import requestLoopFixture from "./__fixtures__/requestLoop.json";
import { agentRequestBundle } from "./agentCardModel";
import { requestBundleState, REQUEST_BUNDLE_FACE, requestLoopCopyViolations, shouldFoldBundleLine } from "./requestBundle";
import { APPROVAL_OFFLINE_COPY } from "./approvalNote";
import { particleFor, directionParticle } from "../../lib/koreanParticle";
import { describe, expect, it } from "vitest";
import type { Message } from "../../lib/api";
import {
  agentCardModel,
  agentCost,
  cardKeepsBody,
  failureGuidance,
  formatCount,
  formatMicroUsd,
  frameSentence,
  payloadDetail,
  parseApprovalAction,
  parseApprovalStatus,
  resolveApprovalStatus,
  turnStatusFor,
} from "./agentCardModel";
import { NetworkError } from "../../lib/http";
import { interpretReceipt, sendFailureCopy } from "./approvalDecision";

function msg(overrides: Partial<Message> = {}): Message {
  return {
    id: "0199aa00-0000-7000-8000-00000000abcd",
    channelId: "00000000-0000-7000-8000-000000000201",
    seq: 42,
    hlcTs: 1_753_400_000_000,
    hlcCount: 0,
    authorMemberId: "00000000-0000-7000-8000-000000000101",
    type: "text",
    body: "빌드 캐시를 정리했습니다.",
    state: "sent",
    createdAtMs: 1_753_400_000_000,
    ...overrides,
  };
}

// Shape mirrors AgentGatewayRoutes.approvalRequestProps: the public copy sits
// next to `arguments` / `tool_grant`, which is exactly why the allowlist exists.
function approvalProps(extra: Record<string, unknown> = {}) {
  return {
    approval_id: "0199aa11-2222-7000-8000-0000000000a1",
    run_id: "0199aa11-2222-7000-8000-0000000000b2",
    channel_id: "00000000-0000-7000-8000-000000000201",
    action_type: "shell",
    tier: "workspace_write",
    call_id: "call_9f31",
    tool_name: "shell",
    title: "빌드 캐시 정리",
    summary: "빌드 산출물 디렉터리를 지웁니다.",
    arguments: { command: "rm -rf build/", cwd: "/Users/minsu/projects/momo" },
    tool_grant: { grant_id: "g-31", scopes: ["shell:write"] },
    status: "pending",
    source: "hermes_gateway",
    ...extra,
  };
}

describe("approval card (f399e417:clients/web-legacy basic-mode vocabulary)", () => {
  it("parses only the public fields and counts the opaque ones", () => {
    const card = agentCardModel(
      msg({ type: "approval_request", props: approvalProps() })
    );
    expect(card?.kind).toBe("approval");
    if (card?.kind !== "approval") return;
    expect(card.title).toBe("빌드 캐시 정리");
    expect(card.summary).toBe("빌드 산출물 디렉터리를 지웁니다.");
    expect(card.status).toBe("pending");
    expect(card.isResumeOffer).toBe(false);

    // arguments / tool_grant / call_id are opaque: they appear nowhere in the
    // rendered rows, and they are counted so the card can admit to them.
    const rendered = JSON.stringify(card);
    expect(rendered).not.toContain("rm -rf");
    expect(rendered).not.toContain("tool_grant");
    expect(rendered).not.toContain("call_9f31");
    expect(card.detail.withheld).toBe(3); // arguments, tool_grant, call_id
    expect(card.detail.rows).toEqual([
      { label: "동작", value: "shell" },
      { label: "도구", value: "shell" },
      // Wire vocabulary is translated, never printed raw.
      { label: "권한", value: "워크스페이스 쓰기" },
    ]);
  });

  it("is not a card when there is neither an approval id nor a resume offer", () => {
    const props = approvalProps();
    delete (props as Record<string, unknown>)["approval_id"];
    expect(agentCardModel(msg({ type: "approval_request", props }))).toBeNull();
  });

  it("keeps a resume offer that carries no approval id", () => {
    const card = agentCardModel(
      msg({
        type: "approval_request",
        props: { kind: "resume_offer", title: "이어서 진행할까요?" },
      })
    );
    expect(card?.kind).toBe("approval");
    if (card?.kind !== "approval") return;
    expect(card.isResumeOffer).toBe(true);
    expect(card.approvalId).toBeNull();
    expect(card.title).toBe("새 호스트에서 재개");
  });

  it("falls back to the message body when the server sent no title", () => {
    const props = approvalProps();
    delete (props as Record<string, unknown>)["title"];
    const card = agentCardModel(
      msg({ type: "approval_request", body: "승인 필요: shell", props })
    );
    expect(card?.kind === "approval" && card.title).toBe("승인 필요: shell");
  });

  it("reads the server decision patch (approval_status wins over status)", () => {
    const card = agentCardModel(
      msg({
        type: "approval_request",
        props: approvalProps({
          approval_status: "approved",
          status: "pending",
          decided_by: "00000000-0000-7000-8000-000000000102",
          decided_at_ms: 1_753_400_060_000,
          decision_reason: "빌드가 막혀 있어 즉시 승인",
        }),
      })
    );
    expect(card?.kind === "approval" && card.status).toBe("approved");
    if (card?.kind !== "approval") return;
    expect(card.decidedByMemberId).toBe(
      "00000000-0000-7000-8000-000000000102"
    );
    expect(card.decidedAtMs).toBe(1_753_400_060_000);
    expect(card.detail.rows).toContainEqual({
      label: "결정 사유",
      value: "빌드가 막혀 있어 즉시 승인",
    });
  });

  it("surfaces the public risk and estimate the server hoisted", () => {
    const card = agentCardModel(
      msg({
        type: "approval_request",
        props: approvalProps({
          is_reversible: false,
          estimated_micro_usd: 12_400,
        }),
      })
    );
    if (card?.kind !== "approval") throw new Error("expected an approval card");
    expect(card.isReversible).toBe(false);
    expect(card.estimatedMicroUsd).toBe(12_400);
    expect(card.detail.rows).toContainEqual({ label: "되돌리기", value: "불가" });
  });

  it("never repeats the body under an approval card", () => {
    const card = agentCardModel(
      msg({ type: "approval_request", props: approvalProps() })
    );
    expect(card && cardKeepsBody(card)).toBe(false);
  });
});

