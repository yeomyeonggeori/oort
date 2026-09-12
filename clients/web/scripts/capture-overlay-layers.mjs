#!/usr/bin/env node
// =============================================================================
// Overlay stacking hit-test + two frames (#2044 #2075 #1919).
//
// Real Chromium. jsdom cannot do layout. Reuses the capture preview guard
// and the same mocked /v1 shape as capture-honesty / capture-screens.
//
//   npm run capture:overlay-layers
//   OVERLAY_LAYER_SABOTAGE=unread-pill npm run capture:overlay-layers
//   OVERLAY_LAYER_SABOTAGE=scrim npm run capture:overlay-layers
//
// Sabotage inverts one assertion so the load-bearing layer can be proven red.
// =============================================================================

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";
import { startGuardedPreview } from "../gates/preview-guard.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR
  ? resolve(process.env.OUT_DIR)
  : resolve(WEB_ROOT, "artifacts/overlay-layers");
const PORT = Number(process.env.OVERLAY_LAYER_PORT || 5198);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SABOTAGE = process.env.OVERLAY_LAYER_SABOTAGE || "";

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";
const GENERAL_ID = "00000000-0000-7000-8000-000000000201";
const ME = "019f94e3-7a10-79cd-9dee-208f47edd9a8";
const TEAMMATE = "019f9a01-0000-7000-8000-000000000400";
const NOW = Date.UTC(2024, 5, 15, 3, 0, 0);

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

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
  realtimeWebSocketUrl: `ws://127.0.0.1:${PORT + 1}/connection/websocket`,
};

const CHANNELS = [
  {
    id: GENERAL_ID,
    workspaceId: WORKSPACE_ID,
    kind: "public",
    name: "general",
    topic: "팀 전체 공지와 잡담",
    muted: false,
  },
];

function member(overrides) {
  return {
    workspaceId: WORKSPACE_ID,
    kind: "human",
    status: "active",
    role: "member",
    channelCount: 1,
    channelIds: [GENERAL_ID],
    capabilities: [],
    createdAtMs: NOW - 90 * 86_400_000,
    updatedAtMs: NOW - 86_400_000,
    ...overrides,
  };
}

const ROSTER = [
  member({ id: ME, displayName: "곽성재", handle: "seongjae", role: "owner" }),
  member({ id: TEAMMATE, displayName: "김도현", handle: "dohyun" }),
];

const BODIES = [
  "prometheus mem_limit 붙였어요. 야간 소크 돌려두고 아침에 그래프 확인합시다.",
  "relay outbox lag 지표가 p99에서 1.2s 근처인데, 배치 크기 조정 전에 원인부터 봅시다.",
  "스테이징 배포는 끝났고 프로덕션 배포는 리뷰 하나만 더 받고 올릴게요.",
  "금요일 배포는 하지 맙시다. 월요일 아침에 같이 보는 게 낫겠어요.",
];

function makeMessages(count) {
  const base = NOW - count * 60_000;
  return Array.from({ length: count }, (_, i) => ({
    id: `capture-overlay-${i + 1}`,
    channelId: GENERAL_ID,
    seq: 1400 + i,
    hlcTs: base + i * 60_000,
    hlcCount: 0,
    authorMemberId: ME,
    type: "text",
    body: BODIES[i % BODIES.length],
    state: "sent",
    createdAtMs: base + i * 60_000,
  }));
}

const MESSAGES = makeMessages(40);

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function absent(route) {
  return route.fulfill({ status: 404, contentType: "text/plain", body: "" });
}

async function installRoutes(context) {
  await context.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === "/v1/auth/login") return json(route, SESSION);
    if (path === "/v1/auth/refresh") {
      return json(route, {
        accessToken: SESSION.accessToken,
        refreshToken: SESSION.refreshToken,
      });
    }
    if (path === "/v1/auth/realtime-token") {
      return json(route, {
        token: "capture-only",
        url: SESSION.realtimeWebSocketUrl,
      });
    }
    if (
      path.includes("/workstreams") ||
      path.includes("/approvals") ||
      path.includes("/huddles") ||
      path.includes("/plugins") ||
      path.includes("/memories") ||
      path.includes("/agent-runs")
    ) {
      return absent(route);
    }
    if (path.endsWith("/roster") || path.endsWith("/members")) {
      return json(route, { members: ROSTER });
    }
    if (path.endsWith("/channels")) return json(route, { channels: CHANNELS });
    if (path.endsWith("/read-state")) {
      return json(route, {
        read_states: [
          {
            channel_id: GENERAL_ID,
            last_read_seq: 1405,
            latest_seq: 1439,
            unread_count: 34,
            mention_count: 0,
          },
        ],
      });
    }
    if (path.includes("/messages")) {
      return json(route, { messages: MESSAGES });
    }
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: [] });
    if (path.endsWith("/work-sessions")) return json(route, { workSessions: [] });
    if (path.endsWith("/effort-table")) return json(route, { providers: [] });
    if (path.endsWith(`/v1/workspaces/${WORKSPACE_ID}`)) {
      return json(route, { id: WORKSPACE_ID, name: "새벽팀", settings: {} });
    }
    return json(route, {});
  });
}

