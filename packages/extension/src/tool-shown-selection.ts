import type { ToolName } from "@zvx/vscode-showme-protocol";
import {
  MIN_MS_SINCE_OWN_TOOL_CALL,
  type SelectionRange,
  selectionKey,
} from "./human-selection.js";

/**
 * ツールが見せた選択（D95）。判断のみ、vscode 非依存。
 *
 * 選択を返すかの判定（`judgeSelection`）は `human-selection.ts` にあり、ここはその観測量の1つ
 * （`shownByTool`）を作るための記録と窓を持つ。依存は一方向（ここ → `human-selection.ts`）。
 * vscode に触る側（前面の観測・事象の購読・呼び出しの包み）は `tool-call-recorder-vscode.ts`、
 * 包みの手順は `tool-call-recorder.ts`。
 */

/** `ToolShownSelection` が覚えるパスの数の上限（D95）。 */
export const TOOL_SHOWN_SELECTION_LIMIT = 256;

/**
 * ツールが前面に出した編集器の選択を、**パスごとに1つ・件数に上限つき**で覚える（D95）。
 *
 * D93 / D94 でエージェントのタブが人間の列に開くと、そのタブが `activeTextEditor` になり、
 * **人間が以前そこで作った選択**（タブの使い回し、または VS Code の表示状態の復元）を持ったまま
 * 前面に出る。それは今の人間の意図ではない。
 *
 * - **パスごと**: 1つだけにすると、エージェントが別のファイルを前に出すだけで先の記録が消え、
 *   人間がクリックで戻ったときに古い選択が返る
 * - **パスの中では直前の1つ**（`SelectionMemory` と同じく集合にしない）: 人間が選び直せば鍵が
 *   変わり、返せるようになる
 * - **件数に上限**（256。最も古く使われたパスから忘れる。1件は短い文字列2つで、溢れて古い記録が
 *   消える方が危ない）。ディスクに残さない（不変条件13）
 */
export class ToolShownSelection {
  private readonly byPath = new Map<string, string>();

  matches(relPath: string, key: string): boolean {
    return this.byPath.get(relPath) === key;
  }

  remember(relPath: string, key: string): void {
    // 挿入順を「最近使った順」に使う: 消してから入れ直すと末尾（最新）に移る。
    this.byPath.delete(relPath);
    this.byPath.set(relPath, key);
    while (this.byPath.size > TOOL_SHOWN_SELECTION_LIMIT) {
      const oldest = this.byPath.keys().next().value;
      if (oldest === undefined) break;
      this.byPath.delete(oldest);
    }
  }

  size(): number {
    return this.byPath.size;
  }
}

/**
 * **窓**（D95）: 前面を変えうるツール（`TOOL_MAY_CHANGE_FRONT_EDITOR`）の呼び出しが始まってから、
 * 終わって `MIN_MS_SINCE_OWN_TOOL_CALL` が経つまで。判断のみで、時刻は呼び出し側が渡す。
 *
 * - 窓の間は選択を返さない（`too-soon-after-tool`）。並行に来た `get_editor_state` が、前面が
 *   変わった後・記録の前の選択を読む競合を塞ぐ
 * - 前面の変化をツールの仕業として記録するのは、**呼び出しの最中**の変化と、落ち着かないまま
 *   終わった呼び出し（`expectLateFront`）の後の**窓の尾の最初の1回**だけ（`frontChanged`）。
 *   それ以外の窓の尾の変化は人間のクリックとして記録しない
 * - 最中に前に出た編集器は覚えておき（`wasFronted`）、窓の間にその選択が変わったら（復元は前に
 *   出た後に届く）変わった先も記録する
 *
 * 重なった呼び出しは件数で数える（片方が終わっても、もう片方が走っている間は窓の中）。
 * 終わりの時刻は最後に終わったもの。
 */
export class ToolCallWindow {
  private inFlight = 0;
  private lastEnd: number | undefined;
  /** この窓の間に前面に出た編集器の同一性（`FrontEditor.identity`）。窓が閉じてから始まる窓で空にする。 */
  private readonly fronted = new Set<string>();
  /** 落ち着かないまま終わった呼び出しがあり、窓の尾の最初の前面の変化をツールの仕業とみなすか。 */
  private lateFront = false;

  begin(now: number = Date.now()): void {
    // 前の窓が閉じていれば、前に出たものの記憶と「遅れて来る」印は持ち越さない（窓の外の
    // 人間の操作で前に出た編集器の選択の変化まで記録し続けない）。
    if (!this.inWindow(now)) {
      this.fronted.clear();
      this.lateFront = false;
    }
    this.inFlight += 1;
  }

