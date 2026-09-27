#!/usr/bin/env node
// =============================================================================
// 설정 › 코드 실행 호스트 › 「이 맥」 캡처와 실측 (#2778).
//
//   npm run build && node scripts/capture-this-mac.mjs
//   → artifacts/this-mac/*.png + report.json
//
// 진짜 앱 셸을 Chromium으로 연다. `/v1/**`는 고정 응답, 실시간 소켓은 곧바로
// 연결되는 흉내(capture-work-tab과 같은 모양). 데스크탑은 `__TAURI_INTERNALS__`
// 흉내이고 `work_host_status`가 장면마다 다른 셸 상태를 돌려준다. 실제 workd도
// 키체인도 건드리지 않는다.
//
// 재는 것: 호스트 0개인 데스크탑에서 목차에 「코드 실행 호스트」가 선다(planner
// 결정), 장면마다 `data-this-mac-state`, 가로 넘침 0.
// =============================================================================

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/this-mac");
const PORT = Number(process.env.CAPTURE_PORT || 5198);

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const hostId = "019a3c1e-5b7d-7e20-9c41-8d2f0a6b3e17";
const channels = [
  { id: "00000000-0000-7000-8000-000000000201", workspaceId, kind: "public", name: "workbench", muted: false },
];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: "ws://this-mac-capture.invalid/connection/websocket",
};
const roster = [
  {
    id: memberId, workspaceId, kind: "human", status: "active", role: "owner", displayName: "곽성재",
    handle: "seongjae", channelCount: 1, channelIds: channels.map((c) => c.id), capabilities: [],
    createdAtMs: 0, updatedAtMs: 0,
  },
];

const failures = [];
const report = { scenes: [], checks: [] };
function check(name, ok, detail) {
  report.checks.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures.push(name);
}

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function installRoutes(context, hosts) {
  await context.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId });
    }
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: hosts });
    if (path.endsWith("/work-host-engine")) return json(route, { engine: "opencode", source: "default" });
    if (path.includes("/work-tier-policy")) return json(route, { workTierPolicy: { mode: "ask", source: "default" } });
    if (path.endsWith("/work-sessions")) return json(route, { workSessions: [] });
    if (path.endsWith(`/workspaces/${workspaceId}`)) return json(route, { workspace: { id: workspaceId, name: "여명거리" } });
    if (path.includes("/messages")) return json(route, { messages: [] });
    return json(route, {});
  });
}

async function installRealtime(page) {
  await page.addInitScript(() => {
    class CaptureSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      constructor(url) {
        this.url = String(url);
        this.readyState = 0;
        queueMicrotask(() => { this.readyState = 1; this.onopen?.(new Event("open")); });
      }
      send(data) {
        const replies = String(data).trim().split("\n").map((line) => {
          const c = JSON.parse(line);
          if (c.connect) return { id: c.id, connect: { client: "this-mac-capture", version: "6" } };
          if (c.subscribe) return { id: c.id, subscribe: { recoverable: true, positioned: true, recovered: false, epoch: "cap", offset: 0 } };
          return { id: c.id };
        });
        queueMicrotask(() => this.onmessage?.(new MessageEvent("message", { data: replies.map((r) => JSON.stringify(r)).join("\n") })));
      }
      close() { this.readyState = 3; this.onclose?.(new CloseEvent("close", { code: 1000 })); }
    }
    window.WebSocket = CaptureSocket;
  });
}


function hostRow(over = {}) {
  return {
    id: hostId, workspaceId, scope: "member", ownerMemberId: memberId, type: "workd",
    displayName: "성재 MacBook Pro, 집 작업실", publicKey: "capture", capabilities: { acp: true },
    createdAtMs: Date.now() - 86_400_000, lastSeenAtMs: Date.now() - 12 * 60_000, online: false, ...over,
  };
}

function localStatus(origin, over = {}) {
  return {
    sidecar: true,
    registered: { hostId, workspaceId, ownerMemberId: memberId, serverUrl: origin },
    running: true,
    heartbeat: { lastOkAtMs: Date.now(), failing: false },
    adapters: [
      { key: "claude", executable: "/opt/homebrew/bin/claude-agent-acp", found: true },
      { key: "codex", executable: "codex-acp", found: false },
    ],
    workFolder: "/Users/seongjae/oort-work",
    displayNameSuggestion: "성재 MacBook Pro",
    ...over,
  };
}