describe("스폰 승인의 호스트 후보 (ADR-0125 D6-A, #1114)", () => {
  // 서버가 `execution`을 payload뿐 아니라 **props에도** 싣는 이유가 이 갈래다:
  // 클라이언트가 브로드캐스트된 메시지 하나로 라디오를 그릴 수 있어야, 카드가
  // 첫 라디오를 그리기 전에 승인 프로젝션을 한 번 더 읽지 않는다.
  const execution = {
    kind: "work_session_spawn",
    tool: "codex",
    label: "리팩터링",
    default_host_id: "0199aa11-2222-7000-8000-0000000000c1",
    host_candidates: [
      {
        host_id: "0199aa11-2222-7000-8000-0000000000c1",
        display_name: "내 맥",
        host_type: "app",
        tier: "local",
        scope: "member",
        online: true,
        selectable: true,
        unavailable_reason: null,
      },
      {
        host_id: "0199aa11-2222-7000-8000-0000000000c2",
        display_name: "momo Cloud",
        host_type: "cloud",
        tier: "cloud",
        scope: "workspace",
        online: true,
        selectable: false,
        unavailable_reason: "t3_disabled",
      },
    ],
  };

  it("카드 스냅샷에서 후보를 읽는다 — 두 번째 fetch 없이", () => {
    const card = agentCardModel(
      msg({ type: "approval_request", props: approvalProps({ execution }) })
    );
    expect(card?.kind).toBe("approval");
    if (card?.kind !== "approval") return;
    expect(card.execution?.defaultHostId).toBe(
      "0199aa11-2222-7000-8000-0000000000c1"
    );
    expect(card.execution?.candidates.map((c) => c.selectable)).toEqual([
      true,
      false,
    ]);
  });

  it("픽커가 없는 승인은 `execution`이 null이다 — 압도적 다수", () => {
    const card = agentCardModel(
      msg({ type: "approval_request", props: approvalProps() })
    );
    if (card?.kind !== "approval") throw new Error("승인 카드가 아니다");
    expect(card.execution).toBeNull();
  });

  it("그리는 것을 숨겼다고 말하지 않는다 — `execution`은 withheld가 아니다", () => {
    // 이 단정이 지키는 것은 카드의 정직성이다: 라디오를 화면에 그려 놓고
    // "숨김 N개"에 그것을 세면, 카드가 보여주고 있는 것을 숨기고 있다고 말한다.
    const withExecution = payloadDetail({ title: "정리", execution });
    const withoutExecution = payloadDetail({ title: "정리" });
    expect(withExecution.withheld).toBe(withoutExecution.withheld);
    // 그렇다고 후보가 원본 데이터 행으로 새어 나가지도 않는다.
    expect(withExecution.rows).toEqual([]);
  });

  it("`target_host_id`는 여전히 불투명하다 — 이름 없는 id는 결정의 재료가 아니다", () => {
    const detail = payloadDetail({ execution, target_host_id: "h-1" });
    expect(detail.withheld).toBe(1);
  });
});

describe("approval status resolution", () => {
  it("accepts only the five PG enum values", () => {
    for (const value of [
      "pending",
      "approved",
      "rejected",
      "expired",
      "cancelled",
    ]) {
      expect(parseApprovalStatus(value)).toBe(value);
    }
    expect(parseApprovalStatus("idempotency_conflict")).toBeNull();
    expect(parseApprovalStatus(undefined)).toBeNull();
  });

  it("lets a settled local receipt win over a stale pending message", () => {
    expect(resolveApprovalStatus("approved", "pending")).toBe("approved");
  });

  it("lets a settled message win when nothing is known locally", () => {
    expect(resolveApprovalStatus(null, "rejected")).toBe("rejected");
  });

  it("never downgrades a settled local status to pending", () => {
    expect(resolveApprovalStatus("rejected", "pending")).toBe("rejected");
    expect(resolveApprovalStatus("pending", "pending")).toBe("pending");
  });
});

describe("turn status lifecycle", () => {
  it("maps the run_status enum onto the chip lifecycle", () => {
    expect(turnStatusFor("queued")).toBe("queued");
    expect(turnStatusFor("running")).toBe("thinking");
    expect(turnStatusFor("streaming")).toBe("streaming");
    expect(turnStatusFor("awaiting_approval")).toBe("awaiting-approval");
    expect(turnStatusFor("succeeded")).toBe("done");
    expect(turnStatusFor("failed")).toBe("error");
  });

  it("never promotes silence to failure", () => {
    // ADR-0132: a timeout or a pause is an absence of news, not a failure.
    expect(turnStatusFor("timed_out")).toBe("stalled");
    expect(turnStatusFor("paused")).toBe("stalled");
    expect(turnStatusFor("cancelled")).toBe("cancelled");
  });

  it("leaves an unknown server status unknown", () => {
    expect(turnStatusFor("weird")).toBeNull();
    expect(turnStatusFor(7)).toBeNull();
  });
});

