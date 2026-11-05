import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWithDeadline, subscribeRestOutcome } from "../../lib/http";
import { installCoreHost, resetCoreHost, type SessionPort } from "../../runtime/host";
import { deriveConnectionState, type ConnectionInput, type ConnectionView } from "./model";
import { restProbeDelayMs, sendRestProbe, startRestProbe, wantsRestProbe, type RestProbeDeps } from "./restProbe";
import {
  eventAction,
  initialConnectionState,
  isRecovered,
  reduceConnection,
  restEvent,
  socketEvent,
  type ConnectionAction,
  type ConnectionState,
} from "./screenState";

// =============================================================================
// 저절로 다시 확인한다 (#5407). 숫자는 상수가 아니라 글자 그대로(2_000, 6_000, 14_000, 30_000)로 단정한다: 상수를 바꿔 간격을 깨뜨렸을 때 단정이 같이
// 움직여 초록으로 남는 일이 없게 한다. 시계는 가짜(`vi.useFakeTimers`), 요청은 실제 `fetchWithDeadline`에 가짜 `fetch`를 물려 결과가 모델까지 가는 길을
// 그대로 탄다(확인 요청이 **보내졌는가**만이 아니라 **띠를 걷는가**를 잰다).
// =============================================================================

const SERVER = "http://server.test";
const T0 = 1_700_000_000_000;

const SESSION: SessionPort = {
  getAccessToken: () => "access-token",
  getRefreshToken: () => null,
  getPersistedSession: () => null,
  applyLogin: () => {},
  applyRotation: () => {},
  markAuthExpired: () => {},
  clearSession: () => {},
};

const cleanups: Array<() => void> = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  installCoreHost({ apiBase: () => SERVER, absoluteApiBase: () => SERVER, buildMode: () => "test", session: SESSION });
});

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  resetCoreHost();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---- 지금 확인이 필요한가 -----------------------------------------------------

function inputWith(patch: Partial<ConnectionInput>): ConnectionInput {
  return {
    deviceOnline: true,
    socket: { status: "connected", open: null, ended: false },
    rest: { unanswered: [] },
    sessionExpired: false,
    ...patch,
  };
}

const NOW = 60_000;
const declared = { unanswered: ["GET a", "GET b", "GET c"] };
const oneFailure = { unanswered: ["GET a"] };
/** 오래전에 끊긴 소켓(10초를 넘겼다). */
const longGap: ConnectionInput["socket"] = {
  status: "disconnected",
  open: { since: 0, quietUntil: 1_000, connectedAt: null },
  ended: false,
};
const viewOf = (patch: Partial<ConnectionInput>): ConnectionView => deriveConnectionState(inputWith(patch), NOW);

describe("지금 확인이 필요한가: REST 실패에서 온 띠가 앞에서 서 있을 때만", () => {
  it("서버에 닿지 못함·알 수 없음이 앞에서 서 있으면 필요하다", () => {
    const unreachable = viewOf({ rest: declared });
    const unknown = viewOf({ socket: longGap, rest: oneFailure });
    expect([unreachable.cause, unknown.cause]).toEqual(["serverUnreachable", "unknown"]);
    expect(wantsRestProbe(unreachable, true)).toBe(true);
    expect(wantsRestProbe(unknown, true)).toBe(true);
  });

  it("뒤에 있으면 아무 띠에도 필요하지 않다 (뒤에 있을 때는 확인 0)", () => {
    expect(wantsRestProbe(viewOf({ rest: declared }), false)).toBe(false);
    expect(wantsRestProbe(viewOf({ socket: longGap, rest: oneFailure }), false)).toBe(false);
  });

  it("REST 실패에서 온 띠가 아니면 앞에서도 필요하지 않다", () => {
    const quiet = deriveConnectionState(
      inputWith({ socket: { status: "connecting", open: { since: NOW - 100, quietUntil: NOW + 900, connectedAt: null }, ended: false } }),
      NOW
    );
    const connecting = deriveConnectionState(
      inputWith({ socket: { status: "connecting", open: { since: NOW - 3_000, quietUntil: NOW - 2_000, connectedAt: null }, ended: false } }),
      NOW
    );
    const views = {
      정상: viewOf({}),
      침묵: quiet,
      "연결 중": connecting,
      "실시간만 끊김": viewOf({ socket: longGap }),
      "기기 오프라인(서버 실패가 쌓여 있어도)": viewOf({ deviceOnline: false, rest: declared }),
      "로그인 만료": viewOf({ sessionExpired: true, rest: declared }),
    };
    for (const [name, view] of Object.entries(views)) expect([name, wantsRestProbe(view, true)]).toEqual([name, false]);
  });
});

