import { describe, expect, it } from "vitest";
import { MAX_CANDIDATES } from "./location.js";
import { MAX_RESOLVE_BYTES, type ResolveDeps, resolveLocation } from "./resolve-location.js";

const FILE = [
  "const a = 1;",
  "function parseHeader() {",
  "  return null;",
  "}",
  "parseHeader();",
].join("\n");

function deps(over: Partial<ResolveDeps> = {}): ResolveDeps {
  return {
    readText: () => FILE,
    findSymbol: () => [{ startLine: 2, endLine: 4 }],
    isRedacted: () => false,
    ...over,
  };
}

describe("resolveLocation", () => {
  it("リテラル一致が1件なら範囲を確定する", () => {
    const r = resolveLocation({ path: "a.ts", text: "function parseHeader" }, deps());
    expect(r.match).toBe("one");
    expect(r.resolvedBy).toBe("text");
    expect(r.range).toEqual({ startLine: 2, endLine: 2 });
  });

  it("見つからないときは none と not-found を返す", () => {
    const r = resolveLocation({ path: "a.ts", text: "nonexistent" }, deps());
    expect(r.match).toBe("none");
    expect(r.reason).toBe("not-found");
    expect(r.range).toBeUndefined();
  });

  it("複数当たっても正確な件数は返さない", () => {
    const r = resolveLocation({ path: "a.ts", text: "parseHeader" }, deps());
    expect(r.match).toBe("many");
    // 件数を漏らすキーが存在しないこと
    expect(r).not.toHaveProperty("count");
    expect(r).not.toHaveProperty("total");
    expect(r).not.toHaveProperty("matchCount");
  });

  it("候補の長さは件数を部分的に明かす（承知の上で許容している性質）", () => {
    // ちょうど2件のとき candidates.length === 2 になり「ちょうど2件」が分かる。
    // 3件以上は 3 で頭打ちになるので「3件以上」としか分からない。
    //
    // これは無音のオラクルの帯域を完全には塞げていないが、意図的に許容している:
    // 一次的なオラクルは none / 非 none の区別であり、位置解決を提供する以上
    // 避けようがない。候補行を返すのは occurrence の当て直しで往復を増やさない
    // ためで、実際の防御は除外リスト・レート制限・空振りの可視化が担う。
    // 詳細は設計書 §4.1 ③。この性質が黙って変わらないようテストで固定する。
    const two = ["needle", "needle", "other"].join("\n");
    const r2 = resolveLocation({ path: "a.ts", text: "needle" }, deps({ readText: () => two }));
    expect(r2.candidates?.length).toBe(2);

    const four = ["needle", "needle", "needle", "needle"].join("\n");
    const r4 = resolveLocation({ path: "a.ts", text: "needle" }, deps({ readText: () => four }));
    expect(r4.candidates?.length).toBe(MAX_CANDIDATES);
  });

  it("候補は最大3件に切り詰める", () => {
    const many = Array.from({ length: 20 }, () => "needle").join("\n");
    const r = resolveLocation({ path: "a.ts", text: "needle" }, deps({ readText: () => many }));
    expect(r.match).toBe("many");
    expect(r.candidates?.length).toBe(MAX_CANDIDATES);
  });

  it("occurrence で候補から1つ選べる", () => {
    const r = resolveLocation({ path: "a.ts", text: "parseHeader", occurrence: 2 }, deps());
    expect(r.match).toBe("one");
    expect(r.range).toEqual({ startLine: 5, endLine: 5 });
  });

  it("occurrence が範囲外なら none", () => {
    const r = resolveLocation({ path: "a.ts", text: "parseHeader", occurrence: 99 }, deps());
    expect(r.match).toBe("none");
    expect(r.reason).toBe("not-found");
  });

  it("除外パスは解決の入口で拒否する（内容を読みに行かない）", () => {
    let read = false;
    const r = resolveLocation(
      { path: ".env", text: "AKIA" },
      deps({
        isRedacted: () => true,
        readText: () => {
          read = true;
          return FILE;
        },
      }),
    );
    expect(r.match).toBe("none");
    expect(r.reason).toBe("excluded-path");
    expect(read).toBe(false);
  });

  it("不正なパスは invalid-path で拒否する", () => {
    const r = resolveLocation({ path: "../../../etc/passwd", text: "root" }, deps());
    expect(r.match).toBe("none");
    expect(r.reason).toBe("invalid-path");
  });

  it("symbol プロバイダが無いときは no-provider を名指しで返す", () => {
    const r = resolveLocation(
      { path: "a.ts", symbol: "parseHeader" },
      deps({ findSymbol: () => undefined }),
    );
    expect(r.match).toBe("none");
    expect(r.reason).toBe("no-provider");
  });

  it("symbol が引けるときは範囲を返す", () => {
    const r = resolveLocation({ path: "a.ts", symbol: "parseHeader" }, deps());
    expect(r.resolvedBy).toBe("symbol");
    expect(r.range).toEqual({ startLine: 2, endLine: 4 });
  });

  it("text は symbol より優先される", () => {
    const r = resolveLocation({ path: "a.ts", text: "const a", symbol: "parseHeader" }, deps());
    expect(r.resolvedBy).toBe("text");
  });

  it("lines は最後の手段として使える", () => {
    const r = resolveLocation({ path: "a.ts", lines: { start: 2, end: 3 } }, deps());
    expect(r.resolvedBy).toBe("lines");
    expect(r.range).toEqual({ startLine: 2, endLine: 3 });
  });

  it("ファイル末尾を超える lines は範囲に丸める", () => {
    const r = resolveLocation({ path: "a.ts", lines: { start: 4, end: 999 } }, deps());
    expect(r.range).toEqual({ startLine: 4, endLine: 5 });
  });

  it("開始が終了より後の lines は none", () => {
    const r = resolveLocation({ path: "a.ts", lines: { start: 4, end: 2 } }, deps());
    expect(r.match).toBe("none");
  });

  it("セレクタが1つも無ければ no-selector", () => {
    const r = resolveLocation({ path: "a.ts" }, deps());
    expect(r.match).toBe("none");
    expect(r.reason).toBe("no-selector");
  });

  it("ファイルが読めなければ not-found", () => {
    const r = resolveLocation({ path: "a.ts", text: "x" }, deps({ readText: () => undefined }));
    expect(r.match).toBe("none");
    expect(r.reason).toBe("not-found");
  });

  it("内容そのものを返り値に含めない", () => {
    const r = resolveLocation({ path: "a.ts", text: "function parseHeader" }, deps());
    expect(JSON.stringify(r)).not.toContain("parseHeader");
    expect(JSON.stringify(r)).not.toContain("return null");
  });
});

