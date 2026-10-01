#!/usr/bin/env bash
# Rasterize the hand-written architecture diagram for the README.
# The README shows the PNG: vsce (and so the Marketplace page) refuses SVG images in a README.
# The SVG stays in the repository as the source. Needs rsvg-convert (librsvg2-bin) and the Inter
# font (fonts-inter); without Inter the text falls back to another sans-serif and may not fit.
# Usage: scripts/media/render-diagram.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DIR="$HERE/../../media/readme"
if [[ "$(fc-match -f "%{family}" Inter)" != Inter* ]]; then
  echo "the Inter font is not installed (sudo apt-get install -y fonts-inter)" >&2
  exit 2
fi
rsvg-convert --zoom 2 "$DIR/how-it-fits.svg" -o "$DIR/how-it-fits.png"
command -v optipng >/dev/null && optipng -quiet -o2 "$DIR/how-it-fits.png" || true
echo "wrote media/readme/how-it-fits.png"
