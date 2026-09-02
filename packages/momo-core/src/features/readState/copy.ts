import { ApiError } from "../../lib/api";

/** 메시지 ⋯ / 우클릭 / 시트. ADR-0178 D5. */
export const MARK_UNREAD_ACTION_LABEL = "여기부터 안 읽음";

function statusOf(error: unknown): number {
  return error instanceof ApiError ? error.status : 0;
}

/**
 * 마크 설정이 거절됐을 때 행 아래 배너. 토스트가 아니다.
 * 400 = 그 seq 가 채널에 없다. 403 = 멤버가 아니다.
 */
export function markUnreadFailureMessage(error: unknown): string {
  switch (statusOf(error)) {
    case 400:
      return "이 메시지부터 안 읽음으로 표시하지 못했습니다. 같은 항목을 다시 눌러 보세요.";
    case 403:
      return "이 채널의 멤버만 안 읽음으로 표시할 수 있습니다.";
    default:
      return "안 읽음으로 표시하지 못했습니다. 잠시 뒤에 다시 시도하세요.";
  }
}
