#!/usr/bin/env node
// =============================================================================
// 남은 「불러오지 못했습니다」 자리들 (#5242, #5221 후속): 사이드바 채널 목록의 원인 상자·한 줄과 대표 두 자리(받은함 목록 = 상자,
// 설정 알림 규칙 = 원인 한 줄)를 라이트·다크 × 390·720·1440으로 찍고 **화면의 문장과 서버로 나간 요청**을 잰다.
//
//   npm run build && node scripts/capture-5242.mjs --label after --out <스크래치>/cap5242
//
// 번들 Chromium 헤드리스 + 모의 `/v1`(시크릿 없음, 인물은 전부 가상). 정적 서버는 이 파일이 직접 띄우고 자기 PID 로만 끈다.
// 단정은 구현 이름이 아니라 **화면의 문장**을 잰다: 제목 + 원인 이유가 나오는가, 상태 코드가 한 글자도 없는가, 옛 「…불러오지
// 못했습니다」 문장이 없는가, 다시 시도가 그 자리의 읽기를 다시 부르고 풀리는가.
//
// #5306 (화면 검수 5b M2): 시트·회색 띠 위에 서는 불러오기 실패의 「다시 시도」 알약이 시트와 같은 색이라 글자로만 읽히던 일(라이트 1.009:1)을
// **그려진 픽셀**로 잰다(「단추 그릇 ↔ 바탕 대비」). 사이드바 상자·한 줄은 시트 위 문법(`--surface` 알약 + rest 그림자)으로 서야 하고, 그 기준은 같은
// 사이드바 빈 상태의 「채널 만들기」다: 같은 조합에서 그 알약을 먼저 찍어 두고 「다시 시도」의 채움 색이 같은지, 그리고 바탕과의 대비가 바닥을 넘는지 잰다.
// 본문 판(받은함) 위의 같은 상자는 보조 채움 그대로 읽혀야 한다. 사진에서 읽은 값(알약·바탕 색, 대비)은 결과 장부(results.json)에 남는다.
//
// 옵션: --dist(기본 dist) --out(기본 captures/5242/<label>) --label(기본 after) --port(기본 5542)
//       --soft(실패해도 끝까지 돌고 종료 코드 0) --no-shots --engine(chromium 기본 | webkit: 데스크탑 셸이 WKWebView 라 두 엔진으로 잰다)
//       --combos(light-390,dark-390,light-720,dark-720,light-1440,dark-1440. 기본 전부. 390 은 사이드바가 서랍이라 열고 잰다)
// 캡처는 저장소에 올리지 않는다: --out 을 스크래치로 준다.
// =============================================================================
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { chromium, webkit } from "playwright";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  if (at < 0) return fallback;
  const next = process.argv[at + 1];
  return next === undefined || next.startsWith("--") ? true : next;
}

const LABEL = String(arg("label", "after"));
const DIST = resolve(WEB_ROOT, String(arg("dist", "dist")));
const OUT = resolve(WEB_ROOT, String(arg("out", `captures/5242/${LABEL}`)));
const PORT = Number(arg("port", 5542));
const SOFT = arg("soft", false) === true;
const SHOTS = arg("no-shots", false) !== true;
const ENGINE = String(arg("engine", "chromium"));
// 390 은 사이드바가 서랍(폭 600 미만), 720·1440 은 셸 바닥 위에 서는 열이다. 알약의 바탕이 서랍 시트냐 셸 바닥이냐가 달라 셋 다 잰다(#5306).
const COMBO_SIZES = {
  "light-390": ["light", 390, 844],
  "dark-390": ["dark", 390, 844],
  "light-720": ["light", 720, 900],
  "dark-720": ["dark", 720, 900],
  "light-1440": ["light", 1440, 900],
  "dark-1440": ["dark", 1440, 900],
};
const COMBOS = String(arg("combos", Object.keys(COMBO_SIZES).join(","))).split(",");
const ORIGIN = `http://127.0.0.1:${PORT}`;
/** 폭 600 미만에서 사이드바는 본문 위를 덮는 서랍이다(tokens.css `sidebar-drawer`). */
const isPhoneWidth = (width) => width < 600;

// ---- 결과 장부 ---------------------------------------------------------------

