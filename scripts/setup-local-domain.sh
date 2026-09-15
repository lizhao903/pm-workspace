#!/bin/bash
# 把 broleez.vip 指向本机的产品工作台，并让 http(s)://broleez.vip 免端口直达。
#
# 做两件事（都需要 root）：
#   1. /etc/hosts 加一行解析到 127.0.0.1
#   2. pf 加两条重定向：127.0.0.1:80 -> 7777（明文），127.0.0.1:443 -> 7443（TLS）
#
# 443 那条是必须的：Chrome 对 .vip 这类公网 TLD 会自动把地址升级到 HTTPS，
# 地址栏敲 bro.vip 根本不走 80 口，443 没人监听就是 ERR_CONNECTION_REFUSED。
# 证书用 scripts/setup-tls.sh 签发，没签也不影响这条规则——只是 443 会连不上后端。
#
# 不直接让工作台监听 80：那要求整个进程以 root 运行，一个本地工具没必要拿 root 权限跑。
# pf 重定向只把内核里的一条转发规则交给 root，进程本身仍以普通用户运行。

set -euo pipefail

# 可配多个域名，空格分隔。pf 那条重定向是按 IP:端口 匹配的，与域名无关，
# 所以加域名只需要多写一行 hosts，不用动 pf。
DOMAINS="${DOMAINS:-broleez.vip bro.vip}"
PORT="${PORT:-7777}"
TLS_PORT="${TLS_PORT:-7443}"
ANCHOR="broleez-local"
ANCHOR_FILE="/etc/pf.anchors/${ANCHOR}"

if [ "$(id -u)" -ne 0 ]; then
  echo "需要 root：sudo $0" >&2
  exit 1
fi

# ---- 1. hosts ----
BACKED_UP=0
for d in $DOMAINS; do
  if grep -qE "^[^#]*[[:space:]]${d}([[:space:]]|\$)" /etc/hosts; then
    echo "[hosts] ${d} 已存在，跳过"
    continue
  fi
  if [ "$BACKED_UP" -eq 0 ]; then
    cp /etc/hosts "/etc/hosts.bak.$(date +%Y%m%d%H%M%S)"
    printf '\n# 产品工作台本地域名（scripts/setup-local-domain.sh 添加）\n' >> /etc/hosts
    BACKED_UP=1
  fi
  printf '127.0.0.1\t%s\n' "$d" >> /etc/hosts
  echo "[hosts] 已添加 127.0.0.1 ${d}"
done
[ "$BACKED_UP" -eq 1 ] && echo "[hosts] 原文件已备份"
dscacheutil -flushcache 2>/dev/null || true
killall -HUP mDNSResponder 2>/dev/null || true

# ---- 2. pf 重定向 80 -> PORT、443 -> TLS_PORT ----
# 单独用 anchor 而不是往 /etc/pf.conf 里塞规则：升级 macOS 或改防火墙时
# pf.conf 可能被系统覆盖，anchor 文件不会，且卸载时只删自己那一份。
#
# 副作用（不是 bug，是 pf rdr 的工作方式）：这两条规则生效后，直接访问
# 127.0.0.1:${PORT} / 127.0.0.1:${TLS_PORT} 会被遮蔽连不上，一律走域名访问。
cat > "$ANCHOR_FILE" <<PFRULE
rdr pass on lo0 inet proto tcp from any to 127.0.0.1 port 80 -> 127.0.0.1 port ${PORT}
rdr pass on lo0 inet proto tcp from any to 127.0.0.1 port 443 -> 127.0.0.1 port ${TLS_PORT}
PFRULE
echo "[pf] 已写入 ${ANCHOR_FILE}（80 -> ${PORT}, 443 -> ${TLS_PORT}）"

if ! grep -q "rdr-anchor \"${ANCHOR}\"" /etc/pf.conf; then
  cp /etc/pf.conf "/etc/pf.conf.bak.$(date +%Y%m%d%H%M%S)"
  # 两行缺一不可：rdr-anchor 声明挂载点，load anchor 才真正把规则文件读进去。
  # 只写 rdr-anchor 的话 anchor 是空的，重定向静默不生效——这类「配置看着对、
  # 实际没规则」的问题排查起来很费劲，因为 pfctl 不会报错。
  # rdr-anchor 必须在 dummynet/anchor 之前，load anchor 放文件末尾。
  awk -v a="$ANCHOR" '
    !done && /^rdr-anchor/ { print; print "rdr-anchor \"" a "\""; done=1; next }
    { print }
    END {
      if (!done) print "rdr-anchor \"" a "\""
      print "load anchor \"" a "\" from \"/etc/pf.anchors/" a "\""
    }
  ' /etc/pf.conf > /tmp/pf.conf.new && mv /tmp/pf.conf.new /etc/pf.conf
  echo "[pf] 已在 /etc/pf.conf 注册并加载 anchor（原文件已备份）"
else
  echo "[pf] anchor 已注册，跳过"
fi

# pf 在 macOS 上默认不开机自启，且 pfctl -e 不持久。装一个 LaunchDaemon 在开机时
# 重新加载规则并启用，否则重启后 http://broleez.vip 会变成连不上。
cat > /Library/LaunchDaemons/vip.broleez.pf.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>vip.broleez.pf</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>-c</string>
    <string>/sbin/pfctl -f /etc/pf.conf; /sbin/pfctl -E</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
</dict>
</plist>
PLIST
launchctl bootout system/vip.broleez.pf 2>/dev/null || true
launchctl bootstrap system /Library/LaunchDaemons/vip.broleez.pf.plist 2>/dev/null || true
echo "[pf] 已装开机自启 LaunchDaemon"

pfctl -f /etc/pf.conf 2>&1 | grep -v "^No ALTQ" || true
pfctl -e 2>&1 | grep -v "already enabled" || true
echo
echo "[pf] 当前生效的重定向规则："
pfctl -a "$ANCHOR" -s nat 2>/dev/null || echo "  （读取失败，可用 sudo pfctl -a ${ANCHOR} -s nat 自查）"

echo
echo "完成。验证："
for d in $DOMAINS; do
  echo "  curl -s -o /dev/null -w '%{http_code}\\n' http://${d}/api/health"
  echo "  curl -s -o /dev/null -w '%{http_code}\\n' https://${d}/api/health"
done
echo
echo "工作台需要同时监听这两个端口："
echo "  ./bin/pmw --addr 127.0.0.1:${PORT} --tls-addr 127.0.0.1:${TLS_PORT} \\"
echo "            --tls-cert ./certs/pmw.pem --tls-key ./certs/pmw-key.pem"
echo "证书用 ./scripts/setup-tls.sh 签发；常驻进程用 ./scripts/install-autostart.sh 装。"
echo
echo "注意：上面两条 rdr 生效后，直接访问 127.0.0.1:${PORT} 会被 pf 遮蔽连不上，"
echo "      调试一律用域名（http://bro.vip / https://bro.vip）。"
