import type { Channel, Message, RosterMember } from "../../lib/api";
import type { Directory } from "../workspace/directory";
import { idKey } from "../workspace/directory";
import { mentionedAgents } from "../routing/mentionTargets";
import { attachParticle } from "../../lib/koreanParticle";

/** Server membership notices invalidate the conversation roster on both clients. */
export function dmMembershipRevision(
  messages: readonly Pick<Message, "id" | "type" | "props">[]
): string {
  return messages
    .filter(
      (message) =>
        message.type === "system" &&
        message.props?.kind === "dm_agent_membership"
    )
    .map((message) => message.id)
    .join(",");
}

/** Display eligibility. The server re-proves the full invocation policy. */
export function dmCallableAgent(agent: RosterMember, selfId: string): boolean {
  return (
    agent.kind === "agent" &&
    agent.status === "active" &&
    agent.paused !== true &&
    !agent.brainUnavailableReason &&
    (agent.callableBy !== "owner_only" ||
      idKey(agent.owner?.id ?? agent.ownerHumanId ?? "") === idKey(selfId))
  );
}

export function dmAdmissionCandidates(
  channel: Channel | null | undefined,
  members: RosterMember[],
  selfId: string
): RosterMember[] {
  if (channel?.kind !== "dm") return members;
  return members.filter(
    (member) => member.kind === "human" || dmCallableAgent(member, selfId)
  );
}

/** A pre-send explanation for the exact new agents named in this draft. */
export function dmAdmissionHint(
  text: string,
  channel: Channel | null | undefined,
  directory: Directory,
  selfId: string
): string | null {
  if (channel?.kind !== "dm") return null;
  const seated = new Set((channel.memberIds ?? []).map(idKey));
  const agents = mentionedAgents(text, directory.members).filter(
    (a) =>
      !seated.has(idKey(a.id)) &&
      dmCallableAgent(a, selfId) &&
      // Personal-agent calls keep their existing owner-signed path (ADR-0198).
      !("personalAgent" in a && a.personalAgent != null)
  );
  if (agents.length === 0) return null;
  const others = (channel.memberIds ?? [])
    .filter((id) => idKey(id) !== idKey(selfId))
    .map((id) => directory.byId.get(idKey(id)))
    .filter((m): m is RosterMember => m?.kind === "human");
  if (others.length === 0) return null;
  const consent =
    others.length === 1
      ? `${others[0].displayName}님이 허락하면`
      : "다른 사람이 모두 허락하면";
  return `${consent} ${attachParticle(
    agents.map((a) => a.displayName).join(", "),
    "subject"
  )} 이 대화에 들어와요. 이후 대화를 봐요.`;
}

export function removableDmAgents(
  channel: Channel | null | undefined,
  directory: Directory
): RosterMember[] {
  if (channel?.kind !== "dm" || !channel.dmKey?.startsWith("admitted:"))
    return [];
  return (channel.memberIds ?? [])
    .map((id) => directory.byId.get(idKey(id)))
    .filter((member): member is RosterMember => member?.kind === "agent");
}
