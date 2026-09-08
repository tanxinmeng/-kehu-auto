import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "data", "diag_api_compare.txt");
const PROBLEM = "6929200394933140853";
const CANARY = "6955680086484194451"; // 10:47 刚查到的正常单
const lines = [];
const log = (s) => { lines.push(s); console.log(s); };

// 与 site-query 完全相同的持久化 profile（复用登录态）
const browser = await chromium.launchPersistentContext(path.resolve(ROOT, "profile"), { channel: "msedge", headless: true });
try {
  const ctx = browser;
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto("https://ai-duola.yuaiweiwu.com/#/clue/index", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3000);

  async function apiQuery(siteKey, orderNo) {
    const p = siteKey === "aiDuola" ? "/prod-api/flowtracker-yy-ai/clue/info/list" : "/prod-api/flowtracker-yy/clue/info/list";
    const origin = siteKey === "aiDuola" ? "https://ai-duola.yuaiweiwu.com" : "https://duola.yuaiweiwu.com";
    return await page.evaluate(async ({ url, orderNo }) => {
      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ nickName: "", nickNames: [], mobile: "", mobiles: [], orderNo: String(orderNo), virtualMobile: "", orderNos: [String(orderNo)], virtualMobiles: [], current: 1, size: 10, recordId: "", recordIds: [] }),
        });
        const text = await resp.text();
        return { status: resp.status, ct: resp.headers.get("content-type"), head: text.slice(0, 160), len: text.length };
      } catch (e) { return { err: String(e).slice(0, 120) }; }
    }, { url: origin + p, orderNo });
  }

  for (const site of ["aiDuola", "duola"]) {
    const u1 = await apiQuery(site, PROBLEM);
    log(`[${site}] 问题单 ${PROBLEM} → ${JSON.stringify(u1)}`);
    const u2 = await apiQuery(site, CANARY);
    log(`[${site}] 对照单 ${CANARY} → ${JSON.stringify(u2)}`);
  }
} finally {
  fs.writeFileSync(OUT, lines.join("\n"), "utf8");
  await browser.close().catch(() => {});
}
