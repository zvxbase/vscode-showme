import {
  type Location,
  MAX_CANDIDATES,
  type Resolution,
  type ResolutionReason,
} from "./location.js";
import { normalizeWorkspaceRelative } from "./paths.js";

export interface ResolveDeps {
  /** ファイル内容を返す。読めなければ undefined。 */
  readText(relPath: string): string | undefined;
  /**
   * シンボル名から範囲を引く。プロバイダが無い／使えない場合は undefined。
   * 空配列は「引けたが見つからなかった」を意味し、undefined と区別する。
   */
  findSymbol(relPath: string, name: string): { startLine: number; endLine: number }[] | undefined;
  /** 秘匿対象のパスか。 */
  isRedacted(relPath: string): boolean;
  /**
   * `Location.path` を正準キー（`normalizedPath`）に正規化する。受け入れない綴りは `undefined`
   * （`invalid-path`）。省略すると `normalizeWorkspaceRelative`（ワークスペース相対パスだけ）。
   *
   * 拡張は人間の設定 `showme.allowOutsideWorkspace` がオンのときだけ、絶対パスも受ける正規化を
   * 渡す（D102。中を指す絶対パスは相対パスに、外は正規化した絶対パスに）。以降の `readText` /
   * `findSymbol` / `isRedacted` にはこの結果が渡る。
   */
  normalizePath?(rawPath: string): string | undefined;
}

/**
 * `readText` が返してよい内容の上限。
 *
 * 上限を課すのは呼び出し側（拡張）の責務だが、**上限を宣言するのは protocol の責務**。
 * これが無いと、2プロセスが共有する契約としては「何バイトでもよい」と読める。
 * 実測: 5MB・全行改行の最悪ケースで split に 64 ms・一時確保 45 MB。
 * 50MB だと 593 ms・450 MB になる。
 */
export const MAX_RESOLVE_BYTES = 5 * 1024 * 1024;

/**
 * リテラル文字列が現れる行をすべて返す。`line` は1始まり、`column` はその行の**最初の**一致の
 * 0始まりの列（増分13 D118）。
 *
 * 列は JavaScript の文字列の添字、つまり **UTF-16 の単位**で数える。VS Code の
 * `Position.character` も同じ単位なので、全角もサロゲートペア（絵文字）も手前にあってずれない
 * （`resolve-location.test.ts` が両方を当てている）。行は `\n` で切るので、CRLF の `\r` は
 * 行末に残るだけで列には効かない。
 */
function literalMatches(
  content: string,
  needle: string,
): { line: number; column: number; again: boolean }[] {
  const lines = content.split("\n");
  const hits: { line: number; column: number; again: boolean }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i] ?? "";
    const column = text.indexOf(needle);
    // `again`: 同じ行にもう1つ一致がある（重なる一致も数える）。そのときは列を名乗らない ――
    // `occurrence` は行を数えるので、同じ行の2つ目は指せず、1つ目の列を返すと黙って違う方を塗る。
    if (column !== -1)
      hits.push({ line: i + 1, column, again: text.indexOf(needle, column + 1) !== -1 });
  }
  return hits;
}

/**
 * 先頭の BOM（U+FEFF）を外す。VS Code は文書の本文から BOM を外すので、残したまま数えると
 * 1行目の列だけが1つずれる（拡張の読み出しは `Buffer#toString("utf8")` で BOM を残す）。
 */
function stripBom(content: string): string {
  return content.startsWith("\uFEFF") ? content.slice(1) : content;
}

/**
 * 行数を数える。`split("\n").length` と同じ答えを、配列を作らずに出す。
 * 5MB・全行改行のファイルでこの差が 45 MB の一時確保になる。
 */
function countLines(content: string): number {
  let total = 1;
  let at = content.indexOf("\n");
  while (at !== -1) {
    total += 1;
    at = content.indexOf("\n", at + 1);
  }
  return total;
}

/**
 * Location を確定した範囲に解決する。
 *
 * 純関数。ファイル読み出しとシンボル検索は注入する（テスト可能性のためと、
 * 「どこで I/O が起きるか」を1箇所に閉じ込めるため）。
 *
 * 返り値にファイルの内容を含めないこと。正確なマッチ件数も含めないこと。
 * どちらも無音のオラクルになる（設計書 §4.1 / S1・D8'）。
 */
