import { describe, expect, it } from "vitest";

import type { Message } from "../../lib/api";
import { dividerText } from "./divider";
import {
  deletedFoldLabel,
  deletedFoldSegments,
  foldDeletedRuns,
  foldedStandInIndex,
  type DeletedRowFacts,
  type MessageStreamItem,
} from "./deletedFold";
import type { TimelineStreamItem } from "./model";

// =============================================================================
// 삭제 접기의 판정 — 코어 승격분 (U4-6, #1100 이탈 1)
//
// 이 규칙이 폰 로컬에 있던 동안 그 파일의 테스트도 폰에 있었다. 승격하면서 그
// 단정들을 여기로 옮기고 **하나를 더 붙인다**: 대리 착지가 접힌 것만 답하는가
// (#1105 인계 — 「진짜 없는 것은 여전히 없다」). 그 단정이 없으면 승격판이
// 「못 찾은 것을 아무 데나 착지시킨다」로 조용히 넓어질 수 있고, 그것은 U4-5 가
// 고친 거짓 지시를 방향만 바꿔 되살리는 일이다.
// =============================================================================

const CH = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const SELF = "11111111-1111-4111-8111-111111111111";
const BASE_MS = 1_700_000_000_000;

function message(over: Partial<Message> & { id: string; seq: number }): Message {
  return {
    channelId: CH,
    hlcTs: over.seq,
    hlcCount: 0,
    authorMemberId: SELF,
    type: "text",
    body: `메시지 ${over.seq}`,
    state: "sent",
    createdAtMs: BASE_MS + over.seq * 1000,
    ...over,
  };
}

const NO_EXTRAS = (): DeletedRowFacts => ({
  hasRollup: false,
  hasReactions: false,
});

function deletedItem(seq: number, startsGroup: boolean): TimelineStreamItem {
  return {
    kind: "message",
    key: `m-${seq}`,
    message: message({ id: `m-${seq}`, seq, state: "deleted", body: "" }),
    startsGroup,
  };
}

function liveItem(seq: number): TimelineStreamItem {
  return {
    kind: "message",
    key: `m-${seq}`,
    message: message({ id: `m-${seq}`, seq }),
    startsGroup: false,
  };
}

function repeats(items: ReturnType<typeof foldDeletedRuns>): unknown[] {
  return items.map((item) => item.deletedRepeat);
}

