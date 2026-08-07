import { describe, expect, it } from "vitest";
import type { PinnedMessageWire } from "../../lib/api";
import {
  CHANNEL_PIN_LIMIT,
  PIN_EMPTY_BODY_TEXT,
  PIN_LIST_EMPTY_DETAIL,
  PIN_LIST_EMPTY_HEADLINE,
  PIN_LIST_FAILED_DETAIL,
  PIN_LIST_FAILED_HEADLINE,
  PIN_ROW_MARK,
  applyPinned,
  emptyPins,
  isPinned,
  normalizePinList,
  pinActionLabel,
  pinExcerpt,
  pinList,
  pinListHeaderLabel,
  pinListLabel,
  pinStampLabel,
  pinStampSegments,
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

// =============================================================================
// 후속 #1146 — 목록이 하는 말이 참인가.
// =============================================================================

describe("발췌는 사람이 쓴 글을 깨뜨리지 않는다 (#1146 N2)", () => {
  /**
   * **결함 그 자체.** `slice` 는 UTF-16 코드 단위를 세므로 BMP 밖 문자(이모지,
   * 일부 한자)의 서로게이트 쌍 한가운데에 경계가 떨어질 수 있고, 그러면 반쪽
   * 코드 단위가 남아 화면에 `�` 로 선다. 60자짜리 발췌 하나를 위해 원본을
   * 깨뜨리는 것이고, 「발췌는 원본을 대표한다」는 전제가 그때 무너진다.
   */
  it("서로게이트 쌍을 반토막 내지 않는다", () => {
    // 한 글자짜리 이모지 셋. `slice(0, 2)` 는 두 번째 이모지의 앞 절반에서 끊는다.
    const body = "🙂🙃🙂";
    const cut = pinExcerpt(body, 2);
    expect(cut.text).toBe("🙂🙃…");
    expect(cut.text).not.toContain("\uFFFD");
    // 잘린 문자열을 다시 코드포인트로 세면 온전한 글자만 남는다.
    for (const point of Array.from(cut.text)) {
      expect(point.charCodeAt(0)).not.toBeGreaterThanOrEqual(0xdc00);
    }
  });

  /** 한도는 **코드포인트**로 센다. 이모지 하나가 두 글자로 세어지면 안 된다. */
  it("한도를 코드 단위가 아니라 글자로 센다", () => {
    expect(pinExcerpt("🙂🙂🙂", 3).text).toBe("🙂🙂🙂");
    expect(pinExcerpt("🙂🙂🙂", 3).text).not.toContain("…");
  });

  /**
   * 자소까지는 가지 않는다(`Intl.Segmenter` 가 폰의 Hermes 에서 보장되지 않는다).
   * 대신 값싼 절반: 끝에 홀로 남은 연결자·변이 선택자를 떨어낸다 — 허공에 뜬 ZWJ
   * 는 눈에 보이는 파손이고, 「가족이 두 사람으로 잘렸다」는 멀쩡한 글자다.
   */
  it("끝에 남은 연결자를 떨어낸다", () => {
    // 👨(1) + ZWJ(2) 에서 끊기면 연결자가 홀로 남는다.
    const family = "👨\u200D👩\u200D👧";
    const cut = pinExcerpt(family, 2);
    expect(cut.text.includes("\u200D…")).toBe(false);
    expect(cut.text).toBe("👨…");
  });

  it("줄바꿈은 한 줄로 접히고, 본문이 없으면 앱의 문장이 선다", () => {
    expect(pinExcerpt("첫 줄\n\n둘째 줄", 40).text).toBe("첫 줄 둘째 줄");
    expect(pinExcerpt(null, 40)).toEqual({
      text: PIN_EMPTY_BODY_TEXT,
      empty: true,
    });
    expect(pinExcerpt("   ", 40).empty).toBe(true);
  });

  /** 한도 안이면 말줄임을 붙이지 않는다 — 붙이면 없는 뒷말을 약속하는 것이다. */
  it("한도 안의 본문은 그대로 선다", () => {
    expect(pinExcerpt("짧은 글", 40)).toEqual({ text: "짧은 글", empty: false });
  });
});

describe("시각 도장은 정렬 근거다 (#1146 N1)", () => {
  const now = new Date(2026, 7, 5, 12, 0, 0).getTime();
  const flat = (atMs: number): string =>
    pinStampSegments(atMs, now)
      .map((segment) => segment.text)
      .join("");

  it("오늘과 어제는 낱말이고, 그 위는 날짜다", () => {
    expect(flat(now - 60_000)).toBe("오늘");
    expect(flat(now - 86_400_000)).toBe("어제");
    expect(flat(new Date(2026, 6, 29, 9, 0, 0).getTime())).toBe("7월 29일");
  });

  /**
   * **연도가 없던 것이 N1 의 나머지 절반이다.** 채널의 고정은 해를 넘겨 남고,
   * 「12월 31일」은 그것이 작년인지 말하지 않는다. 규칙은 날짜 구분선의 것을
   * 그대로 든다 — 한 앱이 같은 사실에 두 표기를 갖지 않는다.
   */
  it("해가 다르면 연도가 붙는다", () => {
    expect(flat(new Date(2025, 11, 31, 9, 0, 0).getTime())).toBe(
      "2025년 12월 31일"
    );
  });

  /** 숫자와 산문이 갈라져 온다: 자릿폭 표지가 한글 음절을 함께 잡으면 벌어진다. */
  it("숫자만 figure 로 나온다", () => {
    const segments = pinStampSegments(
      new Date(2026, 6, 29, 9, 0, 0).getTime(),
      now
    );
    const figures = segments
      .filter((segment) => segment.kind === "figure")
      .map((segment) => segment.text);
    expect(figures).toEqual(["7", "29"]);
    for (const segment of segments) {
      if (segment.kind === "prose") expect(segment.text).not.toMatch(/[0-9]/);
    }
  });

  /**
   * 귀에는 언제나 절대 날짜다. 그리고 **그것이 고정 시각임을 말한다** — 카드에는
   * 날짜가 두 가지일 수 있고, 낭독에는 어느 열인지 알려 줄 위치가 없다.
   */
  it("낭독 라벨은 절대 날짜에 「고정」을 붙인다", () => {
    expect(pinStampLabel(new Date(2025, 11, 31, 9, 0, 0).getTime())).toBe(
      "2025년 12월 31일에 고정"
    );
    expect(pinStampLabel(now)).toBe("2026년 8월 5일에 고정");
  });
});

describe("못 불러온 목록의 문장 (#1146 M2)", () => {
  /**
   * 두 문장은 **서로 다른 세계**를 서술한다: 빈 문장은 채널에 대한 사실이고
   * (아무도 고정하지 않았다), 실패 문장은 우리에 대한 사실이다(무엇이 고정됐는지
   * 모른다). 하나가 다른 하나를 대신할 수 있으면 그것이 곧 거짓말이다.
   */
  it("실패 문장은 빈 문장과 한 글자도 겹치지 않는다", () => {
    expect(PIN_LIST_FAILED_HEADLINE).not.toBe(PIN_LIST_EMPTY_HEADLINE);
    expect(PIN_LIST_FAILED_HEADLINE).not.toContain("없습니다");
    expect(PIN_LIST_FAILED_HEADLINE).toContain("못");
  });

  /** 무슨 일이 있었는지와 **다음에 할 일**이 갈라져 있다(폰 `ErrorState` 두 칸). */
  /**
   * 그리고 실패했을 때는 **수를 말하지 않는다.** 목록 안에 실패 문장을 세워 놓고
   * 제목이 「고정 3개」라고 말하면, 고친 거짓말이 한 줄 위로 옮겨 간 것뿐이다 —
   * 「3개」는 그것이 전부라는 뜻이고, 전부라는 것은 우리가 모르는 사실이다.
   */
  it("셀 자격은 끝난 읽기에만 있다", () => {
    expect(pinListHeaderLabel(3, "ready")).toBe("고정 3개");
    expect(pinListHeaderLabel(3, "failed")).toBe(pinListLabel(0));
    expect(pinListHeaderLabel(3, "loading")).toBe(pinListLabel(0));
    expect(pinListHeaderLabel(3, "failed")).not.toContain("3");
  });

  it("설명은 제목을 되풀이하지 않고 다음 행동을 말한다", () => {
    expect(PIN_LIST_FAILED_DETAIL).not.toContain(PIN_LIST_FAILED_HEADLINE);
    expect(PIN_LIST_FAILED_DETAIL).toContain("다시");
    expect(PIN_LIST_FAILED_HEADLINE.endsWith(".")).toBe(true);
    expect(PIN_LIST_FAILED_DETAIL.endsWith(".")).toBe(true);
  });
});

describe("행의 흔적 (#1146 M3)", () => {
  /**
   * 「수정됨」과 **같은 격**의 낱말이다: 읽기만 하는 서술이고, 명령이 아니다.
   * 동사형(「고정하기」)이면 그 자리에서 누를 수 있는 것처럼 읽힌다 — 꼬리 줄은
   * 누르는 자리가 아니다.
   */
  it("행의 표지는 서술형이고, 액션 낱말과 다르다", () => {
    expect(PIN_ROW_MARK).toBe("고정됨");
    expect(PIN_ROW_MARK).not.toBe(pinActionLabel(true));
    expect(PIN_ROW_MARK).not.toBe(pinActionLabel(false));
    expect(PIN_ROW_MARK.endsWith("하기")).toBe(false);
  });
});
