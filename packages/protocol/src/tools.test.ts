import { describe, expect, it } from "vitest";
import { ARRANGE_ACTIONS } from "./arrange-action.js";
import { TOOL_ANNOTATIONS, TOOL_DESCRIPTIONS, TOOL_NAMES, type ToolName } from "./tools.js";

describe("tool annotations", () => {
  it("全ツールが4つの注釈を明示的に持つ", () => {
    for (const name of Object.keys(TOOL_ANNOTATIONS) as ToolName[]) {
      const a = TOOL_ANNOTATIONS[name];
      expect(typeof a.readOnlyHint, `${name}.readOnlyHint`).toBe("boolean");
      expect(typeof a.destructiveHint, `${name}.destructiveHint`).toBe("boolean");
      expect(typeof a.idempotentHint, `${name}.idempotentHint`).toBe("boolean");
      expect(typeof a.openWorldHint, `${name}.openWorldHint`).toBe("boolean");
    }
  });

  it("どのツールもネットワークに触れない", () => {
    for (const name of Object.keys(TOOL_ANNOTATIONS) as ToolName[]) {
      expect(TOOL_ANNOTATIONS[name].openWorldHint, `${name} must not be open-world`).toBe(false);
    }
  });

  it("タブを閉じうるのは arrange_editors だけで、他は破壊的でない", () => {
    // **「どのツールも破壊的でない」とは書けなくなった**（増分4B）。
    // `arrange_editors` は人間のタブを閉じうるので、そこだけ true である。
    // 全部 false のまま回すと、新しい道具の申告が嘘になったことに誰も気づかない。
    for (const name of Object.keys(TOOL_ANNOTATIONS) as ToolName[]) {
      if (name === "arrange_editors") continue;
      expect(TOOL_ANNOTATIONS[name].destructiveHint, `${name} must not be destructive`).toBe(false);
    }
  });

  it("arrange_editors は destructiveHint: true（既定が安全でも、できることを申告する）", () => {
    // 注釈は**その道具に何ができるか**を書くものであって、既定で何が起きるかでは
    // ない。既定（設定2つとも false）では自分のパネルしか閉じないが、
    // `closeHumanTabs` を立てた人間の画面では人間のタブが閉じる。
    // 「既定は安全だから」と false にすると、設定を立てた人の画面での実態を
    // 隠すことになる。
    expect(TOOL_ANNOTATIONS.arrange_editors.destructiveHint).toBe(true);
    // 画面を変えるので読み取り専用でもない。
    expect(TOOL_ANNOTATIONS.arrange_editors.readOnlyHint).toBe(false);
  });

  it("arrange_editors の idempotentHint: true が語彙の全語で真である", () => {
    // `show_view` は `toggle-*` を7つ足した時点で「繰り返しても結果は同じ」が
    // 語彙の一部にしか当たらなくなり、true が嘘になった（宣言を直した）。
    // 同じ取り違えを繰り返さないために、**語彙の側から**根拠を検査する:
    // 8語はすべて「こうなっていてほしい終状態」を名指しており、反転する語が無い。
    expect(TOOL_ANNOTATIONS.arrange_editors.idempotentHint).toBe(true);
    for (const action of ARRANGE_ACTIONS) {
      expect(action.startsWith("toggle-"), `${action} は反転する語に見える`).toBe(false);
    }
  });

  it("arrange_editors がツール一覧にある", () => {
    expect(TOOL_NAMES as readonly string[]).toContain("arrange_editors");
    expect(TOOL_DESCRIPTIONS.arrange_editors.length).toBeGreaterThan(0);
    expect(TOOL_ANNOTATIONS.arrange_editors).toBeDefined();
  });

  it("arrange_editors の説明が「既定では自分のものしか閉じない」と言っている", () => {
    // 書いていないと、エージェントは `closed: 0` を故障だと読んで、
    // 同じ呼び出しを繰り返すか、別の手を探しに行く。
    // **名前ではなく値を主張する**（部分一致は違う理由で通る）。
    expect(TOOL_DESCRIPTIONS.arrange_editors).toContain(
      "By default only your own things are closed",
    );
    // 「呼べた＝許された」と読まれないよう、決めているのが人間側の設定だと書く。
    expect(TOOL_DESCRIPTIONS.arrange_editors).toContain("showme.layout.closeHumanTabs");
  });

  it("arrange_editors の説明が close-own の範囲と床を言っている（増分5 D53 / §C1）", () => {
    // 「パネル」だけと書いてあると、エージェントは自分が開いたファイルを
    // 片づけられないと思い込む（実際に「片づけて」で起きた。所見 2026-09-12）。
    expect(TOOL_DESCRIPTIONS.arrange_editors).toContain("it opened via show_code");
    // 床は設定で外れない ―― 書いていないと、viewing-tab を見たエージェントが
    // 人間に設定を頼み、立ててもまた断られる。
    expect(TOOL_DESCRIPTIONS.arrange_editors).toContain(
      "The tab the human is viewing and unsaved tabs are never closed, under any setting",
    );
    expect(TOOL_DESCRIPTIONS.arrange_editors).toContain("viewing-tab");
    expect(TOOL_DESCRIPTIONS.arrange_editors).not.toContain("close-own-panels");
  });

  it("arrange_editors の説明が close-tabs の規則（パスで指す・同じ床・notOpen）を言っている", () => {
    // 書いていないと、エージェントは「これとこれを閉じて」に `close-other-tabs` を当てて
    // 各列の非アクティブしか消えず、意図に届かない（実機所見 2026-09-14）。
    expect(TOOL_DESCRIPTIONS.arrange_editors).toContain(
      "close-tabs closes exactly the listed tabs",
    );
    expect(TOOL_DESCRIPTIONS.arrange_editors).toContain("notOpen");
    // 語彙の列挙にも載る（載っていないと、説明の途中で初めて出てくる語になる）。
    expect(TOOL_DESCRIPTIONS.arrange_editors).toContain("close-other-tabs / close-tabs / move-tab");
    // 「全部閉じる」を約束する語は無い。
    expect(TOOL_DESCRIPTIONS.arrange_editors).not.toContain("close-all");
  });

  it("arrange_editors の説明が「列を減らす操作は人間の列が巻き込まれるなら断る」と言っている（増分5 §C3 / D55-2）", () => {
    // 書いていないと、`done: false` を見たエージェントは故障だと読んで呼び直す。
    // **名前ではなく値を主張する**（部分一致は違う理由で通る）。
    expect(TOOL_DESCRIPTIONS.arrange_editors).toContain(
      "Operations that reduce the number of columns are refused if the human's column would be caught up in it",
    );
    expect(TOOL_DESCRIPTIONS.arrange_editors).toContain("human-column-would-merge");
    // single-column は語彙から消えた（D55-1）。説明に残っていると、
    // エージェントは無い語を呼んで invalid_enum_value を見る。
    expect(TOOL_DESCRIPTIONS.arrange_editors).not.toContain("single-column");
  });

  it("arrange_editors の説明が move-tab / move-panel / gather-own と、人間の列への移動の断りを言っている（増分5 D59 / D55-1）", () => {
    // 語彙に足しただけでは、エージェントは「タブは動かせない」と思い込む
    // （実地で「タブの移動も出来ないの？」と言われた。所見4c）。
    // **名前ではなく値を主張する**（部分一致は違う理由で通る）。
    expect(TOOL_DESCRIPTIONS.arrange_editors).toContain("move-tab takes path and toColumn");
    expect(TOOL_DESCRIPTIONS.arrange_editors).toContain("move-panel takes toColumn and slot");
    expect(TOOL_DESCRIPTIONS.arrange_editors).toContain(
      "gather-own collects your own tabs and panels",
    );
    // 人間の列への移動は既定で断る。理由を書いていないと呼び直す。
    expect(TOOL_DESCRIPTIONS.arrange_editors).toContain("human-column-target");
    // 「done: true は意図した列に入ったではない」―― 呼んだあと読み直す（D59 観測できないこと）。
    expect(TOOL_DESCRIPTIONS.arrange_editors).toContain(
      "Re-read with get_editor_state after calling",
    );
  });

  it("show_view の説明が toggle-* の非決定性を明記し show-* / hide-* を勧めている（増分5 D60）", () => {
    // 周辺 UI の可視状態は VS Code が公開しておらず、toggle-* は呼ぶと開くのか閉じるのか
    // 予測できない。書いていないと、エージェントは「今開いているか」を推測して toggle を叩く。
    // **名前ではなく値を主張する**（部分一致は違う理由で通る）。
    expect(TOOL_DESCRIPTIONS.show_view).toContain("flip the state on every call");
    expect(TOOL_DESCRIPTIONS.show_view).toContain("the current state is not observable");
    expect(TOOL_DESCRIPTIONS.show_view).toContain("when the intent is known, prefer show-*/hide-*");
  });

  it("annotate の説明が、色は行にも塗られ注釈と同じ寿命だと言い、location に色が無いと言う（増分6 D65 / D65'）", () => {
    // 塗りの持ち主が注釈になった（D65）。書いていないと、エージェントは対応する行を
    // `show_code` で同じ色に塗ろうとして、同じ位置を2回解決する。
    expect(TOOL_DESCRIPTIONS.annotate).toContain("painted on the line");
    expect(TOOL_DESCRIPTIONS.annotate).toContain("exactly as long as the annotation");
    expect(TOOL_DESCRIPTIONS.annotate).toContain("but without color");
    // 無印は灰で塗る（増分6.1 D78）。灰は語彙に無く、省略の結果としてだけ出る。
    expect(TOOL_DESCRIPTIONS.annotate).toContain(
      "omit it for the unmarked `ShowMe`, which is painted grey",
    );
    expect(TOOL_DESCRIPTIONS.annotate).not.toContain("matched to highlights by color");
  });

  it("stage を切ると show_code は印だけになることを、list_workspaces と show_code の両方の説明が言う（増分6 D76）", () => {
    // 書いていないと、エージェントは「開かなかった＝失敗」と読んで同じ位置を何度も呼ぶか、
    // 「開いた」つもりで人間に「今見えている箇所」を語る。
    expect(TOOL_DESCRIPTIONS.list_workspaces).toContain(
      "when off, show_code only marks lines without opening or scrolling, and show_note is refused",
    );
    expect(TOOL_DESCRIPTIONS.show_code).toContain("turned off showme.stage.enabled");
    expect(TOOL_DESCRIPTIONS.show_code).toContain("the file is not opened or scrolled");
    expect(TOOL_DESCRIPTIONS.show_code).toContain("list_workspaces.features.stage tells you");
  });

  it("パネルの上限は人間の設定であることを、list_workspaces と show_html の説明が言う（増分6.2 D80）", () => {
    // 書いていないと、エージェントは「2枚まで」（D61 の頃の文言）で止まるか、何枚まで
    // 出せるか分からずに断られてから知る。`list_workspaces.panels.max` が最初の知り方。
    expect(TOOL_DESCRIPTIONS.list_workspaces).toContain(
      'panels.max is how many show_html panels the human allows (a number, or "unlimited")',
    );
    expect(TOOL_DESCRIPTIONS.show_html).toContain("showme.html.maxPanels");
    expect(TOOL_DESCRIPTIONS.show_html).toContain("list_workspaces.panels.max");
    // 古い文言は残さない。
    expect(TOOL_DESCRIPTIONS.show_html).not.toContain("slot: 1 | 2");
    expect(TOOL_DESCRIPTIONS.show_html).not.toContain("There is no third");
  });

  it("annotate と get_editor_state の説明が、番号・id と annotations の観測面を言う（増分6 D69 / D71 / D72）", () => {
    // 書いていないと、エージェントは自分で本文に「1.」「2.」を書いて番号を2重にするか、
    // 出した注釈を数えるために本文を返せと言い出す。**名前ではなく値を主張する**。
    expect(TOOL_DESCRIPTIONS.annotate).toContain("gets an id (stable for this window)");
    expect(TOOL_DESCRIPTIONS.annotate).toContain("1-based reading order = the order of items");
    expect(TOOL_DESCRIPTIONS.annotate).toContain("when there are 2 or more annotations");
    expect(TOOL_DESCRIPTIONS.annotate).toContain("renumbers existing bubbles' denominators");
    expect(TOOL_DESCRIPTIONS.get_editor_state).toContain(
      "annotations lists the agent's own bubbles in reading order",
    );
    expect(TOOL_DESCRIPTIONS.get_editor_state).toContain(
      "resolved (true when the human has marked it resolved)",
    );
    expect(TOOL_DESCRIPTIONS.get_editor_state).toContain("Bodies are not returned");
  });

  it("表示を変えるツールに readOnlyHint: true と嘘をつかない", () => {
    expect(TOOL_ANNOTATIONS.show_code.readOnlyHint).toBe(false);
  });

  it("読み取り専用のツールには readOnlyHint: true を付ける（3クライアント横断で唯一効く注釈）", () => {
    expect(TOOL_ANNOTATIONS.list_workspaces.readOnlyHint).toBe(true);
  });

  it("ツール一覧と注釈の対象が一致している", () => {
    expect(new Set(TOOL_NAMES)).toEqual(new Set(Object.keys(TOOL_ANNOTATIONS)));
  });

  it("ツール一覧と説明の対象が一致している", () => {
    // 注釈だけを検査していると、説明を書き忘れたツールが undefined の説明で
    // 登録される（MCP の登録は落ちない）。エージェントには「説明の無い道具」に見える。
    expect(new Set(TOOL_NAMES)).toEqual(new Set(Object.keys(TOOL_DESCRIPTIONS)));
    for (const name of TOOL_NAMES) {
      expect(TOOL_DESCRIPTIONS[name].length, `${name} の説明が短すぎる`).toBeGreaterThan(20);
    }
  });

  it("人間の画面を読むだけのツールにも readOnlyHint: true を付ける", () => {
    expect(TOOL_ANNOTATIONS.get_editor_state.readOnlyHint).toBe(true);
  });

  it("注釈は画面を変えるので readOnlyHint: false", () => {
    expect(TOOL_ANNOTATIONS.annotate.readOnlyHint).toBe(false);
  });

  it("annotate に idempotentHint: true と嘘をつかない（add は呼ぶたびに増える）", () => {
    // 既定の `mode: "replace"` は冪等だが、注釈はツール全体に付くものであって
    // 引数ごとには付かない。`mode: "add"` を同じ引数で呼ぶと吹き出しは増えるので、
    // 「同じ引数で呼び直しても追加の効果は無い」は全ての呼び方では真でない。
    expect(TOOL_ANNOTATIONS.annotate.idempotentHint).toBe(false);
  });
});
