#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
渠道汇总退款率分析（第 5 种分析类型）
=====================================================================
用途：处理「已瘦身」的退款底表（由 preprocess.py 产出，5 列），
      按学科前缀自动分组汇总，输出各直播间/学科的
      已付款订单量、折损量（分配前退款）、退款率。

输入：Excel 文件（5 列：订单编号/渠道/下单时间/退款时间/是否分配）

输出：
  1. Excel 新增工作表「渠道汇总退款率」
  2. PNG 表格图（同目录）：<原表名>_渠道汇总退款率.png

口径：
  - 已付款订单量 = 订单编号去重计数（preprocess 已过滤掉付款时间为空）
  - 折损量（分配前退款）= 是否分配=未分配 且 退款时间非空 且 diff>=0 的订单编号去重数
  - 退款率 = 折损量 / 已付款订单量（百分比，四舍五入到整数）
  - 汇总行 = 渠道名首部连续汉字段前 2 字相同的渠道之和
      例：初中数学-99/-49/-199 → 初中汇总
          高中数学-99 → 高中汇总
          小学英语-99 → 小学汇总
  - 汇总行样式：加粗 + 黄色高亮（与子渠道行的退款率 ≥25% 黄底高亮并存）
  - 服务期名称：每次运行由用户填写（如 0908-18点），作为表格第一列常量

使用：
  python3 refund_channel_summary.py <thin_excel_path> [--service-period 0908-18点]

依赖：
  pip install pandas openpyxl pillow
