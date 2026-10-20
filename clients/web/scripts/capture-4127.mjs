#!/usr/bin/env node
// =============================================================================
// 기억 브라우저 필터·멤버 프로필 역할 칸 캡처 (#4127). 네이티브 select(전) 대 앱이 그린 listbox(후)를
// 라이트/다크 1440 으로 찍고, 진짜 번들 위에서 단언한다. 장면 틀은 capture-4123.mjs 와 같다.
//
//   npm run build && node scripts/capture-4127.mjs                       # 후(listbox)
//   BEFORE=1 OUT_DIR=captures/4127/before node scripts/capture-4127.mjs  # 전(네이티브 select)
// =============================================================================
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "captures/4127");
const PORT = Number(process.env.CAPTURE_PORT || 5199);

const FIXED_NOW = Date.parse("2026-10-16T21:07:00+09:00");

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const peerId = "00000000-0000-7000-8000-000000000102";
const channels = [
  { id: "00000000-0000-7000-8000-000000000201", workspaceId, kind: "public", name: "workbench", muted: false },
  { id: "00000000-0000-7000-8000-000000000203", workspaceId, kind: "public", name: "general", muted: false },
];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: "ws://pause-capture.invalid/connection/websocket",
};

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}


const items = [
  { id: "00000000-0000-7000-8000-000000000701", channelId: channels[0].id, spaceKind: "channel", kind: "decision", origin: "confirmed", body: "결제 재시도 큐는 크기를 두 배로 늘려서 운영하기로 했어요.", validFromMs: FIXED_NOW - 86_400_000, recordedAtMs: FIXED_NOW - 86_400_000, confidence: 0.9, sourceCount: 2 },
  { id: "00000000-0000-7000-8000-000000000702", channelId: channels[1].id, spaceKind: "channel", kind: "fact", origin: "confirmed", body: "배포는 목요일 오전에 해요.", validFromMs: FIXED_NOW - 172_800_000, recordedAtMs: FIXED_NOW - 172_800_000, confidence: 0.8, sourceCount: 1 },
];

function roster() {
  return [
    { id: memberId, workspaceId, kind: "human", status: "active", role: "owner", displayName: "곽성재", handle: "seongjae", channelCount: 2, channelIds: channels.map((c) => c.id), capabilities: [], createdAtMs: 0, updatedAtMs: 0 },
    { id: peerId, workspaceId, kind: "human", status: "active", role: "member", displayName: "서연", handle: "seoyeon", channelCount: 1, channelIds: [channels[0].id], capabilities: [], createdAtMs: 0, updatedAtMs: 0 },
  ];
}

async function installRoutes(context) {
  await context.route("**/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: FIXED_NOW + 600_000, ttlSeconds: 60, workspaceId, memberId });
    }
    if (path.endsWith("/memory/settings")) return json(route, { workspace: { enabled: true, paused: false, resetEpoch: 0 }, channels: [], me: { paused: false } });
    if (path.endsWith("/memory/items")) return json(route, { items });
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) return json(route, { members: roster() });
    if (path.endsWith("/notification-rules")) return json(route, { dnd: false, mentionOverridesMute: false, dndUntilMs: null });
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
          if (c.connect) return { id: c.id, connect: { client: "pause-capture", version: "6" } };
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

/** 데스크탑 셸 흉내(설정 화면과 사이드바만 열면 되므로 명령은 빈 답이다). */
async function installDesktop(page) {
  await page.addInitScript(() => {
    const callbacks = new Map();
    let next = 1;
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() { /* 구독 해제 흉내 */ } };
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
        if (cmd === "app_version") return "0.1.28";
        if (cmd === "notification_permission") return "granted";
        if (cmd === "dock_badge_set") return null;
        if (cmd === "deep_link_take_pending") return [];
        if (cmd.startsWith("plugin:event|")) return 1;
        return null;
      },
    };
  });
}

async function signIn(page, origin) {
  page.on("pageerror", (error) => console.log(`pageerror: ${error.message}`));
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("profile-card").waitFor({ timeout: 20_000 }).catch(async (error) => {
    await page.screenshot({ path: resolve(OUT_DIR, "debug-signin.png") });
    console.log(`로그인 뒤 화면 글: ${((await page.textContent("body")) ?? "").slice(0, 400)}`);
    throw error;
  });
}

const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok) failures.push(`${name} ${detail}`);
}

const WIDTH = 1440;
const HEIGHT = 900;

async function openScene(browser, origin, scheme) {
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    colorScheme: scheme,
    timezoneId: "Asia/Seoul",
    locale: "ko-KR",
    serviceWorkers: "block",
  });
  await installRoutes(context);
  const page = await context.newPage();
  await installRealtime(page);
  await installDesktop(page);
  await page.addInitScript((serverOrigin) => {
    try { localStorage.setItem("momo.web.server.v1", serverOrigin); } catch { /* 저장소 없는 캡처 */ }
  }, origin);
  await signIn(page, origin);
  // 시계는 로그인이 끝난 뒤에 못 박는다. 부팅 안의 시간 의존 단계(첫 화면 최소 노출 등)가
  // 멈춘 시계 아래서는 끝나지 못한다.
  await context.clock.setFixedTime(FIXED_NOW);
  return { context, page };
}

