#!/bin/bash
# 撤销 setup-local-domain.sh 的全部改动：hosts 记录、pf anchor（80 与 443 两条
# 规则都在同一个 anchor 文件里，删文件即两条一起没）、pf 开机自启 LaunchDaemon。
#
# 不动证书：证书归 scripts/teardown-tls.sh 管，两者互不依赖，
# 可以只撤域名转发而保留证书，反之亦然。
set -euo pipefail
DOMAINS="${DOMAINS:-broleez.vip bro.vip}"
ANCHOR="broleez-local"

if [ "$(id -u)" -ne 0 ]; then echo "需要 root：sudo $0" >&2; exit 1; fi

cp /etc/hosts "/etc/hosts.bak.$(date +%Y%m%d%H%M%S)"
sed -i '' "/# 产品工作台本地域名/d" /etc/hosts
for d in $DOMAINS; do
  sed -i '' "/[[:space:]]${d}\$/d" /etc/hosts
  echo "[hosts] 已移除 ${d}"
done

launchctl bootout system/vip.broleez.pf 2>/dev/null || true
rm -f /Library/LaunchDaemons/vip.broleez.pf.plist
sed -i '' "/rdr-anchor \"${ANCHOR}\"/d; /load anchor \"${ANCHOR}\"/d" /etc/pf.conf
rm -f "/etc/pf.anchors/${ANCHOR}"
pfctl -f /etc/pf.conf 2>&1 | grep -v "^No ALTQ" || true
echo "[pf] 已移除 anchor（80 与 443 两条重定向都已失效）"

dscacheutil -flushcache 2>/dev/null || true
killall -HUP mDNSResponder 2>/dev/null || true
echo "完成。"
echo "工作台仍在 127.0.0.1:7777 上跑（pf 规则没了，现在可以直连这个端口了）。"
echo "如需一并删掉 TLS 证书：./scripts/teardown-tls.sh"
