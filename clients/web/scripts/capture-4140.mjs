#!/usr/bin/env node
// =============================================================================
// 「상태 설정」 다이얼로그 캡처 (#4140). 닫힘·이모지 열림·만료 열림을 라이트/다크 1440 으로
// 찍고, 후(AFTER)에서는 진짜 번들 위에서 단언한다. 장면 틀은 capture-4123.mjs 와 같다.
//
//   npm run build && OUT_DIR=<경로> node scripts/capture-4140.mjs               # 후
//   BEFORE=1 OUT_DIR=<경로> node scripts/capture-4140.mjs                       # 전(기준선 번들 위에서 찍기만)
// =============================================================================
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "captures/4140");
const PORT = Number(process.env.CAPTURE_PORT || 5199);

const FIXED_NOW = Date.parse("2026-10-16T21:07:00+09:00");

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
  realtimeWebSocketUrl: "ws://pause-capture.invalid/connection/websocket",
};

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

/** 흉내 서버의 기억. 장면마다 새로 만든다. */
function newServer({ rules = {}, presenceStatus = "auto", dndUntilMs } = {}) {
  return {
    rules: { dnd: false, mentionOverridesMute: false, ...rules },
    presenceStatus,
    dndUntilMs,
    prev: null,
    log: [],
    rosterGets: 0,
    /** GET 한 번마다 앞에서 하나를 꺼내 **다음** GET 의 답으로 둔다 — 서버가 시간이 지나 바뀐 것을 흉내 낸다. */
    rosterAfter: [],
    /** 있으면 `PUT /presence` 의 응답이 그만큼 늦게 온다(저장 중 상태를 찍는다). */
    presenceDelayMs: 0,
  };
}

function wireRules(server) {
  const { dnd, mentionOverridesMute, dndUntilMs } = server.rules;
  return { dnd, mentionOverridesMute, dndUntilMs: dnd && dndUntilMs !== undefined ? dndUntilMs : null };
}

function rosterRows(server) {
  const self = {
    id: memberId, workspaceId, kind: "human", status: "active", role: "owner", displayName: "곽성재",
    handle: "seongjae", channelCount: 2, channelIds: channels.map((c) => c.id), capabilities: [],
    createdAtMs: 0, updatedAtMs: 0, presenceStatus: server.presenceStatus,
  };
  if (server.presenceStatus === "dnd" && server.dndUntilMs !== undefined) self.dndUntilMs = server.dndUntilMs;
  return [self];
}

/** `PUT /presence` 한 번이 서버에서 하는 일(ADR-0124 증보 2 D8 의 묶음) 흉내. */
function applyPresence(server, body) {
  if (body.status === "dnd") {
    if (server.prev === null) server.prev = { dnd: server.rules.dnd, dndUntilMs: server.rules.dndUntilMs };
    server.presenceStatus = "dnd";
    if (body.dndUntilMs !== undefined) server.dndUntilMs = body.dndUntilMs ?? undefined;
    server.rules.dnd = true;
    server.rules.dndUntilMs = server.dndUntilMs;
    return;
  }
  if (server.presenceStatus === "dnd" && server.prev !== null) {
    server.rules.dnd = server.prev.dnd;
    server.rules.dndUntilMs = server.prev.dndUntilMs;
    server.prev = null;
  }
  server.presenceStatus = body.status;
  server.dndUntilMs = undefined;
}

async function installRoutes(context, server) {
  await context.route("**/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    let body = null;
    try {
      body = request.postDataJSON();
    } catch {
      body = null;
    }
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: FIXED_NOW + 600_000, ttlSeconds: 60, workspaceId, memberId });
    }
    if (path.endsWith("/notification-rules")) {
      server.log.push({ method, kind: "notification-rules", body });
      if (method === "PATCH" || method === "PUT") {
        if (body.dnd !== undefined) server.rules.dnd = body.dnd;
        if (body.mentionOverridesMute !== undefined) server.rules.mentionOverridesMute = body.mentionOverridesMute;
        if (body.dndUntilMs !== undefined) server.rules.dndUntilMs = body.dndUntilMs ?? undefined;
        if (!server.rules.dnd) server.rules.dndUntilMs = undefined;
        // 직접 편집은 방해 금지와의 묶음을 끊는다(증보 2 D8).
        server.prev = null;
      }
      return json(route, wireRules(server));
    }
    if (path.endsWith("/presence") && method === "PUT") {
      server.log.push({ method, kind: "presence", body });
      if (server.presenceDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, server.presenceDelayMs));
      applyPresence(server, body);
      return json(route, { status: server.presenceStatus, ...(server.dndUntilMs !== undefined ? { dndUntilMs: server.dndUntilMs } : {}) });
    }
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) {
      server.rosterGets += 1;
      const answer = rosterRows(server);
      const next = server.rosterAfter.shift();
      if (next) {
        server.presenceStatus = next.presenceStatus;
        server.dndUntilMs = next.dndUntilMs;
      }
      return json(route, { members: answer });
    }
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

async function openScene(browser, origin, scheme, server) {
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    colorScheme: scheme,
    timezoneId: "Asia/Seoul",
    locale: "ko-KR",
    serviceWorkers: "block",
  });
  await installRoutes(context, server);
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


async function openProfileMenu(page) {
  await page.getByTestId("profile-card").click();
  const menu = page.getByTestId("profile-card-menu");
  await menu.waitFor({ timeout: 5000 });
  return menu;
}



const BEFORE = process.env.BEFORE === "1";

async function openStatusDialog(page) {
  await openProfileMenu(page);
  await page.getByTestId("profile-set-status").click();
  const dialog = page.getByTestId("set-status-dialog");
  await dialog.waitFor({ timeout: 5000 });
  await page.waitForTimeout(800);
  return dialog;
}

