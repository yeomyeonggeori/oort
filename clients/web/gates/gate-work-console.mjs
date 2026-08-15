#!/usr/bin/env node
// GATE: #1289 workspace-wide Work Console.
//
// Fixture-only, no backend or credentials. It locks the product contract rather
// than a screenshot: `/work` is a global route, T1/T2/T3 come only from the
// referenced host.type, state and location remain separate text chips, the
// selected session survives in `?session=`, and the narrow layout swaps list
// for the exact existing WorkSessionDetail/ObserverTerminal.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.WORK_CONSOLE_GATE_PORT || 5192);
const origin = `http://127.0.0.1:${port}`;
const captureShots = process.env.WORK_CONSOLE_GATE_SHOTS === "1";
const shotsDir = resolve(webRoot, "artifacts/work-console");
const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const otherMemberId = "00000000-0000-7000-8000-000000000102";
const channelId = "00000000-0000-7000-8000-000000000201";
// The hosts the two observation fixtures "dial". Their sockets are the ones
// GateWebSocket never opens, which is the only way to hold a surface in 연결 중
// long enough to leave it by a door the socket does not know about. They are
// named apart so a failure says WHICH surface hung.
const displaySignalHost = "display-gate.invalid";
const terminalAttachHost = "terminal-gate.invalid";
const holdHosts = [displaySignalHost, terminalAttachHost];
// The host the 보는 중 fixture dials, deliberately NOT in `holdHosts`: this is
// the one socket in the gate that opens and then speaks, because a screen a
// person is actually watching is a state no hanging socket can reach.
const displayLiveHost = "display-live-gate.invalid";

const auth = {
  accessToken: "gate-only-not-a-credential",
  refreshToken: "gate-only-not-a-credential",
  member: {
    id: memberId,
    workspaceId,
    kind: "human",
    displayName: "곽성재",
    handle: "seongjae",
  },
  realtimeWebSocketUrl: "ws://work-console-gate.invalid/connection/websocket",
};

const channel = {
  id: channelId,
  workspaceId,
  kind: "public",
  name: "agent-runtime",
  muted: false,
};

const roster = [
  {
    id: memberId,
    workspaceId,
    kind: "human",
    status: "active",
    role: "owner",
    displayName: "곽성재",
    handle: "seongjae",
    channelCount: 1,
    channelIds: [channelId],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  },
  {
    id: otherMemberId,
    workspaceId,
    kind: "human",
    status: "active",
    role: "member",
    displayName: "김서연",
    handle: "seoyeon",
    channelCount: 1,
    channelIds: [channelId],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  },
];

const now = Date.now();
const hostIds = {
  app: "00000000-0000-7000-8000-000000000301",
  workd: "00000000-0000-7000-8000-000000000302",
  cloud: "00000000-0000-7000-8000-000000000303",
  unknown: "00000000-0000-7000-8000-000000000304",
};

function host(id, type, displayName, ownerMemberId = memberId) {
  return {
    id,
    workspaceId,
    scope: "member",
    ownerMemberId,
    type,
    displayName,
    capabilities: { terminal: true },
    lastSeenAtMs: now,
    createdAtMs: now - 60_000,
    online: true,
  };
}

const hosts = [
  // 다른 멤버의 app도 workspace 목록에 보인다. viewer-relative한 "이 기기"라
  // 부르면 안 된다는 회귀를 이 픽스처가 잠근다.
  host(hostIds.app, "app", "서연의 MacBook", otherMemberId),
  host(hostIds.workd, "workd", "개발실 워크스테이션"),
  host(hostIds.cloud, "cloud", "oort Cloud 서울"),
  host(hostIds.unknown, "edge-preview", "실험 호스트"),
];

function workSession(
  idSuffix,
  hostId,
  label,
  status = "running",
  remoteDisplayAvailable = false
) {
  return {
    id: `00000000-0000-7000-8000-0000000004${idSuffix}`,
    workspaceId,
    channelId,
    memberId,
    hostId,
    rootMessageId: `00000000-0000-7000-8000-0000000005${idSuffix}`,
    tool: "codex",
    label,
    status,
    observation: "open",
    observerGrantCount: 0,
    remoteAttachAvailable: true,
    remoteDisplayAvailable,
    startedAtMs: now - Number(idSuffix) * 60_000,
  };
}

const sessions = [
  workSession("01", hostIds.app, "데스크톱 앱에서 UI 검수"),
  workSession("02", hostIds.workd, "셀프호스트에서 테스트"),
  // The one session with BOTH surfaces (LIVE-2 / ADR-0165). The two server
  // facts are independent, so the console must draw both blocks side by side
  // rather than making the reader choose between them.
  workSession("03", hostIds.cloud, "클라우드에서 빌드", "running", true),
  workSession("04", hostIds.unknown, "알 수 없는 위치 확인", "idle"),
];

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

async function installRealtimeSocket(page) {
  await page.addInitScript((hangingHosts) => {
    // React Query decides staleness from Date.now(). Advancing this gate clock
    // lets the gate prove a cached refetch failure without sleeping for the
    // production 30s/60s stale windows.
    const actualNow = Date.now.bind(Date);
    let clockOffsetMs = 0;
    Date.now = () => actualNow() + clockOffsetMs;
    window.__workConsoleGateAdvanceTime = (byMs) => {
      clockOffsetMs += byMs;
    };

    // A live count of the listeners the app has left on the DOCUMENT for the one
    // event a WebSocket cannot raise about itself: the page's own CSP refusing
    // the dial. `document` outlives every component, so a listener that misses
    // its cleanup is not visible anywhere in the UI — it just accumulates, one
    // per retry and per session switch, for as long as the tab is open. The Set
    // counts identities rather than calls, so a cleanup that runs twice is not
    // mistaken for a listener that was never there.
    const cspListeners = new Set();
    const addListener = document.addEventListener.bind(document);
    const removeListener = document.removeEventListener.bind(document);
    document.addEventListener = function (type, listener, options) {
      if (type === "securitypolicyviolation") cspListeners.add(listener);
      return addListener(type, listener, options);
    };
    document.removeEventListener = function (type, listener, options) {
      if (type === "securitypolicyviolation") cspListeners.delete(listener);
      return removeListener(type, listener, options);
    };
    window.__workConsoleGateCspListeners = () => cspListeners.size;

    class GateWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;

      constructor(url) {
        this.url = String(url);
        this.readyState = GateWebSocket.CONNECTING;
        // The observation fixtures' sockets never settle: they do not open and
        // they do not close themselves. That is the whole point — it is the
        // state in which a surface's own cleanup has nothing to run it.
        if (hangingHosts.some((host) => this.url.includes(host))) return;
        queueMicrotask(() => {
          this.readyState = GateWebSocket.OPEN;
          this.onopen?.(new Event("open"));
        });
      }

      send(data) {
        const replies = String(data)
          .trim()
          .split("\n")
          .map((line) => {
            const command = JSON.parse(line);
            if (command.connect) {
              return {
                id: command.id,
                connect: { client: "work-console-gate", version: "6" },
              };
            }
            if (command.subscribe) {
              return {
                id: command.id,
                subscribe: {
                  recoverable: true,
                  positioned: true,
                  recovered: false,
                  epoch: "work-console-gate",
                  offset: 0,
                },
              };
            }
            return { id: command.id };
          });
        queueMicrotask(() => {
          this.onmessage?.(
            new MessageEvent("message", {
              data: replies.map((reply) => JSON.stringify(reply)).join("\n"),
            })
          );
        });
      }

      close() {
        this.readyState = GateWebSocket.CLOSED;
        this.onclose?.(new CloseEvent("close", { code: 1000 }));
      }
    }
    window.WebSocket = GateWebSocket;
  }, holdHosts);
}

