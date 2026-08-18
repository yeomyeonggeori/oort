#!/usr/bin/env node
// GATE: LIVE-5b 「직접 조작」 — 딥링크 진입 · 입력 포워딩 · auto-return 3경로.
//
// 이 게이트가 지키는 것은 화면의 모양이 아니라 **조작 표면이 하는 말이 참인가**,
// 그리고 **사람이 친 것이 이 기계에 남지 않는가**이다.
//
//   1. 딥링크        LIVE-4 카드의 「작업 세션 열기」가 세션 상세를 열고, 도착지가
//                    직접 조작 **확인 단계까지만** 무장한다. 링크가 눌린 것으로
//                    남의 에이전트가 멈추지 않는다.
//   2. 등급          시작을 누른 뒤에야 `mode: "controller"` 가 서버로 나간다.
//                    관전 경로는 끝까지 observer 하나만 민팅한다.
//   3. 순서          datachannel 은 **producer 가** 연다. 클라는 `ondatachannel`
//                    을 듣고, 채널이 열리기 전에는 「조작 중」이라고 말하지 않는다.
//   4. 비관측        친 키가 datachannel 프레임에는 있고, DOM·콘솔·React 파이버
//                    (=devtools 가 읽는 그것)·속성 어디에도 없다. (ADR-0004 증보 3 D2)
//   4-1. 놓은 키     내려간 키는 **전부** 올라온다. Shift+Esc 를 누르고 Shift 를
//                    먼저 떼는 순서(#1563)로도 keyup 이 호스트에 닿는다 — 판정은
//                    이벤트가 아니라 **press** 단위다.
//   5. auto-return   세 경로 — 협상 마감 · producer 소실 · 사람이 누른 반환 — 이
//                    전부 반환 REST 를 부른다. 반환이 실패하면 화면이 lease 90초를
//                    정직하게 말한다.
//   6. 어포던스 부재 소유자가 아니면 조작 컨트롤이 **없다**(비활성이 아니라 부재).
//                    화면 없는 세션에는 이유 한 문장만 서고 버튼은 없다.
//
// 이름 붙은 red proof (버릴 워크트리에서만 돌린다):
//   DISPLAY_CONTROL_GATE_PROVE_RED_OBSERVED=1 npm run gate:display-control
//     expected failure: "a keystroke reached a surface this machine keeps"
//   DISPLAY_CONTROL_GATE_PROVE_RED_NORETURN=1 npm run gate:display-control
//     expected failure: "the control window was never returned"
//   DISPLAY_CONTROL_GATE_PROVE_RED_STUCKKEY=1 npm run gate:display-control
//     expected failure: "a key went down on the host and never came up"
//
// red seam 은 **드라이버/목의 행동만** 바꾼다. OBSERVED 는 사람이 친 키를 화면이
// 실제로 그리는 자리(속성)와 콘솔에 드라이버가 심어, 「어디에도 없다」 단언이
// 정말 그 네 자리를 읽고 있음을 증명한다. NORETURN 은 반환 REST 를 응답하지 않게
// 만들어(창이 서버에 남은 상태), 「모든 경로가 창을 닫았다」 단언이 화면 문구가
// 아니라 **실제 호출**을 세고 있음을 증명한다. STUCKKEY 는 목 producer 가 조합키의
// keyup 하나를 못 받은 것처럼 굴어 — press 판정을 잃은 클라가 내보내지 않았을 바로
// 그 종류의 프레임 — 「내려간 키는 전부 올라왔다」 단언이 화면이 아니라 **와이어**를
// 세고 있음을 증명한다. 제품 소스 줄을 지우거나 단언을 빼라고 요구하지 않으므로
// 증명은 반복 가능하다.
//
// 캡처: DISPLAY_CONTROL_GATE_SHOTS=1 로 네 상태를 light/dark 로 찍는다
//   artifacts/display-control/{connecting,controlling,returning,failed}-{light,dark}.png
//   artifacts/display-control/overlay-mockup-{light,dark}.png  (오버레이 설계 목업)
//
// 시간에 대하여: 협상 마감은 제품에서 30초다(`CONTROL_NEGOTIATE_TIMEOUT_MS`,
// `controlStream.test.ts` 가 그 값과 lease 90초의 대소를 고정한다). 게이트는 그
// 30초를 기다리지 않고 **드라이버가 큰 setTimeout 을 100분의 1로 압축한다** —
// 제품의 상수도 코드도 바뀌지 않고, 압축은 페이지 안 타이머에만 걸린다.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.DISPLAY_CONTROL_GATE_PORT || 5193);
const origin = `http://127.0.0.1:${port}`;

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const otherMemberId = "00000000-0000-7000-8000-000000000102";
const agentId = "AAAAAAAA-AAAA-7AAA-8AAA-AAAAAAAAA613";
const channelId = "00000000-0000-7000-8000-000000000201";
const sessionId = "019FA1C4-3B21-7D0E-9AA1-5E6C82F41B77";
const hostId = "019FA1C4-3B31-7E88-B0D2-2F41C6A73E55";
const rootMessageId = "019FA1C4-3B21-7D0E-9AA1-5E6C82F41B78";
const signalHost = "vm-gate-5b.oor7.internal";

const proveRedObserved =
  process.env.DISPLAY_CONTROL_GATE_PROVE_RED_OBSERVED === "1";
const proveRedNoReturn =
  process.env.DISPLAY_CONTROL_GATE_PROVE_RED_NORETURN === "1";
const proveRedLateWindow =
  process.env.DISPLAY_CONTROL_GATE_PROVE_RED_LATEWINDOW === "1";
const proveRedStuckKey =
  process.env.DISPLAY_CONTROL_GATE_PROVE_RED_STUCKKEY === "1";
const wantShots = process.env.DISPLAY_CONTROL_GATE_SHOTS === "1";

/**
 * 사람이 치는 것. 물리 키 코드의 열이고, 그중 하나가 표지다.
 *
 * 표지가 나타나도 되는 곳은 **정확히 한 곳** — producer 로 나가는 datachannel
 * 프레임 — 이고, 그 밖의 어디에 있어도 이 게이트는 붉어진다.
 */
const PASSPHRASE = ["KeyH", "KeyU", "KeyN", "Digit7", "Minus", "KeyZ"];
const MARKER = "Digit7";

// ---------------------------------------------------------------------------
// 픽스처
// ---------------------------------------------------------------------------

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
  realtimeWebSocketUrl: "ws://display-control-gate.invalid/connection/websocket",
};

function member(id, kind, displayName, handle, over = {}) {
  return {
    id,
    workspaceId,
    kind,
    status: "active",
    role: kind === "human" ? "owner" : "member",
    displayName,
    handle,
    channelCount: 1,
    channelIds: [channelId],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  };
}

const roster = [
  member(memberId, "human", "곽성재", "seongjae"),
  member(agentId, "agent", "김인턴", "kim-intern", {
    capabilities: ["work.observe"],
    ownerHumanId: memberId,
    agentModel: "hermes-agent",
  }),
  member(otherMemberId, "human", "다른 사람", "other", { role: "member" }),
];

const channel = {
  id: channelId,
  workspaceId,
  kind: "public",
  name: "live-5b",
  muted: false,
};

function workSession(over = {}) {
  return {
    id: sessionId,
    workspaceId,
    channelId,
    memberId,
    hostId,
    rootMessageId,
    tool: "claude",
    label: "결제사 콘솔 로그인",
    status: "running",
    observation: "open",
    observerGrantCount: 0,
    remoteAttachAvailable: false,
    remoteDisplayAvailable: true,
    startedAtMs: Date.now() - 120_000,
    ...over,
  };
}

