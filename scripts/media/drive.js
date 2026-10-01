const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const CTL = process.env.MEDIA_CTL;
const cfg = JSON.parse(fs.readFileSync(path.join(CTL, "config.json"), "utf8"));
const clicks = cfg.clicks;
const PHASE = cfg.phase; // "calibrate" | "record"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
function mark(name) {
  fs.appendFileSync(
    path.join(CTL, "marks.log"),
    `${((Date.now() - t0) / 1000).toFixed(2)} ${name}\n`,
  );
}

// ---- terminal output -------------------------------------------------------------------------
const DIM = "\x1b[90m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

// Types text after a prefix, word-wrapping to the terminal width with a hanging indent.
async function type(prefix, text, cps = 45, indent = 8) {
  const cols = (process.stdout.columns || 80) - 1;
  process.stdout.write(prefix);
  let col = indent;
  const words = text.split(" ");
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (i > 0) {
      if (col + 1 + w.length > cols) {
        process.stdout.write(`\r\n${" ".repeat(indent)}`);
        col = indent;
      } else {
        process.stdout.write(" ");
        col += 1;
        await sleep(1000 / cps);
      }
    }
    for (const ch of w) {
      process.stdout.write(ch);
      col += 1;
      await sleep(1000 / cps);
    }
  }
  process.stdout.write(`${RESET}\r\n`);
}
const say = (text, cps) => type(`${BOLD}${CYAN}agent ›${RESET} `, text, cps);
function tool(text) {
  process.stdout.write(`${DIM}  ⚙ ${text}${RESET}\r\n`);
}
function ok(text) {
  process.stdout.write(`${GREEN}  ✓ ${text}${RESET}\r\n`);
}
function human(text) {
  process.stdout.write(`${DIM}  (you click ${text})${RESET}\r\n`);
}