// The producer's half of the display signalling contract, plus a peer
// connection that decodes something. Installed only for the 보는 중 fixture.
//
// WHY A STUB AND NOT A SANDBOX. 보는 중 is the state this surface exists for,
// and it is the one state that needs a real browser-to-microVM negotiation to
// reach — which is the spike (#1411), not this gate. But nothing the BLOCK
// draws is a fact about WebRTC: it comes from four things `DisplayObserver`
// reads through `window` — the producer's `ready`/`offer` frames,
// `connectionState`, `getStats()`, and the track it is handed. So the fixture
// supplies those four and the component renders exactly what a watching reader
// would see, with no change to the component to make it stubbable.
//
// THE SCREEN IS A REAL VIDEO TRACK (a canvas `captureStream`), because a black
// pane would prove nothing about the thing the pane promises. It is 4:3 on
// purpose: 16:9 content would fill the frame edge to edge and make
// `object-contain` unfalsifiable, and letterboxing is the specific guarantee
// there — a cropped screen is a screen with the agent's work hidden off its
// edge.
async function installDisplayProducer(page, liveHost) {
  await page.addInitScript((host) => {
    // Minimal SDP: one sendonly video m-line and NO `m=application`, which is
    // what `sdpCarriesVideo` and `sdpNegotiatesInput` are reading. An offer
    // that negotiated a datachannel is a different fixture (the client refuses
    // it), and it must stay that way here or this capture would be a photograph
    // of a broken guarantee.
    const OFFER_SDP = [
      "v=0",
      "o=- 4611731400430051336 2 IN IP4 127.0.0.1",
      "s=-",
      "t=0 0",
      "m=video 9 UDP/TLS/RTP/SAVPF 96",
      "c=IN IP4 0.0.0.0",
      "a=mid:0",
      "a=sendonly",
      "a=rtpmap:96 VP8/90000",
      "",
    ].join("\r\n");
    const ANSWER_SDP = OFFER_SDP.replace("a=sendonly", "a=recvonly");

    const BaseSocket = window.WebSocket;
    class GateProducerSocket extends BaseSocket {
      constructor(url, protocols) {
        super(url, protocols);
        this.gateIsProducer = String(url).includes(host);
        if (!this.gateIsProducer) return;
        // The base class opens on a microtask, so this queues behind it: the
        // frames have to arrive on a socket the component has already seen
        // open, which is also where it arms the negotiate deadline they satisfy.
        queueMicrotask(() =>
          queueMicrotask(() => {
            this.gateEmit({
              type: "ready",
              display_id: "gate-display-1",
              mode: "observer",
              input_enabled: false,
            });
            this.gateEmit({ type: "offer", sdp: OFFER_SDP });
          })
        );
      }

      gateEmit(frame) {
        this.onmessage?.(
          new MessageEvent("message", { data: JSON.stringify(frame) })
        );
      }

      send(data) {
        // A producer does not reply to its viewer. Everything this socket
        // carries outbound (`answer`, this browser's `ice`, `bye`) is accepted
        // and dropped, which is what the real one does with all but the first.
        if (this.gateIsProducer) return;
        return super.send(data);
      }
    }
    window.WebSocket = GateProducerSocket;

    // A stand-in host desktop that is obviously a fixture and obviously moving.
    // Moving matters twice over: `framesDecoded` is the component's liveness
    // claim, and a still canvas would let a browser that never decoded anything
    // look identical to one that did.
    const mockScreen = () => {
      const canvas = document.createElement("canvas");
      canvas.width = 1024;
      canvas.height = 768;
      const ctx = canvas.getContext("2d");
      let tick = 0;
      const paint = () => {
        tick += 1;
        ctx.fillStyle = "#0b1220";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "#111c2e";
        ctx.fillRect(48, 48, canvas.width - 96, canvas.height - 96);
        ctx.fillStyle = "#1c2b44";
        ctx.fillRect(48, 48, canvas.width - 96, 56);
        ctx.fillStyle = "#dbe7f5";
        ctx.font = "26px monospace";
        ctx.fillText("gate fixture screen", 76, 86);
        ctx.font = "22px monospace";
        ctx.fillStyle = "#8fa6c4";
        [
          "$ codex run --session gate",
          "building workspace...",
          "tests 12/12",
          "waiting for host",
        ].forEach((line, index) => ctx.fillText(line, 84, 170 + index * 40));
        ctx.fillStyle = "#4ea3f0";
        ctx.fillRect(84, 380, ((tick * 28) % (canvas.width - 220)) + 24, 14);
      };
      paint();
      const timer = window.setInterval(paint, 200);
      return {
        stream: canvas.captureStream(10),
        stop: () => window.clearInterval(timer),
      };
    };

    class GatePeerConnection {
      constructor() {
        this.connectionState = "new";
        this.iceConnectionState = "new";
        this.ontrack = null;
        this.onicecandidate = null;
        this.onconnectionstatechange = null;
        this.gateScreen = null;
        this.gateFrames = 0;
        this.gateBytes = 0;
        this.gateClosed = false;
      }

      async setRemoteDescription() {}

      async createAnswer() {
        return { type: "answer", sdp: ANSWER_SDP };
      }

      async setLocalDescription() {
        if (this.gateClosed) return;
        // The track first, then the state that makes the surface claim to be
        // live. That order is the whole point: 보는 중 over an empty pane is the
        // frozen-picture lie the component was written against.
        this.gateScreen = mockScreen();
        this.ontrack?.({
          streams: [this.gateScreen.stream],
          track: this.gateScreen.stream.getVideoTracks()[0],
        });
        this.connectionState = "connected";
        this.onconnectionstatechange?.(new Event("connectionstatechange"));
      }

      async addIceCandidate() {}

      async getStats() {
        // Forwards only, which is the one property the liveness model reads:
        // a counter that moves is what separates a live stream from a
        // connection that merely reports `connected`.
        this.gateFrames += 24;
        this.gateBytes += 96_000;
        return new Map([
          [
            "gate-inbound-video",
            {
              type: "inbound-rtp",
              kind: "video",
              framesDecoded: this.gateFrames,
              bytesReceived: this.gateBytes,
            },
          ],
        ]);
      }

      close() {
        this.gateClosed = true;
        this.gateScreen?.stop();
        this.gateScreen = null;
      }
    }
    window.RTCPeerConnection = GatePeerConnection;
  }, liveHost);
}