const workHost = {
  id: hostId,
  workspaceId,
  scope: "member",
  ownerMemberId: memberId,
  type: "cube",
  displayName: "cube-gate-1",
  capabilities: { display_attach: true },
  lastSeenAtMs: Date.now(),
  createdAtMs: Date.now() - 600_000,
  online: true,
};

/** LIVE-4 로그인 핸드오프 카드 하나. 대기 국면이라 딥링크가 조작을 가리킨다. */
const handoffMessage = {
  id: rootMessageId,
  channelId,
  seq: 41,
  hlcTs: 1_785_238_400_000,
  hlcCount: 0,
  authorMemberId: agentId,
  type: "approval_request",
  body: "Approve work.session.login_handoff",
  state: "sent",
  createdAtMs: 1_785_238_400_000,
  props: {
    kind: "login_handoff",
    approval_id: "5f0d2a1e-1c4b-4c9a-9f2a-0d3c8b7e6a11",
    session_id: sessionId,
    approval_status: "pending",
    summary: "결제사 콘솔에 사람이 직접 로그인해 주세요.",
  },
};

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function wait(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

// ---------------------------------------------------------------------------
// 모의 시그널링 하네스 — producer 한 대, 브라우저 안에서
// ---------------------------------------------------------------------------

/**
 * 페이지 안에 producer 와 peer connection 을 세운다.
 *
 * 실제 microVM producer 는 이 레포로 부팅할 수 없고(README), LIVE-5c 전까지
 * `input_enabled: true` 를 읽은 producer 도 없다(template.spec.json
 * `unverified.inputDelivery`). 그래서 이것은 **계약을 재생하는 목**이지 실기동이
 * 아니고, 이 게이트가 증명하는 것은 브라우저 쪽 절반뿐이다.
 *
 * 각본(`window.__controlGate.script`)은 네 가지다:
 *   grant     — 입력 채널이 있는 offer, 그리고 producer 가 채널을 연다(정상)
 *   noInput   — 화면은 오는데 m=application 이 없다(등급과 배선의 불일치)
 *   silent    — 소켓은 열리고 offer 가 오지 않는다(협상 마감)
 *   crash     — 채널이 열린 뒤 죽는다(producer 소실)
 */
async function installProducer(page, options) {
  await page.addInitScript(
    ({ host, script, plantKeystroke, passphraseMarker, dropModifierKeyup }) => {
      const gate = {
        script,
        /** producer 가 datachannel 로 받은 프레임 전부. 유일하게 허용된 자리. */
        wire: [],
        /** 페이지가 콘솔에 쓴 것 전부. */
        consoleLines: [],
        /** display-attach 로 나간 등급들. */
        grantModes: [],
        socketUrls: [],
      };
      window.__controlGate = gate;

      for (const level of ["log", "warn", "error", "info", "debug"]) {
        const original = console[level].bind(console);
        console[level] = (...args) => {
          try {
            gate.consoleLines.push(args.map((a) => String(a)).join(" "));
          } catch {
            gate.consoleLines.push("<unserialisable>");
          }
          original(...args);
        };
      }

      // 드라이버의 시간 압축. 제품 상수는 그대로이고, 페이지 안의 **아주 긴**
      // setTimeout 만 100분의 1로 줄어든다 — 30초 협상 마감을 30초 기다리지
      // 않기 위해서다.
      //
      // 문턱이 20초인 것은 측정으로 정해졌다. 10초였을 때 이 압축은 REST 요청
      // 자체의 마감(`REQUEST_TIMEOUT_MS` 15초)까지 150ms 로 줄여, grant 가
      // 도착하기도 전에 클라가 포기하게 만들었다 — 그러면 「늦게 도착한 grant」
      // 시나리오는 늦은 grant 를 한 번도 보지 못한 채 통과하거나 실패한다. 압축은
      // 재려는 시계 하나만 건드려야 하고, 그 시계는 30초짜리 하나다.
      const realSetTimeout = window.setTimeout.bind(window);
      window.setTimeout = (fn, ms, ...rest) =>
        realSetTimeout(
          fn,
          typeof ms === "number" && ms >= 20_000 ? Math.round(ms / 100) : ms,
          ...rest
        );

      const OFFER_VIDEO = [
        "v=0",
        "o=- 0 0 IN IP4 127.0.0.1",
        "s=oort-display-gate-5b",
        "t=0 0",
        "a=group:BUNDLE 0",
        "m=video 9 UDP/TLS/RTP/SAVPF 96",
        "c=IN IP4 0.0.0.0",
        "a=rtcp-mux",
        "a=mid:0",
        "a=sendonly",
        "a=rtpmap:96 H264/90000",
        "a=setup:actpass",
        "",
      ].join("\r\n");
      const OFFER_WITH_INPUT =
        OFFER_VIDEO +
        [
          "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
          "c=IN IP4 0.0.0.0",
          "a=mid:1",
          "a=sctp-port:5000",
          "",
        ].join("\r\n");

      const BaseSocket = window.WebSocket;
      class GateProducerSocket extends BaseSocket {
        constructor(url, protocols) {
          super(url, protocols);
          this.gateIsProducer = String(url).includes(host);
          if (!this.gateIsProducer) return;
          gate.socketUrls.push(String(url));
          gate.producerSocket = this;
          queueMicrotask(() =>
            queueMicrotask(() => {
              if (gate.script === "silent") return;
              this.gateEmit({
                type: "ready",
                display_id: "gate-display-1",
                // 이 답이 「이 사람이 키보드를 잡았다」의 producer 쪽 절반이다.
                // 서버의 validate 가 그렇게 답했기 때문에 참인 것이지, 뷰어가
                // 요청해서가 아니다.
                mode: "controller",
                input_enabled: gate.script !== "noInput",
              });
              this.gateEmit({
                type: "offer",
                sdp: gate.script === "noInput" ? OFFER_VIDEO : OFFER_WITH_INPUT,
              });
            })
          );
        }

        gateEmit(frame) {
          this.onmessage?.(
            new MessageEvent("message", { data: JSON.stringify(frame) })
          );
        }

        send(data) {
          // producer 는 뷰어에게 답하지 않는다. answer·ice·bye 는 받고 버린다.
          if (this.gateIsProducer) return;
          return super.send(data);
        }
      }
      window.WebSocket = GateProducerSocket;

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
          ctx.fillRect(40, 40, canvas.width - 80, canvas.height - 80);
          ctx.fillStyle = "#1c2b44";
          ctx.fillRect(40, 40, canvas.width - 80, 60);
          ctx.fillStyle = "#dbe7f5";
          ctx.font = "26px monospace";
          ctx.fillText("gate fixture screen", 70, 80);
          ctx.font = "22px monospace";
          ctx.fillStyle = "#8fa6c4";
          [
            "결제사 콘솔",
            "아이디",
            "비밀번호",
            "로그인",
          ].forEach((line, index) => ctx.fillText(line, 80, 170 + index * 44));
          ctx.fillStyle = "#4ea3f0";
          ctx.fillRect(80, 430, ((tick * 24) % 600) + 20, 12);
        };
        paint();
        const timer = window.setInterval(paint, 200);
        return {
          stream: canvas.captureStream(10),
          stop: () => window.clearInterval(timer),
        };
      };

      class GateInputChannel {
        constructor() {
          this.label = "momo.input.v1";
          this.readyState = "connecting";
          this.onopen = null;
          this.onclose = null;
        }
        send(frame) {
          // RED SEAM (#1563). 이 producer 가 **조합키의 keyup 하나만 못 받은
          // 것처럼** 군다 — 판정을 잃은 클라가 내보내지 않았을 바로 그 종류의
          // 프레임이다. 제품은 한 줄도 바뀌지 않고, 「내려간 키는 전부
          // 올라왔다」 단언이 화면 문구가 아니라 **실제 와이어**를 세고 있음이
          // 증명된다. Escape 가 아니라 Shift 를 지우는 이유: Escape 였다면 그
          // 앞의 시나리오 전용 단언이 먼저 붉어져, 이 균형 단언이 정말 도는지는
          // 아무도 보지 못한다.
          if (dropModifierKeyup) {
            try {
              const parsed = JSON.parse(frame);
              if (
                parsed.type === "key" &&
                parsed.action === "up" &&
                String(parsed.code).startsWith("Shift")
              ) {
                return;
              }
            } catch {
              /* 프레임이 아니면 그대로 기록한다 */
            }
          }
          gate.wire.push(frame);
          if (plantKeystroke) {
            // RED SEAM. 드라이버가 「기억하는 표면」을 **네 자리 모두**에 만든다:
            // 콘솔 한 줄, 화면에 그려지는 글자(DOM 텍스트), 속성 하나, 그리고
            // React 파이버의 props — devtools 가 읽는 바로 그 객체. 제품은 한
            // 줄도 바뀌지 않는다. 네 자리를 함께 심는 이유는 단언이 첫 자리에서
            // 멈추면 나머지 셋을 정말 읽는지 아무도 모르기 때문이다.
            let leaked = passphraseMarker;
            try {
              leaked = JSON.parse(frame).code ?? passphraseMarker;
            } catch {
              /* 프레임이 아니면 표지 그대로 심는다 */
            }
            console.log(`forwarded ${leaked}`);
            const surface = document.querySelector(
              '[data-testid="work-control-surface"]'
            );
            if (surface) {
              surface.setAttribute("data-last-key", leaked);
              let plaque = document.getElementById("gate-red-plaque");
              if (!plaque) {
                plaque = document.createElement("span");
                plaque.id = "gate-red-plaque";
                surface.parentElement?.appendChild(plaque);
              }
              plaque.textContent = `마지막 키 ${leaked}`;
              const fiberKey = Object.keys(surface).find(
                (k) =>
                  k.startsWith("__reactFiber$") ||
                  k.startsWith("__reactInternalInstance$")
              );
              const fiber = fiberKey ? surface[fiberKey] : null;
              if (fiber?.memoizedProps) {
                fiber.memoizedProps = {
                  ...fiber.memoizedProps,
                  gateLastKey: leaked,
                };
              }
            }
          }
        }
        close() {
          this.readyState = "closed";
          this.onclose?.(new Event("close"));
        }
      }

      class GatePeerConnection {
        constructor(config) {
          gate.iceServers = config?.iceServers ?? null;
          this.connectionState = "new";
          this.ontrack = null;
          this.onicecandidate = null;
          this.onconnectionstatechange = null;
          this.ondatachannel = null;
          this.gateScreen = null;
          this.gateClosed = false;
          gate.peer = this;
        }
        async setRemoteDescription() {}
        async createAnswer() {
          return { type: "answer", sdp: "v=0\r\n" };
        }
        async setLocalDescription() {
          if (this.gateClosed) return;
          this.gateScreen = mockScreen();
          this.ontrack?.({
            streams: [this.gateScreen.stream],
            track: this.gateScreen.stream.getVideoTracks()[0],
          });
          this.connectionState = "connected";
          this.onconnectionstatechange?.(new Event("connectionstatechange"));
          if (gate.script === "noInput") return;
          // producer 가 채널을 연다. 클라가 아니다.
          const channel = new GateInputChannel();
          gate.channel = channel;
          this.ondatachannel?.({ channel });
          window.setTimeout(() => {
            channel.readyState = "open";
            channel.onopen?.(new Event("open"));
            if (gate.script === "crash") {
              window.setTimeout(() => channel.close(), 120);
            }
          }, 20);
        }
        async addIceCandidate() {}
        async getStats() {
          return new Map();
        }
        close() {
          this.gateClosed = true;
          this.gateScreen?.stop();
          this.gateScreen = null;
        }
      }
      window.RTCPeerConnection = GatePeerConnection;
    },
    {
      host: signalHost,
      script: options.script,
      plantKeystroke: options.plantKeystroke === true,
      passphraseMarker: MARKER,
      dropModifierKeyup: options.dropModifierKeyup === true,
    }
  );
}

