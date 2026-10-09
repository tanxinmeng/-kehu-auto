// 浏览器操作公共模块：打开文档 / 切换表 / 复制全表 / 按名称框导航读取单元格
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import config from "../config.json" with { type: "json" };

const ROOT = process.cwd();
const dataDir = path.join(ROOT, config.dataDir || "data");
const sessionFile = path.join(dataDir, "session.json");

export function log(msg) {
  const line = `[${new Date().toLocaleString("zh-CN")}] ${msg}`;
  console.log(line);
  try { fs.mkdirSync(dataDir, { recursive: true }); fs.appendFileSync(path.join(dataDir, "sync.log"), line + "\n"); } catch {}
}

function cleanProfileLock() {
  const profileDir = path.resolve(ROOT, config.profileDir);
  // Chromium 持久化 profile 的锁文件：删除残留锁，防止 launchPersistentContext 挂死
  const lockFiles = ["SingletonLock", "SingletonSocket", "SingletonCookie", "Lockfile"];
  for (const f of lockFiles) {
    try { fs.unlinkSync(path.join(profileDir, f)); } catch {}
  }
}

export async function launch() {
  const headless = process.env.KEHU_HEADLESS !== "0";   // 默认无头（复用 profile 登录态，不弹窗）；KEHU_HEADLESS=0 回退有头
  cleanProfileLock();
  await new Promise(r => setTimeout(r, 1000));
  const launchOpts = { channel: "msedge", headless };
  if (!headless) launchOpts.viewport = null;
  const ctx = await chromium.launchPersistentContext(config.profileDir, launchOpts);
  const state = (() => { try { return JSON.parse(fs.readFileSync(sessionFile, "utf8")); } catch { return {}; } })();
  if (state.cookies?.length) await ctx.addCookies(state.cookies);
  const page = await ctx.newPage();
  return { ctx, page };
}

// 游客只读模式检测：掉登录后文档可读但复制/写入都被静默限制
export async function isGuestMode(page) {
  return await page.evaluate(() => /(^|\s)skeleton-guest-mode(\s|$)/.test(document.body.className || "")).catch(() => false);
}

export async function openDoc(page, waitMs = 20000) {
  await page.goto(config.sites.tencentDoc.url, { waitUntil: "domcontentloaded", timeout: 90000 });
  // 等名称框出现即可开始探测（固定等 20s 纯浪费）
  try { await page.waitForSelector("input.bar-label", { timeout: waitMs }); } catch {}
  // 游客只读模式偶发（同 profile 上一分钟游客下一分钟正常）：会话有效但个别页面加载以游客骨架渲染，
  // 复制/写入全被禁。检测到即 reload 自愈，最多 3 次。
  let guest = await isGuestMode(page);
  for (let i = 0; guest && i < 3; i++) {
    log("openDoc: 检测到游客只读模式，reload 自愈（第" + (i + 1) + "次）...");
    await page.reload({ waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => {});
    try { await page.waitForSelector("input.bar-label", { timeout: waitMs }); } catch {}
    await page.waitForTimeout(1500);
    guest = await isGuestMode(page);
  }
  // 实测登录态落盘：session.json 的 cookie 快照无法反映页面实际加载态，
  // server 的登录状态判定以此文件为准（3 小时内的实测结果优先于 cookie 检查）
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "doc_session.json"), JSON.stringify({ guest, at: Date.now() }), "utf8");
  } catch {}
  if (guest) log("openDoc: [警告] reload 3 次后仍为游客只读模式，复制/写入会受限——请运行 start-login.bat 重新扫码");
  // 等待表格渲染完成：导航到 C3 单元格读值，确认能读到数据
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      const bar = page.locator("input.bar-label").first();
      await bar.click();
      await bar.fill("C3");
      await page.keyboard.press("Enter");
      const text = await pollFormulaText(page, 3000);
      if (text && text.length >= 1) { log("openDoc: 表格就绪，C3=" + JSON.stringify(text)); return; }
    } catch (e) { /* retry */ }
    log("openDoc: 第" + (attempt + 1) + "次探测表格未就绪，等待...");
    await page.waitForTimeout(3000);
  }
  log("openDoc: 警告：多次探测表格未就绪，继续尝试");
}

// 轮询读公式栏文本：非空即返回（最多 maxMs），空则等满
async function pollFormulaText(page, maxMs) {
  const deadline = Date.now() + maxMs;
  while (true) {
    const text = await page.evaluate(() => {
      const fb = document.querySelector("div.formula-input");
      return fb ? String(fb.innerText || fb.value || "").trim() : "";
    });
    if (text) return text;
    if (Date.now() >= deadline) return "";
    await page.waitForTimeout(300);
  }
}

