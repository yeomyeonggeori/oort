#!/usr/bin/env node
// =============================================================================
// #5345 받은함 점이 읽음과 맞는가 (웹·데스크탑, #5331 후속): Chromium 헤드리스 재현.
//
//   npm run build && node scripts/capture-5345.mjs
//   DIST_DIR=<고치기 전 dist> EXPECT=before node scripts/capture-5345.mjs   # 어긋남이 **난다**는 단정
//   SHOTS=1 OUT_DIR=<dir> TAG=after node scripts/capture-5345.mjs           # 캡처도 찍기(기본은 재기만)
//
// 백엔드는 없다: `/v1/**` 는 이 파일 안의 메모리 서버이고, 서버가 읽음을 정하는 규칙(ADR-0199 D3)을 그대로 따른다.
//   · 항목 읽음 PUT        그 항목만 읽음이다. 채널의 읽음 위치는 움직이지 않는다.
//   · 채널 읽음 위치 PUT   위치가 전진하면 같은 순간 그 채널의 `seq <= 위치` 항목이 읽음이 된다. 인박스 이벤트는 나가지 않는다.
// 인물은 전부 가상이고 소켓은 구독만 받는다(장면 C 만 이 파일이 개인 채널 프레임을 밀어 넣는다).
//
// 장면 셋. `EXPECT=before`(고치기 전 번들)이면 ★ 표시 단정의 방향이 반대다 — 어긋남이 실제로 난다는 증거다.
//
//   A  같은 대화의 항목 셋 → 하나를 열고 「대화에서 보기」로 대화를 읽고 → 받은함으로 돌아온다 (15초 안: 목록이 신선한 채로 남는 창).
//      ★ 돌아온 받은함에서 같은 대화의 항목 셋 모두 점이 없고, 다른 채널의 진짜 안 읽음(멘션)은 점이 남는다. 탭의 수가 점 수와 같다.
//   B  다른 기기가 그 대화를 읽는다(위치 전진, 이벤트 없음). 이 기기는 받은함을 연 채로 있다.
//      ★ 읽음 위치 투영이 다시 읽히는 주기(30초) 안에 점이 꺼진다.
//   C  다른 기기가 항목 하나만 읽음으로 누른다(`inbox_item.read` 프레임). 원래 맞던 길: 두 번들 모두 점이 꺼진다.
// =============================================================================
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "captures/5345");
const PORT = Number(process.env.CAPTURE_PORT || 5445);
const DIST_DIR = process.env.DIST_DIR || "";
const SHOTS = process.env.SHOTS === "1";
const TAG = process.env.TAG || "run";
const EXPECT = process.env.EXPECT === "before" ? "before" : "after";
/** 장면 B 가 기다리는 최대 시간. 읽음 위치 투영의 다시 읽기 주기(30초) + 여유. */
const POLL_WAIT_MS = 45_000;
const MIN = 60_000;

const workspaceId = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const SEO = "00000000-0000-7000-8000-000000000102";
const DM = "00000000-0000-7000-8000-000000000203";
const GEN = "00000000-0000-7000-8000-000000000201";
// 로그인 직후 착지하는 채널(목록의 첫 비-DM 채널): 글이 없어서 읽음 위치를 광고하지 않는다 — DM 과 멘션 채널은 손대지 않은 채로 시작한다.
const LOBBY = "00000000-0000-7000-8000-000000000204";
const item = (n) => `00000000-0000-7000-8000-0000000009a${n}`;
const D1 = item(1);
const D2 = item(2);
const D3 = item(3);
const M1 = item(4);
const DM_ITEMS = [D1, D2, D3];