async function installRealtimeSocket(page) {
  await page.addInitScript(() => {
    class DeadSocket extends EventTarget {
      constructor() {
        super();
        this.readyState = 0;
      }
      send() {}
      close() {}
    }
    Object.defineProperty(window, "WebSocket", {
      value: DeadSocket,
      writable: true,
    });
  });
}

async function login(page) {
  await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("seongjae@dawn.example");
  await page.getByTestId("login-password").fill("capture-only-not-a-credential");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("timeline-message").first().waitFor({ timeout: 20_000 });
}

async function showJumpLatest(page, { preferBottom = false } = {}) {
  if (!preferBottom) {
    const unread = page.getByTestId("jump-unread");
    try {
      await unread.waitFor({ state: "visible", timeout: 3_000 });
      return;
    } catch {
      /* fall through: scroll to reveal jump-latest */
    }
  }
  await page.evaluate(async () => {
    const frame = () =>
      new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const scroller =
      document.querySelector("[data-virtuoso-scroller]") ||
      document.querySelector('[data-testid="timeline-virtuoso"]');
    if (!scroller) return;
    scroller.scrollTop = 0;
    for (let i = 0; i < 12; i++) await frame();
    if (scroller.scrollTop > 0) scroller.scrollTop = 0;
  });
  const pill =
    preferBottom
      ? page.getByTestId("jump-latest")
      : page.locator(
          '[data-testid="jump-latest"], [data-testid="jump-unread"]'
        );
  await pill.first().waitFor({ state: "visible", timeout: 10_000 });
}

