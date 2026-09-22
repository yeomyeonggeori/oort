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
//   OVERLAY_LAYER_SABOTAGE=artifact-root-z npm run capture:overlay-layers
//   OVERLAY_LAYER_SABOTAGE=tray-content-float npm run capture:overlay-layers
//
// Sabotage reverts one load-bearing thing so the lane can be proven red. Each
// mode reproduces one measured R1 defect (#2485):
//
//   unread-pill        the dock back on a raw `z-10` → ROOT SWEEP red
//   scrim              the scrim's layer removed      → hit test red
//   artifact-root-z    ArtifactCard's `isolate` off   → ROOT SWEEP red (B-2)
//   tray-content-float the tray back on content-float → thread tray red (B-1)
//
// The ROOT SWEEP is the check R1's H-2 asked for and the reason two of these
// modes exist: it walks every element that resolves a numeric z-index, works
// out which stacking context actually owns it, and fails when anything outside
// the named scale competes in the document's root. A path allowlist could not
// see that; this can, because it measures the property.
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

// The 관제 서랍 is folded out of a production build (`serverSurfaces` — the
// self-host default serves no work ledger), so the one scene where the two
// drawers can be open together needs the `ade-gate` bundle. It is built beside
// dist/ by the npm script and served on its own port; when it is missing the
// M-1 scene says so instead of quietly not running.
const ADE_DIST = resolve(WEB_ROOT, "artifacts/dist-ade-gate");
const ADE_DIST_REL = "artifacts/dist-ade-gate";
const ADE_PORT = PORT + 2;
const ADE_ORIGIN = `http://127.0.0.1:${ADE_PORT}`;

const LAYER_NAMES = [
  "--layer-content-float",
  "--layer-overlay-scrim",
  "--layer-overlay-surface",
];

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

// A unified diff body renders as ArtifactCard's file blocks, and the sticky
// filename inside one is the `z-10` leftover R1 measured painting straight
// across the ⌘K panel and across the 390px sidebar drawer (#2485 R1 B-2). The
// scenes below need it on screen, so it lives in the fixture rather than in a
// throwaway probe.
const DIFF_BODY = [
  "diff --git a/clients/web/src/design/tokens.css b/clients/web/src/design/tokens.css",
  "--- a/clients/web/src/design/tokens.css",
  "+++ b/clients/web/src/design/tokens.css",
  "@@ -207,6 +207,22 @@",
  "   --scrim: light-dark(rgb(36 33 28 / 0.24), rgb(9 8 11 / 0.62));",
  "+  --layer-content-float: 100;",
  "+  --layer-overlay-scrim: 200;",
  "+  --layer-overlay-surface: 300;",
  ...Array.from(
    { length: 30 },
    (_, i) => `+  /* 겹침 층 주석 ${i + 1} — 이름을 쓰지 않은 잔량은 자기 상자 안에 산다 */`
  ),
  "diff --git a/clients/web/src/features/timeline/UnreadPill.tsx b/clients/web/src/features/timeline/UnreadPill.tsx",
  "--- a/clients/web/src/features/timeline/UnreadPill.tsx",
  "+++ b/clients/web/src/features/timeline/UnreadPill.tsx",
  "@@ -60,7 +60,7 @@",
  '-        "pointer-events-none absolute inset-x-0 z-10 flex justify-center",',
  '+        "pointer-events-none absolute inset-x-0 layer-content-float flex justify-center",',
  ...Array.from({ length: 30 }, (_, i) => `   문맥 줄 ${i + 1} context line`),
].join("\n");

const DIFF_MESSAGE_ID = "capture-overlay-diff";

// An http URL is what makes the client ask for unfurls, which is the only way
// the 「링크 미리보기 제거」 X reaches a frame (R1 M-3 had no fixture for it).
const UNFURL_MESSAGE_ID = "capture-overlay-unfurl";
const LINK_BODY =
  "배포 회고 문서 올려뒀습니다: https://oort.example/retro/2026-09 — 월요일 전에 한 번씩 읽어 주세요.";
const UNFURLS = [
  {
    id: "capture-overlay-unfurl-1",
    messageId: UNFURL_MESSAGE_ID,
    url: "https://oort.example/retro/2026-09",
    status: "ok",
    title: "2026년 9월 배포 회고",
    description: "relay outbox 지연과 야간 소크 결과를 한 장에 모았습니다.",
    domain: "oort.example",
  },
];

