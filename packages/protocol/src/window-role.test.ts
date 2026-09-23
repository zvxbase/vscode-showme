import { describe, expect, it } from "vitest";
import { type WindowCandidate, chooseStageWindow, windowRoleSchema } from "./window-role.js";

const cand = (over: Partial<WindowCandidate>): WindowCandidate => ({
  windowId: "w1",
  role: "stage",
  socketPath: "/rt/a.sock",
  workspacePath: "/w",
  ...over,
});

describe("windowRoleSchema", () => {
  it("stage と idle だけを受け付ける", () => {
    expect(windowRoleSchema.safeParse("stage").success).toBe(true);
    expect(windowRoleSchema.safeParse("idle").success).toBe(true);
    expect(windowRoleSchema.safeParse("admin").success).toBe(false);
    expect(windowRoleSchema.safeParse(undefined).success).toBe(false);
  });

  it("大文字小文字は揺らさない（登録ファイルの値は1つの綴りだけ）", () => {
    // 拡張が書き、ブリッジが読む。綴りが2通りあると役割が黙って落ちる。
    expect(windowRoleSchema.safeParse("STAGE").success).toBe(false);
    expect(windowRoleSchema.safeParse("Stage").success).toBe(false);
    expect(windowRoleSchema.safeParse("").success).toBe(false);
  });

  it("語彙は stage と idle の2つで閉じている", () => {
    expect(windowRoleSchema.options).toEqual(["stage", "idle"]);
  });
});

