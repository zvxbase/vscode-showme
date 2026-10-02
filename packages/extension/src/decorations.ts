import {
  HIGHLIGHT_BORDER_RGBA,
  HIGHLIGHT_RGBA,
  type HighlightColor,
} from "@zvx/vscode-showme-protocol";
import * as vscode from "vscode";
import { HighlightLayers, type LayerRange } from "./highlight-layers.js";
import { paintedOn } from "./line-range-vscode.js";

/**
 * ハイライトの保持と貼り直し。**画家はこの1つだけ**（増分6 §C2）。
 *
 * 装飾は TextEditor 単位で、エディタを閉じて開き直すと失われる（設計書 Y6）。
 * 状態を保持し、可視エディタが変わったら貼り直す。
 *
 * スタイルはここで固定する。エージェントには範囲しか渡させない（設計書 D20）。
 * contentText を引数化すると、ファイルに存在しないテキストをエディタ内に
 * 描けてしまい、「原典が隣に開いている」という唯一の緩和が無効になる。
 *
 * 層は注釈の1つだけ（`HighlightLayers`。判断はそちらの純関数にある）。注釈ストアが札ごとに
 * 登録・抹消し、注釈と同じ寿命を持つ（D66）。以前は `show_code` のスポットライトの層もあったが、
 * 増分13 D116 で `show_code` が塗らなくなったので消した ―― コメントの無い塗りは人間が辿れず、
 * AI が何も言っていない塗りには意味がほとんど無い（オーナーの所見）。
 *
 * `setDecorations(type, ranges)` は「その型の全範囲」を置き換えるので、2つの書き手が
 * 同じ型を別々に書けば互いを消し合う。だから書き手はここ1つで、貼るときは常に
 * `layers.forUri` の全部を1回で書く（不変条件14）。
 */
/**
 * 貼る範囲と、その**種類**。
 *
 * `isWholeLine` は装飾の型に焼かれるので、範囲だけを渡されると貼る側が
 * 種類を推測することになる。**推測させない** ―― 種類を知っているのは
 * 「列が指定されたか」を見た側（`line-range-vscode.ts` の `toHighlightRange`）だけである
 * （不変条件14）。
 */
export type HighlightRange = LayerRange<vscode.Range>;

export class Highlights implements vscode.Disposable {
  /**
   * 装飾の型。**色 × （行全体 / 文字だけ）**の組ごとに1つ持つ。
   *
   * `isWholeLine` も色も装飾の**型に焼かれる**ので、1つの型で切り替えられない。
   * 組み合わせの数は有限（色6 × 2 = 12）で、初めて使うときに作って持ち続ける
   * （`typeFor`）。捨てないのは、剥がすときに**作った型を全部**空にするため。
   *
   * **`contentText` は渡さない。** D20 の本体はそこで、色を選ばせること（D35）とは
   * 別の話である ―― 色を変えてもエディタに描かれる文字はファイルの中身のままだが、
   * `contentText` はファイルに無い文字を描いてしまう。
   */
  private readonly types = new Map<string, vscode.TextEditorDecorationType>();

  private typeFor(color: HighlightColor, wholeLine: boolean): vscode.TextEditorDecorationType {
    const key = `${color}:${wholeLine ? "line" : "inline"}`;
    const existing = this.types.get(key);
    if (existing !== undefined) return existing;
    // **色相は実装が固定する**（増分6.1 D78）。テーマ色（`ThemeColor`）から借りると
    // 色相がテーマで変わる（実機: Dark Modern で黄がオレンジ、紫が青緑）。背景・縁・
    // スクロールバーの印の全部を protocol の同じ表から取り、テーマ色を混ぜない
    // （縁だけ借りると、どの色にもテーマのオレンジの縁が付いて色相を引っぱる）。
    // 色はトップレベルに**置かない**。`light` / `dark` はトップレベルを上書きするので
    // 置いても効きはしないが、同じ量（色）を決める場所が2つになる（不変条件14）。
    const fill = HIGHLIGHT_RGBA[color];
    const border = HIGHLIGHT_BORDER_RGBA[color];
    const created = vscode.window.createTextEditorDecorationType({
      light: {
        backgroundColor: fill.light,
        borderColor: border.light,
        overviewRulerColor: fill.light,
      },
      dark: {
        backgroundColor: fill.dark,
        borderColor: border.dark,
        overviewRulerColor: fill.dark,
      },
      borderStyle: "solid",
      borderWidth: "1px",
      isWholeLine: wholeLine,
      overviewRulerLane: vscode.OverviewRulerLane.Center,
    });
    this.types.set(key, created);
    return created;
  }

  /** 注釈の層。uri は `uri.toString()`。**唯一の真実**で、`apply` はここからだけ読む。 */
  private readonly layers = new HighlightLayers<vscode.Range>();
  private readonly subscription: vscode.Disposable;

  constructor() {
    this.subscription = vscode.window.onDidChangeVisibleTextEditors((editors) => {
      for (const editor of editors) this.apply(editor);
    });
  }

  /** 注釈ストアが札 `key` で登録する。同じ札の再登録は置き換え（D66）。 */
  setAnnotation(key: string, uri: vscode.Uri, range: HighlightRange): void {
    this.repaint(this.layers.setAnnotation(key, uri.toString(), range));
  }

  removeAnnotation(key: string): void {
    this.repaint(this.layers.removeAnnotation(key));
  }

