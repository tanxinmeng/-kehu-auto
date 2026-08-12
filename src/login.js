// 一次性登录工具：打开持久化 Edge 档案，登录三个站点，并定期保存会话快照（session.json）
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import config from "../config.json" with { type: "json" };

const ROOT = process.cwd();
const dataDir = path.join(ROOT, config.dataDir || "data");
const logFile = path.join(dataDir, "login.log");
const sessionFile = path.join(dataDir, "session.json");
function log(msg) {
  const line = `[${new Date().toLocaleString("zh-CN")}] ${msg}`;
  console.log(line);
  try { fs.mkdirSync(dataDir, { recursive: true }); fs.appendFileSync(logFile, line + "\n"); } catch {}
}
async function saveSession(ctx) {
  try {
    const state = await ctx.storageState();
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(sessionFile, JSON.stringify(state, null, 2), "utf8");
    log("会话快照已保存: cookies=" + state.cookies.length + " 条");
  } catch (e) { log("保存会话失败: " + e.message); }
}

log("开始启动 Edge（档案: " + config.profileDir + "）...");
let ctx;
try {
  ctx = await chromium.launchPersistentContext(config.profileDir, {
    channel: "msedge", headless: false, viewport: null,
    args: ["--start-maximized", "--window-position=0,0"],
  });
  log("Edge 已启动，正在打开 3 个标签页...");
} catch (e) {
  log("Edge 启动失败: " + (e.message || e).split("\n")[0]);
  console.error(e);
  process.exit(1);
}

const entries = Object.entries(config.sites);
let first = true;
for (const [key, site] of entries) {
  let page;
  try {
    page = first ? (ctx.pages()[0] || await ctx.newPage()) : await ctx.newPage();
    first = false;
    let ok = false;
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      try {
        await page.goto(site.url, { waitUntil: "domcontentloaded", timeout: 45000 });
        try { await page.bringToFront(); } catch {}
        ok = true;
        log("已打开: [" + site.name + "]");
      } catch (e) {
        const msg = (e.message || e).split("\n")[0];
        log("第" + attempt + "次打开失败: [" + site.name + "] " + msg);
        if (msg.includes("browser has been closed")) break;
        await new Promise(r => setTimeout(r, 2500));
      }
    }
  } catch (e) {
    log("打开失败: [" + site.name + "] " + (e.message || e).split("\n")[0]);
  }
  await new Promise(r => setTimeout(r, 1500));
}

log("请在 Edge 窗口登录 3 个标签页；登录完成后【关闭窗口】即可（期间每5秒自动保存会话）。");
const timer = setInterval(() => saveSession(ctx), 5000);
try {
  await new Promise((resolve) => { ctx.browser().on("disconnected", resolve); });
} catch (e) { log("等待中断: " + e.message); }
clearInterval(timer);
await saveSession(ctx).catch(() => {});
await ctx.close().catch(() => {});
log("完成！会话已保存到: " + sessionFile);

