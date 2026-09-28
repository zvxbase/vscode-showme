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
 * 外部エージェントに貼る設定で、`node` に渡す引数。
 *
 * **拡張を更新しても貼り直さなくてよい形にする。** インストール先は
 * `…/extensions/zvxbase.vscode-showme-0.1.0/bridge/index.js` のように版番号入りのフォルダで、
 * そのまま貼ると次の版に上がった時点で古いフォルダを指す（VS Code は古い版を後で消す）。
 * そこで「同じ拡張フォルダの中で、この拡張のいちばん新しい版のブリッジを起動する」1行を出す。
 *
 * - どこにもファイルを書かない（不変条件11・13）。探す範囲は VS Code が管理する拡張フォルダの、
 *   この拡張の名前で始まり版番号で終わるフォルダだけ
 * - 版は**数値で**比べる（文字列で比べると 0.10.0 より 0.9.0 を選ぶ）
 * - 見つからなければ理由を stderr に書いて exit 1（黙って別物を起動しない）
 * - 開発中（版番号の無い置き場）は、今までどおりパスを直接起動する
 * - `<` を含めない（文書の検査が埋め残しのプレースホルダとみなす記号）
 *
 * VS Code 内蔵のエージェント向けの提供者は、実行中の版のパスをその都度渡すので、これを使わない。
 */
export function bridgeLaunchArgs(bridgePath: string): string[] {
  const m = VERSIONED_BRIDGE.exec(bridgePath);
  if (m === null) return [bridgePath];
  const [, dir = "", prefix = ""] = m;
  return ["-e", newestLauncher(JSON.stringify(slashedWindowsPath(dir)), prefix)];
}

/**
 * Windows のパス（`C:\…`）なら区切りを `/` にする。それ以外はそのまま。
 *
 * 1行はシェルと、シェルから node.exe への引数の受け渡しを通る。Windows ではそこで
 * バックスラッシュが食われうる（Git Bash の `sh -c` を通して node.exe に渡すと `\\` が `\` になり、
 * `C:\Users` が `C:Users` になって拡張フォルダが見つからない。CI の Windows で実測）。
 * Windows の node は `/` 区切りも読むので、1行にバックスラッシュを入れない。
 * POSIX のパスは `\` を名前の文字として持ちうるので変えない（単一引用符の中なら壊れない）。
 */
function slashedWindowsPath(p: string): string {
  return /^[A-Za-z]:[\\/]/.test(p) ? p.replace(/\\/g, "/") : p;
}
/**
 * Windows の `claude mcp add ... -- node <ここ>`（D109）。
 *
 * `-e` の1行はここでは出さない: POSIX の単一引用符は cmd が引用符として扱わず、1行の中の `"` は
 * Windows PowerShell 5.1 が node.exe に渡すときに剥がす。そこで実際のパス（版番号入り）を `/` 区切りにして
 * 二重引用符で包む ―― 二重引用符は cmd と PowerShell の両方で1引数になり、Windows のファイル名は `"` を
 * 持てない。代わりに版が上がると古いフォルダを指すので、文書に「更新したら打ち直す」と書く。
 * 残る穴: パスに `%`（cmd が展開する）や `$`・`` ` ``（PowerShell が展開する）があると壊れる。
 * インストール先の名前に現れることはまず無いので、ここでは扱わない。
 */
function windowsCommandPath(bridgePath: string): string {
  return `"${bridgePath.replace(/\\/g, "/")}"`;
}
const VERSIONED_BRIDGE = /^(.*)[\\/]([^\\/]+-)(\d+\.\d+\.\d+)[\\/]bridge[\\/]index\.js$/;

/**
 * 他の人の機械でも動く形（D99）。拡張フォルダがホームの下なら、`dir` を実行時に
 * `path.join(require("os").homedir(), …相対の部分…)` で求める1行を返す。この機械のホームの綴りは
 * 1文字も入らない（ホームに空白・引用符・非 ASCII があっても壊れない）ので、`${HOME}` の展開に
 * 頼らず、Claude Code・Copilot CLI・Codex のどの設定にもそのまま置ける。
 * ホームの下でなければ、あるいは版番号の無い置き場（開発中）なら `undefined`。
 * 1行の残りは `bridgeLaunchArgs` と同じ関数から作る（不変条件14）。
 */
export function portableLaunchArgs(
  bridgePath: string,
  home: string | undefined,
  platform: NodeJS.Platform,
): string[] | undefined {
  const m = VERSIONED_BRIDGE.exec(bridgePath);
  if (m === null || home === undefined || home === "") return undefined;
  const [, dir = "", prefix = ""] = m;
  const base = home.replace(/[\\/]+$/, "");
  // Windows のパスは大小を区別しない。しかも同じフォルダでも綴りの大小が揃わない
  // （`Uri.fsPath` はドライブ文字を `c:\`、`os.homedir()` は `C:\` で返す）。POSIX は区別する
  const fold = platform === "win32" ? (x: string) => x.toLowerCase() : (x: string) => x;
  const d = fold(dir);
  const b = fold(base);
  if (base === "" || !(d.startsWith(`${b}/`) || d.startsWith(`${b}\\`))) return undefined;
  const segments = dir
    .slice(base.length + 1)
    .split(/[\\/]+/)
    .filter((x) => x !== "");
  const dirExpr = `path.join(require("os").homedir(),${segments.map((x) => JSON.stringify(x)).join(",")})`;
  return ["-e", newestLauncher(dirExpr, prefix)];
}

