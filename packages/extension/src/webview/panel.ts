import type { PanelSlot } from "@zvx/vscode-showme-protocol";
import * as vscode from "vscode";
import { ownViewTypeFor } from "../own-view-type.js";
import { SinglePendingTimer } from "../single-pending-timer.js";
import type { Stage, StageColumnSettings } from "../stage.js";
import { FRAME_MESSAGE, buildDisplayDocument, buildOuterHtml } from "./frames.js";
import { type PanelSource, panelPlacement, recreatePanel } from "./panel-recreate.js";
import { watchablePattern } from "./watch-pattern.js";

/**
 * 2枚構成の webview パネル（設計書 §4.1）。**このクラスは1枚を管理する。** 枠（`slot`）は
 * 上限2で（不変条件10「上限2枚」。増分5 D61）、`extension.ts` が枠ごとに1つずつ持つ。
 * 枠は `viewType` に刻む（`ownViewTypeFor(slot)`）―― `get_editor_state` と `move-panel` が
 * タブから枠を読む唯一の材料が `TabInputWebview.viewType` だからである（`own-view-type.ts`）。
 *
 * ここは `vscode` に触る口だけを持つ。HTML の組み立ては `frames.ts`（vscode 非依存）
 * にあり、そちらは単体で検査できる。
 *
 * ## 何を渡していないか
 *
 * - `enableCommandUris` を**設定しない**（既定の false）。設定すると webview から
 *   `command:` を踏めるようになる
 * - `localResourceRoots` は**拡張の `media` だけ**（`media/` はいま無い ―― D57 で
 *   注釈のアイコンを消したので、参照できるローカル資源はゼロである。値は変えない:
 *   既定に任せるとワークスペースが入り、読ませている OSS の中身を webview から
 *   参照できてしまう ―― だから明示する）
 *
 * ## 何を渡しているか
 *
 * - `retainContextWhenHidden` を**真にする**。ここには以前「隠れている間も
 *   走り続ける理由が無い」と書いてあったが、**その理由は誤っていた**
 *   （理由は `createWebviewPanel` の側に書いてある）
 *
 * ## 何を覚えているか
 *
 * `source`（作り直すときに描く正。`panel-recreate.ts`）。`move-panel` は `reveal` ではなく
 * **移動先で作り直す**（`reveal` で動かすと preview タブになり、次の preview で
 * 消える）。DOM を捨てるので、`html` 由来は覚えていたサニタイズ済み HTML を入れ直し、
 * `path` 由来はハンドラの閉包で読み直す。D49 との関係はあちらの冒頭に書いてある。
 */
