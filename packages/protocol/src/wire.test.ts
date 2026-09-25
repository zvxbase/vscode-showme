import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { ANNOTATION_COLORS, UNMARKED_ANNOTATION_PAINT } from "./annotation-color.js";
import { HIGHLIGHT_COLORS } from "./highlight-style.js";
import { RESOLUTION_REASONS, locationSchema } from "./location.js";
import { MAX_PANEL_SLOT } from "./panel-limit.js";
import { TOOL_NAMES } from "./tools.js";
import {
  MAX_ANNOTATION_ITEMS,
  MAX_ANNOTATION_TEXT_CHARS,
  MAX_ANNOTATION_THREADS,
  MAX_CLOSE_TABS_PATHS,
  MAX_EDITOR_GROUPS,
  MAX_TABS_PER_GROUP,
  MAX_TAB_LABEL_CHARS,
  RESULT_SCHEMAS,
  TAB_KINDS,
  WIRE_PROTOCOL_VERSION,
  annotateArgsObjectSchema,
  annotateArgsSchema,
  annotateItemSchema,
  annotateResultSchema,
  arrangeEditorsArgsSchema,
  arrangeEditorsResultSchema,
  errorCodeSchema,
  findDefinitionArgsSchema,
  findReferencesArgsSchema,
  getEditorStateResultSchema,
  helloSchema,
  listWorkspacesResultSchema,
  requestSchema,
  responseSchema,
  showCodeArgsSchema,
  showCodeResultSchema,
  showHtmlArgsObjectSchema,
  showHtmlArgsSchema,
} from "./wire.js";

/**
 * strict な object が知らない鍵で落ちたとき、鍵の名前は `issue.keys` に入る
 * （`issue.path` は object 自身を指す）。「color が落ちた」を鍵の名前で言う。
 */
const namesColor = (error: z.ZodError): boolean =>
  error.issues.some((i) => i.code === "unrecognized_keys" && i.keys.includes("color"));

describe("wire schemas", () => {
  it("ハンドシェイクはトークンを必須にする", () => {
    expect(helloSchema.safeParse({ protocolVersion: 1, token: "a".repeat(64) }).success).toBe(true);
    expect(helloSchema.safeParse({ protocolVersion: 1 }).success).toBe(false);
  });

  it("短すぎるトークンを拒否する", () => {
    expect(helloSchema.safeParse({ protocolVersion: 1, token: "short" }).success).toBe(false);
  });

  it("既知のツール名だけを受け付ける", () => {
    const ok = requestSchema.safeParse({
      id: "1",
      tool: "show_code",
      args: { locations: [{ path: "a.ts", text: "x" }] },
    });
    expect(ok.success).toBe(true);
    const ng = requestSchema.safeParse({ id: "1", tool: "rm_rf", args: {} });
    expect(ng.success).toBe(false);
  });

  it("知らないキーを落とさず拒否する（strict）", () => {
    const r = requestSchema.safeParse({
      id: "1",
      tool: "show_code",
      args: { locations: [{ path: "a.ts", text: "x" }] },
      extra: "sneaky",
    });
    expect(r.success).toBe(false);
  });

  it("応答は ok と error のどちらかである", () => {
    expect(responseSchema.safeParse({ id: "1", ok: true, result: {} }).success).toBe(true);
    expect(
      responseSchema.safeParse({ id: "1", ok: false, error: { code: "no-window", message: "x" } })
        .success,
    ).toBe(true);
  });
});

// 以下は計画のテストに追加した境界ケース（自己レビューで洗い出した）。
describe("wire schemas — additional boundary cases", () => {
  it("args の中の未知キーも strict で拒否する（トップレベルだけでなくネストでも効く）", () => {
    const r = requestSchema.safeParse({
      id: "1",
      tool: "show_code",
      args: { locations: [{ path: "a.ts", text: "x" }], sneaky: true },
    });
    expect(r.success).toBe(false);
  });

  it("locations[] の各要素の中の未知キーも strict で拒否する", () => {
    const r = requestSchema.safeParse({
      id: "1",
      tool: "show_code",
      args: { locations: [{ path: "a.ts", text: "x", sneaky: true }] },
    });
    expect(r.success).toBe(false);
  });

  it("未知の tool 値のエラーは discriminator 値を名指しする（分かりやすい）", () => {
    const r = requestSchema.safeParse({ id: "1", tool: "rm_rf", args: {} });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]?.code).toBe("invalid_union_discriminator");
      expect(r.error.issues[0]?.path).toEqual(["tool"]);
    }
  });

  it("トークン長の境界: 63文字は拒否・64文字は受理・65文字は拒否", () => {
    expect(helloSchema.safeParse({ protocolVersion: 1, token: "a".repeat(63) }).success).toBe(
      false,
    );
    expect(helloSchema.safeParse({ protocolVersion: 1, token: "a".repeat(64) }).success).toBe(true);
    expect(helloSchema.safeParse({ protocolVersion: 1, token: "a".repeat(65) }).success).toBe(
      false,
    );
  });

  it("トークンは小文字16進のみ許可する（大文字16進は拒否）", () => {
    expect(helloSchema.safeParse({ protocolVersion: 1, token: "A".repeat(64) }).success).toBe(
      false,
    );
  });

  it("トークンは長さが合っていても非16進文字を含めば拒否する", () => {
    expect(helloSchema.safeParse({ protocolVersion: 1, token: `g${"a".repeat(63)}` }).success).toBe(
      false,
    );
  });
});