/** Centrifugo 자리를 채우는 최소 소켓. 이 게이트는 프레임을 쓰지 않는다. */
async function installRealtimeSocket(page) {
  await page.addInitScript(() => {
    class GateRealtimeSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      constructor(url) {
        this.url = url;
        this.readyState = GateRealtimeSocket.CONNECTING;
        queueMicrotask(() => {
          this.readyState = GateRealtimeSocket.OPEN;
          this.onopen?.(new Event("open"));
        });
      }
      send(data) {
        const replies = [];
        for (const line of String(data).trim().split("\n")) {
          const command = JSON.parse(line);
          if (command.connect) {
            replies.push({
              id: command.id,
              connect: { client: "display-control-gate", version: "6" },
            });
          } else if (command.subscribe) {
            replies.push({
              id: command.id,
              subscribe: {
                recoverable: true,
                positioned: true,
                recovered: false,
                epoch: "display-control-gate",
                offset: 0,
              },
            });
          } else {
            replies.push({ id: command.id });
          }
        }
        queueMicrotask(() => {
          for (const reply of replies) {
            this.onmessage?.(
              new MessageEvent("message", { data: JSON.stringify(reply) })
            );
          }
        });
      }
      close() {
        this.readyState = GateRealtimeSocket.CLOSED;
        this.onclose?.(new CloseEvent("close", { code: 1000 }));
      }
    }
    window.WebSocket = GateRealtimeSocket;
  });
}

// ---------------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------------