  /**
   * 呼び出しの終わりに前面が落ち着いていなかった（待ちが上限に当たった）ことを印す。窓の尾で
   * **最初に**来る前面の変化をツールの仕業とみなす ―― 返しすぎ（人間のクリックを取り違える）は
   * 許し、漏らしは許さない側に倒す。
   */
  expectLateFront(): void {
    this.lateFront = true;
  }

  /**
   * 前面の変化の事象がツールの仕業か（D95）。呼び出しの最中ならいつも、窓の尾なら
   * `expectLateFront` の後の最初の1回だけ。仕業なら、その編集器を前に出たものとして覚える
   * （`identity` が無い＝テキストでない前面なら覚えるものは無い）。
   */
  frontChanged(identity: string | undefined, now: number = Date.now()): boolean {
    let byTool = this.inFlight > 0;
    if (!byTool && this.lateFront && this.inWindow(now)) {
      byTool = true;
      this.lateFront = false;
    }
    if (byTool && identity !== undefined) this.fronted.add(identity);
    return byTool;
  }

  /**
   * **呼び出しの最中に**前面に出た編集器を覚える。呼び出しが走っていなければ覚えない ―― 呼び出しが
   * 終わった後（窓の尾）に前に出たのは、人間がクリックで移った先である。
   *
   * **前面に出た瞬間の選択は、まだ復元前である**（実 VS Code で実測。2026-09-27）:
   * `onDidChangeActiveTextEditor` の時点の選択は既定の 1:0 で、人間が以前作った選択（表示状態の
   * 復元・裏にあったタブの使い回し）は**その後に**選択の変化として届く。閉じた後の前面は
   * ハンドラが返った時点ではまだ `undefined` のこともある（`close-own` で実測。事象は返って数 ms 後）。
   * だから前に出た編集器を覚えておき、窓の間にその編集器の選択が変わったら、変わった先も記録する
   * （`wasFronted`）。
   *
   * 窓の尾の人間のクリックを覚えないのは、覚えると人間が窓の直後に選んだ自分の選択まで
   * 「ツールが見せた」になり、選び直すまで返らなくなるから（実測で「これ何？」の流れが止まった）。
   */
  markFronted(identity: string): void {
    if (this.inFlight > 0) this.fronted.add(identity);
  }

  /** 呼び出しが走っているか（統合テストの観測口が、読んだ時点で窓の最中だったかを確かめる）。 */
  inFlightNow(): boolean {
    return this.inFlight > 0;
  }

  /** 窓の間で、その編集器がこの窓の間に前面に出たか。 */
  wasFronted(identity: string, now: number = Date.now()): boolean {
    return this.inWindow(now) && this.fronted.has(identity);
  }

  end(now: number = Date.now()): void {
    // 対になっていない終わりで負にしない（負のままだと次の始まりで窓が開かなくなる）。
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.lastEnd = now;
  }

  /** 窓の端（最後の呼び出しの終わり）からの経過。走っている間は 0、一度も無ければ Infinity。 */
  msSince(now: number = Date.now()): number {
    if (this.inFlight > 0) return 0;
    if (this.lastEnd === undefined) return Number.POSITIVE_INFINITY;
    // 時計の巻き戻りで負にしない（`OwnToolCallClock.msSince` と同じ理由）。
    return Math.max(0, now - this.lastEnd);
  }

  inWindow(now: number = Date.now()): boolean {
    return this.msSince(now) < MIN_MS_SINCE_OWN_TOOL_CALL;
  }
}

/**
 * 前面の編集器（`activeTextEditor`）の観測。`identity` は文書の URI と列を合わせた綴り
 * （同じ文書でも列が違えば別の編集器）。`relPath` は `get_editor_state` と同じ関数
 * （`observedRelPath`）で作る ―― 覚える鍵と照らす鍵が同じ綴りになるように。
 */
export interface FrontEditor {
  identity: string;
  relPath: string | undefined;
  selection: SelectionRange;
}

/** 前面の編集器の同一性の綴り（列と文書の URI）。観測も照合もこれ1つで作る。 */
export function frontIdentity(viewColumn: number | undefined, uri: string): string {
  return `${String(viewColumn)} ${uri}`;
}

/**
 * 前面が**落ち着いた**か（D95）。`activeTextEditor`（`front`）が、人間の列の表示中のタブ
 * （`activeTabGroup.activeTab`）と一致していれば落ち着いている。
 *
 * 閉じる・動かす・合流の後、VS Code のタブのモデルは先に更新され、`activeTextEditor` は遅れて
 * 追いつく（古い編集器のまま、または `undefined`）ことがある。落ち着く前に観測すると、前に
 * 出てきた編集器（人間が以前作った選択を持つ）を見落とす。
 *
 * 表示中のタブがテキストでない（パネル・端末など）なら、前面の編集器が無いときだけ落ち着いている。
 */
