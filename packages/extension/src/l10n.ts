import type * as vscodeTypes from "vscode";

/**
 * 人間向けの文字列の唯一の入口（設計 D58 / §B5）。
 *
 * **鍵は英語の原文である**（VS Code の l10n の規約）。`l10n/bundle.l10n.ja.json` が
 * 原文→日本語を持ち、VS Code の表示言語が `ja` なら差し替わる。鍵が無ければ
 * VS Code は黙って原文を返すので、鍵の一致は `no-japanese-in-source.test.ts` が
 * 検査する（片方だけにある鍵が無いこと）。
 *
 * エージェント向けの文字列はここを通さない。ブリッジは VS Code の外の素の node で
 * `vscode.l10n` が無いし、LLM 向けは英語が最も安定する。
 */

/**
 * "vscode" モジュールを遅延取得する（`config.ts` と同じ理由）。
 *
 * `status-bar.ts` のように vscode を型でしか読まないモジュールは、表示文字列を
 * 組み立てる純関数を vitest で確かめている。トップレベルで value import すると
 * その読み込み自体が「Failed to load url vscode」で落ちる。読めなければ
 * `undefined` を返し、呼び手は原文（英語）で進む ―― 単体テストは英語を主張する。
 */
function getVSCode(): typeof vscodeTypes | undefined {
  try {
    return require("vscode") as typeof vscodeTypes;
  } catch {
    return undefined;
  }
}

/**
 * `{0}` `{1}` … を引数で埋める（`vscode.l10n.t` と同じ記法）。
 *
 * vscode が無いときの代替なので、記法は本物に合わせる。対応する引数が無い
 * プレースホルダはそのまま残す（本物も同じ）。
 */
export function format(message: string, args: readonly (string | number)[]): string {
  return message.replace(/\{(\d+)\}/g, (whole, index: string) => {
    const value = args[Number(index)];
    return value === undefined ? whole : String(value);
  });
}

/**
 * 人間向けの文字列。vscode が値として読めれば `vscode.l10n.t`、読めなければ
 * 原文に引数を埋めて返す。
 *
 * 第1引数は**リテラルで**書くこと。変数を渡すと `bundle.l10n.ja.json` の鍵の
 * 検査（ソースの第1引数を集める）から漏れ、翻訳が無いことに画面でしか気づけない。
 */
export function t(message: string, ...args: (string | number)[]): string {
  const vscode = getVSCode();
  if (vscode?.l10n !== undefined) return vscode.l10n.t(message, ...args);
  return format(message, args);
}

export type UiLanguage = "en" | "ja";

/**
 * 文書全体を言語ごとに書き分けるときの選択（`agent-config-doc.ts` / `teardown-doc.ts`）。
 *
 * `vscode.env.language` は `ja` のほか `ja-jp` のような綴りもありうるので先頭で見る。
 * 対応していない言語はすべて英語（既定）。**言語を決めるのはここ1箇所**
 * （不変条件14。`t()` は VS Code が同じ `env.language` で束を選ぶ）。
 */
export function uiLanguage(): UiLanguage {
  const language = getVSCode()?.env.language ?? "en";
  return language.toLowerCase().startsWith("ja") ? "ja" : "en";
}
