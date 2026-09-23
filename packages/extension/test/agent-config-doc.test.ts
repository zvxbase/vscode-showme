import { TOOL_ANNOTATIONS, TOOL_NAMES } from "@zvx/vscode-showme-protocol";
import { describe, expect, it } from "vitest";
import {
  agentConfigAllowList,
  allowListInDocument,
  bridgeLaunchArgs,
  buildAgentConfigDocument,
  shellQuote,
} from "../src/agent-config-doc.js";

const BRIDGE = "/home/me/.vscode-server/extensions/zvxbase.vscode-showme-0.0.0/bridge/index.js";

describe("agentConfigAllowList（B6 / §7.2）", () => {
  it("arrange_editors だけが無く、他は全部ある", () => {
    const allow = agentConfigAllowList();
    expect(allow).not.toContain("mcp__showme__arrange_editors");
    // 肯定対照: 語彙の残り全部が、線上の名前（mcp__showme__<tool>）で載る。
    const expected = TOOL_NAMES.filter((t) => t !== "arrange_editors").map(
      (t) => `mcp__showme__${t}`,
    );
    expect(allow).toEqual(expected);
    // 抜いたものが本当に語彙にあること（語彙から消えていたら、この検査は空振りする）。
    expect(TOOL_NAMES as readonly string[]).toContain("arrange_editors");
  });

  it("抜いているのは destructiveHint: true のツールと一致する（理由が生きている）", () => {
    // B6 の根拠は「唯一の destructiveHint: true」。別のツールが破壊的になったのに
    // 許可リストに残る／arrange_editors が破壊的でなくなったのに抜けたままなら、
    // ここが赤になって理由を読み直させる。
    const destructive = TOOL_NAMES.filter((t) => TOOL_ANNOTATIONS[t].destructiveHint === true);
    expect(destructive).toEqual(["arrange_editors"]);
  });
});

describe("shellQuote", () => {
  it("安全な文字だけのパスはそのまま", () => {
    expect(shellQuote(BRIDGE)).toBe(BRIDGE);
  });
  it("空白や引用符を含むパスは単一引用符で包む", () => {
    expect(shellQuote("/Users/me/Application Support/x.js")).toBe(
      "'/Users/me/Application Support/x.js'",
    );
    expect(shellQuote("/tmp/it's.js")).toBe("'/tmp/it'\\''s.js'");
  });
});

/**
 * 文書は言語ごとに丸ごと書き分けている（D58）ので、**両方の版**に同じ検査を当てる。
 * 片方だけ見ていると、日本語版から `arrange_editors` を抜き忘れても緑のままである。
 */
describe.each(["en", "ja"] as const)("buildAgentConfigDocument（D62 / §7.2）[%s]", (lang) => {
  const doc = buildAgentConfigDocument(BRIDGE, lang);

  it("3クライアント分の断片がある", () => {
    // 3つの断片は同じ引数の列（版番号入りのインストール先なので「いちばん新しい版を探す」1行）
    const args = bridgeLaunchArgs(BRIDGE);
    expect(args[0]).toBe("-e");
    expect(doc).toContain(`claude mcp add showme -- node ${args.map(shellQuote).join(" ")}`);
    expect(doc).toContain("[mcp_servers.showme]"); // Codex
    expect(doc).toContain('"mcpServers"'); // Copilot CLI
    expect(doc).toContain("--allow-tool 'showme'");
  });

  it("実際のブリッジのパスが入っている（プレースホルダではない）", () => {
    expect(doc).toContain(BRIDGE);
    expect(doc).not.toContain("<拡張のインストール先>");
    expect(doc).not.toContain("<");
  });

  it("許可リストの中身は agentConfigAllowList そのもの（値で主張する）", () => {
    // 文書の中の許可リストを**値として**取り出して比べる。名前の部分一致では
    // 「説明文に arrange_editors を書く」と「許可リストに入れる」を区別できない。
    expect(allowListInDocument(doc)).toEqual(agentConfigAllowList());
  });

  it("許可リストに arrange_editors は無く、他のツールは全部ある", () => {
    const allow = allowListInDocument(doc);
    expect(allow).toBeDefined();
    expect(allow).not.toContain("mcp__showme__arrange_editors");
    for (const t of TOOL_NAMES) {
      if (t === "arrange_editors") continue;
      expect(allow, t).toContain(`mcp__showme__${t}`);
    }
  });

  it("arrange_editors を自分で足す方法は書いてある（黙って抜かない）", () => {
    // 足すべき1行そのものが、許可リストの外の本文にある。
    const outside = doc.replace(/```json\n\[[\s\S]*?\n\]\n```/, "");
    expect(outside).not.toBe(doc); // 許可リストのブロックが実際に消せたこと
    expect(outside).toContain('"mcp__showme__arrange_editors"');
  });

  it("npx の断片は無い（S12）", () => {
    expect(doc).not.toMatch(/npx\s+-y/);
    expect(doc).not.toContain("npx");
    expect(doc).not.toContain("@zvx/vscode-showme-bridge");
  });

  it("削除側も同じ文書にある", () => {
    expect(doc).toContain("claude mcp remove showme");
  });

  it("JSON / TOML の断片は実際にパースできる", () => {
    const copilot = /```json\n(\{[\s\S]*?\})\n```/.exec(doc);
    expect(copilot).not.toBeNull();
    const parsed = JSON.parse(copilot?.[1] ?? "") as {
      mcpServers: { showme: { type: string; command: string; args: string[] } };
    };
    expect(parsed.mcpServers.showme).toEqual({
      type: "stdio",
      command: "node",
      args: bridgeLaunchArgs(BRIDGE),
    });

    const toml = /```toml\n([\s\S]*?)\n```/.exec(doc);
    expect(toml).not.toBeNull();
    expect(toml?.[1]).toBe(
      `[mcp_servers.showme]\ncommand = "node"\nargs = [${bridgeLaunchArgs(BRIDGE)
        .map((a) => JSON.stringify(a))
        .join(", ")}]`,
    );
  });

  it("引用符や空白を含むパスでも壊れない", () => {
    const odd = '/Users/me/Library/Application Support/"x"/bridge/index.js';
    const d = buildAgentConfigDocument(odd, lang);
    expect(d).toContain(`claude mcp add showme -- node ${shellQuote(odd)}`);
    const copilot = /```json\n(\{[\s\S]*?\})\n```/.exec(d);
    const parsed = JSON.parse(copilot?.[1] ?? "") as {
      mcpServers: { showme: { args: string[] } };
    };
    expect(parsed.mcpServers.showme.args).toEqual([odd]);
    expect(allowListInDocument(d)).toEqual(agentConfigAllowList());
  });

  it("allowListInDocument はブロックが無ければ undefined（検査が空振りしない）", () => {
    expect(allowListInDocument("なにもない")).toBeUndefined();
  });
});

describe("buildAgentConfigDocument の言語（D58）", () => {
  it("en と ja は別の文書で、どちらも自分の言語で書かれている", () => {
    const en = buildAgentConfigDocument(BRIDGE, "en");
    const ja = buildAgentConfigDocument(BRIDGE, "ja");
    expect(en).not.toBe(ja);
    expect(en).not.toMatch(/[぀-ヿ一-鿿]/);
    expect(ja).toContain("エージェント設定");
    // 事実は同じ: 許可リストは値として一致する。
    expect(allowListInDocument(en)).toEqual(allowListInDocument(ja));
  });
});
