import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import * as barrel from "./index.js";

describe("index バレル", () => {
  it("src の全モジュールが再エクスポートされている", () => {
    // モジュールを増やしてバレルに足し忘れると、消費者は黙って参照できないだけで
    // 誰も気づかない。ファイル一覧と突き合わせる。
    const dir = __dirname;
    const modules = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "index.ts")
      .map((f) => path.basename(f, ".ts"));
    expect(modules.length).toBeGreaterThan(5);

    const exported = new Set(Object.keys(barrel));
    expect(exported.size).toBeGreaterThan(15);

    // 各モジュールの代表的な公開名が1つ以上バレルから見えること
    const representatives: ReadonlyArray<readonly [string, string]> = [
      ["annotation-color", "ANNOTATION_COLORS"],
      ["arrange-action", "ARRANGE_ACTIONS"],
      ["feature", "FEATURE_OF_TOOL"],
      ["glob", "matchGlob"],
      ["highlight-style", "HIGHLIGHT_COLORS"],
      ["location", "locationSchema"],
      ["panel-limit", "panelSlotAllowed"],
      ["paths", "normalizeWorkspaceRelative"],
      ["redaction", "isRedactedPath"],
      ["sanitize", "sanitizeDisplayText"],
      ["sanitize-css", "sanitizeStyleAttribute"],
      ["sanitize-html", "sanitizeHtml"],
      ["sanitize-note", "sanitizeNoteText"],
      ["selection", "SELECTION_WITHHELD_REASONS"],
      ["resolve-location", "resolveLocation"],
      ["runtime-dir", "runtimeDirPath"],
      ["tools", "TOOL_ANNOTATIONS"],
      ["view-action", "VIEW_ACTIONS"],
      ["window-role", "chooseStageWindow"],
      ["wire", "requestSchema"],
    ];
    for (const [moduleName, symbol] of representatives) {
      expect(modules, `${moduleName} が src に無い`).toContain(moduleName);
      expect([...exported], `${symbol} がバレルから見えない`).toContain(symbol);
    }

    // 一覧に載っていないモジュールがあるなら、この表ごと古びている。
    // 「代表名が見える」だけだと、新しいモジュールの追加を取りこぼす。
    const covered = new Set(representatives.map(([moduleName]) => moduleName));
    expect(modules.filter((m) => !covered.has(m))).toEqual([]);
  });

  it("内部関数が漏れていない", () => {
    expect(Object.keys(barrel)).not.toContain("matchSegment");
    expect(Object.keys(barrel)).not.toContain("matchSegments");
    expect(Object.keys(barrel)).not.toContain("truncateSafely");
    // サニタイザの内側の判定。外に出すと、呼び出し側が自分で組み合わせ始める
    // ―― それは2つ目のサニタイザである（不変条件7）。
    expect(Object.keys(barrel)).not.toContain("escapeCodePoint");
    expect(Object.keys(barrel)).not.toContain("isZeroWidthChar");
    expect(Object.keys(barrel)).not.toContain("isBidiOverrideChar");
  });
});
