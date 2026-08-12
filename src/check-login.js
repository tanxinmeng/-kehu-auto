// 登录状态检测：从会话快照(session.json)注入登录态，检查三个站点是否可访问
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import config from "../config.json" with { type: "json" };

const ROOT = process.cwd();
const sessionFile = path.join(ROOT, config.dataDir || "data", "session.json");

let ctx;
try {
  ctx = await chromium.launchPersistentContext(config.profileDir, { channel: "msedge", headless: true });
} catch (e) {
  console.log("启动浏览器失败: " + e.message.split("\n")[0]);
  process.exit(1);
}

let cookieCount = 0;
if (fs.existsSync(sessionFile)) {
  try {
    const state = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
    if (state.cookies && state.cookies.length) {
      await ctx.addCookies(state.cookies);
      cookieCount = state.cookies.length;
    }
  } catch (e) { console.log("读取会话快照失败: " + e.message); }
}
console.log("会话快照 cookies 注入: " + cookieCount + " 条");

const results = {};
for (const [key, site] of Object.entries(config.sites)) {
  const page = await ctx.newPage();
  try {
    await page.goto(site.url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(6000);
    const url = page.url();
    let loggedIn = false;
    if (site.check === "host") {
      loggedIn = url.includes(site.host) && !url.includes("login.");
    } else {
      const text = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 2000) : "");
      loggedIn = !(site.loggedOutText && text.includes(site.loggedOutText));
    }
    results[key] = { loggedIn, url: url.slice(0, 90) };
    console.log("[" + site.name + "] " + (loggedIn ? "OK 已登录" : "未登录") + "  " + url.slice(0, 90));
  } catch (e) {
    results[key] = { loggedIn: false, error: e.message.split("\n")[0] };
    console.log("[" + site.name + "] 检查失败: " + e.message.split("\n")[0]);
  }
  await page.close().catch(() => {});
}
await ctx.close().catch(() => {});
const allOk = Object.values(results).every(r => r.loggedIn);
console.log(allOk ? "全部站点已登录" : "有站点未登录");
process.exit(allOk ? 0 : 1);
