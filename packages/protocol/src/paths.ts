import * as path from "node:path";

/**
 * パスの1つの部分が 8.3 の短い名前を含みうるか（`~` の後に数字）。
 *
 * Windows は `PROGRA~1` / `ENV~1` のような短い名前で同じ実体を開ける。綴りに当てる判定
 * （秘匿・資格情報の置き場所）は短い名前を知らないので、別の綴りで同じ実体を指されると
 * すり抜ける。相対パスと絶対パスの両方の関門がこの1つを通す（D106。不変条件14）。
 * ふつうの名前の `foo~1.txt` も巻き添えで落ちる（`notes~draft.md` のように数字が続かない `~` は通る）。
 */
export function hasShortNameSegment(segment: string): boolean {
  return /~\d/.test(segment);
}

/**
 * ワークスペース相対パスとして受け入れられる形に正規化する。
 * 受け入れられないものは undefined を返す（例外を投げない — 呼び出し側が
 * reason コードに変換するため）。
 *
 * ここはあくまで第一の関門で、シンボリックリンク経由の脱出は realpath を
 * 使う拡張側で別途検査する（設計書 §4.1 ⑤）。
 *
 * 返り値は**正準キー**でもある。`.env` / `./.env` / `.//.env` / `a/../.env` は
 * すべて `.env` に正規化されるので、レート制限などの鍵は生の入力ではなく
 * この結果で作ること（生文字列を鍵にすると、綴り替えだけで制限を何倍にもできる）。
 */
export function normalizeWorkspaceRelative(raw: string): string | undefined {
  if (raw.length === 0) return undefined;
  if (raw.includes("\u0000")) return undefined;

  const unified = raw.replace(/\\/g, "/");
  if (unified.startsWith("/")) return undefined;
  // コロンは位置を問わず拒否する。理由が2つある:
  //   1. ドライブ相対（"D:foo"）— path.win32.resolve(root, "D:foo") はルートを無視し、
  //      そのドライブの cwd に解決する。つまり相対パスではなく脱出である。
  //   2. NTFS の代替データストリーム（".env::$DATA"）— Windows ではこれが ".env" と
  //      同じ実体を指すので、接尾辞ベースの除外リストを素通りしてしまう。
  //      realpath でも剥がれないため、ここで塞ぐしかない。
  // 失うのはコロンを含む POSIX ファイル名だけで、実害はほぼない。
  if (unified.includes(":")) return undefined;

  const normalized = path.posix.normalize(unified);
  if (normalized === ".." || normalized.startsWith("../")) return undefined;
  if (normalized.startsWith("/")) return undefined;

  // Win32 はセグメント末尾の空白とドットを剥がす。剥がされた後の名前が別の実体を
  // 指すので、除外リストの照合と実際に開かれるファイルがずれる。拒否する。
  // "." と ".." は上の正規化で処理済みなので、この検査には到達しない。
  // 到達する "a." のようなものだけを弾く。
  for (const segment of normalized.split("/")) {
    if (segment.length === 0) continue;
    const last = segment.charAt(segment.length - 1);
    if (last === " " || last === ".") return undefined;
    // 8.3 の短い名前（`ENV~1` は Windows で `.env` と同じ実体）。綴りに当てる秘匿の判定を
    // すり抜けるので断る。Linux の repo も Windows で開かれうるので、OS を問わない（D106）。
    if (hasShortNameSegment(segment)) return undefined;
  }

  const cleaned = normalized === "." ? "" : normalized;
  return cleaned.length === 0 ? undefined : cleaned;
}

/** `normalizeAbsolutePath` が使うパスの関数だけ。`path.posix` も `path.win32` も満たす。 */
export type AbsolutePathModule = Pick<
  typeof path.posix,
  "sep" | "isAbsolute" | "normalize" | "parse"
>;

/**
 * エージェントが渡した絶対パスを、ワークスペースの外のパスとして受け入れられる形に正規化する
 * （D102。`normalizeWorkspaceRelative` の絶対パス版）。受け入れないものは `undefined`。
 *
 * **綴りの正規化だけ**で、受け入れるかどうか（設定・秘匿・資格情報の置き場所・実体）は拡張の
 * 関門が決める。結果は正準キーでもある ―― 同じ綴りの揺れ（`//`）は同じ値になる。
 *
 * - `~` で始まるものは通さない（展開しない。展開するとエージェントの言うホームと
 *   拡張のホームが一致する前提を置くことになる。絶対パスで指させる）
 * - `.` / `..` の部分は通さない（正規化で消せるが、消した後の綴りと入力が別の実体を指しうる
 *   ―― リンクを辿る前の `..` は、辿った後の `..` と意味が違う）
 * - NUL を通さない。posix ではバックスラッシュも通さない（区切りかどうかが流儀で割れる）
 * - Windows: ドライブからの絶対パス（`C:\…`）だけ。UNC（`\\server\share`）は通さない ――
 *   触った時点で外のサーバへ SMB で問い合わせ、資格情報を送りうる。`\\?\` などの名前空間、
 *   ドライブ相対（`C:a`）、ドライブの無い根（`\a`）も通さない。ドライブの後のコロン
 *   （代替データストリーム `.env::$DATA`）と、末尾が空白・ドットの部分（剥がされて別の実体を
 *   指す）、8.3 の短い名前（`PROGRA~1`。別の綴りで同じ実体を指す。普通の名前の `~1` も
 *   巻き添えで落ちる）も通さない。**ドライブ文字は小文字に揃える**（`C:` と `c:` を同じ鍵にし、
 *   映しの URI の綴りを1つに決める。VS Code も URI の文字列ではドライブ文字を小文字にする）
 */
export function normalizeAbsolutePath(
  raw: string,
  p: AbsolutePathModule = path,
): string | undefined {
  if (raw.length === 0) return undefined;
  if (raw.includes("\u0000")) return undefined;
  if (raw.startsWith("~")) return undefined;
  const windows = p.sep === "\\";
  let unified = raw;
  if (windows) {
    unified = raw.replace(/\//g, "\\");
    // ドライブ文字＋コロン＋区切り、だけを根として認める。
    if (!/^[A-Za-z]:\\/.test(unified)) return undefined;
    if (unified.indexOf(":", 2) !== -1) return undefined;
    unified = unified.charAt(0).toLowerCase() + unified.slice(1);
  } else {
    if (raw.includes("\\")) return undefined;
    if (!raw.startsWith("/")) return undefined;
  }
  if (!p.isAbsolute(unified)) return undefined;
  const root = p.parse(unified).root;
  const segments = unified
    .slice(root.length)
    .split(p.sep)
    .filter((s) => s.length > 0);
  if (segments.length === 0) return undefined; // 根そのもの
  for (const segment of segments) {
    if (segment === "." || segment === "..") return undefined;
    if (windows) {
      const last = segment.charAt(segment.length - 1);
      if (last === " " || last === ".") return undefined;
      if (hasShortNameSegment(segment)) return undefined;
    }
  }
  const normalized = p.normalize(unified);
  // 末尾の区切りは落とす（ファイルは区切りで終わらない。`/a/` と `/a` を同じ鍵にする）。
  return normalized.length > root.length && normalized.endsWith(p.sep)
    ? normalized.slice(0, -1)
    : normalized;
}
