#!/usr/bin/env node
// GATE: #5603 (owner 11-09) — 위로 올려 둔 채 내가 보내면 맨 아래로 · 같은 사람 묶음은 같은 분까지만.
//
// 실제 번들 · 실제 가상 목록을 **WebKit**(데스크탑 앱의 WKWebView와 같은 엔진)과 Chromium에서 잰다(1280).
//   ① 채널: 위로 올려 읽던 중(「최신 메시지로 이동」이 선 상태) 입력창에서 보내면 → 목록이 맨 아래(거리 ≤2px)이고 보낸 줄이 화면 안이며
//      필이 걷힌다. **1초 더 기다려 다시 잰다** — 보던 줄을 지키는 바로잡기(#5583 수동 앵커)가 따라가기를 무르면 여기서 잡힌다.
//   ② 대조: 위로 올려 읽던 중 **남의** 말이 오면 화면은 그대로(±8px)이고 필이 1개를 센다(지금 규칙 그대로).
//   ③ 스레드: 답글 목록을 맨 위로 올려 둔 채 답글을 달면 → 답글 목록이 맨 아래이고 단 답글이 화면 안이다.
//   ④ 묶음: 같은 사람이 47분·50분에 한 말은 머리 둘, 같은 분(52분)의 두 말은 머리 하나다(머리 = 아바타 단추가 선 행).
// 서버는 이 파일의 가짜 `/v1`과 가짜 실시간(센트리퓨고 JSON 프로토콜의 최소판, 페이지 안의 WebSocket 대역)이다. 인물·대화는 지어낸 것이다.
//
// 사용: npm run build && node gates/gate-send-follow.mjs
//   SEND_FOLLOW_ENGINES=webkit,chromium   (기본 둘 다)
//   SEND_FOLLOW_PORT=<포트>               미리보기 포트(기본 5214)
//   SEND_FOLLOW_DIST=<폴더>               dist 대신 이 번들을 띄운다(수리 전 번들로 RED 를 다시 보일 때)
//   SEND_FOLLOW_CAPTURE=<폴더>            Chromium 밝게·어둡게 캡처(묶음 · 보낸 직후)
//   SEND_FOLLOW_SKEW=1                    ⑤ 시계 어긋남 장면만 돌린다(#5624, 아래)
//
// ⑤ 시계 어긋남(#5624): 가짜 서버가 확정본을 「지금 + 어긋남」으로 찍는다(응답 지연 1.5초). 바닥에서 내 글을 하나 보낸 뒤(그 응답이
//    서버 시계를 알려 준다) 같은 분에 하나 더 보내는 동안, 화면이 그린 모든 프레임에서 바로 위 줄의 위치와 보낸 줄의 높이를 잰다.
//    ±90초·0초, 분 경계(시계는 맞고 응답 사이에 분이 바뀜), 연달아 두 번. 보낸 줄은 처음부터 끝까지 한 높이(이어진 줄)여야 하고, 위 줄의
//    이동 폭은 이어진 줄 하나만큼(옛 규칙 44px)이어야 한다. 고치기 전에는 메아리에 머리가 섰다 접히며 72px였다.

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { startGuardedPreview } from "./preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.SEND_FOLLOW_PORT || 5214);
const origin = `http://127.0.0.1:${port}`;
const engineNames = (process.env.SEND_FOLLOW_ENGINES || "webkit,chromium")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const distOverride = process.env.SEND_FOLLOW_DIST || null;
const captureDir = process.env.SEND_FOLLOW_CAPTURE || null;
const skewOnly = process.env.SEND_FOLLOW_SKEW === "1";
// ⑤의 장면 하나만 돌린다(예: boundary). 비우면 다섯 장면 모두.
const skewScenesWanted = (process.env.SEND_FOLLOW_SKEW_SCENES || "").split(",").map((name) => name.trim()).filter(Boolean);
// ⑤ 가짜 서버의 시계: 확정본의 `createdAtMs`는 지금 + skewMs, 응답은 postDelayMs 뒤.
const backendClock = { skewMs: 0, postDelayMs: 150 };
const viewport = { width: 1280, height: 800 };

