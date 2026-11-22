// #5577 (#5566 후속 2) — 서버 결과 카드·칩은 작성자가 에이전트일 때만 선다.
//
// 각 시험은 서버가 실제로 쓰는 모양(게이트웨이 `timeline_props`, 워커 `success_props`·`failure_props`,
// 도우미 `answer_props` 공용 픽스처)을 그대로 쓴다. 같은 props 를 사람이 쓰면(작성자 종류 `human`) 아무것도
// 그려지지 않고, 작성자 종류를 모르면(멤버 목록에 없음) 역시 그려지지 않는다. 에이전트가 쓰면 그대로다.
import { describe, expect, it } from "vitest";
import type { Message } from "../../lib/api";
import teamAiReplyFixture from "./__fixtures__/team-ai-reply-props.json";
import { agentCardModel } from "./agentCardModel";
import { rowPresentation } from "./rowModel";
import { turnRecordRunId } from "./cascadeModel";
import { parseTeamAiReplyMeta, teamAiReplyMetaFor } from "./teamAiReply";
import { teamAiDelegationsFor, teamAiDelegationsOf } from "./teamAiDelegation";
import { isAgentAuthored, type AuthorKind } from "./serverResultAuthor";

const RUN = "0199aa11-2222-7000-8000-0000000000b2";
const HERMES = "0195f0a8-1c2d-7e3f-8a4b-5c6d7e8f9a0b";

function msg(props: Record<string, unknown>, overrides: Partial<Message> = {}): Message {
  return {
    id: "0199aa00-0000-7000-8000-00000000abcd",
    channelId: "00000000-0000-7000-8000-000000000201",
    seq: 7,
    hlcTs: 1_753_400_000_000,
    hlcCount: 0,
    authorMemberId: "00000000-0000-7000-8000-000000000101",
    type: "text",
    body: "작업을 마쳤어요.",
    state: "sent",
    createdAtMs: 1_753_400_000_000,
    props,
    ...overrides,
  };
}

/** `agent_gateway.rs` `timeline_props` — a settled gateway turn, failed, with its usage. */
const GATEWAY_TURN = {
  schema: "momo.agent_gateway.timeline.v0",
  source: "hermes_gateway",
  status: "failed",
  run_id: RUN,
  usage: { model: "claude-opus-4", prompt_tokens: 1240, completion_tokens: 380 },
  error: "upstream provider returned 503",
};
/** The worker's `failure_props` for a dead credential. */
const WORKER_FAILURE = {
  run_id: RUN,
  source: "agent_worker.provider_auth_failure.v0",
  error_code: "provider_auth_failed",
};
/** The worker's `success_props`: the run's settled final text. */
const WORKER_FINAL = { run_id: RUN, source: "agent_worker.final_text.v0" };
/** The helper's answer with a tail: the shared fixture plus the tail's two lists. */
const HELPER_ANSWER = {
  ...teamAiReplyFixture.props,
  tools_used: [{ name: "web_search" }],
  web_citations: [{ url: "https://example.com/a", title: "예시" }],
};
/** The same, as a REST props map can carry it: strings only (`source: team_ai` is enough to open it). */
const STRING_ONLY_TURN = { status: "running", error_code: "provider_auth_failed", run_id: RUN };

const NOT_AN_AGENT: readonly (AuthorKind | undefined | null)[] = ["human", undefined, null];

describe("#5577 — 작성자 종류", () => {
  it("에이전트만 서버 결과의 작성자다", () => {
    expect(isAgentAuthored("agent")).toBe(true);
    for (const kind of NOT_AN_AGENT) expect(isAgentAuthored(kind)).toBe(false);
  });
});