export class ShowMePanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private nonce = "";
  /**
   * 作り直すときに描く正。**パネルと同じ寿命**で持つ ―― パネルが閉じれば消す
   * （無いパネルを作り直すことは無い）。`html` 由来は `showHtml` が、`path` 由来は `watch` が
   * 据える（`path` は `showHtml` → `watch` の順で来るので、最後に据えた側が正になる）。
   * メモリだけ。ディスクには書かない（不変条件13）。
   */
  private source: PanelSource | undefined;
  /** 表示フレームの読み込み待ち。**投げただけで成功と言わない**ための受領確認。 */
  private pendingDisplay: { resolve: (length: number) => void; timer: NodeJS.Timeout } | undefined;
  /**
   * 直近の表示が**フレームに届いたか**。統合テスト専用の観測点。
   *
   * これが無いと、egress の検査は「フレームが立っていないから何も出なかった」でも
   * 緑になる。実際に組んでいてそうなった ―― 空振りの緑を見分ける口が要る。
   */
  private lastDisplay: { acknowledged: boolean; length: number } = {
    acknowledged: false,
    length: 0,
  };
  /**
   * `measureDisplayedLength` の待ち。**統合テスト専用の観測点**。
   *
   * `pendingDisplay` とは別に持つ。あちらは「投げたものが届いたか」を待つもので、
   * こちらは「いま何が入っているか」を問うものである ―― 同じ待ちに相乗りさせると、
   * 測っている最中に来た表示の受領で解決してしまう。
   */
  private pendingMeasure: { resolve: (length: number) => void; timer: NodeJS.Timeout } | undefined;
  /** 表示フレームの読み込み待ちの上限。隠れているパネルは load を起こさない。 */
  private static readonly DISPLAY_TIMEOUT_MS = 3_000;
  /**
   * `show_html({ path })` の見張り（設計 C4）。**パネルにつき1つ。**
   *
   * 見張りは「変わった」を `rerender` に伝えるだけで、何を描くかは決めない
   * （ハンドラの閉包が関門とサニタイザを毎回通す）。タイマーは見張りと同じ寿命で
   * 持つ ―― `SinglePendingTimer` は `dispose()` で永久に止まるので、見張りごとに作る。
   */
  private watching: { watcher: vscode.FileSystemWatcher; timer: SinglePendingTimer } | undefined;
  /** 連続する保存イベントを畳む幅。人間の保存は秒単位なので、これで十分に短い。 */
  private static readonly RERENDER_DEBOUNCE_MS = 150;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly stage: Stage,
    /** この面がどの枠か。**`viewType` を決めるためだけ**に持つ（判断には使わない）。 */
    private readonly slot: PanelSlot,
    /** 舞台の列の選び方の設定。新しく作るときに1回だけ読む（D90）。 */
    private readonly columnSettings: () => StageColumnSettings,
  ) {}

  /**
   * 表示フレームに**サニタイズ済みの** HTML を入れる。
   *
   * この引数は既に `sanitizeHtml` を通っていること。ここでは通さない ――
   * 通すと「どこで無害化されたか」が2箇所になり、片方を外したときに気づけない。
   */
  async showHtml(sanitizedHtml: string, title: string): Promise<void> {
    const panel = this.ensurePanel(title);
    // 正を据えるのは**入れる前**。入れてから据えると、届くのを待つあいだに `move-panel` が
    // 来たとき、古い正で作り直す。
    this.source = { kind: "html", sanitized: sanitizedHtml };
    await this.post(panel, sanitizedHtml);
  }

  /**
   * **いまあるパネルの中身だけ**を差し替える（`show_html({ path })` の再描画用）。
   *
   * `showHtml` と違って **`reveal` しない**。再描画は人間の保存のたびに起きるので、
   * そのたびにパネルを列の前面に出すと、人間が同じ列で別のタブを見ていても
   * 保存のたびに奪われる。`retainContextWhenHidden` なので、隠れている webview にも
   * `postMessage` は届き、次に見たときには新しい中身になっている。
   * パネルが無ければ何もしない（閉じたなら見張りも畳まれている。**新しく作らない**）。
   */
  async refreshHtml(sanitizedHtml: string): Promise<void> {
    const panel = this.panel;
    if (panel === undefined) return;
    await this.post(panel, sanitizedHtml);
  }

  /** 表示フレームにサニタイズ済みの HTML を入れ、届くのを待つ。`showHtml` / `refreshHtml` の共通部。 */
  private async post(panel: vscode.WebviewPanel, sanitizedHtml: string): Promise<void> {
    // **表示フレームが読み込み終えるまで待つ。** 投げただけで「出した」と言うと、
    // フレームが立っていない状態でも成功が返る ―― 検査から見ると空振りの緑になる。
    const displayed = new Promise<void>((resolve) => {
      const previous = this.pendingDisplay;
      if (previous !== undefined) {
        clearTimeout(previous.timer);
        previous.resolve(-1);
      }
      this.lastDisplay = { acknowledged: false, length: 0 };
      const timer = setTimeout(() => {
        this.pendingDisplay = undefined;
        // 待ちが明けなくても表示そのものは失敗ではない（隠れているだけのことがある）。
        resolve();
      }, ShowMePanel.DISPLAY_TIMEOUT_MS);
      this.pendingDisplay = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        timer,
      };
    });
    // **baseline を前置してから**渡す。エージェントが配色を書かなくても読める
    // 状態を既定にする（実地で「黒地に黒」になったため。設計 D29）。
    await panel.webview.postMessage({
      type: FRAME_MESSAGE.display,
      html: buildDisplayDocument(sanitizedHtml),
    });
    await displayed;
  }

  /**
   * パネルを `column` へ動かす（増分5 D59 `move-panel`）。**破棄して作り直す**。
   *
   * `reveal(column)` は**使わない**。実測: `reveal` で動かしたパネルは移動先で
   * preview タブになる（VS Code の `revealWebview` は `openEditor` に `pinned` を渡さない。
   * 作るときの `openWebview` は `pinned: true`）。preview はその列に次に preview で開かれた
   * ものに差し替えられて閉じるので、`gather-own` で両枠を1列に集めると先に動かした枠が
   * 消えた（`moved: 2` と報告しながら）。拡張の API に pin する口は無いので、
   * `createWebviewPanel`（pinned で開く）で移動先に作り直し、正から描き直す。
   *
   * 順序と正の選び方は `recreatePanel`（vscode 非依存。単体で固定）。ここは手を渡すだけ:
   *
   * - `create`: **最初に作るのと同じ `ensurePanel`** を通す（作る道は1本。外側の HTML も
   *   nonce も CSP もそこで決まる）。`this.panel` を先に空にして「無ければ作る」に入れる
   * - `disposeOld`: 古い `WebviewPanel` を破棄する。`onDidDispose` の手は「いまのパネルか」で
   *   守ってあるので、据え替えたあとの破棄は見張りも待ちも正も消さない。**見張りは
   *   `WebviewPanel` を参照していない**（`rerender` → `refreshHtml` → `this.panel`）ので、
   *   付け直さなくてもそのまま新しいパネルに描く
   * - `post`: 新しいパネルの表示フレームに入れる（`showHtml` と同じ `post`）
   *
   * 待ち（`pendingDisplay` / `pendingMeasure`）は据え替える前に畳む ―― 古いパネル宛の
   * 待ちを、新しいパネルからの答えで解かない（`settlePending` の理由と同じ）。
   * `preserveFocus: true`（人間のタイピング先を取らない）。パネルが無ければ false。
   * **判断はしない**（誰の列かはハンドラが決めている）。
   */
  async moveTo(column: number): Promise<boolean> {
    const old = this.panel;
    if (old === undefined) return false;
    const title = old.title;
    await recreatePanel(this.source, {
      create: () => {
        this.settlePending();
        this.panel = undefined;
        try {
          this.ensurePanel(title, column as vscode.ViewColumn);
        } catch (error) {
          // **作れなかったら古いパネルを戻す。** 戻さないと、古いパネルは開いたまま
          // 持ち主を失い（`onDidDispose` の守りで外れる）、人間が閉じたときに見張りが
          // 漏れ、次の `showHtml` が同じ枠に2枚目を作る。
          this.panel = old;
          throw error;
        }
      },
      disposeOld: () => {
        old.dispose();
      },
      post: async (sanitized) => {
        const panel = this.panel;
        if (panel === undefined) return;
        await this.post(panel, sanitized);
      },
    });
    return true;
  }

  /** 統合テストが「本当に届いたか」を見るための観測点。**判断には使わない。** */
  displayState(): { acknowledged: boolean; length: number } {
    return { ...this.lastDisplay };
  }

  /**
   * いま**表示フレームに入っている** HTML の長さを問い合わせる（統合テスト専用）。
   *
   * `displayState()` は「最後に投げたものが届いたか」しか言わない ―― 隠れて
   * 中身が消えても、その記録は残る。**その記録に対して assert すると、DOM が
   * 消えていても緑になる**（この repo が一度出荷した「成功した」と「実際に
   * 描かれた」の取り違えと同じ形である）。**いま何が入っているか**を、
   * 生きているフレームに聞く口が別に要る。
   *
   * 中身は返さない（長さで足りる。不変条件2）。パネルが無ければ 0、
   * 答えが返ってこなければ -1。
   */
  async measureDisplayedLength(): Promise<number> {
    const panel = this.panel;
    if (panel === undefined) return 0;
    return new Promise<number>((resolve) => {
      const previous = this.pendingMeasure;
      if (previous !== undefined) {
        clearTimeout(previous.timer);
        previous.resolve(-1);
      }
      const timer = setTimeout(() => {
        this.pendingMeasure = undefined;
        resolve(-1);
      }, ShowMePanel.DISPLAY_TIMEOUT_MS);
      this.pendingMeasure = { resolve, timer };
      // 投げそこねたら待たない。捨てると、フレームが居ないときに
      // `DISPLAY_TIMEOUT_MS` だけ黙って待つ（`showHtml` は await している）。
      panel.webview.postMessage({ type: FRAME_MESSAGE.measure }).then(undefined, () => {
        if (this.pendingMeasure?.timer === timer) {
          clearTimeout(timer);
          this.pendingMeasure = undefined;
          resolve(-1);
        }
      });
    });
  }

  /**
   * `relPath` を見張り、変わるたびに `rerender` を呼ぶ（設計 C4）。
   *
   * **見張るのは綴り**（ワークスペースの中の、人間が編集するそのファイル）。
   * 中身を読んでよいかは毎回 `rerender` の中の関門が決めるので、ここは判断を持たない。
   * 綴りは `watchablePattern` が関門と同じ関数で揃え、glob の記号を含む名前
   * （`docs/*.html` という実在のファイル）は**見張らない** ―― `RelativePattern` は glob
   * なので、そのまま張ると1ファイルより広い集合を見張ることになる（閉じる側に倒す）。
   *
   * **消えても見張りは畳まない。** temp に書いて rename で差し替える編集器（アトミック保存）は、
   * 見張りから見ると delete → create になりうる。delete で畳むと、その形の保存の1回目で
   * 表示が黙って止まる ―― 安全側の検査は全部緑のまま機能だけが死ぬ向き（不変条件14 の
   * 3A / 3A' と同じ）。delete も「変わった」として同じ `rerender` に流す。安全性は変わらない:
   * 再描画は毎回関門を通り、無いあいだは `undefined` で描き直さず、作成されたら描き直す。
   *
   * 見張りが終わるのは3つだけ: 次の `watch` / `unwatch`（`html` で出し直したとき）、
   * パネルが閉じたとき、`dispose()`。前の見張りがあれば止める。
   */
  watch(relPath: string, rerender: () => Promise<void>): void {
    this.unwatch();
    // **正は `path` になる**。見張りが張れない綴り（glob の記号）でも正は
    // ファイルである ―― 作り直すときは覚えている HTML ではなく閉包で読み直す。
    this.source = { kind: "path", rerender };
    const root = vscode.workspace.workspaceFolders?.[0];
    if (root === undefined) return;
    const pattern = watchablePattern(relPath);
    if (pattern === undefined) return;
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(root, pattern),
    );
    const timer = new SinglePendingTimer();
    const kick = () => {
      timer.schedule(() => {
        // 失敗は握る。再描画はエージェントの呼び出しではないので、線に載せる先が無い
        // （閉包の側でも記録だけして投げない。ここは unhandled rejection にしない保険）。
        rerender().catch(() => undefined);
      }, ShowMePanel.RERENDER_DEBOUNCE_MS);
    };
    watcher.onDidChange(kick);
    watcher.onDidCreate(kick);
    watcher.onDidDelete(kick);
    this.watching = { watcher, timer };
  }

  /** 見張りを止める。`html` で出し直したとき、パネルが閉じたとき、破棄のとき。 */
  unwatch(): void {
    const current = this.watching;
    this.watching = undefined;
    if (current === undefined) return;
    current.timer.dispose();
    current.watcher.dispose();
  }

  dispose(): void {
    this.unwatch();
    this.settlePending();
    this.source = undefined;
    this.panel?.dispose();
    this.panel = undefined;
  }

  /**
   * 飛んでいる待ちを畳む。**破棄のときに必ず通る。**
   *
   * 畳まないと、タイマーが最大 `DISPLAY_TIMEOUT_MS` のあいだ生き残る。その窓の
   * 中で新しいパネルができると、**新しいパネルからの答えが古い待ちを解く** ――
   * 待ちの器はインスタンスに紐づくので、器が残っていれば宛先も残っているからである。
   * 統合テスト専用の経路だが、`pendingDisplay` も同じ形をしていたので両方まとめて閉じる。
   */
  private settlePending(): void {
    const display = this.pendingDisplay;
    this.pendingDisplay = undefined;
    if (display !== undefined) {
      clearTimeout(display.timer);
      display.resolve(-1);
    }
    const measure = this.pendingMeasure;
    this.pendingMeasure = undefined;
    if (measure !== undefined) {
      clearTimeout(measure.timer);
      measure.resolve(-1);
    }
  }

  /**
   * 無ければ作る。**作る道はここ1本**（初回も `move-panel` の作り直しも）。
   *
   * @param column 作る列。省略時は枠の既定の置き場（`panelPlacement`）を舞台に当てる。
   *   `move-panel` はハンドラが判定した列をそのまま渡す（ここで判断しない）。
   */
  private ensurePanel(title: string, column?: vscode.ViewColumn): vscode.WebviewPanel {
    const existing = this.panel;
    if (existing !== undefined) {
      // **タイトルで新しいパネルを作らない**（不変条件10）。同じ枠の1枚を使い回す。
      existing.title = title;
      // フォーカスは奪わない。人間のタイピング先を取らないこと。
      existing.reveal(existing.viewColumn, true);
      return existing;
    }

    this.nonce = createNonce();
    const panel = vscode.window.createWebviewPanel(
      ownViewTypeFor(this.slot),
      title,
      // 既定の置き場は枠で決まる（`panelPlacement`: 枠1は舞台の1列目、枠2は2列目）。
      // `StagePlacement.slot` は**舞台の列の番号**で、パネルの枠とは別の量。
      {
        // 置ける列が無ければ `targetColumn` が `no-stage-column` で断る（D90）。パネルを作る前なので
        // 何も残らない。既にあるパネルを出し直すときはここを通らない（その列に居続ける）。
        viewColumn:
          column ?? this.stage.targetColumn(panelPlacement(this.slot), this.columnSettings()),
        preserveFocus: true,
      },
      {
        enableScripts: true,
        // **隠れているあいだも DOM を保つ**（増分 4A / 設計 D49）。
        //
        // ここには以前「隠れている間も走り続ける理由が無い」と書いてあったが、
        // **その理由は誤っていた**。VS Code は webview が隠れると DOM ごと捨て、
        // 再表示時に `webview.html` から作り直す。作り直された外側には
        // `buildOuterHtml` の骨しか無く、`postMessage` で入れた表示フレームの
        // 中身は戻らない（`postMessage` は状態ではなく**出来事**である）。
        // 実地で「同じ列で表示を切り替えて戻ると空になる」として観測された。
        //
        // 代案（最後の HTML を拡張側で覚えて再投入）は採らない ―― webview の
        // DOM と拡張のフィールドが**同じ量を2箇所で持つ**ことになる（不変条件14）。
        //
        // メモリの懸念は作図ツールのバンドル（3.29 MiB）を消したことで消えた。
        // 保持されるのはエージェントが出した HTML（上限 MAX_HTML_CHARS）だけである。
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
      },
    );
    panel.webview.html = buildOuterHtml(panel.webview.cspSource, this.nonce);
    panel.webview.onDidReceiveMessage((message: unknown) => {
      this.onMessage(message);
    });
    panel.onDidDispose(() => {
      // **いまのパネルでなければ何もしない。** `move-panel` は新しいパネルに据え替えてから
      // 古いほうを破棄する（`recreatePanel`）ので、その通知で見張り・待ち・正を消すと
      // 動かした直後の描き直しが黙って止まる（安全側に閉じすぎる向き。不変条件14 の 3A）。
      if (this.panel !== panel) return;
      // 人間がパネルを閉じたときも待ちを畳む（`dispose()` と同じ理由）。
      // 見張りも畳む ―― パネルが無いのに描き直しても行き先が無く、
      // `ensurePanel` が新しいパネルを勝手に作ることになる。正も消す（作り直す相手が無い）。
      this.unwatch();
      this.settlePending();
      this.source = undefined;
      this.panel = undefined;
    });
    this.panel = panel;
    return panel;
  }

  private onMessage(message: unknown): void {
    if (typeof message !== "object" || message === null) return;
    const data = message as { type?: unknown; length?: unknown };

    if (data.type === FRAME_MESSAGE.measured) {
      const pending = this.pendingMeasure;
      this.pendingMeasure = undefined;
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        pending.resolve(typeof data.length === "number" ? data.length : 0);
      }
      return;
    }

    if (data.type !== FRAME_MESSAGE.displayed) return;

    const pending = this.pendingDisplay;
    this.pendingDisplay = undefined;
    const length = typeof data.length === "number" ? data.length : 0;
    this.lastDisplay = { acknowledged: true, length };
    pending?.resolve(length);
  }
}

/**
 * nonce。**呼び出しごとではなくパネルごと**（外側の HTML の CSP と script に同じ値が要る）。
 *
 * 推測できないことが要件なので、乱数は暗号用のものを使う。
 */
function createNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
