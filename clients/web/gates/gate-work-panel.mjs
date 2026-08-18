#!/usr/bin/env node
// GATE: WEB-WP1 「작업 패널」 v0 (결정 정본 docs/planning/2026-08-04-work-panel-design.md).
//
// 이 게이트가 지키는 것은 화면의 모양이 아니라 **패널이 하는 말이 참인가**이다.
//
//   1. 도착 순서       `text_delta` 3프레임이 도착한 순서대로 한 문장이 된다.
//   2. phase 전이      `agent.status`의 전이가 줄이 되고, 승인 대기가 작업 중으로
//                      번역되지 않는다.
//   3. 잘림 고지       run 도중에 붙었으면 "이 지점부터 관전"을 먼저 적는다.
//   4. 휘발            닫았다 열면 그 시점부터 다시 쌓인다(D1). 닫힌 동안의
//                      프레임을 나중에 있었던 척하지 않는다.
//   5. 인자 불투명     `tool_call_args`의 **값**은 접혀 있든 펼쳐져 있든 화면에
//                      오지 않는다(design-taste-web §9, agentCardModel 계약).
//                      이름과 개수만 접힘 뒤에 있다.
//
// 세 시나리오는 REST 응답 지연과 프레임 간격을 서로 다르게 흔든다(지연 편차 목).
// 마지막 시나리오는 패널을 열기 **전에** 도구 프레임을 흘려 보내, 패널이 못 본
// 것을 봤다고 말하지 않는지 확인한다.
//
// 이름 붙은 red proof (버릴 워크트리에서만 돌린다):
//   WORK_PANEL_GATE_PROVE_RED_ORDER=1 npm run gate:work-panel
//     expected failure: "delta order"
//   WORK_PANEL_GATE_PROVE_RED_ARGS=1 npm run gate:work-panel
//     expected failure: "argument value reached the screen"
//   WORK_PANEL_GATE_PROVE_RED_FOLD=1 npm run gate:work-panel
//     expected failure: "tool args folded by default"
//   WORK_PANEL_GATE_PROVE_RED_VOLATILE=1 npm run gate:work-panel
//     expected failure: "a closed panel kept (or backfilled) history"
//   WORK_PANEL_GATE_PROVE_RED_COOPEN=1 npm run gate:work-panel
//     expected failure: "the thread pane stayed beside the work panel"
//   WORK_PANEL_GATE_PROVE_RED_LIVE=1 npm run gate:work-panel
//     expected failure: "the 1Hz elapsed clock sits inside a live region"
//   WORK_PANEL_GATE_PROVE_RED_PANE=1 npm run gate:work-panel
//     expected failure: "the chat column was squeezed to 236px of composer"
//   WORK_PANEL_GATE_PROVE_RED_PLACEHOLDER=1 npm run gate:work-panel
//     expected failure: "the empty composer overflows its own box"
//   WORK_PANEL_GATE_PROVE_RED_CLAUSE=1 npm run gate:work-panel
//     expected failure: "the mention affordance is still in the box"
//   WORK_PANEL_GATE_PROVE_RED_KEEPALL=1 npm run gate:work-panel
//     expected failure: "may break inside a word"
//   WORK_PANEL_GATE_PROVE_RED_RULER=1 npm run gate:work-panel
//     expected failure: "The probe measured with a STALE font"
//   WORK_PANEL_GATE_PROVE_RED_THREAD=1 npm run gate:work-panel
//     expected failure: "the channel composer was squeezed to 26px"
//   WORK_PANEL_GATE_PROVE_RED_THREAD_INERT=1 npm run gate:work-panel
//     expected failure: "covered the channel but left it in the tab order"
//   WORK_PANEL_GATE_PROVE_RED_THREAD_ESCAPE=1 npm run gate:work-panel
//     expected failure: "Escape inside the reply composer did not close"
//   WORK_PANEL_GATE_PROVE_RED_THREAD_FOCUS=1 npm run gate:work-panel
//     expected failure: "left focus on ... instead of the control that opened it"
//
// red seam은 **목/드라이버의 행동만** 바꾼다. ORDER는 델타를 거꾸로 발행하고,
// ARGS는 값 마커를 화면에 실제로 그려지는 자리(도구 이름)에 심어 "값은 절대
// 화면에 없다" 단언이 DOM을 읽고 있음을 증명하고, FOLD는 검사 전에 디스클로저를
// 먼저 펼치고, VOLATILE은 다시 연 패널에 지나간 문장을 되쏜다. PANE과
// PLACEHOLDER는 스타일시트를 지우지 않고 **한 겹 덮어써서**(`--spacing-chat-min`
// 을 0으로, 플레이스홀더 클램프를 해제) 수리 이전의 렌더를 그 자리에 되돌린다.
// CLAUSE는 절 단위 생략(#1422)을 끄는 대신 그 **결과**를 되돌린다: 드라이버가
// 버려진 뒷절을 속성에 도로 이어 붙인다. PLACEHOLDER도 이제 그것을 함께 한다 —
// 수리 후 화면에 서는 짧은 문장은 클램프를 벗겨도 넘칠 것이 없어서, 옛 렌더는
// 「옛 문자열 + 옛 클램프」 둘 다여야 한다. THREAD도 같은 방식으로 스레드 패널의
// 문턱을 600px로 되돌리고, THREAD_INERT는 드라이버가 `inert` 속성만 떼어 낸다.
// RULER는 프로브의 글자 크기를 `!important`로 못 박아(작성자 선언이 인라인을
// 이긴다) 「효과에서 한 번만 복사한 자」를 그 자리에 되돌린다. THREAD_ESCAPE는
// window 캡처 단계에서 Escape를 삼켜(핸들러 없던 때처럼) 서랍이 닫히지 않게 하고,
// THREAD_FOCUS는 닫힌 뒤 활성 요소를 blur해(포커스 반환 없던 때처럼) 캐럿을
// document.body로 떨어뜨린다 — 둘 다 제품이 아니라 드라이버가 #1431 수리 이전의
// **행동**을 그 자리에 되돌린다.
// 제품 소스 줄을 지우거나 단언을 빼라고 요구하지 않으므로 증명은 반복 가능하다.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "./preview-guard.mjs";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.WORK_PANEL_GATE_PORT || 5189);
const origin = `http://127.0.0.1:${port}`;
const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const agentId = "AAAAAAAA-AAAA-7AAA-8AAA-AAAAAAAAA613";
const channelId = "00000000-0000-7000-8000-000000000201";
const runId = "9F1C8B2A-0000-7000-8000-00000000RUN1";

const proveRedOrder = process.env.WORK_PANEL_GATE_PROVE_RED_ORDER === "1";
const proveRedArgs = process.env.WORK_PANEL_GATE_PROVE_RED_ARGS === "1";
const proveRedFold = process.env.WORK_PANEL_GATE_PROVE_RED_FOLD === "1";
const proveRedVolatile = process.env.WORK_PANEL_GATE_PROVE_RED_VOLATILE === "1";
const proveRedCoOpen = process.env.WORK_PANEL_GATE_PROVE_RED_COOPEN === "1";
const proveRedLive = process.env.WORK_PANEL_GATE_PROVE_RED_LIVE === "1";
const proveRedPane = process.env.WORK_PANEL_GATE_PROVE_RED_PANE === "1";
const proveRedPlaceholder =
  process.env.WORK_PANEL_GATE_PROVE_RED_PLACEHOLDER === "1";
const proveRedThread = process.env.WORK_PANEL_GATE_PROVE_RED_THREAD === "1";
const proveRedThreadInert =
  process.env.WORK_PANEL_GATE_PROVE_RED_THREAD_INERT === "1";
const proveRedThreadEscape =
  process.env.WORK_PANEL_GATE_PROVE_RED_THREAD_ESCAPE === "1";
const proveRedThreadFocus =
  process.env.WORK_PANEL_GATE_PROVE_RED_THREAD_FOCUS === "1";
const proveRedClause = process.env.WORK_PANEL_GATE_PROVE_RED_CLAUSE === "1";
const proveRedKeepAll = process.env.WORK_PANEL_GATE_PROVE_RED_KEEPALL === "1";
const proveRedRuler = process.env.WORK_PANEL_GATE_PROVE_RED_RULER === "1";

/**
 * 플레이스홀더의 뒷절 (#1422). **코어에서 읽는다.**
 *
 * 조각을 손으로 적으면 문장이 고쳐지는 날 게이트가 그 수리를 막는다 — 이 레포가
 * `COMPOSER_OFFLINE_COPY` 에서 이미 한 번 배운 것이고(`gate-composer.mjs` 의
 * `composerOfflineCopy()`), `src/features/chat/composerCopy.test.ts` 가 그
 * 습관을 소스로 지킨다.
 */
function mentionAffordance() {
  const source = readFileSync(
    resolve(webRoot, "../../packages/momo-core/src/features/chat/composerCopy.ts"),
    "utf8"
  );
  const match = source.match(/export const MENTION_AFFORDANCE\s*=\s*"([^"]+)"/);
  if (match === null) {
    throw new Error("코어의 MENTION_AFFORDANCE를 읽지 못했다");
  }
  return match[1];
}

/** 절과 절을 잇는 것. 같은 파일에서 같은 방식으로 읽는다. */
function placeholderJoiner() {
  const source = readFileSync(
    resolve(webRoot, "../../packages/momo-core/src/features/chat/composerCopy.ts"),
    "utf8"
  );
  const match = source.match(
    /export const COMPOSER_PLACEHOLDER_JOINER\s*=\s*"([^"]*)"/
  );
  if (match === null) {
    throw new Error("코어의 COMPOSER_PLACEHOLDER_JOINER를 읽지 못했다");
  }
  return match[1];
}

const MENTION_AFFORDANCE = mentionAffordance();
const PLACEHOLDER_JOINER = placeholderJoiner();

const DELTAS = ["배포 로그를 ", "먼저 ", "읽었습니다."];
const DELTA_SENTENCE = DELTAS.join("");
const REOPEN_DELTA = "다시 열고 나서 온 줄입니다.";
const MISSED_DELTA = "닫혀 있는 동안 흘러간 줄입니다.";
const TOOL_NAME = "work.session.end";
const TOOL_ARG_MARKER = "/Users/seongjae/projects/momo/secret-plan.md";
const TOOL_ARG_VALUE = "되돌리기-절차-초안";
const ROOT_MESSAGE = "0199aaaa-0000-7000-8000-0000000000M1";
const REPLY_MESSAGE = "0199aaaa-0000-7000-8000-0000000000M2";

/**
 * 채팅 표면이 아직 쓸 수 있는 폭인가.
 *
 * 숫자의 출처는 이 레포의 기존 실측이다. tokens.css `work-pane`이 문턱을 900px로
 * 올린 이유가 "760px 창이면 채팅에 200px가 남고, 컴포저가 136px로 접히면서
 * placeholder가 두 줄로 감기고 세로로 잘린다"였다. 그러니 부차 표면 둘이 동시에
 * 열렸을 때도 컴포저는 그 실패 폭 위에 있어야 한다.
 */
const MIN_COMPOSER_WIDTH = 240;

/**
 * 「작업 세션」 pane 의 두 측정값 (#1418).
 *
 * `PANE_MEASURE` 는 `--spacing-pane` 이고, **다른 게이트가 그 위에 단언을 세워
 * 두었다**: `gate:my-sessions` 의 좁은 판 호스트 피커는 1280px 창에서 이 pane 이
 * 320px 라는 전제 위에서만 무엇인가를 재고(재개 블록 288px), 그 전제가 깨지면
 * "pane 이 320px 가 아니면 이 단정은 아무것도 재지 않는다" 로 스스로 붉는다.
 * 그래서 이 게이트는 좁은 티어에서 pane 이 양보하는 것을 재는 동시에 **넓은
 * 티어에서 320px 가 그대로 서는 것**도 함께 잰다. 둘은 같은 규칙의 양쪽 끝이고,
 * 한 파일에서 함께 재야 다음 사람이 한쪽만 옮기지 않는다.
 *
 * `PANE_FLOOR` 는 `--spacing-pane-sm` 이다. 양보에도 바닥이 있다: 그 아래로는
 * 목록이 목록으로 읽히지 않으므로, 채팅이 넓어지는 값이 아니라 둘 다 지는 값이다.
 */
