import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * 所有はスキーム（設計 D82）と、観測で映しを相対パスに戻す（設計 D83）。
 *
 * `editor-surface.ts` は `vscode` を値として読むので、`isOwnTab` の `instanceof` の相手
 * （`TabInputText` / `TabInputWebview`）だけを偽物で用意する。URI は素のオブジェクト
 * （`scheme` / `authority` / `path` / `fsPath` / `toString`）で足りる ―― `observedRelPath` が
 * 読むのはその部分だけで、実物の `vscode.Uri` との一致は統合テスト（`stage-tabs.test.ts`）に委ねる。
 */
vi.mock("vscode", () => {
  class TabInputText {
    constructor(readonly uri: unknown) {}
  }
  class TabInputWebview {
    constructor(readonly viewType: string) {}
  }
  return { TabInputText, TabInputWebview };
});

import * as vscode from "vscode";
import { isOwnTab, observedRelPath } from "../src/editor-surface.js";
import { OpenedByAgent } from "../src/opened-by-agent.js";
import { STAGE_SCHEME_EDITABLE, STAGE_SCHEME_READONLY } from "../src/stage-uri.js";

type FakeUri = {
  scheme: string;
  authority: string;
  path: string;
  fsPath: string;
  toString(): string;
};

const fileUri = (fsPath: string): FakeUri => ({
  scheme: "file",
  authority: "",
  path: fsPath,
  fsPath,
  toString: () => `file://${fsPath}`,
});

const mirrorUri = (scheme: string, uriPath: string, authority = ""): FakeUri => ({
  scheme,
  authority,
  path: uriPath,
  fsPath: uriPath,
  toString: () => `${scheme}:${authority === "" ? "" : `//${authority}`}${uriPath}`,
});

const asUri = (u: FakeUri): vscode.Uri => u as unknown as vscode.Uri;

describe("observedRelPath（D83: 映しも file: と同じ1つの尾で正準化する）", () => {
  let base: string;
  let root: FakeUri;
  let outside: string;

  beforeAll(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "showme-observed-")));
    outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "showme-outside-")));
    fs.mkdirSync(path.join(base, "src"));
    fs.writeFileSync(path.join(base, "src", "a.ts"), "a\n");
    fs.writeFileSync(path.join(outside, "secret.txt"), "s\n");
    // 中を指すリンクと、外を指すリンク（観測した値も関門の規則で実体に直す。不変条件14）
    fs.symlinkSync(path.join(base, "src", "a.ts"), path.join(base, "alias.ts"));
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(base, "leak.txt"));
    root = fileUri(base);
  });

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("file: は今と同じ（ルートからの相対パス）", () => {
    expect(observedRelPath(asUri(root), asUri(fileUri(path.join(base, "src", "a.ts"))))).toBe(
      "src/a.ts",
    );
  });

  it("file: のワークスペースの外は undefined（今と同じ）", () => {
    expect(
      observedRelPath(asUri(root), asUri(fileUri(path.join(outside, "secret.txt")))),
    ).toBeUndefined();
  });

  it.each([STAGE_SCHEME_READONLY, STAGE_SCHEME_EDITABLE])("%s: の映しは rel に戻る", (scheme) => {
    expect(observedRelPath(asUri(root), asUri(mirrorUri(scheme, "/src/a.ts")))).toBe("src/a.ts");
  });

  it("映しの rel も file: と同じく実体の名前に直す（中を指すリンク → 実体の rel）", () => {
    expect(observedRelPath(asUri(root), asUri(mirrorUri(STAGE_SCHEME_READONLY, "/alias.ts")))).toBe(
      "src/a.ts",
    );
  });

  it("映しの rel が外を指すリンクなら undefined（file: と同じ関門で落ちる）", () => {
    expect(
      observedRelPath(asUri(root), asUri(mirrorUri(STAGE_SCHEME_READONLY, "/leak.txt"))),
    ).toBeUndefined();
  });

  it.each([
    ["二重スラッシュ", "/src//a.ts", ""],
    ["ドット区間", "/src/./a.ts", ""],
    ["先頭スラッシュなし", "src/a.ts", ""],
    ["authority つき", "/src/a.ts", "x"],
    ["脱出", "/../etc/passwd", ""],
  ])("別綴りの映し（%s）は undefined", (_label, uriPath, authority) => {
    expect(
      observedRelPath(asUri(root), asUri(mirrorUri(STAGE_SCHEME_READONLY, uriPath, authority))),
    ).toBeUndefined();
  });

  it("存在しない映しの rel は undefined（fail-closed。file: と同じ）", () => {
    expect(
      observedRelPath(asUri(root), asUri(mirrorUri(STAGE_SCHEME_READONLY, "/src/missing.ts"))),
    ).toBeUndefined();
  });

  it("ルートが無ければ映しも undefined", () => {
    expect(
      observedRelPath(undefined, asUri(mirrorUri(STAGE_SCHEME_READONLY, "/src/a.ts"))),
    ).toBeUndefined();
  });
});