// C2: 応答の result が無検証だった（10万文字の fileContents を含む応答が通った）。
// 「どのツールもファイルの中身を返さない」を強制する場所が
// protocol から与えられていなかったので、ツールごとの結果スキーマを切る。
describe("応答の結果スキーマ", () => {
  it("ファイルの中身を含む結果を拒否する（不変条件2をここで強制する）", () => {
    const bad = { resolutions: [{ resolvedBy: "text", match: "one", fileContents: "secret" }] };
    expect(showCodeResultSchema.safeParse(bad).success).toBe(false);
  });

  it("candidates は3件を超えられない", () => {
    const tooMany = {
      resolutions: [
        {
          resolvedBy: "text",
          match: "many",
          candidates: [{ line: 1 }, { line: 2 }, { line: 3 }, { line: 4 }],
        },
      ],
    };
    expect(showCodeResultSchema.safeParse(tooMany).success).toBe(false);
  });

  it("正しい形の show_code 結果は通る", () => {
    const ok = {
      resolutions: [
        {
          resolvedBy: "text",
          match: "one",
          range: { startLine: 2, endLine: 2 },
          normalizedPath: "src/a.ts",
        },
        { resolvedBy: "none", match: "none", reason: "excluded-path", normalizedPath: ".env" },
      ],
    };
    expect(showCodeResultSchema.safeParse(ok).success).toBe(true);
  });

  it("件数を漏らすキーを結果に足せない", () => {
    const leaky = { resolutions: [{ resolvedBy: "text", match: "many", matchCount: 42 }] };
    expect(showCodeResultSchema.safeParse(leaky).success).toBe(false);
  });

  it("list_workspaces の結果は必須フィールドを要求し、未知キーを拒否する", () => {
    const ok = {
      isTrusted: true,
      capabilities: { symbolResolution: true, terminalEnvInjection: false },
      permissions: { closeHumanTabs: false, closeDirtyTabs: false },
      features: { stage: true, html: true, layout: true },
      disabledTools: [],
      editorGroup: "dedicated",
      avoidToolColumns: false,
      panels: { max: 2 },
      otherWindowsListed: false,
    };
    expect(listWorkspacesResultSchema.safeParse(ok).success).toBe(true);
    expect(
      listWorkspacesResultSchema.safeParse({ ...ok, boundWorkspace: { name: "w", path: "/w" } })
        .success,
    ).toBe(true);
    expect(listWorkspacesResultSchema.safeParse({ ...ok, secrets: ["x"] }).success).toBe(false);
    expect(listWorkspacesResultSchema.safeParse({ isTrusted: true }).success).toBe(false);
  });

  describe("list_workspaces の権限（D56）", () => {
    const base = {
      boundWorkspace: { name: "x", path: "/x" },
      isTrusted: true,
      capabilities: { symbolResolution: true, terminalEnvInjection: true },
      otherWindowsListed: false,
    };
    const full = {
      ...base,
      permissions: { closeHumanTabs: false, closeDirtyTabs: false },
      features: { stage: true, html: true, layout: false },
      disabledTools: ["show_view"],
      editorGroup: "dedicated",
      avoidToolColumns: true,
      panels: { max: 2 },
    };

    it("permissions / features / disabledTools / editorGroup / panels を受ける（値がそのまま残る）", () => {
      const r = listWorkspacesResultSchema.safeParse(full);
      expect(r.success, JSON.stringify(r)).toBe(true);
      if (!r.success) return;
      // 名前ではなく値を主張する。通っただけでは「落とされて空になった」と区別できない。
      expect(r.data.permissions).toEqual({ closeHumanTabs: false, closeDirtyTabs: false });
      expect(r.data.features).toEqual({ stage: true, html: true, layout: false });
      expect(r.data.disabledTools).toEqual(["show_view"]);
      expect(r.data.editorGroup).toBe("dedicated");
      expect(r.data.avoidToolColumns).toBe(true);
      expect(r.data.panels).toEqual({ max: 2 });
    });

    /**
     * `avoidToolColumns` は `showme.stage.avoidToolColumns` を写す（D90）。**必須** ―― 欄が消えると
     * エージェントは `no-stage-column` の断りを「設定のせい」と読めない。boolean だけ。
     */
    it("avoidToolColumns は必須の boolean（D90）", () => {
      const { avoidToolColumns: _a, ...noAvoid } = full;
      expect(listWorkspacesResultSchema.safeParse(noAvoid).success).toBe(false);
      expect(
        listWorkspacesResultSchema.safeParse({ ...full, avoidToolColumns: "yes" }).success,
      ).toBe(false);
      const off = listWorkspacesResultSchema.safeParse({ ...full, avoidToolColumns: false });
      expect(off.success).toBe(true);
      if (off.success) expect(off.data.avoidToolColumns).toBe(false);
    });

    /**
     * `panels.max` は `showme.html.maxPanels` を写す（増分6.2 D80）。**必須** ―― 無いと
     * エージェントは「上限が無い」とも「2」とも読めず、古い拡張と新しいブリッジの組で欄が
     * 黙って消えるのを線で落とす。値は整数 1〜999 か "unlimited"（`panelLimitSchema`）。
     */
    it("panels.max は必須で、整数 1〜999 か unlimited。未知の鍵と他の値は落ちる（D80）", () => {
      const { panels: _p, ...noPanels } = full;
      expect(listWorkspacesResultSchema.safeParse(noPanels).success).toBe(false);
      for (const max of [1, 5, 999, "unlimited"]) {
        const r = listWorkspacesResultSchema.safeParse({ ...full, panels: { max } });
        expect(r.success, String(max)).toBe(true);
        if (r.success) expect(r.data.panels.max).toBe(max);
      }
      for (const max of [0, 1000, 2.5, "2", "Unlimited", null]) {
        expect(
          listWorkspacesResultSchema.safeParse({ ...full, panels: { max } }).success,
          String(max),
        ).toBe(false);
      }
      expect(listWorkspacesResultSchema.safeParse({ ...full, panels: {} }).success).toBe(false);
      expect(
        listWorkspacesResultSchema.safeParse({ ...full, panels: { max: 2, open: 1 } }).success,
      ).toBe(false);
    });

    /**
     * `features` は3つの `enabled` を写す（増分6 D74）。**3鍵とも必須**で、
     * 未知の鍵は落とす ―― 機能を足した人が線上の形を足し忘れたら、ここで気づく。
     */
    it("features は stage / html / layout の3鍵が必須で、未知の鍵と boolean 以外を通さない", () => {
      for (const missing of ["stage", "html", "layout"] as const) {
        const { [missing]: _x, ...rest } = full.features;
        expect(
          listWorkspacesResultSchema.safeParse({ ...full, features: rest }).success,
          `${missing} が無くても通った`,
        ).toBe(false);
      }
      expect(
        listWorkspacesResultSchema.safeParse({
          ...full,
          features: { ...full.features, terminal: true },
        }).success,
      ).toBe(false);
      expect(
        listWorkspacesResultSchema.safeParse({
          ...full,
          features: { ...full.features, html: "off" },
        }).success,
      ).toBe(false);
      // 対照: 全部 false も通る（true しか通らない検査では緩みを見逃す）。
      const off = listWorkspacesResultSchema.safeParse({
        ...full,
        features: { stage: false, html: false, layout: false },
      });
      expect(off.success).toBe(true);
      if (off.success)
        expect(off.data.features).toEqual({ stage: false, html: false, layout: false });
    });

    it("permissions は両方の真理値を通す（false しか通らない検査では緩みを見逃す）", () => {
      const r = listWorkspacesResultSchema.safeParse({
        ...full,
        permissions: { closeHumanTabs: true, closeDirtyTabs: true },
      });
      expect(r.success).toBe(true);
      if (!r.success) return;
      expect(r.data.permissions).toEqual({ closeHumanTabs: true, closeDirtyTabs: true });
    });

    it("4欄は必須（無ければ落ちる。古い拡張と新しいブリッジの組み合わせを黙って通さない）", () => {
      // 対照: 4欄が揃っていれば通る（上の検査と同じ入力）。
      expect(listWorkspacesResultSchema.safeParse(full).success).toBe(true);
      expect(listWorkspacesResultSchema.safeParse(base).success).toBe(false);
      // 1欄ずつ欠けても落ちる ―― 「4欄まとめて無い」だけを見ていると、
      // 1欄だけ書き忘れた拡張が黙って通る。
      const { permissions: _p, ...noPermissions } = full;
      expect(listWorkspacesResultSchema.safeParse(noPermissions).success).toBe(false);
      const { features: _f, ...noFeatures } = full;
      expect(listWorkspacesResultSchema.safeParse(noFeatures).success).toBe(false);
      const { disabledTools: _d, ...noDisabled } = full;
      expect(listWorkspacesResultSchema.safeParse(noDisabled).success).toBe(false);
      const { editorGroup: _e, ...noGroup } = full;
      expect(listWorkspacesResultSchema.safeParse(noGroup).success).toBe(false);
    });

    it("permissions は未知の鍵を拒否し、boolean 以外を通さない", () => {
      expect(
        listWorkspacesResultSchema.safeParse({
          ...full,
          permissions: { closeHumanTabs: false, closeDirtyTabs: false, deleteFiles: true },
        }).success,
      ).toBe(false);
      expect(
        listWorkspacesResultSchema.safeParse({
          ...full,
          permissions: { closeHumanTabs: "yes", closeDirtyTabs: false },
        }).success,
      ).toBe(false);
    });

    it("disabledTools は TOOL_NAMES の語彙（設定に書かれた未知の綴りを線に載せない）", () => {
      // 対照: 語彙の全部は通る。
      const all = listWorkspacesResultSchema.safeParse({ ...full, disabledTools: [...TOOL_NAMES] });
      expect(all.success, JSON.stringify(all)).toBe(true);
      if (all.success) expect(all.data.disabledTools).toEqual([...TOOL_NAMES]);
      expect(
        listWorkspacesResultSchema.safeParse({ ...full, disabledTools: ["not_a_tool"] }).success,
      ).toBe(false);
      // 語彙が1つでも混ざっていれば落ちる（既知と未知の混在を部分的に通さない）。
      expect(
        listWorkspacesResultSchema.safeParse({ ...full, disabledTools: ["show_view", "rm -rf"] })
          .success,
      ).toBe(false);
      // 語彙の数を超える配列は落ちる（重複で膨らませられない）。
      expect(
        listWorkspacesResultSchema.safeParse({
          ...full,
          disabledTools: [...TOOL_NAMES, TOOL_NAMES[0]],
        }).success,
      ).toBe(false);
    });

    it("editorGroup は dedicated / active だけ", () => {
      const active = listWorkspacesResultSchema.safeParse({ ...full, editorGroup: "active" });
      expect(active.success).toBe(true);
      if (active.success) expect(active.data.editorGroup).toBe("active");
      expect(
        listWorkspacesResultSchema.safeParse({ ...full, editorGroup: "floating" }).success,
      ).toBe(false);
      expect(listWorkspacesResultSchema.safeParse({ ...full, editorGroup: 1 }).success).toBe(false);
    });
  });

  it("RESULT_SCHEMAS は全ツールを覆う（ブリッジが引けないツールを作らない）", () => {
    for (const tool of TOOL_NAMES) {
      expect(Object.keys(RESULT_SCHEMAS)).toContain(tool);
    }
    expect(Object.keys(RESULT_SCHEMAS).length).toBe(TOOL_NAMES.length);
  });

  /**
   * **広告と受け口が食い違う向きを見る。**
   *
   * `TOOL_NAMES` に名前を載せた時点でブリッジはその道具をエージェントに広告する。
   * ところが `requestSchema` に枝が無ければ、呼んだ瞬間に拡張の要求解析で落ちる
   * ―― 実際に `arrange_editors` が一度その状態になった（語彙も結果スキーマも
   * 注釈もあり、単体は全部緑で、**呼ぶことだけができなかった**）。
   *
   * 逆向き（枝があって dispatch が無い）は switch の網羅で型が捕まえるが、
   * こちら向きは型では出ない。だから検査で見る。
   */
  it("requestSchema は全ツールを覆う（広告しているのに呼べない道具を作らない）", () => {
    const branches = requestSchema.options.map((option) => option.shape.tool.value as string);
    for (const tool of TOOL_NAMES) {
      expect(branches).toContain(tool);
    }
    expect(branches.length).toBe(TOOL_NAMES.length);
  });

  it("arrange_editors は要求として解析でき、語彙の外は落ちる", () => {
    const ok = requestSchema.safeParse({
      id: "1",
      tool: "arrange_editors",
      args: { action: "close-own" },
    });
    expect(ok.success).toBe(true);
    // **通るべきものが通ることも見る。** 「落ちること」だけを見ていると、
    // 全部落ちていても緑になる。
    expect(
      requestSchema.safeParse({ id: "1", tool: "arrange_editors", args: { action: "grid" } })
        .success,
    ).toBe(true);
    // 任意のコマンド名は受け取らない（D36/D42）。
    expect(
      requestSchema.safeParse({
        id: "1",
        tool: "arrange_editors",
        args: { action: "workbench.action.closeAllEditors" },
      }).success,
    ).toBe(false);
    // `.strict()` なので、コマンド名を別の鍵で持ち込むこともできない。
    expect(
      requestSchema.safeParse({
        id: "1",
        tool: "arrange_editors",
        args: { action: "grid", command: "workbench.action.closeAllEditors" },
      }).success,
    ).toBe(false);
  });

  it("arrange_editors の paths は 1〜MAX_CLOSE_TABS_PATHS 本、各 1〜1024 文字（要否はハンドラが決める）", () => {
    const parse = (args: unknown) =>
      requestSchema.safeParse({ id: "1", tool: "arrange_editors", args }).success;
    // 肯定対照。形の規則（`close-tabs` のときだけ／`close-tabs` には必須）はスキーマに無い
    // ―― ハンドラが1回判定する。だからスキーマは `paths` 付きの `grid` も通す。
    expect(parse({ action: "close-tabs", paths: ["src/a.ts"] })).toBe(true);
    expect(parse({ action: "close-tabs", paths: ["src/a.ts", "src/b.ts"] })).toBe(true);
    expect(parse({ action: "close-tabs" })).toBe(true);
    expect(parse({ action: "grid", paths: ["src/a.ts"] })).toBe(true);
    // 上限は protocol の1つ（`MAX_CLOSE_TABS_PATHS`）。ちょうどは通り、1本超えると落ちる。
    expect(MAX_CLOSE_TABS_PATHS).toBe(50);
    const many = Array.from({ length: MAX_CLOSE_TABS_PATHS }, (_, i) => `src/${i}.ts`);
    expect(parse({ action: "close-tabs", paths: many })).toBe(true);
    expect(parse({ action: "close-tabs", paths: [...many, "src/extra.ts"] })).toBe(false);
    // 空の配列は「何も指していない」―― 落とす（`{}` の意味を「全部」に読ませない）。
    expect(parse({ action: "close-tabs", paths: [] })).toBe(false);
    expect(parse({ action: "close-tabs", paths: [""] })).toBe(false);
    expect(parse({ action: "close-tabs", paths: ["a".repeat(1024)] })).toBe(true);
    expect(parse({ action: "close-tabs", paths: ["a".repeat(1025)] })).toBe(false);
    expect(parse({ action: "close-tabs", paths: "src/a.ts" })).toBe(false);
    expect(parse({ action: "close-tabs", paths: [1] })).toBe(false);
    // `.strict()` は保つ ―― 鍵を1つ足しても未知の鍵は落ちる。
    expect(parse({ action: "close-tabs", paths: ["src/a.ts"], all: true })).toBe(false);
  });

  it("arrange_editors の結果に notOpen が載る（関門を通ったが開いていなかったパス）", () => {
    const ok = { done: true, closed: 1 };
    expect(arrangeEditorsResultSchema.safeParse({ ...ok, notOpen: ["src/b.ts"] }).success).toBe(
      true,
    );
    expect(arrangeEditorsResultSchema.safeParse({ ...ok, notOpen: [] }).success).toBe(true);
    // 上限は引数の本数と同じ量（指した本数より多くは「開いていない」と言えない）。
    const many = Array.from({ length: MAX_CLOSE_TABS_PATHS }, (_, i) => `src/${i}.ts`);
    expect(arrangeEditorsResultSchema.safeParse({ ...ok, notOpen: many }).success).toBe(true);
    expect(
      arrangeEditorsResultSchema.safeParse({ ...ok, notOpen: [...many, "src/extra.ts"] }).success,
    ).toBe(false);
    expect(
      arrangeEditorsResultSchema.safeParse({ ...ok, notOpen: ["a".repeat(1025)] }).success,
    ).toBe(false);
    expect(arrangeEditorsResultSchema.safeParse({ ...ok, notOpen: "src/b.ts" }).success).toBe(
      false,
    );
    // **開いていた側の名前は返さない。** `closedPaths` のような鍵は落ちる（タブの名前を
    // 数える口を作らない ―― 既存の「断った枚数を返せない」と同じ向き）。
    expect(arrangeEditorsResultSchema.safeParse({ ...ok, closedPaths: ["src/a.ts"] }).success).toBe(
      false,
    );
  });

  it("arrange_editors の slot は整数 1〜999（D61 → 増分6.2 D80。要否はハンドラが決める）", () => {
    const parse = (args: unknown) =>
      requestSchema.safeParse({ id: "1", tool: "arrange_editors", args }).success;
    // 肯定対照。形の規則（`move-panel` のときだけ）はスキーマに無い ―― ハンドラが1回判定する。
    expect(parse({ action: "move-panel", toColumn: 2, slot: 2 })).toBe(true);
    expect(parse({ action: "move-panel", toColumn: 2, slot: 1 })).toBe(true);
    // 3 はスキーマを通る（上限は設定が決め、拡張が判定する。D80）。
    expect(parse({ action: "move-panel", toColumn: 2, slot: 3 })).toBe(true);
    expect(parse({ action: "move-panel", toColumn: 2, slot: MAX_PANEL_SLOT })).toBe(true);
    expect(parse({ action: "move-panel", toColumn: 2, slot: MAX_PANEL_SLOT + 1 })).toBe(false);
    expect(parse({ action: "move-panel", toColumn: 2, slot: 0 })).toBe(false);
    expect(parse({ action: "move-panel", toColumn: 2, slot: 1.5 })).toBe(false);
    expect(parse({ action: "move-panel", toColumn: 2, slot: "2" })).toBe(false);
  });
});

