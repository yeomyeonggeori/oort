import { describe, expect, it } from "vitest";
import type { Message } from "@/lib/api";
import type { CascadeFallbackFrame } from "@/lib/realtime";
import {
  cascadeFor,
  cascadeKey,
  cascadeNoticeText,
  cascadeReasonLabel,
  cascadeRouteText,
  cascadeServedSubject,
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

// =============================================================================
// Which row carries the notice.
//
// Every fixture below is TRANSCRIBED FROM THE EMITTER, not from the ADR. That
// is the whole point of this block: the first version of this module anchored
// the notice on `props.schema === "momo.agent_gateway.timeline.v0"` and was
// green, because the fixture here and the one in scripts/capture-screens.mjs
// were both hand-written gateway turns. The rows that actually carry a cascade
// are written by the WORKER, which never writes that key, so the notice could
// not render on any real turn (2026-07-26 merge review D1/F3).
//
// Provenance of each shape, by file and function:
//   worker turn record   workers/.../WorkerService.swift finalMessageProps
//                        (+ MessageRoutes.messageSource for source_attribution)
//   gateway turn record  server/.../AgentGatewayRoutes.swift timelineProps
//   approval request     workers/.../WorkerService.swift approvalRequestProps
//   tool result          workers/.../WorkerService.swift toolResultProps
//   loop-guard trip      workers/.../WorkerService.swift guardTripProps
// =============================================================================

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

  const TRIGGER_ID = "0199aa11-2222-7000-8000-0000000000d1";

  /**
   * `WorkerService.finalMessageProps` key for key: `run_id` and `source` always,
   * then the four optional keys the mention payload always fills
   * (`MessageRoutes.mentionJobPayload`). There is NO `schema` key, and adding
   * one here would put this fixture back where it started.
   */
  function workerTurnProps(
    overrides: Record<string, unknown> = {}
  ): Record<string, unknown> {
    return {
      run_id: RUN_ID,
      source: "agent_worker.final_text.v0",
      trigger_message_id: TRIGGER_ID,
      trigger_message_seq: 1399,
      author_member_id: "019f94e3-8b21-7ae0-b3c4-5f1a2d6e7c90",
      // `MessageRoutes.messageSource`, carried through the job payload verbatim.
      source_attribution: {
        source_id: `msg_${TRIGGER_ID}`,
        kind: "message",
        // `MessageRoutes.messageSource`'s own title format, transcribed. The
        // marker below is on the value line because the pre-flight filters per
        // line: this is a message seq, not a hex color.
        title: "Message #1399", // design-preflight-allow
        uri: `momo://workspaces/00000000-0000-7000-8000-000000000101/channels/00000000-0000-7000-8000-000000000201/messages/${TRIGGER_ID}`,
        workspace_id: "00000000-0000-7000-8000-000000000101",
        channel_id: "00000000-0000-7000-8000-000000000201",
        message_id: TRIGGER_ID,
        message_seq: 1399,
        author_member_id: "019f94e3-8b21-7ae0-b3c4-5f1a2d6e7c90",
        permission_snapshot: "actor:channel_member agent:channel_member",
        excerpt: "@hermes 이 diff 리뷰 부탁합니다.",
      },
      ...overrides,
    };
  }

  // The row a real cascade lands on. `provider.cascade.fallback` is published by
  // the worker only, and the worker's claim excludes gateway jobs
  // (`AND method <> 'gateway'`, WorkerService.swift:165), so a turn that fell
  // over is by construction a worker turn and never carries `schema`.
  it("names the run of a settled worker turn record", () => {
    expect(turnRecordRunId(message(workerTurnProps()))).toBe(
      "0199aa11-2222-7000-8000-0000000000c3"
    );
  });

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
  //
  // These four fixtures are the dedupe evidence, and they are exhaustive: the
  // worker has exactly four `INSERT INTO message` sites (WorkerService.swift
  // 752 / 1199 / 1453 / 2062) and only the last writes
  // `source: "agent_worker.final_text.v0"`. The other three carry either a
  // different `source` literal or none at all.
  it("ignores the other rows of the same run", () => {
    // approvalRequestProps: approval_id + call_id, no `source` key at all.
    expect(
      turnRecordRunId(
        message({
          approval_id: "0199aa11-2222-7000-8000-0000000000a1",
          run_id: RUN_ID,
          channel_id: "00000000-0000-7000-8000-000000000201",
          action_type: "shell",
          call_id: "call_9f31",
          tool_name: "shell",
          title: "Approve shell",
          summary: "Review the proposed tool call before momo executes it.",
          arguments: { command: "ls" },
          status: "pending",
        })
      )
    ).toBeNull();
    // toolResultProps: `executor`, not `source`.
    expect(
      turnRecordRunId(
        message({
          call_id: "call_9f31",
          tool_name: "shell",
          approval_id: "0199aa11-2222-7000-8000-0000000000a1",
          run_id: RUN_ID,
          payload_sha256: null,
          output: { stdout: "ok" },
          is_error: false,
          executor: "agentworker.resume_approval.v0",
        })
      )
    ).toBeNull();
    // guardTripProps: a `source` key, and a DIFFERENT literal. A prefix match on
    // `agent_worker.` would swallow this row and print the notice twice.
    expect(
      turnRecordRunId(
        message({
          code: "loop_guard_tripped",
          gate: "G2",
          reason: "consecutive auto responses reached the limit",
          run_id: RUN_ID,
          source: "agent_worker.loop_guard.v0",
        })
      )
    ).toBeNull();
  });

  it("ignores an ordinary message", () => {
    expect(turnRecordRunId(message(undefined))).toBeNull();
    expect(turnRecordRunId(message({ mention_member_ids: [] }))).toBeNull();
  });

  // Uppercase in, lowercase out, on the worker path too: Swift `uuidString` is
  // UPPERCASE and `cascadeFor` looks the map up by the folded id.
  it("folds the worker run id to lower case", () => {
    const map = mergeCascadeFallback(EMPTY_CASCADE, parseCascadeFallback(frame())!);
    expect(cascadeFor(map, turnRecordRunId(message(workerTurnProps())))).toHaveLength(1);
  });

  it("drops a settled row that carries no usable run id", () => {
    expect(turnRecordRunId(message(workerTurnProps({ run_id: "" })))).toBeNull();
    expect(turnRecordRunId(message(workerTurnProps({ run_id: null })))).toBeNull();
  });
});

