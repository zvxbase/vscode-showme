import {
  type AnnotationColor,
  type AnnotationState,
  MAX_EDITOR_GROUPS,
  MAX_OPEN_PATHS,
  MAX_SELECTED_TEXT_CHARS,
  MAX_TABS_PER_GROUP,
  MAX_TAB_LABEL_CHARS,
  isRedactedPath,
  truncateDisplayText,
} from "@zvx/vscode-showme-protocol";
import type { ShowMeConfig } from "../config.js";
import { type ObservedGroup, buildEditorLayout } from "../editor-observation.js";
import {
  type OwnToolCallClock,
  type SelectionMemory,
  type SelectionObservation,
  type SelectionRange,
  judgeSelection,
  selectionKey,
  sharedOwnToolClock,
  sharedSelectionMemory,
} from "../human-selection.js";
import {
  EDITOR_STATE_LIMIT_KEY,
  type RateLimiter,
  sharedEditorStateLimiter,
} from "../rate-limit.js";
import { ToolError } from "../tool-error.js";

/** 1始まりの行と0始まりの桁。線上の `cursor` と同じ数え方。 */
export interface CursorPosition {
  line: number;
  character: number;
}

/** 画面に見えている行の範囲（1始まり、両端を含む）。 */
export interface VisibleLines {
  start: number;
  end: number;
}

/**
 * 人間が使っているエディタから読んだ観測。
 *
 * **選択テキストだけは関数で受け取る**（`readSelectedText`）。値で受け取ると、
 * 共有しないと決まった場合でも文字列が組み立てられる ―― 100MB のファイルの
 * 9割を選択されていれば、返さないと決めた文字列のためだけに拡張ホストが固まる。
 * それ以上に大事なのは、**共有すると決めるまで読まない**という順序が、
 * 「`selectedText` が入る経路は1つだけ」を型で言えることである。
 */
export interface ActiveEditorObservation {
  /**
   * ワークスペース相対パス（映しのタブも `observedRelPath` で rel に戻る。D83）。
   * ワークスペースの外・それ以外の scheme なら undefined。
   */
  relPath: string | undefined;
  /** 人間が使っているエディタか（設計書 §3.1 条件2）。 */
  isActiveEditor: boolean;
  cursor: CursorPosition;
  selection: SelectionRange;
  /** 選択が空か。 */
  empty: boolean;
  /** 選択範囲が文書全体を覆っているか（`selectAll` 系の形）。 */
  coversWholeDocument: boolean;
  visibleLines: VisibleLines | undefined;
  /** 選択テキストを読む。**共有すると決まってから呼ぶこと。** */
  readSelectedText(maxChars: number): string;
}

/**
 * エージェント自身が出している注釈1件の**生の観測**（増分6 D72）。
 *
 * `relPath` は面が `observedRelPath` で作る（パスを決める関数はそれ1つ。`groups` の
 * タブの `relPath` と同じ）。注釈はワークスペースの中にしか作れないので `undefined` には
 * ならないはずだが、なったときに黙って別の名前で名指ししないよう、型は同じにしてある。
 * 本文は**ここにも無い**（§C6: 線に乗せないものは面からも取らない）。
 */
export interface ObservedAnnotation {
  id: number;
  index: number;
  relPath: string | undefined;
  /** 1始まり。 */
  line: number;
  color?: AnnotationColor;
  resolved: boolean;
}

/**
 * 人間の画面を読む面。**`vscode` の値に触るのはこの実装だけ**（`editor-surface.ts`）。
 *
 * `EditorSurface`（`show-code.ts`）と同じ理由で切ってある ―― ハンドラが
 * vscode を値 import していると vitest から読み込めず、判定を1件も単体で
 * 確かめられない。
 */
