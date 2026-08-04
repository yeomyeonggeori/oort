import { describe, expect, it } from "vitest";
import type { Message } from "../../lib/api";
import {
  applyTombstone,
  canDeleteMessage,
  canEditMessage,
  canReactToMessage,
  canReplyToMessage,
  emptyTimeline,
  hasAnyAction,
  isStrictlyOrdered,
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

  it("offers nothing on a tombstone, its author included", () => {
    const gone = msg(1, { state: "deleted", body: undefined });
    expect(canEditMessage(gone, ME)).toBe(false);
    expect(canDeleteMessage(gone, ME)).toBe(false);
    expect(canReactToMessage(gone)).toBe(false);
    expect(canReplyToMessage(gone)).toBe(false);
    expect(canQuoteMessage(gone)).toBe(false);
    expect(
      hasAnyAction({
        reply: canReplyToMessage(gone),
        quote: canQuoteMessage(gone),
        react: canReactToMessage(gone),
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
        edit: false,
        delete: false,
      })
    ).toBe(true);
    expect(
      hasAnyAction({
        reply: false,
        quote: false,
        react: false,
        edit: false,
        delete: false,
      })
    ).toBe(false);
  });
});
