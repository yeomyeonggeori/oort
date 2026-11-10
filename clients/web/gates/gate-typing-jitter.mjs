#!/usr/bin/env node
// GATE: #5567 — 두 사람 DM에서 상대 「작성 중」이 켜지고 꺼지는 동안 내가 입력해도 대화 목록이
// 움직이지 않는다. 실제 번들 · 실제 가상 목록 · 실제 입력창을 **WebKit**(데스크탑 앱의 WKWebView와 같은
// 엔진)과 Chromium에서 잰다.
//
// 재는 것 (맨 아래에 붙은 상태에서):
//   - 목록 `scrollTop`이 바뀐 횟수(`scroll` 이벤트)와 값
//   - 입력창 `style.height`에 쓰인 값의 차례(MutationObserver — 한 작업 안의 잠깐 값까지 본다)
//   - 매 프레임 그려진 마지막 행의 바닥 y · 입력창 · 도구 줄 · 독 높이
//   - ResizeObserver 콜백 수(목록 스크롤러에 걸린 것)와 layout-shift(지원하는 엔진만)
//
// 단계: A 입력만 · B 표시만 켜고 끄기 · C 둘 다(owner 장면) · D 줄이 늘어나는 입력(높이가 바뀌어도 바닥에 붙어야 한다).
//
// 사용: npm run build && node gates/gate-typing-jitter.mjs
//   TYPING_JITTER_ENGINES=webkit,chromium  (기본 둘 다)
//   TYPING_JITTER_VIEWPORTS=1280x800,900x700,390x844  (기본, 폰 폭 포함 #5582)
//   TYPING_JITTER_OUT=<폴더>               프레임 기록 JSON을 남긴다
//   TYPING_JITTER_MEASURE_ONLY=1           단정 없이 숫자만 찍는다(원인 실측용)
//   TYPING_JITTER_DIST=<폴더>               dist 대신 이 번들을 띄운다(수리 전 번들과 숫자를 견줄 때)
// 머리 출력: 엔진마다 `CSS.supports('overflow-anchor','auto')`와 타임라인 스크롤러의 계산값을 찍는다(#5638, `engine-anchor.mjs`).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { printEngineAnchorHeader } from "./engine-anchor.mjs";
import { startGuardedPreview } from "./preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.TYPING_JITTER_PORT || 5198);
const origin = `http://127.0.0.1:${port}`;
const engineNames = (process.env.TYPING_JITTER_ENGINES || "webkit,chromium")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const outDir = process.env.TYPING_JITTER_OUT || null;
const measureOnly = process.env.TYPING_JITTER_MEASURE_ONLY === "1";
const distOverride = process.env.TYPING_JITTER_DIST || null;
// 600 아래(폰 폭)도 기본으로 돈다(#5582, design-review R2-L4): 폰 폭은 「작성 중」 칸이 26이고 독 구조(위 경계선 · 폼 p-3)가 다르다.
const viewports = (process.env.TYPING_JITTER_VIEWPORTS || "1280x800,900x700,390x844")
  .split(",")
  .map((pair) => {
    const [width, height] = pair.split("x").map(Number);
    return { width, height };
  });

const workspaceId = "00000000-0000-7000-8000-000000000001";
const meId = "00000000-0000-7000-8000-000000000111";
const peerId = "00000000-0000-7000-8000-000000000112";
const dmChannelId = "00000000-0000-7000-8000-000000000212";
const generalId = "00000000-0000-7000-8000-000000000211";

const GRANT_DELAY_MS = 120;
const PUBLISH_DELAY_MS = 40;
const REPUBLISH_MS = 3_000;
const AGGREGATE_THRESHOLD = 3;

const session = {
  accessToken: "gate-only-not-a-credential",
  refreshToken: "gate-only-not-a-credential",
  member: { id: meId, workspaceId, kind: "human", displayName: "윤서진", handle: "seojin" },
  realtimeWebSocketUrl: "ws://typing-jitter.invalid/connection/websocket",
};

function rosterMember(over) {
  return {
    workspaceId,
    status: "active",
    role: "member",
    channelCount: 2,
    channelIds: [generalId, dmChannelId],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  };
}

