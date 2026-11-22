import { ApiError, ClaimApiError, type ClaimKind } from "../../lib/api";
import { NetworkError } from "../../lib/http";
import type { MessageKey } from "../../i18n/generated/messages";
import type { FailureMessage } from "./failureMessage";
import { passwordRuleCopy } from "./passwordRuleCopy";

/** `error.code` of a new password that holds a NUL character (ADR-0215 D2). */
export const PASSWORD_INVALID_CHAR_CODE = "password_invalid_char";

/**
 * The dictionary sentences a claim refusal can name instead of its legacy `message`. Only the ones that
 * take no argument: a refusal is read as one sentence with nothing to fill in.
 */
export type ClaimMessageKey = Extract<
  MessageKey,
  "recovery.claim.resetExpired" | "recovery.claim.resetUsed" | "recovery.claim.invalidChar"
>;

export interface ClaimFailure {
  /** 사전의 문장(`auth.*`) 또는 전송 오류가 들고 온 글. 화면이 `failureMessageText`로 푼다. */
  message: FailureMessage;
  /**
   * The dictionary sentence for this refusal, when there is one (ADR-0215 D6 kind-specific copy, #4601).
   * A screen that reads the dictionary shows this and not `message`; `message` stays the sentence for
   * a reader that does not, and is the same one the refusal had before the kind was known.
   */
  messageKey?: ClaimMessageKey;
  /**
   * The refusal is about the new-password field (a 400 that names a password rule). The screen marks that
   * field invalid and ties the sentence to it, and drops the sentence once the person edits the field.
   * A 429 or a dead network keeps the form but says nothing about the password, so it has no `field`.
   */
  field?: "password";
  /** Used or already-passworded: the next step is the sign-in form. */
  suggestSignIn: boolean;
  retryable: boolean;
  /** Keep the password fields. False when the token itself cannot be consumed. */
  keepForm: boolean;
}

function transportFailure(cause: unknown): ClaimFailure | null {
  if (cause instanceof NetworkError) {
    return {
      message: { raw: cause.message },
      suggestSignIn: false,
      retryable: true,
      keepForm: true,
    };
  }
  if (cause instanceof ApiError) return null;
  return {
    message: { key: "auth.failure.unreadableResponse" },
    suggestSignIn: false,
    retryable: true,
    keepForm: true,
  };
}

/**
 * The refusal is about the new-password field (a 400 that names a password rule). The screen marks that
 * field invalid, ties the sentence to it and drops the sentence once the person edits the field. A
 * predicate rather than a field name the screen compares: the name is this file's, not the screen's.
 */
export function claimRefusesPassword(failure: ClaimFailure | null): boolean {
  return failure?.field === "password";
}

/**
 * Which kind of link was refused, when the server said. Only a 409 or 410 carries it (`ClaimApiError`);
 * everything else is unknown, and unknown keeps the sentence the screen had before kinds existed.
 */
function refusedKind(failure: ApiError): ClaimKind | undefined {
  return failure instanceof ClaimApiError ? failure.claimKind : undefined;
}

/**
 * Claim-token failures to distinct copy. Status is the split (404 invalid,
 * 410 expired, 409 used); for a 409 or 410 the kind of link (`claimKind`, ADR-0215 D6) splits it again:
 * an operator-issued reset link asks for a new link from an admin, a first-owner link from whoever ran
 * the install. Unrecognised messages fall back to per-status copy,
 * never a raw English string in front of the user.
 */
export function claimFailureCopy(cause: unknown): ClaimFailure {
  const transport = transportFailure(cause);
  if (transport) return transport;
  const failure = cause as ApiError;
  switch (failure.status) {
    case 404:
      return {
        message: { key: "auth.claim.invalidLink" },
        suggestSignIn: false,
        retryable: false,
        keepForm: false,
      };
    case 410:
      return {
        message: { key: "auth.claim.expired" },
        ...(refusedKind(failure) === "password_reset"
          ? { messageKey: "recovery.claim.resetExpired" as const }
          : {}),
        suggestSignIn: false,
        retryable: false,
        keepForm: false,
      };
    case 409:
      return {
        message: { key: "auth.claim.used" },
        ...(refusedKind(failure) === "password_reset"
          ? { messageKey: "recovery.claim.resetUsed" as const }
          : {}),
        suggestSignIn: true,
        retryable: false,
        keepForm: false,
      };
    case 400:
      // ADR-0215 D2 (#4593): the server names which rule a new password broke
      // (`error.code`; the English message may be reworded, the code may not).
      // A 400 that names no rule, or one this screen does not know, keeps the
      // generic line.
      return {
        message: passwordRuleCopy(failure.code) ?? { key: "auth.claim.passwordRecheck" },
        // A NUL character cannot be typed, so this is rare; it still gets its own sentence (#4601 hand-down
        // from E-1). A code this screen does not know keeps only the generic line above.
        ...(failure.code === PASSWORD_INVALID_CHAR_CODE
          ? { messageKey: "recovery.claim.invalidChar" as const }
          : {}),
        field: "password",
        suggestSignIn: false,
        retryable: false,
        keepForm: true,
      };
    case 429:
      return {
        message: { key: "auth.failure.tooManyRequests" },
        suggestSignIn: false,
        retryable: false,
        keepForm: true,
      };
    default:
      return {
        message:
          failure.status >= 500
            ? { key: "auth.failure.serverError" }
            : { key: "auth.claim.unmapped" },
        suggestSignIn: false,
        retryable: failure.status >= 500,
        keepForm: true,
      };
  }
}
