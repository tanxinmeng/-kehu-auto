// 一次性恢复：kehu 站点登录态（session.json）已丢失，且 profile 的 cookie 库被加密读不到。
// 用 auto-order 推单快照里同一站点（yuaiweiwu.com）的有效 cookie 重建快照，再回写 session.json。
// 站点登录失效会直接导致补全功能不可用（siteLogin 判据就是这份快照）。
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const KEHU = "C:/Users/EDY/.qclaw/workspace/kehu-auto";
const AUTO = "C:/Users/EDY/.qclaw/workspace/auto-order";
const sessionFile = path.join(KEHU, "data/session.json");
const profileDir = path.join(KEHU, "profile");

function loadCookies(file, hostMatch) {
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  return (state.cookies || []).filter((c) => {
    const d = String(c.domain || "").replace(/^\./, "");
    return d === hostMatch || d === "cas.yuaiweiwu.com";
  });
}

const cookies = [
  ...loadCookies(path.join(AUTO, "duola_session_junior.json"), "ai-duola.yuaiweiwu.com"),
  ...loadCookies(path.join(AUTO, "duola_session_high.json"), "duola.yuaiweiwu.com"),
];
const seen = new Set();
const uniq = cookies.filter((c) => {
  const k = c.domain + "|" + c.name;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});
console.log("注入站点 cookie 条数:", uniq.length, uniq.map((c) => c.domain + "/" + c.name).join(", "));

const ctx = await chromium.launchPersistentContext(profileDir, { channel: "msedge", headless: true });
await ctx.addCookies(uniq);

// 打开站点让页面把 cookie 落到 profile，同时核对登录是否真的生效
const targets = [
  ["AI站", "https://ai-duola.yuaiweiwu.com/#/clue/index"],
  ["高中站", "https://duola.yuaiweiwu.com/#/clue/index"],
];
for (const [name, url] of targets) {
  const page = await ctx.newPage();
  try {
    const r = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(4000);
    const body = await page.evaluate(() => document.body.innerText.slice(0, 200)).catch(() => "");
    console.log("[" + name + "] goto status=" + (r && r.status()) + " 页面首行=" + JSON.stringify(body.split("\n").filter(Boolean).slice(0, 3)));
  } catch (e) {
    console.log("[" + name + "] 打开失败: " + (e.message || e).split("\n")[0]);
  }
  await page.close().catch(() => {});
}

const state = await ctx.storageState();
fs.writeFileSync(sessionFile, JSON.stringify(state, null, 2), "utf8");
const doms = {};
for (const c of state.cookies) {
  const d = String(c.domain || "").replace(/^\./, "");
  doms[d] = (doms[d] || 0) + 1;
}
console.log("已写回 session.json，cookie 总数:", state.cookies.length);
console.log("按域统计:", JSON.stringify(doms));
await ctx.close();
