import { readFileSync } from "node:fs";
import {
  DEFAULT_PANEL_LIMIT,
  DEFAULT_REDACTED_PATTERNS,
  MAX_PANEL_SLOT,
} from "@zvx/vscode-showme-protocol";
import { describe, expect, it } from "vitest";
import {
  type InspectResult,
  editorGroupOr,
  mergeRedactedPatterns,
  panelLimitOr,
  pickTrustedValue,
  stringArrayOr,
} from "../src/config.js";

function inspect<T>(over: Partial<InspectResult<T>>): InspectResult<T> {
  return {
    defaultValue: undefined,
    globalValue: undefined,
    workspaceValue: undefined,
    workspaceFolderValue: undefined,
    ...over,
  };
}

describe("pickTrustedValue", () => {
  it("ユーザ設定を採る", () => {
    expect(pickTrustedValue(inspect({ defaultValue: "dedicated", globalValue: "active" }))).toBe(
      "active",
    );
  });

  it("ユーザ設定が無ければ既定値を採る", () => {
    expect(pickTrustedValue(inspect({ defaultValue: "dedicated" }))).toBe("dedicated");
  });

  it("ワークスペース設定を無視する（主敵が .vscode/settings.json を書ける）", () => {
    expect(pickTrustedValue(inspect({ defaultValue: "dedicated", workspaceValue: "active" }))).toBe(
      "dedicated",
    );
  });

  it("ワークスペースフォルダ設定も無視する", () => {
    expect(
      pickTrustedValue(inspect({ defaultValue: "dedicated", workspaceFolderValue: "active" })),
    ).toBe("dedicated");
  });

  it("ユーザ設定があってもワークスペース設定に上書きされない", () => {
    expect(
      pickTrustedValue(
        inspect({ defaultValue: "dedicated", globalValue: "dedicated", workspaceValue: "active" }),
      ),
    ).toBe("dedicated");
  });

  it("ワークスペース設定とワークスペースフォルダ設定が両方あり、ユーザ設定が無くても既定値を採る", () => {
    // 主敵は .vscode/settings.json （workspaceValue）だけでなく、複数フォルダ
    // ワークスペースの .vscode/settings.json（workspaceFolderValue）にも書ける。
    // 片方だけでなく両方を同時に無視できているかを確かめる。
    expect(
      pickTrustedValue(
        inspect({
          defaultValue: "dedicated",
          workspaceValue: "active",
          workspaceFolderValue: "active",
        }),
      ),
    ).toBe("dedicated");
  });
});

describe("mergeRedactedPatterns", () => {
  it("加算専用: 利用者が空配列を設定しても既定リストが残る", () => {
    expect(mergeRedactedPatterns([])).toEqual(DEFAULT_REDACTED_PATTERNS);
  });

  it("利用者の追加パターンは既定リストに足される（既定は取り除けない）", () => {
    expect(mergeRedactedPatterns(["secrets/**"])).toEqual([
      ...DEFAULT_REDACTED_PATTERNS,
      "secrets/**",
    ]);
  });
});

describe("showme.layout.* はワークスペースから読まない（不変条件9 / 設計 §7）", () => {
  // arrange_editors の許可は、この道具で唯一「見せる」を越える操作の鍵である。
  // **主敵は読ませている OSS そのもの**で、そこには .vscode/settings.json が
  // あり、closeDirtyTabs: true を置けたらこの設計は意味を失う（人間の未保存が
  // 消える）。読み口は既存の trusted() ＝ pickTrustedValue 1本に固定してある
  // ので、ここで pickTrustedValue の性質を釘で打つ。
  it("workspaceValue を無視する", () => {
    expect(pickTrustedValue<boolean>(inspect({ defaultValue: false, workspaceValue: true }))).toBe(
      false,
    );
    expect(
      pickTrustedValue<boolean>(
        inspect({ defaultValue: false, workspaceValue: true, workspaceFolderValue: true }),
      ),
    ).toBe(false);
  });

  it("workspaceFolderValue だけでも無視する", () => {
    expect(
      pickTrustedValue<boolean>(inspect({ defaultValue: false, workspaceFolderValue: true })),
    ).toBe(false);
  });

  it("globalValue が true でもワークスペースが false に落とせない（向きが逆でも効く）", () => {
    // 危ない向き（false → true）だけを見ていると、ワークスペースが
    // 「読まれてはいるが今回はたまたま安全側」な実装を見逃す。
    expect(
      pickTrustedValue<boolean>(
        inspect({ defaultValue: false, globalValue: true, workspaceValue: false }),
      ),
    ).toBe(true);
  });

  it("globalValue は効く", () => {
    expect(pickTrustedValue<boolean>(inspect({ defaultValue: false, globalValue: true }))).toBe(
      true,
    );
  });

  it("どちらも既定は false", () => {
    // 「安全でない側が既定」を作らない。
    expect(pickTrustedValue<boolean>(inspect({ defaultValue: false }))).toBe(false);
    expect(pickTrustedValue<boolean>(inspect({}))).toBeUndefined();
  });
});