const workspaceId = "00000000-0000-7000-8000-000000000001";
const meId = "00000000-0000-7000-8000-000000000131";
const peerId = "00000000-0000-7000-8000-000000000132";
const channelId = "00000000-0000-7000-8000-000000000231";
const ROOT_MSG = "0199ffff-0000-7000-8000-000000000a20";
const MIN47_MSG = "0199ffff-0000-7000-8000-000000000b01";
const MIN50_MSG = "0199ffff-0000-7000-8000-000000000b02";
const SAME1_MSG = "0199ffff-0000-7000-8000-000000000b03";
const SAME2_MSG = "0199ffff-0000-7000-8000-000000000b04";

const session = {
  accessToken: "gate-only-not-a-credential",
  refreshToken: "gate-only-not-a-credential",
  member: { id: meId, workspaceId, kind: "human", displayName: "한울", handle: "haneul" },
  realtimeWebSocketUrl: "ws://send-follow.invalid/connection/websocket",
};

function member(over) {
  return {
    workspaceId,
    status: "active",
    role: "member",
    channelCount: 1,
    channelIds: [channelId],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  };
}
const roster = [
  member({ id: meId, kind: "human", role: "owner", displayName: "한울", handle: "haneul" }),
  member({ id: peerId, kind: "human", displayName: "다온", handle: "daon" }),
];
const channels = [{ id: channelId, workspaceId, kind: "public", name: "release-notes", muted: false }];

/** 오늘의 그 시각(로컬). 묶음은 로컬 분으로 갈리므로 픽스처도 로컬 시각으로 짓는다. */
function todayAt(hour, minute, second = 0) {
  const d = new Date();
  d.setHours(hour, minute, second, 0);
  return d.getTime();
}

function row(over) {
  return { channelId, hlcCount: 0, type: "text", state: "sent", ...over, hlcTs: over.hlcTs ?? over.createdAtMs };
}

function history() {
  const rows = [];
  // 읽을 거리: 두 사람이 2분마다 번갈아 한 말 40줄(각자 다른 분이라 줄마다 머리가 선다). 가운데 하나가 답글 30개의 스레드 루트다.
  for (let i = 0; i < 40; i += 1) {
    const at = todayAt(9, 0) + i * 120_000;
    const isRoot = i === 20;
    rows.push(
      row({
        id: isRoot ? ROOT_MSG : `0199ffff-0000-7000-8000-${String(0xa00 + i).padStart(12, "0")}`,
        seq: 100 + i,
        authorMemberId: i % 2 === 0 ? peerId : meId,
        body: isRoot ? "릴리스 노트 초안은 이 스레드에서 이어 갈게요." : `${i + 1}번째 이야기입니다. 오늘 일정과 남은 일을 정리했어요.`,
        createdAtMs: at,
        ...(isRoot ? { thread: { reply_count: 30, last_reply_seq: 1029, last_reply_at: at + 30 * 60_000 } } : {}),
      })
    );
  }
  // 묶음 픽스처(#5603): 같은 사람이 47분과 50분에(머리 둘), 52분에 두 번(머리 하나).
  rows.push(row({ id: MIN47_MSG, seq: 140, authorMemberId: peerId, body: "47분에 보낸 말입니다.", createdAtMs: todayAt(15, 47, 10) }));
  rows.push(row({ id: MIN50_MSG, seq: 141, authorMemberId: peerId, body: "50분에 보낸 말입니다.", createdAtMs: todayAt(15, 50, 5) }));
  rows.push(row({ id: SAME1_MSG, seq: 142, authorMemberId: peerId, body: "52분의 첫 말입니다.", createdAtMs: todayAt(15, 52, 5) }));
  rows.push(row({ id: SAME2_MSG, seq: 143, authorMemberId: peerId, body: "같은 52분의 둘째 말입니다.", createdAtMs: todayAt(15, 52, 40) }));
  return rows;
}

