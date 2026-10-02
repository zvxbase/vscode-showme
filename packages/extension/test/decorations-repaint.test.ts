import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * **画家がエディタに何を書いたか**を見る（増分6 §C2 / D67 のレビュー所見）。
 *
 * `highlightedUris()` / `highlightRanges()` は層（`HighlightLayers`）を読むだけなので、
 * 「消えた uri を貼り直し忘れる」変異（登録し直しで新しい uri だけを貼り直す）は
 * 単体・統合とも全部緑のまま通る ―― 観測面が全部、書き手ではなく帳簿を見ていた。
 * ここでは `vscode` を偽物にして、`setDecorations` に**実際に渡った引数**を主張する。
 *
 * 見るのは各エディタの**最後の**呼び出し群である。`apply` は「全型を空にしてから
 * 貼る」ので、貼り直しの後に非空の呼び出しがあれば貼られており、全部空なら剥がれている。
 */

interface FakeEditor {
  document: { uri: { toString(): string } };
  setDecorations: ReturnType<typeof vi.fn>;
}

// `vi.mock` は import と一緒に先頭へ巻き上がるので、偽物が参照する値も巻き上げる。
const editors = vi.hoisted(() => {
  const editorFor = (uri: string): FakeEditor => ({
    document: { uri: { toString: () => uri } },
    setDecorations: vi.fn(),
  });
  return {
    a: editorFor("file:///a"),
    b: editorFor("file:///b"),
    /** 登録の時点では**見えていない**ファイル。人間が後から開く（D76）。 */
    c: editorFor("file:///c"),
    editorFor,
    /** 画家が `onDidChangeVisibleTextEditors` に登録した聞き手（人間が開いたことを伝える口）。 */
    visibilityListeners: [] as ((editors: FakeEditor[]) => void)[],
  };
});

/** 画家が装飾の型に渡した options。色相が固定されているか（D78）を見るためだけ。 */
const decorationOptions = vi.hoisted(() => [] as Record<string, unknown>[]);

vi.mock("vscode", () => ({
  window: {
    visibleTextEditors: [editors.a, editors.b],
    createTextEditorDecorationType: vi.fn((options: Record<string, unknown>) => {
      decorationOptions.push(options);
      return { dispose: vi.fn() };
    }),
    onDidChangeVisibleTextEditors: vi.fn((listener: (editors: FakeEditor[]) => void) => {
      editors.visibilityListeners.push(listener);
      return { dispose: vi.fn() };
    }),
  },
  // 観測面（`highlightRanges`）が開いている文書を引く。ここでは開いていない。
  workspace: { textDocuments: [] },
  ThemeColor: class {
    constructor(public readonly id: string) {}
  },
  OverviewRulerLane: { Center: 2 },
}));

import {
  HIGHLIGHT_BORDER_RGBA,
  HIGHLIGHT_COLORS,
  HIGHLIGHT_RGBA,
} from "@zvx/vscode-showme-protocol";
import * as vscode from "vscode";
import { type HighlightRange, Highlights } from "../src/decorations.js";

/** 範囲の中身は画家が読まないので、形だけそろえた素の値でよい。 */
const range = (line: number, color: HighlightRange["color"] = "yellow"): HighlightRange =>
  ({
    range: { start: { line, character: 0 }, end: { line, character: 5 } },
    wholeLine: true,
    color,
  }) as unknown as HighlightRange;

/** 直近の `setDecorations` の引数列。`marker` 以降だけを見る。 */
const callsSince = (editor: FakeEditor, marker: number): unknown[][] =>
  editor.setDecorations.mock.calls.slice(marker).map((call) => call[1] as unknown[]);

const painted = (editor: FakeEditor, marker: number): boolean =>
  callsSince(editor, marker).some((ranges) => ranges.length > 0);

const cleared = (editor: FakeEditor, marker: number): boolean => {
  const calls = callsSince(editor, marker);
  return calls.length > 0 && calls.every((ranges) => ranges.length === 0);
};

const mark = (editor: FakeEditor): number => editor.setDecorations.mock.calls.length;

/** 注釈の札で登録するときの uri（画家は `toString()` だけを読む）。 */
const uri = (value: string) => ({ toString: () => value }) as never;

