import { describe, expect, it } from "vitest";
import {
  applyReactionDelta,
  AUTHOR_GROUP_WINDOW_MS,
  mentionsMember,
  mergeMessages,
  removeMessageReactions,
  startsAuthorGroup,
  type TimelineMessage,
} from "./model";

function message(
  seq: number,
  overrides: Partial<TimelineMessage> = {}
): TimelineMessage {
  return {
    id: `message-${seq}`,
    seq,
    type: "text",
    body: `본문 ${seq}`,
    authorMemberId: "MEMBER-A",
    createdAtMs: Date.UTC(2026, 6, 21, 9, 0) + seq * 1_000,
    ...overrides,
  };
}

describe("timeline grouping reducer", () => {
  it("starts the first author group", () => {
    expect(startsAuthorGroup(undefined, message(1))).toBe(true);
  });

  it("groups the same author inside the five minute window", () => {
    const first = message(1);
    const next = message(2, {
      createdAtMs: first.createdAtMs + AUTHOR_GROUP_WINDOW_MS,
    });
    expect(startsAuthorGroup(first, next)).toBe(false);
  });

  it("starts a group outside the five minute window", () => {
    const first = message(1);
    const next = message(2, {
      createdAtMs: first.createdAtMs + AUTHOR_GROUP_WINDOW_MS + 1,
    });
    expect(startsAuthorGroup(first, next)).toBe(true);
  });

  it("starts a group when the author changes", () => {
    expect(
      startsAuthorGroup(message(1), message(2, { authorMemberId: "MEMBER-B" }))
    ).toBe(true);
  });

  it("sorts by seq and replaces edited replay rows", () => {
    const result = mergeMessages(
      [message(2), message(1)],
      [message(2, { body: "수정됨", state: "edited" }), message(3)]
    );
    expect(result.map((item) => item.seq)).toEqual([1, 2, 3]);
    expect(result[1]?.body).toBe("수정됨");
  });
});

describe("mention projection", () => {
  it("matches member ids case-insensitively", () => {
    expect(
      mentionsMember({ mention_member_ids: ["member-a"] }, "MEMBER-A")
    ).toBe(true);
  });

  it("rejects a different member", () => {
    expect(
      mentionsMember({ mention_member_ids: ["member-b"] }, "member-a")
    ).toBe(false);
  });

  it("rejects malformed mention props", () => {
    expect(mentionsMember({ mention_member_ids: "member-a" }, "member-a")).toBe(
      false
    );
  });
});

describe("reaction reducer", () => {
  it("adds a member once", () => {
    const first = applyReactionDelta({}, {
      action: "added",
      messageId: "MESSAGE-1",
      memberId: "MEMBER-A",
      emoji: "👍",
    });
    const replay = applyReactionDelta(first, {
      action: "added",
      messageId: "message-1",
      memberId: "member-a",
      emoji: "👍",
    });
    expect(replay["MESSAGE-1"]?.["👍"]).toHaveLength(1);
  });

  it("removes empty emoji and message buckets", () => {
    const result = applyReactionDelta(
      { "message-1": { "👍": ["member-a"] } },
      {
        action: "removed",
        messageId: "MESSAGE-1",
        memberId: "MEMBER-A",
        emoji: "👍",
      }
    );
    expect(result).toEqual({});
  });

  it("drops all reactions when a message is deleted", () => {
    expect(
      removeMessageReactions(
        { "message-1": { "👍": ["member-a"] } },
        "MESSAGE-1"
      )
    ).toEqual({});
  });
});
