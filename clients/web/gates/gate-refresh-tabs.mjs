#!/usr/bin/env node
// =============================================================================
// GATE — refresh 토큰 회전의 탭 간 조율 (#3067, R1 재사용 계보 폐기의 전제).
//
// 서버는 refresh 토큰을 한 번만 받는다(MOMO-300). #3065 부터 이미 소비된 토큰이
// 다시 오면 서버는 그것을 **도난**으로 읽고 계보를 폐기할 수 있다
// (`MOMO_REFRESH_REUSE_SWEEP_ALL_SESSIONS`). 그 플래그를 켜려면 한 브라우저의
// 여러 탭이 같은 토큰을 두 번 내는 일이 없어야 한다. 이 게이트가 재는 것은 그
// 하나다: **같은 브라우저 컨텍스트의 여러 탭이 동시에 회전해도 재사용 0회.**
//
//   ① 동시 부팅. 탭 3개를 동시에 새로고침하면 셋 다 부팅 복원으로 회전한다.
//      세 탭은 모두 같은 저장 토큰을 읽고 시작하므로, 조율이 없으면 둘은 이미
//      쓰인 토큰을 낸다. 라운드를 여러 번 돌고, 매 라운드 뒤 전 탭이 로그인
//      상태여야 한다.
//   ② 로그아웃 전파. 한 탭에서 로그아웃하면 나머지 탭도 연결 화면으로 가야
//      한다 — 남은 탭이 지워진 세션의 셸을 계속 그리면 안 된다.
//
// 가짜 서버는 **실서버보다 엄격하다**: 30초 재시도 유예가 없다. 이미 소비된
// 토큰은 도착 즉시 재사용으로 센다. 유예가 있는 mock 이면 이 게이트는 헛돈다.
// 응답은 일부러 늦게 보낸다(REFRESH_DELAY_MS) — 경합 창을 넓혀, 조율이 없을 때
// 재사용이 우연이 아니라 매번 나게 한다.
//
// 두 번 돈다: navigator.locks 그대로(Chromium 기본), 그리고 navigator.locks 를
// 지운 컨텍스트(localStorage 임대 폴백). 한쪽만 재면 폴백은 한 줄도 재지 않는다.
//
// 빌드 뒤에 실행:
//   npm run gate:refresh-tabs
//
// LIMIT: Chromium + Vite preview. 데스크탑(Tauri, WKWebView)의 키체인 경로는
// 여기서 재지 않는다 — 그 분기는 src/lib/session.tabs.test.ts 가 mock 키체인으로
// 재고, 실제 다중 창은 runtime-unverified 다(현재 셸은 창 하나만 연다).
// =============================================================================

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "./preview-guard.mjs";
import { advanceToAccount, ONBOARDING_SURFACE } from "../e2e/advanceOnboarding.mjs";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.REFRESH_TABS_GATE_PORT || 5197);
const origin = `http://127.0.0.1:${port}`;
const TABS = Number(process.env.REFRESH_TABS || 3);
const ROUNDS = Number(process.env.REFRESH_ROUNDS || 3);
const REFRESH_DELAY_MS = Number(process.env.REFRESH_DELAY_MS || 250);
const SHELL = "nav[aria-label='워크스페이스 탐색']";

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "019f94e3-7a10-79cd-9dee-208f47edd9a8";
const member = {
  id: memberId,
  workspaceId,
  kind: "human",
  displayName: "곽성재",
  handle: "seongjae",
};

/** Single-use refresh server, no grace window. */
function makeAuthServer() {
  const state = {
    serial: 0,
    live: new Set(),
    consumed: new Set(),
    rotations: 0,
    reuse: 0,
    unknown: 0,
    reuseLog: [],
    rotationLog: [],
  };
  const mint = () => {
    state.serial += 1;
    const refreshToken = `gate-refresh-${state.serial}`;
    state.live.add(refreshToken);
    return { accessToken: `gate-access-${state.serial}`, refreshToken };
  };
  return {
    state,
    login() {
      return { ...mint(), member, realtimeWebSocketUrl: `ws://127.0.0.1:${port + 900}/connection/websocket` };
    },
    /** Returns the pair, or null for a 401. Decides on ARRIVAL, like the server. */
    refresh(token, tab) {
      if (state.live.has(token)) {
        state.live.delete(token);
        state.consumed.add(token);
        state.rotations += 1;
        state.rotationLog.push(`${tab}: ${token}`);
        return mint();
      }
      if (state.consumed.has(token)) {
        state.reuse += 1;
        state.reuseLog.push(`${tab}: ${token}`);
      } else {
        state.unknown += 1;
      }
      return null;
    },
    logout(token) {
      if (token) {
        state.live.delete(token);
        state.consumed.add(token);
      }
    },
  };
}

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function installRoutes(context, server) {
  await context.route("**/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/v1/auth/login") return json(route, server.login());
    if (path === "/v1/auth/refresh") {
      let token = null;
      try {
        token = JSON.parse(request.postData() ?? "{}").refreshToken ?? null;
      } catch {
        token = null;
      }
      const tab = request.frame()?.page()?.__tab ?? "?";
      const pair = server.refresh(token, tab);
      await new Promise((done) => setTimeout(done, REFRESH_DELAY_MS));
      if (!pair) return json(route, { error: { message: "invalid refresh token" } }, 401);
      return json(route, pair);
    }
    if (path === "/v1/auth/logout") {
      try {
        server.logout(JSON.parse(request.postData() ?? "{}").refreshToken ?? null);
      } catch {
        // body shape is not what this gate measures
      }
      return json(route, { revokedRefresh: true });
    }
    if (path === "/v1/auth/realtime-token") return json(route, { token: "gate-only-not-a-credential" });
    if (path.endsWith("/channels")) return json(route, { channels: [] });
    if (path.endsWith("/roster")) return json(route, { members: [] });
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.includes("/messages")) return json(route, { messages: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    return json(route, {});
  });
}

