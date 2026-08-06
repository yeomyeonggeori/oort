import { describe, expect, it } from "vitest";
import { asPinFrame, asReactionFrame } from "./realtimeEvents";

// =============================================================================
// 이슈 #1112 — the narrower is the transport's only gate.
//
// `channelRail`/`realtime` hand every publication on a channel to a cascade of
// `as*Frame` calls and act on the first that answers. So this function decides
// two things a header list depends on: that a pin frame is recognised at all,
// and that a *half* one is not. The second matters more — a dropped frame is
// repaired by the next cold load, a half-decoded one draws a broken row that
// nothing repairs.
// =============================================================================

const PINNED = {
  type: "message.pinned",
  v: 1,
  ts: 1_700_000_100_000,
  seq: 12,
  payload: {
    message_id: "11111111-0000-0000-0000-000000000001",
    channel_id: "cccccccc-0000-0000-0000-000000000001",
    seq: 12,
    author_member_id: "aaaaaaaa-0000-0000-0000-000000000001",
    type: "text",
    state: "sent",
    body: "고정할 메시지",
    created_at_ms: 1_700_000_000_000,
    pinned_by: "bbbbbbbb-0000-0000-0000-000000000001",
    pinned_at_ms: 1_700_000_100_000,
  },
};

const UNPINNED = {
  type: "message.unpinned",
  v: 1,
  ts: 1_700_000_200_000,
  seq: 12,
  payload: {
    message_id: "11111111-0000-0000-0000-000000000001",
    channel_id: "cccccccc-0000-0000-0000-000000000001",
  },
};

describe("pin frames", () => {
  it("accepts both verbs and hands back the payload the list draws", () => {
    const pinned = asPinFrame(PINNED);
    expect(pinned?.type).toBe("message.pinned");
    expect(pinned).not.toBeNull();
    if (pinned?.type === "message.pinned") {
      expect(pinned.payload.pinned_at_ms).toBe(1_700_000_100_000);
      expect(pinned.payload.seq).toBe(12);
    }
    expect(asPinFrame(UNPINNED)?.type).toBe("message.unpinned");
  });

  /**
   * The seq a pin frame carries is the **message's**, reused. If it were minted
   * the frame would advance every cursor in the workspace and a 고정 would read
   * as an unread message to everyone — the same failure the reaction frame's
   * seq rule exists to prevent.
   */
  it("names the target message's seq, not one of its own", () => {
    const frame = asPinFrame(PINNED);
    expect(frame?.seq).toBe(PINNED.payload.seq);
  });

  /**
   * The field-by-field check. Each of these, dropped, produces a row that
   * renders — badly — rather than one that is skipped: no `pinned_at_ms` sorts
   * as `undefined` and sticks to the top of the list forever.
   */
  it("refuses a pinned frame that is missing anything the list needs", () => {
    for (const key of [
      "message_id",
      "channel_id",
      "seq",
      "author_member_id",
      "pinned_by",
      "pinned_at_ms",
      "created_at_ms",
    ]) {
      const payload: Record<string, unknown> = { ...PINNED.payload };
      delete payload[key];
      expect(asPinFrame({ ...PINNED, payload })).toBeNull();
    }
    expect(asPinFrame({ ...PINNED, payload: undefined })).toBeNull();
    expect(asPinFrame({ ...UNPINNED, payload: {} })).toBeNull();
  });

  it("ignores anything that is not a pin frame", () => {
    expect(asPinFrame(undefined)).toBeNull();
    expect(asPinFrame({ type: "message.new", payload: {} })).toBeNull();
    expect(asPinFrame({ type: "reaction.added", payload: {} })).toBeNull();
  });

  /**
   * The two narrowers must not shadow each other. The transport tries them in
   * sequence and acts on the first that answers, so a pin frame that the
   * reaction narrower also accepted would be delivered to the wrong handler.
   */
  it("does not collide with the reaction narrower in either direction", () => {
    expect(asReactionFrame(PINNED)).toBeNull();
    expect(asReactionFrame(UNPINNED)).toBeNull();
    expect(
      asPinFrame({
        type: "reaction.added",
        v: 1,
        ts: 1,
        seq: 12,
        payload: {
          action: "added",
          message_id: "11111111-0000-0000-0000-000000000001",
          member_id: "bbbbbbbb-0000-0000-0000-000000000001",
          emoji: "👍",
        },
      })
    ).toBeNull();
  });
});
