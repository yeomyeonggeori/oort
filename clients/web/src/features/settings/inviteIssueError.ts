import { ApiError } from "@momo/core/lib/api";
import { NetworkError } from "@momo/core/lib/http";
import {
  errorMessage,
  GUEST_INVITES_PAUSED_CODE,
} from "@momo/core/features/settings/model";

// =============================================================================
// Invite issue failure copy. Shared by settings › 멤버와 초대 and onboarding
// S2 so a 5xx without a body never paints "HTTP 503" as the sentence.
//
// 게스트 초대가 멈춰 있을 때(ADR-0128 D1, ADR-0219 GS-0) 서버는 400과
// `guest_invites_paused`로 거절한다. 화면은 이제 게스트를 고르게 하지 않으므로 낡은
// 탭이나 다른 클라이언트에서만 닿는 길이지만, 닿으면 서버의 영어 문장이 아니라
// 사전 문구로 말한다. 사전 키는 호출한 화면이 `formatMessage`로 읽는다.
// =============================================================================

export const INVITE_ISSUE_ERROR =
  "초대 링크를 만들지 못했어요. 설정 › 멤버와 초대에서 다시 시도하세요.";

const HTTP_STATUS = /^HTTP \d+$/;

/** 문장이 사전에 있으면 `key`, 서버 문장이나 코어 문장이면 `message`가 찬다(둘 중 하나). */
export type InviteIssueErrorCopy =
  | { key: "settings.invite.guestInvitesPaused"; message?: undefined; detail?: undefined }
  | { message: string; detail: string | undefined; key?: undefined };

export function inviteIssueErrorCopy(error: unknown): InviteIssueErrorCopy {
  if (
    error instanceof ApiError &&
    error.status === 400 &&
    error.code === GUEST_INVITES_PAUSED_CODE
  ) {
    return { key: "settings.invite.guestInvitesPaused" };
  }
  if (error instanceof NetworkError) {
    return { message: errorMessage(error), detail: undefined };
  }
  const raw = errorMessage(error);
  if (HTTP_STATUS.test(raw)) {
    const detail =
      error instanceof ApiError ? `HTTP ${error.status}` : raw;
    return { message: INVITE_ISSUE_ERROR, detail };
  }
  return { message: raw, detail: undefined };
}
