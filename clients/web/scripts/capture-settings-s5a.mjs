#!/usr/bin/env node
// =============================================================================
// 설정 S5a 캡처 (#3615, 에픽 #3578): 알림 · 단축키(+터미널) · 업데이트.
//
//   npm run build && OUT_DIR=<폴더> node scripts/capture-settings-s5a.mjs
//
// 진짜 앱 셸을 Chromium으로 연다. `/v1/**`는 고정 응답, 실시간 소켓은 곧바로 연결되는
// 흉내. 데스크탑 장면은 `__TAURI_INTERNALS__` 흉내다(업데이트·터미널 색·OS 알림 권한).
// 실제 업데이트 서버도 OS 알림도 건드리지 않는다.
//
// 모든 장면은 **기다리는 값이 기대 상태**다: 다른 상태이면 시간 초과로 실패하고
// `FAIL-<장면>.png`를 남긴다. 상태 장면(403·오프라인·로딩·빈)은 라이트/다크 × 1440/390.
// =============================================================================

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/settings-s5a");
const PORT = Number(process.env.CAPTURE_PORT || 5197);

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const channels = [{ id: "00000000-0000-7000-8000-000000000201", workspaceId, kind: "public", name: "workbench", muted: false }];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: "ws://settings-s5a-capture.invalid/connection/websocket",
};
const roster = [
  {
    id: memberId, workspaceId, kind: "human", status: "active", role: "owner", displayName: "곽성재",
    handle: "seongjae", channelCount: 1, channelIds: channels.map((c) => c.id), capabilities: [],
    createdAtMs: 0, updatedAtMs: 0,
  },
];
const UPDATE = {
  version: "0.1.20", currentVersion: "0.1.19",
  notes: "인박스 필터가 새로고침 뒤에도 유지돼요.\n단축키 설정이 카드로 바뀌었어요.",
  publishedAt: "2026-10-07T09:00:00Z",
};

const failures = [];
const report = { scenes: [], checks: [] };
function check(name, ok, detail) {
  report.checks.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures.push(name);
}
const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function installRoutes(context, cfg) {
  await context.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId });
    }
    if (path.endsWith("/notification-rules")) {
      if (cfg.rules === "403") return json(route, { error: { code: "forbidden", message: "active human membership required" } }, 403);
      if (cfg.rules === "500") return json(route, { error: { code: "internal", message: "boom" } }, 500);
      if (cfg.rules === "hang") return new Promise(() => {});
      return json(route, { dnd: false, mentionOverridesMute: true });
    }
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: [] });
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
          if (c.connect) return { id: c.id, connect: { client: "settings-s5a-capture", version: "6" } };
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

async function installDesktop(page, cfg) {
  await page.addInitScript(({ cfg, update }) => {
    const callbacks = new Map();
    let nextCallback = 1;
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
      transformCallback(callback) { const id = nextCallback++; callbacks.set(id, callback); return id; },
      unregisterCallback(id) { callbacks.delete(id); },
      convertFileSrc: (p) => p,
      async invoke(cmd) {
        if (cmd === "keychain_store_refresh_token") { window.__h = "shell:" + "c".repeat(32); return null; }
        if (cmd === "keychain_refresh_token_handle") return window.__h ?? null;
        if (cmd === "harness_profile_list") return [];
        if (cmd === "work_host_status") return null;
        if (cmd === "detect_local_harnesses") return { harnesses: [] };
        if (cmd === "detect_hosted_agents") return [];
        if (cmd === "keychain_available") return false;
        if (cmd === "deep_link_take_pending") return [];
        if (cmd === "app_version") return "0.1.19";
        if (cmd === "notification_permission") return cfg.perm;
        if (cmd === "updater_check") {
          if (cfg.updater === "hang") return new Promise(() => {});
          if (cfg.updater === "fail") throw new Error("Network Error: updater manifest unreachable");
          return cfg.updater === "current" ? null : update;
        }
        if (cmd === "updater_install") {
          if (cfg.install === "hang") return new Promise(() => {});
          return null;
        }
        if (cmd.startsWith("plugin:event|")) return 1;
        return null;
      },
    };
  }, { cfg, update: UPDATE });
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

const VIEWPORTS = [
  { w: 1440, h: 1400 },
  { w: 390, h: 2600 },
];

