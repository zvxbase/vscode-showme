import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  type AnnotationColor,
  type Location,
  type WindowRole,
  listWorkspacesResultSchema,
  processUid,
  runtimeDirPath,
} from "@zvx/vscode-showme-protocol";
import * as vscode from "vscode";

export const EXTENSION_ID = "zvxbase.vscode-showme";

/**
 * `Resolution` を**そのまま**（未知の鍵も含めて）受け取る。
 *
 * 型を当てて受け取ると、まさに検査したいもの ―― 「件数を漏らす鍵が生えていないか」
 * ―― が型の側で消える。生の Record で受けて、鍵の集合そのものを assert する。
 */
export type RawResolution = Record<string, unknown>;

/** `resolutionSchema` が許す鍵。これ以外が生えていたら線に載る（＝漏れる）。 */
export const ALLOWED_RESOLUTION_KEYS: ReadonlySet<string> = new Set([
  "resolvedBy",
  "match",
  "range",
  "candidates",
  "reason",
  "normalizedPath",
]);

/**
 * `annotateResolutionSchema` が許す鍵（増分6 D71）。`show_code` の鍵に `id` と `index` を
 * 足したもの。**`show_code` の結果にはこの2つは生えない**（あちらは上の集合で見る）。
 */
export const ALLOWED_ANNOTATE_RESOLUTION_KEYS: ReadonlySet<string> = new Set([
  ...ALLOWED_RESOLUTION_KEYS,
  "id",
  "index",
]);

export async function activateExtension(): Promise<vscode.Extension<unknown>> {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(ext, `拡張 ${EXTENSION_ID} が見つからない`);
  await ext.activate();
  assert.strictEqual(ext.isActive, true, "拡張が activate しなかった");
  return ext;
}

export function workspaceRoot(): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "ワークスペースフォルダが開かれていない");
  return folder.uri;
}

/** テスト専用コマンド経由で show_code を呼ぶ（線上と同じ検証を通る）。 */
export async function showCode(
  locations: Location[],
  layout?: "single" | "split",
): Promise<RawResolution[]> {
  // 鍵ごと省く。`layout: undefined` を渡すと線上のスキーマ（strict）が落ちる。
  const args = layout === undefined ? { locations } : { locations, layout };
  const raw = await vscode.commands.executeCommand("showme.test.showCode", args);
  const result = raw as { resolutions?: unknown };
  assert.ok(Array.isArray(result.resolutions), "resolutions が配列で返らなかった");
  return result.resolutions as RawResolution[];
}

/** 1件だけ渡して1件だけ受け取る。 */
export async function showOne(location: Location): Promise<RawResolution> {
  const resolutions = await showCode([location]);
  assert.strictEqual(resolutions.length, 1, "解決結果の件数が1でない");
  const first = resolutions[0];
  assert.ok(first, "解決結果が空");
  return first;
}

/**
 * テスト専用コマンド経由で annotate を呼ぶ（線上と同じ検証を通る）。
 *
 * `mode` は鍵ごと省く（`layout` と同じ理由 ―― `undefined` を渡すと線上の
 * strict なスキーマが落ちる）。
 */
export async function annotate(
  items: { location: Location; text: string; color?: AnnotationColor }[],
  mode?: "replace" | "add",
): Promise<RawResolution[]> {
  const args = mode === undefined ? { items } : { items, mode };
  const raw = await vscode.commands.executeCommand("showme.test.annotate", args);
  const result = raw as { resolutions?: unknown };
  assert.ok(Array.isArray(result.resolutions), "resolutions が配列で返らなかった");
  return result.resolutions as RawResolution[];
}

/**
 * テスト専用コマンド経由で `annotate` の `mode: "clear"` を呼ぶ（設計 D54）。
 *
 * `items` は**渡さない**（線上のスキーマが落とす。付けると意図が曖昧になる）。
 * `annotate()` と別の口なのは、あちらの引数の型が `items` を必須にしているからで、
 * 「clear は items を持たない」を型でも言うため。
 */
export async function annotateClear(): Promise<RawResolution[]> {
  const raw = await vscode.commands.executeCommand("showme.test.annotate", { mode: "clear" });
  const result = raw as { resolutions?: unknown };
  assert.ok(Array.isArray(result.resolutions), "resolutions が配列で返らなかった");
  return result.resolutions as RawResolution[];
}

