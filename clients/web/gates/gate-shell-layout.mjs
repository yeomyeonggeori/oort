#!/usr/bin/env node
// =============================================================================
// GATE — app shell stays the window (MOMO-610 / parity G-2).
//
// The regression this exists to catch: 설정 > 멤버와 초대 rendered taller than
// the window, the *document* scrolled instead of the settings pane, and the
// sidebar left the screen (the parity run measured 워크스페이스 탐색 at y=-267,
// leaving an empty column and a stranded identity row). A desktop messenger
// window does not scroll; its panes do.
//
// So the gate asserts the boundary rather than a screenshot:
//   - the document never scrolls on any signed-in route, at any window size,
//   - the sidebar nav stays at its resting y,
//   - .app-shell itself is not a scroll container that focus could shift,
//   - a long settings section still reaches its last control (the shell clips,
//     so the body pane has to scroll — clipping without scrolling would trade
//     one bug for a worse one),
//   - the composer stays inside the window, and the 1k-row timeline still
//     virtualizes, because both depend on the shell handing down a definite
//     height.
//
//   npm run build && npm run gate:shell
//
// No backend and no credentials: /v1 is fulfilled from the fixtures below, the
// same way scripts/capture-screens.mjs does it. The connect screen is checked
// too, in the opposite direction — it is signed out, has no shell, and is the
// one surface that may scroll the document, so a short window must still reach
// the sign-in button.
// =============================================================================

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// 설정 > 사용량 (MOMO-616) is the tallest settings panel, so it is measured from
// the same contract fixture usageModel.test.ts asserts rather than from an
// invented payload.
const USAGE_FIXTURE = JSON.parse(
  readFileSync(resolve(WEB_ROOT, "src/features/settings/usageFixtures.json"), "utf8")
).normal;
const PORT = Number(process.env.SHELL_GATE_PORT || 5179);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const OUT_DIR = process.env.OUT_DIR
  ? resolve(process.env.OUT_DIR)
  : resolve(WEB_ROOT, "artifacts/shell-layout");
// Layout is scheme-independent, so the gate runs one scheme by default and
// keeps the run short. SHELL_GATE_SCHEME=light shoots the same frames in the
// paper scheme when a review wants both.
const SCHEME = process.env.SHELL_GATE_SCHEME === "light" ? "light" : "dark";

// Windows worth measuring: the review default, the 900px case named in the
// ticket, and a window short and narrow enough that every section overflows.
const SIZES = [
  { name: "1280x800", width: 1280, height: 800 },
  { name: "900x600", width: 900, height: 600 },
  { name: "760x480", width: 760, height: 480 },
];

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";
const GENERAL_ID = "00000000-0000-7000-8000-000000000201";
const ME = "019f94e3-7a10-79cd-9dee-208f47edd9a8";
const HERMES = "019f94e3-8b21-7ae0-b3c4-5f1a2d6e7c90";

const SESSION = {
  accessToken: "gate-only-not-a-credential",
  refreshToken: "gate-only-not-a-credential",
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
  { id: "00000000-0000-7000-8000-000000000202", workspaceId: WORKSPACE_ID, kind: "public", name: "엔진", muted: false },
  { id: "00000000-0000-7000-8000-000000000203", workspaceId: WORKSPACE_ID, kind: "private", name: "김인턴작업", muted: false },
  { id: "00000000-0000-7000-8000-000000000204", workspaceId: WORKSPACE_ID, kind: "public", name: "release-notes", muted: false },
];
const CHANNEL_IDS = CHANNELS.map((c) => c.id);

// A roster long enough to overflow a short window: 멤버 디렉터리 (MOMO-611) is
// the second surface after 설정 > 멤버와 초대 whose length is the workspace's,
// not the designer's, so the gate measures it on a workspace that has been
// hiring rather than on two rows that fit anywhere.
const TEAM = [
  ["박지훈", "jihoon", "admin"],
  ["이서연", "seoyeon", "member"],
  ["최민우", "minwoo", "member"],
  ["정하늘", "haneul", "member"],
  ["윤도현", "dohyun", "guest"],
  ["장서준", "seojun", "member"],
  ["임채원", "chaewon", "member"],
  ["오세훈", "sehun", "member"],
  ["강다인", "dain", "member"],
  ["신유진", "yujin", "member"],
  ["Nadia Rahman", "nadia", "member"],
  ["Tom Okafor", "tom", "member"],
];

