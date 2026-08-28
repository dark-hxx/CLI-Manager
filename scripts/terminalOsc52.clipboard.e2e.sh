#!/usr/bin/env bash
# Host-side OSC 52 check: decode with the real frontend hook, then write/read
# this machine's X11 clipboard. Node must not spawn xclip itself — xclip holds
# the X selection and spawnSync will wait forever.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DISPLAY_NAME="${DISPLAY:-:11}"
export DISPLAY="$DISPLAY_NAME"

if ! command -v xclip >/dev/null; then
  echo "SKIP: xclip is not installed"
  exit 0
fi
if ! xdpyinfo -display "$DISPLAY_NAME" >/dev/null 2>&1; then
  echo "SKIP: X11 display $DISPLAY_NAME is not available"
  exit 0
fi

decode_osc52() {
  node "$ROOT/scripts/decodeOsc52Stream.mjs" "$1"
}

write_clip() {
  printf '%s' "$1" | xclip -selection clipboard -in
}

read_clip() {
  xclip -selection clipboard -o
}

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

payload=$'grok-e2e '"$(date +%s)"$'\n你好 second line'
b64=$(printf '%s' "$payload" | base64 -w0)
stream=$'prompt\033]52;c;'"$b64"$'\007after'
result=$(decode_osc52 "$stream")
visible=$(node -e 'const r=JSON.parse(process.argv[1]); process.stdout.write(r.visible)' "$result")
copied=$(node -e 'const r=JSON.parse(process.argv[1]); process.stdout.write(r.copied.join("\u0000"))' "$result")
[ "$visible" = "promptafter" ] || fail "visible output was: $visible"
[ "$copied" = "$payload" ] || fail "decoded copy was: $copied"
write_clip "$copied"
got=$(read_clip)
[ "$got" = "$payload" ] || fail "clipboard was: $got"
echo "PASS: live OSC 52 wrote this host clipboard"

tmux_payload="tmux-e2e-$(date +%s)"
tmux_b64=$(printf '%s' "$tmux_payload" | base64 -w0)
tmux_stream=$'\033Ptmux;\033\033]52;c;'"$tmux_b64"$'\007\033\\'
tmux_result=$(decode_osc52 "$tmux_stream")
tmux_visible=$(node -e 'const r=JSON.parse(process.argv[1]); process.stdout.write(r.visible)' "$tmux_result")
tmux_copied=$(node -e 'const r=JSON.parse(process.argv[1]); process.stdout.write(r.copied.join("\u0000"))' "$tmux_result")
[ "$tmux_visible" = "" ] || fail "tmux visible output was: $tmux_visible"
[ "$tmux_copied" = "$tmux_payload" ] || fail "tmux decoded copy was: $tmux_copied"
write_clip "$tmux_copied"
tmux_got=$(read_clip)
[ "$tmux_got" = "$tmux_payload" ] || fail "tmux clipboard was: $tmux_got"
echo "PASS: tmux DCS OSC 52 wrote this host clipboard"

write_clip "keep-me"
replay_stream=$'hist\033]52;c;'"$(printf '%s' should-not-replace | base64 -w0)"$'\007'
replay_result=$(APPLY_OSC52=false decode_osc52 "$replay_stream")
replay_visible=$(node -e 'const r=JSON.parse(process.argv[1]); process.stdout.write(r.visible)' "$replay_result")
replay_count=$(node -e 'const r=JSON.parse(process.argv[1]); process.stdout.write(String(r.copied.length))' "$replay_result")
[ "$replay_visible" = "hist" ] || fail "replay visible output was: $replay_visible"
[ "$replay_count" = "0" ] || fail "replay copied unexpectedly"
replay_got=$(read_clip)
[ "$replay_got" = "keep-me" ] || fail "replay overwrote clipboard: $replay_got"
echo "PASS: replay OSC 52 did not overwrite this host clipboard"
echo "OK"
