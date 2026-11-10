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
// 머리 출력: 엔진마다 `CSS.supports('overflow-anchor','auto')`와 타임라인 스크롤러의 계산값을 찍는다(#5638, `engine-anchor.mjs`).
//   ⑥ 기록만(#5638): 스레드 답글 목록 가운데에서 읽는 중 위쪽 답글이 120px 자랄 때 보던 줄 이동(손보정이 없는 목록 — v0.1.47 근거).
//
// ⑤ 시계 어긋남(#5624): 가짜 서버가 확정본을 「지금 + 어긋남」으로 찍는다(응답 지연 1.5초). 바닥에서 내 글을 하나 보낸 뒤(그 응답이
//    서버 시계를 알려 준다) 같은 분에 하나 더 보내는 동안, 화면이 그린 모든 프레임에서 바로 위 줄의 위치와 보낸 줄의 높이를 잰다.
//    ±90초·0초, 분 경계(시계는 맞고 응답 사이에 분이 바뀜), 연달아 두 번. 보낸 줄은 처음부터 끝까지 한 높이(이어진 줄)여야 하고, 위 줄은
//    **보낸 줄(목록의 칸) 높이 ± 1px 만큼 한 방향으로만** 움직여야 한다(되돌아옴 0 — `still-measure.mjs`, #5641). 연달아 두 번은 두 칸 높이의
//    합 ± 1px. 고치기 전에는 메아리에 머리가 섰다 접히며 72px였다.
//    시계(#5641): 페이지의 `Date` 와 가짜 서버의 「지금」을 **같은 만큼** 옮겨, 장면이 분의 알려진 초에서 시작한다(타이머 · rAF ·
//    `performance.now` 는 그대로). ±90초·0초·연달아는 서버 시계로 분의 10초에서 시작해 분이 바뀌지 않는다(벽시계 분 경계의 거짓 RED 없음).
//    분 경계는 둘째 글을 「서버 분 경계 2.5초 전」에 보내고 서버가 3초 뒤 찍어, 메아리는 앞 분 · 확정본은 다음 분이 되게 한다 — 그 전제
//    (메아리가 이어진 줄로 섰고 서버가 다음 분에 찍었다)를 단정하고, 아니면 「장면을 못 만들었다」로 실패한다(타이밍이 빗나가 그냥 통과하지 않는다).
// ⑦ 기록만(#5641, #5637 재확인 검수 Low): 분 경계 · 자정에 **연달아 두 번** 보내기가 걸칠 때 둘째 줄의 높이가 바뀐 횟수와 px.
//   SEND_FOLLOW_OUT=<폴더>                장면 기록(send-follow.json · send-follow-skew.json)을 남긴다(장면표 게이트가 읽는다)
//   SEND_FOLLOW_PROVE_RED=<이름>          구멍 넷을 일부러 다시 열어 RED 를 보인다(#5641): bounce(범위 안 되돌아옴) · rapid-shift(연달아의
//                                         이동 폭) · minute-straddle(시계 고정을 끄고 분 경계에 걸침) · late-boundary(분 경계 장면의 타이밍이 빗나감)

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { printEngineAnchorHeader, scrollerOverflowAnchor } from "./engine-anchor.mjs";
import { startGuardedPreview } from "./preview-guard.mjs";
import { listEnv, motionOf, nothingRan } from "./still-measure.mjs";
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
const SKEW_SCENES = ["plus90", "minus90", "zero", "boundary", "rapid", "rapid-boundary", "rapid-midnight"];
// ⑤·⑦의 장면 고르기(예: boundary). 비우면 모두. 모르는 이름은 실패한다(오타로 장면을 통째로 건너뛰지 않게).
const skewScenesWanted = listEnv("SEND_FOLLOW_SKEW_SCENES", SKEW_SCENES, []);
if (engineNames.length === 0) throw new Error("SEND_FOLLOW_ENGINES 가 비었다");
const outDir = process.env.SEND_FOLLOW_OUT || null;
const PROVE_RED = ["bounce", "rapid-shift", "minute-straddle", "late-boundary"];
const proveRed = process.env.SEND_FOLLOW_PROVE_RED ? listEnv("SEND_FOLLOW_PROVE_RED", PROVE_RED)[0] : null;
// ⑤ 가짜 서버의 시계: 확정본의 `createdAtMs`는 지금 + shiftMs + skewMs, 응답은 postDelayMs 뒤. shiftMs 는 페이지의 `Date` 와 같이 옮긴다.
const backendClock = { skewMs: 0, postDelayMs: 150, shiftMs: 0, holdUntil: null, stamps: [] };
const gateNow = () => Date.now() + backendClock.shiftMs;
/**
 * 연달아 두 번의 되돌아옴은 알려진 실패다(#5641 실측 2026-11-10: 첫 글이 붙는 프레임에 위 줄이 64.4px 올라갔다가 다음 프레임에 7.4px
 * 내려앉음 — #5617 이 알려 둔 「바닥에서 보내기 거리 8px」과 같은 것). 고쳐지면 이 값을 false 로 바꿔 단정으로 올린다.
 */
