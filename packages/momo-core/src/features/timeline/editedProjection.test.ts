import { describe, expect, it } from "vitest";
import {
  threadRollup,
  type Message,
  type MessageAttachment,
  type QuotedMessage,
} from "../../lib/api";
import { payloadToMessage } from "../../lib/realtimeEvents";
import { resolveQuote } from "./quote";
import {
  applyEditedMessage,
  applyTombstone,
  emptyTimeline,
  isStrictlyOrdered,
  reconcileMessages,
  type TimelineState,
} from "./model";

// =============================================================================
// #4450 — 편집이 thread 롤업·인용(replyTo)을 지우고, 안 든 오래된 행의 편집이
// 타임라인 맨 위에 끼어드는 길. #4441(첨부)과 같은 병이다.
//
// 서버는 편집이 내는 두 투영, `message.edited` 프레임과 `PATCH` 응답에서
// **네 가지를 말하지 않는다**:
//
//   칸           프레임 (`build_message_edited_payload`)     PATCH 응답 (`routes/messages.rs` `edit`)
//   attachments  키 없음                                     `&[]` → DTO 가 키를 뺀다
//   thread       키 없음                                     `None`
//   replyTo      `reply_to_id` 만 (「an edit re-publishes     `None` (「the quote id rides along,
//                the whole message, and a rendered quote     the rendered quote comes from the
//                inside it would be the snapshot 규칙 3      next read」)
//                forbids」)
//   runEnded     키 없음                                     `false` → 키를 뺀다 (#1166: 페이지 읽기에만)
//
// 나머지(id·channel_id·seq·hlc_*·author_member_id·type·state·body·props·root_id·
// reply_to_id·created_at_ms·edited_at_ms·deleted_at_ms)는 프레임이 **직접 말한다**.
// 말한 칸은, 비어 있어도(`body: null`, `props: {}`) 프레임의 말이 이긴다 — 허용목록은
// 「말하지 않는 네 칸」뿐이고 「undefined 면 든 것을 유지」 같은 일반 규칙이 아니다.
//
// 아래 프레임·응답은 서버가 실제로 내는 키 그대로다. 합성한 `Message` 한 벌로는 이
// 시험이 증명할 것이 없다: 버그는 「키가 없다」는 서버의 사실에 있다.
// =============================================================================

const CH = "00000000-0000-4000-8000-0000000000c1";
const AUTHOR = "00000000-0000-4000-8000-0000000000a1";
const OTHER_AUTHOR = "00000000-0000-4000-8000-0000000000a2";

const ROOT_ID = "0199bbbb-0000-7000-8000-000000000051"; // seq 7 — 답글이 달린 루트
const QUOTING_ID = "0199bbbb-0000-7000-8000-000000000052"; // seq 9 — 원본을 인용한 줄
const QUOTED_ID = "0199bbbb-0000-7000-8000-000000000031"; // seq 3 — 인용 원본(창 밖)
const QUOTED_ID_2 = "0199bbbb-0000-7000-8000-000000000032";

const ROLLUP = {
  reply_count: 3,
  last_reply_seq: 12,
  last_reply_at: 1_700_000_500_000,
};

const QUOTE: QuotedMessage = {
  id: QUOTED_ID,
  seq: 3,
  authorMemberId: OTHER_AUTHOR,
  type: "text",
  body: "금요일 배포 일정 확인 부탁드려요",
  state: "sent",
};

const PHOTO: MessageAttachment = {
  id: "0199bbbb-0000-7000-8000-0000000000f1",
  name: "IMG_0412.jpg",
  mime: "image/jpeg",
  sizeBytes: 183_204,
};

const ROOT_EDITED_BODY = "배포 일정 공유드려요 (금요일 오전으로 확정)";
const QUOTING_EDITED_BODY = "네, 금요일 오전 열 시로 잡을게요";

type Wire = Parameters<typeof payloadToMessage>[0];

/** 기록 페이지가 싣는, 답글이 달린 루트 — 서버는 페이지에는 롤업을 싣는다. */
function rootRow(over: Partial<Message> = {}): Message {
  return {
    id: ROOT_ID,
    channelId: CH,
    seq: 7,
    hlcTs: 1_700_000_007_000,
    hlcCount: 0,
    authorMemberId: AUTHOR,
    type: "text",
    body: "배포 일정 공유드려요",
    state: "sent",
    createdAtMs: 1_700_000_007_000,
    thread: ROLLUP,
    ...over,
  };
}

/** 기록 페이지가 싣는, 원본을 인용한 줄 — 풀린 인용(`replyTo`)은 페이지에만 있다. */
function quotingRow(over: Partial<Message> = {}): Message {
  return {
    id: QUOTING_ID,
    channelId: CH,
    seq: 9,
    hlcTs: 1_700_000_009_000,
    hlcCount: 0,
    authorMemberId: AUTHOR,
    type: "text",
    body: "네, 금요일 오전으로 잡을게요",
    state: "sent",
    createdAtMs: 1_700_000_009_000,
    replyToId: QUOTED_ID,
    replyTo: QUOTE,
    ...over,
  };
}

interface Identity {
  id: string;
  seq: number;
  rootId?: string;
  replyToId?: string;
}

/**
 * `build_message_edited_payload` 의 키 전부. **`attachments`·`thread`·`reply_to`·
 * `run_ended` 가 없다** — 이 시험 전체가 그 부재에 대한 것이다.
 */
