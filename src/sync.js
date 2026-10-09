// 同步：手动按"起始行号"从源表拉取该行及以下的内容（真实行号标注）
// 用法：
//   node src/sync.js --sheet AI --start-row 10960    从源表第 10960 行及以下全部入库
//   node src/sync.js --sheet 高 --start-row 2707
// 行号原理：打开文档→导航到 C<起始行> 读取该行完整内容→在复制文本块序列中定位锚点块
//   → 锚点块=起始行，其后的块逐块+1（无订单的日期残留行也占位）
// 锚点匹配：优先用导航读到的 C 列完整内容精确匹配（重复订单时区分第几处）；匹配失败回退订单号取第一个
//   注意：绝不能用"最后一个匹配块"当锚点（重复订单会选错，导致后续行全部漏掉）
import path from "node:path";
import fs from "node:fs";
import config from "../config.json" with { type: "json" };
import { openDb, upsertComplaint, upsertBlankRow } from "./db.js";
import { parseCopyWithBlanks, extractFields, extractOrder } from "./blocks.js";
import { log, launch, openDoc, clickTab, copyFromRow, readCell, isGuestMode } from "./browser.js";

const ROOT = process.cwd();
const dataDir = process.env.KEHU_DATA_DIR ? path.resolve(process.env.KEHU_DATA_DIR) : path.join(ROOT, config.dataDir || "data");
const stateFile = path.join(dataDir, "sync_state.json");
const args = process.argv.slice(2);
function arg(name) { const i = args.indexOf("--" + name); return i >= 0 ? args[i + 1] : null; }
const sheet = arg("sheet") || "AI";
const startRow = Number(arg("start-row") || 0);
const copyFile = arg("copy-file");
const anchorOrder = arg("anchor-order");   // 离线模式：起始行订单号（用于定位锚点块）
const force = args.includes("--force");

function readState() { try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { return {}; } }
function saveState(s) { try { fs.writeFileSync(stateFile, JSON.stringify(s, null, 2), "utf8"); } catch {} }
function normText(s) { return String(s || "").replace(/\s+/g, ""); }
function normDate(d) {
  let s = String(d == null ? "" : d).trim();
  s = s.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  s = s.replace(/[，．、]/g, ".");
  s = s.replace(/^(\d+)\.(\d+)$/, (m, a, b) => Number(a) + "." + Number(b));
  return s;
}

async function loadSource(keepOpen = false) {
  if (copyFile) {
    const text = fs.readFileSync(copyFile, "utf8");
    return { text, anchorOrder: anchorOrder || "", anchorDate: "", anchorText: anchorOrder || "" };
  }
  const { ctx, page } = await launch();
  try {
    await openDoc(page);
    if (await isGuestMode(page)) throw new Error("文档游客只读模式（掉登录），复制被禁无法同步——请运行 start-login.bat 重新扫码后重试");
    if (!await clickTab(page, sheet)) throw new Error("找不到 " + sheet + " tab");
    // 表底边缘行渲染慢，readCell 可能读空（C1609 明明有值读到 ""，锚点定位直接失败）——空则重试
    let cText = "", aText = "";
    for (let k = 0; k < 3; k++) {
      if (!String(cText || "").trim()) cText = await readCell(page, "C" + startRow);
      if (!String(aText || "").trim()) aText = await readCell(page, "A" + startRow);
      if (String(cText || "").trim() && String(aText || "").trim()) break;
      if (k < 2) { log("[重试] 起始行读取为空（C=" + JSON.stringify(String(cText || "").slice(0, 20)) + "），2s 后重读"); await new Promise(r => setTimeout(r, 2000)); }
    }
    log("起始行 A" + startRow + "=" + JSON.stringify(String(aText || "").slice(0, 20)) + "  C" + startRow + "=" + JSON.stringify(String(cText || "").slice(0, 60)));
    // 复制"起始行以下"范围（比全表 Ctrl+A 复制更稳，且正合使用场景）
    // A 列为空时（新行客服还没填日期）传 emptyA：Ctrl+Shift+Down 需多按一次跨过空档
    const text = await copyFromRow(page, sheet, startRow, extractOrder(cText), { emptyA: !String(aText || "").trim() });
    return { text, anchorOrder: extractOrder(cText), anchorDate: normDate(aText), anchorText: cText, ctx, page };
  } finally {
    if (!keepOpen) await ctx.close().catch(() => {});
  }
}

function findAnchor(records, anchorOrder, anchorDate, anchorText) {
  // 1) 优先用导航读到的 C 列完整内容精确匹配（重复订单时能区分是第几处）
  if (anchorText) {
    const nt = normText(anchorText);
    if (nt) {
      for (let i = 0; i < records.length; i++) {
        if (records[i].customer_info && normText(records[i].customer_info) === nt) return i;
      }
    }
  }
  // 2) 回退：按订单号匹配，取第一个（绝不要取最后一个，重复订单会选错锚点导致漏行）
  if (anchorOrder) {
    const idx = records.findIndex(r => r.order_no === anchorOrder);
    return idx >= 0 ? idx : null;
  }
  return null;
}

