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

/** 1始まりの行番号で、リテラル文字列が現れる行をすべて返す。 */
function literalMatchLines(content: string, needle: string): number[] {
  const lines = content.split("\n");
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? "").includes(needle)) hits.push(i + 1);
  }
  return hits;
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
  const rel = normalizeWorkspaceRelative(loc.path);
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

    const hits = literalMatchLines(content, loc.text);
    if (hits.length === 0) return none("not-found", "text");

    if (loc.occurrence !== undefined) {
      const picked = hits[loc.occurrence - 1];
      if (picked === undefined) return none("not-found", "text");
      return {
        resolvedBy: "text",
        match: "one",
        range: { startLine: picked, endLine: picked },
        normalizedPath: rel,
      };
    }

    if (hits.length === 1) {
      const line = hits[0] as number;
      return {
        resolvedBy: "text",
        match: "one",
        range: { startLine: line, endLine: line },
        normalizedPath: rel,
      };
    }

    return {
      resolvedBy: "text",
      match: "many",
      candidates: hits.slice(0, MAX_CANDIDATES).map((line) => ({ line })),
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
