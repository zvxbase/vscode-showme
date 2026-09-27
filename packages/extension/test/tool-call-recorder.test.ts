import { describe, expect, it, vi } from "vitest";
import { selectionKey } from "../src/human-selection.js";
import {
  FRONT_SETTLE_MS,
  type FrontObserver,
  runRecordingFront,
} from "../src/tool-call-recorder.js";
import {
  type FrontEditor,
  ToolCallWindow,
  ToolShownSelection,
  frontIdentity,
} from "../src/tool-shown-selection.js";

/**
 * 前面を変えうるツールの呼び出しを包む手順（D95）。vscode に触る観測は差し替えて、手順だけを見る:
 * 窓を開いて閉じる・前後を比べて記録する・落ち着くまで待つ・**記録の失敗でツールの結果も窓も
 * 壊さない**。
 */
const range = { startLine: 3, startCharacter: 1, endLine: 3, endCharacter: 9 };
const editor = (column: number, uri: string, relPath = "src/y.ts"): FrontEditor => ({
  identity: frontIdentity(column, uri),
  relPath,
  selection: range,
});

function observer(fronts: Array<FrontEditor | undefined>, settledAfterWait = true) {
  let i = 0;
  const current = (): FrontEditor | undefined => fronts[Math.min(i, fronts.length - 1)];
  const obs: FrontObserver & { advance(): void } = {
    front: () => current(),
    activeTab: () => {
      const f = current();
      if (f === undefined) return { column: 1, textUri: undefined };
      const [col, uri] = f.identity.split(" ");
      return { column: Number(col), textUri: uri };
    },
    waitForSettled: vi.fn(async () => settledAfterWait),
    advance: () => {
      i += 1;
    },
  };
  return obs;
}

function deps(obs: FrontObserver) {
  return {
    observer: obs,
    toolWindow: new ToolCallWindow(),
    shown: new ToolShownSelection(),
    onRecordError: vi.fn(),
  };
}

describe("runRecordingFront（D95 の包み）", () => {
  it("前面を変えないツールは包まない（窓を開かない）", async () => {
    const d = deps(observer([undefined]));
    expect(await runRecordingFront("list_workspaces", async () => "ok", d)).toBe("ok");
    expect(d.toolWindow.inWindow()).toBe(false);
  });

  it("前面が変わったら、後の編集器の選択を記録し、窓を閉じる（閉じて1秒は窓の中）", async () => {
    const obs = observer([editor(1, "file:///h", "src/h.ts"), editor(1, "file:///y")]);
    const d = deps(obs);
    const result = await runRecordingFront(
      "show_code",
      async () => {
        expect(d.toolWindow.inFlightNow()).toBe(true);
        obs.advance();
        return "shown";
      },
      d,
    );
    expect(result).toBe("shown");
    expect(d.shown.matches("src/y.ts", selectionKey("src/y.ts", range))).toBe(true);
    expect(d.toolWindow.inFlightNow()).toBe(false);
    expect(d.toolWindow.inWindow()).toBe(true);
  });

  it("ツールが投げても、記録と窓の後始末は済み、ツールの例外がそのまま伝わる", async () => {
    const obs = observer([editor(1, "file:///h", "src/h.ts"), editor(1, "file:///y")]);
    const d = deps(obs);
    const boom = new Error("tool failed");
    await expect(
      runRecordingFront(
        "arrange_editors",
        async () => {
          obs.advance();
          throw boom;
        },
        d,
      ),
    ).rejects.toBe(boom);
    expect(d.toolWindow.inFlightNow()).toBe(false);
    expect(d.shown.matches("src/y.ts", selectionKey("src/y.ts", range))).toBe(true);
  });

  it("後の観測が投げても、ツールの結果は返り、窓は閉じ、失敗は報告される", async () => {
    const obs = observer([editor(1, "file:///h")]);
    let calls = 0;
    obs.front = () => {
      calls += 1;
      if (calls > 1) throw new Error("observe failed");
      return editor(1, "file:///h");
    };
    const d = deps(obs);
    expect(await runRecordingFront("show_code", async () => "shown", d)).toBe("shown");
    expect(d.toolWindow.inFlightNow()).toBe(false);
    expect(d.onRecordError).toHaveBeenCalledTimes(1);
  });

  it("後の観測が投げても、ツールの例外は置き換わらない", async () => {
    const obs = observer([editor(1, "file:///h")]);
    let calls = 0;
    obs.front = () => {
      calls += 1;
      if (calls > 1) throw new Error("observe failed");
      return editor(1, "file:///h");
    };
    const d = deps(obs);
    const boom = new Error("tool failed");
    await expect(
      runRecordingFront(
        "show_code",
        async () => {
          throw boom;
        },
        d,
      ),
    ).rejects.toBe(boom);
    expect(d.toolWindow.inFlightNow()).toBe(false);
  });

  it("前の観測が投げても、ツールは走る（前は無いものとして扱い、後を記録する）", async () => {
    const obs = observer([editor(1, "file:///y")]);
    const front = obs.front;
    let first = true;
    obs.front = () => {
      if (first) {
        first = false;
        throw new Error("observe failed");
      }
      return front();
    };
    const d = deps(obs);
    const dispatch = vi.fn(async () => "shown");
    expect(await runRecordingFront("show_code", dispatch, d)).toBe("shown");
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(d.onRecordError).toHaveBeenCalledTimes(1);
    expect(d.shown.matches("src/y.ts", selectionKey("src/y.ts", range))).toBe(true);
  });

  it("終わりに落ち着いていなければ、最中のまま待つ（上限 FRONT_SETTLE_MS）", async () => {
    const obs = observer([editor(1, "file:///h", "src/h.ts")]);
    // 表示中のタブは Y なのに、前面の編集器は古い H のまま。
    obs.activeTab = () => ({ column: 1, textUri: "file:///y" });
    const d = deps(obs);
    let inFlightWhileWaiting: boolean | undefined;
    obs.waitForSettled = vi.fn(async () => {
      inFlightWhileWaiting = d.toolWindow.inFlightNow();
      return true;
    });
    await runRecordingFront("arrange_editors", async () => "done", d);
    expect(obs.waitForSettled).toHaveBeenCalledWith(expect.any(Function), FRONT_SETTLE_MS);
    expect(inFlightWhileWaiting).toBe(true);
  });

  it("待ちが上限に当たったら、窓の尾の最初の前面の変化をツールの仕業とみなす", async () => {
    const obs = observer([editor(1, "file:///h", "src/h.ts")], false);
    obs.activeTab = () => ({ column: 1, textUri: "file:///y" });
    const d = deps(obs);
    await runRecordingFront("arrange_editors", async () => "done", d);
    expect(d.toolWindow.frontChanged(frontIdentity(1, "file:///y"))).toBe(true);
    expect(d.toolWindow.frontChanged(frontIdentity(1, "file:///x"))).toBe(false);
  });

  it("落ち着いていれば待たない", async () => {
    const obs = observer([editor(1, "file:///h", "src/h.ts")]);
    const d = deps(obs);
    await runRecordingFront("show_code", async () => "shown", d);
    expect(obs.waitForSettled).not.toHaveBeenCalled();
  });
});
