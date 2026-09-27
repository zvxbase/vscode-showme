import { describe, expect, it } from "vitest";
import { MIN_MS_SINCE_OWN_TOOL_CALL, selectionKey } from "../src/human-selection.js";
import {
  TOOL_MAY_CHANGE_FRONT_EDITOR,
  TOOL_SHOWN_SELECTION_LIMIT,
  ToolCallWindow,
  ToolShownSelection,
  frontEditorRecord,
  frontIdentity,
  frontSettled,
  toolShownSelectionKey,
} from "../src/tool-shown-selection.js";

/**
 * ツールが見せた選択（D95）。ツールの呼び出しで人間の前面の編集器が別の編集器に変わったら、
 * その編集器のその時点の選択（使い回し・表示状態の復元で戻った選択を含む）を覚える。人間が
 * 選び直すまで返さない。
 */
describe("ToolShownSelection（パスごと・件数に上限。D95）", () => {
  const range = (end: number) => ({
    startLine: 3,
    startCharacter: 1,
    endLine: 3,
    endCharacter: end,
  });
  const key = (rel: string, end = 9) => selectionKey(rel, range(end));

  it("何も覚えていなければ、どの鍵にも当たらない", () => {
    expect(new ToolShownSelection().matches("src/a.ts", key("src/a.ts"))).toBe(false);
  });

  it("覚えた鍵に当たり、人間が選び直した（鍵が変わった）ら当たらない", () => {
    const shown = new ToolShownSelection();
    shown.remember("src/a.ts", key("src/a.ts"));
    expect(shown.matches("src/a.ts", key("src/a.ts"))).toBe(true);
    expect(shown.matches("src/a.ts", key("src/a.ts", 8))).toBe(false);
  });

  it("同じパスでは直前の1つだけ（選び直した先を新しく見せられたら、そちらに置き換わる）", () => {
    const shown = new ToolShownSelection();
    shown.remember("src/a.ts", key("src/a.ts"));
    shown.remember("src/a.ts", key("src/a.ts", 8));
    expect(shown.matches("src/a.ts", key("src/a.ts"))).toBe(false);
    expect(shown.matches("src/a.ts", key("src/a.ts", 8))).toBe(true);
  });

  it("Y を見せてから Z を見せても、Y の記録は消えない（人間がクリックで Y に戻っても古い選択は返らない）", () => {
    const shown = new ToolShownSelection();
    shown.remember("src/y.ts", key("src/y.ts"));
    shown.remember("src/z.ts", key("src/z.ts"));
    expect(shown.matches("src/y.ts", key("src/y.ts"))).toBe(true);
    expect(shown.matches("src/z.ts", key("src/z.ts"))).toBe(true);
    // 人間が Y で選び直せば返る。
    expect(shown.matches("src/y.ts", key("src/y.ts", 5))).toBe(false);
  });

  it(`件数は ${TOOL_SHOWN_SELECTION_LIMIT} まで。溢れたら最も古く使われたパスから忘れる`, () => {
    const shown = new ToolShownSelection();
    for (let i = 0; i < TOOL_SHOWN_SELECTION_LIMIT; i += 1) shown.remember(`f${i}`, key(`f${i}`));
    // f0 を新しく覚え直す（最近使った側に移る）。
    shown.remember("f0", key("f0"));
    shown.remember("extra", key("extra"));
    expect(shown.size()).toBe(TOOL_SHOWN_SELECTION_LIMIT);
    expect(shown.matches("f1", key("f1"))).toBe(false);
    expect(shown.matches("f0", key("f0"))).toBe(true);
    expect(shown.matches("extra", key("extra"))).toBe(true);
  });
});

