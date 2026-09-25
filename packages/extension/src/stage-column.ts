/** 舞台に使ってよい列の上限（設計書 §2A.7）。 */
export const MAX_STAGE_COLUMNS = 2;

/**
 * VS Code が作れる列の最大（`ViewColumn.Nine`）。`TextDocumentShowOptions.viewColumn` の逐語:
 * 「Columns that do not exist will be created as needed up to the maximum of `ViewColumn.Nine`」。
 */
export const MAX_VIEW_COLUMN = 9;

/** 避ける列の既定（空）。呼び出し口が渡さなければ、避ける列の無い以前の答えになる。 */
export const NO_AVOIDED_COLUMNS: ReadonlySet<number> = new Set();

/** 舞台の列。番号が決まらないときは "beside"（`vscode.ViewColumn.Beside` 相当）。 */
export type StageColumn = number | "beside";

/** `show_code` の `layout`。定義元は protocol の `showCodeArgsSchema`。 */
export type StageLayout = "single" | "split";

/**
 * 人間の列。渡されればそれ、省略時は最小の可視列とみなす（`chooseStageColumns` の決め方1の
 * 仮定。本番の経路では必ず観測値を渡す）。可視列も無ければ `undefined`。
 * `chooseStageColumns` と `resolveStageColumn` が同じ答えを使うために1箇所にある。
 */
function defaultHumanColumn(
  visibleColumns: readonly number[],
  humanColumn: number | undefined,
): number | undefined {
  if (humanColumn !== undefined) return humanColumn;
  return visibleColumns.length === 0 ? undefined : Math.min(...visibleColumns);
}

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
 * 5. **避ける列（`avoid`）は候補から外す**（D90）。ターミナルや他の拡張のパネルを表示して
 *    いる列のこと。外すのは 2 の「再利用する既存の列」からだけで、3 の「右端」は避ける列を
 *    **含めた**右端のまま ―― 避ける列の間に割り込むと、それより右の列が番号ずれを起こす
 *    のは 3 と同じ理由。避ける列が空なら、答えは避ける列を持たなかったときと同じ
 *
 * ここが返すのは論理的な列で、VS Code に渡せるか（丸めても人間の列や避ける列に落ちない
 * か）は `resolveStageColumn` が決める。
 *
 * 可視列が1つも無いときだけ番号を決められないので "beside" を返し、
 * 新しい列を作らせる。
 */