async function installRoutes(context, state) {
  await context.route("**/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();

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
        expiresAtMs: Date.now() + 600_000,
        ttlSeconds: 600,
        workspaceId,
        memberId,
      });
    }
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/channels")) return json(route, { channels: [channel] });
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: [workHost] });
    if (path.endsWith("/work-sessions")) {
      return json(route, { workSessions: [state.session] });
    }
    if (path.endsWith("/display-attach")) {
      let mode = "observer";
      try {
        mode = JSON.parse(request.postData() ?? "{}").mode ?? "observer";
      } catch {
        /* 본문 없는 요청은 서버 기본값(observer)이다 */
      }
      state.grantModes.push(mode);
      if (mode !== "controller") {
        // 관전 경로는 이 게이트에서 다이얼되지 않는다. 화면 없이 두면 상세가
        // 「화면 보기」 버튼 상태로 조용히 서 있고, 그것이 여기서 원하는 배경이다.
        return json(route, { error: { message: "gate: observer not served" } }, 409);
      }
      if (state.grantHoldMs) await wait(state.grantHoldMs);
      if (state.grantStatus) {
        return json(
          route,
          { error: { message: "fixture control refusal" } },
          state.grantStatus
        );
      }
      // 원장의 창을 목이 **실제로 연다**. 이 게이트가 세는 것은 DELETE 호출 수가
      // 아니라 **창이 남았는가**이고, 그 둘은 grok H-1 에서 갈라졌다: 너무 이른
      // DELETE 하나는 세어지지만 아무것도 닫지 않는다.
      state.windowOpen = true;
      state.windowOpenedAt = Date.now();
      return json(route, {
        display_endpoint: `wss://${signalHost}/display/signal/gate-display-1`,
        capability_token: "gate-only-not-a-credential",
        display_id: "gate-display-1",
        mode: "controller",
        control_started_at: Date.now(),
        // 빈 배열 = 「이미 가진 설정을 쓰라」. 오류가 아니다(openapi 서술).
        ice_servers: [],
      });
    }
    if (path.endsWith("/display-control") && method === "DELETE") {
      state.returns.push(Date.now());
      // RED SEAM: 반환이 서버에 닿지 않는 판. 창은 원장에 남는다.
      if (state.hangReturn) return new Promise(() => {});
      if (state.returnHoldMs) await wait(state.returnHoldMs);
      if (state.failReturn) {
        // 서버가 500 을 냈다 = 창은 닫히지 않았다. 화면이 lease 를 말해야 하는
        // 판이고, 원장도 그대로 열려 있어야 그 문장이 참이 된다.
        return json(route, { error: { message: "fixture return failure" } }, 500);
      }
      // RED SEAM(H-1): grant 뒤에 온 DELETE 를 목이 삼킨다 — 수리 이전의 서버 쪽
      // 결과를 그 자리에 되돌린다(이른 DELETE 하나만 유효했던 판). 제품은 한 줄도
      // 바뀌지 않고, 단언이 **호출 수가 아니라 창**을 보고 있음을 증명한다.
      const swallow =
        state.swallowLateReturn === true &&
        state.windowOpenedAt !== undefined &&
        Date.now() >= state.windowOpenedAt;
      const closed = state.windowOpen === true && !swallow;
      if (closed) state.windowOpen = false;
      return json(route, { closed });
    }
    if (path.includes("/messages/") && path.endsWith("/replies")) {
      return json(route, { messages: [] });
    }
    if (path.includes("/messages")) {
      return json(route, { messages: [handoffMessage] });
    }
    if (path.includes("/workstreams")) return json(route, { workstreams: [] });
    return json(route, {});
  });
}

async function waitForServer() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(origin)).ok) return;
    } catch {
      /* preview 가 아직 뜨는 중 */
    }
    await wait(200);
  }
  throw new Error("display-control preview server never came up");
}

async function login(page) {
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  const submit = page.getByTestId("login-submit");
  await submit.waitFor({ timeout: 30_000 });
  await page.getByTestId("login-email").fill("gate@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await submit.click();
  await page.getByTestId("channel-item").first().waitFor({ timeout: 30_000 });
}

function fail(message) {
  throw new Error(`GATE FAIL: ${message}`);
}

/**
 * 원장에 창이 남지 않았는가. **모든 시나리오의 마지막 질문**이다.
 *
 * 화면 문구가 아니라 목이 들고 있는 창 상태를 본다(grok freeze H-1): 「반환
 * 문장이 떴다」와 「창이 닫혔다」는 다른 사실이고, 그 둘이 갈라지는 것이 이
 * 결함의 모양이었다.
 */
async function assertWindowClosed(state, label, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state.windowOpen !== true) return;
    await wait(100);
  }
  fail(
    `the control window was left open in the ledger after ${label} — an agent parked with nobody holding the keyboard`
  );
}

async function openContext(browser, state, options = {}) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
    colorScheme: options.colorScheme ?? "light",
  });
  const page = await context.newPage();
  await installRealtimeSocket(page);
  // 실시간 스텁 **뒤에**: producer 소켓은 그때의 `window.WebSocket` 을 상속한다.
  await installProducer(page, {
    script: options.script ?? "grant",
    plantKeystroke: options.plantKeystroke === true,
    dropModifierKeyup: options.dropModifierKeyup === true,
  });
  await installRoutes(context, state);
  return { context, page };
}

/**
 * 세션 상세까지. **딥링크로만 간다** — 그것이 이 goal 의 진입점이고, 카드를
 * 눌러 도착하는 것까지가 계약이다.
 */
async function openDetailViaCard(page) {
  await login(page);
  await page.getByTestId("channel-item").first().click();
  const link = page.getByTestId("handoff-open-session");
  await link.waitFor({ timeout: 30_000 });
  if ((await link.getAttribute("data-seeks-control")) === null) {
    fail("the waiting handoff card's link did not carry the control intent");
  }
  await link.click();
  await page.getByTestId("work-detail").waitFor({ timeout: 30_000 });
}

// ---------------------------------------------------------------------------
// 시나리오
// ---------------------------------------------------------------------------

/**
 * 정상 경로. 딥링크 → 확인 → controller → 입력 → 명시 반환.
 *
 * 비관측 red proof 도 여기 있다: 사람이 실제로 키를 치고, 그 뒤 이 기계의 네
 * 표면을 훑는다.
 */
