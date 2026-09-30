import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyRegions,
  checkAll,
  checkNames,
  checkStamp,
  checkStructure,
  loadSources,
  paletteCommands,
  readStamp,
  renderRegion,
  sectionHashes,
  writeStamp,
} from "./readme-blocks.mjs";

const root = path.resolve(__dirname, "..", "..");
const src = loadSources(root);
const readme = (name: string) => fs.readFileSync(path.join(root, name), "utf8");

interface Manifest {
  contributes: {
    commands: { command: string; title: string }[];
    menus: { commandPalette?: { command: string; when?: string }[] };
    configuration: { properties: Record<string, { default: unknown }> };
  };
}
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "packages/extension/package.json"), "utf8"),
) as Manifest;
const nlsEn = JSON.parse(
  fs.readFileSync(path.join(root, "packages/extension/package.nls.json"), "utf8"),
) as Record<string, string>;
const nlsJa = JSON.parse(
  fs.readFileSync(path.join(root, "packages/extension/package.nls.ja.json"), "utf8"),
) as Record<string, string>;

const titleOf = (nls: Record<string, string>, id: string) => {
  const c = manifest.contributes.commands.find((x) => x.command === id);
  return nls[(c?.title ?? "").replace(/^%|%$/g, "")];
};

/** 表の本文の行（見出しと区切りを除く）を、セルの配列にする。 */
const rows = (table: string) =>
  table
    .split("\n")
    .filter((l) => l.startsWith("|"))
    .slice(2)
    .map((l) =>
      l
        .slice(1, -1)
        .split(/(?<!\\)\|/)
        .map((c) => c.trim()),
    );

describe("commands の生成（package.json の宣言と一致する）", () => {
  // パレットから隠した命令（when: "false"）は載せない。数は宣言から独立に数える
  const hidden = new Set(
    (manifest.contributes.menus.commandPalette ?? [])
      .filter((m) => m.when === "false")
      .map((m) => m.command),
  );
  const expected = manifest.contributes.commands
    .map((c) => c.command)
    .filter((id) => !hidden.has(id));

  it("パレットに出る命令だけを、宣言の順に並べる", () => {
    expect(expected.length).toBeGreaterThan(0);
    expect(paletteCommands(src).map((c: { id: string }) => c.id)).toEqual(expected);
  });

  it("英語版: 行ごとに英語名が一致する", () => {
    const r = rows(renderRegion("commands", "en", src));
    expect(r.length).toBe(expected.length);
    expected.forEach((id, i) => {
      expect(r[i][0]).toBe(`**${titleOf(nlsEn, id)}**`);
      expect(r[i][1].length).toBeGreaterThan(0);
    });
  });

  it("日本語版: 日本語名の直後に英語名が並ぶ", () => {
    const r = rows(renderRegion("commands", "ja", src));
    expect(r.length).toBe(expected.length);
    expected.forEach((id, i) => {
      expect(r[i][0]).toBe(`**${titleOf(nlsJa, id)}**（\`${titleOf(nlsEn, id)}\`）`);
    });
  });

  it("説明の元データは、パレットに出る命令ちょうどを英日の両方で持つ", () => {
    const desc = JSON.parse(
      fs.readFileSync(path.join(root, "scripts/docs/command-descriptions.json"), "utf8"),
    ) as Record<string, { en: string; ja: string; paletteWhen?: string }>;
    expect(Object.keys(desc).sort()).toEqual([...expected].sort());
    for (const [id, d] of Object.entries(desc)) {
      expect(d.en, id).toMatch(/\S/);
      expect(d.ja, id).toMatch(/\S/);
      expect(d.ja, id).not.toBe(d.en);
    }
  });

  it("パレットに条件付きで出る命令は、説明側にその条件を写してある（条件が変われば止まる）", () => {
    const changed = structuredClone(src);
    const item = changed.manifest.contributes.menus.commandPalette.find(
      (m: { when?: string }) => m.when !== "false",
    );
    item.when = "editorLangId == markdown";
    expect(() => paletteCommands(changed)).toThrow(/showme\.openRealFile.*when/s);
  });
});

