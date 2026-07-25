import { describe, expect, it } from "vitest";
import type { AgentRun, Approval, Message } from "@/lib/api";
import {
  approvalItem,
  deadlineLabel,
  mentionItem,
  mentionMemberIds,
  mentionsMember,
  orderFeed,
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
    expect(approvalItem(approval(), agent, "엔진", NOW).note).toBeUndefined();
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
