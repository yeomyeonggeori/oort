#!/usr/bin/env node
// =============================================================================
// 팀 기억 v2 화면 캡처 (ADR-0196 D12 V1·V2, #3165).
//
// Renders the real app against a mocked /v1: the missed-conversation card in
// every state, the 「기억 n개 참고」 chip and its popover, the channel memory
// dialog and 설정 › 기억 for an admin and for a plain member. Light and dark, at
// 1280 and 390.
//
//   npm run build && node scripts/capture-memory.mjs      # -> captures/3165/
//   OUT_DIR=/tmp/shots node scripts/capture-memory.mjs
//
// The summary worker that fills real digests is a separate ticket, so every
// digest, receipt and setting here is a fixture. The shots prove how the client
// draws what the API says, not that the server produces it.
// =============================================================================

import { spawn } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR
  ? resolve(process.env.OUT_DIR)
  : resolve(WEB_ROOT, "captures/3165");
const PORT = Number(process.env.CAPTURE_PORT || 5183);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const VIEWPORTS = [
  { label: "1280", width: 1280, height: 800 },
  { label: "390", width: 390, height: 844 },
];

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";
const GENERAL_ID = "00000000-0000-7000-8000-000000000201";
const ENGINE_ID = "00000000-0000-7000-8000-000000000202";
const ME = "019f94e3-7a10-79cd-9dee-208f47edd9a8";
const JIHOON = "019f94e3-7b0f-7a22-9c13-4d5e6f708192";
const AGENT = "019f94e3-8b21-7ae0-b3c4-5f1a2d6e7c90";
const RUN = "0199aa11-2222-7000-8000-0000000000c4";
const NOW = Date.parse("2026-09-29T09:30:00+09:00");

const SESSION = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: ME, workspaceId: WORKSPACE_ID, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: `ws://127.0.0.1:${PORT + 900}/connection/websocket`,
};

const CHANNELS = [
  { id: GENERAL_ID, workspaceId: WORKSPACE_ID, kind: "public", name: "결제-개발", topic: "결제 모듈 개발 채널", muted: false },
  { id: ENGINE_ID, workspaceId: WORKSPACE_ID, kind: "public", name: "엔진", muted: false },
];

function roster(role) {
  const base = (id, kind, displayName, handle, extra = {}) => ({
    id, workspaceId: WORKSPACE_ID, kind, status: "active", role: "member", displayName, handle,
    channelCount: 2, channelIds: [GENERAL_ID, ENGINE_ID], capabilities: [],
    createdAtMs: 0, updatedAtMs: 0, ...extra,
  });
  return [
    base(ME, "human", "곽성재", "seongjae", { role }),
    base(JIHOON, "human", "박지훈", "jihoon"),
    base(AGENT, "agent", "김인턴", "kim-intern", { ownerHumanId: ME, agentModel: "claude-opus-5" }),
  ];
}

const LINES = [
  [JIHOON, "결제 콜백이 간헐적으로 타임아웃 나요. 어제 밤부터 세 번 봤어요."],
  [ME, "재시도 큐가 밀리는 걸까요? 로그 한 번 볼게요."],
  [JIHOON, "큐 깊이는 정상인데 워커 하나가 계속 재시작해요."],
  [ME, "그럼 워커 수를 늘리기 전에 재시작 원인부터 잡죠."],
  [JIHOON, "메모리 한도에 걸려서 OOM으로 죽고 있었어요."],
  [ME, "한도를 올리고 재시도 큐 크기도 늘려 두죠."],
  [JIHOON, "좋아요. 배포는 목요일 오전으로 미룰게요."],
  [ME, "@김인턴 지난주 결제 장애 요약 좀 부탁해요."],
];

function messages() {
  const base = NOW - 40 * 60_000;
  const rows = LINES.map(([author, body], i) => ({
    id: `cap-${1408 + i}`, channelId: GENERAL_ID, seq: 1408 + i,
    hlcTs: base + i * 60_000, hlcCount: 0, authorMemberId: author, type: "text",
    body, state: "sent", createdAtMs: base + i * 60_000,
  }));
  rows.push({
    id: "cap-1416", channelId: GENERAL_ID, seq: 1416, hlcTs: base + 9 * 60_000, hlcCount: 0,
    authorMemberId: AGENT, type: "text", state: "sent", createdAtMs: base + 9 * 60_000,
    body: "지난주 결제 장애는 재시도 큐 고갈이 원인이었고, 큐 크기를 늘려 해결했어요.",
    props: {
      source: "agent_worker.final_text.v0", run_id: RUN, trigger_message_id: "cap-1415",
      trigger_message_seq: 1415, author_member_id: AGENT,
    },
  });
  return rows;
}

