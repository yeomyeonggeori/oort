import { describe, expect, it } from "vitest";
import type { Message, MessageAttachment } from "../../lib/api";
import { payloadToMessage } from "../../lib/realtimeEvents";
import {
  applyTombstone,
  emptyTimeline,
  isStrictlyOrdered,
  reconcileMessages,
} from "./model";

// =============================================================================
// #4441 — 사진 달린 메시지의 글을 고치면 사진 카드가 사라지던 길.
//
// 서버는 편집이 첨부를 건드리지 않는다는 이유로 **편집이 내는 두 투영 모두에서
// 첨부를 뺀다**:
//   - `PATCH …/messages/{id}` 응답 (`routes/messages.rs` `edit`: "Editing a body
//     cannot change what is bound to the message, so the client keeps the file
//     cards it already drew.")
//   - `message.edited` 프레임 (`interaction.rs` `build_message_edited_payload` 에는
//     `attachments` 키가 아예 없다. `emit_message_edited_in_tx` 주석: "both clients
//     merge it by seq over the row they hold")
// 그런데 `reconcileMessages` 는 같은 seq 를 **통째로 덮어쓴다**. 서버가 「클라가
// 이미 그린 카드를 유지한다」고 가정한 자리에서 클라는 덮어써서, 고친 사람의 화면과
// 그 줄을 열어 둔 모든 사람의 화면에서 사진 카드가 사라졌다(새로 고침하면 돌아온다 —
// 기록 페이지는 첨부를 싣는다).
//
// 아래 프레임·응답은 서버가 실제로 내는 키 그대로다. 합성한 `Message` 한 벌로는
// 이 시험이 증명할 것이 없다: 버그는 「키가 없다」는 서버의 사실에 있다.
// =============================================================================

const CH = "00000000-0000-4000-8000-0000000000c1";
const AUTHOR = "00000000-0000-4000-8000-0000000000a1";
const OTHER_AUTHOR = "00000000-0000-4000-8000-0000000000a2";
const ID = "0199aaaa-0000-7000-8000-000000000041";
const ID_OTHER = "0199aaaa-0000-7000-8000-000000000042";

const PHOTO: MessageAttachment = {
  id: "0199aaaa-0000-7000-8000-0000000000f1",
  name: "IMG_0412.jpg",
  mime: "image/jpeg",
  sizeBytes: 183_204,
};
const PHOTO_2: MessageAttachment = {
  id: "0199aaaa-0000-7000-8000-0000000000f2",
  name: "IMG_0413.jpg",
  mime: "image/jpeg",
  sizeBytes: 201_377,
};

/** `build_broadcast_payload` 가 쓰는 `message.new` 의 안쪽 — 첨부는 있을 때만 실린다. */
function newFrame(
  over: Record<string, unknown> = {}
): Parameters<typeof payloadToMessage>[0] {
  return {
    id: ID,
    channel_id: CH,
    seq: 7,
    type: "text",
    body: "점심 먹은 곳 사진이에요",
    author_member_id: AUTHOR,
    hlc_ts: 1_700_000_007_000,
    hlc_count: 0,
    root_id: null,
    reply_to_id: null,
    attachments: [PHOTO],
    ...over,
  } as Parameters<typeof payloadToMessage>[0];
}

/**
 * `build_message_edited_payload` 가 쓰는 `message.edited` 의 안쪽 키 전부.
 * **`attachments` 가 없다** — 이 시험 전체가 그 한 줄의 부재에 대한 것이다.
 */
function editedFrame(
  over: Record<string, unknown> = {}
): Parameters<typeof payloadToMessage>[0] {
  return {
    id: ID,
    channel_id: CH,
    seq: 7,
    hlc_ts: 1_700_000_007_000,
    hlc_count: 0,
    author_member_id: AUTHOR,
    type: "text",
    state: "edited",
    body: "점심 먹은 곳 사진이에요 (가게 이름 추가)",
    props: {},
    root_id: null,
    reply_to_id: null,
    run_id: null,
    client_msg_id: "0199aaaa-0000-7000-8000-0000000000c1",
    created_at_ms: 1_700_000_007_000,
    edited_at_ms: 1_700_000_099_000,
    deleted_at_ms: null,
    ...over,
  } as Parameters<typeof payloadToMessage>[0];
}

/** 기록 페이지가 싣는 행 — 첨부가 있으면 `attachments` 가 실린다. */
function historyRow(over: Partial<Message> = {}): Message {
  return {
    id: ID,
    channelId: CH,
    seq: 7,
    hlcTs: 1_700_000_007_000,
    hlcCount: 0,
    authorMemberId: AUTHOR,
    type: "text",
    body: "점심 먹은 곳 사진이에요",
    state: "sent",
    createdAtMs: 1_700_000_007_000,
    attachments: [PHOTO],
    ...over,
  };
}

