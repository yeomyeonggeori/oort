import { describe, expect, it } from "vitest";
import { threadRollup, type Message, type ThreadRollup } from "../../lib/api";
import { catalog as ko } from "../../i18n/generated/ko-KR";
import { createMessageCopy } from "../../testkit/i18n";
import { emptyTimeline, reconcileMessages } from "./model";
import {
  THREAD_FACE_MAX,
  THREAD_FACE_OVERLAP,
  THREAD_FACE_RING,
  THREAD_FACE_SIZE,
  applyThreadReadState,
  readSignalSeq,
  threadSummary,
  threadSummaryCopy,
  withLiveUnread,
} from "./threadSummary";

const ME = "00000000-0000-7000-8000-0000000000aa";
const OTHER = "00000000-0000-7000-8000-0000000000bb";
const ROOT = "0199aaaa-0000-7000-8000-000000000001";

function rollup(over: Partial<ThreadRollup> = {}): ThreadRollup {
  return {
    replyCount: 3,
    lastReplySeq: 10,
    lastReplyAtMs: 1_000,
    participantIds: ["a", "b"],
    participantCount: 2,
    ...over,
  };
}

function reply(seq: number, over: Partial<Message> = {}): Message {
  return {
    id: `0199bbbb-0000-7000-8000-${String(seq).padStart(12, "0")}`,
    channelId: "ch",
    rootId: ROOT,
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: OTHER,
    type: "text",
    body: "답글",
    state: "sent",
    createdAtMs: seq,
    ...over,
  };
}

function root(thread: Message["thread"]): Message {
  return {
    id: ROOT,
    channelId: "ch",
    seq: 1,
    hlcTs: 1,
    hlcCount: 0,
    authorMemberId: ME,
    type: "text",
    body: "루트",
    state: "sent",
    createdAtMs: 1,
    thread,
  };
}

const copyKo = createMessageCopy({ messageLocale: "ko-KR", catalog: ko });
const copyEn = createMessageCopy({ messageLocale: "en-US" });

describe("얼굴 — 최대 셋, 최근 먼저, 숫자 없음 (owner 10-31)", () => {
  it("참여자가 다섯이어도 얼굴은 서버가 준 순서 그대로 앞의 셋이다", () => {
    const summary = threadSummary(rollup({ participantIds: ["e", "d", "c", "b", "a"], participantCount: 5 }));
    expect(THREAD_FACE_MAX).toBe(3);
    expect(summary.faces).toEqual(["e", "d", "c"]);
  });

  it("4명 이상이어도 얼굴 뒤에 붙일 「+N」 같은 값을 내지 않는다", () => {
    const summary = threadSummary(rollup({ participantIds: ["e", "d", "c"], participantCount: 9 }));
    expect(Object.keys(summary).sort()).toEqual(["faces", "hasUnread", "replyCount", "unreadReplyCount"]);
  });

  it("대소문자만 다른 같은 id는 한 얼굴이고, 문자열이 아닌 항목은 건너뛴다", () => {
    const summary = threadSummary(
      rollup({ participantIds: ["A1", "a1", "", null as unknown as string, "b2"] })
    );
    expect(summary.faces).toEqual(["A1", "b2"]);
  });

  it("옛 서버(참여자 없음)는 얼굴 없이 글만 선다", () => {
    expect(threadSummary(rollup({ participantIds: undefined, participantCount: undefined })).faces).toEqual([]);
    expect(threadSummary(rollup({ participantIds: [] })).faces).toEqual([]);
  });

  it("규격 숫자는 owner가 정한 값이다: 웹 20 · 폰 22 · 겹침 6 · 링 2", () => {
    expect(THREAD_FACE_SIZE).toEqual({ web: 20, phone: 22 });
    expect(THREAD_FACE_OVERLAP).toBe(6);
    expect(THREAD_FACE_RING).toBe(2);
  });
});

