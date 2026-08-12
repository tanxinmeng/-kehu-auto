// M5 回写模块（最后一步）：勾选"是否处理=是"后，把 期次/手机号/顾问 写回腾讯文档源表 E/F/G；
// 运营填写的"顾问反馈"写回源表（AI 表 H 列 / 高 表 I 列）。
// 安全原则：
//   1) 定位：候选行 = ① 同步时的真实行(src_row) ② 复制校准行（xlsx 或 库内 订单+日期→行）
//      ③ 库内同订单其他行（重复订单兜底）；导航到 C<行> 读完整内容校验（订单号 + 反馈日期双重校验，±探测）
//   2) 写入：确认行号后才写；写后重新导航到该单元格逐格校验，校验不过记失败绝不静默
//   3) 每条回写结果写回 complaints.writeback_status / writeback_msg / writeback_at，网页可见
// 用法：
//   node src/writeback.js --dry-run                定位并校验，不写入（推荐先跑）
//   node src/writeback.js --confirm                定位校验后实际写入 E/F/G（processed=是 的记录）
//   node src/writeback.js --id 123 --confirm       只处理指定记录
//   node src/writeback.js --feedback --confirm     把 feedback_text 写回 H/I（AI: H 列 / 高: I 列）
//   node src/writeback.js --locate-only            不启动浏览器，仅打印定位结果（离线调试）
//   node src/writeback.js --copy-file "ai.txt,gao.txt"  用离线复制快照，不打开腾讯文档
//   node src/writeback.js --xlsx "路径"             用导出的 xlsx 校准行号（更精确；缺省自动用 data/doc_export.xlsx）
import fs from "node:fs";
import path from "node:path";
import config from "../config.json" with { type: "json" };
import { openDb } from "./db.js";
import { parseCopy, extractFields, extractOrder, normDate } from "./blocks.js";
import { log, launch, openDoc, clickTab, readCell, gotoCell, copyFromRow } from "./browser.js";

const ROOT = process.cwd();
const dataDir = path.join(ROOT, config.dataDir || "data");
const sessionFile = path.join(dataDir, "session.json");
const args = process.argv.slice(2);
function arg(name) { const i = args.indexOf("--" + name); return i >= 0 ? args[i + 1] : null; }
const DRY_RUN = args.includes("--dry-run");
const CONFIRM = args.includes("--confirm");
const LOCATE_ONLY = args.includes("--locate-only");
const FEEDBACK_MODE = args.includes("--feedback");
const USE_COPY = args.includes("--use-copy");   // 显式要求用复制校准（默认库内行号定位更快更稳）
const ID = Number(arg("id") || 0);
const BATCH = args.includes("--batch");
const BATCH_PHASE = arg("phase") || (BATCH ? "check" : "");
const batchSheet = arg("sheet") || "AI";
const batchStateFile = path.join(dataDir, "batch_state_" + batchSheet + ".json");
const NO_XLSX = args.includes("--no-xlsx");
const xlsxArg = arg("xlsx");
const xlsxPath = NO_XLSX ? null : (xlsxArg && fs.existsSync(xlsxArg) ? xlsxArg : null);   // 仅显式 --xlsx 才用；自动检测易踩损坏文件
const copyFile = arg("copy-file");
const wbCfg = config.writeback || {};
const MAXLEN = Number(wbCfg.maxLen || 500);
const FEEDBACK_COLS = wbCfg.feedbackCols || { AI: "H", 高: "I" };
const nowStr = () => new Date().toLocaleString("zh-CN");

