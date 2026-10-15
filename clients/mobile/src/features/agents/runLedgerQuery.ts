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
// 깨우는 신호 행을 함께 묻는다(`?include=doorbell`). 그 행을 모르는 옛 서버는 쿼리를
// 읽지 않고 예전 원장을 준다.
// =============================================================================

/** 열린 run의 원장을 다시 읽는 간격. 웹과 같다(마지막 단계는 프레임 없이 끝날 수 있다). */
export const RUN_LEDGER_POLL_MS = 30_000;

export function runLedgerQueryOptions(workspaceId: string, runKey: string | null) {
  return {
    queryKey: ['agent-run-events', workspaceId, runKey] as const,
    queryFn: () =>
      fetchAgentRunEvents(workspaceId, runKey as string, {includeDoorbell: true}),
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
