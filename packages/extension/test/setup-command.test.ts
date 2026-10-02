import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type EditorRuntime,
  type SetupAgent,
  type SnippetForm,
  agentSetupSnippets,
  buildAgentConfigDocument,
  snippetRuntime,
} from "../src/agent-config-doc.js";
import {
  type CopySetupDeps,
  type PickItem,
  SETUP_AGENTS,
  copySetupCommand,
  setupCommandText,
} from "../src/setup-command.js";

/**
 * **ShowMe: Copy agent setup command**（増分14 D122）。
 *
 * 写す文字列は文書（**ShowMe: Show agent configuration**）と同じ関数から作る（不変条件14）。
 * それを「同じ関数を呼んでいる」ではなく値で確かめる: どの組み合わせでも、写す文字列が
 * 文書（英日）の中にそのまま現れること。
 */

const POSIX_BRIDGE = "/home/me/.vscode/extensions/zvxbase.vscode-showme-0.1.8/bridge/index.js";
const WIN_BRIDGE =
  "C:\\Users\\me\\.vscode\\extensions\\zvxbase.vscode-showme-0.1.8\\bridge\\index.js";
const DEV_BRIDGE = "/work/vscode-showme/packages/extension/bridge/index.js";

interface Case {
  name: string;
  bridgePath: string;
  home: string;
  platform: NodeJS.Platform;
  runtime: EditorRuntime;
}

const CASES: Case[] = [
  {
    name: "linux デスクトップ",
    bridgePath: POSIX_BRIDGE,
    home: "/home/me",
    platform: "linux",
    runtime: { executable: "/usr/share/code/code", remote: false },
  },
  {
    name: "linux リモート（node が先）",
    bridgePath: POSIX_BRIDGE.replace(".vscode", ".vscode-server"),
    home: "/home/me",
    platform: "linux",
    runtime: {
      executable: "/home/me/.vscode-server/cli/servers/Stable-x/server/node",
      remote: true,
    },
  },
  {
    name: "linux Flatpak（node だけ）",
    bridgePath: POSIX_BRIDGE,
    home: "/home/me",
    platform: "linux",
    runtime: {
      executable: "/app/extra/vscode/code",
      remote: false,
      env: { FLATPAK_ID: "com.visualstudio.code" },
    },
  },
  {
    name: "darwin（空白入りのパス）",
    bridgePath:
      "/Users/me/Library/Application Support/x/extensions/zvxbase.vscode-showme-0.1.8/bridge/index.js",
    home: "/Users/me",
    platform: "darwin",
    runtime: {
      executable: "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
      remote: false,
    },
  },
  {
    name: "win32",
    bridgePath: WIN_BRIDGE,
    home: "C:\\Users\\me",
    platform: "win32",
    runtime: {
      executable: "C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe",
      remote: false,
    },
  },
  {
    name: "開発中（版番号の無い置き場）",
    bridgePath: DEV_BRIDGE,
    home: "/home/me",
    platform: "linux",
    runtime: { executable: "/usr/share/code/code", remote: false },
  },
];