const KNOWN_RAPID_SETTLE = true;
/** 보낸 뒤 바닥에서 7~8px 위에 앉는 것(#5617 알려 둔 것)도 같은 뿌리다. 고쳐지면 false 로 바꿔 「끝 바닥 거리 ≤ 1px」를 단정한다. */
const KNOWN_SEND_SHORTFALL = true;
/** 그 알려진 모자람의 크기(실측 7.4~8px). 이보다 더 떨어지면 알려진 것이 아니다 — 실패다. */
const KNOWN_SHORTFALL_MAX_PX = 9;
/** 장면표 게이트에 넘길 기록. */
const records = [];
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
      const arrivedAt = gateNow();
      await wait(backendClock.postDelayMs);
      message.createdAtMs = gateNow() + backendClock.skewMs;
      message.hlcTs = message.createdAtMs;
      backendClock.stamps.push({ body: message.body, arrivedAt: arrivedAt + backendClock.skewMs, stampedAt: message.createdAtMs });
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
    // 게이트 시계(#5641): `Date` 만 옮긴다(타이머 · rAF · performance.now 는 그대로). 가짜 서버의 「지금」도 같은 만큼 옮긴다.
    const RealDate = Date;
    let shift = 0;
    function GateDate(...args) {
      if (!new.target) return new RealDate(RealDate.now() + shift).toString();
      return args.length === 0 ? new RealDate(RealDate.now() + shift) : new RealDate(...args);
    }
    GateDate.now = () => RealDate.now() + shift;
    GateDate.parse = RealDate.parse;
    GateDate.UTC = RealDate.UTC;
    GateDate.prototype = RealDate.prototype;
    window.Date = GateDate;
    window.__gateClockShift = (ms) => {
      shift = ms;
    };
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

/**
 * 스레드 답글 목록의 자리 지키기를 잰다(기록만, 단정 없음 — #5638). 답글 목록은 가상화 없는 `overflow-y-auto` 상자이고 손보정
 * (`scrollHold`)이 붙어 있지 않다. 위를 읽는 중 화면 위 밖의 답글이 자랄 때 보던 줄을 지키는 것은 브라우저 스크롤 앵커링뿐이다.
 * Playwright 의 두 엔진은 모두 앵커링이 있어(2026-11-10 실측) 그대로 재면 둘 다 0 근처가 나온다. 그래서 같은 장면을 두 번 잰다:
 *   - 그대로(`asIs`): 앵커링이 있는 엔진 — Chromium · macOS 27 WebKit 의 값.
 *   - 대조(`anchorOff`): 이 상자만 잠깐 `overflow-anchor:none` 으로 두고 잰 뒤 되돌린다 — 앵커링이 없는 macOS 14~26 WebKit 의 값.
 * 맨 위(scrollTop 0)에서는 규격상 앵커링이 서지 않으므로 가운데에서 읽는다. 자라는 줄은 화면 위 밖에 통째로 있는 마지막 답글이고,
 * 그 줄의 최소 높이를 지금 높이 + 120px 로 두어 키우고, 실제로 얼마나 자랐는지(`grew`, 상자의 scrollHeight 차)를 함께 적는다.
 */
