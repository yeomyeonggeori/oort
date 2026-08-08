import type { PinnedMessageWire } from "../../lib/api";
import {
  absoluteDayLabel,
  dayDividerSegments,
  type DividerSegment,
} from "./divider";

// =============================================================================
// Pin state (pure). 이슈 #1112.
//
// The reaction module's shape, with **one axis removed and one added**.
//
// Removed: the member. A reaction is `(message, member, emoji)`; a pin is
// `(message)` alone, because a pin is the channel's fact rather than the
// pinner's. Two people pinning the same message produce one header row, and
// anyone in the channel may unpin — including someone who did not pin it.
// So this map is keyed by message id and holds one entry, not a list.
//
// Added: the entry carries the **message**, not just the fact that it is
// pinned. A pin's whole point is a message that is not on screen, so a store of
// ids alone would force a lookup into a timeline window that, by definition,
// usually misses.
//
// Ids are keyed lowercase, folded at the single ingest point — the same rule
// `reactions.ts` documents at length, kept here for the same reason: the wire's
// UUID casing is mixed by design (`docs/api/openapi.yaml:29-31`) and a map keyed
// by the raw string cannot find a message under its own id. The pin wire is
// lowercase today, so `fold` is currently the identity function on it; that is
// exactly why it must stay — the fold is what makes the casing stop mattering.
//
// Ordering is **not** insertion order here, unlike reactions: entries sort by
// `pinnedAtMs` descending, newest pin first, and ties break on message id so the
// order is total. A header list is read top-down and the thing someone just
// pinned is the thing being talked about; leaving the order to arrival would
// mean a cold load and a live update disagreed about the same channel.
// =============================================================================

/** One pinned message, as the header list draws it. Ids are lowercase. */
export interface PinnedMessage {
  messageId: string;
  channelId: string;
  /** The message's own seq — what a jump scrolls to. Pinning mints none. */
  seq: number;
  authorMemberId: string;
  type: string;
  state: string;
  body: string | null;
  createdAtMs: number;
  /** Where the pin came from. Not permission — anyone in the channel may unpin. */
  pinnedBy: string;
  pinnedAtMs: number;
}

/** `message id (lowercase) -> the pin`. */
export type PinMap = Record<string, PinnedMessage>;

export function emptyPins(): PinMap {
  return {};
}

function fold(id: string): string {
  return id.toLowerCase();
}

function foldEntry(wire: PinnedMessageWire): PinnedMessage {
  return {
    messageId: fold(wire.messageId),
    channelId: fold(wire.channelId),
    seq: wire.seq,
    authorMemberId: fold(wire.authorMemberId),
    type: wire.type,
    state: wire.state,
    body: wire.body ?? null,
    createdAtMs: wire.createdAtMs,
    pinnedBy: fold(wire.pinnedBy),
    pinnedAtMs: wire.pinnedAtMs,
  };
}

function isPinWire(value: unknown): value is PinnedMessageWire {
  if (!value || typeof value !== "object") return false;
  const wire = value as Record<string, unknown>;
  return (
    typeof wire.messageId === "string" &&
    typeof wire.channelId === "string" &&
    typeof wire.seq === "number" &&
    typeof wire.authorMemberId === "string" &&
    typeof wire.pinnedBy === "string" &&
    typeof wire.pinnedAtMs === "number"
  );
}

/**
 * The cold-load list, case-folded and keyed.
 *
 * Malformed entries are dropped rather than thrown on: a header list is an
 * accessory to the channel, and one bad row must not be able to take the
 * conversation down with it.
 */
export function normalizePinList(
  wire: readonly PinnedMessageWire[] | undefined | null
): PinMap {
  const map: PinMap = {};
  if (!Array.isArray(wire)) return map;
  for (const entry of wire) {
    if (!isPinWire(entry)) continue;
    const folded = foldEntry(entry);
    map[folded.messageId] = folded;
  }
  return map;
}

/**
 * Add one pin, returning a new map — or **the same reference** when the message
 * is already pinned, which lets React skip the render for the echo of one's own
 * click.
 *
 * Identity is the message id alone. A second `message.pinned` for a message
 * already in the map is a no-op even if `pinnedBy` differs, because the server
 * is unique on the message: the second pin never happened.
 */
export function applyPinned(map: PinMap, wire: PinnedMessageWire): PinMap {
  if (!isPinWire(wire)) return map;
  const entry = foldEntry(wire);
  if (map[entry.messageId]) return map;
  return { ...map, [entry.messageId]: entry };
}

/**
 * Remove one pin. Same reference when it was not there — the idempotent half of
 * the server's own contract, so the optimistic update and the realtime echo of
 * one click can both be applied.
 */
export function removePin(map: PinMap, messageId: string): PinMap {
  const key = fold(messageId);
  if (!map[key]) return map;
  const next = { ...map };
  delete next[key];
  return next;
}