const PANE_MEASURE = 320;
const PANE_FLOOR = 192;

const session = {
  accessToken: "gate-only-not-a-credential",
  refreshToken: "gate-only-not-a-credential",
  member: {
    id: memberId,
    workspaceId,
    kind: "human",
    displayName: "곽성재",
    handle: "seongjae",
  },
  realtimeWebSocketUrl: "ws://work-panel-gate.invalid/connection/websocket",
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
    id: agentId,
    workspaceId,
    kind: "agent",
    status: "active",
    role: "member",
    displayName: "김인턴",
    handle: "kim-intern",
    channelCount: 1,
    channelIds: [channelId],
    capabilities: ["work.observe"],
    ownerHumanId: memberId,
    agentModel: "hermes-agent",
    createdAtMs: 0,
    updatedAtMs: 0,
  },
];

const channels = [
  {
    id: channelId,
    workspaceId,
    kind: "public",
    name: "release-2026-08",
    muted: false,
  },
];

/**
 * 머리 절 하나도 안 드는 방 이름 (#1422 design-review H1).
 *
 * 위 이름보다 넉 자 길다. 그 넉 자가 경계를 넘긴다 — 900px 창에서 pane 을 열면
 * 컴포저의 글 폭이 238px 인데, 이 이름의 머리 절(「…에 메시지 보내기」)은 그보다
 * 넓다. 즉 **절 단위 생략이 더 이상 할 수 있는 일이 없는 띠**이고, 리뷰가 실측한
 * 그 자리에서 남던 줄이 「…에 메시지 보내」였다(`보내기` 를 `보내`/`기` 로 끊은 것).
 *
 * 픽스처를 통째로 바꾸지 않고 이름만 갈아 끼우는 이유: 다른 시나리오들이 이 방의
 * 이름 위에 자기 단언을 세워 두지 않았고(그쪽은 seq·프레임을 잰다), 이 띠에서
 * 달라지는 것은 오직 **글자 폭** 하나여야 비교가 성립한다.
 */
const LONG_CHANNEL_NAME = "release-2026-08-hotfix";

function channelsFor(scenario) {
  if (scenario.longChannelName !== true) return channels;
  return channels.map((channel) => ({ ...channel, name: LONG_CHANNEL_NAME }));
}

const root = {
  id: ROOT_MESSAGE,
  channelId,
  seq: 41,
  hlcTs: 1_785_238_400_000,
  hlcCount: 0,
  authorMemberId: memberId,
  type: "text",
  body: "배포 되돌리기 절차부터 확인해 줘.",
  state: "sent",
  createdAtMs: 1_785_238_400_000,
  thread: { reply_count: 2, last_reply_seq: 43, last_reply_at: 1_785_238_460_000 },
};

const reply = {
  id: REPLY_MESSAGE,
  channelId,
  rootId: ROOT_MESSAGE,
  seq: 42,
  hlcTs: 1_785_238_430_000,
  hlcCount: 0,
  authorMemberId: agentId,
  type: "text",
  body: "롤백 스크립트와 마지막 정상 배포를 먼저 봤습니다.",
  state: "sent",
  createdAtMs: 1_785_238_430_000,
};

const scenarios = [
  { name: "burst", roster: 20, channels: 20, frameGapMs: 0, toolBeforeOpen: false },
  { name: "slow-roster", roster: 280, channels: 40, frameGapMs: 120, toolBeforeOpen: false },
  { name: "pre-open-tool", roster: 40, channels: 280, frameGapMs: 40, toolBeforeOpen: true },
];

/**
 * 부차 표면 둘이 동시에 열린 900px 창 (리뷰 M-2). 사이드바 240 + 스레드 320 +
 * 작업 패널 320 = 880이 크롬이므로 산술상 채팅에 20px가 남는다. 산술이 곧 렌더는
 * 아니므로(둘 다 `shrink-0`이고 채팅 열은 `min-w-0`이다) **실렌더로** 잰다.
 */
const CO_OPEN_SCENARIO = {
  name: "co-open-900",
  roster: 20,
  channels: 20,
  frameGapMs: 0,
  toolBeforeOpen: false,
  withThread: true,
};

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
            replies.push({
              id: command.id,
              connect: { client: "work-panel-gate", version: "6" },
            });
          } else if (command.subscribe) {
            this.subscriptions.add(command.subscribe.channel);
            replies.push({
              id: command.id,
              subscribe: {
                recoverable: true,
                positioned: true,
                // `recovered: false`가 load-bearing이다. true면 웹 레일의 replay
                // gate가 이 배치를 통째로 버리고(agent 네임스페이스는
                // force_recovery다) 게이트는 아무 프레임도 못 본다.
                recovered: false,
                epoch: "work-panel-gate",
                offset,
              },
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
            new MessageEvent("message", {
              data: replies.map((reply) => JSON.stringify(reply)).join("\n"),
            })
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
    // 실제 Centrifugo는 24h 히스토리를 들고 있어서 늦게 붙은 구독자도 지나간
    // 프레임을 받는다. 이 목에는 히스토리가 없으므로, 레일이 아직 명부를
    // 기다리는 동안(느린 roster 시나리오) 발행한 프레임은 영영 사라진다. 그
    // 차이는 제품이 아니라 목의 성질이므로, 드라이버가 구독을 기다린다.
    window.__workPanelGateAgentSubscribed = () => {
      for (const socket of sockets) {
        for (const channelName of socket.subscriptions) {
          if (channelName.startsWith("agent:")) return true;
        }
      }
      return false;
    };
    // `agent:` 네임스페이스에만 흘린다. 같은 소켓이 메시지 채널도 들고 있어서,
    // 전부에 뿌리면 타임라인 핸들러가 자기 것이 아닌 프레임을 읽게 된다.
    window.__workPanelGatePublish = (frame) => {
      offset += 1;
      const stamped = { ...frame, ts: frame.ts ?? Date.now() };
      for (const socket of sockets) {
        for (const channelName of socket.subscriptions) {
          if (!channelName.startsWith("agent:")) continue;
          socket.onmessage?.(
            new MessageEvent("message", {
              data: JSON.stringify({
                push: {
                  channel: channelName,
                  pub: { data: stamped, offset },
                },
              }),
            })
          );
        }
      }
    };
  });
}

async function installRoutes(context, scenario) {
  await context.route("**/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/v1/auth/login") return json(route, session);
    if (path === "/v1/auth/realtime-token") {
      return json(route, {
        token: "gate-realtime-token",
        tokenType: "Bearer",
        expiresAtMs: Date.now() + 60_000,
        ttlSeconds: 60,
        workspaceId,
        memberId,
      });
    }
    if (path === "/v1/auth/refresh") {
      return json(route, {
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
      });
    }
    if (path.endsWith("/roster")) {
      await wait(scenario.roster);
      return json(route, { members: roster });
    }
    if (path.endsWith("/channels")) {
      await wait(scenario.channels);
      return json(route, { channels: channelsFor(scenario) });
    }
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/replies")) {
      return json(route, { messages: [reply] });
    }
    if (path.includes("/messages")) {
      // 스레드 진입점을 그리려면 답글 롤업이 달린 글이 하나 있어야 한다
      // (MessageRow의 `thread-anchor`는 롤업이 있을 때만 버튼이 된다).
      return json(route, { messages: scenario.withThread ? [root] : [] });
    }
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    // 세션 원장과 호스트 명부. 키 이름은 계약이 정한 것을 그대로 쓴다 (#1418):
    // `sessions` 로 답하던 앞 판은 `fetchWorkSessions` 가 읽는 `workSessions` 와
    // 어긋나 pane 을 오류 배너로 세웠고, 이 게이트의 기존 시나리오는 그 pane 을
    // 연 적이 없어 아무도 몰랐다. 폭을 재는 데는 상관없지만 리뷰 캡처는 상관있다:
    // 잰 판과 찍은 판이 달라진다.
    if (path.endsWith("/work-sessions")) return json(route, { workSessions: [] });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: [] });
    return json(route, {});
  });
}

function statusFrame(phase, runStatus, extra = {}) {
  return {
    type: "agent.status",
    v: 1,
    payload: {
      run_id: runId,
      agent_member_id: agentId,
      channel_id: channelId,
      phase,
      run_status: runStatus,
      ...extra,
    },
  };
}

function partialFrame(payload) {
  return {
    type: "agent.partial",
    v: 1,
    payload: { run_id: runId, channel_id: channelId, ...payload },
  };
}

async function publish(page, frame) {
  await page.evaluate((f) => window.__workPanelGatePublish(f), frame);
}

async function login(page) {
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.getByTestId("login-email").fill("work-panel@example.test");
  await page.getByTestId("login-password").fill("gate-only");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-item").first().waitFor();
  await page.getByTestId("channel-item").first().click();
  await page.waitForFunction(() => window.__workPanelGateAgentSubscribed(), undefined, {
    timeout: 15_000,
  });
}

/** 패널 안에 쌓인 텍스트 항목을 도착 순서대로 이어 붙인 것. */
async function panelText(page) {
  return page
    .locator('[data-testid="agent-work-panel-entry"][data-kind="text"]')
    .evaluateAll((nodes) =>
      nodes
        .sort(
          (a, b) => Number(a.dataset.seq ?? 0) - Number(b.dataset.seq ?? 0)
        )
        .map((node) => node.textContent ?? "")
        .join("")
    );
}

async function openPanelFromComposer(page) {
  await page.getByTestId("composer-working-open").first().waitFor();
  await page.getByTestId("composer-working-open").first().click();
  await page.getByTestId("agent-work-panel").waitFor();
}

