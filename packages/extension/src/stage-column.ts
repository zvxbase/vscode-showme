/** 舞台に使ってよい列の上限（設計書 §2A.7）。 */
export const MAX_STAGE_COLUMNS = 2;

/** 舞台の列。番号が決まらないときは "beside"（`vscode.ViewColumn.Beside` 相当）。 */
export type StageColumn = number | "beside";

/** `show_code` の `layout`。定義元は protocol の `showCodeArgsSchema`。 */
export type StageLayout = "single" | "split";

/**
 * 可視の列の集合から舞台の列を選ぶ（判断ロジックのみ、vscode 非依存）。
 *
 * **不変条件10 の正しい形は「エージェントの舞台は有界であり、人間が使っている
 * 列を決して含まない」である**（設計書 §2A.7）。以前ここは「ちょうど1列」に
 * 固定していたが、そこには2つの別のことが混ざっていた。本当の要件は
 * 「人間の作業面を奪わない」で、「舞台の中でも複数の眺めを作れない」は
 * 巻き添えで課した制約だった。上限のある領域なら `layout: "split"` で
 * 「ここで定義され、ここで使われる」を並べられる。
 *
 * TabGroup に安定した id は無く、ViewColumn は位置番号（1〜9）なので、
 * 人間が手前のグループを閉じると番号がずれる（設計書 Y7）。呼び出し側は
 * 毎回この関数に現在の可視列を渡して再導出すること。
 *
 * 決め方:
 *
 * 1. **人間の列は舞台に含めない。** どれが人間の列かは `humanColumn` で渡す。
 *    実機の呼び出し口（`stage.ts`）は `tabGroups.activeTabGroup.viewColumn` を
 *    渡す ―― **観測であって推測ではない**。省略時は最小の列とみなすが、それは
 *    人間がいちばん手前の列に居るときしか当たらない仮定で、分割エディタや
 *    「舞台を一度覗きにクリックした」だけで崩れる（実測で人間の列を奪った）。
 *    省略できる形を残してあるのは可視列が1つも無い場合の検査のためで、
 *    **本番の経路では必ず渡すこと**
 * 2. その右にある**既存の列を先に使い切る**。既に開いている列を再利用する限り
 *    列は増えない
 * 3. 足りない分だけ、**右端のさらに右**に番号を足す。既存の列の間に割り込むと
 *    それより右の列が番号ずれを起こし、人間の列との位置関係まで動く
 * 4. 返す数は `layout` が決める（`"split"` なら上限の2、`"single"` なら1）
 *
 * 可視列が1つも無いときだけ番号を決められないので "beside" を返し、
 * 新しい列を作らせる。
 */
export function chooseStageColumns(
  visibleColumns: readonly number[],
  layout: StageLayout,
  humanColumn?: number,
): StageColumn[] {
  const want = layout === "split" ? MAX_STAGE_COLUMNS : 1;
  const sorted = [...new Set(visibleColumns)].sort((a, b) => a - b);
  const human = humanColumn ?? sorted[0];
  if (sorted.length === 0 || human === undefined) {
    return Array.from({ length: want }, () => "beside" as const);
  }

  // 人間の列より右の既存の列を再利用する。ここが「列を増やさない」の本体。
  const chosen: StageColumn[] = sorted.filter((c) => c > human).slice(0, want);

  // 足りなければ右端の外側に足す。割り込まないので人間の列は動かない。
  // 人間の列も上限に含める ―― 渡された humanColumn が可視列より右にあるとき、
  // 可視列の右端から足すと人間の列に重なる。
  let next = Math.max(...sorted, human);
  while (chosen.length < want) chosen.push(++next);
  return chosen;
}

/**
 * 舞台の枠（0 始まり）に対応する列。
 *
 * `locations[]` の上限は3、舞台の列の上限は2なので、**3つ目は最後の列の
 * タブになる**（設計書 §2A.7）。枠が列より多いときは最後の列に丸める。
 */
export function stageColumnForSlot(
  visibleColumns: readonly number[],
  layout: StageLayout,
  slot: number,
  humanColumn?: number,
): StageColumn {
  const columns = chooseStageColumns(visibleColumns, layout, humanColumn);
  const index = Math.min(Math.max(Math.trunc(slot), 0), columns.length - 1);
  return columns[index] ?? "beside";
}

/**
 * VS Code に**実際に渡す**列番号へ丸める。
 *
 * `TextDocumentShowOptions.viewColumn` の逐語:「Columns that do not exist
 * will be created as needed up to the maximum of `ViewColumn.Nine`」。つまり
 * **存在しない列番号を渡すとグループが作られる**。`chooseStageColumns` が返す
 * のは「論理的にどの列を使うか」なので、そのまま渡すと状況によっては舞台の
 * 上限2を超えて列が増える。
 *
 * 丸めの上限は「いま存在する列＋1」。1回の呼び出しで増えるグループは高々1つに
 * なる。これは**開く順序と対で意味を持つ**: 昇順に開けば `[2,3]` は 2 → 3 と
 * 増えて舞台は2列で頭打ちになるが、3 を先に渡すと丸められて 2 に落ちる
 * （＝順序を崩した実装は2列にならない）。
 *
 * 列が1つも無いときは番号を決めずに "beside" にする。上限が1になるので、
 * 丸めると**人間の列そのもの**を指してしまう。
 */
export function clampStageColumn(column: StageColumn, existingColumnCount: number): StageColumn {
  if (column === "beside") return "beside";
  if (existingColumnCount <= 0) return "beside";
  const limit = existingColumnCount + 1;
  return column <= limit ? column : limit;
}
