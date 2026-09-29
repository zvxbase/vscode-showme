import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TOOL_ANNOTATIONS, TOOL_NAMES } from "@zvx/vscode-showme-protocol";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";
import {
  RUN_AS_NODE_ENV,
  agentConfigAllowList,
  allowListInDocument,
  bridgeLaunchArgs,
  buildAgentConfigDocument,
  builtInServerDefinition,
  editorRuntimeLaunch,
  portableLaunchArgs,
  shellQuote,
  snippetRuntime,
} from "../src/agent-config-doc.js";

const BRIDGE = "/home/me/.vscode-server/extensions/zvxbase.vscode-showme-0.0.0/bridge/index.js";
const HOME = "/home/me";
/** デスクトップの VS Code の実行ファイル（拡張ホストの `process.execPath`。D112 / D114） */
const RUNTIME = "/usr/share/code/code";
const DESKTOP = { executable: RUNTIME, remote: false };
/** リモート（VS Code Server）では同梱の node。パスに版のハッシュが入り、更新ごとに変わる */
const REMOTE_RUNTIME = "/home/me/.vscode-server/cli/servers/Stable-abc123/server/node";
const REMOTE = { executable: REMOTE_RUNTIME, remote: true };
/** Claude Code の行で `--` の後ろに続く部分（POSIX。実行ファイル＋引数をシェル用に引用） */
const posixCommand = (runtime: string, bridge: string): string =>
  [runtime, ...bridgeLaunchArgs(bridge)].map(shellQuote).join(" ");

/** 文書のコードブロックを、言語の札と中身の組で順に取り出す。 */
function codeBlocks(doc: string): { lang: string; body: string }[] {
  return [...doc.matchAll(/```(\w*)\n([\s\S]*?)\n```/g)].map((m) => ({
    lang: m[1] ?? "",
    body: m[2] ?? "",
  }));
}

interface ServersJson {
  mcpServers: {
    showme: {
      type?: string;
      command: string;
      args: string[];
      env?: Record<string, string>;
      tools?: string[];
    };
  };
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
  const doc = buildAgentConfigDocument(BRIDGE, lang, undefined, "linux", DESKTOP);

  it("3クライアント分の断片がある", () => {
    // 3つの断片は同じ引数の列（版番号入りのインストール先なので「いちばん新しい版を探す」1行）
    const args = bridgeLaunchArgs(BRIDGE);
    expect(args[0]).toBe("-e");
    expect(doc).toContain(
      `claude mcp add -e ELECTRON_RUN_AS_NODE=1 --transport stdio showme -- ${posixCommand(RUNTIME, BRIDGE)}`,
    );
    // node の形も完全な1行で並ぶ（D114 改訂。手で書き換えさせない）
    expect(doc).toContain(
      `claude mcp add --transport stdio showme -- node ${args.map(shellQuote).join(" ")}`,
    );
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
    const cmd = posixCommand(RUNTIME, BRIDGE);
    expect(doc).toContain(
      `claude mcp add --scope user -e ELECTRON_RUN_AS_NODE=1 --transport stdio showme -- ${cmd}`,
    );
    expect(doc).toContain(
      `claude mcp add --scope project -e ELECTRON_RUN_AS_NODE=1 --transport stdio showme -- ${cmd}`,
    );
    // 既定（local）がすでにこの repo だけ・自分だけであること
    expect(doc).toMatch(/--scope local/);
    expect(doc).toContain("~/.claude.json");
    expect(doc).toContain("claude mcp reset-project-choices");
  });

  it("この repo だけの設定: Codex は .codex/config.toml（trusted のときだけ読まれる）", () => {
    expect(doc).toContain(".codex/config.toml");
    expect(doc).toContain('trust_level = "trusted"');
    // repo の節は上の断片（どちらかの形）を指す。形ごとの TOML は Codex の節に1つずつだけ
    const tomls = codeBlocks(doc).filter((b) => b.lang === "toml");
    expect(tomls.length).toBe(2);
    expect(doc).toMatch(lang === "en" ? /\(either form above\)/ : /（上のどちらかの形）/);
  });