const channels = [
  { id: LOBBY, workspaceId, kind: "public", name: "로비", muted: false },
  { id: GEN, workspaceId, kind: "public", name: "일반", muted: false },
  { id: DM, workspaceId, kind: "dm", dmKey: "a", memberIds: [ME, SEO], muted: false },
];
const person = (id, displayName, handle, extra = {}) => ({
  id, workspaceId, kind: "human", status: "active", displayName, handle, role: "member", channelCount: 2,
  channelIds: channels.map((c) => c.id), capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...extra,
});
const roster = [person(ME, "이도현", "dohyun", { role: "owner" }), person(SEO, "박서연", "seoyeon")];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: ME, workspaceId, kind: "human", displayName: "이도현", handle: "dohyun" },
  realtimeWebSocketUrl: "ws://capture-5345.invalid/connection/websocket",
};
const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** 서버가 읽음을 정하는 규칙(D3)을 가진 메모리 서버. 장면마다 새로 만든다. */
function makeServer() {
  const t0 = Date.now();
  const iso = (agoMin) => new Date(t0 - agoMin * MIN).toISOString().replace(/\.(\d{3})Z$/, ".$1123Z");
  const mid = (channelId, seq) => `00000000-0000-7000-8000-00000000${channelId.slice(-2)}${String(seq).padStart(2, "0")}`;
  const latest = { [LOBBY]: 0, [DM]: 3, [GEN]: 5 };
  const position = { [LOBBY]: 0, [DM]: 0, [GEN]: 0 };
  const wire = (id, kind, channel, seq, preview, agoMin) => ({
    id, kind, reasons: [kind],
    channel: { id: channel.id, name: channel.name ?? null, kind: channel.kind },
    message: { id: mid(channel.id, seq), seq, authorMemberId: SEO, preview, deleted: false },
    actorMemberId: SEO, createdAt: iso(agoMin), readAt: null,
  });
  const byId = (id) => channels.find((c) => c.id === id);
  // 최신순(서버가 정렬해서 준다).
  const items = [
    wire(D3, "dm", byId(DM), 3, "12시 반에 건물 앞에서 봐요", 2),
    wire(D2, "dm", byId(DM), 2, "저는 국밥이 좋아요", 3),
    wire(D1, "dm", byId(DM), 1, "점심 뭐 먹을래요?", 4),
    wire(M1, "mention", byId(GEN), 5, "@dohyun 오늘 회의록 확인 부탁드려요", 30),
  ];
  const unread = () => items.filter((i) => i.readAt === null).length;
  const log = { inboxGets: 0, inboxGetAt: [], itemReads: [], positionPuts: [] };

  /** 위치가 전진하면 같은 순간 `seq <= 위치` 항목이 읽음이 된다(D3). 클램프도 서버와 같다. */
  function advance(channelId, seq) {
    position[channelId] = Math.max(position[channelId], Math.min(seq, latest[channelId]));
    for (const row of items) {
      if (row.channel.id === channelId && row.message.seq <= position[channelId] && row.readAt === null) row.readAt = iso(0);
    }
  }
  const readStateRow = (c) => ({
    channel_id: c.id, last_read_seq: position[c.id], latest_seq: latest[c.id],
    unread_count: latest[c.id] - position[c.id], mention_count: 0, marked_unread_before_seq: null,
  });
  const msg = (channelId, seq, body) => ({
    id: mid(channelId, seq), channelId, seq, hlcTs: t0 - (10 - seq) * MIN, hlcCount: 0, authorMemberId: SEO,
    type: "text", body, state: "sent", createdAtMs: t0 - (10 - seq) * MIN,
  });
  const messages = {
    [LOBBY]: [],
    [DM]: [msg(DM, 1, "점심 뭐 먹을래요?"), msg(DM, 2, "저는 국밥이 좋아요"), msg(DM, 3, "12시 반에 건물 앞에서 봐요")],
    [GEN]: [msg(GEN, 4, "다들 좋은 아침이에요"), msg(GEN, 5, "@dohyun 오늘 회의록 확인 부탁드려요")],
  };

  async function install(context) {
    await context.route("**/v1/**", async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      const method = route.request().method();
      if (path === "/v1/auth/login") return json(route, auth);
      if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
      if (path === "/v1/auth/realtime-token") {
        return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId: ME });
      }
      const inbox = path.match(/\/inbox(\/(.*))?$/);
      if (inbox) {
        const rest = inbox[2] ?? "";
        if (rest === "" && method === "GET") {
          log.inboxGets += 1;
          log.inboxGetAt.push(Date.now());
          return json(route, { items: items.map((i) => ({ ...i })), nextCursor: null, unreadCount: unread(), approvalsPending: [] });
        }
        if (rest.endsWith("/read") && method === "PUT") {
          const id = rest.replace("/read", "");
          const found = items.find((i) => i.id === id);
          if (!found) return json(route, { error: { code: "not_found", message: "inbox item not found" } }, 404);
          found.readAt ??= iso(0);
          log.itemReads.push(id);
          return json(route, { id, readAt: found.readAt, unreadCount: unread() });
        }
      }
      const put = path.match(/\/channels\/([^/]+)\/read-state$/);
      if (put && method === "PUT") {
        const body = JSON.parse(route.request().postData() ?? "{}");
        advance(put[1], Number(body.last_read_seq ?? 0));
        log.positionPuts.push(`${put[1].slice(-3)}:${body.last_read_seq}`);
        return json(route, readStateRow(byId(put[1])));
      }
      if (path.endsWith("/read-state") && method === "GET") return json(route, { read_states: channels.map(readStateRow) });
      // 예약 메시지 표면이 있는 서버: 사이드바의 예약 훅이 개인 채널(`user:read-state#…`)을 앱이 사는 동안 쥐고 있다. 그래서 받은함이 다시
      // 마운트되어도 구독이 새로 서지 않고 `onResync` 도 오지 않는다 — 실제 서버와 같은 조건이다.
      if (path.endsWith("/scheduled-messages") && method === "GET") return json(route, { scheduledMessages: [] });
      if (path.endsWith("/members/me/sidebar-prefs")) return json(route, { prefs: { version: 1, sections: [], starredChannelIds: [] } });
      if (path.endsWith("/channels")) return json(route, { channels });
      if (path.endsWith("/roster")) return json(route, { members: roster });
      if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
      if (path.endsWith("/approvals")) return json(route, { approvals: [] });
      if (path.endsWith("/agent-runs/progress")) return json(route, { runs: [] });
      if (path.endsWith("/agent-runs")) return json(route, { runs: [] });
      if (path.endsWith("/work-hosts")) return json(route, { workHosts: [] });
      if (path.endsWith("/work-sessions/shared")) return json(route, { sessions: [], nextCursor: null });
      if (path.endsWith("/work-sessions")) return json(route, { workSessions: [] });
      if (path.endsWith("/reminders")) return json(route, { reminders: [] });
      if (path.endsWith(`/workspaces/${workspaceId}`)) return json(route, { workspace: { id: workspaceId, name: "달무리 스튜디오" } });
      const listed = path.match(/\/channels\/([^/]+)\/messages$/);
      if (listed) return json(route, { messages: messages[listed[1]] ?? [] });
      if (path.includes("/messages")) return json(route, { messages: [] });
      return json(route, {});
    });
    await context.addInitScript(() => {
      window.__capSockets = [];
      class CaptureSocket {
        static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
        constructor(url) {
          this.url = String(url); this.readyState = 0; this.offsets = {};
          window.__capSockets.push(this);
          queueMicrotask(() => { this.readyState = 1; this.onopen?.(new Event("open")); });
        }
        send(data) {
          const replies = String(data).trim().split("\n").map((line) => {
            const c = JSON.parse(line);
            if (c.connect) return { id: c.id, connect: { client: "capture-5345", version: "6" } };
            if (c.subscribe) return { id: c.id, subscribe: { recoverable: true, positioned: true, recovered: false, epoch: "cap", offset: 0 } };
            return { id: c.id };
          });
          queueMicrotask(() => this.onmessage?.(new MessageEvent("message", { data: replies.map((r) => JSON.stringify(r)).join("\n") })));
        }
        close() { this.readyState = 3; this.onclose?.(new CloseEvent("close", { code: 1000 })); }
      }
      window.WebSocket = CaptureSocket;
      // 장면 C: 다른 기기가 낸 개인 채널 프레임을 이 기기에 밀어 넣는다.
      window.__push = (channel, data) => {
        for (const socket of window.__capSockets) {
          socket.offsets[channel] = (socket.offsets[channel] ?? 0) + 1;
          const frame = { push: { channel, pub: { data, offset: socket.offsets[channel] } } };
          socket.onmessage?.(new MessageEvent("message", { data: JSON.stringify(frame) }));
        }
      };
    });
  }

  return {
    install, log, advance,
    unread,
    /** 다른 기기가 그 대화를 열어 읽었다: 위치가 끝까지 가고, 인박스 이벤트는 나가지 않는다. */
    otherDeviceReadsConversation: (channelId) => advance(channelId, latest[channelId]),
    /** 다른 기기가 항목 하나만 읽음으로 눌렀다: 위치는 그대로다. */
    otherDeviceTapsItem: (id) => { items.find((i) => i.id === id).readAt ??= iso(0); },
  };
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${String(detail).slice(0, 300)}`}`);
}
/** ★ 단정: 고친 번들에서는 `ok` 가, 고치기 전 번들(EXPECT=before)에서는 `!ok`(어긋남이 난다)가 기대다. */
function bug(name, ok, detail = "") {
  if (EXPECT === "after") return check(name, ok, detail);
  return check(`[고치기 전: 어긋남이 난다] ${name}`, !ok, `어긋남이 안 났다. ${detail}`);
}
const note = (line) => console.log(`     ${line}`);