describe("setupCommandText（D122）: 写す文字列は文書の中にそのまま現れる", () => {
  for (const c of CASES) {
    for (const lang of ["en", "ja"] as const) {
      it(`${c.name} / ${lang}: 3つのエージェント × 出す形のすべて`, () => {
        const doc = buildAgentConfigDocument(c.bridgePath, lang, c.home, c.platform, c.runtime);
        const snippets = agentSetupSnippets(c.bridgePath, c.platform, c.runtime);
        expect(snippets.map((s) => s.kind)).toEqual(snippetRuntime(c.runtime).forms);
        let checked = 0;
        for (const agent of SETUP_AGENTS) {
          for (const s of snippets) {
            const text = setupCommandText(agent, s);
            expect(text.length).toBeGreaterThan(20);
            // コードブロックの中身として現れる（説明文の一部と偶然一致しているのではない）
            expect(doc, `${agent}/${s.kind}`).toContain(`\n${text}\n\`\`\``);
            checked++;
          }
        }
        // 食わせた件数を確かめる（0 件でも「全部現れた」は真になる）
        expect(checked).toBe(3 * snippetRuntime(c.runtime).forms.length);
      });
    }
  }

  it("Claude Code はスコープ無しの `claude mcp add` の1行、Codex は節、Copilot CLI は JSON", () => {
    const c = CASES[0] as Case;
    const [s] = agentSetupSnippets(c.bridgePath, c.platform, c.runtime);
    if (s === undefined) throw new Error("断片が無い");
    const claude = setupCommandText("claude", s);
    expect(claude).toMatch(
      /^claude mcp add -e ELECTRON_RUN_AS_NODE=1 --transport stdio showme -- /,
    );
    expect(claude).not.toContain("--scope");
    expect(claude).not.toContain("\n");
    expect(setupCommandText("codex", s)).toMatch(/^\[mcp_servers\.showme\]\n/);
    const copilot = JSON.parse(setupCommandText("copilot", s)) as {
      mcpServers: { showme: { tools: string[] } };
    };
    expect(copilot.mcpServers.showme.tools).toEqual(["*"]);
  });

  it("Windows の Claude Code の行は文書と同じ二重引用符の形（D109）", () => {
    const c = CASES.find((x) => x.platform === "win32") as Case;
    const snippets = agentSetupSnippets(c.bridgePath, c.platform, c.runtime);
    for (const s of snippets) {
      const line = setupCommandText("claude", s);
      expect(line).toContain(
        '"C:/Users/me/.vscode/extensions/zvxbase.vscode-showme-0.1.8/bridge/index.js"',
      );
      expect(line).not.toContain("\\");
    }
  });
});

/** 選択の偽物: 指定した値を選ぶ（undefined なら取り消し）。出された候補を記録する。 */
function fakeDeps(
  c: Case,
  choose: { agent?: SetupAgent; form?: SnippetForm },
): CopySetupDeps & {
  offered: PickItem<unknown>[][];
  clipboard: string[];
  informed: { message: string; button: string }[];
  opened: number;
  answer: (button: string | undefined) => void;
} {
  let resolveInform: (v: string | undefined) => void = () => {};
  const deps = {
    offered: [] as PickItem<unknown>[][],
    clipboard: [] as string[],
    informed: [] as { message: string; button: string }[],
    opened: 0,
    answer: (b: string | undefined) => resolveInform(b),
    inputs: { bridgePath: c.bridgePath, platform: c.platform, runtime: c.runtime },
    pick: async <T>(items: readonly PickItem<T>[]): Promise<T | undefined> => {
      deps.offered.push(items as readonly PickItem<unknown>[] as PickItem<unknown>[]);
      const want = deps.offered.length === 1 ? choose.agent : choose.form;
      return items.find((i) => i.value === want)?.value;
    },
    writeClipboard: async (text: string) => {
      deps.clipboard.push(text);
    },
    inform: (message: string, button: string) => {
      deps.informed.push({ message, button });
      return new Promise<string | undefined>((r) => {
        resolveInform = r;
      });
    },
    openFullConfiguration: async () => {
      deps.opened++;
    },
  };
  return deps;
}