// ---------- 校准数据 ----------
// xlsx 校准：order|date → [真实行号,...]
let xlsxOrderRows = null;
if (xlsxPath) {
  try {
    const { parseDocXlsx } = await import("./doc-parse.js");
    const t0 = Date.now();
    const xlsx = await parseDocXlsx(xlsxPath);
    xlsxOrderRows = {};
    for (const [sheetName, list] of Object.entries(xlsx)) {
      xlsxOrderRows[sheetName] = new Map();
      for (const r of list) {
        if (r.rn < 3) continue;
        const o = extractOrder(r.cells["C" + r.rn]);
        if (!o) continue;
        const d = normDate(r.cells["A" + r.rn]);
        const key = o + "|" + d;
        if (!xlsxOrderRows[sheetName].has(key)) xlsxOrderRows[sheetName].set(key, []);
        xlsxOrderRows[sheetName].get(key).push(r.rn);
      }
    }
    log("已加载 xlsx 校准: " + xlsxPath + " (" + ((Date.now() - t0) / 1000).toFixed(1) + "s)");
  } catch (e) {
    log("xlsx 校准加载失败（" + String(e.message || e).split("\n")[0] + "），改用库内行号定位");
    xlsxOrderRows = null;
  }
}

const db = openDb(dataDir);

// 库内校准：最近一次同步的真实行号（order|date → [src_row...]，order → [src_row...]）
const dbCal = { AI: { byKey: new Map(), byOrder: new Map() }, 高: { byKey: new Map(), byOrder: new Map() } };
for (const r of db.prepare("SELECT sheet, src_row, order_no, feedback_date FROM complaints").all()) {
  if (!r.order_no || !r.src_row) continue;
  const m = dbCal[r.sheet] || (dbCal[r.sheet] = { byKey: new Map(), byOrder: new Map() });
  const key = r.order_no + "|" + (r.feedback_date || "");
  if (!m.byKey.has(key)) m.byKey.set(key, []);
  m.byKey.get(key).push(r.src_row);
  if (!m.byOrder.has(r.order_no)) m.byOrder.set(r.order_no, []);
  m.byOrder.get(r.order_no).push(r.src_row);
}

// ---------- 定位 ----------
// 解析复制文本 → 带校准行号的记录数组（锚点 = 最后一个"有日期且能精确匹配校准"的块）
function locateOrders(rawText, sheet) {
  const recs = parseCopy(rawText);
  const out = [];
  for (const r of recs) {
    const f = extractFields(r, sheet);
    if (!f.order_no) continue;
    out.push({ order_no: f.order_no, date: f.feedback_date });
  }
  let anchor = null;
  const cal = dbCal[sheet];
  if (xlsxOrderRows && xlsxOrderRows[sheet]) {
    for (let i = out.length - 1; i >= 0; i--) {
      if (!out[i].date) continue;
      const rows = xlsxOrderRows[sheet].get(out[i].order_no + "|" + out[i].date) || [];
      if (rows.length) { anchor = { i, row: rows[rows.length - 1] }; break; }
    }
  } else if (cal && cal.byKey.size) {
    for (let i = out.length - 1; i >= 0; i--) {
      if (!out[i].date) continue;
      const rows = cal.byKey.get(out[i].order_no + "|" + out[i].date) || [];
      if (rows.length) { anchor = { i, row: rows[rows.length - 1] }; break; }
    }
  }
  for (let i = 0; i < out.length; i++) {
    out[i].row = anchor ? anchor.row + (i - anchor.i) : 0;   // 无校准 → 0（未知）
  }
  return out;
}

// 目标记录 → 候选行（去重，按与 src_row 接近度排序）
function candidateRowsFor(target) {
  const set = [];
  const push = (r) => { r = Number(r) || 0; if (r > 0 && !set.includes(r)) set.push(r); };
  push(target.src_row);                                    // ① 同步时的真实行
  const sheet = target.sheet;
  const same = (located[sheet] || []).filter(x =>
    x.order_no === String(target.order_no) &&
    (!target.feedback_date || !x.date || x.date === target.feedback_date));  // ② 复制校准行（同订单+同日期）
  same.sort((a, b) => Math.abs((a.row || 0) - (target.src_row || 0)) - Math.abs((b.row || 0) - (target.src_row || 0)));
  for (const x of same) push(x.row);
  for (const r of (dbCal[sheet]?.byOrder.get(String(target.order_no)) || [])) push(r);   // ③ 同订单其他行
  return set;
}