const ROSTER = [
  { id: ME, workspaceId: WORKSPACE_ID, kind: "human", status: "active", role: "owner", displayName: "곽성재", handle: "seongjae", channelCount: CHANNEL_IDS.length, channelIds: CHANNEL_IDS, capabilities: [], createdAtMs: 0, updatedAtMs: 0 },
  { id: HERMES, workspaceId: WORKSPACE_ID, kind: "agent", status: "active", role: "member", displayName: "hermes", handle: "hermes", channelCount: CHANNEL_IDS.length, channelIds: CHANNEL_IDS, capabilities: ["code"], ownerHumanId: ME, agentModel: "hermes-agent", createdAtMs: 0, updatedAtMs: 0 },
  ...TEAM.map(([displayName, handle, role], i) => ({
    id: `019f9a01-0000-7000-8000-0000000004${String(i).padStart(2, "0")}`,
    workspaceId: WORKSPACE_ID,
    kind: "human",
    status: "active",
    role,
    displayName,
    handle,
    channelCount: 1,
    channelIds: [GENERAL_ID],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  })),
];

const READ_STATES = CHANNELS.map((c, i) => ({
  channel_id: c.id,
  last_read_seq: 10,
  latest_seq: i === 0 ? 15 : 10,
  unread_count: i === 0 ? 5 : 0,
  mention_count: i === 0 ? 1 : 0,
}));

// A realistic long Korean operator note: the sections have to wrap it, not
// widen the shell, and it is what makes 운영 sections overflow a short window.
const LONG_KO =
  "워크스페이스 운영자만 바꿀 수 있는 설정입니다. 이 값을 바꾸면 이미 발급된 초대 링크와 진행 중인 에이전트 턴에 즉시 영향이 갑니다.";

// Twelve issued codes: 멤버와 초대 is the section the parity run broke on, and
// a workspace that has actually been inviting people is what makes it long.
const INVITES = Array.from({ length: 12 }, (_, i) => ({
  id: `gate-invite-${i}`,
  workspaceId: WORKSPACE_ID,
  codePreview: `zz${String(i).padStart(4, "0")}`,
  role: i % 2 ? "admin" : "member",
  maxUses: 5,
  usedCount: i % 5,
  expiresAtMs: Date.now() + (i + 1) * 86_400_000,
  createdBy: ME,
  createdAtMs: Date.now(),
  updatedAtMs: Date.now(),
}));

const BODIES = [
  [ME, "relay outbox lag p99가 1.2s 근처예요. batch size 만지기 전에 원인부터 봅시다."],
  [HERMES, "outbox_drain 워커 로그를 읽었습니다. 재시작 루프 1건, 마지막 30분은 안정입니다."],
  [ME, LONG_KO],
  [HERMES, "확인했습니다. 여명 팔레트 토큰만 쓰고 있고 인디고 잔재는 없습니다."],
];

function json(route, body) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function makeMessages(count) {
  const base = Date.now() - count * 60_000;
  return Array.from({ length: count }, (_, i) => {
    const [author, body] = BODIES[i % BODIES.length];
    return {
      id: `gate-${i + 1}`,
      channelId: GENERAL_ID,
      seq: 1400 + i,
      hlcTs: base + i * 60_000,
      hlcCount: 0,
      authorMemberId: author,
      type: "text",
      body,
      state: "sent",
      createdAtMs: base + i * 60_000,
    };
  });
}

