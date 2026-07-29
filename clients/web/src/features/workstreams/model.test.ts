import { describe, expect, it } from "vitest";
import { ApiError, type WorkHost, type WorkstreamRun } from "@/lib/api";
import {
  WORKSTREAM_STATUS_CLASS,
  WORKSTREAM_STATUS_LABEL,
  actorCount,
  continuableRun,
  continuationBlockedCopy,
  continuationErrorCopy,
  continuationState,
  isWorkstreamMissing,
  parseStatusFilter,
  runClockLabel,
} from "./model";

const alice = "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaa01";
const bob = "bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbb01";
const deadHost = "11111111-1111-7111-8111-111111111101";
const liveHost = "22222222-2222-7222-8222-222222222201";
const otherMemberHost = "33333333-3333-7333-8333-333333333301";

function run(overrides: Partial<WorkstreamRun> = {}): WorkstreamRun {
  return {
    id: "44444444-4444-7444-8444-444444444401",
    memberId: alice,
    hostId: deadHost,
    tool: "codex",
    label: "회귀 재현",
    status: "ended",
    startedAtMs: 1_785_238_400_000,
    ...overrides,
  };
}

function host(overrides: Partial<WorkHost> = {}): WorkHost {
  return {
    id: liveHost,
    workspaceId: "99999999-9999-7999-8999-999999999901",
    scope: "workspace",
    ownerMemberId: alice,
    type: "app",
    displayName: "성재 맥북",
    capabilities: {},
    createdAtMs: 0,
    online: true,
    ...overrides,
  };
}

describe("workstream status vocabulary", () => {
  it("names and colours every status the schema allows", () => {
    for (const status of ["active", "paused", "done", "cancelled"] as const) {
      expect(WORKSTREAM_STATUS_LABEL[status]).toBeTruthy();
      expect(WORKSTREAM_STATUS_CLASS[status]).toBeTruthy();
    }
  });

  it("spends the accent on 멈춤 only, the one state waiting on a person", () => {
    expect(WORKSTREAM_STATUS_CLASS.paused).toContain("accent");
    expect(WORKSTREAM_STATUS_CLASS.active).not.toContain("accent");
    expect(WORKSTREAM_STATUS_CLASS.done).not.toContain("accent");
    expect(WORKSTREAM_STATUS_CLASS.cancelled).not.toContain("accent");
  });

  it("accepts the server's own filter values and nothing else", () => {
    expect(parseStatusFilter("paused")).toBe("paused");
    expect(parseStatusFilter(null)).toBeNull();
    expect(parseStatusFilter("")).toBeNull();
    expect(parseStatusFilter("ACTIVE")).toBeNull();
    expect(parseStatusFilter("archived")).toBeNull();
  });
});

describe("runClockLabel", () => {
  const now = new Date(2026, 6, 30, 14, 30).getTime();

  it("keeps today to a clock and dates anything older", () => {
    expect(runClockLabel(new Date(2026, 6, 30, 9, 5).getTime(), now)).toEqual({
      day: null,
      time: "09:05",
    });
    expect(runClockLabel(new Date(2026, 6, 28, 9, 5).getTime(), now)).toEqual({
      day: "7월 28일",
      time: "09:05",
    });
    expect(runClockLabel(new Date(2025, 11, 31, 23, 59).getTime(), now)).toEqual({
      day: "2025년 12월 31일",
      time: "23:59",
    });
  });

  it("keeps the Korean day out of the tabular half", () => {
    // The figure is the clock. A day carrying 월/일 is prose, and prose in the
    // mono stack renders with stretched syllable gaps (tokens.md §4), so the
    // two halves have to stay separable by the caller.
    const { day, time } = runClockLabel(
      new Date(2026, 6, 28, 9, 5).getTime(),
      now
    );
    expect(time).toMatch(/^\d{2}:\d{2}$/);
    expect(day).not.toMatch(/^\d{2}:\d{2}$/);
  });
});

