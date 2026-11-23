#!/bin/bash
# 一键启动产品工作台，并打通 https://bro.vip。
#
# 访问链路有四层，任何一层掉了页面都打不开，而且报错各不相同：
#
#   hosts → pf(80/443) → pmw(明文 7796 + TLS 7443) → mkcert 证书
#
#   1. hosts：127.0.0.1 和 ::1 都要把域名指回本机。只写 IPv4 时 DNS 里的
#      公网 AAAA 记录仍会返回，浏览器优先连 Cloudflare 的 IPv6，报
#      ERR_ADDRESS_UNREACHABLE——看起来像「网络不可达」，其实只是没走本机。
#   2. pf：80 -> 明文端口、443 -> TLS 端口。macOS 重启后 pf 不会自己启用；
#      调试时执行过 sudo pfctl -d 也会把它关掉，重启后域名就全挂了。
#   3. pmw：生产实例是 7796（data-dev 里的真实数据），证书存在时同一个进程
#      还监听 7443 的 HTTPS。
#   4. 证书：certs/ 下 mkcert 签的证书。缺了 HTTPS 就不可信，Chrome 会拦。
#
# 本脚本按这个顺序检查并修复，最后用 http/https 各打一次 /api/health 给结论。
#
# 用法：
#   scripts/start-workbench.sh                 日常启动/修复（复用现有二进制）
#   scripts/start-workbench.sh --build         先重新构建前端与二进制再启动
#   scripts/start-workbench.sh --status        只检查现状，不改系统、不用 sudo
#   scripts/start-workbench.sh --stop          停掉 7796 实例（不动域名链路）
#   scripts/start-workbench.sh --keep-legacy   保留旧的 7777 LaunchAgent
#   scripts/start-workbench.sh --open          起来后打开浏览器
#   scripts/start-workbench.sh --help
#
# 环境变量覆盖：PMW_PORT(7796) PMW_TLS_PORT(7443) PMW_DOMAINS PMW_DEV_DIR PMW_SRC_DB
#
# 由 DeepSeek Harness（dsh）协助完成。

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PMW_PORT:-7796}"
TLS_PORT="${PMW_TLS_PORT:-7443}"
DOMAINS="${PMW_DOMAINS:-bro.vip broleez.vip}"
PRIMARY="${DOMAINS%% *}"
BIN="$ROOT/bin/pmw-dev"
DIST="$ROOT/internal/webui/dist"
CERT="$ROOT/certs/pmw.pem"
KEY="$ROOT/certs/pmw-key.pem"
LEGACY_LABEL="vip.broleez.pmw"
LEGACY_PLIST="$HOME/Library/LaunchAgents/$LEGACY_LABEL.plist"
DEV="$ROOT/scripts/dev-instance.sh"

info() { printf '\n== %s ==\n' "$*"; }
die() { echo "start-workbench: $*" >&2; exit 1; }

usage() {
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
}

# 打一次 /api/health，输出 HTTP 状态码（连不上时输出空）。
check_health() {
  curl -g -sS -m 5 -o /dev/null -w '%{http_code}' "$1" 2>/dev/null || true
}

# 有比基准文件更新的就输出第一个路径；没有则输出空。
newer_than() {
  local base="$1"
  shift
  local hit
  hit="$(find "$@" -newer "$base" -print -quit 2>/dev/null || true)"
  [ -n "$hit" ] && echo "$hit"
  return 0
}

