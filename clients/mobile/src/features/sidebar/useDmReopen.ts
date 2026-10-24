import {ApiError, reopenDm, type ReadState} from '@momo/core/lib/api';
import {DM_REOPEN_FAILURE} from '@momo/core/features/channels/model';
import {useQueryClient} from '@tanstack/react-query';
import {useCallback, useEffect, useRef, useState} from 'react';
import {haptics} from '../../lib/haptics';
import {applyClosureToReadStates, workspaceKeys} from '../workspace/queries';
import type {DmClosedEntry} from './dmVerdicts';

// =============================================================================
// 「닫은 대화」 시트의 「다시 열기」 (ADR-0177 증보 D7·D8·D11, #4367). 웹 `reopenClosedDm` 의 폰판이다.
//
//   * 내가 닫은 대화(`closed`): 서버의 닫힘을 푼다(`DELETE …/closure`) - 투영 행의 `closedAtSeq` 가 숫자일 때만. 쓸 것이 없으면
//     왕복을 만들지 않는다. 풀린 뒤에 그 대화를 연다.
//   * 상대가 나간 대화(`gone`): 풀 닫힘이 없다(D8). 쓰는 것 없이 연다 - 열려 있는 동안만 목록에 서고 다 읽으면 다시 숨는다.
//
// 이 화면의 다른 행 동작처럼 **낙관 갱신이 없다**: 서버가 답한 뒤에 캐시를 건드리므로, 실패하면 시트가 그대로 서서 이유를 말한다.
// 서버가 「그 DM 이 없다」(404)고 답해도 열기는 막지 않는다(참여자가 아니거나 보관됨 - 열면 화면이 말한다).
// =============================================================================

export interface DmReopen {
  /** 왕복이 도는 대화(소문자 아님, 항목의 `channel.id`). */
  pendingId: string | null;
  error: string | null;
  reopen: (entry: DmClosedEntry) => void;
  clearError: () => void;
}

export function useDmReopen(
  workspaceId: string,
  byChannel: ReadonlyMap<string, ReadState>,
  /** 풀고 난 뒤 그 대화를 연다. 시트를 거두는 일도 부르는 쪽이 한다. */
  onOpened: (entry: DmClosedEntry) => void,
): DmReopen {
  const client = useQueryClient();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const byChannelRef = useRef(byChannel);
  byChannelRef.current = byChannel;
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const reopen = useCallback(
    (entry: DmClosedEntry) => {
      const id = entry.channel.id;
      if (entry.reason === 'gone') {
        onOpened(entry);
        return;
      }
      const row = byChannelRef.current.get(id.toLowerCase());
      if (row === undefined || typeof row.closedAtSeq !== 'number') {
        onOpened(entry);
        return;
      }
      setPendingId(id);
      setError(null);
      void reopenDm(workspaceId, id)
        .then(
          () => true,
          (cause: unknown) => cause instanceof ApiError && cause.status === 404,
        )
        .then(ok => {
          if (!mounted.current) return;
          setPendingId(null);
          if (!ok) {
            haptics.error();
            setError(DM_REOPEN_FAILURE);
            return;
          }
          applyClosureToReadStates(client, workspaceId, id, null);
          void client.invalidateQueries({queryKey: workspaceKeys.readState(workspaceId)});
          haptics.success();
          onOpened(entry);
        });
    },
    [client, onOpened, workspaceId],
  );

  const clearError = useCallback(() => setError(null), []);
  return {pendingId, error, reopen, clearError};
}
