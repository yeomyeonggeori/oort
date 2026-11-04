#!/usr/bin/env node
// =============================================================================
// 보내지 못한 메시지·첨부의 아이콘 둘 (#5210): 새로고침(다시 보내기) · 빨간 X(지우기).
// 모양·키보드·동작을 재고, 라이트·다크 × 720·1440(+ 좁은 웹 390)으로 찍는다.
//
//   npm run build && node scripts/capture-5210.mjs --label after --out <스크래치>/cap5210
//   node scripts/capture-5210.mjs --dist <옛 빌드> --label before --soft     # 고치기 전 번들에서 RED
//
// 번들 Chromium 헤드리스 + 모의 `/v1`(시크릿 없음, 인물은 전부 가상)이다. 정적 서버·바이트 받이는 이 파일이 직접 띄우고
// 자기 PID 로만 끈다. 모의 서버는 전송(`POST …/messages`)을 `fail`(500) 또는 `ok`(저장하고 메시지를 돌려줌)로 돌린다.
// 단정은 구현 이름이 아니라 **상자와 요청**을 잰다: 아이콘 상자 크기·글리프·겹침, X 를 누른 뒤 줄이 사라지고 **서버로 나간
// 요청이 하나도 없는지**, 새로고침이 **같은 멱등키로** 나가 한 메시지로 모이는지. 그래서 같은 스크립트가 옛 빌드에서는
// 빨갛고 새 빌드에서는 초록이다.
//
// 옵션: --dist(기본 dist) --out(기본 captures/5210/<label>) --label(기본 after) --port(기본 5521)
//       --soft(실패해도 끝까지 돌고 종료 코드 0) --no-shots
//       --combos(쉼표 목록: light-1440,dark-1440,light-720,dark-720,light-390. 기본 전부)
//       --engine(chromium 기본 | webkit)
// 캡처는 저장소에 올리지 않는다: --out 을 스크래치로 준다.
// =============================================================================
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// 못 보낸 줄의 원인 문장(#5221·#5249)은 한국어 사전(connection.json)에서 읽는다: 손으로 적으면 이 캡처가 문장이 고쳐지는 것을 막는 쪽이 된다
// (capture-5239 와 같은 규칙). 이 모의 서버의 실패는 코드 없는 500 — 서버가 직접 답하고 거절한 것이라 분류는 `rejected` 다
// (`causeOfFailure`: 코드 없는 502·504·503 과 응답 없음만 「서버에 닿지 못함」).
const KO_CONNECTION = JSON.parse(
  readFileSync(resolve(WEB_ROOT, "../../packages/momo-core/src/i18n/catalogs/ko-KR/connection.json"), "utf8")
);
const REJECTED_REASON = KO_CONNECTION["connection.send.reasonRejected"];
if (typeof REJECTED_REASON !== "string" || REJECTED_REASON === "") throw new Error("한국어 사전에 connection.send.reasonRejected 가 없다");

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  if (at < 0) return fallback;
  const next = process.argv[at + 1];
  return next === undefined || next.startsWith("--") ? true : next;
}

