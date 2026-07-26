#!/usr/bin/env node
// =============================================================================
// 모델·추론 강도 라우팅 표면 캡처 (ADR-0134 / MOMO-626).
//
//   npm run build && node scripts/capture-routing.mjs
//   OUT_DIR=/tmp/shots node scripts/capture-routing.mjs
//
// capture-screens.mjs와 같은 방식(REST를 라우트로 채우고 prefers-color-scheme을
// 브라우저 수준에서 에뮬레이트)이되, 이 티켓이 만든 화면만 찍는다. 픽스처는
// src/features/routing/routingFixtures.json 하나를 그대로 읽는다: 단위 테스트가
// 검증하는 값과 스크린샷이 보여 주는 값이 같아야 리뷰가 코드를 본 것이 된다.
//
// 세 서버 형상을 각각 찍는다. 이 티켓의 절반은 "서버가 아직 못 하는 일을 어떻게
// 말하는가"이므로, 지원하는 서버만 찍으면 리뷰할 수 없다.
//   ready    GET /v1/provider/effort-table 200  (엔진층이 올라간 서버)
//   absent   같은 경로 404                       (momowebqa를 포함한 현재 서버들)
// =============================================================================

import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR
  ? resolve(process.env.OUT_DIR)
  : resolve(WEB_ROOT, "artifacts/routing");
const PORT = Number(process.env.CAPTURE_PORT || 5179);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const VIEWPORT = { width: 1280, height: 800 };

const FIXTURES = JSON.parse(
  readFileSync(resolve(WEB_ROOT, "src/features/routing/routingFixtures.json"), "utf8")
);

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";
const GENERAL_ID = "00000000-0000-7000-8000-000000000201";
const ME = "019f94e3-7a10-79cd-9dee-208f47edd9a8";
const HERMES = "019f94e3-8b21-7ae0-b3c4-5f1a2d6e7c90";
const KIM = "019f9a01-0000-7000-8000-000000000404";
const TIDY = "019f9a01-0000-7000-8000-000000000405";

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
  realtimeWebSocketUrl: `ws://127.0.0.1:${PORT + 900}/connection/websocket`,
};

const CHANNELS = [
  { id: GENERAL_ID, workspaceId: WORKSPACE_ID, kind: "public", name: "general", muted: false },
  {
    id: "00000000-0000-7000-8000-000000000202",
    workspaceId: WORKSPACE_ID,
    kind: "public",
    name: "엔진",
    muted: false,
  },
];

const ROSTER = [
  {
    id: ME,
    workspaceId: WORKSPACE_ID,
    kind: "human",
    status: "active",
    role: "owner",
    displayName: "곽성재",
    handle: "seongjae",
    channelCount: 2,
    channelIds: CHANNELS.map((c) => c.id),
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
    channelCount: 2,
    channelIds: CHANNELS.map((c) => c.id),
    capabilities: ["code"],
    ownerHumanId: ME,
    agentModel: "hermes-agent",
    createdAtMs: 0,
    updatedAtMs: 0,
  },
  {
    id: KIM,
    workspaceId: WORKSPACE_ID,
    kind: "agent",
    status: "active",
    role: "member",
    displayName: "김인턴",
    handle: "kim-intern",
    channelCount: 2,
    channelIds: CHANNELS.map((c) => c.id),
    capabilities: ["code"],
    ownerHumanId: ME,
    agentModel: "hermes-agent",
    createdAtMs: 0,
    updatedAtMs: 0,
  },
  {
    id: TIDY,
    workspaceId: WORKSPACE_ID,
    kind: "agent",
    status: "active",
    role: "member",
    displayName: "정리봇",
    handle: "tidy-bot",
    channelCount: 1,
    channelIds: [GENERAL_ID],
    capabilities: [],
    ownerHumanId: ME,
    agentModel: "hermes-agent",
    createdAtMs: 0,
    updatedAtMs: 0,
  },
];

