import { describe, expect, it } from "vitest";
import type { Message } from "@momo/core/lib/api";
import {
  AUTHOR_GROUP_WINDOW_MS,
  addPending,
  buildTimelineItems,
  confirmsPending,
  foldPausedNotices,
  emptyChannelCopy,
  emptyTimeline,
  EMPTY_ADD_MEMBER_ACTION_LABEL,
  EMPTY_WRITE_ACTION_LABEL,
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
} from "@momo/core/features/timeline/model";
import {
  matchMembers,
  mentionQueryAt,
} from "@/features/chat/composerAutocomplete";
import type { RosterMember } from "@momo/core/lib/api";

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

  // ---- 첨부가 붙은 echo (ADR-0151) ------------------------------------------
  //
  // 본문 대조만 남겨 두면 파일만 보내는 메시지에서 무너진다: 그 본문은 빈
  // 문자열이라, 같은 사람이 sinceSeq 위에 쓴 **아무** 빈 메시지가 어느 echo나
  // 정착시킨다. 파일 셋을 잇달아 보내면 카드가 남의 자리에 앉는다.

  const png = (id: string) => ({
    id,
    name: `${id}.png`,
    mime: "image/png",
    sizeBytes: 1024,
  });

  it("settles an attachment echo against the message carrying its own file", () => {
    const echo = pending("k1", "", { attachments: [png("att-1")] });
    expect(
      confirmsPending(mine(11, "", { attachments: [png("att-1")] }), echo)
    ).toBe(true);
  });

  it("refuses to settle an attachment echo against another file's message", () => {
    const echo = pending("k1", "", { attachments: [png("att-1")] });
    expect(
      confirmsPending(mine(11, "", { attachments: [png("att-2")] }), echo)
    ).toBe(false);
    // 첨부가 아직 안 실린 행(구 서버·다른 투영)도 이 echo 의 확정이 아니다.
    expect(confirmsPending(mine(11, ""), echo)).toBe(false);
  });

  it("settles two file-only echoes onto their own rows, not FIFO by luck", () => {
    const first = pending("k1", "", { attachments: [png("att-1")] });
    const second = pending("k2", "", { attachments: [png("att-2")] });
    // 두 번째 파일의 행만 먼저 도착했다. 그것이 첫 번째 echo 를 정착시키면 안 된다.
    expect(
      unsettledPending([mine(11, "", { attachments: [png("att-2")] })], [
        first,
        second,
      ]).map((p) => p.clientMsgId)
    ).toEqual(["k1"]);
  });

  it("settles regardless of the order the server lists the files in", () => {
    // 리뷰 M-5. 위치로 대조하면 서버가 순서를 다르게 돌려주는 날 낙관적 행이
    // 영영 확정되지 않고 같은 메시지가 두 벌로 남는다.
    const echo = pending("k1", "", { attachments: [png("att-1"), png("att-2")] });
    expect(
      confirmsPending(
        mine(11, "", { attachments: [png("att-2"), png("att-1")] }),
        echo
      )
    ).toBe(true);
  });

  it("leaves a plain text echo unchanged by the attachment rule", () => {
    const echo = pending("k1", "첨부 없이 보냅니다");
    expect(confirmsPending(mine(11, "첨부 없이 보냅니다"), echo)).toBe(true);
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
//
// 그런데 **첫 행동**은 두 표면이 같다 (#1536, 온보딩 실측 F5). 채널 분기의 유일한
// 액션이 `멤버 초대하기`였고, 그래서 첫 실행에서 사람이 첫 메시지가 아니라 초대
// 다이얼로그로 갔다. 아래 첫 두 절이 그 회귀를 잡는 자리다 — 채널의 primary가
// invite로 돌아가면 빨갛다.
describe("empty surface copy", () => {
  it("makes writing the first action in a channel, invite second", () => {
    for (const kind of ["public", "private", undefined] as const) {
      const copy = emptyChannelCopy(kind, null);
      expect(copy.surface).toBe("channel");
      expect(copy.headline).toBe("이 채널을 첫 메시지로 시작하세요.");
      expect(copy.primary).toEqual({
        kind: "write",
        label: EMPTY_WRITE_ACTION_LABEL,
      });
      expect(copy.secondary).toEqual({
        kind: "add-member",
        label: EMPTY_ADD_MEMBER_ACTION_LABEL,
      });
    }
  });

  it("names the same first act on both surfaces, from one source", () => {
    // 두 표면의 첫 행동이 같은 act이므로 문장도 하나다. 라벨을 클라마다 손으로
    // 적으면 그 둘은 조용히 갈라지고, 게이트와 캡처 레인은 둘 중 하나만 본다.
    expect(emptyChannelCopy("public", null).primary.label).toBe(
      emptyChannelCopy("dm", null).primary.label
    );
    expect(EMPTY_WRITE_ACTION_LABEL).toBe("첫 메시지 쓰기");
    expect(EMPTY_ADD_MEMBER_ACTION_LABEL).toBe("멤버 추가하기");
  });

  it("keeps 초대 out of the channel-scope action's name (#1573)", () => {
    // 한 동사=한 행위. 이 버튼이 여는 방은 「멤버 추가」 다이얼로그이고, 「초대」는
    // 워크스페이스에 새 사람을 부르는 행위의 낱말이다(다이얼로그의 빈-워크스페이스
    // 상태와 DirectoryRoute의 「멤버 초대하기」 — 둘 다 /settings로 간다). 이
    // 라벨이 초대 계열로 돌아가면, 혼자 있는 첫 사용자가 빈 채널에서 이 버튼을
    // 누르고 "다른 멤버가 없습니다" 화면에서 같은 이름의 다른 버튼을 만나는
    // 이중 의미가 재발한다(PR #1568 design-review Medium 2).
    expect(EMPTY_ADD_MEMBER_ACTION_LABEL).not.toContain("초대");
    expect(EMPTY_ADD_MEMBER_ACTION_LABEL).not.toBe("멤버 초대하기");
  });

  it("names the person and offers no invite in a DM", () => {
    const copy = emptyChannelCopy("dm", {
      displayName: "곽성재",
      kind: "human",
    });
    expect(copy.surface).toBe("dm");
    expect(copy.headline).toBe("곽성재님과의 대화를 시작하세요.");
    expect(copy.primary.kind).toBe("write");
    expect(copy.secondary).toBeNull();
    expect(copy.detail).not.toContain("추가");
  });

  it("frames an agent DM as work handed over, still with no invite", () => {
    const copy = emptyChannelCopy("dm", {
      displayName: "김인턴",
      kind: "agent",
    });
    expect(copy.headline).toBe("김인턴님에게 첫 일을 맡겨보세요.");
    expect(copy.secondary).toBeNull();
  });

  it("says nothing about who it is when the roster has not loaded", () => {
    const copy = emptyChannelCopy("dm", null);
    expect(copy.headline).toBe("다이렉트 메시지를 시작하세요.");
    expect(copy.secondary).toBeNull();
  });

  it("keeps the channel copy honest about who reads it later", () => {
    // 혼자 있는 사람이 실제로 망설이는 지점("나 혼자인데 지금 써도 되나")에 답하는
    // 문장이고, 그 답의 근거는 서버 질의다: 채널 히스토리에 가입 시각 절이 없어서
    // (momo-messaging `list_messages` / `list_channel_page`) 나중에 들어온 멤버도
    // 오늘 쓴 줄을 그대로 읽는다. 그 문장이 사라지면 남는 것은 「그냥 쓰라」는
    // 지시뿐이다.
    const copy = emptyChannelCopy("public", null);
    expect(copy.detail).toContain("나중에 들어올");
    expect(copy.detail).toContain("같은 자격");
  });

  it("writes no em-dash into any of the four copies, labels included", () => {
    // 채워 넣는 말(hype)은 여기서 다시 세지 않는다: 그 규칙의 자는
    // `scripts/design_preflight_web.sh`이고, 코어 문자열이 그 스캐너의 사정
    // 범위다. 금지어를 이 파일에 다시 적으면 그 스캐너가 **이 줄을** 위반으로
    // 집는다(실측 — hype 1건).
    const copies = [
      emptyChannelCopy("dm", { displayName: "곽성재", kind: "human" }),
      emptyChannelCopy("dm", { displayName: "김인턴", kind: "agent" }),
      emptyChannelCopy("dm", null),
      emptyChannelCopy("public", null),
    ];
    for (const copy of copies) {
      const spoken = [
        copy.headline,
        copy.detail,
        copy.primary.label,
        copy.secondary?.label ?? "",
      ].join("");
      expect(spoken).not.toMatch(/[—–]/);
    }
  });
});

// =============================================================================
// 멈춘 에이전트 알림 접기 (goal P3 1-2)
//
// 1:1 DM에서는 사람이 쓰는 모든 메시지가 상대 에이전트를 부른다. 그 에이전트가
// 멈춰 있으면 서버는 부를 때마다 시스템 한 줄을 남기므로, 다섯 번 말하면 똑같은
// 문장이 다섯 줄 쌓인다. 접는 것은 반복이지 정보가 아니라는 것을 이 블록이 잰다:
// 마지막 줄은 언제나 남고, 몇 번이었는지도 남는다.
// =============================================================================

const HUMAN = "019f94e3-7a10-79cd-9dee-208f47edd9a8";
const OTHER_HUMAN = "019f94e3-7a10-79cd-9dee-208f47edd9b9";
const AGENT = "019f94e3-8b21-7ae0-b3c4-5f1a2d6e7c90";
const PAUSED_BODY = "김인턴은(는) 현재 일시정지되어 있습니다.";

/** 사람이 쓴 한 줄. 이것이 곧 멘션이고, 알림을 부른 원인이다. */
function said(seq: number, atMs: number, author = HUMAN): Message {
  return {
    id: `msg-${seq}`,
    channelId: "c",
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: author,
    type: "text",
    body: `m${seq}`,
    state: "sent",
    createdAtMs: atMs,
  };
}

/** 서버가 남기는 「일시정지」 시스템 줄 (MessageRoutes.swift / mention.rs). */
function pausedNotice(
  seq: number,
  atMs: number,
  source: Message | null,
  agent = AGENT
): Message {
  return {
    id: `notice-${seq}`,
    channelId: "c",
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: agent,
    type: "system",
    body: PAUSED_BODY,
    props: {
      kind: "agent_paused",
      agent_member_id: agent,
      ...(source ? { source_message_id: source.id } : {}),
    },
    createdAtMs: atMs,
  };
}

/** 사람이 n번 말하고 그때마다 알림이 붙는, 정확히 신고된 그 모양. */
function pausedDm(count: number, startMs = DAY): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < count; i++) {
    const at = startMs + i * 60_000;
    const spoke = said(i * 2 + 1, at);
    out.push(spoke, pausedNotice(i * 2 + 2, at + 1_000, spoke));
  }
  return out;
}

