import * as assert from "node:assert";
import * as http from "node:http";
import * as net from "node:net";
import * as vscode from "vscode";
import { type EgressReceiver, startEgressReceiver } from "./egress-receiver.js";
import { activateExtension, lendWindow } from "./helpers.js";

/**
 * **2C の中核**: 図とメモの経路から外に出ないことを、実際に測る（設計書 §4.4）。
 *
 * ## 観測点と入力の与え方
 *
 * 設計レビューの指摘そのままに組んである:
 *
 * > 攻撃入力は「スクリプトが動くフレーム」に届く形で与えること。`sandbox=""` の
 * > 表示フレームに `location.href` や WebRTC を食わせても、**そこにはスクリプトが
 * > 無いので全部が自明に通る**。それは「検査器が入力を読んでいない緑」である。
 *
 * - マークアップ由来の攻撃は `show_html` として与える
 * - スクリプト由来の攻撃は**判別確認で弱くした webview** に与える ―― 本番の表示面には
 *   そもそもスクリプトが動く場所が無いので、そこへ食わせても自明に通るだけである
 * - 観測点は**外側フレームの外**（拡張ホストで待ち受けるサーバ）
 * - 受信は **http と https の両方**で、TLS 握手に至らない裸の TCP 接続も数える
 *
 * ## 判別確認（これが無いと「ログが空」は何も言っていない）
 *
 * 「わざと壊したら届く」ことを確かめる。届かなければ、その検査は
 * **宛先に届きうることすら確かめていない**。増分2B はまさにそれで緑だった。
 *
 * ## 本番の2層を、実際に外して測った結果（2×2）
 *
 * `show_html` 経由の攻撃について、サニタイザと CSP を独立に外して回した:
 *
 * | サニタイザ | 外側の CSP | 結果 |
 * |---|---|---|
 * | 有 | 本番（`img-src data: <cspSource>` / `frame-src 'none'`） | **緑**（ゼロ） |
 * | **無** | 本番 | **緑** ―― CSP だけで止まる |
 * | 有 | **全開**（`img-src * http: https:` / `frame-src *`） | **緑** ―― サニタイザだけで止まる |
 * | 無 | 全開 | **赤** ―― 両方外すと届く |
 *
 * **どちらの層も単独で十分である。** これは `webrtc 'block'`（no-op で、層として
 * 数えてはいけないもの）とは違い、本物の多層防御である。
 *
 * この表を残すのは、次に「サニタイザは CSP があるから要らない」あるいは
 * 「CSP があるからサニタイザを緩めてよい」と考える人のためである。**要る** ――
 * ただし理由は「両方が同じものを止めているから」ではなく、
 * **CSP が管轄しない経路（`<link rel=dns-prefetch>` / `<meta http-equiv=refresh>`）が
 * あり、そこはサニタイザ（と `sandbox=""`）しか止めていない**からである。
 *
 * ## 測っていないこと
 *
 * **DNS そのものは測っていない。** 攻撃の宛先は 127.0.0.1 なので名前解決が起きず、
 * `dns-prefetch` / `preconnect` によるホスト名への情報の埋め込みは、この検査では
 * 観測できない。その経路について言えるのは「`<link>` 要素はサニタイザが要素ごと
 * 落とす」ことだけで、それは単体テスト（`sanitize-html.test.ts`）が文字列の水準で
 * 見ている。**ネットワークの水準では未測定である。**
 */

/** 描画と読み込みが落ち着くまでの待ち。届くものは届いてから数える。 */
const SETTLE_MS = 2_500;

function settle(ms = SETTLE_MS): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 受信サーバへ向けた攻撃の一覧。**http と https の両方を作る。** */
function attackUrls(receiver: EgressReceiver): { http: string; https: string } {
  return {
    http: `http://127.0.0.1:${receiver.httpPort}/leak`,
    https: `https://127.0.0.1:${receiver.httpsPort}/leak`,
  };
}