// ---- MCP over stdio --------------------------------------------------------------------------
function startBridge() {
  const child = cp.spawn(process.execPath, [cfg.bridge], {
    cwd: cfg.workspace,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  let buf = "";
  let stderr = "";
  const pending = new Map();
  child.stderr.on("data", (d) => {
    stderr += d;
    fs.appendFileSync(path.join(CTL, "bridge.stderr"), d);
  });
  child.stdout.on("data", (d) => {
    buf += d.toString("utf8");
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (typeof msg.id === "number") pending.get(msg.id)?.(msg);
    }
  });
  let id = 0;
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const my = ++id;
      const timer = setTimeout(() => reject(new Error(`${method} timed out: ${stderr}`)), 30000);
      pending.set(my, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: my, method, params })}\n`);
    });
  const notify = (method, params) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  return { child, request, notify };
}

async function callTool(mcp, name, args) {
  const res = await mcp.request("tools/call", { name, arguments: args });
  fs.appendFileSync(
    path.join(CTL, "calls.log"),
    `${name} ${JSON.stringify(args).slice(0, 200)}\n=> ${JSON.stringify(res).slice(0, 1500)}\n`,
  );
  return res;
}

// ---- the "human" -----------------------------------------------------------------------------
function xdo(...args) {
  cp.execFileSync("xdotool", args.map(String));
}
async function click(name) {
  const c = clicks[name];
  if (!c) throw new Error(`no click coordinates for ${name}`);
  xdo("mousemove", c[0], c[1]);
  await sleep(450);
  xdo("click", "1");
  mark(`click ${name}`);
}
async function moveAway() {
  xdo("mousemove", clicks.rest[0], clicks.rest[1]);
}

function shot(name) {
  const out = path.join(cfg.shotDir, `${name}.png`);
  cp.execFileSync("ffmpeg", [
    "-loglevel",
    "error",
    "-y",
    "-f",
    "x11grab",
    "-video_size",
    cfg.size,
    "-draw_mouse",
    "0",
    "-i",
    process.env.DISPLAY,
    "-frames:v",
    "1",
    out,
  ]);
}

let cmdSeq = 0;
async function vscodeCommand(command, ...args) {
  const p = path.join(CTL, `cmd-${String(++cmdSeq).padStart(4, "0")}.json`);
  fs.writeFileSync(`${p}.tmp`, JSON.stringify({ command, args }));
  fs.renameSync(`${p}.tmp`, p);
  for (let i = 0; i < 100; i++) {
    if (fs.existsSync(`${p}.done`)) return;
    await sleep(100);
  }
}

// ---- the human's chat input: real keystrokes (xdotool type) read from this terminal ----------
let keyBuf = "";
let keyWaiter = null;
process.stdin.setRawMode?.(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  keyBuf += d;
  keyWaiter?.();
});
// Echoes what the human types. Line breaks are placed at word boundaries of the expected text,
// so the message wraps like the agent's lines instead of breaking mid-word.
function wrapBreaks(text, indent) {
  const cols = (process.stdout.columns || 80) - 1;
  const breaks = new Set();
  let col = indent;
  let pos = 0;
  text.split(" ").forEach((w, i) => {
    if (i > 0) {
      if (col + 1 + w.length > cols) {
        breaks.add(pos - 1); // the space before this word
        col = indent;
      } else col += 1;
    }
    col += w.length;
    pos += w.length + 1;
  });
  return breaks;
}
async function readLineEcho(expected) {
  const breaks = wrapBreaks(expected, 6);
  let line = "";
  for (;;) {
    while (keyBuf === "")
      await new Promise((r) => {
        keyWaiter = r;
      });
    const ch = keyBuf[0];
    keyBuf = keyBuf.slice(1);
    if (ch === "\r" || ch === "\n") break;
    if (ch >= " ") {
      if (ch === " " && breaks.has(line.length)) process.stdout.write(`\r\n${" ".repeat(6)}`);
      else process.stdout.write(ch);
      line += ch;
    }
  }
  process.stdout.write("\r\n");
  return line;
}
// mode "pre": typed before the recording starts; Enter is pressed after "go".
async function humanTypes(text, mode) {
  process.stdout.write(`${BOLD}you ›${RESET} `);
  const done = readLineEcho(text);
  if (mode === "pre") {
    // make sure the terminal has keyboard focus before the first keystroke
    xdo("mousemove", clicks.terminal[0], clicks.terminal[1]);
    xdo("click", "1");
    await sleep(800);
    await moveAway();
  }
  xdo("type", "--delay", "45", text);
  if (mode === "pre") {
    fs.writeFileSync(path.join(CTL, "prepped"), "1");
    while (!fs.existsSync(path.join(CTL, "go"))) await sleep(50);
    mark("go");
    await sleep(500);
  } else {
    await sleep(350);
  }
  xdo("key", "Return");
  mark(`human typed: ${text}`);
  return done;
}

// ---- content ---------------------------------------------------------------------------------
const ITEMS = [
  {
    location: { path: "src/cart.ts", text: "applyDiscount(base, cart.couponCode)" },
    color: "red",
    text: "The coupon comes off the subtotal first.",
  },
  {
    location: { path: "src/pricing.ts", text: "amount * (1 - rate)" },
    color: "blue",
    text: "WELCOME10 takes 10% off: $80.00 becomes $72.00.",
  },
  {
    location: { path: "src/cart.ts", text: "addTax(discounted, cart.region)" },
    color: "green",
    text: "Tax is computed on that discounted amount, not on the subtotal.",
  },
];

const DIAGRAM = `
<div style="font-family:sans-serif;padding:8px 16px;color:#1f2328;background:#ffffff">
<h2 style="margin:0 0 16px 0;font-weight:600;font-size:24px">cartTotal(): coupon first, then tax</h2>
<svg viewBox="0 0 640 360" width="100%" xmlns="http://www.w3.org/2000/svg" font-family="sans-serif" font-size="19">
  <defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#57606a"/></marker></defs>
  <rect x="1" y="10" width="118" height="84" rx="10" fill="#f6f8fa" stroke="#57606a" stroke-width="1.5"/>
  <text x="60" y="45" text-anchor="middle" font-weight="600">subtotal</text>
  <text x="60" y="74" text-anchor="middle" fill="#57606a" font-size="17">$80.00</text>
  <rect x="155" y="10" width="160" height="84" rx="10" fill="#ffebe9" stroke="#cf222e" stroke-width="1.5"/>
  <text x="235" y="45" text-anchor="middle" font-weight="600">applyDiscount</text>
  <text x="235" y="74" text-anchor="middle" fill="#57606a" font-size="17">−10% → $72.00</text>
  <rect x="351" y="10" width="150" height="84" rx="10" fill="#dafbe1" stroke="#1a7f37" stroke-width="1.5"/>
  <text x="426" y="45" text-anchor="middle" font-weight="600">addTax</text>
  <text x="426" y="74" text-anchor="middle" fill="#57606a" font-size="17">+7.25% → $77.22</text>
  <rect x="537" y="10" width="102" height="84" rx="10" fill="#f6f8fa" stroke="#57606a" stroke-width="1.5"/>
  <text x="588" y="45" text-anchor="middle" font-weight="600">total</text>
  <text x="588" y="74" text-anchor="middle" fill="#57606a" font-size="17">$77.22</text>
  <line x1="119" y1="52" x2="153" y2="52" stroke="#57606a" stroke-width="2.5" marker-end="url(#a)"/>
  <line x1="315" y1="52" x2="349" y2="52" stroke="#57606a" stroke-width="2.5" marker-end="url(#a)"/>
  <line x1="501" y1="52" x2="535" y2="52" stroke="#57606a" stroke-width="2.5" marker-end="url(#a)"/>
  <text x="1" y="160" font-weight="600">Tax is charged on the discounted amount</text>
  <text x="1" y="215" font-size="17">with WELCOME10</text>
  <rect x="160" y="196" width="219" height="26" rx="4" fill="#1a7f37" fill-opacity="0.75"/>
  <text x="391" y="215" font-size="17">$72.00 × 7.25% = <tspan font-weight="600">$5.22</tspan></text>
  <text x="1" y="265" font-size="17">without coupon</text>
  <rect x="160" y="246" width="244" height="26" rx="4" fill="#8c959f" fill-opacity="0.75"/>
  <text x="416" y="265" font-size="17">$80.00 × 7.25% = $5.80</text>
  <text x="1" y="330" font-size="16" fill="#57606a">src/cart.ts: subtotal → applyDiscount → addTax → roundToCents</text>
