# -*- coding: utf-8 -*-
"""批量导入渠道库：读取订单表（订单编号+渠道+商品名称+商品ID），
提取 商品名称+商品ID+渠道 的唯一组合，按商品ID覆盖写入 channel_lib
（文件里出现的商品ID，旧记录整条换掉；没出现的商品保持不动）。"""
import sys, os, sqlite3, json, time
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

    # 覆盖语义：文件里出现的商品ID，旧记录全部换掉；文件里没有的商品保持不动
    pid_list = list(dict.fromkeys(pid for (pid, _ch) in order))

    # 删之前留一份快照，覆盖错了还能查回来
    backup = []
    for pid in pid_list:
        for row in cur.execute("SELECT id, prod_name, prod_id, channel FROM channel_lib WHERE prod_id=?", (pid,)):
            backup.append({"id": row[0], "prod_name": row[1], "prod_id": row[2], "channel": row[3]})

    replaced = 0
    bak_path = ""
    for pid in pid_list:
        cur.execute("DELETE FROM channel_lib WHERE prod_id=?", (pid,))
        replaced += cur.rowcount
    if backup:
        ts = time.strftime("%Y%m%d_%H%M%S")
        bak_path = os.path.join(os.path.dirname(db_path), f"channel_lib_backup_{ts}.json")
        with open(bak_path, "w", encoding="utf-8") as f:
            json.dump(backup, f, ensure_ascii=False, indent=1)

    inserted = 0
    for (pid, ch) in order:
        cur.execute("INSERT INTO channel_lib (prod_name, prod_id, channel) VALUES (?,?,?)", (seen[(pid, ch)], pid, ch))
        inserted += 1
    conn.commit()

    # 文件里没出现的商品ID：原样保留
    untouched = cur.execute("SELECT COUNT(*) FROM channel_lib").fetchone()[0] - inserted
    conn.close()

    print(json.dumps({
        "ok": True,
        "total": total,
        "unique": len(order),
        "inserted": inserted,
        "replaced": replaced,
        "untouched": untouched,
        "backup": bak_path if backup else ""
    }, ensure_ascii=False))

if __name__ == "__main__":
    main()
