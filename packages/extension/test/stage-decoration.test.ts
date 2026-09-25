import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

/**
 * エージェントのタブの印（設計 D89）。
 *
 * 印を付けるかどうかは `isAgentStageUri`（`isOwnTab` のテキストの枝と同じ述語）だけで決まる
 * ―― 正しい綴りの映しにだけ付き、別綴り・`file:`・他のスキームには付かない。
 * vscode の偽物は `stage-uri-vscode.ts` が値として読むのに足りる程度（`Uri` / `ThemeColor`）。
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
  }
  class ThemeColor {
    constructor(readonly id: string) {}
  }
  return { Uri, ThemeColor };
});

import {
  AGENT_TAB_BADGE,
  AGENT_TAB_COLOR_ID,
  agentTabDecoration,
} from "../src/stage-decoration.js";
import { isAgentStageUri } from "../src/stage-uri-vscode.js";
import { STAGE_SCHEME_EDITABLE, STAGE_SCHEME_READONLY } from "../src/stage-uri.js";

const parts = (scheme: string, path: string, authority = "") => ({ scheme, authority, path });

describe("agentTabDecoration（正しい綴りの映しにだけ印）", () => {
  const table: [string, ReturnType<typeof parts>, boolean][] = [
    ["showme-ro の正準", parts(STAGE_SCHEME_READONLY, "/src/a.ts"), true],
    ["showme-rw の正準", parts(STAGE_SCHEME_EDITABLE, "/src/a.ts"), true],
    ["大文字小文字だけ違う綴り（正準の形）", parts(STAGE_SCHEME_READONLY, "/SRC/a.ts"), true],
    ["authority つき", parts(STAGE_SCHEME_READONLY, "/src/a.ts", "host"), false],
    ["// を含む", parts(STAGE_SCHEME_READONLY, "/src//a.ts"), false],
    ["/./ を含む", parts(STAGE_SCHEME_EDITABLE, "/src/./a.ts"), false],
    ["先頭の / なし", parts(STAGE_SCHEME_READONLY, "src/a.ts"), false],
    ["末尾の /", parts(STAGE_SCHEME_READONLY, "/src/"), false],
    ["file:", parts("file", "/workspace/src/a.ts"), false],
    ["untitled:", parts("untitled", "Untitled-1"), false],
    ["他のスキーム", parts("git", "/src/a.ts"), false],
  ];
  for (const [label, uri, want] of table) {
    it(`${label} → ${want ? "印あり" : "なし"}`, () => {
      const got = agentTabDecoration(uri);
      if (want) {
        expect(got).toEqual({
          badge: AGENT_TAB_BADGE,
          tooltip: "ShowMe: the agent's tab",
          colorId: AGENT_TAB_COLOR_ID,
        });
      } else {
        expect(got).toBeUndefined();
      }
      // 印と所有は同じ述語を読む（不変条件14）。
      expect(isAgentStageUri(uri)).toBe(want);
    });
  }

  it("バッジは2文字の SM、色の id は showme.agentTabForeground", () => {
    expect(AGENT_TAB_BADGE).toBe("SM");
    expect(AGENT_TAB_COLOR_ID).toBe("showme.agentTabForeground");
  });
});

describe("package.json の色の宣言（D89）", () => {
  const read = (name: string): Record<string, unknown> =>
    JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), "utf8")) as Record<
      string,
      unknown
    >;
  const manifest = read("package.json") as {
    contributes: {
      colors?: { id: string; description: string; defaults: Record<string, string> }[];
    };
  };
  const nlsEn = read("package.nls.json") as Record<string, string>;
  const nlsJa = read("package.nls.ja.json") as Record<string, string>;

  it("showme.agentTabForeground を4つのテーマ種別の既定つきで宣言し、説明は両方の nls にある", () => {
    const color = manifest.contributes.colors?.find((c) => c.id === AGENT_TAB_COLOR_ID);
    expect(color).toBeDefined();
    expect(Object.keys(color?.defaults ?? {}).sort()).toEqual(
      ["dark", "highContrast", "highContrastLight", "light"].sort(),
    );
    for (const value of Object.values(color?.defaults ?? {})) {
      expect(value).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
    const m = /^%(.+)%$/.exec(color?.description ?? "");
    expect(m).not.toBeNull();
    const key = m?.[1] ?? "";
    expect(nlsEn[key]).toBeTruthy();
    expect(nlsJa[key]).toBeTruthy();
  });

  it("showme.stage.agentTabs の説明は印（色と SM のバッジ）に触れる", () => {
    expect(nlsEn["showme.config.stage.agentTabs"]).toMatch(/color/);
    expect(nlsEn["showme.config.stage.agentTabs"]).toMatch(/"SM" badge/);
    expect(nlsJa["showme.config.stage.agentTabs"]).toMatch(/色/);
    expect(nlsJa["showme.config.stage.agentTabs"]).toMatch(/「SM」/);
  });
});
