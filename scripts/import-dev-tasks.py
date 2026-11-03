#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 docs/dev-tasks.json 导入产品工作台（pmw），建成工作对象。

用法：
    python3 scripts/import-dev-tasks.py                      # 默认 dry-run：只打印要建什么
    python3 scripts/import-dev-tasks.py --api http://127.0.0.1:7796 --apply   # 真的写入（建议先对测试实例）
    python3 scripts/import-dev-tasks.py --apply --update     # 已存在的也按 JSON 更新标题、正文、优先级、标签、props

只用 Python 标准库。

映射规则（依据 docs/api-contract.md）：
- type "task" 建成待办（type_id=task），"requirement" 建成需求（type_id=requirement，状态 backlog「需求池」）。
- 验收标准写进 props.acceptance（与 pmw_get_object、/task 流程读取的位置一致，见 domain.PropAcceptance）。
- 工作目录写进 workdir 列（0008），JSON 里是相对仓库根的路径，这里换成绝对路径，/task 才能直接用。
- 关联仓库写进 props.repo（仓库根绝对路径）。
- 去重键：每条对象打一个标签 "dev-key:<key>"，同时写 props.dev_key。
  用标签而不是只用 props，是因为 GET /api/objects 支持按 tag 精确筛选，props 没有查询参数。
- 依赖：A 依赖 B 建成「B blocks A」的关联（relation=blocks，字典里的标签是「阻塞」，反向显示为「被阻塞于」）。
  契约里的关联类型只有 relates / blocks / duplicates / parent / references，blocks 就是「被阻塞 / 依赖」类，
  方向是「阻塞方 -> 被阻塞方」，所以从依赖项指向依赖它的任务。links 表对 (from,to,relation) 唯一，重复建会 409，这里按已存在处理。
- 写请求带 X-Actor-Source: import，变更记录里能看出是导入脚本写的。

不会做的事：不删除任何对象或关联；不改已存在对象的状态和负责人；不加 --update 时不动已存在的对象。
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

KEY_TAG_PREFIX = "dev-key:"
COMMON_TAG = "dev-plan"
REQUIRED = ["key", "type", "title", "milestone", "module", "priority", "estimate",
            "depends_on", "workdir", "spec", "body", "acceptance"]
TYPES = {"task": "task", "requirement": "requirement"}
PRIORITIES = {"P0", "P1", "P2", "P3"}
ESTIMATES = {"S", "M", "L"}
REQUIREMENT_STATUS = "backlog"

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class ApiError(Exception):
    def __init__(self, status, code, message):
        super().__init__("%s %s: %s" % (status, code, message))
        self.status = status
        self.code = code


class Api:
    def __init__(self, base, timeout=10):
        self.base = base.rstrip("/")
        self.timeout = timeout

    def call(self, method, path, body=None, query=None):
        url = self.base + path
        if query:
            url += "?" + urllib.parse.urlencode(query, doseq=True)
        data = None
        headers = {"Accept": "application/json"}
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json; charset=utf-8"
        if method != "GET":
            headers["X-Actor-Source"] = "import"
            headers["X-Actor-Name"] = "dev-tasks-import"
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as e:
            raw = e.read()
            code, msg = "http_%d" % e.code, raw.decode("utf-8", "replace")
            try:
                err = json.loads(raw)["error"]
                code, msg = err.get("code", code), err.get("message", msg)
            except Exception:
                pass
            raise ApiError(e.code, code, msg)
        if not raw:
            return None, None
        env = json.loads(raw)
        return env.get("data"), env.get("meta")


# ---------------------------------------------------------------- 校验

def load_tasks(path):
    with open(path, encoding="utf-8") as f:
        tasks = json.load(f)
    if not isinstance(tasks, list):
        raise SystemExit("%s 顶层必须是数组" % path)
    errors = []
    seen = {}
    for i, t in enumerate(tasks):
        where = t.get("key") or "#%d" % i
        for k in REQUIRED:
            if k not in t:
                errors.append("%s 缺字段 %s" % (where, k))
        if t.get("type") not in TYPES:
            errors.append("%s type 只能是 task 或 requirement" % where)
        if t.get("priority") not in PRIORITIES:
            errors.append("%s priority 不合法: %r" % (where, t.get("priority")))
        if t.get("estimate") not in ESTIMATES:
            errors.append("%s estimate 不合法: %r" % (where, t.get("estimate")))
        wd = t.get("workdir", "")
        if os.path.isabs(wd) or ".." in wd.split("/"):
            errors.append("%s workdir 必须是仓库内的相对路径: %r" % (where, wd))
        if t.get("key") in seen:
            errors.append("key 重复: %s" % t.get("key"))
        seen[t.get("key")] = t
    for t in tasks:
        for d in t.get("depends_on", []):
            if d not in seen:
                errors.append("%s 依赖了不存在的 key %s" % (t.get("key"), d))
            if d == t.get("key"):
                errors.append("%s 依赖了自己" % d)
    if errors:
        raise SystemExit("任务文件校验失败：\n  " + "\n  ".join(errors))
    return tasks


