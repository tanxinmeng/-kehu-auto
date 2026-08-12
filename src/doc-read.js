// 从腾讯文档界面直接读取表格数据（全选复制法，免下载）
// 关键点：
//   1) Ctrl+A 两次选中整个表（单次只选中活动区域）；复制可能失败（剪贴板残留），需清空剪贴板+重试
//   2) 点击已激活的 tab 会触发重渲染导致复制异常 → 已激活则不点击
//   3) 高→AI 切换偶发卡住 → 先读 AI（文档默认落在 AI 表），失败时重新加载兜底
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import config from "../config.json" with { type: "json" };

const ROOT = process.cwd();
const dataDir = path.join(ROOT, config.dataDir || "data");
const sessionFile = path.join(dataDir, "session.json");
const logFile = path.join(dataDir, "sync.log");
function log(msg) {
  const line = `[${new Date().toLocaleString("zh-CN")}] ${msg}`;
  console.log(line);
  try { fs.mkdirSync(dataDir, { recursive: true }); fs.appendFileSync(logFile, line + "\n"); } catch {}
}

async function isTabActive(page, ariaLabel) {
  return await page.evaluate((label) => {
    const el = Array.from(document.querySelectorAll('[role="tab"]')).find(e => e.getAttribute("aria-label") === label);
    return el ? el.getAttribute("aria-selected") === "true" : false;
  }, ariaLabel);
}

async function clickTab(page, ariaLabel, tabParam) {
  // 若目标 tab 已激活，直接返回（避免点击已激活 tab 触发重渲染，导致后续复制异常）
  if (await isTabActive(page, ariaLabel)) return true;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const tab = page.locator(`[role="tab"][aria-label="${ariaLabel}"]`).first();
    if (await tab.count() > 0) await tab.click();
    else {
      const tab2 = page.locator('[role="tab"]', { hasText: ariaLabel }).first();
      if (await tab2.count() === 0) return false;
      await tab2.click();
    }
    if (tabParam) {
      try {
        await page.waitForFunction((tp) => location.href.includes("tab=" + tp), tabParam, { timeout: 15000 });
      } catch {}
    }
    await page.waitForTimeout(4000);
    if (await isTabActive(page, ariaLabel)) return true;
    await page.waitForTimeout(2000);
  }
  return true;
}

async function copyCurrentSheet(page, checkFn, label) {
  const maxRetry = Number(process.env.KEHU_COPY_RETRY || 5);
  for (let attempt = 1; attempt <= maxRetry; attempt++) {
    // 先清空剪贴板，确保能判断复制是否真正发生
    try { await page.evaluate(() => navigator.clipboard.writeText("")); } catch {}
    await page.waitForTimeout(300);
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
    log("读表: " + label + " 第" + attempt + "次复制结果异常（空/残留/未切换），重试");
    await page.waitForTimeout(2000);
  }
  throw new Error("复制结果不是预期的表（" + label + "）");
}

// 返回 { AI: 原始复制文本, 高: 原始复制文本 }
export async function readDoc() {
  const headless = process.env.KEHU_HEADLESS === "1";
  const ctx = await chromium.launchPersistentContext(config.profileDir, { channel: "msedge", headless, viewport: null });
  try {
    const state = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
    if (state.cookies?.length) await ctx.addCookies(state.cookies);
    const page = await ctx.newPage();
    log("读表: 打开文档...");
    await page.goto(config.sites.tencentDoc.url, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForTimeout(15000);

    async function readSheet(target, checkFn, tabAria, tabParam) {
      for (let round = 1; round <= 2; round++) {
        try {
          const ok = await clickTab(page, tabAria, tabParam);
          if (!ok) throw new Error("找不到 " + target + " tab");
          const text = await copyCurrentSheet(page, checkFn, target);
          log("读表: " + target + " 表复制完成 (" + text.split(/\r?\n/).length + " 行)");
          return text;
        } catch (e) {
          log("读表: " + target + " 第" + round + "轮失败: " + e.message.split("\n")[0]);
          if (round === 1) {
            // 重新加载页面（默认落在 AI 表），再试一次
            await page.goto(config.sites.tencentDoc.url, { waitUntil: "domcontentloaded", timeout: 90000 });
            await page.waitForTimeout(15000);
          }
        }
      }
      throw new Error("无法读取 " + target + " 表");
    }

    // 先读 AI（文档默认落在 AI 表，避免 高→AI 切换卡住），再读 高
    const aiText = await readSheet("AI", t => t.includes("客户信息及反馈") && !t.includes("登记人（飞鸽账号昵称）"), "AI", "ee5hin");
    const gaoText = await readSheet("高", t => t.includes("登记人（飞鸽账号昵称）"), "高", "87qj1u");
    return { AI: aiText, 高: gaoText };
  } finally {
    await ctx.close().catch(() => {});
  }
}
