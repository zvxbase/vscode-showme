/**
 * 「常に1つだけ有効なタイマー」を管理する。
 *
 * schedule() を呼ぶたびに前回分をキャンセルしてから仕掛け直すので、連続呼び出し
 * でタイマーが積み上がらない。dispose() 後は schedule() を呼んでも何もしない
 * （破棄済みの対象にタイマーが後から触るのを防ぐ）。vscode API に依存しないため
 * 単体テストできる。
 */
export class SinglePendingTimer {
  private handle: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  schedule(fn: () => void, ms: number): void {
    if (this.disposed) return;
    if (this.handle !== undefined) {
      clearTimeout(this.handle);
    }
    this.handle = setTimeout(() => {
      this.handle = undefined;
      fn();
    }, ms);
  }

  dispose(): void {
    if (this.handle !== undefined) {
      clearTimeout(this.handle);
      this.handle = undefined;
    }
    this.disposed = true;
  }
}
