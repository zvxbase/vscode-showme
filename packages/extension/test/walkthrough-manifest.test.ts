import { existsSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WALKTHROUGH_ID, openWalkthroughArgs } from "../src/walkthrough.js";

/**
 * Get Started の walkthrough と、入れた直後の案内の命令（増分14 D120 / D121 / D123）。
 *
 * walkthrough は宣言だけで、間違っていても VS Code は黙って出さないか、`%key%` の綴りや
 * 押しても何も起きないボタンを出す。ここで manifest の値として確かめる。
 */
const read = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), "utf8"));
const exists = (rel: string): boolean => existsSync(new URL(`../${rel}`, import.meta.url));
const size = (rel: string): number => statSync(new URL(`../${rel}`, import.meta.url)).size;

interface Step {
  id: string;
  title: string;
  description: string;
  media: { image?: string; altText?: string; markdown?: string };
  completionEvents?: string[];
}
interface Walkthrough {
  id: string;
  title: string;
  description: string;
  steps: Step[];
}
const manifest = read("package.json") as {
  description: string;
  keywords: string[];
  contributes: { commands: { command: string; title: string }[]; walkthroughs?: Walkthrough[] };
};
const nlsEn = read("package.nls.json") as Record<string, string>;
const nlsJa = read("package.nls.ja.json") as Record<string, string>;
const declared = new Set(manifest.contributes.commands.map((c) => c.command));

/** `%key%` を nls で引く。`%key%` でなければ undefined（平文の宣言を許さない） */
function nls(value: string, table: Record<string, string>): string | undefined {
  const m = /^%([\w.-]+)%$/.exec(value);
  return m === null ? undefined : table[m[1] as string];
}

const walkthroughs = manifest.contributes.walkthroughs ?? [];
const wt = walkthroughs[0] as Walkthrough;

describe("contributes.walkthroughs（D120）", () => {
  it("ShowMe の walkthrough がちょうど1つあり、id は定数と同じ", () => {
    expect(walkthroughs).toHaveLength(1);
    expect(wt.id).toBe(WALKTHROUGH_ID);
  });

  it("題・説明・各手順の題と説明は %key% で、英日の両方にある", () => {
    const strings = [
      wt.title,
      wt.description,
      ...wt.steps.flatMap((s) => [s.title, s.description]),
    ];
    for (const v of strings) {
      expect(nls(v, nlsEn), `${v} が package.nls.json に無い`).toBeTypeOf("string");
      expect(nls(v, nlsJa), `${v} が package.nls.ja.json に無い`).toBeTypeOf("string");
    }
    expect(nls(wt.title, nlsEn)).toBe("Get started with ShowMe");
  });

  it("手順は3つ: オンにする → 繋ぐ → 頼む", () => {
    expect(wt.steps.map((s) => s.id)).toEqual(["turnOn", "connect", "ask"]);
  });

  it("説明のボタン（command: のリンク）は自分の宣言した命令だけを呼ぶ（英日とも）", () => {
    let links = 0;
    for (const step of wt.steps) {
      for (const table of [nlsEn, nlsJa]) {
        const text = nls(step.description, table) ?? "";
        for (const m of text.matchAll(/\]\(command:([^)?\s]+)/g)) {
          expect(declared.has(m[1] as string), `${step.id}: ${m[1]} は宣言されていない`).toBe(true);
          expect(m[1]).toMatch(/^showme\./);
          links++;
        }
      }
    }
    // turnOn に1つ、connect に2つ。英日で倍（食わせた件数を確かめる）
    expect(links).toBe(6);
  });

  it("英日の説明は同じボタンを同じ順に持つ", () => {
    for (const step of wt.steps) {
      const cmds = (table: Record<string, string>) =>
        [...(nls(step.description, table) ?? "").matchAll(/\]\(command:([^)\s]+)\)/g)].map(
          (m) => m[1],
        );
      expect(cmds(nlsJa), step.id).toEqual(cmds(nlsEn));
    }
  });

  it("完了の onCommand: は宣言した命令を指す", () => {
    const events = wt.steps.flatMap((s) => s.completionEvents ?? []);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      const m = /^onCommand:(.+)$/.exec(e);
      expect(m, e).not.toBeNull();
      expect(declared.has(m?.[1] as string), e).toBe(true);
    }
    const byId = Object.fromEntries(wt.steps.map((s) => [s.id, s.completionEvents ?? []]));
    expect(byId.turnOn).toEqual(["onCommand:showme.toggle"]);
    expect(byId.connect).toEqual([
      "onCommand:showme.copySetupCommand",
      "onCommand:showme.showAgentConfig",
    ]);
  });

  it("画像は拡張の中にあり、altText があり、小さい（VSIX を太らせない）", () => {
    const images = wt.steps.filter((s) => s.media.image !== undefined);
    expect(images.length).toBe(2);
    for (const s of images) {
      const img = s.media.image as string;
      expect(img).toMatch(/^media\/walkthrough\/[\w-]+\.png$/);
      expect(exists(img), img).toBe(true);
      expect(size(img), img).toBeLessThan(80_000);
      expect(nls(s.media.altText ?? "", nlsEn)).toBeTypeOf("string");
      expect(nls(s.media.altText ?? "", nlsJa)).toBeTypeOf("string");
    }
  });

  it("Markdown のメディアは英日で別のファイルを nls の値で指し、どちらも実在する", () => {
    const md = wt.steps.filter((s) => s.media.markdown !== undefined);
    expect(md.map((s) => s.id)).toEqual(["connect"]);
    const ref = md[0]?.media.markdown as string;
    const en = nls(ref, nlsEn);
    const ja = nls(ref, nlsJa);
    expect(en).toBe("media/walkthrough/connect.md");
    expect(ja).toBe("media/walkthrough/connect.ja.md");
    for (const p of [en, ja] as string[]) expect(exists(p), p).toBe(true);
  });

  it("Markdown のメディアは3つのエージェントの貼る場所を英日で同じだけ持つ", () => {
    for (const p of ["media/walkthrough/connect.md", "media/walkthrough/connect.ja.md"]) {
      const text = readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
      for (const needle of [
        "Copilot",
        "Claude Code",
        "claude mcp add",
        "Codex CLI",
        "~/.codex/config.toml",
        "Copilot CLI",
        "~/.copilot/mcp-config.json",
      ]) {
        expect(text, `${p}: ${needle}`).toContain(needle);
      }
      // Copilot CLI に写すのは {"mcpServers": …} の塊。「項目を足す」とだけ言わない（レビュー）
      expect(text, p).toContain('{"mcpServers": {"showme": …}}');
      // walkthrough の Markdown から命令は呼ばない（ボタンは説明の側に置く）
      expect(text).not.toContain("command:");
    }
  });

  it("「頼む」手順の例は README の What to ask と同じ文言", () => {
    const ask = wt.steps.find((s) => s.id === "ask") as Step;
    const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
    const examples = [
      ...(nls(ask.description, nlsEn) ?? "").matchAll(/"(Use ShowMe to [^"]+)"/g),
    ].map((m) => m[1] as string);
    expect(examples.length).toBeGreaterThanOrEqual(2);
    for (const e of examples) expect(readme, e).toContain(`"${e}"`);
    const readmeJa = readFileSync(new URL("../../../README.ja.md", import.meta.url), "utf8");
    const examplesJa = [
      ...(nls(ask.description, nlsJa) ?? "").matchAll(/「(ShowMe を使って[^」]+)」/g),
    ].map((m) => m[1] as string);
    expect(examplesJa).toHaveLength(examples.length);
    for (const e of examplesJa) expect(readmeJa, e).toContain(`「${e}」`);
  });
});

