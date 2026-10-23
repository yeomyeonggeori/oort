#!/usr/bin/env node
// =============================================================================
// 아바타 편집기 캡처와 실제 앱 위의 단정 (#4261).
//
//   npm run build
//   node scripts/capture-4261.mjs                     # Chromium
//   ENGINE=webkit node scripts/capture-4261.mjs       # WebKit(데스크탑 앱의 WKWebView 와 같은 엔진)
//   OUT_ROOT=<폴더> ...                               # 캡처를 놓을 곳(기본 artifacts/avatar-4261, 커밋하지 않는다)
//   SCHEMES=light node scripts/capture-4261.mjs       # 색 구성 고르기(기본 light,dark)
//   SCENES=keyboard node scripts/capture-4261.mjs     # 장면 묶음 고르기: main(저장 길·세 모드) · keyboard(창 높이 여섯 × 초점) · states(올리는 중·오류·오프라인·Esc)
//
// 라이트·다크 × (사진 · 이모지 · 코메토) 편집기를 찍는다. 대화상자 맨 위의 미리보기 띠가 **진짜 아바타 컴포넌트**를
// 사이드바 24 · 메시지 32 · 프로필 큰 원으로 보여 주므로 한 장에 세 크기가 다 들어온다. 고르는 일은 전부 진짜 컨트롤을
// 눌러서 한다(사진은 `setInputFiles` 의 진짜 파일 선택 경로, 이모지·색·표정은 칩 클릭).
//
// 단정(하나라도 어긋나면 exit 1):
//   ① 이모지 아바타를 **저장**하면 서버(모의)가 받은 바이트가 512×512 PNG 이고 구조(시그니처·IHDR·IEND)가 온전하다.
//   ② 서버가 돌려준 바이트(= 다른 멤버가 받는 바이트)가 올린 바이트와 한 글자도 다르지 않다. 그 PNG 를 다시 디코드해
//      네 모서리가 고른 배경색과 같다.
//   ③ 저장한 뒤 프로필 큰 원과 메시지 행의 내 아바타가 `<img>` 로 그려진다(캡처로 확인한다).
//   ④ 요청 본문이 있는 바깥 요청은 Drive 모의 PUT 하나뿐이고, 베어러가 실리지 않았다.
//   ⑤ 묻히는 조합: 연한 바탕 위의 밝은 이모지는 저장 단추가 잠기고 이유 한 줄이 선다. 서버로 나간 쓰기가 없다.
//
// 백엔드 없이 `/v1/**` 고정 응답 + 가짜 소켓. 벽시계·로케일·시간대를 고정한다. 가상 인물(이도현·박서연 등)만 쓴다.
// =============================================================================
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = process.env.DIST || "dist";
const OUT_ROOT = process.env.OUT_ROOT ? resolve(process.env.OUT_ROOT) : resolve(WEB_ROOT, "artifacts/avatar-4261");
const PORT = Number(process.env.CAPTURE_PORT || 5393);
const ENGINE = process.env.ENGINE === "webkit" ? "webkit" : "chromium";
const launcher = ENGINE === "webkit" ? webkit : chromium;
const SCHEMES = (process.env.SCHEMES || "light,dark").split(",").map((name) => name.trim()).filter((name) => name === "light" || name === "dark");
const VIEWPORT = { width: 1440, height: 1000 };

const FIXTURE_NOW = Date.parse("2026-10-23T10:00:00+09:00");
const MIN = 60_000;
const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const CH = "00000000-0000-7000-8000-000000000201";
const GENERAL = "00000000-0000-7000-8000-000000000202";
const P = (n) => `00000000-0000-7000-8000-0000000001${n}`;
const person = (id, displayName, handle, extra = {}) => ({
  id, workspaceId, kind: "human", status: "active", displayName, handle, channelCount: 2,
  channelIds: [CH, GENERAL], capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...extra,
});
const baseRoster = [
  person(memberId, "이도현", "dohyun", { role: "owner" }),
  person(P("12"), "박서연", "seoyeon"),
  person(P("13"), "최민수", "minsu"),
  person(P("15"), "정하윤", "hayun"),
];
const channels = [
  { id: CH, workspaceId, kind: "public", name: "계획", muted: false },
  { id: GENERAL, workspaceId, kind: "public", name: "general", muted: false },
  { id: "00000000-0000-7000-8000-000000000203", workspaceId, kind: "public", name: "디자인-검수", muted: false },
];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "이도현", handle: "dohyun" },
  realtimeWebSocketUrl: "ws://avatar-4261-capture.invalid/connection/websocket",
};
const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

function messageRows() {
  const m = (n, author, body, ago) => ({
    id: `00000000-0000-7000-8000-0000000a00${String(n).padStart(2, "0")}`,
    channelId: CH, seq: 10 + n, hlcTs: FIXTURE_NOW - ago, hlcCount: 0, authorMemberId: author,
    type: "text", body, state: "sent", createdAtMs: FIXTURE_NOW - ago,
  });
  return [
    m(1, P("12"), "주간 회의 자료 올렸어요. 3쪽 숫자만 같이 봐 주세요.", 42 * MIN),
    m(2, memberId, "확인했어요. 매출 표는 다시 계산해서 올릴게요.", 38 * MIN),
    m(3, P("13"), "저는 일정 쪽을 맡을게요. 배포 전날 점검은 제가 해요.", 31 * MIN),
    m(4, memberId, "디자인 시안은 내일 오전에 공유해요. 링크는 그때 붙일게요.", 24 * MIN),
  ];
}

// ---- 서버 상태(모의): 올린 아바타 한 장 --------------------------------------------------------
const server = { upload: null, served: null, mediaId: null, avatarUrl: null, writes: [], outbound: [], authHeaders: [], hold: null, release: null, failUpload: null };

function resetServer() {
  server.upload = null; server.served = null; server.mediaId = null; server.avatarUrl = null;
  server.writes.length = 0; server.outbound.length = 0; server.authHeaders.length = 0;
  server.hold = null; server.release = null; server.failUpload = null;
}

/** 다음 Drive PUT 응답을 붙들어 둔다(올리는 중 장면). `server.release()` 가 놓는다. */
function holdNextUpload() {
  server.hold = new Promise((resolve) => { server.release = () => { server.hold = null; resolve(); }; });
}

