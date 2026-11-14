// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

// #5816 — 저장된 세션은 그것을 낸 서버의 것이다. 다시 연 뒤의 세션(access 값은 메모리 전용이라 없고 refresh만 저장됨)이
// 저장된 채 서버 주소가 바뀌어도, 그 세션의 값은 다음 서버로 한 번도 가지 않는다. 실제 웹 세션 저장소·서버 주소·코어 호스트로 잰다.

const OLD = "https://old.oort.test";
const NEXT = "https://next.oort.test";
const MEMBER = {
  id: "0199aaaa-0000-7000-8000-000000000001",
  workspaceId: "00000000-0000-7000-8000-000000000001",
  kind: "human",
  displayName: "김도현",
  handle: "dohyeon",
};

interface Sent {
  origin: string;
  path: string;
  authorization: string | null;
  body: string;
}

type Answer = (call: Sent) => Promise<Response> | Response;

let sent: Sent[] = [];
let answer: Answer = () => new Response("{}", { status: 200 });

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

/** 앞 서버의 값(`-old`)이 실린 요청. */
const carriesOld = (call: Sent) => /-old/.test(call.authorization ?? "") || /-old/.test(call.body);

/** 앱을 다시 연다: 저장소에는 앞 서버 주소와 refresh만 든 세션 기록이 있고, 모듈은 새로 읽힌다(access 값 없음). */
async function reopen(seed?: Record<string, string>) {
  if (seed) {
    localStorage.clear();
    for (const [key, value] of Object.entries(seed)) localStorage.setItem(key, value);
  }
  vi.resetModules();
  await import("./coreHost");
  return {
    session: await import("./session"),
    serverBase: await import("./serverBase"),
    notice: await import("./sessionNotice"),
    api: await import("@momo/core/lib/api"),
  };
}

const REOPENED = {
  "momo.web.server.v1": OLD,
  "momo.web.session.v1": JSON.stringify({
    refreshToken: "rt-old",
    realtimeWebSocketUrl: "wss://old.oort.test/connection/websocket",
    member: MEMBER,
  }),
};

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const call = {
      origin: url.origin,
      path: url.pathname,
      authorization: new Headers(init?.headers).get("Authorization"),
      body: typeof init?.body === "string" ? init.body : "",
    };
    sent.push(call);
    return answer(call);
  })
);

afterEach(() => {
  sent = [];
  answer = () => new Response("{}", { status: 200 });
  localStorage.clear();
});

describe("다시 연 뒤 refresh만 저장된 세션이 있는 채 서버 주소를 바꾸면", () => {
  it("그 세션은 기기에서 끝나고, 뒤이은 다시 시도·새로 고침의 복원은 다음 서버로 아무 값도 보내지 않는다", async () => {
    // 다시 연 뒤 앞 서버가 닿지 않아 복원이 끝나지 못했다: 세션은 refresh만 저장된 채 남는다.
    answer = () => json({ error: { message: "busy" } }, 503);
    let app = await reopen(REOPENED);
    expect(await app.api.restoreSession()).toBeNull();
    expect(app.session.getAccessToken()).toBeNull();
    expect(app.session.getRefreshToken()).toBe("rt-old");

    sent = [];
    answer = (call) =>
      call.path === "/v1/auth/refresh" ? json({ accessToken: "at-next", refreshToken: "rt-next" }) : json({});
    app.serverBase.setServerBase(NEXT);

    expect(app.serverBase.apiBase()).toBe(NEXT);
    expect(app.session.getRefreshToken()).toBeNull();
    expect(app.session.getAccessToken()).toBeNull();
    expect(localStorage.getItem("momo.web.session.v1")).toBeNull();
    // 로그인 화면은 어느 서버의 로그인이 끝났는지 말하고, 「저장된 로그인은 그대로」는 걷힌다.
    expect(app.notice.getServerSwitchSignedOutNotice()).toBe(OLD);
    expect(app.notice.getBootUnreachableNotice()).toBe(false);

    // 다시 시도.
    expect(await app.api.restoreSession()).toBeNull();
    // 새로 고침(같은 저장소에서 다시 읽음).
    app = await reopen();
    expect(app.serverBase.apiBase()).toBe(NEXT);
    expect(await app.api.restoreSession()).toBeNull();

    expect(sent.filter((call) => call.origin === NEXT)).toEqual([]);
    expect(sent.filter(carriesOld)).toEqual([]);
  });

  it("복원이 떠 있는 동안 바꾸면 그 복원이 받은 짝을 앞 서버에서 끝내고, 다음 서버로는 아무 값도 보내지 않는다", async () => {
    let land: (response: Response) => void = () => undefined;
    answer = (call) => {
      if (call.path === "/v1/auth/refresh") return new Promise<Response>((resolve) => (land = resolve));
      return json({});
    };
    const app = await reopen(REOPENED);
    expect(app.session.getAccessToken()).toBeNull();
    const restoring = app.api.restoreSession();
    await vi.waitFor(() => expect(sent.map((call) => `${call.origin}${call.path}`)).toEqual([`${OLD}/v1/auth/refresh`]));

    app.serverBase.setServerBase(NEXT);
    expect(app.session.getRefreshToken()).toBeNull();
    land(json({ accessToken: "at-old-2", refreshToken: "rt-old-2" }));

    expect(await restoring).toBeNull();
    await vi.waitFor(() => expect(sent.filter((call) => call.path === "/v1/auth/logout")).toHaveLength(1));
    expect(sent.filter((call) => call.path === "/v1/auth/logout")).toEqual([
      {
        origin: OLD,
        path: "/v1/auth/logout",
        authorization: "Bearer at-old-2",
        body: JSON.stringify({ refreshToken: "rt-old-2" }),
      },
    ]);
    expect(sent.filter((call) => call.origin === NEXT)).toEqual([]);
    expect(app.session.getRefreshToken()).toBeNull();
    expect(app.notice.getServerSwitchSignedOutNotice()).toBe(OLD);
  });

  it("세션이 없으면 주소만 바뀌고 로그인 화면에 남길 사실도 없다", async () => {
    const app = await reopen({ "momo.web.server.v1": OLD });
    app.serverBase.setServerBase(NEXT);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toEqual([]);
    expect(app.notice.getServerSwitchSignedOutNotice()).toBeNull();
  });
});
