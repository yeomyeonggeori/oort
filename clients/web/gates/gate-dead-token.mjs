#!/usr/bin/env node
// =============================================================================
// GATE — 죽은 토큰으로 열면 로그인 화면이 선다 (#5244).
//
// 저장된 로그인이 있는데 그 refresh 토큰이 죽어 있다(폐기·만료·재사용). 앱을 열면 「복원 중」 스켈레톤이 서고, 서버는 401 로 답하고,
// 세션은 지워지고, 로그인 화면이 선다. 로그인 화면은 왜 여기인지를 말한다(「로그인이 만료됐어요」, #5221). 이 레인이 재는 것은
// 그 한 줄이다: **스켈레톤이 영영 남지 않는다.**
//
// 왜 재는가: `useRestoredSession` 은 복원이 자격을 지우는 순간 효과 정리가 `cancelled` 를 세워 자기 `.then` 과 시간 예산
// 타이머(2.5초)를 함께 걷는다. 그 뒤 화면을 로그인으로 넘기는 일은 코어가 지우기 직전에 세우는 만료 신호(`markAuthExpired`)와
// 훅의 방어 효과가 맡는다. 둘 다 잃으면 스켈레톤이 영영 남는다 — 예산도 이미 걷혔으므로 아무것도 풀어 주지 않는다.
// jsdom 시험(src/app/sessionDeadToken.test.tsx)은 훅과 코어의 연결을 재고, 이 레인은 진짜 번들·진짜 브라우저·진짜 localStorage
// 에서 같은 일을 한 번 더 잰다.
//
// 가짜는 서버(`/v1`)뿐이다: 이 refresh 토큰은 서버가 모른다(401). 응답은 일부러 늦게 보낸다(REFRESH_DELAY_MS) — 그동안
// 스켈레톤이 서 있어야 이 실행이 「복원 중」에서 출발했음을 알 수 있다. 출발하지 않았으면 아무것도 잰 것이 아니다.
//
// 빌드 뒤에 실행:
//   npm run gate:dead-token
//
// 사보타주 증명(기대: FAIL): 훅의 방어 효과와 코어의 `markAuthExpired()` 를 함께 지운 번들을 따로 빌드해 이 레인에 먹인다.
//   DEAD_TOKEN_GATE_OUTDIR=/절대/경로/dist-sabotage node gates/gate-dead-token.mjs  (빌드 없이 그 번들만 서빙한다)
// 코어가 만료 신호를 세우는 번들에서는 방어 효과 하나만 지운 번들도 이 레인에서 초록이다 — 방어 효과 하나의 몫은 jsdom 시험
// (훅 단독 모의)이 재고, 이 레인은 둘이 함께 사라지는 회귀와 연결(안내 배너·localStorage 비움)을 잰다.
//
// LIMIT: Chromium + Vite preview. 데스크탑(Tauri, WKWebView)의 키체인 경로는 여기서 재지 않는다 — 그 분기의 복원은 같은 훅을
// 쓰고, 키체인 IPC 는 src/app/boot.test.ts 와 src/lib/session.tabs.test.ts 가 mock 으로 잰다(실기기는 runtime-unverified).
// =============================================================================

import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "./preview-guard.mjs";
import { ONBOARDING_SURFACE } from "../e2e/advanceOnboarding.mjs";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.DEAD_TOKEN_GATE_PORT || 5266);
const origin = `http://127.0.0.1:${port}`;
const REFRESH_DELAY_MS = Number(process.env.DEAD_TOKEN_REFRESH_DELAY_MS || 1000);
// 마지막 확인 전에 기다리는 시간: 출하 기본 시간 예산(app/boot.ts, 2 500 ms)을 넘겨, 늦게 뒤집히는 화면이 없음을 본다.
const PAST_BUDGET_MS = 3_000;
const CEILING_MS = Number(process.env.DEAD_TOKEN_GATE_CEILING_MS || 12_000);
const outDirEnv = process.env.DEAD_TOKEN_GATE_OUTDIR || "";
const outDir = outDirEnv ? (isAbsolute(outDirEnv) ? outDirEnv : resolve(webRoot, outDirEnv)) : resolve(webRoot, "dist");

const STORAGE_KEY = "momo.web.session.v1";
const workspaceId = "00000000-0000-7000-8000-000000000001";
// 서버가 받아 주는 값이 아니다: 이 모양의 문자열은 어떤 서버도 모르고, 가짜 서버는 무엇이든 401 로 답한다.
const DEAD_REFRESH = "gate-only-dead-refresh";
const persisted = {
  refreshToken: DEAD_REFRESH,
  realtimeWebSocketUrl: "ws://127.0.0.1:1/connection/websocket",
  member: {
    id: "019f94e3-7a10-79cd-9dee-208f47edd9a8",
    workspaceId,
    kind: "human",
    displayName: "곽성재",
    handle: "seongjae",
  },
};

