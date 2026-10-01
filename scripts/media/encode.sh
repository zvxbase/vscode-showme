#!/usr/bin/env bash
# Turn the raw capture into the README GIF, crop the stills, and extract review frames.
# Usage: scripts/media/encode.sh <workdir-with-raw/> <outdir>
# The README uses showme-hero.gif and screenshot-{bubbles-comments,show-html,statusbar}.png;
# the rest (MP4, full status bar, 1x crop, frames/) is for review.
set -euo pipefail
WORK="${1:?workdir (the one given to record.sh)}"
OUT="${2:?outdir}"
FPS="${FPS:-10}"
RAW="$WORK/raw"
mkdir -p "$OUT/frames"

# GIF: one global palette (the UI has few colors), no dithering (keeps text crisp), only changed
# rectangles are re-encoded. Starts 1.3 s in: the first frame already shows the typed request, so the empty right column is on screen only ~1 s.
ffmpeg -loglevel error -y -ss 1.3 -i "$RAW/hero.mkv" -vf \
  "fps=$FPS,split[a][b];[a]palettegen=max_colors=160:stats_mode=full:reserve_transparent=0[p];[b][p]paletteuse=dither=none:diff_mode=rectangle" \
  -loop 0 -final_delay 150 "$OUT/hero-raw.gif"
# -final_delay holds the last frame 1.5 s, so the diagram can be read before the loop restarts.
gifsicle -O3 "$OUT/hero-raw.gif" -o "$OUT/showme-hero.gif"
rm -f "$OUT/hero-raw.gif"

# Also an MP4 (much smaller; GitHub READMEs can embed it via a user-attachments upload).
ffmpeg -loglevel error -y -ss 1.3 -i "$RAW/hero.mkv" -vf "fps=24,format=yuv420p" -c:v libx264 -crf 20 \
  -preset slow -movflags +faststart "$OUT/showme-hero.mp4"

# Stills
cp "$RAW/still-bubbles-comments.png" "$OUT/screenshot-bubbles-comments.png"
cp "$RAW/still-show-html.png" "$OUT/screenshot-show-html.png"
cp "$RAW/still-statusbar-full.png" "$OUT/screenshot-statusbar-full.png"
# status bar crop (right end, with the item's tooltip), 1x and 2x
ffmpeg -loglevel error -y -i "$RAW/still-statusbar-hover.png" -vf "crop=342:68:938:652" "$OUT/screenshot-statusbar-crop.png"
ffmpeg -loglevel error -y -i "$RAW/still-statusbar-hover.png" -vf "crop=342:68:938:652,scale=iw*2:ih*2:flags=lanczos" "$OUT/screenshot-statusbar.png"
for f in "$OUT"/screenshot-*.png; do
  command -v optipng >/dev/null && optipng -quiet -o2 "$f" || true
done

# Review frames taken from the GIF itself (what the reader will actually see).
rm -f "$OUT"/frames/*.png
i=0
for t in ${FRAME_TIMES:-0.1 1.0 2.2 3.6 6.0 9.5 12.2 15.5}; do
  i=$((i + 1))
  ffmpeg -loglevel error -y -ss "$t" -i "$OUT/showme-hero.gif" -frames:v 1 "$OUT/frames/frame-$i-t${t}s.png"
done

ls -la "$OUT" "$OUT/frames"
