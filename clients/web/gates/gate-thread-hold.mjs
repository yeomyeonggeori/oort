#!/usr/bin/env node
// GATE: #5649 — 보던 줄은 앱이 직접 지킨다(브라우저 스크롤 앵커링에 기대지 않기). 스레드 답글 목록 + 타임라인 「스크롤 중」.
//
// 실제 번들을 **WebKit** 과 Chromium 에서 잰다(1280×800). 두 목록 모두 스크롤 상자의 계산된 `overflow-anchor` 가 `none` 인 채로다 —
// 앵커링이 없는 엔진(문서상 macOS 14~26 의 시스템 WebKit)과 같은 조건이다. 손보정(`scrollHold`)이 빠지면 여기서 RED 다.
//
// 스레드 답글 목록(가상화 없는 스크롤 상자):
//   T0 상자의 계산된 overflow-anchor = none · 열면 맨 위(scrollTop 0 — 들어갈 때 바닥으로 끌려가지 않는다)
//   T1 위를 읽는 중 화면 위 밖 답글 +120px / −120px → 보던 답글 이동 ≤ 2px · 되돌아옴 0
//   T2 휠로 내리는 중(같은 휠 열을 자람 없이 한 번 · 자람과 함께 한 번) → 보던 답글의 이동 차 ≤ 2px · 거꾸로 간 프레임 0
//   T3 휠을 멈춘 지 60ms 뒤 자람 → ≤ 2px
//   T4 바닥: 마지막 답글이 120px 자람(늦게 뜨는 그림) · 남의 새 답글 → 그려진 모든 프레임에서 바닥 거리 ≤ 1px
//   T5 창 높이 800 → 640 → 800: 위 읽기 ≤ 2px · 바닥 ≤ 1px
//   T6 움직임 줄이기 설정에서 T1
//   T7 한 화면에 다 들어오는 짧은 스레드: 답글이 자라 넘쳐도 맨 위 그대로(맨 위에 선 채로는 「바닥」이 아니다)
//   T8 스레드 A 를 10~45px 내려 둔 채(창 높이 640, 루트가 상자보다 긴 아직 안 받은 스레드 B 로) 바꿔 열기 → B 는 맨 위(scrollTop ≤ 1) (검수 H2)
// 타임라인(가상 목록):
//   L1 가만히 위 읽기 +120px (대조 — 이 칸 전부터 지키던 장면)
//   L2 휠로 **내리는 중** 위 밖 줄 ±120px → 이동 차 ≤ 2px · 거꾸로 간 프레임 0
//   L3 내리다 멈춘 지 60ms 뒤 ±120px → ≤ 2px
//   L4 올리는 중 · 올리다 멈춘 직후 +120px — **기록만**(가상 목록의 위쪽 보정 몫, 이 칸이 바꾸지 않는 길)
//   L5 휠로 한 번 내린 뒤 30 · 80 · 160ms 에 「최신 메시지로 이동」 → 끝 바닥 거리 ≤ 9px(휠 없이 누른 값 7px 이 상한 근거 — 검수 1·2회차)
//   L6 휠 뒤 30 · 80 · 160ms 에 키보드 End(바닥 ≤ 9px) · PageDown(≥ 450px) — 줄에 초점을 둔 채(검수 2회차 H1)
//   L7 누른 뒤에도 휠이 이어진다(20ms 간격 6px 세 번) → 바닥 ≤ 9px (검수 2회차 H1 · 3회차 H1 — 이동 중 ⋯ 단추로 넘어가는 초점이
//      부드러운 스크롤을 끊으면 조용해진 뒤 바닥으로 마무리)
//   L6b 휠 뒤 80ms 에 키보드 PageDown, 그 스크롤 도중 화면 위 밖 줄이 120px 자랐다 되돌아감 → 움직인 거리 ≥ 450px(검수 3회차 M1 —
//      키보드 스크롤을 사람의 손으로 치면 그 줄 높이 변화에서 자리를 붙들어 스크롤을 끊는다. 줄 높이가 안 바뀌면 그 길을 안 타서 L6 은 못 잡는다)
//
// 재는 법: 프레임마다 그려진 모양(rAF 뒤의 태스크에서 읽고, 그 사이 DOM 이 바뀐 표본은 버린다 — #5641 `still-measure` 와 같은 규칙)의
// 보던 줄 위 끝(창 좌표) · scrollTop · 바닥 거리를 적는다. 휠 장면은 A/B 다: 같은 휠 열을 자람 없이 돌린 값이 기준이라 엔진이 휠을
// 어떻게 옮기든(바로 · 부드럽게) 견줄 수 있다. 트랙패드 관성(OS 가 만드는 모멘텀 휠)은 자동으로 못 만든다 — runtime-unverified.
// 이 파일의 재는 코드는 #5641(장면표 게이트)이 착륙하면 그 공용 모듈(`still-measure` · `timeline-fake-backend`)로 옮긴다.
//
// 사용: npm run build && node gates/gate-thread-hold.mjs
//   THREAD_HOLD_ENGINES=webkit,chromium   (기본 둘 다)
//   THREAD_HOLD_PORT=<포트>               미리보기 포트(기본 5271)
//   THREAD_HOLD_DIST=<폴더>               dist 대신 이 번들(수리 전 · 사보타주 번들로 RED 를 보일 때)
//   THREAD_HOLD_SETS=thread,timeline      장면 묶음(기본 둘 다)
//   THREAD_HOLD_FORCE_NONE=1              스레드 상자에 인라인 `overflow-anchor:none` 을 건다 — **수리 전 번들의 대조 측정 전용**
//                                         (그 번들은 상자가 auto 라 브라우저 앵커링이 대신 지킨다). T0 는 그대로 계산값을 단정한다.
//   THREAD_HOLD_OUT=<파일>                표를 JSON 으로도 남긴다

import { writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { startGuardedPreview } from "./preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.THREAD_HOLD_PORT || 5271);
const origin = `http://127.0.0.1:${port}`;
const distOverride = process.env.THREAD_HOLD_DIST || null;
const forceNone = process.env.THREAD_HOLD_FORCE_NONE === "1";
const outFile = process.env.THREAD_HOLD_OUT || null;
const viewport = { width: 1280, height: 800 };

/** 쉼표 목록 환경 값. 모르는 이름이 하나라도 있으면 던진다(오타가 장면을 통째로 건너뛰고 PASS 하지 않게). */
function listEnv(name, allowed) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return [...allowed];
  const names = raw.split(",").map((part) => part.trim()).filter(Boolean);
  const unknown = names.filter((part) => !allowed.includes(part));
  if (names.length === 0 || unknown.length > 0) throw new Error(`${name}=${JSON.stringify(raw)}: ${allowed.join(" · ")} 가운데서 고른다`);
  return names;
}
const engineNames = listEnv("THREAD_HOLD_ENGINES", ["webkit", "chromium"]);
const sets = listEnv("THREAD_HOLD_SETS", ["thread", "timeline"]);

/** 문턱(px): 위 읽기 · 스크롤 중 ≤ 2, 바닥 ≤ 1, 되돌아옴은 1px 넘게 반대로 간 횟수(#5641 장면표와 같은 정의). */
const LIMIT = Object.freeze({ readingPx: 2, bottomPx: 1, reversalFloorPx: 1 });
const GROW_PX = 120;
const WHEEL = Object.freeze({ steps: 8, dy: 30, gapMs: 40, growAtStep: 4 });

