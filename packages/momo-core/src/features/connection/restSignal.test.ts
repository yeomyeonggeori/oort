import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithDeadline, LATE_WAKE_MS, NetworkError, subscribeRestOutcome } from "../../lib/http";
import { CONNECTION_KEYS as K } from "./copyKeys";
import { deriveConnectionState, foldConnectionEvent, type ConnectionInput } from "./model";
import { INITIAL_REST_SIGNAL } from "./restSignal";

// 이 시험은 실제 `fetchWithDeadline`을 거친다(fetch만 가짜). 그래서 `error.code`를 본문에서 읽는 http.ts와
// 닿지 못함으로 세는 restSignal.ts 어느 쪽을 깨뜨려도 빨갛게 된다.

const SERVER = "http://server.test";
const NOW = 1_700_000_000_000;

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  vi.unstubAllGlobals();
});

type Answer = "network" | number | { status: number; code: string };

/** 소켓은 멀쩡하고 기기는 온라인인 앱에서 REST 결과가 하나씩 들어온다. */
function harness() {
  let input: ConnectionInput = {
    deviceOnline: true,
    socket: { status: "connected", open: null, ended: false },
    rest: INITIAL_REST_SIGNAL,
    sessionExpired: false,
  };
  cleanups.push(
    subscribeRestOutcome((outcome) => {
      input = foldConnectionEvent(input, { kind: "rest", outcome });
    }),
  );
  return {
    async hit(path: string, answer: Answer): Promise<void> {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          if (answer === "network") throw new TypeError("Failed to fetch");
          const { status, code } = typeof answer === "number" ? { status: answer, code: undefined } : answer;
          const body = code === undefined ? "" : JSON.stringify({ error: { code, message: "server words" } });
          return new Response(body, { status });
        }),
      );
      await fetchWithDeadline(`${SERVER}${path}`).catch(() => null);
    },
    view: () => deriveConnectionState(input, NOW),
  };
}

describe("③ 서버에 닿지 못함: 선언 임계와 해제", () => {
  // 지키는 것: 한 건(정상 운영의 503 같은)으로 보내기·승인을 잠그지 않는다. 서로 다른 요청 3건이 연달아
  // 닿지 못해야 선언하고, 응답 한 건이면 곧바로 푼다. 같은 요청이 세 번 재시도하는 것은 한 건이다.
  it("서로 다른 요청 3건이 연속으로 닿지 못해야 선언하고, 응답 한 건으로 풀린다", async () => {
    const h = harness();
    await h.hit("/v1/a", "network");
    await h.hit("/v1/b", 502);
    expect(h.view()).toMatchObject({ phase: "ok", canSend: true, canUpload: true, canDecide: true });

    await h.hit("/v1/c", 503);
    expect(h.view()).toMatchObject({
      phase: "down",
      cause: "serverUnreachable",
      canSend: false,
      canUpload: false,
      canDecide: false,
      composerNote: K.composerServerUnreachable,
      approvalNote: K.approvalServerUnreachable,
      action: { kind: "reconnectNow" },
    });

    await h.hit("/v1/d", 200);
    expect(h.view()).toMatchObject({ phase: "ok", canSend: true, canUpload: true, canDecide: true });
  });

  it("같은 요청이 몇 번 실패해도 한 건이고, 주소가 달라야 다른 요청이다(쿼리는 무시한다)", async () => {
    const h = harness();
    for (let i = 0; i < 4; i += 1) await h.hit("/v1/a?page=" + i, "network");
    expect(h.view().phase).toBe("ok");
    await h.hit("/v1/b", "network");
    expect(h.view().phase).toBe("ok");
    await h.hit("/v1/c", "network");
    expect(h.view().cause).toBe("serverUnreachable");
  });
});

