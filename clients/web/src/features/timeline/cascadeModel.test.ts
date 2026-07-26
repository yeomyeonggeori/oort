import { describe, expect, it } from "vitest";
import type { Message } from "@/lib/api";
import type { CascadeFallbackFrame } from "@/lib/realtime";
import {
  cascadeFor,
  cascadeKey,
  cascadeNoticeText,
  cascadeOrdinal,
  cascadeReasonLabel,
  cascadeRouteText,
  EMPTY_CASCADE,
  mergeCascadeFallback,
  parseCascadeFallback,
  turnRecordRunId,
  type CascadeByRun,
} from "./cascadeModel";

// =============================================================================
// The frame below is `AgentWorker.cascadeFallbackBroadcastPayload` verbatim
// (workers/AgentWorker/Sources/AgentWorker/WorkerService.swift): the worker
// that publishes it has not landed on the server this client talks to, so the
// wire shape is pinned here or nowhere. Two of its properties drive most of
// these tests: `run_id` is a Swift uuidString (UPPERCASE) and may be null, and
// the payload carries redacted endpoint labels, never a URL or a bearer.
// =============================================================================

const RUN_ID = "0199AA11-2222-7000-8000-0000000000C3";

function frame(
  overrides: Partial<CascadeFallbackFrame["payload"]> = {}
): CascadeFallbackFrame {
  return {
    type: "provider.cascade.fallback",
    v: 1,
    ts: 1_785_029_000_000,
    payload: {
      channel_id: "00000000-0000-7000-8000-000000000201",
      run_id: RUN_ID,
      from: 0,
      to: 1,
      reason: "provider_unreachable",
      from_endpoint_label: "api.anthropic.com",
      to_endpoint_label: "gateway.dawn.internal:8443",
      ...overrides,
    },
  };
}

describe("parsing the fallback frame", () => {
  it("folds the run id to lower case, as every id comparison here does", () => {
    expect(parseCascadeFallback(frame())?.runId).toBe(
      "0199aa11-2222-7000-8000-0000000000c3"
    );
  });

  // The worker publishes a null run id when the fallback happened before a run
  // row existed. A notice with nothing to attach to would float free or be
  // pinned to the wrong turn, so it is dropped rather than bucketed.
  it("drops a frame with no run to attach to", () => {
    expect(parseCascadeFallback(frame({ run_id: null }))).toBeNull();
  });

  it("drops a transition that does not move forward", () => {
    expect(parseCascadeFallback(frame({ from: 2, to: 1 }))).toBeNull();
    expect(parseCascadeFallback(frame({ from: 1, to: 1 }))).toBeNull();
  });

  it("keeps the endpoint labels the server sent and invents none", () => {
    const parsed = parseCascadeFallback(frame());
    expect(parsed?.fromEndpointLabel).toBe("api.anthropic.com");
    expect(parsed?.toEndpointLabel).toBe("gateway.dawn.internal:8443");
  });
});

describe("merging (the replay rule)", () => {
  const first = parseCascadeFallback(frame())!;

  // The `ch:` namespace is recoverable, so a reconnect replays the whole gap
  // and this exact frame lands again. Appending it would draw a second
  // fall-over that never happened, so the transition key dedupes it.
  it("is idempotent for the same transition, however often it is replayed", () => {
    let map: CascadeByRun = EMPTY_CASCADE;
    map = mergeCascadeFallback(map, first);
    map = mergeCascadeFallback(map, first);
    map = mergeCascadeFallback(map, first);
    expect(cascadeFor(map, RUN_ID)).toHaveLength(1);
  });

  it("keys a transition the way the server keys its outbox row", () => {
    expect(cascadeKey(first)).toBe(
      "0199aa11-2222-7000-8000-0000000000c3:0-1"
    );
  });

  it("keeps a real second hop and orders hops by where they landed", () => {
    const second = parseCascadeFallback(
      frame({ from: 1, to: 2, reason: "provider_rate_limited" })
    )!;
    let map: CascadeByRun = EMPTY_CASCADE;
    map = mergeCascadeFallback(map, second);
    map = mergeCascadeFallback(map, first);
    expect(cascadeFor(map, RUN_ID).map((f) => f.to)).toEqual([1, 2]);
  });

  it("keeps runs apart", () => {
    const other = parseCascadeFallback(
      frame({ run_id: "0199AA11-2222-7000-8000-0000000000FF" })
    )!;
    let map: CascadeByRun = EMPTY_CASCADE;
    map = mergeCascadeFallback(map, first);
    map = mergeCascadeFallback(map, other);
    expect(cascadeFor(map, RUN_ID)).toHaveLength(1);
    expect(cascadeFor(map, "0199aa11-2222-7000-8000-0000000000ff")).toHaveLength(1);
  });

  it("answers empty for a run it never saw and for no run at all", () => {
    expect(cascadeFor(EMPTY_CASCADE, RUN_ID)).toEqual([]);
    expect(cascadeFor(EMPTY_CASCADE, null)).toEqual([]);
  });
});

