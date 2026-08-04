import type {Channel, RosterMember, WorkSession} from '@momo/core/lib/api';
import {
  agentStateLabel,
  PROFILE_UNREAD,
  rosterPaused,
  runningSessionMeta,
  sessionsForAgent,
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
// 작업 세션과 「작업 중」은 여전히 다른 사실이다. 후자는 열린 실시간 턴이고
// `AgentWorkingRail`이 스토어에 넣는다(goal RN-T2); 이 파일이 세는 것은 원장의
// 세션이다. 화면은 둘을 나란히 그리되 섞지 않는다.
//
// ## 상태 한 줄은 이제 명부에서 온다 (goal RN-C1)
//
// 이 목록은 에이전트마다 `GET …/agents/{id}/profile`을 한 번씩 불러 pause 상태를
// 알아냈다. 그 요청은 owner/agent-owner 게이트라 **일반 멤버에게는 행마다 403**이
// 돌아왔고, 소유자에게조차 컬럼 하나를 그리려고 N번의 왕복이었다. goal SRV-R2가
// 같은 컬럼을 roster 프로젝션에 올렸으므로 목록은 아무것도 더 묻지 않는다 —
// `PROFILE_UNREAD`가 "이 표면은 애초에 묻지 않았다"는 뜻이고, 명부가 그 필드를
// 싣지 않는 구 서버에서만 상태를 볼 수 없음으로 떨어진다. 프로필 GET은 이제
// **편집 화면에 들어갈 때만** 일어난다.
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
  sessions,
}: {
  members: readonly RosterMember[];
  channels: readonly Channel[];
  dms: readonly Channel[];
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
    const placement = channelPlacement(member, channels, dms);
    const owned = sessions === undefined ? [] : sessionsForAgent(sessions, member.id);
    const partial = {
      memberId: member.id,
      displayName: member.displayName,
      handle: member.handle,
      // 명부 한 벌이 두 답을 다 준다 (goal SRV-R2). 이 표면은 프로필을 읽지
      // 않으므로 `PROFILE_UNREAD`를 넘기고, 명부가 `paused`를 싣지 않는 구
      // 서버에서만 상태를 볼 수 없음으로 떨어진다 — 모르는 것을 "활성"으로
      // 채우지 않는다.
      stateLabel: agentStateLabel(member, PROFILE_UNREAD),
      paused: rosterPaused(member),
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
