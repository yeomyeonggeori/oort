// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  WELCOME_BACKSTOP_COPY,
  WELCOME_BACKSTOP_HREF,
  WELCOME_BACKSTOP_LINK_LABEL,
  WELCOME_BACKSTOP_MS,
  WELCOME_PROMPT_LIMIT_SENTENCE,
  WELCOME_SHOWN_STORAGE_PREFIX,
  WELCOME_BAND_EXPRESSION,
  WELCOME_BAND_SLEEPY_COPY,
  countActiveAgents,
  decideWelcomeBand,
  decideWelcomeMount,
  hasAgentAuthoredMessage,
  isDefaultWelcomeChannel,
  isWelcomeDecisionPending,
  messagesBelongToChannel,
  readShownMarker,
  welcomeBandSpeaker,
  welcomeBandWorkingCopy,
  welcomePromptTooLong,
  welcomeShownKey,
  writeShownMarker,
} from "./welcomeKickoff";
import { AGENTS_NAV } from "@/features/sidebar/workspaceNav";
import type { RosterMember } from "@momo/core/lib/api";
import { GUIDE_STATE_TABLE } from "@momo/core/features/onboarding/guide";

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
    directoryStatus: "success",
    activeAgentCount: 1,
    hasUnresolvedAuthor: false,
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

  it("directory-not-ready while roster is pending", () => {
    expect(mount({ directoryStatus: "pending" })).toEqual({
      show: false,
      reason: "directory-not-ready",
    });
  });

  it("write CTA is held only while the mount is still pending", () => {
    const pendingInput = {
      freshSignup: fresh,
      workspaceId: WS,
      memberId: MEMBER,
      channelKind: "public" as const,
      channelName: "general",
      timelineStatus: "ready" as const,
      directoryStatus: "pending" as const,
      channelId: AGENT,
      messages: [] as { channelId?: string }[],
    };
    expect(isWelcomeDecisionPending(pendingInput)).toBe(true);
    expect(
      isWelcomeDecisionPending({ ...pendingInput, directoryStatus: "success" })
    ).toBe(false);
    expect(
      isWelcomeDecisionPending({ ...pendingInput, directoryStatus: "error" })
    ).toBe(false);
    expect(
      isWelcomeDecisionPending({ ...pendingInput, timelineStatus: "loading" })
    ).toBe(true);
    expect(isWelcomeDecisionPending({ ...pendingInput, freshSignup: null })).toBe(
      false
    );
  });

  it("unresolved-author after roster settled", () => {
    expect(mount({ hasUnresolvedAuthor: true })).toEqual({
      show: false,
      reason: "unresolved-author",
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

  it("no-active-agent releases hold before the opener stage", () => {
    expect(mount({ activeAgentCount: 0 })).toEqual({
      show: false,
      reason: "no-active-agent",
    });
  });

  it("no-active-agent does not wait for the default channel or timeline", () => {
    expect(
      mount({
        activeAgentCount: 0,
        channelName: "엔진",
        timelineStatus: "loading",
      })
    ).toEqual({ show: false, reason: "no-active-agent" });
  });

  it("one active agent still mounts when every other gate holds", () => {
    expect(mount({ activeAgentCount: 1 })).toEqual({ show: true });
  });
});

describe("countActiveAgents", () => {
  it("counts only kind=agent and status=active", () => {
    expect(countActiveAgents([])).toBe(0);
    expect(
      countActiveAgents([{ kind: "human", status: "active" }])
    ).toBe(0);
    expect(
      countActiveAgents([{ kind: "agent", status: "invited" }])
    ).toBe(0);
    expect(
      countActiveAgents([{ kind: "agent", status: "active" }])
    ).toBe(1);
    expect(
      countActiveAgents([
        { kind: "human", status: "active" },
        { kind: "agent", status: "active" },
        { kind: "agent", status: "suspended" },
      ])
    ).toBe(1);
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

  it("band sentences (issue #2817 / #2814 착수 전 확인 결과)", () => {
    expect(welcomeBandWorkingCopy("hermes")).toBe("hermes가 인사하러 오고 있어요.");
    expect(welcomeBandWorkingCopy("김인턴")).toBe("김인턴이 인사하러 오고 있어요.");
    expect(welcomeBandWorkingCopy(null)).toBe("에이전트가 인사하러 오고 있어요.");
    expect(WELCOME_BAND_SLEEPY_COPY).toBe("터미널에서 Claude Code를 열어 두면 인사해요.");
  });

  it("backstop sentence has no failure wording and names the agents nav", () => {
    expect(WELCOME_BACKSTOP_COPY).toBe(
      `아직 준비하고 있어요. 진행 상황은 ${AGENTS_NAV.label}에서 볼 수 있어요.`
    );
    expect(WELCOME_BACKSTOP_COPY).not.toMatch(/실패|오류|error|fail/i);
    expect(WELCOME_BACKSTOP_COPY.endsWith(".")).toBe(true);
    expect(WELCOME_BACKSTOP_LINK_LABEL).toBe(AGENTS_NAV.label);
    expect(WELCOME_BACKSTOP_HREF).toBe(AGENTS_NAV.to);
    expect(WELCOME_BACKSTOP_COPY.split(AGENTS_NAV.label).length - 1).toBe(1);
  });

  it("band state → expression is a row of the ADR-0193 D11 table (no seventh mapping)", () => {
    const rows = new Map(GUIDE_STATE_TABLE.map((row) => [row.expression, row.state]));
    for (const expression of Object.values(WELCOME_BAND_EXPRESSION)) {
      expect(rows.has(expression), expression).toBe(true);
    }
    expect(WELCOME_BAND_EXPRESSION.working).toBe("working");
    expect(WELCOME_BAND_EXPRESSION.sleepy).toBe("sleepy");
    expect(WELCOME_BAND_EXPRESSION.joy).toBe("happy");
  });

  it("decideWelcomeBand: phase × sleepy", () => {
    expect(decideWelcomeBand({ phase: "hidden", sleepy: false })).toBeNull();
    expect(decideWelcomeBand({ phase: "hidden", sleepy: true })).toBeNull();
    expect(decideWelcomeBand({ phase: "stage", sleepy: false })).toBe("working");
    expect(decideWelcomeBand({ phase: "stage", sleepy: true })).toBe("sleepy");
    expect(decideWelcomeBand({ phase: "backstop", sleepy: false })).toBe("backstop");
    expect(decideWelcomeBand({ phase: "backstop", sleepy: true })).toBe("sleepy");
    expect(decideWelcomeBand({ phase: "exiting", sleepy: false })).toBe("joy");
    expect(decideWelcomeBand({ phase: "exiting", sleepy: true })).toBe("joy");
  });

  it("2001 characters is a sentence rejection", () => {
    expect(welcomePromptTooLong("가".repeat(2000))).toBeNull();
    expect(welcomePromptTooLong("가".repeat(2001))).toBe(
      WELCOME_PROMPT_LIMIT_SENTENCE
    );
    expect(WELCOME_PROMPT_LIMIT_SENTENCE).toBe("2000자까지 쓸 수 있습니다.");
  });
});

function agent(over: Partial<RosterMember>): RosterMember {
  return {
    id: "00000000-0000-7000-8000-000000000201",
    workspaceId: WS,
    kind: "agent",
    status: "active",
    displayName: "hermes",
    handle: "hermes",
    channelCount: 1,
    channelIds: [],
    capabilities: [],
    createdAtMs: 1,
    updatedAtMs: 1,
    ...over,
  };
}

describe("welcomeBandSpeaker (who the band waits for)", () => {
  it("one awake active agent → its name, not sleepy", () => {
    expect(welcomeBandSpeaker([agent({ paused: false })], MEMBER)).toEqual({
      name: "hermes",
      sleepy: false,
    });
  });

  it("paused unknown (older server) reads as awake", () => {
    expect(welcomeBandSpeaker([agent({})], MEMBER)).toEqual({ name: "hermes", sleepy: false });
  });

  it("two awake agents → no single name", () => {
    expect(
      welcomeBandSpeaker(
        [agent({ paused: false }), agent({ id: "x", displayName: "김인턴", paused: false })],
        MEMBER
      )
    ).toEqual({ name: null, sleepy: false });
  });

  it("every active agent paused and one is mine → sleepy, named after mine", () => {
    expect(
      welcomeBandSpeaker(
        [
          agent({ displayName: "곽성재의 Claude", paused: true, ownerHumanId: MEMBER.toUpperCase() }),
          agent({ id: "y", displayName: "팀봇", paused: true, ownerHumanId: OTHER_MEMBER }),
        ],
        MEMBER
      )
    ).toEqual({ name: "곽성재의 Claude", sleepy: true });
  });

  it("an awake agent beats my paused one (someone can already speak)", () => {
    expect(
      welcomeBandSpeaker(
        [
          agent({ displayName: "곽성재의 Claude", paused: true, ownerHumanId: MEMBER }),
          agent({ id: "z", displayName: "김인턴", paused: false }),
        ],
        MEMBER
      )
    ).toEqual({ name: "김인턴", sleepy: false });
  });

  it("paused agents that are not mine → not sleepy (no Claude Code sentence for a team bot)", () => {
    expect(
      welcomeBandSpeaker([agent({ paused: true, ownerHumanId: OTHER_MEMBER })], MEMBER)
    ).toEqual({ name: null, sleepy: false });
  });

  it("invited / suspended agents and humans are not speakers", () => {
    expect(
      welcomeBandSpeaker(
        [
          agent({ status: "invited", paused: false }),
          agent({ id: "h", kind: "human", displayName: "사람" }),
        ],
        MEMBER
      )
    ).toEqual({ name: null, sleepy: false });
  });
});
