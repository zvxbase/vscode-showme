/**
 * 観測したタブに札（不透明な id）を配り、札から引き直すための台帳。
 *
 * `vscode.Tab` に安定した id は無い（設計書 Y7）ので、面は `listTabs()` のたびに
 * 札を配り直す。**判断はしない。** vscode に触らないので、札の性質は単体で確かめる。
 *
 * ## 札は観測をまたいで一意である
 *
 * 初版は観測のたびに `t0` から番号を振り直していた。ハンドラは1回の観測で得た札を
 * 持って `await` を挟みながら面を呼ぶので、そのあいだに**別の要求**が `listTabs()` を
 * 呼ぶと、同じ札が別のタブ ―― 人間が見ているタブでもありうる ―― に結び直される
 * （TOCTOU。床1 を競合で抜ける）。ブリッジが要求を直列化しているから今は届かないが、
 * 信頼の境界はソケットであって（`server.ts` は `void this.dispatch(...)`）、
 * ブリッジの作法ではない。番号は台帳の寿命の中で単調に増やし、古い札は**引けない**
 * （fail-closed）。
 */
export class TabRegistry<T> {
  private entries = new Map<string, T>();
  /** 単調に増える。**観測ごとに戻さない**（戻すと古い札が別のタブに結び直される）。 */
  private next = 0;

  /** 観測を1回分、台帳に載せ替える。前の観測の札はすべて無効になる。 */
  observe(items: readonly T[]): Array<{ id: string; item: T }> {
    this.entries = new Map();
    return items.map((item) => {
      const id = `t${this.next++}`;
      this.entries.set(id, item);
      return { id, item };
    });
  }

  /** 札から引く。**同期**。知らない札（前の観測のもの・存在しないもの）は落とす。 */
  resolve(ids: readonly string[]): T[] {
    const out: T[] = [];
    for (const id of ids) {
      const item = this.entries.get(id);
      if (item !== undefined) out.push(item);
    }
    return out;
  }
}
