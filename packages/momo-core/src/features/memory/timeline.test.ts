import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import { memoryEventLabel } from "./browser";
import type { MemoryItem, MemoryItemEvent } from "./model";
import {
  CLEANUP_NOTE,
  REVERT_CONFLICT_MESSAGE,
  REVERT_FAILED_MESSAGE,
  REVERT_FORBIDDEN_MESSAGE,
  REVERT_GONE_MESSAGE,
  REVERT_UNSUPPORTED_MESSAGE,
  canRevertEvent,
  closerFromEvents,
  consolidationEventView,
  decisionIntervalLabel,
  decisionStateOf,
  deriveDecisionTimeline,
  mergeWinnerFromEvents,
  needsEventsForLinks,
  revertError,
  revertSuccessMessage,
} from "./timeline";

const CH = "00000000-0000-7000-8000-000000000201";
const T0 = 1_800_000_000_000;
const DAY = 86_400_000;

function item(over: Partial<MemoryItem> & { id: string }): MemoryItem {
  return {
    channelId: CH,
    spaceKind: "channel",
    kind: "decision",
    origin: "extracted",
    body: "결제 재시도 큐는 두 배로 늘려요.",
    validFromMs: T0,
    recordedAtMs: T0,
    confidence: 0.9,
    sourceCount: 2,
    ...over,
  };
}

function event(over: Partial<MemoryItemEvent> & { id: string; action: string }): MemoryItemEvent {
  return { detail: {}, createdAtMs: T0, ...over };
}

describe("decisionStateOf", () => {
  it("separates current, closed, merged and decayed", () => {
    expect(decisionStateOf(item({ id: "a" }))).toBe("current");
    expect(decisionStateOf(item({ id: "a", validToMs: T0 + DAY }))).toBe("closed");
    expect(
      decisionStateOf(item({ id: "a", retiredAtMs: T0, retiredReason: "merged" }))
    ).toBe("merged");
    expect(
      decisionStateOf(item({ id: "a", retiredAtMs: T0, retiredReason: "decayed" }))
    ).toBe("decayed");
  });

  it("leaves out edited-away and source-gone versions and every non-decision", () => {
    expect(decisionStateOf(item({ id: "a", retiredAtMs: T0, retiredReason: "edited" }))).toBeNull();
    expect(
      decisionStateOf(item({ id: "a", retiredAtMs: T0, retiredReason: "source_deleted" }))
    ).toBeNull();
    expect(decisionStateOf(item({ id: "a", kind: "fact" }))).toBeNull();
  });
});

describe("deriveDecisionTimeline", () => {
  const OLD = item({ id: "old", subjectKey: "결제 큐", validFromMs: T0, validToMs: T0 + 5 * DAY });
  const NEW = item({ id: "new", subjectKey: "결제 큐", validFromMs: T0 + 5 * DAY, body: "큐를 세 배로 늘려요." });

  it("orders one subject oldest first and reads the replacement from the ledger", () => {
    const groups = deriveDecisionTimeline(
      [NEW, OLD],
      new Map([
        [
          "old",
          [event({ id: "e1", action: "superseded", detail: { reason: "contradiction", superseded_by: "new" } })],
        ],
      ])
    );
    expect(groups).toHaveLength(1);
    const entries = groups[0]?.entries ?? [];
    expect(entries.map((entry) => entry.item.id)).toEqual(["old", "new"]);
    expect(entries.map((entry) => entry.state)).toEqual(["closed", "current"]);
    expect(entries[0]?.replacedById).toBe("new");
    expect(entries[1]?.replacesIds).toEqual(["old"]);
  });

  it("does not guess a replacement from matching dates when the ledger is silent", () => {
    const groups = deriveDecisionTimeline([OLD, NEW], new Map());
    const entries = groups[0]?.entries ?? [];
    expect(entries[0]?.replacedById).toBeUndefined();
    expect(entries[1]?.replacesIds).toEqual([]);
  });

  it("ignores an edit's superseded event: only a contradiction is a replacement", () => {
    const groups = deriveDecisionTimeline(
      [OLD, NEW],
      new Map([
        ["old", [event({ id: "e1", action: "superseded", detail: { reason: "edited", superseded_by: "new" } })]],
      ])
    );
    expect(groups[0]?.entries[0]?.replacedById).toBeUndefined();
  });

  it("keeps a merged decision and points at the winner", () => {
    const merged = item({ id: "m", retiredAtMs: T0 + DAY, retiredReason: "merged" });
    const groups = deriveDecisionTimeline(
      [merged],
      new Map([["m", [event({ id: "e", action: "merged", detail: { into: "w" } })]]])
    );
    expect(groups[0]?.entries[0]?.state).toBe("merged");
    expect(groups[0]?.entries[0]?.mergedIntoId).toBe("w");
  });

  it("groups by channel and subject, most recently changed group first, and drops personal space", () => {
    const other = item({ id: "o", channelId: "00000000-0000-7000-8000-000000000202", validFromMs: T0 + 9 * DAY });
    const personal = item({ id: "p", spaceKind: "personal" });
    const groups = deriveDecisionTimeline([OLD, NEW, other, personal], new Map());
    expect(groups.map((group) => group.entries.map((entry) => entry.item.id))).toEqual([["o"], ["old", "new"]]);
  });

  it("reads the newest closing when there are several", () => {
    expect(
      closerFromEvents([
        event({ id: "1", action: "superseded", createdAtMs: 1, detail: { reason: "contradiction", superseded_by: "a" } }),
        event({ id: "2", action: "superseded", createdAtMs: 2, detail: { reason: "contradiction", superseded_by: "b" } }),
      ])
    ).toBe("b");
    expect(mergeWinnerFromEvents([event({ id: "1", action: "merged", detail: { absorbed: "x" } })])).toBeUndefined();
  });

  it("asks for a ledger only for closed and merged decisions", () => {
    expect(needsEventsForLinks(OLD)).toBe(true);
    expect(needsEventsForLinks(NEW)).toBe(false);
  });
});

