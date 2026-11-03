import { COMPOSER_OFFLINE_COPY } from "@momo/core/features/chat/composerCopy";
import { APPROVAL_OFFLINE_COPY } from "@momo/core/features/timeline/approvalNote";
import { useConnection } from "@/features/common/connectionContext";
import { useFormatMessage } from "@/i18n/useFormatMessage";

// =============================================================================
// 막힌 자리의 한 줄이 무엇을 말하나 (#5239, #5201 S-B 후속).
//
// 쓰기를 **막을지**는 `useOffline()` 한 곳이 답한다(#5220). 막았을 때 **무슨 말을 하나**는 연결 상태 모델이 막은
// 원인에 따라 고른 사전 키가 답한다(`view.composerNote`·`view.approvalNote`): 기기 오프라인이면 「오프라인이라 …」,
// 서버에 닿지 못하면 「서버에 닿지 못해 …」. 서버에 닿지 못한 것을 「오프라인」이라고 말하면 사용자는 자기 와이파이를
// 의심한다.
//
// 모델이 막지 않는 원인(실시간만 끊김 · 알 수 없음)에는 문장이 없고 줄도 서지 않는다: 모르면 막지 않는다. 그래서
// 이 훅의 문장은 **막혔을 때만** 쓴다(호출부가 `useOffline()`이 참일 때 그린다).
//
// 막혔는데 모델에 문장이 없는 길은 로그인 만료뿐이다(앱이 곧 로그인 화면으로 돌아간다). 그때는 원인을 말하지 않는
// 옛 중립 문장으로 물러난다: 이유 없이 잠긴 입력창보다 낫고, 원인을 지어내지도 않는다. 코어 상수라 폰과 같은 문장이다.
// =============================================================================

/** 보내기를 막았을 때 입력창 위 한 줄(과 보내기·예약 단추의 설명)이 말하는 문장. */
export function useComposerBlockedLine(): string {
  const { view } = useConnection();
  const formatMessage = useFormatMessage();
  return view.composerNote === null ? COMPOSER_OFFLINE_COPY : formatMessage(view.composerNote);
}

/** 승인을 막았을 때 결정 단추 자리의 한 줄이 말하는 문장. */
export function useApprovalBlockedLine(): string {
  const { view } = useConnection();
  const formatMessage = useFormatMessage();
  return view.approvalNote === null ? APPROVAL_OFFLINE_COPY : formatMessage(view.approvalNote);
}
