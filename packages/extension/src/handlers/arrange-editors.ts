import {
  type ArrangeAction,
  type ArrangeCloseAction,
  type ArrangeMoveAction,
  type ArrangeWithheldReason,
  DEFAULT_PANEL_SLOT,
  type PanelSlot,
  arrangeActionCloses,
  arrangeActionMoves,
} from "@zvx/vscode-showme-protocol";
import {
  type ArrangePermissions,
  TARGET_GROUPS,
  layoutVerdict,
  mayClose,
  mayTouch,
  moveTargetVerdict,
} from "../arrange-policy.js";
import type { ShowMeConfig } from "../config.js";
import { placeStageColumn } from "../stage-column.js";
import { ToolError } from "../tool-error.js";
import type { WorkspacePathVerdict } from "../workspace-path-gate.js";

/**
 * `arrange_editors`（設計 §2）。
 *
 * **人間のワークスペースに触る唯一のツールである。** だから判断を
 * `arrange-policy.ts` の純関数に預け、ここは「どの候補を渡すか」と
 * 「何を断ったか」だけを組み立てる。
 *
 * ## 何を閉じるかは面が決めない
 *
 * 面（`arrange-surface.ts`）は `listTabs()` で観測を返し、`closeTabs(ids)` で
 * 言われたものを閉じるだけである。面に判断を置くと、vscode を値 import して
 * いるせいで単体で確かめられない ―― そして「閉じてよいか」は、この道具で
 * **いちばん確かめなければならない判断**である。
 *
 * > **候補を決めるのはここ、許可を決めるのは policy、面は言われたとおりにする。**
 *
 * 同じ「閉じてよいか」をここと面の両方で決めると、それが不変条件14 の
 * 8件目になる（この repo は同じ形の欠陥を7回作っている。毎回
 * 「片方が推測、もう片方が観測」であった）。
 */

/** 面が移動の直前に渡す、**新しい**観測。 */
export interface FreshColumns {
  columns: readonly number[];
  humanColumn: number | undefined;
  /**
   * いま存在する列の数（`tabGroups.all.length`）。`Stage.targetColumn` が丸めに使うのと同じ量で、
   * `gather-own` の集め先を `show_code` と同じ答えにするために渡す。
   */
  groupCount: number;
  /**
   * 道具の列（表示中のタブがターミナル・他の拡張のパネル・型の分からない入力の列。D90）。
   * 面は設定に依らず観測して渡し、使うかどうかはハンドラが `showme.stage.avoidToolColumns` で決める。
   */
  toolColumns: ReadonlySet<number>;
}

/**
 * 移動先の決め方（ハンドラの純関数）。面は1枚動かすごとに新しい観測で呼ぶ。
 * `ok: false` なら面はそこで**止まる**（残りは動かさない）。
 */
export type MoveTargetDecider = (fresh: FreshColumns) => MoveTargetDecision;
export type MoveTargetDecision =
  | { ok: true; column: number }
  | { ok: false; reason: MoveHaltReason };

/** 移動を止めた理由。`invalid-request` 以外は `withheld` の語彙（`ArrangeWithheldReason`）でもある。 */
export type MoveHaltReason =
  | "invalid-request"
  | "human-column-target"
  | "tool-column-target"
  | "no-stage-column";

/** `moveTabs` の結果。`moved` は**実際に列が変わった枚数**（既に居たものは数えない）。 */
export interface MoveOutcome {
  moved: number;
  /** 引けなかった札（観測後に人間が閉じた）と、開けなかった／閉じられなかった枚数。 */
  failed: number;
  /** `decide` が止めた理由。止めたら残りは動かしていない。 */
  halted?: MoveHaltReason;
}

/**
 * 面から渡ってくるタブ1枚。`id` は面の中でだけ意味を持つ不透明な札。
 *
 * **`label` は無い。** 題はエージェントが `show_html` の `title` で決められるので、
 * 題で選ぶ経路をここに作らない（D41）。タブは `path`（実体の正準名）で指す。
 */
