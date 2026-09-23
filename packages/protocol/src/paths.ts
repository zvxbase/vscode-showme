import * as path from "node:path";

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
  }

  const cleaned = normalized === "." ? "" : normalized;
  return cleaned.length === 0 ? undefined : cleaned;
}