const TAB_PARAM = { AI: "ee5hin", "高": "87qj1u" };

export async function isTabActive(page, ariaLabel) {
  // 游客模式（掉登录）下底部 tab 不渲染成 [role=tab]，改用 URL 的 tab 参数兜底判断
  return await page.evaluate(({ label, params }) => {
    const el = Array.from(document.querySelectorAll('[role="tab"]')).find(e => e.getAttribute("aria-label") === label);
    if (el) return el.getAttribute("aria-selected") === "true";
    const byParam = params[label];
    return byParam ? location.href.includes("tab=" + byParam) : false;
  }, { label: ariaLabel, params: TAB_PARAM });
}

export async function clickTab(page, sheetName) {
  const ariaLabel = sheetName === "AI" ? "AI" : "高";
  const tabParam = TAB_PARAM[sheetName];
  if (await isTabActive(page, ariaLabel)) return true;
  // 首选 URL 直跳：当前版本文档底部标签栏不渲染 [role=tab] 元素（guest/登录态实测都为空），
  // DOM 点击方式已失效，改 URL 的 tab 参数切换最可靠
  if (tabParam) {
    try {
      const u = new URL(page.url());
      u.searchParams.set("tab", tabParam);
      await page.goto(u.toString(), { waitUntil: "domcontentloaded", timeout: 60000 });
      try { await page.waitForSelector("input.bar-label", { timeout: 20000 }); } catch {}
      const dl = Date.now() + 15000;
      while (Date.now() < dl) {
        if (await isTabActive(page, ariaLabel)) return true;
        await page.waitForTimeout(500);
      }
    } catch (e) { log("clickTab: URL 切换 " + sheetName + " 异常(" + String(e.message || e).slice(0, 80) + ")，回退点击"); }
  }
  // 兜底：点击 tab 元素（未来版本若恢复渲染可用）
  for (let attempt = 1; attempt <= 3; attempt++) {
    const tab = page.locator(`[role="tab"][aria-label="${ariaLabel}"]`).first();
    if (await tab.count() > 0) await tab.click();
    else {
      const tab2 = page.locator('[role="tab"]', { hasText: ariaLabel }).first();
      if (await tab2.count() === 0) break;
      await tab2.click();
    }
    const dl = Date.now() + 6000;
    while (Date.now() < dl) {
      if (await isTabActive(page, ariaLabel)) return true;
      await page.waitForTimeout(500);
    }
  }
  log("clickTab 切换 " + sheetName + " 可能未成功，继续尝试...");
  return await isTabActive(page, ariaLabel);
}

// 复制整张表（Ctrl+A 两次）；自动重试 + 读内部 copyPaste 缓冲兜底
export async function copySheet(page, sheetName) {
  const isAI = sheetName === "AI";
  const checkFn = isAI
    ? (t) => t.includes("客户信息及反馈") && !t.includes("登记人（飞鸽账号昵称）")
    : (t) => t.includes("登记人（飞鸽账号昵称）");
  const maxRetry = Number(process.env.KEHU_COPY_RETRY || 5);
  for (let attempt = 1; attempt <= maxRetry; attempt++) {
    await page.mouse.click(400, 320);
    await page.waitForTimeout(1000);
    await page.keyboard.press("Control+a");
    await page.waitForTimeout(2500);
    await page.keyboard.press("Control+a");
    await page.waitForTimeout(2500);
    await page.keyboard.press("Control+c");
    await page.waitForTimeout(3000);
    const text = await page.evaluate(async () => {
      let t = "";
      try { t = await navigator.clipboard.readText(); } catch {}
      if (!t) {
        const ta = document.querySelector("textarea.copyPaste");
        if (ta) t = ta.value;
      }
      return t;
    });
    if (text && checkFn(text)) return text;
    log("复制 " + sheetName + " 第" + attempt + "次异常（" + (text ? text.length : 0) + "字符），头200字: " + JSON.stringify(String(text || "").slice(0, 200)) + "，含客户信息:" + (text || "").includes("客户信息及反馈") + " 含登记人:" + (text || "").includes("登记人（飞鸽账号昵称）") + "），重试");
    await page.waitForTimeout(2000);
  }
  throw new Error("复制结果不是预期的表（" + sheetName + "）");
}

