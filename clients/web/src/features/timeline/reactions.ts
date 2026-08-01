import type { ReactionSnapshotWire } from "@/lib/api";

// =============================================================================
// Reaction state (pure). B11.
//
// One rule shapes everything here: **ids arrive in two different casings.** The
// reaction snapshot and the reaction realtime frames carry UPPERCASE ids (the
// server builds them from Swift's `uuidString`), while every message projection
// carries lowercase ones (Postgres `id::text`). Keying a map by the raw string
// would mean a message's own reactions could not be found under the message's
// own id — the chips would silently never render.
//
// So this module owns exactly one decision: **everything is keyed lowercase**,
// folded at the single ingest point. Nothing downstream compares raw reaction
// ids, and `uuidEq` is not needed in the render path because the fold already
// happened.
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