const LABEL = String(arg("label", "after"));
const DIST = resolve(WEB_ROOT, String(arg("dist", "dist")));
const OUT = resolve(WEB_ROOT, String(arg("out", `captures/5210/${LABEL}`)));
const PORT = Number(arg("port", 5521));
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
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${id}${detail === "" ? "" : `  (${detail})`}`);
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

// ---- 정적 서버 · 바이트 받이 (자기 PID 로만 끈다) ------------------------------------

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

/** 인터셉트되지 않는 진짜 업로드 목적지(첨부 올리기 PUT 을 받는다). */
function startByteSink() {
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "PUT, OPTIONS",
    "access-control-allow-headers": "content-type",
  };
  const server = createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors).end();
      return;
    }
    req.resume();
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
  member: { id: memberId, workspaceId, kind: "human", displayName: "박서연", handle: "seoyeon" },
  realtimeWebSocketUrl: "ws://capture-5210.invalid/connection/websocket",
};

const person = (over) => ({
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
  person({ id: memberId, kind: "human", role: "owner", displayName: "박서연", handle: "seoyeon" }),
  person({ id: peerId, kind: "human", displayName: "이도현", handle: "dohyun" }),
];
const channels = [{ id: channelA, workspaceId, kind: "public", name: "release-2026-11", topic: "11월 릴리스 준비", muted: false }];

const AT = Date.now() - 3_600_000;
const row = (id, seq, author, body, createdAtMs) => ({
  id: `0199dddd-0000-7000-8000-0000000000${id}`,
  channelId: channelA,
  seq,
  hlcTs: createdAtMs,
  hlcCount: 0,
  authorMemberId: author,
  type: "text",
  body,
  state: "sent",
  createdAtMs,
});
const history = () => [
  row("01", 100, peerId, "스테이징 배포 끝났어요. 체크리스트 한 번만 같이 봐 주세요.", AT),
  row("02", 101, memberId, "확인했어요. 롤백 계획은 문서에 있어요.", AT + 60_000),
  row("03", 102, peerId, "금요일 배포 공지 초안이에요. 이대로 올려도 될까요?", AT + 120_000),
];

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** 페이지 하나가 가지는 모의 서버 상태: 전송 방식, 받은 전송 요청, 저장된 메시지. */
function makeServerState() {
  return { mode: "fail", posts: [], stored: [], nextSeq: 200, mutating: [] };
}

async function installRoutes(context, state) {
  await context.route("**/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (method !== "GET") state.mutating.push({ at: Date.now(), method, path });
    if (path === "/v1/auth/login") return json(route, session);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: session.accessToken, refreshToken: session.refreshToken });
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId });
    }
    if (path.endsWith("/agent-dm-delivery")) return json(route, { agentMemberId: peerId, ownerMemberId: memberId, state: "open" });
    if (/\/inbox(\/|$)/.test(path)) return json(route, { items: [], nextCursor: null, unreadCount: 0, approvalsPending: 0 });
    if (path.endsWith("/agent-runs/progress")) return json(route, { runs: [] });
    if (path.endsWith("/hosted-agent-connections") && method === "GET") return json(route, { connections: [] });
    if (path.endsWith("/allowed-models")) return json(route, { allowedAgentModels: [] });
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/read-state") && method === "GET") {
      return json(route, { read_states: channels.map((c) => ({ channel_id: c.id, last_read_seq: 999, latest_seq: 999, unread_count: 0, mention_count: 0, marked_unread_before_seq: null })) });
    }
    if (path.endsWith("/approvals")) return json(route, { approvals: [] });
    if (path.endsWith("/agent-runs")) return json(route, { runs: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null, participants: [] });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: [] });
    if (path.endsWith("/work-sessions/shared")) return json(route, { sessions: [], nextCursor: null });
    if (path.endsWith("/work-sessions")) return json(route, { workSessions: [] });
    if (path.endsWith("/reminders")) return json(route, { reminders: [] });
    if (path.endsWith("/scheduled-messages")) return json(route, { scheduledMessages: [] });
    if (path.endsWith("/presence")) return json(route, { statuses: [] });
    if (path.endsWith("/webhooks")) return json(route, { installations: [] });
    if (path.endsWith("/event-subscriptions")) return json(route, { eventSubscriptions: [] });
    if (path.endsWith("/pins")) return json(route, { pins: [] });
    if (path.endsWith("/attachments/uploads")) {
      const body = JSON.parse(request.postData() ?? "{}");
      return json(
        route,
        {
          id: `0199eeee-0000-7000-8000-${String(Math.floor(Math.random() * 1e12)).padStart(12, "0")}`,
          status: "pending",
          uploadUrl: `http://127.0.0.1:${SINK_PORT}/upload/${encodeURIComponent(body.name)}`,
        },
        201
      );
    }
    if (path.endsWith("/complete")) {
      return json(route, { id: "0199eeee-0000-7000-8000-0000000000aa", channelId: channelA, uploaderMemberId: memberId, name: "x", mime: "application/octet-stream", size: 1, status: "complete", createdAtMs: Date.now() });
    }
    if (path.endsWith(`/channels/${channelA}/messages`) && method === "POST") {
      const body = JSON.parse(request.postData() ?? "{}");
      state.posts.push({ clientMsgId: body.clientMsgId, body: body.body, attachmentIds: body.attachmentIds ?? [] });
      if (state.mode === "fail") return json(route, { error: { message: "capture: upstream unavailable" } }, 500);
      const seq = state.nextSeq++;
      const stored = {
        ...row(String(seq), seq, memberId, body.body ?? "", Date.now()),
        id: `0199ffff-0000-7000-8000-${String(seq).padStart(12, "0")}`,
      };
      state.stored.push(stored);
      return json(route, stored, 201);
    }
    if (path.includes("/messages")) {
      const url = new URL(request.url());
      if (url.searchParams.has("after") || url.searchParams.has("before")) return json(route, { messages: [] });
      return json(route, { messages: [...history(), ...state.stored] });
    }
    return json(route, {});
  });
}