function replies() {
  const rows = [];
  for (let i = 0; i < 30; i += 1) {
    rows.push(
      row({
        id: `0199ffff-0000-7000-8000-${String(0xc00 + i).padStart(12, "0")}`,
        seq: 1000 + i,
        rootId: ROOT_MSG,
        authorMemberId: i % 2 === 0 ? peerId : meId,
        body: `답글 ${i + 1}: 항목을 하나씩 확인하고 있어요.`,
        createdAtMs: todayAt(9, 40) + i * 60_000,
      })
    );
  }
  return rows;
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function installBackend(context) {
  const state = { messages: history(), replies: replies(), nextSeq: 2000 };
  await context.route("**/healthz", (route) => json(route, { status: "ok" }));
  await context.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === "/v1/auth/login") return json(route, session);
    if (path === "/v1/auth/realtime-token") {
      return json(route, {
        token: "gate-only-not-a-credential",
        tokenType: "Bearer",
        expiresAtMs: Date.now() + 600_000,
        ttlSeconds: 600,
        workspaceId,
        memberId: meId,
      });
    }
    if (path === "/v1/auth/refresh") return json(route, { accessToken: session.accessToken, refreshToken: session.refreshToken });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/reactions")) return json(route, { reactions: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-sessions")) return json(route, { sessions: [] });
    if (/\/expressions$/.test(path)) {
      return json(route, { workspaceId, version: "1", baseVersion: null, reset: true, addPolicy: "members", items: [] });
    }
    if (path.endsWith("/replies")) return json(route, { messages: state.replies, following: true });
    if (path.endsWith("/messages") && request.method() === "POST") {
      const sent = JSON.parse(request.postData() ?? "{}");
      state.nextSeq += 1;
      const message = row({
        id: crypto.randomUUID(),
        seq: state.nextSeq,
        authorMemberId: meId,
        body: sent.body ?? "",
        ...(sent.rootId ? { rootId: sent.rootId } : {}),
      });
      // 서버처럼 지연을 둔다: 메아리가 먼저 서고 확정본이 뒤따른다. 서버는 응답 직전에 시각을 찍는다(⑤의 분 경계가 이 순서를 쓴다).
      await wait(backendClock.postDelayMs);
      message.createdAtMs = Date.now() + backendClock.skewMs;
      message.hlcTs = message.createdAtMs;
      if (sent.rootId) state.replies.push(message);
      else state.messages.push(message);
      return json(route, message, 201);
    }
    if (path.includes("/messages")) {
      if (url.searchParams.has("after") || url.searchParams.has("before")) return json(route, { messages: [] });
      return json(route, { messages: state.messages });
    }
    return json(route, {});
  });
}

async function installRealtimeSocket(page) {
  await page.addInitScript(() => {
    const sockets = new Set();
    let offset = 0;
    class GateWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      constructor(url) {
        this.url = url;
        this.readyState = GateWebSocket.CONNECTING;
        this.subscriptions = new Set();
        sockets.add(this);
        queueMicrotask(() => {
          this.readyState = GateWebSocket.OPEN;
          this.onopen?.(new Event("open"));
        });
      }
      send(data) {
        const out = [];
        for (const line of String(data).trim().split("\n")) {
          const command = JSON.parse(line);
          if (command.connect) out.push({ id: command.id, connect: { client: "send-follow", version: "6" } });
          else if (command.subscribe) {
            this.subscriptions.add(command.subscribe.channel);
            out.push({ id: command.id, subscribe: { recoverable: true, positioned: true, recovered: true, epoch: "send-follow", offset } });
          } else if (command.unsubscribe) {
            this.subscriptions.delete(command.unsubscribe.channel);
            out.push({ id: command.id, unsubscribe: {} });
          } else out.push({ id: command.id });
        }
        queueMicrotask(() => this.onmessage?.(new MessageEvent("message", { data: out.map((x) => JSON.stringify(x)).join("\n") })));
      }
      close() {
        this.readyState = GateWebSocket.CLOSED;
        sockets.delete(this);
        this.onclose?.(new CloseEvent("close", { code: 1000 }));
      }
    }
    window.WebSocket = GateWebSocket;
    window.__sendFollowSubscribed = () => [...sockets].some((s) => [...s.subscriptions].some((name) => name.startsWith("ch:")));
    window.__sendFollowPublish = (frame) => {
      offset += 1;
      const stamped = { ...frame, ts: Date.now() };
      for (const socket of sockets) {
        for (const name of socket.subscriptions) {
          if (!name.startsWith("ch:")) continue;
          socket.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ push: { channel: name, pub: { data: stamped, offset } } }) }));
        }
      }
    };
  });
}