export function resolveLocation(loc: Location, deps: ResolveDeps): Resolution {
  const rel =
    deps.normalizePath === undefined
      ? normalizeWorkspaceRelative(loc.path)
      : deps.normalizePath(loc.path);
  // 正規化が失敗したときだけ normalizedPath を載せられない。正準キーが無いので、
  // 呼び出し側はこの経路をレート制限の対象にできない（そもそも何も読んでいない）。
  if (rel === undefined) return { resolvedBy: "none", match: "none", reason: "invalid-path" };

  const none = (
    reason: ResolutionReason,
    resolvedBy: Resolution["resolvedBy"] = "none",
  ): Resolution => ({ resolvedBy, match: "none", reason, normalizedPath: rel });

  /** 上限を超える内容は「読めなかった」として扱う。呼び出し側に内容量を漏らさない。 */
  const read = (): string | undefined => {
    const content = deps.readText(rel);
    if (content === undefined) return undefined;
    if (content.length > MAX_RESOLVE_BYTES) return undefined;
    return content;
  };

  if (deps.isRedacted(rel)) return none("excluded-path");

  // ── text（リテラル）── 最優先。制限モードでも動く唯一の頑健な手段。
  if (loc.text !== undefined) {
    const content = read();
    if (content === undefined) return none("not-found", "text");

    const needle = loc.text;
    const hits = literalMatches(stripBom(content), needle);
    if (hits.length === 0) return none("not-found", "text");

    // **一致した文字列の列範囲を返す**（増分13 D118）。塗りは文字列だけ、吹き出しはその行
    // （`annotate`）。行が1つに決まったときだけ付く。終端は含まない（`startColumn + 長さ`）。
    // **その行に一致が2つ以上あれば列を返さず行全体**（どちらを指したか決められない。`occurrence`
    // は行を数える）。件数は返さない（不変条件4）。1つに絞るには `lines` の列を使う。
    const exactly = (hit: { line: number; column: number; again: boolean }): Resolution => ({
      resolvedBy: "text",
      match: "one",
      range: hit.again
        ? { startLine: hit.line, endLine: hit.line }
        : {
            startLine: hit.line,
            endLine: hit.line,
            startColumn: hit.column,
            endColumn: hit.column + needle.length,
          },
      normalizedPath: rel,
    });

    if (loc.occurrence !== undefined) {
      const picked = hits[loc.occurrence - 1];
      if (picked === undefined) return none("not-found", "text");
      return exactly(picked);
    }

    if (hits.length === 1) return exactly(hits[0] as (typeof hits)[number]);

    return {
      resolvedBy: "text",
      match: "many",
      candidates: hits.slice(0, MAX_CANDIDATES).map(({ line }) => ({ line })),
      normalizedPath: rel,
    };
  }

  // ── symbol ── 使えるときだけ。制限モードでは TS/JS で常に空になる。
  if (loc.symbol !== undefined) {
    const found = deps.findSymbol(rel, loc.symbol);
    if (found === undefined) return none("no-provider", "symbol");
    if (found.length === 0) return none("not-found", "symbol");

    const index = (loc.occurrence ?? 1) - 1;
    const picked = found[index];
    if (picked === undefined) return none("not-found", "symbol");
    if (found.length > 1 && loc.occurrence === undefined) {
      return {
        resolvedBy: "symbol",
        match: "many",
        candidates: found.slice(0, MAX_CANDIDATES).map((r) => ({ line: r.startLine })),
        normalizedPath: rel,
      };
    }
    return { resolvedBy: "symbol", match: "one", range: picked, normalizedPath: rel };
  }

  // ── lines ── 最後の手段。
  if (loc.lines !== undefined) {
    const { start, end } = loc.lines;
    if (start > end) return none("not-found", "lines");
    const content = read();
    if (content === undefined) return none("not-found", "lines");
    const total = countLines(content);
    if (start > total) return none("not-found", "lines");
    // 列は**両方そろったときだけ**通す（設計 D34）。片方だけなら行全体に倒す ――
    // 「開始だけ指定して終端は行末」を許すと、範囲の意味が呼び出しごとに変わる。
    const columns =
      loc.lines.startColumn !== undefined && loc.lines.endColumn !== undefined
        ? { startColumn: loc.lines.startColumn, endColumn: loc.lines.endColumn }
        : {};
    return {
      resolvedBy: "lines",
      match: "one",
      range: { startLine: start, endLine: Math.min(end, total), ...columns },
      normalizedPath: rel,
    };
  }

  return none("no-selector");
}