async function installDesktop(page, status) {
  await page.addInitScript(({ status }) => {
    const callbacks = new Map();
    let nextCallback = 1;
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
      transformCallback(callback) { const id = nextCallback++; callbacks.set(id, callback); return id; },
      unregisterCallback(id) { callbacks.delete(id); },
      convertFileSrc: (p) => p,
      async invoke(cmd) {
        if (cmd === "work_host_status") return status;
        if (cmd === "detect_local_harnesses") return { harnesses: [] };
        if (cmd === "detect_hosted_agents") return [];
        if (cmd === "keychain_available") return false;
        if (cmd === "deep_link_take_pending") return [];
        if (cmd === "app_version") return "0.1.12";
        if (cmd === "notification_permission") return "denied";
        if (cmd === "updater_check") return null;
        if (cmd.startsWith("plugin:event|")) return 1;
        return null;
      },
    };
  }, { status });
}

async function signIn(page, origin) {
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("nav-team-work").waitFor({ timeout: 20_000 });
}

async function overflowX(page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

async function scene(browser, origin, { name, scheme, viewport, status, hosts, expect }) {
  const tag = `${name}-${viewport.width}-${scheme}`;
  const context = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion: "reduce" });
  await installRoutes(context, hosts);
  const page = await context.newPage();
  await installRealtime(page);
  await installDesktop(page, status(origin));
  await page.addInitScript((server) => {
    try { localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ }
  }, origin);
  await signIn(page, origin);
  await page.goto(`${origin}/#/settings?section=code`);
  await page.getByTestId("this-mac").waitFor({ timeout: 15_000 });
  // The registry answers after the shell: read the state once both have.
  await page.locator("[data-testid='work-host-list'], [data-testid='work-hosts-empty']").first().waitFor({ timeout: 15_000 });
  const state = await page.getByTestId("this-mac").getAttribute("data-this-mac-state");
  check(`${tag} 상태 ${expect}`, state === expect, { state });
  const navHasCode = await page.getByText("코드 실행 호스트", { exact: true }).count();
  check(`${tag} 목차에 코드 실행 호스트`, navHasCode > 0, { navHasCode });
  check(`${tag} 가로 넘침 0`, (await overflowX(page)) === 0);
  await page.waitForTimeout(250);
  await page.screenshot({ path: resolve(OUT_DIR, `${tag}.png`) });
  report.scenes.push(tag);
  if (name === "online") {
    await page.getByTestId("this-mac-unregister").click();
    await page.waitForTimeout(200);
    await page.screenshot({ path: resolve(OUT_DIR, `${tag}-confirm.png`) });
    report.scenes.push(`${tag}-confirm`);
  }
  if (name === "not-registered" && scheme === "light") {
    await page.keyboard.press("Tab");
    await page.getByTestId("this-mac-name").focus();
    await page.keyboard.press("Tab");
    await page.waitForTimeout(100);
    await page.screenshot({ path: resolve(OUT_DIR, `${tag}-focus.png`) });
    report.scenes.push(`${tag}-focus`);
  }
  await context.close();
}

const SCENES = [
  { name: "not-registered", status: (o) => localStatus(o, { registered: null, running: false, heartbeat: null }), hosts: [], expect: "not_registered" },
  { name: "no-adapter", status: (o) => localStatus(o, { registered: null, running: false, heartbeat: null, adapters: [{ key: "claude", executable: "claude-agent-acp", found: false }, { key: "codex", executable: "codex-acp", found: false }] }), hosts: [], expect: "not_registered" },
  { name: "stopped", status: (o) => localStatus(o, { running: false, heartbeat: null }), hosts: [hostRow()], expect: "offline" },
  { name: "not-reaching", status: (o) => localStatus(o, { heartbeat: { lastOkAtMs: null, failing: true } }), hosts: [hostRow()], expect: "offline" },
  { name: "online", status: (o) => localStatus(o), hosts: [hostRow({ online: true, lastSeenAtMs: Date.now() - 20_000 })], expect: "online" },
  { name: "revoked", status: (o) => localStatus(o), hosts: [hostRow({ revokedAtMs: Date.now() - 3_600_000 })], expect: "revoked" },
];

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) throw new Error("dist/ is missing. Run npm run build first.");
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  try {
    for (const scheme of ["light", "dark"]) {
      for (const s of SCENES) {
        await scene(browser, preview.origin, { ...s, scheme, viewport: { width: 1100, height: 760 } });
      }
    }
    await scene(browser, preview.origin, { ...SCENES[0], scheme: "light", viewport: { width: 720, height: 760 } });
    await scene(browser, preview.origin, { ...SCENES[3], scheme: "light", viewport: { width: 720, height: 760 } });
  } finally {
    await browser.close();
    await preview.stop();
    writeFileSync(resolve(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));
  }
  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
}

await main();