async function exerciseHappyPath(browser) {
  const state = { session: workSession(), grantModes: [], returns: [] };
  const { context, page } = await openContext(browser, state, {
    plantKeystroke: proveRedObserved,
    dropModifierKeyup: proveRedStuckKey,
  });
  try {
    await openDetailViaCard(page);

    // 딥링크가 한 일은 **무장까지**. 창은 열리지 않았다.
    await page.getByTestId("work-control-confirm").waitFor({ timeout: 10_000 });
    if (state.grantModes.some((mode) => mode === "controller")) {
      fail("following a link minted a controller grant before anybody confirmed");
    }

    // 그만두면 확인이 접히고 초대만 남는다. 그 뒤 다시 눌러 들어간다.
    await page.getByTestId("work-control-confirm-cancel").click();
    await page.getByTestId("work-control-start").waitFor({ timeout: 10_000 });
    await page.getByTestId("work-control-start").click();
    await page.getByTestId("work-control-confirm").waitFor({ timeout: 10_000 });

    await page.getByTestId("work-control-confirm-start").click();
    await page
      .locator('[data-testid="work-control"][data-phase="controlling"]')
      .waitFor({ timeout: 20_000 });

    if (!state.grantModes.includes("controller")) {
      fail("the control surface never asked the server for a controller grant");
    }
    if (state.grantModes.some((mode) => mode !== "controller")) {
      fail("the control surface minted a grade other than controller");
    }

    // 순서: 채널은 producer 가 열었고, 클라는 요청하지 않았다.
    const asked = await page.evaluate(() =>
      (window.__controlGate.wire ?? []).some((frame) =>
        String(frame).includes("open_input")
      )
    );
    if (asked) fail("the client asked the producer to open input");

    // 사람이 친다.
    await page.getByTestId("work-control-surface").focus();
    for (const code of PASSPHRASE) await page.keyboard.press(code);
    const surfaceBox = await page
      .getByTestId("work-control-surface")
      .boundingBox();
    if (surfaceBox === null) fail("the capture surface has no box to point at");
    await page.mouse.move(
      surfaceBox.x + surfaceBox.width / 2,
      surfaceBox.y + surfaceBox.height / 2
    );
    await page.mouse.move(
      surfaceBox.x + surfaceBox.width / 2 + 12,
      surfaceBox.y + surfaceBox.height / 2 + 8
    );
    await page.waitForTimeout(200);

    const observed = await page.evaluate(
      ({ marker }) => {
        const gate = window.__controlGate;
        /** React 파이버 — devtools 가 읽는 바로 그 트리. */
        const fiberText = () => {
          const node = document.querySelector(
            '[data-testid="work-control-surface"]'
          );
          if (!node) return "";
          const key = Object.keys(node).find(
            (k) =>
              k.startsWith("__reactFiber$") ||
              k.startsWith("__reactInternalInstance$")
          );
          if (!key) return "";
          const seen = new Set();
          const chunks = [];
          const render = (value, depth) => {
            if (depth > 6 || value === null || value === undefined) return;
            if (typeof value === "string" || typeof value === "number") {
              chunks.push(String(value));
              return;
            }
            if (typeof value !== "object") return;
            if (seen.has(value)) return;
            seen.add(value);
            for (const entry of Object.values(value)) render(entry, depth + 1);
          };
          let fiber = node[key];
          let hops = 0;
          while (fiber && hops < 40) {
            render(fiber.memoizedProps, 0);
            let hook = fiber.memoizedState;
            let hookHops = 0;
            while (hook && hookHops < 40) {
              render(hook.memoizedState, 0);
              hook = hook.next;
              hookHops += 1;
            }
            fiber = fiber.return;
            hops += 1;
          }
          return chunks.join("");
        };
        const attributes = [];
        for (const element of document.querySelectorAll("*")) {
          for (const attribute of element.attributes) {
            attributes.push(`${attribute.name}=${attribute.value}`);
          }
        }
        return {
          wire: (gate.wire ?? []).join("\n"),
          // 화면에 실제로 그려진 글자와, 그 글자를 담을 수 있는 속성을 따로
          // 본다. 둘을 합치면 어느 쪽이 샜는지 red 판이 말해 주지 못한다.
          domText: document.body.innerText ?? "",
          attributes: attributes.join("\n"),
          consoleLines: (gate.consoleLines ?? []).join("\n"),
          fiber: fiberText(),
          marker,
        };
      },
      { marker: MARKER }
    );

    // 갔다: 절대 부재만 재는 시험은 아무것도 보내지 않게 된 클라에서도 통과한다.
    if (!observed.wire.includes(MARKER)) {
      fail("the keystroke never reached the datachannel at all");
    }
    const wireFrames = observed.wire.split("\n").filter(Boolean);
    if (wireFrames.length < PASSPHRASE.length * 2) {
      fail(
        `expected keydown+keyup per key on the wire, saw ${wireFrames.length}`
      );
    }
    if (!observed.wire.includes('"type":"pointer"')) {
      fail("pointer movement never reached the datachannel");
    }
    // 문자는 실리지 않는다: 물리 키와 조합키뿐이다.
    if (/"key"\s*:/.test(observed.wire)) {
      fail("a frame carried the produced character, not the physical key");
    }

    // 그리고 이 기계의 어디에도 없다. 네 표면을 각각 이름 붙여 훑고, 첫 자리에서
    // 멈추지 않는다: 하나에서 멈추면 나머지 셋을 정말 읽는지 red 판이 보여 주지
    // 못한다.
    const leaked = [
      ["the rendered DOM", observed.domText],
      ["a DOM attribute", observed.attributes],
      ["the console", observed.consoleLines],
      ["the React fiber tree (devtools)", observed.fiber],
    ]
      .filter(([, text]) => text.includes(MARKER))
      .map(([surface]) => surface);
    if (leaked.length > 0) {
      fail(
        `a keystroke reached a surface this machine keeps: ${leaked.join(", ")}`
      );
    }

    // 포커스를 잃으면 화면이 그렇게 말한다 (design-review H-2). 창은 여전히
    // 열려 있고, 달라진 것은 키가 어디로 가는가뿐이다.
    await page.evaluate(() => {
      const surface = document.querySelector(
        '[data-testid="work-control-surface"]'
      );
      if (surface instanceof HTMLElement) surface.blur();
    });
    await page.getByTestId("work-control-keyboard-lost").waitFor({ timeout: 5_000 });
    const lostChip = await page.getByTestId("work-control-grade").textContent();
    if (lostChip?.includes("조작 중")) {
      fail("the chip still claimed 조작 중 with the keyboard somewhere else");
    }
    if (state.returns.length > 0) {
      fail("losing the keyboard ended the control window — it must only move the caret");
    }

    // 키보드만으로 반환까지 (design-review B-1). 여기서부터 마우스는 쓰지 않는다.
    await page.getByTestId("work-control-surface").focus();
    await page.getByTestId("work-control-grade").waitFor();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);
    const onReturn = await page.evaluate(() => {
      const active = document.activeElement;
      return (
        active instanceof HTMLElement &&
        active.dataset.testid === "work-control-return"
      );
    });
    if (!onReturn) {
      fail(
        "Escape did not hand the caret to 화면 돌려주기 — a keyboard user cannot give the keyboard back"
      );
    }
    // Esc 는 호스트로 가지 않는다.
    const escOnWire = await page.evaluate(() =>
      (window.__controlGate.wire ?? []).some((frame) =>
        String(frame).includes('"code":"Escape"')
      )
    );
    if (escOnWire) fail("the release key was forwarded to the host");

    // ---- #1563: 누른 순서와 뗀 순서가 다를 때 -----------------------------
    //
    // Shift+Esc 는 「Esc 를 호스트로」 라는 몸짓이고, 손이 코드에서 빠지는
    // 보통의 순서는 **조합키를 먼저** 떼는 것이다. 판정이 이벤트 단위였을 때
    // 그 keyup 은 `shiftKey: false` 로 도착해 평범한 Esc 규칙에 걸렸고 —
    // release 로 분류되어 전달되지 않았다. 호스트는 keydown 만 받은 채 그 키를
    // 영영 누르고 있게 된다(논리적 stuck key). 그래서 이 순서를 실제로 친다.
    await page.getByTestId("work-control-surface").focus();
    await page.keyboard.down("Shift");
    await page.keyboard.down("Escape");
    await page.keyboard.up("Shift"); // ← 먼저 뗀다. 이 한 줄이 결함의 모양이다.
    await page.keyboard.up("Escape");
    await page.waitForTimeout(100);

    const keyFrames = await page.evaluate(() =>
      (window.__controlGate.wire ?? [])
        .map((frame) => {
          try {
            return JSON.parse(frame);
          } catch {
            return null;
          }
        })
        .filter((frame) => frame !== null && frame.type === "key")
    );
    const escapeFrames = keyFrames.filter((frame) => frame.code === "Escape");
    if (!escapeFrames.some((frame) => frame.action === "up")) {
      fail(
        "the keyup of Shift+Esc never reached the host after Shift was released first — the host is holding a key nobody is pressing"
      );
    }
    if (escapeFrames.length !== 2) {
      fail(
        `Shift+Esc must put exactly its down and its up on the wire, saw ${escapeFrames.length} Escape frames`
      );
    }
    // 조합키는 몸짓이지 키가 아니다 — 양쪽 모서리 다.
    if (escapeFrames.some((frame) => frame.shift !== false)) {
      fail("Shift travelled with the Escape it was only the gesture for");
    }
    // 그리고 이것은 반환 몸짓이 아니다: 캐럿은 그대로 화면에 있다.
    const stillCapturing = await page.evaluate(() => {
      const active = document.activeElement;
      return (
        active instanceof HTMLElement &&
        active.dataset.testid === "work-control-surface"
      );
    });
    if (!stillCapturing) {
      fail("Shift+Esc moved the caret — it is the send gesture, not the release one");
    }

    // 이 창에서 내려간 키는 **전부** 올라왔는가. 시나리오 하나가 아니라 지금까지
    // 친 모든 키에 대해 묻는다: stuck key 는 한 순서에만 사는 결함이 아니다.
    const held = [];
    for (const frame of keyFrames) {
      if (frame.action === "down") {
        if (!held.includes(frame.code)) held.push(frame.code);
      } else {
        const at = held.indexOf(frame.code);
        if (at >= 0) held.splice(at, 1);
      }
    }
    if (held.length > 0) {
      fail(
        `a key went down on the host and never came up: ${held.join(", ")} — the person let go and the VM did not`
      );
    }

    // 다시 캐럿을 반환 버튼으로. 위 시나리오가 캐럿을 화면에 두고 끝났으므로,
    // 키보드만으로 반환하는 아래 단계는 릴리스 키를 한 번 더 지난다.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);

    // 명시 반환 — Enter 로.
    const before = state.returns.length;
    await page.keyboard.press("Enter");
    await page.getByTestId("work-control-returned").waitFor({ timeout: 20_000 });
    if (state.returns.length <= before) {
      fail("the control window was never returned on an explicit 반환");
    }
    const returnedText = await page
      .getByTestId("work-control-returned")
      .textContent();
    if (!returnedText?.includes("에이전트")) {
      fail("the return notice never says what happens to the agent");
    }
    // 관전이 다시 열렸다는 말은 실제로 열렸을 때만 한다(픽스처는 observation=open).
    if (!returnedText.includes("관전이 다시 팀원에게 열렸습니다")) {
      fail("an owner whose observation was open was not told it reopened");
    }

    await assertWindowClosed(state, "an explicit 반환");

    await page.getByTestId("work-control-dismiss").click();
    await page.getByTestId("work-display").waitFor({ timeout: 10_000 });
  } finally {
    await context.close();
  }
  console.log(
    "  ok  deep link -> confirm -> controller -> input -> Esc -> Shift+Esc(순서 뒤집힌 해제) -> 반환 (keyboard only from control)"
  );
}

