#!/usr/bin/env node
// =============================================================================
// CAPTURE (#4215, ADR-0208 부록 B): 예약 메시지 웹·데스크탑 화면 상태 8개.
//
//   후: npm run build && node scripts/capture-4215.mjs
//   전: BEFORE=1 DIST_DIR=<변경 전 번들> node scripts/capture-4215.mjs     # 단언 없이 보이는 것만 적는다
//   일부만: SCENES=s1,s2 node scripts/capture-4215.mjs
//
// 서버(#4214)는 이 트리에 없다: `/v1/**` 는 계약대로 움직이는 **가짜 서버**(runtime-unverified)이고, 예약 상태는 메모리에 산다.
// 시계는 고정한다(2026-10-22 목 14:30 KST, `page.clock.setFixedTime`): 「내일 오전 9:00」·「곧 보내요」가 캡처마다 같다.
//
// 장면 (라이트·다크 x 1440, 폭 장면은 1280·900·접힌 사이드바·320 스레드 패널):
//   s1 기본          보낼 내용이 있을 때 / 없을 때(둘 다 흐림, ▾는 포커스를 받고 누르면 이유를 말한다)
//   s2 메뉴 열림      둘째 항목 있음 / 일요일(둘째 없음) / 한도(항목 흐림 + 한도 문장)
//   s3 직접 고르기     처음 값 / 오류 줄(1분 안)
//   s4 예약 직후      배너 + 3초 상태줄 / 프리셋 실패 → 직접 고르기에 오류 줄
//   s5 배너          대기(채널) · 대기(대화) · 스레드 · 실패
//   s6 목록          실패 구역 + 보낼 예정(곧 보내요·긴 이름·알 수 없는 채널)
//   s7 실패          missed · not_member · sessions_ended + 내용 확인(지우기 확인 줄)
//   s8 오프라인       입력창 · 목록 · 대화상자 안의 줄 · 거는 도중 끊김(같은 clientRequestId로 다시)
//   w  폭            1280 · 900 · 접힌 사이드바: 입력창(▾가 보내기에 붙어 있다)·배너·메뉴
//   p  폰 폭(390)     입력창의 3초 줄(막힌 ▾의 이유·예약 확정·예약을 끈 서버)이 그릇 위에 서고 잘리지 않는다
//   s9 보충          비밀 키 줄 · 예약을 끈 서버(흐린 ▾와 이유) · 요청 중(예약 중) · 이벤트로만 안 행(뼈대 막대)
//   (s7 안에 이벤트 장면이 있다: 개인 채널 신호로 sessions_ended가 멈춘 즉시 배너·알약·목록에 선다, owner 결정 6)
// 단언이 하나라도 실패하면(후 판에서) 종료 코드 1이다.
// =============================================================================

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BEFORE = process.env.BEFORE === "1";
const DIST_DIR = process.env.DIST_DIR ? resolve(process.env.DIST_DIR) : resolve(WEB_ROOT, "dist");
const OUT_DIR = process.env.OUT_DIR
  ? resolve(process.env.OUT_DIR)
  : resolve(WEB_ROOT, BEFORE ? "captures/4215/before" : "captures/4215");
const PORT = Number(process.env.CAPTURE_PORT || 5415);
const WANT = new Set((process.env.SCENES || "s1,s2,s3,s4,s5,s6,s7,s8,s9,w,p").split(",").map((s) => s.trim()));

const ORIGIN = "https://oort.yeomyeonggeori.test";
// 2026-10-22(목) 14:30 KST. 명세의 예시(「내일 오전 9:00, 10월 23일 금요일」)가 이 날을 기준으로 쓰였다.
const NOW = new Date("2026-10-22T14:30:00+09:00").getTime();
const SUNDAY = new Date("2026-10-25T22:00:00+09:00").getTime();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const workspaceId = "00000000-0000-7000-8000-000000000001";
const me = "00000000-0000-7000-8000-000000000101";
const kim = "00000000-0000-7000-8000-000000000102";
const park = "00000000-0000-7000-8000-000000000103";
const chGeneral = "00000000-0000-7000-8000-000000000201";
const chDeploy = "00000000-0000-7000-8000-000000000202";
const chLong = "00000000-0000-7000-8000-000000000203";
const chDm = "00000000-0000-7000-8000-000000000204";
const chGone = "00000000-0000-7000-8000-0000000002ff"; // 목록에 없는 채널(나간 비공개 채널)
const rootMsg = "00000000-0000-7000-8000-000000000301";

const channels = [
  { id: chGeneral, workspaceId, kind: "public", name: "일반", muted: false },
  { id: chDeploy, workspaceId, kind: "public", name: "배포", muted: false },
  { id: chLong, workspaceId, kind: "public", name: "제품-디자인-리뷰-공유-채널-분기-계획-논의-2026-4분기", muted: false },
  { id: chDm, workspaceId, kind: "dm", muted: false, memberIds: [me, kim] },
];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: me, workspaceId, kind: "human", displayName: "박서연", handle: "seoyeon" },
  realtimeWebSocketUrl: "ws://capture-4215.invalid/connection/websocket",
};
const member = (id, over) => ({
  id, workspaceId, kind: "human", status: "active", role: "member", displayName: "", handle: "",
  channelCount: 3, channelIds: [chGeneral, chDeploy, chLong], capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...over,
});
const roster = [
  member(me, { role: "owner", displayName: "박서연", handle: "seoyeon" }),
  member(kim, { kind: "agent", displayName: "김인턴", handle: "kim-intern", ownerHumanId: me }),
  member(park, { displayName: "이도현", handle: "dohyun" }),
];

function message(over) {
  return { channelId: chGeneral, hlcCount: 0, type: "text", state: "sent", ...over, hlcTs: over.createdAtMs };
}
const timeline = [
  message({ id: "0199aaaa-0000-7000-8000-000000000001", seq: 1, authorMemberId: park, createdAtMs: NOW - 3 * HOUR, body: "내일 배포 전에 체크리스트 한 번만 같이 봐 주세요. 마이그레이션 144번이 들어가요." }),
  message({ id: "0199aaaa-0000-7000-8000-000000000002", seq: 2, authorMemberId: me, createdAtMs: NOW - 2 * HOUR, body: "확인했어요. 롤백 계획은 Notion에 있고, staging에서 한 번 돌려 봤어요." }),
  message({
    id: rootMsg, seq: 3, authorMemberId: park, createdAtMs: NOW - HOUR,
    body: "금요일 배포 공지 초안이에요. 이대로 올려도 될까요?",
    thread: { reply_count: 2, last_reply_seq: 5, last_reply_at: NOW - 30 * 60_000 },
  }),
];

// ---- 가짜 서버의 예약 세계 ------------------------------------------------------------------------------
let rowSerial = 0;
function scheduledRow(over) {
  rowSerial += 1;
  const sendAtMs = over.sendAtMs ?? NOW + DAY;
  const status = over.status ?? "pending";
  return {
    id: `00000000-0000-7000-8000-0000000004${String(rowSerial).padStart(2, "0")}`,
    workspaceId, memberId: me, channelId: chGeneral, body: "내일 회의 전에 자료 올려 둘게요",
    sendAtMs, status, rev: 0, createdAtMs: NOW - 2 * HOUR, updatedAtMs: NOW - 2 * HOUR,
    ...(status === "pending" ? { editableUntilMs: sendAtMs - 30_000 } : {}),
    ...over,
  };
}
const world = {
  scheduled: [],
  createMode: "ok", // ok | too_soon | disabled | network | hang(응답을 끝내 주지 않는다)
  sendNowMode: "ok", // ok | not_member
  listMode: "ok", // ok | 404(이 서버에는 예약이 없다) | 500(장애) | hang(로딩에 머문다)
  listDelayMs: 0, // 첫 읽기 뒤의 읽기를 늦춘다(이벤트로만 안 행의 뼈대 막대가 보이도록)
  listReads: 0,
  creates: [],
  sendNows: [],
};
function resetWorld(rows = []) {
  rowSerial = 0;
  world.scheduled = rows.map((over) => scheduledRow(over));
  world.createMode = "ok";
  world.sendNowMode = "ok";
  world.listMode = "ok";
  world.listDelayMs = 0;
  world.listReads = 0;
  world.creates.length = 0;
  world.sendNows.length = 0;
}

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}
const apiError = (route, status, code, message = "capture") => json(route, { error: { ...(code ? { code } : {}), message } }, status);

async function handleApi(route, request, url) {
  const method = request.method();
  const path = url.pathname;
  if (path === "/v1/auth/login") return json(route, auth);
  if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
  if (path === "/v1/auth/realtime-token") {
    return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId: me });
  }
  const base = `/v1/workspaces/${workspaceId}`;
  // ---- 예약 메시지 (openapi `scheduled-messages`) ----
  if (path === `${base}/scheduled-messages` && method === "GET") {
    world.listReads += 1;
    if (world.listMode === "404") return apiError(route, 404, undefined, "not found");
    if (world.listMode === "500") return apiError(route, 500, undefined, "boom");
    if (world.listMode === "hang") return new Promise(() => {});
    if (world.listDelayMs > 0 && world.listReads > 1) await new Promise((done) => setTimeout(done, world.listDelayMs));
    const open = world.scheduled
      .filter((r) => r.status === "pending" || r.status === "failed")
      .sort((a, b) => a.sendAtMs - b.sendAtMs || (a.id < b.id ? -1 : 1));
    return json(route, { scheduledMessages: open });
  }
  const create = path.match(new RegExp(`^${base}/channels/([^/]+)/scheduled-messages$`));
  if (create && method === "POST") {
    const body = JSON.parse(request.postData() ?? "{}");
    world.creates.push({ channelId: create[1], body });
    if (world.createMode === "network") return route.abort("failed");
    if (world.createMode === "hang") return new Promise(() => {});
    if (world.createMode === "disabled") return apiError(route, 503, "scheduler_disabled");
    if (world.createMode === "too_soon") return apiError(route, 400, "send_at_too_soon");
    const row = scheduledRow({
      channelId: create[1], body: body.body ?? "", sendAtMs: body.sendAtMs,
      ...(body.rootId ? { rootId: body.rootId } : {}),
    });
    world.scheduled.push(row);
    return json(route, { scheduledMessage: row }, 201);
  }
  const item = path.match(new RegExp(`^${base}/scheduled-messages/([^/]+)(/send-now)?$`));
  if (item) {
    const row = world.scheduled.find((r) => r.id === item[1]);
    if (!row) return apiError(route, 404, undefined, "not found");
    if (item[2] && method === "POST") {
      world.sendNows.push(row.id);
      if (world.sendNowMode === "not_member") return apiError(route, 409, "not_member");
      const sent = { ...row, status: "sent", rev: row.rev + 1, sentMessageId: "m", sentAtMs: NOW };
      delete sent.body;
      world.scheduled = world.scheduled.filter((r) => r.id !== row.id);
      return json(route, { scheduledMessage: sent });
    }
    if (method === "PATCH") {
      const body = JSON.parse(request.postData() ?? "{}");
      Object.assign(row, { rev: row.rev + 1, ...(body.body !== undefined ? { body: body.body } : {}) });
      if (body.sendAtMs !== undefined) {
        Object.assign(row, { sendAtMs: body.sendAtMs, status: "pending", editableUntilMs: body.sendAtMs - 30_000 });
        delete row.failureReason;
      }
      return json(route, { scheduledMessage: row });
    }
    if (method === "DELETE") {
      world.scheduled = world.scheduled.filter((r) => r.id !== row.id);
      return route.fulfill({ status: 204 });
    }
  }
  // ---- 작업 공간의 나머지(배너 소음이 없게 비어 있거나 404) ----
  if (path.endsWith("/cohosted-agent")) return apiError(route, 404, "not_found");
  if (path.endsWith("/channels")) return json(route, { channels });
  if (path.endsWith("/roster")) return json(route, { members: roster });
  if (path.endsWith("/read-state")) return json(route, { read_states: [] });
  if (path.endsWith("/hosted-agent-connections")) return json(route, { connections: [] });
  if (path.endsWith("/webhooks")) return json(route, { installations: [] });
  if (path.endsWith("/event-subscriptions")) return json(route, { eventSubscriptions: [] });
  if (path.endsWith("/unfurl-settings")) return json(route, { enabled: true });
  if (path.endsWith("/huddles/active")) return json(route, { huddle: null, participants: [] });
  if (path.endsWith("/work-hosts")) return json(route, { workHosts: [] });
  if (path.endsWith("/work-sessions/shared")) return json(route, { sessions: [], nextCursor: null });
  if (path.endsWith("/work-sessions")) return json(route, { workSessions: [] });
  if (path.endsWith("/inbox")) return json(route, { items: [], nextCursor: null, unreadCount: 0, approvalsPending: 0 });
  if (path.endsWith("/approvals")) return json(route, { approvals: [] });
  if (path.endsWith("/reminders")) return json(route, { reminders: [] });
  if (path.endsWith("/presence")) return json(route, { statuses: [] });
  if (path.includes("/replies")) {
    return json(route, {
      messages: [
        message({ id: "0199aaaa-0000-7000-8000-000000000004", seq: 4, authorMemberId: me, createdAtMs: NOW - 40 * 60_000, rootId: rootMsg, body: "제목은 「금요일 배포」로 하고 롤백 링크를 맨 아래에 넣을게요." }),
        message({ id: "0199aaaa-0000-7000-8000-000000000005", seq: 5, authorMemberId: park, createdAtMs: NOW - 30 * 60_000, rootId: rootMsg, body: "좋아요. 그대로 가요." }),
      ],
    });
  }
  if (path.includes("/messages")) {
    const channelId = path.match(/\/channels\/([^/]+)\/messages/)?.[1];
    return json(route, { messages: channelId === chGeneral ? timeline : [] });
  }
  if (path.endsWith(`/workspaces/${workspaceId}`)) {
    return json(route, { workspace: { id: workspaceId, name: "달무리 스튜디오", slug: "team", updatedAtMs: 1, roleLabels: {}, welcomeAgentMemberId: null, welcomePrompt: "", subscriptionAgentsEnabled: true } });
  }
  return json(route, {});
}

