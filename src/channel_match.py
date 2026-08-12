"""Match channels from channel_lib against input Excel file. Output JSON summary."""
import sys, os, sqlite3, json
import pandas as pd
from openpyxl.utils import get_column_letter

def main():
    file_path = sys.argv[1]
    db_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "kehu.db")

    # Load channel library
    conn = sqlite3.connect(db_path)
    lib = pd.read_sql("SELECT prod_name, prod_id, channel FROM channel_lib", conn)
    conn.close()

    # Build lookup: prod_id -> channel, prod_name -> channel (first match wins)
    id_map = {}
    name_map = {}
    for _, row in lib.iterrows():
        pid = str(row['prod_id']).strip()
        pname = str(row['prod_name']).strip()
        ch = row['channel']
        if pid and pid not in id_map:
            id_map[pid] = ch
        if pname and pname not in name_map:
            name_map[pname] = ch

    # Read input
    df = pd.read_excel(file_path)
    # Find 商品名称 and 商品ID columns
    name_col = None
    id_col = None
    for c in df.columns:
        cs = str(c).strip()
        if '商品名称' in cs and name_col is None:
            name_col = c
        if '商品ID' in cs and id_col is None:
            id_col = c

    if name_col is None or id_col is None:
        fn = [str(c) for c in df.columns]
        print(json.dumps({"ok": False, "error": f"找不到商品名称/商品ID列。列名: {fn}"}, ensure_ascii=False))
        return

    # Convert ID column to string to preserve full precision (19-digit IDs)
    def to_str(x):
        if pd.isna(x):
            return ''
        if isinstance(x, float):
            return str(int(x))
        return str(x)
    df[id_col] = df[id_col].apply(to_str)

    # Match
    matched = 0
    channels = []
    for _, row in df.iterrows():
        pid = str(row[id_col]).strip() if pd.notna(row[id_col]) else ""
        pname = str(row[name_col]).strip() if pd.notna(row[name_col]) else ""
        ch = ""
        if pid and pid in id_map:
            ch = id_map[pid]
        elif pname and pname in name_map:
            ch = name_map[pname]
        channels.append(ch)
        if ch:
            matched += 1

    # Add channel column after 商品ID
    id_idx = df.columns.get_loc(id_col)
    df.insert(id_idx + 1, "渠道", channels)

    # Save output with text format for ID column
    base, ext = os.path.splitext(file_path)
    out_path = base + "_渠道" + ext
    with pd.ExcelWriter(out_path, engine='openpyxl') as writer:
        df.to_excel(writer, index=False)
        ws = writer.sheets['Sheet1']
        id_letter = get_column_letter(id_idx + 1)
        for r in range(2, ws.max_row + 1):
            ws[f'{id_letter}{r}'].number_format = '@'

    print(json.dumps({
        "ok": True,
        "total": len(df),
        "matched": matched,
        "unmatched": len(df) - matched,
        "output": out_path
    }, ensure_ascii=False))

if __name__ == "__main__":
    main()
