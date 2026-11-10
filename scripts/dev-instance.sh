#!/bin/bash
# 测试实例：用真实库的副本在另一个端口跑一个临时编译的 pmw。
#
# 用途是让 Claude Code 通过 MCP 演练「领任务 → 记进展 → 提交验收」这一串写操作，
# 而不碰 127.0.0.1:7777 上那个正在服务的进程和 data/pm.db。
#
#   scripts/dev-instance.sh start    编译 bin/pmw-dev 并在 7796 启动（库不存在时报错，不自动复制）
#   scripts/dev-instance.sh stop     按 pid 文件停掉本脚本起的那个进程
#   scripts/dev-instance.sh status   进程是否在、健康检查是否通
#   scripts/dev-instance.sh reset --wipe-production-data
#                                    停掉、丢弃副本、重新从真实库复制、再启动。
#                                    7796 早已是生产（data-dev 是日常在用的真实数据），reset 等于清库：
#                                    必须带确认参数；目标库有数据时先整库备份到 backups/；源库没有数据时一律拒绝。
#                                    2026-11-10 曾被直接 reset，用 data/ 下的空库覆盖了生产库，靠迁移快照才找回
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
#   4. start 发现库文件不存在时不自动复制：生产库丢了应该从 backups/ 恢复，
#      自动拿 data/pm.db 顶上只会悄悄换成一个空库。首次搭建用 reset。
#
# 可用环境变量覆盖：
#   PMW_DEV_DIR   副本库、附件、备份、pid、日志所在目录（默认 <仓库>/data-dev，不入库）。
#                 不要指到 $TMPDIR 或 Claude 的临时目录：7796 上是日常在用的数据，附件（IM 截图）也落在这里，临时目录会被清掉
#   PMW_DEV_ADDR  监听地址（默认 127.0.0.1:7796）
#   PMW_SRC_DB    被复制的真实库（默认 <仓库>/data/pm.db）
#   PMW_DEV_SKIP_UI=1  编译时不重建正式前端（默认每次 start 都 make frontend 再嵌进去）
#   PMW_DEV_TLS_ADDR  HTTPS 监听地址（默认 127.0.0.1:7443）。<仓库>/certs/ 下有 scripts/setup-tls.sh 签的证书时才监听，
#                 配合 scripts/setup-local-domain.sh 的 pf 转发（443 -> 7443）让 https://bro.vip 直达，见 docs/local-domain.md
#   PMW_DEV_DSH_BIN  deepseek-harness 的 dsh（执行器 DeepSeek，见 docs/deepseek-harness.md）。默认：装在 ~/.local/share/pmw-dsh 时用它，否则不传、走 PATH
#   PMW_DEV_NO_BUILD=1  不重新编译，沿用现有的 bin/pmw-dev 启动：只改启动参数时用，免得把工作区里没提交的改动（和迁移）带上线
#   PMW_DEV_PUBLIC_URL  浏览器访问工作台的地址，OAuth 回调由它拼出。默认：有证书时 https://bro.vip，没有时 http://<PMW_DEV_ADDR>

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DEV_DIR="${PMW_DEV_DIR:-$REPO/data-dev}"
DEV_DIR="${DEV_DIR%/}"
ADDR="${PMW_DEV_ADDR:-127.0.0.1:7796}"
SRC_DB="${PMW_SRC_DB:-$REPO/data/pm.db}"
BIN="$REPO/bin/pmw-dev"
BIN_MCP="$REPO/bin/pmw-mcp-dev"
DB="$DEV_DIR/pm.db"
PID_FILE="$DEV_DIR/pmw.pid"
LOG="$DEV_DIR/pmw.log"
PORT="${ADDR##*:}"
TLS_ADDR="${PMW_DEV_TLS_ADDR:-127.0.0.1:7443}"
DSH_DEFAULT="$HOME/.local/share/pmw-dsh/node_modules/.bin/dsh"
DSH_BIN="${PMW_DEV_DSH_BIN:-}"
[ -n "$DSH_BIN" ] || { [ -x "$DSH_DEFAULT" ] && DSH_BIN="$DSH_DEFAULT"; } || true
TLS_CERT="$REPO/certs/pmw.pem"
TLS_KEY="$REPO/certs/pmw-key.pem"

