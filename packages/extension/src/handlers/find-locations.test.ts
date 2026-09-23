import type { FoundLocation, Location } from "@zvx/vscode-showme-protocol";
import { describe, expect, it } from "vitest";
import {
  type LanguageSurface,
  handleFindDefinition,
  handleFindReferences,
} from "./find-locations.js";

const log = { info: () => {} };
const LOCATION: Location = { path: "src/a.ts", text: "handle" };

function fakeLanguage(overrides: Partial<LanguageSurface> = {}): LanguageSurface {
  return {
    isTrusted: () => true,
    async resolveAnchor() {
      return { ok: true as const, anchor: { path: "src/a.ts", line: 10, column: 5 } };
    },
    async definitions() {
      return [{ path: "src/b.ts", line: 3, column: 2 }];
    },
    async references() {
      return [{ path: "src/c.ts", line: 7, column: 0 }];
    },
    ...overrides,
  };
}

function deps(language: LanguageSurface, extra: readonly string[] = []) {
  return { language, extraRedactedPatterns: () => extra, log };
}

describe("find_definition", () => {
  it("位置だけを返す（中身は返さない）", async () => {
    const result = await handleFindDefinition({ location: LOCATION }, deps(fakeLanguage()));
    expect(result.match).toBe("one");
    expect(result.locations).toEqual([{ path: "src/b.ts", line: 3, column: 2 }]);
    // **中身を運ぶ欄が無いことを、形で確かめる。**
    const keys = new Set(Object.keys(result.locations[0] ?? {}));
    expect([...keys].sort()).toEqual(["column", "line", "path"]);
  });

  it("解決できなければ not-found", async () => {
    const result = await handleFindDefinition(
      { location: LOCATION },
      deps(fakeLanguage({ resolveAnchor: async () => ({ ok: false, reason: "not-found" }) })),
    );
    expect(result.match).toBe("none");
    expect(result.reason).toBe("not-found");
  });

  it("制限モードでプロバイダが引けなければ restricted-mode", async () => {
    const result = await handleFindDefinition(
      { location: LOCATION },
      deps(fakeLanguage({ isTrusted: () => false, definitions: async () => undefined })),
    );
    expect(result.reason).toBe("restricted-mode");
  });

  it("信頼モードでプロバイダが引けなければ no-provider", async () => {
    const result = await handleFindDefinition(
      { location: LOCATION },
      deps(fakeLanguage({ definitions: async () => undefined })),
    );
    expect(result.reason).toBe("no-provider");
  });

  it("回数制限を超えたら rate-limited を返す（例外にしない）", async () => {
    // 位置を教えるだけの道具なので、制限は失敗ではなく「今は答えられない」である。
    const result = await handleFindDefinition(
      { location: LOCATION },
      {
        ...deps(fakeLanguage()),
        allowCall: () => false,
      },
    );
    expect(result.reason).toBe("rate-limited");
    expect(result.locations).toEqual([]);
  });
});

describe("find_references", () => {
  it("秘匿パスの中の位置は返らない", async () => {
    const found: FoundLocation[] = [
      { path: "src/c.ts", line: 7, column: 0 },
      { path: ".env", line: 1, column: 0 },
      { path: "config/secrets.pem", line: 2, column: 0 },
    ];
    const result = await handleFindReferences(
      { location: LOCATION },
      deps(fakeLanguage({ references: async () => found })),
    );
    expect(result.locations.map((l) => l.path)).toEqual(["src/c.ts"]);
  });

  it("落とした本数も返さない（本数そのものが情報になる）", async () => {
    // かつての `openPathsHidden`（増分4 で削除）は「タブが何枚あるか」
    // ＝人間の画面の量だった。
    // ここは「その名前が .env の中で何回使われているか」なので、本数が漏れる。
    const found: FoundLocation[] = [
      { path: "src/c.ts", line: 7, column: 0 },
      ...Array.from({ length: 5 }, (_, i) => ({ path: ".env", line: i + 1, column: 0 })),
    ];
    const result = await handleFindReferences(
      { location: LOCATION },
      deps(fakeLanguage({ references: async () => found })),
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("Hidden");
    expect(serialized).not.toContain("5");
  });

  it("設定で足した除外パターンも効く", async () => {
    const found: FoundLocation[] = [
      { path: "src/c.ts", line: 1, column: 0 },
      { path: "private/notes.md", line: 1, column: 0 },
    ];
    const result = await handleFindReferences(
      { location: LOCATION },
      deps(fakeLanguage({ references: async () => found }), ["private/**"]),
    );
    expect(result.locations.map((l) => l.path)).toEqual(["src/c.ts"]);
  });

  it("includeDeclaration は既定 false で面に渡る", async () => {
    const seen: boolean[] = [];
    const language = fakeLanguage({
      references: async (_anchor, includeDeclaration) => {
        seen.push(includeDeclaration);
        return [];
      },
    });
    await handleFindReferences({ location: LOCATION }, deps(language));
    await handleFindReferences({ location: LOCATION, includeDeclaration: true }, deps(language));
    expect(seen).toEqual([false, true]);
  });

  it("秘匿パスを落として0件になったら not-found（no-provider ではない）", async () => {
    // **区別が要る。** 「引けなかった」と「引けたが全部隠した」は違う。
    const result = await handleFindReferences(
      { location: LOCATION },
      deps(fakeLanguage({ references: async () => [{ path: ".env", line: 1, column: 0 }] })),
    );
    expect(result.match).toBe("none");
    expect(result.reason).toBe("not-found");
  });
});

describe("パスの判断は面が持つ（レビューで見つかった CRITICAL）", () => {
  it("面が返した理由がそのまま結果になる（呼び出し側で決め直さない）", async () => {
    // **これが無かった。** 生のパスが `Uri.joinPath` に渡っていて、`..` は
    // 解決されるので、ホストの任意のファイルについてプロバイダを呼べた。
    // そして返る理由が「開けなかった」と「定義が無い」で分かれるので、
    // **ファイルの存在を1呼び出しずつ確かめられた**（S1 が塞ぐはずの無音のオラクル）。
    // 判断が2箇所に割れないことが要点。面が `invalid-path` と言ったら、
    // 呼び出し側はそれを写すだけである。
    for (const reason of ["invalid-path", "excluded-path", "not-found"] as const) {
      const language = fakeLanguage({ resolveAnchor: async () => ({ ok: false, reason }) });
      const result = await handleFindDefinition({ location: { path: "a.ts" } }, deps(language));
      expect(result.reason, reason).toBe(reason);
      expect(result.match).toBe("none");
      expect(result.locations).toEqual([]);
    }
  });

  it("面が拒否したらプロバイダを一度も呼ばない", async () => {
    // 呼んでから弾いても、開く副作用は既に起きている。
    let providerCalls = 0;
    const language = fakeLanguage({
      resolveAnchor: async () => ({ ok: false, reason: "excluded-path" }),
      definitions: async () => {
        providerCalls += 1;
        return [];
      },
    });
    const result = await handleFindDefinition({ location: { path: ".env" } }, deps(language));
    expect(result.reason).toBe("excluded-path");
    expect(providerCalls).toBe(0);
  });
});
