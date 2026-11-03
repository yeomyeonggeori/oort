// @vitest-environment jsdom

import "@/lib/coreHost";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoginResponse } from "@momo/core/lib/api";
import { applyLogin, clearSession, hasPersistedSession } from "@/lib/session";
import { clearSessionNotices } from "@/lib/sessionNotice";
import { useRestoredSession, type SessionLifecycle } from "@/app/session";

// =============================================================================
// #5244 — 죽은 토큰으로 열 때 세션 상태가 「복원 중」에 머무는가. 재현 결과(2026-11-03):
//
//   ① 실제 코어(refresh 401)로 열면 머물지 않는다. 그런데 화면을 넘기는 쪽은 `useRestoredSession` 의 `.then` 이 아니다.
//      브라우저의 순서: 코어가 자격을 지우기 직전에 `markAuthExpired()`(packages/momo-core/src/lib/api.ts 의 rotateOnce)를 세우고
//      → 그 알림의 재그리기가 만료 효과(app/session.tsx)를 먼저 세워 로그인 화면으로 넘기고 → 복원 효과의 정리가 `cancelled` 를
//      세워 `.then` 을 걷는다(측정한 순서: 만료 효과 → 정리 → `.then`(cancelled=true)).
//   ② 그 신호 없이 복원이 자격을 지우고 null 을 주면(`restoreSession()` 문서가 약속하는 모양 그대로이고 `sessionNotice.test.tsx` 의
//      죽은 토큰 모의와 같은 모양이다. 그 시험은 안내만 단정하고 상태는 단정하지 않는다) 머문다. 자격이 지워지며 `resumable` 이
//      꺼지면 같은 정리가 `.then` 도 시간 예산 타이머(2.5초)도 걷으니, 아무것도 화면을 풀어 주지 않는 「복원 중」이다.
//   → 훅에 「복원 중인데 복원할 로그인이 없다」 방어를 두었다. 이 파일이 두 길(①·②)과 방어가 끼지 말아야 할 두 자리를 지킨다.
//
// 왜 act 를 쓰지 않는가: act 범위 안에서는 React 갱신이 범위 끝까지 쥐어져, ① 에서 `.then` 이 정리보다 **먼저** 돈다
// (측정한 순서: `.then`(cancelled=false) → 정리). 브라우저와 반대 순서라 ① 의 만료 효과는 한 번도 서지 않는다. 그래서 act 환경을
// 끄고 순서를 있는 그대로 돌린다. 가짜인 것은 시계(시간 예산 2.5초·회전 잠금 40ms·요청 마감)와 서버(`/v1`)뿐이다.
// =============================================================================

const restore = vi.hoisted(() => ({
  impl: null as null | (() => Promise<LoginResponse | null>),
}));

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    // 기본은 실제 복원(코어의 회전·지우기·만료 신호까지). 시험이 `restore.impl` 로 갈아 끼운다.
    restoreSession: () => (restore.impl ?? actual.restoreSession)(),
  };
});

vi.mock("@/features/updates/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/updates/store")>()),
  startUpdateWatch: () => () => undefined,
}));

// 로그인된 셸과 첫 실행 화면은 이 시험이 그리지 않는다(죽은 토큰은 로그인 화면으로 간다). 읽는 것은 App·세션 훅·복원 화면·로그인 화면·안내이고,
// 아래 셋은 그 모듈 그래프(콜드 임포트의 대부분)만 줄이는 스텁이다 — App.githubHandoff.test.tsx 와 같은 방식이다.
vi.mock("@/features/chat/ChatShell", () => ({ ChatShell: () => null }));
vi.mock("@/app/AppShell", () => ({ AppShell: () => null }));
vi.mock("@/features/onboarding/OwnerOnboarding", () => ({ OwnerOnboarding: () => null }));