const workspaceId = "00000000-0000-7000-8000-000000000001";
const meId = "00000000-0000-7000-8000-000000000131";
const peerId = "00000000-0000-7000-8000-000000000132";
const channelId = "00000000-0000-7000-8000-000000000231";
const ROOT_MSG = "0199ffff-0000-7000-8000-000000000a20";
/** 답글 둘뿐인 짧은 스레드의 루트(T7). */
const SHORT_ROOT_MSG = "0199ffff-0000-7000-8000-000000000a22";
/** 루트가 답글 상자보다 긴 스레드의 루트(T8). 답글 30개, 답글 응답은 500ms 늦다(뼈대가 서는 순간을 만든다). */
const LONG_ROOT_MSG = "0199ffff-0000-7000-8000-000000000a24";
const LONG_BODY = Array.from({ length: 5 }, (_, i) => `${i + 1}번째 문단: 릴리스 노트에 넣을 변경을 한 줄씩 적어 두었어요. 읽고 빠진 것이 있으면 이어서 적어 주세요.`).join("\n\n");

const session = {
  accessToken: "gate-only-not-a-credential",
  refreshToken: "gate-only-not-a-credential",
  member: { id: meId, workspaceId, kind: "human", displayName: "한울", handle: "haneul" },
  realtimeWebSocketUrl: "ws://thread-hold.invalid/connection/websocket",
};

function member(over) {
  return { workspaceId, status: "active", role: "member", channelCount: 1, channelIds: [channelId], capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...over };
}
const roster = [
  member({ id: meId, kind: "human", role: "owner", displayName: "한울", handle: "haneul" }),
  member({ id: peerId, kind: "human", displayName: "다온", handle: "daon" }),
];
const channels = [{ id: channelId, workspaceId, kind: "public", name: "release-notes", muted: false }];

function todayAt(hour, minute) {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}
function row(over) {
  return { channelId, hlcCount: 0, type: "text", state: "sent", ...over, hlcTs: over.hlcTs ?? over.createdAtMs };
}
/** 두 사람이 2분마다 번갈아 한 말 60줄. 가운데 둘이 스레드 루트다: 답글 30개짜리와 답글 2개짜리. */
function history() {
  const rows = [];
  for (let i = 0; i < 60; i += 1) {
    const at = todayAt(9, 0) + i * 120_000;
    const isRoot = i === 30;
    const isShortRoot = i === 32;
    const isLongRoot = i === 34;
    rows.push(
      row({
        id: isRoot ? ROOT_MSG : isShortRoot ? SHORT_ROOT_MSG : isLongRoot ? LONG_ROOT_MSG : `0199ffff-0000-7000-8000-${String(0xa00 + i).padStart(12, "0")}`,
        seq: 100 + i,
        authorMemberId: i % 2 === 0 ? peerId : meId,
        body: isRoot ? "릴리스 노트 초안은 이 스레드에서 이어 갈게요." : isShortRoot ? "짧은 확인은 이 스레드에서 할게요." : isLongRoot ? LONG_BODY : `${i + 1}번째 이야기입니다. 오늘 일정과 남은 일을 정리했어요.`,
        createdAtMs: at,
        ...(isRoot ? { thread: { reply_count: 30, last_reply_seq: 1029, last_reply_at: at + 30 * 60_000 } } : {}),
        ...(isShortRoot ? { thread: { reply_count: 2, last_reply_seq: 1101, last_reply_at: at + 10 * 60_000 } } : {}),
        ...(isLongRoot ? { thread: { reply_count: 30, last_reply_seq: 1229, last_reply_at: at + 30 * 60_000 } } : {}),
      })
    );
  }
  return rows;
}
function replies(rootId = ROOT_MSG, count = 30, firstSeq = 1000, idBase = 0xc00) {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    rows.push(
      row({
        id: `0199ffff-0000-7000-8000-${String(idBase + i).padStart(12, "0")}`,
        seq: firstSeq + i,
        rootId,
        authorMemberId: i % 2 === 0 ? peerId : meId,
        body: `답글 ${i + 1}: 항목을 하나씩 확인하고 있어요.`,
        createdAtMs: todayAt(11, 0) + i * 120_000,
      })
    );
  }
  return rows;
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const round2 = (value) => Math.round(value * 100) / 100;
const load1 = () => round2(loadavg()[0]);

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function installBackend(context) {
  const state = { messages: history(), replies: replies(), shortReplies: replies(SHORT_ROOT_MSG, 2, 1100, 0xd00), longReplies: replies(LONG_ROOT_MSG, 30, 1200, 0xf00) };
  await context.route("**/healthz", (route) => json(route, { status: "ok" }));
  await context.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === "/v1/auth/login") return json(route, session);
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "gate-only-not-a-credential", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 600, workspaceId, memberId: meId });
    }
    if (path === "/v1/auth/refresh") return json(route, { accessToken: session.accessToken, refreshToken: session.refreshToken });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/reactions")) return json(route, { reactions: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-sessions")) return json(route, { sessions: [] });
    if (/\/expressions$/.test(path)) return json(route, { workspaceId, version: "1", baseVersion: null, reset: true, addPolicy: "members", items: [] });
    if (path.endsWith("/replies")) {
      const lower = path.toLowerCase();
      if (lower.includes(LONG_ROOT_MSG)) {
        await wait(500);
        return json(route, { messages: state.longReplies, following: true });
      }
      return json(route, { messages: lower.includes(SHORT_ROOT_MSG) ? state.shortReplies : state.replies, following: true });
    }
    if (path.includes("/messages")) {
      if (url.searchParams.has("after") || url.searchParams.has("before")) return json(route, { messages: [] });
      return json(route, { messages: state.messages });
    }
    return json(route, {});
  });
  // 가짜 실시간(센트리퓨고 JSON 프로토콜의 최소판). 공용 가짜 서버(`timeline-fake-backend`)와 같은 `routeWebSocket` 이다: 앱이 소켓 객체를 직접
  // 건드려도(다시 붙기 · 조용히 죽은 소켓 판정) 진짜 소켓처럼 구는 쪽이 낫다.
  const sockets = new Set();
  let offset = 0;
  await context.routeWebSocket(/\/connection\/websocket/, (ws) => {
    const entry = { ws, channels: new Set() };
    sockets.add(entry);
    ws.onClose(() => sockets.delete(entry));
    ws.onMessage((raw) => {
      for (const line of String(raw).split("\n")) {
        if (!line.trim()) continue;
        const command = JSON.parse(line);
        if (command.connect) ws.send(JSON.stringify({ id: command.id, connect: { client: "thread-hold", version: "6.0.0" } }));
        else if (command.subscribe) {
          entry.channels.add(command.subscribe.channel);
          ws.send(JSON.stringify({ id: command.id, subscribe: { recoverable: true, positioned: true, epoch: "thread-hold", offset, recovered: false, publications: [] } }));
        } else if (command.unsubscribe) {
          entry.channels.delete(command.unsubscribe.channel);
          ws.send(JSON.stringify({ id: command.id, unsubscribe: {} }));
        } else if (command.id !== undefined) {
          const key = Object.keys(command).find((name) => name !== "id") ?? "ping";
          ws.send(JSON.stringify({ id: command.id, [key]: {} }));
        }
      }
    });
  });
  state.subscribed = () => [...sockets].some((entry) => [...entry.channels].some((name) => name.startsWith("ch:")));
  state.publish = (frame) => {
    offset += 1;
    const stamped = { ...frame, ts: Date.now() };
    for (const entry of sockets) {
      for (const name of entry.channels) {
        if (name.startsWith("ch:")) entry.ws.send(JSON.stringify({ push: { channel: name, pub: { data: stamped, offset } } }));
      }
    }
  };
  return state;
}