const row = (page, id) => page.locator(`[data-testid="mailbox-row"][data-entry-key="inbox:${id}"]`);
const dots = (page) => page.evaluate(() => Object.fromEntries(
  [...document.querySelectorAll('[data-testid="mailbox-row"]')].map((el) => [el.getAttribute("data-entry-key")?.slice(-1), el.getAttribute("data-unread") === "true"]),
));
const dotCount = (state) => Object.values(state).filter(Boolean).length;
const tabCount = async (page) => {
  const text = (await page.getByTestId("inbox-tab-all").textContent()) ?? "";
  const digits = text.match(/\d+/);
  return digits ? Number(digits[0]) : 0;
};
async function shot(page, name) {
  if (!SHOTS) return;
  mkdirSync(OUT_DIR, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: resolve(OUT_DIR, `5345-${TAG}-${name}.png`) });
}

async function open(browser, origin, server) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "light", locale: "ko-KR", timezoneId: "Asia/Seoul", serviceWorkers: "block", reducedMotion: "reduce" });
  await server.install(context);
  await context.addInitScript((serverBase) => { try { localStorage.setItem("momo.web.server.v1", serverBase); } catch { /* 저장소 없는 캡처 */ } }, origin);
  const page = await context.newPage();
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-item").first().waitFor({ state: "attached", timeout: 20_000 });
  await page.evaluate(() => { location.hash = "#/inbox"; });
  await page.getByTestId("inbox-route").waitFor();
  await row(page, D3).waitFor({ timeout: 15_000 });
  // 로그인 직후 착지한 화면이 보내는 읽음 광고는 이 장면이 한 일이 아니다: 여기서부터 센다.
  await page.waitForTimeout(800);
  server.log.positionPuts.length = 0;
  return { context, page };
}

