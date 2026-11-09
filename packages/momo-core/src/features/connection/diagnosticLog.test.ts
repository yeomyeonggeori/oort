import { describe, expect, it } from "vitest";
import { LATE_WAKE_MS, type RestOutcome } from "../../lib/http";
import {
  appendConnectionDiag,
  CONNECTION_DIAG_CAPACITY,
  CONNECTION_DIAG_GROUPS,
  CONNECTION_DIAG_KINDS,
  CONNECTION_DIAG_MAX_AGE_MS,
  connectionDiagToday,
  connectionDiagTransitions,
  formatConnectionDiag,
  parseConnectionDiag,
  restFailureDiagKind,
  serializeConnectionDiag,
  socketDiagKind,
  startOfLocalDay,
  startWakeWatch,
  todayConnectionDiagCounts,
  wakeLateDiagKind,
  type ConnectionDiagEntry,
  type ConnectionDiagKind,
} from "./diagnosticLog";
import {
  deviceEvent,
  eventAction,
  initialConnectionState,
  reduceConnection,
  restEvent,
  socketEvent,
  tickAction,
  type ConnectionAction,
  type ConnectionState,
} from "./screenState";

const NOW = 1_700_000_000_000;
// 기록에 들어가면 안 되는 것의 표본: 워크스페이스·채널 id가 든 주소.
const PRIVATE_TARGET = "https://oort.example/v1/workspaces/ws-7f3a/channels/ch-91c2/messages";

const network = (at: number, path: string, extra: Partial<RestOutcome> = {}): RestOutcome =>
  ({ kind: "network", at, method: "GET", target: `${PRIVATE_TARGET}/${path}`, failure: "unreachable", ...extra }) as RestOutcome;
const answered = (at: number, status: number, code?: string): RestOutcome => ({
  kind: "response",
  at,
  method: "POST",
  target: PRIVATE_TARGET,
  status,
  ...(code === undefined ? {} : { code }),
});

/** 상태를 행동 차례대로 접으며 매 변화가 남긴 종류를 모은다. 화면 공급자가 하는 일 그대로다. */
function record(actions: ConnectionAction[], start: ConnectionState = connected()): ConnectionDiagKind[][] {
  let state = start;
  const out: ConnectionDiagKind[][] = [];
  for (const action of actions) {
    const next = reduceConnection(state, action);
    out.push(connectionDiagTransitions(state, next));
    state = next;
  }
  return out;
}

/** 소켓이 붙어 있고 기기가 온라인인 앱. */
function connected(): ConnectionState {
  const opened = initialConnectionState(NOW - 60_000, true);
  return reduceConnection(opened, eventAction(NOW - 59_000, socketEvent(NOW - 59_000, "connected")));
}

describe("무엇을 남기나: 판정에 들어가는 사실이 바뀐 순간만", () => {
  it("기기 오프라인은 기기 사실과 「보낼 수 없음(기기 오프라인)」을, 돌아오면 그 반대를 남긴다", () => {
    expect(
      record([eventAction(NOW, deviceEvent(NOW, false)), eventAction(NOW + 3_000, deviceEvent(NOW + 3_000, true))])
    ).toEqual([
      ["device.offline", "send.blocked.deviceOffline"],
      ["device.online", "send.open"],
    ]);
  });

  it("서로 다른 요청 3건이 닿지 못하면 실패는 따로 세지 않고 선언과 「보낼 수 없음(서버)」만, 응답 한 건이면 풀림을 남긴다", () => {
    expect(
      record([
        eventAction(NOW, restEvent(network(NOW, "a"))),
        eventAction(NOW + 1, restEvent(network(NOW + 1, "b"))),
        eventAction(NOW + 2, restEvent(network(NOW + 2, "c"))),
        eventAction(NOW + 3, restEvent(network(NOW + 3, "d"))),
        eventAction(NOW + 4, restEvent(answered(NOW + 4, 200))),
        eventAction(NOW + 5, restEvent(answered(NOW + 5, 200))),
      ])
    ).toEqual([[], [], ["rest.declared", "send.blocked.serverUnreachable"], [], ["rest.cleared", "send.open"], []]);
  });

  it("소켓 심장 박동을 놓쳐 끊긴 소켓은 1분이 지나도 보내기를 막지 않는다(「보낼 수 없음」을 남기지 않는다)", () => {
    // 지키는 것: 숨은 창에서 핑을 놓친 소켓(centrifuge noPing)이 「보낼 수 없음」으로 이어지는 길은 없다. 끊김은 실시간만의 일이다.
    let state = connected();
    const kinds: ConnectionDiagKind[] = [];
    for (const action of [
      eventAction(NOW, socketEvent(NOW, "disconnected")),
      tickAction(NOW + 11_000),
      tickAction(NOW + 60_000),
    ]) {
      const next = reduceConnection(state, action);
      kinds.push(...connectionDiagTransitions(state, next));
      state = next;
    }
    expect(state.view).toMatchObject({ phase: "down", cause: "realtimeDown", canSend: true });
    expect(kinds).toEqual([]);
    expect(["connected", "connecting", "disconnected"].map((s) => socketDiagKind(s as "connected"))).toEqual([
      "socket.connected",
      "socket.connecting",
      "socket.disconnected",
    ]);
  });

  it("같은 상태의 되풀이 알림은 아무것도 남기지 않는다", () => {
    expect(
      record([
        eventAction(NOW, socketEvent(NOW, "connected")),
        eventAction(NOW + 1, deviceEvent(NOW + 1, true)),
        eventAction(NOW + 2, restEvent(answered(NOW + 2, 200))),
      ])
    ).toEqual([[], [], []]);
  });
});

