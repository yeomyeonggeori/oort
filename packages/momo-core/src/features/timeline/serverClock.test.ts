// #5624 — 서버 시계 어림과, 에코의 묶음을 확정본이 잇는 장부. 화면 쪽 재현은 웹 `useTimeline.echoSkew.test.tsx`(실제 훅)이 맡고,
// 여기서는 두 코어 함수가 숫자로 무엇을 하는지만 잰다.

import { afterEach, describe, expect, it } from "vitest";
import type { Message } from "../../lib/api";
import {
  buildTimelineItems,
  dayKey,
  pinSettledEchoes,
  type EchoPins,
  type PendingMessage,
  type TimelineItem,
} from "./model";
import {
  SERVER_CLOCK_MAX_ROUND_TRIP_MS,
  observeServerClock,
  resetServerClockForTests,
  serverClockOffsetMs,
  serverClockOffsetNowMs,
  serverNowMs,
} from "./serverClock";

const ME = "00000000-0000-7000-8000-0000000001ff";
const at = (m: number, s: number, ms = 0) => new Date(2026, 10, 9, 10, m, s, ms).getTime();

function message(seq: number, body: string, createdAtMs: number): Message {
  return {
    id: `00000000-0000-7000-8000-${String(seq).padStart(12, "0")}`,
    channelId: "c",
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: ME,
    type: "text",
    body,
    state: "sent",
    createdAtMs,
  };
}

function echo(id: string, body: string, createdAtMs: number, sinceSeq: number | null = 0): PendingMessage {
  return { clientMsgId: id, channelId: "c", authorMemberId: ME, body, createdAtMs, sinceSeq, status: "sending" };
}

afterEach(() => resetServerClockForTests());

describe("serverClock — 보내기 응답 하나로 잰 서버와 기기의 차이", () => {
  it("요청과 답의 가운데를 서버가 찍은 시각에서 뺀다", () => {
    expect(serverClockOffsetMs({ sentAtMs: 1_000, receivedAtMs: 1_400, serverAtMs: 91_200 })).toBe(90_000);
    expect(serverClockOffsetMs({ sentAtMs: 1_000, receivedAtMs: 1_400, serverAtMs: -88_800 })).toBe(-90_000);
  });

  it("쓸 수 없는 표본은 버린다: 답이 요청보다 먼저 옴, 왕복이 너무 김, 수가 아님", () => {
    expect(serverClockOffsetMs({ sentAtMs: 2_000, receivedAtMs: 1_999, serverAtMs: 5_000 })).toBeNull();
    expect(
      serverClockOffsetMs({ sentAtMs: 0, receivedAtMs: SERVER_CLOCK_MAX_ROUND_TRIP_MS + 1, serverAtMs: 5_000 })
    ).toBeNull();
    expect(serverClockOffsetMs({ sentAtMs: 0, receivedAtMs: SERVER_CLOCK_MAX_ROUND_TRIP_MS, serverAtMs: 0 })).toBe(
      -SERVER_CLOCK_MAX_ROUND_TRIP_MS / 2
    );
    expect(serverClockOffsetMs({ sentAtMs: 0, receivedAtMs: 10, serverAtMs: Number.NaN })).toBeNull();
  });

  it("가장 최근에 쓸 수 있었던 표본이 이기고, 버린 표본은 값을 바꾸지 않는다", () => {
    expect(serverClockOffsetNowMs()).toBe(0);
    expect(serverNowMs(5_000)).toBe(5_000);
    expect(observeServerClock({ sentAtMs: 0, receivedAtMs: 200, serverAtMs: 90_100 })).toBe(true);
    expect(serverNowMs(5_000)).toBe(95_000);
    // 다시 보낸 요청의 응답(지난 시각)처럼 왕복이 긴 표본은 버린다.
    expect(observeServerClock({ sentAtMs: 0, receivedAtMs: 60_000, serverAtMs: 10 })).toBe(false);
    expect(serverClockOffsetNowMs()).toBe(90_000);
    // 기기 시계가 세션 중에 뛰었다: 새 표본이 그대로 이긴다.
    expect(observeServerClock({ sentAtMs: 10_000, receivedAtMs: 10_100, serverAtMs: 10_050 })).toBe(true);
    expect(serverClockOffsetNowMs()).toBe(0);
  });
});

