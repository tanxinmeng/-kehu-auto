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
import { openDb, upsertComplaint } from "./db.js";
import { parseCopy, parseCopyWithBlanks, extractFields, extractOrder, normDate, alignDiff } from "./blocks.js";
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
const IDS = String(arg("id") || "").split(",").map(s => Number(String(s).trim())).filter(n => n > 0);   // server 传逗号串，必须拆（Number("1,2")→NaN 曾致多 id 全部失效走默认分支）
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
      // 防残留值误判：名称框导航已确认但新格内容未渲染完时，readCell 会把上一格文本当成
      // 本行（2026-10-10 19:18 批量回填 7 条全误判"无法定位到行"，同格 20s 后重读即正确）。
      // 不含订单 ≠ 真不匹配——等 2.5s 复读一次，仍不含才算真不匹配
      await page.waitForTimeout(2500);
      const cTxt2 = await readCell(page, 'C' + row);
      if (String(cTxt2 || "").includes(orderNo)) {
        cTxt = cTxt2;
      } else {
        log('  tryRow C' + row + ' 不含订单 ' + orderNo + '，读到: ' + JSON.stringify(cTxt.slice(0, 80)));
        return null;
      }
    }
    if (wantDate) {
      let aTxt = await readCell(page, 'A' + row);
      let aDate = normDate(aTxt);
      if (aDate && aDate !== wantDate) {
        await page.waitForTimeout(2500);
        aDate = normDate(await readCell(page, 'A' + row));
      }
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
// 掉登录时文档以游客只读模式打开：读正常、所有写入通道静默失效（公式栏不可编辑/打字无响应/粘贴落空），
// 必须在写之前检测，否则只报"写后校验失败"无从排查（2026/9/13 实测）
async function assertDocWritable(page) {
  const guest = await page.evaluate(() => /(^|\s)skeleton-guest-mode(\s|$)/.test(document.body.className || ""));
  if (guest) throw new Error("腾讯文档已掉登录（游客只读模式），请运行 start-login.bat 重新扫码后再回填");
}

// 硬红线（2026-10-14 事故）：客诉源表 C/D 列绝不允许程序写入——C=客户信息/订单、D=问题归类，
// 程序没有这两列的完整原文，写坏无法自动恢复。任何对 C/D 的写入直接抛错中止。
async function writeCell(page, ref, value) {
  const m = String(ref).match(/^([A-Z]+)(\d+)$/);
  if (!m) throw new Error("非法单元格引用 " + ref);
  const col = m[1].toUpperCase();
  if (col === "C" || col === "D") throw new Error("禁止写入 " + ref + "：客诉源表 C/D 列绝不允许程序改动");

  await gotoCell(page, ref);
  // 焦点必须实测落在公式栏才允许输入（2026-10-14 高表3398/3399 C列被改事故）：
  // 此前 el.focus() 后直接 Ctrl+A/输入，焦点没进去时输入落进当前活动格——而写前订单校验
  // 刚把活动格停在 C{r}，E 列的值就被打进了 C 列。现在焦点没验证通过一律中止，绝不盲打。
  let focused = false;
  for (let attempt = 0; attempt < 2 && !focused; attempt++) {
    focused = await page.evaluate(() => {
      const el = document.querySelector("div.formula-input");
      if (!el) return false;
      el.focus();
      const ae = document.activeElement;
      return ae === el || !!(ae && el.contains(ae));
    });
    if (!focused) {
      if (attempt === 0) { await page.waitForTimeout(600); continue; }
      // F2 兜底：进入活动单元格编辑态，焦点自然落在编辑区
      await page.keyboard.press("F2");
      await page.waitForTimeout(500);
      focused = await page.evaluate(() => {
        const el = document.querySelector("div.formula-input");
        const ae = document.activeElement;
        return !!(ae && ((el && (ae === el || el.contains(ae))) || (ae.closest && ae.closest("div.formula-input, [contenteditable='true']"))));
      });
    }
  }
  if (!focused) throw new Error("写入 " + ref + " 前无法确认输入焦点在公式栏，已中止（宁可失败也绝不误写其他单元格）");

  await page.keyboard.press("Control+a");
  await page.keyboard.type(String(value), { delay: 5 });
  await page.waitForTimeout(150);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
}
async function verifyCell(page, ref, expected) {
  const got = await readCell(page, ref);
  const norm = (s) => String(s == null ? "" : s).replace(/\s+/g, "");
  return norm(got) === norm(expected);
}

// ---------- 批量回填辅助（新） ----------
function normCell(v) { return String(v == null ? "" : v).replace(/\s+/g, ""); }
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
  // 源表为准（2026-10-12）：整段复制一次 + 本地全量 diff，取代采样逐格读。
  //   插行/删行（含空白行）→ alignDiff 精确定位偏移起点，受影响段平移 src_row；
  //   订单号被改/新增 → 就地按源表刷新入库（upsertComplaint：订单变了旧查询结果作废待重查）；
  //   行被删/清空 → 按源表清除；
  //   执行阶段跳过未就绪的行（skipRows 写入 state），不再一票否决整批；
  //   兜底：整段复制失败 → 退回采样逐格读校验（只读不修，报错走人工）。
  let top = 0, middle = 0, bottom = 0, N = 0;
  let shiftCount = 0, refreshedCount = 0, pendingCount = 0, clearedCount = 0, appendedCount = 0;
  let lastB = 0, lastK = 0, note = "", fatal = "";
  const refreshedIds = [];
  const dbRowsStmt = () => db.prepare("SELECT id, src_row, order_no, is_blank, query_status, writeback_status, processed FROM complaints WHERE sheet=? AND src_row IS NOT NULL ORDER BY src_row").all(batchSheet);
  let allRows = dbRowsStmt();
  if (!allRows.some(r => !r.is_blank && r.order_no)) { console.log("__BATCH_JSON__" + JSON.stringify({ ok:false, phase:"check", reason:"该表没有已同步的有效记录" })); db.close(); return; }
  // 只清 mismatch，不清 writeback_msg：清掉 msg 会抹掉上次失败的诊断原因（只显示"失败"无从排查）
  db.prepare("UPDATE complaints SET mismatch=0 WHERE sheet=?").run(batchSheet);
  const { ctx, page } = await launch();
  try {
    await openDoc(page);
    const barOk = await page.locator("input.bar-label").count();
    if (!barOk) throw new Error("腾讯文档未就绪（可能登录过期，请运行 start-login.bat 重新扫码）");
    await assertDocWritable(page);
    await clickTab(page, batchSheet);
    await page.waitForTimeout(2500);
    for (let round = 1; round <= 4 && !fatal; round++) {
      allRows = dbRowsStmt();
      const dbMap = {};
      top = 0; bottom = 0;
      for (const r of allRows) {
        dbMap[r.src_row] = r.is_blank ? "" : String(r.order_no || "");
        if (!r.is_blank && r.order_no) {
          if (!top || r.src_row < top) top = r.src_row;
          if (r.src_row > bottom) bottom = r.src_row;
        }
      }
      const orderedRows = allRows.filter(r => !r.is_blank && r.order_no).map(r => r.src_row);
      N = orderedRows.length;
      middle = orderedRows[Math.floor((orderedRows.length - 1) / 2)];
      const topOrder = String(dbMap[top] || "");
      if (!topOrder) { fatal = "该表没有已同步的有效记录"; break; }
      log("批量检查第" + round + "轮：范围 " + top + "-" + bottom + "（共 " + N + " 条记录），整段复制源表…");
      // 把一段复制文本并入 srcMap（锚点=anchorOrder 所在块对齐到 startRow 行），返回最大行号（找不到锚点返回 -1）
      const mergeCopy = (text, startRow, anchorOrder, map) => {
        const parsed = parseCopyWithBlanks(text);
        const recItems = parsed.filter(x => x.kind === "record");
        const anchorIdx = recItems.findIndex(x => extractFields(x.rec, batchSheet).order_no === anchorOrder);
        if (anchorIdx < 0) return -1;
        const base = startRow - (recItems[anchorIdx].rec.offset ?? anchorIdx);
        let maxRow = startRow;
        for (const item of parsed) {
          const off = item.kind === "record" ? (item.rec.offset ?? 0) : (item.offset ?? 0);
          const row = base + off;
          if (row < startRow) continue;
          if (item.kind === "record") {
            const f = extractFields(item.rec, batchSheet);
            map[row] = f.order_no || "";
            map["#" + row] = f;
          }
          if (row > maxRow) maxRow = row;
        }
        return maxRow;
      };
      // 快路径：从 top 整段复制到表底，一次拿到源表现状
      // top 行 A 列为空时必须传 emptyA（同 sync.js）：单按 Ctrl+Shift+Down 跨不过空档，复制会截断
      // 交叉验证：A 读到非空才敢判"非空"，同时读 C{top} 确认落在锚点行且数据已就绪
      // （readCell 有残值竞态，C 对不上 = 读数不可信 → 按 empty 处理；多按一次 Down 无害，漏按才会截断）
      let topAEmpty = true;
      for (let i = 0; i < 3; i++) {
        const aTxt = String(await readCell(page, "A" + top) || "").trim();
        if (aTxt) {
          const cTxt = String(await readCell(page, "C" + top) || "");
          topAEmpty = !cTxt.includes(topOrder) ? true : false;
          break;
        }
        if (i === 2) { topAEmpty = true; break; }
        await page.waitForTimeout(1500);
      }
      let srcMap = null, srcMax = top;
      const coverSpans = [];   // 复制实际覆盖的行区间集合：对齐守卫按区间判断，不能只看最大行号
      try {
        const text = await copyFromRow(page, batchSheet, top, topOrder, { retries: 2, emptyA: topAEmpty });
        const parsed = parseCopyWithBlanks(text);
        const recItems = parsed.filter(x => x.kind === "record");
        let anchorIdx = recItems.findIndex(x => extractFields(x.rec, batchSheet).order_no === topOrder);
        if (anchorIdx < 0) { log("[警告] 复制内容未找到首行订单锚点，回退锚定首个记录块"); anchorIdx = 0; }
        const base = top - (recItems[anchorIdx].rec.offset ?? anchorIdx);
        srcMap = {};
        for (const item of parsed) {
          const off = item.kind === "record" ? (item.rec.offset ?? 0) : (item.offset ?? 0);
          const row = base + off;
          if (row < top) continue;
          if (item.kind === "record") {
            const f = extractFields(item.rec, batchSheet);
            srcMap[row] = f.order_no || "";
            srcMap["#" + row] = f;   // 该行完整字段，供 rows 分支刷新入库
          }
          if (row > srcMax) srcMax = row;
        }
        coverSpans.push([top, srcMax]);
      } catch (e) {
        log("[警告] 整段复制失败（" + String(e.message || e).split("\n")[0] + "），退回采样逐格读校验");
      }
      // 尾部补合并：整段复制靠 Ctrl+Shift+Down 顺 A 列连续区向下扩展，中间一旦出现 A 列空行
      // （2026-10-13 行2549 客服漏填日期 → 复制止于 2548），库内空档之后的行会被 alignDiff
      // 误判成"源表已删除"而清库（2562/2563 误删事故）。从库内最后一行再补一段复制并入 srcMap；
      // 补段先单独解析并与库内已知订单交叉验证（重复订单/合并单元格会让锚点错位，错位即弃用），
      // 该行真被删时锚点匹配不到，跳过合并按原判处理。
      // 注意：补段与主段之间可能仍有未覆盖的洞（洞里的行两边复制都拿不到），所以覆盖必须记区间。
      const dbBottomOrder = String(dbMap[bottom] || "");
      if (srcMap && dbBottomOrder && srcMax < bottom) {
        try {
          const text2 = await copyFromRow(page, batchSheet, bottom, dbBottomOrder, { retries: 2 });
          const tailMap = {};
          const tailMax = mergeCopy(text2, bottom, dbBottomOrder, tailMap);
          if (tailMax > 0) {
            let bad = "";
            if (tailMap[bottom] !== dbBottomOrder) bad = "锚点行" + bottom + " 对不上（补[" + tailMap[bottom] + "] 库[" + dbBottomOrder + "]）";
            for (let r = bottom + 1; r <= tailMax && !bad; r++) {
              if (dbMap[r] && tailMap[r] !== undefined && tailMap[r] !== dbMap[r]) bad = "行" + r + " 订单与库不一致";
            }
            if (bad) {
              log("[警告] 补复制交叉验证失败（" + bad + "），弃用补段（按整段复制结果继续，安全降级）");
            } else {
              for (const key of Object.keys(tailMap)) srcMap[key] = tailMap[key];
              if (tailMax > srcMax) srcMax = tailMax;
              coverSpans.push([bottom, tailMax]);
              log("整段复制止于行" + srcMax + " 之前（A 列空档截断），已从行" + bottom + " 补复制合并（交叉验证通过），重新校验");
            }
          } else {
            log("[提示] 从行" + bottom + " 补复制未找到锚点订单，按整段复制结果继续");
          }
        } catch (e) {
          log("[提示] 从行" + bottom + " 补复制失败（" + String(e.message || e).split("\n")[0] + "），按整段复制结果继续");
        }
      }
      let progressed = false;
      if (srcMap) {
        const d = alignDiff(dbMap, srcMap, top, bottom, srcMax, coverSpans);
        appendedCount = 0;
        for (let r = bottom + 1; r <= srcMax; r++) if (srcMap[r]) appendedCount++;
        if (d.type === "clean") {
          if (appendedCount) log("源表第" + bottom + "行之后新增 " + appendedCount + " 行订单，超出本批范围（重新同步即可纳入），本轮不处理");
          break;
        }
        if (d.type === "shift") {
          const { B, k, orphans } = d;
          // 占位行是同步快照，平移后必然错位，直接清掉（下次同步重建）
          db.prepare("DELETE FROM complaints WHERE sheet=? AND is_blank=1 AND src_row>=?").run(batchSheet, B);
          for (const orow of orphans) {
            db.prepare("DELETE FROM complaints WHERE sheet=? AND src_row=? AND order_no != ''").run(batchSheet, orow);
            clearedCount++;
            log("行" + orow + " 订单已从源表删除（原" + (dbMap[orow] || "") + "），按源表清除");
          }
          // dedup_key UNIQUE：先置临时键、平移 src_row、再落最终键
          // （单条 UPDATE 里 dedup_key=sheet||'|'||src_row 取的是平移前旧值，必须拆开）
          // k<0 且无孤儿（删的是空白行，krow 平移）时 B 行本身是幸存者必须平移；
          // 孤儿场景 B 行已被删，从 B+1 开始。落点区 [B+k, B) 的占位/已清空行先删，
          // 否则平移后撞 dedup_key UNIQUE（k<0 落点区行号都上移，必然与未平移的行重叠）。
          const lo = (k > 0 || orphans.length === 0) ? B : B + 1;
          try {
            db.exec("BEGIN");
            if (k < 0) {
              const land = db.prepare("DELETE FROM complaints WHERE sheet=? AND src_row>=? AND src_row<? AND (order_no='' OR order_no IS NULL)").run(batchSheet, B + k, B);
              if (land.changes) log("平移落点区清掉 " + land.changes + " 行占位/空行（" + (B + k) + "-" + (B - 1) + "）");
            }
            db.prepare("UPDATE complaints SET dedup_key='rebase:'||id WHERE sheet=? AND src_row>=?").run(batchSheet, lo);
            db.prepare("UPDATE complaints SET src_row=src_row+? WHERE dedup_key LIKE 'rebase:%'").run(k);
            db.prepare("UPDATE complaints SET dedup_key=sheet||'|'||src_row WHERE dedup_key LIKE 'rebase:%'").run();
            db.exec("COMMIT");
          } catch (e) {
            db.exec("ROLLBACK");
            throw e;
          }
          shiftCount++; lastB = B; lastK = k;
          log("源表第" + B + "行起整体偏移 " + (k > 0 ? "+" : "") + k + " 行，库中行号已平移，重新校验");
          progressed = true;
        } else if (d.type === "rows") {
          if (d.changes.length > 30) { fatal = "源表与库差异过大（" + d.changes.length + " 行），请先重新同步再批量回填"; break; }
          for (const ch of d.changes) {
            if (ch.srcOrder) {
              const f = srcMap["#" + ch.row];
              const rec = { sheet: batchSheet, src_row: ch.row, feedback_date: f ? f.feedback_date : null, customer_info: f ? f.customer_info : null, order_no: ch.srcOrder, category: f ? f.category : null, src_period: f ? f.src_period : null, src_phone: f ? f.src_phone : null, src_tutor: f ? f.src_tutor : null, src_feedback: f ? f.src_feedback : null, date_key: null, dedup_key: batchSheet + "|" + ch.row };
              if (f && f.src_period && f.src_phone && f.src_tutor) {
                rec.fill_period = f.src_period; rec.fill_phone = f.src_phone; rec.fill_tutor = f.src_tutor;
                rec.query_status = "filled"; rec.processed = "是"; rec.query_remark = "源表已填";
              } else {
                pendingCount++;
              }
              const res = upsertComplaint(db, rec);
              refreshedIds.push(res.id);
              refreshedCount++;
              log("行" + ch.row + " 订单 " + (ch.dbOrder || "(空)") + "→" + ch.srcOrder + "，已按源表更新" + (ch.dbOrder && ch.dbOrder !== ch.srcOrder ? "（旧查询结果作废，需重新查询）" : ""));
            } else {
              db.prepare("UPDATE complaints SET order_no='', fill_period=NULL, fill_phone=NULL, fill_tutor=NULL, query_status='blank', processed='', writeback_status='', mismatch=0, query_remark=? WHERE sheet=? AND src_row=? AND order_no != ''")
                .run("源表该行订单已删除/清空，按源表清除", batchSheet, ch.row);
              clearedCount++;
              log("行" + ch.row + " 源表已无订单（原" + ch.dbOrder + "），按源表清除");
            }
            progressed = true;
          }
        }
      } else {
        // 兜底：采样逐格读校验（老路径，只读不修，对不上即报错走人工）
        const web = batchWebMap(batchSheet);
        const step = Math.max(1, Math.floor((bottom - top) / 10));
        const samples = new Set([top, middle, bottom]);
        for (let r = top + step; r < bottom; r += step) samples.add(r);
        let mismatches = 0, first = "";
        for (const r of [...samples].sort((a, b) => a - b)) {
          let srcOrder = "";
          for (let retry = 0; retry < 3; retry++) {
            srcOrder = extractOrder(await readCell(page, "C" + r));
            if (srcOrder) break;
            if (retry < 2) await page.waitForTimeout(2000);
          }
          const want = String((web[r] || {}).order || "");
          if (srcOrder !== want) { mismatches++; if (!first) first = "第" + r + "行 源[" + srcOrder + "]≠库[" + want + "]"; }
        }
        if (mismatches) { fatal = "对齐校验失败：" + first + (mismatches > 1 ? " 等共" + mismatches + "处（整段复制不可用，无法自动对齐）" : ""); break; }
        break;
      }
      if (!progressed) { fatal = "对齐失败：源表与库无法自动对齐，请重新同步后再批量回填"; break; }
    }
  } catch (e) {
    fatal = String(e.message || e).split("\n")[0];
  } finally {
    await ctx.close().catch(() => {});
  }
  if (fatal) {
    console.log("__BATCH_JSON__" + JSON.stringify({ ok:false, phase:"check", reason: fatal, top, middle, bottom, N }));
    db.close();
    return;
  }
  // 最终状态：重算范围 + 未就绪行（执行阶段跳过，不再一票否决整批）
  allRows = dbRowsStmt();
  const orderedRows = allRows.filter(r => !r.is_blank && r.order_no).map(r => r.src_row);
  if (!orderedRows.length) { console.log("__BATCH_JSON__" + JSON.stringify({ ok:false, phase:"check", reason:"该表没有已同步的有效记录" })); db.close(); return; }
  top = orderedRows[0]; bottom = orderedRows[orderedRows.length - 1];
  middle = orderedRows[Math.floor((orderedRows.length - 1) / 2)];
  N = orderedRows.length;
  const byRow = new Map(allRows.map(r => [r.src_row, r]));
  const skipRows = [];
  let doneRows = 0;
  for (let r = top; r <= bottom; r++) {
    const rec = byRow.get(r);
    // 库内无记录的行绝不写入（防止把源表已有内容清空）；无订单/待查询的行本轮跳过
    if (!rec || rec.is_blank || !rec.order_no || rec.query_status === "pending") skipRows.push(r);
    // 已回填成功且已处理的行：E/F/G 早已写入源表，重写是无谓耗时，直接跳过
    else if (rec.writeback_status === "ok" && rec.processed === "是") { skipRows.push(r); doneRows++; }
  }
  const parts = [];
  if (shiftCount) parts.push("源表第" + lastB + "行起偏移" + (lastK > 0 ? "+" : "") + lastK + "行已自动对齐");
  if (refreshedCount) parts.push(refreshedCount + "行订单已按源表更新" + (pendingCount ? "（其中" + pendingCount + "行需重新查询）" : ""));
  if (clearedCount) parts.push(clearedCount + "行已按源表清除");
  note = parts.join("；");
  if (note) log(note);
  const state = { sheet: batchSheet, top, bottom, middle, N, skipRows, checkedAt: new Date().toISOString() };
  fs.writeFileSync(batchStateFile, JSON.stringify(state, null, 2), "utf8");
  console.log("__BATCH_JSON__" + JSON.stringify({ ok:true, phase:"check", sheet:batchSheet, top, bottom, middle, N, ordersMatch:true, alreadyDone: doneRows || undefined, reconciled: note || undefined, refreshedIds: [...new Set(refreshedIds)], appended: appendedCount || undefined }));
  db.close();
}
async function batchExec() {
  if (!fs.existsSync(batchStateFile)) { console.log("__BATCH_JSON__" + JSON.stringify({ ok:false, phase:"exec", reason:"请先执行批量检查" })); db.close(); return; }
  const st = JSON.parse(fs.readFileSync(batchStateFile, "utf8"));
  const top = st.top, bottom = st.bottom, middle = st.middle, N = st.N || 0;
  // 未就绪的行（库内无记录/无订单/待查询）跳过不写，不再一票否决整批（2026-10-12 源表为准）
  const skipSet = new Set(st.skipRows || []);
  const web = batchWebMap(batchSheet);
  const samples = [top, middle, bottom].filter(r => !skipSet.has(r));
  const { ctx, page } = await launch();
  let written = 0, skippedCount = 0, rolledBack = false, reason = "", ok = false;
  try {
    await openDoc(page);
    const barOk = await page.locator("input.bar-label").count();
    if (!barOk) throw new Error("腾讯文档未就绪（可能登录过期，请运行 start-login.bat 重新扫码）");
    await assertDocWritable(page);
    await clickTab(page, batchSheet);
    // 预校验：顶/中/底 行号+订单号（跳过的行不校验）
    for (const r of samples) {
      const cTxt = await readCell(page, "C" + r);
      const srcOrder = extractOrder(cTxt);
      const want = (web[r] || {}).order || "";
      if (srcOrder !== want) throw new Error("对齐校验失败：第" + r + "行 源表订单[" + srcOrder + "] 与网页[" + want + "] 不一致，已中止（未粘贴）");
    }
    log("批量预校验通过：顶" + top + " / 中" + middle + " / 底" + bottom + " 行号与订单一致" + (skipSet.size ? "（跳过 " + skipSet.size + " 行未就绪）" : ""));
    const v = (s) => String(s == null ? "" : s).replace(/[\r\n]+/g, " ");
    // 剪贴板批量粘贴在腾讯文档上不可靠（2026/9/10 起静默失效：整块只落首格甚至整块丢失），
    // 改用逐格写入（writeCell 公式栏通道）+ 逐格校验，失败精确定位到单元格
    log("开始逐格写入 E/F/G（共 " + (bottom - top + 1 - skipSet.size) + " 行 × 3 列）...");
    let writeErr = "";
    for (let r = top; r <= bottom && !writeErr; r++) {
      // 检查→执行间隔内被 delete-batch 删掉/清空的行：web 无记录 → 绝不能按空值写源表（会清空 E/F/G）
      if (skipSet.has(r) || !web[r] || !String(web[r].order || "")) {
        skippedCount++; log("[跳过] 行" + r + " 未就绪（无订单/待查询/已被删除），本轮不写"); continue;
      }
      const w = web[r];
      // 写前逐行校验该行 C 列订单号：预校验只抽查顶/中/底，检查与执行之间源表被就地改动
      // （换订单/插删行）时，绝不能把旧客户的期次/手机号写进新客户的行（2026-10-13 审查 #3）
      let srcOrder = "";
      for (let attempt = 0; attempt < 2; attempt++) {
        srcOrder = extractOrder(await readCell(page, "C" + r));
        if (srcOrder === String(w.order)) break;
        if (attempt === 0) { log("行" + r + " 写前订单校验未过（源[" + srcOrder + "] 库[" + w.order + "]），2.5s 复读"); await page.waitForTimeout(2500); }
      }
      if (srcOrder !== String(w.order)) {
        writeErr = "行" + r + " 写前订单校验失败：源表[" + srcOrder + "] ≠ 库[" + w.order + "]，已中止（该行未写入）";
        break;
      }
      const vals = [["E", v(w.period)], ["F", v(w.phone)], ["G", v(w.tutor)]];
      for (const [col, val] of vals) {
        let done = false;
        for (let attempt = 0; attempt < 2 && !done; attempt++) {
          await writeCell(page, col + r, val);
          done = await verifyCell(page, col + r, val);
          if (!done && attempt === 0) log(col + r + " 写后校验未过，重写一次");
        }
        if (!done) { writeErr = col + r + " 写后校验失败（期望[" + val + "]）"; break; }
      }
      if (!writeErr) log("[写入] 行" + r + " E/F/G 完成");
    }
    if (writeErr) {
      db.prepare(`UPDATE complaints SET writeback_status='fail', writeback_msg=?, writeback_at=? WHERE sheet=? AND src_row BETWEEN ? AND ? AND order_no != '' AND query_status <> 'pending'`)
        .run("批量回填失败：" + writeErr + "（已写入部分保留）", nowStr(), batchSheet, top, bottom);
      log("批量回填中止：" + writeErr + "（已写入部分保留，请人工核查后重跑）");
    }

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
	    // 数值不齐不立即判失败：多行粘贴渲染可能滞后，先等 10s 复核（最多 3 轮），仍不齐才算失败
	    const checkSample = async (r) => {
	      const cTxt = await readRetry("C" + r);
	      const srcOrder = extractOrder(cTxt);
	      const w = web[r] || {};
	      if (srcOrder !== (w.order || "")) return "粘贴后订单对不上（第" + r + "行：源表=" + srcOrder + " 网页=" + (w.order || "") + "）";
	      const e = normCell(await readRetry("E" + r));
	      const f = normCell(await readRetry("F" + r));
	      const g = normCell(await readRetry("G" + r));
	      if (e !== normCell(w.period) || f !== normCell(w.phone) || g !== normCell(w.tutor))
	        return "粘贴后数值对不上（第" + r + "行：期次[" + e + "]vs[" + normCell(w.period) + "] 电话[" + f + "]vs[" + normCell(w.phone) + "] 助教[" + g + "]vs[" + normCell(w.tutor) + "]）";
	      return "";
	    };
	    // 复用外层 reason（292 行声明）：这里若再 let 会遮蔽，导致最终 __BATCH_JSON__ 永远 ok:true
	    ok = !writeErr;
	    reason = writeErr || "";
	    if (!writeErr) for (const r of samples) {
	      let msg = "";
	      for (let round = 0; round < 3; round++) {
	        try { msg = await checkSample(r); }
	        catch (e) { msg = "读取异常（第" + r + "行）: " + String(e.message || e).split("\n")[0]; }
	        if (!msg) break;
	        if (round < 2) { log("行" + r + " 校验未过（" + msg + "），等 10s 后复核第" + (round + 2) + "轮"); await page.waitForTimeout(10000); }
	      }
	      if (msg) { ok = false; reason = msg; break; }
	      log("[校验] 行" + r + " 通过");
	    }

	    if (ok) {
	      written = bottom - top + 1 - skipSet.size;
	      const now = nowStr();
	      db.prepare(`UPDATE complaints SET writeback_status='ok', writeback_msg='批量回填成功', writeback_at=? WHERE sheet=? AND src_row BETWEEN ? AND ? AND order_no != '' AND query_status <> 'pending'`)
	        .run(now, batchSheet, top, bottom);
	      // 未掉落/过滤：无需钉钉，直接标记已处理
	      db.prepare(`UPDATE complaints SET processed='是', processed_at=?, mismatch=0 WHERE sheet=? AND src_row BETWEEN ? AND ? AND query_status <> 'pending' AND (fill_period='系统未掉落' OR fill_tutor LIKE '%爱芯过滤%' OR fill_tutor LIKE '%正价课拦截%') AND order_no != ''`)
	        .run(now, batchSheet, top, bottom);
	      // 其他记录：回写完成后，若钉钉也已发送则标记已处理
	      db.prepare(`UPDATE complaints SET processed='是', processed_at=? WHERE sheet=? AND src_row BETWEEN ? AND ? AND writeback_status='ok' AND ding_status='ok' AND order_no != ''
	        AND fill_period<>'系统未掉落' AND fill_tutor NOT LIKE '%爱芯过滤%' AND fill_tutor NOT LIKE '%正价课拦截%'`)
	        .run(now, batchSheet, top, bottom);
	      log("批量回填成功：记录 " + N + " 条，顶/中/底校验通过");
	    } else if (!writeErr) {
	      // 回滚：先把焦点放回网格（校验读取后焦点可能留在名称框，Ctrl+Z 会落空），再撤销粘贴
	      await gotoCellAndFocus(page, "E" + top).catch(() => {});
	      await page.keyboard.press("Control+z");
	      await page.waitForTimeout(3000);
	      try {
	        const e = normCell(await readCell(page, "E" + top));
	        const wantE = normCell((web[top] || {}).period || "");
	        rolledBack = e !== wantE;
	      } catch (e3) { rolledBack = false; }
	      db.prepare(`UPDATE complaints SET writeback_status='fail', writeback_msg=?, writeback_at=? WHERE sheet=? AND src_row BETWEEN ? AND ? AND order_no != '' AND query_status <> 'pending'`)
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
	  console.log("__BATCH_JSON__" + JSON.stringify({ ok: !reason, phase:"exec", sheet:batchSheet, top, bottom, written, skipped: skipSet.size, rolledBack, reason }));
}

if (BATCH) {
  try {
    if (BATCH_PHASE === "check") await batchCheck();
    else if (BATCH_PHASE === "exec") await batchExec();
    else { log("--batch 需 --phase check|exec"); db.close(); process.exit(1); }
  } catch (e) {
    // 启动失败/浏览器异常等不能静默退出——必须回传 __BATCH_JSON__，前端才能显示真实原因
    const phaseName = BATCH_PHASE === "check" ? "检查" : "执行";
    console.log("__BATCH_JSON__" + JSON.stringify({ ok: false, phase: BATCH_PHASE, sheet: batchSheet, reason: "批量" + phaseName + "异常: " + String(e.message || e).split("\n")[0] }));
    try { db.close(); } catch {}
    process.exit(1);
  }
  process.exit(0);
}

// ---------- 目标 ----------
let targets;
if (IDS.length) {
  const ph = IDS.map(() => "?").join(",");
  targets = db.prepare(`SELECT * FROM complaints WHERE id IN (${ph})`).all(...IDS);
} else if (FEEDBACK_MODE) {
  targets = db.prepare("SELECT * FROM complaints WHERE feedback_text IS NOT NULL AND feedback_text != ''").all();
} else {
  // 未定案的查询单（pending/query_fail/nf_wait 复核中）绝不回写源表：
  // nf_wait 可能残留上一轮 not_found 的 fill_period="系统未掉落"，复核后若查到了源表就被写错。
  targets = db.prepare("SELECT * FROM complaints WHERE processed='是' AND (query_status IS NULL OR query_status NOT IN ('pending','query_fail','nf_wait'))").all();
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
  await assertDocWritable(page);

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
          // 单行回填：行号+订单号已由 findRow 校验 → E/F/G 逐格写入并校验（剪贴板粘贴在腾讯文档上不可靠）
          const v = (s) => String(s == null ? "" : s).replace(/[\r\n]+/g, " ");
          const vals = [["E", v(t.fill_period || t.src_period)], ["F", v(t.fill_phone || t.src_phone)], ["G", v(t.fill_tutor || t.src_tutor)]];
          for (const [col, val] of vals) {
            await writeCell(page, col + found.row, val);
            if (!await verifyCell(page, col + found.row, val)) throw new Error("写后校验失败 " + col + found.row);
          }
          written.push("E/F/G");
          log(`[${t.id}] ${sheet}行${found.row} E/F/G 已逐格写入并校验`);
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



