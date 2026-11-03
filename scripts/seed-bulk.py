#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""往测试实例灌大量数据，作为列表、菜单的压测夹具（QA-03）。

用法：
    python3 scripts/seed-bulk.py                              # 默认 dry-run：只打印要灌多少
    python3 scripts/seed-bulk.py --apply                      # 灌进默认的测试实例 http://127.0.0.1:7796
    python3 scripts/seed-bulk.py --api http://127.0.0.1:7799 --apply
    python3 scripts/seed-bulk.py --api http://127.0.0.1:7799 --purge --apply   # 按标签硬删灌进去的数据
    python3 scripts/seed-bulk.py --tasks 200 --docs 50 --stakeholders 40 --apply  # 改数量

只用 Python 标准库。也可以 make seed-bulk ARGS="--api http://127.0.0.1:7799 --apply"。

灌什么（默认量）：
- 任务 2000（type=task）：状态、优先级、截止日（逾期 / 今天 / 本周 / 以后 / 无截止）轮换，
  负责人和参与人从灌入的干系人里挑，一部分挂到灌入的项目上。
- 干系人 500（联系人在后端就是干系人名册）。
- 文档 1000（type=doc）。
- 项目 30（type=project），给任务页的项目筛选用。
- 分类：任务、文档各一组（带二级），标签 12 个。
- 消息等接口上线后再扩展。
名字按「短 / 中 / 长 / 40 字以上超长」轮换，和 web-next/docs/bulk-content-audit.md 的口径一致。

怎么认出灌进去的数据（--purge 只删这些）：
- 工作对象：都带标签 seed:bulk。--purge 按这个标签列出（含回收站里的）逐条 hard 删除。
- 标签：名字以 seed:bulk 开头。
- 干系人：note 以 seed:bulk 开头。
- 分类：description 以 seed:bulk 开头；先删子分类再删父分类。