die() { echo "dev-instance: $*" >&2; exit 1; }

# 护栏：任何一项配置指回了正式实例，就拒绝执行。
guard() {
  [ "$PORT" != "7777" ] || die "端口 7777 是正式实例，测试实例不能用"
  # 只给本机用：监听地址必须是回环，写成 0.0.0.0 或内网 IP 内网其他设备就能直接访问
  local a
  for a in "$ADDR" "$TLS_ADDR"; do
    case "$a" in
      127.0.0.1:*|localhost:*|"[::1]":*) ;;
      *) die "监听地址 $a 不是回环地址，内网其他设备会访问到；只允许 127.0.0.1 / localhost / [::1]" ;;
    esac
  done
  local src_real db_real
  src_real="$(cd "$(dirname "$SRC_DB")" 2>/dev/null && pwd)/$(basename "$SRC_DB")"
  mkdir -p "$DEV_DIR"
  db_real="$(cd "$DEV_DIR" && pwd)/pm.db"
  [ "$src_real" != "$db_real" ] || die "副本路径和真实库是同一个文件：$db_real"
  case "$db_real" in
    "$REPO/data/"*) die "副本不能放在 $REPO/data/ 下" ;;
    /tmp/*|/private/tmp/*|/private/var/folders/*|/var/folders/*)
      [ "${PMW_DEV_ALLOW_TMP:-}" = "1" ] || die "副本目录在临时目录里（${DEV_DIR}），会被系统或会话清掉；用默认的 $REPO/data-dev，确实要临时实例时加 PMW_DEV_ALLOW_TMP=1" ;;
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

# pf 把 80 / 443 转到本实例后（scripts/setup-local-domain.sh），直连 127.0.0.1 上的监听端口会被 pf 遮蔽连不上；
# 这时改走域名经 pf 转发，--resolve 把 bro.vip 钉在回环上，不依赖 hosts
health() {
  curl -fsS --max-time 2 "http://$ADDR/api/health" 2>/dev/null && return 0
  curl -fsS --max-time 2 --resolve bro.vip:80:127.0.0.1 "http://bro.vip/api/health" 2>/dev/null
}

build() {
  echo "编译 $BIN 与 $BIN_MCP"
  # 嵌正式前端 frontend/，和 make build 默认一致。只放占位页或沿用旧产物，7796 上看到的就不是原型对应的界面。
  # PMW_DEV_SKIP_UI=1 时跳过前端构建（只改后端时省时间），dist 为空才放占位页。
  if [ "${PMW_DEV_SKIP_UI:-}" != "1" ]; then
    (cd "$REPO" && make frontend >/dev/null) || die "前端构建失败"
  elif [ ! -f "$REPO/internal/webui/dist/index.html" ]; then
    (cd "$REPO" && make placeholder >/dev/null)
  fi
  (cd "$REPO" && go build -ldflags "-X main.version=dev" -o "$BIN" ./cmd/pmw)
  (cd "$REPO" && go build -ldflags "-X main.version=dev" -o "$BIN_MCP" ./cmd/pmw-mcp)
}

# 库里有多少业务对象；不是有效库或没有 objects 表时输出 0
obj_count() {
  sqlite3 -readonly "$1" "select count(*) from objects" 2>/dev/null || echo 0
}

copy_db() {
  command -v sqlite3 >/dev/null || die "需要 sqlite3 命令行（用它的 .backup 做在线复制）"
  [ -f "$SRC_DB" ] || die "真实库不存在：$SRC_DB"
  local src_n dst_n
  src_n="$(obj_count "$SRC_DB")"
  [ "$src_n" -gt 0 ] || die "源库 $SRC_DB 里没有任何对象（空库），拒绝用它覆盖 $DB"
  if [ -f "$DB" ]; then
    dst_n="$(obj_count "$DB")"
    if [ "$dst_n" -gt 0 ]; then
      local bak
      bak="$DEV_DIR/backups/pm-$(date -u +%Y%m%d-%H%M%S)-before-reset.db"
      mkdir -p "$DEV_DIR/backups"
      sqlite3 -readonly "$DB" ".backup '$bak'" || die "覆盖前备份失败，没有动 $DB"
      [ "$(obj_count "$bak")" = "$dst_n" ] || die "覆盖前备份核对不上（${bak}），没有动 $DB"
      echo "覆盖前已备份：${bak}（$dst_n 个对象）"
    fi
  fi
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
  # 有证书就同时监听 HTTPS（本地域名 https://bro.vip 经 pf 443 -> 7443 到这里）；证书只有一半时拒绝启动，不静默降级
  local tls=() public
  if [ -f "$TLS_CERT" ] && [ -f "$TLS_KEY" ]; then
    if lsof -nP -iTCP:"${TLS_ADDR##*:}" -sTCP:LISTEN >/dev/null 2>&1; then
      die "HTTPS 端口 ${TLS_ADDR##*:} 已被别的进程占用，不启动"
    fi
    tls=(--tls-addr "$TLS_ADDR" --tls-cert "$TLS_CERT" --tls-key "$TLS_KEY")
    public="${PMW_DEV_PUBLIC_URL:-https://bro.vip}"
  elif [ -f "$TLS_CERT" ] || [ -f "$TLS_KEY" ]; then
    die "certs/ 下证书和私钥只有一个，重跑 scripts/setup-tls.sh"
  else
    public="${PMW_DEV_PUBLIC_URL:-http://$ADDR}"
  fi
  if [ "${PMW_DEV_NO_BUILD:-}" = "1" ]; then
    [ -x "$BIN" ] || die "PMW_DEV_NO_BUILD=1 但 $BIN 不存在，先正常 start 编译一次"
    echo "不重新编译，沿用 $BIN"
  else
    build
  fi
  [ -f "$DB" ] || die "库不存在：${DB}。生产库丢了从 $DEV_DIR/backups/ 恢复（cp 某份快照到 ${DB}）；确实要从 $SRC_DB 新建用 reset --wipe-production-data"
  local dsh=()
  [ -n "$DSH_BIN" ] && dsh=(--dsh-bin "$DSH_BIN")
  # 保险箱主密钥只用数据目录下的密钥文件，不碰钥匙串
  echo "启动：$BIN --db $DB --addr $ADDR ${tls[*]:-} ${dsh[*]:-} --vault-keychain=false --public-url $public"
  nohup "$BIN" --db "$DB" --addr "$ADDR" ${tls[@]+"${tls[@]}"} ${dsh[@]+"${dsh[@]}"} --vault-keychain=false --public-url "$public" >>"$LOG" 2>&1 &
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
  [ "${1:-}" = "--wipe-production-data" ] || die "reset 会用 $SRC_DB 覆盖 ${DB}（7796 生产库）。确实要清库重来，带上 --wipe-production-data；只是重启用 stop + start"
  guard
  # 先查源库再停服务：源库不能用时不该把正在跑的实例停掉
  [ -f "$SRC_DB" ] || die "真实库不存在：${SRC_DB}，没有停服务"
  [ "$(obj_count "$SRC_DB")" -gt 0 ] || die "源库 $SRC_DB 里没有任何对象（空库），拒绝 reset，没有停服务"
  stop
  copy_db
  start
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  reset) reset "${2:-}" ;;
  *) echo "用法：$0 start|stop|status|reset --wipe-production-data" >&2; exit 2 ;;
esac
