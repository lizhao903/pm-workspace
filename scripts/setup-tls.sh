#!/bin/bash
# 给本地域名签发浏览器直接信任的 TLS 证书。
#
# 为什么非配 HTTPS 不可：Chrome 对 .vip 这类公网 TLD 会自动把地址升级到 HTTPS
# （HSTS / HTTPS-First），在地址栏敲 bro.vip 根本不会走 80 口，443 没人监听就是
# ERR_CONNECTION_REFUSED。除非每次手打 http://，否则必须把 HTTPS 真的配上。
#
# 用 mkcert 而不是 openssl 自签：mkcert 会把它生成的本地 CA 装进系统钥匙串，
# 由这个 CA 签出来的证书 Chrome/Safari 直接认，地址栏没有「不安全」警告。
# openssl 自签的证书没有受信任的签发者，每次访问都要点「继续前往」。
#
# 本脚本不需要 root：签发证书只写项目目录。装 CA 那一步要访问钥匙串会弹密码框，
# 脚本里跑不了交互，所以交给用户手动执行一次 mkcert -install。

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CERT_DIR="${CERT_DIR:-$ROOT/certs}"
# 证书里写进 SAN 的名字。127.0.0.1 与 ::1 一并签上，这样绕过域名直连回环地址
# 做调试时证书同样有效。
HOSTS="${HOSTS:-broleez.vip bro.vip localhost 127.0.0.1 ::1}"
CERT="$CERT_DIR/pmw.pem"
KEY="$CERT_DIR/pmw-key.pem"

# ---- 1. mkcert 是否装了 ----
# 故意不代劳安装：往用户机器上装软件是用户自己的决定。
if ! command -v mkcert >/dev/null 2>&1; then
  cat >&2 <<'MSG'
未找到 mkcert。请先安装：

  brew install mkcert

装完再重新执行本脚本。
MSG
  exit 1
fi

# ---- 2. 本地 CA 是否已装进钥匙串 ----
# 用 CAROOT 下有没有 rootCA.pem 判断，而不是盲目再跑一次 mkcert -install：
# 已装的情况下重复跑会再弹一次密码框，没必要打扰用户。
CAROOT="$(mkcert -CAROOT)"
if [ ! -f "$CAROOT/rootCA.pem" ]; then
  cat >&2 <<MSG
本地 CA 还没装进系统钥匙串。请先手动执行一次（会弹系统密码框，脚本里无法代跑）：

  mkcert -install

CA 目录：$CAROOT
装完再重新执行本脚本。
MSG
  exit 1
fi
echo "[ca] 本地 CA 已就位：$CAROOT/rootCA.pem"

# ---- 3. 签发证书 ----
mkdir -p "$CERT_DIR"
# shellcheck disable=SC2086
mkcert -cert-file "$CERT" -key-file "$KEY" $HOSTS
# 私钥只给自己读。证书目录已在 .gitignore 里，私钥不进版本库。
chmod 600 "$KEY"
chmod 644 "$CERT"

echo
echo "[cert] 证书：$CERT"
echo "[cert] 私钥：$KEY"
echo "[cert] 覆盖域名：$HOSTS"
echo
cat <<MSG
下一步（按顺序执行）：

  1. 让 pf 把 443 转发到 7443（需要 root）：
       sudo ./scripts/setup-local-domain.sh

  2. 让常驻进程带上证书，同时监听 7777 明文与 7443 TLS：
       ./scripts/install-autostart.sh

  3. 验证：
       curl -s  -o /dev/null -w '%{http_code}\n' http://bro.vip/api/health
       curl -s  -o /dev/null -w '%{http_code}\n' https://bro.vip/api/health

完整说明见 docs/local-domain.md
MSG
