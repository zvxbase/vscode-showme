#!/usr/bin/env bash
# Launch VS Code (isolated profile) on a private Xvfb display, let the scripted agent run,
# and record the screen. Usage: scripts/media/record.sh [record|calibrate|calibrate2] [workdir]
# Run setup.sh first. The raw capture and the stills go to <workdir>/raw.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=env.sh
. "$HERE/env.sh"
PHASE="${1:-record}"
OUT="${2:-$ROOT/work}"
W=1280
H=720
DISP="${MEDIA_DISPLAY:-:99}"
NODE_BIN="$(command -v node)"
BRIDGE="$(echo "$ROOT"/ext/zvxbase.vscode-showme-*/bridge/index.js)"

mkdir -p "$OUT" "$OUT/raw"
OUT="$(cd "$OUT" && pwd)"
CTL="$ROOT/ctl"
rm -rf "$CTL" "$ROOT/xdg" "$ROOT/user/User/workspaceStorage" "$ROOT/user/Backups"
mkdir -p "$CTL" "$ROOT/xdg" "$ROOT/tmp"
chmod 700 "$ROOT/xdg" "$ROOT/tmp"

cat > "$CTL/config.json" <<EOF
{
  "phase": "$PHASE",
  "bridge": "$BRIDGE",
  "workspace": "$DEMO_DIR",
  "size": "${W}x${H}",
  "shotDir": "$OUT/raw",
  "clicks": $(cat "$HERE/clicks.json")
}
EOF

PIDS=()
cleanup() {
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
  sleep 1
  for p in "${PIDS[@]}"; do kill -9 "$p" 2>/dev/null || true; done
}
trap cleanup EXIT

Xvfb "$DISP" -screen 0 "${W}x${H}x24" -nolisten tcp >"$CTL/xvfb.log" 2>&1 &
PIDS+=($!)
sleep 1

export DISPLAY="$DISP"
export TMPDIR="$ROOT/tmp"
export XDG_RUNTIME_DIR="$ROOT/xdg"
# Electron bundles an older fontconfig that refuses the system cache (written by a newer one),
# so it would never see fonts installed later (e.g. the color emoji font). Give it its own cache.
export XDG_CACHE_HOME="$ROOT/cache"
export MEDIA_CTL="$CTL" MEDIA_NODE="$NODE_BIN" MEDIA_DRIVE="$HERE/drive.js"

env -u ELECTRON_RUN_AS_NODE -u VSCODE_IPC_HOOK_CLI -u VSCODE_IPC_HOOK -u VSCODE_PID -u VSCODE_CWD \
  -u VSCODE_NLS_CONFIG -u VSCODE_HANDLES_UNCAUGHT_ERRORS -u VSCODE_ESM_ENTRYPOINT -u SHOWME_SOCK \
  "$CODE_DIR/code" \
  --extensions-dir "$ROOT/ext" --user-data-dir "$ROOT/user" \
  --disable-workspace-trust --skip-welcome --skip-release-notes --disable-telemetry \
  --disable-gpu --no-sandbox --new-window --locale=en \
  "$DEMO_DIR" >"$CTL/code.log" 2>&1 &
PIDS+=($!)

# Size the window to the whole screen (there is no window manager on Xvfb).
for _ in $(seq 1 60); do
  WID="$(xdotool search --onlyvisible --class code 2>/dev/null | tail -n1 || true)"
  [ -n "$WID" ] && break
  sleep 0.5
done
xdotool windowmove "$WID" 0 0 windowsize "$WID" "$W" "$H" || true

for _ in $(seq 1 120); do [ -f "$CTL/ready" ] && [ -f "$CTL/prepped" ] && break; sleep 0.5; done
[ -f "$CTL/prepped" ] || { echo "not ready (see $CTL)"; exit 1; }
xdotool windowmove "$WID" 0 0 windowsize "$WID" "$W" "$H" || true
xdotool mousemove 360 450
sleep 1.5

if [ "$PHASE" = record ]; then
  ffmpeg -loglevel error -y -f x11grab -framerate 24 -video_size "${W}x${H}" -draw_mouse 1 -i "$DISP" \
    -c:v libx264 -preset veryfast -crf 12 -pix_fmt yuv444p "$OUT/raw/hero.mkv" </dev/null &
  FF=$!
  PIDS+=($FF)
  sleep 0.8
fi
touch "$CTL/go"
for _ in $(seq 1 240); do [ -f "$CTL/done" ] && break; sleep 0.25; done
if [ "$PHASE" = record ]; then
  sleep 0.3
  kill -INT "$FF"
  wait "$FF" || true
  touch "$CTL/stills"
  for _ in $(seq 1 120); do [ -f "$CTL/stills-done" ] && break; sleep 0.25; done
fi
echo "phase $PHASE finished; control dir $CTL"
cat "$CTL/marks.log" 2>/dev/null || true