async function hitAt(page, x, y) {
  return page.evaluate(
    ({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      if (!el) return { tag: "NONE", className: "", testId: "", overlay: false };
      const overlay = el.closest(
        [
          "[data-overlay-layer]",
          "[data-radix-dialog-overlay]",
          "[data-testid='quick-switcher']",
          "[data-testid='quick-switcher-overlay']",
          "[data-testid='message-action-sheet']",
          "[data-testid='delete-message-dialog']",
          "[data-testid='sidebar-scrim']",
          "[data-testid='composer-emoji-picker']",
        ].join(",")
      );
      const className =
        typeof el.className === "string" ? el.className : el.className?.baseVal || "";
      return {
        tag: el.tagName,
        className,
        testId:
          el.getAttribute("data-testid") ||
          el.closest("[data-testid]")?.getAttribute("data-testid") ||
          "",
        overlay: Boolean(overlay),
        overlayLayer:
          overlay?.getAttribute("data-overlay-layer") ||
          overlay?.getAttribute("data-testid") ||
          "",
      };
    },
    { x, y }
  );
}

function describeHit(hit) {
  const classes = hit.className.split(/\s+/).filter(Boolean).slice(0, 8).join(" ");
  return `<${hit.tag.toLowerCase()}> class="${classes}" testid=${hit.testId || "—"} overlay=${hit.overlayLayer || "no"}`;
}

async function boxCenter(locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("bounding box missing");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
}

async function collectCoords(page) {
  const pill =
    SABOTAGE === "scrim"
      ? page.getByTestId("jump-latest")
      : page
          .locator('[data-testid="jump-latest"], [data-testid="jump-unread"]')
          .first();
  await pill.waitFor({ state: "visible" });
  const pillPt = await boxCenter(pill);

  const row = page.getByTestId("timeline-message").first();
  const rowBox = await row.boundingBox();
  if (!rowBox) throw new Error("message row missing");
  let toolbarPt = {
    x: rowBox.x + rowBox.width - 48,
    y: rowBox.y + 12,
  };
  const toolbar = page.getByTestId("message-hover-toolbar");
  if ((await toolbar.count()) > 0 && (await toolbar.isVisible().catch(() => false))) {
    toolbarPt = await boxCenter(toolbar);
  }

  const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
  const clamp = (pt) => ({
    x: Math.min(Math.max(12, pt.x), viewport.width - 12),
    y: Math.min(Math.max(12, pt.y), viewport.height - 12),
  });
  const arbitrary = {
    x: Math.round(viewport.width * 0.42),
    y: Math.round(viewport.height * 0.38),
  };
  return {
    pill: clamp(pillPt),
    toolbar: clamp(toolbarPt),
    arbitrary: clamp(arbitrary),
  };
}

async function sabotageUnreadPill(page) {
  // Revert the dock to leftover Tailwind z-10 (the class UnreadPill used to
  // write). CSS injection survives React re-renders of the dock.
  await page.addStyleTag({
    content: "div:has(> [data-unread-pill]) { z-index: 10 !important; }",
  });
}

async function sabotageScrim(page) {
  await page.addStyleTag({
    content: '[data-overlay-layer="scrim"] { z-index: auto !important; }',
  });
}

function expectOverlay(hit, label, { invert = false } = {}) {
  const line = `  elementFromPoint ${label}: ${describeHit(hit)}`;
  console.log(line);
  const ok = hit.overlay && !/jump-latest|jump-unread|unfurl-remove|message-hover-toolbar|timeline-message/.test(
    hit.testId
  );
  if (invert) {
    if (ok) {
      throw new Error(
        `SABOTAGE expected RED at ${label} but overlay still won: ${describeHit(hit)}`
      );
    }
    console.log(`  RED proof ${label}: timeline/control won (expected)`);
    return line;
  }
  if (!ok) {
    throw new Error(
      `${label}: expected overlay, got ${describeHit(hit)}`
    );
  }
  return line;
}

async function longPressGesture(page, target) {
  const box = await target.boundingBox();
  if (!box) throw new Error("long-press target has no box");
  const x0 = box.x + Math.min(24, box.width / 2);
  const y0 = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: x0, y: y0, radiusX: 12, radiusY: 12, force: 1 }],
    });
    await page.waitForTimeout(750);
    const opened = await page
      .getByTestId("message-action-sheet")
      .isVisible()
      .catch(() => false);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchCancel",
      touchPoints: [],
    });
    return opened;
  } finally {
    await cdp.detach();
  }
}

