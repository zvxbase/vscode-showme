import * as path from "node:path";
import { isRedactedPath, normalizeAbsolutePath } from "@zvx/vscode-showme-protocol";

/**
 * ワークスペースの外のパス（D101）の、**ファイルシステムに触らない**判断。
 *
 * 関門（`workspace-path-gate.ts` の `acceptWorkspacePath`）が、設定
 * `showme.allowOutsideWorkspace` がオンのときだけここを呼ぶ。綴りの正規化・資格情報の置き場所・
 * 秘匿の規則を、realpath の**前**（綴り）と**後**（実体）の両方に当てるための部品である。
 * 判断の順序は関門が持つ ―― ここを関門の外から呼ばない（不変条件14）。
 *
 * vscode に依存させない。パスの流儀（`path.posix` / `path.win32`）は引数で受ける ――
 * Windows の綴りを Linux の上でも検査できるように。
 */

/** 使うパスの関数だけ。`path.posix` も `path.win32` も満たす。 */
export type PathModule = Pick<
  typeof path.posix,
  "sep" | "isAbsolute" | "normalize" | "relative" | "parse"
>;

/**
 * 資格情報の置き場所（ホームからの相対。区切りは `/`）。**設定がオンでも開けない。外せない。**
 *
 * 一覧は**ここ1箇所**（設定の説明文・README はここから例を挙げるだけ）。「すべては守れない」――
 * 道具が置く場所は増え続けるし、環境変数で置き場所を移す道具もある（設計書の「既知の限界」）。
 *
 * 当てるのは、渡されたホーム（綴りと実体）と、**他のユーザーのホームの形**（`/home/*`・
 * `/Users/*`・`/root`・`/var/root`、Windows の `<ドライブ>:\Users\*`）の下。自分のホーム以外の
 * 秘密も、読めてしまえば同じく漏れる。
 *
 * - 鍵と資格情報: `.ssh`・`.aws`・`.gnupg`・`.kube`・`.docker`・`.azure`・`.config/gcloud`・
 *   `.password-store`・`.local/share/keyrings`・`Library/Keychains`（macOS）・`.pgpass`・`.my.cnf`・
 *   `.vault-token`・`.m2/settings*.xml`・`.gradle/gradle.properties`・`.config/rclone`・`.s3cfg`・
 *   `.boto`・`AppData/Roaming/Microsoft/Protect`（Windows の DPAPI）
 * - 道具の認証: `.config/gh`・`.config/github-copilot`・`.netrc`・`.git-credentials`・
 *   `.config/git/credentials`・`.pypirc`・`.npmrc`・`.claude.json`・`.claude`・`.codex`・`.copilot`・
 *   `AppData/Roaming/GitHub CLI`
 * - シェルと対話環境の履歴（打ったトークンが残る）
 * - ブラウザのプロフィール（クッキー・保存したパスワード）: Firefox・Chrome・Chromium・Edge・Brave、
 *   macOS の `Library/Cookies`
 * - エディタの状態（拡張の秘密の保存・トークンを持ちうる）: VS Code（Insiders・VSCodium・Cursor・
 *   リモートのサーバ側を含む）
 */
export const CREDENTIAL_LOCATIONS: readonly string[] = Object.freeze([
  // 鍵と資格情報
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
  ".azure",
  ".config/gcloud",
  ".password-store",
  ".local/share/keyrings",
  "Library/Keychains",
  ".pgpass",
  ".my.cnf",
  ".vault-token",
  ".m2/settings.xml",
  ".m2/settings-security.xml",
  ".gradle/gradle.properties",
  ".config/rclone",
  ".s3cfg",
  ".boto",
  "AppData/Roaming/Microsoft/Protect",
  // 道具の認証
  ".config/gh",
  ".config/github-copilot",
  ".netrc",
  ".git-credentials",
  ".config/git/credentials",
  ".pypirc",
  ".npmrc",
  ".claude.json",
  ".claude",
  ".codex",
  ".copilot",
  "AppData/Roaming/GitHub CLI",
  // 履歴
  ".bash_history",
  ".zsh_history",
  ".local/share/fish",
  ".python_history",
  ".node_repl_history",
  ".psql_history",
  ".mysql_history",
  // ブラウザ
  ".mozilla",
  ".config/google-chrome",
  ".config/chromium",
  ".config/microsoft-edge",
  ".config/BraveSoftware",
  "Library/Application Support/Google/Chrome",
  "Library/Application Support/Firefox",
  "Library/Application Support/Microsoft Edge",
  "Library/Application Support/BraveSoftware",
  "Library/Cookies",
  "AppData/Local/Google/Chrome/User Data",
  "AppData/Roaming/Mozilla",
  // エディタ
  ".vscode-server/data",
  ".config/Code",
  ".config/Code - Insiders",
  ".config/VSCodium",
  ".config/Cursor",
  ".cursor-server",
  "Library/Application Support/Code",
  "AppData/Roaming/Code",
]);

/**
 * **どの深さにあっても**断る名前（ディレクトリ）。バックアップ・古いホームの写し・別の
 * マウントの下に置かれた鍵の置き場所も同じく危ない。`CREDENTIAL_LOCATIONS` の部分集合で、
 * ホームの下でなくても当てる。
 */
export const CREDENTIAL_DIRECTORIES_ANY_DEPTH: readonly string[] = Object.freeze([
  ".ssh",
  ".gnupg",
  ".aws",
  ".password-store",
]);

/**
 * システムの置き場所（posix だけ）。疑似ファイルシステム（`/proc`・`/sys`・`/dev`。
 * `/proc/self/environ` は stat が「通常のファイル」と答える）と、コンテナの秘密の置き場所
 * （`/run/secrets`・`/var/run/secrets`。macOS では `/var` が `/private/var` の別名）。
 */