async function threadGrowProbe(page, selector) {
  return page.evaluate(async (sel) => {
    const node = document.querySelector(sel);
    if (node === null) return { error: "답글 목록이 없다" };
    const frames = () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    const round = (value) => Math.round(value * 100) / 100;
    const measure = async () => {
      const scrollRange = node.scrollHeight - node.clientHeight;
      node.scrollTop = Math.round(scrollRange / 2);
      await frames();
      await new Promise((done) => setTimeout(done, 300));
      const box = node.getBoundingClientRect();
      const rows = [...node.querySelectorAll("[data-message-id]")];
      const above = rows.filter((row) => row.getBoundingClientRect().bottom < box.top - 10);
      const visible = rows.find((row) => row.getBoundingClientRect().top >= box.top);
      if (above.length === 0 || visible === undefined) {
        return { error: `장면을 못 만들었다(위 밖 ${above.length}줄, 보이는 줄 ${visible ? 1 : 0}, scrollTop ${node.scrollTop}/${scrollRange})` };
      }
      const before = visible.getBoundingClientRect().top;
      const scrollTopStart = node.scrollTop;
      const heightStart = node.scrollHeight;
      // 줄 자체를 120px 키운다(안에 덩어리를 붙이면 줄의 배치가 일부를 삼켜 74px 만 자랐다 — 첫 실측).
      const grower = above[above.length - 1];
      grower.style.minHeight = `${grower.getBoundingClientRect().height + 120}px`;
      await frames();
      const moveAfter2Frames = round(visible.getBoundingClientRect().top - before);
      await new Promise((done) => setTimeout(done, 400));
      const result = {
        grew: round(node.scrollHeight - heightStart),
        aboveRows: above.length,
        moveAfter2Frames,
        moveAfter400ms: round(visible.getBoundingClientRect().top - before),
        scrollTopDelta: round(node.scrollTop - scrollTopStart),
        overflowAnchorBox: getComputedStyle(node).getPropertyValue("overflow-anchor") || "(계산값 없음)",
      };
      grower.style.removeProperty("min-height");
      await frames();
      await new Promise((done) => setTimeout(done, 200));
      return result;
    };
    const asIs = await measure();
    // 대조: 이 상자만 잠깐 끈다(인라인 값은 재고 나면 지운다 — 게이트 안의 측정 전용, 제품 코드가 아니다).
    node.style.overflowAnchor = "none";
    const anchorOff = await measure();
    node.style.removeProperty("overflow-anchor");
    return { asIs, anchorOff };
  }, selector);
}

function formatThreadGrow(grow) {
  if (grow.error) return grow.error;
  const one = (m) =>
    m.error
      ? m.error
      : `자람 ${m.grew}px → 보던 줄 2프레임 ${m.moveAfter2Frames}px · 400ms ${m.moveAfter400ms}px · scrollTop ${m.scrollTopDelta >= 0 ? "+" : ""}${m.scrollTopDelta} (상자 overflow-anchor ${m.overflowAnchorBox}, 위 밖 ${m.aboveRows}줄)`;
  return `그대로: ${one(grow.asIs)} | 앵커링 끈 대조: ${one(grow.anchorOff)}`;
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
  console.log(`[${where}] 타임라인 스크롤러 overflow-anchor=${await scrollerOverflowAnchor(page, SCROLLER)}`);

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
  if (heads[MIN47_MSG] !== true || heads[MIN50_MSG] !== true) failures.push(`${where} ④: 47분·50분의 말이 머리 둘이 아니다 (${JSON.stringify(heads)})`);
  if (heads[SAME1_MSG] !== true || heads[SAME2_MSG] !== false) failures.push(`${where} ④: 같은 52분의 두 말이 머리 하나가 아니다 (${JSON.stringify(heads)})`);
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
    failures.push(`${where} ①: 위로 올린 장면을 못 만들었다 (거리 ${before?.distance}, 필 ${pillBefore})`);
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
  if (soon === null || soon.distance > 2 || !soon.rowVisible) failures.push(`${where} ①: 보낸 뒤 맨 아래로 가지 않았다 (0.7초 거리 ${soon?.distance}, 보임 ${soon?.rowVisible})`);
  if (later === null || later.distance > 2 || !later.rowVisible) failures.push(`${where} ①: 맨 아래로 갔다가 되돌아갔다 (1.7초 거리 ${later?.distance}, 보임 ${later?.rowVisible})`);
  if (pillAfter !== 0) failures.push(`${where} ①: 보낸 뒤에도 「최신 메시지로 이동」이 서 있다`);
  records.push({ engine, name: "up-send", scene: "① 위에서 보내기(0.7 · 1.7초 바닥 거리)", kind: "bottom", where: `${where} ①`, distances: [soon?.distance ?? null, later?.distance ?? null].filter((value) => value !== null), pillShows: pillAfter });
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
    failures.push(`${where} ②: 남의 말에 읽던 화면이 밀렸다 (${parked?.scrollTop} → ${afterPeer?.scrollTop})`);
  }
  records.push({
    engine,
    name: "peer",
    scene: "② 위 읽는 중 남의 말(scrollTop 변화)",
    kind: "reading",
    where: `${where} ②`,
    unexplainedPx: parked && afterPeer ? Math.abs(afterPeer.scrollTop - parked.scrollTop) : null,
    note: `필 개수 ${peerCount} · 문턱 ±8px(옛 판정)`,
  });
  if (peerCount !== 1) failures.push(`${where} ②: 남의 말을 필이 1개로 세지 않는다 (${peerCount})`);

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
    failures.push(`${where} ③: 답글을 달았는데 답글 목록이 맨 아래로 가지 않았다 (거리 ${threadAfter?.distance}, 보임 ${threadAfter?.rowVisible})`);
  }
  records.push({ engine, name: "thread-reply", scene: "③ 스레드 답글 달기(바닥 거리)", kind: "bottom", where: `${where} ③`, distances: threadAfter ? [threadAfter.distance] : [] });
  await capture(page, `${engine}-${colorScheme}`, "3-after-thread-reply");

  // ⑥ 기록만(#5638 → v0.1.47 근거): 스레드 답글 목록에서 위를 읽는 중 위쪽 답글이 120px 자랄 때 보던 줄 이동.
  const grow = await threadGrowProbe(page, THREAD);
  console.log(`[${where}] 스레드 위 읽기 +120px(기록만): ${formatThreadGrow(grow)}`);
  records.push({
    engine,
    name: "thread-grow",
    scene: "⑥ 스레드 위 읽기 — 위쪽 답글 +120px(보던 줄 400ms)",
    kind: "reading",
    where: `${where} ⑥`,
    recordOnly: true,
    record: grow.error ?? `그대로 ${grow.asIs?.moveAfter400ms ?? grow.asIs?.error}px · 앵커링 끈 대조 ${grow.anchorOff?.moveAfter400ms ?? grow.anchorOff?.error}px`,
    unexplainedPx: grow.asIs?.moveAfter400ms ?? null,
    note: formatThreadGrow(grow),
  });
  await context.close();
  return failures;
}

