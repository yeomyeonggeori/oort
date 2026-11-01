import { uuidEq, type Message } from "../../lib/api";
import { payloadToMessage, type MessageNewEvent } from "../../lib/realtimeEvents";
import { attachmentPreviewLine } from "../attachments/model";
import { mentionsMember } from "../inbox/model";
import { agentCardModel } from "../timeline/agentCardModel";

// =============================================================================
// Desktop notification decision (MOMO-607, ADR-0133 P2). Pure: no DOM, no Tauri,
// no React — every suppression rule below is asserted in model.test.ts instead
// of by watching a notification centre.
//
// The bridge that shows the banner is `src/lib/tauri.ts` (MOMO-603/766); this
// module owns the only question that bridge does not answer: **should anything
// be shown at all**. The default answer is no. A notification interrupts, so it
// has to earn the interruption:
//
//   - only on a surface that can raise OS notifications: the desktop shell, or
//     a browser tab whose user opted in and was granted permission (#3340). The
//     rules below are the same for both; only the gate differs;
//   - only for the two events that are addressed to a person — a mention the
//     SERVER recorded, and an approval request waiting on a human decision;
//   - never when the window already has focus (zero-noise: the message is on
//     screen, or one keystroke away);
//   - never twice for the same message, never for one's own writing, never for
//     a channel the server says is muted, and never for a burst replayed by a
//     reconnect long after the fact;
//   - never while the member's own 알림 일시 중지 is on (#4197). The phone push
//     stops for it on the server (ADR-0124 증보 2, `judge_targets`), so a banner
//     that kept coming would make 「알림도 함께 멈춰요」 untrue on a surface that
//     decides for itself. The pause is the SERVER's value, handed in as
//     `paused`; this module never compares its expiry with a clock (see there).
//
// The copy is deliberately thin: sender as the title, one truncated line as the
// body. Code and secret-shaped tokens are replaced rather than forwarded — a
// notification is rendered by the OS, is retained by the notification centre,
// and is visible to anyone glancing at the screen.
// =============================================================================

/**
 * `dm` (#3339): a message in a direct conversation (including a consented group DM) that does not mention
 * you. Off by default on this device (`preference.ts`): a DM is the noisiest
 * thing a person can do to a teammate, so the person opts in.
 */
export type NotifyKind = "mention" | "approval" | "dm";

/** Why nothing was shown. Every value is a rule someone can argue with. */
export type NotifySkip =
  /** No OS-notification surface: neither the desktop shell nor a granted, opted-in tab. */
  | "browser"
  /** Ordinary channel traffic — not addressed to this member. */
  | "not-notifiable"
  /** An edit is not news; the original already had its chance. */
  | "edited"
  /** One's own message, echoed back by the rail. */
  | "self"
  /** The server's per-member mute for this channel. */
  | "muted"
  /** The member's own 알림 일시 중지 is on — nothing becomes a banner, mentions and approvals included (#4197). */
  | "paused"
  /** momo is the window in front — showing a banner would be noise. */
  | "focused"
  /** Already announced this run. */
  | "duplicate"
  /** Replayed by a reconnect, not live. */
  | "stale"
  /** This device turned this kind off. */
  | "kind-disabled";

export interface DesktopNotification {
  kind: NotifyKind;
  messageId: string;
  channelId: string;
  /** Sender. The one thing that decides whether this is worth turning around for. */
  title: string;
  /** One line, truncated, code and secrets removed. Absent when there is none. */
  body?: string;
}

export type NotifyDecision =
  | { show: true; notification: DesktopNotification }
  | { show: false; skip: NotifySkip };

// ---- copy ------------------------------------------------------------------

/** Body budget. Longer than a macOS banner renders anyway. */
export const BODY_MAX = 80;

