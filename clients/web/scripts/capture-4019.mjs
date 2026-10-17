#!/usr/bin/env node
// =============================================================================
// 업데이트 받는 중 게이지 캡처 (#4019). 골격은 capture-3904.mjs.
//
//   npm run build:design && node scripts/capture-4019.mjs
//
// 스테이징 업데이트 시험에서 게이지가 「0 B」에 멈춰 보였다. 첫 진행 이벤트 전,
// 길이를 아는 이벤트, 길이 없는 이벤트(total=null) 세 장면을 사이드바 카드와
// 설정 > 업데이트 두 곳에서 라이트·다크로 찍고, 어느 곳에도 「0 B」·바이트 낱말이
// 없음을 단언한다. 진행 이벤트는 Tauri 흉내의 `plugin:event|listen` 핸들러로 주입한다.
// =============================================================================
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/4019");
const PORT = Number(process.env.CAPTURE_PORT || 5219);

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const channels = [
  { id: "00000000-0000-7000-8000-000000000201", workspaceId, kind: "public", name: "workbench", muted: false },
  { id: "00000000-0000-7000-8000-000000000202", workspaceId, kind: "public", name: "agent-lab", muted: false },
  { id: "00000000-0000-7000-8000-000000000203", workspaceId, kind: "public", name: "general", muted: false },
  { id: "00000000-0000-7000-8000-000000000204", workspaceId, kind: "private", name: "design-2.0", muted: false },
];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: "ws://work-tab-capture.invalid/connection/websocket",
};
const roster = [
  {
    id: memberId, workspaceId, kind: "human", status: "active", role: "owner", displayName: "곽성재",
    handle: "seongjae", channelCount: 4, channelIds: channels.map((c) => c.id), capabilities: [],
    createdAtMs: 0, updatedAtMs: 0,
  },
];

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function installRoutes(context) {
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
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: [] });
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
          if (c.connect) return { id: c.id, connect: { client: "work-tab-capture", version: "6" } };
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


async function installDesktop(page) {
  await page.addInitScript(() => {
    const callbacks = new Map();
    const listeners = new Map();
    let nextCallback = 1;
    let installResolve = null;
    let installReject = null;
    window.__relaunched = 0;
    window.__emit = (event, payload) => {
      const handler = listeners.get(event);
      if (handler !== undefined) callbacks.get(handler)?.({ event, id: 1, payload });
    };
    window.__finishInstall = () => installResolve?.();
    window.__failInstall = () => installReject?.(new Error("signature mismatch"));
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
      transformCallback(callback) {
        const id = nextCallback++;
        callbacks.set(id, callback);
        return id;
      },
      unregisterCallback(id) { callbacks.delete(id); },
      convertFileSrc: (p) => p,
      async invoke(cmd, args) {
        if (cmd === "plugin:event|listen") { listeners.set(args.event, args.handler); return 1; }
        if (cmd.startsWith("plugin:event|")) return 1;
        if (cmd === "updater_check") return { version: "0.1.28", currentVersion: "0.1.27", notes: null, publishedAt: null };
        if (cmd === "updater_install") return new Promise((res, rej) => { installResolve = res; installReject = rej; });
        if (cmd === "updater_relaunch") { window.__relaunched += 1; return new Promise(() => {}); }
        if (cmd === "detect_local_harnesses") return { harnesses: [] };
        if (cmd === "detect_hosted_agents") return [];
        if (cmd === "keychain_available") return true;
        if (cmd === "keychain_store_refresh_token") { window.__kc = true; return null; }
        if (cmd === "keychain_refresh_token_handle") return window.__kc ? "shell:00000000000000000000000000000001" : null;
        if (cmd === "keychain_clear_refresh_token") { window.__kc = false; return null; }
        if (cmd === "deep_link_take_pending") return [];
        if (cmd === "app_version") return "0.1.27";
        if (cmd === "notification_permission") return "denied";
        return null;
      },
    };
  });
}

const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok) failures.push(`${name} ${detail}`);
}

async function open(browser, origin, scheme, { collapsed = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme, serviceWorkers: "block" });
  await installRoutes(context);
  const page = await context.newPage();
  await installRealtime(page);
  await installDesktop(page);
  await page.addInitScript((server) => { try { localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ } }, origin);
  if (collapsed) await page.addInitScript(() => { try { localStorage.setItem("momo.web.shell.listColumn.collapsed.v1", "1"); } catch { /* 저장소 없는 캡처 */ } });
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId(collapsed ? "profile-card" : "sidebar-profile-foot").waitFor({ timeout: 20_000 });
  await page.waitForTimeout(500);
  return { context, page };
}

