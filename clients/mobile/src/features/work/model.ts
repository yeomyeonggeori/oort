import {
  uuidEq,
  type Channel,
  type WorkHost,
  type WorkSession,
} from '@momo/core/lib/api';
import {sortSessions} from '@momo/core/features/work/workSessionModel';
import {clockLabel} from '@momo/core/features/work/workSessionFormat';
import {workExecutionLocation} from '@momo/core/features/work/workLocation';
import {
  channelLabel,
  memberNameParts,
  type Directory,
} from '@momo/core/features/workspace/directory';

/** The server applies the same ceiling. Keeping it here makes the UI contract explicit. */
export const WORK_CONSOLE_LIMIT = 200;

export type WorkConsoleFilter = 'all' | 'active';

/** `active=1` on the server means exactly these two ledger states. */
export function isActiveWorkSession(session: WorkSession): boolean {
  return session.status === 'running' || session.status === 'idle';
}

/** Running-first core order, then the optional server-compatible active filter. */
export function workConsoleSessions(
  sessions: readonly WorkSession[],
  filter: WorkConsoleFilter,
): WorkSession[] {
  const visible =
    filter === 'active' ? sessions.filter(isActiveWorkSession) : sessions;
  return sortSessions(visible).slice(0, WORK_CONSOLE_LIMIT);
}

const EXPLICIT_TIME = new Intl.DateTimeFormat('ko-KR', {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** A wall-clock fact, never an elapsed value that keeps a hidden list ticking. */
export function explicitTimeLabel(atMs: number): string {
  return EXPLICIT_TIME.format(new Date(atMs));
}

/** Match the shared work-console contract: ended rows show their end fact. */
export function workSessionRecentTimeLabel(session: WorkSession): string {
  if (session.status !== 'ended') {
    return `시작 ${clockLabel(session.startedAtMs)}`;
  }
  return session.endedAtMs === undefined
    ? '종료 시각 확인 필요'
    : `종료 ${clockLabel(session.endedAtMs)}`;
}

export interface WorkSessionPresentation {
  label: string;
  tool: string;
  channelName: string;
  ownerName: string;
  hostName: string;
  hostState: string;
  location: ReturnType<typeof workExecutionLocation>;
}

/**
 * Resolve every name through the same directory/registry reads as the rest of
 * the phone. Missing joins stay explicit instead of leaking UUIDs into UI.
 */
export function workSessionPresentation(
  session: WorkSession,
  hosts: readonly WorkHost[] | undefined,
  channels: readonly Channel[],
  directory: Directory,
  selfMemberId: string,
): WorkSessionPresentation {
  const location = workExecutionLocation(session, hosts);
  const channel = channels.find(candidate => uuidEq(candidate.id, session.channelId));
  const owner = memberNameParts(directory, session.memberId, '담당자 확인 필요');
  return {
    label: session.label.trim() || '이름 없는 작업',
    tool: session.tool.trim() || '도구 확인 필요',
    channelName:
      channel === undefined
        ? '대화 확인 필요'
        : channelLabel(channel, directory, selfMemberId),
    ownerName: owner.handle ? `${owner.name} ${owner.handle}` : owner.name,
    hostName:
      location.host?.displayName.trim() ||
      (location.host === null ? '호스트 확인 필요' : '이름 없는 호스트'),
    hostState:
      location.host === null
        ? '상태 확인 필요'
        : location.host.online
          ? '온라인'
          : '오프라인',
    location,
  };
}
