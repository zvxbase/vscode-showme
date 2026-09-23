import {
  type AnnotationColor,
  MAX_ANNOTATION_THREADS,
  UNMARKED_ANNOTATION_PAINT,
} from "@zvx/vscode-showme-protocol";
import * as vscode from "vscode";
import { annotationAuthor } from "./annotation-author.js";
import type { Highlights } from "./decorations.js";
import { t } from "./l10n.js";
import { toHighlightRange, toRange } from "./line-range-vscode.js";
import type { LineRange } from "./line-range.js";

/**
 * 注釈ストアが画家に対して使う口。**登録と抹消だけ**。
 *
 * `Highlights` そのものではなく口の形で受けるのは、単体で画家を偽物に差し替えて
 * 「ストアが何を渡したか」を見るため（`test/annotations-paint.test.ts`）。
 * 画家に「注釈を全部消す」口は**無い**（`decorations.ts`）―― 全消しも1件ずつの抹消と
 * 同じ関数（`disposeEntry`）を通す。層を直接空にする口があると抹消の経路が2つになり、
 * 役割の解除で画家の全消しだけが呼ばれれば吹き出しが塗り無しで残る（D66）。
 */
export type AnnotationPainter = Pick<Highlights, "setAnnotation" | "removeAnnotation">;

/**
 * 出している注釈1件。スレッドと、注釈層に登録した札。
 *
 * `id` は連番で、札はそこから作る。線上の `id`（D71）も同じ数で、数える場所は
 * `nextId` の1つ。`index`（読む順）は `entries` の位置で、`renumber()` が書く。
 * `color` は作者名を書き直すときに要る（作者名は色と番号から**毎回**作る ――
 * 文字列を切り貼りして番号だけ差し替える形にすると、作者名を決める場所が2つになる）。
 */
interface AnnotationEntry {
  id: number;
  index: number;
  key: string;
  color: AnnotationColor | undefined;
  /** 出したときの行（1始まり）。`thread.range` が無いとき（型の上だけ）の代わり。 */
  line: number;
  thread: vscode.CommentThread;
}

/**
 * `list()` が返す注釈1件の観測（増分6 D72）。id・順番・位置・色・読了だけ。
 * 本文は無い（§C6）。`uri` のまま返し、ワークスペース相対パスに直すのは面
 * （`editor-surface.ts` の `observedRelPath`。パスを決める関数はそれ1つ）。
 */
export interface AnnotationListEntry {
  id: number;
  index: number;
  uri: vscode.Uri;
  /** 吹き出しが付いている行（1始まり）。 */
  line: number;
  color?: AnnotationColor;
  /** 人間が Resolve を押したか（`thread.state`。切り替えは `setResolved`。D70）。 */
  resolved: boolean;
}

/**
 * 行の下に出す説明の吹き出し（設計書 §3.2）。
 *
 * comment thread を使う。**本文は `string` である**。VS Code の comment の
 * 本文は `string | (markdown の文字列型)` を取り、実装は前者を `innerText` に
 * 入れ、後者だけを markdown レンダラに通す。前者を選ぶと、この経路の攻撃面が
 * まるごと消える（リモート画像の取得・`command:` リンク・アイコン展開のすべてが、
 * サニタイザの正しさではなく**型**で成立しなくなる）。禁止事項の一覧と理由は
 * `test/annotation-body-is-plain-text.test.ts` と設計書 §3.2.1 にある。
 *
 * `Highlights` と同じ理由で、`vscode` を値として読むのはこの層（ここと
 * `line-range-vscode.ts`）だけである。判断（どこに何を出すか）はハンドラ側
 * （`handlers/annotate.ts`）にあり、ここは出す口だけを持つ。
 */
export class Annotations implements vscode.Disposable {
  /**
   * 同時に出しておける吹き出しの数。
   *
   * `mode: "add"` は呼ぶたびに足せるので、上限が無いと注釈は人間の画面を
   * 埋めるための無限の面になる（1回の上限20だけでは足りない ―― 制限は
   * 呼び出し回数のほうにしか掛かっていない）。溢れたら**古いものから**捨てる。
   */
  static readonly MAX_THREADS = MAX_ANNOTATION_THREADS;

  /**
   * 作者名は**固定の文字列**（色ごとの表 `ANNOTATION_AUTHOR` と無印）。
   * エージェントに決めさせない。
   *
   * 吹き出しには作者名が出る。ここを引数にすると、人間の名前や
   * 「VS Code」を名乗った吹き出しを描けることになる ―― ステータスバーの
   * codicon なりすましと同じ形の攻撃である（設計書 §5.4）。
   * 色を作成者名に出すようになっても（D57）、エージェントの文字列は表の
   * **鍵の照合**にしか使われず、値になる経路は無い。
   */
  private controller: vscode.CommentController | undefined;
  private readonly entries: AnnotationEntry[] = [];
  /** 次の注釈の連番。1始まり。札（`annotation-N`）の元でもある。 */
  private nextId = 1;

