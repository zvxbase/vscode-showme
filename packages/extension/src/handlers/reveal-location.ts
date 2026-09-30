import { ToolError } from "../tool-error.js";
import type { EditorSurface, LineRange, ShowCodeLog, StagePlacement } from "./show-code.js";

/**
 * 解決した位置を人間の画面に**開いてスクロールする**唯一の関数（増分13 D117）。
 *
 * `show_code` と `annotate { reveal: true }` の両方がここを通る。開く経路を2つにしない
 * （不変条件14）―― 舞台を切っているか（`stage`）、舞台の列が無いときの理由の分け方（D90）、
 * それ以外の失敗を `not-found` に畳むこと（例外の中身を線に載せない）を、ツールごとに書き直すと
 * 片方だけがずれる。列・タブの決め方、own のタブ、`realFile`、`preserveFocus` は面
 * （`EditorSurface.reveal` → `Stage.open`）が持ち、呼ぶ側は `extension.ts` の同じ組み立て
 * （`stageEditorOf`）から面を受け取る。
 *
 * **選択には触らない**（不変条件3）。それを守るのは面の実装（`revealRange` だけを使う）。
 *
 * 人間への表示（空振り・印の案内）は呼ぶ側が決める ―― `show_code` は開けなかった位置に
 * 痕跡が残らないのでステータスバーに出すが、`annotate` は吹き出しそのものが痕跡である。
 */
export type RevealOutcome =
  | { opened: true }
  | { opened: false; reason: "stage-disabled" | "no-stage-column" | "not-found" };

export interface RevealDeps {
  editor: EditorSurface;
  log: ShowCodeLog;
  /** `config.features.stage`。切っていれば開かない（増分6 D76）。 */
  stage: boolean;
}

export async function revealResolved(
  deps: RevealDeps,
  relPath: string,
  range: LineRange,
  placement: StagePlacement,
): Promise<RevealOutcome> {
  // **舞台を切ると開かない**（増分6 §C4 / D76）。設定が縛るのはエージェントであって人間ではない
  // （§C5）: 位置は解決して返すが、開かない・スクロールしない・列を作らない。
  if (!deps.stage) return { opened: false, reason: "stage-disabled" };
  try {
    await deps.editor.reveal(relPath, range, placement);
    return { opened: true };
  } catch (e) {
    // 舞台の列が無い（D90。面が `no-stage-column` で断った）ときだけ理由を分ける ――
    // それ以外の失敗は `not-found` に畳む（例外の中身を線に載せない）。
    const reason =
      e instanceof ToolError && e.code === "no-stage-column" ? "no-stage-column" : "not-found";
    deps.log.info("failed to open", { path: relPath, error: String(e) });
    return { opened: false, reason };
  }
}
