#!/usr/bin/env node
// =============================================================================
// 알림 일시 중지·방해 금지의 기한 고르기 캡처 (#2899, ADR-0204 D2).
//
// 라이트/다크 × 1440으로 다섯 장면을 찍고, 진짜 번들 위에서 쓰기 모양을 단언한다.
//
//   a. 설정 › 알림: 일시 중지 켜짐 + 기한(「오후 10:30까지」 · 「기한 바꾸기」)
//   b. 설정 › 알림: 기한 없는 행(「기한 없음 · 기한 정하기」)
//   c. 일시 중지 다이얼로그: 「직접 고르기」를 열어 날짜·시간 칸이 보이는 판
//   d. 사이드바 프로필 메뉴: 방해 금지 항목에 기한이 보이는 판(+ 기한 없는 행)
//   e. 방해 금지 다이얼로그: 프로필 메뉴에서 연 판
//
//   npm run build && node scripts/capture-2899.mjs
//   → OUT_DIR(기본 captures/2899)/<장면>-1440-<light|dark>.png + report.json
//
// 단언이 하나라도 틀리면 종료 코드 1이다. /v1 은 흉내 서버고 시크릿은 없다.
//
// ## 시계를 못 박는다
//
// 기한 문구는 이 기기의 달력과 시계로 읽힌다. 사진이 찍는 때마다 달라지지 않도록
// 로그인 뒤에 `context.clock.setFixedTime` 으로 `Date.now()` 를 2026-10-16(금) 21:07 KST 에
// 못 박는다(타이머는 그대로 돈다). 시간대는 Asia/Seoul 로 맞춘다.
//
// ## 흉내 서버가 하는 일 한 가지
//
// 방해 금지를 고르면 서버가 같은 트랜잭션에서 알림 일시 중지도 켜고, 방해 금지에서 나오면
// 켜기 전 값으로 되돌린다(ADR-0124 증보 2 D8). 이 흉내가 그 묶음을 따라 한다: 그래야 「프로필
// 메뉴에서 방해 금지를 고른 뒤 설정 › 알림의 스위치가 실제 값을 그린다」(규칙 질의 무효화)를
// 진짜 번들에서 잴 수 있다.
// =============================================================================
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "captures/2899");
const PORT = Number(process.env.CAPTURE_PORT || 5199);

const FIXED_NOW = Date.parse("2026-10-16T21:07:00+09:00");
const kst = (iso) => Date.parse(`${iso}+09:00`);
const UNTIL_2230 = kst("2026-10-16T22:30:00");

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
      applyPresence(server, body);
      return json(route, { status: server.presenceStatus, ...(server.dndUntilMs !== undefined ? { dndUntilMs: server.dndUntilMs } : {}) });
    }
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) return json(route, { members: rosterRows(server) });
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

async function gotoNotifications(page, tag) {
  await page.evaluate(() => { window.location.hash = "#/settings?section=notifications"; });
  await page.getByTestId("notification-rules").waitFor({ timeout: 8000 }).catch(async (error) => {
    await page.screenshot({ path: resolve(OUT_DIR, `debug-${tag}.png`) });
    throw error;
  });
  await page.waitForTimeout(400);
}

async function shoot(page, name, tag, locator) {
  await page.waitForTimeout(250);
  await page.screenshot({ path: resolve(OUT_DIR, `${name}-1440-${tag}.png`) });
  if (locator) await locator.screenshot({ path: resolve(OUT_DIR, `${name}-crop-1440-${tag}.png`) });
}

const noOverflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

const writes = (server, kind) => server.log.filter((entry) => entry.kind === kind && entry.method !== "GET");