const SCROLLER = '[data-testid="timeline-virtuoso"]';

async function openChannel(page) {
  await page.goto(origin, { waitUntil: "networkidle" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("haneul@example.test");
  await page.getByTestId("login-password").fill("gate-only");
  await page.getByTestId("login-submit").click();
  await page.locator(`[data-testid="channel-item"][data-channel-id="${channelId}"]`).click();
  await page.getByTestId("composer-input").waitFor();
  await page.waitForFunction(() => window.__sendFollowSubscribed?.() === true, null, { timeout: 15_000 });
  await page.waitForFunction(
    (selector) => {
      const node = document.querySelector(selector);
      return node !== null && node.scrollHeight > node.clientHeight + 400;
    },
    SCROLLER,
    { timeout: 15_000 }
  );
  for (let i = 0; i < 3; i += 1) {
    await page.locator(SCROLLER).evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await wait(400);
  }
}

/** 목록 바닥까지의 거리(px)와 텍스트가 든 줄이 목록 창 안에 다 보이는지. */
async function measureList(page, selector, text) {
  return page.evaluate(
    ({ selector, text }) => {
      const node = document.querySelector(selector);
      if (node === null) return null;
      const box = node.getBoundingClientRect();
      const rows = [...node.querySelectorAll("[data-testid='timeline-message'], [data-testid='pending-row'], [data-message-id]")];
      const hit = text === null ? null : rows.reverse().find((el) => (el.textContent ?? "").includes(text));
      const rowBox = hit?.getBoundingClientRect() ?? null;
      return {
        distance: Math.round(node.scrollHeight - node.scrollTop - node.clientHeight),
        scrollTop: Math.round(node.scrollTop),
        rowVisible: rowBox !== null && rowBox.top >= box.top - 1 && rowBox.bottom <= box.bottom + 1,
        detail:
          rowBox === null
            ? `줄 없음(행 ${rows.length})`
            : `줄 ${Math.round(rowBox.top - box.top)}..${Math.round(rowBox.bottom - box.top)} / 창 ${Math.round(box.height)}`,
      };
    },
    { selector, text }
  );
}

async function scrollUp(page) {
  await page.locator(SCROLLER).evaluate((node) => {
    // 0까지 가면 `startReached`가 옛 페이지를 부른다 — 35%쯤에서 읽는다.
    node.scrollTop = Math.round(node.scrollHeight * 0.35);
  });
  await wait(700);
}

async function send(page, inputTestId, text) {
  const input = page.getByTestId(inputTestId);
  await input.click();
  await input.fill(text);
  await input.press("Enter");
}

async function capture(page, engine, name) {
  if (captureDir === null) return;
  mkdirSync(captureDir, { recursive: true });
  await page.screenshot({ path: resolve(captureDir, `${engine}-${name}.png`) });
}

async function runScenes(browser, engine, colorScheme) {
  const failures = [];
  const where = `${engine}/${colorScheme}`;
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, locale: "ko-KR", colorScheme });
  await installBackend(context);
  const page = await context.newPage();
  await installRealtimeSocket(page);
  await openChannel(page);

  // ④ 묶음: 같은 사람 47분 · 50분은 머리 둘, 같은 52분 두 말은 머리 하나.
  const heads = await page.evaluate((ids) => {
    const out = {};
    for (const id of ids) {
      const el = document.querySelector(`[data-testid="timeline-message"][data-message-id="${id}"]`);
      out[id] = el === null ? null : el.querySelector('[data-testid="row-avatar-profile"]') !== null;
    }
    return out;
  }, [MIN47_MSG, MIN50_MSG, SAME1_MSG, SAME2_MSG]);
  console.log(`[${where}] 머리: 47분 ${heads[MIN47_MSG]} · 50분 ${heads[MIN50_MSG]} · 52분 첫 ${heads[SAME1_MSG]} · 52분 둘째 ${heads[SAME2_MSG]}`);
  if (heads[MIN47_MSG] !== true || heads[MIN50_MSG] !== true) failures.push(`${where}: 47분·50분의 말이 머리 둘이 아니다 (${JSON.stringify(heads)})`);
  if (heads[SAME1_MSG] !== true || heads[SAME2_MSG] !== false) failures.push(`${where}: 같은 52분의 두 말이 머리 하나가 아니다 (${JSON.stringify(heads)})`);
  await capture(page, `${engine}-${colorScheme}`, "1-groups-47-50-and-same-minute");

  // 기준: 바닥에서 보낸다(수리 전에도 따라가던 길). 위에서 보낸 결과가 이것과 같아야 한다.
  const baseText = `바닥에서 보낸 글 ${engine}`;
  await send(page, "composer-input", baseText);
  await wait(1700);
  const base = await measureList(page, SCROLLER, baseText);
  console.log(`[${where}] 바닥에서 보내기: 거리 ${base?.distance}(보임 ${base?.rowVisible}, ${base?.detail})`);

  // ① 채널: 위로 올려 둔 채 내가 보낸다.
  await scrollUp(page);
  const before = await measureList(page, SCROLLER, null);
  const pillBefore = await page.getByTestId("jump-latest").count();
  if (before === null || before.distance < 400 || pillBefore !== 1) {
    failures.push(`${where}: 위로 올린 장면을 못 만들었다 (거리 ${before?.distance}, 필 ${pillBefore})`);
  }
  const sentText = `위에서 보낸 글 ${engine}`;
  await send(page, "composer-input", sentText);
  await wait(700);
  const soon = await measureList(page, SCROLLER, sentText);
  await wait(1000);
  const later = await measureList(page, SCROLLER, sentText);
  const pillAfter = await page.getByTestId("jump-latest").count();
  console.log(
    `[${where}] 채널 보내기: 전 거리 ${before?.distance} → 0.7초 ${soon?.distance}(보임 ${soon?.rowVisible}, ${soon?.detail}) → 1.7초 ${later?.distance}(보임 ${later?.rowVisible}, ${later?.detail}) · 필 ${pillBefore}→${pillAfter}`
  );
  if (soon === null || soon.distance > 2 || !soon.rowVisible) failures.push(`${where}: 보낸 뒤 맨 아래로 가지 않았다 (0.7초 거리 ${soon?.distance}, 보임 ${soon?.rowVisible})`);
  if (later === null || later.distance > 2 || !later.rowVisible) failures.push(`${where}: 맨 아래로 갔다가 되돌아갔다 (1.7초 거리 ${later?.distance}, 보임 ${later?.rowVisible})`);
  if (pillAfter !== 0) failures.push(`${where}: 보낸 뒤에도 「최신 메시지로 이동」이 서 있다`);
  await capture(page, `${engine}-${colorScheme}`, "2-after-send-from-scrolled-up");

  // ② 대조: 위로 올려 둔 채 남의 말이 온다 — 화면은 그대로, 필이 센다.
  await scrollUp(page);
  const parked = await measureList(page, SCROLLER, null);
  await page.evaluate(
    ({ ch, author }) =>
      window.__sendFollowPublish({
        type: "message.new",
        v: 1,
        seq: 3001,
        payload: {
          id: "0199ffff-0000-7000-8000-000000000d01",
          channel_id: ch,
          seq: 3001,
          type: "text",
          body: "남이 보낸 새 말입니다.",
          author_member_id: author,
          hlc_ts: Date.now(),
          hlc_count: 0,
        },
      }),
    { ch: channelId, author: peerId }
  );
  await wait(900);
  const afterPeer = await measureList(page, SCROLLER, null);
  const peerCount = Number((await page.getByTestId("jump-latest").getAttribute("data-new-count").catch(() => null)) ?? -1);
  console.log(`[${where}] 남의 말: 스크롤 ${parked?.scrollTop} → ${afterPeer?.scrollTop} · 필 개수 ${peerCount}`);
  if (parked === null || afterPeer === null || Math.abs(afterPeer.scrollTop - parked.scrollTop) > 8) {
    failures.push(`${where}: 남의 말에 읽던 화면이 밀렸다 (${parked?.scrollTop} → ${afterPeer?.scrollTop})`);
  }
  if (peerCount !== 1) failures.push(`${where}: 남의 말을 필이 1개로 세지 않는다 (${peerCount})`);

  // ③ 스레드: 답글 목록을 맨 위로 올려 둔 채 답글을 단다.
  const rootRow = page.locator(`[data-testid="timeline-message"][data-message-id="${ROOT_MSG}"]`);
  await page.locator(SCROLLER).evaluate((node, id) => {
    const target = node.querySelector(`[data-message-id="${id}"]`);
    if (target) target.scrollIntoView({ block: "center" });
  }, ROOT_MSG);
  await wait(300);
  if ((await rootRow.count()) === 0) {
    // 가상 목록이 아직 그리지 않았다: 스크롤로 찾아 들어간다.
    await page.locator(SCROLLER).evaluate((node) => {
      node.scrollTop = Math.round(node.scrollHeight * 0.45);
    });
    await wait(500);
  }
  await rootRow.scrollIntoViewIfNeeded();
  await rootRow.hover();
  await rootRow.getByTestId("toolbar-reply").click();
  await page.getByTestId("thread-composer-input").waitFor({ state: "visible" });
  const THREAD = '[data-testid="thread-panel"] [data-message-scroll-container]';
  await page.waitForFunction(
    (selector) => {
      const node = document.querySelector(selector);
      return node !== null && node.querySelectorAll("[data-message-id]").length >= 30 && node.scrollHeight > node.clientHeight + 200;
    },
    THREAD,
    { timeout: 15_000 }
  );
  await page.locator(THREAD).evaluate((node) => {
    node.scrollTop = 0;
  });
  await wait(300);
  const threadBefore = await measureList(page, THREAD, null);
  const replyText = `스레드에서 단 답글 ${engine}`;
  await send(page, "thread-composer-input", replyText);
  await wait(1200);
  const threadAfter = await measureList(page, THREAD, replyText);
  console.log(`[${where}] 스레드 답글: 거리 ${threadBefore?.distance} → ${threadAfter?.distance}(보임 ${threadAfter?.rowVisible})`);
  if (threadAfter === null || threadAfter.distance > 2 || !threadAfter.rowVisible) {
    failures.push(`${where}: 답글을 달았는데 답글 목록이 맨 아래로 가지 않았다 (거리 ${threadAfter?.distance}, 보임 ${threadAfter?.rowVisible})`);
  }
  await capture(page, `${engine}-${colorScheme}`, "3-after-thread-reply");
  await context.close();
  return failures;
}

