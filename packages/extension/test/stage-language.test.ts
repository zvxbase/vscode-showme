import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as posixPath from "node:path/posix";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * 映しのタブの定義・参照（設計 D88 / B3）の写し方。
 *
 * 代理のプロバイダは、映しと同じ位置を `file:` に聞いた結果を写して返す。TS は映しの上で
 * 同じファイルの中の結果を既に返しており、VS Code は同じ定義を2件あると畳まずに覗き見を
 * 出す（B3 の実測）。だから**同じファイルの結果は返さない**。別のファイルの結果だけを、
 * 設定（`file` / `agentTab`）に従って写す。ワークスペースの外はそのまま、関門に落ちる
 * パスは返さない。
 *
 * vscode の偽物は、写し方が読む部品（`Uri` の scheme / authority / path / fsPath と
 * `Uri.from` / `Uri.joinPath`、`Location`）に足りる程度で用意する。
 */
vi.mock("vscode", () => {
  class Uri {
    private constructor(
      readonly scheme: string,
      readonly authority: string,
      readonly path: string,
    ) {}
    get fsPath(): string {
      return this.path;
    }
    static from(parts: { scheme: string; authority?: string; path: string }): Uri {
      return new Uri(parts.scheme, parts.authority ?? "", parts.path);
    }
    static file(p: string): Uri {
      return new Uri("file", "", p);
    }
    static joinPath(base: Uri, ...segments: string[]): Uri {
      return new Uri(base.scheme, base.authority, posixPath.join(base.path, ...segments));
    }
    toString(): string {
      return `${this.scheme}:${this.authority}${this.path}`;
    }
  }
  class Location {
    constructor(
      readonly uri: Uri,
      readonly range: unknown,
    ) {}
  }
  return { Uri, Location };
});

import * as vscode from "vscode";
import {
  type LocationResult,
  type ResultPlace,
  mapMirrorLocations,
  placeOfResult,
} from "../src/stage-language.js";
import { STAGE_SCHEME_EDITABLE, STAGE_SCHEME_READONLY } from "../src/stage-uri.js";

const ROOT = "/ws";
const root = vscode.Uri.file(ROOT);
const fileUri = (rel: string) => vscode.Uri.file(`${ROOT}/${rel}`);
const range = (line: number) => ({ start: { line, character: 0 }, end: { line, character: 3 } });

/** 表の場所: rel → 置き場所。`canonical` は関門が返す正準名（綴りと違いうる）。 */
function placeTable(entries: Record<string, ResultPlace>): (uri: vscode.Uri) => ResultPlace {
  return (uri) => {
    const rel = uri.path.startsWith(`${ROOT}/`) ? uri.path.slice(ROOT.length + 1) : undefined;
    if (rel === undefined) return { kind: "outside" };
    const p = entries[rel];
    if (p === undefined) throw new Error(`表に無い: ${rel}`);
    return p;
  };
}

const place = placeTable({
  "src/b.ts": { kind: "inside", rel: "src/b.ts", canonical: "src/b.ts" },
  // 綴りは違うが同じ実体（リンク）。同じファイルとして落ちる。
  "src/link-to-b.ts": { kind: "inside", rel: "src/link-to-b.ts", canonical: "src/b.ts" },
  "src/a.ts": { kind: "inside", rel: "src/a.ts", canonical: "src/a.ts" },
  ".env": { kind: "rejected" },
});

/** 結果1件を `scheme:path@line` に。Link は `targetUri` と `targetRange` を読む。 */
function describeResult(r: LocationResult): string {
  const isLink = "targetUri" in r;
  const uri = isLink ? r.targetUri : r.uri;
  const start = (isLink ? r.targetRange : r.range).start.line;
  return `${isLink ? "link " : ""}${uri.scheme}:${uri.path}@${start}`;
}

const loc = (uri: vscode.Uri, line: number): LocationResult =>
  new vscode.Location(uri, range(line) as unknown as vscode.Range);
const link = (uri: vscode.Uri, line: number): LocationResult =>
  ({
    originSelectionRange: range(9),
    targetUri: uri,
    targetRange: range(line),
    targetSelectionRange: range(line),
  }) as unknown as vscode.LocationLink;

