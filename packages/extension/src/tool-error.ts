import type { WireErrorCode } from "@zvx/vscode-showme-protocol";

/**
 * ハンドラが「判っている失敗」を名前つきで返すための型。
 *
 * ハンドラの失敗手段が throw しかないと、`dispatch` は一律 `internal` を返す
 * ことしかできない。**停止スイッチを押しただけの利用者に「内部エラー」が
 * 見える**のはただの嘘で、エージェント側も再試行の可否を判断できない。
 *
 * `message` は人間とエージェントの両方が読む。エージェント由来の文字列を
 * そのまま入れないこと（拒否メッセージ経由の注入になる）。
 *
 * **`server.ts` ではなくここに置く。** ハンドラがこの型を投げる必要があり、
 * ハンドラから `server.ts`（ソケット・ファイルシステム・暗号）を読み込ませると、
 * 判定だけを単体で確かめたいファイルに実行環境がぶら下がる。`server.ts` は
 * ここから読んで、同じ名前で再輸出する（定義元は1つのまま）。
 */
export class ToolError extends Error {
  constructor(
    readonly code: WireErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ToolError";
  }
}