async function installRoutes(context, origin) {
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (url.origin !== origin && !request.url().startsWith("data:")) {
      server.outbound.push(`${method} ${url.origin}`);
      return route.abort();
    }
    if (path.startsWith("/__drive/") && method === "PUT") {
      server.upload = request.postDataBuffer();
      server.authHeaders.push(request.headers()["authorization"] ?? null);
      if (server.hold) await server.hold;
      return route.fulfill({ status: 200, body: "" });
    }
    if (!path.startsWith("/v1/")) return route.continue();
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/logout") return json(route, {});
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: FIXTURE_NOW + 600_000, ttlSeconds: 60, workspaceId, memberId });
    }
    // ---- 내 아바타 (ADR-0161 증보) -------------------------------------------------------------
    if (path.endsWith("/members/me/avatar/uploads") && method === "POST" && server.failUpload) {
      return json(route, { error: { code: "capture_failure", message: "capture-only failure" } }, server.failUpload);
    }
    if (path.endsWith("/members/me/avatar/uploads") && method === "POST") {
      server.writes.push("create-upload");
      server.mediaId = "00000000-0000-7000-8000-00000000f001";
      return json(route, { id: server.mediaId, status: "pending", uploadUrl: `${origin}/__drive/${server.mediaId}` });
    }
    if (/\/members\/me\/avatar\/[^/]+\/complete$/.test(path) && method === "POST") {
      server.writes.push("complete");
      server.served = server.upload;
      server.avatarUrl = `/v1/workspaces/${workspaceId}/members/${memberId}/avatar/content?v=${server.mediaId}`;
      return json(route, { id: server.mediaId, memberId, status: "ready", avatarUrl: server.avatarUrl });
    }
    if (path.endsWith("/members/me/avatar") && method === "DELETE") {
      server.writes.push("delete");
      server.served = null; server.avatarUrl = null;
      return route.fulfill({ status: 204, body: "" });
    }
    if (/\/members\/[^/]+\/avatar\/content$/.test(path)) {
      if (!server.served) return json(route, { error: { code: "not_found", message: "none" } }, 404);
      return route.fulfill({ status: 200, contentType: "image/png", body: server.served });
    }
    if (/\/inbox(\/|$)/.test(path)) return json(route, { error: { code: "not_found", message: "not found" } }, 404);
    if (path.endsWith("/agent-runs/progress")) return json(route, { runs: [] });
    if (path.endsWith("/hosted-agent-connections") && method === "GET") return json(route, { connections: [] });
    if (path.endsWith("/allowed-models")) return json(route, { allowedAgentModels: [] });
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) {
      return json(route, { members: baseRoster.map((m) => (m.id === memberId && server.avatarUrl ? { ...m, avatarUrl: server.avatarUrl } : m)) });
    }
    if (path.endsWith("/read-state") && method === "GET") {
      return json(route, { read_states: channels.map((c) => ({ channel_id: c.id, last_read_seq: 99, latest_seq: 99, unread_count: 0, mention_count: 0, marked_unread_before_seq: null })) });
    }
    if (path.endsWith("/approvals")) return json(route, { approvals: [] });
    if (path.endsWith("/agent-runs")) return json(route, { runs: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/members/me/sidebar-prefs")) return json(route, { prefs: { version: 1, sections: [], starredChannelIds: [] } });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: [] });
    if (path.endsWith("/work-sessions/shared")) return json(route, { sessions: [], nextCursor: null });
    if (path.endsWith("/work-sessions")) return json(route, { workSessions: [] });
    if (path.endsWith("/reminders")) return json(route, { reminders: [] });
    if (path.endsWith(`/workspaces/${workspaceId}`)) return json(route, { workspace: { id: workspaceId, name: "달무리 스튜디오" } });
    if (path.includes(`/channels/${CH}/messages`)) return json(route, { messages: messageRows() });
    if (path.includes("/messages")) return json(route, { messages: [] });
    return json(route, {});
  });
}

async function installPageFixtures(page) {
  await page.addInitScript((now) => {
    const NativeDate = Date;
    function FrozenDate(...args) {
      if (new.target) return Reflect.construct(NativeDate, args.length === 0 ? [now] : args);
      return new NativeDate(now).toString();
    }
    FrozenDate.now = () => now;
    FrozenDate.parse = NativeDate.parse.bind(NativeDate);
    FrozenDate.UTC = NativeDate.UTC.bind(NativeDate);
    FrozenDate.prototype = NativeDate.prototype;
    FrozenDate.prototype.constructor = FrozenDate;
    globalThis.Date = FrozenDate;
  }, FIXTURE_NOW);
  // 앱이 Drive 로 보내는 PUT 본문을 페이지 안에서 적는다. 엔진마다 모의 서버(`request.postDataBuffer()`)가 Blob 본문을 읽는지가 달라서
  // (WebKit 은 null) 두 길을 모두 둔다: 서버가 받은 바이트(읽히는 엔진에서)와 앱이 보낸 바이트(어느 엔진에서든).
  await page.addInitScript(() => {
    const nativeOpen = XMLHttpRequest.prototype.open;
    const nativeSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__capture = { method: String(method).toUpperCase(), url: String(url) };
      return nativeOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (body) {
      if (this.__capture?.method === "PUT" && body instanceof Blob) {
        const meta = this.__capture;
        body.arrayBuffer().then((buffer) => {
          (window.__putBodies ??= []).push({ url: meta.url, bytes: Array.from(new Uint8Array(buffer)) });
        });
      }
      return nativeSend.call(this, body);
    };
  });
  // 오프라인 장면: 창이 열려 있는 동안 연결이 끊기는 것을 모든 엔진에서 같게 만든다(`context.setOffline` 은 엔진마다 `navigator.onLine`
  // 이 다르다). `window.__forceOffline` 을 켜고 `offline` 이벤트를 쏘면 앱의 오프라인 판단(`useBrowserOffline`)이 그대로 읽는다.
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "onLine", { configurable: true, get: () => !window.__forceOffline });
  });
  await page.addInitScript(() => {
    class CaptureSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      constructor(url) {
        this.url = String(url); this.readyState = 0; window.__socket = this;
        queueMicrotask(() => { this.readyState = 1; this.onopen?.(new Event("open")); });
      }
      send(data) {
        const replies = String(data).trim().split("\n").map((line) => {
          const c = JSON.parse(line);
          if (c.connect) return { id: c.id, connect: { client: "4261-capture", version: "6" } };
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

async function openContext(browser, origin, scheme) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    colorScheme: scheme,
    reducedMotion: "reduce",
    serviceWorkers: "block",
    deviceScaleFactor: 2,
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
  });
  await installRoutes(context, origin);
  const page = await context.newPage();
  await installPageFixtures(page);
  await page.addInitScript((serverOrigin) => {
    try { localStorage.setItem("momo.web.server.v1", serverOrigin); } catch { /* 저장소 없는 캡처 */ }
  }, origin);
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("profile-card").waitFor({ timeout: 20_000 });
  return { context, page };
}

async function goProfile(page) {
  await page.evaluate(() => { location.hash = "/settings?section=profile"; });
  await page.getByTestId("profile-hero").waitFor({ timeout: 15_000 });
  await page.waitForTimeout(300);
}

async function goChat(page) {
  await page.evaluate((id) => { location.hash = `/c/${id}`; }, CH);
  await page.getByText("확인했어요. 매출 표는 다시 계산해서 올릴게요.").first().waitFor({ timeout: 15_000 });
  await page.waitForTimeout(500);
}

/** 사진처럼 보이는 JPEG 한 장(황혼 산)을 브라우저 캔버스로 만든다. 소스에 픽셀을 박지 않는다. */
async function makeDuskJpeg(page) {
  const base64 = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 1200; canvas.height = 900;
    const g = canvas.getContext("2d");
    const sky = g.createLinearGradient(0, 0, 0, 640);
    sky.addColorStop(0, "#1c2452"); sky.addColorStop(0.5, "#7a4a8c"); sky.addColorStop(0.85, "#f08a5d"); sky.addColorStop(1, "#ffd08a");
    g.fillStyle = sky; g.fillRect(0, 0, 1200, 900);
    const sun = g.createRadialGradient(800, 560, 0, 800, 560, 260);
    sun.addColorStop(0, "rgba(255,244,214,1)"); sun.addColorStop(1, "rgba(255,160,90,0)");
    g.fillStyle = sun; g.fillRect(0, 0, 1200, 900);
    g.fillStyle = "#3a2a4f"; g.beginPath(); g.moveTo(0, 900); g.lineTo(0, 640);
    for (let x = 0; x <= 1200; x += 40) g.lineTo(x, 640 + Math.sin(x / 90) * 40);
    g.lineTo(1200, 900); g.closePath(); g.fill();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  });
  return Buffer.from(base64, "base64");
}