export function frontSettled(
  front: FrontEditor | undefined,
  activeTab: { column: number | undefined; textUri: string | undefined },
): boolean {
  if (activeTab.textUri === undefined) return front === undefined;
  return (
    front !== undefined && front.identity === frontIdentity(activeTab.column, activeTab.textUri)
  );
}

/**
 * ツールの呼び出しの前後の前面の編集器から、覚える鍵を決める（D95）。**判断はここ1つ。**
 *
 * - 前面の編集器が変わらなければ何も覚えない。人間が選んでから「これ何？」と聞き、
 *   エージェントが別の列を `show_code` しても、人間の選択は今までどおり返る
 * - 変わったら、後の編集器の選択の鍵。空の選択も覚える（覚えても害は無く、分岐を増やさない）
 * - 後の編集器がワークスペースの外（相対パスが無い）なら覚えない ―― その選択は
 *   `outside-workspace` で既に返らない
 */
export function toolShownSelectionKey(
  before: FrontEditor | undefined,
  after: FrontEditor | undefined,
): ToolShownRecord | undefined {
  if (before !== undefined && after !== undefined && before.identity === after.identity) {
    return undefined;
  }
  return frontEditorRecord(true, after);
}

/** 覚えるもの（パスと、その選択の鍵）。 */
export interface ToolShownRecord {
  relPath: string;
  key: string;
}

/**
 * ツールの仕業の前面（D95）で覚えるもの: その編集器のその時点の選択。ツールの仕業かどうか
 * （`byTool`）は呼び出し側が決める ―― 前面の変化の事象なら `ToolCallWindow.frontChanged`、
 * 選択の変化なら `ToolCallWindow.wasFronted`。仕業でなければ（人間の操作）覚えない。
 */
export function frontEditorRecord(
  byTool: boolean,
  front: FrontEditor | undefined,
): ToolShownRecord | undefined {
  if (!byTool || front === undefined || front.relPath === undefined) return undefined;
  return { relPath: front.relPath, key: selectionKey(front.relPath, front.selection) };
}

/**
 * 呼び出しの前後で前面の編集器を観測するツール（D95 の記録点）。**`ToolName` の全語を
 * 分類する**（語を足すと型で落ちる ―― 分類し忘れたツールが黙って記録から漏れない）。
 *
 * 真は画面の編集器を動かしうるもの。`show_code` は開く、`arrange_editors` は動かす・閉じる
 * （閉じれば下の編集器が前面に出る）、`show_note` / `show_html` / `show_view` は前面を
 * 入れ替えうる、`annotate` は吹き出しを出す。偽は読むだけのもの ―― 記録すると、呼び出しの
 * 最中に人間が自分で移った先の選択まで「ツールが見せた」になる。
 *
 * **自ツールの時計（`OwnToolCallClock`）とは別の量である。** 時計に印を付けるのは
 * `show_code` だけで、それを広げると `arrange_editors` のあとにも1秒の待ちが生まれる
 * （振る舞いの変更）。**この分類が真のツールは、前面が実際に変わったかどうかに関わらず、
 * 呼び出し中と終わってから `MIN_MS_SINCE_OWN_TOOL_CALL` の間ずっと窓が開き
 * （`ToolCallWindow`）、`get_editor_state` はその間 `too-soon-after-tool` で選択を返さない
 * （`get-editor-state.ts` の `msSinceOwnToolCall` は自ツールの時計とこの窓の小さいほう）。**
 * 「前面が実際に変わったときだけ効く」のは、その変化を**ツールの仕業として記録するか**
 * （`frontChanged` / `wasFronted`）という別の判断であって、窓を開くかどうかではない。
 */
export const TOOL_MAY_CHANGE_FRONT_EDITOR: Readonly<Record<ToolName, boolean>> = {
  show_code: true,
  annotate: true,
  show_note: true,
  show_html: true,
  show_view: true,
  arrange_editors: true,
  get_editor_state: false,
  list_workspaces: false,
  find_definition: false,
  find_references: false,
};

/** ツールが見せた選択（D95）。接続をまたいで1つ（`sharedSelectionMemory` と同じ理由）。 */
export const sharedToolShownSelection = new ToolShownSelection();
/** 窓（D95）。同じ理由で接続をまたいで1つ。 */
export const sharedToolCallWindow = new ToolCallWindow();
