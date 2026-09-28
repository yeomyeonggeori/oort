#!/usr/bin/env node
// =============================================================================
// 설정 › AI 연결 › 내 계정 — 연결 지점 캡처 (#2878 AA-4, 시안 §3·§4).
//
//   npm run build:design && node scripts/capture-my-accounts-profiles.mjs
//
// 브라우저에는 셸이 없어 design 전용 쿼리로 자세를 세운다(제품 빌드는 무시):
// `aiProbe=claude-ready`(기본 로그인 줄) · `aiProfiles=demo`(프로필 두 줄) ·
// `aiUnlink=<상태>`(해제 창) · `aiLogin=waiting`(로그인 모달). 라이트·다크 × 1280·390
// → captures/2878/*.png
// =============================================================================

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR
  ? resolve(process.env.OUT_DIR)
  : resolve(WEB_ROOT, "captures/2878");
const PORT = Number(process.env.CAPTURE_PORT || 5287);
const ORIGIN = `http://127.0.0.1:${PORT}`;

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";
const GENERAL_ID = "00000000-0000-7000-8000-000000000201";
const ME = "019f94e3-7a10-79cd-9dee-208f47edd9a8";
const SESSION = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: ME, workspaceId: WORKSPACE_ID, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: `ws://127.0.0.1:${PORT + 900}/connection/websocket`,
};
const CHANNELS = [
  { id: GENERAL_ID, workspaceId: WORKSPACE_ID, kind: "public", name: "general", muted: false },
];

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function installMocks(context) {
  await context.route("**/v1/**", (route) =>
    json(route, { channels: [], members: [], read_states: [], messages: [] })
  );
  await context.route("**/v1/auth/login", (route) => json(route, SESSION));
  await context.route("**/v1/auth/realtime-token", (route) =>
    json(route, {
      token: "capture-realtime-token",
      tokenType: "Bearer",
      expiresAtMs: Date.now() + 60_000,
      ttlSeconds: 60,
      workspaceId: WORKSPACE_ID,
      memberId: ME,
    })
  );
  await context.route("**/v1/auth/refresh", (route) =>
    json(route, { accessToken: SESSION.accessToken, refreshToken: SESSION.refreshToken })
  );
  await context.route("**/v1/workspaces/*/channels", (route) => json(route, { channels: CHANNELS }));
  await context.route("**/v1/workspaces/*/roster", (route) => json(route, { members: [] }));
  // 운영자가 아닌 사람의 팀 연결(403 → 운영자 안내). 내 계정 절만 본다.
  await context.route("**/v1/provider/link**", (route) =>
    json(route, { error: { code: "forbidden", message: "operator required" } }, 403)
  );
}

