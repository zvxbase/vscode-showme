# Shared defaults for the media scripts (sourced by setup.sh and record.sh). Override any of them
# from the environment.
#   REPO        the repository root (default: two levels up from this folder)
#   CODE_DIR    a VS Code build to record with (default: the newest one the integration tests
#               downloaded into packages/extension/.vscode-test/)
#   VSCE        vsce, to package the runner extension (default: the repository's node_modules/.bin/vsce)
#   MEDIA_ROOT  the isolated profile, control files and logs (default: /tmp/showme-media)
#   DEMO_DIR    the copy of sample/ that VS Code opens (default: /tmp/demo-shop; the window title
#               shows its folder name)
MEDIA_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${REPO:-$(cd "$MEDIA_HERE/../.." && pwd)}"
if [ -z "${CODE_DIR:-}" ]; then
  CODE_DIR="$(ls -d "$REPO"/packages/extension/.vscode-test/vscode-linux-x64-* 2>/dev/null | sort -V | tail -n1 || true)"
fi
VSCE="${VSCE:-$REPO/node_modules/.bin/vsce}"
ROOT="${MEDIA_ROOT:-/tmp/showme-media}"
DEMO_DIR="${DEMO_DIR:-/tmp/demo-shop}"
if [ -z "$CODE_DIR" ] || [ ! -x "$CODE_DIR/code" ]; then
  echo "no VS Code build: set CODE_DIR (or run the integration tests once to download one)" >&2
  exit 2
fi