/**
 * Token shapes that are secrets wherever they appear. The list is short and
 * literal on purpose: a greedy "looks random" heuristic would redact Korean
 * prose, ids and URLs, and a notification that says 비공개 값 where the message
 * said something ordinary is its own kind of lie.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+/g, // JWT
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{12,}/g,
];

const FENCED_CODE = /```[\s\S]*?(?:```|$)/g;
const INLINE_CODE = /`[^`\n]*`/g;

/**
 * A message body as one safe line.
 *
 * A fenced block is removed and the prose around it is what gets shown — a
 * banner cannot render code legibly, and a pasted snippet is the likeliest
 * place for a credential to be sitting. A message that is *only* code says so
 * ("코드") rather than going out with no body at all. Everything after the first
 * line is dropped for the same reason the line is truncated: the notification
 * is a pointer to the message, not a copy of it.
 */
export function notificationBody(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  let text = raw.replace(FENCED_CODE, "\n").replace(INLINE_CODE, " 코드 ");
  const hadCode = text !== raw;
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, "비공개 값");
  }
  const line = text
    .split("\n")
    .map((candidate) => candidate.replace(/\s+/g, " ").trim())
    .find((candidate) => candidate.length > 0);
  if (line === undefined || line === "") return hadCode ? "코드" : undefined;
  if (line.length <= BODY_MAX) return line;
  return `${line.slice(0, BODY_MAX - 1).trimEnd()}…`;
}

// ---- classification --------------------------------------------------------

/**
 * What this message is, to this member. `null` is the overwhelmingly common
 * answer and means "ordinary traffic".
 *
 * Mentions are the SERVER's decision, read back from `props.mention_member_ids`
 * (P7 / inbox model) — the client never re-parses a body looking for its own
 * name, because handles change and the recorded decision does not.
 *
 * An approval request counts while the ledger still says `pending`: that is the
 * agent-card `awaiting-approval` state, and it is the one row in the product
 * that is actively waiting on a human.
 */
export function notifiableKind(
  message: Message,
  selfMemberId: string,
  isDirect = false
): NotifyKind | null {
  if (message.state === "deleted") return null;
  if (message.type === "approval_request") {
    const card = agentCardModel(message);
    if (card?.kind === "approval" && card.status === "pending") return "approval";
  }
  if (mentionsMember(message, selfMemberId)) return "mention";
  // A DM that mentions you is a mention (the louder, default-on kind).
  // Only a person-readable text row: a join/system line or a tool call is not a DM.
  if (isDirect && message.type === "text") return "dm";
  return null;
}

// ---- decision --------------------------------------------------------------

/**
 * How far behind the server clock an event may be and still count as news.
 *
 * A recoverable subscription replays everything missed while the machine was
 * asleep, and the window is by definition unfocused when it wakes: without this
 * the first reconnect of the morning would fire one banner per missed mention.
 * Both sides of the comparison are wall clocks (`hlc_ts` is the server's
 * `Date().timeIntervalSince1970 * 1000`), so this trades a clock-skew tolerance
 * for a bounded burst — and the missed mentions are all still in the inbox,
 * which is where a backlog belongs.
 */
export const MAX_AGE_MS = 120_000;

/**
 * Is a browser tab in front of the person? Both halves are needed: a tab can be
 * `visible` while another window has focus (split screen), and `hasFocus` alone
 * misses a hidden tab (#3340). Only a visible AND focused tab counts as front.
 */
export function windowIsFront(
  visibilityState: string | undefined,
  hasFocus: boolean
): boolean {
  return visibilityState === "visible" && hasFocus;
}