// 浏览器内定位：导航到 C<row> 读取完整内容，校验订单号；有反馈日期时再校验 A 列日期（重复订单区分）
async function findRow(page, target, candidates, range = 6) {
  const orderNo = String(target.order_no || "");
  const wantDate = target.feedback_date ? normDate(target.feedback_date) : "";
  const tried = [];
  async function tryRow(row) {
    row = Number(row) || 0;
    if (row <= 0 || tried.includes(row)) return null;
    tried.push(row);
    let cTxt = '';
    for (let retry = 0; retry < 3; retry++) {
      cTxt = await readCell(page, 'C' + row);
      if (cTxt && cTxt.length > 3 && cTxt !== 'C' + row) break;
      if (retry < 2) await page.waitForTimeout(1500);
    }
    if (!cTxt.includes(orderNo)) {
      log('  tryRow C' + row + ' 不含订单 ' + orderNo + '，读到: ' + JSON.stringify(cTxt.slice(0, 80)));
      return null;
    }
    if (wantDate) {
      const aTxt = await readCell(page, 'A' + row);
      const aDate = normDate(aTxt);
      if (aDate && aDate !== wantDate) return null;
    }
    return { row, text: cTxt.slice(0, 60) };
  }
  for (const r of candidates) { const f = await tryRow(r); if (f) return f; }
  const primary = candidates.find(r => r > 0) || 0;
  if (primary > 0) {
    for (let k = 1; k <= range; k++) {
      const f = (await tryRow(primary - k)) || (await tryRow(primary + k));
      if (f) return f;
    }
  }
  return null;
}

// ---------- 写入与校验 ----------
async function writeCell(page, ref, value) {
  await gotoCell(page, ref);
  // 腾讯文档：活动单元格用公式栏(div.formula-input)编辑最稳（实测 F2/直接输入/双击均不提交）
  const hasFormula = await page.evaluate(() => !!document.querySelector("div.formula-input"));
  if (hasFormula) {
    await page.evaluate(() => { const el = document.querySelector("div.formula-input"); if (el) el.focus(); });
    await page.waitForTimeout(400);
  } else {
    await page.keyboard.press("F2");   // 兜底：老机制
    await page.waitForTimeout(800);
  }
  await page.keyboard.press("Control+a");
  await page.keyboard.type(String(value), { delay: 10 });
  await page.waitForTimeout(300);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1800);
}
async function verifyCell(page, ref, expected) {
  const got = await readCell(page, ref);
  const norm = (s) => String(s == null ? "" : s).replace(/\s+/g, "");
  return norm(got) === norm(expected);
}

