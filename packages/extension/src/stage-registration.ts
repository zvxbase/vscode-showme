import * as vscode from "vscode";
import { relativizeToRoot } from "./editor-observation.js";
import { StageFileSystemProvider } from "./stage-fs-provider.js";
import { StageMirror } from "./stage-mirror.js";
import { STAGE_SCHEME_EDITABLE, STAGE_SCHEME_READONLY } from "./stage-uri.js";

/**
 * 映しの2つのスキームを登録し、変更の知らせを配線する（設計 D81）。activate で1回呼ぶ。
 *
 * **窓を預けていなくても登録する**（D81: 人間が既に開いている映しのタブを復元できる
 * ように）。中身を返すのは `StageMirror` の関門を通ったときだけなので、預けていない
 * 窓でも漏れない。映しを舞台として開くのは `show_code`（D84）で、ここは登録と知らせの配線だけ。
 *
 * **`showme.enabled` が false でも登録する**（意図どおり。D81 の復元のため）。読みは
 * 毎回関門を通り、エージェントがここへ届く経路は無い（映しは人間の画面に描くだけ）。
 *
 * 返す Disposable は呼び出し側の `disposables` に積む（確保と逆順に返る）。
 */
export function registerStageFileSystem(
  redactedPatterns: () => readonly string[],
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];
  // ルートは毎回読む（`StageMirror` の構築子の説明と同じ理由）。
  const rootUri = (): vscode.Uri | undefined => vscode.workspace.workspaceFolders?.[0]?.uri;
  const mirror = new StageMirror(() => rootUri()?.fsPath, redactedPatterns);

  /**
   * 人間の `file:` 文書 → ワークスペース相対パス。未保存の中身を引く側と、変更を
   * 知らせる側の**両方がこの1つを通る**（不変条件14: 「どの文書がその rel か」を
   * 2通りに決めない。片方を `Uri.joinPath` の文字列比較にすると、綴りの正規化が
   * 食い違ったときに「知らせたのに未保存が映らない」が起きる）。
   */
  const relOfHumanDocument = (uri: vscode.Uri): string | undefined =>
    uri.scheme === "file" ? relativizeToRoot(rootUri(), uri) : undefined;

  // 既知の制限: 一致は正規化した綴りの完全一致で見る。大文字小文字を区別しない
  // ファイルシステムで、映しの綴りと人間の文書の綴りが大小だけ違うと、未保存の中身では
  // なくディスクの中身が映る（関門は同じ実体として通す）。
  const unsavedText = (rel: string): string | undefined => {
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.isDirty && relOfHumanDocument(doc.uri) === rel) return doc.getText();
    }
    return undefined;
  };

  const ro = new StageFileSystemProvider(STAGE_SCHEME_READONLY, mirror, unsavedText);
  const rw = new StageFileSystemProvider(STAGE_SCHEME_EDITABLE, mirror, unsavedText);
  disposables.push(
    ro,
    rw,
    vscode.workspace.registerFileSystemProvider(STAGE_SCHEME_READONLY, ro, {
      isCaseSensitive: true,
      isReadonly: true,
    }),
    vscode.workspace.registerFileSystemProvider(STAGE_SCHEME_EDITABLE, rw, {
      isCaseSensitive: true,
    }),
  );

  // 人間の編集（未保存）は showme-ro にだけ映る。showme-rw の実体はディスクなので知らせない。
  // 既知の制限: 間引かない（打鍵1回につき ro への通知1回）。量はまだ測っていない ――
  // 間引くかどうかは、実際に使ったときの負荷を見てから決める（残っている課題）。
  const humanChanged = (uri: vscode.Uri): void => {
    const rel = relOfHumanDocument(uri);
    if (rel === undefined) return;
    mirror.bump();
    ro.notifyChanged(rel);
  };
  disposables.push(
    // 打鍵・revert（中身が戻る）・未保存の状態の変化はここに来る。
    vscode.workspace.onDidChangeTextDocument((e) => humanChanged(e.document.uri)),
    // 未保存のまま閉じた（捨てた）ときは中身の変化の事象が来ないので、ここで拾う。
    vscode.workspace.onDidCloseTextDocument((doc) => humanChanged(doc.uri)),
    // **最初から未保存で開いた文書**（窓の復元で hot exit の控えから戻る人間の file:）も
    // 中身の変化の事象を出さない。拡張は `onFileSystem:showme-ro` で、復元された映しの
    // タブに引かれて人間の文書の復元より**先に**起動しうる（起動の完了を待たない）ので、
    // 映しが先にディスクの中身を読んでいたら、ここで読み直させる。保存済みで開いた文書は
    // ディスクと同じ中身なので知らせない（開くたびに映しを読み直させない）。
    // **推論であって実測ではない**: hot exit の復元の順序を統合テストで再現できていないので、
    // 事象のモデル（未保存で開いた文書は onDidChangeTextDocument を出さない）から足してある。
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (doc.isDirty) humanChanged(doc.uri);
    }),
  );

  // ディスクの変更は両方に映る。**delete も change として流す** ―― 原子的保存
  // （temp に書いて rename）は見張りから delete → create に見える（webview/panel.ts の
  // watch() と同じ理由）。映しは読み直すだけで、読み直しは毎回関門を通る。
  const diskChanged = (uri: vscode.Uri): void => {
    const rel = relativizeToRoot(rootUri(), uri);
    if (rel === undefined) return;
    mirror.bump();
    ro.notifyChanged(rel);
    rw.notifyChanged(rel);
  };
  let watcher: vscode.FileSystemWatcher | undefined;
  // 見張っているルート（URI の文字列）。フォルダの増減でも先頭が変わらなければ張り直さない。
  let watchedRoot: string | undefined;
  const watchRoot = (): void => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const key = folder?.uri.toString();
    if (watcher !== undefined && key === watchedRoot) return;
    watcher?.dispose();
    watcher = undefined;
    watchedRoot = key;
    if (folder === undefined) return;
    watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, "**/*"));
    watcher.onDidChange(diskChanged);
    watcher.onDidCreate(diskChanged);
    watcher.onDidDelete(diskChanged);
  };
  watchRoot();
  disposables.push(
    // ルートが変われば見張りも張り直す（mirror はルートを毎回読むので、見張りだけが
    // 古いルートに残ると、新しいルートのディスクの変更が映しに届かない）。
    vscode.workspace.onDidChangeWorkspaceFolders(watchRoot),
    new vscode.Disposable(() => {
      watcher?.dispose();
      watcher = undefined;
    }),
  );
  return disposables;
}
