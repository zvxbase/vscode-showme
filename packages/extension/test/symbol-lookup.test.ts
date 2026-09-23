import { describe, expect, it } from "vitest";
import {
  SYMBOL_PROBE_DELAYS_MS,
  collectSymbolRanges,
  probeDocumentSymbols,
  probeUntilNonEmpty,
  symbolUnavailableReason,
} from "../src/symbol-lookup.js";

/**
 * シンボル解決の判断ロジック（設計書 §3.4）。
 *
 * ここが `vscode` を値 import していないので、**「1回で諦めていないか」を
 * 単体で確かめられる**。実機でしか判別しない振る舞いにしてはいけない ――
 * 実測（Task 0）で `.json` のシンボルは1回目の呼び出しでは返らなかった。
 */

/** 待ち時間を記録するだけの偽の sleep（実時間を使わない）。 */
function fakeSleep(): { sleep: (ms: number) => Promise<void>; waited: number[] } {
  const waited: number[] = [];
  return {
    waited,
    sleep: async (ms: number) => {
      waited.push(ms);
    },
  };
}

describe("probeDocumentSymbols — 1回引いて諦めない", () => {
  it("1回目で返れば引き直さない", async () => {
    const { sleep, waited } = fakeSleep();
    let calls = 0;
    const out = await probeDocumentSymbols(async () => {
      calls += 1;
      return ["a"];
    }, sleep);
    expect(out).toEqual(["a"]);
    expect(calls).toBe(1);
    expect(waited).toEqual([]);
  });

  /**
   * **この検査が「1回で諦める実装」の判別器である。**
   *
   * 実測: 制限モードの `.json` は1回目に `undefined`、2回目に一覧を返した
   * （言語拡張がまだ起動していない）。1回引いて `undefined` なら
   * `no-provider`、という実装は、実際には動く言語に対して嘘をつく。
   */
  it("1回目が undefined でも、2回目で返れば返す", async () => {
    const { sleep, waited } = fakeSleep();
    let calls = 0;
    const out = await probeDocumentSymbols(async () => {
      calls += 1;
      return calls === 1 ? undefined : ["json-key"];
    }, sleep);
    expect(out).toEqual(["json-key"]);
    expect(calls).toBe(2);
    expect(waited).toEqual([SYMBOL_PROBE_DELAYS_MS[0]]);
  });

  it("最後まで undefined なら undefined（引き直しの回数は表のぶんだけ）", async () => {
    const { sleep, waited } = fakeSleep();
    let calls = 0;
    const out = await probeDocumentSymbols(async () => {
      calls += 1;
      return undefined;
    }, sleep);
    expect(out).toBeUndefined();
    expect(calls).toBe(SYMBOL_PROBE_DELAYS_MS.length + 1);
    expect(waited).toEqual([...SYMBOL_PROBE_DELAYS_MS]);
  });

  /**
   * 空配列を「一覧が取れた」と読まない。
   *
   * 読むと、そこから `not-found`（＝その名前は無い）を名乗ることになる。
   * `not-found` は一覧が取れたときにしか名乗れない（設計書 §3.4）。
   */
  it("最後まで空配列なら undefined に畳む（空を一覧と呼ばない）", async () => {
    const { sleep } = fakeSleep();
    const out = await probeDocumentSymbols(async () => [], sleep);
    expect(out).toBeUndefined();
  });

  it("待ちの合計に上限がある（人間の画面を止めない）", () => {
    const total = SYMBOL_PROBE_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThanOrEqual(2000);
  });
});

describe("collectSymbolRanges", () => {
  const documentSymbols = [
    {
      name: "outer",
      range: { start: { line: 0 }, end: { line: 9 } },
      children: [
        { name: "target", range: { start: { line: 2 }, end: { line: 4 } }, children: [] },
        { name: "other", range: { start: { line: 5 }, end: { line: 6 } } },
      ],
    },
  ];

  it("入れ子のシンボルも見つけ、1始まりの行に直す", () => {
    expect(collectSymbolRanges(documentSymbols, "target")).toEqual([{ startLine: 3, endLine: 5 }]);
  });

  it("名前は完全一致（部分一致で別の場所を開かない）", () => {
    expect(collectSymbolRanges(documentSymbols, "targ")).toEqual([]);
    expect(collectSymbolRanges(documentSymbols, "outer")).toEqual([{ startLine: 1, endLine: 10 }]);
  });

  /**
   * `SymbolInformation`（平ら・`location.range`）も受ける。
   *
   * プロバイダによってどちらの形が返るかが違う。片方しか読まない実装は
   * 「プロバイダはあるのに毎回 not-found」という形で静かに壊れる。
   */
  it("SymbolInformation の形（location.range）も読む", () => {
    const flat = [
      { name: "target", location: { range: { start: { line: 7 }, end: { line: 8 } } } },
    ];
    expect(collectSymbolRanges(flat, "target")).toEqual([{ startLine: 8, endLine: 9 }]);
  });

  it("同じ名前が複数あれば文書順に全部返す（候補になる）", () => {
    const many = [
      { name: "t", range: { start: { line: 0 }, end: { line: 0 } } },
      { name: "t", range: { start: { line: 4 }, end: { line: 4 } } },
    ];
    expect(collectSymbolRanges(many, "t")).toEqual([
      { startLine: 1, endLine: 1 },
      { startLine: 5, endLine: 5 },
    ]);
  });

  it("形の違うものを渡されても落ちない（プロバイダは他人の実装）", () => {
    expect(collectSymbolRanges([null, 1, "x", {}, { name: "t" }], "t")).toEqual([]);
  });

  it("深い入れ子でも止まる（循環した木を返されても戻ってくる）", () => {
    // 自分を子に持つ節。上限が無ければここで戻ってこない。
    const cyclic: Record<string, unknown> = {
      name: "loop",
      range: { start: { line: 0 }, end: { line: 0 } },
    };
    cyclic.children = [cyclic];
    const found = collectSymbolRanges([cyclic], "loop");
    expect(found.length).toBeGreaterThan(0);
    expect(found.length).toBeLessThan(64);
  });
});

