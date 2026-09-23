import { DISPLAY_FRAME_SANDBOX } from "@zvx/vscode-showme-protocol";
import { t, uiLanguage } from "../l10n.js";

/**
 * webview の2枚構成を組み立てる（設計書 §4.1）。**`vscode` に値としては依存しない**
 * （`l10n.ts` が遅延 require する。無ければ英語）。
 *
 * ```
 * 外側 webview（我々の chrome。acquireVsCodeApi を持つ）
 *  └─ 表示フレーム   sandbox=""（スクリプト無し）
 * ```
 *
 * ## エージェント由来の文字列は、この層の HTML に一度も入らない
 *
 * 素朴には「サニタイズ済みの HTML を `srcdoc="…"` に埋めた文字列を作る」となるが、
 * **そうしない**。埋める以上は属性値としての脱出（`"` の扱い）が正しいことに依存し、
 * それは「サニタイザが正しい」の上にもう1つ「組み立てが正しい」を積むことになる。
 *
 * 代わりに、外側の HTML は**完全に静的**にして、中身は実行時に
 * `frame.srcdoc = 受け取った文字列` と**プロパティ代入**で渡す。属性の構文を通らないので、
 * 脱出の問題そのものが存在しない。
 *
 * ## `frame-src 'none'` である理由（2C Task 0 の実測）
 *
 * `srcdoc` のフレームは `frame-src` の対象外なので、`'none'` でも表示フレームは動く。
 * 一方 `src` 付きの孫フレームは `'none'` で落ちる。以前の `frame-src 'self' data:` は
 * 我々に何も与えないまま `data:` の孫フレームを1つ開けていた。
 *
 * ## `webrtc 'block'` は層として数えない（同じく実測）
 *
 * この Chromium では no-op である。**指令は将来のために残すが、防御として数えない。**
 * 実際に egress を止めているのは、表示フレームで**そもそもスクリプトが動かない**こと
 * （`sandbox=""`）と外側の CSP である（設計書 §4.2.1）。
 */

/** 表示フレームの `sandbox`。決定元は `protocol`（無害化の解析モードもここから導出される）。 */
export { DISPLAY_FRAME_SANDBOX };

/** 外側と内側をつなぐメッセージ。**外側の外には出ない。** */
export const FRAME_MESSAGE = {
  /** 拡張 → 外側: 表示フレームに入れる HTML */
  display: "showme:display",
  /**
   * 外側 → 拡張: 表示フレームが**実際に読み込み終えた**。
   *
   * これが無いと `show_html` の `shown: true` は「メッセージを投げた」しか
   * 意味せず、フレームが立っていなくても真になる。検査の側から見ると
   * **空振りでも緑になる**（実際、egress の検査を組んでいてそれに気づいた）。
   */
  displayed: "showme:displayed",
  /**
   * 拡張 → 外側: 表示フレームに**いま何文字入っているか**を問う（統合テスト専用）。
   *
   * `displayed` は「最後に投げたものが届いた」という**出来事**の記録なので、
   * その後に webview が隠れて DOM ごと捨てられても残る。**いま入っているもの**を
   * 見る口は別に要る。
   */
  measure: "showme:measure",
  /** 外側 → 拡張: その答え（長さだけ。中身は返さない）。 */
  measured: "showme:measured",
} as const;

/**
 * 外側の CSP。
 *
 * `default-src 'none'` から始めて、要るものだけを足す。**`connect-src 'none'` は
 * fetch/XHR/WebSocket を塞ぐが、WebRTC は塞がない**（実測。§4.2.1）。
 */