const roster = [
  rosterMember({ id: meId, kind: "human", role: "owner", displayName: "윤서진", handle: "seojin" }),
  rosterMember({ id: peerId, kind: "human", displayName: "한지후", handle: "jihu" }),
];

const channels = [
  { id: generalId, workspaceId, kind: "public", name: "general", topic: "", muted: false },
  { id: dmChannelId, workspaceId, kind: "dm", muted: false, memberIds: [meId, peerId] },
];

// 실제 팀 대화처럼 섞는다(SKILL §7). 화면을 넘칠 만큼 길게: 목록이 스크롤돼야 「맨 아래에 붙음」이 뜻을 갖는다.
const HISTORY_LINES = [
  "오늘 배포 전에 마이그레이션 순서 한 번만 같이 봐 줄 수 있어요?",
  "네, 10분 뒤에 볼게요. outbox relay 쪽은 어제 고친 그대로예요.",
  "좋아요. 롤백 스크립트도 최신인지 확인해 둘게요.",
  "staging에서 5xx 두 건 있었는데 둘 다 timeout이었어요.",
  "그건 Centrifugo 재연결 구간이라 서버 오류는 아니었던 것 같아요.",
  "릴리스 노트에 그 문장 한 줄만 추가해 둘게요.",
  "점심 먹고 QA 체크리스트 마지막 세 줄 같이 봐요.",
  "확인했어요. 그러면 이번 배포는 그대로 가도 되겠네요.",
];

/** 창 폭에서 두세 줄로 접히는 한 문단(줄바꿈 없음). 한국어 메시지는 이렇게 온다(Composer.tsx U4-f 3). */
const LONG_DRAFT =
  "방금 staging 로그 다시 봤는데 5xx 두 건은 둘 다 Centrifugo 재연결 구간이었고 서버 오류는 아니었어요. " +
  "그래서 이번 배포는 그대로 가도 될 것 같고, 릴리스 노트에는 재연결 동안 알림이 늦을 수 있다는 문장만 한 줄 더 넣을게요. " +
  "QA 체크리스트 마지막 세 줄은 점심 먹고 같이 봐요.";

function history() {
  const rows = [];
  for (let i = 0; i < 60; i += 1) {
    rows.push({
      id: `0199eeee-0000-7000-8000-${String(i).padStart(12, "0")}`,
      channelId: dmChannelId,
      seq: i + 1,
      hlcTs: 1_785_238_400_000 + i * 60_000,
      hlcCount: 0,
      authorMemberId: i % 3 === 0 ? meId : peerId,
      type: "text",
      body: HISTORY_LINES[i % HISTORY_LINES.length],
      state: "sent",
      createdAtMs: 1_785_238_400_000 + i * 60_000,
    });
  }
  return rows;
}

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

function wait(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

async function installRoutes(context) {
  const rows = history();
  await context.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === "/v1/auth/login") return json(route, session);
    if (path === "/v1/auth/realtime-token") {
      return json(route, {
        token: "gate-realtime-token",
        tokenType: "Bearer",
        expiresAtMs: Date.now() + 600_000,
        ttlSeconds: 600,
        workspaceId,
        memberId: meId,
      });
    }
    if (path === "/v1/auth/refresh") {
      return json(route, { accessToken: session.accessToken, refreshToken: session.refreshToken });
    }
    if (path.endsWith("/typing/grant")) {
      await wait(GRANT_DELAY_MS);
      return json(route, {
        grant: "gate-grant-1",
        channel: `typing:ws${workspaceId.toUpperCase()}.${dmChannelId.toUpperCase()}`,
        expiresAtMs: Date.now() + 600_000,
        ttlSeconds: 600,
        signalTtlMs: 6_000,
        republishIntervalMs: REPUBLISH_MS,
        aggregateThreshold: AGGREGATE_THRESHOLD,
      });
    }
    if (path.endsWith("/typing")) {
      await wait(PUBLISH_DELAY_MS);
      return route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          channel: `typing:ws${workspaceId.toUpperCase()}.${dmChannelId.toUpperCase()}`,
          expiresAtMs: Date.now() + 6_000,
          republishAfterMs: REPUBLISH_MS,
        }),
      });
    }
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/reactions")) return json(route, { reactions: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-sessions")) return json(route, { sessions: [] });
    if (path.endsWith("/replies")) return json(route, { messages: [] });
    if (path.includes("/messages")) {
      if (!path.includes(dmChannelId) || url.searchParams.has("after")) {
        return json(route, { messages: [] });
      }
      return json(route, { messages: rows });
    }
    return json(route, {});
  });
}