/**
 * テスト専用コマンド経由で `get_editor_state` を呼ぶ（線上と同じ検証を通る）。
 *
 * 返り値は**生の Record** で受け取る。型を当てると、まさに検査したいもの
 * ―― 「返らないはずの鍵が生えていないか」 ―― が型の側で消える。
 */
export async function getEditorState(): Promise<Record<string, unknown>> {
  const raw = await vscode.commands.executeCommand("showme.test.getEditorState");
  assert.ok(raw && typeof raw === "object", "get_editor_state が object を返さなかった");
  return raw as Record<string, unknown>;
}

/**
 * `get_editor_state` が返したレイアウトのタブ1枚。**生の Record** で受け取る。
 *
 * 型を当てると、まさに検査したいもの ―― 「返らないはずの鍵（外のファイルの
 * `visibleLines` など）が生えていないか」 ―― が型の側で消える。
 */
export type RawTab = Record<string, unknown>;

/** レイアウトの列1つ。`tabs` だけは配列であることを確かめて渡す。 */
export interface RawGroup {
  viewColumn?: unknown;
  isActive?: unknown;
  tabs: RawTab[];
}

/** `groups` を取り出す。無ければ空（鍵ごと省かれる形も正当な返り値である）。 */
export function layoutGroups(state: Record<string, unknown>): RawGroup[] {
  const groups = state.groups;
  if (groups === undefined) return [];
  assert.ok(Array.isArray(groups), "groups が配列でない");
  for (const group of groups) {
    assert.ok(group && typeof group === "object", "groups の要素が object でない");
    assert.ok(Array.isArray((group as RawGroup).tabs), "group.tabs が配列でない");
  }
  return groups as RawGroup[];
}

/** すべての列のすべてのタブ。**1枚ずつではなく全体に当てる**ための口。 */
export function layoutTabs(state: Record<string, unknown>): RawTab[] {
  return layoutGroups(state).flatMap((g) => g.tabs);
}

/**
 * 人間の選択が返るまで待って、**返ったときの状態**を渡す。
 *
 * `waitFor` で書けない理由が2つある:
 *
 *   1. 一度返ると次からは `already-returned` になるので、成立した瞬間の値を
 *      掴まえないと後から読み直せない
 *   2. 落ちたときに**最後の拒否理由**が要る。`selectedText が返らなかった` だけ
 *      では、待ちが足りないのか（`too-soon-after-tool`）、窓が前面に無いのか
 *      （`not-focused`）、人間の列に居ないのか（`not-active`）が分からない
 */
