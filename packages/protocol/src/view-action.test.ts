import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { VIEW_ACTIONS, viewActionNeedsPath } from "./view-action.js";

describe("show_view の語彙", () => {
  it("path が要る操作は reveal-in-explorer だけ", () => {
    for (const action of VIEW_ACTIONS) {
      expect(viewActionNeedsPath(action)).toBe(action === "reveal-in-explorer");
    }
  });

  it("語彙にコマンド名が混ざっていない", () => {
    // 語彙は「何をしたいか」であって、VS Code のコマンド名ではない（D36）。
    // ドットを含む値が混じったら、それは対応づけの層を素通りさせている。
    for (const action of VIEW_ACTIONS) {
      expect(action, `${action} はコマンド名に見える`).not.toContain(".");
    }
  });

  it("重複が無い", () => {
    expect(new Set(VIEW_ACTIONS).size).toBe(VIEW_ACTIONS.length);
  });
});

/**
 * **端末の新規作成と破棄を禁じる**（設計 D45）。
 *
 * 人間の判断:「ターミナルの新規作成・破棄は禁止にしましょうか。パネル開いて
 * ターミナル UI が手前にあってターミナルが起動しちゃうというのは許容します。」
 *
 * この区別を「同じことだ」と読まないこと。`workbench.action.terminal.*` の
 * 新規作成は**コマンドを実行できる面をエージェントが能動的に作る**ことで、
 * リング②（見せる）ではない。`togglePanel` で端末が手前に出るのは、パネルの
 * 可視性を変えた結果であって、そこに何があるかは人間の設定の結果である
 * ―― 攻撃者が制御できる量が違う。
 *
 * **禁止は「気をつける」ではなく、書かれていないことの検査にする。**
 * この repo は抽象則が効かないことを4回踏んでいる。
 *
 * 見る先は**出荷される側**（`src/`）である。統合テストは「語彙の外は落ちる」を
 * 見るために攻撃入力としてこの綴りを**持っている**ので、そこは見ない。
 */
describe("端末を起こす・殺すコマンドがコードベースに無い（D45）", () => {
  it("src/ に terminal.new / terminal.kill が1件も無い", () => {
    const roots = [
      path.resolve(__dirname, "../../extension/src"),
      path.resolve(__dirname, "../../bridge/src"),
      path.resolve(__dirname, "../src"),
    ];
    const offenders: string[] = [];
    // **接頭辞ごと禁じる。** 名指しの2つ（`new` / `kill`）だけを並べていると、
    // `workbench.action.terminal.split` のような**別の作り方**が素通りする
    // （split も端末を1本増やす）。人間が禁じたのは「端末を能動的に作る・壊す道具」
    // であって、特定の2つの綴りではない。
    //
    // 末尾を `[a-zA-Z]` に限ると、この規則を**説明している**コメントの
    // `workbench.action.terminal.*`（`*` は英字ではない）は当たらない。
    // 禁止と、禁止の説明を、同じ検査で区別する。
    const BANNED_COMMAND = /workbench\.action\.terminal\.[a-zA-Z]/;
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!full.endsWith(".ts")) continue;
        // この検査自身は禁止語の綴りを持つ。
        if (full.endsWith("view-action.test.ts")) continue;
        const text = fs.readFileSync(full, "utf8");
        const hit = BANNED_COMMAND.exec(text);
        if (hit !== null) offenders.push(`${full}: ${hit[0]}`);
      }
    };
    for (const root of roots) if (fs.existsSync(root)) walk(root);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("接頭辞の変種も落ちる（名指しの2つだけを見ていない）", () => {
    // `split` は名指しされていないが、端末を1本増やす。**接頭辞で禁じている**
    // ことを、検査自身が確かめる（この文字列はこのファイルの中なので走査対象外）。
    const BANNED_COMMAND = /workbench\.action\.terminal\.[a-zA-Z]/;
    for (const bad of [
      "workbench.action.terminal.new",
      "workbench.action.terminal.kill",
      "workbench.action.terminal.split",
      "workbench.action.terminal.killAll",
      "workbench.action.terminal.newInActiveWorkspace",
    ]) {
      expect(BANNED_COMMAND.test(bad), `${bad} が落ちない`).toBe(true);
    }
    // 規則を**説明している**綴りは当たらない（コメントを書けなくならないように）。
    expect(BANNED_COMMAND.test("workbench.action.terminal.*")).toBe(false);
    // 関係の無いコマンドも当たらない。
    expect(BANNED_COMMAND.test("workbench.action.togglePanel")).toBe(false);
  });

  it("検査が実際にファイルを読んでいる（空振りの緑を見分ける）", () => {
    // **0件でも「禁止語は無い」は真になる。** 食わせた件数を主張する
    // 。`src/` が1つも見つからなければ上の検査は
    // 何も読まずに緑になる。
    const roots = [
      path.resolve(__dirname, "../../extension/src"),
      path.resolve(__dirname, "../../bridge/src"),
      path.resolve(__dirname, "../src"),
    ];
    for (const root of roots) {
      expect(fs.existsSync(root), `${root} が無い。上の検査は何も読んでいない`).toBe(true);
    }
  });
});
