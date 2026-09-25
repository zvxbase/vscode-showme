/**
 * 画面に触ってよいかの判断（設計 増分5 §C1 / D53 / D53'）。
 *
 * **vscode に触らない。** 触ると vitest から読み込めず、この判断を1件も
 * 単体で確かめられなくなる ―― `editor-surface.ts` が実際にそうなっていて、
 * レビュアが4箇所を定数に潰しても検査が全部緑のままだったことがある。
 *
 * ## なぜ1つの関数に集めるか
 *
 * 「触ってよいか」を面（vscode 側）とハンドラの両方で判断すると、
 * **同じ量を2箇所が別々の方法で決める**ことになる（不変条件14）。
 * この repo はこの形の欠陥を9回作っており、毎回「片方が推測、もう片方が観測」
 * であった。ここでは観測（`own` / `isDirty` / `viewing`）を受け取り、**判断だけ**を返す。
 *
 * close も moveも gatherも、**この1つの述語を通す。**
 *
 * レイアウトのプリセットが人間の列を巻き込むかも、ここ（`layoutWouldMergeHumanColumn`）で
 * 決める（§C3 / D55-2）。面は `groupCount()` と `humanColumn()` の**数を返すだけ**。
 * 道具の列（D90）を巻き込むかも同じ形でここ（`layoutWouldMergeToolColumn` / `layoutVerdict`）。
 */

import type { ArrangeLayoutAction } from "./handlers/arrange-editors.js";
import { NO_AVOIDED_COLUMNS, stageColumnForSlot } from "./stage-column.js";

/** 触る許可。**2つは直交する**（設計 D43）。 */
export interface ArrangePermissions {
  /** 人間のタブを閉じる・動かすことを許すか（`showme.layout.closeHumanTabs`）。 */
  closeHumanTabs: boolean;
  /** 未保存のタブも閉じることを許すか（`showme.layout.closeDirtyTabs`）。 */
  closeDirtyTabs: boolean;
}

/** 画面に対する操作の種類。床2（未保存）が掛かるのは `close` だけ。 */
export type TouchOp = "close" | "move";

/** 触る候補1枚。**判断に要る量だけ**を持つ。 */
export interface TouchCandidate {
  /**
   * 自分（ShowMe）が出した／開いたものか。
   *
   * webview は **`Tab.input` の型と `viewType`** で、テキストタブは
   * **`OpenedByAgent` の記録**で決める（`editor-surface.ts` の `isOwnTab`。D41 / D53）。
   * `label` で決めると、エージェントが `show_html` の `title` を `package.json` に
   * するだけで人間のタブを自分のものと名乗れる。ここに渡る時点でその判断は済んでいる。
   */
  own: boolean;
  /** 未保存か（`Tab.isDirty`）。 */
  isDirty: boolean;
  /**
   * 人間が**見ている**タブか（`activeTabGroup.activeTab`）。窓に1枚しか無い。
   * 各グループの `isActive`（列ごとに1枚）とは別の量である。**観測する。推測しない。**
   */
  viewing: boolean;
}

/**
 * 画面に触ってよいか（設計 §C1）。**close も move もこれ1つ。**
 *
 * ```
 * reach  = own || closeHumanTabs                          // 届いてよいか
 * floor1 = !viewing                                       // 人間が見ているものは触らない。設定で外れない
 * floor2 = op !== "close" || !isDirty || closeDirtyTabs   // 未保存は消さない
 * 触ってよい = reach && floor1 && floor2
 * ```
 *
 * **床は設定で外れない。** `closeHumanTabs: true` でも `viewing` には触らない。
 * `closeDirtyTabs` は床2 だけを外す（未保存を消してよい、と人間が言った場合）。
 *
 * 増分4B の式は `own || (closeHumanTabs && (!isDirty || closeDirtyTabs))` で、
 * 「自分のものは未保存でも消せる」例外を持っていた。webview は未保存になれないので
 * 実害は無かったが、テキストタブが own になる今（D53）、エージェントが開いたファイルを
 * 人間が編集した瞬間に守られなければならない。**例外を消して床を全員に当てる**（D53'）。
 */
export function mayTouch(
  candidate: TouchCandidate,
  op: TouchOp,
  permissions: ArrangePermissions,
): boolean {
  const reach = candidate.own || permissions.closeHumanTabs;
  const floor1 = !candidate.viewing;
  const floor2 = op !== "close" || !candidate.isDirty || permissions.closeDirtyTabs;
  return reach && floor1 && floor2;
}

/** `mayTouch(candidate, "close", permissions)`。既存の呼び出し口のために残す。**別の式を持たない。** */
export function mayClose(candidate: TouchCandidate, permissions: ArrangePermissions): boolean {
  return mayTouch(candidate, "close", permissions);
}

