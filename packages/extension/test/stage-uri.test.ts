import { describe, expect, it } from "vitest";
import {
  STAGE_SCHEME_EDITABLE,
  STAGE_SCHEME_READONLY,
  effectiveStageScheme,
  isLegacyOwnershipUri,
  isStageScheme,
  relOfStagePath,
  stageOpenTarget,
  stageSchemeFor,
  stageUriPath,
} from "../src/stage-uri.js";

/**
 * 映しの URI の綴り（設計 D81 / D84）。
 *
 * ここは vscode に触らない純粋な関数だけを持つ ―― `showme-ro:` / `showme-rw:`
 * という2つのスキームと、ワークスペース相対パスとの間の変換規則が正しいかを
 * vitest だけで確かめられるようにするため（配線は統合テストが見る）。
 *
 * 脱出・NUL・コロンを拒む判断そのものは protocol の `normalizeWorkspaceRelative`
 * が持つ（`paths.ts`）。ここで確かめるのは、その関門を URI の path 部の綴り
 * （先頭の "/" を1つ剥がす、など）に正しく繋いでいるかだけ ―― 秘匿判定
 * （`.env` を隠すかどうか）はここの仕事ではない（関門の仕事）。
 */
describe("stageSchemeFor（D84 の分岐の唯一の場所）", () => {
  it("agentTabs が false なら editable に関わらず file", () => {
    expect(stageSchemeFor({ agentTabs: false, editable: false })).toBe("file");
    expect(stageSchemeFor({ agentTabs: false, editable: true })).toBe("file");
  });

  it("agentTabs が true かつ editable が false なら読み取り専用の映し", () => {
    expect(stageSchemeFor({ agentTabs: true, editable: false })).toBe(STAGE_SCHEME_READONLY);
  });

  it("agentTabs が true かつ editable が true なら編集できる映し", () => {
    expect(stageSchemeFor({ agentTabs: true, editable: true })).toBe(STAGE_SCHEME_EDITABLE);
  });
});

describe("isLegacyOwnershipUri（own を記録で決める URI か。映しは記録しない ―― D82）", () => {
  it("映しの2つは false、file: と他は true", () => {
    expect(isLegacyOwnershipUri({ scheme: "showme-ro" })).toBe(false);
    expect(isLegacyOwnershipUri({ scheme: "showme-rw" })).toBe(false);
    expect(isLegacyOwnershipUri({ scheme: "file" })).toBe(true);
    expect(isLegacyOwnershipUri({ scheme: "untitled" })).toBe(true);
    // 大文字違いは映しではない（スキームの綴りは stageUriFor が作る形だけ）。
    expect(isLegacyOwnershipUri({ scheme: "SHOWME-RO" })).toBe(true);
  });
});

describe("isStageScheme", () => {
  it("映しの2つのスキームだけ true", () => {
    expect(isStageScheme(STAGE_SCHEME_READONLY)).toBe(true);
    expect(isStageScheme(STAGE_SCHEME_EDITABLE)).toBe(true);
  });

  it("file や似た綴りは false", () => {
    expect(isStageScheme("file")).toBe(false);
    expect(isStageScheme("showme")).toBe(false);
    expect(isStageScheme("showme-rox")).toBe(false);
  });
});

describe("stageUriPath と relOfStagePath の往復", () => {
  it("showme-ro で往復する", () => {
    expect(relOfStagePath(STAGE_SCHEME_READONLY, "", stageUriPath("src/a.ts"))).toBe("src/a.ts");
  });

  it("showme-rw で往復する", () => {
    expect(relOfStagePath(STAGE_SCHEME_EDITABLE, "", stageUriPath("src/a.ts"))).toBe("src/a.ts");
  });

  it("path 部は先頭に / を持つ", () => {
    expect(stageUriPath("src/a.ts")).toBe("/src/a.ts");
  });

  it("# と % を含む rel でも純粋な関数どうしでは往復する（実際の Uri.from 経由の往復は統合テストで確かめる）", () => {
    const rel = "docs/a#b%20c.md";
    expect(relOfStagePath(STAGE_SCHEME_READONLY, "", stageUriPath(rel))).toBe(rel);
  });
});

describe("authority（設計 D81: 映しの URI は authority を持たない）", () => {
  it("authority が空文字でなければ undefined（showme-ro://x/.env のような別名を作らせない）", () => {
    expect(relOfStagePath(STAGE_SCHEME_READONLY, "anything", "/.env")).toBeUndefined();
  });

  it("authority が空文字なら通る", () => {
    expect(relOfStagePath(STAGE_SCHEME_READONLY, "", "/src/a.ts")).toBe("src/a.ts");
  });
});

