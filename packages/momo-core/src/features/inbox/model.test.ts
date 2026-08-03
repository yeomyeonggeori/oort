import { describe, expect, it } from "vitest";
import type { AgentRun, Approval, Message } from "../../lib/api";
import {
  agentsFeedPartial,
  approvalActionLabel,
  approvalItem,
  deadlineLabel,
  mentionItem,
  mentionMemberIds,
  mentionsMember,
  orderFeed,
  availableInboxFilters,
  parseFilter,
  relativeLabel,
  runItem,
  runTitle,
  type ActorNames,
} from "./model";

const NOW = 1_700_000_000_000;
const SELF = "00000000-0000-7000-8000-000000000101";
const AGENT = "00000000-0000-7000-8000-000000000103";

function message(props: Record<string, unknown> | undefined): Message {
  return {
    id: "019F96A4-E717-7F82-9750-58B2D7D28225",
    channelId: "00000000-0000-7000-8000-000000000201",
    seq: 42,
    hlcTs: NOW,
    hlcCount: 0,
    authorMemberId: AGENT,
    type: "text",
    body: "이 건 김인턴한테 시켜볼까요?",
    props,
    createdAtMs: NOW - 3_600_000,
  };
}

const human: ActorNames = { name: "곽성재", isAgent: false };
const agent: ActorNames = {
  name: "김인턴",
  handle: "kim-intern",
  isAgent: true,
  ownerName: "곽성재",
};

function approval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "019F8338-025E-7873-93A3-C1FBA9149185",
    workspaceId: "00000000-0000-7000-8000-000000000001",
    runId: "019F8338-0211-7A11-850C-D4E6229DDCA7",
    channelId: "00000000-0000-7000-8000-000000000201",
    requestedBy: AGENT,
    actionType: "work.spawn",
    status: "pending",
    ...overrides,
  };
}

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: "019F94E3-0E04-79CD-9DEE-208F47EDD9A8",
    workspaceId: "00000000-0000-7000-8000-000000000001",
    agentMemberId: AGENT,
    channelId: "00000000-0000-7000-8000-000000000202",
    status: "succeeded",
    stepCount: 7,
    maxSteps: 12,
    input: { type: "work", title: "릴레이 백프레셔 계측", brief: "..." },
    createdAtMs: NOW - 7_200_000,
    finishedAtMs: NOW - 3_600_000,
    updatedAtMs: NOW - 3_600_000,
    ...overrides,
  };
}

describe("mention decision", () => {
  it("reads the ids the server recorded at insert time", () => {
    expect(mentionMemberIds(message({ mention_member_ids: [SELF] }))).toEqual([
      SELF,
    ]);
  });

  it("ignores a missing, non-array or non-string props value", () => {
    expect(mentionMemberIds(message(undefined))).toEqual([]);
    expect(mentionMemberIds(message({}))).toEqual([]);
    expect(mentionMemberIds(message({ mention_member_ids: "nope" }))).toEqual([]);
    expect(mentionMemberIds(message({ mention_member_ids: [1, SELF] }))).toEqual(
      [SELF]
    );
  });

  it("compares ids case-insensitively, because the wire mixes cases", () => {
    const upper = message({ mention_member_ids: [SELF.toUpperCase()] });
    expect(mentionsMember(upper, SELF.toLowerCase())).toBe(true);
    expect(mentionsMember(upper, AGENT)).toBe(false);
  });
});

describe("clock labels", () => {
  it("states elapsed time in the coarsest unit that still says something", () => {
    expect(relativeLabel(NOW, NOW)).toBe("방금");
    expect(relativeLabel(NOW - 12 * 60_000, NOW)).toBe("12분 전");
    expect(relativeLabel(NOW - 3 * 3_600_000, NOW)).toBe("3시간 전");
    expect(relativeLabel(NOW - 2 * 86_400_000, NOW)).toBe("2일 전");
  });

  it("states a deadline as time remaining, and says so once it is gone", () => {
    expect(deadlineLabel(NOW + 3 * 60_000, NOW)).toBe("3분 후 만료");
    expect(deadlineLabel(NOW + 2 * 3_600_000, NOW)).toBe("2시간 후 만료");
    expect(deadlineLabel(NOW - 60_000, NOW)).toBe("기한 지남");
  });
});

