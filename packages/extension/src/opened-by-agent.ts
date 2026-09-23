/**
 * エージェントが `show_code` で開いた文書の記録（設計 増分5 D53 / §C2）。
 * **メモリのみ**（不変条件13）。ディスクに書かない。拡張ホストが死ねば消える。
 *
 * **舞台は位置ではなく own の集合である。** 「人間の列より右」で舞台を定義すると、
 * 人間が舞台の列をクリックした瞬間に混ざる。所有で定義すれば、人間が覗いても
 * own は変わらず、床（見ている／未保存）が守る（`arrange-policy.ts`）。
 *
 * **閉じたら忘れる。** 忘れないと、エージェントが開いた → 人間が閉じた → 後で人間が
 * 同じファイルを自分で開いた、が own のままになる（人間のタブを片づける経路）。
 * 忘れる場所は `extension.ts` の `tabGroups.onDidChangeTabs` の `closed` ただ1つ。
 *
 * **人間が動かしたタブは人間のものになる。** VS Code はタブのドラッグもレイアウトの
 * 合流も「閉じて開き直す」としてモデル化する（実測: ドラッグ1回で `closed` が1回
 * 発火する）ので、own は**どの close 事象でも**取り消される。これは意図した意味
 * である ―― 人間が自分の列へ引き寄せた／どこかへ動かしたタブは、人間が自分のものに
 * した。方向は閉じない側で、床は破れない。エージェント自身が動かすとき
 * （`move-tab` / `gather-own`）と、**エージェント自身のプリセットで合流した
 * とき**（`two-columns` 等 ―― 合流の close は人間のドラッグと同じ形だが、
 * 自分が呼んだプリセットの中で起きた close は自分の仕業）は、URI を自分で記録し直す
 * （`arrange-surface.ts` の `restoreOwnership`。前に own だったものだけ。元の札が消えた／
 * 列の数が目標に達したのを観測してから ―― 先に記録すると、遅れて来た `closed` がそれを消す。
 * 決めるのは `arrange-policy.ts` の `ownedUrisToRestore` 1つ）。
 *
 * **記録する場所は2つ: `Stage.open()`（`show_code` が編集器を開く唯一の場所）と、
 * `restoreOwnership` の再記録（own を保つ。移動とプリセットの両方）。** どちらも
 * 「エージェントが置いた」出来事である。
 * 別の入口で `opened()` を呼ぶと、その入口が忘れられたときに own の意味がずれる。
 *
 * **実体は1つ。** `Stage`（記録）・`createEditorStateSurface`（`get_editor_state` の
 * `own`）・`createArrangeSurface`（`close-own` の候補）が同じインスタンスを見る。
 * 2つ作ると、片方が「own」と言うものをもう片方が閉じない（不変条件14）。
 *
 * 鍵は `Uri.toString()`。`Tab` に安定した id は無い（設計書 Y7）が、URI は文書に紐づく。
 * `vscode` に触らないので、この判断は vitest で全部確かめられる。
 */
export class OpenedByAgent {
  /** 挿入順を持つ `Set`。古いものが先頭に来る。 */
  private readonly keys = new Set<string>();

  /**
   * @param max 覚える上限。**際限なく溜めない**（1セッションで何百回も `show_code`
   *   が呼ばれる）。超えたら触っていない古いものから忘れる ―― 忘れた側は
   *   「自分のもの」でなくなるだけで、安全側（閉じない側）に倒れる。
   */
  constructor(private readonly max = 256) {}

  /** 開いた。既にあれば新しい側に回す（上限で先に忘れるのは触っていない古いもの）。 */
  opened(key: string): void {
    this.keys.delete(key);
    this.keys.add(key);
    while (this.keys.size > this.max) {
      const oldest = this.keys.values().next().value;
      if (oldest === undefined) break;
      this.keys.delete(oldest);
    }
  }

  /** 閉じた。知らないものは何もしない（人間が閉じたタブの大半は知らないもの）。 */
  closed(key: string): void {
    this.keys.delete(key);
  }

  has(key: string): boolean {
    return this.keys.has(key);
  }

  clear(): void {
    this.keys.clear();
  }

  get size(): number {
    return this.keys.size;
  }
}
