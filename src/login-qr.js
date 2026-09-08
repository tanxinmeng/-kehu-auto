// 腾讯文档扫码登录（二维码回传版）：有头离屏打开登录框，截图二维码到 data/qr.png，
// 轮询登录状态，成功后保存会话快照 session.json；状态写入 data/qr_state.json 供网页轮询。
// 支持 data/qr_refresh.flag 触发强制刷新二维码（网页「刷新二维码」按钮写入该标志）。
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import config from "../config.json" with { type: "json" };

const ROOT = process.cwd();
const dataDir = path.join(ROOT, config.dataDir || "data");
const sessionFile = path.join(dataDir, "session.json");
const qrFile = path.join(dataDir, "qr.png");
const stateFile = path.join(dataDir, "qr_state.json");
const refreshFlag = path.join(dataDir, "qr_refresh.flag");
const forceRelogin = process.argv.includes("--force");   // 退出登录后重新扫码（换账号）

function log(msg) {
  const line = `[${new Date().toLocaleString("zh-CN")}] ${msg}`;
  console.log(line);
  try { fs.mkdirSync(dataDir, { recursive: true }); fs.appendFileSync(path.join(dataDir, "login.log"), line + "\n"); } catch {}
}
function setState(obj) {
  try { fs.writeFileSync(stateFile, JSON.stringify(obj, null, 2), "utf8"); } catch {}
}

function cleanProfileLock() {
  const profileDir = path.resolve(ROOT, config.profileDir);
  for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie", "Lockfile"]) {
    try { fs.unlinkSync(path.join(profileDir, f)); } catch {}
  }
}

// 清除腾讯文档登录态（只删 qq.com / docs.qq.com 的 cookie，保留钉钉、多拉等其它站点登录）
async function logoutTencent(ctx) {
  try {
    const cookies = await ctx.cookies();
    const keep = cookies.filter(c => !/qq\.com/i.test(c.domain || ""));
    await ctx.clearCookies();
    if (keep.length) await ctx.addCookies(keep);
    log("已清除腾讯文档登录态，准备重新扫码登录");
    return true;
  } catch (e) {
    log("清除登录态失败: " + (e.message || e).split("\n")[0]);
    return false;
  }
}

async function isLoggedIn(page) {
  // 登录后：顶部不再有「登录腾讯文档」按钮，也不再显示「只能查看」只读标记。
  // 只查按钮缺失会在页面跳转/加载瞬间误判为已登录，故同时要求「只能查看」标记也消失。
  return await page.evaluate(() => {
    const btn = document.querySelector("button.header-login-btn");
    const readonly = document.querySelector(".readonly-button");
    return !btn && !readonly;
  }).catch(() => false);
}

async function captureQr(page) {
  try {
    // 优先截微信二维码容器（432x340，干净易扫），回退到整个登录弹窗，再回退整页
    const wrap = page.locator(".wx-login-wrapper-daBM1").first();
    if (await wrap.count() > 0) {
      await wrap.screenshot({ path: qrFile });
    } else {
      const modal = page.locator(".login-modal").first();
      if (await modal.count() > 0) await modal.screenshot({ path: qrFile });
      else await page.screenshot({ path: qrFile });
    }
  } catch (e) {
    log("截图二维码失败: " + (e.message || e).split("\n")[0]);
  }
  setState({ status: "waiting", updatedAt: Date.now() });
}

// 合规流程：点「立即登录」→ 点「同意」，露出真正的微信二维码
// （若档案已记住合规协议，则按钮不存在，直接跳过）
async function clickIfPresent(page, selector, waitMs) {
  try {
    const el = page.locator(selector).first();
    if (await el.count() > 0) {
      await el.click({ timeout: 5000 });
      await page.waitForTimeout(waitMs);
      return true;
    }
  } catch (e) { /* 按钮可能已消失 */ }
  return false;
}

async function clickCompliance(page) {
  let clicked = false;
  clicked = (await clickIfPresent(page, 'button[class*="compliance-login-btn"]', 3000)) || clicked;
  clicked = (await clickIfPresent(page, 'button.dui-modal-footer-ok', 4000)) || clicked;
  return clicked;
}