export interface ArrangeTab {
  id: string;
  /** テキスト（`TabInputText`）か、webview か、それ以外（差分・端末・ノートブック等）。 */
  kind: "text" | "webview" | "other";
  /**
   * テキストタブの**正準**ワークスペース相対パス（実体まで辿った名前。
   * `editor-surface.ts` の `observedRelPath` ―― `get_editor_state` の `path` と同じ関数）。
   * ワークスペースの外・辿れないものは `undefined`。webview には無い。
   * `move-tab` の `path` は関門（`acceptWorkspacePath`）の正準名と**これ**を突き合わせる。
   */
  path?: string;
  /** 載っている列（`observedViewColumn`）。読めなければ `undefined`。 */
  column?: number;
  /**
   * 自分（ShowMe）が出した webview／開いたテキストタブか。
   * **`Tab.input` の型と、`OpenedByAgent` の記録で決める**（D41 / D53）。
   */
  own: boolean;
  /**
   * 自分の webview の枠（`get_editor_state` が返す `slot` と**同じ関数** `ownPanelSlot` で
   * 面が付ける。D61）。own の webview だけが持つ。`move-panel { slot }` はこれと突き合わせる。
   */
  slot?: PanelSlot;
  isDirty: boolean;
  /** その列でアクティブか（列ごとに1枚）。 */
  isActive: boolean;
  /**
   * 人間が**見ている**タブか（`activeTabGroup.activeTab`。窓に1枚）。
   * `isActive` とは別の量。**観測する。推測しない**（§C1 の床1）。
   */
  viewing: boolean;
}

/** エディタの配置に触る面。`vscode` に触る実装は `arrange-surface.ts` にある。 */
export interface ArrangeSurface {
  listTabs(): ArrangeTab[];
  /** 札で指したタブを閉じる。**判断はしない**（言われたものを閉じる）。 */
  closeTabs(ids: readonly string[]): Promise<boolean>;
  /** 列の構成を変える。タブは閉じない。 */
  applyLayout(action: ArrangeLayoutAction): Promise<boolean>;
  /**
   * 札で指したテキストタブを動かす（D59）。**判断はしない。**
   *
   * - 札は**最初の `await` の前に全部引く**（`closeTabs` と同じ形。レビュー I1）。
   *   引いたあとに別の要求が `listTabs()` を呼んでも、動かす対象は変わらない
   * - 移動先は1枚ごとに `decide` に**新しい観測**を渡して決め直す（レビュー I3）。
   *   元の列が空になると VS Code が閉じて列が繰り上がるので、最初に決めた番号を
   *   使い続けると人間が右端に居るとき収束しない。決めるのはハンドラの純関数で、
   *   面は観測を渡すだけ
   * - 面の中で「開いてから閉じる」順序と own の再記録を守る
   * - 1要求で共有する期限を持つ（`moved` は期限内に完了した枚数）
   */
  moveTabs(ids: readonly string[], decide: MoveTargetDecider): Promise<MoveOutcome>;
  /** 枠 `slot` の自分の webview パネルを `toColumn` へ動かす（`reveal`）。パネルが無ければ false。 */
  movePanel(slot: PanelSlot, toColumn: number): Promise<boolean>;
  /**
   * いまのエディタグループの列番号（`tabGroups.all` の `viewColumn`）。**観測を返すだけで
   * 判断しない。** 列の数（`groupCount`）は `length` から取る ―― 同じ観測から
   * 2つの表現に畳む（増分4 設計 §8.1 の形）。
   */
  groupColumns(): number[];
  /**
   * 道具の列（D90。`tool-column.ts` の判定を、いまの `tabGroups` の表示中のタブに当てたもの）。
   * **観測を返すだけ。** 避けるかどうかは設定を見るハンドラが決める。
   */
  toolColumns(): ReadonlySet<number>;
  /** いま存在する列の数（`tabGroups.all.length`。`Stage` の丸めと同じ量）。観測を返すだけ。 */
  groupCount(): number;
  /**
   * 人間が居る列（`activeTabGroup.viewColumn`）。**観測する。推測しない**（D55-2 の3）。
   * 列の位置（「最左が人間」）から推測すると、人間が舞台の列を覗いた瞬間に外れる
   * ―― 増分2B で人間の列を奪ったのと同じ量である。
   * **読めなければ `undefined`**（1 に丸めない。丸めると判定が fail-open になる）。
   * 観測できないときにどうするかは policy が決める（減らす操作は断る）。
   */
  humanColumn(): number | undefined;
}

