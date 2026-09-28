import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TOOL_ANNOTATIONS, TOOL_NAMES } from "@zvx/vscode-showme-protocol";
import { describe, expect, it } from "vitest";
import {
  agentConfigAllowList,
  allowListInDocument,
  bridgeLaunchArgs,
  buildAgentConfigDocument,
  portableLaunchArgs,
  shellQuote,
} from "../src/agent-config-doc.js";

const BRIDGE = "/home/me/.vscode-server/extensions/zvxbase.vscode-showme-0.0.0/bridge/index.js";
const HOME = "/home/me";

/** 文書のコードブロックを、言語の札と中身の組で順に取り出す。 */
function codeBlocks(doc: string): { lang: string; body: string }[] {
  return [...doc.matchAll(/```(\w*)\n([\s\S]*?)\n```/g)].map((m) => ({
    lang: m[1] ?? "",
    body: m[2] ?? "",
  }));
}

interface ServersJson {
  mcpServers: { showme: { type?: string; command: string; args: string[]; tools?: string[] } };
}
const jsonBlocks = (doc: string): ServersJson[] =>
  codeBlocks(doc)
    .filter((b) => b.lang === "json" && b.body.startsWith("{"))
    .map((b) => JSON.parse(b.body) as ServersJson);

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
  const doc = buildAgentConfigDocument(BRIDGE, lang, undefined, "linux");

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

  it("npx の断片は無い（S12）。npx の語は、頼む文の「使わない」の1行にだけある", () => {
    expect(doc).not.toMatch(/npx\s+-y/);
    expect(doc).not.toContain("@zvx/vscode-showme-bridge");
    // 断片（頼む文以外のコードブロック）に npx は無い
    for (const b of codeBlocks(doc).filter((x) => x.lang !== "text")) {
      expect(b.body).not.toContain("npx");
    }
    // npx の語が出る行は、禁止の1行だけ（本文にも断片にも他に無い）
    const lines = doc.split("\n").filter((l) => l.includes("npx"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(lang === "en" ? /Do not use npx/ : /npx を使わない/);
  });

  it("この repo だけの設定: Claude Code の3つのスコープを同じ引数で出す", () => {
    const args = bridgeLaunchArgs(BRIDGE).map(shellQuote).join(" ");
    expect(doc).toContain(`claude mcp add --scope user showme -- node ${args}`);
    expect(doc).toContain(`claude mcp add --scope project showme -- node ${args}`);
    // 既定（local）がすでにこの repo だけ・自分だけであること
    expect(doc).toMatch(/--scope local/);
    expect(doc).toContain("~/.claude.json");
    expect(doc).toContain("claude mcp reset-project-choices");
  });

  it("この repo だけの設定: Codex は .codex/config.toml（trusted のときだけ読まれる）", () => {
    expect(doc).toContain(".codex/config.toml");
    expect(doc).toContain('trust_level = "trusted"');
    const tomls = codeBlocks(doc).filter((b) => b.lang === "toml");
    expect(tomls.length).toBe(2);
    expect(tomls[1]?.body).toBe(tomls[0]?.body); // 同じ断片
  });

  it('この repo だけの設定: Copilot CLI は tools: ["*"] 付きで、同じ引数', () => {
    expect(doc).toContain(".github/mcp.json");
    // Copilot CLI の断片（ユーザーの mcp-config.json と repo の分）は同じもので、どちらも tools 付き
    const copilot = jsonBlocks(doc);
    expect(copilot).toHaveLength(2);
    for (const j of copilot) {
      expect(j.mcpServers.showme).toEqual({
        type: "stdio",
        command: "node",
        args: bridgeLaunchArgs(BRIDGE),
        tools: ["*"],
      });
    }
    // 1つの .mcp.json を Claude Code と Copilot CLI の両方で使えることを書く
    expect(doc).toMatch(
      lang === "en" ? /both Claude Code and Copilot CLI/ : /Claude Code と Copilot CLI の両方/,
    );
  });

  it("注意書き: 機械ごとのパス・他人の repo の設定・VS Code の Copilot で2つ並ぶ", () => {
    expect(doc).toMatch(lang === "en" ? /this machine/ : /この機械/);
    expect(doc).toMatch(lang === "en" ? /someone else's repository/ : /他人の repo/);
    expect(doc).toMatch(lang === "en" ? /twice/ : /2つ並ぶ/);
  });

  it("ホーム配下なら、共有できる形（ホームを実行時に求める）を1つだけ出す", () => {
    const withHome = buildAgentConfigDocument(BRIDGE, lang, HOME, "linux");
    const portable = jsonBlocks(withHome).filter((j) =>
      j.mcpServers.showme.args.join().includes("homedir()"),
    );
    expect(portable).toHaveLength(1);
    expect(portable[0]?.mcpServers.showme).toEqual({
      type: "stdio",
      command: "node",
      args: portableLaunchArgs(BRIDGE, HOME),
      tools: ["*"],
    });
    // この機械のホームの綴りは入らない
    expect(portable[0]?.mcpServers.showme.args.join()).not.toContain(HOME);
    // Claude Code・Copilot CLI の .mcp.json と、Codex の .codex/config.toml で使えると書く
    expect(withHome).toMatch(lang === "en" ? /works for anyone/ : /誰の機械でも/);
    // ホーム配下でなければ出さない。ホームを渡さなくても出さない
    expect(buildAgentConfigDocument(BRIDGE, lang, "/root", "linux")).not.toContain("homedir()");
    expect(buildAgentConfigDocument(BRIDGE, lang, "/home/m", "linux")).not.toContain("homedir()");
    expect(doc).not.toContain("homedir()");
    expect(withHome).not.toContain("${HOME}");
  });

  it("節の見出しはスコープの3つを言い、Codex は trusted のときだけ読むとだけ書く", () => {
    expect(doc).toContain(
      lang === "en"
        ? "\n## Scopes: this repository, all repositories, or your team\n"
        : "\n## スコープ（この repo だけ／すべての repo／チームで共有）\n",
    );
    expect(doc).not.toMatch(/without a message|何も言わずに/);
  });

  it("エージェントに頼む文: 責任の明記と、狭く縛る約束を1つの文に持つ", () => {
    const prompts = codeBlocks(doc).filter((b) => b.lang === "text");
    expect(prompts).toHaveLength(1);
    const prompt = prompts[0]?.body ?? "";
    expect(doc).toMatch(lang === "en" ? /You are responsible/ : /責任は使う人/);
    expect(prompt).toMatch(lang === "en" ? /Do not use npx/ : /npx を使わない/);
    expect(prompt).toContain("mcp__showme__arrange_editors");
    expect(prompt).toMatch(lang === "en" ? /wildcard/ : /ワイルドカード/);
    expect(prompt).toMatch(lang === "en" ? /diff/ : /差分/);
    expect(prompt).toMatch(lang === "en" ? /which agent/ : /どのエージェント/);
    expect(prompt).toMatch(lang === "en" ? /on your own/ : /勝手に/);
    expect(prompt).toContain("/mcp");
    expect(prompt).toMatch(lang === "en" ? /Do not commit or push/ : /コミットも push もしない/);
    if (lang === "ja")
      expect(prompt.split("\n")[0]).toMatch(/^私が渡す ShowMe の設定の文書を使って/);
    expect(prompt).not.toContain("<");
    // 頼む文は許可リストとして読まれない（許可リストは値として変わらない）
    expect(allowListInDocument(doc)).toEqual(agentConfigAllowList());
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
      tools: ["*"],
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
    const d = buildAgentConfigDocument(odd, lang, undefined, "darwin");
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
    const en = buildAgentConfigDocument(BRIDGE, "en", undefined, "linux");
    const ja = buildAgentConfigDocument(BRIDGE, "ja", undefined, "linux");
    expect(en).not.toBe(ja);
    expect(en).not.toMatch(/[぀-ヿ一-鿿]/);
    expect(ja).toContain("エージェント設定");
    // 事実は同じ: 許可リストは値として一致する。
    expect(allowListInDocument(en)).toEqual(allowListInDocument(ja));
  });
});

/**
 * 共有できる形: `-e` の1行が、ホームを実行時に `os.homedir()` で求める。この機械のホームの綴りは
 * 1文字も入らない（入るのはホームより下の相対の部分だけ）ので、ホームに何が入っていても壊れない。
 */
describe("portableLaunchArgs", () => {
  const homes = [
    "/home/me",
    "/Users/Jane Doe",
    `/home/o'brien "q"`,
    "/home/日本語",
    "C:\\Users\\me x",
  ];
  it.each(homes)("ホーム %s: 1行は JS として読め、ホームの綴りを含まない", (home) => {
    const sep = home.includes("\\") ? "\\" : "/";
    const bridge = [
      home,
      ".vscode",
      "extensions",
      "zvxbase.vscode-showme-1.2.3",
      "bridge",
      "index.js",
    ].join(sep);
    const args = portableLaunchArgs(bridge, home, sep === "\\" ? "win32" : "linux");
    expect(args?.[0]).toBe("-e");
    const script = args?.[1] ?? "";
    expect(() => new Function(script)).not.toThrow();
    expect(script).not.toContain(home);
    expect(script).toContain('require("os").homedir(),".vscode","extensions"');
    // ホームの部分のほかは、いつもの1行と同じ
    const normal = bridgeLaunchArgs(bridge)[1] ?? "";
    expect(script.replace(/dir=[^;]*?\),pre=/, "dir=X,pre=")).toBe(
      normal.replace(/dir="[^"]*(?:\\.[^"]*)*",pre=/, "dir=X,pre="),
    );
  });

  it("実際に node で動かすと、HOME の下のいちばん新しい版を起動する", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "show me home "));
    const ext = path.join(home, ".vscode", "extensions");
    for (const v of ["0.9.0", "0.10.0"]) {
      const dir = path.join(ext, `zvxbase.vscode-showme-${v}`, "bridge");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "index.js"), `process.stdout.write("bridge ${v}");`);
    }
    // 別の人のホームで作った1行を、この一時ホームで動かす（ホームの綴りに依らない）
    const args = portableLaunchArgs(
      "/home/user/.vscode/extensions/zvxbase.vscode-showme-0.1.0/bridge/index.js",
      "/home/user",
      "linux",
    );
    const r = spawnSync(process.execPath, args ?? [], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: "utf8",
    });
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("bridge 0.10.0");
  });

  it("ホームの下でない・開発中の置き場（版番号が無い）なら出さない", () => {
    expect(portableLaunchArgs(BRIDGE, "/root", "linux")).toBeUndefined();
    expect(portableLaunchArgs(BRIDGE, "/home/m", "linux")).toBeUndefined();
    expect(portableLaunchArgs(BRIDGE, undefined, "linux")).toBeUndefined();
    expect(
      portableLaunchArgs("/home/me/src/showme/bridge/index.js", "/home/me", "linux"),
    ).toBeUndefined();
  });

  // Windows では Uri.fsPath がドライブ文字を小文字で（c:\）、os.homedir() が大文字で（C:\）返す
  it("Windows ではホームの接頭辞を大小を区別せずに比べる（両向き）", () => {
    const lower =
      "c:\\Users\\me\\.vscode\\extensions\\zvxbase.vscode-showme-1.2.3\\bridge\\index.js";
    const upper =
      "C:\\Users\\me\\.vscode\\extensions\\zvxbase.vscode-showme-1.2.3\\bridge\\index.js";
    for (const [bridge, home] of [
      [lower, "C:\\Users\\me"],
      [upper, "c:\\users\\ME"],
      [upper, "C:\\Users\\me"],
    ] as const) {
      const script = portableLaunchArgs(bridge, home, "win32")?.[1] ?? "";
      expect(script, `${bridge} / ${home}`).toContain(
        'require("os").homedir(),".vscode","extensions"',
      );
    }
    // 大小だけでなく名前が違えば、やはりホームの下ではない
    expect(portableLaunchArgs(lower, "C:\\Users\\mex", "win32")).toBeUndefined();
  });

  it("POSIX では大小を区別する（/home/Me と /home/me は別のフォルダ）", () => {
    expect(portableLaunchArgs(BRIDGE, "/home/ME", "linux")).toBeUndefined();
    expect(portableLaunchArgs(BRIDGE, "/HOME/me", "darwin")).toBeUndefined();
  });
});

