import { afterEach, describe, expect, it, vi } from "vitest";

import {
  installCoreHost,
  resetCoreHost,
  type RefreshDeviceProof,
  type SessionPort,
} from "../runtime/host";
import {
  ApiError,
  authedRequest,
  authedResponse,
  fetchAttachmentContent,
  fetchMemberAvatar,
  fetchUnfurlImage,
  fetchWorkspaceAvatar,
  sendMessage,
} from "./api";
import { NetworkError, REQUEST_TIMEOUT_MS } from "./http";

// =============================================================================
// 갱신이 닿지 못한 401은 로그인 만료가 아니다 (#3993, #3926 범위 밖 발견 (a)).
//
// 첫 401 뒤에 세션을 한 번 갱신하고, 그래도 401이면 `markAuthExpired()`를 부르던
// 자리에는 서로 다른 두 일이 섞여 있었다.
//   ① 서버가 갱신을 거절했다(갱신 토큰 무효·재사용 탐지·멤버 비활성). 세션이 진짜 끝났다.
//   ② 갱신이 서버에 닿지 못했다(끊김·데드라인·서버 오류 5xx). 아무도 판정하지 않았다.
// ②를 ①처럼 다루면 지하철·엘리베이터에서 잠깐 끊긴 사이에 받은 401이 로그아웃 화면이
// 된다. 잠금 화면에서 돌아와 승인을 누르는 순간(무선이 아직 깨는 중)이 바로 그 자리다.
//
// 여기서 못박는 것은 넷이다.
//   A. ②는 만료를 선언하지 않고 **NetworkError**로 끝난다. ApiError(401)이 아니다:
//      호출부 여럿이 401을 「다시 로그인하세요」로 읽기 때문에, 그 문장은 이 경우 거짓이다.
//   B. ①은 갱신 응답이 온 **그 자리에서** 선언한다(보안 경계). 재시도·타이머·네트워크를
//      기다리지 않는다. 서버가 세션을 끝냈다고 말했는데 화면이 늦게 따라오면 안 된다.
//   C. 닿지 못한 일이 다음 요청의 갱신을 막지 않는다.
//   D. 같은 규칙이 바이트를 받는 세 헬퍼(미리보기 이미지·첨부·아바타)에도 선다.
//
// 세션 목은 상태를 가진다. 어느 쪽이 선언했는지(회전 자신인가, `authedResponse`인가)가
// 갈리는 시험이 있어서, 선언 횟수를 센다. `expired > 0`만 보는 단정은 한쪽이 지워져도
// 다른 쪽이 채워서 초록으로 남는다 — 그래서 거의 모든 단정에 오류의 **종류**
// (NetworkError / ApiError)를 함께 건다.
// =============================================================================

const WS = "019f9b10-0000-7000-8000-000000000001";
const CH = "019f9b10-0000-7000-8000-0000000000c1";
const SEND_PATH = `/v1/workspaces/${WS}/channels/${CH}/messages`;
const LIST_PATH = `/v1/workspaces/${WS}/channels`;
const REFRESH_PATH = "/v1/auth/refresh";

const member = {
  id: "00000000-0000-0000-0000-000000000002",
  workspaceId: WS,
  handle: "sj",
  displayName: "성재",
  kind: "human",
  role: "owner",
};

/** `down`: 연결이 끊겼다(fetch가 던진다). `silent`: 데드라인까지 아무 말이 없다. */
type Scripted = Response | "down" | "silent";

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const UNAUTHORIZED = () => reply(401, { error: { message: "unauthorized" } });
const ROTATED = () => reply(200, { accessToken: "access-new", refreshToken: "refresh-2" });
// 서버가 갱신 토큰을 보고 세션이 끝났다고 말하는 답들(`auth_routes.rs`의 refresh).
const REFUSED = () => reply(401, { error: { message: "invalid or expired refresh token" } });
const REUSED = () => reply(401, { error: { message: "refresh token already used or revoked" } });
const MEMBER_GONE = () =>
  reply(403, { error: { message: "member is not active in this workspace" } });
// 서버가 아무것도 판정하지 못하고 고장 났다고만 말하는 답.
const FAILING = (status = 500) => reply(status, { error: { message: "internal error" } });

interface Sent {
  path: string;
  method: string;
  bearer: string | null;
  body: Record<string, unknown> | null;
}

