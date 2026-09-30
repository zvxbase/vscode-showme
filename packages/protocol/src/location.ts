import { z } from "zod";

/**
 * `Location.path` の説明（D102）。`show_code` / `annotate` / `find_*` が同じ `locationSchema` を
 * 共有するので、ここ1箇所に書く。
 */
export const OUTSIDE_AWARE_PATH_DESCRIPTION =
  "Workspace-relative path. An absolute path outside the workspace is accepted only when the human " +
  "turned on showme.allowOutsideWorkspace (list_workspaces.outsideWorkspace)";

export const locationSchema = z
  .object({
    path: z.string().min(1).max(1024).describe(OUTSIDE_AWARE_PATH_DESCRIPTION),
    text: z
      .string()
      .min(1)
      .max(200)
      .refine((v) => !v.includes("\n") && !v.includes("\r"), {
        message:
          "text cannot contain a newline (matching is line by line, so a string spanning lines can never match)",
      })
      .optional()
      .describe(
        "Literal string to search for. Not a regular expression. The recommended way to specify a location. " +
          "annotate paints only the matched text; when the line contains the text more than once, the whole line " +
          "is painted (use lines with startColumn and endColumn to pin one)",
      ),
    symbol: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("Symbol name. May be unavailable in Restricted Mode"),
    lines: z
      .object({
        start: z.number().int().min(1),
        end: z.number().int().min(1),
        /**
         * 0始まりの列。**任意**。両方そろったときだけ文字単位で指す。
         *
         * 片方だけ渡されても行全体に倒す ―― 「開始だけ指定して終端は行末」を
         * 許すと、範囲の意味が呼び出しごとに変わる。
         */
        startColumn: z.number().int().min(0).max(10_000).optional(),
        endColumn: z.number().int().min(0).max(10_000).optional(),
      })
      .strict()
      .optional()
      .describe(
        "1-based line range. Passing **both** startColumn and endColumn (0-based) narrows it to characters. " +
          "Lines alone are accepted (columns refine, they are not required)",
      ),
    occurrence: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe(
        "Which match to use when there are several. For text, occurrence counts lines (the Nth line containing the text)",
      ),
    // **色は持たない**（増分13 D116）。以前は `show_code` の塗りの色がここにあり、塗らないツールは
    // それを外した別のスキーマ（`markerLocationSchema`）を使っていた（増分6 D65'）。`show_code` も
    // 塗らなくなったので、色の摘みを持つ位置は無い。注釈の色は項目の `color`（`annotateItemSchema`）。
    // 効かない摘みを広告しない ―― 受けて黙って捨てると、エージェントは効いていると思い込む。
  })
  .strict();

export type Location = z.infer<typeof locationSchema>;

/** 何件当たったか。正確な件数は返さない（設計書 §4.1 ③ / S1）。 */
export type MatchKind = "none" | "one" | "many";

/**
 * 解決できなかった理由。**閉じた語彙**にする。
 *
 * 線上の結果スキーマ（`wire.ts`）もこの一覧から作る。ここが自由文字列だと、
 * `reason` が「ファイルの中身を返さない」の抜け道になる
 * ―― 拡張が中身を `reason` に詰めても、結果スキーマは通してしまう。
 * 型と線がずれないよう、一覧は1つだけ持つ。
 */
export const RESOLUTION_REASONS = [
  "no-provider",
  "restricted-mode",
  "unsupported-language",
  "excluded-path",
  "invalid-path",
  "not-found",
  "rate-limited",
  "no-selector",
  /**
   * 位置は解決できたが、開ける舞台の列が無かった（D90）。`showme.stage.avoidToolColumns` が
   * オンで、人間の列の右がターミナルや他の拡張のパネルの列で埋まり、列も足せないとき。
   * 位置（範囲）は返さない ―― 開けなかった位置を返さないのは他の理由と同じ。
   */
  "no-stage-column",
] as const;

export type ResolutionReason = (typeof RESOLUTION_REASONS)[number];

export interface Resolution {
  resolvedBy: "text" | "symbol" | "lines" | "none";
  match: MatchKind;
  /**
   * 確定した範囲。`match === "one"` のときだけ入る。
   *
   * `startColumn` / `endColumn` は**両方そろったときだけ**入る（0始まり、設計 D34）。
   * 入っていれば文字単位、入っていなければ行全体である。`text` で解決したときは一致した
   * 文字列の列（UTF-16 の単位。増分13 D118）、`lines` は指定された列、`symbol` は行全体。
   */
  range?: { startLine: number; endLine: number; startColumn?: number; endColumn?: number };
  /** match === "many" のときの候補。最大3件 */
  candidates?: { line: number }[];
  reason?: ResolutionReason;
  /**
   * 正規化済みのワークスペース相対パス。解決に成功したかどうかに関わらず、
   * 正規化さえ通れば入る（入らないのは `invalid-path` のときだけ）。
   *
   * 呼び出し側はこれを**正準キー**として使うこと。生の `Location.path` を鍵にすると、
   * `.env` / `./.env` / `a/../.env` が別々のバケットになり、レート制限を綴り替えだけで
   * 何倍にもできる（実測でこの4つはすべて `.env` に正規化される）。
   */
  normalizedPath?: string;
}

/** "many" のとき返す候補の上限。オラクルの帯域を絞るための定数。 */
export const MAX_CANDIDATES = 3;

/**
 * 見つけた位置1件。**中身は含まない**（不変条件2）。
 *
 * `Resolution` と分けてある ―― あちらは「エージェントが指定した1箇所を解決した」
 * 結果で、こちらは「言語サーバに聞いたら複数あった」結果である。同じ型にすると
 * `resolvedBy` のような、こちらでは意味を持たない欄が付いて回る。
 */
export interface FoundLocation {
  /** ワークスペース相対パス。ワークスペースの外は返さない */
  path: string;
  /** 1始まりの行 */
  line: number;
  /** 0始まりの列。プロバイダが返さなければ 0 */
  column: number;
}

/**
 * 位置を探した結果。**正確な件数は返さない**（設計書 §4.1 ③ / S1）。
 */
export interface LocationSearchResult {
  match: MatchKind;
  /** 見つけた位置。**上限つき**。`match` が `"many"` でも全部は返さない */
  locations: FoundLocation[];
  /** 見つからなかった／探せなかった理由 */
  reason?: ResolutionReason;
}

/**
 * 返す位置の上限。
 *
 * 参照は数百件になりうる。**これは「見せる」ではなく「教える」ので舞台は広がらない**
 * ―― `locations[]`（舞台、上限3、不変条件10）とは**別の量**なので、別の定数にする。
 * 混ぜると「参照が3件しか返らない」か「舞台が20列になる」のどちらかになる。
 *
 * それでも無制限にはしない。返す量そのものが人間の読めない大きさになるし、
 * エージェントの文脈も食う。
 */
export const MAX_FOUND_LOCATIONS = 20;
