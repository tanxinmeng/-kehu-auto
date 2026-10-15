// 只读探查：profile 里到底有哪些域的 cookie（不写任何文件，不点按钮）
import path from "node:path";
import { chromium } from "playwright";

const ROOT = "C:/Users/EDY/.qclaw/workspace/kehu-auto";
const ctx = await chromium.launchPersistentContext(path.join(ROOT, "profile"), {
  channel: "msedge",
  headless: true,
});
const page = ctx.pages()[0] || (await ctx.newPage());
for (const url of ["https://docs.qq.com/", "https://ai-duola.yuaiweiwu.com/#/clue/index"]) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(2500);
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
console.log("profile cookie 总数:", state.cookies.length);
console.log("按域统计:", JSON.stringify(doms, null, 1));
console.log("QQ 域 cookie 名:", state.cookies.filter(c => /qq\.com$/i.test((c.domain || "").replace(/^\./, ""))).map(c => c.domain + "/" + c.name).join(", ") || "（无）");
await ctx.close();
