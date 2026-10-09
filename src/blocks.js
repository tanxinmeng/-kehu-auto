// 4 行块解析器：把腾讯文档"复制法"得到的 TSV 文本解析为结构化记录
// 背景：新记录在源表为一行（C 列含多行文本），复制后变成 4 行一块：
//   行1: A=反馈时间, B=客服编号, C=订单号
//   行2: C=下单时间
//   行3: C=课程
//   行4: C=用户问题, D=问题归类, E=期次, F=手机号, G=顾问, ...（复制会省略"是否反馈顾问"列）
// 注意：
//   - 块可能被空行/额外续行打断，结束行也可能被拆行，采用"遇到下一个块起始才结束当前块"
//   - 少于 3 列的行是 C 列续行（如 "8.1"、"7.18"），不是新行
//   - "日期残留行"（A 列有日期、B/C 都空，如 "8.06\t\t"）是客服预填的日期，不产生记录、不并入客户信息，
//     但占源表真实行号（offset）
//   - 每个块带 offset：该块在源表中的累计行号（含空行/残留行占位），用于锚点校准精确行号

// 全角转半角 + 统一日期分隔符
export function normDate(d) {
  let s = String(d == null ? "" : d).trim();
  s = s.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  s = s.replace(/[，．、]/g, ".");
  // 去前导零：8.06 -> 8.6，10.11 不变
  s = s.replace(/^(\d+)\.(\d+)$/, (m, a, b) => Number(a) + "." + Number(b));
  return s;
}
const dateRe = /^\d{1,2}\.\d{1,2}$/;

export function isTabOnlyLine(line) {
  return String(line).split("\t").every((x) => (x || "").trim() === "");
}

// 判断一行是否为"日期残留行"：A 列是日期，C 列无订单号（只看 A→C，D/E/F 可能有预填值不应干扰判定）
export function isResidueRow(parts) {
  if (parts.length < 3) return false;
  if (!dateRe.test(normDate(parts[0]))) return false;
  // B 列为空且 C 列无 10 位以上订单号 → 残留行
  const B = (parts[1] || "").trim();
  const C = (parts[2] || "").trim();
  if (B === "" && !/\d{14,}/.test(C)) return true;
  return false;
}

// 判断一行是否为"块起始"（新记录的第一行）
// rawLen = 原始行（未 shift 前导空列）的列数。块起始行原始必含 A/B/C 三列（即使为空也有 \t 分隔）；
// C 单元格首行若是空行，订单号会被挤到下一行单独成列（rawLen=1），那不是新块起始。
export function isBlockStart(parts, rawLen = parts.length) {
  // parts 已 shift 掉前导空列。块起始行（原始 [A反馈时间, B客服, C订单号]）在 shift 后可能为
  // [A,B,C] / [B,C](A空) / [C](A,B空)，订单号始终在末列。续行（下单时间/课程）仅 1 列无订单号；
  // 结束行末列是顾问/复核（文本）无订单号。
  const last = (parts[parts.length - 1] || "").trim();
  // 订单号 19 位、手机号 11 位 → 14 位阈值区分，避免把结束行 F 列手机号（C 空时被 shift 到末列）误判为块起始
  if (rawLen >= 3 && /\d{14,}/.test(last)) return true;

  // 兜底：C 列无订单号但 A 列是日期、B 列有客服（缺订单号的信息不全行，仍需占位入库避免串行）
  if (parts.length >= 3) {
    const A = (parts[0] || "").trim();
    const B = (parts[1] || "").trim();
    if (dateRe.test(normDate(A)) && B !== "") return true;
  }
  return false;
}

// 从 C 列首行提取订单号（去掉 +、视频号 等后缀）
export function extractOrder(c) {
  const m = String(c || "").match(/\d{14,}/);
  return m ? m[0] : "";
}

// 块起始行原始为 [A反馈时间, B客服编号, C订单号]，shift 掉前导空列后可能为
// [A,B,C] / [B,C](A空) / [C](A,B空)。按"末列=C"还原三列，避免 A/B 为空时字段错位。
function abcFromParts(parts) {
  const n = parts.length;
  const C = (parts[n - 1] || "").trim();
  const B = n >= 2 ? (parts[n - 2] || "").trim() : "";
  const A = n >= 3 ? (parts[n - 3] || "").trim() : "";
  return { A, B, C };
}