function renderedMessages(items: TimelineItem[]): Message[] {
  return items.flatMap((item) => (item.kind === "message" ? [item.message] : []));
}

describe("paused agent notice folding", () => {
  it("접힌 알림은 마지막 하나만 남고, 그 하나가 개수를 진다", () => {
    const messages = pausedDm(3);
    const fold = foldPausedNotices(messages);

    // 앞의 두 알림(seq 2, 4)은 접히고 마지막(seq 6)만 남는다.
    expect([...fold.suppressed].sort((a, b) => a - b)).toEqual([2, 4]);
    expect(fold.repeats.get(6)).toBe(3);
    expect(fold.repeats.size).toBe(1);
  });

  it("사람이 쓴 메시지는 하나도 접지 않는다", () => {
    const messages = pausedDm(3);
    const items = buildTimelineItems(messages);
    const rendered = renderedMessages(items);

    // 사람이 세 번 말했으면 세 줄 다 그려진다. 접는 것은 알림뿐이다.
    expect(rendered.filter((m) => m.authorMemberId === HUMAN).map((m) => m.seq))
      .toEqual([1, 3, 5]);
    // 알림은 한 줄로 접히고, 그 줄이 개수를 진다.
    const notices = rendered.filter((m) => m.type === "system");
    expect(notices.map((m) => m.seq)).toEqual([6]);
    const surviving = items.find(
      (item) => item.kind === "message" && item.message.seq === 6
    );
    expect(surviving?.kind === "message" && surviving.pausedRepeat).toBe(3);
  });

  it("접힌 줄이 마지막 메시지 밑에 앉는다: 답은 가장 최근 질문 옆에 있다", () => {
    const rendered = renderedMessages(buildTimelineItems(pausedDm(5)));
    const last = rendered[rendered.length - 1];
    expect(last.type).toBe("system");
    expect(last.body).toBe(PAUSED_BODY);
    // 바로 위는 사람이 마지막으로 쓴 줄이다.
    expect(rendered[rendered.length - 2].authorMemberId).toBe(HUMAN);
  });

  it("한 번뿐인 알림은 그대로 두고 개수도 붙이지 않는다", () => {
    const messages = pausedDm(1);
    const fold = foldPausedNotices(messages);
    expect(fold.suppressed.size).toBe(0);
    expect(fold.repeats.size).toBe(0);

    const item = buildTimelineItems(messages).find(
      (i) => i.kind === "message" && i.message.type === "system"
    );
    expect(item?.kind === "message" && item.pausedRepeat).toBeUndefined();
  });

  it("사이에 에이전트가 답했으면 접지 않는다: 정지가 풀렸던 것이다", () => {
    const first = said(1, DAY);
    const second = said(4, DAY + 120_000);
    const messages: Message[] = [
      first,
      pausedNotice(2, DAY + 1_000, first),
      // 정지가 풀리고 진짜 답이 왔다.
      { ...said(3, DAY + 60_000, AGENT), body: "다시 왔습니다." },
      second,
      pausedNotice(5, DAY + 121_000, second),
    ];
    const fold = foldPausedNotices(messages);
    expect(fold.suppressed.size).toBe(0);
    expect(fold.repeats.size).toBe(0);
  });

  it("다른 사람이 부른 알림은 각자 자기 멘션 옆에 남는다", () => {
    const mine = said(1, DAY);
    const theirs = said(3, DAY + 60_000, OTHER_HUMAN);
    const messages = [
      mine,
      pausedNotice(2, DAY + 1_000, mine),
      theirs,
      pausedNotice(4, DAY + 61_000, theirs),
    ];
    const fold = foldPausedNotices(messages);
    // 접었다면 A의 알림이 B의 멘션 밑으로 끌려간다. 그건 오독이다.
    expect(fold.suppressed.size).toBe(0);
  });

  it("날이 바뀌면 접지 않는다: 날짜 구분선을 넘어갈 수 없다", () => {
    const today = said(1, DAY);
    const tomorrow = said(3, DAY + 24 * 3_600_000);
    const messages = [
      today,
      pausedNotice(2, DAY + 1_000, today),
      tomorrow,
      pausedNotice(4, DAY + 24 * 3_600_000 + 1_000, tomorrow),
    ];
    expect(foldPausedNotices(messages).suppressed.size).toBe(0);
  });

  it("대소문자가 갈린 id도 같은 에이전트로 본다", () => {
    // Swift는 UUID를 대문자로 내고 이 두 props 키만 소문자로 쓴다. 한 응답 안에서
    // 갈리는 값이므로 비교는 언제나 uuidEq다 (goal P3 1-3에서 실측한 그 계약).
    const spoke1 = said(1, DAY);
    const spoke2 = said(3, DAY + 60_000);
    const messages = [
      spoke1,
      { ...pausedNotice(2, DAY + 1_000, spoke1), authorMemberId: AGENT.toUpperCase() },
      spoke2,
      pausedNotice(4, DAY + 61_000, spoke2),
    ];
    const fold = foldPausedNotices(messages);
    expect([...fold.suppressed]).toEqual([2]);
    expect(fold.repeats.get(4)).toBe(2);
  });

  it("source_message_id가 없으면 바로 윗줄을 원인으로 본다", () => {
    // 옛 서버(그 키를 쓰기 전)나 페이지 경계에서 원인 메시지가 아직 안 실린 경우.
    const messages = [
      said(1, DAY),
      pausedNotice(2, DAY + 1_000, null),
      said(3, DAY + 60_000),
      pausedNotice(4, DAY + 61_000, null),
    ];
    const fold = foldPausedNotices(messages);
    expect([...fold.suppressed]).toEqual([2]);
    expect(fold.repeats.get(4)).toBe(2);
  });

  it("일시정지 알림이 아닌 시스템 줄은 건드리지 않는다", () => {
    const other: Message = {
      ...pausedNotice(2, DAY + 1_000, null),
      body: "채널 이름이 바뀌었습니다.",
      props: { kind: "channel_renamed" },
    };
    const messages = [said(1, DAY), other, said(3, DAY + 60_000), { ...other, id: "notice-4", seq: 4 }];
    expect(foldPausedNotices(messages).suppressed.size).toBe(0);
  });

  it("접기는 렌더에서만 일어난다: seq 배열도 커서도 그대로다", () => {
    const messages = pausedDm(3);
    const before = messages.map((m) => m.seq);
    const state = reconcileMessages(emptyTimeline(), messages);

    buildTimelineItems(messages);
    foldPausedNotices(messages);

    // 배열은 손대지 않는다: seq에 구멍이 나면 재연결이 그것을 메우러 나선다.
    expect(messages.map((m) => m.seq)).toEqual(before);
    expect(state.messages).toHaveLength(6);
    expect(state.oldestSeq).toBe(1);
    expect(state.newestSeq).toBe(6);
    expect(isStrictlyOrdered(state.messages)).toBe(true);
  });

  it("접힌 자리에 빈 날짜 구분선이나 떠 있는 헤더를 남기지 않는다", () => {
    const items = buildTimelineItems(pausedDm(3));
    // 하루짜리 대화이므로 날짜 구분선은 정확히 하나다.
    expect(items.filter((i) => i.kind === "day")).toHaveLength(1);
    expect(items[0].kind).toBe("day");
    // 첫 줄은 사람이 쓴 것이고 자기 헤더를 갖는다.
    const first = items[1];
    expect(first.kind === "message" && first.message.seq).toBe(1);
    expect(first.kind === "message" && first.startsGroup).toBe(true);
  });
});