describe("Highlights は層が「触れ」と言った uri のエディタに実際に書く", () => {
  beforeEach(() => {
    editors.a.setDecorations.mockClear();
    editors.b.setDecorations.mockClear();
  });

  /**
   * 増分13 D116: `show_code` は塗らない。画家の層は注釈だけで、スポットライトの口は無い。
   */
  it("画家にスポットライトの口が無い（D116）", () => {
    const h = new Highlights() as unknown as Record<string, unknown>;
    expect(h.setSpotlight).toBeUndefined();
    expect(h.clearSpotlight).toBeUndefined();
    // 肯定対照: 注釈の口はある。
    expect(typeof h.setAnnotation).toBe("function");
  });

  it("見えていない uri の塗りは登録だけされ、人間が開いたときに貼られる（増分6 D76）", () => {
    // 開かれていないファイルへの注釈は登録だけする。塗りが人間の画面に出るのは
    // **人間が開いたとき**で、その口は `onDidChangeVisibleTextEditors` である。
    // 観測面（`highlightRanges`）は帳簿を読むだけなので、ここでしか「貼られた」を言えない。
    editors.visibilityListeners.length = 0;
    editors.c.setDecorations.mockClear();
    const h = new Highlights();
    expect(editors.visibilityListeners).toHaveLength(1);

    h.setAnnotation("k1", uri("file:///c"), range(3, "red"));
    // 登録はされているが、見えていないので何も書かない。
    expect(h.highlightedUris()).toEqual(["file:///c"]);
    expect(editors.c.setDecorations).not.toHaveBeenCalled();

    // 人間が開いた（VS Code が可視エディタの変化を伝える）。
    editors.visibilityListeners[0]?.([editors.a, editors.b, editors.c]);
    expect(painted(editors.c, 0)).toBe(true);
  });

  it("setAnnotation は貼る uri のエディタに非空で書く", () => {
    const h = new Highlights();
    h.setAnnotation("k1", uri("file:///a"), range(1, "red"));
    expect(painted(editors.a, 0)).toBe(true);
    // 触れと言われていない B には書かない。
    expect(editors.b.setDecorations).not.toHaveBeenCalled();
  });

  it("同じ札を A から B に登録し直したら、A のエディタは剥がされ B に貼られる", () => {
    const h = new Highlights();
    h.setAnnotation("k1", uri("file:///a"), range(1, "red"));
    const a = mark(editors.a);
    const b = mark(editors.b);
    h.setAnnotation("k1", uri("file:///b"), range(2, "red"));
    // **消えた側も書き直されている**。ここが「新しい uri だけ貼り直す」変異で落ちる。
    expect(cleared(editors.a, a), JSON.stringify(callsSince(editors.a, a))).toBe(true);
    expect(painted(editors.b, b)).toBe(true);
  });

  /**
   * 画家に「注釈を全部消す」口は無い（`clearAnnotations` / `clearAll`）。注釈の層の持ち主は
   * 注釈ストアで、抹消は札ごとの `removeAnnotation` だけ。口が生えると、役割の解除で
   * 画家の全消しだけを呼ぶ経路ができ、吹き出しが塗り無しで残る（不変条件14）。
   */
  it("画家に注釈の全消しの口が無い", () => {
    const h = new Highlights() as unknown as Record<string, unknown>;
    expect(h.clearAnnotations).toBeUndefined();
    expect(h.clearAll).toBeUndefined();
  });

  it("removeAnnotation は注釈のエディタを剥がす", () => {
    const h = new Highlights();
    h.setAnnotation("k1", uri("file:///b"), range(3, "red"));
    expect(painted(editors.b, 0)).toBe(true);
    const b = mark(editors.b);
    h.removeAnnotation("k1");
    expect(cleared(editors.b, b)).toBe(true);
  });

  it("同じ uri に注釈が2つあるとき、1つを札で抹消してももう1つは貼られたまま（§C2）", () => {
    const h = new Highlights();
    h.setAnnotation("k1", uri("file:///a"), range(1, "yellow"));
    h.setAnnotation("k2", uri("file:///a"), range(1, "red"));
    const a = mark(editors.a);
    h.removeAnnotation("k2");
    // 剥がしてから貼り直すので、最後の呼び出し群に非空がある＝k1 が残った。
    expect(painted(editors.a, a)).toBe(true);
    // 残ったのは k1 の型（黄の行全体）だけで、k2 の型（赤）は空になっている。
    // 型は偽物なので色では見分けられない ―― 非空の呼び出しが**1つ**であることで言う。
    expect(callsSince(editors.a, a).filter((ranges) => ranges.length > 0)).toHaveLength(1);
  });

  it("観測面の範囲に層の名前は無い（層は注釈だけ。D116）", () => {
    const h = new Highlights();
    h.setAnnotation("k1", uri("file:///a"), range(1, "red"));
    const [only] = h.highlightRanges();
    expect(only).toMatchObject({ uri: "file:///a", startLine: 1, color: "red", wholeLine: true });
    expect(only).not.toHaveProperty("layer");
  });
});

