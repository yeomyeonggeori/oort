#!/usr/bin/env node
// =============================================================================
// 온보딩 O3 캡처 (#3697, ADR-0198 정합).
//
//   npm run capture:onboarding-o3        # build:design 뒤 dist/를 잰다
//
// 1440 × 라이트·다크.
//   ai-connect-grouped   AI 연결 목록: 에이전트(API 키·그록봇)가 먼저, 구독 CLI는 「내 도구」
//   ai-connect-non-admin 관리자가 아닌 멤버: 잠긴 오류 대신 요청 안내 + [계속]
//   empty-channel-cta    에이전트가 없는 워크스페이스의 소유자: 빈 #general에 「에이전트 연결」
// 앞 둘은 design 전용 `?firstAgent=` 자세, 셋째는 로그인한 셸의 실제 빈 채널이다.
// 가로 넘침 0을 잰다. 자격증명·백엔드는 없다(/v1은 픽스처가 답한다).
// =============================================================================

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST_DIR = process.env.DIST_DIR ? resolve(process.env.DIST_DIR) : resolve(WEB_ROOT, "dist");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/onboarding-o3");
const PORT = Number(process.env.CAPTURE_PORT || 5197);
const VIEWPORT = { width: 1440, height: 900 };

const WS = "00000000-0000-7000-8000-000000000001";
const GENERAL = "00000000-0000-7000-8000-000000000201";
const ME = "019f94e3-7a10-79cd-9dee-208f47edd9a8";

const SESSION = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: ME, workspaceId: WS, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: `ws://127.0.0.1:${PORT + 900}/connection/websocket`,
};

const ROSTER = [
  {
    id: ME, workspaceId: WS, kind: "human", status: "active", role: "owner",
    displayName: "곽성재", handle: "seongjae", channelCount: 1, channelIds: [GENERAL],
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
  await context.route("**/v1/auth/login", (route) => json(route, SESSION));
  await context.route("**/v1/auth/refresh", (route) => json(route, SESSION));
  await context.route("**/v1/auth/realtime-token", (route) =>
    json(route, {
      token: "capture-only-not-a-credential", tokenType: "jwt", expiresAtMs: Date.now() + 60_000,
      ttlSeconds: 60, workspaceId: WS, memberId: ME,
    })
  );
  await context.route(`**/v1/workspaces/${WS}`, (route) =>
    json(route, { workspace: { id: WS, slug: "yeomyeong", name: "여명거리 제품팀", updatedAtMs: 1 } })
  );
  await context.route(`**/v1/workspaces/${WS}/members/me`, (route) => json(route, { member: SESSION.member }));
  await context.route(`**/v1/workspaces/${WS}/roster`, (route) => json(route, { members: ROSTER }));
  await context.route(`**/v1/workspaces/${WS}/channels`, (route) =>
    json(route, { channels: [{ id: GENERAL, workspaceId: WS, kind: "public", name: "general", muted: false }] })
  );
}

const failures = [];

async function overflow(page) {
  return page.evaluate(() =>
    Math.max(
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ...[...document.querySelectorAll("*")]
        .filter((el) => ["auto", "scroll"].includes(getComputedStyle(el).overflowX) && !el.hasAttribute("data-scroll-x"))
        .map((el) => el.scrollWidth - el.clientWidth),
      0
    )
  );
}

async function signIn(page, origin) {
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.getByTestId("connect-entry-submit").click();
  await page.getByTestId("login-email").fill("seongjae@dawn.example");
  await page.getByTestId("login-password").fill("capture-only-not-a-credential");
  await page.getByTestId("login-submit").click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="onboarding-sign-in"]'));
}

async function shoot(page, scheme, name, readyTestId) {
  await page.getByTestId(readyTestId).first().waitFor({ state: "visible" });
  await page.mouse.move(VIEWPORT.width + 80, VIEWPORT.height + 80);
  await page.waitForTimeout(500);
  const over = await overflow(page);
  if (over > 0) failures.push(`${name} ${scheme}: 가로 넘침 ${over}px`);
  await page.screenshot({ path: `${OUT_DIR}/${name}-${scheme}.png` });
  console.log(`  ${name} ${scheme}`);
}

async function scheme(browser, origin, colorScheme) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme, reducedMotion: "reduce" });
  await installMocks(context);
  const page = await context.newPage();
  await signIn(page, origin);
  await page.getByTestId("timeline-empty").waitFor({ state: "visible" });
  const cta = await page.getByTestId("timeline-empty-connect-agent").textContent();
  if (!cta?.includes("에이전트 연결")) failures.push(`empty-channel-cta ${colorScheme}: CTA 문구 ${JSON.stringify(cta)}`);
  await shoot(page, colorScheme, "empty-channel-cta", "timeline-empty-connect-agent");
  for (const [name, pose, ready] of [
    ["ai-connect-grouped", "sub-ready", "ai-connect-group-tools"],
    ["ai-connect-non-admin", "non-admin", "first-agent-non-admin"],
  ]) {
    await page.evaluate((next) => {
      window.location.hash = `/?firstAgent=${next}`;
    }, pose);
    await page.getByTestId("first-agent-stage").waitFor({ state: "visible" });
    await shoot(page, colorScheme, name, ready);
  }
  await context.close();
}

async function main() {
  if (!existsSync(resolve(DIST_DIR, "index.html"))) throw new Error(`빌드가 없다: ${DIST_DIR}`);
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({
    webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT", extraArgs: ["--outDir", DIST_DIR],
  });
  try {
    const browser = await chromium.launch();
    try {
      for (const colorScheme of ["light", "dark"]) {
        console.log(`[${colorScheme}]`);
        await scheme(browser, preview.origin, colorScheme);
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
