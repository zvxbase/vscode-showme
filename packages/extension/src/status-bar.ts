import { type WindowRole, sanitizeStatusText } from "@zvx/vscode-showme-protocol";
import type * as vscodeTypes from "vscode";
import { t } from "./l10n.js";
import { SinglePendingTimer } from "./single-pending-timer.js";

/**
 * "vscode" モジュールを遅延取得する（config.ts と同じ理由）。
 *
 * トップレベルで value import すると、表示文字列を組み立てるだけの純関数
 * （`statusView`）を確かめるテストの読み込み自体が「Failed to load url
 * vscode」で落ちる。可視化がこの道具の防御である以上、その文字列は単体で
 * 検証できなければならない。
 */
function getVSCode(): typeof vscodeTypes {
  return require("vscode") as typeof vscodeTypes;
}

/**
 * エージェント由来の文字列を画面に載せる前に無害化する。
 *
 * **中身は `protocol` の `sanitizeStatusText` である**。
 * ここに置いてあるのは名前だけで、判定は1箇所にしかない。ステータスバー用の
 * 追加分（codicon 記法 `$(name)` を壊す）も向こうにある ―― こちらに書き足すと、
 * 同じ理由で無害化している他の経路が黙って置き去りになる。
 *
 * 起動失敗の理由もここを通す。`prepareRuntimeDir` の理由にはパスが入り、
 * そのパスは攻撃者が先回りして置いたディレクトリの名前でありうる。
 *
 * **`t()` の後に通す。** 動的な値を埋めた文を作ってから、その文全体を無害化する
 * （D58）。先に値だけ無害化して翻訳に埋める形だと、画面に載る直前の文字列を
 * 誰も見ていない。我々の codicon `$(name)` は `t()` の外に置く（通すと壊れる）。
 */
const forDisplay = sanitizeStatusText;

/** 画面に出す状態のすべて。ここに無い事実は表示に影響しない。 */
export interface StatusModel {
  /** 設定の停止スイッチ（拡張全体）。 */
  enabled: boolean;
  /** 起動に失敗した理由。成功していれば undefined。 */
  failure: string | undefined;
  /** 現に繋がっている接続。無ければ undefined。 */
  connection: { pid: number | undefined } | undefined;
  /** この窓を預けているか（設計書 §2A.2）。既定は "idle"。 */
  role: WindowRole;
}

export interface StatusView {
  text: string;
  tooltip: string;
}

/**
 * 状態から表示を決める（純関数）。
 *
 * **主語は役割である**（設計書 §2A.3）。既定はどの窓も預けられていないので、
 * 何もしていない窓は「受け付けています」ではなく「オフ」と描く（`ShowMe: Off`。
 * 「Lent / Not lent」は実機で分かりにくいと言われて On / Off に変えた）。
 * 既定が操作**不可**であることが画面から読めないと、人間は預けたつもりの
 * ない窓を預けたと思う（あるいはその逆）。
 *
 * **pid が取れないことを前提にする。** Node は `net.Socket` に接続元 PID を
 * 公開しないので、実機ではまず `undefined` になる。「pid が取れたときだけ
 * 表示する」設計にすると、可視化（設計書 §3.5 / §5.3 / D21）は実質存在しない
 * ことになる。だから**接続していること自体を出し**、pid は取れたときの追記に
 * とどめる。
 *
 * 優先順位は「停止中 > 起動失敗 > 役割 > 接続状態」。
 *
 * - 停止中が最優先なのは、人間が押したスイッチの結果を画面から消さないため
 * - 起動失敗が役割より上なのは、預けても動かない窓を「オン」と描かないため
 * - 役割が接続状態より上なのは、**ソケットは役割と独立に立っている**から。
 *   預けていない窓にブリッジが繋ぐことはできる（そこでツールが全部拒否される）。
 *   そのとき「接続中」とだけ描くと、何も通らない窓が通るように見える
 *
 * **画面に出す動的な文字列は必ず `forDisplay` を通す。** ここで動的なのは
 * 起動失敗の理由（攻撃者が名前を決めうるパスが入る）だけで、残りはこの
 * ファイルのリテラルと数値の pid である。役割は protocol の閉じた列挙なので
 * 文字列として画面に載せない（載せると語彙が増えるだけで、判別は増えない）。
 * リテラル自体は `forDisplay` に通さない ―― 通すと `$(shield)` のような
 * **我々の** codicon まで壊れて、状態を表すアイコンが消える。
 *
 * 人間向けの文字列は `t()` を通る（D58）。鍵は英語の原文で、codicon は鍵の外。
 */
