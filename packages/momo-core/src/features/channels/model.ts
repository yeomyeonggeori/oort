import { ApiError, type MembershipRole } from "../../lib/api";
import { NetworkError } from "../../lib/http";

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

// =============================================================================
// 채널 헤더 메뉴 (검수 피드백 #3). 채널 이름을 누르면 서는 메뉴의 낱말과, 어떤
// 항목이 서는가의 규칙. 낱말을 코어에 두는 이유는 만들기 폼과 같다: 두 클라(그리고
// 게이트)가 한 문장을 읽게 한다.
//
// 「이름 수정」은 이 메뉴에 없다. 2026-08-10 서버 라우트 전수 실측에서 채널 이름을
// 바꾸는 라우트(`PATCH …/channels/{ch}` 류)가 없었고, 누를 수 없는 항목을 그리는
// 것은 없는 항목보다 나쁘다. 별도 티켓으로 남긴다.
// =============================================================================

export const CHANNEL_MUTE_LABEL = "알림 끄기";
export const CHANNEL_UNMUTE_LABEL = "알림 켜기";
export const CHANNEL_LEAVE_LABEL = "채널 나가기";

/** 항목의 낱말은 상태다: 켜져 있으면 「끄기」, 꺼져 있으면 「켜기」. */
export function channelMuteToggleLabel(muted: boolean): string {
  return muted ? CHANNEL_UNMUTE_LABEL : CHANNEL_MUTE_LABEL;
}

/**
 * 이 사람에게 「채널 나가기」를 내놓는가.
 *
 * 서버의 `remove_member`는 워크스페이스 오너/관리자만 멤버십을 지울 수 있게
 * 막는다(2026-08-10 실측, `channels.rs:378` `role_of_actor.is_admin()`) — 자기
 * 자신을 지우는 것도 포함이다. 그래서 일반 멤버에게 「나가기」를 내놓으면 확인
 * 다이얼로그 뒤에서 403으로 끝나는 막다른 길이 된다. 채널 만들기가 같은 이유로
 * `canCreateChannel`을 두는 것과 같은 규율이고, role이 아직 안 온 경우는(roster의
 * 선택 필드) 내놓고 서버가 마지막 말을 하게 둔다.
 */
export function canLeaveChannel(role: MembershipRole | undefined): boolean {
  if (role === undefined) return true;
  return role === "owner" || role === "admin";
}

/** 알림 설정을 바꾸지 못했을 때, 그 항목 자리에서 하는 말(토스트가 아니다). */
export const CHANNEL_MUTE_FAILURE =
  "알림 설정을 바꾸지 못했습니다. 잠시 뒤에 다시 시도하세요.";

/** 나가기 확인 다이얼로그의 제목. */
export const CHANNEL_LEAVE_CONFIRM_TITLE = "이 채널에서 나갈까요?";

/**
 * 확인 다이얼로그의 본문. 「관리자가 다시 추가해야」가 참인 이유: 채널에 멤버를
 * 넣는 라우트(`add_member`)도 오너/관리자 권한이라, 나간 뒤 스스로 다시 들어올
 * 길이 없다.
 */
export function channelLeaveConfirmBody(name: string): string {
  return `${name} 채널이 사이드바에서 사라집니다. 다시 들어오려면 워크스페이스 관리자가 다시 추가해야 합니다.`;
}

/** 나가기가 실패했을 때, 그 자리에서 하는 말. `createChannelFailure`와 같은 결. */
export function channelLeaveFailureMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      // remove_member는 오너/관리자만 허용한다. `canLeaveChannel`이 앞에서
      // 걸러도, role이 늦게 왔거나 도중에 강등된 경우 서버가 여기로 답한다.
      return "채널에서 나갈 권한이 없습니다. 워크스페이스 관리자에게 요청하세요.";
    }
    if (error.status === 404) {
      return "이미 이 채널의 멤버가 아닙니다.";
    }
  }
  if (error instanceof NetworkError) {
    return `채널에서 나가지 못했습니다. ${error.message}`;
  }
  return "채널에서 나가지 못했습니다. 잠시 뒤에 다시 시도하세요.";
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
        message: "요청이 너무 잦습니다. 잠시 뒤에 다시 시도하세요.",
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
    message: "채널을 만들지 못했습니다. 잠시 뒤에 다시 시도하세요.",
  };
}
