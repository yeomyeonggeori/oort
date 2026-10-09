#!/usr/bin/env node
// =============================================================================
// 설정 › 기기 › 「이 맥의 작업 호스트」 캡처와 실측 (#2778, #3578 S4에서 코드 실행 호스트에서
// 기기로 옮김). 같은 흉내로 기기 페이지 전체와 실행 호스트 페이지도 찍는다.
//
//   npm run build && node scripts/capture-this-mac.mjs
//   → artifacts/this-mac/*.png + report.json  (OUT_DIR 로 바꾼다)
//
// 진짜 앱 셸을 Chromium으로 연다. `/v1/**`는 고정 응답, 실시간 소켓은 곧바로
// 연결되는 흉내(capture-work-tab과 같은 모양). 데스크탑은 `__TAURI_INTERNALS__`
// 흉내이고 `work_host_status`가 장면마다 다른 셸 상태를 돌려준다. 실제 workd도
// 키체인도 건드리지 않는다.
//
// 재는 것: 호스트 0개인 데스크탑에서도 목차에 「기기」와 「실행 호스트」가 선다(planner
// 결정), 장면마다 `data-this-mac-state`(**기다리는 조건이 그 값이다**: 다른 상태이면
// 시간 초과로 실패한다), 가로 넘침 0, 실행 호스트 페이지의 남의 개인 맥은 이름만.
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
    if (path.endsWith("/device-keys/signing-context")) {
      return json(route, {
        instanceId: "capture", serverTimeMs: Date.now(), maxLifetimeMs: 600_000, maxClockSkewMs: 300_000,
        humanControlSignatureRequired: true, hostRegisterSignatureRequired: false,
        sessionId: "019a3c1e-0000-7000-8000-00000000c001",
      });
    }
    if (path.endsWith("/device-keys")) return json(route, { deviceKeys: [rootRow, phoneKey] });
    if (path === "/v1/auth/devices") return json(route, { devices: linkedDevices });
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


const MAC_KEY = "Al5MJdwsIiT7groXgUDS9kC6VMwSS1QutnuZEZlbxi5S";
const ROOT_ID = "019a3c1e-0000-7000-8000-00000000d001";
function keyRow(over = {}) {
  return {
    id: "019a3c1e-0000-7000-8000-00000000d002", workspaceId, memberId, alg: "p256",
    publicKey: "A2sX0fLhLEJH+Lzm5WOkQPJ3A32BLeszoPShOUXYmMKW", platform: "ios",
    label: "성재의 iPhone 16 Pro", state: "endorsed", canInstruct: true, current: false,
    createdAtMs: Date.now() - 600_000, ...over,
  };
}
const rootRow = keyRow({ id: ROOT_ID, platform: "macos", publicKey: MAC_KEY, label: "Mac", state: "root", canInstruct: true, current: true });
const phoneKey = keyRow();
const linkedDevices = [
  { id: "link-1", label: "성재의 iPhone 16 Pro", platform: "ios", linkedAt: Date.now() - 600_000, current: false },
  { id: "link-2", label: "성재 MacBook Pro", platform: "macos", linkedAt: Date.now() - 86_400_000, current: true },
];
const deviceKeyStatus = {
  support: "ready", detail: null, publicKey: MAC_KEY, fingerprint: "7C2E 91A0 4B3F D8E6 1055",
  root: { keyId: ROOT_ID, memberId, publicKey: MAC_KEY }, reuseWindowSeconds: 300,
  host: { running: true, matches: true, pinnedRootKeyId: ROOT_ID, signatureEnforcement: "enforced", serverRequiresSignatures: false, signaturesRequiredBy: "server", workspaceMatches: true },
};

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
  await page.addInitScript(({ status, deviceKeyStatus }) => {
    const callbacks = new Map();
    let nextCallback = 1;
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
      transformCallback(callback) { const id = nextCallback++; callbacks.set(id, callback); return id; },
      unregisterCallback(id) { callbacks.delete(id); },
      convertFileSrc: (p) => p,
      async invoke(cmd) {
        // 데스크탑 세션은 키체인 핸들로 이어진다: 로그인 뒤 앱이 한 번 다시 열려도 로그인이 남는다.
        if (cmd === "keychain_store_refresh_token") { window.__h = "shell:" + "c".repeat(32); return null; }
        if (cmd === "keychain_refresh_token_handle") return window.__h ?? null;
        if (cmd === "harness_profile_list") return [];
        if (cmd === "work_host_status") return status;
        if (cmd === "device_key_status") return deviceKeyStatus;
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
  }, { status, deviceKeyStatus });
}

