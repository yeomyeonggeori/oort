import { describe, expect, it } from "vitest";
import { pushAlikeDmUnread, type PushAlikeDmInput } from "./model";

// #5660 (owner 2026-11-11 「켜줘」): 폰이 울리는 DM은 맥의 메뉴 막대 점·독 배지도 켠다. 수는 서버 읽음 투영 그대로이고, 폰 푸시와 같은
// 순서로 거른다(일시 중지 → 채널 알림 끄기 → 지금 보는 중). 멘션 몫은 이미 「나에게 필요한 일」로 셌으니 빼 둔다.

const A = "00000000-0000-7000-8000-0000000000a1";
const B = "00000000-0000-7000-8000-0000000000b2";
const C = "00000000-0000-7000-8000-0000000000c3";

function input(over: Partial<PushAlikeDmInput> = {}): PushAlikeDmInput {
  const rows: Record<string, { unreadCount: number; mentionCount: number }> = {
    [A]: { unreadCount: 3, mentionCount: 0 },
    [B]: { unreadCount: 2, mentionCount: 1 },
    [C]: { unreadCount: 5, mentionCount: 0 },
  };
  return {
    dms: [
      { id: A, muted: false },
      { id: B, muted: false },
      { id: C, muted: true },
    ],
    readState: (id) => rows[id.toLowerCase()],
    paused: false,
    viewingChannelId: null,
    ...over,
  };
}

describe("pushAlikeDmUnread (#5660)", () => {
  it("알림을 끄지 않은 DM의 서버 안 읽음 수를 더하고, 멘션 몫은 빼서 두 번 세지 않는다", () => {
    // A 3 + B (2 - 멘션 1) = 4. C 는 알림을 껐다.
    expect(pushAlikeDmUnread(input())).toBe(4);
  });

  it("투영이 줄면 수도 준다: 다른 기기에서 읽은 것이 다음 투영에 그대로 닿는다", () => {
    const read = input({
      readState: (id) => (id === A ? { unreadCount: 0, mentionCount: 0 } : id === B ? { unreadCount: 1, mentionCount: 1 } : undefined),
    });
    expect(pushAlikeDmUnread(read)).toBe(0);
  });

  it("지금 앞에서 보고 있는 DM은 세지 않는다(대소문자가 달라도 같은 대화다)", () => {
    expect(pushAlikeDmUnread(input({ viewingChannelId: A.toUpperCase() }))).toBe(1);
  });

  it("알림 일시 중지(방해 금지) 중에는 DM 몫이 없다 — 폰도 울리지 않는다", () => {
    expect(pushAlikeDmUnread(input({ paused: true }))).toBe(0);
  });

  it("투영에 줄이 없거나 값이 깨졌으면 그 DM은 0이다(지어내지 않는다)", () => {
    expect(
      pushAlikeDmUnread(
        input({ readState: (id) => (id === A ? { unreadCount: Number.NaN, mentionCount: 0 } : id === B ? { unreadCount: -4, mentionCount: 0 } : undefined) })
      )
    ).toBe(0);
  });
});
