#!/usr/bin/env node
// =============================================================================
// 방해 금지 「기한」 목록 캡처 (#4106). 네이티브 select 의 OS 팝업(회색 반투명 메뉴) 대신
// 앱이 그리는 listbox 를 라이트/다크 1440 으로 찍고, 진짜 번들 위에서 단언한다.
//
//   npm run build && node scripts/capture-4106.mjs          # 후(listbox)
//   BEFORE=1 OUT_DIR=captures/4106/before node scripts/capture-4106.mjs   # 전(네이티브 select, 닫힌 모양만 찍힌다)
//
// 시계는 2026-10-16(금) 21:07 KST 에 못 박는다. /v1 은 흉내 서버고 시크릿은 없다.
// =============================================================================
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "captures/4106");
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

async function openProfileMenu(page) {
  await page.getByTestId("profile-card").click();
  const menu = page.getByTestId("profile-card-menu");
  await menu.waitFor({ timeout: 5000 });
  return menu;
}


const BEFORE = process.env.BEFORE === "1";

async function openDndDialog(page) {
  await openProfileMenu(page);
  await page.getByTestId("presence-option-dnd").click();
  const dialog = page.getByTestId("pause-until-dialog");
  await dialog.waitFor({ timeout: 5000 });
  // 프로필 메뉴가 닫히며 건 포커스 복귀 타이머가 고정 시계 아래서 늦게 돌아 열린 목록의 포커스를 뺏지 않게
  // 먼저 흘려보낸다(캡처 하네스의 시계 못 박기가 만드는 현상이고, 실제 앱에서는 즉시 돈다).
  await page.waitForTimeout(800);
  return dialog;
}

async function sceneBefore(browser, origin, scheme) {
  const server = newServer();
  const { context, page } = await openScene(browser, origin, scheme, server);
  const dialog = await openDndDialog(page);
  await page.getByTestId("pause-until-select").selectOption("1h");
  await page.evaluate(() => document.activeElement?.blur());
  await shoot(page, "dnd-dialog-native-select", scheme, dialog);
  await context.close();
}

async function sceneClosed(browser, origin, scheme, report) {
  const tag = scheme;
  const server = newServer();
  const { context, page } = await openScene(browser, origin, scheme, server);
  const dialog = await openDndDialog(page);
  const trigger = page.getByTestId("pause-until-select");
  check(`1 ${tag} 단추는 combobox·listbox 의미를 갖는다`, (await trigger.getAttribute("role")) === "combobox" && (await trigger.getAttribute("aria-haspopup")) === "listbox" && (await trigger.getAttribute("aria-expanded")) === "false");
  check(`1 ${tag} 네이티브 select 가 다이얼로그에 없다`, (await dialog.locator("select").count()) === 0);
  check(`1 ${tag} 자리표시자가 단추에 선다`, ((await trigger.textContent()) ?? "").trim() === "기한을 고르세요");
  check(`1 ${tag} 단추의 라벨이 「기한」`, ((await page.locator(`label[for="${await trigger.getAttribute("id")}"]`).textContent()) ?? "").trim() === "기한");
  await shoot(page, "dnd-dialog-closed", tag, dialog);
  await context.close();
}

async function sceneOpen(browser, origin, scheme, report) {
  const tag = scheme;
  const server = newServer();
  const { context, page } = await openScene(browser, origin, scheme, server);
  const dialog = await openDndDialog(page);
  const trigger = page.getByTestId("pause-until-select");
  await trigger.click();
  const list = page.getByRole("listbox");
  await list.waitFor({ timeout: 5000 });
  const options = page.getByRole("option");
  const texts = (await options.allTextContents()).map((t) => t.trim());
  check(`2 ${tag} 옵션 여섯, 끝 시각은 라벨 아래 줄`, JSON.stringify(texts) === JSON.stringify([
    "30분오후 9:37까지", "1시간오후 10:07까지", "2시간오후 11:07까지",
    "내일 오전 9시까지10월 17일(토)", "다음 주 월요일 오전 9시까지10월 19일(월)", "직접 고르기",
  ]), JSON.stringify(texts));
  check(`2 ${tag} 포커스가 listbox 로 가고 첫 항목이 활성이다`, await list.evaluate((el) => document.activeElement === el && el.getAttribute("aria-activedescendant") === el.querySelector('[role="option"]').id));
  await page.waitForTimeout(400); // 열림 모션(240ms)이 끝난 뒤에 잰다
  const geo = await page.evaluate(() => {
    const t = document.querySelector('[data-testid="pause-until-select"]').getBoundingClientRect();
    const l = document.querySelector('[role="listbox"]').closest("[data-overlay-layer]").getBoundingClientRect();
    const cs = getComputedStyle(document.querySelector('[role="listbox"]').closest("[data-overlay-layer]"));
    return { tx: t.x, tw: t.width, ty: t.bottom, lx: l.x, lw: l.width, ly: l.y, lb: l.bottom, vh: innerHeight, bg: cs.backgroundColor, radius: cs.borderRadius, shadow: cs.boxShadow !== "none" };
  });
  check(`2 ${tag} 목록 폭이 단추 폭과 같고 같은 왼쪽 선이다`, Math.abs(geo.lw - geo.tw) <= 1 && Math.abs(geo.lx - geo.tx) <= 1, JSON.stringify(geo));
  check(`2 ${tag} 목록이 단추 바로 아래(또는 위)에 붙고 창 안에 있다`, geo.lb <= geo.vh && geo.ly >= 0 && (Math.abs(geo.ly - geo.ty) <= 8), JSON.stringify(geo));
  check(`2 ${tag} 목록은 투명이 아닌 앱 표면색과 그림자를 쓴다`, geo.bg !== "rgba(0, 0, 0, 0)" && geo.shadow, JSON.stringify(geo));
  report[`open-${tag}`] = geo;
  await page.mouse.move(0, 0);
  await shoot(page, "dnd-list-open", tag, dialog);
  // 마우스로 고른다.
  await options.nth(1).click();
  await page.getByRole("listbox").waitFor({ state: "detached", timeout: 3000 });
  check(`2 ${tag} 고르면 목록이 닫히고 단추에 「라벨 · 끝 시각」이 선다`, ((await trigger.textContent()) ?? "").trim() === "1시간 · 오후 10:07까지");
  check(`2 ${tag} 확인이 풀린다`, !(await page.getByTestId("pause-until-confirm").isDisabled()));
  await page.evaluate(() => document.activeElement?.blur());
  await shoot(page, "dnd-dialog-chosen", tag, dialog);
  await page.getByTestId("pause-until-confirm").click();
  await dialog.waitFor({ state: "detached", timeout: 5000 });
  const presence = writes(server, "presence");
  check(`2 ${tag} PUT presence {status, dndUntilMs} 하나`, presence.length === 1 && JSON.stringify(presence[0].body) === JSON.stringify({ status: "dnd", dndUntilMs: FIXED_NOW + 60 * 60_000 }), JSON.stringify(presence));
  await context.close();
}

