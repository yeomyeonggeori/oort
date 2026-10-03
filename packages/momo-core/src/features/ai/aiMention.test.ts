import { describe, expect, it } from "vitest";
import type { RosterMember } from "../../lib/api";
import { CLAUDE_SUBSCRIPTION_AGENT_PAUSED } from "./aiHubModel";
import { composerAgentNotice, mentionAnnotation } from "./aiMention";

const VIEWER = "00000000-0000-7000-8000-00000000000a";
const OWNER = "00000000-0000-7000-8000-00000000000b";

function agent(over: Partial<RosterMember> & { handle: string }): RosterMember {
  return {
    id: `id-${over.handle}`,
    workspaceId: "w",
    kind: "agent",
    status: "active",
    displayName: over.displayName ?? over.handle,
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  };
}

const teamKey = agent({ handle: "intern", displayName: "김인턴", brain: "team_key", callableBy: "everyone" });
const mineSub = agent({
  handle: "mine",
  displayName: "내 Claude",
  brain: "subscription",
  callableBy: "owner_only",
  ownerHumanId: VIEWER,
  owner: { id: VIEWER, displayName: "하늘" },
  hostOnline: true,
});
const otherSub = agent({
  handle: "sj",
  displayName: "성재의 Claude Code",
  brain: "subscription",
  callableBy: "owner_only",
  ownerHumanId: OWNER,
  owner: { id: OWNER, displayName: "성재" },
  hostOnline: false,
});
const otherKey = agent({
  handle: "sjkey",
  displayName: "성재 키",
  brain: "personal_key",
  callableBy: "owner_only",
  ownerHumanId: OWNER,
  owner: { id: OWNER, displayName: "성재" },
});
const pausedMine = agent({
  handle: "pm",
  displayName: "내 Claude",
  brain: "subscription",
  callableBy: "owner_only",
  ownerHumanId: VIEWER,
  hostOnline: true,
  brainUnavailableReason: CLAUDE_SUBSCRIPTION_AGENT_PAUSED,
});

describe("mentionAnnotation", () => {
  it("writes the second line from the core labels, for each kind of agent", () => {
    expect(mentionAnnotation(teamKey, VIEWER)).toEqual({ line: "팀 키 · 누구나", badge: "팀 키", locked: false });
    expect(mentionAnnotation(mineSub, VIEWER)).toEqual({
      line: "내 구독 · 나만 부를 수 있어요",
      badge: "내 구독",
      locked: false,
    });
    expect(mentionAnnotation(otherSub, VIEWER)).toEqual({
      line: "성재 님 개인 구독 · 성재 님만 부를 수 있어요 · 맥 꺼짐",
      badge: "성재 님만",
      locked: true,
    });
    expect(mentionAnnotation(otherKey, VIEWER)?.locked).toBe(true);
    expect(mentionAnnotation(otherKey, VIEWER)?.line).toBe("개인 키 · 성재 님만");
    expect(mentionAnnotation(pausedMine, VIEWER)?.line).toBe("내 구독 · 나만 부를 수 있어요 · 문의 중");
  });

  it("draws nothing for a human, or for an agent the server did not describe", () => {
    expect(mentionAnnotation(agent({ handle: "h", kind: "human" }), VIEWER)).toBeNull();
    expect(mentionAnnotation(agent({ handle: "old" }), VIEWER)).toBeNull();
  });

  it("does not lock the owner out of their own agent when the viewer is unknown", () => {
    expect(mentionAnnotation(otherSub, null)?.locked).toBe(false);
  });
});

describe("composerAgentNotice", () => {
  it("names the owner when the viewer cannot call the agent", () => {
    expect(composerAgentNotice([otherSub], VIEWER)).toBe(
      "성재의 Claude Code는 성재 님만 부를 수 있어요. 보내도 답하지 않아요."
    );
    expect(composerAgentNotice([otherKey], VIEWER)).toContain("성재 님만 부를 수 있어요. 보내도 답하지 않아요.");
  });

  it("says nothing for agents the viewer can call", () => {
    expect(composerAgentNotice([teamKey, mineSub], VIEWER)).toBeNull();
    expect(composerAgentNotice([], VIEWER)).toBeNull();
    // 소유자를 알 수 없으면 비소유자 안내를 만들지 않는다(소유자 본인에게 거짓을 말하는 쪽이 더 나쁘다).
    expect(composerAgentNotice([otherSub], null)).toBeNull();
  });

  it("says why a Claude agent that is paused will not answer, even to its owner", () => {
    const line = composerAgentNotice([pausedMine], VIEWER);
    expect(line).toBe("내 Claude는 Claude 구독 대행이 Anthropic 약관 확인 전까지 쉬고 있어요. 보내도 답하지 않아요.");
    expect(line).not.toContain("팀 키로 대신");
  });

  it("counts the rest when several agents are called", () => {
    expect(composerAgentNotice([teamKey, otherSub, otherKey], VIEWER)).toBe(
      "성재의 Claude Code는 성재 님만 부를 수 있어요. 보내도 답하지 않아요. 외 1명도 답하지 않아요."
    );
  });
});