describe("showme.{stage,html,layout}.enabled はワークスペースから読まない（増分6 D74 / 不変条件9）", () => {
  // 3つとも安全に関わる（layout は人間のタブに触る、html は webview を出す、stage は
  // タブを開く）。既定が true なので、ワークスペース値が効くとしたら「戻す」向き
  // （人間が global で切ったものを、読ませている OSS が true に戻す）である。
  // 読み口は `trusted()` ＝ `pickTrustedValue` 1本なので、その向きを釘で打つ。
  for (const key of ["showme.stage.enabled", "showme.html.enabled", "showme.layout.enabled"]) {
    it(`${key}: global が false なら workspaceValue: true で戻せない`, () => {
      expect(
        pickTrustedValue<boolean>(
          inspect({ defaultValue: true, globalValue: false, workspaceValue: true }),
        ),
      ).toBe(false);
      expect(
        pickTrustedValue<boolean>(
          inspect({ defaultValue: true, globalValue: false, workspaceFolderValue: true }),
        ),
      ).toBe(false);
    });
    it(`${key}: global が無くても workspaceValue: false は読まない（向きが逆でも効く）`, () => {
      expect(
        pickTrustedValue<boolean>(inspect({ defaultValue: true, workspaceValue: false })),
      ).toBe(true);
    });
  }
});

