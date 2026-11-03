import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { uuidEq } from "@momo/core/lib/api";
import {
  carriesPlan,
  isLivePlanSession,
  pickPlanSession,
  planSessionsOf,
  workPlanProgress,
  workPlanSessionLabel,
  type WorkPlanProgress,
} from "@momo/core/features/work/workPlan";
import {
  eventFromFrame,
  eventsForSession,
  foldSessionEvents,
  type WorkSessionEvent,
} from "@momo/core/features/work/workSessionModel";
import { useSession } from "@/app/session";
import {
  invalidateSessionThreads,
  useSessionEvents,
  useWorkSessions,
} from "./useWorkSessions";

// =============================================================================
// 대화 머리의 계획 독이 읽는 것 (#4578). 규칙은 전부 코어 `workPlan`에 있고, 여기 있는 것은 **어디서 재료를
// 꺼내는가**뿐이다.
//
//   세션 목록   `["work-sessions", ws]` 쿼리 — 작업 세션 패널·관제 줄과 **같은 키**라 요청은 한 벌이다.
//   계획        그 세션의 스레드(`useSessionEvents`, 세션 상세와 같은 키) + 아래의 라이브 꼬리를 접은 값.
//
// ## 라이브 꼬리는 계획 프레임만 쌓는다
//
// 이 독은 작업 세션 패널이 닫혀 있어도 서야 하므로 패널의 `useWorkSessionRail`(최대 8채널·이벤트 400개 버퍼)을
// 빌릴 수 없고, 관제 줄처럼 20초 폴링만으로는 「2 of 4」가 한참 늦는다. 그래서 **열린 채널 하나**의 작업 프레임
// 구독에 핸들러를 더한다: `attach`가 메시지 레일과 같은 센트리퓨고 구독을 나눠 쓰므로(realtime.ts
// `subscribeWorkSession`) 새 구독이 열리지 않는다. 쌓는 것은 `agent.status`의 계획을 실은 프레임뿐이고(
// `carriesPlan`) 글 조각·도구 줄은 거른다. 끊겼다 이어지면(`onResync`) 꼬리를 버리고 Postgres를 다시 읽는다:
// 재생된 프레임은 구독이 이미 버렸고, 낡은 꼬리가 새 읽기 위에 남아 합계를 속이면 안 된다.
//
// 기본 대상은 이 채널에서 돌고 있는 세션, 없으면 마지막으로 돈 세션이다(코어 `planSessionsOf`).
//
// ## 서지 않는 때
//
// 세션이 없거나, 읽기가 아직 안 끝났거나, 실패했거나, 계획이 비면 `null`이다. 독은 자리표시자를 두지 않는다
// (「데이터가 있는 아이콘만 선다」): 읽지 못한 것을 「계획 없음」이라고 말하는 문장도 따로 만들지 않는다.
// 오프라인에서는 마지막으로 읽은 값이 그대로 남는다(React Query가 `data`를 지우지 않는다).
// =============================================================================

/** 이 관측자가 읽은 세션 스레드를 새것으로 치는 시간. 채널을 오갈 때마다 최대 5×200행을 다시 읽지 않는다. */
const PLAN_THREAD_STALE_MS = 60_000;

/** 라이브 꼬리 상한. 계획 프레임은 드물고, 깊은 기록은 이미 스레드 읽기에 있다. */
const LIVE_PLAN_CAP = 16;

export interface ChannelWorkPlan {
  progress: WorkPlanProgress;
  /** 고르는 목록(둘 이상이면 팝오버 머리에 선다). 순서는 코어가 정한 기본 순서다. */
  options: readonly { id: string; label: string }[];
  selectedId: string;
  select: (id: string) => void;
  /**
   * 세션 기록이 읽기 상한보다 길어 가장 새 계획을 못 읽었을 수 있고, 이 화면이 새 계획을 실시간으로도 받지
   * 못했다. 낡은 합계를 확정처럼 두지 않으려고 화면이 한 줄로 말한다.
   */
  maybeStale: boolean;
  /**
   * 방금 다른 세션을 골라 그 세션의 계획을 아직 읽는 중이다(#5166). `progress`·`maybeStale`은 **같은 대화에서 마지막으로
   * 읽은 값**이다: 독이 사라지면 열려 있던 팝오버가 함께 닫히므로, 읽는 동안 자리를 지킨다. 화면이 이 사실을 말한다.
   */
  switching: boolean;
}

/** 마지막으로 읽어 낸 계획. 대화(워크스페이스+채널)마다 따로 붙든다: 다른 대화의 계획을 물려주지 않는다. */
interface HeldPlan {
  conversationKey: string;
  progress: WorkPlanProgress;
  maybeStale: boolean;
}