function makeMessages(count) {
  const base = NOW - count * 60_000;
  const out = Array.from({ length: count }, (_, i) => ({
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
  out[count - 7] = { ...out[count - 7], id: DIFF_MESSAGE_ID, body: DIFF_BODY };
  // Far enough from the live end that the row above it can be parked at the
  // top of the scrollport — which is the only position where a hover toolbar
  // flips to `straddle-below` and drops into the unfurl row's band.
  out[count - 20] = { ...out[count - 20], id: UNFURL_MESSAGE_ID, body: LINK_BODY };
  return out;
}

const MESSAGES = makeMessages(40);

const HOST_ID = "019f9a01-0000-7000-8000-000000000900";
const WORK_HOSTS = [
  {
    id: HOST_ID,
    workspaceId: WORKSPACE_ID,
    scope: "workspace",
    ownerMemberId: ME,
    type: "app",
    displayName: "개발실 Mac mini",
    capabilities: { terminal: true },
    createdAtMs: NOW - 90 * 86_400_000,
    online: true,
  },
];

/** One running session: enough for the ADE summary line to exist and open. */
const WORK_SESSIONS = [
  {
    id: "019f9a01-0000-7000-8000-000000000901",
    workspaceId: WORKSPACE_ID,
    channelId: GENERAL_ID,
    memberId: ME,
    hostId: HOST_ID,
    rootMessageId: MESSAGES[0].id,
    tool: "codex",
    label: "야간 회귀 스위트 재실행",
    status: "running",
    observation: "open",
    observerGrantCount: 0,
    remoteAttachAvailable: false,
    remoteDisplayAvailable: false,
    startedAtMs: NOW - 192_000,
  },
];

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

async function installRoutes(context, { work = false } = {}) {
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
    // Before the generic /messages arm: the unfurl read hangs off a message.
    if (path.endsWith("/unfurls")) {
      const id = path.split("/messages/")[1]?.replace("/unfurls", "") ?? "";
      return json(route, {
        unfurls: id.toLowerCase() === UNFURL_MESSAGE_ID ? UNFURLS : [],
      });
    }
    if (path.includes("/messages")) {
      return json(route, { messages: MESSAGES });
    }
    if (path.endsWith("/work-hosts")) {
      return json(route, { workHosts: work ? WORK_HOSTS : [] });
    }
    if (path.endsWith("/work-sessions")) {
      return json(route, { workSessions: work ? WORK_SESSIONS : [] });
    }
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

/**
 * The stacking-context resolver the root sweep needs.
 *
 * `z-index` is only ever compared inside ONE stacking context, so "is this
 * leftover local?" is not a question about the class — it is a question about
 * which ancestor owns the comparison. This walks up for the first ancestor
 * that creates a context (positioned+z, fixed/sticky, opacity, transform,
 * filter, isolation, mix-blend, backdrop-filter, contain, will-change) and
 * reports it. Ported from the #2485 R1 probe that caught B-2.
 */
const PAGE_HELPERS = () => {
  window.__layerProbe = {
    creates(el) {
      if (el === document.documentElement) return true;
      const cs = getComputedStyle(el);
      if (cs.position !== "static" && cs.zIndex !== "auto") return true;
      if (cs.position === "fixed" || cs.position === "sticky") return true;
      if (Number.parseFloat(cs.opacity) < 1) return true;
      if (cs.transform !== "none" || cs.filter !== "none") return true;
      if (cs.perspective !== "none") return true;
      if (cs.isolation === "isolate" || cs.mixBlendMode !== "normal") return true;
      if (cs.backdropFilter && cs.backdropFilter !== "none") return true;
      if (cs.contain && /paint|layout|strict|content/.test(cs.contain)) return true;
      if (cs.willChange && /transform|opacity|filter/.test(cs.willChange)) {
        return true;
      }
      return false;
    },
    root(el) {
      let parent = el.parentElement;
      while (parent) {
        if (window.__layerProbe.creates(parent)) return parent;
        parent = parent.parentElement;
      }
      return document.documentElement;
    },
    label(el) {
      if (!el) return "NONE";
      const cls =
        typeof el.className === "string" ? el.className : el.className?.baseVal || "";
      const tid =
        el.getAttribute?.("data-testid") ||
        el.closest?.("[data-testid]")?.getAttribute("data-testid") ||
        "";
      const short = cls.split(/\s+/).filter(Boolean).slice(0, 5).join(" ");
      return `<${el.tagName.toLowerCase()}> testid=${tid || "—"} class="${short}"`;
    },
    rect(el) {
      const r = el.getBoundingClientRect();
      return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
    },
  };
};

async function login(page) {
  await page.goto(page.__origin ?? ORIGIN, { waitUntil: "domcontentloaded" });
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
    // Repeat rather than assume: with a tall artifact row in the window,
    // virtuoso keeps re-measuring and one assignment does not land at 0.
    for (let attempt = 0; attempt < 10 && scroller.scrollTop > 0; attempt++) {
      scroller.scrollTop = 0;
      for (let i = 0; i < 12; i++) await frame();
    }
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

/** Exactly the #2485 R1 state: the sticky filename back at the document root. */
async function sabotageArtifactRootZ(page) {
  await page.addStyleTag({
    content: '[data-testid="artifact-diff-file"] { isolation: auto !important; }',
  });
}

/** Exactly the #2485 R1 B-1 state: the body-portalled tray back under the pane. */
async function sabotageTray(page) {
  await page.addStyleTag({
    content:
      ".composer-format-tray { z-index: var(--layer-content-float) !important; }",
  });
}

async function applySabotage(page) {
  if (SABOTAGE === "unread-pill") await sabotageUnreadPill(page);
  if (SABOTAGE === "scrim") await sabotageScrim(page);
  if (SABOTAGE === "artifact-root-z") await sabotageArtifactRootZ(page);
  if (SABOTAGE === "tray-content-float") await sabotageTray(page);
}

/** Collected red evidence when a sabotage mode is running. */
const redProofs = [];

/**
 * The property H-2 asked for, measured rather than spelled.
 *
 * Every element that resolves a NUMERIC z-index is asked which stacking
 * context owns it. Anything that resolves in the document's own root and is
 * not one of the named layer values is competing with every overlay in the
 * app — whatever its class says and whatever file it lives in.
 */
async function rootSweep(page) {
  return page.evaluate((names) => {
    const rootStyle = getComputedStyle(document.documentElement);
    const named = new Set(
      names
        .map((name) => Number.parseInt(rootStyle.getPropertyValue(name), 10))
        .filter((value) => Number.isFinite(value))
    );
    const rows = [];
    for (const el of document.querySelectorAll("*")) {
      const cs = getComputedStyle(el);
      if (cs.zIndex === "auto") continue;
      const z = Number.parseInt(cs.zIndex, 10);
      if (!Number.isFinite(z)) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const root = window.__layerProbe.root(el);
      rows.push({
        z,
        atRoot: root === document.documentElement || root === document.body,
        named: named.has(z),
        label: window.__layerProbe.label(el),
        rootLabel: window.__layerProbe.label(root),
        rect: window.__layerProbe.rect(el),
        layer: el.getAttribute("data-overlay-layer") || "",
      });
    }
    rows.sort((a, b) => b.z - a.z);
    return { named: [...named].sort((a, b) => a - b), rows };
  }, LAYER_NAMES);
}

const SWEEP_MODES = new Set(["unread-pill", "artifact-root-z"]);

/**
 * @returns {Promise<string>} the one-line result, already printed.
 */
async function assertRootSweep(page, label) {
  const sweep = await rootSweep(page);
  const violations = sweep.rows.filter((row) => row.atRoot && !row.named);
  const line =
    `  root sweep ${label}: named=[${sweep.named.join(",")}] ` +
    `numeric=${sweep.rows.length} outside-the-scale-at-root=${violations.length}`;
  console.log(line);
  for (const row of violations) {
    console.log(`    z=${row.z} rect=${row.rect.join(",")} ${row.label}`);
  }
  if (violations.length > 0) {
    if (SWEEP_MODES.has(SABOTAGE)) {
      redProofs.push(
        `${label}: ${violations
          .map((row) => `z=${row.z} ${row.label}`)
          .join(" ; ")}`
      );
      return line;
    }
    throw new Error(
      `${label}: ${violations.length} element(s) resolve a numeric z-index in ` +
        `the document root outside the named scale — ` +
        violations.map((row) => `z=${row.z} ${row.label}`).join(" ; ")
    );
  }
  return line;
}

/** Hover a row that is wholly inside the band, without moving the timeline. */
async function hoverVisibleRow(page) {
  const index = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-testid="timeline-message"]')];
    const h = window.innerHeight;
    // A short row, wholly on screen, as close to the upper third as the
    // current scroll position allows. Short, because the diff artifact's own
    // row is taller than the viewport and its toolbar sits off screen.
    let best = -1;
    let bestScore = Infinity;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (r.height < 8 || r.height > 220) continue;
      if (r.top < 72 || r.bottom > h - 72) continue;
      const score = Math.abs(r.top - h * 0.35);
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return best;
  });
  if (index < 0) return -1;
  await page.getByTestId("timeline-message").nth(index).hover({ force: true });
  await page.waitForTimeout(250);
  return index;
}

/** Scroll to the live end first, then hover. */
async function hoverMidRow(page) {
  await page.evaluate(async () => {
    const frame = () =>
      new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const scroller = document.querySelector("[data-virtuoso-scroller]");
    if (!scroller) return;
    scroller.scrollTop = scroller.scrollHeight;
    for (let i = 0; i < 18; i++) await frame();
  });
  await page.waitForTimeout(300);
  return hoverVisibleRow(page);
}

/**
 * Park the diff artifact so its sticky filename is actually **stuck**.
 *
 * The bar is `sticky top-0` inside the card's own scrolling body
 * (`max-h-diff-body overflow-y-auto`), not inside the timeline, so it only
 * pins once that body is scrolled. A frame taken with the body at scrollTop 0
 * measures a bar that is merely sitting at the top of its card and proves
 * nothing about stacking. Two moves, then: bring the body under the overlay
 * band, and scroll it so the bar pins.
 */
async function scrollToArtifact(page) {
  const landed = await page.evaluate(async () => {
    const frame = () =>
      new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const settle = async (n = 10) => {
      for (let i = 0; i < n; i++) await frame();
    };
    const scroller =
      document.querySelector("[data-virtuoso-scroller]") ||
      document.querySelector('[data-testid="timeline-virtuoso"]');
    if (!scroller) return { ok: false, why: "no timeline scroller" };
    const details = () =>
      document.querySelector('[data-testid="artifact-diff-file"]');
    scroller.scrollTop = scroller.scrollHeight;
    await settle(18);
    for (let attempt = 0; attempt < 14 && !details(); attempt++) {
      scroller.scrollTop = Math.max(0, scroller.scrollTop - 500);
      await settle(8);
    }
    if (!details()) return { ok: false, why: "diff artifact never mounted" };
    const scrollParent = (node) => {
      let el = node.parentElement;
      while (el) {
        const overflow = getComputedStyle(el).overflowY;
        if (overflow === "auto" || overflow === "scroll") return el;
        el = el.parentElement;
      }
      return null;
    };
    const body = scrollParent(details());
    if (!body) return { ok: false, why: "diff body scrollport not found" };
    // Bring the card body just under the top of the timeline scrollport.
    for (let attempt = 0; attempt < 14; attempt++) {
      const b = body.getBoundingClientRect();
      const port = scroller.getBoundingClientRect();
      const delta = b.top - (port.top + 24);
      if (Math.abs(delta) < 16) break;
      scroller.scrollTop += delta;
      await settle(8);
    }
    // And scroll the body so the first file's name pins to its top edge.
    body.scrollTop = Math.min(160, Math.max(0, body.scrollHeight - body.clientHeight));
    await settle(12);
    const summary = details()?.querySelector(":scope > summary");
    if (!summary) return { ok: false, why: "summary gone" };
    const r = summary.getBoundingClientRect();
    const b = body.getBoundingClientRect();
    return {
      ok: r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight,
      stuck: Math.abs(r.top - b.top) < 4,
      summary: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      bodyScrollTop: Math.round(body.scrollTop),
    };
  });
  if (!landed?.ok) {
    throw new Error(
      `the diff artifact's sticky filename never reached the fold: ${JSON.stringify(landed)}`
    );
  }
  console.log(
    `  artifact parked: summary rect=${landed.summary.join(",")} ` +
      `stuck=${landed.stuck} bodyScrollTop=${landed.bodyScrollTop}`
  );
  return landed;
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
  await applySabotage(page);
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
  if (SABOTAGE === "scrim") {
    console.log(`  elementFromPoint ${kind} pill: ${describeHit(pillHit)}`);
    console.log(`  elementFromPoint ${kind} toolbar: ${describeHit(toolbarHit)}`);
    console.log(`  elementFromPoint ${kind} arbitrary: ${describeHit(arbitraryHit)}`);
    const pillRed = !pillHit.overlay;
    const arbitraryRed = !arbitraryHit.overlay;
    if (arbitraryRed) {
      redProofs.push(
        `${kind} arbitrary: ${describeHit(arbitraryHit)} (scrim layer reverted)`
      );
      lines.push(
        expectOverlay(arbitraryHit, `${kind} arbitrary`, { invert: true })
      );
    } else if (pillRed) {
      console.log(
        `  RED proof ${kind} pill: timeline float won after scrim layer revert; empty arbitrary still overlay (fixed+blur stacking)`
      );
      redProofs.push(
        `${kind} pill: ${describeHit(pillHit)} (scrim layer reverted)`
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

  if (SABOTAGE !== "scrim") lines.push(await assertRootSweep(page, kind));

  if (clickPillClosesPalette) {
    const before = await hitAt(page, coords.pill.x, coords.pill.y);
    console.log(`  palette click target: ${describeHit(before)}`);
    await page.mouse.click(coords.pill.x, coords.pill.y);
    const still = await page.getByTestId("quick-switcher").isVisible();
    const focused = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="quick-switcher"]');
      return Boolean(root && root.contains(document.activeElement));
    });
    if (before.overlayLayer === "surface") {
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
  // Hover a row that is actually on screen at the current scroll position, and
  // scope the trigger to it: the timeline is parked on the diff artifact here,
  // and more than one row can carry a mounted toolbar.
  const index = await hoverVisibleRow(page);
  if (index < 0) throw new Error("no timeline row in the hover band");
  const row = page.getByTestId("timeline-message").nth(index);
  await row.getByTestId("message-actions-trigger").click({ force: true });
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
  const { work = false, origin = ORIGIN, ...contextOpts } = opts;
  const context = await browser.newContext({
    reducedMotion: "reduce",
    ...contextOpts,
  });
  const page = await context.newPage();
  page.__origin = origin;
  await page.addInitScript(PAGE_HELPERS);
  await installRealtimeSocket(page);
  await installRoutes(context, { work });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  try {
    await login(page);
    const value = await fn(page);
    if (pageErrors.length > 0) {
      throw new Error(`page errors: ${pageErrors.join(" | ")}`);
    }
    return value;
  } finally {
    await context.close();
  }
}

// =============================================================================
// Scenes (#2485 R2). Each one is a frame R1 had to build by hand, or could not
// build at all, brought into the lane so the next run measures it.
// =============================================================================

/** Path for a committed frame. */
function shot(name) {
  return resolve(OUT_DIR, `${name}.png`);
}

async function capture(page, name, clip) {
  const path = shot(name);
  let box = clip;
  if (box) {
    const view = page.viewportSize() ?? { width: 1280, height: 800 };
    const x = Math.max(0, Math.min(box.x, view.width - 8));
    const y = Math.max(0, Math.min(box.y, view.height - 8));
    box = {
      x,
      y,
      width: Math.max(8, Math.min(box.width, view.width - x)),
      height: Math.max(8, Math.min(box.height, view.height - y)),
    };
  }
  await page.screenshot(box ? { path, clip: box } : { path });
  console.log(`  shot ${path}`);
  return path;
}

/**
 * B-1 — the thread composer's own formatting toolbar, under 900px.
 *
 * The tray portals to `document.body`, so no pane can contain it; under 900px
 * the thread panel is an overlay drawer. If the tray sits on content-float it
 * is painted beneath the panel that holds its own textarea, and a `role=
 * "toolbar"` with a roving tab stop survives where the pointer cannot reach it.
 */
async function sceneThreadTray(page, tag) {
  const row = await hoverMidRow(page);
  if (row < 0) throw new Error(`thread tray ${tag}: no row in the hover band`);
  const reply = page.getByTestId("toolbar-reply");
  await reply.first().waitFor({ state: "visible", timeout: 10_000 });
  await reply.first().click({ force: true });
  await page.getByTestId("thread-panel").waitFor({ state: "visible", timeout: 10_000 });
  const input = page.getByTestId("thread-composer-input");
  await input.click();
  await input.fill("배포 일정 확인 부탁드립니다 deploy window");
  await page.waitForTimeout(150);
  await applySabotage(page);
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="thread-composer-input"]');
    el.focus();
    el.setSelectionRange(0, 8);
    el.dispatchEvent(new Event("select", { bubbles: true }));
    document.dispatchEvent(new Event("selectionchange"));
  });
  await page.waitForTimeout(600);
  const measured = await page.evaluate(() => {
    const tray = document.querySelector('[data-testid="thread-composer-format-tray"]');
    if (!tray) return { present: false };
    const pane = document.querySelector('[data-testid="thread-panel"]');
    const box = tray.getBoundingClientRect();
    const at = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    const bold = tray.querySelector("button");
    const bb = bold?.getBoundingClientRect();
    const atBold = bb
      ? document.elementFromPoint(bb.x + bb.width / 2, bb.y + bb.height / 2)
      : null;
    const inTray = (el) =>
      Boolean(el?.closest('[data-testid="thread-composer-format-tray"]'));
    return {
      present: true,
      trayZ: getComputedStyle(tray).zIndex,
      paneZ: pane ? getComputedStyle(pane).zIndex : null,
      trayRoot: window.__layerProbe.label(window.__layerProbe.root(tray)),
      rect: window.__layerProbe.rect(tray),
      hit: window.__layerProbe.label(at),
      hitIsTray: inTray(at),
      hitBold: window.__layerProbe.label(atBold),
      boldReachable: inTray(atBold),
    };
  });
  const line =
    `  thread tray ${tag}: present=${measured.present} z=${measured.trayZ} ` +
    `paneZ=${measured.paneZ} hitIsTray=${measured.hitIsTray} ` +
    `boldReachable=${measured.boldReachable}`;
  console.log(line);
  if (measured.rect) console.log(`    tray rect=${measured.rect.join(",")} root=${measured.trayRoot}`);
  await capture(page, `thread-tray-${tag}`);
  if (measured.rect) {
    await capture(page, `thread-tray-crop-${tag}`, {
      x: Math.max(0, measured.rect[0] - 24),
      y: Math.max(0, measured.rect[1] - 24),
      width: 320,
      height: 130,
    });
  }
  const green = measured.present && measured.hitIsTray && measured.boldReachable;
  if (!green) {
    if (SABOTAGE === "tray-content-float") {
      redProofs.push(line.trim());
      return line;
    }
    throw new Error(
      `thread tray ${tag}: the formatting toolbar is not reachable — ${JSON.stringify(measured)}`
    );
  }
  if (SABOTAGE === "tray-content-float") {
    throw new Error(
      `SABOTAGE tray-content-float expected RED at ${tag} but the tray still won`
    );
  }
  return line;
}

/**
 * Both halves of B-2 in one shape: an overlay opens over the diff artifact and
 * the sticky filename must not be painted across it.
 */
async function sceneArtifactUnderOverlay(page, tag, kind) {
  await scrollToArtifact(page);
  if (kind === "palette") {
    await openPalette(page);
  } else {
    await openDrawer(page);
    await page.getByTestId("sidebar").waitFor({ state: "visible" });
  }
  await applySabotage(page);
  await page.waitForTimeout(200);
  const panelTestId = kind === "palette" ? "quick-switcher" : "sidebar";
  const measured = await page.evaluate((panelTestId) => {
    const summary = document.querySelector('[data-testid="artifact-diff-file"] > summary');
    const panel = document.querySelector(`[data-testid="${panelTestId}"]`);
    if (!summary || !panel) return null;
    const s = summary.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    const y = Math.round(s.y + s.height / 2);
    const inside = y > p.y + 4 && y < p.y + p.height - 4;
    const xs = [
      Math.round(p.x + 20),
      Math.round(p.x + p.width / 2),
      Math.round(p.x + p.width - 20),
    ];
    return {
      summaryZ: getComputedStyle(summary).zIndex,
      summaryRoot: window.__layerProbe.label(window.__layerProbe.root(summary)),
      summaryRect: window.__layerProbe.rect(summary),
      panelZ: getComputedStyle(panel).zIndex,
      panelRect: window.__layerProbe.rect(panel),
      rowCrossesPanel: inside,
      points: xs.map((x) => {
        const el = document.elementFromPoint(x, y);
        return {
          x,
          y,
          el: window.__layerProbe.label(el),
          isSummary: Boolean(
            el?.closest('[data-testid="artifact-diff-file"] > summary')
          ),
          isOverlay: Boolean(el?.closest("[data-overlay-layer]")),
        };
      }),
    };
  }, panelTestId);
  if (!measured) throw new Error(`artifact-under-${kind} ${tag}: scene did not form`);
  const stolen = measured.points.filter((point) => point.isSummary);
  const line =
    `  artifact under ${kind} ${tag}: summary z=${measured.summaryZ} ` +
    `root=${measured.summaryRoot} panel z=${measured.panelZ} ` +
    `rowCrossesPanel=${measured.rowCrossesPanel} stolen=${stolen.length}/3`;
  console.log(line);
  for (const point of measured.points) {
    console.log(`    (${point.x},${point.y}) ${point.el}`);
  }
  await capture(page, `artifact-under-${kind}-${tag}`);
  await capture(page, `artifact-under-${kind}-crop-${tag}`, {
    x: Math.max(0, measured.summaryRect[0] - 20),
    y: Math.max(0, measured.summaryRect[1] - 40),
    width: Math.min(
      page.viewportSize().width - Math.max(0, measured.summaryRect[0] - 20),
      measured.summaryRect[2] + 60
    ),
    height: 120,
  });
  if (stolen.length > 0) {
    throw new Error(
      `artifact-under-${kind} ${tag}: the sticky filename is painted across the ` +
        `${kind} at ${stolen.map((p) => `(${p.x},${p.y})`).join(" ")}`
    );
  }
  if (!measured.rowCrossesPanel) {
    console.log(
      `    note: the summary row does not cross the ${kind} panel band here, ` +
        `so only the root sweep is load bearing in this frame`
    );
  }
  return line;
}

/**
 * M-1 — can the sidebar drawer and the ADE drawer stand together?
 *
 * R1 read the two utilities statically, saw one value where there used to be
 * two, and asked for the scene. Here it is, and the answer is that the scene
 * does not exist: opening the 관제 서랍 covers the route region **and marks it
 * `inert`**, and the 채널 목록 열기 trigger lives inside that region. The
 * second drawer is not merely hard to reach — the click does nothing.
 *
 * This is written as a guard, not as a note. If a later change unhooks that
 * `inert` coupling and the sidebar drawer does open, this asserts the order
 * the old two-value comment was protecting: the sidebar drawer, and the scrim
 * it brings, must be above the ADE drawer. Equal values would fail here.
 */
async function sceneTwoDrawers(page, tag) {
  const summary = page.getByTestId("ade-summary");
  await summary.waitFor({ state: "visible", timeout: 15_000 });
  await summary.click({ force: true });
  await page.getByTestId("ade-drawer").waitFor({ state: "visible", timeout: 10_000 });
  await applySabotage(page);
  await page.waitForTimeout(250);

  const gate = await page.evaluate(() => {
    const trigger = document.querySelector('[data-testid="open-sidebar-drawer"]');
    if (!trigger) return { trigger: false };
    const r = trigger.getBoundingClientRect();
    const inert = trigger.closest("[inert]");
    return {
      trigger: true,
      inert: Boolean(inert),
      inertLabel: window.__layerProbe.label(inert),
      covered: window.__layerProbe.label(
        document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      ),
    };
  });
  // Ask for the second drawer anyway, with the actionability checks off, so
  // the claim is 「it does not open」 and not 「we did not try」.
  await page.getByTestId("open-sidebar-drawer").click({ force: true });
  await page.waitForTimeout(600);
  const bothOpen = await page
    .getByTestId("sidebar-scrim")
    .isVisible()
    .catch(() => false);

  const measured = await page.evaluate(() => {
    const pick = (id) => document.querySelector(`[data-testid="${id}"]`);
    const read = (el) =>
      el && {
        z: getComputedStyle(el).zIndex,
        rect: window.__layerProbe.rect(el),
        root: window.__layerProbe.label(window.__layerProbe.root(el)),
      };
    return {
      ade: read(pick("ade-drawer")),
      adeScrim: read(pick("ade-scrim")),
      sidebar: read(pick("sidebar")),
      sidebarScrim: read(pick("sidebar-scrim")),
      panes: ["thread-panel", "work-pane", "work-panel"]
        .map((id) => [id, read(pick(id))])
        .filter(([, value]) => value),
    };
  });
  const line =
    `  two drawers ${tag}: ade z=${measured.ade?.z} adeScrim z=${measured.adeScrim?.z} ` +
    `sidebarTriggerInert=${gate.inert} coveredBy=${gate.covered} ` +
    `sidebarDrawerOpened=${bothOpen}`;
  console.log(line);
  await capture(page, `two-drawers-${tag}`);

  if (!gate.trigger) {
    throw new Error(`two-drawers ${tag}: the sidebar drawer trigger is not on this surface`);
  }
  if (!bothOpen) {
    if (!gate.inert) {
      throw new Error(
        `two-drawers ${tag}: the sidebar drawer did not open and the route region is ` +
          `not inert either — the reason the two never coexist is no longer measured`
      );
    }
    return line;
  }
  // They DID coexist. Then the order has to be real.
  const adeZ = Number.parseInt(measured.ade.z, 10);
  const sidebarZ = Number.parseInt(measured.sidebar.z, 10);
  const scrimZ = Number.parseInt(measured.sidebarScrim.z, 10);
  if (!(sidebarZ > adeZ && scrimZ > adeZ)) {
    throw new Error(
      `two-drawers ${tag}: both drawers are open and the sidebar drawer ` +
        `(z=${sidebarZ}, scrim z=${scrimZ}) does not stand above the ADE drawer ` +
        `(z=${adeZ}) — DOM order is deciding`
    );
  }
  return line;
}

/**
 * M-3 — the unfurl X and a hover toolbar that straddles below into its row.
 *
 * R1 flagged the reversal from code order alone (「no pixel claim」), because
 * the capture mock served no unfurl. It does now, and the scene is built the
 * only way the reversal can happen: `hover-toolbar-straddle-below` turns on
 * when a row's toolbar would be clipped by the top of the scrollport, so the
 * hovered row is parked at that top edge and the unfurl card is the row under
 * the toolbar it drops.
 *
 * Two things are measured, because either alone is weak. The natural
 * geometry — do they ever touch — and, with the toolbar forced over the X, who
 * wins when they do. Geometry alone would silently become false at a width
 * nobody captured; the forced overlap is the order itself.
 */
async function sceneUnfurlToolbar(page, tag) {
  const parked = await page.evaluate(async () => {
    const frame = () =>
      new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const settle = async (n = 10) => {
      for (let i = 0; i < n; i++) await frame();
    };
    const scroller = document.querySelector("[data-virtuoso-scroller]");
    if (!scroller) return { ok: false, why: "no scroller" };
    scroller.scrollTop = scroller.scrollHeight;
    await settle(20);
    const unfurlRow = () =>
      document
        .querySelector('[data-testid="unfurl-group"]')
        ?.closest('[data-testid="timeline-message"]');
    for (let attempt = 0; attempt < 20 && !unfurlRow(); attempt++) {
      scroller.scrollTop = Math.max(0, scroller.scrollTop - 400);
      await settle(8);
    }
    if (!unfurlRow()) return { ok: false, why: "no unfurl row" };
    const rows = () => [...document.querySelectorAll('[data-testid="timeline-message"]')];
    const prev = () => rows()[rows().indexOf(unfurlRow()) - 1];
    // Virtuoso may have mounted the unfurl row as the first one in the window;
    // scroll a little further up so the row above it exists to be hovered.
    for (let attempt = 0; attempt < 10 && !prev(); attempt++) {
      scroller.scrollTop = Math.max(0, scroller.scrollTop - 260);
      await settle(8);
    }
    if (!prev()) return { ok: false, why: "no row above the unfurl" };
    // Park the row ABOVE the unfurl at the very top of the scrollport: that is
    // the only position where its toolbar flips to straddle-below.
    for (let attempt = 0; attempt < 14; attempt++) {
      const r = prev().getBoundingClientRect();
      const port = scroller.getBoundingClientRect();
      const delta = r.top - (port.top + 2);
      if (Math.abs(delta) < 6) break;
      scroller.scrollTop += delta;
      await settle(8);
    }
    await settle(10);
    const r = prev().getBoundingClientRect();
    return {
      ok: true,
      point: [Math.round(r.x + r.width / 2), Math.round(r.top + 6)],
    };
  });
  if (!parked.ok) throw new Error(`unfurl-toolbar ${tag}: ${parked.why}`);
  // `locator.hover()` scrolls the element into view and would undo the park,
  // so the pointer is moved by coordinate instead.
  await page.mouse.move(parked.point[0], parked.point[1]);
  await applySabotage(page);
  await page.waitForTimeout(400);

  const measured = await page.evaluate(() => {
    const x = document.querySelector('[data-testid="unfurl-remove"]');
    const toolbar = document.querySelector('[data-testid="message-hover-toolbar"]');
    if (!x || !toolbar) return null;
    const xr = x.getBoundingClientRect();
    const tr = toolbar.getBoundingClientRect();
    const overlaps =
      Math.max(xr.x, tr.x) < Math.min(xr.right, tr.right) &&
      Math.max(xr.y, tr.y) < Math.min(xr.bottom, tr.bottom);
    const at = document.elementFromPoint(xr.x + xr.width / 2, xr.y + xr.height / 2);
    return {
      xZ: getComputedStyle(x).zIndex,
      xRect: window.__layerProbe.rect(x),
      xRoot: window.__layerProbe.label(window.__layerProbe.root(x)),
      toolbarZ: getComputedStyle(toolbar).zIndex,
      toolbarRect: window.__layerProbe.rect(toolbar),
      toolbarRoot: window.__layerProbe.label(window.__layerProbe.root(toolbar)),
      straddle: toolbar.getAttribute("data-straddle"),
      overlaps,
      xReachable: Boolean(at?.closest('[data-testid="unfurl-remove"]')),
    };
  });
  if (!measured) throw new Error(`unfurl-toolbar ${tag}: scene did not form`);
  await capture(page, `unfurl-toolbar-${tag}`);
  await capture(page, `unfurl-toolbar-crop-${tag}`, {
    x: Math.max(0, measured.xRect[0] - 40),
    y: Math.max(0, Math.min(measured.xRect[1], measured.toolbarRect[1]) - 30),
    width: Math.max(220, measured.toolbarRect[0] + measured.toolbarRect[2] - measured.xRect[0] + 80),
    height: 150,
  });

  // Now force the overlap the geometry never produces and read the winner.
  const forced = await page.evaluate(() => {
    const x = document.querySelector('[data-testid="unfurl-remove"]');
    const toolbar = document.querySelector('[data-testid="message-hover-toolbar"]');
    const xr = x.getBoundingClientRect();
    const style = document.createElement("style");
    style.textContent =
      `[data-testid="message-hover-toolbar"]{right:auto !important;` +
      `left:${Math.round(xr.x - 40)}px !important;top:${Math.round(xr.y - 2)}px !important;` +
      `bottom:auto !important;translate:none !important;position:fixed !important;}`;
    document.head.append(style);
    const tr = toolbar.getBoundingClientRect();
    const overlaps =
      Math.max(xr.x, tr.x) < Math.min(xr.right, tr.right) &&
      Math.max(xr.y, tr.y) < Math.min(xr.bottom, tr.bottom);
    const at = document.elementFromPoint(xr.x + xr.width / 2, xr.y + xr.height / 2);
    style.remove();
    return {
      overlaps,
      winner: window.__layerProbe.label(at),
      toolbarWins: Boolean(at?.closest('[data-testid="message-hover-toolbar"]')),
    };
  });

  const line =
    `  unfurl X vs hover toolbar ${tag}: X z=${measured.xZ} root=${measured.xRoot} ` +
    `rect=${measured.xRect.join(",")} · toolbar z=${measured.toolbarZ} ` +
    `straddle=${measured.straddle} rect=${measured.toolbarRect.join(",")} · ` +
    `naturalOverlap=${measured.overlaps} forcedOverlap=${forced.overlaps} ` +
    `toolbarWinsWhenForced=${forced.toolbarWins}`;
  console.log(line);
  console.log(`    forced winner: ${forced.winner}`);

  if (measured.straddle !== "below") {
    throw new Error(
      `unfurl-toolbar ${tag}: the toolbar did not straddle below, so the ` +
        `reversal R1 described was never on screen (straddle=${measured.straddle})`
    );
  }
  if (measured.overlaps) {
    throw new Error(
      `unfurl-toolbar ${tag}: the toolbar and the unfurl X overlap in normal ` +
        `geometry — the 「never touch」 reading is no longer true`
    );
  }
  if (!forced.overlaps || !forced.toolbarWins) {
    throw new Error(
      `unfurl-toolbar ${tag}: forced over the unfurl X, the hover toolbar does ` +
        `not win — ${JSON.stringify(forced)}`
    );
  }
  return line;
}

const DESKTOP = { width: 1280, height: 800 };
const NARROW = { width: 880, height: 800 };
const PHONE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent: IPHONE_UA,
};

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
          { viewport: DESKTOP, colorScheme: "light" },
          async (page) => {
            lines.push(
              ...(await probeKind(page, "palette", () => openPalette(page), {
                clickPillClosesPalette: SABOTAGE !== "scrim",
              }))
            );
          }
        );
      } else if (SABOTAGE === "artifact-root-z") {
        console.log(`## desktop 1280 light (sabotage=${SABOTAGE})`);
        await withPage(
          browser,
          { viewport: DESKTOP, colorScheme: "light" },
          async (page) => {
            await scrollToArtifact(page);
            lines.push(...(await probeKind(page, "palette", () => openPalette(page))));
          }
        );
      } else if (SABOTAGE === "tray-content-float") {
        console.log(`## narrow 880 light (sabotage=${SABOTAGE})`);
        await withPage(
          browser,
          { viewport: NARROW, colorScheme: "light" },
          async (page) => {
            lines.push(await sceneThreadTray(page, "880-light"));
          }
        );
      } else {
        // ---- hit tests, five overlay kinds, both schemes ------------------
        console.log("## desktop 1280 light");
        await withPage(
          browser,
          { viewport: DESKTOP, colorScheme: "light" },
          async (page) => {
            // The diff artifact on screen is what makes the root sweep inside
            // probeKind load bearing: an off-screen leftover has a zero box.
            await scrollToArtifact(page);
            lines.push(...(await probeKind(page, "dialog", () => openDialog(page))));
            await page.keyboard.press("Escape");
            await page.getByTestId("delete-message-dialog").waitFor({ state: "hidden" });
            lines.push(...(await probeKind(page, "popover", () => openPopover(page))));
            await page.keyboard.press("Escape");
            lines.push(
              ...(await probeKind(page, "palette", () => openPalette(page), {
                clickPillClosesPalette: true,
              }))
            );
            await page.keyboard.press("Escape");
            await openDialog(page);
            await capture(page, "dialog-light-1280");
          }
        );

        console.log("## mobile 390 dark");
        await withPage(browser, { ...PHONE, colorScheme: "dark" }, async (page) => {
          lines.push(
            ...(await probeKind(page, "action-sheet", () => openActionSheet(page)))
          );
          await page.keyboard.press("Escape");
          await page.getByTestId("message-action-sheet").waitFor({ state: "hidden" });
          lines.push(...(await probeKind(page, "drawer", () => openDrawer(page))));
          await page.keyboard.press("Escape");
          await openActionSheet(page);
          await capture(page, "mobile-b11-action-sheet-dark");
        });

        // ---- B-1: the thread composer's formatting toolbar under 900px ----
        for (const scheme of ["light", "dark"]) {
          console.log(`## thread format tray 880 ${scheme} (R1 B-1)`);
          await withPage(
            browser,
            { viewport: NARROW, colorScheme: scheme },
            async (page) => {
              lines.push(await sceneThreadTray(page, `880-${scheme}`));
            }
          );
        }

        // ---- B-2: the sticky filename under an overlay --------------------
        console.log("## artifact under ⌘K palette 1280 light (R1 B-2)");
        await withPage(
          browser,
          { viewport: DESKTOP, colorScheme: "light" },
          async (page) => {
            lines.push(
              await sceneArtifactUnderOverlay(page, "1280-light", "palette")
            );
          }
        );
        console.log("## artifact under ⌘K palette 1280 dark (R1 B-2)");
        await withPage(
          browser,
          { viewport: DESKTOP, colorScheme: "dark" },
          async (page) => {
            lines.push(await sceneArtifactUnderOverlay(page, "1280-dark", "palette"));
          }
        );
        console.log("## artifact under sidebar drawer 390 dark (R1 B-2)");
        await withPage(browser, { ...PHONE, colorScheme: "dark" }, async (page) => {
          lines.push(await sceneArtifactUnderOverlay(page, "390-dark", "drawer"));
        });
        console.log("## artifact under sidebar drawer 390 light (R1 B-2)");
        await withPage(browser, { ...PHONE, colorScheme: "light" }, async (page) => {
          lines.push(await sceneArtifactUnderOverlay(page, "390-light", "drawer"));
        });

        // ---- M-3: the unfurl X and a straddle-below toolbar ---------------
        for (const scheme of ["light", "dark"]) {
          console.log(`## unfurl X vs hover toolbar 1280 ${scheme} (R1 M-3)`);
          await withPage(
            browser,
            { viewport: DESKTOP, colorScheme: scheme },
            async (page) => {
              lines.push(await sceneUnfurlToolbar(page, `1280-${scheme}`));
            }
          );
        }
      }
    } finally {
      await browser.close();
    }
  } finally {
    await preview.stop();
  }

  // ---- M-1: both drawers open, on the ade-gate bundle --------------------
  //
  // A production build folds the 관제 표면 away entirely, so this scene cannot
  // exist in dist/. The npm script builds the gate bundle beside it; a run
  // without that bundle fails here rather than skipping the scene quietly.
  if (!SABOTAGE) {
    if (!existsSync(resolve(ADE_DIST, "index.html"))) {
      throw new Error(
        `${ADE_DIST_REL}/ is missing. Run ` +
          `\`npm --prefix clients/web run build:ade-gate\` (the capture script does it).`
      );
    }
    const adePreview = await startGuardedPreview({
      webRoot: WEB_ROOT,
      port: ADE_PORT,
      portEnvVar: "OVERLAY_LAYER_PORT",
      extraArgs: ["--outDir", ADE_DIST_REL],
    });
    try {
      const browser = await chromium.launch();
      try {
        // The 채널 목록 열기 trigger is `mobile-only` (< 600px), so the only
        // width where a second drawer can even be asked for is the phone.
        for (const scheme of ["dark", "light"]) {
          console.log(`## two drawers 390 ${scheme} (R1 M-1)`);
          await withPage(
            browser,
            { ...PHONE, colorScheme: scheme, work: true, origin: ADE_ORIGIN },
            async (page) => {
              lines.push(await sceneTwoDrawers(page, `390-${scheme}`));
            }
          );
        }
      } finally {
        await browser.close();
      }
    } finally {
      await adePreview.stop();
    }
  }

  if (SABOTAGE) {
    if (redProofs.length === 0) {
      throw new Error(
        `SABOTAGE ${SABOTAGE}: expected a RED result and everything stayed green`
      );
    }
    console.log(`## overlay layer RED proof (${SABOTAGE}) confirmed`);
    for (const proof of redProofs) console.log(`  ${proof}`);
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
