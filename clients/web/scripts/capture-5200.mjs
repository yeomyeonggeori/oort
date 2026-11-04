#!/usr/bin/env node
// =============================================================================
// 입력창 첨부 줄 (#5200): 모양·키보드를 재고, 라이트·다크 × 720·1440 으로 찍는다.
//
//   npm run build && node scripts/capture-5200.mjs --label after
//   node scripts/capture-5200.mjs --dist <옛 빌드> --label before --soft     # 고치기 전 코드에서 RED
//
// 번들 Chromium 헤드리스 + 모의 `/v1`(시크릿 없음)이다. 정적 서버는 이 파일이 직접 띄우고
// 자기 PID 로만 끈다. 단정은 구현 이름이 아니라 **상자**를 잰다(어디에 서는가·한 줄인가·
// X 가 그림 가운데를 덮는가·입력창이 카드 줄만큼만 자라는가·키보드로 빼고 초점이 어디로 가는가).
// 그래서 같은 스크립트가 옛 빌드에서는 빨갛고 새 빌드에서는 초록이다.
//
// 옵션: --dist(기본 dist) --out(기본 captures/5200/<label>) --label(기본 after)
//       --port(기본 5520) --soft(실패해도 끝까지 돌고 종료 코드 0) --no-shots
//       --combos(쉼표 목록: light-1440,dark-1440,light-720,dark-720,touch,thread-light,thread-dark. 기본 전부)
//       --engine(chromium 기본 | webkit: 데스크탑 셸의 WKWebView 에 가까운 번들 WebKit)
// 캡처는 저장소에 올리지 않는다: --out 을 스크래치로 준다(captures/ 는 옛 이슈의 증거 폴더다).
// =============================================================================
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { chromium, webkit } from "playwright";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  if (at < 0) return fallback;
  const next = process.argv[at + 1];
  return next === undefined || next.startsWith("--") ? true : next;
}

const LABEL = String(arg("label", "after"));
const DIST = resolve(WEB_ROOT, String(arg("dist", "dist")));
const OUT = resolve(WEB_ROOT, String(arg("out", `captures/5200/${LABEL}`)));
const PORT = Number(arg("port", 5520));
const SINK_PORT = PORT + 1;
const SOFT = arg("soft", false) === true;
const SHOTS = arg("no-shots", false) !== true;
const ENGINE = String(arg("engine", "chromium"));
const COMBOS = String(arg("combos", "all")).split(",");
const wanted = (name) => COMBOS.includes("all") || COMBOS.includes(name);
const ORIGIN = `http://127.0.0.1:${PORT}`;

// ---- 결과 장부 ---------------------------------------------------------------

const results = [];
let scope = "";

function check(id, ok, detail = "") {
  results.push({ scope, id, ok: Boolean(ok), detail });
  const mark = ok ? "PASS" : "FAIL";
  console.log(`  [${mark}] ${id}${detail === "" ? "" : `  (${detail})`}`);
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const near = (a, b, tolerance = 1.5) => Math.abs(a - b) <= tolerance;

// ---- 정적 서버 (번들 그대로, 자기 PID 로만 끈다) ----------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".wasm": "application/wasm",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

function startStatic() {
  const server = createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? "/", ORIGIN).pathname);
    let file = normalize(join(DIST, pathname));
    if (!file.startsWith(DIST)) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) {
      if (extname(pathname) !== "") {
        res.writeHead(404).end();
        return;
      }
      file = join(DIST, "index.html");
    }
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
  });
  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(PORT, "127.0.0.1", () => done(server));
  });
}

/** 인터셉트되지 않는 진짜 업로드 목적지. 느리게 읽어서 브라우저가 진행을 여러 번 보고하게 한다. */
function startByteSink() {
  const server = createServer((req, res) => {
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "PUT, OPTIONS",
      "access-control-allow-headers": "content-type",
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors).end();
      return;
    }
    req.on("data", () => {
      req.pause();
      setTimeout(() => req.resume(), 25);
    });
    req.on("end", () => res.writeHead(200, cors).end(""));
  });
  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(SINK_PORT, "127.0.0.1", () => done(server));
  });
}

// ---- 모의 /v1 -----------------------------------------------------------------

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const peerId = "00000000-0000-7000-8000-000000000102";
const channelA = "00000000-0000-7000-8000-000000000201";

const session = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "한서연", handle: "seoyeon" },
  realtimeWebSocketUrl: "ws://capture-5200.invalid/connection/websocket",
};

const member = (over) => ({
  workspaceId,
  status: "active",
  role: "member",
  channelCount: 1,
  channelIds: [channelA],
  capabilities: [],
  createdAtMs: 0,
  updatedAtMs: 0,
  ...over,
});
const roster = [
  member({ id: memberId, kind: "human", role: "owner", displayName: "한서연", handle: "seoyeon" }),
  member({ id: peerId, kind: "human", displayName: "오도현", handle: "dohyun" }),
];
const channels = [{ id: channelA, workspaceId, kind: "public", name: "release-2026-11", muted: false }];

const AT = Date.now() - 3_600_000;
const row = (over) => ({
  channelId: channelA,
  hlcCount: 0,
  type: "text",
  state: "sent",
  ...over,
  hlcTs: over.hlcTs ?? over.createdAtMs,
});
const history = () => [
  row({ id: "0199dddd-0000-7000-8000-000000000001", seq: 100, authorMemberId: peerId, body: "스테이징 배포 끝났어요. 첨부 화면 같이 봐 주세요.", createdAtMs: AT }),
  row({ id: "0199dddd-0000-7000-8000-000000000002", seq: 101, authorMemberId: memberId, body: "녹화랑 캡처 올릴게요. 한 번에 여러 장 붙여 볼게요.", createdAtMs: AT + 60_000 }),
  row({ id: "0199dddd-0000-7000-8000-000000000003", seq: 102, authorMemberId: peerId, body: "좋아요, 영상은 용량이 커서 업로드가 좀 걸릴 수 있어요.", createdAtMs: AT + 120_000 }),
];

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** 세 왕복(uploads·바이트·complete)을 시험이 손으로 연다. */
function createArchive() {
  const latch = () => {
    let open = false;
    let waiting = null;
    return {
      wait: () => (open ? Promise.resolve() : new Promise((release) => { waiting = release; })),
      release: () => { open = true; waiting?.(); waiting = null; },
    };
  };
  const gates = { bytes: latch(), complete: latch() };
  let completeStatus = 200;
  return {
    hold: (key) => gates[key].wait(),
    releaseAll: () => { gates.bytes.release(); gates.complete.release(); },
    setCompleteStatus: (status) => { completeStatus = status; },
    completeStatus: () => completeStatus,
  };
}

