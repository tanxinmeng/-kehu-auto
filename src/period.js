// 期次计算工具：每周三 24:00 更新到下一期，每期顺延 +7 天
// 期次标签如 "0807"（0807期 覆盖 7/29→8/5，标签=期内代表日 8/7）
// 规则与锚点见 config.json 的 periodRule
export function parseDate(s) {
  const m = String(s || "").trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3]);
}
// 期次标签 → 日期（支持 4 位 "0807" 或跨年 8 位 "20260807"）
export function periodToDate(label) {
  let s = String(label || "").trim();
  let y, mm, dd;
  if (/^\d{8}$/.test(s)) { y = +s.slice(0, 4); mm = +s.slice(4, 6); dd = +s.slice(6, 8); }
  else if (/^\d{4}$/.test(s)) { y = new Date().getFullYear(); mm = +s.slice(0, 2); dd = +s.slice(2, 4); }
  else return null;
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return new Date(y, mm - 1, dd);
}
export function fmtMMDD(d) {
  return String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
}
// 当前期标签：按锚点推算。anchorLabel 期 覆盖 anchorStart 起的 7 天；
// 可用 currentOverride 直接指定当前期（优先）。
export function currentPeriodLabel(now, rule) {
  if (!rule) return "";
  const ov = rule.currentOverride;
  if (ov && String(ov).trim()) return String(ov).trim();
  const anchorDate = parseDate(rule.anchorStart);
  const anchorLabelDate = periodToDate(rule.anchorLabel);
  if (!anchorDate || !anchorLabelDate) return "";
  const days = Math.floor((now.getTime() - anchorDate.getTime()) / 86400000);
  const periodsAhead = Math.floor(days / 7);
  return fmtMMDD(new Date(anchorLabelDate.getTime() + periodsAhead * 7 * 86400000));
}
// 订单期次比当前期旧几期（>0 表示更旧；null 表示无法比较）
export function periodsBeforeCurrent(orderLabel, currentLabel) {
  const od = periodToDate(orderLabel), cd = periodToDate(currentLabel);
  if (!od || !cd) return null;
  return Math.round((cd.getTime() - od.getTime()) / (7 * 86400000));
}