function fail(message) {
  throw new Error(message);
}

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function main() {
  if (!existsSync(resolve(outDir, "index.html"))) {
    fail(`${outDir}/index.html is missing. Run npm run build first.`);
  }
  const preview = await startGuardedPreview({
    webRoot,
    port,
    portEnvVar: "DEAD_TOKEN_GATE_PORT",
    extraArgs: outDirEnv ? ["--outDir", outDir] : [],
  });

  let browser;
  const refreshCalls = [];
  const pageErrors = [];
  try {
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" });

    // 저장된 로그인으로 부팅한다 — 스크립트가 돌기 전에 심는다(첫 렌더가 「복원 중」을 읽는다).
    await context.addInitScript(
      ([key, record]) => {
        localStorage.setItem(key, record);
      },
      [STORAGE_KEY, JSON.stringify(persisted)]
    );

    await context.route("**/v1/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === "/v1/auth/refresh") {
        let token = null;
        try {
          token = JSON.parse(request.postData() ?? "{}").refreshToken ?? null;
        } catch {
          token = null;
        }
        refreshCalls.push({ token });
        await new Promise((done) => setTimeout(done, REFRESH_DELAY_MS));
        return json(route, { error: { message: "invalid refresh token" } }, 401);
      }
      return json(route, { error: { message: "not found" } }, 404);
    });

    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(String(error.message ?? error)));

    const restoring = page.locator('[data-testid="session-restoring"]');
    const surface = page.locator(ONBOARDING_SURFACE).first();
    const expiredNotice = page.locator('[data-testid="session-expired-notice"]');
    const unreachableNotice = page.locator('[data-testid="boot-unreachable-notice"]');

    const started = Date.now();
    await page.goto(origin, { waitUntil: "commit" });

    // 1) 출발점: 「복원 중」이다. 로그인 화면이 아니다.
    try {
      await restoring.waitFor({ state: "attached", timeout: CEILING_MS });
    } catch {
      fail("저장된 로그인으로 열었는데 「복원 중」 스켈레톤이 서지 않았다 — 이 실행은 복원 경로에서 출발하지 않았으므로 아무것도 재지 않았다");
    }
    if ((await surface.count()) > 0) fail("스켈레톤과 로그인 화면이 함께 서 있다");

    // 2) 죽은 토큰의 401 뒤 로그인 화면이 선다. 스켈레톤이 영영 남으면 여기서 마감을 넘긴다.
    try {
      await surface.waitFor({ state: "visible", timeout: CEILING_MS });
    } catch {
      fail(
        `죽은 토큰(401)으로 열었는데 ${CEILING_MS} ms 안에 로그인 화면이 서지 않았다 — ` +
          `스켈레톤 ${(await restoring.count()) > 0 ? "그대로 남음(복원 중에 머문다)" : "없음"}`
      );
    }
    const elapsed = Date.now() - started;

    const verify = async (phase) => {
      if ((await restoring.count()) > 0) fail(`[${phase}] 로그인 화면이 섰는데 스켈레톤이 남아 있다`);
      if ((await expiredNotice.count()) === 0) {
        fail(`[${phase}] 로그인 화면이 「로그인이 만료됐어요」를 말하지 않는다(만료 신호가 안내까지 이어지지 않았다)`);
      }
      if ((await unreachableNotice.count()) > 0) {
        fail(`[${phase}] 죽은 토큰인데 「서버에 닿지 못했어요」가 선다 — 서버는 401 로 답했다`);
      }
      const stored = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
      if (stored !== null) fail(`[${phase}] 죽은 토큰의 저장된 로그인이 지워지지 않았다`);
    };
    await verify("로그인 화면 직후");
    if (refreshCalls.length !== 1) fail(`refresh 요청이 ${refreshCalls.length}회다(기대 1회)`);
    if (refreshCalls[0].token !== DEAD_REFRESH) fail("refresh 요청이 저장된 토큰을 싣지 않았다");

    // 3) 예산을 넘겨도 그대로다.
    await page.waitForTimeout(PAST_BUDGET_MS);
    await verify("시간 예산 뒤");
    if (refreshCalls.length !== 1) fail(`예산 뒤 refresh 요청이 ${refreshCalls.length}회다(기대 1회)`);
    if (pageErrors.length > 0) fail(`처리되지 않은 페이지 오류 ${pageErrors.length}건: ${pageErrors[0]}`);

    console.log(
      JSON.stringify(
        {
          gate: "dead-token",
          pass: true,
          loginScreenAfterMs: elapsed,
          refreshRequests: refreshCalls.length,
          bundle: outDirEnv ? outDir : "dist",
        },
        null,
        2
      )
    );
  } finally {
    await browser?.close();
    await preview.stop();
  }
}

main().catch((error) => {
  console.error(`GATE FAIL: ${error.message ?? error}`);
  process.exitCode = 1;
});