const READ_STATES = [
  { channel_id: GENERAL_ID, last_read_seq: 1410, latest_seq: 1410, unread_count: 0, mention_count: 0 },
  { channel_id: CHANNELS[1].id, last_read_seq: 40, latest_seq: 40, unread_count: 0, mention_count: 0 },
];

const BODIES = [
  [ME, "@hermes 어제 relay outbox 지연 그래프 한 번 봐 주세요. 배치 크기 조정 전에 원인부터."],
  [HERMES, "로그를 읽었습니다. drain 워커 하나가 재시작 루프에 있었고 지금은 안정입니다."],
  [ME, "이번 건은 가볍게만 봐도 됩니다. 다음 배포 전에 다시 정리하죠."],
];

function makeMessages() {
  const base = Date.now() - BODIES.length * 60_000;
  return BODIES.map(([author, body], i) => ({
    id: `routing-capture-${i + 1}`,
    channelId: GENERAL_ID,
    seq: 1400 + i,
    hlcTs: base + i * 60_000,
    hlcCount: 0,
    authorMemberId: author,
    type: "text",
    body,
    state: "sent",
    createdAtMs: base + i * 60_000,
  }));
}

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

/**
 * `support`는 이 캡처가 흉내 내는 서버 형상이다.
 *   "ready"  effort-table 200 + effortPref를 아는 프로필
 *   "absent" effort-table 404 (현재 살아 있는 서버들)
 */
async function installMocks(context, support) {
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
  await context.route("**/v1/provider/effort-table", (route) =>
    support === "ready"
      ? json(route, FIXTURES.effortTable)
      : json(route, { error: { message: "not found" } }, 404)
  );
  await context.route("**/v1/workspaces/*/agents/*/profile", (route) => {
    const url = route.request().url();
    // hermes는 오버라이드 픽스처(프로필이 hermes-fast/low를 고정), 김인턴은
    // 무효 클리어 픽스처(hermes-agent/max)를 들고 있다. 두 시나리오가 한 화면
    // 에서 동시에 보이도록 에이전트별로 나눠 준다.
    const lowered = url.toLowerCase();
    const profile = lowered.includes(KIM)
      ? FIXTURES.invalidClear.profile
      : lowered.includes(TIDY)
        ? FIXTURES.inherit.profile
        : FIXTURES.override.profile;
    if (support === "absent") {
      // effort_pref를 모르는 서버는 그 키 없이 답한다.
      const { effortPref, ...rest } = profile;
      void effortPref;
      return json(route, { profile: rest });
    }
    return json(route, { profile });
  });
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
    if (url.searchParams.has("before") || url.searchParams.has("after")) {
      return json(route, { messages: [] });
    }
    return json(route, { messages: makeMessages() });
  });
  await context.route("**/v1/workspaces/*/dms", (route) =>
    json(route, { channels: [] })
  );
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

async function shoot(page, path, shots) {
  // focus/hover는 transition-colors(150ms)를 타므로, 그 사이에 찍으면 제품이
  // 실제로 머무르지 않는 색을 리뷰하게 된다.
  await page.waitForTimeout(250);
  await page.screenshot({ path });
  shots.push(path);
}