async function installRoutes(context, state) {
  await context.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") {
      return json(route, {
        accessToken: auth.accessToken,
        refreshToken: auth.refreshToken,
      });
    }
    if (path === "/v1/auth/realtime-token") {
      return json(route, {
        token: "gate-realtime-token",
        tokenType: "Bearer",
        // The cached-refetch test advances the browser clock by more than one
        // host stale window. Keep the fixture token out of that test's way.
        expiresAtMs: Date.now() + 600_000,
        ttlSeconds: 60,
        workspaceId,
        memberId,
      });
    }
    if (path.endsWith("/channels")) {
      await wait(state.channelDelayMs ?? 0);
      return state.failChannels
        ? json(route, { error: { message: "fixture channel failure" } }, 500)
        : json(route, { channels: [channel] });
    }
    if (path.endsWith("/roster")) {
      await wait(state.rosterDelayMs ?? 0);
      return state.failRoster
        ? json(route, { error: { message: "fixture roster failure" } }, 500)
        : json(route, { members: roster });
    }
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-sessions")) {
      await wait(state.sessionDelayMs ?? 0);
      if (state.mode === "error" || state.failSessions) {
        return json(route, { error: { message: "fixture failure" } }, 500);
      }
      return json(route, {
        workSessions: state.mode === "empty" ? [] : sessions,
      });
    }
    if (path.endsWith("/work-hosts")) {
      await wait(state.hostDelayMs ?? 0);
      return state.failHosts
        ? json(route, { error: { message: "fixture host failure" } }, 500)
        : json(route, { workHosts: hosts });
    }
    if (path.endsWith("/terminal-attach")) {
      // The observer grade and an endpoint the client's own grammar accepts
      // (wss, no credentials, no query, a pty id that matches the server's).
      // Nothing is dialled: the socket that would carry this is the gate's stub.
      return json(route, {
        attach_endpoint: `wss://${terminalAttachHost}/attach`,
        capability_token: "gate-only-not-a-credential",
        pty_id: "pty-gate-1",
      });
    }
    if (path.endsWith("/display-attach")) {
      // A capability call that is accepted and never answered. It is a real
      // state — a server still deciding — and it is the only way to hold
      // 화면 보기 권한을 받는 중 still long enough to photograph it. The pending
      // handler dies with the context that installed it.
      if (state.hangDisplayAttach) return new Promise(() => {});
      // The display route's own 409: this session has no screen to hand out
      // (`classifyDisplayGrantFailure`), which is the failure the reader lands
      // on rather than one they have to break something to see.
      if (state.displayAttachStatus) {
        return json(
          route,
          { error: { message: "fixture display unavailable" } },
          state.displayAttachStatus
        );
      }
      // The grade the client is allowed to render, and an endpoint its own
      // grammar accepts (wss, no credentials, no query). Nothing is dialled: the
      // socket that would carry this is the gate's own stub — except in the
      // watching fixture, whose stub answers on `displayLiveHost`.
      return json(route, {
        display_endpoint: `wss://${
          state.displayLive ? displayLiveHost : displaySignalHost
        }/signal`,
        capability_token: "gate-only-not-a-credential",
        display_id: "gate-display-1",
        mode: "observer",
      });
    }
    if (path.includes("/messages/") && path.endsWith("/replies")) {
      return json(route, { messages: [] });
    }
    return json(route, {});
  });
}

async function waitForServer() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(origin)).ok) return;
    } catch {
      // Preview is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
  throw new Error("preview server never came up");
}

