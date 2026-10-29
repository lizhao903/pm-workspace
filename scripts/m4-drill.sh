#!/bin/bash
# M4 端到端演练（QA-05）：一条 IM 消息转成任务、分配给 Agent，Agent 调需确认的写工具，确认后执行记录变 done；
# 再用定时任务发起一条 SOP 跑到结束。每步打印检查结果，全过才 0 退出。
#
#   scripts/m4-drill.sh
#
# 自己起一套临时环境，跑完按 pid 关掉，不碰正式实例 7777、共用测试实例 7796 和 data/pm.db：
#   - 后端：go build 编到演练目录，用演练目录里的库，带 --fake-im --fake-connector --vault-keychain=false
#   - 模型：内嵌的假 Ollama（标准库 Python，随机端口），只认 /api/tags 和 /api/chat，不联网
#
# 环境变量（都可省）：
#   PMW_DRILL_DIR     演练目录（默认 $TMPDIR/pmw-m4-drill），每次开跑先清空；通过后删掉，没通过留着看日志
#   PMW_DRILL_ADDR    临时后端监听地址（默认 127.0.0.1:7785）
#   PMW_DRILL_BIN     用现成的 pmw 二进制，不重新编译
#   PMW_DRILL_SRC_DB  从这个库复制副本起（sqlite3 -readonly .backup），不给就从空库起；
#                     副本里已有的定时任务和 Agent 先停用，免得它们在演练中途跑起来
#   PMW_DRILL_KEEP=1  通过了也留着演练目录
#
# 几条约束：
#   1. 拒绝 7777、7796 端口，拒绝 data/ 下的库和目录。
#   2. 停进程只按自己记下的 pid，停之前核对命令行，不用 pkill。
#   3. 不访问外部网络：服务商是本机假 Ollama，连接器是内置假连接器，IM 走假适配器的回调。

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DIR="${PMW_DRILL_DIR:-${TMPDIR:-/tmp}/pmw-m4-drill}"
DIR="${DIR%/}"
ADDR="${PMW_DRILL_ADDR:-127.0.0.1:7785}"
PORT="${ADDR##*:}"
API="http://$ADDR"
PY=/usr/bin/python3
[ -x "$PY" ] || PY=python3

PMW_PID=""
OLLAMA_PID=""
DRILL_OK=0 # bash 3.2 在函数里因 set -u 退出时 EXIT trap 拿到的 $? 是 0，成功与否另记

die() { echo "m4-drill: $*" >&2; exit 1; }

