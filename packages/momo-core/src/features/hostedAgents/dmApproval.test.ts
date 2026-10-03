import { describe, expect, it } from "vitest";
import {
  applyHostedDmApproval,
  dmComposerHint,
  dmDeliveryAnswers,
  parseAgentDmDelivery,
  parseHostedDmApprovals,
  parseHostedDmApprovalWrite,
  type AgentDmDeliveryState,
} from "./dmApproval";

const names = { agentSubject: "Claude Code가", agentName: "Claude Code", ownerName: "성재" };

describe("DM composer hint (#2891)", () => {
  it("promises a reply only where the server says the DM is delivered", () => {
    const all: AgentDmDeliveryState[] = [
      "not_hosted",
      "open",
      "awaiting_owner",
      "owner_only",
      "not_approvable",
      "connection_unavailable",
      "delivery_disabled",
      "subscription_disabled",
      "claude_subscription_agent_paused",
    ];
    for (const state of all) {
      const hint = dmComposerHint(state, names);
      expect(hint.includes("바로 말하면"), `${state}: ${hint}`).toBe(dmDeliveryAnswers(state));
      expect(hint).not.toMatch(/[—–]/);
    }
    expect(dmComposerHint("open", names)).toBe("멘션 없이 바로 말하면 Claude Code가 답합니다");
    expect(dmComposerHint("awaiting_owner", names)).toBe(
      "성재님이 이 대화를 열어야 Claude Code가 답합니다"
    );
    expect(dmComposerHint("awaiting_owner", { ...names, ownerName: null })).toBe(
      "소유자가 이 대화를 열어야 Claude Code가 답합니다"
    );
    expect(dmComposerHint("owner_only", names)).toBe(
      "성재님의 개인 에이전트라 이 대화에는 답하지 않습니다"
    );
  });

  it("reads an unknown state as no promise", () => {
    expect(parseAgentDmDelivery({ state: "open", agentMemberId: "a" })?.state).toBe("open");
    expect(parseAgentDmDelivery({ state: "maybe", agentMemberId: "a" })?.state).toBeNull();
    expect(parseAgentDmDelivery({ state: null })?.state).toBeNull();
    expect(parseAgentDmDelivery("x")).toBeNull();
  });
});

describe("DM approval list (#2915)", () => {
  const wire = {
    connectionId: "c",
    agentMemberId: "a",
    ownerMemberId: "o",
    canEdit: true,
    ownerOnly: false,
    dms: [
      { channelId: "d1", counterpartMemberId: "o", state: "owner" },
      { channelId: "d2", counterpartMemberId: "m", state: "unapproved" },
      { channelId: "d3", counterpartMemberId: "n", state: "wide_open" },
    ],
  };

  it("drops rows whose state this build does not know", () => {
    const parsed = parseHostedDmApprovals(wire);
    expect(parsed?.dms.map((dm) => dm.channelId)).toEqual(["d1", "d2"]);
    expect(parsed?.canEdit).toBe(true);
    expect(parseHostedDmApprovals({ ...wire, canEdit: "yes" })?.canEdit).toBe(false);
  });

  it("applies a write to its own row only", () => {
    const parsed = parseHostedDmApprovals(wire)!;
    const row = parseHostedDmApprovalWrite({
      dm: { channelId: "d2", counterpartMemberId: "m", state: "approved" },
    })!;
    const next = applyHostedDmApproval(parsed, row);
    expect(next.dms.map((dm) => dm.state)).toEqual(["owner", "approved"]);
  });
});
