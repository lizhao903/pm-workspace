# powered by dsh - https://github.com/deepseek-ai/deepseek-harness

# 生成 internal/plugins/trade/ta 的外部数值对照（testdata/mytt_golden.json）。
#
# MyTT（https://github.com/mpquant/MyTT）是 GPL 许可，本仓库不带它的源码：这个脚本在仓库外的独立环境里运行，
# 从命令行给的路径加载 MyTT.py，只把它算出的数值写进对照文件。Go 的实现按通达信公开的公式独立写成，未使用 MyTT 源码。
#
# 用法（独立 venv，装 numpy、pandas；不要在 MyTT 目录里运行）：
#   python -I gen-mytt-golden.py /path/to/MyTT.py internal/plugins/trade/testdata/backtest_golden.json out.json
#
# MyTT 的部分指标把结果四舍五入到 3 位（RD），对照时换成不舍入，按 1e-4 比。

import importlib.util
import json
import math
import sys

import numpy as np


def load_mytt(path):
    spec = importlib.util.spec_from_file_location("mytt_ext", path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    m.RD = lambda n, d=3: n  # 不舍入
    return m


def clean(xs):
    out = []
    for x in np.asarray(xs, dtype=float):
        out.append(None if math.isnan(x) or math.isinf(x) else float("%.12g" % x))  # 12 位有效数字，够 1e-4 比对
    return out


def main():
    mytt_path, golden_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
    T = load_mytt(mytt_path)
    g = json.load(open(golden_path))
    series = {}
    for key in ["BINANCE:ETHUSDT|1h", "SSE:510300|1h"]:
        bars = g["bars"][key]
        series[key] = bars
    cases = []
    inputs_all = {}
    for key, bars in series.items():
        O = np.array([b["o"] for b in bars], dtype=float)
        H = np.array([b["h"] for b in bars], dtype=float)
        L = np.array([b["l"] for b in bars], dtype=float)
        C = np.array([b["c"] for b in bars], dtype=float)
        V = np.array([b["v"] for b in bars], dtype=float)
        UP = (C > O)
        MA5 = T.MA(C, 5)
        MA10 = T.MA(C, 10)
        A = np.clip(np.abs(C - MA10) / MA10 * 5, 0.01, 0.99)  # DMA 的序列平滑因子，前 9 根是 NaN
        inp = {"O": O, "H": H, "L": L, "C": C, "V": V, "UP": UP.astype(float), "MA5": MA5, "MA10": MA10, "A": A}
        inputs_all[key] = {k: clean(v) for k, v in inp.items()}

        def add(name, args, res):
            if not isinstance(res, tuple):
                res = (res,)
            cases.append({"input": key, "fn": name, "args": args, "out": [clean(np.asarray(r, dtype=float)) for r in res]})

        # 工具函数
        add("REF", ["C", 3], T.REF(C, 3))
        add("DIFF", ["C", 2], T.DIFF(C, 2))
        add("STDP", ["C", 20], T.STD(C, 20))  # MyTT 的 STD 是总体标准差（ddof=0），对通达信的 STDP
        add("SUM", ["V", 10], T.SUM(V, 10))
        add("SUM", ["V", 0], T.SUM(V, 0))
        add("HHV", ["H", 9], T.HHV(H, 9))
        add("LLV", ["L", 9], T.LLV(L, 9))
        add("HHVBARS", ["H", 9], T.HHVBARS(H, 9))
        add("LLVBARS", ["L", 9], T.LLVBARS(L, 9))
        add("MA", ["C", 20], T.MA(C, 20))
        add("EMA", ["C", 12], T.EMA(C, 12))
        add("SMA", ["C", 9, 1], T.SMA(C, 9, 1))
        add("SMA", ["C", 7, 2], T.SMA(C, 7, 2))
        add("WMA", ["C", 10], T.WMA(C, 10))
        add("DMA", ["C", 0.2], T.DMA(C, 0.2))
        add("DMA", ["C", "A"], T.DMA(C, A.copy()))
        add("AVEDEV", ["C", 14], T.AVEDEV(C, 14))
        add("SLOPE", ["C", 10], T.SLOPE(C, 10))
        add("FORCAST", ["C", 10], T.FORCAST(C, 10))
        add("LAST", ["UP", 4, 1], T.LAST(UP, 4, 1))
        add("COUNT", ["UP", 10], T.COUNT(UP, 10))
        add("EVERY", ["UP", 3], T.EVERY(UP, 3))
        add("EXIST", ["UP", 5], T.EXIST(UP, 5))
        add("FILTER", ["UP", 3], T.FILTER(UP.copy(), 3))
        add("BARSLAST", ["UP"], T.BARSLAST(UP))
        add("BARSLASTCOUNT", ["UP"], T.BARSLASTCOUNT(UP))
        add("BARSSINCEN", ["UP", 10], T.BARSSINCEN(UP, 10))
        add("CROSS", ["MA5", "MA10"], T.CROSS(MA5, MA10))
        add("LONGCROSS", ["MA5", "MA10", 3], T.LONGCROSS(MA5, MA10, 3))
        add("VALUEWHEN", ["UP", "C"], T.VALUEWHEN(UP, C))
        add("BETWEEN", ["C", "MA5", "MA10"], T.BETWEEN(C, MA5, MA10))
        add("TOPRANGE", ["H"], T.TOPRANGE(H))
        add("LOWRANGE", ["L"], T.LOWRANGE(L))

        # 指标
        add("MACD", [12, 26, 9], T.MACD(C, 12, 26, 9))
        add("KDJ", [9, 3, 3], T.KDJ(C, H, L, 9, 3, 3))
        add("RSI", [6], T.RSI(C, 6))
        add("RSI", [14], T.RSI(C, 14))
        add("WR", [10, 6], T.WR(C, H, L, 10, 6))
        add("BIAS", [6, 12, 24], T.BIAS(C, 6, 12, 24))
        add("BOLL", [20, 2], T.BOLL(C, 20, 2))
        add("PSY", [12, 6], T.PSY(C, 12, 6))
        add("CCI", [14], T.CCI(C, H, L, 14))
        add("ATR", [14], T.ATR(C, H, L, 14))
        add("BBI", [3, 6, 12, 20], T.BBI(C, 3, 6, 12, 20))
        add("DMI", [14, 6], T.DMI(C, H, L, 14, 6))
        add("TAQ", [20], T.TAQ(H, L, 20))
        add("KTN", [20, 10], T.KTN(C, H, L, 20, 10))
        add("TRIX", [12, 20], T.TRIX(C, 12, 20))
        add("VR", [26], T.VR(C, V, 26))
        add("CR_HLC3", [20], T.CR(C, H, L, 20))  # MyTT 的 CR 中间价用 (H+L+C)/3，通达信用 (H+L)/2，只对 crWith 的这一口径
        add("EMV", [14, 9], T.EMV(H, L, V, 14, 9))
        add("DPO", [20, 6], T.DPO(C, 20, 11, 6))  # 通达信 DPO 往前错 N/2+1 根
        add("BRAR", [26], T.BRAR(O, C, H, L, 26))
        add("DFMA", [10, 50, 10], T.DFMA(C, 10, 50, 10))
        add("MTM", [12, 6], T.MTM(C, 12, 6))
        add("MASS", [9, 25, 6], T.MASS(H, L, 9, 25, 6))
        add("ROC", [12, 6], T.ROC(C, 12, 6))
        add("EXPMA", [12, 50], T.EXPMA(C, 12, 50))
        add("OBV", [], T.OBV(C, V))  # MyTT 除以 10000，对照时乘回
        add("MFI", [14], T.MFI(C, H, L, V, 14))
        add("ASI", [26, 10], T.ASI(O, C, H, L, 26, 10))
        add("XSII", [102, 7], T.XSII(C, H, L, 102, 7))

    out = {
        "note": "MyTT（GPL，未随仓库分发）在仓库外算出的数值对照；输入取自 backtest_golden.json 的两段 K 线。由 gen-mytt-golden.py 生成，不要手改。",
        "inputs": inputs_all,
        "cases": cases,
    }
    with open(out_path, "w") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))


if __name__ == "__main__":
    main()
