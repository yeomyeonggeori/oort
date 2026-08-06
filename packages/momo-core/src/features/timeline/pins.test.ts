import { describe, expect, it } from "vitest";
import type { PinnedMessageWire } from "../../lib/api";
import {
  CHANNEL_PIN_LIMIT,
  PIN_LIST_EMPTY_DETAIL,
  PIN_LIST_EMPTY_HEADLINE,
  applyPinned,
  emptyPins,
  isPinned,
  normalizePinList,
  pinActionLabel,
  pinList,
  pinListLabel,
  removePin,
} from "./pins";

// =============================================================================
// 이슈 #1112 — what this file pins.
//
// The headline is the third test: **a client that applies the realtime frame
// must land on the same state as a client that re-read the list.** That is the
// whole reason `message.pinned` carries the projection instead of an id, and it
// is the assertion that goes red if anyone trims the payload back down.
// =============================================================================

const CHANNEL = "cccccccc-0000-0000-0000-000000000001";
const AUTHOR = "aaaaaaaa-0000-0000-0000-000000000001";
const PINNER = "bbbbbbbb-0000-0000-0000-000000000001";

function wire(over: Partial<PinnedMessageWire> = {}): PinnedMessageWire {
  return {
    messageId: "11111111-0000-0000-0000-000000000001",
    channelId: CHANNEL,
    seq: 12,
    authorMemberId: AUTHOR,
    type: "text",
    state: "sent",
    body: "고정할 메시지",
    createdAtMs: 1_700_000_000_000,
    pinnedBy: PINNER,
    pinnedAtMs: 1_700_000_100_000,
    ...over,
  };
}

describe("고정은 채널의 사실이다", () => {
  /**
   * A reaction is `(message, member, emoji)`; a pin is the message alone. Two
   * people pinning the same message must produce **one** header row — key this
   * map by anything finer and the list doubles the moment a second person
   * agrees with the first.
   */
  it("두 사람이 같은 메시지를 고정해도 한 줄이다", () => {
    let map = applyPinned(emptyPins(), wire());
    const second = applyPinned(map, wire({ pinnedBy: AUTHOR }));
    expect(Object.keys(second)).toHaveLength(1);
    // Same reference, so a surface skips the render for its own echo.
    expect(second).toBe(map);
    expect(second[wire().messageId].pinnedBy).toBe(PINNER);

    // …and anyone may take it back down, including someone who did not pin it.
    map = removePin(second, wire().messageId);
    expect(isPinned(map, wire().messageId)).toBe(false);
  });

  /**
   * Idempotent in both directions, matching the server, and returning the same
   * reference when nothing moved. That is what lets a surface apply BOTH the
   * optimistic update and the realtime echo of one click — which is the normal
   * case, not the edge case.
   */
  it("없는 고정을 해제해도 같은 지도를 돌려준다", () => {
    const map = applyPinned(emptyPins(), wire());
    expect(removePin(map, "99999999-0000-0000-0000-000000000009")).toBe(map);
  });

  /**
   * The fold. `docs/api/openapi.yaml` calls the wire's UUID casing mixed by
   * design, so a map keyed by the raw string cannot find a message under the
   * message's own id — the header row would silently never light up as pinned.
   */
  it("대소문자가 섞여 와도 같은 메시지로 찾는다", () => {
    const map = applyPinned(
      emptyPins(),
      wire({ messageId: "11111111-0000-0000-0000-000000000001".toUpperCase() })
    );
    expect(isPinned(map, "11111111-0000-0000-0000-000000000001")).toBe(true);
    expect(map["11111111-0000-0000-0000-000000000001"].pinnedBy).toBe(PINNER);
  });
});