describe("settings の生成（package.json と package.nls の宣言と一致する）", () => {
  const props = manifest.contributes.configuration.properties;
  const keys = Object.keys(props);

  it.each(["en", "ja"] as const)("%s: 全部の設定が宣言の順に、既定値つきで並ぶ", (lang) => {
    const r = rows(renderRegion("settings", lang, src));
    expect(r.map((c) => c[0])).toEqual(keys.map((k) => `\`${k}\``));
    expect(r.map((c) => c[1])).toEqual(keys.map((k) => `\`${JSON.stringify(props[k].default)}\``));
  });

  it("説明は各言語の nls から取る（列挙の値の説明も）", () => {
    const en = renderRegion("settings", "en", src);
    const ja = renderRegion("settings", "ja", src);
    expect(en).toContain("Accept connections from agents.");
    expect(ja).toContain("エージェントからの接続を受け付ける。");
    expect(en).toContain('`"dedicated"`: Keep your column for you');
    expect(ja).toContain('`"dedicated"`: あなたの列はあなた専用にする');
  });

  it("Markdown として意味を持つ文字は逃がす（表を壊さない・強調にしない）", () => {
    const changed = structuredClone(src);
    changed.nls.en["showme.config.maxSelectionChars"] = "a | b *.pem id_rsa* `x` __pycache__";
    const en = renderRegion("settings", "en", changed);
    expect(en).toContain("a \\| b \\*.pem id\\_rsa\\* \\`x\\` \\_\\_pycache\\_\\_");
  });
});

describe("生成範囲の書き換えと検出", () => {
  const doc = (body: string) =>
    [
      "# t",
      "",
      "<!-- BEGIN GENERATED: commands -->",
      body,
      "<!-- END GENERATED: commands -->",
      "",
      "<!-- BEGIN GENERATED: settings -->",
      "<!-- END GENERATED: settings -->",
      "",
    ].join("\n");

  it("--write は範囲の中だけを書き、外は変えない", () => {
    const { text, errors } = applyRegions(doc("HAND-WRITTEN"), "en", src);
    expect(errors).toEqual([]);
    expect(text.startsWith("# t\n\n<!-- BEGIN GENERATED: commands -->\n")).toBe(true);
    expect(text).toContain(renderRegion("commands", "en", src));
    expect(text).not.toContain("HAND-WRITTEN");
    // 冪等
    expect(applyRegions(text, "en", src).text).toBe(text);
  });

  it("--check は手で書き換えた範囲を、範囲の名前で咎める", () => {
    const good = applyRegions(doc(""), "en", src).text;
    const edited = good.replace("Remove all of the agent's annotations.", "Remove annotations.");
    const errors = checkAll({ en: edited, ja: null }, src, { only: ["regions"] });
    expect(errors.join("\n")).toMatch(/README\.md.*commands.*--write/);
  });

  it("--check は古い範囲（元の宣言が変わった）を咎める", () => {
    const good = applyRegions(doc(""), "en", src).text;
    const changed = structuredClone(src);
    changed.nls.en["showme.command.clearAnnotations"] = "ShowMe: Remove annotations";
    const errors = checkAll({ en: good, ja: null }, changed, { only: ["regions"] });
    expect(errors.join("\n")).toMatch(/commands/);
    expect(checkAll({ en: good, ja: null }, src, { only: ["regions"] })).toEqual([]);
  });

  it("範囲が無い・閉じていない・重なっているものは失敗する", () => {
    expect(applyRegions("# t\n", "en", src).errors.join("\n")).toMatch(/commands.*missing/);
    const unclosed = doc("").replace("<!-- END GENERATED: commands -->", "");
    expect(applyRegions(unclosed, "en", src).errors.join("\n")).toMatch(/commands/);
    const unknown = `${doc("")}<!-- BEGIN GENERATED: nope -->\n<!-- END GENERATED: nope -->\n`;
    expect(applyRegions(unknown, "en", src).errors.join("\n")).toMatch(/nope/);
  });
});