async function installRealtimeSocket(page) {
  await page.addInitScript(() => {
    const sockets = new Set();
    class CaptureWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      constructor(url) {
        this.url = url;
        this.readyState = CaptureWebSocket.CONNECTING;
        this.subscriptions = new Set();
        sockets.add(this);
        queueMicrotask(() => {
          this.readyState = CaptureWebSocket.OPEN;
          this.onopen?.(new Event("open"));
        });
      }
      send(data) {
        const replies = [];
        for (const line of String(data).trim().split("\n")) {
          const command = JSON.parse(line);
          if (command.connect) replies.push({ id: command.id, connect: { client: "capture-5200", version: "6" } });
          else if (command.subscribe) {
            this.subscriptions.add(command.subscribe.channel);
            replies.push({ id: command.id, subscribe: { recoverable: true, positioned: true, recovered: true, epoch: "capture-5200", offset: 0 } });
          } else if (command.unsubscribe) {
            this.subscriptions.delete(command.unsubscribe.channel);
            replies.push({ id: command.id, unsubscribe: {} });
          } else replies.push({ id: command.id });
        }
        queueMicrotask(() => {
          this.onmessage?.(new MessageEvent("message", { data: replies.map((reply) => JSON.stringify(reply)).join("\n") }));
        });
      }
      close() {
        this.readyState = CaptureWebSocket.CLOSED;
        sockets.delete(this);
        this.onclose?.(new CloseEvent("close", { code: 1000 }));
      }
    }
    window.WebSocket = CaptureWebSocket;
    window.__captureSubscribed = () => {
      for (const socket of sockets) for (const name of socket.subscriptions) if (name.startsWith("ch:")) return true;
      return false;
    };
  });
}

async function installRoutes(context, archive, sink) {
  await context.route(`${ORIGIN}/__capture/upload/*`, async (route) => {
    await archive.hold("bytes");
    await route.fulfill({ status: 200, body: "" });
  });
  await context.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === "/v1/auth/login") return json(route, session);
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "capture-realtime-token", tokenType: "Bearer", expiresAtMs: Date.now() + 60_000, ttlSeconds: 60, workspaceId, memberId });
    }
    if (path === "/v1/auth/refresh") return json(route, { accessToken: session.accessToken, refreshToken: session.refreshToken });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/reactions")) return json(route, {});
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-sessions")) return json(route, { sessions: [] });
    if (path.endsWith("/replies")) return json(route, { messages: [] });
    if (path.includes("/approvals")) return json(route, { approvals: [] });
    if (path.includes("/pins")) return json(route, { pins: [] });
    if (path.endsWith("/attachments/uploads")) {
      const body = JSON.parse(request.postData() ?? "{}");
      return json(
        route,
        {
          id: `0199eeee-0000-7000-8000-${String(Math.floor(Math.random() * 1e12)).padStart(12, "0")}`,
          status: "pending",
          uploadUrl: sink() ? `http://127.0.0.1:${SINK_PORT}/upload/${encodeURIComponent(body.name)}` : `${ORIGIN}/__capture/upload/${encodeURIComponent(body.name)}`,
        },
        201
      );
    }
    if (path.endsWith("/complete")) {
      await archive.hold("complete");
      if (archive.completeStatus() !== 200) {
        return json(route, { error: { message: "uploaded file size or mime does not match" } }, archive.completeStatus());
      }
      return json(route, { id: "0199eeee-0000-7000-8000-0000000000aa", channelId: channelA, uploaderMemberId: memberId, name: "x", mime: "application/octet-stream", size: 1, status: "complete", createdAtMs: Date.now() });
    }
    if (path.endsWith("/messages")) {
      if (url.searchParams.has("after") || url.searchParams.has("before")) return json(route, { messages: [] });
      return json(route, { messages: history() });
    }
    return json(route, {});
  });
}

// ---- 사진처럼 보이는 PNG (1px 짜리는 어떤 레이아웃 버그도 못 드러낸다) ---------------

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

/** variant 0 어두운 화면 캡처 · 1 밝은 문서 · 2 색 그라디언트 · 3 따뜻한 그라디언트 */
function paint(x, y, w, h, variant) {
  const fx = x / w;
  const fy = y / h;
  if (variant === 0) {
    const bar = y % 28 < 8 && fx > 0.08 && fx < 0.34 + ((Math.floor(y / 28) * 37) % 50) / 100;
    return bar ? [226, 230, 236] : [14 + Math.round(fy * 10), 20 + Math.round(fy * 12), 32 + Math.round(fy * 14)];
  }
  if (variant === 1) {
    if (fy < 0.14) return [34, 44, 66];
    const line = y % 20 < 6 && fx > 0.07 && fx < 0.9 - ((Math.floor(y / 20) * 29) % 40) / 100;
    return line ? [190, 196, 206] : [250, 250, 248];
  }
  if (variant === 2) return [40 + Math.round(fx * 150), 60 + Math.round(fy * 120), 150 - Math.round(fx * 90)];
  return [230 + Math.round(fx * 25), 140 + Math.round(fy * 60), 100 + Math.round(fx * 40)];
}

/** 유효한 PNG 뒤에 0 을 덧붙여 바이트를 키운다(디코더는 IEND 뒤를 읽지 않는다). */
function makePng(width, height, variant, pad = 0) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let at = 0;
  for (let y = 0; y < height; y++) {
    raw[at++] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y, width, height, variant);
      raw[at++] = r;
      raw[at++] = g;
      raw[at++] = b;
    }
  }
  const chunk = (type, body) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed) >>> 0);
    return Buffer.concat([length, typed, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
    Buffer.alloc(pad),
  ]);
}