/** 페이지 안의 재는 도구(가짜 실시간은 `installBackend` 의 `routeWebSocket` 이 맡는다). */
async function installPage(page) {
  await page.addInitScript(() => {
    // ---- 재는 도구 ----
    const round = (value) => Math.round(value * 100) / 100;
    const H = (window.__hold = { gen: 0, frames: [], marks: [] });
    /** 보던 줄(창 위 끝에서 `watchOffset` 아래의 첫 줄)과 키울 줄(화면 위 밖에 통째로 있는 마지막 줄)을 고른다. */
    H.pick = (selector, rowSelector, watchOffset) => {
      const node = document.querySelector(selector);
      if (node === null) return { error: "목록이 없다" };
      const box = node.getBoundingClientRect();
      const rows = [...node.querySelectorAll(rowSelector)];
      const above = rows.filter((el) => el.getBoundingClientRect().bottom < box.top - 10);
      const watch = rows.find((el) => el.getBoundingClientRect().top >= box.top + watchOffset) ?? null;
      H.node = node;
      H.watch = watch;
      H.grower = above[above.length - 1] ?? null;
      H.growerBase = H.grower?.getBoundingClientRect().height ?? 0;
      if (H.grower === null || watch === null || node.scrollTop < 1) {
        return { error: `장면을 못 만들었다(위 밖 ${above.length}줄 · 보던 줄 ${watch ? 1 : 0} · scrollTop ${node.scrollTop})` };
      }
      return { aboveRows: above.length, scrollTop: node.scrollTop };
    };
    /** 바닥 장면: 보던 줄 없이 목록만 잡는다. 키울 줄은 마지막 줄이다. */
    H.pickBottom = (selector, rowSelector) => {
      const node = document.querySelector(selector);
      if (node === null) return { error: "목록이 없다" };
      const rows = [...node.querySelectorAll(rowSelector)];
      H.node = node;
      H.watch = null;
      H.grower = rows[rows.length - 1] ?? null;
      H.growerBase = H.grower?.getBoundingClientRect().height ?? 0;
      return H.grower === null ? { error: "줄이 없다" } : { rows: rows.length };
    };
    H.mark = (name) => H.marks.push({ name, t: round(performance.now() - H.t0), frame: H.frames.length });
    H.grow = (px) => {
      H.grower.style.minHeight = `${H.growerBase + px}px`;
      H.mark(`grow${px}`);
    };
    H.ungrow = () => {
      H.grower.style.removeProperty("min-height");
      H.mark("ungrow");
    };
    /** `count` 번째 휠 이벤트 안에서 `action` 을 한다 — 그 휠의 스크롤과 같은 프레임에 줄이 자란다. */
    H.onWheel = (count, action) => {
      let seen = 0;
      const on = () => {
        seen += 1;
        if (seen !== count) return;
        H.node.removeEventListener("wheel", on);
        action();
      };
      H.node.addEventListener("wheel", on, { passive: true });
    };
    H.start = () => {
      H.gen += 1;
      const gen = H.gen;
      H.frames = [];
      H.marks = [];
      H.dropped = 0;
      H.t0 = performance.now();
      // 그려진 모양만 센다: 이 프레임의 rAF 뒤로 DOM 이 바뀌었으면 그 표본은 아직 그려지지 않은 중간 상태다(버린다).
      let dirty = false;
      const dirtyWatch = new MutationObserver(() => {
        dirty = true;
      });
      dirtyWatch.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
      const channel = new MessageChannel();
      const sample = () => {
        if (H.gen !== gen) return;
        if (dirty) {
          H.dropped += 1;
          return;
        }
        const node = H.node;
        H.frames.push({
          t: round(performance.now() - H.t0),
          top: round(node.scrollTop),
          gap: round(node.scrollHeight - node.scrollTop - node.clientHeight),
          height: node.scrollHeight,
          watch: H.watch !== null && H.watch.isConnected ? round(H.watch.getBoundingClientRect().top) : null,
        });
      };
      channel.port1.onmessage = sample;
      sample();
      const tick = () => {
        if (H.gen !== gen) {
          dirtyWatch.disconnect();
          return;
        }
        dirty = false;
        channel.port2.postMessage(0);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };
    H.stop = () => {
      H.gen += 1;
      return { frames: H.frames, marks: H.marks, dropped: H.dropped };
    };
  });
}

const TIMELINE = '[data-testid="timeline-virtuoso"]';
const THREAD = '[data-testid="thread-panel"] [data-message-scroll-container]';

async function openChannel(page, backend) {
  await page.goto(origin, { waitUntil: "networkidle" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("haneul@example.test");
  await page.getByTestId("login-password").fill("gate-only");
  await page.getByTestId("login-submit").click();
  await page.locator(`[data-testid="channel-item"][data-channel-id="${channelId}"]`).click();
  await page.getByTestId("composer-input").waitFor();
  for (const start = Date.now(); !backend.subscribed(); await wait(100)) {
    if (Date.now() - start > 15_000) throw new Error("채널 구독이 15초 안에 서지 않았다");
  }
  await page.waitForFunction(
    (selector) => {
      const node = document.querySelector(selector);
      return node !== null && node.scrollHeight > node.clientHeight + 1200;
    },
    TIMELINE,
    { timeout: 15_000 }
  );
  await wait(600);
}

/** 스레드를 연다. 연 뒤 **게이트가 스크롤을 건드리기 전의** scrollTop 을 돌려준다(T0: 열면 맨 위). */
async function openThread(page, rootId = ROOT_MSG, rowCount = 31) {
  await page.locator(TIMELINE).evaluate((node) => {
    node.scrollTop = Math.round((node.scrollHeight - node.clientHeight) * 0.5);
  });
  await wait(500);
  const rootRow = page.locator(`${TIMELINE} [data-testid="timeline-message"][data-message-id="${rootId}"]`);
  await rootRow.scrollIntoViewIfNeeded();
  await rootRow.hover();
  await rootRow.getByTestId("toolbar-reply").click();
  await page.getByTestId("thread-composer-input").waitFor({ state: "visible" });
  await page.waitForFunction(
    ([selector, root, count]) => {
      const node = document.querySelector(selector);
      const panel = document.querySelector('[data-testid="thread-panel"]');
      return node !== null && panel?.getAttribute("data-root-id") === root && node.querySelectorAll("[data-message-id]").length === count;
    },
    [THREAD, rootId, rowCount],
    { timeout: 15_000 }
  );
  await wait(700);
  if (forceNone) {
    await page.locator(THREAD).evaluate((node) => {
      node.style.overflowAnchor = "none";
    });
  }
  return page.locator(THREAD).evaluate((node) => ({
    scrollTop: node.scrollTop,
    overflowAnchor: getComputedStyle(node).getPropertyValue("overflow-anchor") || "(계산값 없음)",
  }));
}

/** 값 열의 움직임: 폭(최대−최소) · 처음→끝 · 되돌아옴(1px 넘게 반대로 간 횟수) · 프레임 사이 가장 큰 +/− 변화. */
function motionOf(series) {
  const values = series.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (values.length < 2) return null;
  let reversals = 0;
  let direction = 0;
  let pivot = values[0];
  let maxDown = 0;
  let maxUp = 0;
  for (let i = 1; i < values.length; i += 1) {
    const value = values[i];
    const step = value - values[i - 1];
    if (step > maxDown) maxDown = step;
    if (-step > maxUp) maxUp = -step;
    if (direction === 0) {
      if (Math.abs(value - pivot) > LIMIT.reversalFloorPx) {
        direction = value > pivot ? 1 : -1;
        pivot = value;
      }
    } else if (direction === 1) {
      if (value > pivot) pivot = value;
      else if (pivot - value > LIMIT.reversalFloorPx) {
        reversals += 1;
        direction = -1;
        pivot = value;
      }
    } else if (value < pivot) pivot = value;
    else if (value - pivot > LIMIT.reversalFloorPx) {
      reversals += 1;
      direction = 1;
      pivot = value;
    }
  }
  return {
    samples: values.length,
    range: round2(Math.max(...values) - Math.min(...values)),
    net: round2(values[values.length - 1] - values[0]),
    reversals,
    /** 프레임 사이 가장 큰 아래쪽(+) · 위쪽(−) 변화(px). */
    maxDown: round2(maxDown),
    maxUp: round2(maxUp),
  };
}

const record = (page) => page.evaluate(() => window.__hold.start());
const stop = (page) => page.evaluate(() => window.__hold.stop());

async function park(page, selector, fraction) {
  await page.locator(selector).evaluate((node, f) => {
    window.__hold.grower?.style.removeProperty("min-height");
    node.scrollTop = Math.round((node.scrollHeight - node.clientHeight) * f);
  }, fraction);
  // 사람의 스크롤이 「방금」이 아니게 넉넉히 기다린다(scrollHold 의 스크롤 중 창 150ms, 가상 목록의 방향 창 50ms).
  await wait(600);
}

/** 가만히 위 읽기: +120 → −120. */
async function readingScene(page, list, rows) {
  await park(page, list.selector, list.park);
  const picked = await page.evaluate(([s, r, o]) => window.__hold.pick(s, r, o), [list.selector, list.rowSelector, 0]);
  if (picked.error) return [{ scene: `${list.name} 위 읽기 +${GROW_PX}px`, verdict: "FAIL", note: picked.error }];
  const out = [];
  for (const step of [
    { name: `+${GROW_PX}px`, act: (px) => window.__hold.grow(px), want: GROW_PX },
    { name: `−${GROW_PX}px`, act: () => window.__hold.ungrow(), want: -GROW_PX },
  ]) {
    await record(page);
    await wait(150);
    const before = await page.evaluate(() => window.__hold.node.scrollHeight);
    await page.evaluate(step.act, GROW_PX);
    await wait(700);
    const { frames, dropped } = await stop(page);
    const grew = (frames[frames.length - 1]?.height ?? before) - before;
    const m = motionOf(frames.map((frame) => frame.watch));
    const built = Math.abs(grew - step.want) <= 1 && m !== null && m.samples >= 10;
    const ok = built && m.range <= LIMIT.readingPx && m.reversals === 0;
    out.push({
      scene: `${list.name} 위 읽기 ${step.name}`,
      verdict: ok ? "PASS" : "FAIL",
      movedPx: m?.range ?? null,
      reversals: m?.reversals ?? null,
      note: `${built ? "" : "장면을 못 만들었다 · "}목록 높이 ${grew >= 0 ? "+" : ""}${grew}px · 위 밖 ${picked.aboveRows}줄 · 프레임 ${m?.samples ?? 0}(버림 ${dropped})`,
    });
    rows.push(out[out.length - 1]);
  }
  return out;
}

/** 휠 한 번 돌리기. `inject` 가 있으면 `growAtStep` 번째 휠 안에서 줄을 키우거나 줄인다. */
async function wheelRun(page, list, { dy, inject, preGrown }) {
  await park(page, list.selector, list.park);
  const picked = await page.evaluate(([s, r, o]) => window.__hold.pick(s, r, o), [list.selector, list.rowSelector, dy > 0 ? 280 : 40]);
  if (picked.error) return { error: picked.error };
  if (preGrown) {
    // 줄이는 장면: 가만히 있을 때 먼저 키워 두고(그 보정은 L1/T1 이 잰다) 다시 자리를 잡는다.
    await page.evaluate((px) => window.__hold.grow(px), GROW_PX);
    await wait(600);
  }
  const box = await page.locator(list.selector).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await record(page);
  await wait(100);
  if (inject === "grow") await page.evaluate(([n, px]) => window.__hold.onWheel(n, () => window.__hold.grow(px)), [WHEEL.growAtStep, GROW_PX]);
  if (inject === "shrink") await page.evaluate((n) => window.__hold.onWheel(n, () => window.__hold.ungrow()), WHEEL.growAtStep);
  for (let i = 0; i < WHEEL.steps; i += 1) {
    await page.mouse.wheel(0, dy);
    await wait(WHEEL.gapMs);
  }
  await wait(600);
  const { frames, marks, dropped } = await stop(page);
  const m = motionOf(frames.map((frame) => frame.watch));
  return {
    m,
    marks,
    dropped,
    scrolled: frames.length > 0 ? round2(frames[frames.length - 1].top - frames[0].top) : 0,
    height: frames.length > 0 ? frames[frames.length - 1].height - frames[0].height : 0,
  };
}

/** 스크롤 중 A/B: 같은 휠 열을 자람 없이(A) · 자람과 함께(B). 보던 줄의 처음→끝 이동이 같아야 하고(≤2px) 거꾸로 간 프레임이 없어야 한다. */
async function scrollingScene(page, list, rows, { dy, change, recordOnly = false }) {
  const scene = `${list.name} 휠로 ${dy > 0 ? "내리는" : "올리는"} 중 ${change === "grow" ? "+" : "−"}${GROW_PX}px`;
  const base = await wheelRun(page, list, { dy, inject: null, preGrown: change === "shrink" });
  const withChange = await wheelRun(page, list, { dy, inject: change, preGrown: change === "shrink" });
  if (base.error || withChange.error || base.m === null || withChange.m === null) {
    const result = { scene, verdict: recordOnly ? "기록" : "FAIL", note: `장면을 못 만들었다: ${base.error ?? withChange.error ?? "프레임 없음"}` };
    rows.push(result);
    return result;
  }
  const want = change === "grow" ? GROW_PX : -GROW_PX;
  // 사람이 간 거리는 같다: 자람이 있는 쪽의 scrollTop 변화는 「기준 + 지킨 만큼」이다(지키지 않으면 기준 그대로).
  const diff = round2(Math.abs(withChange.m.net - base.m.net));
  // 거꾸로 간 프레임: 내리는 중이면 줄은 위로만 간다(아래로 간 프레임 변화가 기준보다 2px 넘게 크면 튄 것이다).
  const against = round2(dy > 0 ? withChange.m.maxDown - base.m.maxDown : withChange.m.maxUp - base.m.maxUp);
  const built = Math.abs(withChange.height - want) <= 1 && withChange.marks.length === 1 && Math.abs(base.scrolled) >= WHEEL.dy;
  const ok = built && diff <= LIMIT.readingPx && against <= LIMIT.readingPx && withChange.m.reversals === base.m.reversals;
  const result = {
    scene,
    verdict: recordOnly ? "기록" : ok ? "PASS" : "FAIL",
    movedPx: diff,
    reversals: withChange.m.reversals - base.m.reversals,
    note:
      `${built ? "" : "장면을 못 만들었다 · "}보던 줄 처음→끝 기준 ${base.m.net}px · 변화와 함께 ${withChange.m.net}px · 거꾸로 간 프레임 ${against}px · ` +
      `scrollTop 기준 ${base.scrolled >= 0 ? "+" : ""}${base.scrolled} · 변화와 함께 ${withChange.scrolled >= 0 ? "+" : ""}${withChange.scrolled} · 목록 높이 ${withChange.height >= 0 ? "+" : ""}${withChange.height}px`,
  };
  rows.push(result);
  return result;
}

/** 멈춘 직후: 휠 두 번 뒤 60ms 에 줄이 자라거나 준다. 그 순간부터 보던 줄 이동 ≤ 2px. */
async function justStoppedScene(page, list, rows, { dy, change, recordOnly = false }) {
  const scene = `${list.name} ${dy > 0 ? "내리다" : "올리다"} 멈춘 지 60ms 뒤 ${change === "grow" ? "+" : "−"}${GROW_PX}px`;
  await park(page, list.selector, list.park);
  const picked = await page.evaluate(([s, r, o]) => window.__hold.pick(s, r, o), [list.selector, list.rowSelector, 80]);
  if (picked.error) {
    rows.push({ scene, verdict: recordOnly ? "기록" : "FAIL", note: picked.error });
    return;
  }
  if (change === "shrink") {
    await page.evaluate((px) => window.__hold.grow(px), GROW_PX);
    await wait(600);
  }
  const box = await page.locator(list.selector).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await record(page);
  const topBefore = await page.evaluate(() => window.__hold.node.scrollTop);
  await page.mouse.wheel(0, dy);
  await wait(WHEEL.gapMs);
  await page.mouse.wheel(0, dy);
  // 마지막 휠의 스크롤이 실제로 끝난 순간(마지막 scroll 이벤트)에서 60ms 를 센다.
  const info = await page.evaluate(
    ([change, px]) =>
      new Promise((done) => {
        const H = window.__hold;
        let last = performance.now();
        const on = () => {
          last = performance.now();
        };
        H.node.addEventListener("scroll", on, { passive: true });
        const poll = () => {
          const quiet = performance.now() - last;
          if (quiet < 60) return setTimeout(poll, 4);
          H.node.removeEventListener("scroll", on);
          const height = H.node.scrollHeight;
          if (change === "grow") H.grow(px);
          else H.ungrow();
          done({ quietMs: Math.round(quiet), height });
        };
        setTimeout(poll, 30);
      }),
    [change, GROW_PX]
  );
  await wait(700);
  const { frames, marks, dropped } = await stop(page);
  const from = Math.max(0, (marks[marks.length - 1]?.frame ?? 0) - 1);
  const m = motionOf(frames.slice(from).map((frame) => frame.watch));
  const grew = (frames[frames.length - 1]?.height ?? info.height) - info.height;
  const scrolled = (frames[frames.length - 1]?.top ?? topBefore) - topBefore;
  const want = change === "grow" ? GROW_PX : -GROW_PX;
  const built = Math.abs(grew - want) <= 1 && m !== null && m.samples >= 10 && info.quietMs < 150 && Math.abs(scrolled) >= Math.abs(dy);
  const ok = built && m.range <= LIMIT.readingPx && m.reversals === 0;
  rows.push({
    scene,
    verdict: recordOnly ? "기록" : ok ? "PASS" : "FAIL",
    movedPx: m?.range ?? null,
    reversals: m?.reversals ?? null,
    note: `${built ? "" : "장면을 못 만들었다 · "}마지막 스크롤 뒤 ${info.quietMs}ms · 목록 높이 ${grew >= 0 ? "+" : ""}${grew}px · 프레임 ${m?.samples ?? 0}(버림 ${dropped})`,
  });
}

/** 바닥 장면 하나: `act` 뒤 그려진 모든 프레임의 바닥 거리. */
async function bottomScene(page, rows, scene, act, built) {
  // 앞 장면이 바닥을 놓쳤어도 이 장면은 바닥에서 시작한다(장면마다 따로 잰다).
  await page.evaluate(() => {
    window.__hold.node.scrollTop = window.__hold.node.scrollHeight;
  });
  await wait(500);
  await record(page);
  await wait(150);
  const before = await page.evaluate(() => ({ height: window.__hold.node.scrollHeight, gap: window.__hold.node.scrollHeight - window.__hold.node.scrollTop - window.__hold.node.clientHeight }));
  await act();
  await wait(900);
  const { frames, dropped } = await stop(page);
  const gaps = frames.map((frame) => frame.gap);
  const worst = gaps.length > 0 ? round2(Math.max(...gaps)) : null;
  const grew = (frames[frames.length - 1]?.height ?? before.height) - before.height;
  const sceneBuilt = before.gap <= 1 && frames.length >= 10 && (await built(grew));
  rows.push({
    scene,
    verdict: sceneBuilt && worst !== null && worst <= LIMIT.bottomPx ? "PASS" : "FAIL",
    gapPx: worst,
    note: `${sceneBuilt ? "" : "장면을 못 만들었다 · "}목록 높이 ${grew >= 0 ? "+" : ""}${grew}px · 끝 바닥 거리 ${gaps[gaps.length - 1] ?? "?"}px · 프레임 ${frames.length}(버림 ${dropped})`,
  });
}

async function threadScenes(page, backend, rows, tag, measured) {
  const list = { name: `스레드${tag}`, selector: THREAD, rowSelector: "[data-message-id]", park: 0.5 };
  const opened = await openThread(page);
  rows.push({
    scene: `스레드${tag} 상자 overflow-anchor · 열면 맨 위`,
    verdict: opened.overflowAnchor === "none" && opened.scrollTop <= 1 && !forceNone ? "PASS" : forceNone && opened.scrollTop <= 1 ? "대조" : "FAIL",
    note: `계산값 ${opened.overflowAnchor}${forceNone ? "(게이트가 인라인으로 건 대조)" : ""} · 연 직후 scrollTop ${opened.scrollTop}`,
  });
  await readingScene(page, list, rows);
  await scrollingScene(page, list, rows, { dy: WHEEL.dy, change: "grow" });
  await scrollingScene(page, list, rows, { dy: WHEEL.dy, change: "shrink" });
  await justStoppedScene(page, list, rows, { dy: WHEEL.dy, change: "grow" });

  // T5 창 높이(위 읽기): 상자의 아래 끝만 움직인다 — 보던 줄은 제자리.
  await park(page, THREAD, 0.5);
  const picked = await page.evaluate(([s, r]) => window.__hold.pick(s, r, 0), [THREAD, "[data-message-id]"]);
  if (picked.error) rows.push({ scene: `스레드${tag} 창 높이 800→640→800 — 위 읽기`, verdict: "FAIL", note: picked.error });
  else {
    await record(page);
    await wait(150);
    await page.setViewportSize({ width: viewport.width, height: 640 });
    await wait(500);
    await page.setViewportSize(viewport);
    await wait(500);
    const { frames } = await stop(page);
    const m = motionOf(frames.map((frame) => frame.watch));
    rows.push({
      scene: `스레드${tag} 창 높이 800→640→800 — 위 읽기`,
      verdict: m !== null && m.samples >= 10 && m.range <= LIMIT.readingPx && m.reversals === 0 ? "PASS" : "FAIL",
      movedPx: m?.range ?? null,
      reversals: m?.reversals ?? null,
      note: `프레임 ${m?.samples ?? 0}`,
    });
  }

  // T4 바닥.
  await page.locator(THREAD).evaluate((node) => {
    window.__hold.grower?.style.removeProperty("min-height");
    node.scrollTop = node.scrollHeight;
  });
  await wait(600);
  const bottom = await page.evaluate(([s, r]) => window.__hold.pickBottom(s, r), [THREAD, "[data-message-id]"]);
  if (bottom.error) {
    rows.push({ scene: `스레드${tag} 바닥`, verdict: "FAIL", note: bottom.error });
    return;
  }
  await bottomScene(page, rows, `스레드${tag} 바닥 — 마지막 답글 +${GROW_PX}px(늦게 뜨는 그림)`, () => page.evaluate((px) => window.__hold.grow(px), GROW_PX), async (grew) => Math.abs(grew - GROW_PX) <= 1);
  await page.evaluate(() => window.__hold.ungrow());
  await wait(500);
  const replyId = `0199ffff-0000-7000-8000-${String(0xe00 + rows.length).padStart(12, "0")}`;
  const replyBody = `남이 단 새 답글 ${rows.length}`;
  await bottomScene(
    page,
    rows,
    `스레드${tag} 바닥 — 남의 새 답글`,
    async () => {
      const seq = 3000 + rows.length;
      backend.replies.push(row({ id: replyId, seq, rootId: ROOT_MSG, authorMemberId: peerId, body: replyBody, createdAtMs: Date.now() }));
      backend.publish({
        type: "message.new",
        v: 1,
        seq,
        payload: { id: replyId, channel_id: channelId, root_id: ROOT_MSG, seq, type: "text", body: replyBody, author_member_id: peerId, hlc_ts: Date.now(), hlc_count: 0 },
      });
    },
    async (grew) => grew >= 20 && (await page.locator(THREAD).getByText(replyBody).count()) === 1
  );
  await bottomScene(
    page,
    rows,
    `스레드${tag} 바닥 — 창 높이 800→640→800`,
    async () => {
      await page.setViewportSize({ width: viewport.width, height: 640 });
      await wait(400);
      await page.setViewportSize(viewport);
    },
    async () => true
  );

  // T7 짧은 스레드: 한 화면에 다 들어와 맨 위에 서 있다(위도 바닥도 되는 자리). 답글이 자라 넘쳐도 맨 위 그대로다.
  const shortScene = `스레드${tag} 짧은 목록(한 화면) — 답글이 자라 넘쳐도 맨 위`;
  const short = await openThread(page, SHORT_ROOT_MSG, 3);
  const fits = await page.locator(THREAD).evaluate((node) => node.scrollHeight <= node.clientHeight);
  const shortPicked = await page.evaluate(([s, r]) => window.__hold.pickBottom(s, r), [THREAD, "[data-message-id]"]);
  if (shortPicked.error || !fits || short.scrollTop > 1) {
    rows.push({ scene: shortScene, verdict: "FAIL", note: `장면을 못 만들었다(${shortPicked.error ?? ""} 한 화면 ${fits} · 연 직후 scrollTop ${short.scrollTop})` });
    return;
  }
  await record(page);
  await wait(150);
  await page.evaluate(() => window.__hold.grow(900));
  await wait(700);
  const grown = await stop(page);
  const tops = grown.frames.map((frame) => frame.top);
  const overflow = await page.locator(THREAD).evaluate((node) => node.scrollHeight - node.clientHeight);
  const worstTop = tops.length > 0 ? Math.max(...tops) : null;
  rows.push({
    scene: shortScene,
    verdict: overflow >= 400 && tops.length >= 10 && worstTop !== null && worstTop <= 1 ? "PASS" : "FAIL",
    note: `${overflow >= 400 ? "" : "장면을 못 만들었다 · "}넘친 높이 ${overflow}px · 가장 큰 scrollTop ${worstTop} · 프레임 ${tops.length}`,
  });
  await threadSwitchScene(page, backend, rows, tag, measured);
}

/** T8: 스레드 A 를 조금 내려 둔 채 긴 루트의 B 로 바꿔 열면 B 는 루트가 보이는 맨 위에서 열린다. `measured` 는 B 루트 높이를 따로 잰 값이다. */
async function threadSwitchScene(page, backend, rows, tag, measured) {
  // 띠 [M−64, M] 안의 세 자리(M 은 잰 B 루트 높이와 창 높이 640 에서 나온다 — 1280×640 에서 M−64 ≥ 1 이 되게 본문 길이를 맞춰 두었다).
  const bandNow = measured.rootHeight + 32 - 459;
  for (const delta of [bandNow - 55, bandNow - 30, bandNow - 8].map((value) => Math.max(1, value))) {
    const scene = `스레드${tag} 바꿔 열기 — A 를 ${delta}px 내려 둔 채 긴 루트의 B 로`;
    await page.setViewportSize({ width: viewport.width, height: 640 });
    await wait(300);
    await openThread(page, ROOT_MSG, backend.replies.length + 1);
    const box = await page.locator(THREAD).evaluate((node) => ({ clientHeight: node.clientHeight, max: node.scrollHeight - node.clientHeight }));
    // 뼈대가 서는 순간의 최대 scrollTop M = 루트 높이 + 32 − 상자 높이. A 의 scrollTop 이 [M−64, M] 에 들어야 틈이 열린다.
    const band = measured.rootHeight + 32 - box.clientHeight;
    // 장면이 서려면 M > 0 이고 delta 가 띠 안이다. 띠에서 벗어난 delta 는 건너뛰지 않고 「장면을 못 만들었다」로 FAIL 한다(헛도는 칸 금지).
    const inBand = band > 0 && delta >= band - 64 && delta <= band;
    await page.locator(THREAD).evaluate((node, top) => {
      node.scrollTop = top;
    }, delta);
    await wait(500);
    const set = await page.locator(THREAD).evaluate((node) => node.scrollTop);
    await openThread(page, LONG_ROOT_MSG, 31);
    const samples = [];
    for (let i = 0; i < 6; i += 1) {
      samples.push(await page.locator(THREAD).evaluate((node) => Math.round(node.scrollTop)));
      await wait(250);
    }
    const worst = Math.max(...samples.map(Math.abs));
    const built = inBand && Math.abs(set - delta) <= 1;
    rows.push({
      scene,
      verdict: built && worst <= 1 ? "PASS" : "FAIL",
      note: `${built ? "" : "장면을 못 만들었다 · "}B 루트 ${measured.rootHeight}px · 상자 ${box.clientHeight}px · 띠 M=${band} · A 의 scrollTop ${set} · 연 뒤 scrollTop ${samples.join("/")}`,
    });
    await page.setViewportSize(viewport);
    await wait(300);
  }
}

/** B 루트의 높이를 따로 잰다(받아 두지 않은 채로 T8 을 하려고 별도 맥락에서). */
async function measureLongRoot(browser) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: 640 }, deviceScaleFactor: 2, locale: "ko-KR", colorScheme: "light" });
  try {
    const backend = await installBackend(context);
    const page = await context.newPage();
    await installPage(page);
    await openChannel(page, backend);
    await openThread(page, LONG_ROOT_MSG, 31);
    // 루트 높이가 두 번 연달아 같을 때까지 기다려 읽는다(그림 · 글꼴이 늦게 자리를 잡을 수 있다).
    let rootHeight = -1;
    for (let i = 0; i < 10; i += 1) {
      const now = await page.locator(THREAD).evaluate((node) => Math.round(node.querySelector("[data-message-id]").getBoundingClientRect().height));
      if (now === rootHeight) break;
      rootHeight = now;
      await wait(300);
    }
    return { rootHeight };
  } finally {
    await context.close();
  }
}