def topo_order(tasks):
    """按依赖排序（依赖项在前）；发现环直接退出。"""
    by_key = {t["key"]: t for t in tasks}
    state, order = {}, []

    def visit(k, stack):
        s = state.get(k)
        if s == 2:
            return
        if s == 1:
            raise SystemExit("依赖有环: " + " -> ".join(stack + [k]))
        state[k] = 1
        for d in by_key[k]["depends_on"]:
            visit(d, stack + [k])
        state[k] = 2
        order.append(by_key[k])

    for t in tasks:
        visit(t["key"], [])
    return order


# ---------------------------------------------------------------- 组装

def build_body(t):
    parts = [t["body"].rstrip()]
    if t["spec"]:
        parts.append("## 规格\n\n" + "\n".join("- " + s for s in t["spec"]))
    if t["depends_on"]:
        parts.append("## 依赖\n\n" + "\n".join("- " + d for d in t["depends_on"]))
    parts.append("## 元信息\n\n- 任务键：%s\n- 里程碑：%s\n- 模块：%s\n- 规模：%s\n- 工作目录（相对仓库根）：%s\n- 来源：docs/dev-tasks.json"
                 % (t["key"], t["milestone"], t["module"], t["estimate"], t["workdir"]))
    return "\n\n".join(parts) + "\n"


def build_tags(t):
    return [KEY_TAG_PREFIX + t["key"], COMMON_TAG, t["milestone"], "module:" + t["module"]]


def build_props(t, repo_root):
    return {
        "dev_key": t["key"],
        "acceptance": t["acceptance"],
        "repo": repo_root,
        "milestone": t["milestone"],
        "module": t["module"],
        "estimate": t["estimate"],
        "spec": t["spec"],
        "depends_on": t["depends_on"],
    }


def abs_workdir(t, repo_root):
    wd = t["workdir"].strip()
    if wd in ("", "."):
        return repo_root
    return os.path.normpath(os.path.join(repo_root, wd))


# ---------------------------------------------------------------- 与工作台交互

def find_existing(api, key):
    data, _ = api.call("GET", "/api/objects", query={
        "tag": KEY_TAG_PREFIX + key, "type": "task,requirement", "archived": "true", "limit": "5"})
    data = data or []
    if len(data) > 1:
        print("  警告：%s 有 %d 条同 key 对象，取第一条 %s" % (key, len(data), data[0].get("ref")), file=sys.stderr)
    return data[0] if data else None


def task_category(api):
    """待办类型下 slug 为 dev（研发）的分类，没有就不设。"""
    try:
        cats, _ = api.call("GET", "/api/categories", query={"type": "task"})
    except ApiError:
        return None
    for c in cats or []:
        if c.get("slug") == "dev":
            return c.get("id")
    return None


def check_statuses(api):
    types, _ = api.call("GET", "/api/object-types")
    for ty in types or []:
        if ty.get("id") == "requirement":
            keys = [s.get("key") for s in ty.get("statuses") or []]
            if REQUIREMENT_STATUS not in keys:
                raise SystemExit("需求类型里没有状态 %s（现有：%s），请改脚本里的 REQUIREMENT_STATUS" % (REQUIREMENT_STATUS, keys))
    ids = {ty.get("id") for ty in types or []}
    for need in TYPES.values():
        if need not in ids:
            raise SystemExit("工作台里没有类型 %s" % need)


def existing_blocks(api, from_id):
    links, _ = api.call("GET", "/api/objects/%s/links" % from_id)
    out = set()
    for l in links or []:
        if l.get("direction") == "out" and l.get("relation") == "blocks":
            out.add(l.get("to_id"))
    return out