interface StageOptions {
  /** 갱신 키가 있는 호스트(폰·데스크탑): 증명을 달아 갱신한다. */
  signer?: boolean;
  exclusiveRotation?: SessionPort["exclusiveRotation"];
}

function stage(script: Scripted[], options: StageOptions = {}) {
  const session = {
    access: "access-old",
    refresh: "refresh-1",
    expired: 0,
    rotated: [] as string[],
  };
  const port: SessionPort = {
    getAccessToken: () => session.access,
    getRefreshToken: () => session.refresh,
    getPersistedSession: () =>
      session.refresh
        ? ({
            refreshToken: session.refresh,
            realtimeWebSocketUrl: "wss://oort.test/ws",
            member,
          } as never)
        : null,
    applyLogin: () => {},
    applyRotation: (access, refresh) => {
      session.access = access;
      session.refresh = refresh;
      session.rotated.push(refresh);
    },
    markAuthExpired: () => {
      session.expired += 1;
    },
    clearSession: () => {},
  };
  if (options.signer) {
    let nonce = 0;
    port.signRefreshProof = async (request): Promise<RefreshDeviceProof> => {
      nonce += 1;
      return {
        publicKey: "AnE1+k/ZOgnc6Yu/aBtL/PUOfA1jVOYq+wv/KjQpYXhl",
        nonce: `00000000-0000-0000-0000-00000000000${nonce}`,
        signedAtMs: request.signedAtMs,
        signature: `sig-${nonce}`,
      };
    };
  }
  if (options.exclusiveRotation) port.exclusiveRotation = options.exclusiveRotation;
  installCoreHost({
    apiBase: () => "https://oort.test",
    absoluteApiBase: () => "https://oort.test",
    buildMode: () => "test",
    session: port,
  });

  const sent: Sent[] = [];
  const queue = [...script];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      sent.push({
        path: String(url).replace("https://oort.test", ""),
        method: init?.method ?? "GET",
        bearer: new Headers(init?.headers).get("Authorization"),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      const next = queue.shift();
      // 모자라면 던지되, 던지기 전에 기록했다: 예상 밖의 요청(루프)은 경로 목록 단정에서 드러난다.
      if (next === undefined) throw new Error(`unexpected request ${String(url)}`);
      if (next === "down") throw new TypeError("network down");
      if (next === "silent") {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      }
      return next;
    })
  );
  return { session, sent, paths: () => sent.map((request) => request.path) };
}

async function failureOf(call: () => Promise<unknown>): Promise<unknown> {
  return call().then(
    () => null,
    (error: unknown) => error
  );
}

function expectUnreachable(failure: unknown): void {
  expect(failure).toBeInstanceOf(NetworkError);
  expect((failure as NetworkError).failure).toBe("unreachable");
  // 이미 있는 연결 문구가 그대로 나간다: 새 문장이 없다.
  expect((failure as NetworkError).message).toMatch(/서버에 닿지 못했어요/);
  expect(failure).not.toBeInstanceOf(ApiError);
}

function expectSessionEnded(failure: unknown): void {
  expect(failure).toBeInstanceOf(ApiError);
  expect((failure as ApiError).status).toBe(401);
  expect(failure).not.toBeInstanceOf(NetworkError);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetCoreHost();
});

