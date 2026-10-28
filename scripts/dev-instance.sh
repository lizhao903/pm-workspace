#!/bin/bash
# 测试实例：用真实库的副本在另一个端口跑一个临时编译的 pmw。
#
# 用途是让 Claude Code 通过 MCP 演练「领任务 → 记进展 → 提交验收」这一串写操作，
# 而不碰 127.0.0.1:7777 上那个正在服务的进程和 data/pm.db。
#
#   scripts/dev-instance.sh start    编译 bin/pmw-dev，没有副本就先复制一份，然后在 7796 启动
#   scripts/dev-instance.sh stop     按 pid 文件停掉本脚本起的那个进程
#   scripts/dev-instance.sh status   进程是否在、健康检查是否通
#   scripts/dev-instance.sh reset    停掉、丢弃副本、重新从真实库复制、再启动
#
# 几条硬约束，改脚本时别破坏：
#   1. 只按自己写下的 pid 停进程，并且停之前核对这个 pid 的命令行确实是 bin/pmw-dev
#      且指向副本库。pid 会被系统复用，只看文件里的数字可能误杀别人的进程。
#      不用 pkill -f：那会把 7777 上的正式实例一起带走。
#   2. 复制真实库用 sqlite3 的 .backup：它走 SQLite 的在线备份接口，WAL 里还没
#      checkpoint 的数据也会带上，而且只读源库。直接 cp pm.db 会丢掉 WAL 里的写入，
#      还可能复制到写了一半的页。
#   3. 不写 bin/pmw、bin/pmw-mcp：那是正式实例和 .mcp.json 在用的产物。
#      测试实例用 bin/pmw-dev，测试 MCP 用 bin/pmw-mcp-dev。
#
# 可用环境变量覆盖：
#   PMW_DEV_DIR   副本库、pid、日志所在目录（默认 $TMPDIR/pmw-devinst）
#   PMW_DEV_ADDR  监听地址（默认 127.0.0.1:7796）
#   PMW_SRC_DB    被复制的真实库（默认 <仓库>/data/pm.db）

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DEV_DIR="${PMW_DEV_DIR:-${TMPDIR:-/tmp}/pmw-devinst}"
DEV_DIR="${DEV_DIR%/}"
ADDR="${PMW_DEV_ADDR:-127.0.0.1:7796}"
SRC_DB="${PMW_SRC_DB:-$REPO/data/pm.db}"
BIN="$REPO/bin/pmw-dev"
BIN_MCP="$REPO/bin/pmw-mcp-dev"
DB="$DEV_DIR/pm.db"
PID_FILE="$DEV_DIR/pmw.pid"
LOG="$DEV_DIR/pmw.log"
PORT="${ADDR##*:}"

die() { echo "dev-instance: $*" >&2; exit 1; }

# 护栏：任何一项配置指回了正式实例，就拒绝执行。
guard() {
  [ "$PORT" != "7777" ] || die "端口 7777 是正式实例，测试实例不能用"
  local src_real db_real
  src_real="$(cd "$(dirname "$SRC_DB")" 2>/dev/null && pwd)/$(basename "$SRC_DB")"
  mkdir -p "$DEV_DIR"
  db_real="$(cd "$DEV_DIR" && pwd)/pm.db"
  [ "$src_real" != "$db_real" ] || die "副本路径和真实库是同一个文件：$db_real"
  case "$db_real" in
    "$REPO/data/"*) die "副本不能放在 $REPO/data/ 下" ;;
  esac
}

# alive_pid 输出 pid 文件里记的、且确实是本脚本起的那个进程的 pid；否则什么都不输出。
alive_pid() {
  [ -f "$PID_FILE" ] || return 0
  local pid cmd
  pid="$(tr -cd '0-9' < "$PID_FILE")"
  [ -n "$pid" ] || return 0
  cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
  # 命令行必须同时含 pmw-dev 和副本库路径，才认是自己的进程。
  case "$cmd" in
    *"$BIN"*"$DB"*) echo "$pid" ;;
  esac
}

health() {
  curl -fsS --max-time 2 "http://$ADDR/api/health" 2>/dev/null
}

build() {
  echo "编译 $BIN 与 $BIN_MCP"
  # webui 的 //go:embed 要求 dist 至少有一个文件，和 Makefile 的 placeholder 同一个道理。
  if [ ! -f "$REPO/internal/webui/dist/index.html" ]; then
    (cd "$REPO" && make placeholder >/dev/null)
  fi
  (cd "$REPO" && go build -ldflags "-X main.version=dev" -o "$BIN" ./cmd/pmw)
  (cd "$REPO" && go build -ldflags "-X main.version=dev" -o "$BIN_MCP" ./cmd/pmw-mcp)
}

copy_db() {
  command -v sqlite3 >/dev/null || die "需要 sqlite3 命令行（用它的 .backup 做在线复制）"
  [ -f "$SRC_DB" ] || die "真实库不存在：$SRC_DB"
  rm -f "$DB" "$DB-wal" "$DB-shm"
  echo "复制 $SRC_DB -> ${DB}（sqlite3 .backup）"
  # -readonly：源库只读打开，杜绝任何意外写入。
  sqlite3 -readonly "$SRC_DB" ".backup '$DB'"
  [ -s "$DB" ] || die "复制失败：$DB 为空"
}

start() {
  guard
  local pid
  pid="$(alive_pid)"
  if [ -n "$pid" ]; then
    echo "测试实例已在运行：pid=$pid http://$ADDR"
    return 0
  fi
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    die "端口 $PORT 已被别的进程占用（不是本脚本起的），不启动"
  fi
  build
  [ -f "$DB" ] || copy_db
  # 测试实例的保险箱主密钥只用副本目录下的密钥文件，不碰钥匙串
  echo "启动：$BIN --db $DB --addr $ADDR --vault-keychain=false"
  nohup "$BIN" --db "$DB" --addr "$ADDR" --vault-keychain=false >>"$LOG" 2>&1 &
  echo $! >"$PID_FILE"
  for _ in $(seq 1 50); do
    if health >/dev/null; then
      echo "测试实例已启动：pid=$(cat "$PID_FILE") http://$ADDR  日志 $LOG"
      return 0
    fi
    sleep 0.2
  done
  die "启动后 10 秒内健康检查没通过，看日志：$LOG"
}

stop() {
  local pid
  pid="$(alive_pid)"
  if [ -z "$pid" ]; then
    echo "测试实例没有在运行（或 pid 文件里的进程不是本脚本起的，不动它）"
    rm -f "$PID_FILE"
    return 0
  fi
  echo "停止 pid=$pid"
  kill -TERM "$pid"
  for _ in $(seq 1 50); do
    kill -0 "$pid" 2>/dev/null || { rm -f "$PID_FILE"; echo "已停止"; return 0; }
    sleep 0.2
  done
  echo "10 秒内没退出，发 KILL"
  kill -KILL "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
}

status() {
  local pid
  pid="$(alive_pid)"
  if [ -z "$pid" ]; then
    echo "未运行（目录 ${DEV_DIR}）"
    return 1
  fi
  echo "运行中：pid=$pid http://$ADDR  库 $DB"
  health && echo || echo "健康检查未通过，看日志：$LOG"
}

reset() {
  guard
  stop
  copy_db
  start
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  reset) reset ;;
  *) echo "用法：$0 start|stop|status|reset" >&2; exit 2 ;;
esac
