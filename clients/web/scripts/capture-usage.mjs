#!/usr/bin/env node
// =============================================================================
// 설정 > 사용량 화면 캡처 (AX-7 1층 MOMO-616 + 구독 잔여량 ADR-0135 D2 MOMO-628).
//
// Renders the real UsageSection against the contract fixtures, in both color
// schemes, plus the failure paths that fall back to the last confirmed answer.
// The payloads come from src/features/settings/usageFixtures.json and
// quotaFixtures.json, the same files usageModel.test.ts and quotaModel.test.ts
// assert against, so a screenshot and a test can never disagree about what the
// server said.
//
//   node scripts/capture-usage.mjs           # -> artifacts/design/usage-*.png
//   OUT_DIR=/tmp/shots node scripts/capture-usage.mjs
//
// No credentials and no backend: /v1 is fulfilled from the fixtures below.
// Contracts: docs/planning/handoffs/2026-07-25-usage-summary-contract.md
//            server/.../Routes/ProviderQuotaSnapshotRoutes.swift (X-14)
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

const QUOTA = JSON.parse(
  readFileSync(resolve(WEB_ROOT, "src/features/settings/quotaFixtures.json"), "utf8")
);

/**
 * The quota fixtures carry absolute instants (a reset time is absolute by
 * contract), so run six weeks later and every "오늘 22:00 리셋" would render as a
 * date instead. Shifting the whole set by (now - anchor) keeps the relative
 * words the same on any day the capture runs, and it stays consistent because
 * nothing in the panel derives age from these instants: `ageSeconds` is the
 * server's own figure and is left exactly as the fixture wrote it.
 */
function anchoredQuota(fixture) {
  const shift = Date.now() - Date.parse(QUOTA._anchor);
  const move = (iso) =>
    typeof iso === "string" && !Number.isNaN(Date.parse(iso))
      ? new Date(Date.parse(iso) + shift).toISOString()
      : iso;
  return {
    ...fixture,
    observedAt: move(fixture.observedAt),
    snapshots: fixture.snapshots.map((row) => ({
      ...row,
      resetsAt: row.resetsAt === null ? null : move(row.resetsAt),
      probedAt: move(row.probedAt),
      ingestedAt: move(row.ingestedAt),
    })),
  };
}

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

/**
 * The roster the 에이전트별 rows are named from. Ids are upper-cased exactly as
 * the server sends them, and the two 김인턴 (a human @intern-kim and the agent
 * @kim-intern) are the real reason a cost row cannot be labelled by display
 * name alone: without the handle those are two identical lines in a bill.
 */
function member(id, kind, displayName, handle, extra = {}) {
  return {
    id,
    workspaceId: WORKSPACE_ID,
    kind,
    status: "active",
    displayName,
    handle,
    channelCount: 2,
    channelIds: [GENERAL_ID],
    capabilities: [],
    createdAtMs: 1_750_000_000_000,
    updatedAtMs: 1_750_000_000_000,
    ...extra,
  };
}

