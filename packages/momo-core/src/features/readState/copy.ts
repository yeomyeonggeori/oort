import { ApiError } from "../../lib/api";
import type { PlainMessageKey } from "../../i18n/keys";

// 문구는 `i18n/catalogs/<언어>/readState.json`에 있다. 여기는 어느 자리가 어느 키를 읽는지만 정하고, 문장은 화면이
// 그릴 때 지금 언어로 푼다(`formatMessage(key)`).

/** 메시지 ⋯ / 우클릭 / 시트의 항목 이름. ADR-0178 D5. */
export const MARK_UNREAD_ACTION_KEY = "readState.markUnread.action" satisfies PlainMessageKey;

/** 행 polite live region. 성공은 토스트가 아니다. */
export const MARK_UNREAD_SUCCESS_KEY = "readState.markUnread.done" satisfies PlainMessageKey;

function statusOf(error: unknown): number {
  return error instanceof ApiError ? error.status : 0;
}

/**
 * 마크 설정이 거절됐을 때 행 아래 배너의 키. 토스트가 아니다.
 * 400 = 그 seq 가 채널에 없다. 403 = 멤버가 아니다.
 */
export function markUnreadFailureKey(error: unknown): PlainMessageKey {
  switch (statusOf(error)) {
    case 400:
      return "readState.markUnread.messageGone";
    case 403:
      return "readState.markUnread.notMember";
    default:
      return "readState.markUnread.failed";
  }
}
