#!/usr/bin/env bash
# 把 pmw-plugin-builder skill 安装到 agent 的 skills 目录（幂等，可重复执行）。
#
# 用法：
#   ./install-skill.sh                 # 装到首个可用的 skills 目录
#   ./install-skill.sh --dest DIR      # 装到 DIR/pmw-plugin-builder
#   ./install-skill.sh --help
#
# 默认按顺序找：~/.dsh/skills、~/.claude/skills、~/.agents/skills、<repo>/.agents/skills；
# 都不存在时创建 ~/.dsh/skills。重复执行会整体替换旧版本，不会留半套文件。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_NAME="pmw-plugin-builder"
SOURCE_DIR="${SCRIPT_DIR}/skill/${SKILL_NAME}"
DEST_ROOT=""
SHOW_HELP=0

usage() {
  cat <<'EOF'
用法：install-skill.sh [--dest DIR]

把 pmw-plugin-builder skill 安装到 agent 的 skills 目录（幂等）。

  --dest DIR   安装到 DIR/pmw-plugin-builder（DIR 不存在会创建）
  -h, --help   显示帮助

不传 --dest 时按顺序找首个可用位置：
  ~/.dsh/skills
  ~/.claude/skills
  ~/.agents/skills
  <PMW 仓库>/.agents/skills
都不存在时在 ~/.dsh/skills 创建。
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dest)
      if [ $# -lt 2 ] || [ -z "${2:-}" ]; then
        echo "错误：--dest 需要一个目录参数" >&2
        exit 2
      fi
      DEST_ROOT="$2"
      shift 2
      ;;
    -h|--help)
      SHOW_HELP=1
      shift
      ;;
    *)
      echo "错误：未知参数 $1（用 --help 看用法）" >&2
      exit 2
      ;;
  esac
done

if [ "$SHOW_HELP" -eq 1 ]; then
  usage
  exit 0
fi

if [ ! -d "$SOURCE_DIR" ]; then
  echo "错误：找不到 skill 源目录：$SOURCE_DIR" >&2
  echo "请在 PMW 仓库的 plugin-sdk/ 目录下运行本脚本（它是为随仓库分发准备的）。" >&2
  exit 1
fi
if [ ! -f "$SOURCE_DIR/SKILL.md" ]; then
  echo "错误：$SOURCE_DIR 下缺 SKILL.md，源目录不完整" >&2
  exit 1
fi
if [ ! -f "$SOURCE_DIR/scripts/pmw_plugin.py" ]; then
  echo "错误：$SOURCE_DIR/scripts/pmw_plugin.py 不存在，源目录不完整" >&2
  exit 1
fi

# 解析 ~ 和相对路径
expand_path() {
  case "$1" in
    "~") printf '%s\n' "$HOME" ;;
    "~/"*) printf '%s\n' "$HOME/${1#"~/"}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

if [ -n "$DEST_ROOT" ]; then
  DEST_ROOT="$(expand_path "$DEST_ROOT")"
  mkdir -p "$DEST_ROOT"
else
  for candidate in \
    "${HOME}/.dsh/skills" \
    "${HOME}/.claude/skills" \
    "${HOME}/.agents/skills" \
    "${SCRIPT_DIR}/../.agents/skills"
  do
    if [ -d "$candidate" ]; then
      DEST_ROOT="$candidate"
      break
    fi
  done
  if [ -z "$DEST_ROOT" ]; then
    DEST_ROOT="${HOME}/.dsh/skills"
  fi
  mkdir -p "$DEST_ROOT"
fi

TARGET="${DEST_ROOT}/${SKILL_NAME}"
STAGING="${DEST_ROOT}/.${SKILL_NAME}.installing.$$"
CLEANUP_STAGING=1
cleanup() {
  if [ "$CLEANUP_STAGING" -eq 1 ] && [ -d "$STAGING" ]; then
    rm -rf "$STAGING"
  fi
}
trap cleanup EXIT

rm -rf "$STAGING"
cp -R "$SOURCE_DIR" "$STAGING"

# 覆盖旧版本：先删旧目录再移动新目录，避免留下旧版本删掉的文件。
if [ -d "$TARGET" ]; then
  rm -rf "$TARGET"
fi
mv "$STAGING" "$TARGET"
CLEANUP_STAGING=0
trap - EXIT

if [ ! -f "$TARGET/SKILL.md" ] || [ ! -f "$TARGET/scripts/pmw_plugin.py" ]; then
  echo "错误：安装后校验失败：$TARGET 缺 SKILL.md 或 scripts/pmw_plugin.py" >&2
  exit 1
fi

echo "已安装 skill：${SKILL_NAME}"
echo "  安装路径：${TARGET}"
echo "  SKILL.md：${TARGET}/SKILL.md"
echo "  工具脚本：${TARGET}/scripts/pmw_plugin.py"
echo
echo "下一步："
echo "  1) 重开一个 agent 会话（或刷新 skills 目录），让它扫描到新 skill；"
echo "  2) 试运行：python3 \"${TARGET}/scripts/pmw_plugin.py\" --help"
echo "  3) 生成插件：python3 \"${TARGET}/scripts/pmw_plugin.py\" init ./my-plugin --id=my_plugin --owner=<github-owner>"
if [ "$DEST_ROOT" != "${HOME}/.dsh/skills" ] && [ "$DEST_ROOT" != "${HOME}/.claude/skills" ] && [ "$DEST_ROOT" != "${HOME}/.agents/skills" ]; then
  echo
  echo "注意：安装到了非默认位置；如果你的 agent 只扫描普通 skills 目录，请拷到对应目录或加 --dest 重装。"
fi
