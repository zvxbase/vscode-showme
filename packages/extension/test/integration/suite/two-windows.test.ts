import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { callExtension } from "@zvx/vscode-showme-bridge/dist/client.js";
import {
  type RegistryEntry,
  type RegistryRead,
  defaultRuntimeDirs,
  describeSelectionFailure,
  nodeRegistryFileSystem,
  readRegistryEntries,
  selectWindow,
} from "@zvx/vscode-showme-bridge/dist/discover.js";
import { SOCKET_ENV_VAR, type WireRequest } from "@zvx/vscode-showme-protocol";
import * as vscode from "vscode";
import { DEEP_TEXT, NOT_FOCUSED_MARKER, NOT_FOCUSED_REL, SAMPLE_REL } from "../fixture.js";
import {
  type BetaCommand,
  type BetaOp,
  type BetaReply,
  type BetaStatus,
  COMMAND_FILE,
  coordDirFrom,
  readBetaStatuses,
  readJson,
  replyPath,
  sleep,
  writeJsonAtomic,
} from "../two-window-coord.js";
import {
  WINDOW_OFF_MESSAGE,
  activateExtension,
  getEditorState,
  lendWindow,
  readOwnRegistration,
  setRole,
  stageUri,
  visibleEditorFor,
  visibleEditorSnapshot,
  waitFor,
  workspaceRoot,
} from "./helpers.js";

/**
 * **2A の中核の主張を実機で確かめる**（設計書 §2A.5 / 増分2A Task 8）。
 *
 * 同じフォルダを開いた2つの窓を立て、片方だけを人間が預けた状態にして、
 * **`$SHOWME_SOCK` も `workspace_path` も使わずに**ブリッジが預けられた窓を
 * 選べることを見る。ここが働かなければ、2A で入れた「窓の役割」は絵に描いた餅
 * である ―― 単体テストは `chooseStageWindow` に作り物の候補を渡しているだけで、
 * 本物の VS Code が本物の登録ファイルを2つ書くところは一度も通っていない。
 *
 * **選択だけでなく、選択が外れる側も見る。**
 *
 *   - 預けた窓を alpha から beta へ移すと、選ばれる窓も移る
 *     （「候補の先頭を返す」実装ならここで落ちる）
 *   - 両方預けると、両方を名指しして断る（黙って先頭を選ばない）
 *   - 預けていない窓は、**ソケットを直接叩いても**拒否し、可視エディタが動かない
 *
 * 最後の一つには対照を付けてある。預けていない窓が動かないことは、そもそも
 * 何も起きない要求を投げれば自明に成り立つ。だから**同じ要求を、同じ窓が
 * 預けられている状態で投げると可視エディタが動く**ことまで見る。
 */

const COORD_DIR = coordDirFrom(process.env);

/** 測られる側が指図を飲み込んで役割を切り替えるまでの猶予。 */
const BETA_TIMEOUT_MS = 60_000;

/** 2つ目の窓が立って登録を書くまでの猶予。窓の起動 ＋ 拡張ホストの起動を含む。 */
const SECOND_WINDOW_TIMEOUT_MS = 90_000;

/**
 * 「起きなかったこと」を見る前に置く待ち。
 *
 * 拒否されたのにエディタが開く欠陥があったとして、投げた直後に測ると
 * まだ開いていないだけで「変わらなかった」と読める。開くのに十分な時間を
 * 置いてから測る。長さの根拠は下の対照（預けた窓なら同じ時間内に開く）。
 */
const SETTLE_MS = 3_000;

let alphaWindowId = "";
let betaPid = 0;
let betaWindowId = "";

let commandSeq = 0;

interface BetaSnapshot {
  role: string;
  visibleEditors: string[];
  tabGroups: number;
  /**
   * 測られる側の窓が前面にあるか。
   *
   * 「測る側が前面に無い」だけでは、`window.state.focused` が壊れている場合と
   * 区別できない。**どちらか一方は前面にある**ことまで見て、初めて false が
   * 意味のある観測になる。
   */
  windowFocused: boolean;
}

interface BetaIdentity {
  pid: number;
  windowId: string;
  workspacePath: string;
  socketPath: string;
  role: string;
}