describe("tool card", () => {
  it("frames a settled tool_result as did X to Y, arriving at Z", () => {
    const card = agentCardModel(
      msg({
        type: "tool_result",
        body: "3개 디렉터리 삭제",
        props: {
          call_id: "call_9f31",
          tool_name: "shell",
          approval_id: "0199aa11-2222-7000-8000-0000000000a1",
          run_id: "0199aa11-2222-7000-8000-0000000000b2",
          payload_sha256: "sha256:deadbeef",
          output: { stdout: "removed 3 directories" },
          is_error: false,
          executor: "agentworker.resume_approval.v0",
          label: "빌드 캐시",
        },
      })
    );
    expect(card?.kind).toBe("tool");
    if (card?.kind !== "tool") return;
    expect(card.status).toBe("done");
    expect(card.title).toBe("shell 실행");
    expect(frameSentence(card.frame)).toBe(
      "shell 실행, 빌드 캐시 → 3개 디렉터리 삭제"
    );
    // Raw tool output never reaches the card.
    expect(JSON.stringify(card)).not.toContain("removed 3 directories");
    expect(card.detail.withheld).toBe(4); // call_id, payload_sha256, output, executor
  });

  it("marks a failed tool_result as error", () => {
    const card = agentCardModel(
      msg({
        type: "tool_result",
        body: "권한이 없습니다.",
        props: { tool_name: "shell", is_error: true },
      })
    );
    expect(card?.kind === "tool" && card.status).toBe("error");
  });

  it("treats a rejected tool_result as cancelled, not as a failure", () => {
    const card = agentCardModel(
      msg({
        type: "tool_result",
        body: "Tool call rejected by human approval.",
        props: { status: "rejected", is_error: true },
      })
    );
    expect(card?.kind === "tool" && card.status).toBe("cancelled");
  });

  it("shows a tool_call as in flight when the server named no status", () => {
    const card = agentCardModel(
      msg({ type: "tool_call", body: undefined, props: { tool_name: "shell" } })
    );
    expect(card?.kind === "tool" && card.status).toBe("thinking");
  });

  it("reads the server's error text, the same prop the turn record reads", () => {
    // A tool whose BODY is the artifact it tried to write has nowhere else to
    // carry the reason it failed, and the artifact card hoists this note.
    const card = agentCardModel(
      msg({
        type: "tool_result",
        body: "diff --git a/x b/x",
        props: {
          tool_name: "apply_patch",
          is_error: true,
          error: "패치가 3번째 hunk에서 충돌했습니다.",
        },
      })
    );
    expect(card?.kind === "tool" && card.errorNote).toBe(
      "패치가 3번째 hunk에서 충돌했습니다."
    );
  });

  it("leaves errorNote absent when the server sent none", () => {
    const card = agentCardModel(
      msg({ type: "tool_result", body: "완료", props: { tool_name: "shell" } })
    );
    expect(card?.kind === "tool" && "errorNote" in card).toBe(false);
  });
});

describe("turn record and cost", () => {
  const usageProps = {
    schema: "momo.agent_gateway.timeline.v0",
    source: "hermes_gateway",
    status: "succeeded",
    run_id: "0199aa11-2222-7000-8000-0000000000b2",
    agent_member_id: "00000000-0000-7000-8000-000000000101",
    usage: {
      model: "claude-opus-4",
      prompt_tokens: 1240,
      completion_tokens: 380,
      cost_micro_usd: 12_000,
      was_estimated: false,
    },
  };

  it("is not a card for ordinary agent prose", () => {
    expect(agentCardModel(msg())).toBeNull();
    expect(agentCardModel(msg({ props: {} }))).toBeNull();
  });

  it("is not a card for a succeeded turn that carries no cost", () => {
    expect(
      agentCardModel(
        msg({ props: { schema: "momo.agent_gateway.timeline.v0", status: "succeeded" } })
      )
    ).toBeNull();
  });

  it("reads the settled usage the server recorded", () => {
    const card = agentCardModel(msg({ props: usageProps }));
    expect(card?.kind).toBe("turn");
    if (card?.kind !== "turn") return;
    expect(card.status).toBe("done");
    expect(card.cost).toEqual({
      model: "claude-opus-4",
      promptTokens: 1240,
      completionTokens: 380,
      costMicroUsd: 12_000,
      estimated: false,
    });
    // The agent's own sentence stays above the record instead of being eaten.
    expect(cardKeepsBody(card)).toBe(true);
  });

  it("keeps the sanitised failure text and says nothing more", () => {
    const card = agentCardModel(
      msg({
        type: "system",
        body: "Hermes gateway failed before producing a final response.",
        props: {
          schema: "momo.agent_gateway.timeline.v0",
          status: "failed",
          error: "upstream provider returned 503",
        },
      })
    );
    expect(card?.kind).toBe("turn");
    if (card?.kind !== "turn") return;
    expect(card.status).toBe("error");
    expect(card.errorNote).toBe("upstream provider returned 503");
  });

  it("returns no cost when usage is absent or empty", () => {
    expect(agentCost(undefined)).toBeNull();
    expect(agentCost({ usage: {} })).toBeNull();
    expect(agentCost({ usage: "nope" })).toBeNull();
  });
});

// goal B8 H2. The worker's failure notice used to arrive as
// `props.error = "provider answered with HTTP 401 {\"error\":...}"` and the card
// printed it verbatim under an 오류 label. It now arrives as a machine code and
// the copy is ours.
describe("provider failure notice (goal B8 H2)", () => {
  const failureProps = {
    run_id: "0199aa11-2222-7000-8000-0000000000b2",
    source: "agent_worker.provider_failure.v0",
    error_code: "provider_failed",
  };

  it("still earns a card, with a failed status", () => {
    const card = agentCardModel(
      msg({ body: "지금은 답변을 만들지 못했습니다.", props: failureProps })
    );
    expect(card?.kind).toBe("turn");
    if (card?.kind !== "turn") return;
    expect(card.status).toBe("error");
    expect(card.failure?.label).toContain("AI 제공자");
    // The body is the server's own Korean sentence and stays above the card.
    expect(cardKeepsBody(card)).toBe(true);
  });

  it("says where the provider's own words went, rather than pretending", () => {
    const detail = failureGuidance("provider_failed")?.detail ?? "";
    expect(detail).toContain("실행 기록");
    // …and names only what the server keeps. The worker writes no audit_log row
    // on this path, so promising one would send a reader looking for evidence
    // that is not there.
    expect(detail).not.toContain("감사");
  });

  it("tells a dead credential apart from a dead provider", () => {
    const auth = failureGuidance("provider_auth_failed");
    const generic = failureGuidance("provider_failed");
    expect(auth?.label).not.toBe(generic?.label);
    expect(auth?.detail).toContain("AI 화면에서");
    // The fold must not repeat the sentence the body already said 40px above.
    expect(generic?.detail).not.toContain("다시 멘션");
  });

  it("still says something for a code this build has never seen", () => {
    const unknown = failureGuidance("some_future_code");
    expect(unknown?.label).toBeTruthy();
    expect(unknown?.detail).toContain("실행 기록");
    // …without inventing a repair OR a source. An unknown code may be a work
    // host or a policy: "AI을 확인하세요" would be a confidently wrong
    // instruction, and "AI 제공자가 보낸 원문" a confidently wrong attribution,
    // which sends a reader looking for provider output that does not exist.
    expect(unknown?.detail).not.toContain("AI 화면에서");
    expect(unknown?.detail).not.toContain("AI 제공자");
    expect(unknown?.detail).toContain("실행 기록");
    // The key is server data, so the lookup must not answer for Object's own
    // members: an object-literal map would return a function here and the card
    // would render `undefined` where its label goes.
    expect(failureGuidance("constructor")?.label).toBe(unknown?.label);
    expect(failureGuidance("__proto__")?.label).toBe(unknown?.label);
  });

  it("is nothing at all when the server sent no code", () => {
    expect(failureGuidance(undefined)).toBeNull();
    expect(failureGuidance("")).toBeNull();
    expect(failureGuidance(42)).toBeNull();
  });

  // The code is a branch key, never copy: an English identifier on a Korean
  // timeline is exactly the internal vocabulary this ticket removed.
  it("never renders the code itself, not even behind the disclosure", () => {
    const card = agentCardModel(msg({ props: failureProps }));
    if (card?.kind !== "turn") throw new Error("expected a turn card");
    expect(card.failure?.label).not.toContain("provider_failed");
    expect(card.failure?.detail).not.toContain("provider_failed");
    const rendered = card.detail.rows.map((row) => row.value).join(" ");
    expect(rendered).not.toContain("provider_failed");
  });

  it("keeps reading a legacy emitter's `error` string", () => {
    // The Swift worker and the gateway still write `error`; dropping that read
    // would blank their failure rows on this client.
    const card = agentCardModel(
      msg({ props: { run_id: "0199aa11-2222-7000-8000-0000000000b2", error: "rate limited" } })
    );
    if (card?.kind !== "turn") throw new Error("expected a turn card");
    expect(card.status).toBe("error");
    expect(card.errorNote).toBe("rate limited");
  });
});