describe("pinSettledEchoes — 확정본이 에코의 시각을 잇는 장부", () => {
  it("직전 렌더가 쓴 차이로 에코의 시각을 적고, 이은 짝을 돌려준다", () => {
    const row = echo("k1", "안녕", at(47, 59, 800));
    const confirmed = message(1, "안녕", at(48, 0, 100));
    const { pins, settled } = pinSettledEchoes(new Map(), [confirmed], [row], 250);
    expect(pins.get(confirmed.id)).toEqual({ atMs: at(47, 59, 800) + 250, clientMsgId: "k1" });
    expect(settled).toEqual([{ message: confirmed, pending: row }]);
  });

  it("같은 글을 두 번 보냈을 때 둘째 확정본이 이미 이어진 첫 에코를 가로채지 않는다", () => {
    const one = echo("k1", "네", at(47, 10));
    const two = echo("k2", "네", at(47, 11));
    const first = pinSettledEchoes(new Map(), [message(1, "네", at(48, 40))], [one, two]);
    // 보내기 응답과 실시간 프레임이 같은 확정본을 다시 들여도 장부는 그대로다(같은 객체).
    expect(pinSettledEchoes(first.pins, [message(1, "네", at(48, 40))], [one, two]).pins).toBe(first.pins);
    const second = pinSettledEchoes(first.pins, [message(2, "네", at(48, 41))], [one, two]);
    expect(second.pins.get(message(2, "네", 0).id)?.clientMsgId).toBe("k2");
    expect(second.settled.map((pair) => pair.pending.clientMsgId)).toEqual(["k2"]);
  });

  it("다른 채널의 같은 글은 에코를 잇지 않는다 — 떠난 채널의 에코가 새 채널의 첫 화면 읽기에 짝지어지지 않는다", () => {
    // 채널 c에서 아직 날아가는 「네」(그 채널의 seq 0 위). 새로 연 채널 d의 첫 화면 읽기에 몇 시간 전 내 「네」(seq 5)가 있다.
    const inFlight = echo("k1", "네", at(47, 10));
    const otherChannel: Message = { ...message(5, "네", at(10, 0) - 3 * 3_600_000), channelId: "d" };
    const { pins, settled } = pinSettledEchoes(new Map(), [otherChannel], [inFlight]);
    expect(settled).toEqual([]);
    expect(pins.size).toBe(0);
    // 같은 채널의 확정본은 그대로 잇는다.
    expect(pinSettledEchoes(new Map(), [message(5, "네", at(47, 11))], [inFlight]).settled).toHaveLength(1);
  });

  it("한도를 넘으면 오래된 것부터 잊는다", () => {
    let pins: EchoPins = new Map();
    for (let i = 1; i <= 4; i += 1) {
      pins = pinSettledEchoes(pins, [message(i, `m${i}`, at(47, i))], [echo(`k${i}`, `m${i}`, at(47, i), i - 1)], 0, 3).pins;
    }
    expect([...pins.values()].map((pin) => pin.clientMsgId)).toEqual(["k2", "k3", "k4"]);
  });

  it("장부에 있는 확정본은 자기 머리/이어짐을 에코의 시각으로, 다음 행은 그 행의 서버 시각으로 판정받는다", () => {
    const head = message(1, "47분", at(47, 30));
    const boundary = message(2, "경계", at(48, 0, 100));
    const next = message(3, "48분", at(48, 10));
    const pins: EchoPins = new Map([[boundary.id, { atMs: at(47, 59, 800), clientMsgId: "k2" }]]);
    const heads = (echoPins?: EchoPins) =>
      buildTimelineItems([head, boundary, next], { echoPins }).flatMap((item) =>
        item.kind === "message" ? [item.startsGroup] : []
      );
    // 장부 없이(다시 불러온 화면): 서버 시각으로 묶는다 — 48분에 새 머리.
    expect(heads()).toEqual([true, true, false]);
    // 장부가 있으면 경계의 글은 에코 때처럼 이어진 줄이고, 다음 글은 경계 글의 서버 시각(48분)과 같은 분이라 이어진다.
    expect(heads(pins)).toEqual([true, false, false]);
  });

  it("에코는 지금의 차이를 더해 위 확정본(서버 시각)과 견준다", () => {
    const above = message(1, "앞", at(48, 35));
    const row = echo("k9", "뒤", at(47, 15), 1);
    const startsGroup = (serverOffsetMs: number) =>
      buildTimelineItems([above], { pending: [row], serverOffsetMs }).find((item) => item.kind === "pending")
        ?.startsGroup;
    expect(startsGroup(0)).toBe(true);
    expect(startsGroup(90_000)).toBe(false);
  });
});