export interface EditorStateSurface {
  /** VS Code の窓が前面にあるか（設計書 §3.1 条件1）。 */
  windowFocused(): boolean;
  /** 人間が使っているエディタの観測。無ければ undefined。 */
  activeEditor(): ActiveEditorObservation | undefined;
  /**
   * 画面のレイアウトの**生の観測**（設計 D38）。
   *
   * **`openPaths()` は無くなった。** タブの一覧という同じ量を2つの面が
   * 別々に `tabGroups.all` へ問いに行くと、呼ぶタイミングの差で食い違う
   * 。ここが唯一の観測点で、`groups` と `openPaths` は
   * どちらも `buildEditorLayout` がこの1回の観測から畳む。
   *
   * 選別（秘匿・上限・見出しを出すかどうか）はここでは**しない** ――
   * 面は vscode を値 import しているので、判断を置くと単体で確かめられない。
   */
  groups(): ObservedGroup[];
  /**
   * エージェント自身の注釈の**生の観測**（増分6 D72）。読む順（`index`）に並ぶ。
   *
   * 注釈ストアの `list()` 1回から作る。`get_editor_state.annotations` はこれを写すだけで、
   * 選別は無い ―― 注釈は秘匿パスにはそもそも作れない（`annotate` が `excluded-path` で
   * 落とす）ので、伏せ字の分岐が要らない。
   */
  annotations(): ObservedAnnotation[];
}

/**
 * `get_editor_state` の呼び出し回数制限を人間に見せる口。
 *
 * `ShowCodeStatus`（`show_code` / `annotate`）とは別にする ―― あちらの3つは
 * どれもパスを受け取るが、`get_editor_state` には引数が無く、制限は
 * ファイル単位ではなく**呼び出し単位**である。渡せる情報がそもそも無い。
 *
 * `ShowMeStatusBar` が構造的に満たす（`status-bar.ts` の
 * `flashEditorStateRateLimited`。既存の3種と同じ `SinglePendingTimer` に乗る）。
 */
export interface EditorStateStatus {
  flashEditorStateRateLimited(): void;
}

export interface GetEditorStateDeps {
  config: () => ShowMeConfig;
  surface: EditorStateSurface;
  /**
   * 呼び出し回数制限の可視化。**省略できない。**
   *
   * この制限は「人間の作業の連続的な軌跡を取られる」ことへの唯一の歯止め
   * であり、それが無音で発火すると防御として片手落ちになる
   * （設計書 §5.4「副作用は全て画面に出る」）。
   */
  statusBar: EditorStateStatus;
  /**
   * 直前に返した選択の記憶。**省略するとモジュールで1つ共有するものを使う**。
   *
   * 接続をまたいで1つを共有する。接続ごとに作り直すと、切って繋ぎ直すだけで
   * 「同じ選択を二度返さない」が消える（レート制限と同じ理由）。
   */
  memory?: SelectionMemory;
  /** 自ツールがエディタに触った時刻。省略は同上。 */
  clock?: OwnToolCallClock;
  /** 現在時刻。検査で固定するためだけに開けてある。 */
  now?: () => number;
  /**
   * 呼び出し単位の予算。**省略するとモジュールで1つ共有するものを使う**（既定）。
   *
   * `show_code` / `annotate` のファイル単位の予算とは**器から別**にする。
   * 同じ器に入れると、見せる側と読む側が互いの予算を食い合う。
   * 差し替えられるのは検査のためだけで、`extension.ts` は渡さない。
   */
  limiter?: RateLimiter;
}