export const SYSTEM_DENIED_ROOTS: readonly string[] = Object.freeze([
  "/proc",
  "/sys",
  "/dev",
  "/run/secrets",
  "/var/run/secrets",
  "/private/var/run/secrets",
]);

/** パスを根と部分に分ける（根は `/` や `C:\`）。空の部分は捨てる。 */
function segmentsOf(abs: string, p: PathModule): { root: string; segments: string[] } {
  const root = p.parse(abs).root;
  const rest = abs.slice(root.length);
  return { root, segments: rest.split(p.sep).filter((s) => s.length > 0) };
}

/**
 * 絶対パスの綴りの正規化。**定義は protocol の `normalizeAbsolutePath` 1つ**（`normalizeWorkspaceRelative`
 * と並べて置く。解決器が `normalizedPath` を作るのにも同じものを使う）。ここは関門の部品の名前で
 * 見せるだけ。
 */
export const normalizeOutsideAbsolute = normalizeAbsolutePath;

/**
 * 照合の鍵。Unicode の正規化（NFC）と大小を揃える。macOS の既定の FS は大小を区別せず、
 * 名前の NFD / NFC も同じ実体として扱う ―― 綴りの違いで一覧を迂回させない。
 */
function matchKey(s: string): string {
  return s.normalize("NFC").toLowerCase();
}

/** `entry`（`/` 区切り）の部分列が `rest` の先頭に並ぶか。 */
function startsWithEntry(rest: readonly string[], entry: string): boolean {
  const entrySegments = matchKey(entry).split("/");
  if (entrySegments.length > rest.length) return false;
  return entrySegments.every((s, i) => s === rest[i]);
}

/**
 * パスの形から分かるホーム（他のユーザーのホームを含む）の、部分の数。無ければ 0。
 * posix: `/root`・`/var/root`・`/private/var/root`・`/home/<名前>`・`/Users/<名前>`。
 * Windows: `<ドライブ>:\Users\<名前>`。
 */
function homeShapedPrefixLengths(segments: readonly string[], windows: boolean): number[] {
  const out: number[] = [];
  const [a, b, c] = segments;
  if (windows) {
    if (a === "users" && segments.length >= 2) out.push(2);
    return out;
  }
  if (a === "root") out.push(1);
  if ((a === "home" || a === "users") && segments.length >= 2) out.push(2);
  if (a === "var" && b === "root") out.push(2);
  if (a === "private" && b === "var" && c === "root") out.push(3);
  return out;
}

/**
 * 資格情報の置き場所（とシステムの置き場所）の下か。**等しいか、その下**なら真。
 * `abs` は正規化済みの絶対パス（`normalizeOutsideAbsolute` の結果か realpath）。
 * `homes` は照合するホーム（綴りのホームと、その実体）。
 *
 * どのホームも絶対パスでない（取れなかった）ときは、確かめられないので**全部を真**にする
 * （閉じる側に倒す）。
 */
export function isDeniedOutsidePath(
  abs: string,
  homes: readonly string[],
  p: PathModule = path,
): boolean {
  const windows = p.sep === "\\";
  const key = matchKey(abs);
  if (!windows) {
    for (const root of SYSTEM_DENIED_ROOTS) {
      if (key === root || key.startsWith(`${root}/`)) return true;
    }
  }
  const usableHomes = homes.filter((h) => h.length > 0 && p.isAbsolute(h));
  if (usableHomes.length === 0) return true;

  const { root, segments: rawSegments } = segmentsOf(abs, p);
  const segments = rawSegments.map(matchKey);
  const any = new Set(CREDENTIAL_DIRECTORIES_ANY_DEPTH.map(matchKey));
  if (segments.some((s) => any.has(s))) return true;

  const prefixLengths = homeShapedPrefixLengths(segments, windows);
  for (const home of usableHomes) {
    const h = segmentsOf(p.normalize(home), p);
    if (matchKey(h.root) !== matchKey(root)) continue;
    const hs = h.segments.map(matchKey);
    if (hs.length > segments.length) continue;
    if (hs.every((s, i) => s === segments[i])) prefixLengths.push(hs.length);
  }
  for (const n of prefixLengths) {
    const rest = segments.slice(n);
    if (rest.length === 0) continue;
    if (CREDENTIAL_LOCATIONS.some((entry) => startsWithEntry(rest, entry))) return true;
  }
  return false;
}

/**
 * 秘匿の規則（既定のパターン＋`showme.redactedPathPatterns`）を外のパスに当てる。
 *
 * ワークスペースの中では「ルートからの相対パス全体」と「ファイル名」に当てている。外には
 * ルートが無いので、**末尾からの部分列すべて**（`secrets/a.txt`・`proj/secrets/a.txt` …）と
 * **各部分**（途中のディレクトリの名前）に当てる。`secrets/**` のような足したパターンは末尾の
 * 部分列に当たり、`.env` という名前のディレクトリの下も落ちる。中より広く当たる向き（閉じる側）。
 */
export function isRedactedOutsidePath(
  abs: string,
  patterns: readonly string[],
  p: PathModule = path,
): boolean {
  // 名前の NFD / NFC を揃えて照合する（大小は `matchGlob` が揃える）。
  const { segments } = segmentsOf(abs.normalize("NFC"), p);
  for (let i = 0; i < segments.length; i++) {
    if (isRedactedPath(segments.slice(i).join("/"), patterns)) return true;
    if (isRedactedPath(segments[i] as string, patterns)) return true;
  }
  return false;
}