  /**
   * 塗りの持ち主は注釈である（増分6 D65 / D66）。画家は `Highlights` の1つで、
   * ストアはその注釈層に札つきで登録・抹消するだけ。ここで `setDecorations` は呼ばない（§C2）。
   */
  constructor(private readonly highlights: AnnotationPainter) {}

  /**
   * 1件出す。**`body` は既に無害化済みのプレーンな文字列**であること
   * （無害化は `protocol` の `sanitizeDisplayText` が1つだけ持つ。不変条件7）。
   *
   * `color` は**閉じた語彙**（設計 D57）。作成者名に出る（`ShowMe 🔴 R`）**と同時に
   * 行にも塗る**（増分6 D65）。省略すると無印（`ShowMe`）で、**灰で塗る**（増分6.1 D78）。
   *
   * `range` は1始まりの行範囲のまま受ける。吹き出しの位置（`toRange`）と塗りの範囲・種類
   * （`toHighlightRange`）を**同じ1つの値から**作るためで、呼ぶ側が vscode の Range に
   * 直してから渡す形だと、塗りの種類（行全体か文字か）を決める場所がもう1つできる
   * （不変条件14。決めるのは `line-range-vscode.ts` の1関数）。
   *
   * **色が載るのは `author.name` であって `body` ではない。** 本文は
   * `string` のままである（設計 D48 / 設計書 §3.2.1）。ここを混同して
   * 本文を markdown の値にすると、リモート画像も `command:` リンクも戻る。
   *
   * 返すのは `id`（窓内で単調増加）**だけ**。`index` は返さない ―― 同じ呼び出しの後続の
   * 項目が上限の押し出しを起こすと、ここで読んだ位置は1つずれる（`1/64` の吹き出しに
   * `index: 64` と答える）。読む順は**全部足した後に `list()` を1回**読んで決める
   * （`handlers/annotate.ts`。同じ量を2回決めない ―― 不変条件14）。
   */
  add(uri: vscode.Uri, range: LineRange, body: string, color?: AnnotationColor): { id: number } {
    const controller = this.ensureController();
    // 作者名は `renumber()` が総数から付け直すので、ここでは仮に「1件だけ」の名前を
    // 置く（表の**値**はリテラルだけ。エージェントの文字列は鍵の照合にしか使われない。D57）。
    const thread = controller.createCommentThread(uri, toRange(range), [
      {
        body,
        // `Editing = 0` なので、未設定は「編集中」に倒れる。必ず明示する。
        mode: vscode.CommentMode.Preview,
        author: { name: annotationAuthor(color, 1, 1) },
      },
    ]);
    // 返信できない読み取り専用の吹き出しにする。返信欄を出す口
    // （controller 側の範囲プロバイダ）は設定しない ―― 設定すると人間が
    // ファイルのどこにでもコメントを書ける UI が生える。
    thread.canReply = false;
    thread.label = "ShowMe";
    // 畳まれていると行の下に出ない。出ていることが可視化なので、開いておく。
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    // 読了は1ビット（§C3）。ここでは `state` だけを置く。`when` 句が見る `contextValue`
    // は読了と**位置**を1つの文字列で持つ（D79）ので、位置が決まる `renumber()` が
    // `applyContext` で書く ―― `add` が自分の分だけ書く形にしない（不変条件14）。
    thread.state = vscode.CommentThreadState.Unresolved;

    const id = this.nextId;
    this.nextId += 1;
    // `index` は `renumber()` が書く。ここの 0 は「まだ数えていない」の印で、外には出ない。
    const entry: AnnotationEntry = {
      id,
      index: 0,
      key: `annotation-${id}`,
      color,
      line: range.startLine,
      thread,
    };
    // **無印は灰で塗る（増分6.1 D78。D65 の「塗らない」を撤回）。** 灰は protocol の
    // `UNMARKED_ANNOTATION_PAINT` 1つが決め、ここはそれに倒すだけ。塗る色は `show_code` と
    // 同じ語彙・同じ表（`HIGHLIGHT_RGBA`）で、注釈の色（灰無し）はその部分集合なのでそのまま通る。
    // `entry.color` は `undefined` のまま ―― 作者名も観測面も無印のまま（灰はエージェントの色ではない）。
    this.highlights.setAnnotation(
      entry.key,
      uri,
      toHighlightRange({ ...range, color: color ?? UNMARKED_ANNOTATION_PAINT }),
    );

    this.entries.push(entry);
    while (this.entries.length > Annotations.MAX_THREADS) {
      const oldest = this.entries.shift();
      if (oldest !== undefined) this.disposeEntry(oldest);
    }
    // 総数が変わった（足した・押し出した）ので、全部の番号を付け直す。
    this.renumber();
    return { id: entry.id };
  }

