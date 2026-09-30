#!/usr/bin/env node
// =============================================================================
// 결정 타임라인 + 정리 되돌리기 + 서빙 인스펙터 화면 캡처 (ADR-0196 D12 V5·V6, #3174).
//
// Renders the real app against a mocked /v1: the decision timeline (current, closed with a
// validity interval and its replacement, merged, decayed), the consolidation history with the
// 되돌리기 confirm and its 403/404/409 outcomes, guest read-only, and the serving inspector
// (「이 답에 쓰인 기억」) with and without a withheld count. Light and dark, at 1280 and 390.
//
//   npm run build && node scripts/capture-memory-timeline.mjs      # -> captures/3174/
//   OUT_DIR=/tmp/shots ONLY=timeline node scripts/capture-memory-timeline.mjs
//
// Every item, event and receipt here is a fixture. The shots prove how the client draws
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
  : resolve(WEB_ROOT, "captures/3174");
const PORT = Number(process.env.CAPTURE_PORT || 5185);
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

const D = 86_400_000;
const T0 = Date.parse("2026-09-03T10:00:00+09:00");
const D_OLD = "0199aa11-4444-7000-8000-000000000710";
const D_NEW = "0199aa11-4444-7000-8000-000000000711";
const D_MERGED = "0199aa11-4444-7000-8000-000000000712";
const D_DECAYED = "0199aa11-4444-7000-8000-000000000713";
const D_ENGINE = "0199aa11-4444-7000-8000-000000000714";
const EV_CLOSE = "0199aa11-5555-7000-8000-000000000910";
const EV_MERGE = "0199aa11-5555-7000-8000-000000000911";
const EV_DECAY = "0199aa11-5555-7000-8000-000000000912";
const EVIDENCE = [
  { messageId: "cap-1413", channelId: GENERAL_ID, seq: 1413 },
  { messageId: "cap-1414", channelId: GENERAL_ID, seq: 1414 },
];
const dec = (over) => ({
  channelId: GENERAL_ID, spaceKind: "channel", kind: "decision", origin: "extracted",
  validFromMs: T0, recordedAtMs: T0, confidence: 0.9, sourceCount: 2, ...over,
});
const ITEMS = [
  dec({ id: D_NEW, origin: "confirmed", subjectKey: "결제 재시도 큐", body: "재시도 큐는 세 배로 늘려서 운영해요.", validFromMs: T0 + 6 * D, recordedAtMs: T0 + 6 * D }),
  dec({ id: D_OLD, subjectKey: "결제 재시도 큐", body: "재시도 큐는 두 배로 늘려서 운영해요.", validFromMs: T0, validToMs: T0 + 6 * D }),
  dec({ id: D_MERGED, subjectKey: "배포 요일", body: "배포는 목요일 오전에 해요.", validFromMs: T0 + D, retiredAtMs: T0 + 2 * D, retiredReason: "merged" }),
  dec({ id: D_DECAYED, body: "임시 워커 메모리 한도는 512MB예요.", validFromMs: T0 + 2 * D, retiredAtMs: T0 + 9 * D, retiredReason: "decayed" }),
  dec({ id: D_ENGINE, channelId: ENGINE_ID, subjectKey: "코드 리뷰", origin: "curated", body: "코드 리뷰는 한 사람 이상 승인이 있어야 머지해요.", validFromMs: T0 + 3 * D }),
];
const EVENTS_BY_ITEM = {
  [D_OLD]: [
    { id: "ev-c", action: "created", detail: {}, createdAtMs: T0 },
    { id: EV_CLOSE, action: "superseded", detail: { reason: "contradiction", superseded_by: D_NEW }, createdAtMs: T0 + 6 * D + 4 * 3_600_000 },
  ],
  [D_NEW]: [{ id: "ev-n", action: "confirmed", actorMemberId: ME, detail: {}, createdAtMs: T0 + 6 * D }],
  [D_MERGED]: [
    { id: "ev-m0", action: "created", detail: {}, createdAtMs: T0 + D },
    { id: EV_MERGE, action: "merged", detail: { into: D_NEW }, createdAtMs: T0 + 2 * D },
  ],
  [D_DECAYED]: [
    { id: "ev-d0", action: "created", detail: {}, createdAtMs: T0 + 2 * D },
    { id: EV_DECAY, action: "retired", detail: { reason: "decayed" }, createdAtMs: T0 + 9 * D },
  ],
  [D_ENGINE]: [],
};
const REVERTED_EVENTS = {
  [D_OLD]: [
    ...EVENTS_BY_ITEM[D_OLD],
    { id: "ev-rev", action: "reverted", actorMemberId: ME, detail: { of: EV_CLOSE, what: "superseded" }, createdAtMs: T0 + 8 * D },
  ],
};