/** 가짜 소켓(구독만 받는다) + 데스크탑 셸 흉내(네이티브 호출은 가짜가 받는다). */
async function installPage(page) {
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
          if (c.connect) return { id: c.id, connect: { client: "5210-capture", version: "6" } };
          if (c.subscribe) return { id: c.id, subscribe: { recoverable: true, positioned: true, recovered: false, epoch: "cap", offset: 0 } };
          return { id: c.id };
        });
        queueMicrotask(() => this.onmessage?.(new MessageEvent("message", { data: replies.map((r) => JSON.stringify(r)).join("\n") })));
      }
      close() { this.readyState = 3; this.onclose?.(new CloseEvent("close", { code: 1000 })); }
    }
    window.WebSocket = CaptureSocket;
    let n = 0;
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
      transformCallback: () => ++n, unregisterCallback: () => {}, convertFileSrc: (p) => p,
      invoke: async (cmd) => {
        if (cmd === "keychain_available") return false;
        if (cmd === "plugin:event|listen") return ++n;
        if (cmd === "plugin:window|is_fullscreen") return false;
        return null;
      },
    };
    Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
  });
}

// ---- 페이지 조작 ----------------------------------------------------------------

async function open(browser, scheme, width, height) {
  const state = makeServerState();
  const context = await browser.newContext({
    viewport: { width, height }, colorScheme: scheme, reducedMotion: "reduce", serviceWorkers: "block",
    deviceScaleFactor: 2, locale: "ko-KR", timezoneId: "Asia/Seoul",
  });
  await installRoutes(context, state);
  const page = await context.newPage();
  await installPage(page);
  await page.addInitScript(
    ({ server, stored, record }) => {
      try {
        localStorage.setItem("momo.web.server.v1", server);
        localStorage.setItem("momo.web.session.v1", JSON.stringify(stored));
        localStorage.setItem("momo.web.appearance.v2", JSON.stringify(record));
      } catch { /* 저장소 없는 캡처 */ }
    },
    {
      server: ORIGIN,
      stored: { refreshToken: session.refreshToken, realtimeWebSocketUrl: session.realtimeWebSocketUrl, member: session.member },
      record: { v: 2, scheme, theme: "dawnsky", signal: null, density: "comfortable", glass: { on: false } },
    }
  );
  await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
  await page.evaluate((id) => { window.location.hash = `#/c/${id}`; }, channelA);
  await page.getByTestId("composer-input").waitFor({ timeout: 20_000 });
  await page.locator('[data-testid="timeline-message"]').first().waitFor({ timeout: 20_000 });
  await wait(400);
  return { context, page, state };
}

const pendingRows = (page) => page.locator('[data-testid="timeline-pending"]');
const failedRows = (page) => page.locator('[data-testid="timeline-pending"][data-status="failed"]');

async function sendText(page, body) {
  const input = page.getByTestId("composer-input");
  await input.click();
  await input.fill(body);
  await page.getByTestId("composer-send").click();
}

const pdf = (name, kb) => ({ name, mimeType: "application/pdf", buffer: Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(kb * 1024, 32)]) });

async function attachAndSend(page, files, body) {
  await page.locator('[data-testid="composer"] input[type="file"]').first().setInputFiles(files);
  await page.waitForFunction(
    (count) => {
      const list = [...document.querySelectorAll('[data-testid="attachment-chip"]')];
      return list.length === count && list.every((c) => c.dataset.attachmentStatus === "uploaded");
    },
    files.length,
    { timeout: 30_000 }
  );
  if (body !== "") await page.getByTestId("composer-input").fill(body);
  await page.getByTestId("composer-send").click();
}