async function openConsole(context, { displayProducer = false } = {}) {
  const page = await context.newPage();
  await installRealtimeSocket(page);
  // After the realtime stub, never before: the producer socket subclasses
  // whatever `window.WebSocket` is by then, and installing it first would make
  // it the class the realtime stub overwrites.
  if (displayProducer) await installDisplayProducer(page, displayLiveHost);
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  const submit = page.getByTestId("login-submit");
  await submit.waitFor({ timeout: 30_000 });
  await page.getByTestId("login-email").fill("gate@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await submit.click();
  await page.getByTestId("nav-work-console").waitFor();
  await page.getByTestId("nav-work-console").click();
  await page.getByTestId("work-console-route").waitFor();
  return page;
}

async function assertFocus(page, selector) {
  await page.waitForFunction(
    (expectedSelector) => {
      const active = document.activeElement;
      return active instanceof HTMLElement && active.matches(expectedSelector);
    },
    selector
  );
}

async function remountSelectedConsole(page, sessionId, advanceMs) {
  await page.getByTestId("nav-activity").click();
  await page.getByTestId("nav-work-console").waitFor();
  await page.evaluate(
    ({ selectedId, byMs }) => {
      window.__workConsoleGateAdvanceTime(byMs);
      window.location.hash = `#/work?session=${selectedId}`;
    },
    { selectedId: sessionId, byMs: advanceMs }
  );
  await page.getByTestId("work-console-route").waitFor();
}

async function assertCachedRefetchFailure(page, state, kind) {
  const isHost = kind === "host";
  if (isHost) state.failHosts = true;
  else state.failSessions = true;
  await remountSelectedConsole(
    page,
    sessions[2].id,
    isHost ? 61_000 : 31_000
  );
  const warning = page.getByTestId("work-console-stale-error");
  await warning.waitFor({ timeout: 10_000 });
  const expectedCopy = isHost
    ? "실행 위치를 새로 확인하지 못했습니다. 마지막 호스트 정보를 표시합니다."
    : "작업 세션을 새로 확인하지 못했습니다. 마지막 목록을 표시합니다.";
  if ((await warning.textContent())?.includes(expectedCopy) !== true) {
    throw new Error(`${kind} cached refetch warning did not name the stale projection`);
  }
  if ((await page.getByTestId("work-console-row").count()) !== 4) {
    throw new Error(`${kind} cached refetch failure erased the master rows`);
  }
  await page.getByTestId("work-detail").waitFor();
  if (!page.url().includes(`session=${sessions[2].id}`)) {
    throw new Error(`${kind} cached refetch failure lost the selected detail`);
  }

  if (isHost) state.failHosts = false;
  else state.failSessions = false;
  await warning.getByText("다시 시도", { exact: true }).click();
  await warning.waitFor({ state: "detached", timeout: 10_000 });
}

async function assertConsole(context, state) {
  const page = await openConsole(context);
  const skeletons = page.getByTestId("skeleton-row");
  await skeletons.first().waitFor();
  if ((await page.getByTestId("work-console-count").count()) !== 0) {
    throw new Error("initial loading rendered a settled session count");
  }
  const rows = page.getByTestId("work-console-row");
  await rows.first().waitFor();
  // The rest of the gate is about transitions, not artificial latency.
  state.sessionDelayMs = 0;
  state.hostDelayMs = 0;
  if ((await rows.count()) !== 4) {
    throw new Error(`workspace master list rendered ${await rows.count()} rows`);
  }

  const labels = await page
    .getByTestId("work-console-location")
    .allTextContents();
  const expected = [
    "T1 · 데스크톱 앱",
    "T2 · 셀프호스트",
    "T3 · 클라우드",
    "실행 위치 확인 필요",
  ];
  for (const label of expected) {
    if (!labels.some((value) => value.trim() === label)) {
      throw new Error(`location label missing: ${label} in ${JSON.stringify(labels)}`);
    }
  }
  for (const [sessionLabel, expectedHost] of [
    ["데스크톱 앱에서 UI 검수", "서연의 MacBook"],
    ["셀프호스트에서 테스트", "개발실 워크스테이션"],
    ["클라우드에서 빌드", "oort Cloud 서울"],
    ["알 수 없는 위치 확인", "실험 호스트"],
  ]) {
    const hostLabel = rows
      .filter({ hasText: sessionLabel })
      .getByTestId("work-console-host");
    if ((await hostLabel.textContent())?.trim() !== expectedHost) {
      throw new Error(`host identity drifted for ${sessionLabel}`);
    }
    const clipped = await hostLabel.evaluate(
      (element) => element.scrollWidth > element.clientWidth + 1
    );
    if (clipped) {
      throw new Error(`host identity is clipped at the default width: ${expectedHost}`);
    }
  }
  const cloudBadge = page.locator(
    '[data-testid="work-console-location"][data-location="t3"]'
  );
  if (
    (await cloudBadge.count()) !== 1 ||
    (await cloudBadge.locator("svg.lucide-cloud").count()) !== 1
  ) {
    throw new Error("T3 cloud tag lost its data marker or cloud SVG icon");
  }
  const sameElement = await rows.first().evaluate((row) => {
    const status = row.querySelector('[data-testid="work-console-status"]');
    const location = row.querySelector('[data-testid="work-console-location"]');
    return status === location;
  });
  if (sameElement) throw new Error("session state and execution location collapsed into one chip");
  const firstMeta = (await rows.first().getByTestId("work-console-meta").textContent())?.trim();
  if (firstMeta !== "#agent-runtime · 곽성재 · codex") {
    throw new Error(`session who/what meta drifted: ${firstMeta}`);
  }
  for (const meta of await page.getByTestId("work-console-meta").all()) {
    const clipped = await meta.evaluate(
      (element) => element.scrollWidth > element.clientWidth + 1
    );
    if (clipped) {
      throw new Error("channel, owner, or tool metadata is clipped at the default width");
    }
  }
  const firstTime = (
    await rows.first().getByTestId("work-console-time").textContent()
  )?.trim();
  if (!/^시작 \d{2}:\d{2}$/.test(firstTime ?? "")) {
    throw new Error(`session time is not an explicit known timestamp: ${firstTime}`);
  }
  const idleTime = (
    await rows
      .filter({ hasText: "알 수 없는 위치 확인" })
      .getByTestId("work-console-time")
      .textContent()
  )?.trim();
  if (!/^시작 \d{2}:\d{2}$/.test(idleTime ?? "")) {
    throw new Error(`idle session time is not a stable start timestamp: ${idleTime}`);
  }

  await rows.filter({ hasText: "클라우드에서 빌드" }).click();
  await page.getByTestId("work-detail").waitFor();
  const headingOutline = await page
    .getByTestId("work-console-route")
    .locator("h1, h2, h3, h4, h5, h6")
    .evaluateAll((headings) =>
      headings.map((heading) => ({
        level: Number(heading.tagName.slice(1)),
        text: heading.textContent?.trim() ?? "",
      }))
    );
  const expectedHeadingOutline = [
    { level: 1, text: "작업 콘솔" },
    { level: 2, text: "클라우드에서 빌드" },
    { level: 3, text: "터미널 관전" },
    { level: 3, text: "라이브 화면" },
  ];
  if (JSON.stringify(headingOutline) !== JSON.stringify(expectedHeadingOutline)) {
    throw new Error(
      `route detail heading outline is not h1 -> h2 -> h3: ${JSON.stringify(
        headingOutline
      )}`
    );
  }
  const observer = page.getByTestId("work-observer");
  await observer.waitFor();
  const readOnly = observer.getByTestId("work-observer-readonly");
  if ((await readOnly.textContent())?.trim() !== "읽기 전용") {
    throw new Error("observer detail does not state that the terminal is read-only");
  }
  const readOnlyTitle = (await readOnly.getAttribute("title")) ?? "";
  for (const denied of ["입력", "크기 조절", "종료"]) {
    if (!readOnlyTitle.includes(denied)) {
      throw new Error(`read-only title does not deny ${denied}`);
    }
  }
  const controllerInputs = observer.locator(
    'input, textarea, [contenteditable="true"], [data-testid*="controller"], [data-testid*="stdin"], [data-testid*="resize"], [data-testid*="kill"]'
  );
  if ((await controllerInputs.count()) !== 0) {
    throw new Error("observer-only terminal exposed a controller/input control");
  }

  // 라이브 화면 (LIVE-2 / ADR-0165), on the same session as the terminal and
  // beside it. What the gate checks here is what a person would check: that the
  // surface says it cannot be typed into, and that there is nothing on it that
  // could type.
  const display = page.getByTestId("work-display");
  await display.waitFor();
  const displayReadOnly = display.getByTestId("work-display-readonly");
  if ((await displayReadOnly.textContent())?.trim() !== "보기 전용") {
    throw new Error("display detail does not state that the screen is view-only");
  }
  const displayReadOnlyTitle = (await displayReadOnly.getAttribute("title")) ?? "";
  for (const denied of ["키보드", "마우스", "저장"]) {
    if (!displayReadOnlyTitle.includes(denied)) {
      throw new Error(`view-only title does not deny ${denied}`);
    }
  }
  // ADR-0004 증보 3 D1: control is not 인수, and the word must not appear.
  if (((await display.textContent()) ?? "").includes("인수")) {
    throw new Error("the display surface used the word 인수");
  }
  if (!(await display.getByTestId("work-display-start").isVisible())) {
    throw new Error("a session with a published screen offered no way to open it");
  }
  const displayInputs = display.locator(
    'input, textarea, [contenteditable="true"], video[controls], [data-testid*="controller"], [data-testid*="input"], [data-testid*="keyboard"]'
  );
  if ((await displayInputs.count()) !== 0) {
    throw new Error("view-only display exposed a control that could send input");
  }

  if (!page.url().includes(`session=${sessions[2].id}`)) {
    throw new Error(`selected session did not enter the URL: ${page.url()}`);
  }
  // This is a destination, not component memory: reloading the copied address
  // must recover the same detail from the server projection.
  await page.reload();
  await page.getByTestId("work-detail").waitFor();
  const reloadedLocation = (
    await page
      .getByTestId("work-console-detail-location")
      .getByTestId("work-console-location")
      .textContent()
  )?.trim();
  if (reloadedLocation !== "T3 · 클라우드") {
    throw new Error(`direct session link recovered ${reloadedLocation}`);
  }
  if (!(await page.getByTestId("work-console-list").isVisible())) {
    throw new Error("desktop detail replaced the master list instead of standing beside it");
  }

  const consoleLayout = page.locator(".work-console-layout");
  const detailPane = page.locator("[data-work-console-detail]");
  const defaultDetailWidth = await detailPane.evaluate(
    (element) => element.getBoundingClientRect().width
  );
  const wideToggle = page.getByTestId("work-console-detail-wide");
  if (
    (await wideToggle.getAttribute("aria-label")) !== "세션 상세 넓게 보기" ||
    (await wideToggle.getAttribute("title")) !== "상세 넓게 보기" ||
    (await wideToggle.getAttribute("aria-controls")) !==
      "work-console-session-list"
  ) {
    throw new Error("work console detail focus action is not named truthfully");
  }
  await observer.evaluate((element) => {
    window.__workConsoleObserverNode = element;
    element.dataset.gateMountMarker = "before-wide";
  });
  await wideToggle.click();
  await page.waitForFunction(() => {
    const layout = document.querySelector(".work-console-layout");
    return layout instanceof HTMLElement && layout.hasAttribute("data-detail-wide");
  });
  if (await page.getByTestId("work-console-list").isVisible()) {
    throw new Error("detail focus mode left the session master visible");
  }
  const focusedDetailWidth = await detailPane.evaluate(
    (element) => element.getBoundingClientRect().width
  );
  if (focusedDetailWidth < defaultDetailWidth + 250) {
    throw new Error(
      `detail focus recovered too little width: ${defaultDetailWidth} -> ${focusedDetailWidth}`
    );
  }
  if (
    (await consoleLayout.getAttribute("data-detail-wide")) === null ||
    (await wideToggle.getAttribute("aria-pressed")) !== "true" ||
    (await wideToggle.getAttribute("aria-label")) !== "세션 상세 넓게 보기" ||
    (await wideToggle.getAttribute("title")) !== "세션 목록 보이기"
  ) {
    throw new Error("detail focus state is not exposed to assistive technology");
  }
  if (!page.url().includes(`session=${sessions[2].id}`)) {
    throw new Error("detail focus mode discarded the selected session URL");
  }
  if (!(await readOnly.isVisible())) {
    throw new Error("detail focus mode replaced the observer terminal");
  }
  const observerRemounted = await observer.evaluate(
    (element) =>
      window.__workConsoleObserverNode !== element ||
      element.dataset.gateMountMarker !== "before-wide"
  );
  if (observerRemounted) {
    throw new Error("detail focus remounted the observer terminal subtree");
  }
  if (captureShots) {
    mkdirSync(shotsDir, { recursive: true });
    await page.screenshot({
      path: resolve(shotsDir, "console-detail-focus-light.png"),
      fullPage: false,
    });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(220);
    await page.screenshot({
      path: resolve(shotsDir, "console-detail-focus-dark.png"),
      fullPage: false,
    });
    await page.emulateMedia({ colorScheme: "light" });
    await page.waitForTimeout(220);
  }
  await page.goBack();
  await page.waitForFunction(() => !window.location.hash.includes("session="));
  await page.getByTestId("work-console-list").waitFor({ state: "visible" });
  await assertFocus(page, `a[data-session-id="${sessions[2].id}"]`);
  await rows.filter({ hasText: "클라우드에서 빌드" }).click();
  await page.getByTestId("work-detail").waitFor();
  const restoredWideToggle = page.getByTestId("work-console-detail-wide");
  if ((await restoredWideToggle.getAttribute("aria-pressed")) !== "false") {
    throw new Error("history back leaked detail focus into a fresh selection");
  }
  await restoredWideToggle.click();
  await restoredWideToggle.click();
  await page.getByTestId("work-console-list").waitFor({ state: "visible" });
  if ((await restoredWideToggle.getAttribute("aria-pressed")) !== "false") {
    throw new Error("restoring the session list did not release detail focus");
  }

  await assertCachedRefetchFailure(page, state, "host");
  await assertCachedRefetchFailure(page, state, "session");
  if (captureShots) {
    mkdirSync(shotsDir, { recursive: true });
    await page.screenshot({
      path: resolve(shotsDir, "console-wide-light.png"),
      fullPage: false,
    });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(220);
    await page.screenshot({
      path: resolve(shotsDir, "console-wide-dark.png"),
      fullPage: false,
    });
    await page.emulateMedia({ colorScheme: "light" });
    await page.waitForTimeout(220);
  }

  for (const [width, expectSplit] of [
    [900, true],
    [899, false],
  ]) {
    await page.setViewportSize({ width, height: 700 });
    await page.goto(`${origin}/#/work?session=${sessions[1].id}`);
    await page.getByTestId("work-detail").waitFor();
    const listVisible = await page.getByTestId("work-console-list").isVisible();
    const toggleVisible = await page
      .getByTestId("work-console-detail-wide")
      .isVisible();
    if (listVisible !== expectSplit || toggleVisible !== expectSplit) {
      throw new Error(
        `${width}px breakpoint drifted: list=${listVisible} toggle=${toggleVisible}`
      );
    }
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    );
    if (overflow) throw new Error(`${width}px work console created document overflow`);
  }

  await page.setViewportSize({ width: 760, height: 700 });
  await page.goto(`${origin}/#/work`);
  await page.getByTestId("work-console-list").waitFor();
  if (!(await page.getByTestId("work-console-list").isVisible())) {
    throw new Error("narrow console did not start on the session list");
  }
  if (captureShots) {
    await page.screenshot({
      path: resolve(shotsDir, "console-narrow-light.png"),
      fullPage: false,
    });
  }
  await page
    .getByTestId("work-console-row")
    .filter({ hasText: "셀프호스트에서 테스트" })
    .click();
  await page.getByTestId("work-detail").waitFor();
  if (await page.getByTestId("work-console-list").isVisible()) {
    throw new Error("narrow console kept the list beside the terminal detail");
  }
  if (await page.getByTestId("work-console-detail-wide").isVisible()) {
    throw new Error("narrow console exposed a focus action that cannot widen it further");
  }

  // This session has a terminal and no screen, which is a DIFFERENT sentence
  // from an error (LIVE-2 AC-4). It is checked here rather than beside the
  // cloud session's display block because switching rows up there would push
  // two history entries under the goBack the focus assertions depend on.
  const noScreen = (
    await page.getByTestId("work-display-blocked").textContent()
  )?.trim();
  if (!noScreen?.includes("호스트 화면을 열어 두지 않았습니다")) {
    throw new Error(`a session with no screen did not say so: ${noScreen}`);
  }
  if (await page.getByTestId("work-display-error").count()) {
    throw new Error("a session with no screen drew an error instead of a state");
  }
  if (await page.getByTestId("work-display-start").count()) {
    throw new Error("a session with no screen still offered to open one");
  }
  if (captureShots) {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(220);
    await page.screenshot({
      path: resolve(shotsDir, "console-narrow-dark.png"),
      fullPage: false,
    });
    await page.emulateMedia({ colorScheme: "light" });
    await page.waitForTimeout(220);
  }
  await page.getByTestId("work-detail-back").click();
  await page.getByTestId("work-console-list").waitFor({ state: "visible" });
  await assertFocus(page, `a[data-session-id="${sessions[1].id}"]`);

  await page.goto(`${origin}/#/work?session=not-a-session`);
  await page.getByTestId("work-console-not-found").waitFor();
  await page.getByTestId("work-console-not-found").getByText("목록으로").click();
  await page.getByTestId("work-console-list").waitFor({ state: "visible" });
  await assertFocus(page, `a[data-session-id="${sessions[0].id}"]`);

  await page.goto(`${origin}/#/work?session=${sessions[0].id}`);
  const offlineDetail = page.getByTestId("work-detail");
  await offlineDetail.waitFor();
  if ((await offlineDetail.getAttribute("data-live")) === null) {
    throw new Error("fixture detail never entered its live state");
  }
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  const cachedOffline = page.getByTestId("work-console-offline");
  await cachedOffline.waitFor();
  if (
    (await cachedOffline.textContent())?.includes(
      "아래는 마지막으로 확인된 작업 상태입니다."
    ) !== true
  ) {
    throw new Error("cached offline state did not name its last-known projection");
  }
  await page.waitForFunction(() => {
    const detail = document.querySelector('[data-testid="work-detail"]');
    return detail instanceof HTMLElement && !detail.hasAttribute("data-live");
  });
  await page.close();
}

