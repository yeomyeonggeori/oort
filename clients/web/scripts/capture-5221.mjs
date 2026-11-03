#!/usr/bin/env node
// =============================================================================
// 실패 곳 정리 (#5221, #5201 S-C): 보내지 못한 글(원인 한 줄·모두 다시 보내기·자동 재전송·채널 이동과 새로고침에도 남김),
// 불러오기 상자, 로그인 만료·콜드 스타트 안내. 모양과 **요청**을 재고, 라이트·다크 × 720·1440으로 찍는다.
//
//   npm run build && node scripts/capture-5221.mjs --label after --out <스크래치>/cap5221
//
// 번들 Chromium 헤드리스 + 모의 `/v1`(시크릿 없음, 인물은 전부 가상). 정적 서버는 이 파일이 직접 띄우고 자기 PID 로만 끈다.
// 단정은 구현 이름이 아니라 **화면의 문장과 서버로 나간 요청**을 잰다: 같은 멱등키로 다시 나갔는가, 거절된 글은 저절로 나가지
// 않았는가, 채널을 옮기고 새로고침해도 같은 키의 실패 행이 남았는가, 상태 코드가 화면에 한 글자도 없는가.
//
// 옵션: --dist(기본 dist) --out(기본 captures/5221/<label>) --label(기본 after) --port(기본 5531)
//       --soft(실패해도 끝까지 돌고 종료 코드 0) --no-shots --combos(light-1440,dark-1440,light-720,dark-720. 기본 전부)
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
const OUT = resolve(WEB_ROOT, String(arg("out", `captures/5221/${LABEL}`)));
const PORT = Number(arg("port", 5531));
const SOFT = arg("soft", false) === true;
const SHOTS = arg("no-shots", false) !== true;
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
  realtimeWebSocketUrl: "ws://capture-5221.invalid/connection/websocket",
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
  row("03", 102, peerId, "금요일 배포 공지 초안이에요. 이대로 올려도 될까요?", AT + 120_000, channelId),
];
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/**
 * 모의 서버 상태. send: ok(저장) | abort(응답 없음) | reject(500)
 * head: ok | abort(머리 읽기 실패) · refresh: ok | abort | dead(401) · expire: true 면 일반 요청이 401.
 */
function makeServerState() {
  return { send: "abort", head: "ok", refresh: "ok", expire: false, posts: [], stored: [], nextSeq: 200 };
}

async function installRoutes(context, state) {
  await context.route("**/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (path === "/v1/auth/login") return json(route, session);
    if (path === "/v1/auth/refresh") {
      if (state.refresh === "abort") return route.abort("failed");
      if (state.refresh === "dead") return json(route, { error: { message: "refresh token revoked" } }, 401);
      return json(route, { accessToken: session.accessToken, refreshToken: session.refreshToken });
    }
    if (state.expire) return json(route, { error: { message: "token expired" } }, 401);
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
    const send = path.match(/\/channels\/([^/]+)\/messages$/);
    if (send && method === "POST") {
      const body = JSON.parse(request.postData() ?? "{}");
      state.posts.push({ clientMsgId: body.clientMsgId, body: body.body });
      if (state.send === "abort") return route.abort("failed");
      if (state.send === "reject") return json(route, { error: { message: "capture: message rejected by policy" } }, 400);
      const seq = state.nextSeq++;
      const stored = { ...row(String(seq), seq, memberId, body.body ?? "", Date.now(), send[1]), id: `0199ffff-0000-7000-8000-${String(seq).padStart(12, "0")}` };
      state.stored.push(stored);
      return json(route, stored, 201);
    }
    if (path.includes("/messages")) {
      const url = new URL(request.url());
      if (url.searchParams.has("after") || url.searchParams.has("before")) return json(route, { messages: [] });
      if (state.head === "abort") return route.abort("failed");
      const id = path.match(/\/channels\/([^/]+)\/messages/)?.[1] ?? channelA;
      return json(route, { messages: [...history(id), ...state.stored.filter((m) => m.channelId === id)] });
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
          if (c.connect) return { id: c.id, connect: { client: "5221-capture", version: "6" } };
          if (c.subscribe) return { id: c.id, subscribe: { recoverable: true, positioned: true, recovered: false, epoch: "cap", offset: 0 } };
          return { id: c.id };
        });
        queueMicrotask(() => this.onmessage?.(new MessageEvent("message", { data: replies.map((r) => JSON.stringify(r)).join("\n") })));
      }
      close() { this.readyState = 3; this.onclose?.(new CloseEvent("close", { code: 1000 })); }
    }
    window.WebSocket = CaptureSocket;
    // 데스크탑 셸 흉내(`__TAURI_INTERNALS__`)는 이 레인에 필요 없어 두지 않는다(5210 레인과 다른 점). 데스크탑 번들은 웹 번들과 같고,
    // 이 레인은 일반 웹으로 돈다. 실제 Tauri 앱·WebKit(데스크탑 셸 엔진)은 이 레인이 재지 않는다(미검증).
    //
    // 주의(장면 순서): 서버가 **거절한 응답**(400)도 「서버가 답했다」 신호라서, 앞서 네트워크로 못 보낸 행이 있으면 자동 재전송을
    // 깨운다. 그래서 장면은 거절된 글을 먼저 만들고 네트워크 실패 글을 뒤에 만든다(`settleFailed`가 재시도가 가라앉기를 기다린다).
  });
}