/** マークアップ由来の攻撃（`show_html` に食わせる）。 */
function markupAttacks(receiver: EgressReceiver): Array<{ label: string; html: string }> {
  const url = attackUrls(receiver);
  return [
    { label: "img http", html: `<img src="${url.http}">` },
    { label: "img https", html: `<img src="${url.https}">` },
    { label: "img srcset", html: `<img srcset="${url.http} 1x" src="${url.http}">` },
    {
      label: "meta refresh",
      html: `<meta http-equiv="refresh" content="0;url=${url.http}">`,
    },
    { label: "link dns-prefetch", html: `<link rel="dns-prefetch" href="${url.http}">` },
    { label: "link preconnect", html: `<link rel="preconnect" href="${url.https}">` },
    { label: "link prefetch", html: `<link rel="prefetch" href="${url.http}">` },
    { label: "link stylesheet", html: `<link rel="stylesheet" href="${url.http}/x.css">` },
    {
      label: "style @import",
      html: `<style>@import url("${url.http}/x.css");</style><p>a</p>`,
    },
    {
      label: "style background url",
      html: `<p style="background-image: url(${url.http}/bg.png)">a</p>`,
    },
    {
      label: "font-face src",
      html: `<style>@font-face { font-family: x; src: url("${url.http}/f.woff") }</style>`,
    },
    { label: "iframe src", html: `<iframe src="${url.http}/frame"></iframe>` },
    { label: "iframe srcdoc 孫", html: `<iframe srcdoc="&lt;img src=${url.http}&gt;"></iframe>` },
    { label: "object data", html: `<object data="${url.http}/o"></object>` },
    { label: "embed src", html: `<embed src="${url.http}/e">` },
    {
      label: "video/source",
      html: `<video src="${url.http}/v"><source src="${url.https}/s"></video>`,
    },
    { label: "audio", html: `<audio src="${url.http}/a"></audio>` },
    { label: "track", html: `<video><track src="${url.http}/t.vtt"></video>` },
    {
      label: "form 自動送信",
      html: `<form action="${url.http}/f" method="get"><input name="x"></form>`,
    },
    { label: "SVG a", html: `<svg><a href="${url.http}/a"><rect width="9" height="9"/></a></svg>` },
    { label: "SVG use", html: `<svg><use href="${url.http}/u.svg#x"/></svg>` },
    { label: "SVG image", html: `<svg><image href="${url.http}/i.png"/></svg>` },
    {
      label: "SVG image xlink",
      html: `<svg><image xlink:href="${url.https}/i.png"/></svg>`,
    },
    {
      label: "SVG foreignObject",
      html: `<svg><foreignObject><img src="${url.http}/fo.png"></foreignObject></svg>`,
    },
    { label: "base + 相対", html: `<base href="${url.http}/"><img src="x.png">` },
    // SVG の**表示属性**。値は CSS の値として解釈されるので、外部の塗りを指せる。
    // ここは一度素通しだった（CSS のエスケープ `\\28` ＝ `(` を見落としていた）。
    {
      label: "SVG fill url",
      html: `<svg><rect fill="url(${url.http}/paint)" width="9" height="9"/></svg>`,
    },
    {
      label: "SVG fill url（CSS エスケープ）",
      html: `<svg><rect fill="url\\28 ${url.http}/esc\\29" width="9" height="9"/></svg>`,
    },
    {
      label: "SVG stroke url",
      html: `<svg><rect stroke="url(${url.https}/stroke)" width="9" height="9"/></svg>`,
    },
    {
      label: "SVG clip-path url",
      html: `<svg><rect clip-path="url(${url.http}/clip)" width="9" height="9"/></svg>`,
    },
    {
      label: "SVG marker-end url",
      html: `<svg><path d="M0 0 L9 9" marker-end="url(${url.http}/marker)"/></svg>`,
    },
    {
      label: "style 属性の背景（CSS エスケープ）",
      html: `<p style="background-image: url\\28 ${url.http}/bgesc\\29">a</p>`,
    },
    // 増分3A で許可リストに足した略記。**広げた分は測る。**
    {
      label: "background 略記",
      html: `<p style="background: #fff url(${url.http}/bg) no-repeat">a</p>`,
    },
    {
      label: "list-style url",
      html: `<ul style="list-style: url(${url.http}/b.png)"><li>a</li></ul>`,
    },
    {
      label: "<style> の background 略記",
      html: `<style>p { background: url(${url.http}/s) }</style><p>a</p>`,
    },
    {
      label: "<style> の @font-face（CSS エスケープ）",
      html: `<style>@font-face { font-family: x; src: url\\28 ${url.http}/fesc\\29 }</style>`,
    },
    {
      label: "speculation rules",
      html: `<script type="speculationrules">{"prefetch":[{"urls":["${url.http}/sr"]}]}</script>`,
    },
    {
      label: "noscript の中身",
      html: `<noscript><img src="${url.http}/ns.png"></noscript>`,
    },
    { label: "template の中身", html: `<template><img src="${url.http}/tp.png"></template>` },
    { label: "script fetch", html: `<script>fetch(${JSON.stringify(url.http)})</script>` },
    { label: "onerror", html: `<img src="data:," onerror="fetch(${JSON.stringify(url.http)})">` },
  ];
}