const db = openDb(dataDir);
const state = readState();
if (!startRow || startRow < 3) { log("请用 --start-row 指定起始行号（>=3）"); db.close(); process.exit(1); }

const src = await loadSource(true);
const { text, anchorOrder: anchorOrder2, anchorDate, anchorText, ctx, page } = src;
log("复制样本(前300字): " + JSON.stringify(String(text || "").slice(0, 300)));
const parsed = parseCopyWithBlanks(text);
if (parsed.length > 3000) {
  // Ctrl+Shift+End 可能选中表格下方远处的杂散内容（空行会全部转成空白占位行）
  log("[警告] 复制范围异常大（" + parsed.length + " 行），疑似选中了表格外内容；仅处理前 3000 行，请检查源表是否有下方杂散内容");
  parsed.length = 3000;
}
const fields = parsed.filter(x => x.kind === "record").map(x => extractFields(x.rec, sheet));
log(sheet + " 解析到 " + parsed.length + " 行（其中含订单号记录 " + fields.filter(f => f.order_no).length + " 条，空白/残留占位 " + parsed.filter(x => x.kind !== "record").length + " 行）");

let anchorIdx = findAnchor(fields, anchorOrder2 || anchorOrder || "", anchorDate, anchorText);
if ((anchorIdx === null || anchorIdx === undefined) && !copyFile && fields.length > 0) {
  // C{startRow} 重试后仍读到空时锚点无法匹配——copyFromRow 固定从 startRow 开始复制且复制前
  // 校验过名称框位置，首个记录块就是起始行，直接锚定（2026-09-16 行1609 C列读空事故）
  log("[警告] C" + startRow + " 读取为空无法精确锚定，回退锚定首个记录块（复制固定从起始行开始）");
  anchorIdx = 0;
}
if (anchorIdx === null || anchorIdx === undefined) {
  log("无法定位起始行 " + startRow + " 对应的块（起始行可能为空或未复制到）。请检查行号后重试。");
  db.close();
  process.exit(1);
}
const anchorOrderFound = fields[anchorIdx].order_no;
const anchorOffset = fields[anchorIdx].offset ?? anchorIdx;
log("锚点块索引 " + anchorIdx + " → 源表行 " + startRow + "（订单 " + anchorOrderFound + "），其后有 " + (fields.length - 1 - anchorIdx) + " 个块");