const PNG = [0, 1, 2, 3].map((variant) => makePng(640, 400, variant));
const png = (name, variant = 0, pad = 0) => ({
  name,
  mimeType: "image/png",
  buffer: pad === 0 ? PNG[variant % 4] : makePng(640, 400, variant % 4, pad),
});
const video = (name, kb = 2400) => ({ name, mimeType: "video/mp4", buffer: Buffer.alloc(kb * 1024, 1) });
const pdf = (name, kb = 182) => ({ name, mimeType: "application/pdf", buffer: Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(kb * 1024, 32)]) });
const text = (name, kb = 20) => ({ name, mimeType: "text/plain", buffer: Buffer.alloc(kb * 1024, 97) });

/** 섞인 20개. 이미지가 반쯤, 영상·PDF·로그가 사이사이. */
function mixed(n, from = 0) {
  const names = ["화면 캡처 2026-11-02 오후 4.51.png", "릴리스-체크리스트.pdf", "녹화-온보딩-시연.mp4", "drain-2026-11-01.log", "lag-curve.png", "분기별-온보딩-리뷰-최종-v3.pdf"];
  const list = [];
  for (let i = from; i < from + n; i++) {
    const kind = i % 4;
    if (kind === 1) list.push(pdf(`리뷰-${i}-${names[1]}`));
    else if (kind === 2) list.push(video(`${i}-${names[2]}`));
    else if (kind === 3 && i % 8 === 3) list.push(text(`${i}-${names[3]}`));
    else list.push(png(`캡처-${i}-${names[4]}`, i));
  }
  return list;
}

// ---- 페이지 조작 ----------------------------------------------------------------

async function login(page) {
  await page.goto(ORIGIN, { waitUntil: "networkidle" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("capture-only");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-item").first().waitFor();
}

async function openChannel(page) {
  await page.evaluate((id) => { window.location.hash = `#/c/${id}`; }, channelA);
  await page.getByTestId("composer-input").waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => window.__captureSubscribed?.(), undefined, { timeout: 15_000 });
  await wait(400);
}

const attachInput = (page) => page.locator('[data-testid="composer"] input[type="file"]').first();
const cards = (page) => page.getByTestId("attachment-chip");

async function addFiles(page, files) {
  await attachInput(page).setInputFiles(files);
}

async function waitCount(page, n) {
  await page.waitForFunction((count) => document.querySelectorAll('[data-testid="attachment-chip"]').length === count, n, { timeout: 15_000 });
}

async function waitSettled(page) {
  await page.waitForFunction(
    () => {
      const list = [...document.querySelectorAll('[data-testid="attachment-chip"]')];
      return list.length > 0 && list.every((c) => ["uploaded", "failed"].includes(c.dataset.attachmentStatus ?? ""));
    },
    undefined,
    { timeout: 30_000 }
  );
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="attachment-chip"][data-thumb="loading"]').length === 0, undefined, { timeout: 15_000 });
  await wait(250);
}

async function resetTray(page) {
  await page.reload({ waitUntil: "networkidle" });
  await page.getByTestId("composer-input").waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => window.__captureSubscribed?.(), undefined, { timeout: 15_000 });
  await wait(300);
}

const CHANNEL_IDS = { frame: "composer-frame", input: "composer-input", send: "composer-send", actions: "composer-actions" };
const THREAD_IDS = { frame: "thread-composer-frame", input: "thread-composer-input", send: "thread-composer-send", actions: "thread-composer-actions" };

/** 한 화면의 상자를 한 번에 잰다(레이아웃이 중간에 바뀌지 않게 evaluate 하나로). */
function measure(page, ids = CHANNEL_IDS) {
  return page.evaluate((ids) => {
    const rect = (el) => {
      if (el === null || el === undefined) return null;
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height, r: b.right, b: b.bottom };
    };
    const q = (sel) => document.querySelector(sel);
    const frame = q(`[data-testid="${ids.frame}"]`);
    const tray = q('[data-testid="attachment-tray"]');
    const list = q('[data-testid="attachment-list-scroll"]');
    const listStyle = list === null ? null : getComputedStyle(list);
    const cardList = [...document.querySelectorAll('[data-testid="attachment-chip"]')].map((card) => {
      const remove = card.querySelector('[data-testid="attachment-chip-remove"]');
      const visual = remove !== null && remove.firstElementChild?.tagName === "SPAN" ? remove.firstElementChild : remove;
      const thumb = card.querySelector('[data-testid="attachment-chip-thumb"]');
      return {
        status: card.dataset.attachmentStatus ?? "",
        tabIndex: card.tabIndex,
        box: rect(card),
        remove: rect(remove),
        removeVisual: rect(visual),
        removeTabIndex: remove === null ? null : remove.tabIndex,
        removeOpacity: remove === null ? null : Number(getComputedStyle(remove).opacity),
        removeLabel: remove?.getAttribute("aria-label") ?? "",
        thumbNatural: thumb === null ? null : thumb.naturalWidth,
        thumbBox: rect(thumb),
        text: card.innerText,
        // 구현에 기대지 않는다: 이름은 aria-label 이거나(아이콘 단추) 글자(글자 단추)다.
        retryLabel: (() => {
          const retry = card.querySelector('[data-testid="attachment-chip-retry"]');
          return retry === null ? null : (retry.getAttribute("aria-label") ?? retry.textContent?.trim() ?? "");
        })(),
        retryBox: rect(card.querySelector('[data-testid="attachment-chip-retry"]')),
      };
    });
    const maskOf = (el) => (el === null ? "" : getComputedStyle(el).maskImage || getComputedStyle(el).webkitMaskImage || "");
    return {
      frame: rect(frame),
      frameOutline: frame === null ? null : getComputedStyle(frame).outlineStyle,
      tray: rect(tray),
      list: rect(list),
      listOverflowX: listStyle?.overflowX ?? null,
      listScrollWidth: list?.scrollWidth ?? null,
      listClientWidth: list?.clientWidth ?? null,
      listScrollHeight: list?.scrollHeight ?? null,
      listClientHeight: list?.clientHeight ?? null,
      listScrollLeft: list?.scrollLeft ?? null,
      listMask: maskOf(list),
      listFade: list?.dataset.fade ?? null,
      input: rect(q(`[data-testid="${ids.input}"]`)),
      send: rect(q(`[data-testid="${ids.send}"]`)),
      actions: rect(q(`[data-testid="${ids.actions}"]`)),
      blocked: rect(q('[data-testid="attachment-blocked"]')),
      blockedText: q('[data-testid="attachment-blocked"]')?.textContent ?? null,
      rejected: rect(q('[data-testid="attachment-rejected"]')),
      rejectedText: q('[data-testid="attachment-rejected"]')?.textContent ?? null,
      clear: rect(q('[data-testid="attachment-clear"]')),
      cards: cardList,
      scrollY: window.scrollY,
    };
  }, ids);
}

