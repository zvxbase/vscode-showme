import * as assert from "node:assert";
import * as vscode from "vscode";
import { activateExtension } from "./helpers.js";

/**
 * 増分2C の前提測定（計画書 Task 0）。
 *
 * 2C の設計（設計書 §4）は、実機で一度も確かめていない事実の上に立っている ――
 * `srcdoc` の iframe が `frame-src` の対象になるか、`webrtc 'block'` が実装されて
 * いるか、`openTextDocument({content})` の `isDirty` の初期値は何か。
 * **推定のまま実装に入らない。**
 *
 * この節を消さずに残してあるのは、ここで測った事実が**回帰しうる**からである:
 * Chromium が上がれば `webrtc 'block'` の可否は変わりうるし、VS Code が上がれば
 * `isDirty` の初期値は変わりうる。
 * 設計がそこに乗っている以上、変わったことは黙って通ってはいけない。
 *
 * **観測の作法。** webview の中で起きたことは、外からは読めない。だから
 * 「我々のスクリプトが外側フレームで動き、内側フレームからの `postMessage` を
 * 中継し、`acquireVsCodeApi().postMessage` で拡張ホストへ返す」経路を作って測る。
 * 内側が黙っていることは**それ自体が答えではない**（読み込みが落ちたのか、
 * 読み込まれてスクリプトだけ落ちたのかが判別しない）ので、外側は `load` の発火・
 * `contentWindow.location` への到達可否・CSP 違反イベントも一緒に返す。
 */

/** 外側フレームのスクリプトに付ける nonce。内側の script タグにも同じ値を書く。 */
const NONCE = "showme2cprobe0123";