async function installFakeOrigin(context, localOrigin) {
  await context.route(`${ORIGIN}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.startsWith("/v1/")) return handleApi(route, request, url);
    const response = await context.request.get(`${localOrigin}${url.pathname}${url.search}`);
    return route.fulfill({ response });
  });
}

async function installRealtime(page) {
  await page.addInitScript(() => {
    const sockets = [];
    class CaptureSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      constructor(url) {
        this.url = String(url);
        this.readyState = 0;
        this.channels = [];
        this.offsets = {};
        sockets.push(this);
        queueMicrotask(() => { this.readyState = 1; this.onopen?.(new Event("open")); });
      }
      send(data) {
        const replies = String(data).trim().split("\n").map((line) => {
          const c = JSON.parse(line);
          if (c.connect) return { id: c.id, connect: { client: "capture-4215", version: "6" } };
          if (c.subscribe) {
            this.channels.push(c.subscribe.channel);
            return { id: c.id, subscribe: { recoverable: true, positioned: true, recovered: false, epoch: "cap", offset: 0 } };
          }
          return { id: c.id };
        });
        queueMicrotask(() => this.onmessage?.(new MessageEvent("message", { data: replies.map((r) => JSON.stringify(r)).join("\n") })));
      }
      close() { this.readyState = 3; this.onclose?.(new CloseEvent("close", { code: 1000 })); }
    }
    window.WebSocket = CaptureSocket;
    // 서버가 개인 채널에 발행하는 일을 흉내 낸다: 구독한 채널 중 접두사가 맞는 곳으로 발행물 한 건을 민다.
    window.__capturePush = (channelPrefix, data) => {
      let delivered = 0;
      for (const socket of sockets) {
        for (const channel of new Set(socket.channels)) {
          if (!channel.startsWith(channelPrefix)) continue;
          socket.offsets[channel] = (socket.offsets[channel] ?? 0) + 1;
          const frame = { push: { channel, pub: { data, offset: socket.offsets[channel] } } };
          socket.onmessage?.(new MessageEvent("message", { data: JSON.stringify(frame) }));
          delivered += 1;
        }
      }
      return delivered;
    };
  });
}

const failures = [];
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), ...(ok || detail === "" ? {} : { detail: String(detail).slice(0, 300) }) });
  if (BEFORE) {
    console.log(`info ${name}: ${ok ? "예" : "아니오"}`);
    return;
  }
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok) failures.push(name);
}
/** 한 문장이 줄마다 차지한 폭(px). 줄이 둘이면 둘째가 홀로 짧게 남는지 잰다. */
const lineWidths = (page, selector) => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  if (!el) return [];
  const range = document.createRange();
  range.selectNodeContents(el);
  const byTop = new Map();
  for (const r of range.getClientRects()) {
    if (r.width <= 0) continue;
    const key = Math.round(r.top);
    const cur = byTop.get(key);
    byTop.set(key, cur ? { l: Math.min(cur.l, r.left), r: Math.max(cur.r, r.right) } : { l: r.left, r: r.right });
  }
  return [...byTop.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => Math.round(v.r - v.l));
}, selector);
const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const textOf = async (page, testId) => ((await page.getByTestId(testId).first().textContent()) ?? "").replace(/\s+/g, " ").trim();
const has = async (page, testId) => (await page.getByTestId(testId).count()) > 0;
/** 한 줄 안에서 칸으로 나뉜 글을 칸 사이를 한 칸 띄워 읽는다(`textContent`는 칸 사이의 간격을 모른다). */
const joined = async (page, testId) => (await page.getByTestId(testId).first().locator("span").allTextContents()).join(" ").replace(/\s+/g, " ").trim();

async function must(page, testId, timeout = 25_000) {
  try {
    await page.getByTestId(testId).first().waitFor({ timeout });
  } catch (error) {
    mkdirSync(OUT_DIR, { recursive: true });
    await page.screenshot({ path: resolve(OUT_DIR, `debug-${testId}.png`) }).catch(() => {});
    const text = ((await page.textContent("body").catch(() => "")) ?? "").replace(/\s+/g, " ").slice(0, 400);
    console.log(`기다린 칸 ${testId} 이(가) 서지 않았다. 주소 ${await page.evaluate(() => location.href.split("#")[0])} 글자: ${text}`);
    throw error;
  }
}

async function open(browser, localOrigin, scheme, viewport, { fixedAt = NOW, hash = "", offline = false, init = null } = {}) {
  const context = await browser.newContext({
    viewport, colorScheme: scheme, reducedMotion: "reduce", serviceWorkers: "block",
    locale: "ko-KR", timezoneId: "Asia/Seoul",
  });
  await installFakeOrigin(context, localOrigin);
  const page = await context.newPage();
  page.on("pageerror", (error) => console.log(`pageerror: ${error.message}`));
  await page.clock.setFixedTime(fixedAt);
  await installRealtime(page);
  if (init) await page.addInitScript(init);
  await page.addInitScript((server) => { try { localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ } }, ORIGIN);
  await page.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("nav-ai").waitFor({ timeout: 25_000 });
  if (hash) await page.evaluate((h) => { location.hash = h; }, hash);
  if (offline) {
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  }
  return { context, page };
}

const shot = async (page, name, tag) => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: resolve(OUT_DIR, `${name}-${tag}.png`) });
};

async function type(page, testId, value) {
  const area = page.getByTestId(testId);
  await area.click();
  await area.fill(value);
}

async function openChannel(page, channelId = chGeneral) {
  await page.evaluate((id) => { location.hash = `/c/${id}`; }, channelId);
  await must(page, "composer");
  await page.getByTestId("composer-schedule-trigger").waitFor({ timeout: 10_000 }).catch(() => {});
}

// ---- s1 기본 ------------------------------------------------------------------------------------------
async function sceneDefault(browser, origin, scheme, viewport) {
  const tag = `${viewport.width}-${scheme}`;
  resetWorld();
  const { context, page } = await open(browser, origin, scheme, viewport);
  await openChannel(page);
  await type(page, "composer-input", "내일 회의 전에 자료 올려 둘게요");
  const trigger = page.getByTestId("composer-schedule-trigger");
  if (!BEFORE) {
    check(`${tag} s1 보낼 내용이 있으면 ▾가 서 있다`, await trigger.isVisible());
    check(`${tag} s1 ▾ 이름은 「예약해서 보내기」`, (await trigger.getAttribute("aria-label")) === "예약해서 보내기");
    check(`${tag} s1 막히지 않으면 aria-disabled가 없다`, (await trigger.getAttribute("aria-disabled")) === null);
  }
  await shot(page, "s1-default", tag);
  // 보낼 내용이 없을 때: 둘 다 흐림, ▾는 포커스를 받고 누르면 이유를 메타 슬롯에 3초 말한다.
  await page.getByTestId("composer-input").fill("");
  if (!BEFORE) {
    check(`${tag} s1 빈 입력: ▾가 aria-disabled`, (await trigger.getAttribute("aria-disabled")) === "true");
    await trigger.focus();
    check(`${tag} s1 빈 입력: ▾가 포커스를 받는다`, await trigger.evaluate((el) => el === document.activeElement));
    // `aria-disabled` 단추는 사용자가 누를 수 있다. Playwright는 그것을 「활성이 아니다」로 읽어 막으므로 force로 누른다.
    await trigger.click({ force: true });
    await page.waitForTimeout(150);
    check(`${tag} s1 빈 입력: 누르면 이유를 말한다`, (await textOf(page, "composer-status-line")) === "보낼 내용을 쓰면 예약할 수 있어요", await textOf(page, "composer-status").catch(() => ""));
    check(`${tag} s1 빈 입력: 메뉴는 열리지 않는다`, !(await has(page, "composer-schedule-menu")));
    await shot(page, "s1-empty-reason", tag);
    check(`${tag} 가로 넘침 0 (기본)`, (await overflowX(page)) === 0);
  } else {
    await shot(page, "s1-empty", tag);
  }
  await context.close();
}

// ---- s2 메뉴 ------------------------------------------------------------------------------------------
async function sceneMenu(browser, origin, scheme, viewport) {
  const tag = `${viewport.width}-${scheme}`;
  if (BEFORE) return;
  // 목: 둘째 항목 있음
  resetWorld();
  let { context, page } = await open(browser, origin, scheme, viewport);
  await openChannel(page);
  await type(page, "composer-input", "내일 회의 전에 자료 올려 둘게요");
  await page.getByTestId("composer-schedule-trigger").click();
  await must(page, "composer-schedule-menu", 5000);
  const items = await page.getByTestId("composer-schedule-menu").locator('[role="menuitem"]').allTextContents();
  check(`${tag} s2 항목: 내일 · 다음 주 월요일 · 직접 고르기…`, items.length === 3, JSON.stringify(items));
  check(`${tag} s2 내일 오전 9:00 + 10월 23일 (금)`, (await joined(page, "composer-schedule-preset-tomorrow")) === "내일 오전 9:00 10월 23일 (금)", await joined(page, "composer-schedule-preset-tomorrow"));
  check(`${tag} s2 둘째: 다음 주 월요일 오전 9:00 + 10월 26일 (월)`, (await joined(page, "composer-schedule-preset-next-monday")) === "다음 주 월요일 오전 9:00 10월 26일 (월)", await joined(page, "composer-schedule-preset-next-monday"));
  check(`${tag} s2 시간대 안내 줄`, (await textOf(page, "composer-schedule-zone")) === "Asia/Seoul (UTC+9) 기준이에요");
  check(`${tag} s2 첫 항목에 초점`, await page.getByTestId("composer-schedule-preset-tomorrow").evaluate((el) => el === document.activeElement));
  await shot(page, "s2-menu", tag);
  await context.close();

  // 일요일: 둘째가 없다
  resetWorld();
  ({ context, page } = await open(browser, origin, scheme, viewport, { fixedAt: SUNDAY }));
  await openChannel(page);
  await type(page, "composer-input", "월요일 아침에 보낼 글");
  await page.getByTestId("composer-schedule-trigger").click();
  await must(page, "composer-schedule-menu", 5000);
  check(`${tag} s2 일요일: 다음 주 월요일 항목이 없다`, !(await has(page, "composer-schedule-preset-next-monday")));
  check(`${tag} s2 일요일: 내일 오전 9:00은 있다`, await has(page, "composer-schedule-preset-tomorrow"));
  await shot(page, "s2-menu-sunday", tag);
  await context.close();

  // 한도: 항목이 흐리고 한도 문장이 맨 위
  resetWorld(Array.from({ length: 50 }, (_, i) => ({ sendAtMs: NOW + DAY + i * 60_000 })));
  ({ context, page } = await open(browser, origin, scheme, viewport));
  await openChannel(page);
  await type(page, "composer-input", "한도에 닿은 뒤의 글");
  await page.getByTestId("composer-schedule-trigger").click();
  await must(page, "composer-schedule-menu", 5000);
  check(`${tag} s2 한도: 메뉴는 열린다`, await has(page, "composer-schedule-limit"));
  check(`${tag} s2 한도 문장`, (await textOf(page, "composer-schedule-limit")) === "예약은 50개까지 걸 수 있어요. 대기 중인 예약을 지우거나 지금 보낸 뒤에 다시 해 보세요.");
  const dim = await page.getByTestId("composer-schedule-menu").locator('[role="menuitem"]').evaluateAll((els) => els.map((el) => [el.getAttribute("aria-disabled"), el.getAttribute("data-disabled")]));
  check(`${tag} s2 한도: 항목은 aria-disabled이고 disabled가 아니다(키보드가 닿는다)`, dim.every(([aria, data]) => aria === "true" && data === null), JSON.stringify(dim));
  await page.keyboard.press("ArrowDown");
  check(`${tag} s2 한도: 흐린 항목에 키보드가 닿는다`, await page.evaluate(() => document.activeElement?.getAttribute("aria-disabled") === "true"));
  await shot(page, "s2-menu-limit", tag);
  await context.close();
}

// ---- s3 직접 고르기 ---------------------------------------------------------------------------------------
async function sceneCustom(browser, origin, scheme, viewport) {
  const tag = `${viewport.width}-${scheme}`;
  if (BEFORE) return;
  resetWorld();
  const { context, page } = await open(browser, origin, scheme, viewport);
  await openChannel(page);
  await type(page, "composer-input", "내일 회의 전에 자료 올려 둘게요");
  await page.getByTestId("composer-schedule-trigger").click();
  await must(page, "composer-schedule-menu", 5000);
  await page.getByTestId("composer-schedule-custom").click();
  await must(page, "schedule-dialog", 5000);
  check(`${tag} s3 처음 값은 내일 오전 9:00`, (await page.getByTestId("schedule-dialog-date").inputValue()) === "2026-10-23" && (await page.getByTestId("schedule-dialog-time").inputValue()) === "09:00");
  check(`${tag} s3 결과 문장`, (await textOf(page, "schedule-dialog-result")) === "내일 오전 9:00에 보내요", await textOf(page, "schedule-dialog-result"));
  check(`${tag} s3 시간대 줄`, (await textOf(page, "schedule-dialog-zone")) === "Asia/Seoul (UTC+9) 기준이에요");
  check(`${tag} s3 초점은 날짜 칸`, await page.getByTestId("schedule-dialog-date").evaluate((el) => el === document.activeElement));
  await shot(page, "s3-custom", tag);
  // 오류 줄: 지금 + 1분 미만
  await page.getByTestId("schedule-dialog-date").fill("2026-10-22");
  await page.getByTestId("schedule-dialog-time").fill("14:30");
  await page.getByTestId("schedule-dialog-commit").click();
  check(`${tag} s3 1분 안: 오류 줄`, (await textOf(page, "schedule-dialog-error")) === "1분 뒤부터 예약할 수 있어요", await textOf(page, "schedule-dialog-error").catch(() => ""));
  check(`${tag} s3 오류 줄은 role=alert`, (await page.getByTestId("schedule-dialog-error").getAttribute("role")) === "alert");
  check(`${tag} 서버에는 아무것도 가지 않았다`, world.creates.length === 0);
  await shot(page, "s3-custom-error", tag);
  check(`${tag} 가로 넘침 0 (직접 고르기)`, (await overflowX(page)) === 0);
  await context.close();
}

// ---- s4 예약 직후 -----------------------------------------------------------------------------------------
async function sceneAfter(browser, origin, scheme, viewport) {
  const tag = `${viewport.width}-${scheme}`;
  if (BEFORE) return;
  resetWorld();
  let { context, page } = await open(browser, origin, scheme, viewport);
  await openChannel(page);
  await type(page, "composer-input", "내일 회의 전에 자료 올려 둘게요");
  await page.getByTestId("composer-schedule-trigger").click();
  await must(page, "composer-schedule-menu", 5000);
  await page.getByTestId("composer-schedule-preset-tomorrow").click();
  await must(page, "composer-scheduled-banner", 5000);
  await page.waitForTimeout(250);
  check(`${tag} s4 서버가 받았다: 내일 오전 9:00`, world.creates.length === 1 && world.creates[0].body.sendAtMs === new Date("2026-10-23T09:00:00+09:00").getTime(), JSON.stringify(world.creates));
  check(`${tag} s4 요청에 clientRequestId가 있다`, typeof world.creates[0]?.body.clientRequestId === "string");
  check(`${tag} s4 입력창은 비워졌다`, (await page.getByTestId("composer-input").inputValue()) === "");
  check(`${tag} s4 상태줄: 응답의 시각으로`, (await textOf(page, "composer-status-line")) === "내일 오전 9:00에 보낼게요", await textOf(page, "composer-status-line").catch(() => ""));
  check(`${tag} s4 상태줄 낭독 노드는 늘 붙어 있다`, (await page.getByTestId("composer-status").getAttribute("role")) === "status");
  check(`${tag} s4 배너(대기): 이 채널에 예약된 메시지 1개`, (await textOf(page, "composer-scheduled-banner")).startsWith("이 채널에 예약된 메시지 1개"), await textOf(page, "composer-scheduled-banner"));
  check(`${tag} s4 입력창으로 초점이 돌아와 있다`, await page.evaluate(() => document.activeElement?.getAttribute("data-testid") === "composer-input"));
  await shot(page, "s4-after", tag);
  check(`${tag} 가로 넘침 0 (예약 직후)`, (await overflowX(page)) === 0);
  // 3초 뒤 원래 줄로 돌아간다. 배너는 남는다.
  await page.waitForTimeout(3300);
  check(`${tag} s4 3초 뒤 상태줄이 걷힌다`, !(await has(page, "composer-status-line")));
  check(`${tag} s4 배너는 남는다`, await has(page, "composer-scheduled-banner"));
  await context.close();

  // 프리셋이 실패하면 같은 시각이 채워진 직접 고르기가 열려 오류 줄이 이유를 말한다
  resetWorld();
  world.createMode = "too_soon";
  ({ context, page } = await open(browser, origin, scheme, viewport));
  await openChannel(page);
  await type(page, "composer-input", "내일 회의 전에 자료 올려 둘게요");
  await page.getByTestId("composer-schedule-trigger").click();
  await must(page, "composer-schedule-menu", 5000);
  await page.getByTestId("composer-schedule-preset-tomorrow").click();
  await must(page, "schedule-dialog", 5000);
  check(`${tag} s4 프리셋 실패: 직접 고르기가 같은 시각으로 열린다`, (await page.getByTestId("schedule-dialog-date").inputValue()) === "2026-10-23" && (await page.getByTestId("schedule-dialog-time").inputValue()) === "09:00");
  check(`${tag} s4 프리셋 실패: 오류 줄이 이유를 말한다`, (await textOf(page, "schedule-dialog-error")) === "1분 뒤부터 예약할 수 있어요", await textOf(page, "schedule-dialog-error").catch(() => ""));
  check(`${tag} s4 프리셋 실패: 글은 그대로다`, (await page.getByTestId("composer-input").inputValue()) === "내일 회의 전에 자료 올려 둘게요");
  await shot(page, "s4-preset-failed", tag);
  await context.close();
}


// ---- s5 배너 ------------------------------------------------------------------------------------------
async function sceneBanners(browser, origin, scheme, viewport) {
  const tag = `${viewport.width}-${scheme}`;
  if (BEFORE) return;
  // (a) 채널: 대기 둘
  resetWorld([{ sendAtMs: NOW + DAY }, { sendAtMs: NOW + 2 * DAY, body: "다음 주 회의 안건 정리" }]);
  let { context, page } = await open(browser, origin, scheme, viewport);
  await openChannel(page);
  await must(page, "composer-scheduled-banner", 10_000);
  check(`${tag} s5 (a) 채널: 이 채널에 예약된 메시지 2개`, (await textOf(page, "composer-scheduled-banner")).startsWith("이 채널에 예약된 메시지 2개"), await textOf(page, "composer-scheduled-banner"));
  check(`${tag} s5 (a) 대기 배너는 role=status`, (await page.getByTestId("composer-scheduled-banner").getAttribute("role")) === "status");
  check(`${tag} s5 (a) 「보기」 단추`, (await page.getByTestId("composer-scheduled-banner").getByRole("button").textContent()) === "보기");
  check(`${tag} s5 사이드바: 「예약됨」 줄이 서고 알약은 없다(대기는 세지 않는다)`, (await has(page, "nav-scheduled")) && !(await page.getByTestId("nav-scheduled").getByTestId("mention-badge").count()));
  await shot(page, "s5-banner-channel", tag);
  // 「보기」: 그 채널로 거른 목록
  await page.getByTestId("composer-scheduled-banner").getByRole("button", { name: "보기" }).click();
  await must(page, "scheduled-route", 5000);
  check(`${tag} s5 「보기」는 그 채널로 거른 목록을 연다`, (await page.evaluate(() => location.hash)).includes(`channel=${chGeneral}`), await page.evaluate(() => location.hash));
  check(`${tag} s5 거른 목록 머리: 「#일반 예약만 보고 있어요」`, (await textOf(page, "scheduled-filter")).startsWith("#일반 예약만 보고 있어요"), await textOf(page, "scheduled-filter").catch(() => ""));
  check(`${tag} s5 거른 목록: 두 행`, (await page.getByTestId("scheduled-row").count()) === 2);
  await shot(page, "s5-filtered-list", tag);
  await context.close();

  // (a) 대화(DM)
  resetWorld([{ channelId: chDm, body: "어제 회의록 정리해서 보내 줘", sendAtMs: NOW + 4 * DAY }]);
  ({ context, page } = await open(browser, origin, scheme, viewport));
  await openChannel(page, chDm);
  await must(page, "composer-scheduled-banner", 10_000);
  check(`${tag} s5 (a) 대화: 이 대화에 예약된 메시지 1개`, (await textOf(page, "composer-scheduled-banner")).startsWith("이 대화에 예약된 메시지 1개"), await textOf(page, "composer-scheduled-banner"));
  await shot(page, "s5-banner-dm", tag);
  await context.close();

  // (b) 스레드: 스레드 패널은 그 스레드의 것만 센다
  resetWorld([
    { rootId: rootMsg, body: "스레드에 거는 답글" },
    { sendAtMs: NOW + 2 * DAY, body: "스레드가 아닌 채널 글" },
  ]);
  ({ context, page } = await open(browser, origin, scheme, viewport));
  await openChannel(page);
  await page.getByTestId("thread-anchor").first().click();
  await must(page, "thread-composer", 10_000);
  await must(page, "thread-composer-scheduled-banner", 10_000);
  // 스레드 패널(`aside`)은 320px 열이다(`ThreadPanel.tsx`). 입력창은 그 안이라 경계선 한 줄만큼 좁을 수 있어 ±1을 둔다.
  const panelWidth = (await page.getByTestId("thread-panel").boundingBox())?.width ?? 0;
  const composerWidth = (await page.getByTestId("thread-composer").boundingBox())?.width ?? 0;
  check(`${tag} s5 스레드 패널은 320px 열이다(명세 5: 320px 스레드 패널의 입력창)`, Math.abs(panelWidth - 320) <= 1 && Math.abs(composerWidth - 320) <= 1, `패널 ${panelWidth} 입력창 ${composerWidth}`);
  check(`${tag} s5 (b) 스레드: 이 스레드에 예약된 메시지 1개`, (await textOf(page, "thread-composer-scheduled-banner")).startsWith("이 스레드에 예약된 메시지 1개"), await textOf(page, "thread-composer-scheduled-banner"));
  // 320px 열에서 한 줄이 넘으면 두 줄이 비슷한 길이로 접힌다(「1개」가 홀로 남지 않는다) · 입력 틀에 닿지 않는다
  const threadWidths = await lineWidths(page, '[data-testid="thread-composer-scheduled-banner"] span.text-balance');
  check(`${tag} s5 (b) 스레드 배너: 두 줄이 비슷한 길이로 접힌다(줄 폭 ${JSON.stringify(threadWidths)})`, threadWidths.length === 2 && Math.min(...threadWidths) / Math.max(...threadWidths) >= 0.5, JSON.stringify(threadWidths));
  const threadGap = await page.evaluate(() => {
    const banner = document.querySelector('[data-testid="thread-composer-scheduled-banner"]').getBoundingClientRect();
    const frame = document.querySelector('[data-testid="thread-composer-frame"]').getBoundingClientRect();
    return Math.round(frame.top - banner.bottom);
  });
  check(`${tag} s5 (b) 스레드 배너는 입력 틀에 닿지 않는다(간격 ${threadGap}px ≥ 8)`, threadGap >= 8, String(threadGap));
  check(`${tag} s5 (b) 채널 배너는 둘을 센다`, (await textOf(page, "composer-scheduled-banner")).startsWith("이 채널에 예약된 메시지 2개"), await textOf(page, "composer-scheduled-banner"));
  check(`${tag} s5 스레드 입력창에도 ▾가 서 있다`, await has(page, "thread-composer-schedule-trigger"));
  check(`${tag} s5 스레드: 빈 입력이라 ▾는 흐리다`, (await page.getByTestId("thread-composer-schedule-trigger").getAttribute("aria-disabled")) === "true");
  check(`${tag} s5 스레드: 이유는 안 보이는 낭독 문장에 실려 있다`, (await textOf(page, "thread-composer-schedule-reason")) === "보낼 내용을 쓰면 예약할 수 있어요");
  check(`${tag} s5 스레드: 눈에 보이는 상태줄이 없다`, !(await has(page, "thread-composer-status-line")));
  await shot(page, "s5-banner-thread-blocked", tag);
  await type(page, "thread-composer-input", "스레드에 거는 두 번째 답글");
  check(`${tag} s5 스레드: 글을 쓰면 ▾가 켜진다`, (await page.getByTestId("thread-composer-schedule-trigger").getAttribute("aria-disabled")) === null);
  await shot(page, "s5-banner-thread", tag);
  check(`${tag} 가로 넘침 0 (스레드 패널)`, (await overflowX(page)) === 0);
  await context.close();

  // (c) 실패: 위험 어조 한 줄만
  resetWorld([{ sendAtMs: NOW - HOUR, status: "failed", failureReason: "missed", rev: 2 }, { sendAtMs: NOW + DAY }]);
  ({ context, page } = await open(browser, origin, scheme, viewport));
  await openChannel(page);
  await must(page, "composer-scheduled-banner", 10_000);
  check(`${tag} s5 (c) 실패: 예약한 메시지 1개를 보내지 못했어요`, (await textOf(page, "composer-scheduled-banner")).startsWith("예약한 메시지 1개를 보내지 못했어요"), await textOf(page, "composer-scheduled-banner"));
  check(`${tag} s5 (c) 실패 배너는 role=alert`, (await page.getByTestId("composer-scheduled-banner").getAttribute("role")) === "alert");
  check(`${tag} s5 (c) 사이드바 알약: 보내지 못한 수 1개(잉크)`, (await page.getByTestId("nav-scheduled").getByTestId("mention-badge").textContent()) === "1");
  check(`${tag} s5 (c) 알약의 낭독 이름`, ((await page.getByTestId("nav-scheduled").getAttribute("aria-label")) ?? (await textOf(page, "nav-scheduled"))).includes("보내지 못한 예약 1개"), (await page.getByTestId("nav-scheduled").getAttribute("aria-label")) ?? "");
  await shot(page, "s5-banner-failed", tag);
  await context.close();

  // (c) 실패, 스레드 패널(320px): 서술어 구가 갈라지지 않는다
  resetWorld([{ rootId: rootMsg, body: "스레드에 건 답글", sendAtMs: NOW - HOUR, status: "failed", failureReason: "missed", rev: 2 }]);
  ({ context, page } = await open(browser, origin, scheme, viewport));
  await openChannel(page);
  await page.getByTestId("thread-anchor").first().click();
  await must(page, "thread-composer-scheduled-banner", 10_000);
  check(`${tag} s5 (c) 스레드 실패 배너: 예약한 메시지 1개를 보내지 못했어요`, (await textOf(page, "thread-composer-scheduled-banner")).startsWith("예약한 메시지 1개를 보내지 못했어요"), await textOf(page, "thread-composer-scheduled-banner"));
  const failedWidths = await lineWidths(page, '[data-testid="thread-composer-scheduled-banner"] span.text-balance');
  check(`${tag} s5 (c) 스레드 실패 배너: 두 줄이 비슷한 길이로 접힌다(줄 폭 ${JSON.stringify(failedWidths)})`, failedWidths.length === 2 && Math.min(...failedWidths) / Math.max(...failedWidths) >= 0.5, JSON.stringify(failedWidths));
  await shot(page, "s5-banner-thread-failed", tag);
  await context.close();
}

// ---- 공용: 목록 장면의 세계 -----------------------------------------------------------------------------
const TOMORROW_9 = new Date("2026-10-23T09:00:00+09:00").getTime();
const MONDAY_9 = new Date("2026-10-26T09:00:00+09:00").getTime();
const attachmentsOf = (...names) =>
  names.map((name, i) => ({
    id: `00000000-0000-7000-8000-0000000005${String(i + 1).padStart(2, "0")}`,
    name, mime: "application/octet-stream", sizeBytes: 20_480,
  }));
const LONG_BODY =
  "분기 계획 논의 전에 읽어 두면 좋은 자료를 정리했어요. 지난 분기 회고와 이번 분기 목표 초안, 팀별 요청 사항을 한 문서로 모았으니 회의 시작 전에 훑어봐 주세요. 궁금한 점은 이 글 아래 스레드에 남겨 주세요. " +
  "회의에서는 우선순위가 높은 항목부터 차례로 이야기하고, 담당자와 마감일을 그 자리에서 정해요. 정리된 내용은 회의가 끝난 직후에 같은 스레드에 다시 올릴게요. 빠진 항목이 있으면 미리 알려 주세요.";
const REVIEW_BODY = [
  "금요일 배포 공지 초안이에요.",
  "",
  "1. 배포 시간은 금요일 오후 4시예요.",
  "2. 마이그레이션 144번이 먼저 들어가요.",
  "3. 롤백 계획은 Notion에 있어요.",
  "",
  "문제가 생기면 이 채널에 바로 남겨 주세요. 담당자가 확인하고 답할게요.",
  "배포 전에 점검 체크리스트를 한 번 더 같이 봐 주세요.",
  "",
  "참고 링크는 아래에 모아 둘게요.",
  "- 배포 체크리스트",
  "- 롤백 계획",
  "- 마이그레이션 144번 변경 내용",
  "- 배포 후 확인할 지표 목록",
].join("\n");

const listRows = () => [
  { channelId: chDeploy, body: "금요일 배포 공지", sendAtMs: NOW - 2 * HOUR, status: "failed", failureReason: "not_member", rev: 2 },
  { body: "점심 투표 올려 둘게요", sendAtMs: NOW - HOUR, status: "failed", failureReason: "missed", rev: 2 },
  { body: "내일 회의 전에 자료 올려 둘게요. 링크는 스레드에 따로 남겨 둘게요.", sendAtMs: TOMORROW_9, attachments: attachmentsOf("일정.pdf", "변경목록.csv") },
  { channelId: chDm, body: "어제 회의록 정리해서 보내 줘", sendAtMs: MONDAY_9 },
  { body: "곧 나갈 공지예요", sendAtMs: NOW + 20_000 },
  { channelId: chLong, body: LONG_BODY, sendAtMs: NOW + 3 * DAY },
  { channelId: chGone, body: "나간 채널에 걸어 둔 글", sendAtMs: NOW + 5 * DAY },
];

async function openList(browser, origin, scheme, viewport, opts) {
  const result = await open(browser, origin, scheme, viewport, opts);
  await must(result.page, "nav-scheduled", 15_000);
  await result.page.getByTestId("nav-scheduled").click();
  await must(result.page, "scheduled-route", 10_000);
  return result;
}

const rowFacts = (page) =>
  page.getByTestId("scheduled-row").evaluateAll((els) =>
    els.map((el) => {
      const pick = (id) => el.querySelector(`[data-testid="${id}"]`)?.textContent?.replace(/\s+/g, " ").trim() ?? null;
      return {
        status: el.getAttribute("data-status"),
        failure: el.getAttribute("data-failure"),
        place: pick("scheduled-row-place"),
        when: pick("scheduled-row-when"),
        reason: pick("scheduled-row-reason"),
        next: pick("scheduled-row-next"),
        chip: pick("scheduled-row-attachments"),
        inline: [...el.querySelectorAll("button")]
          .filter((b) => b.getAttribute("data-testid") !== "scheduled-row-menu")
          .map((b) => b.textContent?.trim()),
        name: el.querySelector('[role="group"]')?.getAttribute("aria-label") ?? null,
        menuName: el.querySelector('[data-testid="scheduled-row-menu"]')?.getAttribute("aria-label") ?? null,
      };
    })
  );

/** 초점이 곧 그 칸에 닿는가. Radix는 패널이 떨어진 한 틱 뒤에 초점을 돌려주므로 잠깐 기다리며 본다. */
async function focusLands(locator, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    if (await locator.evaluate((el) => el === document.activeElement).catch(() => false)) return true;
    await locator.page().waitForTimeout(50);
  }
  return false;
}
const activeDescription = (page) => page.evaluate(() => {
  const el = document.activeElement;
  return el ? `${el.tagName.toLowerCase()}[${el.getAttribute("data-testid") ?? ""}] ${el.getAttribute("aria-label") ?? ""} ${(el.textContent ?? "").trim().slice(0, 30)}` : "none";
});

