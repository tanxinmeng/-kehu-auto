# -*- coding: utf-8 -*-
"""退款率分析一键编排：加渠道的哆啦导出表 → 全套退款率分析产物。

输入必须是「加完渠道的哆啦导出表」（先在渠道库用渠道匹配补「渠道」列，
未匹配行手动补齐后上传）。本脚本不做渠道匹配。

流程（复用退款 skill 脚本）：
  1. 校验哆啦表已含「渠道」「是否分配」两列
  2. preprocess.py 预处理（付款过滤 + 是否分配加工 + 渠道过滤 → 薄表）
  3. 按所选分析类型依次跑 5 个分析脚本（3.5 需 --service-period，喂 stdin 防阻塞）

输出 JSON（stdout 最后一行 __REFUND_JSON__...）：
  ok / steps / files[...] / error

所有产物集中在 --outdir（服务端按时间戳建目录），含：
  <原名>_thin.xlsx（薄表+各分析 sheet）、各分析 PNG
"""
import sys, os, json, subprocess, glob
from pathlib import Path

import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))  # kehu-auto/src（脚本与渠道库都在这里，分析脚本在 refund/ 子目录）

ANALYSIS_SCRIPTS = {
    "3.1": "refund_summary.py",
    "3.2": "refund_daily_rate.py",
    "3.3": "refund_daily_6h.py",
    "3.4": "refund_daily_6h_unallocated.py",
    "3.5": "refund_channel_summary.py",
}

def emit(obj):
    print("__REFUND_JSON__" + json.dumps(obj, ensure_ascii=False))

def run_py(script, args, stdin_text=None, timeout=300):
    p = subprocess.run(
        [sys.executable, script] + args,
        cwd=HERE, capture_output=True, text=True, encoding="utf-8", errors="replace",
        input=(stdin_text if stdin_text is not None else ""),
        timeout=timeout,
    )
    return p.returncode, (p.stdout or ""), (p.stderr or "")