function editedFrame(
  who: Identity,
  body: string,
  over: Record<string, unknown> = {}
): Wire {
  return {
    id: who.id,
    channel_id: CH,
    seq: who.seq,
    hlc_ts: 1_700_000_000_000 + who.seq * 1000,
    hlc_count: 0,
    author_member_id: AUTHOR,
    type: "text",
    state: "edited",
    body,
    props: {},
    root_id: who.rootId ?? null,
    reply_to_id: who.replyToId ?? null,
    run_id: null,
    client_msg_id: "0199bbbb-0000-7000-8000-0000000000c1",
    created_at_ms: 1_700_000_000_000 + who.seq * 1000,
    edited_at_ms: 1_700_000_099_000,
    deleted_at_ms: null,
    ...over,
  } as Wire;
}

/**
 * `PATCH` 응답 — `message_dto(…, thread: None, reply_to: None, &[], run_ended: false)`
 * 에 `state` 를 실은 모양. 페이지 행에서 네 칸을 뺀 것과 같다.
 */
function patchResponse(page: Message, body: string): Message {
  const {
    attachments: _a,
    thread: _t,
    replyTo: _q,
    runEnded: _r,
    ...rest
  } = page;
  return { ...rest, body, state: "edited", editedAtMs: 1_700_000_099_000 };
}

/** 롤업 키가 아예 없는 행 — DTO 가 답글 없는 루트의 `thread` 키를 빼는 모양 그대로. */
function withoutThread(row: Message): Message {
  const { thread: _thread, ...rest } = row;
  return rest;
}

function fold(...batches: Message[][]): TimelineState {
  return batches.reduce(
    (state, batch) => reconcileMessages(state, batch),
    emptyTimeline()
  );
}

const rootIdentity: Identity = { id: ROOT_ID, seq: 7 };
const quotingIdentity: Identity = {
  id: QUOTING_ID,
  seq: 9,
  replyToId: QUOTED_ID,
};

