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
 * ブリッジを Node として動かすための環境変数（D112）。
 *
 * エディタの実行ファイル（デスクトップでは Electron）は、これが無いと Node ではなく VS Code として
 * 立ち上がる。拡張ホストは自分にこれを立てていて子にも継がれるが、継承に頼らず定義に明示する
 * （意図を書き残し、拡張ホストの将来の変更に耐える）。リモートの実行ファイルは素の node で、
 * そこでは何もしない。
 */
export const RUN_AS_NODE_ENV: Readonly<Record<string, string>> = Object.freeze({
  ELECTRON_RUN_AS_NODE: "1",
});

/** ブリッジを起動する形。 */
export interface LaunchForm {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * **ブリッジを起動する形を決める唯一の関数**（D112 / D114。不変条件14）。
 *
 * `runtime` はエディタの実行環境（拡張ホストの `process.execPath`。デスクトップでは VS Code の
 * 実行ファイル、リモートでは VS Code Server に同梱の node）。`PATH` の `node` を前提にしない ――
 * Node が無い・VS Code を起動した後で入れた・fnm / nvm でシェルの設定にしか無い、のどれでも
 * `spawn node ENOENT` になっていた。VS Code 内蔵のエージェント向けの定義（`builtInServerDefinition`）も
 * 外のエージェントの断片（`buildAgentConfigDocument`）も、これを通す。
 */
export function editorRuntimeLaunch(runtime: string, args: readonly string[]): LaunchForm {
  return { command: runtime, args: [...args], env: { ...RUN_AS_NODE_ENV } };
}

/** VS Code 内蔵のエージェント向けの MCP サーバ定義の中身（`McpStdioServerDefinition` の引数）。 */
export interface BuiltInServerDefinition extends LaunchForm {
  label: string;
  version: string;
}

/**
 * VS Code 内蔵のエージェント向けの定義（D112）。
 *
 * ブリッジは**今動いている版のパス**を直接起動する（拡張ホストが毎回渡すので、いちばん新しい版を
 * 探す1行は要らない）。`version` は拡張の版 ―― 更新したらツールの一覧が Outdated になり、
 * 次のチャットで取り直される（付けないと古い一覧が最新のまま残る）。
 */
export function builtInServerDefinition(
  runtime: string,
  bridgePath: string,
  version: string,
): BuiltInServerDefinition {
  return { label: "ShowMe", ...editorRuntimeLaunch(runtime, [bridgePath]), version };
}

/** 断片に入れる実行環境（`extension.ts` が拡張ホストから取る）。 */
export interface EditorRuntime {
  /** 拡張ホストの `process.execPath` */
  executable: string;
  /** リモート（WSL / SSH / dev container）か。`vscode.env.remoteName` が定義されているとき真 */
  remote: boolean;
  /** 拡張ホストの環境変数のうち、入れ方を見分けるもの（Flatpak / AppImage / Snap） */
  env?: {
    FLATPAK_ID?: string | undefined;
    APPIMAGE?: string | undefined;
    SNAP?: string | undefined;
  };
}

/**
 * 断片に書く実行ファイルが、なぜ長持ちしないか。
 *
 * - `remote`: VS Code Server の実行ファイル。パスに版のハッシュが入り、VS Code を更新するたびに変わる
 * - `flatpak`: 砂箱の中（`/app/…`）。外で動くエージェントからは起動できない
 * - `appimage`: 起動のたびに `/tmp/.mount_…` の別の場所に展開される
 * - `app-translocation`: macOS が隔離のために起動のたびに乱数の場所から動かしている
 * - `nix-store`: Nix のストア（`/nix/store/<ハッシュ>-…`）。更新のたびに別のパスになり、古いものは
 *   ガベージコレクションで消える
 */
export type VolatileRuntime = "remote" | "flatpak" | "appimage" | "app-translocation" | "nix-store";

/**
 * 断片の起動の形。`runtime` はエディタの実行環境（Node.js は要らない。`editorRuntimeLaunch`）、
 * `node` は `PATH` の `node`（Node.js 20 以上が要るが、VS Code の場所に依らない。`nodeLaunch`）。
 */
export type SnippetForm = "runtime" | "node";

/** 断片に書く実行ファイル。`executable` が undefined なら、外からは起動できない（node で起動する）。 */
export interface SnippetRuntime {
  executable: string | undefined;
  volatile: VolatileRuntime | undefined;
  /**
   * 断片に出す形と、その順（先に出すほうを勧める）。安定なら実行環境が先、長持ちしない場所なら
   * `node` が先、外から起動できない（Flatpak）なら `node` だけ。3つのエージェントの節・スコープの節・
   * 冒頭の説明の順は、すべてこれに従う（不変条件14）
   */
  forms: readonly SnippetForm[];
}

/**
 * **断片に書く実行ファイルを決める唯一の関数**（D114。不変条件14）。
 *
 * 「デスクトップの実行ファイルは更新で動かない」は入れ方によっては偽である:
 * - Snap: `process.execPath` は版ごとのフォルダ（`/snap/code/187/…`）で、snap は古い版を2つまでしか
 *   残さない。更新を重ねると貼った断片が消えたフォルダを指す。`/snap/<名前>/current/`（常にある
 *   シンボリックリンク）に直せば長持ちする
 * - Flatpak: 実行ファイルは砂箱の中にあり、外のエージェントは起動できない（`FLATPAK_ID`、`/app/`）
 * - AppImage（`APPIMAGE`、`/tmp/.mount_`）と macOS の App Translocation（`/AppTranslocation/`）:
 *   起動のたびに場所が変わる
 * - Nix（`/nix/store/…`）: 更新のたびに別のパスになり、古いものはガベージコレクションで消える
 *
 * 見分けられないもの（既知の限界）: Arch などの、システムの Electron で動かす VS Code（`/usr/lib/electron…/electron`）。
 * 実行ファイルは Electron の更新で場所が変わりうるが、ここでは安定として扱う
 */
export function snippetRuntime(runtime: EditorRuntime): SnippetRuntime {
  const { executable, volatile } = classifyRuntime(runtime);
  const forms: readonly SnippetForm[] =
    executable === undefined
      ? ["node"]
      : volatile === undefined
        ? ["runtime", "node"]
        : ["node", "runtime"];
  return { executable, volatile, forms };
}

function classifyRuntime(runtime: EditorRuntime): Omit<SnippetRuntime, "forms"> {
  const p = runtime.executable;
  const env = runtime.env ?? {};
  if (runtime.remote) return { executable: p, volatile: "remote" };
  if (nonEmpty(env.FLATPAK_ID) || p.startsWith("/app/")) {
    return { executable: undefined, volatile: "flatpak" };
  }
  if (nonEmpty(env.APPIMAGE) || p.startsWith("/tmp/.mount_")) {
    return { executable: p, volatile: "appimage" };
  }
  if (p.includes("/AppTranslocation/")) return { executable: p, volatile: "app-translocation" };
  if (p.startsWith("/nix/store/")) return { executable: p, volatile: "nix-store" };
  const snap = SNAP_REVISION.exec(p);
  if (snap !== null) {
    return {
      executable: `/snap/${snap[1]}/current/${p.slice(snap[0].length)}`,
      volatile: undefined,
    };
  }
  return { executable: p, volatile: undefined };
}
/** `/snap/<名前>/<版>/`。版は数字、手元で入れたものは `x` と数字 */
const SNAP_REVISION = /^\/snap\/([^/]+)\/x?\d+\//;
const nonEmpty = (v: string | undefined): boolean => v !== undefined && v !== "";

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
  runtime: EditorRuntime,
): string {
  const allowJson = JSON.stringify(agentConfigAllowList(), null, 2);
  // 3つのエージェントの断片は、同じ起動の形から作る（別々に組むとずれる。不変条件14）。
  // 実行環境の形は内蔵の定義（builtInServerDefinition）と同じ `editorRuntimeLaunch` を通す
  const args = bridgeLaunchArgs(bridgePath);
  const where = snippetRuntime(runtime);
  const windows = platform === "win32";
  // 出す形と順は `snippetRuntime` の forms だけが決める（Flatpak は node だけ）
  const snippets = where.forms.flatMap((kind): FormSnippet[] => {
    if (kind === "node") return [formSnippet(kind, nodeLaunch(args), bridgePath, windows)];
    if (where.executable === undefined) return [];
    return [formSnippet(kind, editorRuntimeLaunch(where.executable, args), bridgePath, windows)];
  });
  // 他の人の機械でも動く形（D99）は `node` で起動する。エディタの実行ファイルの場所は OS と
  // インストールの仕方で人ごとに違い（macOS は /Applications、Linux は /usr/share/code、Windows は
  // ホームの下または Program Files）、実行時に求める手が無い。`${HOME}` の置き換えは使わない
  // （展開するかどうか・どの綴りを展開するかがエージェントごとに違い、実行ファイルの位置も
  // ホームの下とは限らない）
  const portableArgs = portableLaunchArgs(bridgePath, home, platform);
  const portable = portableArgs === undefined ? undefined : serversJson(nodeLaunch(portableArgs));
  const findsNewest = args[0] === "-e";
  const parts: DocumentParts = {
    bridgePath,
    // Flatpak の実行ファイルは砂箱の中で、外からは無意味なので出さない（断片は node）
    runtimePath: where.executable ?? "node",
    volatile: where.volatile,
    snippets,
    allowJson,
    portable,
    findsNewest,
    windows,
  };
  return lang === "ja" ? japanese(parts) : english(parts);
}