async function goOffline(context, page) {
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
}

// ---- s6 목록 -------------------------------------------------------------------------------------------
async function sceneList(browser, origin, scheme, viewport) {
  const tag = `${viewport.width}-${scheme}`;
  if (BEFORE) {
    // 변경 전에는 예약됨 화면이 없다: 주소로 가면 무엇이 보이는지만 적는다.
    resetWorld();
    const { context, page } = await open(browser, origin, scheme, viewport, { hash: "/scheduled" });
    await page.waitForTimeout(900);
    await shot(page, "s6-list", tag);
    await context.close();
    return;
  }
  resetWorld(listRows());
  const { context, page } = await open(browser, origin, scheme, viewport);
  await must(page, "nav-scheduled", 15_000);
  check(`${tag} s6 사이드바 알약: 보내지 못한 예약 2개`, (await page.getByTestId("nav-scheduled").getByTestId("mention-badge").textContent()) === "2");
  await page.getByTestId("nav-scheduled").click();
  await must(page, "scheduled-route", 10_000);
  await must(page, "scheduled-section-pending", 10_000);
  check(`${tag} s6 머리: 내 예약 7개`, (await textOf(page, "scheduled-count")) === "내 예약 7개", await textOf(page, "scheduled-count"));
  const sections = await page.locator('[data-testid^="scheduled-section-"]').evaluateAll((els) => els.map((el) => [el.getAttribute("data-testid"), el.querySelector("h2")?.textContent]));
  check(`${tag} s6 구획: 보내지 못함이 위, 보낼 예정이 아래`, JSON.stringify(sections) === JSON.stringify([["scheduled-section-failed", "보내지 못함"], ["scheduled-section-pending", "보낼 예정"]]), JSON.stringify(sections));
  const facts = await rowFacts(page);
  check(`${tag} s6 행은 일곱`, facts.length === 7, String(facts.length));
  const [notMember, missed, soon, tomorrow, long, dm, gone] = facts;
  check(`${tag} s6 실패 1 not_member: 이유·다음 줄·「내용 복사」만`,
    notMember?.failure === "not_member" && notMember.place === "배포" &&
    notMember.reason === "이 채널에서 나가서 보내지 못했어요" && notMember.next === "채널에 다시 들어간 뒤에 보낼 수 있어요" &&
    JSON.stringify(notMember.inline) === JSON.stringify(["내용 복사"]), JSON.stringify(notMember));
  check(`${tag} s6 실패 2 missed: 「지금 보내기」(주)·「다시 예약」`,
    missed?.failure === "missed" && missed.reason === "예약한 시각이 많이 지나서 보내지 않았어요" &&
    missed.next === "지금 보내거나 다시 예약할 수 있어요" &&
    JSON.stringify(missed.inline) === JSON.stringify(["지금 보내기", "다시 예약"]), JSON.stringify(missed));
  check(`${tag} s6 마감 30초 안의 행: 「곧 보내요」`, soon?.when === "곧 보내요", JSON.stringify(soon));
  check(`${tag} s6 내일 오전 9:00 + 첨부 2개`, tomorrow?.when === "내일 오전 9:00에 보내요" && tomorrow.chip === "첨부 2개", JSON.stringify(tomorrow));
  check(`${tag} s6 긴 채널 이름 행`, long?.place === "제품-디자인-리뷰-공유-채널-분기-계획-논의-2026-4분기" && long.when === "10월 25일 (일) 오후 2:30에 보내요", JSON.stringify(long));
  check(`${tag} s6 DM 행: 김인턴과의 대화 · 10월 26일 (월) 오전 9:00`, dm?.place === "김인턴과의 대화" && dm.when === "10월 26일 (월) 오전 9:00에 보내요", JSON.stringify(dm));
  check(`${tag} s6 나간 채널: 알 수 없는 채널`, gone?.place === "알 수 없는 채널", JSON.stringify(gone));
  check(`${tag} s6 보낼 예정 행에는 상시 버튼이 없다`, facts.filter((f) => f.status === "pending").every((f) => f.inline.length === 0));
  check(`${tag} s6 ⋯ 이름은 행마다 다르다`, new Set(facts.map((f) => f.menuName)).size === 7 && facts.every((f) => f.menuName?.includes("예약 동작")), JSON.stringify(facts.map((f) => f.menuName)));
  check(`${tag} s6 행 낭독 이름: 보낼 예정은 「{채널}, {미리보기}, {시각(요일까지)}에 보내요」`, tomorrow?.name === "일반, 내일 회의 전에 자료 올려 둘게요. 링크는 스레드에 따로 남겨 둘게요., 내일 오전 9:00, 10월 23일 금요일에 보내요", tomorrow?.name ?? "");
  check(`${tag} s6 행 낭독 이름: 보내지 못함은 「{채널}, {미리보기}, {사유}」`, notMember?.name === "배포, 금요일 배포 공지, 이 채널에서 나가서 보내지 못했어요", notMember?.name ?? "");
  const place = page.getByTestId("scheduled-row-place").nth(4);
  check(`${tag} s6 긴 채널 이름 칸은 한 줄 말줄임 모양이다`, await place.evaluate((el) => {
    const css = getComputedStyle(el);
    return css.textOverflow === "ellipsis" && css.whiteSpace === "nowrap" && css.overflow === "hidden";
  }));
  const clamp = page.getByTestId("scheduled-row-preview").nth(4);
  check(`${tag} s6 DM 행의 앞머리는 상대의 아바타(24px, 에이전트라 둥근 사각)다`, await page.getByTestId("scheduled-row").filter({ hasText: "김인턴과의 대화" }).evaluate((el) => {
    const avatar = el.querySelector('[data-testid="member-avatar"]');
    if (!avatar) return false;
    const box = avatar.getBoundingClientRect();
    return avatar.getAttribute("data-avatar-kind") === "agent" && Math.round(box.width) === 24 && Math.round(box.height) === 24;
  }));
  check(`${tag} s6 채널 행의 앞머리는 종류 아이콘이다(아바타 없음)`, (await page.getByTestId("scheduled-row").filter({ hasText: "나간 채널에 걸어 둔 글" }).locator('[data-testid="member-avatar"]').count()) === 0);
  check(`${tag} s6 미리보기는 두 줄에서 접힌다`, await clamp.evaluate((el) => getComputedStyle(el).webkitLineClamp === "2" && el.scrollHeight > el.clientHeight));
  check(`${tag} 가로 넘침 0 (목록)`, (await overflowX(page)) === 0);
  await shot(page, "s6-list", tag);

  // ⋯ 메뉴: 마감 30초 안의 행은 「시간 바꾸기」·「고치기」가 흐리고 이유를 말한다. 지금 보내기·지우기는 된다.
  const soonRow = page.getByTestId("scheduled-row").filter({ hasText: "곧 보내요" });
  await soonRow.getByTestId("scheduled-row-menu").click();
  await must(page, "scheduled-row-menu-panel", 5000);
  const dims = await page.getByTestId("scheduled-row-menu-panel").locator('[role="menuitem"]').evaluateAll((els) => els.map((el) => [el.textContent.replace(/\s+/g, " ").trim(), el.getAttribute("aria-disabled")]));
  check(`${tag} s6 잠긴 행의 메뉴: 지금 보내기 · 시간 바꾸기(흐림) · 고치기(흐림) · 지우기`,
    JSON.stringify(dims) === JSON.stringify([["지금 보내기", null], ["시간 바꾸기곧 보내서 바꿀 수 없어요", "true"], ["고치기곧 보내서 바꿀 수 없어요", "true"], ["지우기", null]]), JSON.stringify(dims));
  // 흐린 것은 낱말뿐이다: 이유 줄(왜 흐린가)의 실효 투명도는 1이다(조상 투명도의 곱)
  const reasonOpacity = await page.getByTestId("scheduled-row-menu-panel").locator('[role="menuitem"]').nth(1).evaluate((item) => {
    const reason = item.querySelectorAll("span")[1];
    let product = 1;
    for (let node = reason; node && node !== document.body; node = node.parentElement) product *= Number(getComputedStyle(node).opacity);
    return Math.round(product * 100) / 100;
  });
  check(`${tag} s6 잠긴 항목의 이유 줄은 흐려지지 않는다(실효 투명도 ${reasonOpacity})`, reasonOpacity === 1, String(reasonOpacity));
  await shot(page, "s6-menu-locked", tag);
  await page.keyboard.press("Escape");
  check(`${tag} s6 Esc로 닫으면 초점이 ⋯로 돌아간다`, await focusLands(soonRow.getByTestId("scheduled-row-menu")), await activeDescription(page));

  // 우클릭: ⋯와 같은 항목이 같은 순서로 열린다(명세 1.1)
  const tomorrowRow = page.getByTestId("scheduled-row").filter({ hasText: "내일 회의 전에 자료" });
  await tomorrowRow.click({ button: "right", position: { x: 600, y: 30 } });
  await must(page, "scheduled-row-context-panel", 5000);
  const ctx = await page.getByTestId("scheduled-row-context-panel").locator('[role="menuitem"]').allTextContents();
  check(`${tag} s6 우클릭 메뉴: 지금 보내기 · 시간 바꾸기 · 고치기 · 지우기(⋯와 같다)`, JSON.stringify(ctx) === JSON.stringify(["지금 보내기", "시간 바꾸기", "고치기", "지우기"]), JSON.stringify(ctx));
  await shot(page, "s6-context-menu", tag);
  await page.keyboard.press("Escape");
  await page.getByTestId("scheduled-row-context-panel").waitFor({ state: "detached", timeout: 3000 });

  // 지금 보내기(missed 행): 행이 사라지고 3초 상태줄, 초점은 다음 행의 첫 컨트롤
  const missedRow = page.getByTestId("scheduled-row").filter({ hasText: "점심 투표" });
  const failedTitleTop = () => page.getByTestId("scheduled-section-failed").locator("h2").evaluate((el) => Math.round(el.getBoundingClientRect().top));
  const titleTopBefore = await failedTitleTop();
  await missedRow.getByRole("button", { name: "지금 보내기" }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="scheduled-row"]').length === 6, null, { timeout: 5000 });
  check(`${tag} s6 지금 보내기: 한 번 누르면 간다(확인 없음)`, world.sendNows.length === 1 && !(await has(page, "scheduled-delete-dialog")));
  check(`${tag} s6 지금 보내기: 목록 머리 상태줄 「메시지를 보냈어요」`, (await textOf(page, "scheduled-status")) === "메시지를 보냈어요", await textOf(page, "scheduled-status"));
  check(`${tag} s6 지금 보내기: 초점은 다음 행의 첫 컨트롤`, await page.evaluate(() => {
    const el = document.activeElement;
    const row = el?.closest('[data-testid="scheduled-row"]');
    return row !== null && row?.textContent?.includes("곧 나갈 공지예요") && el === row.querySelector("button");
  }));
  const statusLine = await textOf(page, "scheduled-status-line");
  check(`${tag} s6 상태줄은 「내 예약 N개」의 자리를 대신 쓴다(눈에 보이는 줄 「${statusLine}」, 머리 안, 개수는 잠시 없다)`, statusLine === "메시지를 보냈어요" && (await page.getByTestId("scheduled-route").locator("header").getByTestId("scheduled-status-line").count()) === 1 && !(await has(page, "scheduled-count")));
  const titleTopDuring = await failedTitleTop();
  check(`${tag} s6 상태줄이 목록을 밀지 않는다(「보내지 못함」 제목 y ${titleTopBefore} → ${titleTopDuring})`, titleTopDuring === titleTopBefore, `${titleTopBefore} -> ${titleTopDuring}`);
  await shot(page, "s6-sent-status", tag);
  await page.waitForTimeout(3300);
  check(`${tag} s6 3초 뒤 「내 예약 N개」가 돌아오고 상태줄은 사라진다`, (await textOf(page, "scheduled-count")) === "내 예약 6개" && !(await has(page, "scheduled-status-line")), await textOf(page, "scheduled-count").catch(() => "없음"));
  const titleTopAfter = await failedTitleTop();
  check(`${tag} s6 돌아온 뒤에도 목록은 그 자리다(y ${titleTopAfter})`, titleTopAfter === titleTopBefore, `${titleTopBefore} -> ${titleTopAfter}`);

  // 지우기(⋯ → 지우기 → 확인 대화상자): 행이 사라지면 초점은 다음 행의 첫 컨트롤이다(대화상자의 초점 반환이 가로채지 않는다)
  await soonRow.getByTestId("scheduled-row-menu").click();
  await page.getByTestId("scheduled-row-menu-delete").click();
  await must(page, "scheduled-delete-dialog", 5000);
  check(`${tag} s6 지우기 대화상자: 제목과 본문`, (await textOf(page, "scheduled-delete-dialog")).includes("예약을 지울까요?") && (await textOf(page, "scheduled-delete-dialog")).includes("지우면 이 메시지는 보내지 않아요. 되돌릴 수 없어요."));
  await shot(page, "s6-delete-dialog", tag);
  await page.getByTestId("scheduled-delete-confirm").click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="scheduled-row"]').length === 5, null, { timeout: 5000 });
  check(`${tag} s6 지우기: 초점은 다음 행의 첫 컨트롤`, await (async () => {
    for (let i = 0; i < 40; i += 1) {
      const ok = await page.evaluate(() => {
        const el = document.activeElement;
        const row = el?.closest('[data-testid="scheduled-row"]');
        return row !== null && row !== undefined && row.textContent.includes("내일 회의 전에 자료") && el === row.querySelector("button");
      });
      if (ok) return true;
      await page.waitForTimeout(50);
    }
    return false;
  })(), await activeDescription(page));

  // 좁은 폭: 긴 채널 이름은 말줄임으로 한 줄에 닫히고 가로로 넘치지 않는다
  await page.setViewportSize({ width: 720, height: 800 });
  await page.waitForTimeout(300);
  const narrowPlace = page.getByTestId("scheduled-row-place").filter({ hasText: "제품-디자인" });
  check(`${tag} s6 720px: 긴 채널 이름이 말줄임으로 닫힌다`, await narrowPlace.evaluate((el) => el.scrollWidth > el.clientWidth));
  check(`${tag} s6 720px: 가로 넘침 0`, (await overflowX(page)) === 0, String(await overflowX(page)));
  await shot(page, "s6-list-narrow", `720-${scheme}`);
  await context.close();
}

