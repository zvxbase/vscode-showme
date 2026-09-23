import { existsSync, readFileSync } from "node:fs";
import { MAX_ANNOTATION_THREADS, UNMARKED_ANNOTATION_PAINT } from "@zvx/vscode-showme-protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * **注釈ストアが自分の塗りを持つ**（増分6 D65 / D66）。
 *
 * 注釈の色は作者名（`ShowMe 🔴 R`）だけでなく行にも出る。塗りの持ち主は注釈で、
 * `Highlights` の注釈層に札つきで登録し、注釈が消える**4経路すべて**
 * （`clear` / `replace`（＝ `clearAll`）/ 上限の押し出し / 停止）で同じ関数から抹消する。
 *
 * ここでは `vscode` と画家を偽物にして、ストアが画家に**何を渡したか**を見る。
 * `wholeLine` を決めるのは `toHighlightRange` 1つ（`line-range-vscode.ts`）で、
 * `show_code` の塗りと同じ関数を通る ―― 同じ量を2箇所で決めない（不変条件14）。
 */

interface FakeThread {
  uri: unknown;
  range: unknown;
  comments: unknown[];
  dispose: ReturnType<typeof vi.fn>;
  canReply?: boolean;
  label?: string;
  collapsibleState?: number;
  state?: number;
  contextValue?: string;
}

/**
 * controller の偽物は**素のオブジェクト**。ストアが `commentingRangeProvider` /
 * `reactionHandler` を代入すれば、ここに鍵が生える ―― 「設定しない」を
 * 「鍵が無いまま」で観測する（D70: 他の UI は引き続き無い）。
 */
interface FakeController {
  createCommentThread: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  commentingRangeProvider?: unknown;
  reactionHandler?: unknown;
}

const fake = vi.hoisted(() => {
  const threads: FakeThread[] = [];
  const controller: FakeController = {
    createCommentThread: vi.fn((uri: unknown, range: unknown, comments: unknown[]): FakeThread => {
      const thread: FakeThread = { uri, range, comments, dispose: vi.fn() };
      threads.push(thread);
      return thread;
    }),
    dispose: vi.fn(),
  };
  return { threads, controller };
});

vi.mock("vscode", () => ({
  comments: { createCommentController: vi.fn(() => fake.controller) },
  CommentMode: { Editing: 0, Preview: 1 },
  CommentThreadCollapsibleState: { Collapsed: 0, Expanded: 1 },
  CommentThreadState: { Unresolved: 0, Resolved: 1 },
  // `toRange` が使う。中身は画家に渡る引数として観測するだけなので、素の値で持つ。
  Range: class {
    readonly start: { line: number; character: number };
    readonly end: { line: number; character: number };
    constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
      this.start = { line: startLine, character: startCharacter };
      this.end = { line: endLine, character: endCharacter };
    }
  },
  l10n: { t: (s: string) => s },
}));

import type * as vscode from "vscode";
import { annotationUiSurface } from "../src/annotation-ui-observation.js";
import { Annotations, isCommentThreadLike } from "../src/annotations.js";

/** 画家の偽物。ストアが触る口だけを持つ。 */
const painter = () => ({
  setAnnotation: vi.fn(),
  removeAnnotation: vi.fn(),
});

const uri = (s: string): vscode.Uri => ({ toString: () => s }) as unknown as vscode.Uri;
const A = uri("file:///a");

const authorOf = (thread: FakeThread | undefined): string | undefined =>
  (thread?.comments[0] as { author?: { name?: string } } | undefined)?.author?.name;

