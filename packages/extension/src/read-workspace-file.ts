import * as fs from "node:fs";
import { MAX_RESOLVE_BYTES } from "@zvx/vscode-showme-protocol";
import { readAcceptedOutsideFile } from "./stage-mirror.js";
import {
  type RedactionPolicy,
  type WorkspacePathVerdict,
  acceptWorkspacePath,
  insideOnly,
} from "./workspace-path-gate.js";

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
  redaction: RedactionPolicy,
): string | undefined {
  // **ワークスペースの中だけ**（`show_html` の `path` の口）。設定 `showme.allowOutsideWorkspace` が
  // オンでも外は読まない（外の HTML を描く口は作らない。D102 の対象外）。
  return readVerdict(insideOnly(acceptWorkspacePath(rootPath, rel, redaction)));
}

/**
 * エージェントが位置を指したファイルを読む（`show_code` / `annotate` の解決器の `readText`）。
 * 人間が設定をオンにしていれば、関門を通る**外の**ファイルも読む（D102）。外は関門が見た実体
 * （dev / ino）だけを開いて読む。**`show_html` などの他の口はこちらを使わない**（外を読ませない）。
 */
export function readAgentFile(
  rootPath: string,
  key: string,
  redaction: RedactionPolicy,
): string | undefined {
  return readVerdict(acceptWorkspacePath(rootPath, key, redaction));
}

/** 関門の答えから中身を読む（2つの口が共有する。読み方を2つに書かない）。 */
function readVerdict(verdict: WorkspacePathVerdict): string | undefined {
  if (!verdict.ok) return undefined;
  if (verdict.kind === "outside") return readAcceptedOutsideFile(verdict);

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
