import { sanitizeDisplayText } from "@zvx/vscode-showme-protocol";
import type * as vscode from "vscode";

/**
 * 拡張の出力チャネル。
 *
 * **無害化のロジックはここに書かない。** 記録するのはパスと検索文字列で、いずれも
 * エージェント（＝注入されうる相手）由来である。改行や ANSI を通すと監査ログの行を
 * 偽装できる（設計書 §5.4）が、その判定は `protocol` の `sanitizeDisplayText` に
 * 一本化してある。ここに条件を1つでも書き足すと、
 * ステータスバーと comment thread の経路が置き去りになる。
 *
 * 選択テキストは、そもそもログに渡さないこと。
 */
export class ShowMeLog {
  constructor(private readonly channel: vscode.OutputChannel) {}

  info(message: string, fields: Record<string, string> = {}): void {
    const parts = Object.entries(fields).map(([k, v]) => `${k}=${sanitizeDisplayText(v)}`);
    this.channel.appendLine(
      `[${new Date().toISOString()}] ${sanitizeDisplayText(message)}${parts.length > 0 ? ` ${parts.join(" ")}` : ""}`,
    );
  }

  show(): void {
    this.channel.show(true);
  }
}
