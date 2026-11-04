import {useFormatMessage} from '../../i18n/useFormatMessage';
import {useConnection} from './ConnectionProvider';

// =============================================================================
// 승인을 막았을 때 결정 단추 자리의 한 줄이 무엇을 말하나 (#5262, #5201 결정 ③, 웹 `common/blockedLines.ts` 의 짝).
//
// 승인을 **막을지**는 `useConnectionGates().canDecide` 한 곳이 답한다(#5222). 막았을 때 **무슨 말을 하나**는 연결 상태 모델이 막은 원인에 따라 고른
// 사전 키(`view.approvalNote`)가 답한다: 기기 오프라인이면 「오프라인이라 …」, 서버에 닿지 못하면 「서버에 닿지 못해 …」. 서버에 닿지 못한 것을
// 「오프라인」이라고 말하면 사람은 자기 와이파이를 의심한다.
//
// 모델이 없는 곳(격리 하네스·시험)이나 모델이 문장을 주지 않는 길(로그인 만료 등)에서는 `undefined` 다. 부르는 쪽이 원인을 가리지 않는 기존
// 문장(코어 `APPROVAL_OFFLINE_COPY` 등)으로 물러난다 - 이유 없이 잠긴 카드보다 낫고, 원인을 지어내지도 않는다.
//
// `useConnectionGates()` 가 아니라 컨텍스트만 읽는다: 그 훅은 NetInfo 를 구독하는데(`useOnline`), 승인 카드는 목록 행마다 서므로 행마다 구독이
// 늘면 연결이 바뀔 때 모든 행이 따로 깨어난다. 카드가 막혔는지는 화면이 `approvalOffline` 으로 이미 정했고, 여기는 그 말만 고른다.
// =============================================================================

/** 승인을 막은 원인의 문장. 모델이 문장을 주지 않으면 `undefined`. */
export function useApprovalBlockedLine(): string | undefined {
  const connection = useConnection();
  const formatMessage = useFormatMessage();
  const key = connection?.view.approvalNote ?? null;
  return key === null ? undefined : formatMessage(key);
}
