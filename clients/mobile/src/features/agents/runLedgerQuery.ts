import {fetchAgentRunEvents} from '@momo/core/lib/api';
import {serverSaysAbsent} from '@momo/core/features/capabilities/serverSurfaces';
import {useEffect, useRef} from 'react';
import {subscribeRunLedgerFrames} from './agentRunProgressStore';

// =============================================================================
// 서버 원장 읽기의 폰 접합 (#3824). 키는 웹과 **글자 그대로** 같다
// (`["agent-run-events", ws, run]`, `clients/web/src/features/agents/useRunLedger.ts`):
// 같은 run의 원장을 두 클라이언트가 다른 키로 들고 있을 이유는 없고, 한 기기 안에서는
// 메시지 아래 상태 줄과 기록 시트가 같은 캐시를 써서 같은 순간에 다른 단계를 말하지
// 않는다.
//
// 깨우는 신호 행(`doorbell`)과 oort가 잰 도구 호출(`tools`, #4654), 에이전트가 스스로 알린 활동·계획
// (`activity`, #4657)을 함께 묻는다 — 웹 `useRunLedger`와 **같은 질문**이다. 같은 키의 캐시를 메시지 아래 줄·
// 요청 생각 줄·기록 시트가 나눠 쓰므로 묻는 값이 다르면 먼저 읽은 쪽의 모양이 다른 쪽을 흔든다. 그 값을 모르는
// 옛 서버는 쿼리를 읽지 않고 예전 원장을 주거나(합계 필드가 없다 = 「모름」), 400이면 코어가 가장 새 값부터 한 칸씩
// 물러서 다시 읽는다(`fetchAgentRunEvents`).
// =============================================================================

/** 열린 run의 원장을 다시 읽는 간격. 웹과 같다(마지막 단계는 프레임 없이 끝날 수 있다). */
export const RUN_LEDGER_POLL_MS = 30_000;

export function runLedgerQueryOptions(workspaceId: string, runKey: string | null) {
  return {
    queryKey: ['agent-run-events', workspaceId, runKey] as const,
    queryFn: () =>
      fetchAgentRunEvents(workspaceId, runKey as string, {
        includeDoorbell: true,
        includeTools: true,
        includeActivity: true,
      }),
    staleTime: 0,
    retry: (count: number, error: unknown) =>
      !serverSaysAbsent(error) && count < 1,
  };
}

/** 이 run의 원장 프레임(깨우는 신호 포함)이 오면 다시 읽는다. */
export function useRunLedgerFrames(
  runKey: string | null,
  refetch: () => unknown,
): void {
  const latest = useRef(refetch);
  latest.current = refetch;
  useEffect(() => {
    if (runKey === null) {
      return undefined;
    }
    return subscribeRunLedgerFrames(runKey, () => void latest.current());
  }, [runKey]);
}
