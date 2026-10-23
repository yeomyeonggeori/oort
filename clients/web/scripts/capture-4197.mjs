#!/usr/bin/env node
// =============================================================================
// 알림 일시 중지(서버 규칙)가 데스크탑 OS 배너를 멈춘다 (#4197). 데스크탑 셸의 `notification_show` 를
// 흉내 내는 다리가 **받은 호출**을 세어, 일시 중지 중에 OS 배너가 0건인지 실제 번들로 잰다.
//
//   npm run build && node scripts/capture-4197.mjs                       # 후
//   BEFORE=1 OUT_DIR=captures/4197/before node scripts/capture-4197.mjs   # 전: 단언 없이 센 값만 적는다
//
// 장면(라이트·다크 1440):
//   A 일시 중지 중   서버 규칙 dnd:true. 창이 뒤에 있을 때 멘션·승인·DM 이 와도 배너 0건(후).
//   B 대조           일시 중지 꺼짐. 같은 세 건이 배너 3건 — 하네스가 배너를 볼 수 있다는 증거.
//   C 다시 켜기      일시 중지 중 멘션 0건 → 사이드바 「다시 켜기」 → 다음 멘션 1건.
//   D 다른 기기      폰에서 건 일시 중지(서버만 바뀜)도 간격 재조회(60초) 뒤의 멘션부터 따른다.
//   E 만료           서버 시계가 기한을 지나면 다시 읽은 값(dnd:false)이 와서 배너가 다시 뜬다.
//
// D·E 는 앱의 진짜 타이머(60초 간격)를 기다린다 — 시계는 `setFixedTime` 이라 타이머를 멈추지 않는다.
// 사진 속 점선 상자는 **캡처 계기**다(셸 다리가 받은 호출을 그대로 적는다). 제품 화면이 아니다.
// /v1 은 흉내 서버고 시크릿은 없다. 칸 알림(로컬 PTY)은 이 하네스에 PTY 가 없어 vitest 로만 잰다.
// =============================================================================
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "captures/4197");
const PORT = Number(process.env.CAPTURE_PORT || 5197);
const BEFORE = process.env.BEFORE === "1";