/** Whether this message is pinned, for the row's action label. */
export function isPinned(map: PinMap, messageId: string): boolean {
  return map[fold(messageId)] !== undefined;
}

/**
 * The list, newest pin first. Ties break on message id so two clients that
 * received the same two pins in the same millisecond still draw the same order.
 */
export function pinList(map: PinMap): PinnedMessage[] {
  return Object.values(map).sort((a, b) => {
    if (b.pinnedAtMs !== a.pinnedAtMs) return b.pinnedAtMs - a.pinnedAtMs;
    return a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0;
  });
}

/**
 * The cap the server enforces (migration `062_message_pin.sql`, and
 * `momo_messaging::CHANNEL_PIN_LIMIT`).
 *
 * Mirrored here only so the copy that explains a refusal can name the number.
 * The client does **not** pre-check it — a client-side count would be a second
 * authority that goes stale the moment someone else pins.
 */
export const CHANNEL_PIN_LIMIT = 100;

/**
 * The action label, which flips with the state.
 *
 * Here rather than in a component because web and phone must say the same
 * words, and because it is drawn in three places (the web menu, the web sheet,
 * the phone sheet) — a label duplicated three times is a label that drifts.
 * Verb phrases, which the phone's a11y test enforces mechanically.
 */
export function pinActionLabel(pinned: boolean): string {
  return pinned ? "고정 해제하기" : "고정하기";
}

/** The header entry point's label, with the count folded in. */
export function pinListLabel(count: number): string {
  return count > 0 ? `고정 ${count}개` : "고정한 메시지";
}

/**
 * 같은 라벨이되, **셀 자격이 있을 때만 센다** (이슈 #1146 M2).
 *
 * 실패 문장을 목록 안에 세워 놓고 그 위의 제목은 「고정 3개」라고 말하면, 고친
 * 거짓말이 한 줄 위로 옮겨 간 것뿐이다. 프레임으로 들어온 셋은 실제로 고정돼
 * 있지만 그것이 **전부라는 것**은 우리가 모르는 사실이고, 「3개」는 전부라는 뜻이다.
 *
 * 아직 읽는 중일 때도 마찬가지다. 그때의 0 은 채널의 사실이 아니라 우리의 상태다.
 * 그래서 수를 아는 자격은 **끝난 읽기** 하나뿐이고, 그 밖에서는 이름만 남는다 —
 * 문은 그대로 열리고, 안에서 무슨 일이 있었는지는 안에서 말한다.
 */
export function pinListHeaderLabel(
  count: number,
  status: PinListStatus
): string {
  return status === "ready" ? pinListLabel(count) : pinListLabel(0);
}

/**
 * What a pin list says when it is empty, in two halves — the fact and what to
 * do about it.
 *
 * Split rather than one sentence because the two surfaces mount it differently:
 * the phone's `EmptyState` takes a headline and a detail as separate props, and
 * a single string handed to both printed the fact twice (measured on the
 * simulator). The web menu joins them with a space. Same shape as the ADE
 * drawer's `ADE_DRAWER_EMPTY_HEADLINE` / `_DETAIL`.
 *
 * The detail names the *action*, not the gesture: web opens the menu with `⋯`
 * and phone with a long press, so a sentence naming either would be wrong on
 * the other surface.
 */
export const PIN_LIST_EMPTY_HEADLINE = "고정한 메시지가 없습니다.";
export const PIN_LIST_EMPTY_DETAIL = "메시지 액션에서 고정하면 여기 모입니다.";

/** The body a pinned entry draws when the message has no text. */
export const PIN_EMPTY_BODY_TEXT = "내용 없는 메시지";

/**
 * What the list says when the cold read **failed** (이슈 #1146 M2).
 *
 * The empty copy above and this one describe two different worlds and must not
 * be able to stand in for each other. `PIN_LIST_EMPTY_*` is a fact about the
 * channel — nobody has pinned anything. This is a fact about *us* — we do not
 * know what is pinned. Saying the first when the second is true is the app
 * lying about the channel, and the person who reads it offline concludes their
 * pins were lost.
 *
 * Same two-piece shape as the empty copy, for the same mechanical reason: the
 * phone's `ErrorState` takes a headline and a detail as separate props, and its
 * retry affordance is the atom's own. The wording is the thread panel's
 * (「답글을 불러오지 못했습니다.」) with its noun swapped — a failed read is a
 * failed read, and this app already knows how to say it.
 */
export const PIN_LIST_FAILED_HEADLINE = "고정 목록을 불러오지 못했습니다.";
export const PIN_LIST_FAILED_DETAIL = "연결을 확인한 뒤 다시 시도하세요.";