// ---------- 批量回填辅助（新） ----------
function normCell(v) { return String(v == null ? "" : v).replace(/\s+/g, ""); }
async function setClipboard(page, text) {
  return await page.evaluate((t) => new Promise((resolve) => {
    const fallback = () => {
      try {
        const ta = document.createElement("textarea");
        ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.focus(); ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        resolve(true);
      } catch (e) { resolve(false); }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(() => resolve(true)).catch(fallback);
    } else fallback();
  }), text);
}
// 名称框定位 → 点网格聚焦 → 用方向键微调回目标单元格（实测点击会移动选区，方向键可校正）
async function gotoCellAndFocus(page, ref) {
  const m = String(ref).match(/^([A-Z]+)(\d+)$/);
  if (!m) throw new Error("非法单元格引用 " + ref);
  const colA = (s) => { let n = 0; for (const ch of String(s)) n = n * 26 + (ch.charCodeAt(0) - 64); return n; };
  const wantCol = colA(m[1]), wantRow = Number(m[2]);
  await gotoCell(page, ref);
  await page.mouse.click(400, 320);
  await page.waitForTimeout(900);
  const cur = await page.evaluate(() => { const el = document.querySelector("input.bar-label"); return el ? String(el.value || "") : ""; });
  const cm = String(cur).match(/^([A-Z]+)(\d+)$/);
  if (!cm) throw new Error("点击后无法解析活动单元格: " + JSON.stringify(cur));
  const curCol = colA(cm[1]), curRow = Number(cm[2]);
  const dCol = wantCol - curCol, dRow = wantRow - curRow;
  if (Math.abs(dCol) > 30 || Math.abs(dRow) > 30) throw new Error("定位偏差过大(" + cur + " → " + ref + ")，已中止防止写错行");
  const press = async (n, key) => { for (let i = 0; i < Math.abs(n); i++) { await page.keyboard.press(key); await page.waitForTimeout(80); } };
  if (dCol < 0) await press(dCol, "ArrowLeft"); else if (dCol > 0) await press(dCol, "ArrowRight");
  if (dRow < 0) await press(dRow, "ArrowUp"); else if (dRow > 0) await press(dRow, "ArrowDown");
  await page.waitForTimeout(600);
}
// 一次性粘贴多行×3列文本块到 ref（TSV：行内 \t、行间 \n）
async function pasteBlock(page, ref, blockText) {
  const ok = await setClipboard(page, blockText);
  if (!ok) throw new Error("写入剪贴板失败，无法粘贴");
  await gotoCellAndFocus(page, ref);
  await page.keyboard.press("Control+v");
  await page.waitForTimeout(3500);
}
function batchWebMap(sheet) {
  const map = {};
  for (const r of db.prepare("SELECT src_row, order_no, fill_period, fill_phone, fill_tutor, src_period, src_phone, src_tutor, is_blank FROM complaints WHERE sheet=? ORDER BY src_row").all(sheet)) {
    map[r.src_row] = {
      order: String(r.order_no || ""),
      period: String(r.fill_period || r.src_period || ""),
      phone: String(r.fill_phone || r.src_phone || ""),
      tutor: String(r.fill_tutor || r.src_tutor || ""),
      isBlank: !!r.is_blank,
    };
  }
  return map;
}
async function batchCheck() {
  // 多采样点逐格校验：用 readCell 直接导航到 C 列（避免 copyFromRow 的行号映射偏差）
  const recs = db.prepare("SELECT src_row, order_no FROM complaints WHERE sheet=? AND is_blank=0 AND src_row IS NOT NULL AND order_no != '' ORDER BY src_row").all(batchSheet);
  if (!recs.length) { console.log("__BATCH_JSON__" + JSON.stringify({ ok:false, phase:"check", reason:"该表没有已同步的有效记录" })); db.close(); return; }
  db.prepare("UPDATE complaints SET mismatch=0, writeback_msg=NULL WHERE sheet=?").run(batchSheet);
  const top = recs[0].src_row;
  const bottom = recs[recs.length - 1].src_row;
  const middle = recs[Math.floor((recs.length - 1) / 2)].src_row;
  const web = batchWebMap(batchSheet);
  // 每隔 ~N 行取一个采样点（至少 top/middle/bottom，总共 ~10 个点）
  const step = Math.max(1, Math.floor((bottom - top) / 10));
  const samples = new Set([top, middle, bottom]);
  for (let r = top + step; r < bottom; r += step) samples.add(r);
  const sampleList = [...samples].sort((a, b) => a - b);
  log("批量检查：采样 " + sampleList.length + " 个点（共 " + recs.length + " 条记录）");
  const { ctx, page } = await launch();
  let mismatches = [];
  try {
    await openDoc(page);
    const barOk = await page.locator("input.bar-label").count();
    if (!barOk) throw new Error("腾讯文档未就绪（可能登录过期，请运行 start-login.bat 重新扫码）");
    await clickTab(page, batchSheet);
    await page.waitForTimeout(5000);
    for (const r of sampleList) {
      let srcOrder = "";
      for (let retry = 0; retry < 3; retry++) {
        const cTxt = await readCell(page, "C" + r);
        srcOrder = extractOrder(cTxt);
        if (srcOrder) break;
        if (retry < 2) await page.waitForTimeout(2000);
      }
      const want = String((web[r] || {}).order || "");
      if (srcOrder !== want) {
        mismatches.push({ row: r, srcOrder, want });
        if (mismatches.length >= 20) break;
      } else {
        log("[检查] 行" + r + " 订单" + srcOrder + " \u2713");
      }
    }
  } finally {
    await ctx.close().catch(() => {});
  }
  if (mismatches.length) {
    const detail = mismatches.slice(0, 5).map(m => "第" + m.row + "行 源[" + m.srcOrder + "]\u2260库[" + m.want + "]").join("\uff1b");
    const tail = mismatches.length > 5 ? " \u2026等共" + mismatches.length + "处" : "";
    console.log("__BATCH_JSON__" + JSON.stringify({ ok:false, phase:"check", reason:"对齐校验失败：" + detail + tail, top, middle, bottom, mismatchCount: mismatches.length, sampleMismatches: mismatches.slice(0, 5) }));
    db.close();
    return;
  }
  const state = { sheet: batchSheet, top, bottom, middle, N: recs.length, checkedAt: new Date().toISOString() };
  fs.writeFileSync(batchStateFile, JSON.stringify(state, null, 2), "utf8");
  console.log("__BATCH_JSON__" + JSON.stringify({ ok:true, phase:"check", sheet:batchSheet, top, bottom, middle, N: recs.length, ordersMatch:true }));
  db.close();
}
async function batchExec() {
  if (!fs.existsSync(batchStateFile)) { console.log("__BATCH_JSON__" + JSON.stringify({ ok:false, phase:"exec", reason:"请先执行批量检查" })); db.close(); return; }
  const st = JSON.parse(fs.readFileSync(batchStateFile, "utf8"));
  const top = st.top, bottom = st.bottom, middle = st.middle, N = st.N || 0;
  const web = batchWebMap(batchSheet);
  const samples = [top, middle, bottom];
  const { ctx, page } = await launch();
  let written = 0, rolledBack = false, reason = "";
  try {
    await openDoc(page);
    const barOk = await page.locator("input.bar-label").count();
    if (!barOk) throw new Error("腾讯文档未就绪（可能登录过期，请运行 start-login.bat 重新扫码）");
    await clickTab(page, batchSheet);
    // 预校验：顶/中/底 行号+订单号
    for (const r of samples) {
      const cTxt = await readCell(page, "C" + r);
      const srcOrder = extractOrder(cTxt);
      const want = (web[r] || {}).order || "";
      if (srcOrder !== want) throw new Error("对齐校验失败：第" + r + "行 源表订单[" + srcOrder + "] 与网页[" + want + "] 不一致，已中止（未粘贴）");
    }
    log("批量预校验通过：顶" + top + " / 中" + middle + " / 底" + bottom + " 行号与订单一致");
    const v = (s) => String(s == null ? "" : s).replace(/[\r\n]+/g, " ");
    const lines = [];
    for (let r = top; r <= bottom; r++) {
      const w = web[r] || {};
      lines.push([v(w.period), v(w.phone), v(w.tutor)].join("\t"));
    }
    const block = lines.join("\n").replace(/\n+$/, "");
    await pasteBlock(page, "E" + top, block);
    log("已粘贴 " + (bottom - top + 1) + " 行 × E/F/G 到第 " + top + " 行起");
	    // 等待腾讯文档完成渲染（大批量粘贴可能耗时较长）
	    await page.waitForTimeout(5000);
	    // 轻量探测：读一次单元格确认页面响应正常
	    try { await readCell(page, "E" + top); } catch (e) { await page.waitForTimeout(3000); }

	    // 读单元格（带重试，避免页面瞬时卡顿导致误判失败）
	    const readRetry = async (ref, retries = 3) => {
	      for (let i = 0; i < retries; i++) {
	        try { return await readCell(page, ref); } catch (e) {
	          if (i < retries - 1) { log("读取 " + ref + " 失败，第" + (i+1) + "次重试..."); await page.waitForTimeout(2000); }
	          else throw e;
	        }
	      }
	    };

	    // 末尾校验：顶/中/底 行号+订单号 + 期次/电话/助教 三格一致
	    let ok = true;
	    try {
	      for (const r of samples) {
	        const cTxt = await readRetry("C" + r);
	        const srcOrder = extractOrder(cTxt);
	        const w = web[r] || {};
	        if (srcOrder !== (w.order || "")) { ok = false; reason = "粘贴后订单对不上（第" + r + "行：源表=" + srcOrder + " 网页=" + (w.order || "") + "）"; break; }
	        const e = normCell(await readRetry("E" + r));
	        const f = normCell(await readRetry("F" + r));
	        const g = normCell(await readRetry("G" + r));
	        const we = normCell(w.period), wf = normCell(w.phone), wg = normCell(w.tutor);
	        if (e !== we || f !== wf || g !== wg) { ok = false; reason = "粘贴后数值对不上（第" + r + "行：期次[" + e + "]vs[" + we + "] 电话[" + f + "]vs[" + wf + "] 助教[" + g + "]vs[" + wg + "]）"; break; }
	        log("[校验] 行" + r + " 通过");
	      }
	    } catch (readErr) {
	      // 读取异常不直接当失败——再次等待后重试一轮
	      log("首轮校验异常：" + String(readErr.message || readErr).split("\n")[0] + "，等待后重试...");
	      await page.waitForTimeout(5000);
	      ok = true; reason = "";
	      for (const r of samples) {
	        try {
	          const cTxt = await readCell(page, "C" + r);
	          const srcOrder = extractOrder(cTxt);
	          const w = web[r] || {};
	          if (srcOrder !== (w.order || "")) { ok = false; reason = "粘贴后订单对不上（第" + r + "行）"; break; }
	          const e = normCell(await readCell(page, "E" + r));
	          const f = normCell(await readCell(page, "F" + r));
	          const g = normCell(await readCell(page, "G" + r));
	          if (e !== normCell(w.period) || f !== normCell(w.phone) || g !== normCell(w.tutor)) { ok = false; reason = "粘贴后数值对不上（第" + r + "行）"; break; }
	        } catch (e2) { ok = false; reason = "读取异常（第" + r + "行）: " + String(e2.message||e2).split("\n")[0]; break; }
	      }
	    }

	    if (ok) {
	      written = N;
	      const now = nowStr();
	      db.prepare(`UPDATE complaints SET writeback_status='ok', writeback_msg='批量回填成功', writeback_at=? WHERE sheet=? AND src_row BETWEEN ? AND ? AND order_no != ''`)
	        .run(now, batchSheet, top, bottom);
	      // 未掉落/过滤：无需钉钉，直接标记已处理
	      db.prepare(`UPDATE complaints SET processed='是', processed_at=?, mismatch=0 WHERE sheet=? AND src_row BETWEEN ? AND ? AND (fill_period='系统未掉落' OR fill_tutor LIKE '%爱芯过滤%' OR fill_tutor LIKE '%正价课拦截%') AND order_no != ''`)
	        .run(now, batchSheet, top, bottom);
	      // 其他记录：回写完成后，若钉钉也已发送则标记已处理
	      db.prepare(`UPDATE complaints SET processed='是', processed_at=? WHERE sheet=? AND src_row BETWEEN ? AND ? AND writeback_status='ok' AND ding_status='ok' AND order_no != ''
	        AND fill_period<>'系统未掉落' AND fill_tutor NOT LIKE '%爱芯过滤%' AND fill_tutor NOT LIKE '%正价课拦截%'`)
	        .run(now, batchSheet, top, bottom);
	      log("批量回填成功：记录 " + N + " 条，顶/中/底校验通过");
	    } else {
	      // 回滚：撤销粘贴（Ctrl+Z），并验证顶行 E 已不再等于网页值
	      await page.keyboard.press("Control+z");
	      await page.waitForTimeout(3000);
	      try {
	        const e = normCell(await readCell(page, "E" + top));
	        const wantE = normCell((web[top] || {}).period || "");
	        rolledBack = e !== wantE;
	      } catch (e3) { rolledBack = false; }
	      db.prepare(`UPDATE complaints SET writeback_status='fail', writeback_msg=?, writeback_at=? WHERE sheet=? AND src_row BETWEEN ? AND ?`)
	        .run("批量回填失败已回滚: " + reason, nowStr(), batchSheet, top, bottom);
	      log("批量回填失败（" + reason + "），已撤销粘贴：" + (rolledBack ? "成功" : "未确认，请人工按 Ctrl+Z 撤销"));
	    }
	  } catch (e) {
	    reason = String(e.message || e).split("\n")[0];
	    log("批量回填中止：" + reason);
	  } finally {
	    await ctx.close().catch(() => {});
	    db.close();
	  }
	  console.log("__BATCH_JSON__" + JSON.stringify({ ok: !reason, phase:"exec", sheet:batchSheet, top, bottom, written, rolledBack, reason }));
}

