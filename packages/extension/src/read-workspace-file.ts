import * as fs from "node:fs";
import { MAX_RESOLVE_BYTES } from "@zvx/vscode-showme-protocol";
import { acceptWorkspacePath } from "./workspace-path-gate.js";

/**
 * ワークスペース内のファイルだけを読む（設計書 §4.1 ⑤）。
 *
 * vscode に依存させない（受け取るのはルートのファイルシステムパスだけ）。
 * ここが「判定した文字列」と「実際に読む実体」がずれる唯一の場所なので、
 * 実ファイルシステム上のシンボリックリンクで検査できることに価値がある。
 *
 * **関門を通して読む。** 受け入れるかどうかの判断（綴り・正準化・脱出・秘匿）は
 * `workspace-path-gate.ts` の `acceptWorkspacePath` が持つ。ここはその判定が
 * 返した**実体**（`realPath`）を読むだけで、判断を持たない。
 *
 * 以前はここに「正準化 → 正準名への除外判定」を自前で並べていた。それ自体は
 * 正しかったが、同じ境界を関門と別々に書いていた（不変条件14 ―― 書くたびに
 * 1段ずつ抜ける形。関門にだけ「綴りへの除外判定」が無く、秘匿ファイルの存在の
 * オラクルになっていた）。**ここで書き直さない。**
 *
 * 正準名をルートに再結合せず、判定した実体をそのまま開く。再結合はその綴りの
 * リンクをもう一度辿るので、判定と開く対象がずれる。
 */
export function readWorkspaceFile(
  rootPath: string,
  rel: string,
  redactedPatterns: readonly string[],
): string | undefined {
  const verdict = acceptWorkspacePath(rootPath, rel, redactedPatterns);
  if (!verdict.ok) return undefined;

  try {
    const stat = fs.statSync(verdict.realPath);
    if (!stat.isFile()) return undefined;
    // 上限は protocol が宣言する（2プロセスが共有する契約なので定義元は1つ）。
    if (stat.size > MAX_RESOLVE_BYTES) return undefined;
    return fs.readFileSync(verdict.realPath, "utf8");
  } catch {
    // 読めない理由をここから外へ出さない。呼び出し側は「読めなかった」だけを見る。
    return undefined;
  }
}