async function installMocks(context) {
  // Playwright checks handlers in reverse registration order, so this superset
  // catch-all is registered FIRST and therefore matches LAST. Without it an
  // endpoint nobody thought to mock answers 401 and the shell signs itself out
  // in the middle of the run, which reads as a layout pass on a login screen.
  await context.route("**/v1/**", (route) =>
    json(route, {
      channels: [], members: [], read_states: [], messages: [],
      invites: [], approvals: [], runs: [],
    })
  );
  await context.route("**/v1/auth/login", (route) => json(route, SESSION));
  await context.route("**/v1/auth/realtime-token", (route) =>
    json(route, {
      token: "gate-only-not-a-credential",
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
    if (url.searchParams.has("before") || url.searchParams.has("after")) {
      return json(route, { messages: [] });
    }
    return json(route, { messages: makeMessages(24) });
  });
  await context.route("**/v1/workspaces/*/invites*", (route) =>
    json(route, { invites: INVITES })
  );
  await context.route("**/v1/workspaces/*/usage/summary*", (route) =>
    json(route, USAGE_FIXTURE)
  );
  await context.route("**/v1/provider/link", (route) =>
    json(route, {
      schema: "momo.provider_link.v0",
      configured: true,
      source: "database",
      mode: "anthropic",
      baseUrl: "https://api.anthropic.com",
      endpointLabel: "Anthropic Messages",
      bearerConfigured: true,
      bearerLast4: "9f31",
      availability: "ok",
      keyConfigured: true,
      updatedAtMs: Date.now(),
      updatedBy: "곽성재",
      diagnostics: [LONG_KO, LONG_KO],
    })
  );
  await context.route("**/v1/provider/work-host-engine", (route) =>
    json(route, {
      engine: "docker",
      source: "database",
      updatedBy: "곽성재",
      updatedAtMs: Date.now(),
      schema: "momo.work_host_engine.v0",
    })
  );
  // Least specific of the workspace routes; `*` never crosses a `/`, so the
  // ones above still win for their own sub-paths.
  await context.route("**/v1/workspaces/*", (route) =>
    json(route, {
      workspace: {
        id: WORKSPACE_ID,
        slug: "momowebqa",
        name: "momo webqa",
        updatedAtMs: Date.now(),
      },
    })
  );
}

/** Resting y of the sidebar nav in a shell that has not been pushed anywhere. */
const NAV_RESTING_TOP = 45;

const SHELL_METRICS = `(() => {
  const doc = document.scrollingElement || document.documentElement;
  const nav = document.querySelector('[aria-label="워크스페이스 탐색"]');
  const shell = document.querySelector(".app-shell");
  return {
    docOverflowY: doc.scrollHeight - doc.clientHeight,
    docOverflowX: doc.scrollWidth - doc.clientWidth,
    docScrollY: Math.round(window.scrollY),
    shellScrollTop: shell ? shell.scrollTop : null,
    shellHeight: shell ? Math.round(shell.getBoundingClientRect().height) : null,
    navTop: nav ? Math.round(nav.getBoundingClientRect().top) : null,
    viewportHeight: window.innerHeight,
  };
})()`;

const failures = [];

function check(label, ok, detail) {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

/** Try to scroll the page, then assert nothing moved and nothing overflows. */
async function assertShellHeld(page, label, shotName) {
  await page.waitForTimeout(300);
  await page.evaluate("window.scrollTo(0, 99999)");
  await page.waitForTimeout(150);
  const m = await page.evaluate(SHELL_METRICS);
  const ok =
    m.docOverflowY === 0 &&
    m.docOverflowX === 0 &&
    m.docScrollY === 0 &&
    m.shellScrollTop === 0 &&
    m.navTop === NAV_RESTING_TOP &&
    m.shellHeight === m.viewportHeight;
  check(label, ok, JSON.stringify(m));
  if (shotName) await page.screenshot({ path: `${OUT_DIR}/${shotName}.png` });
}

async function signIn(page) {
  await page.getByTestId("login-email").fill("seongjae@dawn.example");
  await page.getByTestId("login-password").fill("gate-only-not-a-credential");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-list").waitFor({ state: "visible" });
}

/**
 * Route changes go through the hash, not page.goto: a reload drops the
 * in-memory session and would measure the connect screen by mistake.
 * SettingsRoute reads ?section= once at mount, so settings visits bounce
 * through /inbox to force a remount.
 */
async function go(page, hash) {
  if (hash.startsWith("/settings")) {
    await page.evaluate('location.hash = "/inbox"');
    await page.waitForTimeout(200);
  }
  await page.evaluate(`location.hash = ${JSON.stringify(hash)}`);
  await page.waitForTimeout(600);
}

async function measureSize(browser, size) {
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    colorScheme: SCHEME,
    reducedMotion: "reduce",
  });
  await installMocks(context);
  const page = await context.newPage();
  await page.goto(ORIGIN, { waitUntil: "networkidle" });
  await signIn(page);

  await assertShellHeld(page, `${size.name} 채널`, `${size.name}-chat`);

  // The composer is the bottom edge of the chat pane: if the shell ever hands
  // down an indefinite height it is the first thing to fall out of the window.
  const composer = await page.evaluate(`(() => {
    const el = document.querySelector('[data-testid="composer-input"]');
    if (!el) return { missing: true };
    const r = el.getBoundingClientRect();
    return { bottom: Math.round(r.bottom), viewportHeight: window.innerHeight,
             anchored: r.top >= 0 && r.bottom <= window.innerHeight + 1 };
  })()`);
  check(`${size.name} 컴포저가 창 안에 남는다`, composer.anchored === true, JSON.stringify(composer));

  for (const [hash, label, shot] of [
    ["/inbox", "인박스", "inbox"],
    ["/activity", "활동", "activity"],
    ["/directory", "멤버 디렉터리", "directory"],
    ["/settings?section=account", "설정 계정", "settings-account"],
    ["/settings?section=members", "설정 멤버와 초대", "settings-members"],
    ["/settings?section=ai", "설정 AI 연결", "settings-ai"],
    ["/settings?section=code", "설정 코드 실행 호스트", "settings-code"],
    ["/settings?section=workspace", "설정 워크스페이스", "settings-workspace"],
    ["/settings?section=usage", "설정 사용량", "settings-usage"],
  ]) {
    await go(page, hash);
    await assertShellHeld(page, `${size.name} ${label}`, `${size.name}-${shot}`);
  }

  // Clipping without scrolling would be the worse bug: the settings body pane
  // must still reach its last control, and doing so must not move the shell.
  await go(page, "/settings?section=members");
  const reach = await page.evaluate(`(async () => {
    const btn = document.querySelector('[data-testid="invite-create"]');
    if (!btn) return { missing: true };
    btn.scrollIntoView({ block: "end" });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const r = btn.getBoundingClientRect();
    const shell = document.querySelector(".app-shell");
    const nav = document.querySelector('[aria-label="워크스페이스 탐색"]');
    return {
      reached: r.top >= 0 && r.bottom <= window.innerHeight + 1,
      shellScrollTop: shell ? shell.scrollTop : null,
      docScrollY: Math.round(window.scrollY),
      navTop: nav ? Math.round(nav.getBoundingClientRect().top) : null,
    };
  })()`);
  check(
    `${size.name} 설정 본문이 마지막 컨트롤까지 스크롤된다`,
    reach.reached === true &&
      reach.shellScrollTop === 0 &&
      reach.docScrollY === 0 &&
      reach.navTop === NAV_RESTING_TOP,
    JSON.stringify(reach)
  );
  await page.screenshot({ path: `${OUT_DIR}/${size.name}-settings-bottom.png` });

  // Same question for the member directory (MOMO-611): a 14-row roster is
  // taller than a 480px window, so the LIST has to scroll and the shell must
  // not. Reaching the last row by keyboard is the case that broke settings.
  await go(page, "/directory");
  const lastRow = await page.evaluate(`(async () => {
    const rows = document.querySelectorAll('[data-testid="directory-row"]');
    if (rows.length === 0) return { missing: true };
    const last = rows[rows.length - 1];
    last.scrollIntoView({ block: "end" });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const r = last.getBoundingClientRect();
    const shell = document.querySelector(".app-shell");
    const nav = document.querySelector('[aria-label="워크스페이스 탐색"]');
    const doc = document.scrollingElement || document.documentElement;
    return {
      rows: rows.length,
      reached: r.top >= 0 && r.bottom <= window.innerHeight + 1,
      shellScrollTop: shell ? shell.scrollTop : null,
      docScrollY: Math.round(window.scrollY),
      docOverflowY: doc.scrollHeight - doc.clientHeight,
      navTop: nav ? Math.round(nav.getBoundingClientRect().top) : null,
    };
  })()`);
  check(
    `${size.name} 디렉터리 본문이 마지막 멤버까지 스크롤된다`,
    lastRow.reached === true &&
      lastRow.shellScrollTop === 0 &&
      lastRow.docScrollY === 0 &&
      lastRow.docOverflowY === 0 &&
      lastRow.navTop === NAV_RESTING_TOP,
    JSON.stringify(lastRow)
  );
  await page.screenshot({ path: `${OUT_DIR}/${size.name}-directory-bottom.png` });

  await context.close();
}

