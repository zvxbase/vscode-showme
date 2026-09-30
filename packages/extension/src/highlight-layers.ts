import type { HighlightColor } from "@zvx/vscode-showme-protocol";

/**
 * 画家（`decorations.ts` の `Highlights`）が持つ**注釈の層**の判断だけを切り出す
 * （vscode 非依存。範囲の型 `R` は差し込む ―― 画家は `vscode.Range` を入れる）。
 *
 * 層は1つ（注釈）。札（`key`）ごとに登録・抹消し、注釈と同じ寿命を持つ（増分6 D66）。
 * 以前はもう1つ、`show_code` のスポットライトの層があった（窓ごとに丸ごと置き換わる。D67）が、
 * 増分13 D116 で `show_code` が塗らなくなったので消した（死んだ層を残さない）。
 *
 * `setDecorations` は「その型の全範囲」を置き換えるので、1つの uri に貼るものは常に
 * `forUri()` の全部から作る（増分6 §C2。不変条件14）。書き手を足すなら、このクラスに層として
 * 足し、画家に別の口を作らない。
 *
 * どの変異も**貼り直しが要る uri** を返す。返し忘れた uri は画家が触らず、消えたはずの
 * 装飾が残る ―― だから「前の uri ∪ 今の uri」を返す（片方だけでは足りない）。
 */
export interface LayerRange<R> {
  range: R;
  wholeLine: boolean;
  color: HighlightColor;
}

export class HighlightLayers<R> {
  /** 注釈の札 -> (uri, 範囲)。札は注釈ストアが持ち、同じ札の再登録は置き換え。 */
  private readonly annotations = new Map<string, { uri: string; item: LayerRange<R> }>();

  /** key は注釈ストアが持つ札（同じ key の再登録は置き換え）。 */
  setAnnotation(key: string, uri: string, range: LayerRange<R>): string[] {
    const touched = new Set<string>();
    const previous = this.annotations.get(key);
    if (previous !== undefined) touched.add(previous.uri);
    this.annotations.set(key, { uri, item: range });
    touched.add(uri);
    return [...touched];
  }

  removeAnnotation(key: string): string[] {
    const previous = this.annotations.get(key);
    if (previous === undefined) return [];
    this.annotations.delete(key);
    return [previous.uri];
  }

  // **注釈の層を空にする口は無い。** 注釈の層の持ち主は注釈ストア（`annotations.ts`）で、
  // 抹消は `removeAnnotation(key)` を札ごとに通す。層側に「全部消す」を持つと、
  // 吹き出しを消さずに塗りだけを消せる経路がもう1つできる（不変条件14）。

  /** 何かを貼っている uri。観測用。 */
  uris(): string[] {
    const out = new Set<string>();
    for (const { uri } of this.annotations.values()) out.add(uri);
    return [...out];
  }

  /** 1つの uri に貼るもの（登録順）。画家はこれだけを見る。 */
  forUri(uri: string): LayerRange<R>[] {
    const out: LayerRange<R>[] = [];
    for (const entry of this.annotations.values()) if (entry.uri === uri) out.push(entry.item);
    return out;
  }

  /** 観測用: 全部。 */
  entries(): { uri: string; item: LayerRange<R> }[] {
    return [...this.annotations.values()].map(({ uri, item }) => ({ uri, item }));
  }
}