/**
 * Where the cold read of the channel's pins stands (이슈 #1146 M2).
 *
 * Three states rather than a `failed` boolean, because two of them look
 * identical from the map alone: an empty map is what a channel with no pins and
 * a channel whose list has not arrived yet both have. The list is an accessory
 * that loads in parallel with the channel and never blocks it, so the moment
 * before it lands is real and frequent — long enough to print a sentence.
 *
 * Realtime frames are *not* gated on this. A `message.pinned` that arrives
 * while the read is in flight (or after it failed) still enters the map, so a
 * failed list can be non-empty; the surfaces state the failure alongside
 * whatever they do have rather than choosing between the two.
 */
export type PinListStatus = "loading" | "ready" | "failed";

/**
 * The word a timeline row wears when it is pinned (이슈 #1146 M3).
 *
 * ## 왜 **그리는가**
 *
 * 고정의 요점은 「이 메시지가 이 채널의 사실이다」인데, 1차에서 그 사실을 아는
 * 길은 둘뿐이었다: 헤더 목록을 열거나, 그 행의 액션 메뉴를 열어 낱말이
 * 「고정 해제하기」인지 보거나. **고정 목록에서 원본으로 점프한 직후가 특히
 * 그렇다** — 착지 틴트가 가시면 방금 고른 그 줄이 옆줄과 완전히 같아지고, 사람이
 * 확인할 수 있는 것은 자기 기억뿐이다. 목록을 만들면서 그 고리를 열어 둔 것이
 * 1차의 구멍이다.
 *
 * ## 왜 **이 자리에** 그리는가 (기존 위계 불침범)
 *
 * 행에 이미 있는 **꼬리 한 줄**에 낱말 하나로 앉는다 — 「수정됨」이 앉아 있는 그
 * 줄이고, 그 줄은 「읽기만 하는 조각들」의 자리라고 웹 R2 M6 이 이미 정해 두었다.
 * 새 띠도, 새 높이도, 새 색도 만들지 않는다.
 *
 * **accent 를 쓰지 않는다.** 이 레포의 리뷰 계보에서 accent 는 이미 여러 뜻을
 * 지고 있다 — 멘션, 인용 점프 착지 틴트, 포커스 링. 거기에 「고정됨」을 얹으면
 * 색 하나가 네 가지를 말하게 되고, 그 순간 색은 아무것도 말하지 않는다
 * (`dividerTone.ts` 가 D-2 에서 배운 것과 같은 실패 양식). 그래서 이것은
 * 「수정됨」과 같은 흐린 글자다: 강조가 아니라 **서술**이다.
 *
 * 순서도 그 규칙을 따른다 — 「수정됨」(본문에 대한 서술) 다음, 「답글 N개」(바깥
 * 스레드로 나가는 문) 앞. 안쪽에서 바깥쪽으로.
 */
export const PIN_ROW_MARK = "고정됨";

/**
 * 고정 목록 항목의 시각 도장 — **정렬 근거 그대로** (이슈 #1146 N1).
 *
 * 1차는 `createdAtMs`(메시지가 쓰인 때)를 그리면서 `pinnedAtMs`(고정된 때)로
 * 줄을 세웠다. 그래서 어제 쓴 글을 방금 고정하면 목록 맨 위에 어제 날짜가 서고,
 * 목록은 **정렬이 깨진 것처럼** 보인다 — 화면이 정렬 근거를 말하지 않으면 사람은
 * 자기가 보는 순서를 믿지 못한다. 둘 중 하나를 고쳐야 했고, 고친 쪽은 화면이다:
 * 「최근에 고정한 것이 위」는 `pinList` 가 길게 변호해 둔 판정이고(고정은 지금
 * 말하고 있는 것을 올리는 행위다), 정렬을 `createdAtMs` 로 내리면 그 판정이
 * 사라진다.
 *
 * 라벨 규칙은 새로 만들지 않고 날짜 구분선의 것을 그대로 든다 — 오늘/어제는
 * 낱말이고, 해는 다를 때만 적는다. **연도가 없던 것이 N1 의 나머지 절반이다**:
 * 채널의 고정은 해를 넘겨 남고, 「12월 31일」은 그것이 작년인지 말하지 않는다.
 *
 * 조각으로 돌려주는 이유는 구분선과 같다: 숫자에만 자릿폭 표지를 걸어야 하고,
 * 한글 음절이 함께 잡히면 「8월  5일」로 벌어진다(실측 — `divider.ts` 머리말).
 * 1차의 웹 판이 정확히 그 결함이었다(`<span data-numeric>8월 5일</span>`).
 */
export function pinStampSegments(
  pinnedAtMs: number,
  nowMs: number
): DividerSegment[] {
  return dayDividerSegments(pinnedAtMs, nowMs);
}

