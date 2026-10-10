import { describe, expect, it } from "vitest";
import type { Channel, Message, ReadState, RosterMember } from "../../lib/api";
import {
  composeMailbox,
  dmEntry,
  filterMailbox,
  isUnreadSeq,
  mailboxCounts,
  mentionEntry,
  parseMailboxFilter,
  taskEntry,
  threadEntry,
  type MailboxEntry,
} from "./mailbox";
import type { ActorNames, FeedItem } from "./model";
import { channelLabel, makeDirectory } from "../workspace/directory";

const NOW = 1_800_000_000_000;
const SELF = "00000000-0000-7000-8000-000000000101";
const SEO = "00000000-0000-7000-8000-000000000102";
const BOT = "00000000-0000-7000-8000-000000000301";
const DM = "00000000-0000-7000-8000-000000000401";
const CH = "00000000-0000-7000-8000-000000000201";

const people: Record<string, ActorNames> = {
  [SELF]: { name: "곽성재", isAgent: false },
  [SEO]: { name: "서연", isAgent: false },
  [BOT]: { name: "김인턴", handle: "kim-intern", isAgent: true },
};
const actorFor = (id: string): ActorNames => people[id] ?? { name: id, isAgent: false };

function msg(over: Partial<Message> & { seq: number; authorMemberId: string }): Message {
  return {
    id: `m-${over.seq}-${over.authorMemberId.slice(-3)}`,
    channelId: DM,
    hlcTs: NOW,
    hlcCount: 0,
    type: "text",
    body: `본문 ${over.seq}`,
    createdAtMs: NOW - (100 - over.seq) * 60_000,
    ...over,
  };
}

function rs(over: Partial<ReadState> = {}): ReadState {
  return {
    channelId: DM,
    lastReadSeq: 5,
    latestSeq: 8,
    unreadCount: 3,
    mentionCount: 0,
    markedUnreadBeforeSeq: null,
    ...over,
  };
}

describe("isUnreadSeq: 읽음 기준은 ADR-0178 합성 한 곳", () => {
  it("커서 다음부터 안 읽음", () => {
    expect(isUnreadSeq(rs(), 6)).toBe(true);
    expect(isUnreadSeq(rs(), 5)).toBe(false);
  });
  it("여기부터 안 읽음 표시가 커서보다 앞이면 거기부터 안 읽음", () => {
    expect(isUnreadSeq(rs({ markedUnreadBeforeSeq: 3 }), 3)).toBe(true);
    expect(isUnreadSeq(rs({ markedUnreadBeforeSeq: 3 }), 2)).toBe(false);
  });
  it("read-state가 없으면 안 읽음이라 단정하지 않는다", () => {
    expect(isUnreadSeq(undefined, 99)).toBe(false);
  });
});

describe("dmEntry", () => {
  const base = { channelId: DM, channelLabel: "서연", selfMemberId: SELF, actorFor, nowMs: NOW };

  it("상대의 마지막 말이 커서 뒤면 안 읽은 DM", () => {
    const e = dmEntry({
      ...base,
      readState: rs(),
      messages: [msg({ seq: 7, authorMemberId: SEO }), msg({ seq: 8, authorMemberId: SEO, body: "회의 어때요" })],
    });
    expect(e).toMatchObject({ kind: "dm", unread: true, unreadCount: 3, preview: "회의 어때요", seq: 8, actor: "서연" });
    expect(e?.typeLabel).toBe("DM · 서연");
  });

  it("읽은 DM도 목록에 남는다 (메일함)", () => {
    const e = dmEntry({
      ...base,
      readState: rs({ lastReadSeq: 8, unreadCount: 0 }),
      messages: [msg({ seq: 8, authorMemberId: SEO })],
    });
    expect(e).toMatchObject({ unread: false, unreadCount: 0 });
  });

  it("내가 마지막으로 말한 DM은 안 읽음이 아니고 「나:」로 구분", () => {
    const e = dmEntry({
      ...base,
      readState: rs({ lastReadSeq: 7, unreadCount: 1 }),
      messages: [msg({ seq: 8, authorMemberId: SELF, body: "네 좋아요" })],
    });
    expect(e).toMatchObject({ unread: false, preview: "나: 네 좋아요", actor: "나" });
  });

  it("스레드 답글·시스템 메시지는 대표가 되지 않는다", () => {
    const e = dmEntry({
      ...base,
      readState: rs(),
      messages: [
        msg({ seq: 7, authorMemberId: SEO, body: "진짜" }),
        msg({ seq: 8, authorMemberId: SEO, rootId: "root", body: "스레드 답" }),
        msg({ seq: 9, authorMemberId: SEO, type: "system", body: "입장" }),
      ],
    });
    expect(e?.preview).toBe("진짜");
  });

  it("메시지가 없으면 항목을 만들지 않는다", () => {
    expect(dmEntry({ ...base, readState: rs(), messages: [] })).toBeNull();
  });
});