const results = [];
let scope = "";
function check(id, ok, detail = "") {
  results.push({ scope, id, ok: Boolean(ok), detail });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${id}${detail === "" ? "" : `  (${String(detail).slice(0, 160)})`}`);
}
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const hasStatusCode = (text) => /(^|[^\d])\d{3}([^\d]|$)/.test(text);

// ---- 그려진 픽셀 재기 (#5306) ---------------------------------------------------------
// `getComputedStyle` 은 띠·테마가 `--surface` 같은 역할 변수를 다시 묶는 길(tokens.css 「띠 위의 글자」)과 `color-mix`·`light-dark` 를 거치므로
// 실제로 그려진 색을 말하지 않는다. 그래서 스크린샷의 1x1 clip 을 풀어 읽는다(capture-5190.mjs 와 같은 복호기, 캔버스 흉내 없음).

/** PNG(8비트 RGB·RGBA, 비인터레이스)를 푼다. 스크린샷 clip 전용이라 이 모양만 안다. */
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

/**
 * 「단추 그릇 ↔ 바탕」: 알약 안 한 점과 그 오른쪽 바깥 바탕 한 점의 상대 휘도 대비를 **사진에서** 잰다.
 * 알약 안은 왼쪽 끝에서 6px 들어간 세로 가운데(`size="sm"` 은 가로 여백 12px 라 글자가 없다, 둥근 끝 안쪽이다).
 * 바탕은 오른쪽 끝에서 14px 바깥이다(상자 `px-4`·배너 `px-4` 안 여백이라 시트가 그대로 보이고, rest 그림자의 번짐은 닿지 않는다).
 * 위·아래 가장자리는 피한다(다크의 `shadow-sm` 은 위 1px 안쪽 하이라이트를 둔다).
 */
async function pillVsBackdrop(page, button) {
  await button.scrollIntoViewIfNeeded();
  const box = await button.boundingBox();
  if (box === null) return null;
  const y = Math.round(box.y + box.height / 2);
  const fill = await pixelAt(page, Math.round(box.x + 6), y);
  const backdrop = await pixelAt(page, Math.round(box.x + box.width + 14), y);
  const ratio = contrastOf(fill, backdrop);
  return { fill, backdrop, ratio, detail: `알약 rgb(${fill.join(",")}) 바탕 rgb(${backdrop.join(",")}) 대비 ${ratio.toFixed(3)}:1` };
}
const sameFill = (a, b) => a.every((value, i) => Math.abs(value - b[i]) <= 2);

/**
 * 알약이 바탕에서 **읽히는** 바닥(스킴별). 3:1 은 아니다 — 이 문법으로는 구조상 나오지 않는다: 디자인 시스템은 보조 알약의 **채움 대비를 재지 않고**
 * (README §3.3, ADR-0189 D6) 글자 라벨이 컨트롤을 식별시킨다(WCAG 1.4.11). 바닥은 사진으로 잰 값 사이에 둔 것이다.
 *   - 시트 위 알약(`PILL_MIN`): 라이트는 사라지던 보조 채움이 1.009(390 서랍)~1.047(720·1440 셸 바닥), 시트 위 문법(`--surface` + rest 그림자)은
 *     1.109~1.171 → 1.08. 다크의 시트 위 문법은 안쪽 하이라이트 1px 에 기대 1.033(WebKit 1440)~1.076(빈 상태 「채널 만들기」도 같다)이라 바닥은
 *     「시트와 같은 색이 아니다」만 막는 1.02 이다. 그 위에서 같은 문법인지는 아래 「빈 상태 기준과 같은 채움」 단정이 맡는다.
 *   - 본문 판 위 보조 채움(`BODY_PILL_MIN`): 라이트 1.118~1.149, 다크 1.165~1.198 → 1.08 · 1.10. 시트 위 문법이 본문까지 번지면(판 위 `--surface` 알약은
 *     라이트 1.0, 다크 1.04) 이 바닥을 못 넘는다.
 */
const PILL_MIN = { light: 1.08, dark: 1.02 };
const BODY_PILL_MIN = { light: 1.08, dark: 1.10 };

// ---- 정적 서버 (자기 PID 로만 끈다) -------------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".webp": "image/webp", ".woff2": "font/woff2", ".woff": "font/woff", ".wasm": "application/wasm",
  ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
};
function startStatic() {
  const server = createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? "/", ORIGIN).pathname);
    let file = normalize(join(DIST, pathname));
    if (!file.startsWith(DIST)) return void res.writeHead(403).end();
    if (!existsSync(file) || statSync(file).isDirectory()) {
      if (extname(pathname) !== "") return void res.writeHead(404).end();
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

// ---- 모의 /v1 -----------------------------------------------------------------

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const peerId = "00000000-0000-7000-8000-000000000102";
const channelA = "00000000-0000-7000-8000-000000000201";
const channelB = "00000000-0000-7000-8000-000000000202";

const session = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "박서연", handle: "seoyeon" },
  realtimeWebSocketUrl: "ws://capture-5242.invalid/connection/websocket",
};
const person = (over) => ({
  workspaceId, status: "active", role: "member", channelCount: 2, channelIds: [channelA, channelB],
  capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...over,
});
const roster = [
  person({ id: memberId, kind: "human", role: "owner", displayName: "박서연", handle: "seoyeon" }),
  person({ id: peerId, kind: "human", displayName: "이도현", handle: "dohyun" }),
];
const channels = [
  { id: channelA, workspaceId, kind: "public", name: "release-2026-11", topic: "11월 릴리스 준비", muted: false },
  { id: channelB, workspaceId, kind: "public", name: "design-review", topic: "화면 검수", muted: false },
];
const AT = Date.now() - 3_600_000;
const row = (id, seq, author, body, createdAtMs, channelId = channelA) => ({
  id: `0199dddd-0000-7000-8000-0000000000${id}`, channelId, seq, hlcTs: createdAtMs, hlcCount: 0,
  authorMemberId: author, type: "text", body, state: "sent", createdAtMs,
});
const history = (channelId) => [
  row("01", 100, peerId, "스테이징 배포 끝났어요. 체크리스트 한 번만 같이 봐 주세요.", AT, channelId),
  row("02", 101, memberId, "확인했어요. 롤백 계획은 문서에 있어요.", AT + 60_000, channelId),
];
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** 모의 서버 상태. channels: ok | empty(채널 0개) | abort(응답 없음) · inbox: ok | abort · rules: ok | 500. reads 는 자리별로 읽기가 몇 번 나갔는지 센다. */
function makeServerState() {
  return { channels: "ok", inbox: "ok", rules: "ok", reads: { channels: 0, inbox: 0, rules: 0 } };
}

async function installRoutes(context, state) {
  await context.route("**/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (path === "/v1/auth/login") return json(route, session);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: session.accessToken, refreshToken: session.refreshToken });
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId });
    }
    if (/\/inbox(\/|$)/.test(path)) {
      state.reads.inbox += 1;
      if (state.inbox === "abort") return route.abort("failed");
      return json(route, { items: [], nextCursor: null, unreadCount: 0, approvalsPending: 0 });
    }
    if (path.endsWith("/notification-rules")) {
      state.reads.rules += 1;
      if (state.rules === "500") return json(route, { error: { code: "internal", message: "capture: boom" } }, 500);
      return json(route, { dnd: false, mentionOverridesMute: false });
    }
    if (path.endsWith("/channels") && method === "GET") {
      state.reads.channels += 1;
      if (state.channels === "abort") return route.abort("failed");
      if (state.channels === "empty") return json(route, { channels: [] });
      return json(route, { channels });
    }
    if (path.endsWith("/agent-dm-delivery")) return json(route, { agentMemberId: peerId, ownerMemberId: memberId, state: "open" });
    if (path.endsWith("/agent-runs/progress")) return json(route, { runs: [] });
    if (path.endsWith("/hosted-agent-connections") && method === "GET") return json(route, { connections: [] });
    if (path.endsWith("/allowed-models")) return json(route, { allowedAgentModels: [] });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/read-state") && method === "GET") {
      return json(route, { read_states: channels.map((c) => ({ channel_id: c.id, last_read_seq: 999, latest_seq: 999, unread_count: 0, mention_count: 0 })) });
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
    if (path.includes("/messages")) {
      const url = new URL(request.url());
      if (url.searchParams.has("after") || url.searchParams.has("before")) return json(route, { messages: [] });
      const id = path.match(/\/channels\/([^/]+)\/messages/)?.[1] ?? channelA;
      return json(route, { messages: history(id) });
    }
    return json(route, {});
  });
}

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
          if (c.connect) return { id: c.id, connect: { client: "5242-capture", version: "6" } };
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

// ---- 페이지 조작 ----------------------------------------------------------------

async function newPage(browser, scheme, width, height) {
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
  return { context, page, state };
}

async function shot(page, name) {
  if (!SHOTS) return;
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, `${name}.png`) });
}
const textOf = async (locator) => ((await locator.textContent()) ?? "").replace(/\s+/g, " ").trim();

/** 폰 폭(390)에서 사이드바는 닫힌 서랍이다: 헤더의 「채널 목록 열기」로 열고 자리를 잡은 뒤 잰다(열려 있을 때만 알약이 화면 안에 선다). */
async function openDrawerIfPhone(page, width) {
  if (!isPhoneWidth(width)) return;
  await page.getByTestId("open-sidebar-drawer").first().click();
  await page.locator('[data-testid="sidebar"][data-open]').waitFor({ timeout: 10_000 });
  await wait(300);
}

// ---- 장면 ------------------------------------------------------------------------

const TITLE_CHANNELS = "채널 목록을 불러오지 못했어요";
const REASON_SERVER = "서버에 닿지 못했어요. 잠시 뒤 다시 시도해 주세요.";

/**
 * 시트 위 알약의 **기준**: 받아 둔 채널이 0개인 사이드바의 빈 상태 「채널 만들기」(`ghost` + `band-surface bg-surface shadow-sm`, 시안 A 시트 위 알약).
 * 불러오기 실패의 「다시 시도」가 이 알약과 **같은 채움**으로 서는지를 아래 단정이 이 사진 값과 견준다(#5306). 조합마다 먼저 찍어 둔다.
 */
const sheetPillReference = new Map();

async function sceneSidebarEmpty(browser, combo, scheme, width, height) {
  scope = `사이드바 빈 상태(기준) ${combo}`;
  const { context, page, state } = await newPage(browser, scheme, width, height);
  state.channels = "empty";
  await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
  const create = page.getByTestId("sidebar-create-channel");
  await create.waitFor({ timeout: 25_000 });
  await openDrawerIfPhone(page, width);
  await wait(400);
  const pill = await pillVsBackdrop(page, create);
  if (pill !== null) sheetPillReference.set(combo, pill);
  check(`사이드바 빈 상태 「채널 만들기」(시트 위 알약의 기준)가 시트 바탕에서 읽힌다(그릇 ↔ 바탕 대비 ${PILL_MIN[scheme]} 이상)`, pill !== null && pill.ratio >= PILL_MIN[scheme], pill?.detail);
  await shot(page, `sidebar-channels-empty-${combo}`);
  await context.close();
}

/** 불러오기 실패의 「다시 시도」 알약 단정 둘: 빈 상태 기준과 같은 채움(문법) + 시트 바탕에서 읽힘(대비). */
function checkSheetPill(label, combo, scheme, pill) {
  const reference = sheetPillReference.get(combo);
  check(
    `${label}: 「다시 시도」 알약이 빈 상태 「채널 만들기」와 같은 시트 위 문법(같은 채움 색)으로 선다`,
    pill !== null && reference !== undefined && sameFill(pill.fill, reference.fill),
    `${pill?.detail ?? "알약 없음"} · 기준 ${reference?.detail ?? "없음"}`
  );
  check(`${label}: 「다시 시도」 알약(단추 그릇)이 시트 바탕에서 읽힌다(그릇 ↔ 바탕 대비 ${PILL_MIN[scheme]} 이상)`, pill !== null && pill.ratio >= PILL_MIN[scheme], pill?.detail);
}

async function sceneSidebar(browser, combo, scheme, width, height) {
  scope = `사이드바 채널 목록 ${combo}`;
  const { context, page, state } = await newPage(browser, scheme, width, height);
  state.channels = "abort";
  await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
  const box = page.locator('[data-testid="channel-list"] [data-testid="channels-error"]');
  await box.waitFor({ timeout: 25_000 });
  await openDrawerIfPhone(page, width);
  await wait(400);
  const text = await textOf(box);
  check("사이드바: 제목 + 원인 이유(서버에 닿지 못함)가 한 상자에 선다", text.includes(TITLE_CHANNELS) && text.includes(REASON_SERVER), text);
  check("사이드바 상자: 역할 alert, 다시 시도 단추 하나, 원인 표시", (await box.getAttribute("role")) === "alert" && (await box.locator("button").count()) === 1 && (await box.getAttribute("data-cause")) === "serverUnreachable");
  check("사이드바 상자: 상태 코드가 한 글자도 없다", !hasStatusCode(text));
  check("옛 「채널을 불러오지 못했습니다.」 문장이 어디에도 없다", !(await page.locator("body").innerText()).includes("채널을 불러오지 못했습니다"));
  const sidebarBox = await box.boundingBox();
  check("사이드바 상자가 서랍 폭 안에 들어간다(가로 넘침 없음)", sidebarBox !== null && sidebarBox.x >= 0 && sidebarBox.width <= 340, JSON.stringify(sidebarBox));
  const retryPill = await pillVsBackdrop(page, box.getByRole("button", { name: "다시 시도" }));
  checkSheetPill("사이드바 상자", combo, scheme, retryPill);
  await shot(page, `sidebar-channels-failure-${combo}`);
  const before = state.reads.channels;
  state.channels = "ok";
  await box.getByRole("button", { name: "다시 시도" }).click();
  await page.locator('[data-testid="channel-list"]').getByText("release-2026-11").first().waitFor({ timeout: 15_000 }).catch(() => undefined);
  check("다시 시도가 채널 목록을 다시 읽고 풀린다", state.reads.channels > before && (await page.locator('[data-testid="channel-list"] [data-testid="channels-error"]').count()) === 0);
  await context.close();
}

/**
 * 받아 둔 채널이 **있는데** 다시 읽기가 실패한 사이드바의 한 줄(`LoadFailureLine`, #5306). 한 번 읽힌 목록이 있어야 서므로 사이드바를 정상으로 띄운 뒤
 * 읽기를 끊고, `Date.now` 를 60초 앞으로 밀어 목록을 오래된 것(staleTime 30초)으로 만들고, 연결이 끊겼다 돌아온 일(`offline` → `online`)로 다시 읽게 한다.
 * 시계만 밀므로 타이머는 진짜로 흐른다(`retry: 1` 의 1초 대기도 그대로).
 */
async function sceneSidebarLine(browser, combo, scheme, width, height) {
  scope = `사이드바 한 줄 ${combo}`;
  const { context, page, state } = await newPage(browser, scheme, width, height);
  await page.addInitScript(() => {
    const real = Date.now.bind(Date);
    window.__skew5306 = 0;
    Date.now = () => real() + window.__skew5306;
  });
  await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
  const list = page.locator('[data-testid="channel-list"]');
  await list.getByText("release-2026-11").first().waitFor({ timeout: 25_000 });
  state.channels = "abort";
  await page.evaluate(() => {
    window.__skew5306 = 60_000;
    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("online"));
  });
  const line = page.getByTestId("channels-error-line");
  await line.waitFor({ timeout: 25_000 });
  await openDrawerIfPhone(page, width);
  await wait(400);
  const text = await textOf(line);
  check("사이드바 한 줄: 받아 둔 목록은 그대로 두고 제목만 위에 선다(상자 없음)", text.includes(TITLE_CHANNELS) && (await page.getByTestId("channels-error").count()) === 0 && (await list.getByText("release-2026-11").count()) > 0, text);
  check("사이드바 한 줄: 역할 alert, 다시 시도 단추 하나, 상태 코드 없음", (await line.getAttribute("role")) === "alert" && (await line.locator("button").count()) === 1 && !hasStatusCode(text));
  const retryPill = await pillVsBackdrop(page, line.getByRole("button", { name: "다시 시도" }));
  checkSheetPill("사이드바 한 줄", combo, scheme, retryPill);
  await shot(page, `sidebar-channels-failure-line-${combo}`);
  const before = state.reads.channels;
  state.channels = "ok";
  await line.getByRole("button", { name: "다시 시도" }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="channels-error-line"]').length === 0, undefined, { timeout: 15_000 }).catch(() => undefined);
  check("한 줄의 다시 시도가 채널 목록을 다시 읽고 풀린다", state.reads.channels > before && (await page.getByTestId("channels-error-line").count()) === 0);
  await context.close();
}

async function sceneInbox(browser, combo, scheme, width, height) {
  scope = `받은함 목록 ${combo}`;
  const { context, page, state } = await newPage(browser, scheme, width, height);
  await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="channel-list"]').getByText("release-2026-11").first().waitFor({ timeout: 25_000 });
  state.inbox = "abort";
  await page.evaluate(() => { location.hash = "/inbox"; });
  const box = page.getByTestId("inbox-error");
  await box.waitFor({ timeout: 25_000 });
  await wait(400);
  const text = await textOf(box);
  check("받은함: 제목 + 원인 이유가 한 상자에 선다", text.includes("인박스를 불러오지 못했어요") && text.includes(REASON_SERVER), text);
  check("받은함 상자: 역할 alert, 다시 시도 단추 하나", (await box.getAttribute("role")) === "alert" && (await box.locator("button").count()) === 1);
  check("받은함 상자: 상태 코드가 없고 옛 문장이 없다", !hasStatusCode(text) && !(await page.locator("body").innerText()).includes("인박스를 불러오지 못했어요."));
  // 본문 판 위의 같은 상자는 보조 채움 그대로여야 한다(시트 위 문법은 사이드바만의 것이다, #5306).
  const bodyPill = await pillVsBackdrop(page, box.getByRole("button", { name: "다시 시도" }));
  check(`받은함 상자(본문 판): 「다시 시도」 알약이 판 바탕에서 읽힌다(그릇 ↔ 바탕 대비 ${BODY_PILL_MIN[scheme]} 이상)`, bodyPill !== null && bodyPill.ratio >= BODY_PILL_MIN[scheme], bodyPill?.detail);
  await shot(page, `inbox-failure-${combo}`);
  const before = state.reads.inbox;
  state.inbox = "ok";
  await box.getByRole("button", { name: "다시 시도" }).click();
  await page.getByTestId("inbox-empty").waitFor({ timeout: 15_000 }).catch(() => undefined);
  check("다시 시도가 받은함을 다시 읽고 풀린다", state.reads.inbox > before && (await page.getByTestId("inbox-error").count()) === 0);
  await context.close();
}

async function sceneSettings(browser, combo, scheme, width, height) {
  scope = `설정 알림 규칙 ${combo}`;
  const { context, page, state } = await newPage(browser, scheme, width, height);
  state.rules = "500";
  await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="channel-list"]').getByText("release-2026-11").first().waitFor({ timeout: 25_000 });
  await page.evaluate(() => { location.hash = "/settings?section=notifications"; });
  const note = page.getByTestId("notification-rules-error");
  await note.waitFor({ timeout: 25_000 });
  await wait(400);
  const text = await textOf(note);
  check("설정 알림 규칙: 제목 뒤에 원인 이유가 붙은 한 줄이 선다", text.includes("알림 규칙을 불러오지 못했어요") && text.includes("문제가 생겼어요. 다시 시도해 주세요."), text);
  check("설정 한 줄: 역할 alert, 다시 시도 단추 하나, 상태 코드 없음", (await note.getAttribute("role")) === "alert" && (await note.locator("button").count()) === 1 && !hasStatusCode(text));
  await shot(page, `settings-notification-rules-failure-${combo}`);
  const before = state.reads.rules;
  state.rules = "ok";
  await note.getByRole("button", { name: "다시 시도" }).click();
  await page.getByTestId("notification-rules-dnd").waitFor({ timeout: 15_000 }).catch(() => undefined);
  check("다시 시도가 알림 규칙을 다시 읽고 풀린다", state.reads.rules > before && (await page.getByTestId("notification-rules-error").count()) === 0);
  await context.close();
}

// ---- 실행 -----------------------------------------------------------------------

const server = await startStatic();
const browser = await (ENGINE === "webkit" ? webkit : chromium).launch({ headless: true });
try {
  for (const [combo, [scheme, width, height]] of Object.entries(COMBO_SIZES)) {
    if (!COMBOS.includes(combo)) continue;
    await sceneSidebarEmpty(browser, combo, scheme, width, height);
    await sceneSidebar(browser, combo, scheme, width, height);
    await sceneSidebarLine(browser, combo, scheme, width, height);
    await sceneInbox(browser, combo, scheme, width, height);
    await sceneSettings(browser, combo, scheme, width, height);
  }
} finally {
  await browser.close();
  server.close();
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} PASS${failed.length ? ` · ${failed.length} FAIL` : ""}`);
for (const f of failed) console.log(`  FAIL [${f.scope}] ${f.id}  ${f.detail}`);
process.exit(failed.length > 0 && !SOFT ? 1 : 0);
