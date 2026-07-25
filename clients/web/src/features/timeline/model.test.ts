import { describe, expect, it } from "vitest";
import type { Message } from "@/lib/api";
import {
  AUTHOR_GROUP_WINDOW_MS,
  buildTimelineItems,
  emptyTimeline,
  isStrictlyOrdered,
  mergeMessages,
  reconcileMessages,
  startsAuthorGroup,
  type TimelineItem,
} from "./model";
import { matchMembers, mentionQueryAt } from "@/features/chat/Composer";
import type { RosterMember } from "@/lib/api";

const DAY = new Date(2026, 6, 25, 14, 0, 0).getTime();

function msg(seq: number, body = `m${seq}`, overrides: Partial<Message> = {}): Message {
  return {
    id: `id-${seq}`,
    channelId: "c",
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: "a",
    type: "text",
    body,
    state: "sent",
    createdAtMs: seq,
    ...overrides,
  };
}

describe("timeline ordering model", () => {
  it("orders a descending REST page ascending by seq", () => {
    const page = [msg(5), msg(4), msg(3), msg(2), msg(1)]; // server head order
    const state = reconcileMessages(emptyTimeline(), page);
    expect(state.messages.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(isStrictlyOrdered(state.messages)).toBe(true);
    expect(state.oldestSeq).toBe(1);
    expect(state.newestSeq).toBe(5);
  });

  it("inserts an out-of-order realtime message at its seq position", () => {
    let state = reconcileMessages(emptyTimeline(), [msg(1), msg(2), msg(4)]);
    state = reconcileMessages(state, [msg(3)]); // late arrival
    expect(state.messages.map((m) => m.seq)).toEqual([1, 2, 3, 4]);
    expect(isStrictlyOrdered(state.messages)).toBe(true);
  });

  it("dedupes duplicate seq (realtime echo of a REST row), last write wins", () => {
    let state = reconcileMessages(emptyTimeline(), [msg(1), msg(2, "orig")]);
    state = reconcileMessages(state, [msg(2, "edited")]);
    expect(state.messages.map((m) => m.seq)).toEqual([1, 2]);
    expect(state.messages[1].body).toBe("edited");
  });

  it("stays ordered when a backfill batch overlaps existing tail", () => {
    let state = reconcileMessages(emptyTimeline(), [msg(10), msg(11), msg(12)]);
    // backfill ?after=9 returns 10..15 ascending (overlap 10-12)
    state = reconcileMessages(state, [10, 11, 12, 13, 14, 15].map((s) => msg(s)));
    expect(state.messages.map((m) => m.seq)).toEqual([10, 11, 12, 13, 14, 15]);
    expect(isStrictlyOrdered(state.messages)).toBe(true);
  });

  it("keeps mergeMessages as the live-append alias", () => {
    expect(mergeMessages).toBe(reconcileMessages);
  });
});

describe("author grouping", () => {
  it("starts a group for the first message", () => {
    expect(startsAuthorGroup(undefined, msg(1))).toBe(true);
  });

  it("continues the group for the same author inside the window", () => {
    const first = msg(1, "안녕하세요", { createdAtMs: DAY });
    const second = msg(2, "확인 부탁드립니다", {
      createdAtMs: DAY + AUTHOR_GROUP_WINDOW_MS - 1,
    });
    expect(startsAuthorGroup(first, second)).toBe(false);
  });

  it("starts a new group once the 300s window is exceeded", () => {
    const first = msg(1, "배포 시작합니다", { createdAtMs: DAY });
    const second = msg(2, "배포 끝났습니다", {
      createdAtMs: DAY + AUTHOR_GROUP_WINDOW_MS + 1,
    });
    expect(startsAuthorGroup(first, second)).toBe(true);
  });

  it("starts a new group when the author changes, case-insensitively", () => {
    const human = msg(1, "로그 봐주세요", { createdAtMs: DAY, authorMemberId: "abc" });
    const sameAuthorUpper = msg(2, "네", {
      createdAtMs: DAY + 1000,
      authorMemberId: "ABC",
    });
    const agent = msg(3, "로그를 확인했습니다", {
      createdAtMs: DAY + 2000,
      authorMemberId: "def",
    });
    expect(startsAuthorGroup(human, sameAuthorUpper)).toBe(false);
    expect(startsAuthorGroup(sameAuthorUpper, agent)).toBe(true);
  });

  it("starts a new group across a day boundary", () => {
    const late = msg(1, "내일 이어서 하죠", { createdAtMs: DAY });
    const nextDay = msg(2, "이어서 시작합니다", {
      createdAtMs: new Date(2026, 6, 26, 9, 0, 0).getTime(),
    });
    expect(startsAuthorGroup(late, nextDay)).toBe(true);
  });
});

describe("timeline item stream", () => {
  const messages = [
    msg(10, "prometheus mem_limit 붙였어요", { createdAtMs: DAY }),
    msg(11, "이거 확인 좀 부탁", { createdAtMs: DAY + 1000 }),
    msg(12, "확인했습니다", {
      createdAtMs: DAY + 2000,
      authorMemberId: "hermes",
    }),
  ];

  function kinds(items: TimelineItem[]): string[] {
    return items.map((item) => item.kind);
  }

  it("emits a day divider before the first message of a day", () => {
    const items = buildTimelineItems(messages);
    expect(kinds(items)).toEqual(["day", "message", "message", "message"]);
  });

  it("places the unread divider above the first message past the cursor", () => {
    const items = buildTimelineItems(messages, {
      lastReadSeq: 10,
      unreadCount: 2,
    });
    const index = items.findIndex((item) => item.kind === "unread");
    const next = items[index + 1];
    expect(next.kind).toBe("message");
    expect(next.kind === "message" && next.message.seq).toBe(11);
  });

  it("omits the unread divider when the server reports nothing unread", () => {
    const items = buildTimelineItems(messages, { lastReadSeq: 12, unreadCount: 0 });
    expect(kinds(items)).not.toContain("unread");
  });

  it("anchors a recovery marker after the seq it recovered up to", () => {
    const items = buildTimelineItems(messages, {
      recoveryMarkers: [{ id: "r1", seq: 11, source: "backfill" }],
    });
    const index = items.findIndex((item) => item.kind === "recovery");
    const before = items[index - 1];
    expect(before.kind === "message" && before.message.seq).toBe(11);
    expect(items[index].kind === "recovery" && items[index].seq).toBe(11);
  });

  it("drops a recovery marker whose seq is below everything loaded", () => {
    const items = buildTimelineItems(messages, {
      recoveryMarkers: [{ id: "r1", seq: 1, source: "replay" }],
    });
    expect(kinds(items)).not.toContain("recovery");
  });

  it("marks author group starts on the derived stream", () => {
    const items = buildTimelineItems(messages);
    const starts = items
      .filter((item): item is Extract<TimelineItem, { kind: "message" }> =>
        item.kind === "message"
      )
      .map((item) => item.startsGroup);
    expect(starts).toEqual([true, false, true]);
  });
});

describe("mention autocomplete", () => {
  const members: RosterMember[] = [
    {
      id: "1",
      workspaceId: "w",
      kind: "human",
      status: "active",
      displayName: "곽성재",
      handle: "seongjae",
      channelCount: 1,
      channelIds: ["c"],
      capabilities: [],
      createdAtMs: 0,
      updatedAtMs: 0,
    },
    {
      id: "2",
      workspaceId: "w",
      kind: "agent",
      status: "active",
      displayName: "김인턴",
      handle: "hermes",
      channelCount: 1,
      channelIds: ["c"],
      capabilities: ["shell"],
      ownerHumanId: "1",
      createdAtMs: 0,
      updatedAtMs: 0,
    },
    {
      id: "3",
      workspaceId: "w",
      kind: "human",
      status: "suspended",
      displayName: "정지된 멤버",
      handle: "paused",
      channelCount: 0,
      channelIds: [],
      capabilities: [],
      createdAtMs: 0,
      updatedAtMs: 0,
    },
  ];

  it("detects the mention token at the caret", () => {
    const value = "배포 전에 @her";
    expect(mentionQueryAt(value, value.length)).toEqual({ start: 6, text: "her" });
  });

  it("ignores an @ in the middle of a word", () => {
    const value = "seongjae@example.com";
    expect(mentionQueryAt(value, value.length)).toBeNull();
  });

  it("closes the token once whitespace follows the @", () => {
    const value = "@hermes 로그 확인";
    expect(mentionQueryAt(value, value.length)).toBeNull();
  });

  it("matches agents and humans alike, skipping inactive members", () => {
    expect(matchMembers(members, "her").map((m) => m.handle)).toEqual(["hermes"]);
    expect(matchMembers(members, "인턴").map((m) => m.handle)).toEqual(["hermes"]);
    expect(matchMembers(members, "").map((m) => m.handle)).toEqual([
      "seongjae",
      "hermes",
    ]);
  });
});