/** `PATH` の `node` で起動する形（env は無し）。断片の node の形と共有の項目（D99）が通す */
function nodeLaunch(args: readonly string[]): LaunchForm {
  return { command: "node", args: [...args], env: {} };
}

/** 1つの形の、3つのエージェントの断片。 */
interface FormSnippet {
  kind: SnippetForm;
  /** `claude mcp add [--scope X] ` の後ろに続く部分（`-e …` `--transport stdio showme -- <起動>`） */
  claudeTail: string;
  /** Codex の `[mcp_servers.showme]` の節の全体 */
  tomlBody: string;
  /** Copilot CLI の `mcpServers.showme` の JSON */
  copilot: string;
}

function formSnippet(
  kind: SnippetForm,
  launch: LaunchForm,
  bridgePath: string,
  windows: boolean,
): FormSnippet {
  // Claude Code の行だけはシェルを通る。Windows では cmd と PowerShell の両方で壊れない形にする
  // （`windowsCommandPath`。実行ファイルも同じ形、`node` は裸のまま）。JSON / TOML はシェルを通らないので、
  // 実行ファイルは綴りのまま、引数はどの機械でも `-e` の1行のまま
  const shellPath = windows
    ? `${kind === "node" ? "node" : windowsCommandPath(launch.command)} ${windowsCommandPath(bridgePath)}`
    : [launch.command, ...launch.args].map(shellQuote).join(" ");
  // `claude mcp add` の選択肢は名前（showme）の前に置き、`-e` の後ろには `--transport stdio` を続ける
  // （`-e` は後ろの引数を続けて食うので、名前を直後に置くと「showme は KEY=value の形でない」で失敗する。
  // Claude Code 2.1.284 に一時の HOME で登録させて確かめた）
  const envFlags = Object.entries(launch.env)
    .map(([k, v]) => `-e ${k}=${v} `)
    .join("");
  // JSON 文字列は TOML の基本文字列としてもそのまま通る（`\\` `\"` `\uXXXX`）。
  const tomlBody = [
    "[mcp_servers.showme]",
    `command = ${JSON.stringify(launch.command)}`,
    `args = [${launch.args.map((a) => JSON.stringify(a)).join(", ")}]`,
    ...(Object.keys(launch.env).length === 0
      ? []
      : [
          `env = { ${Object.entries(launch.env)
            .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
            .join(", ")} }`,
        ]),
  ].join("\n");
  return {
    kind,
    claudeTail: `${envFlags}--transport stdio showme -- ${shellPath}`,
    tomlBody,
    // Copilot CLI の断片はユーザーの mcp-config.json と repo の .mcp.json で同じ1つ。`tools` は
    // ローカルのサーバに必須（D99）
    copilot: serversJson(launch),
  };
}

