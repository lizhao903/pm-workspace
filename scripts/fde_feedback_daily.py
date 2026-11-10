#!/usr/bin/env python3
# powered by dsh - https://github.com/deepseek-ai/deepseek-harness

"""TSK-0429：从 FDE 反馈表拉取全部行，归并成需求清单，和上一份比对后落盘。

数据源：Google Sheet 公开只读导出（CSV），不写表、不留原始快照。
产出：<out>/lists/YYYY-MM-DD.md、YYYY-MM-DD.json、latest.json。
失败：不写任何文件，退出码 2，stdout 打一行原因。只用 Python 标准库。

用法：
  scripts/fde_feedback_daily.py                 # 正常跑，今天
  scripts/fde_feedback_daily.py --date 2026-11-06
  scripts/fde_feedback_daily.py --out data/fde-feedback
"""
import argparse
import csv
import hashlib
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, date

SHEET_ID = "1f6DUdwuf7pJKKQ0HiquLKCFXZTO2e1POxmbWRMlsBWw"
GID = "1115809405"
EXPORT = f"https://docs.google.com/spreadsheets/d/{SHEET_ID}/export?format=csv&gid={GID}"
SHEET_URL = f"https://docs.google.com/spreadsheets/d/{SHEET_ID}/edit?gid={GID}#gid={GID}"

# 表头缺任何一列就判失败，不猜列的位置
REQUIRED_COLS = ["编号", "反馈时间", "反馈人", "模块", "反馈事项", "优先级", "状态"]
CLOSED_STATUS = {"已上线", "暂不处理"}
PRIO_ORDER = {"P0": 0, "P1": 1, "P2": 2, "P3": 3}
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_OUT = os.path.join(REPO, "data", "fde-feedback")


class Fail(Exception):
    """可预期失败：打一行原因，退出码 2，不写文件"""


