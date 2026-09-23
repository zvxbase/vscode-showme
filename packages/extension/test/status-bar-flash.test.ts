import Module from "node:module";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * **点滅の4口が、エージェント由来の文字列を画面に載せる前に無害化しているか**を、
 * `StatusBarItem.text` と `setStatusBarMessage` に**実際に渡った文字列**で見る
 * （`decorations-repaint.test.ts` と同じ流儀: 帳簿ではなく書き手を見る）。
 *
 * `status-bar.test.ts` は純関数 `statusView` しか見ていないので、`flashMiss` などから
 * `forDisplay` を落としても全部緑だった。無害化の中身は protocol の `sanitizeStatusText`
 * 1つ（不変条件7）で、その効果は `sanitize.test.ts` が固定している:
 * `$(` は `$ (` に割られ、改行は `\n` の2文字に、U+202E は `\u202e` の6文字になる。
 * ここではその**効果が4口すべてに及んでいる**ことを主張する。
 */

const fake = {
  item: {
    text: "",
    tooltip: "" as string | undefined,
    command: undefined as string | undefined,
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
  },
  setStatusBarMessage: vi.fn(),
};

/**
 * `status-bar.ts` は `vscode` を **CJS の `require` で遅延取得する**（トップレベルで
 * value import すると純関数の検査が読み込めないため）。`vi.mock` は ESM の import
 * にしか効かないので、Node の解決器に偽物を登録する。`l10n.ts` も同じ `require` を
 * 通るが、偽物に `l10n` は**置かない** ―― `t()` は無ければ原文に引数を埋める。
 */