/** `dir`（JS の式）の中で、`pre` で始まり版番号で終わるいちばん新しいフォルダのブリッジを起動する1行。 */
function newestLauncher(dirExpr: string, prefix: string): string {
  return [
    `const fs=require("fs"),path=require("path"),dir=${dirExpr},pre=${JSON.stringify(prefix)};`,
    `const ver=(n)=>n.slice(pre.length).split(".").map(Number);`,
    // 正規表現と改行もバックスラッシュ無しで書く（`slashedWindowsPath` と同じ理由）
    "const hit=fs.readdirSync(dir).filter((n)=>n.startsWith(pre)&&/^[0-9]+[.][0-9]+[.][0-9]+$/.test(n.slice(pre.length)))",
    ".sort((a,b)=>{const x=ver(a),y=ver(b);return x[0]-y[0]||x[1]-y[1]||x[2]-y[2];}).pop();",
    `if(!hit){process.stderr.write("ShowMe is not installed in "+dir+require("os").EOL);process.exit(1);}`,
    `require(path.join(dir,hit,"bridge","index.js"));`,
  ].join("");
}

/**
 * 文書全体が人間向けなので、言語ごとに丸ごと書き分ける（D58）。`t()` で断片を
 * 継ぐと Markdown の構造まで鍵になる。`lang` は `extension.ts` が
 * `uiLanguage()`（`vscode.env.language`）で選ぶ。**両方の版が同じ事実を書く**
 * （許可リストに `arrange_editors` が無いこと、`npx` が無いことは単体で両方見る）。
 */
export function buildAgentConfigDocument(
  bridgePath: string,
  lang: UiLanguage,
  home: string | undefined,
  platform: NodeJS.Platform,
): string {
  const allowJson = JSON.stringify(agentConfigAllowList(), null, 2);
  // 3つのエージェントの断片は、同じ引数の列から作る（別々に組むとずれる。不変条件14）
  const args = bridgeLaunchArgs(bridgePath);
  const windows = platform === "win32";
  // Claude Code の行だけはシェルを通る。Windows では cmd と PowerShell の両方で壊れない形にする
  // （`windowsCommandPath`）。JSON / TOML はシェルを通らないので、どの機械でも `-e` の1行のまま
  const shellPath = windows ? windowsCommandPath(bridgePath) : args.map(shellQuote).join(" ");
  // JSON 文字列は TOML の基本文字列としてもそのまま通る（`\\` `\"` `\uXXXX`）。
  const quotedPath = args.map((a) => JSON.stringify(a)).join(", ");
  // Copilot CLI の断片はユーザーの mcp-config.json と repo の .mcp.json で同じ1つ。`tools` は
  // ローカルのサーバに必須（D99）
  const copilot = serversJson(args);
  const portableArgs = portableLaunchArgs(bridgePath, home, platform);
  const portable = portableArgs === undefined ? undefined : serversJson(portableArgs);
  const findsNewest = args[0] === "-e";
  const parts = {
    bridgePath,
    shellPath,
    quotedPath,
    allowJson,
    copilot,
    portable,
    findsNewest,
    windows,
  };
  return lang === "ja" ? japanese(parts) : english(parts);
}

/**
 * `mcpServers.showme` の JSON（Copilot CLI の設定と、repo の `.mcp.json`）。組み立てはここ1つ（不変条件14）。
 * `tools` は Copilot CLI のローカルのサーバに必須で、Claude Code は余分な鍵として受け付ける。
 */
function serversJson(args: string[]): string {
  return JSON.stringify(
    { mcpServers: { showme: { type: "stdio", command: "node", args, tools: ["*"] } } },
    null,
    2,
  );
}

interface DocumentParts {
  bridgePath: string;
  /** Claude Code の1行で `node` の後ろに続く引数（シェル用に引用済み） */
  shellPath: string;
  /** Codex の `args = [...]` の中身（TOML の文字列の並び） */
  quotedPath: string;
  allowJson: string;
  copilot: string;
  /** 他の人の機械でも動く形の JSON（portableLaunchArgs）。ホームの下でなければ undefined */
  portable: string | undefined;
  /** 断片が「いちばん新しい版を探して起動する」形か（開発中は直接のパス） */
  findsNewest: boolean;
  /** Windows の文書か（Claude Code の行は `windowsCommandPath`、札は powershell） */
  windows: boolean;
}

