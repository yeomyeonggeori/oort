#!/usr/bin/env node
// =============================================================================
// 알림 일시 중지가 보인다 — 사이드바 내 이름 아래의 한 줄 캡처 (#3923, ADR-0204 D3).
//
// 라이트/다크 × 1440으로 장면을 찍고, 진짜 번들 위에서 쓰기 모양과 다시 읽기를 단언한다.
//
//   a. 일시 중지 진행 중(+기한): 「알림 일시 중지 중 · 오후 10:30까지」 + 「다시 켜기」
//   b. 기한 없는 행: 「알림 일시 중지 중 · 기한 없음」 + 「다시 켜기」 (성재 계정의 15일 모양)
//   c. 일시 중지는 꺼졌는데 상태만 방해 금지: 「상태는 아직 방해 금지예요」 + 「풀기」
//   d. 흐름: 방해 금지에 묶여 일시 중지가 켜진 판에서 「다시 켜기」 → 둘째 줄 → 「풀기」 → 줄 없음
//   e. 만료: 기한이 지난 줄은 서버에 다시 묻는다(서버가 아직 켜져 있다면 남고, 꺼졌다면 사라진다)
//   f. 끊겨 있으면 단추 자리에 이유를 말한다(단추를 거두고, 줄은 그대로 서 있다)
//   g. 쓰기가 **늦게** 실패하면(design-review H1) 낙관 칠하기로 사라졌던 줄이 이유와 함께 돌아온다
//   h. 날짜가 붙는 기한(「10월 19일(월) 오전 9:00까지」) — 사이드바 폭에서 가장 긴 문장(design-review M3)
//
//   npm run build && node scripts/capture-3923.mjs
//   → OUT_DIR(기본 captures/3923)/<장면>-1440-<light|dark>.png + report.json
//
// 단언이 하나라도 틀리면 종료 코드 1이다. /v1 은 흉내 서버고 시크릿은 없다.
//
// ## 시계를 못 박는다
//
// 기한 문구는 이 기기의 달력과 시계로 읽힌다. 사진이 찍는 때마다 달라지지 않도록 로그인 뒤에
// `context.clock.setFixedTime` 으로 `Date.now()` 를 2026-10-16(금) 21:07 KST 에 못 박는다(타이머는
// 그대로 돈다). 시간대는 Asia/Seoul 로 맞춘다.
//
// ## 흉내 서버가 하는 일
//
// `PATCH notification-rules` 는 방해 금지와의 묶음을 끊고(ADR-0124 증보 2 D8), `PUT presence` 는
// 방해 금지에서 나올 때 묶음이 있으면 켜기 전 값으로 되돌린다. 규칙 GET 의 답은 장면이 줄 세운
// 대기열로 바꿀 수 있다(만료 장면: 첫 답은 「기한이 지난 채 켜짐」, 둘째 답은 「꺼짐」).
// =============================================================================
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "captures/3923");
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

const noOverflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

const writes = (server, kind) => server.log.filter((entry) => entry.kind === kind && entry.method !== "GET");

/** 사이드바의 프로필 줄과 그 아래 멈춤 줄을 함께 감싼 묶음(안전 영역 묶음). */
const footBlock = (page) => page.getByTestId("sidebar-profile-foot").locator("..");
const banner = (page) => page.getByTestId("pause-banner");
/** 줄의 제목과 (있으면) 기한을 「 · 」로 이은 글. 화면에서는 두 줄로 쌓인다. */
const bannerText = async (page) => {
  const title = ((await page.getByTestId("pause-banner-title").textContent()) ?? "").trim();
  const detail = (await page.getByTestId("pause-banner-detail").count()) > 0
    ? ((await page.getByTestId("pause-banner-detail").textContent()) ?? "").trim()
    : null;
  return detail === null ? title : `${title} · ${detail}`;
};

async function waitBanner(page) {
  await banner(page).waitFor({ timeout: 8000 });
  await page.waitForTimeout(300);
}

