# README media: how to re-make them

These scripts make the hero GIF and the screenshots in `media/readme/`. Everything shown is real:
a ShowMe VSIX in a stock VS Code build, driven over MCP by a scripted "agent" that prints what it
does. The "human" clicks and keystrokes are xdotool events. The architecture diagram is separate:
`media/readme/how-it-fits.svg` is hand-written, and `render-diagram.sh` turns it into the PNG the
README shows (the Marketplace does not accept SVG images in a README).

## Requirements (Debian/Ubuntu, Linux only)

```sh
sudo apt-get install -y xvfb ffmpeg xdotool gifsicle fonts-noto-color-emoji   # recording
sudo apt-get install -y librsvg2-bin fonts-inter                              # the diagram
```

- `node` on `PATH`.
- A VS Code build. Default: the newest one the integration tests downloaded into
  `packages/extension/.vscode-test/`; override with `CODE_DIR=…`.
- `vsce` (default: the repository's `node_modules/.bin/vsce`; override with `VSCE=…`).
- A ShowMe VSIX (default: the newest `packages/extension/vscode-showme-*.vsix`, made by
  `npm run -w packages/extension package`; or pass a path, or set `SHOWME_VSIX`).

## One shot

```sh
scripts/media/run-all.sh [path/to/vscode-showme-X.Y.Z.vsix]
```

The output goes to `/tmp/showme-media-out` (`MEDIA_OUT=…` to change): `showme-hero.gif`,
`screenshot-bubbles-comments.png`, `screenshot-show-html.png`, `screenshot-statusbar.png` (the four
the README uses), plus an MP4 of the same take, two extra stills and `frames/` (frames taken from the
GIF, to check what readers will see). Look at them, then copy the four into `media/readme/`.

The diagram: `scripts/media/render-diagram.sh` (writes `media/readme/how-it-fits.png` at 2x).

## The steps, separately

- `setup.sh [vsix]` wipes and recreates `/tmp/showme-media` (`MEDIA_ROOT`): an isolated
  `--extensions-dir` / `--user-data-dir`, and a copy of `sample/` at `/tmp/demo-shop` (`DEMO_DIR`;
  the window title shows its folder name). It installs the ShowMe VSIX and the runner extension
  (packaged with vsce, so the title bar does not say "[Extension Development Host]"), and copies
  `settings.json` (light theme, font 15/14, telemetry/updates/welcome/minimap/trust/chat off).
- `record.sh record|calibrate|calibrate2 [workdir]` starts Xvfb `:99` (`MEDIA_DISPLAY`) at
  1280x720 and VS Code on the demo folder, and sizes the window with xdotool. The runner turns ShowMe
  on (`showme.toggle`, the same as the status bar item), makes a 38/62 two-column layout and starts
  `drive.js` as the shell of an editor-area terminal in the left column. When the runner and the
  bridge are ready, ffmpeg starts (x264 4:4:4, 24 fps, cursor drawn) and the script is told to go.
  After the take, the stills are shot. All processes are killed by PID on exit. It never touches
  another VS Code window: TMPDIR and XDG_RUNTIME_DIR (where ShowMe registers its socket) live under
  `MEDIA_ROOT`. The `calibrate*` phases stop early and save a screenshot (`<workdir>/raw/cal-N.png`)
  to find the button coordinates for `clicks.json`.
- `encode.sh <workdir> <outdir>` makes the GIF at 10 fps (one 160-color palette, no dithering,
  changed-rectangle frames, `gifsicle -O3`, last frame held 1.5 s), the MP4, the still crops, and 8
  review frames taken from the GIF (`FRAME_TIMES="…"` to change).

## Files

- `sample/` — the demo project (a TypeScript cart total, 2 files). `biome.json` leaves it out: its line
  layout is what the screenshots show, and `clicks.json` depends on it.
- `settings.json` — user settings of the isolated profile.
- `runner/` — helper extension: turns ShowMe on, sets the layout, starts the agent terminal, and
  runs VS Code commands that `drive.js` asks for through `$MEDIA_CTL/cmd-N.json` (for the stills).
- `drive.js` — the scripted agent. It starts `<extension>/bridge/index.js` with node and speaks
  MCP JSON-RPC over stdio, like an agent CLI would (initialize, `list_workspaces`,
  `annotate` with `reveal`, `show_html`), prints the agent transcript, and takes the stills. The
  human's two requests ("Use ShowMe to …") are real keystrokes typed into the terminal; the first is
  typed before recording starts (the take opens with Enter), so the empty right column shows only
  about 1 s. The agent never reacts to the human's clicks: it explains, stops, and only answers the
  next request. The text, the annotation items and the SVG diagram are at the top of the content
  section.
- `clicks.json` — screen coordinates (1280x720) of: bubble 1 "next", bubble 2 "next", the agent
  terminal (to focus it before typing), the resting mouse position, the panel sash (x, from-y, to-y),
  the editor scroll for the first still, and the status bar item.

If something moves (a new VS Code or ShowMe version, another font), run
`scripts/media/record.sh calibrate /tmp/showme-media-work` (then `calibrate2`), look at
`/tmp/showme-media-work/raw/cal-*.png` and fix `clicks.json`. The control files and logs of the last
run are in `/tmp/showme-media/ctl` (`marks.log` is the timeline, `calls.log` every MCP call and answer).

## Gotchas

- Electron bundles an older fontconfig that refuses the system font cache written by the newer
  system fontconfig, so it never saw the emoji font (bubble author names showed boxes instead of
  the colored circles). `record.sh` gives VS Code its own `XDG_CACHE_HOME` to fix this.
- `comments.collapseOnResolve` has no visible effect on ShowMe's threads; the resolved state shows
  only as a grey thread border and the check turning into an "unresolve" arrow, so the demo leaves
  Resolve out.
