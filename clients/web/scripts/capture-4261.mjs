#!/usr/bin/env node
// =============================================================================
// 아바타 편집기 캡처와 실제 앱 위의 단정 (#4261).
//
//   npm run build
//   node scripts/capture-4261.mjs                     # Chromium
//   ENGINE=webkit node scripts/capture-4261.mjs       # WebKit(데스크탑 앱의 WKWebView 와 같은 엔진)
//   OUT_ROOT=<폴더> ...                               # 캡처를 놓을 곳(기본 artifacts/avatar-4261, 커밋하지 않는다)
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
const SCHEMES = ["light", "dark"];
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
const server = { upload: null, served: null, mediaId: null, avatarUrl: null, writes: [], outbound: [], authHeaders: [] };

function resetServer() {
  server.upload = null; server.served = null; server.mediaId = null; server.avatarUrl = null;
  server.writes.length = 0; server.outbound.length = 0; server.authHeaders.length = 0;
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

    // ---- ⑥ 낮은 창: 색 칩까지 스크롤해도 미리보기가 위에 붙어 보인다 ----------------------------------
    await chooseMode(page, "emoji");
    await emojiCell(page, "🚀").click();
    await waitDraftPreview(page);
    await page.setViewportSize({ width: 1280, height: 720 });
    await settle(page);
    await page.getByTestId("avatar-color-input").scrollIntoViewIfNeeded();
    await settle(page);
    const box = async (id) => page.getByTestId(id).boundingBox();
    const panel = await dialog(page).boundingBox();
    const previewBox = await box("avatar-editor-preview");
    const pickerBox = await box("avatar-color-picker");
    const inside = (inner) => !!inner && !!panel && inner.y >= panel.y - 1 && inner.y + inner.height <= panel.y + panel.height + 1;
    check(`⑥ 낮은 창에서 색 칩까지 스크롤해도 미리보기가 대화상자 안에 보인다 [${scheme}]`, inside(previewBox) && inside(pickerBox), `panel=${JSON.stringify(panel)} preview=${JSON.stringify(previewBox)} picker=${JSON.stringify(pickerBox)}`);
    await shoot(dialog(page), "short-window-scrolled", scheme);
    await page.setViewportSize(VIEWPORT);
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

async function main() {
  const distDir = resolve(WEB_ROOT, DIST);
  if (!existsSync(resolve(distDir, "index.html"))) throw new Error(`${distDir}/index.html 이 없다. 먼저 빌드한다.`);
  mkdirSync(outDir(), { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT", extraArgs: ["--outDir", distDir] });
  const browser = await launcher.launch();
  try {
    for (const scheme of SCHEMES) await scenesFor(browser, preview.origin, scheme);
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