// ---------------------------------------------------------------------------
// 1. 편집은 행을 다시 투영할 뿐 — 투영이 말하지 않는 장식은 이미 든 것을 지킨다
// ---------------------------------------------------------------------------
describe("편집 투영이 말하지 않는 장식은 이미 든 것을 지킨다 (#4450)", () => {
  it("답글이 달린 루트를 고쳐도(message.edited 프레임) 답글 롤업이 남고, 글·수정 표시는 새것이다", () => {
    const state = fold(
      [rootRow()],
      [payloadToMessage(editedFrame(rootIdentity, ROOT_EDITED_BODY))]
    );

    expect(state.messages).toHaveLength(1);
    const row = state.messages[0];
    // 롤업: 이 시험이 잡는 버그. `threadRollup` 은 화면이 쓰는 그 읽기다.
    // 두 얼굴 키는 옛 서버 모양(세 키뿐인 롤업)을 읽은 값이다 — 얼굴 없음(#4877).
    expect(threadRollup(row)).toEqual({
      replyCount: 3,
      lastReplySeq: 12,
      lastReplyAtMs: 1_700_000_500_000,
      participantIds: [],
      participantCount: 0,
    });
    // 글·표시: 「들어온 행을 통째로 무시」하는 가짜 수리를 막는다. 편집이 실제로
    // 적용됐다는 증거가 같은 단정 안에 있어야 롤업이 남은 것이 「편집이 안 먹어서」가
    // 아니게 된다.
    expect(row.body).toBe(ROOT_EDITED_BODY);
    expect(row.state).toBe("edited");
    expect(row.editedAtMs).toBe(1_700_000_099_000);
  });

  it("PATCH 응답이 덮어써도 같다 — 고친 사람 자신의 화면", () => {
    const page = rootRow();
    const state = fold([page], [patchResponse(page, ROOT_EDITED_BODY)]);

    expect(state.messages).toHaveLength(1);
    expect(threadRollup(state.messages[0])?.replyCount).toBe(3);
    expect(state.messages[0].body).toBe(ROOT_EDITED_BODY);
    expect(state.messages[0].state).toBe("edited");
  });

  it("인용한 줄을 고쳐도(프레임) 풀린 인용이 남는다 — 원본이 화면에 없어도 인용 블록은 서 있다", () => {
    const state = fold(
      [quotingRow()],
      [payloadToMessage(editedFrame(quotingIdentity, QUOTING_EDITED_BODY))]
    );

    expect(state.messages).toHaveLength(1);
    const row = state.messages[0];
    expect(row.replyTo).toEqual(QUOTE);
    // 화면이 보는 결과로도 잰다: 원본(seq 3)은 이 창에 없다(`loaded` 가 못 찾는다). 풀린
    // 인용이 사라지면 블록은 `unresolved` 로 떨어져 「원본을 불러오지 못했어요」가 된다.
    const block = resolveQuote(row, () => undefined);
    expect(block?.kind).toBe("ready");
    expect(block?.kind === "ready" ? block.lines.join(" ") : "").toContain(
      "금요일 배포 일정"
    );
    // 편집이 실제로 적용됐다.
    expect(row.body).toBe(QUOTING_EDITED_BODY);
    expect(row.state).toBe("edited");
  });

  it("인용한 줄을 고쳐도(PATCH 응답) 풀린 인용이 남는다", () => {
    const page = quotingRow();
    const state = fold([page], [patchResponse(page, QUOTING_EDITED_BODY)]);

    expect(state.messages[0].replyTo).toEqual(QUOTE);
    expect(resolveQuote(state.messages[0], () => undefined)?.kind).toBe("ready");
    expect(state.messages[0].body).toBe(QUOTING_EDITED_BODY);
  });

  it("사진·롤업·인용을 다 든 줄도 한 번의 편집에 셋 다 남는다", () => {
    const page = rootRow({
      replyToId: QUOTED_ID,
      replyTo: QUOTE,
      attachments: [PHOTO],
    });
    const state = fold(
      [page],
      [
        payloadToMessage(
          editedFrame(
            { id: ROOT_ID, seq: 7, replyToId: QUOTED_ID },
            ROOT_EDITED_BODY
          )
        ),
      ]
    );

    const row = state.messages[0];
    expect(row.attachments).toEqual([PHOTO]);
    expect(threadRollup(row)?.replyCount).toBe(3);
    expect(row.replyTo).toEqual(QUOTE);
    expect(row.body).toBe(ROOT_EDITED_BODY);
  });

  it("두 번 고쳐도, 응답과 프레임이 같은 편집을 겹쳐 알려도 남는다", () => {
    const page = rootRow();
    const second = "배포 일정 공유드려요 (금요일 오전 열 시)";
    const state = fold(
      [page],
      [patchResponse(page, ROOT_EDITED_BODY)],
      [payloadToMessage(editedFrame(rootIdentity, ROOT_EDITED_BODY))],
      [
        payloadToMessage(
          editedFrame(rootIdentity, second, { edited_at_ms: 1_700_000_199_000 })
        ),
      ]
    );

    expect(state.messages).toHaveLength(1);
    expect(threadRollup(state.messages[0])?.replyCount).toBe(3);
    expect(state.messages[0].body).toBe(second);
  });

  it("수정 표시가 없는 message.edited(스트림 조각·props 만 바꾼 갱신)도 롤업과 인용을 지우지 않는다", () => {
    // `stream_message_body_in_tx`·`emit_message_edited_in_tx` 는 같은 `message.edited` 를
    // 사람 편집 표지를 더하지 않고 낸다. 「수정됨」 표지에 걸어서 지키면 이 프레임들이 같은
    // 병을 그대로 앓는다(#4441 이 첨부에서 못 박은 것과 같은 이유).
    const state = fold(
      [rootRow({ replyToId: QUOTED_ID, replyTo: QUOTE })],
      [
        payloadToMessage(
          editedFrame(
            { id: ROOT_ID, seq: 7, replyToId: QUOTED_ID },
            "배포 일정 공유드려요",
            { state: "sent", edited_at_ms: null, props: { note: "갱신" } }
          )
        ),
      ]
    );

    expect(threadRollup(state.messages[0])?.replyCount).toBe(3);
    expect(state.messages[0].replyTo).toEqual(QUOTE);
    expect(state.messages[0].props).toEqual({ note: "갱신" });
  });

  it("되쏘기로 온 message.new(롤업·인용 키가 없다)도 든 장식을 지우지 않는다", () => {
    // `message.new` 도 `reply_to` 를 일부러 싣지 않고(ADR-0148) 롤업은 루트가 답글을 받기
    // 전의 것이라 싣지 않는다. 기록으로 읽은 줄 위에 같은 줄의 라이브 프레임이 겹쳐 오면
    // (되쏘기·재구독) 같은 침묵이다.
    const state = fold(
      [quotingRow()],
      [
        payloadToMessage({
          id: QUOTING_ID,
          channel_id: CH,
          seq: 9,
          type: "text",
          body: "네, 금요일 오전으로 잡을게요",
          author_member_id: AUTHOR,
          hlc_ts: 1_700_000_009_000,
          hlc_count: 0,
          root_id: null,
          reply_to_id: QUOTED_ID,
        } as Wire),
      ]
    );

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].replyTo).toEqual(QUOTE);
  });

  it("스트리밍이 끝났다고 기록이 말한 줄(runEnded)에 편집 조각이 와도 그 말이 남는다", () => {
    // `runEnded` 는 페이지 읽기에만 실리고 true 일 때만 실린다(#1166). 끝난 run 은 다시
    // 끝나지 않은 것이 되지 않는다 — 조각 프레임의 침묵은 「다시 열렸다」가 아니다.
    const page: Message = {
      ...withoutThread(rootRow()),
      body: "분석 중…",
      runEnded: true,
    };
    const state = fold(
      [page],
      [
        payloadToMessage(
          editedFrame(rootIdentity, "분석 중… 절반", {
            state: "sent",
            edited_at_ms: null,
          })
        ),
      ]
    );

    expect(state.messages[0].runEnded).toBe(true);
    expect(state.messages[0].body).toBe("분석 중… 절반");
  });

  it("들어온 행이 직접 말하면 그 말이 이긴다 — 합치지 않는다 (롤업·인용 모두)", () => {
    const fresherQuote: QuotedMessage = {
      ...QUOTE,
      body: "금요일 배포 일정 확인 부탁드려요 (오전으로 수정)",
      state: "edited",
      editedAtMs: 1_700_000_050_000,
    };
    const biggerRollup = {
      reply_count: 5,
      last_reply_seq: 15,
      last_reply_at: 1_700_000_900_000,
    };

    const rollups = fold([rootRow()], [rootRow({ thread: biggerRollup })]);
    expect(threadRollup(rollups.messages[0])).toEqual({
      replyCount: 5,
      lastReplySeq: 15,
      lastReplyAtMs: 1_700_000_900_000,
      participantIds: [],
      participantCount: 0,
    });

    const quotes = fold(
      [quotingRow()],
      [quotingRow({ replyTo: fresherQuote })]
    );
    expect(quotes.messages[0].replyTo).toEqual(fresherQuote);
  });

  it("답글 수가 0 이라고 말하는 롤업은 말한 것이 아니다 — 화면이 쓰는 읽기(threadRollup)와 같은 답", () => {
    // 서버는 `reply_count > 0` 일 때만 롤업을 싣는다. 0 짜리가 오면 `threadRollup` 은 「답글
    // 없음」으로 읽으므로, 보존 판정도 같은 읽기에 맞춘다: 든 롤업을 0 으로 덮지 않는다.
    const zero = { reply_count: 0, last_reply_seq: 0, last_reply_at: 0 };
    const state = fold([rootRow()], [rootRow({ thread: zero })]);

    expect(threadRollup(state.messages[0])?.replyCount).toBe(3);
  });

  it("보존할 것이 없던 행은 키를 만들지 않는다 — 없는 것을 만들어 내지 않는다", () => {
    const state = fold(
      [withoutThread(rootRow())],
      [payloadToMessage(editedFrame(rootIdentity, ROOT_EDITED_BODY))]
    );

    const row = state.messages[0];
    expect(row.body).toBe(ROOT_EDITED_BODY);
    expect("thread" in row).toBe(false);
    expect("replyTo" in row).toBe(false);
    expect("runEnded" in row).toBe(false);
    expect("attachments" in row).toBe(false);
  });

  it("타입 밖 입력(thread·replyTo: null)에도 던지지 않는다 — null 도 말하지 않은 것이다", () => {
    // 이 입력을 만드는 생산자는 없다. 그래도 접기는 모든 실시간 프레임이 지나는 리듀서라서,
    // 이 규칙이 거기에 새 던질 자리를 만들지 않는다는 것을 못 박는다(#4441 의 null 시험과 같다).
    const nullIncoming = {
      ...patchResponse(quotingRow({ thread: ROLLUP }), "고침"),
      thread: null,
      replyTo: null,
    } as unknown as Message;
    const nullHeld = {
      ...quotingRow(),
      thread: null,
      replyTo: null,
    } as unknown as Message;

    expect(() => fold([quotingRow({ thread: ROLLUP })], [nullIncoming])).not.toThrow();
    const kept = fold([quotingRow({ thread: ROLLUP })], [nullIncoming]).messages[0];
    expect(kept.replyTo).toEqual(QUOTE);
    expect(threadRollup(kept)?.replyCount).toBe(3);

    expect(() =>
      fold([nullHeld], [payloadToMessage(editedFrame(quotingIdentity, "고침"))])
    ).not.toThrow();
    const none = fold([nullHeld], [payloadToMessage(editedFrame(quotingIdentity, "고침"))])
      .messages[0];
    expect(threadRollup(none)).toBeNull();
    expect(none.replyTo ?? null).toBeNull();
  });

  it("인용은 행이 지금 가리키는 원본의 것일 때만 잇는다 — 다른 원본의 풀린 인용을 물려받지 않는다", () => {
    // 한 메시지의 인용 대상은 바뀌지 않는다(컬럼이 불변). 그래서 이 입력은 서버가 못 만들지만,
    // 보존이 「든 것이 있으면 무조건 붙인다」가 아니라 「이 행이 가리키는 그 원본」임을 못 박는다.
    const other = fold(
      [quotingRow()],
      [payloadToMessage(editedFrame({ ...quotingIdentity, replyToId: QUOTED_ID_2 }, "고침"))]
    ).messages[0];
    expect(other.replyToId).toBe(QUOTED_ID_2);
    expect("replyTo" in other).toBe(false);

    // 프레임이 「인용 없음」(reply_to_id: null)을 말하는 경우도 마찬가지다.
    const none = fold(
      [quotingRow()],
      [payloadToMessage(editedFrame({ id: QUOTING_ID, seq: 9 }, "고침"))]
    ).messages[0];
    expect("replyTo" in none).toBe(false);
  });

  it("원본 id 의 대소문자가 달라도 같은 원본이다", () => {
    const state = fold(
      [quotingRow()],
      [
        payloadToMessage(
          editedFrame(
            { ...quotingIdentity, replyToId: QUOTED_ID.toUpperCase() },
            "고침"
          )
        ),
      ]
    );

    expect(state.messages[0].replyTo).toEqual(QUOTE);
  });

  it("seq 가 같아도 id 가 다른 메시지면 롤업·인용을 물려받지 않는다", () => {
    const state = fold(
      [rootRow({ replyToId: QUOTED_ID, replyTo: QUOTE })],
      [
        payloadToMessage(
          editedFrame(
            { id: QUOTING_ID, seq: 7, replyToId: QUOTED_ID },
            "다른 메시지",
            { author_member_id: OTHER_AUTHOR }
          )
        ),
      ]
    );

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].id).toBe(QUOTING_ID);
    expect("thread" in state.messages[0]).toBe(false);
    expect("replyTo" in state.messages[0]).toBe(false);
  });

  it("id 의 대소문자가 달라도 같은 메시지다", () => {
    const state = fold(
      [rootRow()],
      [payloadToMessage(editedFrame({ id: ROOT_ID.toUpperCase(), seq: 7 }, ROOT_EDITED_BODY))]
    );

    expect(threadRollup(state.messages[0])?.replyCount).toBe(3);
  });

  describe("묘비는 장식을 주고받지 않는다 — 묘비가 낀 길의 동작은 수리 전과 같다", () => {
    it("DELETE 응답 묘비는 든 롤업·인용을 이어받지 않는다", () => {
      const tombstone: Message = {
        ...patchResponse(quotingRow({ thread: ROLLUP }), "x"),
        state: "deleted",
        body: undefined,
        deletedAtMs: 1_700_000_300_000,
      };
      const state = fold([quotingRow({ thread: ROLLUP })], [tombstone]);

      expect(state.messages[0].state).toBe("deleted");
      expect("thread" in state.messages[0]).toBe(false);
      expect("replyTo" in state.messages[0]).toBe(false);
    });

    it("실시간 묘비(applyTombstone 은 ...existing 이라 장식을 그대로 든다)가 든 롤업·인용을 늦게 온 편집 프레임이 새 행으로 되살리지 않는다", () => {
      const tombstoned = applyTombstone(
        fold([quotingRow({ thread: ROLLUP })]),
        QUOTING_ID,
        1_700_000_300_000
      );
      // 전제: 이 묘비는 둘 다 들고 있다. 이 단정이 없으면 아래 단정이 헛돈다.
      expect(tombstoned.messages[0].state).toBe("deleted");
      expect(tombstoned.messages[0].replyTo).toEqual(QUOTE);
      expect(threadRollup(tombstoned.messages[0])?.replyCount).toBe(3);

      const after = reconcileMessages(tombstoned, [
        payloadToMessage(editedFrame(quotingIdentity, QUOTING_EDITED_BODY)),
      ]);

      expect(after.messages).toHaveLength(1);
      // 이 시험은 **병합 문**(`reconcileMessages`)을 직접 지난다. 본문이 마지막 쓰기로 돌아오는
      // 것은 병합의 수리 전부터의 동작이다(#4441 과 같다). 편집 프레임·PATCH 응답이 지나는 문
      // (`applyEditedMessage`)은 묘비 위의 편집을 아예 받지 않는다 — 아래 3절. 이 단정은 늦은
      // 프레임이 **적용됐다**는 증거이고, 못 박는 것은 아래 둘이다.
      expect(after.messages[0].body).toBe(QUOTING_EDITED_BODY);
      expect("thread" in after.messages[0]).toBe(false);
      expect("replyTo" in after.messages[0]).toBe(false);
    });
  });

  it("프레임이 직접 말한 칸은 비어 있어도 프레임의 말이 이긴다 — 허용목록은 말하지 않는 네 칸뿐이다", () => {
    // 「들어온 값이 undefined 면 든 것을 유지」 같은 일반 규칙은 이 시험이 막는다: 본문이
    // 비어 나오는 갱신(`body: null`), 비워진 props(`props: {}`), 수정 표시를 거둔 `state`·
    // `edited_at_ms` 는 프레임이 **말한 것**이다. 든 행은 일부러 모든 칸이 차 있다(고친 적 있고
    // props 가 있다) — 비어 있는 든 행이면 「든 것 유지」 변이와 구별되지 않는다.
    const held = rootRow({
      body: "배포 일정 공유드려요",
      state: "edited",
      editedAtMs: 1_700_000_050_000,
      props: { note: "이전" },
    });
    const state = fold(
      [held],
      [
        payloadToMessage(
          editedFrame(rootIdentity, "", {
            state: "sent",
            body: null,
            edited_at_ms: null,
            props: {},
          })
        ),
      ]
    );

    const row = state.messages[0];
    expect(row.body).toBeUndefined();
    expect(row.props).toEqual({});
    expect(row.state).toBe("sent");
    expect(row.editedAtMs).toBeUndefined();
    // 같은 편집에서 말하지 않는 칸은 그대로다 — 둘은 같은 행에서 함께 일어난다.
    expect(threadRollup(row)?.replyCount).toBe(3);
  });

  it("PATCH 응답이 키를 뺀 칸(빈 props)도 응답의 말이 이긴다 — 든 props 를 되살리지 않는다", () => {
    // DTO 는 비어 있는 `props` 의 키를 뺀다(`response_props`). 키가 없다는 것은 「말하지 않음」이
    // 아니라 「비어 있음」이다: 서버가 지정 키를 지워 props 가 비었다면 든 행의 옛 props 가
    // 살아나면 안 된다. 허용목록(attachments·thread·replyTo·runEnded)에 props 는 없다.
    const held = rootRow({ props: { note: "이전" } });
    const { props: _omitted, ...response } = patchResponse(held, ROOT_EDITED_BODY);
    expect("props" in response).toBe(false);

    const state = fold([held], [response as Message]);

    expect(state.messages[0].props).toBeUndefined();
    expect(state.messages[0].body).toBe(ROOT_EDITED_BODY);
    // 허용목록의 칸은 그대로 지킨다.
    expect(threadRollup(state.messages[0])?.replyCount).toBe(3);
  });

  it("들어온 행과 이전 state 를 바꾸지 않는다 — 새 행을 만든다", () => {
    const page = quotingRow({ thread: ROLLUP });
    const before = fold([page]);
    const incoming = patchResponse(page, QUOTING_EDITED_BODY);
    const snapshot = JSON.stringify({ before, incoming });

    const after = reconcileMessages(before, [incoming]);

    expect(JSON.stringify({ before, incoming })).toBe(snapshot);
    expect("replyTo" in incoming).toBe(false);
    expect(after).not.toBe(before);
    expect(after.messages[0]).not.toBe(incoming);
    // 전제: 위 불변 단정이 지나간 길이 「잇는 길」이다.
    expect(after.messages[0].replyTo).toEqual(QUOTE);
    expect(threadRollup(after.messages[0])?.replyCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 2. 편집은 행을 만들지 않는다 — 든 행만 갱신한다 (`applyEditedMessage`)
// ---------------------------------------------------------------------------

/** 최근 꼬리만 든 창: seq 10·11. 그 아래(1~9)는 위로 더 읽어야 닿는다. */
function tailRow(seq: number, over: Partial<Message> = {}): Message {
  return {
    id: `0199bbbb-0000-7000-8000-0000000000${seq.toString().padStart(2, "0")}`,
    channelId: CH,
    seq,
    hlcTs: 1_700_000_000_000 + seq * 1000,
    hlcCount: 0,
    authorMemberId: AUTHOR,
    type: "text",
    body: `메시지 ${seq}`,
    state: "sent",
    createdAtMs: 1_700_000_000_000 + seq * 1000,
    ...over,
  };
}

function window10to11(): TimelineState {
  return fold([tailRow(11), tailRow(10)]);
}

function editOf(seq: number, body = "고친 글"): Message {
  const row = tailRow(seq);
  return payloadToMessage(
    editedFrame({ id: row.id, seq }, body, {
      created_at_ms: row.createdAtMs,
    })
  );
}

describe("편집은 행을 만들지 않는다 — 든 행만 갱신한다 (#4450)", () => {
  it("전제: 이 창은 10·11 만 든다", () => {
    const state = window10to11();
    expect(state.messages.map((m) => m.seq)).toEqual([10, 11]);
    expect(state.oldestSeq).toBe(10);
    expect(state.newestSeq).toBe(11);
  });

  it("든 창보다 오래된 행의 편집은 맨 위에 끼지 않는다 — 같은 state 를 돌려준다", () => {
    const state = window10to11();

    const after = applyEditedMessage(state, editOf(3));

    expect(after).toBe(state);
    expect(after.messages.map((m) => m.seq)).toEqual([10, 11]);
    // 이게 실제 피해다: `oldestSeq` 가 3 으로 내려가면 「위로 더 읽기」는 `before=3` 을
    // 요청해서 4~9 가 영영 읽히지 않는다(두 클라 모두 `before: state.oldestSeq`).
    expect(after.oldestSeq).toBe(10);
    expect(after.newestSeq).toBe(11);
  });

  it("든 창보다 새로운 행의 편집도 끼지 않는다 — 꼬리를 메우는 커서가 앞서가지 않는다", () => {
    const state = window10to11();

    const after = applyEditedMessage(state, editOf(20));

    expect(after).toBe(state);
    expect(after.newestSeq).toBe(11);
  });

  it("창 안이지만 들지 않은 줄(구멍)의 편집도 끼지 않는다", () => {
    const state = fold([tailRow(11), tailRow(8)]);

    const after = applyEditedMessage(state, editOf(10));

    expect(after).toBe(state);
    expect(after.messages.map((m) => m.seq)).toEqual([8, 11]);
  });

  it("빈 타임라인에도 끼지 않는다 — 머리 페이지가 오기 전에 온 프레임", () => {
    const state = emptyTimeline();

    const after = applyEditedMessage(state, editOf(10));

    expect(after).toBe(state);
    expect(after.oldestSeq).toBeNull();
    expect(after.newestSeq).toBeNull();
  });

  it.each([
    {
      label: "스트림 조각 — 아직 못 본 줄(seq 12)의 자란 본문",
      seq: 12,
      body: "조각이 자란 본문",
      props: { "momo.stream": { rev: 3, streaming: true } },
    },
    {
      label: "카드 props 프레임 — 오래된 카드(seq 3)의 승인 결정",
      seq: 3,
      body: "배포 승인 요청",
      props: { card: "approval_request", status: "approved" },
    },
  ])(
    "안 든 줄의 수정 표시 없는 프레임도 끼지 않는다 — 문은 프레임의 모양(state)으로 안 든 줄을 가리지 않는다 ($label)",
    ({ seq, body, props }) => {
      const state = window10to11();
      const frame = payloadToMessage(
        editedFrame({ id: tailRow(seq).id, seq }, body, {
          state: "sent",
          edited_at_ms: null,
          props,
          created_at_ms: tailRow(seq).createdAtMs,
        })
      );
      // 전제: 서버가 스트림 조각·카드 props 갱신에 싣는 모양이다(수정 표시 없음).
      expect(frame.state).toBe("sent");
      expect(frame.editedAtMs).toBeUndefined();

      const after = applyEditedMessage(state, frame);

      expect(after).toBe(state);
      expect(after.messages.map((m) => m.seq)).toEqual([10, 11]);
      expect(after.oldestSeq).toBe(10);
      expect(after.newestSeq).toBe(11);
    }
  );

  it("seq 는 같지만 id 가 다른 줄의 편집은 든 줄을 덮지 않는다", () => {
    const state = window10to11();
    const stranger = payloadToMessage(
      editedFrame(
        { id: "0199bbbb-0000-7000-8000-0000000000ee", seq: 10 },
        "다른 채널의 같은 seq",
        { author_member_id: OTHER_AUTHOR }
      )
    );

    const after = applyEditedMessage(state, stranger);

    expect(after).toBe(state);
    expect(after.messages[0].body).toBe("메시지 10");
  });

  it("든 줄이면 제자리에서 갱신한다 — 글은 새것이고 장식은 그대로이며 창의 끝은 움직이지 않는다", () => {
    const state = fold([
      tailRow(11),
      tailRow(10, { thread: ROLLUP, replyToId: QUOTED_ID, replyTo: QUOTE }),
    ]);
    const edit = payloadToMessage(
      editedFrame(
        { id: tailRow(10).id, seq: 10, replyToId: QUOTED_ID },
        "고친 글",
        { created_at_ms: tailRow(10).createdAtMs }
      )
    );

    const after = applyEditedMessage(state, edit);

    expect(after).not.toBe(state);
    expect(after.messages.map((m) => m.seq)).toEqual([10, 11]);
    expect(after.messages[0].body).toBe("고친 글");
    expect(after.messages[0].state).toBe("edited");
    // 장식: 보존 규칙(1절)이 이 문을 지난다.
    expect(threadRollup(after.messages[0])?.replyCount).toBe(3);
    expect(after.messages[0].replyTo).toEqual(QUOTE);
    // 편집은 창의 끝을 움직이지 못한다.
    expect(after.oldestSeq).toBe(10);
    expect(after.newestSeq).toBe(11);
    expect(isStrictlyOrdered(after.messages)).toBe(true);
  });

  it("스트림 조각 프레임(수정 표시 없음, props 의 momo.stream 만 자람)도 든 줄이면 적용된다 — 문은 「사람이 고친 줄」만 받는 문이 아니다", () => {
    // 에이전트 답 하나가 조각마다 내는 `message.edited` 다(`stream_message_body_in_tx`). `state` 는
    // 행의 현재 값 그대로 `sent`, `edited_at_ms` 는 null — 서버는 스트림 조각에 「수정됨」을 찍지
    // 않는다. 문이 `state`·`editedAtMs` 로 좁혀지면 스트리밍 답이 이 클라에서 멈춘다.
    const STREAM_2 = { "momo.stream": { rev: 2, streaming: true } };
    const STREAM_3 = { "momo.stream": { rev: 3, streaming: true } };
    const GROWN = "배포 일정을 정리하는 중이에요. 금요일 오전으로";
    const state = fold([
      tailRow(11),
      tailRow(10, { body: "배포 일정을 정리하는 중", props: STREAM_2, thread: ROLLUP }),
    ]);
    const slice = payloadToMessage(
      editedFrame({ id: tailRow(10).id, seq: 10 }, GROWN, {
        state: "sent",
        edited_at_ms: null,
        props: STREAM_3,
        created_at_ms: tailRow(10).createdAtMs,
      })
    );
    // 전제: 이 프레임에는 편집 표지가 없다.
    expect(slice.state).toBe("sent");
    expect(slice.editedAtMs).toBeUndefined();

    const after = applyEditedMessage(state, slice);

    expect(after).not.toBe(state);
    expect(after.messages[0].body).toBe(GROWN);
    expect(after.messages[0].props).toEqual(STREAM_3);
    expect(after.messages[0].state).toBe("sent");
    expect(after.messages[0].editedAtMs).toBeUndefined();
    // 같은 투영에서 말하지 않는 칸은 그대로다.
    expect(threadRollup(after.messages[0])?.replyCount).toBe(3);
    expect(after.oldestSeq).toBe(10);
    expect(after.newestSeq).toBe(11);
  });

  it("서버가 스스로 다시 쓴 카드의 props 프레임(글은 그대로, 수정 표시 없음)도 든 줄이면 적용된다", () => {
    // 다른 기기의 승인 결정(#3771)이나 제어 창이 카드의 props 를 갈아 끼우는 길
    // (`emit_message_edited_in_tx`)이다. `UPDATE message SET props` 뿐이라 `state` 는 `sent`,
    // 글은 그대로다.
    const PENDING = { card: "approval_request", status: "pending" };
    const DECIDED = { card: "approval_request", status: "approved" };
    const state = fold([
      tailRow(11),
      tailRow(10, { body: "배포 승인 요청", props: PENDING }),
    ]);
    const frame = payloadToMessage(
      editedFrame({ id: tailRow(10).id, seq: 10 }, "배포 승인 요청", {
        state: "sent",
        edited_at_ms: null,
        props: DECIDED,
        created_at_ms: tailRow(10).createdAtMs,
      })
    );
    expect(frame.state).toBe("sent");
    expect(frame.editedAtMs).toBeUndefined();

    const after = applyEditedMessage(state, frame);

    expect(after).not.toBe(state);
    expect(after.messages[0].props).toEqual(DECIDED);
    expect(after.messages[0].body).toBe("배포 승인 요청");
    expect(after.messages[0].state).toBe("sent");
  });

  it("id 의 대소문자가 달라도 같은 줄이다 — 든 줄은 갱신된다", () => {
    const state = window10to11();
    const upper = payloadToMessage(
      editedFrame({ id: tailRow(10).id.toUpperCase(), seq: 10 }, "고친 글", {
        created_at_ms: tailRow(10).createdAtMs,
      })
    );

    const after = applyEditedMessage(state, upper);

    expect(after).not.toBe(state);
    expect(after.messages[0].body).toBe("고친 글");
  });

  it("입력 state 를 바꾸지 않는다", () => {
    const state = window10to11();
    const snapshot = JSON.stringify(state);

    applyEditedMessage(state, editOf(10));
    applyEditedMessage(state, editOf(3));

    expect(JSON.stringify(state)).toBe(snapshot);
  });

  it("가드는 편집 문에만 있다 — 기록 페이지의 오래된 줄은 여전히 맨 위로 들어온다", () => {
    // 가드를 `reconcileMessages` 에 넣으면 「위로 더 읽기」와 꼬리 되읽기가 같이 죽는다. 그리고
    // 「수정됨」 표지(`state: "edited"`)로 편집을 가를 수도 없다: 고친 적 있는 오래된 줄도
    // 기록 페이지에는 그 표지를 달고 온다.
    const state = window10to11();
    const oldEdited = tailRow(3, { state: "edited", editedAtMs: 1_700_000_050_000 });

    const after = reconcileMessages(state, [oldEdited]);

    expect(after.messages.map((m) => m.seq)).toEqual([3, 10, 11]);
    expect(after.oldestSeq).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 3. 든 줄이 묘비면 묘비가 이긴다 — 편집 문의 가드 (`applyEditedMessage`, planner 결정)
// ---------------------------------------------------------------------------

describe("든 줄이 묘비면 늦게 온 편집은 묘비를 되살리지 않는다 — 편집 문의 가드 (#4450)", () => {
  const DELETED_AT = 1_700_000_300_000;
  const LATE_BODY = "지우기 전에 고친 글";

  /** 롤업·인용을 든 seq 10 이 실시간 묘비(`message.deleted` → `applyTombstone`)로 지워진 창. */
  function tombstonedWindow(): TimelineState {
    return applyTombstone(
      fold([
        tailRow(11),
        tailRow(10, { thread: ROLLUP, replyToId: QUOTED_ID, replyTo: QUOTE }),
      ]),
      tailRow(10).id,
      DELETED_AT
    );
  }

  it("전제: 묘비는 본문이 없고 장식을 든다 — 아래 단정이 헛돌지 않는다", () => {
    const state = tombstonedWindow();

    expect(state.messages.map((m) => m.seq)).toEqual([10, 11]);
    expect(state.messages[0].state).toBe("deleted");
    expect(state.messages[0].body).toBeUndefined();
    expect(state.messages[0].replyTo).toEqual(QUOTE);
    expect(threadRollup(state.messages[0])?.replyCount).toBe(3);
  });

  it("지운 줄 위에 늦게 온 message.edited 프레임은 무시된다 — 같은 state 이고 본문은 돌아오지 않는다", () => {
    const state = tombstonedWindow();

    const after = applyEditedMessage(state, editOf(10, LATE_BODY));

    expect(after).toBe(state);
    expect(after.messages[0].state).toBe("deleted");
    expect(after.messages[0].body).toBeUndefined();
    expect(after.messages[0].deletedAtMs).toBe(DELETED_AT);
  });

  it("수정 표시가 없는 늦은 프레임(스트림 조각·props 만 바꾼 갱신)도 같다 — 「수정됨」으로 가리지 않는다", () => {
    const state = tombstonedWindow();
    const late = payloadToMessage(
      editedFrame({ id: tailRow(10).id, seq: 10 }, LATE_BODY, {
        state: "sent",
        edited_at_ms: null,
        created_at_ms: tailRow(10).createdAtMs,
      })
    );
    // 전제: 이 프레임은 편집 표지가 없다(그래도 가드는 「줄이 묘비인가」만 본다).
    expect(late.state).toBe("sent");
    expect(late.editedAtMs).toBeUndefined();

    const after = applyEditedMessage(state, late);

    expect(after).toBe(state);
    expect(after.messages[0].body).toBeUndefined();
  });

  it("지운 뒤에 PATCH 응답이 닿아도 같다 — 다른 기기가 지웠고 내 편집 응답이 늦게 돌아온 경우", () => {
    const state = tombstonedWindow();
    const response = patchResponse(tailRow(10), LATE_BODY);
    // 전제: 서버가 돌려주는 응답 모양(장식 키 없음, 수정됨 표지)이다.
    expect(response.state).toBe("edited");
    expect("thread" in response).toBe(false);

    const after = applyEditedMessage(state, response);

    expect(after).toBe(state);
    expect(after.messages[0].state).toBe("deleted");
    expect(after.messages[0].body).toBeUndefined();
  });

  it("기록 페이지가 실어 온 묘비도 같다 — 실시간 묘비만 막는 가드가 아니다", () => {
    const tombstone: Message = {
      ...tailRow(10, { thread: ROLLUP, replyToId: QUOTED_ID, replyTo: QUOTE }),
      state: "deleted",
      body: undefined,
      deletedAtMs: DELETED_AT,
    };
    const state = fold([tailRow(11), tombstone]);
    expect(state.messages[0].state).toBe("deleted");

    const after = applyEditedMessage(state, editOf(10, LATE_BODY));

    expect(after).toBe(state);
    expect(after.messages[0].body).toBeUndefined();
  });

  it("대조: 같은 프레임이 병합 문을 직접 지나면 본문이 돌아온다 — 가드는 병합이 아니라 편집 문에 있다", () => {
    // 병합(`reconcileMessages`)은 기록 페이지·`message.new`·꼬리 되읽기가 지나는 길이고 seq 로 접는
    // 마지막 쓰기 우선이다(수리 전과 같다). 가드를 거기에 두면 그 길이 같이 막힌다.
    const merged = reconcileMessages(tombstonedWindow(), [editOf(10, LATE_BODY)]);

    expect(merged.messages[0].body).toBe(LATE_BODY);
  });

  it("묘비만 막는다 — 이미 고친 줄은 또 고쳐진다", () => {
    const state = fold([
      tailRow(11),
      tailRow(10, {
        state: "edited",
        editedAtMs: 1_700_000_050_000,
        body: "한 번 고친 글",
      }),
    ]);

    const after = applyEditedMessage(state, editOf(10, "두 번째로 고친 글"));

    expect(after).not.toBe(state);
    expect(after.messages[0].body).toBe("두 번째로 고친 글");
    expect(after.messages[0].state).toBe("edited");
  });

  it.each([
    { tombstoned: 10, edited: 11, label: "묘비가 앞 줄, 편집이 뒤 줄" },
    { tombstoned: 11, edited: 10, label: "묘비가 뒤 줄, 편집이 앞 줄" },
  ])(
    "지워진 줄 하나만 무시한다 — 같은 창의 다른 줄의 편집은 적용된다 ($label)",
    ({ tombstoned, edited }) => {
      const state = applyTombstone(window10to11(), tailRow(tombstoned).id, DELETED_AT);

      const after = applyEditedMessage(state, editOf(edited, "산 줄의 편집"));

      expect(after.messages.map((m) => m.seq)).toEqual([10, 11]);
      const dead = after.messages.find((m) => m.seq === tombstoned);
      const live = after.messages.find((m) => m.seq === edited);
      expect(dead?.state).toBe("deleted");
      expect(dead?.body).toBeUndefined();
      expect(live?.state).toBe("edited");
      expect(live?.body).toBe("산 줄의 편집");
    }
  );
});