/** 페이지 안에서 매 프레임 「위 줄의 top」과 「보낸 줄의 높이」를 적기 시작한다. `stop`이 모은 값을 돌려준다. */
async function startSampler(page, aboveText, sentText) {
  await page.evaluate(
    ({ selector, aboveText, sentText }) => {
      const samples = [];
      let running = true;
      const rowOf = (text) =>
        [...document.querySelectorAll(`${selector} [data-testid='timeline-message'], ${selector} [data-testid='timeline-pending']`)]
          .reverse()
          .find((el) => (el.textContent ?? "").includes(text)) ?? null;
      const tick = () => {
        if (!running) return;
        const above = rowOf(aboveText);
        const sent = rowOf(sentText);
        samples.push({
          aboveTop: above === null ? null : above.getBoundingClientRect().top,
          sentHeight: sent === null ? null : Math.round(sent.getBoundingClientRect().height),
          sentPending: sent === null ? null : sent.getAttribute("data-testid") === "timeline-pending",
        });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      window.__skewSampler = () => {
        running = false;
        return samples;
      };
    },
    { selector: SCROLLER, aboveText, sentText }
  );
}

async function stopSampler(page) {
  return page.evaluate(() => window.__skewSampler());
}

/** 보낸 줄이 확정될 때까지(메아리가 사라짐) 기다리고, 그 뒤 0.6초 더 잰다. */
async function waitConfirmed(page, text) {
  await page.waitForFunction(
    ({ selector, text }) =>
      ![...document.querySelectorAll(`${selector} [data-testid='timeline-pending']`)].some((el) => (el.textContent ?? "").includes(text)) &&
      [...document.querySelectorAll(`${selector} [data-testid='timeline-message']`)].some((el) => (el.textContent ?? "").includes(text)),
    { selector: SCROLLER, text },
    { timeout: 15_000 }
  );
  await wait(600);
}

function summarize(samples) {
  const tops = samples.map((one) => one.aboveTop).filter((value) => value !== null);
  const heights = [...new Set(samples.map((one) => one.sentHeight).filter((value) => value !== null))];
  const echoHeights = [...new Set(samples.filter((one) => one.sentPending === true).map((one) => one.sentHeight))];
  const settledHeights = [...new Set(samples.filter((one) => one.sentPending === false).map((one) => one.sentHeight))];
  return {
    travel: tops.length === 0 ? null : Math.round((Math.max(...tops) - Math.min(...tops)) * 10) / 10,
    heights,
    echoHeights,
    settledHeights,
    frames: samples.length,
  };
}

/** 밀리초 뒤의 다음 분 경계까지 남은 시간. */
const msToMinute = () => 60_000 - (Date.now() % 60_000);

/** ⑤ 한 장면: 바닥에서 앞 글을 보내 확정시킨 뒤(또는 `rapid`면 곧바로) 둘째 글을 보내며 잰다. */
async function skewScene(browser, engine, colorScheme, { name, skewMs, boundary = false, rapid = false }) {
  const where = `${engine}/${colorScheme}/${name}`;
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, locale: "ko-KR", colorScheme });
  await installBackend(context);
  const page = await context.newPage();
  await installRealtimeSocket(page);
  await openChannel(page);
  backendClock.skewMs = skewMs;
  // 분 경계: 서버는 1초 뒤에 찍는다. 앞 글의 응답이 알려 주는 차이는 그 지연의 절반쯤(+0.5초)이므로, 둘째 글을 경계 0.75초 전에
  // 보내면 메아리의 어림 시각은 경계 앞(같은 분, 이어진 줄)이고 서버의 시각은 경계 뒤(다음 분)다 — 확정본이 에코의 묶음을 이어야 하는 판.
  backendClock.postDelayMs = boundary ? 1000 : 1500;
  const first = `${name} 앞 글입니다.`;
  const second = `${name} 이어 보낸 글입니다.`;
  let result;
  if (rapid) {
    // 연달아 두 번: 첫 응답이 오기 전에 둘째를 보낸다. 위 줄은 화면에 있던 마지막 남의 말이다.
    await startSampler(page, "같은 52분의 둘째 말입니다.", second);
    await send(page, "composer-input", first);
    await wait(250);
    await send(page, "composer-input", second);
    await waitConfirmed(page, first);
    await waitConfirmed(page, second);
    result = summarize(await stopSampler(page));
  } else {
    if (boundary) {
      // 앞 글은 경계 5~15초 전에(같은 분), 둘째는 경계 0.35초 전에 보낸다 — 서버는 0.6초 뒤 경계를 넘겨 찍는다.
      while (msToMinute() > 15_000 || msToMinute() < 5_000) await wait(200);
    }
    await send(page, "composer-input", first);
    await waitConfirmed(page, first);
    await capture(page, engine, `skew-${name}-${colorScheme}-1-before`);
    await startSampler(page, first, second);
    if (boundary) {
      // 글은 미리 채워 두고 Enter만 경계 0.75초 전에 누른다(누르기까지의 지연을 줄인다).
      const input = page.getByTestId("composer-input");
      await input.click();
      await input.fill(second);
      while (msToMinute() > 1_500) await wait(20);
      while (msToMinute() > 750) await wait(5);
      await input.press("Enter");
    } else {
      await send(page, "composer-input", second);
    }
    await wait(boundary ? 200 : 700);
    await capture(page, engine, `skew-${name}-${colorScheme}-2-echo`);
    await waitConfirmed(page, second);
    result = summarize(await stopSampler(page));
    await capture(page, engine, `skew-${name}-${colorScheme}-3-confirmed`);
  }
  await context.close();
  backendClock.skewMs = 0;
  backendClock.postDelayMs = 150;
  console.log(
    `[${where}] 위 줄 이동 ${result.travel}px · 보낸 줄 높이 ${JSON.stringify(result.heights)} ` +
      `(메아리 ${JSON.stringify(result.echoHeights)} → 확정 ${JSON.stringify(result.settledHeights)}) · 프레임 ${result.frames}`
  );
  const failures = [];
  const height = result.heights[0] ?? 99;
  if (result.heights.length !== 1) {
    failures.push(`${where}: 보낸 줄의 높이가 보내는 동안 바뀌었다 ${JSON.stringify(result.heights)} — 머리가 섰다 사라졌다 (#5624)`);
  }
  if (!rapid && !boundary && height > 44) {
    // 서버 시계로도 같은 분이다: 이어진 줄이어야 한다(메아리가 기기 시계로 묶이면 머리가 선다).
    failures.push(`${where}: 같은 분에 이어 보낸 글이 이어진 줄이 아니다(높이 ${height}px) — 메아리가 기기 시계로 묶였다`);
  }
  if (!rapid && (result.travel === null || result.travel > height + 10)) {
    // 위 줄은 보낸 줄 하나만큼 **한 방향으로만** 움직인다(이어진 줄이면 44px 안팎). 더 움직였으면 되돌아온 것이다.
    failures.push(`${where}: 위 줄이 ${result.travel}px 움직였다 — 보낸 줄(${height}px) 하나만큼이어야 한다(되돌아옴)`);
  }
  if (boundary) {
    // 분 경계: 서버는 다음 분에 찍었다. 메아리가 어느 쪽에 서든(어림한 차이의 오차 안) 확정 때 바뀌지 않는 것이 요점이다.
    console.log(`[${where}] 경계의 글은 ${height > 44 ? "머리(다음 분)" : "이어진 줄(앞 분)"}로 서고 그대로였다`);
  }
  return failures;
}

