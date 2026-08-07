import { describe, expect, it } from "vitest";

import type { Message } from "../../lib/api";
import { TURN_STATUS_LABEL } from "./agentCardModel";
import {
  STREAM_CANCELLED_MARK,
  STREAM_CUT_OFF_MARK,
  STREAM_PROPS_KEY,
  streamMarker,
  streamStopMark,
} from "./streamStop";

function message(props?: Record<string, unknown>): Message {
  return {
    id: "m1",
    channelId: "c1",
    seq: 7,
    hlcTs: 1,
    hlcCount: 0,
    authorMemberId: "agent",
    type: "text",
    body: "답을 절반쯤 쓰다가",
    state: "sent",
    createdAtMs: 1,
    ...(props ? { props } : {}),
  };
}

function streamed(marker: Record<string, unknown>): Message {
  return message({ [STREAM_PROPS_KEY]: marker });
}

describe("streamMarker", () => {
  it("한 번도 스트리밍하지 않은 메시지에는 도장이 없다", () => {
    expect(streamMarker(message())).toBeNull();
    expect(streamMarker(message({ kind: "resume_offer" }))).toBeNull();
  });

  it("마지막 조각이 끝나도 도장은 남는다", () => {
    // 서버가 키를 지우지 않고 `streaming: false` 로 눕히는 이유가 이것이다:
    // 마지막 프레임만 본 클라이언트도 「이 메시지는 조립된 것」을 안다.
    expect(streamMarker(streamed({ rev: 17, streaming: false }))).toEqual({
      rev: 17,
      streaming: false,
      outcome: null,
    });
  });

  it("정의되지 않은 outcome 은 말하지 않는다", () => {
    // 서버가 두 값만 받으므로 도달할 수 없는 모양이다. 도달했다면 낯선 토큰을
    // 채널에 그리는 것보다 침묵이 낫다.
    expect(
      streamMarker(streamed({ rev: 3, streaming: false, outcome: "abandoned" }))
        ?.outcome,
    ).toBeNull();
  });
});

describe("streamStopMark", () => {
  it("잘 끝난 답에는 아무 말도 붙지 않는다", () => {
    expect(streamStopMark(streamed({ rev: 17, streaming: false }), true)).toBeNull();
  });

  it("도착 중인 답에는 아무 말도 붙지 않는다", () => {
    expect(streamStopMark(streamed({ rev: 4, streaming: true }), false)).toBeNull();
  });

  it("사람이 친 글은 run 이 끝나 있어도 건드리지 않는다", () => {
    expect(streamStopMark(message(), true)).toBeNull();
  });

  it("취소 도장은 사람의 행위를 말한다", () => {
    expect(
      streamStopMark(
        streamed({ rev: 5, streaming: false, outcome: "cancelled" }),
        true,
      ),
    ).toBe(STREAM_CANCELLED_MARK);
  });

  it("사망 도장은 끊김을 말한다", () => {
    expect(
      streamStopMark(
        streamed({ rev: 5, streaming: false, outcome: "failed" }),
        true,
      ),
    ).toBe(STREAM_CUT_OFF_MARK);
  });

  /**
   * **RED proof — 방어 렌더링.**
   *
   * 닫는 PATCH 는 best effort 다. 워커가 그 한 번의 쓰기에서 죽으면 메시지는
   * `streaming: true` 인 채로 남고, 도장은 영영 오지 않는다. 이 단정을 지우면
   * (혹은 판정을 `outcome` 하나로 좁히면) 그 메시지는 **영원히 도착 중인 답**으로
   * 그려진다 — 커서가 깜빡이고, 아무것도 오지 않고, 아무도 그것이 끝났다는 것을
   * 배우지 못한다. 오류도, 로그도, 실패한 요청도 없다.
   *
   * 서버 sweeper 를 두지 않기로 한 대가가 정확히 이 한 줄이다.
   */
  it("run 이 끝났는데 stream 이 열려 있으면 같은 꼬리를 그린다", () => {
    const orphan = streamed({ rev: 9, streaming: true });
    expect(streamStopMark(orphan, true)).toBe(STREAM_CUT_OFF_MARK);
    expect(
      streamStopMark(orphan, false),
      "run 이 살아 있는 동안은 그냥 도착 중이다",
    ).toBeNull();
  });

  /**
   * 이미 도장이 찍힌 메시지는 run 상태를 되묻지 않는다. 메시지가 자기서술적이라는
   * 것이 이 ADR 이 `outcome` 을 run 테이블이 아니라 메시지에 둔 이유다 — 히스토리
   * 독자는 run 을 조회할 수 없다.
   */
  it("도장이 있으면 run 을 몰라도 그린다", () => {
    expect(
      streamStopMark(
        streamed({ rev: 5, streaming: false, outcome: "cancelled" }),
        false,
      ),
    ).toBe(STREAM_CANCELLED_MARK);
  });

  /**
   * 한 사건에 한 낱말. 턴 칩이 「중단됨」이라고 말하는 그 취소를 꼬리가 다른 말로
   * 부르면, 같은 화면에서 같은 일이 두 이름을 갖는다.
   */
  it("취소를 부르는 낱말은 턴 칩과 같다", () => {
    expect(STREAM_CANCELLED_MARK).toBe(TURN_STATUS_LABEL.cancelled);
  });
});