export function buildOuterCsp(cspSource: string, nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'unsafe-inline' ${cspSource}`,
    `img-src data: ${cspSource}`,
    `font-src ${cspSource}`,
    "connect-src 'none'",
    // `srcdoc` は対象外（実測）。ここで塞いでいるのは `src` 付きの孫フレームである。
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "media-src data:",
    // この Chromium では no-op（実測）。**層として数えない。** 将来の実装への予約と、
    // 「入れ忘れ」と「入れたが効かない」を後から区別するために残す。
    "webrtc 'block'",
  ].join("; ");
}

/**
 * 表示フレームに入れる文書を組む。**我々の baseline を前置してから**中身を置く。
 *
 * ## なぜ要るか（実地で踏んだ）
 *
 * エージェントが `<style>body{background:#fbfbfa;color:#1c1b1a}</style>` という
 * **ごく普通の**書き方をしたところ、`background` が許可リストに無くて落ち、
 * `color` だけが残った。表示フレームの地は `transparent` なので、エディタの
 * ダークな地に `#1c1b1a` の文字が乗って**読めなかった**
 * 。
 *
 * 許可リストは広げた（`sanitize-css.ts`）が、それだけでは
 * **配色を書かなかったエージェント**が救われない。両方要る。
 *
 * ## `var(--vscode-…)` を使わない理由
 *
 * VS Code のテーマ変数を使えばテーマに追随できるが、`var()` は
 * **別の場所で定義された値を持ち込める**ので検査の外に出る ―― `sanitize-css.ts` が
 * 意図的に禁止している（設計 D32）。代わりに CSS のシステム色
 * （`Canvas` / `CanvasText`）を使う。`color-scheme` に追随するので、
 * テーマ変数を通さずに同じことができる。
 *
 * ## 前置するのは我々のリテラルだけ
 *
 * 引数はここに差し込まない。サニタイズ済みの HTML は**後ろ**に置くので、
 * エージェントが配色を指定したらそちらが勝つ（後から来るので自然にそうなる）。
 */
export function buildDisplayDocument(sanitizedHtml: string): string {
  return `<!doctype html><meta charset="utf-8"><style>
:root { color-scheme: light dark; }
html, body { margin: 0; padding: 8px 10px; }
body {
  background-color: Canvas;
  color: CanvasText;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 13px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
h1, h2, h3, h4 { line-height: 1.3; margin: 0.8em 0 0.4em; }
p, ul, ol, table, pre { margin: 0.5em 0; }
table { border-collapse: collapse; }
th, td { border: 1px solid; border-color: color-mix(in srgb, CanvasText 30%, transparent); padding: 3px 7px; text-align: left; }
th { background-color: color-mix(in srgb, CanvasText 8%, transparent); }
pre, code, kbd, samp { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
code { background-color: color-mix(in srgb, CanvasText 8%, transparent); padding: 0 3px; border-radius: 3px; }
pre { overflow-x: auto; padding: 6px 8px; background-color: color-mix(in srgb, CanvasText 6%, transparent); border-radius: 4px; }
pre code { background: none; padding: 0; }
blockquote { margin: 0.5em 0; padding-left: 10px; border-left: 3px solid; border-color: color-mix(in srgb, CanvasText 25%, transparent); }
hr { border: 0; border-top: 1px solid; border-color: color-mix(in srgb, CanvasText 25%, transparent); }
img, svg { max-width: 100%; height: auto; }
</style>
${sanitizedHtml}`;
}

/**
 * 外側の HTML。**静的である**（nonce と CSP 以外にどんな値も入らない）。
 *
 * 帯（「この内容はエージェントが生成しました」）は**外側が描く**。エージェントは
 * 外枠を描けないので、これが本物である保証になる。スクロールしても消えない位置に置く。
 *
 * 帯と iframe の `title` は人間向けなので `t()` を通る（D58）。`lang` は同じ
 * `uiLanguage()` から出す ―― 帯の言語と食い違わせない。
 *
 * **テンプレートの中のスクリプトのコメントは英語で書く。** テンプレートの中は
 * 文字列リテラルなので、日本語を書くと `no-japanese-in-source.test.ts` が
 * 「翻訳漏れ」として拾う（コメントとリテラルを区別できない）。説明はここに置く:
 *
 * - 拡張から来るメッセージは信頼する（webview の親は VS Code 本体）
 * - **表示フレームからは何も受け取らない。** 今はスクリプトが無くて送れないが、
 *   将来の変更で穴が開かないよう最初から区別する
 * - `display` は読み込み終わってから受領を知らせる。`srcdoc` の代入は load を起こす
 * - `srcdoc` は**プロパティ代入**。属性の構文を通らない
 * - `measure` は統合テスト専用。覚えている値ではなく、生きているフレームの
 *   `srcdoc` そのものを読む ―― 「出した」ではなく「残っている」を見るための口。
 *   中身は返さない
 */
export function buildOuterHtml(cspSource: string, nonce: string): string {
  const csp = buildOuterCsp(cspSource, nonce);
  return `<!doctype html>
<html lang="${uiLanguage()}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  :root { color-scheme: light dark; }
  html, body { margin: 0; padding: 0; height: 100%; }
  body { display: flex; flex-direction: column; font-family: var(--vscode-font-family); }
  #showme-banner {
    flex: 0 0 auto; padding: 4px 8px; font-size: 12px;
    background: var(--vscode-editorWidget-background);
    color: var(--vscode-editorWidget-foreground);
    border-bottom: 1px solid var(--vscode-editorWidget-border);
  }
  #showme-display { flex: 1 1 auto; width: 100%; border: 0; background: transparent; }
</style></head>
<body>
  <div id="showme-banner">🤖 ${t("This content was generated by an agent")}</div>
  <iframe id="showme-display" sandbox="${DISPLAY_FRAME_SANDBOX}" title="${t("ShowMe display")}"></iframe>
<script nonce="${nonce}">
(function () {
  var api = acquireVsCodeApi();
  var display = document.getElementById("showme-display");

  // Messages from the extension. The webview's parent is VS Code itself, so trust them.
  addEventListener("message", function (event) {
    var data = event.data;
    if (!data || typeof data.type !== "string") return;

    // Never accept anything from the display frame. It has no script today, but
    // keep the distinction from the start so a later change cannot open a hole.
    if (event.source !== null && event.source === display.contentWindow) return;

    if (data.type === ${JSON.stringify(FRAME_MESSAGE.display)}) {
      var html = String(data.html);
      // Acknowledge after the load; assigning srcdoc fires load.
      display.onload = function () {
        api.postMessage({ type: ${JSON.stringify(FRAME_MESSAGE.displayed)}, length: html.length });
      };
      // Property assignment: it never goes through attribute syntax.
      display.srcdoc = html;
      return;
    }

    // Measure what is in the display frame right now (integration tests only).
    // Read the live frame's srcdoc, not a remembered value: "still there", not
    // "was sent". The content itself is never returned.
    if (data.type === ${JSON.stringify(FRAME_MESSAGE.measure)}) {
      var current = document.getElementById("showme-display");
      var length = current && current.srcdoc ? current.srcdoc.length : 0;
      api.postMessage({ type: ${JSON.stringify(FRAME_MESSAGE.measured)}, length: length });
      return;
    }
  });
})();
</script></body></html>`;
}