// 通过名称框导航到指定单元格（如 C10880）并读取内容
// 读 div.formula-input，回退到 contenteditable、再尝试从表格格子直接读
export async function readCell(page, ref) {
  const bar = page.locator("input.bar-label").first();
  await bar.click();
  await bar.fill(ref);
  await page.keyboard.press("Enter");
  // 关键：先等名称框显示目标格（导航确认完成），否则可能读到上一个单元格的残留值——
  // 连续行同值（如期次都是 0911）时会假通过，读到旧空值会假失败
  await page.waitForFunction((r) => {
    const el = document.querySelector("input.bar-label");
    return el && String(el.value || "").trim().toUpperCase() === String(r).toUpperCase();
  }, String(ref), { timeout: 5000 }).catch(() => {});
  let text = await pollFormulaText(page, 3000);
  if (!text) {
    await page.waitForTimeout(1500);
    text = await page.evaluate(() => {
      const fb = document.querySelector("div.formula-input");
      if (fb) { const t = (fb.innerText || "").trim(); if (t) return t; }
      const ce = document.querySelector("[contenteditable]");
      if (ce) { const t = (ce.innerText || "").trim(); if (t) return t; }
      // 最后尝试：读当前选中的格子文本
      const sel = document.getSelection();
      if (sel && sel.rangeCount) { const t = sel.toString().trim(); if (t) return t; }
      return "";
    });
  }
  return text || "";
}