/**
 * Windows の `claude mcp add` の行（D109）。POSIX の単一引用符と、埋め込みの `"` を持つ `-e` の1行は、
 * cmd と Windows PowerShell 5.1 で壊れる。Windows では版番号入りの実際のパスを `/` 区切りで
 * 二重引用符に入れて出す。JSON / TOML の断片は、今までどおりどの機械でも動く `-e` の1行。
 */
const WIN_BRIDGE =
  "C:\\Users\\Jane Doe\\.vscode\\extensions\\zvxbase.vscode-showme-0.1.5\\bridge\\index.js";
const WIN_HOME = "C:\\Users\\Jane Doe";

describe.each(["en", "ja"] as const)("buildAgentConfigDocument（Windows。D109）[%s]", (lang) => {
  const doc = buildAgentConfigDocument(WIN_BRIDGE, lang, WIN_HOME, "win32");
  const claudeLines = doc.split("\n").filter((l) => l.startsWith("claude mcp add"));

  it("claude mcp add の3行は、実際のパスを / 区切りで二重引用符に入れる（単一引用符も -e も無い）", () => {
    const quoted =
      '"C:/Users/Jane Doe/.vscode/extensions/zvxbase.vscode-showme-0.1.5/bridge/index.js"';
    expect(claudeLines).toEqual([
      `claude mcp add showme -- node ${quoted}`,
      `claude mcp add --scope user showme -- node ${quoted}`,
      `claude mcp add --scope project showme -- node ${quoted}`,
    ]);
    for (const l of claudeLines) {
      expect(l).not.toContain("'");
      expect(l).not.toContain("\\");
      expect(l).not.toContain(" -e ");
      // 二重引用符はパスを包む2つだけ（中に埋め込みの " が無い）
      expect(l.split('"')).toHaveLength(3);
    }
  });

  it("claude のコマンドの札は powershell で、sh の札は無い", () => {
    const blocks = codeBlocks(doc);
    for (const b of blocks.filter((x) => x.body.startsWith("claude "))) {
      expect(b.lang, b.body).toBe("powershell");
    }
    expect(blocks.some((b) => b.lang === "sh")).toBe(false);
  });

  it("PowerShell と コマンド プロンプトの両方で使えること、版ごとに打ち直すことを書く", () => {
    expect(doc).toMatch(
      lang === "en" ? /PowerShell and Command Prompt/ : /PowerShell とコマンド プロンプト/,
    );
    expect(doc).toMatch(
      lang === "en" ? /run it again after the extension updates/ : /拡張を更新したら打ち直す/,
    );
  });

  it("JSON / TOML の断片は、どの機械でも動く -e の1行のまま", () => {
    const args = bridgeLaunchArgs(WIN_BRIDGE);
    expect(args[0]).toBe("-e");
    const copilot = jsonBlocks(doc).filter(
      (j) => !j.mcpServers.showme.args.join().includes("homedir()"),
    );
    expect(copilot).toHaveLength(2);
    for (const j of copilot) expect(j.mcpServers.showme.args).toEqual(args);
    const tomls = codeBlocks(doc).filter((b) => b.lang === "toml");
    expect(tomls).toHaveLength(2);
    for (const t of tomls) {
      expect(t.body).toContain(`args = [${args.map((a) => JSON.stringify(a)).join(", ")}]`);
    }
    // ホームの下なので、共有の形も出る（大小の違うドライブ文字でも）
    expect(
      jsonBlocks(buildAgentConfigDocument(WIN_BRIDGE.replace(/^C/, "c"), lang, WIN_HOME, "win32"))
        .length,
    ).toBe(3);
  });

  it("頼む文と許可リストは POSIX の版と同じ（D100）", () => {
    const posix = buildAgentConfigDocument(BRIDGE, lang, undefined, "linux");
    const prompt = (d: string) => codeBlocks(d).filter((b) => b.lang === "text");
    expect(prompt(doc)).toHaveLength(1);
    expect(prompt(doc)).toEqual(prompt(posix));
    expect(allowListInDocument(doc)).toEqual(agentConfigAllowList());
    expect(doc).not.toContain("<");
    expect(doc).toContain(WIN_BRIDGE); // 「ブリッジ:」の行は実際のパスそのもの
  });

  it("POSIX の文書には Windows の説明が入らない", () => {
    const posix = buildAgentConfigDocument(BRIDGE, lang, undefined, "linux");
    expect(posix).not.toMatch(/PowerShell/);
    expect(codeBlocks(posix).some((b) => b.lang === "sh")).toBe(true);
  });
});