def fetch_csv(timeout=30, attempts=3):
    local = os.environ.get("FDE_CSV_FILE")  # 离线复跑：直接读本地 CSV，跳过下载
    if local:
        try:
            with open(local, encoding="utf-8-sig") as f:
                return f.read()
        except OSError as e:
            raise Fail(f"读不到本地 CSV：{e}")
    last = ""
    for i in range(attempts):
        try:
            req = urllib.request.Request(EXPORT, headers={"User-Agent": "pmw-fde-daily/1"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
            text = raw.decode("utf-8-sig")
            if not text.strip():
                raise Fail("读不到表格：导出内容为空")
            return text
        except urllib.error.HTTPError as e:
            last = f"HTTP {e.code}"
            if e.code in (401, 403):
                raise Fail(f"读不到表格（{e.code}，没有访问权限），检查表格共享设置")
            if e.code == 404:
                raise Fail(f"读不到表格（404，表格或工作表不存在）：gid {GID}")
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            last = str(getattr(e, "reason", e))
        if i < attempts - 1:
            time.sleep(3 * (i + 1))
    raise Fail(f"读不到表格（网络失败，重试 {attempts} 次）：{last}")


def parse_rows(text):
    reader = csv.reader(io.StringIO(text))
    rows = list(reader)
    if not rows:
        raise Fail("表结构变了：导出没有表头行")
    header = [h.strip() for h in rows[0]]
    missing = [c for c in REQUIRED_COLS if c not in header]
    if missing:
        raise Fail("表结构变了：缺少列 " + "、".join(missing))
    idx = {h: i for i, h in enumerate(header) if h}
    skipped = 0
    records = []
    for n, r in enumerate(rows[1:], start=2):  # n 是 CSV 里的行号，表头是 1
        cells = [c.strip() for c in r]

        def cell(col):
            i = idx.get(col)
            return cells[i] if i is not None and i < len(cells) else ""

        if not any(cells):  # 整行为空
            skipped += 1
            continue
        if cell("编号") == "编号":  # 表头重复行
            skipped += 1
            continue
        if not cell("反馈事项"):  # 没有反馈内容，无从归并
            skipped += 1
            continue
        records.append({
            "line": n,
            "no": cell("编号"),
            "at": cell("反馈时间"),
            "by": cell("反馈人"),
            "module": cell("模块"),
            "content": cell("反馈事项"),
            "kind": cell("反馈类型"),
            "prio": cell("优先级").upper() if cell("优先级") else "",
            "owner": cell("负责人"),
            "dev": cell("开发"),
            "jira": cell("Jira 号"),
            "status": cell("状态"),
            "release": cell("上线时间"),
            "doc": cell("需求文档"),
            "memo": cell("备注"),
        })
    return records, skipped


def norm_date(s):
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%Y.%m.%d", "%Y年%m月%d日"):
        try:
            return datetime.strptime(s.strip(), fmt).date().isoformat()
        except ValueError:
            continue
    return s.strip()


def first_sentence(text, limit=50):
    s = " ".join(text.split())
    for sep in ("。", "！", "？", "\n"):
        i = s.find(sep)
        if 0 < i <= limit:
            return s[: i + 1]
    return s[:limit] + ("…" if len(s) > limit else "")


def severity(prios):
    known = sorted({p for p in prios if p in PRIO_ORDER}, key=lambda p: PRIO_ORDER[p])
    if known:
        return known[0]
    return sorted({p for p in prios if p})[0] if any(prios) else ""


def group(records):
    """一条需求 = 一个编号下的全部反馈行；编号缺失的按反馈事项单独成条"""
    buckets = {}
    order = []
    for r in records:
        key = r["no"] or "TXT-" + hashlib.sha1(r["content"].encode("utf-8")).hexdigest()[:8]
        if key not in buckets:
            buckets[key] = []
            order.append(key)
        buckets[key].append(r)

    reqs = []
    for key in order:
        rows = sorted(buckets[key], key=lambda x: x["line"])
        texts = [x["content"] for x in rows]
        dig = hashlib.sha1("\n".join(texts).encode("utf-8")).hexdigest()[:12]
        dates = [norm_date(x["at"]) for x in rows if x["at"]]
        statuses = sorted({x["status"] for x in rows if x["status"]})
        reqs.append({
            "id": key,
            "title": first_sentence(rows[0]["content"]),
            "module": sorted({x["module"] for x in rows if x["module"]})[0] if any(x["module"] for x in rows) else "",
            "summary": " ".join(texts[0].split()),
            "reporters": sorted({x["by"] for x in rows if x["by"]}),
            "feedback_types": sorted({x["kind"] for x in rows if x["kind"]}),
            "source_rows": [x["line"] for x in rows],
            "mentions": len(rows),
            "first_seen": min(dates) if dates else "",
            "last_seen": max(dates) if dates else "",
            "severity": severity([x["prio"] for x in rows]),
            "status": statuses,
            "owner": next((x["owner"] for x in rows if x["owner"]), ""),
            "jira": next((x["jira"] for x in rows if x["jira"]), ""),
            "released_at": next((norm_date(x["release"]) for x in rows if x["release"]), ""),
            "text_digest": dig,
            "uncertain_merge": False,
        })
    return reqs


def mark_changes(reqs, prev):
    prev_map = {r["id"]: r for r in prev.get("requirements", [])} if prev else {}
    counts = {"new": 0, "updated": 0, "closed": 0, "unchanged": 0}
    for r in reqs:
        old = prev_map.get(r["id"])
        if not old:
            r["change"] = "new"
        else:
            now_closed = bool(r["status"]) and all(s in CLOSED_STATUS for s in r["status"])
            was_closed = bool(old.get("status")) and all(s in CLOSED_STATUS for s in old["status"])
            if now_closed and not was_closed:
                r["change"] = "closed"
            elif r["mentions"] > old.get("mentions", 0) or r["text_digest"] != old.get("text_digest"):
                r["change"] = "updated"
            else:
                r["change"] = "unchanged"
        counts[r["change"]] += 1
    gone = [i for i in prev_map if i not in {r["id"] for r in reqs}]
    return counts, gone


def sort_reqs(reqs):
    return sorted(reqs, key=lambda r: (
        PRIO_ORDER.get(r["severity"], 9),
        -r["mentions"],
        "".join(reversed(r["last_seen"])),
    ))


SECTION_ORDER = [("new", "新增"), ("updated", "变更"), ("closed", "已关闭"), ("unchanged", "其余")]


def render_md(day, reqs, stats, gone, generated_at):
    def esc(s):
        return (s or "").replace("|", "\\|").replace("\n", " ")

    out = [f"# FDE 需求清单 · {day}", ""]
    out.append(
        f"反馈 {stats['rows']} 行、需求 {stats['requirements']} 条、新增 {stats['new']}、"
        f"变更 {stats['updated']}、关闭 {stats['closed']}、跳过 {stats['skipped']} 行。"
    )
    out.append("")
    out.append(f"数据源：{SHEET_URL}（工作台 TSK-0429），生成于 {generated_at}。")
    out.append("")
    for key, name in SECTION_ORDER:
        items = [r for r in reqs if r["change"] == key]
        out.append(f"## {name}（{len(items)}）")
        out.append("")
        if not items:
            out.append("无。")
            out.append("")
            continue
        out.append("| 编号 | 标题 | 模块 | 反馈人 | 类型 | 次数 | 优先级 | 状态 | 首次 | 最近 | 行号 |")
        out.append("|---|---|---|---|---|---|---|---|---|---|---|")
        for r in items:
            out.append("| {id} | {title} | {module} | {reporters} | {types} | {m} | {sev} | {st} | {f} | {l} | {rows} |".format(
                id=esc(r["id"]), title=esc(r["title"]), module=esc(r["module"]) or "—",
                reporters=esc("、".join(r["reporters"])) or "—",
                types=esc("、".join(r["feedback_types"])) or "—",
                m=r["mentions"], sev=esc(r["severity"]) or "—",
                st=esc("、".join(r["status"])) or "—",
                f=r["first_seen"] or "—", l=r["last_seen"] or "—",
                rows=",".join(str(x) for x in r["source_rows"]),
            ))
        out.append("")
    if gone:
        out.append(f"## 表里已消失（{len(gone)}）")
        out.append("")
        out.append("上一份有、这次表里找不到的编号（人工确认是否删行）：" + "、".join(sorted(gone)) + "。")
        out.append("")
    return "\n".join(out).rstrip() + "\n"


def load_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError) as e:
        raise Fail(f"上一份清单读不了，拒绝在坏基准上比对：{path}（{e}）")


def pick_base(lists, day):
    """比对基准：上一份不同日期的清单。同日重跑仍和同一天的上一版比，结果可复现"""
    latest_path = os.path.join(lists, "latest.json")
    if os.path.exists(latest_path):
        prev = load_json(latest_path)
        if prev.get("list_date") != day:
            return prev
    if not os.path.isdir(lists):
        return None
    older = sorted(
        p for p in os.listdir(lists)
        if p.endswith(".json") and p != "latest.json" and p[:-5] < day
    )
    return load_json(os.path.join(lists, older[-1])) if older else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--date", default=None, help="清单日期，缺省取本机今天")
    ap.add_argument("--dry-run", action="store_true", help="只打印统计，不写文件")
    args = ap.parse_args()

    day = args.date or date.today().isoformat()
    out = os.path.abspath(args.out)
    lists = os.path.join(out, "lists")
    generated_at = datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S %z")

    try:
        records, skipped = parse_rows(fetch_csv())
        if not records:
            raise Fail("表里没有可用的反馈行（全部为空或缺少反馈事项）")
        reqs = sort_reqs(group(records))
        prev = pick_base(lists, day)
        counts, gone = mark_changes(reqs, prev)
        stats = {
            "rows": len(records),
            "requirements": len(reqs),
            "skipped": skipped,
            **counts,
        }
        doc = {
            "generated_at": generated_at,
            "list_date": day,
            "sheet_id": SHEET_ID,
            "gid": GID,
            "sheet_url": SHEET_URL,
            "task": "TSK-0429",
            "stats": stats,
            "missing_since_last": sorted(gone),
            "requirements": reqs,
        }
        md = render_md(day, reqs, stats, gone, generated_at)

        if args.dry_run:
            print("dry-run：" + json.dumps(stats, ensure_ascii=False))
            return 0

        os.makedirs(lists, exist_ok=True)
        md_path = os.path.join(lists, f"{day}.md")
        json_path = os.path.join(lists, f"{day}.json")
        latest_path = os.path.join(lists, "latest.json")
        with open(md_path, "w", encoding="utf-8") as f:
            f.write(md)
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False, indent=2)
        with open(latest_path, "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False, indent=2)

        print(
            f"FDE 清单 {day}：反馈 {stats['rows']} 行、需求 {stats['requirements']} 条、"
            f"新增 {stats['new']}、变更 {stats['updated']}、关闭 {stats['closed']}、跳过 {stats['skipped']} 行；"
            f"写入 {md_path}、{json_path}、{latest_path}"
        )
        return 0
    except Fail as e:
        print(f"失败：{e}（未写任何文件）", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
