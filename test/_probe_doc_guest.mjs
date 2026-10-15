// 只读实测：用真实 profile 打开腾讯文档，判断当前是否处于「游客只读模式」。
// 这是 server.js 里 doc_session.json 记录的那个判据的复现，不复制、不写入任何单元格。
import path from "node:path";
import { chromium } from "playwright";

const ROOT = "C:/Users/EDY/.qclaw/workspace/kehu-auto";
const docUrl = "https://docs.qq.com/sheet/DWGRyUkJtamNpdFJk?tab=ee5hin";

const ctx = await chromium.launchPersistentContext(path.join(ROOT, "profile"), {
  channel: "msedge",
  headless: true,
});
const page = ctx.pages()[0] || (await ctx.newPage());
const isGuest = () => page.evaluate(() =>
  /(^|\s)skeleton-guest-mode(\s|$)/.test(document.body.className || "")
).catch(() => null);
try {
  await page.goto(docUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(12000);
  let guest = await isGuest();
  console.log("首页加载 游客只读模式:", guest, "标题:", await page.title().catch(() => ""));
  // 复现 openDoc 的 reload 自愈：偶发游客骨架，重载后可能恢复
  for (let i = 1; guest && i <= 3; i++) {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => {});
    await page.waitForTimeout(10000);
    guest = await isGuest();
    console.log("reload 第" + i + "次 游客只读模式:", guest);
  }
  const bar = await page.locator("input.bar-label").count().catch(() => -1);
  console.log("最终 游客只读模式:", guest, " 名称框数量:", bar);
} catch (e) {
  console.log("打开失败:", (e.message || e).split("\n")[0]);
}
await ctx.close();