/** 測られる側に1つ指図して、返事を待つ。 */
async function askBeta<T>(command: BetaOp, timeoutMs = BETA_TIMEOUT_MS): Promise<T> {
  commandSeq += 1;
  const seq = commandSeq;
  const message: BetaCommand = { seq, command };
  writeJsonAtomic(path.join(COORD_DIR, COMMAND_FILE), message);

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const reply = readJson<BetaReply>(replyPath(COORD_DIR, seq));
    if (reply !== undefined) {
      assert.ok(reply.ok, `測られる側が ${command.op} に失敗した: ${String(reply.error)}`);
      return reply.data as T;
    }
    if (Date.now() >= deadline) {
      assert.fail(`測られる側が ${command.op} に ${timeoutMs}ms 以内に応えなかった`);
    }
    await sleep(200);
  }
}

/** 測られる側が定期的に書いている近況。1つだけあるはず。 */
function betaStatus(): BetaStatus | undefined {
  const all = readBetaStatuses(COORD_DIR);
  assert.ok(all.length <= 1, `測られる側の窓が ${all.length} 個ある（1つのはず）`);
  return all[0];
}

/**
 * 測られる側の近況が条件を満たすまで待つ。
 *
 * 近況には `failure` が載る。**先にそれを見る。** 見ないと、2つ目の窓に拡張が
 * 入らなかったときの失敗が「時間切れ」に化け、原因が消える。
 */
async function waitForBeta(
  label: string,
  predicate: (status: BetaStatus) => boolean,
  timeoutMs: number,
): Promise<BetaStatus> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = betaStatus();
    if (status !== undefined) {
      assert.strictEqual(
        status.failure,
        undefined,
        `測られる側の窓が立ち上がれなかった: ${String(status.failure)}`,
      );
      if (predicate(status)) return status;
    }
    if (Date.now() >= deadline) assert.fail(`${label} が ${timeoutMs}ms 以内に成立しなかった`);
    await sleep(200);
  }
}

/** ブリッジが実際に読むのと同じ経路で登録ファイルを読む。 */
function readRegistry(): RegistryRead {
  return readRegistryEntries(defaultRuntimeDirs(), nodeRegistryFileSystem);
}

function entryOf(read: RegistryRead, windowId: string): RegistryEntry {
  const found = read.entries.find((e) => e.windowId === windowId);
  assert.ok(found, `windowId ${windowId} の登録が読めない`);
  return found;
}

/** 登録が2件あることを、毎回の検査の前提として確かめる。 */
function readBothWindows(): RegistryRead {
  const read = readRegistry();
  assert.strictEqual(
    read.entries.length,
    2,
    `登録が2件でない（${read.entries.length}件）。窓が1つしか無いなら、この節は『役割で選んだ』ことを何も確かめていない`,
  );
  return read;
}

function showSampleRequest(id: string): WireRequest {
  return { id, tool: "show_code", args: { locations: [{ path: SAMPLE_REL, text: DEEP_TEXT }] } };
}

function mentionsSample(editors: readonly string[]): boolean {
  return editors.some((e) => e.endsWith(SAMPLE_REL));
}

