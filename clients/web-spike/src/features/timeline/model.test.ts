import { describe, expect, it } from "vitest";
import type { Message } from "@/lib/api";
import {
  emptyTimeline,
  isStrictlyOrdered,
  mergeMessages,
} from "./model";

function msg(seq: number, body = `m${seq}`): Message {
  return {
    id: `id-${seq}`,
    channelId: "c",
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: "a",
    type: "text",
    body,
    state: "sent",
    createdAtMs: seq,
  };
}

describe("timeline ordering model", () => {
  it("orders a descending REST page ascending by seq", () => {
    const page = [msg(5), msg(4), msg(3), msg(2), msg(1)]; // server head order
    const state = mergeMessages(emptyTimeline(), page);
    expect(state.messages.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(isStrictlyOrdered(state.messages)).toBe(true);
    expect(state.oldestSeq).toBe(1);
    expect(state.newestSeq).toBe(5);
  });

  it("inserts an out-of-order realtime message at its seq position", () => {
    let state = mergeMessages(emptyTimeline(), [msg(1), msg(2), msg(4)]);
    state = mergeMessages(state, [msg(3)]); // late arrival
    expect(state.messages.map((m) => m.seq)).toEqual([1, 2, 3, 4]);
    expect(isStrictlyOrdered(state.messages)).toBe(true);
  });

  it("dedupes duplicate seq (realtime echo of a REST row), last write wins", () => {
    let state = mergeMessages(emptyTimeline(), [msg(1), msg(2, "orig")]);
    state = mergeMessages(state, [msg(2, "edited")]);
    expect(state.messages.map((m) => m.seq)).toEqual([1, 2]);
    expect(state.messages[1].body).toBe("edited");
  });

  it("stays ordered when a backfill batch overlaps existing tail", () => {
    let state = mergeMessages(emptyTimeline(), [msg(10), msg(11), msg(12)]);
    // backfill ?after=9 returns 10..15 ascending (overlap 10-12)
    state = mergeMessages(state, [10, 11, 12, 13, 14, 15].map((s) => msg(s)));
    expect(state.messages.map((m) => m.seq)).toEqual([10, 11, 12, 13, 14, 15]);
    expect(isStrictlyOrdered(state.messages)).toBe(true);
  });
});