const FIXED_NOW = Date.parse("2026-10-22T21:07:00+09:00");
const kst = (iso) => Date.parse(`${iso}+09:00`);
const UNTIL_2230 = kst("2026-10-22T22:30:00");
const POLL_WAIT_MS = BEFORE ? 4_000 : 75_000; // 앱의 간격 재조회(60초)를 지나게 기다린다. 전 판에는 간격 재조회가 없다.
const COALESCE_WAIT_MS = 2_200; // 같은 종류를 묶는 창(1.2초) 뒤 셸 호출까지.

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const otherId = "00000000-0000-7000-8000-0000000005d1";
const agentId = "00000000-0000-7000-8000-000000000103";
const chWork = "00000000-0000-7000-8000-000000000201";
const chGeneral = "00000000-0000-7000-8000-000000000203";
const chDm = "00000000-0000-7000-8000-000000000207";
const channels = [
  { id: chWork, workspaceId, kind: "public", name: "workbench", muted: false },
  { id: chGeneral, workspaceId, kind: "public", name: "general", muted: false },
  { id: chDm, workspaceId, kind: "dm", name: "곽민지", dmKey: "capture-dm", memberIds: [memberId, otherId], muted: false },
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

/** 흉내 서버의 기억. 장면마다 새로 만든다. `nowMs` 는 서버 시계다(기한 만료를 서버가 판정한다). */
function newServer({ dnd = false, dndUntilMs, presenceStatus = "auto" } = {}) {
  return {
    rules: { dnd, mentionOverridesMute: false, dndUntilMs },
    presenceStatus,
    nowMs: FIXED_NOW,
    log: [],
    rulesGets: 0,
  };
}

/** 서버는 읽기에도 **유효 값**을 준다(ADR-0124 증보 2 D7): 기한이 지났으면 dnd=false. */
function wireRules(server) {
  const { dnd, mentionOverridesMute, dndUntilMs } = server.rules;
  const live = dnd && (dndUntilMs === undefined || dndUntilMs > server.nowMs);
  return { dnd: live, mentionOverridesMute, dndUntilMs: live && dndUntilMs !== undefined ? dndUntilMs : null };
}

function rosterRows(server) {
  const row = (id, kind, displayName, handle, extra = {}) => ({
    id, workspaceId, kind, status: "active", role: kind === "agent" ? "member" : "owner", displayName, handle,
    channelCount: 2, channelIds: [chWork, chGeneral], capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...extra,
  });
  const self = row(memberId, "human", "곽성재", "seongjae", { presenceStatus: server.presenceStatus });
  if (server.presenceStatus === "dnd" && server.rules.dndUntilMs !== undefined) self.dndUntilMs = server.rules.dndUntilMs;
  return [self, row(otherId, "human", "곽민지", "minji"), row(agentId, "agent", "헤르메스", "hermes")];
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
        if (body.dndUntilMs !== undefined) server.rules.dndUntilMs = body.dndUntilMs ?? undefined;
        if (!server.rules.dnd) server.rules.dndUntilMs = undefined;
        return json(route, wireRules(server));
      }
      server.rulesGets += 1;
      return json(route, wireRules(server));
    }
    if (path.endsWith("/presence") && method === "PUT") {
      server.log.push({ method, kind: "presence", body });
      server.presenceStatus = body.status;
      return json(route, { status: server.presenceStatus });
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

/** Centrifugo 흉내. `window.__push(channel, data)` 가 구독한 채널로 발행 한 건을 밀어 넣는다. */
async function installRealtime(page) {
  await page.addInitScript(() => {
    const subscribed = new Set();
    const offsets = new Map();
    let live = null;
    class CaptureSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      constructor(url) {
        this.url = String(url);
        this.readyState = 0;
        live = this;
        queueMicrotask(() => { this.readyState = 1; this.onopen?.(new Event("open")); });
      }
      emit(frames) {
        queueMicrotask(() => this.onmessage?.(new MessageEvent("message", { data: frames.map((r) => JSON.stringify(r)).join("\n") })));
      }
      send(data) {
        const replies = String(data).trim().split("\n").map((line) => {
          const c = JSON.parse(line);
          if (c.connect) return { id: c.id, connect: { client: "pause-capture", version: "6" } };
          if (c.subscribe) {
            subscribed.add(c.subscribe.channel);
            offsets.set(c.subscribe.channel, 0);
            return { id: c.id, subscribe: { recoverable: true, positioned: true, recovered: false, epoch: "cap", offset: 0 } };
          }
          return { id: c.id };
        });
        this.emit(replies);
      }
      close() { this.readyState = 3; this.onclose?.(new CloseEvent("close", { code: 1000 })); }
    }
    window.WebSocket = CaptureSocket;
    window.__subscribedCount = () => subscribed.size;
    window.__push = (channel, data) => {
      const offset = (offsets.get(channel) ?? 0) + 1;
      offsets.set(channel, offset);
      live?.emit([{ push: { channel, pub: { data, offset } } }]);
    };
  });
}

/** 데스크탑 셸 흉내. `notification_show` 가 받은 호출을 `window.__banners` 에 쌓는다. */
async function installDesktop(page) {
  await page.addInitScript(() => {
    const callbacks = new Map();
    let next = 1;
    window.__banners = [];
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() { /* 구독 해제 흉내 */ } };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
      transformCallback(cb) { const id = next++; callbacks.set(id, cb); return id; },
      unregisterCallback(id) { callbacks.delete(id); },
      convertFileSrc: (p) => p,
      async invoke(cmd, args) {
        if (cmd === "keychain_available") return true;
        if (cmd === "keychain_store_refresh_token") { window.__kc = true; return null; }
        if (cmd === "keychain_refresh_token_handle") return window.__kc ? "shell:00000000000000000000000000000001" : null;
        if (cmd === "keychain_clear_refresh_token") { window.__kc = false; return null; }
        if (cmd === "app_version") return "0.1.32";
        if (cmd === "notification_permission") return "granted";
        if (cmd === "notification_show") { window.__banners.push({ title: args?.title ?? "", body: args?.body ?? "" }); return true; }
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
    try {
      localStorage.setItem("momo.web.server.v1", serverOrigin);
      // 새 DM 은 기본 끔이다. 켜 두어야 「일시 중지 때문에 안 뜬 것」과 「꺼서 안 뜬 것」이 갈린다.
      localStorage.setItem("momo.web.notifications.v1", JSON.stringify({ dm: true }));
    } catch { /* 저장소 없는 캡처 */ }
  }, origin);
  await signIn(page, origin);
  // 시계는 로그인이 끝난 뒤에 못 박는다. 타이머는 멈추지 않는다.
  await context.clock.setFixedTime(FIXED_NOW);
  // 알림 레일이 채널을 구독할 때까지(공개 둘 + DM 하나).
  await page.waitForFunction(() => window.__subscribedCount?.() >= 3, null, { timeout: 15_000 });
  // 창이 뒤로 갔다: 데스크탑 셸은 blur 로 「포커스 없음」을 안다. 그래야 배너가 후보가 된다.
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  return { context, page };
}

