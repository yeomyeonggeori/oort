import { describe, expect, it } from "vitest";
import type { Message, QuotedMessage } from "../../lib/api";
import { payloadToMessage } from "../../lib/realtimeEvents";
import { hasAnyAction } from "./model";
import {
  canQuoteMessage,
  quoteBlockFrom,
  quoteDraftFor,
  quoteDraftStillValid,
  quoteExcerpt,
  quotedKindLabel,
  resolveQuote,
  QUOTE_DELETED_TEXT,
  QUOTE_EXCERPT_MAX_CHARS,
  QUOTE_EXCERPT_MAX_LINES,
} from "./quote";

function message(over: Partial<Message> = {}): Message {
  return {
    id: "0199aaaa-0000-7000-8000-00000000m001",
    channelId: "00000000-0000-7000-8000-000000000201",
    seq: 41,
    hlcTs: 1_785_238_400_000,
    hlcCount: 0,
    authorMemberId: "00000000-0000-7000-8000-000000000101",
    type: "text",
    body: "배포 되돌리기 절차부터 확인해 줘.",
    state: "sent",
    createdAtMs: 1_785_238_400_000,
    ...over,
  };
}

function quoted(over: Partial<QuotedMessage> = {}): QuotedMessage {
  return {
    id: "0199aaaa-0000-7000-8000-00000000m001",
    seq: 41,
    authorMemberId: "00000000-0000-7000-8000-000000000101",
    type: "text",
    body: "배포 되돌리기 절차부터 확인해 줘.",
    state: "sent",
    ...over,
  };
}

describe("quoteExcerpt", () => {
  it("keeps a short body whole and says it was not cut", () => {
    expect(quoteExcerpt("한 줄이면 그대로.")).toEqual({
      lines: ["한 줄이면 그대로."],
      truncated: false,
    });
  });

  it("drops blank lines rather than spending the two-line budget on them", () => {
    const { lines, truncated } = quoteExcerpt("첫 줄\n\n\n둘째 줄\n셋째 줄");
    expect(lines).toEqual(["첫 줄", "둘째 줄"]);
    expect(truncated).toBe(true);
  });

  it("cuts one very long line even though the line count is under the cap", () => {
    const long = "가".repeat(QUOTE_EXCERPT_MAX_CHARS + 40);
    const { lines, truncated } = quoteExcerpt(long);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveLength(QUOTE_EXCERPT_MAX_CHARS);
    expect(truncated).toBe(true);
  });

  it("never returns more lines than the cap", () => {
    const { lines } = quoteExcerpt("a\nb\nc\nd\ne");
    expect(lines.length).toBeLessThanOrEqual(QUOTE_EXCERPT_MAX_LINES);
  });

  it("has nothing to show for a body that is only whitespace", () => {
    expect(quoteExcerpt("   \n\n  ")).toEqual({ lines: [], truncated: false });
  });
});

describe("quoteBlockFrom", () => {
  it("renders a live quote with its author and excerpt", () => {
    const block = quoteBlockFrom(quoted());
    expect(block.kind).toBe("ready");
    if (block.kind !== "ready") return;
    expect(block.targetId).toBe(quoted().id);
    expect(block.targetSeq).toBe(41);
    expect(block.lines).toEqual(["배포 되돌리기 절차부터 확인해 줘."]);
    expect(block.quotesAnother).toBe(false);
    expect(block.edited).toBe(false);
  });

  /**
   * ADR-0148 규칙 3 — a deleted original leaves a tombstone, never a copy. The
   * assertion is on the SHAPE and not only on the copy: a `ready` block whose
   * lines happen to read 「삭제된 메시지」 would still offer the excerpt slot to
   * whatever body a later refactor put back in it.
   */
  it("reports a deleted original as deleted and carries no body anywhere", () => {
    const block = quoteBlockFrom(
      quoted({ state: "deleted", body: undefined, deletedAtMs: 1_785_238_500_000 })
    );
    expect(block.kind).toBe("deleted");
    expect(JSON.stringify(block)).not.toContain("배포");
  });

  it("treats a text quote with no body at all as a tombstone", () => {
    // The server omits `body` on a tombstone rather than sending an empty
    // string, so "no body" IS the deletion signal for text.
    expect(quoteBlockFrom(quoted({ body: undefined })).kind).toBe("deleted");
  });

  it("does not mistake a bodyless agent card for a deletion", () => {
    const block = quoteBlockFrom(quoted({ type: "diff", body: undefined }));
    expect(block.kind).toBe("ready");
    if (block.kind !== "ready") return;
    expect(block.lines).toEqual([quotedKindLabel("diff")]);
  });

  /**
   * ADR-0148 미결 2 — quoting an agent's long output must not drag that output's
   * rendering into the quote block. The kind is named and the reader is sent to
   * the original.
   */
  it("names the kind instead of excerpting a non-text body", () => {
    for (const type of [
      "tool_call",
      "tool_result",
      "diff",
      "artifact",
      "approval_request",
      "system",
    ] as const) {
      const dump = "{'rows': [" + "x".repeat(400) + "]}";
      const block = quoteBlockFrom(quoted({ type, body: dump }));
      expect(block.kind).toBe("ready");
      if (block.kind !== "ready") continue;
      expect(block.lines).toEqual([quotedKindLabel(type)]);
      expect(block.lines.join("")).not.toContain("xxx");
      expect(block.truncated).toBe(false);
    }
  });

  /** 규칙 4 — the second layer is a marker, and the inner id is not on the wire. */
  it("marks a quote of a quote without carrying the inner target", () => {
    const block = quoteBlockFrom(quoted({ quotesAnother: true }));
    expect(block.kind).toBe("ready");
    if (block.kind !== "ready") return;
    expect(block.quotesAnother).toBe(true);
  });

  it("follows an edit of the original, because a quote is a reference", () => {
    const block = quoteBlockFrom(
      quoted({ state: "edited", editedAtMs: 1_785_238_460_000, body: "고친 뒤 본문" })
    );
    expect(block.kind).toBe("ready");
    if (block.kind !== "ready") return;
    expect(block.edited).toBe(true);
    expect(block.lines).toEqual(["고친 뒤 본문"]);
  });
});