async function sceneA(browser, origin, scheme, report) {
  const tag = scheme;
  const server = newServer({ rules: { dnd: true, dndUntilMs: UNTIL_2230 }, presenceStatus: "dnd", dndUntilMs: UNTIL_2230 });
  const { context, page } = await openScene(browser, origin, scheme, server);
  await waitBanner(page);
  check(`a ${tag} 줄이 「알림 일시 중지 중 · 오후 10:30까지」`, (await bannerText(page)) === "알림 일시 중지 중 · 오후 10:30까지", await bannerText(page));
  check(`a ${tag} 단추 글자가 「다시 켜기」`, ((await page.getByTestId("pause-banner-action").textContent()) ?? "").trim() === "다시 켜기");
  check(`a ${tag} 묶음의 이름이 문장 전체`, (await banner(page).getAttribute("aria-label")) === "알림 일시 중지 중 · 오후 10:30까지 · 다시 켜기");
  const foot = page.getByTestId("sidebar-profile-foot");
  const fb = await foot.boundingBox();
  const bb = await banner(page).boundingBox();
  check(`a ${tag} 줄이 프로필 줄 위에 선다(#4107)`, fb !== null && bb !== null && bb.y + bb.height <= fb.y + 1, JSON.stringify({ fb, bb }));
  check(`a ${tag} 줄이 사이드바 폭 안에 있다`, bb !== null && bb.x >= 0 && bb.x + bb.width <= 320, JSON.stringify(bb));
  const overflow = await noOverflow(page);
  check(`a ${tag} 가로 스크롤 없음`, overflow <= 0, String(overflow));
  // 그릇(design-review M4): 사이드바의 흰 면 카드(검색 입구·지금 카드와 같은 문법) — 각진 평평한 띠가 아니다.
  const card = page.getByTestId("pause-banner-line").locator("xpath=..");
  const look = await card.evaluate((node) => {
    const style = getComputedStyle(node);
    return { radius: parseFloat(style.borderTopLeftRadius), shadow: style.boxShadow, background: style.backgroundColor };
  });
  check(`a ${tag} 그릇이 둥글고(반경 12px 이상) 그림자가 있다`, look.radius >= 12 && look.shadow !== "none", JSON.stringify(look));
  // 글자 크기: 제목은 프로필 줄의 이름(14px)과 같고 기한은 둘째 줄(12px)과 같다 — 본문 15px 가 아니다.
  const sizes = await page.evaluate(() => {
    const px = (id) => parseFloat(getComputedStyle(document.querySelector(`[data-testid="${id}"]`)).fontSize);
    return { title: px("pause-banner-title"), detail: px("pause-banner-detail"), selfName: px("self-name") };
  });
  check(`a ${tag} 제목이 프로필 이름과 같은 크기, 기한이 더 작다`, sizes.title === sizes.selfName && sizes.detail < sizes.title, JSON.stringify(sizes));
  // 카드 왼쪽 안쪽 여백: 글자 첫 줄이 프로필 카드의 아바타 왼쪽과 가깝다(4px 이내로 맞는지 잰다).
  const avatarBox = await page.getByTestId("profile-card").locator("span").first().boundingBox();
  const titleBox = await page.getByTestId("pause-banner-title").boundingBox();
  const offsetX = avatarBox && titleBox ? Math.round((titleBox.x - avatarBox.x) * 10) / 10 : null;
  check(`a ${tag} 제목 글자가 프로필 아바타 왼쪽과 8px 안에서 맞는다`, offsetX !== null && Math.abs(offsetX) <= 8, String(offsetX));
  await shoot(page, "banner-paused", tag, footBlock(page));
  report[`a-${tag}`] = { overflow, banner: bb, look, sizes, titleOffsetX: offsetX };
  await context.close();
}

async function sceneB(browser, origin, scheme) {
  const tag = scheme;
  const server = newServer({ rules: { dnd: true }, presenceStatus: "dnd" });
  const { context, page } = await openScene(browser, origin, scheme, server);
  await waitBanner(page);
  check(`b ${tag} 기한 없는 행은 「기한 없음」`, (await bannerText(page)) === "알림 일시 중지 중 · 기한 없음", await bannerText(page));
  await shoot(page, "banner-open-ended", tag, footBlock(page));
  await context.close();
}

async function sceneC(browser, origin, scheme) {
  const tag = scheme;
  const server = newServer({ presenceStatus: "dnd", dndUntilMs: UNTIL_2230 });
  const { context, page } = await openScene(browser, origin, scheme, server);
  await waitBanner(page);
  check(`c ${tag} 줄이 「상태는 아직 방해 금지예요」`, (await bannerText(page)) === "상태는 아직 방해 금지예요", await bannerText(page));
  check(`c ${tag} 단추 글자가 「풀기」`, ((await page.getByTestId("pause-banner-action").textContent()) ?? "").trim() === "풀기");
  check(`c ${tag} 종류가 dnd`, (await banner(page).getAttribute("data-kind")) === "dnd");
  await shoot(page, "banner-dnd-only", tag, footBlock(page));
  await context.close();
}