/**
 * 枠のプリセットの語だけ。`arrangeActionCloses` も `arrangeActionMoves` も false を返す側
 * である。語を並べ直さず、**2つの述語の型ガードから導く**（不変条件14）。
 */
export type ArrangeLayoutAction = Exclude<ArrangeAction, ArrangeCloseAction | ArrangeMoveAction>;

export interface ArrangeEditorsArgs {
  action: ArrangeAction;
  /** `move-tab` のときだけ。動かすタブのワークスペース相対パス。 */
  path?: string;
  /** `move-tab` / `move-panel` のときだけ。移動先の列（1始まり）。 */
  toColumn?: number;
  /** `move-panel` のときだけ。動かす枠（既定 1。D61）。 */
  slot?: PanelSlot;
  /** `close-tabs` のときだけ（必須）。閉じるタブのワークスペース相対パス。 */
  paths?: readonly string[];
}

export interface ArrangeEditorsDeps {
  surface: ArrangeSurface;
  config: () => ShowMeConfig;
  /**
   * `move-tab` の `path` と `close-tabs` の `paths` を通す関門（`workspace-path-gate.ts` の
   * `acceptWorkspacePath`）。
   * 綴りの拒否・秘匿・realpath・正準名への秘匿の4段はそちらにある。**ここで書き直さない。**
   * 落ちたものはその理由で `ToolError` になり、タブの一覧を引かない（秘匿ファイルを
   * 人間が開いているかの口にしない）。
   */
  acceptPath: (raw: string) => WorkspacePathVerdict;
  /**
   * `show_code` のスポットライトを消す（画家 `Highlights.clearSpotlight`）。`close-own` が
   * 片づいたときに呼ぶ ―― 消すのは画家で、ハンドラは呼ぶ時だけを決める（増分6 D67）。
   */
  clearSpotlight: () => void;
  log: { info: (message: string, fields?: Record<string, string>) => void };
}

export interface ArrangeEditorsResult {
  done: boolean;
  /**
   * **実際に閉じた枚数**（設計 D51）。エージェントが `get_editor_state` で
   * 見ていた枚数と食い違っても、この数で気づける。
   */
  closed: number;
  /**
   * **実際に動かした枚数**（`move-*` / `gather-own` だけ。D59）。閉じる語では付けない。
   * `closed` と同じ理由 ―― 「動いた」と「断られた」を区別する。
   */
  moved?: number;
  /**
   * 何を断ったか。**何枚断ったかは返さない** ―― 人間のタブを数える口になる。
   * 断るものが無かったときは付けない（「片づいた」と「断られた」の区別）。
   */
  withheld?: ArrangeWithheldReason[];
  /**
   * `close-tabs` だけ。**関門を通ったのに開いているタブが無かった**パス。
   * 載るのはエージェントが送った綴り（正準名ではない）。無ければ付けない。
   */
  notOpen?: string[];
}

