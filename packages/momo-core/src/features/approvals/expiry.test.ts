import { describe, expect, it } from "vitest";
import { makeDirectory } from "../workspace/directory";
import type { RosterMember } from "../../lib/api";
import { catalog as en } from "../../i18n/generated/en-US";
import { catalog as ko } from "../../i18n/generated/ko-KR";
import { createMessageCopy } from "../../testkit/i18n";
import {
  EXPIRY_WARN_MS,
  cardReproposeReason,
  expiryPhase,
  reproposeDraft,
  reproposeTarget,
  closedCardReproposeReason,
  expiryLineSentence,
} from "./expiry";

const EXPIRES = 1_000_000_000_000;
const MIN = 60_000;

describe("승인 기한 국면 (#3738)", () => {
  it("경계: 10분 1초 전은 조용하고, 9분 59초 전부터 경고다", () => {
    expect(expiryPhase(EXPIRES, EXPIRES - 10 * MIN - 1_000)).toBe("none");
    expect(expiryPhase(EXPIRES, EXPIRES - 10 * MIN)).toBe("soon");
    expect(expiryPhase(EXPIRES, EXPIRES - (9 * MIN + 59_000))).toBe("soon");
  });

  it("경계: 기한 정각과 그 뒤는 만료다", () => {
    expect(expiryPhase(EXPIRES, EXPIRES - 1)).toBe("soon");
    expect(expiryPhase(EXPIRES, EXPIRES)).toBe("expired");
    expect(expiryPhase(EXPIRES, EXPIRES + 10 * MIN + 1)).toBe("expired");
  });

  it("기한을 모르면 지어내지 않는다", () => {
    expect(expiryPhase(undefined, EXPIRES)).toBe("none");
    expect(expiryPhase(null, EXPIRES)).toBe("none");
  });

  it("경고 창은 10분이다", () => {
    expect(EXPIRY_WARN_MS).toBe(10 * MIN);
  });

  // 화면 검수 3회차 L7: 경고 줄은 놓쳤을 때의 결과만 말하고 시간은 조용한 줄(`remainingTime`)이 한 번 말한다. 경고 문장에
  // 시간 말(숫자 · 분 · 시간 · minute)이 다시 들어가면 한 카드가 두 줄에서 다른 시간을 말하던 결함이 돌아온다.
  it.each([
    ["ko-KR", ko],
    ["en-US", en],
  ] as const)("경고 줄 문장(%s)에는 시간 말이 없다 (L7)", (messageLocale, catalog) => {
    const soon = createMessageCopy({ messageLocale, catalog })("timeline.approvalExpiry.soon");
    expect(soon.length).toBeGreaterThan(10);
    expect(soon).not.toMatch(/\d|분|시간|초|minute|second|hour|soon|min\b/i);
  });

  it("다시 제안 초안은 에이전트 핸들을 멘션한다", () => {
    const draft = reproposeDraft("grokbot");
    expect(draft.startsWith("@grokbot ")).toBe(true);
    expect(draft.endsWith(" ")).toBe(true);
  });

  it("이유를 생략하면 만료 초안이고, 거부·실패는 자기 사정을 말한다 (#4986)", () => {
    expect(reproposeDraft("grokbot")).toBe(reproposeDraft("grokbot", "expired"));
    expect(reproposeDraft("grokbot", "expired")).toContain("만료됐어요");
    expect(reproposeDraft("grokbot", "declined")).toContain("거부됐어요");
    expect(reproposeDraft("grokbot", "failed")).toContain("끝내지 못했어요");
    // 이유마다 다른 글자이고, 모두 멘션으로 시작해 사람이 이어 쓸 수 있게 공백으로 끝난다.
    const drafts = (["expired", "declined", "failed"] as const).map((reason) => reproposeDraft("grokbot", reason));
    expect(new Set(drafts).size).toBe(3);
    for (const draft of drafts) {
      expect(draft.startsWith("@grokbot ")).toBe(true);
      expect(draft.endsWith(" ")).toBe(true);
      // 요청 고리 문구 규칙: 합쇼체·「거절」·영어 원문이 없다.
      expect(draft).not.toMatch(/니다(?:[.!?\s]|$)|거절|[A-Za-z]{3,}\s[A-Za-z]{3,}/u);
    }
  });

  it("닫힌 카드가 「다시 요청」을 건네는 것은 실패와 (남이 한) 거부뿐이다 (#4986)", () => {
    expect(closedCardReproposeReason("failed", false)).toBe("failed");
    expect(closedCardReproposeReason("failed", true)).toBe("failed");
    expect(closedCardReproposeReason("declined", false)).toBe("declined");
    // 내가 거부한 카드: 방금 스스로 닫은 사람에게 되돌릴 것이 없다.
    expect(closedCardReproposeReason("declined", true)).toBeNull();
    // 만료는 제 푸터가 맡고, 끝·취소·진행 중에는 다음 행동이 없다.
    for (const state of ["expired", "thinking", "approval", "executing", "done", "cancelled", "", "unknown"]) {
      expect(closedCardReproposeReason(state, false), state).toBeNull();
    }
  });
});

