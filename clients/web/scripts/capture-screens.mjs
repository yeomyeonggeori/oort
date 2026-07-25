#!/usr/bin/env node
// =============================================================================
// Dawn palette screenshot capture (MOMO-597 / ADR-0133 P1).
//
// Renders the real components against a mocked REST surface and captures every
// screen in BOTH color schemes, so light/dark can be reviewed side by side and
// regressions are visible. prefers-color-scheme is emulated at the browser
// level, which means the capture exercises the same CSS light-dark() path the
// product uses; nothing is themed specially for the screenshot.
//
//   node scripts/capture-screens.mjs          # -> artifacts/design/*.png
//   OUT_DIR=/tmp/shots node scripts/capture-screens.mjs
//
// No credentials and no backend are involved: /v1 is fulfilled from the
// fixtures below (realistic Korean+English team content, never "테스트 1").
// =============================================================================

import { spawn } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR
  ? resolve(process.env.OUT_DIR)
  : resolve(WEB_ROOT, "artifacts/design");
const PORT = Number(process.env.CAPTURE_PORT || 5178);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const VIEWPORT = { width: 1280, height: 800 };

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";
const GENERAL_ID = "00000000-0000-7000-8000-000000000201";
const ME = "019f94e3-7a10-79cd-9dee-208f47edd9a8";
const HERMES = "019f94e3-8b21-7ae0-b3c4-5f1a2d6e7c90";

const SESSION = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: {
    id: ME,
    workspaceId: WORKSPACE_ID,
    kind: "human",
    displayName: "곽성재",
    handle: "seongjae",
  },
  // Deliberately unreachable: the capture shows the disconnected/connecting
  // rail state rather than pretending the realtime rail is up.
  realtimeWebSocketUrl: `ws://127.0.0.1:${PORT + 900}/connection/websocket`,
};

const CHANNELS = [
  { id: GENERAL_ID, workspaceId: WORKSPACE_ID, kind: "public", name: "general", muted: false },
  { id: "00000000-0000-7000-8000-000000000202", workspaceId: WORKSPACE_ID, kind: "public", name: "엔진", muted: false },
  { id: "00000000-0000-7000-8000-000000000203", workspaceId: WORKSPACE_ID, kind: "private", name: "김인턴작업", muted: false },
  { id: "00000000-0000-7000-8000-000000000204", workspaceId: WORKSPACE_ID, kind: "public", name: "release-notes", muted: false },
];

const CHANNEL_IDS = CHANNELS.map((c) => c.id);

// Roster and read-state are what turn the timeline from raw ids into the actual
// design: the agent row is where --agent (predawn slate-blue) is visible at all,
// and the unread/mention badges are the only place --accent lands in the
// sidebar. Without these the capture would review a surface nobody ships.
const ROSTER = [
  {
    id: ME,
    workspaceId: WORKSPACE_ID,
    kind: "human",
    status: "active",
    displayName: "곽성재",
    handle: "seongjae",
    channelCount: CHANNEL_IDS.length,
    channelIds: CHANNEL_IDS,
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  },
  {
    id: HERMES,
    workspaceId: WORKSPACE_ID,
    kind: "agent",
    status: "active",
    displayName: "hermes",
    handle: "hermes",
    channelCount: CHANNEL_IDS.length,
    channelIds: CHANNEL_IDS,
    capabilities: ["code"],
    ownerHumanId: ME,
    agentModel: "hermes-agent",
    createdAtMs: 0,
    updatedAtMs: 0,
  },
];

const READ_STATES = [
  { channel_id: GENERAL_ID, last_read_seq: 1410, latest_seq: 1415, unread_count: 5, mention_count: 1 },
  { channel_id: CHANNELS[1].id, last_read_seq: 40, latest_seq: 42, unread_count: 2, mention_count: 0 },
  { channel_id: CHANNELS[2].id, last_read_seq: 12, latest_seq: 12, unread_count: 0, mention_count: 0 },
  { channel_id: CHANNELS[3].id, last_read_seq: 7, latest_seq: 7, unread_count: 0, mention_count: 0 },
];