async function exerciseScenario(browser, scenario) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await installRealtimeSocket(page);
  await installRoutes(context, scenario);
  await login(page);

  const label = scenario.name;

  // 레일은 run이 열리는 것을 처음부터 보고 있다: 여는 프레임이 활동 줄의 시계를
  // 만들고, 그 시계가 패널로 넘어간다(패널 자신은 얻을 수 없는 값이다).
  await publish(page, statusFrame("queued", "queued"));
  // 그 다음 패널이 붙는다. v0에서 이것이 유일한 진입 경로이고, 그래서 잘림 고지가
  // 예외가 아니라 기본값이다.
  await publish(page, statusFrame("streaming", "running", { spent_micro_usd: 1_200 }));

  if (scenario.toolBeforeOpen) {
    await publish(
      page,
      partialFrame({
        tool_call_id: "call-before-open",
        tool_call_name: "fs.read",
        tool_call_args: { path: "/tmp/before-open" },
      })
    );
    await wait(scenario.frameGapMs + 40);
  }

  await openPanelFromComposer(page);

  // ---- 1. 도착 순서 --------------------------------------------------------
  // 패널이 붙기 전에 지나간 `streaming` 프레임은 로그에 없다(그것이 잘림 고지의
  // 근거다). 여기서부터가 이 패널이 실제로 본 것이다.
  await publish(page, statusFrame("thinking", "running"));
  const order = proveRedOrder ? [...DELTAS].reverse() : DELTAS;
  for (const slice of order) {
    await publish(page, partialFrame({ text_delta: slice }));
    if (scenario.frameGapMs > 0) await wait(scenario.frameGapMs);
  }
  await page.getByTestId("agent-work-panel-entries").waitFor();
  await page.waitForFunction(
    (expected) =>
      (document.querySelector('[data-testid="agent-work-panel-entry"][data-kind="text"]')
        ?.textContent ?? "").length >= expected,
    DELTA_SENTENCE.length,
    { timeout: 5_000 }
  ).catch(() => {
    // 길이 대기는 편의일 뿐이다. 실제 판정은 아래 문자열 비교가 한다.
  });
  const streamed = await panelText(page);
  if (!streamed.includes(DELTA_SENTENCE)) {
    throw new Error(
      `${label}: delta order — expected "${DELTA_SENTENCE}", panel read "${streamed}"`
    );
  }

  // ---- 1b. 읽어 주는 것과 읽어 주지 않는 것 ----------------------------------
  // 상태 칩은 live 영역이고, 1Hz 경과 시계는 그 **바깥**이다. live 영역을 헤더
  // 줄 전체로 잡으면 보조기술이 초당 한 번 숫자를 낭독한다 — 컴포저 진입점
  // 버튼에서 접근성 이름을 명시해 피한 함정의 live 판본이라, 같은 실수를 다른
  // 문법으로 되풀이하지 않도록 DOM으로 잠근다.
  if (proveRedLive) {
    // red seam: 드라이버가 DOM에서 live 영역을 헤더 줄로 끌어올린다(고치기 전
    // 모양). 아래 단언이 DOM을 읽고 있다면 반드시 깨진다. 제품 소스는 그대로다.
    await page.evaluate(() => {
      const chip = document.querySelector('[data-testid="agent-work-panel-state"]');
      chip?.removeAttribute("aria-live");
      chip?.parentElement?.setAttribute("aria-live", "polite");
    });
  }
  const liveRegions = await page.evaluate(() => {
    const closestLive = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return "missing";
      return node.closest("[aria-live]") === null ? "outside" : "inside";
    };
    return {
      state: closestLive('[data-testid="agent-work-panel-state"]'),
      elapsed: closestLive('[data-testid="agent-work-panel-elapsed"]'),
    };
  });
  if (liveRegions.state !== "inside") {
    throw new Error(
      `${label}: the state chip must be a live region (it is the fact a reader is waiting on), got "${liveRegions.state}"`
    );
  }
  if (liveRegions.elapsed === "inside") {
    throw new Error(
      `${label}: the 1Hz elapsed clock sits inside a live region, so assistive tech reads a number once a second`
    );
  }

  // ---- 2. 잘림 고지 --------------------------------------------------------
  const truncated = await page.getByTestId("agent-work-panel-truncated").count();
  if (truncated !== 1) {
    throw new Error(
      `${label}: mid-run attach must state "이 지점부터 관전", found ${truncated} notices`
    );
  }
  if (scenario.toolBeforeOpen) {
    const body = (await page.getByTestId("agent-work-panel").textContent()) ?? "";
    if (body.includes("/tmp/before-open") || body.includes("fs.read")) {
      throw new Error(
        `${label}: a frame that arrived before the panel opened was rendered as observed`
      );
    }
  }

  // ---- 3. 도구 단계와 인자 불투명 -------------------------------------------
  await publish(page, statusFrame("streaming", "running"));
  await publish(
    page,
    partialFrame({
      tool_call_id: "call-1",
      // red seam: 값 마커를 실제로 렌더되는 자리(도구 이름)에 심는다. 아래
      // "값은 화면 어디에도 없다" 단언이 DOM을 읽고 있다면 반드시 깨진다.
      tool_call_name: proveRedArgs ? TOOL_ARG_MARKER : TOOL_NAME,
      tool_call_args: { session: TOOL_ARG_VALUE, path: TOOL_ARG_MARKER },
      tool_call_args_truncated: true,
      spent_micro_usd: 4_800,
    })
  );
  await page.getByTestId("agent-work-panel-args-toggle").waitFor();
  if (proveRedFold) {
    // red seam: 검사 전에 사람이 펼친 척한다. 접힘 단언이 살아 있다면 여기서
    // 반드시 깨진다.
    await page.getByTestId("agent-work-panel-args-toggle").click();
    await page.getByTestId("agent-work-panel-args").waitFor();
  }
  if ((await page.getByTestId("agent-work-panel-args").count()) !== 0) {
    throw new Error(
      `${label}: tool args folded by default — the disclosure body was present without an explicit expand`
    );
  }
  const foldedBody =
    (await page.getByTestId("agent-work-panel").textContent()) ?? "";
  if (!proveRedArgs && !foldedBody.includes(TOOL_NAME)) {
    throw new Error(`${label}: tool step must state its name (${TOOL_NAME})`);
  }
  if (!proveRedFold) {
    await page.getByTestId("agent-work-panel-args-toggle").click();
  }
  await page.getByTestId("agent-work-panel-args").waitFor();
  const expandedBody =
    (await page.getByTestId("agent-work-panel").textContent()) ?? "";
  // 펼쳐도 값은 오지 않는다. 이름과 숨김 개수만 온다(design-taste-web §9).
  for (const secret of [TOOL_ARG_MARKER, TOOL_ARG_VALUE]) {
    if (expandedBody.includes(secret)) {
      throw new Error(
        `${label}: argument value reached the screen ("${secret}"), folded or not`
      );
    }
  }
  if (!expandedBody.includes("session") || !expandedBody.includes("path")) {
    throw new Error(
      `${label}: an expanded disclosure must still name the argument fields`
    );
  }
  const withheld = await page
    .getByTestId("agent-work-panel-args-withheld")
    .textContent();
  if (!withheld || !withheld.includes("2")) {
    throw new Error(
      `${label}: the count of withheld argument values must be stated, read "${withheld}"`
    );
  }
  const cost = await page.getByTestId("agent-work-panel-cost").textContent();
  if (!cost || !cost.includes("$")) {
    throw new Error(`${label}: cost snapshot missing, read "${cost}"`);
  }
  // 시계는 관전을 시작한 순간이 아니라 턴이 시작된 순간에서 센다. 패널이 붙은
  // 시점보다 앞선 값이어야 하고, 못 봤으면 아예 없어야 한다.
  const elapsed = await page.getByTestId("agent-work-panel-elapsed").count();
  if (elapsed !== 1) {
    throw new Error(
      `${label}: the turn clock the activity line already had did not reach the panel`
    );
  }

  // ---- 4. phase 전이, 승인 대기 ≠ 작업 중 -----------------------------------
  await publish(page, statusFrame("thinking", "awaiting_approval"));
  await page.waitForFunction(() => {
    const node = document.querySelector('[data-testid="agent-work-panel-state"]');
    return node?.getAttribute("data-state") === "awaiting_approval";
  }, undefined, { timeout: 5_000 });
  const phases = await page
    .locator('[data-testid="agent-work-panel-phase"]')
    .evaluateAll((nodes) => nodes.map((node) => node.textContent?.trim() ?? ""));
  const expectedPhases = ["생각 중", "답을 쓰는 중", "승인 대기"];
  for (const phase of expectedPhases) {
    if (!phases.includes(phase)) {
      throw new Error(
        `${label}: phase transition "${phase}" missing, read ${JSON.stringify(phases)}`
      );
    }
  }
  const positions = expectedPhases.map((phase) => phases.indexOf(phase));
  if (positions.some((value, index) => index > 0 && value < positions[index - 1])) {
    throw new Error(
      `${label}: phase transitions arrived out of order, read ${JSON.stringify(phases)}`
    );
  }
  const stateText = await page
    .getByTestId("agent-work-panel-state")
    .textContent();
  if (stateText?.trim() !== "승인 대기") {
    throw new Error(
      `${label}: awaiting_approval was rendered as "${stateText}" instead of 승인 대기`
    );
  }

  // ---- 5. 닫으면 휘발, 다시 열면 라이브부터 (D1) -----------------------------
  await page.getByTestId("agent-work-panel-close").click();
  await page.getByTestId("agent-work-panel").waitFor({ state: "detached" });
  await publish(page, partialFrame({ text_delta: MISSED_DELTA }));
  await wait(scenario.frameGapMs + 60);
  await openPanelFromComposer(page);
  if (proveRedVolatile) {
    // red seam: 다시 연 패널에 지나간 문장을 되쏜다. 아래 단언이 살아 있다면
    // "다시 열면 그 시점부터"가 화면에서 깨진 것을 잡아야 한다.
    for (const slice of DELTAS) await publish(page, partialFrame({ text_delta: slice }));
  }
  await publish(page, partialFrame({ text_delta: REOPEN_DELTA }));
  await page.waitForFunction(
    (needle) =>
      (document.querySelector('[data-testid="agent-work-panel"]')?.textContent ??
        "").includes(needle),
    REOPEN_DELTA,
    { timeout: 5_000 }
  );
  const reopened = await panelText(page);
  if (!reopened.includes(REOPEN_DELTA)) {
    throw new Error(`${label}: reopened panel did not resume from live`);
  }
  if (reopened.includes(DELTA_SENTENCE) || reopened.includes(MISSED_DELTA)) {
    throw new Error(
      `${label}: a closed panel kept (or backfilled) history it does not store (D1)`
    );
  }
  const reopenedTruncated = await page
    .getByTestId("agent-work-panel-truncated")
    .count();
  if (reopenedTruncated !== 1) {
    throw new Error(
      `${label}: a reopened panel must still say it only has the tail`
    );
  }

  // ---- 6. 키보드 경로 -------------------------------------------------------
  await page.keyboard.press("Escape");
  await page.getByTestId("agent-work-panel").waitFor({ state: "detached" });

  await context.close();
}

/**
 * 리뷰용 스크린샷 (SKILL §11). 두 색 구성표를 브라우저 수준에서 흉내 내서
 * `light-dark()`가 제품과 같은 경로로 도는 것을 찍는다. 판정은 하지 않는다 —
 * 게이트가 실패하는 자리가 아니라 사람이 보는 자리다.
 */
async function captureShots(browser) {
  const outDir = resolve(webRoot, "artifacts/work-panel");
  mkdirSync(outDir, { recursive: true });
  for (const scheme of ["light", "dark"]) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      reducedMotion: "reduce",
      colorScheme: scheme,
    });
    const page = await context.newPage();
    await installRealtimeSocket(page);
    await installRoutes(context, scenarios[0]);
    await login(page);
    await publish(page, statusFrame("queued", "queued"));
    await publish(
      page,
      statusFrame("streaming", "running", { spent_micro_usd: 1_200 })
    );
    await openPanelFromComposer(page);
    await publish(page, statusFrame("thinking", "running"));
    for (const slice of DELTAS) await publish(page, partialFrame({ text_delta: slice }));
    await publish(page, statusFrame("streaming", "running"));
    await publish(
      page,
      partialFrame({
        tool_call_id: "call-1",
        tool_call_name: TOOL_NAME,
        tool_call_args: { session: "A", path: TOOL_ARG_MARKER },
        tool_call_args_truncated: true,
        spent_micro_usd: 4_800,
      })
    );
    await publish(page, statusFrame("thinking", "awaiting_approval"));
    await page.getByTestId("agent-work-panel-args-toggle").waitFor();
    await page.screenshot({ path: resolve(outDir, `work-panel-${scheme}.png`) });
    await context.close();
  }
  console.log(`[shots] artifacts/work-panel/work-panel-{light,dark}.png`);
}

/**
 * 「작업 세션」 pane 의 리뷰용 스크린샷 (#1418). 판정하지 않는다.
 *
 * 문턱 전후를 함께 찍는다: 900px 은 pane 이 폭을 내는 구간이고 928px 부터는 내지
 * 않으므로, 두 장이 나란히 있어야 「무엇이 얼마나 움직였나」를 사람이 볼 수 있다.
 * 빈 컴포저를 프레임 안에 두는 것도 의도다 — 이 티켓이 고친 둘째 결함이 정확히
 * 그 상자의 아래 테두리에서 보이던 것이라, 그 자리가 안 찍힌 캡처는 증거가 아니다.
 */