describe("readConfig の既定（package.json の宣言と一致すること）", () => {
  // readConfig() 自体は vscode モジュールを要るので単体では呼べない。
  // ここでは「宣言」の側 ―― package.json ―― を直接読み、
  // 既定 false / scope: machine / restrictedConfigurations 入りを確かめる。
  // 同じ量（既定値）を code と package.json の2箇所で決めているので、
  // 少なくとも一致していることを検査で結ぶ（不変条件14）。
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as {
    capabilities: { untrustedWorkspaces: { restrictedConfigurations: string[] } };
    contributes: {
      configuration: {
        properties: Record<string, { type: string; default: unknown; scope: string }>;
      };
    };
  };
  const keys = ["showme.layout.closeHumanTabs", "showme.layout.closeDirtyTabs"] as const;

  for (const key of keys) {
    it(`${key} は boolean / 既定 false / scope: machine で宣言されている`, () => {
      const prop = manifest.contributes.configuration.properties[key];
      expect(prop).toBeDefined();
      expect(prop?.type).toBe("boolean");
      expect(prop?.default).toBe(false);
      expect(prop?.scope).toBe("machine");
    });

    it(`${key} は restrictedConfigurations に入っている`, () => {
      expect(manifest.capabilities.untrustedWorkspaces.restrictedConfigurations).toContain(key);
    });
  }

  /** 増分6 D74: 3機能の `enabled`。既定 true、machine。 */
  const featureKeys = ["showme.stage.enabled", "showme.html.enabled", "showme.layout.enabled"];
  for (const key of featureKeys) {
    it(`${key} は boolean / 既定 true / scope: machine で宣言されている`, () => {
      const prop = manifest.contributes.configuration.properties[key];
      expect(prop).toBeDefined();
      expect(prop?.type).toBe("boolean");
      expect(prop?.default).toBe(true);
      expect(prop?.scope).toBe("machine");
    });
    it(`${key} は restrictedConfigurations に入っている`, () => {
      expect(manifest.capabilities.untrustedWorkspaces.restrictedConfigurations).toContain(key);
    });
  }

  it("showme.stage.editorGroup が dedicated / active の enum で宣言され、showme.editorGroup は無い（D74）", () => {
    const prop = manifest.contributes.configuration.properties["showme.stage.editorGroup"] as
      | { enum?: unknown; default?: unknown; scope?: unknown }
      | undefined;
    expect(prop).toBeDefined();
    expect(prop?.enum).toEqual(["dedicated", "active"]);
    expect(prop?.default).toBe("dedicated");
    expect(prop?.scope).toBe("machine");
    expect(manifest.contributes.configuration.properties["showme.editorGroup"]).toBeUndefined();
  });

  /**
   * `showme.html.maxPanels`（増分6.2 D80）。**整数1つ**（0〜999。`0` は無制限）、既定 2、machine。
   * `anyOf`（整数 | `"unlimited"`）は VS Code の設定画面が描けず「settings.json で編集」の
   * リンクになる。`type: "integer"` だけなら入力欄が出る。
   * 上限は人間の作業面を守る量なので、`restrictedConfigurations` にも入れる（走査が見る）。
   */
  it("showme.html.maxPanels は整数 0〜999 / 既定 2 / scope: machine で宣言されている（anyOf ではない。D80）", () => {
    const prop = manifest.contributes.configuration.properties["showme.html.maxPanels"] as
      | {
          type?: unknown;
          minimum?: unknown;
          maximum?: unknown;
          anyOf?: unknown;
          enum?: unknown;
          default?: unknown;
          scope?: unknown;
          description?: unknown;
        }
      | undefined;
    expect(prop).toBeDefined();
    expect(prop?.type).toBe("integer");
    expect(prop?.minimum).toBe(0);
    expect(prop?.maximum).toBe(MAX_PANEL_SLOT);
    expect(prop?.default).toBe(DEFAULT_PANEL_LIMIT);
    expect(prop?.default).toBe(2);
    expect(prop?.scope).toBe("machine");
    expect(prop?.description).toBe("%showme.config.html.maxPanels%");
    // 設定画面に入力欄を出すため、複合型に戻さない。
    expect(prop?.anyOf).toBeUndefined();
    expect(prop?.enum).toBeUndefined();
  });

  it("showme.tools.disabled は宣言から消えている（D74: 同じ量を2つの設定で決めない）", () => {
    expect(manifest.contributes.configuration.properties["showme.tools.disabled"]).toBeUndefined();
    expect(manifest.capabilities.untrustedWorkspaces.restrictedConfigurations).not.toContain(
      "showme.tools.disabled",
    );
  });

  /**
   * **`readConfig` が読む鍵の集合 ＝ `package.json` が宣言する鍵の集合**（D74 の走査）。
   *
   * 片方にだけ残った鍵（消し忘れた `showme.tools.disabled`、足し忘れた
   * `showme.html.enabled`）は、型でも lint でも見つからない ―― 宣言だけの鍵は
   * Settings UI に出るが効かず、読むだけの鍵は UI に無い。ソースの `trusted<…>("showme.…")`
   * を走査して突き合わせる。`inspect()` を `trusted()` 以外で呼ばないこと（不変条件9）は
   * 同じ走査で見る。
   */
  it("readConfig が trusted() で読む鍵の集合が package.json の宣言と一致する", () => {
    const source = readFileSync(new URL("../src/config.ts", import.meta.url), "utf8");
    const read = [...source.matchAll(/trusted<[^>]+>\("(showme\.[^"]+)"\)/g)].map((m) => m[1]);
    expect(read.length).toBeGreaterThanOrEqual(12);
    // 同じ鍵を2回読まない（2回読むなら別の場所で別の答えになりうる）。
    expect(new Set(read).size).toBe(read.length);
    const declared = Object.keys(manifest.contributes.configuration.properties);
    expect([...read].sort()).toEqual([...declared].sort());
    // 宣言した鍵は全部 restrictedConfigurations にも入っている。
    expect([...manifest.capabilities.untrustedWorkspaces.restrictedConfigurations].sort()).toEqual(
      [...declared].sort(),
    );
    // `inspect(` の呼び出しは `trusted()` の中の1箇所だけ。
    expect(source.match(/\.inspect</g)?.length).toBe(1);
    // `getConfiguration(` も同じ1箇所だけ ―― 宣言していない鍵を `.get()` で読む
    // 口は、上の走査（`trusted<…>("showme.…")`）に映らない。
    expect(source.match(/getConfiguration\(/g)?.length).toBe(1);
    // `trusted` の出現は「定義1 ＋ 型付きの読み出し N」。型を付けずに
    // `trusted("…")` と書いた読み出しは走査に映らないので、数で捕まえる
    // （コメントの中の `trusted()` は数えない）。
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code.match(/\btrusted\s*[<(]/g)?.length).toBe(read.length + 1);
  });
});

describe("設定の値を型で守る（読む場所で型を揃える）", () => {
  it("配列でない redactedPathPatterns は fallback として読む", () => {
    expect(stringArrayOr("secrets/**", [])).toEqual([]);
    expect(stringArrayOr(["secrets/**", 3], [])).toEqual([]);
    expect(stringArrayOr(undefined, ["x"])).toEqual(["x"]);
    // 肯定対照: 正しい配列はそのまま。
    expect(stringArrayOr(["a/**", "b/**"], [])).toEqual(["a/**", "b/**"]);
  });
  it("editorGroup は dedicated / active 以外を dedicated に倒す（既定は安全側）", () => {
    expect(editorGroupOr("Active")).toBe("dedicated");
    expect(editorGroupOr(undefined)).toBe("dedicated");
    expect(editorGroupOr("active")).toBe("active");
  });

  /**
   * `showme.html.maxPanels`（増分6.2 D80）。`inspect<T>()` は宣言した型を信じるだけなので、
   * settings.json に `"3"` や `2.5` や `"unlimited"` が書かれていても `T` で返る。読む場所で
   * 型を揃え、形の外れた値は**既定（2）に倒す**（緩める向きには倒さない）。
   *
   * 設定は整数1つで `0` が無制限。線上の語彙 `number | "unlimited"`（`panelLimitSchema`）に
   * 畳むのは `panelLimitOr` の1箇所 ―― `0` → `"unlimited"`、1〜999 → その数。
   * 文字列の `"unlimited"` は宣言が受けなくなったので**壊れた値**として既定に倒す。
   */
  it("html.maxPanels は整数 0〜999 だけを受け、0 は unlimited に畳み、それ以外は既定 2 に倒す（D80）", () => {
    // 肯定対照。
    expect(panelLimitOr(0, DEFAULT_PANEL_LIMIT)).toBe("unlimited");
    expect(panelLimitOr(1, DEFAULT_PANEL_LIMIT)).toBe(1);
    expect(panelLimitOr(2, DEFAULT_PANEL_LIMIT)).toBe(2);
    expect(panelLimitOr(5, DEFAULT_PANEL_LIMIT)).toBe(5);
    expect(panelLimitOr(MAX_PANEL_SLOT, DEFAULT_PANEL_LIMIT)).toBe(MAX_PANEL_SLOT);
    // 形の外れた値は既定。**unlimited には倒れない**（緩める向きに倒すと、壊れた設定で上限が消える）。
    for (const bad of [
      undefined,
      null,
      -1,
      -0.5,
      MAX_PANEL_SLOT + 1,
      2.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      "0",
      "3",
      "unlimited",
      "Unlimited",
      "UNLIMITED",
      " unlimited",
      "infinite",
      "",
      true,
      false,
      [],
      [0],
      {},
    ]) {
      expect(panelLimitOr(bad, DEFAULT_PANEL_LIMIT), String(bad)).toBe(DEFAULT_PANEL_LIMIT);
    }
    // 既定は引数で渡す（関数が 2 を別に持たない ―― 既定は `DEFAULT_PANEL_LIMIT` 1つ）。
    expect(panelLimitOr("3", 5)).toBe(5);
    expect(panelLimitOr("unlimited", 5)).toBe(5);
  });
});
