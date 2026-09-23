import { normalizeWorkspaceRelative } from "@zvx/vscode-showme-protocol";

/**
 * `RelativePattern` の第2引数は **glob** である。ファイル名に `* ? [ ] { }` が入ると、
 * `docs/*.html` という実在のファイルが `docs/` の HTML 全部（`**` なら木全体）を見張る
 * パターンになる。中身は漏れない（再描画の閉包は固定した綴りを毎回関門を通して読む）が、
 * 見張る集合が1ファイルより広い。エスケープの構文は無いので、**見張らない**（閉じる側に倒す。
 * 描画は済んでいる）。
 */
const GLOB_METACHARACTERS = /[*?[\]{}]/;

/**
 * 見張ってよい綴りに直す。**関門と同じ `normalizeWorkspaceRelative`** で揃える ――
 * 関門が `./docs/a.html` を `docs/a.html` として受け入れたのに、見張りが生の綴りで
 * 別のパターンを張ると、同じ量を2箇所で別々に決めることになる（不変条件14）。
 *
 * 通らなければ `undefined`（見張らない）。
 */
export function watchablePattern(relPath: string): string | undefined {
  const normalized = normalizeWorkspaceRelative(relPath);
  if (normalized === undefined) return undefined;
  if (GLOB_METACHARACTERS.test(normalized)) return undefined;
  return normalized;
}
