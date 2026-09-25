/**
 * MCP のツール注釈。
 *
 * 注意（設計書 §4.3 / A6）: 3クライアントを調べた結果、注釈で承認が変わるのは
 * Codex CLI だけで、Claude Code と Copilot CLI は注釈を承認判断に使わない。
 * idempotentHint はどのクライアントにも消費者が見つからなかった。
 * それでも正直に付ける（文書としての価値がある）が、体験の滑らかさは
 * 許可ルールの断片（拡張のコマンドが出す）で担保する。
 */
export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/**
 * 提供するツールの名前。**増分の番号を型に焼き込まない。**
 *
 * 以前は `INCREMENT_1_TOOLS` という名前だった。増分2でツールを足した時点で
 * 「増分1のツール」という名前は嘘になり、しかも嘘のまま動く ―― 名前が古びても
 * コンパイラは何も言わないので、次に読む人が「これは増分1の分だけを回して
 * いるのだろう」と誤読する側にだけ倒れる。
 */
export const TOOL_NAMES = [
  "list_workspaces",
  "show_code",
  "get_editor_state",
  "annotate",
  "show_html",
  "show_note",
  "find_definition",
  "find_references",
  "show_view",
  "arrange_editors",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export const TOOL_ANNOTATIONS: Record<ToolName, ToolAnnotations> = {
  // 何も変えない。3クライアント横断で実効がある唯一の注釈がこれ。
  list_workspaces: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  // エディタの表示を変えるので readOnly ではない。嘘をつかない。
  // ワークスペースは変えないので destructive でもない。
  show_code: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  // 人間の画面を読むだけで、何も変えない。
  get_editor_state: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  // 人間の画面に吹き出しを出すので readOnly ではない。ワークスペースは変えない。
  //
  // **idempotentHint は false である。** 既定の `mode: "replace"` は冪等だが、
  // 注釈は `mode: "add"` も取れて、そちらは同じ引数で呼ぶたびに増える。注釈は
  // ツール全体に付くもので引数ごとには付かないので、「同じ引数で呼び直しても
  // 追加の効果は無い」が全ての呼び方で真でない以上、true とは書けない。
  // 冪等なのは既定の側だけである、という事実は説明文のほうに書く。
  annotate: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  // パネルを1枚使い回して中身を差し替えるので、同じ引数で呼び直しても増えない。
  //
  // **`openWorldHint` は false である。** 図もメモも外に出ない ―― webview の CSP は
  // `default-src 'none'` で、表示面にはスクリプトが無い。ここを true にすると
  // 「外部と話す道具」だと読まれ、承認の判断が実態より重くなる。
  show_html: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  // **`idempotentHint` は false。** 人間がメモを触っていたら新しいドキュメントを
  // 開く（上書きしない）ので、同じ引数で呼び直したときに増えることがある。
  show_note: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  // **何も変えない。** 言語サーバに聞くだけで、画面も舞台も動かさない。
  find_definition: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  find_references: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  // 画面の見え方を変えるので readOnly ではない。ワークスペースは変えない。
  //
  // **`idempotentHint` は false である。** 増分4 で `toggle-*` を7つ足したので、
  // 「繰り返しても結果は同じ」は語彙の一部にしか当たらなくなった
  // （`show-*` と `hide-*` は冪等、`toggle-*` は呼ぶたびに反転する）。
  // 一部にしか当たらない性質を true と宣言すると、それは嘘である ――
  // 語彙を足したときに宣言を見直さなかった、という形の古さになる。
  show_view: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  // **`destructiveHint` は true。** この道具だけが人間のタブを閉じうる。
  // 既定（`closeHumanTabs` / `closeDirtyTabs` がどちらも false）では自分が
  // 出したパネルしか閉じないが、**注釈は「何ができるか」を書くもの**であって
  // 「既定で何が起きるか」ではない。既定が安全だからと false にすると、
  // 設定を立てた人間の画面での実態を隠すことになる ―― 承認の判断に注釈を使う
  // クライアント（Codex CLI）では、そこが唯一の手がかりである。
  //
  // **`idempotentHint` は true。** 11語はすべて「こうなっていてほしい終状態」を
  // 名指していて、反転する語が無い（レイアウトの5語は絶対的な配置を指定し、
  // `close-own` / `close-other-tabs` / `close-tabs` は2回目に閉じるものが残っておらず、
  // `move-tab` / `move-panel` / `gather-own` は「その列に居る」という終状態を指す）。
  // `show_view` が false なのは `toggle-*` を7つ持つからで、こちらには無い
  // ―― その差は `arrange-action.test.ts` と `tools.test.ts` が語彙の側から
  // 検査している。**反転する語を足すなら、先にここを直すこと。**
  arrange_editors: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
};

export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  list_workspaces:
    "Returns information about the VS Code window this connection is bound to. Does not return file contents. " +
    "capabilities.symbolResolution is **deliberately conservative**: it is false when the window is in " +
    "Restricted Mode (isTrusted: false), but the only language providers actually disabled in Restricted Mode " +
    "are the TypeScript/JavaScript family; symbols in JSON and the like still resolve. " +
    "Even when it is false, a symbol lookup is worth trying; if it fails, reason tells you whether it was " +
    "restricted-mode or no-provider. " +
    "Also returns the settings that constrain your own actions: permissions tells you whether arrange_editors " +
    "may reach the human's tabs (closeHumanTabs) and unsaved tabs (closeDirtyTabs). " +
    "features tells you which of the three switchable features the human has left on: " +
    "stage (opening files and tabs, scrolling, splitting; when off, show_code only marks lines without " +
    "opening or scrolling, and show_note is refused), " +
    "html (when off, show_html is refused) and " +
    "layout (when off, arrange_editors and show_view are refused). " +
    "disabledTools is derived from features and lists the tools that are refused with disabled when called; " +
    "annotate, show_code and the reading tools are never in it. " +
    "If editorGroup is active, show_code opens in the human's column (dedicated means a column of its own). " +
    "If avoidToolColumns is true, show_code / show_note / show_html do not open in columns showing a terminal or " +
    "another extension's panel, and are refused with no-stage-column when no other column can be used. " +
    'panels.max is how many show_html panels the human allows (a number, or "unlimited"). ' +
    "Call this first to learn what you can do; being refused should be the last resort for finding out.",
  show_code:
    "Opens a file on the human's screen, scrolls to the given location and highlights it. " +
    "The location is given by one of text (a literal string, recommended) / symbol / lines. " +
    "Regular expressions are not accepted. File contents are not returned; if you need the contents, use your own read tool. " +
    "When there are multiple matches, up to 3 candidates are returned; pick one with occurrence. " +
    'Passing layout: "split" places the locations side by side in at most 2 columns (the default "single" stacks them as tabs in one column). ' +
    "By default the file opens as your own tab (read-only under the default settings), which you can close with arrange_editors close-own. " +
    "Passing realFile: true opens the real file instead so the human can edit it; close-own leaves it open " +
    "(it belongs to the human), so use it only when the human should edit the file. " +
    "If the human has turned off showme.stage.enabled, the file is not opened or scrolled: the location is resolved " +
    "and marked, and the highlight appears when the human opens the file (list_workspaces.features.stage tells you). " +
    "If the human has turned on showme.stage.avoidToolColumns, columns showing a terminal or another extension's panel " +
    "are skipped; when no column can be used, the location is returned without a range and with reason no-stage-column.",
  get_editor_state:
    "Returns where the human is currently looking and the screen layout: the workspace-relative path of " +
    "the active file, cursor position, selection range, the lines visible on screen, " +
    "and the paths of open tabs (openPaths). " +
    "groups lists the tabs of each column: label, kind (file / diff / webview / terminal / " +
    "notebook / notebook-diff / other), relative path, active, dirty, pinned, " +
    "preview, and visible lines. Panels that ShowMe itself opened carry own, so you " +
    "know which ones you may clean up. " +
    "Redacted paths (.env etc.) are listed as tabs too, but their visible lines, cursor and selection are not returned. " +
    "File names outside the workspace, terminal titles, and the titles of other tools' panels are not returned; " +
    "they are replaced by a fixed string naming only the kind ((outside workspace) / (terminal) / (other)). " +
    "Selected text is returned only when it can be established that the human really selected it. " +
    "When it is not returned, selectionWithheld carries the reason, so you can tell " +
    '"there is no selection" from "it was not shared". ' +
    "annotations lists the agent's own bubbles in reading order: id, index, path, line, color, " +
    "and resolved (true when the human has marked it resolved). Bodies are not returned; " +
    "the key is omitted when there are no annotations. " +
    "File contents are not returned (selected text is the one exception, and it is truncated to a bounded length).",
  annotate:
    "Shows an explanatory speech bubble (comment thread) below the given line on the human's screen. " +
    "The text is a **plain string** and is not interpreted as markdown " +
    "(no links, images or bold: by design there is no channel of any kind that could send data out). " +
    "The location is specified the same way as in show_code (text / symbol / lines), but without color: " +
    "each item's own color (optional) is shown in the bubble's author name and painted on the line " +
    "(omit it for the unmarked `ShowMe`, which is painted grey), " +
    "and that paint lives exactly as long as the annotation (highlights from show_code are a separate, " +
    "short-lived layer replaced by the next show_code). " +
    'mode: "replace" (the default) replaces all annotations in this window, ' +
    "so calling again with the same arguments does not add bubbles. " +
    'mode: "add" appends to the existing annotations (each call adds more). ' +
    'mode: "clear" removes all annotations in this window (do not pass items; the result is resolutions: []). ' +
    "Bubbles go on your own tab by default; after show_code with realFile: true, pass realFile: true here too " +
    "so they appear on the real file the human is looking at. " +
    "Each resolved item gets an id (stable for this window) and an index (1-based reading order = the order of items; " +
    "the author name shows 3/7 · when there are 2 or more annotations). " +
    'mode: "add" continues the numbering and renumbers existing bubbles\' denominators. ' +
    "File contents are not returned; only the resolved locations and how they were resolved.",
  show_html:
    "Displays HTML on the human's screen (tables, diagrams, annotated explanations, and so on). " +
    '**Scripts do not run**: the display surface is an iframe with sandbox="", and ' +
    "script / link / meta / iframe / form / on* attributes, as well as src/href with any scheme other than data:, are dropped. " +
    "Tables, headings, pre, code, basic SVG shapes, data: images and style such as colors pass through. " +
    "One panel per slot is reused, so calling repeatedly does not multiply windows. " +
    "Pass slot: 2 to show a second panel (e.g. the previous diagram next to the current one). " +
    "How many panels exist is the human's setting showme.html.maxPanels (default 2; list_workspaces.panels.max tells you); " +
    "a slot above the limit is refused with invalid-request naming the limit. " +
    "Nothing ever goes out to the network (external images and fonts cannot be loaded). " +
    "If the human has turned on showme.stage.avoidToolColumns and no column can be used for a new panel, " +
    "the call is refused with no-stage-column. " +
    "Instead of html you can pass path (a workspace-relative HTML file); the extension reads and renders the file and " +
    "**re-renders it every time that file is saved**. Use path when growing a diagram: to change it, " +
    "just edit the file (no need to resend the whole text or call again, so you can grow a diagram without spending tokens). " +
    "File contents are not returned.",
  show_note:
    "Opens an untitled editor and writes a note (the human decides where to save it; nothing is written to disk unprompted). " +
    "If the human has edited the note that is already open, it is **not overwritten: a new document is opened instead**, " +
    "so nothing the human added is ever lost. " +
    "reusedDocument: false means a new document was opened. " +
    "If the human has turned on showme.stage.avoidToolColumns (columns showing a terminal or another extension's panel " +
    "are skipped) and no column can be used, the call is refused with no-stage-column.",
  find_definition:
    "Returns **where the symbol at the given location is defined**. " +
    'Same answer as VS Code\'s "Go to Definition", and **unlike grep it does not confuse different things with the same name**. ' +
    "Only locations (path, line, column) are returned, never file contents. " +
    "To show the human a location you found, pass it to show_code. " +
    "In Restricted Mode this is unavailable for some languages (reason is restricted-mode). " +
    "When no language extension is present, reason is no-provider; waiting will not help, so search with text instead.",
  find_references:
    "Returns **where the symbol at the given location is used**. " +
    "Only locations are returned, never file contents. " +
    "Counts are not returned: match is one of the three values none / one / many, and locations is bounded " +
    '(many means "possibly more than the bound"; the exact number is unknown). ' +
    "Locations inside redacted paths (.env etc.) are not returned. " +
    "Set includeDeclaration to true to include the declaration itself (by default only the usages).",
  show_view:
    "Changes how the human's screen looks (reveal a file's location in the explorer, " +
    "switch the sidebar view, open or close the bottom panel, enter Zen mode). " +
    "**Only operations from a closed vocabulary**; arbitrary VS Code commands cannot be run. " +
    "action: reveal-in-explorer (requires path) / show-explorer / show-search / show-scm / " +
    "show-debug / show-extensions / hide-sidebar / toggle-sidebar / show-panel / hide-panel / " +
    "toggle-panel / toggle-maximized-panel / show-problems / show-output / show-comments / " +
    "toggle-auxiliary-bar / toggle-zen-mode / toggle-activity-bar / toggle-status-bar. " +
    "There is no operation to create or kill terminals. " +
    "**Operations starting with toggle- flip the state on every call** (show- / hide- are idempotent), " +
    "and the current state is not observable (VS Code exposes no API for sidebar/panel visibility); " +
    "when the intent is known, prefer show-*/hide-*. " +
    "The screen state is not returned (only whether done is true or false).",
  arrange_editors:
    "Arranges the editors on the human's screen (rearranges columns, tidies up). " +
    "**Only operations from a closed vocabulary**; arbitrary VS Code commands cannot be run. " +
    "action: close-own / two-columns / three-columns / two-rows / grid / even-widths / " +
    "close-other-tabs / close-tabs / move-tab / move-panel / gather-own. " +
    "close-own closes the panels ShowMe itself opened and the files **it opened via show_code** " +
    "(the tabs with own: true in get_editor_state). " +
    "close-tabs closes exactly the listed tabs (by path), subject to the same rules as close-own: " +
    "the tab the human is viewing and unsaved tabs are never closed; the human's tabs need closeHumanTabs. " +
    "notOpen lists paths that had no open tab. Tabs without a path (terminals, panels) cannot be listed. " +
    'Use close-own for "tidy up" and close-tabs when the human names the tabs to close. ' +
    "**The tab the human is viewing and unsaved tabs are never closed, under any setting** " +
    "(withheld: [viewing-tab] / [dirty-tabs-not-allowed]; asking for a setting change does not alter viewing-tab). " +
    "**Operations that reduce the number of columns are refused if the human's column would be caught up in it** " +
    "(done: false with withheld: [human-column-would-merge]. VS Code's presets only create frames; " +
    "surplus groups are merged into the last frame and cannot be restored). Merging column 3 into column 2 while the human is in column 1 is allowed. " +
    "even-widths never reduces columns, so it always passes. " +
    "**Tabs and panels can be moved**: move-tab takes path and toColumn (the workspace-relative path of the tab to move, and " +
    "the destination column, 1-based, up to the current column count + 1); move-panel takes toColumn and slot (the slot of the panel to move; default 1). " +
    "**Tabs are addressed by path. They cannot be addressed by title (label).** " +
    "By default only your own tabs (own: true) and panels move; moving the human's tabs requires closeHumanTabs. " +
    "**Moving into the column the human is in is refused by default** (withheld: [human-column-target]; allowed with closeHumanTabs). " +
    "gather-own collects your own tabs and panels into the first stage column (the lowest column to the right of the human's; if there is none, a new column to its right). " +
    "The human's column is not touched. " +
    "With showme.stage.avoidToolColumns on, gather-own skips columns showing a terminal or another extension's panel, " +
    "the same way show_code does, and is refused (withheld: [no-stage-column]) when no column can be used; " +
    "presets that would merge such a column are refused (withheld: [tool-column-would-merge]) " +
    "and moving into one is refused (withheld: [tool-column-target]). " +
    'The resulting layout is not returned: done: true means "the operation ran", not "it landed in the intended column" ' +
    "(VS Code may reuse a column where the same document is already open). **Re-read with get_editor_state after calling.** " +
    "**By default only your own things are closed**: " +
    "calling close-other-tabs closes none of the human's text tabs, " +
    "and returns closed: 0 with withheld: [human-tabs-not-allowed]. " +
    "**This is not a malfunction**; calling again will not change the result. " +
    "The human's tabs can be closed only when the setting showme.layout.closeHumanTabs is true, " +
    "and unsaved tabs additionally only when showme.layout.closeDirtyTabs is true " +
    "(both default to false; only the human can change them). " +
    "Returned are only done, the number actually closed (closed), the number moved (moved), and the reasons refused (withheld). " +
    "The number not closed and the names of tabs are not returned (see the open tabs with " +
    "get_editor_state).",
};
