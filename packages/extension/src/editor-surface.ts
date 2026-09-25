import type { AnnotationColor, PanelSlot } from "@zvx/vscode-showme-protocol";
import * as vscode from "vscode";
import type { Annotations } from "./annotations.js";
import type { HighlightRange, Highlights } from "./decorations.js";
import {
  type ObservedGroup,
  type ObservedTab,
  type TabKind,
  type VisibleLineRange,
  capSelectionRange,
  coversWholeDocument,
  observedViewColumn,
  relativizeToRoot,
  visibleLineRange,
} from "./editor-observation.js";
import type { AnnotationSurface } from "./handlers/annotate.js";
import type {
  ActiveEditorObservation,
  EditorStateSurface,
  ObservedAnnotation,
} from "./handlers/get-editor-state.js";
import type { EditorSurface, LineRange, StagePlacement } from "./handlers/show-code.js";
import type { SymbolLookup, SymbolSurface } from "./handlers/symbol-prefetch.js";
import { toHighlightRange, toRange } from "./line-range-vscode.js";
import type { OpenedByAgent } from "./opened-by-agent.js";
import { slotOfViewType } from "./own-view-type.js";
import { isAgentStageUri, relOfStageUri, stageUriFor } from "./stage-uri-vscode.js";
import { type StageOpenTarget, type StageScheme, isStageScheme } from "./stage-uri.js";
import type { Stage, StageColumnSettings } from "./stage.js";
import {
  collectSymbolRanges,
  probeDocumentSymbols,
  symbolUnavailableReason,
} from "./symbol-lookup.js";
import { canonicalWorkspaceName } from "./workspace-path-gate.js";

/**
 * `handleShowCode` に渡す、vscode に触る薄い層。
 *
 * **このファイルだけが `vscode` を値として読む。** ハンドラ側に置くと、
 * ハンドラを読み込むだけで vitest が「Failed to load url vscode」で落ち、
 * 判断ロジック（可視化を出すか・制限に当てるか）を単体で確かめられなくなる。
 *
 * ルートは呼び出しのたびに渡し直す。多ルートで並びが変わったときに、
 * `handleShowCode` が見ているルートとここが開くルートが食い違わないように
 * するため（`extension.ts` の showCodeDeps と同じ瞬間の値を使う）。
 */
/**
 * 観測したエディタのパスを、**実体まで辿った正準名**にする。
 *
 * ## なぜ要るか（4回目のレビューで見つかった）
 *
 * `relativizeToRoot` は綴りしか見ない（`path.relative` ＋ 正規化）。VS Code は
 * ドキュメントの URI にシンボリックリンクを**解決しないまま**入れるので、
 * ワークスペースの中に `notes.md -> ~/.ssh/id_rsa` があると:
 *
 * - 綴りは `notes.md` なので「ワークスペースの外」に落ちない
 * - 除外判定も `notes.md` に当たるので `.env` 等として弾かれない
 * - 結果、`cursor` / `selection` / `visibleLines` が無条件に返り、
 *   人間がそこで選択すれば **`selectedText` に実体の中身が載る**
 *
 * 増分3の修正は「**エージェントが送るパス**」だけを見ていて、
 * **VS Code 自身が持つパス**を見ていなかった。同じ境界の5箇所目である。
 *
 * ここで正準名に直せば、下流の除外判定（`get-editor-state.ts`）は
 * そのまま正しくなる ―― **新しい判断点を作らない**（不変条件14）。
 * 正準化できない（存在しない・外に出る）ものは `undefined` に倒す
 * ＝「ワークスペースの外」として扱う。fail-closed である。
 *
 * **export しているのは `arrange-surface.ts` が同じ関数でタブの `path` を作るためである**
 * （`move-tab`）。`get_editor_state` が返す `path` と `move-tab` が突き合わせる `path` が
 * 別の関数から出ると、エージェントが読んだ名前で指せないタブができる（不変条件14）。
 */
