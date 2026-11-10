#!/usr/bin/env python3
# powered by dsh - https://github.com/deepseek-ai/deepseek-harness

"""按开发任务编号（docs/dev-tasks.json 里的 key，如 FE-00a）回写工作台：领任务、记进展、登记产出、提交验收。

走 pmw-mcp 的工具（stdio），所以负责人、状态切换、会话标识的处理和 Claude Code 用 /task 时完全一样。
默认连测试实例 http://127.0.0.1:7796 和 bin/pmw-mcp-dev；不会连 7777，除非显式用 --api 指过去。

用法：
  scripts/pmw-task.py show     FE-00a
  scripts/pmw-task.py claim    FE-00a [--note 打算怎么做]
  scripts/pmw-task.py progress FE-00a "做了什么" [--files a,b] [--commits sha1,sha2]
  scripts/pmw-task.py artifact FE-00a --kind commit --sha abc123 [--branch feat/x] [--title 标题]
  scripts/pmw-task.py review   FE-00a "对着验收标准逐条说明" [--files a,b] [--tests "go test ./... 通过"] [--commits sha]
  scripts/pmw-task.py ready                # 列出依赖都已完成或待验收、自己还没开工的任务

会话标识取环境变量 PMW_SESSION_ID，子代理请设成自己的名字（如 PMW_SESSION_ID=agent-FE-00a），
这样变更记录里能分清是哪个代理改的。只用 Python 标准库。
"""
import argparse
import json
import os
import subprocess
import sys
import urllib.parse
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEY_TAG = "dev-key:"


def http_get(api, path, params=None):
    url = api.rstrip("/") + path + ("?" + urllib.parse.urlencode(params, doseq=True) if params else "")
    with urllib.request.urlopen(url, timeout=10) as r:
        return json.load(r)["data"]


def find(api, key):
    """按 dev-key 标签精确找对象；关键字搜索会误配，不用它"""
    rows = http_get(api, "/api/objects", {"tag": KEY_TAG + key, "type": "task,requirement", "archived": "true", "limit": "5"})
    if not rows:
        sys.exit(f"找不到任务 {key}（标签 {KEY_TAG}{key}）；先跑 scripts/import-dev-tasks.py --apply")
    return rows[0]


class MCP:
    """最小的 MCP stdio 客户端：起一个 pmw-mcp 进程，调一个工具，返回文本结果"""

    def __init__(self, binp, api):
        self.p = subprocess.Popen([binp, "--api", api], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, text=True, bufsize=1, env=dict(os.environ))
        self.n = 0
        self.req("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "pmw-task", "version": "1"}})
        self.send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def send(self, msg):
        self.p.stdin.write(json.dumps(msg) + "\n")
        self.p.stdin.flush()

    def req(self, method, params):
        self.n += 1
        self.send({"jsonrpc": "2.0", "id": self.n, "method": method, "params": params})
        while True:
            line = self.p.stdout.readline()
            if not line:
                sys.exit("pmw-mcp 退出了：" + self.p.stderr.read())
            r = json.loads(line)
            if r.get("id") == self.n:
                if "error" in r:
                    sys.exit("MCP 错误：" + json.dumps(r["error"], ensure_ascii=False))
                return r["result"]

    def call(self, name, args):
        res = self.req("tools/call", {"name": name, "arguments": args})
        text = "\n".join(c.get("text", "") for c in res.get("content", []) if c.get("type") == "text")
        if res.get("isError"):
            sys.exit(f"{name} 失败：{text}")
        return text

    def close(self):
        self.p.stdin.close()
        self.p.wait(timeout=5)


def split(s):
    return [x.strip() for x in s.split(",") if x.strip()] if s else []


def ready(api):
    """依赖都已完成或待验收、自己还在未开工的任务"""
    tasks = json.load(open(os.path.join(REPO, "docs", "dev-tasks.json")))
    status = {}
    for t in tasks:
        rows = http_get(api, "/api/objects", {"tag": KEY_TAG + t["key"], "type": "task,requirement", "archived": "true", "limit": "1"})
        status[t["key"]] = rows[0]["status"] if rows else None
    out = []
    for t in tasks:
        if t["type"] != "task" or status.get(t["key"]) != "todo":
            continue
        if all(status.get(d) in ("done", "review") for d in t.get("depends_on", [])):
            out.append(t)
    for t in out:
        print(f"{t['key']:<11} {t['milestone']:<3} {t['priority']} {t['estimate']}  {t['workdir']:<10} {t['title']}")
    print(f"共 {len(out)} 条可以开工")


def main():
    ap = argparse.ArgumentParser(description="按开发任务编号回写工作台")
    ap.add_argument("--api", default=os.environ.get("PMW_API", "http://127.0.0.1:7796"))
    ap.add_argument("--mcp", default=os.path.join(REPO, "bin", "pmw-mcp-dev"))
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("show"); s.add_argument("key")
    s = sub.add_parser("claim"); s.add_argument("key"); s.add_argument("--note", default="")
    s = sub.add_parser("progress"); s.add_argument("key"); s.add_argument("text"); s.add_argument("--files", default=""); s.add_argument("--commits", default="")
    s = sub.add_parser("artifact"); s.add_argument("key"); s.add_argument("--kind", default="file", choices=["file", "commit", "branch", "pr"])
    s.add_argument("--sha", default=""); s.add_argument("--branch", default=""); s.add_argument("--path", default=""); s.add_argument("--url", default=""); s.add_argument("--title", default="")
    s = sub.add_parser("review"); s.add_argument("key"); s.add_argument("summary"); s.add_argument("--files", default=""); s.add_argument("--tests", default=""); s.add_argument("--commits", default="")
    sub.add_parser("ready")
    a = ap.parse_args()

    if ":7777" in a.api or "broleez.vip" in a.api or "bro.vip" in a.api:
        print("注意：正在连真实服务", a.api, file=sys.stderr)
    if a.cmd == "ready":
        return ready(a.api)
    obj = find(a.api, a.key)
    if a.cmd == "show":
        print(json.dumps({k: obj.get(k) for k in ("id", "ref", "title", "status", "workdir", "owner_name")}, ensure_ascii=False, indent=2))
        return
    m = MCP(a.mcp, a.api)
    try:
        if a.cmd == "claim":
            out = m.call("pmw_claim_task", {"id": obj["id"], **({"note": a.note} if a.note else {})})
        elif a.cmd == "progress":
            out = m.call("pmw_append_progress", {"id": obj["id"], "text": a.text, "files": split(a.files), "commits": split(a.commits)})
        elif a.cmd == "artifact":
            args = {"object_id": obj["id"], "kind": a.kind, "repo": obj.get("workdir") or REPO}
            for k in ("sha", "branch", "path", "url", "title"):
                if getattr(a, k):
                    args[k] = getattr(a, k)
            if a.kind in ("commit", "branch") and not args.get("path"):
                args["path"] = obj.get("workdir") or REPO
            out = m.call("pmw_record_artifact", args)
        else:
            out = m.call("pmw_submit_review", {"id": obj["id"], "summary": a.summary, "changed_files": split(a.files), "test_results": a.tests, "commits": split(a.commits)})
        print(out)
    finally:
        m.close()


if __name__ == "__main__":
    main()