async function signIn(page, origin) {
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  try {
    await page.getByTestId("nav-team").waitFor({ timeout: 20_000 });
  } catch (error) {
    await page.screenshot({ path: resolve(OUT_DIR, "FAIL-sign-in.png") }).catch(() => {});
    throw error;
  }
}

async function overflowX(page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

async function open(browser, origin, { scheme, viewport, status, hosts, section }) {
  const context = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion: "reduce", serviceWorkers: "block" });
  await installRoutes(context, hosts);
  const page = await context.newPage();
  if (process.env.CAPTURE_DEBUG) {
    page.on("console", (m) => console.log("console", m.type(), m.text().slice(0, 200)));
    page.on("response", (r) => console.log("resp", r.status(), r.url().replace(/^https?:\/\/[^/]+/, "")));
    page.on("framenavigated", (f) => console.log("nav", f.url()));
    page.on("pageerror", (e) => console.log("pageerror", String(e).slice(0, 300)));
  }
  await installRealtime(page);
  await installDesktop(page, status(origin));
  await page.addInitScript((server) => {
    try { localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ }
  }, origin);
  await signIn(page, origin);
  await page.evaluate((hash) => { location.hash = hash; }, `/settings?section=${section}`);
  return { context, page };
}

async function navRows(page) {
  // 폰 폭에서는 목차가 본문 위 한 줄로 눕지만 두 행은 그대로 DOM에 있다.
  return {
    devices: await page.getByTestId("settings-nav-devices").count(),
    code: await page.getByTestId("settings-nav-code").count(),
  };
}

/** 기기 페이지: 이 맥 호스트 카드의 상태 장면. 기다리는 값이 곧 기대 상태라 다르면 실패한다. */
async function scene(browser, origin, { name, scheme, viewport, status, hosts, expect, full = false }) {
  const tag = `host-${name}-${viewport.width}-${scheme}`;
  const { context, page } = await open(browser, origin, { scheme, viewport, status, hosts, section: "devices" });
  try {
    await page
      .locator(`[data-testid='this-mac'][data-this-mac-state='${expect}']`)
      .waitFor({ timeout: 15_000 });
  } catch (error) {
    // 실패한 장면을 남긴다: 기다린 상태가 아니면 무엇이 떠 있었는지가 증거다.
    await page.screenshot({ path: resolve(OUT_DIR, `FAIL-${tag}.png`) }).catch(() => {});
    throw error;
  }
  // 내 재개 정책 카드와 연결된 기기 목록이 답한 뒤에 찍는다(그래야 한 장이 페이지 전체를 말한다).
  await page.getByTestId("work-tier-save-member").waitFor({ timeout: 15_000 });
  await page.getByTestId("linked-devices-list").waitFor({ timeout: 15_000 });
  const state = await page.getByTestId("this-mac").getAttribute("data-this-mac-state");
  check(`${tag} 상태 ${expect}`, state === expect, { state });
  const rows = await navRows(page);
  check(`${tag} 목차에 기기와 실행 호스트`, rows.devices > 0 && rows.code > 0, rows);
  check(`${tag} 가로 넘침 0`, (await overflowX(page)) === 0);
  check(`${tag} 이 페이지에 워크스페이스 기본 저장이 없다`, (await page.getByTestId("work-tier-save-workspace").count()) === 0);
  check(`${tag} 실행 엔진 문구가 없다`, !(await page.locator("body").innerText()).includes("실행 엔진"));
  await page.waitForTimeout(250);
  if (full) {
    await page.screenshot({ path: resolve(OUT_DIR, `devices-${viewport.width}-${scheme}.png`) });
    report.scenes.push(`devices-${viewport.width}-${scheme}`);
  }
  // 카드 하나를 찍는다: 상태 장면은 이 카드가 말하는 것이다.
  await page.getByTestId("this-mac-card").scrollIntoViewIfNeeded();
  await page.getByTestId("this-mac-card").screenshot({ path: resolve(OUT_DIR, `${tag}.png`) });
  report.scenes.push(tag);
  if (name === "online") {
    await page.getByTestId("this-mac-unregister").click();
    await page.waitForTimeout(200);
    await page.getByTestId("this-mac-card").screenshot({ path: resolve(OUT_DIR, `${tag}-confirm.png`) });
    report.scenes.push(`${tag}-confirm`);
  }
  if (name === "not-registered" && scheme === "light") {
    await page.getByTestId("this-mac-name").focus();
    await page.waitForTimeout(100);
    await page.getByTestId("this-mac-card").screenshot({ path: resolve(OUT_DIR, `${tag}-focus.png`) });
    report.scenes.push(`${tag}-focus`);
  }
  await context.close();
}