async function sceneKeyboard(browser, origin, scheme) {
  const tag = scheme;
  const server = newServer();
  const { context, page } = await openScene(browser, origin, scheme, server);
  const dialog = await openDndDialog(page);
  const trigger = page.getByTestId("pause-until-select");
  await trigger.focus();
  await page.keyboard.press("ArrowDown");
  const list = page.getByRole("listbox");
  await list.waitFor({ timeout: 3000 });
  check(`3 ${tag} 단추에서 ↓ 로 열린다`, (await trigger.getAttribute("aria-expanded")) === "true");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  const active = () => list.evaluate((el) => document.getElementById(el.getAttribute("aria-activedescendant"))?.dataset.value);
  check(`3 ${tag} ↓↓ 로 세 번째(2시간)가 활성이다`, (await active()) === "2h", String(await active()));
  await page.keyboard.press("ArrowUp");
  check(`3 ${tag} ↑ 로 1시간`, (await active()) === "1h");
  await page.keyboard.press("End");
  check(`3 ${tag} End 는 마지막(직접 고르기)`, (await active()) === "custom");
  await page.keyboard.press("Home");
  check(`3 ${tag} Home 은 처음(30분)`, (await active()) === "30m");
  await page.keyboard.press("Escape");
  await list.waitFor({ state: "detached", timeout: 3000 });
  await page.waitForTimeout(300);
  check(`3 ${tag} Esc 는 목록만 닫고 다이얼로그는 남는다`, (await dialog.count()) === 1);
  await page.waitForTimeout(300);
  check(`3 ${tag} Esc 뒤 포커스가 단추로 돌아온다`, await trigger.evaluate((el) => document.activeElement === el));
  await page.keyboard.press("Enter");
  await list.waitFor({ timeout: 3000 });
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  check(`3 ${tag} Enter 로 고른다`, ((await trigger.textContent()) ?? "").trim() === "1시간 · 오후 10:07까지");
  await context.close();
}

async function sceneCustom(browser, origin, scheme, report) {
  const tag = scheme;
  const server = newServer();
  const { context, page } = await openScene(browser, origin, scheme, server);
  const dialog = await openDndDialog(page);
  await page.getByTestId("pause-until-select").click();
  await page.getByRole("option", { name: "직접 고르기" }).click();
  const date = page.getByTestId("pause-until-custom-date");
  const time = page.getByTestId("pause-until-custom-time");
  check(`4 ${tag} 직접 고르기: 날짜·시간 칸이 한 시간 뒤로 채워져 선다`, (await date.inputValue()) === "2026-10-16" && (await time.inputValue()) === "22:07");
  await date.fill("2026-10-17");
  await time.fill("09:30");
  await page.evaluate(() => document.activeElement?.blur());
  const overflow = await noOverflow(page);
  check(`4 ${tag} 가로 스크롤 없음`, overflow <= 0, String(overflow));
  await shoot(page, "dnd-dialog-custom", tag, dialog);
  await page.getByTestId("pause-until-confirm").click();
  await dialog.waitFor({ state: "detached", timeout: 5000 });
  const presence = writes(server, "presence");
  check(`4 ${tag} 직접 고른 시각이 그대로 나간다`, presence.length === 1 && JSON.stringify(presence[0].body) === JSON.stringify({ status: "dnd", dndUntilMs: kst("2026-10-17T09:30:00") }), JSON.stringify(presence));
  report[`custom-${tag}`] = { overflow };
  await context.close();
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  const report = {};
  try {
    for (const scheme of ["light", "dark"]) {
      if (BEFORE) { await sceneBefore(browser, preview.origin, scheme); continue; }
      await sceneClosed(browser, preview.origin, scheme, report);
      await sceneOpen(browser, preview.origin, scheme, report);
      await sceneKeyboard(browser, preview.origin, scheme);
      await sceneCustom(browser, preview.origin, scheme, report);
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