describe("실시간 프레임과 재조회가 같은 상태에 닿는다", () => {
  /**
   * **Red proof #3, client half.** Two clients see the same channel: one cold
   * loads the list, the other was already open and only received the frames.
   * They must be byte-identical, or the second one is quietly wrong until it
   * reloads — which is exactly the bug "목록 재조회 없이 실시간 갱신" names.
   *
   * Strip `message.pinned` back to an id and this goes red on the deep equality,
   * because the live client would have nothing to draw.
   */
  it("프레임만 받은 클라이언트와 목록을 다시 읽은 클라이언트가 같다", () => {
    const first = wire({
      messageId: "11111111-0000-0000-0000-000000000001",
      pinnedAtMs: 1_700_000_100_000,
    });
    const second = wire({
      messageId: "22222222-0000-0000-0000-000000000002",
      seq: 40,
      body: "나중에 고정한 메시지",
      pinnedAtMs: 1_700_000_200_000,
    });

    // The live client: two frames, in the order they were published.
    let live = emptyPins();
    live = applyPinned(live, first);
    live = applyPinned(live, second);

    // The cold client: one list read, newest pin first, as the server orders it.
    const cold = normalizePinList([second, first]);

    expect(live).toEqual(cold);
    expect(pinList(live)).toEqual(pinList(cold));
    expect(pinList(live).map((entry) => entry.messageId)).toEqual([
      second.messageId,
      first.messageId,
    ]);
  });

  /**
   * Order is by `pinnedAtMs` descending and **not** by arrival, because the two
   * disagree the moment a frame overtakes a cold load. The tiebreak exists so
   * that two pins in the same millisecond still produce one total order rather
   * than two clients drawing different lists.
   */
  it("도착 순서가 아니라 고정 시각으로 줄을 세운다", () => {
    const older = wire({
      messageId: "33333333-0000-0000-0000-000000000003",
      pinnedAtMs: 1_000,
    });
    const newer = wire({
      messageId: "44444444-0000-0000-0000-000000000004",
      pinnedAtMs: 2_000,
    });
    const arrivedBackwards = applyPinned(applyPinned(emptyPins(), older), newer);
    expect(pinList(arrivedBackwards).map((entry) => entry.messageId)).toEqual([
      newer.messageId,
      older.messageId,
    ]);

    const tied = applyPinned(
      applyPinned(emptyPins(), wire({ messageId: "b0000000-0000-0000-0000-000000000001", pinnedAtMs: 5 })),
      wire({ messageId: "a0000000-0000-0000-0000-000000000001", pinnedAtMs: 5 })
    );
    expect(pinList(tied).map((entry) => entry.messageId)).toEqual([
      "a0000000-0000-0000-0000-000000000001",
      "b0000000-0000-0000-0000-000000000001",
    ]);
  });

  /**
   * A header list is an accessory to the channel. One malformed row must not be
   * able to take the conversation down with it, and — more subtly — must not be
   * half-admitted either: an entry with no `pinnedAtMs` would sort as
   * `undefined` and sit at the top of the list forever.
   */
  it("망가진 항목은 통째로 버린다 — 반쯤 그리지 않는다", () => {
    const map = normalizePinList([
      wire(),
      { ...wire({ messageId: "55555555-0000-0000-0000-000000000005" }), pinnedAtMs: undefined } as unknown as PinnedMessageWire,
      null as unknown as PinnedMessageWire,
    ]);
    expect(Object.keys(map)).toEqual([wire().messageId]);
    expect(normalizePinList(undefined)).toEqual({});
  });
});

describe("낱말", () => {
  /**
   * The label is drawn in three places (web menu, web sheet, phone sheet). A
   * label duplicated three times is a label that drifts, so it lives here — and
   * it must be a verb phrase, which the phone's a11y test enforces mechanically.
   */
  it("고정 라벨은 상태에 따라 뒤집히고 둘 다 동사형이다", () => {
    expect(pinActionLabel(false)).toBe("고정하기");
    expect(pinActionLabel(true)).toBe("고정 해제하기");
    expect(pinActionLabel(false)).not.toBe(pinActionLabel(true));
    for (const label of [pinActionLabel(false), pinActionLabel(true)]) {
      expect(label.endsWith("하기")).toBe(true);
    }
  });

  it("헤더 진입점은 개수를 말하고, 없을 때는 개수를 말하지 않는다", () => {
    expect(pinListLabel(3)).toBe("고정 3개");
    expect(pinListLabel(0)).toBe("고정한 메시지");
  });

  /**
   * The empty line names the *action*, not the gesture: web opens the menu with
   * `⋯` and phone with a long press, so a sentence naming either would be wrong
   * on the other surface.
   */
  it("빈 목록 문장은 한쪽 surface의 제스처를 지시하지 않는다", () => {
    for (const line of [PIN_LIST_EMPTY_HEADLINE, PIN_LIST_EMPTY_DETAIL]) {
      expect(line).not.toMatch(/길게|우클릭|⋯|hover/);
      expect(line).toContain("고정");
    }
  });

  /**
   * 두 조각이다. 폰의 `EmptyState` 는 제목과 설명을 따로 받으므로 한 문자열을
   * 둘 다에 넘기면 같은 문장이 두 번 인쇄된다 — 시뮬레이터에서 실제로 그렇게
   * 찍혔다. 그래서 설명은 사실을 되풀이하지 않고 **다음 행동만** 말한다.
   */
  it("설명이 제목을 되풀이하지 않는다", () => {
    expect(PIN_LIST_EMPTY_DETAIL).not.toContain(PIN_LIST_EMPTY_HEADLINE);
    expect(PIN_LIST_EMPTY_HEADLINE.endsWith(".")).toBe(true);
    expect(PIN_LIST_EMPTY_DETAIL.endsWith(".")).toBe(true);
  });

  /** The number the copy names has to be the number the server enforces. */
  it("상한 상수는 서버(061 마이그레이션)와 같은 값이다", () => {
    expect(CHANNEL_PIN_LIMIT).toBe(100);
  });
});