export function statusView(model: StatusModel): StatusView {
  if (!model.enabled) {
    return {
      text: `$(circle-slash) ${t("ShowMe: Stopped")}`,
      // クリックは役割のトグルになった（設計書 §2A.3）。停止中に
      // 「クリックで再開」と書くと、押しても再開しない操作を案内することになる。
      tooltip: t(
        'ShowMe is stopped. Resume it from the Command Palette with "ShowMe: Stop / Resume the extension"',
      ),
    };
  }
  if (model.failure !== undefined) {
    return {
      text: `$(error) ${t("ShowMe: Failed to start")}`,
      tooltip: forDisplay(
        t(
          "ShowMe could not open its socket: {0} (details in the ShowMe output channel)",
          model.failure,
        ),
      ),
    };
  }
  if (model.role !== "stage") {
    return {
      text: `$(shield) ${t("ShowMe: Off")}`,
      tooltip: t(
        "ShowMe is off for this window. Click to turn it on (the agent can then show things here)",
      ),
    };
  }
  if (model.connection !== undefined) {
    const pid = model.connection.pid;
    return {
      text:
        pid === undefined
          ? `$(plug) ${t("ShowMe: Connected")}`
          : `$(plug) ${t("ShowMe: Connected (pid {0})", pid)}`,
      tooltip:
        pid === undefined
          ? t("An agent is connected (the peer PID is not available). Click to turn ShowMe off")
          : t("An agent (pid {0}) is connected. Click to turn ShowMe off", pid),
    };
  }
  return {
    text: `$(eye) ${t("ShowMe: On")}`,
    tooltip: t("ShowMe is on for this window. Click to turn it off"),
  };
}

/**
 * 停止スイッチと可視化。
 *
 * この道具の安全性は「副作用が全て画面に出る」ことに強く依存している
 * （設計書 §5.4）。判定基準は「0件かどうか」ではなく**エディタが開くかどうか**で、
 * 開かない結果（空振り・多重一致・回数制限）はすべてここに出す。接続と切断も出す。
 * `get_editor_state` の呼び出し回数制限（パスを持たない、独立した予算）も
 * 同じ経路に乗せる。4種類の点滅は1つのタイマーを共有する（別々に持つと積み上がる）。
 */
export class ShowMeStatusBar {
  private readonly item: vscodeTypes.StatusBarItem;
  private connection: { pid: number | undefined } | undefined;
  private failure: string | undefined;
  private readonly flashTimer = new SinglePendingTimer();
  private disposed = false;

  constructor(
    private enabled: boolean,
    private role: WindowRole = "idle",
  ) {
    const vscode = getVSCode();
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = "showme.toggle";
    this.render();
    this.item.show();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.render();
  }

  /**
   * この窓の役割が変わった。
   *
   * 役割はツール呼び出しの可否そのものなので、画面に出ていない役割は
   * 存在しないのと同じである（人間は自分が何を預けたか確かめられない）。
   */
  setRole(role: WindowRole): void {
    this.role = role;
    this.render();
  }

  /** 接続を受けた。pid は取れないのが普通（Node は公開しない）。 */
  setConnected(pid: number | undefined): void {
    this.connection = { pid };
    this.render();
  }

  /** 最後の接続が切れた。出したままにすると、いつまでも繋がって見える。 */
  setDisconnected(): void {
    this.connection = undefined;
    this.render();
  }

  /**
   * 起動に失敗した。
   *
   * 失敗したのに `$(eye) ShowMe` を出し続けると、受け付けていないものを
   * 受け付けていると言うことになる。理由は必ず `forDisplay` を通す。
   */
  setFailed(reason: string): void {
    this.failure = reason;
    this.connection = undefined;
    this.render();
  }

  /**
   * 空振りを人間に見せる。無音のオラクルを作らないための要件。
   *
   * `needle` は「何を探したか」（`text` / `symbol`、無ければ行指定の説明）。
   * 文を丸ごと1つの `t()` にして、位置は引数で渡す ―― 断片を継ぎ足す形だと、
   * 日本語の束が自然な語順で書けない（D58）。
   */
  flashMiss(path: string, needle: string): void {
    this.item.text = `$(search-stop) ${forDisplay(t("ShowMe: not found in {0}", path))}`;
    void getVSCode().window.setStatusBarMessage(
      forDisplay(t('ShowMe: the agent looked for "{1}" in {0} and found nothing', path, needle)),
      5000,
    );
    // 連続空振りでタイマーが積み上がらないよう、前回分をキャンセルしてから
    // 仕掛け直す（SinglePendingTimer が担う）。dispose() 後は無視される。
    this.flashTimer.schedule(() => this.render(), 5000);
  }

  /**
   * `stage` を切っているので開かずに印だけ付けたことを人間に見せる（増分6 D76）。
   *
   * 開かない結果はすべて画面に出す ―― 空振りと同じく、これが人間に残る唯一の
   * 痕跡である（開いたファイルは無く、見えていないファイルの塗りは開くまで出ない）。
   * `path:line` は人間が自分で場所を探すための手がかりで、`line` は1始まり。
   * 文全体を `forDisplay` に通す（パスはエージェント由来。D58）。
   */
  flashMarked(path: string, line: number): void {
    this.item.text = `$(bookmark) ${forDisplay(t("ShowMe: marked {0}:{1}", path, String(line)))}`;
    void getVSCode().window.setStatusBarMessage(
      forDisplay(
        t(
          "ShowMe: the agent marked {0}:{1} (open the file to see the highlight)",
          path,
          String(line),
        ),
      ),
      5000,
    );
    this.flashTimer.schedule(() => this.render(), 5000);
  }