const CLIP = { x: 0, y: 620, width: 460, height: 280 };
const BYTES = /\b\d+(\.\d+)? ?(B|KB|MB)\b/;

async function scene(browser, origin, scheme) {
  const { context, page } = await open(browser, origin, scheme);
  const shot = (name) => page.screenshot({ path: resolve(OUT_DIR, `${name}-${scheme}.png`), clip: CLIP });
  const card = page.getByTestId("update-card");
  const bar = () => page.locator("[data-testid=update-card] progress");
  const lineOf = async () => (await page.getByTestId("update-card-progress").textContent()) ?? "";

  await page.getByTestId("update-pill").click();
  await card.waitFor();
  await page.waitForTimeout(250);
  // 1) 첫 이벤트 전
  let line = await lineOf();
  check(`${scheme} 카드: 첫 이벤트 전 「받는 중」`, line === "받는 중", line);
  check(`${scheme} 카드: 첫 이벤트 전 막대는 불확정`, (await bar().getAttribute("value")) === null);
  check(`${scheme} 카드: 「0 B」 없음`, !line.includes("0 B"), line);
  await shot("1-before-first-event");
  // 2) 길이를 아는 이벤트
  await page.evaluate(() => window.__emit("momo:update-progress", { downloaded: 2_500_000, total: 10_000_000 }));
  await page.waitForTimeout(250);
  line = await lineOf();
  check(`${scheme} 카드: 길이를 알면 게이지가 찬다`, (await bar().getAttribute("value")) === "2500000" && line.includes("2.5 / 10.0 MB") && line.includes("25%"), line);
  await shot("2-known-total");
  // 3) 길이 없는 이벤트
  await page.evaluate(() => window.__emit("momo:update-progress", { downloaded: 3_200_000, total: null }));
  await page.waitForTimeout(250);
  line = await lineOf();
  check(`${scheme} 카드: 길이를 모르면 「받는 중」이고 바이트·% 없음`, line === "받는 중" && !BYTES.test(line), line);
  check(`${scheme} 카드: 길이를 모르면 막대는 불확정`, (await bar().getAttribute("value")) === null);
  await shot("3-unknown-total");
  // 불확정 막대는 움직인다(빈 트랙이면 얼어 보인다): 두 프레임의 조각 위치가 다르다
  const drift = () => bar().evaluate((el) => getComputedStyle(el).backgroundPositionX);
  const d1 = await drift();
  await page.waitForTimeout(350);
  await shot("3b-unknown-total-frame2");
  const d2 = await drift();
  check(`${scheme} 카드: 불확정 막대가 흐른다(조각 위치가 변한다)`, d1 !== d2, `${d1} -> ${d2}`);
  await page.screenshot({ path: resolve(OUT_DIR, `3-full-${scheme}.png`) });

  // 설정 > 업데이트: 같은 상태가 설정 화면에도 같은 말로 선다
  await page.keyboard.press("Escape");
  await page.evaluate(() => { window.location.hash = "#/settings?section=updates"; });
  await page.getByTestId("update-progress").waitFor({ timeout: 10_000 });
  await page.waitForTimeout(250);
  const sline = (await page.getByTestId("update-progress").textContent()) ?? "";
  check(`${scheme} 설정: 길이를 모르면 「받는 중」`, sline === "받는 중", sline);
  check(`${scheme} 설정: 불확정 막대가 있다`, (await page.locator("[data-testid=update-progress] progress").count()) === 1);
  await page.screenshot({ path: resolve(OUT_DIR, `4-settings-unknown-${scheme}.png`) });
  await page.waitForTimeout(350);
  await page.screenshot({ path: resolve(OUT_DIR, `4b-settings-unknown-frame2-${scheme}.png`) });
  await page.evaluate(() => window.__emit("momo:update-progress", { downloaded: 7_500_000, total: 10_000_000 }));
  await page.waitForTimeout(250);
  const kline = (await page.getByTestId("update-progress").textContent()) ?? "";
  check(`${scheme} 설정: 길이를 알면 「x / y MB (n%)」`, kline === "7.5 / 10.0 MB (75%)", kline);
  await page.screenshot({ path: resolve(OUT_DIR, `5-settings-known-${scheme}.png`) });
  await context.close();
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  try {
    for (const scheme of ["light", "dark"]) await scene(browser, preview.origin, scheme);
  } finally {
    await browser.close();
    await preview.stop?.();
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length}개 단언 실패`);
    process.exit(1);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