// ---- s6 상태: 빈 · 오류 · 로딩 · 이 서버에는 예약이 없다 ----------------------------------------------------------
async function sceneListStates(browser, origin, scheme, viewport) {
  const tag = `${viewport.width}-${scheme}`;
  if (BEFORE) return;
  // 빈
  resetWorld();
  let { context, page } = await open(browser, origin, scheme, viewport, { hash: "/scheduled" });
  await must(page, "scheduled-empty", 15_000);
  check(`${tag} s6 빈: 예약한 메시지가 없어요 + 대화로 돌아가기`, (await textOf(page, "scheduled-empty")).includes("예약한 메시지가 없어요") && (await textOf(page, "scheduled-empty-back")) === "대화로 돌아가기");
  await shot(page, "s6-empty", tag);
  await context.close();

  // 오류(장애)
  resetWorld();
  world.listMode = "500";
  ({ context, page } = await open(browser, origin, scheme, viewport, { hash: "/scheduled" }));
  await must(page, "scheduled-error", 15_000);
  check(`${tag} s6 오류: 예약 목록을 불러오지 못했어요 + 다시 불러오기(role=alert)`, (await textOf(page, "scheduled-error")).includes("예약 목록을 불러오지 못했어요") && (await page.getByTestId("scheduled-error").getAttribute("role")) === "alert");
  await shot(page, "s6-error", tag);
  await context.close();

  // 로딩
  resetWorld();
  world.listMode = "hang";
  ({ context, page } = await open(browser, origin, scheme, viewport, { hash: "/scheduled" }));
  await must(page, "scheduled-route", 15_000);
  await page.waitForTimeout(600);
  check(`${tag} s6 로딩: 세 행 높이의 중성 스켈레톤, 제목은 서 있고 개수는 아직 없다`, (await page.getByTestId("skeleton-row").count()) >= 3 && (await textOf(page, "scheduled-heading")) === "예약됨" && !(await has(page, "scheduled-count")));
  await shot(page, "s6-loading", tag);
  await context.close();

  // 「내용 복사」가 실패한다(클립보드를 못 쓰는 곳): 행 안에 이유와 다음 행동이 선다
  resetWorld([{ channelId: chDeploy, body: "금요일 배포 공지", sendAtMs: NOW - 2 * HOUR, status: "failed", failureReason: "not_member", rev: 2 }]);
  ({ context, page } = await open(browser, origin, scheme, viewport, {
    init: () => { Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.reject(new Error("denied")) } }); },
  }));
  await must(page, "nav-scheduled", 15_000);
  await page.getByTestId("nav-scheduled").click();
  await must(page, "scheduled-row-copy", 10_000);
  const copyTopBefore = (await page.getByTestId("scheduled-row-copy").boundingBox())?.y;
  await page.getByTestId("scheduled-row-copy").click();
  await must(page, "scheduled-row-copy-error", 5000);
  const copyTopAfter = (await page.getByTestId("scheduled-row-copy").boundingBox())?.y;
  check(`${tag} s6 복사 실패: 누른 단추가 밀리지 않는다(y ${copyTopBefore} → ${copyTopAfter}), 실패 줄은 단추 아래에 선다`, copyTopBefore === copyTopAfter && (await page.evaluate(() => {
    const button = document.querySelector('[data-testid="scheduled-row-copy"]').getBoundingClientRect();
    const error = document.querySelector('[data-testid="scheduled-row-copy-error"]').getBoundingClientRect();
    return error.top >= button.bottom;
  })), `${copyTopBefore} -> ${copyTopAfter}`);
  check(`${tag} s6 복사 실패: 이유와 다음 행동이 행 안에 선다(role=alert)`, (await textOf(page, "scheduled-row-copy-error")) === "복사하지 못했어요고치기에서 글을 열어 복사할 수 있어요" && (await page.getByTestId("scheduled-row-copy-error").getAttribute("role")) === "alert", await textOf(page, "scheduled-row-copy-error"));
  check(`${tag} s6 복사 실패: 단추는 「복사됨」이 되지 않는다`, (await textOf(page, "scheduled-row-copy")) === "내용 복사");
  await shot(page, "s6-copy-failed", tag);
  await context.close();

  // 이 서버에는 예약이 없다(첫 목록 404): 입구는 없고 옛 링크로 온 사람에게만 이 줄이 보인다
  resetWorld();
  world.listMode = "404";
  ({ context, page } = await open(browser, origin, scheme, viewport, { hash: "/scheduled" }));
  await must(page, "scheduled-absent", 15_000);
  check(`${tag} s6 없는 서버: 이유와 다음 행동 줄 + 대화로 돌아가기`, (await textOf(page, "scheduled-absent")).includes("이 서버에서는 예약을 쓸 수 없어요") && (await textOf(page, "scheduled-absent")).includes("관리자에게 물어보세요") && (await textOf(page, "scheduled-absent-back")) === "대화로 돌아가기");
  check(`${tag} s6 없는 서버: 사이드바에 「예약됨」 줄이 없다`, !(await has(page, "nav-scheduled")));
  await shot(page, "s6-absent", tag);
  await page.getByTestId("scheduled-absent-back").click();
  await page.waitForFunction(() => !location.hash.includes("scheduled"), null, { timeout: 5000 });
  check(`${tag} s6 없는 서버: 「대화로 돌아가기」가 목록 밖으로 나간다`, !(await page.evaluate(() => location.hash)).includes("scheduled"));
  await context.close();
}

