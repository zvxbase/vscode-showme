import {
  SELECTION_WITHHELD_REASONS,
  type SelectionWithheldReason,
} from "@zvx/vscode-showme-protocol";

/**
 * 人間が本当に選んだものだけを返すための判定（設計書 §3.1）。
 *
 * **`vscode` を値として読まない。** 読むとこのファイルは vitest から読み込めず、
 * 判定を1件も単体で確かめられなくなる（`show-code.ts` が実際にそうなっていて、
 * 防御を壊しても全部緑だった）。観測は `editor-surface.ts` が集め、ここは
 * 受け取った数値と真偽値だけで決める。
 *
 * ## なぜ「VS Code が名乗る変更の出所」を判定に使わないのか
 *
 * 実機の検証で、出所の申告は**両方向に誤る**ことが分かっている。既定値が
 * 「キーボード」なので core のカーソルコマンドはすべてキーボード起源を名乗れる
 * （偽陽性）。逆に人間の操作の多く ―― 次の一致を選択・選択を広げる・定義へ移動・
 * 検索結果のクリック ―― は API 由来として報告され、Undo/Redo と表示状態の復元に
 * 至っては出所そのものが付かない（偽陰性）。
 *
 * 名乗りは由来ではない。だから**観測できる量だけ**で人間由来を組み立てる。
 * 詳しい根拠と実測は `test/human-selection.test.ts` の冒頭にある。
 *
 * ## 判定の順序
 *
 * 複数の条件が同時に外れているとき、**どれを返すかを決めておく**。順序は
 * 「その理由がどれだけ長く真であり続けるか」の降順で、定義元は protocol の
 * `SELECTION_WITHHELD_REASONS`（線に載る語彙と同じ並び）である。
 *
 * 永続的な理由を一時的な理由で覆わない。覆うと、エージェントは
 * 「もう一度呼べば取れる」と読んで呼び続ける ―― 理由を返すのは、まさにその
 * 無限の往復を止めるためである。
 */
export interface SelectionObservation {
  /** 文書がワークスペースの外にある（相対パスを作れない）。 */
  outsideWorkspace: boolean;
  /** パスが除外リストに当たるか。 */
  redacted: boolean;
  /** 選択が空か。 */
  empty: boolean;
  /** 選択範囲が文書全体を覆っているか。 */
  coversWholeDocument: boolean;
  /** VS Code の窓が前面にあるか。 */
  windowFocused: boolean;
  /** 当該エディタが人間の使っているエディタか。 */
  isActiveEditor: boolean;
  /** 直前の自ツール呼び出しからの経過ミリ秒。呼んでいなければ Infinity。 */
  msSinceOwnToolCall: number;
  /** この範囲を既に返したか。 */
  alreadyReturned: boolean;
}

export type SelectionVerdict = { share: true } | { share: false; reason: SelectionWithheldReason };

/**
 * 自ツールがエディタに触ってから、選択を返してよくなるまでの時間。
 *
 * `show_code` は選択を変更しない（不変条件3）ので、この待ちは合成攻撃に対する
 * 最後の砦ではなく**二重の底**である。それでも置くのは、エディタを開いた直後は
 * VS Code 自身が表示状態（＝以前の選択）を復元しうるからで、その復元は
 * 出所の申告を持たない ―― つまり申告では区別できない類のものである。
 */
export const MIN_MS_SINCE_OWN_TOOL_CALL = 1000;

/**
 * 条件と、それが外れたときに返す理由。**この配列が順序の実体である。**
 *
 * `if` の並びではなく表にしてあるのは、順序を値として取り出して
 * `SELECTION_WITHHELD_REASONS` と突き合わせられるようにするため。並べ替えると
 * 検査が落ちる。
 */
const CHECKS: ReadonlyArray<
  readonly [SelectionWithheldReason, (o: SelectionObservation) => boolean]
> = [
  // パス: 別のファイルを開くまで変わらない
  ["outside-workspace", (o) => o.outsideWorkspace],
  ["redacted", (o) => o.redacted],
  // 選択の形: 人間が選び直せば変わる
  ["empty", (o) => o.empty],
  ["whole-document", (o) => o.coversWholeDocument],
  // 人間の居場所: 戻れば変わる
  ["not-focused", (o) => !o.windowFocused],
  ["not-active", (o) => !o.isActiveEditor],
  // 時間: 待てば変わる
  ["too-soon-after-tool", (o) => o.msSinceOwnToolCall < MIN_MS_SINCE_OWN_TOOL_CALL],
  // 重複: 人間が動かせば変わる
  ["already-returned", (o) => o.alreadyReturned],
];