describe("wire schemas — 上限とハンドシェイク", () => {
  it("locations は1〜3件（不変条件10をスキーマで強制する）", () => {
    const loc = { path: "a.ts", text: "x" };
    expect(showCodeArgsSchema.safeParse({ locations: [] }).success).toBe(false);
    expect(showCodeArgsSchema.safeParse({ locations: [loc, loc, loc] }).success).toBe(true);
    expect(showCodeArgsSchema.safeParse({ locations: [loc, loc, loc, loc] }).success).toBe(false);
  });

  it("realFile は省略できる boolean で、型違いを拒む（D87）", () => {
    const locations = [{ path: "a.ts", text: "x" }];
    expect(showCodeArgsSchema.safeParse({ locations, realFile: true }).success).toBe(true);
    expect(showCodeArgsSchema.safeParse({ locations, realFile: false }).success).toBe(true);
    expect(showCodeArgsSchema.safeParse({ locations }).success).toBe(true);
    for (const wrong of ["true", 1, null, {}]) {
      expect(
        showCodeArgsSchema.safeParse({ locations, realFile: wrong }).success,
        JSON.stringify(wrong),
      ).toBe(false);
    }
    // 線の要求（`requestSchema`）の上でも同じ形で通る。
    const r = requestSchema.safeParse({
      id: "1",
      tool: "show_code",
      args: { locations, realFile: true },
    });
    expect(r.success).toBe(true);
    if (r.success && r.data.tool === "show_code") expect(r.data.args.realFile).toBe(true);
  });

  it("realFile の説明は、人間のタブになり close-own で閉じられないことを言う（D87）", () => {
    const description = showCodeArgsSchema.shape.realFile.description ?? "";
    expect(description).toContain("real file");
    expect(description).toContain("close-own");
    expect(description).toContain("close-own leaves it open (it belongs to the human)");
    expect(description).toContain(
      "instead of your own tab (your tab is the default and is read-only under default settings)",
    );
    expect(description).not.toContain("you cannot close it");
    expect(description.endsWith(".")).toBe(true);
  });

  it("プロトコル版が違うハンドシェイクを拒否する", () => {
    const token = "a".repeat(64);
    expect(helloSchema.safeParse({ protocolVersion: WIRE_PROTOCOL_VERSION, token }).success).toBe(
      true,
    );
    expect(
      helloSchema.safeParse({ protocolVersion: WIRE_PROTOCOL_VERSION + 1, token }).success,
    ).toBe(false);
    expect(helloSchema.safeParse({ protocolVersion: 0, token }).success).toBe(false);
  });
});

