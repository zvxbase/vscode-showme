#!/usr/bin/env bash
# Full pipeline: isolated profile -> record -> encode.
# Usage: scripts/media/run-all.sh [path-to-vsix]
# Output: $MEDIA_OUT (default /tmp/showme-media/out). Copy the four README files from there into
# media/readme/ after looking at them (and at frames/).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${MEDIA_WORK:-${MEDIA_ROOT:-/tmp/showme-media}-work}"
OUT="${MEDIA_OUT:-${MEDIA_ROOT:-/tmp/showme-media}-out}"
"$HERE/setup.sh" "$@"
"$HERE/record.sh" record "$WORK"
"$HERE/encode.sh" "$WORK" "$OUT"
