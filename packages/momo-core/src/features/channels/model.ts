import { ApiError, type MembershipRole } from "../../lib/api";
import { NetworkError } from "../../lib/http";
import koChannels from "../../i18n/catalogs/ko-KR/channels.json";
import type { MessageKey } from "../../i18n/generated/messages";

// =============================================================================
// 채널 만들기 model (AX-1a / MOMO-614). Everything the dialog decides without
// React lives here, so the rules are under test rather than inside a component.
//
// The name rule is the server's, and since ADR-0225 it is not ascii any more:
// letters and numbers of every script, `-` and `_`, blanks become `-`, at most
// 80 code points. The single source of truth is the shared vectors file
// (`docs/api/channel-name.vectors.json`); `__fixtures__/channel-name.vectors.json`
// is this package's byte-identical copy and `model.test.ts` runs every row of
// it. A client that accepts what the server rejects turns a typo into a 400 the
// reader cannot act on, and a client that rejects what the server accepts makes
// a legal name look broken. Both are the same bug. The server is the authority;
// this is the quick hint.
// =============================================================================

export const CHANNEL_NAME_MAX = 80;
export const CHANNEL_TOPIC_MAX = 280;

/** Unicode `White_Space` (ADR-0225 D2), the 25 code points Rust's
 *  `char::is_whitespace` knows. Deliberately not the regex class for spaces:
 *  that adds U+FEFF and lacks U+0085. */