describe("number formatting", () => {
  it("groups token counts", () => {
    expect(formatCount(1240)).toBe("1,240");
    expect(formatCount(380)).toBe("380");
    expect(formatCount(1_234_567)).toBe("1,234,567");
  });

  it("prints micro USD without pretending a real charge was free", () => {
    expect(formatMicroUsd(0)).toBe("$0");
    expect(formatMicroUsd(12_000)).toBe("$0.012");
    expect(formatMicroUsd(1_500_000)).toBe("$1.50");
    expect(formatMicroUsd(12_345_678)).toBe("$12.35");
    expect(formatMicroUsd(400)).toBe("$0.001 미만");
  });
});

describe("payload redaction", () => {
  it("counts every key it refuses to interpret", () => {
    const detail = payloadDetail({
      title: "정리",
      arguments: { command: "rm -rf build/" },
      tool_grant: {},
      target_host_id: "h-1",
      control_id: "c-1",
    });
    expect(detail.withheld).toBe(4);
    expect(detail.rows).toEqual([]);
  });

  it("never emits two rows under the same label", () => {
    const detail = payloadDetail({ tool_name: "shell", tool: "shell" });
    expect(detail.rows).toEqual([{ label: "도구", value: "shell" }]);
  });
});

describe("decision receipt semantics", () => {
  const receipt = (status: string) => ({
    approval_id: "0199aa11-2222-7000-8000-0000000000a1",
    status,
    decided_by: "00000000-0000-7000-8000-000000000102",
    decided_at_ms: 1_753_400_060_000,
    decision_reason: null,
  });

  it("commits a 200", () => {
    expect(interpretReceipt(200, receipt("approved"))).toEqual({
      kind: "committed",
      status: "approved",
      decidedAtMs: 1_753_400_060_000,
      decidedByMemberId: "00000000-0000-7000-8000-000000000102",
    });
  });

  it("treats a settled 409 as a normal transition, not an error", () => {
    const outcome = interpretReceipt(409, receipt("rejected"));
    expect(outcome.kind).toBe("superseded");
    expect(outcome.status).toBe("rejected");
    expect(outcome.note).toBe("다른 곳에서 이미 결정됐어요.");
  });

  it("names expiry for what it is", () => {
    expect(interpretReceipt(409, receipt("expired")).note).toBe(
      "결정 전에 만료됐어요."
    );
  });

  it("flags an idempotency conflict so the retry mints a fresh key", () => {
    const outcome = interpretReceipt(409, receipt("idempotency_conflict"));
    expect(outcome.kind).toBe("error");
    expect(outcome.errorCode).toBe("idempotency_conflict");
  });

  it("never lets a decision that got no answer read as recorded", () => {
    // MOMO-609: the request either reached the server or it did not, and the
    // two absences point at different next moves. Neither is "it was recorded".
    expect(sendFailureCopy(new NetworkError("timeout", 15_000))).toContain(
      "보내지 못했어요"
    );
    expect(sendFailureCopy(new NetworkError("unreachable", 15_000))).toContain(
      "닿지 못했어요"
    );
  });

  it("says what a 403 and a 404 mean without apologising", () => {
    expect(interpretReceipt(403, receipt("forbidden")).errorCopy).toContain(
      "권한이 없어요"
    );
    expect(interpretReceipt(404, receipt("not_found")).errorCopy).toContain(
      "찾지 못했어요"
    );
  });
});

// ---- ADR-0186 부록 A: 승인 카드의 행동 블록 --------------------------------

/** 부록 A 샘플 그대로. 서버(AX-3a/3b)가 아직 없으므로 이것이 계약이다. */
const APPENDIX_A_ACTION = {
  id: "invite.create",
  rows: [
    { label: "역할", value: "member" },
    { label: "사용 횟수", value: "1회" },
    { label: "만료", value: "7일" },
  ],
  rationale: "새 팀원 온보딩 요청",
  required_role: "admin",
};