describe("Annotations は色つきの注釈を注釈層に登録する（D65）", () => {
  beforeEach(() => {
    fake.threads.length = 0;
    fake.controller.createCommentThread.mockClear();
  });

  it("色つきは行全体で登録され、札・uri・色が画家に渡る", () => {
    const h = painter();
    const store = new Annotations(h);
    store.add(A, { startLine: 3, endLine: 3 }, "why", "red");

    expect(h.setAnnotation).toHaveBeenCalledTimes(1);
    const [key, passedUri, range] = h.setAnnotation.mock.calls[0] as [string, unknown, unknown];
    expect(typeof key).toBe("string");
    expect(passedUri).toBe(A);
    expect(range).toMatchObject({
      wholeLine: true,
      color: "red",
      range: { start: { line: 2, character: 0 }, end: { line: 2 } },
    });
    // 吹き出しも同じ位置に出ている。
    expect(fake.controller.createCommentThread).toHaveBeenCalledTimes(1);
  });

  it("列が両方そろえば文字単位（wholeLine を決める関数は show_code と同じ）", () => {
    const h = painter();
    const store = new Annotations(h);
    store.add(A, { startLine: 3, endLine: 3, startColumn: 2, endColumn: 8 }, "why", "blue");
    expect(h.setAnnotation.mock.calls[0]?.[2]).toMatchObject({
      wholeLine: false,
      color: "blue",
      range: { start: { line: 2, character: 2 }, end: { line: 2, character: 8 } },
    });
  });

  it("無印（color 省略）は灰で塗る。作者名は ShowMe のまま（増分6.1 D78）", () => {
    // D65 の「無印は塗らない」は実機で目立たなすぎたので撤回。塗る色は protocol の
    // `UNMARKED_ANNOTATION_PAINT` 1つが決め、注釈の語彙（作者名の表）には灰を戻さない。
    const h = painter();
    const store = new Annotations(h);
    store.add(A, { startLine: 3, endLine: 3 }, "why");
    expect(h.setAnnotation).toHaveBeenCalledTimes(1);
    expect(h.setAnnotation.mock.calls[0]?.[2]).toMatchObject({
      wholeLine: true,
      color: UNMARKED_ANNOTATION_PAINT,
      range: { start: { line: 2, character: 0 } },
    });
    expect(UNMARKED_ANNOTATION_PAINT).toBe("grey");
    expect(fake.controller.createCommentThread).toHaveBeenCalledTimes(1);
    expect(authorOf(fake.threads[0])).toBe("ShowMe");
    // 観測面（`list()`）には色が**出ない**: 無印は無印のまま（灰はエージェントの色ではない）。
    expect(store.list()[0] !== undefined && "color" in store.list()[0]).toBe(false);
  });

  it("札は注釈ごとに違う（同じ札なら層で置き換わって前の塗りが消える）", () => {
    const h = painter();
    const store = new Annotations(h);
    store.add(A, { startLine: 1, endLine: 1 }, "x", "red");
    store.add(A, { startLine: 2, endLine: 2 }, "y", "red");
    const keys = h.setAnnotation.mock.calls.map((c) => c[0] as string);
    expect(new Set(keys).size).toBe(2);
  });
});