async function sceneA(browser, origin, scheme, report) {
  const tag = scheme;
  const server = newServer({ rules: { dnd: true, dndUntilMs: UNTIL_2230 } });
  const { context, page } = await openScene(browser, origin, scheme, server);
  await gotoNotifications(page, `a-${tag}`);
  const sw = page.getByTestId("notification-rules-dnd");
  check(`a ${tag} 스위치가 켜져 있다`, (await sw.getAttribute("aria-checked")) === "true");
  const row = page.getByTestId("notification-rules-until");
  const text = (await row.textContent()) ?? "";
  check(`a ${tag} 기한 줄이 「오후 10:30까지」와 알림 정지 문장을 말한다`, text.includes("오후 10:30까지") && text.includes("이 워크스페이스의 알림을 받지 않아요."), text);
  check(`a ${tag} 단추의 접근 이름이 「기한 바꾸기」`, (await page.getByRole("button", { name: "기한 바꾸기" }).count()) === 1);
  const body = (await page.textContent("body")) ?? "";
  check(`a ${tag} 「직접 끌 때까지」가 화면 어디에도 없다`, !body.includes("직접 끌 때까지"));
  const overflow = await noOverflow(page);
  check(`a ${tag} 가로 스크롤 없음`, overflow <= 0, String(overflow));
  await shoot(page, "pause-on", tag, page.getByTestId("notification-rules-section"));
  report[`a-${tag}`] = { overflow };
  await context.close();
}

async function sceneB(browser, origin, scheme, report) {
  const tag = scheme;
  const server = newServer({ rules: { dnd: true } });
  const { context, page } = await openScene(browser, origin, scheme, server);
  await gotoNotifications(page, `b-${tag}`);
  const edit = page.getByTestId("notification-rules-until-edit");
  check(`b ${tag} 기한 없는 행의 단추 글자`, ((await edit.textContent()) ?? "").trim() === "기한 없음 · 기한 정하기");
  check(`b ${tag} 접근 이름도 같은 말`, (await page.getByRole("button", { name: "기한 없음 · 기한 정하기" }).count()) === 1);
  const overflow = await noOverflow(page);
  check(`b ${tag} 가로 스크롤 없음`, overflow <= 0, String(overflow));
  await shoot(page, "pause-open-ended", tag, page.getByTestId("notification-rules-section"));
  report[`b-${tag}`] = { overflow };
  await context.close();
}

async function sceneC(browser, origin, scheme, report) {
  const tag = scheme;
  const server = newServer();
  const { context, page } = await openScene(browser, origin, scheme, server);
  await gotoNotifications(page, `c-${tag}`);
  await page.getByTestId("notification-rules-dnd").click();
  const dialog = page.getByTestId("pause-until-dialog");
  await dialog.waitFor({ timeout: 5000 });
  check(`c ${tag} 스위치를 눌러도 쓰지 않고 다이얼로그가 열린다`, writes(server, "notification-rules").length === 0);
  check(`c ${tag} 스위치는 꺼진 채다`, (await page.getByTestId("notification-rules-dnd").getAttribute("aria-checked")) === "false");
  const labels = await page.getByTestId("pause-until-select").evaluate((select) => [...select.options].map((option) => option.textContent));
  check(`c ${tag} 선택이 순서대로 여섯 + 자리표시자`, JSON.stringify(labels) === JSON.stringify([
    "기한을 고르세요",
    "30분 · 오후 9:37까지",
    "1시간 · 오후 10:07까지",
    "2시간 · 오후 11:07까지",
    "내일 오전 9시까지 · 10월 17일(토)",
    "다음 주 월요일 오전 9시까지 · 10월 19일(월)",
    "직접 고르기",
  ]), JSON.stringify(labels));
  check(`c ${tag} 고르기 전에는 확인이 잠겨 있다`, await page.getByTestId("pause-until-confirm").isDisabled());
  await page.getByTestId("pause-until-select").selectOption("custom");
  const date = page.getByTestId("pause-until-custom-date");
  const time = page.getByTestId("pause-until-custom-time");
  check(`c ${tag} 직접 고르기: 한 시간 뒤가 채워져 있다`, (await date.inputValue()) === "2026-10-16" && (await time.inputValue()) === "22:07");
  await date.fill("2026-10-17");
  await time.fill("09:30");
  const overflow = await noOverflow(page);
  check(`c ${tag} 가로 스크롤 없음`, overflow <= 0, String(overflow));
  // 사진은 쉬는 모양으로 찍는다: 방금 채운 시간 칸의 초점 고리를 걷는다.
  await page.evaluate(() => document.activeElement?.blur());
  await shoot(page, "pause-dialog-custom", tag, dialog);
  await page.getByTestId("pause-until-confirm").click();
  await dialog.waitFor({ state: "detached", timeout: 5000 });
  const patches = writes(server, "notification-rules");
  check(`c ${tag} 확인하면 PATCH 하나가 {dnd, dndUntilMs} 만 싣는다`, patches.length === 1 && patches[0].method === "PATCH"
    && JSON.stringify(patches[0].body) === JSON.stringify({ dnd: true, dndUntilMs: kst("2026-10-17T09:30:00") }), JSON.stringify(patches));
  check(`c ${tag} 줄이 「내일 오전 9:30까지」로 바뀐다`, ((await page.getByTestId("notification-rules-until").textContent()) ?? "").includes("내일 오전 9:30까지"));
  check(`c ${tag} 스위치가 켜진다`, (await page.getByTestId("notification-rules-dnd").getAttribute("aria-checked")) === "true");
  report[`c-${tag}`] = { overflow };
  await context.close();
}