// ---- H1(검수 1회차): 오래된 메아리 ------------------------------------------------
//
// 실패한 글은 다시 보내도 처음 시각을 들고 있다(`retryPending`은 상태만 바꾼다, 새로고침 뒤에도 그 시각으로 되살아난다 #5221). 장부가
// 그 시각을 그대로 이으면, 밤에 못 보낸 글을 아침에 다시 보낸 확정본이 어제 날짜로 자기 날 줄을 판정받는다. 날 줄은 언제나 서버 시각이
// 정한다 — 장부는 같은 날 안에서만 머리/이어짐을 잇는다.

const PEER = "00000000-0000-7000-8000-0000000002ff";
const on = (d: number, h: number, m: number, s = 0, ms = 0) => new Date(2026, 10, d, h, m, s, ms).getTime();

function said(seq: number, author: string, body: string, createdAtMs: number): Message {
  return { ...message(seq, body, createdAtMs), authorMemberId: author };
}

/** 그린 줄의 날짜가 맞는가: 키는 겹치지 않고, 날 줄은 시간 순서이고, 확정본마다 바로 위 날 줄이 자기 서버 시각의 날이다. */
function dayIssues(items: TimelineItem[]): string[] {
  const issues: string[] = [];
  const keys = items.map((item) => item.key);
  const repeated = keys.filter((key, index) => keys.indexOf(key) !== index);
  if (repeated.length > 0) issues.push(`겹친 키 ${repeated.join(",")}`);
  let day: string | null = null;
  let dayAt = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    if (item.kind === "day") {
      if (item.atMs <= dayAt) issues.push(`날 줄 순서 ${item.key}`);
      day = item.key;
      dayAt = item.atMs;
    }
    if (item.kind === "message" && day !== `day-${dayKey(item.message.createdAtMs)}`) {
      issues.push(`「${item.message.body}」이 ${day} 아래`);
    }
  }
  return issues;
}

/** 한 글의 머리/이어짐(확정본이든 에코든). */
function headOf(items: TimelineItem[], body: string): boolean | undefined {
  for (const item of items) {
    if (item.kind === "message" && item.message.body === body) return item.startsGroup;
    if (item.kind === "pending" && item.pending.body === body) return item.startsGroup;
  }
  return undefined;
}

