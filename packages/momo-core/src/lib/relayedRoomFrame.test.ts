import { describe, expect, it } from "vitest";
import { centrifugoChannelName, relayedRoomChannel } from "./realtimeEvents";

// 개인 채널로 옮겨 온 방 프레임 (ADR-0177 증보 2026-11-14 D17, #5825).
describe("relayedRoomChannel", () => {
  const WS = "00000000-0000-7000-8000-000000000001";
  const CH = "00000000-0000-7000-8000-000000000302";

  it("room_channel 이 있는 방 프레임은 그 방 채널 이름을 돌려준다", () => {
    const room = centrifugoChannelName(WS, CH);
    expect(relayedRoomChannel({ type: "message.edited", v: 1, ts: 1, seq: 3, payload: {}, room_channel: room })).toBe(room);
  });

  it("개인 채널 본래의 신호(받은함·예약·팔로우)와 옛 서버의 프레임은 null - 지금까지와 같다", () => {
    expect(relayedRoomChannel({ type: "inbox_item.created", payload: {} })).toBeNull();
    expect(relayedRoomChannel({ type: "scheduled_message.updated", payload: {} })).toBeNull();
    expect(relayedRoomChannel({ type: "followed_unread.updated" })).toBeNull();
    expect(relayedRoomChannel(null)).toBeNull();
    expect(relayedRoomChannel("ch:ws1.2")).toBeNull();
  });

  it("방 채널(ch:)이 아닌 이름은 받지 않는다", () => {
    expect(relayedRoomChannel({ type: "message.edited", room_channel: "user:read-state#X" })).toBeNull();
    expect(relayedRoomChannel({ type: "message.edited", room_channel: 42 })).toBeNull();
  });
});
