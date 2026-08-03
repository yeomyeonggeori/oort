import type {Channel, RosterMember, WorkSession} from '@momo/core/lib/api';
import {
  agentStateLabel,
  isAgentPaused,
  runningSessionMeta,
  sessionsForAgent,
  type AgentProfileRead,
} from '@momo/core/features/agents/agentOps';
import {agentMembers} from '@momo/core/features/agents/hubModel';
import {channelPlacement} from '@momo/core/features/agents/channelPlacement';

// =============================================================================
// 「에이전트」 목록의 한 줄.
//
// Every judgement below is a call into `@momo/core/features/agents/*`. This file
// exists to COMPOSE them into the three things a row has to say — 깨어 있나,
// 무슨 세션을 갖고 있나, 어느 채널에 있나 — and to keep that composition out of a
// component where it could only be checked by screenshot.
//
// The web hub answers the same questions from the same functions, which is the
// point: two clients that call the same agent 활성 and 준비됨 have shipped a
// defect, not a variation.
//
// The third question is deliberately NOT "지금 일하는 중인가" (R1 High-2). That
// is the web's 작업 중, and it means an open realtime TURN, which this client
// cannot observe. What a row here reads is the work-session ledger, so it says
// 작업 세션 — see `runningSessionMeta` in the core for why the words diverge.
// =============================================================================

export interface AgentRow {
  key: string;
  memberId: string;
  displayName: string;
  handle: string;
  /** 활성 · 일시정지 · 사용 중지 · 상태 확인 중 · 상태 확인 실패 · 상태를 볼 수 없음 */
  stateLabel: string;
  /** True only when the profile was actually read and says so. */
  paused: boolean | null;
  /**
   * Work sessions this agent owns that the LEDGER still calls running. Not "is
   * this agent working": see the header note.
   */
  runningCount: number;
  /** Every session this agent owns, running or finished. */
  sessionCount: number;
  /** Named channels this agent is in, in the caller's own sidebar order. */
  channelNames: string[];
  /**
   * Memberships this client cannot name — channels the caller does not see, and
   * the agent's DMs. Counted rather than invented (`channelPlacement`).
   */
  unresolvedChannels: number;
  /** The whole row as one sentence, for VoiceOver. */
  accessibilityLabel: string;
}

/**
 * The second line of a row, assembled from what is actually known.
 *
 * Absent facts are DROPPED rather than rendered as a placeholder: a row that
 * reads "작업 0개 · 채널 0개" for an agent whose profile has not loaded yet is
 * three lies in one line. What survives is only what a request already proved.
 */
function metaParts(row: Omit<AgentRow, 'accessibilityLabel' | 'key'>): string[] {
  const parts = [row.stateLabel];
  if (row.runningCount > 0) parts.push(runningSessionMeta(row.runningCount));
  if (row.channelNames.length > 0) {
    parts.push(row.channelNames.map(name => `#${name}`).join(' '));
  }
  if (row.unresolvedChannels > 0) {
    parts.push(`그 밖에 ${row.unresolvedChannels}곳`);
  }
  return parts;
}

export function agentRowMeta(row: AgentRow): string {
  return metaParts(row).join(' · ');
}

export function buildAgentRows({
  members,
  channels,
  dms,
  profiles,
  sessions,
}: {
  members: readonly RosterMember[];
  channels: readonly Channel[];
  dms: readonly Channel[];
  profiles: ReadonlyMap<string, AgentProfileRead>;
  /**
   * The workspace ledger, or undefined when it has not been read. Undefined is
   * NOT an empty ledger: a row must not claim an agent has done nothing because
   * the request has not landed.
   */
  sessions: readonly WorkSession[] | undefined;
}): AgentRow[] {
  // `agentMembers` is the web hub's own filter and sort (kind === "agent",
  // then localeCompare in ko). Rewriting it here is how two lists start
  // disagreeing about which rows exist.
  return agentMembers(members).map(member => {
    const read: AgentProfileRead = profiles.get(member.id.toLowerCase()) ?? {
      kind: 'pending',
    };
    const placement = channelPlacement(member, channels, dms);
    const owned = sessions === undefined ? [] : sessionsForAgent(sessions, member.id);
    const partial = {
      memberId: member.id,
      displayName: member.displayName,
      handle: member.handle,
      stateLabel: agentStateLabel(member, read),
      paused: isAgentPaused(read),
      runningCount: owned.filter(session => session.status === 'running').length,
      sessionCount: owned.length,
      channelNames: placement.present
        .map(channel => channel.name)
        .filter((name): name is string => name !== undefined),
      unresolvedChannels: placement.unresolved,
    };
    return {
      key: `agent:${member.id}`,
      ...partial,
      // The handle is spoken because two agents can share a display name — the
      // same reason the sidebar disambiguates (`directory.ts`).
      accessibilityLabel: [
        `에이전트 ${partial.displayName}`,
        `@${partial.handle}`,
        ...metaParts(partial),
      ].join(', '),
    };
  });
}
