import type { useFormatMessage } from "@/i18n/useFormatMessage";
import { deviceOnlineNow } from "@/lib/deviceOnline";
import { CONNECTION_KEYS, type ConnectionPlainKey } from "@momo/core/features/connection/copyKeys";
import { causeOfFailure, causeOfUnknownFailure } from "@momo/core/features/connection/failure";
import { copyForCause, type ConnectionCause } from "@momo/core/features/connection/model";

// =============================================================================
// 남은 「불러오지 못했습니다」 자리들이 함께 쓰는 순수 도우미 (#5242, #5221 후속). 컴포넌트는 `LoadFailureBox.tsx`에 있다.
// =============================================================================

/**
 * 이 자리의 오류 객체 하나가 말하는 원인. 렌더 때 기기 온라인 여부를 읽는다(S-C 상자 자리들과 같다).
 * 오류 객체를 **모르는** 자리(훅이 `isError`만 내놓거나 원천이 여럿이라 하나로 말할 수 없다)는 `null`을 넘기고, 그때는 기기가 아는
 * 사실 하나만 안다: 꺼져 있으면 오프라인, 아니면 원인 없음(이유는 「문제가 생겼어요」). 오류 객체가 있는데 연결 쪽 원인이 아니면
 * 기기 상태와 무관하게 원인 없음이다.
 */
export function loadCauseOf(error: unknown): ConnectionCause | null {
  if (error === null || error === undefined) return causeOfUnknownFailure(deviceOnlineNow());
  return causeOfFailure(error, deviceOnlineNow());
}

type FormatMessage = ReturnType<typeof useFormatMessage>;

/**
 * 이 원인의 이유 문장 키. 곁에 「다시 시도」 단추가 서 있으면(`withAction`) 다음 행동을 뺀 문장이다 — 단추와 문장이 같은 말을 되풀이하지 않는다(#5307 L2).
 * 단추가 없는 자리는 문장이 다음 행동까지 말한다.
 */
export function loadReasonKeyOf(cause: ConnectionCause | null, withAction: boolean): ConnectionPlainKey {
  const copy = copyForCause(cause);
  return withAction ? copy.loadReasonBare : copy.loadReason;
}

/**
 * 이미 만들어 둔 제목 문장(값이 든 키를 `formatMessage(key, values)`로 푼 것)에 이유를 붙여 한 문장 묶음으로(`"{title}. {reason}"`의 언어별 틀).
 * `withAction`은 곁에 「다시 시도」 단추가 서 있는가: 있으면 이유가 다음 행동을 되풀이하지 않는다(#5307 L2).
 */
export function loadFailureSentenceOf(
  formatMessage: FormatMessage,
  title: string,
  cause: ConnectionCause | null,
  withAction = true
): string {
  return formatMessage(CONNECTION_KEYS.loadSentence, {
    title,
    reason: formatMessage(loadReasonKeyOf(cause, withAction)),
  });
}

/**
 * 제목 + 이유를 한 문장 묶음으로(`"{title}. {reason}"`의 언어별 틀). 문자열만 받는 자리(설명·aria)에도 쓴다. `withAction`은 곁에 「다시 시도」 단추가
 * 서 있는가(기본 있음): 있으면 이유가 다음 행동을 되풀이하지 않는다.
 */
export function loadFailureSentence(
  formatMessage: FormatMessage,
  titleKey: ConnectionPlainKey,
  cause: ConnectionCause | null,
  withAction = true
): string {
  return loadFailureSentenceOf(formatMessage, formatMessage(titleKey), cause, withAction);
}
