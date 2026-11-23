#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# synthesize-audio-indextts.sh — 用本机 IndexTTS-MLX 合成口播
#
# mmx-cli 变体的对照版：不联网，不烧 MiniMax token，靠预提取的
# `.voice.pt` 音色特征文件复用音色，单次模型加载（~25s）后批量合成。
#
# Prereq:
#   1. npm run extract-narrations   (writes audio-segments.json)
#   2. indextts CLI 已装：
#        cd /path/to/index-tts-mlx && uv tool install -e .
#   3. 音色特征文件存在于 $INDEXTTS_VOICE_DIR
#      （生成方式：indextts --extract -v audio.mp3 -o name.voice.pt）
#   4. ffmpeg（把 indextts 写的 .wav 转成 skill 期望的 .mp3）
#
# 音色：
#   默认               voice-broleez.voice.pt（v1.7.1+）
#   --sincere-adult    voice-sincere-adult.voice.pt（v1.7.0 之前的默认）
#   --voice=X          $INDEXTTS_VOICE_DIR/X.voice.pt（X 不带后缀）
#
# Usage:
#   bash scripts/synthesize-audio-indextts.sh                   # broleez 音色 + 增量
#   bash scripts/synthesize-audio-indextts.sh --sincere-adult   # 切 sincere-adult 音色
#   bash scripts/synthesize-audio-indextts.sh --force           # 覆盖已存在
#   INDEXTTS_VOICE_DIR=/path/to/voices bash ...                 # 自定义音色目录
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

INDEXTTS_VOICE_DIR="${INDEXTTS_VOICE_DIR:-/Volumes/project/git_0xBroleez/web-video}"
VOICE_NAME="voice-broleez"
FORCE=false
ROOT_ARG=""

for arg in "$@"; do
  case "$arg" in
    --force)          FORCE=true ;;
    --broleez)        VOICE_NAME="voice-broleez" ;;
    --sincere-adult)  VOICE_NAME="voice-sincere-adult" ;;
    --voice=*)        VOICE_NAME="${arg#--voice=}" ;;
    --root=*)   ROOT_ARG="${arg#--root=}" ;;
    -h|--help)
      sed -n '2,/^set -euo/p' "$0" | sed 's/^# \?//'
      exit 0 ;;
    *) echo "✗ unknown arg: $arg" >&2; exit 1 ;;
  esac
done

VOICE_FILE="$INDEXTTS_VOICE_DIR/$VOICE_NAME.voice.pt"

# Resolve project root. Under web-video's `shared/presentation` symlink
# layout, npm canonicalizes symlinks when chdir-ing for the child process,
# so $INIT_CWD / $PWD lose the project identity. Priority:
#   1. --root=<path>                  (explicit, highest)
#   2. $INDEXTTS_PROJECT_ROOT env var
#   3. walk up from $INIT_CWD / $PWD / script-relative looking for
#      audio-segments.json (works for direct `bash scripts/X.sh` from
#      inside the project, or any non-symlinked layout)
find_segments_root() {
  local d="$1"
  while [[ -n "$d" && "$d" != "/" ]]; do
    [[ -f "$d/audio-segments.json" ]] && { echo "$d"; return 0; }
    d="$(dirname "$d")"
  done
  return 1
}

ROOT=""
if [[ -n "$ROOT_ARG" ]]; then
  ROOT="$ROOT_ARG"
elif [[ -n "${INDEXTTS_PROJECT_ROOT:-}" ]]; then
  ROOT="$INDEXTTS_PROJECT_ROOT"
else
  for cand in "${INIT_CWD:-}" "$PWD" "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; do
    [[ -z "$cand" ]] && continue
    if hit="$(find_segments_root "$cand")"; then
      ROOT="$hit"; break
    fi
  done
fi

if [[ -z "$ROOT" || ! -f "$ROOT/audio-segments.json" ]]; then
  cat >&2 <<'EOF'
✗ could not locate a presentation project containing audio-segments.json.

  Under a `web-video/shared/presentation` symlink layout, npm canonicalizes
  the package.json symlink so the script loses the original project path.
  Specify the project explicitly:

    npm run synthesize-audio-indextts -- --root=<path>                  # broleez 默认音色
    npm run synthesize-audio-indextts -- --root=<path> --sincere-adult  # sincere-adult 音色

  Or set an env var:

    INDEXTTS_PROJECT_ROOT=<path> npm run synthesize-audio-indextts

  Or skip npm and run directly (auto-detects):

    cd <project>/presentation
    bash scripts/synthesize-audio-indextts.sh
EOF
  search="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  while [[ -n "$search" && "$search" != "/" ]]; do
    [[ -d "$search/projects" && -d "$search/shared" ]] && break
    search="$(dirname "$search")"
  done
  if [[ -n "$search" && "$search" != "/" ]]; then
    cands="$(ls -1t "$search"/projects/*/presentation/audio-segments.json 2>/dev/null | head -10)"
    if [[ -n "$cands" ]]; then
      echo >&2
      echo "  Recent candidates (by audio-segments.json mtime):" >&2
      while IFS= read -r f; do
        [[ -z "$f" ]] && continue
        echo "    --root=$(dirname "$f")" >&2
      done <<< "$cands"
    fi
  fi
  exit 1
