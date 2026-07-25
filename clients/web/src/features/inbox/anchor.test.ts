import { describe, expect, it, vi } from "vitest";
import { channelPath, messageSelector, watchForMessage } from "./anchor";

describe("channelPath", () => {
  it("opens the channel when the source projection carries no seq", () => {
    expect(channelPath("00000000-0000-7000-8000-000000000201")).toBe(
      "/c/00000000-0000-7000-8000-000000000201"
    );
  });

  it("carries the anchor in the url so a reload still names the target", () => {
    expect(channelPath("019F94E3-0E04-79CD-9DEE-208F47EDD9A8", 147)).toBe(
      "/c/019F94E3-0E04-79CD-9DEE-208F47EDD9A8?seq=147"
    );
  });

  it("targets the timeline row identity the seq gate also asserts on", () => {
    expect(messageSelector(147)).toBe(
      '[data-testid="timeline-message"][data-seq="147"]'
    );
  });
});

describe("watchForMessage", () => {
  function fakeSchedule() {
    const queued: (() => void)[] = [];
    return {
      queued,
      schedule: (fn: () => void) => {
        queued.push(fn);
        return queued.length;
      },
    };
  }

  it("scrolls the row into view as soon as virtuoso has mounted it", () => {
    const row = {
      scrollIntoView: vi.fn(),
      classList: { add: vi.fn(), remove: vi.fn() },
    };
    const { queued, schedule } = fakeSchedule();
    watchForMessage(147, {
      doc: { querySelector: () => row } as unknown as Document,
      now: () => 0,
      schedule,
      cancel: () => {},
    });
    expect(row.scrollIntoView).toHaveBeenCalledWith({ block: "center" });
    expect(row.classList.add).toHaveBeenCalled();
    // The only thing still queued is the highlight teardown.
    expect(queued).toHaveLength(1);
    queued[0]();
    expect(row.classList.remove).toHaveBeenCalled();
  });

  it("gives up quietly once the watch window is spent", () => {
    const { queued, schedule } = fakeSchedule();
    let clock = 0;
    watchForMessage(147, {
      doc: { querySelector: () => null } as unknown as Document,
      now: () => clock,
      schedule,
      cancel: () => {},
      watchMs: 100,
    });
    expect(queued).toHaveLength(1);
    clock = 1_000;
    queued[0]();
    expect(queued).toHaveLength(1);
  });

  it("stops polling when the caller cancels", () => {
    const { queued, schedule } = fakeSchedule();
    const cancel = vi.fn();
    const stop = watchForMessage(147, {
      doc: { querySelector: () => null } as unknown as Document,
      now: () => 0,
      schedule,
      cancel,
      watchMs: 10_000,
    });
    stop();
    expect(cancel).toHaveBeenCalled();
    queued[0]();
    expect(queued).toHaveLength(1);
  });
});