  /**
   * 全スレッドの `index` と作者名と `contextValue` の位置を、いまの一覧から付け直す
   * （増分6 D69 / 増分6.1 D79）。
   *
   * **総数が変わる経路はすべてここを通る**（追加・上限の押し出し。`clearAll` は 0 件に
   * なるので付け直すものが無い）。番号を決めるのはこの1箇所で、`add` が自分の分だけ
   * 番号を計算する形にしない ―― 分母は総数なので、1件足せば**既存の全件**が変わる。
   * 端（first / last / only）も総数で決まる量なので、同じ場所で書く。
   *
   * `thread.comments` は**配列ごと再代入する**。VS Code の comment thread はプロパティの
   * 代入で描き直し、要素（`comments[0].author.name`）の書き換えでは描き直さない。
   * 本文と `mode` はそのまま写す（本文は `string` のまま。D48）。
   */
  private renumber(): void {
    const total = this.entries.length;
    this.entries.forEach((entry, position) => {
      const index = position + 1;
      entry.index = index;
      const name = annotationAuthor(entry.color, index, total);
      entry.thread.comments = entry.thread.comments.map((comment) => ({
        ...comment,
        author: { name },
      }));
      this.applyContext(entry, total);
    });
  }

  /**
   * `contextValue` を書く**唯一の場所**（増分6.1 D79）。
   *
   * `"<resolved|unresolved> <first|middle|last|only>"` ―― 読了（`thread.state`）と位置
   * （`index` と総数）を1つの文字列で持ち、`package.json` の `when` 句が正規表現で読む
   * （Resolve は `=~ /^unresolved/`、‹ は `=~ /(middle|last)$/`、› は `=~ /(first|middle)$/`）。
   * 読了は `setResolved` が、位置は `renumber()` が変える。どちらもここを呼ぶ ―― 2箇所が
   * 別々に文字列を組み立てると、片方が位置を落として端のボタンが戻る（不変条件14）。
   * `get_editor_state` が読む `resolved` は `thread.state` のほうで、ここはそれを写すだけ。
   */
  private applyContext(entry: AnnotationEntry, total: number): void {
    const resolved = entry.thread.state === vscode.CommentThreadState.Resolved;
    const position =
      total <= 1 ? "only" : entry.index === 1 ? "first" : entry.index === total ? "last" : "middle";
    entry.thread.contextValue = `${resolved ? "resolved" : "unresolved"} ${position}`;
  }

  /**
   * 人間の読了（`Resolve` / `Unresolve`）を1件に書く（増分6 D70）。
   *
   * `thread` が**この店の一覧にあるものか**を同一性で確かめてから触る。命令の `when`
   * 句（`commentController == showme.annotations`）は他拡張のスレッドを隠すが、
   * `when` は作法であって構造ではない ―― `executeCommand` は同じ拡張ホストの誰でも
   * 呼べ、任意のオブジェクトを渡せる。一覧に無ければ**何もせず** false を返す
   * （捨てた後の古いスレッドも同じ。dispose 済みのスレッドに書いて VS Code を
   * 怒らせない）。
   *
   * 切り替えても番号（`index`・作者名）と `id` は変わらない ―― 順番は案内であって
   * 未読管理ではない（§C3 / D79）。人間から流れるのはこの1ビットだけで、文字列は
   * 流れない: 返信・編集・削除・リアクションの口は引き続き無い（`canReply = false`、
   * controller の返信欄の口・リアクションの口は未設定）。
   *
   * `state`（`get_editor_state` が読む）を書き、`contextValue`（`when` 句が読む）は
   * `applyContext` に写させる ―― 別々に書くと表示と観測が食い違う（不変条件14）。
   */
  setResolved(thread: vscode.CommentThread, resolved: boolean): boolean {
    const entry = this.entries.find((e) => e.thread === thread);
    if (entry === undefined) return false;
    entry.thread.state = resolved
      ? vscode.CommentThreadState.Resolved
      : vscode.CommentThreadState.Unresolved;
    this.applyContext(entry, this.entries.length);
    return true;
  }