async function waitFailed(page, count = 1) {
  await page.waitForFunction(
    (n) => document.querySelectorAll('[data-testid="timeline-pending"][data-status="failed"]').length === n,
    count,
    { timeout: 10_000 }
  );
  await wait(250);
}

/**
 * 클릭 뒤에 나간 변경(비 GET) 요청의 목록. 「메시지 호출」은 `/messages` 를 건드리거나 DELETE 인 것이다.
 * WebKit 은 클릭이 창 초점 이벤트를 일으켜 현재 보는 방 하트비트(`PUT …/viewing`)를 보낸다 — 메시지와 무관해서 목록에만 남긴다.
 */
function requestsSince(state, index) {
  return state.mutating.slice(index).map((r) => `${r.method} ${r.path.replace(workspaceId, "<ws>").replace(channelA, "<ch>")}`);
}
const messageCalls = (list) => list.filter((line) => /\/messages(\/|$)/.test(line) || line.startsWith("DELETE "));

async function pendingCount(page) {
  return page.evaluate(() => window.__spike?.pending ?? -1);
}

/** 실패 행을 스크롤러 아래쪽에서 잘 보이게 두고 아이콘·줄의 상자와 색을 잰다. */
async function measureFailure(page) {
  return page.evaluate(() => {
    const rect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
    };
    const rowEl = document.querySelector('[data-testid="timeline-pending"][data-status="failed"]');
    const line = rowEl?.querySelector('[data-testid="pending-failed"]');
    const reason = rowEl?.querySelector('[data-testid="pending-failed-reason"]');
    const resend = rowEl?.querySelector('[data-testid="pending-resend"]');
    const discard = rowEl?.querySelector('[data-testid="pending-discard"]');
    const glyph = (el) => rect(el?.querySelector("svg"));
    const color = (el) => (el ? getComputedStyle(el).color : null);
    const scroller = document.querySelector("[data-virtuoso-scroller]");
    return {
      rowBox: rect(rowEl),
      lineBox: rect(line),
      lineText: line?.textContent ?? null,
      reasonKind: reason?.getAttribute("data-failure-kind") ?? null,
      lineOverflowX: line ? line.scrollWidth - line.clientWidth : null,
      resendBox: rect(resend),
      discardBox: rect(discard),
      resendGlyph: glyph(resend),
      discardGlyph: glyph(discard),
      resendLabel: resend?.getAttribute("aria-label") ?? null,
      discardLabel: discard?.getAttribute("aria-label") ?? null,
      resendTitle: resend?.getAttribute("title") ?? null,
      discardTitle: discard?.getAttribute("title") ?? null,
      resendText: resend?.textContent ?? null,
      discardText: discard?.textContent ?? null,
      resendColor: color(resend),
      discardColor: color(discard),
      lineColor: color(line),
      attachmentCards: rowEl ? rowEl.querySelectorAll('[data-testid="attachment-card"]').length : 0,
      attachmentList: rowEl ? Boolean(rowEl.querySelector('[data-testid="attachment-list"]')) : false,
      scroller: rect(scroller),
      viewport: { w: window.innerWidth, h: window.innerHeight },
    };
  });
}

