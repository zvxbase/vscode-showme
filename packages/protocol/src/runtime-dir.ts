import * as path from "node:path";

/** 実行時ディレクトリの名前。ブリッジと拡張の両方がこの規則で計算する。 */
export const RUNTIME_DIR_BASENAME = "vscode-showme";

/**
 * 拡張が統合ターミナルに注入し、ブリッジが読む環境変数の名前。
 *
 * 注入する側(拡張)と読む側(ブリッジ)は別プロセスなので、名前が両方に
 * 書かれていると片方だけ直したときに黙って疎通しなくなる。実行時ディレクトリの
 * 計算と同じ理由で、唯一の定義元は protocol に置く。
 *
 * `VSCODE_` 接頭辞は使わない。`sanitizeProcessEnvironment` の削除対象で、
 * いま生き残っているのは適用順序の偶然にすぎない(設計書 Y2)。
 */
export const SOCKET_ENV_VAR = "SHOWME_SOCK";

export interface UidSource {
  getuid?: (() => number) | undefined;
}

/**
 * 実行時ディレクトリの名前に使う uid。
 *
 * `runtimeDirPath` と同じく、**両端が同じ答えを出さないと互いを見つけられない**。
 * Windows には `process.getuid` が無い。`os.userInfo().uid` は -1 を返すが、
 * それを使うと「片方が -1、もう片方が 0」で黙ってすれ違いうるので、
 * 無いときの値もここで1つに決める。
 */
export function processUid(source: UidSource): number {
  return typeof source.getuid === "function" ? source.getuid() : 0;
}

export interface RuntimeDirEnv {
  // 環境変数の入れ物（`process.env` をそのまま渡す）。名前つきの欄だけだと TypeScript が「弱い型」と
  // みなし、`ProcessEnv` に共通の欄が無いとして断ることがある（依存の型の版で揺れた）
  readonly [name: string]: string | undefined;
  XDG_RUNTIME_DIR?: string | undefined;
  /** win32 だけが使う（D125）。 */
  LOCALAPPDATA?: string | undefined;
}

/**
 * ソケットと登録ファイルを置く**第一の**ディレクトリ（`runtimeDirCandidates` の先頭）。
 *
 * ブリッジと拡張は別プロセスなので、この関数が両者で同じ答えを出すことが
 * 疎通の前提になる（設計書 §3.3 / Y4）。os.tmpdir() は $TMPDIR に従うため、
 * 呼び出し側が tmpdir と platform を渡す形にして、テストで固定できるようにしてある。
 *
 * mkdtemp() は使わない。名前がランダムだとブリッジが登録ファイルを見つけられない。
 * パスは決定的にし、安全性は「開いた fd を fstat して検証する」ことで担保する（設計書 D22）。
 */
export function runtimeDirPath(
  env: RuntimeDirEnv,
  tmpdir: string,
  uid: number,
  platform: NodeJS.Platform,
): string {
  // tmpdir の候補は必ず入るので、`[0]` は未定義にならない。
  return runtimeDirCandidates(env, tmpdir, uid, platform)[0] as string;
}

type PathApi = typeof path.posix;

/** 後退先（tmpdir の下）の実行時ディレクトリの名前。uid を埋めて利用者ごとに分ける。 */
function fallbackRuntimeDirName(uid: number): string {
  return `${RUNTIME_DIR_BASENAME}-${uid}`;
}

/** `runtimeDirPath` が作りうる名前の形（XDG・%LOCALAPPDATA% の下なら基底名そのもの、tmpdir の下なら `-<uid>` 付き）。 */
const RUNTIME_DIR_NAME = new RegExp(`^${RUNTIME_DIR_BASENAME}(?:-\\d+)?$`);
/** tmpdir の下の名前の形（`-<uid>` 付き）。 */
const TMPDIR_RUNTIME_DIR_NAME = new RegExp(`^${RUNTIME_DIR_BASENAME}-\\d+$`);

/**
 * `name` が実行時ディレクトリの名前の形か（D105）。ブリッジは、ソケットが実行時ディレクトリの
 * 形をしたディレクトリの中にあることを確かめる。ブリッジ自身は構成できない候補
 * （拡張にだけ `$XDG_RUNTIME_DIR` がある）もあるので、候補の一覧ではなく名前の形で見る。
 */
export function isRuntimeDirName(name: string): boolean {
  return RUNTIME_DIR_NAME.test(name);
}

/**
 * `name` が tmpdir の下の候補の名前か（D125）。親の検査に落ちたときの助言
 * （「TEMP / TMP を向け直す」）を、その候補にだけ添えるために使う。
 */
export function isTmpdirRuntimeDirName(name: string): boolean {
  return TMPDIR_RUNTIME_DIR_NAME.test(name);
}