describe("REST 실패의 분류: 시간 초과 · 늦게 깬 마감 · 망 · 길 위 장비만", () => {
  it("분류 낱말 하나만 내고, 서버가 답한 것은 실패가 아니다", () => {
    expect(restFailureDiagKind(network(NOW, "a", { failure: "timeout" }))).toBe("rest.fail.timeout");
    expect(restFailureDiagKind(network(NOW, "a", { failure: "timeout", lateMs: LATE_WAKE_MS }))).toBe(
      "rest.fail.timeoutLate"
    );
    expect(restFailureDiagKind(network(NOW, "a"))).toBe("rest.fail.network");
    for (const status of [502, 503, 504]) expect(restFailureDiagKind(answered(NOW, status))).toBe("rest.fail.gateway");
    for (const status of [200, 401, 429, 500]) expect(restFailureDiagKind(answered(NOW, status))).toBeNull();
    expect(restFailureDiagKind(answered(NOW, 503, "drive_unavailable"))).toBeNull();
  });
});

describe("늦게 깬 타이머", () => {
  it("10초 미만은 남기지 않고, 그 위는 네 칸으로만 접는다", () => {
    expect(wakeLateDiagKind(LATE_WAKE_MS - 1)).toBeNull();
    expect(wakeLateDiagKind(Number.NaN)).toBeNull();
    expect(wakeLateDiagKind(LATE_WAKE_MS)).toBe("wake.late.10s");
    expect(wakeLateDiagKind(60_000)).toBe("wake.late.1m");
    expect(wakeLateDiagKind(10 * 60_000)).toBe("wake.late.10m");
    expect(wakeLateDiagKind(3 * 60 * 60_000)).toBe("wake.late.1h");
  });

  it("5초 시계가 예정보다 크게 늦게 깬 번만 알린다(가짜 시계)", () => {
    let clock = NOW;
    let pending: (() => void) | null = null;
    const late: Array<[ConnectionDiagKind, number]> = [];
    const stop = startWakeWatch({
      now: () => clock,
      setTimer: (run) => {
        pending = run;
        return 1;
      },
      clearTimer: () => {
        pending = null;
      },
      onLate: (kind, at) => late.push([kind, at]),
    });
    const fire = (afterMs: number) => {
      clock += afterMs;
      const run = pending;
      pending = null;
      run?.();
    };
    fire(5_000); // 제때
    fire(5_900); // 0.9초 늦음: 숨은 창의 1초 맞춤 잡음
    fire(5_000 + 4 * 60_000); // 4분 잠들었다 깸
    fire(5_000 + 12_000); // 12초 늦음
    expect(late).toEqual([
      ["wake.late.1m", NOW + 5_000 + 5_900 + 5_000 + 4 * 60_000],
      ["wake.late.10s", NOW + 5_000 + 5_900 + 5_000 + 4 * 60_000 + 17_000],
    ]);
    stop();
    expect(pending).toBeNull();
  });
});