async function assertTerminalState(browser, state, testId, expectedCopy = null) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    reducedMotion: "reduce",
  });
  try {
    await installRoutes(context, state);
    const page = await openConsole(context);
    const target = page.getByTestId(testId);
    await target.waitFor({ timeout: 10_000 });
    if (
      expectedCopy !== null &&
      (await target.textContent())?.includes(expectedCopy) !== true
    ) {
      throw new Error(`${testId} did not render expected copy: ${expectedCopy}`);
    }
  } finally {
    await context.close();
  }
}

async function assertMetadataFallback(
  browser,
  state,
  expectedMeta,
  expectedWarning
) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    reducedMotion: "reduce",
  });
  try {
    await installRoutes(context, state);
    const page = await openConsole(context);
    const firstMeta = page
      .getByTestId("work-console-row")
      .first()
      .getByTestId("work-console-meta");
    await firstMeta.waitFor({ timeout: 10_000 });
    const warning = page.getByTestId("work-console-metadata-error");
    await warning.waitFor({ timeout: 10_000 });
    if ((await warning.textContent())?.includes(expectedWarning) !== true) {
      throw new Error(
        `metadata failure warning did not name the failed projection: ${await warning.textContent()}`
      );
    }
    if ((await firstMeta.textContent())?.trim() !== expectedMeta) {
      throw new Error(
        `initial projection failure did not fail closed: ${await firstMeta.textContent()}`
      );
    }
  } finally {
    await context.close();
  }
}

