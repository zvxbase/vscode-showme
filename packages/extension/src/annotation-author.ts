import type { AnnotationColor } from "@zvx/vscode-showme-protocol";

/**
 * 色 → 作成者名（D57）。**吹き出しにもコメント一覧にも出る**唯一の面。
 *
 * 人間の観察: 吹き出しには作成者のアイコン（D46 で同梱していた画像）が出るが、
 * コメント一覧には作成者名と本文しか載らない。一覧で色が分かるには作成者名に入れるしかない。
 * 吹き出しにも作成者名は出るので、アイコンは要らなくなった（`media/` ごと消した）。
 *
 * **値はリテラルだけである**（D47 と同じ構造）。エージェントが送るのは色名で、
 * この表の鍵の照合にしか使われない。作成者名の偽装（設計書 §5.4: 人間の名前や
 * 「VS Code」を名乗る吹き出し）は構造的に不可能。
 *
 * `Record<AnnotationColor, string>` にしてあるので、語彙に色を足すと
 * ここが型で落ちる（足し忘れが黙って無印に倒れない）。
 *
 * 灰が無いのは、灰の丸（⚪/⚫）が白か黒にしか見えず環境依存が強いため。
 *
 * ## なぜ `annotations.ts` ではなくここにあるか
 *
 * `annotations.ts` は `vscode` を**値として**読むので vitest から読み込めない。
 * 表そのものを単体で検査できるように、vscode に触らない側へ置く。
 * **定義はここ1つだけ**で、`annotations.ts` はこれを import する（不変条件14）。
 */
export const ANNOTATION_AUTHOR: Record<AnnotationColor, string> = {
  yellow: "ShowMe 🟡 Y",
  green: "ShowMe 🟢 G",
  red: "ShowMe 🔴 R",
  blue: "ShowMe 🔵 B",
  purple: "ShowMe 🟣 P",
};

/** 無印。色を持たない。 */
export const ANNOTATION_AUTHOR_DEFAULT = "ShowMe";

/**
 * 番号つきの作者名（増分6 D69）。**番号は拡張が付ける。**
 *
 * ```
 * total <= 1   → "ShowMe 🔴 R"          （D57 のまま。1件だけなら番号を出さない ―― 人間の決定 §B4）
 * total >= 2   → "3/7 · ShowMe 🔴 R"
 * ```
 *
 * エージェントに番号を渡させない（配列の順と番号で「順番を決める場所が2つ」になる。
 * 設計書 §C3）。`items[]` の順が読む順で、`index` と `total` はストア（`annotations.ts`）が
 * 自分の一覧から数える。
 *
 * **作者名に入るのは表の値と整数だけ**なので、D57 の性質（人間の名前や「VS Code」を
 * 名乗る吹き出しは構造的に描けない）は番号が付いても保たれる。
 *
 * `index` / `total` はストアが決める量で、外から入る値ではない。矛盾した番号
 * （`3/2`、0、非整数）は入力の誤りではなく**バグ**なので、黙って直さず投げる。
 */
export function annotationAuthor(
  color: AnnotationColor | undefined,
  index: number,
  total: number,
): string {
  if (!Number.isInteger(index) || !Number.isInteger(total) || index < 1 || total < 1) {
    throw new Error(`annotation numbering out of range: ${String(index)}/${String(total)}`);
  }
  if (index > total) {
    throw new Error(`annotation index exceeds total: ${String(index)}/${String(total)}`);
  }
  const name = color === undefined ? ANNOTATION_AUTHOR_DEFAULT : ANNOTATION_AUTHOR[color];
  return total <= 1 ? name : `${String(index)}/${String(total)} · ${name}`;
}