describe("ToolCallWindow（窓。D95）", () => {
  it("呼び出しが無ければ窓の外（経過は無限大）", () => {
    const w = new ToolCallWindow();
    expect(w.msSince(1_000)).toBe(Number.POSITIVE_INFINITY);
    expect(w.inWindow(1_000)).toBe(false);
  });

  it("呼び出しの最中は窓の中（経過 0）", () => {
    const w = new ToolCallWindow();
    w.begin(100);
    expect(w.msSince(5_000)).toBe(0);
    expect(w.inWindow(5_000)).toBe(true);
  });

  it(`終わってから ${MIN_MS_SINCE_OWN_TOOL_CALL} ms 未満は窓の中、ちょうど経てば外`, () => {
    const w = new ToolCallWindow();
    w.begin(0);
    w.end(100);
    expect(w.inWindow(100 + MIN_MS_SINCE_OWN_TOOL_CALL - 1)).toBe(true);
    expect(w.inWindow(100 + MIN_MS_SINCE_OWN_TOOL_CALL)).toBe(false);
    expect(w.msSince(350)).toBe(250);
  });

  it("重なった呼び出し: 片方が終わっても、もう片方が走っている間は窓の中", () => {
    const w = new ToolCallWindow();
    w.begin(0);
    w.begin(10);
    w.end(20);
    expect(w.inWindow(20 + MIN_MS_SINCE_OWN_TOOL_CALL * 5)).toBe(true);
    w.end(30);
    expect(w.msSince(40)).toBe(10);
  });

  it("終わりが始まりより多く来ても負の件数にしない（窓を閉じたままにしない・開きっぱなしにもしない）", () => {
    const w = new ToolCallWindow();
    w.end(0);
    w.begin(10);
    expect(w.inWindow(10_000)).toBe(true);
    w.end(20);
    expect(w.inWindow(20 + MIN_MS_SINCE_OWN_TOOL_CALL)).toBe(false);
  });

  it("窓の間に前面に出た編集器を覚え、窓の間だけ「前面に出たもの」と答える", () => {
    const w = new ToolCallWindow();
    w.begin(0);
    w.markFronted("1 file:///y");
    expect(w.wasFronted("1 file:///y", 10)).toBe(true);
    expect(w.wasFronted("1 file:///z", 10)).toBe(false);
    w.end(100);
    expect(w.wasFronted("1 file:///y", 100 + MIN_MS_SINCE_OWN_TOOL_CALL - 1)).toBe(true);
    expect(w.wasFronted("1 file:///y", 100 + MIN_MS_SINCE_OWN_TOOL_CALL)).toBe(false);
  });

  it("窓が閉じてから新しく始まった窓は、前の窓で前面に出たものを持ち越さない", () => {
    const w = new ToolCallWindow();
    w.begin(0);
    w.markFronted("1 file:///y");
    w.end(10);
    w.begin(10 + MIN_MS_SINCE_OWN_TOOL_CALL);
    expect(w.wasFronted("1 file:///y", 10 + MIN_MS_SINCE_OWN_TOOL_CALL)).toBe(false);
  });

  it("窓が開いている間に次の呼び出しが始まれば、前面に出たものは続けて覚えている", () => {
    const w = new ToolCallWindow();
    w.begin(0);
    w.markFronted("1 file:///y");
    w.end(10);
    w.begin(20);
    expect(w.wasFronted("1 file:///y", 30)).toBe(true);
  });

  it("呼び出しが終わった後（窓の尾）に前に出たものは覚えない（人間がクリックで移った先）", () => {
    const w = new ToolCallWindow();
    w.begin(0);
    w.end(10);
    w.markFronted("1 file:///y");
    expect(w.inWindow(20)).toBe(true);
    expect(w.wasFronted("1 file:///y", 20)).toBe(false);
  });

  it("窓の外で覚えさせても覚えない（人間の操作）", () => {
    const w = new ToolCallWindow();
    w.markFronted("1 file:///y");
    w.begin(0);
    expect(w.wasFronted("1 file:///y", 0)).toBe(false);
  });

  it("時計が巻き戻っても負を返さない", () => {
    const w = new ToolCallWindow();
    w.begin(0);
    w.end(1_000);
    expect(w.msSince(500)).toBe(0);
  });
});