"""

import sys
import os
import re
import warnings
import argparse
from pathlib import Path

import pandas as pd
import openpyxl
from openpyxl.styles import PatternFill, Font, Alignment, Border, Side
from PIL import Image, ImageDraw, ImageFont

warnings.filterwarnings('ignore')


SHEET_NAME = '退款'
SHEET_OUT = '渠道汇总退款率'

ALLOCATED   = '已分配'
UNALLOCATED = '未分配'

# 高亮配色
HIGHLIGHT_THRESHOLD = 20  # 退款率 > 20% 时高亮「退款率」单元格（橙色）
COLOR_HIGHLIGHT  = (255, 242, 204)  # 汇总行整行黄底（FFF2CC）
COLOR_RATE_HIGH  = (255, 192,   0)  # 退款率 >20% 单元格橙底（FFC000）

SCALE = 2


def find_chinese_font() -> str:
    candidates = [
        '/System/Library/Fonts/PingFang.ttc',
        '/System/Library/Fonts/STHeiti Medium.ttc',
        '/System/Library/Fonts/STHeiti Light.ttc',
        '/System/Library/Fonts/Hiragino Sans GB.ttc',
        '/Library/Fonts/Songti.ttc',
        '/System/Library/Fonts/Supplemental/Songti.ttc',
        'C:/Windows/Fonts/msyh.ttc',
        'C:/Windows/Fonts/simhei.ttf',
    ]
    for p in candidates:
        if os.path.exists(p):
            return p
    return None


def map_alloc(v) -> str:
    s = str(v).strip()
    if s in ('已分配', '是', 'Y', 'y', 'YES', 'Yes', 'yes', '1', 'TRUE', 'True', 'true'):
        return ALLOCATED
    if s in ('未分配', '否', 'N', 'n', 'NO', 'No', 'no', '0', 'FALSE', 'False', 'false'):
        return UNALLOCATED
    if s in ('', 'nan', 'None', '#N/A', 'N/A', 'NA', '#NA'):
        return UNALLOCATED
    return s


def load_data(path: str) -> pd.DataFrame:
    df = pd.read_excel(path, sheet_name=SHEET_NAME)
    needed = {'订单编号', '渠道', '下单时间', '退款时间', '是否分配'}
    missing = needed - set(df.columns)
    if missing:
        raise ValueError(f'底表缺少必要列: {missing}')

    df = df.copy()
    df['下单时间_dt'] = pd.to_datetime(df['下单时间'].astype(str).str.strip(), errors='coerce')
    df['退款时间_dt'] = pd.to_datetime(df['退款时间'].astype(str).str.strip(), errors='coerce')
    df = df.dropna(subset=['下单时间_dt'])
    df['diff_hours'] = (df['退款时间_dt'] - df['下单时间_dt']).dt.total_seconds() / 3600

    df['是否分配_规范'] = df['是否分配'].apply(map_alloc)
    df['是否退款'] = (df['退款时间'].notna()
                      & df['diff_hours'].notna()
                      & (df['diff_hours'] >= 0))
    df['未分配退款'] = (df['是否分配_规范'] == UNALLOCATED) & df['是否退款']
    return df


def extract_edu_prefix(ch: str) -> str:
    """提取渠道名的"学段前缀"。

    规则：渠道名首部连续汉字段的前 2 字。
      例：初中数学-99   → 初中
          高中数学-99   → 高中
          小学英语-99   → 小学
          初中物理-199  → 初中
    """
    m = re.match(r'^[\u4e00-\u9fa5]+', str(ch))
    if not m:
        return str(ch)
    head = m.group(0)
    return head[:2]


def extract_channel_type(ch: str) -> str:
    """提取渠道名的"渠道类型"（连字符前的完整中文名）。

    用于把"初中数学-99"和"初中数理化-199"视为同一学段（初中）下、
    不同渠道类型，从而在排序时让同一类型相邻。
      例：初中数学-99   → 初中数学
          初中数理化-199 → 初中数理化
          高中数学-99   → 高中数学
          小学英语-99   → 小学英语
    """
    s = str(ch)
    # 去掉末尾数字和价格后缀
    s = re.sub(r'-?\d+\s*$', '', s)
    # 去掉尾部可能的非汉字
    s = re.sub(r'[^\u4e00-\u9fa5\s]+$', '', s).strip()
    return s if s else str(ch)


def compute_summary(df: pd.DataFrame, service_period: str) -> pd.DataFrame:
    """按学科前缀自动分组汇总，生成渠道汇总退款率表。

    - 总是为每个学段前缀生成汇总行（即使只有一个子渠道）。
    - 学段排序：高中 → 初中 → 小学 → 大学 → 中专 → 幼儿园 → 其他。
    - 同一学段内部，子渠道按"渠道类型"相邻排列（例：初中数学、初中数理化），
      同一渠道类型内按价格 49 → 99 → 199 从小到大排列。
    - 退款率保留 1 位小数。
    """
    channels = sorted(df['渠道'].dropna().unique())

    # 学段前缀顺序：按渠道在原始数据中首次出现的顺序（用于汇总行渲染顺序备查）
    prefixes = []
    for ch in df['渠道'].dropna():
        prefix = extract_edu_prefix(ch)
        if prefix not in prefixes:
            prefixes.append(prefix)

    # 每个渠道的指标
    channel_rows = []
    for ch in channels:
        sub = df[df['渠道'] == ch]
        paid = sub['订单编号'].nunique()
        loss = sub[sub['未分配退款']]['订单编号'].nunique()
        rate = round(loss / paid * 100, 1) if paid else 0.0
        prefix = extract_edu_prefix(ch)
        channel_rows.append({
            '学段前缀': prefix,
            '直播间名称': ch,
            '已付款订单量': paid,
            '折损量': loss,
            '退款率': rate,
        })

    # 按学段前缀分组，生成汇总行（总是生成，不管几个子渠道）
    grouped = {}
    for r in channel_rows:
        grouped.setdefault(r['学段前缀'], []).append(r)

    records = []
    for prefix in prefixes:
        items = grouped[prefix]
        total_paid = sum(x['已付款订单量'] for x in items)
        total_loss = sum(x['折损量'] for x in items)
        total_rate = round(total_loss / total_paid * 100, 1) if total_paid else 0.0
        # 总是生成汇总行
        records.append({
            '服务期': service_period,
            '直播间名称': f'{prefix}汇总',
            '已付款订单量': total_paid,
            '折损量': total_loss,
            '退款率': total_rate,
            '是汇总行': True,
        })
        for x in items:
            records.append({
                '服务期': service_period,
                '直播间名称': x['直播间名称'],
                '已付款订单量': x['已付款订单量'],
                '折损量': x['折损量'],
                '退款率': x['退款率'],
                '是汇总行': False,
            })

    # 排序：按学段优先级（高中→初中→小学→大学→中专→幼儿园→其他），
    #       组内汇总行在前；子渠道按"渠道类型"相邻，同一类型内价格 49→99→199
    PREFIX_ORDER = {'高中': 0, '初中': 1, '小学': 2, '大学': 3, '中专': 4, '幼儿园': 5}

    def suffix_order(name):
        m = re.search(r'(\d+)$', name)
        if not m:
            return 99
        return {'49': 0, '99': 1, '199': 2}.get(m.group(1), 99)

    def sort_key(r):
        if r['是汇总行']:
            prefix = r['直播间名称'][:-2]
        else:
            prefix = extract_edu_prefix(r['直播间名称'])
        po = PREFIX_ORDER.get(prefix, 99)
        is_summary = 0 if r['是汇总行'] else 1
        if r['是汇总行']:
            return (po, is_summary, '', 0)
        # 子渠道：先按渠道类型分组，再按价格后缀从小到大
        channel_type = extract_channel_type(r['直播间名称'])
        so = suffix_order(r['直播间名称'])
        return (po, is_summary, channel_type, so)

    records.sort(key=sort_key)
    return pd.DataFrame(records)


def write_excel(path: str, summary: pd.DataFrame) -> None:
    wb = openpyxl.load_workbook(path)
    if SHEET_OUT in wb.sheetnames:
        del wb[SHEET_OUT]
    ws = wb.create_sheet(SHEET_OUT, 1)

    header_fill = PatternFill('solid', fgColor='1F4E78')
    white_bold  = Font(color='FFFFFF', bold=True, size=11)
    center      = Alignment(horizontal='center', vertical='center', wrap_text=True)
    thin        = Side(border_style='thin', color='999999')
    border      = Border(left=thin, right=thin, top=thin, bottom=thin)
    fill_summary = PatternFill('solid', fgColor='FFF2CC')  # 汇总行黄底
    fill_rate    = PatternFill('solid', fgColor='FFC000')  # 退款率 >20% 橙底
    bold_black   = Font(bold=True, color='000000', size=11)
    norm_black   = Font(color='000000', size=11)

    headers = ['服务期', '直播间名称', '已付款订单量', '折损量（分配前退款）', '退款率']
    for i, h in enumerate(headers, 1):
        c = ws.cell(row=1, column=i, value=h)
        c.fill = header_fill
        c.font = white_bold
        c.alignment = center
        c.border = border

    n = len(summary)
    RATE_COL_IDX = 5  # 「退款率」列号
    for r, row in summary.iterrows():
        rr = r + 2
        is_summary = bool(row['是汇总行'])
        rate_str = f'{row["退款率"]:.1f}%'  # 1 位小数
        vals = [
            row['服务期'],
            row['直播间名称'],
            int(row['已付款订单量']),
            int(row['折损量']),
            rate_str,
        ]
        rate_high = row['退款率'] > HIGHLIGHT_THRESHOLD
        for i, v in enumerate(vals, 1):
            c = ws.cell(row=rr, column=i, value=v)
            c.alignment = center
            c.border = border
            # 汇总行：整行加粗 + 黄底
            if is_summary:
                c.font = bold_black
                c.fill = fill_summary
            else:
                c.font = norm_black
            # 退款率单元格 >20% 时橙底（叠加在汇总行黄底之上也保留橙色）
            if i == RATE_COL_IDX and rate_high:
                c.fill = fill_rate

    # 服务期列合并单元格（跨所有数据行）
    if n > 0:
        ws.merge_cells(start_row=2, end_row=n + 1, start_column=1, end_column=1)
        a = ws.cell(row=2, column=1)
        a.alignment = Alignment(horizontal='center', vertical='center')

    ws.column_dimensions['A'].width = 16
    ws.column_dimensions['B'].width = 22
    for col in 'CDE':
        ws.column_dimensions[col].width = 22
    ws.freeze_panes = 'A2'
    wb.save(path)


def draw_png(summary: pd.DataFrame, out_path: str) -> None:
    """绘制与 Excel 样式完全一致的渠道汇总退款率 PNG。

    对齐 Excel 的关键样式点（实测对应）：
      - 全表 11 号字，汇总行用 stroke_width 模拟加粗（不靠放大字号）
      - 表头：#1F4E78 蓝底、白字、加粗
      - 汇总行：#FFF2CC 黄底、整行加粗
      - 退款率 >20%：#FFC000 橙底（只染色该单元格，不影响其他字段）
      - 边框统一 #999999
      - 服务期列整列只显示一次（垂直居中，模拟 Excel A2:AN 合并效果）
      - 列宽按 Excel 16:22:22:22:22 比例
        服务期 16 单位 ≈ 110 px
        直播间 22 单位 ≈ 170 px（含中文略宽）
        订单量/折损量 22 单位 ≈ 130 / 170 px
        退款率 22 单位 ≈ 110 px
    """
    fp = find_chinese_font()
    if not fp:
        raise RuntimeError('未找到中文字体，无法生成图片')

    S = SCALE
    # 统一字号 ≈ 11号 @ 96dpi，SCALE=2 下用 26 px
    font_size = S * 13
    font_base = ImageFont.truetype(fp, font_size)
    STROKE_BOLD = 1  # 汇总行加粗描边（像素数；SCALE=2 下加粗效果与 Excel 一致）

    # 配色（与 Excel 完全一致）
    HEADER_BG     = (31,  78, 120)   # #1F4E78 表头蓝
    SUMMARY_BG    = (255, 242, 204)  # #FFF2CC 汇总行黄
    RATE_HIGH_BG  = (255, 192,   0)  # #FFC000 退款率>20% 橙
    BORDER_COLOR  = (153, 153, 153)  # #999999 统一边框
    WHITE         = (255, 255, 255)
    BLACK         = (0,   0,   0)

    # 列宽按 Excel 16:22:22:22:22 → 像素 110:170:130:170:110
    col_w = [S * 110, S * 170, S * 130, S * 170, S * 110]
    row_h     = S * 22
    header_h  = S * 24
    margin_t  = S * 10   # 去掉顶部标题后的留白
    margin_b  = S * 10

    headers = ['服务期', '直播间名称', '已付款订单量', '折损量（分配前退款）', '退款率']

    n_rows = len(summary)
    W = sum(col_w)
    H = margin_t + header_h + n_rows * row_h + margin_b

    img = Image.new('RGB', (W, H), WHITE)
    draw = ImageDraw.Draw(img)

    # ---- 找到第一个汇总行（用于 A 列"整列只显示一次"）----
    first_summary_idx = None
    for i, (_, row) in enumerate(summary.iterrows()):
        if bool(row['是汇总行']):
            first_summary_idx = i
            break
    service_period_text = str(summary.iloc[first_summary_idx]['服务期']) if first_summary_idx is not None else ''

    # ---- 第一遍：表头 ----
    y = margin_t
    x = 0
    for i, h in enumerate(headers):
        draw.rectangle([x, y, x + col_w[i], y + header_h], fill=HEADER_BG, outline=BORDER_COLOR)
        bbox = draw.textbbox((0, 0), h, font=font_base)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        draw.text((x + (col_w[i] - tw) // 2, y + (header_h - th) // 2 - 1),
                  h, fill=WHITE, font=font_base,
                  stroke_width=STROKE_BOLD, stroke_fill=WHITE)
        x += col_w[i]
    y += header_h

    # ---- 第二遍：所有数据行（单元格背景 + 边框，无文字）----
    for idx, (_, row) in enumerate(summary.iterrows()):
        is_summary = bool(row['是汇总行'])
        rate_high = row['退款率'] > HIGHLIGHT_THRESHOLD
        other_row_bg = SUMMARY_BG if is_summary else WHITE

        # A 列统一用黄底（模拟 Excel A2:AN 合并后整段黄底）
        a_bg = SUMMARY_BG

        for i in range(5):
            if i == 4 and rate_high:
                cell_bg = RATE_HIGH_BG
            elif i == 0:
                cell_bg = a_bg
            else:
                cell_bg = other_row_bg
            draw.rectangle([x_start := sum(col_w[:i]), y,
                            x_start + col_w[i], y + row_h],
                           fill=cell_bg, outline=BORDER_COLOR)
        y += row_h

    # ---- 第三遍：所有数据行文字（B/C/D/E 列对齐到单元格中心，A 列跳过）----
    y = margin_t + header_h
    for idx, (_, row) in enumerate(summary.iterrows()):
        is_summary = bool(row['是汇总行'])
        rate_high = row['退款率'] > HIGHLIGHT_THRESHOLD
        vals = [
            '',                                              # A 列放到下一遍跨行居中画
            row['直播间名称'],
            str(int(row['已付款订单量'])),
            str(int(row['折损量'])),
            f'{row["退款率"]:.1f}%',                          # 1 位小数，与 Excel 一致
        ]
        stroke_w = STROKE_BOLD if is_summary else 0
        x = 0
        for i, v in enumerate(vals):
            if i == 0:
                x += col_w[i]
                continue
            bbox = draw.textbbox((0, 0), v, font=font_base)
            tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
            tx = x + (col_w[i] - tw) // 2
            ty = y + (row_h - th) // 2 - 1
            draw.text((tx, ty), v, fill=BLACK, font=font_base,
                      stroke_width=stroke_w, stroke_fill=BLACK)
            x += col_w[i]
        y += row_h

    # ---- 第四遍：A 列服务期文本（垂直居中，跨整列数据行范围）----
    if first_summary_idx is not None and service_period_text:
        a_x = 0
        a_y_top = margin_t + header_h + first_summary_idx * row_h
        a_y_bot = margin_t + header_h + n_rows * row_h
        center_y = (a_y_top + a_y_bot) // 2
        bbox = draw.textbbox((0, 0), service_period_text, font=font_base)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        tx = a_x + (col_w[0] - tw) // 2
        ty = center_y - th // 2
        draw.text((tx, ty), service_period_text,
                  fill=BLACK, font=font_base,
                  stroke_width=STROKE_BOLD, stroke_fill=BLACK)

    img.save(out_path)
    print(f'  ✓ PNG: {out_path}（{W}×{H}）')


def main():
    ap = argparse.ArgumentParser(description='渠道汇总退款率分析')
    ap.add_argument('excel', help='瘦身表路径（.xlsx）')
    ap.add_argument('--service-period', default=None, help='服务期名称（如 0908-18点），不传则交互式输入')
    args = ap.parse_args()

    path = args.excel
    if not os.path.exists(path):
        print(f'文件不存在: {path}')
        sys.exit(1)

    service_period = args.service_period
    # 服务期内容每次跑都向用户确认（即便已通过 --service-period 传入，仍询问一次确认）
    if service_period:
        confirm = input(f'检测到服务期参数 "{service_period}"，确认使用？[回车确认 / 输入新值覆盖]: ').strip()
        if confirm:
            service_period = confirm
    else:
        service_period = input('请输入服务期名称（如 0908-18点）: ').strip()
    if not service_period:
        service_period = '未命名'

    print(f'[1/3] 读取底表: {path}')
    df = load_data(path)
    print(f'  → 已付款订单 {df["订单编号"].nunique()} 笔')

    print(f'[2/3] 计算渠道汇总退款率（服务期: {service_period}）')
    summary = compute_summary(df, service_period)
    print(summary.to_string(index=False))

    print('[3/3] 写入 Excel 工作表 + PNG')
    write_excel(path, summary)
    print('  ✓ Excel 已保存')
    png_path = str(Path(path).with_name(Path(path).stem + '_渠道汇总退款率.png'))
    draw_png(summary, png_path)

    print('\n=== 渠道汇总退款率摘要 ===')
    for _, r in summary.iterrows():
        print(f'{r["直播间名称"]}: 已付款 {int(r["已付款订单量"])} | '
              f'折损 {int(r["折损量"])} | 退款率 {r["退款率"]}%')


if __name__ == '__main__':
    main()