describe("symbolUnavailableReason（設計書 §3.4 の表）", () => {
  it("信頼モードでは常に no-provider（制限モードのせいにしない）", () => {
    expect(
      symbolUnavailableReason({ relPath: "src/a.ts", languageId: "typescript", isTrusted: true }),
    ).toBe("no-provider");
  });

  it("制限モード＋信頼に依存する言語は restricted-mode", () => {
    for (const languageId of ["typescript", "typescriptreact", "javascript", "javascriptreact"]) {
      expect(symbolUnavailableReason({ relPath: "src/a", languageId, isTrusted: false })).toBe(
        "restricted-mode",
      );
    }
  });

  /**
   * 判定材料が**消えた**ときの受け皿。
   *
   * 実測 1.137.0 では制限モードでも `.ts` は `languageId: "typescript"` の
   * ままで、この経路は効いていない（統合テストで測った）。塞いでいるのは
   * 「言語寄与が消えて `plaintext` になる」構成で、そのとき言語 id だけの
   * 判定は制限モードのときだけ外れ、`no-provider` と名乗る ―― 人間が信頼を
   * 与えれば直る問題を、直しようのない問題に見せる向きの誤りである。
   */
  it("言語 id が plaintext に潰れても、拡張子で restricted-mode を名乗る", () => {
    for (const relPath of ["src/a.ts", "src/a.tsx", "src/a.mjs", "src/a.JSX"]) {
      expect(symbolUnavailableReason({ relPath, languageId: "plaintext", isTrusted: false })).toBe(
        "restricted-mode",
      );
    }
    expect(symbolUnavailableReason({ relPath: "src/a.ts", isTrusted: false })).toBe(
      "restricted-mode",
    );
  });

  it("制限モードでも動く言語は no-provider（JSON / Markdown / CSS）", () => {
    expect(
      symbolUnavailableReason({ relPath: "data/a.json", languageId: "json", isTrusted: false }),
    ).toBe("no-provider");
    expect(
      symbolUnavailableReason({ relPath: "docs/a.md", languageId: "markdown", isTrusted: false }),
    ).toBe("no-provider");
    expect(
      symbolUnavailableReason({ relPath: "style.css", languageId: "css", isTrusted: false }),
    ).toBe("no-provider");
  });

  it("知らない言語は no-provider（制限モードのせいだと決めつけない）", () => {
    expect(symbolUnavailableReason({ relPath: "a.zig", languageId: "zig", isTrusted: false })).toBe(
      "no-provider",
    );
  });

  it("not-found はここからは返らない（一覧が取れたときにしか名乗れない）", () => {
    const cases = [
      { relPath: "src/a.ts", languageId: "typescript", isTrusted: false },
      { relPath: "data/a.json", languageId: "json", isTrusted: false },
      { relPath: "src/a.ts", languageId: "typescript", isTrusted: true },
    ];
    for (const c of cases) {
      expect(["restricted-mode", "no-provider"]).toContain(symbolUnavailableReason(c));
    }
  });
});

describe("probeUntilNonEmpty（定義・参照と共有する引き直しの輪）", () => {
  const noSleep = async () => {};

  it("1回目が空・2回目が非空なら、2回目を返す", async () => {
    // 実地で観測した形: 再読み込み直後の1回目の find_definition が not-found、
    // 数秒後の2回目が当たった。tsserver がプロジェクトを読む前は空で応答する。
    const answers: (readonly string[] | undefined)[] = [[], ["hit"]];
    const out = await probeUntilNonEmpty(async () => answers.shift(), noSleep, [1, 1, 1]);
    expect(out).toEqual(["hit"]);
  });

  it("最後まで空なら **空をそのまま返す**（undefined に畳まない）", async () => {
    // シンボル一覧と違って、定義が本当に無いときの `[]` は正当な答えである。
    // `undefined` に畳むと `no-provider` になり、逆向きに嘘をつく。
    const out = await probeUntilNonEmpty(async () => [], noSleep, [1, 1]);
    expect(out).toEqual([]);
  });

  it("最後まで undefined なら undefined（プロバイダ不在）", async () => {
    const out = await probeUntilNonEmpty(async () => undefined, noSleep, [1, 1]);
    expect(out).toBeUndefined();
  });

  it("非空が来た時点で止まる（無駄に待たない）", async () => {
    let calls = 0;
    const out = await probeUntilNonEmpty(
      async () => {
        calls += 1;
        return ["x"];
      },
      noSleep,
      [1, 1, 1],
    );
    expect(out).toEqual(["x"]);
    expect(calls).toBe(1);
  });

  it("probeDocumentSymbols は同じ輪を使っている（畳み方だけが違う）", async () => {
    const out = await probeDocumentSymbols(async () => [], noSleep, [1]);
    expect(out).toBeUndefined();
  });
});
