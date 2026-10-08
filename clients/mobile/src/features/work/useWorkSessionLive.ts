import {uuidEq, type WorkSession} from '@momo/core/lib/api';
import {
  eventFromFrame,
  type WorkSessionEvent,
} from '@momo/core/features/work/workSessionModel';
import {useQueryClient} from '@tanstack/react-query';
import {useCallback, useEffect, useRef, useState} from 'react';
import {useRealtime} from '../../realtime/RealtimeProvider';
import {agentKeys} from '../agents/queries';
import {workSessionEventsKey, type SessionEventPage} from './queries';

// =============================================================================
// 작업 상세의 라이브 꼬리 (N2 #3594, 시나리오 A).
//
// 실시간은 **꼬리**이고 읽기가 진실이다. 열려 있는 동안 도착한 ACP 프레임을 이 세션 것만
// 버퍼에 쌓아 두고, 화면은 `mergeEvents(읽은 것, 꼬리)`로 접는다(코어 `foldSessionEvents`가
// 연속된 `agent.partial`을 한 말풍선 줄로 합치므로 글자는 같은 줄에서 자란다 - 줄이 새로
// 생기거나 다시 마운트되지 않는다). 웹 `useWorkSessionRail`의 한 세션짜리 짝이다.
//
// 듣는 조건 = `active`(이 화면이 맨 위 층) && `subscriptionsWanted`(백그라운드 정책이
// 소켓을 원함) && 아직 끝나지 않은 세션. 가려진 화면과 백그라운드에서는 구독하지 않으므로
// 아무것도 읽지 않고, 돌아오면 재구독이 `onResync`로 읽기를 한 번 부른다.
//
// 햅틱은 없다. 햅틱은 사용자가 만든 순간에 한 번이고 실시간 수신에서는 부르지 않는다
// (`lib/haptics.ts` 계약 2). 이 파일은 haptics를 import하지 않고 시험이 그것을 잠근다.
// =============================================================================

/** 이 상한을 넘으면 오래된 쪽부터 버린다(읽기에 이미 있다). */
export const LIVE_EVENT_CAP = 400;
export const LIVE_EVENT_KEEP = 300;

export function useWorkSessionLive(
  workspaceId: string,
  session: WorkSession | null,
  active: boolean,
): {liveEvents: WorkSessionEvent[]; listening: boolean} {
  const {rail, subscriptionsWanted} = useRealtime();
  const queryClient = useQueryClient();
  const [liveEvents, setLiveEvents] = useState<WorkSessionEvent[]>([]);
  const liveRef = useRef<WorkSessionEvent[]>([]);
  const seenRef = useRef<Set<string>>(new Set());

  const sessionId = session?.id ?? null;
  const channelId = session?.channelId ?? null;
  const rootId = session?.rootMessageId ?? null;
  const ended = session === null || session.status === 'ended';
  const listening =
    active &&
    subscriptionsWanted &&
    rail !== null &&
    workspaceId !== '' &&
    sessionId !== null &&
    channelId !== null &&
    !ended;

  const publish = useCallback((next: WorkSessionEvent[]) => {
    liveRef.current = next;
    seenRef.current = new Set(next.map(event => event.eventId.toLowerCase()));
    setLiveEvents(next);
  }, []);

  // 다른 세션으로 바뀌면 꼬리를 비운다(이전 세션 프레임이 남지 않게).
  useEffect(() => {
    if (liveRef.current.length > 0) publish([]);
  }, [sessionId, publish]);

  useEffect(() => {
    if (!listening || rail === null || sessionId === null || channelId === null) {
      return;
    }
    const eventsKey = workSessionEventsKey(workspaceId, channelId, rootId ?? '');
    let disposed = false;

    // 읽기를 다시 하고, **끝난 뒤에** 읽기가 이미 담은 조각만 꼬리에서 뺀다. 먼저 비우면
    // 읽기가 돌아올 때까지 글자가 사라졌다 나타나 레이아웃이 튄다(웹 G-H1의 짝).
    const heal = () => {
      void queryClient
        .invalidateQueries({queryKey: eventsKey})
        .then(() => {
          if (disposed) return;
          const durable = queryClient.getQueryData<SessionEventPage>(eventsKey);
          if (durable === undefined) return;
          const have = new Set(
            durable.events.map(event => event.eventId.toLowerCase()),
          );
          const kept = liveRef.current.filter(
            event => !have.has(event.eventId.toLowerCase()),
          );
          if (kept.length !== liveRef.current.length) publish(kept);
        });
      void queryClient.invalidateQueries({
        queryKey: agentKeys.workSessions(workspaceId),
      });
    };

    const stop = rail.subscribeWorkSession(workspaceId, channelId, {
      onAcpEvent: frame => {
        if (!uuidEq(frame.payload.work_session_id, sessionId)) return;
        const event = eventFromFrame(frame);
        const folded = event.eventId.toLowerCase();
        if (seenRef.current.has(folded)) return;
        const next = [...liveRef.current, event];
        if (next.length > LIVE_EVENT_CAP) {
          publish(next.slice(next.length - LIVE_EVENT_KEEP));
          return;
        }
        liveRef.current = next;
        seenRef.current.add(folded);
        setLiveEvents(next);
      },
      onLifecycle: frame => {
        if (frame.type === 'work.session.ended') {
          if (uuidEq(frame.payload.session_id, sessionId)) heal();
          return;
        }
        // started: 다른 세션의 시작은 이 화면과 무관하다.
      },
      onToolTransition: frame => {
        if (
          frame.type === 'work.session.idle' &&
          uuidEq(frame.payload.session_id, sessionId)
        ) {
          heal();
        }
      },
      // 이 화면은 관전자 수·조작 창을 그리지 않는다.
      onObserver: () => {},
      onResync: heal,
    });
    return () => {
      disposed = true;
      stop();
    };
  }, [listening, rail, workspaceId, sessionId, channelId, rootId, queryClient, publish]);

  return {liveEvents, listening};
}
