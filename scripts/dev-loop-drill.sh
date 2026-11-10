#!/bin/bash
# 开发任务闭环的端到端演练（DEV-11）：在测试实例上建一条演示任务，交给 Claude Code 用 /task 做完，再逐项检查。
#
#   scripts/dev-loop-drill.sh setup           重置测试实例、建沙箱仓库和演示任务，打印编号和下一步命令
#   scripts/dev-loop-drill.sh check <编号>    逐项检查这条任务是否按 /task 流程走完，全过才 0 退出
#   scripts/dev-loop-drill.sh stop            停掉本次演练用的测试实例（转给 dev-instance.sh stop）
#
# 选 bash 而不是 Python：起停实例和沙箱 git 操作本来就是 shell，接口读写和检查交给内嵌的
# 标准库 Python（/usr/bin/python3），不装任何依赖。
#
# 测试实例由 scripts/dev-instance.sh 管，环境变量和它一致，原样传过去：
#   PMW_DEV_DIR   副本库、pid、日志、沙箱、演练状态所在目录（默认 <仓库>/data-dev，同 dev-instance.sh）
#   PMW_DEV_ADDR  测试实例监听地址（默认 127.0.0.1:7796）
#   PMW_SRC_DB    被复制的源库（dev-instance.sh 的默认值是正式库，只读复制）
#
# 几条约束：
#   1. setup 会 reset 测试实例，丢掉上面所有数据。7796 已是生产，对它 setup 一律拒绝；
#      自己演练请用 PMW_DEV_DIR + PMW_DEV_ADDR 起一个独立实例。
#   2. 拒绝 7777 端口：那是正式实例。本脚本不直接读写正式库，只经由 dev-instance.sh 做只读复制。
#   3. 停进程只走 dev-instance.sh stop（按 pid 文件并核对命令行），不用 pkill。
#   4. 不切真实库。切换条件见 web-next/docs/dev-plan.md 4.0。

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DEV_DIR="${PMW_DEV_DIR:-$(cd "$(dirname "$0")/.." && pwd)/data-dev}"
DEV_DIR="${DEV_DIR%/}"
ADDR="${PMW_DEV_ADDR:-127.0.0.1:7796}"
PORT="${ADDR##*:}"
API="http://$ADDR"
SANDBOX="$DEV_DIR/sandbox"
STATE="$DEV_DIR/drill-state.json"
PY=/usr/bin/python3
[ -x "$PY" ] || PY=python3

export PMW_DEV_DIR="$DEV_DIR" PMW_DEV_ADDR="$ADDR"

die() { echo "dev-loop-drill: $*" >&2; exit 1; }

guard() {
  # 只用于拒绝：正式实例的端口不许当测试实例用
  [ "$PORT" != "7777" ] || die "端口 7777 是正式实例，演练只能用测试实例"
}

# 沙箱：一个 Python 小仓库，add 写反了，测试会失败，留给 /task 去修。
make_sandbox() {
  case "$SANDBOX" in
    "$DEV_DIR"/sandbox) ;;
    *) die "沙箱路径不在演练目录下：$SANDBOX" ;;
  esac
  rm -rf "$SANDBOX"
  mkdir -p "$SANDBOX"
  cat >"$SANDBOX/calc.py" <<'EOF'
def add(a, b):
    return a - b


def mul(a, b):
    return a * b
EOF
  cat >"$SANDBOX/test_calc.py" <<'EOF'
import unittest

from calc import add, mul


class CalcTest(unittest.TestCase):
    def test_add(self):
        self.assertEqual(add(2, 3), 5)

    def test_mul(self):
        self.assertEqual(mul(2, 3), 6)


if __name__ == "__main__":
    unittest.main()
EOF
  cat >"$SANDBOX/README.md" <<'EOF'
# calc

演练用的小仓库。测试命令：

    python3 -m unittest -v
EOF
  (
    cd "$SANDBOX"
    git init -q -b main
    git config user.name "pmw drill"
    git config user.email "drill@localhost"
    git add -A
    git commit -q -m "init: calc 和测试（add 有 bug）"
  )
}

