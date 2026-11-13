// 설정 > 업데이트 > 「연결 기록」 캡처 (#5587). 데스크탑 셸을 흉내 낸 번들 Chromium(헤드리스)에서 밝게·어둡게 찍는다.
//
//   CAPTURE_PORT=26021 OUT_DIR=<폴더> node scripts/capture-5587.mjs
//
// 개발 서버(vite)를 이 칸의 포트로 띄우고, 가짜 서버(route)·가짜 소켓·가짜 데스크탑(`__TAURI_INTERNALS__`)을 물린다. 기록은 오늘 하루를
// 흉내 낸 값(시각과 종류뿐)을 저장소에 미리 넣는다. 끝나면 띄운 개발 서버를 그 PID로 끝낸다.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/5587");
const PORT = Number(process.env.CAPTURE_PORT || 26021);
const ORIGIN = `http://127.0.0.1:${PORT}`;

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const channels = [
  { id: "00000000-0000-7000-8000-000000000201", workspaceId, kind: "public", name: "workbench", muted: false },
  { id: "00000000-0000-7000-8000-000000000202", workspaceId, kind: "public", name: "general", muted: false },
];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "김하늘", handle: "haneul" },
  realtimeWebSocketUrl: "ws://capture.invalid/connection/websocket",
};
const roster = [
  {
    id: memberId, workspaceId, kind: "human", status: "active", role: "owner", displayName: "김하늘",
    handle: "haneul", channelCount: 2, channelIds: channels.map((c) => c.id), capabilities: [],
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
    if (path.endsWith(`/workspaces/${workspaceId}`)) return json(route, { workspace: { id: workspaceId, name: "여명거리" } });
    if (path.includes("/messages")) return json(route, { messages: [] });
    return json(route, {});
  });
}

async function installShell(page, corrupt) {
  await page.addInitScript((corruptStore) => {
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
          if (c.connect) return { id: c.id, connect: { client: "capture", version: "6" } };
          if (c.subscribe) return { id: c.id, subscribe: { recoverable: true, positioned: true, recovered: false, epoch: "cap", offset: 0 } };
          return { id: c.id };
        });
        queueMicrotask(() => this.onmessage?.(new MessageEvent("message", { data: replies.map((r) => JSON.stringify(r)).join("\n") })));
      }
      close() { this.readyState = 3; this.onclose?.(new CloseEvent("close", { code: 1000 })); }
    }
    window.WebSocket = CaptureSocket;
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
      transformCallback: () => 1,
      unregisterCallback: () => undefined,
      convertFileSrc: (p) => p,
      async invoke(cmd) {
        if (cmd.startsWith("plugin:event|")) return 1;
        if (cmd === "updater_check") return null;
        if (cmd === "app_version") return "0.1.46";
        if (cmd === "keychain_available") return true;
        if (cmd === "keychain_store_refresh_token") { window.__kc = true; return null; }
        if (cmd === "keychain_refresh_token_handle") return window.__kc ? "shell:00000000000000000000000000000001" : null;
        if (cmd === "keychain_clear_refresh_token") { window.__kc = false; return null; }
        if (cmd === "deep_link_take_pending") return [];
        if (cmd === "detect_local_harnesses") return { harnesses: [] };
        if (cmd === "detect_hosted_agents") return [];
        if (cmd === "notification_permission") return "denied";
        return null;
      },
    };
    // 오늘 하루를 흉내 낸 기록: 시각과 종류뿐이다(저장 모양은 코어 diagnosticLog.ts).
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const at = (h, m) => midnight.getTime() + (h * 60 + m) * 60_000;
    const day = [
      [at(0, 5), "window.blur"], [at(0, 5), "window.hidden"],
      [at(0, 41), "wake.late.10m"], [at(0, 41), "rest.fail.timeoutLate"], [at(0, 41), "rest.fail.timeoutLate"],
      [at(0, 41), "rest.fail.timeoutLate"], [at(0, 41), "socket.disconnected"], [at(0, 41), "socket.connected"],
      [at(1, 12), "device.offline"], [at(1, 12), "send.blocked.deviceOffline"],
      [at(1, 12), "device.online"], [at(1, 12), "send.open"],
      [at(1, 30), "rest.fail.network"], [at(1, 30), "rest.fail.network"], [at(1, 30), "rest.fail.gateway"],
      [at(1, 30), "rest.declared"], [at(1, 30), "send.blocked.serverUnreachable"],
      [at(1, 31), "rest.cleared"], [at(1, 31), "send.open"],
      [at(1, 50), "window.visible"], [at(1, 50), "window.focus"],
    ].filter(([time]) => time <= Date.now());
    // 망가진 저장값(수리 1회차 H1): 날짜로 만들 수 없는 시각·음수·빈 값·모양이 다른 값이 섞여도 카드는 서고 멀쩡한 기록만 센다.
    if (corruptStore) day.push([1e20, "device.online"], [-5, "device.offline"], [null, "send.open"], ["x", "window.hidden"], [at(1, 40)]);
    try { localStorage.setItem("momo.connection.diag.v1", JSON.stringify(day)); } catch { /* 저장소 없는 캡처 */ }
  }, corrupt);
}

