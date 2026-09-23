import { disabledToolsFor } from "@zvx/vscode-showme-protocol";
import * as vscode from "vscode";
import type { ShowMeConfig } from "../config.js";

/**
 * symbol 解決が実装されているか。増分 2B（Task 5）で
 * `executeDocumentSymbolProvider` を繋いだので true。
 *
 * 増分1ではここが false だった ―― provider を渡していないのに「使える」と
 * 伝えると、エージェントは毎回 `reason: "no-provider"` を受け取り、その往復が
 * レート制限の予算を食う。嘘のコストは実在する。
 *
 * 型注釈で boolean に広げてあるのは、定数式に畳まれて「常に true/false」と
 * 警告されるのを避けるため。
 */
const SYMBOL_RESOLUTION_IMPLEMENTED: boolean = true;

/**
 * この接続が束縛されているウィンドウの情報を返す。
 *
 * v1 は同一マシンの全ウィンドウの `workspacePath` と `windowTitle` を返していた。
 * これは `readOnlyHint: true`（自動承認の候補）のツールで、汚染されたウィンドウの
 * エージェントに**業務リポジトリの名前とディレクトリ構成を列挙させる**ことを意味する
 * （設計書 S9 / D18）。束縛されたウィンドウだけを返す。
 *
 * `windowTitle` は返さない（ファイル名・ブランチ名が入る）。
 *
 * ファイルの内容も、ワークスペース内のファイル一覧も返さない。
 */
export function handleListWorkspaces(config: ShowMeConfig): Record<string, unknown> {
  // 束縛先はサーバに渡しているのと同じ「最初のフォルダ」。多ルートでも
  // 残りは列挙しない（列挙はまさに S9 が塞いだ経路）。
  const bound = vscode.workspace.workspaceFolders?.[0];
  const trusted = vscode.workspace.isTrusted;

  return {
    // exactOptionalPropertyTypes 下でも Record<string, unknown> なので鍵は残るが、
    // JSON 化で undefined の鍵は落ちる（線上スキーマでも optional）。
    ...(bound === undefined
      ? {}
      : { boundWorkspace: { name: bound.name, path: bound.uri.fsPath } }),
    isTrusted: trusted,
    // 制限モードでの縮退を、エージェントが事前に知れるようにする
    // （設計書 §5.5 / A1）。
    //
    // **`symbolResolution` は保守的に倒してある（＝過小申告する）。** 制限
    // モードで実際に落ちる文書シンボルのプロバイダは TypeScript/JavaScript の
    // ものだけで、JSON や Markdown のシンボルは制限モードでも解決できる
    // （統合テストで実測）。それでもここは単一の boolean なので、言語ごとの
    // 崖を表現できない。false と言っておいて解決できるのは安全側だが、
    // **書かないと `symbolResolution: isTrusted` が「事実」として一人歩きする**
    // ので、この過小申告は `TOOL_DESCRIPTIONS.list_workspaces` にも書いてある。
    capabilities: {
      symbolResolution: SYMBOL_RESOLUTION_IMPLEMENTED && trusted,
      terminalEnvInjection: trusted && config.injectTerminalEnv,
    },
    // **エージェントの行動を制約する設定は、エージェントから読める**（D56 / C5）。
    // 「やってみて断られる」（`arrange_editors` の `withheld`、ゲートの `disabled`）は
    // 最後の砦であって、普段の知り方ではない。
    //
    // 値は `config`（`readConfig()` ＝ `pickTrustedValue` 経由）から**写すだけ**。
    // ここで新しい読み口を作らない ―― 作った瞬間、ワークスペース値を読む経路が
    // 1つ増える（不変条件9）。`arrange_editors` が可否を決めるのと同じ
    // `config.layout` を載せるので、申告と実際の判断がずれない（不変条件14）。
    permissions: {
      closeHumanTabs: config.layout.closeHumanTabs,
      closeDirtyTabs: config.layout.closeDirtyTabs,
    },
    // 3機能の `enabled`（増分6 D74）。`disabledTools` は**ここから導出**する（D75）。
    // 関門（`checkToolGate`）が同じ `FEATURE_OF_TOOL` で可否を決めるので、
    // 一覧と実際の判断がずれない（不変条件14）。
    features: config.features,
    disabledTools: disabledToolsFor(config.features),
    editorGroup: config.editorGroup,
    // `show_html` のパネルの上限（増分6.2 D80）。`config.html.maxPanels` を**写すだけ**
    // （2回目の読み口を作らない）。`handleShowHtml` が `slot` を断るのと同じ値なので、
    // 申告と実際の判断がずれない（不変条件14）。
    panels: { max: config.html.maxPanels },
    // このハンドラは他のウィンドウを**一度も**列挙しない。設定
    // `showme.listAllWorkspaces` は増分1では効かないので、設定値をそのまま
    // 返すと「他の窓も返した」という嘘になる。この鍵はこの応答の中身を
    // 述べるものなので、常に false を返す。
    otherWindowsListed: false,
  };
}
