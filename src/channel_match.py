"""Match channels from channel_lib against input Excel file. Output JSON summary.
同名多渠道时用金额消歧：优先 商品单价，其次 支付金额+平台补贴金额（与渠道名 -99/-49/-199 后缀比对）；
无法判定则留在未匹配列表（页面手动补齐）。规格=默认 的行不需要匹配，直接从成品表中删除。
商品单价填充（2026-10-21 改）：先按 支付金额+平台补贴金额 计算，算不出再用源表原始单价列；
仅认可档位（49/99/119/199/219）才回填且档位归一（119→99、219→199）；
仍算不出 → 同商品ID众数价兜底（单档直接借，多档须唯一最多，冲突/并列留空）；
源表没有单价列时在支付金额前新增一列。
"""
import sys, os, sqlite3, json, re
from collections import Counter, defaultdict
import pandas as pd
from openpyxl.utils import get_column_letter

# 与 web-chat/full_pool.py 的 VALID_UNIT_PRICES / _TIER_ALIAS / _NA_PLACEHOLDERS 保持一致
VALID_UNIT_PRICES = {49.0, 99.0, 119.0, 199.0, 219.0}
TIER_ALIAS = {119.0: 99.0, 219.0: 199.0}
MISSING_TOKENS = {"", "-", "无", "#N/A", "N/A", "NA", "#NA", "#VALUE!", "#REF!", "#NULL!", "NULL", "NONE"}

def price_missing(x):  # noqa: 保留供外部/后续校验使用；填充链路已统一走 to_num/normalize_tier
    if x is None or (isinstance(x, float) and pd.isna(x)):
        return True
    if isinstance(x, (int, float)) and float(x) == 0:
        return True   # 数值 0 同订单池按缺失处理（or "" 语义）
    return str(x).strip().upper() in MISSING_TOKENS

def to_num(x):
    """'71.40元' / 71.4 / '1,234.00元' -> float；解析失败返回 None"""
    if x is None or (isinstance(x, float) and pd.isna(x)):
        return None
    s = str(x).replace("元", "").replace(",", "").strip()
    try:
        return float(s)
    except ValueError:
        return None

def normalize_tier(total):
    """认可档位 → 归一文本（119→'99'、219→'199'），非认可档位返回 ''（与 full_pool._normalize_tier 同参）。"""
    normalized = TIER_ALIAS.get(total, total)
    if normalized not in VALID_UNIT_PRICES:
        return ""
    return str(int(normalized)) if normalized == int(normalized) else f"{normalized:g}"

def mode_price_map(pid_list, pay_list, sub_list, orig_price_list):
    """②空白价格兜底：同商品ID的价格众数（与 full_pool.export_price_mode_map 同参）。

    每行的「自身价」= 支付金额+平台补贴 归一档位，算不出再用源表原始单价列；
    票数按自身价统计（119/219 归一后计票）。
    单一档位直接借，多档位须唯一最多票数才借，档位冲突或并列最多留空。
    返回 {index: 归一档位文本}。
    """
    own = []
    for i in range(len(pid_list)):
        total = normalize_tier(round((to_num(pay_list[i]) or 0.0) + (to_num(sub_list[i]) or 0.0), 2))
        if not total:
            orig = to_num(orig_price_list[i]) if i < len(orig_price_list) else None
            total = normalize_tier(orig) if orig is not None else ""
        own.append(total)
    prices_by_product = defaultdict(Counter)
    for i, pid in enumerate(pid_list):
        if pid and own[i]:
            prices_by_product[pid][float(own[i])] += 1
    out = {}
    for i, pid in enumerate(pid_list):
        if own[i]:
            out[i] = own[i]
            continue
        counts = prices_by_product.get(pid)
        mode = None
        if counts:
            if len(counts) == 1:
                mode = next(iter(counts))
            else:
                best = max(counts.values())
                top = [q for q, n in counts.items() if n == best]
                if len(top) == 1:
                    mode = top[0]
        out[i] = normalize_tier(mode) if mode is not None else ""
    return out

def price_of(channel):
    """'初中数学-99' -> 99.0；'高中内容直播' -> None"""
    m = re.search(r"-(\d+(?:\.\d+)?)$", str(channel).strip())
    return float(m.group(1)) if m else None

