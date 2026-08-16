import { describe, expect, it } from "vitest";

import {
  approvalCardNote,
  approvalNoteRank,
  APPROVAL_ELSEWHERE_COPY,
  APPROVAL_NOTE_BLOCKED_TWIN,
  APPROVAL_NOTE_TONE_ORDER,
  APPROVAL_NOTE_TONE_SPEC,
  APPROVAL_OFFLINE_COPY,
  type ApprovalCardNoteInput,
} from "./approvalNote";

// =============================================================================
// 승인 카드의 한 줄 — 무엇을 말하고 어떤 격으로 말하는가 (design-review M-3)
// =============================================================================

function input(over: Partial<ApprovalCardNoteInput> = {}): ApprovalCardNoteInput {
  return {
    settled: false,
    hasTarget: true,
    pendingHere: true,
    offline: false,
    approvalsProvided: true,
    ...over,
  };
}

describe("색 계약 — 값이 아니라 역할이다 (#1429)", () => {
  it("세 톤이 전부 명세를 갖는다", () => {
    for (const tone of APPROVAL_NOTE_TONE_ORDER) {
      expect(APPROVAL_NOTE_TONE_SPEC[tone].meaning.length).toBeGreaterThan(0);
      expect(
        APPROVAL_NOTE_TONE_SPEC[tone].mustDifferFrom.length
      ).toBeGreaterThan(0);
    }
  });

  /**
   * 명세에 들 수 있는 이름은 둘뿐이다: 형제 톤이거나, 클라가 답할 수 있는 팔레트
   * 역할이거나. 셋째 종류가 들어오면 두 클라의 계약 테스트가 그것을 답하지 못한 채
   * 초록으로 지나간다 — D-2가 같은 자리에 같은 가드를 둔 이유다.
   */
  it("명세의 이름은 형제 톤이거나 팔레트 역할이다", () => {
    const roles = ["attention", "danger"];
    for (const tone of APPROVAL_NOTE_TONE_ORDER) {
      for (const name of APPROVAL_NOTE_TONE_SPEC[tone].mustDifferFrom) {
        const known =
          (APPROVAL_NOTE_TONE_ORDER as readonly string[]).includes(name) ||
          roles.includes(name);
        expect(known, `명세의 "${name}"`).toBe(true);
        expect(name, `${tone}이 자기 자신과 다르라고 한다`).not.toBe(tone);
      }
    }
  });

  /**
   * 차단만 팔레트 역할 둘을 함께 든다. 그 둘이 이 톤이 실수로 빌려 쓸 수 있는
   * 유일한 이웃이기 때문이다: 부름(웹 `--accent` · 폰 `warn`)과 사고(`danger`).
   * 영수증과 안내는 회색 축에 살아서 그 이웃이 없다.
   */
  it("차단만 부름과 사고를 함께 금지한다", () => {
    expect([...APPROVAL_NOTE_TONE_SPEC.blocked.mustDifferFrom].sort()).toEqual([
      "attention",
      "danger",
      "guidance",
      "receipt",
    ]);
    for (const tone of ["receipt", "guidance"] as const) {
      expect(APPROVAL_NOTE_TONE_SPEC[tone].mustDifferFrom).not.toContain(
        "attention"
      );
    }
  });

  it("차단의 쌍둥이 자리를 코어가 이름 짓는다 (U4-6 M-2)", () => {
    // 두 클라의 계약 테스트가 같은 상수로 자기 컴포저를 지목한다. 이름이 갈라지면
    // 둘 중 하나가 아무것도 없는 자리를 재게 된다.
    expect(APPROVAL_NOTE_BLOCKED_TWIN).toBe("composer-offline");
  });
});

describe("격의 순서", () => {
  it("영수증이 가장 앞이다 — 카드에서 가장 값어치 있는 문장", () => {
    expect(APPROVAL_NOTE_TONE_ORDER[0]).toBe("receipt");
    expect(approvalNoteRank("receipt")).toBeLessThan(approvalNoteRank("blocked"));
    expect(approvalNoteRank("blocked")).toBeLessThan(
      approvalNoteRank("guidance")
    );
  });

  /**
   * 시간축으로 봐도 격이 뒤집히지 않아야 한다. 오프라인이던 카드에서 사람이 결정을
   * 마치면 문장은 `blocked` 에서 `receipt` 로 **올라간다**. 내려가는 전이는 이
   * 카드에 없다.
   */
  it("오프라인에서 결정으로 가면 격이 올라간다", () => {
    const blocked = approvalCardNote(input({ offline: true }));
    const settled = approvalCardNote(
      input({ offline: true, receiptNote: "승인을 기록했습니다." })
    );
    expect(blocked?.tone).toBe("blocked");
    expect(settled?.tone).toBe("receipt");
    expect(approvalNoteRank(settled!.tone)).toBeLessThan(
      approvalNoteRank(blocked!.tone)
    );
  });
});

