import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyIncomingMessage,
  createSequenceDebouncer,
  highestVisibleSequence,
  mergeEntry,
} from "./readStates";

afterEach(() => vi.useRealTimers());

describe("visible read-state debounce", () => {
  it("selects the highest visible sequence", () => {
    expect(highestVisibleSequence(new Set([4, 9, 7]))).toBe(9);
  });

  it("coalesces visibility churn to the highest sequence", () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const debouncer = createSequenceDebouncer(flush, 300);
    debouncer.report("CHANNEL-A", 3);
    debouncer.report("channel-a", 8);
    vi.advanceTimersByTime(299);
    expect(flush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(flush).toHaveBeenCalledWith("channel-a", 8);
  });

  it("keeps independent channel cursors in one debounce window", () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const debouncer = createSequenceDebouncer(flush, 100);
    debouncer.report("channel-a", 4);
    debouncer.report("channel-b", 6);
    vi.runAllTimers();
    expect(flush.mock.calls).toEqual([
      ["channel-a", 4],
      ["channel-b", 6],
    ]);
  });

  it("cancels a pending cursor", () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const debouncer = createSequenceDebouncer(flush, 100);
    debouncer.report("channel-a", 4);
    debouncer.cancel();
    vi.runAllTimers();
    expect(flush).not.toHaveBeenCalled();
  });
});

describe("read-state reconciliation", () => {
  const current = {
    lastReadSeq: 5,
    latestSeq: 8,
    unreadCount: 3,
    mentionCount: 1,
  };

  it("increments an inactive channel immediately", () => {
    expect(applyIncomingMessage(current, 9, true)).toEqual({
      lastReadSeq: 5,
      latestSeq: 9,
      unreadCount: 4,
      mentionCount: 2,
    });
  });

  it("ignores a replayed inactive-channel message", () => {
    expect(applyIncomingMessage(current, 8, true)).toBe(current);
  });

  it("does not regress on a stale REST projection", () => {
    expect(
      mergeEntry(current, {
        lastReadSeq: 4,
        latestSeq: 7,
        unreadCount: 3,
        mentionCount: 0,
      })
    ).toBe(current);
  });

  it("recomputes unread from monotonic read and latest cursors", () => {
    expect(
      mergeEntry(current, {
        lastReadSeq: 7,
        latestSeq: 10,
        unreadCount: 99,
        mentionCount: 0,
      })
    ).toEqual({
      lastReadSeq: 7,
      latestSeq: 10,
      unreadCount: 3,
      mentionCount: 0,
    });
  });
});
