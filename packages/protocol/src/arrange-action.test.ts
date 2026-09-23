import { describe, expect, it } from "vitest";
import { ARRANGE_ACTIONS, arrangeActionCloses, arrangeActionMoves } from "./arrange-action.js";
import {
  ARRANGE_WITHHELD_REASONS,
  arrangeEditorsArgsSchema,
  arrangeEditorsResultSchema,
} from "./wire.js";

describe("arrange_editors の語彙（設計 D42）", () => {
  it("語彙にコマンド名が混ざっていない", () => {
    // 語彙は「どうしたいか」であって VS Code のコマンド名ではない（D36/D42）。
    // ドットを含む値が混じったら、それは対応づけの層を素通りさせている。
    for (const action of ARRANGE_ACTIONS) {
      expect(action, `${action} はコマンド名に見える`).not.toContain(".");
    }
  });

  it("重複が無い", () => {
    expect(new Set(ARRANGE_ACTIONS).size).toBe(ARRANGE_ACTIONS.length);
  });

  it("閉じうるのは close-own / close-other-tabs / close-tabs だけ", () => {
    // **全語に当てる。** 「3つが true」だけを見ていると、レイアウトの語に
    // true を足しても緑のままになる。
    for (const action of ARRANGE_ACTIONS) {
      expect(arrangeActionCloses(action), action).toBe(
        action === "close-own" || action === "close-other-tabs" || action === "close-tabs",
      );
    }
  });

  it("close-tabs は語彙にある。close-all は無い（何でも消せる設定と組む語はパスで指すものだけ）", () => {
    expect(ARRANGE_ACTIONS).toContain("close-tabs");
    // `close-all` は列の裏のターミナルや他拡張のパネルまで消える。パスの無いタブは
    // 指せない、が構造であって、「全部」の語を置いた瞬間にその構造が消える。
    expect(ARRANGE_ACTIONS as readonly string[]).not.toContain("close-all");
    expect(ARRANGE_ACTIONS as readonly string[]).not.toContain("close-except");
    expect(arrangeEditorsArgsSchema.safeParse({ action: "close-all" }).success).toBe(false);
  });

  it("動かすのは move-tab / move-panel / gather-own だけ（閉じる語と重ならない）", () => {
    // **全語に当てる。** 語を足したときに、閉じる側と動かす側の両方に true が
    // 立つ語や、どちらにも属さない語が黙って混ざらないようにする。
    for (const action of ARRANGE_ACTIONS) {
      expect(arrangeActionMoves(action), action).toBe(
        action === "move-tab" || action === "move-panel" || action === "gather-own",
      );
      expect(arrangeActionCloses(action) && arrangeActionMoves(action), action).toBe(false);
    }
  });

  it("single-column は語彙に無い（D55-1: 名前が「画面全体を1列に」を約束し、人間の列を必ず巻き込む）", () => {
    expect(ARRANGE_ACTIONS as readonly string[]).not.toContain("single-column");
    // 落ちる理由まで見る ―― 周りの形のせいではなく、語彙の外だから落ちる。
    // 陽性の対照: 同じ形で `two-columns` は通る。
    expect(arrangeEditorsArgsSchema.safeParse({ action: "two-columns" }).success).toBe(true);
    const result = arrangeEditorsArgsSchema.safeParse({ action: "single-column" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join("."))).toEqual(["action"]);
      expect(result.error.issues[0]?.code).toBe("invalid_enum_value");
    }
  });

  it("語彙の中は通る", () => {
    for (const action of ARRANGE_ACTIONS) {
      expect(arrangeEditorsArgsSchema.safeParse({ action }).success, action).toBe(true);
    }
  });

  it("move-tab は path と toColumn を、move-panel は toColumn を受ける（スキーマは plain object のまま）", () => {
    // 「move-tab には path と toColumn が要る」は**ハンドラ**が1回だけ判定する
    // （transform にすると線の両端で二重に parse する形になる）。スキーマは鍵の形だけを見る。
    expect(
      arrangeEditorsArgsSchema.safeParse({ action: "move-tab", path: "src/a.ts", toColumn: 2 })
        .success,
    ).toBe(true);
    expect(arrangeEditorsArgsSchema.safeParse({ action: "move-panel", toColumn: 3 }).success).toBe(
      true,
    );
    // `.shape` を持つこと ―― MCP SDK は ZodObject しか広告できない。
    expect(typeof arrangeEditorsArgsSchema.shape).toBe("object");
    expect(Object.keys(arrangeEditorsArgsSchema.shape).sort()).toEqual([
      "action",
      "path",
      "paths",
      "slot",
      "toColumn",
    ]);
  });

  it("toColumn は 1〜9 の整数、path は 1〜1024 文字", () => {
    for (const bad of [0, -1, 10, 1.5, "2"]) {
      const result = arrangeEditorsArgsSchema.safeParse({
        action: "move-panel",
        toColumn: bad,
      });
      expect(result.success, String(bad)).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.map((issue) => issue.path.join(".")),
          String(bad),
        ).toEqual(["toColumn"]);
      }
    }
    for (const good of [1, 9]) {
      expect(
        arrangeEditorsArgsSchema.safeParse({ action: "move-panel", toColumn: good }).success,
        String(good),
      ).toBe(true);
    }
    expect(
      arrangeEditorsArgsSchema.safeParse({ action: "move-tab", path: "", toColumn: 1 }).success,
    ).toBe(false);
    expect(
      arrangeEditorsArgsSchema.safeParse({
        action: "move-tab",
        path: "a".repeat(1025),
        toColumn: 1,
      }).success,
    ).toBe(false);
    expect(
      arrangeEditorsArgsSchema.safeParse({
        action: "move-tab",
        path: "a".repeat(1024),
        toColumn: 1,
      }).success,
    ).toBe(true);
  });

  it("語彙の外は落ち、しかも落ちる理由が action である", () => {
    // **陰性の検査は、意図した理由で落ちること**まで見る。
    // 周りの形が間違っているせいで落ちていると、語彙が開いていても緑になる。
    // まず陽性の対照 ―― この形そのものは通る。
    expect(arrangeEditorsArgsSchema.safeParse({ action: "two-columns" }).success).toBe(true);

    for (const bad of [
      "workbench.action.closeAllEditors",
      "workbench.action.files.delete",
      "workbench.action.editorLayoutSingle",
      "",
      "close-own; rm -rf /",
      "close_own",
      "CLOSE-OWN",
    ]) {
      const result = arrangeEditorsArgsSchema.safeParse({ action: bad });
      expect(result.success, `${bad} が通った`).toBe(false);
      if (result.success) continue;
      // 落ちた指摘は**すべて** action のものであること。
      expect(
        result.error.issues.map((issue) => issue.path.join(".")),
        `${bad} が action 以外の理由で落ちている`,
      ).toEqual(["action"]);
      expect(result.error.issues[0]?.code).toBe("invalid_enum_value");
    }
  });

  it("余分な鍵は落ちる（strict）", () => {
    // 陽性の対照つき ―― `command` を外せば通る形であることを見せる。
    expect(arrangeEditorsArgsSchema.safeParse({ action: "two-columns" }).success).toBe(true);
    const result = arrangeEditorsArgsSchema.safeParse({
      action: "two-columns",
      command: "workbench.action.closeAllEditors",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.code).toBe("unrecognized_keys");
    }
  });

  it("action は必須（省略できない）", () => {
    expect(arrangeEditorsArgsSchema.safeParse({}).success).toBe(false);
  });
});