/**
 * L5~L7: 휠로 한 번 내린 뒤 `afterMs` 에 이동을 한다(null 이면 휠 없이 — 기준). `via` 는 이동 방법:
 *   click    「최신 메시지로 이동」 누르기(L5)  ·  end  키보드 End(L6)  ·  pagedown  키보드 PageDown(L6)
 *   clickWheels  누른 뒤 20ms 간격으로 작은 휠 세 번이 이어진다(L7 — 휠이 이어져도 바닥에 간다).
 * 끝 바닥 거리 · 움직인 거리를 돌려준다.
 */
async function jumpRun(page, afterMs, via = "click") {
  await park(page, TIMELINE, 0.4);
  await page.waitForFunction(() => document.querySelector('[data-testid="jump-latest"]') !== null, null, { timeout: 5000 }).catch(() => {});
  const box = await page.locator(TIMELINE).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.evaluate(() => {
    window.__hold.node = document.querySelector('[data-testid="timeline-virtuoso"]');
    window.__hold.watch = null;
  });
  const focused = await page.evaluate(() => {
    const list = document.querySelector('[data-testid="timeline-virtuoso"]');
    const edge = list.getBoundingClientRect();
    const row = [...list.querySelectorAll('[data-testid="timeline-message"]')].find((el) => el.getBoundingClientRect().top > edge.top + 80);
    row?.focus();
    return row !== undefined && list.contains(document.activeElement) && document.activeElement !== list;
  });
  await record(page);
  await wait(100);
  const topBefore = await page.evaluate(() => window.__hold.node.scrollTop);
  if (afterMs !== null) {
    await page.mouse.wheel(0, WHEEL.dy);
    await wait(afterMs);
  }
  let pill = true;
  let grew = null;
  if (via === "pagedownGrow") {
    // 다음 스크롤(= PageDown 의 첫 프레임)에서 화면 위 밖 줄을 120px 키우고 세 프레임 뒤 되돌린다. 그동안 그 줄이 붙어 있어야 장면이 선다.
    grew = await page.evaluate(
      ([selector, px]) => {
        const H = window.__hold;
        const picked = H.pick(selector, "[data-index]", 0);
        H.watch = null;
        if (picked.error) return { error: picked.error };
        const report = { grown: false, attachedAtUngrow: false };
        const node = H.node;
        const onScroll = () => {
          node.removeEventListener("scroll", onScroll);
          H.grow(px);
          report.grown = true;
          let frames = 0;
          const tick = () => {
            frames += 1;
            if (frames < 3) {
              requestAnimationFrame(tick);
              return;
            }
            report.attachedAtUngrow = H.grower.isConnected;
            H.ungrow();
          };
          requestAnimationFrame(tick);
        };
        node.addEventListener("scroll", onScroll, { passive: true });
        H.growReport = report;
        return { aboveRows: picked.aboveRows };
      },
      [TIMELINE, GROW_PX]
    );
  }
  if (via === "click" || via === "clickWheels") {
    pill = await page.evaluate(() => {
      const button = document.querySelector('[data-testid="jump-latest"]');
      if (button === null) return false;
      button.click();
      return true;
    });
    if (via === "clickWheels") {
      for (let i = 0; i < 3; i += 1) {
        await wait(20);
        await page.mouse.wheel(0, 6);
      }
    }
  } else await page.keyboard.press(via === "end" ? "End" : "PageDown");
  await wait(1800);
  const { frames } = await stop(page);
  const last = frames[frames.length - 1];
  if (grew !== null && !grew.error) grew = await page.evaluate(() => window.__hold.growReport);
  return { pill, focused, grew, gap: last ? last.gap : null, moved: last ? round2(last.top - topBefore) : null, client: viewport.height };
}