const active = (page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    const list = [...document.querySelectorAll('[data-testid="attachment-chip"]')];
    return {
      testId: a?.getAttribute("data-testid") ?? null,
      cardIndex: list.findIndex((c) => c === a || c.contains(a)),
      cardCount: list.length,
      onCard: list.some((c) => c === a),
    };
  });

/** 스크린샷 바이트를 페이지 안에서 풀어 한 픽셀을 읽는다(의존 없이 「그려졌는가」를 잰다). */
function pixelAt(page, buffer, x, y) {
  return page.evaluate(
    async ({ b64, x, y }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d");
      context.drawImage(bitmap, 0, 0);
      const d = context.getImageData(x, y, 1, 1).data;
      return [d[0], d[1], d[2]];
    },
    { b64: buffer.toString("base64"), x, y }
  );
}

const parseRgb = (text) => {
  const found = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(text);
  return found === null ? null : [Number(found[1]), Number(found[2]), Number(found[3])];
};
const closeRgb = (a, b, tolerance = 16) => a !== null && b !== null && a.every((v, i) => Math.abs(v - b[i]) <= tolerance);

async function shot(page, name, width, id = "composer") {
  if (!SHOTS) return;
  const dock = await page.getByTestId(id).boundingBox();
  const top = Math.max(0, Math.floor(dock.y - 140));
  const viewportHeight = page.viewportSize().height;
  // 스레드 패널은 오른쪽에 붙은 좁은 판이라 그 판 폭만 찍는다.
  const left = id === "composer" ? 0 : Math.max(0, Math.floor(dock.x - 24));
  const clip = { x: left, y: top, width: Math.min(width - left, id === "composer" ? width : Math.ceil(dock.width + 48)), height: Math.min(viewportHeight - top, Math.ceil(dock.height + 140)) };
  await page.screenshot({ path: join(OUT, `${name}.png`), clip });
}

const intersects = (a, b) => a.x < b.r && a.r > b.x && a.y < b.b && a.b > b.y;
const center = (box, share) => ({
  x: box.x + (box.w * (1 - share)) / 2,
  y: box.y + (box.h * (1 - share)) / 2,
  r: box.r - (box.w * (1 - share)) / 2,
  b: box.b - (box.h * (1 - share)) / 2,
});

// ---- 한 조합(색 × 폭)의 전 장면 -----------------------------------------------------