async function probeKind(page, kind, open, { clickPillClosesPalette = false } = {}) {
  await showJumpLatest(page, { preferBottom: SABOTAGE === "scrim" });
  const coords = await collectCoords(page);
  await open();
  if (SABOTAGE === "unread-pill") await sabotageUnreadPill(page);
  if (SABOTAGE === "scrim") await sabotageScrim(page);
  await page.waitForTimeout(80);
  const scrimBox = await page
    .locator("[data-overlay-layer='scrim']")
    .first()
    .boundingBox()
    .catch(() => null);
  if (
    SABOTAGE !== "scrim" &&
    scrimBox &&
    scrimBox.width > 16 &&
    scrimBox.height > 16
  ) {
    const inside = (pt) =>
      pt.x >= scrimBox.x + 4 &&
      pt.x <= scrimBox.x + scrimBox.width - 4 &&
      pt.y >= scrimBox.y + 4 &&
      pt.y <= scrimBox.y + scrimBox.height - 4;
    if (!inside(coords.toolbar)) {
      coords.toolbar = {
        x: scrimBox.x + scrimBox.width / 2,
        y: scrimBox.y + scrimBox.height * 0.55,
      };
    }
    if (!inside(coords.arbitrary)) {
      coords.arbitrary = {
        x: scrimBox.x + scrimBox.width * 0.65,
        y: scrimBox.y + scrimBox.height * 0.4,
      };
    }
  }

  const pillHit = await hitAt(page, coords.pill.x, coords.pill.y);
  const toolbarHit = await hitAt(page, coords.toolbar.x, coords.toolbar.y);
  const arbitraryHit = await hitAt(page, coords.arbitrary.x, coords.arbitrary.y);
  const lines = [];
  const hasScrim = (await page.locator("[data-overlay-layer='scrim']").count()) > 0;
  if (SABOTAGE === "unread-pill") {
    lines.push(expectOverlay(pillHit, `${kind} pill`, { invert: true }));
    if (hasScrim) {
      lines.push(expectOverlay(toolbarHit, `${kind} toolbar`));
      lines.push(expectOverlay(arbitraryHit, `${kind} arbitrary`));
    }
  } else if (SABOTAGE === "scrim") {
    console.log(`  elementFromPoint ${kind} pill: ${describeHit(pillHit)}`);
    console.log(`  elementFromPoint ${kind} toolbar: ${describeHit(toolbarHit)}`);
    console.log(`  elementFromPoint ${kind} arbitrary: ${describeHit(arbitraryHit)}`);
    const pillRed = !pillHit.overlay;
    const arbitraryRed = !arbitraryHit.overlay;
    if (arbitraryRed) {
      lines.push(
        expectOverlay(arbitraryHit, `${kind} arbitrary`, { invert: true })
      );
    } else if (pillRed) {
      console.log(
        `  RED proof ${kind} pill: timeline float won after scrim layer revert; empty arbitrary still overlay (fixed+blur stacking)`
      );
      lines.push(`  elementFromPoint ${kind} pill: ${describeHit(pillHit)}`);
    } else {
      throw new Error(
        `SABOTAGE scrim: expected a timeline hit at pill or arbitrary, both still overlay`
      );
    }
  } else if (hasScrim) {
    lines.push(expectOverlay(pillHit, `${kind} pill`));
    lines.push(expectOverlay(toolbarHit, `${kind} toolbar`));
    lines.push(expectOverlay(arbitraryHit, `${kind} arbitrary`));
  } else {
    // Popover/menu: no dimming scrim. The named surface layer must still
    // sit above content-float, and a point on the panel must hit the panel.
    const order = await page.evaluate(() => {
      const surface = document.querySelector("[data-overlay-layer='surface']");
      const pill = document.querySelector(
        '[data-testid="jump-latest"], [data-testid="jump-unread"]'
      )?.parentElement;
      if (!surface || !pill) return null;
      const zs = Number.parseInt(getComputedStyle(surface).zIndex, 10);
      const zp = Number.parseInt(getComputedStyle(pill).zIndex, 10);
      const box = surface.getBoundingClientRect();
      const at = document.elementFromPoint(
        box.left + Math.min(24, box.width / 2),
        box.top + Math.min(24, box.height / 2)
      );
      return {
        surfaceZ: zs,
        pillZ: zp,
        onPanel: Boolean(at?.closest("[data-overlay-layer='surface']")),
      };
    });
    if (!order || !(order.surfaceZ > order.pillZ) || !order.onPanel) {
      throw new Error(
        `${kind}: surface layer must beat content-float and receive hits on the panel (${JSON.stringify(order)})`
      );
    }
    console.log(
      `  ${kind} (no scrim): surface z=${order.surfaceZ} > pill z=${order.pillZ}; panel hit ok`
    );
    console.log(`  elementFromPoint ${kind} pill: ${describeHit(pillHit)}`);
    console.log(`  elementFromPoint ${kind} toolbar: ${describeHit(toolbarHit)}`);
    console.log(`  elementFromPoint ${kind} arbitrary: ${describeHit(arbitraryHit)}`);
  }

  if (clickPillClosesPalette) {
    const before = await hitAt(page, coords.pill.x, coords.pill.y);
    console.log(`  palette click target: ${describeHit(before)}`);
    await page.mouse.click(coords.pill.x, coords.pill.y);
    const still = await page.getByTestId("quick-switcher").isVisible();
    const focused = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="quick-switcher"]');
      return Boolean(root && root.contains(document.activeElement));
    });
    if (SABOTAGE === "unread-pill") {
      if (still && before.testId === "jump-unread") {
        throw new Error("SABOTAGE unread-pill: click should have hit the pill and closed");
      }
      console.log(`  RED proof palette: still=${still} hit=${before.testId}`);
    } else if (before.overlayLayer === "surface") {
      if (!still) throw new Error("palette closed after click at UnreadPill position");
      if (!focused) throw new Error("palette lost focus after click at UnreadPill position");
      console.log("  palette stayed open and focused after click at pill position");
    } else if (before.overlayLayer === "scrim") {
      // Pill sits over empty scrim, not the panel. Scrim dismiss is correct.
      console.log("  pill position is over the scrim (dismiss is the overlay, not the pill)");
    } else {
      throw new Error(
        `palette click at pill hit ${describeHit(before)}, not the overlay`
      );
    }
  }
  return lines;
}

async function openDialog(page) {
  const row = page.getByTestId("timeline-message").first();
  await row.hover({ force: true });
  await page.getByTestId("message-actions-trigger").click({ force: true });
  await page.getByTestId("menu-delete").click();
  await page.getByTestId("delete-message-dialog").waitFor({ state: "visible" });
}