async function waitForServer() {
  for (let i = 0; i < 120; i += 1) {
    try {
      const res = await fetch(ORIGIN);
      if (res.ok) return;
    } catch { /* 아직 안 떴다 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`개발 서버가 ${ORIGIN}에 뜨지 않았다`);
}

async function scene(browser, scheme, variant) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: scheme, locale: "ko-KR", serviceWorkers: "block" });
  await installRoutes(context);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error.message)));
  await installShell(page, variant === "corrupt");
  await page.addInitScript((server) => { try { localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ } }, ORIGIN);
  await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("sidebar-profile-foot").waitFor({ timeout: 90_000 });
  await page.evaluate(() => { window.location.hash = "#/settings?section=updates"; });
  const card = page.getByTestId("connection-log");
  try {
    await card.waitFor({ timeout: 45_000 });
  } catch (error) {
    await page.screenshot({ path: resolve(OUT_DIR, `debug-${scheme}.png`) });
    console.error(`hash=${await page.evaluate(() => window.location.hash)} updates=${await page.getByTestId("updates-page").count()}`);
    throw error;
  }
  // 처음 뜬 앱이 여는 「업데이트 소식」 창을 닫는다(이 캡처의 대상이 아니다).
  const dialog = page.getByRole("dialog");
  if (await dialog.count()) {
    await page.keyboard.press("Escape");
    await dialog.first().waitFor({ state: "detached", timeout: 10_000 }).catch(() => undefined);
  }
  await card.scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  await page.screenshot({ path: resolve(OUT_DIR, `settings-updates-${variant}-${scheme}.png`) });
  await card.screenshot({ path: resolve(OUT_DIR, `connection-log-card-${variant}-${scheme}.png`) });
  const line = async (id) => ((await page.getByTestId(id).textContent()) ?? "").replace(/\s+/g, " ").trim();
  const fallback = await page.getByTestId("render-error-boundary").count();
  console.log(
    `${variant}/${scheme}: ${await line("connection-log-send-blocked")} · ${await line("connection-log-rest-failed")} · ` +
      `${await line("connection-log-cut-while-resting")} · 무너진 카드 ${fallback} · 페이지 오류 ${errors.filter((e) => e.includes("RangeError")).length}`
  );
  if (variant === "normal") {
    // 복사를 눌러 결과 알림을 찍는다(헤드리스 Chromium은 클립보드 권한이 없어 실패 문장이 보이는 쪽이 보통이다).
    await page.getByTestId("connection-log-copy").click();
    await page.waitForTimeout(300);
    const announced = (await card.locator('[role="status"]').textContent()) ?? "";
    console.log(`${variant}/${scheme}: 복사 뒤 알림 = 「${announced}」`);
    await card.screenshot({ path: resolve(OUT_DIR, `connection-log-card-after-copy-${scheme}.png`) });
  }
  await context.close();
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const server = spawn(resolve(WEB_ROOT, "node_modules/.bin/vite"), ["--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
    cwd: WEB_ROOT,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: "ignore",
  });
  console.log(`개발 서버 PID ${server.pid}`);
  try {
    await waitForServer();
    const browser = await chromium.launch();
    try {
      for (const scheme of ["light", "dark"]) {
        for (const variant of ["normal", "corrupt"]) await scene(browser, scheme, variant);
      }
    } finally {
      await browser.close();
    }
  } finally {
    server.kill("SIGTERM");
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