/**
 * `mcpServers.showme` の JSON（Copilot CLI の設定と、repo の `.mcp.json`）。組み立てはここ1つ（不変条件14）。
 * `tools` は Copilot CLI のローカルのサーバに必須で、Claude Code は余分な鍵として受け付ける。
 */
function serversJson(launch: LaunchForm): string {
  const { command, args, env } = launch;
  // env が空なら鍵ごと省く（node で起動する形）
  const server =
    Object.keys(env).length === 0
      ? { type: "stdio", command, args, tools: ["*"] }
      : { type: "stdio", command, args, env, tools: ["*"] };
  return JSON.stringify({ mcpServers: { showme: server } }, null, 2);
}

interface DocumentParts {
  bridgePath: string;
  /** エディタの実行環境（Snap は current に直したもの。Flatpak は node） */
  runtimePath: string;
  /** 実行ファイルが長持ちしない理由（snippetRuntime）。安定なら undefined */
  volatile: VolatileRuntime | undefined;
  /** 出す形の断片。順は snippetRuntime の forms */
  snippets: FormSnippet[];
  allowJson: string;
  /** 他の人の機械でも動く形の JSON（portableLaunchArgs）。ホームの下でなければ undefined */
  portable: string | undefined;
  /** 断片が「いちばん新しい版を探して起動する」形か（開発中は直接のパス） */
  findsNewest: boolean;
  /** Windows の文書か（Claude Code の行は `windowsCommandPath`、札は powershell） */
  windows: boolean;
}