describe("run history", () => {
  it("counts the DIFFERENT members a goal was run by", () => {
    expect(actorCount([])).toBe(0);
    expect(
      actorCount([
        run({ memberId: alice }),
        run({ id: "x", memberId: alice.toUpperCase() }),
        run({ id: "y", memberId: bob }),
      ])
    ).toBe(2);
  });

  it("offers only an orphaned run for continuation, newest first", () => {
    expect(continuableRun([run({ status: "running" })])).toBeNull();
    expect(continuableRun([run({ status: "idle" })])).toBeNull();
    expect(continuableRun([run({ status: "ended" })])).toBeNull();
    const stale = run({ id: "stale", status: "orphaned", startedAtMs: 10 });
    const fresh = run({ id: "fresh", status: "orphaned", startedAtMs: 20 });
    expect(continuableRun([stale, fresh])?.id).toBe("fresh");
  });
});

describe("continuationState", () => {
  const orphaned = run({ status: "orphaned" });

  it("offers the takeover with the hosts the server would accept", () => {
    const state = continuationState(
      [orphaned],
      [
        host(),
        host({ id: deadHost, displayName: "죽은 호스트" }),
        host({ id: otherMemberHost, scope: "member", ownerMemberId: bob }),
        host({ id: "44444444-4444-7444-8444-444444444402", online: false }),
      ],
      alice,
      false
    );
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") return;
    // The dead source host, another member's private host and an offline host
    // are all excluded — the same boundary the server enforces.
    expect(state.targets.map((target) => target.id)).toEqual([liveHost]);
    expect(state.run.id).toBe(orphaned.id);
  });

  it("names the reason instead of disabling one button for four causes", () => {
    expect(continuationState([], [host()], alice, false).kind).toBe("no-runs");
    expect(
      continuationState([run({ status: "running" })], [host()], alice, false).kind
    ).toBe("no-stopped-run");
    expect(continuationState([orphaned], [], alice, false).kind).toBe("no-host");
    expect(continuationState([orphaned], [host()], alice, true).kind).toBe(
      "offline"
    );
  });

  it("has a sentence for every blocked branch", () => {
    for (const state of [
      { kind: "offline" } as const,
      { kind: "no-runs" } as const,
      { kind: "no-stopped-run" } as const,
      { kind: "no-host", run: orphaned } as const,
    ]) {
      const copy = continuationBlockedCopy(state);
      expect(copy.length).toBeGreaterThan(0);
      // ADR-0143 D3: the ledger knows WIP metadata; whether git hands the
      // commits over is git's answer. No branch may promise otherwise.
      expect(copy).not.toContain("미커밋");
      expect(copy).not.toMatch(/[—–]/);
    }
  });
});

describe("continuationErrorCopy", () => {
  it("says membership only for the code that means membership", () => {
    expect(continuationErrorCopy(403)).toContain("멤버");
    expect(continuationErrorCopy(409)).not.toContain("멤버");
    expect(continuationErrorCopy(404)).not.toContain("멤버");
    expect(continuationErrorCopy(null)).not.toContain("멤버");
  });

  it("never apologizes and never uses an em-dash", () => {
    for (const status of [403, 409, 404, 500, null]) {
      const copy = continuationErrorCopy(status);
      expect(copy).not.toContain("죄송");
      expect(copy).not.toMatch(/[—–]/);
    }
  });
});

describe("isWorkstreamMissing", () => {
  it("tells 404 and 403 apart, because the server means different things by them", () => {
    // 404 is the read answering "not yours, and no more than that"; 403 belongs
    // to the resume path alone. A predicate that folded them would let the
    // detail surface talk about permission for a workstream whose existence the
    // server refused to confirm.
    expect(isWorkstreamMissing(new ApiError(404, "workstream not found"))).toBe(
      true
    );
    expect(
      isWorkstreamMissing(new ApiError(403, "active channel membership required"))
    ).toBe(false);
    expect(isWorkstreamMissing(new Error("offline"))).toBe(false);
  });
});