const outside = vscode.Uri.file("/usr/lib/node_modules/typescript/lib/lib.d.ts");

const inputs: LocationResult[] = [
  loc(fileUri("src/b.ts"), 1),
  link(fileUri("src/b.ts"), 2),
  loc(fileUri("src/link-to-b.ts"), 3),
  loc(fileUri("src/a.ts"), 4),
  link(fileUri("src/a.ts"), 5),
  loc(fileUri(".env"), 6),
  link(fileUri(".env"), 7),
  loc(outside, 8),
  link(outside, 9),
];

describe("mapMirrorLocations（映しの代理が返す結果の写し方。D88 / B3）", () => {
  it("file: 同じファイル（綴り違いの同じ実体も）と関門に落ちるパスは返さず、別のファイルとワークスペースの外は file: のまま", () => {
    const out = mapMirrorLocations(inputs, {
      sourceCanonical: "src/b.ts",
      target: "file",
      agentTabScheme: STAGE_SCHEME_READONLY,
      root,
      place,
    });
    expect(out.map(describeResult)).toEqual([
      "file:/ws/src/a.ts@4",
      "link file:/ws/src/a.ts@5",
      `file:${outside.path}@8`,
      `link file:${outside.path}@9`,
    ]);
  });

  for (const scheme of [STAGE_SCHEME_READONLY, STAGE_SCHEME_EDITABLE] as const) {
    it(`agentTab（いまの設定の舞台のスキームが ${scheme}）: 別のファイルはそのスキームに写し、外は file: のまま`, () => {
      const out = mapMirrorLocations(inputs, {
        sourceCanonical: "src/b.ts",
        target: "agentTab",
        agentTabScheme: scheme,
        root,
        place,
      });
      expect(out.map(describeResult)).toEqual([
        `${scheme}:/src/a.ts@4`,
        `link ${scheme}:/src/a.ts@5`,
        `file:${outside.path}@8`,
        `link file:${outside.path}@9`,
      ]);
    });
  }

  it("agentTab でも、いまの設定の舞台が file:（映しを使わない）なら file: のまま", () => {
    const out = mapMirrorLocations(inputs, {
      sourceCanonical: "src/b.ts",
      target: "agentTab",
      agentTabScheme: "file",
      root,
      place,
    });
    expect(out.map(describeResult)).toEqual([
      "file:/ws/src/a.ts@4",
      "link file:/ws/src/a.ts@5",
      `file:${outside.path}@8`,
      `link file:${outside.path}@9`,
    ]);
  });

  it("写しても範囲は変えない（Location の range、Link の origin / target / selection）", () => {
    const [l, k] = mapMirrorLocations([loc(fileUri("src/a.ts"), 4), link(fileUri("src/a.ts"), 5)], {
      sourceCanonical: "src/b.ts",
      target: "agentTab",
      agentTabScheme: STAGE_SCHEME_READONLY,
      root,
      place,
    });
    expect(l).toBeInstanceOf(vscode.Location);
    expect((l as vscode.Location).range).toEqual(range(4));
    const kl = k as vscode.LocationLink;
    expect(kl.originSelectionRange).toEqual(range(9));
    expect(kl.targetRange).toEqual(range(5));
    expect(kl.targetSelectionRange).toEqual(range(5));
  });

  it("同じファイルかどうかは正準名で決める（映しの綴りでない）", () => {
    // 映しが link-to-b.ts でも、実体が b.ts なら b.ts の結果は同じファイル。
    const out = mapMirrorLocations([loc(fileUri("src/b.ts"), 1), loc(fileUri("src/a.ts"), 4)], {
      sourceCanonical: "src/b.ts",
      target: "file",
      agentTabScheme: STAGE_SCHEME_READONLY,
      root,
      place,
    });
    expect(out.map(describeResult)).toEqual(["file:/ws/src/a.ts@4"]);
  });

  it("結果が無ければ空", () => {
    expect(
      mapMirrorLocations([], {
        sourceCanonical: "src/b.ts",
        target: "agentTab",
        agentTabScheme: STAGE_SCHEME_READONLY,
        root,
        place,
      }),
    ).toEqual([]);
  });
});