const results = [];
const meta = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
}

const outDir = () => resolve(OUT_ROOT, ENGINE);
async function shoot(locator, name, scheme) {
  const path = resolve(outDir(), `${name}-${scheme}.png`);
  await locator.screenshot({ path });
  meta.push({ name, scheme, path });
  return path;
}

const dialog = (page) => page.getByTestId("avatar-editor-dialog");
const chooseMode = (page, mode) => page.locator(`label:has([data-testid="avatar-editor-mode-${mode}"])`).click();
const pickColor = (page, id) => page.locator(`label:has([data-testid="avatar-color-${id}"])`).click();
/** 이모지 칸은 글자로 찾는다(카탈로그의 글리프에 변형 선택자가 붙는 것이 있어 테스트 id 의 글자와 다를 수 있다). */
const emojiCell = (page, glyph) => page.locator('[data-testid="avatar-emoji-picker"] [data-emoji-cell]').filter({ hasText: glyph }).first();
const waitDraftPreview = (page) =>
  page.waitForFunction(() => document.querySelector('[data-testid="avatar-editor-preview"][data-source="draft"] img'), null, { timeout: 15_000 });
const settle = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

function pngInfo(bytes) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!bytes || bytes.length < 45 || sig.some((v, i) => bytes[i] !== v)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const iend = [0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
  const tail = bytes.length - iend.length;
  return {
    width: view.getUint32(16),
    height: view.getUint32(20),
    ihdr: String.fromCharCode(...bytes.slice(12, 16)),
    ended: iend.every((v, i) => bytes[tail + i] === v),
  };
}

async function decodeCorners(page, bytes) {
  return page.evaluate(async (data) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(data)], { type: "image/png" }));
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const g = canvas.getContext("2d", { willReadFrequently: true });
    g.drawImage(bitmap, 0, 0);
    const at = (x, y) => Array.from(g.getImageData(x, y, 1, 1).data);
    return [at(0, 0), at(bitmap.width - 1, 0), at(0, bitmap.height - 1), at(bitmap.width - 1, bitmap.height - 1)];
  }, Array.from(bytes));
}

