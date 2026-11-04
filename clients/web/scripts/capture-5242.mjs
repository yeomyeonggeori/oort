#!/usr/bin/env node
// =============================================================================
// 남은 「불러오지 못했습니다」 자리들 (#5242, #5221 후속): 사이드바 채널 목록의 원인 상자와 대표 두 자리(받은함 목록 = 상자,
// 설정 알림 규칙 = 원인 한 줄)를 라이트·다크 1440으로 찍고 **화면의 문장과 서버로 나간 요청**을 잰다.
//
//   npm run build && node scripts/capture-5242.mjs --label after --out <스크래치>/cap5242
//
// 번들 Chromium 헤드리스 + 모의 `/v1`(시크릿 없음, 인물은 전부 가상). 정적 서버는 이 파일이 직접 띄우고 자기 PID 로만 끈다.
// 단정은 구현 이름이 아니라 **화면의 문장**을 잰다: 제목 + 원인 이유가 나오는가, 상태 코드가 한 글자도 없는가, 옛 「…불러오지
// 못했습니다」 문장이 없는가, 다시 시도가 그 자리의 읽기를 다시 부르고 풀리는가.
//
// 옵션: --dist(기본 dist) --out(기본 captures/5242/<label>) --label(기본 after) --port(기본 5542)
//       --soft(실패해도 끝까지 돌고 종료 코드 0) --no-shots --combos(light-1440,dark-1440. 기본 둘)
// 캡처는 저장소에 올리지 않는다: --out 을 스크래치로 준다.
// =============================================================================
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

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
const COMBOS = String(arg("combos", "light-1440,dark-1440")).split(",");
const ORIGIN = `http://127.0.0.1:${PORT}`;

// ---- 결과 장부 ---------------------------------------------------------------

const results = [];
let scope = "";
function check(id, ok, detail = "") {
  results.push({ scope, id, ok: Boolean(ok), detail });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${id}${detail === "" ? "" : `  (${String(detail).slice(0, 160)})`}`);
}
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const hasStatusCode = (text) => /(^|[^\d])\d{3}([^\d]|$)/.test(text);

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

/** 모의 서버 상태. channels·inbox: ok | abort(응답 없음) · rules: ok | 500. reads 는 자리별로 읽기가 몇 번 나갔는지 센다. */
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

// ---- 장면 ------------------------------------------------------------------------

const TITLE_CHANNELS = "채널 목록을 불러오지 못했어요";
const REASON_SERVER = "서버에 닿지 못했어요. 잠시 뒤 다시 시도해 주세요.";

async function sceneSidebar(browser, combo, scheme, width, height) {
  scope = `사이드바 채널 목록 ${combo}`;
  const { context, page, state } = await newPage(browser, scheme, width, height);
  state.channels = "abort";
  await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
  const box = page.locator('[data-testid="channel-list"] [data-testid="channels-error"]');
  await box.waitFor({ timeout: 25_000 });
  await wait(400);
  const text = await textOf(box);
  check("사이드바: 제목 + 원인 이유(서버에 닿지 못함)가 한 상자에 선다", text.includes(TITLE_CHANNELS) && text.includes(REASON_SERVER), text);
  check("사이드바 상자: 역할 alert, 다시 시도 단추 하나, 원인 표시", (await box.getAttribute("role")) === "alert" && (await box.locator("button").count()) === 1 && (await box.getAttribute("data-cause")) === "serverUnreachable");
  check("사이드바 상자: 상태 코드가 한 글자도 없다", !hasStatusCode(text));
  check("옛 「채널을 불러오지 못했습니다.」 문장이 어디에도 없다", !(await page.locator("body").innerText()).includes("채널을 불러오지 못했습니다"));
  const sidebarBox = await box.boundingBox();
  check("사이드바 상자가 서랍 폭 안에 들어간다(가로 넘침 없음)", sidebarBox !== null && sidebarBox.x >= 0 && sidebarBox.width <= 340, JSON.stringify(sidebarBox));
  await shot(page, `sidebar-channels-failure-${combo}`);
  const before = state.reads.channels;
  state.channels = "ok";
  await box.getByRole("button", { name: "다시 시도" }).click();
  await page.locator('[data-testid="channel-list"]').getByText("release-2026-11").first().waitFor({ timeout: 15_000 }).catch(() => undefined);
  check("다시 시도가 채널 목록을 다시 읽고 풀린다", state.reads.channels > before && (await page.locator('[data-testid="channel-list"] [data-testid="channels-error"]').count()) === 0);
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
const browser = await chromium.launch({ headless: true });
const COMBO_SIZES = { "light-1440": ["light", 1440, 900], "dark-1440": ["dark", 1440, 900] };
try {
  for (const [combo, [scheme, width, height]] of Object.entries(COMBO_SIZES)) {
    if (!COMBOS.includes(combo)) continue;
    await sceneSidebar(browser, combo, scheme, width, height);
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