export async function waitForSharedSelection(timeoutMs = 8_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let lastWithheld: unknown = "(呼び出しが一度も成立していない)";
  for (;;) {
    const state = await getEditorState();
    if (typeof state.selectedText === "string") return state;
    lastWithheld = state.selectionWithheld;
    if (Date.now() >= deadline) {
      assert.fail(
        `選択テキストが ${timeoutMs}ms 以内に返らなかった（最後の理由: ${String(lastWithheld)}）`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export type ListWorkspacesResult = ReturnType<typeof listWorkspacesResultSchema.parse>;

/**
 * `list_workspaces` を線上と同じ道で呼び、**線上のスキーマで検証してから**返す。
 *
 * テスト用コマンドはブリッジを通らないので、ブリッジの結果検査
 * （`result-guard`）が無い。ここで同じスキーマを当てないと、拡張が
 * 欄を書き忘れても（D56 の3欄は必須）統合は緑のまま通る。
 */
export async function listWorkspaces(): Promise<ListWorkspacesResult> {
  const raw = await vscode.commands.executeCommand("showme.test.listWorkspaces");
  assert.ok(raw && typeof raw === "object", "list_workspaces が object を返さなかった");
  const parsed = listWorkspacesResultSchema.safeParse(raw);
  assert.ok(
    parsed.success,
    `list_workspaces の結果が線上のスキーマを通らない: ${JSON.stringify(raw)} / ${
      parsed.success ? "" : parsed.error.message
    }`,
  );
  return parsed.data;
}

/**
 * `show_view` の**対応表の値**（操作名 → VS Code のコマンド名）。
 *
 * 統合テストは `src/` を直接 import できない（`test/integration` の `rootDir` の
 * 外になる）ので、拡張の側から観測する。**対応表そのものを写さないこと** ――
 * 写した時点で「同じ量を2箇所で決める」（不変条件14）になり、実機に無い
 * コマンド名が表に残っていても検査は緑のまま通る。
 */
export async function viewCommands(): Promise<readonly string[]> {
  const raw = await vscode.commands.executeCommand("showme.test.viewCommands");
  assert.ok(raw && typeof raw === "object", "viewCommands が object を返さなかった");
  const commands = (raw as { commands?: unknown }).commands;
  assert.ok(Array.isArray(commands), "commands が配列でない");
  for (const command of commands) {
    assert.strictEqual(typeof command, "string", "commands に string でない値がある");
  }
  return commands as readonly string[];
}

/**
 * `arrange_editors` の**対応表の値**（操作名 → VS Code のコマンド名）。
 *
 * `viewCommands()` と同じ理由で、拡張の側から観測する ―― 表を写した時点で
 * 「同じ量を2箇所で決める」（不変条件14）になり、実機に無いコマンド名が
 * 残っていても検査は緑のまま通る。
 */
export async function arrangeCommands(): Promise<readonly string[]> {
  const raw = await vscode.commands.executeCommand("showme.test.arrangeCommands");
  assert.ok(raw && typeof raw === "object", "arrangeCommands が object を返さなかった");
  const commands = (raw as { commands?: unknown }).commands;
  assert.ok(Array.isArray(commands), "commands が配列でない");
  for (const command of commands) {
    assert.strictEqual(typeof command, "string", "commands に string でない値がある");
  }
  return commands as readonly string[];
}

/** `arrange_editors` が受け付ける操作（`ARRANGE_ACTIONS`。線上と同じ語彙。`single-column` は消えた）。 */
export type ArrangeActionName =
  | "close-own"
  | "two-columns"
  | "three-columns"
  | "two-rows"
  | "grid"
  | "even-widths"
  | "close-other-tabs"
  | "close-tabs"
  | "move-tab"
  | "move-panel"
  | "gather-own";

/**
 * 語ごとの引数（`move-tab`: path + toColumn / `move-panel`: toColumn + slot /
 * `close-tabs`: paths）。
 */
export interface ArrangeMoveArgs {
  path?: string;
  toColumn?: number;
  slot?: number;
  paths?: string[];
}

/**
 * テスト専用コマンド経由で `arrange_editors` を呼ぶ（線上と同じ検証とゲートを通る）。
 *
 * 返り値は**生の Record** で受け取る。型を当てると、まさに検査したいもの
 * ―― 「返らないはずの鍵（断った枚数など）が生えていないか」 ―― が
 * 型の側で消える。
 *
 * `undefined` の鍵は渡さない（線上のスキーマは `.strict()`）―― `extra` は
 * 呼び手が付けた鍵だけを持つこと。
 */
export async function arrangeEditors(
  action: ArrangeActionName,
  extra: ArrangeMoveArgs = {},
): Promise<Record<string, unknown>> {
  const raw = await vscode.commands.executeCommand("showme.test.arrangeEditors", {
    action,
    ...extra,
  });
  assert.ok(raw && typeof raw === "object", "arrange_editors が object を返さなかった");
  return raw as Record<string, unknown>;
}

/**
 * MCP 提供者が返す定義（統合テスト専用の観測点）。
 *
 * `vscode.lm` には「登録済みの提供者を列挙する」口が無いので、拡張が登録した
 * **同じ提供者オブジェクト**の `provideMcpServerDefinitions` を呼んだ結果を返して
 * もらう。ここで返るのはブリッジのパスだけで、トークンもソケットのパスも含まない。
 */
export async function mcpDefinitions(): Promise<{ command: string; args: string[] }[]> {
  const raw = await vscode.commands.executeCommand("showme.test.mcpDefinitions");
  assert.ok(Array.isArray(raw), "mcpDefinitions が配列を返さなかった");
  return raw.map((d: unknown) => {
    assert.ok(d && typeof d === "object", "定義が object でない");
    const { command, args } = d as { command?: unknown; args?: unknown };
    assert.strictEqual(typeof command, "string", "command が string でない");
    assert.ok(
      Array.isArray(args) && args.every((a) => typeof a === "string"),
      "args が string[] でない",
    );
    return { command: command as string, args: args as string[] };
  });
}

/**
 * **いま表示フレームに入っている** HTML の長さ（統合テスト専用の観測点）。
 *
 * `showme.test.panelState` の `length` と混同しないこと。あちらは「最後に投げた
 * ものが届いた」という**出来事の記録**で、webview が隠れて DOM ごと捨てられても
 * 残る ―― それに assert すると、中身が消えていても緑になる。こちらは生きている
 * フレームに問い合わせるので、**戻ってきたこと**を主張できる。
 */
export async function measureDisplayedLength(slot: PanelSlotName = 1): Promise<number> {
  const raw = await vscode.commands.executeCommand("showme.test.measureDisplayedLength", { slot });
  assert.ok(raw && typeof raw === "object", "measureDisplayedLength が object を返さなかった");
  const length = (raw as { length?: unknown }).length;
  assert.strictEqual(typeof length, "number", "length が number でない");
  return length as number;
}

/** パネルの枠（`show_html` の `slot`。線上と同じ整数。D61 → 増分6.2 D80）。 */
export type PanelSlotName = number;

/**
 * 枠ごとの、拡張が `createWebviewPanel` に渡す `viewType`（`own-view-type.ts` の `ownViewTypeFor`
 * と同じ値。統合テストは `src/` を import できないので写す ―― ずれたら `panelTab()` が
 * 見つけられず、「パネルが開く」の待ちで落ちる）。枠1は `showme.view`、枠 N ≥ 2 は
 * `showme.view.N`。VS Code はこれに `mainThreadWebview-` を前置する（実測）。
 */
function panelViewType(slot: PanelSlotName): string {
  return slot === 1 ? "showme.view" : `showme.view.${slot}`;
}

/** 観測した `viewType` がその枠のものか（素の値か、VS Code の接頭辞つきの完全一致）。 */
function isPanelViewType(viewType: string, slot: PanelSlotName): boolean {
  const own = panelViewType(slot);
  return viewType === own || viewType === `mainThreadWebview-${own}`;
}

/**
 * 自分の webview パネルのタブ**全部**（枠を問わない。列の順）。枚数の上限が設定次第に
 * なった（D80）ので、枠を列挙せずに数える口が要る。形は `own-view-type.ts` の
 * `slotOfViewType` と同じ（整数のみ・完全一致）。
 */
export function allPanelTabs(): vscode.Tab[] {
  const pattern = /^(?:mainThreadWebview-)?showme\.view(?:\.[1-9]\d*)?$/;
  const out: vscode.Tab[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input: unknown = tab.input;
      if (input instanceof vscode.TabInputWebview && pattern.test(input.viewType)) out.push(tab);
    }
  }
  return out;
}

/** 舞台の webview パネルのタブ（無ければ undefined）。枠は既定 1。 */
export function panelTab(slot: PanelSlotName = 1): vscode.Tab | undefined {
  return panelTabs(slot)[0];
}

/**
 * その枠の `viewType` を持つタブ**全部**（列の順）。
 *
 * `move-panel` は作ってから破棄するので、一瞬2枚になりうる。「1枚に戻った」を
 * 主張するには、最初の1枚ではなく枚数を見る必要がある。
 */
export function panelTabs(slot: PanelSlotName = 1): vscode.Tab[] {
  const out: vscode.Tab[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input: unknown = tab.input;
      if (input instanceof vscode.TabInputWebview && isPanelViewType(input.viewType, slot)) {
        out.push(tab);
      }
    }
  }
  return out;
}

/**
 * パネルが**いま見えているか**。
 *
 * 拡張の内部状態ではなく VS Code のタブを見る ―― 「隠れた」を拡張の記録で
 * 判定すると、隠れていないのに隠れたことにして先へ進める。
 */
export function panelIsVisible(slot: PanelSlotName = 1): boolean {
  return panelTab(slot)?.isActive === true;
}

/** パネルが載っている列（無ければ undefined）。 */
export function panelColumn(slot: PanelSlotName = 1): vscode.ViewColumn | undefined {
  const tab = panelTab(slot);
  if (tab === undefined) return undefined;
  return vscode.window.tabGroups.all.find((g) => g.tabs.includes(tab))?.viewColumn;
}

/** 指定の URI を表示している可視エディタ（無ければ undefined）。 */
export function visibleEditorFor(uri: vscode.Uri): vscode.TextEditor | undefined {
  return vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString());
}

/**
 * 条件が成立するまで待つ。
 *
 * 述語は同期でも非同期でもよい。観測がコマンド越し（`inspectVisuals`）に
 * なる面があり、同期に限ると「1回だけ見て諦める」書き方に倒れる。
 */
export async function waitFor(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) assert.fail(`${label} が ${timeoutMs}ms 以内に成立しなかった`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** 0始まりの行が、そのエディタの可視範囲に入っているか。 */
export function showsLine(editor: vscode.TextEditor, zeroBasedLine: number): boolean {
  return editor.visibleRanges.some(
    (r) => r.start.line <= zeroBasedLine && zeroBasedLine <= r.end.line,
  );
}

export function asNumber(value: unknown, label: string): number {
  assert.strictEqual(typeof value, "number", `${label} が number でない`);
  return value as number;
}

/**
 * このウィンドウの登録ファイルを読む。
 *
 * `authToken` は**返さない**。テストの assert メッセージも記録に残る出力なので、
 * 呼び出し側が誤って印字できる場所にトークンを置かない。
 */
export function readOwnRegistration(): Record<string, unknown> {
  const runtimeDir = runtimeDirPath(process.env, os.tmpdir(), processUid(process));
  assert.ok(fs.existsSync(runtimeDir), `実行時ディレクトリが無い: ${runtimeDir}`);

  const expected = workspaceRoot().fsPath;
  const mine = fs
    .readdirSync(runtimeDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(runtimeDir, name), "utf8")) as Record<
          string,
          unknown
        >;
      } catch {
        return undefined;
      }
    })
    .filter((entry) => entry?.workspacePath === expected && entry?.pid === process.pid);

  assert.strictEqual(mine.length, 1, `このウィンドウの登録ファイルが1件でない（${mine.length}件）`);
  const entry = mine[0];
  assert.ok(entry, "登録ファイルが読めない");
  const { authToken: _authToken, ...rest } = entry;
  return rest;
}