describe("승인 카드의 행동 블록 (ADR-0186 부록 A)", () => {
  it("부록 A 샘플을 행·사유·필요 역할로 읽는다", () => {
    const card = agentCardModel(
      msg({
        type: "approval_request",
        props: approvalProps({
          action_type: "workspace_action",
          title: "팀원 초대 링크 만들기",
          action: APPENDIX_A_ACTION,
        }),
      })
    );
    if (card?.kind !== "approval") throw new Error("not an approval card");
    expect(card.action).toEqual({
      id: "invite.create",
      rows: [
        { label: "역할", value: "member" },
        { label: "사용 횟수", value: "1회" },
        { label: "만료", value: "7일" },
      ],
      omittedRows: 0,
      rationale: "새 팀원 온보딩 요청",
      requiredRole: "admin",
    });
  });

  it("블록을 그리는 카드는 그것을 숨김으로 세지 않는다", () => {
    const card = agentCardModel(
      msg({
        type: "approval_request",
        props: {
          approval_id: "0199aa11-2222-7000-8000-0000000000a1",
          action_type: "workspace_action",
          title: "팀원 초대 링크 만들기",
          summary: "hermes가 제안했습니다.",
          status: "pending",
          action: APPENDIX_A_ACTION,
        },
      })
    );
    if (card?.kind !== "approval") throw new Error("not an approval card");
    expect(card.detail.withheld).toBe(0);
  });

  it("블록이 없으면 도구 호출 승인 그대로다 (회귀 0)", () => {
    const card = agentCardModel(
      msg({ type: "approval_request", props: approvalProps() })
    );
    if (card?.kind !== "approval") throw new Error("not an approval card");
    expect(card.action).toBeNull();
    expect(card.title).toBe("빌드 캐시 정리");
  });

  it("id 없는 블록은 블록이 아니다 — 이름 없는 행동을 허가시키지 않는다", () => {
    expect(parseApprovalAction({ rows: APPENDIX_A_ACTION.rows })).toBeNull();
    expect(parseApprovalAction("invite.create")).toBeNull();
    expect(parseApprovalAction(null)).toBeNull();
  });

  it("모양이 어긋난 행은 버리고 개수로 남긴다", () => {
    const action = parseApprovalAction({
      id: "invite.create",
      rows: [{ label: "역할", value: "member" }, { label: "만료" }, 7],
    });
    expect(action?.rows).toEqual([{ label: "역할", value: "member" }]);
    expect(action?.omittedRows).toBe(2);
    expect(action?.rationale).toBeNull();
    expect(action?.requiredRole).toBeNull();
  });

  it("`workspace_action` 은 접힘에서 enum 이 아니라 낱말로 읽힌다", () => {
    const detail = payloadDetail({ action_type: "workspace_action" });
    expect(detail.rows).toContainEqual({
      label: "동작",
      value: "워크스페이스 행동",
    });
    // 모르는 값은 원문 그대로 지나간다(감추지 않는다).
    expect(payloadDetail({ action_type: "shell" }).rows).toContainEqual({
      label: "동작",
      value: "shell",
    });
  });
});

describe("승인 카드의 기한·요청자 (#3738)", () => {
  it("props.expires_at_ms 와 작성자·채널을 카드에 싣는다", () => {
    const card = agentCardModel(
      msg({
        type: "approval_request",
        props: approvalProps({ expires_at_ms: 1_753_403_600_000 }),
      })
    );
    expect(card?.kind).toBe("approval");
    if (card?.kind !== "approval") return;
    expect(card.expiresAtMs).toBe(1_753_403_600_000);
    expect(card.requestedByMemberId).toBe("00000000-0000-7000-8000-000000000101");
    expect(card.channelId).toBe("00000000-0000-7000-8000-000000000201");
  });

  it("기한이 없으면 칸 자체가 없다", () => {
    const card = agentCardModel(
      msg({ type: "approval_request", props: approvalProps() })
    );
    if (card?.kind !== "approval") throw new Error("approval card expected");
    expect(card.expiresAtMs).toBeUndefined();
  });
});


describe("먼저 제안 카드와 고정 카드의 읽기 (ADR-0186 증보 v5 U-c·U-e, #4705)", () => {
  const AGENT = "019f9a01-0000-7000-8000-000000000401";
  const PIN_PREVIEW = {
    kind: "message",
    messageId: "0199aa11-2222-7000-8000-0000000000c1",
    channelId: "00000000-0000-7000-8000-000000000202",
    totalChars: 1234,
    truncated: true,
  };
  const PIN_ACTION = {
    id: "message.pin",
    rows: [
      { label: "채널", value: "#qa" },
      { label: "글자 수", value: "1234자" },
    ],
    rationale: "안내문을 채널 맨 위에 두고 싶어요",
    required_role: "admin",
    preview: PIN_PREVIEW,
  };

  function pinCard(extra: Record<string, unknown> = {}, action: unknown = PIN_ACTION) {
    const card = agentCardModel(
      msg({
        type: "approval_request",
        authorMemberId: AGENT,
        props: approvalProps({
          action_type: "workspace_action",
          title: "메시지 고정",
          action,
          ...extra,
        }),
      })
    );
    if (card?.kind !== "approval") throw new Error("approval card expected");
    return card;
  }

  it("props.origin 이 agent_initiated 이면 표시 키가 서고, 제안자는 카드 작성자다", () => {
    const card = pinCard({ origin: "agent_initiated" });
    expect(card.agentInitiated).toBe(true);
    expect(card.requestedByMemberId).toBe(AGENT);
  });

  it("origin 이 없거나 모르는 값이면 표시 키 자체가 없다(카드는 지금까지 그대로)", () => {
    expect("agentInitiated" in pinCard()).toBe(false);
    expect("agentInitiated" in pinCard({ origin: "scheduled" })).toBe(false);
    expect("agentInitiated" in pinCard({ origin: "AGENT_INITIATED" })).toBe(false);
    expect("agentInitiated" in pinCard({ origin: true })).toBe(false);
  });

  it("알아본 origin 은 카드가 그리는 키라 숨김으로 세지 않고, 모르는 origin 은 지금처럼 센다", () => {
    const without = pinCard();
    expect(pinCard({ origin: "agent_initiated" }).detail.withheld).toBe(
      without.detail.withheld
    );
    // 인플레이스 카드의 origin 처럼 이 빌드가 읽지 않는 값은 정직 카운트에 남는다.
    expect(pinCard({ origin: "server_in_place" }).detail.withheld).toBe(
      without.detail.withheld + 1
    );
  });

  it("고정 카드의 대상 메시지를 읽고, 서버 행은 그대로 둔다", () => {
    const card = pinCard({ origin: "agent_initiated" });
    expect(card.action?.messagePreview).toEqual(PIN_PREVIEW);
    expect(card.action?.rows).toEqual(PIN_ACTION.rows);
    // 사진 미리보기와 갈린다: 같은 `preview` 칸이지만 `kind` 가 열쇠다.
    expect(card.action?.preview).toBeUndefined();
  });

  it("모르는 preview kind·어긋난 모양이면 미리보기 키가 없고 행은 그대로다", () => {
    const wrongKind = pinCard({}, { ...PIN_ACTION, preview: { ...PIN_PREVIEW, kind: "thread" } });
    expect(wrongKind.action?.messagePreview).toBeUndefined();
    expect(wrongKind.action?.rows).toHaveLength(2);
    const noIds = pinCard({}, { ...PIN_ACTION, preview: { kind: "message", totalChars: 3 } });
    expect(noIds.action?.messagePreview).toBeUndefined();
    const notObject = pinCard({}, { ...PIN_ACTION, preview: "message" });
    expect(notObject.action?.messagePreview).toBeUndefined();
  });

  it("글자 수를 모르는 미리보기는 totalChars 가 null 이고, 수를 지어내지 않는다", () => {
    const attachmentOnly = pinCard(
      {},
      { ...PIN_ACTION, preview: { ...PIN_PREVIEW, totalChars: null, truncated: false } }
    );
    expect(attachmentOnly.action?.messagePreview?.totalChars).toBeNull();
    const negative = pinCard({}, { ...PIN_ACTION, preview: { ...PIN_PREVIEW, totalChars: -1 } });
    expect(negative.action?.messagePreview?.totalChars).toBeNull();
  });
});