// Three of these rows are typed agent events, not prose, so the capture shows
// the R-1 §4 agent cards (approval / tool run / settled turn cost) in both
// schemes. The props are shaped exactly like the server's own
// (AgentGatewayRoutes.approvalRequestProps, WorkerService.toolResultProps,
// AgentGatewayRoutes.timelineProps), opaque fields included, so the capture
// also proves the redaction: `arguments` and `tool_grant` are present in the
// fixture and must not appear anywhere on screen.
const BODIES = [
  [ME, "prometheus mem_limit 붙였어요. 야간 소크 돌려두고 아침에 그래프 확인합시다."],
  [ME, "relay outbox lag 지표가 p99에서 1.2s 근처인데, 배치 크기 조정 전에 원인부터 봅시다."],
  [HERMES, "로그를 읽었습니다. outbox drain 워커 1개가 재시작 루프에 있었고, 지금은 안정입니다."],
  [
    HERMES,
    "빌드 캐시를 정리하려 합니다.",
    "approval_request",
    {
      approval_id: "0199aa11-2222-7000-8000-0000000000a1",
      run_id: "0199aa11-2222-7000-8000-0000000000b2",
      action_type: "shell",
      tool_name: "shell",
      tier: "workspace_write",
      call_id: "call_9f31",
      title: "빌드 캐시 정리",
      summary: "빌드 산출물 디렉터리를 지웁니다. 진행 중인 빌드는 없습니다.",
      arguments: { command: "rm -rf build/", cwd: "/Users/dawn/projects/momo" },
      tool_grant: { grant_id: "g-31", scopes: ["shell:write"] },
      is_reversible: false,
      estimated_micro_usd: 12400,
      status: "pending",
      source: "hermes_gateway",
    },
  ],
  [ME, "좋아요, 승인할게요. 끝나면 seq 기준으로 복구 마커 남는지 확인 부탁해요."],
  [
    HERMES,
    "3개 디렉터리 삭제",
    "tool_result",
    {
      call_id: "call_9f31",
      tool_name: "shell",
      label: "빌드 캐시",
      approval_id: "0199aa11-2222-7000-8000-0000000000a1",
      run_id: "0199aa11-2222-7000-8000-0000000000b2",
      payload_sha256: "sha256:0199aa112222",
      output: { stdout: "removed 3 directories" },
      is_error: false,
      executor: "agentworker.resume_approval.v0",
    },
  ],
  [ME, "@hermes 다음은 clients/web 쪽 토큰 교체 diff 리뷰 부탁합니다."],
  [
    HERMES,
    "확인했습니다. 여명 팔레트 토큰만 사용하고 있고, 인디고 잔재는 없습니다.",
    "text",
    {
      schema: "momo.agent_gateway.timeline.v0",
      source: "hermes_gateway",
      status: "succeeded",
      run_id: "0199aa11-2222-7000-8000-0000000000c3",
      agent_member_id: HERMES,
      usage: {
        model: "claude-opus-4",
        prompt_tokens: 1240,
        completion_tokens: 380,
        cost_micro_usd: 12000,
        was_estimated: false,
      },
    },
  ],
];

function makeMessages(count) {
  const base = Date.now() - count * 60_000;
  return Array.from({ length: count }, (_, i) => {
    const [author, body, type, props] = BODIES[i % BODIES.length];
    return {
      id: `capture-${i + 1}`,
      channelId: GENERAL_ID,
      seq: 1400 + i,
      hlcTs: base + i * 60_000,
      hlcCount: 0,
      authorMemberId: author,
      type: type ?? "text",
      body,
      state: "sent",
      ...(props ? { props } : {}),
      createdAtMs: base + i * 60_000,
    };
  });
}

