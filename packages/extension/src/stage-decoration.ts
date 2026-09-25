import * as vscode from "vscode";
import { t } from "./l10n.js";
import { type StageUriParts, isAgentStageUri } from "./stage-uri-vscode.js";

/** エージェントのタブに付くバッジ（VS Code のバッジは2文字まで）。 */
export const AGENT_TAB_BADGE = "SM";

/** タブの名前の色。`package.json` の `contributes.colors` で既定を宣言し、テーマで変えられる。 */
export const AGENT_TAB_COLOR_ID = "showme.agentTabForeground";

export interface AgentTabDecoration {
  readonly badge: string;
  readonly tooltip: string;
  readonly colorId: string;
}

/**
 * その URI のタブに付ける印（設計 D89）。エージェントのタブでなければ undefined。
 *
 * **付けるかどうかは `isAgentStageUri` だけで決める**（不変条件14: 所有の `isOwnTab` と
 * 同じ述語）。設定（`agentTabs`）も記録も見ない ―― 所有がスキームで決まるのと同じく、
 * 設定を途中で切り替えても開いている映しのタブには印が残る。
 */
export function agentTabDecoration(uri: StageUriParts): AgentTabDecoration | undefined {
  if (!isAgentStageUri(uri)) return undefined;
  return {
    badge: AGENT_TAB_BADGE,
    tooltip: t("ShowMe: the agent's tab"),
    colorId: AGENT_TAB_COLOR_ID,
  };
}

/**
 * タブ（とエクスプローラ等、URI を表示する所）に印を返すプロバイダ。
 *
 * 印は URI の綴りだけで決まり、時間で変わらないので変更の知らせ
 * （`onDidChangeFileDecorations`）は持たない。`propagate: false`: 映しの URI は
 * フォルダの木に載らないので、親へ伝える意味が無い。
 *
 * 実測では、読み取り専用（`showme-ro`）のタブは鍵のアイコンがバッジより優先されて
 * バッジは出ず、色だけが付く。編集できる映し（`showme-rw`）には両方が付く。
 */
export class AgentTabDecorationProvider implements vscode.FileDecorationProvider {
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const d = agentTabDecoration(uri);
    if (d === undefined) return undefined;
    return {
      badge: d.badge,
      tooltip: d.tooltip,
      color: new vscode.ThemeColor(d.colorId),
      propagate: false,
    };
  }
}

/**
 * 印のプロバイダを1つ登録する。activate で1回呼ぶ。
 *
 * **窓を預けていなくても登録する**（映しの FS と同じ理由: 復元された映しのタブにも印を
 * 付ける）。返す `provider` は統合テストの口が同じインスタンスを呼ぶためのもの。
 */
export function registerAgentTabDecoration(): {
  provider: AgentTabDecorationProvider;
  disposable: vscode.Disposable;
} {
  const provider = new AgentTabDecorationProvider();
  return { provider, disposable: vscode.window.registerFileDecorationProvider(provider) };
}