/** 레일(Centrifugo) 흉내. `gate-typing.mjs`와 같은 모양이다: 같은 tick에 답하지 않고, 지정한 접두의 구독에만 흘린다. */
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
        const replies = [];
        for (const line of String(data).trim().split("\n")) {
          const command = JSON.parse(line);
          if (command.connect) {
            replies.push({ id: command.id, connect: { client: "typing-jitter", version: "6" } });
          } else if (command.subscribe) {
            this.subscriptions.add(command.subscribe.channel);
            replies.push({
              id: command.id,
              subscribe: { recoverable: true, positioned: true, recovered: true, epoch: "typing-jitter", offset },
            });
          } else if (command.unsubscribe) {
            this.subscriptions.delete(command.unsubscribe.channel);
            replies.push({ id: command.id, unsubscribe: {} });
          } else {
            replies.push({ id: command.id });
          }
        }
        queueMicrotask(() => {
          this.onmessage?.(
            new MessageEvent("message", { data: replies.map((reply) => JSON.stringify(reply)).join("\n") })
          );
        });
      }
      close() {
        this.readyState = GateWebSocket.CLOSED;
        sockets.delete(this);
        this.onclose?.(new CloseEvent("close", { code: 1000 }));
      }
    }
    window.WebSocket = GateWebSocket;
    window.__jitterReady = (prefix) => {
      for (const socket of sockets) {
        for (const name of socket.subscriptions) if (name.startsWith(prefix)) return true;
      }
      return false;
    };
    window.__jitterPublish = (prefix, frame) => {
      offset += 1;
      let delivered = 0;
      for (const socket of sockets) {
        for (const name of socket.subscriptions) {
          if (!name.startsWith(prefix)) continue;
          delivered += 1;
          socket.onmessage?.(
            new MessageEvent("message", {
              data: JSON.stringify({ push: { channel: name, pub: { data: frame, offset } } }),
            })
          );
        }
      }
      return delivered;
    };
  });
}

/**
 * 계측. 앱 스크립트보다 먼저 설치한다(ResizeObserver 감싸기는 앱이 만들기 전에 있어야 한다).
 * `J.on`인 동안만 센다 — 진입·로그인의 콜백은 이 시험이 묻는 것이 아니다.
 */
async function installProbe(page) {
  await page.addInitScript(() => {
    const J = {
      on: false,
      ro: 0,
      roScroller: 0,
      shifts: [],
      layoutShiftSupported:
        typeof PerformanceObserver !== "undefined" &&
        Array.isArray(PerformanceObserver.supportedEntryTypes) &&
        PerformanceObserver.supportedEntryTypes.includes("layout-shift"),
      scrolls: [],
      heights: [],
      frames: [],
    };
    window.__jitter = J;
    const Native = window.ResizeObserver;
    if (typeof Native === "function") {
      window.ResizeObserver = class extends Native {
        constructor(callback) {
          super((entries, observer) => {
            if (J.on) {
              J.ro += 1;
              if (entries.some((entry) => entry.target.hasAttribute?.("data-virtuoso-scroller"))) {
                J.roScroller += 1;
              }
            }
            callback(entries, observer);
          });
        }
      };
    }
    if (J.layoutShiftSupported) {
      const describe = (node) => {
        if (!node || node.nodeType !== 1) return node?.nodeName ?? "?";
        const testid = node.closest?.("[data-testid]")?.getAttribute("data-testid");
        return `${node.nodeName.toLowerCase()}${testid ? `@${testid}` : ""}`;
      };
      new PerformanceObserver((list) => {
        if (!J.on) return;
        for (const entry of list.getEntries()) {
          J.shifts.push({
            t: Math.round(entry.startTime),
            value: entry.value,
            sources: (entry.sources ?? []).map((source) => describe(source.node)),
          });
        }
      }).observe({ type: "layout-shift" });
    }
  });
}