describe("relOfStagePath が undefined を返す場合", () => {
  it("映しのスキームでなければ undefined（file はそのまま file: を使う）", () => {
    expect(relOfStagePath("file", "", "/src/a.ts")).toBeUndefined();
  });

  it("先頭に / が無ければ undefined（映しの URI の path は常に絶対）", () => {
    expect(relOfStagePath(STAGE_SCHEME_READONLY, "", "src/a.ts")).toBeUndefined();
  });

  it(".. で脱出しようとするものは undefined", () => {
    expect(relOfStagePath(STAGE_SCHEME_READONLY, "", "/../etc/passwd")).toBeUndefined();
  });

  it("正規化しても脱出が残るものは undefined", () => {
    expect(relOfStagePath(STAGE_SCHEME_READONLY, "", "/a/../../x")).toBeUndefined();
  });

  it("先頭の / を1つ剥がしてもまだ絶対なものは undefined", () => {
    expect(relOfStagePath(STAGE_SCHEME_READONLY, "", "//etc/passwd")).toBeUndefined();
  });

  it("空文字は undefined", () => {
    expect(relOfStagePath(STAGE_SCHEME_READONLY, "", "")).toBeUndefined();
  });

  it("/ だけは undefined", () => {
    expect(relOfStagePath(STAGE_SCHEME_READONLY, "", "/")).toBeUndefined();
  });

  it("NUL を含むものは undefined", () => {
    expect(relOfStagePath(STAGE_SCHEME_READONLY, "", "/a\u0000b")).toBeUndefined();
  });

  it("コロンを含むものは undefined", () => {
    expect(relOfStagePath(STAGE_SCHEME_READONLY, "", "/.env::$DATA")).toBeUndefined();
  });

  it("秘匿の判定はここでしない（.env もそのまま通す）", () => {
    expect(relOfStagePath(STAGE_SCHEME_READONLY, "", "/.env")).toBe(".env");
  });

  it("末尾が / なら undefined（ファイルパスは / で終わらない）", () => {
    expect(relOfStagePath(STAGE_SCHEME_READONLY, "", "/src/a.ts/")).toBeUndefined();
  });

  it("末尾が \\ でも undefined（normalizeWorkspaceRelative が / に統一した後に末尾スラッシュへ変わる）", () => {
    expect(relOfStagePath(STAGE_SCHEME_READONLY, "", "/src/a.ts\\")).toBeUndefined();
  });

  it("途中の二重スラッシュは正規化後に綴りが変わるので undefined（別綴りは拒む）", () => {
    // normalizeWorkspaceRelative は "/a//b" を "a/b" に畳むが、stageUriPath("a/b") は
    // "/a/b" であって元の path "/a//b" とは綴りが違う。この食い違いを relOfStagePath が
    // 検査して拒むことで、同じ実体に対する別綴りの URI を作らせない（不変条件14 / D82）。
    expect(relOfStagePath(STAGE_SCHEME_READONLY, "", "/a//b")).toBeUndefined();
  });

  it("Windows 形式の脱出（バックスラッシュの ..）は undefined", () => {
    expect(relOfStagePath(STAGE_SCHEME_READONLY, "", "/..\\x")).toBeUndefined();
  });

  it("ドライブ相対（C:/x）は undefined", () => {
    expect(relOfStagePath(STAGE_SCHEME_READONLY, "", "/C:/x")).toBeUndefined();
  });

  it("UNC 風（\\\\server\\share）は undefined", () => {
    expect(relOfStagePath(STAGE_SCHEME_READONLY, "", "/\\\\server\\share")).toBeUndefined();
  });
});

describe("relOfStagePath は正しい綴りだけを受ける（別綴りの拒否を1箇所に）", () => {
  // 正規化すると同じ rel になるが、path の綴りそのものは違う。受け入れると同じ実体が
  // 2つの URI で開けてしまい、D82（所有は URI の綴りで決まる）が崩れる。
  it("二重スラッシュ（/src//a.ts）は undefined", () => {
    expect(relOfStagePath(STAGE_SCHEME_READONLY, "", "/src//a.ts")).toBeUndefined();
  });

  it("カレントディレクトリの . を含む（/src/./a.ts）は undefined", () => {
    expect(relOfStagePath(STAGE_SCHEME_READONLY, "", "/src/./a.ts")).toBeUndefined();
  });

  it("バックスラッシュ区切り（/src\\a.ts）は undefined", () => {
    expect(relOfStagePath(STAGE_SCHEME_READONLY, "", "/src\\a.ts")).toBeUndefined();
  });

  it("行き来する .. を含む（/x/../a.ts）は undefined", () => {
    expect(relOfStagePath(STAGE_SCHEME_READONLY, "", "/x/../a.ts")).toBeUndefined();
  });

  it("正準形の綴り（stageUriPath(rel) と同じ）はそのまま通る", () => {
    expect(relOfStagePath(STAGE_SCHEME_READONLY, "", stageUriPath("src/a.ts"))).toBe("src/a.ts");
    expect(relOfStagePath(STAGE_SCHEME_EDITABLE, "", stageUriPath("a/b"))).toBe("a/b");
  });
});