async function sceneA(browser, origin) {
  console.log("--- A  같은 대화의 항목 셋 → 하나 열기 → 대화 읽기 → 받은함으로 돌아오기");
  const server = makeServer();
  const { context, page } = await open(browser, origin, server);
  try {
    const first = await dots(page);
    check("A0 받은함에 항목 넷, 모두 점이 있다 (DM 셋 + 다른 채널의 멘션)", Object.keys(first).length === 4 && dotCount(first) === 4, JSON.stringify(first));

    await row(page, D3).click();
    await page.getByTestId("inbox-detail").waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid="mailbox-row"][data-entry-key$="3"]')?.getAttribute("data-unread") === "false");
    const afterOpen = await dots(page);
    check("A1 가장 새 DM 줄을 열면 그 항목만 읽음이다 (항목 읽음 PUT 하나, 채널 위치는 그대로)",
      server.log.itemReads.length === 1 && afterOpen["3"] === false && afterOpen["2"] === true && afterOpen["1"] === true && server.log.positionPuts.length === 0,
      JSON.stringify({ afterOpen, itemReads: server.log.itemReads.length, positionPuts: server.log.positionPuts }));

    await page.getByTestId("inbox-open-conversation").click();
    await page.getByTestId("composer").waitFor({ timeout: 20_000 });
    await page.locator('[data-testid="timeline-message"][data-seq="3"]').first().waitFor({ timeout: 20_000 });
    for (let i = 0; i < 40 && server.log.positionPuts.length === 0; i += 1) await page.waitForTimeout(100);
    check("A2 대화를 열면 읽음 위치가 끝(seq 3)까지 간다", server.log.positionPuts.some((p) => p.endsWith(":3")), JSON.stringify(server.log.positionPuts));
    check("A2 서버 쪽 사실: DM 항목 셋 모두 읽음, 멘션만 안 읽음", server.unread() === 1, `unread=${server.unread()}`);
    await page.waitForTimeout(600);

    const getsBefore = server.log.inboxGets;
    const lastGetAt = server.log.inboxGetAt.at(-1);
    const backAt = Date.now();
    await page.goBack();
    await page.getByTestId("inbox-route").waitFor();
    await row(page, D3).waitFor();
    await page.waitForTimeout(1800);
    const back = await dots(page);
    const rereads = server.log.inboxGetAt.slice(getsBefore).map((t) => `${t - backAt}ms`);
    const counted = await tabCount(page);
    note(`돌아온 받은함: 점 ${JSON.stringify(back)} · 탭 수 ${counted} · 서버가 아는 안 읽음 ${server.unread()} · 마지막 읽기 후 ${((backAt - lastGetAt) / 1000).toFixed(1)}초에 돌아왔고 돌아온 뒤 목록 읽기 ${rereads.length === 0 ? "없음" : rereads.join(", ")}`);
    await shot(page, "A-back");
    bug("A3 돌아온 받은함에서 같은 대화의 항목 셋 모두 점이 없다", back["1"] === false && back["2"] === false && back["3"] === false, JSON.stringify(back));
    check("A3 다른 채널의 진짜 안 읽음(멘션)은 점이 남는다", back["4"] === true, JSON.stringify(back));
    bug("A3 탭의 안 읽음 수가 서버가 아는 수와 같다", counted === server.unread(), `탭 ${counted} · 서버 ${server.unread()}`);
  } finally {
    await context.close();
  }
}