describe("threadEntry", () => {
  const root = (over: Partial<Message> = {}): Message =>
    msg({
      seq: 3,
      authorMemberId: SELF,
      channelId: CH,
      thread: { reply_count: 2, last_reply_seq: 9, last_reply_at: NOW - 60_000 },
      ...over,
    });
  const base = { channelLabel: "#workbench", selfMemberId: SELF, actorFor, nowMs: NOW };

  it("내 글의 마지막 답글이 읽음 기준 뒤면 항목", () => {
    const e = threadEntry({
      ...base,
      root: root(),
      readState: rs({ channelId: CH, lastReadSeq: 5 }),
      lastReply: msg({ seq: 9, authorMemberId: BOT, body: "끝났어요" }),
    });
    expect(e).toMatchObject({ kind: "thread", unread: true, preview: "끝났어요", actor: "@kim-intern", rootId: root().id, seq: 9 });
  });

  it("이미 읽은 답글이면 항목이 아니다", () => {
    expect(
      threadEntry({ ...base, root: root(), readState: rs({ channelId: CH, lastReadSeq: 9 }), lastReply: undefined })
    ).toBeNull();
  });

  it("남의 글에 달린 답글은 이 모델이 모르는 사실이다", () => {
    expect(
      threadEntry({ ...base, root: root({ authorMemberId: SEO }), readState: rs({ channelId: CH }), lastReply: undefined })
    ).toBeNull();
  });

  it("마지막 답글 본문을 아직 못 받았으면 루트 본문으로 이유를 말한다", () => {
    const e = threadEntry({ ...base, root: root(), readState: rs({ channelId: CH }), lastReply: undefined });
    expect(e?.preview).toContain("답글 2개");
  });
});

describe("taskEntry", () => {
  const item = (over: Partial<FeedItem> = {}): FeedItem => ({
    key: "approval:a1",
    kind: "approval",
    tone: "warn",
    actor: "@kim-intern",
    actorIsAgent: true,
    predicate: "세션 종료 허가를 요청했습니다",
    outcome: null,
    outcomeTone: "muted",
    channelId: CH,
    channelLabel: "#workbench",
    timeLabel: "5분 후 만료",
    sortAtMs: NOW + 300_000,
    pending: true,
    reason: "허가 요청",
    approvalId: "a1",
    ...over,
  });
  it("결정할 수 있는 대기 승인만", () => {
    expect(taskEntry(item(), NOW)).toMatchObject({ kind: "task", unread: true });
    expect(taskEntry(item({ approvalId: undefined }), NOW)).toBeNull();
    expect(taskEntry(item({ pending: false }), NOW)).toBeNull();
  });
});

