import * as vscode from "vscode";
import type { ShowMeConfig } from "./config.js";
import type { StagePlacement } from "./handlers/show-code.js";
import type { OpenedByAgent } from "./opened-by-agent.js";
import { placeStageColumn } from "./stage-column.js";
import { observeToolColumns } from "./tool-column-vscode.js";
import { ToolError } from "./tool-error.js";

/**
 * 舞台の列の選び方を決める設定（1回の要求の写し）。
 *
 * **呼び出し側が1回の要求につき1回だけ作って渡す**（`show_code` は `showCodeDeps` の写しから、
 * メモとパネルは開く直前に1回）。`targetColumn` の中で設定を読み直すと、`split` の2か所目を
 * 開くあいだに人間が設定を変えたとき、1回の要求の中で答えが割れる（不変条件14）。
 */
export interface StageColumnSettings {
  editorGroup: ShowMeConfig["editorGroup"];
  avoidToolColumns: boolean;
}

export function stageColumnSettingsOf(config: ShowMeConfig): StageColumnSettings {
  return { editorGroup: config.editorGroup, avoidToolColumns: config.avoidToolColumns };
}

/** 舞台の列が無いときの断りの文言（エージェントと人間が読む。英語）。 */
export const NO_STAGE_COLUMN_MESSAGE =
  "No stage column is available: the columns to the right are in use by tools " +
  "(showme.stage.avoidToolColumns) or no more columns can be added.";

/**
 * エージェントが描いてよいエディタ領域。
 *
 * TabGroup に安定した id は無く、ViewColumn は位置番号なので、人間が手前の
 * グループを閉じると番号がずれる（設計書 Y7）。毎回再導出する。実際の判断
 * （どの列を再利用するか）は vscode 非依存の chooseStageColumns に切り出して
 * ある。
 *
 * 舞台は有界であり、人間が使っている列を決して含まない（設計書 §2A.7）。
 * 列数の上限は chooseStageColumns が持ち、VS Code に渡す直前の丸めは
 * clampStageColumn が持つ。ここはその2つを、そのときの可視列に当てるだけ。
 */
export class Stage {
  /**
   * @param opened 自分が開いた文書の記録（D53）。**`extension.ts` が1つだけ作り**、
   *   `get_editor_state` の面と `arrange_editors` の面にも同じ実体を渡す。
   */
  constructor(private readonly opened: OpenedByAgent) {}

  /**
   * 描画先の列。preserveFocus と併せて使うこと。
   *
   * **可視列は毎回ここで読み直す。** 覚えておくと、人間が手前のグループを
   * 閉じたときに番号がずれ、人間の列に描く事故になる（設計書 Y7）。
   *
   * `active` モードは人間の作業面をそのまま使う設定なので、layout も枠も
   * 見ない（列を分けるという概念がその設定に無い）。道具の列を避ける設定（D90）も効かない。
   *
   * **置ける列が無ければ `no-stage-column` の `ToolError` を投げる**（`showme.stage.avoidToolColumns`
   * がオンのときだけ起きる）。人間の列にも避ける列にも描かない。`show_code` は位置ごとの
   * `reason` に、`show_note` / `show_html` は呼び出しの断りにする。
   */
  targetColumn(placement: StagePlacement, settings: StageColumnSettings): vscode.ViewColumn {
    if (settings.editorGroup === "active") {
      return vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    }
    // 専用モード: 人間が使っている列の隣に置く。
    // 既に右側の列があればそれを再利用し、新しい列を増やさない。
    const groups = vscode.window.tabGroups.all;
    const columns = groups
      .map((g) => g.viewColumn)
      .filter((c): c is number => typeof c === "number");
    // **人間の列は観測する。推測しない。** `chooseStageColumns` は渡さなければ
    // 「最小の列＝人間」と仮定するが、それは人間がいちばん手前の列に居るときしか
    // 当たらない。分割エディタで2列目を使っている、あるいは**舞台を一度覗きに
    // クリックしただけ**で仮定は崩れ、舞台が人間の列そのものを選ぶ（実測。
    // 不変条件10 の直接の違反であり、そのとき `show_code` が開いたエディタが
    // `activeTextEditor` の座に就くので、`get_editor_state` の条件2
    // （設計書 §3.1.1 (d)）も同時に無効になる ―― 待ちが明ければ選択テキストが返る）。
    const humanColumn = vscode.window.tabGroups.activeTabGroup.viewColumn;
    // 道具の列（D90）は設定がオンのときだけ観測して渡す。オフなら渡さない ――
    // `placeStageColumn` は以前の道（枠の列を選んで丸めるだけ）を通り、断らない。
    // 観測は `gather-own` と同じ関数（`observeToolColumns`）で、同じ `groups` から取る。
    const avoid = settings.avoidToolColumns ? observeToolColumns(groups) : undefined;
    // 渡す直前に丸める（`placeStageColumn` の中）。存在しない列番号を渡すと VS Code は
    // グループを作るので、論理的な列番号をそのまま渡すと舞台の上限2を超えて増えうる。
    const column = placeStageColumn(
      columns,
      placement.layout,
      placement.slot,
      humanColumn,
      groups.length,
      avoid,
    );
    if (column === "none") throw new ToolError("no-stage-column", NO_STAGE_COLUMN_MESSAGE);
    return column === "beside" ? vscode.ViewColumn.Beside : (column as vscode.ViewColumn);
  }

  /**
   * @param record 開いた文書を記録するか。**`stageOpenTarget` の `record` をそのまま渡す**
   *   （ここで URI のスキームから決め直さない ―― 判断は1箇所。不変条件14）。従来の窓でタブが
   *   使い回されるときの両方向の端の場合は `stageOpenTarget` のコメントにある。
   */
  async open(
    uri: vscode.Uri,
    placement: StagePlacement,
    record: boolean,
    settings: StageColumnSettings,
  ): Promise<vscode.TextEditor> {
    const editor = await vscode.window.showTextDocument(uri, {
      viewColumn: this.targetColumn(placement, settings),
      // フォーカスを奪わない。人間のタイピング先を取らないこと（設計書 §4.6）。
      preserveFocus: true,
      preview: false,
    });
    // **ここが「自分が開いた」を記録する唯一の場所である**（D53）。`show_code` が
    // 編集器を開く道はこの1本しか無い。鍵は開いた編集器の文書の URI ―― 渡された
    // `uri` ではなく、VS Code が実際に開いたほうを取る（タブの `input.uri` と
    // 同じ値で照合するため。同じ量を2つの綴りで持たない）。
    //
    // **ここでは「既に開いていたか」を見ない。常に記録する。** 同じ文書のタブが
    // 2枚あるとき（人間が先に開いていた／後から開いた）に own にしない判断は、
    // 観測の側の `isOwnTab`（`editor-surface.ts`）が枚数を数えて**1箇所で**決める。
    // ここでも見ると、同じ量を2箇所で決めることになる（不変条件14）。
    //
    // **記録するかは呼び出し側が1回だけ決めて渡す**（`stageOpenTarget`）。映し
    // （`showme-ro:` / `showme-rw:`）は記録しない ―― own はスキームで決まる（D82）。`realFile`
    // （D87）で開いた `file:` も記録しない ―― それは人間のタブである。記録するのは
    // `agentTabs: false` の従来の経路で `file:` を開いたときだけ（D53 のまま）。
    if (record) {
      this.opened.opened(editor.document.uri.toString());
    }
    return editor;
  }
}
