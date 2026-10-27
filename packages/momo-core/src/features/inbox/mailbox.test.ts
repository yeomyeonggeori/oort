import { describe, expect, it } from "vitest";
import type { Channel, Message, MessageAttachment, ReadState, RosterMember } from "../../lib/api";
import {
  composeMailbox,
  contextWindow,
  CONTEXT_AFTER,
  CONTEXT_BEFORE,
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
import { actorToken, resolveActorNames, type ActorNames, type FeedItem } from "./model";
import { channelLabel, makeDirectory } from "../workspace/directory";

const NOW = 1_800_000_000_000;
const SELF = "00000000-0000-7000-8000-000000000101";
const SEO = "00000000-0000-7000-8000-000000000102";
const BOT = "00000000-0000-7000-8000-000000000301";
const DM = "00000000-0000-7000-8000-000000000401";
const CH = "00000000-0000-7000-8000-000000000201";

const people: Record<string, ActorNames> = {
  [SELF]: { name: "구민수", isAgent: false },
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
    predicate: "세션 종료 허가를 요청했어요",
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
    const directory = makeDirectory([roster(SELF, "구민수")]);
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
    expect(e?.channelLabel).not.toContain("구민수");
  });
});

describe("contextWindow: 패널은 항목 메시지를 중심으로 연다(#3694)", () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ id: `m${i + 1}`, seq: i + 1 }));

  it("긴 기록에서도 항목 메시지 앞 몇 개·뒤 몇 개만 남기고 위치를 알려 준다", () => {
    const view = contextWindow(rows, { messageId: "m20", seq: 20 }, { window: true });
    expect(view.rows.map((r) => r.seq)).toEqual([16, 17, 18, 19, 20, 21, 22]);
    expect(view.rows).toHaveLength(CONTEXT_BEFORE + 1 + CONTEXT_AFTER);
    expect(view.rows[view.targetIndex]?.id).toBe("m20");
  });

  it("기록 끝·처음에 붙은 항목은 있는 만큼만 남긴다", () => {
    expect(contextWindow(rows, { messageId: "m30" }, { window: true }).rows.map((r) => r.seq))
      .toEqual([26, 27, 28, 29, 30]);
    expect(contextWindow(rows, { messageId: "m1" }, { window: true }).rows).toHaveLength(1 + CONTEXT_AFTER);
  });

  it("페이지에 항목이 없으면 자르지 않고 위치를 모른다고 말한다", () => {
    const view = contextWindow(rows, { messageId: "gone", seq: 99 }, { window: true });
    expect(view.targetIndex).toBe(-1);
    expect(view.rows).toHaveLength(30);
  });

  it("window:false(DM·스레드)는 자르지 않고 seq로도 위치를 찾는다", () => {
    const view = contextWindow(rows, { seq: 12 }, { window: false });
    expect(view.rows).toHaveLength(30);
    expect(view.targetIndex).toBe(11);
  });
});

describe("resolveActorNames: 목록과 패널이 쓰는 글쓴이 해석 한 곳(#3694)", () => {
  it("에이전트는 연결 이름이 아니라 @핸들로 부른다", () => {
    const actor = resolveActorNames(
      { kind: "agent", displayName: "grok", handle: "grokbot" },
      "알 수 없음"
    );
    expect(actorToken(actor)).toBe("@grokbot");
    expect(actor.isAgent).toBe(true);
  });

  it("사람은 이름이고, 명부에 없으면 받은 대체 문구다", () => {
    expect(
      actorToken(resolveActorNames({ kind: "human", displayName: "서연", handle: "seo" }, "x"))
    ).toBe("서연");
    expect(actorToken(resolveActorNames(null, "나간 멤버"))).toBe("나간 멤버");
  });
});

