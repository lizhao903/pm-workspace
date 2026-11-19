# powered by dsh - https://github.com/deepseek-ai/deepseek-harness

# 生成内置策略（TRD-09）和 autotrader 的信号对照（testdata/autotrader_golden.json）。
#
# autotrader 是用户自己的私有量化项目（Python）。这个脚本在仓库外的独立环境里运行，只读打开它的 klines.db，
# 用它自己的指标函数（script/utils/MyTT.py 的 KDJ、script/strategy/strategy_supertrend_adx_1h3m.py 的 supertrend、adx，
# 都是纯计算，按文件路径加载）和逐行转写的信号条件算出每根 3m 的买卖信号，只把 K 线和信号下标写进对照文件。
# 不 import autotrader 的行情、下单、配置模块，不连交易所。
#
# 用法（独立 venv，装 numpy、pandas；不要在 autotrader 目录里运行；-B 不写字节码）：
#   python -I -B gen-autotrader-golden.py /path/to/autotrader internal/plugins/trade/testdata/autotrader_golden.json
#
# 三组对照：
#   kdj_adapter：autotrader 回测引擎（script/backtest/engine.py + adapters/kdj_short_1h3m.py）的口径：
#     1h 取开盘时间 <= 3m 开盘时间的那根整根（含之后的数据）、买点不要求 3m J 拐头、卖点要求 1h 超买拐头向下；
#   kdj_live：实盘 compute_signals 的口径：1h 用已收盘的加上「当前这根截至这根 3m」的部分、买点要 J 拐头、卖点不要 1h；
#   supertrend：backtest_supertrend_adx_1h3m._compute_signals（1h 只用已收盘的），period 14、mult 3.5、ADX 14、阈值 20。

import importlib.util
import json
import sqlite3
import sys

sys.dont_write_bytecode = True  # 按路径加载 autotrader 的模块时不在它的目录里写 __pycache__
from datetime import datetime, timezone

import numpy as np
import pandas as pd

SYMBOL, START, END = "BTCUSDT", "2024-06-01", "2024-06-07"
OS, OB = 20, 78
H1, M3 = 3600_000, 180_000