// 在当前已打开的文档页上：点登录 → 走合规 → 截图二维码
async function openLoginAndCapture(page) {
  const btn = page.locator("button.header-login-btn").first();
  if (await btn.count() > 0) {
    await btn.click().catch(() => {});
    log("已点击登录，等待二维码...");
  }
  await page.waitForTimeout(7000);
  if (await clickCompliance(page)) log("已通过合规确认");
  await captureQr(page);
  log("二维码已截图，等待扫码...");
}

async function saveSessionAndExit(ctx, state, message) {
  try {
    const s = state || await ctx.storageState();
    fs.writeFileSync(sessionFile, JSON.stringify(s, null, 2), "utf8");
    log("会话快照已保存: cookies=" + (s.cookies || []).length + " 条");
  } catch (e) { log("保存会话失败: " + (e.message || e).split("\n")[0]); }
  setState({ status: "done", message });
  await ctx.close().catch(() => {});
  process.exit(0);
}

log("开始腾讯文档扫码登录（有头离屏）...");
setState({ status: "starting" });
try { fs.unlinkSync(refreshFlag); } catch {}
cleanProfileLock();
await new Promise(r => setTimeout(r, 1000));

let ctx;
try {
  // 有头 + 离屏窗口：微信二维码 iframe 在 headless 下轮询会失效（表现为「扫码无反应」），
  // 改用有头模式并把窗口移到屏幕外（-32000,-32000），既不占终端屏幕又能让 iframe 正常轮询。
  ctx = await chromium.launchPersistentContext(config.profileDir, {
    channel: "msedge",
    headless: false,
    viewport: { width: 1400, height: 900 },
    args: ["--window-position=-32000,-32000"],
  });
} catch (e) {
  log("浏览器启动失败: " + (e.message || e).split("\n")[0]);
  setState({ status: "error", message: "浏览器启动失败" });
  process.exit(1);
}

try {
  const page = await ctx.newPage();
  await page.goto(config.sites.tencentDoc.url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(9000);

  // 强制重新登录：先清除腾讯文档登录态，再重载页面露出登录按钮
  if (forceRelogin) {
    await logoutTencent(ctx);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(9000);
  }

  // 已登录 → 直接刷新会话快照并结束
  if (await isLoggedIn(page)) await saveSessionAndExit(ctx, null, "已登录");

  await openLoginAndCapture(page);

  // 轮询登录状态，最多 5 分钟
  const start = Date.now();
  const MAX_WAIT = 5 * 60 * 1000;
  let lastShot = Date.now();
  let loggedInStreak = 0;   // 连续两次确认「已登录」才判定成功，避免跳转瞬间误判
  while (Date.now() - start < MAX_WAIT) {
    await page.waitForTimeout(3000);
    if (await isLoggedIn(page)) {
      loggedInStreak++;
      if (loggedInStreak >= 2) await saveSessionAndExit(ctx, null, "登录成功");
    } else {
      loggedInStreak = 0;
    }

    // 网页请求刷新二维码：重载页面重新走登录流程
    try {
      if (fs.existsSync(refreshFlag)) {
        fs.unlinkSync(refreshFlag);
        log("收到刷新请求，重新生成二维码...");
        await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
        await page.waitForTimeout(9000);
        if (await isLoggedIn(page)) await saveSessionAndExit(ctx, null, "登录成功");
        await openLoginAndCapture(page);
        lastShot = Date.now();
        continue;
      }
    } catch {}

    // 二维码约 2 分钟过期，每 30 秒重截一次；若合规按钮再现则先点掉
    if (Date.now() - lastShot > 30000) {
      await clickCompliance(page);
      await captureQr(page);
      lastShot = Date.now();
      log("二维码已刷新截图");
    }
  }

  log("登录超时（5分钟）");
  setState({ status: "error", message: "登录超时，请重试" });
  await ctx.close().catch(() => {});
  process.exit(1);
} catch (e) {
  log("登录流程出错: " + (e.message || e).split("\n")[0]);
  setState({ status: "error", message: (e.message || e).split("\n")[0] });
  await ctx.close().catch(() => {});
  process.exit(1);
}
