// 只读探查：打开客诉表，判断页面到底是不是「游客/未登录」态。
// 除 class 检测外，再看页面上是否出现「登录」入口、是否有用户头像，以及 C3 能否读到内容。
import path from "node:path";
import { chromium } from "playwright";

const ROOT = "C:/Users/EDY/.qclaw/workspace/kehu-auto";
const docUrl = "https://docs.qq.com/sheet/DWGRyUkJtamNpdFJk?tab=ee5hin";

const ctx = await chromium.launchPersistentContext(path.join(ROOT, "profile"), {
  channel: "msedge",
  headless: true,
});
const page = ctx.pages()[0] || (await ctx.newPage());
try {
  await page.goto(docUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(15000);
  const info = await page.evaluate(() => {
    const body = document.body;
    const txt = (body.innerText || "").slice(0, 3000);
    const loginHints = ["登录", "立即登录", "扫码登录", "免费试用"].filter(k => txt.includes(k));
    const avatar = document.querySelectorAll(
      ".user-avatar, .avatar, [class*='avatar'], .header-user-info, .user-info"
    ).length;
    return {
      guestClass: /(^|\s)skeleton-guest-mode(\s|$)/.test(body.className || ""),
      className: (body.className || "").slice(0, 200),
      title: document.title,
      loginHints,
      avatarNodes: avatar,
      textHead: txt.slice(0, 300).replace(/\n+/g, " | "),
    };
  });
  console.log(JSON.stringify(info, null, 1));

  // C3 读值：guest 也能读，但如果连值都读不到说明表格根本没加载
  const bar = page.locator("input.bar-label").first();
  await bar.click();
  await bar.fill("C3");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2500);
  const c3 = await page.evaluate(() => {
    const el = document.querySelector(".formula-content, .formula-editor, [class*='formula']");
    return el ? (el.innerText || "").slice(0, 120) : "（未找到公式栏）";
  });
  console.log("C3 读数:", JSON.stringify(c3));
} catch (e) {
  console.log("失败:", (e.message || e).split("\n")[0]);
}
await ctx.close();