describe("resolveQuote", () => {
  it("is null for a message that quotes nothing", () => {
    expect(resolveQuote(message())).toBeNull();
  });

  /**
   * The red proof the packet asks for: resolving a quote must never reach the
   * network. `resolveQuote` is handed a lookup that FAILS the test if it is
   * asked for anything other than an already-loaded row, and no fetch seam
   * exists in this module at all (it takes no client, no base url).
   */
  it("uses the server-resolved quote from the page and asks the lookup for nothing", () => {
    let lookups = 0;
    const block = resolveQuote(
      { replyToId: quoted().id, replyTo: quoted() },
      () => {
        lookups += 1;
        return undefined;
      }
    );
    expect(lookups).toBe(0);
    expect(block?.kind).toBe("ready");
  });

  it("resolves a live frame against the rows already on screen", () => {
    const target = message();
    const live = payloadToMessage({
      id: "0199aaaa-0000-7000-8000-00000000m002",
      channel_id: target.channelId,
      seq: 42,
      type: "text",
      body: "그 절차 먼저 봤어.",
      author_member_id: "00000000-0000-7000-8000-000000000102",
      hlc_ts: 1_785_238_430_000,
      hlc_count: 0,
      reply_to_id: target.id,
    });
    expect(live.replyToId).toBe(target.id);
    // The frame carries no body for the quote, on purpose. `replyTo` must stay
    // absent so nothing downstream can mistake a frame for a resolved page row.
    expect(live.replyTo).toBeUndefined();

    const block = resolveQuote(live, (id) => (id === target.id ? target : undefined));
    expect(block?.kind).toBe("ready");
    if (block?.kind !== "ready") return;
    expect(block.lines).toEqual([target.body]);
  });

  it("says it cannot see the original rather than inventing one", () => {
    const block = resolveQuote(
      { replyToId: "0199aaaa-0000-7000-8000-00000000m0ff" },
      () => undefined
    );
    expect(block).toEqual({
      kind: "unresolved",
      targetId: "0199aaaa-0000-7000-8000-00000000m0ff",
      targetSeq: null,
    });
  });

  it("reports a locally-known tombstone as deleted, not as unresolved", () => {
    const gone = message({ state: "deleted", body: undefined });
    const block = resolveQuote({ replyToId: gone.id }, () => gone);
    expect(block?.kind).toBe("deleted");
  });

  /**
   * The page's resolved quote WINS over the local row. It is the newer read of
   * the same row (rebuilt per fetch), so preferring the local copy would let a
   * stale on-screen row hide an edit or a deletion the page already knows about.
   */
  it("prefers the page's resolved quote over a stale local row", () => {
    const stale = message({ body: "예전 본문" });
    const block = resolveQuote(
      { replyToId: stale.id, replyTo: quoted({ body: "서버가 아는 본문" }) },
      () => stale
    );
    expect(block?.kind).toBe("ready");
    if (block?.kind !== "ready") return;
    expect(block.lines).toEqual(["서버가 아는 본문"]);
  });
});

describe("canQuoteMessage / quoteDraftFor", () => {
  it("offers a quote on a message that is already a thread reply", () => {
    // 규칙 1 — the two devices are not exclusive, and the ADR's own example is
    // quoting one reply from inside its own thread. `canReplyToMessage` says no
    // here; quoting must not inherit that answer.
    const reply = message({ rootId: "0199aaaa-0000-7000-8000-00000000m000" });
    expect(canQuoteMessage(reply)).toBe(true);
    expect(quoteDraftFor(reply)).not.toBeNull();
  });

  it("does not offer a quote of a tombstone", () => {
    const gone = message({ state: "deleted", body: undefined });
    expect(canQuoteMessage(gone)).toBe(false);
    expect(quoteDraftFor(gone)).toBeNull();
  });

  it("builds a draft whose chip renders through the same rules as the row", () => {
    const draft = quoteDraftFor(message());
    expect(draft?.block.kind).toBe("ready");
    expect(draft?.targetSeq).toBe(41);
  });

  it("keeps a draft whose target scrolled out of the loaded window", () => {
    const draft = quoteDraftFor(message());
    expect(draft).not.toBeNull();
    if (!draft) return;
    expect(quoteDraftStillValid(draft, () => undefined)).toBe(true);
  });

  it("drops a draft whose target was deleted while it was pinned", () => {
    const draft = quoteDraftFor(message());
    expect(draft).not.toBeNull();
    if (!draft) return;
    const gone = message({ state: "deleted", body: undefined });
    expect(quoteDraftStillValid(draft, () => gone)).toBe(false);
  });
});

describe("the two devices stay separate in the action set", () => {
  it("counts quote as an action of its own", () => {
    const none = {
      reply: false,
      quote: false,
      react: false,
      pin: false,
      edit: false,
      delete: false,
    };
    expect(hasAnyAction(none)).toBe(false);
    expect(hasAnyAction({ ...none, quote: true })).toBe(true);
  });

  it("keeps our tombstone sentence out of the markdown path", () => {
    // The label is ours, not the author's, so it must not carry markup that a
    // body renderer would interpret.
    expect(QUOTE_DELETED_TEXT).not.toMatch(/[*_`[\]]/);
  });
});
