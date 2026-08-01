import { describe, expect, it } from "vitest";
import {
  applyReactionDelta,
  chipsFor,
  clearMessageReactions,
  emptyReactions,
  normalizeReactionSnapshot,
  toggleDirection,
  QUICK_REACTIONS,
} from "./reactions";

// The two casings that meet in this module, spelled out once here so every test
// below is about the same collision the production code exists to survive: the
// reaction wire is Swift `uuidString` (UPPERCASE), the message wire is Postgres
// `id::text` (lowercase).
const MESSAGE_LOWER = "3f1a2b4c-5d6e-7f80-9a1b-2c3d4e5f6071";
const MESSAGE_UPPER = MESSAGE_LOWER.toUpperCase();
const ME_LOWER = "11111111-2222-3333-4444-555555555555";
const ME_UPPER = ME_LOWER.toUpperCase();
const OTHER_UPPER = "99999999-8888-7777-6666-555555555555";

describe("normalizeReactionSnapshot", () => {
  /**
   * The bug this module exists to prevent: the snapshot keys a message by its
   * UPPERCASE id while the timeline holds the same message under its lowercase
   * one. Without the fold, every chip in every channel silently fails to render
   * — nothing throws, nothing logs, the reactions are simply never found.
   */
  it("folds both the message ids and the member ids to lower case", () => {
    const map = normalizeReactionSnapshot({
      [MESSAGE_UPPER]: { "👍": [ME_UPPER, OTHER_UPPER] },
    });
    expect(Object.keys(map)).toEqual([MESSAGE_LOWER]);
    expect(map[MESSAGE_LOWER]["👍"]).toEqual([
      ME_LOWER,
      OTHER_UPPER.toLowerCase(),
    ]);
    // …and it is findable by the id the timeline actually holds.
    expect(chipsFor(map, MESSAGE_LOWER, ME_LOWER)).toEqual([
      { emoji: "👍", count: 2, mine: true },
    ]);
  });

  it("survives a missing, malformed or empty snapshot without throwing", () => {
    expect(normalizeReactionSnapshot(undefined)).toEqual({});
    expect(normalizeReactionSnapshot(null)).toEqual({});
    expect(normalizeReactionSnapshot({})).toEqual({});
    // An emoji with no members is a chip with a count of zero — dropped.
    expect(normalizeReactionSnapshot({ [MESSAGE_UPPER]: { "👍": [] } })).toEqual(
      {}
    );
  });

  it("keeps the server's emoji order, which is what makes chips stable", () => {
    const map = normalizeReactionSnapshot({
      [MESSAGE_UPPER]: { "✅": [ME_UPPER], "🎉": [OTHER_UPPER] },
    });
    expect(chipsFor(map, MESSAGE_LOWER, ME_LOWER).map((c) => c.emoji)).toEqual([
      "✅",
      "🎉",
    ]);
  });
});

describe("applyReactionDelta", () => {
  const add = (map = emptyReactions(), memberId = ME_UPPER) =>
    applyReactionDelta(map, {
      messageId: MESSAGE_UPPER,
      memberId,
      emoji: "👍",
      action: "added",
    });

  it("adds under the folded key, whichever casing the frame used", () => {
    const map = add();
    expect(map[MESSAGE_LOWER]["👍"]).toEqual([ME_LOWER]);
  });

  /**
   * The load-bearing property. A click applies the delta locally AND the
   * realtime echo of the very same click applies it again a moment later —
   * that is the normal path, not an edge case. A non-idempotent apply would
   * double every count the user themselves produced.
   */
  it("is idempotent in both directions and returns the SAME reference", () => {
    const once = add();
    const twice = add(once);
    expect(twice).toBe(once);

    const removed = applyReactionDelta(once, {
      messageId: MESSAGE_LOWER,
      memberId: ME_LOWER,
      emoji: "👍",
      action: "removed",
    });
    const removedAgain = applyReactionDelta(removed, {
      messageId: MESSAGE_UPPER,
      memberId: ME_UPPER,
      emoji: "👍",
      action: "removed",
    });
    expect(removedAgain).toBe(removed);
  });

  it("drops the emoji bucket, then the message, once the last member leaves", () => {
    const map = add();
    const empty = applyReactionDelta(map, {
      messageId: MESSAGE_UPPER,
      memberId: ME_UPPER,
      emoji: "👍",
      action: "removed",
    });
    expect(empty[MESSAGE_LOWER]).toBeUndefined();
    expect(chipsFor(empty, MESSAGE_LOWER, ME_LOWER)).toEqual([]);
  });

  it("keeps the other members when one of several leaves", () => {
    const map = add(add(), OTHER_UPPER);
    expect(chipsFor(map, MESSAGE_LOWER, ME_LOWER)).toEqual([
      { emoji: "👍", count: 2, mine: true },
    ]);
    const afterMine = applyReactionDelta(map, {
      messageId: MESSAGE_LOWER,
      memberId: ME_LOWER,
      emoji: "👍",
      action: "removed",
    });
    expect(chipsFor(afterMine, MESSAGE_LOWER, ME_LOWER)).toEqual([
      { emoji: "👍", count: 1, mine: false },
    ]);
  });

  it("does not disturb another message's reactions", () => {
    const other = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const map = applyReactionDelta(add(), {
      messageId: other,
      memberId: ME_UPPER,
      emoji: "🎉",
      action: "added",
    });
    expect(chipsFor(map, MESSAGE_LOWER, ME_LOWER)).toHaveLength(1);
    expect(chipsFor(map, other, ME_LOWER)).toEqual([
      { emoji: "🎉", count: 1, mine: true },
    ]);
  });
});

