#!/usr/bin/env node
// =============================================================================
// 설정 › 단축키 측정 (#3281): 실제 Chromium에서 목록·검색·키 입력·충돌 경고를 라이트/다크로
// 찍고, 줄 높이가 키 입력 중에 흔들리지 않는지(레이아웃 시프트 0), 가로 스크롤이 없는지,
// 바꾼 키가 새로고침 뒤에도 남는지 단언한다.
//
//   npm run build && node scripts/capture-shortcuts-settings.mjs
//   → OUT_DIR(기본 artifacts/shortcuts-settings)/*.png + report.json
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
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/shortcuts-settings");
const PORT = Number(process.env.CAPTURE_PORT || 5198);

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

/** 데스크탑 셸 흉내(설정 화면만 열면 되므로 명령은 빈 답이다). */
async function installDesktop(page) {
  await page.addInitScript(() => {
    const callbacks = new Map();
    let next = 1;
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
      transformCallback(cb) { const id = next++; callbacks.set(id, cb); return id; },
      unregisterCallback(id) { callbacks.delete(id); },
      convertFileSrc: (p) => p,
      async invoke(cmd) {
        if (cmd === "keychain_available") return true;
        if (cmd === "keychain_store_refresh_token") { window.__kc = true; return null; }
        if (cmd === "keychain_refresh_token_handle") return window.__kc ? "shell:00000000000000000000000000000001" : null;
        if (cmd === "keychain_clear_refresh_token") { window.__kc = false; return null; }
        if (cmd === "app_version") return "0.1.15";
        if (cmd === "notification_permission") return "denied";
        if (cmd === "deep_link_take_pending") return [];
        if (cmd.startsWith("plugin:event|")) return 1;
        return null;
      },
    };
  });
}

async function signIn(page, origin) {
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("rail-team").waitFor({ timeout: 20_000 });
}

const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok) failures.push(`${name} ${detail}`);
}

