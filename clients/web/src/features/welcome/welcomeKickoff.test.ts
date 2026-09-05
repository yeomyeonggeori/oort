// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  WELCOME_BACKSTOP_COPY,
  WELCOME_BACKSTOP_MS,
  WELCOME_SHOWN_STORAGE_PREFIX,
  WELCOME_STAGE_COPY,
  decideWelcomeMount,
  hasAgentAuthoredMessage,
  isDefaultWelcomeChannel,
  messagesBelongToChannel,
  readShownMarker,
  welcomePromptTooLong,
  welcomeShownKey,
  writeShownMarker,
} from "./welcomeKickoff";

const WS = "00000000-0000-7000-8000-000000000001";
const OTHER_WS = "00000000-0000-7000-8000-000000000002";
const MEMBER = "00000000-0000-7000-8000-000000000101";
const OTHER_MEMBER = "00000000-0000-7000-8000-000000000102";
const AGENT = "00000000-0000-7000-8000-000000000201";
const HUMAN = "00000000-0000-7000-8000-000000000101";

const fresh = { workspaceId: WS, memberId: MEMBER };

function mount(over: Partial<Parameters<typeof decideWelcomeMount>[0]> = {}) {
  return decideWelcomeMount({
    freshSignup: fresh,
    workspaceId: WS,
    memberId: MEMBER,
    channelKind: "public",
    channelName: "general",
    timelineStatus: "ready",
    hasAgentAuthoredMessage: false,
    shown: false,
    ...over,
  });
}

afterEach(() => {
  localStorage.removeItem(welcomeShownKey(WS, MEMBER));
});

describe("decideWelcomeMount early returns", () => {
  it("no-fresh-signup", () => {
    expect(mount({ freshSignup: null })).toEqual({
      show: false,
      reason: "no-fresh-signup",
    });
  });

  it("wrong-workspace", () => {
    expect(mount({ workspaceId: OTHER_WS })).toEqual({
      show: false,
      reason: "wrong-workspace",
    });
  });

  it("wrong-member", () => {
    expect(mount({ memberId: OTHER_MEMBER })).toEqual({
      show: false,
      reason: "wrong-member",
    });
  });

  it("not-default-channel: private", () => {
    expect(mount({ channelKind: "private" })).toEqual({
      show: false,
      reason: "not-default-channel",
    });
  });

  it("not-default-channel: other public name", () => {
    expect(mount({ channelName: "엔진" })).toEqual({
      show: false,
      reason: "not-default-channel",
    });
  });

  it("not-default-channel: dm", () => {
    expect(mount({ channelKind: "dm", channelName: "general" })).toEqual({
      show: false,
      reason: "not-default-channel",
    });
  });

  it("timeline-not-ready", () => {
    expect(mount({ timelineStatus: "loading" })).toEqual({
      show: false,
      reason: "timeline-not-ready",
    });
  });

  it("has-agent-message at mount", () => {
    expect(mount({ hasAgentAuthoredMessage: true })).toEqual({
      show: false,
      reason: "has-agent-message",
    });
  });

  it("already-shown", () => {
    expect(mount({ shown: true })).toEqual({
      show: false,
      reason: "already-shown",
    });
  });

  it("show when every gate holds", () => {
    expect(mount()).toEqual({ show: true });
  });
});

describe("isDefaultWelcomeChannel", () => {
  it("public general is the server default channel", () => {
    expect(isDefaultWelcomeChannel({ kind: "public", name: "general" })).toBe(
      true
    );
  });

  it("public non-general is not", () => {
    expect(isDefaultWelcomeChannel({ kind: "public", name: "엔진" })).toBe(
      false
    );
  });
});

describe("hasAgentAuthoredMessage", () => {
  it("true when a message author is kind agent", () => {
    expect(
      hasAgentAuthoredMessage(
        [{ authorMemberId: AGENT }, { authorMemberId: HUMAN }],
        (id) => (id === AGENT ? "agent" : "human")
      )
    ).toBe(true);
  });

  it("false when every author is human", () => {
    expect(
      hasAgentAuthoredMessage([{ authorMemberId: HUMAN }], () => "human")
    ).toBe(false);
  });

  it("false when the author is unknown", () => {
    expect(
      hasAgentAuthoredMessage([{ authorMemberId: AGENT }], () => undefined)
    ).toBe(false);
  });
});

describe("messagesBelongToChannel", () => {
  const HERE = "00000000-0000-7000-8000-000000000201";
  const THERE = "00000000-0000-7000-8000-000000000202";

  it("empty list matches", () => {
    expect(messagesBelongToChannel([], HERE)).toBe(true);
  });

  it("rows without channelId match (test fixtures that only pass author)", () => {
    expect(messagesBelongToChannel([{}], HERE)).toBe(true);
  });

  it("rows for this channel match, including case", () => {
    expect(
      messagesBelongToChannel([{ channelId: HERE.toUpperCase() }], HERE)
    ).toBe(true);
  });

  it("a row from another channel does not match", () => {
    expect(
      messagesBelongToChannel(
        [{ channelId: HERE }, { channelId: THERE }],
        HERE
      )
    ).toBe(false);
  });

  it("null channelId matches everything", () => {
    expect(messagesBelongToChannel([{ channelId: THERE }], null)).toBe(true);
  });
});

describe("shown marker", () => {
  it("key is oort.welcomeKickoffShown.v1:{workspaceId}:{memberId}", () => {
    expect(welcomeShownKey(WS, MEMBER)).toBe(
      `${WELCOME_SHOWN_STORAGE_PREFIX}:${WS}:${MEMBER}`
    );
  });

  it("round trip write then read", () => {
    expect(readShownMarker(WS, MEMBER)).toBe(false);
    writeShownMarker(WS, MEMBER);
    expect(readShownMarker(WS, MEMBER)).toBe(true);
  });

  it("marker for another workspace does not count", () => {
    writeShownMarker(OTHER_WS, MEMBER);
    expect(readShownMarker(WS, MEMBER)).toBe(false);
  });
});

describe("copy and constants", () => {
  it("backstop is 120s named *_MS, not a CSS duration", () => {
    expect(WELCOME_BACKSTOP_MS).toBe(120_000);
  });

  it("stage sentence", () => {
    expect(WELCOME_STAGE_COPY).toBe("팀이 준비하고 있어요");
  });

  it("backstop sentence has no failure wording", () => {
    expect(WELCOME_BACKSTOP_COPY).toBe(
      "에이전트가 아직 준비 중이에요. 설정 › 에이전트에서 상태를 볼 수 있어요"
    );
    expect(WELCOME_BACKSTOP_COPY).not.toMatch(/실패|오류|error|fail/i);
  });

  it("2001 characters is a sentence rejection", () => {
    expect(welcomePromptTooLong("가".repeat(2000))).toBeNull();
    expect(welcomePromptTooLong("가".repeat(2001))).toBe(
      "웰컴 프롬프트는 2000자까지 쓸 수 있습니다."
    );
  });
});