/** CSP の共通部分。frame-src と webrtc だけを問ごとに差し替える。 */
const CSP_BASE = [
  "default-src 'none'",
  `script-src 'nonce-${NONCE}'`,
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join("; ");

interface ProbeMessage {
  readonly tag: string;
  readonly data: Record<string, unknown>;
  readonly outerViolations: Record<string, unknown>[];
}

/** 外側フレームに渡す指示。内側の HTML は**拡張ホストで組んで postMessage で渡す**。 */
interface FrameOrder {
  readonly kind: "frame";
  readonly id: string;
  /** `null` なら sandbox 属性を付けない。`""` なら全制限。 */
  readonly sandbox: string | null;
  readonly html: string;
  readonly settleMs: number;
}

/**
 * 外側 webview の HTML。
 *
 * **問ごとに変わるのは CSP だけ**で、スクリプトは固定である。問ごとのふるまいは
 * すべて内側の HTML 側に置き、それは `postMessage` で渡す ―― 拡張ホストが
 * 内側の HTML を外側の HTML に埋め込むと、`</script`" の並びを避ける小細工が
 * 要るうえ、その小細工自体が測定結果を汚す。
 */
function outerHtml(csp: string): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>ShowMe 2C probe</title>
</head>
<body>
<script nonce="${NONCE}">
"use strict";
const vscodeApi = acquireVsCodeApi();
const violations = [];
document.addEventListener("securitypolicyviolation", function (e) {
  violations.push({
    directive: String(e.violatedDirective),
    effective: String(e.effectiveDirective),
    blocked: String(e.blockedURI),
    disposition: String(e.disposition),
  });
});
function post(tag, data) {
  vscodeApi.postMessage({ tag: tag, data: data, outerViolations: violations.slice() });
}
window.addEventListener("message", function (e) {
  const d = e.data;
  if (!d || typeof d !== "object") return;
  if (d.__from === "inner") {
    post(String(d.tag), d.data);
    return;
  }
  if (d.kind !== "frame") return;
  const f = document.createElement("iframe");
  if (d.sandbox !== null) f.setAttribute("sandbox", d.sandbox);
  f.style.width = "800px";
  f.style.height = "600px";
  f.style.border = "0";
  let loadFired = false;
  f.addEventListener("load", function () { loadFired = true; });
  document.body.appendChild(f);
  f.srcdoc = d.html;
  setTimeout(function () {
    let reach;
    try {
      reach = String(f.contentWindow.location.href);
    } catch (err) {
      reach = "(到達不可: " + String(err && err.name) + ")";
    }
    post("frame-verdict", {
      id: d.id,
      loadFired: loadFired,
      contentWindowHref: reach,
      sandboxAttr: String(f.getAttribute("sandbox")),
    });
  }, d.settleMs);
});
post("ready", { href: String(location.href), origin: String(location.origin) });
</script>
</body>
</html>`;
}

/**
 * webview を1枚立てて、`stop` が真を返すまでメッセージを集める。
 *
 * **必ず時間で切る。** 読み込みが落ちた場合、内側は永遠に黙る ―― 待ち続けると
 * 「測れなかった」ではなく「suite が固まった」になる。
 */
async function collectFromWebview(opts: {
  readonly label: string;
  readonly csp: string;
  readonly orders: readonly FrameOrder[];
  readonly stop: (messages: readonly ProbeMessage[]) => boolean;
  readonly timeoutMs: number;
}): Promise<ProbeMessage[]> {
  const panel = vscode.window.createWebviewPanel(
    "showme.probe.2c",
    `ShowMe 2C probe (${opts.label})`,
    // 人間の列を奪わない（不変条件10）。測定でも同じ作法にしておく。
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true },
  );
  const messages: ProbeMessage[] = [];
  try {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, opts.timeoutMs);
      const sub = panel.webview.onDidReceiveMessage((raw: unknown) => {
        // 受け口を先に張ってから html を入れる（下）。逆にすると `ready` を取り逃す。
        const m = raw as ProbeMessage;
        messages.push(m);
        if (m.tag === "ready") {
          for (const order of opts.orders) void panel.webview.postMessage(order);
          return;
        }
        if (opts.stop(messages)) {
          clearTimeout(timer);
          sub.dispose();
          resolve();
        }
      });
      panel.webview.html = outerHtml(opts.csp);
    });
  } finally {
    panel.dispose();
  }
  console.log(`[測定/2C] ${opts.label}\n${JSON.stringify(messages, null, 2)}`);
  // **測定器が動いたことを先に確かめる。** 外側が黙っているとき、内側の沈黙は
  // 「フレームが落ちた」ではなく「そもそも何も走っていない」である。ここを
  // assert しないと、harness の不具合が CSP の測定結果として読める。
  assert.ok(
    messages.some((m) => m.tag === "ready"),
    `外側フレームが ready を返さなかった（測定器が動いていない）: ${opts.label}`,
  );
  return messages;
}

function find(messages: readonly ProbeMessage[], tag: string): ProbeMessage | undefined {
  return messages.find((m) => m.tag === tag);
}

/**
 * 内側フレーム（`srcdoc`）の HTML。
 *
 * 3つのことを同時に測る:
 *
 *   1. nonce 付きの script が動くか（＝親の CSP が nonce ごと継承されるか）
 *   2. nonce 無しの script が落ちるか（1 の**判別器**。両方動くなら CSP は継承されていない）
 *   3. この中から `src` 付きの孫 iframe を作れるか（＝継承した `frame-src` は
 *      **URL を読む**フレームには効くのか）。`srcdoc` 自身が `frame-src` の
 *      対象外だったとして、それは「`frame-src` が無意味」を意味しない。
 *      両者を分けて測らないと、外側の CSP に何を書くべきかが決まらない
 */
function frameSrcProbeHtml(id: string): string {
  return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8"></head><body>
<script nonce="${NONCE}">
const v = [];
document.addEventListener("securitypolicyviolation", function (e) {
  v.push({ effective: String(e.effectiveDirective), blocked: String(e.blockedURI) });
});
parent.postMessage({ __from: "inner", tag: "inner-ran", data: {
  id: ${JSON.stringify(id)},
  origin: String(location.origin),
  href: String(location.href),
  hasAcquire: typeof acquireVsCodeApi
} }, "*");
(function () {
  const made = {};
  for (const spec of [["data", "data:text/html,<p>x"], ["https", "https://127.0.0.1:9/showme-probe"]]) {
    try {
      const g = document.createElement("iframe");
      g.src = spec[1];
      document.body.appendChild(g);
      made[spec[0]] = "追加した";
    } catch (e) {
      made[spec[0]] = "例外: " + String(e && e.name);
    }
  }
  setTimeout(function () {
    parent.postMessage({ __from: "inner", tag: "grandchild", data: {
      id: ${JSON.stringify(id)},
      appended: made,
      innerViolations: v.slice(),
    } }, "*");
  }, 900);
})();
</script>
<script>
parent.postMessage({ __from: "inner", tag: "inner-ran-unnonced", data: { id: ${JSON.stringify(id)} } }, "*");
</script>
</body></html>`;
}