describe("안 읽은 답글 — 값이 없다·0이다·양수다는 서로 다르다", () => {
  it("값이 없으면(따라가지 않는 스레드·옛 서버) 칩도 강조도 없다", () => {
    const summary = threadSummary(rollup());
    expect(summary.hasUnread).toBe(false);
    expect(threadSummaryCopy(summary, copyKo).unreadChip).toBeNull();
  });

  it("0은 「따라가고 있고 새 답글이 없다」 — 칩이 없다", () => {
    const summary = threadSummary(rollup({ unreadReplyCount: 0 }));
    expect(summary.hasUnread).toBe(false);
    expect(summary.unreadReplyCount).toBe(0);
  });

  it("양수면 강조하고 칩 글을 낸다", () => {
    const summary = threadSummary(rollup({ unreadReplyCount: 2 }));
    expect(summary.hasUnread).toBe(true);
    expect(threadSummaryCopy(summary, copyKo).unreadChip).toBe("새 답글 2");
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("깨진 값 %s 는 칩이 아니라 「말하지 않음」이다", (broken) => {
    expect(threadSummary(rollup({ unreadReplyCount: broken })).hasUnread).toBe(false);
  });
});

describe("문구 — 사전에서 나오고 시간 문구가 없다", () => {
  it("한국어: 답글 N개 · 새 답글 M · 접근성 라벨 「스레드 열기, 답글 N개(, 새 답글 M개)」", () => {
    const plain = threadSummaryCopy(threadSummary(rollup()), copyKo);
    expect(plain).toEqual({
      count: "답글 3개",
      unreadChip: null,
      open: "스레드 열기, 답글 3개",
      spoken: "답글 3개",
    });
    const unread = threadSummaryCopy(threadSummary(rollup({ unreadReplyCount: 2 })), copyKo);
    expect(unread).toEqual({
      count: "답글 3개",
      unreadChip: "새 답글 2",
      open: "스레드 열기, 답글 3개, 새 답글 2개",
      spoken: "답글 3개, 새 답글 2",
    });
  });

  it("영어: 복수형이 사전에서 갈린다", () => {
    const one = threadSummaryCopy(threadSummary(rollup({ replyCount: 1, unreadReplyCount: 1 })), copyEn);
    expect(one.count).toBe("1 reply");
    expect(one.unreadChip).toBe("1 new reply");
    expect(one.open).toBe("Open thread, 1 reply, 1 new reply");
    const many = threadSummaryCopy(threadSummary(rollup({ replyCount: 4, unreadReplyCount: 3 })), copyEn);
    expect(many.count).toBe("4 replies");
    expect(many.open).toBe("Open thread, 4 replies, 3 new replies");
  });

  it("어느 문구에도 「마지막 답글 X 전」 같은 시간 문구가 없다 — 마지막 답글이 방금이든 하루 전이든", () => {
    for (const lastReplyAtMs of [Date.now(), Date.now() - 90 * 60_000, Date.now() - 3 * 86_400_000]) {
      for (const unreadReplyCount of [undefined, 0, 4]) {
        const summary = threadSummary(rollup({ lastReplyAtMs, unreadReplyCount }));
        for (const copy of [threadSummaryCopy(summary, copyKo), threadSummaryCopy(summary, copyEn)]) {
          const all = [copy.count, copy.unreadChip ?? "", copy.open, copy.spoken].join("|");
          expect(all).not.toMatch(/마지막|분 전|시간 전|일 전|방금|ago|last|just now/i);
        }
      }
    }
  });
});

describe("withLiveUnread — 든 답글로 세므로 되쏘기에도 같은 답이다", () => {
  const base = rollup({ lastReplySeq: 10, unreadReplyCount: 1 });

  it("값이 없으면(따라가는지 모르면) 답글이 늘어도 그대로 돌려준다", () => {
    const silent = rollup({ lastReplySeq: 10 });
    expect(withLiveUnread(silent, [reply(11), reply(12)], ME)).toBe(silent);
  });

  it("머리 뒤에 온 남의 text 답글만 더한다: 내 것·지운 것·카드·머리 이전은 세지 않는다", () => {
    const replies = [
      reply(9), // 머리 이전: 서버 값에 이미 들어 있다
      reply(10), // 머리와 같다: 이미 들어 있다
      reply(11), // 센다
      reply(12, { authorMemberId: ME }), // 내 답글
      reply(13, { state: "deleted", body: undefined }), // 지운 답글
      reply(14, { type: "approval_request" }), // text 아님
      reply(15), // 센다
    ];
    expect(withLiveUnread(base, replies, ME).unreadReplyCount).toBe(3);
  });

  it("같은 답글이 두 번 배달되어도(되쏘기) 든 배열은 seq로 중복이 없어 같은 답이다", () => {
    const once = reconcileMessages(emptyTimeline(), [reply(11), reply(12)]);
    const twice = reconcileMessages(once, [reply(11), reply(12)]);
    expect(withLiveUnread(base, twice.messages, ME).unreadReplyCount).toBe(
      withLiveUnread(base, once.messages, ME).unreadReplyCount
    );
    expect(withLiveUnread(base, twice.messages, ME).unreadReplyCount).toBe(3);
  });

  it("대소문자가 다른 내 id도 내 답글이다", () => {
    expect(withLiveUnread(base, [reply(11, { authorMemberId: ME.toUpperCase() })], ME)).toBe(base);
  });
});

describe("readSignalSeq", () => {
  it("든 답글의 가장 큰 seq(지운 줄 포함)이고, 없으면 null", () => {
    expect(readSignalSeq([])).toBeNull();
    expect(readSignalSeq([reply(12), reply(11, { state: "deleted" }), reply(14, { state: "deleted" })])).toBe(14);
  });
});

describe("applyThreadReadState — 읽음 신호의 응답이 든 루트에 닿는다", () => {
  const thread = { reply_count: 3, last_reply_seq: 10, last_reply_at: 1, participant_ids: ["b"], participant_count: 1, unread_reply_count: 2 };
  const held = (extra: Message[] = []) => reconcileMessages(emptyTimeline(), [root(thread), ...extra]);

  it("따라가는 스레드: 서버가 준 값으로 맞추고 0이면 칩이 사라진다", () => {
    const state = held([reply(11), reply(12)]);
    const next = applyThreadReadState(state, ROOT, { following: true, unreadReplyCount: 0, lastReadReplySeq: 12 });
    const read = threadRollup(next.messages.find((m) => m.id === ROOT)!);
    expect(read?.unreadReplyCount).toBe(0);
    expect(threadSummary(read!).hasUnread).toBe(false);
  });

  it("비교 머리는 든 답글의 최대 seq까지 앞으로만 움직인다", () => {
    const next = applyThreadReadState(held([reply(11), reply(12)]), ROOT, { following: true, unreadReplyCount: 0 });
    expect(next.messages.find((m) => m.id === ROOT)?.thread?.last_reply_seq).toBe(12);
    // 든 답글이 더 낮으면 머리를 끌어내리지 않는다.
    const low = applyThreadReadState(held([reply(5)]), ROOT, { following: true, unreadReplyCount: 2 });
    expect(low.messages.find((m) => m.id === ROOT)?.thread?.last_reply_seq).toBe(10);
  });

  it("읽음 직후 온 답글만 다시 센다: 신호 뒤 seq 13 하나 → 칩 1", () => {
    const afterRead = applyThreadReadState(held([reply(11), reply(12)]), ROOT, { following: true, unreadReplyCount: 0 });
    const withNew = reconcileMessages(afterRead, [reply(13)]);
    const merged = threadRollup(withNew.messages.find((m) => m.id === ROOT)!)!;
    const replies = withNew.messages.filter((m) => m.rootId !== undefined);
    expect(withLiveUnread(merged, replies, ME).unreadReplyCount).toBe(1);
  });

  it("따라가지 않는 스레드(following:false)면 값을 지운다 — 값 없음이 「말하지 않음」이다", () => {
    const next = applyThreadReadState(held(), ROOT, { following: false });
    const rolled = threadRollup(next.messages.find((m) => m.id === ROOT)!);
    expect(rolled).not.toBeNull();
    expect(rolled).not.toHaveProperty("unreadReplyCount");
  });

  it("바뀐 것이 없으면 같은 참조를 돌려준다(재그림 없음)", () => {
    const state = held();
    const same = { following: true, unreadReplyCount: 2 } as const;
    expect(applyThreadReadState(state, ROOT, same)).toBe(state);
  });

  it("루트가 창 밖이거나 요약이 없거나 답글이 루트로 오면 건드리지 않는다", () => {
    const state = held();
    expect(applyThreadReadState(state, "0199ffff-0000-7000-8000-000000000009", { following: true, unreadReplyCount: 0 })).toBe(state);
    const noThread = reconcileMessages(emptyTimeline(), [root(undefined)]);
    expect(applyThreadReadState(noThread, ROOT, { following: true, unreadReplyCount: 0 })).toBe(noThread);
    const asReply = reconcileMessages(emptyTimeline(), [reply(11)]);
    expect(applyThreadReadState(asReply, asReply.messages[0].id, { following: true, unreadReplyCount: 0 })).toBe(asReply);
  });

  it("대소문자가 다른 루트 id도 같은 루트다", () => {
    const next = applyThreadReadState(held(), ROOT.toUpperCase(), { following: true, unreadReplyCount: 0 });
    expect(next.messages.find((m) => m.id === ROOT)?.thread?.unread_reply_count).toBe(0);
  });
});