  /**
   * いま出ている注釈の一覧（増分6 D72）。**読む順（`index`）に並ぶ。**
   *
   * `get_editor_state.annotations` は**この1回の観測から**作る（増分4 の `groups` /
   * `openPaths` と同じ形。不変条件14）。`annotatedUris` / `annotatedBodies` は統合テストの
   * 観測口で、こちらは線に載る側 ―― 本文は含めない（§C6）。
   *
   * `resolved` は `thread.state`（人間の Resolve は `setResolved` が書く。D70）。
   */
  list(): AnnotationListEntry[] {
    return this.entries.map(({ id, index, color, line, thread }) => {
      const base = {
        id,
        index,
        uri: thread.uri,
        // 行は**観測**する（人間が編集すれば VS Code がスレッドを動かす）。`range` が
        // 無い型（ファイル全体のスレッド）は我々には無いので、無ければ出したときの行。
        line: thread.range === undefined ? line : thread.range.start.line + 1,
        resolved: thread.state === vscode.CommentThreadState.Resolved,
      };
      // 無印は鍵ごと省く（`exactOptionalPropertyTypes`。既定色に倒さない）。
      return color === undefined ? base : { ...base, color };
    });
  }

  /**
   * 押した吹き出しの隣の注釈（増分6.1 D79）。`direction` が 1 なら次、-1 なら前。
   * 端（先頭の前・末尾の次）と、自分の一覧に無いスレッドは `undefined`。
   *
   * **起点は吹き出しである。** 「次」は命令の状態ではなく、押した吹き出しの `index` から
   * 決まる ―― だからストアにカーソルは無い（不変条件13 にも素直）。自分のものかは
   * `setResolved` と同じく同一性で決める（`when` 句は作法であって構造ではない）。
   *
   * 順番は `list()` の**1回の観測**から取る（`get_editor_state.annotations` と同じ面。
   * 不変条件14）―― `entries` を直接読んで `index` をもう一度数えない。`list()` は
   * `entries` と同じ並びなので、起点の位置は `entries` の同一性照合で、隣は `list()` で読める。
   *
   * **読了済みも飛ばさない。** 順番は案内であって未読管理ではない（§C3）。
   * ここは**位置を決めるだけ**で、ファイルを開くのは `extension.ts` の命令が
   * **人間の規則**（`human-reveal.ts`）で行う ―― `show_code` の `Stage.open` ではない。
   */
  neighbor(thread: vscode.CommentThread, direction: 1 | -1): AnnotationListEntry | undefined {
    const position = this.entries.findIndex((e) => e.thread === thread);
    if (position < 0) return undefined;
    return this.list()[position + direction];
  }

  /**
   * `id` の吹き出しを開き直す（増分6.1 D79）。案内で行を出したとき、人間が畳んで
   * いれば開く。**代入し直す**（VS Code の comment thread はプロパティの代入で
   * 描き直す。`renumber()` の `comments` と同じ）。自分の一覧に無い `id` は何もせず false。
   */
  expand(id: number): boolean {
    const entry = this.entries.find((e) => e.id === id);
    if (entry === undefined) return false;
    entry.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    return true;
  }

  /**
   * 注釈1件を消す。**吹き出しと塗りを同じ関数で**（増分6 D66）。
   *
   * 消える経路は4つ（`clear` / `replace` / 上限の押し出し / 停止）で、全部ここを通る。
   * 経路ごとに `thread.dispose()` と `removeAnnotation` を並べて書くと、次に足した経路が
   * 片方を忘れた時点で塗りだけが残る。**`thread.dispose()` をここ以外で呼ばない。**
   *
   * 札は無印でも作ってあり、登録していない札の抹消は層が無視する（`HighlightLayers`）。
   * 「色つきだけ抹消する」の分岐をここに持つと、登録の条件と抹消の条件が2箇所になる。
   */
  private disposeEntry(entry: AnnotationEntry): void {
    this.highlights.removeAnnotation(entry.key);
    entry.thread.dispose();
  }

  /**
   * いま吹き出しを出している URI（`uri.toString()`）。**観測のためだけ**。
   *
   * `Highlights.highlightedUris` と同じ理由でここにある ―― VS Code には
   * 吹き出しが描かれているかを問い合わせる API が無いので、統合テストから
   * 確かめられる最も近い面がこの状態である。件数も一緒に見えるように、
   * 同じ URI に複数出ていれば同じだけ並ぶ（重複を潰さない）。潰すと
   * `mode: "replace"` が冪等かどうかが、この面からは判別しなくなる。
   */
  annotatedUris(): string[] {
    return this.entries.map(({ thread }) => thread.uri.toString());
  }