async function scene(browser, origin, def, scheme, vp) {
  const tag = `${def.name}-${vp.w}-${scheme}`;
  const cfg = { rules: "ok", perm: "granted", updater: "current", install: "ok", ...def.cfg };
  const context = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, colorScheme: scheme, reducedMotion: "reduce", serviceWorkers: "block" });
  await installRoutes(context, cfg);
  const page = await context.newPage();
  await installRealtime(page);
  if (def.desktop) await installDesktop(page, cfg);
  else await page.addInitScript((perm) => {
    // 브라우저 탭 장면: 알림 권한 API를 고정된 값으로 흉내 낸다.
    window.Notification = class { static permission = perm; static requestPermission() { return Promise.resolve(perm); } };
  }, cfg.perm);
  await page.addInitScript((server) => { try { localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ } }, origin);
  await signIn(page, origin);
  await page.evaluate((hash) => { location.hash = hash; }, `/settings?section=${def.section}`);
  try {
    await def.ready(page, tag);
    if (def.after) await def.after(page, context);
    await page.waitForTimeout(250);
    const overflow = await page.evaluate(() => {
      const v = document.querySelector("[data-settings-scroll-viewport]") ?? document.documentElement;
      return Math.max(document.documentElement.scrollWidth - document.documentElement.clientWidth, v.scrollWidth - v.clientWidth);
    });
    check(`${tag} 가로 넘침 0`, overflow <= 0, { overflow });
    // 잘린 컨트롤이 없다: 모든 스위치가 화면 폭 안에 온전히 들어온다(좁은 폭에서 표 열이 잘리던 결함).
    const clipped = await page.evaluate((width) =>
      [...document.querySelectorAll('[role="switch"]')].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && (r.right > width + 0.5 || r.left < -0.5);
      }).length, vp.w);
    check(`${tag} 화면 밖으로 잘린 스위치 0`, clipped === 0, { clipped });
    if (def.verify) await def.verify(page, tag);
    await page.screenshot({ path: resolve(OUT_DIR, `${tag}.png`) });
    report.scenes.push(tag);
  } catch (error) {
    await page.screenshot({ path: resolve(OUT_DIR, `FAIL-${tag}.png`) }).catch(() => {});
    throw error;
  } finally {
    await context.close();
  }
}

const waitText = (page, id, text) => page.getByTestId(id).filter({ hasText: text }).waitFor({ timeout: 10_000 });
const rulesReady = (page) => page.getByTestId("notification-rules-dnd").waitFor({ timeout: 10_000 });
const noCheckbox = async (page, tag) =>
  check(`${tag} 네이티브 체크박스가 없다(스위치만)`, (await page.locator("main input[type=checkbox], [data-testid=settings-route] input[type=checkbox]").count()) === 0);

