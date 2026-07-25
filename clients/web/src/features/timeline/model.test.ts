import { describe, expect, it } from "vitest";
import type { Message } from "@/lib/api";
import {
  AUTHOR_GROUP_WINDOW_MS,
  addPending,
  buildTimelineItems,
  confirmsPending,
  emptyChannelCopy,
  emptyTimeline,
  failPending,
  isStrictlyOrdered,
  mergeMessages,
  reconcileMessages,
  removePending,
  retryPending,
  startsAuthorGroup,
  unsettledPending,
  type PendingMessage,
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

  it("re-introduces the author on the row directly under the unread divider", () => {
    // seq 10 and 11 are the same author inside the group window, so without the
    // divider rule seq 11 renders anonymous right below "새 메시지 2개".
    expect(startsAuthorGroup(messages[0], messages[1])).toBe(false);
    const items = buildTimelineItems(messages, {
      lastReadSeq: 10,
      unreadCount: 2,
    });
    const index = items.findIndex((item) => item.kind === "unread");
    const under = items[index + 1];
    expect(under.kind === "message" && under.message.seq).toBe(11);
    expect(under.kind === "message" && under.startsGroup).toBe(true);
  });

  it("re-introduces the author on the row directly under a recovery divider", () => {
    const items = buildTimelineItems(messages, {
      recoveryMarkers: [{ id: "r1", seq: 10, source: "backfill" }],
    });
    const index = items.findIndex((item) => item.kind === "recovery");
    const under = items[index + 1];
    expect(under.kind === "message" && under.message.seq).toBe(11);
    expect(under.kind === "message" && under.startsGroup).toBe(true);
  });

  it("forces the header only on the row under the divider, not the next one", () => {
    const run = [
      msg(10, "배포 브랜치 올렸습니다", { createdAtMs: DAY }),
      msg(11, "CI 초록 뜨면 머지할게요", { createdAtMs: DAY + 1000 }),
      msg(12, "그대로 진행합니다", { createdAtMs: DAY + 2000 }),
    ];
    const items = buildTimelineItems(run, { lastReadSeq: 10, unreadCount: 2 });
    const starts = items
      .filter((item): item is Extract<TimelineItem, { kind: "message" }> =>
        item.kind === "message"
      )
      .map((item) => item.startsGroup);
    expect(starts).toEqual([true, true, false]);
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

describe("optimistic insert (M10)", () => {
  const ME = "0199aaaa-0000-7000-8000-000000000001";
  const OTHER = "0199bbbb-0000-7000-8000-000000000002";

  function pending(
    clientMsgId: string,
    body: string,
    overrides: Partial<PendingMessage> = {}
  ): PendingMessage {
    return {
      clientMsgId,
      channelId: "c",
      authorMemberId: ME,
      body,
      createdAtMs: DAY,
      sinceSeq: 10,
      status: "sending",
      ...overrides,
    };
  }

  function mine(seq: number, body: string, overrides: Partial<Message> = {}) {
    return msg(seq, body, { authorMemberId: ME, createdAtMs: DAY, ...overrides });
  }

  function pendingKeys(items: TimelineItem[]): string[] {
    return items
      .filter((item): item is Extract<TimelineItem, { kind: "pending" }> =>
        item.kind === "pending"
      )
      .map((item) => item.pending.clientMsgId);
  }

  // ---- 낙관 -> 확정 치환 ---------------------------------------------------

  it("renders the local echo at the tail while it has no seq", () => {
    const items = buildTimelineItems([mine(10, "배포 시작합니다")], {
      pending: [pending("k1", "CI 초록 뜨면 머지할게요")],
    });
    expect(items.map((i) => i.kind)).toEqual(["day", "message", "pending"]);
    expect(pendingKeys(items)).toEqual(["k1"]);
  });

  it("replaces the echo with the confirmed row once its seq arrives", () => {
    const body = "CI 초록 뜨면 머지할게요";
    const echo = pending("k1", body);
    const confirmed = [mine(10, "배포 시작합니다"), mine(11, body)];
    expect(unsettledPending(confirmed, [echo])).toEqual([]);
    const items = buildTimelineItems(confirmed, { pending: [echo] });
    expect(items.map((i) => i.kind)).toEqual(["day", "message", "message"]);
  });

  it("keeps the confirmed array strictly ordered by seq, echoes stay outside", () => {
    // The echo never gets a synthetic seq, so the invariant the seq gate
    // re-implements is untouched while a send is in flight.
    const state = reconcileMessages(emptyTimeline(), [mine(10, "a"), mine(11, "b")]);
    expect(isStrictlyOrdered(state.messages)).toBe(true);
    expect(state.newestSeq).toBe(11);
  });

  // ---- 중복 방지 ------------------------------------------------------------

  it("shows one row, not two, when the realtime frame beats the POST response", () => {
    // message.new carries no client_msg_id (MessageRoutes.broadcastPayload), so
    // the confirmed twin has to be recognised by content and seq position.
    const body = "prometheus mem_limit 붙였어요";
    const echo = pending("k1", body);
    const items = buildTimelineItems([mine(11, body)], { pending: [echo] });
    const rows = items.filter(
      (i) => i.kind === "message" || i.kind === "pending"
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("message");
  });

  it("does not let an older identical message swallow a fresh echo", () => {
    const body = "네";
    const echo = pending("k1", body, { sinceSeq: 10 });
    // seq 9 predates the send: it cannot be its echo, however identical.
    expect(confirmsPending(mine(9, body), echo)).toBe(false);
    expect(unsettledPending([mine(9, body)], [echo])).toEqual([echo]);
  });

  it("does not settle an echo against another member's identical message", () => {
    const body = "확인했습니다";
    const echo = pending("k1", body);
    expect(confirmsPending(mine(11, body, { authorMemberId: OTHER }), echo)).toBe(
      false
    );
  });

  it("settles one echo per confirmed message when the same text is sent twice", () => {
    const body = "다시 확인 부탁드립니다";
    const first = pending("k1", body);
    const second = pending("k2", body);
    expect(unsettledPending([mine(11, body)], [first, second])).toEqual([second]);
    expect(unsettledPending([mine(11, body), mine(12, body)], [first, second]))
      .toEqual([]);
  });

  it("ignores a tombstone as a confirmation", () => {
    const body = "지워진 메시지";
    const echo = pending("k1", body);
    expect(confirmsPending(mine(11, body, { state: "deleted" }), echo)).toBe(false);
  });

  // ---- 실패 전이 ------------------------------------------------------------

  it("moves a failed send to the failed row state without dropping the text", () => {
    const list = addPending([], pending("k1", "머지했습니다"));
    const failed = failPending(list, "k1");
    expect(failed[0].status).toBe("failed");
    expect(failed[0].body).toBe("머지했습니다");
    const items = buildTimelineItems([mine(10, "배포 시작합니다")], {
      pending: failed,
    });
    const row = items.find((i) => i.kind === "pending");
    expect(row?.kind === "pending" && row.pending.status).toBe("failed");
  });

  it("retries with the SAME idempotency key so a committed send is not doubled", () => {
    const list = failPending(addPending([], pending("k1", "머지했습니다")), "k1");
    const retried = retryPending(list, "k1");
    expect(retried[0].clientMsgId).toBe("k1");
    expect(retried[0].status).toBe("sending");
  });

  it("drops the echo when the send path settles it explicitly", () => {
    const list = addPending([], pending("k1", "머지했습니다"));
    expect(removePending(list, "k1")).toEqual([]);
  });

  // ---- 그룹핑 / 빈 채널 -----------------------------------------------------

  it("continues the author group when the echo follows my own recent message", () => {
    const items = buildTimelineItems([mine(10, "배포 시작합니다")], {
      pending: [pending("k1", "CI 돌려둘게요", { createdAtMs: DAY + 1000 })],
    });
    const row = items.find((i) => i.kind === "pending");
    expect(row?.kind === "pending" && row.startsGroup).toBe(false);
  });

  it("starts a group when the echo follows someone else", () => {
    const items = buildTimelineItems(
      [msg(10, "확인 부탁드립니다", { authorMemberId: OTHER, createdAtMs: DAY })],
      { pending: [pending("k1", "지금 봅니다", { createdAtMs: DAY + 1000 })] }
    );
    const row = items.find((i) => i.kind === "pending");
    expect(row?.kind === "pending" && row.startsGroup).toBe(true);
  });

  it("carries the first message of an empty channel", () => {
    const items = buildTimelineItems([], {
      pending: [pending("k1", "첫 메시지입니다", { sinceSeq: null })],
    });
    expect(items.map((i) => i.kind)).toEqual(["pending"]);
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

// A DM and a channel are empty for different reasons, so they cannot land on
// one line of copy: a 1:1 DM's participants are fixed by dmKey, so the channel
// copy would offer an action the server refuses (MOMO-611 R2 High).
describe("empty surface copy", () => {
  it("names the person and offers no invite in a DM", () => {
    const copy = emptyChannelCopy("dm", {
      displayName: "곽성재",
      kind: "human",
    });
    expect(copy.headline).toBe("곽성재님과의 대화를 시작하세요.");
    expect(copy.invitable).toBe(false);
    expect(copy.detail).not.toContain("추가");
  });

  it("frames an agent DM as work handed over, still with no invite", () => {
    const copy = emptyChannelCopy("dm", {
      displayName: "김인턴",
      kind: "agent",
    });
    expect(copy.headline).toBe("김인턴님에게 첫 일을 맡겨보세요.");
    expect(copy.invitable).toBe(false);
  });

  it("says nothing about who it is when the roster has not loaded", () => {
    const copy = emptyChannelCopy("dm", null);
    expect(copy.headline).toBe("다이렉트 메시지를 시작하세요.");
    expect(copy.invitable).toBe(false);
  });

  it("invites members in a channel, which can gain them", () => {
    for (const kind of ["public", "private", undefined] as const) {
      const copy = emptyChannelCopy(kind, null);
      expect(copy.headline).toBe("이 채널을 함께 시작하세요.");
      expect(copy.invitable).toBe(true);
    }
  });

  it("writes no em-dash into any of the four copies", () => {
    const copies = [
      emptyChannelCopy("dm", { displayName: "곽성재", kind: "human" }),
      emptyChannelCopy("dm", { displayName: "김인턴", kind: "agent" }),
      emptyChannelCopy("dm", null),
      emptyChannelCopy("public", null),
    ];
    for (const copy of copies) {
      expect(`${copy.headline}${copy.detail}`).not.toMatch(/[—–]/);
    }
  });
});
