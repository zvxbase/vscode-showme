import { matchGlob } from "./glob.js";

/**
 * 内容を読ませない・位置も解決させないパスの既定パターン。
 * 加算専用（設計書 §4.6）。利用者の設定はこれに「足す」ことしかできない。
 */
export const DEFAULT_REDACTED_PATTERNS: readonly string[] = Object.freeze([
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa*",
  "id_ed25519*",
  "credentials*",
  "*.keystore",
  ".npmrc",
  ".netrc",
]);

/**
 * このパスを秘匿対象として扱うか。既定リストと追加パターンの和で判定する。
 * 「除外しない」方向の設定は受け付けない（加算専用）。
 *
 * 照合は `matchGlob`（正規表現を使わない・大文字小文字を区別しない）で行う。
 * 大小を区別すると `.ENV` で既定リストを迂回できる — VS Code の主要プラットフォーム
 * （macOS の APFS 既定・Windows の NTFS）は大小を区別しないので、`.ENV` は関門を
 * 素通りしたまま `.env` の実体を開く。
 */
export function isRedactedPath(relPath: string, extraPatterns: readonly string[]): boolean {
  const basename = relPath.split("/").pop() ?? relPath;
  const patterns = [...DEFAULT_REDACTED_PATTERNS, ...extraPatterns];
  return patterns.some((p) => matchGlob(relPath, p) || matchGlob(basename, p));
}