describe("結果スキーマに自由文字列の口を残さない", () => {
  const base = { resolvedBy: "text", match: "one", range: { startLine: 1, endLine: 2 } };

  it("reason は決められた語だけ（任意の文字列を通さない）", () => {
    // `reason` が z.string() だと、ここが不変条件2の抜け道になる。
    // 拡張がファイルの中身を reason に詰めても、結果スキーマは通してしまう。
    expect(
      showCodeResultSchema.safeParse({ resolutions: [{ ...base, reason: "not-found" }] }).success,
    ).toBe(true);
    expect(
      showCodeResultSchema.safeParse({
        resolutions: [{ ...base, reason: "const secret = process.env.TOKEN;" }],
      }).success,
    ).toBe(false);
  });

  it("no-stage-column は語彙にある（舞台の列が作れない断りを無言にしない。D90）", () => {
    // 無いと、開けなかった位置は `not-found` しか言えず、エージェントは「文字列が無い」と
    // 「設定で開く列が無い」を区別できない ―― 綴りを変えて呼び続ける。
    expect(RESOLUTION_REASONS).toContain("no-stage-column");
  });

  it("エラーの語彙に no-stage-column がある（show_note / show_html の断り。D90）", () => {
    expect(errorCodeSchema.safeParse("no-stage-column").success).toBe(true);
    // 陰性の対照 ―― 閉じた語彙のまま（自由文字列を通さない）。
    expect(errorCodeSchema.safeParse("no-stage-columns").success).toBe(false);
  });

  it("RESOLUTION_REASONS の語はすべて通る（型と線が食い違わない）", () => {
    for (const reason of RESOLUTION_REASONS) {
      expect(showCodeResultSchema.safeParse({ resolutions: [{ ...base, reason }] }).success).toBe(
        true,
      );
    }
  });

  it("normalizedPath は入力のパスと同じ上限までしか通さない", () => {
    const ok = { resolutions: [{ ...base, normalizedPath: "a".repeat(1024) }] };
    const tooLong = { resolutions: [{ ...base, normalizedPath: "a".repeat(1025) }] };
    expect(showCodeResultSchema.safeParse(ok).success).toBe(true);
    expect(showCodeResultSchema.safeParse(tooLong).success).toBe(false);
  });
});

/**
 * エージェントに**広告する引数**は、全部が説明を持つ。
 *
 * `layout` は `inputSchema` に出るのに `.describe()` を持っていなかった（実測）。
 * 「広告して効かない引数」を潰した増分で「効くが説明が無い引数」を残すと、
 * エージェントは値の選び方を推測することになる。1件ずつ思い出すのではなく、
 * **広告面そのものを走査して**塞ぐ。
 */
describe("広告する引数はすべて説明を持つ", () => {
  /** `.optional()` の外側／内側のどちらに書かれていても拾う。 */
  function descriptionOf(schema: unknown): string | undefined {
    let node = schema as { description?: string; _def?: { innerType?: unknown } } | undefined;
    for (let depth = 0; node !== undefined && depth < 8; depth += 1) {
      if (typeof node.description === "string" && node.description.length > 0)
        return node.description;
      node = node._def?.innerType as typeof node;
    }
    return undefined;
  }

  it("show_code の引数", () => {
    for (const [key, field] of Object.entries(showCodeArgsSchema.shape)) {
      expect(descriptionOf(field), `show_code.${key} に .describe() が無い`).toBeTruthy();
    }
  });

  it("show_html の引数（path も含む）", () => {
    for (const [key, field] of Object.entries(showHtmlArgsObjectSchema.shape)) {
      expect(descriptionOf(field), `show_html.${key} に .describe() が無い`).toBeTruthy();
    }
    // path の説明は「保存のたびに描き直す」「呼び直し不要」を言う（C4 の使い方が広告面に載る）。
    expect(descriptionOf(showHtmlArgsObjectSchema.shape.path)).toContain(
      "re-renders it every time the file is saved",
    );
    expect(descriptionOf(showHtmlArgsObjectSchema.shape.path)).toContain("no need to call again");
  });

  it("Location の項目", () => {
    for (const [key, field] of Object.entries(locationSchema.shape)) {
      expect(descriptionOf(field), `location.${key} に .describe() が無い`).toBeTruthy();
    }
  });

  it("annotate の引数", () => {
    // 広告面は `annotateArgsObjectSchema`（`.shape` を持つほう）。`annotateArgsSchema` は
    // その上の transform で、SDK はそれを広告できない（D54 の実測）。
    for (const [key, field] of Object.entries(annotateArgsObjectSchema.shape)) {
      expect(descriptionOf(field), `annotate.${key} に .describe() が無い`).toBeTruthy();
    }
    // 本文は「markdown ではない」ことが説明に書かれていないと、エージェントは
    // 太字や箇条書きを送ってくる（そして人間の画面にはその記号がそのまま出る）。
    expect(descriptionOf(annotateItemSchema.shape.text)).toContain("A plain string, not markdown");
    // `clear` の規則は説明文にも載る（形だけでは「items を省ける」としか読めない）。
    expect(descriptionOf(annotateArgsObjectSchema.shape.mode)).toContain("clear");
    expect(descriptionOf(annotateArgsObjectSchema.shape.items)).toContain("clear");
  });
});