// ---- 페이지 조작 ----------------------------------------------------------------

async function newPage(browser, scheme, width, height, { seedSession = true } = {}) {
  const state = makeServerState();
  const context = await browser.newContext({
    viewport: { width, height }, colorScheme: scheme, reducedMotion: "reduce", serviceWorkers: "block",
    deviceScaleFactor: 2, locale: "ko-KR", timezoneId: "Asia/Seoul",
  });
  await installRoutes(context, state);
  const page = await context.newPage();
  await installPage(page);
  await page.addInitScript(
    ({ server, stored, record, seed }) => {
      try {
        localStorage.setItem("momo.web.server.v1", server);
        if (seed) localStorage.setItem("momo.web.session.v1", JSON.stringify(stored));
        localStorage.setItem("momo.web.appearance.v2", JSON.stringify(record));
      } catch { /* 저장소 없는 캡처 */ }
    },
    {
      server: ORIGIN, seed: seedSession,
      stored: { refreshToken: session.refreshToken, realtimeWebSocketUrl: session.realtimeWebSocketUrl, member: session.member },
      record: { v: 2, scheme, theme: "dawnsky", signal: null, density: "comfortable", glass: { on: false } },
    }
  );
  return { context, page, state };
}

async function openChannel(page, channelId) {
  await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
  await page.evaluate((id) => { window.location.hash = `#/c/${id}`; }, channelId);
  await page.getByTestId("composer-input").waitFor({ timeout: 20_000 });
  await page.locator('[data-testid="timeline-message"]').first().waitFor({ timeout: 20_000 });
  await wait(400);
}
const gotoChannel = (page, id) => page.evaluate((c) => { window.location.hash = `#/c/${c}`; }, id);

async function sendText(page, body) {
  const input = page.getByTestId("composer-input");
  await input.click();
  await input.fill(body);
  await page.getByTestId("composer-send").click();
}
async function waitFailed(page, count) {
  await page.waitForFunction(
    (n) => document.querySelectorAll('[data-testid="timeline-pending"][data-status="failed"]').length === n,
    count, { timeout: 15_000 }
  );
  await wait(250);
}
const failedKeys = (page) =>
  page.evaluate(() => [...document.querySelectorAll('[data-testid="timeline-pending"][data-status="failed"]')].map((el) => el.getAttribute("data-client-msg-id")));
const reasons = (page) =>
  page.evaluate(() => [...document.querySelectorAll('[data-testid="pending-failed-reason"]')].map((el) => el.textContent));
const pendingCount = (page) => page.locator('[data-testid="timeline-pending"]').count();
const hasStatusCode = (text) => /\b[45]\d\d\b/.test(text ?? "");

async function shot(page, name) {
  if (!SHOTS) return;
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, `${name}.png`) });
}

// ---- 장면 -----------------------------------------------------------------------

/**
 * 실패 행이 정확히 n개이고 보내는 중인 행이 없는 채로 0.7초 머문다. 서버가 답한다는 사실(다른 요청의 응답)이 자동 재전송을
 * 깨우므로 네트워크 실패 행은 몇 번 다시 시도됐다 실패할 수 있다: 찍거나 재기 전에 가라앉기를 기다린다.
 */
async function settleFailed(page, n) {
  await page.waitForFunction(
    (count) => {
      const rows = [...document.querySelectorAll('[data-testid="timeline-pending"]')];
      return rows.length === count && rows.every((r) => r.getAttribute("data-status") === "failed");
    },
    n, { timeout: 20_000 }
  );
  await wait(700);
  await page.waitForFunction(
    (count) => document.querySelectorAll('[data-testid="timeline-pending"][data-status="failed"]').length === count,
    n, { timeout: 20_000 }
  );
}