async function openPopover(page) {
  await page.getByTestId("composer-emoji-trigger").click();
  await page.getByTestId("composer-emoji-picker").waitFor({ state: "visible" });
}

async function openPalette(page) {
  await page.getByTestId("open-quick-switcher").click();
  await page.getByTestId("quick-switcher").waitFor({ state: "visible" });
}

async function openDrawer(page) {
  await page.getByTestId("open-sidebar-drawer").click();
  await page.getByTestId("sidebar-scrim").waitFor({ state: "visible" });
}

async function openActionSheet(page) {
  const target = page.getByTestId("timeline-message").last();
  const opened = await longPressGesture(page, target);
  if (!opened) {
    throw new Error("action sheet did not open from long press");
  }
  await page.getByTestId("message-action-sheet").waitFor({ state: "visible" });
}

async function withPage(browser, opts, fn) {
  const context = await browser.newContext({
    reducedMotion: "reduce",
    ...opts,
  });
  const page = await context.newPage();
  await installRealtimeSocket(page);
  await installRoutes(context);
  try {
    await login(page);
    return await fn(page);
  } finally {
    await context.close();
  }
}

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) {
    throw new Error("dist/ is missing. Run `npm --prefix clients/web run build`.");
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({
    webRoot: WEB_ROOT,
    port: PORT,
    portEnvVar: "OVERLAY_LAYER_PORT",
  });
  const lines = [];
  try {
    const browser = await chromium.launch();
    try {
      if (SABOTAGE === "unread-pill" || SABOTAGE === "scrim") {
        console.log(`## desktop 1280 light (sabotage=${SABOTAGE})`);
        await withPage(
          browser,
          { viewport: { width: 1280, height: 800 }, colorScheme: "light" },
          async (page) => {
            lines.push(
              ...(await probeKind(page, "palette", () => openPalette(page), {
                clickPillClosesPalette: SABOTAGE === "unread-pill",
              }))
            );
          }
        );
      } else if (!SABOTAGE) {
        console.log(`## desktop 1280 light (sabotage=${SABOTAGE || "none"})`);
        await withPage(
          browser,
          { viewport: { width: 1280, height: 800 }, colorScheme: "light" },
          async (page) => {
            lines.push(...(await probeKind(page, "dialog", () => openDialog(page))));
            await page.keyboard.press("Escape");
            await page.getByTestId("delete-message-dialog").waitFor({ state: "hidden" });
            lines.push(...(await probeKind(page, "popover", () => openPopover(page))));
            await page.keyboard.press("Escape");
            lines.push(
              ...(await probeKind(page, "palette", () => openPalette(page), {
                clickPillClosesPalette: SABOTAGE !== "scrim",
              }))
            );
            if (!SABOTAGE) {
              const dialogPath = resolve(OUT_DIR, "dialog-light-1280.png");
              await page.keyboard.press("Escape");
              await openDialog(page);
              await page.screenshot({ path: dialogPath });
              console.log(`  shot ${dialogPath}`);
            }
          }
        );

        console.log(`## mobile 390 dark (sabotage=${SABOTAGE || "none"})`);
        await withPage(
          browser,
          {
            viewport: { width: 390, height: 844 },
            deviceScaleFactor: 3,
            isMobile: true,
            hasTouch: true,
            userAgent: IPHONE_UA,
            colorScheme: "dark",
          },
          async (page) => {
            lines.push(
              ...(await probeKind(page, "action-sheet", () => openActionSheet(page)))
            );
            await page.keyboard.press("Escape");
            await page
              .getByTestId("message-action-sheet")
              .waitFor({ state: "hidden" });
            lines.push(...(await probeKind(page, "drawer", () => openDrawer(page))));
            if (!SABOTAGE) {
              await page.keyboard.press("Escape");
              await openActionSheet(page);
              const sheetPath = resolve(OUT_DIR, "mobile-b11-action-sheet-dark.png");
              await page.screenshot({ path: sheetPath });
              console.log(`  shot ${sheetPath}`);
            }
          }
        );
      }
    } finally {
      await browser.close();
    }
  } finally {
    await preview.stop();
  }
  if (SABOTAGE) {
    console.log(`## overlay layer RED proof (${SABOTAGE}) confirmed`);
    for (const line of lines) console.log(line);
    process.exit(1);
  }
  console.log("## overlay layer probe PASS");
  for (const line of lines) console.log(line);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