const SCENES = [
  {
    name: "notifications-desktop", section: "notifications", desktop: true, cfg: { perm: "granted" },
    ready: async (page) => { await rulesReady(page); await page.getByTestId("desktop-notifications-granted").waitFor(); },
    verify: async (page, tag) => {
      await noCheckbox(page, tag);
      check(`${tag} 스위치: 규칙 2 + 종류 6 + 독 DM 1 + 독 배지 1`, (await page.getByRole("switch").count()) === 10, { n: await page.getByRole("switch").count() });
      check(`${tag} 서버 규칙 값이 스위치에 보인다(멘션 켬)`, (await page.getByTestId("notification-rules-mention").getAttribute("aria-checked")) === "true");
    },
  },
  {
    name: "notifications-browser", section: "notifications", desktop: false, cfg: { perm: "default" },
    ready: async (page) => { await rulesReady(page); await page.getByTestId("desktop-notifications-enable").waitFor(); },
    verify: async (page, tag) => {
      await noCheckbox(page, tag);
      check(`${tag} 독 배지 카드가 없다(브라우저)`, (await page.getByTestId("desktop-notification-dock-badge").count()) === 0);
    },
  },
  {
    name: "notifications-denied", section: "notifications", desktop: true, cfg: { perm: "denied" },
    ready: async (page) => { await rulesReady(page); await page.getByTestId("desktop-notifications-denied").waitFor(); },
  },
  {
    name: "notifications-403", section: "notifications", desktop: false, cfg: { rules: "403", perm: "granted" },
    ready: async (page) => { await waitText(page, "notification-rules-error", "사람 멤버만 알림 규칙을 정할 수 있어요."); },
    verify: async (page, tag) => {
      check(`${tag} 다시 불러오기 단추가 없다`, (await page.locator("[data-testid=notification-rules-error] button").count()) === 0);
      check(`${tag} 운영자 문의 문구가 없다`, !(await page.locator("body").innerText()).includes("서버 운영자에게 문의"));
    },
  },
  {
    name: "notifications-error", section: "notifications", desktop: false, cfg: { rules: "500", perm: "granted" },
    ready: async (page) => { await waitText(page, "notification-rules-error", "불러오지 못했어요"); },
    verify: async (page, tag) =>
      check(`${tag} 다시 불러오기 단추가 있다`, (await page.locator("[data-testid=notification-rules-error] button").count()) === 1),
  },
  {
    name: "notifications-loading", section: "notifications", desktop: false, cfg: { rules: "hang", perm: "granted" },
    ready: async (page) => { await page.locator("[data-testid=notification-rules-section] [data-testid=skeleton][data-ready=false]").waitFor({ timeout: 10_000 }); },
    verify: async (page, tag) =>
      check(`${tag} 규칙 스위치는 아직 없다`, (await page.getByTestId("notification-rules-dnd").count()) === 0),
  },
  {
    name: "notifications-offline", section: "notifications", desktop: false, cfg: { perm: "granted" },
    ready: async (page) => { await rulesReady(page); },
    after: async (page, context) => {
      await context.setOffline(true);
      await page.evaluate(() => window.dispatchEvent(new Event("offline")));
      await page.getByTestId("settings-offline-banner").waitFor({ timeout: 10_000 });
      await page.getByTestId("notification-rules-offline").waitFor({ timeout: 10_000 });
    },
    verify: async (page, tag) =>
      check(`${tag} 규칙 스위치가 잠겼다`, await page.getByTestId("notification-rules-dnd").isDisabled()),
  },
  {
    name: "shortcuts-browser", section: "shortcuts", desktop: false,
    ready: async (page) => { await page.getByTestId("shortcut-list").waitFor({ timeout: 10_000 }); },
    verify: async (page, tag) => {
      check(`${tag} 합쇼체가 없다`, !/(습니다|됩니다|웁니다)/.test(await page.locator("body").innerText()));
      check(`${tag} 터미널 색 고르기가 없다(브라우저)`, (await page.getByTestId("terminal-theme-choice").count()) === 0);
      check(`${tag} 터미널 키 목록은 있다`, (await page.getByTestId("terminal-shortcut-row").count()) > 0);
    },
  },
  {
    name: "shortcuts-desktop", section: "shortcuts", desktop: true,
    ready: async (page) => { await page.getByTestId("shortcut-list").waitFor({ timeout: 10_000 }); await page.getByTestId("terminal-theme-choice").waitFor(); },
    verify: async (page, tag) => {
      check(`${tag} 합쇼체가 없다`, !/(습니다|됩니다|웁니다)/.test(await page.locator("body").innerText()));
      check(`${tag} 터미널 색 기본은 어둡게`, await page.getByTestId("terminal-theme-choice-dark").isChecked());
      await page.getByTestId("terminal-theme-section").scrollIntoViewIfNeeded();
    },
  },
  {
    name: "shortcuts-empty", section: "shortcuts", desktop: false,
    ready: async (page) => { await page.getByTestId("shortcut-search").fill("zzzz-없는-단축키"); await page.getByTestId("shortcut-empty").waitFor({ timeout: 10_000 }); },
    verify: async (page, tag) => check(`${tag} 목록이 사라졌다`, (await page.getByTestId("shortcut-list").count()) === 0),
  },
  {
    name: "shortcuts-capture", section: "shortcuts", desktop: false,
    ready: async (page) => { await page.getByTestId("shortcut-list").waitFor({ timeout: 10_000 }); },
    after: async (page) => {
      await page.getByTestId("shortcut-change-open-inbox").click();
      await page.getByTestId("shortcut-capture").waitFor({ timeout: 5_000 });
      await page.keyboard.press("a"); // 수식 키 없이 누르면 안내가 뜬다
      await page.getByTestId("shortcut-notice").waitFor({ timeout: 5_000 });
    },
    verify: async (page, tag) =>
      check(`${tag} 안내 문장이 해당 행 안에 있다`, (await page.locator("[data-shortcut-row=open-inbox] [data-testid=shortcut-notice]").count()) === 1),
  },
  {
    name: "updates-current", section: "updates", desktop: true, cfg: { updater: "current" },
    ready: async (page) => { await waitText(page, "update-status", "최신"); },
  },
  {
    name: "updates-available", section: "updates", desktop: true, cfg: { updater: "available" },
    ready: async (page) => { await waitText(page, "update-status", "새 버전 있음"); await page.getByTestId("update-install").waitFor(); },
    verify: async (page, tag) => check(`${tag} 합쇼체가 없다`, !/습니다/.test(await page.locator("body").innerText())),
  },
  {
    name: "updates-installing", section: "updates", desktop: true, cfg: { updater: "available", install: "hang" },
    ready: async (page) => { await page.getByTestId("update-install").click(); await waitText(page, "update-status", "받는 중"); },
  },
  {
    name: "updates-installed", section: "updates", desktop: true, cfg: { updater: "available", install: "ok" },
    ready: async (page) => { await page.getByTestId("update-install").click(); await page.getByTestId("update-relaunch").waitFor({ timeout: 10_000 }); },
    verify: async (page, tag) => check(`${tag} 합쇼체가 없다`, !/습니다/.test(await page.locator("body").innerText())),
  },
  {
    name: "updates-failed", section: "updates", desktop: true, cfg: { updater: "fail" },
    ready: async (page) => { await waitText(page, "update-error", "닿지 못했어요"); },
    verify: async (page, tag) => check(`${tag} 합쇼체가 없다`, !/습니다/.test(await page.locator("body").innerText())),
  },
  {
    name: "updates-checking", section: "updates", desktop: true, cfg: { updater: "hang" },
    ready: async (page) => { await waitText(page, "update-status", "확인 중"); },
    verify: async (page, tag) => check(`${tag} 확인 단추가 잠겼다`, await page.getByTestId("update-check").isDisabled()),
  },
];

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) throw new Error("dist/ is missing. Run npm run build first.");
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  try {
    for (const scheme of ["light", "dark"]) {
      for (const vp of VIEWPORTS) {
        for (const def of SCENES) await scene(browser, preview.origin, def, scheme, vp);
      }
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