async function openProfileMenu(page) {
  await page.getByTestId("profile-card").click();
  const menu = page.getByTestId("profile-card-menu");
  await menu.waitFor({ timeout: 5000 });
  return menu;
}

async function sceneD(browser, origin, scheme, report) {
  const tag = scheme;
  // 기한이 있는 방해 금지(서버가 일시 중지를 같은 기한으로 묶어 켠 판).
  {
    const server = newServer({ presenceStatus: "dnd", dndUntilMs: UNTIL_2230, rules: { dnd: true, dndUntilMs: UNTIL_2230 } });
    server.prev = { dnd: false, dndUntilMs: undefined };
    const { context, page } = await openScene(browser, origin, scheme, server);
    const menu = await openProfileMenu(page);
    const note = page.getByTestId("presence-dnd-until");
    check(`d ${tag} 방해 금지 항목 둘째 줄이 「오후 10:30까지」`, ((await note.textContent()) ?? "").trim() === "오후 10:30까지");
    check(`d ${tag} 항목의 접근 이름에 기한이 들어 있다`, ((await page.getByTestId("presence-option-dnd").textContent()) ?? "").includes("오후 10:30까지"));
    check(`d ${tag} 메뉴가 서브메뉴 없이 같은 목록이다`, (await page.locator('[data-testid^="presence-option-"]').count()) === 3);
    const overflow = await noOverflow(page);
    check(`d ${tag} 가로 스크롤 없음`, overflow <= 0, String(overflow));
    await shoot(page, "menu-dnd-on", tag, menu);
    report[`d-${tag}`] = { overflow };
    await context.close();
  }
  // 기한 없는 방해 금지.
  {
    const server = newServer({ presenceStatus: "dnd", rules: { dnd: true } });
    const { context, page } = await openScene(browser, origin, scheme, server);
    const menu = await openProfileMenu(page);
    const note = page.getByTestId("presence-dnd-until");
    check(`d ${tag} 기한 없는 항목 둘째 줄이 「기한 없음 · 기한 정하기」`, ((await note.textContent()) ?? "").trim() === "기한 없음 · 기한 정하기");
    await shoot(page, "menu-dnd-open-ended", tag, menu);
    await context.close();
  }
}