/**
 * `effectiveStageScheme` ― 舞台のスキームを決める**唯一の関数**。
 *
 * `showme.stage.enabled` を切った「印だけ」（D76）は、`agentTabs` / `editable` の
 * 値に関わらず常に `"file"`（映しを一切使わない）。それ以外は `stageSchemeFor` に
 * そのまま委ねる ―― 分岐を2箇所に分けない。
 */
describe("effectiveStageScheme（舞台のスキームを決める唯一の関数）", () => {
  it("stageFeature が false なら、agentTabs / editable に関わらず file（D76 の印だけ）", () => {
    expect(effectiveStageScheme({ stageFeature: false, agentTabs: false, editable: false })).toBe(
      "file",
    );
    expect(effectiveStageScheme({ stageFeature: false, agentTabs: true, editable: false })).toBe(
      "file",
    );
    expect(effectiveStageScheme({ stageFeature: false, agentTabs: true, editable: true })).toBe(
      "file",
    );
  });

  it("stageFeature が true かつ agentTabs が false なら file", () => {
    expect(effectiveStageScheme({ stageFeature: true, agentTabs: false, editable: false })).toBe(
      "file",
    );
    expect(effectiveStageScheme({ stageFeature: true, agentTabs: false, editable: true })).toBe(
      "file",
    );
  });

  it("stageFeature が true かつ agentTabs が true かつ editable が false なら読み取り専用の映し", () => {
    expect(effectiveStageScheme({ stageFeature: true, agentTabs: true, editable: false })).toBe(
      STAGE_SCHEME_READONLY,
    );
  });

  it("stageFeature が true かつ agentTabs が true かつ editable が true なら編集できる映し", () => {
    expect(effectiveStageScheme({ stageFeature: true, agentTabs: true, editable: true })).toBe(
      STAGE_SCHEME_EDITABLE,
    );
  });
});

/**
 * `stageOpenTarget` ― `show_code` 1回の「どのスキームで開き、開いた文書を記録するか」を
 * 決める**唯一の関数**（D87 の `realFile` を D84 の分岐に合流させる）。
 *
 * `realFile: true` は本物のファイル（`file:`）を開くが、それは人間のタブであって記録しない
 * （own にしない。`agentTabs` の値に関わらず）。`realFile` なしは今までどおり: スキームは
 * `effectiveStageScheme`、記録は `isLegacyOwnershipUri` がそのスキームに言うとおり。
 */
describe("stageOpenTarget（show_code 1回の開き方と記録を決める唯一の関数）", () => {
  const combos = [false, true].flatMap((stageFeature) =>
    [false, true].flatMap((agentTabs) =>
      [false, true].map((editable) => ({ stageFeature, agentTabs, editable })),
    ),
  );

  it("realFile: true なら、どの設定でも file で開き、記録しない（D87）", () => {
    for (const settings of combos) {
      expect(stageOpenTarget({ ...settings, realFile: true }), JSON.stringify(settings)).toEqual({
        scheme: "file",
        record: false,
      });
    }
  });

  it("realFile なしなら、スキームは effectiveStageScheme、記録は isLegacyOwnershipUri のとおり", () => {
    for (const settings of combos) {
      const scheme = effectiveStageScheme(settings);
      expect(stageOpenTarget({ ...settings, realFile: false }), JSON.stringify(settings)).toEqual({
        scheme,
        record: isLegacyOwnershipUri({ scheme }),
      });
    }
  });

  it("agentTabs: false の従来の経路（D53）は file で開いて記録する。映しは記録しない", () => {
    expect(
      stageOpenTarget({ stageFeature: true, agentTabs: false, editable: false, realFile: false }),
    ).toEqual({ scheme: "file", record: true });
    expect(
      stageOpenTarget({ stageFeature: true, agentTabs: true, editable: false, realFile: false }),
    ).toEqual({ scheme: STAGE_SCHEME_READONLY, record: false });
    expect(
      stageOpenTarget({ stageFeature: true, agentTabs: true, editable: true, realFile: false }),
    ).toEqual({ scheme: STAGE_SCHEME_EDITABLE, record: false });
  });
});