/**
 * **色相は実装が固定する**（増分6.1 D78）。テーマ色から借りると色相がテーマで変わる
 * （実機: Dark Modern で黄がオレンジ、紫が青緑）。画家が装飾の型に渡した options を
 * 捕まえて、背景・縁・スクロールバーの印の全部が protocol の表の値で、`ThemeColor` が
 * 1つも混ざっていないことを主張する。
 */
describe("装飾の型は rgba で固定され、テーマ色を含まない（D78）", () => {
  beforeEach(() => {
    decorationOptions.length = 0;
    editors.a.setDecorations.mockClear();
  });

  const walk = (value: unknown, into: unknown[]): void => {
    into.push(value);
    if (typeof value === "object" && value !== null) {
      for (const v of Object.values(value as Record<string, unknown>)) walk(v, into);
    }
  };

  it("全6色 × 行全体／文字だけ の型が、light / dark ともに表の値を持つ", () => {
    const h = new Highlights();
    for (const color of HIGHLIGHT_COLORS) {
      h.setAnnotation(`${color}-line`, uri("file:///a"), range(1, color));
      h.setAnnotation(`${color}-inline`, uri("file:///a"), {
        ...range(2, color),
        wholeLine: false,
      } as unknown as HighlightRange);
    }
    // 食わせた件数: 6色 × 2種類。0 件なら下の主張は空で緑になる。
    expect(decorationOptions).toHaveLength(HIGHLIGHT_COLORS.length * 2);

    const found = new Set<string>();
    for (const options of decorationOptions) {
      const light = options.light as Record<string, unknown>;
      const dark = options.dark as Record<string, unknown>;
      const color = HIGHLIGHT_COLORS.find((c) => HIGHLIGHT_RGBA[c].light === light.backgroundColor);
      expect(
        color,
        `表に無い light.backgroundColor: ${String(light.backgroundColor)}`,
      ).toBeDefined();
      if (color === undefined) continue;
      found.add(`${color}:${String(options.isWholeLine)}`);
      expect(light).toMatchObject({
        backgroundColor: HIGHLIGHT_RGBA[color].light,
        borderColor: HIGHLIGHT_BORDER_RGBA[color].light,
        overviewRulerColor: HIGHLIGHT_RGBA[color].light,
      });
      expect(dark).toMatchObject({
        backgroundColor: HIGHLIGHT_RGBA[color].dark,
        borderColor: HIGHLIGHT_BORDER_RGBA[color].dark,
        overviewRulerColor: HIGHLIGHT_RGBA[color].dark,
      });
      // テーマに関わらない属性はトップレベル。背景・縁の色はトップレベルに**置かない**
      // （light / dark がトップレベルを上書きするので効きはしないが、色を決める場所が
      // 2つになる ―― 同じ量を2箇所で決めない。不変条件14）。
      expect(options).toMatchObject({ borderStyle: "solid", borderWidth: "1px" });
      expect(options).not.toHaveProperty("backgroundColor");
      expect(options).not.toHaveProperty("borderColor");
      expect(options).not.toHaveProperty("overviewRulerColor");
    }
    expect([...found].sort()).toEqual(
      HIGHLIGHT_COLORS.flatMap((c) => [`${c}:true`, `${c}:false`]).sort(),
    );
  });

  it("options のどこにも ThemeColor が無い", () => {
    const h = new Highlights();
    h.setAnnotation("k1", uri("file:///a"), range(1, "yellow"));
    expect(decorationOptions.length).toBeGreaterThan(0);
    for (const options of decorationOptions) {
      const values: unknown[] = [];
      walk(options, values);
      for (const v of values) expect(v).not.toBeInstanceOf(vscode.ThemeColor);
    }
  });
});