describe("만료 스윕이 남긴 줄 (검수 L4, #4705)", () => {
  const SWEEP_PROPS = {
    call_id: "",
    output: "Tool call expired without a human approval.",
    is_error: true,
    approval_id: "0199aa11-2222-7000-8000-0000000000a1",
    run_id: "0199aa11-2222-7000-8000-0000000000b2",
    status: "expired",
    decided_at_ms: 1_753_400_000_000,
  };

  it("영어 본문과 is_error 로 와도 중립의 만료 줄로 읽는다(실패 칩이 아니다)", () => {
    const card = agentCardModel(
      msg({ type: "tool_result", body: SWEEP_PROPS.output, props: SWEEP_PROPS })
    );
    if (card?.kind !== "tool") throw new Error("tool card expected");
    expect(card.approvalExpired).toBe(true);
    expect(card.status).not.toBe("error");
    expect(card.frame.outcome).not.toBe(SWEEP_PROPS.output);
    expect(card.frame.outcome).toMatch(/[가-힣]/);
    // 서버의 영어 본문이 카드 위에 한 번 더 서지 않는다.
    expect(cardKeepsBody(card)).toBe(false);
    // 조용한 한 줄: 「표시하지 않은 항목 N개」도, 펼칠 원본도 없다.
    expect(card.detail).toEqual({ rows: [], withheld: 0 });
  });

  it("서버가 이미 한국어로 쓴 만료 줄(인플레이스 카드)은 그 문장을 그대로 두고 칩만 중립이다", () => {
    const korean = "시간이 지나 요청을 처리하지 않았어요. 다시 불러 주세요.";
    const card = agentCardModel(
      msg({
        type: "tool_result",
        body: korean,
        props: { ...SWEEP_PROPS, output: korean },
      })
    );
    if (card?.kind !== "tool") throw new Error("tool card expected");
    expect(card.approvalExpired).toBe(true);
    expect(card.status).not.toBe("error");
    // 다음 행동(「다시 불러 주세요」)을 일반 문장으로 덮지 않는다.
    expect(card.frame.outcome).toBe(korean);
  });

  it("본문이 비어 있으면 한국어 기본 한 줄이다", () => {
    const card = agentCardModel(
      msg({ type: "tool_result", body: undefined, props: { ...SWEEP_PROPS, output: "" } })
    );
    if (card?.kind !== "tool") throw new Error("tool card expected");
    expect(card.approvalExpired).toBe(true);
    expect(card.frame.outcome).toMatch(/[가-힣]/);
    expect(card.frame.outcome).not.toBe("");
  });

  it("어느 승인의 줄인지 모르거나 expired 가 아니면 지금까지의 도구 카드다", () => {
    const noApproval = agentCardModel(
      msg({
        type: "tool_result",
        body: "boom",
        props: { call_id: "c1", output: "boom", is_error: true, status: "expired" },
      })
    );
    if (noApproval?.kind !== "tool") throw new Error("tool card expected");
    expect("approvalExpired" in noApproval).toBe(false);
    expect(noApproval.status).toBe("error");

    const plainError = agentCardModel(
      msg({
        type: "tool_result",
        body: "boom",
        props: { ...SWEEP_PROPS, status: "failed", output: "boom" },
      })
    );
    if (plainError?.kind !== "tool") throw new Error("tool card expected");
    expect("approvalExpired" in plainError).toBe(false);
    expect(plainError.status).toBe("error");
  });
});