function json(route, body) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installMocks(context) {
  await context.route("**/v1/auth/login", (route) => json(route, SESSION));
  await context.route("**/v1/auth/realtime-token", (route) =>
    json(route, {
      token: "capture-only-not-a-credential",
      tokenType: "jwt",
      expiresAtMs: Date.now() + 60_000,
      ttlSeconds: 60,
      workspaceId: WORKSPACE_ID,
      memberId: ME,
    })
  );
  await context.route("**/v1/workspaces/*/channels", (route) =>
    json(route, { channels: CHANNELS })
  );
  await context.route("**/v1/workspaces/*/roster", (route) =>
    json(route, { members: ROSTER })
  );
  await context.route("**/v1/workspaces/*/read-state", (route) =>
    json(route, { read_states: READ_STATES })
  );
  await context.route("**/v1/workspaces/*/channels/*/read-state", (route) =>
    json(route, READ_STATES[0])
  );
  await context.route("**/v1/workspaces/*/channels/*/messages*", (route) => {
    const url = new URL(route.request().url());
    // Older-history and backfill pages are empty: the head page is the shot.
    if (url.searchParams.has("before") || url.searchParams.has("after")) {
      return json(route, { messages: [] });
    }
    return json(route, { messages: makeMessages(16) });
  });
}

async function waitForServer(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`preview server never came up: ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function signIn(page) {
  await page.getByTestId("login-email").fill("seongjae@dawn.example");
  await page.getByTestId("login-password").fill("capture-only-not-a-credential");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-list").waitFor({ state: "visible" });
}

async function captureScheme(browser, scheme) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    colorScheme: scheme,
    reducedMotion: "reduce",
  });
  await installMocks(context);
  const shots = [];

  // 1. login surface: Card / Input / Button / runtime badge tokens
  const login = await context.newPage();
  await login.goto(ORIGIN, { waitUntil: "networkidle" });
  await login.getByTestId("login-submit").waitFor({ state: "visible" });
  const loginShot = `${OUT_DIR}/login-${scheme}.png`;
  await login.screenshot({ path: loginShot });
  shots.push(loginShot);

  // 1b. connect surface, invite path (MOMO-604): the browser fallback for a
  //     momo://join link fills server and code, so only email/password remain.
  //     The LAN discovery card has no web equivalent (no mDNS in a page), so it
  //     is reviewed in the desktop shell, not here.
  const invite = await context.newPage();
  const deepLink = `momo://join?server=${encodeURIComponent(
    ORIGIN
  )}&code=momo-alpha-2026`;
  await invite.goto(`${ORIGIN}/?join=${encodeURIComponent(deepLink)}`, {
    waitUntil: "networkidle",
  });
  await invite.getByTestId("login-invite-code").waitFor({ state: "visible" });
  const inviteShot = `${OUT_DIR}/connect-invite-${scheme}.png`;
  await invite.screenshot({ path: inviteShot });
  shots.push(inviteShot);

  // 2. chat shell, live path: sidebar + timeline + composer + rail status
  await signIn(login);
  await login.getByTestId("timeline-message").first().waitFor({ state: "visible" });
  const chatShot = `${OUT_DIR}/chat-${scheme}.png`;
  await login.screenshot({ path: chatShot });
  shots.push(chatShot);

  // 3. focus ring on the composer (focus indication is a hard rule)
  await login.getByTestId("composer-input").focus();
  const focusShot = `${OUT_DIR}/composer-focus-${scheme}.png`;
  await login.screenshot({ path: focusShot });
  shots.push(focusShot);

  // 4. dense timeline via the stress path (no realtime rail, 40 rows)
  const stress = await context.newPage();
  await stress.goto(`${ORIGIN}/?stress=40`, { waitUntil: "networkidle" });
  await signIn(stress);
  await stress.getByTestId("timeline-message").first().waitFor({ state: "visible" });
  const stressShot = `${OUT_DIR}/timeline-dense-${scheme}.png`;
  await stress.screenshot({ path: stressShot });
  shots.push(stressShot);

  await context.close();
  return shots;
}

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) {
    throw new Error("dist/ is missing. Run `npm run build` first.");
  }
  mkdirSync(OUT_DIR, { recursive: true });

  const server = spawn(
    resolve(WEB_ROOT, "node_modules/.bin/vite"),
    ["preview", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"],
    { cwd: WEB_ROOT, stdio: "ignore" }
  );
  const shutdown = () => server.kill("SIGTERM");
  process.on("exit", shutdown);

  try {
    await waitForServer(ORIGIN);
    const browser = await chromium.launch();
    try {
      const all = [];
      for (const scheme of ["light", "dark"]) {
        all.push(...(await captureScheme(browser, scheme)));
      }
      for (const path of all) console.log(path);
    } finally {
      await browser.close();
    }
  } finally {
    shutdown();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
