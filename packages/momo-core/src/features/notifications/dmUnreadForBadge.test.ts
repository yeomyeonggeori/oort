import { describe, expect, it } from "vitest";
import { dmUnreadForBadge, type DmBadgeInput } from "./model";

// #5660 (owner 2026-11-11 「켜줘」): 안 읽은 DM은 맥의 메뉴 막대 점·독 배지도 켠다. 수는 서버 읽음 투영 그대로이고, 배지의 규칙은 다른 몫과
// 같다(ADR-0124 D2·D4-A: 채널 알림 끄기·알림 일시 중지는 푸시만 막고 배지는 그대로). 거르는 것은 「지금 앞에서 보는 대화」와 「멘션과 두 번
// 세지 않기」뿐이다.

const A = "00000000-0000-7000-8000-0000000000a1";
const B = "00000000-0000-7000-8000-0000000000b2";
const C = "00000000-0000-7000-8000-0000000000c3";

function input(over: Partial<DmBadgeInput> = {}): DmBadgeInput {
  const rows: Record<string, { unreadCount: number; mentionCount: number }> = {
    [A]: { unreadCount: 3, mentionCount: 0 },
    [B]: { unreadCount: 2, mentionCount: 1 },
    [C]: { unreadCount: 5, mentionCount: 0 },
  };
  return {
    dms: [{ id: A }, { id: B }, { id: C }],
    readState: (id) => rows[id.toLowerCase()],
    viewingChannelId: null,
    ...over,
  };
}

describe("dmUnreadForBadge (#5660)", () => {
  it("DM의 서버 안 읽음 수를 더하고, 멘션 몫은 빼서 두 번 세지 않는다", () => {
    // A 3 + B (2 - 멘션 1) + C 5 = 9.
    expect(dmUnreadForBadge(input())).toBe(9);
  });

  it("알림을 끈 DM도 센다: 채널 알림 끄기는 푸시만 막고 배지는 그대로다(ADR-0124 D2)", () => {
    // 입력에 알림 끄기·일시 중지가 없다: 그 값으로 거를 길 자체가 없다는 것을 형태로 못박는다.
    expect(Object.keys(input()).sort()).toEqual(["dms", "readState", "viewingChannelId"]);
  });

  it("투영이 줄면 수도 준다: 다른 기기에서 읽은 것이 다음 투영에 그대로 닿는다", () => {
    const read = input({
      readState: (id) =>
        id === A ? { unreadCount: 0, mentionCount: 0 } : id === B ? { unreadCount: 1, mentionCount: 1 } : undefined,
    });
    expect(dmUnreadForBadge(read)).toBe(0);
  });

  it("지금 앞에서 보고 있는 DM은 세지 않는다(대소문자가 달라도 같은 대화다)", () => {
    expect(dmUnreadForBadge(input({ viewingChannelId: A.toUpperCase() }))).toBe(6);
  });

  it("투영에 줄이 없거나 값이 깨졌으면 그 DM은 0이다(지어내지 않는다)", () => {
    expect(
      dmUnreadForBadge(
        input({
          readState: (id) =>
            id === A ? { unreadCount: Number.NaN, mentionCount: 0 } : id === B ? { unreadCount: -4, mentionCount: 0 } : undefined,
        })
      )
    ).toBe(0);
  });
});