// 扁平单行块：源表 C 列内容是空格分隔的单行（非 Alt+Enter 换行）时，整行复制成一行
// [A=日期, B?, C=订单+内容(空格分隔), D归类, ...]，订单号在中间列而非末列，isBlockStart 判不出来。
// 只认"订单号不在末列"的行，避免把正常块起始 [A,B,C=订单号] 误判成扁平块。
function flattenFromParts(parts) {
  if (parts.length < 3) return null;
  if (!dateRe.test(normDate(parts[0]))) return null;
  const orderIdx = parts.findIndex((p, idx) => idx >= 1 && /\d{14,}/.test((p || "").trim()));
  if (orderIdx < 1 || orderIdx >= parts.length - 1) return null;
  return {
    A: normDate(parts[0]),
    B: (parts[1] || "").trim(),
    C: (parts[orderIdx] || "").trim(),
    // 与正常块结束行对齐：slice 后 [C, D, E, F, ...]，extractFields 按 ep[1]=D 起映射
    endParts: parts.slice(orderIdx),
  };
}

// 统一块构造：正常块（订单号在末列）走 abcFromParts；扁平单行块 endParts 直接就绪
function beginRecord(parts, row) {
  const fl = flattenFromParts(parts);
  if (fl) {
    return {
      offset: row,
      feedback_date: fl.A,
      cust_no: fl.B,
      order_no: extractOrder(fl.C),
      startC: fl.C,
      contC: [],
      endParts: fl.endParts,
      flattened: true,
    };
  }
  const abc = abcFromParts(parts);
  return {
    offset: row,
    feedback_date: normDate(abc.A),
    cust_no: abc.B,
    order_no: extractOrder(abc.C),
    startC: abc.C,
    contC: [],
    endParts: null,
  };
}

// 块起始判定（含扁平单行块）
function isBlockStartAny(parts, rawLen = parts.length) {
  return isBlockStart(parts, rawLen) || flattenFromParts(parts) !== null;
}

// 解析整份复制文本 → 记录数组（按源表从上到下顺序，每块含 offset 行号）
export function parseCopy(text) {
  const lines = String(text || "").split(/\r?\n/);
  const records = [];
  // 跳过标题行和表头行（含"反馈时间"的行）
  // 注意：只在前 5 行找表头——"起始行向下复制"的内容没有表头，找不到就从头开始解析
  let i = 0;
  let headerIdx = -1;
  for (let k = 0; k < lines.length && k < 5; k++) {
    if (lines[k].includes("反馈时间")) { headerIdx = k; break; }
  }
  if (headerIdx >= 0) i = headerIdx + 1;
  let row = 2; // 标题行=1、表头行=2 已跳过
  let cur = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    const parts = line.split("\t");
    const rawLen = parts.length;
    // 兼容两种复制格式：腾讯文档可能保留或裁剪前导空列（A/B），统一去掉前导空字段再判断
    while (parts.length > 1 && (parts[0] || "").trim() === "") parts.shift();
    if (isTabOnlyLine(line)) { row++; continue; }       // 空行：占源表一行，不产生记录
    if (isResidueRow(parts)) { row++; continue; }        // 日期残留行：占一行，不产生记录、不入客户信息
    if (isBlockStartAny(parts, rawLen)) {
      if (cur) records.push(cur);
      cur = beginRecord(parts, row);
      row++;
      if (cur.endParts) continue;   // 扁平单行块：整行即完整记录，无续行
      // 消费续行/结束行/碎片（不占行号），直到下一个块起始
      i++;
      while (i < lines.length) {
        const rawParts = lines[i].split("\t");
        const rawLen2 = rawParts.length;
        const p2 = rawParts.slice();
        while (p2.length > 1 && (p2[0] || "").trim() === "") p2.shift();
        if (isTabOnlyLine(lines[i])) { i++; continue; }          // 块内空行：不结束块，继续
        if (isResidueRow(p2)) { i++; continue; }                 // 块内日期残留：忽略，继续
        if (isBlockStartAny(p2, rawLen2)) { i--; break; }        // 下一个块起始（含扁平单行块）
        cur.contC.push((rawParts[0] || "").trim());
        // ?????? C(??)+D(??) ???????/???/??????????????
        // 结束行识别：C 列有内容且该行至少 2 列。不再要求第 2 列（问题归类 D）非空——
        // D 可能为空但期次/手机号/顾问已有值；C 列续行（下单时间/课程）都只有 1 列，
        // 日期续行由 dateRe 排除，避免把"下单时间"误当结束行
        if (!cur.endParts && p2.length >= 2 && !dateRe.test(normDate(p2[0] || ""))) {
          cur.endParts = rawParts;                               // 存原始列，D/E 位置不因 C 空而错位
        }
        i++;
      }
    } else if (cur) {
      // 兜底：不属于上述任何类的行，忽略（不占行号，避免错位）
    }
  }
  if (cur) records.push(cur);
  return records;
}

