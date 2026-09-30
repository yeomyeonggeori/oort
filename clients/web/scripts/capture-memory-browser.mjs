#!/usr/bin/env node
// =============================================================================
// 「기억해 둘게요」 제안 카드 + 기억 브라우저 화면 캡처 (ADR-0196 D12 V3·V4, #3170).
//
// Renders the real app against a mocked /v1: the proposal card under an agent reply in
// every state (pending, self-accept warning, guest read-only, accepted, rejected, 409,
// error) and the memory browser (list + detail, edit, forget confirm, guest, old version,
// empty, error). Light and dark, at 1280 and 390.
//
//   npm run build && node scripts/capture-memory-browser.mjs      # -> captures/3170/
//   OUT_DIR=/tmp/shots ONLY=proposal node scripts/capture-memory-browser.mjs
//
// Every proposal, item and event here is a fixture. The shots prove how the client draws
// what the API says, not that the server produces it (runtime-unverified).
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
  : resolve(WEB_ROOT, "captures/3170");
const PORT = Number(process.env.CAPTURE_PORT || 5184);
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
const PROPOSAL = "0199aa11-3333-7000-8000-000000000601";
const ITEM_A = "0199aa11-4444-7000-8000-000000000701";
const ITEM_B = "0199aa11-4444-7000-8000-000000000702";
const ITEM_C = "0199aa11-4444-7000-8000-000000000703";
const ITEM_OLD = "0199aa11-4444-7000-8000-000000000704";
const NOW = Date.parse("2026-09-30T09:30:00+09:00");

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
  [ME, "한도를 올리고 재시도 큐 크기도 두 배로 늘려 두죠."],
  [JIHOON, "좋아요. 배포는 목요일 오전으로 미룰게요."],
  [ME, "@김인턴 지난주 결제 장애 정리 좀 부탁해요."],
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
    body: "지난주 결제 장애는 워커 메모리 한도가 원인이었고, 한도와 재시도 큐 크기를 늘려 해결했어요.",
    props: {
      source: "agent_worker.final_text.v0", run_id: RUN, trigger_message_id: "cap-1415",
      trigger_message_seq: 1415, author_member_id: AGENT,
    },
  });
  return rows;
}

const proposal = (over = {}) => ({
  id: PROPOSAL, channelId: GENERAL_ID, runId: RUN, agentMemberId: AGENT, requesterMemberId: JIHOON,
  kind: "decision", status: "pending",
  text: "결제 워커의 메모리 한도를 올리고, 재시도 큐 크기는 두 배로 늘려서 운영하기로 했어요.",
  evidenceMessageIds: ["cap-1413", "cap-1414"],
  evidence: [
    { messageId: "cap-1413", seq: 1413, authorMemberId: ME },
    { messageId: "cap-1414", seq: 1414, authorMemberId: JIHOON },
  ],
  callerIsRequester: false, createdAtMs: NOW - 2 * 60_000, expiresAtMs: NOW + 14 * 86_400_000, ...over,
});
const decided = (status, over = {}) =>
  proposal({ status, text: undefined, evidence: [], evidenceMessageIds: [], decidedBy: ME, decidedAtMs: NOW, ...over });

const EVIDENCE = [
  { messageId: "cap-1413", channelId: GENERAL_ID, seq: 1413 },
  { messageId: "cap-1414", channelId: GENERAL_ID, seq: 1414 },
];
const item = (over = {}) => ({
  id: ITEM_A, channelId: GENERAL_ID, spaceKind: "channel", kind: "decision", origin: "confirmed",
  body: "결제 워커의 메모리 한도를 올리고, 재시도 큐 크기는 두 배로 늘려서 운영하기로 했어요.",
  validFromMs: NOW - 86_400_000, recordedAtMs: NOW - 86_400_000, confidence: 0.9, sourceCount: 2, ...over,
});
const ITEMS = [
  item(),
  item({ id: ITEM_B, kind: "commitment", origin: "extracted", body: "배포는 목요일 오전에 박지훈 님이 진행해요.", recordedAtMs: NOW - 3 * 86_400_000 }),
  item({ id: ITEM_C, kind: "preference", origin: "curated", channelId: ENGINE_ID, body: "코드 리뷰는 한 사람 이상 승인이 있어야 머지해요.", recordedAtMs: NOW - 5 * 86_400_000, editedByMemberId: JIHOON, editedAtMs: NOW - 4 * 86_400_000 }),
  item({ id: ITEM_OLD, kind: "fact", origin: "extracted", body: "재시도 큐 크기는 200개예요.", recordedAtMs: NOW - 9 * 86_400_000, retiredAtMs: NOW - 86_400_000, retiredReason: "edited", supersededById: ITEM_A }),
];
const EVENTS = [
  { id: "ev1", action: "created", detail: {}, createdAtMs: NOW - 86_400_000 },
  { id: "ev2", action: "confirmed", actorMemberId: ME, detail: {}, createdAtMs: NOW - 86_400_000 + 60_000 },
  { id: "ev3", action: "served", detail: {}, createdAtMs: NOW - 3_600_000 },
];

