import { describe, expect, it } from "vitest";
import { type StatusModel, statusView } from "../src/status-bar.js";

// vitest には "vscode" が無いので `t()` は原文（英語）を返す（l10n.test.ts）。
// ここで主張しているのは英語の原文 ―― 日本語は `bundle.l10n.ja.json` の鍵一致の検査と、
// `--locale=ja` で起こした統合テスト（locale-ja.test.ts）が見る。

/**
 * 既定は「預けている窓」。役割を足したのは表示の主語を変えるためであって、
 * 接続の分岐まで作り替えたわけではないので、既存の検査はその条件を保つ。
 * 「預けていない」側は下の節で明示的に組み立てる。
 */
function model(over: Partial<StatusModel> = {}): StatusModel {
  return { enabled: true, failure: undefined, connection: undefined, role: "stage", ...over };
}

describe("statusView", () => {
  it("停止中は停止中と出す", () => {
    expect(statusView(model({ enabled: false })).text).toContain("Stopped");
  });

  it("預け中で待機なら、オンであることを出して接続は主張しない（Lent → On）", () => {
    const view = statusView(model());
    expect(view.text).toBe("$(eye) ShowMe: On");
    expect(view.text).not.toContain("Connected");
  });

  it("pid が取れなくても接続していることが分かる（欠陥1: Node は socket.pid を公開しない）", () => {
    const view = statusView(model({ connection: { pid: undefined } }));
    expect(view.text).toContain("Connected");
    expect(view.text).not.toContain("undefined");
    expect(view.tooltip).toContain("connected");
  });

  it("pid が取れたときだけ pid を添える", () => {
    expect(statusView(model({ connection: { pid: 1234 } })).text).toContain("(pid 1234)");
  });

  it("接続が切れたら待機中の表示に戻る", () => {
    expect(statusView(model({ connection: undefined })).text).not.toContain("Connected");
  });

  it("起動に失敗したら失敗を出す（有効なのに待機中と嘘をつかない）", () => {
    const view = statusView(model({ failure: "cannot create runtime dir: /tmp/x" }));
    expect(view.text).toContain("Failed to start");
    expect(view.tooltip).toContain("cannot create runtime dir");
  });

  it("停止中は起動失敗より優先する（人間が押したスイッチの結果を隠さない）", () => {
    const view = statusView(model({ enabled: false, failure: "boom" }));
    expect(view.text).toContain("Stopped");
  });

  it("失敗の理由に混ぜられた codicon 記法を展開させない（偽の状態表示を作らせない）", () => {
    const reason = "runtime dir is a symlink: /tmp/$(check) OK";
    const view = statusView(model({ failure: reason }));
    expect(view.text).not.toContain("$(check)");
    expect(view.tooltip).not.toContain("$(check)");
  });

  it("失敗の理由から制御文字を落とす（ステータスバーの行を偽装させない）", () => {
    const view = statusView(model({ failure: "boom\n$(eye) ShowMe" }));
    expect(view.text).not.toContain("\n");
    expect(view.tooltip).not.toContain("\n");
  });

  describe("役割（設計書 §2A.3）", () => {
    it("既定（預けていない）は、オフであることを出す（Not lent → Off）", () => {
      const view = statusView(model({ role: "idle" }));
      expect(view.text).toBe("$(shield) ShowMe: Off");
      // 「受け付けています」と読める語を出さない。既定は操作**不可**である。
      expect(view.text).not.toMatch(/ShowMe: On\b/);
      expect(view.text).not.toContain("Connected");
    });

    it("預けていない窓の tooltip が、次にすべきことを言う", () => {
      const view = statusView(model({ role: "idle" }));
      expect(view.tooltip).toContain("Click to turn it on");
      // 「Off」だけでは何を切り替えるのか分からない。主語（ShowMe）を言う。
      expect(view.tooltip).toContain("ShowMe is off");
    });

    it("役割は接続状態より優先する（預けていないのに接続中と描かない）", () => {
      // 接続そのものは役割と独立に起きうる（ソケットは立っている）。役割が
      // 無いのに「接続中」とだけ描くと、何も通らない窓が通るように見える。
      const view = statusView(model({ role: "idle", connection: { pid: undefined } }));
      expect(view.text).toContain("ShowMe: Off");
      expect(view.text).not.toContain("Connected");
    });

    it("停止中は役割より優先する（人間が押したスイッチの結果を隠さない）", () => {
      const view = statusView(model({ enabled: false, role: "stage" }));
      expect(view.text).toContain("Stopped");
      expect(view.text).not.toMatch(/ShowMe: On\b/);
    });

    it("停止中の tooltip は、クリックの意味が変わったことに合わせる", () => {
      // クリックは役割のトグルになった。停止中に「クリックで再開」と出すのは嘘。
      const view = statusView(model({ enabled: false }));
      expect(view.tooltip).not.toMatch(/^Click to resume/);
      // 案内するコマンド名は package.nls.json の showme.command.disableExtension と同じ綴り。
      expect(view.tooltip).toContain("ShowMe: Stop / Resume the extension");
    });

    it("起動失敗は役割より優先する（預けても動かないことを隠さない）", () => {
      const view = statusView(model({ role: "idle", failure: "boom" }));
      expect(view.text).toContain("Failed to start");
    });

    it("預け中で接続していれば接続中を出す", () => {
      const view = statusView(model({ role: "stage", connection: { pid: undefined } }));
      expect(view.text).toBe("$(plug) ShowMe: Connected");
    });

    it("オンの tooltip は、クリックでオフにできることを言う", () => {
      for (const connection of [undefined, { pid: undefined }, { pid: 42 }]) {
        const view = statusView(model({ role: "stage", connection }));
        expect(view.tooltip).toMatch(/Click to turn (it|ShowMe) off/);
      }
    });

    it("4つの状態は互いに違う文字列になる（表示が状態を判別する）", () => {
      const texts = [
        statusView(model({ enabled: false })).text,
        statusView(model({ failure: "boom" })).text,
        statusView(model({ role: "idle" })).text,
        statusView(model({ role: "stage" })).text,
        statusView(model({ role: "stage", connection: { pid: undefined } })).text,
      ];
      expect(new Set(texts).size).toBe(texts.length);
    });
  });
});
