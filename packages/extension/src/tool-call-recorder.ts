import type { ToolName } from "@zvx/vscode-showme-protocol";
import {
  type FrontEditor,
  TOOL_MAY_CHANGE_FRONT_EDITOR,
  type ToolCallWindow,
  type ToolShownSelection,
  frontSettled,
  toolShownSelectionKey,
} from "./tool-shown-selection.js";

/**
 * 前面を変えうるツールの呼び出しを包む手順（D95）。vscode 非依存 ―― 観測は `FrontObserver` で
 * 受け取り（実体は `tool-call-recorder-vscode.ts`）、手順だけを単体で確かめられるようにしてある。
 */

/** 前面が落ち着くのを待つ上限（D95）。実測は 1〜4 ms（`runRecordingFront` のコメント）。 */
export const FRONT_SETTLE_MS = 200;

/** 前面の観測（vscode に触る側が満たす）。 */
export interface FrontObserver {
  /** `activeTextEditor` の観測（`observeFrontEditor`）。 */
  front(): FrontEditor | undefined;
  /** 人間の列の表示中のタブ（`observeActiveTab`）。 */
  activeTab(): { column: number | undefined; textUri: string | undefined };
  /** `settled()` が真になるのを待つ（上限つき）。上限までに落ち着けば true。 */
  waitForSettled(settled: () => boolean, timeoutMs: number): Promise<boolean>;
}

export interface RecorderDeps {
  observer: FrontObserver;
  toolWindow: ToolCallWindow;
  shown: ToolShownSelection;
  /** 記録の失敗を報告する（ツールの結果・例外は置き換えない）。 */
  onRecordError(error: unknown): void;
}

/**
 * ツールの呼び出しを包む。前面を変えうるツール（`TOOL_MAY_CHANGE_FRONT_EDITOR`）なら窓を開き、
 * 呼び出しの前後の前面の編集器を比べ、変わっていたら後の編集器の選択を「ツールが見せた選択」と
 * して覚える（`toolShownSelectionKey`）。
 *
 * **窓は必ず閉じる。記録の失敗はツールの結果も例外も置き換えない。** 前の観測が投げたら前は
 * 無いものとして扱い（後の前面を記録する側に倒れる）、ツールは走らせる。後の観測・待ち・記録が
 * 投げたら報告だけして、`end()` は `finally` で呼ぶ ―― 窓が最中のまま残ると、選択が永久に返らない。
 *
 * **前面が落ち着くまで呼び出しの最中に留まる**（`frontSettled`）。閉じる・動かす・合流の後、
 * タブのモデルは先に更新され、`activeTextEditor` は遅れて追いつく（`undefined` のまま、または
 * 古い編集器のまま）。落ち着いていなければ、一致するのを待つ（上限 `FRONT_SETTLE_MS`）―― その間に
 * 来た前面の変化は最中の変化として記録される（`registerFrontObservers`）。上限に当たったら、窓の尾で
 * 最初に来る前面の変化をツールの仕業とみなす（`expectLateFront`。返しすぎは許し、漏らしは許さない）。
 * 落ち着いている呼び出し（`show_code` のほとんど）は待たない。
 *
 * 実測（2026-09-27、実 VS Code）:
 * - 人間の列で自分のタブを `close-own` で閉じる・`move-tab` で外へ出す・`gather-own` で集めると、
 *   下の人間の編集器が表示中のタブになった時点で `activeTextEditor` はまだ `undefined` で、
 *   1〜4 ms で一致した（上限に当たったことは無い）。古い編集器が残る形（定義されているが違う）は
 *   観測されなかったが、判定はそれも落ち着いていないと読む。`show_html` の後はパネルが表示中で
 *   前面の編集器が無く、落ち着いている
 * - 表示状態の復元（閉じたタブを同じ列に開き直させる）は、呼び出しが返った時点で既に前面の
 *   選択にあり、50 ms 後・350 ms 後も同じだった。別の列に開いたときは復元されず空だった。
 *   裏にあったタブの使い回しは元の選択をそのまま持つ。ただし**前面の変化の事象の時点では選択は
 *   復元前**（既定の 1:0）で、復元は選択の変化として後から届く ―― だから最中に前に出た編集器の
 *   選択の変化も窓の間は記録する（`ToolCallWindow.wasFronted`）
 */
export async function runRecordingFront<T>(
  tool: ToolName,
  dispatch: () => Promise<T>,
  deps: RecorderDeps,
): Promise<T> {
  if (!TOOL_MAY_CHANGE_FRONT_EDITOR[tool]) return dispatch();
  const { observer, toolWindow, shown } = deps;
  toolWindow.begin();
  let before: FrontEditor | undefined;
  try {
    try {
      before = observer.front();
    } catch (error) {
      deps.onRecordError(error);
    }
    return await dispatch();
  } finally {
    try {
      const settled = (): boolean => frontSettled(observer.front(), observer.activeTab());
      if (!settled() && !(await observer.waitForSettled(settled, FRONT_SETTLE_MS))) {
        toolWindow.expectLateFront();
      }
      const after = observer.front();
      const record = toolShownSelectionKey(before, after);
      if (record !== undefined && after !== undefined) {
        shown.remember(record.relPath, record.key);
        // 前に出た編集器の選択が、この後（窓の間）に復元で変わっても記録できるように。
        toolWindow.markFronted(after.identity);
      }
    } catch (error) {
      deps.onRecordError(error);
    } finally {
      toolWindow.end();
    }
  }
}
