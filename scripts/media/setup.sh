#!/usr/bin/env bash
# Prepare an isolated VS Code profile with ShowMe installed, and the sample workspace.
# Usage: scripts/media/setup.sh [path-to-vsix]
#   The VSIX defaults to $SHOWME_VSIX, then to the newest packages/extension/*.vsix
#   (npm run -w packages/extension package).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=env.sh
. "$HERE/env.sh"
VSIX="${1:-${SHOWME_VSIX:-$(ls "$REPO"/packages/extension/vscode-showme-*.vsix 2>/dev/null | sort -V | tail -n1 || true)}}"
[ -f "$VSIX" ] || { echo "no VSIX: pass one, set SHOWME_VSIX, or run npm run -w packages/extension package" >&2; exit 2; }

rm -rf "$ROOT" "$DEMO_DIR"
mkdir -p "$ROOT"/{ext,user/User,tmp}
chmod 700 "$ROOT/tmp"

# Sample project, under a neutral name (the window title shows it).
cp -r "$HERE/sample" "$DEMO_DIR"

# Install the VSIX with the VS Code CLI (must not run as node / talk to another window).
env -u ELECTRON_RUN_AS_NODE -u VSCODE_IPC_HOOK_CLI \
  "$CODE_DIR/bin/code" --extensions-dir "$ROOT/ext" --user-data-dir "$ROOT/user" \
  --install-extension "$VSIX" --force

# The runner is installed as a normal extension (loading it with --extensionDevelopmentPath
# would put "[Extension Development Host]" in the window title).
(cd "$HERE/runner" && "$VSCE" package --allow-missing-repository --skip-license -o "$ROOT/runner.vsix" >/dev/null)
env -u ELECTRON_RUN_AS_NODE -u VSCODE_IPC_HOOK_CLI \
  "$CODE_DIR/bin/code" --extensions-dir "$ROOT/ext" --user-data-dir "$ROOT/user" \
  --install-extension "$ROOT/runner.vsix" --force

cp "$HERE/settings.json" "$ROOT/user/User/settings.json"
echo "setup done: $ROOT"
