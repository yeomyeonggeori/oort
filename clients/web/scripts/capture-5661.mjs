#!/usr/bin/env node
// =============================================================================
// 켜 둔 앱이 새 버전을 알아채는가 (#5661). 골격은 capture-3904.mjs.
//
//   npm run build:design && OUT_DIR=<dir> CAPTURE_PORT=26521 node scripts/capture-5661.mjs
//
// 실제 design 번들을 Tauri 흉내로 열고 Playwright 가짜 시계를 건다.
//   1) 처음 확인은 「새 버전 없음」. 그 뒤 피드에 새 판이 올라오고, 맥이 한 시간 잤다 깬다(`clock.fastForward` = 뚜껑을 닫았다
//      연 것). 깬 뒤 첫 시계 칸에 다시 묻고 「업데이트」 알약이 선다. 알약이 서고 질 때 채널 목록 행과 대화 영역의 자리가 0px
//      움직이는지 잰다. 밝게·어둡게·200%(640×400 @2x).
//   2) 확인하지 않는 판(updater_disabled): 설정 > 업데이트가 「최신」이 아니라 「확인 안 함」이다.
//   3) 확인 실패: 설정 > 업데이트 > 연결 기록의 「업데이트 확인 실패」가 센다.
// 사람·워크스페이스 이름은 가상이다.
// =============================================================================
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/5661");
const PORT = Number(process.env.CAPTURE_PORT || 5204);

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
  member: { id: memberId, workspaceId, kind: "human", displayName: "김도현", handle: "dohyun" },
  realtimeWebSocketUrl: "ws://update-capture.invalid/connection/websocket",
};
const roster = [
  {
    id: memberId, workspaceId, kind: "human", status: "active", role: "owner", displayName: "김도현",
    handle: "dohyun", channelCount: 4, channelIds: channels.map((c) => c.id), capabilities: [],
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
    if (path.endsWith(`/workspaces/${workspaceId}`)) return json(route, { workspace: { id: workspaceId, name: "새벽 스튜디오" } });
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
          if (c.connect) return { id: c.id, connect: { client: "update-capture", version: "6" } };
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

/** `mode`: "none" 새 판 없음 · "offer" 새 판 있음 · "off" 확인하지 않는 판 · "fail" 피드에 닿지 못함. 바꿀 수 있다(`window.__updateMode`). */
async function installDesktop(page, mode) {
  await page.addInitScript((initialMode) => {
    const callbacks = new Map();
    const listeners = new Map();
    let nextCallback = 1;
    window.__updateMode = initialMode;
    window.__checks = [];
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
        if (cmd === "updater_check") {
          window.__checks.push(Date.now());
          if (window.__updateMode === "off") throw "updater_disabled";
          if (window.__updateMode === "fail") throw "error sending request";
          return window.__updateMode === "offer"
            ? { version: "0.1.45", currentVersion: "0.1.42", notes: null, publishedAt: null }
            : null;
        }
        if (cmd === "updater_install") return new Promise(() => {});
        if (cmd === "updater_relaunch") return null;
        if (cmd === "detect_local_harnesses") return { harnesses: [] };
        if (cmd === "detect_hosted_agents") return [];
        if (cmd === "keychain_available") return true;
        if (cmd === "keychain_store_refresh_token") { window.__kc = true; return null; }
        if (cmd === "keychain_refresh_token_handle") return window.__kc ? "shell:00000000000000000000000000000001" : null;
        if (cmd === "keychain_clear_refresh_token") { window.__kc = false; return null; }
        if (cmd === "deep_link_take_pending") return [];
        if (cmd === "app_version") return "0.1.42";
        if (cmd === "notification_permission") return "denied";
        return null;
      },
    };
  }, mode);
}

const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok) failures.push(`${name} ${detail}`);
}

async function open(browser, origin, scheme, mode, { zoom = false } = {}) {
  const context = await browser.newContext({
    viewport: zoom ? { width: 640, height: 400 } : { width: 1280, height: 800 },
    deviceScaleFactor: zoom ? 2 : 1,
    colorScheme: scheme,
    locale: "ko-KR",
    serviceWorkers: "block",
  });
  await installRoutes(context);
  const page = await context.newPage();
  await page.clock.install({ time: new Date("2026-11-05T03:09:00Z") });
  await installRealtime(page);
  await installDesktop(page, mode);
  await page.addInitScript((server) => { try { localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ } }, origin);
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("sidebar-profile-foot").waitFor({ timeout: 20_000 });
  await page.waitForTimeout(500);
  // 「업데이트 소식」 창(이 판의 소식)이 처음 한 번 뜬다: 닫고 잰다.
  for (let i = 0; i < 3 && (await page.locator('[role="dialog"]').count()) > 0; i += 1) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  }
  return { context, page };
}

/** 채널 목록 행·대화 영역·프로필 줄의 자리. */
async function layout(page) {
  return page.evaluate(() => {
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return [Math.round(r.x * 100) / 100, Math.round(r.y * 100) / 100, Math.round(r.width * 100) / 100, Math.round(r.height * 100) / 100];
    };
    const rows = [...document.querySelectorAll("[data-sidebar-row]")].slice(0, 8).map(box);
    return {
      rows,
      main: box(document.querySelector("main")),
      foot: box(document.querySelector('[data-testid="sidebar-profile-foot"]')),
      pane: box(document.querySelector('[data-testid="sidebar-channel-pane"]')),
    };
  });
}

function sameRows(a, b) {
  return JSON.stringify(a.rows) === JSON.stringify(b.rows) && JSON.stringify(a.main) === JSON.stringify(b.main);
}