describe("approvalCardNote", () => {
  /**
   * 폰이 실측한 순서. 결정한 순간 그 승인은 대기 목록에서 빠져 `pendingHere` 가
   * 거짓이 되므로, 영수증을 뒤에 두면 방금 누른 사람이 「다른 데서 하세요」를
   * 읽는다.
   */
  it("영수증이 무엇보다 먼저다 — 결정하면 대기 목록에서 빠지기 때문", () => {
    const note = approvalCardNote(
      input({
        settled: true,
        pendingHere: false,
        receiptNote: "승인을 기록했습니다.",
      })
    );
    expect(note).toEqual({
      kind: "receipt",
      tone: "receipt",
      text: "승인을 기록했습니다.",
    });
  });

  /**
   * 끝난 결정에 「인박스나 데스크톱에서 처리하세요」를 붙이면 처리할 것이 없는데
   * 처리하러 가라고 하는 셈이다. 그 카드가 할 말은 원장 줄이 이미 하고 있다.
   */
  it("끝난 결정은 아무 줄도 세우지 않는다", () => {
    expect(
      approvalCardNote(input({ settled: true, pendingHere: false }))
    ).toBeNull();
  });

  it("결정할 대상이 없으면 승인 안내를 붙이지 않는다", () => {
    expect(approvalCardNote(input({ hasTarget: false }))).toBeNull();
  });

  it("이 표면에서 결정할 수 없으면 자리의 문제를 말한다", () => {
    expect(approvalCardNote(input({ pendingHere: false }))).toEqual({
      kind: "elsewhere",
      tone: "guidance",
      text: APPROVAL_ELSEWHERE_COPY,
    });
  });

  it("빈 영수증은 영수증이 아니다", () => {
    expect(approvalCardNote(input({ receiptNote: "   " }))?.kind).not.toBe(
      "receipt"
    );
    expect(approvalCardNote(input({ receiptNote: null }))).toBeNull();
  });

  it("결정할 수 있고 보낼 수 있으면 컨트롤이 선다 (null)", () => {
    expect(approvalCardNote(input())).toBeNull();
  });

  it("연결이 끊기면 컨트롤 자리에 「때」의 문장이 선다", () => {
    expect(approvalCardNote(input({ offline: true }))).toEqual({
      kind: "offline",
      tone: "blocked",
      text: APPROVAL_OFFLINE_COPY,
    });
  });

  /**
   * 원장이 없는 서버에서는 다른 자리로 가도, 온라인이 되어도 아무 일도 일어나지
   * 않는다. 그래서 그 둘보다 이 판정이 앞이다 — 나머지 두 문장이 그 서버에서는
   * 거짓말이 된다.
   */
  it("원장 없는 서버는 자리·때보다 먼저 답한다", () => {
    const note = approvalCardNote(
      input({
        approvalsProvided: false,
        offline: true,
        unsupportedText: "이 서버는 승인 원장을 제공하지 않습니다.",
      })
    );
    expect(note?.kind).toBe("unsupported");
    expect(note?.tone).toBe("guidance");
    expect(note?.text).toBe("이 서버는 승인 원장을 제공하지 않습니다.");
  });

  it("설명 문장이 없으면 길 안내 문장으로 물러난다 — 빈 줄을 그리지 않는다", () => {
    const note = approvalCardNote(input({ approvalsProvided: false }));
    expect(note?.text).toBe(APPROVAL_ELSEWHERE_COPY);
  });

  it("재개 제안은 승인이 아니다 — 승인 문장을 붙이지 않는다", () => {
    const note = approvalCardNote(
      input({
        isResumeOffer: true,
        hasTarget: false,
        resumeOfferText: "git 계보만 새 호스트로 이어집니다.",
      })
    );
    expect(note?.kind).toBe("resume-offer");
    expect(note?.tone).toBe("guidance");
    // 오프라인이어도 마찬가지다: 보낼 결정 자체가 없다.
    expect(
      approvalCardNote(
        input({
          isResumeOffer: true,
          offline: true,
          resumeOfferText: "git 계보만 새 호스트로 이어집니다.",
        })
      )?.kind
    ).toBe("resume-offer");
  });

  it("할 말이 없는 재개 제안은 아무 줄도 세우지 않는다", () => {
    expect(
      approvalCardNote(input({ isResumeOffer: true, hasTarget: false }))
    ).toBeNull();
  });
});

describe("문구", () => {
  /**
   * 두 클라가 **같은 상수**를 든다. 복제하면 두 경로가 같은 상황에 다른 말을 하기
   * 시작한다 — 폰의 `useOnline.ts` 가 적어 둔 이유 그대로이고, 이제 그 「두 화면」이
   * 두 클라다.
   */
  it("오프라인 문장은 때의 문제를 말하고, 안내 문장은 자리의 문제를 말한다", () => {
    expect(APPROVAL_OFFLINE_COPY).toContain("다시 연결되면");
    expect(APPROVAL_ELSEWHERE_COPY).toContain("인박스나 데스크톱");
    expect(APPROVAL_OFFLINE_COPY).not.toBe(APPROVAL_ELSEWHERE_COPY);
  });

  it("사과하지 않고, em-dash를 쓰지 않는다 (SKILL §7)", () => {
    for (const copy of [APPROVAL_OFFLINE_COPY, APPROVAL_ELSEWHERE_COPY]) {
      expect(copy).not.toMatch(/[—–]/);
      expect(copy).not.toContain("죄송");
    }
  });
});