/**
 * 人間がいま見ている場所を返す（設計書 §3.1）。**この道具が一方向でなくなる転換点。**
 *
 * ## 何を返さないか
 *
 * `selectedText` は**不変条件2「どのツールもファイルの中身を返さない」の唯一の
 * 例外**である。例外を成り立たせているのは2つで、どちらも崩せない:
 *
 * 1. `show_code` が `TextEditor.selection` を変更しない（不変条件3）。だから
 *    エージェントは自分で選択を作って読み出せない。**この2つは対である**
 * 2. `judgeSelection` が観測量から人間由来を組み立てる。VS Code が名乗る
 *    変更の出所は使わない（両方向に誤ることが実機で分かっている）
 *
 * ## 除外パスでは「範囲」も返さない
 *
 * `.env` を開いて選択したとき、返さないのは選択テキストだけでは足りない。
 * **範囲だけでも情報になる** ―― 何行目の何桁から何桁までか、が分かれば、
 * 人間がカーソルを行末へ動かすたびにその行の長さが読める。`KEY=value` の
 * 形式が分かっているファイルでは、それは値の長さそのものである。だから
 * 除外パスでは `cursor` / `selection` / `visibleLines` をまとめて落とす。
 *
 * **`activePath` は返す。** 除外に当たるかどうかは `show_code` に問えば分かる
 * （`excluded-path` が返る）ので、いま見ているファイルの名前を伏せても隠せる
 * ものが無い。伏せるとエージェントは理由の分からない沈黙を受け取り、人間に
 * 問い合わせ続ける。
 *
 * **`openPaths` と `groups` には載せる**（設計 D37。増分3 の判断を覆した）。
 * タブの一覧は、人間が自分の意思で画面に出しているものの**観測**であって、
 * ディレクトリの**列挙**ではない。伏せて得ていたのは「`.env` が存在する」の
 * 1ビットだけで、それは `show_code` に問えば `excluded-path` として既に読める。
 * 一方、伏せるとレイアウトに穴が空き、片づけの判断に使えない一覧になる。
 * **名前は出し、中身に当たるもの（`visibleLines` / `cursor` / `selection` /
 * `selectedText`）は1つ残らず伏せる**（設計 §1.4）。
 *
 * `visibleLines` を落とす理由は `isDirty` を出す理由の裏返しである ――
 * 可視行は人間のスクロールに連動して**動く**量なので、繰り返し観測すると
 * ファイルの行数が決まり、`KEY=value` の形式ではそれが鍵の本数になる。
 */