// 从一条记录提取各字段（含结束行列映射：复制会省略"是否反馈顾问"列）
// AI 表：H=顾问反馈结果, I=是否反馈顾问, J=复核用户需求
// 高 表：H=是否反馈顾问, I=顾问反馈结果, J=复核用户需求
// 复制结果：parts = [C, D, E, F, G, 顾问反馈结果, 复核用户需求, ...]
// ???????? ? ???????/?????????????"???"???
// 解析整份复制文本 → 全部行（含空白/日期残留占位），供同步时把"占位行"也入库
export function parseCopyWithBlanks(text) {
  const lines = String(text || "").split(/\r?\n/);
  const rows = [];
  let i = 0;
  let headerIdx = -1;
  for (let k = 0; k < lines.length && k < 5; k++) {
    if (lines[k].includes("反馈时间")) { headerIdx = k; break; }
  }
  if (headerIdx >= 0) i = headerIdx + 1;
  let row = 2; // 标题行=1、表头行=2 已跳过（偏移相对，同步时按锚点折算真实行号）
  let cur = null;
  let pushed = true;   // 当前记录块是否已推入 rows（保证空白行排在所属记录之后）
  for (; i < lines.length; i++) {
    const line = lines[i];
    const parts = line.split("\t");
    const rawLen = parts.length;
    // 兼容两种复制格式：去掉前导空列（A/B）再判断
    while (parts.length > 1 && (parts[0] || "").trim() === "") parts.shift();
    if (isTabOnlyLine(line)) { rows.push({ kind: "blank", offset: row }); row++; continue; }
    if (isResidueRow(parts)) { rows.push({ kind: "residue", offset: row, feedback_date: normDate(parts[0]) }); row++; continue; }
    if (isBlockStartAny(parts, rawLen)) {
      if (cur && !pushed) rows.push({ kind: "record", rec: cur });
      cur = beginRecord(parts, row);
      pushed = false;
      row++;
      if (cur.endParts) {                                        // 扁平单行块：整行即完整记录
        rows.push({ kind: "record", rec: cur });
        pushed = true;
        continue;
      }
      i++;
      while (i < lines.length) {
        const rawParts = lines[i].split("\t");
        const rawLen2 = rawParts.length;
        const p2 = rawParts.slice();
        while (p2.length > 1 && (p2[0] || "").trim() === "") p2.shift();
        // 结束行(endParts)之后：空行/日期残留 = 源表单独占一行的空白/残留行（不再吞掉，避免串行）
        if (isTabOnlyLine(lines[i])) {
          if (cur.endParts) {
            if (!pushed) { rows.push({ kind: "record", rec: cur }); pushed = true; }
            rows.push({ kind: "blank", offset: row }); row++; i++; continue;
          }
          i++; continue;   // 结束行之前 → C 单元格内空行，属本记录
        }
        if (isResidueRow(p2)) {
          if (cur.endParts) {
            if (!pushed) { rows.push({ kind: "record", rec: cur }); pushed = true; }
            rows.push({ kind: "residue", offset: row, feedback_date: normDate(p2[0]) }); row++; i++; continue;
          }
          i++; continue;
        }
        if (isBlockStartAny(p2, rawLen2)) { i--; break; }        // 下一个块起始（含扁平单行块）
        cur.contC.push((rawParts[0] || "").trim());
        // 结束行识别：同 parseCopy（≥2 列且首列非日期；不要求问题归类 D 非空）
        if (!cur.endParts && p2.length >= 2 && !dateRe.test(normDate(p2[0] || ""))) {
          cur.endParts = rawParts;                               // 存原始列，D/E 位置不因 C 空而错位
          rows.push({ kind: "record", rec: cur });
          pushed = true;
        }
        i++;
      }
    } else if (cur) {
      // 兜底：不属于上述任何类的行，忽略（不占行号，避免错位）
    }
  }
  if (cur && !pushed) rows.push({ kind: "record", rec: cur });
  return rows;
}

export function extractFields(rec, sheet) {
  const ep = rec.endParts || [];
  const cText = [rec.startC, ...rec.contC].join("\n");
  return {
    offset: rec.offset,
    feedback_date: rec.feedback_date,
    cust_no: rec.cust_no,
    order_no: rec.order_no || extractOrder(cText),
    customer_info: cText,
    category: (ep[1] || "").trim(),          // D
    src_period: (ep[2] || "").trim(),        // E
    src_phone: (ep[3] || "").trim(),         // F
    src_tutor: (ep[4] || "").trim(),         // G
    src_feedback: (ep[5] || "").trim(),      // 顾问反馈结果（AI-H / 高-I）
    review: (ep[6] || "").trim(),            // J 复核用户需求
    sheet,
  };
}

// 按日期过滤（归一化比较，如 "8.6"、"8.06"、"8.06 " 都等于 8.6）
export function dateEquals(d, target) {
  return normDate(d) === normDate(target);
}