const SETTINGS_ON = {
  workspace: { enabled: true, paused: false, resetEpoch: 0 },
  channels: [], me: { paused: false },
};

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

/** `v` describes one variant: role, proposals, decision outcome, items. */
async function installMocks(context, v) {
  await context.route("**/v1/**", (route) =>
    json(route, { channels: [], members: [], read_states: [], messages: [] }));
  await context.route("**/v1/auth/login", (route) => json(route, SESSION));
  await context.route("**/v1/auth/refresh", (route) =>
    json(route, { accessToken: SESSION.accessToken, refreshToken: SESSION.refreshToken }));
  await context.route("**/v1/auth/realtime-token", (route) =>
    json(route, { token: "capture-only-not-a-credential", tokenType: "jwt", expiresAtMs: Date.now() + 60_000, ttlSeconds: 60, workspaceId: WORKSPACE_ID, memberId: ME }));
  await context.route("**/v1/workspaces/*/channels", (route) => json(route, { channels: CHANNELS }));
  await context.route("**/v1/workspaces/*/roster", (route) => json(route, { members: roster(v.role ?? "member") }));
  await context.route("**/v1/workspaces/*/read-state", (route) =>
    json(route, { read_states: [
      { channel_id: GENERAL_ID, last_read_seq: 1416, latest_seq: 1416, unread_count: 0, mention_count: 0 },
      { channel_id: ENGINE_ID, last_read_seq: 40, latest_seq: 40, unread_count: 0, mention_count: 0 },
    ] }));
  await context.route("**/v1/workspaces/*/channels/*/read-state", (route) =>
    json(route, { channel_id: GENERAL_ID, last_read_seq: 1416, latest_seq: 1416, unread_count: 0, mention_count: 0 }));
  await context.route("**/v1/workspaces/*/channels/*/messages*", (route) => {
    const url = new URL(route.request().url());
    const after = url.searchParams.get("after");
    if (after !== null) {
      const from = Number(after);
      const limit = Number(url.searchParams.get("limit") ?? 50);
      return json(route, { messages: messages().filter((m) => m.seq > from).slice(0, limit) });
    }
    if (url.searchParams.has("before")) return json(route, { messages: [] });
    return json(route, { messages: messages() });
  });
  await context.route("**/v1/workspaces/*/memory/settings", (route) => json(route, v.settings ?? SETTINGS_ON));
  await context.route("**/v1/workspaces/*/channels/*/memory/digests*", (route) =>
    json(route, { digests: [], afterSeq: 1416, summarizedThroughSeq: 1416 }));
  await context.route("**/v1/workspaces/*/agent-runs/*/memory-receipt", (route) =>
    json(route, { error: { message: "no receipt" } }, 404));
  // 「기억해 둘게요」
  await context.route("**/v1/workspaces/*/channels/*/memory/proposals*", (route) =>
    json(route, { proposals: v.proposals ?? [] }));
  await context.route("**/v1/workspaces/*/memory/proposals/*/accept", (route) =>
    v.acceptStatus
      ? json(route, { error: { message: "x" } }, v.acceptStatus)
      : json(route, { proposal: decided("accepted", { itemId: ITEM_A }) }));
  await context.route("**/v1/workspaces/*/memory/proposals/*/reject", (route) =>
    json(route, { proposal: decided("rejected") }));
  // 기억 브라우저
  await context.route(/\/v1\/workspaces\/[^/]+\/memory\/items(\?.*)?$/, (route) => {
    if (v.itemsStatus) return json(route, { error: { message: "boom" } }, v.itemsStatus);
    const url = new URL(route.request().url());
    const status = url.searchParams.get("status") ?? "active";
    let rows = v.items ?? ITEMS;
    if (status === "active") rows = rows.filter((r) => r.retiredAtMs === undefined);
    return json(route, { items: rows });
  });
  await context.route(/\/v1\/workspaces\/[^/]+\/memory\/items\/[^/]+\/events$/, (route) =>
    json(route, { events: EVENTS }));
  await context.route(/\/v1\/workspaces\/[^/]+\/memory\/items\/[^/]+$/, (route) => {
    const id = route.request().url().split("/").pop();
    const found = (v.items ?? ITEMS).find((r) => r.id === id);
    if (route.request().method() === "DELETE") return json(route, { forgottenCount: 1 });
    return found ? json(route, { item: found, evidence: EVIDENCE }) : json(route, { error: { message: "nf" } }, 404);
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

const CHAT = `/c/${GENERAL_ID}`;
const scrollCard = async (page) => {
  await page.getByTestId("memory-proposal").scrollIntoViewIfNeeded();
};

/** Each entry: name, hash to open, variant, and what to do before the shot. */
const SHOTS = [
  { name: "proposal-pending", hash: CHAT, v: { proposals: [proposal()] }, wait: "memory-proposal-evidence-row", drive: scrollCard },
  { name: "proposal-self-warning", hash: CHAT, v: { proposals: [proposal({ callerIsRequester: true })] }, wait: "memory-proposal-self-warning", drive: scrollCard },
  { name: "proposal-guest", hash: CHAT, v: { role: "guest", proposals: [proposal()] }, wait: "memory-proposal-readonly", drive: scrollCard },
  { name: "proposal-accepted", hash: CHAT, v: { proposals: [proposal()] }, wait: "memory-proposal-accept",
    drive: async (page) => {
      await page.getByTestId("memory-proposal-accept").click();
      await page.getByTestId("memory-proposal-accepted").waitFor({ state: "visible" });
      await scrollCard(page);
    } },
  { name: "proposal-rejected", hash: CHAT, v: { proposals: [proposal()] }, wait: "memory-proposal-reject",
    drive: async (page) => {
      await page.getByTestId("memory-proposal-reject").click();
      await page.getByTestId("memory-proposal-rejected").waitFor({ state: "visible" });
      await scrollCard(page);
    } },
  { name: "proposal-conflict", hash: CHAT, v: { proposals: [proposal()], acceptStatus: 409 }, wait: "memory-proposal-accept",
    drive: async (page) => {
      await page.getByTestId("memory-proposal-accept").click();
      await page.getByTestId("memory-proposal-conflict").waitFor({ state: "visible" });
      await scrollCard(page);
    } },
  { name: "proposal-error", hash: CHAT, v: { proposals: [proposal()], acceptStatus: 500 }, wait: "memory-proposal-accept",
    drive: async (page) => {
      await page.getByTestId("memory-proposal-accept").click();
      await page.getByTestId("memory-proposal-error").waitFor({ state: "visible" });
      await scrollCard(page);
    } },
  { name: "browser-list", hash: "/memory", v: {}, wait: "memory-browser-row" },
  { name: "browser-detail", hash: `/memory?item=${ITEM_A}`, v: {}, wait: "memory-detail-events" },
  { name: "browser-detail-curated", hash: `/memory?item=${ITEM_C}`, v: {}, wait: "memory-detail-edited-by" },
  { name: "browser-detail-old", hash: `/memory?item=${ITEM_OLD}`, v: { }, wait: "memory-detail-reason" },
  { name: "browser-edit", hash: `/memory?item=${ITEM_A}`, v: {}, wait: "memory-detail-edit",
    drive: async (page) => {
      await page.getByTestId("memory-detail-edit").click();
      await page.getByTestId("memory-edit-notice").waitFor({ state: "visible" });
    } },
  { name: "browser-forget", hash: `/memory?item=${ITEM_A}`, v: {}, wait: "memory-detail-forget",
    drive: async (page) => {
      await page.getByTestId("memory-detail-forget").click();
      await page.getByTestId("memory-forget-dialog").waitFor({ state: "visible" });
    } },
  { name: "browser-guest", hash: `/memory?item=${ITEM_A}`, v: { role: "guest" }, wait: "memory-detail-reason" },
  { name: "browser-paused", hash: "/memory", v: { settings: { ...SETTINGS_ON, me: { paused: true } } }, wait: "memory-browser-paused" },
  { name: "browser-empty", hash: "/memory", v: { items: [] }, wait: "memory-browser-empty" },
  { name: "browser-error", hash: "/memory", v: { itemsStatus: 500 }, wait: "memory-browser-error" },
  { name: "settings-link", hash: "/settings?section=memory", v: {}, wait: "memory-open-browser" },
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