function checkShape(m, width) {
  const minHit = width < 600 ? 44 : 24;
  const inside = (box) =>
    box !== null && box.x >= 0 && box.y >= 0 && box.right <= m.viewport.w + 0.5 && box.bottom <= m.viewport.h + 0.5;
  // 줄의 글자는 원인 한 문장뿐이다: 분류(rejected)와 사전의 그 문장이 그대로 서고, 상태 코드·서버 원문("capture: upstream unavailable")·옛 「전송 실패」는 없다.
  // 아이콘 단추에는 글자가 없어(아래 icons 단정) 줄 전체의 글자 = 문장이다.
  check("failure-line: 글자는 원인 한 문장뿐이다(코드 없는 500 → rejected, 사전 문장)", m.lineText === REJECTED_REASON && m.reasonKind === "rejected", JSON.stringify([m.lineText, m.reasonKind]));
  check("icons: 새로고침과 X 가 둘 다 서 있다", m.resendBox !== null && m.discardBox !== null);
  if (m.resendBox === null || m.discardBox === null) return;
  check("icons: 글자 단추가 아니다(단추 안에 글자 없음)", m.resendText === "" && m.discardText === "", `${JSON.stringify(m.resendText)} ${JSON.stringify(m.discardText)}`);
  check("icons: 낭독 이름 「다시 보내기」·「지우기」", m.resendLabel === "다시 보내기" && m.discardLabel === "지우기", `${m.resendLabel} / ${m.discardLabel}`);
  check("icons: 네이티브 title 을 쓰지 않는다(툴팁이 따로 있다)", m.resendTitle === null && m.discardTitle === null);
  check(`hit-area: 누르는 면 ≥ ${minHit}px (두 아이콘)`, [m.resendBox, m.discardBox].every((b) => b.w >= minHit - 0.5 && b.h >= minHit - 0.5), `${m.resendBox.w}x${m.resendBox.h} ${m.discardBox.w}x${m.discardBox.h}`);
  check("glyph: 눈에 보이는 글리프 16×16", [m.resendGlyph, m.discardGlyph].every((g) => g && Math.abs(g.w - 16) < 0.6 && Math.abs(g.h - 16) < 0.6), `${m.resendGlyph?.w} ${m.discardGlyph?.w}`);
  check("layout: 두 아이콘이 겹치지 않는다", m.resendBox.right <= m.discardBox.x + 0.5 || m.discardBox.right <= m.resendBox.x + 0.5);
  check("layout: 두 아이콘이 화면 안에 있다", inside(m.resendBox) && inside(m.discardBox));
  check("layout: 실패 줄이 가로로 넘치지 않는다", (m.lineOverflowX ?? 0) <= 1, String(m.lineOverflowX));
  check("hierarchy: X 만 위험색이고 다시 보내기는 다른 색이다", m.discardColor === m.lineColor && m.resendColor !== m.discardColor, `${m.resendColor} | ${m.discardColor} | ${m.lineColor}`);
}

/** 키보드: 새로고침 → X 순서로 초점이 가고 둘 다 보이는 초점 고리가 선다. */
async function checkKeyboard(page) {
  if (ENGINE === "webkit") {
    console.log("  [SKIP] keyboard: macOS WebKit 의 Tab 은 단추를 건너뛴다(기본 설정, 앱 전체가 같다). 초점 순서는 Chromium 레인이 잰다");
    return;
  }
  await page.getByTestId("pending-resend").focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  const first = await page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? null);
  const ringFirst = await page.evaluate(() => {
    const el = document.activeElement;
    return el ? getComputedStyle(el).outlineStyle !== "none" && parseFloat(getComputedStyle(el).outlineWidth) >= 1.5 : false;
  });
  await page.keyboard.press("Tab");
  const second = await page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? null);
  const ringSecond = await page.evaluate(() => {
    const el = document.activeElement;
    return el ? getComputedStyle(el).outlineStyle !== "none" && parseFloat(getComputedStyle(el).outlineWidth) >= 1.5 : false;
  });
  check("keyboard: Tab 순서는 새로고침 → X", first === "pending-resend" && second === "pending-discard", `${first} → ${second}`);
  check("keyboard: 두 아이콘 모두 보이는 초점 고리", ringFirst && ringSecond, `${ringFirst} ${ringSecond}`);
}

async function checkTooltip(page) {
  if ((await page.getByTestId("pending-discard").count()) === 0) {
    check("tooltip: X 위에서 「지우기」가 뜬다(≤ 400ms)", false, "X 가 없다");
    return false;
  }
  await page.mouse.move(2, 2);
  await wait(250);
  const box = await page.getByTestId("pending-discard").boundingBox();
  if (box === null) return check("tooltip: X 위에서 이름이 뜬다", false, "no box");
  const startedAt = Date.now();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const tip = page.locator('[data-testid="tooltip"]').first();
  const shown = await tip.waitFor({ state: "visible", timeout: 1500 }).then(() => true, () => false);
  const took = Date.now() - startedAt;
  const text = shown ? await tip.textContent() : null;
  check("tooltip: X 위에서 「지우기」가 뜬다(≤ 400ms)", shown && text === "지우기" && took <= 400, `${text} ${took}ms`);
  return shown;
}