if (BATCH) {
  if (BATCH_PHASE === "check") await batchCheck();
  else if (BATCH_PHASE === "exec") await batchExec();
  else { log("--batch 需 --phase check|exec"); db.close(); process.exit(1); }
  process.exit(0);
}

// ---------- 目标 ----------
let targets;
if (ID) {
  targets = db.prepare("SELECT * FROM complaints WHERE id=?").all(ID);
} else if (FEEDBACK_MODE) {
  targets = db.prepare("SELECT * FROM complaints WHERE feedback_text IS NOT NULL AND feedback_text != ''").all();
} else {
  targets = db.prepare("SELECT * FROM complaints WHERE processed='是'").all();
}
log(`待回写 ${targets.length} 条（dry-run=${DRY_RUN}, confirm=${CONFIRM}, feedback=${FEEDBACK_MODE}, locate-only=${LOCATE_ONLY}）`);
if (!targets.length) { db.close(); process.exit(0); }
if (!LOCATE_ONLY && !fs.existsSync(sessionFile)) {
  log("未找到会话快照，请先运行 start-login.bat");
  db.close(); process.exit(1);
}

// ---------- 读取复制文本（离线 or 在线） ----------
// 说明：复制法（Ctrl+A→Ctrl+C→读剪贴板）在剪贴板不稳定/无权限时会失败；
// 失败不中断——自动降级为"库内真实行号(src_row)+同订单行"定位，浏览器逐格校验兜底。
let copies = {};
let copyError = "";
if (copyFile) {
  const [ai, gao] = String(copyFile).split(",");
  copies.AI = ai && fs.existsSync(ai) ? fs.readFileSync(ai, "utf8") : "";
  copies["高"] = gao && fs.existsSync(gao) ? fs.readFileSync(gao, "utf8") : "";
} else if (USE_COPY) {
  try {
    const { readDoc } = await import("./doc-read.js");
    copies = await readDoc();
  } catch (e) {
    copyError = String(e.message || e).split("\n")[0];
    log("复制读取失败，降级为库内行号定位: " + copyError);
  }
} else {
  log("未用复制校准（默认库内行号定位，更快；如需复制校准请加 --use-copy）");
}
const located = {};
for (const sheet of ["AI", "高"]) located[sheet] = locateOrders(copies[sheet] || "", sheet);
if (copyError) log("已用库内行号定位（候选=同步时真实行 + 同订单其他行），findRow 会逐格校验订单号/日期");

