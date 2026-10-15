#!/usr/bin/env node
// =============================================================================
// CAPTURE (#3821): 에이전트 프로필 카드(보기·편집·오류), 멘션 목록, 에이전트 목록. 1440 light/dark.
//
//   npm run build && OUT_DIR=<dir> node scripts/capture-3821.mjs
// =============================================================================

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.IDENTITY_CAPTURE_PORT || 5198);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/identity");
const PHOTO = process.env.PHOTO ? readFileSync(process.env.PHOTO) : null;
const DESKTOP = { width: 1440, height: 900 };

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000201";
const ME = "019f94e3-7a10-79cd-9dee-208f47edd9a8";
const HERMES = "019f9a01-0000-7000-8000-000000000401";
const GROK = "019f9a01-0000-7000-8000-000000000402";
const PHOTO_PATH = `/v1/workspaces/${WS}/members/${HERMES}/avatar/content?v=m1`;

const SESSION = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: ME, workspaceId: WS, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: "ws://identity-capture.invalid/connection/websocket",
};
const base = { workspaceId: WS, status: "active", channelCount: 1, channelIds: [CH], capabilities: [], createdAtMs: 0, updatedAtMs: 0 };
const ROSTER = [
  { ...base, id: ME, kind: "human", role: "owner", displayName: "곽성재", handle: "seongjae" },
  { ...base, id: HERMES, kind: "agent", role: "member", displayName: "hermes", handle: "hermes", ownerHumanId: ME, paused: false,
    ...(PHOTO ? { avatarUrl: PHOTO_PATH } : {}), tagline: "코드 리뷰와 배포 점검을 도와요" },
  { ...base, id: GROK, kind: "agent", role: "member", displayName: "그록", handle: "grok", ownerHumanId: ME, paused: false,
    tagline: "리서치와 요약 담당이에요", statusText: "오늘 오후까지 리서치 중", statusEmoji: "🔎", statusExpiresAtMs: Date.now() + 6 * 3_600_000 },
];

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function installMocks(context, { renameStatus }) {
  await context.route("**/v1/**", (route) => json(route, { channels: [], members: [], read_states: [], messages: [] }));
  await context.route("**/v1/auth/login", (route) => json(route, SESSION));
  await context.route("**/v1/auth/refresh", (route) => json(route, { accessToken: SESSION.accessToken, refreshToken: SESSION.refreshToken }));
  await context.route("**/v1/auth/realtime-token", (route) =>
    json(route, { token: "x", tokenType: "jwt", expiresAtMs: Date.now() + 60_000, ttlSeconds: 60, workspaceId: WS, memberId: ME }));
  await context.route("**/v1/workspaces/*/channels", (route) => json(route, { channels: [{ id: CH, workspaceId: WS, kind: "public", name: "general", muted: false }] }));
  await context.route("**/v1/workspaces/*/roster", (route) => json(route, { members: ROSTER }));
  await context.route("**/v1/workspaces/*/read-state", (route) => json(route, { read_states: [] }));
  await context.route("**/v1/workspaces/*/channels/*/huddles/active", (route) => json(route, { huddle: null, participants: [] }));
  await context.route("**/v1/workspaces/*/channels/*/messages*", (route) => json(route, { messages: [] }));
  await context.route("**/v1/workspaces/*/agents/*/profile", (route) => json(route, { error: { message: "not found" } }, 404));
  if (PHOTO) {
    await context.route("**/members/*/avatar/content*", (route) => route.fulfill({ status: 200, contentType: "image/png", body: PHOTO }));
  }
  await context.route(/\/v1\/workspaces\/[^/]+\/agents\/[^/]+$/, (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    return renameStatus === 409
      ? json(route, { error: { message: "display name is already in use" } }, 409)
      : json(route, { member: { id: GROK, workspaceId: WS, kind: "agent", displayName: "그록", handle: "grok" } });
  });
}

async function waitForServer(url) {
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("preview server never came up");
}

async function login(context) {
  const page = await context.newPage();
  await page.goto(ORIGIN, { waitUntil: "networkidle" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("seongjae@dawn.example");
  await page.getByTestId("login-password").fill("capture-only-not-a-credential");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-list").waitFor({ state: "visible" });
  return page;
}

async function shoot(scheme, server) {
  const context = await server.newContext({ viewport: DESKTOP, deviceScaleFactor: 2, colorScheme: scheme, reducedMotion: "reduce" });
  await installMocks(context, { renameStatus: 409 });
  const page = await login(context);
  const tag = `1440-${scheme}`;
  // 멘션 목록
  await page.evaluate((id) => { location.hash = `/c/${id}`; }, CH);
  const composer = page.locator("textarea").first();
  await composer.waitFor({ state: "visible" });
  await composer.click();
  await composer.type("@");
  await page.locator("[data-testid='composer-mention-list'], [role='listbox']").first().waitFor({ state: "visible" });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT_DIR}/c3821-mention-list-${tag}.png` });
  await composer.fill("");
  // 에이전트 목록 + 프로필 카드(보기)
  await page.evaluate((id) => { location.hash = `/agents?agent=${id}`; }, GROK);
  await page.getByTestId("agent-identity-card").waitFor({ state: "visible" });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT_DIR}/c3821-agent-list-card-view-${tag}.png` });
  // 편집
  await page.getByTestId("agent-identity-edit").click();
  await page.getByTestId("agent-identity-name-input").fill("그록 2호");
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT_DIR}/c3821-card-edit-${tag}.png` });
  // 오류(409)
  await page.getByTestId("agent-identity-name-input").fill("hermes");
  await page.getByTestId("agent-identity-save").click();
  await page.getByTestId("agent-identity-error").waitFor({ state: "visible" });
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT_DIR}/c3821-card-error-${tag}.png` });
  await context.close();
}

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) throw new Error("dist/ is missing. Run `npm run build` first.");
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = spawn(resolve(WEB_ROOT, "node_modules/.bin/vite"), ["preview", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], { cwd: WEB_ROOT, stdio: "ignore" });
  process.on("exit", () => preview.kill("SIGTERM"));
  try {
    await waitForServer(ORIGIN);
    const browser = await chromium.launch();
    try {
      for (const scheme of ["light", "dark"]) await shoot(scheme, browser);
    } finally {
      await browser.close();
    }
  } finally {
    preview.kill("SIGTERM");
  }
}
main().catch((error) => { console.error(error); process.exit(1); });