describe("foldDeletedRuns", () => {
  it("셋이 하나가 되고, 살아남은 행이 셋을 대신한다고 말한다", () => {
    const folded = foldDeletedRuns(
      [deletedItem(1, true), deletedItem(2, false), deletedItem(3, false)],
      NO_EXTRAS
    );
    expect(folded).toHaveLength(1);
    expect(folded[0].deletedRepeat).toBe(3);
  });

  it("묶음의 머리는 접지 않는다 — 접으면 「누가 지웠는가」가 사라진다", () => {
    const folded = foldDeletedRuns(
      [deletedItem(1, true), deletedItem(2, true)],
      NO_EXTRAS
    );
    expect(folded).toHaveLength(2);
    expect(folded[0].deletedRepeat).toBeUndefined();
  });

  it("살아 있는 메시지가 사이에 들어오면 「연달아」가 아니다", () => {
    const folded = foldDeletedRuns(
      [
        deletedItem(1, true),
        deletedItem(2, false),
        liveItem(3),
        deletedItem(4, false),
        deletedItem(5, false),
      ],
      NO_EXTRAS
    );
    expect(repeats(folded)).toEqual([2, undefined, 2]);
  });

  it("구분선도 묶음을 끊는다", () => {
    const folded = foldDeletedRuns(
      [
        deletedItem(1, true),
        { kind: "day", key: "day-1", atMs: BASE_MS },
        deletedItem(2, false),
      ],
      NO_EXTRAS
    );
    expect(folded).toHaveLength(3);
  });

  it("답글이 달린 묘비는 접지 않는다 — 문을 접어 없애는 일이 된다", () => {
    const folded = foldDeletedRuns(
      [deletedItem(1, true), deletedItem(2, false), deletedItem(3, false)],
      (item: MessageStreamItem) => ({
        hasRollup: item.message.seq === 2,
        hasReactions: false,
      })
    );
    // 1 은 혼자, 2 는 자기 자리를 지키고, 3 은 2 밑으로 접힌다.
    expect(folded).toHaveLength(2);
    expect(folded[0].deletedRepeat).toBeUndefined();
    expect(folded[1].deletedRepeat).toBe(2);
  });

  it("반응이 달린 묘비도 접지 않는다", () => {
    const folded = foldDeletedRuns(
      [deletedItem(1, true), deletedItem(2, false)],
      (item: MessageStreamItem) => ({
        hasRollup: false,
        hasReactions: item.message.seq === 2,
      })
    );
    expect(folded).toHaveLength(2);
  });

  it("입력 배열을 건드리지 않는다 — 접기는 스트림에서만 일어난다", () => {
    const input = [deletedItem(1, true), deletedItem(2, false)];
    const snapshot = JSON.stringify(input);
    foldDeletedRuns(input, NO_EXTRAS);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// 대리 착지 (#1105) — 승격이 되돌려서는 안 되는 계약
// ---------------------------------------------------------------------------

describe("foldedStandInIndex", () => {
  it("접힌 행이 자기가 흡수한 id 를 든다 — 자기 것은 빼고", () => {
    const folded = foldDeletedRuns(
      [deletedItem(1, true), deletedItem(2, false), deletedItem(3, false)],
      NO_EXTRAS
    );
    expect(folded[0].deletedFoldedIds).toEqual(["m-2", "m-3"]);
  });

  it("대신 서는 행을 id 로 되찾는다 — 대소문자를 접는다", () => {
    const folded = foldDeletedRuns(
      [
        liveItem(1),
        deletedItem(2, true),
        deletedItem(3, false),
        deletedItem(4, false),
      ],
      NO_EXTRAS
    );
    // `m-3` 은 목록에 자기 행이 없다. 그것을 대신해 서 있는 행은 `m-2` 다.
    expect(foldedStandInIndex(folded, "M-3")).toBe(1);
    // 자기 행이 그대로 있는 것은 이 함수의 질문이 아니다(호출자의 findIndex).
    expect(foldedStandInIndex(folded, "m-2")).toBe(-1);
  });

  /**
   * **진짜 없는 것은 여전히 없다** (#1105 의 네 번째 red proof).
   *
   * 이 단정이 대리 착지를 정직하게 만든다. 접힌 것을 찾아 주는 함수가 「못 찾으면
   * 아무거나」로 넓어지면, 아직 불러오지도 않은 옛 메시지를 가리킨 인용이 엉뚱한
   * 묘비에 착지하고 화면은 그것을 원본이라고 말한다 — U4-5 가 고친 거짓 지시가
   * 방향만 바꿔 돌아오는 것이다. 호출자의 「더 위쪽에 있습니다」가 참인 자리는
   * 정확히 여기서 `-1` 이 나오는 경우다.
   */
  it("로드되지 않은 메시지에는 -1 — 접힌 것만 답한다", () => {
    const folded = foldDeletedRuns(
      [deletedItem(2, true), deletedItem(3, false)],
      NO_EXTRAS
    );
    expect(foldedStandInIndex(folded, "m-99")).toBe(-1);
    expect(foldedStandInIndex(folded, "")).toBe(-1);
  });

  it("아무것도 접히지 않은 목록에서는 언제나 -1", () => {
    const folded = foldDeletedRuns([liveItem(1), liveItem(2)], NO_EXTRAS);
    expect(foldedStandInIndex(folded, "m-1")).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// 문구 — 두 클라가 같은 문장을 말한다
// ---------------------------------------------------------------------------

describe("deletedFoldLabel", () => {
  it("하나면 세지 않는다 — 「1개」는 개수가 아니라 잡음이다", () => {
    expect(deletedFoldLabel(undefined)).toBe("삭제된 메시지");
    expect(deletedFoldLabel(1)).toBe("삭제된 메시지");
  });

  it("둘 이상이면 개수를 말한다", () => {
    expect(deletedFoldLabel(3)).toBe("삭제된 메시지 3개");
  });

  it("조각을 이어 붙이면 같은 문장이다 — 두 판이 갈라지지 않는다", () => {
    for (const repeat of [undefined, 1, 2, 12]) {
      expect(dividerText(deletedFoldSegments(repeat))).toBe(
        deletedFoldLabel(repeat)
      );
    }
  });

  it("숫자만 figure 다 — 「개」에 자릿폭을 걸면 음절이 벌어진다", () => {
    const segments = deletedFoldSegments(4);
    expect(segments.filter((s) => s.kind === "figure").map((s) => s.text)).toEqual(
      ["4"]
    );
  });
});