/**
 * `annotate` の引数（設計書 §3.2）。
 *
 * 上限を型で強制しておく ―― 注釈は人間の画面を埋められる唯一のツールなので、
 * 「件数」と「1件の長さ」の両方に上限が要る。片方だけだと、もう片方で溢れる。
 */
describe("annotate の引数スキーマ", () => {
  const item = { location: { path: "a.ts", text: "x" }, text: "説明" };

  it("既定の形を受け付ける（mode は省略できる）", () => {
    expect(annotateArgsSchema.safeParse({ items: [item] }).success).toBe(true);
    expect(annotateArgsSchema.safeParse({ items: [item], mode: "replace" }).success).toBe(true);
    expect(annotateArgsSchema.safeParse({ items: [item], mode: "add" }).success).toBe(true);
  });

  it("知らない mode を拒否する", () => {
    expect(annotateArgsSchema.safeParse({ items: [item], mode: "append" }).success).toBe(false);
  });

  it("realFile は省略できる boolean で、型違いを拒み、検証後の形に残る（D87）", () => {
    expect(annotateArgsSchema.parse({ items: [item], realFile: true })).toEqual({
      items: [item],
      realFile: true,
    });
    expect(annotateArgsSchema.parse({ items: [item], mode: "add", realFile: false })).toEqual({
      items: [item],
      mode: "add",
      realFile: false,
    });
    expect(annotateArgsSchema.parse({ items: [item] })).toEqual({ items: [item] });
    for (const wrong of ["true", 1, null]) {
      expect(
        annotateArgsSchema.safeParse({ items: [item], realFile: wrong }).success,
        JSON.stringify(wrong),
      ).toBe(false);
    }
    // clear は窓の全部を消すので、どこに付けるかは意味を持たない（受けて捨てる）。
    expect(annotateArgsSchema.parse({ mode: "clear", realFile: true })).toEqual({ mode: "clear" });
    expect(annotateArgsObjectSchema.shape.realFile.description).toContain("real file");
  });

  it("items は1〜20件", () => {
    expect(annotateArgsSchema.safeParse({ items: [] }).success).toBe(false);
    const many = Array.from({ length: MAX_ANNOTATION_ITEMS }, () => item);
    expect(annotateArgsSchema.safeParse({ items: many }).success).toBe(true);
    expect(annotateArgsSchema.safeParse({ items: [...many, item] }).success).toBe(false);
  });

  it("本文は空にできず、上限を超えられない", () => {
    expect(
      annotateArgsSchema.safeParse({ items: [{ location: item.location, text: "" }] }).success,
    ).toBe(false);
    const long = "a".repeat(MAX_ANNOTATION_TEXT_CHARS + 1);
    expect(
      annotateArgsSchema.safeParse({ items: [{ location: item.location, text: long }] }).success,
    ).toBe(false);
  });

  it("知らない鍵を落とさず拒否する（strict がネストでも効く）", () => {
    expect(annotateArgsSchema.safeParse({ items: [{ ...item, isTrusted: true }] }).success).toBe(
      false,
    );
    expect(annotateArgsSchema.safeParse({ items: [item], extra: 1 }).success).toBe(false);
  });

  it("線上の要求としても受け付ける", () => {
    expect(
      requestSchema.safeParse({ id: "1", tool: "annotate", args: { items: [item] } }).success,
    ).toBe(true);
  });
});

/**
 * `mode: "clear"`（設計 D54）。
 *
 * 「解決しない位置を1件渡して replace の副作用で消す」は実装の順序に依存した
 * 経路で、仕様ではない。消す口を形として持つ。
 */
