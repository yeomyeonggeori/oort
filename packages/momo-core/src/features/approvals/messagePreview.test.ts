import { describe, expect, it } from "vitest";
import {
  isMessagePinAction,
  parseMessagePreview,
  MESSAGE_PREVIEW_KIND,
} from "./messagePreview";

const IDS = {
  messageId: "0199aa11-2222-7000-8000-0000000000c1",
  channelId: "00000000-0000-7000-8000-000000000202",
};

describe("고정 카드의 대상 메시지 미리보기", () => {
  it("kind 가 message 이고 두 id 가 있을 때만 값이다", () => {
    expect(
      parseMessagePreview({ kind: MESSAGE_PREVIEW_KIND, ...IDS, totalChars: 7, truncated: false })
    ).toEqual({ kind: "message", ...IDS, totalChars: 7, truncated: false });
    expect(parseMessagePreview({ kind: "message", messageId: IDS.messageId })).toBeNull();
    expect(parseMessagePreview({ kind: "message", channelId: IDS.channelId })).toBeNull();
    expect(parseMessagePreview({ kind: "avatar_image", ...IDS })).toBeNull();
    expect(parseMessagePreview(null)).toBeNull();
    expect(parseMessagePreview([])).toBeNull();
    expect(parseMessagePreview("message")).toBeNull();
  });

  it("truncated 는 정확히 true 일 때만 참이다", () => {
    expect(parseMessagePreview({ kind: "message", ...IDS, truncated: "true" })?.truncated).toBe(false);
    expect(parseMessagePreview({ kind: "message", ...IDS })?.truncated).toBe(false);
    expect(parseMessagePreview({ kind: "message", ...IDS, truncated: true })?.truncated).toBe(true);
  });

  it("고정 행동 id 는 둘뿐이다", () => {
    expect(isMessagePinAction("message.pin")).toBe(true);
    expect(isMessagePinAction("message.unpin")).toBe(true);
    expect(isMessagePinAction("channel.create")).toBe(false);
    expect(isMessagePinAction(undefined)).toBe(false);
    expect(isMessagePinAction(null)).toBe(false);
  });
});