export interface NotifyContext {
  /**
   * This surface can raise OS notifications: the Tauri shell, or a browser tab
   * with Notification permission granted by an explicit click (#3340). False =
   * the whole feature is off. (Name kept for the desktop callers.)
   */
  isDesktop: boolean;
  /** The momo window is in front right now (see `windowIsFront` for a tab). */
  windowFocused: boolean;
  /**
   * Is this channel what the window is showing right now? A banner is
   * suppressed only when the window is focused AND the target is on screen
   * (#3339): a focused window looking at another channel still gets one.
   * Absent means "assume visible", the stricter pre-#3339 rule (any focus
   * suppresses).
   */
  isTargetVisible?: (channelId: string) => boolean;
  /** Is this channel a one-to-one DM? Absent means no channel is. */
  isDirect?: (channelId: string) => boolean;
  selfMemberId: string;
  /**
   * 이 멤버의 **알림 일시 중지**(서버 `notification_rule.dnd`)가 켜져 있다 (#4197). 켜져 있으면
   * 멘션·승인·DM 어느 것도 OS 배너가 되지 않는다: 폰 푸시는 같은 규칙으로 서버에서 멈추는데(ADR-0124
   * 증보 2, ADR-0204 D2) 배너만 계속 오면 「알림도 함께 멈춰요」가 이 기기에서만 거짓이 된다.
   * 채널 음소거·종류 스위치보다 위다(ADR-0124 D5: 일시 중지 > 채널 mute > 사유).
   *
   * **기한(`dndUntilMs`)을 여기서 시계와 비교하지 않는다.** 만료는 서버가 판정하고(증보 2 D7, 읽기도
   * 유효 값을 준다) 클라이언트는 기한이 지나면 규칙을 **다시 읽을** 뿐이다(ADR-0204 D3). 그러니 이 값은
   * 서버가 마지막으로 답한 `dnd` 그대로다. 못 읽었으면 비운다 — 읽지 못한 규칙으로 배너를 막지 않는다.
   * 배지·인박스는 이 입력과 무관하다(별개 원장, ADR-0124 D2).
   */
  paused?: boolean;
  /** Server per-member mute for a channel (Channel.muted). */
  isMuted: (channelId: string) => boolean;
  /** Message ids already announced this run. */
  isAnnounced: (messageId: string) => boolean;
  /** Sender as a display token: `@handle` for agents, the name for people. */
  actorFor: (memberId: string) => string;
  /**
   * 도우미 초대 링크 메시지(#5025)의 알림이 서버의 `props.preview` 를 못 쓸 때(없음·빔·링크 모양) 말하는
   * **링크 없는 고정 문장**. 문구 사전의 것(`notifications.inviteLink.fallback`)을 호출자가 지금 언어로 읽어 준다:
   * 이 모듈은 사전도 언어도 모른다. 함수인 이유는 그런 메시지가 올 때만 읽기 위해서다.
   */
  inviteLinkSentence: () => string;
  nowMs: number;
  maxAgeMs?: number;
  /**
   * Device-local kind mute. Absent means every notifiable kind is on.
   * The web layer reads `momo.web.notifications.v1` and passes that here.
   */
  kindEnabled?: (kind: NotifyKind) => boolean;
}

/**
 * The whole rule, in the order the rules matter. The reasons are returned
 * rather than logged so the tests read as the product statement.
 */
export function notifyDecision(
  event: MessageNewEvent,
  context: NotifyContext
): NotifyDecision {
  if (!context.isDesktop) return { show: false, skip: "browser" };
  if (event.type !== "message.new") return { show: false, skip: "edited" };

  const message = payloadToMessage(event.payload);
  const kind = notifiableKind(
    message,
    context.selfMemberId,
    context.isDirect?.(message.channelId) ?? false
  );
  if (kind === null) return { show: false, skip: "not-notifiable" };
  if (uuidEq(message.authorMemberId, context.selfMemberId)) {
    return { show: false, skip: "self" };
  }
  // 일시 중지는 채널 음소거·종류 스위치보다 위다(ADR-0124 D5).
  if (context.paused) return { show: false, skip: "paused" };
  if (context.isMuted(message.channelId)) return { show: false, skip: "muted" };
  if (context.kindEnabled && !context.kindEnabled(kind)) {
    return { show: false, skip: "kind-disabled" };
  }

  const maxAgeMs = context.maxAgeMs ?? MAX_AGE_MS;
  // hlc_ts of 0 means the server did not stamp one; a live frame is the honest
  // reading of that, so an unstamped event is not treated as a replay.
  if (message.hlcTs > 0 && context.nowMs - message.hlcTs > maxAgeMs) {
    return { show: false, skip: "stale" };
  }
  if (context.isAnnounced(message.id)) return { show: false, skip: "duplicate" };
  if (
    context.windowFocused &&
    (context.isTargetVisible?.(message.channelId) ?? true)
  ) {
    return { show: false, skip: "focused" };
  }

  const notification: DesktopNotification = {
    kind,
    messageId: message.id,
    channelId: message.channelId,
    title: context.actorFor(message.authorMemberId),
  };
  // 「무엇이 일어났나 + 어디서」 순서(#3339 시안): 승인은 종류 이름이 먼저다.
  if (kind === "approval") notification.title = `승인 필요 · ${notification.title}`;
  const body =
    notificationBody(notificationSource(message, kind, context.inviteLinkSentence)) ??
    // 글 없이 사진·파일만 보낸 DM·멘션(#4294): 제목만 있는 배너가 되지 않게 개수로 말한다.
    // 본문이 있으면 본문이 이긴다(위 식이 이미 답했다). 승인 카드에는 첨부가 없다.
    (kind === "approval" ? undefined : (attachmentPreviewLine(message.attachments) ?? undefined));
  if (body !== undefined) notification.body = body;
  return { show: true, notification };
}

