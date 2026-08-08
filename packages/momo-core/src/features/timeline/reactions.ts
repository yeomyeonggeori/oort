import type { ReactionSnapshotWire } from "../../lib/api";

// =============================================================================
// Reaction state (pure). B11.
//
// One rule shapes everything here: **ids arrive in two different casings.** The
// reaction snapshot and the reaction realtime frames carry UPPERCASE ids (the
// server builds them from Swift's `uuidString`), and some message projections
// carry lowercase ones (the ones Postgres builds with `id::text`). Keying a map
// by the raw string would mean a message's own reactions could not be found
// under the message's own id — the chips would silently never render.
//
// So this module owns exactly one decision: **everything is keyed lowercase**,
// folded at the single ingest point. Nothing downstream compares raw reaction
// ids, and `uuidEq` is not needed in the render path because the fold already
// happened.
//
// ---- 왜 서버를 고쳐서 없애지 않는가 (goal P3 1-3에서 실측하고 내린 판단) -------
//
// 이 접기를 없애려면 서버가 소문자로 통일하면 된다. 재보고 **하지 않기로** 했다.
//
// 1. 전제가 틀렸다. 이 주석의 옛 판본은 "반응만 대문자이고 다른 메시지 투영은
//    전부 소문자"라고 적고 있었다(Rust의 `interaction.rs`·`dto.rs` 주석도 같은
//    말을 한다). 실측은 반대다: Swift 서버에서 대문자가 **기본값**이다 — 응답
//    DTO에 id를 채우는 자리가 114곳, 33개 route 파일에 흩어져 있고
//    (`MessageRoutes.swift:336`·`:491`·`:2935`의 send·history·`message.new`가 전부
//    `uuidString`이다), 소문자는 Postgres가 JSON을 만든 자리와 손으로 적은
//    `.lowercased()` 64곳뿐이다. 그러니 반응 DTO만 소문자로 내리면 불일치가
//    사라지는 게 아니라 **하나 더 생긴다**: 반응만 소문자이고 나머지는 대문자인
//    와이어는 지금보다 예측하기 어렵다.
// 2. 그 혼재는 이미 **비준된 계약**이다. `docs/api/openapi.yaml:29-31`이
//    "UUID casing is mixed by design … Clients must compare UUIDs
//    case-insensitively"라고 못 박는다. 여기서 서버를 바꾸면 QA 후속 한 건이
//    스펙 문구를 무효로 만든다 — 그건 ADR이 결정할 경계 변경이지 이 배치의 몫이
//    아니다.
// 3. 대문자가 **실제로 지고 있는 짐**이 있다. `crates/momo-auth/src/realtime.rs:100`
//    은 realtime 토큰의 info 클레임을 대문자로 만드는데, 릴레이가 그 대소문자를
//    채널 이름에 그대로 굽기 때문이다. 소문자 통일은 반응 DTO 한 줄이 아니라
//    전송 계층의 채널 문자열까지 따라가는 작업이다.
// 4. 클라이언트 위험은 낮다(그래서 "못 한다"가 아니라 "지금 할 일이 아니다"이다):
//    macOS/iOS는 모든 id를 `Identifier<Tag>`의 `UUID`로 파싱하므로 대소문자에
//    면역이고(`clients/Core/.../Identifiers.swift:10-39`), 저장된 id 캐시도 없다.
//    웹은 이 fold가 **양쪽**(수신과 조회)에서 돌기 때문에 서버가 소문자로 바뀌면
//    `fold`는 그냥 항등함수가 된다.
//
// 그래서 이 접기는 남는다. 서버가 언젠가 통일하더라도 이 코드는 바뀔 필요가 없고,
// 픽스처가 대문자를 재현하는 것도 그대로 둔다 — 옛 서버와 지금 서버가 같은 화면을
// 그리는지는 계속 증명되어야 한다.
//
// Ordering is insertion order, and that is deliberate rather than incidental:
// the snapshot arrives emoji-sorted from the server's BTreeMap, so a cold load
// is stable; a newly reacted emoji appends at the end, so a chip never jumps
// position under someone's cursor while they are clicking it.
// =============================================================================

/** `message id (lowercase) -> emoji -> member ids (lowercase, insertion order)`. */
export type ReactionMap = Record<string, Record<string, string[]>>;

export function emptyReactions(): ReactionMap {
  return {};
}

function fold(id: string): string {
  return id.toLowerCase();
}

/**
 * The wire snapshot, case-folded. Empty emoji buckets are dropped: an emoji with
 * no members is a chip with a count of zero, which is a chip that should not
 * exist.
 */
