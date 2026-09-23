import type { HighlightColor } from "@zvx/vscode-showme-protocol";

/**
 * 画家（`decorations.ts` の `Highlights`）が持つ**2つの層**の判断だけを切り出す
 * （vscode 非依存。範囲の型 `R` は差し込む ―― 画家は `vscode.Range` を入れる）。
 *
 * `setDecorations` は「その型の全範囲」を置き換えるので、`show_code` と注釈が同じ型を
 * 別々に書けば互いを消し合う。だから画家は1つで、層を2つ持ち、
 * 1つの uri に貼るものは常に `forUri()`（両層の和）から作る（増分6 §C2。不変条件14）。
 *
 * - **spotlight**: `show_code` のもの。**窓ごと**に丸ごと置き換わる（D67）。
 *   ファイルごとに残す前の形（LRU 32）は消した ―― 戻れず、消せず、ずれるものを
 *   残す理由が無い（§C1）。
 * - **annotation**: 注釈ストアのもの。札（`key`）ごとに登録・抹消し、注釈と同じ寿命を
 *   持つ（D66）。
 *
 * どの変異も**貼り直しが要る uri** を返す。返し忘れた uri は画家が触らず、消えたはずの
 * 装飾が残る ―― だから「前の集合 ∪ 今の集合」を返す（片方だけでは足りない）。
 */
export interface LayerRange<R> {
  range: R;
  wholeLine: boolean;
  color: HighlightColor;
}

export type LayerName = "spotlight" | "annotation";

export class HighlightLayers<R> {
  /** uri -> 今の窓の範囲。 */
  private spotlight = new Map<string, readonly LayerRange<R>[]>();
  /** 注釈の札 -> (uri, 範囲)。札は注釈ストアが持ち、同じ札の再登録は置き換え。 */
  private readonly annotations = new Map<string, { uri: string; item: LayerRange<R> }>();

  /** 窓ごとに置き換える。返すのは貼り直しが要る uri（前回の集合 ∪ 今回の集合）。 */
  setSpotlight(byUri: ReadonlyMap<string, readonly LayerRange<R>[]>): string[] {
    const touched = new Set(this.spotlight.keys());
    this.spotlight = new Map(byUri);
    for (const uri of this.spotlight.keys()) touched.add(uri);
    return [...touched];
  }

  clearSpotlight(): string[] {
    return this.setSpotlight(new Map());
  }

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
    for (const [uri, items] of this.spotlight) if (items.length > 0) out.add(uri);
    for (const { uri } of this.annotations.values()) out.add(uri);
    return [...out];
  }

  /** 1つの uri に貼るもの（両層の和。spotlight が先）。画家はこれだけを見る。 */
  forUri(uri: string): LayerRange<R>[] {
    const out: LayerRange<R>[] = [...(this.spotlight.get(uri) ?? [])];
    for (const entry of this.annotations.values()) if (entry.uri === uri) out.push(entry.item);
    return out;
  }

  /** 観測用: 層の名前つきで全部。 */
  entries(): { uri: string; layer: LayerName; item: LayerRange<R> }[] {
    const out: { uri: string; layer: LayerName; item: LayerRange<R> }[] = [];
    for (const [uri, items] of this.spotlight) {
      for (const item of items) out.push({ uri, layer: "spotlight", item });
    }
    for (const { uri, item } of this.annotations.values()) {
      out.push({ uri, layer: "annotation", item });
    }
    return out;
  }
}