describe("상한과 저장 모양", () => {
  it("500건을 넘으면 앞쪽을, 7일보다 오래되면 그 기록을 버린다", () => {
    let log: ConnectionDiagEntry[] = [];
    for (let i = 0; i < CONNECTION_DIAG_CAPACITY + 20; i += 1) {
      log = appendConnectionDiag(log, { at: NOW + i, kind: "window.blur" });
    }
    expect(log).toHaveLength(CONNECTION_DIAG_CAPACITY);
    expect(log[0]?.at).toBe(NOW + 20);

    const old = appendConnectionDiag([], { at: NOW, kind: "device.offline" });
    const later = appendConnectionDiag(old, { at: NOW + CONNECTION_DIAG_MAX_AGE_MS + 1, kind: "device.online" });
    expect(later.map((entry) => entry.kind)).toEqual(["device.online"]);
  });

  it("저장하는 값은 [시각, 종류] 쌍뿐이고, 읽을 때 표 밖의 것·깨진 것은 버린다", () => {
    const sneaky = { at: NOW, kind: "rest.fail.network", target: PRIVATE_TARGET } as ConnectionDiagEntry;
    const stored = serializeConnectionDiag(appendConnectionDiag([], sneaky));
    expect(stored).toBe(`[[${NOW},"rest.fail.network"]]`);
    expect(stored).not.toContain("ws-7f3a");

    expect(
      parseConnectionDiag(
        [
        [NOW, "device.offline"],
        [NOW + 1, PRIVATE_TARGET],
        [NOW + 2, "device.offline", "extra"],
        ["yesterday", "device.online"],
        [Number.POSITIVE_INFINITY, "device.online"],
        { at: NOW + 3, kind: "device.online" },
        [NOW + 4, "send.open"],
        ],
        NOW + 10
      )
    ).toEqual([
      { at: NOW, kind: "device.offline" },
      { at: NOW + 4, kind: "send.open" },
    ]);
    for (const junk of [null, "x", 3, {}, undefined]) expect(parseConnectionDiag(junk, NOW)).toEqual([]);
  });

  it("날짜로 만들 수 없는 시각(1e20·음수·NaN·2020년 전·하루 넘게 앞선 값)과 7일 넘은 값은 읽을 때 버리고, 남은 기록은 복사 글이 된다 (수리 1회차 H1)", () => {
    // 지키는 것: `1e20`처럼 유한하지만 날짜가 아닌 시각 하나가 카드의 `toISOString()`에서 RangeError를 던져 설정 > 업데이트 페이지 전체를
    // 무너뜨렸다. 읽을 때 걸러 내면 화면·복사 글 어디에도 닿지 않는다. 바로 곁의 멀쩡한 값(하루 안쪽으로 앞선 값 포함)은 살린다.
    const raw = JSON.parse(
      JSON.stringify([
        [NOW - 60_000, "window.hidden"],
        [1e20, "device.online"],
        [-5, "device.offline"],
        [-1e20, "device.offline"],
        [Date.UTC(2019, 11, 31), "send.open"],
        [NOW + 2 * 24 * 60 * 60_000, "send.open"],
        [NOW - CONNECTION_DIAG_MAX_AGE_MS - 1, "send.open"],
        [NOW + 60 * 60_000, "window.visible"],
      ])
    ) as unknown[];
    raw.push([Number.NaN, "device.online"]);
    const log = parseConnectionDiag(raw, NOW);
    expect(log).toEqual([
      { at: NOW - 60_000, kind: "window.hidden" },
      { at: NOW + 60 * 60_000, kind: "window.visible" },
    ]);
    expect(() => formatConnectionDiag(log)).not.toThrow();
    expect(formatConnectionDiag(log).split("\n")).toHaveLength(2);
    // 이미 메모리에 들어온 깨진 값이 있어도 복사 글은 그 줄만 건너뛴다(화면이 무너지지 않는다).
    expect(formatConnectionDiag([{ at: 1e20, kind: "device.online" }, { at: NOW, kind: "send.open" }])).toBe(
      `${new Date(NOW).toISOString()} send.open`
    );
    // 더할 때도 하루 넘게 앞선 값은 남기지 않는다(7일 정리에 안 걸리는 미래 시각이 500건이 밀어낼 때까지 남던 길).
    expect(appendConnectionDiag([{ at: 1e20, kind: "device.online" }], { at: NOW, kind: "send.open" })).toEqual([
      { at: NOW, kind: "send.open" },
    ]);
  });

  it("종류 표의 낱말에는 주소·숫자 id가 들어갈 자리가 없다", () => {
    for (const kind of CONNECTION_DIAG_KINDS) expect(kind).toMatch(/^[a-z]+(\.[a-zA-Z0-9]+)+$/);
  });
});

