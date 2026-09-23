import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SinglePendingTimer } from "../src/single-pending-timer.js";

describe("SinglePendingTimer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("指定時間後に一度だけ発火する", () => {
    const fn = vi.fn();
    const timer = new SinglePendingTimer();
    timer.schedule(fn, 5000);
    vi.advanceTimersByTime(4999);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("経過前に再度 schedule すると前回分はキャンセルされ、後勝ちする（積み上がらない）", () => {
    const first = vi.fn();
    const second = vi.fn();
    const timer = new SinglePendingTimer();
    timer.schedule(first, 5000);
    vi.advanceTimersByTime(3000);
    timer.schedule(second, 5000);
    vi.advanceTimersByTime(5000);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("dispose() 後は保留中のタイマーが発火しない", () => {
    const fn = vi.fn();
    const timer = new SinglePendingTimer();
    timer.schedule(fn, 5000);
    timer.dispose();
    vi.advanceTimersByTime(10000);
    expect(fn).not.toHaveBeenCalled();
  });

  it("dispose() 後に schedule() を呼んでも何もしない", () => {
    const fn = vi.fn();
    const timer = new SinglePendingTimer();
    timer.dispose();
    timer.schedule(fn, 5000);
    vi.advanceTimersByTime(10000);
    expect(fn).not.toHaveBeenCalled();
  });
});