/**
 * ソケットが実際に立っていることを、登録ファイルの実在で確かめる。
 *
 * 「activate が例外を投げなかった」だけでは足りない。`server.start()` が
 * 失敗しても activate は成功する（拡張自体は有効なままにする設計）ので、
 * 起動できていないウィンドウが「制限モードで動いた」と読めてしまう。
 */
export function assertSocketIsListening(): void {
  const entry = readOwnRegistration();
  const socketPath = entry.socketPath;
  assert.strictEqual(typeof socketPath, "string", "socketPath が文字列でない");
  assert.ok(fs.existsSync(String(socketPath)), `ソケットが存在しない: ${String(socketPath)}`);
}

/**
 * 預けていない（ShowMe がオフの）窓での拒否の文言（`src/tool-gate.ts` の `WINDOW_OFF_MESSAGE`）。
 *
 * **わざと写してある。** 統合テストの tsconfig は `rootDir` が
 * `test/integration` なので拡張のソースを import できないが、それ以上に、
 * 実装から取ってくると「実装が言っていることを実装に確かめる」形になる。
 * ここを書き換えないと通らないようにしておけば、文言を変えた人は
 * runbook（人間向けの案内）も一緒に見直すことになる。
 */
export const WINDOW_OFF_MESSAGE =
  "ShowMe is off for this window. Click ShowMe in the VS Code status bar to turn it on (if it says Stopped, resume it first)";