describe("annotate の clear（D54）", () => {
  const item = { location: { path: "a.ts", lines: { start: 1, end: 1 } }, text: "x" };

  it("{ mode: clear } だけで通り、そのままの形で出る", () => {
    const parsed = annotateArgsSchema.safeParse({ mode: "clear" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual({ mode: "clear" });
  });

  it("clear に items を付けると落ちる（意図が曖昧になる）", () => {
    // 空配列でも落ちる ―― が、それは `min(1)` という**別の理由**でも落ちる形なので、
    // 1件入りのほうで「items があること」自体が理由だと確かめる。
    expect(annotateArgsSchema.safeParse({ mode: "clear", items: [] }).success).toBe(false);
    const withItems = annotateArgsSchema.safeParse({ mode: "clear", items: [item] });
    expect(withItems.success).toBe(false);
    if (!withItems.success) {
      expect(withItems.error.issues.map((i) => i.path.join("."))).toEqual(["items"]);
    }
  });

  it("replace / add は items が要る（変わらない）", () => {
    expect(annotateArgsSchema.safeParse({ mode: "replace" }).success).toBe(false);
    expect(annotateArgsSchema.safeParse({ mode: "add" }).success).toBe(false);
    expect(annotateArgsSchema.safeParse({}).success).toBe(false);
    // 肯定対照: items があれば通る（この検査が別の理由で落ちていないこと）。
    expect(annotateArgsSchema.safeParse({ mode: "replace", items: [item] }).success).toBe(true);
  });

  it("線上の要求としても受け付ける", () => {
    expect(
      requestSchema.safeParse({ id: "1", tool: "annotate", args: { mode: "clear" } }).success,
    ).toBe(true);
  });

  it("知らない鍵は clear でも落ちる（strict）", () => {
    expect(annotateArgsSchema.safeParse({ mode: "clear", extra: 1 }).success).toBe(false);
  });
});

describe("annotate の色（設計 D46/D47/D57）", () => {
  /** 位置そのものは妥当であること。ここが妥当でないと「色が落ちた」が別の理由で真になる。 */
  const LOC = { path: "a.ts", lines: { start: 1, end: 1 } };

  it("5色を受ける", () => {
    for (const color of ["yellow", "green", "red", "blue", "purple"]) {
      const parsed = annotateArgsSchema.safeParse({
        items: [{ location: LOC, text: "x", color }],
      });
      expect(parsed.success, `${color} が落ちた`).toBe(true);
    }
  });

  it("省略できる（無印）", () => {
    expect(annotateArgsSchema.safeParse({ items: [{ location: LOC, text: "x" }] }).success).toBe(
      true,
    );
  });

  it("語彙の外は落ちる", () => {
    // **ここが作成者名への経路を閉じている。** 色は拡張側の固定表
    // `ANNOTATION_AUTHOR[color]` の**鍵**にしかならないので、語彙の外の文字列が
    // 通ると鍵の照合が外れて `undefined` になり、作成者名を偽装する口になる
    // （設計書 §5.4 / D57）。表の鍵として解釈されうる名前（`__proto__` 等）も並べる。
    // （D47 の時代はここが `iconPath` への経路を閉じていた。アイコンは消えたが、
    // 「自由文字列を表の鍵にしない」という性質は同じである。）
    for (const bad of [
      "orange",
      "#ff0000",
      "../../etc/passwd",
      "https://evil.example/x.png",
      "",
      "__proto__",
      "constructor",
      "toString",
    ]) {
      const parsed = annotateArgsSchema.safeParse({
        items: [{ location: LOC, text: "x", color: bad }],
      });
      expect(parsed.success, `${bad} が通った`).toBe(false);
    }
  });

  it("灰は受けない（D57: 環境依存の丸を出さない）", () => {
    const item = (color: string) => ({
      items: [{ location: LOC, text: "x", color }],
    });
    expect(annotateArgsSchema.safeParse(item("grey")).success).toBe(false);
    // **意図した理由で落ちていること**: 同じ形で色だけ変えれば通る。
    expect(annotateArgsSchema.safeParse(item("red")).success).toBe(true);
  });

  /**
   * 注釈の色は項目の `color` にだけある。`location.color` は `show_code` の摘みで、
   * 注釈では効かない ―― 効かない摘みを広告しない（増分6 D65'）。
   */
  it("location.color は落ちる（塗るのは項目の color。D65'）", () => {
    const parsed = annotateArgsSchema.safeParse({
      items: [{ location: { ...LOC, color: "red" }, text: "x" }],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(namesColor(parsed.error)).toBe(true);
    }
    // 肯定対照: 同じ形で location.color だけ外せば通る。
    expect(annotateArgsSchema.safeParse({ items: [{ location: LOC, text: "x" }] }).success).toBe(
      true,
    );
  });

  it("対照: show_code の location.color は残る", () => {
    expect(showCodeArgsSchema.safeParse({ locations: [{ ...LOC, color: "red" }] }).success).toBe(
      true,
    );
  });

  it("ハイライトの語彙の部分集合である（灰を除いて一致）", () => {
    // そろえておくと「赤いハイライトと赤い注釈」を対にできる。対応づけは5色で成立し、
    // 灰の**ハイライト**は CSS の色なので環境依存が無く、そちらは残す（D57）。
    for (const c of ANNOTATION_COLORS) expect(HIGHLIGHT_COLORS).toContain(c);
    expect(ANNOTATION_COLORS).not.toContain("grey");
    expect([...ANNOTATION_COLORS]).toEqual(["yellow", "green", "red", "blue", "purple"]);
  });

  it("無印の塗りは灰で、注釈の語彙の外にある（増分6.1 D78）", () => {
    // 無印の塗りは塗る側の既定であって、エージェントが選ぶ色ではない。語彙に灰を
    // 戻すと灰の丸（⚪/⚫）の問題が戻る。
    expect(UNMARKED_ANNOTATION_PAINT).toBe("grey");
    expect(HIGHLIGHT_COLORS).toContain(UNMARKED_ANNOTATION_PAINT);
    expect(ANNOTATION_COLORS).not.toContain(UNMARKED_ANNOTATION_PAINT);
    expect(
      annotateArgsSchema.safeParse({ items: [{ location: LOC, text: "x", color: "grey" }] })
        .success,
    ).toBe(false);
  });
});

/**
 * `get_editor_state` の結果に人間の画面のレイアウトが載る（設計 D37/D37'/D38）。
 *
 * ここで見ているのは**線に載る形の有界性**である。中身（可視行・カーソル・
 * 選択）を秘匿ファイルで落とすのは拡張側の判断で、`buildEditorLayout` の
 * 単体と実機の統合が見ている。スキーマは「入りうる形」の上限を決める。
 */
describe("get_editor_state の結果にレイアウトが載る（設計 D38）", () => {
  it("groups を受ける", () => {
    const parsed = getEditorStateResultSchema.safeParse({
      openPaths: ["a.ts"],
      groups: [
        {
          viewColumn: 1,
          isActive: true,
          tabs: [
            {
              label: "a.ts",
              kind: "file",
              path: "a.ts",
              isActive: true,
              isDirty: true,
              visibleLines: { start: 1, end: 40 },
            },
            { label: "(terminal)", kind: "terminal" },
          ],
        },
      ],
    });
    expect(parsed.success, JSON.stringify(parsed)).toBe(true);
  });

  it("groups は省略できる（レイアウトが空の窓）", () => {
    expect(getEditorStateResultSchema.safeParse({ openPaths: [] }).success).toBe(true);
  });

  it("openPathsHidden は**もう受けない**（D37 で削除）", () => {
    // 対照。`openPaths: []` だけなら通ることを上の検査が示しているので、
    // ここで落ちる理由は `openPathsHidden` である。
    const parsed = getEditorStateResultSchema.safeParse({ openPaths: [], openPathsHidden: 3 });
    expect(parsed.success).toBe(false);
  });

  it("kind は閉じた語彙", () => {
    const good = getEditorStateResultSchema.safeParse({
      openPaths: [],
      groups: [{ viewColumn: 1, tabs: [{ label: "x", kind: "file" }] }],
    });
    // 対照が無いと、下の false が `kind` 以外の理由で成り立ちうる。
    expect(good.success, JSON.stringify(good)).toBe(true);
    const parsed = getEditorStateResultSchema.safeParse({
      openPaths: [],
      groups: [{ viewColumn: 1, tabs: [{ label: "x", kind: "arbitrary" }] }],
    });
    expect(parsed.success).toBe(false);
  });

  it("TAB_KINDS の語はすべて通る（型と線が食い違わない）", () => {
    for (const kind of TAB_KINDS) {
      const parsed = getEditorStateResultSchema.safeParse({
        openPaths: [],
        groups: [{ viewColumn: 1, tabs: [{ label: "x", kind }] }],
      });
      expect(parsed.success, `${kind} が落ちた`).toBe(true);
    }
  });

  it("タブに未知の鍵を生やせない（中身を詰める口を残さない）", () => {
    const parsed = getEditorStateResultSchema.safeParse({
      openPaths: [],
      groups: [{ viewColumn: 1, tabs: [{ label: "x", kind: "file", fileContents: "SECRET=1" }] }],
    });
    expect(parsed.success).toBe(false);
  });

  it("own の webview に slot が付く（C5）。整数 1〜999 で、0 / 1000 / 文字列は落ちる（D80）", () => {
    const parse = (tab: Record<string, unknown>) =>
      getEditorStateResultSchema.safeParse({
        openPaths: [],
        groups: [
          { viewColumn: 1, tabs: [{ label: "ShowMe", kind: "webview", own: true, ...tab }] },
        ],
      }).success;
    expect(parse({ slot: 1 })).toBe(true);
    expect(parse({ slot: 2 })).toBe(true);
    expect(parse({ slot: 3 })).toBe(true);
    expect(parse({ slot: MAX_PANEL_SLOT })).toBe(true);
    expect(parse({})).toBe(true);
    expect(parse({ slot: 0 })).toBe(false);
    expect(parse({ slot: MAX_PANEL_SLOT + 1 })).toBe(false);
    expect(parse({ slot: "1" })).toBe(false);
  });

  it("旗は true しか入らない（false を毎回言わない）", () => {
    const parsed = getEditorStateResultSchema.safeParse({
      openPaths: [],
      groups: [{ viewColumn: 1, tabs: [{ label: "x", kind: "file", isDirty: false }] }],
    });
    expect(parsed.success).toBe(false);
  });

  it("列の数・タブの数・見出しの長さに上限がある", () => {
    const tooManyGroups = {
      openPaths: [],
      groups: Array.from({ length: MAX_EDITOR_GROUPS + 1 }, (_, i) => ({
        viewColumn: i + 1,
        tabs: [],
      })),
    };
    expect(getEditorStateResultSchema.safeParse(tooManyGroups).success).toBe(false);
    // 上限ちょうどは通る（「上限で落ちた」が別の理由でないことの対照）。
    expect(
      getEditorStateResultSchema.safeParse({
        ...tooManyGroups,
        groups: tooManyGroups.groups.slice(0, MAX_EDITOR_GROUPS),
      }).success,
    ).toBe(true);

    const tooManyTabs = {
      openPaths: [],
      groups: [
        {
          viewColumn: 1,
          tabs: Array.from({ length: MAX_TABS_PER_GROUP + 1 }, () => ({
            label: "x",
            kind: "file" as const,
          })),
        },
      ],
    };
    expect(getEditorStateResultSchema.safeParse(tooManyTabs).success).toBe(false);
    expect(
      getEditorStateResultSchema.safeParse({
        openPaths: [],
        groups: [{ viewColumn: 1, tabs: tooManyTabs.groups[0].tabs.slice(0, MAX_TABS_PER_GROUP) }],
      }).success,
    ).toBe(true);

    const longLabel = {
      openPaths: [],
      groups: [
        { viewColumn: 1, tabs: [{ label: "a".repeat(MAX_TAB_LABEL_CHARS + 1), kind: "file" }] },
      ],
    };
    expect(getEditorStateResultSchema.safeParse(longLabel).success).toBe(false);
    expect(
      getEditorStateResultSchema.safeParse({
        openPaths: [],
        groups: [
          { viewColumn: 1, tabs: [{ label: "a".repeat(MAX_TAB_LABEL_CHARS), kind: "file" }] },
        ],
      }).success,
    ).toBe(true);
  });

  it("viewColumn は1以上の整数", () => {
    for (const viewColumn of [0, -1, 1.5]) {
      const parsed = getEditorStateResultSchema.safeParse({
        openPaths: [],
        groups: [{ viewColumn, tabs: [] }],
      });
      expect(parsed.success, `viewColumn=${viewColumn} が通った`).toBe(false);
    }
  });

  it("path はワークスペース相対パスの上限で切れる", () => {
    const tab = (path: string) => ({
      openPaths: [],
      groups: [{ viewColumn: 1, tabs: [{ label: "x", kind: "file" as const, path }] }],
    });
    expect(getEditorStateResultSchema.safeParse(tab("a".repeat(1024))).success).toBe(true);
    expect(getEditorStateResultSchema.safeParse(tab("a".repeat(1025))).success).toBe(false);
  });
});

/**
 * `show_html` の `path`（設計 D52 / C4）。
 *
 * `html | path` の排他は **object＋transform** で書く（`.refine` / union ではない）。
 * MCP SDK が `.shape` の無いスキーマを広告できないと実測済み。
 */
describe("show_html の path（D52）", () => {
  const ok = (a: unknown) => showHtmlArgsSchema.safeParse(a).success;

  it("html か path のどちらか一方", () => {
    expect(ok({ path: "docs/a.html" })).toBe(true);
    expect(ok({ html: "<p>x</p>" })).toBe(true);
    expect(ok({ path: "docs/a.html", title: "t" })).toBe(true);
    expect(ok({ html: "<p>x</p>", path: "a.html" })).toBe(false);
    expect(ok({ title: "t" })).toBe(false);
    expect(ok({})).toBe(false);
  });

  it("両方あるとき／どちらも無いときの issue は path を指す（意図した理由で落ちる）", () => {
    for (const args of [{ html: "<p>x</p>", path: "a.html" }, { title: "t" }]) {
      const r = showHtmlArgsSchema.safeParse(args);
      expect(r.success).toBe(false);
      if (!r.success) {
        expect(r.error.issues.some((i) => i.path.includes("path"))).toBe(true);
      }
    }
  });

  it("transform の出力は kind で判別できる", () => {
    expect(showHtmlArgsSchema.parse({ path: "docs/a.html" })).toEqual({
      kind: "path",
      path: "docs/a.html",
      slot: 1,
    });
    expect(showHtmlArgsSchema.parse({ html: "<p>x</p>", title: "t" })).toEqual({
      kind: "html",
      html: "<p>x</p>",
      slot: 1,
      title: "t",
    });
    // 未指定の title は鍵ごと省く（`exactOptionalPropertyTypes`）。`slot` は**省かない**
    // （既定 1 に畳むのは transform の1箇所。ハンドラにもう一度 `?? 1` を書かない）。
    expect(Object.keys(showHtmlArgsSchema.parse({ html: "<p>x</p>" })).sort()).toEqual([
      "html",
      "kind",
      "slot",
    ]);
  });

  it("path は空にできず、相対パスの上限で切れる", () => {
    expect(ok({ path: "" })).toBe(false);
    expect(ok({ path: "a".repeat(1024) })).toBe(true);
    expect(ok({ path: "a".repeat(1025) })).toBe(false);
  });

  it("知らない鍵は拒否する（strict）", () => {
    expect(ok({ path: "a.html", watch: false })).toBe(false);
  });

  it("広告される形は object で、html / path / slot / title を持つ", () => {
    expect(Object.keys(showHtmlArgsObjectSchema.shape).sort()).toEqual([
      "html",
      "path",
      "slot",
      "title",
    ]);
  });
});

/**
 * `show_html` の `slot`（設計 D61 / §B2 → 増分6.2 D80）。**スキーマは上限を知らない。**
 * 線上の形は整数 1〜999（線の健全性）で、何枚まで出せるかは人間の設定
 * `showme.html.maxPanels` が決め、拡張の `show-html.ts` が `panelSlotAllowed` で1回判定する。
 *
 * 否定の検査には肯定対照（`slot: 2`）を並べる ―― `slot` の鍵そのものが `.strict()` で
 * 落ちていても「0 は落ちる」は真になる（計画「部分一致は違う理由で通る」）。
 */
describe("show_html の slot（D61 / D80）", () => {
  const ok = (a: unknown) => showHtmlArgsSchema.safeParse(a).success;

  it('整数 1〜999 が通る。0 / 1000 / 1.5 / "1" は落ちる', () => {
    expect(ok({ html: "<p>x</p>", slot: 1 })).toBe(true);
    expect(ok({ html: "<p>x</p>", slot: 2 })).toBe(true);
    expect(ok({ path: "docs/a.html", slot: 2 })).toBe(true);
    // 3 はスキーマを通る。断るかは拡張が設定で決める（D80）。
    expect(ok({ html: "<p>x</p>", slot: 3 })).toBe(true);
    expect(ok({ html: "<p>x</p>", slot: MAX_PANEL_SLOT })).toBe(true);
    expect(ok({ html: "<p>x</p>", slot: MAX_PANEL_SLOT + 1 })).toBe(false);
    expect(ok({ html: "<p>x</p>", slot: 0 })).toBe(false);
    expect(ok({ html: "<p>x</p>", slot: "1" })).toBe(false);
    expect(ok({ html: "<p>x</p>", slot: 1.5 })).toBe(false);
  });

  it("落ちる理由は slot である（意図した理由で落ちる）", () => {
    for (const bad of [0, MAX_PANEL_SLOT + 1, 1.5]) {
      const r = showHtmlArgsSchema.safeParse({ html: "<p>x</p>", slot: bad });
      expect(r.success, String(bad)).toBe(false);
      if (!r.success) expect(r.error.issues.some((i) => i.path.includes("slot"))).toBe(true);
    }
  });

  it("省略は 1、指定した値はそのまま transform の出力に載る", () => {
    expect(showHtmlArgsSchema.parse({ html: "<p>x</p>" }).slot).toBe(1);
    expect(showHtmlArgsSchema.parse({ html: "<p>x</p>", slot: 2 }).slot).toBe(2);
    expect(showHtmlArgsSchema.parse({ path: "docs/a.html", slot: 2 }).slot).toBe(2);
    expect(showHtmlArgsSchema.parse({ path: "docs/a.html", slot: 7 }).slot).toBe(7);
  });

  it("slot の説明は「上限は人間の設定 showme.html.maxPanels（既定 2）」「list_workspaces.panels.max で分かる」「越えると invalid-request で上限を言う」を言う", () => {
    const description = showHtmlArgsObjectSchema.shape.slot.description ?? "";
    expect(description).toContain("showme.html.maxPanels");
    expect(description).toContain("default 2");
    expect(description).toContain("list_workspaces.panels.max");
    expect(description).toContain("invalid-request");
    expect(description).toContain("Showing again in the same slot replaces its content");
    // 古い文言（上限がスキーマにあった頃）は残さない ―― 残るとエージェントが 2 で止まる。
    expect(description).not.toContain("Up to 2 panels");
    expect(description).not.toContain("There is no third");
  });

  it("arrange_editors の slot の説明も同じ上限の出所を言う", () => {
    const description = arrangeEditorsArgsSchema.shape.slot.description ?? "";
    expect(description).toContain("Only for move-panel");
    expect(description).toContain("showme.html.maxPanels");
    expect(description).toContain("list_workspaces.panels.max");
  });
});

/**
 * `find_definition` / `find_references` も `location` を受けるが、拡張は色を読まない
 * （`handlers/find-locations.ts` に color は出てこない）。D65' の規則は同じ:
 * 色を持つのは `show_code` だけ。
 */
describe("find_* の location.color（D65'）", () => {
  const LOC = { path: "a.ts", text: "x" };

  it("find_definition は location.color を落とす", () => {
    const parsed = findDefinitionArgsSchema.safeParse({ location: { ...LOC, color: "red" } });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(namesColor(parsed.error)).toBe(true);
    }
    expect(findDefinitionArgsSchema.safeParse({ location: LOC }).success).toBe(true);
  });

  it("find_references は location.color を落とす", () => {
    const parsed = findReferencesArgsSchema.safeParse({
      location: { ...LOC, color: "red" },
      includeDeclaration: true,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(namesColor(parsed.error)).toBe(true);
    }
    expect(
      findReferencesArgsSchema.safeParse({ location: LOC, includeDeclaration: true }).success,
    ).toBe(true);
  });

  it("線上の要求としても落ちる（requestSchema が同じスキーマを使っている）", () => {
    expect(
      requestSchema.safeParse({
        id: "1",
        tool: "find_definition",
        args: { location: { ...LOC, color: "red" } },
      }).success,
    ).toBe(false);
    expect(
      requestSchema.safeParse({
        id: "1",
        tool: "annotate",
        args: { items: [{ location: { ...LOC, color: "red" }, text: "y" }] },
      }).success,
    ).toBe(false);
    expect(
      requestSchema.safeParse({
        id: "1",
        tool: "show_code",
        args: { locations: [{ ...LOC, color: "red" }] },
      }).success,
    ).toBe(true);
  });
});

/**
 * `annotate` の結果に `id` と `index` が載る（増分6 D71）。
 *
 * どちらも**任意**である ―― 出せなかった項目（`none` / `many`）には無い。
 * `show_code` の結果には載らない（あちらは吹き出しを持たない）。
 */
describe("annotate の結果に id と index が載る（D71）", () => {
  const one = { resolvedBy: "text", match: "one", range: { startLine: 1, endLine: 1 } };

  it("id と index を受ける", () => {
    const parsed = annotateResultSchema.safeParse({
      resolutions: [{ ...one, id: 7, index: 1, normalizedPath: "src/a.ts" }],
    });
    expect(parsed.success, JSON.stringify(parsed)).toBe(true);
  });

  it("出せなかった項目は id も index も無いまま通る", () => {
    const parsed = annotateResultSchema.safeParse({
      resolutions: [{ resolvedBy: "none", match: "none", reason: "not-found" }],
    });
    expect(parsed.success).toBe(true);
  });

  it("clear の結果（空の配列）は通る", () => {
    expect(annotateResultSchema.safeParse({ resolutions: [] }).success).toBe(true);
  });

  it("id と index は 1 以上の整数", () => {
    for (const bad of [0, -1, 1.5, "1"]) {
      expect(annotateResultSchema.safeParse({ resolutions: [{ ...one, id: bad }] }).success).toBe(
        false,
      );
      expect(
        annotateResultSchema.safeParse({ resolutions: [{ ...one, index: bad }] }).success,
      ).toBe(false);
    }
  });

  it("index は同時に出せる吹き出しの数（MAX_ANNOTATION_THREADS）を超えない", () => {
    expect(MAX_ANNOTATION_THREADS).toBe(64);
    expect(
      annotateResultSchema.safeParse({
        resolutions: [{ ...one, index: MAX_ANNOTATION_THREADS }],
      }).success,
    ).toBe(true);
    expect(
      annotateResultSchema.safeParse({
        resolutions: [{ ...one, index: MAX_ANNOTATION_THREADS + 1 }],
      }).success,
    ).toBe(false);
  });

  it("strict のまま（知らない鍵は落ちる。extend で緩んでいない）", () => {
    expect(
      annotateResultSchema.safeParse({ resolutions: [{ ...one, body: "leak" }] }).success,
    ).toBe(false);
  });

  it("show_code の結果には id も index も載らない", () => {
    expect(showCodeResultSchema.safeParse({ resolutions: [{ ...one, id: 1 }] }).success).toBe(
      false,
    );
    expect(showCodeResultSchema.safeParse({ resolutions: [{ ...one, index: 1 }] }).success).toBe(
      false,
    );
  });
});

/**
 * `get_editor_state` に `annotations` が載る（増分6 D72 / §C6）。
 *
 * id・順番・パス・行・色・読了だけ。**本文は載らない**（線に乗せる理由が無い）。
 */
describe("get_editor_state の結果に annotations が載る（D72）", () => {
  const entry = { id: 3, index: 1, path: "src/a.ts", line: 12, color: "red", resolved: false };

  it("annotations を受ける（色は省略できる）", () => {
    const parsed = getEditorStateResultSchema.safeParse({
      openPaths: [],
      annotations: [entry, { id: 4, index: 2, path: "src/b.ts", line: 1, resolved: true }],
    });
    expect(parsed.success, JSON.stringify(parsed)).toBe(true);
  });

  it("annotations は省略できる（注釈が無い窓）", () => {
    expect(getEditorStateResultSchema.safeParse({ openPaths: [] }).success).toBe(true);
  });

  it("本文を載せる鍵は無い（strict）", () => {
    for (const leak of [{ body: "x" }, { text: "x" }, { author: "x" }]) {
      const parsed = getEditorStateResultSchema.safeParse({
        openPaths: [],
        annotations: [{ ...entry, ...leak }],
      });
      expect(parsed.success, JSON.stringify(leak)).toBe(false);
    }
  });

  it("必須の鍵が欠けると落ちる（resolved も必須 ―― 省略を false と読ませない）", () => {
    for (const key of ["id", "index", "path", "line", "resolved"] as const) {
      const { [key]: _dropped, ...rest } = entry;
      const parsed = getEditorStateResultSchema.safeParse({ openPaths: [], annotations: [rest] });
      expect(parsed.success, key).toBe(false);
    }
  });

  it("色は閉じた語彙（ANNOTATION_COLORS）", () => {
    for (const color of ANNOTATION_COLORS) {
      expect(
        getEditorStateResultSchema.safeParse({ openPaths: [], annotations: [{ ...entry, color }] })
          .success,
      ).toBe(true);
    }
    expect(
      getEditorStateResultSchema.safeParse({
        openPaths: [],
        annotations: [{ ...entry, color: "grey" }],
      }).success,
    ).toBe(false);
  });

  it("id / index / line は 1 以上の整数", () => {
    for (const key of ["id", "index", "line"] as const) {
      for (const bad of [0, -1, 1.5]) {
        const parsed = getEditorStateResultSchema.safeParse({
          openPaths: [],
          annotations: [{ ...entry, [key]: bad }],
        });
        expect(parsed.success, `${key}=${String(bad)}`).toBe(false);
      }
    }
  });

  it("件数は同時に出せる吹き出しの数（MAX_ANNOTATION_THREADS）まで", () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ ...entry, id: i + 1, index: i + 1 }));
    expect(
      getEditorStateResultSchema.safeParse({
        openPaths: [],
        annotations: many(MAX_ANNOTATION_THREADS),
      }).success,
    ).toBe(true);
    expect(
      getEditorStateResultSchema.safeParse({
        openPaths: [],
        annotations: many(MAX_ANNOTATION_THREADS + 1),
      }).success,
    ).toBe(false);
  });

  it("path はワークスペース相対パスの上限で切れる", () => {
    const withPath = (p: string) => ({ openPaths: [], annotations: [{ ...entry, path: p }] });
    expect(getEditorStateResultSchema.safeParse(withPath("a".repeat(1024))).success).toBe(true);
    expect(getEditorStateResultSchema.safeParse(withPath("a".repeat(1025))).success).toBe(false);
  });
});
