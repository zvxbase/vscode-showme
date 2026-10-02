import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * **`text` で指した注釈の列は、塗る直前に VS Code の文書の行で決め直す**。
 *
 * 解決（`resolveLocation`）はディスクの読みで一致を探すが、人間が見るのは VS Code の文書である
 * （BOM なし・`realFile` の未保存の編集込み・読んだ後の編集込み）。ディスクの列をそのまま塗ると、
 * 文書が違えば別の文字に落ちる。画家は塗る直前に文書のその行で一致を数え、ちょうど1回なら
 * その列、0回か2回以上なら行全体を塗る。「1回なら列、それ以外は行全体」を決めるのは解決と同じ
 * protocol の `columnsOfUniqueMatch` 1つ。
 *
 * `vscode` を偽物にして、`setDecorations` に**実際に渡った引数**（範囲と、型に焼かれた
 * `isWholeLine`）を見る（`decorations-repaint.test.ts` と同じ理由: 帳簿ではなく書き手を見る）。
 */

interface FakeDocument {
  uri: { toString(): string };
  lines: string[];
  readonly lineCount: number;
  lineAt(line: number): { text: string };
}

interface FakeEditor {
  document: FakeDocument;
  setDecorations: ReturnType<typeof vi.fn>;
}

const fake = vi.hoisted(() => {
  const documentFor = (uri: string, lines: string[]): FakeDocument => ({
    uri: { toString: () => uri },
    lines,
    get lineCount() {
      return this.lines.length;
    },
    lineAt(line: number) {
      // 本物の `TextDocument.lineAt` と同じく、範囲外は投げる。
      const text = this.lines[line];
      if (text === undefined) throw new Error("Illegal value for `line`");
      return { text };
    },
  });
  const editorFor = (document: FakeDocument): FakeEditor => ({
    document,
    setDecorations: vi.fn(),
  });
  return {
    documentFor,
    editorFor,
    visible: [] as FakeEditor[],
    documents: [] as FakeDocument[],
    visibilityListeners: [] as ((editors: FakeEditor[]) => void)[],
  };
});

vi.mock("vscode", () => ({
  window: {
    get visibleTextEditors() {
      return fake.visible;
    },
    createTextEditorDecorationType: vi.fn((options: Record<string, unknown>) => ({
      options,
      dispose: vi.fn(),
    })),
    onDidChangeVisibleTextEditors: vi.fn((listener: (editors: FakeEditor[]) => void) => {
      fake.visibilityListeners.push(listener);
      return { dispose: vi.fn() };
    }),
  },
  workspace: {
    get textDocuments() {
      return fake.documents;
    },
  },
  Range: class {
    readonly start: { line: number; character: number };
    readonly end: { line: number; character: number };
    constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
      this.start = { line: startLine, character: startCharacter };
      this.end = { line: endLine, character: endCharacter };
    }
  },
  OverviewRulerLane: { Center: 2 },
}));

import { Highlights } from "../src/decorations.js";
import { toHighlightRange } from "../src/line-range-vscode.js";

const URI = "showme-ro://ws/src/a.ts";
const uri = { toString: () => URI } as never;

interface Painted {
  line: number;
  startColumn: number;
  endColumn: number;
  wholeLine: boolean;
}

/** 直近の貼り付けで、非空で渡った範囲（型に焼かれた `isWholeLine` つき）。 */
function lastPaint(editor: FakeEditor, since: number): Painted[] {
  const out: Painted[] = [];
  for (const [type, ranges] of editor.setDecorations.mock.calls.slice(since) as [
    { options: { isWholeLine: boolean } },
    { start: { line: number; character: number }; end: { character: number } }[],
  ][]) {
    for (const r of ranges) {
      out.push({
        line: r.start.line,
        startColumn: r.start.character,
        endColumn: r.end.character,
        wholeLine: type.options.isWholeLine,
      });
    }
  }
  return out;
}

const WHOLE = { startColumn: 0, endColumn: Number.MAX_SAFE_INTEGER, wholeLine: true };

/**
 * ディスクの読みで `startLine` 行目（1始まり）の `[startColumn, endColumn)` に `needle` があった、
 * として登録し、文書が `lines` のエディタに貼られたものを返す。
 */
function paintAgainst(
  lines: string[],
  disk: { startLine: number; startColumn?: number; endColumn?: number },
  needle: string | undefined,
): Painted[] {
  const document = fake.documentFor(URI, lines);
  const editor = fake.editorFor(document);
  fake.visible = [editor];
  fake.documents = [document];
  const h = new Highlights();
  h.setAnnotation("k1", uri, toHighlightRange({ endLine: disk.startLine, ...disk }, "red", needle));
  return lastPaint(editor, 0);
}