/**
 * `showme.toggle` を呼んだ回数。
 *
 * 「**既定で**操作できない」を主張するテストは、そこまでに一度も役割を
 * 触っていないことに依存している。テストを並べ替えた人が黙って前提を
 * 壊せないよう、回数そのものを見えるようにしておく。
 */
let toggleCount = 0;
export function toggleCallCount(): number {
  return toggleCount;
}

/**
 * いまの役割。**登録ファイルから読む**。
 *
 * 拡張の内部状態を覗く口は無い（あえて作っていない）。登録ファイルは
 * `applyRole` が役割の変化のたびに書き直す、外から観測できる唯一の面であり、
 * ブリッジが実際に見るのもここである。
 */
export function currentRole(): WindowRole {
  const role = readOwnRegistration().role;
  assert.ok(role === "stage" || role === "idle", `登録ファイルの role が未知の値: ${String(role)}`);
  return role;
}

/**
 * 役割を `want` に**合わせる**（既に合っていれば何もしない）。
 *
 * `showme.toggle` は切り替えしか無いので、望む役割を指定する形にしておかないと
 * 「前のテストが預けたままにした」状態に次のテストが依存する。各 test は
 * 自分が要る役割をここで宣言すること。
 */
export async function setRole(want: WindowRole): Promise<void> {
  if (currentRole() === want) return;
  toggleCount += 1;
  await vscode.commands.executeCommand("showme.toggle");
  await waitFor(`役割が ${want} になる`, () => currentRole() === want);
}