def main():
    file_path = sys.argv[1]
    db_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "kehu.db")

    # Load channel library
    conn = sqlite3.connect(db_path)
    lib = pd.read_sql("SELECT prod_name, prod_id, channel FROM channel_lib", conn)
    conn.close()

    # Lookup: prod_id / prod_name -> [channel, ...]（同名/同ID 多渠道保留全部，匹配时用金额消歧）
    id_map = {}
    name_map = {}
    for _, row in lib.iterrows():
        pid = str(row['prod_id']).strip()
        pname = str(row['prod_name']).strip()
        ch = row['channel']
        if pid and pid not in id_map:
            id_map[pid] = []
        if pid and ch not in id_map[pid]:
            id_map[pid].append(ch)
        if pname and pname not in name_map:
            name_map[pname] = []
        if pname and ch not in name_map[pname]:
            name_map[pname].append(ch)

    # Read input
    df = pd.read_excel(file_path)
    # Find 订单编号 / 商品名称 / 商品ID / 规格 / 金额 columns
    order_col = None
    name_col = None
    id_col = None
    spec_col = None
    price_col = None
    pay_col = None
    sub_col = None
    for c in df.columns:
        cs = str(c).strip()
        if ('订单编号' in cs or '订单号' in cs or '订单ID' in cs) and order_col is None:
            order_col = c
        if '商品名称' in cs and name_col is None:
            name_col = c
        if '商品ID' in cs and id_col is None:
            id_col = c
        if cs == '规格' and spec_col is None:
            spec_col = c
        if '商品单价' in cs and price_col is None:
            price_col = c
        if '支付金额' in cs and pay_col is None:
            pay_col = c
        if '补贴金额' in cs and sub_col is None:
            sub_col = c

    if name_col is None or id_col is None:
        fn = [str(c) for c in df.columns]
        print(json.dumps({"ok": False, "error": f"找不到商品名称/商品ID列。列名: {fn}"}, ensure_ascii=False))
        return

    # 商品单价填充（2026-10-21 改）：先 支付金额+平台补贴金额 → 认可档位归一（119→99、219→199）；
    # 算不出再用源表原始单价列（须落在认可档位）；两者都算不出 → 同商品ID众数价兜底。
    filled_price = 0
    if price_col is None:
        anchor = pay_col if pay_col is not None else sub_col
        price_col = "商品单价"
        df.insert(df.columns.get_loc(anchor) if anchor is not None else len(df.columns), price_col, "")

    def id_text(x):
        """商品ID 转文本：float 必须走 int，否则 3.8486e+18 会把不同商品并成一组。"""
        if pd.isna(x):
            return ""
        if isinstance(x, float):
            return str(int(x))
        return str(x).strip()

    pid_list = [id_text(v) for v in df[id_col]]
    pay_list = [row[pay_col] if pay_col is not None else None for _, row in df.iterrows()]
    sub_list = [row[sub_col] if sub_col is not None else None for _, row in df.iterrows()]
    orig_price_list = [row[price_col] if price_col in df.columns else None for _, row in df.iterrows()]
    price_map = mode_price_map(pid_list, pay_list, sub_list, orig_price_list)
    # 单价列若被 pandas 读成 int/float，直接写字符串会 TypeError，先转 object。
    df[price_col] = df[price_col].astype(object)
    for i in range(len(df)):
        df.at[df.index[i], price_col] = price_map.get(i, "")
        filled_price += 1 if price_map.get(i, "") else 0

    # Convert key columns to string to preserve full precision (19-digit IDs / order numbers)
    def to_str(x):
        if pd.isna(x):
            return ''
        if isinstance(x, float):
            return str(int(x))
        return str(x).strip()
    if order_col is not None:
        df[order_col] = df[order_col].apply(to_str)
    df[id_col] = df[id_col].apply(to_str)

    # 剔除不需要匹配的行：规格=默认（如赠品/无渠道商品），直接从成品表中删除
    removed_spec = 0
    if spec_col is not None:
        mask = df[spec_col].apply(lambda x: str(x).strip() == '默认' if pd.notna(x) else False)
        removed_spec = int(mask.sum())
        if removed_spec:
            df = df[~mask].reset_index(drop=True)

    def resolve(pname, pid, price, amount):
        cands = (id_map.get(pid) if pid else None) or (name_map.get(pname) if pname else None) or []
        if not cands:
            return ""
        if len(cands) == 1:
            return cands[0]
        # 同名/同ID 多渠道：按金额与渠道名价格后缀消歧（单价优先——支付+补贴有约 22% 行因优惠偏离）
        for amt in (price, amount):
            if amt is None:
                continue
            by_price = [c for c in cands if price_of(c) is not None and abs(price_of(c) - amt) < 0.01]
            if by_price:
                return by_price[0]
        # 金额对不上带后缀的渠道时，退回无价格后缀的渠道（如 初中内容直播）
        no_price = [c for c in cands if price_of(c) is None]
        if no_price:
            return no_price[0]
        return ""   # 无法判定 → 未匹配，进手动补齐列表

    # Match
    matched = 0
    unmatched_items = {}
    channels = []
    for _, row in df.iterrows():
        pid = str(row[id_col]).strip() if pd.notna(row[id_col]) else ""
        pname = str(row[name_col]).strip() if pd.notna(row[name_col]) else ""
        price = to_num(row[price_col]) if price_col is not None else None
        amount = None
        if pay_col is not None or sub_col is not None:
            p = to_num(row[pay_col]) if pay_col is not None else 0.0
            s = to_num(row[sub_col]) if sub_col is not None else 0.0
            if p is not None or s is not None:
                amount = (p or 0.0) + (s or 0.0)
        ch = resolve(pname, pid, price, amount)
        channels.append(ch)
        if ch:
            matched += 1
        else:
            key = (pname, pid)
            unmatched_items[key] = unmatched_items.get(key, 0) + 1

    # Add channel column after 商品ID
    id_idx = df.columns.get_loc(id_col)
    df.insert(id_idx + 1, "渠道", channels)

    # Save output with text format for order/id columns
    base, ext = os.path.splitext(file_path)
    out_path = base + "_渠道" + ext
    with pd.ExcelWriter(out_path, engine='openpyxl') as writer:
        df.to_excel(writer, index=False)
        ws = writer.sheets['Sheet1']
        text_cols = []
        if order_col is not None:
            text_cols.append(df.columns.get_loc(order_col) + 1)
        text_cols.append(id_idx + 1)
        for col_idx in set(text_cols):
            letter = get_column_letter(col_idx)
            for r in range(2, ws.max_row + 1):
                ws[f'{letter}{r}'].number_format = '@'

    print(json.dumps({
        "ok": True,
        "total": len(df),
        "removedSpec": removed_spec,
        "priceFilled": filled_price,
        "matched": matched,
        "unmatched": len(df) - matched,
        "unmatchedItems": [
            {"name": k[0], "id": k[1], "rows": v}
            for k, v in sorted(unmatched_items.items(), key=lambda kv: -kv[1])
        ],
        "output": out_path
    }, ensure_ascii=False))

if __name__ == "__main__":
    main()