/** WebRTC を実際に作ろうとする内側フレーム。 */
function webrtcProbeHtml(id: string): string {
  return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8"></head><body>
<script nonce="${NONCE}">
(async function () {
  const v = [];
  document.addEventListener("securitypolicyviolation", function (e) {
    v.push({ directive: String(e.violatedDirective), blocked: String(e.blockedURI) });
  });
  const out = { id: ${JSON.stringify(id)}, ctorType: typeof RTCPeerConnection };
  try {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:127.0.0.1:19302" }] });
    out.constructed = true;
    out.iceGatheringState = String(pc.iceGatheringState);
    const candidates = [];
    pc.addEventListener("icecandidate", function (ev) {
      if (ev.candidate) candidates.push(String(ev.candidate.candidate).slice(0, 90));
    });
    try {
      pc.createDataChannel("probe");
      const offer = await pc.createOffer();
      const sdp = String(offer && offer.sdp);
      out.offerCreated = true;
      out.sdpHasIceUfrag = sdp.indexOf("ice-ufrag") >= 0;
      out.sdpHasCandidate = sdp.indexOf("a=candidate") >= 0;
      // **ここまでは「API が生きている」だけである。** ICE の収集まで進むかどうかが
      // 「実際にソケットを開けるか」の側の答えになる。
      await pc.setLocalDescription(offer);
      await new Promise(function (r) { setTimeout(r, 2500); });
      out.iceGatheringStateAfter = String(pc.iceGatheringState);
      out.candidateCount = candidates.length;
      out.candidates = candidates.slice(0, 6);
    } catch (e2) {
      out.offerCreated = false;
      out.offerError = String(e2 && (e2.name + ": " + e2.message));
    }
    pc.close();
  } catch (e1) {
    out.constructed = false;
    out.ctorError = String(e1 && (e1.name + ": " + e1.message));
  }
  await new Promise(function (r) { setTimeout(r, 300); });
  out.innerViolations = v;
  parent.postMessage({ __from: "inner", tag: "webrtc", data: out }, "*");
})();
</script>
</body></html>`;
}

suite("実 VS Code / 増分2C の前提測定", () => {
  suiteSetup(async () => {
    await activateExtension();
  });

  test("[測定] 走らせている Electron / Chromium / VS Code の版", () => {
    console.log(
      [
        "[測定/2C] 版",
        `  vscode.version:   ${vscode.version}`,
        `  process.versions: ${JSON.stringify(process.versions)}`,
        `  isTrusted:        ${String(vscode.workspace.isTrusted)}`,
      ].join("\n"),
    );
    // 版が読めないと、この節の答えがどの版のものかが分からなくなる。
    assert.strictEqual(typeof process.versions.chrome, "string", "Chromium の版が読めない");
    assert.strictEqual(typeof process.versions.electron, "string", "Electron の版が読めない");
  });

  /**
   * 問1・問2: `show_note`（設計書 §4.3）が乗っている2つの量。
   *
   * §4.3 は「人間が書き足していたら上書きしない（`isDirty` かつ最後の書き込み以降に
   * 変更があれば新しいドキュメントに逃がす）」と書いている。`isDirty` が
   * **常に true** なら、この判定は毎回発火してメモが無制限に増える。
   */
  test("[測定] 問1/問2 名前なしドキュメントの isDirty と version", async () => {
    const timeline: Record<string, unknown>[] = [];
    const snap = (at: string, doc: vscode.TextDocument) => {
      timeline.push({
        at,
        isDirty: doc.isDirty,
        isUntitled: doc.isUntitled,
        version: doc.version,
        uri: doc.uri.toString(),
        length: doc.getText().length,
      });
    };

    const doc = await vscode.workspace.openTextDocument({
      content: "# メモ\n\n最初の内容\n",
      language: "markdown",
    });
    snap("openTextDocument 直後", doc);

    await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
    snap("showTextDocument 直後", doc);

    // 人間の編集に相当するもの（WorkspaceEdit）。
    const insert = new vscode.WorkspaceEdit();
    insert.insert(doc.uri, new vscode.Position(doc.lineCount - 1, 0), "人間が書き足した行\n");
    assert.strictEqual(await vscode.workspace.applyEdit(insert), true, "WorkspaceEdit が通らない");
    snap("WorkspaceEdit で1行足した後", doc);

    // エージェントによる全文差し替えに相当するもの。
    const replace = new vscode.WorkspaceEdit();
    replace.replace(
      doc.uri,
      new vscode.Range(new vscode.Position(0, 0), doc.lineAt(doc.lineCount - 1).range.end),
      "# メモ\n\n差し替えた内容\n",
    );
    assert.strictEqual(await vscode.workspace.applyEdit(replace), true, "全文差し替えが通らない");
    snap("全文差し替えの後", doc);

    // 差し替えが**内容を変えない**ときにも version が動くか（冪等な書き直しの検出）。
    const same = new vscode.WorkspaceEdit();
    same.replace(
      doc.uri,
      new vscode.Range(new vscode.Position(0, 0), doc.lineAt(doc.lineCount - 1).range.end),
      "# メモ\n\n差し替えた内容\n",
    );
    assert.strictEqual(await vscode.workspace.applyEdit(same), true, "同内容の差し替えが通らない");
    snap("同じ内容で差し替えた後", doc);

    console.log(`[測定/2C] isDirty / version\n${JSON.stringify(timeline, null, 2)}`);

    const first = timeline[0];
    assert.ok(first, "測定が成立していない");
    // ここが「答え」である。回帰したら設計（§4.3）を読み直すこと。
    assert.strictEqual(
      first.isDirty,
      true,
      "openTextDocument({content}) の isDirty が true でなくなった。§4.3 の判定を読み直すこと",
    );
    assert.strictEqual(first.version, 1, "名前なしドキュメントの version の初期値が 1 でない");
    const versions = timeline.map((t) => Number(t.version));
    assert.ok(
      versions[2] !== undefined && versions[1] !== undefined && versions[2] > versions[1],
      "編集で version が増えない（§4.3 の代替判定が成立しない）",
    );
  });

  /**
   * 問3: `srcdoc` の iframe は外側の `frame-src` の対象か。
   *
   * 4通りの CSP で同じ内側フレームを立てる。内側は nonce 付きの script と
   * nonce 無しの script の**両方**を持つ ―― 前者が動いて後者が黙れば
   * 「`srcdoc` は親の CSP を継承する（nonce ごと）」の証拠になり、
   * 両方黙れば「フレームごと落ちた」の側である。判別は外側の
   * `frame-verdict`（`load` の発火・CSP 違反）で行う。
   */
  test("[測定] 問3 srcdoc の iframe と frame-src", async function () {
    this.timeout(60_000);
    const cases: readonly { readonly id: string; readonly frameSrc: string | null }[] = [
      { id: "none", frameSrc: "frame-src 'none'" },
      { id: "self", frameSrc: "frame-src 'self'" },
      { id: "data", frameSrc: "frame-src data:" },
      { id: "absent", frameSrc: null },
    ];
    const summary: Record<string, unknown>[] = [];
    for (const c of cases) {
      const csp = c.frameSrc === null ? CSP_BASE : `${CSP_BASE}; ${c.frameSrc}`;
      const messages = await collectFromWebview({
        label: `frame-src/${c.id}`,
        csp,
        orders: [
          {
            kind: "frame",
            id: c.id,
            sandbox: "allow-scripts",
            html: frameSrcProbeHtml(c.id),
            settleMs: 2_000,
          },
        ],
        stop: (ms) =>
          find(ms, "frame-verdict") !== undefined && find(ms, "grandchild") !== undefined,
        timeoutMs: 15_000,
      });
      const verdict = find(messages, "frame-verdict");
      const grandchild = find(messages, "grandchild");
      summary.push({
        csp: c.frameSrc ?? "(frame-src 無し / default-src 'none')",
        innerNoncedScriptRan: find(messages, "inner-ran") !== undefined,
        innerUnnoncedScriptRan: find(messages, "inner-ran-unnonced") !== undefined,
        innerOrigin: find(messages, "inner-ran")?.data?.origin ?? "(返らず)",
        innerSeesAcquireVsCodeApi: find(messages, "inner-ran")?.data?.hasAcquire ?? "(返らず)",
        loadFired: verdict?.data?.loadFired ?? "(判定が返らず)",
        contentWindowHref: verdict?.data?.contentWindowHref ?? "(判定が返らず)",
        // 孫フレーム（`src` 付き＝ URL を読むフレーム）が、継承した CSP で落ちるか。
        grandchildViolations: grandchild?.data?.innerViolations ?? "(判定が返らず)",
        outerViolations: verdict?.outerViolations ?? [],
      });
    }
    console.log(`[測定/2C] 問3 frame-src と srcdoc\n${JSON.stringify(summary, null, 2)}`);

    // 測定が成立していること（4件とも外側の判定が返っていること）。
    assert.strictEqual(summary.length, 4, "4通りすべてを測れていない");
    for (const row of summary) {
      assert.notStrictEqual(
        row.loadFired,
        "(判定が返らず)",
        `外側の判定が返らなかった: ${String(row.csp)}`,
      );
    }
  });

  /**
   * 問4: `webrtc 'block'` は実装されているか。
   *
   * **対照が要る。** `webrtc 'block'` を付けた回だけを見て「作れなかった」と
   * 読むと、不透明オリジンの sandbox フレームで WebRTC がそもそも使えない場合と
   * 同じ観測値になる。付けない回を同じ形で測って、**違いが出るか**で判定する。
   */
  test("[測定] 問4 webrtc 'block' が honored か（対照付き）", async function () {
    this.timeout(60_000);
    const rows: Record<string, unknown>[] = [];
    for (const c of [
      { id: "with-block", csp: `${CSP_BASE}; frame-src 'self'; webrtc 'block'` },
      { id: "control", csp: `${CSP_BASE}; frame-src 'self'` },
    ]) {
      const messages = await collectFromWebview({
        label: `webrtc/${c.id}`,
        csp: c.csp,
        orders: [
          {
            kind: "frame",
            id: c.id,
            sandbox: "allow-scripts",
            html: webrtcProbeHtml(c.id),
            settleMs: 3_000,
          },
        ],
        stop: (ms) => find(ms, "webrtc") !== undefined && find(ms, "frame-verdict") !== undefined,
        timeoutMs: 20_000,
      });
      const w = find(messages, "webrtc");
      rows.push({
        id: c.id,
        csp: c.csp,
        answered: w !== undefined,
        ...(w?.data ?? {}),
        outerViolations: find(messages, "frame-verdict")?.outerViolations ?? [],
      });
    }
    console.log(`[測定/2C] 問4 webrtc 'block'\n${JSON.stringify(rows, null, 2)}`);

    const blocked = rows.find((r) => r.id === "with-block");
    const control = rows.find((r) => r.id === "control");
    assert.ok(blocked && control, "対照が揃っていない");
    assert.strictEqual(blocked.answered, true, "webrtc 'block' の回から答えが返らなかった");
    assert.strictEqual(control.answered, true, "対照の回から答えが返らなかった");
    // ここは**主張しない**。実装されていないなら実装されていないことが答えであり、
    // その場合は設計側で別の層を用意する（§4.1）。値は上の JSON に出ている。
  });
});
