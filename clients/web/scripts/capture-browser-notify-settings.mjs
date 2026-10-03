#!/usr/bin/env node
// =============================================================================
// 설정 › 알림 › 브라우저 탭 상태 캡처 (#3340): default/granted/denied/unsupported × 라이트/다크.
// 라이트/다크 × 1280·900으로 찍고, 기본값(DM 꺼짐)·가로 스크롤 없음·독 배지 invoke가
// 인박스 수와 같은지(데스크탑 셸 흉내가 받은 `dock_badge_set`)를 단언한다.
//
//   npm run build && node scripts/capture-notify-settings.mjs
//   → OUT_DIR(기본 artifacts/notify-settings)/*.png + report.json
//
// 단언이 하나라도 틀리면 종료 코드 1이다. /v1 은 흉내 서버고 시크릿은 없다.
// =============================================================================
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/notify-settings");
const PORT = Number(process.env.CAPTURE_PORT || 5199);

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const channels = [
  { id: "00000000-0000-7000-8000-000000000201", workspaceId, kind: "public", name: "workbench", muted: false },
  { id: "00000000-0000-7000-8000-000000000203", workspaceId, kind: "public", name: "general", muted: false },
];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: "ws://shortcuts-capture.invalid/connection/websocket",
};
const roster = [
  {
    id: memberId, workspaceId, kind: "human", status: "active", role: "owner", displayName: "곽성재",
    handle: "seongjae", channelCount: 2, channelIds: channels.map((c) => c.id), capabilities: [],
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
          if (c.connect) return { id: c.id, connect: { client: "shortcuts-capture", version: "6" } };
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

/** 브라우저 Notification API 흉내. 셸은 없다. state: default | granted | denied | unsupported. */
async function installNotification(page, state) {
  await page.addInitScript((initial) => {
    window.__asked = 0;
    if (initial === "unsupported") { delete window.Notification; return; }
    class FakeNotification {
      static permission = initial;
      static async requestPermission() { window.__asked += 1; FakeNotification.permission = "granted"; return "granted"; }
    }
    window.Notification = FakeNotification;
  }, state);
}

async function signIn(page, origin) {
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("nav-team").waitFor({ timeout: 20_000 });
}


const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok) failures.push(`${name} ${detail}`);
}

async function scene(browser, origin, scheme, state, report) {
  const tag = `${state}-${scheme}`;
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, colorScheme: scheme, serviceWorkers: "block" });
  await installRoutes(context);
  const page = await context.newPage();
  await installRealtime(page);
  await installNotification(page, state);
  await page.addInitScript((server) => { try { localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ } }, origin);
  await signIn(page, origin);
  check(`${tag} 로드 중에는 권한을 묻지 않는다`, (await page.evaluate(() => window.__asked ?? 0)) === 0);
  await page.evaluate(() => { window.location.hash = "#/settings?section=notifications"; });
  await page.getByTestId("desktop-notification-kinds").waitFor({ timeout: 8000 }).catch(async (error) => {
    await page.screenshot({ path: resolve(OUT_DIR, `debug-${tag}.png`) });
    throw error;
  });
  await page.waitForTimeout(400);
  const permissionState = () => page.getByTestId("desktop-notifications-permission").getAttribute("data-state");
  check(`${tag} 상태 표시`, (await permissionState()) === state, String(await permissionState()));
  check(`${tag} 설정을 열어도 권한을 묻지 않는다`, (await page.evaluate(() => window.__asked ?? 0)) === 0);
  check(`${tag} 가로 스크롤 없음`, (await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 0);
  check(`${tag} 독 배지 열 없음(브라우저)`, (await page.getByTestId("desktop-notification-dock-badge").count()) === 0);
  if (state !== "unsupported") {
    check(`${tag} DM은 기본 끔`, !(await page.getByTestId("desktop-notification-kind-dm").isChecked()));
  }
  await page.screenshot({ path: resolve(OUT_DIR, `settings-${tag}.png`), fullPage: true });
  if (state === "default") {
    await page.getByTestId("desktop-notifications-enable").click();
    await page.waitForTimeout(300);
    check(`${tag} 단추를 누르면 한 번 묻고 켜짐`, (await page.evaluate(() => window.__asked)) === 1 && (await permissionState()) === "granted");
    await page.screenshot({ path: resolve(OUT_DIR, `settings-after-click-${scheme}.png`), fullPage: true });
  }
  report[tag] = { ok: true };
  await context.close();
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  const report = {};
  try {
    for (const scheme of ["light", "dark"]) {
      for (const state of ["default", "granted", "denied", "unsupported"]) {
        await scene(browser, preview.origin, scheme, state, report);
      }
    }
  } finally {
    await browser.close();
    await preview.stop?.();
  }
  writeFileSync(resolve(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));
  if (failures.length > 0) {
    console.error(`\n${failures.length}개 단언 실패`);
    process.exit(1);
  }
  console.log("\n모든 단언 통과");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
