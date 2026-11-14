// @vitest-environment jsdom

import "@/lib/coreHost";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoginResponse } from "@momo/core/lib/api";
import { applyLogin, clearSession, hasPersistedSession } from "@/lib/session";
import { clearSessionNotices } from "@/lib/sessionNotice";
import { setServerBase } from "@/lib/serverBase";

// =============================================================================
// #5816 — 저장된 로그인이 있는 채 서버를 바꾸면 그 로그인은 앞 서버에서 끝난다. 로그인 화면은 그 사실을 말한다:
// 어느 서버의 로그인이 끝났는지를 남기고, 「저장된 로그인은 그대로」는 걷는다. 뒤이어 끝나는 복원·다시 시도·앞 서버의 늦은 답이
// 그 문장을 지우거나 다른 문장으로 덮지 않는다.
//
// sessionDeadToken.test.tsx 와 같은 틀이다: act 환경을 끄고 React 의 순서를 브라우저처럼 돌린다. 가짜인 것은 시계와 서버(`/v1`)뿐이다.
// =============================================================================

vi.mock("@/features/updates/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/updates/store")>()),
  startUpdateWatch: () => () => undefined,
}));
vi.mock("@/features/chat/ChatShell", () => ({ ChatShell: () => null }));
vi.mock("@/app/AppShell", () => ({ AppShell: () => null }));
vi.mock("@/features/onboarding/OwnerOnboarding", () => ({ OwnerOnboarding: () => null }));

const OLD = "https://old.oort.test";
const NEXT = "https://next.oort.test";

const LOGIN = {
  accessToken: "access-old",
  refreshToken: "refresh-old",
  realtimeWebSocketUrl: "wss://old.oort.test/connection/websocket",
  member: {
    id: "00000000-0000-7000-8000-0000000001ff",
    workspaceId: "00000000-0000-7000-8000-000000000001",
    kind: "human",
    displayName: "이도현",
    handle: "dohyun",
  },
} as unknown as LoginResponse;

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
const realSetTimeout = globalThis.setTimeout;

let root: Root | null = null;
let host: HTMLElement | null = null;

interface Sent {
  origin: string;
  path: string;
}
let sent: Sent[] = [];
/** 앞 서버의 refresh 답: 시험이 정한다. */
let refreshAnswer: () => Promise<Response> = async () => reply(503, {});

beforeAll(async () => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  await import("./App");
}, 60_000);

afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  clearSession();
  setServerBase(OLD);
  clearSessionNotices();
  window.history.replaceState(null, "", "/");
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      sent.push({ origin: url.origin, path: url.pathname });
      if (url.pathname === "/v1/auth/refresh") return refreshAnswer();
      return reply(404, { error: { message: "not found" } });
    })
  );
});

afterEach(() => {
  if (root) {
    const mounted = root;
    flushSync(() => mounted.unmount());
  }
  root = null;
  host?.remove();
  host = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  clearSession();
  setServerBase(null);
  clearSessionNotices();
});

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const switchNotice = () => q("server-switch-signed-out-notice");

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await new Promise<void>((done) => realSetTimeout(done, 0));
  await vi.advanceTimersByTimeAsync(0);
}

async function mountApp(): Promise<void> {
  const { App } = await import("./App");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root?.render(createElement(App)));
}

describe("저장된 로그인이 있는 채 서버를 바꾸면 로그인 화면이 그 사실을 말한다 (#5816)", { timeout: 20_000 }, () => {
  // 지키는 것: 늦는 복원 때문에 「저장된 로그인은 그대로」가 선 로그인 화면에서 서버를 바꾸면, 그 문장 대신 앞 서버의 로그인이 끝났다는
  // 문장이 서고, 앞 서버의 늦은 거절(만료)이 와도 그 문장이 남는다. 다음 서버로는 아무 요청도 가지 않는다.
  it("늦는 복원 중에 바꾸면 앞 서버 이름과 함께 끝났다고 말하고, 늦은 거절도 그 문장을 덮지 않는다", async () => {
    let answer: (response: Response) => void = () => undefined;
    refreshAnswer = () => new Promise<Response>((resolve) => (answer = resolve));
    applyLogin(LOGIN);
    await mountApp();
    await advance(2_600); // 시간 예산(2.5초)이 지나 로그인 화면과 「그대로」 안내가 선다
    expect(q("boot-unreachable-notice")).not.toBeNull();
    expect(switchNotice()).toBeNull();

    setServerBase(NEXT);
    await advance(0);
    expect(hasPersistedSession()).toBe(false);
    expect(q("boot-unreachable-notice")).toBeNull();
    expect(switchNotice()?.textContent).toContain("old.oort.test");
    expect(switchNotice()?.querySelector("button")).toBeNull();

    // 앞 서버가 늦게 「모르는 토큰」으로 답한다(만료 신호가 선다).
    answer(reply(401, { error: { message: "invalid refresh token" } }));
    refreshAnswer = async () => reply(401, { error: { message: "invalid refresh token" } });
    await advance(5_000);
    expect(switchNotice()?.textContent).toContain("old.oort.test");
    expect(q("session-expired-notice")).toBeNull();
    expect(q("boot-unreachable-notice")).toBeNull();
    expect(sent.filter((call) => call.origin === NEXT)).toEqual([]);
  });

  // 지키는 것: 복원이 닿지 않고 끝나 「다시 시도」가 도는 동안 서버를 바꿔도, 그 다시 시도가 아무것도 남기지 않고 끝나면서 문장을 걷지 않는다.
  it("다시 시도가 도는 동안 바꾸면, 다시 시도가 끝나도 앞 서버의 로그인이 끝났다는 문장이 남는다", async () => {
    refreshAnswer = async () => reply(503, { error: { message: "busy" } });
    applyLogin(LOGIN);
    await mountApp();
    await advance(200);
    const retry = q("boot-unreachable-notice")?.querySelector("button");
    expect(retry).toBeTruthy();

    let answer: (response: Response) => void = () => undefined;
    refreshAnswer = () => new Promise<Response>((resolve) => (answer = resolve));
    retry?.click();
    await advance(100);
    setServerBase(NEXT);
    await advance(0);
    expect(switchNotice()?.textContent).toContain("old.oort.test");

    answer(reply(503, { error: { message: "busy" } }));
    await advance(1_000);
    expect(hasPersistedSession()).toBe(false);
    expect(switchNotice()?.textContent).toContain("old.oort.test");
    expect(q("boot-unreachable-notice")).toBeNull();
    expect(sent.filter((call) => call.origin === NEXT)).toEqual([]);
  });
});