# api.py：建任务、检查，都走测试实例的 HTTP 接口。
run_py() {
  "$PY" - "$@" <<'PY'
import datetime, json, os, re, subprocess, sys, urllib.error, urllib.request

API = os.environ["DRILL_API"]
STATE = os.environ["DRILL_STATE"]
SANDBOX = os.environ["DRILL_SANDBOX"]


def call(method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(API + path, data=data, method=method,
                                 headers={"Content-Type": "application/json", "X-Actor-Source": "api", "X-Actor-Name": "dev-loop-drill"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.load(r)["data"]
    except urllib.error.HTTPError as e:
        sys.exit(f"{method} {path} 失败：{e.code} {e.read().decode(errors='replace')}")


def parse_time(s):
    # Go 的时间可能带 9 位小数和 Z，3.9 的 fromisoformat 吃不下，去掉小数再解析
    s = re.sub(r"\.\d+", "", s).replace("Z", "+00:00")
    return datetime.datetime.fromisoformat(s)


def setup():
    started = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
    base = subprocess.check_output(["git", "-C", SANDBOX, "rev-parse", "HEAD"], text=True).strip()
    acceptance = "\n".join([
        "- [ ] `python3 -m unittest -v` 全部通过",
        "- [ ] 只改 `calc.py`，不改测试",
        "- [ ] 在工作分支上提交，并登记 commit 产物",
    ])
    body = "\n".join([
        "演练任务（DEV-11），由 scripts/dev-loop-drill.sh setup 建在测试实例上。",
        "",
        "`calc.add` 返回了 a - b，`test_calc.py` 的 test_add 因此失败。修好它。",
    ])
    o = call("POST", "/api/objects", {
        "type_id": "task", "title": "演练：修好 calc.add", "body": body, "priority": "P1",
        "workdir": SANDBOX, "props": {"acceptance": acceptance, "repo": SANDBOX}, "tags": ["dev-loop-drill"],
    })
    with open(STATE, "w") as f:
        json.dump({"id": o["id"], "ref": o["ref"], "base_sha": base, "started_at": started.isoformat(),
                   "api": API, "sandbox": SANDBOX}, f, ensure_ascii=False, indent=2)
    print(o["ref"])


def check(key):
    try:
        with open(STATE) as f:
            st = json.load(f)
    except FileNotFoundError:
        sys.exit(f"没有演练状态文件 {STATE}，先跑 setup")
    o = call("GET", "/api/objects/" + urllib.request.quote(st["id"] if key in (st["id"], st["ref"]) else key))
    if o["ref"] != st["ref"]:
        print(f"注意：{o['ref']} 不是最近一次 setup 建的 {st['ref']}，沙箱和起始时间仍按最近一次算")
    results = []

    def item(name, ok, detail=""):
        results.append(ok)
        print(f"  [{'通过' if ok else '不通过'}] {name}" + (f"：{detail}" if detail else ""))

    print(f"检查 {o['ref']} {o['title']}（{API}）")
    item("状态为 done 或 review", o["status"] in ("done", "review"), f"当前 {o['status']}")

    prog = call("GET", f"/api/objects/{o['id']}/progress?limit=500")
    kinds = [p["kind"] for p in prog]
    item("进展至少 3 条", len(prog) >= 3, f"{len(prog)} 条")
    item("进展含 claim", "claim" in kinds)
    item("进展含 review", "review" in kinds)
    sessions = {p.get("session_id") or "" for p in prog}
    item("进展的 session_id 非空且一致", bool(prog) and "" not in sessions and len(sessions) == 1,
         "、".join(sorted(s or "（空）" for s in sessions)) or "没有进展")

    arts = call("GET", f"/api/artifacts?object_id={o['id']}&limit=500")
    shas = []
    for a in arts:
        m = re.match(r"\[commit\]\s+sha=(\S+)", a.get("note") or "")
        if m:
            shas.append(m.group(1))
    item("至少 1 条 commit 产物", len(shas) >= 1, ", ".join(shas) or "没有")
    known = [s for s in shas if subprocess.run(["git", "-C", SANDBOX, "cat-file", "-e", s + "^{commit}"],
                                               capture_output=True).returncode == 0]
    item("commit 产物的 sha 在沙箱仓库里", bool(shas) and len(known) == len(shas),
         f"{len(known)}/{len(shas)} 个能找到")

    heads = subprocess.run(["git", "-C", SANDBOX, "for-each-ref", "--format=%(refname:short)", "refs/heads"],
                           capture_output=True, text=True).stdout.split()
    new = []
    for h in heads:
        if h == "main":
            continue
        n = subprocess.run(["git", "-C", SANDBOX, "rev-list", "--count", f"{st['base_sha']}..{h}"],
                           capture_output=True, text=True).stdout.strip()
        if n and int(n) > 0:
            new.append(f"{h}（{n} 个提交）")
    item("沙箱仓库有新分支和提交", bool(new), "、".join(new) or "只有 " + "、".join(heads))

    # 起始时间之后的状态变更里，有没有切到终态的。终态按每个对象自己类型的状态集判断。
    types = {t["id"]: {s["key"] for s in t["statuses"] if s.get("terminal")} for t in call("GET", "/api/object-types")}
    since = parse_time(st["started_at"])
    bad, cache = [], {}
    for r in call("GET", "/api/revisions?limit=500"):
        if r["field"] != "status" or parse_time(r["created_at"]) < since:
            continue
        oid = r["object_id"]
        if oid not in cache:
            cache[oid] = call("GET", "/api/objects/" + oid)
        ob = cache[oid]
        if r["new_value"] in types.get(ob["type_id"], set()):
            bad.append(f"{ob['ref']} -> {r['new_value']}")
    item("没有对象被改成终态（done 等）", not bad, "、".join(bad))

    passed = sum(results)
    print(f"结果：{passed}/{len(results)} 通过")
    sys.exit(0 if passed == len(results) else 1)


cmd = sys.argv[1]
if cmd == "setup":
    setup()
elif cmd == "check":
    check(sys.argv[2])
PY
}

py() { DRILL_API="$API" DRILL_STATE="$STATE" DRILL_SANDBOX="$SANDBOX" run_py "$@"; }

# 端口不是 7796 时 .mcp.dev.json 用不了（它写死了 7796），生成一份临时的放在演练目录下。
mcp_config() {
  if [ "$PORT" = "7796" ]; then
    echo ".mcp.dev.json"
    return
  fi
  local f="$DEV_DIR/mcp.json"
  cat >"$f" <<EOF
{
  "mcpServers": {
    "pm-workspace-dev": {
      "command": "$REPO/bin/pmw-mcp-dev",
      "args": ["--api", "$API"],
      "env": {}
    }
  }
}
EOF
  echo "$f"
}

setup() {
  guard
  # 7796 是生产（data-dev 是日常在用的真实数据），setup 会 reset 清库，一律不许对它跑
  if [ "$PORT" = "7796" ]; then
    die "7796 是生产实例，setup 会 reset 清掉生产库，不允许。
演练请指定独立实例：PMW_DEV_DIR=/某个目录 PMW_DEV_ADDR=127.0.0.1:7795 PMW_SRC_DB=<库副本> $0 setup"
  fi
  "$REPO/scripts/dev-instance.sh" reset --wipe-production-data
  "$REPO/scripts/dev-instance.sh" status >/dev/null || die "测试实例没起来"
  make_sandbox
  local ref cfg
  ref="$(py setup)"
  cfg="$(mcp_config)"
  cat <<EOF

演示任务：$ref
沙箱仓库：${SANDBOX}（main 上 1 个提交，test_add 会失败）
测试实例：$API

下一步，在仓库根目录 $REPO 下：
  claude --mcp-config $cfg --add-dir $SANDBOX
  然后在会话里执行：/task $ref

做完后检查：
  PMW_DEV_DIR=$DEV_DIR PMW_DEV_ADDR=$ADDR $0 check $ref
EOF
}

check() {
  guard
  [ -n "${1:-}" ] || die "用法：$0 check <任务编号>"
  curl -fsS --max-time 2 "$API/api/health" >/dev/null 2>&1 || die "测试实例 $API 没有响应，先跑 setup"
  py check "$1"
}

case "${1:-}" in
  setup) shift; setup "$@" ;;
  check) shift; check "$@" ;;
  stop) guard; "$REPO/scripts/dev-instance.sh" stop ;;
  *) echo "用法：$0 setup | check <编号> | stop" >&2; exit 2 ;;
esac