async function sceneE(browser, origin, scheme, report) {
  const tag = scheme;
  const server = newServer();
  const { context, page } = await openScene(browser, origin, scheme, server);
  // 설정 › 알림을 먼저 열어 규칙을 캐시에 꺼진 채로 넣고, 사이드바가 있는 화면으로 돌아온다.
  // 시계가 못 박혀 있어 그 캐시는 영영 신선하다: 방해 금지를 고른 뒤 설정을 다시 열었을 때
  // 켜진 값이 보이려면 프로필 메뉴의 쓰기가 규칙 질의를 **무효화**해야만 한다.
  await gotoNotifications(page, `e-${tag}`);
  check(`e ${tag} 시작할 때 일시 중지 스위치는 꺼져 있다`, (await page.getByTestId("notification-rules-dnd").getAttribute("aria-checked")) === "false");
  await page.evaluate(() => { window.location.hash = "#/"; });
  await page.getByTestId("profile-card").waitFor({ timeout: 8000 });
  await openProfileMenu(page);
  await page.getByTestId("presence-option-dnd").click();
  const dialog = page.getByTestId("pause-until-dialog");
  await dialog.waitFor({ timeout: 5000 });
  check(`e ${tag} 방해 금지 항목은 쓰지 않고 다이얼로그를 연다`, writes(server, "presence").length === 0);
  const description = (await dialog.textContent()) ?? "";
  check(`e ${tag} 설명이 「알림도 함께 멈춰요」를 말한다`, description.includes("알림도 함께 멈춰요") && description.includes("방해 금지를 언제까지 켤까요?"), description);
  check(`e ${tag} 확인 단추의 이름`, ((await page.getByTestId("pause-until-confirm").textContent()) ?? "").trim() === "방해 금지 켜기");
  await page.getByTestId("pause-until-select").selectOption("1h");
  const overflow = await noOverflow(page);
  check(`e ${tag} 가로 스크롤 없음`, overflow <= 0, String(overflow));
  await shoot(page, "dnd-dialog", tag, dialog);
  await page.getByTestId("pause-until-confirm").click();
  await dialog.waitFor({ state: "detached", timeout: 5000 });
  const presence = writes(server, "presence");
  check(`e ${tag} PUT presence 하나가 {status, dndUntilMs} 만 싣는다`, presence.length === 1
    && JSON.stringify(presence[0].body) === JSON.stringify({ status: "dnd", dndUntilMs: FIXED_NOW + 60 * 60_000 }), JSON.stringify(presence));
  check(`e ${tag} 알림 규칙은 PUT 도 PATCH 도 보내지 않는다`, writes(server, "notification-rules").length === 0, JSON.stringify(writes(server, "notification-rules")));
  // 규칙 질의 무효화: 설정 › 알림을 다시 열면 서버가 묶어 켠 값을 다시 읽어 그린다.
  await gotoNotifications(page, `e2-${tag}`);
  await page.waitForFunction(() => document.querySelector('[data-testid="notification-rules-dnd"]')?.getAttribute("aria-checked") === "true", null, { timeout: 5000 })
    .then(() => check(`e ${tag} 방해 금지를 고른 뒤 설정의 일시 중지 스위치가 서버 값(켜짐)을 그린다`, true))
    .catch(() => check(`e ${tag} 방해 금지를 고른 뒤 설정의 일시 중지 스위치가 서버 값(켜짐)을 그린다`, false, "스위치가 꺼진 채"));
  const until = (await page.getByTestId("notification-rules-until").textContent().catch(() => "")) ?? "";
  check(`e ${tag} 같은 기한이 설정 줄에도 보인다`, until.includes("오후 10:07까지"), until);
  await shoot(page, "dnd-then-settings", tag);
  report[`e-${tag}`] = { overflow };
  await context.close();
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  const report = {};
  try {
    for (const scheme of ["light", "dark"]) {
      await sceneA(browser, preview.origin, scheme, report);
      await sceneB(browser, preview.origin, scheme, report);
      await sceneC(browser, preview.origin, scheme, report);
      await sceneD(browser, preview.origin, scheme, report);
      await sceneE(browser, preview.origin, scheme, report);
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
