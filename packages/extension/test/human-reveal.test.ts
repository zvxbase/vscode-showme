import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * **人間の命令で開く規則**（増分6.1 D79 / §C5）。`show_code` の `Stage.open` とは別の関数である。
 *
 * 舞台の規則（人間の列を避ける・`preserveFocus`・own の記録）は**エージェントのため**の規則で、
 * 人間が吹き出しの ‹ › を押したときには逆に働く（実機: 同じファイルが人間の列に見えていても
 * 舞台にもう1枚開いてそちらを動かすので、人間の目には何も起きない。D73 の撤回理由）。
 * 人間の命令は**人間の規則**で開く: 既に見えているエディタがあればそこで、無ければ人間の
 * 今の列（`ViewColumn.Active`）に。フォーカスも移す（人間が押したのだから）。
 * 開いたタブは人間のもの（own に記録しない）。`selection` には触らない（不変条件3）。
 */

interface FakeEditor {
  document: { uri: { toString(): string } };
  viewColumn: number | undefined;
  revealRange: ReturnType<typeof vi.fn>;
  selection?: unknown;
}

const fake = vi.hoisted(() => {
  const visible: FakeEditor[] = [];
  const showTextDocument = vi.fn();
  return { visible, showTextDocument };
});

vi.mock("vscode", () => ({
  window: {
    get visibleTextEditors() {
      return fake.visible;
    },
    showTextDocument: fake.showTextDocument,
  },
  ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2 },
  TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
  Range: class {
    readonly start: { line: number; character: number };
    readonly end: { line: number; character: number };
    constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
      this.start = { line: startLine, character: startCharacter };
      this.end = { line: endLine, character: endCharacter };
    }
  },
}));

import type * as vscode from "vscode";
import { revealForHuman } from "../src/human-reveal.js";

const uri = (s: string): vscode.Uri => ({ toString: () => s }) as unknown as vscode.Uri;

/**
 * `selection` の setter は**スパイで、しかも投げる**。投げるだけだと、実装が `try/catch` で
 * 包めば書いたのに緑のまま通る（レビューの変異 f3）。呼ばれた回数を主張して、包んでも見える。
 */
const selectionSetter = vi.fn((): void => {
  throw new Error("selection に触った（不変条件3）");
});

/** `selection` に代入されたら記録して投げるエディタ。触らないことを構造で観測する。 */
function editorFor(uriString: string, viewColumn: number | undefined): FakeEditor {
  const editor: FakeEditor = {
    document: { uri: uri(uriString) },
    viewColumn,
    revealRange: vi.fn(),
  };
  Object.defineProperty(editor, "selection", {
    get: () => undefined,
    set: selectionSetter,
  });
  return editor;
}

describe("revealForHuman は人間の規則で開く（D79 / §C5）", () => {
  beforeEach(() => {
    fake.visible.length = 0;
    fake.showTextDocument.mockReset();
    selectionSetter.mockClear();
  });

  afterEach(() => {
    // どの検査でも `selection` は一度も書かれていない（不変条件3）。投げるだけでは
    // `try/catch` で包んだ実装を見逃すので、回数で言う。
    expect(selectionSetter).not.toHaveBeenCalled();
  });

  it("既に見えているエディタがあれば、その文書をその列で・フォーカスを移して開き直し、行を出す", async () => {
    const seen = editorFor("file:///a.md", 1);
    const other = editorFor("file:///other.md", 2);
    fake.visible.push(other, seen);
    const reopened = editorFor("file:///a.md", 1);
    fake.showTextDocument.mockResolvedValue(reopened);

    await revealForHuman(uri("file:///a.md"), 150);

    expect(fake.showTextDocument).toHaveBeenCalledTimes(1);
    expect(fake.showTextDocument).toHaveBeenCalledWith(seen.document, {
      viewColumn: 1,
      preserveFocus: false,
      preview: false,
    });
    expect(reopened.revealRange).toHaveBeenCalledTimes(1);
    const [range, type] = reopened.revealRange.mock.calls[0] as [unknown, unknown];
    expect(range).toMatchObject({ start: { line: 149, character: 0 }, end: { line: 149 } });
    expect(type).toBe(2);
    expect(other.revealRange).not.toHaveBeenCalled();
  });

  it("見えていなければ、人間の今の列（ViewColumn.Active）に・フォーカスを移して開く", async () => {
    fake.visible.push(editorFor("file:///other.md", 2));
    const opened = editorFor("file:///b.md", 2);
    fake.showTextDocument.mockResolvedValue(opened);
    const target = uri("file:///b.md");

    await revealForHuman(target, 3);

    expect(fake.showTextDocument).toHaveBeenCalledWith(target, {
      viewColumn: -1,
      preserveFocus: false,
      preview: false,
    });
    expect(opened.revealRange).toHaveBeenCalledTimes(1);
    expect(opened.revealRange.mock.calls[0]?.[0]).toMatchObject({ start: { line: 2 } });
  });

  it("見えているが列を持たないエディタ（グループの外）は、人間の今の列に倒す", async () => {
    const seen = editorFor("file:///a.md", undefined);
    fake.visible.push(seen);
    fake.showTextDocument.mockResolvedValue(editorFor("file:///a.md", 1));
    await revealForHuman(uri("file:///a.md"), 1);
    expect(fake.showTextDocument).toHaveBeenCalledWith(seen.document, {
      viewColumn: -1,
      preserveFocus: false,
      preview: false,
    });
  });

  it("URI の照合は toString で（同じ綴りの別オブジェクトでも見えている扱い）", async () => {
    const seen = editorFor("file:///a.md", 2);
    fake.visible.push(seen);
    fake.showTextDocument.mockResolvedValue(editorFor("file:///a.md", 2));
    await revealForHuman(uri("file:///a.md"), 1);
    expect(fake.showTextDocument.mock.calls[0]?.[0]).toBe(seen.document);
  });

  /**
   * own を記録する口（`OpenedByAgent`）も舞台（`Stage`）も**引数に無く、import も無い**。
   * 人間が開いたタブは人間のもので、`arrange_editors close-own` の対象にならない。
   * 「呼ばない」を作法ではなく構造（依存が無い）で固定する。
   */
  it("舞台にも own の記録にも依存しない（人間のタブは人間のもの）", () => {
    const source = readFileSync(new URL("../src/human-reveal.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/stage\.js|opened-by-agent\.js|editor-surface\.js/);
    expect(source).not.toMatch(/\.opened\(/);
    expect(source).not.toMatch(/preserveFocus:\s*true/);
    // 位置合わせは revealRange だけ。selection は綴りにも出ない（不変条件3）。
    expect(source).not.toMatch(/\.selection\s*=/);
  });
});