export function observedRelPath(root: vscode.Uri | undefined, uri: vscode.Uri): string | undefined {
  // **綴りを読む枝は2つ、正準化する尾は1つ**（D83）。映し（`showme-ro:` / `showme-rw:`）は
  // `relOfStageUri`（`stageUriFor` の映し側の唯一の逆。別綴りは拒む）で rel を取り、`file:` は
  // `relativizeToRoot` で取る。どちらも下の `canonicalWorkspaceName` を通す ―― 映しの rel を
  // そのまま返すと、映しの側だけシンボリックリンクが実体に直らず、同じ実体が `file:` と映しで
  // 別の名前になる（不変条件14: 観測した値も同じ関門の規則で正準化する）。
  //
  // **照合はこの関数の出力だけで行うこと。** 映しの URI の path から rel を剥がして直接
  // 比べると、綴り・大文字小文字・リンクの差で `get_editor_state` の `path` と食い違う。
  const spelled = isStageScheme(uri.scheme) ? relOfStageUri(uri) : relativizeToRoot(root, uri);
  if (spelled === undefined) return undefined;
  // **除外判定はここでしない。** 除外かどうかは下流が決める（そこには設定の
  // パターンがあり、`activePath` は除外でも返すという規則もある。設計書 §3.1）。
  // ここがするのは「実体の名前に直す」ことだけである。
  return canonicalWorkspaceName(root?.fsPath, spelled);
}

/**
 * `target` は `show_code` 1回の開き方（`stageOpenTarget` の結果: スキームと記録するか）。
 * **呼び出しのたびに `extension.ts` が1回だけ決めて渡す**（D84 / D87）。ここ（`reveal` /
 * `setSpotlight`）で設定や `realFile` を見直すと、呼び出しの途中で設定が変わったときに舞台は映し・
 * 塗りは `file:` と割れ、塗りが舞台に届かない（不変条件14: 同じ量を2箇所で決めない）。
 */
