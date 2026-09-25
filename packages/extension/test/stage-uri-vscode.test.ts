import * as posixPath from "node:path/posix";
import { describe, expect, it, vi } from "vitest";

/**
 * `stage-uri-vscode.ts`（vscode に依存する薄い層。設計 D84・D83）。
 *
 * ここが持つのは vscode の型と `stage-uri.ts` の純関数を繋ぐことだけで、判断は持たない
 * （不変条件14）。だから `Uri.from` / `Uri.joinPath` の偽物は**委譲を確かめるのに足りる
 * 程度**で用意する（完全に忠実ではない ―― 例えばこの偽物の `toString` はパーセント
 * エンコードをしない。実物の `vscode.Uri` との忠実な一致は統合テストに委ねる）。
 *
 * `vscode.Uri.joinPath` は POSIX 的にセグメントを結合する（`path/posix` の `join` で
 * 委譲を確かめるには十分 ―― この repo の rel は `normalizeWorkspaceRelative` を通した
 * 後の POSIX 形なので、Windows 固有の正規化の差はここでは関係しない）。
 */
vi.mock("vscode", () => {
  class Uri {
    private constructor(
      readonly scheme: string,
      readonly authority: string,
      readonly path: string,
    ) {}
    static from(parts: { scheme: string; authority?: string; path: string }): Uri {
      return new Uri(parts.scheme, parts.authority ?? "", parts.path);
    }
    static joinPath(base: Uri, ...segments: string[]): Uri {
      return new Uri(base.scheme, base.authority, posixPath.join(base.path, ...segments));
    }
    toString(): string {
      return `${this.scheme}:${this.authority}${this.path}`;
    }
  }
  return { Uri };
});

import type * as vscode from "vscode";
import { relOfStageUri, stageMirrorUri, stageUriFor } from "../src/stage-uri-vscode.js";
import { STAGE_SCHEME_EDITABLE, STAGE_SCHEME_READONLY, stageUriPath } from "../src/stage-uri.js";

const uriOf = (scheme: string, path: string, authority = ""): vscode.Uri =>
  ({ scheme, authority, path, toString: () => `${scheme}:${path}` }) as unknown as vscode.Uri;

describe("stageMirrorUri", () => {
  it("scheme と stageUriPath(rel) から映しの URI を組む（authority は空）", () => {
    const uri = stageMirrorUri("src/a.ts", STAGE_SCHEME_READONLY);
    expect(uri.scheme).toBe(STAGE_SCHEME_READONLY);
    expect(uri.authority).toBe("");
    expect(uri.path).toBe(stageUriPath("src/a.ts"));
  });
});

describe("stageUriFor（D84 の唯一の場所）", () => {
  const root = { scheme: "file", authority: "", path: "/workspace" } as unknown as vscode.Uri;

  it("scheme が file なら Uri.joinPath(root, rel)", () => {
    const uri = stageUriFor(root, "src/a.ts", "file");
    expect(uri.scheme).toBe("file");
    expect(uri.path).toBe("/workspace/src/a.ts");
  });

  it("scheme が showme-ro なら stageMirrorUri と同じ URI（root は使わない）", () => {
    const uri = stageUriFor(root, "src/a.ts", STAGE_SCHEME_READONLY);
    expect(uri.scheme).toBe(STAGE_SCHEME_READONLY);
    expect(uri.authority).toBe("");
    expect(uri.path).toBe(stageUriPath("src/a.ts"));
  });

  it("scheme が showme-rw でも同じ規則", () => {
    const uri = stageUriFor(root, "docs/a.md", STAGE_SCHEME_EDITABLE);
    expect(uri.scheme).toBe(STAGE_SCHEME_EDITABLE);
    expect(uri.path).toBe(stageUriPath("docs/a.md"));
  });
});

describe("relOfStageUri（D83 の逆関数）", () => {
  it("映しの URI を rel に戻す", () => {
    expect(relOfStageUri(uriOf(STAGE_SCHEME_READONLY, "/src/a.ts"))).toBe("src/a.ts");
    expect(relOfStageUri(uriOf(STAGE_SCHEME_EDITABLE, "/src/a.ts"))).toBe("src/a.ts");
  });

  it("映しでなければ undefined（file はそのまま file: を使う）", () => {
    expect(relOfStageUri(uriOf("file", "/src/a.ts"))).toBeUndefined();
  });

  it("別綴り（正準形でない）は undefined ―― relOfStagePath への委譲そのままの結果", () => {
    expect(relOfStageUri(uriOf(STAGE_SCHEME_READONLY, "/src//a.ts"))).toBeUndefined();
    expect(relOfStageUri(uriOf(STAGE_SCHEME_READONLY, "/src/./a.ts"))).toBeUndefined();
  });

  it("authority を持つ映しの URI は undefined", () => {
    expect(relOfStageUri(uriOf(STAGE_SCHEME_READONLY, "/a.ts", "anything"))).toBeUndefined();
  });
});

describe("stageUriFor と relOfStageUri の往復（映しのスキームだけ）", () => {
  const root = { scheme: "file", authority: "", path: "/workspace" } as unknown as vscode.Uri;

  for (const scheme of [STAGE_SCHEME_READONLY, STAGE_SCHEME_EDITABLE] as const) {
    it(`${scheme}: stageUriFor で組んだ URI を relOfStageUri で戻すと元の rel`, () => {
      const rel = "src/a.ts";
      const uri = stageUriFor(root, rel, scheme);
      expect(relOfStageUri(uri)).toBe(rel);
    });
  }

  // % / # / 空白 / 非 ASCII を含む rel でも往復する（`Uri.from` を使い `Uri.parse` を
  // 使わないことの効能。stageUriFor が返すモックの Uri をそのまま relOfStageUri に渡す
  // ―― 手組みの `{ scheme, authority, path }` オブジェクトではなく、実際に組んだ URI で
  // 確かめる）。
  const trickyRels = ["a%20b#c.ts", "docs/a#b%20c.md", "path with space/a.ts", "docs/日本語.md"];
  for (const scheme of [STAGE_SCHEME_READONLY, STAGE_SCHEME_EDITABLE] as const) {
    for (const rel of trickyRels) {
      it(`${scheme}: ${JSON.stringify(rel)} も stageUriFor → relOfStageUri で往復する`, () => {
        const uri = stageUriFor(root, rel, scheme);
        expect(relOfStageUri(uri)).toBe(rel);
      });
    }
  }
});
