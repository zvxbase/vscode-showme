import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * **`show_code` は塗らない**（増分13 D116）を、`setDecorations` に**実際に渡った引数**で言う。
 *
 * `decorations-repaint.test.ts` と同じく `vscode` を偽物にし、本物の面（`createEditorSurface`）と
 * 本物の画家（`Highlights`）を組んで `handleShowCode` を通す。開いたエディタも可視エディタの一覧に
 * 置くので、画家が何かを書けばこのエディタの `setDecorations` に出る。
 *
 * 対照として、同じエディタに注釈の層から塗れば `setDecorations` に出ることも確かめる
 * （検出器が本物の書き込みに当たる ―― 0 件でも「書いていない」は真になる）。
 */

const fake = vi.hoisted(() => {
  const editors: {
    document: { uri: { toString(): string } };
    setDecorations: ReturnType<typeof vi.fn>;
    revealRange: ReturnType<typeof vi.fn>;
    selection?: unknown;
  }[] = [];
  return { editors };
});

vi.mock("vscode", () => {
  class Range {
    constructor(
      readonly startLine: number,
      readonly startCharacter: number,
      readonly endLine: number,
      readonly endCharacter: number,
    ) {}
    get start() {
      return { line: this.startLine, character: this.startCharacter };
    }
    get end() {
      return { line: this.endLine, character: this.endCharacter };
    }
  }
  const uriOf = (fsPath: string) => ({
    scheme: "file",
    authority: "",
    path: fsPath,
    fsPath,
    toString: () => `file://${fsPath}`,
  });
  return {
    Range,
    TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
    OverviewRulerLane: { Center: 2 },
    Uri: {
      file: (p: string) => uriOf(p),
      joinPath: (root: { fsPath: string }, rel: string) => uriOf(`${root.fsPath}/${rel}`),
      from: (parts: { scheme: string; path: string }) => ({
        ...uriOf(parts.path),
        scheme: parts.scheme,
        toString: () => `${parts.scheme}:${parts.path}`,
      }),
    },
    window: {
      get visibleTextEditors() {
        return fake.editors;
      },
      createTextEditorDecorationType: vi.fn(() => ({ dispose: vi.fn() })),
      onDidChangeVisibleTextEditors: vi.fn(() => ({ dispose: vi.fn() })),
    },
    // 観測面（`highlightRanges`）が開いている文書を引く。
    workspace: { textDocuments: [] },
  };
});

import { DEFAULT_REDACTED_PATTERNS } from "@zvx/vscode-showme-protocol";
import type * as vscode from "vscode";
import type { ShowMeConfig } from "../src/config.js";
import { Highlights } from "../src/decorations.js";
import { createEditorSurface } from "../src/editor-surface.js";
import { handleShowCode } from "../src/handlers/show-code.js";
import { RateLimiter } from "../src/rate-limit.js";
import type { Stage } from "../src/stage.js";

const config: ShowMeConfig = {
  enabled: true,
  features: { stage: true, html: true, layout: true },
  editorGroup: "shared",
  html: { maxPanels: 2 },
  redaction: { patterns: [...DEFAULT_REDACTED_PATTERNS], blockLinksToRedacted: true },
  maxSelectionChars: 4000,
  injectTerminalEnv: true,
  listAllWorkspaces: false,
  layout: { closeHumanTabs: false, closeDirtyTabs: false, protectViewingTab: false },
};

const made: string[] = [];
afterEach(() => {
  fake.editors.length = 0;
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("show_code は setDecorations に何も渡さない（増分13 D116）", () => {
  it("開いてスクロールするが、開いたエディタにも他の可視エディタにも塗らない", async () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "showme-nopaint-")));
    made.push(root);
    fs.writeFileSync(path.join(root, "a.ts"), "one\nconst TARGET = 1;\nthree\n");

    // 人間が別のファイルを見ている（可視エディタ）。
    const other = {
      document: { uri: { toString: () => `file://${root}/other.ts` } },
      setDecorations: vi.fn(),
      revealRange: vi.fn(),
    };
    fake.editors.push(other);

    // 画家を作っておく（`extension.ts` と同じく窓に1つ）。`show_code` の経路はこれを持たない。
    const highlights = new Highlights();
    const opened: { uri: string }[] = [];
    const stage = {
      open: async (uri: vscode.Uri) => {
        opened.push({ uri: uri.toString() });
        const editor = {
          document: { uri },
          setDecorations: vi.fn(),
          revealRange: vi.fn(),
        };
        fake.editors.push(editor);
        return editor as unknown as vscode.TextEditor;
      },
    } as unknown as Stage;

    const rootUri = {
      scheme: "file",
      authority: "",
      path: root,
      fsPath: root,
      toString: () => `file://${root}`,
    } as unknown as vscode.Uri;
    const out = await handleShowCode(
      { locations: [{ path: "a.ts", text: "TARGET" }] },
      {
        config: () => config,
        editor: createEditorSurface(rootUri, { scheme: "file", record: true }, stage, {
          editorGroup: "shared",
          avoidToolColumns: false,
        }),
        log: { info: () => {} },
        statusBar: {
          flashMiss: () => {},
          flashManyMatches: () => {},
          flashRateLimited: () => {},
          flashMarked: () => {},
        },
        workspaceRoot: root,
        limiter: new RateLimiter(),
      },
    );

    expect((out.resolutions as { match: string }[])[0]?.match).toBe("one");
    // 開いた（食わせた件数を主張する: 開いていなければ「塗らない」は空で真になる）。
    expect(opened).toHaveLength(1);
    const shown = fake.editors[1];
    expect(shown?.revealRange).toHaveBeenCalledTimes(1);
    // **どのエディタにも setDecorations が1回も渡っていない。**
    for (const editor of fake.editors) expect(editor.setDecorations).not.toHaveBeenCalled();
    expect(highlights.highlightRanges()).toEqual([]);
    // 選択には触らない（不変条件3）。
    expect(shown).not.toHaveProperty("selection");

    // 対照: 同じエディタに注釈の層から塗れば、画家は書く（検出器が本物の書き込みに当たる）。
    highlights.setAnnotation(
      "k1",
      shown?.document.uri as unknown as vscode.Uri,
      {
        range: { start: { line: 1, character: 6 }, end: { line: 1, character: 12 } },
        wholeLine: false,
        color: "red",
      } as never,
    );
    expect(shown?.setDecorations).toHaveBeenCalled();
    highlights.dispose();
  });
});
