# vscode-showme

> 日本語: [README.ja.md](README.ja.md)

**Give AI agents hands in VS Code.**

Claude Code, Copilot CLI and Codex can change your code, but they cannot touch your screen.
vscode-showme fills exactly that gap: while an agent walks you through an unfamiliar repository,
it can open the file, highlight the lines, put two places side by side, leave numbered
annotations, draw a diagram and pin a note — the way a colleague sitting next to you would.

## What it does not do

- No code editing, no shell, no diagnostics/LSP — your agent already has those.
- No pre-generated tours, no LLM calls of its own. The teaching is the agent's job.

## Getting started

You need two things: the extension (the "hands" inside VS Code) and a one-time registration in
your agent (so the agent can talk to it). The bridge the agent talks to is bundled with the
extension — there is nothing to install from npm.

### 1. Install the extension

From the VS Code Marketplace or Open VSX (`zvxbase.vscode-showme`), or download the VSIX from
[Releases](https://github.com/zvxbase/vscode-showme/releases) and run
`code --install-extension vscode-showme-<version>.vsix`.

### 2. Register ShowMe with your agent

Run **ShowMe: Show agent configuration** from the Command Palette. It opens an untitled document
with ready-to-paste snippets for Claude Code, Codex CLI and Copilot CLI, filled in with the real
install path. Copy the one for your agent. ShowMe never edits other tools' configuration files
itself.

- **Claude Code** — one `claude mcp add showme -- node …` line, plus a list of permission rules to
  add to `permissions.allow` in `.claude/settings.json`. Without those rules, Claude Code asks for
  confirmation on every call, even for display-only tools.
- **Codex CLI** — a `[mcp_servers.showme]` section for `~/.codex/config.toml`. No permission
  setup is needed.
- **Copilot CLI** — a `"showme"` entry for `~/.copilot/mcp-config.json`; start it with
  `--allow-tool 'showme'`.
- **Copilot agent mode inside VS Code** — nothing to do. The extension registers itself as an
  MCP server (this does not work in Restricted Mode).

The snippets start the newest ShowMe installed, so you do not need to paste them again after the
extension updates.

`arrange_editors` is left out of the Claude Code allow list on purpose: it is the only tool that
can close tabs. Add `"mcp__showme__arrange_editors"` yourself if you want it.

The agent and VS Code must run on the same machine and in the same environment: in a
devcontainer, both inside the container; with Remote-SSH, both on the remote side.

### 3. Turn it on in the window you want the agent to use

Nothing is driven until you allow it. Click **`ShowMe: Off`** in the status bar of that window →
it becomes **`ShowMe: On`**, and **`ShowMe: Connected`** once the agent connects. Click again to
turn it off. You can open the same folder in two windows and turn ShowMe on in only one of them;
the agent uses that one.

### 4. Ask your agent

Talk to your agent as usual and ask it to show you things, for example:

- "Walk me through how a request is handled in this repo. Show me each step in the editor."
- "Show me where `parseConfig` is defined and where it is used, side by side."
- "Annotate the important lines of `src/server.ts` in reading order."
- "Draw a diagram of how these modules depend on each other."

## What you will see

- **The agent's tabs** — files the agent shows open in its own tabs: a read-only mirror of the file
  that also shows your unsaved edits. The tab name is colored and carries an **SM** badge (read-only
  tabs show a lock icon instead), so you can tell them apart from your own; Go to Definition and
  Find References work there too. They stay the agent's even if you move them, so it can tidy them
  up. A tab you open yourself on the same file stays yours.
- **Open the real file** — the **`ShowMe: Open the real file`** button in the tab title bar opens
  the same file at the same line in the column you're in (next to the agent's tab). That tab is yours, not the agent's.