const chName = (channelId) => `ch:ws${workspaceId.toUpperCase()}.${channelId.toUpperCase()}`;

let seqCounter = 100;
let idCounter = 0;
function messageEvent(nowMs, { channelId, type = "text", body, authorId, props = {} }) {
  seqCounter += 1;
  idCounter += 1;
  const id = `019F96A4-E717-7F82-9750-${String(idCounter).padStart(12, "0")}`;
  return {
    channelId,
    event: {
      type: "message.new",
      v: 1,
      ts: nowMs,
      seq: seqCounter,
      payload: { id, channel_id: channelId, seq: seqCounter, type, body, author_member_id: authorId, hlc_ts: nowMs, hlc_count: 0, props },
    },
  };
}
const mention = (nowMs) =>
  messageEvent(nowMs, { channelId: chWork, body: "@성재 스테이징 배포 확인 부탁드립니다", authorId: otherId, props: { mention_member_ids: [memberId] } });
const approval = (nowMs) =>
  messageEvent(nowMs, {
    channelId: chWork, type: "approval_request", body: "승인 요청", authorId: agentId,
    props: { approval_id: "019F8338-025E-7873-93A3-C1FBA9149185", title: "스테이징에 배포" },
  });
const directMessage = (nowMs) =>
  messageEvent(nowMs, { channelId: chDm, body: "점심 먹었어요?", authorId: otherId });

async function push(page, item) {
  await page.evaluate(([channel, data]) => window.__push(channel, data), [chName(item.channelId), item.event]);
}

const banners = (page) => page.evaluate(() => window.__banners.map((b) => ({ title: b.title, body: b.body })));

/** 점선 상자(캡처 계기)를 그려 사진 한 장에 「셸이 받은 호출」을 함께 담는다. */
async function paintInstrument(page, scene, list) {
  await page.evaluate(({ scene: sceneName, list: calls }) => {
    document.getElementById("capture-instrument")?.remove();
    const style = getComputedStyle(document.body);
    const box = document.createElement("aside");
    box.id = "capture-instrument";
    box.setAttribute("aria-hidden", "true");
    box.style.cssText = [
      "position:fixed", "right:24px", "top:84px", "z-index:2147483647", "max-width:440px",
      "padding:12px 14px", "border:1px dashed currentColor", "border-radius:8px",
      `background:${style.backgroundColor}`, `color:${style.color}`,
      "font:12px/1.6 ui-monospace,Menlo,monospace", "white-space:pre-wrap",
    ].join(";");
    const lines = [
      `[캡처 계기 · 제품 화면 아님] ${sceneName}`,
      `셸(notification_show)이 받은 OS 배너 호출: ${calls.length}건`,
      ...calls.map((c, i) => `${i + 1}. ${c.title}${c.body ? ` · ${c.body}` : ""}`),
    ];
    box.textContent = lines.join("\n");
    document.body.append(box);
  }, { scene, list });
}

const shoot = async (page, name, tag) => {
  await page.waitForTimeout(250);
  await page.screenshot({ path: resolve(OUT_DIR, `${name}-1440-${tag}.png`) });
};

const pauseLine = (page) => page.getByTestId("pause-banner");

/** 멘션·승인·DM 을 한 번씩 보내고 묶음 창이 지나길 기다린다. */
async function fireThree(page, nowMs) {
  await push(page, mention(nowMs));
  await push(page, approval(nowMs));
  await push(page, directMessage(nowMs));
  await page.waitForTimeout(COALESCE_WAIT_MS);
}