/**
 * 이름 붙은 red proof (#5567): 제품 소스를 건드리지 않고 **옛 `useAutoGrow`가 키마다 하던 일**을 페이지에서 되살린다.
 * 입력 이벤트마다 입력창을 `height: auto`로 접고 `scrollHeight`를 읽은 뒤(강제 레이아웃) 높이를 되돌린다. 수리판 위에서
 * 이것만 켜도 WebKit 의 D·E 가 RED 여야 한다 — 이 게이트가 재는 것이 정확히 그 메커니즘이라는 증명이다.
 *   TYPING_JITTER_PROVE_RED_COLLAPSE=1 node gates/gate-typing-jitter.mjs
 *     expected failure (webkit): "입력하는 동안 목록이 N번 내려앉았다"
 */
async function installCollapseSeam(page) {
  await page.addInitScript(() => {
    document.addEventListener(
      "input",
      (event) => {
        const input = event.target;
        if (!(input instanceof HTMLTextAreaElement) || input.dataset.testid !== "composer-input") return;
        const fixed = input.style.height;
        input.style.height = "auto";
        void input.scrollHeight;
        input.style.height = fixed;
      },
      true
    );
  });
}

async function startWindow(page) {
  await page.evaluate(() => {
    const J = window.__jitter;
    const scroller = document.querySelector('[data-testid="chat-timeline"] [data-virtuoso-scroller]');
    const input = document.querySelector('[data-testid="composer-input"]');
    const actions = document.querySelector('[data-testid="composer-actions"]');
    const dock = document.querySelector('[data-testid="composer"]');
    if (!scroller || !input || !actions || !dock) throw new Error("계측할 노드가 없다");
    J.ro = 0;
    J.roScroller = 0;
    J.shifts = [];
    J.scrolls = [];
    J.heights = [];
    J.frames = [];
    J.on = true;
    const t0 = performance.now();
    J.t0 = t0;
    const onScroll = () => {
      if (J.on) J.scrolls.push({ t: Math.round(performance.now() - t0), top: scroller.scrollTop });
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    // 입력창 높이를 **쓰는 순간마다** 남긴다. 프레임 표본은 한 작업 안에서 썼다가 되돌린 값을 못 본다.
    const mo = new MutationObserver(() => {
      if (J.on) J.heights.push({ t: Math.round(performance.now() - t0), h: input.style.height });
    });
    mo.observe(input, { attributes: true, attributeFilter: ["style"] });
    // 그려진 모양: rAF 안에서 게시한 메시지는 그 프레임의 그리기(ResizeObserver 콜백 포함)가 끝난 뒤에 돈다.
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      if (!J.on) return;
      const rows = scroller.querySelectorAll("[data-index]");
      const last = rows[rows.length - 1];
      J.frames.push({
        t: Math.round(performance.now() - t0),
        top: scroller.scrollTop,
        gap: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
        ch: scroller.clientHeight,
        lastBottom: last ? Math.round(last.getBoundingClientRect().bottom * 100) / 100 : null,
        inputH: Math.round(input.getBoundingClientRect().height * 1000) / 1000,
        actionsH: Math.round(actions.getBoundingClientRect().height * 1000) / 1000,
        dockH: Math.round(dock.getBoundingClientRect().height * 1000) / 1000,
        typing: document.querySelector('[data-testid="composer-typing"], [data-testid="typing-line"][data-state="on"]') !== null,
      });
    };
    const tick = () => {
      if (!J.on) {
        scroller.removeEventListener("scroll", onScroll);
        mo.disconnect();
        return;
      }
      channel.port2.postMessage(0);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function stopWindow(page) {
  return page.evaluate(() => {
    const J = window.__jitter;
    J.on = false;
    return {
      ro: J.ro,
      roScroller: J.roScroller,
      shifts: J.shifts,
      layoutShiftSupported: J.layoutShiftSupported,
      scrolls: J.scrolls,
      heights: J.heights,
      frames: J.frames,
    };
  });
}

async function publishPeerTyping(page, ttlMs) {
  return page.evaluate(
    ({ ws, ch, who, ttl }) =>
      window.__jitterPublish("typing:", {
        type: "ephemeral.typing",
        v: 1,
        ts: Date.now(),
        payload: {
          workspace_id: ws.toUpperCase(),
          channel_id: ch.toUpperCase(),
          member_id: who.toUpperCase(),
          expires_at: Date.now() + ttl,
        },
      }),
    { ws: workspaceId, ch: dmChannelId, who: peerId, ttl: ttlMs }
  );
}

/** 상대 표시를 `cycles`번 켜고 끈다. 켜진 시간 ~ttl, 꺼짐은 저장소의 1초 훑기가 정한다. */
async function togglePeer(page, { cycles, ttlMs = 700, gapMs = 1_600 }) {
  for (let i = 0; i < cycles; i += 1) {
    await publishPeerTyping(page, ttlMs);
    await wait(gapMs);
  }
}

async function typeText(page, text, delay = 55) {
  await page.keyboard.type(text, { delay });
}

async function clearInput(page) {
  await page.getByTestId("composer-input").fill("");
}

function summarize(label, raw) {
  const tops = [...new Set(raw.frames.map((frame) => frame.top))];
  const lastBottoms = [...new Set(raw.frames.map((frame) => frame.lastBottom))];
  const inputHs = [...new Set(raw.frames.map((frame) => frame.inputH))];
  const actionsHs = [...new Set(raw.frames.map((frame) => frame.actionsH))];
  const dockHs = [...new Set(raw.frames.map((frame) => frame.dockH))];
  const gaps = raw.frames.map((frame) => frame.gap);
  const writtenHeights = raw.heights.map((entry) => entry.h);
  const distinctWritten = [...new Set(writtenHeights)];
  const typingFrames = raw.frames.filter((frame) => frame.typing).length;
  // 그려진 scrollTop이 **줄어든** 횟수와 폭. 바닥에 붙은 목록은 입력창이 자랄 때 위로만 간다(scrollTop 증가).
  // 줄었다는 것은 목록이 입력창 뒤로 내려앉았다는 뜻이고, 그 뒤에 다시 붙으면 위아래 왕복이 된다.
  // 1px 이하의 줄어듦은 따로 센다: 바닥 붙이기가 소수점 끝값을 정수로 맞추는 정착이다(그 프레임도 gap 0).
  let drops = 0;
  let settles = 0;
  let maxDrop = 0;
  for (let i = 1; i < raw.frames.length; i += 1) {
    const delta = raw.frames[i].top - raw.frames[i - 1].top;
    if (delta < -1) {
      drops += 1;
      maxDrop = Math.max(maxDrop, -delta);
    } else if (delta < 0) {
      settles += 1;
    }
  }
  return {
    label,
    frames: raw.frames.length,
    typingFrames,
    drops,
    settles,
    maxDrop,
    finalGap: raw.frames.length ? raw.frames[raw.frames.length - 1].gap : null,
    scrollEvents: raw.scrolls.length,
    scrollTops: tops,
    scrollEventTops: [...new Set(raw.scrolls.map((entry) => entry.top))].slice(0, 12),
    maxGap: gaps.length ? Math.max(...gaps.map((gap) => Math.abs(gap))) : null,
    lastBottoms: lastBottoms.slice(0, 12),
    lastBottomSpread: lastBottoms.length
      ? Math.round((Math.max(...lastBottoms) - Math.min(...lastBottoms)) * 100) / 100
      : null,
    inputHeights: inputHs,
    actionsHeights: actionsHs,
    dockHeights: dockHs,
    heightWrites: writtenHeights.length,
    distinctHeightWrites: distinctWritten,
    resizeObserverCallbacks: raw.ro,
    scrollerResizeCallbacks: raw.roScroller,
    layoutShift: raw.layoutShiftSupported
      ? Math.round(raw.shifts.reduce((sum, entry) => sum + entry.value, 0) * 10_000) / 10_000
      : "unsupported",
    layoutShiftEntries: raw.layoutShiftSupported ? raw.shifts.length : "unsupported",
    layoutShiftSources: raw.layoutShiftSupported
      ? [...new Set(raw.shifts.flatMap((entry) => entry.sources))]
      : "unsupported",
  };
}

async function openDm(page) {
  await page.goto(origin, { waitUntil: "networkidle" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("jitter@example.test");
  await page.getByTestId("login-password").fill("gate-only");
  await page.getByTestId("login-submit").click();
  const narrow = (page.viewportSize()?.width ?? 1280) < 600;
  if (narrow) {
    // 폰 폭에서는 사이드바가 서랍이라 채널 행이 화면 밖이다. 행이 가리키는 주소(`#/c/<id>`)로 똑같이 연다.
    await page.locator(`[data-testid="channel-item"][data-channel-id="${dmChannelId}"]`).waitFor({ state: "attached" });
    await page.evaluate((id) => {
      window.location.hash = `#/c/${id}`;
    }, dmChannelId);
  } else {
    await page.locator(`[data-testid="channel-item"][data-channel-id="${dmChannelId}"]`).click();
  }
  await page.getByTestId("composer-input").waitFor();
  await page.waitForFunction(() => window.__jitterReady("typing:"), undefined, { timeout: 15_000 });
  // 기록이 다 그려지고 목록이 바닥에 앉을 때까지.
  await page
    .waitForFunction(
      () => {
        const scroller = document.querySelector('[data-testid="chat-timeline"] [data-virtuoso-scroller]');
        if (!scroller) return false;
        // 바닥 판정은 앱과 같은 여유(`AT_BOTTOM_SLACK_PX` 64)로 한다. 첫 착지가 정확히 0이 아닐 수 있다(재는 값 중 하나다).
        return (
          scroller.scrollHeight > scroller.clientHeight + 200 &&
          scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 64
        );
      },
      undefined,
      { timeout: 15_000 }
    )
    .catch(async (error) => {
      const state = await page.evaluate(() => {
        const scroller = document.querySelector('[data-testid="chat-timeline"] [data-virtuoso-scroller]');
        return scroller
          ? { sh: scroller.scrollHeight, ch: scroller.clientHeight, top: scroller.scrollTop, rows: scroller.querySelectorAll("[data-index]").length }
          : { scroller: null, url: location.href };
      });
      throw new Error(`목록이 바닥에 앉지 않았다: ${JSON.stringify(state)} (${error.message})`);
    });
  await page.getByTestId("composer-input").click();
  await wait(1_200);
}

async function runScenario(browser, engine, viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, locale: "ko-KR" });
  const page = await context.newPage();
  await installProbe(page);
  if (process.env.TYPING_JITTER_PROVE_RED_COLLAPSE === "1") await installCollapseSeam(page);
  await installRealtimeSocket(page);
  await installRoutes(context);
  await openDm(page);
  if (process.env.TYPING_JITTER_ANCHOR_NONE === "1") {
    // 가설 ④ 가르기: 스크롤 앵커링을 끄고도 내려앉으면 원인은 앵커링이 아니다.
    await page.addStyleTag({ content: "[data-virtuoso-scroller]{overflow-anchor:none!important}" });
  }
  const features = await page.evaluate(() => {
    const scroller = document.querySelector('[data-testid="chat-timeline"] [data-virtuoso-scroller]');
    return {
      overflowAnchorAuto: CSS.supports("overflow-anchor", "auto"),
      scrollerOverflowAnchor: scroller ? getComputedStyle(scroller).getPropertyValue("overflow-anchor") || "(계산값 없음)" : null,
      fieldSizing: CSS.supports("field-sizing", "content"),
    };
  });
  console.log(`[${engine} ${viewport.width}x${viewport.height}] features ${JSON.stringify(features)}`);

  const results = [];
  const record = async (label, body) => {
    await startWindow(page);
    await body();
    await wait(400);
    const raw = await stopWindow(page);
    results.push({ summary: summarize(label, raw), raw });
  };

  // A. 입력만 (한 줄).
  await record("A 입력만", async () => {
    await typeText(page, "배포 체크리스트 다시 보고 알려 드릴게요");
  });
  await clearInput(page);
  await wait(500);

  // B. 상대 표시만 켜고 끄기 (입력 없음, 내 입력창은 빈 채).
  await record("B 표시만", async () => {
    await togglePeer(page, { cycles: 3 });
  });
  await wait(1_200);

  // C. 둘 다 (owner 장면): 상대 표시가 켜지고 꺼지는 동안 한 줄 안에서 입력한다.
  await record("C 입력+표시", async () => {
    // 이 장면은 **한 줄** 입력이다(높이 변화 0을 단정한다). 폰 폭(390)의 입력창은 한 줄에 한국어 스무 자 남짓이라 넓은 창의
    // 초안이 두 줄로 접힌다 — 그것은 줄 늘기(D·E가 잰다)이지 흔들림이 아니다. 그래서 폰 폭은 한 줄에 드는 초안을 친다(#5582).
    const narrow = viewport.width < 600;
    const typing = (async () => {
      await typeText(page, narrow ? "네 확인해 볼게요 " : "네 지금 확인해 볼게요 잠시만요 ");
      await typeText(page, narrow ? "잠시만요" : "staging 로그부터 봅니다");
    })();
    const toggles = togglePeer(page, { cycles: 3 });
    await Promise.all([typing, toggles]);
  });
  await clearInput(page);
  await wait(1_200);

  // D. 줄이 느는 입력: 높이는 바뀌어도 된다. 다만 목록은 바닥에 붙어 있어야 한다(gap 0).
  await record("D 줄 늘기", async () => {
    await typeText(page, "첫 줄입니다", 30);
    await page.keyboard.press("Shift+Enter");
    await typeText(page, "둘째 줄입니다", 30);
    await page.keyboard.press("Shift+Enter");
    await typeText(page, "셋째 줄입니다", 30);
  });
  await clearInput(page);
  await wait(600);

  // E. owner 장면 그대로: 긴 글이 창 폭에서 접혀 두세 줄이 되는 동안 상대 표시가 켜지고 꺼진다.
  await record("E 긴 글+표시", async () => {
    const typing = typeText(page, LONG_DRAFT, 35);
    const toggles = togglePeer(page, { cycles: 4, ttlMs: 700, gapMs: 1_300 });
    await Promise.all([typing, toggles]);
  });
  await clearInput(page);
  await wait(600);

  if (measureOnly) {
    // 메커니즘을 React 밖에서 바로 재 본다: 3줄 초안 · 바닥 gap 0 에서 입력창을 `height:auto`로 접고 `scrollHeight`를
    // 읽은 뒤(강제 레이아웃) 높이를 되돌린다. 옛 `useAutoGrow`가 키마다 하던 일 그대로다.
    await typeText(page, "하나", 10);
    await page.keyboard.press("Shift+Enter");
    await typeText(page, "둘", 10);
    await page.keyboard.press("Shift+Enter");
    await typeText(page, "셋", 10);
    await wait(400);
    const probe = await page.evaluate(async () => {
      const scroller = document.querySelector('[data-testid="chat-timeline"] [data-virtuoso-scroller]');
      const input = document.querySelector('[data-testid="composer-input"]');
      scroller.scrollTop = scroller.scrollHeight;
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      const fixed = input.style.height;
      const before = { top: scroller.scrollTop, gap: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight };
      input.style.height = "auto";
      void input.scrollHeight;
      input.style.height = fixed;
      const sameTask = scroller.scrollTop;
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      return {
        fixed,
        before,
        sameTask,
        after: { top: scroller.scrollTop, gap: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight },
      };
    });
    console.log(`[${engine} ${viewport.width}x${viewport.height}] mechanism ${JSON.stringify(probe)}`);
    await clearInput(page);
  }

  await context.close();
  return results.map((entry) => ({ engine, viewport: `${viewport.width}x${viewport.height}`, ...entry }));
}

function judge(all) {
  const failures = [];
  for (const entry of all) {
    const { summary, engine, viewport } = entry;
    const where = `${engine} ${viewport} ${summary.label}`;
    if (summary.label.startsWith("D") || summary.label.startsWith("E")) {
      // 줄이 늘면 입력창이 자라고 목록은 그만큼 위로 간다(scrollTop 증가, 정상). 줄어드는 것은 목록이 입력창 뒤로
      // 내려앉은 것이고, 다음 줄에서 다시 붙으면 owner가 본 위아래 왕복이 된다.
      if (summary.drops !== 0) {
        failures.push(
          `${where}: 입력하는 동안 목록이 ${summary.drops}번 내려앉았다(최대 ${summary.maxDrop}px). 맨 아래에 붙은 목록은 입력창이 자랄 때 위로만 가야 한다`
        );
      }
      if (summary.finalGap > 1) {
        failures.push(`${where}: 입력을 마친 뒤 목록이 바닥에서 ${summary.finalGap}px 떨어져 마지막 줄이 입력창 뒤에 가렸다`);
      }
      if (summary.inputHeights.length < 2) {
        failures.push(`${where}: 줄이 늘지 않았다(시험이 장면을 못 만들었다) ${JSON.stringify(summary.inputHeights)}`);
      }
      if (summary.label.startsWith("E") && summary.typingFrames === 0) {
        failures.push(`${where}: 상대 「작성 중」이 한 번도 그려지지 않았다(시험이 장면을 못 만들었다)`);
      }
      continue;
    }
    if (summary.scrollEvents !== 0 || summary.scrollTops.length !== 1) {
      failures.push(
        `${where}: 맨 아래에 붙은 목록의 scrollTop이 움직였다 (scroll 이벤트 ${summary.scrollEvents}회, 값 ${JSON.stringify(summary.scrollEventTops)})`
      );
    }
    if (summary.lastBottomSpread !== 0) {
      failures.push(`${where}: 마지막 행의 바닥이 ${summary.lastBottomSpread}px 흔들렸다 ${JSON.stringify(summary.lastBottoms)}`);
    }
    if (summary.inputHeights.length !== 1 || summary.distinctHeightWrites.length > 1) {
      failures.push(
        `${where}: 한 줄 입력인데 입력창 높이가 바뀌었다 (그려진 ${JSON.stringify(summary.inputHeights)}, 쓴 값 ${JSON.stringify(summary.distinctHeightWrites)})`
      );
    }
    if (summary.dockHeights.length !== 1) {
      failures.push(`${where}: 입력 독 높이가 바뀌었다 ${JSON.stringify(summary.dockHeights)}`);
    }
    if (summary.label.startsWith("B") || summary.label.startsWith("C")) {
      if (summary.typingFrames === 0) failures.push(`${where}: 상대 「작성 중」이 한 번도 그려지지 않았다(시험이 장면을 못 만들었다)`);
    }
  }
  return failures;
}

async function main() {
  const server = await startGuardedPreview({
    webRoot,
    port,
    portEnvVar: "TYPING_JITTER_PORT",
    extraArgs: distOverride ? ["--outDir", resolve(distOverride)] : [],
  });
  const all = [];
  try {
    for (const name of engineNames) {
      const type = name === "webkit" ? webkit : name === "chromium" ? chromium : null;
      if (type === null) throw new Error(`모르는 엔진: ${name}`);
      const browser = await type.launch({ headless: true });
      try {
        await printEngineAnchorHeader(browser, name);
        for (const viewport of viewports) {
          all.push(...(await runScenario(browser, name, viewport)));
        }
      } finally {
        await browser.close();
      }
    }
  } finally {
    await server.stop();
  }

  for (const entry of all) {
    console.log(`[${entry.engine} ${entry.viewport}] ${JSON.stringify(entry.summary)}`);
  }
  if (outDir !== null) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(resolve(outDir, "typing-jitter.json"), JSON.stringify(all, null, 1));
    console.log(`프레임 기록: ${resolve(outDir, "typing-jitter.json")}`);
  }
  if (measureOnly) return;
  const failures = judge(all);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    process.exit(1);
  }
  console.log(`PASS typing-jitter: ${engineNames.join("·")} × ${viewports.length}폭, 목록 흔들림 0 · 한 줄 입력창 높이 변화 0`);
}

await main();
