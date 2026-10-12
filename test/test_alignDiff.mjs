// alignDiff 单元测试：node test_alignDiff.mjs
import { alignDiff } from "../src/blocks.js";

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log("PASS", name); }
  else { fail++; console.log("FAIL", name, "\n  got: ", g, "\n  want:", w); }
}

const TOP = 100, BOTTOM = 110;

// 场景1：完全一致 → clean
{
  const dbMap = { 100: "A", 103: "B", 106: "C" };
  const srcMap = { ...dbMap };
  eq("clean 一致", alignDiff(dbMap, srcMap, TOP, BOTTOM, 110), { type: "clean" });
}

// 场景2：中部插入 1 行订单（B、C 在源表各下移 1 行）→ shift k=+1
{
  const dbMap = { 100: "A", 103: "B", 106: "C" };
  const srcMap = { 100: "A", 103: "D", 104: "B", 107: "C" };
  eq("中部插行", alignDiff(dbMap, srcMap, TOP, BOTTOM, 110),
    { type: "shift", B: 103, k: 1, orphans: [] });
}

// 场景3：删除 1 行（库在 106 的 C 被删）→ shift k=-1, orphans=[106]
{
  const dbMap = { 100: "A", 103: "B", 106: "C" };
  const srcMap = { 100: "A", 103: "B" };
  eq("删行+孤儿", alignDiff(dbMap, srcMap, TOP, BOTTOM, 108),
    { type: "shift", B: 106, k: -1, orphans: [106] });
}

// 场景4：插入的是空白行（订单序列不变、行号整体下移）→ shift k=+2（krow 路径）
{
  const dbMap = { 100: "A", 103: "B", 106: "C" };
  const srcMap = { 102: "A", 105: "B", 108: "C" };
  eq("空白行插入行号平移", alignDiff(dbMap, srcMap, TOP, BOTTOM, 110),
    { type: "shift", B: 100, k: 2, orphans: [] });
}

// 场景5：订单号被改动（同数量、同位置）→ rows
{
  const dbMap = { 100: "A", 103: "B", 106: "C" };
  const srcMap = { 100: "A", 103: "X", 106: "C" };
  eq("订单改动", alignDiff(dbMap, srcMap, TOP, BOTTOM, 110),
    { type: "rows", changes: [{ row: 103, dbOrder: "B", srcOrder: "X" }] });
}

// 场景6：尾部追加（库内没有的新订单在 bottom 之后）→ rows（不是 shift）
{
  const dbMap = { 100: "A", 103: "B" };
  const srcMap = { 100: "A", 103: "B", 108: "NEW" };
  eq("尾部追加", alignDiff(dbMap, srcMap, TOP, BOTTOM, 110),
    { type: "rows", changes: [{ row: 108, dbOrder: "", srcOrder: "NEW" }] });
}

// 场景7：多行插入的 shift 验证（k=2，后续订单整体下移 2）
{
  const dbMap = { 100: "A", 103: "B", 106: "C" };
  const srcMap = { 100: "P", 101: "Q", 102: "A", 105: "B", 108: "C" };
  eq("多行插入 k=2", alignDiff(dbMap, srcMap, TOP, BOTTOM, 120),
    { type: "shift", B: 100, k: 2, orphans: [] });
}

// 场景8：插行但尾部对齐不上（证据不足）→ 退化为 rows
{
  const dbMap = { 100: "A", 103: "B", 106: "C" };
  const srcMap = { 100: "D", 103: "A", 106: "B" };   // 插了 D 但 C 消失了
  const r = alignDiff(dbMap, srcMap, TOP, BOTTOM, 110);
  eq("伪插行退化rows", r.type, "rows");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
