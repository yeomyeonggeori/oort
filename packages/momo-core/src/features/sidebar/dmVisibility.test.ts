import { describe, expect, it } from "vitest";
import {
  DM_CLOSE_STAR_FIRST_HINT,
  dmCloseBlockedByStar,
  dmCloseOffered,
  dmClosedListReason,
  dmReadFacts,
  dmClosedReasonLabel,
  dmReopenLabelFor,
  DM_CLOSED_LIST_HINT,
  DM_CLOSED_LIST_LABEL,
  DM_REOPEN_LABEL,
  dmVisibility,
  type DmVisibilityInput,
  type DmVisibilityRule,
} from "./dmVisibility";

// ADR-0177 증보 D8 의 표 9줄과 `unknown` 을 한 행렬로 잰다. 기본 입력은 「9번: 그 밖」이고, 각 행은 **그 줄만** 맞도록 한 칸씩
// 바꾼다. 그래서 줄을 지우거나 순서를 바꾸면 이름을 부르며 빨개진다.
const BASE: DmVisibilityInput = {
  isOpen: false,
  starredOrSectioned: false,
  closedAtSeq: null,
  latestReadableSeq: 10,
  lastReadSeq: 10,
  markedUnreadBeforeSeq: null,
  mentionCount: 0,
  counterpart: "present",
  phase: "ready",
};

interface Row {
  name: string;
  input: Partial<DmVisibilityInput>;
  visibility: "shown" | "hidden" | "hold";
  rule: DmVisibilityRule;
}

const MATRIX: Row[] = [
  // 1 - 열림은 무엇보다 먼저다: 닫은 DM, 나간 상대, 에러, 로딩이어도 보는 대화는 사라지지 않는다.
  { name: "1 열림", input: { isOpen: true }, visibility: "shown", rule: 1 },
  { name: "1 열림이 닫힘(7)보다 먼저", input: { isOpen: true, closedAtSeq: 10 }, visibility: "shown", rule: 1 },
  { name: "1 열림이 나간 상대(6)보다 먼저", input: { isOpen: true, counterpart: "gone" }, visibility: "shown", rule: 1 },
  { name: "1 열림이 로딩(3)보다 먼저", input: { isOpen: true, phase: "loading" }, visibility: "shown", rule: 1 },
  // 2 - 모를 때 숨기는 쪽이 최악이다.
  { name: "2 투영 오류", input: { phase: "error", closedAtSeq: 10 }, visibility: "shown", rule: 2 },
  { name: "2 오류가 로딩이 아님", input: { phase: "error", counterpart: "gone" }, visibility: "shown", rule: 2 },
  // 3 - 직전 판정 유지.
  { name: "3 로딩", input: { phase: "loading", closedAtSeq: 10 }, visibility: "hold", rule: 3 },
  { name: "3 로딩이 별표(4)보다 먼저", input: { phase: "loading", starredOrSectioned: true }, visibility: "hold", rule: 3 },
  // 4 - 별표·섹션.
  { name: "4 별표, 닫힘 기록이 있어도", input: { starredOrSectioned: true, closedAtSeq: 10 }, visibility: "shown", rule: 4 },
  { name: "4 별표, 나간 상대여도", input: { starredOrSectioned: true, counterpart: "gone" }, visibility: "shown", rule: 4 },
  // 5 - 사람이 직접 남긴 신호.
  { name: "5 안 읽음으로 표시", input: { markedUnreadBeforeSeq: 7, closedAtSeq: 10 }, visibility: "shown", rule: 5 },
  { name: "5 멘션", input: { mentionCount: 1, closedAtSeq: 10 }, visibility: "shown", rule: 5 },
  { name: "5 나간 상대여도 멘션이 있으면", input: { mentionCount: 2, counterpart: "gone" }, visibility: "shown", rule: 5 },
  // 6 - 나간 상대 + 안 읽은 것 없음.
  { name: "6 나간 상대, 다 읽음", input: { counterpart: "gone" }, visibility: "hidden", rule: 6 },
  { name: "6 경계: 읽을 seq 가 읽은 seq 와 같다", input: { counterpart: "gone", latestReadableSeq: 10, lastReadSeq: 10 }, visibility: "hidden", rule: 6 },
  { name: "6 나간 상대 + 안 읽은 읽을 메시지 -> 보임(9)", input: { counterpart: "gone", latestReadableSeq: 11 }, visibility: "shown", rule: 9 },
  // 6 이 7·8 보다 먼저: 되살아난 뒤 다 읽으면 다시 숨는다.
  { name: "6 되살아난 뒤 다 읽음 -> 숨김 (6이 8보다 먼저)", input: { counterpart: "gone", closedAtSeq: 5, latestReadableSeq: 10, lastReadSeq: 10 }, visibility: "hidden", rule: 6 },
  { name: "6 닫은 나간 상대도 6 으로 숨는다(7 이 아니다)", input: { counterpart: "gone", closedAtSeq: 10 }, visibility: "hidden", rule: 6 },
  { name: "6 닫은 값을 모르는 나간 상대도 6 이 먼저", input: { counterpart: "gone", closedAtSeq: undefined }, visibility: "hidden", rule: 6 },
  // unknown - 명부 미완이면 6 을 적용하지 않는다.
  { name: "unknown 명부 미완이면 6 을 건너뛴다", input: { counterpart: "unknown" }, visibility: "shown", rule: 9 },
  { name: "unknown 이어도 명시적 닫기(7)는 그대로", input: { counterpart: "unknown", closedAtSeq: 10 }, visibility: "hidden", rule: 7 },
  // 7·8 - 명시적 닫기와 되살림.
  { name: "7 닫음, 새 것 없음", input: { closedAtSeq: 10, latestReadableSeq: 10 }, visibility: "hidden", rule: 7 },
  { name: "7 닫음, 기계 메시지만 왔다(읽을 seq 불변)", input: { closedAtSeq: 10, latestReadableSeq: 10, lastReadSeq: 4 }, visibility: "hidden", rule: 7 },
  { name: "7 처음부터 0 에서 닫음", input: { closedAtSeq: 0, latestReadableSeq: 0, lastReadSeq: 0 }, visibility: "hidden", rule: 7 },
  { name: "8 닫은 뒤 읽을 메시지가 옴", input: { closedAtSeq: 10, latestReadableSeq: 11 }, visibility: "shown", rule: 8 },
  // 9 - 그 밖.
  { name: "9 안 닫음(null)", input: { closedAtSeq: null }, visibility: "shown", rule: 9 },
  // `undefined`("이 응답이 말하지 않았다")는 `null`("안 닫았다")이 아니다.
  { name: "undefined 는 안 닫음이 아니다 -> 직전 판정 유지", input: { closedAtSeq: undefined }, visibility: "hold", rule: 3 },
];