function fail(message) {
  throw new Error(message);
}

async function runScenario(browser, { withoutLocks }) {
  const label = withoutLocks ? "lease-fallback" : "navigator.locks";
  const server = makeAuthServer();
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" });
  await installRoutes(context, server);
  if (withoutLocks) {
    await context.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, "locks", { configurable: true, get: () => undefined });
    });
  }
  const probeLocks = async (page) => page.evaluate(() => typeof navigator.locks?.request === "function");

  try {
    const pages = [];
    const first = await context.newPage();
    first.__tab = "tab0";
    pages.push(first);
    await first.goto(origin, { waitUntil: "networkidle" });
    if ((await probeLocks(first)) === withoutLocks) {
      fail(`[${label}] navigator.locks 존재 여부가 시나리오와 다르다 — 이 실행은 의도한 경로를 재지 않는다`);
    }
    await advanceToAccount(first);
    await first.getByTestId("login-email").fill("tabs@example.test");
    await first.getByTestId("login-password").fill("not-a-secret");
    await first.getByTestId("login-submit").click();
    await first.waitForSelector(SHELL);

    // 나머지 탭은 저장된 세션으로 부팅한다 — 동시에.
    const rest = [];
    for (let i = 1; i < TABS; i++) {
      const page = await context.newPage();
      page.__tab = `tab${i}`;
      rest.push(page);
      pages.push(page);
    }
    // 재사용 판정을 셸 대기보다 먼저 한다: 재사용이 나면 그 탭은 세션을 지우고
    // 연결 화면으로 가므로, 셸 타임아웃이 진짜 원인을 가린다.
    const settle = async (group, phase) => {
      const settled = await Promise.allSettled(
        group.map((page) => page.waitForSelector(SHELL, { timeout: 20_000 }))
      );
      if (server.state.reuse > 0) {
        fail(
          `[${label}] ${phase}: 서버가 refresh 재사용 ${server.state.reuse}회를 감지했다 ` +
            `(${server.state.reuseLog.join(", ")}). 탭 간 회전이 조율되지 않는다.`
        );
      }
      const out = settled
        .map((result, index) => (result.status === "rejected" ? group[index].__tab : null))
        .filter(Boolean);
      if (out.length) fail(`[${label}] ${phase}: 로그인 셸로 돌아오지 못한 탭 ${out.join(", ")}`);
    };
    await Promise.all(rest.map((page) => page.goto(origin)));
    await settle(rest, "동시 부팅");

    for (let round = 1; round <= ROUNDS; round++) {
      await Promise.all(pages.map((page) => page.reload()));
      await settle(pages, `라운드 ${round}`);
    }
    if (server.state.unknown > 0) fail(`[${label}] 서버가 모르는 refresh 토큰 ${server.state.unknown}회`);
    const expectedMin = TABS - 1 + TABS * ROUNDS;
    if (server.state.rotations < expectedMin) {
      fail(`[${label}] 회전 ${server.state.rotations}회 < 기대 ${expectedMin}회 — 부팅 복원이 회전하지 않았다면 이 게이트는 아무것도 재지 않았다`);
    }

    // ② 로그아웃 전파
    await first.getByTestId("profile-card").click();
    await first.getByTestId("profile-logout").click();
    await first.getByTestId("profile-logout-confirm-action").click();
    await first.locator(ONBOARDING_SURFACE).first().waitFor({ state: "visible", timeout: 10_000 });
    const stayed = [];
    for (const page of rest) {
      try {
        await page.locator(ONBOARDING_SURFACE).first().waitFor({ state: "visible", timeout: 5_000 });
      } catch {
        stayed.push(page.__tab);
      }
    }
    if (stayed.length) fail(`[${label}] 다른 탭에서 로그아웃했는데 셸에 남은 탭: ${stayed.join(", ")}`);
    if (server.state.reuse > 0) fail(`[${label}] 로그아웃 중 refresh 재사용 ${server.state.reuse}회`);

    return { scenario: label, tabs: TABS, rounds: ROUNDS, rotations: server.state.rotations, rotationLog: process.env.REFRESH_TABS_VERBOSE === "1" ? server.state.rotationLog : undefined, reuse: server.state.reuse, unknown: server.state.unknown, logoutPropagated: true };
  } finally {
    await context.close();
  }
}

async function main() {
  if (!existsSync(resolve(webRoot, "dist/index.html"))) {
    throw new Error("dist/ is missing. Run npm run build first.");
  }
  const preview = await startGuardedPreview({ webRoot, port, portEnvVar: "REFRESH_TABS_GATE_PORT" });
  const results = [];
  let failure = null;
  try {
    const browser = await chromium.launch();
    try {
      for (const withoutLocks of [false, true]) {
        try {
          results.push(await runScenario(browser, { withoutLocks }));
        } catch (error) {
          failure ??= error;
          results.push({ scenario: withoutLocks ? "lease-fallback" : "navigator.locks", error: String(error.message ?? error) });
        }
      }
    } finally {
      await browser.close();
    }
  } finally {
    await preview.stop();
  }
  console.log(JSON.stringify({ gate: "refresh-tabs", pass: failure === null, results }, null, 2));
  if (failure) process.exit(1);
}

await main();