// ---- s7 실패 ------------------------------------------------------------------------------------------
async function sceneFailures(browser, origin, scheme, viewport) {
  const tag = `${viewport.width}-${scheme}`;
  if (BEFORE) return;
  resetWorld([
    { channelId: chDeploy, body: REVIEW_BODY, sendAtMs: TOMORROW_9, status: "failed", failureReason: "sessions_ended", rev: 2, attachments: attachmentsOf("일정.pdf", "변경목록.csv") },
    { body: "점심 투표 올려 둘게요", sendAtMs: NOW - HOUR, status: "failed", failureReason: "missed", rev: 2 },
    { channelId: chDeploy, body: "금요일 배포 공지", sendAtMs: NOW - 2 * HOUR, status: "failed", failureReason: "not_member", rev: 2 },
  ]);
  const { context, page } = await openList(browser, origin, scheme, viewport);
  await must(page, "scheduled-section-failed", 10_000);
  const facts = await rowFacts(page);
  const ended = facts.find((f) => f.failure === "sessions_ended");
  check(`${tag} s7 세 행: not_member · missed · sessions_ended(시각 순)`, JSON.stringify(facts.map((f) => f.failure)) === JSON.stringify(["not_member", "missed", "sessions_ended"]), JSON.stringify(facts.map((f) => f.failure)));
  check(`${tag} s7 sessions_ended 행: 이유·다음 줄·「내용 확인」만`, ended?.reason === "로그인이 끝나서 예약을 멈췄어요" && ended.next === "내용을 확인하고 보내거나 다시 예약해 주세요" && JSON.stringify(ended.inline) === JSON.stringify(["내용 확인"]), JSON.stringify(ended));
  check(`${tag} s7 사유 줄은 위험 어조, 다음 줄은 보조 어조`, await page.getByTestId("scheduled-row-reason").first().evaluate((el) => el.className.includes("text-danger")) && await page.getByTestId("scheduled-row-next").first().evaluate((el) => el.className.includes("text-ink-muted")));
  await shot(page, "s7-failed-rows", tag);

  const endedRow = page.locator('[data-testid="scheduled-row"][data-failure="sessions_ended"]');
  await endedRow.getByTestId("scheduled-row-menu").click();
  await must(page, "scheduled-row-menu-panel", 5000);
  const items = await page.getByTestId("scheduled-row-menu-panel").locator('[role="menuitem"]').allTextContents();
  check(`${tag} s7 sessions_ended의 ⋯: 내용 확인 · 고치기 · 내용 복사 · 지우기(지금 보내기·다시 예약 없음)`, JSON.stringify(items) === JSON.stringify(["내용 확인", "고치기", "내용 복사", "지우기"]), JSON.stringify(items));
  await shot(page, "s7-menu-review", tag);
  await page.keyboard.press("Escape");

  // 내용 확인 대화상자
  const reviewButton = endedRow.getByTestId("scheduled-row-review");
  await reviewButton.click();
  await must(page, "scheduled-review-dialog", 5000);
  check(`${tag} s7 내용 확인: 초점은 제목`, await page.evaluate(() => document.activeElement?.textContent === "내용을 확인해 주세요"));
  check(`${tag} s7 내용 확인: 설명`, (await page.getByTestId("scheduled-review-dialog").textContent()).includes("로그인이 끝나서 멈춘 예약이에요. 내가 쓴 글이 맞는지 확인한 뒤에 보내 주세요."));
  check(`${tag} s7 내용 확인: 채널`, (await textOf(page, "scheduled-review-place")) === "#배포", await textOf(page, "scheduled-review-place"));
  const body = page.getByTestId("scheduled-review-body");
  // 이 하네스의 기본 브라우저는 `--hide-scrollbars`로 떠서 막대가 안 그려진다: 여기서는 계약(클래스·넘침)만 보고 실제 막대의
  // 폭은 막대를 그리는 브라우저로 뜬 「긴 본문」 장면(`sceneReviewLong`)이 잰다.
  check(`${tag} s7 내용 확인: 본문 상자는 \`scrollbar-visible\`이고 세로로 스크롤한다`, await body.evaluate((el) => el.classList.contains("scrollbar-visible") && getComputedStyle(el).overflowY === "auto"));
  check(`${tag} s7 내용 확인: 본문 전체(길면 이 상자만 스크롤)`, (await body.evaluate((el) => el.scrollHeight > el.clientHeight && el.getAttribute("tabindex") === "0" && el.getAttribute("role") === "region" && el.getAttribute("aria-label") === "예약한 메시지 본문")) && (await body.textContent()).includes("배포 후 확인할 지표 목록"));
  check(`${tag} s7 내용 확인: 첨부 이름`, (await textOf(page, "scheduled-review-attachments")) === "첨부 2개: 일정.pdf, 변경목록.csv", await textOf(page, "scheduled-review-attachments"));
  check(`${tag} s7 내용 확인: 보내려던 시각`, (await textOf(page, "scheduled-review-when")) === "내일 오전 9:00에 보내려던 예약이에요", await textOf(page, "scheduled-review-when"));
  const footer = await page.getByTestId("scheduled-review-dialog").locator("button").evaluateAll((els) => els.map((el) => el.textContent.trim()).filter((t) => t !== ""));
  check(`${tag} s7 내용 확인: 푸터 닫기 · 지우기 · 다시 예약 · 지금 보내기`, JSON.stringify(footer.slice(-4)) === JSON.stringify(["닫기", "지우기", "다시 예약", "지금 보내기"]), JSON.stringify(footer));
  const tabStops = [];
  for (let i = 0; i < 5; i += 1) {
    await page.keyboard.press("Tab");
    tabStops.push(await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent?.trim()));
  }
  check(`${tag} s7 내용 확인: Tab 순서 본문 → 닫기 → 지우기 → 다시 예약 → 지금 보내기`, JSON.stringify(tabStops.slice(0, 5)) === JSON.stringify(["예약한 메시지 본문", "닫기", "지우기", "다시 예약", "지금 보내기"]), JSON.stringify(tabStops));
  await shot(page, "s7-review", tag);

  // 지우기: 푸터만 확인 줄로 바뀐다
  await page.getByTestId("scheduled-review-delete").click();
  await must(page, "scheduled-review-confirm", 3000);
  check(`${tag} s7 지우기 확인: 초점은 「취소」(안전한 쪽)`, await page.getByTestId("scheduled-review-confirm-cancel").evaluate((el) => el === document.activeElement));
  check(`${tag} s7 지우기 확인: 그룹 이름 「예약을 지울까요?」와 본문`, (await page.getByTestId("scheduled-review-confirm").evaluate((el) => document.getElementById(el.getAttribute("aria-labelledby"))?.textContent)) === "예약을 지울까요?" && (await textOf(page, "scheduled-review-confirm")).includes("지우면 이 메시지는 보내지 않아요. 되돌릴 수 없어요."));
  check(`${tag} s7 지우기 확인: 본문은 그대로 보인다(대화상자는 겹치지 않는다)`, await has(page, "scheduled-review-body") && (await page.locator('[role="dialog"]').count()) === 1);
  await shot(page, "s7-review-delete-confirm", tag);
  await page.keyboard.press("Escape");
  check(`${tag} s7 Esc 한 번: 확인만 취소하고 초점은 「지우기」`, !(await has(page, "scheduled-review-confirm")) && (await has(page, "scheduled-review-dialog")) && (await page.getByTestId("scheduled-review-delete").evaluate((el) => el === document.activeElement)));
  await page.keyboard.press("Escape");
  await page.getByTestId("scheduled-review-dialog").waitFor({ state: "detached", timeout: 3000 });
  check(`${tag} s7 Esc 한 번 더: 닫히고 초점은 행의 「내용 확인」`, await focusLands(reviewButton), await activeDescription(page));

  // 지금 보내기 거절: 대화상자 안에 3.2의 이유 줄
  world.sendNowMode = "not_member";
  await reviewButton.click();
  await must(page, "scheduled-review-dialog", 5000);
  await page.getByTestId("scheduled-review-send-now").click();
  await must(page, "scheduled-review-dialog", 5000);
  await page.waitForFunction(() => document.querySelector('[data-testid="scheduled-review-dialog"] [role="alert"]') !== null, null, { timeout: 5000 });
  const alert = ((await page.getByTestId("scheduled-review-dialog").locator('[role="alert"]').textContent()) ?? "").replace(/\s+/g, " ").trim();
  check(`${tag} s7 지금 보내기 거절: 대화상자 안에 3.2의 이유 줄`, alert === "이 채널에서 나가서 보내지 못했어요", alert);
  check(`${tag} s7 지금 보내기 거절: 대화상자는 열려 있다`, await has(page, "scheduled-review-dialog"));
  await shot(page, "s7-review-refused", tag);

  // 다시 예약: 이 대화상자를 닫고 「다시 예약하기」를 연다(겹치지 않는다). 취소·Esc는 초점을 「내용 확인」으로.
  await page.getByTestId("scheduled-review-rearm").click();
  await must(page, "schedule-dialog", 5000);
  check(`${tag} s7 다시 예약: 내용 확인은 닫히고 「다시 예약하기」가 열린다`, !(await has(page, "scheduled-review-dialog")) && (await page.locator('[role="dialog"]').count()) === 1 && (await page.getByTestId("schedule-dialog").textContent()).includes("다시 예약하기"));
  await page.keyboard.press("Escape");
  await page.getByTestId("schedule-dialog").waitFor({ state: "detached", timeout: 3000 });
  check(`${tag} s7 다시 예약을 Esc로 닫으면 초점은 행의 「내용 확인」`, await focusLands(reviewButton), await activeDescription(page));
  check(`${tag} 가로 넘침 0 (실패 행)`, (await overflowX(page)) === 0);
  await context.close();
}

