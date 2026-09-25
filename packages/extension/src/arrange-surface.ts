import type { PanelSlot } from "@zvx/vscode-showme-protocol";
import * as vscode from "vscode";
import {
  type OwnedBefore,
  TARGET_GROUPS,
  layoutReducesGroups,
  ownedUrisToRestore,
} from "./arrange-policy.js";
import { observedViewColumn } from "./editor-observation.js";
import { countTextTabs, isOwnTab, observedRelPath, ownPanelSlot } from "./editor-surface.js";
import type {
  ArrangeLayoutAction,
  ArrangeSurface,
  ArrangeTab,
  FreshColumns,
  MoveOutcome,
} from "./handlers/arrange-editors.js";
import type { OpenedByAgent } from "./opened-by-agent.js";
import { isLegacyOwnershipUri } from "./stage-uri.js";
import { TabRegistry } from "./tab-registry.js";
import { observeToolColumns } from "./tool-column-vscode.js";
import type { ShowMePanel } from "./webview/panel.js";

/**
 * エディタの配置に触る面。**`vscode` の値に触るのはここだけ**
 * （判断は `arrange-policy.ts` と `handlers/arrange-editors.ts`）。
 *
 * ## ここには判断を書かない
 *
 * このファイルは `vscode` を**値として** import しているので、vitest からは
 * 読み込めない ―― つまり**ここに書いた判断は単体で1件も確かめられない**。
 * 観測する（`listTabs` / `groupColumns` / `humanColumn`）・言われたとおりに閉じる
 * （`closeTabs`）・動かす（`moveTab` / `movePanel`）・語をコマンドに対応づける
 * （`applyLayout`）だけを持つ。
 *
 * 許可の `if`（誰のタブか、未保存か、設定が何か）をここに書きたくなったら、
 * それは上流の判断である ―― `arrange-policy.ts` の `mayClose` か
 * `handlers/arrange-editors.ts` に置くこと。両方で決めると、それが
 * 不変条件14 の8件目になる。
 */

/**
 * 操作名 → VS Code のコマンド名（設計 D42 / D36。`view-surface.ts` と同じ形）。
 *
 * **コマンド名はここにしか現れない。** エージェントが渡すのは閉じた語彙の
 * 操作名であって、コマンド名ではない。対応づけをこの層に閉じ込めることで、
 * 「任意のコマンドを実行できる」経路が構造的に存在しなくなる。
 *
 * 鍵は `ArrangeLayoutAction`（＝`arrangeActionCloses` が false を返す語）なので、
 * 語彙に**閉じない語**を足すとここが型で落ちる（足し忘れが黙って何もしない
 * のを防ぐ）。
 *
 * **当てずっぽうの名前を置かないこと。** コマンド ID は VS Code の版で変わる。
 * 無い名前を置くと `run()` が例外を飲んで `done: false` を返し、エージェントには
 * 「その配置にできなかった」と区別がつかない。実測で `show_view` の
 * `workbench.panel.comments.focus` は**実機に無かった**（設計 D44）。
 * 統合テストが `ARRANGE_COMMANDS` を実機の一覧と突き合わせている。
 */
const COMMAND_BY_LAYOUT: Record<ArrangeLayoutAction, string> = {
  "two-columns": "workbench.action.editorLayoutTwoColumns",
  "three-columns": "workbench.action.editorLayoutThreeColumns",
  "two-rows": "workbench.action.editorLayoutTwoRows",
  grid: "workbench.action.editorLayoutTwoByTwoGrid",
  "even-widths": "workbench.action.evenEditorWidths",
};

/**
 * 対応表の値。**統合テストが実機に存在することを確かめる**（設計 D44）。
 *
 * 統合テストは `src/` を import できないので、表を写さずに観測できるよう
 * 拡張の側から出す（`VIEW_COMMANDS` と同じ理由）。
 */
export const ARRANGE_COMMANDS: readonly string[] = Object.values(COMMAND_BY_LAYOUT);

/**
 * @param root ワークスペースのルート（`observedRelPath` の基準。呼び出しのたびに渡し直す ――
 *   `createEditorStateSurface` と同じ理由）。
 * @param opened 自分が開いた文書の記録（D53）。**`Stage` と同じ実体**を渡すこと。
 *   別に作ると、`show_code` が記録した側とここが見る側が食い違う（不変条件14）。
 * @param panelFor 枠ごとの自分の webview パネル（`move-panel` が作り直す面）。**`extension.ts` と
 *   同じ `Map` を引く関数**を渡すこと（別に作ると、`show_html` が出した枠とここが動かす枠がずれる）。
 */
