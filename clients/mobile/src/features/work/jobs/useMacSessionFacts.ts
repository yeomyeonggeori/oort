import {uuidEq, type SharedWorkSession, type WorkSession} from '@momo/core/lib/api';
import {
  isAgentLane,
  isFinishedState,
  isRunItem,
} from '@momo/core/features/workbench/teamBoard';
import {pendingPermission} from '@momo/core/features/workbench/agentPane';
import {eventsForSession} from '@momo/core/features/work/workSessionModel';
import {useQueries} from '@tanstack/react-query';
import {useMemo} from 'react';

import {useWorkHosts, useWorkSessions} from '../../agents/queries';
import {workSessionEventsQuery} from '../queries';
import {BOARD_POLL_MS} from '../teamBoard/useTeamBoard';

// =============================================================================
// 작업 목록 줄의 맥 사실 둘 (#5593, ADR-0188 D5).
//
//   맥 점          그 세션을 돌리는 맥이 지금 켜져 있는가. 보드 줄에는 호스트 id 가 없다(서버 `work_board`가
//                  일부러 싣지 않는다) — 세션 원장(`GET …/work-sessions`)의 `hostId` 를 호스트 목록에 맞춘다.
//   내 확인 필요   **내** 맥 세션이 권한 요청에 답을 기다리는가. 보드는 호스트 세션의 상태를 원장 값(실행 중·대기)으로만
//                  내므로, 그 세션의 진행을 읽어 열린 요청을 찾는다(`pendingPermission`, 웹 칸 머리의 「응답 필요」와 같은
//                  판정). 남의 세션은 읽지 않는다: 요청은 주인에게만 보이고 주인만 답한다(D3·D5).
//
// 진행 읽기는 세션 화면과 같은 열쇠다(`workSessionEventsQuery`): 줄을 눌러 들어가면 카드가 이미 따뜻하다. 끝나지 않은
// 내 맥 세션만 읽는다 — 보통 한두 개다. 목록이 떠 있는 동안 보드와 같은 박자(`BOARD_POLL_MS`)로 다시 읽는다. 요청이
// 오는 그 순간은 알림(권한 요청 푸시)이 알린다. 이 줄은 목록을 연 사람이 놓친 것을 맨 위에 올려 두는 일이다.
// =============================================================================

export interface MacOfRow {
  /** 맥(호스트)의 이름. 사람이 붙인 이름이라 일반 글자로만 그린다. */
  name: string;
  online: boolean;
}

export interface MacSessionFacts {
  /** 보드 줄 id → 그 세션의 맥. 실행 줄이거나 원장·호스트 목록에서 못 찾으면 null(점을 그리지 않는다). */
  macOf: (rowId: string) => MacOfRow | null;
  /** 보드 줄 id → 내 맥 세션이 권한 요청에 답을 기다리는가. */
  needsMyCheck: (rowId: string) => boolean;
}

/** 내가 연 맥 세션(호스트 세션) 줄인가. 실행 줄·남의 세션·맥에서 직접 연 창(로컬 공유)은 아니다. */
export function isMyMacSessionRow(item: SharedWorkSession, selfMemberId: string): boolean {
  // 에이전트 레인(`isAgentLane`)은 호스트 세션과 실행 줄이다 — 실행 줄을 빼면 호스트 세션이 남는다.
  return !isRunItem(item) && isAgentLane(item) && uuidEq(item.owner.memberId, selfMemberId);
}

/**
 * 진행을 읽어 볼 줄: 끝나지 않은 내 맥 세션. 끝난 줄(보드 상태)은 읽지 않는다 — 끝난 세션의 요청은 이미 취소됐다(D5).
 * 원장의 상태가 실행 중·대기가 아니면 `pendingPermission` 이 스스로 없다고 답한다.
 */
function watchedSession(
  item: SharedWorkSession,
  ledger: ReadonlyMap<string, WorkSession>,
  selfMemberId: string,
): WorkSession | null {
  if (!isMyMacSessionRow(item, selfMemberId) || isFinishedState(item.state)) return null;
  const session = ledger.get(item.sessionId.toLowerCase());
  if (session === undefined || session.rootMessageId === undefined) return null;
  return uuidEq(session.memberId, selfMemberId) ? session : null;
}

export function useMacSessionFacts(
  workspaceId: string,
  selfMemberId: string,
  items: readonly SharedWorkSession[],
  active: boolean,
): MacSessionFacts {
  const sessionsQuery = useWorkSessions(workspaceId, active);
  const hostsQuery = useWorkHosts(workspaceId, active);
  const sessions = sessionsQuery.data;
  const hosts = hostsQuery.data;

  const ledger = useMemo(() => {
    const byId = new Map<string, WorkSession>();
    for (const session of sessions ?? []) byId.set(session.id.toLowerCase(), session);
    return byId;
  }, [sessions]);

  const watched = useMemo(
    () =>
      items
        .map(item => watchedSession(item, ledger, selfMemberId))
        .filter((session): session is WorkSession => session !== null),
    [items, ledger, selfMemberId],
  );

  const reads = useQueries({
    queries: watched.map(session => ({
      ...workSessionEventsQuery(workspaceId, session),
      enabled: active,
      refetchInterval: active ? BOARD_POLL_MS : (false as const),
    })),
  });

  const waiting = useMemo(() => {
    const ids = new Set<string>();
    watched.forEach((session, index) => {
      const page = reads[index]?.data;
      if (page === undefined) return;
      if (pendingPermission(eventsForSession(page.events, session.id), session) !== null) {
        ids.add(session.id.toLowerCase());
      }
    });
    return ids;
  }, [watched, reads]);

  return useMemo<MacSessionFacts>(
    () => ({
      macOf: rowId => {
        const session = ledger.get(rowId.toLowerCase());
        if (session === undefined) return null;
        const host = hosts?.find(candidate => uuidEq(candidate.id, session.hostId));
        if (host === undefined) return null;
        return {
          name: host.displayName.trim(),
          online:
            host.online === true &&
            (host.revokedAtMs === undefined || host.revokedAtMs === null),
        };
      },
      needsMyCheck: rowId => waiting.has(rowId.toLowerCase()),
    }),
    [ledger, hosts, waiting],
  );
}
