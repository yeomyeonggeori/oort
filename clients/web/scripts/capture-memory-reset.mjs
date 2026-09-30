#!/usr/bin/env node
// =============================================================================
// 설정 › 기억: 팀 고지 + 기억 초기화 캡처 (ADR-0196 D9, #3212).
//
// Renders the real app against a mocked /v1. Every notice, count and answer is
// a fixture: the shots prove how the client draws what the API says, not that
// the server erases anything.
//
//   npm run build && node scripts/capture-memory-reset.mjs   # -> captures/3212/
//   ONLY=confirming node scripts/capture-memory-reset.mjs
// =============================================================================

import { spawn } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "captures/3212");
const PORT = Number(process.env.CAPTURE_PORT || 5187);
const ORIGIN = `http://127.0.0.1:${PORT}`;
// Tall on purpose: the section is one long column and a review needs all of it in one frame.
const VIEWPORTS = [
  { label: "1280", width: 1280, height: 1500 },
  { label: "390", width: 390, height: 2300 },
];

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";
const GENERAL_ID = "00000000-0000-7000-8000-000000000201";
const ME = "019f94e3-7a10-79cd-9dee-208f47edd9a8";
const JIHOON = "019f94e3-7b0f-7a22-9c13-4d5e6f708192";

const SESSION = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: ME, workspaceId: WORKSPACE_ID, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: `ws://127.0.0.1:${PORT + 900}/connection/websocket`,
};

const roster = (role) => [
  { id: ME, workspaceId: WORKSPACE_ID, kind: "human", status: "active", role, displayName: "곽성재", handle: "seongjae",
    channelCount: 1, channelIds: [GENERAL_ID], capabilities: [], createdAtMs: 0, updatedAtMs: 0 },
  { id: JIHOON, workspaceId: WORKSPACE_ID, kind: "human", status: "active", role: "member", displayName: "박지훈", handle: "jihoon",
    channelCount: 1, channelIds: [GENERAL_ID], capabilities: [], createdAtMs: 0, updatedAtMs: 0 },
];

const settings = (over = {}) => ({
  workspace: { enabled: true, paused: false, resetEpoch: 2, ...over },
  channels: [], me: { paused: false },
});

const NOTICE = {
  enabled: true, paused: false, sending: true, resetEpoch: 2,
  summary: { configured: true, provider: { name: "OpenAI", host: "api.openai.com" }, modelId: "gpt-5.4-mini" },
  embeddings: { model: "multilingual-e5-small", location: "local", sentToProvider: false },
  sends: ["channel_message_text", "author_display_name", "agent_dm_message_text", "digest_text", "memory_item_text", "topic_summary_input"],
  neverSends: ["human_direct_messages", "attachments", "deleted_messages", "excluded_channels", "paused_members_dms"],
};
const COUNTS = { digests: 12, items: 8, evidence: 30, topics: 3, topicSummaries: 3, embeddings: 8, proposals: 1, servings: 5, consolidationPairs: 0, consolidationState: 0 };

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function installMocks(context, v) {
  await context.route("**/v1/**", (route) => json(route, { channels: [], members: [], read_states: [], messages: [] }));
  await context.route("**/v1/auth/login", (route) => json(route, SESSION));
  await context.route("**/v1/auth/refresh", (route) =>
    json(route, { accessToken: SESSION.accessToken, refreshToken: SESSION.refreshToken }));
  await context.route("**/v1/auth/realtime-token", (route) =>
    json(route, { token: "capture-only-not-a-credential", tokenType: "jwt", expiresAtMs: Date.now() + 60_000, ttlSeconds: 60, workspaceId: WORKSPACE_ID, memberId: ME }));
  await context.route("**/v1/workspaces/*/channels", (route) =>
    json(route, { channels: [{ id: GENERAL_ID, workspaceId: WORKSPACE_ID, kind: "public", name: "결제-개발", muted: false }] }));
  await context.route("**/v1/workspaces/*/roster", (route) => json(route, { members: roster(v.role ?? "owner") }));
  await context.route("**/v1/workspaces/*/read-state", (route) => json(route, { read_states: [] }));
  await context.route("**/v1/workspaces/*/memory/settings", (route) => {
    if (route.request().method() === "GET") return json(route, v.settings ?? settings());
    return json(route, (v.settings ?? settings()).workspace);
  });
  await context.route("**/v1/workspaces/*/memory/settings/me", (route) => json(route, { paused: false }));
  await context.route("**/v1/workspaces/*/memory/notice", (route) =>
    v.noticeStatus ? json(route, { error: { message: "boom" } }, v.noticeStatus) : json(route, v.notice ?? NOTICE));
  await context.route("**/v1/workspaces/*/memory/reset", (route) => {
    if (v.resetHang) return new Promise(() => undefined);
    if (v.resetStatus) return json(route, { error: { message: v.resetStatus === 503 ? "memory_reset_busy" : "x" } }, v.resetStatus);
    return json(route, { epoch: 3, deleted: COUNTS });
  });
}