describe("agents tab half-ledger judgement", () => {
  it("is partial exactly while the run history cannot be read", () => {
    // 두 클라이언트가 같은 답을 해야 해서 core에 산다(M-AP1 3R N-B): 웹은
    // `features/inbox/approvalsPanel.ts`에서 이것을 다시 내보내고, 모바일
    // 인박스는 직접 부른다. 두 벌이 되면 한쪽만 고쳐지는 날이 온다.
    expect(agentsFeedPartial(() => false)).toBe(true);
    expect(agentsFeedPartial(() => true)).toBe(false);
    // 묻는 표면은 작업 실행 기록 하나다 — 승인 원장의 유무는 이 판정에 없다.
    const asked: string[] = [];
    agentsFeedPartial((surface) => {
      asked.push(surface);
      return false;
    });
    expect(asked).toEqual(["agentRunHistory"]);
  });
});

describe("approval rows", () => {
  it("leaves the outcome null while nothing has been decided", () => {
    const item = approvalItem(
      approval({ expiresAtMs: NOW + 5 * 60_000 }),
      agent,
      "엔진",
      NOW
    );
    expect(item.outcome).toBeNull();
    expect(item.pending).toBe(true);
    expect(item.actor).toBe("@kim-intern");
    expect(item.actorIsAgent).toBe(true);
    // 3R M4: 와이어 액션 타입은 사용자 어휘로 번역된다(actionTypeLabel).
    expect(item.predicate).toBe("작업 실행 허가를 요청했습니다");
    // The projection carries no created_at, so a pending row shows the deadline.
    expect(item.timeLabel).toBe("5분 후 만료");
    expect(item.managedBy).toBe("곽성재");
  });

  it("shows the ledger decision and when it was made", () => {
    const item = approvalItem(
      approval({
        status: "rejected",
        decidedAtMs: NOW - 30 * 60_000,
        decisionReason: "빌드 디렉터리를 지우는 건 승인 안 함",
      }),
      agent,
      "엔진",
      NOW
    );
    expect(item.outcome).toBe("거절됨");
    expect(item.outcomeTone).toBe("danger");
    expect(item.timeLabel).toBe("30분 전");
    expect(item.detail).toContain("승인 안 함");
  });

  it("frames an unanswered request as expiry, never as an error", () => {
    const item = approvalItem(approval({ status: "expired" }), agent, "엔진", NOW);
    expect(item.outcome).toBe("만료됨");
    expect(item.outcomeTone).toBe("warn");
  });

  it("flags an irreversible action", () => {
    const item = approvalItem(
      approval({ isReversible: false }),
      agent,
      "엔진",
      NOW
    );
    expect(item.note).toBe("되돌릴 수 없음");
    expect(item.reversible).toBe(false);
  });

  it("treats an ABSENT reversibility flag as irreversible, not as reversible", () => {
    // goal M-AP1 2R B1. 서버가 못박은 계약이다(`dto.rs:2210-2212`): 없음은
    // "모른다"이지 "되돌릴 수 있다"가 아니다. 이 프로젝션은 그 필드를 아예 싣지
    // 않으므로, 예전 규칙(`!== false`)에서는 **모든** 승인이 가역으로 그려졌다 —
    // 그런데 이 서버가 실행하는 유일한 툴은 비가역인 것이 선정 사유였다.
    const item = approvalItem(approval(), agent, "엔진", NOW);
    expect(item.reversible).toBe(false);
    expect(item.note).toBe("되돌릴 수 없음");
  });

  it("calls it reversible only when the server said so in so many words", () => {
    const item = approvalItem(
      approval({ isReversible: true }),
      agent,
      "엔진",
      NOW
    );
    expect(item.reversible).toBe(true);
    expect(item.note).toBeUndefined();
  });

  it("marks a pending row whose deadline has already passed", () => {
    // 이 행에 결정을 보내면 서버는 승인이 아니라 **만료**로 확정한다
    // (`routes/approvals.rs:584` settle_expired). 화면이 "승인하면 …"이라고
    // 말하면 그것은 일어나지 않을 일이다.
    expect(
      approvalItem(approval({ expiresAtMs: NOW - 60_000 }), agent, "엔진", NOW)
        .deadlinePassed
    ).toBe(true);
    expect(
      approvalItem(approval({ expiresAtMs: NOW + 60_000 }), agent, "엔진", NOW)
        .deadlinePassed
    ).toBeUndefined();
    // 이미 끝난 결정에는 기한 이야기가 없다.
    expect(
      approvalItem(
        approval({ status: "approved", expiresAtMs: NOW - 60_000 }),
        agent,
        "엔진",
        NOW
      ).deadlinePassed
    ).toBeUndefined();
  });

  it("never puts the ledger's own class name in front of a person", () => {
    // goal M-AP1 2R B2. 이 서버가 쓰는 action_type은 언제나 `tool_call`이고
    // (`tools.rs:82`), 무엇을 허가하는지는 payload의 툴 이름에만 있다.
    const known = approvalItem(
      approval({ actionType: "tool_call", toolName: "work.session.end" }),
      agent,
      "엔진",
      NOW
    );
    expect(known.predicate).toBe("작업 세션 종료 허가를 요청했습니다");

    // 모르는 툴: 지어내지 않고 원문 이름을 쓴다.
    expect(
      approvalItem(
        approval({ actionType: "tool_call", toolName: "repo.branch.delete" }),
        agent,
        "엔진",
        NOW
      ).predicate
    ).toBe("repo.branch.delete 허가를 요청했습니다");

    // 이름조차 없으면 갈래를 우리말로. 어느 경우에도 `tool_call`은 안 나온다.
    const nameless = approvalItem(
      approval({ actionType: "tool_call" }),
      agent,
      "엔진",
      NOW
    );
    expect(nameless.predicate).toBe("에이전트 도구 실행 허가를 요청했습니다");
    for (const item of [known, nameless]) {
      expect(item.predicate).not.toContain("tool_call");
    }
  });

  it("keeps the legacy Swift action vocabulary working", () => {
    expect(approvalActionLabel("work.spawn")).toBe("작업 실행");
    expect(approvalActionLabel("message.send")).toBe("메시지 전송");
    // 툴 이름이 실려 있으면 그것이 더 구체적인 진실이다.
    expect(approvalActionLabel("work.spawn", "work.session.end")).toBe(
      "작업 세션 종료"
    );
    // 아무것도 모르면 원문 유지(정직 폴백).
    expect(approvalActionLabel("deploy")).toBe("deploy");
  });

  it("has no timeline seq: the projection exposes a message id, not a seq", () => {
    expect(
      approvalItem(approval({ requestMessageId: "abc" }), agent, "엔진", NOW).seq
    ).toBeUndefined();
  });
});