describe("④ error.code 가 있는 503은 서버에 닿지 못함으로 세지 않는다", () => {
  // 지키는 것: 코드가 있는 503은 우리 서버가 직접 이름을 붙여 거절한 답이다(예: 보관소 미연결). 닿았다는
  // 증거이므로 세지 않고 연속도 끊는다. 길 위의 장비가 낸 503·502·504와 응답 없음만 센다.
  it("코드 없는 503·502·504는 세고, 코드 있는 503은 세지 않고 연속을 끊는다", async () => {
    const h = harness();
    for (const path of ["/v1/a", "/v1/b", "/v1/c"]) {
      await h.hit(path, { status: 503, code: "drive_unavailable" });
    }
    expect(h.view().phase).toBe("ok");

    await h.hit("/v1/d", 503);
    await h.hit("/v1/e", 504);
    await h.hit("/v1/f", { status: 503, code: "drive_unavailable" });
    await h.hit("/v1/g", 502);
    expect(h.view().phase).toBe("ok");

    await h.hit("/v1/h", { status: 503, code: "" });
    await h.hit("/v1/i", 504);
    expect(h.view()).toMatchObject({ phase: "down", cause: "serverUnreachable" });
  });

  it("503이 아닌 오류 응답(400·401·429·500)은 서버가 직접 답한 것이라 세지 않는다", async () => {
    const h = harness();
    await h.hit("/v1/a", "network");
    await h.hit("/v1/b", "network");
    for (const [i, status] of [400, 401, 429, 500].entries()) {
      await h.hit(`/v1/x${i}`, status);
      await h.hit(`/v1/y${i}`, "network");
      await h.hit(`/v1/z${i}`, "network");
      expect(h.view().phase).toBe("ok");
    }
  });
});

describe("⑤ 늦게 깬 마감의 시간 초과는 「서버에 닿지 못함」으로 세지 않는다 (#5587)", () => {
  // 지키는 것: 창이 뒤에 있는 데스크탑 앱이 잠들었다 깨면(맥 잠자기·앱 낮잠) 마감 타이머가 깨는 순간 먼저 돌아, 깨어 있는 시간을
  // 한 번도 받지 못한 요청을 시간 초과로 끝낸다. 백그라운드 폴링 서너 건이 그렇게 함께 끝나면 서로 다른 요청 3건이라 「보낼 수
  // 없음」이 섰다. 그 시간 초과는 세지도 풀지도 않는다. 마감이 제때 돈 시간 초과는 그대로 센다. 이 시험은 실제 `fetchWithDeadline`을
  // 거쳐서 http.ts의 표시(`lateMs`)와 restSignal.ts의 건너뛰기 어느 쪽을 깨뜨려도 빨갛게 된다.
  afterEach(() => {
    vi.useRealTimers();
  });

  /** 답하지 않는 요청 하나를 보내고, 앱이 `asleepMs` 동안 잠든 뒤(벽시계만 흐른다) 15초 마감 타이머가 돈다. */
  async function timeoutAfterSleep(path: string, asleepMs: number): Promise<unknown> {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          }),
      ),
    );
    const settled = fetchWithDeadline(`${SERVER}${path}`, {}, 15_000).catch((error: unknown) => error);
    vi.setSystemTime(Date.now() + asleepMs);
    await vi.advanceTimersByTimeAsync(15_000);
    return settled;
  }

  it("잠든 사이 마감을 다 쓴 서로 다른 요청 3건은 선언하지 않고, 쌓인 실패를 풀지도 않는다", async () => {
    vi.useFakeTimers();
    const h = harness();
    for (const path of ["/v1/a", "/v1/b", "/v1/c"]) {
      // 호출자는 예전처럼 시간 초과를 받는다(요청 쪽 행동은 그대로다).
      expect(await timeoutAfterSleep(path, 5 * 60_000)).toBeInstanceOf(NetworkError);
    }
    expect(h.view()).toMatchObject({ phase: "ok", cause: null, canSend: true });

    // 제때 돈 시간 초과 2건 뒤의 늦게 깬 1건은 선언도 풀림도 만들지 않는다: 다음 제때 돈 1건이 세 번째다.
    await timeoutAfterSleep("/v1/d", 0);
    await timeoutAfterSleep("/v1/e", 0);
    await timeoutAfterSleep("/v1/f", 5 * 60_000);
    expect(h.view()).toMatchObject({ phase: "ok", canSend: true });
    await timeoutAfterSleep("/v1/g", 0);
    expect(h.view()).toMatchObject({ phase: "down", cause: "serverUnreachable", canSend: false });
  });

  it("문턱 바로 아래(마감이 10초 미만 늦게 돈 것)는 제때 돈 마감이라 센다", async () => {
    vi.useFakeTimers();
    const h = harness();
    for (const path of ["/v1/a", "/v1/b", "/v1/c"]) await timeoutAfterSleep(path, LATE_WAKE_MS - 1_000);
    expect(h.view()).toMatchObject({ phase: "down", cause: "serverUnreachable", canSend: false });
  });
});