def main():
    ap_args = sys.argv[1:]
    def arg(name, default=None):
        if name in ap_args:
            i = ap_args.index(name)
            return ap_args[i + 1] if i + 1 < len(ap_args) else default
        return default

    duola = arg("--duola")
    analyses = [a.strip() for a in (arg("--analyses") or "").split(",") if a.strip() in ANALYSIS_SCRIPTS]
    service_period = arg("--service-period")
    channels = arg("--channels")
    keep_allocated = arg("--keep-allocated")
    outdir = arg("--outdir")

    steps = []
    def step(name, ok, detail=""):
        steps.append({"step": name, "ok": bool(ok), "detail": str(detail)[:300]})
        print(f"[{name}] {'OK' if ok else 'FAIL'} {detail}", flush=True)
        return ok

    if not duola or not os.path.exists(duola):
        emit({"ok": False, "error": f"哆啦导出表不存在: {duola}", "steps": steps})
        return
    if not analyses:
        emit({"ok": False, "error": "未选择任何分析类型", "steps": steps})
        return
    if "3.5" in analyses and not (service_period or "").strip():
        emit({"ok": False, "error": "渠道汇总退款率(3.5)需要填写服务期", "steps": steps})
        return

    try:
        # ---- 1. 校验已含「渠道」列（本脚本不做渠道匹配） ----
        head = pd.read_excel(duola, sheet_name=0, nrows=5)
        if not any(str(c).strip() == "渠道" for c in head.columns):
            emit({"ok": False,
                  "error": "哆啦表缺少「渠道」列：请先在「渠道库 → Excel 渠道匹配」补列，把未匹配行手动补齐后再上传",
                  "steps": steps})
            return
        matched_file = duola
        step("渠道列检查", True, "已含「渠道」列")

        # ---- 2. 预处理（付款过滤 + 是否分配加工 + 渠道过滤 → 薄表） ----
        # sheet 名：优先「退款」，否则第一个
        wb = pd.ExcelFile(matched_file)
        sheet = "退款" if "退款" in wb.sheet_names else wb.sheet_names[0]
        wb.close()

        pa = [matched_file, "--sheet", sheet, "--out", os.path.join(outdir, Path(duola).stem + "_thin.xlsx")]
        # 是否分配「已分配」侧唯一值检测：多个值必须由用户指定，避免交互阻塞
        raw = pd.read_excel(matched_file, sheet_name=sheet)
        alloc_col = next((c for c in raw.columns if str(c).strip() == "是否分配"), None)
        pay_col = next((c for c in raw.columns if str(c).strip() == "付款时间"), None)
        if alloc_col is None:
            emit({"ok": False,
                  "error": "哆啦表缺少「是否分配」列：请先在「渠道库 → ② 匹配已分配」用已分配底表加列（并手动补齐渠道）后再上传",
                  "steps": steps})
            return
        vals = []
        for v in raw[alloc_col].dropna():
            s = str(v).strip()
            if s and s.upper() not in ("#N/A", "N/A", "NA", "#NA", "#VALUE!", "#REF!") and s not in vals:
                vals.append(s)
        if len(vals) > 1 and not keep_allocated:
            emit({"ok": False, "needKeepAllocated": True,
                  "error": f"「是否分配」列出现多个已分配值: {vals}，请在「已分配保留值」里填一个再跑",
                  "steps": steps})
            return
        if len(vals) == 1:
            keep_allocated = vals[0]
        if keep_allocated:
            pa += ["--keep-allocated", str(keep_allocated)]
        if pay_col is None:
            emit({"ok": False, "error": "哆啦导出表缺少「付款时间」列（预过滤需要），实际列: " + ", ".join(str(c) for c in raw.columns), "steps": steps})
            return
        # 渠道过滤：未指定时显式传全部渠道，避免脚本交互询问；渠道 W 始终排除，不参与 5 项分析
        all_ch = [c.strip() for c in channels.split(",") if c.strip()] if channels else []
        if not all_ch and "渠道" in raw.columns:
            all_ch = sorted(set(str(x).strip() for x in raw["渠道"].dropna() if str(x).strip()))
        excluded_w = [c for c in all_ch if c.upper() == "W"]
        all_ch = [c for c in all_ch if c.upper() != "W"]
        if excluded_w:
            print(f"[渠道过滤] 排除渠道 W（不参与分析）: {excluded_w}", flush=True)
        if all_ch:
            pa += ["--channels", ",".join(all_ch)]

        rc, out, err = run_py(os.path.join(HERE, "refund", "preprocess.py"), pa, timeout=300)
        thin = pa[pa.index("--out") + 1]
        if rc != 0 or not os.path.exists(thin):
            emit({"ok": False, "error": "预处理失败: " + (err.splitlines()[-1] if err.strip() else out.splitlines()[-1] if out.strip() else "未知错误"), "steps": steps})
            return
        step("预处理", True, f"薄表 {os.path.basename(thin)}（{sheet}）")

        # ---- 3. 依次跑所选分析 ----
        files = [thin]
        for a in analyses:
            script = os.path.join(HERE, "refund", ANALYSIS_SCRIPTS[a])
            aa = [thin]
            stdin_text = ""
            if a == "3.5":
                aa += ["--service-period", str(service_period)]
                stdin_text = "\n"  # 脚本内部会 input() 二次确认，必须喂回车
            rc, out, err = run_py(script, aa, stdin_text=stdin_text, timeout=300)
            if rc != 0:
                emit({"ok": False, "error": f"分析 {a} 失败: " + (err.splitlines()[-1] if err.strip() else out.splitlines()[-1] if out.strip() else "exit " + str(rc)), "steps": steps, "files": files})
                return
            step(f"分析 {a}", True, "")
            stem = Path(thin).stem
            if a == "3.1":
                files += glob.glob(os.path.join(outdir, stem + "_未分配时段占比图.png"))
            elif a == "3.2":
                files += glob.glob(os.path.join(outdir, stem + "_分日退款率.png"))
                files += glob.glob(os.path.join(outdir, stem + "_分渠道分日退款率.png"))
            elif a == "3.3":
                files += glob.glob(os.path.join(outdir, stem + "_分日6h内退款率.png"))
                files += glob.glob(os.path.join(outdir, stem + "_分渠道分日6h内退款率.png"))
            elif a == "3.4":
                files += glob.glob(os.path.join(outdir, stem + "_分日6h内未分配退款率.png"))
                files += glob.glob(os.path.join(outdir, stem + "_分渠道分日6h内未分配退款率.png"))
            elif a == "3.5":
                files += glob.glob(os.path.join(outdir, stem + "_渠道汇总退款率.png"))

        emit({"ok": True, "steps": steps, "files": [os.path.abspath(f) for f in files],
              "thin": os.path.abspath(thin)})
    except Exception as e:
        emit({"ok": False, "error": f"{type(e).__name__}: {e}", "steps": steps})

if __name__ == "__main__":
    main()
