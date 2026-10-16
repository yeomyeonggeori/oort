#!/usr/bin/env node
// =============================================================================
// 업데이트 알약·카드 캡처 (#3904, 성재 결재 2026-10-16). 골격은 capture-rail-unified.mjs.
//
//   npm run build:design && node scripts/capture-3904.mjs
//
// 실제 design 번들을 Tauri 흉내(updater_check/install/relaunch + 진행 이벤트)로 열어
// 알약·툴팁(호버·키보드)·받는 중 카드·3초 카운트다운·실패 카드·접힘(알약 없음)을
// 라이트·다크로 찍고, 자동 다시 실행이 정확히 한 번 일어나는지 단언한다.
// =============================================================================
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/3904");
const PORT = Number(process.env.CAPTURE_PORT || 5203);

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
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: scheme, serviceWorkers: "block" });
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

const CLIP = { x: 0, y: 560, width: 460, height: 240 };

async function scene(browser, origin, scheme) {
  const shot = (page, name) => page.screenshot({ path: resolve(OUT_DIR, `${name}-${scheme}.png`), clip: CLIP });

  // 1) 새 버전: 알약 + 툴팁(호버, 키보드)
  {
    const { context, page } = await open(browser, origin, scheme);
    const pill = page.getByTestId("update-pill");
    await pill.waitFor({ timeout: 10_000 });
    await shot(page, "1-pill");
    await page.screenshot({ path: resolve(OUT_DIR, `1-full-${scheme}.png`) });
    await pill.hover();
    await page.waitForTimeout(150);
    const tip = page.getByTestId("update-pill-tooltip");
    check(`${scheme} 호버 툴팁이 보인다`, await tip.isVisible());
    check(`${scheme} 툴팁 문구`, (await tip.textContent()) === "0.1.28로 업데이트할 수 있어요. 누르면 받고 다시 실행해요.");
    const box = await tip.boundingBox();
    check(`${scheme} 툴팁이 창 안에 있다`, !!box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 1280);
    await shot(page, "2-tooltip-hover");
    await page.mouse.move(700, 300);
    await page.waitForTimeout(100);
    check(`${scheme} 포인터가 떠나면 툴팁이 사라진다`, !(await tip.isVisible()));
    await pill.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await page.waitForTimeout(100);
    check(`${scheme} 키보드 포커스에도 툴팁이 보인다`, await tip.isVisible());
    await shot(page, "2b-tooltip-focus");

    // 2) 누르면 받기 시작 + 카드(게이지)
    await pill.click();
    await page.getByTestId("update-card").waitFor();
    await page.evaluate(() => window.__emit("momo:update-progress", { downloaded: 11_100_000, total: 42_600_000 }));
    await page.waitForTimeout(250);
    check(`${scheme} 받는 중 카드 제목`, (await page.getByTestId("update-card-title").textContent()) === "새 버전을 받는 중");
    check(`${scheme} 게이지 값`, (await page.locator("[data-testid=update-card] progress").getAttribute("value")) === "11100000");
    await shot(page, "3-downloading");
    await page.screenshot({ path: resolve(OUT_DIR, `3-full-${scheme}.png`) });
    // 길이 모름: 불확정 막대
    await page.evaluate(() => window.__emit("momo:update-progress", { downloaded: 5_000_000, total: null }));
    await page.waitForTimeout(250);
    check(`${scheme} 길이를 모르면 value 가 없다`, (await page.locator("[data-testid=update-card] progress").getAttribute("value")) === null);
    await shot(page, "3b-downloading-unknown");

    // 3) 끝남 → 3초 카운트다운 → 자동 다시 실행 한 번
    await page.evaluate(() => window.__finishInstall());
    await page.waitForTimeout(200);
    check(`${scheme} 카운트다운 카드`, (await page.getByTestId("update-card-title").textContent()) === "곧 다시 실행돼요");
    await shot(page, "4-restarting");
    check(`${scheme} 2.5초 안에는 다시 실행하지 않았다`, (await page.evaluate(() => window.__relaunched)) === 0);
    await page.waitForTimeout(3300);
    check(`${scheme} 3초 뒤 정확히 한 번 다시 실행했다`, (await page.evaluate(() => window.__relaunched)) === 1);
    await context.close();
  }

  // 4) 실패
  {
    const { context, page } = await open(browser, origin, scheme);
    await page.getByTestId("update-pill").click();
    await page.getByTestId("update-card").waitFor();
    await page.evaluate(() => window.__failInstall());
    await page.waitForTimeout(300);
    check(`${scheme} 실패 카드`, (await page.getByTestId("update-card-title").textContent()) === "업데이트하지 못했어요");
    await shot(page, "5-failed");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    const pill = page.getByTestId("update-pill");
    check(`${scheme} 실패 뒤 카드를 닫아도 알약이 남는다`, await pill.isVisible());
    await pill.hover();
    await page.waitForTimeout(150);
    check(`${scheme} 실패 툴팁`, (await page.getByTestId("update-pill-tooltip").textContent()) === "업데이트하지 못했어요. 눌러서 다시 확인해요.");
    await shot(page, "5b-failed-tooltip");
    await context.close();
  }

  // 5) 접힘(⌘B 저장 상태): 알약 없음
  {
    const { context, page } = await open(browser, origin, scheme, { collapsed: true });
    await page.waitForTimeout(600);
    check(`${scheme} 접힘에서는 알약이 없다`, (await page.getByTestId("update-pill").count()) === 0);
    await page.screenshot({ path: resolve(OUT_DIR, `6-collapsed-${scheme}.png`), clip: { x: 0, y: 500, width: 460, height: 300 } });
    await context.close();
  }
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
