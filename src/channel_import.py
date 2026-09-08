# -*- coding: utf-8 -*-
"""批量导入渠道库：读取订单表（订单编号+渠道+商品名称+商品ID），
提取 商品名称+商品ID+渠道 的唯一组合，去重后写入 channel_lib。"""
import sys, os, sqlite3, json
import pandas as pd

def to_str(x):
    if pd.isna(x):
        return ''
    if isinstance(x, float):
        return str(int(x))
    return str(x).strip()

def main():
    file_path = sys.argv[1]
    db_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "kehu.db")

    df = pd.read_excel(file_path)

    name_col = id_col = ch_col = None
    for c in df.columns:
        cs = str(c).strip()
        if cs == '商品名称' and name_col is None:
            name_col = c
        elif cs == '商品ID' and id_col is None:
            id_col = c
        elif cs == '渠道' and ch_col is None:
            ch_col = c

    if name_col is None or id_col is None or ch_col is None:
        fn = [str(c) for c in df.columns]
        print(json.dumps({"ok": False, "error": f"找不到 商品名称/商品ID/渠道 列（模板：订单编号+渠道+商品名称+商品ID）。列名: {fn}"}, ensure_ascii=False))
        return

    # 提取唯一 (prod_id, channel) -> prod_name，保持出现顺序
    seen = {}
    order = []
    total = 0
    for _, row in df.iterrows():
        pid = to_str(row[id_col])
        name = to_str(row[name_col])
        ch = to_str(row[ch_col])
        if not pid or not ch:
            continue
        total += 1
        key = (pid, ch)
        if key not in seen:
            seen[key] = name
            order.append(key)

    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    inserted = 0
    skipped = 0
    for (pid, ch) in order:
        name = seen[(pid, ch)]
        exists = cur.execute("SELECT id FROM channel_lib WHERE prod_id=? AND channel=?", (pid, ch)).fetchone()
        if exists:
            skipped += 1
            continue
        cur.execute("INSERT INTO channel_lib (prod_name, prod_id, channel) VALUES (?,?,?)", (name, pid, ch))
        inserted += 1
    conn.commit()
    conn.close()

    print(json.dumps({
        "ok": True,
        "total": total,
        "unique": len(order),
        "inserted": inserted,
        "skipped": skipped
    }, ensure_ascii=False))

if __name__ == "__main__":
    main()