describe("text の塗りは VS Code の文書の行で列を決め直す", () => {
  beforeEach(() => {
    fake.visible = [];
    fake.documents = [];
    fake.visibilityListeners.length = 0;
  });

  it("文書がディスクと同じなら、ディスクの列のまま（対照）", () => {
    expect(
      paintAgainst(["x", "  needle;"], { startLine: 2, startColumn: 2, endColumn: 8 }, "needle"),
    ).toEqual([{ line: 1, startColumn: 2, endColumn: 8, wholeLine: false }]);
  });

  it("BOM の分だけ列がずれていても、文書の上の位置を塗る", () => {
    // ディスクの読みが BOM を1単位と数えた列（1..7）。文書は BOM を外している（0..6）。
    expect(
      paintAgainst(["needle = 1;"], { startLine: 1, startColumn: 1, endColumn: 7 }, "needle"),
    ).toEqual([{ line: 0, startColumn: 0, endColumn: 6, wholeLine: false }]);
  });

  it("未保存の編集で同じ行の中で動いていれば、文書の上の新しい位置を塗る", () => {
    expect(
      paintAgainst(
        ["x", "const extra = 1; needle;"],
        { startLine: 2, startColumn: 2, endColumn: 8 },
        "needle",
      ),
    ).toEqual([{ line: 1, startColumn: 17, endColumn: 23, wholeLine: false }]);
  });

  it("文書のその行に2回あれば行全体（どちらか決められない）", () => {
    expect(
      paintAgainst(
        ["x", "needle(needle);"],
        { startLine: 2, startColumn: 2, endColumn: 8 },
        "needle",
      ),
    ).toEqual([{ line: 1, ...WHOLE }]);
  });

  it("文書のその行から消えていれば行全体（ディスクの列で別の文字を塗らない）", () => {
    expect(
      paintAgainst(["x", "  other;"], { startLine: 2, startColumn: 2, endColumn: 8 }, "needle"),
    ).toEqual([{ line: 1, ...WHOLE }]);
  });

  it("ディスクで同じ行に2回あって列が無くても、文書で1回ならその列を塗る", () => {
    expect(paintAgainst(["x", "  needle;"], { startLine: 2 }, "needle")).toEqual([
      { line: 1, startColumn: 2, endColumn: 8, wholeLine: false },
    ]);
  });

  it("文書がその行まで無ければ、ディスクの行の行全体（投げない）", () => {
    expect(
      paintAgainst(["only"], { startLine: 5, startColumn: 2, endColumn: 8 }, "needle"),
    ).toEqual([{ line: 4, ...WHOLE }]);
  });

  it("探した文字列が無い（lines の列指定）なら、文書が違っても指定の列のまま（対照）", () => {
    expect(
      paintAgainst(["x", "  other;"], { startLine: 2, startColumn: 2, endColumn: 8 }, undefined),
    ).toEqual([{ line: 1, startColumn: 2, endColumn: 8, wholeLine: false }]);
  });

  it("貼り直し（人間が開き直した）でも、そのときの文書で決め直す", () => {
    const document = fake.documentFor(URI, ["x", "  needle;"]);
    const editor = fake.editorFor(document);
    fake.documents = [document];
    const h = new Highlights();
    // 登録の時点では見えていない。
    h.setAnnotation(
      "k1",
      uri,
      toHighlightRange({ startLine: 2, endLine: 2, startColumn: 2, endColumn: 8 }, "red", "needle"),
    );
    expect(editor.setDecorations).not.toHaveBeenCalled();
    // 見えるまでの間に人間が編集した。
    document.lines[1] = "    moved needle;";
    fake.visible = [editor];
    for (const listener of fake.visibilityListeners) listener([editor]);
    expect(lastPaint(editor, 0)).toEqual([
      { line: 1, startColumn: 10, endColumn: 16, wholeLine: false },
    ]);
  });

  it("観測面（highlightRanges）も文書で決め直した範囲を言う（塗ったものと同じ関数）", () => {
    paintAgainst(
      ["x", "const extra = 1; needle;"],
      { startLine: 2, startColumn: 2, endColumn: 8 },
      "needle",
    );
    const h = new Highlights();
    h.setAnnotation(
      "k1",
      uri,
      toHighlightRange({ startLine: 2, endLine: 2, startColumn: 2, endColumn: 8 }, "red", "needle"),
    );
    expect(h.highlightRanges()).toEqual([
      { uri: URI, startLine: 1, startColumn: 17, endColumn: 23, wholeLine: false, color: "red" },
    ]);
  });

  it("観測面は、文書が開いていなければディスクの範囲を言う", () => {
    fake.documents = [];
    const h = new Highlights();
    h.setAnnotation(
      "k1",
      uri,
      toHighlightRange({ startLine: 2, endLine: 2, startColumn: 2, endColumn: 8 }, "red", "needle"),
    );
    expect(h.highlightRanges()).toEqual([
      { uri: URI, startLine: 1, startColumn: 2, endColumn: 8, wholeLine: false, color: "red" },
    ]);
  });
});