describe("H1 — 장부는 날을 넘긴 메아리를 잇지 않는다(날 줄은 서버 시각이 정한다)", () => {
  it("밤에 못 보낸 글을 아침에 다시 보내 확정되면(오늘 남의 말이 이미 있음) 어제 날 줄이 오늘 줄 아래 다시 서지 않는다", () => {
    const failed: PendingMessage = { ...echo("k1", "실패했던 글", on(9, 23, 55), 1), status: "failed" };
    const before = [said(1, PEER, "어제 남의 말", on(9, 23, 50)), said(2, PEER, "오늘 남의 말", on(10, 9, 0))];
    const mine = said(3, ME, "실패했던 글", on(10, 9, 5));
    const { pins } = pinSettledEchoes(new Map(), [mine], [failed]);
    expect(pins.size).toBe(1);
    const items = buildTimelineItems([...before, mine], { echoPins: pins });
    expect(dayIssues(items)).toEqual([]);
    expect(items.filter((item) => item.kind === "day").map((item) => item.key)).toEqual([
      `day-${dayKey(on(9, 0, 0))}`,
      `day-${dayKey(on(10, 0, 0))}`,
    ]);
  });

  it("오늘 말이 없을 때 다시 보낸 글이 확정되면 그 위에 오늘 날 줄이 서고, 뒤에 오는 오늘 말도 오늘 아래에 놓인다", () => {
    const failed: PendingMessage = { ...echo("k1", "실패했던 글", on(9, 23, 55), 1), status: "failed" };
    const mine = said(2, ME, "실패했던 글", on(10, 9, 5));
    const { pins } = pinSettledEchoes(new Map(), [mine], [failed]);
    const items = buildTimelineItems(
      [said(1, PEER, "어제 남의 말", on(9, 23, 50)), mine, said(3, PEER, "그 뒤 남의 말", on(10, 9, 6))],
      { echoPins: pins }
    );
    expect(dayIssues(items)).toEqual([]);
  });

  it("어제 내 글에 이어진 줄이던 메아리도, 다음 날 확정되면 오늘 날 줄 아래 머리로 선다(날 줄 아래 이어진 줄 없음)", () => {
    const failed: PendingMessage = { ...echo("k1", "실패했던 글", on(9, 23, 55, 10), 1), status: "failed" };
    const mineYesterday = said(1, ME, "어제 내 글", on(9, 23, 55));
    expect(headOf(buildTimelineItems([mineYesterday], { pending: [failed] }), "실패했던 글")).toBe(false);
    const mine = said(2, ME, "실패했던 글", on(10, 9, 5));
    const { pins } = pinSettledEchoes(new Map(), [mine], [failed]);
    const items = buildTimelineItems([mineYesterday, mine], { echoPins: pins });
    expect(dayIssues(items)).toEqual([]);
    expect(headOf(items, "실패했던 글")).toBe(true);
  });

  it("자정을 걸친 보내기(기기 23:59:59.8 → 서버 00:00:00.1)도 확정본은 새 날 줄 아래에 선다", () => {
    const mineBefore = said(1, ME, "자정 전 글", on(9, 23, 59, 30));
    const row = echo("k1", "자정의 글", on(9, 23, 59, 59, 800), 1);
    const mine = said(2, ME, "자정의 글", on(10, 0, 0, 0, 100));
    const { pins } = pinSettledEchoes(new Map(), [mine], [row]);
    const items = buildTimelineItems([mineBefore, mine, said(3, PEER, "자정 뒤 남의 말", on(10, 0, 0, 5))], {
      echoPins: pins,
    });
    expect(dayIssues(items)).toEqual([]);
  });

  it("같은 날 한참 뒤 손으로 다시 보낸 글(10:00:30 실패 → 15:00)도 그 화면에서는 메아리 때 묶음을 지킨다 — (가)가 받아 둔 대가", () => {
    // 날 줄은 서버 시각 그대로라 날짜는 맞다. 머리/이어짐은 메아리 때(10:00 머리 아래 이어진 줄)를 지키고, 다시 불러오면 15:00 머리로 선다.
    const head = said(1, ME, "앞 글", on(9, 10, 0, 10));
    const failed: PendingMessage = { ...echo("k1", "실패했던 글", on(9, 10, 0, 30), 1), status: "failed" };
    expect(headOf(buildTimelineItems([head], { pending: [failed] }), "실패했던 글")).toBe(false);
    const mine = said(2, ME, "실패했던 글", on(9, 15, 0, 5));
    const { pins } = pinSettledEchoes(new Map(), [mine], [failed]);
    const items = buildTimelineItems([head, mine], { echoPins: pins });
    expect(dayIssues(items)).toEqual([]);
    expect(headOf(items, "실패했던 글")).toBe(false);
    expect(headOf(buildTimelineItems([head, mine]), "실패했던 글")).toBe(true);
  });

  it("같은 날 안에서는 장부가 그대로 일한다 — 몇 분 뒤 저절로 다시 나간 글의 확정본은 메아리 때 묶음을 지킨다", () => {
    // 10:47:30에 이어 보낸 글이 연결이 끊겨 실패하고, 3분 뒤 저절로 다시 나가 서버가 10:50:31에 찍었다. 좁은 문턱(왕복 몇 초)으로
    // 장부를 끊으면 여기서 확정 순간에 머리가 서며 뒤집힌다.
    const head = said(1, ME, "앞 글", on(9, 10, 47, 10));
    const failed: PendingMessage = { ...echo("k1", "이어 보낸 글", on(9, 10, 47, 30), 1), status: "failed" };
    expect(headOf(buildTimelineItems([head], { pending: [failed] }), "이어 보낸 글")).toBe(false);
    const mine = said(2, ME, "이어 보낸 글", on(9, 10, 50, 31));
    const { pins } = pinSettledEchoes(new Map(), [mine], [failed]);
    const items = buildTimelineItems([head, mine], { echoPins: pins });
    expect(headOf(items, "이어 보낸 글")).toBe(false);
    expect(dayIssues(items)).toEqual([]);
  });
});