/** 이동 뒤 바닥 거리 상한(px): 이 장면의 원래 값이 7px 이다(휠 없이 누른 값). 기준 실행과 견주지 않고 상한으로 단정한다(검수 2회차 M1). */
const JUMP_GAP_MAX = 9;

async function jumpScenes(page, rows) {
  const base = await jumpRun(page, null);
  rows.push({
    scene: "타임라인 최신 메시지로 이동 — 휠 없이(기준)",
    verdict: base.pill && base.gap !== null && base.gap <= JUMP_GAP_MAX ? "PASS" : "FAIL",
    gapPx: base.gap,
    note: `${base.pill ? "" : "장면을 못 만들었다(이동 버튼이 없다) · "}끝 바닥 거리 ${base.gap}px (상한 ${JUMP_GAP_MAX})`,
  });
  for (const afterMs of [30, 80, 160]) {
    const run = await jumpRun(page, afterMs);
    const built = run.pill && run.gap !== null;
    rows.push({
      scene: `타임라인 휠 뒤 ${afterMs}ms 에 최신 메시지로 이동`,
      verdict: built && run.gap <= JUMP_GAP_MAX ? "PASS" : "FAIL",
      gapPx: run.gap,
      note: `${built ? "" : "장면을 못 만들었다 · "}끝 바닥 거리 ${run.gap}px (상한 ${JUMP_GAP_MAX})`,
    });
  }
  // L6 키보드: 휠 직후 End → 바닥 · PageDown → 한 쪽 가까이(휠 30px 에 더해 ≥ 450px).
  for (const afterMs of [30, 80, 160]) {
    const end = await jumpRun(page, afterMs, "end");
    const builtEnd = end.focused && end.gap !== null && end.moved !== null && end.moved > 200;
    rows.push({
      scene: `타임라인 휠 뒤 ${afterMs}ms 에 키보드 End`,
      verdict: builtEnd && end.gap <= JUMP_GAP_MAX ? "PASS" : "FAIL",
      gapPx: end.gap,
      note: `${builtEnd ? "" : "장면을 못 만들었다 · "}줄 초점 ${end.focused} · 끝 바닥 거리 ${end.gap}px (상한 ${JUMP_GAP_MAX}) · 움직인 거리 ${end.moved}px`,
    });
    const page_ = await jumpRun(page, afterMs, "pagedown");
    const builtPage = page_.focused && page_.moved !== null;
    rows.push({
      scene: `타임라인 휠 뒤 ${afterMs}ms 에 키보드 PageDown`,
      verdict: builtPage && page_.moved >= 450 ? "PASS" : "FAIL",
      note: `${builtPage ? "" : "장면을 못 만들었다 · "}줄 초점 ${page_.focused} · 움직인 거리 ${page_.moved}px (하한 450 — 휠 30 + 한 쪽)`,
    });
  }
  // L6b 키보드 스크롤 도중 줄 높이가 바뀐다(검수 3회차 M1): 키보드 스크롤을 사람의 손으로 치면 자리를 붙들어 PageDown 을 끊는다.
  {
    const grown = await jumpRun(page, 80, "pagedownGrow");
    const built = grown.focused && grown.moved !== null && grown.grew !== null && !grown.grew.error && grown.grew.grown && grown.grew.attachedAtUngrow;
    rows.push({
      scene: "타임라인 휠 뒤 80ms 에 키보드 PageDown · 그 도중 위 밖 줄 +120px 뒤 되돌아감",
      verdict: built && grown.moved >= 450 ? "PASS" : "FAIL",
      note: `${built ? "" : `장면을 못 만들었다(${JSON.stringify(grown.grew)}) · `}줄 초점 ${grown.focused} · 움직인 거리 ${grown.moved}px (하한 450 — 휠 30 + 한 쪽)`,
    });
  }
  // L7 누른 뒤에도 휠이 이어진다.
  for (const afterMs of [30, 80, 160]) {
    const run = await jumpRun(page, afterMs, "clickWheels");
    const built = run.pill && run.gap !== null;
    rows.push({
      scene: `타임라인 휠 뒤 ${afterMs}ms 에 최신 메시지로 이동 · 이어서 휠 세 번`,
      verdict: built && run.gap <= JUMP_GAP_MAX ? "PASS" : "FAIL",
      gapPx: run.gap,
      note: `${built ? "" : "장면을 못 만들었다 · "}끝 바닥 거리 ${run.gap}px (상한 ${JUMP_GAP_MAX})`,
    });
  }
}