const BLANKS = new Set<number>([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008,
  0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

/** Letters and marks that draw nothing (ADR-0225 D4, second list). The
 *  control/format/private-use/surrogate half is decided by category instead. */
function isInvisibleLetterOrMark(cp: number): boolean {
  return (
    cp === 0x115f || cp === 0x1160 || cp === 0x3164 || cp === 0xffa0 ||
    cp === 0x034f || cp === 0x17b4 || cp === 0x17b5 ||
    (cp >= 0x180b && cp <= 0x180d) || cp === 0x180f ||
    (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef)
  );
}

// The Unicode-property regexes are built the first time a name is judged, never
// at module load: an engine that does not know the syntax would otherwise fail
// to start the whole app (ADR-0225 D11; the same care as `design/fontName.ts`).
interface CategoryPatterns {
  letter: RegExp;
  number: RegExp;
  mark: RegExp;
  unseen: RegExp;
}
let categoryPatterns: CategoryPatterns | null = null;
function categories(): CategoryPatterns {
  categoryPatterns ??= {
    letter: new RegExp("^\\p{L}$", "u"),
    number: new RegExp("^\\p{N}$", "u"),
    mark: new RegExp("^\\p{M}$", "u"),
    unseen: new RegExp("^[\\p{Cc}\\p{Cf}\\p{Co}\\p{Cs}]$", "u"),
  };
  return categoryPatterns;
}

/** Why a name was refused: the five labels of the shared vectors. The server
 *  answers with two errors (length, characters); telling the five apart is the
 *  screen's job. */
export type ChannelNameVerdict =
  | "required"
  | "tooLong"
  | "hidden"
  | "unsupported"
  | "edge";

export type ChannelNameJudgement =
  | { ok: true; name: string }
  | { ok: false; verdict: ChannelNameVerdict };

export type ChannelNameIssue =
  | "required"
  | "tooLong"
  | "hiddenCharacters"
  | "unsupportedCharacters"
  | "edgeSeparator";
export type ChannelTopicIssue = "tooLong";

/** What the server stores, ADR-0225 D3 steps 1-5 (no accept/refuse decision):
 *  NFC, fullwidth to halfwidth, blanks, lowercase, NFC. */
export function normalizeChannelName(raw: string): string {
  const folded: number[] = [];
  for (const ch of raw.normalize("NFC")) {
    const cp = ch.codePointAt(0)!;
    folded.push(cp >= 0xff01 && cp <= 0xff5e ? cp - 0xfee0 : cp);
  }
  const isSeparator = (cp: number | undefined) => cp === 0x2d || cp === 0x5f;
  const out: number[] = [];
  let i = 0;
  while (i < folded.length) {
    if (!BLANKS.has(folded[i])) {
      out.push(folded[i]);
      i += 1;
      continue;
    }
    const runStart = i;
    while (i < folded.length && BLANKS.has(folded[i])) i += 1;
    if (i >= folded.length) break; // a trailing run: dropped
    if (runStart === 0) continue; // a leading run: dropped
    if (!isSeparator(out[out.length - 1]) && !isSeparator(folded[i])) out.push(0x2d);
  }
  return out
    .map((cp) => String.fromCodePoint(cp))
    .join("")
    .toLowerCase()
    .normalize("NFC");
}

/** ADR-0225 D1-D5, the server's `judge_channel_name`: fold, then length (code
 *  points) -> hidden -> characters -> edges, so an over-long name hears "too
 *  long" and a zero-width space hears "invisible". */
export function judgeChannelName(raw: string): ChannelNameJudgement {
  const name = normalizeChannelName(raw);
  const chars = Array.from(name);
  if (chars.length === 0) return { ok: false, verdict: "required" };
  if (chars.length > CHANNEL_NAME_MAX) return { ok: false, verdict: "tooLong" };
  const re = categories();
  if (chars.some((c) => re.unseen.test(c) || isInvisibleLetterOrMark(c.codePointAt(0)!))) {
    return { ok: false, verdict: "hidden" };
  }
  // A combining mark must lean on a letter or number (directly, or through
  // other marks), never on `-`, `_` or the start of the name.
  let afterBase = false;
  for (const c of chars) {
    if (re.letter.test(c) || re.number.test(c)) afterBase = true;
    else if (re.mark.test(c) && afterBase) continue;
    else if (c === "-" || c === "_") afterBase = false;
    else return { ok: false, verdict: "unsupported" };
  }
  const edge = (c: string) => c === "-" || c === "_";
  if (edge(chars[0]) || edge(chars[chars.length - 1])) {
    return { ok: false, verdict: "edge" };
  }
  return { ok: true, name };
}

/** Topic keeps its case; only the edges go. Empty means "no topic". */
export function normalizeChannelTopic(raw: string): string {
  return raw.trim();
}

export function channelNameIssue(raw: string): ChannelNameIssue | null {
  const judged = judgeChannelName(raw);
  if (judged.ok) return null;
  switch (judged.verdict) {
    case "required":
      return "required";
    case "tooLong":
      return "tooLong";
    case "hidden":
      return "hiddenCharacters";
    case "unsupported":
      return "unsupportedCharacters";
    case "edge":
      return "edgeSeparator";
  }
}

export function channelTopicIssue(raw: string): ChannelTopicIssue | null {
  return normalizeChannelTopic(raw).length > CHANNEL_TOPIC_MAX
    ? "tooLong"
    : null;
}

/** Dictionary keys of the name-rule sentences (`i18n/catalogs/<언어>/channels.json`,
 *  seven languages). Screens format these with their message service; `tooLong`
 *  takes `{max}` (`CHANNEL_NAME_MAX`). `serverRejected` is what a 400 on create
 *  or rename shows instead of the server's English. */
export const CHANNEL_NAME_ISSUE_KEYS = {
  required: "channels.nameRule.required",
  tooLong: "channels.nameRule.tooLong",
  hiddenCharacters: "channels.nameRule.hidden",
  unsupportedCharacters: "channels.nameRule.unsupported",
  edgeSeparator: "channels.nameRule.edge",
} as const satisfies Record<ChannelNameIssue, MessageKey>;

export const CHANNEL_NAME_SERVER_REJECTED_KEY =
  "channels.nameRule.serverRejected" as const satisfies MessageKey;

export function channelNameIssueKey(
  issue: ChannelNameIssue
): (typeof CHANNEL_NAME_ISSUE_KEYS)[ChannelNameIssue] {
  return CHANNEL_NAME_ISSUE_KEYS[issue];
}

/** Korean sentences for callers that have no message service yet. They are
 *  read from the ko catalog itself, so there is one copy of the words. New
 *  screens format `channelNameIssueKey` with their message service instead. */
function koSentence(key: MessageKey): string {
  return (koChannels as Record<string, string>)[key].replace(
    "{max, number}",
    String(CHANNEL_NAME_MAX)
  );
}

export function channelNameIssueMessage(issue: ChannelNameIssue): string {
  return koSentence(CHANNEL_NAME_ISSUE_KEYS[issue]);
}

export function channelTopicIssueMessage(issue: ChannelTopicIssue): string {
  switch (issue) {
    case "tooLong":
      return `주제는 ${CHANNEL_TOPIC_MAX}자 이내여야 합니다.`;
  }
}

// =============================================================================
// 채널 헤더 메뉴 (검수 피드백 #3, #1865). 헤더 우측 ⋮ 이 여는 메뉴의 낱말과,
// 어떤 항목이 서는가의 규칙. 낱말을 코어에 두는 이유는 만들기 폼과 같다: 두
// 클라(그리고 게이트)가 한 문장을 읽게 한다.
//
// 「이름 수정」은 이 메뉴에 없다. 2026-08-10 서버 라우트 전수 실측에서 채널 이름을
// 바꾸는 라우트(`PATCH …/channels/{ch}` 류)가 없었고, 누를 수 없는 항목을 그리는
// 것은 없는 항목보다 나쁘다. 별도 티켓으로 남긴다.
//
// 토픽도 같은 이유다: 읽기 다이얼로그는 있고, 갱신 라우트는 없다. 항목 이름은
// 「주제 보기」이지 「편집」이 아니다. 빈 토픽에는 항목 자체를 그리지 않는다.
// =============================================================================

export const CHANNEL_MUTE_LABEL = "알림 켜짐";
export const CHANNEL_UNMUTE_LABEL = "알림 꺼짐";
export const CHANNEL_LEAVE_LABEL = "채널 나가기";
export const CHANNEL_TOPIC_VIEW_LABEL = "주제 보기";

/** 항목의 낱말은 상태다: 지금 켜짐·꺼짐을 말한다. */
export function channelMuteToggleLabel(muted: boolean): string {
  return muted ? CHANNEL_UNMUTE_LABEL : CHANNEL_MUTE_LABEL;
}

/**
 * 이 사람에게 「채널 나가기」를 내놓는가.
 *
 * 서버의 `remove_member`는 워크스페이스 소유자/관리자만 멤버십을 지울 수 있게
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
  "알림 설정을 바꾸지 못했어요. 잠시 뒤에 다시 시도해 주세요.";

/** 나가기 확인 다이얼로그의 제목. */
export const CHANNEL_LEAVE_CONFIRM_TITLE = "이 채널에서 나갈까요?";

/**
 * 확인 다이얼로그의 본문. 「관리자가 다시 추가해야」가 참인 이유: 채널에 멤버를
 * 넣는 라우트(`add_member`)도 소유자/관리자 권한이라, 나간 뒤 스스로 다시 들어올
 * 길이 없다.
 */
export function channelLeaveConfirmBody(name: string): string {
  return `${name} 채널이 사이드바에서 사라집니다. 다시 들어오려면 워크스페이스 관리자가 다시 추가해야 합니다.`;
}

/** 나가기가 실패했을 때, 그 자리에서 하는 말. `createChannelFailure`와 같은 결. */
export function channelLeaveFailureMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      // remove_member는 소유자/관리자만 허용한다. `canLeaveChannel`이 앞에서
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

// ---- 행에서 채널을 조작하는 낱말 (BT-1 / #1929) ------------------------------
//
// 채널 액션은 헤더 ⋮ 메뉴에만 있었다 — 「채널을 열지 않고 조작한다」는 문법이
// 아예 없었고, 사이드바 행 우클릭이 그 문을 연다. 두 표면이 같은 일을 하므로
// 낱말은 여기 한 벌뿐이다: `copyLabels.ts`가 메시지 쪽에서 같은 이유로 이미
// 코어에 있고(웹 메뉴와 폰 시트가 갈라졌던 자리), 링크 복사의 낱말은 그 파일
// 것을 그대로 든다 — 같은 뜻에 두 번째 이름을 만들지 않는다.

/** 이 채널의 안 읽음을 서버에 광고한다. 채널을 열지 않고. */
export const CHANNEL_MARK_READ_LABEL = "읽음 처리하기";

/** 읽음 광고가 실패했을 때, 그 항목 자리에서 하는 말(토스트가 아니다). */
export const CHANNEL_MARK_READ_FAILURE =
  "읽음 처리를 하지 못했습니다. 잠시 뒤에 다시 시도하세요.";

/** 채널 이름(또는 DM 상대의 이름)을 클립보드에 올린다. */
export const CHANNEL_COPY_NAME_LABEL = "이름 복사하기";

/** 이름이 클립보드에 올라간 뒤의 영수증. */
export const CHANNEL_COPY_NAME_DONE_LABEL = "이름 복사됨";

/** 복사 항목의 낱말도 상태다 — `copyLinkActionLabel`과 같은 결. */
export function channelCopyNameLabel(copied: boolean): string {
  return copied ? CHANNEL_COPY_NAME_DONE_LABEL : CHANNEL_COPY_NAME_LABEL;
}

// ---- 복사 · 읽지 않음으로 표시 · DM 닫기 (#3963) ----------------------------
//
// 성재(2026-10-16)가 Buzz 캡처와 맞대어 준 메뉴 구성이다. 「복사 ▸」는 이 레포의 서브메뉴
// 금지(이슈 #1383, `dropdown-menu.tsx` 머리말)에 따라 **서브메뉴가 아니라 화면에 남는 행들
// 위의 제목**으로 옮겼다: 이름·링크·ID 세 행이 접히지 않고 서 있다.

/** 복사 무리의 제목. 항목이 아니라 그 아래 세 행의 이름이다. */
export const CHANNEL_COPY_GROUP_LABEL = "복사";

/** 채널(또는 DM)의 ID를 클립보드에 올린다. */
export const CHANNEL_COPY_ID_LABEL = "ID 복사하기";

/** ID가 클립보드에 올라간 뒤의 영수증. */
export const CHANNEL_COPY_ID_DONE_LABEL = "ID 복사됨";

/** 복사 항목의 낱말도 상태다 - `channelCopyNameLabel` 과 같은 결. */
export function channelCopyIdLabel(copied: boolean): string {
  return copied ? CHANNEL_COPY_ID_DONE_LABEL : CHANNEL_COPY_ID_LABEL;
}

/**
 * 읽음 처리의 반대 방향. 다 읽은 채널의 **가장 최근 메시지**를 첫 안 읽음으로 남긴다
 * (ADR-0178 D5). 안 읽음이 이미 있는 채널에는 「읽음 처리하기」가 서므로 둘은 한 자리의
 * 두 방향이고, 한 메뉴에 함께 서지 않는다.
 */
export const CHANNEL_MARK_UNREAD_LABEL = "읽지 않음으로 표시하기";

/** 왕복이 도는 동안. 「명사 + 중」 꼴이다(진행 낱말 게이트). */
export const CHANNEL_MARK_UNREAD_BUSY_LABEL = "읽지 않음으로 표시 중";

/** 표시가 거절됐을 때, 그 항목 자리에서 하는 말(토스트가 아니다). */
export const CHANNEL_MARK_UNREAD_FAILURE =
  "읽지 않음으로 표시하지 못했습니다. 잠시 뒤에 다시 시도하세요.";

/**
 * DM 행의 「목록에서 숨기기」 (2026-11-14 QA 11: 옛 낱말 「목록에서 숨기기」). 호버 X 와 우클릭 항목이 같은 낱말을 쓴다.
 * **대화를 지우는 것이 아니다**: 내 목록에서 숨길 뿐이고(서버가 기억해 모든 기기에서 숨는다, ADR-0177 D7), 새 메시지가
 * 오면 다시 나타난다. 그래서 확인 단계가 없다. 이 낱말이 「나가기」와 헷갈리지 않게 「닫기」를 쓰지 않는다.
 * 동작 이름(`close-dm`·`closure` 라우트)은 그대로이고 사람이 읽는 낱말만 바뀌었다.
 */
export const DM_CLOSE_LABEL = "목록에서 숨기기";

/** 숨기기·다시 보이기가 서버에서 거절됐을 때 하는 말. 되돌려진 대화가 다시 서 있는 이유다. */
export const DM_CLOSE_FAILURE = "대화를 목록에서 숨기지 못했어요. 잠시 뒤에 다시 시도해 주세요.";

export const DM_REOPEN_FAILURE = "대화를 다시 보이게 하지 못했어요. 잠시 뒤에 다시 시도해 주세요.";

/** 호버 X 의 접근 가능한 이름. 행의 링크 이름 꼴(`이름, 뜻`)을 따른다. */
export function dmCloseButtonLabel(name: string): string {
  return `${name}, ${DM_CLOSE_LABEL}`;
}

/**
 * 메뉴 안에서 실패 문장을 인 상자의 이름 (design-review #1937 N-5).
 *
 * `role="menu"` 의 직계 자식은 menuitem/group/separator 여야 하는데 실패 배너는
 * `role="alert"` 이다. `group` 한 겹으로 구조를 맞추면 그 group 은 이름을 가져야
 * 하고, 그 이름이 이 문장이다.
 */
export const CHANNEL_ACTION_ERROR_GROUP_LABEL = "이 메뉴의 알림";

/** 읽음 광고가 도는 동안. */
export const CHANNEL_MARK_READ_BUSY_LABEL = "읽음 처리 중";

/**
 * 이 행의 메뉴가 스크린리더에게 자기를 부르는 이름 (design-review #1937 M-1).
 *
 * DM 에 「채널 메뉴」라고 말하지 않는다. 헤더 ⋮ 는 DM 에 아예 서지 않아서
 * 이 낱말이 DM 에 붙는 자리는 사이드바 행이 처음이고, 이 제품이 그 표면을
 * 부르는 이름은 사이드바 섹션 제목과 같은 「다이렉트 메시지」다.
 */
export function channelMenuAccessibleLabel(name: string, isDm: boolean): string {
  return `${name} ${isDm ? "다이렉트 메시지" : "채널"} 메뉴`;
}

/**
 * 클립보드 자체가 없는 런타임에서 하는 말. 다시 눌러도 같으므로 「다시
 * 시도」라고 말하지 않는다 — `MessageRow`의 형제 문장과 같은 판정이다.
 */
export const CHANNEL_COPY_UNAVAILABLE =
  "복사하지 못했습니다. 이 브라우저에서는 클립보드를 쓸 수 없습니다.";

/** 클립보드는 있는데 쓰기가 실패했을 때. 다시 누르면 될 수 있다. */
export const CHANNEL_COPY_FAILURE =
  "복사하지 못했습니다. 같은 항목을 다시 눌러 보세요.";

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
  /** Set when the sentence has a dictionary key (a 400 on the name); screens
   *  with a message service format it instead of `message`. */
  messageKey?: typeof CHANNEL_NAME_SERVER_REJECTED_KEY;
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
      // The form judges with the server's own rule, so a 400 means the two
      // drifted. Say what the server will take rather than echoing its English.
      return {
        field: "name",
        message: koSentence(CHANNEL_NAME_SERVER_REJECTED_KEY),
        messageKey: CHANNEL_NAME_SERVER_REJECTED_KEY,
      };
    }
    if (error.status === 403) {
      return {
        field: null,
        message:
          "채널을 만들 권한이 없습니다. 워크스페이스 소유자나 관리자에게 요청하세요.",
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