export function chooseStageColumns(
  visibleColumns: readonly number[],
  layout: StageLayout,
  humanColumn?: number,
  avoid: ReadonlySet<number> = NO_AVOIDED_COLUMNS,
): StageColumn[] {
  const want = layout === "split" ? MAX_STAGE_COLUMNS : 1;
  const sorted = [...new Set(visibleColumns)].sort((a, b) => a - b);
  const human = defaultHumanColumn(visibleColumns, humanColumn);
  if (sorted.length === 0 || human === undefined) {
    return Array.from({ length: want }, () => "beside" as const);
  }

  // 人間の列より右の既存の列を再利用する。ここが「列を増やさない」の本体。
  // 避ける列は再利用しない（D90）。
  const chosen: StageColumn[] = sorted.filter((c) => c > human && !avoid.has(c)).slice(0, want);

  // 足りなければ右端の外側に足す。割り込まないので人間の列は動かない。
  // 人間の列も上限に含める ―― 渡された humanColumn が可視列より右にあるとき、
  // 可視列の右端から足すと人間の列に重なる。`sorted` は避ける列も含むので、
  // 足す列は避ける列より右になる。
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
  avoid: ReadonlySet<number> = NO_AVOIDED_COLUMNS,
): StageColumn {
  const columns = chooseStageColumns(visibleColumns, layout, humanColumn, avoid);
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

/** 舞台に使える列が無い（呼び出し側は理由付きで断る）。 */
export type NoStageColumn = "none";

/**
 * 舞台の枠を、VS Code に**実際に渡す**列まで決める（`stageColumnForSlot` → `clampStageColumn`）。
 * 丸めた結果が人間の列・避ける列・`ViewColumn.Nine` の外に落ちるなら `"none"` を返す。
 *
 * **`"beside"` に倒さない理由。** `ViewColumn.Beside` は「いまアクティブな列の隣」で、
 * アクティブな列は人間の列である。隣が既にあればそこに開くので、人間の列の右が避ける列なら
 * **まさに避けた列に描く**。Nine の外で Beside を渡しても作れる列は無く、VS Code が
 * 既存のどこかに置く ―― どこになるかは我々が決めていない。どちらも「人間の列にも避ける列にも
 * 描かない」を守れないので、番号を決められないときは決めずに断る:
 *
 * | 可視列 | 人間 | 避ける列 | layout・枠 | 論理の列 | 丸め後 | 返す値 |
 * |---|---|---|---|---|---|---|
 * | 1,2,3 | 1 | 2,3 | single・0 | 4 | 4 | 4（列を1つ足す。丸めは存在する列＋1 を許す） |
 * | 1,2,3 | 1 | 2,3 | split・1（枠0を開く前の数） | 5 | 4 | 4（枠0と同じ舞台の列） |
 * | 1,2,3,4 | 1 | 2,3 | split・1（枠0を開いた後） | 5 | 5 | 5 |
 * | 1..9 | 1 | 2..9 | single・0 | 10 | 10 | none（Nine の外。Beside なら列2＝避ける列） |
 * | 1..9 | 9 | なし | single・0 | 10 | 10 | none（Nine の外） |
 * | 1,3（飛び番、存在2） | 1 | 3 | single・0 | 4 | 3 | none（丸めが避ける列に落ちる） |
 * | 1,3（飛び番、存在2） | 3 | なし | single・0 | 4 | 3 | none（丸めが人間の列に落ちる） |
 *
 * split の枠1が丸められて枠0と同じ列に落ちるのは許す。そこは舞台の列で、人間の列でも
 * 避ける列でもない（避ける列が無いときに「降順に開くと2列にならない」のと同じ振る舞い）。
 * 枠を昇順に開き、開くたびに可視列を読み直せば2列になる。
 *
 * 飛び番の行は実際の VS Code には無い形（ViewColumn は位置番号で詰まっている）だが、
 * 丸めの上限が「存在する列の数＋1」なので、そこで既存の列に落ちうる。落ち先を調べずに
 * 渡すと、避ける列の無い以前の答えでも人間の列を指した。
 *
 * 可視列が1つも無いときだけは `"beside"` のまま（人間の列も避ける列も無い）。
 */
export function resolveStageColumn(
  visibleColumns: readonly number[],
  layout: StageLayout,
  slot: number,
  humanColumn: number | undefined,
  existingColumnCount: number,
  avoid: ReadonlySet<number> = NO_AVOIDED_COLUMNS,
): StageColumn | NoStageColumn {
  const chosen = stageColumnForSlot(visibleColumns, layout, slot, humanColumn, avoid);
  const column = clampStageColumn(chosen, existingColumnCount);
  if (column === "beside") return "beside";
  // 人間の列は `chooseStageColumns` と同じ関数で決める（同じ量を2箇所で書かない）。
  const human = defaultHumanColumn(visibleColumns, humanColumn);
  if (column === human || avoid.has(column) || column > MAX_VIEW_COLUMN) return "none";
  return column;
}

/**
 * 舞台の枠を、VS Code に渡す列まで決める**ただ1つの入口**（`Stage.targetColumn` が呼ぶ。D90）。
 *
 * - `avoid` が `undefined` ＝ `showme.stage.avoidToolColumns` がオフ。**以前の道のまま**
 *   （`stageColumnForSlot` → `clampStageColumn`）で、断らない。9列で人間が列9に居る端の場合も、
 *   以前どおりの番号を渡す ―― 設定を足しただけで既定の振る舞いを変えない
 * - 集合を渡す ＝ オン。`resolveStageColumn` で、人間の列・避ける列・`ViewColumn.Nine` の外に
 *   落ちるなら置かない。**枠1以降が置けず枠0が置けるなら、枠0の列に重ねる**（split の2列目が
 *   足りないだけで呼び出しごと断らない。避ける列が無いときに丸めが枠0の列に落とすのと同じ結果）。
 *   枠0も置けなければ `"none"` ―― 呼び出し側が理由付きで断る
 *
 * 避ける集合の中身（どの列が道具か）は `tool-column.ts` が決める。ここは列の番号だけを見る。
 */
export function placeStageColumn(
  visibleColumns: readonly number[],
  layout: StageLayout,
  slot: number,
  humanColumn: number | undefined,
  existingColumnCount: number,
  avoid: ReadonlySet<number> | undefined,
): StageColumn | NoStageColumn {
  if (avoid === undefined) {
    return clampStageColumn(
      stageColumnForSlot(visibleColumns, layout, slot, humanColumn),
      existingColumnCount,
    );
  }
  const column = resolveStageColumn(
    visibleColumns,
    layout,
    slot,
    humanColumn,
    existingColumnCount,
    avoid,
  );
  if (column !== "none" || slot <= 0) return column;
  return resolveStageColumn(visibleColumns, layout, 0, humanColumn, existingColumnCount, avoid);
}
