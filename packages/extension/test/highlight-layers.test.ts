import { describe, expect, it } from "vitest";
import { HighlightLayers, type LayerRange } from "../src/highlight-layers.js";

/**
 * 範囲の型は何でもよい（画家は `vscode.Range` を差す）。ここでは行番号を1つ持つだけの
 * 値で、層の判断だけを見る。
 */
type R = { line: number };
const item = (line: number, color: LayerRange<R>["color"] = "yellow"): LayerRange<R> => ({
  range: { line },
  wholeLine: true,
  color,
});
const map = (
  ...pairs: [string, LayerRange<R>[]][]
): ReadonlyMap<string, readonly LayerRange<R>[]> => new Map(pairs);

describe("HighlightLayers（増分6 §C2 / D67）", () => {
  it("スポットライトは窓ごとに置き換わる: A の次に B を貼ると A は消える", () => {
    const layers = new HighlightLayers<R>();
    expect(layers.setSpotlight(map(["file:///a", [item(1)]]))).toEqual(["file:///a"]);
    expect(layers.uris()).toEqual(["file:///a"]);

    // 返るのは貼り直しが要る uri: 消える A と、新しく貼る B の両方。
    // A を返さないと、画家が A の装飾を剥がしに行かない。
    const touched = layers.setSpotlight(map(["file:///b", [item(2)]]));
    expect([...touched].sort()).toEqual(["file:///a", "file:///b"]);
    expect(layers.uris()).toEqual(["file:///b"]);
    expect(layers.forUri("file:///a")).toEqual([]);
    expect(layers.forUri("file:///b")).toEqual([item(2)]);
  });

  it("空の窓を渡すと前回の分が全部消える（解決できなかった show_code も窓を置き換える）", () => {
    const layers = new HighlightLayers<R>();
    layers.setSpotlight(map(["file:///a", [item(1)]], ["file:///b", [item(2)]]));
    expect([...layers.setSpotlight(map())].sort()).toEqual(["file:///a", "file:///b"]);
    expect(layers.uris()).toEqual([]);
  });

  it("clearSpotlight は貼っていた uri を返し、スポットライトだけを空にする", () => {
    const layers = new HighlightLayers<R>();
    layers.setSpotlight(map(["file:///a", [item(1)]]));
    layers.setAnnotation("k1", "file:///b", item(3, "red"));
    expect(layers.clearSpotlight()).toEqual(["file:///a"]);
    expect(layers.uris()).toEqual(["file:///b"]);
    // 何も無いときは何も触らない。
    expect(layers.clearSpotlight()).toEqual([]);
  });

  it("注釈の層はスポットライトの置き換えで消えない（D66: 注釈の塗りは注釈の寿命）", () => {
    const layers = new HighlightLayers<R>();
    layers.setAnnotation("k1", "file:///a", item(5, "red"));
    layers.setSpotlight(map(["file:///b", [item(1)]]));
    layers.setSpotlight(map(["file:///c", [item(1)]]));
    expect(layers.forUri("file:///a")).toEqual([item(5, "red")]);
    expect([...layers.uris()].sort()).toEqual(["file:///a", "file:///c"]);
  });

  it("スポットライトは注釈の抹消で消えない", () => {
    const layers = new HighlightLayers<R>();
    layers.setSpotlight(map(["file:///a", [item(1)]]));
    layers.setAnnotation("k1", "file:///b", item(2, "red"));
    expect(layers.removeAnnotation("k1")).toEqual(["file:///b"]);
    expect(layers.forUri("file:///a")).toEqual([item(1)]);
    expect(layers.uris()).toEqual(["file:///a"]);
  });

  it("同じ uri に両層があるとき forUri は両方を返す（互いを消さない。spotlight が先）", () => {
    const layers = new HighlightLayers<R>();
    layers.setAnnotation("k1", "file:///a", item(7, "red"));
    layers.setSpotlight(map(["file:///a", [item(7, "yellow")]]));
    expect(layers.forUri("file:///a")).toEqual([item(7, "yellow"), item(7, "red")]);
    // どちらを貼り直しても他方は残る。
    layers.setSpotlight(map(["file:///a", [item(8)]]));
    expect(layers.forUri("file:///a")).toEqual([item(8), item(7, "red")]);
    layers.setAnnotation("k2", "file:///a", item(9, "blue"));
    expect(layers.forUri("file:///a")).toEqual([item(8), item(7, "red"), item(9, "blue")]);
    // 1つの uri は1回だけ数える。
    expect(layers.uris()).toEqual(["file:///a"]);
  });

  it("知らない key の removeAnnotation は何も触らない", () => {
    const layers = new HighlightLayers<R>();
    expect(layers.removeAnnotation("nope")).toEqual([]);
    layers.setAnnotation("k1", "file:///a", item(1, "red"));
    expect(layers.removeAnnotation("k1")).toEqual(["file:///a"]);
    expect(layers.uris()).toEqual([]);
    expect(layers.removeAnnotation("k1")).toEqual([]);
  });

  it("同じ key の再登録は置き換え（前の uri も貼り直しの対象に入る）", () => {
    const layers = new HighlightLayers<R>();
    layers.setAnnotation("k1", "file:///a", item(1, "red"));
    const touched = layers.setAnnotation("k1", "file:///b", item(2, "red"));
    expect([...touched].sort()).toEqual(["file:///a", "file:///b"]);
    expect(layers.uris()).toEqual(["file:///b"]);
    expect(layers.forUri("file:///a")).toEqual([]);
    expect(layers.forUri("file:///b")).toEqual([item(2, "red")]);
    // 同じ uri での置き換えは uri を重複させない。
    layers.setAnnotation("k1", "file:///b", item(3, "red"));
    expect(layers.uris()).toEqual(["file:///b"]);
    expect(layers.forUri("file:///b")).toEqual([item(3, "red")]);
  });

  it("clearSpotlight は注釈の項目を残す。注釈は札ごとの抹消でだけ空になる（D66）", () => {
    const layers = new HighlightLayers<R>();
    layers.setSpotlight(map(["file:///a", [item(1)]]));
    layers.setAnnotation("k1", "file:///a", item(2, "red"));
    layers.setAnnotation("k2", "file:///b", item(3, "green"));
    expect(layers.clearSpotlight()).toEqual(["file:///a"]);
    expect(layers.entries().map((e) => e.layer)).toEqual(["annotation", "annotation"]);
    expect(layers.removeAnnotation("k1")).toEqual(["file:///a"]);
    expect(layers.removeAnnotation("k2")).toEqual(["file:///b"]);
    expect(layers.uris()).toEqual([]);
    expect(layers.entries()).toEqual([]);
  });

  /**
   * 層に「注釈を全部消す」口は無い。持ち主は注釈ストアで、抹消は札ごと。
   */
  it("層に注釈の全消しの口が無い", () => {
    const layers = new HighlightLayers<R>() as unknown as Record<string, unknown>;
    expect(layers.clearAnnotations).toBeUndefined();
    expect(layers.clearAll).toBeUndefined();
  });

  it("entries は層の名前つきで全部を返す（観測用）", () => {
    const layers = new HighlightLayers<R>();
    layers.setSpotlight(map(["file:///a", [item(1), item(2)]]));
    layers.setAnnotation("k1", "file:///b", item(3, "red"));
    expect(layers.entries()).toEqual([
      { uri: "file:///a", layer: "spotlight", item: item(1) },
      { uri: "file:///a", layer: "spotlight", item: item(2) },
      { uri: "file:///b", layer: "annotation", item: item(3, "red") },
    ]);
  });
});