// #5171. 폰 승인 카드에도 「다시 요청」이 서야 해서, 웹 `AgentCard` 안에 있던 서는 곳 판정(`reproposeTarget`)을 코어로 옮기고 만료까지
// 한 표(`cardReproposeReason`)로 말한다. 웹과 폰은 이 두 함수를 읽고, 각 표면의 렌더 시험이 같은 상태 표를 화면에서 잰다.
describe("「다시 요청」의 서는 조건 한 표 (#5171)", () => {
  it("만료는 보는 사람과 상관없이, 실패는 늘, 거부는 거부한 본인을 빼고 건넨다 — 그 밖의 상태에는 없다", () => {
    for (const decided of [false, true]) {
      expect(cardReproposeReason("expired", decided)).toBe("expired");
      expect(cardReproposeReason("failed", decided)).toBe("failed");
    }
    expect(cardReproposeReason("declined", false)).toBe("declined");
    expect(cardReproposeReason("declined", true)).toBeNull();
    for (const state of ["thinking", "approval", "executing", "done", "cancelled", "", "unknown"]) {
      expect(cardReproposeReason(state, false), state).toBeNull();
    }
  });

  // 웹 카드 푸터의 branch 순서(영수증 줄이 먼저)로만 있던 조건을 코어 표로 옮겼다. 만료 카드는 영수증 줄이 함께 있으면 서지 않고,
  // 실패·거부 카드는 영수증 줄과 함께 선다(`AgentCard.nextAction.test.tsx` · 폰 `requestBundleRepropose.test.tsx` 가 화면에서 같은 표를 잰다).
  it("만료 카드가 이미 영수증 줄을 말하면 서지 않고, 실패·거부 카드는 영수증 줄과 함께 선다", () => {
    for (const decided of [false, true]) {
      expect(cardReproposeReason("expired", decided, "기한이 지나 만료로 기록됐어요.")).toBeNull();
    }
    // 공백뿐이거나 없는 줄은 줄이 아니다(`approvalCardNote` 와 같은 규칙).
    for (const blank of [undefined, null, "", "   "]) {
      expect(cardReproposeReason("expired", false, blank)).toBe("expired");
    }
    expect(cardReproposeReason("failed", true, "승인을 기록했어요.")).toBe("failed");
    expect(cardReproposeReason("declined", false, "다른 곳에서 먼저 결정됐어요.")).toBe("declined");
    expect(cardReproposeReason("declined", true, "거부를 기록했어요.")).toBeNull();
    // 영수증 줄이 있어도 다음 행동이 없는 상태는 그대로 없다.
    for (const state of ["done", "cancelled", "executing", "approval"]) {
      expect(cardReproposeReason(state, false, "기록했어요."), state).toBeNull();
    }
  });

  const member = (id: string, kind: "human" | "agent"): RosterMember =>
    ({ id, workspaceId: "ws", kind, status: "active", displayName: id, handle: `h-${id}`, channelCount: 0, channelIds: [], capabilities: [], createdAtMs: 0, updatedAtMs: 0 }) as RosterMember;
  const directory = makeDirectory([member("AGENT-1", "agent"), member("human-1", "human")]);

  it("카드를 올린 이가 에이전트로 풀리고 채널을 알 때만 대상이 있다 (아이디의 대소문자는 가리지 않는다)", () => {
    expect(reproposeTarget({ requestedByMemberId: "agent-1", channelId: "ch" }, directory)).toMatchObject({
      agent: { handle: "h-AGENT-1" },
      channelId: "ch",
    });
    // 사람이 올린 카드 · 명부에 없는 이 · 올린 이를 모르는 카드 · 채널을 모르는 카드에는 단추를 세우지 않는다.
    expect(reproposeTarget({ requestedByMemberId: "human-1", channelId: "ch" }, directory)).toBeNull();
    expect(reproposeTarget({ requestedByMemberId: "ghost", channelId: "ch" }, directory)).toBeNull();
    expect(reproposeTarget({ channelId: "ch" }, directory)).toBeNull();
    expect(reproposeTarget({ requestedByMemberId: "AGENT-1" }, directory)).toBeNull();
  });
});

describe("만료 스윕 줄의 문장", () => {
  it("한글이 없는 본문(영어 기본 문구)과 빈 본문만 한국어 기본 한 줄로 바꾼다", () => {
    const fallback = expiryLineSentence(undefined);
    expect(fallback).toMatch(/[가-힣]/);
    expect(expiryLineSentence("Tool call expired without a human approval.")).toBe(fallback);
    expect(expiryLineSentence("")).toBe(fallback);
    expect(expiryLineSentence("   ")).toBe(fallback);
    expect(expiryLineSentence(null)).toBe(fallback);
  });

  it("서버가 이미 한국어로 쓴 문장은 다음 행동까지 그대로 둔다", () => {
    const server = "시간이 지나 요청을 처리하지 않았어요. 다시 불러 주세요.";
    expect(expiryLineSentence(server)).toBe(server);
    expect(expiryLineSentence(`  ${server}  `)).toBe(server);
    expect(expiryLineSentence("expired · 기한 지남")).toBe("expired · 기한 지남");
  });
});
