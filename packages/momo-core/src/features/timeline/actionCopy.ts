import { ApiError } from "../../lib/api";

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
// =============================================================================

function statusOf(error: unknown): number {
  return error instanceof ApiError ? error.status : 0;
}

/** The line every unmapped failure shares — never a raw status or wire text. */
const GENERIC = "요청을 끝내지 못했습니다. 잠시 뒤에 다시 시도하세요.";

export function editFailureMessage(error: unknown): string {
  switch (statusOf(error)) {
    case 400:
      // Two 400s reach here: an empty body, and an edit of a message someone
      // already deleted. The empty body is caught before the request, so the
      // one a person actually sees is the tombstone.
      return "이미 삭제된 메시지는 고칠 수 없습니다.";
    case 403:
      return "내가 보낸 메시지만 고칠 수 있습니다.";
    case 404:
      return "메시지를 찾지 못했습니다. 이미 지워졌을 수 있습니다.";
    default:
      return "메시지를 고치지 못했습니다. 잠시 뒤에 다시 시도하세요.";
  }
}

export function deleteFailureMessage(error: unknown): string {
  switch (statusOf(error)) {
    case 403:
      return "내가 보낸 메시지만 지울 수 있습니다.";
    case 404:
      // The delete is idempotent server-side, so a 404 means the row is gone
      // entirely rather than already tombstoned — nothing left to do.
      return "메시지를 찾지 못했습니다. 이미 지워졌을 수 있습니다.";
    default:
      return "메시지를 지우지 못했습니다. 잠시 뒤에 다시 시도하세요.";
  }
}

export function reactionFailureMessage(error: unknown): string {
  switch (statusOf(error)) {
    case 400:
      return "삭제된 메시지에는 반응을 남길 수 없습니다.";
    case 403:
      return "이 채널의 멤버만 반응할 수 있습니다.";
    case 404:
      return "메시지를 찾지 못했습니다. 이미 지워졌을 수 있습니다.";
    case 409:
      // The per-message cap. Naming the number is what makes this actionable —
      // "한도" alone reads as a bug rather than a rule.
      return "이 메시지에 달린 반응이 200개를 넘었습니다. 기존 반응을 하나 지운 뒤 다시 눌러 보세요.";
    default:
      return "반응을 남기지 못했습니다. 잠시 뒤에 다시 시도하세요.";
  }
}

export function replyFailureMessage(error: unknown): string {
  switch (statusOf(error)) {
    case 400:
      return "이 메시지에는 답글을 달 수 없습니다. 원본이 삭제됐거나 이미 답글입니다.";
    case 403:
      return "이 채널의 멤버만 답글을 달 수 있습니다.";
    case 404:
      return "원본 메시지를 찾지 못했습니다. 이미 지워졌을 수 있습니다.";
    default:
      return "답글을 보내지 못했습니다. 잠시 뒤에 다시 시도하세요.";
  }
}

/** The shared fallback, exported so a caller can reuse it verbatim. */
export const genericActionFailureMessage = GENERIC;
