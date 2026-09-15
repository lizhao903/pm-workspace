#!/bin/bash
# 撤销 setup-tls.sh 的改动：删掉项目里签发的证书。
#
# 不会动系统钥匙串里的本地 CA——那个 CA 可能还在给别的项目签证书，
# 删它是全局影响。真要卸载 CA 得用户自己执行 mkcert -uninstall，
# 脚本末尾会把这条命令打出来。

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CERT_DIR="${CERT_DIR:-$ROOT/certs}"

if [ -d "$CERT_DIR" ]; then
  rm -f "$CERT_DIR/pmw.pem" "$CERT_DIR/pmw-key.pem"
  # 目录空了才删，避免误删用户自己放进去的别的东西。
  rmdir "$CERT_DIR" 2>/dev/null || true
  echo "[cert] 已删除 $CERT_DIR 下的证书与私钥"
else
  echo "[cert] $CERT_DIR 不存在，跳过"
fi

cat <<'MSG'

证书没了之后 install-autostart.sh 会自动退回只跑明文 HTTP，
重新执行一次让 LaunchAgent 去掉 TLS 参数：

  ./scripts/install-autostart.sh

如果连 pf 的 443 转发一起撤掉：

  sudo ./scripts/teardown-local-domain.sh

如果确定本机没有别的项目依赖 mkcert 的本地 CA，可以再卸载 CA（会弹密码框）：

  mkcert -uninstall
MSG