describe("꺼내 보기: 오늘의 횟수와 복사 글", () => {
  it("오늘(이 기기 시간대 0시부터)만 종류 표 순서로 센다", () => {
    const midnight = startOfLocalDay(NOW);
    const log: ConnectionDiagEntry[] = [
      { at: midnight - 1, kind: "send.blocked.serverUnreachable" },
      { at: midnight, kind: "window.hidden" },
      { at: midnight + 10, kind: "send.blocked.serverUnreachable" },
      { at: midnight + 20, kind: "device.offline" },
      { at: midnight + 30, kind: "send.blocked.serverUnreachable" },
    ];
    expect(todayConnectionDiagCounts(log, midnight + 60_000)).toEqual([
      { kind: "device.offline", count: 1 },
      { kind: "window.hidden", count: 1 },
      { kind: "send.blocked.serverUnreachable", count: 2 },
    ]);
  });

  it("「서버 응답 없음」은 늦게 깬 마감을 세지 않고 「쉬는 동안 끊긴 요청」이 따로 센다. 한 종류는 한 묶음에만 든다 (수리 1회차 M1)", () => {
    const midnight = startOfLocalDay(NOW);
    const log: ConnectionDiagEntry[] = [
      { at: midnight + 1, kind: "rest.fail.timeoutLate" },
      { at: midnight + 2, kind: "rest.fail.timeoutLate" },
      { at: midnight + 3, kind: "rest.fail.timeoutLate" },
      { at: midnight + 4, kind: "rest.fail.network" },
      { at: midnight + 5, kind: "rest.fail.gateway" },
      { at: midnight + 6, kind: "rest.fail.timeout" },
      { at: midnight + 7, kind: "wake.late.10m" },
      { at: midnight + 8, kind: "send.blocked.expired" },
    ];
    const { counts } = connectionDiagToday(log, midnight + 60_000);
    expect(counts).toMatchObject({ serverNoAnswer: 3, cutWhileResting: 3, appRested: 1, sendBlocked: 1 });
    const grouped = Object.values(CONNECTION_DIAG_GROUPS).flat() as string[];
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it("기록이 가득 차 오늘 기록의 앞쪽이 잘렸을 수 있으면 그렇다고 말한다 (수리 1회차 M3)", () => {
    const midnight = startOfLocalDay(NOW);
    const fill = (from: number): ConnectionDiagEntry[] =>
      Array.from({ length: CONNECTION_DIAG_CAPACITY }, (_, i) => ({ at: from + i, kind: "window.blur" as const }));
    expect(connectionDiagToday(fill(midnight + 10), midnight + 60_000).cappedToday).toBe(true);
    // 가득 찼어도 가장 오래 남은 기록이 어제 것이면 오늘 기록은 다 있다.
    expect(connectionDiagToday(fill(midnight - 100), midnight + 60_000).cappedToday).toBe(false);
    // 오늘 것뿐이어도 가득 차지 않았으면 잘린 적이 없다.
    expect(connectionDiagToday(fill(midnight + 10).slice(1), midnight + 60_000).cappedToday).toBe(false);
  });

  it("복사 글은 한 줄에 UTC 시각과 종류 하나다", () => {
    const text = formatConnectionDiag([
      { at: Date.UTC(2026, 10, 9, 8, 0, 0), kind: "window.hidden" },
      { at: Date.UTC(2026, 10, 9, 8, 4, 1), kind: "wake.late.1m" },
    ]);
    expect(text).toBe("2026-11-09T08:00:00.000Z window.hidden\n2026-11-09T08:04:01.000Z wake.late.1m");
    expect(formatConnectionDiag([])).toBe("connection: no events recorded");
  });
});