describe("#5577 — 턴 카드(「에이전트 실행 결과」)", () => {
  it("에이전트가 쓴 서버 모양은 그대로 카드다(거짓 양성 0)", () => {
    const gateway = agentCardModel(msg(GATEWAY_TURN, { type: "system" }), "agent");
    expect(gateway?.kind).toBe("turn");
    expect(gateway?.kind === "turn" && gateway.status).toBe("error");
    expect(gateway?.kind === "turn" && gateway.cost?.model).toBe("claude-opus-4");
    const failure = agentCardModel(msg(WORKER_FAILURE), "agent");
    expect(failure?.kind === "turn" && failure.failure?.label).toBe("연결된 계정 인증이 만료되었습니다.");
  });

  it("사람이 같은 값을 쓰면, 또는 작성자를 모르면 카드가 없다", () => {
    for (const kind of NOT_AN_AGENT) {
      for (const props of [GATEWAY_TURN, WORKER_FAILURE, STRING_ONLY_TURN]) {
        expect(agentCardModel(msg(props), kind)).toBeNull();
      }
    }
  });

  it("카드가 없는 사람 글은 평범한 본문으로 남는다(행이 본문을 지우지 않는다)", () => {
    const human = rowPresentation(msg(STRING_ONLY_TURN), "human");
    expect(human.card).toBeNull();
    expect(human.artifactState).toBeNull();
    expect(human.keepsBody).toBe(true);
    const agent = rowPresentation(msg(GATEWAY_TURN), "agent");
    expect(agent.card?.kind).toBe("turn");
  });

  it("사람의 diff 는 서버가 잰 상태 칩을 달지 않는다", () => {
    const patch = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n";
    const props = { status: "error", error: "샤드 클레임이 타임아웃됐습니다." };
    const human = rowPresentation(msg(props, { type: "diff", body: patch }), "human");
    expect(human.artifactState).toBeNull();
    const agent = rowPresentation(msg(props, { type: "diff", body: patch }), "agent");
    expect(agent.artifactState?.status).toBe("error");
  });

  it("승인 카드는 작성자 종류 없이도 그대로다(승인만 묻는 호출자: 알림·결정 무대)", () => {
    const approval = msg(
      { approval_id: "0199aa11-2222-7000-8000-0000000000a1", status: "pending", title: "배포 승인" },
      { type: "approval_request" }
    );
    expect(agentCardModel(approval)?.kind).toBe("approval");
  });
});

describe("#5577 — 정착한 턴 기록(제공자 전환 줄·기억 영수증)", () => {
  it("에이전트가 쓴 게이트웨이·워커 기록은 run 을 가리킨다", () => {
    expect(turnRecordRunId(msg(GATEWAY_TURN), "agent")).toBe(RUN);
    expect(turnRecordRunId(msg(WORKER_FINAL), "agent")).toBe(RUN);
  });

  it("사람 글이나 작성자를 모르는 글은 어느 run 의 기록도 아니다", () => {
    for (const kind of NOT_AN_AGENT) {
      expect(turnRecordRunId(msg(GATEWAY_TURN), kind)).toBeNull();
      expect(turnRecordRunId(msg(WORKER_FINAL), kind)).toBeNull();
    }
  });
});

describe("#5577 — 도우미 답의 꼬리(「팀 AI · 모델」·찾아본 것·출처)", () => {
  it("에이전트가 쓴 도우미 답은 칩과 꼬리가 그대로다", () => {
    const meta = teamAiReplyMetaFor(msg(HELPER_ANSWER), undefined, "agent");
    expect(meta?.modelChip).toBe("팀 AI · Claude Sonnet 4.5");
    expect(meta?.toolsLine).toBe("찾아본 것: 웹 검색");
    expect(meta?.citations.map((item) => item.host)).toEqual(["example.com"]);
    expect(parseTeamAiReplyMeta(HELPER_ANSWER, undefined, "agent")?.modelChip).toBe(meta?.modelChip);
  });

  it("사람이 같은 값을 쓰면, 또는 작성자를 모르면 아무것도 없다", () => {
    for (const kind of NOT_AN_AGENT) {
      expect(teamAiReplyMetaFor(msg(HELPER_ANSWER), undefined, kind)).toBeNull();
      expect(parseTeamAiReplyMeta(HELPER_ANSWER, undefined, kind)).toBeNull();
    }
  });
});

describe("#5577 — 「Hermes 도움」 칩", () => {
  const delegated = { ...HELPER_ANSWER, team_ai_delegated: [{ kind: "web_search", agent_member_id: HERMES }] };

  it("에이전트가 쓴 도우미 답만 칩을 단다", () => {
    expect(teamAiDelegationsFor(msg(delegated), "agent")).toEqual([
      { kind: "web_search", agentMemberId: HERMES },
    ]);
    for (const kind of NOT_AN_AGENT) {
      expect(teamAiDelegationsFor(msg(delegated), kind)).toEqual([]);
      expect(teamAiDelegationsOf(delegated, kind)).toEqual([]);
    }
  });
});
