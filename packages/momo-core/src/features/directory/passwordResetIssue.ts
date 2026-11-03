import { ApiError } from "../../lib/api";
import { NetworkError } from "../../lib/http";
import type { MessageKey } from "../../i18n/generated/messages";

// =============================================================================
// What a refused 「재설정 링크 만들기」 says to the administrator (ADR-0215 D6, #4603).
//
// The sentences are in the dictionary (`recovery.issue.error*`); this file only decides which one a
// refusal reads and where it stands. Two refusals are the password re-check and are told apart by
// `error.code`, never by the bare status or the English message (the message may be reworded, the code
// may not):
//   400 `current_password_required`   the field was empty
//   403 `current_password_incorrect`  the administrator's own password was wrong
// A 403 without that code is the ladder (the target is above this administrator, or is oneself) and must
// not tell the person their password was wrong.
// =============================================================================

/** 400: `currentPassword` missing or blank (E-4 #4596). */
export const CURRENT_PASSWORD_REQUIRED_CODE = "current_password_required";

/** 403: the administrator's own password did not match (E-4 #4596). */
export const CURRENT_PASSWORD_INCORRECT_CODE = "current_password_incorrect";

export type PasswordResetIssueErrorKey = Extract<MessageKey, `recovery.issue.error${string}`>;

export interface PasswordResetIssueFailure {
  key: PasswordResetIssueErrorKey;
  /** Whole seconds, only on `recovery.issue.errorRateLimitedAfter`. */
  seconds?: number;
  /** The refusal is about the password field: it stands under that field and keeps focus there. */
  atPasswordField: boolean;
  /**
   * The server judged the typed password, so it is not kept: the field is emptied and the next try
   * starts clean. A refusal that says nothing about the password keeps what was typed.
   */
  clearPassword: boolean;
}

function banner(key: PasswordResetIssueErrorKey, seconds?: number): PasswordResetIssueFailure {
  return {
    key,
    ...(seconds === undefined ? {} : { seconds }),
    atPasswordField: false,
    clearPassword: false,
  };
}

/** The empty field, said before any request leaves (the server says the same with its 400). */
export function passwordResetIssueRequired(): PasswordResetIssueFailure {
  return { key: "recovery.issue.errorRequired", atPasswordField: true, clearPassword: false };
}

export function passwordResetIssueFailure(error: unknown): PasswordResetIssueFailure {
  if (error instanceof NetworkError) return banner("recovery.issue.errorNetwork");
  if (!(error instanceof ApiError)) return banner("recovery.issue.errorGeneric");
  if (error.status === 400) {
    if (error.code === CURRENT_PASSWORD_REQUIRED_CODE) return passwordResetIssueRequired();
    return banner("recovery.issue.errorBadTarget");
  }
  if (error.status === 403) {
    if (error.code === CURRENT_PASSWORD_INCORRECT_CODE) {
      return { key: "recovery.issue.errorWrongPassword", atPasswordField: true, clearPassword: true };
    }
    return banner("recovery.issue.errorForbidden");
  }
  if (error.status === 404) return banner("recovery.issue.errorNotFound");
  if (error.status === 409) return banner("recovery.issue.errorInactive");
  if (error.status === 429) {
    const seconds = error.retryAfterSeconds;
    return seconds !== undefined && Number.isInteger(seconds) && seconds >= 1
      ? banner("recovery.issue.errorRateLimitedAfter", seconds)
      : banner("recovery.issue.errorRateLimited");
  }
  return banner("recovery.issue.errorGeneric");
}

/**
 * The refusal as one sentence. The dictionary is the caller's (`formatMessage` of the installed locale),
 * so a language switch re-reads it.
 */
export function passwordResetIssueMessage(
  failure: PasswordResetIssueFailure,
  formatMessage: {
    (key: Exclude<PasswordResetIssueErrorKey, "recovery.issue.errorRateLimitedAfter">): string;
    (key: "recovery.issue.errorRateLimitedAfter", args: { seconds: number }): string;
  }
): string {
  if (failure.key === "recovery.issue.errorRateLimitedAfter") {
    return formatMessage(failure.key, { seconds: failure.seconds ?? 1 });
  }
  return formatMessage(failure.key);
}