  /**
   * 多重一致を人間に見せる（設計書 §4.1 ⑥）。
   *
   * 可視化の判定基準は「0件かどうか」ではなく「エディタが開くかどうか」である。
   * `many` は候補を返すだけでエディタが開かないので、`none` と同じく画面に
   * 痕跡が残らない — エージェントにとっては情報量のある結果なのに、である。
   *
   * 候補の行番号は載せない。ステータスバーは狭いうえ、行番号を並べても人間の
   * 役には立たず、画面を通じた露出面だけが増える。
   */
  flashManyMatches(path: string, needle: string): void {
    this.item.text = `$(list-selection) ${forDisplay(t("ShowMe: multiple matches in {0}", path))}`;
    void getVSCode().window.setStatusBarMessage(
      forDisplay(
        t(
          'ShowMe: the agent found "{1}" more than once in {0} (it has to narrow the selector)',
          path,
          needle,
        ),
      ),
      5000,
    );
    this.flashTimer.schedule(() => this.render(), 5000);
  }

  /**
   * レート制限で落とした試行を人間に見せる（設計書 §4.1 ⑦）。
   *
   * 落とされた試行は「空振り」ではないので別の文言にする。攻撃が進行して
   * いるときこそ、何が起きているかが画面から読めている必要がある。
   */
  flashRateLimited(path: string): void {
    this.item.text = `$(circle-slash) ${forDisplay(t("ShowMe: rate limited {0}", path))}`;
    void getVSCode().window.setStatusBarMessage(
      forDisplay(
        t(
          "ShowMe: the agent requested {0} repeatedly in a short time, so it was rate limited",
          path,
        ),
      ),
      5000,
    );
    this.flashTimer.schedule(() => this.render(), 5000);
  }

  /**
   * `get_editor_state` の呼び出し回数制限を人間に見せる。
   *
   * `flashRateLimited` は `show_code` / `annotate` のファイル単位の制限用で、
   * パスを持つ。`get_editor_state` には引数が無く、制限は**呼び出し単位**
   * （器も `sharedEditorStateLimiter` と別。`rate-limit.ts`）なので、
   * 特定のファイルに紐づく表示にはしない ―― **パスを出さない**。
   *
   * この制限は「人間の作業の連続的な軌跡を取られる」ことへの唯一の歯止め
   * （カーソル位置・可視行・選択は毎回変わりうる）なので、それが無音で
   * 発火すると片手落ちになる。`show_code` の3種と**同じタイマー**
   * （`flashTimer` / `SinglePendingTimer`）に乗せる ―― 別々に持つと
   * 積み上がる。
   */
  flashEditorStateRateLimited(): void {
    this.item.text = `$(circle-slash) ${t("ShowMe: editor state reads limited")}`;
    void getVSCode().window.setStatusBarMessage(
      t(
        "ShowMe: the agent tried to read the editor state repeatedly in a short time, so it was rate limited (get_editor_state)",
      ),
      5000,
    );
    this.flashTimer.schedule(() => this.render(), 5000);
  }

  /**
   * 2本目の同時接続を拒否したことを人間に見せる（設計書 §3.5 / D21）。
   *
   * 同一ユーザの他プロセスからの到達は原理的に防げないので、「もう1本来た」
   * ことが見えていること自体が防御の一部になる。設計書は「2本目は人間に
   * 通知する」と書いており、出力チャネルの1行だけでは誰も見ていない。
   *
   * 拒否された側が**正規のブリッジ**であることもある（別のプロセスに先に
   * 座られた場合）。だから文言はどちらの向きでも読めるようにし、断定しない。
   */
  flashSecondConnection(): void {
    this.item.text = `$(warning) ${t("ShowMe: second connection refused")}`;
    void getVSCode().window.setStatusBarMessage(
      t(
        "ShowMe: another connection request arrived while one was already connected, so it was refused (one connection at a time)",
      ),
      5000,
    );
    this.flashTimer.schedule(() => this.render(), 5000);
  }

  /**
   * いま画面に出ている文字列。**観測のためだけ**（統合テスト用）。
   *
   * モデルから作り直さず、`StatusBarItem` そのものを読む。作り直すと
   * 「`render()` を呼び忘れている」実装でも一致してしまい、まさに検査したい
   * 「画面が役割を映しているか」が消える。
   *
   * これが無いと、`applyRole` から `setRole(role)` を消しても単体・統合とも
   * 全部緑のままだった（実測）。可視化はこの道具の防御である（設計書 §5.4）。
   */
  currentView(): StatusView {
    const tooltip = this.item.tooltip;
    return { text: this.item.text, tooltip: typeof tooltip === "string" ? tooltip : "" };
  }

  private render(): void {
    // dispose() 後にタイマー経由で呼ばれても、破棄済みの item に触らない。
    if (this.disposed) return;
    const view = statusView({
      enabled: this.enabled,
      failure: this.failure,
      connection: this.connection,
      role: this.role,
    });
    this.item.text = view.text;
    this.item.tooltip = view.tooltip;
  }

  dispose(): void {
    this.flashTimer.dispose();
    this.disposed = true;
    this.item.dispose();
  }
}
