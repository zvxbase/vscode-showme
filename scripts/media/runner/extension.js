// Tiny helper extension for recording README media (installed into the isolated profile by setup.sh).
// 1. turns ShowMe on for this window (status bar toggle command),
// 2. sets up a two-column layout with the scripted "agent" terminal in the left column,
// 3. executes VS Code commands that the drive script asks for via $MEDIA_CTL/cmd-*.json.
const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");

const CTL = process.env.MEDIA_CTL;
const NODE = process.env.MEDIA_NODE;
const DRIVE = process.env.MEDIA_DRIVE;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function log(msg) {
  if (CTL) fs.appendFileSync(path.join(CTL, "runner.log"), `${new Date().toISOString()} ${msg}\n`);
}

async function exec(cmd, ...args) {
  try {
    return await vscode.commands.executeCommand(cmd, ...args);
  } catch (e) {
    log(`command failed ${cmd}: ${e}`);
    return undefined;
  }
}

async function activate(context) {
  if (!CTL) return;
  log("runner activated");
  const showme = vscode.extensions.getExtension("zvxbase.vscode-showme");
  if (!showme) {
    log("ShowMe is not installed");
    return;
  }
  await showme.activate();
  await sleep(1500);

  // Quiet the workbench.
  await exec("workbench.action.closeSidebar");
  await exec("workbench.action.closeAuxiliaryBar");
  await exec("workbench.action.closePanel");
  await exec("notifications.clearAll");
  await exec("workbench.action.closeAllEditors");

  // Turn ShowMe on for this window (the same command as clicking the status bar item).
  await exec("showme.toggle");
  log("showme.toggle executed");

  // Left column: agent terminal. Right column: empty, ShowMe uses it.
  await exec("vscode.setEditorLayout", {
    orientation: 0,
    groups: [{ size: 0.38 }, { size: 0.62 }],
  });
  await exec("workbench.action.focusFirstEditorGroup");
  const term = vscode.window.createTerminal({
    name: "agent (scripted demo)",
    location: { viewColumn: vscode.ViewColumn.One },
    shellPath: NODE,
    shellArgs: [DRIVE],
    env: { MEDIA_CTL: CTL },
    isTransient: true,
  });
  term.show(false);
  await sleep(800);
  await exec("vscode.setEditorLayout", {
    orientation: 0,
    groups: [{ size: 0.38 }, { size: 0.62 }],
  });
  await exec("notifications.clearAll");
  fs.writeFileSync(path.join(CTL, "ready"), "1");
  log("ready");

  // Command channel for the drive script.
  const timer = setInterval(async () => {
    let files;
    try {
      files = fs
        .readdirSync(CTL)
        .filter((f) => /^cmd-\d+\.json$/.test(f))
        .sort();
    } catch {
      return;
    }
    for (const f of files) {
      const p = path.join(CTL, f);
      let req;
      try {
        req = JSON.parse(fs.readFileSync(p, "utf8"));
      } catch {
        continue;
      }
      fs.renameSync(p, `${p}.taken`);
      const out = await exec(req.command, ...(req.args ?? []));
      log(`ran ${req.command}`);
      fs.writeFileSync(`${p}.done`, JSON.stringify(out ?? null));
    }
  }, 150);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

module.exports = { activate, deactivate() {} };