describe("decisionIntervalLabel", () => {
  it("names the interval by state", () => {
    expect(decisionIntervalLabel("closed", "10월 3일", "10월 9일")).toBe("10월 3일 ~ 10월 9일");
    expect(decisionIntervalLabel("current", "10월 3일", null)).toBe("10월 3일부터 지금까지");
  });
});

describe("consolidation events", () => {
  const merged = event({ id: "m", action: "merged", detail: { into: "w" } });
  const winnerSide = event({ id: "w", action: "merged", detail: { absorbed: "l" } });
  const closed = event({ id: "c", action: "superseded", detail: { reason: "contradiction", superseded_by: "n" } });
  const edited = event({ id: "s", action: "superseded", detail: { reason: "edited", superseded_by: "n" } });
  const decayed = event({ id: "d", action: "retired", detail: { reason: "decayed" } });
  const gone = event({ id: "g", action: "retired", detail: { reason: "source_deleted" } });
  const all = [merged, winnerSide, closed, edited, decayed, gone];

  it("marks exactly the kinds the server can undo", () => {
    const kinds = all.map((e) => consolidationEventView(e, all, "x").kind);
    expect(kinds).toEqual(["merged", null, "closed", null, "decayed", null]);
  });

  it("folds a revert already made against the event", () => {
    const reverted = event({ id: "r", action: "reverted", actorMemberId: "u", detail: { of: "m", what: "merged" } });
    const view = consolidationEventView(merged, [merged, reverted], "x");
    expect(view.alreadyReverted).toBe(true);
    expect(canRevertEvent(view, "member")).toBe(false);
    expect(consolidationEventView(closed, [closed, reverted], "x").alreadyReverted).toBe(false);
  });

  it("a guest can read the event but not revert it", () => {
    const view = consolidationEventView(merged, [merged], "x");
    expect(canRevertEvent(view, "member")).toBe(true);
    expect(canRevertEvent(view, "guest")).toBe(false);
  });

  it("treats an event without an actor as automatic", () => {
    expect(consolidationEventView(merged, [merged], "x").automatic).toBe(true);
    expect(
      consolidationEventView({ ...merged, actorMemberId: "u" }, [merged], "x").automatic
    ).toBe(false);
  });

  it("labels by detail, not by action alone", () => {
    expect(memoryEventLabel("superseded", { reason: "edited" })).toBe("새 버전으로 바뀌었어요");
    expect(memoryEventLabel("superseded", { reason: "contradiction" })).toContain("유효 기간이 닫혔어요");
    expect(memoryEventLabel("retired", { reason: "decayed" })).toContain("오래 쓰지 않아서");
    expect(memoryEventLabel("retired", { reason: "source_deleted" })).toContain("지워져서");
    expect(memoryEventLabel("reverted", { what: "merged" })).toBe("합치기를 되돌렸어요");
    expect(memoryEventLabel("merged", { absorbed: "l" })).toContain("합쳐 받았어요");
  });
});

describe("revertError", () => {
  it("maps each status to its own sentence", () => {
    expect(revertError(new ApiError(403, "x")).message).toBe(REVERT_FORBIDDEN_MESSAGE);
    expect(revertError(new ApiError(404, "x"))).toMatchObject({ message: REVERT_GONE_MESSAGE, gone: true });
    expect(revertError(new ApiError(409, "x"))).toMatchObject({ message: REVERT_CONFLICT_MESSAGE, refetch: true });
    expect(revertError(new ApiError(422, "x")).message).toBe(REVERT_UNSUPPORTED_MESSAGE);
    expect(revertError(new ApiError(500, "x")).message).toBe(REVERT_FAILED_MESSAGE);
    expect(revertError(new Error("offline")).message).toBe(REVERT_FAILED_MESSAGE);
  });

  it("does not tell 403 and 404 apart in words", () => {
    expect(REVERT_GONE_MESSAGE).not.toMatch(/권한/);
  });

  it("names what each revert did", () => {
    expect(revertSuccessMessage("merged")).toContain("합치기");
    expect(revertSuccessMessage("superseded")).toContain("기간");
    expect(revertSuccessMessage("decayed")).toContain("살렸어요");
  });
});

describe("copy", () => {
  it("says the cleanup is nightly and can be undone", () => {
    expect(CLEANUP_NOTE).toContain("밤사이");
    expect(CLEANUP_NOTE).toContain("되돌릴 수 있어요");
  });
});
