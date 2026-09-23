/**
 * エディタの配置を整える操作（設計 §2 / D42）。
 *
 * 人間の言葉:「新しく開くツールをたくさん使い画面が混雑するし、やっぱり画面
 * レイアウトを整えてほしくもなる。vscode をちゃんと AI と人のインターフェース
 * にできているという体験が重要だと感じる。」
 *
 * ## 任意のコマンド名を受け取らない（D36 と同じ）
 *
 * VS Code のコマンドを名前で受け取ると `executeCommand` を線の向こうに開くことに
 * なり、**この道具の境界そのものが消える**（ファイルの作成も削除も設定の変更も、
 * 全部コマンドである）。閉じた語彙だけを受け取り、コマンド名への対応づけは
 * 拡張の面（`arrange-surface.ts`）だけが持つ。
 *
 * ## 何が閉じられるかは、この語彙では決まらない
 *
 * `close-other-tabs` は「人間のタブを閉じてよい」を意味**しない**。
 * 実際に閉じるかどうかは `showme.layout.closeHumanTabs` と
 * `showme.layout.closeDirtyTabs` が決める（`arrange-policy.ts` の `mayTouch`）。
 *
 * > **語彙は意図を表し、設定が権限を表す。**
 *
 * この2つを混ぜないこと ―― 混ぜると「その操作を呼べた＝許可されている」に
 * なり、設定が飾りになる。語彙を足すときに問うのは「エージェントはこれを
 * *したい* と言えるべきか」であって、「これを*させて*よいか」ではない。
 * 後者を決めるのは人間の設定だけである。
 */

/**
 * 受け付ける配置の操作。**この一覧が境界である。**
 *
 * 11語はすべて「こうなっていてほしい**終状態**」を名指している
 * （`toggle-*` のような反転する語を入れていない）。だから同じ語で呼び直しても
 * 追加の効果が無い ―― `TOOL_ANNOTATIONS.arrange_editors.idempotentHint: true` の
 * 根拠がこれである。**反転する語や「もう1列足す」形の語を足すなら、
 * 先に注釈を見直すこと** ―― `show_view` は `toggle-*` を7つ足した時点で
 * `idempotentHint: true` が嘘になり、後から直している。
 *
 * ## 語彙は「枠」と「移動」と「片づけ」に分かれる（増分5 §C3）
 *
 * VS Code の API には「グループを結合する」も「タブを動かす」も無い。あるのは
 * 枠を作るプリセット（`editorLayout*`。既存のタブは動かさず、枠が減るなら末尾の枠に
 * 合流）と、「開いてから閉じる」（テキスト）／`reveal`（webview）で結果としてタブが
 * 動くこと。だから語彙でも分ける。
 *
 * `single-column` は消した（D55-1）。枠のプリセットとしては**必ず**人間の列を
 * 巻き込む（人間がどの列に居ても他の列が流れ込む）ので、断る操作にしかならなかった。
 * 名前が「画面全体を1列に」を約束していて、それは嘘になる。「集める」意図なら
 * `gather-own` が正しい語彙である。**復活させないこと。**
 */
export const ARRANGE_ACTIONS = [
  /**
   * 自分（ShowMe）のものを全部閉じる ―― 出した webview パネルと、`show_code` で
   * 開いたテキストタブ（増分5 D53。`close-own-panels` から改名。「panels」は嘘になる）。
   * 人間が見ているタブと未保存のタブは、どの設定でも残る（§C1 の床）。
   */
  "close-own",
  /** 左右2列に分ける */
  "two-columns",
  /** 左右3列に分ける */
  "three-columns",
  /** 上下2段に分ける */
  "two-rows",
  /** 2×2 に分ける */
  "grid",
  /** 列の幅を均等にする */
  "even-widths",
  /** アクティブなタブ以外を閉じる。**設定が許した範囲でしか閉じない** */
  "close-other-tabs",
  /**
   * `paths` で指したテキストタブ**だけ**を閉じる。人間の言葉:
   * 「リストを渡したらそのリストに乗ったタブを消す」。`close-other-tabs` は
   * 「各列の非アクティブ」しか消えず、`close-all` は列の裏のターミナルや他拡張の
   * パネルまで消える ―― どちらも「これとこれを閉じて」に届かない。
   *
   * **タブは `paths` で指す**（`move-tab` と同じ関門 `acceptWorkspacePath` を通す）。
   * パスを持たないタブ（ターミナル・他拡張のパネル・自分の HTML パネル）は指せないので
   * **構造的に消えない**。自分のパネルは `close-own`。可否は `mayClose` ―― 述語は増やさない。
   *
   * `close-all` は作らない。「それ以外全部」（`close-except`）も見送り ―― 「全部」に
   * パスの無いタブが入る。
   */
  "close-tabs",
  /**
   * テキストタブを `path` で指して `toColumn` へ動かす（増分5 D59）。
   * **タブは `path` で指す。ラベルでは指さない**（D41: ラベルはエージェントが決められる）。
   * 既定では自分のタブだけ。人間の列への移動は既定で断る。
   */
  "move-tab",
  /** 自分の webview パネルを `toColumn` へ動かす（D59）。 */
  "move-panel",
  /**
   * 自分のタブとパネルを舞台の最初の列（人間の列より右で最小の列。無ければ人間の隣）に
   * 集める（D55-1）。人間の列には触れない。`single-column` の後継。
   */
  "gather-own",
] as const;

export type ArrangeAction = (typeof ARRANGE_ACTIONS)[number];

/** タブを閉じうる語。`arrangeActionCloses` が true を返す側。 */
export type ArrangeCloseAction = "close-own" | "close-other-tabs" | "close-tabs";
/** タブ／パネルを動かす語。`arrangeActionMoves` が true を返す側。 */
export type ArrangeMoveAction = "move-tab" | "move-panel" | "gather-own";

/**
 * その操作がタブを閉じうるか（`close-*`）。レイアウトの組み替えだけのものと分ける。
 *
 * **「閉じうる」であって「閉じてよい」ではない。** 閉じてよいかは1枚ごとに
 * `arrange-policy.ts` の `mayTouch` が設定と観測から決める。
 *
 * 型の絞り込み（type guard）にしてあるのは、ハンドラの振り分けで語を並べ直さず、
 * **この述語のとおりに型が狭まる**ようにするため（不変条件14: 振り分けの述語は1つ）。
 * 述語の中身と型が食い違っても TS は気づかないので、`arrange-action.test.ts` が
 * 語彙の全語に当てている。
 */
export function arrangeActionCloses(action: ArrangeAction): action is ArrangeCloseAction {
  return action === "close-own" || action === "close-other-tabs" || action === "close-tabs";
}

/**
 * その操作がタブ／パネルを動かすか（`move-*` / `gather-own`）。
 *
 * 動かす語は `path` / `toColumn` を受ける（`move-tab` は両方、`move-panel` は
 * `toColumn` だけ、`gather-own` はどちらも受けない）。閉じる語のうち `close-tabs` だけが
 * `paths` を受ける。その規則は**ハンドラが1回**
 * 判定する（スキーマは plain object のまま）。
 *
 * **「動かしうる」であって「動かしてよい」ではない。** 動かしてよいかは1枚ごとに
 * `arrange-policy.ts` の `mayTouch(·, "move", ·)` が決める（閉じる側と同じ述語）。
 */
export function arrangeActionMoves(action: ArrangeAction): action is ArrangeMoveAction {
  return action === "move-tab" || action === "move-panel" || action === "gather-own";
}
