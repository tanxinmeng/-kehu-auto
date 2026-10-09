#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
原始退款底表预处理脚本
=====================================================================
用途：把钉钉导出的「多字段原始底表」瘦身成 refund_summary.py 能吃的 5 列表。

原始底表字段较多（示例 37 列，含店铺名称/达人ID/手机号/地址等无关列），
本脚本负责：

  1. 提取必要列：订单编号 / 渠道 / 下单时间 / 退款时间 / 是否分配 / 付款时间
  2. 仅保留已付款订单：付款时间非空才进入后续计算
  3. 加工「是否分配」列：
       - 有具体数值/文本 → 「已分配」
       - #N/A（空 / 错误值）→ 「未分配」
       - 若「已分配」侧出现多个不同值 → 必须确认保留哪个（否则报错退出）
         （其余数值的明细是多余的，不是计算目标）
  4. 渠道过滤：只保留用户指定的渠道
  5. 输出瘦身表（另存，不覆盖原表）

用法：
  python3 preprocess.py <原始底表.xlsx> \
      --keep-allocated 20260911 \
      --channels 初中数学-99,初中数学-199,初中数学-49 \
      --sheet 退款 \
      --out <输出路径>

  不传 --keep-allocated / --channels 时交互式询问。

依赖：pandas openpyxl
"""

import sys
import os
import argparse
from pathlib import Path

import pandas as pd

# ============== 可调参数（默认值） ==============
SHEET_NAME = '退款'          # 默认读取的工作表
OUT_SUFFIX = '_thin'         # 瘦身表文件名后缀（原名 + _thin.xlsx）

# 需要保留/映射的列名（原始底表中的实际列名）
COL_ORDER_ID = '订单编号'
COL_CHANNEL  = '渠道'
COL_ORDER_TM = '下单时间'
COL_REFUND_TM = '退款时间'
COL_ALLOC    = '是否分配'
COL_PAY_TM   = '付款时间'     # 用于过滤未付款订单（未付款不算总订单）

OUT_COLUMNS = [COL_ORDER_ID, COL_CHANNEL, COL_ORDER_TM, COL_REFUND_TM, COL_ALLOC]

# 「已分配 / 未分配」的加工结果标签
ALLOCATED   = '已分配'
UNALLOCATED = '未分配'


# ============== 工具函数 ==============
def is_na(v) -> bool:
    """判断单元格是否属于「未分配」的 #N/A 形态（空 / NaN / #N/A 文本 / 空白）。"""
    if v is None:
        return True
    try:
        if isinstance(v, float) and pd.isna(v):
            return True
    except (TypeError, ValueError):
        pass
    if isinstance(v, str):
        s = v.strip().upper()
        if s in ('#N/A', 'N/A', 'NA', '#NA', '#VALUE!', '#REF!', ''):
            return True
    return False


def norm_value(v):
    """把单元格值规范成可比较的字符串（用于「已分配」多值去重比较）。

    20260911.0 -> '20260911'；文本原样 strip；#N/A -> None。
    """
    if is_na(v):
        return None
    if isinstance(v, float):
        if v.is_integer():
            return str(int(v))
        return str(v)
    return str(v).strip()


def read_raw(path: str, sheet: str) -> pd.DataFrame:
    """读原始底表并校验必要列。"""
    df = pd.read_excel(path, sheet_name=sheet)
    needed = [COL_ORDER_ID, COL_CHANNEL, COL_ORDER_TM, COL_REFUND_TM, COL_ALLOC, COL_PAY_TM]
    missing = [c for c in needed if c not in df.columns]
    if missing:
        raise ValueError(f'原始底表缺少必要列: {missing}\n'
                         f'实际列名: {list(df.columns)}')
    return df


def detect_alloc_values(df: pd.DataFrame):
    """返回「已分配」侧的非空唯一值列表（规范化后的字符串）。"""
    col = df[COL_ALLOC]
    vals = []
    for v in col.dropna():
        n = norm_value(v)
        if n is not None and n not in vals:
            vals.append(n)
    return vals


def choose_keep_allocated(candidates, keep_allocated):
    """确定保留哪个「已分配」值。

    - 只有一个值：直接返回该值。
    - 多个值 + 已指定 --keep-allocated：校验在候选内，返回。
    - 多个值 + 未指定：交互式询问。
    """
    if len(candidates) == 1:
        return candidates[0]

    if keep_allocated:
        k = norm_value(keep_allocated)
        if k not in candidates:
            print(f'[警告] --keep-allocated 指定的值 {k!r} 不在候选 {candidates} 中')
        return k

    # 多值且未指定 → 交互式询问
    print('\n' + '=' * 60)
    print('「是否分配」列出现多个不同值（已分配侧）：')
    for i, v in enumerate(candidates, 1):
        print(f'  [{i}] {v}')
    print('其余数值的明细是多余的，不是计算目标。')
    print('=' * 60)
    while True:
        ans = input('请选择要保留的值（输入序号或值本身）: ').strip()
        if ans in candidates:
            return ans
        if ans.isdigit() and 1 <= int(ans) <= len(candidates):
            return candidates[int(ans) - 1]
        print(f'  无效输入：{ans!r}，请重新输入。')


