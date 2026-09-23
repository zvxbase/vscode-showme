import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * `package.json` の `%key%` と `package.nls.json` / `package.nls.ja.json` の対応を検査する。
 *
 * 人間向けの文字列は英語が既定で、`%key%` を両方の nls に置く（D58）。片方に鍵を
 * 足し忘れると VS Code は `%key%` の綴りをそのまま表示するだけで、赤くならない。
 * `.ts` 側の文字列は `t()` が守るが、宣言側の文字列はここでしか見ない。
 */
const read = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), "utf8")) as Record<
    string,
    unknown
  >;

interface MenuItem {
  command: string;
  when?: string;
  group?: string;
}

const manifest = read("package.json") as {
  contributes: {
    commands: { command: string; title: string; icon?: string }[];
    menus: Record<string, MenuItem[]>;
    configuration: { properties: Record<string, { description: string }> };
  };
};
const nlsEn = read("package.nls.json") as Record<string, string>;
const nlsJa = read("package.nls.ja.json") as Record<string, string>;

describe("package.nls（%key% が英日の両方で解決される）", () => {
  it("英日の nls は同じ鍵の集合を持つ", () => {
    expect(Object.keys(nlsJa).sort()).toEqual(Object.keys(nlsEn).sort());
  });

  it("nls の値はどれも空でなく、英日で異なる（写し忘れの判別）", () => {
    for (const [key, en] of Object.entries(nlsEn)) {
      expect(en, key).not.toBe("");
      expect(nlsJa[key], key).not.toBe("");
      expect(nlsJa[key], `${key} の日本語が英語と同じ`).not.toBe(en);
    }
  });

  /**
   * パレットから隠した命令（`menus.commandPalette` に `when: "false"`）。
   * 吹き出しのボタンのように**引数が要る**ものは、パレットから呼んでも何も
   * できないので隠す。隠した命令の title はボタンのツールチップなので "ShowMe:" を
   * 付けない（アイコンの横に出る短い動詞）。
   */
  const hiddenFromPalette = new Set(
    (manifest.contributes.menus.commandPalette ?? [])
      .filter((item) => item.when === "false")
      .map((item) => item.command),
  );

  it("contributes.commands の title は %key% で、両方の nls にある", () => {
    expect(manifest.contributes.commands.length).toBeGreaterThan(0);
    for (const { command, title } of manifest.contributes.commands) {
      const match = /^%(.+)%$/.exec(title);
      expect(match, `${command} の title が %key% でない: ${title}`).not.toBeNull();
      const key = match?.[1] ?? "";
      expect(nlsEn[key], `${key} が package.nls.json に無い`).toBeTypeOf("string");
      expect(nlsJa[key], `${key} が package.nls.ja.json に無い`).toBeTypeOf("string");
      if (hiddenFromPalette.has(command)) continue;
      // 命令名は人間がパレットで探す綴り。どちらの言語でも "ShowMe:" で始まる。
      expect(nlsEn[key]).toMatch(/^ShowMe: /);
      expect(nlsJa[key]).toMatch(/^ShowMe: /);
    }
  });

  it("contributes.menus が指す命令はどれも contributes.commands にある", () => {
    const ids = new Set(manifest.contributes.commands.map((c) => c.command));
    const menus = Object.entries(manifest.contributes.menus);
    expect(menus.length).toBeGreaterThan(0);
    for (const [menu, items] of menus) {
      expect(items.length, `${menu} が空`).toBeGreaterThan(0);
      for (const { command } of items) {
        expect(ids.has(command), `${menu} の ${command} が contributes.commands に無い`).toBe(true);
      }
    }
  });

  /**
   * 吹き出しのボタン（増分6 D70 の Resolve / Unresolve、増分6.1 D79 の ‹ Previous / Next ›）。
   * `comments/commentThread/title` のインラインボタンで、**自分の controller に限り**、
   * `contextValue`（`"<resolved|unresolved> <first|middle|last|only>"`。書くのは
   * `annotations.ts` の1関数）を正規表現で読んで、読了の片方と、端でない向きだけ出る。
   * 引数（スレッド）が要るので4つともパレットからは隠す ―― 起点の無い案内は嘘になる
   * （D73 のパレットの命令は撤回）。並びは ‹ › Resolve の順（`inline@n`）。
   */
  it("Resolve / Unresolve / Previous / Next は自分の controller の吹き出しにだけ出て、パレットには出ない（D70 / D79）", () => {
    const byId = new Map(manifest.contributes.commands.map((c) => [c.command, c]));
    expect(byId.get("showme.annotation.resolve")?.icon).toMatch(/^\$\(.+\)$/);
    expect(byId.get("showme.annotation.unresolve")?.icon).toMatch(/^\$\(.+\)$/);
    expect(byId.get("showme.annotation.previous")?.icon).toBe("$(arrow-left)");
    expect(byId.get("showme.annotation.next")?.icon).toBe("$(arrow-right)");
    expect(nlsEn["showme.command.annotation.resolve"]).toBe("Resolve");
    expect(nlsEn["showme.command.annotation.unresolve"]).toBe("Unresolve");
    expect(nlsEn["showme.command.annotation.previous"]).toBe("Previous annotation");
    expect(nlsEn["showme.command.annotation.next"]).toBe("Next annotation");

    const title = manifest.contributes.menus["comments/commentThread/title"] ?? [];
    const itemOf = (id: string): MenuItem | undefined => title.find((item) => item.command === id);
    expect(itemOf("showme.annotation.previous")).toEqual({
      command: "showme.annotation.previous",
      when: "commentController == showme.annotations && commentThread =~ /(middle|last)$/",
      group: "inline@1",
    });
    expect(itemOf("showme.annotation.next")).toEqual({
      command: "showme.annotation.next",
      when: "commentController == showme.annotations && commentThread =~ /(first|middle)$/",
      group: "inline@2",
    });
    expect(itemOf("showme.annotation.resolve")).toEqual({
      command: "showme.annotation.resolve",
      when: "commentController == showme.annotations && commentThread =~ /^unresolved/",
      group: "inline@3",
    });
    expect(itemOf("showme.annotation.unresolve")).toEqual({
      command: "showme.annotation.unresolve",
      when: "commentController == showme.annotations && commentThread =~ /^resolved/",
      group: "inline@3",
    });
    expect(title.map((item) => item.command).sort()).toEqual([
      "showme.annotation.next",
      "showme.annotation.previous",
      "showme.annotation.resolve",
      "showme.annotation.unresolve",
    ]);
    // 他の吹き出しメニュー（返信・編集・削除・リアクション）は宣言しない。
    expect(Object.keys(manifest.contributes.menus).sort()).toEqual([
      "commandPalette",
      "comments/commentThread/title",
    ]);
    expect(hiddenFromPalette).toEqual(
      new Set([
        "showme.annotation.resolve",
        "showme.annotation.unresolve",
        "showme.annotation.previous",
        "showme.annotation.next",
      ]),
    );
  });

  /**
   * `contextValue` の語彙と `when` の正規表現が同じ量を言っていることを、**両端で**確かめる。
   * 宣言側の正規表現を、ストアが書く形（`"<読了> <位置>"`）に実際に当てる ―― どちらかの
   * 綴りを変えれば、ここが赤になる（`when` は VS Code の中で黙って偽になるだけで、赤くならない）。
   */
  it("when の正規表現は contextValue の形に当たり、端の向きと読了の片方だけを通す", () => {
    const title = manifest.contributes.menus["comments/commentThread/title"] ?? [];
    const regexOf = (id: string): RegExp => {
      const when = title.find((item) => item.command === id)?.when ?? "";
      const m = /commentThread =~ \/(.+)\/$/.exec(when);
      expect(m, `${id} の when が commentThread =~ /…/ で終わらない: ${when}`).not.toBeNull();
      return new RegExp(m?.[1] ?? "(?!)");
    };
    const previous = regexOf("showme.annotation.previous");
    const next = regexOf("showme.annotation.next");
    const resolve = regexOf("showme.annotation.resolve");
    const unresolve = regexOf("showme.annotation.unresolve");
    const table: [string, { previous: boolean; next: boolean; resolve: boolean }][] = [
      ["unresolved only", { previous: false, next: false, resolve: true }],
      ["unresolved first", { previous: false, next: true, resolve: true }],
      ["unresolved middle", { previous: true, next: true, resolve: true }],
      ["unresolved last", { previous: true, next: false, resolve: true }],
      ["resolved only", { previous: false, next: false, resolve: false }],
      ["resolved first", { previous: false, next: true, resolve: false }],
      ["resolved middle", { previous: true, next: true, resolve: false }],
      ["resolved last", { previous: true, next: false, resolve: false }],
    ];
    for (const [value, want] of table) {
      expect(previous.test(value), `previous @ ${value}`).toBe(want.previous);
      expect(next.test(value), `next @ ${value}`).toBe(want.next);
      expect(resolve.test(value), `resolve @ ${value}`).toBe(want.resolve);
      expect(unresolve.test(value), `unresolve @ ${value}`).toBe(!want.resolve);
    }
  });

  it("contributes.configuration の description は %key% で、両方の nls にある", () => {
    const entries = Object.entries(manifest.contributes.configuration.properties);
    expect(entries.length).toBeGreaterThan(0);
    for (const [key, { description }] of entries) {
      const match = /^%(.+)%$/.exec(description);
      expect(match, `${key} の description が %key% でない: ${description}`).not.toBeNull();
      const nlsKey = match?.[1] ?? "";
      expect(nlsEn[nlsKey], `${nlsKey} が package.nls.json に無い`).toBeTypeOf("string");
      expect(nlsJa[nlsKey], `${nlsKey} が package.nls.ja.json に無い`).toBeTypeOf("string");
    }
  });

  /**
   * 人間向けの消す命令（増分6 D68）。`showme.enabled` や窓の役割で縛らない
   * （§C5: 設定が縛るのはエージェントであって人間ではない）。
   */
  it("Clear highlights / Clear annotations が宣言されている（D68）", () => {
    const ids = manifest.contributes.commands.map((c) => c.command);
    expect(ids).toContain("showme.clearHighlights");
    expect(ids).toContain("showme.clearAnnotations");
    expect(nlsEn["showme.command.clearHighlights"]).toBe("ShowMe: Clear highlights");
    expect(nlsEn["showme.command.clearAnnotations"]).toBe("ShowMe: Clear annotations");
  });
});