  it('この repo だけの設定: Copilot CLI は tools: ["*"] 付きで、同じ引数', () => {
    expect(doc).toContain(".github/mcp.json");
    // Copilot CLI の断片は形ごとに1つ（repo の .mcp.json も同じ項目）で、どちらも tools 付き
    const copilot = jsonBlocks(doc);
    expect(copilot.map((j) => j.mcpServers.showme)).toEqual([
      {
        type: "stdio",
        command: RUNTIME,
        args: bridgeLaunchArgs(BRIDGE),
        env: { ELECTRON_RUN_AS_NODE: "1" },
        tools: ["*"],
      },
      { type: "stdio", command: "node", args: bridgeLaunchArgs(BRIDGE), tools: ["*"] },
    ]);
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

  it("ホーム配下なら、共有できる形（ホームを実行時に求める）を1つだけ出す。command は node（実行ファイルは人ごとに違う）", () => {
    const withHome = buildAgentConfigDocument(BRIDGE, lang, HOME, "linux", DESKTOP);
    const portable = jsonBlocks(withHome).filter((j) =>
      j.mcpServers.showme.args.join().includes("homedir()"),
    );
    expect(portable).toHaveLength(1);
    // エディタの実行ファイルの場所は OS・インストールの仕方で人ごとに違い、実行時に求める手が無い
    // （portableLaunchArgs が求めるのは args の中のホームだけ）。だから共有の形だけは node で起動し、
    // Node.js が要ると書く（D114。`${HOME}` の置き換えは実行ファイルには使わない）
    expect(portable[0]?.mcpServers.showme).toEqual({
      type: "stdio",
      command: "node",
      args: portableLaunchArgs(BRIDGE, HOME, "linux"),
      tools: ["*"],
    });
    expect(withHome).toMatch(lang === "en" ? /Node\.js 20 or later/ : /Node\.js 20 以上/);
    // この機械のホームの綴りは入らない
    expect(portable[0]?.mcpServers.showme.args.join()).not.toContain(HOME);
    // Claude Code・Copilot CLI の .mcp.json と、Codex の .codex/config.toml で使えると書く
    expect(withHome).toMatch(lang === "en" ? /works for anyone/ : /誰の機械でも/);
    // ホーム配下でなければ出さない。ホームを渡さなくても出さない
    expect(buildAgentConfigDocument(BRIDGE, lang, "/root", "linux", DESKTOP)).not.toContain(
      "homedir()",
    );
    expect(buildAgentConfigDocument(BRIDGE, lang, "/home/m", "linux", DESKTOP)).not.toContain(
      "homedir()",
    );
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
    const parsed = JSON.parse(copilot?.[1] ?? "") as ServersJson;
    expect(parsed.mcpServers.showme).toEqual({
      type: "stdio",
      command: RUNTIME,
      args: bridgeLaunchArgs(BRIDGE),
      env: { ELECTRON_RUN_AS_NODE: "1" },
      tools: ["*"],
    });

    // TOML は本物のパーサで読む（文字列の比較では「読める」ことを言えない）。形ごとに1つ
    const tomls = codeBlocks(doc).filter((b) => b.lang === "toml");
    expect(tomls.map((t) => parseToml(t.body))).toEqual([
      {
        mcp_servers: {
          showme: {
            command: RUNTIME,
            args: bridgeLaunchArgs(BRIDGE),
            env: { ELECTRON_RUN_AS_NODE: "1" },
          },
        },
      },
      { mcp_servers: { showme: { command: "node", args: bridgeLaunchArgs(BRIDGE) } } },
    ]);
  });

  it("引用符や空白を含むパスでも壊れない", () => {
    const odd = '/Users/me/Library/Application Support/"x"/bridge/index.js';
    const mac =
      "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)";
    const d = buildAgentConfigDocument(odd, lang, undefined, "darwin", {
      executable: mac,
      remote: false,
    });
    expect(d).toContain(
      `claude mcp add -e ELECTRON_RUN_AS_NODE=1 --transport stdio showme -- ${shellQuote(mac)} ${shellQuote(odd)}`,
    );
    const copilot = /```json\n(\{[\s\S]*?\})\n```/.exec(d);
    const parsed = JSON.parse(copilot?.[1] ?? "") as {
      mcpServers: { showme: { args: string[] } };
    };
    expect(parsed.mcpServers.showme.args).toEqual([odd]);
    expect(parsed.mcpServers.showme.command).toBe(mac);
    expect(allowListInDocument(d)).toEqual(agentConfigAllowList());
  });

  it("allowListInDocument はブロックが無ければ undefined（検査が空振りしない）", () => {
    expect(allowListInDocument("なにもない")).toBeUndefined();
  });
});

describe("buildAgentConfigDocument の言語（D58）", () => {
  it("en と ja は別の文書で、どちらも自分の言語で書かれている", () => {
    const en = buildAgentConfigDocument(BRIDGE, "en", undefined, "linux", DESKTOP);
    const ja = buildAgentConfigDocument(BRIDGE, "ja", undefined, "linux", DESKTOP);
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
/** Windows のユーザー インストール（ホームの下。`%LOCALAPPDATA%\\Programs\\Microsoft VS Code`） */
const WIN_RUNTIME = "C:\\Users\\Jane Doe\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe";
const WIN_DESKTOP = { executable: WIN_RUNTIME, remote: false };

describe.each(["en", "ja"] as const)("buildAgentConfigDocument（Windows。D109）[%s]", (lang) => {
  const doc = buildAgentConfigDocument(WIN_BRIDGE, lang, WIN_HOME, "win32", WIN_DESKTOP);
  const claudeLines = doc.split("\n").filter((l) => l.startsWith("claude mcp add"));

  it("claude mcp add の6行（2つの形 × 3つのスコープ）は、パスを / 区切りで二重引用符に入れる（単一引用符も -e の1行も無い）", () => {
    const runtime = '"C:/Users/Jane Doe/AppData/Local/Programs/Microsoft VS Code/Code.exe"';
    const quoted =
      '"C:/Users/Jane Doe/.vscode/extensions/zvxbase.vscode-showme-0.1.5/bridge/index.js"';
    const tail = `-e ELECTRON_RUN_AS_NODE=1 --transport stdio showme -- ${runtime} ${quoted}`;
    const nodeTail = `--transport stdio showme -- node ${quoted}`;
    expect(claudeLines).toEqual([
      `claude mcp add ${tail}`,
      `claude mcp add ${nodeTail}`,
      `claude mcp add --scope user ${tail}`,
      `claude mcp add --scope user ${nodeTail}`,
      `claude mcp add --scope project ${tail}`,
      `claude mcp add --scope project ${nodeTail}`,
    ]);
    for (const l of claudeLines) {
      expect(l).not.toContain("'");
      expect(l).not.toContain("\\");
      const nodeForm = l.includes("-- node ");
      // `-e` は実行環境の形の環境変数の1つだけ（node の `-e` の1行は出さない。D109）
      expect(l.match(/ -e /g) ?? []).toHaveLength(nodeForm ? 0 : 1);
      // 二重引用符はパスを包むものだけ（中に埋め込みの " が無い）
      expect(l.split('"')).toHaveLength(nodeForm ? 3 : 5);
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
    // 実行環境の形と node の形。シェルを通らないので、実行ファイルは綴りのまま（JSON の中で `\\` はエスケープ）
    expect(copilot.map((j) => j.mcpServers.showme)).toEqual([
      {
        type: "stdio",
        command: WIN_RUNTIME,
        args,
        env: { ELECTRON_RUN_AS_NODE: "1" },
        tools: ["*"],
      },
      { type: "stdio", command: "node", args, tools: ["*"] },
    ]);
    const tomls = codeBlocks(doc).filter((b) => b.lang === "toml");
    expect(tomls).toHaveLength(2);
    for (const t of tomls) {
      expect(t.body).toContain(`args = [${args.map((a) => JSON.stringify(a)).join(", ")}]`);
    }
    // バックスラッシュの入った実行ファイルのパスも、TOML として読むと元の綴りに戻る
    expect(tomls.map((t) => parseToml(t.body))).toEqual([
      {
        mcp_servers: {
          showme: { command: WIN_RUNTIME, args, env: { ELECTRON_RUN_AS_NODE: "1" } },
        },
      },
      { mcp_servers: { showme: { command: "node", args } } },
    ]);
    // ホームの下なので、共有の形も出る（大小の違うドライブ文字でも）
    expect(
      jsonBlocks(
        buildAgentConfigDocument(
          WIN_BRIDGE.replace(/^C/, "c"),
          lang,
          WIN_HOME,
          "win32",
          WIN_DESKTOP,
        ),
      ).length,
    ).toBe(3); // 実行環境・node・共有の項目
  });

  it("頼む文と許可リストは POSIX の版と同じ（D100）", () => {
    const posix = buildAgentConfigDocument(BRIDGE, lang, undefined, "linux", DESKTOP);
    const prompt = (d: string) => codeBlocks(d).filter((b) => b.lang === "text");
    expect(prompt(doc)).toHaveLength(1);
    expect(prompt(doc)).toEqual(prompt(posix));
    expect(allowListInDocument(doc)).toEqual(agentConfigAllowList());
    expect(doc).not.toContain("<");
    expect(doc).toContain(WIN_BRIDGE); // 「ブリッジ:」の行は実際のパスそのもの
  });

  it("POSIX の文書には Windows の説明が入らない", () => {
    const posix = buildAgentConfigDocument(BRIDGE, lang, undefined, "linux", DESKTOP);
    expect(posix).not.toMatch(/PowerShell/);
    expect(codeBlocks(posix).some((b) => b.lang === "sh")).toBe(true);
  });
});

/**
 * 起動の形（D112 / D114）。VS Code 内蔵のエージェント向けの定義と、外のエージェントの断片は、
 * **同じ関数**が返す command / args / env を使う（不変条件14）。どちらも `node` を前提にしない。
 */
describe("editorRuntimeLaunch / builtInServerDefinition（D112）", () => {
  it("起動の形は、渡した実行ファイル・引数と ELECTRON_RUN_AS_NODE=1", () => {
    expect(editorRuntimeLaunch(RUNTIME, ["/x/bridge/index.js"])).toEqual({
      command: RUNTIME,
      args: ["/x/bridge/index.js"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
    expect(RUN_AS_NODE_ENV).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
  });

  it("返す env と args は呼ぶたびに別の物（片方を書き換えても他方がずれない）", () => {
    const args = ["/x/bridge/index.js"];
    const a = editorRuntimeLaunch(RUNTIME, args);
    a.env.EXTRA = "1";
    a.args.push("more");
    expect(editorRuntimeLaunch(RUNTIME, args)).toEqual({
      command: RUNTIME,
      args: ["/x/bridge/index.js"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
    expect(RUN_AS_NODE_ENV).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
  });

  it("内蔵の定義: 題は ShowMe、実行中の版のブリッジを直接起動し、拡張の版を付ける", () => {
    const def = builtInServerDefinition(RUNTIME, BRIDGE, "0.1.6");
    expect(def).toEqual({
      label: "ShowMe",
      command: RUNTIME,
      // 内蔵の定義は、今動いている版のパスをその都度渡すので「いちばん新しい版を探す」1行を使わない
      args: [BRIDGE],
      env: { ELECTRON_RUN_AS_NODE: "1" },
      version: "0.1.6",
    });
    expect(def.command).not.toBe("node");
  });

  it("断片の起動の形は、同じ関数に bridgeLaunchArgs を渡したもの", () => {
    const doc = buildAgentConfigDocument(BRIDGE, "en", undefined, "linux", DESKTOP);
    const launch = editorRuntimeLaunch(RUNTIME, bridgeLaunchArgs(BRIDGE));
    const j = jsonBlocks(doc)[0]?.mcpServers.showme;
    expect({ command: j?.command, args: j?.args, env: j?.env }).toEqual(launch);
  });
});

describe.each(["en", "ja"] as const)("実行環境の注記（D114）[%s]", (lang) => {
  it("デスクトップ: 実行ファイルのパスを出し、VS Code が動いたら文書を開き直すと書く", () => {
    const doc = buildAgentConfigDocument(BRIDGE, lang, undefined, "linux", DESKTOP);
    expect(doc).toContain(`${lang === "en" ? "Runtime" : "実行環境"}: ${RUNTIME}`);
    expect(doc).toMatch(lang === "en" ? /needs no Node\.js/ : /Node\.js が要らない/);
    expect(doc).toContain(
      lang === "en" ? "**ShowMe: Show agent configuration**" : "**ShowMe: エージェント設定を表示**",
    );
    expect(doc).toMatch(lang === "en" ? /If VS Code moves/ : /VS Code の場所が変わったら/);
    // デスクトップでは更新ごとに変わる、とは書かない
    expect(doc).not.toMatch(lang === "en" ? /after VS Code updates/ : /VS Code を更新したら/);
  });

  it("リモート: 更新のたびに設定し直すと書き、更新に強い node の形を先に出す", () => {
    const doc = buildAgentConfigDocument(BRIDGE, lang, undefined, "linux", REMOTE);
    expect(doc).toMatch(lang === "en" ? /after VS Code updates/ : /VS Code を更新したら/);
    expect(doc).toContain(
      `claude mcp add -e ELECTRON_RUN_AS_NODE=1 --transport stdio showme -- ${posixCommand(REMOTE_RUNTIME, BRIDGE)}`,
    );
    // 代わりの形（Node.js があれば更新に強い）。引数は同じ関数から
    expect(doc).toContain(
      `claude mcp add --transport stdio showme -- node ${bridgeLaunchArgs(BRIDGE).map(shellQuote).join(" ")}`,
    );
    expect(doc).toMatch(lang === "en" ? /Node\.js 20 or later/ : /Node\.js 20 以上/);
    expect(doc).not.toMatch(lang === "en" ? /If VS Code moves/ : /VS Code の場所が変わったら/);
    // 更新に強い node の形が、Claude Code の節で実行環境の形より先に来る
    const nodeAt = doc.indexOf("claude mcp add --transport stdio showme -- node ");
    expect(nodeAt).toBeGreaterThan(doc.indexOf("\n## Claude Code\n"));
    expect(nodeAt).toBeLessThan(doc.indexOf("claude mcp add -e ELECTRON_RUN_AS_NODE=1 "));
    // D100: 頼む文は変わらない
    const prompt = (d: string) => codeBlocks(d).filter((b) => b.lang === "text");
    expect(prompt(doc)).toEqual(
      prompt(buildAgentConfigDocument(BRIDGE, lang, undefined, "linux", DESKTOP)),
    );
    expect(doc).not.toContain("<");
  });

  it("${HOME} の形はどの版にも出ない（実行ファイルの置き換えはしない。D99 / D114）", () => {
    for (const rt of [DESKTOP, REMOTE, { executable: "/home/me/apps/code/code", remote: false }]) {
      const doc = buildAgentConfigDocument(BRIDGE, lang, HOME, "linux", rt);
      expect(doc).not.toContain("${HOME}");
      expect(doc).not.toContain("$HOME");
    }
  });
});

/**
 * 断片に書く実行ファイルの分類（D114 の見直し）。「デスクトップの実行ファイルは更新で動かない」は
 * 入れ方によっては偽である: Snap は版ごとのフォルダ（古い版は消える）、Flatpak は砂箱の中（外の
 * エージェントからは起動できない）、AppImage と macOS の App Translocation は起動のたびに場所が変わる。
 * 分類は `snippetRuntime` 1つが決める（不変条件14）。
 */
describe("snippetRuntime（実行ファイルの場所の分類）", () => {
  const none = {};
  it.each([
    ["Linux の deb/rpm", "/usr/share/code/code", none, "/usr/share/code/code"],
    [
      "Windows のユーザー インストール",
      "C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe",
      none,
      "C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe",
    ],
    [
      "macOS の /Applications",
      "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)",
      none,
      "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)",
    ],
    [
      "Snap（版の番号を current に直す）",
      "/snap/code/187/usr/share/code/code",
      { SNAP: "/snap/code/187" },
      "/snap/code/current/usr/share/code/code",
    ],
    [
      "Snap（手元で入れた x の版）",
      "/snap/code-insiders/x2/usr/share/code-insiders/code-insiders",
      none,
      "/snap/code-insiders/current/usr/share/code-insiders/code-insiders",
    ],
  ] as const)("%s は安定した場所", (_label, executable, env, expected) => {
    expect(snippetRuntime({ executable, remote: false, env })).toEqual({
      executable: expected,
      volatile: undefined,
      forms: ["runtime", "node"],
    });
  });

  it("根の /snap/ でなければ直さない（ホームの下の snap という名前のフォルダなど）", () => {
    const p = "/home/user/snap/code/187/usr/share/code/code";
    expect(snippetRuntime({ executable: p, remote: false, env: {} })).toEqual({
      executable: p,
      volatile: undefined,
      forms: ["runtime", "node"],
    });
  });

  it("Snap の current はすでに安定（そのまま）", () => {
    const p = "/snap/code/current/usr/share/code/code";
    expect(snippetRuntime({ executable: p, remote: false, env: {} }).executable).toBe(p);
  });

  it.each([
    [
      "FLATPAK_ID があれば Flatpak",
      "/app/extra/vscode/code",
      { FLATPAK_ID: "com.visualstudio.code" },
    ],
    ["/app/ の下なら環境変数が無くても Flatpak", "/app/extra/vscode/code", {}],
  ] as const)("%s: 外からは起動できないので実行ファイルを出さない", (_l, executable, env) => {
    expect(snippetRuntime({ executable, remote: false, env })).toEqual({
      executable: undefined,
      volatile: "flatpak",
      forms: ["node"],
    });
  });

  it.each([
    [
      "APPIMAGE があれば AppImage",
      "/tmp/.mount_CodeAbC123/code",
      { APPIMAGE: "/home/me/Code.AppImage" },
      "appimage",
    ],
    ["/tmp/.mount_ の下なら AppImage", "/tmp/.mount_CodeAbC123/code", {}, "appimage"],
    ["Nix のストア", "/nix/store/abc123xyz-vscode-1.139.1/lib/vscode/code", {}, "nix-store"],
    [
      "App Translocation",
      "/private/var/folders/ab/xyz/T/AppTranslocation/0A1B2C3D-4E5F/d/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)",
      {},
      "app-translocation",
    ],
  ] as const)(
    "%s: 長持ちしない（起動のたび・更新のたびに変わる）",
    (_l, executable, env, reason) => {
      expect(snippetRuntime({ executable, remote: false, env })).toEqual({
        executable,
        volatile: reason,
        forms: ["node", "runtime"],
      });
    },
  );

  it("リモートは更新のたびに変わる（ほかの判定より先）", () => {
    expect(snippetRuntime({ executable: REMOTE_RUNTIME, remote: true, env: {} })).toEqual({
      executable: REMOTE_RUNTIME,
      volatile: "remote",
      forms: ["node", "runtime"],
    });
  });
});

describe.each(["en", "ja"] as const)("実行ファイルの場所ごとの文書（D114）[%s]", (lang) => {
  const nodeLine = `claude mcp add --transport stdio showme -- node ${bridgeLaunchArgs(BRIDGE)
    .map(shellQuote)
    .join(" ")}`;
  const firstSection = (d: string) => d.indexOf("\n## Claude Code\n");

  it("Snap: 断片は /snap/<名前>/current/ を指し、版の番号のフォルダを指さない", () => {
    const doc = buildAgentConfigDocument(BRIDGE, lang, undefined, "linux", {
      executable: "/snap/code/187/usr/share/code/code",
      remote: false,
      env: { SNAP: "/snap/code/187" },
    });
    const current = "/snap/code/current/usr/share/code/code";
    expect(doc).toContain(
      `claude mcp add -e ELECTRON_RUN_AS_NODE=1 --transport stdio showme -- ${posixCommand(current, BRIDGE)}`,
    );
    for (const j of jsonBlocks(doc).filter((x) => x.mcpServers.showme.env !== undefined)) {
      expect(j.mcpServers.showme.command).toBe(current);
    }
    expect(doc).not.toContain("/snap/code/187/");
  });

  it("Flatpak: 断片は node で起動し（env 無し）、砂箱の中の実行ファイルを出さない", () => {
    const sandboxed = "/app/extra/vscode/code";
    const doc = buildAgentConfigDocument(BRIDGE, lang, undefined, "linux", {
      executable: sandboxed,
      remote: false,
      env: { FLATPAK_ID: "com.visualstudio.code" },
    });
    expect(doc).not.toContain(sandboxed);
    expect(doc).not.toContain("ELECTRON_RUN_AS_NODE");
    expect(doc).toContain(nodeLine);
    for (const j of jsonBlocks(doc)) {
      expect(j.mcpServers.showme.command).toBe("node");
      expect(j.mcpServers.showme.env).toBeUndefined();
    }
    for (const t of codeBlocks(doc).filter((b) => b.lang === "toml")) {
      expect(parseToml(t.body)).toEqual({
        mcp_servers: { showme: { command: "node", args: bridgeLaunchArgs(BRIDGE) } },
      });
    }
    expect(doc).toContain("Flatpak");
    expect(doc).toMatch(lang === "en" ? /Node\.js 20 or later/ : /Node\.js 20 以上/);
    expect(allowListInDocument(doc)).toEqual(agentConfigAllowList());
  });

  it.each([
    ["AppImage", "/tmp/.mount_CodeAbC123/code", { APPIMAGE: "/home/me/Code.AppImage" }, "AppImage"],
    [
      "App Translocation",
      "/private/var/folders/ab/T/AppTranslocation/0A1B/d/Visual Studio Code.app/Contents/MacOS/Electron",
      {},
      lang === "en" ? "Applications" : "アプリケーション",
    ],
  ] as const)(
    "%s: node の形が先に来て、理由を書き、実行ファイルの形も残す",
    (_l, executable, env, word) => {
      const doc = buildAgentConfigDocument(BRIDGE, lang, undefined, "darwin", {
        executable,
        remote: false,
        env,
      });
      expect(doc).toContain(word);
      const at = doc.indexOf(nodeLine);
      expect(at).toBeGreaterThan(firstSection(doc));
      expect(at).toBeLessThan(doc.indexOf("claude mcp add -e ELECTRON_RUN_AS_NODE=1 "));
      expect(doc).toContain(
        `-e ELECTRON_RUN_AS_NODE=1 --transport stdio showme -- ${posixCommand(executable, BRIDGE)}`,
      );
      expect(doc).toMatch(lang === "en" ? /VS Code restarts/ : /VS Code を起動し直す/);
      expect(doc).not.toMatch(lang === "en" ? /If VS Code moves/ : /VS Code の場所が変わったら/);
    },
  );

  it("Nix: node の形が先に来て、ストアのパスは更新で変わり GC で消えると書き、実行ファイルの形も残す", () => {
    const executable = "/nix/store/abc123xyz-vscode-1.139.1/lib/vscode/code";
    const doc = buildAgentConfigDocument(BRIDGE, lang, undefined, "linux", {
      executable,
      remote: false,
      env: {},
    });
    const at = doc.indexOf(nodeLine);
    expect(at).toBeGreaterThan(firstSection(doc));
    expect(at).toBeLessThan(doc.indexOf("claude mcp add -e ELECTRON_RUN_AS_NODE=1 "));
    expect(doc).toContain("/nix/store/");
    expect(doc).toMatch(lang === "en" ? /garbage collection/ : /ガベージコレクション/);
    expect(doc).toContain(
      `-e ELECTRON_RUN_AS_NODE=1 --transport stdio showme -- ${posixCommand(executable, BRIDGE)}`,
    );
    expect(doc).not.toMatch(lang === "en" ? /If VS Code moves/ : /VS Code の場所が変わったら/);
  });

  it("Windows のデスクトップ: 更新の後に繋ぎ直すこと（/mcp）と、node の形なら避けられることを書く", () => {
    const doc = buildAgentConfigDocument(WIN_BRIDGE, lang, WIN_HOME, "win32", WIN_DESKTOP);
    expect(doc).toContain("/mcp");
    expect(doc).toMatch(
      lang === "en" ? /after VS Code updates on Windows/i : /Windows で VS Code を更新したら/,
    );
    expect(doc).toMatch(lang === "en" ? /`node`/ : /`node`/);
    const posix = buildAgentConfigDocument(BRIDGE, lang, undefined, "linux", DESKTOP);
    expect(posix).not.toMatch(
      lang === "en" ? /after VS Code updates on Windows/i : /Windows で VS Code を更新したら/,
    );
  });
});

/**
 * 2つの形（D114 の改訂。オーナーの判断 2026-09-29「node での使い方で迷わないように」）。
 *
 * 3つのエージェント（Claude Code / Codex CLI / Copilot CLI）の節は、それぞれ**完全な断片を2つ**持つ:
 * エディタの実行環境の形（Node.js は要らない）と `node` の形（Node.js 20 以上が `PATH` に要る）。
 * 手で書き換えさせる文は置かない。どちらを先に出すか・どちらを出すかは `snippetRuntime` の
 * `forms` 1つが決める（不変条件14）: 安定なら実行環境が先、長持ちしない場所なら `node` が先、
 * Flatpak は `node` だけ。
 */
type Form = "runtime" | "node";
const NIX = "/nix/store/abc123xyz-vscode-1.139.1/lib/vscode/code";
const APPIMAGE = "/tmp/.mount_CodeAbC123/code";
const TRANSLOCATED =
  "/private/var/folders/ab/T/AppTranslocation/0A1B/d/Visual Studio Code.app/Contents/MacOS/Electron";
const RUNTIME_CLASSES = [
  { name: "stable", rt: DESKTOP, exe: RUNTIME, forms: ["runtime", "node"] },
  { name: "remote", rt: REMOTE, exe: REMOTE_RUNTIME, forms: ["node", "runtime"] },
  {
    name: "appimage",
    rt: { executable: APPIMAGE, remote: false, env: { APPIMAGE: "/home/me/Code.AppImage" } },
    exe: APPIMAGE,
    forms: ["node", "runtime"],
  },
  {
    name: "app-translocation",
    rt: { executable: TRANSLOCATED, remote: false },
    exe: TRANSLOCATED,
    forms: ["node", "runtime"],
  },
  {
    name: "nix-store",
    rt: { executable: NIX, remote: false },
    exe: NIX,
    forms: ["node", "runtime"],
  },
  {
    name: "flatpak",
    rt: {
      executable: "/app/extra/vscode/code",
      remote: false,
      env: { FLATPAK_ID: "com.visualstudio.code" },
    },
    exe: undefined,
    forms: ["node"],
  },
] as const;

/** H2 の節（`## <見出し>` から次の H2 まで）。見出しの前方一致で探す */
function h2Section(doc: string, heading: string): string {
  const start = doc.indexOf(`\n## ${heading}`);
  expect(start, heading).toBeGreaterThan(-1);
  const next = doc.indexOf("\n## ", start + 4);
  return doc.slice(start, next === -1 ? undefined : next);
}
/** H3 の節（`### <見出し>` から次の H2 / H3 まで）。`from` より後ろで探す */
function h3Section(doc: string, heading: string, from: number): string {
  const start = doc.indexOf(`\n### ${heading}\n`, from);
  expect(start, heading).toBeGreaterThan(-1);
  const rest = doc.slice(start + 5);
  const next = rest.search(/\n##+ /);
  return doc.slice(start, next === -1 ? undefined : start + 5 + next);
}

describe("snippetRuntime の forms（出す形と順を決める唯一の場所）", () => {
  it.each(RUNTIME_CLASSES)("$name: $forms", ({ rt, forms }) => {
    expect(snippetRuntime(rt).forms).toEqual(forms);
  });
  it("Snap（current に直す）と Windows のデスクトップは安定: 実行環境が先", () => {
    expect(
      snippetRuntime({ executable: "/snap/code/187/usr/share/code/code", remote: false }).forms,
    ).toEqual(["runtime", "node"]);
    expect(snippetRuntime(WIN_DESKTOP).forms).toEqual(["runtime", "node"]);
  });
});

describe.each(["en", "ja"] as const)("エージェントごとの2つの形（D114 改訂）[%s]", (lang) => {
  const args = bridgeLaunchArgs(BRIDGE);
  const expectedFor = (form: Form, exe: string | undefined) =>
    form === "node"
      ? {
          claude: `--transport stdio showme -- node ${args.map(shellQuote).join(" ")}`,
          json: { type: "stdio", command: "node", args, tools: ["*"] },
          toml: { command: "node", args },
        }
      : {
          claude: `-e ELECTRON_RUN_AS_NODE=1 --transport stdio showme -- ${posixCommand(exe ?? "", BRIDGE)}`,
          json: {
            type: "stdio",
            command: exe,
            args,
            env: { ELECTRON_RUN_AS_NODE: "1" },
            tools: ["*"],
          },
          toml: { command: exe, args, env: { ELECTRON_RUN_AS_NODE: "1" } },
        };
  const nodeLabel = lang === "en" ? "**With `node`**" : "**`node` で起動する**";
  const runtimeLabel =
    lang === "en" ? "**With VS Code's runtime**" : "**VS Code の実行環境で起動する**";
  const labelOf = (f: Form) => (f === "node" ? nodeLabel : runtimeLabel);

  describe.each(RUNTIME_CLASSES)("$name", ({ rt, exe, forms }) => {
    const doc = buildAgentConfigDocument(BRIDGE, lang, undefined, "linux", rt);
    const want = forms.map((f) => expectedFor(f, exe));

    it("Claude Code: 形ごとの完全な claude mcp add の行が、決めた順で並ぶ（札つき）", () => {
      const sec = h2Section(doc, "Claude Code");
      const lines = codeBlocks(sec)
        .filter((b) => b.body.startsWith("claude mcp add"))
        .map((b) => b.body);
      expect(lines).toEqual(want.map((w) => `claude mcp add ${w.claude}`));
      // 各ブロックの直前に、その形の札がある
      let at = 0;
      for (const [i, f] of forms.entries()) {
        const label = sec.indexOf(labelOf(f), at);
        expect(label, f).toBeGreaterThan(-1);
        const block = sec.indexOf(lines[i] ?? "", label);
        expect(block, f).toBeGreaterThan(label);
        at = block;
      }
    });

    it("Claude Code のスコープ: user / project も形ごとに完全な行", () => {
      const scopes = h2Section(doc, lang === "en" ? "Scopes" : "スコープ");
      const cc = h3Section(scopes, "Claude Code", 0);
      const lines = codeBlocks(cc)
        .filter((b) => b.body.startsWith("claude mcp add"))
        .map((b) => b.body);
      expect(lines).toEqual([
        ...want.map((w) => `claude mcp add --scope user ${w.claude}`),
        ...want.map((w) => `claude mcp add --scope project ${w.claude}`),
      ]);
    });

    it("Codex CLI: 形ごとの TOML を本物のパーサで読むと、決めた順で2つの形", () => {
      const sec = h2Section(doc, "Codex CLI");
      const tomls = codeBlocks(sec).filter((b) => b.lang === "toml");
      expect(tomls.map((t) => parseToml(t.body))).toEqual(
        want.map((w) => ({ mcp_servers: { showme: w.toml } })),
      );
    });

    it("Copilot CLI: 形ごとの JSON をパースすると、決めた順で2つの形", () => {
      const sec = h2Section(doc, "Copilot CLI");
      expect(jsonBlocks(sec).map((j) => j.mcpServers.showme)).toEqual(want.map((w) => w.json));
    });

    it("node の形の条件（Node.js 20 以上・確かめ方・入れた後は完全に起動し直す・更新に強い）を1度だけ書く", () => {
      expect(doc).toMatch(lang === "en" ? /Node\.js 20 or later/ : /Node\.js 20 以上/);
      expect(doc).toContain("`which node`");
      expect(doc).not.toContain("where.exe");
      expect(doc).toMatch(
        lang === "en"
          ? /quit VS Code and that terminal completely/
          : /VS Code とその端末を完全に終了して/,
      );
      expect(doc).toMatch(
        lang === "en" ? /keeps working when VS Code updates/ : /更新・再起動しても動き続ける/,
      );
      // 手で書き換えさせる文は無い
      expect(doc).not.toMatch(
        lang === "en" ? /leave out `env`|use `"node"` as the command/ : /`env` を外す/,
      );
      // 頼む文（D100）は形の数に依らず同じ
      const prompt = (d: string) => codeBlocks(d).filter((b) => b.lang === "text");
      expect(prompt(doc)).toEqual(
        prompt(buildAgentConfigDocument(BRIDGE, lang, undefined, "linux", DESKTOP)),
      );
      expect(allowListInDocument(doc)).toEqual(agentConfigAllowList());
      expect(doc).not.toContain("<");
    });

    it("冒頭（最初の ## Claude Code より前）に claude mcp add の行を置かない（節が持つ）", () => {
      const head = doc.slice(0, doc.indexOf("\n## Claude Code\n"));
      expect(head).not.toContain("claude mcp add");
    });
  });
});

describe.each(["en", "ja"] as const)("Windows の2つの形（D109 / D114 改訂）[%s]", (lang) => {
  const doc = buildAgentConfigDocument(WIN_BRIDGE, lang, WIN_HOME, "win32", WIN_DESKTOP);

  it("node の形の Claude Code の行も / 区切りの二重引用符で、確かめ方は where.exe node", () => {
    const quoted =
      '"C:/Users/Jane Doe/.vscode/extensions/zvxbase.vscode-showme-0.1.5/bridge/index.js"';
    const sec = h2Section(doc, "Claude Code");
    const lines = codeBlocks(sec)
      .filter((b) => b.body.startsWith("claude mcp add"))
      .map((b) => b.body);
    expect(lines[1]).toBe(`claude mcp add --transport stdio showme -- node ${quoted}`);
    expect(doc).toContain("`where.exe node`");
    expect(doc).not.toContain("`which node`");
    // Windows では node の形は更新の仕組みに止められない、と書く
    expect(doc).toMatch(
      lang === "en" ? /the VS Code updater does not stop it/ : /更新の仕組みにも止められない/,
    );
  });
});