export function createArrangeSurface(
  root: vscode.Uri | undefined,
  opened: OpenedByAgent,
  panelFor: (slot: PanelSlot) => ShowMePanel,
): ArrangeSurface {
  // **札とタブの対応は `listTabs()` のたびに作り直す。** 覚えておくと、人間が
  // タブを閉じたあとに古い札で別のタブを閉じることになる（`vscode.Tab` に
  // 安定した id は無い。設計書 Y7）。札は観測をまたいで一意（`TabRegistry`。
  // 古い札は引けない ―― 別の要求が観測し直しても、持っていた札が別のタブに
  // 結び直されない。レビュー I1）。
  // `own` も観測時の値を札と一緒に持つ ―― 動かしたあとの再記録は「動かす前に own
  // だったもの」だけに当てる（人間のタブを `closeHumanTabs` で動かしても own にはならない）。
  const registry = new TabRegistry<{ tab: vscode.Tab; own: boolean; column: number | undefined }>();

  /** 観測を1回分まとめる（`groupColumns` と `humanColumn` を同じ瞬間に）。 */
  const fresh = (): FreshColumns => ({
    columns: groupColumns(),
    humanColumn: humanColumn(),
    toolColumns: toolColumns(),
    groupCount: groupCount(),
  });
  const groupColumns = (): number[] => {
    // **観測を返すだけ。** 列の数はハンドラが `length` で取る（1回の観測から2つの表現）。
    const out: number[] = [];
    for (const group of vscode.window.tabGroups.all) {
      const column = observedViewColumn(group.viewColumn);
      if (column !== undefined) out.push(column);
    }
    return out;
  };
  const humanColumn = (): number | undefined =>
    // **観測する。推測しない**（D55-2 の3）。`Stage` が人間の列を取るのと同じ量
    // （`activeTabGroup`）。列の位置（「最左が人間」）から推測すると、人間が舞台の
    // 列を覗いた瞬間に外れる ―― 増分2B で人間の列を奪ったのと同じ形になる。
    //
    // **読めなければ `undefined` を返す。1 に丸めない。** 1 は `humanColumn >= target`
    // の最も緩い値なので、丸めると「観測できない」が「安全」に化けて一方通行の
    // 合流を許す（fail-open）。読めた／読めないの述語は `get_editor_state` の
    // `groups` と同じ `observedViewColumn` 1つ（不変条件14）。断るかは policy が決める。
    observedViewColumn(vscode.window.tabGroups.activeTabGroup.viewColumn);
  // 道具の列（D90）。`Stage.targetColumn` と**同じ観測の関数**（`observeToolColumns`）で読む ――
  // `gather-own` の集め先と `show_code` の舞台が同じ列になるように（不変条件14）。
  const toolColumns = (): ReadonlySet<number> => observeToolColumns();
  // 存在する列の数。`Stage.targetColumn` の丸めと同じ `tabGroups.all.length`（D90）。
  const groupCount = (): number => vscode.window.tabGroups.all.length;

  return {
    listTabs(): ArrangeTab[] {
      const out: ArrangeTab[] = [];
      // **人間が見ているタブは観測する。推測しない**（§C1 の床1）。列の位置
      // （「最左が人間」）から推測すると、人間が舞台の列を覗いた瞬間に外れる
      // （不変条件14 の 2B と同じ形）。`tabGroups.all` と同じ1回の観測で取る。
      const viewing = vscode.window.tabGroups.activeTabGroup.activeTab;
      const groups = vscode.window.tabGroups.all;
      // 文書ごとのタブの枚数も**同じ観測**から作る（`isOwnTab` の第3引数。
      // 数え方は `editor-surface.ts` の `countTextTabs` 1つ）。
      const textTabCount = countTextTabs(groups);
      // 札は観測全体に対して1回で配る（`TabRegistry.observe`。観測をまたいで一意）。
      const observed: Array<{ tab: vscode.Tab; own: boolean; column: number | undefined }> = [];
      for (const group of groups) {
        // 列番号は `get_editor_state` の `groups` と同じ述語で読む（`observedViewColumn`）。
        const column = observedViewColumn(group.viewColumn);
        for (const tab of group.tabs) {
          // **自分のものかの判定は `editor-surface.ts` の `isOwnTab` を使う。**
          // ここに書き写すと、同じ判定が2箇所に生まれる（不変条件14）。
          // 実際この照合は一度直っている（`endsWith("showme.view")` は
          // `evil.showme.view` に当たっていた）。写した側は直らない。
          observed.push({ tab, own: isOwnTab(tab, opened, textTabCount), column });
        }
      }
      for (const { id, item } of registry.observe(observed)) {
        const { tab, own, column } = item;
        const entry: ArrangeTab = {
          id,
          kind:
            tab.input instanceof vscode.TabInputText
              ? "text"
              : tab.input instanceof vscode.TabInputWebview
                ? "webview"
                : "other",
          own,
          isDirty: tab.isDirty,
          isActive: tab.isActive,
          viewing: viewing !== undefined && tab === viewing,
        };
        // `path` は **`get_editor_state` が返す `path` と同じ関数**（`observedRelPath`:
        // 実体まで辿った正準名）。`move-tab` はエージェントがそこで読んだ名前で指すので、
        // 別の関数で作ると指せないタブができる（不変条件14）。
        // `label` は**載せない**（D41。題はエージェントが決められる）。
        if (tab.input instanceof vscode.TabInputText) {
          const relPath = observedRelPath(root, tab.input.uri);
          if (relPath !== undefined) entry.path = relPath;
        }
        // 枠は `get_editor_state` の面と**同じ関数**（`ownPanelSlot`）で付ける。`move-panel { slot }`
        // はエージェントがそこで読んだ値で指すので、別の読み方をすると指せない枠ができる。
        const slot = ownPanelSlot(tab);
        if (slot !== undefined) entry.slot = slot;
        if (column !== undefined) entry.column = column;
        out.push(entry);
      }
      return out;
    },

    async closeTabs(ids): Promise<boolean> {
      // **札で引けなかったものは黙って飛ばす。** 観測してから閉じるまでに
      // 人間がタブを閉じていることがある。そこで例外にすると、人間の操作が
      // エージェントの呼び出しの失敗になって返る。
      const tabs = registry.resolve(ids).map((entry) => entry.tab);
      if (tabs.length === 0) return true;
      try {
        // `preserveFocus: true` ―― **人間のタイピング先を取らない**（不変条件10 の精神）。
        return await vscode.window.tabGroups.close(tabs, true);
      } catch {
        return false;
      }
    },

    async applyLayout(action): Promise<boolean> {
      // **プリセットの合流は own を消す**（実機で2回観測: `show_code` split の
      // 2枚が列2・3 → `two-columns` → 列3が列2に合流 → 合流で動いた1枚の own が消え、
      // 直後の `close-own` が `closed: 1`）。VS Code は合流を close+open として扱い、
      // `OpenedByAgent` はどの close でも忘れる（§C2）。合流の close は人間のドラッグと
      // 同じ形で区別がつかないが、**自分が呼んだプリセットの中で起きた close は自分の仕業**
      // である。だから移動（`moveOne`）と同じ規則で記録し直す ―― 呼ぶ前に own を写し、
      // 合流が終わったのを観測してから、前に own だったものだけ（`restoreOwnership`）。
      //
      // 写すのは**呼ぶ前**。`own` は `listTabs()` と同じ判定（`isOwnTab`。記録にあり、
      // かつ窓に1枚）で取る ―― `opened.has()` だけで写すと、人間も開いている文書の
      // 1枚が合流のあとで own になる。
      const before = ownedTextTabsNow();
      const groupsBefore = groupColumns().length;
      const deadline = Date.now() + ARRANGE_REQUEST_BUDGET_MS;
      try {
        await vscode.commands.executeCommand(COMMAND_BY_LAYOUT[action]);
      } catch {
        return false;
      }
      // 「合流が終わった」は**列の数**で観測する。VS Code は余ったグループの編集器を
      // 最後の枠へ動かして（close+open）からそのグループを消すので、列の数が目標まで
      // 減った時点で、合流のタブの `closed` は届き終えている。減らないプリセット
      // （枠を増やす `grid`、`even-widths`）はここで待たない ―― 呼ぶ前の「減るか」と
      // 同じ述語 `layoutReducesGroups`（不変条件14）。期限に当たったらそのまま進む
      // （own が消える側に倒れるだけ）。
      const target = TARGET_GROUPS[action];
      if (layoutReducesGroups(target, groupsBefore)) {
        await until(() => !layoutReducesGroups(target, groupColumns().length), deadline);
      }
      restoreOwnership(before);
      return true;
    },

    async moveTabs(ids, decide): Promise<MoveOutcome> {
      // **札は最初の `await` の前に全部引く**（`closeTabs` と同じ形。レビュー I1）。
      // 引けなかった札（観測後に人間が閉じた）は失敗に数える ―― 黙って飛ばすと
      // 「動かした」と「消えていた」の区別がつかない。
      const entries = registry.resolve(ids);
      const outcome: MoveOutcome = { moved: 0, failed: ids.length - entries.length };
      // **1要求で1つの期限**（M2）。1枚ごとに 2 s 待つと、枚数でブリッジの呼び出しの
      // 上限（5 s）を超える。期限を過ぎたら再記録を待たずに進む（own が消える側に倒れる
      // だけ）。`moved` は期限内に完了した枚数。
      const deadline = Date.now() + ARRANGE_REQUEST_BUDGET_MS;
      for (const { tab, own } of entries) {
        // **移動先は1枚ごとに新しい観測で決め直す**（レビュー I3）。元の列が空になると
        // VS Code が閉じて列が繰り上がる ―― 最初に決めた番号を使い続けると、人間が
        // 右端に居るとき1枚ごとに新しい列を作って収束しない。決めるのはハンドラの
        // 純関数で、ここは観測を渡すだけ。止めると言われたら残りは動かさない
        // （人間が途中で移動先の列を覗いた、など）。
        const decision = decide(fresh());
        if (!decision.ok) {
          outcome.halted = decision.reason;
          break;
        }
        const result = await moveOne(tab, own, decision.column, deadline);
        if (result === "moved") outcome.moved += 1;
        else if (result === "failed") outcome.failed += 1;
      }
      return outcome;
    },

    async movePanel(slot, toColumn): Promise<boolean> {
      // 面は**移動先で作り直す**（`ShowMePanel.moveTo`）。
      // `path` 由来の描き直しは関門を通り直し、読めなければ**黙って描かない**（合図を出すと
      // 存在が読める）ので、ここに例外は届かず `done: true` のまま中身だけ空になる。
      // 例外が届くのは `html` 由来で `postMessage` が拒否したときだけで、それは `false` に畳む。
      try {
        return await panelFor(slot).moveTo(toColumn);
      } catch {
        return false;
      }
    },

    groupColumns,
    humanColumn,
    toolColumns,
    groupCount,
  };

  /**
   * 1枚を動かす。**開いてから閉じる**（設計 D59）。
   *
   * - `"moved"`: 列が変わった（閉じたあと、own なら再記録済み）
   * - `"already"`: 開いた結果、元の札が移動先の列に居た ＝ 同じタブ。閉じない
   * - `"failed"`: 開けなかった／閉じられなかった
   */
  async function moveOne(
    tab: vscode.Tab,
    own: boolean,
    toColumn: number,
    deadline: number,
  ): Promise<"moved" | "already" | "failed"> {
    if (!(tab.input instanceof vscode.TabInputText)) return "failed";
    const uri = tab.input.uri;
    try {
      // VS Code の API に「タブを動かす」は無い。同じ `TextDocument` を2つの編集器が
      // 指しているあいだは、片方を閉じても文書は生きているので、未保存の内容は
      // 失われず、閉じるときの保存の確認も出ない。**逆にすると文書が一度閉じて
      // 未保存が飛ぶ。** `preserveFocus: true` は人間のタイピング先を取らないため、
      // `preview: false` はプレビュータブとして次の open に入れ替えられないため。
      await vscode.window.showTextDocument(uri, {
        viewColumn: toColumn,
        preserveFocus: true,
        preview: false,
      });
      // **開いた結果、元の札が移動先の列に居るなら、それは同じタブである。** 閉じると
      // 自分のタブを消すことになる（同じ列への「移動」や、VS Code が既に開いていた
      // 列を再利用した場合）。ハンドラは観測した列で先に弾くが、ここでも**開いた後の
      // 観測**で止める ―― 呼び出し側の作法ではなく構造で（不変条件14 の「判断は
      // 触る側に置く」）。
      const landed = vscode.window.tabGroups.all.find((g) => g.viewColumn === toColumn);
      if (landed?.tabs.includes(tab)) return "already";
      // 元のタブは**観測時の札**で閉じる（同じ URI の別のタブを巻き込まない）。
      // 移動の一瞬、同じ URI のタブが2枚になるが、`listTabs()` は移動の前に1回だけ
      // 観測しているので `isOwnTab` の「1枚だけ」規則には当たらない。
      const closed = await vscode.window.tabGroups.close(tab, true);
      if (!closed) return "failed";
      // **移動は所有を消す**。VS Code は列をまたぐ移動を
      // 「閉じて開く」として発火するので `onDidChangeTabs.closed` が来て `OpenedByAgent`
      // が URI を忘れる。人間が動かしたタブは人間のもの（意図した意味論）だが、
      // **エージェント自身の移動は所有を保つ**。だから閉じたあとに再記録する ――
      // ただし、動かす前に own だったものだけ（人間のタブを `closeHumanTabs` で
      // 動かしても own にはならない）。決めるのはプリセットの合流と同じ
      // `restoreOwnership` 1つ。
      //
      // `closed` 事象はタブのモデルの更新と同時に発火する。`tabGroups.close` の解決と
      // その更新の到着順は API が約束していないので、**元の札が一覧から消えたことを
      // 観測してから**記録する（先に記録すると、遅れて来た事象がそれを消す）。
      // **映しは記録し直さない**（D82）。映しの own はスキームで決まり、移動しても残る ――
      // 待つのも記録し直すためだけなので、両方飛ばす。`ownedTextTabsNow` も映しを写さないので、
      // 映しの除外はこことそちらの両側で成り立つ（片側に頼らない）。
      if (own && isLegacyOwnershipUri(uri)) {
        await until(() => !isPresent(tab), deadline);
        restoreOwnership([{ uri: uri.toString(), own }]);
      }
      return "moved";
    } catch {
      return "failed";
    }
  }

  /**
   * いまの窓の全テキストタブを、`listTabs()` と**同じ判定**（`isOwnTab`）の own と一緒に写す。
   * `restoreOwnership` の「前」と「後」の観測（後は URI しか見ない）。**`opened.has()` で
   * 写さない** ―― それは「記録にある」であって「own」ではない（人間も開いていれば own ではない）。
   */
  function ownedTextTabsNow(): OwnedBefore[] {
    const groups = vscode.window.tabGroups.all;
    const textTabCount = countTextTabs(groups);
    const out: OwnedBefore[] = [];
    for (const group of groups) {
      for (const tab of group.tabs) {
        if (!(tab.input instanceof vscode.TabInputText)) continue;
        // **映しのタブは写さない**（D82）。映しの own はスキームで決まり、移動でも合流でも
        // 残る ―― 記録し直す必要が無い。写すと `ownedUrisToRestore` が映しの URI を返し、
        // `OpenedByAgent` に映しが入って own を決める場所が2つになる（不変条件14）。
        // プリセットの合流（`applyLayout`）では、ここで「前」と「後」の両方から落とすことが
        // 映しを記録しない理由になる。移動（`moveOne`）では、映しなら `restoreOwnership` を
        // そもそも呼ばない ―― 除外はこの1箇所に頼らず、呼ぶ側でも成り立つ。`file:` の枚数は
        // 映しと別の鍵なので、落としても変わらない。
        if (!isLegacyOwnershipUri(tab.input.uri)) continue;
        out.push({ uri: tab.input.uri.toString(), own: isOwnTab(tab, opened, textTabCount) });
      }
    }
    return out;
  }

  /**
   * 自分の操作（移動・プリセットの合流）のあとで own を記録し直す。**移動もプリセットも
   * これ1つ**（不変条件14）。決めるのは `arrange-policy.ts` の `ownedUrisToRestore`
   * （前に own && 後に同じ URI が1枚）。ここは「後」を観測して渡すだけ。
   *
   * 呼ぶのは、操作が終わったのを**観測してから**（元の札が消えた／列の数が目標に達した）。
   * 先に呼ぶと、遅れて来た `closed` が記録を消す。
   */
  function restoreOwnership(before: readonly OwnedBefore[]): void {
    for (const uri of ownedUrisToRestore(before, ownedTextTabsNow())) opened.opened(uri);
  }
}

/**
 * 1要求（`moveTabs` / `applyLayout`）で使ってよい時間。ブリッジの呼び出しの上限（5 s）より
 * 十分小さく取る。超えたら残りの再記録を待たずに進む（own が消える側に倒れるだけ）。
 */
const ARRANGE_REQUEST_BUDGET_MS = 2_000;

/** 札のタブがまだ `tabGroups.all` に居るか。 */
function isPresent(tab: vscode.Tab): boolean {
  return vscode.window.tabGroups.all.some((g) => g.tabs.includes(tab));
}

/**
 * 観測が成り立つまで待つ（期限つき。期限は要求ごとに1つで、呼び手が渡す ――
 * 1枚ごとに持つと枚数で伸びる。M2）。
 *
 * `tabGroups.close` やコマンドが解決した時点でモデルが更新されている保証は無い
 * （実測で順序が安定しない）。期限に当たったら、そのまま進む ―― 再記録が遅れて来た
 * `closed` に消される可能性は残るが、own が消える側（閉じない側）に倒れるだけである。
 */
async function until(settled: () => boolean, deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    if (settled()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
