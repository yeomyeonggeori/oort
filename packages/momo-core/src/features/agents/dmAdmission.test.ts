import { describe, expect, it } from "vitest";
import type { Channel, RosterMember } from "../../lib/api";
import {
  makeDirectory,
  dmPeer,
  dmAutoReplyAgent,
  channelLabelParts,
} from "../workspace/directory";
import { parseApprovalAction } from "../timeline/agentCardModel";
import { approvalCardNote } from "../timeline/approvalNote";
import {
  dmAdmissionCandidates,
  dmAdmissionHint,
  removableDmAgents,
} from "./dmAdmission";

const member = (
  id: string,
  kind: "human" | "agent",
  extra: Partial<RosterMember> = {}
): RosterMember => ({
  id,
  workspaceId: "ws",
  kind,
  displayName: id,
  handle: id,
  status: "active",
  channelIds: [],
  channelCount: 0,
  capabilities: [],
  createdAtMs: 0,
  updatedAtMs: 0,
  ...extra,
});
const self = member("me", "human"),
  peer = member("Peer", "human"),
  agent = member("grok", "agent");
const channel: Channel = {
  id: "dm",
  workspaceId: "ws",
  kind: "dm",
  muted: false,
  memberIds: [self.id, peer.id],
};
const directory = makeDirectory([self, peer, agent]);

describe("consented agent DM", () => {
  it("explains the other person's consent and ongoing reading before sending", () => {
    expect(dmAdmissionHint("@grok help", channel, directory, self.id)).toBe(
      "Peer님이 허락하면 grok이 이 대화에 들어와요. 이후 대화를 봐요."
    );
    expect(
      dmAdmissionHint(
        "ordinary human conversation",
        channel,
        directory,
        self.id
      )
    ).toBeNull();
  });
  it("never offers another person's owner-only, paused or unavailable agent as an admission candidate", () => {
    const candidates = [
      agent,
      member("private", "agent", {
        callableBy: "owner_only",
        ownerHumanId: "someone",
      }),
      member("asleep", "agent", { paused: true }),
      member("gone", "agent", { status: "suspended" }),
    ];
    expect(dmAdmissionCandidates(channel, candidates, self.id)).toEqual([
      agent,
    ]);
    expect(
      dmAdmissionCandidates({ ...channel, kind: "public" }, candidates, self.id)
    ).toBe(candidates);
  });
  it("keeps personal-agent calls on the existing owner-signed path", () => {
    const local = {
      ...agent,
      personalAgent: { ownerId: self.id, harness: "codex" },
    };
    expect(
      dmAdmissionHint(
        "@grok help",
        channel,
        makeDirectory([self, peer, local]),
        self.id
      )
    ).toBeNull();
  });
  it("stops promising an admission after the agent is seated", () => {
    expect(
      dmAdmissionHint(
        "@grok help",
        { ...channel, memberIds: [...channel.memberIds!, agent.id] },
        directory,
        self.id
      )
    ).toBeNull();
  });
  it("a group has a member summary and no arbitrary peer or implicit reply target", () => {
    const group = { ...channel, memberIds: [...channel.memberIds!, agent.id] };
    expect(dmPeer(group, directory, self.id)).toBeNull();
    expect(dmAutoReplyAgent(group, directory, self.id)).toBeNull();
    expect(channelLabelParts(group, directory, self.id)).toMatchObject({
      kind: "group",
      text: "Peer, grok · 3명",
      isAgent: false,
    });
    expect(
      dmAutoReplyAgent(
        { ...channel, memberIds: [self.id, agent.id] },
        directory,
        self.id
      )
    ).toBe(agent);
  });
  it("only the consented conversation exposes agent removal", () => {
    const group = { ...channel, memberIds: [...channel.memberIds!, agent.id] };
    expect(removableDmAgents(group, directory)).toEqual([]);
    expect(
      removableDmAgents({ ...group, dmKey: "admitted:dm" }, directory)
    ).toEqual([agent]);
  });
  it("keeps the server-pinned human on the reusable action card", () => {
    expect(
      parseApprovalAction({
        id: "dm.agent.admit",
        rows: [],
        required_role: "dm_participant",
        target_member_id: peer.id,
      })
    ).toMatchObject({
      targetMemberId: peer.id,
      requiredRole: "dm_participant",
    });
  });
  it("a participant waiting on someone else's card sees guidance instead of decision controls", () => {
    expect(
      approvalCardNote({
        settled: false,
        hasTarget: true,
        pendingHere: true,
        waitingForParticipant: true,
        offline: false,
        approvalsProvided: true,
      })
    ).toMatchObject({ kind: "participant", tone: "guidance" });
    expect(
      approvalCardNote({
        settled: true,
        hasTarget: true,
        pendingHere: false,
        waitingForParticipant: true,
        offline: false,
        approvalsProvided: true,
      })
    ).toBeNull();
  });
});