async function runSkewScenes(browser, engine, colorScheme) {
  const failures = [];
  for (const scene of [
    { name: "plus90", skewMs: 90_000 },
    { name: "minus90", skewMs: -90_000 },
    { name: "zero", skewMs: 0 },
    { name: "boundary", skewMs: 0, boundary: true },
    { name: "rapid", skewMs: 90_000, rapid: true },
  ]) {
    if (skewScenesWanted.length > 0 && !skewScenesWanted.includes(scene.name)) continue;
    failures.push(...(await skewScene(browser, engine, colorScheme, scene)));
  }
  return failures;
}

async function main() {
  const server = await startGuardedPreview({
    webRoot,
    port,
    portEnvVar: "SEND_FOLLOW_PORT",
    extraArgs: distOverride ? ["--outDir", resolve(distOverride)] : [],
  });
  const failures = [];
  try {
    for (const name of engineNames) {
      const type = name === "webkit" ? webkit : name === "chromium" ? chromium : null;
      if (type === null) throw new Error(`모르는 엔진: ${name}`);
      const browser = await type.launch({ headless: true });
      try {
        if (skewOnly) {
          failures.push(...(await runSkewScenes(browser, name, "light")));
          if (captureDir !== null && name === "chromium") failures.push(...(await runSkewScenes(browser, name, "dark")));
        } else {
          failures.push(...(await runScenes(browser, name, "light")));
          if (captureDir !== null && name === "chromium") failures.push(...(await runScenes(browser, name, "dark")));
        }
      } finally {
        await browser.close();
      }
    }
  } finally {
    await server.stop();
  }
  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    process.exit(1);
  }
  if (skewOnly) {
    console.log(`PASS send-follow skew: ${engineNames.join("·")} — ±90초·0초·분 경계에서 이어 보낸 글이 처음부터 이어진 줄이고 위 줄은 44px 안팎 · 연달아 두 번에서 높이 불변`);
    return;
  }
  console.log(`PASS send-follow: ${engineNames.join("·")} — 위에서 보내면 맨 아래(≤2px, 1초 뒤에도) · 남의 말은 제자리(±8px)·필 1 · 스레드 답글 맨 아래 · 47/50분 머리 둘 · 같은 분 머리 하나`);
}

await main();