/**
 * 回数制限を空にする。**攻撃を食わせる前に必ず呼ぶ。**
 *
 * 制限は 30 回/分だが、攻撃は 41 件ある。リセットしないと**後半がサニタイザに
 * 届く前に弾かれ**、それでも `feedHtml` は例外を飲むので検査は緑になる ――
 * 「検査器が入力を読んでいない緑」そのものである（実測でそうなっていた）。
 */
async function resetRateLimits(): Promise<void> {
  await vscode.commands.executeCommand("showme.test.resetRateLimits");
}

/** 攻撃を1つ食わせる。**落ちてよい**（例外はここで飲む） ―― 見たいのは egress である。 */
async function feedHtml(html: string): Promise<void> {
  try {
    await vscode.commands.executeCommand("showme.test.showHtml", { html });
  } catch {
    // スキーマや上限で弾かれるものがある。それはそれで「出て行かなかった」。
  }
}

function asNumberOrZero(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

/** 観測を読みやすい形にする（失敗したときに何が届いたかを見るため）。 */
function describeHits(receiver: EgressReceiver): string {
  return JSON.stringify(receiver.hits());
}

/**
 * 判別確認のために、**わざと弱くした** webview を1枚立てて中身を入れる。
 *
 * 本番の経路（`frames.ts`）は触らない。ここで立てるのは検査専用の使い捨てで、
 * 「本番と同じ入れ物に、同じ攻撃を、防御だけ外して入れたら届くか」を見る。
 */
async function probeWeakenedWebview(options: {
  displaySandbox: string;
  /** `{{NONCE}}` を書くと、継承される CSP の nonce に置き換わる。 */
  bodyHtml: string;
  cspFrameSrc: string;
}): Promise<vscode.WebviewPanel> {
  const panel = vscode.window.createWebviewPanel(
    "showme.egressProbe",
    "egress probe",
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    { enableScripts: true },
  );
  const nonce = "probe0123456789ab";
  // **ペイロードの `</script>` が外側の script を閉じる。** かつて本番側の作図フレーム
  // （`escapeScriptEnd`。増分4 で作図ツールごと消えた）で塞いだのと同じ欠陥を、
  // このプローブでも踏んだ ―― 判別確認2が「届かない」と言い続けた原因はこれで、
  // sandbox でも CSP でもなかった。
  // **判別器そのものが壊れていると、緑も赤も意味を持たない。**
  // 下の `.replace(/<\/(script)/gi, ...)` は**このプローブ自身の**塞ぎであり、
  // 本番側の関数が消えても要る（プローブは本番の経路を通らない）。
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    "img-src data: http: https:",
    "connect-src http: https:",
    `frame-src ${options.cspFrameSrc}`,
    "media-src data: http: https:",
  ].join("; ");
  panel.webview.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}"></head><body>
<iframe id="f" sandbox="${options.displaySandbox}"></iframe>
<script nonce="${nonce}">
  document.getElementById("f").srcdoc = ${JSON.stringify(
    options.bodyHtml.replaceAll("{{NONCE}}", nonce),
  ).replace(/<\/(script)/gi, "<\\/$1")};