describe("resolveLocation — 正規化済みパス（レート制限の正準キー）", () => {
  it("綴りが違っても同じ正規化済みパスを返す", () => {
    // 呼び出し側が生の loc.path を鍵にすると、この4つが別々のバケットになり、
    // 綴り替えだけでレート制限を何倍にもできる。正準キーを渡すのは protocol の責務。
    for (const spelling of [".env", "./.env", ".//.env", "a/../.env"]) {
      const r = resolveLocation({ path: spelling, text: "x" }, deps({ isRedacted: () => true }));
      expect(r.reason).toBe("excluded-path");
      expect(r.normalizedPath).toBe(".env");
    }
  });

  it("解決に成功した経路にも入る", () => {
    const one = resolveLocation({ path: "./a.ts", text: "const a" }, deps());
    expect(one.match).toBe("one");
    expect(one.normalizedPath).toBe("a.ts");

    const many = resolveLocation({ path: "./a.ts", text: "parseHeader" }, deps());
    expect(many.match).toBe("many");
    expect(many.normalizedPath).toBe("a.ts");

    const bySymbol = resolveLocation({ path: "./a.ts", symbol: "parseHeader" }, deps());
    expect(bySymbol.normalizedPath).toBe("a.ts");

    const byLines = resolveLocation({ path: "./a.ts", lines: { start: 1, end: 2 } }, deps());
    expect(byLines.normalizedPath).toBe("a.ts");
  });

  it("見つからない経路にも入る", () => {
    const notFound = resolveLocation({ path: "./a.ts", text: "nonexistent" }, deps());
    expect(notFound.normalizedPath).toBe("a.ts");

    const noSelector = resolveLocation({ path: "./a.ts" }, deps());
    expect(noSelector.reason).toBe("no-selector");
    expect(noSelector.normalizedPath).toBe("a.ts");

    const noProvider = resolveLocation(
      { path: "./a.ts", symbol: "s" },
      deps({ findSymbol: () => undefined }),
    );
    expect(noProvider.normalizedPath).toBe("a.ts");
  });

  it("invalid-path のときだけ入らない（正規化そのものが失敗しているため）", () => {
    const r = resolveLocation({ path: "../../../etc/passwd", text: "root" }, deps());
    expect(r.reason).toBe("invalid-path");
    expect(r.normalizedPath).toBeUndefined();
  });
});