export function normalizeReactionSnapshot(
  wire: ReactionSnapshotWire | undefined | null
): ReactionMap {
  const map: ReactionMap = {};
  if (!wire || typeof wire !== "object") return map;
  for (const [messageId, byEmoji] of Object.entries(wire)) {
    if (!byEmoji || typeof byEmoji !== "object") continue;
    const bucket: Record<string, string[]> = {};
    for (const [emoji, memberIds] of Object.entries(byEmoji)) {
      if (!Array.isArray(memberIds) || memberIds.length === 0) continue;
      bucket[emoji] = memberIds
        .filter((id): id is string => typeof id === "string")
        .map(fold);
    }
    if (Object.keys(bucket).length > 0) map[fold(messageId)] = bucket;
  }
  return map;
}

export interface ReactionChange {
  messageId: string;
  memberId: string;
  emoji: string;
  action: "added" | "removed";
}

/**
 * Apply one delta, returning a new map (or the same reference when nothing
 * changed — which lets React skip a render for the echo of one's own click).
 *
 * Idempotent in both directions, matching the server: adding a reaction that is
 * already there and removing one that is not are both no-ops. That is what makes
 * it safe to apply the optimistic update AND the realtime echo of the same
 * click, which is the normal case rather than the edge case.
 */
export function applyReactionDelta(
  map: ReactionMap,
  change: ReactionChange
): ReactionMap {
  const messageId = fold(change.messageId);
  const memberId = fold(change.memberId);
  const current = map[messageId]?.[change.emoji] ?? [];
  const present = current.includes(memberId);

  if (change.action === "added") {
    if (present) return map;
    return {
      ...map,
      [messageId]: {
        ...map[messageId],
        [change.emoji]: [...current, memberId],
      },
    };
  }

  if (!present) return map;
  const remaining = current.filter((id) => id !== memberId);
  const bucket = { ...map[messageId] };
  // A bucket that lost its last member is deleted rather than left empty: an
  // empty array would render as a chip with no count.
  if (remaining.length === 0) delete bucket[change.emoji];
  else bucket[change.emoji] = remaining;

  const next = { ...map };
  if (Object.keys(bucket).length === 0) delete next[messageId];
  else next[messageId] = bucket;
  return next;
}

/**
 * Drop every reaction on a message. The server deletes the rows when the
 * message is deleted, so a tombstone that kept its chips would be showing counts
 * for a body nobody can read and for rows that no longer exist.
 */
export function clearMessageReactions(
  map: ReactionMap,
  messageId: string
): ReactionMap {
  const key = fold(messageId);
  if (!map[key]) return map;
  const next = { ...map };
  delete next[key];
  return next;
}

/** One rendered chip: the emoji, how many reacted, and whether I am one. */
export interface ReactionChip {
  emoji: string;
  count: number;
  /** Drives the emphasised style AND the toggle direction of a click. */
  mine: boolean;
}

/**
 * The chips for one message, in stable order. Empty array when there are none —
 * the caller renders nothing rather than an empty row, so a message without
 * reactions keeps its original vertical rhythm.
 */
export function chipsFor(
  map: ReactionMap,
  messageId: string,
  myMemberId: string | undefined
): ReactionChip[] {
  const bucket = map[fold(messageId)];
  if (!bucket) return [];
  const mine = myMemberId ? fold(myMemberId) : undefined;
  const chips: ReactionChip[] = [];
  for (const [emoji, memberIds] of Object.entries(bucket)) {
    if (memberIds.length === 0) continue;
    chips.push({
      emoji,
      count: memberIds.length,
      mine: mine !== undefined && memberIds.includes(mine),
    });
  }
  return chips;
}

/**
 * The direction a click on this emoji should move it. Derived rather than
 * remembered so the optimistic update and the request can never disagree about
 * which way the toggle was going.
 */
export function toggleDirection(
  map: ReactionMap,
  messageId: string,
  myMemberId: string,
  emoji: string
): "added" | "removed" {
  const memberIds = map[fold(messageId)]?.[emoji] ?? [];
  return memberIds.includes(fold(myMemberId)) ? "removed" : "added";
}

/**
 * The emoji offered without opening the full picker.
 *
 * Six, and chosen for what a work channel actually says rather than for
 * coverage: acknowledged, agreed, done, thanks, celebrating, noticed. A longer
 * row would need scrolling on a phone, and a shorter one sends people into the
 * picker for the reply they make twenty times a day.
 */
export const QUICK_REACTIONS = ["👍", "✅", "🙏", "🎉", "👀", "😄"] as const;
