#!/usr/bin/env node
// =============================================================================
// 이미지 미리보기(라이트박스) 다시 디자인의 화면 증거와 측정 (#5190).
//
//   npm run build                                  (또는 vite build --outDir <폴더>)
//   LABEL=before DIST=artifacts/dist-before                   node scripts/capture-5190.mjs
//   LABEL=after  DIST=dist                CHECKS=1             node scripts/capture-5190.mjs
//
// 하는 일은 둘이다.
//   · 캡처: 데스크탑 셸 흉내(신호등 자리에 세 원을 덧그린다) × 라이트·다크 × 720·1440 × 한 장·여러 장·확대, 그리고
//     브라우저(신호등 없음) 두 장. `OUT_ROOT/<LABEL>/*.png`.
//   · 측정(`CHECKS=1`): 같은 장면에서 숫자로 잰다. 머리 요소가 신호등 자리(왼쪽 위 80x40)를 덮지 않고, 머리 줄의 세로 가운데가
//     신호등 원 중심(y=20)에 맞고, 브라우저에서는 그 80px을 비우지 않는다. ←/→·+/-/0·Esc, 초점 가두기와 복귀, 낭독 이름, 복사.
//     키보드로 열기(`ONLY=focus`, #5275): Enter로 열고(입력 방식 표지는 pointer) Tab·Shift+Tab이 밖으로 새지 않는지, 첫 초점 링이
//     서는지(마우스로 열면 안 서는지), 펼치는 동안에도 안 새는지. 엔진은 Chromium과 WebKit(WKWebView의 엔진)이다.
//
// 백엔드 없이 `/v1/**` 고정 응답 + 가짜 소켓(capture-4190과 같은 길). 벽시계·로케일·시간대를 고정한다. 신호등은 진짜가 아니라
// **페이지 위에 덧그린 세 원**이다(캡처 전용, 측정이 끝난 뒤에만 그린다): 네이티브 창 틀은 헤드리스 브라우저에 없다.
// =============================================================================
import { deflateSync, inflateSync } from "node:zlib";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { focusReturnsTo } from "../gates/focus.mjs";

const WEB_ROOT = process.env.WEB_ROOT
  ? resolve(process.env.WEB_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LABEL = process.env.LABEL || "after";
const DIST = process.env.DIST || "dist";
const CHECKS = process.env.CHECKS === "1";
const SHOTS = process.env.SHOTS !== "0";
const OUT_ROOT = process.env.OUT_ROOT ? resolve(process.env.OUT_ROOT) : resolve(WEB_ROOT, "artifacts/lightbox-5190");
const PORT = Number(process.env.CAPTURE_PORT || 5391);
const ENGINES = (process.env.ENGINES || "chromium,webkit").split(",").filter(Boolean);
// `PROBE=1`: 전·후 번들에서 같은 숫자(머리 글자 블록의 자리·가운데, 닫기 단추의 가운데)를 찍기만 한다. 전 번들에는 새 시험 표지가 없어서 측정은 못 돌린다.
const PROBE = process.env.PROBE === "1";

const FIXTURE_NOW = Date.parse("2026-11-02T22:07:00+09:00");
const SCHEMES = ["light", "dark"];
const VIEWPORTS = [
  { name: "720", width: 720, height: 820 },
  { name: "1440", width: 1440, height: 900 },
];

// ---- 고정 자료 ---------------------------------------------------------------
const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const peerId = "00000000-0000-7000-8000-000000000102";
const CH = "00000000-0000-7000-8000-000000000201";
const MULTI_MSG = "0199dddd-0000-7000-8000-000000000011";
const SINGLE_MSG = "0199dddd-0000-7000-8000-000000000014";

const person = (id, kind, displayName, handle, extra = {}) => ({
  id, workspaceId, kind, status: "active", displayName, handle, channelCount: 1,
  channelIds: [CH], capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...extra,
});
const roster = [
  person(memberId, "human", "곽성재", "seongjae", { role: "owner" }),
  person(peerId, "human", "이도현", "dohyun"),
];
const channels = [{ id: CH, workspaceId, kind: "public", name: "간판-시안", muted: false }];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: "ws://lightbox-5190-capture.invalid/connection/websocket",
};

const ATT = {
  a: { id: "0199eeee-0000-7000-8000-0000000000a1", name: "간판-시안-A.png", mime: "image/png", sizeBytes: 482_113 },
  b: { id: "0199eeee-0000-7000-8000-0000000000a2", name: "노을-톤-B.png", mime: "image/png", sizeBytes: 351_902 },
  c: { id: "0199eeee-0000-7000-8000-0000000000a3", name: "build-log.jpg", mime: "image/jpeg", sizeBytes: 218_440 },
  d: { id: "0199eeee-0000-7000-8000-0000000000a4", name: "지난주-화면.png", mime: "image/png", sizeBytes: 301_250 },
};

const AT = (minutesAgo) => FIXTURE_NOW - minutesAgo * 60_000;
const row = (over) => ({
  channelId: CH, hlcCount: 0, type: "text", state: "sent", ...over, hlcTs: over.hlcTs ?? over.createdAtMs,
});
const messages = [
  row({ id: "0199dddd-0000-7000-8000-000000000010", seq: 100, authorMemberId: peerId, createdAtMs: AT(31),
    body: "간판 시안 오늘 중으로 정리해서 올릴게요. 글자 굵기 때문에 두 가지로 나눴어요." }),
  row({ id: MULTI_MSG, seq: 101, authorMemberId: peerId, createdAtMs: AT(24),
    body: "A는 지금 쓰는 안이고, B는 노을 톤으로 바꿔 본 거예요. 마지막은 렌더 로그예요.",
    attachments: [ATT.a, ATT.b, ATT.c] }),
  row({ id: "0199dddd-0000-7000-8000-000000000012", seq: 102, authorMemberId: memberId, createdAtMs: AT(19),
    body: "A가 제일 낫네요. 글자 굵기만 한 단계 줄이면 좋겠어요." }),
  row({ id: "0199dddd-0000-7000-8000-000000000013", seq: 103, authorMemberId: peerId, createdAtMs: AT(14),
    body: "알겠어요. 수정해서 다시 올릴게요. 렌더는 10분쯤 걸려요." }),
  row({ id: SINGLE_MSG, seq: 104, authorMemberId: memberId, createdAtMs: AT(9),
    body: "참고로 지난주 화면도 붙여요. 이때는 간판 폭이 지금보다 좁았어요.", attachments: [ATT.d] }),
  row({ id: "0199dddd-0000-7000-8000-000000000015", seq: 105, authorMemberId: peerId, createdAtMs: AT(4),
    body: "확인했어요. 폭은 그대로 두고 높이만 맞출게요." }),
];