// ---- s7 긴 본문: 한 화면을 한참 넘는 본문이 「넘친다」를 말한다 (design-review #4215 H1) ----------------------------
const REVIEW_LONG_BODY = Array.from({ length: 65 }, (_, i) => {
  if (i === 0) return "금요일 배포 공지 초안이에요. 아래 항목을 끝까지 읽어 주세요.";
  if (i === 64) return "마지막 줄: 이 줄은 맨 아래로 스크롤해야만 보여요.";
  if (i % 8 === 0) return "";
  return `${i}. 배포 전에 확인할 항목 ${i}번이에요. 담당자와 마감 시각을 이 줄에 적어 둘게요.`;
}).join("\n");

/**
 * `browser`는 **막대를 그리는** 브라우저여야 한다(`ignoreDefaultArgs: ["--hide-scrollbars"]`): 이 하네스의 기본 브라우저는 모든
 * 스크롤바를 숨겨서 「넘침 신호」를 잴 수 없고, 바로 그 때문에 한 번 넘침 신호의 부재를 놓쳤다(design-review #4215 H1).
 * `scrollbar-visible`은 `::-webkit-scrollbar` 스타일이라 OS의 오버레이 설정과 무관하게 막대가 자리를 차지한다.
 */
async function sceneReviewLong(browser, origin, scheme, viewport) {
  const tag = `${viewport.width}-${scheme}`;
  if (BEFORE) return;
  resetWorld([{ channelId: chDeploy, body: REVIEW_LONG_BODY, sendAtMs: TOMORROW_9, status: "failed", failureReason: "sessions_ended", rev: 2, attachments: attachmentsOf("일정.pdf", "변경목록.csv") }]);
  const { context, page } = await openList(browser, origin, scheme, viewport);
  await must(page, "scheduled-section-failed", 10_000);
  await page.getByTestId("scheduled-row-review").click();
  await must(page, "scheduled-review-body", 5000);
  const body = page.getByTestId("scheduled-review-body");
  const facts = await body.evaluate((el) => ({ bar: el.offsetWidth - el.clientWidth, scroll: el.scrollHeight, client: el.clientHeight, className: el.className }));
  check(`${tag} s7 긴 본문: 본문이 한 화면의 3배 넘게 길다(${facts.scroll}px / 보이는 ${facts.client}px)`, facts.scroll >= facts.client * 3, JSON.stringify(facts));
  check(`${tag} s7 긴 본문: 스크롤 막대가 자리를 차지해 늘 보인다(폭 ${facts.bar}px ≥ 10, 오버레이 막대는 스크롤해야 나타난다)`, facts.bar >= 10, JSON.stringify(facts));
  check(`${tag} s7 긴 본문: 마지막 줄은 스크롤 전에는 가려져 있고(scrollTop 0) 그 줄이 본문에 있다`, await body.evaluate((el) => el.scrollTop === 0 && el.textContent.includes("마지막 줄: 이 줄은 맨 아래로 스크롤해야만 보여요.")));
  await shot(page, "s7-review-long", tag);
  await body.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(200);
  check(`${tag} s7 긴 본문: 맨 아래로 스크롤하면 마지막 줄까지 닿는다`, await body.evaluate((el) => Math.abs(el.scrollTop + el.clientHeight - el.scrollHeight) <= 1));
  await shot(page, "s7-review-long-end", tag);
  await context.close();
}

// ---- s7 이벤트: sessions_ended가 멈춘 즉시 보인다(owner 결정 6) ----------------------------------------------
async function sceneEvent(browser, origin, scheme, viewport) {
  const tag = `${viewport.width}-${scheme}`;
  if (BEFORE) return;
  resetWorld([{ sendAtMs: TOMORROW_9, body: "내일 아침에 올릴 공지예요" }]);
  const { context, page } = await open(browser, origin, scheme, viewport);
  await openChannel(page);
  await must(page, "composer-scheduled-banner", 10_000);
  await type(page, "composer-input", "아직 보내지 않은 글");
  check(`${tag} s7e 처음: 대기 배너 · 알약 없음`, (await textOf(page, "composer-scheduled-banner")).startsWith("이 채널에 예약된 메시지 1개") && !(await page.getByTestId("nav-scheduled").getByTestId("mention-badge").count()));
  // 서버에서 로그인 세션이 끝나 예약이 멈추고, 개인 채널에 신호가 온다(본문 없는 신호).
  const row = world.scheduled[0];
  Object.assign(row, { status: "failed", failureReason: "sessions_ended", rev: 1 });
  delete row.editableUntilMs;
  const frame = {
    type: "scheduled_message.updated",
    ts: new Date(NOW).toISOString(),
    payload: {
      workspace_id: workspaceId.toUpperCase(), member_id: me.toUpperCase(),
      scheduled_message_id: row.id.toUpperCase(), channel_id: chGeneral.toUpperCase(),
      status: "failed", failure_reason: "sessions_ended", send_at_ms: row.sendAtMs, rev: 1,
    },
  };
  const delivered = await page.evaluate(([prefix, data]) => window.__capturePush(prefix, data), ["user:read-state#", frame]);
  check(`${tag} s7e 신호가 구독한 개인 채널로 갔다`, delivered >= 1, String(delivered));
  await page.waitForFunction(() => document.querySelector('[data-testid="composer-scheduled-banner"]')?.getAttribute("role") === "alert", null, { timeout: 1500 }).catch(() => {});
  check(`${tag} s7e 신호 도착 즉시 배너가 실패 어조: 예약한 메시지 1개를 보내지 못했어요`, (await textOf(page, "composer-scheduled-banner")).startsWith("예약한 메시지 1개를 보내지 못했어요") && (await page.getByTestId("composer-scheduled-banner").getAttribute("role")) === "alert", await textOf(page, "composer-scheduled-banner"));
  check(`${tag} s7e 사이드바 알약 1`, (await page.getByTestId("nav-scheduled").getByTestId("mention-badge").textContent()) === "1");
  check(`${tag} s7e 새로 읽지 않았다: 쓰던 글이 그대로`, (await page.getByTestId("composer-input").inputValue()) === "아직 보내지 않은 글");
  await shot(page, "s7-event-banner", tag);
  await page.getByTestId("composer-scheduled-banner").getByRole("button", { name: "보기" }).click();
  await must(page, "scheduled-section-failed", 5000);
  const facts = await rowFacts(page);
  check(`${tag} s7e 목록: 「보내지 못함」 구획에 sessions_ended 행, 「내용 확인」만`, facts.length === 1 && facts[0].failure === "sessions_ended" && JSON.stringify(facts[0].inline) === JSON.stringify(["내용 확인"]), JSON.stringify(facts));
  await shot(page, "s7-event-list", tag);
  await context.close();
}