async function waitForServer(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`preview server never came up: ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function open(context) {
  const page = await context.newPage();
  await page.goto(ORIGIN, { waitUntil: "networkidle" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("seongjae@dawn.example");
  await page.getByTestId("login-password").fill("capture-only-not-a-credential");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-list").waitFor({ state: "visible" });
  await page.evaluate(`location.hash = "/settings?section=memory"`);
  return page;
}

async function confirmReset(page, word = "초기화") {
  await page.getByTestId("memory-reset-open").click();
  await page.getByTestId("memory-reset-word").fill(word);
}

const SHOTS = [
  { name: "idle", v: {}, wait: "memory-reset-open" },
  { name: "ask-enable", v: { settings: settings({ enabled: false }), notice: { ...NOTICE, enabled: false, sending: false } }, wait: "memory-workspace-enabled",
    drive: async (page) => { await page.getByTestId("memory-workspace-enabled").click(); await page.getByTestId("memory-enable-ask").waitFor({ state: "visible" }); } },
  { name: "confirming", v: {}, wait: "memory-reset-open", drive: async (page) => { await confirmReset(page, "초기"); } },
  { name: "confirming-armed", v: {}, wait: "memory-reset-open", drive: async (page) => { await confirmReset(page); } },
  { name: "running", v: { resetHang: true }, wait: "memory-reset-open",
    drive: async (page) => { await confirmReset(page); await page.getByTestId("memory-reset-submit").click(); await page.getByText("지우는 중").waitFor({ state: "visible" }); } },
  { name: "done", v: {}, wait: "memory-reset-open",
    drive: async (page) => { await confirmReset(page); await page.getByTestId("memory-reset-submit").click(); await page.getByTestId("memory-reset-done").waitFor({ state: "visible" }); } },
  { name: "stale-409", v: { resetStatus: 409 }, wait: "memory-reset-open",
    drive: async (page) => { await confirmReset(page); await page.getByTestId("memory-reset-submit").click(); await page.getByTestId("memory-reset-error").waitFor({ state: "visible" }); } },
  { name: "busy-503", v: { resetStatus: 503 }, wait: "memory-reset-open",
    drive: async (page) => { await confirmReset(page); await page.getByTestId("memory-reset-submit").click(); await page.getByTestId("memory-reset-error").waitFor({ state: "visible" }); } },
  { name: "forbidden-403", v: { resetStatus: 403 }, wait: "memory-reset-open",
    drive: async (page) => { await confirmReset(page); await page.getByTestId("memory-reset-submit").click(); await page.getByTestId("memory-reset-error").waitFor({ state: "visible" }); } },
  { name: "member", v: { role: "member" }, wait: "memory-reset-admin-only" },
  { name: "guest-custom", v: { role: "guest", notice: { ...NOTICE, summary: { configured: true, provider: { name: "사용자 지정" } } } }, wait: "memory-reset-admin-only" },
  { name: "notice-unknown-code", v: { notice: { ...NOTICE, sends: [...NOTICE.sends, "brand_new_code"], neverSends: [...NOTICE.neverSends, "other_new_code"] } }, wait: "memory-notice-body" },
  { name: "notice-paused-unconfigured", v: { notice: { ...NOTICE, sending: false, summary: { configured: false } } }, wait: "memory-notice-body" },
  { name: "notice-error", v: { noticeStatus: 500 }, wait: "memory-notice-load" },
];

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) throw new Error("dist/ is missing. Run `npm run build` first.");
  mkdirSync(OUT_DIR, { recursive: true });
  const server = spawn(resolve(WEB_ROOT, "node_modules/.bin/vite"),
    ["preview", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], { cwd: WEB_ROOT, stdio: "ignore" });
  const shutdown = () => server.kill("SIGTERM");
  process.on("exit", shutdown);
  try {
    await waitForServer(ORIGIN);
    const browser = await chromium.launch();
    try {
      const only = process.env.ONLY;
      for (const shot of SHOTS) {
        if (only && !shot.name.includes(only)) continue;
        for (const scheme of ["light", "dark"]) {
          for (const vp of VIEWPORTS) {
            const context = await browser.newContext({
              viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1,
              colorScheme: scheme, reducedMotion: "reduce",
            });
            await installMocks(context, shot.v);
            const page = await open(context);
            await page.getByTestId(shot.wait).first().waitFor({ state: "visible", timeout: 15_000 });
            if (shot.drive) await shot.drive(page, context);
            await page.waitForTimeout(200);
            const path = `${OUT_DIR}/${shot.name}-${scheme}-${vp.label}.png`;
            await page.screenshot({ path });
            console.log(path);
            await context.close();
          }
        }
      }
    } finally {
      await browser.close();
    }
  } finally {
    shutdown();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