// ---- 도우미 초대 링크 메시지 (#5025, ADR-0201 증보 v3 B4-2) -----------------------

/**
 * 서버가 도우미의 초대 링크 메시지에 붙이는 `props.kind`(#4965, 서버 `momo-messaging`의
 * `invite_link::PROPS_KIND`와 같은 낱말). 폰 알림 확장(Swift `PushInviteLinkCopy.kind`)이 같은 낱말을
 * 읽는다 — 폰 시험이 둘을 맞댄다.
 */
export const INVITE_LINK_KIND = "team_ai_invite_link";

/**
 * 링크의 모양: 서버의 `…/join?code=…`(퍼센트 인코딩한 것도)이거나 `://`가 든 어떤 주소.
 * 서버가 `preview`에 링크를 실을 일은 없다(닫힌 객체). 이 모양 검사는 그 계약이 어긋난 날에도 알림 문장에
 * 링크가 0이게 하는 마지막 걸음쇠다: 모양이면 `preview`를 버리고 고정 문장으로 말한다.
 * Swift `PushInviteLinkCopy.carriesLink`가 같은 세 조각을 센다.
 */
const INVITE_LINK_SHAPE = /join\?code=|join%3fcode%3d|:\/\//i;

/**
 * 도우미의 초대 링크 메시지가 알림에서 말하는 한 문장.
 *
 * 그 메시지의 본문은 「문장 + 링크」다. 알림은 본문 어디도 읽지 않는다 — 배너와 잠금 화면은 같은 방의 눈에
 * 닿는 자리라서 링크는 대화 안에서만 보여야 한다(ADR-0201 증보 v3 B4-2: 푸시 미리보기에는 링크를 싣지
 * 않는다). 서버가 링크 없이 써 준 `props.preview`가 알림 문장이고, 없거나 비었거나 링크 모양이면 호출자가
 * 사전에서 읽어 준 고정 문장이다. 이 함수는 표지가 있는 메시지에만 문장을 낸다(`undefined`면 평범한 메시지).
 */
export function inviteLinkNotificationText(
  props: Message["props"],
  fallback: () => string
): string | undefined {
  if (props?.kind !== INVITE_LINK_KIND) return undefined;
  const preview = typeof props.preview === "string" ? props.preview.trim() : "";
  return preview !== "" && !INVITE_LINK_SHAPE.test(preview) ? preview : fallback();
}

/**
 * 알림 본문이 읽을 글: 도우미 초대 링크 메시지는 그 문장, 승인 카드는 카드 제목, 나머지는 본문이다.
 * 표지가 가장 먼저다 — 본문은 링크를 품은 글이라 어떤 갈래도 그것을 먼저 읽으면 안 된다.
 */
function notificationSource(
  message: Message,
  kind: NotifyKind,
  inviteLinkSentence: () => string
): string | undefined {
  return (
    inviteLinkNotificationText(message.props, inviteLinkSentence) ??
    approvalTitle(message, kind) ??
    message.body
  );
}

/**
 * An approval card carries the server's own public title, which says what is
 * being asked for. The raw body of that message is the same sentence at best
 * and internal vocabulary at worst, so the card copy wins when there is one.
 */
function approvalTitle(message: Message, kind: NotifyKind): string | undefined {
  if (kind !== "approval") return undefined;
  const card = agentCardModel(message);
  return card?.kind === "approval" ? card.title : undefined;
}

