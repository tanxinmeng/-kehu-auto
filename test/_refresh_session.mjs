// 重建 data/session.json：直接从真实 profile 取一次 storageState（含腾讯文档 + 站点 cookie）。
// 背景：上个会话 login.js 的 5 秒定时 saveSession 在窗口关闭后把快照写成空 cookies，
// 之后我只补了 yuaiweiwu 站点 cookie，docs.qq.com 一直缺席 → 界面误报「腾讯文档会话已失效」。
// 只读 profile、只写 session.json，不点任何按钮。
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = "C:/Users/EDY/.qclaw/workspace/kehu-auto";
const sessionFile = path.join(ROOT, "data/session.json");

const ctx = await chromium.launchPersistentContext(path.join(ROOT, "profile"), {
  channel: "msedge",
  headless: true,
});
const page = ctx.pages()[0] || (await ctx.newPage());

// 打开两个站点 + 腾讯文档首页，让 profile 里的 cookie 都挂到当前上下文
for (const url of [
  "https://docs.qq.com/",
  "https://ai-duola.yuaiweiwu.com/#/clue/index",
  "https://duola.yuaiweiwu.com/#/clue/index",
]) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(3000);
  } catch (e) {
    console.log("打开失败 " + url + " : " + (e.message || e).split("\n")[0]);
  }
}

const state = await ctx.storageState();
const doms = {};
for (const c of state.cookies) {
  const d = String(c.domain || "").replace(/^\./, "");
  doms[d] = (doms[d] || 0) + 1;
}
console.log("profile 最新 cookie 总数:", state.cookies.length);
console.log("按域统计:", JSON.stringify(doms));
fs.writeFileSync(sessionFile, JSON.stringify(state, null, 2), "utf8");
console.log("已写回 " + sessionFile);
await ctx.close();