async function timelineScenes(page, rows) {
  const list = { name: "타임라인", selector: TIMELINE, rowSelector: "[data-index]", park: 0.4 };
  const anchor = await page.locator(TIMELINE).evaluate((node) => getComputedStyle(node).getPropertyValue("overflow-anchor") || "(계산값 없음)");
  rows.push({ scene: "타임라인 스크롤러 overflow-anchor", verdict: anchor === "none" ? "PASS" : "FAIL", note: `계산값 ${anchor}` });
  await readingScene(page, list, rows);
  await scrollingScene(page, list, rows, { dy: WHEEL.dy, change: "grow" });
  await scrollingScene(page, list, rows, { dy: WHEEL.dy, change: "shrink" });
  await justStoppedScene(page, list, rows, { dy: WHEEL.dy, change: "grow" });
  await justStoppedScene(page, list, rows, { dy: WHEEL.dy, change: "shrink" });
  await scrollingScene(page, list, rows, { dy: -WHEEL.dy, change: "grow", recordOnly: true });
  await justStoppedScene(page, list, rows, { dy: -WHEEL.dy, change: "grow", recordOnly: true });
  await jumpScenes(page, rows);
}

async function runEngine(browser, engine) {
  const rows = [];
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, locale: "ko-KR", colorScheme: "light" });
  const backend = await installBackend(context);
  const page = await context.newPage();
  await installPage(page);
  await openChannel(page, backend);
  if (sets.includes("timeline")) await timelineScenes(page, rows);
  if (sets.includes("thread")) await threadScenes(page, backend, rows, "", await measureLongRoot(browser));
  await context.close();
  if (sets.includes("thread")) {
    // T6 움직임 줄이기: 같은 위 읽기 장면을 한 번.
    const reduced = await browser.newContext({ viewport, deviceScaleFactor: 2, locale: "ko-KR", colorScheme: "light", reducedMotion: "reduce" });
    const reducedBackend = await installBackend(reduced);
    const reducedPage = await reduced.newPage();
    await installPage(reducedPage);
    await openChannel(reducedPage, reducedBackend);
    await openThread(reducedPage);
    await readingScene(reducedPage, { name: "스레드(움직임 줄이기)", selector: THREAD, rowSelector: "[data-message-id]", park: 0.5 }, rows);
    await reduced.close();
  }
  return rows.map((entry) => ({ engine, ...entry }));
}

