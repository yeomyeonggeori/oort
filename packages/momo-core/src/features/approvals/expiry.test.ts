import { describe, expect, it } from "vitest";
import { makeDirectory } from "../workspace/directory";
import type { RosterMember } from "../../lib/api";
import {
  EXPIRY_WARN_MS,
  cardReproposeReason,
  expiryPhase,
  expirySoonCopy,
  minutesLeft,
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

  it("남은 분은 올림이고 0분이라고 말하지 않는다", () => {
    expect(minutesLeft(EXPIRES, EXPIRES - 59_000)).toBe(1);
    expect(minutesLeft(EXPIRES, EXPIRES - 61_000)).toBe(2);
    expect(minutesLeft(EXPIRES, EXPIRES - 10 * MIN)).toBe(10);
    expect(expirySoonCopy(EXPIRES, EXPIRES - 61_000)).toBe(
      "2분 안에 만료돼요. 결정하지 않으면 에이전트가 다시 제안해야 해요."
    );
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