async function captureScheme(browser, scheme, support) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    colorScheme: scheme,
    reducedMotion: "reduce",
  });
  await installMocks(context, support);
  const shots = [];
  const tag = `${support}-${scheme}`;

  // 1. 디렉터리: 에이전트 행에만 붙는 [라우팅] 진입점.
  const directory = await context.newPage();
  await directory.goto(ORIGIN, { waitUntil: "networkidle" });
  await signIn(directory);
  await directory.evaluate('location.hash = "/directory"');
  await directory.getByTestId("directory-row").first().waitFor({ state: "visible" });
  await shoot(directory, `${OUT_DIR}/directory-routing-${tag}.png`, shots);

  // 2. 프로필 다이얼로그: 아무것도 지정하지 않은 에이전트(정리봇). 두 상자에
  //    "상속 (에이전트 기본: hermes-agent)"과 "상속 (지정 없음, 모델 기본 보통)"이
  //    그대로 적혀 있다 -- D3의 "상속 (실제값 병기)"가 실제로 보이는 프레임.
  await directory.locator(`[data-testid="directory-row-profile"][data-member-id="${TIDY}"]`).click();
  await directory.getByTestId("agent-profile-dialog").waitFor({ state: "visible" });
  await shoot(directory, `${OUT_DIR}/agent-profile-inherit-${tag}.png`, shots);
  await directory.getByTestId("agent-profile-cancel").click();

  // 2b. 저장된 오버라이드가 있는 에이전트(hermes: hermes-fast / 낮음).
  await directory.locator(`[data-testid="directory-row-profile"][data-member-id="${HERMES}"]`).click();
  await directory.getByTestId("agent-profile-dialog").waitFor({ state: "visible" });
  await shoot(directory, `${OUT_DIR}/agent-profile-saved-${tag}.png`, shots);
  await directory.getByTestId("agent-profile-cancel").click();

  // 3. 프로필 다이얼로그: 모델을 바꿔 강도가 무효해지는 순간. ready 서버에서만
  //    의미가 있다(absent에서는 상자가 잠겨 있고 그 사유가 이미 2번 프레임에
  //    찍혀 있다).
  if (support === "ready") {
    // 김인턴이 hermes-agent/max를 들고 있으므로, hermes-fast로 내리면 max가
    // 유효값에서 빠진다.
    await directory
      .locator(`[data-testid="directory-row-profile"][data-member-id="${KIM}"]`)
      .click();
    await directory.getByTestId("agent-profile-dialog").waitFor({ state: "visible" });
    await directory.getByTestId("agent-profile-model").selectOption("hermes-fast");
    await directory.getByTestId("agent-profile-cleared").waitFor({ state: "visible" });
    await shoot(directory, `${OUT_DIR}/agent-profile-cleared-${tag}.png`, shots);
  }

  // 4. 컴포저 멘션 줄: 상속 상태. 바꾸지 않으면 무엇이 되는지가 먼저 보인다.
  const chat = await context.newPage();
  await chat.goto(ORIGIN, { waitUntil: "networkidle" });
  await signIn(chat);
  await chat.getByTestId("composer-input").waitFor({ state: "visible" });
  await chat.getByTestId("composer-input").fill("@hermes 빌드 로그 요약만 부탁합니다");
  await chat.getByTestId("composer-routing").waitFor({ state: "visible" });
  await shoot(chat, `${OUT_DIR}/composer-routing-inherit-${tag}.png`, shots);

  // 5. 펼친 상태: 두 상자와 (absent라면) 잠긴 이유.
  await chat.getByTestId("composer-routing-toggle").click();
  await chat.getByTestId("composer-routing-model").waitFor({ state: "visible" });
  await shoot(chat, `${OUT_DIR}/composer-routing-open-${tag}.png`, shots);

  // 6. 오버라이드 활성: 줄 전체가 accent-soft로 바뀌고 "이번 한 번만"이 붙는다.
  if (support === "ready") {
    await chat.getByTestId("composer-routing-model").selectOption("hermes-agent");
    await chat.getByTestId("composer-routing-effort").selectOption("xhigh");
    await chat
      .locator('[data-testid="composer-routing"][data-override]')
      .waitFor({ state: "visible" });
    await shoot(chat, `${OUT_DIR}/composer-routing-override-${tag}.png`, shots);
  }

  // 7. 에이전트를 여러 명 부르면 붙일 수 없다고 말한다.
  await chat
    .getByTestId("composer-input")
    .fill("@hermes @kim-intern 두 분 같이 확인 부탁합니다");
  await chat.getByTestId("composer-routing-many").waitFor({ state: "visible" });
  await shoot(chat, `${OUT_DIR}/composer-routing-many-${tag}.png`, shots);

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
      for (const support of ["ready", "absent"]) {
        for (const scheme of ["light", "dark"]) {
          all.push(...(await captureScheme(browser, scheme, support)));
        }
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