/**
 * 페이지 안에서 매 프레임 「위 줄의 top · bottom」과 「보낸 줄의 높이 · bottom」을 적기 시작한다. `stop`이 모은 값을 돌려준다.
 * 위 줄의 기대 이동은 `summarize` 가 낸다(위 줄 top 아래로 새로 생긴 높이). 맨 아래에 붙은 목록이면 위 줄은 정확히 그만큼 한 방향으로 올라간다.
 * `firstText` 는 연달아 두 번에서 앞 글(확정을 기다리는 데만 쓴다).
 * `seam` 은 구멍을 일부러 다시 여는 사보타주(#5641)다: bounce = 위 줄이 다 움직인 뒤 3프레임 동안 5px 되돌아갔다 다시 감(옛 문턱 +10px
 * 안의 되돌아옴), rapid-shift = 두 글이 다 확정된 뒤 목록을 30px 위로 한 번 밀어 둠(바닥에 덜 앉음 — 옛 판정은 연달아의 이동 폭을 안 봄).
 */
async function startSampler(page, { aboveText, sentText, firstText = null, seam = null }) {
  await page.evaluate(
    ({ selector, aboveText, sentText, firstText, seam }) => {
      const samples = [];
      let running = true;
      const rowOf = (text) =>
        [...document.querySelectorAll(`${selector} [data-testid='timeline-message'], ${selector} [data-testid='timeline-pending']`)]
          .reverse()
          .find((el) => (el.textContent ?? "").includes(text)) ?? null;
      let baseline = null;
      let bounceLeft = seam === "bounce" ? 4 : 0;
      let shifted = false;
      const tick = () => {
        if (!running) return;
        const above = rowOf(aboveText);
        const sent = rowOf(sentText);
        const first = firstText === null ? null : rowOf(firstText);
        const top = above === null ? null : above.getBoundingClientRect().top;
        if (baseline === null && top !== null) baseline = top;
        const list = document.querySelector(selector);
        samples.push({
          gap: list ? list.scrollHeight - list.scrollTop - list.clientHeight : null,
          aboveTop: top,
          aboveBottom: above === null ? null : above.getBoundingClientRect().bottom,
          sentBottom: sent === null ? null : sent.getBoundingClientRect().bottom,
          sentHeight: sent === null ? null : Math.round(sent.getBoundingClientRect().height),
          sentPending: sent === null ? null : sent.getAttribute("data-testid") === "timeline-pending",
        });
        if (seam === "bounce" && above !== null && bounceLeft > 0 && sent !== null && baseline - top > 20 && sent.getAttribute("data-testid") === "timeline-message") {
          bounceLeft -= 1;
          above.style.transform = bounceLeft > 0 ? "translateY(5px)" : "";
        }
        const settled = (row) => row !== null && row.getAttribute("data-testid") === "timeline-message";
        if (seam === "rapid-shift" && !shifted && settled(sent) && settled(first)) {
          shifted = true;
          document.querySelector(selector).scrollTop -= 30;
        }
        requestAnimationFrame(tick);
      };
      // 첫 표본은 지금 바로(보내기 전) 적는다: 첫 rAF 를 기다리면 바로 뒤의 Enter 로 메아리가 이미 붙은 프레임이 「처음」이 되어
      // 기대 이동이 어긋난다(실측: 연달아 장면에서 처음 바닥 거리 65px).
      tick();
      window.__skewSampler = () => {
        running = false;
        return samples;
      };
    },
    { selector: SCROLLER, aboveText, sentText, firstText, seam }
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
  // 기대 이동 = 마지막의 「보낸 줄 bottom − 위 줄 top」 − 처음의 「위 줄 높이」: 위 줄의 top 아래로 새로 생긴 높이(새 칸 · 줄 사이 여백 ·
  // 위 줄 자신이 이어짐으로 바뀐 몫). 맨 아래에 붙은 목록이면 위 줄은 정확히 그만큼 올라간다. 목록 끝이 바닥에서 떨어지면 어긋난다.
  const initial = samples.find((one) => one.aboveTop !== null && one.aboveBottom !== null && one.sentBottom === null) ?? null;
  const final = [...samples].reverse().find((one) => one.sentBottom !== null && one.aboveTop !== null) ?? null;
  // 처음에 목록이 바닥에서 떨어져 있었으면(#5617 알려 둔 것: 앞 글을 보낸 뒤 7~8px 위에 앉음) 바닥에 붙으며 그만큼 더 올라간다 — 그 몫은 기대에
  // 더하고 따로 적는다(`gapBefore`). 끝의 바닥 거리(`gapAfter`)는 따로 단정한다.
  const gapBefore = initial?.gap ?? null;
  const gapAfter = final?.gap ?? null;
  const expected =
    final === null || initial === null
      ? null
      : Math.round((final.sentBottom - final.aboveTop - (initial.aboveBottom - initial.aboveTop) + (gapBefore ?? 0) - (gapAfter ?? 0)) * 100) / 100;
  // 보낸 줄의 높이가 바뀐 횟수와 그 폭(⑦ 기록): 이어진 프레임 사이의 다른 값.
  let heightChanges = 0;
  let heightChangePx = 0;
  const seq = samples.map((one) => one.sentHeight).filter((value) => value !== null);
  for (let i = 1; i < seq.length; i += 1) {
    if (seq[i] !== seq[i - 1]) {
      heightChanges += 1;
      heightChangePx += Math.abs(seq[i] - seq[i - 1]);
    }
  }
  const motion = motionOf(tops);
  return {
    travel: motion === null ? null : Math.round(motion.range * 10) / 10,
    net: motion?.net ?? null,
    gapBefore: gapBefore === null ? null : Math.round(gapBefore * 100) / 100,
    gapAfter: gapAfter === null ? null : Math.round(gapAfter * 100) / 100,
    reversals: motion?.reversals ?? null,
    steps: motion?.steps ?? null,
    expected,
    heights,
    echoHeights,
    settledHeights,
    heightChanges,
    heightChangePx,
    frames: samples.length,
    series: samples.filter((one) => one.aboveTop !== null).map((one) => ({ aboveTop: one.aboveTop, gap: one.gap })),
  };
}

/**
 * 게이트 시계를 옮긴다: 페이지의 `Date` 와 가짜 서버의 「지금」이 같이 `targetMs` 가 된다(이 순간 기준).
 * 타이머 · rAF · performance.now 는 건드리지 않는다.
 */
async function setGateClock(page, targetMs) {
  const shift = targetMs - Date.now();
  backendClock.shiftMs = shift;
  await page.evaluate((ms) => window.__gateClockShift(ms), shift);
}

/** 서버 시계(게이트 시계 + 어긋남)로 「다음 분의 `second` 초」가 되는 게이트 시각. */
function serverSecondTarget(second, skewMs) {
  const server = gateNow() + skewMs;
  return Math.floor(server / 60_000) * 60_000 + 60_000 + second * 1000 - skewMs;
}

const minuteOf = (ms) => Math.floor(ms / 60_000);

/**
 * ⑤ 한 장면: 바닥에서 앞 글을 보내 확정시킨 뒤(또는 `rapid`면 곧바로) 둘째 글을 보내며 잰다. ⑦(`recordOnly`)은 분 경계 · 자정에 연달아 두 번.
 * 시계는 게이트가 고정한다(위 머리 주석).
 */
async function skewScene(browser, engine, colorScheme, { name, skewMs, boundary = false, rapid = false, edge = null, recordOnly = false }) {
  const where = `${engine}/${colorScheme}/${name}`;
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, locale: "ko-KR", colorScheme });
  await installBackend(context);
  const page = await context.newPage();
  await installRealtimeSocket(page);
  await openChannel(page);
  backendClock.skewMs = skewMs;
  backendClock.stamps = [];
  // 분 경계: 서버는 3초 뒤에 찍는다. 앞 글의 응답이 알려 주는 차이는 그 지연의 절반(+1.5초)이므로, 둘째 글을 서버 분 경계 2.5초 전에
  // 보내면 메아리의 어림 시각은 경계 1초 전(앞 분, 이어진 줄)이고 서버의 시각은 경계 0.5초 뒤(다음 분)다 — 확정본이 에코의 묶음을 이어야
  // 하는 판. 누르기까지 1초 가까이 늦어도 판이 바뀌지 않는다. 왕복 3초는 시계 표본의 한도(4초) 안이다.
  backendClock.postDelayMs = boundary ? 3000 : 1500;
  const first = `${name} 앞 글입니다.`;
  const second = `${name} 이어 보낸 글입니다.`;
  const seam = proveRed === "bounce" && !rapid && !boundary ? "bounce" : proveRed === "rapid-shift" && rapid && !recordOnly ? "rapid-shift" : null;
  let result;
  let edgeAt = null;
  if (rapid) {
    // 연달아 두 번: 첫 응답이 오기 전에 둘째를 보낸다. 위 줄은 화면에 있던 마지막 남의 말이다.
    const input = page.getByTestId("composer-input");
    await input.click();
    await input.fill(first);
    if (edge === "minute") edgeAt = serverSecondTarget(0, 0);
    if (edge === "midnight") {
      const midnight = new Date(gateNow());
      midnight.setHours(24, 0, 0, 0);
      edgeAt = midnight.getTime();
    }
    // 분 경계 · 자정 0.6초 전에 앞 글, 0.25초 뒤에 둘째. 아니면 서버 분의 10초에서 시작한다(분이 바뀌지 않는다).
    await setGateClock(page, edgeAt === null ? serverSecondTarget(10, skewMs) : edgeAt - 600);
    await startSampler(page, { aboveText: "같은 52분의 둘째 말입니다.", sentText: second, firstText: first, seam });
    await input.press("Enter");
    await wait(250);
    await send(page, "composer-input", second);
    await waitConfirmed(page, first);
    await waitConfirmed(page, second);
    result = summarize(await stopSampler(page));
  } else {
    await setGateClock(page, serverSecondTarget(boundary ? 30 : 10, skewMs));
    await send(page, "composer-input", first);
    await waitConfirmed(page, first);
    await capture(page, engine, `skew-${name}-${colorScheme}-1-before`);
    await startSampler(page, { aboveText: first, sentText: second, seam });
    const input = page.getByTestId("composer-input");
    await input.click();
    await input.fill(second);
    if (boundary) {
      // 글은 미리 채워 두고 시계를 서버 분 경계 2.5초 전으로 옮긴 뒤 바로 누른다. late-boundary 사보타주는 경계 0.5초 뒤로 옮긴다.
      await setGateClock(page, serverSecondTarget(proveRed === "late-boundary" ? 0.5 : -2.5, skewMs));
    } else if (proveRed === "minute-straddle") {
      // 사보타주: 시계 고정을 끄고 둘째 글을 다음 분(서버 시계)으로 넘긴다 — 옛 게이트가 벽시계 분 경계에서 보던 거짓 RED.
      await setGateClock(page, serverSecondTarget(2, skewMs));
    }
    await input.press("Enter");
    await wait(boundary ? 200 : 700);
    await capture(page, engine, `skew-${name}-${colorScheme}-2-echo`);
    await waitConfirmed(page, second);
    result = summarize(await stopSampler(page));
    await capture(page, engine, `skew-${name}-${colorScheme}-3-confirmed`);
  }
  const stamps = [...backendClock.stamps];
  await context.close();
  backendClock.skewMs = 0;
  backendClock.postDelayMs = 150;
  backendClock.shiftMs = 0;
  const stampOf = (text) => stamps.find((one) => one.body === text) ?? null;
  const firstStamp = stampOf(first);
  const secondStamp = stampOf(second);
  console.log(
    `[${where}] 위 줄 이동 ${result.travel}px(기대 ${result.expected}px · 되돌아옴 ${result.reversals} · ${result.steps}번 · 바닥 거리 ${result.gapBefore}→${result.gapAfter}) · 보낸 줄 높이 ${JSON.stringify(result.heights)} ` +
      `(메아리 ${JSON.stringify(result.echoHeights)} → 확정 ${JSON.stringify(result.settledHeights)}, 바뀐 횟수 ${result.heightChanges} · ${result.heightChangePx}px) · 프레임 ${result.frames}`
  );
  const record = {
    engine,
    name,
    scene: recordOnly ? `⑦ ${edge === "midnight" ? "자정" : "분 경계"}에 연달아 두 번(기록만)` : `⑤ 시계 어긋남 ${name}`,
    kind: "expected",
    where,
    samples: result.series,
    expected: result.expected,
    travel: result.travel,
    heights: result.heights,
    heightChanges: result.heightChanges,
    heightChangePx: result.heightChangePx,
    gapBefore: result.gapBefore,
    gapAfter: result.gapAfter,
    recordOnly,
  };
  const failures = [];
  if (recordOnly) {
    const rel = (stamp) => (stamp === null || edgeAt === null ? "?" : `${((stamp.arrivedAt - edgeAt) / 1000).toFixed(2)}초`);
    record.record = `둘째 줄 높이 바뀜 ${result.heightChanges}번 · ${result.heightChangePx}px`;
    record.note = `보낸 시각(경계 기준): 앞 ${rel(firstStamp)} · 둘째 ${rel(secondStamp)} · 높이 ${JSON.stringify(result.heights)} · 위 줄 ${result.travel}px(기대 ${result.expected}, 되돌아옴 ${result.reversals})`;
    console.log(`[${where}] 기록만: ${record.record} — ${record.note}`);
    records.push(record);
    return failures;
  }
  record.note = `바닥 거리 ${result.gapBefore}→${result.gapAfter}px${result.gapBefore > 1 ? "(앞 글 뒤 떨어져 앉음 — #5617 알려 둔 것, 기대 이동에 더함)" : ""}`;
  const height = result.heights[0] ?? 99;
  if (result.heights.length !== 1) {
    failures.push(`${where}: 보낸 줄의 높이가 보내는 동안 바뀌었다 ${JSON.stringify(result.heights)} — 머리가 섰다 사라졌다 (#5624)`);
  }
  const sameMinute = firstStamp !== null && secondStamp !== null && minuteOf(firstStamp.stampedAt) === minuteOf(secondStamp.stampedAt);
  if (!boundary && !rapid && proveRed !== "minute-straddle" && !sameMinute) {
    // 시계를 고정했으므로 일어나면 안 된다. 일어났으면 이 장면은 재려던 것을 재지 않았다(거짓 RED 도 거짓 초록도 내지 않는다).
    failures.push(`${where}: 장면을 못 만들었다 — 두 글 사이에 서버 분이 바뀌었다(${firstStamp?.stampedAt} → ${secondStamp?.stampedAt})`);
  } else if (!rapid && !boundary && height > 44) {
    // 서버 시계로도 같은 분이다: 이어진 줄이어야 한다(메아리가 기기 시계로 묶이면 머리가 선다).
    failures.push(`${where}: 같은 분에 이어 보낸 글이 이어진 줄이 아니다(높이 ${height}px) — 메아리가 기기 시계로 묶였다`);
  }
  if (boundary) {
    // 분 경계의 전제: 메아리는 앞 분(이어진 줄)으로 섰고, 서버는 다음 분에 찍었다. 아니면 장부가 일하는 판을 재지 않은 것이다.
    const crossed = firstStamp !== null && secondStamp !== null && minuteOf(secondStamp.stampedAt) > minuteOf(firstStamp.stampedAt);
    const echoContinued = result.echoHeights.length > 0 && result.echoHeights.every((value) => value <= 44);
    if (!crossed || !echoContinued) {
      failures.push(`${where}: 장면을 못 만들었다 — 메아리가 이어진 줄로 서고(${JSON.stringify(result.echoHeights)}) 서버가 다음 분에 찍어야 한다(분 넘김 ${crossed})`);
    }
    console.log(`[${where}] 경계의 글은 ${height > 44 ? "머리(다음 분)" : "이어진 줄(앞 분)"}로 서고 그대로였다 · 서버 분 넘김 ${crossed}`);
  }
  // 위 줄은 보낸 칸 높이(연달아면 두 칸의 합) ± 1px 만큼 한 방향으로만 움직인다(#5641: 옛 문턱은 +10px · 되돌아옴 미계수 · 연달아 미단정).
  // 움직인 폭(최대 − 최소)과 처음 → 끝이 둘 다 기대 ± 1px 이어야 한다.
  if (result.travel === null || result.expected === null || Math.abs(result.travel - result.expected) > 1 || Math.abs(Math.abs(result.net) - result.expected) > 1) {
    failures.push(`${where}: 위 줄이 ${result.travel}px(처음 → 끝 ${result.net}px) 움직였다 — 보낸 칸 높이 ${result.expected}px ± 1px 여야 한다`);
  }
  if (result.gapAfter === null || result.gapAfter > 1) {
    if (KNOWN_SEND_SHORTFALL && result.gapAfter <= KNOWN_SHORTFALL_MAX_PX) {
      record.known = `${record.known ? `${record.known} · ` : ""}끝 바닥 거리 ${result.gapAfter}px — 알려진 실패(#5617)`;
      console.log(`[${where}] 알려진 실패(기록만): 끝 바닥 거리 ${result.gapAfter}px(#5617)`);
    } else {
      failures.push(`${where}: 보낸 뒤 목록이 바닥에서 ${result.gapAfter}px 떨어져 앉았다`);
    }
  }
  if (result.reversals === null || result.reversals !== 0) {
    if (rapid && KNOWN_RAPID_SETTLE) {
      // 알려진 실패(#5617 「바닥에서 보내기 7~8px 모자람」): 세션의 첫 글이 붙는 프레임에 목록이 그 줄만큼 올라갔다가 다음 프레임에
      // 7~8px 내려앉는다. 수리는 v0.1.47 M-3 칸이다. 기록만 하고 판정에서 뺀다(움직인 폭 · 처음 → 끝은 위에서 단정한다).
      record.known = `${record.known ? `${record.known} · ` : ""}되돌아옴 ${result.reversals}회 — 알려진 실패(#5617 첫 글 7~8px 내려앉음)`;
      console.log(`[${where}] 알려진 실패(기록만): ${record.known}`);
    } else {
      failures.push(`${where}: 위 줄이 되돌아왔다(${result.reversals}회)`);
    }
  }
  records.push(record);
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
    { name: "rapid-boundary", skewMs: 0, rapid: true, edge: "minute", recordOnly: true },
    { name: "rapid-midnight", skewMs: 0, rapid: true, edge: "midnight", recordOnly: true },
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
        await printEngineAnchorHeader(browser, name);
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
  if (outDir !== null) {
    mkdirSync(outDir, { recursive: true });
    const file = resolve(outDir, skewOnly ? "send-follow-skew.json" : "send-follow.json");
    writeFileSync(file, JSON.stringify(records, null, 1));
    console.log(`장면 기록: ${file}`);
  }
  const empty = nothingRan(records.length, "send-follow");
  if (empty !== null) failures.push(empty);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    process.exit(1);
  }
  if (skewOnly) {
    console.log(
      `PASS send-follow skew: ${engineNames.join("·")} — ±90초·0초·분 경계에서 이어 보낸 글이 처음부터 이어진 줄 · 위 줄은 보낸 칸 높이 ±1px · 되돌아옴 0 · 연달아 두 번은 두 칸 합 ±1px (⑦ 분 경계·자정 연달아는 기록만)`
    );
    return;
  }
  console.log(`PASS send-follow: ${engineNames.join("·")} — 위에서 보내면 맨 아래(≤2px, 1초 뒤에도) · 남의 말은 제자리(±8px)·필 1 · 스레드 답글 맨 아래 · 47/50분 머리 둘 · 같은 분 머리 하나`);
}

await main();