</svg>
</div>`;

// ---- scenario --------------------------------------------------------------------------------
async function main() {
  process.stdout.write("\x1b[2J\x1b[H\x1b[?25l");
  process.stdout.write(`${DIM}scripted demo agent · real ShowMe tool calls${RESET}\r\n\r\n`);
  const mcp = startBridge();
  const init = await mcp.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "showme-media-demo", version: "0" },
  });
  fs.appendFileSync(path.join(CTL, "calls.log"), `init ${JSON.stringify(init).slice(0, 400)}\n`);
  mcp.notify("notifications/initialized", {});
  const lw = await callTool(mcp, "list_workspaces", {});
  fs.writeFileSync(path.join(CTL, "bridge-ok"), "1");

  // The human's first request is typed (into this terminal, with xdotool) before the recording
  // starts, so the empty right column is on screen only briefly; the take begins with Enter.
  const first = humanTypes(
    "Use ShowMe to show me why the tax is lower when I use a coupon.",
    "pre",
  );
  await first;
  await sleep(150);
  await say(
    "The coupon comes off first, so tax is charged on the smaller amount. I've marked the three steps.",
    110,
  );
  tool("annotate  3 items · reveal: true");
  mark("annotate");
  const r = await callTool(mcp, "annotate", { items: ITEMS, reveal: true });
  const n = r?.result?.structuredContent?.resolutions?.length ?? ITEMS.length;
  ok(`${n} bubbles placed, src/cart.ts opened`);
  await sleep(700);
  await say("Read them in order; ← → on a bubble moves between them.", 60);
  mark("agent-stops");
  await sleep(1600);

  if (PHASE === "calibrate") {
    shot("cal-1");
    fs.writeFileSync(path.join(CTL, "done"), "1");
    return;
  }

  // The human reads the bubbles. The agent does nothing meanwhile.
  await click("next1");
  await moveAway();
  await sleep(2600);
  if (PHASE === "calibrate2") {
    shot("cal-2");
    fs.writeFileSync(path.join(CTL, "done"), "1");
    return;
  }
  await click("next2");
  await moveAway();
  await sleep(2400);

  // The human's next message, typed into the terminal.
  await click("terminal");
  await sleep(300);
  await humanTypes("Use ShowMe to draw that flow as a diagram.", "live");
  await sleep(250);
  await say("Here it is.", 40);
  tool("show_html  (SVG)");
  mark("show_html");
  await callTool(mcp, "show_html", { html: DIAGRAM, title: "cartTotal flow" });
  ok("diagram shown");
  await sleep(3400);
  mark("end");
  fs.writeFileSync(path.join(CTL, "done"), "1");

  // ---- stills (after the GIF recording has stopped) ----
  while (!fs.existsSync(path.join(CTL, "stills"))) await sleep(100);
  // (2) the show_html panel with the diagram, as it is now
  shot("still-show-html");
  // (1) bubbles + Comments panel: bring the code back and open the Comments panel
  await vscodeCommand("workbench.action.focusCommentsPanel");
  await sleep(800);
  // make the panel shorter by dragging its top edge (sash) down
  const sash = clicks.panelSash;
  xdo("mousemove", sash[0], sash[1]);
  await sleep(300);
  xdo("mousedown", "1");
  for (let y = sash[1]; y <= sash[2]; y += 10) {
    xdo("mousemove", sash[0], y);
    await sleep(20);
  }
  xdo("mouseup", "1");
  await moveAway();
  await sleep(500);
  await callTool(mcp, "annotate", { items: ITEMS, reveal: true });
  await sleep(1200);
  await vscodeCommand("workbench.action.focusSecondEditorGroup");
  await sleep(300);
  await vscodeCommand("editorScroll", { to: "down", by: "line", value: clicks.stillScroll ?? 0 });
  await sleep(1000);
  shot("still-bubbles-comments");
  // (3) status bar, plus its tooltip
  await vscodeCommand("workbench.action.closePanel");
  await sleep(800);
  shot("still-statusbar-full");
  xdo("mousemove", clicks.statusItem[0], clicks.statusItem[1]);
  await sleep(2500);
  shot("still-statusbar-hover");
  await moveAway();
  fs.writeFileSync(path.join(CTL, "stills-done"), "1");
  await sleep(1000);
  mcp.child.kill();
}

main().catch((e) => {
  fs.appendFileSync(path.join(CTL, "drive.err"), `${e.stack}\n`);
  process.stdout.write(`\r\nERROR ${e.message}\r\n`);
  fs.writeFileSync(path.join(CTL, "done"), "1");
  fs.writeFileSync(path.join(CTL, "stills-done"), "1");
});
