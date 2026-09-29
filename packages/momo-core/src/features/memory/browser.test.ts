import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import {
  BROWSER_OPEN_ITEM_GONE,
  EVIDENCE_RANGE_MAX,
  FORGET_DESCRIPTION,
  ITEM_CONFLICT_MESSAGE,
  ITEM_EDIT_REFUSED_MESSAGE,
  ITEM_FORBIDDEN_MESSAGE,
  MEMORY_EVENT_FALLBACK,
  PROPOSAL_CONFLICT_MESSAGE,
  PROPOSAL_FAILED_MESSAGE,
  PROPOSAL_FORBIDDEN_MESSAGE,
  PROPOSAL_GUEST_READONLY,
  deriveProposalCard,
  editDraftProblem,
  evidenceSeqRange,
  forgottenNotice,
  isCurrentMemoryItem,
  itemReadError,
  itemWriteError,
  memberMayWriteMemory,
  memoryEventLabel,
  proposalDecisionError,
} from "./browser";

describe("제안 카드 판정", () => {
  const pending = { status: "pending", callerIsRequester: false } as const;

  it("멤버는 결정하고, 손님은 이유와 함께 읽기 전용이다", () => {
    expect(deriveProposalCard({ proposal: pending, role: "member" })).toEqual({
      canDecide: true,
      readOnlyReason: null,
      warnSelfAccept: false,
    });
    expect(deriveProposalCard({ proposal: pending, role: "guest" })).toEqual({
      canDecide: false,
      readOnlyReason: PROPOSAL_GUEST_READONLY,
      warnSelfAccept: false,
    });
  });

  it("자기 수락 경고는 요청자에게만, 대기 중일 때만 선다", () => {
    const self = { status: "pending", callerIsRequester: true } as const;
    expect(deriveProposalCard({ proposal: self, role: "member" }).warnSelfAccept).toBe(true);
    expect(
      deriveProposalCard({ proposal: { ...self, status: "accepted" }, role: "member" }).warnSelfAccept
    ).toBe(false);
    // 경고는 조언일 뿐 막지 않는다.
    expect(deriveProposalCard({ proposal: self, role: "member" }).canDecide).toBe(true);
  });

  it("이미 결정된 제안은 누구에게도 버튼이 없다", () => {
    const decided = { status: "accepted", callerIsRequester: false } as const;
    expect(deriveProposalCard({ proposal: decided, role: "member" }).canDecide).toBe(false);
    expect(deriveProposalCard({ proposal: decided, role: "member" }).readOnlyReason).toBeNull();
  });

  it("역할을 모르면(옛 행) 막지 않고 서버에 맡긴다", () => {
    expect(memberMayWriteMemory(undefined)).toBe(true);
    expect(memberMayWriteMemory("guest")).toBe(false);
  });
});

describe("오류 문장 매핑", () => {
  it("결정: 403은 권한/없는 id를 가리지 않고, 409는 다시 읽게 한다", () => {
    expect(proposalDecisionError(new ApiError(403, "x"))).toEqual({
      kind: "forbidden",
      message: PROPOSAL_FORBIDDEN_MESSAGE,
      refetch: false,
    });
    expect(proposalDecisionError(new ApiError(409, "x"))).toEqual({
      kind: "conflict",
      message: PROPOSAL_CONFLICT_MESSAGE,
      refetch: true,
    });
    expect(proposalDecisionError(new ApiError(500, "x")).message).toBe(PROPOSAL_FAILED_MESSAGE);
    expect(proposalDecisionError(new Error("offline")).kind).toBe("failed");
  });

  it("편집·잊기: 403 손님, 404 없음=볼 수 없음, 409 다시 읽기, 422는 이유를 좁히지 않는다", () => {
    expect(itemWriteError(new ApiError(403, "x"), "edit").message).toBe(ITEM_FORBIDDEN_MESSAGE);
    const gone = itemWriteError(new ApiError(404, "x"), "forget");
    expect(gone).toEqual({ message: BROWSER_OPEN_ITEM_GONE, refetch: true, gone: true });
    expect(itemWriteError(new ApiError(409, "x"), "edit")).toEqual({
      message: ITEM_CONFLICT_MESSAGE,
      refetch: true,
      gone: false,
    });
    const refused = itemWriteError(new ApiError(422, "x"), "edit");
    expect(refused.message).toBe(ITEM_EDIT_REFUSED_MESSAGE);
    // 「바뀐 게 없음」과 「숨은 쌍둥이」는 같은 답이라 문장에 어느 쪽도 담기지 않는다.
    expect(refused.message).not.toMatch(/쌍둥이|이미 있는|다른 기억/);
    // 잊기에는 422 문장이 없다.
    expect(itemWriteError(new ApiError(422, "x"), "forget").message).not.toBe(
      ITEM_EDIT_REFUSED_MESSAGE
    );
  });

  it("읽기: 목록의 404는 표면 없음, 상세의 404는 없거나 볼 수 없음", () => {
    expect(itemReadError(new ApiError(404, "x"), "list").kind).toBe("absent");
    expect(itemReadError(new ApiError(404, "x"), "detail").kind).toBe("gone");
    expect(itemReadError(new ApiError(500, "x"), "list").kind).toBe("failed");
  });
});

describe("잊기 문구", () => {
  it("다시는 나타나지 않는다고 약속하지 않고 요약에 남을 수 있다고 말한다", () => {
    expect(FORGET_DESCRIPTION).toBe(
      "이 기억을 지워요. 이미 만들어진 요약에는 다시 만들어질 때까지 남아 있을 수 있어요."
    );
    expect(FORGET_DESCRIPTION).not.toMatch(/다시는|절대|영원히|나타나지 않/);
  });

  it("지운 버전이 여럿이면 개수를 말한다", () => {
    expect(forgottenNotice(1)).toBe("잊었어요.");
    expect(forgottenNotice(3)).toContain("3개");
  });
});

describe("항목 규칙", () => {
  it("새 버전이 있거나 내려간 항목은 현재가 아니다", () => {
    expect(isCurrentMemoryItem({})).toBe(true);
    expect(isCurrentMemoryItem({ supersededById: "x" })).toBe(false);
    expect(isCurrentMemoryItem({ retiredAtMs: 1 })).toBe(false);
  });

  it("모르는 사건 이름은 서버 어휘를 그대로 내보내지 않는다", () => {
    expect(memoryEventLabel("edited")).toBe("고쳐 썼어요");
    expect(memoryEventLabel("brand_new_action")).toBe(MEMORY_EVENT_FALLBACK);
  });

  it("편집 초안: 빈 글·너무 긴 글·그대로인 글을 미리 거른다", () => {
    expect(editDraftProblem("  ", "원문")).not.toBeNull();
    expect(editDraftProblem("원문", "원문")).not.toBeNull();
    expect(editDraftProblem("가".repeat(601), "원문")).not.toBeNull();
    expect(editDraftProblem("가".repeat(600), "원문")).toBeNull();
    expect(editDraftProblem("새 문장", "원문")).toBeNull();
  });
});

describe("근거 메시지 읽기 구간", () => {
  it("가까운 근거는 한 번에, 멀리 떨어지면 개별로 읽는다", () => {
    expect(evidenceSeqRange([41, 44, 42])).toEqual({ after: 40, limit: 4 });
    expect(evidenceSeqRange([1, 1 + EVIDENCE_RANGE_MAX])).toBeNull();
    expect(evidenceSeqRange([])).toBeNull();
  });
});