describe("isOwnTab（D82: テキストは映しのスキームなら own。file: は D53 のまま）", () => {
  const textTab = (uri: FakeUri): vscode.Tab =>
    ({ input: new vscode.TabInputText(asUri(uri)) }) as unknown as vscode.Tab;

  const fileA = fileUri("/work/repo/src/a.ts");
  const roA = mirrorUri(STAGE_SCHEME_READONLY, "/src/a.ts");
  const rwA = mirrorUri(STAGE_SCHEME_EDITABLE, "/src/a.ts");

  const recorded = (...keys: string[]): OpenedByAgent => {
    const opened = new OpenedByAgent();
    for (const key of keys) opened.opened(key);
    return opened;
  };
  const counts = (entries: Array<[FakeUri, number]>): ReadonlyMap<string, number> =>
    new Map(entries.map(([u, n]) => [u.toString(), n]));

  it.each<[string, FakeUri, OpenedByAgent, ReadonlyMap<string, number>, boolean]>([
    // 映し: 記録にも枚数にも拠らない（スキームは移動でも合流でも残る。設計 D82・B2）
    ["showme-ro・記録なし・1枚", roA, recorded(), counts([[roA, 1]]), true],
    ["showme-rw・記録なし・1枚", rwA, recorded(), counts([[rwA, 1]]), true],
    ["showme-ro・記録なし・2枚（列をまたいで2枚）", roA, recorded(), counts([[roA, 2]]), true],
    ["showme-ro・枚数表に無い", roA, recorded(), counts([]), true],
    // 正準の綴りなら、実体が無くても own（構文だけで決める。消えたファイルの映しも片づけられる）
    [
      "showme-ro・実体の無いファイル（正準の綴り）",
      mirrorUri(STAGE_SCHEME_READONLY, "/src/deleted-file.ts"),
      recorded(),
      counts([]),
      true,
    ],
    // 別綴りの映しは own にならない（`stageUriFor` は別綴りを作らない ＝ 人間か別の拡張が開いた）
    [
      "showme-ro・authority つき（別綴り）",
      mirrorUri(STAGE_SCHEME_READONLY, "/src/a.ts", "x"),
      recorded(),
      counts([]),
      false,
    ],
    [
      "showme-ro・二重スラッシュ（別綴り）",
      mirrorUri(STAGE_SCHEME_READONLY, "/src//a.ts"),
      recorded(),
      counts([]),
      false,
    ],
    [
      "showme-rw・先頭スラッシュなし（別綴り）",
      mirrorUri(STAGE_SCHEME_EDITABLE, "src/a.ts"),
      recorded(),
      counts([]),
      false,
    ],
    // 大文字小文字だけ違う綴りは正準の形なので own（設計の注記どおり。別の文書として扱う）
    [
      "showme-ro・大文字小文字違い",
      mirrorUri(STAGE_SCHEME_READONLY, "/SRC/a.ts"),
      recorded(),
      counts([]),
      true,
    ],
    // file: は D53 のまま（記録にあり、かつ窓に1枚）
    ["file・記録あり・1枚", fileA, recorded(fileA.toString()), counts([[fileA, 1]]), true],
    ["file・記録あり・2枚", fileA, recorded(fileA.toString()), counts([[fileA, 2]]), false],
    ["file・記録なし・1枚", fileA, recorded(), counts([[fileA, 1]]), false],
    // 人間が同じファイルを file: で開いても、それは own にならない（映しの記録は file: の鍵ではない）
    [
      "file・映しだけ開いている",
      fileA,
      recorded(),
      counts([
        [roA, 1],
        [fileA, 1],
      ]),
      false,
    ],
  ])("%s", (_label, uri, opened, count, own) => {
    expect(isOwnTab(textTab(uri), opened, count)).toBe(own);
  });

  it("設定を読まない（B2）: agentTabs を切っても、開いている映しは own のまま", () => {
    // `isOwnTab` の引数に設定は無い ―― 判定は URI（と file: の記録・枚数）だけで決まる。
    // だから `agentTabs` を途中で false にしても、既に開いている映しのタブは own のままで、
    // `close-own` で片づけられる。引数の数で固定する（設定を足すと落ちる）。
    expect(isOwnTab.length).toBe(3);
    expect(isOwnTab(textTab(roA), recorded(), counts([]))).toBe(true);
  });

  it("テキスト以外（差分など）は映しでも own にならない", () => {
    const tab = { input: { original: asUri(roA), modified: asUri(roA) } } as unknown as vscode.Tab;
    expect(isOwnTab(tab, recorded(), counts([]))).toBe(false);
  });
});
