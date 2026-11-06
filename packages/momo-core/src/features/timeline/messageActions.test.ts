import { describe, expect, it } from "vitest";
import type { Message } from "../../lib/api";
import {
  applyTombstone,
  canDeleteMessage,
  canEditMessage,
  canPinMessage,
  canReactToMessage,
  canMarkUnreadMessage,
  canRemindMessage,
  canReplyToMessage,
  emptyTimeline,
  hasAnyAction,
  isStrictlyOrdered,
  lastEditableMessage,
  reconcileMessages,
} from "./model";
import { canQuoteMessage } from "./quote";

const ME = "11111111-2222-3333-4444-555555555555";
const OTHER = "99999999-8888-7777-6666-555555555555";

function msg(seq: number, overrides: Partial<Message> = {}): Message {
  return {
    id: `0000000${seq}-0000-4000-8000-000000000000`,
    channelId: "c",
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: ME,
    type: "text",
    body: `m${seq}`,
    state: "sent",
    createdAtMs: seq,
    ...overrides,
  };
}

describe("applyTombstone", () => {
  const state = reconcileMessages(emptyTimeline(), [msg(1), msg(2), msg(3)]);

  /**
   * **The invariant.** `seq` is both the ordering authority and the recovery
   * cursor. Remove a deleted row and the timeline has a hole indistinguishable
   * from one the client failed to receive — and the next reconnect sets out to
   * heal a gap that is not a gap.
   */
  it("keeps the row and its seq, and leaves the stream strictly ordered", () => {
    const next = applyTombstone(state, msg(2).id, 1_700_000_000_000);
    expect(next.messages).toHaveLength(3);
    expect(next.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(isStrictlyOrdered(next.messages)).toBe(true);
    expect(next.oldestSeq).toBe(1);
    expect(next.newestSeq).toBe(3);
  });

  it("erases the body and stamps the row, because the frame carries no body", () => {
    const next = applyTombstone(state, msg(2).id, 1_700_000_000_000);
    const row = next.messages[1];
    expect(row.state).toBe("deleted");
    expect(row.body).toBeUndefined();
    expect(row.deletedAtMs).toBe(1_700_000_000_000);
  });

  it("matches the id case-insensitively, like every other id comparison", () => {
    const next = applyTombstone(state, msg(2).id.toUpperCase());
    expect(next.messages[1].state).toBe("deleted");
  });

  it("is a no-op for an unknown id or an already-deleted row", () => {
    expect(applyTombstone(state, "no-such-id")).toBe(state);
    const once = applyTombstone(state, msg(2).id);
    expect(applyTombstone(once, msg(2).id)).toBe(once);
  });

  it("leaves the other rows untouched", () => {
    const next = applyTombstone(state, msg(2).id);
    expect(next.messages[0].body).toBe("m1");
    expect(next.messages[2].body).toBe("m3");
  });
});

describe("action affordances", () => {
  /**
   * The server is the authority and answers 403; these decide what to *draw*.
   * Both directions matter: an action that is visible but always fails teaches
   * people to distrust the UI, and one hidden where the server would have
   * allowed it is a feature nobody finds.
   */
  it("offers 고치기/지우기 to the author alone", () => {
    const mine = msg(1);
    const theirs = msg(2, { authorMemberId: OTHER });
    expect(canEditMessage(mine, ME)).toBe(true);
    expect(canDeleteMessage(mine, ME)).toBe(true);
    expect(canEditMessage(theirs, ME)).toBe(false);
    expect(canDeleteMessage(theirs, ME)).toBe(false);
    // …and folds case, because ids arrive in two casings.
    expect(canEditMessage(mine, ME.toUpperCase())).toBe(true);
    // An unknown viewer owns nothing.
    expect(canEditMessage(mine, undefined)).toBe(false);
  });

  it("offers 반응/답글 to anyone, with no authorship gate", () => {
    const theirs = msg(1, { authorMemberId: OTHER });
    expect(canReactToMessage(theirs)).toBe(true);
    expect(canReplyToMessage(theirs)).toBe(true);
  });

  it("offers 나중에 알림 on a live message, with no authorship gate", () => {
    expect(canRemindMessage(msg(1))).toBe(true);
    expect(canRemindMessage(msg(1, { authorMemberId: OTHER }))).toBe(true);
  });

  it("offers nothing on a tombstone, its author included", () => {
    const gone = msg(1, { state: "deleted", body: undefined });
    expect(canEditMessage(gone, ME)).toBe(false);
    expect(canDeleteMessage(gone, ME)).toBe(false);
    expect(canReactToMessage(gone)).toBe(false);
    expect(canReplyToMessage(gone)).toBe(false);
    expect(canQuoteMessage(gone)).toBe(false);
    expect(canRemindMessage(gone)).toBe(false);
    expect(canMarkUnreadMessage(gone)).toBe(false);
    expect(
      hasAnyAction({
        reply: canReplyToMessage(gone),
        quote: canQuoteMessage(gone),
        react: canReactToMessage(gone),
        pin: canPinMessage(gone),
        remind: canRemindMessage(gone),
        markUnread: canMarkUnreadMessage(gone),
        edit: canEditMessage(gone, ME),
        delete: canDeleteMessage(gone, ME),
      })
    ).toBe(false);
  });

  it("offers nothing on a failed send, which has no server row behind it", () => {
    const failed = msg(1, { state: "failed" });
    expect(canEditMessage(failed, ME)).toBe(false);
    expect(canDeleteMessage(failed, ME)).toBe(false);
    expect(canReactToMessage(failed)).toBe(false);
  });

  /**
   * momo threads are one level deep, and the server refuses a `rootId` that is
   * itself a reply. Offering 답글 on a reply would be an action that always
   * fails — a reply may still be reacted to, edited and deleted.
   */
  it("does not offer 답글 on a reply, but keeps the other three", () => {
    const reply = msg(1, { rootId: "0000000a-0000-4000-8000-000000000000" });
    expect(canReplyToMessage(reply)).toBe(false);
    expect(canReactToMessage(reply)).toBe(true);
    expect(canEditMessage(reply, ME)).toBe(true);
    expect(canDeleteMessage(reply, ME)).toBe(true);
  });

  /**
   * ADR-0148 규칙 1 — 인용은 답글과 **다른 축**이다. 스레드가 한 겹인 것은
   * `root_id`의 제약이고 `reply_to_id`에는 그 제약이 없다. 그래서 답글이 막힌 행에서
   * 인용은 열려 있어야 하고, 이 단정이 그 둘을 한 예측으로 접는 리팩터를 막는다.
   */
  it("offers 인용 on a reply, where 답글 is refused", () => {
    const reply = msg(1, { rootId: "0000000a-0000-4000-8000-000000000000" });
    expect(canReplyToMessage(reply)).toBe(false);
    expect(canQuoteMessage(reply)).toBe(true);
  });

  /**
   * Only text has an editable body. A tool result or an artifact card is a
   * projection of something else, so "editing" it would edit nothing — but its
   * author may still withdraw it.
   */
  it("does not offer 고치기 on a non-text row, but still offers 지우기", () => {
    const card = msg(1, { type: "tool_result" });
    expect(canEditMessage(card, ME)).toBe(false);
    expect(canDeleteMessage(card, ME)).toBe(true);
  });

  it("hasAnyAction is true as soon as one action survives", () => {
    expect(
      hasAnyAction({
        reply: false,
        quote: false,
        react: true,
        pin: false,
        edit: false,
        delete: false,
      })
    ).toBe(true);
    expect(
      hasAnyAction({
        reply: false,
        quote: false,
        react: false,
        pin: false,
        edit: false,
        delete: false,
      })
    ).toBe(false);
  });
});

// #5191 - 빈 입력칸의 ↑ 가 고칠 메시지. 「이 대화에서 **내** 마지막 **글 있는** 고칠 수 있는 메시지」.
describe("lastEditableMessage", () => {
  const ROOT = "0000000a-0000-4000-8000-000000000000";
  const PHOTO = { id: "f1", name: "a.png", mime: "image/png", sizeBytes: 1 };

  it("returns my newest live message that has text", () => {
    const rows = [msg(1), msg(2, { authorMemberId: OTHER }), msg(3)];
    expect(lastEditableMessage(rows, ME)?.seq).toBe(3);
  });

  it("skips other people's and agents' messages, however recent", () => {
    const rows = [msg(1), msg(2, { authorMemberId: OTHER }), msg(3, { authorMemberId: OTHER })];
    expect(lastEditableMessage(rows, ME)?.seq).toBe(1);
  });

  it("skips a message with no text (attachments only): there is nothing to fix, and the editor would open empty", () => {
    const rows = [msg(1), msg(2, { body: "", attachments: [PHOTO] }), msg(3, { body: undefined, attachments: [PHOTO] })];
    expect(lastEditableMessage(rows, ME)?.seq).toBe(1);
    // A caption that is only whitespace is no text either.
    expect(lastEditableMessage([msg(1), msg(2, { body: "  \n " })], ME)?.seq).toBe(1);
  });

  it("keeps a message that has text and attachments", () => {
    const rows = [msg(1), msg(2, { attachments: [PHOTO] })];
    expect(lastEditableMessage(rows, ME)?.seq).toBe(2);
  });

  it("skips tombstones, failed sends and non-text rows", () => {
    const rows = [
      msg(1),
      msg(2, { state: "deleted", body: undefined }),
      msg(3, { state: "failed" }),
      msg(4, { type: "tool_result" }),
    ];
    expect(lastEditableMessage(rows, ME)?.seq).toBe(1);
  });

  it("keeps an already edited message editable", () => {
    expect(lastEditableMessage([msg(1), msg(2, { state: "edited" })], ME)?.seq).toBe(2);
  });

  it("is the channel's main flow by default: a thread reply is not the channel's last message", () => {
    const rows = [msg(1), msg(2, { rootId: ROOT })];
    expect(lastEditableMessage(rows, ME)?.seq).toBe(1);
  });

  // #5324 - 「대화에도 보내기」는 화면에서 빠졌다. 옛날에 켜고 보낸 답글도 스레드에만 보이므로 채널 입력칸의 ↑ 가 열면 안 되는 답글이다.
  // 판정이 그리는 규칙과 같은 한 함수(`isMainFlowRow`)여야 한다 — 서버 필드가 true 여도 본류의 행이 아니다.
  it("skips my old reply that was once sent to the conversation: it is no longer drawn in the main flow", () => {
    const rows = [msg(1), msg(2, { rootId: ROOT, alsoInChannel: true })];
    expect(lastEditableMessage(rows, ME)?.seq).toBe(1);
  });

  it("still skips thread replies of any kind when a later main-flow message is someone else's", () => {
    const rows = [msg(1), msg(2, { rootId: ROOT, alsoInChannel: true }), msg(3, { authorMemberId: OTHER })];
    expect(lastEditableMessage(rows, ME)?.seq).toBe(1);
  });

  it("returns nothing for an unknown viewer or when none of mine can be edited", () => {
    expect(lastEditableMessage([msg(1)], undefined)).toBeUndefined();
    expect(lastEditableMessage([msg(1, { authorMemberId: OTHER })], ME)).toBeUndefined();
    expect(lastEditableMessage([], ME)).toBeUndefined();
  });
});

// #5191 - 「메시지 고치기가 안 된다」 재현 표를 판정 수준에서 못 박는다. 가설 ①(첨부가 든 메시지는 `type` 이 `text` 가 아니라 고치기가
// 안 뜬다)은 거짓이었다: 클라이언트는 첨부를 `type: "text"` + `attachmentIds` 로 보내고(`sendMessage`), 서버는 보낸 `type` 을 그대로
// 저장하며(`routes/messages.rs`), 예약 보냄도 `MessageType::Text` 로 같은 길에 넣는다(`scheduler.rs`). 그래서 작성자의 글이 있는
// 메시지는 첨부·예약·답글·스레드 루트 어느 것이든 같은 판정을 지난다. 이 표가 그 사실을 고정해 첨부를 이유로 고치기를 닫는 변경이 빨갛게 한다.
describe("고치기 재현 표 (#5191)", () => {
  const PHOTO = { id: "f1", name: "lunch.png", mime: "image/png", sizeBytes: 48_000 };
  const OWN: ReadonlyArray<[string, Partial<Message>]> = [
    ["글", {}],
    ["첨부 든 글", { attachments: [PHOTO] }],
    ["첨부만(글 없음)", { body: "", attachments: [PHOTO] }],
    ["예약해서 보낸 글", { body: "예약해서 보낸 글이에요" }],
    ["답글", { rootId: "0000000a-0000-4000-8000-000000000000" }],
    ["대화에도 보낸 답글", { rootId: "0000000a-0000-4000-8000-000000000000", alsoInChannel: true }],
    ["스레드 루트", { thread: { reply_count: 2, last_reply_seq: 9, last_reply_at: 1 } }],
    ["이미 고친 글", { state: "edited", editedAtMs: 5 }],
  ];

  it.each(OWN)("내 %s: 고칠 수 있다", (_name, over) => {
    expect(canEditMessage(msg(1, over), ME)).toBe(true);
  });

  const NOT_EDITABLE: ReadonlyArray<[string, Partial<Message>]> = [
    ["남의 글", { authorMemberId: OTHER }],
    ["남의 첨부 든 글", { authorMemberId: OTHER, attachments: [PHOTO] }],
    ["에이전트 글", { authorMemberId: "cccccccc-1111-4111-8111-cccccccccccc" }],
    ["지운 글", { state: "deleted", body: undefined }],
    ["보내지 못한 글", { state: "failed" }],
    ["승인 카드", { type: "approval_request" }],
  ];

  it.each(NOT_EDITABLE)("%s: 고칠 수 없다", (_name, over) => {
    expect(canEditMessage(msg(1, over), ME)).toBe(false);
  });
});