describe("注釈の塗りは注釈の寿命（D66: 4経路すべてで同じ関数が抹消する）", () => {
  beforeEach(() => {
    fake.threads.length = 0;
    fake.controller.createCommentThread.mockClear();
  });

  it("clearAll は色つきの札を1つずつ抹消し、スレッドも全部捨てる", () => {
    const h = painter();
    const store = new Annotations(h);
    store.add(A, { startLine: 1, endLine: 1 }, "x", "red");
    store.add(A, { startLine: 2, endLine: 2 }, "y");
    store.add(A, { startLine: 3, endLine: 3 }, "z", "green");
    const registered = h.setAnnotation.mock.calls.map((c) => c[0] as string);
    // 無印も灰で登録される（D78）ので3件。
    expect(registered).toHaveLength(3);

    store.clearAll();

    // 登録した札は**全部**抹消される。
    const removed = h.removeAnnotation.mock.calls.map((c) => c[0] as string);
    for (const key of registered) expect(removed).toContain(key);
    expect(h.removeAnnotation).toHaveBeenCalledTimes(3);
    for (const thread of fake.threads) expect(thread.dispose).toHaveBeenCalledTimes(1);
    expect(store.annotatedUris()).toEqual([]);
  });

  it("上限を超えた押し出しは、最も古い注釈の札を抹消する", () => {
    const h = painter();
    const store = new Annotations(h);
    store.add(A, { startLine: 1, endLine: 1 }, "oldest", "red");
    const oldestKey = h.setAnnotation.mock.calls[0]?.[0] as string;
    for (let i = 0; i < Annotations.MAX_THREADS; i += 1) {
      store.add(A, { startLine: i + 2, endLine: i + 2 }, `n${i}`, "blue");
    }
    expect(store.annotatedUris()).toHaveLength(Annotations.MAX_THREADS);
    expect(h.removeAnnotation).toHaveBeenCalledTimes(1);
    expect(h.removeAnnotation).toHaveBeenCalledWith(oldestKey);
    expect(fake.threads[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it("dispose は全部の札を抹消し、controller も捨てる", () => {
    const h = painter();
    const store = new Annotations(h);
    store.add(A, { startLine: 1, endLine: 1 }, "x", "red");
    store.add(A, { startLine: 2, endLine: 2 }, "y", "purple");
    store.dispose();
    expect(h.removeAnnotation).toHaveBeenCalledTimes(2);
    expect(fake.controller.dispose).toHaveBeenCalled();
    expect(store.annotatedUris()).toEqual([]);
  });
});

/**
 * 番号と一覧（増分6 D69 / D71 / D72）。
 *
 * 作者名の番号（`1/2 · ShowMe 🔴 R`）は**ストアが自分の一覧から数えて**書く。
 * 総数が変わる経路（追加・上限の押し出し）のたびに全スレッドの作者名を書き直す ――
 * VS Code の comment thread は `comments` の**再代入**で描き直す（要素の変更では描き直さない）。
 */
describe("番号は拡張が付け、総数が変わるたびに全部書き直す（D69）", () => {
  beforeEach(() => {
    fake.threads.length = 0;
    fake.controller.createCommentThread.mockClear();
  });

  it("1件だけなら番号を出さない", () => {
    const store = new Annotations(painter());
    store.add(A, { startLine: 1, endLine: 1 }, "x", "red");
    expect(authorOf(fake.threads[0])).toBe("ShowMe 🔴 R");
    expect(store.annotatedBodies().map((b) => b.author)).toEqual(["ShowMe 🔴 R"]);
  });

  it("2件目を足すと、1件目の作者名も `1/2 ·` に書き直される（分母の更新）", () => {
    const store = new Annotations(painter());
    store.add(A, { startLine: 1, endLine: 1 }, "x", "red");
    store.add(A, { startLine: 2, endLine: 2 }, "y");
    expect(authorOf(fake.threads[0])).toBe("1/2 · ShowMe 🔴 R");
    expect(authorOf(fake.threads[1])).toBe("2/2 · ShowMe");
    store.add(A, { startLine: 3, endLine: 3 }, "z", "blue");
    expect(store.annotatedBodies().map((b) => b.author)).toEqual([
      "1/3 · ShowMe 🔴 R",
      "2/3 · ShowMe",
      "3/3 · ShowMe 🔵 B",
    ]);
  });

  it("書き直しは comments の再代入で行い、本文と mode は変えない（D48: 本文は string のまま）", () => {
    const store = new Annotations(painter());
    store.add(A, { startLine: 1, endLine: 1 }, "本文", "red");
    const before = fake.threads[0]?.comments;
    store.add(A, { startLine: 2, endLine: 2 }, "y");
    const after = fake.threads[0]?.comments;
    // 配列そのものが新しい（要素の書き換えでは VS Code が描き直さない）。
    expect(after).not.toBe(before);
    expect(after?.[0]).toMatchObject({ body: "本文", mode: 1 });
    expect(typeof (after?.[0] as { body: unknown }).body).toBe("string");
  });

  it("上限の押し出しで総数が変わったら、残った側も詰め直す", () => {
    const store = new Annotations(painter());
    let last: { id: number } | undefined;
    for (let i = 0; i < Annotations.MAX_THREADS + 1; i += 1) {
      last = store.add(A, { startLine: i + 1, endLine: i + 1 }, `n${i}`, "red");
    }
    const authors = store.annotatedBodies().map((b) => b.author);
    expect(authors).toHaveLength(Annotations.MAX_THREADS);
    expect(authors[0]).toBe(`1/${Annotations.MAX_THREADS} · ShowMe 🔴 R`);
    expect(authors[Annotations.MAX_THREADS - 1]).toBe(
      `${Annotations.MAX_THREADS}/${Annotations.MAX_THREADS} · ShowMe 🔴 R`,
    );
    // 押し出されたのは最古（id 1）で、生き残りの先頭は id 2 で index 1。
    const list = store.list();
    expect(list[0]).toMatchObject({ id: 2, index: 1 });
    // 65件目は一覧の末尾＝ちょうど MAX_THREADS の位置。65 と答える実装（押し出しの前に
    // 数える）をここで殺す。全部の index が上限以下であることも見る。
    expect(list.find((e) => e.id === last?.id)?.index).toBe(Annotations.MAX_THREADS);
    expect(list.map((e) => e.index)).toEqual(
      Array.from({ length: Annotations.MAX_THREADS }, (_, i) => i + 1),
    );
    for (const e of list) expect(e.index).toBeLessThanOrEqual(MAX_ANNOTATION_THREADS);
  });

  it("add は id だけを返す（index は list() で読む ―― 押し出しでずれる量を add の時点で答えない）", () => {
    const store = new Annotations(painter());
    expect(store.add(A, { startLine: 1, endLine: 1 }, "a")).toEqual({ id: 1 });
    expect(store.add(A, { startLine: 2, endLine: 2 }, "b")).toEqual({ id: 2 });
    expect(store.list().map((e) => [e.id, e.index])).toEqual([
      [1, 1],
      [2, 2],
    ]);
  });

  it("64件の上に2件足すと、その2件の index は 63 と 64 で、作者名も同じ数を言う", () => {
    const store = new Annotations(painter());
    for (let i = 0; i < Annotations.MAX_THREADS; i += 1) {
      store.add(A, { startLine: i + 1, endLine: i + 1 }, `n${i}`, "red");
    }
    const a = store.add(A, { startLine: 100, endLine: 100 }, "A", "blue");
    const b = store.add(A, { startLine: 101, endLine: 101 }, "B");
    const list = store.list();
    expect(list).toHaveLength(Annotations.MAX_THREADS);
    expect(list.find((e) => e.id === a.id)?.index).toBe(Annotations.MAX_THREADS - 1);
    expect(list.find((e) => e.id === b.id)?.index).toBe(Annotations.MAX_THREADS);
    const authors = store.annotatedBodies().map((x) => x.author);
    expect(authors[Annotations.MAX_THREADS - 2]).toBe(
      `${Annotations.MAX_THREADS - 1}/${Annotations.MAX_THREADS} · ShowMe 🔵 B`,
    );
    expect(authors[Annotations.MAX_THREADS - 1]).toBe(
      `${Annotations.MAX_THREADS}/${Annotations.MAX_THREADS} · ShowMe`,
    );
  });
});

describe("list() は id・順番・位置・色・読了を1回で返す（D72）", () => {
  beforeEach(() => {
    fake.threads.length = 0;
    fake.controller.createCommentThread.mockClear();
  });

  const B = uri("file:///b");

  it("index 順に、1始まりの行と色（無印は鍵ごと無い）と resolved: false", () => {
    const store = new Annotations(painter());
    store.add(A, { startLine: 12, endLine: 14 }, "x", "red");
    store.add(B, { startLine: 3, endLine: 3 }, "y");
    const list = store.list();
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({ id: 1, index: 1, uri: A, line: 12, color: "red", resolved: false });
    expect(list[1]).toEqual({ id: 2, index: 2, uri: B, line: 3, resolved: false });
    expect(list[1] !== undefined && "color" in list[1]).toBe(false);
  });

  it("id は clear の後も戻らない（窓の中で単調増加）", () => {
    const store = new Annotations(painter());
    store.add(A, { startLine: 1, endLine: 1 }, "a");
    store.add(A, { startLine: 2, endLine: 2 }, "b");
    store.add(A, { startLine: 3, endLine: 3 }, "c");
    expect(store.list().map((e) => e.id)).toEqual([1, 2, 3]);
    store.clearAll();
    expect(store.list()).toEqual([]);
    expect(store.add(A, { startLine: 1, endLine: 1 }, "d")).toEqual({ id: 4 });
    expect(store.list().map((e) => [e.id, e.index])).toEqual([[4, 1]]);
  });

  it("上限は protocol の MAX_ANNOTATION_THREADS と同じ量（決める場所は1つ）", () => {
    expect(Annotations.MAX_THREADS).toBe(MAX_ANNOTATION_THREADS);
  });
});

/**
 * 人間の読了は1ビット（増分6 §C3 / D70）。
 *
 * `Resolve` / `Unresolve` の命令は `thread` を引数に受ける。`when` 句で自分の
 * controller に限っているが、`when` は作法であって構造ではない ―― `executeCommand` は
 * 誰でも呼べる。だからストアは**自分の一覧にあるスレッドか**を同一性で確かめてから触る。
 * 編集・削除・返信・リアクション・新規作成の UI は引き続き無い（`canReply === false`、
 * `commentingRangeProvider` / `reactionHandler` 未設定）。
 */
describe("Resolve / Unresolve は自分のスレッドだけを切り替える（D70）", () => {
  beforeEach(() => {
    fake.threads.length = 0;
    fake.controller.createCommentThread.mockClear();
  });

  it("新しいスレッドは Unresolved で contextValue は unresolved で始まる", () => {
    const store = new Annotations(painter());
    store.add(A, { startLine: 1, endLine: 1 }, "x", "red");
    expect(fake.threads[0]).toMatchObject({ state: 0, contextValue: "unresolved only" });
    expect(store.list()[0]?.resolved).toBe(false);
  });

  it("setResolved(true) で state と contextValue と list().resolved が反転し、false で戻る", () => {
    const store = new Annotations(painter());
    store.add(A, { startLine: 1, endLine: 1 }, "x", "red");
    store.add(A, { startLine: 2, endLine: 2 }, "y");
    const thread = fake.threads[0] as unknown as vscode.CommentThread;

    expect(store.setResolved(thread, true)).toBe(true);
    expect(fake.threads[0]).toMatchObject({ state: 1, contextValue: "resolved first" });
    expect(store.list().map((e) => e.resolved)).toEqual([true, false]);

    expect(store.setResolved(thread, false)).toBe(true);
    expect(fake.threads[0]).toMatchObject({ state: 0, contextValue: "unresolved first" });
    expect(store.list().map((e) => e.resolved)).toEqual([false, false]);
  });

  it("読了を切り替えても番号（作者名）と id は変わらない", () => {
    const store = new Annotations(painter());
    store.add(A, { startLine: 1, endLine: 1 }, "x", "red");
    store.add(A, { startLine: 2, endLine: 2 }, "y");
    const before = store.annotatedBodies().map((b) => b.author);
    store.setResolved(fake.threads[1] as unknown as vscode.CommentThread, true);
    expect(store.annotatedBodies().map((b) => b.author)).toEqual(before);
    expect(store.list().map((e) => [e.id, e.index, e.resolved])).toEqual([
      [1, 1, false],
      [2, 2, true],
    ]);
  });

  it("自分の一覧に無いスレッド（他拡張のもの・形だけ同じもの）は false を返して触らない", () => {
    const store = new Annotations(painter());
    store.add(A, { startLine: 1, endLine: 1 }, "x", "red");
    const own = fake.threads[0];
    // 中身を写した別オブジェクト。同一性でしか見分けられない。
    const foreign = { ...own, state: 0, contextValue: "unresolved only" };
    expect(store.setResolved(foreign as unknown as vscode.CommentThread, true)).toBe(false);
    expect(foreign).toMatchObject({ state: 0, contextValue: "unresolved only" });
    expect(own).toMatchObject({ state: 0, contextValue: "unresolved only" });
    expect(store.list()[0]?.resolved).toBe(false);
  });

  it("clearAll の後の古いスレッドは false（捨てたものを触らない）", () => {
    const store = new Annotations(painter());
    store.add(A, { startLine: 1, endLine: 1 }, "x", "red");
    const stale = fake.threads[0] as unknown as vscode.CommentThread;
    store.clearAll();
    expect(store.setResolved(stale, true)).toBe(false);
    expect(fake.threads[0]).toMatchObject({ state: 0, contextValue: "unresolved only" });
  });

  it("他の UI は無い: canReply は false、範囲プロバイダもリアクションの口も設定されない", () => {
    const store = new Annotations(painter());
    store.add(A, { startLine: 1, endLine: 1 }, "x", "red");
    store.add(A, { startLine: 2, endLine: 2 }, "y");
    store.setResolved(fake.threads[0] as unknown as vscode.CommentThread, true);
    for (const thread of fake.threads) expect(thread.canReply).toBe(false);
    // 統合テストが見る面も同じことを言う（観測の関数は controller の偽物にそのまま当たる）。
    expect(annotationUiSurface(store.observeUi())).toEqual({
      canReply: [false, false],
      hasCommentingRangeProvider: false,
      hasReactionHandler: false,
    });
    // **観測の後に**鍵が無いことを見る。観測が controller に書けば（`Readonly` は型の上だけ）
    // ここで鍵が生えて赤くなる ―― 観測が書き換えないことの証拠は、順序で持つ。
    expect("commentingRangeProvider" in fake.controller).toBe(false);
    expect("reactionHandler" in fake.controller).toBe(false);
    expect(fake.controller.commentingRangeProvider).toBeUndefined();
    expect(fake.controller.reactionHandler).toBeUndefined();
    // 吹き出しは表示のまま（`Editing = 0` に倒れていない）。
    for (const thread of fake.threads) {
      expect(thread.comments[0]).toMatchObject({ mode: 1 });
    }
  });
});

describe("isCommentThreadLike は形だけを見る（自分のものかは setResolved が決める）", () => {
  it("uri（object）と comments（配列）を持つ object だけ true", () => {
    expect(isCommentThreadLike({ uri: A, comments: [] })).toBe(true);
    expect(isCommentThreadLike({ uri: A, comments: [{ body: "x" }], state: 1 })).toBe(true);
  });

  it("それ以外は false（undefined・文字列・uri 無し・comments が配列でない）", () => {
    expect(isCommentThreadLike(undefined)).toBe(false);
    expect(isCommentThreadLike(null)).toBe(false);
    expect(isCommentThreadLike("thread")).toBe(false);
    expect(isCommentThreadLike({ comments: [] })).toBe(false);
    expect(isCommentThreadLike({ uri: "file:///a", comments: [] })).toBe(false);
    expect(isCommentThreadLike({ uri: A, comments: "x" })).toBe(false);
  });
});

describe("annotationUiSurface は controller の口の有無を読むだけ", () => {
  it("未作成（1件も出していない）なら両方 false で canReply は空", () => {
    expect(annotationUiSurface(new Annotations(painter()).observeUi())).toEqual({
      canReply: [],
      hasCommentingRangeProvider: false,
      hasReactionHandler: false,
    });
  });

  it("口が設定されていれば true と言う（検出器が本当に当たる）", () => {
    const controller = {
      commentingRangeProvider: { provideCommentingRanges: () => [] },
      reactionHandler: async () => undefined,
    } as unknown as vscode.CommentController;
    expect(annotationUiSurface({ canReply: [true], controller })).toEqual({
      canReply: [true],
      hasCommentingRangeProvider: true,
      hasReactionHandler: true,
    });
  });
});

/**
 * 案内は吹き出しから（増分6.1 D79。D73 のカーソルは撤回）。
 *
 * 「次」は命令の状態ではなく、押した吹き出しの位置から決まる。だからストアにカーソルは
 * **無い**（不変条件13 にも素直）。端では ‹ › を出さない ―― そのために `contextValue` が
 * 読了と位置を**1つの文字列**で持ち（`"unresolved first"` のように）、`when` 句が
 * `=~ /(first|middle)$/` で読む。位置は総数が変わるたびに（`renumber()`）、読了は
 * `setResolved` で書き直され、**書く関数は1つ**（同じ量を2箇所で決めない。不変条件14）。
 */
describe("contextValue は読了と位置を1つの文字列で持つ（D79）", () => {
  beforeEach(() => {
    fake.threads.length = 0;
    fake.controller.createCommentThread.mockClear();
  });

  const B = uri("file:///b");
  const contexts = (): (string | undefined)[] => fake.threads.map((th) => th.contextValue);

  it("1件だけなら only、2件なら first / last、3件なら first / middle / last", () => {
    const store = new Annotations(painter());
    store.add(A, { startLine: 1, endLine: 1 }, "1", "red");
    expect(contexts()).toEqual(["unresolved only"]);
    store.add(A, { startLine: 2, endLine: 2 }, "2");
    expect(contexts()).toEqual(["unresolved first", "unresolved last"]);
    store.add(B, { startLine: 3, endLine: 3 }, "3", "blue");
    expect(contexts()).toEqual(["unresolved first", "unresolved middle", "unresolved last"]);
  });

  it("setResolved は位置を保ったまま先頭の語だけ変える", () => {
    const store = new Annotations(painter());
    store.add(A, { startLine: 1, endLine: 1 }, "1");
    store.add(A, { startLine: 2, endLine: 2 }, "2");
    store.add(A, { startLine: 3, endLine: 3 }, "3");
    store.setResolved(fake.threads[1] as unknown as vscode.CommentThread, true);
    expect(contexts()).toEqual(["unresolved first", "resolved middle", "unresolved last"]);
    store.setResolved(fake.threads[1] as unknown as vscode.CommentThread, false);
    expect(contexts()).toEqual(["unresolved first", "unresolved middle", "unresolved last"]);
  });

  it("上限の押し出しで位置が書き直され、読了は保たれる", () => {
    const store = new Annotations(painter());
    for (let i = 1; i <= MAX_ANNOTATION_THREADS; i += 1) {
      store.add(A, { startLine: i, endLine: i }, `${i}`);
    }
    // 2件目を読了にしておく。押し出しで先頭になっても読了のまま。
    store.setResolved(fake.threads[1] as unknown as vscode.CommentThread, true);
    expect(fake.threads[1]?.contextValue).toBe("resolved middle");
    store.add(B, { startLine: 1, endLine: 1 }, "new");
    expect(fake.threads[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(fake.threads[1]?.contextValue).toBe("resolved first");
    expect(fake.threads[MAX_ANNOTATION_THREADS - 1]?.contextValue).toBe("unresolved middle");
    expect(fake.threads[MAX_ANNOTATION_THREADS]?.contextValue).toBe("unresolved last");
  });

  it("clearAll の後に出し直せば only から数え直す", () => {
    const store = new Annotations(painter());
    store.add(A, { startLine: 1, endLine: 1 }, "1");
    store.add(A, { startLine: 2, endLine: 2 }, "2");
    store.clearAll();
    store.add(B, { startLine: 1, endLine: 1 }, "x");
    expect(fake.threads[2]?.contextValue).toBe("unresolved only");
  });
});

/**
 * 隣の注釈（増分6.1 D79）。起点は**押した吹き出し**で、自分のものかは同一性で決める
 * （`setResolved` と同じ）。順番は `list()` の**1回の観測**から取る（`get_editor_state.annotations`
 * と同じ面。不変条件14）。端では `undefined`（‹ › は `contextValue` で消えているが、
 * `executeCommand` は誰でも呼べる）。読了は飛ばさない（順番は案内であって未読管理ではない。§C3）。
 */
describe("neighbor は押した吹き出しの隣を list() の順で返す（D79）", () => {
  beforeEach(() => {
    fake.threads.length = 0;
    fake.controller.createCommentThread.mockClear();
  });

  const B = uri("file:///b");
  const thread = (i: number): vscode.CommentThread =>
    fake.threads[i] as unknown as vscode.CommentThread;

  function three(): Annotations {
    const store = new Annotations(painter());
    store.add(A, { startLine: 5, endLine: 5 }, "1", "red");
    store.add(A, { startLine: 150, endLine: 150 }, "2", "blue");
    store.add(B, { startLine: 3, endLine: 3 }, "3");
    return store;
  }

  it("next は index + 1、previous は index - 1 で、返るのは list() の要素そのもの", () => {
    const store = three();
    expect(store.neighbor(thread(0), 1)).toEqual(store.list()[1]);
    expect(store.neighbor(thread(0), 1)).toMatchObject({
      index: 2,
      uri: A,
      line: 150,
      color: "blue",
    });
    expect(store.neighbor(thread(1), 1)).toMatchObject({ index: 3, uri: B, line: 3 });
    expect(store.neighbor(thread(2), -1)).toMatchObject({ index: 2, uri: A, line: 150 });
    expect(store.neighbor(thread(1), -1)).toMatchObject({
      index: 1,
      uri: A,
      line: 5,
      color: "red",
    });
  });

  it("末尾の next と先頭の previous は undefined（回らない）", () => {
    const store = three();
    expect(store.neighbor(thread(2), 1)).toBeUndefined();
    expect(store.neighbor(thread(0), -1)).toBeUndefined();
    const one = new Annotations(painter());
    one.add(A, { startLine: 1, endLine: 1 }, "x");
    expect(one.neighbor(thread(3), 1)).toBeUndefined();
    expect(one.neighbor(thread(3), -1)).toBeUndefined();
  });

  it("読了済みも飛ばさない（§C3）", () => {
    const store = three();
    store.setResolved(thread(1), true);
    expect(store.neighbor(thread(0), 1)).toMatchObject({ index: 2, resolved: true });
    expect(store.neighbor(thread(2), -1)).toMatchObject({ index: 2, resolved: true });
  });

  it("自分の一覧に無いスレッド（形だけ同じもの・clearAll 後の古いもの）は undefined", () => {
    const store = three();
    const foreign = { ...fake.threads[0] };
    expect(store.neighbor(foreign as unknown as vscode.CommentThread, 1)).toBeUndefined();
    const stale = thread(0);
    store.clearAll();
    expect(store.neighbor(stale, 1)).toBeUndefined();
    expect(store.neighbor(stale, -1)).toBeUndefined();
  });

  it("押し出しの後は新しい順で隣を返す", () => {
    const store = new Annotations(painter());
    for (let i = 1; i <= MAX_ANNOTATION_THREADS + 1; i += 1) {
      store.add(A, { startLine: i, endLine: i }, `${i}`);
    }
    // 1件目は押し出されている。2件目が先頭で、previous は無い。
    expect(store.neighbor(thread(0), -1)).toBeUndefined();
    expect(store.neighbor(thread(1), -1)).toBeUndefined();
    expect(store.neighbor(thread(1), 1)).toMatchObject({ index: 2, line: 3 });
  });

  it("expand は自分の id のスレッドだけ collapsibleState を Expanded に代入し直す", () => {
    const store = three();
    // 人間が畳んだ状態を作る（VS Code 側から `collapsibleState` が書き戻る）。
    for (const th of fake.threads) th.collapsibleState = 0;
    const second = store.list()[1];
    expect(second).toBeDefined();
    expect(store.expand(second?.id ?? -1)).toBe(true);
    expect(fake.threads.map((th) => th.collapsibleState)).toEqual([0, 1, 0]);
    // 知らない id は何もせず false。
    expect(store.expand(9999)).toBe(false);
    expect(fake.threads.map((th) => th.collapsibleState)).toEqual([0, 1, 0]);
  });
});

/**
 * D73 のカーソル（`tour`）と純関数（`annotation-tour.ts`）は撤回した（D79）。名前が残って
 * いれば誰かが戻したということである。ファイルの有無と、ストアの綴りの両方を見る。
 */
describe("案内のカーソル（D73）は消えている（D79）", () => {
  it("annotation-tour.ts が無く、annotations.ts に tour の識別子が無い", () => {
    const src = new URL("../src/", import.meta.url);
    expect(existsSync(new URL("annotation-tour.ts", src))).toBe(false);
    const source = readFileSync(new URL("annotations.ts", src), "utf8");
    expect(source).not.toMatch(/\btour\b/i);
    expect(source).not.toContain("nextTourIndex");
  });
});