describe("入れた直後の命令（D121 / D122）", () => {
  it("ShowMe: Get started と ShowMe: Copy agent setup command が宣言され、題は英日にある", () => {
    for (const [command, en, ja] of [
      ["showme.getStarted", "ShowMe: Get started", "ShowMe: "],
      ["showme.copySetupCommand", "ShowMe: Copy agent setup command", "ShowMe: "],
    ] as const) {
      const c = manifest.contributes.commands.find((x) => x.command === command);
      expect(c, command).toBeDefined();
      expect(nls(c?.title ?? "", nlsEn)).toBe(en);
      expect(nls(c?.title ?? "", nlsJa)).toMatch(new RegExp(`^${ja}`));
    }
  });

  it("Get started は <拡張 ID>#<walkthrough の id> で開く", () => {
    expect(openWalkthroughArgs("zvxbase.vscode-showme")).toEqual([
      "workbench.action.openWalkthrough",
      `zvxbase.vscode-showme#${WALKTHROUGH_ID}`,
    ]);
  });
});

describe("Marketplace の説明文と keywords（D123）", () => {
  it("探す人の語が先頭近くにあり、200 字以内", () => {
    const d = manifest.description;
    expect(d.length).toBeLessThanOrEqual(200);
    expect(d.slice(0, 80)).toMatch(/MCP server/);
    for (const w of ["Copilot", "Claude Code", "Codex", "VS Code"]) expect(d, w).toContain(w);
    // README の主張の範囲（ネットワークの主張を足さない）
    expect(d).not.toMatch(/network|offline|telemetry/i);
  });

  it("keywords に mcp server / walkthrough / code tour があり、重複が無く 30 以内", () => {
    const k = manifest.keywords;
    for (const w of ["mcp server", "walkthrough", "code tour"]) expect(k).toContain(w);
    expect(new Set(k).size).toBe(k.length);
    expect(k.length).toBeLessThanOrEqual(30);
  });
});