async function sceneA(browser, origin, scheme, report) {
  const server = newServer({ dnd: true, dndUntilMs: UNTIL_2230, presenceStatus: "dnd" });
  const { context, page } = await openScene(browser, origin, scheme, server);
  await pauseLine(page).waitFor({ timeout: 8000 });
  await fireThree(page, FIXED_NOW);
  const got = await banners(page);
  report[`A-paused-${scheme}`] = got;
  await paintInstrument(page, `A 일시 중지 중 · ${scheme}`, got);
  await shoot(page, "A-paused", scheme);
  if (BEFORE) console.log(`[before ${scheme}] A 일시 중지 중 배너 ${got.length}건 (기대: 일시 중지를 무시하니 3건)`);
  else {
    check(`A ${scheme} 일시 중지 중 멘션·승인·DM 에 OS 배너 0건`, got.length === 0, JSON.stringify(got));
    check(`A ${scheme} 사이드바의 「알림 일시 중지 중」 줄이 서 있다`, await pauseLine(page).isVisible());
  }
  await context.close();
}

async function sceneB(browser, origin, scheme, report) {
  const server = newServer();
  const { context, page } = await openScene(browser, origin, scheme, server);
  await page.getByTestId("profile-card").waitFor({ timeout: 8000 });
  await fireThree(page, FIXED_NOW);
  const got = await banners(page);
  report[`B-control-${scheme}`] = got;
  await paintInstrument(page, `B 대조(일시 중지 꺼짐) · ${scheme}`, got);
  await shoot(page, "B-control", scheme);
  check(`B ${scheme} 일시 중지가 꺼져 있으면 같은 세 건이 배너 3건이다(하네스가 배너를 본다)`, got.length === 3, JSON.stringify(got));
  check(
    `B ${scheme} 멘션·승인·DM 한 건씩이다`,
    got.some((b) => b.title === "곽민지" && b.body.startsWith("@성재")) &&
      got.some((b) => b.title.startsWith("승인 필요") && b.body === "스테이징에 배포") &&
      got.some((b) => b.title === "곽민지" && b.body === "점심 먹었어요?"),
    JSON.stringify(got)
  );
  await context.close();
}

async function sceneC(browser, origin, scheme, report) {
  const server = newServer({ dnd: true, dndUntilMs: UNTIL_2230, presenceStatus: "dnd" });
  const { context, page } = await openScene(browser, origin, scheme, server);
  await pauseLine(page).waitFor({ timeout: 8000 });
  await push(page, mention(FIXED_NOW));
  await page.waitForTimeout(COALESCE_WAIT_MS);
  const during = await banners(page);
  // 사이드바의 「다시 켜기」(PATCH {dnd:false}) — 같은 규칙 캐시가 갱신돼 레일이 곧바로 따른다.
  await page.getByTestId("pause-banner-action").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="pause-banner"]')?.getAttribute("data-kind") !== "paused", null, { timeout: 5000 });
  // 단추를 누르는 일이 창에 포커스를 줬을 수 있다: 창은 다시 뒤에 있다.
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await push(page, mention(FIXED_NOW));
  await page.waitForTimeout(COALESCE_WAIT_MS);
  const after = await banners(page);
  report[`C-resume-${scheme}`] = { during, after };
  await paintInstrument(page, `C 「다시 켜기」 뒤 · ${scheme}`, after);
  await shoot(page, "C-resume", scheme);
  if (BEFORE) console.log(`[before ${scheme}] C 일시 중지 중 ${during.length}건 → 다시 켜기 뒤 ${after.length}건`);
  else {
    check(`C ${scheme} 일시 중지 중 멘션 배너 0건`, during.length === 0, JSON.stringify(during));
    check(`C ${scheme} 「다시 켜기」 뒤의 멘션은 배너 1건`, after.length === 1, JSON.stringify(after));
  }
  await context.close();
}