describe("本文の `ShowMe: …` の照合", () => {
  it("英語版: 実在する命令名とステータスバーの文言は通る", () => {
    const text = [
      "Run **ShowMe: Clear annotations**.",
      "Click **`ShowMe: Off`**.",
      "| `ShowMe: not found …` | x |",
      "| `ShowMe: Failed to start` | x |",
    ].join("\n");
    expect(checkNames(text, "en", src)).toEqual([]);
  });

  it("英語版: 実在しない名前は失敗する", () => {
    const errors = checkNames("Run **ShowMe: Clear everything**.", "en", src);
    expect(errors.join("\n")).toMatch(/ShowMe: Clear everything/);
  });

  it("英語版: 日本語名は失敗する", () => {
    expect(checkNames("Run **ShowMe: 注釈を消す**.", "en", src)).not.toEqual([]);
  });

  it("強調かコードで囲まない `ShowMe: …` は照合できないので失敗する", () => {
    expect(checkNames("Run ShowMe: Clear annotations now.", "en", src).join("\n")).toMatch(
      /line 1/,
    );
  });

  it("日本語版: 日本語名の直後に英語名が括弧で並べば通る", () => {
    const text = [
      "**ShowMe: 注釈を消す**（`ShowMe: Clear annotations`）を実行する。",
      "**`ShowMe: オフ`**（`ShowMe: Off`）をクリック。",
      "| `ShowMe: 見つからず …`（`ShowMe: not found …`） | x |",
    ].join("\n");
    expect(checkNames(text, "ja", src)).toEqual([]);
  });

  it("日本語版: 英語名が無い日本語名は失敗する", () => {
    const errors = checkNames("**ShowMe: 注釈を消す** を実行する。", "ja", src);
    expect(errors.join("\n")).toMatch(/ShowMe: 注釈を消す/);
  });

  it("日本語版: 組が一致しない（別の命令の英語名）は失敗する", () => {
    const errors = checkNames(
      "**ShowMe: 注釈を消す**（`ShowMe: Show the operations log`）を実行する。",
      "ja",
      src,
    );
    expect(errors.join("\n")).toMatch(/ShowMe: Show the operations log/);
  });

  it("日本語版: 実在しない日本語名は失敗する", () => {
    const errors = checkNames(
      "**ShowMe: 全部消す**（`ShowMe: Clear annotations`）を実行する。",
      "ja",
      src,
    );
    expect(errors.join("\n")).toMatch(/ShowMe: 全部消す/);
  });

  it("日本語版: 日本語名の付かない英語名は失敗する", () => {
    expect(checkNames("`ShowMe: Off` をクリック。", "ja", src)).not.toEqual([]);
  });

  it("省略（…）は1つの文言に決まるときだけ通る", () => {
    expect(checkNames("`ShowMe: Connected …`", "en", src)).toEqual([]);
    expect(checkNames("`ShowMe: …`", "en", src).join("\n")).toMatch(/ambiguous|more than one/);
  });
});

