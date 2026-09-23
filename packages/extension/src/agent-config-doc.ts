import { TOOL_ANNOTATIONS, TOOL_NAMES } from "@zvx/vscode-showme-protocol";
import * as agentConfigDocJa from "./agent-config-doc.ja.json";
import { type UiLanguage, format } from "./l10n.js";

/**
 * `ShowMe: エージェント設定を表示` が開く文書（D62 / 設計書 §7.2）。
 *
 * **見せるだけ。書かない**（不変条件11）。人間が自分のエージェントの設定に写す。
 * ブリッジのパスは実際のインストール先を入れる ―― プレースホルダを残すと、
 * 人間がそこを埋める作業をし、埋め方を間違える。
 *
 * **`npx` を出さない**（S12 / D26）。`@zvx` スコープは npm 未登録で、`npx -y` は
 * 確認なしにダウンロードして実行する。第三者がスコープを取った時点で、断片を
 * コピーした人のマシンで任意コードが走る。
 *
 * このファイルは vscode に依存しない。文書の中身を単体で検査するため。
 * 日本語版は `lang: "ja"` の分岐にそのまま残す（文書全体が人間向け。D58）。
 */

/**
 * Claude Code の許可リストに載せるツール名（線上の綴り `mcp__showme__<tool>`）。
 *
 * **`destructiveHint: true` のツールは入れない**（B6）。今それは `arrange_editors`
 * だけで、人間が設定を立てた窓では人間のタブが実際に閉じる。一括の許可に混ぜると
 * 「入れた覚えの無い破壊的ツールが承認済み」になる。欲しい人が自分で1行足す。
 *
 * 名前を並べて書かず、注釈から引く ―― 名前で抜くと、別のツールが破壊的になった
 * とき（あるいは `arrange_editors` が破壊的でなくなったとき）に黙ってずれる。
 * 「どれが破壊的か」を決めているのは `TOOL_ANNOTATIONS` の1箇所である（不変条件14）。
 */
export function agentConfigAllowList(): string[] {
  return TOOL_NAMES.filter((t) => TOOL_ANNOTATIONS[t].destructiveHint !== true).map(
    (t) => `mcp__showme__${t}`,
  );
}

/**
 * 文書の中の許可リストを**値として**取り出す。無ければ `undefined`。
 *
 * 検査が「名前の部分一致」で通らないようにするための口。本文には
 * 「`"mcp__showme__arrange_editors"` を自分で足す」と書くので、文書全体に対する
 * `not.toContain` は永久に赤（あるいは説明を消して緑）になる。許可リストの
 * **ブロック**に無いことを主張する。
 */
export function allowListInDocument(doc: string): string[] | undefined {
  const m = ALLOW_BLOCK.exec(doc);
  if (m === null) return undefined;
  const parsed: unknown = JSON.parse(m[1] ?? "");
  if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === "string")) return undefined;
  return parsed as string[];
}
const ALLOW_BLOCK = /```json\n(\[[\s\S]*?\n\])\n```/;

/**
 * シェルの1引数として安全な綴りにする。
 *
 * インストール先は人間が選ぶので、空白（macOS の `Application Support`）や
 * 引用符を含みうる。安全な文字だけならそのまま（見た目が普通の行になる）、
 * それ以外は POSIX の単一引用符で包む。
 */
export function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_\-./:@+=,]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * 文書全体が人間向けなので、言語ごとに丸ごと書き分ける（D58）。`t()` で断片を
 * 継ぐと Markdown の構造まで鍵になる。`lang` は `extension.ts` が
 * `uiLanguage()`（`vscode.env.language`）で選ぶ。**両方の版が同じ事実を書く**
 * （許可リストに `arrange_editors` が無いこと、`npx` が無いことは単体で両方見る）。
 */
export function buildAgentConfigDocument(bridgePath: string, lang: UiLanguage): string {
  const allowJson = JSON.stringify(agentConfigAllowList(), null, 2);
  const shellPath = shellQuote(bridgePath);
  // JSON 文字列は TOML の基本文字列としてもそのまま通る（`\\` `\"` `\uXXXX`）。
  const quotedPath = JSON.stringify(bridgePath);
  const copilot = JSON.stringify(
    { mcpServers: { showme: { type: "stdio", command: "node", args: [bridgePath] } } },
    null,
    2,
  );
  const parts = { bridgePath, shellPath, quotedPath, allowJson, copilot };
  return lang === "ja" ? japanese(parts) : english(parts);
}

interface DocumentParts {
  bridgePath: string;
  shellPath: string;
  quotedPath: string;
  allowJson: string;
  copilot: string;
}

function english(p: DocumentParts): string {
  return `# ShowMe — agent configuration (copy from here; there is no need to save this file)

ShowMe never edits other tools' configuration files. This document is untitled:
copy the fragment you need into your agent's configuration.

Bridge: ${p.bridgePath}

## Claude Code

\`\`\`sh
claude mcp add showme -- node ${p.shellPath}
\`\`\`

Permission rules (add to \`permissions.allow\` in \`.claude/settings.json\`.
Without them, even the display-only tools ask for confirmation on every call):

\`\`\`json
${p.allowJson}
\`\`\`

\`arrange_editors\` is left out on purpose. It is the only destructive tool (it can
close your tabs), so it does not belong in a blanket allow list. If you want it,
add the one line \`"mcp__showme__arrange_editors"\` yourself.

Removal:

\`\`\`sh
claude mcp remove showme
\`\`\`

## Codex CLI (\`~/.codex/config.toml\`)

\`\`\`toml
[mcp_servers.showme]
command = "node"
args = [${p.quotedPath}]
\`\`\`

Removal: delete the \`[mcp_servers.showme]\` section above.

## Copilot CLI (\`~/.copilot/mcp-config.json\`)

\`\`\`json
${p.copilot}
\`\`\`

Permission: \`--allow-tool 'showme'\`

Removal: delete the \`"showme"\` entry.

## Agents built into VS Code

The extension registers an MCP server definition provider (\`showme\`), so no
configuration is needed (it does not work in Restricted Mode).
`;
}

function japanese(p: DocumentParts): string {
  // 日本語版の本文は隣の JSON にある（`.ts` に日本語の文字列リテラルを置かない。D58）。
  return format(agentConfigDocJa.lines.join("\n"), [
    p.bridgePath,
    p.shellPath,
    p.allowJson,
    p.quotedPath,
    p.copilot,
  ]);
}