/** 冒頭の「断片が何を起動するか」の段落（英語）。Windows では Claude Code の行だけ版に縛られる */
function englishLead(p: DocumentParts): string {
  const cmd =
    "The `claude mcp add` commands work in both PowerShell and Command Prompt. Each names this\nversion's folder, so run it again after the extension updates.";
  if (p.windows && p.findsNewest)
    return `\nThe JSON and TOML snippets below start the newest ShowMe installed next to this one, so you do\nnot need to paste them again after the extension updates. ${cmd}\n`;
  if (p.windows)
    return "\nThe `claude mcp add` commands work in both PowerShell and Command Prompt.\n";
  if (p.findsNewest)
    return "\nThe snippets below start the newest ShowMe installed next to this one, so you do not need to\npaste them again after the extension updates.\n";
  return "";
}

function english(p: DocumentParts): string {
  const fence = p.windows ? "powershell" : "sh";
  return `# ShowMe — agent configuration (read-only; copy from here)

ShowMe never edits other tools' configuration files. This document is read-only:
copy the fragment you need into your agent's configuration.

Bridge: ${p.bridgePath}
${englishLead(p)}
## Claude Code

\`\`\`${fence}
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

\`\`\`${fence}
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

## Scopes: this repository, all repositories, or your team

The snippets contain this machine's install path. It differs between people, operating systems
and environments (local or devcontainer), so a configuration committed to share with others does
not work on their machines as it is.

### Claude Code

\`claude mcp add\` without \`--scope\` uses \`--scope local\`: this repository only, and only for
you (saved in \`~/.claude.json\` under this project's path). The command above is already
repository-only.

All your repositories:

\`\`\`${fence}
claude mcp add --scope user showme -- node ${p.shellPath}
\`\`\`

Shared with your team (writes \`.mcp.json\` at the repository root, meant to be committed. Claude
Code asks each person to approve project servers before using them; \`claude mcp reset-project-choices\`
resets those answers):

\`\`\`${fence}
claude mcp add --scope project showme -- node ${p.shellPath}
\`\`\`

### Codex CLI

Put the same \`[mcp_servers.showme]\` section in \`.codex/config.toml\` in the repository:

\`\`\`toml
[mcp_servers.showme]
command = "node"
args = [${p.quotedPath}]
\`\`\`

Codex reads it only for trusted projects (\`trust_level = "trusted"\` for the project in
\`~/.codex/config.toml\`).

### Copilot CLI

Put the same entry in \`.mcp.json\` at the repository root (or in \`.github/mcp.json\`).
\`"tools": ["*"]\` is required. Copilot CLI reads it only after you confirm that you trust the
folder. One \`.mcp.json\` entry like this works for both Claude Code and Copilot CLI (Claude Code
accepts the extra \`"tools"\` key).

\`\`\`json
${p.copilot}
\`\`\`
${
  p.portable === undefined
    ? ""
    : `
### One entry for everyone on the team

ShowMe is installed under your home folder, so this entry works for anyone who installed it in the
same place under their own home folder: it finds the home folder when it starts, instead of
containing this machine's path. Put it in \`.mcp.json\` at the repository root for Claude Code and
Copilot CLI. The same \`args\` also work in Codex's \`.codex/config.toml\`.

\`\`\`json
${p.portable}
\`\`\`
`
}
### Before you approve

- Check the MCP configuration in someone else's repository before you approve it. A repository's
  configuration can start any command, and ShowMe assumes the repository you are reading may be
  hostile.
- Copilot in VS Code (agent mode) also reads \`.mcp.json\` at the workspace root. ShowMe already
  registers itself with it, so ShowMe can be listed twice there.

## Ask your agent to set it up (optional)

You are responsible for the changes an agent makes. ShowMe does not guarantee the result. Read the
prompt before you use it. Give it to your agent together with this document.

\`\`\`text
Set up the ShowMe MCP server for me, using the ShowMe configuration document I give you.

1. First ask me which agent to configure (Claude Code, Codex CLI or Copilot CLI) and which scope:
   this repository only for me, all my repositories, or shared with my team through a file in
   this repository. Do not choose the shared scope on your own.
2. Use only the snippets and the install path in that document. Do not use npx, and do not
   download anything from the network.
3. Before writing, show me each file you will change and the exact diff, and wait for my approval.
   Do not commit or push.
4. Do not delete or rewrite existing configuration. Only add the ShowMe entry.
5. Do not add mcp__showme__arrange_editors to an allow list, and do not add a wildcard rule that
   allows all tools. (Copilot CLI's "tools": ["*"] is required and only lists the tools.)
6. When you are done, tell me to turn ShowMe on in VS Code (click "ShowMe: Off" in the status bar)
   and to restart you, or to reconnect with /mcp in Claude Code.
\`\`\`
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
    japaneseLead(p),
    p.portable === undefined ? "" : format(agentConfigDocJa.portable.join("\n"), [p.portable]),
    p.windows ? "powershell" : "sh",
  ]);
}

/** 冒頭の段落（日本語）。`englishLead` と同じ4通り */
function japaneseLead(p: DocumentParts): string {
  const ja = agentConfigDocJa;
  if (p.windows && p.findsNewest) return ja.findsNewestWindows.join("\n");
  if (p.windows) return ja.windowsCommand.join("\n");
  if (p.findsNewest) return ja.findsNewest.join("\n");
  return "";
}