async function sceneD(browser, origin, scheme) {
  const tag = scheme;
  // 방해 금지에 묶여 일시 중지가 켜진 흔한 모양.
  const server = newServer({ rules: { dnd: true, dndUntilMs: UNTIL_2230 }, presenceStatus: "dnd", dndUntilMs: UNTIL_2230 });
  server.prev = { dnd: false, dndUntilMs: undefined };
  const { context, page } = await openScene(browser, origin, scheme, server);
  await waitBanner(page);
  check(`d ${tag} 둘 다 켜져 있으면 일시 중지 줄이 먼저다`, (await banner(page).getAttribute("data-kind")) === "paused");
  await page.getByTestId("pause-banner-action").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="pause-banner"]')?.getAttribute("data-kind") === "dnd", null, { timeout: 5000 });
  const patches = writes(server, "notification-rules");
  check(`d ${tag} 「다시 켜기」는 PATCH {dnd:false} 하나만 보낸다`, patches.length === 1 && patches[0].method === "PATCH" && JSON.stringify(patches[0].body) === JSON.stringify({ dnd: false }), JSON.stringify(patches));
  check(`d ${tag} 상태 쓰기는 하지 않는다`, writes(server, "presence").length === 0);
  check(`d ${tag} 둘째 줄이 「상태는 아직 방해 금지예요」`, (await bannerText(page)) === "상태는 아직 방해 금지예요", await bannerText(page));
  await shoot(page, "banner-after-resume", tag, footBlock(page));
  // 더블클릭의 둘째 누름(design-review M1): 방금 「다시 켜기」를 누른 같은 자리에 올라온 「풀기」는 잠깐 받지 않는다.
  await page.getByTestId("pause-banner-action").click();
  await page.waitForTimeout(400);
  check(`d ${tag} 방금 누른 직후의 「풀기」는 상태 쓰기를 보내지 않는다(보호 시간)`, writes(server, "presence").length === 0, JSON.stringify(writes(server, "presence")));
  // 시계가 못 박혀 있어 보호 시간(1.5초)이 흐르지 않는다 — 사람이 잠깐 뒤에 누르는 것을 3초 앞으로 옮겨 흉내 낸다.
  await context.clock.setFixedTime(FIXED_NOW + 3_000);
  await page.getByTestId("pause-banner-action").click();
  await banner(page).waitFor({ state: "detached", timeout: 5000 });
  const presence = writes(server, "presence");
  check(`d ${tag} 「풀기」는 PUT presence {status:auto} 하나만 보낸다`, presence.length === 1 && JSON.stringify(presence[0].body) === JSON.stringify({ status: "auto" }), JSON.stringify(presence));
  check(`d ${tag} 풀고 나면 줄이 없다`, (await banner(page).count()) === 0);
  check(`d ${tag} 풀기가 규칙을 새로 쓰지 않는다(PATCH 는 처음 하나뿐)`, writes(server, "notification-rules").length === 1);
  await shoot(page, "banner-gone", tag, footBlock(page));
  await context.close();
}

async function sceneE(browser, origin, scheme) {
  const tag = scheme;
  // 첫 답: 기한(21:00)이 이미 지난 채 켜져 있다. 둘째 답: 서버가 꺼졌다고 답한다.
  const server = newServer({ rules: { dnd: true, dndUntilMs: kst("2026-10-16T21:00:00") } });
  server.rulesAfter = [{ dnd: false, dndUntilMs: undefined }];
  const { context, page } = await openScene(browser, origin, scheme, server);
  // 시계가 로그인 뒤에 못 박혀 첫 읽기가 이미 끝났을 수 있다 — 줄이 없어졌는지가 아니라 읽기 횟수로 말한다.
  await page.waitForFunction(() => true);
  await page.waitForTimeout(1200);
  check(`e ${tag} 기한이 지난 줄은 서버에 다시 물었다(규칙 읽기 둘 이상)`, server.rulesGets >= 2, String(server.rulesGets));
  check(`e ${tag} 서버가 꺼졌다고 답했으니 줄이 없다`, (await banner(page).count()) === 0);
  await context.close();

  // 서버가 계속 켜져 있다고 답하면(시계 차이) 줄이 남는다 — 스스로 내려가지 않는다.
  const stuck = newServer({ rules: { dnd: true, dndUntilMs: kst("2026-10-16T21:00:00") } });
  const second = await openScene(browser, origin, scheme, stuck);
  await waitBanner(second.page);
  await second.page.waitForTimeout(1200);
  check(`e ${tag} 서버가 켜져 있다고 답하는 동안 줄이 남는다`, (await banner(second.page).count()) === 1);
  check(`e ${tag} 남은 줄이 지난 기한을 그대로 말한다`, (await bannerText(second.page)) === "알림 일시 중지 중 · 오후 9:00까지", await bannerText(second.page));
  check(`e ${tag} 한 번 더 물었다(규칙 읽기 둘 이상)`, stuck.rulesGets >= 2, String(stuck.rulesGets));
  await shoot(second.page, "banner-elapsed-still-on", tag, footBlock(second.page));
  await second.context.close();
}