export function handleGetEditorState(deps: GetEditorStateDeps): Record<string, unknown> {
  // **予算はいちばん先に当てる。** 後ろに置くと、断ったはずの呼び出しでも
  // カーソル位置と可視行だけは返り、軌跡を取る経路がそのまま残る。
  if (!(deps.limiter ?? sharedEditorStateLimiter).allow(EDITOR_STATE_LIMIT_KEY)) {
    // 落とされた試行も画面に出す（`show_code` / `annotate` の回数制限と同じ理由。
    // 設計書 §5.4）。ここは**呼び出し単位**の予算で、特定のパスに紐づかない
    // ので、パスは渡さない。
    deps.statusBar.flashEditorStateRateLimited();
    throw new ToolError(
      "rate-limited",
      "Too many get_editor_state calls. The human's screen cannot be read continuously (wait a while before calling again)",
    );
  }

  const config = deps.config();
  const memory = deps.memory ?? sharedSelectionMemory;
  const clock = deps.clock ?? sharedOwnToolClock;
  const now = deps.now ?? Date.now;

  // **1回の観測から2つに畳む**（不変条件14）。`groups` と `openPaths` を
  // 別々に問いに行くと、呼ぶタイミングの差で食い違う。
  //
  // 上限は**独立した3つの量**である。`maxOpenPaths` は平坦な一覧だけを切り、
  // `maxGroups` / `maxTabsPerGroup` は表示だけを切る。片方からもう片方を
  // 導出すると、「`openPaths.length === MAX_OPEN_PATHS` なら溢れている」という
  // 合図を2つの量が別々に決めることになる。
  const layout = buildEditorLayout(
    deps.surface.groups(),
    (rel) => isRedactedPath(rel, config.redactedPathPatterns),
    {
      maxOpenPaths: MAX_OPEN_PATHS,
      maxGroups: MAX_EDITOR_GROUPS,
      maxTabsPerGroup: MAX_TABS_PER_GROUP,
      maxLabelChars: MAX_TAB_LABEL_CHARS,
    },
  );
  const result: Record<string, unknown> = { openPaths: layout.openPaths };
  // 列が1つも無いときは鍵ごと省く。「レイアウトは空だ」を毎回わざわざ言わない。
  if (layout.groups.length > 0) result.groups = layout.groups;

  // エージェント自身の注釈（増分6 D72）。**面の1回の観測から**写す。本文は載らない（§C6）。
  // 秘匿の分岐は無い ―― 注釈は秘匿パスにはそもそも作れない（`annotate` が関門で
  // `excluded-path` を返す。統合テストが再確認している）。相対パスにできないものは
  // 起きない経路だが、起きたときに別の名前で名指しするより落とす（fail-closed）。
  const annotations: AnnotationState[] = [];
  for (const a of deps.surface.annotations()) {
    if (a.relPath === undefined) continue;
    const entry: AnnotationState = {
      id: a.id,
      index: a.index,
      path: a.relPath,
      line: a.line,
      resolved: a.resolved,
    };
    // 無印は鍵ごと省く（`undefined` の鍵を線に載せない。既定色にも倒さない）。
    annotations.push(a.color === undefined ? entry : { ...entry, color: a.color });
  }
  // 注釈が無いときは鍵ごと省く（`groups` と同じ約束）。
  if (annotations.length > 0) result.annotations = annotations;

  const active = deps.surface.activeEditor();
  if (active === undefined) {
    // 人間が使っているエディタが無い（端末やパネルに居る、あるいは全部閉じている）。
    // 黙って `openPaths` だけを返すと、エージェントには「選択が無い」と区別が
    // つかない。理由を付ける。
    result.selectionWithheld = "not-active";
    return result;
  }

  const relPath = active.relPath;
  const redacted = relPath !== undefined && isRedactedPath(relPath, config.redactedPathPatterns);

  if (relPath !== undefined) {
    result.activePath = relPath;
    if (!redacted) {
      result.cursor = active.cursor;
      result.selection = active.selection;
      if (active.visibleLines !== undefined) result.visibleLines = active.visibleLines;
    }
  }

  const observation: SelectionObservation = {
    outsideWorkspace: relPath === undefined,
    redacted,
    empty: active.empty,
    coversWholeDocument: active.coversWholeDocument,
    windowFocused: deps.surface.windowFocused(),
    isActiveEditor: active.isActiveEditor,
    msSinceOwnToolCall: clock.msSince(now()),
    alreadyReturned:
      relPath !== undefined && memory.wasReturned(selectionKey(relPath, active.selection)),
  };

  const verdict = judgeSelection(observation);
  if (!verdict.share) {
    result.selectionWithheld = verdict.reason;
    return result;
  }
  if (relPath === undefined) {
    // 型の上では起きない（`outside-workspace` が先に当たる）。起きたときに
    // 黙って共有する側へ倒さない。
    result.selectionWithheld = "outside-workspace";
    return result;
  }

  // ここが `selectedText` を結果に入れる**唯一の場所**である。`judgeSelection` が
  // `share: true` を返す唯一の関数で、その内側にしかこの代入は無い。
  //
  // 上限は設定と protocol の絶対上限の小さいほうを採る。設定側だけで切ると、
  // 上限は拡張の善意にだけ依存することになる（信頼境界はソケットなので、
  // ブリッジの結果スキーマ側にも同じ上限が要る）。
  const limit = Math.min(config.maxSelectionChars, MAX_SELECTED_TEXT_CHARS);
  // **無害化（エスケープ）は通さない。** サニタイザは人間の画面に載せるものの
  // ためのもので、ここの読み手はエージェントである。ソースコードの制御文字を
  // エスケープ列に置き換えたら、それは選択されたテキストではない別の文字列になる。
  // 切り詰めだけを、サロゲートペアを割らない実装（protocol に1つ）で行う。
  result.selectedText = truncateDisplayText(active.readSelectedText(limit), limit);
  memory.remember(selectionKey(relPath, active.selection));
  return result;
}
