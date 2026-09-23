import * as path from "node:path";
import type { FoundLocation, Location } from "@zvx/vscode-showme-protocol";
import * as vscode from "vscode";
import type { AnchorResolution, LanguageSurface } from "./handlers/find-locations.js";
import { probeUntilNonEmpty } from "./symbol-lookup.js";
import { acceptWorkspacePath } from "./workspace-path-gate.js";

/**
 * 言語プロバイダに聞く面。**`vscode` の値に触るのはここだけ**（判断は `language-lookup.ts`）。
 *
 * VS Code が組み込みで持つコマンドを叩く。`executeDocumentSymbolProvider`（増分1で
 * 既に使っている）と同じ仕組みの兄弟で、実在は VS Code 1.137.0 の本体で確認済み。
 *
 * ## 「引けなかった」と「引けて0件」を分ける
 *
 * VS Code はどちらも曖昧に返しうる。ここで正規化して、
 * **`undefined` = 引けなかった / `[]` = 引けて0件**にしてから判断層に渡す。
 * `not-found`（＝その名前は無い）は**一覧が取れたときにしか名乗れない**（設計書 §3.4）。
 */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createLanguageSurface(
  workspaceRoot: vscode.Uri | undefined,
  extraRedactedPatterns: () => readonly string[],
): LanguageSurface {
  const toRelative = (uri: vscode.Uri): string | undefined => {
    if (workspaceRoot === undefined) return undefined;
    // **ワークスペースの外は返さない。** 言語サーバは node_modules や
    // TypeScript の lib.d.ts を平気で返してくる ―― それは「見せる」対象ではないし、
    // 相対パスとして表現できない。
    //
    // **文字列比較だけでは足りない。** ワークスペースの中に外を指すシンボリック
    // リンクがあると、論理パスは中に見えて実体は外になる。この repo は
    // 不変条件14 の1件目でまさにそれを踏んでいる（「除外判定は生の文字列、
    // 読み出しは realpath 後」）。実体まで辿ってから判定する。
    // **入力側とまったく同じ関門を通す。** 以前はここだけ
    // `canonicalizeWorkspacePath` を直に呼んでいて、除外判定は呼び出し側が
    // 別に当てていた ―― 同じ量を2箇所で決めていた形である（不変条件14）。
    if (uri.scheme !== "file") return undefined;
    const rel = path.relative(workspaceRoot.fsPath, uri.fsPath);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
    const accepted = acceptPath(rel.split(path.sep).join("/"));
    return accepted.ok ? accepted.canonical : undefined;
  };

  const toFound = (items: unknown): readonly FoundLocation[] | undefined => {
    if (!Array.isArray(items)) return undefined;
    const out: FoundLocation[] = [];
    for (const item of items) {
      // `Location` と `LocationLink` の両方が返りうる（プロバイダによる）。
      const record = item as {
        uri?: vscode.Uri;
        range?: vscode.Range;
        targetUri?: vscode.Uri;
        targetRange?: vscode.Range;
        targetSelectionRange?: vscode.Range;
      };
      const uri = record.uri ?? record.targetUri;
      const range = record.targetSelectionRange ?? record.targetRange ?? record.range;
      if (uri === undefined || range === undefined) continue;
      const rel = toRelative(uri);
      if (rel === undefined) continue;
      out.push({ path: rel, line: range.start.line + 1, column: range.start.character });
    }
    return out;
  };

  /**
   * エージェントが指定したパスを、**実体まで辿って**受け入れるか決める。
   *
   * ## ここが唯一の関門である
   *
   * 一度は呼び出し側（ハンドラ）で `normalizeWorkspaceRelative` を当てる形にしたが、
   * それは**作法**であって構造ではなかった。しかも綴りしか見ていないので、
   * **ワークスペースの中に置かれた、外を指すシンボリックリンク**を通してしまった:
   *
   * ```
   * docs/innocent.txt -> /etc/passwd     名前に `..` は無く、除外パターンにも当たらない
   * ```
   *
   * そのうえ `text` の走査は**中身の部分一致**を答えるので、これは存在の
   * オラクルより強い ―― **外のファイルの内容を1文字列ずつ確かめられた**。
   *
   * 止められるのは realpath を取る側だけである。この repo は不変条件14 の
   * 1件目でまさに同じことを踏んでいて、`canonicalizeWorkspacePath` はそのために
   * 書かれた関数である。**同じファイルの出力側（`toRelative`）では使っていたのに、
   * 入力側で使っていなかった。**
   *
   * ## 除外は綴りではなく実体で見る
   *
   * `docs/harmless.txt -> .env` は、綴りでは除外に当たらない。
   * **正準化した名前**に対して当てる。
   */
  /** パスの判断は共通の関門に任せる（`workspace-path-gate.ts`）。**ここで書き直さない。** */
  const acceptPath = (rawPath: string) =>
    acceptWorkspacePath(workspaceRoot?.fsPath, rawPath, extraRedactedPatterns());

  /**
   * 開く先の `Uri`。**正準名をルートに再結合せず、解決済みの実体パスを使う。**
   *
   * 再結合すると、その綴りにあるリンクを**もう一度辿る**ことになる ―― 判定した
   * 実体と開く実体がずれる窓が残る（判定と読み出しの間にリンクを差し替えられる）。
   * 出荷済みの `read-workspace-file.ts` は最初からこうしていて、
   * 「判定した文字列と実際に触る実体を一致させる」と書いてある。**揃える。**
   */
  const uriFor = (accepted: { realPath: string }): vscode.Uri => vscode.Uri.file(accepted.realPath);

  const openAt = async (anchor: { path: string; line: number; column: number }) => {
    if (workspaceRoot === undefined) return undefined;
    // アンカーは `resolveAnchor` が正準化済みの名前で作る。**それでももう一度通す**
    // ―― 同じ関数なので判断は割れないし、将来ここに別の入口ができても塞がる。
    const accepted = acceptPath(anchor.path);
    if (!accepted.ok) return undefined;
    const uri = uriFor(accepted);
    const position = new vscode.Position(Math.max(0, anchor.line - 1), Math.max(0, anchor.column));
    return { uri, position };
  };

  return {
    isTrusted: () => vscode.workspace.isTrusted,

    async resolveAnchor(location: Location): Promise<AnchorResolution> {
      // **何をするより先に、実体まで辿って受け入れるか決める。**
      const accepted = acceptPath(location.path);
      if (!accepted.ok) return { ok: false, reason: accepted.reason };
      if (workspaceRoot === undefined) return { ok: false, reason: "invalid-path" };

      // 行の指定がいちばん素直。`text` は開いてから探す。
      if (location.lines !== undefined) {
        return {
          ok: true,
          anchor: { path: accepted.canonical, line: location.lines.start, column: 0 },
        };
      }
      const uri = uriFor(accepted);
      let document: vscode.TextDocument;
      try {
        document = await vscode.workspace.openTextDocument(uri);
      } catch {
        return { ok: false, reason: "not-found" };
      }
      const needle = location.text ?? location.symbol;
      if (needle === undefined) return { ok: false, reason: "not-found" };
      const occurrence = location.occurrence ?? 1;
      let seen = 0;
      for (let line = 0; line < document.lineCount; line++) {
        const column = document.lineAt(line).text.indexOf(needle);
        if (column < 0) continue;
        seen += 1;
        if (seen === occurrence) {
          // **識別子の途中を指す。** 先頭だと、直前の記号を拾うプロバイダがある。
          return {
            ok: true,
            anchor: { path: accepted.canonical, line: line + 1, column: column + 1 },
          };
        }
      }
      return { ok: false, reason: "not-found" };
    },

    async definitions(anchor) {
      const at = await openAt(anchor);
      if (at === undefined) return undefined;
      // **空で返ったら時間を与えて引き直す。** 再読み込み直後の1回目は、tsserver が
      // プロジェクトを読む前で、登録済みのプロバイダが空で応答する（実地で観測。
      // シンボル一覧で既に測っていた挙動と同じ）。輪は `probeUntilNonEmpty` と共有する。
      return probeUntilNonEmpty(async () => {
        try {
          const raw = await vscode.commands.executeCommand(
            "vscode.executeDefinitionProvider",
            at.uri,
            at.position,
          );
          return toFound(raw);
        } catch {
          return undefined;
        }
      }, sleep);
    },

    async references(anchor, includeDeclaration) {
      const at = await openAt(anchor);
      if (at === undefined) return undefined;
      return probeUntilNonEmpty(async () => {
        try {
          const raw = await vscode.commands.executeCommand(
            "vscode.executeReferenceProvider",
            at.uri,
            at.position,
            { includeDeclaration },
          );
          return toFound(raw);
        } catch {
          return undefined;
        }
      }, sleep);
    },
  };
}
