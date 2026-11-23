#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# synthesize-audio.sh — read audio-segments.json and call MiniMax CLI
# (mmx) to produce one mp3 per segment under public/audio/<chapter>/<N>.mp3.
#
# Prereq:
#   1. mmx-cli installed and authenticated (`mmx auth status`)
#
# Behavior:
#   • Runs extract-narrations first (writes audio-segments.json).
#     Pass --no-extract to skip and reuse the existing file.
#   • Serial calls (TTS APIs commonly rate-limit parallel requests).
#   • Skips segments whose mp3 already exists (so you can rerun safely
#     after a partial failure). Pass --force to re-synthesize all.
#   • Prints progress per segment with elapsed time.
#
# Default voice: Chinese (Mandarin)_Sincere_Adult — pairs with the
# voice-sincere-adult.mp3 reference used by synthesize-audio-indextts.sh
# so both engines sound like the same speaker. Override via --voice=<id>.
#
# Usage:
#   bash scripts/synthesize-audio.sh                # extract + incremental
#   bash scripts/synthesize-audio.sh --force        # extract + overwrite all
#   bash scripts/synthesize-audio.sh --no-extract   # reuse existing segments.json
#   bash scripts/synthesize-audio.sh --voice=<id>   # override voice
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

# Prefer $PWD (npm run sets it to the project's package.json dir) so the
# script works when `scripts/` is a symlink into shared/presentation/.
# Fall back to the script-relative path if $PWD isn't a presentation dir.
if [[ -f "$PWD/audio-segments.json" || -d "$PWD/src/chapters" ]]; then
  ROOT="$PWD"
else
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi
SEGMENTS="$ROOT/audio-segments.json"
OUT_DIR="$ROOT/public/audio"

DEFAULT_VOICE="Chinese (Mandarin)_Sincere_Adult"
FORCE=false
NO_EXTRACT=false
VOICE=""
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=true ;;
    --no-extract) NO_EXTRACT=true ;;
    --voice=*) VOICE="${arg#--voice=}" ;;
    *) echo "✗ unknown arg: $arg" >&2; exit 1 ;;
  esac
done
VOICE="${VOICE:-$DEFAULT_VOICE}"
VOICE_ARGS=(--voice "$VOICE")

if [[ "$NO_EXTRACT" != true ]]; then
  if [[ ! -d "$ROOT/src/chapters" ]]; then
    echo "✗ $ROOT/src/chapters not found — run this from a presentation dir, or pass --no-extract" >&2
    exit 1
  fi
  echo "→ extracting narrations …"
  ( cd "$ROOT" && npx --yes tsx scripts/extract-narrations.ts ) || {
    echo "✗ extract-narrations failed" >&2; exit 1; }
fi

if [[ ! -f "$SEGMENTS" ]]; then
  echo "✗ $SEGMENTS not found. Run without --no-extract, or: npm run extract-narrations" >&2
  exit 1
fi
if ! command -v mmx >/dev/null; then
  cat <<EOF >&2
✗ mmx CLI not found in PATH.

  Install:  npm install -g mmx-cli
  Login:    mmx auth login --api-key sk-xxxxx
            (get a key at https://platform.minimaxi.com)

If you don't want to use MiniMax, see references/AUDIO.md "用户自带 TTS"
for how to plug in any other TTS engine.
EOF
  exit 1
fi
if ! command -v jq >/dev/null; then
  echo "✗ jq is required to read audio-segments.json" >&2
  exit 1
fi

total=$(jq 'length' "$SEGMENTS")
i=0
synthesized=0
skipped=0
failed=0

while IFS= read -r row; do
  i=$((i + 1))
  chapter=$(echo "$row" | jq -r '.chapter')
  step=$(echo "$row" | jq -r '.step')
  text=$(echo "$row" | jq -r '.text')
  out="$OUT_DIR/$chapter/$step.mp3"

  if [[ -f "$out" && "$FORCE" != true ]]; then
    skipped=$((skipped + 1))
    printf "[%3d/%d] %-20s skip (exists)\n" "$i" "$total" "$chapter/$step.mp3"
    continue
  fi

  mkdir -p "$(dirname "$out")"
  start=$(date +%s)
  if mmx speech synthesize "${VOICE_ARGS[@]}" --text "$text" --out "$out" \
       >/dev/null 2>&1; then
    elapsed=$(( $(date +%s) - start ))
    synthesized=$((synthesized + 1))
    printf "[%3d/%d] %-20s ✓ %ss\n" "$i" "$total" "$chapter/$step.mp3" "$elapsed"
  else
    failed=$((failed + 1))
    printf "[%3d/%d] %-20s ✗ FAILED\n" "$i" "$total" "$chapter/$step.mp3" >&2
  fi
done < <(jq -c '.[]' "$SEGMENTS")

echo
echo "✓ done — synthesized $synthesized, skipped $skipped, failed $failed"
[[ $failed -eq 0 ]] || exit 2