/**
 * プリセットが作る**枠の数**（設計 §C3 / D55-2）。
 *
 * `Record<ArrangeLayoutAction, number>` にしてあるので、語彙に閉じない語を足すと
 * ここが型で落ちる ―― 表の足し忘れが「判定が黙って通る」にならない。
 *
 * **0 は「減らさない」の印**（`even-widths` は幅を揃えるだけで枠の数を変えない）。
 * 減らす操作に 0 を書いてはならない ―― `layoutWouldMergeHumanColumn` が黙って通る。
 *
 * `single-column`（1）は語彙から消した。既に1列でない限り**必ず**人間の列を
 * 巻き込む語だった。**ここに戻さない**（戻すと `Record` が型で通ってしまう ―― 語彙の
 * 側にも無いことを `arrange-action.test.ts` が見ている）。
 */
export const TARGET_GROUPS: Record<ArrangeLayoutAction, number> = {
  "two-columns": 2,
  "three-columns": 3,
  "two-rows": 2,
  grid: 4,
  "even-widths": 0, // 減らさない
};

/**
 * プリセットで人間の列が別の列に合流するか（設計 §C3 / D55-2。所見4b・4c）。
 *
 * VS Code の `editorLayout*` は**枠を作るだけ**で、既存のタブを再配置しない。
 * 目標より多いグループは**最後の枠に合流**する。合流は一方通行（戻す API が無い）。
 * だから**呼ぶ前に**判定し、危険なら呼ばない（`done: false` + `withheld`）。
 *
 * ```
 * 減らさない操作（target 0）     → 安全
 * currentGroups <= targetGroups → 減らないので安全
 * humanColumn が観測できない    → 断る（どの列が人間か言えないのに、一方通行の合流は通せない）
 * humanColumn >= targetGroups   → 人間が最後の枠かそれより後ろに居る → 合流する
 * ```
 *
 * **観測できないときは断る側に倒す。** 面が `1` を名乗って渡すと、`>=` の最も緩い値に
 * なって合流を許す（fail-open）。安全側の判定の既定値は「通す」ではなく「断る」。
 * 上の2行（減らさない／減らない）は人間の列と無関係なので、観測できなくても通る。
 *
 * 境界の `h == t` は**合流する**側である ―― 人間が最後の枠に居て、後ろの列が
 * そこへ流れ込む。`>=` を `>` にすると `[2,3,2]`（人間が列2、3列→2列）が通ってしまう。
 *
 * `humanColumn` は **`activeTabGroup.viewColumn` の観測**である。列の位置から
 * 推測してはならない（増分2B で「最左が人間」と推測して人間の列を奪った量と同じ）。
 *
 * target 1（かつての `single-column`）は、既に1列でない限り**必ず**真になる ―― 人間が
 * 列1に居ても列2以降が人間の列に流れ込む。だからその語は語彙から消えた。
 */
export function layoutWouldMergeHumanColumn(
  targetGroups: number,
  currentGroups: number,
  humanColumn: number | undefined,
): boolean {
  if (!layoutReducesGroups(targetGroups, currentGroups)) return false; // 減らさない／減らない
  if (humanColumn === undefined) return true; // 観測できない → 断る（推測で通さない）
  return columnIsCaughtInMerge(humanColumn, targetGroups); // 人間が最後の枠以降に居る
}

/**
 * 減らすプリセットで、列 `column` が合流に巻き込まれるか: 最後の枠（`targetGroups`）に居れば
 * 後ろの列が流れ込み、それより後ろに居ればその列そのものが流れ込む。人間の列（D55-2）と
 * 道具の列（D90）の**両方がこれ1つ**を通す ―― 境界を2箇所で書くと片方だけ `>` になりうる。
 */
function columnIsCaughtInMerge(column: number, targetGroups: number): boolean {
  return column >= targetGroups;
}

/**
 * プリセットで道具の列（ターミナル・他の拡張のパネル・型の分からない入力の列。D90）が合流するか。
 *
 * `layoutWouldMergeHumanColumn` と**同じ形**: 減らさない／減らないなら無関係、減らすなら
 * 道具の列のどれかが最後の枠以降に居れば合流する。避ける列が空（設定がオフ）なら常に false。
 */
export function layoutWouldMergeToolColumn(
  targetGroups: number,
  currentGroups: number,
  avoid: ReadonlySet<number>,
): boolean {
  if (!layoutReducesGroups(targetGroups, currentGroups)) return false;
  for (const column of avoid) {
    if (columnIsCaughtInMerge(column, targetGroups)) return true;
  }
  return false;
}

/** プリセットを呼んでよいかの判定。`reason` は `withheld` の語彙（`ArrangeWithheldReason`）。 */
export type LayoutVerdict =
  | { ok: true }
  | { ok: false; reason: "human-column-would-merge" | "tool-column-would-merge" };