/** この窓をエージェントに預ける（統合テストの大半の前提）。 */
export async function lendWindow(): Promise<void> {
  await setRole("stage");
}

/**
 * 可視エディタの写し。列と URI の組で採る。
 *
 * 件数だけを数えると「拒否したのに別の列で開いた」が判別しない。
 */
export function visibleEditorSnapshot(): string[] {
  return vscode.window.visibleTextEditors
    .map((e) => `${String(e.viewColumn)}:${e.document.uri.toString()}`)
    .sort();
}

/** 設定 `showme.<key>` を**グローバルに**書く（不変条件9: 拡張はそこしか読まない）。 */
export async function setGlobal(key: string, value: unknown): Promise<void> {
  await vscode.workspace
    .getConfiguration()
    .update(`showme.${key}`, value, vscode.ConfigurationTarget.Global);
}

/** 設定 `showme.<key>` が**実際にその globalValue で読まれる状態**か。前提として毎回確かめる。 */
export function assertGlobal(key: string, want: unknown): void {
  // 配列の設定（`redactedPathPatterns`）も比べるので中身で比べる（プリミティブは strictEqual と同じ）。
  assert.deepStrictEqual(
    vscode.workspace.getConfiguration().inspect(`showme.${key}`)?.globalValue,
    want,
    `showme.${key} の globalValue が ${String(want)} でない（前提が崩れている）`,
  );
}

/**
 * 映しのスキーム名（D81 / D84）。src の定数を import せず文字列で書く（統合テストの
 * rootDir は src を含まない）。綴りが変われば検査が落ちる ―― スキーム名は人間のタブや
 * 復元に残る外向きの名前なので、黙って変わってよいものではない。
 */
export const STAGE_SCHEME_READONLY = "showme-ro";
export const STAGE_SCHEME_EDITABLE = "showme-rw";
export type StageScheme = typeof STAGE_SCHEME_READONLY | typeof STAGE_SCHEME_EDITABLE;

/**
 * `rel` を舞台で開いたときの URI（D84）。**規則はテスト側に写さない。**
 *
 * 統合テストは `src/` を import できない（rootDir の外）。規則（`stageUriFor` と、設定から
 * スキームを決める `effectiveStageScheme`）をここに書き写すと、同じ量を2箇所で決めることに
 * なる（不変条件14）。拡張のテスト専用コマンド `showme.test.stageUri` が `show_code` と
 * 同じ関数・同じ設定の読み方で組んだ部品を返すので、それを `Uri.from` で組み直すだけにする
 * （文字列を `Uri.parse` すると `%` / `#` を誤読しうる）。
 *
 * `scheme` を省くと**いまの設定**（`showme.stage.agentTabs` / `editable` / `stage.enabled`）で
 * 決まる舞台のスキーム。明示すればそのスキーム（`showme-ro:` と `showme-rw:` を並べて
 * 比べる検査、人間側の `file:` など）。設定を書き換える検査では、書き換えた**後**に呼ぶこと。
 */
export async function stageUri(rel: string, scheme?: "file" | StageScheme): Promise<vscode.Uri> {
  const raw = await vscode.commands.executeCommand("showme.test.stageUri", { path: rel, scheme });
  assert.ok(raw && typeof raw === "object", "stageUri が object を返さなかった");
  const { scheme: s, authority, path } = raw as Record<string, unknown>;
  assert.ok(
    typeof s === "string" && typeof authority === "string" && typeof path === "string",
    `stageUri の形が違う: ${JSON.stringify(raw)}`,
  );
  return vscode.Uri.from({ scheme: s, authority, path });
}

/** `rel` を舞台で開いたときの URI の文字列（`highlightedUris` / `annotatedUris` と比べる形）。 */
export async function stageUriString(rel: string): Promise<string> {
  return (await stageUri(rel)).toString();
}

