import * as vscode from "vscode";
import { t } from "./l10n.js";
import type { StageMirror } from "./stage-mirror.js";
import { relOfStageUri, stageMirrorUri } from "./stage-uri-vscode.js";
import { STAGE_SCHEME_READONLY, type StageScheme } from "./stage-uri.js";

/**
 * 映し（`showme-ro:` / `showme-rw:`）の FileSystemProvider（設計 D81）。
 *
 * ここは vscode の型と `StageMirror` の答えを繋ぐだけで、**判断を持たない**
 * （不変条件14）。URI → 相対パスは `relOfStagePath`、受け入れ（秘匿・脱出・正準化・
 * 実体の検査）は `StageMirror` の中の関門が唯一持つ。読み・stat・書きのすべてが
 * mirror を通り、ここからファイルシステムに直接触る口は無い。
 *
 * ## 失敗の形
 *
 * 関門や実体の検査で落ちたものは、理由を問わず `FileSystemError.FileNotFound(uri)`。
 * メッセージは呼び出し側が渡した URI の綴りだけで、理由（秘匿・脱出・不在）を含まない
 * 。`FileNotFound` 以外を返すのは、パスについて新しいことを
 * 語らない場合だけ（`StageMirror.write` の理由ごとの根拠を参照）。
 */
export class StageFileSystemProvider implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this.emitter.event;

  constructor(
    private readonly scheme: StageScheme,
    private readonly mirror: StageMirror,
    // 人間の file: 文書が未保存ならその中身。showme-ro だけが使う（showme-rw の実体はディスク）。
    private readonly unsavedText: (rel: string) => string | undefined,
  ) {}

  /**
   * その相対パスの映しが変わったと VS Code に知らせる（Changed）。
   *
   * **その映し（このスキーム・この rel）の文書が開いているときだけ知らせる。** 知らせる
   * 相手は読み直す文書だけで、開いていなければ知らせる意味が無い。絞る場所はここ1つ
   * （呼び出し側は条件を持たない）。絞らないと、映しを1つも開いていない窓でも人間の
   * 打鍵1回ごとに通知が走り、秘匿パス（開けないので決して開いていない）についても
   * 「showme-ro:/.env が変わった」を他の購読者へ流す。版（`mirror.bump()`）は呼び出し側で
   * 無条件に上げる ―― 後から開いた文書も新しい mtime を見る。
   * O(開いている文書の数)。
   */
  notifyChanged(rel: string): void {
    const open = vscode.workspace.textDocuments.some(
      (doc) => doc.uri.scheme === this.scheme && relOfStageUri(doc.uri) === rel,
    );
    if (!open) return;
    // URI を組むのは stageMirrorUri 1つ（stage-uri-vscode.ts。`stageUriFor` の映し側と
    // 同じ経路 ―― 不変条件14: 舞台の URI を組む場所を2つにしない）。
    const uri = stageMirrorUri(rel, this.scheme);
    this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  /**
   * 何もしない。変更は `notifyChanged` で出す ―― ディスクの見張りと人間の編集の
   * 購読は activate に1つずつあり、URI ごとに見張りを張るとその数だけ見張りが増える。
   */
  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const rel = this.relOf(uri);
    const result = this.mirror.stat(this.scheme, rel, this.unsavedFor(rel));
    if (!result.ok) throw vscode.FileSystemError.FileNotFound(uri);
    return {
      type: vscode.FileType.File,
      size: result.size,
      mtime: result.mtime,
      ctime: result.ctime,
      // showme-ro は常に、showme-rw は書けないファイル（ハードリンク・ディスクの権限）のとき
      // readonly（判断は mirror。ここは写すだけ）。
      ...(result.readonly ? { permissions: vscode.FilePermission.Readonly } : {}),
    };
  }

  readFile(uri: vscode.Uri): Uint8Array {
    const rel = this.relOf(uri);
    // stat と同じ unsaved を渡す（size と中身の長さを揃える）。
    const result = this.mirror.read(this.scheme, rel, this.unsavedFor(rel));
    if (!result.ok) throw vscode.FileSystemError.FileNotFound(uri);
    return result.bytes;
  }

  /**
   * showme-rw だけが書ける。**作らない**（既存の通常ファイルにだけ書く。D81）。
   *
   * `create && !overwrite`（「無ければ作る、あれば断る」）は、あるときは
   * `FileExists`、無いときは作らないので `FileNotFound`。あるかどうかは mirror の
   * stat（関門を通る）で見る ―― 秘匿パスは stat でも無いと答えるので、
   * `FileExists` が秘匿の存在を語ることはない。
   */
  writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { readonly create: boolean; readonly overwrite: boolean },
  ): void {
    // 近道: 読み取り専用の規則を持つのは mirror.write（不変条件14）。ここで先に断るのは
    // 下の stat を無駄に引かないためで、答えは mirror の `readonly` と同じ NoPermissions。
    if (this.scheme === STAGE_SCHEME_READONLY) throw vscode.FileSystemError.NoPermissions(uri);
    const rel = this.relOf(uri);
    if (!options.overwrite && this.mirror.stat(this.scheme, rel).ok) {
      throw vscode.FileSystemError.FileExists(uri);
    }
    const result = this.mirror.write(this.scheme, rel, content);
    if (result.ok) return;
    switch (result.reason) {
      case "readonly":
        throw vscode.FileSystemError.NoPermissions(uri);
      case "not-found":
        throw vscode.FileSystemError.FileNotFound(uri);
      case "not-writable":
        // 関門を通った後の拒否。存在は read が、書けないことは stat が既に答えている。
        throw vscode.FileSystemError.NoPermissions(uri);
      case "too-large":
        // 渡した bytes の長さだけで決まる理由。パスを語らない。
        throw vscode.FileSystemError.NoPermissions(t("Content exceeds the size limit."));
      case "io-error":
        throw vscode.FileSystemError.Unavailable(uri);
    }
  }

  /** 列挙の口にしない（D81）。 */
  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  delete(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  rename(oldUri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(oldUri);
  }

  dispose(): void {
    this.emitter.dispose();
  }

  /**
   * URI → 相対パス。読めない綴り（別スキーム・authority 付き・脱出・末尾 "/"・別名の
   * 綴り）は関門で落ちたものと同じ `FileNotFound(uri)` にする（綴りで落ちたか関門で
   * 落ちたかを形で割らない）。
   *
   * **正準形の検査（`/src//a.ts`・`/src/./a.ts`・`/src\a.ts` などの別名を拒む）は
   * ここに持たない。** `relOfStageUri`（`stage-uri-vscode.ts`）経由で `relOfStagePath`
   * （`stage-uri.ts`）1つに集約してある（不変条件14: 同じ判断を2箇所に書かない）。
   */
  private relOf(uri: vscode.Uri): string {
    const rel = relOfStageUri(uri);
    if (rel === undefined) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return rel;
  }

  /**
   * showme-ro のときだけ人間の未保存の中身を引く。近道: 「unsaved は ro だけ」の規則を
   * 持つのは mirror（不変条件14。rw に渡しても mirror が無視する）。ここで先に切るのは、
   * rw の読みのたびに開いている文書を走査しないため。
   */
  private unsavedFor(rel: string): string | undefined {
    if (this.scheme !== STAGE_SCHEME_READONLY) return undefined;
    return this.unsavedText(rel);
  }
}