/**
 * プリセットを呼んでよいか（§C3 / D55-2 と D90）。ハンドラはこれ1つを通す。
 *
 * ```
 * 人間の列が合流する → human-column-would-merge（どの設定でも外れない）
 * 道具の列が合流する → tool-column-would-merge（avoid は設定がオンのときだけ空でない）
 * それ以外           → 通す
 * ```
 *
 * **人間の列を先に、理由は1つだけ返す。** 人間の列の合流は設定で外れないので、道具の理由を
 * 並べると、エージェントは「設定をオフにすれば通る」と読んで人間に頼み、また断られる。
 * `avoid` の既定は空で、そのときは `layoutWouldMergeHumanColumn` だけの以前の答え。
 */
export function layoutVerdict(
  targetGroups: number,
  currentGroups: number,
  humanColumn: number | undefined,
  avoid: ReadonlySet<number> = NO_AVOIDED_COLUMNS,
): LayoutVerdict {
  if (layoutWouldMergeHumanColumn(targetGroups, currentGroups, humanColumn)) {
    return { ok: false, reason: "human-column-would-merge" };
  }
  if (layoutWouldMergeToolColumn(targetGroups, currentGroups, avoid)) {
    return { ok: false, reason: "tool-column-would-merge" };
  }
  return { ok: true };
}

/**
 * プリセットが列を**減らす**か（＝合流が起きるか）。
 *
 * `layoutWouldMergeHumanColumn` の前半（呼ぶ前の「減るか」）と、面の `applyLayout` が
 * 呼んだ後に「合流が終わった」を観測する述語（`!layoutReducesGroups(target, いまの列数)`）は
 * **同じ量**である。別々に書くと、片方に `0` の印の扱いが抜けて不変条件14 の
 * 11件目になる。
 *
 * ```
 * targetGroups <= 0             → false（減らさない印。even-widths）
 * currentGroups <= targetGroups → false（減らない）
 * それ以外                       → true（余ったグループが最後の枠に合流する）
 * ```
 */
export function layoutReducesGroups(targetGroups: number, currentGroups: number): boolean {
  if (targetGroups <= 0) return false; // 減らさない操作
  return currentGroups > targetGroups;
}

/** `ownedUrisToRestore` の入力。`own` は**操作の前**に `listTabs()` が観測した値。 */
export interface OwnedBefore {
  /** `Uri.toString()`（`OpenedByAgent` の鍵と同じ）。 */
  uri: string;
  own: boolean;
}

/**
 * 自分の操作（`move-tab` / `gather-own` の移動、プリセットの合流）のあとで、
 * own を**記録し直す** URI（設計 §C2 / D59）。
 *
 * VS Code はタブの移動もレイアウトの合流も「閉じて開き直す」として扱い、
 * `OpenedByAgent` は**どの close 事象でも**忘れる（人間が動かしたタブは人間のもの、
 * という意図した意味論。`opened-by-agent.ts`）。合流の close は人間のドラッグと
 * 同じ形で区別がつかない ―― だが**自分が呼んだ操作の中で起きた close は自分の仕業**
 * なので、操作が終わったのを観測してから記録し直す。決めるのはここ1つで、
 * `arrange-surface.ts` の移動とプリセットの両方がこれを通す（不変条件14）。
 *
 * ```
 * 記録し直す = 前に own だった && 後に同じ URI のテキストタブがちょうど1枚
 * ```
 *
 * - 「ちょうど1枚」は `isOwnTab` の規則と同じ量（2枚以上なら人間が関わっていて、
 *   どちらが自分の1枚か言えない）。記録しても own にならないものは記録しない
 * - 後に無い（閉じられた）ものは記録しない。記録すると、次に人間が同じファイルを
 *   開いたときに own になる（D53「閉じたら忘れる」の逆戻り）
 * - **前に own でなかったものは決して記録しない。** 同じ合流で人間のタブも動くが、
 *   それは人間のもののまま（`closeHumanTabs` で人間のタブを動かしても own にはならない）
 *
 * @param before 操作の前の観測（`listTabs()` の `own` と同じ判定）。順序は保つ
 * @param after 操作の後の観測（窓の全テキストタブ）
 * @returns 記録し直す URI。`before` の順、重複なし
 */
export function ownedUrisToRestore(
  before: readonly OwnedBefore[],
  after: ReadonlyArray<{ uri: string }>,
): string[] {
  const count = new Map<string, number>();
  for (const { uri } of after) count.set(uri, (count.get(uri) ?? 0) + 1);
  const out: string[] = [];
  for (const { uri, own } of before) {
    if (!own) continue;
    if (count.get(uri) !== 1) continue;
    if (out.includes(uri)) continue;
    out.push(uri);
  }
  return out;
}