describe("A. 갱신이 닿지 못하면 로그인 만료를 선언하지 않는다 (#3993)", () => {
  it("연결이 끊겨 갱신 요청이 못 나가면 만료를 선언하지 않고 연결 오류로 끝난다", async () => {
    const { session, paths } = stage([UNAUTHORIZED(), "down"]);

    const failure = await failureOf(() => authedRequest(LIST_PATH));

    expectUnreachable(failure);
    expect(session.expired).toBe(0);
    // 결정 한 번, 갱신 한 번. 다시 보내지도 갱신을 되풀이하지도 않는다.
    expect(paths()).toEqual([LIST_PATH, REFRESH_PATH]);
    // 세션은 건드리지 않았다: 갱신 토큰도 접근 토큰도 그대로다.
    expect(session.refresh).toBe("refresh-1");
    expect(session.access).toBe("access-old");
    expect(session.rotated).toEqual([]);
  });

  it("실제 답장 전송(sendMessage)도 같다: 세션을 지키고 연결 오류를 돌려준다", async () => {
    const { session, paths } = stage([UNAUTHORIZED(), "down"]);

    const failure = await failureOf(() => sendMessage(WS, CH, "client-msg-1", "답장"));

    expectUnreachable(failure);
    expect(session.expired).toBe(0);
    expect(paths()).toEqual([SEND_PATH, REFRESH_PATH]);
  });

  it("갱신이 데드라인까지 답하지 않아도 같다", async () => {
    vi.useFakeTimers();
    const { session, paths } = stage([UNAUTHORIZED(), "silent"]);

    const pending = failureOf(() => authedRequest(LIST_PATH));
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    const failure = await pending;

    expectUnreachable(failure);
    expect(session.expired).toBe(0);
    expect(paths()).toEqual([LIST_PATH, REFRESH_PATH]);
  });

  it.each([500, 502, 503, 504])(
    "갱신 서버가 %i로 답해도 같다: 고장 난 서버는 세션을 판정하지 않았다",
    async (status) => {
      const { session, paths } = stage([UNAUTHORIZED(), FAILING(status)]);

      const failure = await failureOf(() => authedRequest(LIST_PATH));

      expectUnreachable(failure);
      expect(session.expired).toBe(0);
      expect(paths()).toEqual([LIST_PATH, REFRESH_PATH]);
      expect(session.refresh).toBe("refresh-1");
    }
  );

  it("갱신 키가 있는 호스트에서도 서버 오류는 한 번으로 끝난다: 재서명 루프가 없다", async () => {
    const { session, paths } = stage([UNAUTHORIZED(), FAILING(503), FAILING(503), FAILING(503)], {
      signer: true,
    });

    const failure = await failureOf(() => authedRequest(LIST_PATH));

    expectUnreachable(failure);
    expect(session.expired).toBe(0);
    expect(paths()).toEqual([LIST_PATH, REFRESH_PATH]);
  });

  it("authedResponse도 401을 답으로 돌려주지 않는다: 던진다", async () => {
    const { session } = stage([UNAUTHORIZED(), "down"]);

    // 던지지 않고 401을 돌려주면 호출부(결정 전송)가 그것을 「로그인 만료」로 읽는다.
    const failure = await failureOf(() => authedResponse(SEND_PATH, { method: "POST", body: "{}" }));

    expectUnreachable(failure);
    expect(session.expired).toBe(0);
  });

  it("동시에 401을 받은 요청들은 갱신 하나를 나눠 쓰고 모두 연결 오류로 끝난다", async () => {
    const { session, sent } = stage([UNAUTHORIZED(), UNAUTHORIZED(), "down"]);

    const [first, second] = await Promise.all([
      failureOf(() => authedRequest(`${LIST_PATH}?a=1`)),
      failureOf(() => authedRequest(`${LIST_PATH}?b=2`)),
    ]);

    expectUnreachable(first);
    expectUnreachable(second);
    expect(session.expired).toBe(0);
    expect(sent.filter((request) => request.path === REFRESH_PATH)).toHaveLength(1);
  });
});

describe("C. 닿지 못한 일이 다음 요청의 갱신을 막지 않는다 (#3993)", () => {
  it("끊긴 사이에 실패한 요청 다음 요청은 다시 갱신하고 같은 갱신 토큰을 내민다", async () => {
    const { session, sent, paths } = stage([
      UNAUTHORIZED(),
      "down",
      // 두 번째 요청: 연결이 돌아왔다.
      UNAUTHORIZED(),
      ROTATED(),
      reply(200, { channels: [] }),
    ]);

    expectUnreachable(await failureOf(() => authedRequest(LIST_PATH)));
    const second = await authedRequest(LIST_PATH);

    expect(second.status).toBe(200);
    expect(paths()).toEqual([LIST_PATH, REFRESH_PATH, LIST_PATH, REFRESH_PATH, LIST_PATH]);
    // 첫 갱신은 닿지 못했으니 토큰은 쓰이지 않았다: 둘째 갱신이 같은 토큰을 낸다.
    expect(sent[1]?.body).toEqual({ refreshToken: "refresh-1" });
    expect(sent[3]?.body).toEqual({ refreshToken: "refresh-1" });
    expect(sent[4]?.bearer).toBe("Bearer access-new");
    expect(session.rotated).toEqual(["refresh-2"]);
    expect(session.expired).toBe(0);
  });
});