/** `$XDG_RUNTIME_DIR` の候補。無い・相対なら信用しない。 */
function xdgCandidate(env: RuntimeDirEnv, p: PathApi): string | undefined {
  const xdg = env.XDG_RUNTIME_DIR;
  // 綴り（区切り文字・絶対の判定）は `platform` 引数に従い、走らせている機械には依らない。
  // 拡張とブリッジはそれぞれ自分の `process.platform` を渡し、両者は必ず同じ OS / 同じ
  // ファイルシステム名前空間にいる（設計書 §3.4 が唯一の成立条件としてそう定めており、
  // ホスト↔コンテナ／WSL の組み合わせは明示的に非対応）ので、同じ綴りの答えを得る。
  if (xdg && p.isAbsolute(xdg)) return p.join(xdg, RUNTIME_DIR_BASENAME);
  return undefined;
}

/**
 * win32 の `%LOCALAPPDATA%` の候補（D125）。既定の DACL は本人・SYSTEM・Administrators だけで、
 * エージェントのサンドボックスが権利を足すのは `%TEMP%` のほう（Codex の `CodexSandboxUsers` など）。
 * ローカルのドライブでない綴り（UNC など）も候補には入る。拡張は ACL の検査
 * （`windows-acl-io.ts` の `closedOnError`）が触る前に断り、ブリッジは在るかを lstat で見てから
 * 同じ検査で断る（XDG の候補と同じ扱い）。
 */
/**
 * ローカルのドライブの絶対パス（`C:\...`）か。UNC（`\\host\...`）は SMB で外の機械に触れ、
 * `\\?\` / `\\.\` はデバイスの名前空間、`C:dir` はそのドライブの現在のディレクトリ、
 * `\dir` は現在のドライブに相対 ―― どれも「どこを確かめたか」が綴りから決まらない。
 * Windows の実行時ディレクトリの綴りを受け入れるかは、この1つで決める（候補を作る側と
 * ACL を確かめる側。不変条件14）。
 */
export function isLocalDriveAbsolutePath(p: string): boolean {
  return /^[A-Za-z]:\\/.test(p);
}

function localAppDataCandidate(
  env: RuntimeDirEnv,
  platform: NodeJS.Platform,
  p: PathApi,
): string | undefined {
  if (platform !== "win32") return undefined;
  const base = env.LOCALAPPDATA;
  // UNC などは候補にしない。ブリッジは確かめる前に lstat するので、ここで落とさないと SMB に触れる
  if (base && p.isAbsolute(base) && isLocalDriveAbsolutePath(base)) {
    return p.join(base, RUNTIME_DIR_BASENAME);
  }
  return undefined;
}

/**
 * 実行時ディレクトリの候補。**読む側も書く側もこれを使う**（設計書 §2A.6）。
 *
 * 拡張とブリッジで `$XDG_RUNTIME_DIR` が食い違うと、同じマシンにいても別の場所を
 * 探して黙って見つからなくなる（長生きした tmux サーバが古い値を握る、
 * ログアウト後に /run/user/<uid> が消える、など）。
 *
 * **読むだけを候補すべてにしても片方向しか塞がらない。** ブリッジは自分に
 * `$XDG_RUNTIME_DIR` が無ければ XDG 候補を**構成できない**ので、「拡張に XDG が
 * あり、ブリッジには無い」向きは残る ―― そしてそれが現実的な構成である
 * （デスクトップ／コンテナで起動した VS Code には XDG があり、`docker exec` /
 * `ssh` / `su` で入ったシェルには無い）。だから拡張は**全部の候補に登録ファイルを
 * 書く**。ソケットは1本のままで、複製するのは登録ファイルだけである。
 *
 * 並びは XDG（あれば）・`%LOCALAPPDATA%`（win32 だけ。D125）・tmpdir の後退先。tmpdir を最後に
 * 残すのは、版の混ざった窓とブリッジが互いを見つけられるようにするため。
 *
 * 先頭は必ず第一候補。ソケットは、用意できてパスが `sun_path` に収まる最初の候補に置く
 * （ふつうは第一候補。拡張の `server.ts`。D108）。同じ場所になる候補は1つに畳む
 * （同じディレクトリを2度走査すると、同じ窓の登録が2つに見える）。
 */
export function runtimeDirCandidates(
  env: RuntimeDirEnv,
  tmpdir: string,
  uid: number,
  platform: NodeJS.Platform,
): string[] {
  const p: PathApi = platform === "win32" ? path.win32 : path.posix;
  const all = [
    xdgCandidate(env, p),
    localAppDataCandidate(env, platform, p),
    p.join(tmpdir, fallbackRuntimeDirName(uid)),
  ];
  return [...new Set(all.filter((dir): dir is string => dir !== undefined))];
}
