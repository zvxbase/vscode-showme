import { describe, expect, it, vi } from "vitest";
import {
  type PanelSource,
  type RecreateOps,
  panelPlacement,
  recreatePanel,
} from "./panel-recreate.js";

/**
 * `move-panel` の「作り直す」の順序と、何を描き直すか。
 *
 * `panel.ts` は `vscode` を値として読むので単体では検査できない。順序と正の選び方だけを
 * ここに切り出し、偽の手で**呼ばれた順**を固定する。実機での確認は
 * `test/integration/suite/panel-slots.test.ts`。
 */

function fakeOps() {
  const calls: string[] = [];
  const ops: RecreateOps = {
    create: vi.fn(() => {
      calls.push("create");
    }),
    disposeOld: vi.fn(() => {
      calls.push("disposeOld");
    }),
    post: vi.fn(async (sanitized: string) => {
      calls.push(`post:${sanitized}`);
    }),
  };
  return { calls, ops };
}

describe("recreatePanel（move-panel は破棄して作り直す）", () => {
  it("html 由来: 覚えていたサニタイズ済み HTML を、新しいパネルに**そのまま**入れる", async () => {
    const { calls, ops } = fakeOps();
    const source: PanelSource = { kind: "html", sanitized: "<p>覚えていた図</p>" };
    await recreatePanel(source, ops);
    expect(calls).toEqual(["create", "disposeOld", "post:<p>覚えていた図</p>"]);
  });

  it("path 由来: 覚えている HTML は使わず、閉包（関門＋サニタイザ）で読み直す", async () => {
    const { calls, ops } = fakeOps();
    const rerender = vi.fn(async () => {
      calls.push("rerender");
    });
    await recreatePanel({ kind: "path", rerender }, ops);
    expect(calls).toEqual(["create", "disposeOld", "rerender"]);
    expect(ops.post).not.toHaveBeenCalled();
  });

  it("**作ってから破棄する**（D59 のテキストタブと同じ「開いてから閉じる」）", async () => {
    // 逆順（破棄してから作る）だと、古い列が空になって VS Code が閉じ、列が繰り上がった
    // あとに元の番号で作ることになる ―― 番号が既存の列数を超えていれば、途中の列まで
    // **空のまま**作られる（`columnToEditorGroup` は足りない列を順に足す）。
    const { calls, ops } = fakeOps();
    await recreatePanel({ kind: "html", sanitized: "x" }, ops);
    expect(calls.indexOf("create")).toBeLessThan(calls.indexOf("disposeOld"));
  });

  it("正が無ければ（出したことが無い）作って破棄するだけで、何も入れない", async () => {
    const { calls, ops } = fakeOps();
    await recreatePanel(undefined, ops);
    expect(calls).toEqual(["create", "disposeOld"]);
  });

  it("描き直しの失敗は握らない（呼び手が `done: false` に畳む）", async () => {
    const { ops } = fakeOps();
    const rerender = vi.fn(async () => {
      throw new Error("読めない");
    });
    await expect(recreatePanel({ kind: "path", rerender }, ops)).rejects.toThrow("読めない");
    // それでも作る・破棄するは済んでいる（移動そのものは起きた）。
    expect(ops.create).toHaveBeenCalledTimes(1);
    expect(ops.disposeOld).toHaveBeenCalledTimes(1);
  });
});

describe("panelPlacement（枠の既定の置き場）", () => {
  it("枠1は舞台の1列目、枠2は舞台の2列目（人間の「並べる」は横並び）", () => {
    expect(panelPlacement(1)).toEqual({ layout: "single", slot: 0 });
    expect(panelPlacement(2)).toEqual({ layout: "split", slot: 1 });
  });
});
