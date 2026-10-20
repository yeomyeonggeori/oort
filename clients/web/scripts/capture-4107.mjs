#!/usr/bin/env node
// =============================================================================
// 「알림 일시 중지 중」 카드를 프로필 줄 위로 (#4107). 카드가 뜨고 질 때 프로필 줄이 움직이지 않는지
// 라이트/다크 1440 에서 **좌표로** 잰다.
//
//   npm run build && node scripts/capture-4107.mjs                    # 후(카드가 프로필 줄 위)
//   BEFORE=1 OUT_DIR=captures/4107/before node scripts/capture-4107.mjs  # 전(카드가 프로필 줄 아래): 좌표만 기록, 단언 없음
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
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "captures/4107");
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
  realtimeWebSocketUrl: "ws://pause-banner-capture.invalid/connection/websocket",
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
    rulesGets: 0,
    rulesAfter: [],
    /** 쓰기(PATCH·PUT)가 이만큼 늦게 답한다. 낙관 칠하기가 서버 답보다 먼저 보이게 한다. */
    writeDelayMs: 0,
    /** 이 쓰기가 실패(500)로 끝난다. */
    failRulesWrite: false,
    failPresenceWrite: false,
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
        if (server.writeDelayMs > 0) await new Promise((done) => setTimeout(done, server.writeDelayMs));
        if (server.failRulesWrite) return json(route, { error: { message: "capture-forced-failure" } }, 500);
        if (body.dnd !== undefined) server.rules.dnd = body.dnd;
        if (body.mentionOverridesMute !== undefined) server.rules.mentionOverridesMute = body.mentionOverridesMute;
        if (body.dndUntilMs !== undefined) server.rules.dndUntilMs = body.dndUntilMs ?? undefined;
        if (!server.rules.dnd) server.rules.dndUntilMs = undefined;
        // 직접 편집은 방해 금지와의 묶음을 끊는다(증보 2 D8).
        server.prev = null;
      }
      if (method === "GET") {
        server.rulesGets += 1;
        const answer = wireRules(server);
        const next = server.rulesAfter.shift();
        if (next) server.rules = { ...server.rules, ...next };
        return json(route, answer);
      }
      return json(route, wireRules(server));
    }
    if (path.endsWith("/presence") && method === "PUT") {
      server.log.push({ method, kind: "presence", body });
      if (server.writeDelayMs > 0) await new Promise((done) => setTimeout(done, server.writeDelayMs));
      if (server.failPresenceWrite) return json(route, { error: { message: "capture-forced-failure" } }, 500);
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
          if (c.connect) return { id: c.id, connect: { client: "pause-banner-capture", version: "6" } };
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


const shoot = async (page, name, tag, locator) => {
  await page.waitForTimeout(250);
  await page.screenshot({ path: resolve(OUT_DIR, `${name}-1440-${tag}.png`) });
  if (locator) await locator.screenshot({ path: resolve(OUT_DIR, `${name}-crop-1440-${tag}.png`) });
};

const writes = (server, kind) => server.log.filter((entry) => entry.kind === kind && entry.method !== "GET");

/** 사이드바의 프로필 줄과 그 아래 멈춤 줄을 함께 감싼 묶음(안전 영역 묶음). */

const BEFORE = process.env.BEFORE === "1";
const banner = (page) => page.getByTestId("pause-banner");
const foot = (page) => page.getByTestId("sidebar-profile-foot");
const footBlock = (page) => foot(page).locator("..");
const box = async (locator) => {
  const b = await locator.boundingBox();
  return b === null ? null : { x: Math.round(b.x * 10) / 10, y: Math.round(b.y * 10) / 10, width: Math.round(b.width * 10) / 10, height: Math.round(b.height * 10) / 10 };
};
const same = (a, b) => a !== null && b !== null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

async function waitBanner(page) {
  await banner(page).waitFor({ timeout: 8000 });
  await page.waitForTimeout(300);
}

/** 카드가 없는 판과 있는 판에서 프로필 줄의 상자를 잰다. */
async function sceneGeometry(browser, origin, scheme, report) {
  const tag = scheme;
  const none = await openScene(browser, origin, scheme, newServer());
  await foot(none.page).waitFor({ timeout: 8000 });
  await none.page.waitForTimeout(500);
  const footNone = await box(foot(none.page));
  const cardNone = await box(none.page.getByTestId("profile-card"));
  await shoot(none.page, "sidebar-no-banner", tag, footBlock(none.page));
  await none.context.close();

  const server = newServer({ rules: { dnd: true, dndUntilMs: UNTIL_2230 }, presenceStatus: "dnd", dndUntilMs: UNTIL_2230 });
  const { context, page } = await openScene(browser, origin, scheme, server);
  await waitBanner(page);
  const footOn = await box(foot(page));
  const cardOn = await box(page.getByTestId("profile-card"));
  const bannerBox = await box(banner(page));
  report[`geometry-${tag}`] = { footNone, footOn, cardNone, cardOn, bannerBox };
  await shoot(page, "sidebar-banner", tag, footBlock(page));
  if (BEFORE) {
    console.log(`[before ${tag}] 프로필 줄 y: 카드 없음 ${footNone?.y} → 카드 있음 ${footOn?.y} (이동 ${footNone && footOn ? footOn.y - footNone.y : "?"}px)`);
  } else {
    check(`1 ${tag} 카드가 서도 프로필 줄의 상자가 그대로다(좌표·크기 일치)`, same(footNone, footOn), JSON.stringify({ footNone, footOn }));
    check(`1 ${tag} 카드가 서도 프로필 카드(아바타 단추)의 상자가 그대로다`, same(cardNone, cardOn), JSON.stringify({ cardNone, cardOn }));
    check(`1 ${tag} 카드가 프로필 줄 **위**에 선다(카드 아래끝 <= 프로필 줄 위끝)`, bannerBox !== null && footOn !== null && bannerBox.y + bannerBox.height <= footOn.y + 0.5, JSON.stringify({ bannerBox, footOn }));
    check(`1 ${tag} 카드가 프로필 줄 바로 위에 이어진다(둘 사이 빈틈은 프로필 줄 안쪽 위 여백 8px 하나)`, bannerBox !== null && footOn !== null && Math.abs(footOn.y - (bannerBox.y + bannerBox.height)) <= 1, JSON.stringify({ bannerBox, footOn }));
    check(`1 ${tag} 카드가 사이드바 폭 안에 있다`, bannerBox !== null && bannerBox.x >= 0 && bannerBox.x + bannerBox.width <= 320, JSON.stringify(bannerBox));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(`1 ${tag} 가로 스크롤 없음`, overflow <= 0, String(overflow));
    const bottom = await page.evaluate(() => {
      const f = document.querySelector('[data-testid="sidebar-profile-foot"]').getBoundingClientRect();
      return Math.round(innerHeight - f.bottom);
    });
    report[`geometry-${tag}`].footBottomGap = bottom;
  }
  await context.close();
}

/** 카드가 바뀌고 사라지는 흐름 내내 프로필 줄이 같은 자리에 있다. */
async function sceneFlow(browser, origin, scheme, report) {
  const tag = scheme;
  const server = newServer({ rules: { dnd: true, dndUntilMs: UNTIL_2230 }, presenceStatus: "dnd", dndUntilMs: UNTIL_2230 });
  server.prev = { dnd: false, dndUntilMs: undefined };
  const { context, page } = await openScene(browser, origin, scheme, server);
  await waitBanner(page);
  const base = await box(foot(page));
  const ys = [base];
  // 일시 중지 카드 → 「다시 켜기」 → 방해 금지만 남은 카드 → 「풀기」 → 카드 없음
  await page.getByTestId("pause-banner-action").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="pause-banner"]')?.getAttribute("data-kind") !== "paused", null, { timeout: 5000 });
  await page.waitForTimeout(300);
  ys.push(await box(foot(page)));
  if (!BEFORE) await shoot(page, "sidebar-banner-dnd-only", tag, footBlock(page));
  // 더블클릭 방지 창(1.5초)이 고정 시계 아래서는 지나지 않으므로 시계를 앞당긴다(3923 장면 D 와 같다).
  await context.clock.setFixedTime(FIXED_NOW + 2000);
  await page.getByTestId("pause-banner-action").click();
  await banner(page).waitFor({ state: "detached", timeout: 5000 });
  await page.waitForTimeout(300);
  ys.push(await box(foot(page)));
  report[`flow-${tag}`] = ys;
  if (!BEFORE) {
    check(`2 ${tag} 「다시 켜기」→「풀기」→ 카드 사라짐 내내 프로필 줄 상자가 그대로다`, ys.every((b) => same(b, base)), JSON.stringify(ys));
    check(`2 ${tag} 쓰기 모양이 그대로다(PATCH {dnd:false} 하나, PUT {status:auto} 하나)`, writes(server, "notification-rules").length === 1 && JSON.stringify(writes(server, "notification-rules")[0].body) === JSON.stringify({ dnd: false }) && writes(server, "presence").length === 1 && JSON.stringify(writes(server, "presence")[0].body) === JSON.stringify({ status: "auto" }), JSON.stringify(server.log.filter((e) => e.method !== "GET")));
  } else {
    console.log(`[before ${tag}] 흐름 중 프로필 줄 y: ${ys.map((b) => b?.y).join(" → ")}`);
  }
  await context.close();
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  const report = {};
  try {
    for (const scheme of ["light", "dark"]) {
      await sceneGeometry(browser, preview.origin, scheme, report);
      await sceneFlow(browser, preview.origin, scheme, report);
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
