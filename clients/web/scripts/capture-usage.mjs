#!/usr/bin/env node
// =============================================================================
// 설정 > 사용량 화면 캡처 (AX-7 1층 / MOMO-616).
//
// Renders the real UsageSection against the three contract fixtures, in both
// color schemes, plus the failure path that falls back to the last confirmed
// answer. The payloads come from src/features/settings/usageFixtures.json, the
// same file usageModel.test.ts asserts against, so a screenshot and a test can
// never disagree about what the server said.
//
//   node scripts/capture-usage.mjs           # -> artifacts/design/usage-*.png
//   OUT_DIR=/tmp/shots node scripts/capture-usage.mjs
//
// No credentials and no backend: /v1 is fulfilled from the fixtures below.
// Contract: docs/planning/handoffs/2026-07-25-usage-summary-contract.md
// =============================================================================

import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR
  ? resolve(process.env.OUT_DIR)
  : resolve(WEB_ROOT, "artifacts/design");
const PORT = Number(process.env.CAPTURE_PORT || 5181);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const VIEWPORT = { width: 1280, height: 800 };

const FIXTURES = JSON.parse(
  readFileSync(resolve(WEB_ROOT, "src/features/settings/usageFixtures.json"), "utf8")
);

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";
const GENERAL_ID = "00000000-0000-7000-8000-000000000201";
const ME = "019f94e3-7a10-79cd-9dee-208f47edd9a8";

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

function json(route, body) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

/**
 * `usage` is a function so a variant can change its answer mid run: the
 * fallback capture serves one good response and then starts failing, which is
 * exactly the sequence that produces a 마지막 확인값 screen. Returning a number
 * instead of a payload answers that HTTP status: 404 is what a server built
 * before the engine ticket landed says, and the panel turns it into a sentence.
 */
async function installMocks(context, usage) {
  await context.route("**/v1/**", (route) =>
    json(route, { channels: [], members: [], read_states: [], messages: [] })
  );
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
  await context.route("**/v1/workspaces/*/usage/summary*", (route) => {
    const body = usage();
    if (typeof body === "number") {
      return route.fulfill({
        status: body,
        contentType: "application/json",
        body: JSON.stringify(
          body === 404
            ? {}
            : {
                error: {
                  message:
                    "사용량을 집계하는 중입니다. 잠시 뒤에 다시 시도하세요.",
                },
              }
        ),
      });
    }
    return json(route, body);
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

/** The settings body pane scrolls, not the document (MOMO-610 shell contract). */
async function scrollTo(page, selector) {
  await page.evaluate(`(async () => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (el) el.scrollIntoView({ block: "center" });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  })()`);
}

async function openUsage(context) {
  const page = await context.newPage();
  await page.goto(ORIGIN, { waitUntil: "networkidle" });
  await page.getByTestId("login-email").fill("seongjae@dawn.example");
  await page.getByTestId("login-password").fill("capture-only-not-a-credential");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-list").waitFor({ state: "visible" });
  await page.evaluate('location.hash = "/settings?section=usage"');
  await page.getByTestId("usage-controls").waitFor({ state: "visible" });
  return page;
}

async function captureScheme(browser, scheme) {
  const shots = [];

  async function shoot(name, usage, drive) {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 2,
      colorScheme: scheme,
      reducedMotion: "reduce",
    });
    await installMocks(context, usage);
    const page = await openUsage(context);
    await drive(page);
    const path = `${OUT_DIR}/usage-${name}-${scheme}.png`;
    await page.screenshot({ path });
    shots.push(path);
    await context.close();
  }

  // 1. 정상, 패널 상단: the range controls, the total with its estimated part
  //    split out, and the budget block under its limit.
  await shoot("normal", () => FIXTURES.normal, async (page) => {
    await page.getByTestId("usage-totals").waitFor({ state: "visible" });
  });

  // 1b. 정상, 분해 영역: the model and agent rows with their bars, plus the
  //     bucket disclosure opened so the per-day rows are reviewable.
  await shoot("breakdown", () => FIXTURES.normal, async (page) => {
    await page.getByTestId("usage-totals").waitFor({ state: "visible" });
    await page.getByTestId("usage-buckets").locator("summary").click();
    await page.getByTestId("usage-bucket-row").first().waitFor({ state: "visible" });
    await scrollTo(page, '[data-testid="usage-model-row"]');
  });

  // 2. 빈 기간: 200 with zeros, not a 404. One line of copy and one action.
  await shoot("empty", () => FIXTURES.emptyPeriod, async (page) => {
    await page.getByTestId("usage-period-7d").click();
    await page.getByTestId("usage-empty").waitFor({ state: "visible" });
  });

  // 3. budget hard_limit: the state chip and the danger-toned detail line. The
  //    fixture covers a 7-day range, so the control is set to match it.
  await shoot("budget-hard-limit", () => FIXTURES.budgetHardLimit, async (page) => {
    await page.getByTestId("usage-period-7d").click();
    const budget = '[data-testid="usage-budget"][data-budget-state="hard_limit"]';
    await page.locator(budget).waitFor({ state: "visible" });
    await scrollTo(page, budget);
  });

  // 4. 마지막 확인값: one good answer, then the server stops answering and the
  //    person switches range. The cached summary keeps rendering, undimmed,
  //    with the instant it was confirmed stated above it.
  let served = 0;
  await shoot(
    "last-known",
    () => (served++ === 0 ? FIXTURES.normal : 503),
    async (page) => {
      await page.getByTestId("usage-totals").waitFor({ state: "visible" });
      await page.getByTestId("usage-period-7d").click();
      await page.getByTestId("usage-last-known").waitFor({ state: "visible" });
    }
  );

  // 4b. 오류, 폴백할 값도 없을 때: a server that predates the route answers 404,
  //     and the panel says what that means and what to do, inline, not a toast.
  await shoot("error", () => 404, async (page) => {
    await page.getByTestId("usage-error").waitFor({ state: "visible" });
  });

  // 5. 키보드 초점: the range control is a native radio group, one tab stop with
  //    arrow-key roving inside it. Tabbed into rather than focused
  //    programmatically, because :focus-visible only fires for the real path.
  await shoot("focus", () => FIXTURES.normal, async (page) => {
    await page.getByTestId("usage-totals").waitFor({ state: "visible" });
    for (let i = 0; i < 30; i += 1) {
      const onControl = await page.evaluate(`(() => {
        const el = document.activeElement;
        return !!el && el.getAttribute("name") === "usage-period";
      })()`);
      if (onControl) break;
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