const FAKE_VSCODE_ID = "/__showme_fake__/vscode.cjs";
const fakeVscode = {
  window: {
    createStatusBarItem: vi.fn(() => fake.item),
    setStatusBarMessage: fake.setStatusBarMessage,
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
};
type Resolver = (request: string, ...rest: unknown[]) => string;
const moduleInternals = Module as unknown as {
  _resolveFilename: Resolver;
  _cache: NodeJS.Dict<Module>;
};
const originalResolve = moduleInternals._resolveFilename;
moduleInternals._resolveFilename = function (this: unknown, request, ...rest) {
  if (request === "vscode") return FAKE_VSCODE_ID;
  return originalResolve.call(this, request, ...rest);
};
moduleInternals._cache[FAKE_VSCODE_ID] = Object.assign(new Module(FAKE_VSCODE_ID), {
  filename: FAKE_VSCODE_ID,
  loaded: true,
  exports: fakeVscode,
});
afterAll(() => {
  moduleInternals._resolveFilename = originalResolve;
  delete moduleInternals._cache[FAKE_VSCODE_ID];
});

import { ShowMeStatusBar } from "../src/status-bar.js";

/** 攻撃文字列。U+202E は生で打たない（`source-hygiene.test.ts`）。 */
const HOSTILE = ["$(check) OK.md", "a\nb.md", "x\u202ey.md"] as const;

/** 無害化の**文書化された効果**（`sanitize.test.ts` に逐語）。 */
function expectSanitized(text: string, label: string): void {
  expect(text, `${label}: codicon 記法が生きている`).not.toContain("$(");
  expect(text, `${label}: 改行が生きている`).not.toContain("\n");
  expect(text, `${label}: 双方向オーバーライドが生きている`).not.toContain("\u202e");
}

/**
 * `item.text` は**我々の** codicon 1つで始まる（`t()` の外に置いてあり、無害化に
 * 通していない）。それを外した残りに `$(` が無いことを見る ―― 先頭ごと見ると
 * 「我々の codicon まで壊れた」と「攻撃の codicon が生きている」が同じ赤になる。
 */
function expectItemTextSanitized(text: string, label: string): string {
  const own = /^\$\([a-z-]+\) /.exec(text);
  expect(own, `${label}: 我々の codicon で始まっていない: ${text}`).not.toBeNull();
  const rest = text.slice(own?.[0].length ?? 0);
  expectSanitized(rest, label);
  return rest;
}

/** `setStatusBarMessage` の**最後の**呼び出しの本文。 */
function lastMessage(): string {
  const calls = fake.setStatusBarMessage.mock.calls;
  const last = calls[calls.length - 1];
  expect(last, "setStatusBarMessage が呼ばれていない").toBeDefined();
  return String(last?.[0]);
}

describe("ShowMeStatusBar の点滅は攻撃文字列を無害化して載せる", () => {
  let bar: ShowMeStatusBar;

  beforeEach(() => {
    vi.useFakeTimers();
    fake.setStatusBarMessage.mockClear();
    bar = new ShowMeStatusBar(true, "stage");
  });

  afterEach(() => {
    bar.dispose();
    vi.useRealTimers();
  });

  const flashes: {
    name: string;
    call: (path: string, needle: string) => void;
    /** `needle` が画面に載る口か（`flashRateLimited` / `flashMarked` は path だけ）。 */
    takesNeedle: boolean;
    /** 表示に残るはずの断片（無害化した**後**の形）。落としすぎも赤にする。 */
    keeps: string;
  }[] = [
    {
      name: "flashMiss",
      call: (p, n) => bar.flashMiss(p, n),
      takesNeedle: true,
      keeps: "not found in",
    },
    {
      name: "flashManyMatches",
      call: (p, n) => bar.flashManyMatches(p, n),
      takesNeedle: true,
      keeps: "multiple matches in",
    },
    {
      name: "flashRateLimited",
      call: (p) => bar.flashRateLimited(p),
      takesNeedle: false,
      keeps: "rate limited",
    },
    {
      name: "flashMarked",
      call: (p) => bar.flashMarked(p, 3),
      takesNeedle: false,
      keeps: "marked",
    },
  ];

  /** 実際に画面まで届いた攻撃文字列の数（0件でも「無害化されている」は真になる）。 */
  let fed = 0;

  for (const flash of flashes) {
    for (const hostile of HOSTILE) {
      it(`${flash.name}: path=${JSON.stringify(hostile)}`, () => {
        flash.call(hostile, "needle");
        fed += 1;
        expectItemTextSanitized(fake.item.text, `${flash.name} item.text`);
        expectSanitized(lastMessage(), `${flash.name} message`);
        // 良性の部分は残っている（検査は両方向に当てる）。
        expect(fake.item.text).toContain(flash.keeps);
        expect(lastMessage()).toContain("ShowMe");
      });

      if (!flash.takesNeedle) continue;
      it(`${flash.name}: needle=${JSON.stringify(hostile)}`, () => {
        flash.call("src/ok.ts", hostile);
        fed += 1;
        // needle は本文（メッセージ）にだけ載る。item.text は path だけ。
        expectSanitized(lastMessage(), `${flash.name} message`);
        expect(lastMessage()).toContain("ShowMe");
        expect(fake.item.text).toContain("src/ok.ts");
      });
    }
  }

  it("flashMarked は path:line（1始まり）を本文とメッセージの両方に出す", () => {
    bar.flashMarked("src/a.ts", 3);
    expect(fake.item.text).toBe("$(bookmark) ShowMe: marked src/a.ts:3");
    expect(lastMessage()).toBe(
      "ShowMe: the agent marked src/a.ts:3 (open the file to see the highlight)",
    );
    // **我々の** codicon は `t()` の外にあり、無害化で壊れていない。
    expect(fake.item.text.startsWith("$(bookmark) ")).toBe(true);
  });

  it("5秒後に通常の表示へ戻る（点滅は残らない）", () => {
    bar.flashMarked("src/a.ts", 3);
    expect(fake.item.text).toContain("marked");
    vi.advanceTimersByTime(5000);
    expect(fake.item.text).not.toContain("marked");
    expect(fake.item.text).toContain("ShowMe: On");
  });

  it("攻撃を食わせた件数: path は4口 × 3、needle は2口 × 3", () => {
    // 0件でも「無害化されている」は真になるので、食わせた数を主張する（この it は
    // 宣言順で最後に走る）。
    expect(fed).toBe(4 * 3 + 2 * 3);
  });
});