/** 첨부 키가 아예 없는 행 — DTO 가 빈 배열의 키를 빼는 모양 그대로. */
function withoutAttachments(row: Message): Message {
  const { attachments: _attachments, ...rest } = row;
  return rest;
}

/** `PATCH` 응답 — 서버가 `attachments` 에 `&[]` 를 넘기고 DTO 가 빈 배열의 키를 뺀다. */
function patchResponse(over: Partial<Message> = {}): Message {
  return {
    ...withoutAttachments(historyRow()),
    body: "점심 먹은 곳 사진이에요 (가게 이름 추가)",
    state: "edited",
    editedAtMs: 1_700_000_099_000,
    ...over,
  };
}

function fold(...batches: Message[][]) {
  return batches.reduce(
    (state, batch) => reconcileMessages(state, batch),
    emptyTimeline()
  );
}

describe("편집은 첨부를 건드리지 않는다 — 이미 든 첨부를 지킨다 (#4441)", () => {
  it("message.edited 프레임에 첨부 키가 없어도 사진은 남고, 글과 수정 표시는 새것이 된다", () => {
    const state = fold(
      [payloadToMessage(newFrame())],
      [payloadToMessage(editedFrame())]
    );

    expect(state.messages).toHaveLength(1);
    const row = state.messages[0];
    // 사진: 이 시험이 잡는 버그.
    expect(row.attachments).toEqual([PHOTO]);
    // 글·표시: 「들어온 행을 통째로 무시」하는 가짜 수리를 막는다. 편집이 실제로
    // 적용됐다는 증거가 같은 단정 안에 있어야 사진이 남은 것이 「편집이 안 먹어서」가
    // 아니게 된다.
    expect(row.body).toBe("점심 먹은 곳 사진이에요 (가게 이름 추가)");
    expect(row.state).toBe("edited");
    expect(row.editedAtMs).toBe(1_700_000_099_000);
  });

  it("기록 페이지로 읽은 사진 행에 편집 프레임이 와도 같다 — 그 줄을 열어 둔 다른 기기", () => {
    const state = fold([historyRow()], [payloadToMessage(editedFrame())]);

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].attachments).toEqual([PHOTO]);
    expect(state.messages[0].body).toBe("점심 먹은 곳 사진이에요 (가게 이름 추가)");
  });

  it("PATCH 응답이 덮어써도 같다 — 고친 사람 자신의 화면", () => {
    const state = fold([historyRow()], [patchResponse()]);

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].attachments).toEqual([PHOTO]);
    expect(state.messages[0].body).toBe("점심 먹은 곳 사진이에요 (가게 이름 추가)");
    expect(state.messages[0].state).toBe("edited");
  });

  it("두 번 고쳐도, 응답과 프레임이 같은 편집을 두 번 알려도 남는다", () => {
    const second = "점심 먹은 곳 사진이에요 (가게 이름·층 추가)";
    const state = fold(
      [historyRow()],
      [patchResponse()],
      [payloadToMessage(editedFrame())],
      [payloadToMessage(editedFrame({ body: second, edited_at_ms: 1_700_000_199_000 }))]
    );

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].attachments).toEqual([PHOTO]);
    expect(state.messages[0].body).toBe(second);
  });

  it("수정 표시가 없는 message.edited(스트림 조각·props 만 바꾼 갱신)도 첨부를 지우지 않는다", () => {
    // `stream_message_body_in_tx`·`emit_message_edited_in_tx` 는 같은 `message.edited`
    // 를 사람 편집 표지를 더하지 않고 낸다: 프레임은 행의 현재 값을 그대로 싣는다(고친
    // 적 없는 행이면 `state` 는 `sent`, `edited_at_ms` 는 null). 「수정됨」 표지에 걸어서
    // 지키면 이 프레임들이 같은 병을 그대로 앓는다.
    const state = fold(
      [historyRow()],
      [
        payloadToMessage(
          editedFrame({ state: "sent", edited_at_ms: null, props: { note: "갱신" } })
        ),
      ]
    );

    expect(state.messages[0].attachments).toEqual([PHOTO]);
    expect(state.messages[0].props).toEqual({ note: "갱신" });
  });

  it("들어온 행이 첨부를 직접 말하면 그 말이 이긴다 — 합치지 않는다", () => {
    const state = fold([historyRow()], [historyRow({ attachments: [PHOTO_2] })]);

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].attachments).toEqual([PHOTO_2]);
  });

  it("빈 배열은 첨부를 말한 것이 아니다 — 키를 빼는 서버와 같은 답", () => {
    const state = fold([historyRow()], [patchResponse({ attachments: [] })]);

    expect(state.messages[0].attachments).toEqual([PHOTO]);
  });

  it("첨부가 없던 행은 편집 뒤에도 첨부가 없다 — 없는 것을 만들어 내지 않는다", () => {
    const state = fold(
      [withoutAttachments(historyRow())],
      [payloadToMessage(editedFrame())]
    );

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].body).toBe("점심 먹은 곳 사진이에요 (가게 이름 추가)");
    expect("attachments" in state.messages[0]).toBe(false);
  });

  it("seq 가 같아도 id 가 다른 메시지면 첨부를 물려받지 않는다", () => {
    const state = fold(
      [historyRow()],
      [payloadToMessage(editedFrame({ id: ID_OTHER, author_member_id: OTHER_AUTHOR }))]
    );

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].id).toBe(ID_OTHER);
    expect("attachments" in state.messages[0]).toBe(false);
  });

  it("id 의 대소문자가 달라도 같은 메시지다", () => {
    const state = fold(
      [historyRow()],
      [payloadToMessage(editedFrame({ id: ID.toUpperCase() }))]
    );

    expect(state.messages[0].attachments).toEqual([PHOTO]);
  });

  it("DELETE 응답 묘비는 옛 첨부를 이어받지 않는다 — 들어온 행이 묘비면 편집 보존은 해당 없다", () => {
    // DELETE 응답은 본문도 첨부도 없는 묘비다(`routes/messages.rs` `delete_message`:
    // "A tombstone names no files"). 편집 보존은 편집에만 해당한다.
    const tombstone: Message = {
      ...withoutAttachments(historyRow()),
      state: "deleted",
      body: undefined,
      deletedAtMs: 1_700_000_300_000,
    };
    const state = fold([historyRow()], [tombstone]);

    expect(state.messages[0].state).toBe("deleted");
    expect("attachments" in state.messages[0]).toBe(false);
  });

  // 든 행이 묘비일 때 — 실시간 묘비(`applyTombstone`)는 `...existing` 이라 첨부를 그대로
  // 들고, 기록 페이지의 묘비도 서버 조인에 메시지 상태 조건이 없어 첨부를 싣고 온다
  // (화면은 `deleted` 에서 카드를 그리지 않는다). 그 첨부를 늦게 온 편집 프레임이 새
  // 행으로 되살리면 안 된다 — 본문이 마지막 쓰기로 돌아오는 것은 수리 전부터의 동작이고,
  // 이 수리가 그 경로에 더하는 것은 0 이어야 한다.
  //
  // 아래 시험들이 못 박는 것은 「묘비에 첨부가 되살아나지 않는다」 하나다. `body` 복귀
  // 단정은 늦은 프레임이 **적용됐다**는 증거(무시됐다면 묘비의 첨부가 남아 어차피
  // 빨개진다)이자 수리 전 마지막 쓰기 우선을 그대로 잰 것이라, 훗날 묘비를 고정하는 수리가
  // 들어오면 본문 단정만 지우고 첨부 단정은 남기면 된다.
  const lateFrames = [
    { label: "편집 프레임", frame: () => editedFrame() },
    {
      // 서버는 묘비에 이런 프레임을 못 만들지만(편집·스트림 모두 거절), 가드가 `edited`
      // 표지에 걸려 있지 않다는 것을 못 박는다.
      label: "수정 표시 없는 갱신 프레임",
      frame: () => editedFrame({ state: "sent", edited_at_ms: null }),
    },
  ];

  it.each(lateFrames)(
    "실시간 묘비가 든 첨부를, 늦게 온 $label 이 되살리지 않는다",
    ({ frame }) => {
      const tombstoned = applyTombstone(fold([historyRow()]), ID, 1_700_000_300_000);
      // 전제: 이 묘비는 첨부를 들고 있다. 이 단정이 없으면 아래 단정이 헛돈다.
      expect(tombstoned.messages[0].state).toBe("deleted");
      expect(tombstoned.messages[0].attachments).toEqual([PHOTO]);

      const after = reconcileMessages(tombstoned, [payloadToMessage(frame())]);

      expect(after.messages).toHaveLength(1);
      expect(after.messages[0].body).toBe("점심 먹은 곳 사진이에요 (가게 이름 추가)");
      expect("attachments" in after.messages[0]).toBe(false);
    }
  );

  it.each(lateFrames)(
    "기록 페이지가 첨부를 실어 온 묘비도 마찬가지다 — 늦게 온 $label",
    ({ frame }) => {
      const heldTombstone = historyRow({
        state: "deleted",
        body: undefined,
        deletedAtMs: 1_700_000_300_000,
      });
      expect(heldTombstone.attachments).toEqual([PHOTO]);

      const state = fold([heldTombstone], [payloadToMessage(frame())]);

      expect(state.messages).toHaveLength(1);
      expect(state.messages[0].body).toBe("점심 먹은 곳 사진이에요 (가게 이름 추가)");
      expect("attachments" in state.messages[0]).toBe(false);
    }
  );

  // 글 없이 사진만 보낸 메시지(#4294)는 카드가 사라지면 메시지가 통째로 빈다 — 가장
  // 아픈 경우다. 「본문이 없으면 묘비」 같은 그럴듯한 오구현이 여기서 잡힌다.
  describe("글 없이 사진만 보낸 메시지", () => {
    const photoOnly = () => historyRow({ body: undefined });

    it("나중에 글을 달아 고쳐도 사진이 남는다", () => {
      const state = fold([photoOnly()], [payloadToMessage(editedFrame())]);

      expect(state.messages).toHaveLength(1);
      expect(state.messages[0].body).toBe("점심 먹은 곳 사진이에요 (가게 이름 추가)");
      expect(state.messages[0].state).toBe("edited");
      expect(state.messages[0].attachments).toEqual([PHOTO]);
    });

    it("본문이 비어 나오는 갱신 프레임(props 만 바뀜)도 사진을 지우지 않는다 — 본문 없음은 묘비가 아니다", () => {
      const state = fold(
        [photoOnly()],
        [
          payloadToMessage(
            editedFrame({
              state: "sent",
              body: null,
              edited_at_ms: null,
              props: { note: "갱신" },
            })
          ),
        ]
      );

      expect(state.messages).toHaveLength(1);
      expect(state.messages[0].state).toBe("sent");
      expect(state.messages[0].body).toBeUndefined();
      expect(state.messages[0].props).toEqual({ note: "갱신" });
      expect(state.messages[0].attachments).toEqual([PHOTO]);
    });
  });

  it("타입 밖 입력(attachments: null)에도 던지지 않는다 — null 도 말하지 않은 것이다", () => {
    // 이 입력을 만드는 생산자는 없다(DTO 는 빈 배열의 키를 빼고 `attachmentsFromWire` 는
    // 배열만 낸다). 그래도 접기는 모든 실시간 프레임이 지나는 리듀서라서, 수리가
    // 거기에 새 던질 자리를 만들지 않는다는 것을 못 박는다.
    const nullIncoming = {
      ...withoutAttachments(historyRow()),
      attachments: null,
    } as unknown as Message;
    const nullHeld = {
      ...withoutAttachments(historyRow()),
      attachments: null,
    } as unknown as Message;

    expect(() => fold([historyRow()], [nullIncoming])).not.toThrow();
    expect(fold([historyRow()], [nullIncoming]).messages[0].attachments).toEqual([PHOTO]);

    expect(() => fold([nullHeld], [payloadToMessage(editedFrame())])).not.toThrow();
    expect(
      "attachments" in fold([nullHeld], [payloadToMessage(editedFrame())]).messages[0]
    ).toBe(false);
  });

  it("들어온 행과 이전 state 를 바꾸지 않는다 — 새 행을 만든다", () => {
    const before = fold([historyRow()]);
    const incoming = patchResponse();
    const snapshot = JSON.stringify({ before, incoming });

    const after = reconcileMessages(before, [incoming]);

    expect(JSON.stringify({ before, incoming })).toBe(snapshot);
    expect("attachments" in incoming).toBe(false);
    expect(after).not.toBe(before);
    expect(after.messages[0]).not.toBe(incoming);
    // 전제: 위 불변 단정이 지나간 길이 「잇는 길」이다.
    expect(after.messages[0].attachments).toEqual([PHOTO]);
  });

  it("순서·중복의 불변식은 그대로다 — 편집 묶음이 와도 한 줄이고 seq 오름차순이다", () => {
    const rows = [6, 7, 8].map((seq) => {
      const row = historyRow({
        id: `0199aaaa-0000-7000-8000-00000000006${seq}`,
        seq,
        body: `메시지 ${seq}`,
      });
      return seq === 7 ? row : withoutAttachments(row);
    });
    const state = fold(
      // 첫 묶음부터 뒤섞여 온다(접기는 「어떤 순서든」 받는다). 이미 오름차순인 묶음으로는
      // 아래 오름차순 단정이 실패할 수 없다.
      [rows[1], rows[2], rows[0]],
      // 편집 프레임도 순서를 뒤섞어 한꺼번에 온다.
      [
        payloadToMessage(editedFrame({ id: rows[2].id, seq: 8, body: "고침 8" })),
        payloadToMessage(editedFrame({ id: rows[1].id, seq: 7, body: "고침 7" })),
      ]
    );

    expect(state.messages.map((m) => m.seq)).toEqual([6, 7, 8]);
    expect(isStrictlyOrdered(state.messages)).toBe(true);
    expect(state.messages.map((m) => m.body)).toEqual(["메시지 6", "고침 7", "고침 8"]);
    expect(state.messages[1].attachments).toEqual([PHOTO]);
    expect(state.oldestSeq).toBe(6);
    expect(state.newestSeq).toBe(8);
  });
});
