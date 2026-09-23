import { MAX_PANEL_SLOT, type PanelSlot } from "@zvx/vscode-showme-protocol";

/**
 * 自分が出す webview の `viewType`。**作る側と見分ける側で同じ値を使う**（不変条件14）。
 *
 * この文字列は2箇所で要る:
 *
 * - `webview/panel.ts` が `createWebviewPanel` に渡す（**作る側**: `ownViewTypeFor`）
 * - `editor-surface.ts` の `isOwnTab` がタブを見分ける（**見分ける側**: `slotOfViewType`）
 *
 * 別々に書くと、片方を変えたときにもう片方が黙って外れる ―― そして外れ方が
 * 悪い。見分けが外れると、自分のパネルが「人間のタブ」に見えるので
 * `arrange_editors` が既定で閉じられなくなり（人間のタブは触らないため）、
 * **自分で出したものを自分で片づけられない**状態になる。しかも例外も警告も出ない。
 *
 * この repo は「同じ量を2箇所で決める」欠陥を**10回**作っている。
 * 11件目をここで作らない。
 *
 * ## 枠（`slot`）は `viewType` で識別する（増分5 D61 → 増分6.2 D80）
 *
 * 「このタブはどの枠か」を `Tab` から決める材料は `TabInputWebview.viewType` **だけ**である
 * （`WebviewPanel` の実体は `Tab` から引けない）。列や題で当てるのは推測（D39）かラベル照合
 * （D41）になる。だから枠ごとに `viewType` を変える: 枠1は `showme.view`、枠 N（N ≥ 2）は
 * `showme.view.N`。**表ではなく1つの関数の対**（`ownViewTypeFor` / `slotOfViewType`）―― 枠の数は
 * 人間の設定 `showme.html.maxPanels`（D80）で、表には書けない。所有の判定と枠の判定は同じ対から
 * 導く: `isOwnTab` は `slotOfViewType(...) !== undefined` であり、所有判定が2つになることはない。
 *
 * 見分ける側は**完全一致・整数のみ**: `showme.view.03` / `showme.view.0` / `showme.view.3x` は
 * 所有でない（`03` を 3 に読むと同じ枠に2つの綴りができる）。`showme.view.1` も無い
 * （枠1の綴りは `showme.view` だけ）。番号は線の絶対上限 `MAX_PANEL_SLOT` まで
 * （スキーマと同じ1つの値。越える番号は所有でない）。
 *
 * ## 照合が「素の値」の完全一致でない理由
 *
 * VS Code は `viewType` に接頭辞を付ける。実測値は `mainThreadWebview-showme.view`
 * （統合テストが実際の値を**完全一致で**主張して固定してある）。だから素の値の完全一致では
 * 永久に当たらない。
 *
 * **接尾辞照合にはしない。** 以前は `endsWith("-showme.view")`（区切りつきの接尾辞）だったが、
 * それは同居する別の拡張が `evil-showme.view` を名乗ると当たる ―― 観測される値は
 * `mainThreadWebview-evil-showme.view` で、`-showme.view` で終わる。そのパネルが「自分のもの」
 * になれば、題が実名で返り（D37' 破り）、`close-own` の対象になる。接頭辞は VS Code の
 * 内部定数（`webviewPanelViewType.fromExternal`）なので、**素の値か、その接頭辞つきの値か**の
 * 2つの完全一致だけを認める。接頭辞が変われば所有判定は黙って外れるが、それは統合テストが
 * 実機の値を完全一致で主張しているので、そこで落ちる（安全側に閉じる向きの故障を検査で拾う。
 * 不変条件14 の 3A の教訓）。
 *
 * **枠2の `showme.view.2` は枠1の照合に当たらない**（完全一致なので当然だが、接尾辞照合に
 * 戻すと `"…-showme.view.2".endsWith("-showme.view")` は false でも `evil-showme.view` の穴が
 * 戻る）。`test/own-view-type.test.ts` が両方を固定している。
 */

/** VS Code が拡張の `viewType` に前置する内部の接頭辞（実測値。統合テストが完全一致で固定）。 */
const VSCODE_WEBVIEW_VIEW_TYPE_PREFIX = "mainThreadWebview-";
/** 枠1の `viewType`。枠 N ≥ 2 はこれに `.N` を付ける。 */
const OWN_VIEW_TYPE_BASE = "showme.view";
/**
 * 見分ける側の形。**接頭辞を剥がした後の素の値**に、全体一致で当てる。番号は `[1-9]\d*`
 * （先頭ゼロ無し・符号無し・整数のみ）で、無ければ枠1。`^` と `$` で全体一致 ――
 * `evil-showme.view.3` も `showme.view.3x` も当たらない。
 */
const OWN_VIEW_TYPE_PATTERN = /^showme\.view(?:\.([1-9]\d*))?$/;

/** 作る側。`createWebviewPanel` の第1引数。 */
export function ownViewTypeFor(slot: PanelSlot): string {
  return slot === 1 ? OWN_VIEW_TYPE_BASE : `${OWN_VIEW_TYPE_BASE}.${slot}`;
}

/**
 * 見分ける側。観測した `viewType` がどの枠の自分のパネルか。自分のものでなければ `undefined`。
 *
 * 素の値か、VS Code の接頭辞つきの値か、**2つの完全一致だけ**を認める
 * （上記「照合が『素の値』の完全一致でない理由」）。接頭辞は**先頭からの完全一致**で1回だけ
 * 剥がす（`startsWith` ―― 2重の接頭辞や別の接頭辞は残って全体一致に落ちる）。
 */
export function slotOfViewType(viewType: string): PanelSlot | undefined {
  const raw = viewType.startsWith(VSCODE_WEBVIEW_VIEW_TYPE_PREFIX)
    ? viewType.slice(VSCODE_WEBVIEW_VIEW_TYPE_PREFIX.length)
    : viewType;
  const match = OWN_VIEW_TYPE_PATTERN.exec(raw);
  if (match === null) return undefined;
  const digits = match[1];
  if (digits === undefined) return 1;
  // `showme.view.1` は無い（枠1の綴りは `showme.view` だけ）。長い桁は `Number` で丸まる前に落とす。
  if (digits.length > String(MAX_PANEL_SLOT).length) return undefined;
  const slot = Number(digits);
  if (slot < 2 || slot > MAX_PANEL_SLOT) return undefined;
  return slot;
}