/**
 * 設定を書いて `body` を走らせ、`finally` で必ず戻す。戻したことも確かめる（後続の節の前提）。
 *
 * 書き込みも try の中に置く: 2つ目の書き込みが落ちても、1つ目は finally で戻る。
 */
export async function withSettings(
  settings: Record<string, unknown>,
  body: () => Promise<void>,
): Promise<void> {
  try {
    for (const [key, value] of Object.entries(settings)) await setGlobal(key, value);
    for (const [key, value] of Object.entries(settings)) assertGlobal(key, value);
    await body();
  } finally {
    for (const key of Object.keys(settings)) await setGlobal(key, undefined);
  }
  for (const key of Object.keys(settings)) assertGlobal(key, undefined);
}

/**
 * 節（suite）の間だけ旧来の D53 の経路（`showme.stage.agentTabs: false`）にする。
 *
 * 既定は映し（`true`。D84）である。`file:` のタブの「記録＋枚数」の所有、人間が
 * 動かしたタブは人間のものになる、プリセットの合流の再記録、といった **D53 に固有の検査**は
 * `false` の経路の検査として残す（その経路は設定で選べるので、壊れてはいけない）。
 * 映しの側の同じ論点は stage-tabs.test.ts が見ている。
 */
export function pinLegacyFileTabs(): void {
  suiteSetup(async () => {
    await setGlobal("stage.agentTabs", false);
    assertGlobal("stage.agentTabs", false);
  });
  suiteTeardown(async () => {
    await setGlobal("stage.agentTabs", undefined);
    assertGlobal("stage.agentTabs", undefined);
  });
}

/** いま存在する編集グループの数（人間の列 ＋ 舞台の列）。 */
export function tabGroupCount(): number {
  return vscode.window.tabGroups.all.length;
}

/**
 * 拡張が画面に出しているもの。**装飾とステータスバーは外からは読めない**ので、
 * テスト専用コマンド（`showme.test.inspectVisuals`）越しに観測する。
 *
 * ここが無い間、`applyRole` から `highlights.clearAll()` と
 * `statusBar.setRole(role)` を消しても単体441件・統合24件がすべて緑のままだった
 * （実測）。可視エディタと登録ファイルしか見ていなかったからである。
 */
export interface VisualState {
  highlightedUris: string[];
  /**
   * いま貼っている範囲と、その**層**（増分6 §C2）。`spotlight` は `show_code` のもの、
   * `annotation` は注釈ストアのもの。`highlightedUris` は両層の和なので、
   * 「どちらの塗りが残ったか」はここでしか言えない。
   */
  highlightRanges: Array<{
    uri: string;
    layer: "spotlight" | "annotation";
    startLine: number;
    startColumn: number;
    endColumn: number;
    wholeLine: boolean;
    color: string;
  }>;
  /**
   * いま出ている吹き出しの URI。**重複を潰していない**ので、件数がそのまま
   * 吹き出しの件数である（`mode: "replace"` が冪等かを判別するのに要る）。
   */
  annotatedUris: string[];
  /**
   * いま出ている吹き出しの本文と、その本文が VS Code に渡った型。
   *
   * `kind` を一緒に見るのは、`string` であること自体が防御だからである
   * （設計書 §3.2.1）。本文の文字列だけを見ると、markdown の値に変えても
   * 「同じ文字列が入っている」で通ってしまう。
   */
  annotatedBodies: Array<{
    kind: string;
    text: string;
    /**
     * `author.name` そのもの（D57: 色つきは `ShowMe 🔴 R`、無印は `ShowMe`）。
     *
     * 色は `author` 側の欄なので、色を付けても `kind` は `string` の
     * ままである ―― その2つを同じ観測で見られるようにしてある（設計 D57/D48）。
     */
    author: string;
  }>;
  /**
   * 吹き出しに**無い UI**（増分6 D70）。人間からエージェントへ流れるのは Resolve の
   * 1ビットだけで、返信（`canReply`）・新規作成（`commentingRangeProvider`）・
   * リアクション（`reactionHandler`）の口は無い。「設定していない」は実機でしか
   * 言えないので、それを決めているプロパティを観測する。
   */
  annotationUi: {
    canReply: boolean[];
    hasCommentingRangeProvider: boolean;
    hasReactionHandler: boolean;
  };
  statusBar: { text: string; tooltip: string };
}