- **Highlight** — the lines the agent is talking about right now. The next `show_code` replaces it.
- **Annotations** — speech bubbles under lines in the agent's tabs, numbered in the agent's reading order (`1/7 ·`).
  Use the `‹ ›` buttons in the bubble, or **Next annotation / Previous annotation**, to follow
  them. They open the agent's tab, possibly in your column, and the agent may tidy it up once
  you look away. **Resolve** marks one as read.
- **HTML panels** — tables and diagrams. Scripts never run in them.
- **Notes** — an untitled editor. Nothing is saved unless you save it.
- **Clean up** — **ShowMe: Clear highlights** and **ShowMe: Clear annotations**.

## Tools

| Tool | What it does |
|---|---|
| `list_workspaces` | Tells the agent which VS Code window it is connected to |
| `get_editor_state` | Where you are looking: active file, cursor, selection, visible lines, open tabs |
| `show_code` | Opens a file, scrolls to a location and highlights it. `realFile: true` opens the real file instead, for you to edit |
| `annotate` | Leaves numbered speech bubbles under lines (`realFile: true` puts them on the real file, for use after `show_code realFile: true`) |
| `show_html` | Shows a table or diagram in a panel (no scripts) |
| `show_note` | Opens an untitled note |
| `find_definition` | Where a symbol is defined (like Go to Definition) |
| `find_references` | Where a symbol is used |
| `show_view` | Reveals a file in the explorer, switches the sidebar, toggles the panel, Zen mode |
| `arrange_editors` | Arranges and tidies editor columns (closes only its own panels by default) |

No tool returns file contents. The agent reads files with its own tools.

## Settings

All of these are user settings. A repository's `.vscode/settings.json` cannot change the safety
settings.

| Setting | Default | Meaning |
|---|---|---|
| `showme.stage.enabled` | `true` | Let the agent open files, scroll and split. When off, `show_code` only marks lines |
| `showme.stage.agentTabs` | `true` | Open the agent's editors as its own tabs (a mirror of the file). When off, it opens ordinary file tabs as before |
| `showme.stage.editable` | `false` | Let you edit and save in the agent's tabs. Saving writes the real file; a file you can't write (read-only on disk, or a hard link) opens read-only |
| `showme.stage.definitionTarget` | `"file"` | Where Go to Definition / Find References from the agent's tab take you: the real file, or the agent's tab |
| `showme.html.enabled` | `true` | Allow `show_html` |
| `showme.layout.enabled` | `true` | Allow `arrange_editors` and `show_view` |
| `showme.layout.closeHumanTabs` | `false` | Let `arrange_editors` close or move tabs you opened |
| `showme.layout.closeDirtyTabs` | `false` | …including unsaved ones |
| `showme.redactedPathPatterns` | `[]` | More paths to hide from the agent. The built-in list (`.env`, keys, …) cannot be removed |
| `showme.maxSelectionChars` | `4000` | How much selected text `get_editor_state` may return |
| `showme.injectTerminalEnv` | `true` | Put `SHOWME_SOCK` into integrated terminals |
| `showme.listAllWorkspaces` | `false` | Let the agent see other windows' folder paths |
| `showme.stage.avoidToolColumns` | `false` | Keep the agent's editors, notes and panels out of a column whose visible tab is a terminal, another extension's panel, or another non-file tab such as Settings. It uses another column instead, and refuses if none can be used; `arrange_editors` also refuses presets and moves that would use such a column. `showme.stage.editorGroup: "active"` only affects where the agent opens things — the `arrange_editors` refusals still apply |

To stop everything at once: **ShowMe: Stop / Resume the extension**. Every tool call is recorded
in **ShowMe: Show the operations log** (selected text is not recorded).

## Troubleshooting

Look at the status bar first — ShowMe shows what it is doing there.