/** 실패 행 셋(서버 거절 하나 + 서버에 닿지 못함 둘), 원인 한 줄과 모두 다시 보내기. */
async function sceneFailureRows(browser, combo, scheme, width, height) {
  scope = `failure-rows ${combo}`;
  console.log(`\n== ${scope}`);
  const { context, page, state } = await newPage(browser, scheme, width, height);
  await openChannel(page, channelA);
  // 서버가 직접 거절한 글을 먼저 만든다(거절 응답도 「서버가 답했다」 신호라 그 뒤의 닿지 못한 글을 깨울 수 있어 순서가 중요하다).
  state.send = "reject";
  await sendText(page, "이 글은 서버가 받지 않을 거예요");
  await settleFailed(page, 1);
  state.send = "abort";
  await sendText(page, "금요일 배포 공지 올렸어요");
  await settleFailed(page, 2);
  await sendText(page, "롤백 문서 링크도 같이 둘게요");
  await settleFailed(page, 3);
  const lines = await reasons(page);
  check("원인 한 줄이 행마다 다르다(서버 거절 · 서버에 닿지 못함)",
    lines[0]?.includes("서버가 받지 못했어요") && lines[1]?.includes("서버에 닿지 못해") && lines[2]?.includes("서버에 닿지 못해"), JSON.stringify(lines));
  check("어떤 줄에도 상태 코드가 없다", !lines.some(hasStatusCode));
  const all = page.getByTestId("pending-resend-all");
  check("실패가 셋이면 모두 다시 보내기가 한 번만 선다", (await all.count()) === 1, `count=${await all.count()}`);
  check("모두 다시 보내기가 개수를 말한다", (await all.textContent())?.includes("3개 모두 다시 보내기") === true);
  const lastRowHasIt = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-testid="timeline-pending"]')];
    return rows.at(-1)?.querySelector('[data-testid="pending-resend-all"]') !== null;
  });
  check("마지막 실패 행 아래에 선다", lastRowHasIt);
  await page.evaluate(() => document.querySelector('[data-testid="pending-resend-all"]')?.scrollIntoView({ block: "center" }));
  await wait(200);
  await shot(page, `failure-rows-${combo}`);
  // 모두 다시 보내기: 서버가 돌아왔다. 같은 키 · 보낸 순서.
  const keys = await failedKeys(page);
  const before = state.posts.length;
  state.send = "ok";
  await all.click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="timeline-pending"]').length === 0, null, { timeout: 20_000 });
  const resent = state.posts.slice(before).map((p) => p.clientMsgId);
  check("모두 다시 보내기는 같은 멱등키로 보낸 순서대로 나갔다", JSON.stringify(resent) === JSON.stringify(keys), `${resent.length}/${keys.length}`);
  check("화면에 메시지가 한 번씩만 있다", (await page.locator('[data-testid="timeline-message"]').count()) === 3 + 3);
  await context.close();
}

/** 자동 재전송(결정 ⑤)과 거절된 글. 채널 이동·새로고침에도 남는다. */
async function sceneAutoAndKeep(browser, combo, scheme, width, height) {
  scope = `auto-resend+keep ${combo}`;
  console.log(`\n== ${scope}`);
  const { context, page, state } = await newPage(browser, scheme, width, height);
  await openChannel(page, channelA);
  state.send = "reject";
  await sendText(page, "거절될 글은 손으로");
  await settleFailed(page, 1);
  const [rejectedKey] = await failedKeys(page);
  state.send = "abort";
  await sendText(page, "연결이 돌아오면 저절로 가는 글");
  await settleFailed(page, 2);
  const networkKey = (await failedKeys(page)).find((k) => k !== rejectedKey);
  const before = state.posts.length;
  state.send = "ok";
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="timeline-pending"][data-status="failed"]').length === 1, null, { timeout: 20_000 });
  const sent = state.posts.slice(before);
  check("네트워크로 못 보낸 글만 저절로 같은 멱등키로 나갔다", sent.length >= 1 && sent.every((p) => p.clientMsgId === networkKey), `posts=${sent.length}`);
  check("서버가 거절한 글은 저절로 나가지 않았다", !state.posts.slice(before).some((p) => p.clientMsgId === rejectedKey) && (await failedKeys(page))[0] === rejectedKey);
  // 채널 이동 · 새로고침에도 남는다.
  await gotoChannel(page, channelB);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="timeline-pending"]').length === 0, null, { timeout: 15_000 });
  check("다른 채널에는 보이지 않는다", (await pendingCount(page)) === 0);
  await gotoChannel(page, channelA);
  await waitFailed(page, 1);
  check("채널을 옮겼다 돌아와도 같은 키의 실패 행이 남는다", (await failedKeys(page))[0] === rejectedKey);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("composer-input").waitFor({ timeout: 20_000 });
  await waitFailed(page, 1);
  check("새로고침해도 같은 키의 실패 행이 남고 원인 줄도 돌아온다", (await failedKeys(page))[0] === rejectedKey && (await reasons(page))[0]?.includes("서버가 받지 못했어요") === true);
  await shot(page, `kept-after-reload-${combo}`);
  await context.close();
}