describe("글 없이 첨부만 보낸 메시지의 줄 (#4294)", () => {
  const attach = (n: number, mime = "image/jpeg"): MessageAttachment[] =>
    Array.from({ length: n }, (_, i) => ({ id: `a-${mime}-${i}`, name: `파일${i}`, mime, sizeBytes: 1000 }));
  const base = { channelId: DM, channelLabel: "서연", selfMemberId: SELF, actorFor, nowMs: NOW, readState: rs() };
  const dm = (over: Partial<Message> & { authorMemberId: string }) =>
    dmEntry({ ...base, messages: [msg({ seq: 8, body: "", attachments: attach(2), ...over })] });

  it("DM 줄은 「내용 없는 메시지」가 아니라 사진 개수로 말한다", () => {
    const e = dm({ authorMemberId: SEO });
    expect(e?.preview).toBe("사진 2장");
    expect(e?.preview).not.toContain("내용 없는");
  });

  it("내가 보낸 DM은 「나:」가 앞선다", () => {
    expect(dm({ authorMemberId: SELF })?.preview).toBe("나: 사진 2장");
  });

  it("사진과 파일이 섞이면 사진이 먼저다", () => {
    const e = dm({ authorMemberId: SEO, attachments: [...attach(1, "application/pdf"), ...attach(1)] });
    expect(e?.preview).toBe("사진 1장, 파일 1개");
  });

  it("공백뿐인 본문도 글이 없는 것이다", () => {
    expect(dm({ authorMemberId: SEO, body: "  \n " })?.preview).toBe("사진 2장");
    expect(dm({ authorMemberId: SEO, body: undefined })?.preview).toBe("사진 2장");
  });

  it("글이 있으면 글이 이긴다 (첨부는 카드가 그린다)", () => {
    expect(dm({ authorMemberId: SEO, body: "회의 자료예요" })?.preview).toBe("회의 자료예요");
  });

  it("글도 첨부도 없으면 예전 문장 그대로다", () => {
    expect(dm({ authorMemberId: SEO, body: "", attachments: [] })?.preview).toBe("내용 없는 메시지예요.");
    expect(dm({ authorMemberId: SEO, body: "" , attachments: undefined })?.preview).toBe("내용 없는 메시지예요.");
  });

  it("지워진 메시지는 클라이언트 행에 첨부가 남아 있어도 삭제됐다고 말한다", () => {
    expect(dm({ authorMemberId: SEO, state: "deleted" })?.preview).toBe("삭제된 메시지예요.");
  });

  it("멘션 줄도 같은 말을 한다", () => {
    const e = mentionEntry(
      msg({ seq: 4, authorMemberId: SEO, channelId: CH, body: "", attachments: attach(1) }),
      actorFor(SEO),
      "#workbench",
      NOW
    );
    expect(e.preview).toBe("사진 1장");
  });

  // 서버 투영 줄(`serverEntry`)은 아직 못 고친다: 서버 항목은 `message.preview` 문자열만 싣고(`InboxMessageDto`),
  // 서버가 그 문자열을 본문으로만 만든다(`make_preview(body)`). 첨부만 있는 메시지의 preview 는 빈 문자열이라
  // 줄이 「내용 없는 메시지예요.」로 떨어진다. 항목에 첨부 개수(또는 서버가 지은 문구)가 실려야 닫힌다 - 엔진 후속.
  it.todo("서버 투영 줄: 첨부만 있는 메시지는 「내용 없는 메시지예요.」가 아니라 사진·파일 개수로 말한다 (엔진: InboxMessageDto)");

  it("스레드 줄은 마지막 답글과 루트 둘 다 같은 말을 한다", () => {
    const root = msg({
      seq: 3,
      authorMemberId: SELF,
      channelId: CH,
      body: "",
      attachments: attach(3),
      thread: { reply_count: 2, last_reply_seq: 9, last_reply_at: NOW - 60_000 },
    });
    const common = { channelLabel: "#workbench", selfMemberId: SELF, actorFor, nowMs: NOW, readState: rs({ channelId: CH, lastReadSeq: 5 }) };
    const withReply = threadEntry({
      ...common,
      root,
      lastReply: msg({ seq: 9, authorMemberId: BOT, body: "", attachments: attach(1, "application/pdf") }),
    });
    expect(withReply?.preview).toBe("파일 1개");
    expect(withReply?.rootPreview).toBe("사진 3장");
    const withoutReply = threadEntry({ ...common, root, lastReply: undefined });
    expect(withoutReply?.preview).toBe("내 글에 답글 2개: 사진 3장");
  });
});
