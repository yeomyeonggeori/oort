import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api";
import { installCoreHost, resetCoreHost, type SessionPort } from "../../runtime/host";
import {
  ACTIVITY_BEAT_INTERVAL_MS,
  ACTIVITY_IDLE_LIMIT_MS,
  holdActivityBeat,
  resetActivityBeatForTests,
  touchPresenceActivity,
  type ActivityBeatDeps,
  type ActivityPort,
} from "./activityBeat";

// 서버(#4497)는 30초 안의 신호를 「쓰는 중」으로 읽고, 클라이언트 계약(ADR-0206 D4 · 수용 기준 20·38)은
// 「앞 + 마지막 입력 5분 이내인 동안 20초 이하 주기」다. 여기서는 그 주기·멈춤·거절 처리를 잰다.

function fakePort(foreground = true) {
  let fg = foreground;
  const fgSubs = new Set<(f: boolean) => void>();
  const inputSubs = new Set<() => void>();
  const port: ActivityPort = {
    isForeground: () => fg,
    subscribe: (cb) => {
      fgSubs.add(cb);
      return () => fgSubs.delete(cb);
    },
    subscribeInput: (cb) => {
      inputSubs.add(cb);
      return () => inputSubs.delete(cb);
    },
  };
  return {
    port,
    setForeground(next: boolean) {
      fg = next;
      fgSubs.forEach((cb) => cb(next));
    },
    input() {
      inputSubs.forEach((cb) => cb());
    },
    subscribers: () => fgSubs.size + inputSubs.size,
  };
}

let send: ReturnType<typeof vi.fn>;
let deps: ActivityBeatDeps;
let serverKey: string;