export async function inspectVisuals(): Promise<VisualState> {
  const raw = await vscode.commands.executeCommand("showme.test.inspectVisuals");
  assert.ok(raw && typeof raw === "object", "inspectVisuals が object を返さなかった");
  const state = raw as Partial<VisualState>;
  assert.ok(Array.isArray(state.highlightedUris), "highlightedUris が配列でない");
  assert.ok(Array.isArray(state.highlightRanges), "highlightRanges が配列でない");
  assert.ok(Array.isArray(state.annotatedUris), "annotatedUris が配列でない");
  assert.ok(Array.isArray(state.annotatedBodies), "annotatedBodies が配列でない");
  assert.ok(state.annotationUi, "annotationUi が無い");
  assert.ok(Array.isArray(state.annotationUi.canReply), "annotationUi.canReply が配列でない");
  assert.ok(state.statusBar, "statusBar が無い");
  return state as VisualState;
}

/**
 * いま focus を持っているエディタの写し。`undefined` も1つの値として畳む。
 *
 * 列と URI の組で採る。URI だけで見ると、同じファイルが人間の列と舞台の
 * 両方に開いているときに「フォーカスが移った」が判別しない。
 */
export function activeEditorSnapshot(): string {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined) return "(none)";
  return `${String(editor.viewColumn)}:${editor.document.uri.toString()}`;
}

/**
 * `id` の吹き出しの `CommentThread` そのもの（`showme.test.annotationThread`）。
 *
 * `comments/commentThread/title` のボタンが命令に渡す引数と同じもの。VS Code には
 * スレッドを列挙する API が無いので、拡張の側の口から取る。
 */
export async function annotationThread(id: number): Promise<vscode.CommentThread> {
  const raw = await vscode.commands.executeCommand("showme.test.annotationThread", { id });
  assert.ok(raw && typeof raw === "object", `id ${id} のスレッドが無い`);
  return raw as vscode.CommentThread;
}

/** `executeDefinitionProvider` / `executeReferenceProvider` の結果1件。 */
export type LocationResult = vscode.Location | vscode.LocationLink;

/**
 * 結果1件を `スキーム:ファイル名@行:桁` に。定義の Link は選択範囲（名前の位置）の先頭で書く。
 * 映しのタブの定義・参照（D88）の検査が、件数と重なりを文字列の一覧で比べるための形。
 */
export function describeLocation(t: LocationResult): string {
  const isLink = "targetUri" in t;
  const uri = isLink ? t.targetUri : t.uri;
  const range = isLink ? (t.targetSelectionRange ?? t.targetRange) : t.range;
  return `${uri.scheme}:${path.posix.basename(uri.path)}@${range.start.line}:${range.start.character}`;
}

/**
 * 人間が F12（Ctrl+クリックと同じ「定義へ移動」）を押したとき、どこへ行くか。
 *
 * 1件なら飛ぶ（アクティブな編集器か選択が変わる）、2件以上なら既定（`editor.gotoLocation.multipleDefinitions`
 * = `peek`）で覗き見が開き、編集器も選択も動かない。覗き見を読む API は無いので、「3秒動かなかった」を
 * `stayed` と書く。終わったら覗き見と編集器を閉じる。
 */
export async function goToDefinitionFrom(
  mirror: vscode.Uri,
  pos: vscode.Position,
): Promise<string> {
  const editor = await vscode.window.showTextDocument(mirror, { preview: false });
  editor.selection = new vscode.Selection(pos, pos);
  await vscode.commands.executeCommand("editor.action.revealDefinition");
  const moved = () => {
    const a = vscode.window.activeTextEditor;
    return (
      a !== undefined &&
      (a.document.uri.toString() !== mirror.toString() || !a.selection.active.isEqual(pos))
    );
  };
  try {
    await waitFor("F12 で動く", moved, 3_000);
  } catch {
    // 動かなかった（覗き見）。下で `stayed` と書く。
  }
  const a = vscode.window.activeTextEditor;
  const where =
    a !== undefined && moved()
      ? `jump ${a.document.uri.scheme}:${path.posix.basename(a.document.uri.path)}@${a.selection.active.line}:${a.selection.active.character}`
      : "stayed";
  await vscode.commands.executeCommand("closeReferenceSearch");
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  return where;
}