// ---- s8 오프라인 ---------------------------------------------------------------------------------------
async function sceneOffline(browser, origin, scheme, viewport) {
  const tag = `${viewport.width}-${scheme}`;
  if (BEFORE) return;
  // (1) 입력창: 앱의 오프라인 줄이 이유를 말하고 보내기와 ▾가 함께 흐리다
  resetWorld([{ sendAtMs: TOMORROW_9 }]);
  let { context, page } = await open(browser, origin, scheme, viewport);
  await openChannel(page);
  await must(page, "composer-scheduled-banner", 10_000);
  await type(page, "composer-input", "내일 회의 전에 자료 올려 둘게요");
  await goOffline(context, page);
  await must(page, "composer-offline", 5000);
  const trigger = page.getByTestId("composer-schedule-trigger");
  check(`${tag} s8 입력창: ▾가 흐리다(aria-disabled)`, (await trigger.getAttribute("aria-disabled")) === "true");
  check(`${tag} s8 입력창: 보내기도 흐리다`, await page.getByTestId("composer-send").evaluate((el) => el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true"));
  check(`${tag} s8 입력창: 예약용 오프라인 줄·배너를 따로 만들지 않는다(앱의 줄 하나)`, (await page.getByTestId("composer-offline").count()) === 1 && !(await page.locator('[data-testid^="composer-schedule-offline"]').count()));
  check(`${tag} s8 입력창: 캐시된 대기 배너는 그대로 보인다`, (await textOf(page, "composer-scheduled-banner")).startsWith("이 채널에 예약된 메시지 1개"));
  await trigger.focus();
  check(`${tag} s8 입력창: ▾가 포커스를 받는다`, await trigger.evaluate((el) => el === document.activeElement));
  await shot(page, "s8-composer-offline", tag);
  await context.close();

  // (2) 목록: 캐시된 목록은 그대로, 행의 동작은 모두 흐리다
  resetWorld(listRows().slice(0, 4));
  ({ context, page } = await openList(browser, origin, scheme, viewport));
  await must(page, "scheduled-section-pending", 10_000);
  await goOffline(context, page);
  await must(page, "scheduled-offline", 5000);
  check(`${tag} s8 목록: 연결이 없어요. 연결되면 예약을 바꿀 수 있어요.`, (await textOf(page, "scheduled-offline")).startsWith("연결이 없어요. 연결되면 예약을 바꿀 수 있어요."), await textOf(page, "scheduled-offline"));
  check(`${tag} s8 목록: 캐시된 네 행이 그대로 보인다`, (await page.getByTestId("scheduled-row").count()) === 4);
  const inlineDim = await page.getByTestId("scheduled-section-failed").locator("button[data-testid^='scheduled-row-']:not([data-testid='scheduled-row-menu'])").evaluateAll((els) => els.map((el) => el.getAttribute("aria-disabled")));
  check(`${tag} s8 목록: 실패 행의 상시 버튼이 모두 흐리다`, inlineDim.length > 0 && inlineDim.every((v) => v === "true"), JSON.stringify(inlineDim));
  await page.getByTestId("scheduled-section-pending").getByTestId("scheduled-row-menu").first().click();
  await must(page, "scheduled-row-menu-panel", 5000);
  const dim = await page.getByTestId("scheduled-row-menu-panel").locator('[role="menuitem"]').evaluateAll((els) => els.map((el) => el.getAttribute("aria-disabled")));
  check(`${tag} s8 목록: ⋯ 메뉴의 항목이 모두 흐리다`, dim.length === 4 && dim.every((v) => v === "true"), JSON.stringify(dim));
  await shot(page, "s8-list-offline", tag);
  await page.keyboard.press("Escape");
  await context.close();

  // (3) 대화상자 안: 열려 있는 동안 연결이 끊긴다
  resetWorld(listRows().slice(3, 4));
  ({ context, page } = await openList(browser, origin, scheme, viewport));
  await must(page, "scheduled-section-pending", 10_000);
  await page.getByTestId("scheduled-row-menu").first().click();
  await page.getByTestId("scheduled-row-menu-change").click();
  await must(page, "schedule-dialog", 5000);
  await goOffline(context, page);
  await page.waitForFunction(() => document.querySelector('[data-testid="schedule-dialog-error"]') !== null, null, { timeout: 3000 });
  check(`${tag} s8 대화상자: 연결이 없어서 지금은 할 수 없어요. 연결되면 다시 눌러 주세요.`, (await textOf(page, "schedule-dialog-error")) === "연결이 없어서 지금은 할 수 없어요. 연결되면 다시 눌러 주세요.", await textOf(page, "schedule-dialog-error"));
  check(`${tag} s8 대화상자: 확인이 흐리다`, await page.getByTestId("schedule-dialog-commit").evaluate((el) => el.disabled || el.getAttribute("aria-disabled") === "true"));
  await shot(page, "s8-dialog-offline", tag);
  await context.close();

  // (4) 거는 도중 연결이 끊겼다: 결과를 모른다. 같은 clientRequestId로 다시 건다.
  resetWorld();
  ({ context, page } = await open(browser, origin, scheme, viewport));
  await openChannel(page);
  await type(page, "composer-input", "내일 회의 전에 자료 올려 둘게요");
  world.createMode = "network";
  await page.getByTestId("composer-schedule-trigger").click();
  await must(page, "composer-schedule-menu", 5000);
  await page.getByTestId("composer-schedule-preset-tomorrow").click();
  await must(page, "schedule-dialog", 5000);
  await page.waitForFunction(() => document.querySelector('[data-testid="schedule-dialog-error"]') !== null, null, { timeout: 5000 });
  check(`${tag} s8 거는 도중 끊김: 예약됐는지 확인하지 못했어요. 연결을 확인하고 다시 눌러 주세요.`, (await textOf(page, "schedule-dialog-error")) === "예약됐는지 확인하지 못했어요. 연결을 확인하고 다시 눌러 주세요.", await textOf(page, "schedule-dialog-error"));
  check(`${tag} s8 거는 도중 끊김: 오류 줄은 role=alert`, (await page.getByTestId("schedule-dialog-error").getAttribute("role")) === "alert");
  check(`${tag} s8 거는 도중 끊김: 쓰던 글은 그대로`, (await page.getByTestId("composer-input").inputValue()) === "내일 회의 전에 자료 올려 둘게요");
  await shot(page, "s8-dialog-network", tag);
  world.createMode = "ok";
  await page.getByTestId("schedule-dialog-commit").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="schedule-dialog"]') === null, null, { timeout: 5000 });
  check(`${tag} s8 다시 누르면 같은 clientRequestId로 건다(멱등)`, world.creates.length === 2 && world.creates[0].body.clientRequestId === world.creates[1].body.clientRequestId && typeof world.creates[0].body.clientRequestId === "string", JSON.stringify(world.creates.map((c) => c.body.clientRequestId)));
  await context.close();
}

// ---- s9 보충: 비밀 키 · 예약을 끈 서버 · 요청 중 · 이벤트로만 안 행 ------------------------------------------------
const KEY_LIKE = "sk-ant-api03-Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78St90";

async function sceneExtras(browser, origin, scheme, viewport) {
  const tag = `${viewport.width}-${scheme}`;
  if (BEFORE) return;

  // (1) 키 모양 글: 고르는 순간 막히고 줄의 첫 문장이 「예약하지 않았어요」다
  resetWorld();
  let { context, page } = await open(browser, origin, scheme, viewport);
  await openChannel(page);
  await type(page, "composer-input", `키예요 ${KEY_LIKE}`);
  await page.getByTestId("composer-schedule-trigger").click();
  await must(page, "composer-schedule-menu", 5000);
  await page.getByTestId("composer-schedule-preset-tomorrow").click();
  await must(page, "composer-secret-block", 5000);
  const secretText = await textOf(page, "composer-secret-block");
  check(`${tag} s9 비밀 키: 줄의 첫 문장이 「이 메시지는 예약하지 않았어요.」`, secretText.startsWith("키는 채팅에 붙여 넣지 마세요. 이 메시지는 예약하지 않았어요."), secretText);
  check(`${tag} s9 비밀 키: 서버를 부르지 않았고 쓰던 글이 그대로다`, world.creates.length === 0 && (await page.getByTestId("composer-input").inputValue()).includes(KEY_LIKE));
  await shot(page, "s9-secret-key", tag);
  await context.close();

  // (2) 예약을 끈 서버: 프리셋이 거절되면 직접 고르기가 이유를 말하고, 그 뒤 ▾는 흐려서 눌러서 이유를 듣는다
  resetWorld();
  world.createMode = "disabled";
  ({ context, page } = await open(browser, origin, scheme, viewport));
  await openChannel(page);
  await type(page, "composer-input", "내일 회의 전에 자료 올려 둘게요");
  await page.getByTestId("composer-schedule-trigger").click();
  await must(page, "composer-schedule-menu", 5000);
  await page.getByTestId("composer-schedule-preset-tomorrow").click();
  await must(page, "schedule-dialog", 5000);
  await page.waitForFunction(() => document.querySelector('[data-testid="schedule-dialog-error"]') !== null, null, { timeout: 5000 });
  const disabledError = await textOf(page, "schedule-dialog-error");
  check(`${tag} s9 예약을 끈 서버: 직접 고르기가 이유 + 다음 행동을 말한다`, disabledError.includes("이 서버에서는 예약을 쓸 수 없어요") && disabledError.includes("관리자에게 물어보세요"), disabledError);
  const commitDim = await page.getByTestId("schedule-dialog-commit").evaluate((el) => ({ disabled: el.disabled, opacity: Number(getComputedStyle(el).opacity) }));
  check(`${tag} s9 예약을 끈 서버: 「예약하기」가 흐리다(disabled, 불투명도 ${commitDim.opacity})`, commitDim.disabled === true && commitDim.opacity < 1, JSON.stringify(commitDim));
  check(`${tag} s9 예약을 끈 서버: 취소는 눌린다(닫을 길이 있다)`, !(await page.getByTestId("schedule-dialog-cancel").isDisabled()));
  check(`${tag} s9 예약을 끈 서버: 날짜·시간 칸도 오프라인처럼 잠긴다`, (await page.getByTestId("schedule-dialog-date").isDisabled()) && (await page.getByTestId("schedule-dialog-time").isDisabled()));
  await shot(page, "s9-disabled-dialog", tag);
  await page.getByTestId("schedule-dialog-cancel").click();
  await page.getByTestId("schedule-dialog").waitFor({ state: "detached", timeout: 3000 });
  const trigger = page.getByTestId("composer-schedule-trigger");
  check(`${tag} s9 예약을 끈 서버: ▾가 흐리고(aria-disabled) title이 이유 + 다음 행동을 합쳐 싣는다`, (await trigger.getAttribute("aria-disabled")) === "true" && (await trigger.getAttribute("title")) === "이 서버에서는 예약을 쓸 수 없어요. 관리자에게 물어보세요.", (await trigger.getAttribute("title")) ?? "");
  await trigger.focus();
  await trigger.click({ force: true });
  await page.waitForTimeout(150);
  check(`${tag} s9 예약을 끈 서버: 눌러서 이유를 듣는다(입력창 3초 줄)`, (await textOf(page, "composer-status-line")) === "이 서버에서는 예약을 쓸 수 없어요", await textOf(page, "composer-status").catch(() => ""));
  await shot(page, "s9-disabled-trigger", tag);
  await context.close();

  // (3) 요청 중: 직접 고르기는 「예약 중」이고 Esc가 닫지 않는다. 프리셋 요청 중에는 보내기와 ▾가 aria-busy다
  resetWorld();
  world.createMode = "hang";
  ({ context, page } = await open(browser, origin, scheme, viewport));
  await openChannel(page);
  await type(page, "composer-input", "내일 회의 전에 자료 올려 둘게요");
  await page.getByTestId("composer-schedule-trigger").click();
  await must(page, "composer-schedule-menu", 5000);
  await page.getByTestId("composer-schedule-custom").click();
  await must(page, "schedule-dialog", 5000);
  await page.getByTestId("schedule-dialog-commit").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="schedule-dialog-commit"]')?.getAttribute("aria-busy") === "true", null, { timeout: 5000 });
  check(`${tag} s9 요청 중: 확인은 「예약 중」(aria-busy)이고 칸과 취소가 잠긴다`, (await textOf(page, "schedule-dialog-commit")) === "예약 중" && (await page.getByTestId("schedule-dialog-date").isDisabled()) && (await page.getByTestId("schedule-dialog-cancel").isDisabled()));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check(`${tag} s9 요청 중: Esc가 대화상자를 닫지 않는다(결과를 모르는 채 화면이 사라지지 않는다)`, await has(page, "schedule-dialog"));
  await shot(page, "s9-dialog-busy", tag);
  await context.close();

  resetWorld();
  world.createMode = "hang";
  ({ context, page } = await open(browser, origin, scheme, viewport));
  await openChannel(page);
  await type(page, "composer-input", "내일 회의 전에 자료 올려 둘게요");
  await page.getByTestId("composer-schedule-trigger").click();
  await must(page, "composer-schedule-menu", 5000);
  await page.getByTestId("composer-schedule-preset-tomorrow").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="composer-send"]')?.getAttribute("aria-busy") === "true", null, { timeout: 5000 });
  check(`${tag} s9 요청 중(프리셋): 보내기와 ▾가 aria-busy이고 글은 아직 그대로다`, (await page.getByTestId("composer-schedule-trigger").getAttribute("aria-busy")) === "true" && (await page.getByTestId("composer-input").inputValue()) === "내일 회의 전에 자료 올려 둘게요");
  check(`${tag} s9 요청 중(프리셋): 눈에 보이는 3초 줄 자리와 낭독 노드가 「예약 중」을 말한다`, (await textOf(page, "composer-status-line")) === "예약 중" && (await textOf(page, "composer-status")) === "예약 중", await textOf(page, "composer-status").catch(() => ""));
  await shot(page, "s9-busy", tag);
  await context.close();

  // (4) 이벤트로만 안 행: 본문은 뒤따르는 읽기가 채우고, 그동안은 뼈대 막대가 선다
  resetWorld();
  ({ context, page } = await open(browser, origin, scheme, viewport, { hash: "/scheduled" }));
  await must(page, "scheduled-empty", 15_000);
  const late = scheduledRow({ channelId: chDeploy, body: "금요일 배포 공지", sendAtMs: TOMORROW_9, status: "failed", failureReason: "sessions_ended", rev: 2 });
  world.scheduled = [late];
  world.listDelayMs = 2500;
  const delivered = await page.evaluate(([prefix, data]) => window.__capturePush(prefix, data), ["user:read-state#", {
    type: "scheduled_message.updated",
    ts: new Date(NOW).toISOString(),
    payload: {
      workspace_id: workspaceId.toUpperCase(), member_id: me.toUpperCase(), scheduled_message_id: late.id.toUpperCase(),
      channel_id: chDeploy.toUpperCase(), status: "failed", failure_reason: "sessions_ended", send_at_ms: late.sendAtMs, rev: 2,
    },
  }]);
  check(`${tag} s9 뼈대 행: 신호가 구독한 개인 채널로 갔다`, delivered >= 1, String(delivered));
  await must(page, "scheduled-row-stub", 3000);
  const stubBox = await page.getByTestId("scheduled-row-stub").boundingBox();
  check(`${tag} s9 뼈대 행: 본문 자리는 24px 높이의 중성 막대로 서 있다(높이 ${stubBox?.height})`, stubBox !== null && Math.round(stubBox.height) === 24, JSON.stringify(stubBox));
  check(`${tag} s9 뼈대 행: 사유 줄과 「내용 확인」은 이미 서 있다`, (await textOf(page, "scheduled-row-reason")) === "로그인이 끝나서 예약을 멈췄어요" && (await textOf(page, "scheduled-row-review")) === "내용 확인");
  await shot(page, "s9-stub-row", tag);
  await page.waitForFunction(() => !document.querySelector('[data-testid="scheduled-row-stub"]'), null, { timeout: 9000 });
  check(`${tag} s9 뼈대 행: 읽기가 끝나면 본문이 채워진다`, (await textOf(page, "scheduled-row-preview")) === "금요일 배포 공지");
  await context.close();
}