/** 불러오기 상자: 원인 문장, 상태 코드 없음. */
async function sceneLoadBox(browser, combo, scheme, width, height) {
  scope = `load-box ${combo}`;
  console.log(`\n== ${scope}`);
  const { context, page, state } = await newPage(browser, scheme, width, height);
  state.head = "abort";
  await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
  await page.evaluate((id) => { window.location.hash = `#/c/${id}`; }, channelA);
  const box = page.getByTestId("timeline-error");
  await box.waitFor({ timeout: 25_000 });
  const text = (await box.textContent()) ?? "";
  check("상자가 제목과 원인 문장과 다시 시도를 말한다", text.includes("대화를 불러오지 못했어요") && text.includes("서버에 닿지 못했어요") && text.includes("다시 시도"), text);
  check("상태 코드·서버 원문이 없다", !hasStatusCode(text) && !/upstream|capture:/i.test(text));
  await shot(page, `load-box-${combo}`);
  state.head = "ok";
  await box.getByRole("button", { name: "다시 시도" }).click();
  await page.locator('[data-testid="timeline-message"]').first().waitFor({ timeout: 15_000 });
  check("다시 시도하면 대화가 열린다", (await page.getByTestId("timeline-error").count()) === 0);
  await context.close();
}

/** 콜드 스타트(서버에 안 닿음)와 로그인 만료. */
async function sceneSessionNotices(browser, combo, scheme, width, height) {
  scope = `session-notices ${combo}`;
  console.log(`\n== ${scope}`);
  {
    const { context, page, state } = await newPage(browser, scheme, width, height);
    state.refresh = "abort";
    await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
    const notice = page.getByTestId("boot-unreachable-notice");
    await notice.waitFor({ timeout: 25_000 });
    const text = (await notice.textContent()) ?? "";
    check("콜드 스타트: 저장된 로그인이 그대로임을 말하고 다시 시도가 있다", text.includes("서버에 닿지 못했어요") && text.includes("저장된 로그인은 그대로") && text.includes("다시 시도"), text);
    check("콜드 스타트 안내에 상태 코드가 없다", !hasStatusCode(text));
    await wait(300);
    await shot(page, `boot-unreachable-${combo}`);
    state.refresh = "ok";
    await notice.getByRole("button", { name: "다시 시도" }).click();
    await page.getByTestId("composer-input").waitFor({ timeout: 20_000 }).catch(() => undefined);
    check("다시 시도하면 저장된 로그인으로 이어진다(안내가 걷힌다)", (await page.getByTestId("boot-unreachable-notice").count()) === 0);
    await context.close();
  }
  {
    const { context, page, state } = await newPage(browser, scheme, width, height);
    await openChannel(page, channelA);
    state.refresh = "dead";
    state.expire = true;
    await gotoChannel(page, channelB);
    const notice = page.getByTestId("session-expired-notice");
    await notice.waitFor({ timeout: 25_000 });
    const text = (await notice.textContent()) ?? "";
    check("로그인 만료: 해요체 한 문장이 로그인 화면 위에 선다", text.includes("로그인이 만료됐어요. 다시 로그인해 주세요."), text);
    check("만료 안내에 단추가 없고 상태 코드가 없다", (await notice.locator("button").count()) === 0 && !hasStatusCode(text));
    await wait(300);
    await shot(page, `session-expired-${combo}`);
    await context.close();
  }
}

// ---- 실행 -----------------------------------------------------------------------

const server = await startStatic();
const browser = await chromium.launch({ headless: true });
const COMBO_SIZES = { "light-1440": ["light", 1440, 900], "dark-1440": ["dark", 1440, 900], "light-720": ["light", 720, 900], "dark-720": ["dark", 720, 900] };
try {
  for (const [combo, [scheme, width, height]] of Object.entries(COMBO_SIZES)) {
    if (!wanted(combo)) continue;
    await sceneFailureRows(browser, combo, scheme, width, height);
    await sceneLoadBox(browser, combo, scheme, width, height);
    await sceneSessionNotices(browser, combo, scheme, width, height);
    if (combo === "light-1440" || combo === "dark-720") await sceneAutoAndKeep(browser, combo, scheme, width, height);
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