async function scenesFor(browser, origin, scheme) {
  resetServer();
  const { context, page } = await openContext(browser, origin, scheme);
  try {
    await goProfile(page);
    await shoot(page.getByTestId("profile-hero"), "hero-before", scheme);
    const duskJpeg = await makeDuskJpeg(page);

    // ---- 열기 ------------------------------------------------------------------------------
    await page.getByTestId("profile-avatar-change").click();
    await dialog(page).waitFor({ timeout: 15_000 });
    await settle(page);
    await shoot(dialog(page), "editor-open", scheme);

    // ---- 사진 ------------------------------------------------------------------------------
    await page.getByTestId("profile-avatar-input").setInputFiles({ name: "dusk.jpg", mimeType: "image/jpeg", buffer: duskJpeg });
    await waitDraftPreview(page);
    await settle(page);
    await shoot(dialog(page), "mode-photo", scheme);

    // ---- 이모지 ----------------------------------------------------------------------------
    await chooseMode(page, "emoji");
    await emojiCell(page, "🚀").waitFor({ timeout: 15_000 });
    await shoot(dialog(page), "mode-emoji-empty", scheme);
    await emojiCell(page, "🚀").click();
    await waitDraftPreview(page);
    await settle(page);
    await shoot(dialog(page), "mode-emoji", scheme);
    // H-2: 아바타로 고른 이모지는 컴포저·반응·메시지 툴바가 읽는 「자주 쓰는」 기록을 바꾸지 않는다.
    const frequency = await page.evaluate(() => localStorage.getItem("momo.web.emoji.frequency.v1"));
    check(`⑩ 아바타로 이모지를 골라도 「자주 쓰는」 기록은 그대로다 [${scheme}]`, frequency === null, `localStorage=${frequency}`);

    // ⑤ 묻히는 조합: 밝은 이모지(🌕 계열 노랑) 위에 연한 배경을 직접 입력한다. 서버 쓰기는 없어야 한다.
    await emojiCell(page, "✨").click();
    await page.getByTestId("avatar-color-input").fill("#ffe75c");
    await settle(page);
    const saveBlocked = await page.getByTestId("avatar-editor-save").getAttribute("aria-disabled");
    const reasonText = (await page.getByTestId("avatar-editor-status").textContent())?.trim();
    check(`⑤ 묻히는 조합은 저장이 잠기고 이유를 말한다 [${scheme}]`, saveBlocked === "true" && /잘 안 보여요/.test(reasonText ?? ""), `aria-disabled=${saveBlocked} reason="${reasonText}"`);
    await page.getByTestId("avatar-editor-save").click({ force: true });
    await page.waitForTimeout(200);
    check(`⑤ 잠긴 저장 단추를 눌러도 서버 쓰기가 없다 [${scheme}]`, server.writes.length === 0, `writes=${server.writes.join(",") || "none"}`);
    // 잠긴 단추의 전이(색·불투명도)가 끝난 뒤에 찍는다: 전이 중간 프레임은 활성 단추처럼 보인다(design-review Low).
    await page.waitForTimeout(400);
    await shoot(dialog(page), "emoji-blocked", scheme);

    // 되돌려 정상 조합으로: 칩이 흐려진 색은 고를 수 없고, 팔레트에서 통과하는 색을 고른다.
    await pickColor(page, "navy");
    await emojiCell(page, "🚀").click();
    await waitDraftPreview(page);
    await settle(page);

    // ---- 코메토 ----------------------------------------------------------------------------
    await chooseMode(page, "preset");
    await page.getByTestId("avatar-preset-happy").waitFor({ timeout: 15_000 });
    await page.locator('label:has([data-testid="avatar-preset-happy"])').click();
    await waitDraftPreview(page);
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="avatar-preset-picker"] img').length === 6, null, { timeout: 15_000 });
    await settle(page);
    await shoot(dialog(page), "mode-preset", scheme);
    await pickColor(page, "forest");
    await settle(page);
    await shoot(dialog(page), "mode-preset-forest", scheme);
    await pickColor(page, "navy");

    // ---- ⑥ 창 높이에 따른 미리보기 띠 (design-review H-3) ----------------------------------------------
    // 높이 780 초과에서는 색 칩까지 스크롤해도 미리보기가 위에 붙어 보이고, 그 이하(노트북 창·지원 최소 창)에서는 붙지 않고 본문과
    // 같이 스크롤된다(붙은 띠가 본문 높이를 먹어서 지원 최소 창에서 컨트롤이 60px 만 보였다).
    await chooseMode(page, "emoji");
    await emojiCell(page, "🚀").click();
    await waitDraftPreview(page);
    for (const [name, height, pinned] of [["tall-900", 900, true], ["short-720", 720, false]]) {
      await page.setViewportSize({ width: 1280, height });
      await settle(page);
      await page.waitForTimeout(200);
      await page.getByTestId("avatar-color-input").scrollIntoViewIfNeeded();
      await settle(page);
      const state = await page.evaluate(() => {
        const body = document.querySelector('[data-testid="avatar-editor-body"]');
        const sticky = document.querySelector(".avatar-editor-sticky");
        const input = document.querySelector('[data-testid="avatar-color-input"]');
        const rect = (node) => { const r = node.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
        return {
          position: getComputedStyle(sticky).position,
          cssHeight: body.style.getPropertyValue("--avatar-editor-sticky-height"),
          stickyHeight: Math.round(sticky.getBoundingClientRect().height),
          scrollable: body.hasAttribute("data-scrollable"),
          mask: getComputedStyle(body).maskImage || getComputedStyle(body).webkitMaskImage || "",
          body: rect(body), sticky: rect(sticky), input: rect(input),
          bodyClient: body.clientHeight, scrollTop: Math.round(body.scrollTop),
        };
      });
      const detail = JSON.stringify(state);
      if (pinned) {
        check(`⑥ ${name}: 미리보기 띠가 붙고(sticky) 색 입력까지 스크롤해도 본문 맨 위에 보인다 [${scheme}]`,
          state.position === "sticky" && state.sticky.top >= state.body.top - 1 && state.sticky.bottom <= state.body.bottom + 1 && state.scrollTop > 0, detail);
        check(`⑥ ${name}: 띠 높이를 재서 초점 스크롤 여백으로 넘긴다 (--avatar-editor-sticky-height) [${scheme}]`,
          state.cssHeight === `${state.stickyHeight}px`, detail);
        check(`⑥ ${name}: 색 입력이 띠 밑이 아니라 띠 아래에 선다 [${scheme}]`, state.input.top >= state.sticky.bottom - 1, detail);
      } else {
        check(`⑥ ${name}: 낮은 창에서는 띠가 붙지 않고 본문과 같이 스크롤된다 [${scheme}]`,
          state.position !== "sticky" && state.sticky.bottom <= state.body.top + 1, detail);
        check(`⑥ ${name}: 색 입력이 본문 안에 온전히 보인다 [${scheme}]`, state.input.top >= state.body.top - 1 && state.input.bottom <= state.body.bottom + 1, detail);
      }
      check(`⑥ ${name}: 내용이 본문보다 길면 스크롤 단서(아래 가장자리 마스크)가 선다 [${scheme}]`,
        state.scrollable && /gradient/.test(state.mask), detail);
      await shoot(dialog(page), `${name}-scrolled`, scheme);
    }
    await page.setViewportSize(VIEWPORT);
    await settle(page);

    // ---- 좁은 창·중간 창: 가로로 넘치지 않고 칩과 단추가 접힌다 ---------------------------------------
    for (const size of [{ name: "narrow-390", width: 390, height: 844 }, { name: "mid-900", width: 900, height: 700 }]) {
      await page.setViewportSize({ width: size.width, height: size.height });
      await settle(page);
      for (const mode of ["emoji", "preset"]) {
        await chooseMode(page, mode);
        if (mode === "preset") await page.getByTestId("avatar-preset-picker").locator("img").first().waitFor({ timeout: 15_000 });
        await settle(page);
        const overflow = await page.evaluate(() => {
          const panel = document.querySelector('[data-testid="avatar-editor-dialog"]');
          const body = panel?.querySelector('[data-testid="avatar-editor-body"]');
          return {
            page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            panel: panel ? panel.scrollWidth - panel.clientWidth : -1,
            body: body ? body.scrollWidth - body.clientWidth : -1,
          };
        });
        check(`⑦ ${size.width}px ${mode} 탭이 가로로 넘치지 않는다 [${scheme}]`, overflow.page <= 0 && overflow.panel <= 0 && overflow.body <= 0, JSON.stringify(overflow));
        await shoot(dialog(page), `${size.name}-${mode}`, scheme);
      }
    }
    await page.setViewportSize(VIEWPORT);
    await settle(page);
    await chooseMode(page, "emoji");
    await settle(page);

    // ---- 저장(진짜 쓰기 길) ------------------------------------------------------------------
    await chooseMode(page, "emoji");
    await emojiCell(page, "🚀").click();
    await waitDraftPreview(page);
    await pickColor(page, "navy");
    await settle(page);
    const before = server.writes.length;
    await page.getByTestId("avatar-editor-save").click();
    await dialog(page).waitFor({ state: "detached", timeout: 20_000 });
    await page.waitForFunction(() => document.querySelector('[data-testid="profile-avatar"] img'), null, { timeout: 15_000 });
    await settle(page);
    await shoot(page.getByTestId("profile-hero"), "hero-after", scheme);

    await page.waitForFunction(() => (window.__putBodies?.length ?? 0) >= 1, null, { timeout: 15_000 });
    const recorded = await page.evaluate(() => window.__putBodies ?? []);
    const sent = recorded.length === 1 ? Buffer.from(recorded[0].bytes) : null;
    check(`앱이 Drive 로 보낸 PUT 은 한 번이고 본문이 있다 [${scheme}]`, recorded.length === 1 && !!sent && sent.length > 0, `puts=${recorded.length} bytes=${sent?.length ?? 0}`);
    // 서버(모의)가 본문을 읽는 엔진에서는 서버가 받은 바이트와 앱이 보낸 바이트가 같은지 잰다. 못 읽는 엔진(WebKit)에서는 앱이 보낸
    // 바이트를 올린 바이트로 삼는다(그 사실을 detail 에 적는다).
    const serverSaw = server.upload !== null && server.upload !== undefined && server.upload.length > 0;
    if (serverSaw) {
      check(`서버가 받은 본문이 앱이 보낸 본문과 같다 [${scheme}]`, !!sent && Buffer.compare(server.upload, sent) === 0, `engine=${ENGINE}`);
    } else {
      server.upload = sent;
      server.served = sent;
    }
    const uploaded = server.upload;
    const info = pngInfo(uploaded);
    check(`① 올라간 바이트가 512×512 PNG 이고 구조가 온전하다 [${scheme}]`, !!info && info.width === 512 && info.height === 512 && info.ihdr === "IHDR" && info.ended, JSON.stringify(info));
    check(`② 서버가 돌려줄 바이트가 올린 바이트와 같다 [${scheme}]`, !!uploaded && !!server.served && Buffer.compare(uploaded, server.served) === 0, `source=${serverSaw ? "server-received" : "app-sent (server cannot read the body on this engine)"} sha256=${uploaded ? createHash("sha256").update(uploaded).digest("hex").slice(0, 16) : "none"}`);
    const corners = uploaded ? await decodeCorners(page, uploaded) : [];
    const navy = [0x22, 0x28, 0x40, 255];
    check(`② 올린 PNG 의 네 모서리가 고른 배경(남색)과 같다 [${scheme}]`, corners.length === 4 && corners.every((c) => c.every((v, i) => v === navy[i])), JSON.stringify(corners));
    check(`쓰기 길은 세션 열기 → complete 둘뿐이다 [${scheme}]`, server.writes.slice(before).join(",") === "create-upload,complete", server.writes.join(","));
    check(`④ Drive PUT 에 베어러가 실리지 않았다 [${scheme}]`, server.authHeaders.length === 1 && server.authHeaders[0] === null, JSON.stringify(server.authHeaders));
    check(`④ 같은 오리진 밖으로 나간 요청이 없다 [${scheme}]`, server.outbound.length === 0, server.outbound.join(" | ") || "none");

    // ---- ③ 실제 표면 -----------------------------------------------------------------------
    await goChat(page);
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="row-avatar"] img').length >= 1, null, { timeout: 15_000 });
    await settle(page);
    const messageImgs = await page.locator('[data-testid="row-avatar"] img').count();
    check(`③ 메시지 행의 내 아바타가 이미지로 그려진다 [${scheme}]`, messageImgs >= 1, `images=${messageImgs}`);
    await page.screenshot({ path: resolve(outDir(), `chat-after-${scheme}.png`) });
    meta.push({ name: "chat-after", scheme, path: resolve(outDir(), `chat-after-${scheme}.png`) });

    // ---- 기본으로 되돌리기 -------------------------------------------------------------------
    await goProfile(page);
    await page.getByTestId("profile-avatar-change").click();
    await dialog(page).waitFor({ timeout: 15_000 });
    await page.getByTestId("avatar-editor-reset").waitFor();
    await shoot(dialog(page), "editor-with-avatar", scheme);
    await page.getByTestId("avatar-editor-reset").click();
    await shoot(dialog(page), "reset-confirm", scheme);
    await page.getByTestId("avatar-editor-reset-confirm").click();
    await dialog(page).waitFor({ state: "detached", timeout: 20_000 });
    await settle(page);
    check(`기본으로 되돌리면 DELETE 한 번이고 히어로가 이니셜로 돌아온다 [${scheme}]`, server.writes.at(-1) === "delete" && (await page.locator('[data-testid="profile-avatar"] img').count()) === 0, server.writes.join(","));
    await shoot(page.getByTestId("profile-hero"), "hero-reset", scheme);
  } finally {
    await context.close();
  }
}