guard() {
  case "$PORT" in
    7777) die "端口 7777 是正式实例，演练只能用自己的临时后端" ;;
    7796) die "端口 7796 是共用的测试实例，演练只能用自己的临时后端" ;;
  esac
  case "$DIR" in
    "" | "/" | "$HOME" | "$REPO" | "$REPO"/*) die "演练目录不能是 ${DIR}（放到 scratchpad 或 /tmp 下）" ;;
  esac
  if [ -n "${PMW_DRILL_SRC_DB:-}" ]; then
    local src
    src="$(cd "$(dirname "$PMW_DRILL_SRC_DB")" 2>/dev/null && pwd)/$(basename "$PMW_DRILL_SRC_DB")"
    case "$src" in
      "$REPO"/data/*) die "不复制 data/ 下的正式库：$src" ;;
    esac
    [ -f "$src" ] || die "源库不存在：$src"
  fi
}

# 只停自己起的进程：pid 还在且命令行对得上才发信号，等它退出，最后确认已经不在了。
stop_pid() {
  local pid="$1" want="$2" name="$3" i
  [ -n "$pid" ] || return 0
  if kill -0 "$pid" 2>/dev/null; then
    if ps -p "$pid" -o command= | grep -qF -- "$want"; then
      kill "$pid" 2>/dev/null || true
      for i in $(seq 1 50); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.1
      done
      kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
    else
      echo "m4-drill: pid $pid 的命令行不是${name}，不动它" >&2
      return 1
    fi
  fi
  wait "$pid" 2>/dev/null || true
  if kill -0 "$pid" 2>/dev/null; then
    echo "m4-drill: ${name}（pid ${pid}）没有退出" >&2
    return 1
  fi
}

cleanup() {
  local code=$? ok=1
  trap - EXIT INT TERM
  [ "$DRILL_OK" = 1 ] || [ "$code" != 0 ] || code=1
  stop_pid "$PMW_PID" "$DIR/pm.db" "临时后端" || ok=0
  stop_pid "$OLLAMA_PID" "$DIR/ollama.port" "假 Ollama" || ok=0
  if [ "$ok" = 1 ] && [ -n "$PMW_PID$OLLAMA_PID" ]; then
    echo "清理：临时后端和假 Ollama 已退出"
  fi
  [ "$ok" = 1 ] || code=1
  if [ "$code" = 0 ] && [ "${PMW_DRILL_KEEP:-}" != 1 ]; then
    rm -rf "$DIR"
    echo "清理：删掉了演练目录 $DIR"
  elif [ -d "$DIR" ]; then
    echo "演练目录留着：${DIR}（后端日志 pmw.log，假 Ollama 日志 ollama.log）"
  fi
  exit "$code"
}

# 假 Ollama：第一轮让模型调名字以 __create_item 结尾的连接器工具，工具结果回来后给一句总结。
start_ollama() {
  "$PY" - "$DIR/ollama.port" "$DIR/ollama.log" >"$DIR/ollama.out" 2>&1 <<'PY' &
import json, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT_FILE, LOG = sys.argv[1], sys.argv[2]
MODEL = "drill-model"
FINAL = "演练完成：已在测试连接器里建好条目「M4 演练条目」。"


def log(entry):
    with open(LOG, "a") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body, ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/tags":
            self.send(200, json.dumps({"models": [{"name": MODEL}]}).encode())
        else:
            self.send(404, b"{}")

    def do_POST(self):
        if self.path != "/api/chat":
            self.send(404, b"{}")
            return
        req = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        msgs = req.get("messages") or []
        tools = [t.get("function", {}).get("name", "") for t in req.get("tools") or []]
        roles = [m.get("role", "") for m in msgs]
        tail = msgs[-1] if msgs else {}
        # 确认后接着跑的那一轮：历史按文字回放，最后是一条 system「用户确认了……已经执行」；同一轮里的工具结果也算
        if roles[-1:] == ["tool"] or (tail.get("role") == "system" and "已经执行" in (tail.get("content") or "")):
            msg = {"role": "assistant", "content": FINAL}
            reply = "final"
        else:
            name = next((t for t in tools if t.endswith("__create_item")), "")
            if name:
                msg = {"role": "assistant", "content": "",
                       "tool_calls": [{"function": {"name": name, "arguments": {"title": "M4 演练条目"}}}]}
                reply = "tool:" + name
            else:
                msg = {"role": "assistant", "content": "没有可用的写工具。"}
                reply = "no_tool"
        # 假连接器 create_item 回的是 {"tool", "ok": true, "args"}，确认后那一轮的提示里应该带着它
        got = "create_item" in (tail.get("content") or "") and '"ok":true' in (tail.get("content") or "").replace(" ", "")
        log({"model": req.get("model"), "roles": roles, "tools": tools, "reply": reply, "tool_output": got})
        lines = [{"model": MODEL, "message": msg, "done": False},
                 {"model": MODEL, "message": {"role": "assistant", "content": ""}, "done": True}]
        self.send(200, "".join(json.dumps(x, ensure_ascii=False) + "\n" for x in lines).encode(), "application/x-ndjson")


srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
with open(PORT_FILE + ".tmp", "w") as f:
    f.write(str(srv.server_address[1]))
import os
os.rename(PORT_FILE + ".tmp", PORT_FILE)
srv.serve_forever()
PY
  OLLAMA_PID=$!
  local i
  for i in $(seq 1 50); do
    [ -s "$DIR/ollama.port" ] && break
    kill -0 "$OLLAMA_PID" 2>/dev/null || die "假 Ollama 没起来：$(cat "$DIR/ollama.out")"
    sleep 0.1
  done
  [ -s "$DIR/ollama.port" ] || die "假 Ollama 没有写出端口"
}

prepare_db() {
  if [ -z "${PMW_DRILL_SRC_DB:-}" ]; then
    echo "库：从空库起（$DIR/pm.db）"
    return
  fi
  command -v sqlite3 >/dev/null || die "复制源库要用 sqlite3"
  sqlite3 -readonly "$PMW_DRILL_SRC_DB" ".backup '$DIR/pm.db'"
  # 副本是演练自己的，停掉里面已有的定时任务和 Agent（表还没有就跳过）
  sqlite3 "$DIR/pm.db" "UPDATE schedules SET enabled = 0;" 2>/dev/null || true
  sqlite3 "$DIR/pm.db" "UPDATE agents SET enabled = 0;" 2>/dev/null || true
  echo "库：$PMW_DRILL_SRC_DB 的副本（$DIR/pm.db），已有的定时任务和 Agent 已停用"
}

start_pmw() {
  if curl -s --max-time 1 "$API/api/health" >/dev/null 2>&1; then
    die "$ADDR 上已经有服务在跑，换一个 PMW_DRILL_ADDR"
  fi
  "$BIN" --db "$DIR/pm.db" --addr "$ADDR" --vault-keychain=false --fake-im --fake-connector \
    --public-url "$API" >"$DIR/pmw.log" 2>&1 &
  PMW_PID=$!
  local i
  for i in $(seq 1 100); do
    curl -fsS --max-time 1 "$API/api/health" >/dev/null 2>&1 && return 0
    kill -0 "$PMW_PID" 2>/dev/null || die "临时后端没起来：$(tail -n 20 "$DIR/pmw.log")"
    sleep 0.2
  done
  die "临时后端 30 秒内没有响应：$(tail -n 20 "$DIR/pmw.log")"
}

# 演练步骤：全走临时后端的 HTTP 接口，标准库 Python。检查行不带 id，两次跑的输出可以直接比。
run_steps() {
  DRILL_API="$API" DRILL_OLLAMA="http://127.0.0.1:$(cat "$DIR/ollama.port")" DRILL_OLLAMA_LOG="$DIR/ollama.log" \
    "$PY" - <<'PY'
import datetime, json, os, sys, time, urllib.error, urllib.request

API = os.environ["DRILL_API"]
OLLAMA = os.environ["DRILL_OLLAMA"]
OLLAMA_LOG = os.environ["DRILL_OLLAMA_LOG"]
results = []


def call(method, path, body=None, want=None, raw=False, timeout=15):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(API + path, data=data, method=method,
                                 headers={"Content-Type": "application/json", "X-Actor-Source": "ui", "X-Actor-Name": "m4-drill"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            code, text = r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        code, text = e.code, e.read().decode(errors="replace")
    if want is not None and code not in want:
        fail(f"{method} {path} 回 {code}：{text[:300]}")
    if raw:
        return code, text
    return code, (json.loads(text).get("data") if text.strip() else None)


def item(name, ok, detail=""):
    results.append(ok)
    print(f"  [{'通过' if ok else '不通过'}] {name}" + (f"：{detail}" if detail else ""), flush=True)
    return ok


def fail(why):
    item("接口调用", False, why)
    finish()


def finish():
    passed = sum(results)
    print(f"结果：{passed}/{len(results)} 通过", flush=True)
    sys.exit(0 if results and passed == len(results) else 1)


def must(name, ok, detail=""):
    if not item(name, ok, detail):
        finish()


def poll(fn, ok, timeout=30, every=0.3):
    end = time.time() + timeout
    v = fn()
    while not ok(v) and time.time() < end:
        time.sleep(every)
        v = fn()
    return v


def step(title):
    print(f"\n{title}", flush=True)


# 1. 插件：装上并启用 im、sop（sop 的 network:any 在演练库里确认）
step("1. 装插件")
_, plugins = call("GET", "/api/plugins", want=[200])
for pid in ("im", "sop"):
    p = next((x for x in plugins if x["id"] == pid), None)
    must(f"二进制里有 {pid} 插件", p is not None)
    if not p["installed"]:
        call("POST", f"/api/plugins/{pid}/install", {"permissions": p["permissions"]}, want=[200, 201])
    elif p.get("upgradable"):
        call("POST", f"/api/plugins/{pid}/upgrade", {"permissions": p["permissions"]}, want=[200])
    if not p["enabled"] or not p["installed"]:
        call("POST", f"/api/plugins/{pid}/enable", {}, want=[200])
_, plugins = call("GET", "/api/plugins", want=[200])
for pid in ("im", "sop"):
    p = next(x for x in plugins if x["id"] == pid)
    must(f"{pid} 插件在跑", p["running"] and not p.get("upgradable"), f"版本 {p['version']}")
_, adapters = call("GET", "/api/im/adapters", want=[200])
must("IM 有假适配器 fake（回调）", any(a["key"] == "fake" and a["callback"] for a in adapters))

# 2. 连接器和服务商
step("2. 接假连接器、假模型服务商")
_, cn = call("POST", "/api/connectors", {"tool": "fake", "name": "演练连接器", "secrets": {"token": "drill-token"}}, want=[201])
_, t = call("POST", f"/api/connectors/{cn['id']}/test", {}, want=[200])
must("假连接器连通", t["ok"] and t["connector"]["status"] == "connected", f"状态 {t['connector']['status']}")
_, rf = call("POST", f"/api/connectors/{cn['id']}/tools/refresh", {}, want=[200])
modes = {x["name"]: x["mode"] for x in rf["connector"]["tools"]}
must("假连接器的 create_item 默认需确认", modes.get("create_item") == "confirm", f"{modes.get('create_item')}")
_, pv = call("POST", "/api/agent-providers",
             {"name": "演练假 Ollama", "kind": "ollama", "base_url": OLLAMA, "model": "drill-model", "enabled": True, "api_key": ""},
             want=[200, 201])
_, pt = call("POST", f"/api/agent-providers/{pv['id']}/test", {}, want=[200])
must("假服务商连通、模型列表有 drill-model", pt["ok"] and "drill-model" in (pt.get("models") or []), pt.get("message", ""))

# 3. Agent：任务分配给它时触发，挂假连接器，create_item 需确认
step("3. 建任务触发的 Agent")
_, ag = call("POST", "/api/agents", {
    "name": "M4 演练助手", "desc": "QA-05 演练用", "provider_id": pv["id"], "model": "drill-model",
    "instructions": "任务分配给你时，在测试连接器里建一条条目。", "mcps": [cn["id"]],
    "triggers": [{"kind": "task", "detail": "任务分配给它", "match": {"assigned": True}}],
}, want=[201])
key = f"conn:{cn['id']}:create_item"
_, gr = call("PUT", f"/api/agents/{ag['id']}/grants", {"grants": {"read_tasks": "auto", key: "auto"}}, want=[200])
must("Agent 的 create_item 实际档位是需确认（连接器上限压下来）", gr["effective"].get(key) == "confirm",
     f"授权 {gr['grants'].get(key)}，实际 {gr['effective'].get(key)}")

# 4. IM 消息进来，转任务
step("4. 灌一条 IM 消息，转任务")
ext = "C_M4DRILL:" + datetime.datetime.now().strftime("%Y%m%d%H%M%S.%f")
_, got = call("POST", "/api/im/callbacks/fake", {"messages": [{
    "external_id": ext, "connector_id": cn["id"], "conversation_id": "C_M4DRILL", "conversation_kind": "group",
    "conversation_name": "#m4-drill", "sender_id": "U_DRILL", "sender_name": "演练同事",
    "text": "@我 帮忙在测试连接器里建一条「M4 演练条目」",
}]}, want=[200])
must("回调落库 1 条", len(got["ids"]) == 1 and got["duplicates"] == 0, f"{len(got['ids'])} 条新、{got['duplicates']} 条重复")
mid = got["ids"][0]
_, msg = call("GET", f"/api/im/messages/{mid}", want=[200])
must("消息待处理、与我相关、记着连接器", msg["status"] == "pending" and msg["relevance"] == "me" and msg["connector_id"] == cn["id"],
     f"status={msg['status']} relevance={msg['relevance']}")
code, _ = call("POST", "/api/im/callbacks/fake", {"messages": [{"external_id": ext, "sender_id": "U_DRILL", "text": "重复"}]}, raw=True)
_, again = call("GET", "/api/im/messages?channel=slack&limit=200", want=[200])
must("同一条重复到达只落一次", code == 200 and sum(1 for m in again if m["external_id"] == ext) == 1)
_, conv = call("POST", f"/api/im/messages/{mid}/task", {"title": "M4 演练：在测试连接器建条目", "priority": "P2", "done": True}, want=[201])
task = conv["task"]
must("转出 source=im 的任务", task["source"] == "im" and task["ref"].startswith("TSK-"), f"source={task['source']}")
must("消息标成处理完、记着任务", conv["message"]["status"] == "done" and conv["message"]["task_id"] == task["id"],
     f"status={conv['message']['status']}")
code, _ = call("POST", f"/api/im/messages/{mid}/task", {}, raw=True)
must("同一条消息不能再转一次", code == 409, f"回 {code}")
_, runs0 = call("GET", f"/api/agent-runs?agent={ag['id']}", want=[200])
must("转任务时还没分配，Agent 没被触发", len(runs0) == 0, f"{len(runs0)} 条执行记录")

# 5. 分配给 Agent，等它停在确认
step("5. 分配给 Agent，Agent 被触发")
_, obj = call("GET", f"/api/objects/{task['id']}", want=[200])
props = dict(obj.get("props") or {})
props["agent_id"] = ag["id"]
_, obj = call("PATCH", f"/api/objects/{task['id']}", {"props": props}, want=[200])
must("任务的 props 记着 agent_id、来源消息还在",
     obj["props"].get("agent_id") == ag["id"] and (obj["props"].get("source_ref") or {}).get("message_id") == mid)


def runs():
    return call("GET", f"/api/agent-runs?agent={ag['id']}", want=[200])[1]


rs = poll(runs, lambda v: len(v) >= 1 and v[0]["status"] != "running")
must("分配后起了 1 条执行记录", len(rs) == 1, f"{len(rs)} 条")
run = rs[0]
must("执行记录是任务触发、来源是这条任务", run["trigger_kind"] == "task" and run["source_id"] == task["id"]
     and run["event_key"] == "task:" + task["id"], run["trigger"])
must("执行记录停在等你确认、1 处待确认", run["status"] == "waiting" and run["pending"] == 1,
     f"status={run['status']} pending={run['pending']} {run['summary']}")
_, det = call("GET", f"/api/agent-runs/{run['id']}", want=[200])
calls = det["tool_calls"]
must("待确认的是连接器的 create_item", len(calls) == 1 and calls[0]["grant_key"] == key and calls[0]["state"] == "pending",
     "、".join(f"{c['tool']}（{c['state']}）" for c in calls))
_, sess = call("GET", f"/api/agent/sessions?object_id={task['id']}", want=[200])
must("执行建的会话挂在任务下、挂着这个 Agent",
     any(s["id"] == run["session_id"] and s.get("agent_id") == ag["id"] for s in sess))

# 6. 确认，接着跑完
step("6. 确认写工具，执行记录变 done")
code, text = call("POST", f"/api/agent/tool-calls/{calls[0]['id']}/confirm", {}, raw=True, timeout=60)
events = []
for line in text.splitlines():
    if line.startswith("data:"):
        try:
            events.append(json.loads(line[5:].strip()))
        except ValueError:
            pass
kinds = [e.get("type") for e in events]
must("确认的流里有 tool_result 和 done、没有 error", code == 200 and "tool_result" in kinds and "done" in kinds and "error" not in kinds,
     "、".join(k or "?" for k in kinds))
must("确认后没有再要确认", "confirm" not in kinds)
rs = poll(runs, lambda v: v and v[0]["status"] not in ("running", "waiting"))
run = rs[0]
must("执行记录 done、没有待确认", run["status"] == "done" and run["pending"] == 0, f"status={run['status']} pending={run['pending']}")
must("summary 是 Agent 最后一句", run["summary"].startswith("演练完成"), run["summary"][:60])
_, det = call("GET", f"/api/agent-runs/{run['id']}", want=[200])
tc = det["tool_calls"][0]
must("调用记录已确认、结果记下了", tc["state"] == "confirmed" and tc["result"] != "", f"{tc['state']}：{tc['result']}")
with open(OLLAMA_LOG) as f:
    seen = [json.loads(x) for x in f if x.strip()]
must("模型被调了两轮：先调工具、再总结", [s["reply"].split(":")[0] for s in seen] == ["tool", "final"],
     "、".join(s["reply"] for s in seen))
must("连接器工具真的执行了，结果交回了模型", len(seen) == 2 and seen[1]["tool_output"])
time.sleep(0.5)
must("同一任务只触发一次", len(runs()) == 1)

# 7. 定时任务发起 SOP
step("7. 定时任务发起一条 SOP，跑到结束")
_, flow = call("POST", "/api/sop/flows", {
    "name": "M4 演练流程", "desc": "QA-05 演练用", "trigger": "定时任务",
    "fields": [{"key": "topic", "label": "主题", "type": "text", "default": "M4 演练"}],
    "steps": [
        {"key": "draft", "name": "拼一句话", "kind": "template", "config": {"template": "本周主题：{{topic}}", "output": "text"}},
        {"key": "pass", "name": "透传", "kind": "auto", "after": ["draft"]},
    ],
}, want=[201])
later = (datetime.datetime.now() + datetime.timedelta(hours=12)).strftime("%H:%M")
_, sch = call("POST", "/api/schedules", {"name": "M4 演练：发起 SOP", "enabled": True,
                                         "rule": {"freq": "daily", "time": later},
                                         "action": {"kind": "sop", "sop_id": flow["id"]}}, want=[201])
_, sr = call("POST", f"/api/schedules/{sch['id']}/run", {}, want=[201])
spr = "spr_" + sr["text"].split("spr_", 1)[1].split()[0].strip("，。") if "spr_" in sr["text"] else ""
must("定时任务执行成功、发起了 SOP", sr["status"] == "ok" and spr != "", sr["text"].replace(spr, "spr_…") if spr else sr["text"])


def sop_run():
    return call("GET", f"/api/sop/runs/{spr}", want=[200])[1]


r = poll(sop_run, lambda v: v["status"] in ("done", "failed", "stopped", "waiting"))
must("SOP 执行跑到 done", r["status"] == "done", f"status={r['status']}")
must("每一步都 done", all(s["status"] == "done" for s in r["steps"]), "、".join(f"{s['key']}={s['status']}" for s in r["steps"]))
out = (r["steps"][0].get("output") or {}).get("text")
must("模板步骤按默认输入出了结果", out == "本周主题：M4 演练", str(out))
_, srs = call("GET", f"/api/schedules/{sch['id']}/runs", want=[200])
must("定时任务记了 1 条手动执行", len(srs) == 1 and srs[0]["manual"] and srs[0]["ok"])

finish()
PY
}

main() {
  guard
  rm -rf "$DIR"
  mkdir -p "$DIR"
  trap cleanup EXIT
  trap 'exit 130' INT TERM

  echo "M4 演练（QA-05）：临时后端 ${API}，演练目录 ${DIR}"
  if [ -n "${PMW_DRILL_BIN:-}" ]; then
    BIN="$PMW_DRILL_BIN"
    [ -x "$BIN" ] || die "PMW_DRILL_BIN 不可执行：$BIN"
  else
    BIN="$DIR/pmw"
    echo "编译：go build ./cmd/pmw -> $BIN"
    (cd "$REPO" && go build -ldflags "-X main.version=drill" -o "$BIN" ./cmd/pmw) || die "编译失败"
  fi
  prepare_db
  start_ollama
  echo "假 Ollama：127.0.0.1:$(cat "$DIR/ollama.port")（pid ${OLLAMA_PID}）"
  start_pmw
  echo "临时后端：${API}（pid ${PMW_PID}）"
  run_steps
  DRILL_OK=1
}

main "$@"
