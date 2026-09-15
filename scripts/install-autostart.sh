#!/bin/bash
# 让工作台随登录自启，这样 https://broleez.vip 任何时候都能打开。
# 用 LaunchAgent（用户级）而不是 LaunchDaemon：进程以当前用户身份运行，
# 不需要 root，也不会有 root 写用户数据文件的权限问题。
#
# 幂等：重复执行只是把 plist 重写一遍再重启服务，不会报错也不会装出两份。
# 证书存在就带上 TLS 参数同时监听明文与 HTTPS；不存在就只跑明文，行为与以前一致。
set -euo pipefail

# 注意：变量后面紧跟中文标点时，必须写成带花括号的 ${VAR} 形式，不能用裸写法。
# macOS 自带 bash 3.2 在 set -u 下会把变量名后面的非 ASCII 字节一起吃进变量名，
# 报一句 "VAR?: unbound variable"，而且只在走到那一行时才炸，很难发现。

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/bin/pmw"
DB="$ROOT/data/pm.db"
ADDR="${ADDR:-127.0.0.1:7777}"
TLS_ADDR="${TLS_ADDR:-127.0.0.1:7443}"
CERT="${CERT:-$ROOT/certs/pmw.pem}"
KEY="${KEY:-$ROOT/certs/pmw-key.pem}"
LABEL="vip.broleez.pmw"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

[ -x "$BIN" ] || { echo "未找到 ${BIN}，请先 make build" >&2; exit 1; }
mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/data" "$ROOT/logs"

# 证书齐全才加 TLS 参数。缺一个就当没配——pmw 对「只给 cert 不给 key」会直接
# 报错退出，LaunchAgent 带 KeepAlive 会把它拉起来反复崩，不如这里先拦掉。
# 这里故意用普通多行字符串而不是 $(cat <<EOF ...)：macOS 自带的是 bash 3.2，
# 命令替换里套 heredoc 会把后面的变量名解析错，报一个很误导的 unbound variable。
TLS_ARGS=""
if [ -f "$CERT" ] && [ -f "$KEY" ]; then
  TLS_ARGS="    <string>--tls-addr</string><string>$TLS_ADDR</string>
    <string>--tls-cert</string><string>$CERT</string>
    <string>--tls-key</string><string>$KEY</string>"
  echo "[tls] 找到证书，将同时监听 ${ADDR}（明文）与 ${TLS_ADDR}（HTTPS）"
else
  echo "[tls] 未找到证书（${CERT}），只监听 $ADDR 明文。签发证书：./scripts/setup-tls.sh"
fi

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BIN</string>
    <string>--db</string><string>$DB</string>
    <string>--addr</string><string>$ADDR</string>
$TLS_ARGS
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$ROOT/logs/pmw.log</string>
  <key>StandardErrorPath</key><string>$ROOT/logs/pmw.log</string>
</dict>
</plist>
PLIST_EOF

# 校验一下 plist 语法。写坏了 bootstrap 只报一句含糊的 "Input/output error"，
# 先 plutil 一下能直接指出是哪一行。
plutil -lint "$PLIST" >/dev/null || { echo "生成的 plist 有语法错误：$PLIST" >&2; exit 1; }

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 2
echo "已安装并启动：$PLIST"
echo "日志：$ROOT/logs/pmw.log"
echo

# 注意：pf 的 rdr 规则一旦生效，直连 127.0.0.1:$ADDR 会被遮蔽，下面这条 curl
# 可能连不上——那不代表服务没起来，改用域名验证即可。
curl -s -o /dev/null -w "直连 %{http_code}  http://$ADDR/api/health\n" "http://$ADDR/api/health" \
  || echo "直连 $ADDR 失败：要么服务没起来（看日志），要么被 pf rdr 遮蔽（正常，改用域名验证）"
echo "  curl -s -o /dev/null -w '%{http_code}\n' http://bro.vip/api/health"
echo "  curl -s -o /dev/null -w '%{http_code}\n' https://bro.vip/api/health"
echo
echo "卸载：launchctl bootout gui/\$(id -u)/$LABEL && rm $PLIST"