const LOGIN = {
  accessToken: "access",
  refreshToken: "dead-refresh-token",
  realtimeWebSocketUrl: "wss://example.test/connection/websocket",
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
// 가짜 시계를 켜기 전에 잡아 둔 진짜 setTimeout: React 스케줄러의 일은 진짜 틱으로 돈다.
const realSetTimeout = globalThis.setTimeout;

let root: Root | null = null;
let host: HTMLElement | null = null;

interface Sent {
  path: string;
  method: string;
  body: string;
}
const sent: Sent[] = [];
let releaseRefresh: () => void = () => undefined;

beforeAll(async () => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  // 첫 마운트가 `./App` 모듈 그래프 전체를 읽는다(콜드 임포트). 시험 안에서 읽으면 시험의 5s 가 그 값을 진다.
  await import("./App");
}, 60_000);

afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  clearSession();
  clearSessionNotices();
  restore.impl = null;
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
  // `/v1` 모의: 이 refresh 토큰은 서버가 모른다(폐기·만료·재사용 — 코어는 401 을 「세션이 끝났다」로 읽는다).
  // 답은 시험이 `releaseRefresh()` 로 풀어 줄 때까지 붙든다 — 그동안 화면이 어디에 있는지를 단정하려고.
  sent.length = 0;
  const refreshGate = new Promise<void>((release) => {
    releaseRefresh = release;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), window.location.origin).pathname;
      sent.push({ path, method: init?.method ?? "GET", body: String(init?.body ?? "") });
      if (path === "/v1/auth/refresh") {
        await refreshGate;
        return reply(401, { error: { message: "invalid refresh token" } });
      }
      return reply(404, { error: { message: "not found" } });
    })
  );
});

afterEach(() => {
  releaseRefresh();
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
  clearSessionNotices();
  restore.impl = null;
});

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const restoring = () => q("session-restoring") !== null;
// 로그인 화면의 첫 갈래들: 서버 주소를 묻는 D0, 저장된 서버의 D1, 초대의 D1′(e2e/advanceOnboarding.mjs 와 같은 낱말).
const onLoginScreen = () => ["onboarding-welcome", "onboarding-sign-in", "onboarding-join"].some((id) => q(id) !== null);
const refreshCalls = () => sent.filter((call) => call.path === "/v1/auth/refresh");

/** 가짜 시계를 옮기고, 진짜 틱을 한 번 내줘 React 스케줄러의 일까지 돌린다. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await new Promise<void>((done) => realSetTimeout(done, 0));
  await vi.advanceTimersByTimeAsync(0);
}

/** 조건이 설 때까지 `step` 씩 옮긴다. 시간 예산(2.5초)을 넘기지 않게 `limitMs` 로 막는다 — 예산이 풀어 준 화면은 이 시험이 재는 것이 아니다. */
async function until(done: () => boolean, limitMs = 1_000, step = 50): Promise<void> {
  for (let spent = 0; spent <= limitMs && !done(); spent += step) await advance(step);
}

function mount(node: ReturnType<typeof createElement>): void {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root?.render(node));
}

async function mountApp(): Promise<void> {
  const { App } = await import("./App");
  mount(createElement(App));
}

