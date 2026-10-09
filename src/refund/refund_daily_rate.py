#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
分日退款率趋势分析（未分配 / 已分配 / 总 三条退款率）
=====================================================================
用途：处理「已瘦身」的退款底表（由 preprocess.py 产出，5 列），
      按下单日期分组，输出三条退款率趋势：
        1. 未分配退款率 = 未分配退款数 / 总订单数
        2. 已分配退款率 = 已分配退款数 / 总订单数
        3. 总退款率     = 总退款数 / 总订单数

输入：Excel 文件（5 列：订单编号/渠道/下单时间/退款时间/是否分配）

输出：
  1. Excel 新增工作表「分日退款率」
  2. PNG 趋势图（同目录，文件名：<原表名>_分日退款率.png）

口径：
  - 分日 = 按「下单日期」分组
  - 总订单数 = 每日「订单编号」去重数（含未退款订单）
  - 退款数 = 每日退款时间非空 且 diff>=0 的「订单编号」去重数
  - 未分配退款数 = 是否分配=未分配 的退款订单去重数
  - 已分配退款数 = 是否分配=已分配 的退款订单去重数
  - 退款率 = 退款数 / 总订单数（百分比，保留 2 位小数）

使用：
  python3 refund_daily_rate.py <thin_excel_path>

依赖：
  pip install pandas openpyxl pillow
