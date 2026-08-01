import { ApiError, type Channel, type RosterMember } from "@/lib/api";
import { NetworkError } from "@/lib/http";
import { attachParticle } from "@/lib/koreanParticle";
import { normalizedId } from "./model";

// =============================================================================
// 채널 배치 model (goal B5.3b, D-4). Which channels an agent is in, which ones
// it could be put into, and what a refusal from the membership endpoints means.
//
// The membership an agent has IS its reachability: an agent that belongs to no
// channel is in the roster, is mentionable in autocomplete, and answers nothing,
// because `POST …/agents` deliberately stops at the identity boundary and
// records `channel_memberships_created: 0`. This surface is the second half of
// that decision, and the pair (create → place) is the onboarding the hub exists
// to make possible.
//
// Two facts about the data this reads, stated rather than smoothed over:
//
//   1. `RosterMember.channelIds` is EVERY channel the member is in, DMs
//      included, and it is not filtered to what the caller can see (the roster
//      only narrows it for guests). So the agent can legitimately carry ids this
//      client cannot name. Those are counted, not invented: `unresolved` is how
//      many, and the surface says so instead of quietly showing a shorter list.
//   2. The membership endpoints refuse DMs (`c.kind IN ('public','private')`),
//      so a DM never appears as a place to add or remove. A DM with an agent is
//      opened from the directory, and closing it is not a membership edit.
// =============================================================================

export interface ChannelPlacement {
  /** Named channels the agent is in, in the caller's own sidebar order. */
  present: Channel[];
  /** Channels the caller can see that the agent is not in yet. */
  available: Channel[];
  /**
   * Memberships this client cannot name: channels the agent is in that the
   * caller does not see, plus its DMs. Reported as a number because that is
   * exactly what is known about them.
   */
  unresolved: number;
}

/**
 * Split the caller's channel list around one agent's memberships.
 *
 * `channels` is the caller's non-DM list, `dms` is only used to recognise an id
 * as a DM so it is not double counted as "somewhere I cannot see".
 */
export function channelPlacement(
  agent: RosterMember,
  channels: readonly Channel[],
  dms: readonly Channel[] = []
): ChannelPlacement {
  const member = new Set(agent.channelIds.map(normalizedId));
  const present: Channel[] = [];
  const available: Channel[] = [];
  for (const channel of channels) {
    if (member.has(normalizedId(channel.id))) present.push(channel);
    else available.push(channel);
  }
  const named = new Set(
    [...channels, ...dms].map((channel) => normalizedId(channel.id))
  );
  let unresolved = 0;
  for (const id of member) {
    if (!named.has(id)) unresolved += 1;
  }
  return { present, available, unresolved };
}

export type PlacementAction = "add" | "remove";

/**
 * A refused placement, as a sentence the reader can act on.
 *
 * The 404 branch carries the weight here. This surface consumes the membership
 * pair that goal B5.3a opens, so on a server that has not landed it yet EVERY
 * press answers 404, and "다시 시도하세요" would be an instruction into a loop
 * that cannot end. The client cannot tell that 404 apart from "the channel is
 * gone" by status alone, so it says both things and names the one it can check.
 */
export function placementFailure(
  action: PlacementAction,
  error: unknown
): string {
  const verb = action === "add" ? "채널에 추가하지" : "채널에서 내보내지";
  if (error instanceof ApiError) {
    if (error.status === 404 || error.status === 405) {
      return `${verb} 못했습니다. 이 서버가 채널 멤버 편집을 아직 지원하지 않거나, 그 채널이 사라졌습니다.`;
    }
    if (error.status === 403) {
      return `${verb} 못했습니다. 채널 멤버를 바꾸려면 워크스페이스 관리자여야 합니다.`;
    }
    if (error.status === 429) {
      return `${verb} 못했습니다. 요청이 너무 잦습니다. 잠시 뒤에 다시 시도하세요.`;
    }
    if (error.status >= 500) {
      return `${verb} 못했습니다. 서버가 오류로 답했습니다.`;
    }
    return `${verb} 못했습니다. 잠시 뒤에 다시 시도하세요.`;
  }
  if (error instanceof NetworkError) {
    return `${verb} 못했습니다. ${error.message}`;
  }
  return `${verb} 못했습니다. 잠시 뒤에 다시 시도하세요.`;
}

/**
 * The receipt for a placement that worked. Named because "저장됨" says nothing
 * about what changed, and this row is the one place the reader learns that
 * mention routing just became possible for that agent in that channel.
 */
export function placementReceipt(
  action: PlacementAction,
  agentName: string,
  channelName: string
): string {
  const subject = attachParticle(agentName, "object");
  return action === "add"
    ? `${subject} #${channelName}에 추가했습니다. 이제 그 채널에서 멘션할 수 있습니다.`
    : `${subject} #${channelName}에서 내보냈습니다. 그 채널의 멘션은 더 이상 전달되지 않습니다.`;
}
