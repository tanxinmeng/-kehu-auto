// 诊断：实际搜索订单号，截图 + dump 页面状态
import fs from "node:fs";
import config from "../config.json" with { type: "json" };
import { chromium } from "playwright";

const ORDER = process.argv[2] || "6928575223641374274";
const SITE = process.argv[3] || "duola";
const site = config.sites[SITE];
const profileDir = process.cwd() + "/" + config.profileDir;

// 清 profile 锁
for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie", "Lockfile"]) {
  try { fs.unlinkSync(profileDir + "/" + f); } catch {}
}
await new Promise(r => setTimeout(r, 1000));
const ctx = await chromium.launchPersistentContext(profileDir, { channel: "msedge", headless: true });
const state = JSON.parse(fs.readFileSync(process.cwd() + "/data/session.json", "utf8"));
if (state.cookies?.length) await ctx.addCookies(state.cookies);
const page = await ctx.newPage();
const out = [];

try {
  await page.goto(site.url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(8000);
  out.push("URL after load: " + page.url());
  for (let i = 0; i < 30; i++) {
    if ((await page.getByPlaceholder("订单号").count()) > 0) break;
    await page.waitForTimeout(1000);
  }
  const input = page.getByPlaceholder("订单号").first();
  if (!(await input.count())) {
    out.push("搜索框未出现！页面文本前500字: " + (await page.evaluate(() => document.body.innerText)).slice(0, 500));
  } else {
    await input.fill(ORDER);
    await page.waitForTimeout(400);
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    for (let i = 0; i < 6; i++) {
      await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(1500);
      const tables = await page.evaluate(() => {
        const ts = Array.from(document.querySelectorAll("table"));
        return ts.map(t => t.innerText.slice(0, 800));
      });
      out.push(`--- 第${i + 1}轮读表 (table数=${tables.length}) ---`);
      out.push(tables.join("\n====\n") || "(无表格)");
      if (tables.join("").includes(ORDER)) break;
    }
    // 页面整体文本（找「暂无数据」之类提示）
    const bodyText = await page.evaluate(() => document.body.innerText);
    out.push("--- 页面关键词 ---");
    for (const kw of ["暂无", "无数据", "没有", "空", ORDER]) {
      const idx = bodyText.indexOf(kw);
      if (idx >= 0) out.push(`"${kw}" @${idx}: ...${bodyText.slice(Math.max(0, idx - 60), idx + 80).replace(/\n/g, "⏎")}...`);
    }
    await page.screenshot({ path: process.cwd() + "/data/diag_search.png", fullPage: false });
    out.push("截图: data/diag_search.png");
  }
} catch (e) {
  out.push("异常: " + String(e).slice(0, 300));
} finally {
  await ctx.close().catch(() => {});
  fs.writeFileSync(process.cwd() + "/data/diag_search.txt", out.join("\n"), "utf8");
  console.log("done");
}
