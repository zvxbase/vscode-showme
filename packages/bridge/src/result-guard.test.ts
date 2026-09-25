import { RESULT_SCHEMAS, TOOL_NAMES } from "@zvx/vscode-showme-protocol";
import { describe, expect, it } from "vitest";
import {
  MAX_REJECTION_MESSAGE_CHARS,
  MAX_UNKNOWN_KEY_CHARS,
  ResultRejectedError,
  parseToolResult,
} from "./result-guard.js";

const listWorkspaces = {
  boundWorkspace: { name: "alpha", path: "/w/alpha" },
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

const showCode = {
  resolutions: [
    {
      resolvedBy: "text",
      match: "one",
      range: { startLine: 10, endLine: 12 },
      normalizedPath: "src/a.ts",
    },
  ],
};

describe("parseToolResult", () => {
  it("増分1 のすべてのツールに結果スキーマがある", () => {
    // 表に載っていないツールは検証を素通りする。増やしたとき気づけるようにする。
    for (const tool of TOOL_NAMES) {
      expect(Object.keys(RESULT_SCHEMAS)).toContain(tool);
    }
  });

  it("真っ当な list_workspaces の結果は通る", () => {
    expect(parseToolResult("list_workspaces", listWorkspaces)).toEqual(listWorkspaces);
  });

  it("権限の4欄が無い list_workspaces の結果は拒否する（古い拡張と新しいブリッジの組み合わせ）", () => {
    // D56 の3欄＋増分6 D74 の `features` は必須。古い拡張が返す形（欄無し）を
    // optional で黙って通すと、エージェントは「制約が無い」と読む。線で落として、
    // 拡張の更新に気づかせる。
    const {
      permissions: _p,
      features: _f,
      disabledTools: _d,
      editorGroup: _e,
      ...old
    } = listWorkspaces;
    expect(() => parseToolResult("list_workspaces", old)).toThrow(ResultRejectedError);
    // `features` だけ欠けても落ちる（増分5 の拡張と増分6 のブリッジの組み合わせ）。
    const { features: _only, ...noFeatures } = listWorkspaces;
    expect(() => parseToolResult("list_workspaces", noFeatures)).toThrow(ResultRejectedError);
    // `panels` だけ欠けても落ちる（増分6.1 の拡張と増分6.2 のブリッジの組み合わせ。D80）。
    const { panels: _panels, ...noPanels } = listWorkspaces;
    expect(() => parseToolResult("list_workspaces", noPanels)).toThrow(ResultRejectedError);
    // `avoidToolColumns` だけ欠けても落ちる（D90 より前の拡張と後のブリッジの組み合わせ）。
    const { avoidToolColumns: _avoid, ...noAvoid } = listWorkspaces;
    expect(() => parseToolResult("list_workspaces", noAvoid)).toThrow(ResultRejectedError);
    // 対照: 4欄が揃った同じ値は通る（上の検査と同じ入力）。
    expect(parseToolResult("list_workspaces", listWorkspaces)).toEqual(listWorkspaces);
  });

  it("真っ当な show_code の結果は通る", () => {
    expect(parseToolResult("show_code", showCode)).toEqual(showCode);
  });

  it("fileContents を含む結果は拒否する（不変条件2の実体）", () => {
    // 「どのツールもファイルの中身を返さない」を実行時に
    // 強制する場所は、エージェントへ手渡す側＝ブリッジ。
    const leaky = { ...showCode, fileContents: "x".repeat(100_000) };
    expect(() => parseToolResult("show_code", leaky)).toThrow(ResultRejectedError);
  });

  it("入れ子に紛れた未知の鍵も拒否する", () => {
    const leaky = {
      resolutions: [{ ...showCode.resolutions[0], fileContents: "secret" }],
    };
    expect(() => parseToolResult("show_code", leaky)).toThrow(ResultRejectedError);
  });

  it("list_workspaces に紛れた未知の鍵も拒否する", () => {
    const leaky = { ...listWorkspaces, fileContents: "secret" };
    expect(() => parseToolResult("list_workspaces", leaky)).toThrow(ResultRejectedError);
  });

  it("拒否した中身をエラーメッセージに載せない（検問所が漏洩経路にならない）", () => {
    const secret = "SUPER_SECRET_SOURCE_LINE";
    let message = "";
    try {
      parseToolResult("show_code", { ...showCode, fileContents: secret });
    } catch (e) {
      message = String(e);
    }
    expect(message).not.toContain(secret);
    // 何が落ちたかは分かること（鍵の名前は出す）
    expect(message).toContain("fileContents");
  });

  it("未知の鍵の名前を切り詰める（関所そのものを無制限のテキスト経路にしない）", () => {
    // 鍵の名前は攻撃者が決めうる。線上の error.message は 2000 字に制限して
    // あるのに、拒否の理由を作るこちら側だけが開いていた（実測: 88,041 字の
    // 文字列が ResultRejectedError.message を経由してエージェントに届いた）。
    const huge = "K".repeat(88_041);
    let message = "";
    try {
      parseToolResult("show_code", { ...showCode, [huge]: 1 });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toContain(huge);
    expect(message.length).toBeLessThanOrEqual(MAX_REJECTION_MESSAGE_CHARS);
    // 何が落ちたかは分かること（頭は出す）
    expect(message).toContain("K".repeat(MAX_UNKNOWN_KEY_CHARS - 1));
  });

  it("未知の鍵が大量にあってもメッセージは有界（鍵1本ずつ短くても数で溢れる）", () => {
    const leaky: Record<string, unknown> = { ...showCode };
    for (let i = 0; i < 5000; i++) leaky[`unknownKey${i}`] = 1;
    let message = "";
    try {
      parseToolResult("show_code", leaky);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message.length).toBeLessThanOrEqual(MAX_REJECTION_MESSAGE_CHARS);
  });

  it("鍵の名前を切ってもサロゲートペアを割らない", () => {
    const huge = "\u{1f600}".repeat(200);
    let message = "";
    try {
      parseToolResult("show_code", { ...showCode, [huge]: 1 });
    } catch (e) {
      message = (e as Error).message;
    }
    // 対のない下位/上位サロゲートが残っていないこと
    for (let i = 0; i < message.length; i++) {
      const code = message.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = message.charCodeAt(i + 1);
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
        i += 1;
      } else {
        expect(code >= 0xdc00 && code <= 0xdfff).toBe(false);
      }
    }
  });

  it("候補が3件を超える結果は拒否する（不変条件4の上限を線の手前で守る）", () => {
    const tooMany = {
      resolutions: [
        {
          resolvedBy: "text",
          match: "many",
          candidates: [{ line: 1 }, { line: 2 }, { line: 3 }, { line: 4 }],
        },
      ],
    };
    expect(() => parseToolResult("show_code", tooMany)).toThrow(ResultRejectedError);
  });

  it("値の型が違う結果は拒否する", () => {
    const wrong = {
      resolutions: [{ resolvedBy: "text", match: "one", range: { startLine: "10" } }],
    };
    expect(() => parseToolResult("show_code", wrong)).toThrow(ResultRejectedError);
  });

  it("知らない解決手段は拒否する", () => {
    const wrong = { resolutions: [{ resolvedBy: "grep", match: "one" }] };
    expect(() => parseToolResult("show_code", wrong)).toThrow(ResultRejectedError);
  });

  it("そもそもオブジェクトでない結果は拒否する", () => {
    expect(() => parseToolResult("show_code", "見せました")).toThrow(ResultRejectedError);
    expect(() => parseToolResult("show_code", null)).toThrow(ResultRejectedError);
  });

  it("ツールの取り違えを拾う（list_workspaces の結果を show_code として返させない）", () => {
    expect(() => parseToolResult("show_code", listWorkspaces)).toThrow(ResultRejectedError);
  });

  it("返すのは検証を通った値そのもの（生の入力を素通しにしない）", () => {
    const input = { ...listWorkspaces };
    const output = parseToolResult("list_workspaces", input);
    expect(output).not.toBe(input);
  });
});