async function sceneF(browser, origin, scheme, report) {
  const tag = scheme;
  const server = newServer({ rules: { dnd: true, dndUntilMs: UNTIL_2230 }, presenceStatus: "dnd", dndUntilMs: UNTIL_2230 });
  const { context, page } = await openScene(browser, origin, scheme, server);
  await waitBanner(page);
  check(`f ${tag} 이어져 있을 때는 단추가 있다`, (await page.getByTestId("pause-banner-action").count()) === 1);
  // 브라우저를 끊는다(`navigator.onLine` 과 offline 이벤트).
  await context.setOffline(true);
  await page.getByTestId("pause-banner-offline").waitFor({ timeout: 5000 });
  check(`f ${tag} 끊기면 이유를 말한다`, ((await page.getByTestId("pause-banner-offline").textContent()) ?? "").includes("연결이 끊겨 지금은 바꿀 수 없어요."));
  check(`f ${tag} 끊기면 단추를 거둔다`, (await page.getByTestId("pause-banner-action").count()) === 0);
  check(`f ${tag} 줄은 그대로 서 있다`, (await bannerText(page)) === "알림 일시 중지 중 · 오후 10:30까지", await bannerText(page));
  check(`f ${tag} 끊긴 동안 쓰기가 없다`, server.log.filter((entry) => entry.method !== "GET" ).length === 0);
  const overflow = await noOverflow(page);
  check(`f ${tag} 가로 스크롤 없음`, overflow <= 0, String(overflow));
  await shoot(page, "banner-offline", tag, footBlock(page));
  await context.setOffline(false);
  await page.getByTestId("pause-banner-action").waitFor({ timeout: 5000 });
  check(`f ${tag} 다시 이어지면 단추가 돌아온다`, (await page.getByTestId("pause-banner-offline").count()) === 0);
  report[`f-${tag}`] = { overflow };
  await context.close();
}