/** auto-return 경로 하나. 각본대로 망가뜨리고, 창이 닫혔는지 본다. */
async function exerciseAutoReturn(browser, { script, label, expectCopy }) {
  const state = { session: workSession(), grantModes: [], returns: [] };
  if (proveRedNoReturn) state.hangReturn = true;
  const { context, page } = await openContext(browser, state, { script });
  try {
    await openDetailViaCard(page);
    await page.getByTestId("work-control-confirm-start").click();

    if (proveRedNoReturn) {
      // 창이 서버에 남았는지가 질문이므로 화면 문구를 기다리지 않는다.
      await page.waitForTimeout(4_000);
      if (state.returns.length === 0) {
        fail(`the control window was never returned (${label})`);
      }
      // 목이 응답하지 않았으므로 여기 도달하면 그것대로 붉다.
      fail(
        `the control window was never returned to a server that could close it (${label})`
      );
    }

    await page.getByTestId("work-control-returned").waitFor({ timeout: 30_000 });
    if (state.returns.length === 0) {
      fail(`the control window was never returned (${label})`);
    }
    const text = await page.getByTestId("work-control-returned").textContent();
    if (!text?.includes(expectCopy)) {
      fail(`${label}: the surface did not say why control ended (${text})`);
    }
    await assertWindowClosed(state, label);
  } finally {
    await context.close();
  }
  console.log(`  ok  auto-return: ${label}`);
}

/**
 * grant 가 오는 중에 사람이 화면을 떠난다 (grok freeze H-1).
 *
 * 앞 판의 구멍은 이중 반환이 아니라 **너무 이른 한 번의 반환**이었다: 언마운트
 * cleanup 의 DELETE 가 「닫을 창 없음」으로 먼저 끝나고, 그 뒤에 mint 가 성공해
 * 창이 열린다. 아무도 잡고 있지 않은 창이 lease 90초까지 서 있고, 그 사이의
 * 재시도는 409 다.
 *
 * 그래서 이 시나리오는 화면을 보지 않는다. 목의 원장에 **창이 남았는지**만 본다.
 */
async function exerciseUnmountDuringGrant(browser) {
  const state = {
    session: workSession(),
    grantModes: [],
    returns: [],
    // mint 가 늦게 도착하도록: 사람이 떠날 시간을 만든다.
    grantHoldMs: 1_500,
  };
  if (proveRedLateWindow) state.swallowLateReturn = true;
  const { context, page } = await openContext(browser, state);
  try {
    await openDetailViaCard(page);
    await page.getByTestId("work-control-confirm-start").click();
    await page.getByTestId("work-control-busy").waitFor({ timeout: 10_000 });
    // 떠난다. 상세가 언마운트되고, 조작 표면도 함께 내려간다.
    await page.getByTestId("work-detail-back").click();
    await page.waitForTimeout(200);
    if ((await page.getByTestId("work-control").count()) > 0) {
      fail("the control surface survived leaving the session detail");
    }
    // mint 가 도착할 시간을 준다.
    await page.waitForTimeout(2_500);
    if (!state.grantModes.includes("controller")) {
      fail("the fixture never minted the late grant this scenario is about");
    }
    await assertWindowClosed(state, "leaving while the grant was in flight");
  } finally {
    await context.close();
  }
  console.log("  ok  a grant that lands after the reader left closes its own window");
}

/**
 * 콘솔 주소가 조작 의도를 실어 왔을 때 (design-review M3 · nitpick 3).
 *
 * 두 가지를 함께 잰다. `?control=1` 은 **읽고 나면 주소에서 지워지고**(#1193
 * 규칙), 그 의도는 **한 번만** 쓰인다: 확인을 그만둔 사람이 목록에 나갔다
 * 돌아왔을 때 같은 질문이 다시 서면, 그 질문의 대가가 남의 에이전트를 멈추는
 * 것일 때, 화면이 물어본 적 없는 동의를 받아내는 모양이 된다.
 */
async function exerciseConsoleIntent(browser) {
  const state = { session: workSession(), grantModes: [], returns: [] };
  const { context, page } = await openContext(browser, state);
  try {
    await login(page);
    await page.goto(`${origin}/#/work?session=${sessionId}&control=1`);
    await page.getByTestId("work-console-route").waitFor({ timeout: 30_000 });
    await page.getByTestId("work-control-confirm").waitFor({ timeout: 20_000 });

    // 주소는 자리를 계속 가리키되, 부사는 지워졌다.
    const url = page.url();
    if (!url.includes("session=")) fail("the console dropped the place it was pointing at");
    if (url.includes("control=")) {
      fail("the one-shot control intent stayed in the address bar");
    }

    // 그만두고 나갔다 돌아온다. 새 의도가 없으므로 확인은 서지 않아야 한다.
    await page.getByTestId("work-control-confirm-cancel").click();
    await page.getByTestId("work-control-start").waitFor({ timeout: 10_000 });
    await page.goto(`${origin}/#/work`);
    await page.getByTestId("work-console-route").waitFor({ timeout: 20_000 });
    await page.goto(`${origin}/#/work?session=${sessionId}`);
    await page.getByTestId("work-control-start").waitFor({ timeout: 20_000 });
    if ((await page.getByTestId("work-control-confirm").count()) > 0) {
      fail("a confirmation the reader cancelled came back without a new intent");
    }
    if (state.grantModes.length > 0) {
      fail("the console intent minted a grant with nobody confirming");
    }
  } finally {
    await context.close();
  }
  console.log("  ok  console ?control=1 is consumed once and leaves the address bar");
}