async function main() {
  const server = await startGuardedPreview({
    webRoot,
    port,
    portEnvVar: "THREAD_HOLD_PORT",
    extraArgs: distOverride ? ["--outDir", resolve(distOverride)] : [],
  });
  const table = [];
  const loadStart = load1();
  try {
    for (const name of engineNames) {
      const browser = await (name === "webkit" ? webkit : chromium).launch({ headless: true });
      try {
        console.log(`[엔진 ${name} ${browser.version()}] 1분 부하 ${load1()}`);
        const rows = await runEngine(browser, name);
        for (const entry of rows) {
          const numbers = [
            entry.movedPx === undefined || entry.movedPx === null ? null : `이동 ${entry.movedPx}px`,
            entry.reversals === undefined || entry.reversals === null ? null : `되돌아옴 ${entry.reversals}`,
            entry.gapPx === undefined || entry.gapPx === null ? null : `바닥 거리 ${entry.gapPx}px`,
          ].filter(Boolean);
          console.log(`[${name}] ${entry.verdict} ${entry.scene}${numbers.length > 0 ? ` — ${numbers.join(" · ")}` : ""} (${entry.note})`);
        }
        table.push(...rows);
      } finally {
        await browser.close();
      }
    }
  } finally {
    await server.stop();
  }
  const loadEnd = load1();
  if (outFile !== null) writeFileSync(resolve(outFile), `${JSON.stringify({ loadStart, loadEnd, forceNone, dist: distOverride, rows: table }, null, 2)}\n`);
  const failed = table.filter((entry) => entry.verdict === "FAIL");
  const passed = table.filter((entry) => entry.verdict === "PASS");
  const tail = `${engineNames.join("·")} · ${sets.join("+")} · 1분 부하 ${loadStart}→${loadEnd}${forceNone ? " · 스레드 상자 대조(인라인 none)" : ""}`;
  if (passed.length === 0) {
    console.error(`FAIL thread-hold: 통과한 장면이 0개다(${table.length}칸) — ${tail}`);
    process.exit(1);
  }
  if (failed.length > 0) {
    for (const entry of failed) console.error(`FAIL ${entry.engine}: ${entry.scene} (${entry.note})`);
    console.error(`FAIL thread-hold: ${failed.length}/${table.length}칸 — ${tail}`);
    process.exit(1);
  }
  console.log(
    `PASS thread-hold: ${table.length}칸(단정 ${passed.length} · 기록 ${table.length - passed.length}) — 위 읽기 · 스크롤 중 ≤${LIMIT.readingPx}px · 되돌아옴 0 · 바닥 ≤${LIMIT.bottomPx}px — ${tail}`
  );
}

await main();