describe("copy", () => {
  it("names the provider that served the turn, never an attempt number", () => {
    expect(cascadeServedSubject(parseCascadeFallback(frame())!)).toBe(
      "gateway.dawn.internal:8443 프로바이더"
    );
  });

  // The bug this replaced: `position + 1` printed an ordinal, and a position is
  // not an ordinal. Deleting a middle hop leaves a permanent gap by design (a
  // position is a credential's identity, settings/chainModel.ts rule 1), so the
  // survivor at position 2 is the SECOND provider tried and the 연결 순서 list
  // labels it "2차" while the frame carries `to: 2`. The old text announced
  // "3차 프로바이더로 처리됨" for a 3차 that does not exist on that screen.
  it("says nothing numeric about a hop that survived a gap-making delete", () => {
    const gapped = parseCascadeFallback(
      frame({ from: 0, to: 2, to_endpoint_label: "backup.dawn.internal" })
    )!;
    const text = cascadeNoticeText([gapped])!;
    expect(text).toBe("backup.dawn.internal 프로바이더로 처리됨 (응답 없음)");
    expect(text).not.toContain("차");
  });

  it("says which provider served the turn and why the first did not", () => {
    expect(cascadeNoticeText([parseCascadeFallback(frame())!])).toBe(
      "gateway.dawn.internal:8443 프로바이더로 처리됨 (응답 없음)"
    );
  });

  // Naming only the survivor would hide that two providers were tried and two
  // budgets were touched on the way, which is the fact the ADR asks for.
  it("states the transition count when more than one provider was spent", () => {
    const hops = [
      parseCascadeFallback(frame())!,
      parseCascadeFallback(
        frame({
          from: 1,
          to: 2,
          reason: "provider_rate_limited",
          to_endpoint_label: "backup.dawn.internal",
        })
      )!,
    ];
    expect(cascadeNoticeText(hops)).toBe(
      "backup.dawn.internal 프로바이더로 처리됨 (전환 2번, 마지막 사유: 요청 한도 초과)"
    );
  });

  // A frame with no label is the one case where nothing can be named. It is
  // hedged, not numbered: "예비" is what is actually known.
  it("hedges rather than numbering when the server sent no label", () => {
    expect(
      cascadeNoticeText([parseCascadeFallback(frame({ to_endpoint_label: "" }))!])
    ).toBe("예비 프로바이더로 처리됨 (응답 없음)");
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

  // The headline already names where the turn landed, so the muted half names
  // the one thing it does not: where it was supposed to run. No space before
  // 에서, matching usageModel/Composer/approvalDecision.
  it("names the provider the cascade left, without a space before the particle", () => {
    const hops = [
      parseCascadeFallback(frame())!,
      parseCascadeFallback(
        frame({ from: 1, to: 2, to_endpoint_label: "backup.dawn.internal" })
      )!,
    ];
    expect(cascadeRouteText(hops)).toBe("api.anthropic.com에서 넘어왔습니다");
  });

  it("stays silent rather than half-naming a route", () => {
    expect(
      cascadeRouteText([
        parseCascadeFallback(frame({ from_endpoint_label: "" }))!,
      ])
    ).toBeNull();
  });
});