/** 반환이 실패한 판. 화면은 서버의 lease 를 정직하게 말해야 한다. */
async function exerciseReturnFailure(browser) {
  const state = {
    session: workSession(),
    grantModes: [],
    returns: [],
    failReturn: true,
  };
  const { context, page } = await openContext(browser, state);
  try {
    await openDetailViaCard(page);
    await page.getByTestId("work-control-confirm-start").click();
    await page
      .locator('[data-testid="work-control"][data-phase="controlling"]')
      .waitFor({ timeout: 20_000 });
    await page.getByTestId("work-control-return").click();
    const banner = page.getByTestId("work-control-return-failed");
    await banner.waitFor({ timeout: 20_000 });
    const text = (await banner.textContent()) ?? "";
    if (!text.includes("90초")) {
      fail("a failed return did not name the lease that will finish the job");
    }
    if (/다시 시도|재시도/.test(text)) {
      fail("a failed return offered the very call that just failed");
    }
    // 그 자리에 다시 누를 컨트롤도 없어야 한다.
    if ((await page.getByTestId("work-control-return").count()) > 0) {
      fail("the 반환 control survived a failed return");
    }
  } finally {
    await context.close();
  }
  console.log("  ok  a failed return names the 90s lease and offers no retry");
}

/** 어포던스 부재. 없으면 비활성이 아니라 **없다**. */
async function exerciseAffordanceAbsence(browser) {
  for (const [label, session, expectNote] of [
    ["a teammate's session", workSession({ memberId: otherMemberId }), null],
    [
      "a session with no published screen",
      workSession({ remoteDisplayAvailable: false }),
      "호스트 화면을 열어 두지 않아",
    ],
  ]) {
    const state = { session, grantModes: [], returns: [] };
    const { context, page } = await openContext(browser, state);
    try {
      await openDetailViaCard(page);
      await page.getByTestId("work-display").waitFor({ timeout: 20_000 });
      if ((await page.getByTestId("work-control-start").count()) > 0) {
        fail(`${label}: a control was offered that cannot work`);
      }
      if ((await page.getByTestId("work-control-confirm").count()) > 0) {
        fail(`${label}: the deep link armed a control that is not there`);
      }
      const disabled = await page
        .locator('[data-testid="work-display"] [disabled], [data-testid="work-display"] [aria-disabled="true"]')
        .count();
      if (disabled > 0) fail(`${label}: a disabled control stood in for absence`);
      const blocked = page.getByTestId("work-control-blocked");
      if (expectNote === null) {
        if ((await blocked.count()) > 0) {
          fail(`${label}: a teammate was told about a control that is not theirs`);
        }
      } else {
        const note = (await blocked.textContent()) ?? "";
        if (!note.includes(expectNote)) {
          fail(`${label}: the reason was not stated (${note})`);
        }
      }
    } finally {
      await context.close();
    }
    console.log(`  ok  어포던스 부재: ${label}`);
  }
}

// ---------------------------------------------------------------------------
// 캡처 — 네 상태 × light/dark
// ---------------------------------------------------------------------------

const shotsDir = resolve(webRoot, "artifacts/display-control");

async function shoot(page, name) {
  mkdirSync(shotsDir, { recursive: true });
  const path = resolve(shotsDir, `${name}.png`);
  const target = page.getByTestId("work-detail-scroll");
  if ((await target.count()) > 0) {
    await target.screenshot({ path });
    return;
  }
  await page.screenshot({ path });
}

async function captureStates(browser, colorScheme) {
  // 연결 중: 서버가 아직 답하지 않는 그 순간을 붙잡는다.
  {
    const state = {
      session: workSession(),
      grantModes: [],
      returns: [],
      grantHoldMs: 6_000,
    };
    const { context, page } = await openContext(browser, state, { colorScheme });
    try {
      await openDetailViaCard(page);
      await page.getByTestId("work-control-confirm-start").click();
      await page.getByTestId("work-control-busy").waitFor({ timeout: 10_000 });
      await shoot(page, `connecting-${colorScheme}`);
    } finally {
      await context.close();
    }
  }
  // 조작 중.
  {
    const state = { session: workSession(), grantModes: [], returns: [] };
    const { context, page } = await openContext(browser, state, { colorScheme });
    try {
      await openDetailViaCard(page);
      await page.getByTestId("work-control-confirm-start").click();
      await page
        .locator('[data-testid="work-control"][data-phase="controlling"]')
        .waitFor({ timeout: 20_000 });
      // 그림이 도착한 뒤에 찍는다. 「아직 화면이 도착하지 않았습니다」도 참인
      // 상태이지만 그것은 **연결 중**의 꼬리이고, 이 사진이 리뷰에 답해야 하는
      // 것은 「조작 중인 화면이 어떻게 보이는가」다.
      await page
        .getByTestId("work-control-state")
        .waitFor({ state: "detached", timeout: 10_000 })
        .catch(() => {});
      await page.waitForTimeout(400);
      await shoot(page, `controlling-${colorScheme}`);

      // 키보드가 이 화면을 떠난 판 (design-review H-2). 창은 그대로 열려 있고
      // 낱말만 달라진다 — 그 구분이 사진으로 읽히는지가 이 장의 질문이다.
      await page.evaluate(() => {
        const surface = document.querySelector(
          '[data-testid="work-control-surface"]'
        );
        if (surface instanceof HTMLElement) surface.blur();
      });
      await page.getByTestId("work-control-keyboard-lost").waitFor({ timeout: 5_000 });
      await shoot(page, `keyboard-lost-${colorScheme}`);
      await page.getByTestId("work-control-surface").focus();

      // 반환 중: DELETE 를 붙들어 그 상태를 사진에 남긴다.
      state.returnHoldMs = 6_000;
      await page.getByTestId("work-control-return").click();
      await page
        .locator('[data-testid="work-control"][data-phase="returning"]')
        .waitFor({ timeout: 10_000 });
      await shoot(page, `returning-${colorScheme}`);
    } finally {
      await context.close();
    }
  }
  // 초대와 확인 (design-review M2). 사람이 이 화면에서 **가장 먼저** 보는 두
  // 장이고, 앞 판의 캡처는 조작이 이미 시작된 뒤부터였다 — 그래서 「무엇을
  // 감수하는지」를 말하는 문단이 리뷰에 한 번도 오르지 않았다.
  {
    const state = { session: workSession(), grantModes: [], returns: [] };
    const { context, page } = await openContext(browser, state, { colorScheme });
    try {
      await login(page);
      await page.getByTestId("channel-item").first().click();
      // 딥링크를 타지 않고 들어와, 무장되지 않은 초대 그대로를 찍는다.
      await page.evaluate(
        (id) => window.history.pushState({}, "", `?work=${id}`),
        sessionId
      );
      await page.getByTestId("channel-item").first().click();
      await page.getByTestId("handoff-open-session").click();
      await page.getByTestId("work-detail").waitFor({ timeout: 30_000 });
      await page.getByTestId("work-control-confirm").waitFor({ timeout: 10_000 });
      await shoot(page, `invite-confirm-${colorScheme}`);
      await page.getByTestId("work-control-confirm-cancel").click();
      await page.getByTestId("work-control-start").waitFor({ timeout: 10_000 });
      await shoot(page, `invite-${colorScheme}`);
    } finally {
      await context.close();
    }
  }
  // 반환이 실패한 판 (design-review M2). 이 화면이 유일하게 lease 를 말하는
  // 자리이고, 그 문장이 어떤 격으로 서는지는 사진으로만 확인된다.
  {
    const state = {
      session: workSession(),
      grantModes: [],
      returns: [],
      failReturn: true,
    };
    const { context, page } = await openContext(browser, state, { colorScheme });
    try {
      await openDetailViaCard(page);
      await page.getByTestId("work-control-confirm-start").click();
      await page
        .locator('[data-testid="work-control"][data-phase="controlling"]')
        .waitFor({ timeout: 20_000 });
      await page.getByTestId("work-control-return").click();
      await page
        .getByTestId("work-control-return-failed")
        .waitFor({ timeout: 20_000 });
      await shoot(page, `return-failed-${colorScheme}`);
    } finally {
      await context.close();
    }
  }
  // 실패: 창을 이미 누군가 잡고 있다(409).
  {
    const state = {
      session: workSession(),
      grantModes: [],
      returns: [],
      grantStatus: 409,
    };
    const { context, page } = await openContext(browser, state, { colorScheme });
    try {
      await openDetailViaCard(page);
      await page.getByTestId("work-control-confirm-start").click();
      await page.getByTestId("work-control-error").waitFor({ timeout: 20_000 });
      await shoot(page, `failed-${colorScheme}`);
    } finally {
      await context.close();
    }
  }
}