describe("arrange_editors の結果（何枚断ったかは返さない）", () => {
  it("閉じた数と断った理由を返せる", () => {
    expect(arrangeEditorsResultSchema.safeParse({ done: true, closed: 0 }).success).toBe(true);
    expect(
      arrangeEditorsResultSchema.safeParse({
        done: true,
        closed: 3,
        withheld: ["human-tabs-not-allowed", "dirty-tabs-not-allowed"],
      }).success,
    ).toBe(true);
  });

  it("断った理由は閉じた語彙（自由文字列にしない）", () => {
    // 自由文字列にすると、理由に中身を詰める経路が開く。
    for (const bad of [
      "human tabs not allowed",
      "1 tab is /home/me/secret.txt",
      "human-tabs-not-allowed ",
    ]) {
      expect(
        arrangeEditorsResultSchema.safeParse({ done: true, closed: 0, withheld: [bad] }).success,
        `${bad} が通った`,
      ).toBe(false);
    }
    // 陽性の対照 ―― 語彙の中なら同じ形が通る。
    for (const reason of ARRANGE_WITHHELD_REASONS) {
      expect(
        arrangeEditorsResultSchema.safeParse({ done: true, closed: 0, withheld: [reason] }).success,
        reason,
      ).toBe(true);
    }
  });

  it("断った枚数を返す鍵を足せない（人間のタブを数える口を作らない）", () => {
    // **「何枚断ったか」は返さない**（設計 D51 の周辺）。返すと、設定で
    // 塞いだはずの「人間のタブが何枚あるか」を数え上げる口になる。
    for (const leaky of [
      { done: true, closed: 0, withheldCount: 7 },
      { done: true, closed: 0, refused: 7 },
      { done: true, closed: 0, humanTabs: 7 },
      { done: true, closed: 0, paths: ["a.ts"] },
    ]) {
      expect(arrangeEditorsResultSchema.safeParse(leaky).success, JSON.stringify(leaky)).toBe(
        false,
      );
    }
  });

  it("moved は任意で、0 以上の整数（実際に動かした枚数。D59）", () => {
    expect(arrangeEditorsResultSchema.safeParse({ done: true, closed: 0, moved: 2 }).success).toBe(
      true,
    );
    expect(arrangeEditorsResultSchema.safeParse({ done: true, closed: 0, moved: -1 }).success).toBe(
      false,
    );
    expect(
      arrangeEditorsResultSchema.safeParse({ done: true, closed: 0, moved: 1.5 }).success,
    ).toBe(false);
  });

  it("closed は 0 以上の整数", () => {
    expect(arrangeEditorsResultSchema.safeParse({ done: true, closed: -1 }).success).toBe(false);
    expect(arrangeEditorsResultSchema.safeParse({ done: true, closed: 1.5 }).success).toBe(false);
    expect(arrangeEditorsResultSchema.safeParse({ done: true }).success).toBe(false);
  });

  it("withheld は語彙の数を超えられない", () => {
    // **語彙の数から作る。** 定数で3つ並べていたら、語を1つ足した時点で
    // 「上限ちょうど」になって通り、この検査は黙って空振りする（実際にそうなった）。
    const tooMany = [...ARRANGE_WITHHELD_REASONS, ARRANGE_WITHHELD_REASONS[0]];
    expect(tooMany.length).toBe(ARRANGE_WITHHELD_REASONS.length + 1);
    expect(
      arrangeEditorsResultSchema.safeParse({ done: true, closed: 0, withheld: tooMany }).success,
    ).toBe(false);
    // 陽性の対照 ―― 語彙の数ちょうどなら通る。
    expect(
      arrangeEditorsResultSchema.safeParse({
        done: true,
        closed: 0,
        withheld: [...ARRANGE_WITHHELD_REASONS],
      }).success,
    ).toBe(true);
  });

  it("viewing-tab は語彙にある（床1 の断りを無言にしない。増分5 §C1）", () => {
    expect(ARRANGE_WITHHELD_REASONS).toContain("viewing-tab");
  });

  it("human-column-target は語彙にある（人間の列への移動の断りを無言にしない。増分5 D59）", () => {
    // 無いと、`move-tab` が人間の列を断ったとき `done: false` しか言えず、エージェントは
    // 「列番号が悪い」と「人間の列を守った」を区別できない。
    expect(ARRANGE_WITHHELD_REASONS).toContain("human-column-target");
  });

  it("human-column-would-merge は語彙にある（プリセットの断りを無言にしない。増分5 §C3 / D55-2）", () => {
    // 無いと、ハンドラは `done: false` しか言えず、エージェントは「コマンドが無かった」と
    // 「人間の列を守った」を区別できない ―― 同じ操作を呼び続ける。
    expect(ARRANGE_WITHHELD_REASONS).toContain("human-column-would-merge");
  });
});