// LIVE-2 leak floor. 연결 중 hangs a `securitypolicyviolation` listener on the
// document — the CSP refusal is the one way a dial can fail with no event on the
// socket at all — and the surface's teardown deletes the socket's own handlers
// before it closes it. So every exit that is not the socket settling leaves that
// listener behind unless teardown releases it itself, and a listener on the
// document survives the component, the session and the retry: it is invisible in
// the UI and it accumulates for the life of the tab.
//
// This runs in its own context because it navigates between sessions, which
// would push history entries under the goBack assertions in assertConsole.
async function assertDisplayConnectCleanup(browser) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    reducedMotion: "reduce",
  });
  try {
    await installRoutes(context, { mode: "normal" });
    const page = await openConsole(context);
    const rows = page.getByTestId("work-console-row");
    await rows.first().waitFor();
    await rows.filter({ hasText: "클라우드에서 빌드" }).click();
    await page.getByTestId("work-display").waitFor();

    const baseline = await page.evaluate(() =>
      window.__workConsoleGateCspListeners()
    );
    if (baseline !== 0) {
      throw new Error(
        `the console started with ${baseline} document CSP listeners already attached`
      );
    }

    await page.getByTestId("work-display-start").click();
    // The fixture socket never opens, so the surface stays here.
    await page
      .locator('[data-testid="work-display"][data-phase="connecting"]')
      .waitFor({ timeout: 10_000 });
    const attached = await page.evaluate(() =>
      window.__workConsoleGateCspListeners()
    );
    if (attached !== 1) {
      throw new Error(
        `연결 중 did not attach the CSP listener this gate measures (count ${attached})`
      );
    }

    // Leave by a door the socket does not know about: a different session in the
    // same mounted panel. Nothing fires on the socket, so only the surface's own
    // teardown can release the listener.
    await rows.filter({ hasText: "데스크톱 앱에서 UI 검수" }).click();
    await page.getByTestId("work-detail").waitFor();
    try {
      await page.waitForFunction(
        () => window.__workConsoleGateCspListeners() === 0,
        null,
        { timeout: 5_000 }
      );
    } catch {
      const leaked = await page.evaluate(() =>
        window.__workConsoleGateCspListeners()
      );
      throw new Error(
        `leaving 연결 중 by a session switch left ${leaked} document CSP listener(s) behind`
      );
    }
    if ((await page.getByTestId("work-display-video").count()) !== 0) {
      throw new Error("a torn-down attempt left its video frame on screen");
    }
  } finally {
    await context.close();
  }
}

// The same leak floor on the PTY surface, which has the identical shape: 연결 중
// hangs a `securitypolicyviolation` listener on the document — the CSP refusal
// is the one way a dial can fail with no event on the socket at all — and
// `closeSocket` deletes the socket's own handlers before it closes it. So the
// terminal's non-socket exits (the handshake deadline giving up, 관전 중단, the
// ledger revoking mid-handshake, a different session.id in the same mounted
// panel) fire nothing on the socket and can only release that listener
// themselves. A listener on the document outlives the component, the session and
// the retry: it is invisible in the UI and it accumulates for the life of the
// tab.
//
// Its own context: it navigates between sessions, which would push history
// entries under the goBack assertions in assertConsole.
async function assertObserverConnectCleanup(browser) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    reducedMotion: "reduce",
  });
  try {
    await installRoutes(context, { mode: "normal" });
    const page = await openConsole(context);
    const rows = page.getByTestId("work-console-row");
    await rows.first().waitFor();
    await rows.filter({ hasText: "클라우드에서 빌드" }).click();
    await page.getByTestId("work-observer").waitFor();

    const cspCount = () =>
      page.evaluate(() => window.__workConsoleGateCspListeners());
    const baseline = await cspCount();
    if (baseline !== 0) {
      throw new Error(
        `the console started with ${baseline} document CSP listeners already attached`
      );
    }

    await page.getByTestId("work-observer-start").click();
    // The fixture socket never opens, so the surface stays here.
    await page
      .locator('[data-testid="work-observer"][data-phase="connecting"]')
      .waitFor({ timeout: 10_000 });
    const attached = await cspCount();
    if (attached !== 1) {
      throw new Error(
        `연결 중 did not attach the CSP listener this gate measures (count ${attached})`
      );
    }

    // Leave by a door the socket does not know about: a different session in the
    // same mounted panel. Nothing fires on the socket, so only the surface's own
    // cleanup can release the listener.
    await rows.filter({ hasText: "데스크톱 앱에서 UI 검수" }).click();
    await page.getByTestId("work-detail").waitFor();
    try {
      await page.waitForFunction(
        () => window.__workConsoleGateCspListeners() === 0,
        null,
        { timeout: 5_000 }
      );
    } catch {
      throw new Error(
        `leaving 연결 중 by a session switch left ${await cspCount()} document CSP listener(s) behind`
      );
    }
    // ...and the abandoned attempt does not keep the new session's panel busy.
    const phase = await page
      .getByTestId("work-observer")
      .getAttribute("data-phase");
    if (phase !== "idle") {
      throw new Error(
        `the session switch left the terminal in ${phase} instead of idle`
      );
    }
  } finally {
    await context.close();
  }
}