def main():
    ap = argparse.ArgumentParser(description="把 docs/dev-tasks.json 导入产品工作台")
    ap.add_argument("--api", default=os.environ.get("PMW_API", "http://127.0.0.1:7777"), help="工作台地址，默认 http://127.0.0.1:7777")
    ap.add_argument("--file", default=os.path.join(REPO_ROOT, "docs", "dev-tasks.json"))
    ap.add_argument("--repo-root", default=REPO_ROOT, help="工作目录的基准（仓库根的绝对路径）")
    ap.add_argument("--project", default="", help="可选：挂到哪个项目（对象 id），任务的工作目录仍然单独设置")
    ap.add_argument("--only", default="", help="只处理这些 key（逗号分隔），依赖关系只在这些 key 之间建")
    ap.add_argument("--apply", action="store_true", help="真的写入；不加时只打印计划")
    ap.add_argument("--update", action="store_true", help="已存在的对象也按 JSON 更新（不改状态和负责人）")
    args = ap.parse_args()

    repo_root = os.path.abspath(args.repo_root)
    tasks = load_tasks(args.file)
    order = topo_order(tasks)
    if args.only:
        only = {k.strip() for k in args.only.split(",") if k.strip()}
        unknown = only - {t["key"] for t in tasks}
        if unknown:
            raise SystemExit("--only 里有不存在的 key: %s" % ", ".join(sorted(unknown)))
        order = [t for t in order if t["key"] in only]

    api = Api(args.api)
    online = True
    try:
        api.call("GET", "/api/health")
    except (urllib.error.URLError, OSError, ApiError) as e:
        online = False
        if args.apply:
            raise SystemExit("连不上工作台 %s：%s\n工作台没在运行。先启动它（或用 --api 指向测试实例），再加 --apply。" % (args.api, e))

    mode = "写入" if args.apply else "dry-run（只打印，不写入）"
    print("模式：%s" % mode)
    print("工作台：%s（%s）" % (args.api, "已连接" if online else "未连接，无法判断哪些已存在，以下按全部新建列出"))
    print("任务文件：%s，共 %d 条，本次处理 %d 条" % (args.file, len(tasks), len(order)))
    print("仓库根：%s" % repo_root)
    print()

    category = None
    if online:
        check_statuses(api)
        category = task_category(api)

    ids = {}  # key -> object id（已存在或新建的）
    stats = {"create": 0, "update": 0, "skip": 0, "link": 0, "link_skip": 0}

    for t in order:
        key = t["key"]
        existing = find_existing(api, key) if online else None
        workdir = abs_workdir(t, repo_root)
        if t["type"] == "task" and not os.path.isdir(workdir):
            note = "（工作目录还不存在，由前置任务创建）"
        else:
            note = ""
        line = "%-10s %-11s %s %s  %s | 工作目录 %s%s" % (
            key, t["type"], t["milestone"], t["priority"], t["title"], workdir, note)

        if existing:
            ids[key] = existing["id"]
            if not args.update:
                stats["skip"] += 1
                print("[已存在] %s -> %s" % (line, existing.get("ref")))
                continue
            stats["update"] += 1
            print("[更新]   %s -> %s" % (line, existing.get("ref")))
            if args.apply:
                cur, _ = api.call("GET", "/api/objects/%s" % existing["id"])
                props = dict((cur or {}).get("props") or {})
                props.update(build_props(t, repo_root))  # props 是整体替换：先读回再合并
                tags = list(dict.fromkeys(((cur or {}).get("tags") or []) + build_tags(t)))
                api.call("PATCH", "/api/objects/%s" % existing["id"], body={
                    "title": t["title"], "body": build_body(t), "priority": t["priority"],
                    "workdir": workdir, "props": props, "tags": tags})
            continue

        stats["create"] += 1
        print("[新建]   %s" % line)
        if args.apply:
            payload = {
                "type_id": TYPES[t["type"]],
                "title": t["title"],
                "body": build_body(t),
                "priority": t["priority"],
                "source": "import",
                "workdir": workdir,
                "props": build_props(t, repo_root),
                "tags": build_tags(t),
            }
            if t["type"] == "requirement":
                payload["status"] = REQUIREMENT_STATUS
            elif category:
                payload["category_id"] = category
            if args.project:
                payload["project_id"] = args.project
            obj, _ = api.call("POST", "/api/objects", body=payload)
            ids[key] = obj["id"]
            print("         -> %s" % obj.get("ref"))

    print()
    print("依赖关联（relation=blocks，方向：依赖项 -> 依赖它的任务）：")
    in_scope = {t["key"] for t in order}
    cache = {}
    for t in order:
        for d in t["depends_on"]:
            if d not in in_scope:
                continue
            label = "  %s 阻塞 %s" % (d, t["key"])
            from_id, to_id = ids.get(d), ids.get(t["key"])
            if online and from_id and to_id:
                if from_id not in cache:
                    cache[from_id] = existing_blocks(api, from_id)
                if to_id in cache[from_id]:
                    stats["link_skip"] += 1
                    print(label + "（已存在）")
                    continue
            stats["link"] += 1
            print(label)
            if args.apply:
                try:
                    api.call("POST", "/api/objects/%s/links" % from_id, body={"to_id": to_id, "relation": "blocks", "note": "dev-tasks.json depends_on"})
                    cache.setdefault(from_id, set()).add(to_id)
                except ApiError as e:
                    if e.status == 409:
                        stats["link_skip"] += 1
                        stats["link"] -= 1
                        print("    已存在，跳过")
                    else:
                        raise

    print()
    print("汇总：新建 %(create)d，更新 %(update)d，已存在跳过 %(skip)d，新建关联 %(link)d，已有关联 %(link_skip)d" % stats)
    if not args.apply:
        print("这是 dry-run，没有写入任何数据。确认无误后加 --apply（建议先用 --api 指向测试实例 http://127.0.0.1:7796）。")


if __name__ == "__main__":
    main()
