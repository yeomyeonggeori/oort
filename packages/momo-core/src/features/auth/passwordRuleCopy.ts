// =============================================================================
// What the server's new-password rule (ADR-0215 D2, #4593) says to a person.
//
// One place on purpose. The claim screen (`claimModel.ts`) and the join screen
// (`connectModel.ts`) are refused by the same server function for the same
// reasons, so they read the same sentences. Two copies of a rule drift, and a
// person told the wrong thing fixes the wrong field.
//
// The numbers are the server's (`momo-auth` `password_rules.rs`:
// `NEW_PASSWORD_MIN_CHARS`, `NEW_PASSWORD_MAX_BYTES`). The tests pin the
// sentences as literals, so moving a number here without the server (or the
// server without here) goes red in one place.
// =============================================================================

/** Fewest characters a new password may have (input as typed). */
export const NEW_PASSWORD_MIN_CHARS = 10;

/** Most UTF-8 bytes a new password may have: what bcrypt actually hashes. */
export const NEW_PASSWORD_MAX_BYTES = 72;

/** UTF-8 bytes one Hangul syllable (NFC) takes. */
const HANGUL_SYLLABLE_BYTES = 3;

/** Hangul syllables that fit under the byte ceiling when nothing else is typed. */
export const NEW_PASSWORD_MAX_HANGUL =
  NEW_PASSWORD_MAX_BYTES / HANGUL_SYLLABLE_BYTES;

/** `error.code` of a new password under the minimum. */
export const PASSWORD_TOO_SHORT_CODE = "password_too_short";

/** `error.code` of a new password over the byte ceiling. */
export const PASSWORD_TOO_LONG_CODE = "password_too_long";

/**
 * The sentence for a 400 that names the rule a new password broke, or `null`
 * for a 400 that names none (an empty password, or one older than the named
 * rules) and for a code this screen does not know. The caller keeps its own
 * generic line for `null`: a code it does not know must not borrow another
 * rule's sentence.
 *
 * The ceiling is bytes, not characters, and a person types characters. So the
 * long sentence gives the exchange rate, which holds for any mix of scripts,
 * instead of two per-script limits that read as independent: twenty Hangul and
 * thirteen digits are inside both "24 Hangul" and "72 Latin" and still 73 bytes.
 * The register is the form's (합니다체); the rate is stated the way
 * `eventSubscriptions.ts` states its own byte ceiling.
 */
export function passwordRuleCopy(code: string | undefined): string | null {
  switch (code) {
    case PASSWORD_TOO_SHORT_CODE:
      return `비밀번호가 너무 짧습니다. ${NEW_PASSWORD_MIN_CHARS}자 이상으로 입력하세요.`;
    case PASSWORD_TOO_LONG_CODE:
      return `비밀번호가 너무 깁니다. ${NEW_PASSWORD_MAX_BYTES}바이트 이하로 입력하세요. 한 자에 영문·숫자·기호는 1바이트, 한글은 ${HANGUL_SYLLABLE_BYTES}바이트라서 한글만이면 ${NEW_PASSWORD_MAX_HANGUL}자까지입니다.`;
    default:
      return null;
  }
}
