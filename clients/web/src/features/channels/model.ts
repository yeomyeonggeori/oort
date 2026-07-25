import { ApiError, type MembershipRole } from "@/lib/api";
import { NetworkError } from "@/lib/http";

// =============================================================================
// 채널 만들기 model (AX-1a / MOMO-614). Everything the dialog decides without
// React lives here, so the rules are under test rather than inside a component.
//
// The name rule is not invented: it is `ChannelRoutes.normalizedChannelName`,
// character for character, and the mac sheet
// (MomoChannelCreationSheet.MomoChannelCreationValidation) already carries the
// same one. A client that accepts what the server rejects turns a typo into an
// English 400 the reader cannot act on, and a client that rejects what the
// server accepts makes a legal name look broken. Both are the same bug.
// =============================================================================

export const CHANNEL_NAME_MAX = 80;
export const CHANNEL_TOPIC_MAX = 280;

/** Server regex, verbatim: a name is ascii, and it never starts or ends on a
 *  separator. Anchored on both sides, so a Korean name fails here rather than
 *  at the server. */
const NAME_RE = /^[a-z0-9][a-z0-9_-]*[a-z0-9]$|^[a-z0-9]$/;

/** The alphabet by itself, without the rule about where a name may begin. */
const NAME_ALPHABET_RE = /^[a-z0-9_-]+$/;

export type ChannelNameIssue =
  | "required"
  | "tooLong"
  | "unsupportedCharacters"
  | "edgeSeparator";
export type ChannelTopicIssue = "tooLong";

/** What the server stores: trimmed and lowercased. */
export function normalizeChannelName(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Topic keeps its case; only the edges go. Empty means "no topic". */
export function normalizeChannelTopic(raw: string): string {
  return raw.trim();
}

export function channelNameIssue(raw: string): ChannelNameIssue | null {
  const name = normalizeChannelName(raw);
  if (name === "") return "required";
  // Length before shape, same order as the server: "80자를 넘었다"는 말이
  // "쓸 수 없는 글자가 있다"보다 고치기 쉬운 안내다.
  if (name.length > CHANNEL_NAME_MAX) return "tooLong";
  if (NAME_RE.test(name)) return null;
  // The server's regex refuses two different things and one message for both
  // told `-release` to use only the characters it had already used. Which half
  // of the rule was broken decides which sentence the reader gets.
  return NAME_ALPHABET_RE.test(name) ? "edgeSeparator" : "unsupportedCharacters";
}

export function channelTopicIssue(raw: string): ChannelTopicIssue | null {
  return normalizeChannelTopic(raw).length > CHANNEL_TOPIC_MAX
    ? "tooLong"
    : null;
}

/** Field copy, inherited from the mac sheet so both clients say one thing. */
export function channelNameIssueMessage(issue: ChannelNameIssue): string {
  switch (issue) {
    case "required":
      return "채널 이름을 입력하세요.";
    case "tooLong":
      return `채널 이름은 ${CHANNEL_NAME_MAX}자 이내여야 합니다.`;
    case "unsupportedCharacters":
      return "영문, 숫자, 하이픈, 밑줄만 사용할 수 있습니다.";
    case "edgeSeparator":
      return "처음과 끝은 영문이나 숫자여야 합니다. 하이픈과 밑줄은 가운데에만 쓸 수 있습니다.";
  }
}

export function channelTopicIssueMessage(issue: ChannelTopicIssue): string {
  switch (issue) {
    case "tooLong":
      return `주제는 ${CHANNEL_TOPIC_MAX}자 이내여야 합니다.`;
  }
}

/**
 * May this member create a channel at all?
 *
 * `ChannelRoutes.create` runs `requireWorkspaceAdmin`, so a plain member's
 * every attempt ends in 403. Offering the action anyway would replace the dead
 * end this ticket removes with a slower one, so the entry points ask first.
 *
 * An absent role is treated as allowed on purpose: the roster projection marks
 * `role` optional, and hiding the only way to create a channel because a field
 * did not arrive is a worse failure than letting the server answer.
 */
export function canCreateChannel(role: MembershipRole | undefined): boolean {
  if (role === undefined) return true;
  return role === "owner" || role === "admin";
}

/**
 * The same question, asked while the roster may still be in flight.
 *
 * The fallback above answers "a roster that arrived without a role field", and
 * for that it is right. It cannot also answer "no roster yet", and it was being
 * asked both: on a slow roster every member saw the +, the ⌘K 만들기 item and
 * the body [채널 만들기] for a frame, then watched all three disappear (R2 M5).
 * An offer that is withdrawn is worse than an offer that arrives a beat late,
 * so until the roster settles the entry points say nothing. Once it settles,
 * including when it settles as an error, the documented fallback applies again
 * and the server keeps the last word.
 */
export function canCreateChannelNow(
  rosterSettled: boolean,
  role: MembershipRole | undefined
): boolean {
  if (!rosterSettled) return false;
  return canCreateChannel(role);
}

/**
 * A rejected creation, addressed to a place on the form.
 *
 * `field` is what makes this inline rather than a banner: a duplicate name is a
 * statement about the name box, so it is shown under the name box with the
 * value still in it, not floated somewhere the reader has to map back.
 */
export interface CreateChannelFailure {
  field: "name" | null;
  message: string;
}

export function createChannelFailure(error: unknown): CreateChannelFailure {
  if (error instanceof ApiError) {
    if (error.status === 409) {
      return {
        field: "name",
        message: "같은 이름의 채널이 이미 있습니다. 다른 이름으로 다시 시도하세요.",
      };
    }
    if (error.status === 400) {
      // The form validates with the server's own rule, so a 400 means the two
      // drifted. Say what the server will take rather than echoing its English.
      return {
        field: "name",
        message:
          "서버가 이 이름을 거절했습니다. 영문 소문자, 숫자, 하이픈, 밑줄만 쓸 수 있고 처음과 끝은 영문이나 숫자여야 합니다.",
      };
    }
    if (error.status === 403) {
      return {
        field: null,
        message:
          "채널을 만들 권한이 없습니다. 워크스페이스 오너나 관리자에게 요청하세요.",
      };
    }
    if (error.status === 429) {
      return {
        field: null,
        message: "요청이 너무 잦습니다. 잠시 뒤 다시 시도하세요.",
      };
    }
  }
  if (error instanceof NetworkError) {
    // The transport already writes measured copy for "nothing answered"
    // (timeout vs unreachable, with the deadline in seconds); a second
    // vocabulary for one failure is how two screens start disagreeing.
    return { field: null, message: `채널을 만들지 못했습니다. ${error.message}` };
  }
  return {
    field: null,
    message: "채널을 만들지 못했습니다. 잠시 뒤 다시 시도하세요.",
  };
}