// 从指定起始行向下复制，双策略交替重试：
//   策略A（无漂移）：点击网格 → 名称框导航 A<startRow> → 方向键轻推回网格焦点 → 校验名称框 → 扩展复制
//   策略B（传统）：名称框导航 → 点击网格 → 方向键微调回目标行 → 扩展复制
// 为什么两条都要：A 避免点击漂移但导航后焦点可能不落回网格；B 焦点可靠但 click(400,320)
// 会把选区点到别的格子（实测落 C1531/C1433）。游客只读模式下复制本身受限，两种都会失败并留下诊断日志。
export async function copyFromRow(page, sheetName, startRow, expectedOrder, opts = {}) {
  const { x = 75, y = 350, retries = 4 } = opts;
  const readNamebox = () => page.evaluate(() => {
    const el = document.querySelector("input.bar-label");
    return el ? String(el.value || "") : "";
  });
  const readClipboard = async () => {
    return await page.evaluate(async () => {
      let t = "";
      try { t = await navigator.clipboard.readText(); } catch {}
      if (!t) {
        const ta = document.querySelector("textarea.copyPaste");
        if (ta) t = ta.value;
      }
      return t;
    });
  };
  // 仍从 A 列锚定（用户要求复制必须含 A 日期/B 客服列）；A、B 允许为空，
  // A 为空时 Ctrl+Shift+Down 只跳到下一个非空格，选区会散（1609 行事故）——扩展逻辑见 extendAndCopy
  const target = "A" + startRow;
  // 名称框接受目标格或其下一行：高表开头有合并单元格（A3:A4 合并时导航 A3 名称框显示 A4），
  // 内容对齐由锚点订单校验兜底（sync 侧 findAnchor 按内容定位，错行会导致锚点匹配失败而中止）
  const acceptedRef = (v) => {
    const m = String(v || "").trim().match(/^([A-Z]+)(\d+)$/i);
    if (!m) return false;
    const row = Number(m[2]);
    return m[1].toUpperCase() === "A" && (row === startRow || row === startRow + 1);
  };
  const navToTarget = async () => {
    await page.evaluate((r) => { const el = document.querySelector("input.bar-label"); if (el) { el.focus(); el.select(); } }, target);
    await page.keyboard.type(target, { delay: 15 });
    await page.keyboard.press("Enter");
    return await page.waitForFunction((r) => {
      const el = document.querySelector("input.bar-label");
      if (!el) return false;
      const v = String(el.value || "").trim().toUpperCase();
      const m = v.match(/^A(\d+)$/);
      // 接受目标行或其下一行（合并单元格显示锚定行）
      return m && (Number(m[1]) === startRow || Number(m[1]) === startRow + 1);
    }, target, { timeout: 4000 }).then(() => true).catch(() => false);
  };
  const extendAndCopy = async () => {
    // A{startRow} 为空时（新行未填日期），Ctrl+Shift+Down 第一按只扩到锚点上方连续区的末尾，
    // 第二按才跨过空档把锚点行和表底带上（2026-09-16 1609 行事故实测）。
    // 非空时多按会越过表底选到整列空行，绝不能多按。Right 最多 3 按：一按到数据右缘，
    // D 列为空时需再按跨档；网格封顶在已用列宽，多按只追加空列，无害。
    await page.keyboard.press("Control+Shift+ArrowDown");
    await page.waitForTimeout(2200);
    if (opts.emptyA) {
      await page.keyboard.press("Control+Shift+ArrowDown");
      await page.waitForTimeout(2200);
    }
    for (let k = 0; k < 3; k++) {
      await page.keyboard.press("Control+Shift+ArrowRight");
      await page.waitForTimeout(1200);
    }
    try { await page.evaluate(() => navigator.clipboard.writeText("")); } catch {}
    await page.waitForTimeout(300);
    await page.keyboard.press("Control+c");
    await page.waitForTimeout(3000);
    return await readClipboard();
  };
  for (let attempt = 1; attempt <= retries; attempt++) {
    const useNew = attempt % 2 === 1;   // 奇数次用策略A，偶数次用策略B
    let before = "";
    if (useNew) {
      // 策略A：先点击网格（此后绝不能再点击），名称框导航，方向键轻推把焦点落回网格
      await page.mouse.click(x, y);
      await page.waitForTimeout(800);
      if (!await navToTarget()) { log("copyFromRow: 第" + attempt + "次(A)名称框导航未确认（当前=" + JSON.stringify(await readNamebox()) + "），重试"); continue; }
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(300);
      await page.keyboard.press("ArrowUp");
      await page.waitForTimeout(300);
    } else {
      // 策略B：导航 → 点击网格 → 方向键微调回目标行（click 落点可能漂移，靠名称框读数校正）
      await page.evaluate((r) => { const el = document.querySelector("input.bar-label"); if (el) { el.focus(); el.select(); } }, target);
      await page.keyboard.type(target, { delay: 15 });
      await page.keyboard.press("Enter");
      await page.waitForTimeout(1800);
      await page.mouse.click(x, y);
      await page.waitForTimeout(1000);
      let cell = await readNamebox();
      let m = String(cell).match(/^([A-Z]+)(\d+)$/);
      if (!m) { log("copyFromRow: 第" + attempt + "次(B)点击后活动单元格无法解析 " + JSON.stringify(cell) + "，重试"); continue; }
      let col = m[1], row = Number(m[2]);
      if (col !== "A") {
        await page.keyboard.press("Home");
        await page.waitForTimeout(600);
        cell = await readNamebox();
        m = String(cell).match(/^([A-Z]+)(\d+)$/);
        if (m) { col = m[1]; row = Number(m[2]); }
      }
      let guard = 0;
      while (row < startRow && guard < 25) { await page.keyboard.press("ArrowDown"); await page.waitForTimeout(120); row++; guard++; }
      while (row > startRow && guard < 25) { await page.keyboard.press("ArrowUp"); await page.waitForTimeout(120); row--; guard++; }
      await page.waitForTimeout(400);
    }
    // 复制前校验选区位置：名称框必须显示目标格（或合并单元格的下一行），否则绝不复制
    before = await readNamebox();
    if (!acceptedRef(before)) {
      log("copyFromRow: 第" + attempt + "次(" + (useNew ? "A" : "B") + ")选区漂移（复制前名称框=" + JSON.stringify(before) + "，目标 " + target + "），重试");
      continue;
    }
    const text = await extendAndCopy();
    // 锚点订单在复制结果里 = 选区确实从起始行开始，长度不再设下限——表尾只剩一两行时
    // 合法复制可能不足 100 字符（2026-10-01 行3278 表尾 84 字符被误判重试死循环）
    const ok = expectedOrder
      ? text && text.includes(String(expectedOrder))
      : text && text.length > 100;
    if (ok) return text;
    log("copyFromRow: " + sheetName + " 第" + attempt + "次(" + (useNew ? "A" : "B") + ")结果异常（" + (text ? text.length : 0) + " 字符）" + (expectedOrder ? "，缺锚点订单" : "") + "，复制前名称框=" + JSON.stringify(before) + "，内容前200字: " + JSON.stringify(String(text || "").slice(0, 200)) + "，重试");
    if (await page.evaluate(() => /(^|\s)skeleton-guest-mode(\s|$)/.test(document.body.className || ""))) {
      log("copyFromRow: [警告] 文档处于游客只读模式（掉登录），复制很可能被禁——请运行 start-login.bat 重新扫码后再同步");
    }
    await page.waitForTimeout(1500);
  }
  throw new Error("从第 " + startRow + " 行向下复制失败（" + sheetName + "）");
}

export async function gotoCell(page, ref) {
  await page.evaluate((r) => { const el = document.querySelector("input.bar-label"); if (el) { el.focus(); el.select(); } }, ref);
  await page.keyboard.type(ref, { delay: 15 });
  await page.keyboard.press("Enter");
  // 名称框显示目标格 = 导航提交完成，即刻返回（原固定 2.2s 纯等）
  const ok = await page.waitForFunction((r) => {
    const el = document.querySelector("input.bar-label");
    return el && String(el.value || "").trim().toUpperCase() === String(r).toUpperCase();
  }, String(ref), { timeout: 2500 }).then(() => true).catch(() => false);
  if (!ok) await page.waitForTimeout(1500);   // 未确认到位时兜底等一会
}