const digest = (over = {}) => ({
  id: "00000000-0000-7000-8000-000000000401",
  channelId: GENERAL_ID, level: "window", fromSeq: 1408, toSeq: 1415,
  body: "결제 콜백 타임아웃은 워커가 메모리 한도에 걸려 재시작하던 것이 원인이었어요.\n메모리 한도와 재시도 큐 크기를 늘리기로 했고, 배포는 목요일 오전으로 미뤘어요.",
  sourceCount: 8, model: "team-summary", createdAtMs: NOW - 5 * 60_000,
  evidence: [
    { messageId: "cap-1410", channelId: GENERAL_ID, seq: 1410 },
    { messageId: "cap-1412", channelId: GENERAL_ID, seq: 1412 },
    { messageId: "cap-1414", channelId: GENERAL_ID, seq: 1414 },
  ],
  ...over,
});

const SETTINGS_ON = {
  workspace: { enabled: true, paused: false, resetEpoch: 0 },
  channels: [], me: { paused: false },
};

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

/** `v` describes one variant: role, settings, digests page, receipt. */
async function installMocks(context, v) {
  await context.route("**/v1/**", (route) =>
    json(route, { channels: [], members: [], read_states: [], messages: [] }));
  await context.route("**/v1/auth/login", (route) => json(route, SESSION));
  await context.route("**/v1/auth/refresh", (route) =>
    json(route, { accessToken: SESSION.accessToken, refreshToken: SESSION.refreshToken }));
  await context.route("**/v1/auth/realtime-token", (route) =>
    json(route, { token: "capture-only-not-a-credential", tokenType: "jwt", expiresAtMs: Date.now() + 60_000, ttlSeconds: 60, workspaceId: WORKSPACE_ID, memberId: ME }));
  await context.route("**/v1/workspaces/*/channels", (route) => json(route, { channels: CHANNELS }));
  await context.route("**/v1/workspaces/*/roster", (route) => json(route, { members: roster(v.role ?? "owner") }));
  await context.route("**/v1/workspaces/*/read-state", (route) =>
    json(route, { read_states: [
      { channel_id: GENERAL_ID, last_read_seq: 1409, latest_seq: 1416, unread_count: 7, mention_count: 1 },
      { channel_id: ENGINE_ID, last_read_seq: 40, latest_seq: 40, unread_count: 0, mention_count: 0 },
    ] }));
  await context.route("**/v1/workspaces/*/channels/*/read-state", (route) =>
    json(route, { channel_id: GENERAL_ID, last_read_seq: 1416, latest_seq: 1416, unread_count: 0, mention_count: 0 }));
  await context.route("**/v1/workspaces/*/channels/*/messages*", (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("before") || url.searchParams.has("after")) return json(route, { messages: [] });
    return json(route, { messages: messages() });
  });
  await context.route("**/v1/workspaces/*/memory/settings", async (route) => {
    if (route.request().method() === "GET") return json(route, v.settings ?? SETTINGS_ON);
    return json(route, (v.settings ?? SETTINGS_ON).workspace);
  });
  await context.route("**/v1/workspaces/*/memory/settings/me", (route) => json(route, { paused: true }));
  await context.route("**/v1/workspaces/*/channels/*/memory/settings", (route) =>
    json(route, { channelId: GENERAL_ID, excluded: false, paused: false }));
  await context.route("**/v1/workspaces/*/channels/*/memory/digests*", async (route) => {
    if (v.digestsHang) return new Promise(() => undefined);
    if (v.digestsStatus) return json(route, { error: { message: "boom" } }, v.digestsStatus);
    return json(route, v.digests ?? { digests: [digest()], afterSeq: 1409, summarizedThroughSeq: 1416 });
  });
  await context.route("**/v1/workspaces/*/agent-runs/*/memory-receipt", (route) =>
    v.receipt ? json(route, { receipt: v.receipt }) : json(route, { error: { message: "no receipt" } }, 404));
}