// ---- duplicate ledger ------------------------------------------------------

/** How many message ids to remember. Bounded so a long session cannot grow. */
export const ANNOUNCED_CAP = 200;

/**
 * Remember one announced message, oldest dropped first. Returns a new list, so
 * the caller can hold it in a ref and this stays testable without one.
 */
export function rememberAnnounced(
  announced: readonly string[],
  messageId: string,
  cap: number = ANNOUNCED_CAP
): string[] {
  if (announced.includes(messageId)) return announced.slice();
  const next = [...announced, messageId];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

// ---- click landing ---------------------------------------------------------

/**
 * How long a shown notification stays the reason the window is being looked at.
 *
 * KNOWN APPROXIMATION. `notification_show` (MOMO-603) is fire-and-forget: the
 * shell reports permission and delivery, never a click, so the web layer cannot
 * be told which banner was clicked. What it can observe is that clicking a
 * macOS notification activates the app, and the window was unfocused when the
 * banner was shown (that is a precondition of showing it at all). So the target
 * is armed at show time and consumed by the next focus.
 *
 * The failure mode is honest and small: someone who ignores the banner and
 * switches to momo within this window lands on the mentioned channel instead of
 * where they left off — one sidebar click away, and usually where they were
 * heading. The proper fix is a click event from the shell, which needs a Rust
 * notification path that keeps the handle (`clients/desktop/README.md`).
 */
export const OPEN_ARM_TTL_MS = 20_000;

export interface ArmedOpen {
  /** The channel every armed notification pointed at; null when they disagree. */
  channelId: string | null;
  /**
   * 무장된 알림이 **모두 같은 카드(메시지)** 를 가리킬 때만 있다 (#3738).
   * 승인 알림이 채널 맨 아래가 아니라 그 카드로 착지하게 한다. 같은 채널의 다른
   * 메시지가 끼면 사라지고, 그때는 채널로 간다 — 어느 카드를 뜻하는지 추측하지 않는다.
   */
  messageId?: string;
  armedAtMs: number;
}

/**
 * Arm (or re-arm) the landing target. Two notifications for the same channel
 * still point at it; two channels cancel each other out, because guessing which
 * of them someone meant is worse than landing on the list that holds both.
 */
export function armOpen(
  current: ArmedOpen | null,
  channelId: string,
  nowMs: number,
  ttlMs: number = OPEN_ARM_TTL_MS,
  messageId?: string
): ArmedOpen {
  const live = current !== null && nowMs - current.armedAtMs <= ttlMs;
  if (!live) {
    return messageId === undefined
      ? { channelId, armedAtMs: nowMs }
      : { channelId, messageId, armedAtMs: nowMs };
  }
  const same =
    current.channelId !== null && uuidEq(current.channelId, channelId);
  const sameCard =
    same &&
    messageId !== undefined &&
    current.messageId !== undefined &&
    uuidEq(current.messageId, messageId);
  return sameCard
    ? { channelId: current.channelId, messageId, armedAtMs: nowMs }
    : { channelId: same ? current.channelId : null, armedAtMs: nowMs };
}

/**
 * The route to land on, or null when nothing was armed or the arm has expired.
 * Several channels land on the mentions inbox — the honest "more than one thing
 * happened" destination.
 */
export function openTarget(
  armed: ArmedOpen | null,
  nowMs: number,
  ttlMs: number = OPEN_ARM_TTL_MS
): string | null {
  if (armed === null) return null;
  if (nowMs - armed.armedAtMs > ttlMs) return null;
  if (armed.channelId === null) return "/inbox?filter=mentions";
  if (armed.messageId !== undefined) {
    // `inbox/anchor.messageAnchorPath`와 같은 주소다(`?msg=`, 소문자 id). 웹의 헬퍼를
    // 코어가 부를 수 없어 모양만 같다 — 시험이 둘의 일치를 묶는다.
    return `/c/${encodeURIComponent(armed.channelId)}?msg=${encodeURIComponent(
      armed.messageId.toLowerCase()
    )}`;
  }
  return `/c/${armed.channelId}`;
}
