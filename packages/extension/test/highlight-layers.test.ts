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

describe("HighlightLayers（注釈の層だけ。増分6 D66 / 増分13 D116）", () => {
  /**
   * 増分13 D116: `show_code` は塗らない。スポットライトの層は消した（死んだ層を残さない）。
   */
  it("スポットライトの層の口が無い（D116）", () => {
    const layers = new HighlightLayers<R>() as unknown as Record<string, unknown>;
    expect(layers.setSpotlight).toBeUndefined();
    expect(layers.clearSpotlight).toBeUndefined();
    // 肯定対照: 注釈の口はある（検査が別の理由で緑になっていない）。
    expect(typeof layers.setAnnotation).toBe("function");
    expect(typeof layers.removeAnnotation).toBe("function");
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

  it("同じ uri に複数の注釈があるとき forUri は全部を登録順に返す", () => {
    const layers = new HighlightLayers<R>();
    layers.setAnnotation("k1", "file:///a", item(7, "red"));
    layers.setAnnotation("k2", "file:///a", item(9, "blue"));
    layers.setAnnotation("k3", "file:///b", item(1, "green"));
    expect(layers.forUri("file:///a")).toEqual([item(7, "red"), item(9, "blue")]);
    // 1つの uri は1回だけ数える。
    expect([...layers.uris()].sort()).toEqual(["file:///a", "file:///b"]);
  });

  it("注釈は札ごとの抹消でだけ空になる（D66）", () => {
    const layers = new HighlightLayers<R>();
    layers.setAnnotation("k1", "file:///a", item(2, "red"));
    layers.setAnnotation("k2", "file:///b", item(3, "green"));
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

  it("entries は全部を返す（観測用）", () => {
    const layers = new HighlightLayers<R>();
    layers.setAnnotation("k1", "file:///a", item(1));
    layers.setAnnotation("k2", "file:///b", item(3, "red"));
    expect(layers.entries()).toEqual([
      { uri: "file:///a", item: item(1) },
      { uri: "file:///b", item: item(3, "red") },
    ]);
  });
});