// =============================================================================
// 키보드와 낮은 창 (design-review B-1 · H-3). 「키보드로는 닿는데 눈으로는 못 보는 컨트롤」은 늘 Blocker 라서(ADR-0112 D6),
// 창 높이 여섯 가지에서 초점이 가는 모든 칸이 **눈에 보이는지**를 잰다.
//
// 보인다는 것: ① 창 안, ② 스크롤하는 모든 조상 상자의 보이는 영역 안(위에 붙은 미리보기 띠 아래, 아래 가장자리를 녹이는 16px 위),
// ③ 칸의 한가운데를 실제로 그 칸이 받는다(`elementFromPoint`, 띠가 덮으면 걸린다). 숨긴 라디오는 라벨(칩) 전체로 잰다: 눈에 보이는 것은
// 칩이고, 칩의 선택 고리·초점 고리는 칩 밖 4px 까지 그려지므로 그만큼의 여유도 요구한다.
// =============================================================================
const KEYBOARD_VIEWPORTS = [
  { name: "h1000", width: 1280, height: 1000 },
  { name: "h860", width: 1280, height: 860 },
  { name: "h800", width: 1280, height: 800 },
  { name: "h720", width: 1280, height: 720 },
  { name: "h600", width: 1024, height: 600 },
  // 데스크탑 셸의 최소 창(`clients/desktop/src-tauri/tauri.conf.json` 의 minWidth 720 · minHeight 480).
  { name: "min-720x480", width: 720, height: 480 },
];

const focusReport = (page) =>
  page.evaluate(() => {
    const RING = 4; // 칩의 선택 고리·초점 고리가 칩 밖으로 그려지는 두께
    const FADE = 16; // 스크롤 단서가 아래 가장자리를 녹이는 두께
    const active = document.activeElement;
    if (!active || active === document.body) return { ok: false, why: ["no-focus"] };
    const label = active instanceof HTMLInputElement && active.type === "radio" ? active.closest("label") : null;
    const box = label ?? active;
    const r = box.getBoundingClientRect();
    const why = [];
    const named = (node) => node.getAttribute("data-testid") ?? (node.getAttribute("role") ? `role=${node.getAttribute("role")}` : node.className.toString().split(" ")[0]);
    const info = {
      tag: active.tagName.toLowerCase(),
      testid: active.getAttribute("data-testid") ?? active.closest("[data-testid]")?.getAttribute("data-testid") ?? null,
      name: (active.getAttribute("aria-label") ?? label?.textContent ?? active.textContent ?? "").trim().slice(0, 20),
      top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right),
    };
    const ring = label ? RING : 0;
    if (r.top < -0.5 || r.bottom > innerHeight + 0.5 || r.left < -0.5 || r.right > innerWidth + 0.5) why.push("outside-window");
    const sticky = document.querySelector(".avatar-editor-sticky");
    const pinned = !!sticky && getComputedStyle(sticky).position === "sticky";
    for (let node = box.parentElement; node && node !== document.body; node = node.parentElement) {
      if (!/(auto|scroll)/.test(getComputedStyle(node).overflowY)) continue;
      if (node.scrollHeight <= node.clientHeight + 1) continue;
      const nr = node.getBoundingClientRect();
      let top = nr.top + node.clientTop;
      let bottom = top + node.clientHeight;
      const isBody = node.getAttribute("data-testid") === "avatar-editor-body";
      if (isBody && pinned && !sticky.contains(box)) top = Math.max(top, sticky.getBoundingClientRect().bottom);
      if (isBody && node.hasAttribute("data-scrollable")) bottom -= FADE;
      if (r.top - ring < top - 0.5) why.push(`above ${named(node)} by ${Math.round(top - (r.top - ring))}px`);
      if (r.bottom + ring > bottom + 0.5) why.push(`below ${named(node)} by ${Math.round(r.bottom + ring - bottom)}px`);
    }
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!hit || !box.contains(hit)) why.push(`covered by ${hit ? `${hit.tagName.toLowerCase()}.${hit.className.toString().split(" ")[0]}` : "nothing"}`);
    return { ...info, ok: why.length === 0, why };
  });

const describeStop = (stop) => `${stop.testid ?? stop.tag}${stop.name ? ` "${stop.name}"` : ""} [${stop.top},${stop.bottom}] ${stop.why?.join("; ") ?? ""}`;

async function focusAndReport(page, locator) {
  await locator.focus();
  await settle(page);
  return focusReport(page);
}

async function keyWalk(page, key, steps) {
  const stops = [];
  for (let i = 0; i < steps; i += 1) {
    await page.keyboard.press(key);
    await settle(page);
    stops.push(await focusReport(page));
  }
  return stops;
}

async function openEditorFresh(page) {
  await goProfile(page);
  await page.getByTestId("profile-avatar-change").click();
  await dialog(page).waitFor({ timeout: 15_000 });
  await settle(page);
}