export function useChannelWorkPlan(
  workspaceId: string,
  channelId: string
): ChannelWorkPlan | null {
  const { realtime } = useSession();
  const queryClient = useQueryClient();
  const active = workspaceId !== "" && channelId !== "";
  const sessionsQuery = useWorkSessions(workspaceId, undefined, active);

  const candidates = useMemo(
    () => planSessionsOf(sessionsQuery.data ?? [], channelId),
    [sessionsQuery.data, channelId]
  );
  const [pickedId, setPickedId] = useState<string | null>(null);
  const selected = pickPlanSession(candidates, pickedId);

  const [live, setLive] = useState<WorkSessionEvent[]>([]);

  useEffect(() => {
    if (!active || realtime === null) return;
    const sessionsKey = ["work-sessions", workspaceId];
    // 전이가 첫 목록 응답보다 먼저 올 수 있다: 진행 중인 읽기를 버리고 전이 뒤의 스냅샷을 한 번 읽는다.
    const refetchSessions = () => {
      void queryClient
        .cancelQueries({ queryKey: sessionsKey })
        .then(() => queryClient.invalidateQueries({ queryKey: sessionsKey }));
    };
    const dropLive = (sessionId: string) =>
      setLive((held) => {
        const kept = held.filter((event) => !uuidEq(event.sessionId, sessionId));
        return kept.length === held.length ? held : kept;
      });
    return realtime.subscribeWorkSession(workspaceId, channelId, {
      onLifecycle: (frame) => {
        // 끝난 세션의 꼬리는 스레드가 이미 갖고 있다. 스레드를 다시 읽어 마지막 계획을 확정한다.
        if (frame.type === "work.session.ended") {
          dropLive(frame.payload.session_id);
          void invalidateSessionThreads(queryClient);
        }
        refetchSessions();
      },
      onToolTransition: (frame) => {
        if (frame.type === "work.session.idle") {
          dropLive(frame.payload.session_id);
          void invalidateSessionThreads(queryClient);
        }
        refetchSessions();
      },
      onAcpEvent: (frame) => {
        const event = eventFromFrame(frame);
        if (!carriesPlan(event)) return;
        setLive((held) => {
          if (held.some((e) => uuidEq(e.eventId, event.eventId))) return held;
          const next = [...held, event];
          return next.length > LIVE_PLAN_CAP ? next.slice(next.length - LIVE_PLAN_CAP) : next;
        });
      },
      // 관찰자 수는 이 독의 재료가 아니다.
      onObserver: () => undefined,
      onResync: () => {
        setLive((held) => (held.length > 0 ? [] : held));
        void queryClient.invalidateQueries({ queryKey: sessionsKey });
        void invalidateSessionThreads(queryClient);
      },
    });
  }, [active, realtime, workspaceId, channelId, queryClient]);

  const liveForSelected = useMemo(
    () => (selected === null ? [] : eventsForSession(live, selected.id)),
    [live, selected]
  );
  const events = useSessionEvents(workspaceId, active ? selected : null, liveForSelected, {
    staleTimeMs: PLAN_THREAD_STALE_MS,
  });

  const select = useCallback((id: string) => setPickedId(id), []);
  const options = useMemo(
    () => candidates.map((session) => ({ id: session.id, label: workPlanSessionLabel(session) })),
    [candidates]
  );

  const progress = useMemo(
    () =>
      selected === null || events.data === undefined
        ? null
        : workPlanProgress(
            foldSessionEvents(events.events, selected, events.truncated).plan,
            isLivePlanSession(selected)
          ),
    [selected, events.data, events.events, events.truncated]
  );

  // 세션을 바꾸면 쿼리 키가 바뀌어 새 세션의 스레드 `data`가 잠깐 없다. 그 한 순간에 `null`을 돌려주면 독이 사라지고,
  // 팝오버(독 안의 상태)가 함께 닫힌다(#5166). 공용 쿼리(세션 상세와 같은 키)를 건드리지 않고 이 훅이 마지막 값을 붙든다.
  const heldPlan = useRef<HeldPlan | null>(null);
  if (!active || selected === null) return null;
  const conversationKey = `${workspaceId}|${channelId}`;
  if (progress !== null) {
    const maybeStale = events.truncated && liveForSelected.length === 0;
    heldPlan.current = { conversationKey, progress, maybeStale };
    return { progress, options, selectedId: selected.id, select, maybeStale, switching: false };
  }
  // 읽는 중일 때만 붙든다. 읽기가 실패했거나 계획이 비었으면 독은 서지 않는다(읽지 못한 것을 지어내지 않는다).
  if (events.data === undefined && !events.isError && heldPlan.current?.conversationKey === conversationKey) {
    return {
      progress: heldPlan.current.progress,
      options,
      selectedId: selected.id,
      select,
      maybeStale: heldPlan.current.maybeStale,
      switching: true,
    };
  }
  return null;
}