/** 실행 호스트 페이지: 등록부(남의 개인 맥은 이름만)와 워크스페이스 기본 정책. */
async function codePage(browser, origin, { scheme, viewport }) {
  const tag = `code-${viewport.width}-${scheme}`;
  const hosts = [
    hostRow({ id: "019a3c1e-5b7d-7e20-9c41-8d2f0a6b3e18", scope: "workspace", ownerMemberId: "00000000-0000-7000-8000-000000000999", displayName: "빌드 서버 (Linux)", type: "workd", online: true, lastSeenAtMs: Date.now() - 30_000 }),
    hostRow({ online: true, lastSeenAtMs: Date.now() - 20_000 }),
    hostRow({ id: "019a3c1e-5b7d-7e20-9c41-8d2f0a6b3e19", scope: "member", ownerMemberId: "00000000-0000-7000-8000-000000000998", displayName: "지현의 MacBook Air", online: true }),
    hostRow({ id: "019a3c1e-5b7d-7e20-9c41-8d2f0a6b3e20", displayName: "옛 맥미니", revokedAtMs: Date.now() - 3 * 86_400_000, online: false }),
  ];
  const { context, page } = await open(browser, origin, {
    scheme, viewport, section: "code", hosts,
    status: (o) => localStatus(o),
  });
  await page.locator("[data-testid='work-host-row'][data-host-status='other-personal']").waitFor({ timeout: 15_000 });
  await page.getByTestId("work-tier-save-workspace").waitFor({ timeout: 15_000 });
  const rowsN = await page.getByTestId("work-host-row").count();
  check(`${tag} 호스트 행 ${hosts.length}`, rowsN === hosts.length, { rowsN });
  check(
    `${tag} 남의 개인 맥은 복사 단추가 없다`,
    (await page.locator("[data-host-status='other-personal'] [data-testid='work-host-copy-id']").count()) === 0
  );
  check(`${tag} 이 페이지에 이 맥 카드와 내 정책이 없다`, (await page.getByTestId("this-mac").count()) === 0 && (await page.getByTestId("work-tier-save-member").count()) === 0);
  check(`${tag} 가로 넘침 0`, (await overflowX(page)) === 0);
  check(`${tag} 실행 엔진 문구가 없다`, !(await page.locator("body").innerText()).includes("실행 엔진"));
  await page.waitForTimeout(250);
  await page.screenshot({ path: resolve(OUT_DIR, `${tag}.png`) });
  report.scenes.push(tag);
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
        await scene(browser, preview.origin, { ...s, scheme, viewport: { width: 1440, height: 900 } });
      }
      // 기기 페이지 전체(온라인 장면), 데스크탑 폭과 폰 폭. 설정 판은 안에서 스크롤하므로 판이
      // 길어진 만큼 창을 키운다.
      const online = SCENES.find((x) => x.name === "online");
      await scene(browser, preview.origin, { ...online, scheme, viewport: { width: 1440, height: 2300 }, full: true });
      await scene(browser, preview.origin, { ...online, scheme, viewport: { width: 390, height: 3000 }, full: true });
      await codePage(browser, preview.origin, { scheme, viewport: { width: 1440, height: 1300 } });
      await codePage(browser, preview.origin, { scheme, viewport: { width: 390, height: 2600 } });
    }
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
