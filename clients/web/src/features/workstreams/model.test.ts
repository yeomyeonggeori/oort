import { describe, expect, it } from "vitest";
import { ApiError, type WorkHost, type WorkstreamRun } from "@/lib/api";
import {
  WORKSTREAM_FILTER_TABS,
  WORKSTREAM_FILTERS,
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
  workstreamFilterLabel,
  workstreamFilterOf,
  workstreamStatusOf,
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
      false,
      "active"
    );
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") return;
    // The dead source host, another member's private host and an offline host
    // are all excluded — the same boundary the server enforces.
    expect(state.targets.map((target) => target.id)).toEqual([liveHost]);
    expect(state.run.id).toBe(orphaned.id);
  });

  it("names the reason instead of disabling one button for four causes", () => {
    expect(continuationState([], [host()], alice, false, "active").kind).toBe(
      "no-runs"
    );
    expect(
      continuationState(
        [run({ status: "running" })],
        [host()],
        alice,
        false,
        "active"
      ).kind
    ).toBe("no-stopped-run");
    expect(continuationState([orphaned], [], alice, false, "active").kind).toBe(
      "no-host"
    );
    expect(
      continuationState([orphaned], [host()], alice, true, "active").kind
    ).toBe("offline");
  });

  it("does not offer to continue a goal that is over", () => {
    // 1R M1: the state read the run ledger and never the GOAL, so a completed
    // workstream that still holds an orphaned Run (a host dies after the work
    // is called done) rendered an enabled 이어받기 180px under its 완료 chip.
    for (const status of ["done", "cancelled"] as const) {
      const state = continuationState(
        [orphaned],
        [host()],
        alice,
        false,
        status
      );
      expect(state).toEqual({ kind: "closed", status });
    }
    expect(
      continuationState([orphaned], [host()], alice, false, "paused").kind
    ).toBe("ready");
  });

  it("does not promise a reconnection to a goal that is over", () => {
    // Offline is a transport fact and 완료 is a fact about the work. The
    // offline sentence ends with "다시 연결되면 이 자리에서 이어받을 수
    // 있습니다", which for a finished goal is a promise nothing can keep, so
    // the goal's own status has to be asked first.
    const state = continuationState([orphaned], [host()], alice, true, "done");
    expect(state.kind).toBe("closed");
  });

  it("has a sentence for every blocked branch", () => {
    for (const state of [
      { kind: "closed", status: "done" } as const,
      { kind: "closed", status: "cancelled" } as const,
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

  it("tells 완료 and 취소됨 apart in the sentence it says", () => {
    const done = continuationBlockedCopy({ kind: "closed", status: "done" });
    const cancelled = continuationBlockedCopy({
      kind: "closed",
      status: "cancelled",
    });
    expect(done).toContain("완료");
    expect(cancelled).toContain("취소");
    expect(done).not.toBe(cancelled);
    // 끝난 목표에 이어받기를 다시 권하지 않는다: 다음 행동은 새 작업이다.
    expect(done).not.toContain("이어받을 수 있습니다");
    expect(cancelled).not.toContain("이어받을 수 있습니다");
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

describe("작업 흐름 상태 필터 어휘", () => {
  it("keeps `all` out of the server's alphabet", () => {
    // `all`은 서버의 상태가 아니라 `?status=`의 부재다. 컨트롤이 다섯 값을
    // 말하더라도 요청으로 나가는 것은 넷 아니면 아무것도 아니어야 한다.
    expect(WORKSTREAM_FILTERS).toEqual([
      "all",
      "active",
      "paused",
      "done",
      "cancelled",
    ]);
    expect(workstreamStatusOf("all")).toBeNull();
    expect(workstreamStatusOf("paused")).toBe("paused");
    expect(workstreamFilterOf(null)).toBe("all");
    expect(workstreamFilterOf("done")).toBe("done");
  });

  it("names every value with the same vocabulary the chips use", () => {
    expect(workstreamFilterLabel("all")).toBe("전체");
    for (const status of ["active", "paused", "done", "cancelled"] as const) {
      expect(workstreamFilterLabel(status)).toBe(
        WORKSTREAM_STATUS_LABEL[status]
      );
    }
  });

  it("keeps the tab ids and the v1 test ids apart, on purpose", () => {
    // 게이트가 `workstream-filter-done`으로 서버 필터 왕복을 잡는다. 컨트롤을
    // 공용 탭으로 바꾸면서 엘리먼트 id는 탭 규약을 따르되, test id는 v1이 정한
    // 문자열을 그대로 지킨다.
    for (const value of WORKSTREAM_FILTERS) {
      expect(WORKSTREAM_FILTER_TABS.testId(value)).toBe(
        `workstream-filter-${value}`
      );
      expect(WORKSTREAM_FILTER_TABS.tabId(value)).not.toBe(
        WORKSTREAM_FILTER_TABS.panelId(value)
      );
    }
    expect(WORKSTREAM_FILTER_TABS.values).toBe(WORKSTREAM_FILTERS);
    expect(WORKSTREAM_FILTER_TABS.labelFor).toBe(workstreamFilterLabel);
  });
});