/** 判定が条件を当てる順序。線上の語彙の並びと一致していることを検査している。 */
export const SELECTION_CHECK_ORDER: readonly SelectionWithheldReason[] = CHECKS.map(
  ([reason]) => reason,
);

/**
 * 観測量から、選択テキストを返してよいかを決める。
 *
 * **これが `share: true` を作る唯一の場所である。** 呼び出し側は
 * `verdict.share` の内側でしか選択テキストを結果に入れてはならない。
 */
export function judgeSelection(o: SelectionObservation): SelectionVerdict {
  for (const [reason, withheld] of CHECKS) {
    if (withheld(o)) return { share: false, reason };
  }
  return { share: true };
}

/** 1始まりの行と0始まりの桁で表した選択範囲。線上の `selection` と同じ数え方。 */
export interface SelectionRange {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

/**
 * 「同じ選択」を判定するための鍵。
 *
 * 「同じ範囲か」を文字列の一致で決めるので、**別の範囲が同じ鍵に潰れないこと**
 * だけが要件である。組み立て方は実装のコメントに書いた。
 */
export function selectionKey(relPath: string, range: SelectionRange): string {
  // 数値の並びを先に置き、パスを最後に置く。区切り文字はパスに現れうるので、
  // 「数値・区切り・数値…・残り全部がパス」という形にしておけば、どんなパスでも
  // 分解が一意になる。区切りが曖昧だと 1:2-3:4 と 1:23-0:4 のような別の範囲が
  // 同じ鍵に潰れ、返してよいものを返さなくなる（あるいはその逆になる）。
  return `${range.startLine}:${range.startCharacter}-${range.endLine}:${range.endCharacter} ${relPath}`;
}

/**
 * 直前に返した選択を1つだけ覚える（設計書 §3.1 条件5）。
 *
 * **集合ではなく直前の1つ。** 集合にすると、人間が一度見せた範囲を二度と
 * 見せられなくなる。要件は「同じ選択を続けて何度も引き出せない」であって
 * 「一度返した範囲を永久に封じる」ではない。人間が選択を動かした時点で、
 * 前の範囲はまた返せるようになる。
 *
 * ディスクに残さない（不変条件13）。窓を閉じれば消える。
 */
export class SelectionMemory {
  private last: string | undefined;

  wasReturned(key: string): boolean {
    return this.last === key;
  }

  remember(key: string): void {
    this.last = key;
  }
}

/**
 * 自ツールが人間のエディタに触った時刻。
 *
 * **触るツールだけが印を付ける。** `list_workspaces` のような、エディタを
 * 一切動かさないツールでも印を付けると、エージェントの自然な開始手順
 * （まず窓を確かめてから状態を読む）が毎回この待ちに当たる。効かない防御は
 * 「効かないから緩めよう」という圧力を生み、緩めた先に穴が開く ―― 出所の
 * 申告で同じことが起きた。だから最初から、意味のある事象だけを数える。
 */
export class OwnToolCallClock {
  private lastMark: number | undefined;

  mark(now: number = Date.now()): void {
    this.lastMark = now;
  }

  /** 直前の印からの経過。一度も印が無ければ Infinity。**負は返さない。** */
  msSince(now: number = Date.now()): number {
    if (this.lastMark === undefined) return Number.POSITIVE_INFINITY;
    // 時計が巻き戻ると負になり、負は無条件に上限未満＝「まだ待て」に見えるが、
    // 実際には「印より前」という無意味な状態である。0 に丸めて危険な側に倒さない。
    return Math.max(0, now - this.lastMark);
  }
}

/**
 * 記憶と時計は**接続をまたいで1つ**を共有する。
 *
 * 接続ごとに作り直すと、切って繋ぎ直すだけで「同じ選択を二度返さない」も
 * 「自ツールが触った直後は返さない」も消える。予算を接続ごとに持たせない
 * `rate-limit.ts` の共有インスタンスと同じ理由である。
 *
 * 差し替えられるのは検査のためだけで、`extension.ts` はどちらも渡さない。
 */
export const sharedSelectionMemory = new SelectionMemory();
export const sharedOwnToolClock = new OwnToolCallClock();