async function closeEditor(page) {
  await page.getByTestId("avatar-editor-cancel").click();
  await dialog(page).waitFor({ state: "detached", timeout: 15_000 });
  await settle(page);
}

function checkStops(label, stops, scheme) {
  const bad = stops.filter((stop) => !stop.ok);
  check(`⌨ ${label}: 초점이 간 ${stops.length}곳이 모두 눈에 보인다 [${scheme}]`, stops.length > 0 && bad.length === 0,
    bad.length ? bad.map(describeStop).join(" | ") : stops.map((stop) => stop.testid ?? stop.tag).join(" > "));
}

async function keyboardScenes(browser, origin, scheme) {
  resetServer();
  const { context, page } = await openContext(browser, origin, scheme);
  try {
    for (const viewport of KEYBOARD_VIEWPORTS) {
      const tag = viewport.name;
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await settle(page);
      await openEditorFresh(page);
      await chooseMode(page, "emoji");
      await emojiCell(page, "🚀").waitFor({ timeout: 15_000 });
      await emojiCell(page, "🚀").click();
      await waitDraftPreview(page);
      await settle(page);
      await page.waitForTimeout(200);

      // 구조: 높이 780 초과에서만 띠가 붙고, 지원 최소 창에서도 본문이 컨트롤을 보일 만큼의 높이를 남긴다.
      const layout = await page.evaluate(() => {
        const body = document.querySelector('[data-testid="avatar-editor-body"]');
        const sticky = document.querySelector(".avatar-editor-sticky");
        const panel = document.querySelector('[data-testid="avatar-editor-dialog"]').getBoundingClientRect();
        return {
          pinned: getComputedStyle(sticky).position === "sticky",
          bodyClient: body.clientHeight,
          scrollable: body.hasAttribute("data-scrollable"),
          panelBottom: Math.round(panel.bottom), innerHeight,
        };
      });
      check(`⌨ ${tag}: 미리보기 띠는 높이 780 초과에서만 붙는다 [${scheme}]`, layout.pinned === viewport.height > 780, JSON.stringify(layout));
      check(`⌨ ${tag}: 본문이 컨트롤을 보일 높이를 남긴다(200px 이상) [${scheme}]`, layout.bodyClient >= 200, JSON.stringify(layout));
      check(`⌨ ${tag}: 대화상자가 창 안에 선다 [${scheme}]`, layout.panelBottom <= layout.innerHeight, JSON.stringify(layout));

      const enabledChips = await page.locator('[data-testid^="avatar-color-"][type="radio"]:not([disabled])').evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-testid")));
      const cells = page.locator('[data-testid="avatar-emoji-picker"] [data-emoji-cell]');
      const modeRadio = page.locator('[data-testid^="avatar-editor-mode-"]:checked');
      const sequence = [
        modeRadio,
        page.getByTestId("emoji-search"),
        cells.first(), cells.nth(20), cells.nth(31),
        ...enabledChips.map((id) => page.getByTestId(id)),
        page.getByTestId("avatar-color-input"),
        page.getByTestId("avatar-editor-cancel"),
        page.getByTestId("avatar-editor-save"),
      ];

      // ① 두 엔진 공통: 초점을 위에서 아래로, 다시 아래에서 위로 옮기며 매 정차를 잰다(스크롤이 양방향으로 일어난다).
      const forward = [];
      for (const locator of sequence) forward.push(await focusAndReport(page, locator));
      checkStops(`${tag} 초점을 위에서 아래로`, forward, scheme);
      const backward = [];
      for (const locator of [...sequence].reverse()) backward.push(await focusAndReport(page, locator));
      checkStops(`${tag} 초점을 아래에서 위로`, backward, scheme);

      // ② 방향키: 이모지 격자(내부 스크롤 상자 안)와 배경색 칩 줄. 두 엔진 공통이다.
      await cells.first().focus();
      const gridDown = await keyWalk(page, "ArrowDown", 4);
      const gridUp = await keyWalk(page, "ArrowUp", 4);
      checkStops(`${tag} 이모지 격자 ↓4 ↑4`, [...gridDown, ...gridUp], scheme);
      await page.locator('[data-testid^="avatar-color-"][type="radio"]:checked').focus();
      const chipsRight = await keyWalk(page, "ArrowRight", 6);
      const chipsLeft = await keyWalk(page, "ArrowLeft", 6);
      checkStops(`${tag} 배경색 칩 →6 ←6`, [...chipsRight, ...chipsLeft], scheme);

      // ③ 진짜 Tab·Shift+Tab 은 Chromium 에서만 잰다(WebKit 의 Tab 은 기본 설정에서 단추와 라디오를 건너뛴다: 엔진 기본값).
      if (ENGINE === "chromium") {
        await modeRadio.focus();
        const tabForward = [];
        for (let i = 0; i < 40; i += 1) {
          const [stop] = await keyWalk(page, "Tab", 1);
          tabForward.push(stop);
          if (stop.testid === "avatar-editor-save") break;
        }
        check(`⌨ ${tag} Tab 이 저장 단추까지 닿는다 [${scheme}]`, tabForward.at(-1)?.testid === "avatar-editor-save", tabForward.map((stop) => stop.testid ?? stop.tag).join(" > "));
        checkStops(`${tag} Tab`, tabForward, scheme);
        const tabBackward = [];
        for (let i = 0; i < 40; i += 1) {
          const [stop] = await keyWalk(page, "Shift+Tab", 1);
          tabBackward.push(stop);
          if (stop.testid?.startsWith("avatar-editor-mode-")) break;
        }
        check(`⌨ ${tag} Shift+Tab 이 종류 고르기까지 올라온다 [${scheme}]`, !!tabBackward.at(-1)?.testid?.startsWith("avatar-editor-mode-"), tabBackward.map((stop) => stop.testid ?? stop.tag).join(" > "));
        checkStops(`${tag} Shift+Tab`, tabBackward, scheme);
      }

      // ④ 코메토 탭: 표정 타일은 칩보다 크고(이름표까지 한 라벨) 줄이 접힌다. 타일 여섯과 진한 단 칩을 위·아래로 오가며 잰다.
      await chooseMode(page, "preset");
      await page.getByTestId("avatar-preset-happy").waitFor({ timeout: 15_000 });
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="avatar-preset-picker"] img').length === 6, null, { timeout: 15_000 });
      await settle(page);
      await page.waitForTimeout(150);
      const presetChips = await page.locator('[data-testid^="avatar-color-"][type="radio"]:not([disabled])').evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-testid")));
      const tiles = ["idle", "thinking", "happy", "flustered", "working", "sleepy"].map((id) => page.getByTestId(`avatar-preset-${id}`));
      const presetSequence = [
        page.locator('[data-testid^="avatar-editor-mode-"]:checked'),
        ...tiles,
        ...presetChips.map((id) => page.getByTestId(id)),
        page.getByTestId("avatar-color-input"),
        page.getByTestId("avatar-editor-cancel"),
        page.getByTestId("avatar-editor-save"),
      ];
      const presetForward = [];
      for (const locator of presetSequence) presetForward.push(await focusAndReport(page, locator));
      checkStops(`${tag} 코메토: 초점을 위에서 아래로`, presetForward, scheme);
      const presetBackward = [];
      for (const locator of [...presetSequence].reverse()) presetBackward.push(await focusAndReport(page, locator));
      checkStops(`${tag} 코메토: 초점을 아래에서 위로`, presetBackward, scheme);
      await tiles[0].focus();
      const tilesRight = await keyWalk(page, "ArrowRight", 5);
      const tilesLeft = await keyWalk(page, "ArrowLeft", 5);
      checkStops(`${tag} 코메토 타일 →5 ←5`, [...tilesRight, ...tilesLeft], scheme);
      if (ENGINE === "chromium") {
        await page.locator('[data-testid^="avatar-editor-mode-"]:checked').focus();
        const presetTab = [];
        for (let i = 0; i < 40; i += 1) {
          const [stop] = await keyWalk(page, "Tab", 1);
          presetTab.push(stop);
          if (stop.testid === "avatar-editor-save") break;
        }
        checkStops(`${tag} 코메토 Tab`, presetTab, scheme);
      }
      if (tag === "h720" || tag === "min-720x480") {
        await tiles.at(-1).focus();
        await settle(page);
        await shoot(dialog(page), `kbd-${tag}-preset-last-tile`, scheme);
      }

      // ⑤ 사진 탭: 고르기 단추와 아래 단추 둘.
      await chooseMode(page, "photo");
      await settle(page);
      const photoStops = [];
      for (const locator of [page.locator('[data-testid^="avatar-editor-mode-"]:checked'), page.getByTestId("avatar-photo-pick"), page.getByTestId("avatar-editor-cancel"), page.getByTestId("avatar-editor-save")]) {
        photoStops.push(await focusAndReport(page, locator));
      }
      checkStops(`${tag} 사진`, photoStops, scheme);
      await chooseMode(page, "emoji");
      await settle(page);

      // 증거 캡처: 마지막 색 칩에 초점이 있을 때의 대화상자와(낮은 창에서 가장 깊은 곳), 창 전체.
      if (enabledChips.length > 0) await page.getByTestId(enabledChips.at(-1)).focus();
      await settle(page);
      await shoot(dialog(page), `kbd-${tag}-last-chip`, scheme);
      if (tag === "h720" || tag === "min-720x480") {
        const path = resolve(outDir(), `kbd-${tag}-page-${scheme}.png`);
        await page.screenshot({ path });
        meta.push({ name: `kbd-${tag}-page`, scheme, path });
        await page.getByTestId("avatar-editor-mode-emoji").focus();
        await settle(page);
        await shoot(dialog(page), `kbd-${tag}-first-stop`, scheme);
      }
      await closeEditor(page);
    }
  } finally {
    await context.close();
  }
}