const RECEIPT = (withheld) => ({
  receipt: {
    runId: RUN, channelId: GENERAL_ID, servedCount: 4, budgetChars: 6000, usedChars: 2140, createdAtMs: NOW - 60_000,
    digestIds: ["dg1"], itemIds: [D_NEW, D_OLD],
    digests: [{
      id: "dg1", channelId: GENERAL_ID, level: "window", fromSeq: 1400, toSeq: 1412,
      body: "결제 콜백 타임아웃은 워커 OOM이 원인이었어요.\n한도를 올리고 재시도 큐를 늘리기로 했어요.",
      sourceCount: 12, model: "claude-haiku-5", createdAtMs: NOW - 86_400_000,
      evidence: [{ messageId: "cap-1410", channelId: GENERAL_ID, seq: 1410 }, { messageId: "cap-1412", channelId: GENERAL_ID, seq: 1412 }],
    }],
    items: [
      { id: D_NEW, channelId: GENERAL_ID, kind: "decision", origin: "confirmed", body: "재시도 큐는 세 배로 늘려서 운영해요.", validFromMs: T0 + 6 * D, sourceCount: 2 },
      { id: D_OLD, channelId: GENERAL_ID, kind: "decision", origin: "extracted", body: "재시도 큐는 두 배로 늘려서 운영해요.", validFromMs: T0, sourceCount: 2 },
    ],
    ...(withheld !== undefined ? { withheldCount: withheld } : {}),
  },
});

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
    v.receipt !== undefined
      ? json(route, RECEIPT(v.receipt.withheld))
      : json(route, { error: { message: "no receipt" } }, 404));
  // 결정 타임라인·정리 이력
  await context.route(/\/v1\/workspaces\/[^/]+\/memory\/items(\?.*)?$/, (route) => {
    if (v.itemsStatus) return json(route, { error: { message: "boom" } }, v.itemsStatus);
    const url = new URL(route.request().url());
    const status = url.searchParams.get("status") ?? "active";
    const channel = url.searchParams.get("channelId");
    let rows = v.items ?? ITEMS;
    if (status === "active") rows = rows.filter((r) => r.retiredAtMs === undefined);
    if (channel) rows = rows.filter((r) => r.channelId === channel);
    return json(route, { items: rows });
  });
  await context.route(/\/v1\/workspaces\/[^/]+\/memory\/items\/[^/]+\/events\/[^/]+\/revert$/, (route) =>
    v.revertStatus
      ? json(route, { error: { message: "x" } }, v.revertStatus)
      : json(route, { reverted: "superseded", itemId: D_OLD }));
  await context.route(/\/v1\/workspaces\/[^/]+\/memory\/items\/[^/]+\/events$/, (route) => {
    const id = route.request().url().split("/").slice(-2)[0];
    const source = v.events ?? EVENTS_BY_ITEM;
    return json(route, { events: source[id] ?? [] });
  });
  await context.route(/\/v1\/workspaces\/[^/]+\/memory\/items\/[^/]+$/, (route) => {
    const id = route.request().url().split("/").pop();
    const found = (v.items ?? ITEMS).find((r) => r.id === id);
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
const TL = "/memory?view=timeline";
const openRevert = async (page) => {
  await page.getByTestId("memory-event-revert").first().click();
  await page.getByTestId("memory-revert-dialog").waitFor({ state: "visible" });
};
const confirmRevert = async (page, marker) => {
  await openRevert(page);
  await page.getByTestId("memory-revert-confirm").click();
  await page.getByTestId(marker).waitFor({ state: "visible" });
};
const openInspector = async (page) => {
  await page.getByTestId("memory-receipt-chip").click();
  await page.getByTestId("memory-receipt-inspect").click();
  await page.getByTestId("memory-inspector").waitFor({ state: "visible" });
};

const SHOTS = [
  { name: "timeline", hash: TL, v: {}, wait: "memory-timeline-replaced" },
  { name: "timeline-selected", hash: `${TL}&item=${D_OLD}`, v: {}, wait: "memory-history-cleanup-note" },
  { name: "timeline-channel", hash: `${TL}&channel=${GENERAL_ID}`, v: {}, wait: "memory-timeline-replaced" },
  { name: "timeline-empty", hash: TL, v: { items: [] }, wait: "memory-timeline-empty" },
  { name: "timeline-error", hash: TL, v: { itemsStatus: 500 }, wait: "memory-timeline-error" },
  { name: "history-closed", hash: `/memory?item=${D_OLD}`, v: {}, wait: "memory-event-revert" },
  { name: "history-merged", hash: `/memory?item=${D_MERGED}`, v: {}, wait: "memory-event-revert" },
  { name: "history-decayed", hash: `/memory?item=${D_DECAYED}`, v: {}, wait: "memory-event-revert" },
  { name: "history-reverted", hash: `/memory?item=${D_OLD}`, v: { events: REVERTED_EVENTS }, wait: "memory-event-reverted" },
  { name: "history-guest", hash: `/memory?item=${D_OLD}`, v: { role: "guest" }, wait: "memory-history-guest" },
  { name: "revert-confirm", hash: `/memory?item=${D_OLD}`, v: {}, wait: "memory-event-revert", drive: openRevert },
  { name: "revert-done", hash: `/memory?item=${D_OLD}`, v: {}, wait: "memory-event-revert", drive: (p) => confirmRevert(p, "memory-browser-notice") },
  { name: "revert-conflict", hash: `/memory?item=${D_OLD}`, v: { revertStatus: 409 }, wait: "memory-event-revert", drive: (p) => confirmRevert(p, "memory-history-error") },
  { name: "revert-forbidden", hash: `/memory?item=${D_OLD}`, v: { revertStatus: 403 }, wait: "memory-event-revert", drive: (p) => confirmRevert(p, "memory-history-error") },
  { name: "revert-gone", hash: `/memory?item=${D_OLD}`, v: { revertStatus: 404 }, wait: "memory-event-revert", drive: (p) => confirmRevert(p, "memory-browser-notice") },
  { name: "inspector", hash: CHAT, v: { receipt: {} }, wait: "memory-receipt-chip", drive: openInspector },
  { name: "inspector-withheld", hash: CHAT, v: { receipt: { withheld: 2 } }, wait: "memory-receipt-chip",
    drive: async (page) => {
      await openInspector(page);
      await page.getByTestId("memory-inspector-withheld").scrollIntoViewIfNeeded();
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