describe("chipsFor", () => {
  it("returns nothing for a message with no reactions, so no row is drawn", () => {
    expect(chipsFor(emptyReactions(), MESSAGE_LOWER, ME_LOWER)).toEqual([]);
  });

  it("marks `mine` only for the reacting member, case-insensitively", () => {
    const map = normalizeReactionSnapshot({
      [MESSAGE_UPPER]: { "👍": [OTHER_UPPER] },
    });
    expect(chipsFor(map, MESSAGE_UPPER, ME_UPPER)[0].mine).toBe(false);
    expect(chipsFor(map, MESSAGE_UPPER, OTHER_UPPER)[0].mine).toBe(true);
    // A signed-out / unknown viewer owns nothing.
    expect(chipsFor(map, MESSAGE_UPPER, undefined)[0].mine).toBe(false);
  });
});

describe("toggleDirection", () => {
  /**
   * Derived, never remembered: if the direction were captured when the chip
   * rendered, a reaction someone else removed in between would send the local
   * update one way and the request the other.
   */
  it("answers with the move a click should make, folding case", () => {
    const empty = emptyReactions();
    expect(toggleDirection(empty, MESSAGE_UPPER, ME_UPPER, "👍")).toBe("added");

    const mine = normalizeReactionSnapshot({
      [MESSAGE_UPPER]: { "👍": [ME_UPPER] },
    });
    expect(toggleDirection(mine, MESSAGE_LOWER, ME_LOWER, "👍")).toBe("removed");
    // Someone else's reaction is not mine to remove.
    expect(toggleDirection(mine, MESSAGE_LOWER, OTHER_UPPER, "👍")).toBe(
      "added"
    );
    // A different emoji on the same message is its own toggle.
    expect(toggleDirection(mine, MESSAGE_LOWER, ME_LOWER, "🎉")).toBe("added");
  });
});

describe("clearMessageReactions", () => {
  /**
   * The server deletes the reaction rows with the message. A tombstone that
   * kept its chips would report counts for a body nobody can read, and for rows
   * that no longer exist.
   */
  it("removes every reaction on a deleted message, whichever casing", () => {
    const map = normalizeReactionSnapshot({
      [MESSAGE_UPPER]: { "👍": [ME_UPPER] },
    });
    expect(clearMessageReactions(map, MESSAGE_UPPER)).toEqual({});
    expect(clearMessageReactions(map, MESSAGE_LOWER)).toEqual({});
  });

  it("returns the same reference when there was nothing to clear", () => {
    const map = emptyReactions();
    expect(clearMessageReactions(map, MESSAGE_LOWER)).toBe(map);
  });
});

describe("QUICK_REACTIONS", () => {
  it("is a short, unique row that fits a phone without scrolling", () => {
    expect(new Set(QUICK_REACTIONS).size).toBe(QUICK_REACTIONS.length);
    expect(QUICK_REACTIONS.length).toBeLessThanOrEqual(6);
  });
});