// ---- 라이브 화면 상태별 픽셀 증거 (#1414) -----------------------------------
//
// LIVE-2's design review (#1412 M2) found the 라이브 화면 block photographed in
// exactly one state — idle, the one nobody waits in — while every state a
// reader actually sits in or lands on had no pixel evidence at all: the 16:9
// pane before anything arrives, the failure banner, and 보는 중 with a frame in
// it. The three fixtures below each ASSERT the state and then photograph it, in
// that order. The assertion is what fails the gate; the screenshot is what a
// reviewer reads. Neither is a substitute for the other — a capture nobody
// asserts on is a picture of whatever happened, and an assertion with no
// capture is why this ticket exists.

/** The one fixture session that publishes a screen, with its display block up. */
async function openCloudDisplay(page) {
  const rows = page.getByTestId("work-console-row");
  await rows.first().waitFor();
  await rows.filter({ hasText: "클라우드에서 빌드" }).click();
  const display = page.getByTestId("work-display");
  await display.waitFor();
  return display;
}

/**
 * The 라이브 화면 block in both schemes, as it stands right now.
 *
 * The ELEMENT and not the viewport: these states differ only inside this block,
 * and four near-identical 1280x800 consoles are not evidence anyone can read.
 * Both schemes because the failure banner and the warn-tone link notes are
 * exactly where a token that was only checked in light gets caught.
 */
async function captureDisplayState(page, name) {
  if (!captureShots) return [];
  mkdirSync(shotsDir, { recursive: true });
  const display = page.getByTestId("work-display");
  await display.scrollIntoViewIfNeeded();
  const written = [];
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    await page.waitForTimeout(220);
    const path = resolve(shotsDir, `display-${name}-${colorScheme}.png`);
    await display.screenshot({ path });
    written.push(path);
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForTimeout(220);
  return written;
}

/** 화면 보기 권한을 받는 중: the capability call is out and has not come back. */
async function assertDisplayBusy(browser) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    reducedMotion: "reduce",
  });
  try {
    await installRoutes(context, { mode: "normal", hangDisplayAttach: true });
    const page = await openConsole(context);
    await openCloudDisplay(page);
    await page.getByTestId("work-display-start").click();
    await page
      .locator('[data-testid="work-display"][data-phase="issuing"]')
      .waitFor({ timeout: 10_000 });

    const busy = page.getByTestId("work-display-busy");
    const busyCopy = (await busy.textContent())?.trim();
    if (busyCopy !== "화면 보기 권한을 받는 중") {
      throw new Error(`the busy display did not say what it is doing: ${busyCopy}`);
    }
    if ((await busy.getAttribute("role")) !== "status") {
      throw new Error("the busy display line is not announced as a status");
    }
    // The pane is drawn WHILE busy and not only once frames arrive, so the block
    // does not jump under the reader when the first one lands.
    const video = page.getByTestId("work-display-video");
    if ((await video.count()) !== 1) {
      throw new Error("the busy display drew no frame for the screen to land in");
    }
    const ratio = await video.evaluate((element) => {
      const box = element.parentElement.getBoundingClientRect();
      return box.width / box.height;
    });
    if (Math.abs(ratio - 16 / 9) > 0.02) {
      throw new Error(`the display pane is not 16:9 while busy: ${ratio}`);
    }
    // Nothing has arrived, and the surface says exactly that rather than
    // implying a link it does not have.
    const line = (
      await page.getByTestId("work-display-frames").textContent()
    )?.trim();
    if (line !== "연결 없음 · 받은 화면 0프레임, 0바이트") {
      throw new Error(`the busy display claimed something about a link: ${line}`);
    }
    if (await page.getByTestId("work-display-stop").count()) {
      throw new Error("a display that is not watching offered 보기 중단");
    }
    if (await page.getByTestId("work-display-error").count()) {
      throw new Error("a display still waiting on the server drew a failure");
    }
    await captureDisplayState(page, "busy");
    // Still exactly where it was. Everything above — and every pixel of the two
    // captures — was read off a surface that had not moved on, which is the
    // difference between photographing a state and photographing a race.
    const settled = await page.getByTestId("work-display").getAttribute("data-phase");
    if (settled !== "issuing") {
      throw new Error(
        `the display left 화면 보기 권한을 받는 중 mid-capture, into ${settled}`
      );
    }
  } finally {
    await context.close();
  }
}

/** The failure banner, on the server's own 409: this session has no screen. */
async function assertDisplayFailed(browser) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    reducedMotion: "reduce",
  });
  try {
    await installRoutes(context, { mode: "normal", displayAttachStatus: 409 });
    const page = await openConsole(context);
    await openCloudDisplay(page);
    await page.getByTestId("work-display-start").click();
    await page
      .locator('[data-testid="work-display"][data-phase="failed"]')
      .waitFor({ timeout: 10_000 });

    const banner = page.getByTestId("work-display-error");
    const message = (await banner.textContent()) ?? "";
    if (
      !message.includes(
        "이 세션에는 지금 볼 수 있는 화면이 없습니다. 화면을 띄운 호스트에서 실행 중인 세션만 볼 수 있습니다."
      )
    ) {
      throw new Error(`409 did not render its own sentence: ${message}`);
    }
    // Error tone rather than chrome. `InlineBanner` carries the tone in its
    // role, which is also the half a screen reader gets.
    if ((await banner.getAttribute("role")) !== "alert") {
      throw new Error("a failed display drew its banner in the neutral tone");
    }
    if (
      !(await banner.getByText("다시 연결", { exact: true }).isVisible())
    ) {
      throw new Error("a retryable display failure offered no way to retry");
    }
    // Nothing is kept from a stream that never started. A pane left behind here
    // is the frozen picture the whole surface is written against.
    if (await page.getByTestId("work-display-video").count()) {
      throw new Error("a failed display kept its frame on screen");
    }
    if (await page.getByTestId("work-display-frames").count()) {
      throw new Error("a failed display still published a frame counter");
    }
    await captureDisplayState(page, "failed");
  } finally {
    await context.close();
  }
}