async function runCombo(browser, { scheme, width }) {
  const tag = `${scheme}-${width}`;
  scope = tag;
  console.log(`\n== ${LABEL} · ${tag} ==`);
  const archive = createArchive();
  let useSink = false;
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: scheme,
    locale: "ko-KR",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await installRealtimeSocket(page);
  await installRoutes(context, archive, () => useSink);
  await login(page);
  await openChannel(page);
  const prefix = (n) => `${tag}-${n}`;

  // 0. 첨부가 없으면 줄도 없다.
  const base = await measure(page);
  check("빈 상태: 첨부 줄이 서 있지 않다", base.tray === null && base.cards.length === 0);

  // 1. 한 개, 다섯 개, 스무 개 (업로드는 끝나게 둔다 — 완료 모양을 찍는다)
  archive.releaseAll();
  const frames = {};
  const rows = {};
  for (const [label, count, files] of [
    ["n1", 1, [png("화면 캡처 2026-11-02 오후 4.51.png", 0)]],
    ["n5", 5, [png("lag-curve.png", 1), png("릴리스 화면.png", 2), video("녹화-온보딩-시연.mp4"), pdf("분기별-온보딩-리뷰-최종-v3.pdf")]],
    ["n20", 20, mixed(15, 5)],
  ]) {
    await addFiles(page, files);
    await waitCount(page, count);
    await waitSettled(page);
    const m = await measure(page);
    frames[label] = m.frame.h;
    rows[label] = m.list?.h ?? 0;

    check(`${label}: 줄이 입력창 테두리 안에 서 있다`,
      m.tray !== null && m.frame !== null && m.tray.x >= m.frame.x - 0.5 && m.tray.r <= m.frame.r + 0.5 && m.tray.y >= m.frame.y - 0.5 && m.tray.b <= m.frame.b + 0.5,
      m.tray === null ? "트레이 없음" : `tray y=${m.tray.y.toFixed(0)}..${m.tray.b.toFixed(0)} frame y=${m.frame.y.toFixed(0)}..${m.frame.b.toFixed(0)}`);

    if (m.cards.length > 1) {
      const tops = m.cards.map((c) => c.box.y);
      check(`${label}: 카드가 한 줄이다(세로로 줄바꿈 없음)`, tops.every((t) => near(t, tops[0], 1)) && (m.listScrollHeight ?? 0) <= (m.listClientHeight ?? 0) + 1,
        `tops ${[...new Set(tops.map((t) => Math.round(t)))].join(",")} scrollH=${m.listScrollHeight}/${m.listClientHeight}`);
    }

    // X: 작고, 그림 가운데를 가리지 않고, 24px 이상으로 눌린다
    const worst = m.cards.map((c) => ({ visual: c.removeVisual, hit: c.remove, card: c.box }));
    check(`${label}: X 단추가 작다(눈에 보이는 원 ≤ 20px, 카드 높이의 20% 이하)`,
      worst.every((w) => w.visual !== null && w.visual.w <= 20.5 && w.visual.h <= 20.5 && w.visual.h / w.card.h <= 0.2),
      worst.slice(0, 1).map((w) => `원 ${w.visual?.w}×${w.visual?.h} / 카드 ${w.card.w}×${w.card.h}`).join(""));
    check(`${label}: X 단추 누를 면이 24px 이상이다`, worst.every((w) => w.hit !== null && w.hit.w >= 23.5 && w.hit.h >= 23.5));
    check(`${label}: X 가 그림 가운데(가로·세로 50%)를 덮지 않는다`,
      worst.every((w) => w.hit !== null && !intersects(w.hit, center(w.card, 0.5))));
    check(`${label}: X 가 카드 오른쪽 위 모서리에 걸쳐 있다`,
      worst.every((w) => w.visual !== null && w.visual.x + w.visual.w / 2 >= w.card.x + w.card.w * 0.8 && w.visual.y + w.visual.h / 2 <= w.card.y + w.card.h * 0.2));

    // 썸네일은 카드의 두 배 이상으로 그린다
    const thumbs = m.cards.filter((c) => c.thumbNatural !== null);
    check(`${label}: 썸네일이 카드 한 변의 2배 이상으로 그려진다`,
      thumbs.length > 0 && thumbs.every((c) => c.thumbNatural >= c.box.w * 2 - 1), thumbs[0] === undefined ? "썸네일 없음" : `${thumbs[0].thumbNatural}px / 카드 ${thumbs[0].box.w}px`);

    // 입력창은 줄만큼만 자라고 글 칸·보내기와 겹치지 않는다
    if (m.tray !== null && m.input !== null && m.send !== null) {
      check(`${label}: 글 칸이 줄 아래에 있고 겹치지 않는다`, m.input.y >= m.tray.b - 1, `input.y=${m.input.y.toFixed(0)} tray.b=${m.tray.b.toFixed(0)}`);
      check(`${label}: 보내기 단추가 줄과 겹치지 않는다`, !intersects(m.send, m.tray));
    }
    check(`${label}: 줄 아래 안내 줄이 비어도 자리를 지킨다(높이 > 0)`, m.blocked !== null && m.blocked.h > 0);
    if (label === "n1") check("n1: 넘치지 않으면 가장자리가 흐리지 않다", m.listFade === "none", String(m.listFade));
    if (label === "n20") {
      check("n20: 카드를 끝에 붙이면 줄이 끝으로 밀려 방금 붙인 카드가 보인다", (m.listScrollLeft ?? 0) + (m.listClientWidth ?? 0) >= (m.listScrollWidth ?? 0) - 3, `${m.listScrollLeft}+${m.listClientWidth}/${m.listScrollWidth}`);
    }
    await shot(page, prefix(label), width);
  }

  // 높이: 한 줄이므로 1·5·20개에서 줄 높이가 같고, 입력창은 그 줄만큼만 더 자란다
  check("줄 높이가 1·5·20개에서 같다(고정)", near(rows.n1, rows.n5, 1) && near(rows.n5, rows.n20, 1), `${rows.n1}/${rows.n5}/${rows.n20}`);
  check("입력창이 1→20개에서 더 자라지 않는다(카드 줄은 한 줄)", near(frames.n1, frames.n20, 2), `${frames.n1}→${frames.n20}`);
  const grown = frames.n1 - base.frame.h;
  const m1 = await measure(page);
  check("입력창이 카드 줄(+안내 줄)만큼만 자란다", m1.tray !== null && near(grown, m1.tray.h, 3), `Δ${grown.toFixed(0)} vs 줄 ${m1.tray?.h.toFixed(0)}`);

  // 20개: 가로로 밀리고, 넘치는 쪽만 흐리다
  {
    const m = await measure(page);
    check("n20: 가로로 밀린다(overflow-x 스크롤, scrollWidth > clientWidth)",
      (m.listOverflowX === "auto" || m.listOverflowX === "scroll") && m.listScrollWidth > m.listClientWidth + 4,
      `overflow-x=${m.listOverflowX} ${m.listScrollWidth}/${m.listClientWidth}`);
    check("n20: 넘치는 쪽 가장자리가 흐리다(mask)", m.listMask !== "" && m.listMask !== "none", m.listMask.slice(0, 60));
    await page.getByTestId("attachment-list-scroll").evaluate((el) => { el.scrollLeft = 0; });
    await wait(200);
    const atStart = await measure(page);
    check("n20: 맨 앞에서는 오른쪽 가장자리만 흐리다(data-fade=end)", atStart.listFade === "end", String(atStart.listFade));
    const wheelBefore = atStart.listScrollLeft ?? 0;
    const list = await page.getByTestId("attachment-list-scroll").boundingBox();
    await page.mouse.move(list.x + list.width / 2, list.y + list.height / 2);
    await page.mouse.wheel(0, 420);
    await wait(250);
    const afterWheel = await measure(page);
    check("n20: 휠(세로)로 줄이 가로로 밀린다", (afterWheel.listScrollLeft ?? 0) > wheelBefore + 40, `${wheelBefore}→${afterWheel.listScrollLeft}`);
    check("n20: 가운데에서는 양쪽 가장자리가 흐리다(data-fade=both)", afterWheel.listFade === "both", String(afterWheel.listFade));
    await page.getByTestId("attachment-list-scroll").evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    await wait(200);
    const end = await measure(page);
    const last = end.cards.at(-1);
    check("n20: 끝까지 밀면 마지막 카드와 그 X 가 줄 안에 다 보인다",
      last !== undefined && last.box.r <= end.list.r + 0.5 && last.removeVisual.r <= end.list.r + 0.5 && last.removeVisual.y >= end.list.y - 0.5,
      last === undefined ? "" : `card.r=${last.box.r.toFixed(0)} X.r=${last.removeVisual.r.toFixed(0)} list.r=${end.list.r.toFixed(0)} X.y=${last.removeVisual.y.toFixed(0)} list.y=${end.list.y.toFixed(0)}`);
    check("n20: 끝에서는 오른쪽 흐림이 걷히고 왼쪽만 흐리다(data-fade=start)", end.listFade === "start", String(end.listFade));
    await shot(page, prefix("n20-scrolled-end"), width);
    await page.getByTestId("attachment-list-scroll").evaluate((el) => { el.scrollLeft = 0; });
  }

  // 스물한 번째: 넘친 수를 짧은 한 줄로
  {
    await addFiles(page, [png("스물한-번째.png", 2)]);
    await wait(500);
    const m = await measure(page);
    check("n21: 20개에서 멈추고 넘친 수 알림이 한 줄이다", m.cards.length === 20 && m.rejected !== null && m.rejected.h <= 28 && /1/.test(m.rejectedText ?? ""),
      `카드 ${m.cards.length} · 알림 h=${m.rejected?.h} "${(m.rejectedText ?? "").trim()}"`);
    check("n21: 알림이 입력창 안, 글 칸 위에 있다", m.rejected !== null && m.frame !== null && m.rejected.y >= m.frame.y && m.input !== null && m.rejected.b <= m.input.y + 1);
    await shot(page, prefix("n21-overflow"), width);
    await page.getByTestId("attachment-rejected").getByRole("button").first().click().catch(() => {});
  }

  // 키보드: 탭 정거장은 하나, X 는 탭에서 빠지고, 카드에서 Delete/Backspace 로 빼면 초점이 옆으로 간다
  {
    const m = await measure(page);
    const stops = m.cards.filter((c) => c.tabIndex === 0).length;
    check("키보드: 카드 줄의 탭 정거장이 정확히 하나다(로빙)", stops === 1, `정거장 ${stops}개`);
    check("키보드: X 단추는 탭 순서에 없다(카드 20개 × 2 정거장 방지)", m.cards.every((c) => c.removeTabIndex === -1), `탭 가능한 X ${m.cards.filter((c) => c.removeTabIndex !== -1).length}개`);
    check("낭독: X 의 이름이 「{파일 이름} 첨부 빼기」다", m.cards.every((c) => /첨부 빼기$/.test(c.removeLabel) && c.removeLabel.replace(/ 첨부 빼기$/, "").trim() !== ""), m.cards[0]?.removeLabel ?? "");

    // 마우스로 카드를 눌러도 초점이 글 칸으로 튕겨 나가지 않는다(그릇의 「빈 면적 클릭」 규칙에서 카드를 뺐다).
    const second = await cards(page).nth(1).boundingBox();
    await page.mouse.click(second.x + second.width / 2, second.y + second.height * 0.6);
    await wait(100);
    let a = await active(page);
    check("마우스로 카드를 눌러도 초점이 글 칸으로 튕기지 않는다(카드에 남는다)", a.onCard && a.cardIndex === 1, JSON.stringify(a));
    // 로빙: 카드에서 Tab 은 줄의 다른 카드가 아니라 줄 밖으로 나간다.
    await page.keyboard.press("Tab");
    await wait(80);
    a = await active(page);
    check("키보드: 카드에서 Tab 은 줄을 한 번에 지나간다(다른 카드로 가지 않는다)", a.cardIndex === -1, JSON.stringify(a));

    await cards(page).nth(2).focus();
    await page.keyboard.press("Delete");
    await wait(120);
    a = await active(page);
    check("키보드: 가운데 카드에서 Delete → 한 장 빠지고 초점이 옆 카드로 간다", a.cardCount === 19 && a.onCard && a.cardIndex === 2, JSON.stringify(a));

    await page.keyboard.press("ArrowRight");
    await wait(80);
    a = await active(page);
    check("키보드: → 로 다음 카드로 간다", a.onCard && a.cardIndex === 3, JSON.stringify(a));
    {
      // 링이 면 **위에** 그려지는가를 픽셀로 잰다(스타일 값이 아니라 화면이 증거다).
      const target = cards(page).nth(3);
      await target.scrollIntoViewIfNeeded();
      await wait(120);
      const box = await target.boundingBox();
      const ring = parseRgb(await target.evaluate((el) => getComputedStyle(el).outlineColor));
      const buffer = await page.screenshot({ clip: { x: box.x - 4, y: box.y - 4, width: box.width + 8, height: box.height + 8 } });
      const edge = await pixelAt(page, buffer, 10, Math.round((4 + box.height / 2) * 2));
      const inner = await pixelAt(page, buffer, 30, Math.round((4 + box.height / 2) * 2));
      check("키보드: 초점을 받은 카드에 링이 면 위로 그려진다(가장자리 픽셀 = 링 색)", ring !== null && closeRgb(edge, ring) && !closeRgb(inner, ring), `edge ${edge} ring ${ring} inner ${inner}`);
      const framed = await measure(page);
      check("키보드: 카드에 초점이 있으면 그릇의 링은 접힌다(링이 두 겹이 되지 않는다)", framed.frameOutline === "none", String(framed.frameOutline));
    }

    await cards(page).nth(18).focus();
    await page.keyboard.press("Backspace");
    await wait(120);
    a = await active(page);
    check("키보드: 마지막 카드에서 Backspace → 앞 카드로 초점이 간다", a.cardCount === 18 && a.onCard && a.cardIndex === 17, JSON.stringify(a));
    await shot(page, prefix("focus-card"), width);

    // 호버: X 는 호버에서만 보인다
    await page.mouse.move(2, 2);
    await wait(120);
    const rest = await measure(page);
    const first = rest.cards[0];
    await cards(page).first().hover();
    await wait(200);
    const hovered = await measure(page);
    check("호버: 가만히 있을 때 X 는 숨고, 카드에 올리면 보인다",
      first.removeOpacity <= 0.05 && hovered.cards[0].removeOpacity >= 0.95, `${first.removeOpacity}→${hovered.cards[0].removeOpacity}`);
    await shot(page, prefix("hover-x"), width);

    // 모두 지우기(넷 이상) 뒤 마지막 한 장까지 키보드로 빼면 초점이 글 칸으로 간다
    const clear = await measure(page);
    check("모두 지우기: 넷 이상에서 보이고 입력창 안에 있다", clear.clear !== null && clear.frame !== null && clear.clear.b <= clear.frame.b && clear.clear.y >= clear.frame.y);
    await page.getByTestId("attachment-clear").click();
    await wait(150);
    check("모두 지우기: 누르면 줄이 사라진다", (await measure(page)).tray === null);
    await addFiles(page, [png("하나만.png", 3)]);
    await waitCount(page, 1);
    await cards(page).first().focus();
    // 방금 마우스(모두 지우기)를 눌렀으므로 모달리티가 pointer 다. 캐럿을 옮기는 키(화살표)가 keyboard 로 올린다.
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Delete");
    await wait(150);
    a = await active(page);
    check("키보드: 하나뿐인 카드를 빼면 초점이 글 칸으로 간다", a.cardCount === 0 && a.testId === "composer-input", JSON.stringify(a));
    const back = await measure(page);
    check("키보드: 글 칸에 초점이 오면 그릇의 링이 다시 선다", back.frameOutline !== "none", String(back.frameOutline));
  }

  // Codex 입력창과 나란히 놓을 한 장: 입력칸 폭을 캡처(약 800px)와 비슷하게 맞추고, 줄을 끝까지 밀어
  // 왼쪽 카드가 경계에서 잘리게 하고, 마지막 카드(영상)에 호버해 × 를 보인다.
  if (width === 1440) {
    await resetTray(page);
    await page.setViewportSize({ width: 1100, height: 900 });
    await wait(300);
    await addFiles(page, [png("화면 1.png", 0), png("화면 2.png", 1), png("화면 3.png", 2), png("화면 4.png", 0), png("화면 5.png", 1), pdf("분기별-온보딩-리뷰-최종-v3.pdf"), video("v1.mp4", 2400)]);
    await waitCount(page, 7);
    await waitSettled(page);
    await page.getByTestId("attachment-list-scroll").evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    await wait(150);
    await cards(page).last().hover();
    await wait(250);
    if (SHOTS) {
      const frame = await page.getByTestId("composer-frame").boundingBox();
      await page.screenshot({ path: join(OUT, `${tag}-compare.png`), clip: { x: frame.x - 16, y: frame.y - 16, width: frame.width + 32, height: frame.height + 32 } });
    }
    await page.setViewportSize({ width, height: 900 });
    await wait(300);
  }

  // 올리는 중: 진짜 바이트 서버로 진행을 보고하게 한다
  {
    await resetTray(page);
    useSink = true;
    await addFiles(page, [png("큰 화면 캡처.png", 2, 3 * 1024 * 1024), video("녹화-온보딩-시연.mp4", 4200), pdf("분기별-온보딩-리뷰-최종-v3.pdf", 1800)]);
    await waitCount(page, 3);
    await page.waitForFunction(() => { const p = document.querySelector('[data-testid="attachment-chip-percent"]'); return p !== null && Number(p.textContent.replace("%", "")) >= 15; }, undefined, { timeout: 20_000 }).catch(() => {});
    const m = await measure(page);
    const bars = await page.locator('[data-testid="attachment-chip-progress"]').count();
    check("올리는 중: 진행 막대가 서 있고 카드가 같은 높이를 지킨다", bars >= 1 && m.cards.every((c) => near(c.box.h, m.cards[0].box.h, 1)), `막대 ${bars}개 · 높이 ${m.cards.map((c) => Math.round(c.box.h)).join("/")}`);
    check("올리는 중: 막힘 안내가 줄 아래에 있다", (m.blockedText ?? "").trim() !== "" && m.blocked !== null && m.input !== null && m.blocked.b <= m.input.y + 1, (m.blockedText ?? "").trim());
    await shot(page, prefix("uploading"), width);
    useSink = false;
  }

  // 실패: 되돌릴 값이 있는 실패(재시도)와 상한을 넘긴 실패(재시도 없음)
  {
    await resetTray(page);
    archive.setCompleteStatus(409);
    await addFiles(page, [png("실패할 화면.png", 0), pdf("분기별-온보딩-리뷰-최종-v3.pdf")]);
    await waitCount(page, 2);
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="attachment-chip"]')].every((c) => c.dataset.attachmentStatus === "failed"), undefined, { timeout: 20_000 });
    await page.evaluate(() => {
      const original = Object.getOwnPropertyDescriptor(Blob.prototype, "size");
      Object.defineProperty(Blob.prototype, "size", {
        configurable: true,
        get() { return this.name === "huge.bin" ? 100 * 1024 * 1024 + 1 : original.get.call(this); },
      });
    });
    await addFiles(page, [{ name: "huge.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(1024) }]);
    await waitCount(page, 3);
    await wait(300);
    const m = await measure(page);
    check("실패: 같은 높이의 카드에 이유가 보이고 X 는 늘 보인다",
      m.cards.every((c) => near(c.box.h, m.cards[0].box.h, 1) && c.removeOpacity >= 0.95), `높이 ${m.cards.map((c) => Math.round(c.box.h)).join("/")} · X opacity ${m.cards.map((c) => c.removeOpacity).join("/")}`);
    check("실패: 되돌릴 값이 있는 두 카드에만 다시 시도가 있다", m.cards[0].retryLabel !== null && m.cards[1].retryLabel !== null && m.cards[2].retryLabel === null, m.cards.map((c) => c.retryLabel ?? "-").join("/"));
    check("실패: 다시 시도 단추 이름이 「다시 시도」다", m.cards[0].retryLabel === null || /다시 시도/.test(m.cards[0].retryLabel ?? ""), m.cards[0].retryLabel ?? "");
    check("실패: 다시 시도가 X·카드 가운데를 안 가리고 카드 안에 있다", m.cards[0].retryBox === null || (m.cards[0].retryBox.x >= m.cards[0].box.x && m.cards[0].retryBox.r <= m.cards[0].box.r && m.cards[0].retryBox.b <= m.cards[0].box.b && !intersects(m.cards[0].retryBox, m.cards[0].remove)));
    check("실패: 막힌 이유가 줄 아래에 있다", m.blocked !== null && (m.blockedText ?? "").trim() !== "", (m.blockedText ?? "").trim());
    await shot(page, prefix("failed"), width);
  }

  await context.close();
}

// ---- 스레드 입력창: 같은 컴포넌트가 그 그릇 안에 선다 -------------------------------------

async function runThread(browser, scheme) {
  const tag = `${scheme}-1440-thread`;
  scope = tag;
  console.log(`\n== ${LABEL} · ${tag} ==`);
  const archive = createArchive();
  archive.releaseAll();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: scheme, locale: "ko-KR", reducedMotion: "reduce" });
  const page = await context.newPage();
  await installRealtimeSocket(page);
  await installRoutes(context, archive, () => false);
  await login(page);
  await openChannel(page);
  const row = page.locator('[data-testid="timeline-message"][data-message-id="0199dddd-0000-7000-8000-000000000002"]');
  await row.hover();
  // 답글은 호버 도구 막대의 단추다: 답글 묶음은 막대에만 서고 ⋯ 메뉴에는 `menu-reply` 가 없다(#5192, `MESSAGE_ACTION_GROUP_PLACEMENT`).
  await row.getByTestId("toolbar-reply").click();
  // 이 단추가 스레드 입력창을 여는 것이 아래 스레드 단정들의 전제다. 안 열리면 시간 초과로 스크립트가 죽지 않고 이 단정이 붉어진다.
  const threadOpened = await page.getByTestId("thread-composer-input").waitFor({ timeout: 15_000 }).then(() => true, () => false);
  check("스레드: 호버 도구 막대의 답글 단추가 스레드 입력창을 연다", threadOpened);
  if (!threadOpened) {
    await context.close();
    return;
  }
  const base = await measure(page, THREAD_IDS);
  await page.locator('[data-testid="thread-composer"] input[type="file"]').first().setInputFiles([png("스레드 캡처.png", 0), png("스레드 화면.png", 1), video("녹화-온보딩-시연.mp4"), pdf("분기별-온보딩-리뷰-최종-v3.pdf")]);
  await waitCount(page, 4);
  await waitSettled(page);
  const m = await measure(page, THREAD_IDS);
  check("스레드: 줄이 스레드 입력창 테두리 안에 서 있다", m.tray !== null && m.frame !== null && m.tray.x >= m.frame.x - 0.5 && m.tray.r <= m.frame.r + 0.5 && m.tray.y >= m.frame.y - 0.5 && m.tray.b <= m.frame.b + 0.5);
  check("스레드: 카드가 한 줄이고 가로로 밀린다", m.cards.every((c) => near(c.box.y, m.cards[0].box.y, 1)) && (m.listScrollWidth ?? 0) > (m.listClientWidth ?? 0), `${m.listScrollWidth}/${m.listClientWidth}`);
  check("스레드: 글 칸이 줄 아래에 있고 입력창이 줄만큼 자란다", m.input !== null && m.tray !== null && m.input.y >= m.tray.b - 1 && near(m.frame.h - base.frame.h, m.tray.h, 3), `Δ${(m.frame.h - base.frame.h).toFixed(0)} 줄 ${m.tray?.h.toFixed(0)}`);
  check("스레드: X 가 작고 그림 가운데를 덮지 않는다", m.cards.every((c) => c.removeVisual !== null && c.removeVisual.w <= 20.5 && !intersects(c.remove, center(c.box, 0.5))));
  await shot(page, `${tag}-n4`, 1440, "thread-composer");
  await cards(page).first().focus();
  await page.keyboard.press("Delete");
  await wait(120);
  let a = await active(page);
  check("스레드: 카드에서 Delete → 초점이 옆 카드로 간다", a.cardCount === 3 && a.onCard && a.cardIndex === 0, JSON.stringify(a));
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Delete");
    await wait(100);
  }
  a = await active(page);
  check("스레드: 마지막 카드까지 빼면 초점이 스레드 글 칸으로 간다", a.cardCount === 0 && a.testId === "thread-composer-input", JSON.stringify(a));
  await context.close();
}

