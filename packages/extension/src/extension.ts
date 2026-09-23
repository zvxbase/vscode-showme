import * as os from "node:os";
import {
  type PanelSlot,
  SOCKET_ENV_VAR,
  type WindowRole,
  type WireRequest,
  annotateArgsSchema,
  arrangeEditorsArgsSchema,
  findDefinitionArgsSchema,
  findReferencesArgsSchema,
  panelSlotSchema,
  processUid,
  runtimeDirCandidates,
  showCodeArgsSchema,
  showHtmlArgsSchema,
  showNoteArgsSchema,
  showViewArgsSchema,
} from "@zvx/vscode-showme-protocol";
import * as vscode from "vscode";
import { buildAgentConfigDocument } from "./agent-config-doc.js";
import { annotationUiSurface } from "./annotation-ui-observation.js";
import { Annotations, isCommentThreadLike } from "./annotations.js";
import { ARRANGE_COMMANDS, createArrangeSurface } from "./arrange-surface.js";
import { readConfig } from "./config.js";
import { Highlights } from "./decorations.js";
import {
  createAnnotationSurface,
  createEditorStateSurface,
  createEditorSurface,
  createSymbolSurface,
} from "./editor-surface.js";
import { type AnnotateDeps, handleAnnotate } from "./handlers/annotate.js";
import {
  type ArrangeEditorsArgs,
  type ArrangeEditorsDeps,
  handleArrangeEditors,
} from "./handlers/arrange-editors.js";
import {
  type FindLocationsDeps,
  handleFindDefinition,
  handleFindReferences,
} from "./handlers/find-locations.js";
import { handleGetEditorState } from "./handlers/get-editor-state.js";
import { handleListWorkspaces } from "./handlers/list-workspaces.js";
import { type ShowCodeDeps, handleShowCode } from "./handlers/show-code.js";
import { type ShowPanelDeps, handleShowHtml } from "./handlers/show-html.js";
import { type ShowNoteDeps, handleShowNote } from "./handlers/show-note.js";
import { type ShowViewDeps, handleShowView } from "./handlers/show-view.js";
import { revealForHuman } from "./human-reveal.js";
import { t, uiLanguage } from "./l10n.js";
import { createLanguageSurface } from "./language-surface.js";
import { ShowMeLog } from "./log.js";
import { createNoteSurface } from "./note-surface.js";
import type { LastWrite } from "./note-target.js";
import { OpenedByAgent } from "./opened-by-agent.js";
import { panelCallLimiter, sharedEditorStateLimiter, sharedFileLimiter } from "./rate-limit.js";
import { readWorkspaceFile } from "./read-workspace-file.js";
import {
  type ConnectionObserver,
  SECOND_CONNECTION_REASON,
  ShowMeSocketServer,
  ToolError,
} from "./server.js";
import { Stage } from "./stage.js";
import { ShowMeStatusBar } from "./status-bar.js";
import { buildTeardownDocument } from "./teardown-doc.js";
import { checkToolGate } from "./tool-gate.js";
import { VIEW_COMMANDS, createViewSurface } from "./view-surface.js";
import { ShowMePanel } from "./webview/panel.js";
import { WindowRoleState } from "./window-role-state.js";
import { acceptWorkspacePath } from "./workspace-path-gate.js";

/** 線上のスキーマが決める show_code の引数の形。 */
type ShowCodeWireArgs = Extract<WireRequest, { tool: "show_code" }>["args"];

/** 線上のスキーマが決める annotate の引数の形。 */
type AnnotateWireArgs = Extract<WireRequest, { tool: "annotate" }>["args"];

/**
 * 線上の引数を handleShowCode の引数へ移し替える。
 *
 * zod の `.optional()` は `layout?: T | undefined` を推論するのに対し、
 * handleShowCode は `layout?: T` を要求する。`exactOptionalPropertyTypes`
 * が有効なので前者は後者へ渡せない（実測: TS2379）。未指定なら**鍵ごと省く**
 * ことで移す（`undefined` を代入しない）。
 *
 * 移し替えはここ1か所にまとめる。線上経路とテスト用コマンドの両方が通るので、
 * 片方だけ形が変わることが起きない。
 */
function toShowCodeArgs(args: ShowCodeWireArgs): Parameters<typeof handleShowCode>[0] {
  return args.layout === undefined
    ? { locations: args.locations }
    : { locations: args.locations, layout: args.layout };
}

/**
 * 線上の引数を handleAnnotate の引数へ移し替える。
 *
 * `toShowCodeArgs` と同じ理由（`exactOptionalPropertyTypes` の下では
 * `mode: undefined` を渡せない）。未指定なら鍵ごと省く。
 */
function toAnnotateArgs(args: AnnotateWireArgs): Parameters<typeof handleAnnotate>[0] {
  // `clear` は items を持たない（設計 D54）。線上の transform が判別可能な形にしてある。
  if (args.mode === "clear") return { mode: "clear" };
  // `color` も**未指定なら鍵ごと省く**（`exactOptionalPropertyTypes`）。
  const items = args.items.map((item) =>
    item.color === undefined
      ? { location: item.location, text: item.text }
      : { location: item.location, text: item.text, color: item.color },
  );
  return args.mode === undefined ? { items } : { items, mode: args.mode };
}

/**
 * 線上の引数を 2C のハンドラの引数へ移し替える。
 *
 * `toShowCodeArgs` と同じ理由（`exactOptionalPropertyTypes` の下では
 * `title: undefined` を渡せない）。未指定なら**鍵ごと省く**。
 */
function toShowHtmlArgs(
  args: Extract<WireRequest, { tool: "show_html" }>["args"],
): Parameters<typeof handleShowHtml>[0] {
  // transform（`showHtmlArgsSchema`）が既に `kind` 付きで、未指定の title を省いた形にしている。
  return args;
}