</script></body></html>`;
  return panel;
}

suite("egress の実測（2C Task 6）", () => {
  let receiver: EgressReceiver;

  suiteSetup(async () => {
    await activateExtension();
    await lendWindow();
  });

  setup(async () => {
    receiver = await startEgressReceiver();
  });

  teardown(async () => {
    await receiver.close();
  });

  test("受信サーバ自体は届く（検査器が生きていることの確認）", async () => {
    // **これが無いと「ログが空」は何も言っていない。** 2B の失敗はここだった。
    const url = attackUrls(receiver);
    await new Promise<void>((resolve) => {
      const req = http.get(url.http, () => resolve());
      req.on("error", () => resolve());
    });
    await new Promise<void>((resolve) => {
      const socket = net.connect(receiver.httpsPort, "127.0.0.1", () => {
        socket.end();
        resolve();
      });
      socket.on("error", () => resolve());
    });
    await settle(300);

    const hits = receiver.hits();
    assert.ok(
      hits.some((h) => h.scheme === "http"),
      "http の受信が数えられていない（検査器が壊れている）",
    );
    assert.ok(
      hits.some((h) => h.scheme === "https"),
      "https 側の TCP 接続が数えられていない（検査器が壊れている）",
    );
  });

  test("陽性対照: show_html の中身が表示フレームに実際に届いている", async () => {
    await resetRateLimits();
    // **返り値だけでは足りない。** `shown: true` は「投げた」でも真になりうるので、
    // フレーム側の読み込み完了を観測する。ここが false のまま下の検査が緑なら、
    // それは「入れ物が無いから何も出なかった」である。
    const result = (await vscode.commands.executeCommand("showme.test.showHtml", {
      html: "<p>対照</p>",
    })) as { shown?: unknown };
    assert.strictEqual(result.shown, true);

    const state = (await vscode.commands.executeCommand("showme.test.panelState")) as {
      acknowledged?: unknown;
      length?: unknown;
    };
    assert.strictEqual(
      state.acknowledged,
      true,
      `表示フレームが読み込みを知らせてこない（検査が空振りしている）: ${JSON.stringify(state)}`,
    );
    assert.ok(asNumberOrZero(state.length) > 0, "届いた中身が空である");
  });

  /**
   * **手書き SVG の図が、実機の `show_html` を通って描ける**（設計 D50 / §6.2, §9）。
   *
   * 作図ツールを消した根拠は「SVG を直接書けば済む」である。その前提は
   * 単体（`sanitize-html.test.ts`）で測ってあるが、**単体はサニタイザしか通らない**
   * ―― 線のスキーマ・上限・パネルの受け渡しは通っていない。設計 §9 の完了条件は
   * ここを（統合）と書いているので、実機で1本通す。
   *
   * **陰性だけでは足りない。** この suite の他の SVG は「攻撃が落ちること」を
   * 見ているが、それは**全部落としても緑**である（増分2C の教訓）。
   * ここは良性の図が**落ちずに届く**ことを見る、良性側の対照である。
   */
  test("陽性対照: 手書き SVG の図が落とされずに実機で描ける（作図ツール削除の前提）", async () => {
    await resetRateLimits();
    const diagram = [
      "<h2>呼び出しの流れ</h2>",
      '<svg viewBox="0 0 400 120" width="400" height="120">',
      '  <defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5"',
      '    markerWidth="6" markerHeight="6" orient="auto-start-reverse">',
      '    <path d="M 0 0 L 10 5 L 0 10 z" fill="#555"/></marker></defs>',
      "  <style>.b { fill: #eef; stroke: #445; stroke-width: 1.5 }</style>",
      '  <rect class="b" x="20" y="30" width="140" height="48" rx="6"/>',
      '  <text x="90" y="60" text-anchor="middle" font-size="13">Agent</text>',
      '  <path d="M 170 54 L 236 54" stroke="#555" marker-end="url(#a)" fill="none"/>',
      '  <rect class="b" x="240" y="30" width="140" height="48" rx="6"/>',
      "</svg>",
    ].join("\n");

    const result = (await vscode.commands.executeCommand("showme.test.showHtml", {
      html: diagram,
    })) as { shown?: unknown; droppedDeclarations?: unknown };

    assert.strictEqual(result.shown, true, "図が出せなかった");
    // **1つも落ちないこと。** 落ちた宣言があるなら、図は出ても見た目が壊れている。
    assert.strictEqual(
      result.droppedDeclarations,
      0,
      `良性の図で CSS 宣言が落ちた: ${JSON.stringify(result)}`,
    );

    // 届いた中身が、図を落として `<h2>` だけになっていないことを長さで見る。
    // （中身そのものは返さない ―― 不変条件2。長さで足りる。）
    const state = (await vscode.commands.executeCommand("showme.test.panelState")) as {
      acknowledged?: unknown;
      length?: unknown;
    };
    assert.strictEqual(state.acknowledged, true, "表示フレームに届いていない");
    assert.ok(
      asNumberOrZero(state.length) > diagram.length / 2,
      `届いた中身が図の半分未満しかない（大半が落ちている）: ${JSON.stringify(state)}`,
    );
  });

  test("show_html 経由の攻撃で egress がゼロ", async () => {
    let fed = 0;
    for (const attack of markupAttacks(receiver)) {
      // **1件ごとに予算を戻す。** まとめて食わせると後半が制限で弾かれ、
      // サニタイザに届かないまま「落ちた」と読むことになる。
      await resetRateLimits();
      await feedHtml(attack.html);
      fed += 1;
    }
    // 食わせた件数を数える。**0 件でも「egress ゼロ」は真になってしまう。**
    assert.strictEqual(fed, markupAttacks(receiver).length);
    assert.ok(fed > 35, `攻撃の件数が減っている: ${fed}`);
    await settle();
    assert.deepStrictEqual(
      receiver.hits(),
      [],
      `show_html 経由で外に出た: ${describeHits(receiver)}`,
    );
  });

  test("判別確認1: サニタイザを通さなければ同じ攻撃が届く", async () => {
    // **同じ入れ物・同じ攻撃・防御だけ外す。** これが緑のままなら、
    // 上の2件は「宛先に届きうること」すら確かめていない。
    const url = attackUrls(receiver);
    const panel = await probeWeakenedWebview({
      displaySandbox: "",
      cspFrameSrc: "'none'",
      bodyHtml: `<img src="${url.http}/unsanitized">`,
    });
    await settle();
    panel.dispose();

    assert.ok(
      receiver.hits().length > 0,
      "サニタイザを外しても届かなかった。この検査は何も測っていない",
    );
  });

  /**
   * 表示フレームは**二重に守られている**（この検査を書いていて分かった）。
   *
   * 最初の版は `allow-scripts` を足しただけで nonce を付けない script を入れており、
   * **届かなかった**。理由は sandbox ではなく CSP である ―― `srcdoc` は親の CSP を
   * **nonce ごと**継承するので（2C Task 0 の実測）、nonce の無いインライン script は
   * `allow-scripts` があっても動かない。
   *
   * つまり本番の表示フレームを破るには、`allow-scripts` を足すことに加えて
   * **nonce を漏らすか CSP を緩めるか**しなければならない。ここでは判別確認として
   * 「両方を破ったら届く」ことを見る ―― 届かなければ、この検査は
   * 宛先に届きうることすら確かめていない。
   */
  test("判別確認2: allow-scripts と nonce の両方を与えるとスクリプト由来の攻撃が届く", async () => {
    const url = attackUrls(receiver);
    const panel = await probeWeakenedWebview({
      displaySandbox: "allow-scripts",
      cspFrameSrc: "'none'",
      // **`fetch` は使わない。** webview の `connect-src` はワークベンチ側の CSP と
      // 交差するので、`fetch` が落ちても「sandbox が効いた」とは言えない
      // （実際、最初の版はそれで赤くなった ―― 交絡である）。
      // 判別確認1で**届くと分かっている経路**（画像）をスクリプトから叩き、
      // 変数を「スクリプトが動くかどうか」だけに絞る。
      bodyHtml: `<script nonce="{{NONCE}}">new Image().src = ${JSON.stringify(`${url.http}/scripted`)};</script>`,
    });
    await settle();
    panel.dispose();

    assert.ok(
      receiver.hits().length > 0,
      "allow-scripts と nonce を与えてもスクリプト由来の攻撃が届かなかった。この検査は何も測っていない",
    );
  });

  test("判別確認2の対照: allow-scripts だけでは届かない（CSP の nonce が二重目の層）", async () => {
    // 上の検査の nonce を外した版。**これが届かないことが、二重目の層の証拠である。**
    // 本番の表示フレームは `allow-scripts` すら無いので、層は2枚とも立っている。
    const url = attackUrls(receiver);
    const panel = await probeWeakenedWebview({
      displaySandbox: "allow-scripts",
      cspFrameSrc: "'none'",
      bodyHtml: `<script>new Image().src = ${JSON.stringify(`${url.http}/no-nonce`)};</script>`,
    });
    await settle();
    panel.dispose();

    assert.deepStrictEqual(
      receiver.hits(),
      [],
      `nonce の無いインライン script が動いた: ${describeHits(receiver)}`,
    );
  });

  test("判別確認3: 孫フレームを許すと src 付きのフレームが届く", async () => {
    // 本番は `frame-src 'none'`。ここを緩めると `src` 付きの孫フレームが通る
    // ことを見る（2C Task 0 で「srcdoc は対象外・src には効く」と測ってある）。
    const url = attackUrls(receiver);
    const panel = await probeWeakenedWebview({
      displaySandbox: "",
      cspFrameSrc: "http: https:",
      bodyHtml: `<iframe src="${url.http}/grandchild"></iframe>`,
    });
    await settle();
    panel.dispose();

    assert.ok(
      receiver.hits().length > 0,
      "frame-src を緩めても孫フレームが届かなかった。この検査は何も測っていない",
    );
  });
});
