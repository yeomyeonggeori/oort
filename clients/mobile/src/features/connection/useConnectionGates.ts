import type {ConnectionPlainKey} from '@momo/core/features/connection/copyKeys';
import {useMemo} from 'react';
import {useOnline} from '../inbox/useOnline';
import {useConnection} from './ConnectionProvider';

// =============================================================================
// 지금 이 요청이 나갈 수 있는가 — 보내기·올리기·승인의 게이트 (#5222, #5201 결정 ③).
//
// 전송·올리기·승인은 REST 이고 소켓은 수신용이다. 막는 기준은 「이 요청이 나갈 수 있는가」다(감사 문서 §4-4): 기기 오프라인이거나
// 서버에 닿지 못함이 **확정**일 때만 막고, 실시간(소켓)만 끊기면 막지 않는다. 모르면 막지 않는다. 폰은 지금까지 NetInfo 하나만
// 읽었다(`useOnline.ts` 머리말) — 그 질문의 답을 코어 연결 상태 모델이 내리고, 이 훅이 화면에 건넨다.
//
// 막을 때 컴포저 위 한 줄은 **원인별**이다(오프라인 / 서버에 닿지 못함). 문장의 사전 키는 모델이 고르고, 화면이 읽는다.
//
// 연결 상태 모델이 없는 곳(격리 하네스·시험)은 이전과 같다: NetInfo 의 기기 온라인으로 셋 모두 답하고 원인 문장은 없다(null →
// 화면의 기존 문장).
// =============================================================================

export interface ConnectionGates {
  canSend: boolean;
  canUpload: boolean;
  canDecide: boolean;
  /** 보내기를 막았을 때 컴포저 위 한 줄의 사전 키. 막지 않았거나 모델이 없으면 null. */
  composerNote: ConnectionPlainKey | null;
  /** 승인을 막았을 때 단추 자리의 한 줄의 사전 키. 막지 않았거나 모델이 없으면 null. */
  approvalNote: ConnectionPlainKey | null;
}

export function useConnectionGates(): ConnectionGates {
  const connection = useConnection();
  // 훅 순서를 지키려고 모델이 있어도 부른다(NetInfo 구독은 `useOnline` 하나다).
  const online = useOnline();
  const view = connection?.view ?? null;
  return useMemo<ConnectionGates>(
    () =>
      view === null
        ? {
            canSend: online,
            canUpload: online,
            canDecide: online,
            composerNote: null,
            approvalNote: null,
          }
        : {
            canSend: view.canSend,
            canUpload: view.canUpload,
            canDecide: view.canDecide,
            composerNote: view.composerNote,
            approvalNote: view.approvalNote,
          },
    [view, online],
  );
}