const updStatus = db.prepare(`UPDATE complaints SET writeback_status=?, writeback_msg=?, writeback_at=? WHERE id=?`);

if (LOCATE_ONLY) {
  for (const t of targets) {
    const cands = candidateRowsFor(t);
    const hit = (located[t.sheet] || []).filter(x => x.order_no === String(t.order_no));
    log(`[${t.id}] ${t.sheet}行${t.src_row} 订单${t.order_no} 候选行 ${cands.join(",") || "无"} | 复制命中 ${hit.length} 处`);
  }
  log("定位预览完成（未启动浏览器）。真实写入请去掉 --locate-only 并带 --confirm。");
  db.close();
  process.exit(0);
}

// ---------- 浏览器执行 ----------
const { ctx, page } = await launch();
let ok = 0, fail = 0;
try {
  await openDoc(page);
  const barOk = await page.locator("input.bar-label").count();
  if (!barOk) throw new Error("腾讯文档未就绪（可能登录过期，请运行 start-login.bat 重新扫码）");

  for (const t of targets) {
    const sheet = t.sheet;
    const order = String(t.order_no || "");
    if (!order) { updStatus.run("fail", "无订单号", nowStr(), t.id); fail++; log(`[${t.id}] ${sheet} 无订单号，跳过`); continue; }
    const candidates = candidateRowsFor(t);
    await clickTab(page, sheet);
    const found = await findRow(page, t, candidates);
    if (!found) {
      updStatus.run("fail", `无法定位到行（候选 ${candidates.join(",") || "无"}）`, nowStr(), t.id);
      fail++;
      log(`[${t.id}] ${sheet} 订单 ${order} 无法定位到行（候选 ${candidates.join(",") || "无"}）→ 未写入`);
      continue;
    }
    log(`[${t.id}] ${sheet} 订单 ${order} 定位到第 ${found.row} 行（候选 ${candidates.join(",") || "无"}）`);
    if (DRY_RUN) { updStatus.run("dry_ok", `已定位第${found.row}行（dry-run 未写入）`, nowStr(), t.id); ok++; continue; }
    if (CONFIRM) {
      try {
        const written = [];
        if (FEEDBACK_MODE) {
          const col = FEEDBACK_COLS[sheet] || (sheet === "AI" ? "H" : "I");
          const val = String(t.feedback_text || "").replace(/\n/g, " ").slice(0, MAXLEN);
          if (val) {
            await writeCell(page, col + found.row, val);
            if (!await verifyCell(page, col + found.row, val)) throw new Error("写后校验失败 " + col + found.row);
            written.push(col);
            log(`[${t.id}] ${sheet}行${found.row}${col} 已写入顾问反馈`);
          }
                } else {
          // 单行快速回填：行号+订单号已由 findRow 校验 → 期次/电话/助教 一次粘贴（不再逐格校验）
          const v = (s) => String(s == null ? "" : s).replace(/[\r\n]+/g, " ");
          const block = [v(t.fill_period || t.src_period), v(t.fill_phone || t.src_phone), v(t.fill_tutor || t.src_tutor)].join("\t");
          await pasteBlock(page, "E" + found.row, block);
          written.push("E/F/G");
          log(`[${t.id}] ${sheet}行${found.row} E/F/G 已一次性写入`);
        }
        updStatus.run("ok", `${sheet}行${found.row} ${written.join("/")} 已写入`, nowStr(), t.id);
        // 未掉落/过滤：无需钉钉，直接标记已处理
        const _perT = String(t.fill_period || "");
        const _tutT = String(t.fill_tutor || "");
        if (_perT === "系统未掉落" || _tutT.indexOf("爱芯过滤") >= 0 || _tutT.indexOf("正价课拦截") >= 0) {
          db.prepare("UPDATE complaints SET processed='是', processed_at=? WHERE id=?").run(nowStr(), t.id);
        } else {
          const dr = db.prepare("SELECT ding_status FROM complaints WHERE id=?").get(t.id);
          if (dr && dr.ding_status === 'ok') {
            db.prepare("UPDATE complaints SET processed='是', processed_at=? WHERE id=?").run(nowStr(), t.id);
          }
        }
        ok++;
        log(`[${t.id}] ${sheet}行${found.row} 写入成功: ${written.join(",")}`);
      } catch (e) {
        updStatus.run("fail", String(e.message || e).split("\n")[0], nowStr(), t.id);
        fail++;
        log(`[${t.id}] ${sheet} 写入失败: ${String(e.message || e).split("\n")[0]}`);
      }
    }
    await page.waitForTimeout(800);
  }
  log(`回写完成: 成功 ${ok}, 失败 ${fail}`);
} finally {
  await ctx.close().catch(() => {});
  db.close();
}



