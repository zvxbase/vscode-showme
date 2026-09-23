/**
 * 人間の選択を共有する／しないの語彙と上限。**定義元はここ1つ**
 * 。
 *
 * 判定そのもの（`judgeSelection`）は拡張側にある。判定は観測量を要るだけ、
 * 語彙は線に載るので protocol にある ―― `RESOLUTION_REASONS` と同じ分け方である。
 * 語彙を拡張側に置くと、結果スキーマ（`getEditorStateResultSchema`）が
 * `z.string()` に緩み、そこが不変条件2の抜け道になる。
 */

/**
 * 選択テキストを返さなかった理由。**閉じた語彙**。
 *
 * 自由文字列にしない。理由に任意の文字列を入れられるなら、そこがそのまま
 * 「ファイルの中身を返さない」の抜け道になる（`resolutionSchema.reason` と同じ理由）。
 *
 * **並びは判定の順序そのものである**（`human-selection.ts` の `SELECTION_CHECK_ORDER`
 * が一致していることを検査している）。順序は「その理由がどれだけ長く真であり続けるか」
 * の降順で決めてある:
 *
 * | 段 | 理由 | いつ変わるか |
 * |---|---|---|
 * | パス | `outside-workspace` / `redacted` | 別のファイルを開くまで変わらない |
 * | 選択の形 | `empty` / `whole-document` | 人間が選び直せば変わる |
 * | 人間の居場所 | `not-focused` / `not-active` | 人間が戻れば変わる |
 * | 時間 | `too-soon-after-tool` | 待てば変わる |
 * | 重複 | `already-returned` | 人間が動かせば変わる |
 *
 * **永続的な理由を一時的な理由で覆い隠さない。** 覆うと、エージェントは
 * 「もう一度呼べば取れる」と読んで呼び続ける ―― `selectionWithheld` を返すのは
 * まさにその無限の往復を止めるためである。
 */
export const SELECTION_WITHHELD_REASONS = [
  "outside-workspace",
  "redacted",
  "empty",
  "whole-document",
  "not-focused",
  "not-active",
  "too-soon-after-tool",
  "already-returned",
] as const;

export type SelectionWithheldReason = (typeof SELECTION_WITHHELD_REASONS)[number];

/**
 * 選択テキストの絶対上限（文字数）。
 *
 * `showme.maxSelectionChars`（既定 4000）は**この値より上には行けない**。
 * 設定側だけで切ると、上限は拡張の善意に依存する ―― 信頼境界はソケットなので、
 * エージェントへ手渡す手前（ブリッジの結果スキーマ）にも同じ上限が要る。
 * ここが「どのツールもファイルの中身を返さない」の唯一の明示的な例外であり、
 * 例外である以上、大きさが有限であることを型で言えなければならない。
 */
export const MAX_SELECTED_TEXT_CHARS = 4000;

/**
 * `openPaths` に載せるパスの本数の上限。
 *
 * 本数に上限が無いと、1024 文字のパスをいくつでも積める配列が1本、
 * 結果スキーマの中に開いたままになる。実用（開いているタブ）は多くても数十本。
 */
export const MAX_OPEN_PATHS = 200;