export async function handleArrangeEditors(
  args: ArrangeEditorsArgs,
  deps: ArrangeEditorsDeps,
): Promise<ArrangeEditorsResult> {
  // **`paths` は `close-tabs` だけが受け、`close-tabs` には必須**。語を問わず
  // ここで1回判定する（`move-*` の `path` / `toColumn` と同じ形。スキーマの transform に
  // しない）。黙って無視すると、エージェントは「paths を付けた close-own」が
  // そのタブだけを閉じたと読む。
  const needsPaths = args.action === "close-tabs";
  if (needsPaths !== (args.paths !== undefined)) {
    throw new ToolError(
      "invalid-request",
      needsPaths ? "close-tabs requires paths" : `${args.action} does not take paths`,
    );
  }
  if (arrangeActionMoves(args.action)) {
    return handleMove(args.action, args, deps);
  }
  // **`move-*` 以外に `path` / `toColumn` / `slot` を付けたら落とす。** 黙って無視すると、
  // エージェントは「toColumn を付けた close-own」が何かをしたと読む。
  // 引数の形の規則は**ここで1回**判定する（スキーマの transform にしない）。
  if (args.path !== undefined || args.toColumn !== undefined || args.slot !== undefined) {
    throw new ToolError("invalid-request", `${args.action} does not take path / toColumn / slot`);
  }
  if (!arrangeActionCloses(args.action)) {
    // **振り分けの述語は `arrangeActionCloses` / `arrangeActionMoves` の2つだけ**にする
    // （不変条件14）。ここで語を並べ直して型を絞ると、語を足したときにずれる
    // ―― 型ガードで述語のとおりに狭まり、
    // 「述語のとおりに振り分かれる」を単体検査が語彙の全語に当てている。
    const action = args.action;
    // **呼ぶ前に判定する**（設計 §C3 / D55-2）。プリセットは枠を作るだけで、余った
    // グループは最後の枠に合流し、合流は一方通行 ―― 呼んでから戻すことはできない。
    // 判定は `arrange-policy.ts` の純関数、枠の数は `TARGET_GROUPS`、人間の列は面の
    // **観測**（`activeTabGroup.viewColumn`）。ここで列の位置を推測しない（増分2B）。
    // 道具の列（D90）も同じ判定で見る。設定がオフなら渡さない ―― 以前の答えのまま。
    const verdict = layoutVerdict(
      TARGET_GROUPS[action],
      deps.surface.groupColumns().length,
      deps.surface.humanColumn(),
      deps.config().avoidToolColumns ? deps.surface.toolColumns() : undefined,
    );
    if (!verdict.ok) {
      // **呼ばない。** `done: false` と理由を返す ―― 理由が無いと、エージェントは
      // 「コマンドが無かった」と「人間の列（道具の列）を守った」を区別できず、呼び直す。
      deps.log.info("arrange_editors withheld", {
        action: args.action,
        reason: verdict.reason,
      });
      return { done: false, closed: 0, withheld: [verdict.reason] };
    }
    const done = await deps.surface.applyLayout(action);
    deps.log.info("arrange_editors", { action: args.action, done: String(done) });
    return { done, closed: 0 };
  }
  return handleClose(args.action, args, deps);
}

/**
 * `close-own` / `close-other-tabs` / `close-tabs`。
 *
 * **3語は候補の選び方だけが違い、候補 → 述語 → 断った理由 → 面 → 結果の列は1本である。**
 * 語ごとに列を書き分けると、「閉じてよいか」と「何を断ったと言うか」を3箇所で決めることに
 * なる（不変条件14。この repo が10回作った形）。
 *
 *   close-own:        own の全部（webview もテキストタブも。D53）
 *   close-other-tabs: その列でアクティブでないもの（所有で例外を作らない）
 *   close-tabs:       `paths` で指した**テキスト**タブ（パスの無いタブは指せない）
 *
 * 候補に入っても、可否は `mayClose` が当てる ―― 自分のものだから無条件、ではない（D53'）。
 */