describe("mention rows", () => {
  it("anchors on the seq of the message that named you", () => {
    const item = mentionItem(
      message({ mention_member_ids: [SELF] }),
      human,
      "general",
      NOW
    );
    expect(item.seq).toBe(42);
    expect(item.channelLabel).toBe("general");
    expect(item.actor).toBe("곽성재");
    expect(item.actorIsAgent).toBe(false);
    expect(item.predicate).toBe("회원님을 불렀습니다");
    expect(item.detail).toBe("이 건 김인턴한테 시켜볼까요?");
    expect(item.timeLabel).toBe("1시간 전");
  });
});

describe("work run rows", () => {
  it("reads the validated work title, and nothing else from input", () => {
    expect(runTitle(run())).toBe("릴레이 백프레셔 계측");
    expect(runTitle(run({ input: {} }))).toBeUndefined();
    expect(runTitle(run({ input: undefined }))).toBeUndefined();
  });

  it("says what the agent did and how it came out", () => {
    const item = runItem(run(), agent, "agent-lab", NOW);
    expect(item.predicate).toBe('"릴레이 백프레셔 계측" 작업을 실행했습니다');
    expect(item.outcome).toBe("완료");
    expect(item.outcomeTone).toBe("ok");
    expect(item.detail).toBe("7/12 단계");
    expect(item.pending).toBe(false);
  });

  it("calls silence stalled, not failed (ADR-0132)", () => {
    const item = runItem(run({ status: "timed_out" }), agent, "agent-lab", NOW);
    expect(item.outcome).toBe("응답 없음");
    expect(item.outcomeTone).toBe("warn");
  });

  it("keeps a live run pending so it sorts to the top", () => {
    expect(runItem(run({ status: "running" }), agent, "a", NOW).pending).toBe(
      true
    );
    expect(runItem(run({ status: "running" }), agent, "a", NOW).outcome).toBeNull();
  });
});

