#!/usr/bin/env bash
# 可选：给 GitHub Release 的 SHA256SUMS 生成 ed25519 签名（public key 填进 plugin.json 的 publisher.key）。
# 依赖 openssl（macOS/Linux 自带或 brew install openssl）；私钥不进仓库、不进 CI 环境变量以外的任何地方。
#
# 用法：
#   scripts/sign_release.sh gen-key publisher.pem            # 生成私钥，打印 publisher.id/key 片段
#   scripts/sign_release.sh sign publisher.pem SHA256SUMS    # 生成 SHA256SUMS.sig（base64 单行）
#   scripts/sign_release.sh verify public.key.b64 SHA256SUMS SHA256SUMS.sig
set -euo pipefail

cmd="${1:-}"
case "$cmd" in
  gen-key)
    pem="${2:-publisher.pem}"
    [ -f "$pem" ] && { echo "错误：$pem 已存在，拒绝覆盖" >&2; exit 1; }
    openssl genpkey -algorithm ed25519 -out "$pem"
    chmod 600 "$pem"
    pub_b64="$(openssl pkey -in "$pem" -pubout -outform DER | tail -c 32 | base64 | tr -d '\n')"
    echo "已生成私钥：$pem（保持 0600，不要提交）"
    echo "plugin.json 里填："
    echo "  \"publisher\": { \"id\": \"github:<owner>\", \"key\": \"$pub_b64\" }"
    ;;
  sign)
    pem="${2:?用法: sign <私钥.pem> <SHA256SUMS>}"
    sums="${3:?用法: sign <私钥.pem> <SHA256SUMS>}"
    [ -f "$pem" ] || { echo "错误：私钥不存在：$pem" >&2; exit 1; }
    tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
    openssl pkeyutl -sign -inkey "$pem" -rawin -in "$sums" -out "$tmp"
    base64 < "$tmp" | tr -d '\n' > "$sums.sig"
    echo "已生成 $sums.sig（base64；作为 Release 资产上传时不要改内容）"
    ;;
  verify)
    pub="${2:?用法: verify <公钥 base64> <SHA256SUMS> <SHA256SUMS.sig>}"
    sums="${3:?用法: verify <公钥 base64> <SHA256SUMS> <SHA256SUMS.sig>}"
    sig="${4:?用法: verify <公钥 base64> <SHA256SUMS> <SHA256SUMS.sig>}"
    pubder="$(mktemp)"; sigraw="$(mktemp)"; trap 'rm -f "$pubder" "$sigraw"' EXIT
    printf '%s' "$pub" | base64 -D > /dev/null 2>&1 || true
    printf '%s' "$pub" | base64 --decode > "$pubder" 2>/dev/null || printf '%s' "$pub" | base64 -D > "$pubder"
    { printf '\x30\x2a\x30\x05\x06\x03\x2b\x65\x70\x03\x42\x00'; cat "$pubder"; } > "$pubder.der"
    base64 --decode < "$sig" > "$sigraw" 2>/dev/null || base64 -D < "$sig" > "$sigraw"
    openssl pkeyutl -verify -pubin -inkey "$pubder.der" -keyform DER -rawin -in "$sums" -sigfile "$sigraw"
    ;;
  *)
    echo "用法：$0 gen-key|sign|verify ..." >&2; exit 2;;
esac
