// 浏览器操作公共模块：打开文档 / 切换表 / 复制全表 / 按名称框导航读取单元格
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import config from "../config.json" with { type: "json" };

const ROOT = process.cwd();
const dataDir = path.join(ROOT, config.dataDir || "data");
const sessionFile = path.join(dataDir, "session.json");

export function log(msg) {
  const line = `[${new Date().toLocaleString("zh-CN")}] ${msg}`;
  console.log(line);
  try { fs.mkdirSync(dataDir, { recursive: true }); fs.appendFileSync(path.join(dataDir, "sync.log"), line + "\n"); } catch {}
}

function cleanProfileLock() {
  const profileDir = path.resolve(ROOT, config.profileDir);
  // Chromium 持久化 profile 的锁文件：删除残留锁，防止 launchPersistentContext 挂死
  const lockFiles = ["SingletonLock", "SingletonSocket", "SingletonCookie", "Lockfile"];
  for (const f of lockFiles) {
    try { fs.unlinkSync(path.join(profileDir, f)); } catch {}
  }
}

export async function launch() {
  const headless = process.env.KEHU_HEADLESS !== "0";   // 默认无头（复用 profile 登录态，不弹窗）；KEHU_HEADLESS=0 回退有头
  cleanProfileLock();
  await new Promise(r => setTimeout(r, 1000));
  const launchOpts = { channel: "msedge", headless };
  if (!headless) launchOpts.viewport = null;
  const ctx = await chromium.launchPersistentContext(config.profileDir, launchOpts);
  const state = (() => { try { return JSON.parse(fs.readFileSync(sessionFile, "utf8")); } catch { return {}; } })();
  if (state.cookies?.length) await ctx.addCookies(state.cookies);
  const page = await ctx.newPage();
  return { ctx, page };
}

export async function openDoc(page, waitMs = 20000) {
  await page.goto(config.sites.tencentDoc.url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(waitMs);
  // 等待表格渲染完成：导航到 C3 单元格读值，确认能读到数据
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      const bar = page.locator("input.bar-label").first();
      await bar.click();
      await bar.fill("C3");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(3000);
      const text = await page.evaluate(() => {
        const el = document.querySelector("div.formula-input");
        return el ? String(el.innerText || el.value || "").trim() : "";
      });
      if (text && text.length >= 1) { log("openDoc: 表格就绪，C3=" + JSON.stringify(text)); return; }
    } catch (e) { /* retry */ }
    log("openDoc: 第" + (attempt + 1) + "次探测表格未就绪，等待...");
    await page.waitForTimeout(3000);
  }
  log("openDoc: 警告：多次探测表格未就绪，继续尝试");
}

const TAB_PARAM = { AI: "ee5hin", "高": "87qj1u" };

export async function isTabActive(page, ariaLabel) {
  return await page.evaluate((label) => {
    const el = Array.from(document.querySelectorAll('[role="tab"]')).find(e => e.getAttribute("aria-label") === label);
    return el ? el.getAttribute("aria-selected") === "true" : false;
  }, ariaLabel);
}

export async function clickTab(page, sheetName) {
  const ariaLabel = sheetName === "AI" ? "AI" : "高";
  const tabParam = TAB_PARAM[sheetName];
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
      try { await page.waitForFunction((tp) => location.href.includes("tab=" + tp), tabParam, { timeout: 15000 }); } catch {}
    }
    await page.waitForTimeout(4000);
    if (await isTabActive(page, ariaLabel)) return true;
    await page.waitForTimeout(2000);
  }
  log("clickTab 切换 " + sheetName + " 可能未成功，继续尝试...");
  return await isTabActive(page, ariaLabel);
}

// 复制整张表（Ctrl+A 两次）；自动重试 + 读内部 copyPaste 缓冲兜底
export async function copySheet(page, sheetName) {
  const isAI = sheetName === "AI";
  const checkFn = isAI
    ? (t) => t.includes("客户信息及反馈") && !t.includes("登记人（飞鸽账号昵称）")
    : (t) => t.includes("登记人（飞鸽账号昵称）");
  const maxRetry = Number(process.env.KEHU_COPY_RETRY || 5);
  for (let attempt = 1; attempt <= maxRetry; attempt++) {
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
    log("复制 " + sheetName + " 第" + attempt + "次异常（" + (text ? text.length : 0) + "字符），头200字: " + JSON.stringify(String(text || "").slice(0, 200)) + "，含客户信息:" + (text || "").includes("客户信息及反馈") + " 含登记人:" + (text || "").includes("登记人（飞鸽账号昵称）") + "），重试");
    await page.waitForTimeout(2000);
  }
  throw new Error("复制结果不是预期的表（" + sheetName + "）");
}