/**
 * 統合テスト専用コマンドの `{ slot }` 引数を読む（省略は 1）。**線上と同じ `panelSlotSchema`**
 * を当てる ―― ここで `Number(...)` のように別の読み方をすると、枠の形を決める場所が2つになる。
 * 上限（`showme.html.maxPanels`）はここでは見ない（判定は `handleShowHtml` の1箇所。D80）。
 */
function testSlotOf(args: unknown): PanelSlot {
  const slot = (args as { slot?: unknown } | undefined)?.slot;
  return slot === undefined ? 1 : panelSlotSchema.parse(slot);
}

function toShowNoteArgs(
  args: Extract<WireRequest, { tool: "show_note" }>["args"],
): Parameters<typeof handleShowNote>[0] {
  return args.language === undefined
    ? { text: args.text }
    : { text: args.text, language: args.language };
}

/**
 * activate が確保したもの。deactivate はここからだけ辿る。
 *
 * `server` は「起動に失敗したときは undefined」。失敗したまま握っておくと、
 * deactivate が存在しないソケットを片付けたつもりになる。
 */
interface ActiveState {
  readonly server: ShowMeSocketServer | undefined;
  readonly highlights: Highlights;
  readonly annotations: Annotations;
  readonly opened: OpenedByAgent;
  readonly envCollection: vscode.EnvironmentVariableCollection;
  readonly disposables: readonly vscode.Disposable[];
}

let active: ActiveState | undefined;

/** シャットダウン経路では報告先が無い。1つの失敗で残りの片付けを止めない。 */
function tolerate(fn: () => void): void {
  try {
    fn();
  } catch {
    // 片付けの途中では、失敗を伝える手段（チャネル・通知）自体が既に無いことがある
  }
}

/**
 * 文書を untitled で開いて見せる（D62）。**ディスクに書かない。**
 *
 * `openTextDocument({ content })` は untitled バッファを作るだけで、人間が保存
 * しない限りどこにも残らない（不変条件11 / 13）。`preview: false` は、次に人間が
 * 別のファイルを開いたときにこの文書が置き換えられて消えないため。
 */
async function showUntitledMarkdown(content: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({ language: "markdown", content });
  await vscode.window.showTextDocument(doc, { preview: false });
}