describe("toolShownSelectionKey（D95）", () => {
  const range = { startLine: 3, startCharacter: 1, endLine: 3, endCharacter: 9 };
  const front = (identity: string, relPath: string | undefined) => ({
    identity,
    relPath,
    selection: range,
  });

  it("前面の編集器が変わらなければ何も覚えない（「これ何？」の流れを壊さない）", () => {
    expect(
      toolShownSelectionKey(front("1 file:///a", "src/a.ts"), front("1 file:///a", "src/a.ts")),
    ).toBeUndefined();
  });

  it("前面の編集器が別の文書に変われば、後の編集器の選択の鍵を返す", () => {
    expect(
      toolShownSelectionKey(front("1 file:///h", "src/a.ts"), front("1 file:///a", "src/a.ts")),
    ).toEqual({ relPath: "src/a.ts", key: selectionKey("src/a.ts", range) });
  });

  it("同じ文書でも列が変われば、別の編集器として覚える", () => {
    expect(
      toolShownSelectionKey(front("1 file:///a", "src/a.ts"), front("2 file:///a", "src/a.ts")),
    ).toEqual({ relPath: "src/a.ts", key: selectionKey("src/a.ts", range) });
  });

  it("前に前面の編集器が無く、後にあれば覚える", () => {
    expect(toolShownSelectionKey(undefined, front("1 file:///a", "src/a.ts"))).toEqual({
      relPath: "src/a.ts",
      key: selectionKey("src/a.ts", range),
    });
  });

  it("後に前面の編集器が無い・相対パスが無い（ワークスペース外）なら何も覚えない", () => {
    expect(toolShownSelectionKey(front("1 file:///a", "src/a.ts"), undefined)).toBeUndefined();
    expect(
      toolShownSelectionKey(front("1 file:///h", "src/a.ts"), front("1 file:///x", undefined)),
    ).toBeUndefined();
  });
});

describe("TOOL_MAY_CHANGE_FRONT_EDITOR（D95 の記録点）", () => {
  it("画面の編集器を動かしうるツールは記録する", () => {
    for (const tool of [
      "show_code",
      "annotate",
      "show_note",
      "show_html",
      "show_view",
      "arrange_editors",
    ] as const) {
      expect(TOOL_MAY_CHANGE_FRONT_EDITOR[tool], tool).toBe(true);
    }
  });

  it("読むだけのツールは記録しない（人間が呼び出しの最中に自分で移った先を、ツールが見せたものにしない）", () => {
    for (const tool of [
      "get_editor_state",
      "list_workspaces",
      "find_definition",
      "find_references",
    ] as const) {
      expect(TOOL_MAY_CHANGE_FRONT_EDITOR[tool], tool).toBe(false);
    }
  });
});

describe("TOOL_SHOWN_SELECTION_LIMIT", () => {
  it("256 件（パスごとの記録の費用は小さい。溢れて古い記録が消える方が危ない）", () => {
    expect(TOOL_SHOWN_SELECTION_LIMIT).toBe(256);
  });
});