const ROSTER = [
  member(ME, "human", "곽성재", "seongjae", { role: "owner" }),
  member(
    "019F94E3-7B0F-7A22-9C13-4D5E6F708192",
    "human",
    "김인턴",
    "intern-kim",
    { role: "member" }
  ),
  member(
    "019F94E3-8B21-7AE0-B3C4-5F1A2D6E7C90",
    "agent",
    "김인턴",
    "kim-intern",
    { ownerHumanId: ME, agentModel: "claude-opus-5" }
  ),
  member(
    "019F94E3-9C32-7BF1-A4D5-6E2B3C7D8E01",
    "agent",
    "hermes",
    "hermes",
    { ownerHumanId: ME, agentModel: "gpt-5.6-sol" }
  ),
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
async function installMocks(context, usage, quota = () => anchoredQuota(QUOTA.healthy)) {
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
  await context.route("**/v1/workspaces/*/roster", (route) =>
    json(route, { members: ROSTER })
  );
  await context.route("**/v1/workspaces/*/usage/summary*", async (route) => {
    // Awaited so a variant can hold a read open and photograph the wait, and
    // handed the URL so one can answer differently per requested window.
    const body = await usage(route.request().url());
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
  // Registered AFTER the /v1/** catch-all so it wins, same as the routes above.
  // It has to exist in every variant, quota-focused or not: without it the
  // catch-all answers an object with no `snapshots`, and the cost screenshots
  // would all carry an empty quota block that no fixture describes.
  await context.route("**/v1/provider/quota-snapshots", async (route) => {
    const body = await quota();
    if (typeof body === "number") {
      return route.fulfill({
        status: body,
        contentType: "application/json",
        body: JSON.stringify(
          body === 404
            ? {}
            : { error: { message: "잔여량을 읽지 못했습니다." } }
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

/** `beforeUsage` runs after sign-in and before the panel opens, which is the
 *  only window in which the browser can be taken offline BEFORE the usage query
 *  is ever created (the offline state has nothing cached to fall back on). */
async function openUsage(context, beforeUsage) {
  const page = await context.newPage();
  await page.goto(ORIGIN, { waitUntil: "networkidle" });
  await page.getByTestId("login-email").fill("seongjae@dawn.example");
  await page.getByTestId("login-password").fill("capture-only-not-a-credential");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-list").waitFor({ state: "visible" });
  if (beforeUsage) await beforeUsage(page, context);
  await page.evaluate('location.hash = "/settings?section=usage"');
  await page.getByTestId("usage-controls").waitFor({ state: "visible" });
  return page;
}

async function captureScheme(browser, scheme) {
  const shots = [];

  async function shoot(name, usage, drive, beforeUsage, quota) {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 2,
      colorScheme: scheme,
      reducedMotion: "reduce",
    });
    await installMocks(context, usage, quota);
    const page = await openUsage(context, beforeUsage);
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

  // 4. 마지막 확인값: one good answer for this window, then the server stops
  //    answering a refresh of the SAME window. The cached summary keeps
  //    rendering, undimmed, and the banner states the instant it was confirmed.
  let served = 0;
  await shoot(
    "last-known",
    () => (served++ === 0 ? FIXTURES.normal : 503),
    async (page) => {
      await page.getByTestId("usage-totals").waitFor({ state: "visible" });
      await page.getByTestId("usage-refresh").click();
      await page.getByTestId("usage-last-known").waitFor({ state: "visible" });
    }
  );

  // 4a. 다른 기간의 실패: 30일 was confirmed, 7일 is not. The fallback is keyed
  //     by window, so the panel says the 7일 read failed instead of leaving the
  //     30일 total on screen under a lit 7일 segment. The control and the
  //     numbers never disagree on a cost surface.
  await shoot(
    "period-switch-error",
    (url) => {
      const q = new URL(url).searchParams;
      const days = Math.round(
        (Date.parse(q.get("to")) - Date.parse(q.get("from"))) / 86_400_000
      );
      return days <= 8 ? 503 : FIXTURES.normal;
    },
    async (page) => {
      await page.getByTestId("usage-totals").waitFor({ state: "visible" });
      await page.getByTestId("usage-period-7d").click();
      await page.getByTestId("usage-error").waitFor({ state: "visible" });
    }
  );

  // 4b. 오류, 폴백할 값도 없을 때: a server that predates the route answers 404,
  //     and the panel says what that means and what to do, inline, not a toast.
  await shoot("error", () => 404, async (page) => {
    await page.getByTestId("usage-error").waitFor({ state: "visible" });
  });

  // 4c. 오프라인: the browser goes offline BEFORE the panel is opened, so the
  //     query is created in react-query's `paused` fetchStatus. It is never
  //     sent and never fails, so nothing but this branch would ever resolve the
  //     skeleton. Nothing is cached yet either, which is the one case that has
  //     to say so in words rather than fall back.
  await shoot(
    "offline",
    () => FIXTURES.normal,
    async (page) => {
      await page.getByTestId("usage-error").waitFor({ state: "visible" });
    },
    async (_page, context) => {
      await context.setOffline(true);
    }
  );

  // 4d. 로딩: height-preserving neutral bars shaped like the panel they stand
  //     in for (two grouped blocks then two lists), so the surface does not jump
  //     ~800px when the read lands. Never a shimmer.
  {
    let release = () => {};
    const held = new Promise((r) => {
      release = r;
    });
    // The read is held open for the whole variant: the shot has to be taken
    // while the bars are still on screen, and shoot() photographs after drive().
    await shoot("loading", () => held.then(() => FIXTURES.normal), async (page) => {
      await page.getByTestId("usage-skeleton").waitFor({ state: "visible" });
    });
    release();
  }

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

  // ---- 구독 잔여량 (ADR-0135 D2 / MOMO-628) ---------------------------------
  //
  // The cost fixture stays normal in all of these: the point of the block is
  // that it is a DIFFERENT frame from the money under the rule, and that only
  // reads if both are on screen at once.

  /** Every quota variant renders the ledger below it unchanged. */
  const withQuota = (name, quota, drive) =>
    shoot(name, () => FIXTURES.normal, drive, undefined, quota);

  // 6. 2게이지 정상: two providers, short and weekly each, remaining rather than
  //    consumed, with the reset written as an absolute instant (레퍼런스 §5).
  await withQuota(
    "quota-normal",
    () => anchoredQuota(QUOTA.healthy),
    async (page) => {
      await page.getByTestId("usage-quota-provider").first().waitFor({ state: "visible" });
    }
  );

  // 6a. 한도 임박: 임박 under a tenth, 주의 under a quarter, and a provider whose
  //     adapter reports only the weekly window, which is stated rather than
  //     drawn as an empty bar.
  await withQuota(
    "quota-near-limit",
    () => anchoredQuota(QUOTA.nearLimit),
    async (page) => {
      await page
        .locator('[data-testid="usage-quota-gauge"][data-tone="danger"]')
        .waitFor({ state: "visible" });
    }
  );

  // 6b. 스냅샷 노후: 7시간 지난 값 + 이미 지나간 리셋 시각. The figures keep
  //     rendering with their age stated and their state colour removed, because
  //     an old 19% may have been 100% for most of those hours.
  await withQuota(
    "quota-stale",
    () => anchoredQuota(QUOTA.staleSnapshot),
    async (page) => {
      await page.getByTestId("usage-quota-reset-passed").first().waitFor({ state: "visible" });
    }
  );

  // 6c. 스냅샷 부재: a 200 with an empty list, which is a server whose adapter
  //     has not probed yet and not a failure. One line and one action.
  await withQuota(
    "quota-empty",
    () => anchoredQuota(QUOTA.absent),
    async (page) => {
      await page.getByTestId("usage-quota-empty").waitFor({ state: "visible" });
    }
  );

  // 6d. 조회 실패, 폴백할 값도 없을 때: a server that predates the ADR-0135
  //     engine layer answers 404 (momowebqa does today), and the cost frame
  //     below keeps rendering because the two are separate contracts.
  await withQuota("quota-error", () => 404, async (page) => {
    await page.getByTestId("usage-quota-error").waitFor({ state: "visible" });
    await page.getByTestId("usage-totals").waitFor({ state: "visible" });
  });

  // 6e. 마지막 확인값: one good answer, then the server stops answering. The
  //     cached gauges keep rendering, undimmed, and the banner states when they
  //     were confirmed (레퍼런스 §5, Claude Code `Showing last-known usage`).
  {
    let served = 0;
    await withQuota(
      "quota-last-known",
      () => (served++ === 0 ? anchoredQuota(QUOTA.healthy) : 503),
      async (page) => {
        await page.getByTestId("usage-quota-provider").first().waitFor({ state: "visible" });
        await page.getByTestId("usage-quota-refresh").click();
        await page.getByTestId("usage-quota-last-known").waitFor({ state: "visible" });
      }
    );
  }

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