describe("chooseStageWindow", () => {
  it("stage が1つならそれを選ぶ", () => {
    const r = chooseStageWindow(
      [cand({ windowId: "a" }), cand({ windowId: "b", role: "idle" })],
      {},
    );
    expect(r.ok && r.entry.windowId).toBe("a");
  });

  it("stage が0なら、預けられていないことを名指しで返す", () => {
    const r = chooseStageWindow(
      [cand({ role: "idle" }), cand({ windowId: "b", role: "idle" })],
      {},
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe("no-stage");
    // 候補が居ることは伝える（拡張が動いていないのとは違う）
    expect(!r.ok && r.idleCount).toBe(2);
  });

  it("候補が1つも無ければ no-entries", () => {
    const r = chooseStageWindow([], {});
    expect(!r.ok && r.reason).toBe("no-entries");
  });

  it("stage が2つ以上なら、黙って選ばず両方を名指しする", () => {
    const r = chooseStageWindow([cand({ windowId: "a" }), cand({ windowId: "b" })], {});
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe("multiple-stages");
    expect(!r.ok && r.stages?.map((s) => s.windowId)).toEqual(["a", "b"]);
  });

  it("stage が複数でも SHOWME_SOCK が一致すれば同点を解ける", () => {
    const r = chooseStageWindow(
      [
        cand({ windowId: "a", socketPath: "/rt/a.sock" }),
        cand({ windowId: "b", socketPath: "/rt/b.sock" }),
      ],
      { sock: "/rt/b.sock" },
    );
    expect(r.ok && r.entry.windowId).toBe("b");
  });

  it("stage が複数でも workspace_path が一致すれば同点を解ける", () => {
    const r = chooseStageWindow(
      [
        cand({ windowId: "a", workspacePath: "/w/alpha" }),
        cand({ windowId: "b", workspacePath: "/w/beta" }),
      ],
      { workspacePath: "/w/beta" },
    );
    expect(r.ok && r.entry.windowId).toBe("b");
  });

  it("同点解決のヒントは stage の中だけに効く（idle を拾わない）", () => {
    // ヒントが idle の窓を指していても、預けられていない窓には繋がない
    const r = chooseStageWindow([cand({ windowId: "a", role: "idle", socketPath: "/rt/a.sock" })], {
      sock: "/rt/a.sock",
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe("no-stage");
  });

  it("役割が欠けている登録は idle として扱う（古い拡張との共存・フェイルクローズ）", () => {
    const legacy = {
      windowId: "old",
      socketPath: "/rt/o.sock",
      workspacePath: "/w",
    } as WindowCandidate;
    const r = chooseStageWindow([legacy], {});
    expect(!r.ok && r.reason).toBe("no-stage");
  });

  it("役割が未知の綴りの登録も idle として扱う（フェイルクローズ）", () => {
    // 未来の拡張が知らない役割を書いても、預かっていると解釈しない。
    const future = cand({ windowId: "future", role: "admin" as unknown as "stage" });
    const r = chooseStageWindow([future, cand({ windowId: "s" })], {});
    expect(r.ok && r.entry.windowId).toBe("s");
  });

  it("役割の欠けた登録も idleCount に数える", () => {
    const legacy = {
      windowId: "old",
      socketPath: "/rt/o.sock",
      workspacePath: "/w",
    } as WindowCandidate;
    const r = chooseStageWindow([legacy, cand({ windowId: "i", role: "idle" })], {});
    expect(!r.ok && r.idleCount).toBe(2);
  });

  it("ヒントが idle だけを指していても、stage が複数なら黙って選ばない", () => {
    // idle を指すヒントは同点解決に使えない。先頭の stage に落ちてはならない。
    const r = chooseStageWindow(
      [
        cand({ windowId: "a" }),
        cand({ windowId: "b" }),
        cand({ windowId: "i", role: "idle", socketPath: "/rt/i.sock" }),
      ],
      { sock: "/rt/i.sock" },
    );
    expect(!r.ok && r.reason).toBe("multiple-stages");
    expect(!r.ok && r.stages?.map((s) => s.windowId)).toEqual(["a", "b"]);
  });

  it("ヒントが空文字なら無いものとして扱う", () => {
    const r = chooseStageWindow([cand({ windowId: "a" }), cand({ windowId: "b" })], {
      sock: "",
      workspacePath: "",
    });
    expect(!r.ok && r.reason).toBe("multiple-stages");
  });

  it("ヒントがどの stage にも一致しなければ黙って選ばない", () => {
    const r = chooseStageWindow([cand({ windowId: "a" }), cand({ windowId: "b" })], {
      sock: "/rt/nowhere.sock",
      workspacePath: "/w/nowhere",
    });
    expect(!r.ok && r.reason).toBe("multiple-stages");
  });

  it("workspace_path のヒントが複数の stage に一致するなら黙って選ばない", () => {
    // 同じフォルダを2窓で開いて両方を預けた場合。workspace_path では判別できない。
    const r = chooseStageWindow(
      [
        cand({ windowId: "a", workspacePath: "/w/same", socketPath: "/rt/a.sock" }),
        cand({ windowId: "b", workspacePath: "/w/same", socketPath: "/rt/b.sock" }),
      ],
      { workspacePath: "/w/same" },
    );
    expect(!r.ok && r.reason).toBe("multiple-stages");
    expect(!r.ok && r.stages?.map((s) => s.windowId)).toEqual(["a", "b"]);
  });

  it("SHOWME_SOCK のヒントが workspace_path のヒントより先に効く", () => {
    // ソケットパスは窓ごとに一意。フォルダは2窓で共有されうる。強い方を先に使う。
    const r = chooseStageWindow(
      [
        cand({ windowId: "a", socketPath: "/rt/a.sock", workspacePath: "/w/alpha" }),
        cand({ windowId: "b", socketPath: "/rt/b.sock", workspacePath: "/w/beta" }),
      ],
      { sock: "/rt/a.sock", workspacePath: "/w/beta" },
    );
    expect(r.ok && r.entry.windowId).toBe("a");
  });

  it("stage が1つなら、ヒントがどこも指していなくてもそれを選ぶ", () => {
    // 制限モードでは $SHOWME_SOCK が届かない。ヒント無しで動くことが主経路である。
    const r = chooseStageWindow([cand({ windowId: "a" }), cand({ windowId: "b", role: "idle" })], {
      sock: "/rt/stale.sock",
      workspacePath: "/w/stale",
    });
    expect(r.ok && r.entry.windowId).toBe("a");
  });

  it("入力の配列を書き換えない", () => {
    const input = [cand({ windowId: "a" }), cand({ windowId: "b" })];
    const before = input.map((c) => c.windowId);
    const r = chooseStageWindow(input, {});
    if (!r.ok && r.stages) r.stages.length = 0;
    expect(input.map((c) => c.windowId)).toEqual(before);
  });
});
