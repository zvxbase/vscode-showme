# Changelog

## 0.1.3 — preview

- New opt-in `showme.allowOutsideWorkspace` setting (default off): the agent can show, annotate and search files outside the workspace by absolute path. Turning it on is at your own risk — it lets the agent get around the folder restrictions you gave it (contents are never returned, but repeated searches can reveal them), and a malicious instruction in a repository you are reading could put your secret files on screen. Credential locations (`~/.ssh`, `~/.aws`, `~/.config/gh`, browser profiles, shell history and more) and redacted files stay refused even when it is on, and the status bar shows a warning while it is on. `list_workspaces` reports it as `outsideWorkspace`.
- New `showme.blockLinksToRedactedFiles` setting (default `true`): a hard link to a redacted file (such as `.env`) is now treated as redacted too, even under a harmless name, so the agent can't open, search, or read its selection. Ordinary hard links (e.g. pnpm's `node_modules`) still work, except in very large workspaces (over 50,000 entries outside skipped folders), where they're refused and the operations log says so.
- **Behavior change:** `arrange_editors` may now close or move the agent's own tab even while you are currently viewing it. New `showme.layout.protectViewingTab` setting (default `false`) restores the old protection when turned on; your own tabs and unsaved tabs are unaffected either way.
- **Behavior change:** `show_code`, `show_note`, `show_html` and `arrange_editors` now use your column instead of adding a new one when no column is open to the right of yours. `showme.stage.editorGroup` gained a new `"shared"` value and now defaults to it; set it to `"dedicated"` to go back to a column of your own that the agent never uses while it holds any of your tabs.
- Fixed: with `showme.stage.editorGroup: "dedicated"`, a column with none of your tabs (empty, or holding only the agent's tabs) is now reused instead of always opening a new column next to it.
- Fixed: if a tool call brings a different editor to the front, the selection it's showing — including one VS Code restores on its own — is now withheld from `get_editor_state` until you select something yourself.
- `get_editor_state` now withholds the selection (`too-soon-after-tool`) for 1 second after any tool call that can change what's on screen (`annotate`, `arrange_editors`, `show_note`, `show_html`, `show_view`), not only after `show_code`.
- **ShowMe: Show agent configuration** and **ShowMe: Show teardown steps and how to remove the configuration** now open a read-only document with a title. It is not saved anywhere, and closing it no longer asks whether to save.
- The agent configuration document now explains how to set ShowMe up for one repository only (Claude Code scopes, Codex CLI's `.codex/config.toml`, Copilot CLI's `.github/mcp.json` or `.mcp.json`), with the caveats: the snippets contain this machine's install path, repository configuration should be checked before you approve it, and Copilot in VS Code may list ShowMe twice. It ends with an optional prompt you can give your agent to do the setup; you are responsible for what the agent changes. The teardown steps (and the README) now cover these places and scopes too, and the Copilot CLI snippet includes the required `"tools": ["*"]`.
- README: new command table. The Japanese README gives each command's English name next to the Japanese one (VS Code shows the English names when the Japanese language pack is not installed). The command and settings tables are now generated from the extension's declarations, so they no longer drift, and the Japanese README records which version of the English README it was translated from.
- Setting descriptions (shown in the Settings UI and in the README) are rewritten in plain language, and the README now lists every setting, including `showme.enabled` and `showme.html.maxPanels`.

## 0.1.2 — preview

- The agent's editors now open as its own tabs: a read-only mirror of the file that also shows your unsaved edits. They stay the agent's even if you move them or open the same file yourself, so the agent can tidy them up; highlights and annotations appear in the agent's tab, not in your own tab of the same file. The `‹ ›` buttons (and Next / Previous annotation) open the agent's tab, possibly in your column, and the agent may tidy it up once you look away. `showme.stage.agentTabs: false` restores the previous behavior, and `showme.stage.editable` lets you edit and save in the agent's tabs (saving writes the real file).
- The agent's tabs are now marked: the tab name is colored (`showme.agentTabForeground`) and carries an **SM** badge (read-only tabs show a lock icon instead of the badge).
- New **ShowMe: Open the real file** button in the agent's tab title bar: opens the real file at the same line, in the column you're in (next to the agent's tab). `close-own` leaves it open (it belongs to you).
- `show_code` and `annotate` accept `realFile: true` so the agent can put a highlight or a bubble on the real file instead of its own tab, for when you should edit it. `showme.stage.editable` now shows a file you can't write (read-only on disk, or a hard link) as read-only, instead of failing on save.
- Go to Definition and Find References now work across files in the agent's tabs. New `showme.stage.definitionTarget` setting controls whether a definition in another file opens in the real file (default) or in the agent's tab; jumps within the same file always stay in the agent's tab, an imported name shows a small picker instead of jumping straight there, and paths hidden from the agent are never offered as results inside the workspace.
- New `showme.stage.avoidToolColumns` setting: when on, the agent keeps its editors, notes and panels out of a column whose visible tab is a terminal, another extension's panel (such as an AI agent's chat), or another non-file tab such as Settings, using another column instead and refusing when none can be used; `arrange_editors` presets and moves that would use such a column are refused too, regardless of `showme.stage.editorGroup`.
- Fixed: `find_references` returned the declaration too, although by default it should return only the usages (VS Code's reference command always includes the declaration). Pass `includeDeclaration: true` to get it.
- README: uninstall steps in order (your agent's registration first, the extension last), including the Claude Code permission rules.

## 0.1.1 — preview

- README: how to set up and use ShowMe — registering it with your agent, what you will see, the tools, settings, troubleshooting and uninstalling.
- The Japanese developer notes are no longer part of the published repository. Everything a user needs is in the README.

## 0.1.0 — preview

First public release.

- 10 tools: `list_workspaces`, `get_editor_state`, `show_code`, `annotate`, `show_html`, `show_note`, `find_definition`, `find_references`, `show_view`, `arrange_editors`.
- Numbered annotations with Resolve; `‹ ›` navigation from the comment bubble; **ShowMe: Clear highlights / Clear annotations** commands.
- Off by default per window; status bar toggle; works in Restricted Mode.
- English/Japanese UI strings (`vscode.l10n`).
- Verified on Linux. macOS: same code path, not yet verified. Windows named pipes: implemented, not yet verified.