describe("which row carries the notice", () => {
  function message(props: Record<string, unknown> | undefined): Message {
    return {
      id: "019f9b10-0000-7000-8000-0000000000a1",
      channelId: "00000000-0000-7000-8000-000000000201",
      seq: 1400,
      hlcTs: 1_785_029_000_000,
      hlcCount: 0,
      authorMemberId: "019f94e3-8b21-7ae0-b3c4-5f1a2d6e7c90",
      type: "text",
      state: "sent",
      createdAtMs: 1_785_029_000_000,
      ...(props ? { props } : {}),
    };
  }

  it("names the run of a settled gateway turn record", () => {
    expect(
      turnRecordRunId(
        message({
          schema: "momo.agent_gateway.timeline.v0",
          source: "hermes_gateway",
          status: "succeeded",
          run_id: RUN_ID,
        })
      )
    ).toBe("0199aa11-2222-7000-8000-0000000000c3");
  });

  // One run writes an approval request, tool rows AND a turn record, and every
  // one of them carries the same run_id. Keying off that would print the same
  // notice three times in one turn.
  it("ignores the other rows of the same run", () => {
    expect(
      turnRecordRunId(message({ approval_id: "abc", run_id: RUN_ID }))
    ).toBeNull();
    expect(turnRecordRunId(message({ tool_name: "bash", run_id: RUN_ID }))).toBeNull();
  });

  it("ignores an ordinary message", () => {
    expect(turnRecordRunId(message(undefined))).toBeNull();
    expect(turnRecordRunId(message({ mention_member_ids: [] }))).toBeNull();
  });
});

describe("copy", () => {
  it("counts the provider link as the first provider", () => {
    expect(cascadeOrdinal(0)).toBe("1차");
    expect(cascadeOrdinal(1)).toBe("2차");
  });

  it("says which provider served the turn and why the first did not", () => {
    expect(cascadeNoticeText([parseCascadeFallback(frame())!])).toBe(
      "2차 프로바이더로 처리됨 (응답 없음)"
    );
  });

  // "3차" alone would hide that two providers were tried and two budgets were
  // touched on the way, which is the fact the ADR asks the UI to surface.
  it("states the transition count when more than one provider was spent", () => {
    const hops = [
      parseCascadeFallback(frame())!,
      parseCascadeFallback(
        frame({ from: 1, to: 2, reason: "provider_rate_limited" })
      )!,
    ];
    expect(cascadeNoticeText(hops)).toBe(
      "3차 프로바이더로 처리됨 (전환 2번, 마지막 사유: 요청 한도 초과)"
    );
  });

  // Absence of a notice is absence of evidence: there is no REST history for
  // this frame, so a session that was not listening has nothing to say and must
  // not claim the turn ran on the first provider.
  it("says nothing at all when no transition was recorded", () => {
    expect(cascadeNoticeText([])).toBeNull();
    expect(cascadeRouteText([])).toBeNull();
  });

  it("translates the classifier's reasons, generated ones included", () => {
    expect(cascadeReasonLabel("provider_unreachable")).toBe("응답 없음");
    expect(cascadeReasonLabel("provider_rate_limited")).toBe("요청 한도 초과");
    expect(cascadeReasonLabel("provider_status_503")).toBe("서버 오류 503");
  });

  it("names an unmapped reason as the server's report, never bare", () => {
    expect(cascadeReasonLabel("brand_new_label")).toBe(
      "서버가 보고한 사유: brand_new_label"
    );
  });

  it("renders the route from the first hop left to the last hop reached", () => {
    const hops = [
      parseCascadeFallback(frame())!,
      parseCascadeFallback(
        frame({ from: 1, to: 2, to_endpoint_label: "backup.dawn.internal" })
      )!,
    ];
    expect(cascadeRouteText(hops)).toBe(
      "api.anthropic.com 에서 backup.dawn.internal 로"
    );
  });

  it("stays silent rather than half-naming a route", () => {
    expect(
      cascadeRouteText([parseCascadeFallback(frame({ to_endpoint_label: "" }))!])
    ).toBeNull();
  });
});
