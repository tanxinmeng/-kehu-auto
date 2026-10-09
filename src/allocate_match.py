# -*- coding: utf-8 -*-
"""已分配订单匹配：哆啦导出表（已加渠道） × 已分配底表 → 加「是否分配」列。

复刻手工 VLOOKUP 语义，与 refund/preprocess.py 完全兼容：
  - 订单在外部订单编号匹配到 → 是否分配 = 该单的服务期（如 20260918）
  - 匹配不到 → 是否分配 = "#N/A"（preprocess 判为未分配）

已分配底表格式：「自营-店铺底表」，关键列 外部订单编号 + 服务期。
支持传多份（最近一期持续更新 + 上一期留存），订单号集合自动合并。

用法：
  python allocate_match.py --table <哆啦表.xlsx> \
      --allocated <已分配表1.xlsx> [--allocated <已分配表2.xlsx>] --out <输出.xlsx>

输出：成品表 + stdout 最后一行 JSON{ok,total,matched,unmatched,files,periods,output}
"""
import sys, os, json, argparse
import pandas as pd
from openpyxl.utils import get_column_letter


def to_str(x):
    """单元格 → 干净文本：float 去尾 .0（防科学计数/精度丢失），空 → ''。"""
    if x is None:
        return ""
    try:
        if pd.isna(x):
            return ""
    except (TypeError, ValueError):
        pass
    if isinstance(x, float) and x.is_integer():
        return str(int(x))
    return str(x).strip()


def find_col(cols, keywords):
    for c in cols:
        cs = str(c).strip()
        for k in keywords:
            if k in cs:
                return c
    return None


def load_allocated(path):
    """读一份已分配底表 → (订单号→服务期 dict, 服务期行数分布)"""
    df = pd.read_excel(path)
    order_col = find_col(df.columns, ["外部订单编号", "订单编号", "订单号", "订单ID"])
    period_col = find_col(df.columns, ["服务期", "期次"])
    if order_col is None:
        raise ValueError(f"{os.path.basename(path)} 找不到订单列（外部订单编号），实际列: {[str(c) for c in df.columns]}")
    orders = {}
    periods = {}
    for _, row in df.iterrows():
        oid = to_str(row[order_col])
        if not oid:
            continue
        pv = to_str(row[period_col]) if period_col is not None else ""
        if pv:
            periods[pv] = periods.get(pv, 0) + 1
        if oid not in orders:   # 先到先得：订单号唯一，跨文件重复时保留第一份
            orders[oid] = pv
    return orders, periods


def main():
    ap = argparse.ArgumentParser(description="已分配订单匹配（写是否分配列）")
    ap.add_argument("--table", required=True, help="哆啦导出表（已加渠道列）")
    ap.add_argument("--allocated", action="append", required=True, help="已分配底表，可重复传多份")
    ap.add_argument("--out", default=None, help="输出路径（默认 <表名>_分配.xlsx）")
    args = ap.parse_args()

    try:
        table_path = args.table
        if not os.path.exists(table_path):
            print(json.dumps({"ok": False, "error": f"哆啦表不存在: {table_path}"}, ensure_ascii=False))
            return
        alloc_files = [p for p in args.allocated if os.path.exists(p)]
        if not alloc_files:
            missing = [p for p in args.allocated if not os.path.exists(p)]
            print(json.dumps({"ok": False, "error": f"已分配底表不存在: {missing}"}, ensure_ascii=False))
            return

        df = pd.read_excel(table_path)
        order_col = find_col(df.columns, ["订单编号", "订单号", "订单ID"])
        if order_col is None:
            print(json.dumps({"ok": False, "error": f"哆啦表找不到订单编号列，实际列: {[str(c) for c in df.columns]}"}, ensure_ascii=False))
            return
        df[order_col] = df[order_col].apply(to_str)
        # pandas 读 Excel 会把数字文本列推断成 int64（19 位商品ID 精度丢失+科学计数）——
        # 所有 int64 列统一转回文本，输出时设 @ 格式，和订单编号一致
        int_cols = [c for c in df.columns if str(df[c].dtype) == "int64"]
        for c in int_cols:
            df[c] = df[c].apply(to_str)

        # 合并所有已分配文件的订单号 → 服务期
        alloc_map = {}
        files_info = []
        for p in alloc_files:
            try:
                orders, periods = load_allocated(p)
            except Exception as e:
                print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
                return
            alloc_map.update(orders)
            files_info.append({
                "name": os.path.basename(p),
                "rows": sum(periods.values()) or len(orders),
                "periods": periods,
            })

        # 写「是否分配」列：匹配到 = 服务期；没匹配到 = #N/A
        vals = []
        matched = 0
        for oid in df[order_col]:
            pv = alloc_map.get(oid, "")
            if pv:
                vals.append(pv)
                matched += 1
            else:
                vals.append("#N/A")
        alloc_col_name = "是否分配"
        if alloc_col_name in df.columns:
            df[alloc_col_name] = vals
        else:
            pos = df.columns.get_loc(order_col) + 1
            df.insert(pos, alloc_col_name, vals)

        out_path = args.out or str(os.path.splitext(table_path)[0] + "_分配.xlsx")
        with pd.ExcelWriter(out_path, engine="openpyxl") as writer:
            df.to_excel(writer, index=False)
            ws = writer.sheets["Sheet1"]
            text_cols = {df.columns.get_loc(order_col) + 1}
            text_cols.update(df.columns.get_loc(c) + 1 for c in int_cols)
            for col_idx in text_cols:
                letter = get_column_letter(col_idx)
                for r in range(2, ws.max_row + 1):
                    ws[f"{letter}{r}"].number_format = "@"

        print(json.dumps({
            "ok": True,
            "total": len(df),
            "matched": matched,
            "unmatched": len(df) - matched,
            "files": files_info,
            "periods": sorted({p for f in files_info for p in f["periods"]}),
            "output": out_path,
        }, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
