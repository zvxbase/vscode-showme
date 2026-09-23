import { SOCKET_ENV_VAR } from "@zvx/vscode-showme-protocol";
import { type UiLanguage, format } from "./l10n.js";
import * as teardownDocJa from "./teardown-doc.ja.json";

/**
 * 撤去手順の文書に入れる事実。**ここでは計算しない**（不変条件14）。
 *
 * `runtimeDirs` は `extension.ts` がソケットと登録ファイルを置くために既に
 * 計算している候補（`runtimeDirCandidates`）をそのまま受け取る。ここで
 * 計算し直すと、拡張が実際に書いた場所と文書に書く場所がずれうる。
 * 先頭がソケットのある第一候補で、残りは登録ファイルだけの後退先（§2A.6）。
 */
export interface TeardownFacts {
  runtimeDirs: readonly string[];
  extensionId: string;
}

/**
 * `ShowMe: 撤去手順を表示` が開く文書（D62）。**見せるだけ**（不変条件11）。
 *
 * 拡張は `deactivate` で自分のソケットと登録ファイルを消す（不変条件13: 設定以外を
 * ディスクに残さない）ので、削除ボタンは要らない。人間が消すのは、拡張の外にある
 * 3つ ―― エージェント側の設定、拡張そのもの、既に開いている端末の環境変数。
 *
 * `rm -rf` のような破壊的なコマンドは**書かない**。消す対象は拡張が自分で消すか、
 * 人間の設定ファイルの中の1節であって、ディレクトリごと消す場面が無い。
 *
 * このファイルは vscode に依存しない。文書の中身を単体で検査するため。
 * 文書全体が人間向けなので言語ごとに丸ごと書き分け、日本語版は `lang: "ja"` の
 * 分岐にそのまま残す（D58）。`lang` は `extension.ts` が `uiLanguage()` で選ぶ。
 */
export function buildTeardownDocument(facts: TeardownFacts, lang: UiLanguage): string {
  const dirs = facts.runtimeDirs.map((d) => `- \`${d}\``).join("\n");
  return lang === "ja" ? japanese(facts, dirs) : english(facts, dirs);
}

function english(facts: TeardownFacts, dirs: string): string {
  return `# ShowMe — teardown (display only; there is no need to save this file)

ShowMe never edits other tools' configuration files and persists nothing but its
settings. So teardown splits in two: what the extension removes by itself, and
what you added and therefore remove yourself.

## 1. What the extension removes by itself (nothing to do)

When you disable or uninstall the extension (deactivate), the extension itself removes:

- The socket and the registration files. Runtime directories:
${dirs}
- The \`${SOCKET_ENV_VAR}\` injection into newly opened terminals (what it injected into VS Code's terminals)

Anything left behind is cleaned up the next time this extension starts (stale registration files).

## 2. What you remove (things outside the extension)

### 2a. Your agent's configuration

Remove the fragment you copied via \`ShowMe: Show agent configuration\` from wherever you put it:

- Claude Code:

\`\`\`sh
claude mcp remove showme
\`\`\`

  Also remove the \`mcp__showme__*\` lines you added to \`permissions.allow\` in \`.claude/settings.json\`.
- Codex CLI: delete the \`[mcp_servers.showme]\` section in \`~/.codex/config.toml\`
- Copilot CLI: delete the \`"showme"\` entry in \`~/.copilot/mcp-config.json\`

### 2b. The extension itself

\`\`\`sh
code --uninstall-extension ${facts.extensionId}
\`\`\`

If you wrote any \`showme.\` settings into your VS Code user settings, remove them by hand
(the extension never deletes settings on its own).

### 2c. Environment variables in terminals that are already open

\`${SOCKET_ENV_VAR}\` stays in the environment of terminals opened after it was injected. The
extension cannot change the environment of a terminal that is already open, so reopen the
terminal (or \`unset ${SOCKET_ENV_VAR}\`).
`;
}

function japanese(facts: TeardownFacts, dirs: string): string {
  // 日本語版の本文は隣の JSON にある（`.ts` に日本語の文字列リテラルを置かない。D58）。
  return format(teardownDocJa.lines.join("\n"), [dirs, SOCKET_ENV_VAR, facts.extensionId]);
}