async function sceneB(browser, origin) {
  console.log("--- B  다른 기기가 그 대화를 읽는다 (위치 전진, 인박스 이벤트 없음) · 이 기기는 받은함을 연 채");
  const server = makeServer();
  const { context, page } = await open(browser, origin, server);
  try {
    const first = await dots(page);
    check("B0 받은함에 점 넷", dotCount(first) === 4, JSON.stringify(first));
    server.otherDeviceReadsConversation(DM);
    const startedAt = Date.now();
    let cleared = false;
    while (Date.now() - startedAt < POLL_WAIT_MS) {
      await page.waitForTimeout(500);
      const now = await dots(page);
      if (DM_ITEMS.every((id) => now[id.slice(-1)] === false)) { cleared = true; break; }
    }
    const after = await dots(page);
    note(`다른 기기가 읽은 뒤 ${((Date.now() - startedAt) / 1000).toFixed(1)}초: 점 ${JSON.stringify(after)}, 탭 수 ${await tabCount(page)}`);
    await shot(page, "B-other-device");
    bug(`B1 읽음 위치 투영이 다시 읽히는 주기 안에(${POLL_WAIT_MS / 1000}초) DM 항목 셋의 점이 꺼진다`, cleared, JSON.stringify(after));
    check("B1 멘션(다른 채널)은 점이 남는다", after["4"] === true, JSON.stringify(after));
    await page.waitForTimeout(1500);
    const counted = await tabCount(page);
    bug("B2 탭의 안 읽음 수가 서버가 아는 수와 같다", counted === server.unread(), `탭 ${counted} · 서버 ${server.unread()}`);
  } finally {
    await context.close();
  }
}

async function sceneC(browser, origin) {
  console.log("--- C  다른 기기가 항목 하나만 읽음으로 누른다 (inbox_item.read 프레임)");
  const server = makeServer();
  const { context, page } = await open(browser, origin, server);
  try {
    await page.waitForTimeout(600); // 개인 채널 구독이 선 뒤.
    server.otherDeviceTapsItem(M1);
    const memberChannel = `user:read-state#${ME.toUpperCase()}`;
    await page.evaluate(([channel, itemId]) => window.__push(channel, { type: "inbox_item.read", payload: { item_id: itemId } }), [memberChannel, M1]);
    let cleared = false;
    for (let i = 0; i < 40 && !cleared; i += 1) {
      await page.waitForTimeout(150);
      cleared = (await dots(page))["4"] === false;
    }
    const after = await dots(page);
    check("C1 항목 하나만 읽은 다른 기기의 신호를 받으면 그 줄의 점이 꺼진다 (원래 맞던 길)", cleared && after["1"] === true, JSON.stringify(after));
  } finally {
    await context.close();
  }
}

async function main() {
  const preview = await startGuardedPreview({
    webRoot: WEB_ROOT,
    port: PORT,
    portEnvVar: "CAPTURE_PORT",
    ...(DIST_DIR ? { extraArgs: ["--outDir", resolve(DIST_DIR)] } : {}),
  });
  const browser = await chromium.launch();
  try {
    console.log(`--- chromium (${EXPECT})`);
    await sceneA(browser, preview.origin);
    await sceneC(browser, preview.origin);
    await sceneB(browser, preview.origin);
  } finally {
    await browser.close();
    await preview.stop?.();
  }
  const bad = results.filter((r) => !r.ok);
  console.log(`INBOX-DOT-5345 ${EXPECT} ${bad.length === 0 ? "PASS" : "FAIL"} (${results.length} checks${bad.length ? `, ${bad.length} failed` : ""})`);
  if (bad.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