// 通过名称框导航到指定单元格（如 C10880）并读取内容
// 读 div.formula-input，回退到 contenteditable、再尝试从表格格子直接读
export async function readCell(page, ref) {
  const bar = page.locator("input.bar-label").first();
  await bar.click();
  await bar.fill(ref);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(4000);
  let text = await page.evaluate(() => {
    const fb = document.querySelector("div.formula-input");
    if (fb) { const t = (fb.innerText || "").trim(); if (t) return t; }
    return "";
  });
  if (!text) {
    await page.waitForTimeout(2500);
    text = await page.evaluate(() => {
      const fb = document.querySelector("div.formula-input");
      if (fb) { const t = (fb.innerText || "").trim(); if (t) return t; }
      const ce = document.querySelector("[contenteditable]");
      if (ce) { const t = (ce.innerText || "").trim(); if (t) return t; }
      // 最后尝试：读当前选中的格子文本
      const sel = document.getSelection();
      if (sel && sel.rangeCount) { const t = sel.toString().trim(); if (t) return t; }
      return "";
    });
  }
  return text || "";
}

// 从指定起始行向下复制：A<startRow> → 点击A列聚焦网格 → 方向键微调到目标行 → Ctrl+Shift+Down/Right 扩展 → Ctrl+C
// 实测：全选复制(Ctrl+A)在部分环境失效（点击落到浮层/焦点丢失），此法可靠；仅复制"起始行以下"，正合使用场景
export async function copyFromRow(page, sheetName, startRow, expectedOrder, opts = {}) {
  const { x = 75, y = 350, maxAdjust = 25, retries = 4 } = opts;
  const readNamebox = () => page.evaluate(() => {
    const el = document.querySelector("input.bar-label");
    return el ? String(el.value || "") : "";
  });
  const readClipboard = async () => {
    return await page.evaluate(async () => {
      let t = "";
      try { t = await navigator.clipboard.readText(); } catch {}
      if (!t) {
        const ta = document.querySelector("textarea.copyPaste");
        if (ta) t = ta.value;
      }
      return t;
    });
  };
  for (let attempt = 1; attempt <= retries; attempt++) {
    // 1) 名称框定位 A<startRow>
    await page.evaluate((r) => { const el = document.querySelector("input.bar-label"); if (el) { el.focus(); el.select(); } }, "A" + startRow);
    await page.keyboard.type("A" + startRow, { delay: 15 });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1800);
    // 2) 点击 A 列区域，让网格进入可选状态（实测必须先点击，选区快捷键才生效）
    await page.mouse.click(x, y);
    await page.waitForTimeout(1000);
    let cell = await readNamebox();
    let m = String(cell).match(/^([A-Z]+)(\d+)$/);
    if (!m) { log("copyFromRow: 点击后活动单元格无法解析 " + JSON.stringify(cell) + "，重试"); continue; }
    let col = m[1], row = Number(m[2]);
    // 3) 列不是 A → Home 跳到 A 列
    if (col !== "A") {
      await page.keyboard.press("Home");
      await page.waitForTimeout(600);
      cell = await readNamebox();
      m = String(cell).match(/^([A-Z]+)(\d+)$/);
      if (m) { col = m[1]; row = Number(m[2]); }
    }
    // 4) 行微调到 startRow
    let guard = 0;
    while (row < startRow && guard < maxAdjust) { await page.keyboard.press("ArrowDown"); await page.waitForTimeout(120); row++; guard++; }
    while (row > startRow && guard < maxAdjust) { await page.keyboard.press("ArrowUp"); await page.waitForTimeout(120); row--; guard++; }
    // 5) 扩展选区：向下到数据末尾（遇空行会停在第1个空行前），再向右含全部列
    await page.keyboard.press("Control+Shift+ArrowDown");
    await page.waitForTimeout(2200);
    await page.keyboard.press("Control+Shift+ArrowRight");
    await page.waitForTimeout(2200);
    // 6) 复制并校验
    try { await page.evaluate(() => navigator.clipboard.writeText("")); } catch {}
    await page.waitForTimeout(300);
    await page.keyboard.press("Control+c");
    await page.waitForTimeout(3000);
    const text = await readClipboard();
    const ok = text && text.length > 100 && (!expectedOrder || text.includes(String(expectedOrder)));
    if (ok) return text;
    log("copyFromRow: " + sheetName + " 第" + attempt + "次结果异常（" + (text ? text.length : 0) + " 字符）" + (expectedOrder ? "，缺锚点订单" : "") + "，重试");
    await page.waitForTimeout(1500);
  }
  throw new Error("从第 " + startRow + " 行向下复制失败（" + sheetName + "）");
}

export async function gotoCell(page, ref) {
  await page.evaluate((r) => { const el = document.querySelector("input.bar-label"); if (el) { el.focus(); el.select(); } }, ref);
  await page.keyboard.type(ref, { delay: 15 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2200);
}