describe("frontSettled（前面が落ち着いたか。D95）", () => {
  const range = { startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 0 };
  const front = (column: number, uri: string) => ({
    identity: frontIdentity(column, uri),
    relPath: "a.ts",
    selection: range,
  });

  it("前面の編集器が、人間の列の表示中のテキストタブと同じ URI・同じ列なら落ち着いている", () => {
    expect(frontSettled(front(1, "file:///a"), { column: 1, textUri: "file:///a" })).toBe(true);
  });
  it("前面の編集器が古い（表示中のタブと違う文書）なら落ち着いていない", () => {
    expect(frontSettled(front(1, "file:///z"), { column: 1, textUri: "file:///a" })).toBe(false);
  });
  it("列が違えば落ち着いていない", () => {
    expect(frontSettled(front(2, "file:///a"), { column: 1, textUri: "file:///a" })).toBe(false);
  });
  it("表示中のタブがテキストでない（パネル・端末）なら、前面の編集器が無いときだけ落ち着いている", () => {
    expect(frontSettled(undefined, { column: 1, textUri: undefined })).toBe(true);
    expect(frontSettled(front(1, "file:///a"), { column: 1, textUri: undefined })).toBe(false);
  });
  it("表示中のタブがテキストなのに前面の編集器が無ければ落ち着いていない", () => {
    expect(frontSettled(undefined, { column: 1, textUri: "file:///a" })).toBe(false);
  });
});

describe("ToolCallWindow: 落ち着かないまま終わった呼び出しの後の、最初の前面の変化（D95）", () => {
  it("遅れて来ると言われていれば、窓の尾の最初の変化だけをツールの仕業にし、前に出たものとして覚える", () => {
    const w = new ToolCallWindow();
    w.begin(0);
    w.expectLateFront();
    w.end(10);
    expect(w.frontChanged("1 file:///y", 20)).toBe(true);
    expect(w.wasFronted("1 file:///y", 30)).toBe(true);
    // 2つ目の変化は人間のもの。
    expect(w.frontChanged("1 file:///x", 40)).toBe(false);
    expect(w.wasFronted("1 file:///x", 50)).toBe(false);
  });
  it("言われていなければ、窓の尾の変化は人間のもの", () => {
    const w = new ToolCallWindow();
    w.begin(0);
    w.end(10);
    expect(w.frontChanged("1 file:///y", 20)).toBe(false);
  });
  it("呼び出しの最中の変化はいつもツールの仕業", () => {
    const w = new ToolCallWindow();
    w.begin(0);
    expect(w.frontChanged("1 file:///y", 5)).toBe(true);
    expect(w.frontChanged("1 file:///z", 6)).toBe(true);
  });
  it("窓が閉じた後に来た変化は、遅れて来ると言われていても人間のもの（窓の外）", () => {
    const w = new ToolCallWindow();
    w.begin(0);
    w.expectLateFront();
    w.end(10);
    expect(w.frontChanged("1 file:///y", 10 + MIN_MS_SINCE_OWN_TOOL_CALL)).toBe(false);
  });
  it("遅れて来るという印は次の窓に持ち越さない", () => {
    const w = new ToolCallWindow();
    w.begin(0);
    w.expectLateFront();
    w.end(10);
    w.begin(10 + MIN_MS_SINCE_OWN_TOOL_CALL);
    w.end(20 + MIN_MS_SINCE_OWN_TOOL_CALL);
    expect(w.frontChanged("1 file:///y", 30 + MIN_MS_SINCE_OWN_TOOL_CALL)).toBe(false);
  });
});

describe("frontEditorRecord（窓の間の前面の変化。D95）", () => {
  const range = { startLine: 3, startCharacter: 1, endLine: 3, endCharacter: 9 };
  it("窓の間に前面になった編集器の選択を覚える", () => {
    expect(
      frontEditorRecord(true, { identity: "1 x", relPath: "src/a.ts", selection: range }),
    ).toEqual({
      relPath: "src/a.ts",
      key: selectionKey("src/a.ts", range),
    });
  });
  it("窓の外の変化（人間の操作）は覚えない", () => {
    expect(
      frontEditorRecord(false, { identity: "1 x", relPath: "src/a.ts", selection: range }),
    ).toBeUndefined();
  });
  it("前面が無い・ワークスペースの外なら覚えない", () => {
    expect(frontEditorRecord(true, undefined)).toBeUndefined();
    expect(
      frontEditorRecord(true, { identity: "1 x", relPath: undefined, selection: range }),
    ).toBeUndefined();
  });
});