// =============================================================================
// 상태 장면 (design-review 의 증거 레인 보강): 올리는 중 · 오류 · 깨진 사진 · 오프라인 · 되돌리기 확인과 Esc.
// =============================================================================
async function saveEmojiAvatar(page, glyph = "🚀") {
  await openEditorFresh(page);
  await chooseMode(page, "emoji");
  await emojiCell(page, glyph).click();
  await waitDraftPreview(page);
  await pickColor(page, "navy");
  await settle(page);
  await page.getByTestId("avatar-editor-save").click();
  await dialog(page).waitFor({ state: "detached", timeout: 20_000 });
  await page.waitForFunction(() => document.querySelector('[data-testid="profile-avatar"] img'), null, { timeout: 15_000 });
  await settle(page);
}

const activeTestId = (page) => page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.tagName ?? null);

async function statesScenes(browser, origin, scheme) {
  resetServer();
  const { context, page } = await openContext(browser, origin, scheme);
  try {
    await goProfile(page);
    await saveEmojiAvatar(page);

    // ---- 올리는 중: 취소는 native disabled, Esc 도 못 닫는다(H-1) -----------------------------------
    await openEditorFresh(page);
    await chooseMode(page, "emoji");
    await emojiCell(page, "🔥").click();
    await waitDraftPreview(page);
    await pickColor(page, "forest");
    await settle(page);
    holdNextUpload();
    await page.getByTestId("avatar-editor-save").click();
    await page.waitForFunction(() => document.querySelector('[data-testid="avatar-editor-save"]')?.getAttribute("aria-busy") === "true", null, { timeout: 10_000 });
    await page.waitForTimeout(250);
    const cancel = page.getByTestId("avatar-editor-cancel");
    check(`H-1 올리는 동안 취소는 native disabled 다 [${scheme}]`, await cancel.isDisabled(), "");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    check(`H-1 올리는 동안 Esc 도 대화상자를 닫지 못한다 [${scheme}]`, await dialog(page).isVisible(), "");
    await shoot(dialog(page), "busy-uploading", scheme);
    server.release();
    await dialog(page).waitFor({ state: "detached", timeout: 20_000 });
    await settle(page);

    // ---- 오류: 그려 올린 PNG 는 「프로필 사진」이라고 말하지 않는다(M-4) ----------------------------------
    for (const [status, expected, label] of [[500, /아바타를 올리지 못했어요/, "error-500"], [429, /아바타를 너무 자주 바꿨어요/, "error-429"]]) {
      await openEditorFresh(page);
      await chooseMode(page, "emoji");
      await emojiCell(page, "🚀").click();
      await waitDraftPreview(page);
      await pickColor(page, "navy");
      await settle(page);
      server.failUpload = status;
      await page.getByTestId("avatar-editor-save").click();
      await page.getByTestId("avatar-editor-error").waitFor({ timeout: 10_000 });
      const message = (await page.getByTestId("avatar-editor-error").textContent())?.trim() ?? "";
      check(`M-4 서버 ${status} 는 아바타 문장으로 말한다 (「프로필 사진」·한도 숫자가 없다) [${scheme}]`, expected.test(message) && !/프로필 사진|5MB|4096px/.test(message), `"${message}"`);
      check(`M-4 서버 ${status} 뒤에도 대화상자가 열려 있고 취소가 다시 열린다 [${scheme}]`, (await dialog(page).isVisible()) && !(await page.getByTestId("avatar-editor-cancel").isDisabled()), "");
      await shoot(dialog(page), label, scheme);
      server.failUpload = null;
      await closeEditor(page);
    }

    // ---- 깨진 사진(M-3): 이름만 .png 인 바이트는 미리보기도 저장도 열지 않는다 ----------------------------
    await openEditorFresh(page);
    await page.getByTestId("profile-avatar-input").setInputFiles({ name: "fake.png", mimeType: "image/png", buffer: Buffer.from("this is not an image at all, only bytes with a png name") });
    await page.getByTestId("avatar-editor-error").waitFor({ timeout: 10_000 });
    const brokenText = (await page.getByTestId("avatar-editor-error").textContent())?.trim() ?? "";
    const brokenSource = await page.getByTestId("avatar-editor-preview").getAttribute("data-source");
    const brokenSave = await page.getByTestId("avatar-editor-save").getAttribute("aria-disabled");
    check(`M-3 이미지로 열리지 않는 파일은 읽지 못했다고 말하고 저장을 열지 않는다 [${scheme}]`, /읽지 못했어요/.test(brokenText) && brokenSource === "current" && brokenSave === "true", `"${brokenText}" source=${brokenSource} save.aria-disabled=${brokenSave}`);
    await shoot(dialog(page), "photo-broken", scheme);
    await closeEditor(page);

    // ---- 오프라인: 이유가 잠긴 단추 바로 위에 선다(M-1) ------------------------------------------------
    await openEditorFresh(page);
    await chooseMode(page, "emoji");
    await emojiCell(page, "🚀").click();
    await waitDraftPreview(page);
    await settle(page);
    await page.evaluate(() => { window.__forceOffline = true; window.dispatchEvent(new Event("offline")); });
    await page.getByTestId("avatar-editor-offline").waitFor({ timeout: 10_000 });
    await settle(page);
    const offline = await page.evaluate(() => {
      const banner = document.querySelector('[data-testid="avatar-editor-offline"]');
      const body = document.querySelector('[data-testid="avatar-editor-body"]');
      const save = document.querySelector('[data-testid="avatar-editor-save"]');
      const reset = document.querySelector('[data-testid="avatar-editor-reset"]');
      const bannerRect = banner.getBoundingClientRect();
      const saveRect = save.getBoundingClientRect();
      const reasonText = (button) => (button?.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
      return {
        outsideBody: !body.contains(banner),
        aboveButtons: bannerRect.bottom <= saveRect.top,
        sameInset: Math.abs(bannerRect.left - document.querySelector('[data-testid="avatar-editor-dialog"]').getBoundingClientRect().left - 16) <= 1,
        saveLocked: save.getAttribute("aria-disabled") === "true",
        saveReason: reasonText(save),
        resetReason: reasonText(reset),
        visible: bannerRect.top >= 0 && bannerRect.bottom <= innerHeight,
      };
    });
    check(`M-1 오프라인 배너가 스크롤 본문 밖, 잠긴 단추 위에 서서 늘 보인다 [${scheme}]`, offline.outsideBody && offline.aboveButtons && offline.visible, JSON.stringify(offline));
    check(`M-1 배너가 푸터와 같은 안쪽 여백(16px)에 선다 [${scheme}]`, offline.sameInset, JSON.stringify(offline));
    check(`M-1 잠긴 저장·되돌리기가 가리키는 이유 문장이 배너의 그 문장이다 [${scheme}]`, offline.saveLocked && /오프라인|연결이 끊겨/.test(offline.saveReason) && /오프라인|연결이 끊겨/.test(offline.resetReason), JSON.stringify(offline));
    await shoot(dialog(page), "offline-editor", scheme);
    await page.setViewportSize({ width: 1280, height: 720 });
    await settle(page);
    await page.getByTestId("avatar-color-input").scrollIntoViewIfNeeded();
    await settle(page);
    const shortOffline = await page.evaluate(() => {
      const banner = document.querySelector('[data-testid="avatar-editor-offline"]').getBoundingClientRect();
      return banner.top >= 0 && banner.bottom <= innerHeight;
    });
    check(`M-1 낮은 창에서 본문 끝까지 스크롤해도 오프라인 이유가 보인다 [${scheme}]`, shortOffline, "");
    await shoot(dialog(page), "offline-editor-short-scrolled", scheme);
    await page.setViewportSize(VIEWPORT);
    await page.evaluate(() => { window.__forceOffline = false; window.dispatchEvent(new Event("online")); });
    await page.getByTestId("avatar-editor-offline").waitFor({ state: "detached", timeout: 10_000 });
    await closeEditor(page);

    // ---- 되돌리기 확인과 Esc (두 엔진): 첫 Esc 는 질문만, 둘째가 대화상자 ------------------------------------
    await openEditorFresh(page);
    await page.getByTestId("avatar-editor-reset").click();
    await page.getByTestId("avatar-editor-reset-question").waitFor();
    await settle(page);
    const asking = await page.evaluate(() => {
      const save = document.querySelector('[data-testid="avatar-editor-save"]');
      const question = document.querySelector('[data-testid="avatar-editor-reset-question"]').getBoundingClientRect();
      const panel = document.querySelector('[data-testid="avatar-editor-dialog"]').getBoundingClientRect();
      return { saveHidden: save.getBoundingClientRect().width === 0, questionInside: question.left >= panel.left && question.right <= panel.right };
    });
    check(`M-2 확인 질문이 열리면 저장·취소는 숨어 「취소」가 둘이 되지 않는다 [${scheme}]`, asking.saveHidden && asking.questionInside, JSON.stringify(asking));
    await shoot(dialog(page), "reset-confirm", scheme);
    await page.setViewportSize({ width: 390, height: 844 });
    await settle(page);
    const narrow = await page.evaluate(() => {
      const question = document.querySelector('[data-testid="avatar-editor-reset-question"]').getBoundingClientRect();
      const panel = document.querySelector('[data-testid="avatar-editor-dialog"]').getBoundingClientRect();
      return { overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, questionInside: question.left >= panel.left - 0.5 && question.right <= panel.right + 0.5 };
    });
    check(`M-2 390px 에서도 확인 질문이 대화상자 안에 서고 가로로 넘치지 않는다 [${scheme}]`, narrow.overflow <= 0 && narrow.questionInside, JSON.stringify(narrow));
    await shoot(dialog(page), "narrow-390-reset-confirm", scheme);
    await page.setViewportSize(VIEWPORT);
    await settle(page);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    check(`Esc 첫 번째: 질문만 닫히고 대화상자는 남으며 초점은 「기본으로 되돌리기」로 간다 [${scheme}]`,
      (await page.getByTestId("avatar-editor-reset-question").count()) === 0 && (await dialog(page).isVisible()) && (await activeTestId(page)) === "avatar-editor-reset",
      `active=${await activeTestId(page)}`);
    await page.keyboard.press("Escape");
    await dialog(page).waitFor({ state: "detached", timeout: 10_000 });
    await page.waitForTimeout(250);
    check(`Esc 두 번째: 대화상자가 닫히고 초점이 「아바타 바꾸기」 단추로 돌아온다 [${scheme}]`, (await activeTestId(page)) === "profile-avatar-change", `active=${await activeTestId(page)}`);
  } finally {
    await context.close();
  }
}

async function main() {
  const distDir = resolve(WEB_ROOT, DIST);
  if (!existsSync(resolve(distDir, "index.html"))) throw new Error(`${distDir}/index.html 이 없다. 먼저 빌드한다.`);
  mkdirSync(outDir(), { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT", extraArgs: ["--outDir", distDir] });
  const browser = await launcher.launch();
  const wanted = new Set((process.env.SCENES || "main,keyboard,states").split(",").map((name) => name.trim()));
  try {
    for (const scheme of SCHEMES) {
      if (wanted.has("main")) await scenesFor(browser, preview.origin, scheme);
      if (wanted.has("keyboard")) await keyboardScenes(browser, preview.origin, scheme);
      if (wanted.has("states")) await statesScenes(browser, preview.origin, scheme);
    }
  } finally {
    await browser.close();
    await preview.stop?.();
  }
  writeFileSync(resolve(outDir(), "meta.json"), JSON.stringify({ engine: ENGINE, shots: meta, checks: results }, null, 1));
  const failed = results.filter((r) => !r.ok);
  console.log(`CAPTURE ${ENGINE}: ${meta.length} shots, ${results.length - failed.length}/${results.length} checks -> ${outDir()}`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
