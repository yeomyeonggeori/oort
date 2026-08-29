#!/usr/bin/env node
// =============================================================================
// 설정 > 이벤트 구독 화면 캡처 (#1202 워커 V).
//
// Renders the real EventSubscriptionSection against the four `event-subscriptions`
// operations, in both color schemes, covering the four mandatory states plus the
// two moments this surface exists for: the create form (what leaves the
// workspace) and the one-time signing secret (the only render it ever gets).
//
//   node scripts/capture-eventsub.mjs        # -> artifacts/design/eventsub-*.png
//   OUT_DIR=/tmp/shots node scripts/capture-eventsub.mjs
//
// No credentials and no backend: /v1 is fulfilled from the fixtures below. The
// "secret" in the create fixture is a capture string, not signing material: the
// real one is derived server-side and never leaves the create response.
// Contracts: docs/api/openapi.yaml (event-subscriptions),
//            server/Migrations/033_event_subscription.sql
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
  : resolve(WEB_ROOT, "artifacts/design");
const PORT = Number(process.env.CAPTURE_PORT || 5184);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const VIEWPORT = { width: 1280, height: 900 };

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";
const GENERAL_ID = "00000000-0000-7000-8000-000000000201";
const ME = "019f94e3-7a10-79cd-9dee-208f47edd9a8";
const DAY = 86_400_000;

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
  { id: "00000000-0000-7000-8000-000000000202", workspaceId: WORKSPACE_ID, kind: "public", name: "엔진", muted: false },
];

function subscription(overrides) {
  return {
    id: "019f94e3-1111-7000-8000-000000000001",
    workspaceId: WORKSPACE_ID,
    url: "https://hooks.example.com/oort/mentions",
    eventKinds: ["mention"],
    enabled: true,
    deliveryFailureCount: 0,
    createdBy: ME,
    updatedBy: ME,
    createdAtMs: Date.now() - 12 * DAY,
    updatedAtMs: Date.now() - 12 * DAY,
    ...overrides,
  };
}

/**
 * Three rows that are three different answers, not three of the same row: one
 * delivering, one the relay stopped after repeated 5xx, and one that is off with
 * no reason on record (the state a two-branch mapping would call 관리자 중지).
 */
const ROWS = [
  subscription({
    id: "019f94e3-1111-7000-8000-000000000001",
    url: "https://hooks.slack.com/services/T0/B0/oort-mentions",
    eventKinds: ["mention", "approval_request"],
    createdAtMs: Date.now() - 2 * DAY,
    updatedAtMs: Date.now() - 2 * DAY,
  }),
  subscription({
    id: "019f94e3-1111-7000-8000-000000000002",
    url: "https://ops.dawnlab.example/oort/work-status",
    eventKinds: ["work.status_changed"],
    enabled: false,
    disabledReason: "server_5xx_threshold",
    deliveryFailureCount: 3,
    disabledAtMs: Date.now() - 6 * 3_600_000,
    createdAtMs: Date.now() - 9 * DAY,
    updatedAtMs: Date.now() - 6 * 3_600_000,
  }),
  subscription({
    id: "019f94e3-1111-7000-8000-000000000003",
    url: "https://n8n.dawnlab.example/webhook/oort-approval",
    eventKinds: ["approval_request"],
    enabled: false,
    createdAtMs: Date.now() - 31 * DAY,
    updatedAtMs: Date.now() - 20 * DAY,
  }),
];

const CREATED = {
  eventSubscription: subscription({
    id: "019f94e3-1111-7000-8000-0000000000ff",
    url: "https://hooks.example.com/oort/approvals",
    eventKinds: ["approval_request", "work.status_changed"],
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
  }),
  secret: "whsec_capture_only_not_a_credential_9f2a7c41",
  signatureVersion: "v1",
  algorithm: "HMAC-SHA256",
};

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