status() {
  info "证书"
  if [ -f "$CERT" ] && [ -f "$KEY" ]; then
    echo "  有：$CERT"
    openssl x509 -in "$CERT" -noout -enddate 2>/dev/null | sed 's/^/  /'
  else
    echo "  缺：证书或私钥不在，HTTPS 会不可信；跑 scripts/setup-tls.sh 重签"
  fi

  info "hosts（bro.vip 是公网域名，只写 IPv4 会连到公网 IPv6）"
  local d ip
  for d in $DOMAINS; do
    for ip in 127.0.0.1 ::1; do
      if awk -v ip="$ip" -v d="$d" '!/^[[:space:]]*#/ && $1==ip && $2==d { f=1 } END { exit(f?0:1) }' /etc/hosts; then
        echo "  ${ip} ${d}  ok"
      else
        echo "  ${ip} ${d}  缺（跑 $0 修）"
      fi
    done
  done

  info "监听端口"
  local p
  for p in "$PORT" "$TLS_PORT"; do
    if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "  $p  在监听"
    else
      echo "  $p  没在监听"
    fi
  done

  info "解析"
  for d in $DOMAINS; do
    echo "  $d -> $(dscacheutil -q host -a name "$d" 2>/dev/null | awk '/ip_address|ipv6_address/ { printf "%s ", $2 }')"
  done

  info "域名健康检查"
  local http_code https_code
  http_code="$(check_health "http://$PRIMARY/api/health")"
  https_code="$(check_health "https://$PRIMARY/api/health")"
  echo "  http://$PRIMARY/api/health   -> ${http_code:-无响应}"
  echo "  https://$PRIMARY/api/health  -> ${https_code:-无响应}"

  info "7796 实例"
  "$DEV" status || true

  echo
  if [ "$https_code" = "200" ]; then
    echo "结论：https://$PRIMARY 可用。"
    return 0
  fi
  echo "结论：https://$PRIMARY 还不通。最常见原因是 pf 被关过（sudo pfctl -d）或 hosts 缺 ::1。"
  echo "      跑 scripts/start-workbench.sh 修复（会要一次 sudo 密码）。"
  return 1
}

# ---- 参数 ----
MODE=start
BUILD=auto
KEEP_LEGACY=0
OPEN=0
for arg in "$@"; do
  case "$arg" in
    --status) MODE=status ;;
    --stop) MODE=stop ;;
    --build) BUILD=force ;;
    --no-build) BUILD=never ;;
    --keep-legacy) KEEP_LEGACY=1 ;;
    --open) OPEN=1 ;;
    --help|-h) usage; exit 0 ;;
    *) die "不认识的参数：${arg}（--help 看用法）" ;;
  esac
done

[ "$(id -u)" -eq 0 ] && die "不要用 sudo 跑本脚本：只有改 hosts/pf 那一步需要 root，脚本会自己调 sudo；整个脚本用 root 跑会让 7796 和 data-dev 里的文件变成 root 所有。"

if [ "$MODE" = status ]; then
  status && exit 0
  exit 1
fi
if [ "$MODE" = stop ]; then
  "$DEV" stop
  exit 0
fi

# ---- 1. 证书 ----
info "1/5 证书"
if [ ! -f "$CERT" ] || [ ! -f "$KEY" ]; then
  echo "certs/ 缺证书，先重签（不需要 root；需要 mkcert，且本地 CA 已 mkcert -install）"
  "$ROOT/scripts/setup-tls.sh" || die "签证书失败：按上面提示装 mkcert / 跑 mkcert -install 再试"
fi
echo "证书：$CERT"

# ---- 2. 停掉旧的 7777 常驻服务 ----
info "2/5 旧的 7777 常驻服务"
if launchctl list 2>/dev/null | grep "$LEGACY_LABEL" >/dev/null; then
  if [ "$KEEP_LEGACY" -eq 1 ]; then
    echo "保留（--keep-legacy）：$LEGACY_LABEL"
  else
    launchctl bootout "gui/$(id -u)/$LEGACY_LABEL" 2>/dev/null || true
    launchctl disable "gui/$(id -u)/$LEGACY_LABEL" 2>/dev/null || true
    echo "已停用 ${LEGACY_LABEL}：它指向旧库 data/pm.db（7777），已被 7796 生产实例取代。"
    echo "  想恢复：launchctl enable gui/$(id -u)/$LEGACY_LABEL && launchctl bootstrap gui/$(id -u) \"$LEGACY_PLIST\""
  fi
else
  echo "没有在跑"
fi