describe("B. 서버가 세션을 끝냈다고 말하면 그 자리에서 만료를 선언한다 (#3993)", () => {
  it.each([
    ["갱신 토큰이 무효·만료", REFUSED],
    ["재사용 탐지: 이미 쓴 갱신 토큰", REUSED],
    ["멤버가 이 워크스페이스에서 비활성(403)", MEMBER_GONE],
  ])("%s: 만료를 선언하고 401을 돌려준다", async (_label, answer) => {
    // 타이머를 켜 두고 한 번도 돌리지 않는다: 선언이 타이머 뒤로 밀리면 이 시험이 빨개진다.
    vi.useFakeTimers();
    const { session, paths } = stage([UNAUTHORIZED(), answer()]);

    const failure = await failureOf(() => authedRequest(LIST_PATH));

    expectSessionEnded(failure);
    expect(session.expired).toBeGreaterThan(0);
    // 다시 보내지도 갱신을 되풀이하지도 않는다.
    expect(paths()).toEqual([LIST_PATH, REFRESH_PATH]);
  });

  it("재사용 탐지를 갱신 키가 있는 호스트가 받아도 같다: 한 번 재서명하고 곧바로 선언한다", async () => {
    vi.useFakeTimers();
    // 증명한 갱신의 일반 401은 한 번만 다시 서명한다(클라이언트 계약 MUST 2). 둘째도 401이면 끝이다.
    const { session, paths } = stage([UNAUTHORIZED(), REUSED(), REUSED()], { signer: true });

    const failure = await failureOf(() => authedRequest(LIST_PATH));

    expectSessionEnded(failure);
    expect(session.expired).toBeGreaterThan(0);
    expect(paths()).toEqual([LIST_PATH, REFRESH_PATH, REFRESH_PATH]);
  });

  it("authedResponse는 거절 뒤에 401 응답을 그대로 돌려주고 선언한다", async () => {
    const { session } = stage([UNAUTHORIZED(), REUSED()]);

    const res = await authedResponse(SEND_PATH, { method: "POST", body: "{}" });

    expect(res.status).toBe(401);
    expect(session.expired).toBeGreaterThan(0);
  });

  it("회전이 스스로 선언하지 않은 거절도 authedResponse가 선언한다 (갱신 토큰이 이미 지워졌다)", async () => {
    // 다른 탭이 로그아웃한 사이 배타 구간이 저장소를 다시 읽으면 내밀 토큰이 없다. 회전은
    // `rejected`로 끝나지만 그 자리에서는 선언하지 않는다 — 선언은 호출자의 몫이다.
    const { session, paths } = stage([UNAUTHORIZED()], {
      exclusiveRotation: async <T>(work: () => Promise<T>): Promise<T> => {
        session.refresh = "";
        return work();
      },
    });

    const failure = await failureOf(() => authedRequest(LIST_PATH));

    expectSessionEnded(failure);
    // 정확히 한 번: 회전이 부른 것이 아니라 이 호출이 부른 것이다.
    expect(session.expired).toBe(1);
    expect(paths()).toEqual([LIST_PATH]);
  });

  it("갱신은 됐는데 새 토큰으로 다시 보낸 요청도 401이면 선언한다: 루프가 없다", async () => {
    const { session, paths } = stage([
      UNAUTHORIZED(),
      ROTATED(),
      UNAUTHORIZED(),
      // 이 아래는 소비돼서는 안 된다.
      ROTATED(),
      reply(200, { channels: [] }),
    ]);

    const failure = await failureOf(() => authedRequest(LIST_PATH));

    expectSessionEnded(failure);
    expect(session.expired).toBe(1);
    expect(paths()).toEqual([LIST_PATH, REFRESH_PATH, LIST_PATH]);
  });

  it("갱신할 토큰이 없으면 갱신 요청 없이 선언한다", async () => {
    const { session, paths } = stage([UNAUTHORIZED()]);
    session.refresh = "";

    const failure = await failureOf(() => authedRequest(LIST_PATH));

    expectSessionEnded(failure);
    expect(session.expired).toBe(1);
    expect(paths()).toEqual([LIST_PATH]);
  });

  it("동시에 401을 받은 요청들은 거절을 함께 받고 모두 선언한다", async () => {
    const { session, sent } = stage([UNAUTHORIZED(), UNAUTHORIZED(), REUSED()]);

    const [first, second] = await Promise.all([
      failureOf(() => authedRequest(`${LIST_PATH}?a=1`)),
      failureOf(() => authedRequest(`${LIST_PATH}?b=2`)),
    ]);

    expectSessionEnded(first);
    expectSessionEnded(second);
    expect(session.expired).toBeGreaterThan(0);
    expect(sent.filter((request) => request.path === REFRESH_PATH)).toHaveLength(1);
  });
});