async function captureWorkPaneShots(browser) {
  // 표면 이름으로 부른다(형제 레인 `artifacts/work-panel/`과 같은 관례). 티켓
  // 번호를 단 증거 경로는 그 티켓이 닫히는 날 찾을 수 없는 경로가 된다.
  const outDir = resolve(webRoot, "artifacts/work-pane");
  mkdirSync(outDir, { recursive: true });
  for (const width of [900, 1280]) {
    for (const scheme of ["light", "dark"]) {
      const context = await browser.newContext({
        viewport: { width, height: 800 },
        reducedMotion: "reduce",
        colorScheme: scheme,
      });
      const page = await context.newPage();
      await installRealtimeSocket(page);
      await installRoutes(context, CO_OPEN_SCENARIO);
      await login(page);
      await page.getByTestId("open-work-panel").click();
      await page.getByTestId("work-panel").waitFor();
      // 목록이 자리를 잡은 뒤에 찍는다. 골격 막대가 서 있는 순간을 찍으면 두 번
      // 돌릴 때마다 다른 판이 나오고, 전후 비교가 조명 비교가 된다.
      await page.getByTestId("work-panel-empty").waitFor();
      await page.screenshot({
        path: resolve(outDir, `work-pane-${width}-${scheme}.png`),
      });
      await context.close();
    }
  }
  console.log(`[shots] artifacts/work-pane/work-pane-{900,1280}-{light,dark}.png`);
}

/**
 * 스레드 패널과 작업 패널을 동시에 열고 채팅 표면이 남는 폭을 실렌더로 잰다.
 *
 * 셋은 서로 다른 상자에 산다: 사이드바는 셸 그리드, 스레드는 채팅 표면 안쪽,
 * 작업 패널은 라우트 상자 옆. 그래서 "동시에 열릴 수 없다"는 보장이 어디에도
 * 없고, 산술로는 900px 창에서 채팅에 20px가 남는다. 그 산술이 실제로 무는지는
 * 브라우저만 안다.
 */
async function exerciseCoOpen(browser) {
  const scenario = CO_OPEN_SCENARIO;
  const context = await browser.newContext({
    viewport: { width: 900, height: 800 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await installRealtimeSocket(page);
  await installRoutes(context, scenario);
  await login(page);

  await publish(page, statusFrame("queued", "queued"));
  await publish(page, statusFrame("streaming", "running"));

  // 스레드를 먼저 연다. 답글 롤업이 달린 글의 「답글 N개」가 그 진입점이다.
  await page.getByTestId("thread-anchor").first().click();
  await page.getByTestId("thread-panel").waitFor();

  // red seam: 작업 패널을 열지 않는다. 스레드가 그대로 남으므로 아래 "부차 표면은
  // 하나" 단언이 살아 있다면 반드시 깨진다.
  if (!proveRedCoOpen) await openPanelFromComposer(page);

  // 규칙: 부차 표면은 한 번에 하나. 작업 패널이 열려 있는 동안 채팅 표면의
  // 부차 패널은 **물러난다**(닫히는 것이 아니라 가려진다 — 스레드가 작업 세션
  // 패널을 가리는 것과 같은 방식이다).
  if ((await page.getByTestId("thread-panel").count()) !== 0) {
    throw new Error(
      `${scenario.name}: the thread pane stayed beside the work panel; two secondary panes at 900px leave the chat surface unusable`
    );
  }

  const composer = await page.getByTestId("composer-input").boundingBox();
  const width = composer?.width ?? 0;
  console.log(
    `[co-open] 900px 창, 스레드 열어 둔 채 작업 패널 개방 -> 컴포저 ${Math.round(width)}px`
  );
  if (width < MIN_COMPOSER_WIDTH) {
    throw new Error(
      `${scenario.name}: the chat surface was squeezed to ${Math.round(
        width
      )}px of composer (floor ${MIN_COMPOSER_WIDTH}px). A secondary pane must not push the primary surface out of usable width (tokens.css work-pane).`
    );
  }

  // 물러난 것이지 버려진 것이 아니다: 작업 패널을 닫으면 읽던 스레드가 그
  // 자리에 돌아온다. 이것이 "가린다"와 "닫는다"의 차이이고, 사람이 클릭 한
  // 번으로 잃을 수 있는 것이 무엇인지가 거기서 갈린다.
  await page.keyboard.press("Escape");
  await page.getByTestId("agent-work-panel").waitFor({ state: "detached" });
  await page.getByTestId("thread-panel").waitFor();
  await context.close();
}

/**
 * 채팅 표면과 「작업 세션」 pane 이 나란히 선 판 (#1418).
 *
 * 위 `exerciseCoOpen` 이 재는 것과 **다른 상자**다. 저쪽 작업 패널은 라우트 상자의
 * 형제이고(`work-panel-pane`), 이 pane 은 채팅 표면 **안쪽** 열이다. 그래서
 * #1413 이 라우트 상자에 세운 바닥(`route-region`)이 이 판에는 닿지 않았고,
 * 900px 창에서 라우트는 660px 그대로인데 그 안에서 다시 320px 이 빠져 컴포저가
 * 236px 였다. 어느 게이트도 이 조합을 재지 않았다는 것이 결함이 남아 있던 이유다.
 *
 * 여섯 가지를 잰다:
 *   1. 좁은 티어(900px)에서 컴포저가 바닥 위에 있다 — #1418 이 고친 것.
 *   2. 그 양보에 바닥이 있다 — pane 이 `--spacing-pane-sm` 아래로 내려가지 않는다.
 *   3. 넓은 티어(1280px)에서 pane 이 320px 그대로 선다 — `gate:my-sessions` 가
 *      그 위에 세워 둔 좁은 판 호스트 피커 단언과의 정합.
 *   4. 빈 컴포저가 자기 상자를 넘지 않는다 — 넘친 플레이스홀더 줄의 글리프가
 *      아래 테두리 위로 반쯤 드러나던 자리(design-review #1413 Low).
 *   5. 좁은 티어에서 **버려진 것이 절 전체**다 (#1422). 화면에 남은 문장에
 *      뒷절(`MENTION_AFFORDANCE`)의 조각이 하나도 없고, 남은 것은 한 줄이다.
 *   6. 넓은 티어에서는 **버리지 않는다**. 절 단위 생략이 한쪽으로만 실수할 수
 *      없다는 것을 이 짝이 잰다 — 5번만 있으면 "언제나 지운다"도 초록이다.
 *
 * 4번은 픽셀이 아니라 넘침 자체를 잰다: `scrollHeight <= clientHeight` 면 패딩
 * 상자 밖으로 내다볼 것이 없다. 이 단언이 무엇인가를 재고 있는지는 같은 폭에서
 * **문장 전체가** 실제로 두 줄로 접히는지 먼저 확인해서 지킨다 — 안 접히는
 * 폭에서는 4·5번이 언제나 참이고 아무것도 증명하지 않는다. #1422 이후 화면에
 * 서는 것은 이미 접히지 않는 짧은 문장이므로, 프로브가 재는 대상은 **렌더된
 * 문자열이 아니라 절을 다 실은 문장**이다.
 */
/**
 * 플레이스홀더가 **자리를 잡을 때까지** 기다린다 (#1422).
 *
 * pane 이 열리면 컴포저 폭이 줄고, 그 폭은 이 컴포넌트의 렌더가 아니라 형제의
 * 렌더가 바꾼다. 그래서 문장을 다시 고르는 계기는 `ResizeObserver` 이고, 그
 * 콜백은 레이아웃 뒤·페인트 전에 오지만 React 의 커밋은 그 다음이다. 즉 pane 이
 * 열린 **바로 그 프레임**에는 아직 옛 문장이 서 있다.
 *
 * 기다리는 조건이 「짧아졌는가」가 아니라 **「두 프레임 동안 안 변했는가」**인
 * 것이 이 함수의 전부다: 답을 기다리면 뒤의 단언은 자기가 기다린 것을 다시
 * 확인할 뿐이고, 안정을 기다리면 단언은 여전히 자유롭게 틀릴 수 있다.
 */
function settlePlaceholder(page) {
  return page.waitForFunction(
    () =>
      new Promise((resolve) => {
        const input = document.getElementById("composer-input");
        if (input === null) {
          resolve(false);
          return;
        }
        const before = input.getAttribute("placeholder");
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve(input.getAttribute("placeholder") === before);
          });
        });
      })
  );
}