let inserted = 0, updated = 0, skipped = 0, srcFilled = 0, noOrder = 0, blanks = 0, lastInsertedRow = 0;
const catFixes = [];   // 复制未含"问题归类"列时，待逐格读取 D 列补全的行
let recIdx = -1;          // 已扫描到的记录索引
let started = false;      // 锚点之后才开始处理
let consecBlank = 0;      // 连续占位行数（空白 + 日期残留都算）
let stoppedEarly = false; // 连续 3 条占位行 → 不再入库占位行（后续真实记录仍正常同步）
const base = startRow - anchorOffset;
for (const item of parsed) {
  if (item.kind !== "record") {
    if (!started) continue;          // 锚点之前的占位行不处理
    // blank = A-D 全空；residue = A 列日期残留（客服预填日期）。两者都算占位行——
    // residue 曾把计数器清零，导致表底大量残留行全部入库（2026-09-23 同步 23 条空白占位）。
    // 连续 3 条后不再入库占位行，但继续扫描（不 break）：表底之后的真实记录仍会同步，不会漏。
    consecBlank++;
    if (consecBlank >= 3) { stoppedEarly = true; continue; }
    const row = base + (item.offset ?? 0);
    upsertBlankRow(db, sheet, row);
    blanks++;
    lastInsertedRow = row;
    continue;
  }
  recIdx++;
  if (recIdx < anchorIdx) continue;  // 锚点之前的记录不处理
  started = true;
  consecBlank = 0;
  const row = base + (item.rec.offset ?? recIdx);
  const f = extractFields(item.rec, sheet);
  if (!f.order_no) {
    // 无订单号但有内容 → 仍入库，备注标注"无订单号"（情况少见，不做电话反查）
    const res = upsertComplaint(db, {
      sheet, src_row: row, feedback_date: f.feedback_date, customer_info: f.customer_info,
      order_no: "", category: f.category, src_period: f.src_period, src_phone: f.src_phone, src_tutor: f.src_tutor,
      src_feedback: f.src_feedback, date_key: null, internal_remark: "无订单号", dedup_key: sheet + "|" + row,
    });
    if (!f.category) catFixes.push({ row, id: res.id });
    noOrder++;
    lastInsertedRow = row;
    continue;
  }
  const dedupKey = sheet + "|" + row;
  const existing = db.prepare("SELECT id, is_blank FROM complaints WHERE dedup_key=?").get(dedupKey);
  if (existing && !existing.is_blank && !force) { skipped++; lastInsertedRow = row; continue; }
  const rec = {
    sheet, src_row: row,
    feedback_date: f.feedback_date,
    customer_info: f.customer_info,
    order_no: f.order_no,
    category: f.category,
    src_period: f.src_period,
    src_phone: f.src_phone,
    src_tutor: f.src_tutor,
    src_feedback: f.src_feedback,
    date_key: null,
    dedup_key: dedupKey,
  };
  if (f.src_period && f.src_phone && f.src_tutor) {
    rec.fill_period = f.src_period;
    rec.fill_phone = f.src_phone;
    rec.fill_tutor = f.src_tutor;
    rec.query_status = "filled";
    rec.processed = "是";
    rec.processed_at = new Date().toLocaleString("zh-CN");
    rec.query_remark = "源表已填";
    srcFilled++;
  }
  const res = upsertComplaint(db, rec);
  if (!f.category) catFixes.push({ row, id: res.id });
  if (res.inserted) inserted++; else updated++;
  lastInsertedRow = row;
}
// 验证对齐：读取最后一行 C 列订单号与最后一条记录比对，检测 Ctrl+Shift+ArrowDown 漏空白行的偏移
// 占位行提前截断后真实记录仍全部入库，校验依然有效（不再因 stoppedEarly 跳过）
if (page && lastInsertedRow && fields.length > anchorIdx + 1) {
  const lastField = fields[fields.length - 1];
  if (lastField.order_no && lastField.offset != null) {
    const expectedRow = base + lastField.offset;
    const cTxt = await readCell(page, "C" + expectedRow);
    const actualOrder = extractOrder(cTxt);
    if (actualOrder && actualOrder !== lastField.order_no) {
      let foundRow = 0;
      for (let off = -8; off <= 8; off++) {
        if (off === 0) continue;
        const t = await readCell(page, "C" + (expectedRow + off));
        if (extractOrder(t) === lastField.order_no) { foundRow = expectedRow + off; break; }
      }
      if (foundRow) {
        const drift = foundRow - expectedRow;
        log(`[警告] 对齐偏移：末记录锚定在行 ${expectedRow}，实测在行 ${foundRow}，偏移 ${drift}（源表可能有空白行被 Ctrl+Shift+ArrowDown 跳过）。建议用更小的起始行范围重新同步，避开空白行区间。`);
      }
    }
  }
}
// 复制选区可能漏掉 D 列（问题归类）——对归类为空的行逐格读取源表 D 列补全
if (catFixes.length && page) {
  // 复制操作后页面焦点/选区状态可能异常，先点击网格恢复，再开始逐格读取
  try { await page.mouse.click(400, 320); await page.waitForTimeout(900); } catch {}
  log("复制未含问题归类列，改为逐格读取 D 列补全 " + catFixes.length + " 条...");
  let fixed = 0, empty = 0;
  for (let k = 0; k < catFixes.length; k++) {
    const fx = catFixes[k];
    let d = String(await readCell(page, "D" + fx.row) || "").trim().replace(/\++$/g, "");
    if (!d) {
      // 兜底：进入编辑态从公式栏读取（腾讯文档活动单元格用 div.formula-input 最稳）
      try {
        await page.keyboard.press("F2");
        await page.waitForTimeout(800);
        d = await page.evaluate(() => {
          const el = document.querySelector("div.formula-input");
          return el ? String(el.innerText || el.textContent || "").trim() : "";
        }).catch(() => "");
        await page.keyboard.press("Escape");
        await page.waitForTimeout(400);
      } catch {}
    }
    if (k === 0) {
      const box = await page.evaluate(() => { const el = document.querySelector("input.bar-label"); return el ? el.value : ""; }).catch(() => "");
      log("[诊断] D" + fx.row + " 名称框=" + JSON.stringify(box) + " 读到=" + JSON.stringify(d));
    }
    if (d) { db.prepare("UPDATE complaints SET category=? WHERE id=?").run(d, fx.id); fixed++; }
    else empty++;
  }
  log("D 列补全完成：成功 " + fixed + " 条" + (empty ? "，" + empty + " 条源表 D 列为空" : ""));
}
if (ctx) await ctx.close().catch(() => {});
const lastRow = lastInsertedRow || startRow;
state[sheet] = { ...(state[sheet] || {}), lastRow, startRow, count: Math.max(0, recIdx - anchorIdx), stoppedEarly, updatedAt: new Date().toISOString() };
saveState(state);
log(`同步完成: ${sheet} 从 ${startRow} 行起（表内到约 ${lastRow} 行）${stoppedEarly ? "，连续 3 条空白/残留占位行后未再入库占位行" : ""}，新增 ${inserted}, 更新 ${updated}, 跳过(已存在) ${skipped}, 空白占位 ${blanks}, 无订单行 ${noOrder}, 源表已填 ${srcFilled} 条`);
db.close();
