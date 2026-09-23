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

## Install

1. Install the extension from the VS Code Marketplace or Open VSX (`zvxbase.vscode-showme`), or download the VSIX from Releases.
2. Click `ShowMe: Off` in the status bar of the window you want the agent to drive → it becomes `ShowMe: On`.
3. Run **ShowMe: Show agent configuration** from the Command Palette and paste the snippet for your agent (Claude Code / Copilot CLI / Codex CLI). The bridge is bundled with the extension — nothing to install from npm.

Ten tools: `list_workspaces`, `get_editor_state`, `show_code`, `annotate`, `show_html`, `show_note`,
`find_definition`, `find_references`, `show_view`, `arrange_editors`. Details and the list of
things that do not work yet: [`docs/runbook.md`](docs/runbook.md) (Japanese).

## Status

`0.1.0` — **preview**. Verified on Linux (unit + integration tests in a real VS Code). macOS uses the same Unix-socket path but has not been verified yet; Windows named-pipe support is written but not yet verified. CI runs both as non-blocking observations. This is a personal project without an SLA; issues and PRs are welcome and are answered by the maintainer when time allows. Development happens in a private repository and each release is published here as one commit — see `CONTRIBUTING.md`.

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