async function exerciseWorkPaneCoOpen(browser, width) {
  const scenario = CO_OPEN_SCENARIO;
  const context = await browser.newContext({
    viewport: { width, height: 800 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await installRealtimeSocket(page);
  await installRoutes(context, scenario);
  await login(page);

  // red seam: 스타일시트를 지우지 않고 한 겹 덮어써서 수리 이전의 렌더로 되돌린다.
  if (proveRedPane) {
    await page.addStyleTag({ content: ":root { --spacing-chat-min: 0px; }" });
  }
  if (proveRedPlaceholder) {
    await page.addStyleTag({
      content:
        "#composer-input::placeholder { max-block-size: none; overflow: visible; }",
    });
  }

  await page.getByTestId("open-work-panel").click();
  await page.getByTestId("work-panel").waitFor();
  await settlePlaceholder(page);

  // red seam (#1422): 절 단위 생략을 **끄지 않고**, 그 결과를 되돌린다 — 상자에
  // 안 드는 문장 전체를 다시 속성에 넣는다. `PLACEHOLDER` 도 같은 일을 먼저
  // 해야 무엇인가를 잰다: 수리 후 화면에 서는 짧은 문장은 클램프를 벗겨도 넘칠
  // 것이 없으므로, 그 seam 은 이제 「옛 문자열 + 옛 클램프」 둘 다여야 옛 렌더다.
  if (proveRedClause || proveRedPlaceholder) {
    await page.evaluate(
      ([joiner, affordance]) => {
        const input = document.getElementById("composer-input");
        const current = input.getAttribute("placeholder") ?? "";
        if (!current.includes(affordance)) {
          input.setAttribute("placeholder", `${current}${joiner}${affordance}`);
        }
      },
      [PLACEHOLDER_JOINER, MENTION_AFFORDANCE]
    );
  }

  const geometry = await page.evaluate(
    ([joiner, affordance]) => {
      const round = (value) => Math.round(value);
      const pane = document.querySelector('[data-testid="work-panel"]');
      const input = document.getElementById("composer-input");
      const paneBox = pane.getBoundingClientRect();
      const inputBox = input.getBoundingClientRect();
      const rendered = input.getAttribute("placeholder") ?? "";

      // 이 폭에서 문장이 실제로 접히는가. 접히지 않는 폭이라면 아래 단언들은
      // 언제나 참이고 아무것도 증명하지 않으므로, 그 사실을 먼저 잰다. 상자를
      // 건드리지 않으려고 같은 글자꼴·같은 콘텐츠 폭의 사본에 재 본다.
      //
      // 두 번 잰다: 화면에 **선** 문자열과, 절을 다 실은 문장. #1422 이후 앞의
      // 것은 이미 짧아져 있으므로 "여기서 넘치는가"에 답할 수 있는 것은 뒤의
      // 것뿐이다.
      const styles = getComputedStyle(input);
      const probe = document.createElement("div");
      for (const property of [
        "fontFamily",
        "fontSize",
        "fontWeight",
        "letterSpacing",
        "lineHeight",
        "wordBreak",
        "whiteSpace",
        "wordSpacing",
      ]) {
        probe.style[property] = styles[property];
      }
      probe.style.position = "absolute";
      probe.style.visibility = "hidden";
      probe.style.inlineSize = `${input.clientWidth - Number.parseFloat(styles.paddingLeft) - Number.parseFloat(styles.paddingRight)}px`;
      document.body.appendChild(probe);
      const line = Number.parseFloat(styles.lineHeight);
      const linesOf = (text) => {
        probe.textContent = text;
        return Math.max(1, Math.round(probe.getBoundingClientRect().height / line));
      };
      const placeholderLines = linesOf(rendered);
      const wholeSentenceLines = linesOf(
        rendered.includes(affordance) ? rendered : `${rendered}${joiner}${affordance}`
      );
      probe.remove();

      return {
        paneWidth: round(paneBox.width),
        paneLeft: round(paneBox.left),
        composerWidth: round(inputBox.width),
        composerValue: input.value,
        clientHeight: input.clientHeight,
        scrollHeight: input.scrollHeight,
        placeholderText: rendered,
        placeholderLines,
        wholeSentenceLines,
      };
    },
    [PLACEHOLDER_JOINER, MENTION_AFFORDANCE]
  );

  console.log(
    `[work-pane] ${width}px 창, 작업 세션 pane 개방 -> pane ${geometry.paneWidth}px · ` +
      `컴포저 ${geometry.composerWidth}px · 플레이스홀더 ${geometry.placeholderLines}줄 ` +
      `(문장 전체 ${geometry.wholeSentenceLines}줄, 빈 상자 ${geometry.scrollHeight}/${geometry.clientHeight}px) ` +
      `"${geometry.placeholderText}"`
  );

  // 이 판이 정말 "나란히 선" 판인가. 문턱 아래에서 pane 은 흐름을 떠나 채팅
  // 표면을 통째로 덮으므로(tokens.css work-pane), 그 판에서는 아래 폭 단언들이
  // 재는 대상이 아예 다르다.
  if (geometry.paneLeft <= 0 || geometry.paneWidth >= width) {
    throw new Error(
      `work-pane-${width}: the pane covered the chat surface instead of standing beside it (left ${geometry.paneLeft}, width ${geometry.paneWidth}); the width assertions below would measure nothing`
    );
  }

  if (geometry.composerWidth < MIN_COMPOSER_WIDTH) {
    throw new Error(
      `work-pane-${width}: the chat column was squeezed to ${geometry.composerWidth}px of composer (floor ${MIN_COMPOSER_WIDTH}px). A pane INSIDE the chat surface must not push the composer out of usable width either (tokens.css chat-region / --spacing-chat-min).`
    );
  }

  // 이 단언은 **오늘 어느 폭에서도 물지 않는다**, 그리고 그것을 적어 두는 것이
  // 이 줄의 값이다: 900px 위에서 pane 이 받는 폭은 `창 - 240 - 368` 이라 언제나
  // 292px 이상이고 192px 은 100px 밖이다. 그래서 형제들과 달리 red seam 이 없다 —
  // 재는 단언이 아니라 **난간**이다. 위 두 측정값(사이드바 240 · 채널 바닥 368)
  // 중 하나라도 커지는 날 이 줄이 먼저 붉어, 「양보」와 「둘 다 지는 것」의 경계가
  // 어디였는지를 그때 말한다. 붉힐 수 없다고 지우면 그 경계가 말없이 사라진다.
  if (geometry.paneWidth < PANE_FLOOR) {
    throw new Error(
      `work-pane-${width}: the pane yielded down to ${geometry.paneWidth}px (floor ${PANE_FLOOR}px, --spacing-pane-sm). Below that the session list stops reading as a list, so this is not a trade, it is both surfaces losing.`
    );
  }

  // 넓은 티어에서는 양보할 이유가 없다. 이 단언이 `gate:my-sessions` 의 좁은 판
  // 호스트 피커(1280px 창, 재개 블록 288px)가 서 있는 전제다.
  if (width >= 928 && geometry.paneWidth !== PANE_MEASURE) {
    throw new Error(
      `work-pane-${width}: the pane stands at ${geometry.paneWidth}px where nothing forces it to yield (expected ${PANE_MEASURE}px, --spacing-pane). gate:my-sessions measures its host picker at that width and reports "pane이 320px가 아니면 이 단정은 아무것도 재지 않는다".`
    );
  }

  if (geometry.composerValue !== "") {
    throw new Error(
      `work-pane-${width}: the composer was not empty, so the placeholder assertion below measures typed text instead`
    );
  }
  // 이 단언들이 실제로 무엇인가를 재고 있는가. 절을 다 실은 문장이 한 줄에 드는
  // 폭에서는 버릴 것도 넘칠 것도 없어 전부 언제나 참이므로, 좁은 티어에서는
  // **문장 전체가 접힌다**는 사실을 먼저 확인한다. 재는 대상이 렌더된 문자열이
  // 아닌 이유가 여기 있다: #1422 이후 그것은 이미 접히지 않는 짧은 문장이다.
  if (width < 928 && geometry.wholeSentenceLines < 2) {
    throw new Error(
      `work-pane-${width}: the whole sentence still fits on one line here (${geometry.wholeSentenceLines}); the clause and overflow assertions below prove nothing at this width`
    );
  }
  // 이 줄이 #1422 체제에서도 **살아 있는** 단언인가 — 독립 리뷰가 죽었다고 봤고,
  // 그래서 현 HEAD 에서 두 seam 을 따로 돌려 재 봤다(900px, 픽스처 `release-2026-08`):
  //
  //   green                     빈 상자 39/39px · 플레이스홀더 1줄
  //   PROVE_RED_CLAUSE=1        빈 상자 39/39px · 플레이스홀더 2줄  <- 이 줄은 안 문다
  //   PROVE_RED_PLACEHOLDER=1   빈 상자 **62/39px**                <- 이 줄이 문다
  //
  // 즉 두 seam 은 서로 다른 것을 재고 각자 자기 단언을 붉힌다. 「런타임 fit 이 절을
  // 먼저 버리니 클램프를 지워도 넘칠 것이 없다」는 논증이 놓친 것은 위 1017 줄이다 —
  // `PLACEHOLDER` 는 클램프만 벗기지 않고 `CLAUSE` 의 문자열 복원을 **함께** 한다.
  // 옛 렌더는 「옛 문자열 + 옛 클램프」 둘 다이고, 62/39 는 #1418 이 수리 전 소스로
  // 적어 둔 그 숫자 그대로다.
  //
  // 두 번째 논거였던 「빈 값의 scrollHeight 는 플레이스홀더를 세지 않는다」는
  // **거짓**이다. 위 62/39 가 그것을 잰다: 클램프를 벗긴 2줄 플레이스홀더는 빈
  // textarea 의 scrollHeight 를 한 줄만큼 늘린다(39 -> 62). 그 문장은 #1384 머리말이
  // 가정으로 적었다가 #1413 Low(글리프 반노출)로 반증된 것이고, 오늘 그것이 참으로
  // 보이는 이유는 성질이 아니라 **이 클램프가 서 있기 때문**이다. 그러니 이 단언은
  // 클램프의 마지막 방어선을 지키는 자리이고, 지우면 그 방어선이 말없이 사라진다.
  // (코어 머리말의 그 문장은 #1422 수리 회전에서 실측으로 고쳤다.)
  if (geometry.scrollHeight > geometry.clientHeight) {
    throw new Error(
      `work-pane-${width}: the empty composer overflows its own box (${geometry.scrollHeight} > ${geometry.clientHeight}px). The wrapped placeholder line is not gone, it is peeking through the bottom padding as half-drawn glyphs; the approved trade-off (#1384) was losing the clause, not showing half of it (tokens.css composer-placeholder).`
    );
  }

  // #1422 — 무엇이 사라졌는가. 위 단언은 「반쯤 보이지 않는다」까지만 말하고,
  // 그것은 클램프가 절 한가운데를 잘라도 참이다. 실제로 이 폭에서 살아남던 줄이
  // "…메시지 보내기, @로" 였다(#1418 design-review M1): 목적어를 잃은 조사가 줄
  // 끝에 남은 것 — 디자인 시스템 §5.3 이 7위로 세어 둔 의존형태소 절단이고,
  // 기계가 안 잡는 축이었다. 그 축을 여기서 잰다.
  if (width < 928) {
    // ① 안 드는 절이 아직 상자 안에 있는가. 있으면 그 뒤의 모양 단언들은 전부
    //    「보이지 않는 글자」에 대한 것이 된다.
    if (geometry.placeholderText.includes(MENTION_AFFORDANCE)) {
      throw new Error(
        `work-pane-${width}: the mention affordance is still in the box at a width where the whole sentence needs ${geometry.wholeSentenceLines} lines ("${geometry.placeholderText}"). The clause that does not fit has to go whole (@momo/core fitComposerPlaceholder), not be hidden by the 1lh clamp.`
      );
    }
    // ② 조각도 남으면 안 된다. 「@」·「@로」·「@로 부르」 어느 것으로 끝나도
    //    그것은 낱말이 아니다.
    for (let i = 1; i < MENTION_AFFORDANCE.length; i += 1) {
      const partial = MENTION_AFFORDANCE.slice(0, i);
      if (geometry.placeholderText.endsWith(partial)) {
        throw new Error(
          `work-pane-${width}: the placeholder ends mid-clause on "${partial}" ("${geometry.placeholderText}"). The approved trade-off (#1384) was losing the whole clause; a trailing particle with no object is broken Korean (design system §5.3, 의존형태소 절단).`
        );
      }
    }
    if (geometry.placeholderText.endsWith(PLACEHOLDER_JOINER.trimEnd())) {
      throw new Error(
        `work-pane-${width}: the placeholder ends on the clause joiner ("${geometry.placeholderText}"), so the box promises a clause it then does not show.`
      );
    }
    // ③ 그러고도 접히면, 남은 것은 머리 절 하나인데 그것마저 안 드는 폭이다 —
    //    절 단위 생략이 손댈 수 없는 판이고, 그때는 이 창의 기하가 문제다.
    if (geometry.placeholderLines !== 1) {
      throw new Error(
        `work-pane-${width}: the placeholder still wraps (${geometry.placeholderLines} lines) with only its head clause left ("${geometry.placeholderText}"); nothing above the 1lh clamp can rescue that, so the box itself is too narrow here.`
      );
    }
  }

  // 그리고 반대쪽. 이 짝이 없으면 "언제나 지운다"도 위 단언을 통과하고, #1384 가
  // 실은 광고가 넓은 창에서까지 조용히 사라진다.
  if (width >= 928 && !geometry.placeholderText.includes(MENTION_AFFORDANCE)) {
    throw new Error(
      `work-pane-${width}: the mention affordance is gone from a box that fits it ("${geometry.placeholderText}"). Clause-level ellipsis drops a clause only when it does not fit; here it does (#1384 measured this sentence into a 236px box).`
    );
  }

  await context.close();
}

/**
 * 600~899px 구간의 스레드 패널 (#1421).
 *
 * `exerciseWorkPaneCoOpen` 이 재는 것과 **같은 상자, 다른 pane** 이다. 두 pane 은
 * 채팅 표면 안쪽에서 채널 열과 같은 행을 나눠 갖는데 문턱만 서로 달랐다: 작업
 * 세션 pane 은 900px, 스레드 패널은 600px. 그래서 그 사이 구간에는 아무 바닥도
 * 없었고, 스레드를 열면 채널 열이 라우트에서 320px 을 뺀 나머지를 받아 컴포저가
 * 899px 에서 235px, 700px 에서 36px, 600px 에서 26px 가 됐다(#1418 워커 실측).
 * `chat-region` 의 바닥은 900px 위에서만 얹히므로 이 구간을 잡지 못했고, 여유가
 * 양수라 shrink 도 돌지 않았다 — 어느 게이트도 이 조합을 재지 않았다.
 *
 * 수리는 바닥이 아니라 문턱을 옮겼다(tokens.css `thread-pane` 이 그 근거와
 * 대안의 실측을 든다). 그래서 이 시나리오가 재는 것은 "덮었는가" 하나가 아니라
 * 셋이다:
 *
 *   1. 이 구간에서 **사람이 읽고 쓰는 두 컴포저가 모두 바닥 위**에 있다.
 *      덮은 표면의 채널 컴포저도 함께 재는 이유는, 문턱이 다시 내려가는 날
 *      먼저 좁아지는 것이 그쪽이기 때문이다.
 *   2. 덮음과 탭 순서는 한 사실의 두 얼굴이다 — 스타일시트가 덮은 표면을
 *      스크립트가 `inert` 로 함께 빼낸다(ChatShell). 둘이 어긋나면 화면에 없는
 *      컨트롤로 Tab 이 걸어 들어간다.
 *   3. 덮는 것은 **표면 전체**이지 한쪽 끝의 320px 띠가 아니다.
 */
async function exerciseThreadPaneNarrow(browser, width) {
  const scenario = CO_OPEN_SCENARIO;
  const context = await browser.newContext({
    viewport: { width, height: 800 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await installRealtimeSocket(page);
  await installRoutes(context, scenario);
  await login(page);

  // red seam: 스타일시트를 지우지 않고 한 겹 덮어써서 문턱을 600px 로 되돌린다.
  // 이 구간에서 절대 배치를 풀면 패널은 다시 `flex: 0 1 320px` 인 열이 되고,
  // 수리 이전의 렌더가 그 자리에 그대로 돌아온다.
  if (proveRedThread) {
    await page.addStyleTag({
      content:
        "@media (600px <= width < 900px) { .thread-pane { position: static; inset: auto; inline-size: auto; z-index: auto; } }",
    });
  }

  await page.getByTestId("thread-anchor").first().click();
  await page.getByTestId("thread-panel").waitFor();

  // red seam: 제품 소스가 아니라 드라이버가 속성 하나를 떼어 낸다. 효과는
  // `covered` 가 바뀔 때만 다시 도므로 다시 붙지 않는다 — 아래 짝 단언이 DOM 을
  // 읽고 있다는 증명이다.
  if (proveRedThreadInert) {
    await page.evaluate(() =>
      document.querySelector(".chat-region")?.removeAttribute("inert")
    );
  }

  const geometry = await page.evaluate(() => {
    const round = (value) => Math.round(value);
    const panel = document.querySelector('[data-testid="thread-panel"]');
    const surface = panel.parentElement;
    const region = document.querySelector(".chat-region");
    const channelInput = document.getElementById("composer-input");
    const threadInput = document.querySelector(
      '[data-testid="thread-composer-input"]'
    );
    const close = document.querySelector('[data-testid="thread-close"]');
    const panelBox = panel.getBoundingClientRect();
    const surfaceBox = surface.getBoundingClientRect();
    const closeBox = close.getBoundingClientRect();
    return {
      panelLeft: round(panelBox.left),
      panelWidth: round(panelBox.width),
      surfaceLeft: round(surfaceBox.left),
      surfaceWidth: round(surfaceBox.width),
      covering: getComputedStyle(panel).position === "absolute",
      inert: region.hasAttribute("inert"),
      channelComposerWidth: round(channelInput.getBoundingClientRect().width),
      threadComposerWidth: round(threadInput.getBoundingClientRect().width),
      closeRight: round(closeBox.right),
      viewportWidth: window.innerWidth,
    };
  });

  console.log(
    `[thread-pane] ${width}px 창, 스레드 개방 -> 패널 ${geometry.panelWidth}px ` +
      `(덮음 ${geometry.covering} · inert ${geometry.inert}) · 채널 컴포저 ` +
      `${geometry.channelComposerWidth}px · 답글 컴포저 ${geometry.threadComposerWidth}px`
  );

  // 1. 두 컴포저 모두 바닥 위. 이 구간에서 실제로 쓰는 것은 답글 컴포저지만,
  //    채널 컴포저가 먼저 좁아지므로 둘을 함께 잰다.
  const squeezed =
    geometry.channelComposerWidth < MIN_COMPOSER_WIDTH
      ? ["channel", geometry.channelComposerWidth]
      : geometry.threadComposerWidth < MIN_COMPOSER_WIDTH
        ? ["thread", geometry.threadComposerWidth]
        : null;
  if (squeezed) {
    throw new Error(
      `thread-pane-${width}: the ${squeezed[0]} composer was squeezed to ${squeezed[1]}px (floor ${MIN_COMPOSER_WIDTH}px). Between 600 and 899px the thread pane covers the channel instead of standing beside it as a 320px column, because standing beside it left the channel ${width - 240 - PANE_MEASURE}px (tokens.css thread-pane / chat-region).`
    );
  }

  // 2. 덮음과 탭 순서는 한 사실의 두 얼굴이다.
  if (geometry.covering !== geometry.inert) {
    throw new Error(
      `thread-pane-${width}: the stylesheet and the script disagree about this width (covering ${geometry.covering}, inert ${geometry.inert}). A pane that covered the channel but left it in the tab order sends Tab into controls that are not on screen (tokens.css thread-pane 문턱 · ChatShell matchMedia).`
    );
  }

  // 3. 덮는다면 표면 전체를 덮는다. 한쪽 끝의 띠는 컴포저의 전송 컨트롤을 반쯤
  //    가리고, 반쯤 보이는 컨트롤은 아예 없는 것보다 나쁘다(work-pane 주석).
  if (
    geometry.panelLeft !== geometry.surfaceLeft ||
    geometry.panelWidth !== geometry.surfaceWidth
  ) {
    throw new Error(
      `thread-pane-${width}: the pane covered only part of the chat surface (pane ${geometry.panelLeft}+${geometry.panelWidth}, surface ${geometry.surfaceLeft}+${geometry.surfaceWidth}). A strip over one edge half-hides the composer it is standing on.`
    );
  }

  // 4. 난간(red seam 없음). 사람이 연 것을 닫을 수 있는가 — 닫기 컨트롤이 창
  //    안에 있는가. 오늘 어느 폭에서도 물지 않지만, 이 줄이 이 티켓에서 **다른
  //    수리안을 떨어뜨린 측정**이다: 바닥(`--spacing-chat-min` 368)을 이 구간까지
  //    내리면 셋이 서는 데 240 + 368 + 192 = 800px 이 필요해서, 600px 창에서
  //    패널이 x 608..800 에 놓이고 닫기 컨트롤을 포함한 전체가 셸의
  //    `overflow: clip` 밑으로 사라졌다(실측). 붉힐 수 없다고 지우면 그때 무엇을
  //    쟀는지가 함께 사라진다.
  if (geometry.closeRight > geometry.viewportWidth) {
    throw new Error(
      `thread-pane-${width}: the pane's close control sits at x ${geometry.closeRight} in a ${geometry.viewportWidth}px window, i.e. outside the shell's clip. A surface the reader can open and cannot close is worse than one that never opened.`
    );
  }

  // 5. 키보드 탈출 패리티 (#1431). 두 서랍은 위에서 잰 바로 그 오버레이 문법을
  //    공유하는데(같은 900px 문턱 · 같은 inert 덮개), 탈출에서만 갈라졌다: 작업
  //    서랍은 Escape 닫기(WorkPanel onKeyDown)와 포커스 반환(closePanel + ChatShell
  //    inert 제거)이 있고, 스레드 서랍은 둘 다 없어 답글 컴포저에서 Escape가
  //    무반응이었고 닫기 버튼을 누르면 캐럿이 document.body로 떨어졌다. 이
  //    구간(600~899px)이 #1421이 오버레이로 넓힌, 데스크톱 키보드 사용자가 실제로
  //    사는 폭이라 그 갈라짐이 여기서 물린다.

  // 5a. 답글 컴포저 안에서 누른 Escape가 서랍을 닫는다.
  //     red seam: window 캡처 단계에서 Escape를 삼켜 aside 핸들러에 닿지 못하게 —
  //     즉 핸들러가 없던 수리 이전으로 되돌린다. 짝 단언이 서랍이 열린 채 남는
  //     것을 잡는다.
  if (proveRedThreadEscape) {
    await page.evaluate(() => {
      window.addEventListener(
        "keydown",
        (event) => {
          if (event.key === "Escape") event.stopImmediatePropagation();
        },
        true
      );
    });
  }
  await page.getByTestId("thread-composer-input").focus();
  await page.keyboard.press("Escape");
  try {
    await page
      .getByTestId("thread-panel")
      .waitFor({ state: "detached", timeout: 3_000 });
  } catch {
    throw new Error(
      `thread-pane-${width}: Escape inside the reply composer did not close the thread drawer. The 작업 세션 drawer closes on Escape (WorkPanel onKeyDown); this drawer shares the same overlay grammar and has to be its homolog, or a keyboard reader who stepped in to read a thread has no key that steps back out (#1431).`
    );
  }

  // 5b. 닫기 버튼이 서랍을 연 컨트롤(답글 앵커)로 포커스를 되돌린다 — body가 아니라.
  //     앵커는 덮개(chat-region)가 inert로 만든 표면 안에 살아, 서랍이 닫히며
  //     ChatShell이 inert를 먼저 떼야 focus()가 먹는다.
  //     red seam: 닫은 뒤 활성 요소를 blur해 포커스 반환이 없던 수리 이전으로
  //     되돌린다 — 캐럿이 document.body로 떨어진다.
  await page.getByTestId("thread-anchor").first().click();
  await page.getByTestId("thread-panel").waitFor();
  await page.getByTestId("thread-close").click();
  await page.getByTestId("thread-panel").waitFor({ state: "detached" });
  if (proveRedThreadFocus) {
    await page.evaluate(() => document.activeElement?.blur());
  }
  const restored = await page.evaluate(
    () => document.activeElement?.getAttribute?.("data-testid") ?? null
  );
  if (restored !== "thread-anchor") {
    throw new Error(
      `thread-pane-${width}: closing the thread drawer left focus on ${
        restored ?? "document.body"
      } instead of the control that opened it. The 작업 세션 drawer hands the caret back to its opener (WorkPanel closePanel + ChatShell inert removal); this drawer has to do the same, or the next Tab starts at the top of the document (#1431).`
    );
  }

  await context.close();
}

/**
 * 좁은 구간 스레드 패널의 리뷰용 스크린샷 (#1421). 판정하지 않는다.
 *
 * 700px 은 이 티켓이 고친 판의 한가운데이고(고치기 전 채널 열 140px · 컴포저
 * 36px), 900px 은 문턱 바로 위라 **아무것도 바뀌지 않아야 하는** 폭이다. 무회귀는
 * 말이 아니라 그 두 장이 나란히 있을 때 보인다.
 */
async function captureThreadPaneShots(browser) {
  const outDir = resolve(webRoot, "artifacts/thread-pane");
  mkdirSync(outDir, { recursive: true });
  for (const width of [700, 900]) {
    for (const scheme of ["light", "dark"]) {
      const context = await browser.newContext({
        viewport: { width, height: 800 },
        reducedMotion: "reduce",
        colorScheme: scheme,
      });
      const page = await context.newPage();
      await installRealtimeSocket(page);
      await installRoutes(context, CO_OPEN_SCENARIO);
      await login(page);
      await page.getByTestId("thread-anchor").first().click();
      await page.getByTestId("thread-panel").waitFor();
      // 답글이 자리를 잡은 뒤에 찍는다(work-pane 캡처와 같은 이유): 골격 막대가
      // 서 있는 순간을 찍으면 전후 비교가 조명 비교가 된다. 컴포저가 아니라
      // **답글 본문**을 기다리는 이유가 그것이다 — 컴포저는 목록이 아직 골격일
      // 때 이미 서 있다.
      await page.getByTestId("thread-composer-input").waitFor();
      await page
        .locator('[data-testid="thread-panel"]')
        .getByText(reply.body)
        .waitFor();
      await page.screenshot({
        path: resolve(outDir, `thread-pane-${width}-${scheme}.png`),
      });
      await context.close();
    }
  }
  console.log(
    `[shots] artifacts/thread-pane/thread-pane-{700,900}-{light,dark}.png`
  );
}

/**
 * 머리 절 하나도 안 드는 띠 (#1422 design-review H1).
 *
 * `exerciseWorkPaneCoOpen` 이 재는 것과 **같은 판, 더 긴 이름**이다. 그 함수의
 * 단언들은 「버릴 절이 남아 있는」 폭을 재고, 이 함수는 그 아래 띠를 잰다:
 * 절을 다 버리고 머리 절만 남았는데 그것도 상자를 넘는 폭. 계약이 손을 뗀
 * 자리이므로 여기서 묻는 것은 **무엇이 버려졌나**가 아니라 **어떻게 잘렸나**다.
 *
 * 셋을 잰다:
 *   1. 이 폭이 정말 그 띠인가 — 머리 절의 한 줄 폭이 상자보다 넓다.
 *   2. 그런데도 상자는 안 넘친다 — 반노출 없음(#1418 의 불변식 그대로).
 *   3. 잘리는 자리가 **낱말 사이다** — `::placeholder` 가 `keep-all` 로 계산된다.
 *      낱말 안에서 끊기면 「보내기」가 「보내」/「기」가 되고, 그것이 리뷰가 이
 *      폭에서 실측한 줄이다(디자인 시스템 §5.3, 의존형태소 절단).
 *
 * 3번을 계산된 스타일로 재는 이유: `::placeholder` 안에 그려진 글자는 DOM 에
 * 없으므로 「몇 번째 글자에서 끊겼는가」는 스크립트가 답할 수 없다. 답할 수 있는
 * 것은 **그 자리를 지배하는 규칙**이고, 그 규칙이 스타일시트에서 실제로 이 요소에
 * 닿았는지는 계산된 값만이 안다(클래스 이름을 세는 것과 다르다). 어디서 끊겼는지
 * 는 이 폭의 스크린샷이 사람에게 답한다.
 */
async function exerciseHeadClauseBand(browser, width) {
  const scenario = { ...CO_OPEN_SCENARIO, longChannelName: true };
  const context = await browser.newContext({
    viewport: { width, height: 800 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await installRealtimeSocket(page);
  await installRoutes(context, scenario);
  await login(page);

  // red seam: 스타일시트를 지우지 않고 한 겹 덮어써서 어절 규칙만 되돌린다.
  if (proveRedKeepAll) {
    await page.addStyleTag({
      content: "#composer-input::placeholder { word-break: normal; }",
    });
  }

  await page.getByTestId("open-work-panel").click();
  await page.getByTestId("work-panel").waitFor();
  await settlePlaceholder(page);

  const geometry = await page.evaluate(() => {
    const input = document.getElementById("composer-input");
    const styles = getComputedStyle(input);
    const placeholderStyles = getComputedStyle(input, "::placeholder");
    const available =
      input.clientWidth -
      Number.parseFloat(styles.paddingLeft) -
      Number.parseFloat(styles.paddingRight);

    // 한 줄일 때의 자연 폭. `pre` 라 감기지 않으므로 이 값이 곧 「들어가는가」다.
    const probe = document.createElement("span");
    for (const property of [
      "fontFamily",
      "fontSize",
      "fontStretch",
      "fontStyle",
      "fontVariant",
      "fontWeight",
      "letterSpacing",
      "textTransform",
      "wordSpacing",
    ]) {
      probe.style[property] = styles[property];
    }
    probe.style.whiteSpace = "pre";
    probe.style.position = "fixed";
    probe.style.visibility = "hidden";
    probe.textContent = input.getAttribute("placeholder") ?? "";
    document.body.appendChild(probe);
    const naturalWidth = probe.getBoundingClientRect().width;
    probe.remove();

    return {
      placeholderText: input.getAttribute("placeholder") ?? "",
      composerWidth: Math.round(input.getBoundingClientRect().width),
      available: Math.round(available),
      naturalWidth: Math.round(naturalWidth),
      clientHeight: input.clientHeight,
      scrollHeight: input.scrollHeight,
      wordBreak: placeholderStyles.wordBreak,
      // 함께 찍어 두는 이유는 이 값이 tokens.css 주석의 근거이기 때문이다:
      // `text-overflow` 를 포기한 자리가 `::placeholder` 의 어떤 성질 때문인지를
      // 다음 사람이 다시 실험하지 않으려면 실측치가 로그에 남아야 한다.
      whiteSpace: placeholderStyles.whiteSpace,
    };
  });

  console.log(
    `[head-clause] ${width}px 창, 긴 방 이름 -> 컴포저 ${geometry.composerWidth}px ` +
      `(글 ${geometry.available}px) · 머리 절 ${geometry.naturalWidth}px · ` +
      `word-break=${geometry.wordBreak} · white-space=${geometry.whiteSpace} "${geometry.placeholderText}"`
  );

  if (geometry.placeholderText.includes(MENTION_AFFORDANCE)) {
    throw new Error(
      `head-clause-${width}: the mention affordance survived a box that cannot even hold the head clause ("${geometry.placeholderText}")`
    );
  }
  if (geometry.naturalWidth <= geometry.available) {
    throw new Error(
      `head-clause-${width}: the head clause fits here (${geometry.naturalWidth} <= ${geometry.available}px), so this scenario is not measuring the band it names. Lengthen LONG_CHANNEL_NAME or narrow the window.`
    );
  }
  if (geometry.scrollHeight > geometry.clientHeight) {
    throw new Error(
      `head-clause-${width}: the empty composer overflows its own box (${geometry.scrollHeight} > ${geometry.clientHeight}px) in the band where no clause can be dropped.`
    );
  }
  if (geometry.wordBreak !== "keep-all") {
    throw new Error(
      `head-clause-${width}: the clamped line may break inside a word (::placeholder word-break=${geometry.wordBreak}). That is how "보내기" became "보내"/"기" here — 디자인 시스템 §5.3 의존형태소 절단, and the phone's lineBreakStrategyIOS="hangul-word" is the same rule on the other surface (tokens.css composer-placeholder).`
    );
  }

  await context.close();
}

/**
 * 자가 늙지 않는가 — 글자가 커진 뒤의 재판정 (#1422 수리 회전 M1).
 *
 * 위 두 함수는 **상자가 좁아질 때** 계약이 도는지를 잰다. 자를 움직이는 축은
 * 그것 하나가 아니다: 같은 상자에서 **글자가 커져도** 같은 문장이 안 든다.
 * 루트 `font-size`(rem)·브라우저 기본 글자 크기·늦게 푸는 글꼴 폴백이 그 축이고,
 * 그 축은 `placeholderFit.ts` 의 효과 의존성(`ref`·`clauses`·`full`)에 **없다**.
 *
 * 앞 판은 프로브의 글자꼴을 효과 몸통에서 한 번만 복사했다. 그러면 폭이 아니라
 * 글자가 움직인 판에서 `ResizeObserver` 는 (상자 높이가 함께 움직이므로) 콜백까지
 * 오는데 자만 옛 글자로 남고, 틀리는 방향이 하필 낙관이다 — 안 드는 절을 "든다"고
 * 답해 상자에 남긴다. 그것이 #1422 가 지운 바로 그 렌더이므로 이 레인이 있다.
 *
 * 넓게 열고 **좁히는** 순서인 이유는 실측이다: 글자만 커지는 사건은 이 컴포넌트를
 * 깨우지 못한다. 입력창의 높이는 `useAutoGrow` 가 인라인 px 로 못 박고 그 훅은
 * `value` 가 바뀔 때만 다시 도므로, 루트 글자를 키워도 상자의 두 변이 **하나도**
 * 안 움직이고 `ResizeObserver` 는 30초를 기다려도 안 깬다(첫 판 실측: 높이 39px
 * 불변, waitForFunction 타임아웃). 그러니 자가 늙는 것이 화면에 나오는 순간은
 * 「글자가 커진 뒤에 폭이 움직일 때」이고 — 창을 줄이거나 pane 을 열 때 — 이
 * 레인이 세우는 것이 정확히 그 순서다.
 *
 * (그래서 이 레인이 **안 닫는** 것도 적어 둔다: 글자만 바뀌고 폭이 안 바뀌는
 * 판에서는 문장이 아예 다시 골라지지 않는다. 그것은 자의 결함이 아니라 계기의
 * 결함이라 고칠 자리도 다르다 — 관찰 대상에 글자 축을 더하는 결정이고, 그 결정은
 * 이 회전의 범위가 아니다.)
 *
 * 1280 -> 980 인 이유: 1280 은 base 에서 문장 전체가 넉넉히 드는 폭이고(그래서
 * 「사라졌다」의 출발점이 광고가 선 화면이다), 980 은 키운 글자로 문장 전체가 안
 * 드는 첫 띠이면서 머리 절은 아직 드는 폭이다. 900 은 base 에서 이미 안 드는 폭이라
 * 이 축을 못 잰다.
 *
 * 넷을 잰다:
 *   1. base 에서 광고가 서 있다 — 안 그러면 아래 「사라졌다」가 아무것도 안 잰다.
 *   2. 키운 글자에서 이 폭이 정말 그 띠인가 — 문장 전체는 안 들고
 *   3. 머리 절은 든다(안 그러면 여기는 `exerciseHeadClauseBand` 의 띠다).
 *   4. 그 폭에서 광고가 통째로 사라졌다 — 자가 새 글자로 다시 쟀다는 뜻이다.
 */
async function exerciseProbeRuler(browser, wideWidth, width) {
  const context = await browser.newContext({
    viewport: { width: wideWidth, height: 800 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await installRealtimeSocket(page);
  await installRoutes(context, CO_OPEN_SCENARIO);
  await login(page);
  await page.getByTestId("open-work-panel").click();
  await page.getByTestId("work-panel").waitFor();
  await settlePlaceholder(page);

  const before = await page.evaluate(() => {
    const input = document.getElementById("composer-input");
    return {
      placeholderText: input.getAttribute("placeholder") ?? "",
      fontSize: getComputedStyle(input).fontSize,
      composerWidth: input.clientWidth,
    };
  });

  // red seam: 제품 소스를 지우지 않고 **프로브의 글자만 옛 값에 못 박는다**.
  // 작성자 스타일시트의 `!important` 는 인라인 선언을 이기므로, 이 한 줄이 곧
  // 「효과에서 한 번만 복사한 자」다 — recompute 는 여전히 돌고, 답만 옛 글자로
  // 나온다. 수리 이전의 코드가 내던 그 답이다.
  if (proveRedRuler) {
    await page.addStyleTag({
      content: `.text-probe { font-size: ${before.fontSize} !important; }`,
    });
  }

  // 글자를 한 단 키운다. 상자는 안 커진다 — 이 레포의 간격 토큰은 전부 px 이고
  // 글자 토큰만 rem 이다(tokens.css). 그래서 이것이 「같은 상자, 큰 글자」다.
  await page.addStyleTag({ content: ":root { font-size: 20px; }" });
  // 그리고 **폭**을 움직인다. 이것이 위 머리말이 적은 그 순서다: 자를 늙게 한
  // 사건과 자를 쓰게 하는 사건이 따로 온다.
  await page.setViewportSize({ width, height: 800 });
  // 자가 다시 잴 **기회**를 기다린다. 기다리는 것은 답이 아니라 상자다.
  // 「짧아졌는가」를 기다리면 아래 단언이 자기가 기다린 것을 다시 확인할 뿐이다.
  await page.waitForFunction(
    (previous) => {
      const input = document.getElementById("composer-input");
      return input !== null && input.clientWidth !== previous;
    },
    before.composerWidth
  );
  await settlePlaceholder(page);

  const geometry = await page.evaluate(
    ([joiner, affordance]) => {
      const input = document.getElementById("composer-input");
      const styles = getComputedStyle(input);
      const available =
        input.clientWidth -
        Number.parseFloat(styles.paddingLeft) -
        Number.parseFloat(styles.paddingRight);
      const rendered = input.getAttribute("placeholder") ?? "";

      // 지금 글자로 잰 한 줄 폭. `text-probe` 를 **안 쓰는** 것이 중요하다 —
      // red seam 이 못 박는 것이 그 클래스라, 이 프로브가 그것을 쓰면 심판이
      // 피고와 같은 자를 든다.
      const probe = document.createElement("span");
      for (const property of [
        "fontFamily",
        "fontSize",
        "fontStretch",
        "fontStyle",
        "fontVariant",
        "fontWeight",
        "letterSpacing",
        "textTransform",
        "wordSpacing",
      ]) {
        probe.style[property] = styles[property];
      }
      probe.style.whiteSpace = "pre";
      probe.style.position = "fixed";
      probe.style.visibility = "hidden";
      document.body.appendChild(probe);
      const widthOf = (text) => {
        probe.textContent = text;
        return probe.getBoundingClientRect().width;
      };
      const head = rendered.includes(affordance)
        ? rendered.slice(0, rendered.indexOf(`${joiner}${affordance}`))
        : rendered;
      const headWidth = widthOf(head);
      const wholeWidth = widthOf(`${head}${joiner}${affordance}`);
      probe.remove();

      return {
        placeholderText: rendered,
        fontSize: styles.fontSize,
        available: Math.round(available),
        headWidth: Math.round(headWidth),
        wholeWidth: Math.round(wholeWidth),
      };
    },
    [PLACEHOLDER_JOINER, MENTION_AFFORDANCE]
  );

  console.log(
    `[probe-ruler] ${wideWidth} -> ${width}px 창, 글자 ${before.fontSize} -> ${geometry.fontSize} · ` +
      `글 ${geometry.available}px · 머리 절 ${geometry.headWidth}px · ` +
      `문장 전체 ${geometry.wholeWidth}px "${geometry.placeholderText}"`
  );

  if (!before.placeholderText.includes(MENTION_AFFORDANCE)) {
    throw new Error(
      `probe-ruler-${width}: the affordance was already gone at the base font size ("${before.placeholderText}"), so "it disappeared after the font grew" measures nothing here. Widen the window.`
    );
  }
  if (geometry.wholeWidth <= geometry.available) {
    throw new Error(
      `probe-ruler-${width}: the whole sentence still fits after the font grew (${geometry.wholeWidth} <= ${geometry.available}px); this lane is not standing in the band it names. Raise the root font-size or narrow the window.`
    );
  }
  if (geometry.headWidth > geometry.available) {
    throw new Error(
      `probe-ruler-${width}: even the head clause no longer fits (${geometry.headWidth} > ${geometry.available}px), so this is the head-clause band, not the clause-dropping band. Lower the root font-size or widen the window.`
    );
  }
  if (geometry.placeholderText.includes(MENTION_AFFORDANCE)) {
    throw new Error(
      `probe-ruler-${width}: the affordance survived a box it no longer fits after the font grew ("${geometry.placeholderText}", ${geometry.wholeWidth} > ${geometry.available}px). The probe measured with a STALE font: placeholderFit.ts must re-copy PROBE_PROPERTIES on every recompute, not once per effect — the box moved the ruler, and rem/base-font changes are not in that effect's deps.`
    );
  }

  await context.close();
}

/**
 * 절 단위 생략의 리뷰용 스크린샷 (#1422). 판정하지 않는다.
 *
 * 세 폭이 한 규칙의 세 얼굴이다: **390** 은 폰 폭이라 긴 방 이름에서 광고가
 * 사라지고, **900** 은 이 게이트가 단언으로 재는 그 판이며(pane 을 열면 236px 급
 * 상자), **1200** 은 아무것도 사라지지 않아야 하는 폭이다. 사라지는 사진만 있으면
 * 리뷰는 「언제나 지운다」와 구별할 수 없다.
 *
 * 방 이름은 픽스처의 `release-2026-08` 이다 — 게이트가 재는 그 이름이라, 사진과
 * 단언이 같은 문장을 두고 말한다.
 *
 * **전후를 한 번에 찍는다.** 「이전」은 red seam 과 같은 방법으로 만든다: 버려진
 * 뒷절을 속성에 도로 이어 붙이면 클램프(#1418)가 그것을 한 줄로 자르고, 그 줄이
 * 바로 이 티켓이 물려받은 화면이다. 따로 돌리는 명령으로 두면 두 장이 다른
 * 빌드·다른 조명에서 나올 수 있고, 그러면 비교가 조명 비교가 된다.
 */
async function captureClauseShots(browser) {
  const outDir = resolve(webRoot, "artifacts/composer-clause");
  mkdirSync(outDir, { recursive: true });
  for (const { width, longName } of [
    { width: 390, longName: false },
    { width: 900, longName: false },
    { width: 1200, longName: false },
    // 절 단위 생략이 손을 뗀 띠 (design-review H1). 같은 900px 판, 넉 자 긴 이름.
    { width: 900, longName: true },
  ]) {
    for (const scheme of ["light", "dark"]) {
      // 로그인은 넓은 판에서 한다. 390px 셸에서는 채널 목록이 서랍 안이라
      // 드라이버가 방에 들어갈 수 없고(실측: 「element is outside of the
      // viewport」), 이 사진이 보여 줄 것은 로그인 경로가 아니라 컴포저다.
      // 창을 그 뒤에 줄이는 것은 우회가 아니라 **이 수리가 도는 그 계기**다:
      // 폭이 바뀌면 `ResizeObserver` 가 문장을 다시 고른다.
      const context = await browser.newContext({
        viewport: { width: Math.max(width, 900), height: 800 },
        reducedMotion: "reduce",
        colorScheme: scheme,
      });
      const page = await context.newPage();
      await installRealtimeSocket(page);
      await installRoutes(context, { ...CO_OPEN_SCENARIO, longChannelName: longName });
      await login(page);
      // 900px 에서만 pane 을 연다: 그 판이 이 티켓이 물려받은 판이고(#1418),
      // 390 과 1200 은 pane 없이도 각각 「가장 좁은 상자」와 「넉넉한 상자」다.
      if (width === 900) {
        await page.getByTestId("open-work-panel").click();
        await page.getByTestId("work-panel").waitFor();
      }
      await page.setViewportSize({ width, height: 800 });
      await page.locator("#composer-input").waitFor();
      await settlePlaceholder(page);
      // 포인터를 치운다 (design-review N1). 로그인 드라이버가 채널 행을 클릭한
      // 자리에 커서가 남아 있어 전후 두 장 중 한 장에만 hover 배경이 들어갔다 —
      // 두 자리가 다른 전후 쌍은 한 자리만 다른 쌍보다 약한 증거다.
      await page.mouse.move(0, 0);
      // 포커스도 함께 치운다 (design-review N1 잔여). 로그인 드라이버가 누른
      // 패널 토글이 포커스를 들고 있어 전후 두 장의 상단 40px 띠가 달랐다.
      await page.evaluate(() => {
        const active = document.activeElement;
        if (active instanceof HTMLElement) active.blur();
      });
      await page.screenshot({
        path: resolve(outDir, `composer-clause-${width}${longName ? "-long" : ""}-${scheme}-after.png`),
      });

      // 「이전」— 두 띠의 이전이 서로 다르다.
      //
      //   보통 폭   버린 절을 도로 붙이면 #1418 의 화면이 그 자리에 선다.
      //   긴 이름   버릴 절이 없던 띠라 이전은 **끊는 자리**다. 어절 규칙만
      //             되돌리면 리뷰가 실측한 「…에 메시지 보내」가 돌아온다.
      if (longName) {
        await page.addStyleTag({
          content: "#composer-input::placeholder { word-break: normal; }",
        });
      } else {
        await page.evaluate(
          ([joiner, affordance]) => {
            const input = document.getElementById("composer-input");
            const current = input.getAttribute("placeholder") ?? "";
            if (!current.includes(affordance)) {
              input.setAttribute("placeholder", `${current}${joiner}${affordance}`);
            }
          },
          [PLACEHOLDER_JOINER, MENTION_AFFORDANCE]
        );
      }
      await page.screenshot({
        path: resolve(outDir, `composer-clause-${width}${longName ? "-long" : ""}-${scheme}-before.png`),
      });
      await context.close();
    }
  }
  console.log(
    `[shots] artifacts/composer-clause/composer-clause-{390,900,1200,900-long}-{light,dark}-{before,after}.png`
  );
}

async function main() {
  if (!existsSync(resolve(webRoot, "dist/index.html"))) {
    throw new Error("dist/ is missing. Run npm run build first.");
  }
  const server = await startGuardedPreview({
    webRoot,
    port,
    portEnvVar: "WORK_PANEL_GATE_PORT",
  });
  try {
    const browser = await chromium.launch();
    try {
      for (const scenario of scenarios) {
        await exerciseScenario(browser, scenario);
      }
      await exerciseCoOpen(browser);
      // 양보 구간과 그 밖 (#1418). 900px 은 pane 이 폭을 내는 유일한 구간의
      // 왼쪽 끝이고, 1280px 은 gate:my-sessions 가 자기 단언을 세워 둔 폭이다.
      await exerciseWorkPaneCoOpen(browser, 900);
      await exerciseWorkPaneCoOpen(browser, 1280);
      // 절 단위 생략이 손을 뗀 띠 (#1422 design-review H1). 같은 900px 판에서
      // 방 이름만 넉 자 길다.
      await exerciseHeadClauseBand(browser, 900);
      // 자를 움직이는 다른 축 — 같은 상자, 큰 글자 (#1422 수리 회전 M1). 1280 에서
      // 글자를 키운 뒤 980 으로 좁힌다: 자를 늙게 하는 사건과 자를 쓰게 하는
      // 사건이 따로 오는 그 순서가 이 결함이 화면에 나오는 순서다.
      await exerciseProbeRuler(browser, 1280, 980);
      // 문턱 아래의 스레드 패널 (#1421). 600 과 899 는 구간의 양 끝이고, 700 은
      // 티켓이 인용한 실측(컴포저 36px)이 난 폭이다. 양 끝만 재면 그 사이에서
      // 무엇이 달라지는지 아무도 모르고, 가운데만 재면 경계가 어디였는지 모른다.
      for (const width of [600, 700, 899]) {
        await exerciseThreadPaneNarrow(browser, width);
      }
      if (process.env.WORK_PANEL_GATE_SHOTS === "1") {
        await captureShots(browser);
        await captureWorkPaneShots(browser);
        await captureThreadPaneShots(browser);
        await captureClauseShots(browser);
      }
    } finally {
      await browser.close();
    }
  } finally {
    await server.stop();
  }
  console.log(
    "GATE PASS: delta arrival order, phase transitions, 승인 대기 vocabulary,"
  );
  console.log(
    "           mid-run truncation notice, folded tool args, and volatile reopen"
  );
  console.log(
    "           held across three skewed REST/frame timings, and one secondary"
  );
  console.log(
    "           pane at a time kept the 900px chat surface usable."
  );
  console.log(
    "           The 작업 세션 pane inside the chat surface yields the same way:"
  );
  console.log(
    "           composer above its floor at 900px, pane still 320px at 1280px,"
  );
  console.log(
    "           and the empty composer never overflows its own box."
  );
  console.log(
    "           What it loses when it does not fit is a WHOLE clause: at 900px"
  );
  console.log(
    "           the mention affordance is gone and nothing of it is left on the"
  );
  console.log(
    "           line, while at 1280px the same box still carries it."
  );
  console.log(
    "           The ruler does not age either: with the root font a step larger"
  );
  console.log(
    "           and the window then narrowed, the same box drops the clause it"
  );
  console.log("           no longer fits.");
  console.log(
    "           Below 900px the thread pane covers the channel instead of"
  );
  console.log(
    "           standing beside it, the covered column leaves the tab order"
  );
  console.log(
    "           with it, and both composers stay above their floor at 600,"
  );
  console.log("           700 and 899px. In that same band the thread drawer escapes");
  console.log(
    "           by keyboard like the 작업 세션 drawer: Escape inside the reply"
  );
  console.log(
    "           composer closes it, and the close button hands the caret back to"
  );
  console.log("           the control that opened it rather than dropping it on body.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