describe("composeMailbox / 필터 / 세기", () => {
  const dm = dmEntry({
    channelId: DM, channelLabel: "서연", selfMemberId: SELF, actorFor, nowMs: NOW,
    readState: rs(), messages: [msg({ seq: 8, authorMemberId: SEO })],
  }) as MailboxEntry;
  const mention = (channelId: string, id: string): MailboxEntry =>
    mentionEntry(msg({ seq: 4, authorMemberId: SEO, channelId, id }), actorFor(SEO), "#workbench", NOW);
  const task = taskEntry(
    {
      key: "approval:a1", kind: "approval", tone: "warn", actor: "@kim-intern", actorIsAgent: true,
      predicate: "허가 요청", outcome: null, outcomeTone: "muted", channelId: CH, channelLabel: "#workbench",
      timeLabel: "", sortAtMs: 0, pending: true, reason: "r", approvalId: "a1",
    },
    NOW
  ) as MailboxEntry;

  const all = composeMailbox({
    dms: [dm],
    mentions: [mention(CH, "mm1"), mention(DM, "mm-dm")],
    threads: [],
    tasks: [task],
    dmChannelIds: new Set([DM.toLowerCase()]),
  });

  it("DM 채널의 멘션은 DM 항목과 이중으로 세지 않는다", () => {
    expect(all.map((e) => e.key)).toEqual(["approval:a1", "dm:" + DM, "mention:mm1"]);
  });
  it("처리할 일이 맨 앞", () => {
    expect(all[0]?.kind).toBe("task");
  });
  it("필터는 종류로 거른다", () => {
    expect(filterMailbox(all, "dm")).toHaveLength(1);
    expect(filterMailbox(all, "mention").map((e) => e.kind)).toEqual(["mention"]);
    expect(filterMailbox(all, "task")).toHaveLength(1);
    expect(filterMailbox(all, "all")).toHaveLength(3);
  });
  it("안 읽음 필터는 읽은 DM을 뺀다", () => {
    const read = { ...dm, unread: false };
    const list = composeMailbox({ dms: [read], mentions: [], threads: [], tasks: [task], dmChannelIds: new Set() });
    expect(filterMailbox(list, "unread").map((e) => e.kind)).toEqual(["task"]);
    expect(mailboxCounts(list)).toMatchObject({ all: 1, unread: 1, dm: 0, task: 1 });
  });
  it("모르는 필터 값은 전체로", () => {
    expect(parseMailboxFilter("nope")).toBe("all");
    expect(parseMailboxFilter("dm")).toBe("dm");
    expect(parseMailboxFilter(null)).toBe("all");
  });
});

describe("entryAriaLabel", () => {
  it("안 읽음은 색이 아니라 글로도 말한다", async () => {
    const { entryAriaLabel } = await import("./mailbox");
    const e = {
      key: "k", kind: "dm", channelId: DM, channelLabel: "서연", typeLabel: "DM · 서연", actor: "서연",
      actorIsAgent: false, preview: "안녕", atMs: NOW, timeLabel: "방금", unread: true, unreadCount: 3, reason: "r",
    } as MailboxEntry;
    expect(entryAriaLabel(e)).toBe("안 읽음 3개, DM · 서연, 서연, 방금, 안녕");
    expect(entryAriaLabel({ ...e, unread: false })).toBe("DM · 서연, 서연, 방금, 안녕");
  });
});

// #3675 / #3676: 은퇴·정지된 에이전트와의 DM. 명부(활성 멤버만)에서 상대가 빠져도 인박스는
// 대화 이름을 지어내지 않고, 마지막 말이 내 것이면 「나」가 보낸 사람일 뿐 대화 이름이 되지 않는다.
describe("dmEntry · 명부에서 빠진 상대", () => {
  const GONE = "00000000-0000-7000-8000-0000000009ff";
  const dmChannel = {
    id: DM,
    workspaceId: "w",
    kind: "dm",
    muted: false,
    memberIds: [SELF, GONE],
  } as Channel;
  const roster = (id: string, name: string) =>
    ({
      id,
      workspaceId: "w",
      kind: "human",
      status: "active",
      displayName: name,
      handle: name,
      channelCount: 0,
      channelIds: [],
      capabilities: [],
      createdAtMs: 0,
      updatedAtMs: 0,
    }) as RosterMember;

  it("부제는 「DM · 나간 멤버」이고 「다이렉트 메시지」가 아니다", () => {
    const directory = makeDirectory([roster(SELF, "곽성재")]);
    const e = dmEntry({
      channelId: DM,
      channelLabel: channelLabel(dmChannel, directory, SELF),
      readState: rs(),
      messages: [msg({ seq: 3, authorMemberId: SELF, body: "ㅎㅇ" })],
      selfMemberId: SELF,
      actorFor,
      nowMs: NOW,
    });
    expect(e?.typeLabel).toBe("DM · 나간 멤버");
    expect(e?.channelLabel).toBe("나간 멤버");
    expect(e?.typeLabel).not.toContain("다이렉트 메시지");
    // 「나」는 마지막 말을 한 사람이다. 대화 이름이 자기 자신으로 떨어진 것이 아니다.
    expect(e?.actor).toBe("나");
    expect(e?.channelLabel).not.toContain("곽성재");
  });
});