安全：
- 拒绝真实服务：端口 7777、bro.vip、broleez.vip（含子域名）直接退出，不发任何请求。
- 写之前读 /api/stats 的 db_path，指向仓库里的 data/pm.db 也拒绝。
- 不加 --apply 只读不写。库里已有 seed:bulk 的对象时拒绝再灌，先 --purge。
- 写请求带 X-Actor-Source: import、X-Actor-Name: seed-bulk，变更记录里能看出来。
"""
import argparse
import concurrent.futures
import datetime
import json
import os
import random
import sys
import urllib.error
import urllib.parse
import urllib.request

TAG = "seed:bulk"
DEFAULT_API = "http://127.0.0.1:7796"
BLOCKED_PORTS = {7777}
BLOCKED_HOSTS = ("bro.vip", "broleez.vip")
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REAL_DB = os.path.join(REPO_ROOT, "data", "pm.db")

TASK_STATUSES = ["todo"] * 5 + ["doing"] * 2 + ["review", "blocked", "done", "done", "cancelled"]
DOC_STATUSES = ["draft", "review", "published", "published", "archived"]
PROJECT_STATUSES = ["planning", "active", "active", "paused", "done"]
PRIORITIES = ["P0", "P1", "P1", "P2", "P2", "P2", "P3"]
SURNAMES = "王李张刘陈杨赵黄周吴徐孙胡朱高林何郭马罗梁宋郑谢韩唐冯于董萧程曹袁邓许傅沈曾彭吕苏卢蒋蔡贾丁魏薛叶阎余潘杜戴夏钟汪田任姜范方石姚谭廖邹熊金陆郝孔白崔康毛邱秦江史顾侯邵孟龙万段雷钱汤尹黎易常武乔贺赖龚文"
GIVEN = "一凡子涵雨桐浩然思远欣怡梓萱俊杰诗琪宇轩嘉怡明哲晓东振华一杰钊婷伟芳敏静丽强磊军洋勇艳杰娟涛超秀霞平刚桂英"
ROLES = ["产品经理", "后端", "前端", "设计", "测试", "运营", "客户", "合作方", "法务", "财务", ""]
TASK_WORDS = [
    "修复登录态过期", "整理接口文档", "评审需求", "补单元测试", "对齐设计稿", "导出周报",
    "迁移旧数据", "排查慢查询", "联调支付回调", "写上线说明", "清理废弃配置", "复盘线上事故",
]
DOC_WORDS = ["会议纪要", "技术方案", "需求说明", "调研报告", "周报", "操作手册", "复盘", "评审意见"]
PROJECT_WORDS = ["支付中台", "会员体系", "数据看板", "移动端重构", "客服工单", "风控规则", "开放平台", "内部工具"]
LONG_TAIL = "，涉及多个团队协作、历史数据兼容、灰度发布与回滚预案，需要逐项确认后再推进到下一阶段"


class ApiError(Exception):
    def __init__(self, status, code, message):
        super().__init__("%s %s: %s" % (status, code, message))
        self.status = status
        self.code = code


class Api:
    def __init__(self, base, timeout=15):
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
            headers["X-Actor-Name"] = "seed-bulk"
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

    def list_all(self, path, query):
        out = []
        while True:
            q = dict(query, limit=200, offset=len(out))
            data, meta = self.call("GET", path, query=q)
            data = data or []
            out.extend(data)
            total = (meta or {}).get("total", len(out))
            if not data or len(out) >= total:
                return out


# ---------------------------------------------------------------- 安全检查

def check_target(api_url):
    """真实服务地址直接退出，不发请求。"""
    u = urllib.parse.urlparse(api_url)
    if u.scheme not in ("http", "https") or not u.hostname:
        raise SystemExit("--api 不是合法地址：%r" % api_url)
    host = u.hostname.lower().rstrip(".")
    port = u.port or (443 if u.scheme == "https" else 80)
    if port in BLOCKED_PORTS:
        raise SystemExit("拒绝：%s 是真实服务端口（%d），本脚本只写测试实例" % (api_url, port))
    for h in BLOCKED_HOSTS:
        if host == h or host.endswith("." + h):
            raise SystemExit("拒绝：%s 是真实服务域名，本脚本只写测试实例" % api_url)


def check_db(api):
    stats, _ = api.call("GET", "/api/stats")
    db_path = (stats or {}).get("db_path", "")
    if db_path and os.path.realpath(db_path) == os.path.realpath(REAL_DB):
        raise SystemExit("拒绝：目标实例的库是真实库 %s" % db_path)
    return stats


# ---------------------------------------------------------------- 造数据

def vary(i, base, n):
    """短 / 中 / 长 / 超长 四档轮换。"""
    k = i % 4
    if k == 0:
        return base
    if k == 1:
        return "%s %d" % (base, n)
    if k == 2:
        return "%s：第 %d 轮跟进与确认" % (base, n)
    return "%s 第 %d 项%s" % (base, n, LONG_TAIL)


def person_name(rng, i):
    given = rng.choice(GIVEN) + (rng.choice(GIVEN) if i % 3 else "")
    name = rng.choice(SURNAMES) + given
    if i % 4 == 3:
        name += "（%s 事业部 外部顾问）" % rng.choice(PROJECT_WORDS)
    return "%s-%03d" % (name, i + 1)


def due_for(i, today):
    """逾期 / 今天 / 本周 / 以后 / 无截止 轮换。"""
    k = i % 10
    if k in (0, 1):
        d = today - datetime.timedelta(days=1 + i % 60)
    elif k == 2:
        d = today
    elif k in (3, 4):
        d = today + datetime.timedelta(days=1 + i % 6)
    elif k in (5, 6):
        d = today + datetime.timedelta(days=8 + i % 90)
    else:
        return None
    return d.isoformat()


def build_plan(args, rng):
    today = datetime.date.today()
    tags = ["%s:%s" % (TAG, w) for w in
            ["后端", "前端", "设计", "数据", "运营", "客户反馈", "紧急", "技术债", "文档", "安全", "性能", "跨团队协作长标签名称"]]
    cat_tree = {
        "task": [("研发", ["接口", "页面", "数据迁移"]), ("运营", ["活动", "内容"]), ("支持", []),
                 ("跨部门协作事项与对外沟通（压测长分类名）", ["法务", "财务"])],
        "doc": [("方案", ["后端方案", "前端方案"]), ("纪要", ["周会", "评审会"]), ("手册", [])],
    }
    stakeholders = []
    for i in range(args.stakeholders):
        stakeholders.append({
            "name": person_name(rng, i),
            "role": ROLES[i % len(ROLES)],
            "email": "seed%03d@example.com" % (i + 1) if i % 2 == 0 else "",
            "note": TAG,
            "sort_order": 1000 + i,
        })
    projects = []
    for i in range(args.projects):
        projects.append({
            "type_id": "project",
            "title": vary(i, PROJECT_WORDS[i % len(PROJECT_WORDS)], i + 1),
            "status": PROJECT_STATUSES[i % len(PROJECT_STATUSES)],
            "body": "压测数据（%s）" % TAG,
            "tags": [TAG],
        })
    tasks = []
    for i in range(args.tasks):
        t_tags = [TAG] + rng.sample(tags, i % 3)
        tasks.append({
            "type_id": "task",
            "title": vary(i, TASK_WORDS[i % len(TASK_WORDS)], i + 1),
            "status": TASK_STATUSES[i % len(TASK_STATUSES)],
            "priority": PRIORITIES[i % len(PRIORITIES)],
            "due_at": due_for(i, today),
            "body": "压测任务 %d（%s）" % (i + 1, TAG) if i % 5 else "",
            "source": "manual",
            "tags": t_tags,
            "_owner": i % 6 != 0,
            "_participants": i % 4,
            "_project": i % 3 == 0,
            "_category": "task" if i % 2 == 0 else None,
        })
    docs = []
    for i in range(args.docs):
        docs.append({
            "type_id": "doc",
            "title": vary(i, DOC_WORDS[i % len(DOC_WORDS)], i + 1),
            "status": DOC_STATUSES[i % len(DOC_STATUSES)],
            "body": "# 压测文档 %d\n\n%s\n" % (i + 1, TAG),
            "tags": [TAG] + rng.sample(tags, i % 2),
            "_owner": i % 3 != 0,
            "_participants": 0,
            "_project": i % 4 == 0,
            "_category": "doc" if i % 3 else None,
        })
    return {"tags": tags, "categories": cat_tree, "stakeholders": stakeholders,
            "projects": projects, "tasks": tasks, "docs": docs}


# ---------------------------------------------------------------- 写入

def run_parallel(fn, items, workers, label):
    out, done = [None] * len(items), 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(fn, it): i for i, it in enumerate(items)}
        for f in concurrent.futures.as_completed(futs):
            out[futs[f]] = f.result()
            done += 1
            if done % 250 == 0 or done == len(items):
                print("  %s %d/%d" % (label, done, len(items)), flush=True)
    return out


def apply_seed(api, plan, args, rng):
    existing, meta = api.call("GET", "/api/objects", query={"tag": TAG, "limit": 1})
    if (meta or {}).get("total", len(existing or [])) > 0:
        raise SystemExit("库里已有 %s 的对象，先跑 --purge --apply 再灌" % TAG)

    print("标签 %d" % len(plan["tags"]))
    have = {t["name"] for t in (api.call("GET", "/api/tags")[0] or [])}
    for name in [TAG] + plan["tags"]:
        if name not in have:
            api.call("POST", "/api/tags", {"name": name})

    print("分类")
    cats = {}
    for type_id, tree in plan["categories"].items():
        ids = []
        for pi, (parent, children) in enumerate(tree):
            p, _ = api.call("POST", "/api/categories", {
                "type_id": type_id, "name": parent, "slug": "seed-bulk-%d" % pi,
                "description": TAG, "sort_order": 900 + pi})
            ids.append(p["id"])
            for ci, child in enumerate(children):
                c, _ = api.call("POST", "/api/categories", {
                    "type_id": type_id, "parent_id": p["id"], "name": child,
                    "slug": "seed-bulk-%d-%d" % (pi, ci), "description": TAG, "sort_order": ci})
                ids.append(c["id"])
        cats[type_id] = ids

    print("干系人 %d" % len(plan["stakeholders"]))
    people = run_parallel(lambda b: api.call("POST", "/api/stakeholders", b)[0]["id"],
                          plan["stakeholders"], args.workers, "干系人")

    print("项目 %d" % len(plan["projects"]))
    projects = run_parallel(lambda b: api.call("POST", "/api/objects", b)[0]["id"],
                            plan["projects"], args.workers, "项目")

    # 挑人、挑项目在主线程按顺序做完，同一个种子灌出同一份数据
    def prep(b):
        b = dict(b)
        if b.pop("_owner") and people:
            b["owner_id"] = rng.choice(people)
        n = b.pop("_participants")
        if n and people:
            b["participant_ids"] = rng.sample(people, min(n, len(people)))
        if b.pop("_project") and projects:
            b["project_id"] = rng.choice(projects)
        cat = b.pop("_category")
        if cat and cats.get(cat):
            b["category_id"] = rng.choice(cats[cat])
        if b.get("due_at") is None:
            b.pop("due_at", None)
        return b

    def make(b):
        return api.call("POST", "/api/objects", b)[0]["id"]

    print("任务 %d" % len(plan["tasks"]))
    run_parallel(make, [prep(b) for b in plan["tasks"]], args.workers, "任务")
    print("文档 %d" % len(plan["docs"]))
    run_parallel(make, [prep(b) for b in plan["docs"]], args.workers, "文档")


def purge(api, args):
    objs = {}
    for deleted in (False, True):
        q = {"tag": TAG}
        if deleted:
            q["deleted"] = "true"
        for o in api.list_all("/api/objects", q):
            objs[o["id"]] = o
    people = [s for s in (api.call("GET", "/api/stakeholders", query={"archived": "true"})[0] or [])
              if (s.get("note") or "").startswith(TAG)]
    tags = [t for t in (api.call("GET", "/api/tags")[0] or []) if t["name"].startswith(TAG)]
    cats = []
    for type_id in ("task", "doc"):
        cats += [c for c in (api.call("GET", "/api/categories", query={"type": type_id})[0] or [])
                 if (c.get("description") or "").startswith(TAG)]
    print("要删：对象 %d、干系人 %d、标签 %d、分类 %d" % (len(objs), len(people), len(tags), len(cats)))
    if not args.apply:
        print("dry-run，加 --apply 才会删")
        return
    run_parallel(lambda oid: api.call("DELETE", "/api/objects/%s" % urllib.parse.quote(oid),
                                      query={"hard": "true"}),
                 list(objs), args.workers, "对象")
    if people:
        run_parallel(lambda s: api.call("DELETE", "/api/stakeholders/%s" % urllib.parse.quote(s["id"])),
                     people, args.workers, "干系人")
    for t in tags:
        api.call("DELETE", "/api/tags/%s" % urllib.parse.quote(t["id"]))
    for c in sorted(cats, key=lambda c: -c.get("depth", 0)):
        api.call("DELETE", "/api/categories/%s" % urllib.parse.quote(c["id"]))
    print("已删完")


def main():
    ap = argparse.ArgumentParser(description="往测试实例灌压测数据，或按标签删掉")
    ap.add_argument("--api", default=DEFAULT_API, help="测试实例地址，默认 %s" % DEFAULT_API)
    ap.add_argument("--apply", action="store_true", help="真的写入；不加只打印")
    ap.add_argument("--purge", action="store_true", help="按标签 %s 硬删灌进去的数据" % TAG)
    ap.add_argument("--tasks", type=int, default=2000)
    ap.add_argument("--stakeholders", type=int, default=500)
    ap.add_argument("--docs", type=int, default=1000)
    ap.add_argument("--projects", type=int, default=30)
    ap.add_argument("--workers", type=int, default=4, help="并发请求数")
    ap.add_argument("--seed", type=int, default=20261028, help="随机种子，同一个种子灌出同一份数据")
    args = ap.parse_args()

    check_target(args.api)
    api = Api(args.api)
    try:
        stats = check_db(api)
    except (urllib.error.URLError, OSError) as e:
        raise SystemExit("连不上 %s：%s" % (args.api, e))
    print("目标 %s，库 %s，现有对象 %s" % (args.api, stats.get("db_path", "?"), stats.get("objects", "?")))

    try:
        if args.purge:
            purge(api, args)
            return
        rng = random.Random(args.seed)
        plan = build_plan(args, rng)
        print("计划：任务 %d、干系人 %d、文档 %d、项目 %d、分类 %d、标签 %d" % (
            len(plan["tasks"]), len(plan["stakeholders"]), len(plan["docs"]), len(plan["projects"]),
            sum(len(t) + sum(len(c) for _, c in t) for t in plan["categories"].values()),
            len(plan["tags"]) + 1))
        if not args.apply:
            print("dry-run，加 --apply 才会写入")
            return
        apply_seed(api, plan, args, rng)
        print("灌完")
    except ApiError as e:
        raise SystemExit("接口报错：%s" % e)


if __name__ == "__main__":
    sys.exit(main())
