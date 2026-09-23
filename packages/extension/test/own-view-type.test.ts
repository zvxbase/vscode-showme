import { MAX_PANEL_SLOT } from "@zvx/vscode-showme-protocol";
import { describe, expect, it } from "vitest";
import { ownViewTypeFor, slotOfViewType } from "../src/own-view-type.js";

/**
 * 所有と枠の対応（`own-view-type.ts`）。**作る側と見分ける側が1つの関数の対**（不変条件14。
 * 増分6.2 D80 で表 `OWN_VIEW_TYPES` から関数の対に変わった ―― 枠の数は人間の設定で、表には
 * 書けない）。
 *
 * VS Code は `viewType` に `mainThreadWebview-` を前置する（実測。統合テストが固定している）。
 * 見分ける側は「素の値か、接頭辞つきの値か」の**2つの完全一致**で照合する。ここで固定するのは:
 *
 * - 枠2の `showme.view.2` が枠1の `showme.view` に**当たらない**こと
 *   （当たると2枚とも枠1になり、`move-panel { slot: 2 }` が枠1を動かす）
 * - 別の拡張が名乗れる `evil-showme.view`（観測値は `mainThreadWebview-evil-showme.view` で、
 *   以前の接尾辞照合 `endsWith("-showme.view")` には**当たっていた**）や `evil.showme.view` は、
 *   どの枠にも**ならない**（所有でない）
 * - 整数でない綴り（`showme.view.03` / `showme.view.0` / `showme.view.3x`）は所有でない
 */
describe("ownViewTypeFor / slotOfViewType", () => {
  it("枠1は showme.view、枠 N（≥2）は showme.view.N", () => {
    expect(ownViewTypeFor(1)).toBe("showme.view");
    expect(ownViewTypeFor(2)).toBe("showme.view.2");
    expect(ownViewTypeFor(3)).toBe("showme.view.3");
    expect(ownViewTypeFor(10)).toBe("showme.view.10");
    expect(ownViewTypeFor(MAX_PANEL_SLOT)).toBe("showme.view.999");
    expect(ownViewTypeFor(1)).not.toBe(ownViewTypeFor(2));
  });

  it("1〜999 の全部が往復する（素の値も、VS Code の接頭辞つきも）", () => {
    const seen = new Set<string>();
    for (let slot = 1; slot <= MAX_PANEL_SLOT; slot++) {
      const viewType = ownViewTypeFor(slot);
      // 枠ごとに異なる（2枠が同じ viewType になると、同じタブが2枠に見える）。
      expect(seen.has(viewType), viewType).toBe(false);
      seen.add(viewType);
      expect(slotOfViewType(viewType), viewType).toBe(slot);
      expect(slotOfViewType(`mainThreadWebview-${viewType}`), viewType).toBe(slot);
    }
  });

  it("VS Code の接頭辞つき showme.view.2 は枠2であって枠1ではない（接尾辞照合の誤爆を固定）", () => {
    // これが 1 になると、2枚とも「枠1」に見える。
    expect(slotOfViewType("mainThreadWebview-showme.view.2")).toBe(2);
    expect(slotOfViewType("mainThreadWebview-showme.view.2")).not.toBe(1);
    expect(slotOfViewType("mainThreadWebview-showme.view.3")).toBe(3);
    // 対照: 接頭辞つき枠1は枠1。
    expect(slotOfViewType("mainThreadWebview-showme.view")).toBe(1);
  });

  it("区切りの無い接尾辞・別の区切り・整数でない綴り・絶対上限越えは所有でない", () => {
    for (const impostor of [
      "evil-showme.view",
      "mainThreadWebview-evil-showme.view",
      "evil.showme.view",
      "mainThreadWebview-evil.showme.view",
      "evilshowme.view",
      "evil-showme.view.2",
      "evil-showme.view.3",
      "mainThreadWebview-evil-showme.view.3",
      "showme.view.",
      "showme.view2",
      "showme.views",
      // 整数でない綴り。`showme.view.03` を 3 に読むと、同じ枠に2つの viewType ができる。
      "showme.view.0",
      "showme.view.03",
      "showme.view.3x",
      "showme.view.1.2",
      "showme.view.-1",
      "showme.view.+1",
      "showme.view.1e2",
      "showme.view. 3",
      "showme.view.3 ",
      "mainThreadWebview-showme.view.03",
      "mainThreadWebview-showme.view.0",
      // 枠1の綴りに番号を付けた `showme.view.1` は無い（枠1は `showme.view` だけ。2つの綴りが
      // 同じ枠を指すと「同じ量を2つの表現で持つ」になる）。
      "showme.view.1",
      "mainThreadWebview-showme.view.1",
      // 線の絶対上限（999）を越える番号は所有でない（スキーマも落とす。同じ1つの値）。
      `showme.view.${MAX_PANEL_SLOT + 1}`,
      `mainThreadWebview-showme.view.${MAX_PANEL_SLOT + 1}`,
      "showme.view.99999999999999999999",
      // 接頭辞は完全一致（`mainThreadWebview-` だけ。別の接頭辞や2重の接頭辞は所有でない）。
      "xmainThreadWebview-showme.view",
      "mainThreadWebview-mainThreadWebview-showme.view",
      "mainThreadWebview-",
      "",
    ]) {
      expect(slotOfViewType(impostor), impostor).toBeUndefined();
    }
  });
});