describe("세션 훅: 죽은 토큰으로 열기 (#5244)", { timeout: 20_000 }, () => {
  // 지키는 것: 실제 코어 복원(refresh 401)이 로그인 화면까지 간다. 시간 예산이 풀어 준 것이 아니어야 하므로 예산 안에서 끝난다.
  it("실제 복원이 401 을 받으면 자격이 지워지고 시간 예산 전에 로그인 화면이 선다", async () => {
    applyLogin(LOGIN); // 저장된 로그인이 있어야 「복원 중」으로 시작한다
    await mountApp();
    await advance(100); // 회전 잠금(40ms) 뒤 refresh 가 날아간다
    expect(refreshCalls()).toHaveLength(1);
    expect(JSON.parse(refreshCalls()[0].body)).toEqual({ refreshToken: LOGIN.refreshToken });
    expect(restoring()).toBe(true); // 출발점: 답을 기다리는 동안은 스켈레톤이다
    expect(onLoginScreen()).toBe(false);

    releaseRefresh();
    await until(onLoginScreen);
    expect(onLoginScreen()).toBe(true);
    expect(restoring()).toBe(false);
    expect(hasPersistedSession()).toBe(false);
    // 로그인 화면은 왜 여기인지를 말한다: 코어가 세운 만료 신호가 안내까지 이어진다(#5221). 「서버에 닿지 못했어요」는 아니다.
    expect(q("session-expired-notice")).not.toBeNull();
    expect(q("boot-unreachable-notice")).toBeNull();
    expect(refreshCalls()).toHaveLength(1);

    // 예산(2.5초)이 지나도 그대로다 — 늦게 뭔가 바뀌는 화면이 아니다.
    await advance(5_000);
    expect(onLoginScreen()).toBe(true);
    expect(restoring()).toBe(false);
    expect(q("session-expired-notice")).not.toBeNull();
    expect(q("boot-unreachable-notice")).toBeNull();
    expect(refreshCalls()).toHaveLength(1);
  });

  // 지키는 것: 훅의 방어. 복원이 만료 신호 없이 자격을 지우고 null 을 줘도 「복원 중」에 머물지 않는다.
  it("복원이 만료 신호 없이 자격을 지우고 null 을 줘도 로그인 화면이 선다", async () => {
    applyLogin(LOGIN);
    let answer: () => void = () => undefined;
    restore.impl = async () => {
      await new Promise<void>((resolve) => {
        answer = resolve;
      });
      clearSession();
      return null;
    };
    await mountApp();
    expect(restoring()).toBe(true);

    answer();
    await until(onLoginScreen);
    expect(restoring()).toBe(false);
    expect(onLoginScreen()).toBe(true);
    expect(hasPersistedSession()).toBe(false);
    expect(q("boot-unreachable-notice")).toBeNull(); // 자격이 지워졌으니 「그대로 남아 있다」는 말은 거짓이다
    expect(refreshCalls()).toHaveLength(0); // 코어는 부르지 않았다: 훅 단독의 길이다

    await advance(5_000);
    expect(restoring()).toBe(false);
    expect(onLoginScreen()).toBe(true);
  });

  // 지키는 것: 방어는 「복원할 로그인이 없을 때」만 낀다. 저장된 로그인이 남은 채 답이 늦으면 예산이 풀어 줄 때까지 복원 중이다.
  it("저장된 로그인이 남아 있으면 답이 늦는 동안 복원 중이고, 예산이 지나면 로그인 화면과 안내가 선다", async () => {
    applyLogin(LOGIN);
    restore.impl = () => new Promise<LoginResponse | null>(() => undefined);
    await mountApp();
    await advance(100);
    expect(restoring()).toBe(true);
    expect(onLoginScreen()).toBe(false);
    expect(hasPersistedSession()).toBe(true);

    await advance(2_600);
    expect(restoring()).toBe(false);
    expect(onLoginScreen()).toBe(true);
    expect(q("boot-unreachable-notice")).not.toBeNull();
    expect(q("session-expired-notice")).toBeNull();
    expect(hasPersistedSession()).toBe(true);
  });

  // 지키는 것: 방어는 「복원 중」일 때만 낀다. 저장소가 빈 채로 로그인 상태가 된 경우를 로그인 전으로 되돌리지 않는다(그 경계를 `status` 조건이 긋는다).
  it("복원 중이 아니면 방어가 끼지 않는다: 저장소가 빈 채 로그인한 상태는 그대로 남는다", async () => {
    const seen: { lifecycle: SessionLifecycle | null } = { lifecycle: null };
    function Probe() {
      const lifecycle = useRestoredSession();
      seen.lifecycle = lifecycle;
      return createElement("span", { "data-testid": "probe-status" }, lifecycle.status);
    }
    mount(createElement(Probe));
    expect(q("probe-status")?.textContent).toBe("anonymous"); // 저장된 로그인이 없으니 복원 중으로 시작하지 않는다
    flushSync(() => seen.lifecycle?.signIn(LOGIN)); // `applyLogin` 없이: 저장소에는 아무것도 없다
    expect(hasPersistedSession()).toBe(false);
    await advance(100);
    expect(q("probe-status")?.textContent).toBe("signed-in");
    expect(seen.lifecycle?.session).toEqual(LOGIN);
  });
});