async function shoot(page, name, tag, locator) {
  await page.waitForTimeout(250);
  await page.screenshot({ path: resolve(OUT_DIR, `${name}-1440-${tag}.png`) });
  if (locator) await locator.screenshot({ path: resolve(OUT_DIR, `${name}-crop-1440-${tag}.png`) });
}

const noOverflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);






const BEFORE = process.env.BEFORE === "1";

/** 앱 안 링크로 옮겨 간다(주소창 이동은 부팅을 다시 한다). */
async function goto(page, path) {
  await page.evaluate((p) => { window.location.hash = "#" + p; }, path);
  await page.waitForTimeout(600);
}

async function memoryScene(browser, origin, scheme) {
  const { context, page } = await openScene(browser, origin, scheme);
  await goto(page, "/memory");
  const channel = page.getByTestId("memory-browser-filter-channel");
  await channel.waitFor({ timeout: 10_000 }).catch(async (error) => {
    await page.screenshot({ path: resolve(OUT_DIR, "debug-memory.png") });
    console.log(`url=${page.url()} 글: ${((await page.textContent("body")) ?? "").slice(0, 300)}`);
    throw error;
  });
  const filters = page.getByTestId("memory-browser-filter-channel").locator("xpath=ancestor::div[contains(@class,'grid')][1]");
  await page.evaluate(() => document.activeElement?.blur());
  if (BEFORE) {
    await shoot(page, "memory-filters-native", scheme, filters);
    await context.close();
    return;
  }
  for (const [id, label] of [["channel", "채널"], ["kind", "종류"], ["status", "상태"]]) {
    const t = page.getByTestId(`memory-browser-filter-${id}`);
    check(`M ${scheme} ${label} 칸은 combobox`, (await t.getAttribute("role")) === "combobox" && (await t.getAttribute("aria-label")) === label);
  }
  check(`M ${scheme} 가로 스크롤 없음`, (await noOverflow(page)) <= 0);
  check(`M ${scheme} 네이티브 select 가 없다`, (await page.locator("select").count()) === 0);
  await shoot(page, "memory-filters-closed", scheme, filters);
  await page.getByTestId("memory-browser-filter-kind").click();
  const list = page.getByRole("listbox");
  await list.waitFor({ timeout: 5000 });
  await page.waitForTimeout(400);
  const geo = await page.evaluate(() => {
    const t = document.querySelector('[data-testid="memory-browser-filter-kind"]').getBoundingClientRect();
    const l = document.querySelector('[role="listbox"]').closest("[data-overlay-layer]").getBoundingClientRect();
    return { tw: t.width, lw: l.width, lb: l.bottom, vh: innerHeight };
  });
  check(`M ${scheme} 목록 폭이 단추와 같고 창 안이다`, Math.abs(geo.lw - geo.tw) <= 1 && geo.lb <= geo.vh, JSON.stringify(geo));
  await page.mouse.move(0, 0);
  await shoot(page, "memory-kind-open", scheme);
  await page.getByRole("option", { name: "사실" }).click().catch(async () => {
    console.log("options:", await page.getByRole("option").allTextContents());
    throw new Error("kind option 「사실」 없음");
  });
  await page.waitForTimeout(500);
  check(`M ${scheme} 고르면 주소 질의가 바뀐다`, page.url().includes("kind=fact"), page.url());
  check(`M ${scheme} 단추가 고른 값을 보인다`, ((await page.getByTestId("memory-browser-filter-kind").textContent()) ?? "").includes("사실"));
  await context.close();
}

async function profileScene(browser, origin, scheme) {
  const { context, page } = await openScene(browser, origin, scheme);
  await goto(page, "/directory");
  const row = page.getByTestId("directory-row").filter({ hasText: "서연" });
  await row.first().waitFor({ timeout: 10_000 });
  await row.first().click();
  const dialog = page.getByTestId("member-profile-dialog");
  await dialog.waitFor({ timeout: 5000 });
  await page.waitForTimeout(600);
  await page.evaluate(() => document.activeElement?.blur());
  if (BEFORE) {
    await shoot(page, "profile-role-native", scheme, dialog);
    await context.close();
    return;
  }
  const t = page.getByTestId("member-profile-role");
  check(`P ${scheme} 역할 칸은 combobox`, (await t.getAttribute("role")) === "combobox" && (await t.getAttribute("aria-label")) === "역할");
  check(`P ${scheme} 네이티브 select 가 없다`, (await dialog.locator("select").count()) === 0);
  await shoot(page, "profile-role-closed", scheme, dialog);
  await t.click();
  await page.getByRole("listbox").waitFor({ timeout: 5000 });
  await page.waitForTimeout(400);
  await page.mouse.move(0, 0);
  await shoot(page, "profile-role-open", scheme, dialog);
  const texts = (await page.getByRole("option").allTextContents()).map((s) => s.trim());
  check(`P ${scheme} 역할 네 가지`, texts.length === 4, JSON.stringify(texts));
  await page.keyboard.press("Escape");
  await page.getByRole("listbox").waitFor({ state: "detached", timeout: 3000 });
  check(`P ${scheme} Esc 는 목록만 닫고 프로필은 남는다`, await dialog.isVisible());
  await context.close();
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  try {
    for (const scheme of ["light", "dark"]) {
      await memoryScene(browser, preview.origin, scheme);
      await profileScene(browser, preview.origin, scheme);
    }
  } finally {
    await browser.close();
    await preview.stop?.();
  }
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