/** 보는 중, with a real decoded track in the pane. */
async function assertDisplayWatching(browser) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    reducedMotion: "reduce",
  });
  try {
    await installRoutes(context, { mode: "normal", displayLive: true });
    const page = await openConsole(context, { displayProducer: true });
    const display = await openCloudDisplay(page);
    await page.getByTestId("work-display-start").click();
    await page
      .locator('[data-testid="work-display"][data-phase="watching"]')
      .waitFor({ timeout: 15_000 });

    // A frame this browser actually decoded, not a video element that was
    // handed a source. `videoWidth` stays zero until the first one lands, which
    // is the difference between 보는 중 and an empty black pane claiming to be it.
    try {
      await page.waitForFunction(
        () => {
          const element = document.querySelector(
            '[data-testid="work-display-video"]'
          );
          return (
            element instanceof HTMLVideoElement &&
            element.videoWidth > 0 &&
            element.videoHeight > 0
          );
        },
        null,
        { timeout: 10_000 }
      );
    } catch {
      throw new Error("보는 중 was reached with nothing decoded into the pane");
    }
    const pane = await page.getByTestId("work-display-video").evaluate(
      (element) => ({
        source: element.videoWidth / element.videoHeight,
        frame: element.clientWidth / element.clientHeight,
        fit: getComputedStyle(element).objectFit,
      })
    );
    if (pane.source >= pane.frame) {
      throw new Error(
        "the watching fixture's screen is not narrower than the pane, so it proves nothing about letterboxing"
      );
    }
    if (pane.fit !== "contain") {
      throw new Error(
        `a screen narrower than the pane is ${pane.fit} rather than letterboxed`
      );
    }
    if (Math.abs(pane.frame - 16 / 9) > 0.02) {
      throw new Error(`the watching display pane is not 16:9: ${pane.frame}`);
    }

    // 보는 중 is bound to decoded frames and not to the connection state, so the
    // gate waits for the published count to move rather than for the phase. A
    // stalled connection reports `connected` for its whole timeout, and this is
    // the number that does not go along with it.
    try {
      await page.waitForFunction(
        () => {
          const line = document.querySelector(
            '[data-testid="work-display-frames"]'
          );
          return line !== null && !line.textContent.includes("0프레임");
        },
        null,
        { timeout: 10_000 }
      );
    } catch {
      throw new Error(
        "the watching surface never published a frame it had decoded"
      );
    }
    const line = (
      await page.getByTestId("work-display-frames").textContent()
    )?.trim();
    const counted = /^보는 중 · 받은 화면 ([\d,]+)프레임, ([\d,]+)바이트$/.exec(
      line ?? ""
    );
    if (counted === null) {
      throw new Error(`the watching status line drifted: ${line}`);
    }
    if (Number(counted[1].replaceAll(",", "")) <= 0) {
      throw new Error(`보는 중 was claimed over zero decoded frames: ${line}`);
    }
    if ((await display.getAttribute("data-link")) !== "live") {
      throw new Error("a stream delivering frames was not marked live");
    }
    if (await page.getByTestId("work-display-link").count()) {
      throw new Error("a live stream drew a network warning");
    }
    if (!(await page.getByTestId("work-display-stop").isVisible())) {
      throw new Error("a watching display offered no way to stop");
    }
    // 보기 전용 in the one state where a controllable stream would look
    // identical. The idle assertion in `assertConsole` cannot reach here.
    const inputs = display.locator(
      'input, textarea, [contenteditable="true"], video[controls], [data-testid*="controller"], [data-testid*="input"], [data-testid*="keyboard"]'
    );
    if ((await inputs.count()) !== 0) {
      throw new Error("a watching display exposed a control that could send input");
    }
    if (
      (await page.getByTestId("work-display-readonly").textContent())?.trim() !==
      "보기 전용"
    ) {
      throw new Error("a watching display stopped saying it is view-only");
    }
    await captureDisplayState(page, "watching");
  } finally {
    await context.close();
  }
}

async function assertColdOffline(browser) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    reducedMotion: "reduce",
  });
  try {
    await installRoutes(context, {
      mode: "normal",
      sessionDelayMs: 2_000,
      hostDelayMs: 2_000,
    });
    const page = await openConsole(context);
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    const banner = page.getByTestId("work-console-offline");
    await banner.waitFor();
    if (
      (await banner.textContent())?.includes(
        "아직 표시할 저장된 작업 상태가 없습니다."
      ) !== true
    ) {
      throw new Error("cold offline state claimed that a cached projection exists");
    }
  } finally {
    await context.close();
  }
}

async function main() {
  if (!existsSync(resolve(webRoot, "dist/index.html"))) {
    throw new Error("dist/ is missing. Run npm run build first.");
  }
  const server = spawn(
    resolve(webRoot, "node_modules/.bin/vite"),
    ["preview", "--port", String(port), "--strictPort", "--host", "127.0.0.1"],
    { cwd: webRoot, stdio: "ignore" }
  );
  try {
    await waitForServer();
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        reducedMotion: "reduce",
      });
      const state = {
        mode: "normal",
        sessionDelayMs: 650,
        hostDelayMs: 850,
        channelDelayMs: 0,
        rosterDelayMs: 0,
        failSessions: false,
        failHosts: false,
        failChannels: false,
        failRoster: false,
      };
      await installRoutes(context, state);
      await assertConsole(context, state);
      await context.close();
      await assertTerminalState(
        browser,
        { mode: "empty" },
        "work-console-empty"
      );
      await assertTerminalState(
        browser,
        { mode: "error" },
        "work-console-error",
        "작업 세션을 불러오지 못했습니다."
      );
      await assertTerminalState(
        browser,
        { mode: "normal", failHosts: true },
        "work-console-error",
        "실행 위치를 불러오지 못했습니다."
      );
      await assertMetadataFallback(
        browser,
        { mode: "normal", failChannels: true },
        "채널 조회 실패 · 곽성재 · codex",
        "채널 정보를 새로 확인하지 못했습니다."
      );
      await assertMetadataFallback(
        browser,
        { mode: "normal", failRoster: true },
        "#agent-runtime · 담당자 조회 실패 · codex",
        "담당자 정보를 새로 확인하지 못했습니다."
      );
      await assertDisplayConnectCleanup(browser);
      await assertObserverConnectCleanup(browser);
      await assertDisplayBusy(browser);
      await assertDisplayFailed(browser);
      await assertDisplayWatching(browser);
      await assertColdOffline(browser);
    } finally {
      await browser.close();
    }
  } finally {
    server.kill("SIGTERM");
  }
  console.log(
    "PASS work console: delayed load, projection errors and cached stale fallback, unclipped T1/T2/T3/unknown hosts, cloud icon, observer-only terminal, h1/h2/h3 route outline, linkable selection, responsive keyboard focus, live-screen and terminal connect cleanup on a non-socket exit, live screen busy/failed/watching with a decoded letterboxed frame, cached/cold offline, empty/error"
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