const rowBox = (page, id) =>
  page.evaluate((rid) => {
    const el = document.querySelector(`[data-shortcut-row="${rid}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { y: Math.round(r.y * 10) / 10, h: Math.round(r.height * 10) / 10, w: Math.round(r.width * 10) / 10 };
  }, id);

async function scene(browser, origin, scheme, desktop, report, width = 1280) {
  const tag = `${desktop ? "desktop" : "web"}-${scheme}${width === 1280 ? "" : `-${width}`}`;
  const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme, serviceWorkers: "block" });
  await installRoutes(context);
  const page = await context.newPage();
  await installRealtime(page);
  if (desktop) await installDesktop(page);
  await page.addInitScript((server) => { try { localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ } }, origin);
  await signIn(page, origin);
  // 세션이 메모리에만 있으므로 새로 불러오지 않고 앱 안에서 이동한다(⌘, 와 같은 경로).
  await page.evaluate(() => { window.location.hash = "#/settings?section=shortcuts"; });
  await page.getByTestId("shortcut-list").waitFor({ timeout: 8000 }).catch(async (error) => {
    await page.screenshot({ path: resolve(OUT_DIR, `debug-${tag}.png`) });
    throw error;
  });
  const shot = (name) => page.screenshot({ path: resolve(OUT_DIR, `${name}-${tag}.png`) });
  const out = {};

  await page.waitForTimeout(300);
  await shot("1-list");
  out.scrollX = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(`${tag} 가로 스크롤 없음`, out.scrollX <= 0, String(out.scrollX));
  const ids = await page.evaluate(() => [...document.querySelectorAll("[data-shortcut-row]")].map((e) => e.getAttribute("data-shortcut-row")));
  check(`${tag} 목록에 ⌘K·⌘B가 있다`, ids.includes("open-quick-switcher") && ids.includes("toggle-sidebar"));
  check(`${tag} 데스크탑 전용 줄(${ids.filter((i) => i.startsWith("terminal:")).length}개)이 두 환경 모두에 표시된다`, ids.some((i) => i.startsWith("terminal:")));
  const label = await page.evaluate(() => document.querySelector('[data-shortcut-row="terminal:jump-palette"]')?.textContent ?? "");
  check(`${tag} 데스크탑 전용 표시`, label.includes("데스크탑 전용"));

  // 터미널·작업 공간 묶음(데스크탑 전용 줄)
  await page.locator('[data-shortcut-row="terminal:toggle-dock"]').scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, 0));
  await page.waitForTimeout(150);
  await shot("1b-terminal-group");
  await page.locator('[data-shortcut-row="open-quick-switcher"]').scrollIntoViewIfNeeded();

  // 검색
  await page.getByTestId("shortcut-search").fill("인박스");
  await page.waitForTimeout(150);
  await shot("2-search");
  const found = await page.evaluate(() => [...document.querySelectorAll("[data-shortcut-row]")].map((e) => e.getAttribute("data-shortcut-row")));
  check(`${tag} 검색은 이름으로 거른다`, found.length === 1 && found[0] === "open-inbox", JSON.stringify(found));
  await page.getByTestId("shortcut-search").fill("");

  // 키 입력: 줄 높이가 흔들리지 않는다.
  const before = await rowBox(page, "open-inbox");
  const beforeNext = await rowBox(page, "move-unread-channel");
  await page.getByTestId("shortcut-change-open-inbox").click();
  await page.getByTestId("shortcut-capture").waitFor();
  await page.waitForTimeout(150);
  await shot("3-capture");
  const during = await rowBox(page, "open-inbox");
  const duringNext = await rowBox(page, "move-unread-channel");
  check(`${tag} 키 입력 중에도 줄 높이·아래 줄 위치가 그대로다`, before.h === during.h && beforeNext.y === duringNext.y, JSON.stringify({ before, during, beforeNext, duringNext }));
  check(`${tag} 키 입력 칸이 포커스를 가진다`, await page.evaluate(() => document.activeElement?.getAttribute("data-testid") === "shortcut-capture"));

  // 충돌: 설정 줄에서 ⌘K(또는 Ctrl+K)를 누른다.
  await page.keyboard.press("Escape");
  const cancelled = await page.getByTestId("shortcut-capture").count();
  check(`${tag} Esc가 키 입력을 취소한다`, cancelled === 0);
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.getByTestId("shortcut-change-open-settings").click();
  await page.keyboard.press(`${modifier}+K`);
  await page.getByTestId("shortcut-notice").waitFor();
  await page.waitForTimeout(150);
  await shot("4-conflict");
  const paletteOpen = await page.getByRole("dialog").count();
  check(`${tag} 입력 중 ⌘K는 팔레트를 열지 않는다`, paletteOpen === 0);
  const noticeText = await page.getByTestId("shortcut-notice").textContent();
  check(`${tag} 충돌 경고가 상대 항목을 말한다`, (noticeText ?? "").includes("검색과 이동 열기"), noticeText ?? "");

  // 예약 키
  await page.getByTestId("shortcut-swap-cancel").click();
  await page.getByTestId("shortcut-change-open-inbox").click();
  await page.keyboard.press(`${modifier}+Q`);
  await page.waitForTimeout(100);
  await shot("5-reserved");
  const reservedText = (await page.getByTestId("shortcut-notice").textContent()) ?? "";
  check(`${tag} 예약 키 안내`, reservedText.includes("앱 종료"), reservedText);

  // 바꾸기 + 지속
  await page.keyboard.press(`${modifier}+Shift+Y`);
  await page.waitForTimeout(150);
  await shot("6-changed");
  const stored = await page.evaluate(() => localStorage.getItem("oort.shortcuts.v1"));
  check(`${tag} 바꾼 키가 이 기기에 저장된다`, stored !== null && stored.includes("KeyY"), String(stored));

  report[tag] = out;
  await context.close();
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  const report = {};
  try {
    for (const scheme of ["light", "dark"]) {
      await scene(browser, preview.origin, scheme, false, report);
    }
    await scene(browser, preview.origin, "light", true, report);
    await scene(browser, preview.origin, "dark", true, report);
    // 좁은 창(900): 설정 목차와 이름 열이 좁아져도 줄이 무너지지 않는다.
    await scene(browser, preview.origin, "light", true, report, 900);
    await scene(browser, preview.origin, "dark", false, report, 900);
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
