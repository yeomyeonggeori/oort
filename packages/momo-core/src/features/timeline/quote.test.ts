import { describe, expect, it } from "vitest";
import type { Message, QuotedMessage } from "../../lib/api";
import { payloadToMessage } from "../../lib/realtimeEvents";
import { hasRenderableBody } from "./bodySlot";
import { COMPLETION_REPORT_TITLE } from "./completionReportCard";
import { hasAnyAction } from "./model";
import {
  canQuoteMessage,
  quoteBlockFrom,
  quoteDraftFor,
  quoteDraftStillValid,
  quoteExcerpt,
  quotedKindLabel,
  resolveQuote,
  QUOTE_CARD_TEXT,
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

// =============================================================================
// #1498 — 본문이 없다는 사실이 전선에서 네 가지 모양으로 온다.
//
// 타입은 `body?: string`이라 말하지만 서버는 `"body": null`을 싣고
// (`momo_messaging::build_broadcast_payload`), 그 `null`이 이 파일까지 오는 길에
// 정규화가 한 줄도 없다: `payloadToMessage`의 `p.body ?? undefined`는 실시간 프레임
// 경로뿐이고, REST 페이지는 `isMessage`가 본문을 **보지 않은 채** 통과시켜
// (`lib/api.ts` — 검사 목록에 `body`가 없다) 와이어 객체가 그대로 행이 된다.
// #1476이 같은 값으로 타임라인을 통째로 백지화했고, 이 파일에서는 던지는 대신
// **조용히 틀렸다** — 그래서 재는 것이 크래시가 아니라 **모양**이다.
//
// 네 모양이 두 무리로 갈리는 것이 이 표의 요점이다:
//
//   부재·null   「본문이 없다」    → 묘비 (서버가 tombstone에서 본문을 뺀다)
//   ''·공백뿐    「읽을 것이 없다」 → 살아 있는 인용, 발췌만 비어 있다
//
// 아래 무리를 묘비로 접으면 화면이 **지워지지 않은 메시지를 지워졌다고** 말한다.
// 그 자리에 두 표면이 이미 다른 말을 세워 뒀다(「내용 없는 메시지」 — 웹
// `QuoteBlock.tsx`, 폰 `Quote.tsx`, 코어 `PIN_EMPTY_BODY_TEXT`).
// =============================================================================

/** 본문 칸을 와이어가 말한 그대로 만든다. `undefined`는 **키 자체가 없는** 것이다. */
function bodied<T extends object>(row: T, body: string | null | undefined): T {
  const next = { ...row } as Record<string, unknown>;
  if (body === undefined) {
    delete next.body;
  } else {
    next.body = body;
  }
  return next as T;
}

const BODY_SHAPES = [
  { name: "키 자체가 없다", body: undefined, kind: "deleted" },
  { name: "런타임 null", body: null, kind: "deleted" },
  { name: "빈 문자열", body: "", kind: "ready" },
  { name: "공백뿐", body: "   \n\t ", kind: "ready" },
] as const;

describe("#1498 — 본문 없는 인용의 네 모양", () => {
  it.each(BODY_SHAPES)("서버가 푼 인용: $name → $kind", ({ body, kind }) => {
    const block = quoteBlockFrom(bodied(quoted(), body));
    expect(block.kind).toBe(kind);
    // 살아 있는 쪽은 발췌가 비어 있을 뿐이다. 표면이 그 빈 발췌를 보고
    // 「내용 없는 메시지」라고 말한다 — 삭제라고 말하지 않는다.
    if (block.kind === "ready") expect(block.lines).toEqual([]);
  });

  /**
   * 같은 원본이 실시간으로 도착했을 때와 새로고침한 뒤에 다르게 읽히면 안 된다.
   * `quoteBlockFromLocal`이 만드는 `QuotedMessage`는 서버가 주는 것과 **같은
   * 모양**이어야 하고, 그 말은 로컬 행의 `null`도 부재로 접혀야 한다는 뜻이다.
   */
  it.each(BODY_SHAPES)(
    "화면의 행에서 푼 인용도 같은 답을 낸다: $name → $kind",
    ({ body, kind }) => {
      const draft = quoteDraftFor(bodied(message(), body));
      expect(draft).not.toBeNull();
      expect(draft?.block.kind).toBe(kind);
      // 블록에는 본문 칸 자체가 없다 — `null`이 스냅샷을 타고 표면까지 갈 길이
      // 이 경로에는 없다는 뜻이다.
      expect(JSON.stringify(draft?.block)).not.toContain("body");
    }
  );

  it("null 본문을 실은 행을 인용해도 그 null은 블록 어디에도 없다", () => {
    const block = quoteBlockFrom(bodied(quoted(), null));
    expect(block.kind).toBe("deleted");
    expect(JSON.stringify(block)).not.toContain("null");
  });

  it("종류 라벨이 있는 인용은 본문이 null이어도 묘비가 아니다", () => {
    // 카드형 메시지는 본문이 없는 것이 정상이다(#1478의 `bodyless agent card`와
    // 같은 사실). `null`이 그 판정을 뒤집으면 도구 실행 인용이 묘비로 선다.
    const block = quoteBlockFrom(bodied(quoted({ type: "diff" }), null));
    expect(block.kind).toBe("ready");
    if (block.kind !== "ready") return;
    expect(block.lines).toEqual([quotedKindLabel("diff")]);
  });

  /**
   * 「발췌가 비었다」와 코어의 「읽을 글자가 없다」는 같은 답이어야 한다. 둘이
   * 갈라지면 인용 블록만 다른 규칙으로 비고, 표면의 「내용 없는 메시지」가 본문 칸의
   * 그것과 다른 뜻이 된다. `normalizeLines`가 줄마다 `trim`하므로 지금은 같다 —
   * 이 단정이 그 일치를 못으로 박는다(`bodySlot.hasRenderableBody`, #1478).
   */
  it("발췌가 비는 자리는 `hasRenderableBody`와 같은 답이다", () => {
    for (const body of ["", "   \n\t ", "  실제 본문  ", "한 줄\n두 줄"]) {
      const block = quoteBlockFrom(quoted({ body }));
      expect(block.kind).toBe("ready");
      if (block.kind !== "ready") continue;
      expect(block.lines.length === 0).toBe(!hasRenderableBody(body));
    }
  });

  it("본문이 사라져도 삭제 신호는 여전히 삭제로 읽힌다", () => {
    // 무회귀: 진짜 묘비는 `state`와 `deletedAtMs`로도 온다. 본문 판정은 그 둘이
    // 못 온 경우의 마지막 벨트이지 그 둘의 대체가 아니다.
    for (const shape of BODY_SHAPES) {
      const block = quoteBlockFrom(
        bodied(quoted({ state: "deleted", deletedAtMs: 1_785_238_500_000 }), shape.body)
      );
      expect(block.kind).toBe("deleted");
    }
  });
});

// =============================================================================
// #1510 — 본문 없는 카드는 지워진 메시지가 아니다.
//
// #1454가 완료 리포트를 **평범한 턴 메시지**로 커밋한다: `type: "text"`, 본문 없음,
// 카드는 `props` 안(`kind = "completion_report"`). 그 순간부터 위 표의 첫 줄
// (「본문이 없다 → 묘비」)은 두 가지 서로 다른 행에 똑같이 걸린다 — 지워진 글과
// 카드가 인용 객체의 어느 칸으로도 구별되지 않았기 때문이다.
//
// 그래서 고칠 자리는 판정이 아니라 **계약**이었다. 클라가 아무리 잘 물어도 답을 줄
// 재료가 전선에 없었고, 그 재료가 `propsKind` 다(서버 투영이 `props.kind` 한 칸만
// 싣는다 — 카드의 내용은 여전히 원본의 것이다).
// =============================================================================

/** 카드 하나, 두 경로가 각자 보는 모양으로. */
const CARD_PROPS = { kind: "completion_report", title: "작업 완료 리포트" };

describe("#1510 — 카드 인용", () => {
  /**
   * **red proof.** `propsKind`를 지우면 이 단정이 「삭제된 메시지」로 빨개진다 —
   * 그것이 성재가 본 화면이었다.
   */
  it("서버가 푼 인용: 본문 없는 카드는 묘비가 아니라 카드 이름이다", () => {
    const block = quoteBlockFrom(
      bodied(quoted({ propsKind: "completion_report" }), undefined)
    );
    expect(block.kind).toBe("ready");
    if (block.kind !== "ready") return;
    expect(block.lines).toEqual([COMPLETION_REPORT_TITLE]);
    expect(JSON.stringify(block)).not.toContain(QUOTE_DELETED_TEXT);
  });

  /**
   * 실시간 프레임에는 `reply_to`가 없어 클라가 화면의 행에서 푼다. 그 경로가 카드
   * 신호를 못 옮기면 **같은 원본이 실시간에만 묘비**로 서고 새로고침하면 낫는다.
   */
  it("화면의 행에서 푼 인용도 같은 답을 낸다", () => {
    const card = bodied(message({ props: CARD_PROPS }), undefined);
    const live = payloadToMessage({
      id: "0199aaaa-0000-7000-8000-00000000m003",
      channel_id: card.channelId,
      seq: 43,
      type: "text",
      body: null,
      author_member_id: "00000000-0000-7000-8000-000000000102",
      hlc_ts: 1_785_238_440_000,
      hlc_count: 0,
      reply_to_id: card.id,
    });
    expect(live.replyTo).toBeUndefined();

    const local = resolveQuote(live, (id) => (id === card.id ? card : undefined));
    expect(local?.kind).toBe("ready");
    if (local?.kind !== "ready") return;
    expect(local.lines).toEqual([COMPLETION_REPORT_TITLE]);

    // 두 경로가 **같은 블록**을 만든다. 하나만 고쳐 두면 새로고침이 화면을 바꾼다.
    const served = quoteBlockFrom(
      bodied(
        quoted({ id: card.id, seq: card.seq, propsKind: "completion_report" }),
        undefined
      )
    );
    expect(served).toEqual(local);
  });

  it("컴포저에 건 카드 초안도 같은 규칙을 탄다", () => {
    const draft = quoteDraftFor(bodied(message({ props: CARD_PROPS }), null));
    expect(draft?.block.kind).toBe("ready");
    if (draft?.block.kind !== "ready") return;
    expect(draft.block.lines).toEqual([COMPLETION_REPORT_TITLE]);
  });

  it("정말 지워진 카드는 여전히 묘비다", () => {
    // 무회귀 — 삭제는 `state`/`deletedAtMs`가 나른다. 카드 신호가 그 둘을 이기면
    // 지워진 리포트의 이름이 채널에 남는다. 서버도 묘비에는 `propsKind`를 싣지
    // 않지만(투영이 접는다), 판정은 그 약속에 기대지 않는다.
    for (const gone of [
      quoted({ propsKind: "completion_report", state: "deleted" }),
      quoted({ propsKind: "completion_report", deletedAtMs: 1_785_238_500_000 }),
    ]) {
      expect(quoteBlockFrom(bodied(gone, undefined)).kind).toBe("deleted");
    }
  });

  it("모르는 종류는 아는 만큼만 말한다", () => {
    // 어댑터가 새 `kind`를 쓸 수 있다. 코어가 그 낱말을 몰라도 「내용 없는 메시지」로
    // 떨어뜨리지 않는다 — 카드는 내용을 `props`에 들고 있다.
    const block = quoteBlockFrom(
      bodied(quoted({ propsKind: "some_future_card" }), undefined)
    );
    expect(block.kind).toBe("ready");
    if (block.kind !== "ready") return;
    expect(block.lines).toEqual([QUOTE_CARD_TEXT]);
  });

  it("본문을 쓴 카드는 그 본문을 인용한다", () => {
    // 요약을 쓴 완료 리포트는 사람이 읽을 문장을 갖고 있다. 카드 이름으로 덮으면
    // 인용이 원본의 말 대신 분류명을 가리킨다.
    const block = quoteBlockFrom(
      quoted({ propsKind: "completion_report", body: "환경 셋업을 마쳤습니다." })
    );
    expect(block.kind).toBe("ready");
    if (block.kind !== "ready") return;
    expect(block.lines).toEqual(["환경 셋업을 마쳤습니다."]);
  });

  it("카드의 내용은 인용 블록에 오지 않는다", () => {
    // 계약이 `props.kind` **한 칸**인 이유. 요약·불릿·게이트 표는 원본의 것이고,
    // 인용은 두 줄을 그린 뒤 원본으로 보내는 표지판이다(미결 2와 같은 답).
    const card = bodied(
      message({
        props: {
          kind: "completion_report",
          summary: "게이트 12종 전부 통과했습니다.",
          gates: [{ name: "cargo test", outcome: "pass" }],
        },
      }),
      undefined
    );
    const draft = quoteDraftFor(card);
    expect(JSON.stringify(draft?.block)).not.toContain("게이트 12종");
    expect(JSON.stringify(draft?.block)).not.toContain("cargo test");
  });

  it("낱말이 아닌 kind는 없는 것으로 접는다", () => {
    // 반대 방향 거짓말 방지: `props`는 `Record<string, unknown>`이라 무엇이든 올 수
    // 있고, 아무 값이나 카드로 읽으면 진짜 묘비가 판정을 빠져나간다.
    for (const junk of [12, true, null, {}, ""]) {
      const draft = quoteDraftFor(
        bodied(message({ props: { kind: junk } }), undefined)
      );
      expect(draft?.block.kind).toBe("deleted");
    }
  });

  it("카드가 아닌 행의 네 모양은 #1508 그대로다", () => {
    // 무회귀 — 이 이슈는 `props.kind`를 든 행에만 손댄다. 든 것이 없으면 표가 그대로.
    for (const shape of BODY_SHAPES) {
      expect(quoteBlockFrom(bodied(quoted(), shape.body)).kind).toBe(shape.kind);
    }
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