beforeEach(() => {
  vi.useFakeTimers();
  resetActivityBeatForTests();
  send = vi.fn(async () => {});
  serverKey = "https://oort.test";
  deps = {
    send,
    now: () => Date.now(),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    serverKey: () => serverKey,
  };
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

const tick = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
};

describe("활동 신호의 주기", () => {
  it("주기는 20초 상한 안이다. 입력이 와야 시작하고, 바로 한 번 보낸 뒤 15초마다 보낸다", async () => {
    expect(ACTIVITY_BEAT_INTERVAL_MS).toBeLessThanOrEqual(20_000);
    const ui = fakePort();
    holdActivityBeat("w", ui.port, deps);
    // 창은 앞에 있어도 입력을 본 적이 없으면 「쓰는 중」이 아니다.
    await tick(60_000);
    expect(send).not.toHaveBeenCalled();
    ui.input();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("w");
    await tick(ACTIVITY_BEAT_INTERVAL_MS - 1);
    expect(send).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(send).toHaveBeenCalledTimes(2);
    await tick(ACTIVITY_BEAT_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("입력은 보내는 횟수를 늘리지 않는다: 키를 계속 눌러도 타이머는 하나고 주기는 그대로다", async () => {
    const ui = fakePort();
    holdActivityBeat("w", ui.port, deps);
    ui.input();
    for (let i = 0; i < 20; i += 1) {
      await tick(1_000);
      ui.input();
    }
    // 20초 동안: 처음 한 번 + 15초 지점 한 번.
    expect(send).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe("멈추는 때", () => {
  it("창이 뒤로 가면 멈추고, 앞으로 돌아오면(입력이 5분 안이면) 바로 한 번 보내고 다시 돈다", async () => {
    const ui = fakePort();
    holdActivityBeat("w", ui.port, deps);
    ui.input();
    await tick(ACTIVITY_BEAT_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(2);
    ui.setForeground(false);
    expect(vi.getTimerCount()).toBe(0);
    await tick(ACTIVITY_BEAT_INTERVAL_MS * 4);
    expect(send).toHaveBeenCalledTimes(2);
    ui.setForeground(true);
    expect(send).toHaveBeenCalledTimes(3);
    await tick(ACTIVITY_BEAT_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(4);
  });

  it("마지막 입력 5분이 지나면 보내지 않고 타이머를 끈다. 새 입력이면 바로 다시 보낸다", async () => {
    const ui = fakePort();
    holdActivityBeat("w", ui.port, deps);
    ui.input();
    // 5분 직전까지는 보낸다: t = 0, 15, ..., 285초 = 20번.
    await tick(ACTIVITY_IDLE_LIMIT_MS - 1);
    expect(send).toHaveBeenCalledTimes(20);
    await tick(1);
    // 300초 지점의 틱은 경과가 5분이라 보내지 않고 타이머를 끈다.
    expect(send).toHaveBeenCalledTimes(20);
    expect(vi.getTimerCount()).toBe(0);
    await tick(ACTIVITY_IDLE_LIMIT_MS);
    expect(send).toHaveBeenCalledTimes(20);
    ui.input();
    expect(send).toHaveBeenCalledTimes(21);
  });

  it("입력이 이어지는 동안은 5분이 넘어도 계속 보낸다", async () => {
    const ui = fakePort();
    holdActivityBeat("w", ui.port, deps);
    ui.input();
    await tick(ACTIVITY_IDLE_LIMIT_MS - 30_000);
    ui.input();
    await tick(ACTIVITY_IDLE_LIMIT_MS - 30_000);
    // 두 번째 입력(4분 30초 지점)에서 4분 30초 뒤 = 9분 지점: 아직 5분 안이라 타이머가 돈다.
    expect(vi.getTimerCount()).toBe(1);
    const before = send.mock.calls.length;
    await tick(ACTIVITY_BEAT_INTERVAL_MS);
    expect(send.mock.calls.length).toBe(before + 1);
  });

  it("절전에서 깨면(시계가 건너뛰면) 새 입력이 올 때까지 보내지 않는다", async () => {
    const ui = fakePort();
    holdActivityBeat("w", ui.port, deps);
    ui.input();
    await tick(ACTIVITY_BEAT_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(2);
    // 뚜껑을 2분 닫았다: 타이머는 돌지 못했고 시계만 앞으로 갔다. 입력은 아직 5분 안이다.
    vi.setSystemTime(Date.now() + 120_000);
    await tick(ACTIVITY_BEAT_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    await tick(60_000);
    expect(send).toHaveBeenCalledTimes(2);
    ui.input();
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("화면을 떠나면(해제) 멈추고 구독도 푼다. 두 번 잡은 것은 둘 다 떠나야 멈춘다", async () => {
    const ui = fakePort();
    const a = holdActivityBeat("w", ui.port, deps);
    const b = holdActivityBeat("W", ui.port, deps);
    ui.input();
    expect(vi.getTimerCount()).toBe(1);
    a();
    expect(vi.getTimerCount()).toBe(1);
    expect(ui.subscribers()).toBe(2);
    b();
    expect(vi.getTimerCount()).toBe(0);
    expect(ui.subscribers()).toBe(0);
    ui.input();
    await tick(ACTIVITY_BEAT_INTERVAL_MS * 3);
    expect(send).toHaveBeenCalledTimes(1);
    b();
  });
});

describe("서버가 거절하면", () => {
  it("옛 서버(404·405)면 그 서버로는 다시 보내지 않는다. 다른 서버는 영향이 없다", async () => {
    for (const status of [404, 405]) {
      resetActivityBeatForTests();
      send.mockReset();
      send.mockRejectedValue(new ApiError(status, "nope"));
      const ui = fakePort();
      const release = holdActivityBeat("w", ui.port, deps);
      ui.input();
      await tick(ACTIVITY_BEAT_INTERVAL_MS * 4);
      expect(send).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      // 입력·앞뒤 전환·다른 워크스페이스도 같은 서버에는 다시 보내지 않는다.
      ui.setForeground(false);
      ui.setForeground(true);
      ui.input();
      const other = holdActivityBeat("other", ui.port, deps);
      ui.input();
      await tick(ACTIVITY_BEAT_INTERVAL_MS * 2);
      expect(send).toHaveBeenCalledTimes(1);
      release();
      other();
      // 서버 주소가 바뀌면(다른 서버에 연결) 다시 시험해 볼 수 있다.
      serverKey = `https://other-${status}.test`;
      send.mockResolvedValue(undefined);
      const next = holdActivityBeat("w", ui.port, deps);
      ui.input();
      expect(send).toHaveBeenCalledTimes(2);
      next();
      serverKey = "https://oort.test";
      vi.clearAllTimers();
    }
  });

  it("403이면 이 세션에서 멈춘다. 새 세션(다시 잡기)은 다시 시험한다", async () => {
    send.mockRejectedValueOnce(new ApiError(403, "not an active member"));
    const ui = fakePort();
    const release = holdActivityBeat("w", ui.port, deps);
    ui.input();
    await tick(ACTIVITY_BEAT_INTERVAL_MS * 4);
    expect(send).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    ui.setForeground(false);
    ui.setForeground(true);
    ui.input();
    await tick(ACTIVITY_BEAT_INTERVAL_MS * 4);
    expect(send).toHaveBeenCalledTimes(1);
    // 로그아웃·재로그인(hold 해제 뒤 다시 잡기)이면 새 세션이다.
    release();
    const again = holdActivityBeat("w", ui.port, deps);
    ui.input();
    expect(send).toHaveBeenCalledTimes(2);
    again();
  });

  it("503은 멈추지 않고, Retry-After가 지난 뒤의 다음 주기에 다시 보낸다", async () => {
    // 서버가 주는 2초: 다음 주기(15초)는 이미 그 뒤다.
    send.mockRejectedValueOnce(new ApiError(503, "busy", undefined, 2));
    const ui = fakePort();
    holdActivityBeat("w", ui.port, deps);
    ui.input();
    await tick(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    await tick(ACTIVITY_BEAT_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("주기보다 긴 Retry-After(40초) 안의 틱은 건너뛰고, 지난 뒤의 틱이 보낸다", async () => {
    const ui = fakePort();
    holdActivityBeat("w", ui.port, deps);
    send.mockRejectedValueOnce(new ApiError(503, "busy", undefined, 40));
    ui.input(); // t=0: 보냄(503, 40초 기다림)
    await tick(0);
    expect(send).toHaveBeenCalledTimes(1);
    await tick(ACTIVITY_BEAT_INTERVAL_MS); // 15초: 기다리는 중
    await tick(ACTIVITY_BEAT_INTERVAL_MS); // 30초: 기다리는 중
    expect(send).toHaveBeenCalledTimes(1);
    await tick(ACTIVITY_BEAT_INTERVAL_MS); // 45초: 40초가 지났다
    expect(send).toHaveBeenCalledTimes(2);
    // Retry-After를 말하지 않은 503은 기다림을 지어내지 않는다: 다음 주기가 곧 기다림이다.
    send.mockRejectedValueOnce(new ApiError(503, "busy"));
    await tick(ACTIVITY_BEAT_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(3);
    await tick(ACTIVITY_BEAT_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(4);
  });

  it("네트워크 실패와 500은 삼키고 다음 주기에 다시 보낸다", async () => {
    send.mockRejectedValueOnce(new TypeError("offline"));
    send.mockRejectedValueOnce(new ApiError(500, "boom"));
    const ui = fakePort();
    holdActivityBeat("w", ui.port, deps);
    ui.input();
    await tick(0);
    expect(send).toHaveBeenCalledTimes(1);
    await tick(ACTIVITY_BEAT_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(2);
    await tick(ACTIVITY_BEAT_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("응답이 늦으면 겹쳐 보내지 않고, 끝내 안 오면 30초 뒤 주기에 다시 보낸다", async () => {
    send.mockImplementationOnce(() => new Promise<void>(() => {}));
    const ui = fakePort();
    holdActivityBeat("w", ui.port, deps);
    ui.input();
    await tick(ACTIVITY_BEAT_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(1);
    await tick(ACTIVITY_BEAT_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("touchPresenceActivity", () => {
  function installHost(): void {
    const session: SessionPort = {
      getAccessToken: () => "access-token",
      getRefreshToken: () => null,
      getPersistedSession: () => null,
      applyLogin: () => {},
      applyRotation: () => {},
      markAuthExpired: () => {},
      clearSession: () => {},
    };
    installCoreHost({
      apiBase: () => "https://oort.test",
      absoluteApiBase: () => "https://oort.test",
      buildMode: () => "test",
      session,
    });
  }
  afterEach(() => {
    vi.unstubAllGlobals();
    resetCoreHost();
  });

  it("PUT .../presence/activity 를 본문 없이 보낸다(무엇을 보는지·어느 채널인지 싣지 않는다)", async () => {
    installHost();
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await touchPresenceActivity("w 1");
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe("https://oort.test/v1/workspaces/w%201/presence/activity");
    expect(call[1].method).toBe("PUT");
    expect(call[1].body ?? undefined).toBeUndefined();
  });

  it("503의 Retry-After와 403·404는 ApiError로 읽힌다", async () => {
    installHost();
    const answer = (status: number, headers: Record<string, string> = {}) =>
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: "x" } }), {
            status,
            headers: { "Content-Type": "application/json", ...headers },
          })
      );
    vi.stubGlobal("fetch", answer(503, { "Retry-After": "2" }));
    await expect(touchPresenceActivity("w")).rejects.toMatchObject({
      status: 503,
      retryAfterSeconds: 2,
    });
    vi.stubGlobal("fetch", answer(403));
    await expect(touchPresenceActivity("w")).rejects.toMatchObject({ status: 403 });
    vi.stubGlobal("fetch", answer(404));
    await expect(touchPresenceActivity("w")).rejects.toMatchObject({ status: 404 });
  });
});