// ---- p 폰 폭(390) ------------------------------------------------------------------------------------
// 폰 폭(<600px)에서 액션 행의 메타 슬롯은 107px다: 3초 줄(「10월 26일 (월) 오전 9:00에 보낼게요」 184px, 막힌 ▾의 이유)이
// 잘리고, 터치에는 `title`이 없다. 그래서 이 폭에서는 줄이 그릇 **위**에 서고(폰 DM 힌트·오프라인 줄과 같은 자리) 잘리지 않아야 한다.
async function scenePhone(browser, origin, scheme) {
  if (BEFORE) return;
  const viewport = { width: 390, height: 844 };
  const tag = `${viewport.width}-${scheme}`;
  const facts = (page) => page.evaluate(() => {
    const line = document.querySelector('[data-testid="composer-status-line"]');
    if (!line) return null;
    const rect = line.getBoundingClientRect();
    const slot = Array.from(document.querySelectorAll("[data-composer-meta-slot]")).map((el) => el.textContent ?? "").join("");
    const root = document.querySelector('[data-testid="composer"]')?.getBoundingClientRect();
    return {
      text: (line.textContent ?? "").replace(/\s+/g, " ").trim(),
      outsideForm: line.closest("form") === null,
      ariaHidden: line.getAttribute("aria-hidden"),
      left: rect.left, right: rect.right, height: rect.height,
      clipped: line.scrollWidth > line.clientWidth + 1,
      inSlot: slot.includes((line.textContent ?? "").trim()),
      lines: Math.round(rect.height / parseFloat(getComputedStyle(line).lineHeight)),
      composerHeight: root ? root.height : null,
      viewportWidth: window.innerWidth,
    };
  });
  const composerHeight = (page) => page.evaluate(() => document.querySelector('[data-testid="composer"]')?.getBoundingClientRect().height ?? null);
  const expectBand = async (page, label, expected) => {
    const f = await facts(page);
    check(`${tag} p ${label}: 문장이 그릇 위 줄에 그대로 선다`, f !== null && f.text === expected, JSON.stringify(f));
    check(`${tag} p ${label}: 폼(액션 행) 밖이고 낭독에는 한 번만(aria-hidden)`, f !== null && f.outsideForm && f.ariaHidden === "true", JSON.stringify(f));
    check(`${tag} p ${label}: 화면 안에서 잘리지 않고(${f?.lines}줄) 슬롯에 사본이 없다`, f !== null && !f.clipped && f.left >= 0 && f.right <= f.viewportWidth && f.lines <= 2 && !f.inSlot, JSON.stringify(f));
    check(`${tag} p ${label}: 낭독 노드가 같은 문장을 읽는다`, (await textOf(page, "composer-status")) === expected, await textOf(page, "composer-status"));
    return f;
  };

  // (1) 막힌 ▾의 이유
  resetWorld();
  let { context, page } = await open(browser, origin, scheme, viewport);
  await openChannel(page);
  const idleHeight = await composerHeight(page);
  const trigger = page.getByTestId("composer-schedule-trigger");
  const triggerBox = await trigger.boundingBox();
  const sendBox = await page.getByTestId("composer-send").boundingBox();
  check(`${tag} p ▾와 보내기는 44px 타깃이다(${triggerBox?.width}×${triggerBox?.height}, ${sendBox?.width}×${sendBox?.height})`, triggerBox !== null && sendBox !== null && triggerBox.width >= 44 && triggerBox.height >= 44 && sendBox.width >= 44 && sendBox.height >= 44);
  await trigger.focus();
  await trigger.click({ force: true });
  await page.waitForTimeout(150);
  const blocked = await expectBand(page, "막힌 ▾", "보낼 내용을 쓰면 예약할 수 있어요");
  check(`${tag} p 막힌 ▾: 줄이 서 있는 동안 입력창은 한 줄만큼 자란다(${idleHeight} → ${blocked?.composerHeight})`, idleHeight !== null && blocked !== null && blocked.composerHeight !== null && blocked.composerHeight > idleHeight && blocked.composerHeight - idleHeight <= 40, `${idleHeight} -> ${blocked?.composerHeight}`);
  check(`${tag} p 가로 넘침 0 (줄이 서 있을 때)`, (await overflowX(page)) === 0);
  await shot(page, "p-blocked", tag);
  await page.waitForFunction(() => !document.querySelector('[data-testid="composer-status-line"]'), null, { timeout: 6000 });
  check(`${tag} p 3초 뒤 줄이 걷히고 입력창은 원래 높이로 돌아온다`, Math.abs((await composerHeight(page)) - idleHeight) < 1, `${idleHeight} -> ${await composerHeight(page)}`);

  // (2) 메뉴는 화면 안에 서고, 예약 확정 줄이 그릇 위에 선다
  await type(page, "composer-input", "내일 회의 전에 자료 올려 둘게요");
  await trigger.click();
  await must(page, "composer-schedule-menu", 5000);
  check(`${tag} p 메뉴가 화면 안에 선다`, await page.getByTestId("composer-schedule-menu").evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.left >= 0 && r.right <= window.innerWidth && r.top >= 0 && r.bottom <= window.innerHeight;
  }));
  await shot(page, "p-menu", tag);
  await page.getByTestId("composer-schedule-preset-tomorrow").click();
  await page.waitForFunction(() => (document.querySelector('[data-testid="composer-status-line"]')?.textContent ?? "").includes("보낼게요"), null, { timeout: 5000 });
  await expectBand(page, "예약 확정", "내일 오전 9:00에 보낼게요");
  check(`${tag} p 예약 확정: 배너도 서 있다`, (await textOf(page, "composer-scheduled-banner")).startsWith("이 채널에 예약된 메시지 1개"));
  await shot(page, "p-after", tag);
  await context.close();

  // (3) 가장 긴 문장: 월요일로 밀린 확정 줄(184px)
  resetWorld();
  ({ context, page } = await open(browser, origin, scheme, viewport));
  await openChannel(page);
  await type(page, "composer-input", "내일 회의 전에 자료 올려 둘게요");
  await page.getByTestId("composer-schedule-trigger").click();
  await must(page, "composer-schedule-menu", 5000);
  await page.getByTestId("composer-schedule-preset-next-monday").click();
  await page.waitForFunction(() => (document.querySelector('[data-testid="composer-status-line"]')?.textContent ?? "").includes("보낼게요"), null, { timeout: 5000 });
  await expectBand(page, "가장 긴 확정 문장", "10월 26일 (월) 오전 9:00에 보낼게요");
  await shot(page, "p-after-long", tag);
  await context.close();

  // (4) 예약을 끈 서버의 이유
  resetWorld();
  world.createMode = "disabled";
  ({ context, page } = await open(browser, origin, scheme, viewport));
  await openChannel(page);
  await type(page, "composer-input", "내일 회의 전에 자료 올려 둘게요");
  await page.getByTestId("composer-schedule-trigger").click();
  await must(page, "composer-schedule-menu", 5000);
  await page.getByTestId("composer-schedule-preset-tomorrow").click();
  await must(page, "schedule-dialog", 5000);
  await page.waitForFunction(() => document.querySelector('[data-testid="schedule-dialog-error"]') !== null, null, { timeout: 5000 });
  check(`${tag} p 예약을 끈 서버: 대화상자가 화면 안에 서고 가로 넘침이 없다`, await page.getByTestId("schedule-dialog").evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.left >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight;
  }) && (await overflowX(page)) === 0);
  await shot(page, "p-disabled-dialog", tag);
  await page.getByTestId("schedule-dialog-cancel").click();
  await page.getByTestId("schedule-dialog").waitFor({ state: "detached", timeout: 3000 });
  await page.getByTestId("composer-schedule-trigger").focus();
  await page.getByTestId("composer-schedule-trigger").click({ force: true });
  await page.waitForTimeout(150);
  await expectBand(page, "예약을 끈 서버", "이 서버에서는 예약을 쓸 수 없어요");
  await shot(page, "p-disabled", tag);
  await context.close();
}

// ---- w 폭 ---------------------------------------------------------------------------------------------
async function sceneWidths(browser, origin, scheme) {
  if (BEFORE) return;
  const variants = [
    { name: "1280", viewport: { width: 1280, height: 800 } },
    { name: "900", viewport: { width: 900, height: 800 } },
    { name: "1440-collapsed", viewport: { width: 1440, height: 900 }, collapse: true },
  ];
  for (const variant of variants) {
    const tag = `${variant.name}-${scheme}`;
    resetWorld([{ sendAtMs: TOMORROW_9 }, { sendAtMs: NOW + 2 * DAY, body: "다음 주 회의 안건 정리" }]);
    const { context, page } = await open(browser, origin, scheme, variant.viewport);
    if (variant.collapse) {
      await page.getByTestId("sidebar-toggle").click();
      await page.waitForTimeout(300);
    }
    await openChannel(page);
    await must(page, "composer-scheduled-banner", 10_000);
    await type(page, "composer-input", "내일 회의 전에 자료 올려 둘게요");
    const trigger = page.getByTestId("composer-schedule-trigger");
    const send = page.getByTestId("composer-send");
    check(`${tag} w ▾와 보내기가 한 줄에 붙어 있다`, await (async () => {
      const a = await send.boundingBox();
      const b = await trigger.boundingBox();
      return a !== null && b !== null && Math.abs(a.y - b.y) < 1 && Math.abs(a.height - b.height) < 1 && b.x - (a.x + a.width) <= 2 && b.x >= a.x;
    })());
    check(`${tag} w 배너가 보인다`, (await textOf(page, "composer-scheduled-banner")).startsWith("이 채널에 예약된 메시지 2개"));
    check(`${tag} w 가로 넘침 0`, (await overflowX(page)) === 0);
    await shot(page, "w-composer", tag);
    await trigger.click();
    await must(page, "composer-schedule-menu", 5000);
    check(`${tag} w 메뉴가 화면 안에 선다`, await page.getByTestId("composer-schedule-menu").evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.left >= 0 && r.right <= window.innerWidth && r.top >= 0 && r.bottom <= window.innerHeight;
    }));
    await shot(page, "w-menu", tag);
    await context.close();
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  if (!existsSync(resolve(DIST_DIR, "index.html"))) throw new Error(`번들이 없다: ${DIST_DIR} (npm run build 먼저)`);
  const preview = await startGuardedPreview({
    webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT",
    extraArgs: ["--outDir", DIST_DIR],
  });
  // `--lang=ko-KR`: 헤드리스 Chromium은 `locale: "ko-KR"`만으로는 날짜·시간 칸을 영어 모양(10/23/2026, 09:00 AM)으로 그린다.
  // 브라우저의 UI 언어를 맞춰야 한국어 모양(2026. 10. 23., 오전 09:00)이 된다(design-review가 짚은 하네스 한계).
  const browser = await chromium.launch({ args: ["--lang=ko-KR"] });
  const browserWithBars = await chromium.launch({ args: ["--lang=ko-KR"], ignoreDefaultArgs: ["--hide-scrollbars"] });
  try {
    for (const scheme of (process.env.SCHEMES || "light,dark").split(",")) {
      const desktop = { width: 1440, height: 900 };
      if (WANT.has("s1")) await sceneDefault(browser, preview.origin, scheme, desktop);
      if (WANT.has("s2")) await sceneMenu(browser, preview.origin, scheme, desktop);
      if (WANT.has("s3")) await sceneCustom(browser, preview.origin, scheme, desktop);
      if (WANT.has("s4")) await sceneAfter(browser, preview.origin, scheme, desktop);
      if (WANT.has("s5")) await sceneBanners(browser, preview.origin, scheme, desktop);
      if (WANT.has("s6")) {
        await sceneList(browser, preview.origin, scheme, desktop);
        await sceneListStates(browser, preview.origin, scheme, desktop);
      }
      if (WANT.has("s7")) {
        await sceneFailures(browser, preview.origin, scheme, desktop);
        await sceneReviewLong(browserWithBars, preview.origin, scheme, desktop);
        await sceneEvent(browser, preview.origin, scheme, desktop);
      }
      if (WANT.has("s8")) await sceneOffline(browser, preview.origin, scheme, desktop);
      if (WANT.has("s9")) await sceneExtras(browser, preview.origin, scheme, desktop);
      if (WANT.has("w")) await sceneWidths(browser, preview.origin, scheme);
      if (WANT.has("p")) await scenePhone(browser, preview.origin, scheme);
    }
  } finally {
    await browser.close();
    await browserWithBars.close();
    await preview.stop?.();
  }
  writeFileSync(resolve(OUT_DIR, "report.json"), `${JSON.stringify({ mode: BEFORE ? "before" : "after", results }, null, 2)}\n`);
  if (!BEFORE && failures.length > 0) {
    console.error(`\n${failures.length}개 단언 실패`);
    process.exit(1);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
