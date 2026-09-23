import * as path from "node:path";
import {
  type PanelSlot,
  type TabKind,
  normalizeWorkspaceRelative,
  truncateDisplayText,
} from "@zvx/vscode-showme-protocol";

/**
 * 人間の画面から読んだものを、線に載る形へ落とす**判断だけ**を集めたところ。
 *
 * **`vscode` を値として読まない。** 読むとこのファイルは vitest から読み込めず、
 * ここにある判断を1件も単体で確かめられなくなる。`editor-surface.ts` が
 * 実際にそうなっていて、レビュアが4箇所（`windowFocused` / `isActiveEditor` /
 * `coversWholeDocument` / `openPaths` の打ち切り）を定数に潰しても
 * **613+50件がすべて緑のまま**だった ―― 判定を担う層に検査が1件も当たって
 * いなかったということである。
 *
 * `human-selection.ts`（返してよいかの判定）と対になる。あちらは受け取った
 * 真偽値で決め、ここはその真偽値と数値そのものを作る。vscode に触るのは
 * `editor-surface.ts` に残った薄い層だけである。
 */

/** 0始まりの行・桁で表した範囲。vscode の `Range` / `Selection` と同じ数え方。 */
export interface ZeroBasedRange {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

/** 画面に見えている行の範囲（1始まり、両端を含む）。 */
export interface VisibleLineRange {
  start: number;
  end: number;
}

/**
 * `vscode.Uri` のうち、相対化に要る分だけ。
 *
 * 型を絞ることで、この関数が `fsPath` だけを見て済ませていないこと
 * （scheme と authority も要求すること）が呼び出し側からも読める。
 */
export interface UriParts {
  scheme: string;
  authority: string;
  fsPath: string;
}

/**
 * URI をワークスペース相対パスに直す。**直せないものは undefined**。
 *
 * `asRelativePath` を使わない ―― 多ルートではフォルダ名を頭に付けるうえ、
 * ワークスペースの外の URI をそのまま絶対パスで返す（＝外の場所の名前が
 * 「相対パス」の顔をして線に載る）。ここは fail-closed でなければならない。
 *
 * scheme と authority も一致を要求する。`untitled:` / `git:` / `output:` /
 * 別ホストの `vscode-remote:` は、`fsPath` だけを見るとルートの下にあるように
 * 見えることがあるが、同じファイルではない。
 */
/**
 * `TabGroup.viewColumn` が**観測できた列番号**なら返し、そうでなければ `undefined`。
 *
 * `ViewColumn` には負の別名（`Active` = -1 / `Beside` = -2）がある。実際の
 * `TabGroup.viewColumn` は具体的な列番号なので外れは起きない ―― だが起きたときに
 * `1` へ丸めると、**黙って別の列を名乗る**。それは観測ではなく推測であり、
 * D39「返せないものは返さない。推測もしない」に反する。
 *
 * **この量を読む場所は2つある**（`get_editor_state` の `groups` と、`arrange_editors`
 * の人間の列）。可否の条件をそれぞれに書くと、後から書いたほうが緩くなる
 * （不変条件14 の7件目の形。実際 `typeof === "number"` だけの版が -1 を通していた）。
 * どちらもこの1つを通す。
 */
export function observedViewColumn(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : undefined;
}

export function relativizeToRoot(root: UriParts | undefined, uri: UriParts): string | undefined {
  if (root === undefined) return undefined;
  if (uri.scheme !== root.scheme || uri.authority !== root.authority) return undefined;
  const rel = path.relative(root.fsPath, uri.fsPath);
  if (rel.length === 0) return undefined;
  // 綴りの正規化・脱出の拒否・NTFS 代替データストリームの拒否は protocol に1つ。
  return normalizeWorkspaceRelative(rel);
}

/**
 * 選択が文書全体を覆っているか（`selectAll` 系の形。設計書 §3.1 条件3）。
 *
 * 末尾の比較を `>=` にしてあるのは、`selectAll` が最終行の行末より後ろ
 * （改行の向こう側）を指すことがあるからである。`===` にすると、その形が
 * 「全体ではない」に落ちて素通りする。
 */
export function coversWholeDocument(
  selection: ZeroBasedRange,
  lastLine: number,
  lastLineEndCharacter: number,
): boolean {
  return (
    selection.startLine === 0 &&
    selection.startCharacter === 0 &&
    selection.endLine >= lastLine &&
    selection.endCharacter >= lastLineEndCharacter
  );
}

/**
 * 可視範囲の集まりから、画面に見えている行の範囲（1始まり）を作る。
 *
 * 折り畳みがあると `visibleRanges` は複数になるので、最小と最大で畳む。
 * 1つも無いときは undefined（`visibleLines` を返さない）。
 */
export function visibleLineRange(
  ranges: readonly { startLine: number; endLine: number }[],
): VisibleLineRange | undefined {
  if (ranges.length === 0) return undefined;
  return {
    start: Math.min(...ranges.map((r) => r.startLine)) + 1,
    end: Math.max(...ranges.map((r) => r.endLine)) + 1,
  };
}

/**
 * 選択範囲を「先頭から maxChars 文字ぶん」に切り詰めた範囲。
 *
 * 選択そのものを `getText` に渡すと、人間がファイルの9割を選択していれば
 * その9割が文字列として組み立てられる ―― 返すのは高々 4000 文字なのに、である。
 * 行を先頭から必要な分だけ辿って範囲を縮める。改行が1行につき最低1文字を消費
 * するので、繰り返しは maxChars 回で必ず止まる。
 *
 * `lineEndCharacter` は「その行の行末の桁」を返す関数。文書に触る唯一の口で、
 * ここを注入にしてあるので算術だけを単体で確かめられる。
 */
export function capSelectionRange(
  selection: ZeroBasedRange,
  lineEndCharacter: (line: number) => number,
  maxChars: number,
): ZeroBasedRange {
  const head = { startLine: selection.startLine, startCharacter: selection.startCharacter };
  let remaining = Math.max(1, maxChars);
  let line = selection.startLine;
  let character = selection.startCharacter;
  while (line <= selection.endLine) {
    const lineEnd = line === selection.endLine ? selection.endCharacter : lineEndCharacter(line);
    const available = Math.max(0, lineEnd - character);
    if (available >= remaining) {
      return { ...head, endLine: line, endCharacter: character + remaining };
    }
    remaining -= available;
    if (line === selection.endLine) break;
    remaining -= 1; // 改行
    if (remaining <= 0) return { ...head, endLine: line, endCharacter: lineEnd };
    line += 1;
    character = 0;
  }
  return selection;
}

/**
 * タブの種類。**閉じた語彙**。`Tab.input` の型から決める。
 *
 * **定義元は protocol の `TAB_KINDS` ただ1つ**（そこから導く）。ここに同じ
 * 並びをもう一度書くと、片方だけ語が増えたときに線と型が黙ってずれる
 * （不変条件14）。
 */
export type { TabKind };

/** 面から渡ってくる、1枚ぶんの生の観測。**判断は入っていない。** */
export interface ObservedTab {
  /** VS Code が出している見出し。**そのまま返すとは限らない**（D37'）。 */
  label: string;
  kind: TabKind;
  /** ワークスペース相対パス。相対化できなければ undefined。 */
  relPath: string | undefined;
  /** 自分（ShowMe）が出した webview か（`viewType` で判定。D41）。 */
  own: boolean;
  /**
   * 自分の webview の枠（`show_html` の `slot`。C5 / D61）。**面が `viewType` から読んで渡す**
   * （`own` と同じ表 `own-view-type.ts`。ここで決め直さない）。自分の webview 以外は `undefined`。
   */
  slot?: PanelSlot;
  isActive: boolean;
  isDirty: boolean;
  isPinned: boolean;
  isPreview: boolean;
  /** 可視エディタがあるタブだけ。**秘匿ファイルでは落とす**。 */
  visibleLines: VisibleLineRange | undefined;
}

export interface ObservedGroup {
  viewColumn: number;
  isActive: boolean;
  tabs: ObservedTab[];
}

/** 線に載るタブ1枚。**false の旗は欄ごと省く**（毎回「違う」と言わない）。 */
export interface TabState {
  label: string;
  kind: TabKind;
  path?: string;
  own?: true;
  /** own の webview だけ（C5）。 */
  slot?: PanelSlot;
  isActive?: true;
  isDirty?: true;
  isPinned?: true;
  isPreview?: true;
  visibleLines?: VisibleLineRange;
}

export interface EditorGroupState {
  viewColumn: number;
  isActive?: true;
  tabs: TabState[];
}

export interface EditorLayout {
  groups: EditorGroupState[];
  openPaths: string[];
}

export interface LayoutLimits {
  /** 平坦な一覧に載せるパスの本数。**列やタブの表示上限とは別の量**（下記）。 */
  maxOpenPaths: number;
  maxGroups: number;
  maxTabsPerGroup: number;
  maxLabelChars: number;
}

/**
 * 名前を出さないタブの見出し（D37'）。**種類だけを言う固定文字列**。
 *
 * ワークスペースの外のファイル名・端末の見出し・他人の webview の題は
 * 返さない。返せば**ホストのファイル名を列挙する新しいチャネル**になり、
 * レイアウトを読むのには1文字も要らない。
 */
const PLACEHOLDER_LABEL: Record<"outside" | "terminal" | "other", string> = {
  outside: "(outside workspace)",
  terminal: "(terminal)",
  other: "(other)",
};

/**
 * 人間の画面のレイアウトを、線に載る形へ畳む（設計 §1.3）。
 *
 * **1回の観測から `groups` と `openPaths` の2つを作る。** 別々に
 * `tabGroups.all` を読むと、呼ぶタイミングの差で食い違う ―― 不変条件14 の形を
 * こちらから作ることになる。`openPaths` は同じ観測を畳んだもう1つの**表現**で
 * あって、独立した観測ではない。だから走査も1回で、パスを取り出す場所も1つ。
 *
 * **秘匿判定もここで1回だけ当てる。** 面に置くと、`groups` 側と `openPaths` 側で
 * 別々に当たる形になる。
 *
 * **`openPaths` は表示の上限（`maxGroups` / `maxTabsPerGroup`）では削らない。**
 * 削ると「`openPaths.length` が `maxOpenPaths` に達していれば溢れている」という
 * 合図が壊れる ―― 本数という1つの量を、平坦な一覧の上限と画面の表示上限の
 * 2箇所が別々に決めることになるからである。1列に30枚開いている人間に対して、
 * 上限40を宣言しながら24本で黙って打ち切る（＝安全側に閉じすぎて機能が死ぬ）
 * 向きの壊れ方も、これで塞がる。
 */
export function buildEditorLayout(
  observed: readonly ObservedGroup[],
  isRedacted: (rel: string) => boolean,
  limits: LayoutLimits,
): EditorLayout {
  const maxOpenPaths = Math.max(0, limits.maxOpenPaths);
  const maxGroups = Math.max(0, limits.maxGroups);
  const maxTabsPerGroup = Math.max(0, limits.maxTabsPerGroup);

  const groups: EditorGroupState[] = [];
  const openPaths: string[] = [];
  const seen = new Set<string>();

  for (const [groupIndex, group] of observed.entries()) {
    const shown = groupIndex < maxGroups;
    const tabs: TabState[] = [];
    for (const [tabIndex, tab] of group.tabs.entries()) {
      // パスを取り出す口はここ1つ。`groups` に載るかどうかとは独立に畳む。
      // 出してよいかの判断は `disclosablePath` ただ1つ（`tabs` 側と同じ答え）。
      const rel = disclosablePath(tab);
      if (rel !== undefined && !seen.has(rel)) {
        seen.add(rel);
        if (openPaths.length < maxOpenPaths) openPaths.push(rel);
      }
      if (!shown || tabIndex >= maxTabsPerGroup) continue;
      tabs.push(toTabState(tab, isRedacted, limits.maxLabelChars));
    }
    if (!shown) continue;
    const state: EditorGroupState = { viewColumn: group.viewColumn, tabs };
    if (group.isActive) state.isActive = true;
    groups.push(state);
  }

  return { groups, openPaths };
}

/** 文書として中身を持つ種類。ここだけが本当の名前を出しうる。 */
const DOCUMENT_KINDS: readonly TabKind[] = ["file", "diff", "notebook", "notebook-diff"];

/**
 * 名前を出してよい、ワークスペース内のパス（D37'）。**ここが唯一の判断点。**
 *
 * `relPath` が立っていることだけを根拠にすると、安全は「面が
 * `TabInputWebview` に URI を付けない」という**別のファイルの作法**に
 * 乗ることになる ―― 次に足された入口が付けた時点で穴が開く。種類まで
 * 見れば、その依存が構造に変わる（不変条件14 の「判断は1箇所」）。
 *
 * `path` / 見出し / `visibleLines` / `openPaths` は**すべてこの1つの答え**を
 * 使う。別々に `relPath` を見に行くと、また片方だけが緩む。
 */
function disclosablePath(tab: ObservedTab): string | undefined {
  if (tab.relPath === undefined) return undefined;
  return DOCUMENT_KINDS.includes(tab.kind) ? tab.relPath : undefined;
}

/** 生の観測1枚を線に載る形へ。**false の旗は欄ごと省く。** */
function toTabState(
  tab: ObservedTab,
  isRedacted: (rel: string) => boolean,
  maxLabelChars: number,
): TabState {
  const path = disclosablePath(tab);
  // 秘匿判定は**綴りがあれば必ず当てる**（`path` ではなく `relPath` を見る）。
  // 出さないと決めた種類でも、判定だけは fail-closed の側に倒しておく。
  const redacted = tab.relPath !== undefined && isRedacted(tab.relPath);
  const state: TabState = { label: labelFor(tab, maxLabelChars), kind: tab.kind };
  if (path !== undefined) state.path = path;
  if (tab.own) state.own = true;
  // 枠は面が観測した値をそのまま写す（付くのは own の webview だけ ―― どれに付くかは面の
  // `slotOfViewType` が決めていて、ここで `own` と突き合わせて決め直さない）。
  if (tab.slot !== undefined) state.slot = tab.slot;
  if (tab.isActive) state.isActive = true;
  if (tab.isDirty) state.isDirty = true;
  if (tab.isPinned) state.isPinned = true;
  if (tab.isPreview) state.isPreview = true;
  // **可視行は「ワークスペースの中」かつ「秘匿でない」ときだけ返す。**
  //
  // 人間がスクロールするたびに動く連続量なので、繰り返し観測すると
  // ファイルの行数（`.env` なら鍵の本数）が決まる。`isDirty` のような
  // 動かない1ビットとはここが違う（設計 §1.4）。
  //
  // **`!redacted` だけでは足りない**（実測で漏れていた）。ワークスペースの
  // 外のタブは `relPath` が `undefined` なので `redacted` が false になり、
  // 名前は伏せたまま**スクロール窓だけが返っていた** ―― 人間が許可すら
  // していないファイルについて、である（§1.4b の一覧に `visibleLines` は無い）。
  // 同じ量を `handlers/get-editor-state.ts` は「中 かつ 非秘匿」で切っていた。
  // 同じ量を2つの述語が別々に決め、新しいほうが緩かった（不変条件14）。
  if (path !== undefined && !redacted && tab.visibleLines !== undefined) {
    state.visibleLines = tab.visibleLines;
  }
  return state;
}

/**
 * 返してよい見出しを決める（D37'）。
 *
 * **ここが唯一の判断点である。** 「ワークスペースの中のファイル」か
 * 「自分が出したもの」だけが本当の見出しを持ち、それ以外は種類を言うだけになる。
 *
 * 切り詰めは `protocol` の `truncateDisplayText` に通す ―― 同じ数え方を
 * 2箇所に書かない（サロゲートの境界計算が2つあると、片方だけ直る）。
 * 置き換えた固定文字列も同じ関門を通す。上限を1箇所で決めるためである。
 */
function labelFor(tab: ObservedTab, maxChars: number): string {
  return truncateDisplayText(rawLabelFor(tab), maxChars);
}

function rawLabelFor(tab: ObservedTab): string {
  if (tab.own) return tab.label;
  // **種類まで見る**（`disclosablePath`）。`relPath` が立っていることだけを
  // 根拠にすると、webview に URI を付けない作法が破られた瞬間に他人のパネルの
  // 題が素通りする。
  if (disclosablePath(tab) !== undefined) return tab.label;
  if (tab.kind === "terminal") return PLACEHOLDER_LABEL.terminal;
  // 種類は文書なのに相対化できない ＝ ワークスペースの外。
  if (DOCUMENT_KINDS.includes(tab.kind)) return PLACEHOLDER_LABEL.outside;
  return PLACEHOLDER_LABEL.other;
}