/** 실패 줄이 보이도록 행 가까이를 잘라 크게 찍는다(owner 에게 보여 줄 장면). */
async function shoot(page, name) {
  if (!SHOTS) return;
  mkdirSync(OUT, { recursive: true });
  await page.locator('[data-testid="timeline-pending"]').first().scrollIntoViewIfNeeded();
  await wait(150);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  const box = await page.locator('[data-testid="timeline-pending"]').first().boundingBox();
  if (box === null) return;
  const viewport = page.viewportSize();
  const top = Math.max(0, Math.floor(box.y - 150));
  const height = Math.min(viewport.height - top, Math.ceil(box.height + 300));
  const width = Math.min(viewport.width, 1000);
  await page.screenshot({ path: join(OUT, `${name}-zoom.png`), clip: { x: 0, y: top, width, height } });
}

// ---- 장면 ---------------------------------------------------------------------

async function sceneTextFailure(browser, combo, scheme, width, height, extra) {
  scope = `${combo} 텍스트 실패`;
  console.log(`\n== ${scope}`);
  const { context, page, state } = await open(browser, scheme, width, height);
  try {
    state.mode = "fail";
    await sendText(page, "금요일 배포 공지 초안 올렸어요. 라이트와 다크 둘 다 확인 부탁해요.");
    await waitFailed(page);
    check("failed-row: 보내지 못하면 그 자리에 실패 행이 선다", (await failedRows(page).count()) === 1);
    const m = await measureFailure(page);
    checkShape(m, width);
    await checkKeyboard(page);
    // 키보드 검사가 남긴 초점 고리를 걷고 찍는다: owner 에게 보여 줄 사진에 시험의 흔적이 남지 않게.
    await page.evaluate(() => document.activeElement?.blur());
    await page.mouse.move(2, 2);
    await shoot(page, `text-failed-${combo}`);
    if (extra) {
      const shown = await checkTooltip(page);
      if (shown && SHOTS) {
        const box = await page.locator('[data-testid="timeline-pending"]').first().boundingBox();
        if (box !== null) {
          const viewport = page.viewportSize();
          const top = Math.max(0, Math.floor(box.y - 150));
          await page.screenshot({ path: join(OUT, `text-failed-${combo}-tooltip-zoom.png`), clip: { x: 0, y: top, width: Math.min(viewport.width, 1000), height: Math.min(viewport.height - top, Math.ceil(box.height + 300)) } });
        }
      }
      await page.mouse.move(2, 2);
      await wait(200);
    }

    // X: 줄이 사라지고, 서버로 나간 요청은 하나도 없다.
    if ((await page.getByTestId("pending-discard").count()) === 0) {
      check("discard: X 가 있다", false, "pending-discard 없음");
      return;
    }
    const postsBefore = state.posts.length;
    const mutatingBefore = state.mutating.length;
    await page.getByTestId("pending-discard").click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="timeline-pending"]').length === 0, undefined, { timeout: 5000 }).catch(() => undefined);
    await wait(900);
    check("discard: X 를 누르면 실패 행이 사라진다", (await pendingRows(page).count()) === 0);
    check("discard: 대기 목록도 비었다(__spike.pending 0)", (await pendingCount(page)) === 0, String(await pendingCount(page)));
    const sinceClick = requestsSince(state, mutatingBefore);
    check("discard: 서버 호출 없음(메시지 전송·삭제 요청 0건)", state.posts.length === postsBefore && messageCalls(sinceClick).length === 0, `posts ${postsBefore}→${state.posts.length}, 클릭 뒤 변경 요청 ${JSON.stringify(sinceClick)}`);
    const stillThere = await page.locator('[data-testid="timeline-message"]', { hasText: "금요일 배포 공지 초안 올렸어요" }).count();
    check("discard: 확정 메시지로 되살아나지 않는다", stillThere === 0, String(stillThere));
  } finally {
    await context.close();
  }
}