fi

ROOT="$(cd "$ROOT" && pwd)"
SEGMENTS="$ROOT/audio-segments.json"
OUT_DIR="$ROOT/public/audio"
echo ">> project root: $ROOT"

# ── 前置校验 ─────────────────────────────────────────────────────────
if [[ ! -f "$SEGMENTS" ]]; then
  echo "✗ $SEGMENTS not found. Run: npm run extract-narrations" >&2
  exit 1
fi
if ! command -v indextts >/dev/null; then
  cat <<'EOF' >&2
✗ indextts CLI not found in PATH.

  Install (one-time):
    cd /path/to/index-tts-mlx
    uv tool install -e .

  See references/AUDIO.md "用户自带 TTS 的最小契约" 段了解如何接其它 TTS。
EOF
  exit 1
fi
if ! command -v jq >/dev/null; then
  echo "✗ jq is required to read audio-segments.json" >&2
  exit 1
fi
if [[ ! -f "$VOICE_FILE" ]]; then
  echo "✗ voice feature file not found: $VOICE_FILE" >&2
  echo "  Available files in \$INDEXTTS_VOICE_DIR ($INDEXTTS_VOICE_DIR):" >&2
  ls -1 "$INDEXTTS_VOICE_DIR"/*.voice.pt 2>/dev/null | sed 's|.*/||; s|^|    |' >&2 || \
    echo "    (none)" >&2
  echo "  Generate via: indextts --extract -v <audio> -o <name>.voice.pt" >&2
  exit 1
fi

echo ">> voice: $VOICE_FILE"

# ── 把 segments → indextts JSONL（用 batch 模式让模型只加载一次）─────
BATCH_FILE="$(mktemp -t indextts-batch.XXXXXX).jsonl"
WAV_LIST="$(mktemp -t indextts-wavlist.XXXXXX)"
trap 'rm -f "$BATCH_FILE" "$WAV_LIST"' EXIT

total=$(jq 'length' "$SEGMENTS")
queued=0
skipped=0
empty=0

while IFS= read -r row; do
  chapter=$(echo "$row" | jq -r '.chapter')
  step=$(echo "$row"   | jq -r '.step')
  text=$(echo "$row"   | jq -r '.text')
  mp3="$OUT_DIR/$chapter/$step.mp3"
  wav="$OUT_DIR/$chapter/$step.wav"

  # 空 narration 跳过（与 mmx 变体一致）
  if [[ -z "$text" ]]; then
    empty=$((empty + 1)); continue
  fi
  if [[ -f "$mp3" && "$FORCE" != true ]]; then
    skipped=$((skipped + 1)); continue
  fi

  mkdir -p "$(dirname "$mp3")"
  jq -nc --arg text "$text" --arg voice "$VOICE_FILE" --arg output "$wav" \
    '{text: $text, voice: $voice, output: $output, force: true}' >> "$BATCH_FILE"
  echo "$wav	$mp3" >> "$WAV_LIST"
  queued=$((queued + 1))
done < <(jq -c '.[]' "$SEGMENTS")

echo ">> queued $queued, skipped $skipped exists, $empty empty / $total total"

if [[ "$queued" -eq 0 ]]; then
  echo "✓ nothing to do."
  exit 0
fi

# ── 合成 ─────────────────────────────────────────────────────────────
echo ">> running indextts --batch (model loads once)..."
indextts --batch "$BATCH_FILE" -f

# ── wav → mp3（skill Auto 模式按 .mp3 路径找文件）─────────────────────
if ! command -v ffmpeg >/dev/null; then
  echo "⚠ ffmpeg not found — .wav files left in place." >&2
  echo "  skill 的 Auto 录屏模式按 .mp3 路径取文件；请装 ffmpeg：brew install ffmpeg" >&2
  exit 0
fi

echo ">> converting .wav → .mp3 ..."
converted=0
failed=0
while IFS=$'\t' read -r wav mp3; do
  if [[ ! -f "$wav" ]]; then
    echo "  ✗ missing: $wav" >&2
    failed=$((failed + 1))
    continue
  fi
  if ffmpeg -y -loglevel error -i "$wav" -codec:a libmp3lame -qscale:a 2 "$mp3"; then
    rm -f "$wav"
    converted=$((converted + 1))
  else
    echo "  ✗ ffmpeg failed: $wav" >&2
    failed=$((failed + 1))
  fi
done < "$WAV_LIST"

echo
echo "✓ done — synthesized $converted, skipped $skipped, empty $empty, failed $failed"
[[ $failed -eq 0 ]] || exit 2