/**
 * 오버레이 목업 (§1.4 — 설계만, 구현 0줄).
 *
 * 제품 코드가 아니라 **픽스처 한 장**이고, 문장은 제품에서 읽어 온다
 * (`CONTROL_OVERLAY_MOCKUP`): 스스로 낱말을 지어낸 목업은 제품이 결코 보여 주지
 * 않을 화면을 리뷰하게 만든다.
 */
async function captureOverlayMockup(browser, colorScheme) {
  const fixture = resolve(webRoot, "gates/fixtures/display-control-overlay.html");
  if (!existsSync(fixture)) fail("the overlay mockup fixture is missing");
  const source = readFileSync(
    resolve(webRoot, "src/features/work/controlStream.ts"),
    "utf8"
  );
  const label = source.match(/CONTROL_START_LABEL\s*=\s*"([^"]+)"/)?.[1];
  const invite = source.match(/CONTROL_INVITE_COPY\s*=\s*\n?\s*"([^"]+)"/)?.[1];
  if (!label || !invite) fail("could not read the overlay copy from the product");
  const html = readFileSync(fixture, "utf8");
  if (!html.includes("__CONTROL_START_LABEL__") || !html.includes("__CONTROL_INVITE_COPY__")) {
    fail("the overlay mockup stopped reading its copy from the product");
  }
  // 토큰도 제품의 것이어야 한다 (리뷰 nitpick 3). 목업은 번들 밖이라 tokens.css 를
  // import 할 수 없고 값을 손으로 옮겨 적는데, 그 값이 낡으면 목업은 제품이 아닌
  // 팔레트를 리뷰에 보여 준다 — 그리고 리뷰가 판단하려는 것이 정확히 「이 팔레트
  // 안에서 이 컨트롤이 화면을 얼마나 가리는가」다. 그래서 사본을 대조한다.
  const tokens = readFileSync(
    resolve(webRoot, "src/design/tokens.css"),
    "utf8"
  );
  const copied = [...html.matchAll(/light-dark\((#[0-9a-f]{6}),\s*(#[0-9a-f]{6})\)/g)];
  if (copied.length === 0) fail("the overlay mockup carries no tokens to check");
  for (const [pair] of copied) {
    if (!tokens.includes(pair)) {
      fail(`the overlay mockup's palette drifted from tokens.css: ${pair}`);
    }
  }
  const context = await browser.newContext({
    viewport: { width: 720, height: 620 },
    colorScheme,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  try {
    await page.setContent(
      html
        .replaceAll("__CONTROL_START_LABEL__", label)
        .replaceAll("__CONTROL_INVITE_COPY__", invite)
    );
    await page.waitForTimeout(120);
    mkdirSync(shotsDir, { recursive: true });
    await page.screenshot({
      path: resolve(shotsDir, `overlay-mockup-${colorScheme}.png`),
    });
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------------

async function main() {
  if (!existsSync(resolve(webRoot, "dist/index.html"))) {
    throw new Error("dist/ is missing. Run npm run build first.");
  }
  const server = spawn(
    resolve(webRoot, "node_modules/.bin/vite"),
    ["preview", "--port", String(port), "--strictPort", "--host", "127.0.0.1"],
    { cwd: webRoot, stdio: "ignore" }
  );
  // 이 포트가 **우리 것인가**. 측정으로 들어온 규율이다 (#1563 작업 중):
  // 다른 워크트리에 남아 있던 `vite preview` 가 5193 을 잡고 있으면
  // `--strictPort` 는 우리 서버를 즉시 죽이는데, `stdio: "ignore"` 라 그 실패는
  // 어디에도 뜨지 않고 `waitForServer()` 는 **남의 빌드**를 보고 성공한다. 그러면
  // 이 게이트는 자기 워크트리를 한 줄도 재지 않은 채 초록이 될 수 있다.
  let serverDied = false;
  server.on("exit", () => {
    serverDied = true;
  });
  try {
    await waitForServer();
    // 스폰한 프로세스가 죽었다면 지금 응답하는 것은 우리 dist/ 가 아니다.
    await wait(300);
    if (serverDied) {
      throw new Error(
        `GATE FAIL: port ${port} is already served by another process, so this run would have measured somebody else's build. Free it (lsof -nP -iTCP:${port}) or set DISPLAY_CONTROL_GATE_PORT.`
      );
    }
    const browser = await chromium.launch();
    try {
      await exerciseHappyPath(browser);
      // auto-return 세 경로. 명시 반환은 위에서 이미 지났다.
      await exerciseAutoReturn(browser, {
        script: "silent",
        label: "협상 마감 (producer never offered)",
        expectCopy: "조작 연결이 서지 않아",
      });
      await exerciseAutoReturn(browser, {
        script: "crash",
        label: "producer 소실 (input channel died)",
        expectCopy: "호스트 연결이 끊겨",
      });
      await exerciseAutoReturn(browser, {
        script: "noInput",
        label: "등급과 배선 불일치 (no input channel offered)",
        expectCopy: "입력 채널을 열지 않아",
      });
      await exerciseUnmountDuringGrant(browser);
      await exerciseConsoleIntent(browser);
      await exerciseReturnFailure(browser);
      await exerciseAffordanceAbsence(browser);
      if (wantShots) {
        for (const scheme of ["light", "dark"]) {
          await captureStates(browser, scheme);
          await captureOverlayMockup(browser, scheme);
        }
        console.log(
          "[shots] artifacts/display-control/{invite,invite-confirm,connecting,controlling,keyboard-lost,returning,return-failed,failed}-{light,dark}.png"
        );
        console.log(
          "[shots] artifacts/display-control/overlay-mockup-{light,dark}.png"
        );
      }
    } finally {
      await browser.close();
    }
  } finally {
    server.kill("SIGTERM");
  }
  console.log("GATE PASS: deep-link intent (arms, never opens), controller-only");
  console.log("           grade, producer-opened input channel, keystrokes on the");
  console.log("           wire and on no surface this machine keeps, auto-return");
  console.log("           on all paths, an honest failed return, and absence");
  console.log("           instead of a dead control.");
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