// ---- 터치 기기: X 가 늘 보인다 --------------------------------------------------------

async function runTouch(browser) {
  scope = "touch-390";
  console.log(`\n== ${LABEL} · touch-390 ==`);
  const archive = createArchive();
  archive.releaseAll();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "ko-KR", reducedMotion: "reduce" });
  const page = await context.newPage();
  await installRealtimeSocket(page);
  await installRoutes(context, archive, () => false);
  await login(page);
  await openChannel(page).catch(async () => { await page.getByTestId("composer-input").waitFor({ timeout: 15_000 }); });
  await addFiles(page, [png("터치 캡처.png", 0), pdf("분기별-온보딩-리뷰-최종-v3.pdf")]);
  await waitCount(page, 2);
  await waitSettled(page);
  const hover = await page.evaluate(() => matchMedia("(hover: none)").matches);
  const m = await measure(page);
  check("터치: (hover: none) 에서 X 가 늘 보인다", hover && m.cards.every((c) => c.removeOpacity >= 0.95), `hover:none=${hover} opacity ${m.cards.map((c) => c.removeOpacity).join("/")}`);
  check("터치: 줄이 입력창 안에 선다", m.tray !== null && m.frame !== null && m.tray.y >= m.frame.y && m.tray.b <= m.frame.b + 0.5);
  await shot(page, "touch-390-n2", 390);
  await context.close();
}

