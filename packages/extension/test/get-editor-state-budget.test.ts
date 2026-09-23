import { DEFAULT_REDACTED_PATTERNS } from "@zvx/vscode-showme-protocol";
import { describe, expect, it } from "vitest";
import type { ShowMeConfig } from "../src/config.js";
import {
  type EditorStateStatus,
  type EditorStateSurface,
  type GetEditorStateDeps,
  handleGetEditorState,
} from "../src/handlers/get-editor-state.js";
import {
  EDITOR_STATE_LIMIT_KEY,
  EDITOR_STATE_MAX_CALLS,
  EDITOR_STATE_WINDOW_MS,
  RateLimiter,
  sharedEditorStateLimiter,
  sharedFileLimiter,
} from "../src/rate-limit.js";
import { ToolError } from "../src/tool-error.js";

/**
 * `get_editor_state` の**呼び出し単位**の予算（設計書 §3.1.3）。
 *
 * **別ファイルにしてある。** 共有の器（`sharedEditorStateLimiter`）を実際に
 * 使い切る検査があり、同じファイルの他の検査と器を共有すると、走らせる順番で
 * 結果が変わる。vitest はファイル単位でモジュールを分けるので、ここで使い切っても
 * `get-editor-state.test.ts` には及ばない。
 */

const config = (): ShowMeConfig => ({
  enabled: true,
  editorGroup: "dedicated",
  html: { maxPanels: 2 },
  disabledTools: [],
  redactedPathPatterns: [...DEFAULT_REDACTED_PATTERNS],
  maxSelectionChars: 4000,
  injectTerminalEnv: true,
  listAllWorkspaces: false,
});

/** 何も返さない面。ここで見たいのは予算だけである。 */
const surface: EditorStateSurface = {
  windowFocused: () => true,
  activeEditor: () => undefined,
  groups: () => [
    {
      viewColumn: 1,
      isActive: true,
      tabs: [
        {
          label: "app.ts",
          kind: "file",
          relPath: "src/app.ts",
          own: false,
          isActive: true,
          isDirty: false,
          isPinned: false,
          isPreview: false,
          visibleLines: undefined,
        },
      ],
    },
  ],
  annotations: () => [],
};

/** 可視化そのものを見たくない検査のための無害な既定。 */
const noopStatusBar: EditorStateStatus = { flashEditorStateRateLimited: () => {} };

/** 呼ばれた回数を数える偽の可視化。「無音で落ちていないか」を判別する側。 */
function fakeStatus(): { statusBar: EditorStateStatus; flashes: () => number } {
  let flashes = 0;
  return {
    statusBar: {
      flashEditorStateRateLimited: () => {
        flashes += 1;
      },
    },
    flashes: () => flashes,
  };
}

function run(overrides: Partial<GetEditorStateDeps> = {}): Record<string, unknown> {
  return handleGetEditorState({ config, surface, statusBar: noopStatusBar, ...overrides });
}

describe("get_editor_state の呼び出し予算", () => {
  it("上限までは通り、超えると rate-limited で断る", () => {
    const limiter = new RateLimiter({ limit: 3, windowMs: 60_000 });
    for (let i = 0; i < 3; i += 1) {
      expect(run({ limiter }).openPaths).toEqual(["src/app.ts"]);
    }
    let thrown: unknown;
    try {
      run({ limiter });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ToolError);
    expect((thrown as ToolError).code).toBe("rate-limited");
  });

  it("断ったときは何も返さない（カーソルも可視行も openPaths も出ない）", () => {
    // 予算を後ろに置いた実装は、断ってもここまでは返してしまう ―― それでは
    // 軌跡を取る経路が残る。**投げること**そのものが要件である。
    const limiter = new RateLimiter({ limit: 1, windowMs: 60_000 });
    run({ limiter });
    expect(() => run({ limiter })).toThrow(ToolError);
  });

  it("窓が過ぎればまた通る（永久に閉じない）", () => {
    let now = 1_000;
    const limiter = new RateLimiter({ limit: 2, windowMs: 1_000, now: () => now });
    run({ limiter });
    run({ limiter });
    expect(() => run({ limiter })).toThrow(ToolError);
    now += 1_001;
    expect(run({ limiter }).openPaths).toEqual(["src/app.ts"]);
  });

  it("器はファイル単位の予算と別（見せる側と読む側が食い合わない）", () => {
    expect(sharedEditorStateLimiter).not.toBe(sharedFileLimiter);
  });

  it("共有の器は EDITOR_STATE_MAX_CALLS 回で閉じる", () => {
    // 定数そのものではなく、**器に実際に設定されている上限**を測る。
    for (let i = 0; i < EDITOR_STATE_MAX_CALLS; i += 1) {
      expect(sharedEditorStateLimiter.allow(EDITOR_STATE_LIMIT_KEY)).toBe(true);
    }
    expect(sharedEditorStateLimiter.allow(EDITOR_STATE_LIMIT_KEY)).toBe(false);
    expect(EDITOR_STATE_WINDOW_MS).toBe(60_000);
  });

  it("limiter を省くと、その共有の器を使う（接続ごとに予算が戻らない）", () => {
    // 直前の検査が共有の器を使い切っている。省略時に別の器を作る実装なら、
    // ここは通ってしまう。
    expect(() => run()).toThrow(ToolError);
  });
});

/**
 * 呼び出し回数制限を人間に見せているか（設計書 §5.4）。
 *
 * `show_code` / `annotate` のファイル単位の制限は `statusBar.flashRateLimited`
 * で可視化されるが、`get_editor_state` のこの呼び出し単位の制限は前タスクまで
 * 無音だった。ここが落ちれば、可視化の呼び出しを消したことがすぐ分かる
 * （このスイートを統合テストにしない理由は冒頭のコメントの通り: 拡張ホストで
 * 共有の器を使い切ると後続テストが1分間ブロックされる）。
 */
describe("回数制限の可視化", () => {
  it("制限に当たった呼び出しごとに画面へ出す（無音のオラクルにしない）", () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 60_000 });
    const status = fakeStatus();

    // 1回目は予算内なので通る。可視化はまだ呼ばれない。
    run({ limiter, statusBar: status.statusBar });
    expect(status.flashes()).toBe(0);

    // 2回目・3回目は落とされる。落とされるたびに1回ずつ増える。
    expect(() => run({ limiter, statusBar: status.statusBar })).toThrow(ToolError);
    expect(status.flashes()).toBe(1);
    expect(() => run({ limiter, statusBar: status.statusBar })).toThrow(ToolError);
    expect(status.flashes()).toBe(2);
  });

  it("予算内では一度も呼ばない", () => {
    const limiter = new RateLimiter({ limit: 3, windowMs: 60_000 });
    const status = fakeStatus();
    for (let i = 0; i < 3; i += 1) {
      run({ limiter, statusBar: status.statusBar });
    }
    expect(status.flashes()).toBe(0);
  });

  it("可視化はパスを渡さずに呼ぶ（引数の形そのものが `get_editor_state` にはパスが無いことの証拠）", () => {
    // `flashEditorStateRateLimited` は引数を取らない型である。呼べたことが
    // そのまま「パスを要求していない」ことの証拠になる。
    const limiter = new RateLimiter({ limit: 0, windowMs: 60_000 });
    const status = fakeStatus();
    expect(() => run({ limiter, statusBar: status.statusBar })).toThrow(ToolError);
    expect(status.flashes()).toBe(1);
  });
});