/**
 * 形ごとの断片を、札（どちらの形か）とコードブロックの組で、決めた順に並べる。
 * 3つのエージェントの節とスコープの節が通す（言語が変わっても並べ方は同じ）。
 */
function formBlocks(
  p: DocumentParts,
  labels: Readonly<Record<SnippetForm, string>>,
  fence: string,
  body: (s: FormSnippet) => string,
): string {
  return p.snippets
    .map((s) => `${labels[s.kind]}\n\n\`\`\`${fence}\n${body(s)}\n\`\`\``)
    .join("\n\n");
}

const EN_LABELS: Readonly<Record<SnippetForm, string>> = {
  runtime: "**With VS Code's runtime** (no Node.js needed):",
  node: "**With `node`** (needs Node.js 20 or later on your `PATH`):",
};

/**
 * 冒頭の「2つの形」の説明（英語。D114）。形の順は `snippetRuntime` の forms に従う。
 * 実行環境の形が長持ちしないとき（`volatile`）は、その理由を実行環境の項に書く。
 * Flatpak では実行環境の形を出さない（外から起動できない）。
 */
function englishRuntime(p: DocumentParts): string {
  const open = "open **ShowMe: Show agent configuration** again";
  const node = `- **\`node\`** needs Node.js 20 or later on your \`PATH\`. To check, run ${
    p.windows ? "`where.exe node`" : "`which node`"
  } in the terminal
  where you start your agent. After you install Node.js, quit VS Code and that terminal completely
  and start them again: a running program keeps the \`PATH\` it started with. This form does not
  depend on where VS Code is, so it keeps working when VS Code updates or restarts${
    p.windows ? ",\n  and the VS Code updater does not stop it" : ""
  }.`;
  const runtime = (): string => {
    const head = "- **VS Code's runtime** (the path above) needs no Node.js";
    switch (p.volatile) {
      case undefined:
        return `${head}. If VS Code moves to another
  folder, ${open} for the current path.${
    p.windows
      ? `
  After VS Code updates on Windows, the updater stops every program running from VS Code's folder,
  including a ShowMe that your agent started this way: reconnect ShowMe in your agent (in Claude Code,
  \`/mcp\`).`
      : ""
  }`;
      case "remote":
        return `- **VS Code's runtime** here is the runtime of the VS Code Server in this remote environment (the
  path above). It needs no Node.js, but that path changes every time VS Code updates:
  after VS Code updates, ${open} and replace the snippet.`;
      case "appimage":
        return `${head}, but VS Code runs as an AppImage, which is unpacked to a new folder
  (\`/tmp/.mount_…\`) every time it starts, so this form works only until VS Code restarts: after VS Code
  restarts, ${open} and replace the snippet.`;
      case "app-translocation":
        return `${head}, but macOS is running VS Code from a temporary folder (App Translocation),
  because it was opened where it was downloaded, so this form works only until VS Code restarts. For a
  path that lasts, move Visual Studio Code to the Applications folder, start it from there and ${open}.`;
      case "nix-store":
        return `${head}, but VS Code is installed in the Nix store (\`/nix/store/…\`): the store path
  changes on every upgrade and garbage collection deletes the old one. After upgrading VS Code, ${open}
  and replace the snippet.`;
      case "flatpak":
        return "";
    }
  };
  if (p.volatile === "flatpak") {
    return `VS Code runs in a Flatpak sandbox, so its runtime is inside the sandbox and an agent outside it cannot
start it. The snippets below start ShowMe with \`node\` instead:

${node}`;
  }
  const intro =
    p.volatile === undefined
      ? "Each agent below has two forms of the same entry. Use one of them:"
      : "Each agent below has two forms of the same entry. Use one of them. The `node` form comes first,\nbecause it lasts longer here:";
  const items = p.snippets.map((s) => (s.kind === "node" ? node : runtime()));
  return `${intro}\n\n${items.join("\n")}`;
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
  const claude = (scope: string): string =>
    formBlocks(p, EN_LABELS, fence, (s) => `claude mcp add ${scope}${s.claudeTail}`);
  const either = p.snippets.length > 1 ? " (either form above)" : "";
  return `# ShowMe — agent configuration (read-only; copy from here)

ShowMe never edits other tools' configuration files. This document is read-only:
copy the fragment you need into your agent's configuration.

Bridge: ${p.bridgePath}
Runtime: ${p.runtimePath}

${englishRuntime(p)}
${englishLead(p)}
## Claude Code

${claude("")}

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

${formBlocks(p, EN_LABELS, "toml", (s) => s.tomlBody)}

Removal: delete the \`[mcp_servers.showme]\` section above.

## Copilot CLI (\`~/.copilot/mcp-config.json\`)

${formBlocks(p, EN_LABELS, "json", (s) => s.copilot)}

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
you (saved in \`~/.claude.json\` under this project's path). The commands above are already
repository-only.

All your repositories:

${claude("--scope user ")}

Shared with your team (writes \`.mcp.json\` at the repository root, meant to be committed. Claude
Code asks each person to approve project servers before using them; \`claude mcp reset-project-choices\`
resets those answers):

${claude("--scope project ")}

### Codex CLI

Put the same \`[mcp_servers.showme]\` section${either} in \`.codex/config.toml\` in the
repository. Codex reads it only for trusted projects (\`trust_level = "trusted"\` for the project in
\`~/.codex/config.toml\`).

### Copilot CLI

Put the same entry${either} in \`.mcp.json\` at the repository root (or in
\`.github/mcp.json\`). \`"tools": ["*"]\` is required. Copilot CLI reads it only after you confirm that
you trust the folder. One \`.mcp.json\` entry like this works for both Claude Code and Copilot CLI
(Claude Code accepts the extra \`"tools"\` key).
${
  p.portable === undefined
    ? ""
    : `
### One entry for everyone on the team

ShowMe is installed under your home folder, so this entry works for anyone who installed it in the
same place under their own home folder: it finds the home folder when it starts, instead of
containing this machine's path. It starts ShowMe with \`node\`, because VS Code itself is in a
different place on each machine, so everyone who uses it needs Node.js 20 or later. Put it in
\`.mcp.json\` at the repository root for Claude Code and Copilot CLI. The same \`args\` also work in
Codex's \`.codex/config.toml\` (with \`command = "node"\`).

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
  const ja = agentConfigDocJa;
  const labels: Readonly<Record<SnippetForm, string>> = {
    runtime: ja.formRuntime,
    node: ja.formNode,
  };
  const fence = p.windows ? "powershell" : "sh";
  const claude = (scope: string): string =>
    formBlocks(p, labels, fence, (s) => `claude mcp add ${scope}${s.claudeTail}`);
  return format(ja.lines.join("\n"), [
    p.bridgePath,
    claude(""),
    p.allowJson,
    formBlocks(p, labels, "toml", (s) => s.tomlBody),
    formBlocks(p, labels, "json", (s) => s.copilot),
    japaneseLead(p),
    p.portable === undefined ? "" : format(ja.portable.join("\n"), [p.portable]),
    fence,
    p.runtimePath,
    japaneseRuntime(p),
    claude("--scope user "),
    claude("--scope project "),
    p.snippets.length > 1 ? ja.eitherForm : "",
  ]);
}

/** 冒頭の「2つの形」の説明（日本語）。`englishRuntime` と同じ場合分け */
function japaneseRuntime(p: DocumentParts): string {
  const ja = agentConfigDocJa;
  const node = format(ja.formNodeItem.join("\n"), [
    p.windows ? "`where.exe node`" : "`which node`",
    p.windows ? ja.formNodeWindows : "",
  ]);
  const runtime = (): string[] => {
    switch (p.volatile) {
      case undefined:
        return p.windows ? [...ja.runtimeDesktop, ...ja.runtimeWindowsUpdate] : ja.runtimeDesktop;
      case "remote":
        return ja.runtimeRemote;
      case "appimage":
        return ja.runtimeAppImage;
      case "app-translocation":
        return ja.runtimeTranslocation;
      case "nix-store":
        return ja.runtimeNix;
      case "flatpak":
        return [];
    }
  };
  if (p.volatile === "flatpak") return [...ja.runtimeFlatpak, "", node].join("\n");
  const intro = p.volatile === undefined ? ja.introBoth : ja.introNodeFirst;
  const items = p.snippets.map((s) => (s.kind === "node" ? node : runtime().join("\n")));
  return [...intro, "", ...items].join("\n");
}

/** 冒頭の段落（日本語）。`englishLead` と同じ4通り */
function japaneseLead(p: DocumentParts): string {
  const ja = agentConfigDocJa;
  if (p.windows && p.findsNewest) return ja.findsNewestWindows.join("\n");
  if (p.windows) return ja.windowsCommand.join("\n");
  if (p.findsNewest) return ja.findsNewest.join("\n");
  return "";
}