async function handleClose(
  action: ArrangeCloseAction,
  args: ArrangeEditorsArgs,
  deps: ArrangeEditorsDeps,
): Promise<ArrangeEditorsResult> {
  const permissions: ArrangePermissions = deps.config().layout;

  // `close-tabs` の `paths` は**全部を関門に通してから**タブを見る（`move-tab` と同じ）。
  // 1本でも落ちたら、その理由で**呼び出し全体**が落ちる ―― 「`.env` は excluded、他は
  // 閉じた」とパスごとに答えを割ると、秘匿ファイルの存在を1本ずつ確かめる口になる
  // 。秘匿の綴りでタブの一覧を引かないのも同じ理由。
  //
  // 正準名 → 送った綴り（最初のもの）。照合は正準名で（面の `ArrangeTab.path` は
  // 正準名。`move-tab` と同じ突き合わせ）、`notOpen` に載せるのは綴りで（開いていない
  // ファイルの正準名を返すと、リンクの先を読む口になる）。同じ実体を2回指しても1回。
  const wanted = new Map<string, string>();
  if (action === "close-tabs") {
    for (const raw of args.paths ?? []) {
      const verdict = deps.acceptPath(raw);
      if (!verdict.ok) throw new ToolError(verdict.reason, "path is not accepted");
      if (!wanted.has(verdict.canonical)) wanted.set(verdict.canonical, raw);
    }
  }

  // 観測は**1回だけ**取る。閉じる途中で取り直すと、判断した集合と閉じる集合が
  // 別の観測になる（同じ量を2つの観測で決めることになる）。
  const tabs = deps.surface.listTabs();

  // 候補を絞る。**`close-own` は自分のもの**（webview もテキストタブも。D53）だけを
  // 候補にする。候補に入っても、床（見ている／未保存）は `mayClose` が当てる ――
  // 自分のものだから無条件、ではない（D53'）。
  //
  // `close-other-tabs` の除外は**その列でアクティブかどうかだけ**で決める。所有で
  // 例外を作らない。人間が**見ている**1枚（`viewing`）はこれとは別に、
  // 述語の床1 が全語で守る。
  //
  // `close-tabs` は指されたテキストタブだけ。webview / 端末には `path` が無いので
  // 構造的に入らない（own のパネルは `close-own` の仕事）。同じパスが2列にあれば両方。
  const candidates =
    action === "close-own"
      ? tabs.filter((candidate) => candidate.own)
      : action === "close-other-tabs"
        ? tabs.filter((candidate) => !candidate.isActive)
        : tabs.filter(
            (candidate) =>
              candidate.kind === "text" &&
              candidate.path !== undefined &&
              wanted.has(candidate.path),
          );

  const closable = candidates.filter((candidate) => mayClose(candidate, permissions));

  // **断った理由を組み立てる。** エージェントが「片づいた」と「断られた」を
  // 区別できないと、同じ操作を呼び続ける（`selectionWithheld` と同じ理由）。
  //
  // 未保存の人間のタブは `closeHumanTabs` と `closeDirtyTabs` の**両方**が
  // 要るので、両方の理由が出る。片方しか言わないと、エージェントは片方だけを
  // 人間に頼んで、また断られる。
  //
  // 理由は `mayTouch` の3つの項（reach / 床1 / 床2）に1つずつ対応する。
  // ここで許可を**再導出しない** ―― 断ったのは述語で、ここは断った候補が
  // どの項で落ちたかを言うだけである（不変条件14）。
  const refused = candidates.filter((candidate) => !mayClose(candidate, permissions));
  const withheld: ArrangeWithheldReason[] = [];
  if (refused.some((candidate) => !candidate.own && !permissions.closeHumanTabs)) {
    withheld.push("human-tabs-not-allowed");
  }
  // 床2 は**自分のものにも掛かる**（D53'）。`!own` で絞らない ―― 絞ると、
  // エージェントが開いて人間が編集したタブを断ったときに理由が無くなる。
  if (refused.some((candidate) => candidate.isDirty && !permissions.closeDirtyTabs)) {
    withheld.push("dirty-tabs-not-allowed");
  }
  // 人間が見ているタブは**設定で外れない**（床1）。設定の理由と分けて言う ――
  // 「human-tabs-not-allowed」に混ぜると、エージェントは人間に設定を頼み、
  // 立ててもまた断られる。
  if (refused.some((candidate) => candidate.viewing)) {
    withheld.push("viewing-tab");
  }

  // **空の指示を渡さない。** 呼ぶと、面の実装が「空配列なら全部閉じる」のように
  // 読み違えたときに壊れる。構造で止めるのであって、無駄な呼び出しの節約ではない。
  const done =
    closable.length === 0 ? true : await deps.surface.closeTabs(closable.map((c) => c.id));
  // 面が失敗したなら、閉じた枚数は 0 である。「3枚閉じた（ただし done: false）」は
  // エージェントに次の一手を選ばせない。少なく言う側に倒す ―― この道具は
  // べき等（`idempotentHint: true`）なので、呼び直しても増えない。
  const closed = done ? closable.length : 0;

  // **片づけたのに指差しが残るのは片づけていない**（D67）。スポットライトの寿命は
  // 1回の `show_code` の分だけで、`close-own` はその終わりでもある。
  //
  // 決めるのは `done` だけである。断られた own タブ（人間が見ている／未保存）が
  // 開いたまま残っても消す ―― 人間は「片づけて」と言ったのであり、指差しは中身では
  // なく指であって、残しても人間には戻る手段も消す手段も無い（§C1）。閉じるものが
  // 無くても同じ理由で消す。消さないのは面が失敗した（`done: false`）ときだけで、
  // それは**何も変わっていない**からである（べき等な呼び直しに同じ画面を渡す）。
  // `close-other-tabs` は人間のタブを片づける語で、自分の指差しとは別の量である。
  // `close-tabs` も同じ ―― 指されたタブを閉じるのであって「片づけ」ではない。
  if (action === "close-own" && done) deps.clearSpotlight();

  // `close-tabs` で、指したのに開いていなかったパス（関門を通ったものだけ。送った綴りで）。
  // 「開いていなかった」は候補の観測から決める ―― 閉じる前後で取り直さない。
  const openCanonical = new Set(candidates.map((candidate) => candidate.path));
  const notOpen = [...wanted]
    .filter(([canonical]) => !openCanonical.has(canonical))
    .map(([, raw]) => raw);

  deps.log.info("arrange_editors", {
    action,
    closed: String(closed),
    withheld: withheld.join(","),
    ...(action === "close-tabs" ? { notOpen: String(notOpen.length) } : {}),
  });

  const result: ArrangeEditorsResult = { done, closed };
  if (withheld.length > 0) result.withheld = withheld;
  if (notOpen.length > 0) result.notOpen = notOpen;
  return result;
}