// 요청 고리: 별도 줄을 기다리지 않고 카드 한 장의 공개 props만 읽어요.
describe("요청 묶음", () => {
  const nowMs = 1_800_000_000_000;
  const names: Record<string, string> = { agent: "달무리봇", human: "김인턴", other: "박연구원" };
  const context = { nowMs, nameFor: (id: string) => names[id], viewerMemberId: "human", viewerKind: "human" as const, canDecide: true };
  const message = (props: Record<string, unknown> = {}) => msg({ type: "approval_request", authorMemberId: "agent", props: { approval_id: "approval", action_type: "tool_call", tool_name: "shell", status: "pending", ...props } });

  it("승인 다섯 상태 × run 아홉 단계 × 종료 코드 여섯 × 승인 두 종류에서 정확히 한 상태와 얼굴을 낸다", () => {
    const phases = ["queued", "claimed", "running", "awaiting_approval", "paused", "succeeded", "failed", "timed_out", "cancelled"] as const;
    const endReasons = [undefined, "approval_rejected", "approval_expired", "agent_error", "human_cancelled", "lease_abandoned"];
    const statusEnds = { rejected: "declined", expired: "expired", cancelled: "cancelled" } as const;
    const faces = {
      thinking: ["생각 중", "CircleDot", "working"], approval: ["승인 필요", "ShieldQuestion", "warn"],
      executing: ["실행 중", "CircleDot", "working"], done: ["끝", "Check", "ok"],
      declined: ["거부", "Ban", "muted"], expired: ["만료", "Clock", "warn"],
      failed: ["실패", "CircleX", "danger"], cancelled: ["취소", "Octagon", "muted"],
    };
    const seen = new Set<string>();
    for (const status of ["pending", "approved", "rejected", "expired", "cancelled"] as const) {
      for (const phase of phases) for (const endReason of endReasons) for (const actionType of ["workspace_action", "tool_call"]) {
        const terminal = ["succeeded", "failed", "timed_out", "cancelled"].includes(phase);
        const ending = terminal ? ({ approval_rejected: "declined", approval_expired: "expired" } as Record<string, string>)[endReason ?? ""] : undefined;
        const phaseEnd = ({ succeeded: "done", failed: "failed", cancelled: "cancelled" } as Record<string, string>)[phase];
        const approved = actionType === "tool_call" && !terminal ? "executing" : "done";
        const expected = status === "pending" || status === "approved"
          ? ending ?? phaseEnd ?? (status === "approved" ? approved : "approval") : statusEnds[status];
        const state = requestBundleState({ status, actionType, run: { phase, endReason } });
        expect(state, `${status}/${phase}/${endReason}/${actionType}`).toBe(expected);
        const face = REQUEST_BUNDLE_FACE[state];
        expect([face.word, face.icon, face.tone]).toEqual(faces[state]);
        seen.add(state);
      }
    }
    seen.add(requestBundleState({}));
    expect([...seen].sort()).toEqual(Object.keys(faces).sort());
  });

  it("도구·행동 모두 코드와 result만으로 종결하고 옛 영어 본문을 한국어로 말한다", () => {
    for (const action_type of ["tool_call", "workspace_action"]) {
      const extra = action_type === "workspace_action" ? { action: { id: "channel.create", rows: [] } } : {};
      for (const [status, expected, sentence] of [
        ["rejected", "declined", "김인턴 님이 거부했어요"],
        ["expired", "expired", "승인을 기다리다 만료됐어요"],
        ["failed", "failed", "실행을 끝내지 못했어요 · 다시 요청해 보세요"],
        ["cancelled", "cancelled", "요청이 취소됐어요"],
        ["succeeded", "done", "실행을 마쳤어요"],
      ]) {
        const model = agentRequestBundle(message({ ...extra, action_type, status: "pending", decided_by: "human", result: { status, line: "Tool call rejected by human approval.", output: "PRIVATE" } }), context)!;
        expect(model.state).toBe(expected);
        expect(model.sentence).toBe(sentence);
        expect(JSON.stringify(model)).not.toContain("PRIVATE");
        expect(model.canDecide).toBe(false);
      }
      expect(agentRequestBundle(message({ ...extra, action_type, code: "approval_expired" }), context)?.state).toBe("expired");
      expect(agentRequestBundle(message({ ...extra, action_type, code: "approval_rejected" }), context)?.word).toBe("거부");
    }
    for (const { code, word, sentence } of requestLoopFixture.terminalCopy) {
      const model = agentRequestBundle(message({ code }), { ...context, nameFor: undefined })!;
      expect({ word: model.word, sentence: model.sentence }).toEqual({ word, sentence });
    }
    for (const status of ["failed", "succeeded"]) {
      expect(agentRequestBundle(message({ status }), context)?.state).toBe(status === "failed" ? "failed" : "done");
    }
    expect(agentRequestBundle(message({ status: "approved", result: { status: "running" } }), context)?.state).toBe("executing");
    expect(agentRequestBundle(message({ status: "approved", result: { status: "approved" } }), context)?.state).toBe("executing");
    expect(agentRequestBundle(message({ title: "Approve shell" }), context)?.headline).toBe("달무리봇 · 도구 「shell」 실행");
    const line = agentCardModel(msg({ type: "tool_result", body: "Tool call rejected by human approval.", props: { approval_id: "approval", status: "rejected", is_error: true } }));
    expect(line).toMatchObject({ kind: "tool", title: "거부", status: "cancelled", frame: { outcome: "거부됐어요" } });
  });

  it("문장이 머리이고 값 칩 둘·넘친 수·조용한 줄·관리자에게만 원장 번호를 낸다", () => {
    const model = agentRequestBundle(message({ intent: "소개를 바꾸려고 해요", expires_at_ms: nowMs + 23 * 3_600_000,
      action: { id: "agent.profile.update", rows: [
        { label: "소개", before: "예전", after: "새 소개" }, { label: "이름", value: "달무리" }, { label: "별명", value: "구름" },
      ] }, arguments: { private: "PRIVATE" },
    }), context)!;
    expect(model).toMatchObject({ headline: "달무리봇 · 소개를 바꾸려고 해요", quietLine: "23시간 남음 · 자세히", moreValues: 1, details: { label: "자세히" } });
    expect(model.valueChips).toHaveLength(2);
    expect(model.valueChips[0]).toMatchObject({ before: "예전", after: "새 소개", labelText: "소개: 이전 값 예전, 이후 값 새 소개" });
    expect(model.details.approvalId).toBeUndefined();
    expect(model.details.rows).toContainEqual({ label: "별명", value: "구름" });
    expect(JSON.stringify(model)).not.toContain("PRIVATE");
    expect(agentRequestBundle(message(), { ...context, isWorkspaceAdmin: true })?.details.approvalId).toBe("approval");
    expect(agentRequestBundle(message({ expires_at_ms: nowMs + 600_000 }), context)?.quietLine).toBe("10분 안에 만료돼요 · 자세히");
    expect(agentRequestBundle(message({ expires_at_ms: nowMs }), context)?.state).toBe("expired");
    const result = agentRequestBundle(message({ status: "approved", result: {
      status: "succeeded", rows: [{ label: "결과", after: "새 값" }, null],
      ref: { type: "channel", id: "target", arguments: "PRIVATE" },
      next: { label: "결과 보기", href: "javascript:PRIVATE" }, arguments: "PRIVATE",
    } }), context)!;
    expect(result.ref).toEqual({ type: "channel", id: "target" });
    expect(result.next).toBeUndefined();
    expect(result.moreValues).toBe(1);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    for (const raw of [null, [], true, { rows: [null], status: "future" }]) {
      expect(agentRequestBundle(message({ result: raw }), context)?.state).toBe("approval");
    }
  });

  it("결정할 사람만 버튼을 받고 다른 사람·요청한 에이전트는 기다리는 문장을 받는다", () => {
    for (const [viewerMemberId, viewerKind, canDecide, expected] of [
      ["human", "human", true, true], ["other", "human", false, false], ["agent", "agent", true, false],
    ] as const) {
      const model = agentRequestBundle(message(), { ...context, viewerMemberId, viewerKind, canDecide, approverMemberIds: ["human"] })!;
      expect(model.canDecide).toBe(expected);
      expect(model.waitingFor).toBe(expected ? undefined : "김인턴 님의 승인을 기다려요");
    }
    expect(agentRequestBundle(message(), { ...context, viewerMemberId: "AGENT" })?.canDecide).toBe(false);
    expect(agentRequestBundle(message({ can_decide: false }), context)?.canDecide).toBe(false);
    expect(agentRequestBundle(message({ can_decide: true }), { ...context, canDecide: false })?.canDecide).toBe(false);
    expect(agentRequestBundle(message(), { ...context, canDecide: false, approverMemberIds: ["human", "other"] })?.waitingFor).toBe("관리자의 승인을 기다려요");
  });

  it("decision_mode는 서버 값을 그대로 쓰고 부재 때만 현행 규칙으로 폴백한다", () => {
    for (const decision_mode of ["inline", "open"] as const) {
      expect(agentRequestBundle(message({ decision_mode, action: { id: "invite.create", rows: [] } }), context)?.decisionMode).toBe(decision_mode);
    }
    for (const [props, expected] of [
      [{ tool_name: "shell" }, "inline"], [{ decision_mode: "future" }, "open"], [{ tool_name: "work.session.login_handoff" }, "open"],
      [{ action: { id: "channel.create", rows: [] } }, "inline"], [{ action: { id: "invite.create", rows: [] } }, "open"],
      [{ action: { id: "message.pin", rows: [] } }, "open"], [{ action: { id: "new.action", rows: [] } }, "open"],
    ] as const) expect(agentRequestBundle(message(props), context)?.decisionMode).toBe(expected);
    expect(agentRequestBundle(message({ status: "approved" }), context)?.state).toBe("done");
    expect(agentRequestBundle(message({ status: "approved" }), { ...context, run: { phase: "running" } })?.state).toBe("executing");
    expect(agentRequestBundle(message({ action_type: "workspace_action", action: { id: "channel.create", rows: [] }, status: "approved" }), { ...context, run: { phase: "running" } })?.state).toBe("done");
  });

  it("bundle_of는 같은 목록의 같은 승인 종결 카드가 있을 때만 접고 도구 실행 결과를 잃지 않는다", () => {
    const line = msg({ type: "tool_result", props: { bundle_of: "approval" } });
    for (const status of ["rejected", "expired", "cancelled"]) expect(shouldFoldBundleLine(line, [message({ status }), line])).toBe(true);
    expect(shouldFoldBundleLine(line, [message({ result: { status: "succeeded" } }), line])).toBe(true);
    for (const cards of [[], [message()], [message({ approval_id: "other", status: "expired" })], [message({ status: "approved" })], [message({ status: "approved", result: {} })], [msg({ ...message({ status: "expired" }), state: "deleted" })]]) {
      expect(shouldFoldBundleLine(line, cards)).toBe(false);
    }
    expect(shouldFoldBundleLine(msg({ ...line, props: {} }), [message({ status: "expired" })])).toBe(false);
    expect(shouldFoldBundleLine(line, [msg({ ...message({ status: "expired" }), channelId: "other" })])).toBe(false);
  });

  it("문구 프리플라이트는 영어 원문·합쇼체·거절·옛 승인 낱말의 양성 fixture를 실제로 잡는다", () => {
    for (const [copy, hit] of [
      ["Tool call expired without a human approval.", "english-source"], ["Tool call rejected by human approval.", "english-source"],
      ["Approval required: shell", "english-source"], ["Approve shell", "english-source"], ["결정할 수 없습니다.", "formal"], ["승인을 기록합니다.", "formal"], ["거절됨", "declined-copy"], ["승인 대기", "approval-wait-copy"],
    ]) expect(requestLoopCopyViolations(copy)).toContain(hit);
    expect(requestLoopCopyViolations(APPROVAL_OFFLINE_COPY)).toEqual([]);
    expect(requestLoopCopyViolations("shell · 승인 필요 · 김인턴 님의 승인을 기다려요")).toEqual([]);
  });

  it("값 뒤 기본 틀은 한글·영문·숫자·기호·이모지 끝에서 조사 헤지 없이 읽힌다", () => {
    for (const value of requestLoopFixture.valueOnly) {
      const model = agentRequestBundle(message({ intent: "소개 바꾸기", action: { id: "agent.profile.update", rows: [{ label: "소개", before: "이전", after: value }] } }), context)!;
      expect(model.valueChips[0]!.labelText).toBe(`소개: 이전 값 이전, 이후 값 ${value}`);
      expect(JSON.stringify(model)).not.toMatch(/을\(를\)|\(으\)로/);
    }
    // 값 뒤 조사가 필요한 기존 틀은 같은 코어 표의 받침·ㄹ 예외를 읽어요.
    for (const { value, object, direction } of requestLoopFixture.particles) {
      expect(particleFor(value, "object")).toBe(object);
      expect(directionParticle(value)).toBe(direction);
    }
  });
});
