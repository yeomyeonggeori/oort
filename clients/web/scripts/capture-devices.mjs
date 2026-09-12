#!/usr/bin/env node
// =============================================================================
// 설정 > 기기 연결된 기기 목록 캡처 (#2476).
//
// 1280 light + 390 dark: empty / two rows / disconnect confirm open.
//
//   npm run capture:devices                  # -> artifacts/design/settings-devices-*.png
//   OUT_DIR=/tmp/shots npm run capture:devices
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
const PORT = Number(process.env.CAPTURE_PORT || 5186);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
const LINKED_AT = Date.UTC(2024, 5, 15, 3, 0, 0);

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";
const GENERAL_ID = "00000000-0000-7000-8000-000000000201";
const ME = "019f94e3-7a10-79cd-9dee-208f47edd9a8";
const CURRENT_ID = "019f9b10-0000-7000-8000-000000000d01";
const OTHER_ID = "019f9b10-0000-7000-8000-000000000d02";

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
  {
    id: GENERAL_ID,
    workspaceId: WORKSPACE_ID,
    kind: "public",
    name: "general",
    muted: false,
  },
];

const TWO_ROWS = [
  {
    id: CURRENT_ID,
    label: "성재 iMac, 집 작업실",
    platform: "macos",
    linkedAt: LINKED_AT - 86_400_000,
    current: true,
  },
  {
    id: OTHER_ID,
    label: "성재 iPhone 16 Pro Max, 집 작업실 책상 옆 MagSafe 충전 거치대",
    platform: "ios",
    linkedAt: LINKED_AT - 3_600_000,
    current: false,
  },
];

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installMocks(context, devices) {
  await context.route("**/v1/**", (route) =>
    json(route, { channels: [], members: [], read_states: [], messages: [] })
  );
  await context.route("**/v1/auth/login", (route) => json(route, SESSION));
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
  await context.route("**/v1/auth/devices**", (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const tail = url.pathname.split("/devices")[1] ?? "";
    if (method === "GET" && (tail === "" || tail === "/")) {
      return json(route, { devices });
    }
    if (method === "DELETE") {
      return route.fulfill({ status: 204, body: "" });
    }
    return route.fallback();
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
    if (Date.now() > deadline) {
      throw new Error(`preview server never came up: ${url}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function openDevices(context) {
  const page = await context.newPage();
  await page.goto(ORIGIN, { waitUntil: "networkidle" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("seongjae@dawn.example");
  await page.getByTestId("login-password").fill("capture-only-not-a-credential");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-list").waitFor({ state: "visible" });
  await page.evaluate('location.hash = "/settings?section=devices"');
  await page.getByTestId("settings-route").waitFor({ state: "visible" });
  await page.getByTestId("device-link-card").waitFor({ state: "visible" });
  return page;
}

async function shoot(browser, { name, scheme, viewport, devices, drive }) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    colorScheme: scheme,
    reducedMotion: "reduce",
  });
  await installMocks(context, devices);
  const page = await openDevices(context);
  await drive(page);
  const width = viewport.width;
  const path = `${OUT_DIR}/settings-devices-${name}-${width}-${scheme}.png`;
  await page.screenshot({ path });
  await context.close();
  return path;
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
      const shots = [];
      const frames = [
        { scheme: "light", viewport: DESKTOP },
        { scheme: "dark", viewport: PHONE },
      ];
      for (const frame of frames) {
        shots.push(
          await shoot(browser, {
            ...frame,
            name: "empty",
            devices: [],
            drive: async (page) => {
              await page.getByTestId("linked-devices-empty").waitFor({
                state: "visible",
              });
            },
          })
        );
        shots.push(
          await shoot(browser, {
            ...frame,
            name: "rows",
            devices: TWO_ROWS,
            drive: async (page) => {
              await page.getByTestId("linked-devices-list").waitFor({
                state: "visible",
              });
            },
          })
        );
        shots.push(
          await shoot(browser, {
            ...frame,
            name: "confirm",
            devices: TWO_ROWS,
            drive: async (page) => {
              await page.getByTestId("linked-devices-list").waitFor({
                state: "visible",
              });
              await page.getByTestId(`linked-device-disconnect-${OTHER_ID}`).click();
              await page
                .getByTestId(`linked-device-disconnect-${OTHER_ID}-confirm`)
                .waitFor({ state: "visible" });
              await page
                .getByTestId(`linked-device-row-${OTHER_ID}`)
                .scrollIntoViewIfNeeded();
            },
          })
        );
      }
      for (const path of shots) console.log(path);
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
