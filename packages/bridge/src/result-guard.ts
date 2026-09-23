import { RESULT_SCHEMAS, type ToolName, truncateDisplayText } from "@zvx/vscode-showme-protocol";
import type { z } from "zod";

/**
 * 拡張が返した結果が、そのツールの結果スキーマに合わなかった。
 *
 * **結果は捨てる。** 「たぶん大丈夫だから通す」をしない。この検証こそが
 * 「どのツールもファイルの中身を返さない」の実体で、
 * 通してしまえば不変条件は文書上のものになる。
 */
export class ResultRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResultRejectedError";
  }
}

/**
 * 拡張から受け取った結果を、呼んだツールの結果スキーマに当ててから返す。
 *
 * 要求側は全階層 `strict()` なのに、応答は `z.record(z.unknown())` で
 * 素通りしていた（実測: 10万文字の `fileContents` を含む応答が通る）。
 * 信頼境界はブリッジではなくソケットなので、**拡張が何を返しても**
 * エージェントへ手渡す手前で落とす必要がある。
 *
 * ツール名で引いて当てる。和で当てるより強い ―― 「show_code の呼び出しに
 * list_workspaces の形の結果が返る」という取り違えまで落ちる。
 */
export function parseToolResult(tool: ToolName, result: unknown): Record<string, unknown> {
  const schema: z.ZodTypeAny | undefined = RESULT_SCHEMAS[tool];
  if (schema === undefined) {
    // 型の上では起きないが、ツールを増やして表に足し忘れたときに
    // 「無検証で素通り」ではなく「拒否」に倒す。
    throw new ResultRejectedError(`No result schema is defined for ${tool}`);
  }

  const parsed = schema.safeParse(result);
  if (!parsed.success) {
    // 上限は組み立ての最後にもう一度当てる。ツール名は閉じた語彙だが、
    // 「どこで切るか」を1か所に決めておかないと、前置きを足すたびに上限が
    // 名目だけのものになる。
    throw new ResultRejectedError(
      truncate(
        `The result of ${tool} does not match its result schema: ${summarize(parsed.error)}`,
        MAX_REJECTION_MESSAGE_CHARS,
      ),
    );
  }
  return parsed.data as Record<string, unknown>;
}

/**
 * 未知の鍵の名前として出してよい長さ。
 *
 * **鍵の名前も攻撃者が決める。** 値は引かない設計なのに名前が無制限だと、
 * 関所そのものが任意長のテキスト経路になる（実測: 88,041 字の鍵名が
 * `ResultRejectedError.message` を経由してエージェントに届いた）。線上の
 * `error.message` は `MAX_ERROR_MESSAGE_CHARS` で塞いであるのに、拒否の
 * 理由を組み立てるこちら側だけが開いていた。
 */
export const MAX_UNKNOWN_KEY_CHARS = 64;

/** 1件あたりに出す未知の鍵の数。 */
const MAX_UNKNOWN_KEYS_SHOWN = 5;

/**
 * 拒否理由の全長。
 *
 * 鍵1本ずつを短くしても、鍵の**数**で溢れる（`unrecognized_keys` は1つの
 * issue に鍵をいくつでも積める）。最後にもう一度、全体にも上限を当てる。
 */
export const MAX_REJECTION_MESSAGE_CHARS = 1000;

/**
 * 文字列を切り詰める。サロゲートペアの内側では切らない。
 *
 * **実装は `protocol` の `truncateDisplayText` である**。
 * 以前はここに写しがあった ―― 同じ境界計算が3箇所（ここ、`log.ts`、`status-bar.ts`）
 * にあり、コメント自身が「同じ理由・同じ直し方」と書いていた。写しがあるということは、
 * 直すときに片方だけ直る道があるということである。
 *
 * ここは**エスケープしない**。拒否理由に載るのは既にスキーマ検証を通った値で、
 * 切る理由は長さだけである。
 */
const truncate = truncateDisplayText;

/**
 * 失敗の理由を、**受け取った値を持ち出さずに**言う。
 *
 * zod の `error.message` は受け取った値を含めうる。落とした理由を説明する
 * ために漏らしてはいけないものを引用したら、検問所そのものが漏洩経路になる。
 * 場所（パス）と種類、未知だった鍵の名前だけを出す。**名前にも長さと本数の
 * 上限を置く**（名前は攻撃者が決める）。
 */
function summarize(error: z.ZodError): string {
  const parts = error.issues.slice(0, 5).map((issue) => {
    // path も受け取った値由来の要素（オブジェクトの鍵）を含みうる。同じ上限を当てる。
    const where =
      issue.path.length > 0
        ? issue.path.map((p) => truncate(String(p), MAX_UNKNOWN_KEY_CHARS)).join(".")
        : "(top level)";
    if (issue.code === "unrecognized_keys") {
      const shown = issue.keys
        .slice(0, MAX_UNKNOWN_KEYS_SHOWN)
        .map((k) => truncate(k, MAX_UNKNOWN_KEY_CHARS))
        .join(", ");
      const rest =
        issue.keys.length > MAX_UNKNOWN_KEYS_SHOWN
          ? ` and ${issue.keys.length - MAX_UNKNOWN_KEYS_SHOWN} more`
          : "";
      return `${where}: unknown keys ${shown}${rest}`;
    }
    return `${where}: ${issue.code}`;
  });
  const more =
    error.issues.length > parts.length ? ` and ${error.issues.length - parts.length} more` : "";
  return truncate(`${parts.join(" / ")}${more}`, MAX_REJECTION_MESSAGE_CHARS);
}
