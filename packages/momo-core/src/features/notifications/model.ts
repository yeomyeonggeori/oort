import { uuidEq, type Message } from "../../lib/api";
import { payloadToMessage, type MessageNewEvent } from "../../lib/realtimeEvents";
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
//   - only inside the desktop shell (a browser tab notifies about nothing);
//   - only for the two events that are addressed to a person — a mention the
//     SERVER recorded, and an approval request waiting on a human decision;
//   - never when the window already has focus (zero-noise: the message is on
//     screen, or one keystroke away);
//   - never twice for the same message, never for one's own writing, never for
//     a channel the server says is muted, and never for a burst replayed by a
//     reconnect long after the fact.
//
// The copy is deliberately thin: sender as the title, one truncated line as the
// body. Code and secret-shaped tokens are replaced rather than forwarded — a
// notification is rendered by the OS, is retained by the notification centre,
// and is visible to anyone glancing at the screen.
// =============================================================================

export type NotifyKind = "mention" | "approval";

/** Why nothing was shown. Every value is a rule someone can argue with. */
export type NotifySkip =
  /** No desktop shell underneath: the web build stays silent by contract. */
  | "browser"
  /** Ordinary channel traffic — not addressed to this member. */
  | "not-notifiable"
  /** An edit is not news; the original already had its chance. */
  | "edited"
  /** One's own message, echoed back by the rail. */
  | "self"
  /** The server's per-member mute for this channel. */
  | "muted"
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
  selfMemberId: string
): NotifyKind | null {
  if (message.state === "deleted") return null;
  if (message.type === "approval_request") {
    const card = agentCardModel(message);
    if (card?.kind === "approval" && card.status === "pending") return "approval";
  }
  if (mentionsMember(message, selfMemberId)) return "mention";
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

export interface NotifyContext {
  /** Running inside the Tauri shell. False = the whole feature is off. */
  isDesktop: boolean;
  /** The momo window has focus right now. */
  windowFocused: boolean;
  selfMemberId: string;
  /** Server per-member mute for a channel (Channel.muted). */
  isMuted: (channelId: string) => boolean;
  /** Message ids already announced this run. */
  isAnnounced: (messageId: string) => boolean;
  /** Sender as a display token: `@handle` for agents, the name for people. */
  actorFor: (memberId: string) => string;
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
  const kind = notifiableKind(message, context.selfMemberId);
  if (kind === null) return { show: false, skip: "not-notifiable" };
  if (uuidEq(message.authorMemberId, context.selfMemberId)) {
    return { show: false, skip: "self" };
  }
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
  if (context.windowFocused) return { show: false, skip: "focused" };

  const notification: DesktopNotification = {
    kind,
    messageId: message.id,
    channelId: message.channelId,
    title: context.actorFor(message.authorMemberId),
  };
  const body = notificationBody(approvalTitle(message, kind) ?? message.body);
  if (body !== undefined) notification.body = body;
  return { show: true, notification };
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
  ttlMs: number = OPEN_ARM_TTL_MS
): ArmedOpen {
  const live = current !== null && nowMs - current.armedAtMs <= ttlMs;
  if (!live) return { channelId, armedAtMs: nowMs };
  const same =
    current.channelId !== null && uuidEq(current.channelId, channelId);
  return { channelId: same ? current.channelId : null, armedAtMs: nowMs };
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
  return `/c/${armed.channelId}`;
}