describe("placeOfResult（結果の URI がワークスペースのどこか。関門は acceptWorkspacePath）", () => {
  let dir: string;
  let ws: string;
  let rootUri: vscode.Uri;

  beforeAll(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "showme-lang-")));
    ws = path.join(dir, "ws");
    fs.mkdirSync(path.join(ws, "src"), { recursive: true });
    fs.writeFileSync(path.join(ws, "src", "a.ts"), "export const a = 1;\n");
    fs.writeFileSync(path.join(ws, ".env"), "X=1\n");
    fs.writeFileSync(path.join(ws, "src", "private.ts"), "export const p = 1;\n");
    fs.symlinkSync(path.join(ws, ".env"), path.join(ws, "src", "env-link.ts"));
    fs.symlinkSync(path.join(ws, "src", "a.ts"), path.join(ws, "src", "a-link.ts"));
    fs.writeFileSync(path.join(dir, "outside.ts"), "export const o = 1;\n");
    rootUri = vscode.Uri.file(ws);
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("ワークスペースの中で関門を通るものは綴りの rel と正準名を返す", () => {
    expect(placeOfResult(rootUri, vscode.Uri.file(path.join(ws, "src/a.ts")), [])).toEqual({
      kind: "inside",
      rel: "src/a.ts",
      canonical: "src/a.ts",
    });
    expect(placeOfResult(rootUri, vscode.Uri.file(path.join(ws, "src/a-link.ts")), [])).toEqual({
      kind: "inside",
      rel: "src/a-link.ts",
      canonical: "src/a.ts",
    });
  });

  it("秘匿（既定・追加・リンクの先）は rejected", () => {
    expect(placeOfResult(rootUri, vscode.Uri.file(path.join(ws, ".env")), [])).toEqual({
      kind: "rejected",
    });
    expect(
      placeOfResult(rootUri, vscode.Uri.file(path.join(ws, "src/private.ts")), ["src/private.ts"]),
    ).toEqual({ kind: "rejected" });
    expect(placeOfResult(rootUri, vscode.Uri.file(path.join(ws, "src/env-link.ts")), [])).toEqual({
      kind: "rejected",
    });
  });

  it("ルートがリンクで結果が実体の綴り（realpath 済み）でも、中として関門を通す", () => {
    // TS は実体のパスで答えうる。綴りだけで比べると中のものが outside になり、関門を素通りする。
    const linkRoot = path.join(dir, "ws-link");
    if (!fs.existsSync(linkRoot)) fs.symlinkSync(ws, linkRoot);
    const viaLink = vscode.Uri.file(linkRoot);
    expect(placeOfResult(viaLink, vscode.Uri.file(path.join(ws, ".env")), [])).toEqual({
      kind: "rejected",
    });
    expect(
      placeOfResult(viaLink, vscode.Uri.file(path.join(ws, "src/private.ts")), ["src/private.ts"]),
    ).toEqual({ kind: "rejected" });
    expect(placeOfResult(viaLink, vscode.Uri.file(path.join(ws, "src/a.ts")), [])).toEqual({
      kind: "inside",
      rel: "src/a.ts",
      canonical: "src/a.ts",
    });
    // リンクの綴りの結果も今までどおり。
    expect(placeOfResult(viaLink, vscode.Uri.file(path.join(linkRoot, "src/a.ts")), [])).toEqual({
      kind: "inside",
      rel: "src/a.ts",
      canonical: "src/a.ts",
    });
    // 本当の外は外のまま。
    expect(placeOfResult(viaLink, vscode.Uri.file(path.join(dir, "outside.ts")), [])).toEqual({
      kind: "outside",
    });
  });

  it("ワークスペースの外と file: でない URI は outside", () => {
    expect(placeOfResult(rootUri, vscode.Uri.file(path.join(dir, "outside.ts")), [])).toEqual({
      kind: "outside",
    });
    expect(
      placeOfResult(rootUri, vscode.Uri.from({ scheme: "untitled", path: "Untitled-1" }), []),
    ).toEqual({ kind: "outside" });
  });
});