describe("갱신이 되면 같은 요청을 새 토큰으로 한 번 다시 보낸다", () => {
  it("선언 없이 응답을 돌려준다", async () => {
    const { session, sent, paths } = stage([UNAUTHORIZED(), ROTATED(), reply(200, { channels: [] })]);

    const res = await authedRequest(LIST_PATH);

    expect(res.status).toBe(200);
    expect(paths()).toEqual([LIST_PATH, REFRESH_PATH, LIST_PATH]);
    expect(sent[0]?.bearer).toBe("Bearer access-old");
    expect(sent[2]?.bearer).toBe("Bearer access-new");
    expect(session.expired).toBe(0);
  });
});

// ---- D. 바이트를 받는 세 헬퍼 -------------------------------------------------
// 미리보기 이미지·첨부·아바타는 JSON 문(`request()`)을 쓸 수 없어 401 회전을 손으로 한 번
// 더 적는다. 앱이 백그라운드에서 돌아온 직후에는 이 요청들이 한꺼번에 나가고, 모두 같은
// 죽은 접근 토큰으로 401을 받는다 — 로그아웃이 가장 쉽게 새는 자리다.

const BLOB_CASES: Array<[string, string, () => Promise<Blob>]> = [
  [
    "fetchUnfurlImage",
    `/v1/workspaces/${WS}/unfurls/u1/image`,
    () => fetchUnfurlImage(`/v1/workspaces/${WS}/unfurls/u1/image`),
  ],
  [
    "fetchAttachmentContent",
    `/v1/workspaces/${WS}/channels/${CH}/attachments/att-1/content`,
    () => fetchAttachmentContent(WS, CH, "att-1"),
  ],
  [
    "fetchWorkspaceAvatar",
    `/v1/workspaces/${WS}/avatar/content?v=1`,
    () => fetchWorkspaceAvatar(`/v1/workspaces/${WS}/avatar/content?v=1`),
  ],
  [
    "fetchMemberAvatar",
    `/v1/workspaces/${WS}/members/m1/avatar/content?v=1`,
    () => fetchMemberAvatar(`/v1/workspaces/${WS}/members/m1/avatar/content?v=1`),
  ],
];

describe.each(BLOB_CASES)("D. %s", (_name, path, call) => {
  it("갱신이 닿지 못하면 만료를 선언하지 않고 연결 오류로 끝난다", async () => {
    const { session, paths } = stage([UNAUTHORIZED(), "down"]);

    const failure = await failureOf(call);

    expectUnreachable(failure);
    expect(session.expired).toBe(0);
    expect(paths()).toEqual([path, REFRESH_PATH]);
  });

  it("갱신 서버가 5xx로 답해도 같다", async () => {
    const { session } = stage([UNAUTHORIZED(), FAILING(503)]);

    const failure = await failureOf(call);

    expectUnreachable(failure);
    expect(session.expired).toBe(0);
  });

  it("갱신이 거절되면 그 자리에서 선언하고 401을 던진다", async () => {
    vi.useFakeTimers();
    const { session, paths } = stage([UNAUTHORIZED(), REUSED()]);

    const failure = await failureOf(call);

    expectSessionEnded(failure);
    expect(session.expired).toBeGreaterThan(0);
    expect(paths()).toEqual([path, REFRESH_PATH]);
  });

  it("갱신이 되면 새 토큰으로 다시 받는다", async () => {
    const { session, sent } = stage([UNAUTHORIZED(), ROTATED(), new Response("bytes", { status: 200 })]);

    const blob = await call();

    expect(await blob.text()).toBe("bytes");
    expect(sent[2]?.bearer).toBe("Bearer access-new");
    expect(session.expired).toBe(0);
  });
});
