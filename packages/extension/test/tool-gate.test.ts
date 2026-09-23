import {
  FEATURES,
  FEATURE_OF_TOOL,
  TOOL_NAMES,
  type WindowRole,
} from "@zvx/vscode-showme-protocol";
import { describe, expect, it } from "vitest";
import { checkToolGate } from "../src/tool-gate.js";

const ALL_ON = { stage: true, html: true, layout: true } as const;
/** 3機能のうち `off` だけを切った設定。 */
function featuresOff(off: "stage" | "html" | "layout") {
  return { ...ALL_ON, [off]: false };
}

describe("checkToolGate", () => {
  it("預けている窓で、有効で3機能とも on なら通す", () => {
    expect(checkToolGate({ enabled: true, features: ALL_ON }, "show_code", "stage")).toEqual({
      allowed: true,
    });
  });

  it("停止中なら拒否する", () => {
    const gate = checkToolGate({ enabled: false, features: ALL_ON }, "show_code", "stage");
    expect(gate.allowed).toBe(false);
    // 停止したことが分かる文言であること（ブリッジはこれをそのままエージェントに渡す）
    if (!gate.allowed) expect(gate.message).toContain("ShowMe is stopped");
  });

  it("停止中は、機能が全部 on のツールも拒否する", () => {
    // 停止スイッチが「機能の無効化」より上の段であることの確認。
    expect(
      checkToolGate({ enabled: false, features: ALL_ON }, "list_workspaces", "stage").allowed,
    ).toBe(false);
  });

  /**
   * **機能→ツールの表の全組み合わせ**（増分6 D75）。
   *
   * 3機能を1つずつ切り、`TOOL_NAMES` の全部を当てる。断られるのは
   * `FEATURE_OF_TOOL` でその機能に属するツール**だけ**で、核と他の機能の
   * ツールは通る。表を写さず（不変条件14）、表から期待値を作る。
   */
  describe("機能を切ると、その機能のツールだけが断られる（D75）", () => {
    for (const off of FEATURES) {
      it(`${off} を切る`, () => {
        const config = { enabled: true, features: featuresOff(off) };
        let refused = 0;
        for (const tool of TOOL_NAMES) {
          const gate = checkToolGate(config, tool, "stage");
          const want = FEATURE_OF_TOOL[tool] !== off;
          expect(gate.allowed, `${tool}（${off} off）`).toBe(want);
          if (!gate.allowed) {
            refused += 1;
            // 文言はツール名と、**直す場所（設定の鍵）**を言う。
            expect(gate.message).toContain(tool);
            expect(gate.message).toContain(`showme.${off}.enabled`);
          }
        }
        // 空振りの緑を防ぐ: 実際に断られたものがある。
        expect(refused).toBeGreaterThanOrEqual(1);
      });
    }

    it("核のツールは3機能を全部切っても通る（切れない）", () => {
      const config = { enabled: true, features: { stage: false, html: false, layout: false } };
      const core = TOOL_NAMES.filter((t) => FEATURE_OF_TOOL[t] === "core");
      expect(core.length).toBeGreaterThanOrEqual(6);
      for (const tool of core) {
        expect(checkToolGate(config, tool, "stage").allowed, tool).toBe(true);
      }
      // 対照: 核でないものは全部断られる。
      for (const tool of TOOL_NAMES.filter((t) => FEATURE_OF_TOOL[t] !== "core")) {
        expect(checkToolGate(config, tool, "stage").allowed, tool).toBe(false);
      }
    });

    it("show_code は stage を切っても関門は通す（印は出せる。開かないのは別の仕事）", () => {
      expect(
        checkToolGate({ enabled: true, features: featuresOff("stage") }, "show_code", "stage")
          .allowed,
      ).toBe(true);
    });

    it("拒否の文言の形", () => {
      const gate = checkToolGate(
        { enabled: true, features: featuresOff("html") },
        "show_html",
        "stage",
      );
      if (gate.allowed) throw new Error("拒否されるはず");
      expect(gate.message).toBe(
        "Tool show_html is disabled by settings (showme.html.enabled is false)",
      );
    });
  });

  describe("窓の役割（設計書 §2A.1）", () => {
    const on = { enabled: true, features: ALL_ON };
    const message = (role: WindowRole, tool: "show_code" | "list_workspaces") => {
      const gate = checkToolGate(on, tool, role);
      if (gate.allowed) throw new Error("拒否されるはず");
      return gate.message;
    };

    it("預けていない窓では show_code を拒否する（既定は操作不可）", () => {
      expect(checkToolGate(on, "show_code", "idle").allowed).toBe(false);
    });

    it("預けていない窓では list_workspaces も拒否する", () => {
      // 預けていない窓の存在やワークスペースパスをエージェントに教える理由が無い。
      // ここを通すと、既定で「窓が1つあり、パスはこれ」までは必ず漏れる。
      expect(checkToolGate(on, "list_workspaces", "idle").allowed).toBe(false);
    });

    it("拒否の文言が、人間が次にすべきことを言う", () => {
      for (const tool of ["show_code", "list_workspaces"] as const) {
        expect(message("idle", tool)).toBe(
          "ShowMe is off for this window. Click ShowMe in the VS Code status bar to turn it on (if it says Stopped, resume it first)",
        );
      }
    });

    it("知らない綴りの役割は預けていない扱いにする（フェイルクローズ）", () => {
      // 役割は登録ファイルや将来の版から来うる。=== "idle" で判定すると、
      // 知らない値が「預けている」側に落ちる。
      for (const unknown of ["STAGE", "stage ", "", "on"]) {
        expect(checkToolGate(on, "show_code", unknown as WindowRole).allowed).toBe(false);
      }
    });

    it("停止中は役割より優先する（表示の優先順位と揃える）", () => {
      const gate = checkToolGate({ enabled: false, features: ALL_ON }, "show_code", "idle");
      if (gate.allowed) throw new Error("拒否されるはず");
      expect(gate.message).toContain("ShowMe is stopped");
    });

    /**
     * 2B で増えたツールも、**既存のゲートに載っている**ことを見る。
     *
     * ツールを足した人が `handle` の switch にだけ足して、ゲートの検査を
     * 足し忘れても、`checkToolGate` は `ToolName` で受けているので通って
     * しまう ―― 通ることは正しいが、「通ることを誰も確かめていない」のは
     * 別の話である。1件ずつ名指しで見る。
     */
    it("預けていない窓では annotate も拒否する（人間の画面に描くツールである）", () => {
      expect(checkToolGate(on, "annotate", "idle").allowed).toBe(false);
      expect(checkToolGate(on, "annotate", "stage").allowed).toBe(true);
      expect(checkToolGate({ enabled: false, features: ALL_ON }, "annotate", "stage").allowed).toBe(
        false,
      );
      // 核なので、機能を全部切っても通る（人間は注釈だけは常に受け取れる）。
      expect(
        checkToolGate(
          { enabled: true, features: { stage: false, html: false, layout: false } },
          "annotate",
          "stage",
        ).allowed,
      ).toBe(true);
    });

    /**
     * **`get_editor_state` は人間の画面を*読む*ツールである。**
     *
     * ここが抜けていた。`handle` のゲートを `get_editor_state` だけ迂回させても
     * 613+50件が緑のままだった（実測）―― つまり「預けていない窓で人間の画面が
     * 読める」状態を誰も落とさない。配線は正しかったので、欠けていたのは検査
     * だけである。書くツール（`show_code` / `annotate`）と同じ4つの段を見る。
     */
    it("預けていない窓では get_editor_state も拒否する（人間の画面を読むツールである）", () => {
      expect(checkToolGate(on, "get_editor_state", "idle").allowed).toBe(false);
      expect(checkToolGate(on, "get_editor_state", "stage").allowed).toBe(true);
      expect(
        checkToolGate({ enabled: false, features: ALL_ON }, "get_editor_state", "stage").allowed,
      ).toBe(false);
      // 核なので、機能を全部切っても通る。
      expect(
        checkToolGate(
          { enabled: true, features: { stage: false, html: false, layout: false } },
          "get_editor_state",
          "stage",
        ).allowed,
      ).toBe(true);
    });

    it("預けていない窓では get_editor_state の文言も『次に何をするか』を言う", () => {
      const gate = checkToolGate(on, "get_editor_state", "idle");
      if (gate.allowed) throw new Error("拒否されるはず");
      expect(gate.message).toBe(
        "ShowMe is off for this window. Click ShowMe in the VS Code status bar to turn it on (if it says Stopped, resume it first)",
      );
    });

    /**
     * **1件ずつの名指しは、足した人が足し忘れると増えない。**
     *
     * 上の4件（`show_code` / `list_workspaces` / `annotate` / `get_editor_state`）は
     * 手で並べたものなので、次にツールが増えたときに黙って抜ける。母集団の
     * 列挙器（`TOOL_NAMES`）から回して、閉じていることを型ではなく値で言う。
     */
    it("既知のツールは1つ残らず、預けていない窓で拒否される", () => {
      expect(TOOL_NAMES.length).toBeGreaterThanOrEqual(4);
      for (const tool of TOOL_NAMES) {
        expect(checkToolGate(on, tool, "idle").allowed, `${tool} が idle の窓で通った`).toBe(false);
        expect(checkToolGate(on, tool, "stage").allowed, `${tool} が stage の窓で通らない`).toBe(
          true,
        );
      }
    });

    it("役割は機能の無効化より上の段（預けていなければ全部拒否）", () => {
      const config = { enabled: true, features: featuresOff("html") };
      const gate = checkToolGate(config, "show_html", "idle");
      if (gate.allowed) throw new Error("拒否されるはず");
      expect(gate.message).toContain("ShowMe is off for this window");
    });
  });
});