"""

import sys
import os
import math
import warnings
from pathlib import Path

import pandas as pd
import openpyxl
from openpyxl.styles import PatternFill, Font, Alignment, Border, Side
from PIL import Image, ImageDraw, ImageFont

from _channel_daily import (PALETTE, channel_daily_rows, write_channel_sheet,
                            draw_channel_png)

warnings.filterwarnings('ignore')


SHEET_NAME = '退款'
SHEET_OUT = '分日退款率'
SHEET_CH = '分渠道分日退款率'

ALLOCATED   = '已分配'
UNALLOCATED = '未分配'

# 图表配色
C_UNALLOC = (31, 78, 120)     # 未分配退款率：深蓝
C_ALLOC   = (237, 125, 49)    # 已分配退款率：橙
C_TOTAL   = (192, 0, 0)       # 总退款率：红

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


def load_df(path: str) -> pd.DataFrame:
    df = pd.read_excel(path, sheet_name=SHEET_NAME)
    needed = {'订单编号', '渠道', '下单时间', '退款时间', '是否分配'}
    missing = needed - set(df.columns)
    if missing:
        raise ValueError(f'底表缺少必要列: {missing}')

    df = df.copy()
    df['下单时间_dt'] = pd.to_datetime(df['下单时间'].astype(str).str.strip(), errors='coerce')
    df['退款时间_dt'] = pd.to_datetime(df['退款时间'].astype(str).str.strip(), errors='coerce')
    df = df.dropna(subset=['下单时间_dt'])
    df['下单日期'] = df['下单时间_dt'].dt.date
    df['diff_hours'] = (df['退款时间_dt'] - df['下单时间_dt']).dt.total_seconds() / 3600
    df['是否分配_规范'] = df['是否分配'].apply(map_alloc)

    # 是否退款：退款时间非空 且 diff>=0（丢弃退款早于下单的异常）
    df['是否退款'] = (df['退款时间'].notna()
                      & df['diff_hours'].notna()
                      & (df['diff_hours'] >= 0))
    df['未分配退款'] = (df['是否分配_规范'] == UNALLOCATED) & df['是否退款']
    df['已分配退款'] = (df['是否分配_规范'] == ALLOCATED) & df['是否退款']
    return df


def load_daily(path: str) -> pd.DataFrame:
    df = load_df(path)
    return aggregate_daily(df)


def aggregate_daily(df: pd.DataFrame) -> pd.DataFrame:
    daily = pd.DataFrame()
    daily['总订单数'] = df.groupby('下单日期')['订单编号'].nunique()
    daily['未分配退款数'] = df[df['未分配退款']].groupby('下单日期')['订单编号'].nunique()
    daily['已分配退款数'] = df[df['已分配退款']].groupby('下单日期')['订单编号'].nunique()
    daily['总退款数'] = df[df['是否退款']].groupby('下单日期')['订单编号'].nunique()
    daily = daily.fillna(0).astype(int)

    daily['未分配退款率'] = (daily['未分配退款数'] / daily['总订单数'] * 100).round(2)
    daily['已分配退款率'] = (daily['已分配退款数'] / daily['总订单数'] * 100).round(2)
    daily['总退款率'] = (daily['总退款数'] / daily['总订单数'] * 100).round(2)
    return daily.reset_index().sort_values('下单日期').reset_index(drop=True)


def write_excel(path: str, daily: pd.DataFrame) -> None:
    wb = openpyxl.load_workbook(path)
    if SHEET_OUT in wb.sheetnames:
        del wb[SHEET_OUT]
    ws = wb.create_sheet(SHEET_OUT, 1)

    header_fill = PatternFill('solid', fgColor='1F4E78')
    white_bold  = Font(color='FFFFFF', bold=True, size=11)
    center      = Alignment(horizontal='center', vertical='center', wrap_text=True)
    thin        = Side(border_style='thin', color='999999')
    border      = Border(left=thin, right=thin, top=thin, bottom=thin)

    headers = ['下单日期', '总订单数', '未分配退款数', '未分配退款率',
               '已分配退款数', '已分配退款率', '总退款数', '总退款率']
    for i, h in enumerate(headers, 1):
        c = ws.cell(row=1, column=i, value=h)
        c.fill = header_fill
        c.font = white_bold
        c.alignment = center
        c.border = border

    for r, row in daily.iterrows():
        rr = r + 2
        vals = [
            row['下单日期'].strftime('%Y-%m-%d'),
            int(row['总订单数']),
            int(row['未分配退款数']), f'{row["未分配退款率"]:.2f}%',
            int(row['已分配退款数']), f'{row["已分配退款率"]:.2f}%',
            int(row['总退款数']), f'{row["总退款率"]:.2f}%',
        ]
        for i, v in enumerate(vals, 1):
            c = ws.cell(row=rr, column=i, value=v)
            c.alignment = center
            c.border = border

    # 合计行
    total_orders = int(daily['总订单数'].sum())
    total_un = int(daily['未分配退款数'].sum())
    total_al = int(daily['已分配退款数'].sum())
    total_ref = int(daily['总退款数'].sum())
    rr = len(daily) + 2
    sum_vals = ['合计', total_orders,
                total_un, f'{total_un / total_orders * 100:.2f}%',
                total_al, f'{total_al / total_orders * 100:.2f}%',
                total_ref, f'{total_ref / total_orders * 100:.2f}%']
    for i, v in enumerate(sum_vals, 1):
        c = ws.cell(row=rr, column=i, value=v)
        c.alignment = center
        c.border = border
        c.fill = PatternFill('solid', fgColor='D9E1F2')
        c.font = Font(bold=True)

    ws.column_dimensions['A'].width = 14
    for col in 'BCDEFGH':
        ws.column_dimensions[col].width = 14
    ws.freeze_panes = 'A2'
    wb.save(path)


def draw_png(daily: pd.DataFrame, out_path: str) -> None:
    fp = find_chinese_font()
    if not fp:
        raise RuntimeError('未找到中文字体，无法生成图片')

    S = SCALE
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

    title = '分日退款率趋势（未分配 / 已分配 / 总）'
    bbox = draw.textbbox((0, 0), title, font=font_t)
    tw = bbox[2] - bbox[0]
    draw.text(((W - tw) // 2, S * 20), title, fill=(31, 78, 120), font=font_t)

    # 副标题：总体指标
    total_orders = int(daily['总订单数'].sum())
    total_un = int(daily['未分配退款数'].sum())
    total_al = int(daily['已分配退款数'].sum())
    total_ref = int(daily['总退款数'].sum())
    sub = (f'总体：未分配退款率 {total_un / total_orders * 100:.2f}%  ·  '
           f'已分配退款率 {total_al / total_orders * 100:.2f}%  ·  '
           f'总退款率 {total_ref / total_orders * 100:.2f}%')
    bbox = draw.textbbox((0, 0), sub, font=font_n)
    sw = bbox[2] - bbox[0]
    draw.text(((W - sw) // 2, S * 58), sub, fill=(80, 80, 80), font=font_n)

    chart_x0, chart_y0 = margin_l, margin_t
    chart_x1 = chart_x0 + chart_w
    chart_y1 = chart_y0 + chart_h

    # Y 轴自适应：取整十的下一个边界，刻度为 20% 的整数倍
    y_max_val = float(daily[['未分配退款率', '已分配退款率', '总退款率']].max().max())
    y_max = max(20.0, math.ceil(y_max_val * 1.2 / 20) * 20)
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

    n = len(daily)
    gap = chart_w / n

    def plot_line(col, color):
        pts = []
        for i in range(n):
            cx = chart_x0 + gap * (i + 0.5)
            val = float(daily.iloc[i][col])
            cy = chart_y1 - (val / y_max) * chart_h
            pts.append((cx, cy))
        for i in range(len(pts) - 1):
            draw.line([pts[i], pts[i + 1]], fill=color, width=S * 3)
        for p in pts:
            draw.ellipse([p[0] - S * 5, p[1] - S * 5, p[0] + S * 5, p[1] + S * 5],
                         fill=color, outline=(255, 255, 255), width=S * 2)
        return pts

    lines = [
        ('未分配退款率', C_UNALLOC, '未分配退款率'),
        ('已分配退款率', C_ALLOC, '已分配退款率'),
        ('总退款率', C_TOTAL, '总退款率'),
    ]
    for col, color, _ in lines:
        plot_line(col, color)

    # X 轴日期
    for i in range(n):
        cx = chart_x0 + gap * (i + 0.5)
        d_label = daily.iloc[i]['下单日期'].strftime('%m-%d')
        bbox = draw.textbbox((0, 0), d_label, font=font_s)
        lw = bbox[2] - bbox[0]
        draw.text((cx - lw / 2, chart_y1 + S * 10), d_label, fill=(0, 0, 0), font=font_s)

    # 图例
    lx, ly = margin_l, H - S * 55
    for col, color, label in lines:
        draw.line([(lx, ly + S * 6), (lx + S * 30, ly + S * 6)], fill=color, width=S * 3)
        draw.ellipse([lx + S * 10, ly + S * 1, lx + S * 20, ly + S * 11], fill=color, outline=(255, 255, 255))
        bbox = draw.textbbox((0, 0), label, font=font_n)
        draw.text((lx + S * 40, ly - S * 2), label, fill=(0, 0, 0), font=font_n)
        lx += S * 230

    img.save(out_path)
    print(f'  ✓ PNG: {out_path}（{W}×{H}）')


CH_HEADERS = ['渠道', '下单日期', '总订单数', '未分配退款数', '未分配退款率',
              '已分配退款数', '已分配退款率', '总退款数', '总退款率']


def write_channel_parts(path: str, df: pd.DataFrame, daily: pd.DataFrame) -> str:
    """分渠道分日退款率：学段汇总行 + 逐渠道明细 sheet，另出各学段汇总总退款率折线图"""
    rows_raw, dates = channel_daily_rows(df, [('未分配退款数', '未分配退款'),
                                              ('已分配退款数', '已分配退款'),
                                              ('总退款数', '是否退款')])

    def fmt(rr):
        o = rr['总订单数']
        return [rr['渠道'], rr['下单日期'].strftime('%Y-%m-%d'), o,
                rr['未分配退款数'], f'{rr["未分配退款数"] / o * 100:.2f}%',
                rr['已分配退款数'], f'{rr["已分配退款数"] / o * 100:.2f}%',
                rr['总退款数'], f'{rr["总退款数"] / o * 100:.2f}%']

    rows = [fmt(r) for r in rows_raw]
    o = int(df['订单编号'].nunique())
    un = int(df[df['未分配退款']]['订单编号'].nunique())
    al = int(df[df['已分配退款']]['订单编号'].nunique())
    rf = int(df[df['是否退款']]['订单编号'].nunique())
    total = ['合计', '-', o, un, f'{un / o * 100:.2f}%', al, f'{al / o * 100:.2f}%',
             rf, f'{rf / o * 100:.2f}%']
    write_channel_sheet(path, SHEET_CH, CH_HEADERS, rows, total)
    print(f'  ✓ 工作表: {SHEET_CH}（{len(rows)} 行）')

    # PNG：各学段汇总的总退款率折线 + 全部参考线
    sum_rows = [r for r in rows_raw if r['汇总']]
    series = []
    for i, label in enumerate(dict.fromkeys(r['渠道'] for r in sum_rows)):
        m = {r['下单日期']: r for r in sum_rows if r['渠道'] == label}
        vals = [m[dt]['总退款数'] / m[dt]['总订单数'] * 100 if dt in m else None for dt in dates]
        series.append((label, PALETTE[i % len(PALETTE)], vals))
    om = dict(zip(daily['下单日期'], daily['总退款率']))
    series.append(('全部', (89, 89, 89), [om.get(dt) for dt in dates]))
    sub = (f'总体：未分配退款率 {un / o * 100:.2f}%  ·  '
           f'已分配退款率 {al / o * 100:.2f}%  ·  总退款率 {rf / o * 100:.2f}%')
    png_path = str(Path(path).with_name(Path(path).stem + '_分渠道分日退款率.png'))
    draw_channel_png(png_path, '分渠道分日退款率趋势（学段汇总 · 总退款率）', sub, dates, series)
    return png_path


def main():
    if len(sys.argv) < 2:
        print('用法: python3 refund_daily_rate.py <thin_excel_path>')
        sys.exit(1)

    path = sys.argv[1]
    if not os.path.exists(path):
        print(f'文件不存在: {path}')
        sys.exit(1)

    print(f'[1/3] 读取底表: {path}')
    df = load_df(path)
    daily = aggregate_daily(df)
    print(f'  → {len(daily)} 天')
    print(daily.to_string(index=False))

    print(f'[2/3] 写入工作表: {SHEET_OUT}')
    write_excel(path, daily)
    print('  ✓ 已保存')
    ch_png = write_channel_parts(path, df, daily)

    print('[3/3] 绘制趋势图')
    png_path = str(Path(path).with_name(Path(path).stem + '_分日退款率.png'))
    draw_png(daily, png_path)

    print('\n=== 分日退款率摘要 ===')
    for _, r in daily.iterrows():
        print(f'{r["下单日期"]}: 总订单 {int(r["总订单数"])} | '
              f'未分配 {r["未分配退款率"]:.2f}% | 已分配 {r["已分配退款率"]:.2f}% | '
              f'总退款率 {r["总退款率"]:.2f}%')


if __name__ == '__main__':
    main()
