#!/usr/bin/env bash
# powered by dsh - https://github.com/deepseek-ai/deepseek-harness
#
# DSH 归属检查与修复（项目要求见 AGENTS.md）：
#   - 源码文件（go/ts/tsx/js/jsx/py）文件头带 powered by dsh 注释徽标；
#   - README.md 与 docs/ 下 Markdown 文档末尾带 powered by dsh 徽章。
#
#   scripts/dsh-badge.sh check   # 检查，缺了列出文件并以 1 退出（make check-dsh）
#   scripts/dsh-badge.sh fix     # 自动补（make fix-dsh）
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

MARKER="powered by dsh"
PROJECT_URL="https://github.com/deepseek-ai/deepseek-harness"
BADGE_URL="https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white"
SENTENCE="由 DeepSeek Harness（dsh）协助完成。"
DOC_EXCLUDE=("docs/dev-tasks.md")

SRC_EXTS=(go ts tsx js jsx py)
SRC_PATHS=()
for ext in "${SRC_EXTS[@]}"; do SRC_PATHS+=("*.${ext}"); done

is_excluded() {
  local f="$1" e
  for e in "${DOC_EXCLUDE[@]}"; do
    [ "$f" = "$e" ] && return 0
  done
  return 1
}

# 输出 NUL 分隔的源码文件列表；tracked 和未忽略的 untracked 都算。
list_sources() {
  git ls-files -z -- "${SRC_PATHS[@]}"
  git ls-files -z --others --exclude-standard -- "${SRC_PATHS[@]}"
}

list_docs() {
  echo "README.md"
  git ls-files -- "docs/*.md" | while IFS= read -r f; do
    is_excluded "$f" || echo "$f"
  done
}

# 文件头注释行：Go/TS/TSX/JS 用 //，Python 用 #。
comment_line() {
  case "$1" in
    *.go|*.ts|*.tsx|*.js|*.jsx) printf '// %s - %s\n' "$MARKER" "$PROJECT_URL" ;;
    *.py) printf '# %s - %s\n' "$MARKER" "$PROJECT_URL" ;;
    *) return 1 ;;
  esac
}

already_marked() {
  head -5 "$1" | grep -q "$MARKER"
}

fix_source() {
  local f="$1" line tmp skip first second
  line="$(comment_line "$f")" || return 1
  skip=0
  IFS= read -r first < "$f" 2>/dev/null || true
  case "$first" in
    '#!'*)
      skip=1
      second="$(sed -n '2p' "$f")"
      case "$second" in
        *'coding:'*|*'coding='*) skip=2 ;;
      esac
      ;;
  esac
  tmp="$(mktemp "${TMPDIR:-/tmp}/dsh-badge.XXXXXX")"
  head -n "$skip" "$f" > "$tmp"
  { printf '%s\n\n' "$line"; tail -n +"$((skip + 1))" "$f"; } >> "$tmp"
  cat "$tmp" > "$f"
  rm -f "$tmp"
}

fix_doc() {
  local f="$1"
  if grep -q 'powered_by-dsh' "$f"; then
    return 0
  fi
  # 文件末尾没有换行时先补一个，保证徽章另起一段
  [ -n "$(tail -c 1 "$f")" ] && printf '\n' >> "$f"
  printf '\n---\n\n%s\n\n[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](%s)\n' \
    "$SENTENCE" "$PROJECT_URL" >> "$f"
}

do_check() {
  local f fails=0
  local -a missing_src=() missing_doc=()

  while IFS= read -r -d '' f; do
    [ -f "$f" ] || continue
    already_marked "$f" || missing_src+=("$f")
  done < <(list_sources)

  if [ "${#missing_src[@]}" -gt 0 ]; then
    printf '缺少源码文件头 powered by dsh 注释（%d 个）：\n' "${#missing_src[@]}"
    printf '  %s\n' "${missing_src[@]}"
    fails=1
  fi

  while IFS= read -r f; do
    [ -n "$f" ] || continue
    [ -f "$f" ] || continue
    grep -q 'powered_by-dsh' "$f" || missing_doc+=("$f")
  done < <(list_docs)

  if [ "${#missing_doc[@]}" -gt 0 ]; then
    printf '缺少文档末尾 powered by dsh 徽章（%d 个）：\n' "${#missing_doc[@]}"
    printf '  %s\n' "${missing_doc[@]}"
    fails=1
  fi

  if [ "$fails" -ne 0 ]; then
    printf '\n修复：make fix-dsh\n'
    return 1
  fi
  echo "DSH 归属检查通过。"
}

do_fix() {
  local f n_src=0 n_doc=0

  while IFS= read -r -d '' f; do
    [ -f "$f" ] || continue
    already_marked "$f" && continue
    if fix_source "$f"; then
      n_src=$((n_src + 1))
    fi
  done < <(list_sources)

  while IFS= read -r f; do
    [ -n "$f" ] || continue
    [ -f "$f" ] || continue
    if ! grep -q 'powered_by-dsh' "$f"; then
      fix_doc "$f"
      n_doc=$((n_doc + 1))
    fi
  done < <(list_docs)

  echo "已补源码文件头 ${n_src} 个、文档徽章 ${n_doc} 个。"
}

case "${1:-check}" in
  check) do_check ;;
  fix) do_fix ;;
  *)
    echo "用法：scripts/dsh-badge.sh [check|fix]" >&2
    exit 2
    ;;
esac