async function installRealtimeSocket(context) {
  await context.addInitScript(() => {
    class GateWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      constructor(url) {
        this.url = url;
        this.readyState = 0;
        queueMicrotask(() => {
          this.readyState = 1;
          this.onopen?.(new Event("open"));
        });
      }
      send(data) {
        const replies = [];
        for (const line of String(data).trim().split("\n")) {
          const command = JSON.parse(line);
          if (command.connect) replies.push({ id: command.id, connect: { client: "slash-gate", version: "6" } });
          else if (command.subscribe)
            replies.push({
              id: command.id,
              subscribe: { recoverable: true, positioned: true, recovered: true, epoch: "slash-gate", offset: 0 },
            });
          else replies.push({ id: command.id });
        }
        queueMicrotask(() =>
          this.onmessage?.(new MessageEvent("message", { data: replies.map((r) => JSON.stringify(r)).join("\n") }))
        );
      }
      close() {
        this.readyState = 3;
        this.onclose?.(new CloseEvent("close", { code: 1000 }));
      }
    }
    window.WebSocket = GateWebSocket;
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

async function signedIn(browser, { viewport, scheme }) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    colorScheme: scheme,
    reducedMotion: "reduce",
  });
  await installMocks(context);
  await installRealtimeSocket(context);
  const page = await context.newPage();
  await page.goto(ORIGIN, { waitUntil: "networkidle" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("seongjae@dawn.example");
  await page.getByTestId("login-password").fill("capture-only-not-a-credential");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-list").waitFor({ state: "visible" });
  return { context, page };
}

const BASE = "/settings?section=ai&aiEntry=rows&aiProbe=claude-ready&aiProfiles=demo";

const SCENES = [
  { name: "list", query: "", ready: "my-account-claude/회사" },
  { name: "list-long", query: "", ready: "my-account-claude/회사", act: async (page) => {
      await page.getByTestId("my-account-codex/회사 메인 Pro 계정 (팀 공용 아님, 개인 결제)").scrollIntoViewIfNeeded();
    } },
  { name: "menu", query: "", ready: "my-account-claude/회사", act: async (page) => {
      await page.getByTestId("my-account-claude/회사-more").click();
      await page.getByTestId("my-account-claude/회사-menu").waitFor({ state: "visible" });
    } },
  { name: "unlink-confirm", query: "&aiUnlink=confirm", ready: "my-account-unlink-dialog" },
  { name: "unlink-signing-out", query: "&aiUnlink=signing-out", ready: "my-account-unlink-dialog" },
  { name: "unlink-failed", query: "&aiUnlink=failed:logout-failed", ready: "my-account-unlink-dialog" },
  { name: "unlink-still", query: "&aiUnlink=failed:still-signed-in", ready: "my-account-unlink-dialog" },
  { name: "remove-from-list", query: "", ready: "my-account-claude", act: async (page) => {
      await page.getByTestId("my-account-claude-more").click();
      await page.getByTestId("my-account-claude-menu-destructive").click();
      await page.getByTestId("my-account-unlink-dialog").waitFor({ state: "visible" });
    } },
  { name: "add", query: "", ready: "subscription-entry-open", act: async (page) => {
      await page.getByTestId("subscription-entry-open").click();
      await page.getByTestId("add-subscription-label").fill("회사2");
    } },
  { name: "add-taken", query: "", ready: "subscription-entry-open", act: async (page) => {
      await page.getByTestId("subscription-entry-open").click();
      await page.getByTestId("add-subscription-label").fill("회사");
      await page.getByTestId("add-subscription-label").press("Enter");
    } },
  { name: "relogin-modal", query: "&aiLogin=waiting", ready: "my-account-claude/회사-login", act: async (page) => {
      await page.getByTestId("my-account-claude/회사-login").click();
      await page.getByTestId("harness-login-dialog").waitFor({ state: "visible" });
    } },
];

const FRAMES = [
  { viewport: { width: 1280, height: 800 }, scheme: "light" },
  { viewport: { width: 1280, height: 800 }, scheme: "dark" },
  { viewport: { width: 390, height: 844 }, scheme: "light" },
  { viewport: { width: 390, height: 844 }, scheme: "dark" },
];

async function shoot(browser, frame, scene) {
  const { context, page } = await signedIn(browser, frame);
  await page.evaluate((hash) => {
    location.hash = hash;
  }, BASE + scene.query);
  try { await page.getByTestId(scene.ready).first().waitFor({ state: "visible", timeout: 8000 }); } catch (e) { await page.screenshot({ path: `${OUT_DIR}/debug.png` }); throw e; }
  await page.getByTestId("ai-my-accounts").scrollIntoViewIfNeeded();
  if (scene.act) await scene.act(page);
  await page.waitForTimeout(250);
  const path = `${OUT_DIR}/${scene.name}-${frame.viewport.width}-${frame.scheme}.png`;
  await page.screenshot({ path });
  await context.close();
  return path;
}

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) {
    throw new Error("dist/ is missing. Run `npm run build:design` first.");
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
      const only = process.env.ONLY ? process.env.ONLY.split(",") : null;
      for (const scene of SCENES) {
        if (only && !only.includes(scene.name)) continue;
        for (const frame of FRAMES) console.log(await shoot(browser, frame, scene));
      }
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