/**
 * `move-tab` / `move-panel` / `gather-own`（増分5 D59 / D55-1）。
 *
 * ## 形
 *
 * 引数の形（`move-tab` には `path` と `toColumn`、`move-panel` には `toColumn` と省略可の
 * `slot`、`gather-own` はどれも取らない）は**ここで1回**判定する（スキーマの transform に
 * しない。線の両端で二重に parse する形になる）。
 *
 * ## 述語は close と同じ `mayTouch`（op: "move"）
 *
 * 床1（人間が見ているものは触らない）は掛かり、床2（未保存）は掛からない ――
 * 動かしても何も失われない。移動先の判定は `moveTargetVerdict` 1つ
 * （`move-tab` も `move-panel` も）。`gather-own` の集め先は `show_code` と同じ
 * `placeStageColumn` が構成するので、人間の列にはならない（`firstStageColumn` と同じ列）。
 *
 * ## タブは `path` で指す。題では指さない（D41）
 *
 * `path` は関門を通して正準名にし、面が観測した**正準名**（`ArrangeTab.path`）と
 * 突き合わせる。候補はテキストタブだけ ―― webview が同じ題を持っていても当たらない。
 */
async function handleMove(
  action: ArrangeMoveAction,
  args: ArrangeEditorsArgs,
  deps: ArrangeEditorsDeps,
): Promise<ArrangeEditorsResult> {
  const needsPath = action === "move-tab";
  const needsColumn = action !== "gather-own";
  if (needsPath !== (args.path !== undefined)) {
    throw new ToolError(
      "invalid-request",
      needsPath ? "move-tab requires path" : `${action} does not take path`,
    );
  }
  if (needsColumn !== (args.toColumn !== undefined)) {
    throw new ToolError(
      "invalid-request",
      needsColumn ? `${action} requires toColumn` : `${action} does not take toColumn`,
    );
  }
  // `slot` は `move-panel` だけが取る（省略可。D61）。他の語に付いたら落とす（上と同じ理由）。
  if (action !== "move-panel" && args.slot !== undefined) {
    throw new ToolError("invalid-request", `${action} does not take slot`);
  }
  // 既定の枠は protocol の `DEFAULT_PANEL_SLOT`（`show_html` の既定と同じ値。別に書かない）。
  const wantedSlot: PanelSlot = args.slot ?? DEFAULT_PANEL_SLOT;

  // 設定は1回だけ読む（許可と「道具の列を避けるか」を同じ写しから）。
  const config = deps.config();
  const permissions: ArrangePermissions = config.layout;
  const avoidToolColumns = config.avoidToolColumns;

  // **移動先の決め方は1つの純関数にして、面に渡す。** 面は1枚動かすごとに新しい観測
  // （`groupColumns` / `humanColumn`）でこれを呼ぶ（レビュー I3: 元の列が空になると
  // VS Code が閉じて列が繰り上がるので、最初に決めた番号を使い続けると人間が右端に
  // 居るとき収束しない）。人間が途中で移動先の列を覗いたら、そこで止まる（M1）。
  const decide: MoveTargetDecider =
    action === "gather-own"
      ? ({ columns, humanColumn, toolColumns, groupCount }) => {
          // 人間の列が観測できない → どこが舞台か言えない。推測で集めない。
          // `placeStageColumn` は人間の列を省くと最小の列と仮定するので、先に断る。
          if (humanColumn === undefined) return { ok: false, reason: "human-column-target" };
          // 道具の列を避けるのは設定がオンのときだけ（D90）。オフなら観測があっても渡さない ――
          // 以前の答えのまま。
          const avoid = avoidToolColumns ? toolColumns : undefined;
          // 集め先は `show_code` が開く列と**同じ関数・同じ量**で決める（`Stage.targetColumn` の
          // `placeStageColumn`。存在する列の数も `Stage` と同じ `tabGroups.all.length`）。丸めた
          // 後の列をそのまま使う ―― 丸める前の番号に動かすと、`show_code` と違う列に集めうる。
          const placed = placeStageColumn(columns, "single", 0, humanColumn, groupCount, avoid);
          // オンで Nine の外にしか置けなければ断る ―― 人間の列にも避ける列にも集めない。
          if (placed === "none") return { ok: false, reason: "no-stage-column" };
          // "beside" は列が1つも無いとき（人間の列が観測できた以上、起きないはず）。番号の
          // 無い行き先へは集めない。
          if (placed === "beside") return { ok: false, reason: "human-column-target" };
          // 設定がオフの以前の道は丸めた先を調べない。列が飛び番（実際の VS Code には無い形）だと
          // 丸めが人間の列に落ちうるので、集める側では人間の列を断る（床。§C2）。
          if (placed === humanColumn) return { ok: false, reason: "human-column-target" };
          return { ok: true, column: placed };
        }
      : ({ columns, humanColumn, toolColumns }) => {
          // `toColumn` は形の検査で必須にしてある。
          const toColumn = args.toColumn ?? Number.NaN;
          // 道具の列へは入れない（D90。設定がオンのときだけ。行き先だけを見るので、道具の列から
          // 出すのは通る）。
          const verdict = moveTargetVerdict(
            toColumn,
            columns.length,
            humanColumn,
            permissions,
            avoidToolColumns ? toolColumns : undefined,
          );
          return verdict.ok ? { ok: true, column: toColumn } : verdict;
        };

  // **最初の判定は動かす前に。** 断るなら、タブの一覧も関門も引かない。
  const first = decide(freshColumns(deps.surface));
  if (!first.ok) {
    if (first.reason === "invalid-request") {
      throw new ToolError(
        "invalid-request",
        "toColumn must be between 1 and (the current column count + 1)",
      );
    }
    return withheldMove(deps, action, first.reason);
  }
  const target = first.column;

  // `move-tab` の `path` は**関門を通してから**タブを見る。秘匿の綴りでタブの一覧を
  // 引くと、落ちる理由の割れ方から「人間がそのファイルを開いているか」が読める。
  let wantedPath: string | undefined;
  if (action === "move-tab") {
    const verdict = deps.acceptPath(args.path ?? "");
    if (!verdict.ok) throw new ToolError(verdict.reason, "path is not accepted");
    wantedPath = verdict.canonical;
  }

  // 観測は**1回だけ**（close 側と同じ理由）。
  const tabs = deps.surface.listTabs();

  // 候補を絞る。**候補に入っても許可は `mayTouch` が決める**（不変条件14）。
  //   move-tab:   path が一致する**テキスト**タブ（own でなくても候補。許可は述語）
  //   move-panel: 指した枠（`slot`）の own の webview。**別の枠を代わりに動かさない**
  //   gather-own: own の全部（両方の枠の webview も）。人間のものは候補にしない
  const candidates =
    action === "move-tab"
      ? tabs.filter((t) => t.kind === "text" && t.path !== undefined && t.path === wantedPath)
      : action === "move-panel"
        ? tabs.filter((t) => t.kind === "webview" && t.own && t.slot === wantedSlot)
        : tabs.filter((t) => t.own);
  if (action === "move-tab" && candidates.length === 0) {
    throw new ToolError("not-found", "No open tab has that path");
  }

  const movable = candidates.filter((t) => mayTouch(t, "move", permissions));
  const refused = candidates.filter((t) => !mayTouch(t, "move", permissions));
  // 理由は `mayTouch` の項に1つずつ対応する（reach / 床1）。床2 は move に掛からない。
  const withheld: ArrangeWithheldReason[] = [];
  if (refused.some((t) => !t.own && !permissions.closeHumanTabs)) {
    withheld.push("human-tabs-not-allowed");
  }
  if (refused.some((t) => t.viewing)) withheld.push("viewing-tab");

  // **既にその列に居るものは動かさない。** 同じ列へ「開いてから閉じる」と、開くのは
  // 同じタブで閉じるのもそのタブ ―― 自分のタブを消すことになる。動かした数にも入れない。
  // 観測時の列で見る。動かす途中で列が繰り上がっても、移動先も同じだけ繰り上がる
  // （空くのは人間より左の列だけで、移動先は人間より右にある）ので、この判断は保つ。
  const toMove = movable.filter((t) => t.column !== target);
  const textIds = toMove.filter((t) => t.kind !== "webview").map((t) => t.id);
  // パネルは**枠で指す**（`ArrangeTab.slot`。面が `ownPanelSlot` で付けたもの）。own の webview で
  // 枠が読めないものは無い（own ⇔ 枠がある）が、型の上では optional なので絞っておく。
  const panels = toMove.filter((t) => t.kind === "webview" && t.slot !== undefined);

  let moved = 0;
  let done = true;
  let halted: MoveHaltReason | undefined;
  if (textIds.length > 0) {
    // **1回で渡す。** 面は最初の `await` の前に札を全部引く（レビュー I1）。
    const outcome = await deps.surface.moveTabs(textIds, decide);
    moved += outcome.moved;
    if (outcome.failed > 0) done = false;
    halted = outcome.halted;
  }
  for (const panel of panels) {
    if (halted !== undefined || panel.slot === undefined) break;
    // パネルも1枚ごとに**新しい観測**で決め直す（テキストを動かして列が繰り上がった後。
    // `gather-own` では枠1と枠2の2枚がここを通る）。止められたら残りは動かさない。
    const decision = decide(freshColumns(deps.surface));
    if (!decision.ok) {
      halted = decision.reason;
      break;
    }
    if (await deps.surface.movePanel(panel.slot, decision.column)) moved += 1;
    else done = false;
  }
  if (halted !== undefined) {
    done = false;
    // 途中で列の数が変わって範囲外になるのは、同じ文書のタブが2枚以上あるときだけ
    // （1枚目の移動で元の列が空く）。語彙に無い理由は `done: false` だけで言う。
    if (halted !== "invalid-request" && !withheld.includes(halted)) withheld.push(halted);
  }

  deps.log.info("arrange_editors", {
    action,
    toColumn: String(target),
    moved: String(moved),
    withheld: withheld.join(","),
  });
  const result: ArrangeEditorsResult = { done, closed: 0, moved };
  if (withheld.length > 0) result.withheld = withheld;
  return result;
}

/** 面の観測を1回分まとめる。**同じ瞬間**の `groupColumns` と `humanColumn`。 */
function freshColumns(surface: ArrangeSurface): FreshColumns {
  return {
    columns: surface.groupColumns(),
    humanColumn: surface.humanColumn(),
    toolColumns: surface.toolColumns(),
    groupCount: surface.groupCount(),
  };
}

/** 動かさずに断る（移動先が人間の列・道具の列、または人間の列が観測できない）。 */
function withheldMove(
  deps: ArrangeEditorsDeps,
  action: ArrangeMoveAction,
  reason: ArrangeWithheldReason,
): ArrangeEditorsResult {
  deps.log.info("arrange_editors withheld", { action, reason });
  return { done: false, closed: 0, moved: 0, withheld: [reason] };
}
