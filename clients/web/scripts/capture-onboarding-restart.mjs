#!/usr/bin/env node
// =============================================================================
// 온보딩 진행 상태 영속 캡처 (#3696).
//
//   npm run build && node scripts/capture-onboarding-restart.mjs
//   (또는 build:design. 제품 번들이면 충분하다: 자세 쿼리를 쓰지 않는다.)
//
// 셀프호스트 claim → S1에서 이름을 쓰다가 앱을 끈다. 「끔」은 같은 브라우저
// 컨텍스트에서 탭을 닫고 새 탭을 여는 것이다(sessionStorage는 사라지고
// localStorage는 남는다: 데스크탑 앱 재시작과 같은 저장소 모양).
//
//   1) before-quit     S1에서 이름을 쓴 직후
//   2) after-restart   새 탭: 같은 S1 + 쓰던 초안이 남아 있다
//   3) seed-rejudge    영속 슬롯까지 지운 새 탭: 서버 값(시드 이름·@demo·소유자)으로
//                      S1이 다시 선다(초안은 시드 칸으로 돌아간다)
// 라이트·다크 × 1440. 가로 넘침 0을 잰다. 자격증명·백엔드는 없다.
// =============================================================================

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST_DIR = process.env.DIST_DIR ? resolve(process.env.DIST_DIR) : resolve(WEB_ROOT, "dist");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/onboarding-restart");
const PORT = Number(process.env.CAPTURE_PORT || 5196);
const VIEWPORT = { width: 1440, height: 900 };

const WS = "00000000-0000-7000-8000-000000000001";
const GENERAL = "00000000-0000-7000-8000-000000000201";
const ME = "019f94e3-7a10-79cd-9dee-208f47edd9a8";
const CLAIM_TOKEN = "capture-only-3696".padEnd(43, "x");
const SEED_NAME = "momo Demo Workspace";

const SESSION = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: ME, workspaceId: WS, kind: "human", displayName: "demo", handle: "demo" },
  realtimeWebSocketUrl: `ws://127.0.0.1:${PORT + 900}/connection/websocket`,
};

const ROSTER = [
  {
    id: ME, workspaceId: WS, kind: "human", status: "active", role: "owner",
    displayName: "demo", handle: "demo", channelCount: 1, channelIds: [GENERAL],
    capabilities: [], createdAtMs: 0, updatedAtMs: 0,
  },
];

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function installMocks(context) {
  await context.route("**/v1/**", (route) =>
    json(route, { channels: [], members: [], read_states: [], messages: [], connections: [] })
  );
  await context.route("**/v1/auth/refresh", (route) =>
    json(route, { accessToken: SESSION.accessToken, refreshToken: SESSION.refreshToken, ...SESSION })
  );
  await context.route("**/v1/auth/realtime-token", (route) =>
    json(route, {
      token: "capture-only-not-a-credential", tokenType: "jwt", expiresAtMs: Date.now() + 60_000,
      ttlSeconds: 60, workspaceId: WS, memberId: ME,
    })
  );
  await context.route("**/v1/claim", (route) => json(route, SESSION));
  await context.route(`**/v1/workspaces/${WS}`, (route) =>
    json(route, { workspace: { id: WS, slug: "demo", name: SEED_NAME, updatedAtMs: 1 } })
  );
  await context.route(`**/v1/workspaces/${WS}/members/me`, (route) => json(route, { member: SESSION.member }));
  await context.route(`**/v1/workspaces/${WS}/roster`, (route) => json(route, { members: ROSTER }));
  await context.route(`**/v1/workspaces/${WS}/channels`, (route) =>
    json(route, { channels: [{ id: GENERAL, workspaceId: WS, kind: "public", name: "general", muted: false }] })
  );
}

const failures = [];

async function settle(page) {
  await page.waitForTimeout(400);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
}

async function shoot(page, scheme, name, expect) {
  await page.getByTestId("onboarding-s1").waitFor({ state: "visible" });
  await settle(page);
  const state = await page.evaluate(() => ({
    workspace: document.querySelector('[data-testid="onboarding-s1-workspace-name"]')?.value ?? null,
    overflow: Math.max(
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ...[...document.querySelectorAll("*")]
        .filter((el) => ["auto", "scroll"].includes(getComputedStyle(el).overflowX) && !el.hasAttribute("data-scroll-x"))
        .map((el) => el.scrollWidth - el.clientWidth),
      0
    ),
  }));
  if (state.overflow > 0) failures.push(`${name} ${scheme}: 가로 넘침 ${state.overflow}px`);
  if (expect(state.workspace) !== true) failures.push(`${name} ${scheme}: 이름 칸 값 ${JSON.stringify(state.workspace)}`);
  await page.screenshot({ path: `${OUT_DIR}/s1-${name}-${scheme}.png`, fullPage: false });
  console.log(`  ${name} ${scheme}: 이름 칸 = ${JSON.stringify(state.workspace)}`);
}

async function flow(browser, origin, scheme) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: scheme, reducedMotion: "reduce" });
  await installMocks(context);
  const first = await context.newPage();
  await first.goto(`${origin}/claim/${CLAIM_TOKEN}`, { waitUntil: "networkidle" });
  await first.getByTestId("claim-password").fill("capture-only-not-a-credential");
  await first.getByTestId("claim-confirm").fill("capture-only-not-a-credential");
  await first.getByTestId("claim-submit").click();
  await first.getByTestId("onboarding-s1-workspace-name").waitFor({ state: "visible" });
  await first.getByTestId("onboarding-s1-workspace-name").fill("여명거리 제품팀");
  await shoot(first, scheme, "1-before-quit", (v) => v === "여명거리 제품팀");
  await first.close();

  // 앱을 껐다 켠다: 새 탭 = 빈 sessionStorage, 같은 localStorage.
  const second = await context.newPage();
  await second.goto(origin, { waitUntil: "networkidle" });
  await shoot(second, scheme, "2-after-restart", (v) => v === "여명거리 제품팀");

  // 영속 슬롯이 없어도(지워졌거나 막힘) 서버 값이 시드면 S1이 다시 선다.
  await second.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("oort.onboarding") || key.startsWith("oort.freshSignup") || key.startsWith("momo.web.firstAgent")) {
        localStorage.removeItem(key);
      }
    }
    sessionStorage.clear();
  });
  await second.close();
  const third = await context.newPage();
  await third.goto(origin, { waitUntil: "networkidle" });
  await shoot(third, scheme, "3-seed-rejudge", (v) => v === "");
  await context.close();
}

async function main() {
  if (!existsSync(resolve(DIST_DIR, "index.html"))) {
    throw new Error(`빌드가 없다: ${DIST_DIR}. 먼저 npm run build`);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({
    webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT", extraArgs: ["--outDir", DIST_DIR],
  });
  try {
    const browser = await chromium.launch();
    try {
      for (const scheme of ["light", "dark"]) {
        console.log(`[${scheme}]`);
        await flow(browser, preview.origin, scheme);
      }
    } finally {
      await browser.close();
    }
  } finally {
    await preview.stop();
  }
  if (failures.length > 0) {
    console.log(`failures (${failures.length}):`);
    for (const f of failures) console.log(`  ${f}`);
    process.exit(1);
  }
  console.log(`ok: ${OUT_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