suite("実 VS Code / 2窓（役割で窓を選ぶ）", () => {
  suiteSetup(async function () {
    this.timeout(SECOND_WINDOW_TIMEOUT_MS + 60_000);
    await activateExtension();

    await waitFor("測る側の登録ファイルが立つ", () => readRegistry().entries.length >= 1, 60_000);
    const own = readOwnRegistration();
    assert.strictEqual(typeof own.windowId, "string", "自分の登録に windowId が無い");
    alphaWindowId = String(own.windowId);

    // 同じフォルダの2窓目は**これでしか開かない**。`vscode.openFolder` に
    // `forceNewWindow` を渡しても、同一フォルダでは例外も投げずに何も起きない
    // （スパイクで実測: 45秒待って登録は1件のまま）。
    await vscode.commands.executeCommand("workbench.action.duplicateWorkspaceInNewWindow");

    const status = await waitForBeta(
      "測られる側の窓が登録を立てる",
      (s) => s.ready && s.windowId !== undefined,
      SECOND_WINDOW_TIMEOUT_MS,
    );
    betaPid = status.pid;

    const identity = await askBeta<BetaIdentity>({ op: "identity" });
    betaWindowId = identity.windowId;
    assert.notStrictEqual(betaWindowId, alphaWindowId, "2つの窓が同じ windowId を名乗っている");
  });

  test("同じフォルダの2窓が、別々の登録を立てている", () => {
    const read = readBothWindows();
    const alpha = entryOf(read, alphaWindowId);
    const beta = entryOf(read, betaWindowId);

    assert.notStrictEqual(alpha.pid, beta.pid, "2つの登録が同じ pid を名乗っている");
    assert.strictEqual(alpha.pid, process.pid, "測る側の登録の pid が自分と違う");
    assert.strictEqual(beta.pid, betaPid, "測られる側の登録の pid が近況と違う");

    assert.notStrictEqual(alpha.socketPath, beta.socketPath, "2窓が同じソケットを共有している");
    assert.ok(fs.existsSync(alpha.socketPath), "測る側のソケットが存在しない");
    assert.ok(fs.existsSync(beta.socketPath), "測られる側のソケットが存在しない");

    // **ここがこの節の存在理由である。** 2窓は同じフォルダを開いているので、
    // `workspace_path` では永久に区別できない。区別できる軸は役割しかない。
    assert.strictEqual(
      alpha.workspacePath,
      beta.workspacePath,
      "2窓が同じフォルダを開いていない。この節の前提が崩れている",
    );
  });

  test("片方だけを stage にできる", async () => {
    await lendWindow();
    await askBeta<{ role: string }>({ op: "set-role", role: "idle" });

    const read = readBothWindows();
    const stages = read.entries.filter((e) => e.role === "stage");
    const idles = read.entries.filter((e) => e.role === "idle");
    assert.strictEqual(stages.length, 1, `stage の窓が1つでない（${stages.length}個）`);
    assert.strictEqual(idles.length, 1, `idle の窓が1つでない（${idles.length}個）`);
    assert.strictEqual(stages[0]?.windowId, alphaWindowId, "stage になっているのが測る側でない");
    assert.strictEqual(idles[0]?.windowId, betaWindowId, "idle のままなのが測られる側でない");
  });

  test("$SHOWME_SOCK 無し・workspace_path 無しで、stage の窓が選ばれる", async () => {
    await lendWindow();
    await askBeta<{ role: string }>({ op: "set-role", role: "idle" });

    // ヒントに頼っていないことを、環境そのもので確かめる。拡張が
    // `$SHOWME_SOCK` を注入するのは統合ターミナルだけで、拡張ホストには入らない。
    assert.strictEqual(
      process.env[SOCKET_ENV_VAR],
      undefined,
      `${SOCKET_ENV_VAR} が env にある。この検査は「ヒント無しで選べる」ことを見ていない`,
    );

    const read = readBothWindows();
    const selection = selectWindow(read.entries, {});
    assert.ok(
      selection.ok,
      `窓を選べなかった: ${selection.ok ? "" : describeSelectionFailure(selection, read)}`,
    );
    assert.strictEqual(selection.entry.windowId, alphaWindowId, "預けた窓が選ばれていない");
    assert.strictEqual(
      selection.entry.socketPath,
      entryOf(read, alphaWindowId).socketPath,
      "選ばれた窓のソケットが、預けた窓のものでない",
    );
  });

  /**
   * 「先頭を返しているだけ」を落とす。
   *
   * 前の test だけだと、候補の並び順がたまたま測る側を先頭にしているのか、
   * 役割で選んでいるのかが判別しない。**預ける窓を移して、選ばれる窓も移る**
   * ことを見る。登録ファイルの並びは動かない（どちらの窓も立ったまま）ので、
   * 動く理由は役割しかない。
   */
  test("預ける窓を移すと、選ばれる窓も移る", async () => {
    await setRole("idle");
    await askBeta<{ role: string }>({ op: "set-role", role: "stage" });

    const read = readBothWindows();
    const selection = selectWindow(read.entries, {});
    assert.ok(
      selection.ok,
      `窓を選べなかった: ${selection.ok ? "" : describeSelectionFailure(selection, read)}`,
    );
    assert.strictEqual(
      selection.entry.windowId,
      betaWindowId,
      "預ける窓を移したのに、選ばれる窓が移っていない（先頭を返しているだけの疑い）",
    );
  });

  test("両方 stage にすると、両方を名指しして断る", async () => {
    await lendWindow();
    await askBeta<{ role: string }>({ op: "set-role", role: "stage" });

    const read = readBothWindows();
    assert.strictEqual(
      read.entries.filter((e) => e.role === "stage").length,
      2,
      "両方を stage にできていない",
    );

    const selection = selectWindow(read.entries, {});
    assert.strictEqual(
      selection.ok,
      false,
      "両方預けているのに窓が1つ選ばれた（黙って先頭を選んだ）",
    );
    if (selection.ok) return;
    assert.strictEqual(selection.reason, "multiple-stages", `断り方が違う: ${selection.reason}`);
    if (selection.reason !== "multiple-stages") return;

    const named = selection.stages.map((s) => s.windowId).sort();
    assert.deepStrictEqual(
      named,
      [alphaWindowId, betaWindowId].sort(),
      "断りが2つの窓の両方を名指ししていない",
    );

    // 人間が読む言葉にも両方が出ること。片方しか出ないと、どちらを外せばよいか分からない。
    const message = describeSelectionFailure(selection, read);
    assert.ok(message.includes(alphaWindowId), `断りの文言に測る側の窓が出ない: ${message}`);
    assert.ok(message.includes(betaWindowId), `断りの文言に測られる側の窓が出ない: ${message}`);

    // ヒントは主経路ではないが、**役割で絞った後の同点解決としては効く**（§2A.5）。
    const viaSock = selectWindow(read.entries, { sock: entryOf(read, betaWindowId).socketPath });
    assert.ok(viaSock.ok, "$SHOWME_SOCK で同点を解けなかった");
    assert.strictEqual(viaSock.entry.windowId, betaWindowId, "同点解決が別の窓を選んだ");
  });

  /**
   * 設計書 §2A.1 の既定 ―― **預けていない窓は何を投げても動かない**。
   *
   * ブリッジ越しではなく、**測られる側のソケットとトークンを直接使って**投げる。
   * ブリッジ経由だとそもそも選ばれないので、拒否しているのが窓なのか選択なのか
   * 分からない。窓に届いたうえで断られることを見る。
   */
  test("預けていない窓は、ソケットを直接叩いても拒否し、可視エディタも動かない", async () => {
    await lendWindow();
    await askBeta<{ role: string }>({ op: "set-role", role: "idle" });

    const read = readBothWindows();
    const beta = entryOf(read, betaWindowId);
    const before = await askBeta<BetaSnapshot>({ op: "snapshot" });
    const alphaBefore = visibleEditorSnapshot();

    for (const request of [
      showSampleRequest("two-win-idle-show"),
      { id: "two-win-idle-list", tool: "list_workspaces", args: {} } satisfies WireRequest,
      // **人間のタブを閉じうる唯一のツール**も、預けていない窓では届かない。
      // ここを通すと、預けていない窓のタブが片づけられる。
      {
        id: "two-win-idle-arrange",
        tool: "arrange_editors",
        args: { action: "close-own" },
      } satisfies WireRequest,
    ]) {
      const response = await callExtension(beta.socketPath, beta.authToken, request);
      assert.strictEqual(response.ok, false, `${request.tool} が預けていない窓で通った`);
      if (response.ok) continue;
      assert.strictEqual(response.error.code, "disabled", `${request.tool} の拒否の符号が違う`);
      assert.strictEqual(
        response.error.message,
        WINDOW_OFF_MESSAGE,
        `${request.tool} の拒否の文言が違う`,
      );
    }

    await sleep(SETTLE_MS);
    const after = await askBeta<BetaSnapshot>({ op: "snapshot" });
    assert.deepStrictEqual(
      after.visibleEditors,
      before.visibleEditors,
      "預けていない窓の可視エディタが動いた",
    );
    assert.deepStrictEqual(
      visibleEditorSnapshot(),
      alphaBefore,
      "隣の窓（測る側）に開いた。要求は届いた窓の外へ出てはならない",
    );
  });

  /**
   * 直前の検査に判別力があることの証拠。
   *
   * 「動かなかった」は、動くはずのない要求を投げても成り立つ。**同じ要求**を
   * **同じ窓**に、預けられた状態で投げて、可視エディタが動くことを見る。
   * ここが落ちるなら、直前の検査は何も確かめていない。
   */
  test("対照: 同じ要求を、同じ窓が預けられている状態で投げると可視エディタが動く", async () => {
    await askBeta<{ role: string }>({ op: "set-role", role: "stage" });

    const read = readBothWindows();
    const beta = entryOf(read, betaWindowId);
    const before = await askBeta<BetaSnapshot>({ op: "snapshot" });
    assert.strictEqual(
      mentionsSample(before.visibleEditors),
      false,
      "対照の出発点で既に sample.ts が開いている",
    );

    const response = await callExtension(
      beta.socketPath,
      beta.authToken,
      showSampleRequest("two-win-stage-show"),
    );
    assert.strictEqual(response.ok, true, "預けた窓で show_code が通らなかった");

    await waitForBeta(
      "預けた窓に sample.ts が開く",
      (s) => mentionsSample(s.visibleEditors ?? []),
      SETTLE_MS * 4,
    );

    // 後片付け。次に走るものが「両方 stage」の状態を引き継がないようにする。
    await askBeta<{ role: string }>({ op: "set-role", role: "idle" });
  });

  /**
   * **`windowFocused` の導出を実機で判別する**（設計書 §3.1 条件1）。
   *
   * この判定（`window.state.focused`）は `editor-surface.ts` にあり、そこは
   * `vscode` を値 import するので単体テストからは読み込めない。レビュアが
   * `windowFocused` を `true` に潰しても 613+50件がすべて緑のままだった（実測）。
   *
   * **単一の窓では判別できない。** 窓が1つしかない実行では、その窓は常に前面に
   * あるので `false` になる状態を作れない ―― 潰しても同じ値が出る。2窓の実行では
   * 測る側（alpha）の窓が後から開いた窓に前面を譲るので（実測:
   * alpha.focused=false / beta.focused=true）、ここでだけ本物の `false` が測れる。
   *
   * だから前提そのものを2つとも assert する。前面がどちらにも無い（API が
   * 壊れている・ヘッドレスの都合で両方 false）ときに、この検査が
   * 「防御が効いた」と読めないようにする。
   */
  test("前面に無い窓では、人間が選んでも選択テキストは返らない（not-focused）", async () => {
    await lendWindow();

    const beta = await askBeta<BetaSnapshot>({ op: "snapshot" });
    assert.strictEqual(
      vscode.window.state.focused,
      false,
      "測る側の窓が前面にある。この検査の前提（前面に無い窓）が作れていない",
    );
    assert.strictEqual(
      beta.windowFocused,
      true,
      "どちらの窓も前面に無い。`window.state.focused` が常に false なら、この検査は何も判別していない",
    );

    // 人間がこの窓でファイルを開いて選ぶ。**フォーカスごと**開く（エージェントの
    // 経路は通らない）。使うのは他のどのテストも触らないファイルで、前のテストが
    // 返した範囲と一致して `already-returned` に化けないようにする。
    const uri = vscode.Uri.joinPath(workspaceRoot(), NOT_FOCUSED_REL);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: false,
    });
    const index = editor.document.getText().indexOf(NOT_FOCUSED_MARKER);
    assert.ok(index >= 0, `フィクスチャに ${NOT_FOCUSED_MARKER} が無い`);
    editor.selection = new vscode.Selection(
      editor.document.positionAt(index),
      editor.document.positionAt(index + NOT_FOCUSED_MARKER.length),
    );

    // 自ツール呼び出しの待ちを明ける。明けないと `too-soon-after-tool` が先に
    // 当たり、`windowFocused` を潰しても同じ結果になって判別しない。
    await sleep(1_500);

    const state = await getEditorState();
    // 呼び出し自体は成立していること（＝断られたのは選択テキストだけ）。
    assert.strictEqual(state.activePath, NOT_FOCUSED_REL, "人間が開いたファイルが返っていない");
    assert.strictEqual(
      state.selectedText,
      undefined,
      `前面に無い窓で選択テキストが返った: ${String(state.selectedText)}`,
    );
    assert.strictEqual(state.selectionWithheld, "not-focused");
  });

  test("預けた窓に投げた要求は、その窓のエディタを開く", async () => {
    await lendWindow();
    await askBeta<{ role: string }>({ op: "set-role", role: "idle" });

    const read = readBothWindows();
    const alpha = entryOf(read, alphaWindowId);
    const response = await callExtension(
      alpha.socketPath,
      alpha.authToken,
      showSampleRequest("two-win-alpha-show"),
    );
    assert.strictEqual(response.ok, true, "預けた窓で show_code が通らなかった");

    // 舞台の URI はこの窓の設定で決まる（D84: 既定は映し）。
    const staged = await stageUri(SAMPLE_REL);
    await waitFor("測る側に sample.ts が開く", () => visibleEditorFor(staged) !== undefined);
  });
});
