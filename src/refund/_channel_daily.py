#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""分渠道分日公共逻辑（供 refund_daily_rate / refund_daily_6h / refund_daily_6h_unallocated 复用）
口径与 3.5 渠道汇总一致：
  - 学段分组 = 渠道名首部连续汉字段前 2 字（初中数学-99 → 初中）
  - 学段优先级排序：高中 → 初中 → 小学 → 大学 → 中专 → 幼儿园 → 其他
  - 组内汇总行在前；子渠道按渠道类型相邻、同类型按价格从小到大
  - 汇总行整行加粗 + 黄底 #FFF2CC
"""
import math
import os
import re

import pandas as pd
import openpyxl
from openpyxl.styles import PatternFill, Font, Alignment, Border, Side
from PIL import Image, ImageDraw, ImageFont

XUE_ORDER = ['高中', '初中', '小学', '大学', '中专', '幼儿园']

PALETTE = [
    (31, 78, 120),    # 深蓝
    (237, 125, 49),   # 橙
    (192, 0, 0),      # 红
    (84, 130, 53),    # 绿
    (112, 48, 160),   # 紫
    (0, 112, 192),    # 亮蓝
    (156, 87, 38),    # 棕
]

EMPTY_CH = ('', 'nan', 'None', '#N/A', 'N/A', 'NA', '#NA')


def find_chinese_font() -> str:
    candidates = [
        'C:/Windows/Fonts/msyh.ttc',
        'C:/Windows/Fonts/simhei.ttf',
        '/System/Library/Fonts/PingFang.ttc',
        '/System/Library/Fonts/STHeiti Medium.ttc',
        '/System/Library/Fonts/Hiragino Sans GB.ttc',
        '/Library/Fonts/Songti.ttc',
    ]
    for p in candidates:
        if os.path.exists(p):
            return p
    return None


def xueduan(name) -> str:
    m = re.match(r'^([一-龥]{2})', str(name).strip())
    return m.group(1) if m else '其他'


def channel_sort_key(name):
    s = str(name).strip()
    xu = xueduan(s)
    prio = XUE_ORDER.index(xu) if xu in XUE_ORDER else len(XUE_ORDER)
    rest = s[2:] if s[:2] == xu else s
    m = re.search(r'(\d+)', rest)
    price = int(m.group(1)) if m else 10 ** 9
    typ = re.sub(r'\d+', '', rest)
    return (prio, xu, typ, price, s)


def channel_daily_rows(df: pd.DataFrame, specs):
    """按 渠道×下单日期 统计。df 需含 订单编号/渠道/下单日期 列及 specs 引用的布尔列。
    specs: [(计数列名, 布尔列名)]
    返回 (rows, dates)：rows 元素 {渠道, 汇总, 下单日期, 总订单数, <specs 各计数>}，
    顺序=学段汇总行在前+子渠道，未填渠道（渠道列为空）放最后。
    """
    d = df.copy()
    d['渠道_'] = d['渠道'].astype(str).str.strip()
    d.loc[d['渠道_'].isin(EMPTY_CH), '渠道_'] = ''
    dates = sorted(set(d['下单日期']))
    rows = []

    def emit(label, is_sum, sub):
        for dt in dates:
            s = sub[sub['下单日期'] == dt]
            if s.empty or int(s['订单编号'].nunique()) == 0:
                continue   # 该渠道此日无订单，不出行（避免除零+稀疏噪音）
            row = {'渠道': label, '汇总': is_sum, '下单日期': dt,
                   '总订单数': int(s['订单编号'].nunique())}
            for name, col in specs:
                row[name] = int(s[s[col]]['订单编号'].nunique())
            rows.append(row)

    d['学段'] = d['渠道_'].map(lambda v: xueduan(v) if v else '未填渠道')
    xus = [x for x in dict.fromkeys(d['学段']) if x != '未填渠道']
    xus.sort(key=lambda x: XUE_ORDER.index(x) if x in XUE_ORDER else len(XUE_ORDER))
    for xu in xus:
        emit(xu + '汇总', True, d[d['学段'] == xu])
        for ch in sorted(d[d['学段'] == xu]['渠道_'].unique(), key=channel_sort_key):
            emit(ch, False, d[d['渠道_'] == ch])
    if (d['学段'] == '未填渠道').any():
        emit('未填渠道', True, d[d['学段'] == '未填渠道'])
    return rows, dates


def write_channel_sheet(path: str, sheet_name: str, headers, rows, total_vals) -> None:
    """rows: 每行与 headers 等长的值列表；学段汇总行（渠道名以'汇总'结尾）加粗+黄底。
    total_vals: 合计行（与 headers 等长）。"""
    wb = openpyxl.load_workbook(path)
    if sheet_name in wb.sheetnames:
        del wb[sheet_name]
    ws = wb.create_sheet(sheet_name, 1)

    header_fill = PatternFill('solid', fgColor='1F4E78')
    white_bold = Font(color='FFFFFF', bold=True, size=11)
    center = Alignment(horizontal='center', vertical='center', wrap_text=True)
    thin = Side(border_style='thin', color='999999')
    border = Border(left=thin, right=thin, top=thin, bottom=thin)

    for i, h in enumerate(headers, 1):
        c = ws.cell(row=1, column=i, value=h)
        c.fill = header_fill
        c.font = white_bold
        c.alignment = center
        c.border = border

    sum_fill = PatternFill('solid', fgColor='FFF2CC')
    for r, row in enumerate(rows, 2):
        is_sum = str(row[0]).endswith('汇总')
        for i, v in enumerate(row, 1):
            c = ws.cell(row=r, column=i, value=v)
            c.alignment = center
            c.border = border
            if is_sum:
                c.fill = sum_fill
                c.font = Font(bold=True)

    rr = len(rows) + 2
    for i, v in enumerate(total_vals, 1):
        c = ws.cell(row=rr, column=i, value=v)
        c.alignment = center
        c.border = border
        c.fill = PatternFill('solid', fgColor='D9E1F2')
        c.font = Font(bold=True)

    ws.column_dimensions['A'].width = 22
    for col in 'BCDEFGHIJKL'[:len(headers) - 1]:
        ws.column_dimensions[col].width = 14
    ws.freeze_panes = 'A2'
    wb.save(path)


def draw_channel_png(png_path: str, title: str, subtitle: str, dates, series, scale: int = 2) -> None:
    """分渠道退款率折线图。series: [(label, color, [各日期的率值%])]"""
    fp = find_chinese_font()
    if not fp:
        raise RuntimeError('未找到中文字体，无法生成图片')

    S = scale
    font_t = ImageFont.truetype(fp, S * 20)
    font_n = ImageFont.truetype(fp, S * 14)
    font_s = ImageFont.truetype(fp, S * 12)

    W = S * 1000
    margin_l, margin_r = S * 100, S * 50
    margin_t, margin_b = S * 120, S * 140
    chart_w = W - margin_l - margin_r
    chart_h = S * 420
    H = margin_t + chart_h + margin_b

    img = Image.new('RGB', (W, H), (255, 255, 255))
    draw = ImageDraw.Draw(img)

    bbox = draw.textbbox((0, 0), title, font=font_t)
    draw.text(((W - (bbox[2] - bbox[0])) // 2, S * 20), title, fill=(31, 78, 120), font=font_t)
    bbox = draw.textbbox((0, 0), subtitle, font=font_n)
    draw.text(((W - (bbox[2] - bbox[0])) // 2, S * 58), subtitle, fill=(80, 80, 80), font=font_n)

    chart_x0, chart_y0 = margin_l, margin_t
    chart_x1 = chart_x0 + chart_w
    chart_y1 = chart_y0 + chart_h

    all_vals = [v for _, _, vs in series for v in vs if v is not None] or [0.0]
    y_max = max(20.0, math.ceil(max(all_vals) * 1.2 / 20) * 20)
    grid_n = int(y_max / 20)
    for i in range(grid_n + 1):
        yv = 20 * i
        y = chart_y1 - (yv / y_max) * chart_h
        draw.line([(chart_x0, y), (chart_x1, y)], fill=(225, 225, 225), width=1)
        label = f'{yv:.0f}%'
        bbox = draw.textbbox((0, 0), label, font=font_s)
        lw = bbox[2] - bbox[0]
        draw.text((chart_x0 - lw - S * 8, y - S * 8), label, fill=(80, 80, 80), font=font_s)

    draw.line([(chart_x0, chart_y1), (chart_x1, chart_y1)], fill=(0, 0, 0), width=S * 2)
    draw.line([(chart_x0, chart_y0), (chart_x0, chart_y1)], fill=(0, 0, 0), width=S * 2)

    n = len(dates)
    gap = chart_w / max(n, 1)
    for i in range(n):
        cx = chart_x0 + gap * (i + 0.5)
        d_label = dates[i].strftime('%m-%d')
        bbox = draw.textbbox((0, 0), d_label, font=font_s)
        lw = bbox[2] - bbox[0]
        draw.text((cx - lw / 2, chart_y1 + S * 10), d_label, fill=(0, 0, 0), font=font_s)

    for label, color, vals in series:
        pts = []
        for i, v in enumerate(vals):
            if v is None:
                continue
            cx = chart_x0 + gap * (i + 0.5)
            cy = chart_y1 - (v / y_max) * chart_h
            pts.append((cx, cy))
        for i in range(len(pts) - 1):
            draw.line([pts[i], pts[i + 1]], fill=color, width=S * 3)
        for p in pts:
            draw.ellipse([p[0] - S * 4, p[1] - S * 4, p[0] + S * 4, p[1] + S * 4],
                         fill=color, outline=(255, 255, 255), width=S * 2)

    lx, ly = margin_l, H - S * 55
    for label, color, _ in series:
        draw.line([(lx, ly + S * 6), (lx + S * 30, ly + S * 6)], fill=color, width=S * 3)
        draw.ellipse([lx + S * 10, ly + S * 1, lx + S * 20, ly + S * 11], fill=color,
                     outline=(255, 255, 255))
        draw.text((lx + S * 40, ly - S * 2), label, fill=(0, 0, 0), font=font_n)
        lx += S * (40 * len(label) + 90)

    img.save(png_path)
    print(f'  ✓ PNG: {png_path}（{W}×{H}）')