// ---- main ---------------------------------------------------------------------

mkdirSync(OUT, { recursive: true });
const staticServer = await startStatic();
const sinkServer = await startByteSink();
const browser = await (ENGINE === "webkit" ? webkit : chromium).launch({ headless: true });
let crashed = null;
try {
  for (const scheme of ["light", "dark"]) {
    for (const width of [1440, 720]) {
      if (wanted(`${scheme}-${width}`)) await runCombo(browser, { scheme, width });
    }
  }
  if (wanted("touch")) await runTouch(browser);
  for (const scheme of ["light", "dark"]) if (wanted(`thread-${scheme}`)) await runThread(browser, scheme);
} catch (error) {
  crashed = error;
  console.error(`\nSCRIPT ERROR: ${error?.stack ?? error}`);
} finally {
  await browser.close();
  await new Promise((done) => staticServer.close(done));
  await new Promise((done) => sinkServer.close(done));
}

const failed = results.filter((r) => !r.ok);
const byId = new Map();
for (const r of results) {
  const entry = byId.get(r.id) ?? { pass: 0, fail: 0 };
  if (r.ok) entry.pass += 1;
  else entry.fail += 1;
  byId.set(r.id, entry);
}
console.log(`\n== 요약 (${LABEL}) ==`);
console.log(`단정 ${results.length}건 · 통과 ${results.length - failed.length} · 실패 ${failed.length}`);
for (const [id, entry] of byId) {
  if (entry.fail > 0) console.log(`  RED  ${id}  (실패 ${entry.fail}/${entry.pass + entry.fail})`);
}
writeFileSync(join(OUT, "results.json"), JSON.stringify({ label: LABEL, dist: DIST, results }, null, 2));
if (crashed !== null) process.exitCode = 2;
else if (failed.length > 0 && !SOFT) process.exitCode = 1;