async function scenePill(browser, origin, scheme, zoom) {
  const tag = `${scheme}${zoom ? "-200" : ""}`;
  const { context, page } = await open(browser, origin, scheme, "none", { zoom });
  check(`${tag} 처음에는 알약이 없다(새 판 없음)`, (await page.getByTestId("update-pill").count()) === 0);
  const before = await layout(page);
  check(`${tag} 채널 행을 잴 수 있다`, before.rows.length >= 3 && before.main !== null, JSON.stringify(before));

  // 피드에 새 판이 올라왔고, 맥이 한 시간 잤다 깼다.
  await page.evaluate(() => { window.__updateMode = "offer"; });
  const checksBefore = await page.evaluate(() => window.__checks.length);
  await page.clock.fastForward("01:00:00");
  await page.getByTestId("update-pill").waitFor({ timeout: 5_000 }).catch(() => undefined);
  const checksAfter = await page.evaluate(() => window.__checks.length);
  check(`${tag} 깬 뒤 첫 시계 칸에 다시 물었다`, checksAfter === checksBefore + 1, `${checksBefore}→${checksAfter}`);
  check(`${tag} 알약이 섰다`, (await page.getByTestId("update-pill").count()) === 1);
  const shown = await layout(page);
  check(`${tag} 알약이 서도 채널 행·대화 영역 이동 0px`, sameRows(before, shown), JSON.stringify({ before, shown }));
  check(`${tag} 알약이 서도 프로필 줄 높이 그대로`, before.foot?.[3] === shown.foot?.[3], JSON.stringify([before.foot, shown.foot]));
  await page.screenshot({ path: resolve(OUT_DIR, `1-pill-${tag}.png`) });
  if (!zoom) await page.screenshot({ path: resolve(OUT_DIR, `1-pill-clip-${tag}.png`), clip: { x: 0, y: 560, width: 460, height: 240 } });

  // 피드가 다시 「새 판 없음」이 됐다(예: 그 판을 거둠): 다음 깸의 확인이 알약을 거둔다. 깨어 있는 6시간 상한은 가짜 시계 단위 시험
  // (`schedule.test.ts`)이 잰다 — 실제 번들에서 `runFor(6h)`는 앱의 다른 짧은 타이머까지 모두 돌려 끝나지 않는다.
  await page.evaluate(() => { window.__updateMode = "none"; });
  await page.clock.fastForward("06:02:00");
  await page.waitForTimeout(500);
  check(`${tag} 깬 뒤 다시 물어 알약이 졌다`, (await page.getByTestId("update-pill").count()) === 0);
  const gone = await layout(page);
  check(`${tag} 알약이 져도 채널 행·대화 영역 이동 0px`, sameRows(before, gone), JSON.stringify({ before, gone }));
  await context.close();
}

async function openUpdatesPage(page) {
  await page.getByTestId("profile-card").click();
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("settings-nav-updates").click();
  await page.getByTestId("updates-page").waitFor({ timeout: 10_000 });
  await page.waitForTimeout(300);
}

async function sceneOff(browser, origin, scheme) {
  const { context, page } = await open(browser, origin, scheme, "off");
  await openUpdatesPage(page);
  const status = page.getByTestId("update-status");
  check(`${scheme} 확인하지 않는 판: 상태 표지 off`, (await status.getAttribute("data-update-state")) === "off");
  check(`${scheme} 확인하지 않는 판: 「최신」이 아니다`, !(await page.getByTestId("updates-page").textContent()).includes("최신"));
  check(`${scheme} 확인하지 않는 판: 「업데이트 확인」 단추가 없다`, (await page.getByTestId("update-check").count()) === 0);
  await page.screenshot({ path: resolve(OUT_DIR, `2-settings-off-${scheme}.png`), fullPage: true });
  await context.close();
}

async function sceneFailed(browser, origin, scheme) {
  const { context, page } = await open(browser, origin, scheme, "fail");
  await openUpdatesPage(page);
  check(`${scheme} 실패: 상태 칩`, (await page.getByTestId("update-status").getAttribute("data-update-state")) === "failed");
  const row = page.getByTestId("connection-log-update-check-failed");
  check(`${scheme} 실패: 연결 기록이 센다`, ((await row.textContent()) ?? "").includes("1"), await row.textContent());
  await row.scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(OUT_DIR, `3-settings-failed-${scheme}.png`), fullPage: true });
  // 다시 붙었다: 「다시 시도」 → 최신 + 마지막 확인 시각.
  await page.evaluate(() => { window.__updateMode = "none"; });
  await page.getByTestId("update-error").getByRole("button").click();
  await page.waitForTimeout(300);
  check(`${scheme} 다시 시도 뒤 최신`, (await page.getByTestId("update-status").getAttribute("data-update-state")) === "current");
  check(`${scheme} 마지막 확인 시각이 선다`, (await page.getByTestId("update-last-checked").count()) === 1);
  await page.getByTestId("updates-page").scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(OUT_DIR, `4-settings-current-${scheme}.png`), fullPage: true });
  await context.close();
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  try {
    for (const scheme of ["light", "dark"]) {
      await scenePill(browser, preview.origin, scheme, false);
      await sceneOff(browser, preview.origin, scheme);
      await sceneFailed(browser, preview.origin, scheme);
    }
    await scenePill(browser, preview.origin, "light", true);
  } finally {
    await browser.close();
    await preview.stop?.();
  }
  if (failures.length) {
    console.error(`\n${failures.length} FAIL`);
    process.exit(1);
  }
  console.log("\nall ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
