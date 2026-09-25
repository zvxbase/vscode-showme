# Changelog

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