  // `clearAnnotations` / `clearAll` は**無い**。注釈の層を空にできるのは注釈ストアだけで、
  // 札ごとの `removeAnnotation` を `disposeEntry` から通す。画家に「全部消す」を持たせると、
  // 役割の解除・停止・無効化の各所で「画家の全消し ＋ ストアの全消し」を並べることになり、
  // 片方を落とした時点で吹き出しだけが残る（不変条件14）。

  /**
   * 層が「貼り直しが要る」と言った uri **だけ**を貼り直す。
   *
   * 消えた uri も含まれている（層は前の集合 ∪ 今の集合を返す）ので、剥がすべき
   * エディタも `apply` に来て、`forUri` が空を返して外れる。可視でない uri は
   * `onDidChangeVisibleTextEditors` で現れたときに貼る。
   */
  private repaint(touched: readonly string[]): void {
    if (touched.length === 0) return;
    const set = new Set(touched);
    for (const editor of vscode.window.visibleTextEditors) {
      if (set.has(editor.document.uri.toString())) this.apply(editor);
    }
  }

  /**
   * いまハイライトを預かっている URI（`uri.toString()`）。**観測のためだけ**。
   *
   * VS Code には**貼った装飾を読み出す API が無い**（`setDecorations` は
   * 書きっぱなし）。だから統合テストから確かめられる最も近い面がこの状態で、
   * ここが空になることが「装飾を剥がした」ことの根拠になる ―― `apply()` が
   * 層を唯一の真実として editor へ書いている。
   *
   * これが無いと、役割を外したときの剥がしを消しても単体・統合とも全部緑のままだった
   * （実測）。「預けるのをやめても装飾が残る」は、この道具が防御として数えている性質である
   * （設計書 §5.4）。
   */
  highlightedUris(): string[] {
    return this.layers.uris();
  }

  /**
   * いま貼っている範囲を、**種類つきで**返す。**観測のためだけ**。
   *
   * `highlightedUris` は「どのファイルに貼ったか」しか言わないので、
   * **列の指定が効いているか**は観測できなかった。効いていることを言うには
   * 範囲そのものを見るしかない（設計 D34。`text` で指した注釈が一致の列だけを塗ること ――
   * 増分13 D118 ―― もここで見る）。
   */
  highlightRanges(): {
    uri: string;
    startLine: number;
    startColumn: number;
    endColumn: number;
    wholeLine: boolean;
    color: HighlightColor;
  }[] {
    // 貼ったものと同じ範囲を言う: `text` で指したものは、開いている文書で決め直す（
    // `apply` と同じ `paintedOn`）。開いていなければ登録された範囲。
    const documents = new Map(
      vscode.workspace.textDocuments.map((document) => [document.uri.toString(), document]),
    );
    return this.layers.entries().map(({ uri, item: registered }) => {
      const item = paintedOn(registered, documents.get(uri));
      return {
        uri,
        startLine: item.range.start.line,
        startColumn: item.range.start.character,
        // 行全体のときは `Number.MAX_SAFE_INTEGER` が入る。丸めずにそのまま出す
        // ―― 丸めると「行全体」と「たまたま長い範囲」が観測できなくなる。
        endColumn: item.range.end.character,
        wholeLine: item.wholeLine,
        color: item.color,
      };
    });
  }

  /**
   * **作った装飾を全部外す。** 一部だけ外すと、前の貼り付けが残って
   * 消えたように見えない ―― 色を増やしたぶん、外し忘れる面も増えた。
   */
  private clearEditor(editor: vscode.TextEditor): void {
    for (const type of this.types.values()) editor.setDecorations(type, []);
  }

  /**
   * 貼り直す。**行全体のものと文字だけのものを分けて渡す。**
   *
   * `isWholeLine` は装飾の型に焼かれるので、1回の `setDecorations` では混ぜられない
   * （混ぜると全部が同じ扱いになり、列の指定が黙って効かなくなる）。
   *
   * その uri の全部を1回で書く。書き手ごとに書くと、同じ型（同じ色 × 同じ種類）を後から
   * 書いた側が前の分を消す（§C2 の「互いを消し合う」はまさにこれ）。
   */
  private apply(editor: vscode.TextEditor): void {
    const ranges = this.layers.forUri(editor.document.uri.toString());
    // **種類も色も作る側が持っている。** ここで範囲の形から推測しない ――
    // `toRange` は行末に `Number.MAX_SAFE_INTEGER` を置くので、
    // 「終端の列が 0 なら行全体」のような推測は必ず外れる（不変条件14）。
    //
    // **まず全部外してから貼る。** 前回使った色の装飾が残ると、色を変えた
    // ハイライトが二重に見える。
    this.clearEditor(editor);
    const byType = new Map<vscode.TextEditorDecorationType, vscode.Range[]>();
    for (const registered of ranges) {
      // `text` で指したものは、このエディタの文書の行で列を決め直す（種類もここで決まる ――
      // 範囲の形から推測するのではなく、`paintedOn` が作る）。
      const item = paintedOn(registered, editor.document);
      const type = this.typeFor(item.color, item.wholeLine);
      const list = byType.get(type) ?? [];
      list.push(item.range);
      byType.set(type, list);
    }
    for (const [type, list] of byType) editor.setDecorations(type, list);
  }

  dispose(): void {
    this.subscription.dispose();
    for (const type of this.types.values()) type.dispose();
    this.types.clear();
  }
}