/** `list` returns rows, or an HTTP status to answer instead. */
async function installMocks(context, list) {
  await context.route("**/v1/**", (route) =>
    json(route, { channels: [], members: [], read_states: [], messages: [] })
  );
  await context.route("**/v1/auth/login", (route) => json(route, SESSION));
  // 로그인 직후 토큰 회전: 위 포괄 스텁은 200이지만 모양이 비어 있어 코어가
  // throw 하고 앱이 스스로 로그아웃한다 (#1089).
  await context.route("**/v1/auth/refresh", (route) =>
    json(route, {
      accessToken: SESSION.accessToken,
      refreshToken: SESSION.refreshToken,
    })
  );
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
    json(route, { members: [] })
  );
  // Registered after the catch-all so it wins, same convention as capture-usage.
  await context.route("**/v1/workspaces/*/event-subscriptions", async (route) => {
    if (route.request().method() === "POST") return json(route, CREATED, 201);
    const body = await list();
    if (typeof body === "number") {
      return json(
        route,
        body === 403
          ? { error: { message: "event subscriptions require a human admin" } }
          : { error: { message: "event subscriptions are unavailable" } },
        body
      );
    }
    return json(route, { eventSubscriptions: body });
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

async function openPanel(context) {
  const page = await context.newPage();
  await page.goto(ORIGIN, { waitUntil: "networkidle" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("seongjae@dawn.example");
  await page.getByTestId("login-password").fill("capture-only-not-a-credential");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-list").waitFor({ state: "visible" });
  await page.evaluate('location.hash = "/settings?section=events"');
  return page;
}

/** Fill the create form without submitting: the address plus two events. */
async function draft(page) {
  await page.getByTestId("event-subscription-url-input").fill(
    "https://hooks.example.com/oort/approvals"
  );
  await page.getByTestId("event-subscription-kinds")
    .locator('input[value="approval_request"]').check();
  await page.getByTestId("event-subscription-kinds")
    .locator('input[value="work.status_changed"]').check();
}

async function captureScheme(browser, scheme) {
  const shots = [];

  async function shoot(name, list, drive) {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 2,
      colorScheme: scheme,
      reducedMotion: "reduce",
    });
    await installMocks(context, list);
    const page = await openPanel(context);
    await drive(page);
    const path = `${OUT_DIR}/eventsub-${name}-${scheme}.png`;
    await page.screenshot({ path });
    shots.push(path);
    await context.close();
  }

  // 1. 목록: three rows, three states, each with its address, its reason line
  //    and its two row actions.
  await shoot("list", () => ROWS, async (page) => {
    await page.getByTestId("event-subscription-list").waitFor({ state: "visible" });
  });

  // 1b. 삭제 확인: nothing irreversible fires on one unguarded click, so the
  //     second step is a real state this surface has to be reviewed in.
  await shoot("delete-confirm", () => ROWS, async (page) => {
    await page.getByTestId("event-subscription-list").waitFor({ state: "visible" });
    await page.getByTestId("event-subscription-delete").first().click();
    await page.getByTestId("event-subscription-delete-confirm").waitFor({ state: "visible" });
  });

  // 2. 생성: the form with an address typed and two events chosen. Each option
  //    states what that event actually sends, which is the whole point of the
  //    block: two of the three carry the message body out of the workspace.
  await shoot("create", () => ROWS, async (page) => {
    await page.getByTestId("event-subscription-create-form").waitFor({ state: "visible" });
    await draft(page);
    await page.getByTestId("event-subscription-kinds").scrollIntoViewIfNeeded();
  });

  // 2b. 생성 검증 실패: the address is refused before a request is made, and
  //     the rule is stated where the problem is, with the hint still on screen.
  await shoot("create-invalid", () => ROWS, async (page) => {
    await page.getByTestId("event-subscription-create-form").waitFor({ state: "visible" });
    await page.getByTestId("event-subscription-url-input").fill(
      "https://svc:s3cr3t@hooks.example.com/oort"
    );
    await page.getByTestId("event-subscription-create").click();
    await page.getByTestId("event-subscription-create-form")
      .locator('[role="alert"]').first().waitFor({ state: "visible" });
    await page.getByTestId("event-subscription-create-form").scrollIntoViewIfNeeded();
  });

  // 3. 서명 비밀 1회: the block takes focus, states the algorithm and version,
  //    and says what happens when it is closed. This value never returns.
  await shoot("secret", () => ROWS, async (page) => {
    await page.getByTestId("event-subscription-create-form").waitFor({ state: "visible" });
    await draft(page);
    await page.getByTestId("event-subscription-create").click();
    await page.getByTestId("event-subscription-secret").waitFor({ state: "visible" });
    await page.getByTestId("event-subscription-secret").scrollIntoViewIfNeeded();
  });

  // 4. 빈 상태: one line of copy and the form right under it, never a poster.
  await shoot("empty", () => [], async (page) => {
    await page.getByTestId("event-subscription-empty").waitFor({ state: "visible" });
  });

  // 5. 로딩: height-preserving neutral bars, no shimmer.
  {
    let release = () => {};
    const held = new Promise((r) => {
      release = r;
    });
    await shoot("loading", () => held.then(() => ROWS), async (page) => {
      await page.getByTestId("skeleton-row").first().waitFor({ state: "visible" });
    });
    release();
  }

  // 6. 권한 없음: a 403 is an answer, so the panel says who can instead of
  //    drawing a form whose save is guaranteed to fail.
  await shoot("denied", () => 403, async (page) => {
    await page.getByTestId("operator-notice").waitFor({ state: "visible" });
  });

  // 7. 오류: what happened and the next step, inline, with a retry.
  await shoot("error", () => 503, async (page) => {
    await page.getByTestId("event-subscription-error").waitFor({ state: "visible" });
  });

  // 7b. 오프라인: the fourth mandatory state, which the first pass shipped as an
  //     assertion rather than a picture (#1203 design review H3). It is
  //     reachable now because the settings shell reads `useOffline`, which asks
  //     the BROWSER as well as the rail: `setOffline` is what a pulled cable
  //     looks like, and the rail's `disconnected` never arrives from one
  //     (useOffline.ts). Both row controls go grey here, so the shot has to
  //     show the sentence standing next to them, not just the shell banner.
  await shoot("offline", () => ROWS, async (page) => {
    await page.getByTestId("event-subscription-list").waitFor({ state: "visible" });
    await page.context().setOffline(true);
    await page.getByTestId("settings-offline-banner").waitFor({ state: "visible" });
    await page
      .getByTestId("event-subscription-row-offline")
      .first()
      .waitFor({ state: "visible" });
  });

  // 7c. 만들기 실패 중 확인 못 한 2xx: the sentence tells the reader to re-read
  //     the list, so the control that does it is in the same block (#1203 M1).
  await shoot("create-unverified", () => ROWS, async (page) => {
    await page.getByTestId("event-subscription-create-form").waitFor({ state: "visible" });
    // A create that answers 2xx with a body describing a different address.
    await page.context().route("**/v1/workspaces/*/event-subscriptions", (route) =>
      route.request().method() === "POST"
        ? json(route, { ...CREATED, eventSubscription: { ...CREATED.eventSubscription, url: "https://elsewhere.example/oort" } }, 201)
        : json(route, { eventSubscriptions: ROWS })
    );
    await draft(page);
    await page.getByTestId("event-subscription-create").click();
    await page.getByTestId("event-subscription-create-reload").waitFor({ state: "visible" });
    await page.getByTestId("event-subscription-create-reload").scrollIntoViewIfNeeded();
  });

  // 8. 키보드 초점: tabbed into rather than focused programmatically, because
  //    :focus-visible only fires on the real path.
  await shoot("focus", () => ROWS, async (page) => {
    await page.getByTestId("event-subscription-list").waitFor({ state: "visible" });
    for (let i = 0; i < 40; i += 1) {
      const onToggle = await page.evaluate(`(() => {
        const el = document.activeElement;
        return !!el && el.getAttribute("data-testid") === "event-subscription-toggle";
      })()`);
      if (onToggle) break;
      await page.keyboard.press("Tab");
    }
  });

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