describe("resolveLocation — 読み出しの上限", () => {
  it("上限を超える内容は解決に使わない", () => {
    const big = "x\n".repeat(MAX_RESOLVE_BYTES);
    const r = resolveLocation({ path: "a.ts", text: "x" }, deps({ readText: () => big }));
    expect(r.match).toBe("none");
    expect(r.reason).toBe("not-found");
  });

  it("上限ちょうどは通す", () => {
    const exact = "x".repeat(MAX_RESOLVE_BYTES);
    const r = resolveLocation({ path: "a.ts", text: "x" }, deps({ readText: () => exact }));
    expect(r.match).toBe("one");
  });

  it("lines 経路にも同じ上限が掛かる", () => {
    const big = "x".repeat(MAX_RESOLVE_BYTES + 1);
    const r = resolveLocation(
      { path: "a.ts", lines: { start: 1, end: 2 } },
      deps({ readText: () => big }),
    );
    expect(r.match).toBe("none");
    expect(r.reason).toBe("not-found");
  });
});

describe("列は両方そろったときだけ通る（設計 D34）", () => {
  const readText = () => "aaa\nbbb\nccc\n";

  it("両方そろえば範囲に入る", () => {
    const out = resolveLocation(
      { path: "a.txt", lines: { start: 1, end: 1, startColumn: 1, endColumn: 3 } },
      deps({ readText, findSymbol: () => undefined }),
    );
    expect(out.range).toEqual({ startLine: 1, endLine: 1, startColumn: 1, endColumn: 3 });
  });

  it("片方だけなら入らない（行全体になる）", () => {
    const out = resolveLocation(
      { path: "a.txt", lines: { start: 1, end: 1, startColumn: 1 } },
      deps({ readText, findSymbol: () => undefined }),
    );
    expect(out.range).toEqual({ startLine: 1, endLine: 1 });
  });

  it("列 0 も指定として扱う", () => {
    const out = resolveLocation(
      { path: "a.txt", lines: { start: 2, end: 2, startColumn: 0, endColumn: 2 } },
      deps({ readText, findSymbol: () => undefined }),
    );
    expect(out.range).toEqual({ startLine: 2, endLine: 2, startColumn: 0, endColumn: 2 });
  });

  it("text で解決したときは列を持たない（行全体のまま）", () => {
    // text 照合は行単位なので、列を名乗れない。名乗ると嘘の精度になる。
    const out = resolveLocation(
      { path: "a.txt", text: "bbb" },
      deps({ readText, findSymbol: () => undefined }),
    );
    expect(out.range).toEqual({ startLine: 2, endLine: 2 });
  });
});