describe("訳の印（節ごとの内容のハッシュ）", () => {
  const en = [
    "# t",
    "",
    "intro",
    "",
    "## Alpha",
    "",
    "alpha text",
    "",
    "### Alpha one",
    "",
    "one",
    "",
    "## Beta",
    "",
    "<!-- BEGIN GENERATED: commands -->",
    "| a |",
    "<!-- END GENERATED: commands -->",
    "",
    "beta text",
    "",
  ].join("\n");
  const ja = writeStamp(
    [
      "# t",
      "",
      "前書き",
      "",
      "## アルファ",
      "",
      "本文",
      "",
      "### その1",
      "",
      "1",
      "",
      "## ベータ",
      "",
    ].join("\n"),
    en,
  );

  it("--stamp は日本語版の先頭に英語版の節ごとのハッシュを書き、検査が通る", () => {
    expect(ja.startsWith("<!-- translated-from README.md: {")).toBe(true);
    expect(Object.keys(readStamp(ja) ?? {})).toEqual(["t", "Alpha", "Alpha one", "Beta"]);
    expect(Object.values(readStamp(ja) ?? {}).every((h) => /^[0-9a-f]{16}$/.test(String(h)))).toBe(
      true,
    );
    expect(checkStamp(en, ja)).toEqual([]);
    // 書き直しても印は1つ（冪等）
    expect(writeStamp(ja, en)).toBe(ja);
  });

  it("英語版の1節を変えると、その節の名前だけを挙げて失敗する", () => {
    // 本文の行だけを変える（見出し "### Alpha one" の綴りは変えない）
    const changed = en.replace("\n\none\n", "\n\none, now longer\n");
    expect(changed).toContain("### Alpha one\n");
    const errors = checkStamp(changed, ja);
    expect(errors).toHaveLength(1);
    // 挙げた節の名前を並びとして取り出して比べる（部分一致だと "Alpha" と "Alpha one" を取り違える）
    const listed = /in these sections: (.*?)\. Update/.exec(errors[0])?.[1] ?? "";
    expect([...listed.matchAll(/"([^"]*)"/g)].map((m) => m[1])).toEqual(["Alpha one"]);
    expect(errors[0]).toMatch(/README\.ja\.md.*--stamp/);
  });

  it("節を足す・消す・見出しを変えるのも、その節の名前で失敗する", () => {
    expect(checkStamp(`${en}\n## Gamma\n\nnew\n`, ja).join()).toContain('"Gamma"');
    expect(checkStamp(en.replace("## Beta", "## Bravo"), ja).join()).toMatch(/"Bravo".*"Beta"/);
  });

  it("生成範囲の中身はハッシュに入らない（生成器が両方を同時に書く）", () => {
    const regen = en.replace("| a |", "| a |\n| b |");
    expect(sectionHashes(regen)).toEqual(sectionHashes(en));
    expect(checkStamp(regen, ja)).toEqual([]);
    // 範囲の外は入る
    expect(sectionHashes(en.replace("beta text", "beta text!")).Beta).not.toBe(
      sectionHashes(en).Beta,
    );
  });

  it("行末の空白と改行コードでは変わらない", () => {
    expect(sectionHashes(en.replace("alpha text", "alpha text  ").replace(/\n/g, "\r\n"))).toEqual(
      sectionHashes(en),
    );
  });

  it("先頭の BOM・空行があっても印を読み、--stamp は既存の印を置き換える（2つ目を足さない）", () => {
    const padded = `\uFEFF\n\n${ja}`;
    expect(readStamp(padded)).toEqual(readStamp(ja));
    expect(checkStamp(en, padded)).toEqual([]);
    const restamped = writeStamp(padded, en);
    expect(restamped.match(/translated-from/g)).toHaveLength(1);
    expect(restamped).toBe(ja);
  });

  it("印が2つあれば失敗する", () => {
    const twice = ja.replace("## アルファ", `${ja.split("\n# t")[0]}\n## アルファ`);
    expect(checkStamp(en, twice).join()).toMatch(/more than one/);
    expect(writeStamp(twice, en).match(/translated-from/g)).toHaveLength(1);
  });

  it("印が無ければ失敗する", () => {
    expect(checkStamp(en, "# t\n").join()).toMatch(/no translated-from stamp/);
  });
});

describe("2つの README の構造", () => {
  const en = [
    "# t",
    "",
    "## A",
    "",
    "| x |",
    "|---|",
    "| 1 |",
    "",
    "## B",
    "",
    "```sh",
    "npm ci",
    "```",
    "",
  ].join("\n");
  const ja = [
    "# t",
    "",
    "## あ",
    "",
    "| x |",
    "|---|",
    "| 1 |",
    "",
    "## い",
    "",
    "```sh",
    "npm ci",
    "```",
    "",
  ].join("\n");

  it("見出しの深さと順・表の行・コードブロックが一致すれば通る（見出しの文言は違ってよい）", () => {
    expect(checkStructure(en, ja)).toEqual([]);
  });

  it("見出しの数が違えば失敗する", () => {
    expect(checkStructure(en, `${ja}\n## う\n`).join()).toMatch(/headings differ.*## う/);
  });

  it("見出しの深さ（順）が違えば失敗する", () => {
    expect(checkStructure(en, ja.replace("## い", "### い")).join()).toMatch(/headings differ/);
  });

  it("コードブロックの中身が違えば失敗する", () => {
    expect(checkStructure(en, ja.replace("npm ci", "npm install")).join()).toMatch(
      /code block 1 differs/,
    );
    expect(checkStructure(en, ja.replace(/```sh\nnpm ci\n```\n/, "")).join()).toMatch(
      /code blocks differ/,
    );
  });

  it("コードブロックの字下げの違いも失敗する（フェンスの行だけを整える）", () => {
    expect(checkStructure(en, ja.replace("npm ci", "  npm ci")).join()).toMatch(
      /code block 1 differs/,
    );
    // フェンスの行の前後の空白は問わない
    expect(checkStructure(en, ja.replace("```sh", "```sh  "))).toEqual([]);
  });

  it("フェンスの中の # は見出しにしない", () => {
    const fenced = (s: string) => s.replace("npm ci", "# comment\nnpm ci");
    expect(checkStructure(fenced(en), fenced(ja))).toEqual([]);
  });

  it("節の表の行の数が違えば、その節の名前で失敗する", () => {
    expect(checkStructure(en, ja.replace("| 1 |", "| 1 |\n| 2 |")).join()).toMatch(
      /table rows differ in "A" \/ "あ"/,
    );
  });
});

describe("改行コード（CRLF の作業ツリーでも同じ判定）", () => {
  const crlf = (t: string) => t.replace(/\n/g, "\r\n");

  it("CRLF の README でも --check が通る", () => {
    const texts = { en: crlf(readme("README.md")), ja: crlf(readme("README.ja.md")) };
    expect(checkAll(texts, src)).toEqual([]);
  });

  it("--write は LF で書く", () => {
    const { text, errors } = applyRegions(crlf(readme("README.md")), "en", src);
    expect(errors).toEqual([]);
    expect(text.includes("\r")).toBe(false);
    expect(text).toBe(readme("README.md"));
  });

  it("CRLF でも名前の照合は同じ", () => {
    const text = "**ShowMe: 注釈を消す**（`ShowMe: Clear annotations`）\r\n`ShowMe: Off`\r\n";
    expect(checkNames(text, "ja", src)).toEqual(checkNames(text.replace(/\r/g, ""), "ja", src));
    expect(checkNames(text, "ja", src)).toHaveLength(1);
  });
});

describe("名前の照合が見る場所・見ない場所", () => {
  it("フェンスの中は見ない（同じ文字で、同じか長いフェンスでだけ閉じる）", () => {
    const text = ["````md", "```", "ShowMe: anything", "```", "````", ""].join("\n");
    expect(checkNames(text, "en", src)).toEqual([]);
    const tilde = ["~~~", "ShowMe: anything", "```", "ShowMe: still code", "~~~", ""].join("\n");
    expect(checkNames(tilde, "en", src)).toEqual([]);
    // 閉じた後は見る
    expect(checkNames(`${tilde}ShowMe: after\n`, "en", src).join()).toMatch(/line 6/);
  });

  it("生成範囲の中身は見ない（生成器が名前を保証する）", () => {
    const text = [
      "<!-- BEGIN GENERATED: commands -->",
      "| ShowMe: free text in a description |",
      "<!-- END GENERATED: commands -->",
      "",
    ].join("\n");
    expect(checkNames(text, "en", src)).toEqual([]);
  });

  it("リンクの文字と見出しの名前も照合する", () => {
    expect(checkNames("[ShowMe: Clear annotations](#x)", "en", src)).toEqual([]);
    expect(checkNames("[ShowMe: Clear everything](#x)", "en", src).join()).toMatch(
      /Clear everything/,
    );
    expect(checkNames("### ShowMe: Clear annotations", "en", src)).toEqual([]);
    expect(checkNames("### ShowMe: Clear everything", "en", src).join()).toMatch(
      /Clear everything/,
    );
  });

  it("見出しの名前は （ かバッククォートで終わり、日本語版の組として照合する", () => {
    const pair = "## ShowMe: 注釈を消す（`ShowMe: Clear annotations`）";
    expect(checkNames(pair, "ja", src)).toEqual([]);
    const wrong = "## ShowMe: 注釈を消す（`ShowMe: Show the operations log`）";
    expect(checkNames(wrong, "ja", src).join()).toMatch(
      /paired with "ShowMe: Show the operations log"/,
    );
    expect(checkNames("## ShowMe: 注釈を消す", "ja", src).join()).toMatch(/must be followed/);
  });

  it("斜体は照合できないと、斜体だと言って失敗する", () => {
    expect(checkNames("*ShowMe: Clear annotations*", "en", src).join()).toMatch(/italic/);
    expect(checkNames("_ShowMe: Clear annotations_", "en", src).join()).toMatch(/italic/);
  });
});

describe("コマンドの CLI", () => {
  const cli = path.join(root, "scripts", "docs", "readme-blocks.mjs");
  const copyRoot = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "readme blocks "));
    for (const rel of [
      "README.md",
      "README.ja.md",
      "packages/extension/package.json",
      "packages/extension/package.nls.json",
      "packages/extension/package.nls.ja.json",
      "packages/extension/l10n/bundle.l10n.ja.json",
      "scripts/docs/command-descriptions.json",
    ]) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.copyFileSync(path.join(root, rel), path.join(dir, rel));
    }
    return dir;
  };
  const run = (dir: string, mode: string) =>
    spawnSync(process.execPath, [cli, mode, "--root", dir], { encoding: "utf8" });

  it("--check: きれいなら 0、ずれていれば 0 以外で、どこがずれたかを言う", () => {
    const dir = copyRoot();
    const clean = run(dir, "--check");
    expect(clean.status, clean.stderr).toBe(0);
    const en = path.join(dir, "README.md");
    fs.writeFileSync(
      en,
      fs.readFileSync(en, "utf8").replace("Remove all of the agent's annotations.", "Remove it."),
    );
    const drift = run(dir, "--check");
    expect(drift.status).not.toBe(0);
    expect(drift.stderr).toMatch(/README\.md: generated region "commands"/);
    expect(drift.stderr).toMatch(/behind README\.md.*"Commands"|region "commands"/s);
  });

  it("--write と --stamp はその root の README を LF で書き直し、--check が通る", () => {
    const dir = copyRoot();
    for (const name of ["README.md", "README.ja.md"]) {
      const p = path.join(dir, name);
      fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(/\n/g, "\r\n"));
    }
    expect(run(dir, "--write").status).toBe(0);
    expect(run(dir, "--stamp").status).toBe(0);
    expect(fs.readFileSync(path.join(dir, "README.md"), "utf8")).toBe(readme("README.md"));
    expect(fs.readFileSync(path.join(dir, "README.ja.md"), "utf8")).toBe(readme("README.ja.md"));
    expect(run(dir, "--check").status).toBe(0);
  });

  it("使い方の誤りは 2", () => {
    expect(run(copyRoot(), "--nope").status).toBe(2);
  });
});

describe("この repo の README", () => {
  it("生成範囲・名前・構造・訳の印が、今の宣言と英語版に合っている（npm run docs:check と同じ判定）", () => {
    const errors = checkAll({ en: readme("README.md"), ja: readme("README.ja.md") }, src);
    expect(errors).toEqual([]);
  });
});