export function createEditorSurface(
  root: vscode.Uri | undefined,
  target: StageOpenTarget,
  stage: Stage,
  highlights: Highlights,
  columns: StageColumnSettings,
): EditorSurface {
  const { scheme, record } = target;
  const uriOf = (relPath: string): vscode.Uri => {
    // ハンドラは workspaceRoot が undefined なら先に返すので、通常ここには
    // 来ない。来たときに黙って別の場所を開かないよう、投げて止める。
    if (root === undefined) throw new Error("no workspace folder");
    // 舞台で開く URI・塗りの鍵は `stageUriFor` だけで組む（D84。不変条件14）。
    // 印だけ（舞台を切った窓）は scheme が "file" なので、実ファイルに付く（D85）。
    return stageUriFor(root, relPath, scheme);
  };

  return {
    async reveal(relPath: string, range: LineRange, placement: StagePlacement): Promise<void> {
      // 列の選び方の設定も `target` と同じ写し（`showCodeDeps` が1回だけ作る）。
      const shown = await stage.open(uriOf(relPath), placement, record, columns);
      // selection は絶対に触らない（設計書 D8' / S2）。
      // 触ると show_code -> get_editor_state の合成で任意ファイルの生テキストが
      // 取れてしまう。位置合わせは revealRange だけで行う。
      shown.revealRange(toRange(range), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    },
    setSpotlight(byPath: ReadonlyMap<string, readonly LineRange[]>): void {
      const byUri = new Map<string, HighlightRange[]>();
      for (const [relPath, ranges] of byPath) {
        byUri.set(uriOf(relPath).toString(), ranges.map(toHighlightRange));
      }
      highlights.setSpotlight(byUri);
    },
  };
}

/**
 * `prefetchSymbol` に渡す、vscode に触る薄い層（設計書 §3.4）。
 *
 * **文書は開くが、見せない。** `showTextDocument` を呼ぶと、解決に失敗しうる
 * 問い合わせが人間の画面を動かすことになる（そして `show_code` は解決できた
 * ものだけを見せる、という約束が崩れる）。`openTextDocument` は言語拡張の
 * `onLanguage` を発火させるので、これだけでプロバイダは起きる。
 *
 * **1回引いて諦めない**（`probeDocumentSymbols`）。理由はそちらに書いてある。
 *
 * 引けなかったときの理由もここで決める。材料（信頼の有無・言語 id）は vscode に
 * 触らないと分からないからである。判定そのものは純関数（`symbolUnavailableReason`）
 * で、制限モードでは TypeScript の拡張ごと無効になり `.ts` が `plaintext` として
 * 開かれうるため、言語 id **と**パスの綴りの両方を見る。
 */
export function createSymbolSurface(root: vscode.Uri | undefined): SymbolSurface {
  return {
    async lookup(relPath: string, name: string): Promise<SymbolLookup> {
      if (root === undefined) return { kind: "unavailable", reason: "no-provider" };
      const uri = vscode.Uri.joinPath(root, relPath);

      let languageId: string | undefined;
      try {
        languageId = (await vscode.workspace.openTextDocument(uri)).languageId;
      } catch {
        // 開けないファイル（バイナリ・消えた）。何が起きたかは外に出さない。
        return { kind: "unavailable", reason: "no-provider" };
      }

      const symbols = await probeDocumentSymbols<unknown>(
        async () => {
          try {
            const raw = await vscode.commands.executeCommand<unknown>(
              "vscode.executeDocumentSymbolProvider",
              uri,
            );
            return Array.isArray(raw) ? raw : undefined;
          } catch {
            // URI がテキストモデルに解決できないときは投げる（実測）。
            // 起動途中の一時的な失敗と区別できないので、引き直しに任せる。
            return undefined;
          }
        },
        (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      );

      if (symbols === undefined) {
        return {
          kind: "unavailable",
          reason: symbolUnavailableReason({
            relPath,
            languageId,
            // 信頼は毎回読み直す。人間はセッションの途中でワークスペースを
            // 信頼できる（そのとき言語プロバイダが起きる）ので、握ると古びる。
            isTrusted: vscode.workspace.isTrusted,
          }),
        };
      }
      return { kind: "resolved", ranges: collectSymbolRanges(symbols, name) };
    },
  };
}

/**
 * `handleAnnotate` に渡す、vscode に触る薄い層。
 *
 * ルートと舞台のスキームは `createEditorSurface` と同じ理由で呼び出しのたびに渡し直す。
 *
 * **本文には触らない。** 受け取った `string` をそのまま `Annotations` に渡す。
 * ここで整形（改行の畳み直し・記法の解釈）を足すと、それは無害化を通った後の
 * 文字列を作り変えることであり、2つ目のサニタイザになる（不変条件7）。
 */
export function createAnnotationSurface(
  root: vscode.Uri | undefined,
  scheme: "file" | StageScheme,
  annotations: Annotations,
): AnnotationSurface {
  return {
    clearAll(): void {
      annotations.clearAll();
    },
    add(relPath: string, range: LineRange, body: string, color?: AnnotationColor): { id: number } {
      if (root === undefined) throw new Error("no workspace folder");
      // 行範囲は**そのまま**渡す。吹き出しの位置と塗りの範囲を同じ1つの `LineRange` から
      // 作るのは注釈ストアの仕事で、ここで vscode の Range に直すと塗りの種類
      // （行全体か文字か）をもう一度決める場所ができる（不変条件14）。
      //
      // 吹き出しは舞台と**同じ URI**に付ける（D84）。`scheme` は `createEditorSurface` と
      // 同じく呼び出し側が1回だけ決めたもの。映しが開いていなくてもスレッドは作られ、
      // 開けばそこに出る。
      return annotations.add(stageUriFor(root, relPath, scheme), range, body, color);
    },
    indices(): ReadonlyMap<number, number> {
      // **`list()` 1回から作る**（`get_editor_state.annotations` と同じ観測。不変条件14）。
      return new Map(annotations.list().map(({ id, index }) => [id, index]));
    },
  };
}

/** タブの種類を `input` の**型**から決める。名前では決めない。 */
function tabKind(input: unknown): TabKind {
  if (input instanceof vscode.TabInputText) return "file";
  if (input instanceof vscode.TabInputTextDiff) return "diff";
  if (input instanceof vscode.TabInputCustom) return "file";
  if (input instanceof vscode.TabInputWebview) return "webview";
  if (input instanceof vscode.TabInputTerminal) return "terminal";
  if (input instanceof vscode.TabInputNotebook) return "notebook";
  if (input instanceof vscode.TabInputNotebookDiff) return "notebook-diff";
  return "other";
}

/**
 * そのタブが指しているファイルの URI。**差分は左側（元）を返さない**。
 *
 * 差分タブは2つの URI を持つ。`modified` のほうが人間が編集している実体である。
 *
 * **`TabInputWebview` は拾わない。** webview は URI を持たないので `relPath` は
 * 必ず `undefined` になり、他人の webview の題は `(other)` に落ちる（D37'）。
 * これは偶然ではなく、ここが拾わないことで**構造的に**そうなっている。
 */
function tabResourceUri(input: unknown): vscode.Uri | undefined {
  if (input instanceof vscode.TabInputText) return input.uri;
  if (input instanceof vscode.TabInputCustom) return input.uri;
  if (input instanceof vscode.TabInputTextDiff) return input.modified;
  if (input instanceof vscode.TabInputNotebook) return input.uri;
  if (input instanceof vscode.TabInputNotebookDiff) return input.modified;
  return undefined;
}

/**
 * 自分（ShowMe）が出した webview か、自分が `show_code` で開いたテキストタブか
 * （設計 D41 / 増分5 D53）。
 *
 * **`label` で判定しない。** ラベルはエージェントが `show_html` の `title` で
 * 決められるので、ラベル照合は「タイトルを `package.json` にすれば人間の
 * `package.json` を自分のものと名乗れる」経路になる。
 * **`viewType` はエージェントが送る文字列からは作れない。**
 *
 * VS Code は `viewType` に `mainThreadWebview-` の接頭辞を付ける（実測値は
 * `mainThreadWebview-showme.view`）ので、素の値の完全一致では**永久に当たらない**。
 * かといって `endsWith("showme.view")` は緩すぎる ―― 同居する別の拡張が
 * `evil.showme.view` を名乗れば、**そのパネルが「自分のもの」になる**。
 * 題が実名で返り（D37' 破り）、`arrange_editors` の「弱」でも閉じる対象になる。
 *
 * 照合そのものは `own-view-type.ts` の `slotOfViewType` にある（素の値か接頭辞つきの値の
 * 完全一致。枠ごとに `viewType` が違うので、所有の判定と枠の判定は同じ1つの表から出る）。
 *
 * **export しているのは `arrange-surface.ts` が同じ判定を使うためである。**
 * 写して2つ目を書かないこと ―― 片づけの面が緩い側にずれれば人間のパネルを
 * 閉じ、厳しい側にずれれば自分のパネルを片づけられなくなる（不変条件14）。
 */
export function isOwnTab(
  tab: vscode.Tab,
  opened: OpenedByAgent,
  textTabCount: ReadonlyMap<string, number>,
): boolean {
  if (tab.input instanceof vscode.TabInputWebview) {
    // **所有と枠は同じ表から読む**（`own-view-type.ts`。増分5 D61）。「自分のものか」は
    // 「どの枠か」が決まることと同じで、判定は `ownPanelSlot` の1つ。
    return ownPanelSlot(tab) !== undefined;
  }
  // **テキストタブは、記録にあり、かつ窓にその文書のタブが1枚だけのとき own**（D53）。
  // `Stage.open()` が記録し、閉じたら忘れる。`label` でも列の位置でも決めない ――
  // D41 の懸念（名前は騙れる）はそのまま生きている。
  //
  // **2枚以上あれば人間が関わっている。** 所有の鍵は URI であってタブではない
  // （`Tab` に安定した id は無い。設計書 Y7）ので、同じ文書のタブが2枚あるとき
  // 「どちらがエージェントの1枚か」は決められない。2枚になる順序は2つある:
  //   - 人間が先に `foo.ts` を開いていて、エージェントが同じ `foo.ts` を `show_code` した
  //   - エージェントが先に開いていて、人間が後から `foo.ts` を自分の列に開いた
  // どちらでも、記録だけを見ると**人間の1枚が own になる**。だから枚数を観測して、
  // 1枚でなければ own にしない（閉じない側に倒す。代償は、その場面では自分の
  // 1枚も片づけられないこと）。
  //
  // **枚数は呼び出しのたびに観測する。覚えない。** 覚えると、人間がタブを開いた・
  // 閉じた瞬間に記録と実態がずれ、それは「同じ量を2箇所で決める」になる
  // （不変条件14）。`countTextTabs` を同じ観測の中で1回だけ作って渡すこと。
  // 差分・ノートブック・カスタム編集器は `show_code` が開かないので、own になれない。
  if (tab.input instanceof vscode.TabInputText) {
    // **映しのタブはスキームで own**（D82。D53 を置き換える）。映しを開くのは `show_code`
    // だけで、スキームは人間の移動でもプリセットの合流でも残る ―― だから記録も枚数も見ない。
    // **設定（`agentTabs`）も見ない**（設計 B2）: 途中で切り替えても、開いている映しは own のまま。
    // 人間が同じファイルを `file:` で開いたタブは別の URI なので、下の D53 の枝に落ちて own に
    // ならない（同じファイルの2枚の衝突は起きない）。床（見ている・未保存）は `arrange-policy.ts`
    // が式を変えずに当てる。
    //
    // **own になるのは正準の綴りの映しだけ**（`isAgentStageUri`。タブの印も同じ述語を読む ―― D89）。`stageUriFor` は
    // 別綴り（authority つき・`//`・`/./`・先頭の `/` なし）を決して作らないので、別綴りの映しの
    // タブは作りから言って人間か別の拡張が開いたものである。own にしない ―― 片づけの方針は
    // 「閉じない側」に倒れる。記録（D53）の枝にも落とさない（映しは記録しない）。
    // 判定は**綴りだけ**で、実体の有無は見ない（`observedRelPath` を使わない）: ファイルが消えた
    // 映しのタブも own のまま `close-own` で片づけられる。大文字小文字だけ違う綴りは正準の形
    // なので own になる（`stageUriFor` のコメントの設計の注記: 別の文書として扱う）。
    if (isStageScheme(tab.input.uri.scheme)) return isAgentStageUri(tab.input.uri);
    const key = tab.input.uri.toString();
    return opened.has(key) && (textTabCount.get(key) ?? 0) === 1;
  }
  return false;
}

/**
 * そのタブが自分の webview なら、その枠（`slot`）。それ以外は `undefined`（C5 / D61）。
 *
 * **`isOwnTab` の webview の枝はこれで決まる**（own ⇔ 枠がある）。`get_editor_state` の面と
 * `arrange_editors` の面が両方これで `slot` を付ける ―― 枠の読み方を2箇所に書かない。
 * 判定の実体は `own-view-type.ts` の `slotOfViewType`（作る側と同じ表）。
 */
export function ownPanelSlot(tab: vscode.Tab): PanelSlot | undefined {
  if (!(tab.input instanceof vscode.TabInputWebview)) return undefined;
  return slotOfViewType(tab.input.viewType);
}

/**
 * 窓の中の、文書ごとのテキストタブの枚数（`isOwnTab` の第3引数）。
 *
 * **観測する側が1回だけ作り、その観測のすべてのタブに同じ表を渡す。**
 * `get_editor_state` の面と `arrange_editors` の面の両方がここを使う ――
 * 同じ数え方を2箇所に書かない（不変条件14）。
 */
export function countTextTabs(groups: readonly vscode.TabGroup[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const group of groups) {
    for (const tab of group.tabs) {
      if (!(tab.input instanceof vscode.TabInputText)) continue;
      const key = tab.input.uri.toString();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * `handleGetEditorState` に渡す、vscode に触る薄い層。
 *
 * ルートは `createEditorSurface` と同じ理由で呼び出しのたびに渡し直す
 * （多ルートで並びが変わったときに、ハンドラの見ているルートとここが食い違わない）。
 */
export function createEditorStateSurface(
  root: vscode.Uri | undefined,
  opened: OpenedByAgent,
  annotations: Annotations,
): EditorStateSurface {
  return {
    windowFocused(): boolean {
      return vscode.window.state.focused;
    },

    annotations(): ObservedAnnotation[] {
      // **ストアの `list()` 1回から作る**（増分6 D72）。パスはタブと同じ関数
      // （`observedRelPath`）で作る ―― `get_editor_state` が返す `path` は全部同じ
      // 関数から出る（不変条件14）。
      return annotations.list().map(({ id, index, uri, line, color, resolved }) => {
        const base = { id, index, relPath: observedRelPath(root, uri), line, resolved };
        return color === undefined ? base : { ...base, color };
      });
    },

    activeEditor(): ActiveEditorObservation | undefined {
      // **可視エディタへのフォールバックを置かない。** 置くと、`show_code` が
      // 開いたエディタが「人間のエディタ」の座に滑り込みうる。VS Code は
      // エディタを開き直すときに表示状態（＝以前の選択）を復元するので、
      // それはエージェントが選んだファイルの中身を、人間が一度選択したぶんだけ
      // 引き出せるということである。
      const editor = vscode.window.activeTextEditor;
      if (editor === undefined) return undefined;

      const document = editor.document;
      const selection = editor.selection;
      const lastLine = Math.max(0, document.lineCount - 1);
      const documentEnd = document.lineAt(lastLine).range.end;
      const zeroBased = {
        startLine: selection.start.line,
        startCharacter: selection.start.character,
        endLine: selection.end.line,
        endCharacter: selection.end.character,
      };

      return {
        relPath: observedRelPath(root, document.uri),
        // **`activeTextEditor` であることだけでは足りない。** VS Code の
        // `activeTextEditor` は「フォーカスを持つエディタ、**無ければ最後に
        // 入力が変わったエディタ**」である。人間が端末に居るあいだに
        // `show_code` が別の列へ開くと、preserveFocus を守っていても
        // 「最後に入力が変わったエディタ」は舞台側になりうる。人間が実際に
        // 使っているタブグループと同じ列かどうかで判定する。
        isActiveEditor:
          editor.viewColumn !== undefined &&
          editor.viewColumn === vscode.window.tabGroups.activeTabGroup.viewColumn,
        cursor: { line: selection.active.line + 1, character: selection.active.character },
        selection: {
          startLine: selection.start.line + 1,
          startCharacter: selection.start.character,
          endLine: selection.end.line + 1,
          endCharacter: selection.end.character,
        },
        empty: selection.isEmpty,
        coversWholeDocument: coversWholeDocument(zeroBased, lastLine, documentEnd.character),
        visibleLines: visibleLineRange(
          editor.visibleRanges.map((r) => ({ startLine: r.start.line, endLine: r.end.line })),
        ),
        readSelectedText: (maxChars: number): string => {
          const capped = capSelectionRange(
            zeroBased,
            (line) => document.lineAt(line).range.end.character,
            maxChars,
          );
          return document.getText(
            new vscode.Range(
              capped.startLine,
              capped.startCharacter,
              capped.endLine,
              capped.endCharacter,
            ),
          );
        },
      };
    },

    groups(): ObservedGroup[] {
      // **ここは観測するだけ。** 何を返すか（秘匿・上限・見出し）は
      // `buildEditorLayout` が決める（設計 §1.3）。判断をここに置くと、
      // vscode を値 import しているせいで単体で確かめられない。
      //
      // 可視行は `TextEditor` からしか読めない（`Tab` には無い）ので、
      // いま可視なエディタを URI で引けるようにしてから回す。
      const visibleByUri = new Map<string, VisibleLineRange>();
      for (const editor of vscode.window.visibleTextEditors) {
        const range = visibleLineRange(
          editor.visibleRanges.map((r) => ({ startLine: r.start.line, endLine: r.end.line })),
        );
        if (range !== undefined) visibleByUri.set(editor.document.uri.toString(), range);
      }

      // **1回の観測から作る。** `groups` を回すループと同じ `tabGroups.all` の読み出し
      // （呼ぶタイミングの差で食い違わないように、先に1度だけ取る）。
      const groups = vscode.window.tabGroups.all;
      const textTabCount = countTextTabs(groups);
      const out: ObservedGroup[] = [];
      for (const group of groups) {
        const tabs: ObservedTab[] = [];
        for (const tab of group.tabs) {
          const uri = tabResourceUri(tab.input);
          // **観測した値も同じ関門を通す**（不変条件14 の5件目）。VS Code は
          // ドキュメントの URI にシンボリックリンクを解決しないまま入れるので、
          // 綴りだけを見るとワークスペースの中に見えるものが外を指しうる。
          const relPath = uri === undefined ? undefined : observedRelPath(root, uri);
          // 枠は own の webview にだけ付く（`ownPanelSlot`。`isOwnTab` の webview の枝と同じ関数）。
          const slot = ownPanelSlot(tab);
          tabs.push({
            label: tab.label,
            kind: tabKind(tab.input),
            relPath,
            own: isOwnTab(tab, opened, textTabCount),
            ...(slot === undefined ? {} : { slot }),
            isActive: tab.isActive,
            isDirty: tab.isDirty,
            isPinned: tab.isPinned,
            isPreview: tab.isPreview,
            visibleLines: uri === undefined ? undefined : visibleByUri.get(uri.toString()),
          });
        }
        // **列番号が読めないグループは、丸めずに落とす。**
        //
        // 読めた／読めないの述語は `observedViewColumn` 1つ（`arrange-surface.ts` の
        // 人間の列と同じ量。ここに条件を書き足さない ―― 不変条件14）。
        // 起きたときに `1` へ丸めると、**黙って別の列（しかも既にある列と
        // 重複しうる番号）を名乗る**。それは観測ではなく推測であり、
        // D39「返せないものは返さない。推測もしない」と、この面の役目
        // （§1.4b「面は観測するだけで判断しない」）の両方に反する。
        //
        // 落とすと `groups` からその列が消えるが、**嘘の列番号よりは欠けたほうが
        // 良い** ―― 片づけ（`arrange_editors`）は列番号で人間の面を指すからである。
        const viewColumn = observedViewColumn(group.viewColumn);
        if (viewColumn === undefined) continue;
        out.push({
          viewColumn,
          isActive: group.isActive,
          tabs,
        });
      }
      return out;
    },
  };
}