describe("DM 보임 판정 (ADR-0177 D8)", () => {
  for (const row of MATRIX) {
    it(row.name, () => {
      const got = dmVisibility({ ...BASE, ...row.input });
      expect({ visibility: got.visibility, rule: got.rule }).toEqual({
        visibility: row.visibility,
        rule: row.rule,
      });
    });
  }

  it("표의 아홉 줄이 모두 행렬에 있다(줄을 하나 빼면 이 시험이 먼저 빨개진다)", () => {
    const covered = new Set(MATRIX.map((row) => row.rule));
    for (const rule of [1, 2, 3, 4, 5, 6, 7, 8, 9] as const) {
      expect(covered.has(rule)).toBe(true);
    }
  });

  it("보임·숨김·유지 세 결과가 모두 행렬에 나온다", () => {
    expect(new Set(MATRIX.map((row) => row.visibility))).toEqual(
      new Set(["shown", "hidden", "hold"])
    );
  });
});

describe("닫기를 내미는가 (D7)", () => {
  const OK = { phase: "ready", unreadCount: 0, mentionCount: 0, starredOrSectioned: false } as const;

  it("읽음 투영이 준비되고 안 읽음이 없고 별표가 아니면 내민다", () => {
    expect(dmCloseOffered(OK)).toBe(true);
  });

  it("안 읽음·멘션·투영 미준비·별표 하나씩이 각각 막는다", () => {
    expect(dmCloseOffered({ ...OK, unreadCount: 1 })).toBe(false);
    expect(dmCloseOffered({ ...OK, mentionCount: 1 })).toBe(false);
    expect(dmCloseOffered({ ...OK, phase: "loading" })).toBe(false);
    expect(dmCloseOffered({ ...OK, phase: "error" })).toBe(false);
    expect(dmCloseOffered({ ...OK, starredOrSectioned: true })).toBe(false);
  });

  it("「별표를 먼저 빼요」 안내는 별표가 **유일한** 이유일 때만 선다", () => {
    expect(dmCloseBlockedByStar({ ...OK, starredOrSectioned: true })).toBe(true);
    expect(dmCloseBlockedByStar({ ...OK, starredOrSectioned: true, unreadCount: 3 })).toBe(false);
    expect(dmCloseBlockedByStar({ ...OK, starredOrSectioned: true, phase: "loading" })).toBe(false);
    expect(dmCloseBlockedByStar(OK)).toBe(false);
    expect(DM_CLOSE_STAR_FIRST_HINT).toBe("별표를 먼저 빼요");
  });
});

