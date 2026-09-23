import { VIEW_ACTIONS, viewActionNeedsPath } from "@zvx/vscode-showme-protocol";
import { describe, expect, it } from "vitest";
import { ToolError } from "../tool-error.js";
import { type ViewSurface, handleShowView } from "./show-view.js";

const log = { info: () => {} };

function fakeView() {
  const calls: string[] = [];
  const surface: ViewSurface = {
    async revealInExplorer(relPath) {
      calls.push(`reveal:${relPath}`);
      return true;
    },
    async perform(action) {
      calls.push(action);
      return true;
    },
  };
  return { calls, surface };
}

describe("show_view", () => {
  it("閉じた語彙の操作がそれぞれの面に届く", async () => {
    const view = fakeView();
    for (const action of ["show-explorer", "hide-sidebar", "hide-panel"] as const) {
      const result = await handleShowView({ action }, { view: view.surface, log });
      expect(result.done).toBe(true);
    }
    expect(view.calls).toEqual(["show-explorer", "hide-sidebar", "hide-panel"]);
  });

  it("語彙のすべての操作が面に届く（足し忘れが黙って何もしないのを防ぐ）", async () => {
    // **語彙を一覧から回す。** 手で並べると、足した操作を書き忘れたときに
    // 「その操作は何もしない」が緑のまま通る ―― この repo が4回踏んだ形である。
    const withoutPath = VIEW_ACTIONS.filter((a) => !viewActionNeedsPath(a));
    // 0件でも「全部届いた」は真になるので、食わせた件数を主張する。
    expect(withoutPath.length).toBeGreaterThanOrEqual(10);
    const view = fakeView();
    for (const action of withoutPath) {
      const result = await handleShowView({ action }, { view: view.surface, log });
      expect(result.done, `${action} が面に届いていない`).toBe(true);
    }
    expect(view.calls).toEqual([...withoutPath]);
  });

  it("reveal-in-explorer は path を要る", async () => {
    const view = fakeView();
    await expect(
      handleShowView({ action: "reveal-in-explorer" }, { view: view.surface, log }),
    ).rejects.toBeInstanceOf(ToolError);
    expect(view.calls).toEqual([]);
  });

  it("パスは面にそのまま渡る（判断は面が持つ）", async () => {
    // **ハンドラは何も決めない。** 以前はここで綴りの正規化だけを当てていて、
    // realpath も除外判定も無かった ―― それで `.env` をツリーに出せた
    // （`workspace-path-gate.ts` の説明を読むこと）。
    const view = fakeView();
    await handleShowView(
      { action: "reveal-in-explorer", path: "./src/a.ts" },
      { view: view.surface, log },
    );
    expect(view.calls).toEqual(["reveal:./src/a.ts"]);
  });

  it("面が断ったら done: false（例外にしない）", async () => {
    // **外にある / 除外 / コマンドが失敗した、が全部同じ答えになる。**
    // 分けると、そこからワークスペースの形を読める（S1 と同じ形）。
    const view = fakeView();
    const result = await handleShowView(
      { action: "reveal-in-explorer", path: "../secret" },
      { view: { ...view.surface, revealInExplorer: async () => false }, log },
    );
    expect(result).toEqual({ done: false });
  });

  it("失敗しても理由は返さない（画面の状態を教えない）", async () => {
    const view = fakeView();
    const result = await handleShowView(
      { action: "hide-panel" },
      {
        view: { ...view.surface, perform: async () => false },
        log,
      },
    );
    expect(result).toEqual({ done: false });
    // 「なぜ」を運ぶ欄が無い。あると人間の画面の状態を問い合わせる口になる。
    expect(Object.keys(result)).toEqual(["done"]);
  });

  it("回数制限を超えたら何もしない", async () => {
    const view = fakeView();
    await expect(
      handleShowView({ action: "hide-panel" }, { view: view.surface, log, allowCall: () => false }),
    ).rejects.toBeInstanceOf(ToolError);
    expect(view.calls).toEqual([]);
  });
});