  /**
   * いま出ている吹き出しの本文と作成者名。**観測のためだけ**
   * （`annotatedUris` と同じ理由）。
   *
   * `kind` は本文が VS Code に渡った**型**である。ここが `"string"` でなくなると
   * markdown のレンダラに載るということなので、リンク・画像・アイコン展開が
   * 一斉に戻ってくる（設計書 §3.2.1）。型で閉じているつもりが閉じていないことを、
   * 統合テストが実機で判別できるようにしておく。
   * **色を足してもここが `"string"` のままであること**が、増分4 で崩しては
   * ならない性質である（設計 D48）。
   *
   * `author` は `author.name` そのもの。色が作成者名に出ているか（D57:
   * `ShowMe 🔴 R`、無印は `ShowMe`）を実機で見る口である。
   *
   * 秘密は返さない ―― ここにあるのはエージェントが送ってきた説明そのもので、
   * 既に人間の画面に出ているものである。
   */
  annotatedBodies(): Array<{ kind: string; text: string; author: string }> {
    return this.entries.map(({ thread }) => {
      const comment = thread.comments[0];
      const body = comment?.body;
      const author = comment?.author.name ?? "";
      return typeof body === "string"
        ? { kind: "string", text: body, author }
        : { kind: typeof body, text: "", author };
    });
  }

  /**
   * 吹き出しに**無い UI**を観測するための材料（統合テスト専用。`annotatedUris` と同じ理由）。
   *
   * スレッドごとの `canReply` と、controller の読み取り専用の眺め。controller の
   * **どの口を見るか**（返信欄の口・リアクションの口）は `annotation-ui-observation.ts` が
   * 決める ―― その口の名前は注釈の経路の禁止語で（`test/annotation-body-is-plain-text.test.ts`）、
   * このファイルには観測のためであっても書かない。controller が未作成（1件も出していない）
   * なら `undefined`。
   *
   * 返す controller は**生きた本物**で、`Readonly` は型の上だけである（`as` で戻せば書ける。
   * それを `test/annotation-body-is-plain-text.test.ts` が観測のファイルに対して禁じている）。
   * 呼ぶのは Test モードの `showme.test.inspectVisuals` ただ1つ。
   */
  observeUi(): { canReply: boolean[]; controller: Readonly<vscode.CommentController> | undefined } {
    return {
      canReply: this.entries.map(({ thread }) => thread.canReply === true),
      controller: this.controller,
    };
  }

  /**
   * `id` のスレッドそのもの（統合テスト専用）。
   *
   * VS Code にはスレッドを列挙する API が無く、`comments/commentThread/title` の
   * ボタンが渡す引数（スレッド）を統合テストが手に入れる道はここしかない。
   * 本番の経路（`setResolved`）は同一性で照合するので、ここから取ったものを
   * `executeCommand("showme.annotation.resolve", thread)` に渡すと本物の命令が通る。
   */
  threadById(id: number): vscode.CommentThread | undefined {
    return this.entries.find((e) => e.id === id)?.thread;
  }

  clearAll(): void {
    for (const entry of this.entries) this.disposeEntry(entry);
    this.entries.length = 0;
  }

  dispose(): void {
    this.clearAll();
    this.controller?.dispose();
    this.controller = undefined;
  }

  /**
   * controller は最初の1件で作る。
   *
   * 先に作っておくと、注釈を一度も出していないウィンドウにも空の
   * コメント機能が登録される。使っていない機能の痕跡を人間の画面に残さない。
   */
  private ensureController(): vscode.CommentController {
    if (this.controller !== undefined) return this.controller;
    const controller = vscode.comments.createCommentController(
      "showme.annotations",
      t("ShowMe (agent annotations)"),
    );
    // リアクションの口も返信欄の口も設定しない（設定しなければその UI は出ない）。
    // 人間からエージェントへ流れるのは読了の1ビットだけ（`setResolved`）。
    // 単体は controller の偽物に鍵が生えないことを見る。
    this.controller = controller;
    return controller;
  }
}

/**
 * 命令の引数が comment thread の**形**をしているか。
 *
 * `comments/commentThread/title` のボタンは `CommentThread` を渡すが、`executeCommand`
 * は誰でも任意の値で呼べる。ここは「`uri` と `comments` を持つ object」だけを見る
 * 構造の関門で、**自分のものかは決めない** ―― それは `Annotations.setResolved` /
 * `neighbor` の同一性照合が決める（決める場所は1つ。不変条件14）。
 */
export function isCommentThreadLike(value: unknown): value is vscode.CommentThread {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { uri?: unknown; comments?: unknown };
  return typeof v.uri === "object" && v.uri !== null && Array.isArray(v.comments);
}
