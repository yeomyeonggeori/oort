#!/usr/bin/env node
// =============================================================================
// 설정 > 모양 > 글꼴 캡처 (#3774 단계 2): 기본 · 적용 · 목록 · 거부 · 잘못된 이름.
//
//   npm run build && OUT_DIR=<폴더> node scripts/capture-settings-font.mjs
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
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/settings-font");
const PORT = Number(process.env.CAPTURE_PORT || 5198);

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const channels = [{ id: "00000000-0000-7000-8000-000000000201", workspaceId, kind: "public", name: "workbench", muted: false }];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: "ws://settings-font-capture.invalid/connection/websocket",
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
          if (c.connect) return { id: c.id, connect: { client: "settings-font-capture", version: "6" } };
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


const FONT_STATE = JSON.stringify({ scheme: "system", accent: "dawn", fontSans: "Georgia", fontMono: "Courier New" });

const SCENES = [
  { name: "font-default-unsupported", init: () => { delete window.queryLocalFonts; } },
  { name: "font-custom-applied", init: () => { delete window.queryLocalFonts; }, state: FONT_STATE },
  {
    name: "font-list-loaded",
    init: () => { window.queryLocalFonts = async () => [{ family: "Georgia" }, { family: "Courier New" }, { family: "Menlo" }, { family: "Avenir Next" }]; },
    after: async (page) => { await page.getByTestId("font-list-load").click(); await page.getByTestId("font-list").filter({ hasText: "4개를 불러왔어요" }).waitFor({ timeout: 5000 }); },
  },
  {
    name: "font-denied",
    init: () => { window.queryLocalFonts = async () => { const e = new Error("denied"); e.name = "NotAllowedError"; throw e; }; },
    after: async (page) => { await page.getByTestId("font-list-load").click(); await page.getByTestId("font-list").filter({ hasText: "권한이 없어요" }).waitFor({ timeout: 5000 }); },
  },
  {
    name: "font-invalid-name",
    init: () => { delete window.queryLocalFonts; },
    after: async (page) => { await page.getByTestId("font-sans-input").fill('Evil"; } body {'); await page.getByTestId("font-sans-apply").click(); await page.getByTestId("font-sans-error").waitFor({ timeout: 5000 }); },
  },
];

async function scene(browser, origin, def, scheme) {
  const tag = `${def.name}-1440-${scheme}`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1500 }, colorScheme: scheme, reducedMotion: "reduce", serviceWorkers: "block" });
  await installRoutes(context, {});
  const page = await context.newPage();
  await installRealtime(page);
  await page.addInitScript(def.init);
  await page.addInitScript(({ server, state }) => {
    try { localStorage.setItem("momo.web.server.v1", server); if (state) localStorage.setItem("momo.web.appearance.v1", state); } catch { /* 저장소 없는 캡처 */ }
  }, { server: origin, state: def.state ?? null });
  await signIn(page, origin);
  await page.evaluate(() => { location.hash = "/settings?section=appearance"; });
  try {
    await page.getByTestId("font-sans-input").waitFor({ timeout: 10_000 });
    if (def.after) await def.after(page);
    await page.waitForTimeout(250);
    const applied = await page.evaluate(() => ({
      body: getComputedStyle(document.body).fontFamily,
      code: getComputedStyle(document.querySelector("[data-testid=font-preview] code")).fontFamily,
    }));
    console.log(tag, JSON.stringify(applied));
    if (def.state) check(`${tag} 본문 글꼴이 Georgia로 시작`, applied.body.startsWith("Georgia"), applied);
    if (def.state) check(`${tag} 코드 글꼴이 Courier New로 시작`, applied.code.startsWith('"Courier New"'), applied);
    if (!def.state) check(`${tag} 시스템 서체 그대로`, !applied.body.includes("Georgia"), applied);
    await page.getByTestId("font-preview").scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(OUT_DIR, `${tag}.png`) });
  } catch (error) {
    await page.screenshot({ path: resolve(OUT_DIR, `FAIL-${tag}.png`) }).catch(() => {});
    throw error;
  } finally {
    await context.close();
  }
}

mkdirSync(OUT_DIR, { recursive: true });
if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) throw new Error("dist/ is missing. Run npm run build first.");
const server = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
const browser = await chromium.launch();
try {
  for (const def of SCENES) for (const scheme of ["light", "dark"]) await scene(browser, server.origin, def, scheme);
} finally {
  await browser.close();
  await server.stop();
}
writeFileSync(resolve(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));
console.log(failures.length ? `FAILED ${failures.length}` : "all ok");
process.exit(failures.length ? 1 : 0);