async function sceneG(browser, origin, scheme, report) {
  const tag = scheme;
  // 실제 네트워크처럼 쓰기가 늦게(0.8초) 실패한다. 누르면 낙관 칠하기로 줄이 먼저 사라졌다가, 서버가 실패하면
  // 줄이 되돌아오며 이유를 말해야 한다(design-review H1 — 이전 구현은 이 장면에서 이유가 한 번도 뜨지 않았다).
  const server = newServer({ rules: { dnd: true, dndUntilMs: UNTIL_2230 } });
  server.writeDelayMs = 800;
  server.failRulesWrite = true;
  const { context, page } = await openScene(browser, origin, scheme, server);
  await waitBanner(page);
  await page.getByTestId("pause-banner-action").click();
  // 낙관 구간: 줄이 이미 사라졌고 서버는 아직 답하지 않았다.
  await banner(page).waitFor({ state: "detached", timeout: 3000 });
  check(`g ${tag} 낙관 구간: 줄이 먼저 사라졌고 쓰기가 나갔다`, writes(server, "notification-rules").length === 1);
  // 서버가 실패하면 줄이 이유와 함께 돌아온다.
  await page.getByTestId("pause-banner-failure").waitFor({ timeout: 6000 });
  const failure = ((await page.getByTestId("pause-banner-failure").textContent()) ?? "").trim();
  check(`g ${tag} 실패하면 이유가 선다`, failure === "알림 설정을 바꾸지 못했어요. 다시 시도하세요.", failure);
  check(`g ${tag} 줄이 되돌아왔다`, (await bannerText(page)) === "알림 일시 중지 중 · 오후 10:30까지", await bannerText(page));
  check(`g ${tag} 이유는 줄의 그릇 안에서 단추 아래에 선다`, await page.getByTestId("pause-banner-failure").evaluate((node) => node.closest(".glass") !== null));
  check(`g ${tag} 알림(role=alert)으로 읽힌다`, (await page.getByTestId("pause-banner-failure").getAttribute("role")) === "alert");
  const overflow = await noOverflow(page);
  check(`g ${tag} 가로 스크롤 없음`, overflow <= 0, String(overflow));
  await shoot(page, "banner-failure", tag, footBlock(page));
  // 다시 눌러 성공하면 걷힌다(같은 줄의 다시 시도는 막지 않는다).
  server.failRulesWrite = false;
  await page.getByTestId("pause-banner-action").click();
  await banner(page).waitFor({ state: "detached", timeout: 5000 });
  check(`g ${tag} 다시 눌러 성공하면 줄과 이유가 함께 걷힌다`, (await page.getByTestId("pause-banner-failure").count()) === 0);
  report[`g-${tag}`] = { overflow, failure };
  await context.close();

  // 「풀기」도 같다.
  const second = newServer({ presenceStatus: "dnd", dndUntilMs: UNTIL_2230 });
  second.writeDelayMs = 800;
  second.failPresenceWrite = true;
  const opened = await openScene(browser, origin, scheme, second);
  await waitBanner(opened.page);
  await opened.page.getByTestId("pause-banner-action").click();
  await banner(opened.page).waitFor({ state: "detached", timeout: 3000 });
  await opened.page.getByTestId("pause-banner-failure").waitFor({ timeout: 6000 });
  const dndFailure = ((await opened.page.getByTestId("pause-banner-failure").textContent()) ?? "").trim();
  check(`g ${tag} 「풀기」가 늦게 실패해도 이유가 선다`, dndFailure === "상태를 바꾸지 못했습니다. 다시 시도하세요.", dndFailure);
  await shoot(opened.page, "banner-dnd-failure", tag, footBlock(opened.page));
  await opened.context.close();
}

async function sceneH(browser, origin, scheme, report) {
  const tag = scheme;
  // 다음 주 월요일 오전 9시: 오늘·내일 이름이 아니라 날짜가 붙는 가장 긴 문장(design-review M3).
  const monday = kst("2026-10-19T09:00:00");
  const server = newServer({ rules: { dnd: true, dndUntilMs: monday }, presenceStatus: "dnd", dndUntilMs: monday });
  const { context, page } = await openScene(browser, origin, scheme, server);
  await waitBanner(page);
  const text = await bannerText(page);
  check(`h ${tag} 날짜가 붙은 기한을 말한다`, text === "알림 일시 중지 중 · 10월 19일(월) 오전 9:00까지", text);
  // 줄 수와 넘침: 기한 문장이 접혀도(두 줄) 단추와 겹치거나 카드 밖으로 넘치지 않는다.
  const geometry = await page.evaluate(() => {
    const rect = (id) => document.querySelector(`[data-testid="${id}"]`).getBoundingClientRect();
    const card = document.querySelector('[data-testid="pause-banner-line"]').parentElement.getBoundingClientRect();
    const detail = document.querySelector('[data-testid="pause-banner-detail"]');
    const lineHeight = parseFloat(getComputedStyle(detail).lineHeight);
    const title = rect("pause-banner-title");
    const action = rect("pause-banner-action");
    const d = detail.getBoundingClientRect();
    return {
      detailLines: Math.round(d.height / lineHeight),
      detailRight: d.right,
      actionLeft: action.left,
      cardRight: card.right,
      actionRight: action.right,
      titleRight: title.right,
    };
  });
  check(`h ${tag} 기한 글자가 단추와 겹치지 않는다`, geometry.detailRight <= geometry.actionLeft + 0.5, JSON.stringify(geometry));
  check(`h ${tag} 단추가 카드 안에 있다`, geometry.actionRight <= geometry.cardRight + 0.5, JSON.stringify(geometry));
  const overflow = await noOverflow(page);
  check(`h ${tag} 가로 스크롤 없음`, overflow <= 0, String(overflow));
  await shoot(page, "banner-date", tag, footBlock(page));
  report[`h-${tag}`] = { overflow, text, ...geometry };
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
      await sceneB(browser, preview.origin, scheme);
      await sceneC(browser, preview.origin, scheme);
      await sceneD(browser, preview.origin, scheme);
      await sceneE(browser, preview.origin, scheme);
      await sceneF(browser, preview.origin, scheme, report);
      await sceneG(browser, preview.origin, scheme, report);
      await sceneH(browser, preview.origin, scheme, report);
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