def load_file(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def ms(d):
    return int(datetime.strptime(d, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp() * 1000)


def load(db, iv):
    # immutable=1：库是 WAL 模式，只读打开也会在旁边建 -wal、-shm；声明不可变就不建
    con = sqlite3.connect("file:" + db + "?mode=ro&immutable=1", uri=True)
    rows = con.execute(
        "select open_time, open, high, low, close, volume from kline where symbol=? and interval=? and open_time>=? and open_time<? order by open_time",
        (SYMBOL, iv, ms(START), ms(END))).fetchall()
    con.close()
    return rows


def kdj(mytt, rows):
    h = np.array([r[2] for r in rows], float)
    l = np.array([r[3] for r in rows], float)
    c = np.array([r[4] for r in rows], float)
    K, D, J = mytt.KDJ(c, h, l, N=9, M1=3, M2=3)
    return np.round(K, 2), np.round(D, 2), np.round(J, 2)


def kdj_eval(K3, D3, J3, i, k3, J1, need_turn, need_trend):
    """同 strategy_kdj_short_1h3m.compute_signals 的单根判断；J1 是 1h 的 J 序列，最后一个是「当前」。"""
    nan = np.isnan
    j3, j1 = J3[i], J1[-1]
    if nan(j3) or nan(j1) or len(J1) < 20 or i + 1 < 20:
        return False, False
    a, b = (J1[-2], J1[-1]) if len(J1) >= 2 else (None, None)
    up = True if a is None else (not nan(a) and not nan(b) and (b >= a or b < 15))
    dn = True if a is None else (not nan(a) and not nan(b) and (b <= a or b > 85))
    t_buy, t_sell = j1 < OS and up, j1 > OB and dn

    def cross(up_):
        a0, b0, a1, b1 = J3[i - 1], D3[i - 1], J3[i], D3[i]
        if nan(a0) or nan(b0) or nan(a1) or nan(b1):
            return False
        return (a0 <= b0 and a1 > b1) if up_ else (a0 >= b0 and a1 < b1)

    def recent(f):
        return any(not nan(J3[k]) and f(J3[k]) for k in range(max(0, i - 6), i + 1))

    k_ok = not nan(K3[i]) and K3[i] >= D3[i]
    buy3 = (j3 < OS and (cross(True) or k_ok)) or (recent(lambda v: v < OS) and k_ok and j3 < 58 and cross(True))
    if need_turn:
        buy3 = buy3 and (not nan(J3[i - 1]) and J3[i] > J3[i - 1])
    k_sell = not nan(K3[i]) and K3[i] <= D3[i]
    sell3 = (j3 > OB and (cross(False) or k_sell)) or (recent(lambda v: v > OB) and k_sell and j3 > 42)
    candle = k3[i][4] > k3[i - 1][4]
    buy = t_buy and buy3 and candle
    sell = sell3 and (t_sell if need_trend else True)
    return bool(buy), bool(sell)


def main():
    root, out = sys.argv[1], sys.argv[2]
    db = root + "/klines.db"
    mytt = load_file("mytt_ext", root + "/script/utils/MyTT.py")
    stm = load_file("st_ext", root + "/script/strategy/strategy_supertrend_adx_1h3m.py")
    k3, k1 = load(db, "3m"), load(db, "1h")

    # 3m 聚成 1h 要和库里的 1h 一样（Go 那边只取 3m、自己聚合）
    agg = {}
    for r in k3:
        g = r[0] // H1 * H1
        if g not in agg:
            agg[g] = [g, r[1], r[2], r[3], r[4], r[5]]
        else:
            a = agg[g]
            a[2], a[3], a[4], a[5] = max(a[2], r[2]), min(a[3], r[3]), r[4], a[5] + r[5]
    for r in k1:
        a = agg[r[0]]
        assert abs(a[2] - r[2]) < 1e-9 and abs(a[3] - r[3]) < 1e-9 and abs(a[4] - r[4]) < 1e-9, (r, a)

    K3, D3, J3 = kdj(mytt, k3)
    K1, D1, J1 = kdj(mytt, k1)
    t1 = [r[0] for r in k1]
    res = {"kdj_adapter": ([], []), "kdj_live": ([], [])}
    ptr = -1
    for i, b in enumerate(k3):
        if i < 1:
            continue
        while ptr + 1 < len(k1) and k1[ptr + 1][0] <= b[0]:
            ptr += 1
        if ptr >= 0:
            by, sl = kdj_eval(K3, D3, J3, i, k3, J1[: ptr + 1], False, True)
            if by:
                res["kdj_adapter"][0].append(i)
            if sl:
                res["kdj_adapter"][1].append(i)
        # 实盘：已收盘的 1h + 当前这根截至 i
        g = b[0] // H1 * H1
        closed = [r for r in k1 if r[0] < g]
        part = [r for r in k3[: i + 1] if r[0] >= g]
        bundle = closed + [[g, part[0][1], max(r[2] for r in part), min(r[3] for r in part), part[-1][4], 0]]
        if len(bundle) >= 20:
            _, _, Jp = kdj(mytt, bundle)
            by, sl = kdj_eval(K3, D3, J3, i, k3, Jp, True, False)
            if by:
                res["kdj_live"][0].append(i)
            if sl:
                res["kdj_live"][1].append(i)

    h3 = np.array([r[2] for r in k3], float)
    l3 = np.array([r[3] for r in k3], float)
    c3 = np.array([r[4] for r in k3], float)
    tr3, _ = stm.supertrend(h3, l3, c3, period=14, mult=3.5)
    adx3, _, _ = stm.adx(h3, l3, c3, N=14)
    tr1, _ = stm.supertrend(np.array([r[2] for r in k1], float), np.array([r[3] for r in k1], float),
                            np.array([r[4] for r in k1], float), period=14, mult=3.5)
    sb, ss = [], []
    for i in range(36, len(k3)):
        j = int(np.searchsorted(t1, k3[i][0] + M3 - H1 + 1, side="right")) - 1
        j = max(0, min(j, len(t1) - 1))
        if stm.trend_up(tr1, j) and stm.trend_flip_up(tr3, i) and stm.adx_strong(adx3, i, threshold=20):
            sb.append(i)
        if stm.trend_flip_down(tr3, i):
            ss.append(i)

    tail = [{"i": i, "k": float(K3[i]), "d": float(D3[i]), "j": float(J3[i])} for i in range(len(k3) - 5, len(k3))]
    doc = {
        "source": "autotrader klines.db " + SYMBOL + " 3m " + START + " 到 " + END + "（左闭右开）",
        "bars": [[r[0], r[1], r[2], r[3], r[4], r[5]] for r in k3],
        "kdj_tail": tail,
        "kdj_adapter": {"buy": res["kdj_adapter"][0], "sell": res["kdj_adapter"][1]},
        "kdj_live": {"buy": res["kdj_live"][0], "sell": res["kdj_live"][1]},
        "supertrend": {"buy": sb, "sell": ss},
    }
    with open(out, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    print({k: (len(v["buy"]), len(v["sell"])) for k, v in doc.items() if isinstance(v, dict)})


if __name__ == "__main__":
    main()