async function scene(browser, origin, scheme) {
  const tag = scheme;
  const server = newServer();
  const { context, page } = await openScene(browser, origin, scheme, server);
  const dialog = await openStatusDialog(page);
  const emojiBtn = page.getByTestId("set-status-emoji");
  const expiry = page.getByTestId("set-status-expiry");
  const rect = (testId) =>
    page.evaluate((id) => {
      const r = document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect();
      return r ? { x: r.x, y: r.y, w: r.width, h: r.height, b: r.bottom, r: r.right } : null;
    }, testId);
  const overlap = (a, b) => a && b && a.x < b.r && b.x < a.r && a.y < b.b && b.y < a.b;

  await page.evaluate(() => document.activeElement?.blur());
  await shoot(page, "set-status-closed", tag, dialog);

  // 이모지 열림
  await emojiBtn.click();
  const picker = page.getByTestId("set-status-emoji-picker");
  await picker.waitFor({ timeout: 5000 });
  await page.waitForTimeout(500);
  await page.mouse.move(0, 0);
  if (!BEFORE) {
    check(`1 ${tag} 이모지 단추가 글 칸과 같은 그릇 안, 글 칸 왼쪽`, await page.evaluate(() => {
      const b = document.querySelector('[data-testid="set-status-emoji"]');
      const t = document.querySelector('[data-testid="set-status-text"]');
      return b.parentElement === t.parentElement && b.getBoundingClientRect().right <= t.getBoundingClientRect().left + 1;
    }));
    check(`1 ${tag} 팝오버로 열려 스크림이 하나뿐이다`, (await page.locator('[data-overlay-layer="scrim"]').count()) === 1 && (await picker.getAttribute("data-side")) !== null);
    const pr = await rect("set-status-emoji-picker");
    const vh = await page.evaluate(() => innerHeight);
    check(`1 ${tag} 팝오버가 창 안이다`, pr && pr.y >= 0 && pr.b <= vh, JSON.stringify(pr));
  }
  await shoot(page, "set-status-emoji-open", tag, null);
  if (BEFORE) {
    await page.keyboard.press("Escape");
    await picker.waitFor({ state: "detached", timeout: 3000 });
  } else {
    // 고르기: 첫 칸. 포커스는 글 칸으로.
    await page.locator('[data-testid^="picker-status-"]').first().click();
    await picker.waitFor({ state: "detached", timeout: 3000 });
    await page.waitForTimeout(300);
    const shown = ((await emojiBtn.textContent()) ?? "").trim();
    check(`2 ${tag} 고른 이모지가 단추에 보인다`, shown.length > 0 && !(await emojiBtn.locator("svg").count()), shown);
    check(`2 ${tag} 포커스는 글 칸이다`, await page.getByTestId("set-status-text").evaluate((el) => el === document.activeElement));
    check(`2 ${tag} 이모지만 골라도 추천 목록은 그대로(글이 비었다)`, (await page.getByTestId("set-status-presets").count()) === 1);
    // 추천 목록 → 세 값
    await page.getByTestId("set-status-preset-meeting").click();
    check(`3 ${tag} 추천을 고르면 이모지·글·만료가 함께 채워진다`,
      ((await emojiBtn.textContent()) ?? "").trim() === "📅" &&
      (await page.getByTestId("set-status-text").inputValue()) === "회의 중" &&
      ((await expiry.textContent()) ?? "").trim() === "1시간");
    check(`3 ${tag} 글이 생기면 추천 목록이 접힌다`, (await page.getByTestId("set-status-presets").count()) === 0);
    await page.getByTestId("set-status-text-clear").click();
    check(`3 ${tag} 지우기로 비우면 목록이 다시 펼쳐진다`, (await page.getByTestId("set-status-presets").count()) === 1 && (await page.getByTestId("set-status-text").inputValue()) === "");
    // 저장 payload
    await page.getByTestId("set-status-preset-commute").click();
    const put = page.waitForRequest((r) => r.url().endsWith("/presence") && r.method() === "PUT");
    await page.getByTestId("set-status-save").click();
    const body = (await put).postDataJSON();
    check(`3 ${tag} 저장 payload 에 emoji·text·expires 가 실린다`, body.statusEmoji === "🚶" && body.statusText === "이동 중" && body.statusExpiresAtMs === FIXED_NOW + 30 * 60_000, JSON.stringify(body));
    await dialog.waitFor({ state: "detached", timeout: 5000 });
    // 다시 열어 만료 열림 장면
    await page.waitForTimeout(500);
    await openStatusDialog(page);
  }

  // 만료 열림
  await expiry.click();
  await page.getByRole("listbox").waitFor({ timeout: 5000 });
  await page.waitForTimeout(400);
  await page.mouse.move(0, 0);
  if (!BEFORE) {
    const lb = await page.evaluate(() => {
      const r = document.querySelector('[role="listbox"]').closest("[data-overlay-layer]").getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, b: r.bottom, r: r.right };
    });
    const tr = await rect("set-status-expiry");
    const save = await rect("set-status-save");
    const cancel = await rect("set-status-cancel");
    const clear = await rect("set-status-clear");
    check(`4 ${tag} 만료 목록이 하단 버튼을 가리지 않는다`, !overlap(lb, save) && !overlap(lb, cancel) && !overlap(lb, clear), JSON.stringify({ lb, save, cancel, clear }));
    check(`4 ${tag} 만료 목록 폭이 칸과 같다`, Math.abs(lb.w - tr.w) <= 1 && Math.abs(lb.x - tr.x) <= 1, JSON.stringify({ lb, tr }));
  }
  await shoot(page, "set-status-expiry-open", tag, null);
  await page.keyboard.press("Escape");
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
  console.log("\n모든 단언 통과");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
