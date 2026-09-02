import { describe, expect, it } from "vitest";
import type { Message } from "@momo/core/lib/api";
import {
  countNewerThan,
  countUnreadJump,
  dataIndexFromVirtuoso,
  dividerRectRelation,
  dividerViewportRelation,
  newestSeqOf,
  reconcileDividerRelation,
  relationFromIntersection,
  firstUnreadMessageSeq,
  shouldLatchUnreadJump,
  shouldShowJumpUnread,
  timelineScrollBehavior,
  unreadDividerIndexOf,
} from "./navigation";

// 「아래 새 메시지 N개」가 참인가. 이 산수가 틀려도 화면은 멀쩡해 보이고 사람만
// 잘못 안다 — 그래서 화면이 아니라 숫자를 잰다 (진단 M-9).

const OTHER = "00000000-0000-7000-8000-000000000101";
const ME = "00000000-0000-7000-8000-0000000001ff";

function message(seq: number, authorMemberId: string = OTHER): Message {
  return {
    id: `0199cccc-0000-7000-8000-${String(seq).padStart(12, "0")}`,
    channelId: "0199cccc-0000-7000-8000-000000000201",
    seq,
    authorMemberId,
    body: `메시지 ${seq}`,
    type: "text",
    state: "sent",
    createdAtMs: 1_700_000_000_000 + seq * 1_000,
    hlcTs: 1_700_000_000_000 + seq * 1_000,
    hlcCount: 0,
  };
}

/** 내가 보낸 확정 행 (seq 를 받은 뒤 — 낙관적 메아리가 아니다). */
function mine(seq: number): Message {
  return message(seq, ME);
}

const stream = [41, 42, 43, 44].map((seq) => message(seq));

describe("newestSeqOf", () => {
  it("빈 채널에는 기준선이 없다", () => {
    expect(newestSeqOf([])).toBeNull();
  });

  it("꼬리의 seq가 기준선이다", () => {
    expect(newestSeqOf(stream)).toBe(44);
  });
});