async function waitForServer(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`preview server never came up: ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function open(context, hash) {
  const page = await context.newPage();
  await page.goto(ORIGIN, { waitUntil: "networkidle" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("seongjae@dawn.example");
  await page.getByTestId("login-password").fill("capture-only-not-a-credential");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-list").waitFor({ state: "visible" });
  await page.evaluate(`location.hash = ${JSON.stringify(hash)}`);
  return page;
}

const receipt = (over = {}) => ({
  runId: RUN, channelId: GENERAL_ID, servedCount: 2, digestIds: [digest().id],
  digests: [digest()], budgetChars: 6000, usedChars: 1800, createdAtMs: NOW, ...over,
});

/** Each entry: name, hash to open, variant, and what to do before the shot. */
const SHOTS = [
  { name: "card-ready", hash: `/c/${GENERAL_ID}`, v: {}, wait: "missed-summary-digest" },
  { name: "card-ready-behind", hash: `/c/${GENERAL_ID}`,
    v: { digests: { digests: [digest()], afterSeq: 1409, summarizedThroughSeq: 1413 } }, wait: "missed-summary-behind" },
  { name: "card-not-yet", hash: `/c/${GENERAL_ID}`,
    v: { digests: { digests: [], afterSeq: 1409, summarizedThroughSeq: 1410 } }, wait: "missed-summary-notYet" },
  { name: "card-empty", hash: `/c/${GENERAL_ID}`,
    v: { digests: { digests: [], afterSeq: 1409, summarizedThroughSeq: 1416 } }, wait: "missed-summary-empty" },
  { name: "card-off", hash: `/c/${GENERAL_ID}`,
    v: { settings: { ...SETTINGS_ON, workspace: { enabled: true, paused: true, resetEpoch: 0 } } }, wait: "missed-summary-off" },
  { name: "card-error", hash: `/c/${GENERAL_ID}`, v: { digestsStatus: 500 }, wait: "missed-summary-error" },
  { name: "card-loading", hash: `/c/${GENERAL_ID}`, v: { digestsHang: true }, wait: "missed-summary-loading" },
  { name: "chip", hash: `/c/${GENERAL_ID}`, v: { receipt: receipt() }, wait: "memory-receipt-chip",
    drive: async (page) => { await page.getByTestId("memory-receipt-chip").scrollIntoViewIfNeeded(); } },
  { name: "chip-popover-withheld", hash: `/c/${GENERAL_ID}`, v: { receipt: receipt({ withheldCount: 3, servedCount: 1 }) },
    wait: "memory-receipt-chip",
    drive: async (page) => {
      await page.getByTestId("memory-receipt-chip").click();
      await page.getByTestId("memory-receipt-popover").waitFor({ state: "visible" });
    } },
  { name: "chip-popover", hash: `/c/${GENERAL_ID}`, v: { receipt: receipt({ servedCount: 1 }) }, wait: "memory-receipt-chip",
    drive: async (page) => {
      await page.getByTestId("memory-receipt-chip").click();
      await page.getByTestId("memory-receipt-popover").waitFor({ state: "visible" });
    } },
  { name: "channel-dialog-admin", hash: `/c/${GENERAL_ID}`, v: {}, wait: "channel-title-menu",
    drive: async (page) => {
      await page.getByTestId("channel-title-menu").click();
      await page.getByTestId("channel-memory-settings").click();
      await page.getByTestId("channel-memory-excluded").waitFor({ state: "visible" });
    } },
  { name: "channel-dialog-member", hash: `/c/${GENERAL_ID}`, v: { role: "member" }, wait: "channel-title-menu",
    drive: async (page) => {
      await page.getByTestId("channel-title-menu").click();
      await page.getByTestId("channel-memory-settings").click();
      await page.getByTestId("channel-memory-reason").waitFor({ state: "visible" });
    } },
  { name: "settings-admin", hash: "/settings?section=memory", v: {}, wait: "memory-workspace-enabled" },
  { name: "settings-member", hash: "/settings?section=memory", v: { role: "member" }, wait: "memory-admin-reason" },
  { name: "settings-error", hash: "/settings?section=memory", v: {}, wait: "memory-workspace-enabled",
    drive: async (page, context) => {
      await context.route("**/v1/workspaces/*/memory/settings", (route) =>
        route.request().method() === "PATCH"
          ? route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: { message: "forbidden" } }) })
          : route.fallback());
      await page.getByTestId("memory-workspace-enabled").click();
      await page.getByTestId("memory-write-error").waitFor({ state: "visible" });
    } },
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
            const page = await open(context, shot.hash);
            await page.getByTestId(shot.wait).first().waitFor({ state: "visible", timeout: 15_000 });
            if (shot.drive) await shot.drive(page, context);
            await page.waitForTimeout(150);
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