function disposeAll(disposables: readonly vscode.Disposable[]): void {
  // 確保と逆順に返す。
  for (const disposable of [...disposables].reverse()) tolerate(() => disposable.dispose());
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const envCollection = context.environmentVariableCollection;
  const disposables: vscode.Disposable[] = [];
  let started: ShowMeSocketServer | undefined;

  try {
    // 端末への注入は、何を入れるか決める前に必ず初期化する。
    // persistent の既定は true で、ワークスペースストレージに保存され、拡張が
    // アクティブになる前（ウィンドウ再読込直後）の端末にも適用される。ソケット名は
    // セッションごとに変わるので、既定のままだと死んだパスを注入する（設計書 Y1）。
    envCollection.persistent = false;
    // 以前のセッションが（あるいは persistent を明示していなかった版が）保存した
    // 内容が復元されていることがある。設定で注入を切っている場合も含め、まず空にする。
    envCollection.clear();
    envCollection.description = t("ShowMe: the socket path the agent connects to");

    const channel = vscode.window.createOutputChannel("ShowMe");
    disposables.push(channel);
    const log = new ShowMeLog(channel);

    // この窓の役割。**既定は idle（預けていない）**（設計書 §2A.1）。
    // 設定を経由しないので、ワークスペースからは触れない（不変条件9）。
    const roleState = new WindowRoleState();
    disposables.push(roleState);

    const statusBar = new ShowMeStatusBar(readConfig().enabled, roleState.current());
    disposables.push(statusBar);
    const highlights = new Highlights();
    disposables.push(highlights);
    // 注釈は自分の塗りを持つ（増分6 D65）。画家は上の `highlights` 1つ（§C2）。
    const annotations = new Annotations(highlights);
    disposables.push(annotations);
    // 自分が `show_code` で開いた文書の記録（D53）。**インスタンスは1つ。**
    // `Stage`（記録する）・`get_editor_state` の面（`own` を返す）・
    // `arrange_editors` の面（`close-own` の候補）が同じ実体を見る。
    // 2つ作ると、片方が own と言うものをもう片方が閉じない（不変条件14）。
    const opened = new OpenedByAgent();
    // **タブが閉じたら忘れる**（D53）。忘れないと、エージェントが開いた → 人間が
    // 閉じた → 人間が同じファイルを自分で開いた、が own のままになる。
    // 忘れる場所はここ1つ。誰が閉じたか（人間か `close-own` か）は問わない。
    disposables.push(
      vscode.window.tabGroups.onDidChangeTabs((event) => {
        for (const tab of event.closed) {
          if (tab.input instanceof vscode.TabInputText) opened.closed(tab.input.uri.toString());
        }
      }),
    );
    const stage = new Stage(() => readConfig().editorGroup, opened);

    // 図とメモ（2C）。**パネルの上限は人間の設定 `showme.html.maxPanels`**（不変条件10。既定 2。
    // 増分6.2 D80）。枠ごとに `ShowMePanel` を1つ持ち、**要るときに作る**（枚数は設定次第で、
    // 起動時には決められない）。作る場所はここ1つ、捨てる場所も `disposables` 1つ ――
    // 作ったらその場で `disposables` に積むので、作る場所と捨てる場所は2つにならない。
    // **上限の判定はここに無い**: `handleShowHtml` が `panelSlotAllowed` で断ってから
    // `panelFor` を呼ぶ（断った枠の実体は生まれない）。`move-panel` と統合テスト用の命令は
    // 出ていない枠を引きうるが、webview の無い `ShowMePanel` は何も動かさない（`moveTo` は false）。
    const panels = new Map<PanelSlot, ShowMePanel>();
    const panelFor = (slot: PanelSlot): ShowMePanel => {
      let panel = panels.get(slot);
      if (panel === undefined) {
        panel = new ShowMePanel(context.extensionUri, stage, slot);
        panels.set(slot, panel);
        disposables.push(panel);
      }
      return panel;
    };
    const notes = createNoteSurface(stage);
    // 直前にメモを書いたときの版。**呼び出しをまたいで持つのはここだけ**で、
    // 「人間が触ったか」の判断そのものは `note-target.ts` の純関数が持つ（不変条件14）。
    let lastNoteWrite: LastWrite | undefined;

    const panelDeps = (tool: "show_html"): ShowPanelDeps => ({
      panels: panelFor,
      // 上限は**毎回**読む（人間が途中で変えたら次の呼び出しから効く）。`readConfig()` は
      // `trusted()` 経由なのでワークスペース値は来ない（不変条件9）。
      maxPanels: () => readConfig().html.maxPanels,
      // **関門は `readWorkspaceFile`**（`acceptWorkspacePath` を通る形）。
      // ルートと設定は毎回読み直す（showCodeDeps と同じ理由）。ルートが無ければ読めない。
      readFile: (rel) => {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (root === undefined) return undefined;
        return readWorkspaceFile(root, rel, readConfig().redactedPathPatterns);
      },
      allowCall: () => panelCallLimiter.allow(tool),
      log,
    });

    const findDeps = (): FindLocationsDeps => ({
      // ルートは毎回読み直す（showCodeDeps と同じ理由）。
      language: createLanguageSurface(
        vscode.workspace.workspaceFolders?.[0]?.uri,
        () => readConfig().redactedPathPatterns,
      ),
      extraRedactedPatterns: () => readConfig().redactedPathPatterns,
      // **鍵はツール名そのもの。** 別名を使うと `maxKeys` の導出（TOOL_NAMES の数）
      // と食い違う。2つのツールで budget を分ける必要も無いので、まとめて1つ。
      allowCall: () => panelCallLimiter.allow("find_definition"),
      log,
    });

    const viewDeps = (): ShowViewDeps => ({
      // ルートは毎回読み直す（showCodeDeps と同じ理由）。
      view: createViewSurface(
        vscode.workspace.workspaceFolders?.[0]?.uri,
        () => readConfig().redactedPathPatterns,
      ),
      allowCall: () => panelCallLimiter.allow("show_view"),
      log,
    });

    // 面は毎回作り直す。**札とタブの対応を呼び出しをまたいで持たない**
    // ためである（`vscode.Tab` に安定した id は無い。設計書 Y7）。
    const arrangeDeps = (): ArrangeEditorsDeps => ({
      // ルートは毎回読み直す（showCodeDeps と同じ理由）。
      surface: createArrangeSurface(vscode.workspace.workspaceFolders?.[0]?.uri, opened, panelFor),
      config: readConfig,
      // `move-tab` の `path` と `close-tabs` の `paths`の関門。**`acceptWorkspacePath` そのもの**（書き直さない）。
      acceptPath: (raw) =>
        acceptWorkspacePath(
          vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
          raw,
          readConfig().redactedPathPatterns,
        ),
      // `close-own` が片づいたら `show_code` の指差しも消える（増分6 D67）。画家は1つ。
      clearSpotlight: () => highlights.clearSpotlight(),
      log,
    });

    const noteDeps = (): ShowNoteDeps => ({
      notes,
      lastWrite: () => lastNoteWrite,
      rememberWrite: (write) => {
        lastNoteWrite = write;
      },
      allowCall: () => panelCallLimiter.allow("show_note"),
      log,
    });

    // ソケットが立ってから決まる。立つまで（あるいは起動に失敗したら）注入しない。
    let socketPath: string | undefined;

    /**
     * 設定の現在値を画面と端末に反映する。
     *
     * 設定は呼び出しのたびに読み直すので、拒否そのものは追随している
     * （checkToolGate を毎回当てる）。ここが要るのは、設定を変えた瞬間に
     * 「見えているもの」を合わせるため。可視性がこの道具の防御なので、
     * 停止中と表示しながら描いたものが残る状態を作らない。
     */
    const applyConfig = (): void => {
      const config = readConfig();
      statusBar.setEnabled(config.enabled);
      if (!config.enabled) {
        highlights.clearSpotlight();
        // 描いたものは装飾だけではない。停止中と表示しながらエージェントの
        // 説明が行の下に残るのは、装飾が残るのと同じ嘘である。
        // **注釈の層を空にできるのは注釈ストアだけ。** 注釈の塗りは注釈と一緒に
        // ここで消える（D66）。画家に注釈の全消しを頼まない ―― 頼めば「画家の全消し ＋
        // ストアの全消し」を各所に並べることになり、片方を落とした時点で吹き出しだけが
        // 残る（不変条件14）。`applyRole` と `deactivate` も同じ2行である。
        annotations.clearAll();
      }
      if (socketPath !== undefined && config.injectTerminalEnv) {
        envCollection.replace(SOCKET_ENV_VAR, socketPath);
      } else {
        // 注入を切ったら消す。既に開いている端末には残るので、runbook では
        // 「端末を開き直してください」と案内すること（設計書 §6.2）。
        envCollection.delete(SOCKET_ENV_VAR);
      }
    };

    /**
     * 吹き出しの ‹ › （増分6.1 D79 / D77）。起点は**押した吹き出し**で、隣を決めるのは
     * ストア（`neighbor`）の1箇所。端では `contextValue` でボタンが消えているが、
     * `executeCommand` は誰でも任意の値で呼べるので、形（`isCommentThreadLike`）→
     * 自分のもの（同一性）→ 隣が有る、のどれかが崩れれば黙って何もしない。
     *
     * **開くのは人間の規則**（`revealForHuman`）であって `show_code` の `Stage.open` ではない。
     * 舞台の規則（列選択・own）はエージェントのため; 人間の命令は人間の列で、フォーカスも移す。
     * 開いたタブは人間のもの（own に記録しない）。`selection` には触らない（不変条件3）。
     *
     * **`stage.enabled` は見ない**（§C5 / D77）。設定が縛るのはエージェントであって
     * 人間ではない ―― `showme.enabled` にも窓の役割にも縛られない（Clear と同じ）。
     */
    const stepAnnotation = async (thread: unknown, direction: 1 | -1): Promise<void> => {
      if (!isCommentThreadLike(thread)) return;
      const target = annotations.neighbor(thread, direction);
      if (target === undefined) return;
      // URI はストアが持っている（相対パスへ往復しない）。ファイルが消えていれば
      // `showTextDocument` が投げて VS Code のエラー通知に出る。
      await revealForHuman(target.uri, target.line);
      // 人間が畳んでいても、案内した吹き出しは開いておく。
      annotations.expand(target.id);
    };

    /**
     * ワークスペースルートは毎回読み直す。
     *
     * activate 時の値を握ると、多ルートでフォルダの並びが変わったときに
     * list_workspaces（毎回読み直している）と show_code の見ているルートが
     * 食い違う。TabGroup と同じ理由で、位置で決まるものは再導出する。
     */
    const showCodeDeps = (): ShowCodeDeps => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
      return {
        config: readConfig,
        // vscode に触る部分は薄い層に押し出してある（editor-surface.ts）。
        // ハンドラ自体が vscode を値 import していると、vitest から読み込めず
        // 単体テストが1件も書けない ―― 実際にそうなっていて、可視化と
        // レート制限を壊しても緑のままだった。
        editor: createEditorSurface(root, stage, highlights),
        symbols: createSymbolSurface(root),
        log,
        statusBar,
        workspaceRoot: root?.fsPath,
      };
    };

    const annotateDeps = (): AnnotateDeps => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
      return {
        config: readConfig,
        annotations: createAnnotationSurface(root, annotations),
        symbols: createSymbolSurface(root),
        log,
        statusBar,
        workspaceRoot: root?.fsPath,
      };
    };

    const handle = async (req: WireRequest): Promise<Record<string, unknown>> => {
      const config = readConfig();
      // 役割は毎回いまの値を読む。握ると、預けるのをやめても既に立っている
      // ソケットが受け付け続ける。
      const gate = checkToolGate(config, req.tool, roleState.current());
      // 停止スイッチと個別無効化は「内部エラー」ではない。errorCodeSchema の
      // disabled をそのまま線に載せる（設計書 §6.1 の4段階のオフ）。
      if (!gate.allowed) throw new ToolError("disabled", gate.message);

      switch (req.tool) {
        case "list_workspaces":
          return handleListWorkspaces(config);
        case "show_code":
          return handleShowCode(toShowCodeArgs(req.args), showCodeDeps());
        case "annotate":
          return handleAnnotate(toAnnotateArgs(req.args), annotateDeps());
        case "get_editor_state":
          return handleGetEditorState({
            config: readConfig,
            // ルートは毎回読み直す（showCodeDeps と同じ理由）。
            surface: createEditorStateSurface(
              vscode.workspace.workspaceFolders?.[0]?.uri,
              opened,
              annotations,
            ),
            statusBar,
          });
        case "show_html":
          return handleShowHtml(toShowHtmlArgs(req.args), panelDeps("show_html"));
        case "show_note":
          return handleShowNote(toShowNoteArgs(req.args), noteDeps());
        case "show_view":
          return handleShowView(
            req.args.path === undefined
              ? { action: req.args.action }
              : { action: req.args.action, path: req.args.path },
            viewDeps(),
          );
        case "arrange_editors": {
          // `undefined` の鍵は渡さず省く（`show_view` の `path` と同じ形）。
          const args: ArrangeEditorsArgs = { action: req.args.action };
          if (req.args.path !== undefined) args.path = req.args.path;
          if (req.args.toColumn !== undefined) args.toColumn = req.args.toColumn;
          if (req.args.slot !== undefined) args.slot = req.args.slot;
          if (req.args.paths !== undefined) args.paths = req.args.paths;
          return { ...(await handleArrangeEditors(args, arrangeDeps())) };
        }
        case "find_definition":
          return { ...(await handleFindDefinition({ location: req.args.location }, findDeps())) };
        case "find_references":
          return {
            ...(await handleFindReferences(
              req.args.includeDeclaration === undefined
                ? { location: req.args.location }
                : {
                    location: req.args.location,
                    includeDeclaration: req.args.includeDeclaration,
                  },
              findDeps(),
            )),
          };
      }
    };

    const observer: ConnectionObserver = {
      onAccepted: (pid) => {
        // 同一ユーザのプロセスからの到達は原理的に防げない。だから「見えること」
        // そのものが要件になる（設計書 S11 / §3.5）。pid は取れないのが普通
        // なので、pid の有無で表示を分けない（server.ts の peerPid を参照）。
        log.info("agent connected", { pid: pid === undefined ? "unknown" : String(pid) });
        statusBar.setConnected(pid);
      },
      onRejected: (reason) => {
        log.info("connection rejected", { reason });
        // 2本目は人間に**通知する**（設計書 §3.5 / D21）。出力チャネルの1行は
        // 誰も見ていないので、可視化としては数えられない。理由は server.ts が
        // 定義した定数で判定する（綴りを2か所に持たない）。
        if (reason === SECOND_CONNECTION_REASON) statusBar.flashSecondConnection();
      },
      onDisconnected: (remaining) => {
        log.info("agent disconnected", { remaining: String(remaining) });
        // 残りが無くなったときだけ待機表示に戻す。2本目が生きているのに
        // 「接続なし」と描くと、可視化が実態より軽い側に嘘をつく。
        if (remaining === 0) statusBar.setDisconnected();
      },
    };

    // uid の導出は protocol に1つだけ置く。両端が同じ答えを出さないと、
    // 同じマシンにいても実行時ディレクトリ名がずれて互いを見つけられない。
    //
    // **書くのも両候補である**（設計書 §2A.6）。ブリッジは自分に
    // `$XDG_RUNTIME_DIR` が無ければ XDG 候補を構成できないので、読み取りだけを
    // 両候補にしても「拡張に XDG があり、ブリッジには無い」向きは塞がらない。
    // そしてその向きこそが現実的な構成である（デスクトップ／コンテナで起動した
    // VS Code には XDG があり、`docker exec` / `ssh` / `su` で入ったシェルには無い）。
    // ソケットは1本のまま。複製するのは登録ファイルだけである。
    //
    // ここで1回だけ決める。ソケットサーバも撤去手順の文書（`showme.teardown`）も
    // この値を受け取る ―― 文書側で計算し直すと、書いた場所と書いてある場所が
    // ずれうる（不変条件14）。
    const runtimeDirs = runtimeDirCandidates(process.env, os.tmpdir(), processUid(process));

    // 同梱したブリッジの実体（esbuild が `bridge/index.js` に束ねる。不変条件12）。
    // **1回だけ決めて**、エージェント設定の文書と MCP 提供者の両方に渡す。
    // 2箇所で `joinPath` を書くと、片方だけ直したときに文書と提供者が別の
    // ファイルを指す（不変条件14）。
    const bridgePath = vscode.Uri.joinPath(context.extensionUri, "bridge", "index.js").fsPath;

    /**
     * VS Code 内蔵のエージェント向けの MCP 提供者（設計書 §7.2 / Y12）。
     *
     * **宣言だけで実装が無かった**（package.json の `contributes.mcpServerDefinitionProviders`
     * に "showme" があるのに、`registerMcpServerDefinitionProvider` を呼んでいなかった）。
     * VS Code には「提供者がいる」と見えていて、何も提供していなかった。
     *
     * オブジェクトを1つ作って、登録と統合テストの観測（`showme.test.mcpDefinitions`）の
     * 両方に同じものを使う。
     */
    const mcpProvider: vscode.McpServerDefinitionProvider<vscode.McpStdioServerDefinition> = {
      provideMcpServerDefinitions: () => [
        new vscode.McpStdioServerDefinition("ShowMe", "node", [bridgePath]),
      ],
    };

    disposables.push(
      // ステータスバーのクリックはこれ。**切り替えるのは窓の役割**であって、
      // 拡張全体の停止スイッチではない（設計書 §2A.2 の二段構え）。
      // 役割は窓ごとのメモリにあるので、設定の書き込みは起きず失敗もしない。
      vscode.commands.registerCommand("showme.toggle", () => {
        roleState.toggle();
      }),
      // 拡張全体の停止はコマンドパレットへ移した（設計書 §2A.3）。
      // 停止したまま戻れなくなるとステータスバーからは復帰できない（クリックは
      // 役割のトグルになった）ので、同じコマンドで再開もできるようにする。
      vscode.commands.registerCommand("showme.disableExtension", async () => {
        const next = !readConfig().enabled;
        try {
          // Global に書く。ワークスペースに書くと次にこのリポジトリを開いた人の
          // 設定を汚すうえ、readConfig() はワークスペース値を読まない（config.ts /
          // 設計書 D11'）ので、書いても効かない。
          await vscode.workspace
            .getConfiguration()
            .update("showme.enabled", next, vscode.ConfigurationTarget.Global);
        } catch (e) {
          void vscode.window.showErrorMessage(
            t("ShowMe: could not write the setting: {0}", String(e)),
          );
          return;
        }
        log.info(next ? "resumed by human" : "stopped by human");
        // 設定変更の購読からも呼ばれるが、冪等なので二重に当たって困らない。
        // ここで直接呼ぶのは、イベントを待たずに画面を合わせるため。
        applyConfig();
      }),
      vscode.commands.registerCommand("showme.showLog", () => log.show()),
      // どちらも **untitled 文書を開いて見せるだけ**（D62 / 不変条件11）。他ツールの
      // 設定ファイルにもワークスペースにもホームにも書かない。人間が写す。
      // 中身は vscode に依存しない純関数が組む（単体で検査するため）。文書全体が
      // 人間向けなので、言語は `uiLanguage()`（`vscode.env.language`）で選ぶ（D58）。
      vscode.commands.registerCommand("showme.showAgentConfig", async () => {
        await showUntitledMarkdown(buildAgentConfigDocument(bridgePath, uiLanguage()));
      }),
      vscode.commands.registerCommand("showme.teardown", async () => {
        await showUntitledMarkdown(
          buildTeardownDocument({ runtimeDirs, extensionId: context.extension.id }, uiLanguage()),
        );
      }),
      // 人間向けの消す命令（増分6 D68）。**人間の操作であって、エージェントへの
      // 入力路ではない**（§C5: 設定が縛るのはエージェントであって人間ではない）ので、
      // 窓の役割でも `showme.enabled` でも縛らない ―― 消すだけで、何も開かない。
      // エージェントは `get_editor_state` の注釈が空になったことで知る（その観測面が
      // 付いた）。ハイライトは戻れないものなので知らせない。
      vscode.commands.registerCommand("showme.clearHighlights", () => {
        highlights.clearSpotlight();
      }),
      vscode.commands.registerCommand("showme.clearAnnotations", () => {
        // 注釈の層を空にできるのは注釈ストアだけ（`applyConfig` と同じ1行。
        // 吹き出しと塗りは一緒に消える。D66）。画家に全消しを頼まない。
        annotations.clearAll();
      }),
      // 吹き出しの Resolve / Unresolve（増分6 D70）。`comments/commentThread/title` の
      // ボタンがスレッドを引数に渡す。人間の読了は**1ビット**で、これが人間→エージェント
      // に流れる唯一のもの（§C3）。役割にも `showme.enabled` にも縛られない（§C5）。
      // 引数は形だけ見て（`isCommentThreadLike`）、**自分のものか**はストアが同一性で
      // 決める ―― `when` 句は他拡張のスレッドを隠すが、`when` は作法であって構造ではない。
      // 自分のものでなければ黙って何もしない（投げない: ボタン経由では起きない事象で、
      // 起きたとしても人間に見せるものが無い）。
      vscode.commands.registerCommand("showme.annotation.resolve", (thread: unknown) => {
        if (!isCommentThreadLike(thread)) return;
        annotations.setResolved(thread, true);
      }),
      vscode.commands.registerCommand("showme.annotation.unresolve", (thread: unknown) => {
        if (!isCommentThreadLike(thread)) return;
        annotations.setResolved(thread, false);
      }),
      // 吹き出しの ‹ › （増分6.1 D79）。Resolve と同じ仕組みでスレッドが渡る。
      // パレットには無い（起点の無い案内は嘘になる）。
      vscode.commands.registerCommand("showme.annotation.next", (thread: unknown) =>
        stepAnnotation(thread, 1),
      ),
      vscode.commands.registerCommand("showme.annotation.previous", (thread: unknown) =>
        stepAnnotation(thread, -1),
      ),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration("showme")) return;
        applyConfig();
      }),
    );

    // `typeof` で守るのは、`engines.vscode` より古いホストで activate ごと落ちない
    // ため（API は 1.101 からある）。無ければ内蔵エージェントからは見えないだけで、
    // 外部クライアント（Claude Code / Codex / Copilot CLI）には影響しない。
    if (typeof vscode.lm?.registerMcpServerDefinitionProvider === "function") {
      disposables.push(vscode.lm.registerMcpServerDefinitionProvider("showme", mcpProvider));
    } else {
      log.info("mcp provider api unavailable on this host");
    }

    if (context.extensionMode === vscode.ExtensionMode.Test) {
      // 統合テスト専用。`contributes.commands` に載せないのでコマンドパレットには
      // 出ないが、`executeCommand` は同じ拡張ホストにいる誰でも呼べる = トークンを
      // 持たない相手に線上と同じ経路を開くことになる。
      //
      // **Test に限る。** `!== Production` にすると Development でも登録され、
      // それは runbook が主な開発手順として案内している F5（拡張開発ホスト）の
      // ウィンドウそのものである。そこで動いている任意の拡張がトークン無しで
      // このハンドラを叩けることになり、実際に人が使う場面でだけ穴が開く。
      // 統合テストは Test モードで走るので影響を受けない。
      disposables.push(
        vscode.commands.registerCommand("showme.test.showCode", async (args: unknown) => {
          const gate = checkToolGate(readConfig(), "show_code", roleState.current());
          if (!gate.allowed) throw new ToolError("disabled", gate.message);
          // 線上と同じ検証を通す。ソケット経由は requestSchema で検証されるので、
          // ここだけ素通りにすると2つの入口の振る舞いが食い違う。
          return handleShowCode(toShowCodeArgs(showCodeArgsSchema.parse(args)), showCodeDeps());
        }),
        vscode.commands.registerCommand("showme.test.annotate", async (args: unknown) => {
          const gate = checkToolGate(readConfig(), "annotate", roleState.current());
          if (!gate.allowed) throw new ToolError("disabled", gate.message);
          // 線上と同じ検証を通す（`showme.test.showCode` と同じ理由）。
          return handleAnnotate(toAnnotateArgs(annotateArgsSchema.parse(args)), annotateDeps());
        }),
        // 制限モードでの縮退（capabilities）を実機で確かめるための入口。
        // ハンドラを直に呼ばず handle に通すので、ゲートを含めて線上と同じ道を通る。
        vscode.commands.registerCommand("showme.test.listWorkspaces", async () =>
          handle({ id: "test", tool: "list_workspaces", args: {} }),
        ),
        // 人間の選択が読めることを実機で確かめる入口。ハンドラを直に呼ばず
        // handle に通すので、ゲートを含めて線上と同じ道を通る。
        vscode.commands.registerCommand("showme.test.getEditorState", async () =>
          handle({ id: "test", tool: "get_editor_state", args: {} }),
        ),
        // 図とメモ（2C）。**`handle` に通す** ―― ゲートも検証も線上と同じ道になる。
        vscode.commands.registerCommand("showme.test.showHtml", async (args: unknown) =>
          handle({ id: "test", tool: "show_html", args: showHtmlArgsSchema.parse(args) }),
        ),
        vscode.commands.registerCommand("showme.test.showNote", async (args: unknown) =>
          handle({ id: "test", tool: "show_note", args: showNoteArgsSchema.parse(args) }),
        ),
        // 表示フレームに**本当に届いたか**を観測する口（統合テスト専用）。
        // egress の検査は「フレームが立っていないから何も出なかった」でも緑になる。
        // 空振りの緑を見分けるために、届いたことを別に確かめられるようにしておく。
        // 枠は引数 `{ slot }`（省略は 1）。線上と同じ `panelSlotSchema` で読む（0 / 1000 は落ちる）。
        vscode.commands.registerCommand("showme.test.panelState", async (args?: unknown) =>
          panelFor(testSlotOf(args)).displayState(),
        ),
        // **いま表示フレームに入っている中身**を測る口（統合テスト専用）。
        // `showme.test.panelState` は「最後に投げたものが届いた」という出来事の
        // 記録なので、その後に webview が隠れて DOM ごと捨てられても残る。
        // 「隠して出し直したら中身が戻るか」は、その記録では判別できない。
        vscode.commands.registerCommand(
          "showme.test.measureDisplayedLength",
          async (args?: unknown) => ({
            length: await panelFor(testSlotOf(args)).measureDisplayedLength(),
          }),
        ),
        // 回数制限を空にする（統合テスト専用）。
        // 1プロセスで何十回も呼ぶ統合テストでは予算が尽き、**攻撃入力が
        // サニタイザに届く前に制限で弾かれる**。そのとき検査は「落ちた」と読むが、
        // 実際には食わせていない ―― 空振りの緑である。実測で egress の検査は
        // 41 件中 11 件が届いていなかった。
        vscode.commands.registerCommand("showme.test.showView", async (args: unknown) =>
          handle({ id: "test", tool: "show_view", args: showViewArgsSchema.parse(args) }),
        ),
        vscode.commands.registerCommand("showme.test.arrangeEditors", async (args: unknown) =>
          handle({
            id: "test",
            tool: "arrange_editors",
            args: arrangeEditorsArgsSchema.parse(args),
          }),
        ),
        /**
         * `arrange_editors` の**対応表の値**を観測する口（統合テスト専用）。
         * `showme.test.viewCommands` と同じ理由 ―― 表を写すと、実機に無い
         * コマンド名が残っていても検査は緑のまま通る（不変条件14）。
         */
        vscode.commands.registerCommand("showme.test.arrangeCommands", () => ({
          commands: ARRANGE_COMMANDS,
        })),
        vscode.commands.registerCommand("showme.test.findDefinition", async (args: unknown) =>
          handle({
            id: "test",
            tool: "find_definition",
            args: findDefinitionArgsSchema.parse(args),
          }),
        ),
        vscode.commands.registerCommand("showme.test.findReferences", async (args: unknown) =>
          handle({
            id: "test",
            tool: "find_references",
            args: findReferencesArgsSchema.parse(args),
          }),
        ),
        /**
         * `show_view` の**対応表の値**を観測する口（統合テスト専用）。
         *
         * 統合テストは `src/` を import できない（`test/integration` の `rootDir` の
         * 外になる）。写して並べ直すと「同じ量を2箇所で決める」（不変条件14）に
         * なり、実機に無いコマンド名が表に残っていても検査は緑のまま通る。
         * **表そのものを返す。**
         *
         * 秘密は含まない ―― VS Code の組み込みコマンド名だけである。
         */
        vscode.commands.registerCommand("showme.test.viewCommands", () => ({
          commands: VIEW_COMMANDS,
        })),
        vscode.commands.registerCommand("showme.test.resetRateLimits", async () => {
          // **器は3つある。全部戻す。** 片方だけ戻すのは戻していないのと同じである。
          //
          // 器ごとに**溢れたときの形が違う**ので、漏らしたときの害も違う:
          //
          // - `sharedEditorStateLimiter`（`get_editor_state`）は `ToolError` を
          //   投げるので、漏らすと検査は**うるさく赤くなる**（実測で確認済み。
          //   ここを戻さなくても既存の検査は1件も落ちない）
          // - `sharedFileLimiter`（`show_code` / `annotate`）は投げずに
          //   `{ reason: "rate-limited" }` を**返す**。こちらを漏らすと、
          //   検査が理由の選言で受けている限り**黙って緑になる** ―― 沈黙の緑の形は
          //   こちらである
          //
          // だから「どれが危ないか」ではなく、**全部戻す**を形にしておく。
          panelCallLimiter.clear();
          sharedEditorStateLimiter.clear();
          sharedFileLimiter.clear();
          return { cleared: true };
        }),
        /**
         * 可視化を**観測する口**（統合テスト専用）。
         *
         * 統合テストが見られるのは可視エディタと登録ファイルだけだったので、
         * 「役割を外したら装飾を剥がす」（`highlights.clearSpotlight()`）と
         * 「画面が役割を映す」（`statusBar.setRole()`）は、**消しても全部緑**
         * のままだった（実測）。どちらもこの道具が防御として数えている性質で
         * ある（設計書 §5.4）。VS Code には貼った装飾を読み出す API が無く、
         * `StatusBarItem` の文字列も外からは読めないので、拡張の側に口を開ける
         * 以外に観測する手段が無い。
         *
         * **秘密は返さない。** 認証トークンもソケットのパスも含めない。
         * ここが返すのは、既に人間の画面に出ているものだけである。
         */
        vscode.commands.registerCommand("showme.test.inspectVisuals", () => ({
          highlightedUris: highlights.highlightedUris(),
          // **列の指定が効いているかは、範囲そのものを見ないと言えない。**
          // uri の一覧だけでは「貼った」しか分からない（設計 D34）。
          highlightRanges: highlights.highlightRanges(),
          // 吹き出しが出ているかも API からは読めない。件数まで見えるように
          // 重複を潰さずに返す（`mode: "replace"` が冪等かを外から判別するため）。
          annotatedUris: annotations.annotatedUris(),
          // 本文と、その本文が VS Code に渡った型。型が `string` でなくなれば
          // markdown のレンダラに載る（＝リンクと画像が戻る。設計書 §3.2.1）。
          // アイコンは `author` 側の欄なので、色を付けても `kind` は `string` の
          // ままである ―― それを実機で確かめられるように同じ観測点から返す。
          annotatedBodies: annotations.annotatedBodies(),
          // 吹き出しに**無い UI**（D70: 返信・範囲プロバイダ・リアクション）。
          // 「設定していない」はコードを読めば分かるが、実機で無いことは
          // ここでしか言えない。
          annotationUi: annotationUiSurface(annotations.observeUi()),
          statusBar: statusBar.currentView(),
        })),
        /**
         * `id` の吹き出しのスレッドそのもの（統合テスト専用）。
         *
         * `comments/commentThread/title` のボタンが渡す引数を、テストが
         * `executeCommand("showme.annotation.resolve", thread)` に渡すため。
         * VS Code にはスレッドを列挙する API が無い。返すのはスレッドで、本文は
         * 既に人間の画面に出ているもの（秘密は無い）。
         */
        vscode.commands.registerCommand("showme.test.annotationThread", (args: unknown) => {
          const id = (args as { id?: unknown } | undefined)?.id;
          if (typeof id !== "number") throw new Error("annotationThread: id must be a number");
          return annotations.threadById(id);
        }),
        /**
         * MCP 提供者が返す定義。`vscode.lm` には登録済みの提供者を列挙する口が
         * 無いので、登録したのと**同じオブジェクト**を呼ぶ。返すのはブリッジの
         * パスだけ（トークンもソケットのパスも含まない）。
         */
        vscode.commands.registerCommand("showme.test.mcpDefinitions", () => {
          const defs = mcpProvider.provideMcpServerDefinitions(
            new vscode.CancellationTokenSource().token,
          );
          return (Array.isArray(defs) ? defs : []).map((d) => ({
            command: d.command,
            args: [...d.args],
          }));
        }),
      );
      log.info("test-only commands registered", {
        commands:
          "showme.test.showCode, showme.test.annotate, showme.test.listWorkspaces, showme.test.getEditorState, showme.test.inspectVisuals",
      });
    }

    const server = new ShowMeSocketServer(
      runtimeDirs,
      handle,
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "",
      observer,
      // 役割は**関数で**渡す。値で渡すと、預けた瞬間に握った古い値を書き続ける。
      { windowId: roleState.windowId, role: () => roleState.current() },
    );

    /**
     * 役割が変わったときに、画面と外に出ているものを合わせる。
     *
     * 役割そのものは `WindowRoleState` が持ち、拒否は毎回 `checkToolGate` が
     * 現在値に対して行うので、ここが要るのは「変わった瞬間に見えているものを
     * 合わせる」ため。預けるのをやめたのにエージェントが描いた装飾が残ると、
     * 停止中と表示しながら描いたものが残るのと同じ嘘になる。
     *
     * **登録ファイルの書き直しが要る。** ブリッジは登録ファイルしか見ないので、
     * メモリの役割だけを変えると、人間が預けた窓は永久に見つからない。書けな
     * かったことも黙って飲み込まない ―― 人間には預けたように見えて、エージェント
     * からは見えない窓ができるのが、この失敗のいちばん高い形である。
     */
    const applyRole = (role: WindowRole): void => {
      statusBar.setRole(role);
      if (role !== "stage") {
        // スポットライトは画家、注釈の塗りは注釈ストア（`applyConfig` の理由）。
        highlights.clearSpotlight();
        annotations.clearAll();
      }
      log.info("window role changed", { role });
      try {
        server.refreshRegistration();
      } catch (e) {
        log.info("failed to refresh registration", { error: String(e) });
        void vscode.window.showErrorMessage(
          t(
            "ShowMe: could not write the role to the registration file. To the agent, this window's role looks unchanged: {0}",
            String(e),
          ),
        );
      }
    };
    // 購読はサーバを作ってから繋ぐ（書き直す先が無いうちに繋いでも意味が無い）。
    // start() は書くときに現在の役割を読むので、この間の変更も取りこぼさない。
    disposables.push(roleState.onChange(applyRole));

    try {
      const info = await server.start();
      started = server;
      socketPath = info.socketPath;
      // トークンは登録ファイルの中だけに置く。ログにもステータスバーにも出さない。
      log.info("listening", {
        socket: info.socketPath,
        registry: info.registryPaths.join(", "),
      });
      applyConfig();
    } catch (e) {
      // 止まって知らせる。特に実行時ディレクトリの検証に落ちたときは
      // prepareRuntimeDir の理由をそのまま見せる — 先回りされたディレクトリを
      // 黙って迂回しない設計なので、迂回しなかったことが人間に伝わる必要がある
      // （設計書 S7 / D22）。
      log.info("failed to start", { error: String(e) });
      void vscode.window.showErrorMessage(t("ShowMe could not start: {0}", String(e)));
      // 通知は流れて消える。設定が有効なままだとステータスバーは
      // 「受け付けています」と描き続けるので、そこにも失敗を残す。理由は
      // ShowMeStatusBar 側で必ず forDisplay を通る（prepareRuntimeDir の理由には
      // パスが入り、そのパスは攻撃者が置いたディレクトリの名前でありうる）。
      statusBar.setFailed(e instanceof Error ? e.message : String(e));
      log.show();
      // 部分的に開いた資源を残さない（stop() は start() が何も残さなかった場合の
      // 呼び出しも許す）。await して待つ — 投げっぱなしにすると、失敗したときに
      // unhandled rejection になって、起動できなかったという主たる報告を汚す。
      // 拡張自体は有効なままにする — ログとコマンドが使えないと人間が理由に
      // 辿り着けない。
      try {
        await server.stop();
      } catch {
        // 片付けの失敗で、起動できなかったという報告を上書きしない
      }
    }

    // context.subscriptions と deactivate の両方から解放される。vscode の
    // Disposable は二重 dispose に耐えるので、どちらが先でも構わない。
    for (const disposable of disposables) context.subscriptions.push(disposable);
    active = { server: started, highlights, annotations, opened, envCollection, disposables };
  } catch (e) {
    // 途中で落ちたら half-initialized な状態を残さない。ここまでに確保した
    // ものを全部返してから、VS Code に失敗として伝える。
    if (started !== undefined) {
      try {
        await started.stop();
      } catch {
        // 片付けの失敗で元の例外を隠さない
      }
    }
    tolerate(() => envCollection.clear());
    disposeAll(disposables);
    active = undefined;
    throw e;
  }
}