/** 移動先の判定の結果。`reason` は閉じた語彙（`invalid-request` はエラー、もう1つは `withheld`）。 */
export type MoveTargetVerdict =
  | { ok: true }
  | { ok: false; reason: "invalid-request" | "human-column-target" | "tool-column-target" };

/**
 * `toColumn` へ動かしてよいか（設計 D59）。**`move-tab` も `move-panel` もこれ1つ。**
 *
 * ```
 * toColumn が 1..groupCount+1 の整数でない → invalid-request（VS Code は飛び番の枠を作る）
 * humanColumn が観測できない            → human-column-target（どの列が人間か言えないのに流し込まない）
 * toColumn === humanColumn              → closeHumanTabs が無ければ human-column-target
 * toColumn が避ける列（D90）             → tool-column-target
 * ```
 *
 * 道具の列へ動かすと、動かしたタブがその列の表示中になり、ターミナルや他の拡張のパネルに被さる
 * ―― `show_code` が避けたのと同じことを移動で起こす。だから設定がオンなら**行き先として**断る。
 * 道具の列**から**自分のタブを出すのは通る（行き先だけを見る）。`closeHumanTabs` では外れない
 * （人間のタブの許可であって、道具の列の許可ではない。外すのは設定をオフにすること）。
 * `avoid` の既定は空で、そのときは以前の答え。
 *
 * 人間の列にタブを流し込むのは `single-column` が起こしたことと同じである。
 * `closeHumanTabs: true` は「人間の面に触ってよい」の宣言なので、そのときだけ通す。
 *
 * **観測できないときは断る側に倒す**（`layoutWouldMergeHumanColumn` と同じ）。設定を
 * 立てていても通さない ―― 人間の列が分からない状態で「人間の列に触ってよい」は
 * 判定できない。`groupCount+1` を許すのは、右端の外側に**1つだけ**新しい列を作るのは
 * 意図どおりの結果になるから（それより先は VS Code が空の枠を挟む）。
 */
export function moveTargetVerdict(
  toColumn: number,
  groupCount: number,
  humanColumn: number | undefined,
  permissions: ArrangePermissions,
  avoid: ReadonlySet<number> = NO_AVOIDED_COLUMNS,
): MoveTargetVerdict {
  if (!Number.isInteger(toColumn) || toColumn < 1 || toColumn > groupCount + 1) {
    return { ok: false, reason: "invalid-request" };
  }
  if (humanColumn === undefined) return { ok: false, reason: "human-column-target" };
  if (toColumn === humanColumn && !permissions.closeHumanTabs) {
    return { ok: false, reason: "human-column-target" };
  }
  if (avoid.has(toColumn)) return { ok: false, reason: "tool-column-target" };
  return { ok: true };
}

/**
 * `gather-own` の集め先（設計 D55-1）: **舞台の最初の列** ―― 人間の列より右で最小の列。
 * 右に無ければ人間の隣（新しい列）。
 *
 * **「舞台の最初の列」を決めているのは `stage-column.ts` の `chooseStageColumns` である**
 * （`show_code` が `layout: "single"` で開く列と同じ量）。ここで別の式を書くと、
 * `show_code` が開く列と `gather-own` が集める列がずれる（不変条件14 ―― 初版は
 * 実際に別の式を書いていた。レビュー I2）。`stageColumnForSlot(columns, "single", 0, human)`
 * を通し、`test/arrange-policy.test.ts` が生成した表の全組み合わせで等しいことを見ている。
 *
 * 人間の列そのものは**決して**返さない ―― 返せば `single-column` の再来である。
 * 人間の列が観測できなければ `undefined`（推測で集め先を決めない。ハンドラが断る）。
 * `stageColumnForSlot` は `humanColumn` 省略時に「最小の列が人間」と**推測**するので、
 * ここで先に止める。可視列が無く番号が決まらない（"beside"）ときも `undefined`。
 *
 * `columns` は `tabGroups.all` の `viewColumn`（観測）。並び順を仮定しない。
 *
 * `avoid` は舞台に選ばない列（D90。ターミナルや他の拡張のパネルを表示している列）。
 * `show_code` と同じ集合を `stageColumnForSlot` にそのまま渡す ―― ここで別に除くと、
 * 避けた結果の列が2箇所で決まる。既定は空で、そのときは避ける列の無い以前の答え。
 */
export function firstStageColumn(
  columns: readonly number[],
  humanColumn: number | undefined,
  avoid: ReadonlySet<number> = NO_AVOIDED_COLUMNS,
): number | undefined {
  if (humanColumn === undefined) return undefined;
  const column = stageColumnForSlot(columns, "single", 0, humanColumn, avoid);
  return column === "beside" ? undefined : column;
}