async function sceneResendConverges(browser, combo, scheme, width, height) {
  scope = `${combo} 새로고침`;
  console.log(`\n== ${scope}`);
  const { context, page, state } = await open(browser, scheme, width, height);
  try {
    const body = "다시 보내면 한 메시지로 모여야 해요";
    state.mode = "fail";
    await sendText(page, body);
    await waitFailed(page);
    state.mode = "ok";
    await page.getByTestId("pending-resend").click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="timeline-pending"]').length === 0, undefined, { timeout: 8000 }).catch(() => undefined);
    await wait(500);
    const shown = await page.locator('[data-testid="timeline-message"]', { hasText: body }).count();
    check("resend: 실패 행이 사라지고 확정 메시지가 정확히 하나다", (await pendingRows(page).count()) === 0 && shown === 1, `pending ${await pendingRows(page).count()}, messages ${shown}`);
    check("resend: 전송 요청은 둘이고 같은 멱등키다", state.posts.length === 2 && state.posts[0].clientMsgId === state.posts[1].clientMsgId && Boolean(state.posts[0].clientMsgId), JSON.stringify(state.posts.map((p) => p.clientMsgId)));
    check("resend: 서버에는 한 줄만 저장됐다", state.stored.length === 1, String(state.stored.length));
  } finally {
    await context.close();
  }
}

async function sceneAttachmentFailure(browser, combo, scheme, width, height) {
  scope = `${combo} 첨부 실패`;
  console.log(`\n== ${scope}`);
  const { context, page, state } = await open(browser, scheme, width, height);
  try {
    state.mode = "fail";
    await attachAndSend(page, [pdf("견적서-2026-11.pdf", 182), pdf("회의록-1102.pdf", 64)], "견적서와 회의록 같이 보내요");
    await waitFailed(page);
    const m = await measureFailure(page);
    check("attachment: 첨부가 든 메시지가 실패해도 파일 카드가 보인다", m.attachmentList && m.attachmentCards === 2, `list ${m.attachmentList} cards ${m.attachmentCards}`);
    checkShape(m, width);
    check("attachment: 첨부 id 를 싣고 나간 요청이었다", state.posts.length === 1 && state.posts[0].attachmentIds.length === 2, JSON.stringify(state.posts[0]?.attachmentIds));
    await page.mouse.move(2, 2);
    await shoot(page, `attachment-failed-${combo}`);

    if ((await page.getByTestId("pending-discard").count()) === 0) {
      check("attachment: X 가 있다", false, "pending-discard 없음");
      return;
    }
    const mutatingBefore = state.mutating.length;
    await page.getByTestId("pending-discard").click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="timeline-pending"]').length === 0, undefined, { timeout: 5000 }).catch(() => undefined);
    await wait(900);
    check("attachment: X 가 글과 파일 카드를 한 번에 지운다", (await pendingRows(page).count()) === 0);
    const sinceAttachmentClick = requestsSince(state, mutatingBefore);
    check("attachment: 지우기에 서버 호출이 없다(메시지 전송·삭제 요청 0건)", messageCalls(sinceAttachmentClick).length === 0, `클릭 뒤 변경 요청 ${JSON.stringify(sinceAttachmentClick)}`);
  } finally {
    await context.close();
  }
}

// ---- 실행 ---------------------------------------------------------------------

const COMBO_TABLE = {
  "light-1440": ["light", 1440, 900],
  "dark-1440": ["dark", 1440, 900],
  "light-720": ["light", 720, 900],
  "dark-720": ["dark", 720, 900],
  "light-390": ["light", 390, 844],
};

async function main() {
  if (!existsSync(join(DIST, "index.html"))) throw new Error(`빌드가 없다: ${DIST} (npm run build 먼저)`);
  const servers = [await startStatic(), await startByteSink()];
  const browser = await (ENGINE === "webkit" ? webkit : chromium).launch();
  try {
    let first = true;
    for (const [combo, [scheme, width, height]] of Object.entries(COMBO_TABLE)) {
      if (!wanted(combo)) continue;
      await sceneTextFailure(browser, combo, scheme, width, height, first || combo === "dark-720");
      await sceneAttachmentFailure(browser, combo, scheme, width, height);
      if (first || combo === "dark-720") await sceneResendConverges(browser, combo, scheme, width, height);
      first = false;
    }
  } finally {
    await browser.close();
    for (const server of servers) server.close();
  }
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "results.json"), `${JSON.stringify({ label: LABEL, engine: ENGINE, results }, null, 2)}\n`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} PASS${failed.length > 0 ? `, ${failed.length} FAIL` : ""}  (label ${LABEL}, engine ${ENGINE})`);
  if (failed.length > 0 && !SOFT) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