describe("copySetupCommand（D122）: 選んで写して、どこへ貼るかを言う", () => {
  const desktop = CASES[0] as Case;

  it("エージェント → 形の順に訊き、形の候補と順は snippetRuntime の forms と同じ", async () => {
    for (const c of CASES) {
      const forms = snippetRuntime(c.runtime).forms;
      const deps = fakeDeps(c, { agent: "codex", form: forms[forms.length - 1] });
      const done = await copySetupCommand(deps);
      expect(deps.offered[0]?.map((i) => i.value)).toEqual(["claude", "codex", "copilot"]);
      if (forms.length > 1) {
        expect(deps.offered[1]?.map((i) => i.value)).toEqual(forms);
      } else {
        // Flatpak は node だけ ―― 形を訊かない
        expect(deps.offered).toHaveLength(1);
      }
      const snippet = agentSetupSnippets(c.bridgePath, c.platform, c.runtime).find(
        (s) => s.kind === forms[forms.length - 1],
      );
      expect(snippet).toBeDefined();
      expect(deps.clipboard).toEqual([setupCommandText("codex", snippet as never)]);
      expect(done?.text).toBe(deps.clipboard[0]);
    }
  });

  it("形の候補の先頭（勧めるもの）に印が付き、それ以外には付かない", async () => {
    const deps = fakeDeps(desktop, { agent: "claude", form: "node" });
    await copySetupCommand(deps);
    const forms = deps.offered[1] ?? [];
    expect(forms[0]?.description).toMatch(/recommended/i);
    expect(forms[1]?.description ?? "").not.toMatch(/recommended/i);
  });

  it("エージェントを取り消したら何も写さず、何も言わない", async () => {
    const deps = fakeDeps(desktop, {});
    expect(await copySetupCommand(deps)).toBeUndefined();
    expect(deps.clipboard).toEqual([]);
    expect(deps.informed).toEqual([]);
  });

  it("形を取り消したら何も写さない", async () => {
    const deps = fakeDeps(desktop, { agent: "copilot" });
    expect(await copySetupCommand(deps)).toBeUndefined();
    expect(deps.clipboard).toEqual([]);
    expect(deps.informed).toEqual([]);
  });

  it("メッセージは貼る場所をエージェントごとに言う", async () => {
    const where: Record<SetupAgent, RegExp> = {
      claude: /terminal/i,
      codex: /~\/\.codex\/config\.toml/,
      copilot: /~\/\.copilot\/mcp-config\.json/,
    };
    for (const agent of SETUP_AGENTS) {
      const deps = fakeDeps(desktop, { agent, form: "runtime" });
      await copySetupCommand(deps);
      expect(deps.informed).toHaveLength(1);
      expect(deps.informed[0]?.message).toMatch(where[agent]);
      expect(deps.informed[0]?.button).toBe("Open full configuration");
    }
  });

  it("Copilot CLI のメッセージは写した形（mcpServers を頂点に持つ JSON の塊）と同じことを言う", async () => {
    // 写すのは {"mcpServers": {"showme": …}} の塊。「"showme" の項目を mcpServers の下に足す」とだけ言うと、
    // 既にサーバのあるファイルに塊ごと貼られて mcpServers.mcpServers.showme ができる（レビュー）
    const deps = fakeDeps(desktop, { agent: "copilot", form: "runtime" });
    const done = await copySetupCommand(deps);
    const parsed = JSON.parse(done?.text ?? "") as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["mcpServers"]);
    const message = deps.informed[0]?.message ?? "";
    // 塊であることを言い、ファイルが無いとき・あるときの2通りを言う
    expect(message).toContain('{"mcpServers": {"showme": …}}');
    expect(message).toMatch(/doesn't exist/);
    expect(message).toMatch(/existing "mcpServers"/);
    expect(message).not.toMatch(/copied the "showme" entry/i);
  });

  it("日本語のメッセージも同じ2通りを言う（束の値）", () => {
    const bundle = JSON.parse(
      readFileSync(new URL("../l10n/bundle.l10n.ja.json", import.meta.url), "utf8"),
    ) as Record<string, string>;
    const copilot = Object.entries(bundle).filter(([k]) => k.includes("mcp-config.json"));
    const messages = copilot.filter(([k]) => k.startsWith("ShowMe: copied"));
    expect(messages).toHaveLength(1);
    const [en, ja] = messages[0] as [string, string];
    expect(en).toContain('{"mcpServers": {"showme": …}}');
    expect(ja).toContain('{"mcpServers": {"showme": …}}');
    expect(ja).toMatch(/無ければ/);
    expect(ja).toMatch(/既にある "mcpServers"/);
  });

  it("「Open full configuration」を押すと文書を開く。閉じただけなら開かない", async () => {
    const pressed = fakeDeps(desktop, { agent: "claude", form: "runtime" });
    await copySetupCommand(pressed);
    pressed.answer("Open full configuration");
    await new Promise((r) => setTimeout(r, 0));
    expect(pressed.opened).toBe(1);

    const dismissed = fakeDeps(desktop, { agent: "claude", form: "runtime" });
    await copySetupCommand(dismissed);
    dismissed.answer(undefined);
    await new Promise((r) => setTimeout(r, 0));
    expect(dismissed.opened).toBe(0);
  });

  it("メッセージの返事を待たずに終わる（写したら完了）", async () => {
    const deps = fakeDeps(desktop, { agent: "claude", form: "runtime" });
    // inform は答えないまま。待っていればここで止まる
    const done = await copySetupCommand(deps);
    expect(done?.agent).toBe("claude");
  });
});
