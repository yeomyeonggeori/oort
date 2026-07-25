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
//   npm run capture:design                    # -> artifacts/design/*.png
//   OUT_DIR=/tmp/shots npm run capture:design
//
// Go through the npm script, not this file directly: it builds `--mode design`,
// and that mode is what enables the `?agentwork=` capture seam. A release build
// (`npm run build`) answers null to that flag on purpose, so the two agent turn
// screens would shoot an empty sidebar against a production dist.
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

// The DM the directory opens onto (MOMO-611). It is in the fixture so the
// sidebar renders its 다이렉트 메시지 section, including the 새 다이렉트 메시지
// entry point, in every frame below.
const DM_ID = "019f984d-b4a8-76fd-8fba-3b6e3390072d";
const DM_CHANNEL = {
  id: DM_ID,
  workspaceId: WORKSPACE_ID,
  kind: "dm",
  memberIds: [ME, HERMES],
  muted: false,
};

/** The id POST /channels answers with (MOMO-614): the app routes to it. */
const CREATED_CHANNEL_ID = "019f9b10-0000-7000-8000-000000000301";

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
    role: "owner",
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
    role: "member",
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
  // The directory (MOMO-611) is the first surface that renders the whole
  // roster, so the fixture carries a workspace rather than a pair: role
  // labels, the human/agent split, and a second agent attributed to a human.
  {
    id: "019f9a01-0000-7000-8000-000000000401",
    workspaceId: WORKSPACE_ID,
    kind: "human",
    status: "active",
    role: "admin",
    displayName: "박지훈",
    handle: "jihoon",
    channelCount: 2,
    channelIds: CHANNEL_IDS.slice(0, 2),
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  },
  {
    id: "019f9a01-0000-7000-8000-000000000402",
    workspaceId: WORKSPACE_ID,
    kind: "human",
    status: "active",
    role: "member",
    displayName: "김인턴",
    handle: "intern-kim",
    channelCount: 1,
    channelIds: [GENERAL_ID],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  },
  {
    id: "019f9a01-0000-7000-8000-000000000403",
    workspaceId: WORKSPACE_ID,
    kind: "human",
    status: "invited",
    role: "member",
    displayName: "Nadia Rahman",
    handle: "nadia",
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  },
  {
    id: "019f9a01-0000-7000-8000-000000000404",
    workspaceId: WORKSPACE_ID,
    kind: "agent",
    status: "active",
    role: "member",
    displayName: "김인턴",
    handle: "kim-intern",
    channelCount: 2,
    channelIds: CHANNEL_IDS.slice(0, 2),
    capabilities: ["code"],
    ownerHumanId: "019f9a01-0000-7000-8000-000000000401",
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
  { channel_id: DM_ID, last_read_seq: 3, latest_seq: 3, unread_count: 0, mention_count: 0 },
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

/** The DM the directory opens onto: a short 1:1 with the agent, not a channel. */
function makeDmMessages() {
  const base = Date.now() - 3 * 60_000;
  return [
    [ME, "어제 올린 relay 패치, DM으로 짧게만 확인할게요. 롤백 절차는 그대로죠?"],
    [HERMES, "그대로입니다. outbox 재처리 스크립트만 먼저 돌리면 됩니다."],
    [ME, "좋아요. 배포 끝나면 여기로 결과만 남겨주세요."],
  ].map(([author, body], i) => ({
    id: `capture-dm-${i + 1}`,
    channelId: DM_ID,
    seq: i + 1,
    hlcTs: base + i * 60_000,
    hlcCount: 0,
    authorMemberId: author,
    type: "text",
    body,
    state: "sent",
    createdAtMs: base + i * 60_000,
  }));
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
  // 채널 만들기 (MOMO-614). The POST answers the way the server does: 409 when
  // an unarchived channel already carries the name, which is the frame that
  // matters because the rejection has to land under the name field, and 201
  // with the created row otherwise.
  await context.route("**/v1/workspaces/*/channels", (route) => {
    if (route.request().method() !== "POST") {
      return json(route, { channels: [...CHANNELS, DM_CHANNEL] });
    }
    const body = JSON.parse(route.request().postData() ?? "{}");
    if (CHANNELS.some((c) => c.name === body.name)) {
      return route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: { message: "channel name already exists" },
        }),
      });
    }
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        channel: {
          id: CREATED_CHANNEL_ID,
          workspaceId: WORKSPACE_ID,
          kind: body.kind,
          name: body.name,
          topic: body.topic,
          muted: false,
        },
        creatorMembership: {
          id: "019f9b10-0000-7000-8000-0000000003ff",
          workspaceId: WORKSPACE_ID,
          channelId: CREATED_CHANNEL_ID,
          memberId: ME,
          role: "owner",
          joinedAtMs: Date.now(),
        },
      }),
    });
  });
  // 디렉터리 행에서 DM 시작 (MOMO-611): idempotent per pair, so the fixture
  // answers created:false, which is the "이미 있는 대화로 이동" path.
  await context.route("**/v1/workspaces/*/dms", (route) =>
    route.request().method() === "POST"
      ? json(route, { channel: DM_CHANNEL, created: false })
      : json(route, { channels: [DM_CHANNEL] })
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
    if (url.pathname.includes(DM_ID)) {
      return json(route, { messages: makeDmMessages() });
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

  // 3a. 채널 만들기 다이얼로그 (MOMO-614): the form the sidebar + opens, filled
  //     the way a person fills it. This is the surface that replaced the
  //     /settings dead end, so it is reviewed in both schemes.
  await login.getByTestId("new-channel").click();
  await login.getByTestId("create-channel-dialog").waitFor({ state: "visible" });
  await login.getByTestId("create-channel-name").fill("release-rollback");
  await login
    .getByTestId("create-channel-topic")
    .fill("배포와 롤백 절차, 당번 인계를 한곳에서");
  // The focus ring rides `transition-colors` (150ms), so a frame shot the
  // instant after focus catches the ring mid-interpolation and reviews a color
  // the product never rests on. Let it settle first.
  await login.waitForTimeout(300);
  const createShot = `${OUT_DIR}/channel-create-${scheme}.png`;
  await login.screenshot({ path: createShot });
  shots.push(createShot);

  // 3a-2. 서버 거절은 필드 옆에 (MOMO-614): 이미 있는 이름을 보내면 409가 이름
  //       상자 밑에 붙고, 입력한 값은 그대로 남는다. 토스트 아님.
  await login.getByTestId("create-channel-name").fill("general");
  await login.getByTestId("create-channel-submit").click();
  await login
    .getByTestId("create-channel-name-error")
    .waitFor({ state: "visible" });
  await login.waitForTimeout(300);
  const createErrorShot = `${OUT_DIR}/channel-create-error-${scheme}.png`;
  await login.screenshot({ path: createErrorShot });
  shots.push(createErrorShot);
  await login.getByTestId("create-channel-cancel").click();
  await login.getByTestId("create-channel-dialog").waitFor({ state: "detached" });

  // 3a-3. 빈 워크스페이스 (MOMO-614): 채널이 0개일 때 남는 유일한 행동. 이 화면의
  //       [채널 만들기]가 /settings로 보내던 막다른 골목이었고, 이제 위의
  //       다이얼로그를 연다. 이 페이지에서만 채널 목록을 비운다.
  const emptyWorkspace = await context.newPage();
  await emptyWorkspace.route("**/v1/workspaces/*/channels", (route) =>
    route.request().method() === "POST"
      ? route.fallback()
      : json(route, { channels: [] })
  );
  await emptyWorkspace.goto(ORIGIN, { waitUntil: "networkidle" });
  await signIn(emptyWorkspace);
  await emptyWorkspace.getByTestId("chat-no-channel").waitFor({ state: "visible" });
  const emptyShot = `${OUT_DIR}/workspace-empty-${scheme}.png`;
  await emptyWorkspace.screenshot({ path: emptyShot });
  shots.push(emptyShot);

  // 3b. 멤버 디렉터리 (MOMO-611): the roster as a list, the role labels, the
  //     human/agent split, and the row that starts a DM.
  const directory = await context.newPage();
  await directory.goto(ORIGIN, { waitUntil: "networkidle" });
  await signIn(directory);
  await directory.evaluate('location.hash = "/directory"');
  await directory.getByTestId("directory-row").first().waitFor({ state: "visible" });
  const directoryShot = `${OUT_DIR}/directory-${scheme}.png`;
  await directory.screenshot({ path: directoryShot });
  shots.push(directoryShot);

  // 3c. ⌘K with the 사람 section: channels, DMs and people in one palette. The
  //     query is typed, which is how the palette is actually used, and "김"
  //     lands on the pair a directory has to keep apart (a human and an agent
  //     whose display names are both 김인턴).
  await directory.getByTestId("open-quick-switcher").click();
  await directory.getByTestId("quick-switcher-input").fill("김");
  await directory.getByTestId("switcher-person").first().waitFor({ state: "visible" });
  const switcherShot = `${OUT_DIR}/quick-switcher-people-${scheme}.png`;
  await directory.screenshot({ path: switcherShot });
  shots.push(switcherShot);
  await directory.keyboard.press("Escape");

  // 3d. the DM that a directory row opens: same timeline anatomy as a channel.
  await directory
    .locator('[data-testid="directory-row"][data-member-kind="agent"]')
    .first()
    .click();
  await directory.getByTestId("composer-input").waitFor({ state: "visible" });
  await directory.getByTestId("timeline-message").first().waitFor({ state: "visible" });
  const dmShot = `${OUT_DIR}/dm-${scheme}.png`;
  await directory.screenshot({ path: dmShot });
  shots.push(dmShot);

  // 3e. agent turn surfaces (MOMO-613): the sidebar pill and the composer
  //     activity list. `?agentwork=live` seeds fixed turns and reports the rail
  //     as connected, so the clock, the 승인 대기 state and the stacked composer
  //     lines are all on screen at once without a socket.
  const turns = await context.newPage();
  await turns.goto(`${ORIGIN}/?agentwork=live`, { waitUntil: "networkidle" });
  await signIn(turns);
  await turns.getByTestId("timeline-message").first().waitFor({ state: "visible" });
  await turns.getByTestId("agent-turn-badge").first().waitFor({ state: "visible" });
  await turns.getByTestId("composer-working").waitFor({ state: "visible" });
  const turnsShot = `${OUT_DIR}/agent-turns-${scheme}.png`;
  await turns.screenshot({ path: turnsShot });
  shots.push(turnsShot);

  // 3f. the same turns with the rail down (SKILL §5 offline): the clocks go
  //     away rather than counting on a dead socket, and the banner says why.
  const turnsOffline = await context.newPage();
  await turnsOffline.goto(`${ORIGIN}/?agentwork=offline`, {
    waitUntil: "networkidle",
  });
  await signIn(turnsOffline);
  await turnsOffline
    .getByTestId("timeline-message")
    .first()
    .waitFor({ state: "visible" });
  await turnsOffline
    .getByTestId("agent-turn-badge")
    .first()
    .waitFor({ state: "visible" });
  const turnsOfflineShot = `${OUT_DIR}/agent-turns-offline-${scheme}.png`;
  await turnsOffline.screenshot({ path: turnsOfflineShot });
  shots.push(turnsOfflineShot);

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
    throw new Error("dist/ is missing. Run `npm run capture:design`.");
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