describe("countNewerThan", () => {
  it("바닥을 떠난 뒤 아무것도 오지 않았으면 0이다", () => {
    expect(countNewerThan(stream, 44)).toBe(0);
  });

  it("꼬리에 붙은 것만 센다", () => {
    expect(countNewerThan([...stream, message(45), message(46)], 44)).toBe(2);
  });

  it("위로 더 불러온 옛 페이지는 새 메시지가 아니다", () => {
    // `?before` prepend. 이것을 세면 위로 스크롤할 때마다 「아래 새 메시지」가
    // 늘어난다 — 이 goal이 피해야 할 정확한 거짓말이다.
    const older = [37, 38, 39, 40].map((seq) => message(seq));
    expect(countNewerThan([...older, ...stream], 44)).toBe(0);
  });

  it("옛 페이지와 새 메시지가 같은 판에 들어와도 새것만 센다", () => {
    const older = [37, 38].map((seq) => message(seq));
    const withNew = [...older, ...stream, message(45)];
    expect(countNewerThan(withNew, 44)).toBe(1);
  });

  it("기준선 자체는 새것이 아니다", () => {
    expect(countNewerThan(stream, 43)).toBe(1);
  });

  it("빈 목록은 0이다", () => {
    expect(countNewerThan([], 44)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// M-3 (design-review U4-5) — 「새 메시지」는 남의 말이다
//
// 위로 올라가 읽던 중에 한 줄 보내면 화면이 「새 메시지 1개 보기」를 띄웠다. 그것이
// 가리키는 곳은 **내가 방금 쓴 문장**이고, 같은 낱말이 안읽음 구분선에서는 남의
// 말을 뜻한다. 낙관적 메아리는 이 배열에 없으므로 결함은 **확정된 뒤에** 나타났다.
// ---------------------------------------------------------------------------
describe("countNewerThan — 저자", () => {
  it("내 확정 전송은 「새 메시지」가 아니다", () => {
    expect(countNewerThan([...stream, mine(45)], 44, ME)).toBe(0);
  });

  it("내가 끼어들어도 그 아래 남의 말은 계속 센다", () => {
    // `continue`이지 `break`가 아니라는 것. 내가 한 줄 썼다고 그 뒤에 온 남의
    // 말이 안 보이면 처음 결함과 같은 종류의 거짓말이 된다.
    const tail = [message(45), mine(46), message(47)];
    expect(countNewerThan([...stream, ...tail], 44, ME)).toBe(2);
  });

  it("전부 내 것이면 셀 것이 없다 — 그때 라벨은 「최신 메시지로 이동」이다", () => {
    expect(countNewerThan([...stream, mine(45), mine(46)], 44, ME)).toBe(0);
  });

  it("대소문자가 섞여도 같은 사람이다 — 와이어가 섞어 보낸다", () => {
    expect(countNewerThan([...stream, mine(45)], 44, ME.toUpperCase())).toBe(0);
  });

  it("저자를 모르면 빼지 않는다 — 남의 말을 놓치는 쪽이 더 나쁘다", () => {
    // 행 액션이 없는 표면(작업 세션 기록)에는 `myMemberId`가 없다.
    expect(countNewerThan([...stream, mine(45)], 44)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// BF-A2 — 상단 「새 메시지 N개」. 산수가 틀리면 필이 거짓을 말하고, 창 위치가
// 틀리면 구분선이 보이는데도 떠 있거나 위쪽에 쌓였는데도 안 뜬다.
// ---------------------------------------------------------------------------
describe("countUnreadJump", () => {
  it("동결 스냅샷이 없으면 셀 것이 없다", () => {
    expect(countUnreadJump(null)).toBe(0);
    expect(countUnreadJump(0)).toBe(0);
    expect(countUnreadJump(undefined)).toBe(0);
  });

  it("구분선과 같은 수다 — 라이브 꼬리를 다시 세지 않는다", () => {
    expect(countUnreadJump(5)).toBe(5);
    // (b) 하단은 꼬리를 세고 (a) 상단은 연 순간의 N을 그대로 쓴다.
    const tail = [...stream, message(45), message(46)];
    expect(countNewerThan(tail, 44, ME)).toBe(2);
    expect(countUnreadJump(5)).not.toBe(countNewerThan(tail, 44, ME));
  });
});

describe("unreadDividerIndexOf", () => {
  it("구분선이 없으면 null이다", () => {
    expect(unreadDividerIndexOf([{ kind: "message" }, { kind: "day" }])).toBeNull();
  });

  it("첫 안읽음 항목의 첨자를 돌려준다", () => {
    expect(
      unreadDividerIndexOf([
        { kind: "day" },
        { kind: "message" },
        { kind: "unread" },
        { kind: "message" },
      ])
    ).toBe(2);
  });
});

describe("dataIndexFromVirtuoso", () => {
  it("firstItemIndex가 앞에 얹히면 뺀다", () => {
    expect(dataIndexFromVirtuoso(1_000_007, 1_000_000)).toBe(7);
  });

  it("이미 데이터 첨자면 그대로 둔다", () => {
    expect(dataIndexFromVirtuoso(7, 1_000_000)).toBe(7);
  });
});

describe("dividerViewportRelation", () => {
  it("구분선이 없으면 absent이다", () => {
    expect(dividerViewportRelation(null, 0, 10)).toBe("absent");
  });

  it("창 시작보다 앞이면 위쪽 밖이다", () => {
    expect(dividerViewportRelation(2, 8, 20)).toBe("above");
  });

  it("창 끝보다 뒤면 아래쪽 밖이다", () => {
    expect(dividerViewportRelation(21, 8, 20)).toBe("below");
  });

  it("창 안에 있으면 in이다", () => {
    expect(dividerViewportRelation(10, 8, 20)).toBe("in");
    expect(dividerViewportRelation(8, 8, 20)).toBe("in");
    expect(dividerViewportRelation(20, 8, 20)).toBe("in");
  });
});

describe("reconcileDividerRelation", () => {
  it("IO가 위쪽을 실측하면 range의 「안」(오버스캔)을 이긴다", () => {
    expect(
      reconcileDividerRelation({
        dividerIndex: 10,
        visibleStart: 8,
        visibleEnd: 20,
        observed: "above",
      })
    ).toBe("above");
  });

  it("구분선이 DOM에 없으면 range가 위/아래를 안다", () => {
    expect(
      reconcileDividerRelation({
        dividerIndex: 2,
        visibleStart: 40,
        visibleEnd: 55,
        observed: null,
      })
    ).toBe("above");
  });

  it("range를 아직 모르면 필을 띄우지 않는다", () => {
    expect(
      reconcileDividerRelation({
        dividerIndex: 2,
        visibleStart: null,
        visibleEnd: null,
        observed: null,
      })
    ).toBe("absent");
  });
});

describe("relationFromIntersection", () => {
  const root = { top: 100, bottom: 500 };

  it("겹치면 창 안이다", () => {
    expect(
      relationFromIntersection({
        isIntersecting: true,
        rootBounds: root,
        boundingClientRect: { top: 90, bottom: 120 },
      })
    ).toBe("in");
  });

  it("완전히 위면 above이다", () => {
    expect(
      relationFromIntersection({
        isIntersecting: false,
        rootBounds: root,
        boundingClientRect: { top: 10, bottom: 40 },
      })
    ).toBe("above");
  });

  it("완전히 아래면 below이다", () => {
    expect(
      relationFromIntersection({
        isIntersecting: false,
        rootBounds: root,
        boundingClientRect: { top: 520, bottom: 560 },
      })
    ).toBe("below");
  });

  it("정렬 중 창 안 in 다음 15ms 뒤 above 는 래치 없이 필을 무장한다 (H-5)", () => {
    const mid = relationFromIntersection({
      isIntersecting: true,
      rootBounds: { top: 85, bottom: 694 },
      boundingClientRect: { top: 144, bottom: 178 },
    });
    expect(mid).toBe("in");
    expect(shouldLatchUnreadJump(mid, false)).toBe(false);
    const later = relationFromIntersection({
      isIntersecting: false,
      rootBounds: { top: 85, bottom: 694 },
      boundingClientRect: { top: -284, bottom: -250 },
    });
    expect(later).toBe("above");
    expect(shouldLatchUnreadJump(later, false)).toBe(false);
    expect(shouldShowJumpUnread(later, 4, false)).toBe(true);
  });
});

describe("dividerRectRelation", () => {
  const viewport = { top: 85, bottom: 800 };

  it("뷰포트 위면 above, 겹치면 in, 아래면 below다", () => {
    expect(dividerRectRelation({ top: -283, bottom: -249 }, viewport)).toBe(
      "above"
    );
    expect(dividerRectRelation({ top: 90, bottom: 120 }, viewport)).toBe("in");
    expect(dividerRectRelation({ top: 820, bottom: 850 }, viewport)).toBe(
      "below"
    );
  });
});

describe("shouldLatchUnreadJump", () => {
  it("IO가 실측한 창 안만 래치한다", () => {
    expect(shouldLatchUnreadJump("in")).toBe(true);
    expect(shouldLatchUnreadJump("above")).toBe(false);
    expect(shouldLatchUnreadJump("below")).toBe(false);
    expect(shouldLatchUnreadJump("absent")).toBe(false);
    expect(shouldLatchUnreadJump(null)).toBe(false);
  });

  it("초기 정렬이 끝나기 전의 in 은 래치하지 않는다 (H-5)", () => {
    expect(shouldLatchUnreadJump("in", false)).toBe(false);
    expect(shouldLatchUnreadJump("in", true)).toBe(true);
  });

  it("range 폴백 「in」은 래치 입력이 아니다", () => {
    const rangeIn = reconcileDividerRelation({
      dividerIndex: 10,
      visibleStart: 8,
      visibleEnd: 20,
      observed: null,
    });
    expect(rangeIn).toBe("in");
    expect(shouldLatchUnreadJump(null)).toBe(false);
  });
});

describe("shouldShowJumpUnread", () => {
  it("구분선이 위쪽 밖이고 N이 있을 때만 뜬다", () => {
    expect(shouldShowJumpUnread("above", 3)).toBe(true);
    expect(shouldShowJumpUnread("in", 3)).toBe(false);
    expect(shouldShowJumpUnread("below", 3)).toBe(false);
    expect(shouldShowJumpUnread("absent", 3)).toBe(false);
    expect(shouldShowJumpUnread("above", 0)).toBe(false);
  });

  it("래치되면 위쪽 밖이어도 다시 서지 않는다", () => {
    expect(shouldShowJumpUnread("above", 3, true)).toBe(false);
    expect(shouldShowJumpUnread("above", 3, false)).toBe(true);
  });
});

describe("firstUnreadMessageSeq", () => {
  it("구분선 다음 첫 메시지의 seq다", () => {
    expect(
      firstUnreadMessageSeq(
        [
          { kind: "day" },
          { kind: "message", message: { seq: 3 } },
          { kind: "unread" },
          { kind: "message", message: { seq: 4 } },
          { kind: "message", message: { seq: 5 } },
        ],
        2
      )
    ).toBe(4);
  });

  it("구분선이 없으면 착지가 없다", () => {
    expect(firstUnreadMessageSeq([{ kind: "message", message: { seq: 1 } }], null)).toBeNull();
  });
});

describe("timelineScrollBehavior", () => {
  it("reduced-motion이면 즉시, 아니면 smooth다", () => {
    expect(timelineScrollBehavior(true)).toBe("auto");
    expect(timelineScrollBehavior(false)).toBe("smooth");
  });
});