/**
 * 그 도장을 귀로 들을 때. **언제나 절대 날짜다.**
 *
 * 눈은 「오늘」을 읽고 보조기술은 「2026년 8월 5일에 고정」을 읽는다. 화면을
 * 되돌아볼 수 없는 사람에게 상대 표현만 남기는 것은 정보를 빼는 것이다
 * (`dayDividerLabel` 이 구분선에서 하는 것과 같은 판단, 같은 재료).
 *
 * 「…에 고정」까지 붙이는 것은 이 목록에서 날짜가 **두 가지일 수 있기** 때문이다.
 * 카드에는 쓰인 때도 고정된 때도 있을 수 있고, 낭독은 열이 없어서 어느 쪽인지
 * 위치로 알 수 없다.
 */
export function pinStampLabel(pinnedAtMs: number): string {
  return `${absoluteDayLabel(pinnedAtMs)}에 고정`;
}

/**
 * 홀로 남으면 파손으로 보이는 코드포인트들 — 연결자(ZWJ), 변이 선택자, 피부색
 * 수식자. 정규식 문자 클래스가 아니라 집합인 것은 취향이 아니다: 이것들을 한
 * 클래스에 모으면 `no-misleading-character-class` 가 정확한 이유로 붉어진다
 * (그 클래스는 「결합된 한 글자」처럼 읽히지만 실제로는 낱개를 매칭한다).
 */
const TRAILING_JOINERS = new Set([
  "\u200D",
  "\uFE0E",
  "\uFE0F",
  "\u{1F3FB}",
  "\u{1F3FC}",
  "\u{1F3FD}",
  "\u{1F3FE}",
  "\u{1F3FF}",
]);

export interface PinExcerpt {
  text: string;
  /** 본문이 없었다 — 그린 글자는 앱의 서술이지 저자의 말이 아니다. */
  empty: boolean;
}

/**
 * 한 줄이 감당할 만큼의 발췌 (이슈 #1146 N2).
 *
 * ## 왜 코어인가
 *
 * 1차는 웹과 폰이 각자 `slice` 를 적었고, **둘 다 같은 결함**을 가졌다. 잘라내는
 * 규칙이 두 벌이면 고치는 것도 두 번이고, 한 번은 잊는다. 길이(`limit`)만 각자
 * 낸다 — 320px 드롭다운과 폰 카드가 담을 수 있는 글자 수는 실제로 다르다.
 *
 * ## `slice` 가 아니라 코드포인트로 자르는 이유
 *
 * `String.prototype.slice` 는 **UTF-16 코드 단위**를 센다. BMP 밖 문자(이모지,
 * 일부 한자·고문자)는 두 단위짜리 서로게이트 쌍이라, 경계가 그 사이에 떨어지면
 * 반쪽 코드 단위가 남아 화면에 `�` 로 선다. 60자짜리 발췌 하나를 위해 사람이 쓴
 * 글을 깨뜨리는 것이고, 「발췌는 원본을 대표한다」는 이 목록의 전제를 무너뜨린다.
 * `Array.from` 은 코드포인트로 순회하므로 그 경계에 떨어지지 않는다.
 *
 * 자소(grapheme)까지 가지 **않는 것은 판단이다.** 가족 이모지(ZWJ 연결)나 국기는
 * 여러 코드포인트가 한 글자로 서고, 완전한 해법은 `Intl.Segmenter` 다 — 그런데
 * 그것은 폰의 Hermes 에서 보장되지 않는다. 대신 값싼 절반을 취한다: 자른 끝에
 * 남은 **연결자·변이 선택자·피부색 수식자**를 떨어낸다. 그것들이 혼자 남는 것이
 * 눈에 보이는 유일한 파손(허공에 뜬 ZWJ, 뒤따를 것이 없는 U+FE0F)이고, 나머지는
 * 「가족이 두 사람으로 잘렸다」 — 읽기에는 멀쩡한 글자다.
 */
export function pinExcerpt(body: string | null, limit: number): PinExcerpt {
  const text = body?.trim();
  if (!text) return { text: PIN_EMPTY_BODY_TEXT, empty: true };
  // 줄바꿈은 한 줄짜리 발췌에서 공백이다 — 안 접으면 목록이 본문의 모양을 흉내
  // 내려다 아무 모양도 못 갖는다.
  const flattened = text.replace(/\s+/g, " ");
  const points = Array.from(flattened);
  if (points.length <= limit) return { text: flattened, empty: false };
  const kept = points.slice(0, limit);
  // 한 글자는 남긴다 — 전부 떨어내고 「…」만 남는 발췌는 잘린 이모지보다 나쁘다.
  while (kept.length > 1 && TRAILING_JOINERS.has(kept[kept.length - 1])) {
    kept.pop();
  }
  return { text: `${kept.join("")}…`, empty: false };
}