# ---- 3. 域名链路（hosts + pf，需要 sudo）----
# 放在起实例之前：80 口先指到 7796，随后 dev-instance 的健康检查即使走域名也不会打到旧实例。
info "3/5 域名链路（改 /etc/hosts 和 pf，需要一次 sudo 密码）"
DOMAIN_OK=1
if sudo env PORT="$PORT" TLS_PORT="$TLS_PORT" DOMAINS="$DOMAINS" /bin/bash "$ROOT/scripts/setup-local-domain.sh"; then
  echo "域名链路已就绪：80 -> ${PORT}，443 -> ${TLS_PORT}"
else
  DOMAIN_OK=0
  echo "域名链路修复失败（实例本身不受影响）。手动执行：" >&2
  echo "  sudo env PORT=$PORT TLS_PORT=$TLS_PORT DOMAINS=\"$DOMAINS\" /bin/bash $ROOT/scripts/setup-local-domain.sh" >&2
fi

# ---- 4. 生产实例 7796 ----
info "4/5 生产实例 ${PORT}（明文）+ ${TLS_PORT}（TLS）"
NO_BUILD=1
if [ "$BUILD" = force ]; then
  NO_BUILD=0
elif [ "$BUILD" = never ]; then
  [ -x "$BIN" ] || die "--no-build 但 $BIN 不存在，先正常跑一次脚本（会构建）"
  NO_BUILD=1
elif [ ! -x "$BIN" ]; then
  echo "找不到 ${BIN}，先构建"
  NO_BUILD=0
else
  # 默认复用现有二进制，不自动重建：工作区常有别的会话在改代码，
  # 自动重建可能把别人没写完的改动带上线，启动也慢。要让改动生效显式 --build。
  stale="$(newer_than "$BIN" "$ROOT/cmd" "$ROOT/internal" -name '*.go' | head -1 || true)"
  if [ -n "$stale" ]; then
    echo "提示：$stale 比 $BIN 新（可能有未生效的改动）；需要时加 --build 重建"
  fi
  if [ -f "$DIST/index.html" ]; then
    stale_front="$(newer_than "$DIST/index.html" "$ROOT/frontend/src" "$ROOT/frontend/index.html" | head -1 || true)"
    if [ -n "$stale_front" ]; then
      echo "提示：$stale_front 比已嵌入的 dist 新；需要时加 --build 重建前端"
    fi
  fi
fi
if [ "$NO_BUILD" -eq 1 ]; then
  echo "沿用现有二进制：$BIN"
else
  echo "重新构建前端与二进制（大约 1-2 分钟）"
fi
PMW_DEV_ADDR="127.0.0.1:$PORT" \
PMW_DEV_TLS_ADDR="127.0.0.1:$TLS_PORT" \
PMW_DEV_NO_BUILD="$NO_BUILD" \
  "$DEV" start

# ---- 5. 验证 ----
info "5/5 验证"
sleep 1
http_code="$(check_health "http://$PRIMARY/api/health")"
https_code="$(check_health "https://$PRIMARY/api/health")"
echo "  http://$PRIMARY/api/health   -> ${http_code:-无响应}"
echo "  https://$PRIMARY/api/health  -> ${https_code:-无响应}"
if [ "$DOMAIN_OK" -eq 1 ] && [ "$http_code" = "200" ] && [ "$https_code" = "200" ]; then
  echo
  echo "完成：https://$PRIMARY 可用（实例 ${PORT} / TLS ${TLS_PORT}，库 $ROOT/data-dev/pm.db）"
  echo "日志：$ROOT/data-dev/pmw.log"
  [ "$OPEN" -eq 1 ] && open "https://$PRIMARY"
  exit 0
fi
echo "还没全通，按顺序排查：" >&2
echo "  1. 实例：$DEV status；日志 $ROOT/data-dev/pmw.log" >&2
echo "  2. TLS 端口：lsof -nP -iTCP:$TLS_PORT -sTCP:LISTEN" >&2
echo "  3. pf：sudo pfctl -a broleez-local -s nat；开没开：sudo pfctl -s info | head -1" >&2
echo "  4. 现状总览：$0 --status" >&2
exit 1
