import { ApiError } from "@momo/core/lib/api";
import { NetworkError } from "@momo/core/lib/http";
import { errorMessage } from "@momo/core/features/settings/model";

// =============================================================================
// Invite issue failure copy. Shared by settings › 멤버와 초대 and onboarding
// S2 so a 5xx without a body never paints "HTTP 503" as the sentence.
// =============================================================================

export const INVITE_ISSUE_ERROR =
  "초대 링크를 만들지 못했습니다. 설정 › 멤버와 초대에서 다시 시도하세요.";

const HTTP_STATUS = /^HTTP \d+$/;

export function inviteIssueErrorCopy(error: unknown): {
  message: string;
  detail: string | undefined;
} {
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