def choose_channels(all_channels, channels_arg):
    """确定保留哪些渠道。

    - 已指定 --channels：校验并返回。
    - 未指定：交互式多选（输入序号，逗号分隔）。
    """
    if channels_arg:
        want = [c.strip() for c in channels_arg.split(',') if c.strip()]
        bad = [c for c in want if c not in all_channels]
        if bad:
            print(f'[警告] --channels 指定了不存在的渠道: {bad}')
        return [c for c in want if c in all_channels]

    print('\n' + '=' * 60)
    print('原始底表中的渠道：')
    for i, c in enumerate(all_channels, 1):
        print(f'  [{i}] {c}')
    print('=' * 60)
    while True:
        ans = input('请输入要保留的渠道序号（逗号分隔，如 1,2,3）: ').strip()
        idxs = [x.strip() for x in ans.split(',') if x.strip()]
        if not idxs:
            continue
        picked = []
        ok = True
        for x in idxs:
            if x.isdigit() and 1 <= int(x) <= len(all_channels):
                picked.append(all_channels[int(x) - 1])
            else:
                print(f'  无效序号：{x!r}')
                ok = False
        if ok and picked:
            return picked


# ============== 主流程 ==============
def main():
    ap = argparse.ArgumentParser(description='原始退款底表预处理（瘦身成 5 列表）')
    ap.add_argument('excel', help='原始底表路径（.xlsx）')
    ap.add_argument('--sheet', default=SHEET_NAME, help=f'工作表名（默认 {SHEET_NAME}）')
    ap.add_argument('--keep-allocated', default=None,
                    help='「已分配」侧保留哪个值（多值时必填，如 20260911）')
    ap.add_argument('--channels', default=None,
                    help='保留的渠道，逗号分隔（如 初中数学-99,初中数学-199,初中数学-49）')
    ap.add_argument('--out', default=None, help='输出瘦身表路径（默认 <原名>_thin.xlsx）')
    args = ap.parse_args()

    path = args.excel
    if not os.path.exists(path):
        print(f'文件不存在: {path}')
        sys.exit(1)

    print(f'[1/5] 读取原始底表: {path}（工作表: {args.sheet}）')
    df = read_raw(path, args.sheet)
    print(f'  → 原始记录 {len(df)} 行')

    print('[2/5] 仅保留已付款订单（付款时间非空）')
    before_pay = len(df)
    df = df[df[COL_PAY_TM].notna()].copy()
    print(f'  → 已付款 {len(df)} 行，剔除未付款 {before_pay - len(df)} 行')

    print('[3/5] 加工「是否分配」列')
    alloc_values = detect_alloc_values(df)
    if not alloc_values:
        print('  ⚠ 未发现「已分配」侧的取值（是否分配列全部为 #N/A）')
        keep = None
    else:
        print(f'  → 「已分配」侧取值: {alloc_values}')
        keep = choose_keep_allocated(alloc_values, args.keep_allocated)
        print(f'  → 保留「已分配」值: {keep}，其余值明细将被剔除')
        # 剔除其余值
        df = df[df[COL_ALLOC].apply(
            lambda v: norm_value(v) == keep if not is_na(v) else False
        ) | df[COL_ALLOC].apply(is_na)]

    # 加工成 已分配/未分配 二值
    df = df.copy()
    df[COL_ALLOC] = df[COL_ALLOC].apply(lambda v: UNALLOCATED if is_na(v) else ALLOCATED)

    print('[4/5] 渠道过滤')
    all_channels = sorted(df[COL_CHANNEL].dropna().unique().tolist())
    print(f'  → 当前渠道: {all_channels}')
    channels = choose_channels(all_channels, args.channels)
    print(f'  → 保留渠道: {channels}')
    df = df[df[COL_CHANNEL].isin(channels)]

    # 只保留 5 列
    df = df[OUT_COLUMNS].copy()
    # 清洗时间列：钉钉导出可能混入 \t 制表符等首尾空白，导致下游 to_datetime 解析失败
    for _c in (COL_ORDER_TM, COL_REFUND_TM):
        df[_c] = df[_c].apply(lambda v: v.strip() if isinstance(v, str) else v)
    df = df.dropna(subset=[COL_ORDER_ID, COL_CHANNEL])  # 订单编号/渠道 必须非空
    print(f'  → 瘦身后记录 {len(df)} 行')

    out = args.out or str(Path(path).with_name(Path(path).stem + OUT_SUFFIX + '.xlsx'))
    print(f'[5/5] 输出瘦身表: {out}')
    df.to_excel(out, index=False, sheet_name='退款')
    print('  ✓ 已保存')

    # 打印摘要
    print('\n=== 预处理摘要 ===')
    print(df[COL_ALLOC].value_counts().to_string())
    print('\n渠道 × 是否分配 交叉:')
    print(pd.crosstab(df[COL_CHANNEL], df[COL_ALLOC]).to_string())


if __name__ == '__main__':
    main()