| Status bar | Meaning |
|---|---|
| `ShowMe: Off` | This window is not lent to the agent. Click to turn it on |
| `ShowMe: On` | Turned on, but no agent is connected yet |
| `ShowMe: Connected` | Working |
| `ShowMe: Stopped` | The extension is stopped. Run **ShowMe: Stop / Resume the extension** |
| `ShowMe: Failed to start` | The tooltip says why. If it names a directory, check its owner and permissions with `ls -ld` |
| `ShowMe: second connection refused` | Only one agent can connect at a time. Stop the other one. If you are not running a second agent, some other process of yours connected first — find out what it is |
| `ShowMe: not found …` / `multiple matches …` | The agent looked for a location and did not find exactly one. The agent needs to be more specific |
| `ShowMe: rate limited …` | The agent repeated the same request too quickly |

**The agent says it cannot find a VS Code window.** Check that ShowMe is `On` in a window, that
the agent runs in the same environment as VS Code (see step 2), and that both see the same
`$TMPDIR`.

**`.env` or a key file is "not found".** That is intended: ShowMe hides those paths and does not
reveal where they are.

## Uninstall

Remove your agent's registration first and the extension last. The full steps are in
**ShowMe: Show teardown steps and how to remove the configuration**, which lives in the extension
and disappears with it.

1. Remove ShowMe from your agent:
   - Claude Code: `claude mcp remove showme`, and delete the `mcp__showme__*` lines you added to
     `permissions.allow` in `.claude/settings.json`
   - Codex CLI: delete the `[mcp_servers.showme]` section in `~/.codex/config.toml`
   - Copilot CLI: delete the `"showme"` entry in `~/.copilot/mcp-config.json`
2. Uninstall the extension: `code --uninstall-extension zvxbase.vscode-showme`. It removes its
   socket and registration files by itself. `showme.*` entries in your user settings stay until
   you delete them.
3. Reopen terminals that were already open (or `unset SHOWME_SOCK`).

If you uninstall the extension but leave the agent's registration, the agent only fails to start
ShowMe with `ShowMe is not installed in …`. Nothing else happens, but remove the entry to stop
the error.

## Safety, in one table

| Property | How |
|---|---|
| No network listener | Unix socket / named pipe only. No HTTP server, ever. |
| No tool returns file contents | `show_code` returns the resolved position and how it was resolved — never text. |
| Selection is never moved | Highlights use decorations; alignment uses `revealRange`. Moving the selection would leak text through `get_editor_state`. |
| Agent HTML has no script | Double iframe, inner `sandbox=""`, `connect-src 'none'`, `img-src data:`. |
| The agent's stage is bounded | At most 2 editor columns, never the column you are working in. Tidy-up (`arrange_editors`) only closes panels the agent itself opened unless you opt in. |
| Safety settings are not read from the workspace | Only user-level settings count. The repository you are reading may be hostile; its `.vscode/settings.json` cannot widen anything. |
| Off by default | The status bar shows `ShowMe: Off`. Nothing is driven until you click it. One click stops everything. Works in Restricted Mode. |

What is in scope for security reports, and what is not, is in [`SECURITY.md`](SECURITY.md).

## Status

**Preview.** Verified on Linux (unit + integration tests in a real VS Code). macOS uses the same Unix-socket path but has not been verified yet; Windows named-pipe support is written but not yet verified. CI runs both as non-blocking observations. This is a personal project without an SLA; issues and PRs are welcome and are answered by the maintainer when time allows. Development happens in a private repository and each release is published here as one commit — see `CONTRIBUTING.md`.

## How this was built

The code was written with Claude Code. Every change went through a specification review and a
quality review (including mutation checks of the tests) before merge. The safety properties above
are enforced by tests, not by convention — see `test/` for the repository-wide checks (for example
"only one sanitizer" and "no tool returns file contents") and the unit and integration suites under
`packages/`.

## License

MIT. The extension bundles third-party components (the MCP SDK, zod, parse5 and their
dependencies — all MIT, ISC or BSD); their licenses are reproduced in `THIRD-PARTY-NOTICES.txt`
inside the VSIX, generated from what the build actually bundles.