describe("「닫은 대화」 목록에 드는 줄 (D11)", () => {
  it("명시적 닫기(7)와 나간 상대(6)만 든다", () => {
    expect(dmClosedListReason(7)).toBe("closed");
    expect(dmClosedListReason(6)).toBe("gone");
    for (const rule of [1, 2, 3, 4, 5, 8, 9] as const) {
      expect(dmClosedListReason(rule)).toBeNull();
    }
  });
});

describe("「닫은 대화」 문구 (D11)", () => {
  it("이유 줄: 닫음은 「내가 닫았어요」, 나간 상대는 원인(상대가 나갔다)과 조건(안 읽은 메시지가 없다)을 함께 말한다", () => {
    expect(dmClosedReasonLabel("closed")).toBe("내가 닫았어요");
    expect(dmClosedReasonLabel("gone")).toBe("상대가 나갔고 안 읽은 메시지가 없어요");
  });

  it("동작 낱말: 닫은 대화는 「다시 열기」, 나간 상대는 풀 닫힘이 없어 「열기」", () => {
    expect(DM_REOPEN_LABEL).toBe("다시 열기");
    expect(dmReopenLabelFor("closed")).toBe("다시 열기");
    expect(dmReopenLabelFor("gone")).toBe("열기");
  });

  it("제목과 힌트는 한 번씩만 말한다", () => {
    expect(DM_CLOSED_LIST_LABEL).toBe("닫은 대화");
    expect(DM_CLOSED_LIST_HINT).toContain("새 메시지가 오면");
    expect(DM_CLOSED_LIST_HINT).not.toContain("—");
  });
});

describe("읽음 투영 행에서 판정 입력 뽑기 (dmReadFacts, #4367)", () => {
  const row = {
    channelId: "c",
    lastReadSeq: 4,
    latestSeq: 9,
    unreadCount: 5,
    mentionCount: 2,
    markedUnreadBeforeSeq: 3,
    latestReadableSeq: 6,
    closedAtSeq: 5,
  };

  it("서버가 닫기를 싣는 동안은 행 그대로다", () => {
    expect(dmReadFacts(row, true)).toEqual({
      closedAtSeq: 5,
      latestReadableSeq: 6,
      lastReadSeq: 4,
      markedUnreadBeforeSeq: 3,
      mentionCount: 2,
    });
  });

  it("closedAtSeq 의 세 상태를 섞지 않는다: undefined 는 undefined 로 남는다 (null 로 읽으면 닫은 DM 이 되살아난다)", () => {
    expect(dmReadFacts({ ...row, closedAtSeq: undefined }, true).closedAtSeq).toBeUndefined();
    expect(dmReadFacts({ ...row, closedAtSeq: null }, true).closedAtSeq).toBeNull();
  });

  it("행이 읽을 seq 를 말하지 않았으면 전체 seq 로 대신한다", () => {
    expect(dmReadFacts({ ...row, latestReadableSeq: undefined }, true).latestReadableSeq).toBe(9);
  });

  it("옛 서버: 닫힘이 없고 읽을 seq 는 전체 seq 다 - 행이 뭐라 하든", () => {
    const facts = dmReadFacts(row, false);
    expect(facts.closedAtSeq).toBeNull();
    expect(facts.latestReadableSeq).toBe(9);
  });

  it("행이 없는 DM: 닫을 것도 읽을 것도 없다", () => {
    expect(dmReadFacts(undefined, true)).toEqual({
      closedAtSeq: null,
      latestReadableSeq: 0,
      lastReadSeq: 0,
      markedUnreadBeforeSeq: null,
      mentionCount: 0,
    });
  });
});