/** D: 폰에서 건 일시 중지는 서버만 바뀐다. 이 기기는 간격 재조회로 안다. */
async function sceneD(browser, origin, scheme, report) {
  const server = newServer();
  const { context, page } = await openScene(browser, origin, scheme, server);
  await page.getByTestId("profile-card").waitFor({ timeout: 8000 });
  await push(page, mention(FIXED_NOW));
  await page.waitForTimeout(COALESCE_WAIT_MS);
  const first = (await banners(page)).length;
  // 폰에서 일시 중지를 걸었다.
  server.rules = { ...server.rules, dnd: true, dndUntilMs: UNTIL_2230 };
  const getsBefore = server.rulesGets;
  await page.waitForTimeout(POLL_WAIT_MS);
  const polled = server.rulesGets > getsBefore;
  await push(page, mention(FIXED_NOW));
  await page.waitForTimeout(COALESCE_WAIT_MS);
  const second = (await banners(page)).length;
  // 폰에서 풀었다.
  server.rules = { ...server.rules, dnd: false, dndUntilMs: undefined };
  const getsMid = server.rulesGets;
  await page.waitForTimeout(POLL_WAIT_MS);
  const polledAgain = server.rulesGets > getsMid;
  await push(page, mention(FIXED_NOW));
  await page.waitForTimeout(COALESCE_WAIT_MS);
  const third = (await banners(page)).length;
  report[`D-cross-device-${scheme}`] = { first, second, third, polled, polledAgain };
  if (BEFORE) console.log(`[before ${scheme}] D 다른 기기: 배너 수 ${first} → ${second} → ${third} (기대: 일시 중지를 모르니 1 → 2 → 3)`);
  else {
    check(`D ${scheme} 간격 재조회가 나갔다(일시 중지 건 뒤·푼 뒤)`, polled && polledAgain, JSON.stringify({ polled, polledAgain }));
    check(`D ${scheme} 폰에서 건 일시 중지 뒤의 멘션은 배너가 늘지 않는다 (${first} → ${second})`, first === 1 && second === 1, JSON.stringify({ first, second }));
    check(`D ${scheme} 폰에서 푼 뒤의 멘션은 다시 뜬다 (${second} → ${third})`, third === 2, JSON.stringify({ third }));
  }
  await context.close();
}

/** E: 기한은 서버 시계가 판정한다. 지난 뒤 다시 읽은 값이 오면 배너가 다시 뜬다. */
async function sceneE(browser, origin, scheme, report) {
  const server = newServer({ dnd: true, dndUntilMs: FIXED_NOW + 30 * 60_000, presenceStatus: "dnd" });
  const { context, page } = await openScene(browser, origin, scheme, server);
  await pauseLine(page).waitFor({ timeout: 8000 });
  await push(page, mention(FIXED_NOW));
  await page.waitForTimeout(COALESCE_WAIT_MS);
  const during = (await banners(page)).length;
  // 31분이 흘렀다: 이 기기 시계와 서버 시계가 함께 기한을 지난다. 서버는 읽기에 dnd:false 를 준다.
  const later = FIXED_NOW + 31 * 60_000;
  await context.clock.setFixedTime(later);
  server.nowMs = later;
  const getsBefore = server.rulesGets;
  await page.waitForTimeout(POLL_WAIT_MS);
  const reread = server.rulesGets > getsBefore;
  await push(page, mention(later));
  await page.waitForTimeout(COALESCE_WAIT_MS);
  const after = await banners(page);
  report[`E-expiry-${scheme}`] = { during, after, reread };
  if (BEFORE) console.log(`[before ${scheme}] E 만료: 기한 안 ${during}건 → 기한 뒤 ${after.length}건`);
  else {
    check(`E ${scheme} 기한 안의 멘션은 배너 0건`, during === 0, String(during));
    check(`E ${scheme} 기한이 지나면 서버에 다시 물었다`, reread, "no re-read");
    check(`E ${scheme} 서버가 풀었다고 답한 뒤의 멘션은 배너 1건`, after.length === 1, JSON.stringify(after));
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
      await sceneA(browser, preview.origin, scheme, report);
      await sceneB(browser, preview.origin, scheme, report);
      await sceneC(browser, preview.origin, scheme, report);
    }
    // D·E 는 진짜 타이머를 기다린다: 두 장면을 나란히 돌려 기다림을 겹친다.
    await Promise.all([
      sceneD(browser, preview.origin, "light", report),
      sceneE(browser, preview.origin, "light", report),
    ]);
  } finally {
    await browser.close();
    await preview.stop?.();
  }
  writeFileSync(resolve(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));
  if (failures.length > 0) {
    console.error(`\n${failures.length}개 단언 실패`);
    process.exit(1);
  }
  console.log(BEFORE ? "\n전 판: 센 값만 적었다" : "\n모든 단언 통과");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