// ---- 그림 바이트 -------------------------------------------------------------
// 밝은 문서·노을·(브라우저가 그리는) 어두운 로그 세 가지다: 머리 글자와 단추가 밝은 사진 위에서도 읽혀야 하므로 밝은 쪽이 꼭 필요하다.
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}
function makePng(width, height, paint) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let at = 0;
  for (let y = 0; y < height; y++) {
    raw[at++] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x / width, y / height, x, y);
      raw[at++] = r; raw[at++] = g; raw[at++] = b;
    }
  }
  const chunk = (type, body) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(typed) >>> 0);
    return Buffer.concat([length, typed, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
/** 밝은 문서(흰 바탕, 회색 줄, 먹색 덩어리). 위쪽 가장자리가 하얘서 흰 글자가 가장 어려운 바닥이다. */
const paintDocument = (u, v) => {
  if (v < 0.09) return [236, 233, 227];
  if (u > 0.08 && u < 0.52 && v > 0.18 && v < 0.62) return [38, 44, 58];
  if (u > 0.58 && u < 0.92 && v > 0.2 && v < 0.62 && Math.floor(v * 60) % 3 !== 2) return [196, 192, 184];
  if (u > 0.08 && u < 0.92 && v > 0.7 && v < 0.9 && Math.floor(v * 80) % 3 === 0) return [205, 201, 193];
  return [250, 248, 244];
};
const paintSunset = (u, v) => {
  const sky = v < 0.7 ? mix([58, 40, 112], [252, 156, 84], v / 0.7) : mix([18, 30, 62], [10, 16, 36], (v - 0.7) / 0.3);
  const dx = (u - 0.5) * 0.75, dy = v - 0.68;
  return Math.hypot(dx, dy) < 0.1 ? [255, 232, 170] : sky;
};
/** 첨부 id → 응답. 셋째 장(`build-log`)은 JPEG이다: 복사의 PNG 변환 갈래(캔버스)를 진짜 브라우저로 재려면 PNG 아닌 그림이 있어야 한다. */
const BYTES_BY_ID = {
  [ATT.a.id]: { mime: "image/png", body: makePng(1600, 1000, paintDocument) },
  [ATT.b.id]: { mime: "image/png", body: makePng(900, 1200, paintSunset) },
  [ATT.c.id]: { mime: "image/jpeg", body: Buffer.alloc(0), width: 1400, height: 800 },
  [ATT.d.id]: { mime: "image/png", body: makePng(1200, 900, paintDocument) },
};
const PNG_BY_ID = BYTES_BY_ID; // 아래 라우트가 읽는 이름

// ---- 가짜 서버·소켓·데스크탑 셸 ----------------------------------------------
const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function installRoutes(context) {
  await context.route("**/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: FIXTURE_NOW + 600_000, ttlSeconds: 60, workspaceId, memberId });
    }
    if (/\/inbox(\/|$)/.test(path)) return json(route, { error: { code: "not_found", message: "not found" } }, 404);
    if (path.endsWith("/agent-runs/progress")) return json(route, { runs: [] });
    if (path.endsWith("/hosted-agent-connections") && method === "GET") return json(route, { connections: [] });
    if (path.endsWith("/allowed-models")) return json(route, { allowedAgentModels: [] });
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/read-state") && method === "GET") {
      return json(route, { read_states: channels.map((c) => ({ channel_id: c.id, last_read_seq: 105, latest_seq: 105, unread_count: 0, mention_count: 0, marked_unread_before_seq: null })) });
    }
    if (path.endsWith("/approvals")) return json(route, { approvals: [] });
    if (path.endsWith("/agent-runs")) return json(route, { runs: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/members/me/sidebar-prefs")) return json(route, { prefs: { version: 1, sections: [], starredChannelIds: [] } });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: [] });
    if (path.endsWith("/work-sessions/shared")) return json(route, { sessions: [], nextCursor: null });
    if (path.endsWith("/work-sessions")) return json(route, { workSessions: [] });
    if (path.endsWith("/reminders")) return json(route, { reminders: [] });
    if (path.endsWith("/replies")) return json(route, { messages: [] });
    if (path.includes("/pins")) return json(route, { pins: [] });
    if (path.endsWith("/reactions")) return json(route, {});
    if (path.endsWith(`/workspaces/${workspaceId}`)) return json(route, { workspace: { id: workspaceId, name: "여명거리" } });
    if (path.endsWith("/content")) {
      const id = Object.keys(PNG_BY_ID).find((key) => path.includes(key));
      if (request.headers().authorization === undefined) return json(route, { error: { message: "unauthorized" } }, 401);
      if (id === undefined) return json(route, { error: { message: "not found" } }, 404);
      return route.fulfill({ status: 200, contentType: PNG_BY_ID[id].mime, headers: { "content-disposition": "attachment" }, body: PNG_BY_ID[id].body });
    }
    if (path.endsWith("/messages")) {
      const url = new URL(request.url());
      if (url.searchParams.has("after") || url.searchParams.has("before")) return json(route, { messages: [] });
      return json(route, { messages });
    }
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
  await page.addInitScript(() => {
    class CaptureSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      constructor(url) {
        this.url = String(url); this.readyState = 0;
        queueMicrotask(() => { this.readyState = 1; this.onopen?.(new Event("open")); });
      }
      send(data) {
        const replies = String(data).trim().split("\n").map((line) => {
          const c = JSON.parse(line);
          if (c.connect) return { id: c.id, connect: { client: "5190-capture", version: "6" } };
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

/** 맥 데스크탑 셸이라고 페이지가 믿게 한다(`IS_TAURI`는 `__TAURI_INTERNALS__`로 선다). 네이티브 호출은 가짜가 받는다. */
async function installDesktopMock(page) {
  await page.addInitScript(() => {
    let n = 0;
    window.__tauriCalls = [];
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
      transformCallback: () => ++n,
      unregisterCallback: () => {},
      convertFileSrc: (path) => path,
      invoke: async (cmd, args) => {
        window.__tauriCalls.push([cmd, args ?? null]);
        if (cmd === "keychain_available") return false;
        if (cmd === "plugin:event|listen") return ++n;
        return null;
      },
    };
    Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
  });
}

async function seed(page, origin) {
  await page.addInitScript(({ server, session }) => {
    try {
      localStorage.setItem("momo.web.server.v1", server);
      localStorage.setItem("momo.web.session.v1", JSON.stringify(session));
    } catch { /* 저장소 없는 캡처 */ }
  }, { server: origin, session: { refreshToken: auth.refreshToken, realtimeWebSocketUrl: auth.realtimeWebSocketUrl, member: auth.member } });
}

// ---- 장면 도우미 -------------------------------------------------------------
const errors = [];
async function open(browser, origin, scheme, viewport, { desktop, clipboard = false, contrast, motion = "reduce" }) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: scheme,
    reducedMotion: motion,
    serviceWorkers: "block",
    deviceScaleFactor: 1,
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    ...(contrast ? { contrast } : {}),
  });
  // 클립보드 권한은 Chromium만 준다(WebKit은 권한 이름을 모른다). 복사 측정만 켠다.
  if (clipboard) await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  await installRoutes(context);
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  await installPageFixtures(page);
  if (desktop) await installDesktopMock(page);
  await seed(page, origin);
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.evaluate((id) => { location.hash = `#/c/${id}`; }, CH);
  await page.getByTestId("composer-input").waitFor({ timeout: 20_000 });
  await page.locator(`[data-testid="timeline-message"][data-message-id="${MULTI_MSG}"]`).waitFor({ timeout: 20_000 });
  await page.waitForTimeout(500);
  return { context, page };
}

function opener(page, messageId, index = 0) {
  return page
    .locator(`[data-testid="timeline-message"][data-message-id="${messageId}"] [data-testid="attachment-image"] button`)
    .nth(index);
}

async function openLightbox(page, messageId, index = 0) {
  const button = opener(page, messageId, index);
  await button.scrollIntoViewIfNeeded();
  await button.waitFor({ timeout: 15_000 });
  await button.click();
  await page.getByTestId("image-lightbox-ready").waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => document.querySelector('[data-testid="image-lightbox"]')?.dataset.stagePhase === "open", null, { timeout: 15_000 });
  await page.waitForFunction(() => {
    const photo = document.querySelector(".lightbox-photo");
    return photo instanceof HTMLImageElement && photo.complete && photo.naturalWidth > 0;
  }, null, { timeout: 15_000 });
  await page.waitForTimeout(250);
  return button;
}

async function closeLightbox(page) {
  await page.keyboard.press("Escape");
  await page.getByTestId("image-lightbox").waitFor({ state: "detached", timeout: 10_000 });
}

/** 캡처 전용: 신호등 자리에 세 원을 덧그린다(데스크탑 셸의 `trafficLightPosition` x16, 원 지름 12, 간격 8, 중심 y=20). */
async function drawTrafficLights(page) {
  await page.evaluate(() => {
    const box = document.createElement("div");
    box.setAttribute("data-capture-traffic-lights", "");
    box.style.cssText = "position:fixed;left:16px;top:14px;display:flex;gap:8px;z-index:2147483647;pointer-events:none";
    for (const color of ["#ff5f57", "#febc2e", "#28c840"]) {
      const dot = document.createElement("span");
      dot.style.cssText = `width:12px;height:12px;border-radius:50%;background:${color}`;
      box.appendChild(dot);
    }
    document.body.appendChild(box);
  });
}
async function eraseTrafficLights(page) {
  await page.evaluate(() => document.querySelector("[data-capture-traffic-lights]")?.remove());
}

const outDir = () => resolve(OUT_ROOT, LABEL);
const written = [];
async function shoot(page, name, { clip } = {}) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
  const path = resolve(outDir(), `${name}.png`);
  await page.screenshot({ path, animations: "disabled", caret: "hide", ...(clip ? { clip } : {}) });
  written.push(path);
}

// ---- 캡처 -------------------------------------------------------------------
async function captureScenes(browserType, origin) {
  const browser = await browserType.launch();
  try {
    for (const scheme of SCHEMES) {
      for (const viewport of VIEWPORTS) {
        const { context, page } = await open(browser, origin, scheme, viewport, { desktop: true });
        try {
          const tag = `${scheme}-${viewport.name}`;
          await openLightbox(page, SINGLE_MSG);
          await drawTrafficLights(page);
          await shoot(page, `desktop-single-${tag}`);
          await eraseTrafficLights(page);
          await closeLightbox(page);

          await openLightbox(page, MULTI_MSG);
          await drawTrafficLights(page);
          await shoot(page, `desktop-multi-${tag}`);
          await eraseTrafficLights(page);

          // 확대: 두 번 클릭은 맞춤 ↔ 실제 크기다(이 판 이전부터 있는 길이라 전·후가 같은 손으로 잰다).
          await page.locator(".lightbox-photo").dblclick();
          await page.waitForFunction(() => document.querySelector(".lightbox-photo")?.hasAttribute("data-zoomed"));
          await page.waitForTimeout(250);
          await drawTrafficLights(page);
          await shoot(page, `desktop-zoom-${tag}`);
          await eraseTrafficLights(page);
          await closeLightbox(page);
        } finally {
          await context.close();
        }
      }
    }
    // 키보드로 열어 초점 고리를 본다(마우스로 열면 :focus-visible이 고리를 그리지 않는다). 닫기(처음 초점) → Shift+Tab으로 복사 → Tab 두 번으로 이전 단추.
    // 라이트·다크 둘 다: 첫 장면(`desktop-focus-first-*`)은 키보드로 연 직후 화면 전체이고, 닫기 둘레의 링은 잘라 둔 사진(`desktop-focus-close-*`)에서 본다(#5275).
    for (const scheme of SCHEMES) {
      const { context, page } = await open(browser, origin, scheme, VIEWPORTS[1], { desktop: true });
      try {
        const trigger = opener(page, MULTI_MSG);
        await trigger.scrollIntoViewIfNeeded();
        await trigger.focus();
        await page.keyboard.press("Enter");
        await page.getByTestId("image-lightbox-ready").waitFor({ timeout: 15_000 });
        await page.waitForFunction(() => document.querySelector('[data-testid="image-lightbox"]')?.dataset.stagePhase === "open", null, { timeout: 15_000 });
        await page.waitForTimeout(250);
        await drawTrafficLights(page);
        await shoot(page, `desktop-focus-first-${scheme}-1440`);
        await shoot(page, `desktop-focus-close-${scheme}-1440`, { clip: { x: 1100, y: 0, width: 340, height: 60 } });
        await page.keyboard.press("Shift+Tab");
        await shoot(page, `desktop-focus-copy-${scheme}-1440`, { clip: { x: 1100, y: 0, width: 340, height: 60 } });
        await page.keyboard.press("Tab");
        await page.keyboard.press("Tab");
        await shoot(page, `desktop-focus-prev-${scheme}-1440`, { clip: { x: 0, y: 410, width: 100, height: 80 } });
        await eraseTrafficLights(page);
        await closeLightbox(page);
      } finally {
        await context.close();
      }
    }
    // 고대비(유리를 끈 길): 같은 `glass` 유틸이 불투명한 면으로 돌아가고 무대도 불투명한 어두운 면이 된다.
    {
      const { context, page } = await open(browser, origin, "light", VIEWPORTS[1], { desktop: true, contrast: "more" });
      try {
        await openLightbox(page, MULTI_MSG);
        await drawTrafficLights(page);
        await shoot(page, "desktop-multi-light-1440-contrast-more");
        await eraseTrafficLights(page);
        await closeLightbox(page);
      } finally {
        await context.close();
      }
    }
    // 폰 폭의 웹(터치 타깃 44px, 확대 묶음이 빠진다).
    {
      const { context, page } = await open(browser, origin, "light", { name: "390", width: 390, height: 844 }, { desktop: false });
      try {
        await openLightbox(page, MULTI_MSG);
        await shoot(page, "browser-multi-light-390");
        await closeLightbox(page);
      } finally {
        await context.close();
      }
    }
    // 브라우저(신호등·셸 없음): 머리가 왼쪽 가장자리에서 시작해야 한다.
    for (const [scheme, viewport] of [["light", VIEWPORTS[1]], ["dark", VIEWPORTS[0]]]) {
      const { context, page } = await open(browser, origin, scheme, viewport, { desktop: false });
      try {
        await openLightbox(page, MULTI_MSG);
        await shoot(page, `browser-multi-${scheme}-${viewport.name}`);
        await closeLightbox(page);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
}


// ---- 측정 -------------------------------------------------------------------
// 숫자로 잰다. 한 칸이 틀려도 멈추지 않고 모아서 마지막에 한 번에 말한다(사보타주 때 어느 칸이 빨개지는지 보려고).
const failures = [];
const passes = [];
function check(engine, name, ok, detail = "") {
  (ok ? passes : failures).push(`${engine}: ${name}${detail ? ` (${detail})` : ""}`);
}

const ZONE = { left: 0, top: 0, right: 80, bottom: 40 }; // 신호등 자리(왼쪽 위 80x40)
const BAND_CENTER_Y = 20; // 신호등 원 중심 = 상단 줄(높이 40)의 세로 가운데
const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

async function rectOf(page, selector) {
  return page.locator(selector).first().evaluate((node) => {
    const r = node.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  });
}

/** PNG(8비트 RGB·RGBA, 비인터레이스)를 푼다. 스크린샷 clip 전용이라 이 모양만 안다. 진짜 렌더된 픽셀을 재려는 것이라 캔버스 흉내를 쓰지 않는다. */
function decodePng(png) {
  let at = 8, width = 0, height = 0, colorType = 0;
  const idat = [];
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const type = png.toString("ascii", at + 4, at + 8);
    const body = png.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") { width = body.readUInt32BE(0); height = body.readUInt32BE(4); colorType = body[9]; }
    if (type === "IDAT") idat.push(body);
    at += 12 + length;
  }
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const data = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? data[y * stride + x - channels] : 0;
      const up = y > 0 ? data[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? data[(y - 1) * stride + x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const guess = left + up - upLeft;
        const dl = Math.abs(guess - left), du = Math.abs(guess - up), dul = Math.abs(guess - upLeft);
        value += dl <= du && dl <= dul ? left : du <= dul ? up : upLeft;
      }
      data[y * stride + x] = value & 255;
    }
  }
  return { width, height, channels, data };
}
async function pixelAt(page, x, y) {
  const png = await page.screenshot({ clip: { x, y, width: 1, height: 1 }, animations: "disabled", caret: "hide" });
  const { data } = decodePng(png);
  return [data[0], data[1], data[2]];
}
const srgbLuminance = ([r, g, b]) => {
  const lin = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const contrastOf = (a, b) => {
  const [hi, lo] = [srgbLuminance(a), srgbLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const INK_DARK = [241, 241, 243]; // tokens.css 다크 `--ink`(#f1f1f3). 어두운 범위의 글자색이다.

/** 사각형 안에서 가장 밝은 픽셀의 휘도. 글자가 판에 가려 어두워졌는지(글자 획의 가장 밝은 점이 ink에 못 미치는지) 본다. */
async function brightestIn(page, rect) {
  const clip = { x: Math.floor(rect.left), y: Math.floor(rect.top), width: Math.ceil(rect.width) + 1, height: Math.ceil(rect.height) + 1 };
  const { width, height, channels, data } = decodePng(await page.screenshot({ clip, animations: "disabled", caret: "hide" }));
  let best = 0;
  for (let i = 0; i < width * height; i += 1) best = Math.max(best, srgbLuminance([data[i * channels], data[i * channels + 1], data[i * channels + 2]]));
  return best;
}

/** 머리 줄의 신호등 자리·세로 가운데·충돌. 데스크탑 셸 흉내에서만 부른다. */
async function headerChecks(page, engine, tag) {
  const header = await rectOf(page, '[data-testid="image-lightbox-header"]');
  const info = await rectOf(page, '[data-testid="image-lightbox-info"]');
  const close = await rectOf(page, '[data-testid="image-lightbox-close"]');
  const download = await rectOf(page, '[data-testid="image-lightbox"] [data-testid="attachment-download"]');
  const leaves = await page.locator('[data-testid="image-lightbox-header"] button, [data-testid="image-lightbox-info"]').evaluateAll((nodes) =>
    nodes.map((node) => {
      const r = node.getBoundingClientRect();
      return { id: node.getAttribute("data-testid") ?? node.tagName, left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    })
  );
  const hit = leaves.filter((leaf) => overlaps(leaf, ZONE)).map((leaf) => leaf.id);
  check(engine, `${tag} 머리 요소가 신호등 자리(80x40)를 덮지 않는다`, hit.length === 0, hit.length ? `덮는 것: ${hit.join(",")}` : `info.left=${info.left.toFixed(1)}`);
  check(engine, `${tag} 머리 글자 왼쪽이 신호등 원 오른쪽 끝(68)에서 12px 이상 떨어져 있다`, info.left >= 80, `info.left=${info.left.toFixed(1)}`);
  check(engine, `${tag} 머리 줄 높이가 상단 줄 40px과 같다`, Math.abs(header.height - 40) < 0.5, `height=${header.height.toFixed(1)}`);
  // 글자 블록은 줄(40) 안에 든다: 긴 이름은 접히지 않고 말줄임이어야 한다(접히면 블록이 줄 위아래로 넘친다, 가운데 y는 그대로라 아래 줄만으론 못 잡는다).
  check(engine, `${tag} 글자 블록이 40px 줄 안에 들고 접히지 않는다`, info.top >= 0 && info.bottom <= header.height + 0.5, `top=${info.top.toFixed(1)} bottom=${info.bottom.toFixed(1)}`);
  const infoCenter = (info.top + info.bottom) / 2;
  check(engine, `${tag} 머리 글자 블록의 세로 가운데가 신호등 중심선(y 20)이다`, Math.abs(infoCenter - BAND_CENTER_Y) <= 1.5, `center=${infoCenter.toFixed(1)}`);
  const closeCenter = (close.top + close.bottom) / 2;
  const downloadCenter = (download.top + download.bottom) / 2;
  check(engine, `${tag} 오른쪽 단추 줄의 세로 가운데도 y 20이다`, Math.abs(closeCenter - BAND_CENTER_Y) <= 1.5 && Math.abs(downloadCenter - BAND_CENTER_Y) <= 1.5, `close=${closeCenter.toFixed(1)} download=${downloadCenter.toFixed(1)}`);
  check(engine, `${tag} 글자 블록과 오른쪽 단추 줄 사이에 8px 이상 있다`, info.right <= download.left - 8, `gap=${(download.left - info.right).toFixed(1)}`);
}

async function geometryChecks(browserType, engine, origin) {
  const browser = await browserType.launch();
  try {
    // 데스크탑 셸 흉내: 라이트·다크 × 720·900·1440.
    for (const scheme of SCHEMES) {
      for (const width of [720, 900, 1440]) {
        const { context, page } = await open(browser, origin, scheme, { name: String(width), width, height: 820 }, { desktop: true });
        try {
          const tag = `[셸 ${scheme} ${width}]`;
          await openLightbox(page, MULTI_MSG);
          await headerChecks(page, engine, tag);
          if (width === 720 && scheme === "light") {
            // 아주 긴 이름: 말줄임으로 접히고 단추 줄·신호등 자리를 밀어내지 않는다.
            await page.locator('[data-testid="image-lightbox-info"] span').first().evaluate((node) => {
              node.textContent = "아주아주 긴 보낸 사람 이름 ".repeat(8);
            });
            await headerChecks(page, engine, `${tag} 긴 이름`);
            // 전체 화면: 신호등이 사라져 80px이 죽은 공간이므로 접힌다(표지는 셸이 루트에 찍는다).
            await page.evaluate(() => document.documentElement.setAttribute("data-window-fullscreen", ""));
            const info = await rectOf(page, '[data-testid="image-lightbox-info"]');
            check(engine, `${tag} 전체 화면에서는 인셋이 접혀 글자가 12px 에서 시작한다`, info.left <= 16, `info.left=${info.left.toFixed(1)}`);
          }
          await closeLightbox(page);
        } finally {
          await context.close();
        }
      }
    }
    // 움직임을 켠 채로 열기: 사진이 썸네일에서 날아와 자리를 잡는다(hero). 끝난 뒤에 머리·아래 줄이 서 있고 같은 자리에 선다.
    {
      const { context, page } = await open(browser, origin, "dark", VIEWPORTS[1], { desktop: true, motion: "no-preference" });
      try {
        await openLightbox(page, MULTI_MSG);
        await page.waitForFunction(() => document.querySelectorAll(".stage-hero").length === 0, null, { timeout: 10_000 });
        await headerChecks(page, engine, "[셸 다크 1440 움직임 켬]");
        const hidden = await page.evaluate(() => [...document.querySelectorAll(".lightbox-chrome, .lightbox-foot")].filter((node) => getComputedStyle(node).visibility === "hidden").length);
        check(engine, "[셸 다크 1440 움직임 켬] 열림이 끝나면 머리·아래 줄이 보인다", hidden === 0, `hidden=${hidden}`);
        await closeLightbox(page);
      } finally {
        await context.close();
      }
    }
    // 브라우저(셸 아님): 신호등이 없으니 80px을 비우지 않는다.
    for (const width of [720, 1440]) {
      const { context, page } = await open(browser, origin, "light", { name: String(width), width, height: 820 }, { desktop: false });
      try {
        await openLightbox(page, MULTI_MSG);
        const info = await rectOf(page, '[data-testid="image-lightbox-info"]');
        check(engine, `[브라우저 ${width}] 머리 글자가 왼쪽 가장자리 가까이(12px)에서 시작한다`, info.left <= 16, `info.left=${info.left.toFixed(1)}`);
        await closeLightbox(page);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
}

/** 렌더된 픽셀로 재는 두 가지: 라이트 앱에서도 조작이 어둡다, 확대해 흰 사진이 머리 뒤로 와도 글자가 읽힌다. */
async function pixelChecks(browserType, engine, origin) {
  const browser = await browserType.launch();
  try {
    for (const scheme of SCHEMES) {
      const { context, page } = await open(browser, origin, scheme, { name: "1440", width: 1440, height: 900 }, { desktop: true });
      try {
        await openLightbox(page, SINGLE_MSG); // 한 장: 밝은 문서 사진
        const tag = `[픽셀 ${scheme}]`;
        // ① 맞춤: 머리 글자 바로 옆 무대(글자 없는 자리)와 흰 글자의 대비.
        const stage = await pixelAt(page, 300, 20);
        check(engine, `${tag} 맞춤에서 머리 글자 뒤 무대와 글자(다크 ink)의 대비가 4.5 이상이다`, contrastOf(INK_DARK, stage) >= 4.5, `stage=${stage} contrast=${contrastOf(INK_DARK, stage).toFixed(2)}`);
        // ② 조작 면이 스킴과 무관하게 어둡다: 한 장일 때 캡슐은 가운데 아래에 있다. 캡슐 안쪽 왼쪽 가장자리(− 단추 왼쪽 여백)를 잰다.
        const capsule = await rectOf(page, '[data-testid="image-lightbox-controls"]');
        const glass = await pixelAt(page, Math.round(capsule.left + 3), Math.round((capsule.top + capsule.bottom) / 2));
        check(engine, `${tag} 아래 캡슐의 유리가 어둡다(휘도 0.12 이하, 라이트 앱에서도)`, srgbLuminance(glass) <= 0.12, `glass=${glass} L=${srgbLuminance(glass).toFixed(3)}`);
        // ③ 확대: 흰 문서가 머리 줄 뒤로 들어오면 판이 깔려 글자가 읽혀야 한다.
        await page.locator(".lightbox-photo").dblclick();
        await page.waitForFunction(() => document.querySelector(".lightbox-photo")?.hasAttribute("data-zoomed"));
        await page.waitForTimeout(250);
        const behind = await pixelAt(page, 400, 12);
        check(engine, `${tag} 확대해 흰 사진이 머리 뒤로 와도 글자 뒤 픽셀과 글자의 대비가 4.5 이상이다`, contrastOf(INK_DARK, behind) >= 4.5, `behind=${behind} contrast=${contrastOf(INK_DARK, behind).toFixed(2)}`);
        // 판은 글자 **뒤**에 서야 한다(앞에 그려지면 글자가 판 색으로 눌려 어두워진다). 글자 획의 가장 밝은 점이 ink에 가까워야 한다.
        const nameRect = await rectOf(page, '[data-testid="image-lightbox-info"] span');
        const readoutRect = await rectOf(page, '[data-testid="image-lightbox-zoom"]');
        const nameBrightest = await brightestIn(page, nameRect);
        const readoutBrightest = await brightestIn(page, readoutRect);
        check(engine, `${tag} 확대해도 머리 글자가 판에 눌리지 않는다(가장 밝은 획의 휘도 0.6 이상)`, nameBrightest >= 0.6, `L=${nameBrightest.toFixed(3)}`);
        check(engine, `${tag} 확대해도 아래 캡슐 글자가 판에 눌리지 않는다(휘도 0.6 이상)`, readoutBrightest >= 0.6, `L=${readoutBrightest.toFixed(3)}`);
        await closeLightbox(page);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
}

/** 폰 폭의 웹: 앱 바닥이 거의 순백(사이드바 띠가 없다)이라 무대가 가장 밝게 나오는 자리에서도 머리 글자가 읽혀야 한다. */
async function narrowChecks(browserType, engine, origin) {
  const browser = await browserType.launch();
  try {
    for (const scheme of SCHEMES) {
      const { context, page } = await open(browser, origin, scheme, { name: "390", width: 390, height: 844 }, { desktop: false });
      try {
        await openLightbox(page, MULTI_MSG);
        const tag = `[폰 폭 ${scheme}]`;
        const header = await rectOf(page, '[data-testid="image-lightbox-header"]');
        const stage = await pixelAt(page, 200, 12);
        check(engine, `${tag} 머리 글자 뒤 무대와 글자(다크 ink)의 대비가 4.5 이상이다`, contrastOf(INK_DARK, stage) >= 4.5, `stage=${stage} contrast=${contrastOf(INK_DARK, stage).toFixed(2)}`);
        const zoomGroup = await page.locator(".lightbox-zoom-group").first().evaluate((node) => getComputedStyle(node).display);
        check(engine, `${tag} 확대 묶음이 빠진다(핀치·두 번 탭이 그 길)`, zoomGroup === "none", `display=${zoomGroup}`);
        const info = await rectOf(page, '[data-testid="image-lightbox-info"]');
        const download = await rectOf(page, '[data-testid="image-lightbox"] [data-testid="attachment-download"]');
        check(engine, `${tag} 글자 블록과 오른쪽 단추 줄이 겹치지 않고 줄 높이는 40이다`, info.right <= download.left - 8 && Math.abs(header.height - 40) < 0.5, `gap=${(download.left - info.right).toFixed(1)} h=${header.height}`);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
        check(engine, `${tag} 가로로 넘치지 않는다`, overflow === false);
        await closeLightbox(page);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
}

/** 키보드·초점·낭독. 브라우저 모드, 라이트 1440. */
async function keyboardChecks(browserType, engine, origin) {
  const browser = await browserType.launch();
  try {
    const { context, page } = await open(browser, origin, "light", VIEWPORTS[1], { desktop: false });
    try {
      const trigger = await openLightbox(page, MULTI_MSG);
      const active = () => page.evaluate(() => {
        const el = document.activeElement;
        const box = document.querySelector('[data-testid="image-lightbox"]');
        return { id: el?.getAttribute?.("data-testid") ?? el?.tagName ?? null, inside: !!(box && el && box.contains(el)) };
      });
      const position = () => page.getByTestId("image-lightbox-position").textContent();
      const readout = () => page.getByTestId("image-lightbox-zoom").textContent();
      const zoomed = () => page.evaluate(() => document.querySelector(".lightbox-photo")?.hasAttribute("data-zoomed") === true);
      const settle = () => page.waitForTimeout(120);

      // 초점: 열면 닫기에 선다.
      check(engine, "[키보드] 열면 초점이 닫기 단추에 선다", (await active()).id === "image-lightbox-close", JSON.stringify(await active()));

      // 낭독 이름.
      const dialogs = await page.getByRole("dialog", { name: ATT.a.name }).count();
      check(engine, "[낭독] 대화상자의 이름이 파일 이름이다", dialogs === 1, `count=${dialogs}`);
      const alt = await page.locator(".lightbox-photo").getAttribute("alt");
      check(engine, "[낭독] 사진의 대체 글이 파일 이름이다", alt === ATT.a.name, `alt=${alt}`);
      const nameless = await page.locator('[data-testid="image-lightbox"] button').evaluateAll((nodes) =>
        nodes.filter((node) => !((node.getAttribute("aria-label") ?? node.textContent ?? "").trim())).map((node) => node.getAttribute("data-testid") ?? "?")
      );
      check(engine, "[낭독] 모든 단추에 이름이 있다", nameless.length === 0, nameless.join(","));
      const live = await page.getByTestId("image-lightbox-position").getAttribute("aria-live");
      const status = await page.getByTestId("image-lightbox-zoom").getAttribute("role");
      check(engine, "[낭독] 장 번호는 polite 알림이고 배율은 status다", live === "polite" && status === "status", `live=${live} role=${status}`);

      // ←/→ 넘기기(순환).
      check(engine, "[키보드] 시작은 3장 중 1번", (await position()) === "3장 중 1번", String(await position()));
      await page.keyboard.press("ArrowRight"); await settle();
      const afterRight = await position();
      const selected = await page.locator('[data-testid="image-lightbox-thumb"]').evaluateAll((nodes) => nodes.findIndex((node) => node.getAttribute("aria-current") === "true"));
      check(engine, "[키보드] → 가 다음 장(3장 중 2번)으로 가고 썸네일 표시가 따라간다", afterRight === "3장 중 2번" && selected === 1, `${afterRight} / thumb ${selected}`);
      await page.keyboard.press("ArrowLeft"); await settle();
      await page.keyboard.press("ArrowLeft"); await settle();
      check(engine, "[키보드] ← 가 이전 장으로 가고 처음에서 마지막(3장 중 3번)으로 순환한다", (await position()) === "3장 중 3번", String(await position()));
      await page.keyboard.press("ArrowRight"); await settle();

      // + − 0 (수식 키 없이).
      await page.keyboard.press("Equal"); await settle();
      const grown = { label: await readout(), zoomed: await zoomed() };
      check(engine, "[키보드] + 가 확대한다(배율 글자가 「맞춤」을 떠난다)", grown.zoomed && grown.label !== "맞춤", JSON.stringify(grown));
      const before = await position();
      await page.keyboard.press("ArrowRight"); await settle();
      check(engine, "[키보드] 확대 중 → 는 넘기지 않고 사진을 옮긴다", (await position()) === before);
      await page.keyboard.press("Minus"); await settle();
      check(engine, "[키보드] − 가 맞춤까지 줄인다", (await readout()) === "맞춤" && !(await zoomed()), String(await readout()));
      await page.keyboard.press("Shift+Equal"); await settle();
      await page.keyboard.press("Shift+Equal"); await settle();
      await page.keyboard.press("Digit0"); await settle();
      check(engine, "[키보드] 0 이 맞춤으로 되돌린다", (await readout()) === "맞춤" && !(await zoomed()), String(await readout()));

      // 캡슐 단추.
      await page.getByTestId("image-lightbox-zoom-in").click(); await settle();
      check(engine, "[포인터] 캡슐의 + 가 확대한다", (await zoomed()) === true);
      await page.getByTestId("image-lightbox-zoom-out").click(); await settle();
      check(engine, "[포인터] 캡슐의 − 가 맞춤으로 돌린다", (await zoomed()) === false);
      await page.getByTestId("image-lightbox-next").click(); await settle();
      check(engine, "[포인터] 다음 단추가 다음 장으로 간다", (await position()) !== before);

      // 초점 가두기: Tab/Shift+Tab을 여러 번 눌러도 대화상자 밖으로 나가지 않는다.
      const visited = new Set();
      let escaped = 0;
      for (let turn = 0; turn < 40; turn += 1) {
        await page.keyboard.press(turn % 5 === 4 ? "Shift+Tab" : "Tab");
        const state = await active();
        if (!state.inside) escaped += 1;
        visited.add(state.id);
      }
      check(engine, "[초점] Tab·Shift+Tab 40번 동안 초점이 대화상자 밖으로 나가지 않는다", escaped === 0, `escaped=${escaped} visited=${[...visited].join(",")}`);
      if (engine === "chromium") {
        const must = ["image-lightbox-close", "image-lightbox-previous", "image-lightbox-next", "image-lightbox-zoom-in", "image-lightbox-thumb"];
        const missing = must.filter((id) => !visited.has(id));
        check(engine, "[초점] 한 바퀴에 닫기·이전·다음·확대·썸네일이 모두 걸린다", missing.length === 0, `missing=${missing.join(",")}`);
      }

      // Esc: 닫히고 초점이 여는 단추로 돌아온다(확대 중이어도).
      await page.keyboard.press("Equal"); await settle();
      await page.keyboard.press("Escape");
      await page.getByTestId("image-lightbox").waitFor({ state: "detached", timeout: 10_000 });
      // 복귀는 닫힘 전환이 끝난 뒤 프레임에 일어난다(gates/focus.mjs, #5048): 한 번만 재면 경주다.
      const back = await focusReturnsTo(trigger);
      check(engine, "[초점] Esc로 닫으면 초점이 여는 단추로 돌아온다(확대 중이어도)", back === true);
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

/**
 * 키보드로 열기 (#5275): 초점 가두기(B1)와 첫 초점의 링(H1). 마우스로 여는 길과 다르다: 열기 단추가 Enter로 눌리고, 그때 입력 방식 표지
 * (`data-focus-modality`)는 아직 pointer다(Enter·Space는 표지를 올리지 않는다). 수리 전에는 ① 움직임 줄이기로 열면 `interactive`가
 * Radix FocusScope보다 먼저 닫기를 잡아 「마지막 초점」 기억이 비었고, WebKit(단추를 건너뛰는 탭 순서)의 Shift+Tab 한 번이 무대 뒤 입력창으로
 * 샜으며, ② 두 엔진 모두 첫 초점 「닫기」에 링이 없었다. 여기서는 Tab 없이 `focus()` + Enter로 열어 표지를 pointer로 둔다(실제로 틀린 길).
 */
async function keyboardOpenChecks(browserType, engine, origin) {
  const browser = await browserType.launch();
  try {
    const state = (page) => page.evaluate(() => {
      const el = document.activeElement;
      const box = document.querySelector('[data-testid="image-lightbox"]');
      const style = el ? getComputedStyle(el) : null;
      return {
        id: el?.getAttribute?.("data-testid") ?? el?.tagName ?? null,
        inside: !!(box && el && box.contains(el)),
        ring: style ? `${style.outlineStyle} ${style.outlineWidth}` : null,
        // 계산된 outline이 실제로 그려지는 모양인가(style none이면 폭 값이 남아 있어도 안 그려진다).
        ringShown: style ? style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2 : false,
        modality: document.documentElement.getAttribute("data-focus-modality"),
        phase: box?.getAttribute("data-stage-phase") ?? null,
      };
    });
    const openByKeyboard = async (page) => {
      const trigger = opener(page, MULTI_MSG);
      await trigger.scrollIntoViewIfNeeded();
      await trigger.focus();
      const stamp = (await state(page)).modality;
      await page.keyboard.press("Enter");
      return { trigger, stamp };
    };
    const settledOpen = async (page) => {
      await page.getByTestId("image-lightbox-ready").waitFor({ timeout: 15_000 });
      await page.waitForFunction(() => document.querySelector('[data-testid="image-lightbox"]')?.dataset.stagePhase === "open", null, { timeout: 15_000 });
      await page.waitForTimeout(250);
    };
    // 한 번에 한 방향을 길게 누르는 것이 아니라 섞어 누른다. 첫 두 번이 Shift+Tab인 것이 중요하다: 수리 전 WebKit은 거기서 새어 나갔다.
    const KEYS = ["Shift+Tab", "Shift+Tab", "Tab", "Tab", "Tab", "Shift+Tab", "Tab", "Tab", "Tab", "Tab", "Tab", "Shift+Tab", "Tab", "Tab"];

    for (const motion of ["reduce", "no-preference"]) {
      const tag = `[키보드로 열기·${motion === "reduce" ? "움직임 줄임" : "움직임 켬"}]`;
      const { context, page } = await open(browser, origin, "light", VIEWPORTS[1], { desktop: false, motion });
      try {
        const { trigger, stamp } = await openByKeyboard(page);
        check(engine, `${tag} 시험이 실제로 틀린 길에서 시작한다(입력 방식 표지가 아직 pointer)`, stamp === "pointer", String(stamp));
        await settledOpen(page);
        const first = await state(page);
        check(engine, `${tag} 열면 초점이 닫기 단추에 선다`, first.id === "image-lightbox-close" && first.inside, JSON.stringify(first));
        check(engine, `${tag} 첫 초점 「닫기」에 초점 링이 보인다(계산된 outline)`, first.ringShown === true, JSON.stringify(first));
        let escaped = 0;
        const visited = [];
        for (const key of KEYS) {
          await page.keyboard.press(key);
          await page.waitForTimeout(40);
          const now = await state(page);
          if (!now.inside) escaped += 1;
          visited.push(`${key}:${now.id}${now.inside ? "" : "(밖)"}`);
        }
        check(engine, `${tag} Tab·Shift+Tab ${KEYS.length}번 동안 초점이 라이트박스 밖으로 나가지 않는다`, escaped === 0, `escaped=${escaped} ${visited.join(" ")}`);
        await page.keyboard.press("Escape");
        await page.getByTestId("image-lightbox").waitFor({ state: "detached", timeout: 10_000 });
        check(engine, `${tag} Esc로 닫으면 초점이 여는 썸네일로 돌아온다`, (await focusReturnsTo(trigger)) === true);
      } finally {
        await context.close();
      }
    }

    // 펼치는 동안(hero 이동 중): 크롬은 숨어 닫기가 초점을 못 받는다. 이때 초점이 열기 단추(무대 뒤)에 남으면 Tab이 밖으로 샌다.
    // hero 애니메이션을 만들어지는 순간 멈춰 이 구간을 결정적으로 만든다(시계에 기대지 않는다).
    {
      const tag = "[키보드로 열기·펼치는 중]";
      const { context, page } = await open(browser, origin, "light", VIEWPORTS[1], { desktop: false, motion: "no-preference" });
      try {
        await page.evaluate(() => {
          const original = Element.prototype.animate;
          window.__heroHeld = [];
          Element.prototype.animate = function (...args) {
            const animation = original.apply(this, args);
            if (this.classList?.contains("stage-hero")) { animation.pause(); window.__heroHeld.push(animation); }
            return animation;
          };
        });
        await openByKeyboard(page);
        await page.waitForFunction(() => window.__heroHeld.length > 0, null, { timeout: 15_000 });
        await page.waitForTimeout(150);
        const held = await state(page);
        check(engine, `${tag} 시험이 펼치는 구간에 선다(단계 opening)`, held.phase === "opening", JSON.stringify(held));
        let escaped = 0;
        const visited = [];
        for (const key of ["Tab", "Shift+Tab", "Tab", "Tab", "Shift+Tab", "Shift+Tab"]) {
          await page.keyboard.press(key);
          await page.waitForTimeout(40);
          const now = await state(page);
          if (!now.inside) escaped += 1;
          visited.push(`${key}:${now.id}${now.inside ? "" : "(밖)"}`);
        }
        check(engine, `${tag} 펼치는 동안 Tab·Shift+Tab이 라이트박스 밖으로 새지 않는다`, escaped === 0, `escaped=${escaped} ${visited.join(" ")}`);
        await page.evaluate(() => window.__heroHeld.forEach((animation) => animation.play()));
        await settledOpen(page);
        const landed = await state(page);
        check(engine, `${tag} 펼침이 끝나면 초점이 닫기 단추로 옮겨 가고 링이 보인다`, landed.id === "image-lightbox-close" && landed.ringShown === true, JSON.stringify(landed));
      } finally {
        await context.close();
      }
    }

    // 마우스로 열면 링이 서지 않는다: 같은 첫 초점이지만 입력 방식 표지가 pointer 그대로여야 한다.
    {
      const tag = "[마우스로 열기]";
      const { context, page } = await open(browser, origin, "light", VIEWPORTS[1], { desktop: false, motion: "reduce" });
      try {
        await openLightbox(page, MULTI_MSG);
        const clicked = await state(page);
        check(engine, `${tag} 열면 초점이 닫기 단추에 선다`, clicked.id === "image-lightbox-close" && clicked.inside, JSON.stringify(clicked));
        check(engine, `${tag} 첫 초점 「닫기」에 초점 링이 서지 않는다`, clicked.ringShown === false && clicked.modality === "pointer", JSON.stringify(clicked));
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
}

/** 복사: 진짜 클립보드(Chromium)에서 PNG와 JPEG→PNG 두 갈래를 읽어 본다. */
async function copyChecks(origin) {
  const engine = "chromium";
  const browser = await chromium.launch();
  try {
    const { context, page } = await open(browser, origin, "light", VIEWPORTS[1], { desktop: false, clipboard: true });
    try {
      await openLightbox(page, MULTI_MSG);
      // 클립보드에서 읽은 PNG와 원본 그림을 같은 다섯 점에서 비교한다. Chromium은 시스템 클립보드에 넣을 때 PNG를 다시 인코딩하므로 바이트 길이는 같을
      // 수 없다: 눈에 보이는 값(크기·픽셀)이 그대로인지를 잰다. 둘 다 무손실 경로라 오차는 0이다.
      const compare = (originalBase64, originalMime) => page.evaluate(async ({ originalBase64, originalMime }) => {
        const points = [[0.1, 0.1], [0.5, 0.5], [0.9, 0.9], [0.3, 0.7], [0.7, 0.3]];
        const sample = async (blob) => {
          const bitmap = await createImageBitmap(blob);
          const canvas = document.createElement("canvas");
          canvas.width = bitmap.width; canvas.height = bitmap.height;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(bitmap, 0, 0);
          return { width: bitmap.width, height: bitmap.height, px: points.map(([u, v]) => Array.from(ctx.getImageData(Math.floor(u * (bitmap.width - 1)), Math.floor(v * (bitmap.height - 1)), 1, 1).data.slice(0, 3))) };
        };
        const items = await navigator.clipboard.read();
        const types = items.flatMap((item) => item.types);
        const pngItem = items.find((item) => item.types.includes("image/png"));
        if (!pngItem) return { types, error: "image/png 항목이 없다" };
        let copied;
        try {
          copied = await sample(await pngItem.getType("image/png"));
        } catch (error) {
          return { types, error: `클립보드의 PNG를 못 읽는다: ${error}` };
        }
        const bytes = Uint8Array.from(atob(originalBase64), (c) => c.charCodeAt(0));
        const original = await sample(new Blob([bytes], { type: originalMime }));
        const worst = Math.max(...copied.px.flatMap((rgb, i) => rgb.map((v, k) => Math.abs(v - original.px[i][k]))));
        return { types, items: items.length, copied: [copied.width, copied.height], original: [original.width, original.height], worst };
      }, { originalBase64, originalMime });
      /** 단추가 「복사했어요」를 말할 때까지(실패하면 말하지 않는다). 못 기다리면 거짓이다: 멈추지 않고 실패로 모은다. */
      const copiedSaid = () => page.waitForFunction(() => document.querySelector('[data-testid="image-lightbox-copy"]')?.getAttribute("aria-label") === "복사했어요", null, { timeout: 5_000 }).then(() => true, () => false);
      // ① PNG
      await page.bringToFront();
      await page.getByTestId("image-lightbox-copy").click();
      const pngSaid = await copiedSaid();
      check(engine, "[복사] PNG 사진을 누르면 단추가 「복사했어요」를 말한다", pngSaid);
      const png = pngSaid ? await compare(BYTES_BY_ID[ATT.a.id].body.toString("base64"), "image/png") : { error: "복사했어요를 못 들었다" };
      check(engine, "[복사] PNG 사진이 image/png 한 항목으로 들어가고 크기와 다섯 점의 픽셀이 원본과 같다", png.items === 1 && png.types.join() === "image/png" && png.copied?.join() === "1600,1000" && png.worst === 0, JSON.stringify(png));
      // ② JPEG: 그려서 PNG로 바꾼다.
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await page.waitForFunction(() => document.querySelector('[data-testid="image-lightbox-position"]')?.textContent === "3장 중 3번");
      await page.getByTestId("image-lightbox-ready").locator("img").waitFor();
      await page.getByTestId("image-lightbox-copy").click();
      const jpegSaid = await copiedSaid();
      check(engine, "[복사] JPEG 사진을 누르면 단추가 「복사했어요」를 말한다", jpegSaid);
      const jpeg = jpegSaid ? await compare(BYTES_BY_ID[ATT.c.id].body.toString("base64"), "image/jpeg") : { error: "복사했어요를 못 들었다" };
      check(engine, "[복사] JPEG 사진이 image/png 한 항목으로 바뀌어 들어가고 크기와 다섯 점의 픽셀이 같다", jpeg.items === 1 && jpeg.types.join() === "image/png" && jpeg.copied?.join() === "1400,800" && jpeg.worst <= 2, JSON.stringify(jpeg));
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

/** 브라우저(Chromium)가 그려 만든 JPEG 한 장. Node에는 인코더가 없다. */
async function makeJpeg(width, height) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const base64 = await page.evaluate(({ width, height }) => {
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#0e1118"; ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = "#22262f"; ctx.fillRect(0, 0, width, Math.round(height * 0.07));
      const colors = ["#62d68c", "#70a8ff", "#a0a8b8"];
      for (let row = 0; row < 24; row += 1) {
        ctx.fillStyle = colors[row % 3];
        ctx.fillRect(Math.round(width * 0.04), Math.round(height * (0.12 + row * 0.034)), Math.round(width * (0.2 + ((row * 37) % 55) / 100)), Math.round(height * 0.014));
      }
      return canvas.toDataURL("image/jpeg", 0.9).split(",")[1];
    }, { width, height });
    return Buffer.from(base64, "base64");
  } finally {
    await browser.close();
  }
}

async function probe(origin) {
  const browser = await chromium.launch();
  try {
    for (const scheme of SCHEMES) {
      const { context, page } = await open(browser, origin, scheme, VIEWPORTS[1], { desktop: true });
      try {
        await openLightbox(page, MULTI_MSG);
        const facts = await page.evaluate(() => {
          const rect = (sel) => { const r = document.querySelector(sel)?.getBoundingClientRect(); return r ? { left: +r.left.toFixed(1), top: +r.top.toFixed(1), width: +r.width.toFixed(1), height: +r.height.toFixed(1), centerY: +((r.top + r.bottom) / 2).toFixed(1) } : null; };
          const glass = document.querySelector('[data-testid="image-lightbox-info"]');
          return { info: rect('[data-testid="image-lightbox-info"]'), close: rect('[data-testid="image-lightbox-close"]'), infoBackground: glass ? getComputedStyle(glass).backgroundColor : null };
        });
        console.log(`PROBE ${LABEL} ${scheme} 1440`, JSON.stringify(facts));
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
}

async function runChecks(origin) {
  // `ONLY=geometry,pixel,narrow,keyboard,focus,copy`: 사보타주 때 지키는 줄에 해당하는 묶음만 돌린다. 기본은 전부다.
  const only = new Set((process.env.ONLY || "geometry,pixel,narrow,keyboard,focus,copy").split(","));
  for (const name of ENGINES) {
    const browserType = name === "webkit" ? webkit : chromium;
    if (only.has("geometry")) await geometryChecks(browserType, name, origin);
    if (only.has("pixel")) await pixelChecks(browserType, name, origin);
    if (only.has("narrow")) await narrowChecks(browserType, name, origin);
    if (only.has("keyboard")) await keyboardChecks(browserType, name, origin);
    if (only.has("focus")) await keyboardOpenChecks(browserType, name, origin);
  }
  if (only.has("copy") && ENGINES.includes("chromium")) await copyChecks(origin);
  writeFileSync(resolve(outDir(), "checks.json"), JSON.stringify({ label: LABEL, dist: DIST, passes, failures }, null, 2));
  console.log(`측정 통과 ${passes.length} · 실패 ${failures.length}`);
  for (const line of failures) console.log(`  FAIL ${line}`);
  if (failures.length) process.exitCode = 1;
}

async function main() {
  const distDir = resolve(WEB_ROOT, DIST);
  if (!existsSync(resolve(distDir, "index.html"))) throw new Error(`빌드가 없다: ${distDir} (먼저 vite build)`);
  mkdirSync(outDir(), { recursive: true });
  const preview = await startGuardedPreview({
    webRoot: WEB_ROOT,
    port: PORT,
    portEnvVar: "CAPTURE_PORT",
    extraArgs: ["--outDir", distDir],
  });
  const origin = preview.origin;
  try {
    // 셋째 장은 JPEG이다(복사의 PNG 변환 갈래를 재려고). Node에 인코더가 없어 브라우저가 그려서 만든다.
    BYTES_BY_ID[ATT.c.id].body = await makeJpeg(BYTES_BY_ID[ATT.c.id].width, BYTES_BY_ID[ATT.c.id].height);
    if (SHOTS) {
      // 그림은 엔진마다 한 벌만: Chromium이 정본이고, WebKit(WKWebView)은 측정에서 본다.
      await captureScenes(chromium, origin);
    }
    if (PROBE) await probe(origin);
    if (CHECKS) await runChecks(origin);
    writeFileSync(resolve(outDir(), "files.json"), JSON.stringify({ label: LABEL, dist: DIST, written, errors }, null, 2));
    console.log(`캡처 ${written.length}장 -> ${outDir()}`);
    if (errors.length) console.log(`페이지 오류 ${errors.length}건`, errors.slice(0, 5));
  } finally {
    await preview.stop?.();
  }
}

main().then(() => process.exit(process.exitCode ?? 0), (error) => {
  console.error(error);
  process.exit(1);
});