describe("ordering", () => {
  it("puts live rows first by soonest deadline, then settled rows newest first", () => {
    const soon = approvalItem(
      approval({ id: "a", expiresAtMs: NOW + 60_000 }),
      agent,
      "엔진",
      NOW
    );
    const later = approvalItem(
      approval({ id: "b", expiresAtMs: NOW + 600_000 }),
      agent,
      "엔진",
      NOW
    );
    const old = approvalItem(
      approval({ id: "c", status: "approved", decidedAtMs: NOW - 86_400_000 }),
      agent,
      "엔진",
      NOW
    );
    const recent = approvalItem(
      approval({ id: "d", status: "approved", decidedAtMs: NOW - 60_000 }),
      agent,
      "엔진",
      NOW
    );
    expect(orderFeed([old, later, recent, soon]).map((i) => i.key)).toEqual([
      "approval:a",
      "approval:b",
      "approval:d",
      "approval:c",
    ]);
  });

  it("sorts a pending row with no recorded deadline last among pending rows", () => {
    const noDeadline = approvalItem(approval({ id: "a" }), agent, "엔진", NOW);
    const withDeadline = approvalItem(
      approval({ id: "b", expiresAtMs: NOW + 600_000 }),
      agent,
      "엔진",
      NOW
    );
    expect(orderFeed([noDeadline, withDeadline]).map((i) => i.key)).toEqual([
      "approval:b",
      "approval:a",
    ]);
  });

  it("is a total order, so equal timestamps cannot shuffle between renders", () => {
    const a = runItem(run({ id: "a" }), agent, "x", NOW);
    const b = runItem(run({ id: "b" }), agent, "x", NOW);
    expect(orderFeed([b, a]).map((i) => i.key)).toEqual(["run:a", "run:b"]);
    expect(orderFeed([a, b]).map((i) => i.key)).toEqual(["run:a", "run:b"]);
  });
});

describe("filter parsing", () => {
  it("defaults to the action-first tab and rejects anything unknown", () => {
    expect(parseFilter(null)).toBe("needs-action");
    expect(parseFilter("nope")).toBe("needs-action");
    expect(parseFilter("mentions")).toBe("mentions");
    expect(parseFilter("agents")).toBe("agents");
  });
});

// goal B12: 승인 원장이 없는 서버에서 인박스가 무엇을 보여야 하는가.
describe("이 서버가 답할 수 있는 탭만", () => {
  const nothing = () => false;
  const everything = () => true;

  it("승인도 실행 기록도 없으면 멘션만 남는다", () => {
    expect(availableInboxFilters(nothing)).toEqual(["mentions"]);
  });

  it("둘 다 있으면 세 탭 그대로다", () => {
    expect(availableInboxFilters(everything)).toEqual([
      "needs-action",
      "mentions",
      "agents",
    ]);
  });

  it("에이전트 탭은 두 원천 중 하나만 있어도 선다", () => {
    // 그 탭은 승인 원장 위에 작업 실행 기록을 얹은 것이라, 한쪽만 있어도
    // 보여줄 행이 존재한다.
    expect(availableInboxFilters((s) => s === "agentRunHistory")).toEqual([
      "mentions",
      "agents",
    ]);
    expect(availableInboxFilters((s) => s === "approvals")).toEqual([
      "needs-action",
      "mentions",
      "agents",
    ]);
  });

  it("기본 탭은 남은 탭의 첫 번째다: 죽은 탭에 착지하지 않는다", () => {
    // 이것이 goal B12가 고친 것이다: 예전 기본값은 상수 needs-action이었고,
    // 그 탭이 죽은 서버에서 인박스는 열자마자 영영 비어 있는 목록에 앉았다.
    const onlyMentions = availableInboxFilters(nothing);
    expect(parseFilter(null, onlyMentions)).toBe("mentions");
    expect(parseFilter("needs-action", onlyMentions)).toBe("mentions");
    expect(parseFilter("agents", onlyMentions)).toBe("mentions");
  });

  it("주소로 온 값이 살아 있는 탭이면 그대로 존중한다", () => {
    const all = availableInboxFilters(everything);
    expect(parseFilter("agents", all)).toBe("agents");
  });
});