export async function deactivate(): Promise<void> {
  // ここでモーダル確認は出せない（設計書 A5 / D24）。黙って片付けるだけ。
  const state = active;
  active = undefined;
  if (state === undefined) return;

  // 外に残る作りもの（ソケット・登録ファイル）から先に片付ける。画面の後始末で
  // 失敗しても、ファイルシステム上の痕跡だけは必ず消えるようにする。
  if (state.server !== undefined) {
    try {
      await state.server.stop();
    } catch {
      // 消せなくても続ける。片付けを止めるよりは、残りを解放するほうがましである。
      // 残った登録ファイルは、次にこの拡張が起動したときに掃除される
      // （server.ts の cleanStaleRegistrations を start() が呼ぶ。設計書 §6.2）。
    }
  }
  // persistent = false なので保存はされていないが、このセッションで後から
  // 開かれる端末に死んだパスが渡らないよう明示的に消す。
  tolerate(() => state.envCollection.clear());
  tolerate(() => state.highlights.clearSpotlight());
  tolerate(() => state.annotations.clearAll());
  // 所有の記録はメモリだけなので消えるが、明示的に空にする（不変条件13）。
  tolerate(() => state.opened.clear());
  // ステータスバーのタイマー、装飾、エディタ購読、登録したコマンド、出力チャネル。
  disposeAll(state.disposables);
}
