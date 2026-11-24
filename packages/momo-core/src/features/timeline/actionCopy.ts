import { ApiError } from "../../lib/api";
import type { PlainMessageKey } from "../../i18n/keys";

// =============================================================================
// Message-action failure copy (B11), following the B8 rule: the server's wire
// sentence never reaches the screen.
//
// The message routes answer in operator English — "only the message author may
// edit", "message reaction limit reached", "not a member of this channel". That
// is the right thing to log and the wrong thing to put under someone's message.
// Each status a click can actually provoke gets a sentence that says what
// happened AND what to do next; anything unmapped falls back to the generic
// line rather than leaking the wire string.
//
// Pure and exported so the tests assert the mapping without mounting anything.
// 문장은 `i18n/catalogs/<언어>/timeline.json`(`timeline.actionFailure.*`)에 있고, 여기는 상태 → 키만 정한다(#6044).
// =============================================================================

function statusOf(error: unknown): number {
  return error instanceof ApiError ? error.status : 0;
}

/** The line every unmapped failure shares — never a raw status or wire text. */
const GENERIC = "timeline.actionFailure.generic" satisfies PlainMessageKey;

export function editFailureKey(error: unknown): PlainMessageKey {
  switch (statusOf(error)) {
    case 400:
      // Two 400s reach here: an empty body, and an edit of a message someone
      // already deleted. The empty body is caught before the request, so the
      // one a person actually sees is the tombstone.
      return "timeline.actionFailure.editDeleted";
    case 403:
      return "timeline.actionFailure.editNotAuthor";
    case 404:
      return "timeline.actionFailure.messageNotFound";
    default:
      return "timeline.actionFailure.editFailed";
  }
}

export function deleteFailureKey(error: unknown): PlainMessageKey {
  switch (statusOf(error)) {
    case 403:
      return "timeline.actionFailure.deleteNotAuthor";
    case 404:
      // The delete is idempotent server-side, so a 404 means the row is gone
      // entirely rather than already tombstoned — nothing left to do.
      return "timeline.actionFailure.messageNotFound";
    default:
      return "timeline.actionFailure.deleteFailed";
  }
}

export function reactionFailureKey(error: unknown): PlainMessageKey {
  switch (statusOf(error)) {
    case 400:
      return "timeline.actionFailure.reactDeleted";
    case 403:
      return "timeline.actionFailure.reactNotMember";
    case 404:
      return "timeline.actionFailure.messageNotFound";
    case 409:
      // The per-message cap. Naming the number is what makes this actionable —
      // "한도" alone reads as a bug rather than a rule.
      return "timeline.actionFailure.reactLimit";
    default:
      return "timeline.actionFailure.reactFailed";
  }
}

/**
 * 이슈 #1112. The 409 is the interesting one: unlike the reaction cap, which a
 * person can clear on the message in front of them, the pin cap is a **channel**
 * fact — the thing to unpin is somewhere else. So the sentence sends them to the
 * list rather than telling them to undo something here.
 */
export function pinFailureKey(error: unknown): PlainMessageKey {
  switch (statusOf(error)) {
    case 400:
      return "timeline.actionFailure.pinDeleted";
    case 403:
      return "timeline.actionFailure.pinNotMember";
    case 404:
      return "timeline.actionFailure.messageNotFound";
    case 409:
      return "timeline.actionFailure.pinLimit";
    default:
      return "timeline.actionFailure.pinFailed";
  }
}

export function replyFailureKey(error: unknown): PlainMessageKey {
  switch (statusOf(error)) {
    case 400:
      return "timeline.actionFailure.replyNotAllowed";
    case 403:
      return "timeline.actionFailure.replyNotMember";
    case 404:
      return "timeline.actionFailure.replyOriginalNotFound";
    default:
      return "timeline.actionFailure.replyFailed";
  }
}

/** The shared fallback key, exported so a caller can reuse it verbatim. */
export const GENERIC_ACTION_FAILURE_KEY = GENERIC;