describe("간격", () => {
  it("2 · 4 · 8 · 16초로 늘다가 30초에서 멈춘다", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 40].map(restProbeDelayMs)).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000, 30_000]);
  });
});

// ---- 시계를 쥔 쪽 ------------------------------------------------------------

function clocked(send: () => Promise<unknown>): RestProbeDeps {
  return {
    send,
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

describe("확인을 보내는 시계", () => {
  it("시작한 지 2초 뒤 첫 확인, 그 뒤는 앞 확인이 끝난 때부터 4 · 8 · 16 · 30 · 30초 뒤다", async () => {
    const at: number[] = [];
    const stop = startRestProbe(
      clocked(async () => {
        at.push(Date.now() - T0);
      })
    );
    cleanups.push(stop);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(at).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(at).toEqual([2_000]);
    await vi.advanceTimersByTimeAsync(200_000);
    expect(at).toEqual([2_000, 6_000, 14_000, 30_000, 60_000, 90_000, 120_000, 150_000, 180_000]);
  });

  it("멈추면 타이머를 거두고 다시는 보내지 않는다", async () => {
    const send = vi.fn(async () => undefined);
    const stop = startRestProbe(clocked(send));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(send).toHaveBeenCalledTimes(1);
    stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("시작하자마자 멈추면 한 번도 보내지 않는다", async () => {
    const send = vi.fn(async () => undefined);
    startRestProbe(clocked(send))();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(send).not.toHaveBeenCalled();
  });

  it("한 번에 하나만 날아간다: 끝나지 않은 동안은 다음을 걸지 않고, 끝난 때부터 센다", async () => {
    let finish: () => void = () => undefined;
    const send = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    cleanups.push(startRestProbe(clocked(send)));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(send).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(3_999);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("요청이 거절되거나 동기 예외를 던져도 다음 확인은 이어진다", async () => {
    const send = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("down"))
      .mockImplementationOnce(() => {
        throw new Error("sync");
      })
      .mockResolvedValue(undefined);
    cleanups.push(startRestProbe(clocked(send)));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(send).toHaveBeenCalledTimes(3);
  });
});

describe("확인 요청 한 건", () => {
  it("apiBase 의 인증 없는 GET /healthz 다 (로그인 갱신을 끌어들이지 않는다)", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await sendRestProbe();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://server.test/healthz");
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
  });
});

// ---- 끝에서 끝까지: 서버가 돌아오면 사람의 요청 없이 걷힌다 -----------------------

/**
 * 공급자가 하는 일을 그대로 흉내 낸 작은 앱: REST 결과를 모델에 먹이고, 모델이 「확인이 필요하다」로 바뀌면 시작하고 아니면 멈춘다. 서버는
 * `serverUp` 하나로 켜고 끈다. 사람이 보내는 요청은 `hit` 뿐이고 서버가 돌아온 뒤에는 쓰지 않는다.
 */
function app() {
  let state: ConnectionState = reduceConnection(
    initialConnectionState(T0 - 60_000, true),
    eventAction(T0 - 60_000, socketEvent(T0 - 60_000, "connected"))
  );
  let foreground = true;
  let serverUp = false;
  let stop: (() => void) | null = null;
  const urls: string[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(url);
      if (!serverUp) throw new TypeError("Failed to fetch");
      return new Response("{}", { status: 200 });
    })
  );

  const sync = () => {
    const wanted = wantsRestProbe(state.view, foreground);
    if (wanted && stop === null) stop = startRestProbe();
    else if (!wanted && stop !== null) {
      stop();
      stop = null;
    }
  };
  const dispatch = (action: ConnectionAction) => {
    state = reduceConnection(state, action);
    sync();
  };
  cleanups.push(
    subscribeRestOutcome((outcome) => dispatch(eventAction(Date.now(), restEvent(outcome)))),
    () => stop?.()
  );

  return {
    state: () => state,
    probes: () => urls.filter((url) => url.endsWith("/healthz")),
    humanRequests: () => urls.filter((url) => !url.endsWith("/healthz")),
    serverBack: () => {
      serverUp = true;
    },
    setForeground: (value: boolean) => {
      foreground = value;
      sync();
    },
    dispatch,
    /** 사람이 한 요청(화면의 목록 불러오기 같은 것). */
    async hit(path: string) {
      await fetchWithDeadline(`${SERVER}${path}`).catch(() => undefined);
    },
    /** 서로 다른 요청 셋이 닿지 못해 「서버에 닿지 못함」이 선다. */
    async declareUnreachable() {
      for (const path of ["/v1/a", "/v1/b", "/v1/c"]) await this.hit(path);
    },
  };
}

describe("서버에 닿지 못함: 서버가 돌아오면 사람의 요청 없이 걷힌다", () => {
  it("2초·6초에 확인이 실패해도 띠는 그대로이고, 서버가 돌아온 뒤 첫 확인(14초)에 걷힌다. 걷힌 뒤에는 더 보내지 않는다", async () => {
    const a = app();
    await a.declareUnreachable();
    expect(a.state().view.cause).toBe("serverUnreachable");
    expect(a.humanRequests()).toHaveLength(3);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(a.probes()).toEqual(["http://server.test/healthz"]);
    expect(a.state().view.cause).toBe("serverUnreachable");
    await vi.advanceTimersByTimeAsync(4_000); // 6초
    expect(a.probes()).toHaveLength(2);
    expect(a.state().view.cause).toBe("serverUnreachable");
    expect(a.state().input.rest.unanswered).toHaveLength(3);

    // 서버가 돌아온다. 사람은 아무것도 하지 않는다.
    await vi.advanceTimersByTimeAsync(1_000); // 7초
    a.serverBack();
    await vi.advanceTimersByTimeAsync(6_999); // 13.999초
    expect(a.probes()).toHaveLength(2);
    expect(a.state().view.cause).toBe("serverUnreachable");
    await vi.advanceTimersByTimeAsync(1); // 14초
    expect(a.probes()).toHaveLength(3);
    expect(a.state().view.phase).toBe("ok");
    expect(a.state().view.canSend).toBe(true);
    // 끊김이 보였으니 「다시 연결됐어요」 2초 규칙을 따른다.
    expect(isRecovered(a.state(), Date.now())).toBe(true);
    expect(isRecovered(a.state(), Date.now() + 2_000)).toBe(false);

    await vi.advanceTimersByTimeAsync(300_000);
    expect(a.probes()).toHaveLength(3);
    expect(a.humanRequests()).toHaveLength(3);
  });

  it("뒤에 있는 동안은 확인을 한 건도 보내지 않고, 앞으로 돌아오면 2초부터 다시 시작한다", async () => {
    const a = app();
    await a.declareUnreachable();
    a.setForeground(false);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(a.probes()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    a.setForeground(true);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(a.probes()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(a.probes()).toHaveLength(1);
  });

  it("확인이 나가 있는 동안 뒤로 가면 돌아온 확인이 다음 확인을 걸지 않는다", async () => {
    const a = app();
    await a.declareUnreachable();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(a.probes()).toHaveLength(1);
    a.setForeground(false);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(a.probes()).toHaveLength(1);
  });

  it("실시간이 다시 붙으면 요청 없이 걷히고, 확인도 멈춘다", async () => {
    const a = app();
    await a.declareUnreachable();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(a.probes()).toHaveLength(1);
    a.dispatch(eventAction(Date.now(), socketEvent(Date.now(), "disconnected")));
    expect(a.state().view.cause).toBe("serverUnreachable");
    a.dispatch(eventAction(Date.now(), socketEvent(Date.now(), "connected")));
    expect(a.state().view.phase).toBe("ok");
    expect(isRecovered(a.state(), Date.now())).toBe(true);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(a.probes()).toHaveLength(1);
    expect(a.humanRequests()).toHaveLength(3);
  });
});