/** 1k rows still windowed: virtuoso needs a definite height from the shell. */
async function measureTimeline(browser) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    colorScheme: SCHEME,
    reducedMotion: "reduce",
  });
  await installMocks(context);
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/?stress=1000`, { waitUntil: "networkidle" });
  await signIn(page);
  await page.waitForFunction("window.__spike && window.__spike.count === 1000", null, {
    timeout: 20_000,
  });
  await page.waitForSelector('[data-testid="timeline-message"]', { timeout: 20_000 });

  const timeline = await page.evaluate(`(async () => {
    const scroller = document.querySelector('[data-testid="timeline-virtuoso"]');
    if (!scroller) return { missing: true };
    const firstSeq = () => {
      const el = document.querySelector('[data-testid="timeline-message"]');
      return el ? Number(el.getAttribute("data-seq")) : null;
    };
    // Same warm-up as gate-scroll.mjs: virtuoso only measures the full extent
    // after a bottom→top round trip.
    scroller.scrollTop = scroller.scrollHeight;
    await new Promise((r) => setTimeout(r, 400));
    scroller.scrollTop = 0;
    await new Promise((r) => setTimeout(r, 800));
    const atTop = { rows: document.querySelectorAll('[data-testid="timeline-message"]').length, seq: firstSeq() };
    const measuredScrollHeight = Math.round(scroller.scrollHeight);
    scroller.scrollTop = scroller.scrollHeight;
    await new Promise((r) => setTimeout(r, 800));
    const atBottom = { rows: document.querySelectorAll('[data-testid="timeline-message"]').length, seq: firstSeq() };
    const doc = document.scrollingElement;
    return {
      atTop, atBottom, measuredScrollHeight,
      scrollerBottom: Math.round(scroller.getBoundingClientRect().bottom),
      viewportHeight: window.innerHeight,
      docOverflowY: doc.scrollHeight - doc.clientHeight,
    };
  })()`);

  const ok =
    !timeline.missing &&
    timeline.atTop.rows < 200 &&
    timeline.atBottom.rows < 200 &&
    timeline.measuredScrollHeight > timeline.viewportHeight * 10 &&
    timeline.atBottom.seq > timeline.atTop.seq &&
    timeline.scrollerBottom <= timeline.viewportHeight + 1 &&
    timeline.docOverflowY === 0;
  check("타임라인 1000행 가상화", ok, JSON.stringify(timeline));
  await page.screenshot({ path: `${OUT_DIR}/timeline-1000-bottom.png` });
  await context.close();
}

/**
 * The opposite assertion, on the one surface that has no shell: the connect
 * screen is allowed to scroll the document, and in a short window it has to,
 * or the sign-in button is unreachable.
 */
async function measureConnect(browser) {
  const context = await browser.newContext({
    viewport: { width: 900, height: 380 },
    colorScheme: SCHEME,
    reducedMotion: "reduce",
  });
  await installMocks(context);
  const page = await context.newPage();
  await page.goto(ORIGIN, { waitUntil: "networkidle" });
  const submit = page.getByTestId("login-submit");
  await submit.waitFor({ state: "visible" });
  await submit.scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  const reach = await page.evaluate(`(() => {
    const r = document.querySelector('[data-testid="login-submit"]').getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom),
             viewportHeight: window.innerHeight,
             reached: r.top >= 0 && r.bottom <= window.innerHeight };
  })()`);
  check("연결 화면 짧은 창에서 로그인 버튼 도달", reach.reached === true, JSON.stringify(reach));
  await page.screenshot({ path: `${OUT_DIR}/connect-short-window.png` });
  await context.close();
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
      for (const size of SIZES) await measureSize(browser, size);
      await measureTimeline(browser);
      await measureConnect(browser);
    } finally {
      await browser.close();
    }
  } finally {
    shutdown();
  }

  console.log(`\nscreenshots: ${OUT_DIR}`);
  if (failures.length > 0) {
    console.error(`\nGATE FAIL: ${failures.length} check(s)`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("\nGATE PASS: the shell held at every window size.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
