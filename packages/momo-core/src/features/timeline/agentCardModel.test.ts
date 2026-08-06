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
    arguments: { command: "rm -rf build/", cwd: "/Users/seongjae/projects/momo" },
    tool_grant: { grant_id: "g-31", scopes: ["shell:write"] },
    status: "pending",
    source: "hermes_gateway",
    ...extra,
  };
}

describe("approval card (web-legacy basic-mode vocabulary)", () => {
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
    expect(auth?.detail).toContain("AI 연결");
    // The fold must not repeat the sentence the body already said 40px above.
    expect(generic?.detail).not.toContain("다시 멘션");
  });

  it("still says something for a code this build has never seen", () => {
    const unknown = failureGuidance("some_future_code");
    expect(unknown?.label).toBeTruthy();
    expect(unknown?.detail).toContain("실행 기록");
    // …without inventing a repair OR a source. An unknown code may be a work
    // host or a policy: "설정의 AI 연결을 확인하세요" would be a confidently wrong
    // instruction, and "AI 제공자가 보낸 원문" a confidently wrong attribution,
    // which sends a reader looking for provider output that does not exist.
    expect(unknown?.detail).not.toContain("AI 연결");
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
    expect(outcome.note).toBe("다른 곳에서 이미 결정되었습니다.");
  });

  it("names expiry for what it is", () => {
    expect(interpretReceipt(409, receipt("expired")).note).toBe(
      "결정 전에 만료되었습니다."
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
      "보내지 못했습니다"
    );
    expect(sendFailureCopy(new NetworkError("unreachable", 15_000))).toContain(
      "닿지 못했습니다"
    );
  });

  it("says what a 403 and a 404 mean without apologising", () => {
    expect(interpretReceipt(403, receipt("forbidden")).errorCopy).toContain(
      "권한이 없습니다"
    );
    expect(interpretReceipt(404, receipt("not_found")).errorCopy).toContain(
      "찾을 수 없습니다"
    );
  });
});
