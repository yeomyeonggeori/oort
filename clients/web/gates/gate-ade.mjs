#!/usr/bin/env node
// GATE: ADE 2단계 관제 표면 (정본 ADR-0154 D1+D2, 이슈 1135).
//
// 이 게이트가 지키는 것은 서랍이 열리는지가 아니라 **그 줄이 센 것이 참인가,
// 그리고 그것을 여느라 화면을 밀지 않았는가**다.
//
//   1. 집계 정확성   요약 줄의 숫자 = 서랍의 카드 수 = 원장이 실제로 낸 것.
//                    종료된 세션은 세지 않고, 유휴는 줄을 켜지 않는다.
//   2. 대기 강조     「대기」는 나머지 조각과 **다른 잉크**로 서고, 대기 카드가
//                    목록 맨 위에 온다. blocked 가 강조축이라는 D1 의 주장이
//                    문서가 아니라 마크업과 픽셀에 있다.
//   3. 서랍 불밀림   여는 전후로 라우트·컴포저·타임라인의 좌표가 **한 픽셀도**
//                    다르지 않다. 「작성 중」줄이 컴포저를 26px 밀었던 그 결함의
//                    더 큰 판이라, 같은 방식으로 잰다.
//   4. 생존성 정직   app 호스트 카드는 「기기를 꺼도 계속됩니다」라고 **말하지
//                    않는다**. 이 문장은 사람이 랩탑을 덮는 근거다.
//   5. 빈 상태       살아 있는 작업이 0이면 요약 줄이 DOM 에 없다. 빈 띠도 없다.
//   6. 카드 확대     카드를 누르면 서랍이 물러나고 기존 표면이 선다. 둘이 겹쳐
//                    있는 순간이 없다. **두 종류 다** 누른다 — 턴 카드는 작업
//                    패널로, 세션 카드는 `?work=` 로 작업 세션 패널로. 1차 게이트가
//                    턴 카드만 눌러서 세션 절반이 죽은 채 통과했다(리뷰 B1: 세션
//                    카드는 라우트 표에 없는 주소로 가서 `/` 로 튕겼다).
//   7. live 아님     이 줄은 `aria-live` 영역이 아니다. 잦은 갱신을 낭독으로
//                    끼어들게 하지 않는다(작업 패널 1Hz 시계와 같은 판정).
//   8. Esc 는 한 층  서랍과 작업 패널이 함께 서 있을 때 Esc 한 번은 **위 한 층**만
//                    닫는다(리뷰 H1 ①). 두 층이 같은 키에 같이 반응하면 사람이 한
//                    번 누른 것으로 아직 보고 있던 것까지 사라진다.
//   9. 덮인 형제     서랍에 덮인 작업 패널은 `inert` 다 — 라우트에만 걸려 있던
//                    규칙을 형제 표면도 받는다(리뷰 H1 ②).
//  10. 바깥 클릭     덮이지 않은 라우트 영역을 누르면 서랍이 닫힌다. 보이는데
//                    아무 반응도 없는 표면을 남기지 않는다(리뷰 H2).
//  11. 조각 띠 없음  899px 에서 서랍 오른쪽에 남는 라우트 띠는 0px 이고, 1200px
//                    위에서는 최소 한 칸(320px)이다. 반쯤 잘린 컨트롤이 걸리는
//                    폭이 없다(리뷰 M3).
//
// 이름 붙은 red proof (버릴 워크트리에서만 돌린다):
//   ADE_GATE_PROVE_RED_COUNT=1 npm run gate:ade
//     expected failure: "the summary count disagreed with the ledger"
//   ADE_GATE_PROVE_RED_BLOCKED=1 npm run gate:ade
//     expected failure: "대기 was not emphasised"
//   ADE_GATE_PROVE_RED_LAYOUT=1 npm run gate:ade
//     expected failure: "opening the drawer moved the route"
//   ADE_GATE_PROVE_RED_DURABILITY=1 npm run gate:ade
//     expected failure: "a device-bound session claimed it survives the lid"
//   ADE_GATE_PROVE_RED_SESSION=1 npm run gate:ade
//     expected failure: "the session card led nowhere"
//   ADE_GATE_PROVE_RED_ESC=1 npm run gate:ade
//     expected failure: "one Escape closed two layers"
//   ADE_GATE_PROVE_RED_OUTSIDE=1 npm run gate:ade
//     expected failure: "clicking the uncovered route did nothing"
//
// red seam 은 **목/드라이버의 행동만** 바꾼다. COUNT 는 원장에 실행 중 세션을 한
// 줄 더 실어 화면과 기대표를 갈라놓고(단언이 DOM 의 숫자를 실제로 읽는지 증명),
// DURABILITY 는 지속 호스트의 `type` 을 `app` 으로 바꿔 배지가 호스트에서 파생되는지
// 증명하며, BLOCKED 와 LAYOUT 은 CSS 만 덮어쓴다(React 가 들고 있는 노드는 그대로).
// 제품 소스 줄을 지우거나 단언을 빼라고 요구하지 않으므로 증명은 반복 가능하다.
//
// 새 셋도 같은 규율이다. SESSION 은 `history.pushState` 를 감싸 작업 세션 주소의
// `#/c/` 를 `#/channels/` 로 되돌린다 — 리뷰가 잡은 그 죽은 주소 그대로이고, 라우트
// 표에 없으므로 와일드카드가 `/` 로 보낸다. ESC 는 **예전 판의 리스너를 하나 되살린다**:
// window 캡처 단계에 작업 패널을 닫는 리스너를 앱보다 먼저 등록하므로, 층 스택이
// 없던 시절처럼 두 층이 같은 Esc 에 각자 반응한다. OUTSIDE 는 스크림의
// `pointer-events` 만 끈다(노드는 그대로 서 있고 클릭만 통과한다).
//
// 스크린샷은 이 게이트가 만든다(게이트 재생성 규율): artifacts/ade/*.png,
// light/dark 두 벌. 판정하지 않는다 — design-review 는 별도 레인이다.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.ADE_GATE_PORT || 5191);
const origin = `http://127.0.0.1:${port}`;

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const agentId = "AAAAAAAA-AAAA-7AAA-8AAA-AAAAAAAAA613";
const hermesId = "AAAAAAAA-AAAA-7AAA-8AAA-AAAAAAAAA614";
const generalId = "00000000-0000-7000-8000-000000000201";
const engineId = "00000000-0000-7000-8000-000000000202";
const runId = "9F1C8B2A-0000-7000-8000-00000000RUN1";

const APP_HOST = "0199C0DE-0000-7000-8000-0000000000H1";
const CLOUD_HOST = "0199C0DE-0000-7000-8000-0000000000H2";

const proveRedCount = process.env.ADE_GATE_PROVE_RED_COUNT === "1";
const proveRedBlocked = process.env.ADE_GATE_PROVE_RED_BLOCKED === "1";
const proveRedLayout = process.env.ADE_GATE_PROVE_RED_LAYOUT === "1";
const proveRedDurability = process.env.ADE_GATE_PROVE_RED_DURABILITY === "1";
const proveRedSession = process.env.ADE_GATE_PROVE_RED_SESSION === "1";
const proveRedEsc = process.env.ADE_GATE_PROVE_RED_ESC === "1";
const proveRedOutside = process.env.ADE_GATE_PROVE_RED_OUTSIDE === "1";

const PERSISTENT_BADGE = "기기를 꺼도 계속됩니다";
const DEVICE_BADGE = "이 기기에서만";

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
  realtimeWebSocketUrl: "ws://ade-gate.invalid/connection/websocket",
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
    channelCount: 2,
    channelIds: [generalId, engineId],
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
    channelCount: 2,
    channelIds: [generalId, engineId],
    capabilities: ["work.observe"],
    ownerHumanId: memberId,
    agentModel: "hermes-agent",
    createdAtMs: 0,
    updatedAtMs: 0,
  },
  {
    id: hermesId,
    workspaceId,
    kind: "agent",
    status: "active",
    role: "member",
    displayName: "Hermes",
    handle: "hermes",
    channelCount: 1,
    channelIds: [engineId],
    capabilities: ["work.observe"],
    ownerHumanId: memberId,
    agentModel: "hermes-agent",
    createdAtMs: 0,
    updatedAtMs: 0,
  },
];

const channels = [
  { id: generalId, workspaceId, kind: "public", name: "release-2026-08", muted: false },
  { id: engineId, workspaceId, kind: "public", name: "엔진", muted: false },
];

const workHosts = [
  {
    id: APP_HOST,
    workspaceId,
    scope: "member",
    ownerMemberId: memberId,
    type: "app",
    displayName: "성재 맥북",
    capabilities: { "work.spawn": true },
    createdAtMs: 0,
    online: true,
  },
  {
    id: CLOUD_HOST,
    workspaceId,
    scope: "workspace",
    ownerMemberId: memberId,
    // red seam: 지속 호스트를 로컬로 바꾼다. 배지가 `work_host.type` 파생이라면
    // 카드는 「이 기기에서만」이 되고, 아래 단언이 그것을 잡는다.
    type: proveRedDurability ? "app" : "cloud",
    displayName: "momo Cloud (서울)",
    capabilities: { "work.spawn": true },
    createdAtMs: 0,
    online: false,
  },
];

/**
 * 원장 픽스처. 다섯 줄이고, 각 줄이 이 게이트의 한 규칙을 산다.
 *
 *   running  + cloud   실행 중 · 지속        "기기를 꺼도 계속됩니다"
 *   running  + app     실행 중 · 기기 종속   "이 기기에서만"
 *   orphaned + app     대기(멘션급)          목록 맨 위
 *   idle     + app     유휴                  줄을 켜지 않는다(카드는 있다)
 *   ended    + cloud   어디에도 없다
 */
const BASE_SESSIONS = [
  {
    id: "0199AAAA-0000-7000-8000-0000000000S1",
    workspaceId,
    channelId: generalId,
    memberId,
    hostId: CLOUD_HOST,
    rootMessageId: "0199AAAA-0000-7000-8000-0000000000M1",
    tool: "codex",
    label: "릴리스 노트 초안",
    status: "running",
    observation: "open",
    observerGrantCount: 0,
    remoteAttachAvailable: true,
    startedAtMs: Date.now() - 240_000,
  },
  {
    id: "0199AAAA-0000-7000-8000-0000000000S2",
    workspaceId,
    channelId: engineId,
    memberId,
    hostId: APP_HOST,
    rootMessageId: "0199AAAA-0000-7000-8000-0000000000M2",
    tool: "codex",
    label: "마이그레이션 042 검토",
    status: "running",
    observation: "open",
    observerGrantCount: 0,
    remoteAttachAvailable: false,
    startedAtMs: Date.now() - 120_000,
  },
  {
    id: "0199AAAA-0000-7000-8000-0000000000S3",
    workspaceId,
    channelId: engineId,
    memberId,
    hostId: APP_HOST,
    rootMessageId: "0199AAAA-0000-7000-8000-0000000000M3",
    tool: "codex",
    label: "관전 터미널 회귀",
    status: "orphaned",
    observation: "open",
    observerGrantCount: 0,
    remoteAttachAvailable: false,
    startedAtMs: Date.now() - 600_000,
  },
  {
    id: "0199AAAA-0000-7000-8000-0000000000S4",
    workspaceId,
    channelId: generalId,
    memberId,
    hostId: APP_HOST,
    rootMessageId: "0199AAAA-0000-7000-8000-0000000000M4",
    tool: "codex",
    label: "스크롤 프로파일",
    status: "idle",
    observation: "open",
    observerGrantCount: 0,
    remoteAttachAvailable: false,
    startedAtMs: Date.now() - 900_000,
  },
  {
    id: "0199AAAA-0000-7000-8000-0000000000S5",
    workspaceId,
    channelId: generalId,
    memberId,
    hostId: CLOUD_HOST,
    rootMessageId: "0199AAAA-0000-7000-8000-0000000000M5",
    tool: "codex",
    label: "지난 배포 되돌리기",
    status: "ended",
    observation: "open",
    observerGrantCount: 0,
    remoteAttachAvailable: false,
    startedAtMs: Date.now() - 1_800_000,
    endedAtMs: Date.now() - 1_500_000,
    exitCode: 0,
  },
];

// red seam: 원장이 한 줄 더 낸다. 기대표는 픽스처(BASE_SESSIONS)에서 나오므로
// 화면과 갈라지고, 「숫자가 원장과 같은가」 단언이 DOM 을 실제로 읽고 있다면
// 반드시 깨진다.
const RED_EXTRA_SESSION = {
  ...BASE_SESSIONS[0],
  id: "0199AAAA-0000-7000-8000-0000000000S9",
  label: "빨간 증명용 여벌",
};

function ledger(extra = false) {
  return extra ? [...BASE_SESSIONS, RED_EXTRA_SESSION] : BASE_SESSIONS;
}

/** 픽스처가 실제로 뜻하는 수. 화면이 아니라 여기서 센다. */
function expectedFromFixture(sessions, turnStates) {
  let working = 0;
  let blocked = 0;
  let idle = 0;
  for (const s of sessions) {
    if (s.status === "running") working += 1;
    else if (s.status === "orphaned") blocked += 1;
    else if (s.status === "idle") idle += 1;
  }
  for (const state of turnStates) {
    if (state === "awaiting_approval") blocked += 1;
    else working += 1;
  }
  return { working, blocked, idle };
}

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
              connect: { client: "ade-gate", version: "6" },
            });
          } else if (command.subscribe) {
            this.subscriptions.add(command.subscribe.channel);
            replies.push({
              id: command.id,
              subscribe: {
                recoverable: true,
                positioned: true,
                // `recovered: false` 가 load-bearing 이다: true 면 웹 레일의
                // replay gate 가 agent 네임스페이스 배치를 통째로 버린다.
                recovered: false,
                epoch: "ade-gate",
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
    window.__adeGateAgentSubscribed = () => {
      for (const socket of sockets) {
        for (const name of socket.subscriptions) {
          if (name.startsWith("agent:")) return true;
        }
      }
      return false;
    };
    window.__adeGatePublish = (frame) => {
      offset += 1;
      const stamped = { ...frame, ts: frame.ts ?? Date.now() };
      for (const socket of sockets) {
        for (const name of socket.subscriptions) {
          if (!name.startsWith("agent:")) continue;
          socket.onmessage?.(
            new MessageEvent("message", {
              data: JSON.stringify({
                push: { channel: name, pub: { data: stamped, offset } },
              }),
            })
          );
        }
      }
    };
  });
}

/**
 * red seam 둘 (드라이버 쪽에서만 산다, 앱 번들보다 **먼저** 돈다).
 *
 * SESSION: 1차 판이 지었던 죽은 주소를 되돌린다. 라우트 표에 있는 것은
 *   `c/:channelId` 뿐이라 `#/channels/...` 는 와일드카드가 받아 `/` 로 보내고,
 *   그 리다이렉트는 쿼리(`?work=`)까지 함께 버린다.
 *
 * ESC: 층 스택이 서기 전의 리스너를 하나 되살린다. window 캡처 단계이고 앱보다
 *   먼저 등록되므로 — 그것이 정확히 예전 `AgentWorkPanel` 의 자리였다 —
 *   `stopImmediatePropagation` 도 이것을 막지 못한다. 서랍이 자기 층을 닫는 사이
 *   이 리스너가 작업 패널을 닫아, 한 번의 Esc 가 두 층을 가져간다.
 */
async function installRedSeams(page) {
  if (proveRedSession) {
    await page.addInitScript(() => {
      const push = history.pushState.bind(history);
      history.pushState = (state, title, url) => {
        const dead =
          typeof url === "string" && url.includes("work=")
            ? url.replace("#/c/", "#/channels/")
            : url;
        return push(state, title, dead);
      };
    });
  }
  if (proveRedEsc) {
    await page.addInitScript(() => {
      window.addEventListener(
        "keydown",
        (event) => {
          if (event.key !== "Escape") return;
          const close = document.querySelector(
            '[data-testid="agent-work-panel-close"]'
          );
          if (close instanceof HTMLElement) close.click();
        },
        true
      );
    });
  }
}

async function installRoutes(context, options = {}) {
  const sessions = options.sessions ?? ledger(false);
  await context.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
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
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: workHosts });
    if (path.endsWith("/work-sessions")) {
      return json(route, { workSessions: sessions });
    }
    if (path.endsWith("/replies")) return json(route, { messages: [] });
    if (path.includes("/messages")) return json(route, { messages: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    return json(route, {});
  });
}

async function waitForServer() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(origin)).ok) return;
    } catch {
      // preview 서버가 아직 뜨는 중.
    }
    await wait(200);
  }
  throw new Error("ade preview server never came up");
}

function statusFrame(agentMemberId, channelId, phase, runStatus) {
  return {
    type: "agent.status",
    v: 1,
    payload: {
      run_id: `${runId}-${agentMemberId.slice(-3)}`,
      agent_member_id: agentMemberId,
      channel_id: channelId,
      phase,
      run_status: runStatus,
    },
  };
}

async function publish(page, frame) {
  await page.evaluate((f) => window.__adeGatePublish(f), frame);
}

async function login(page) {
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.getByTestId("login-email").fill("ade@example.test");
  await page.getByTestId("login-password").fill("gate-only");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-item").first().waitFor();
  await page.getByTestId("channel-item").first().click();
  await page.waitForFunction(() => window.__adeGateAgentSubscribed(), undefined, {
    timeout: 15_000,
  });
}

/** 요약 줄이 실제로 그린 숫자. 조각의 종류로 읽는다(문자열 파싱이 아니다). */
async function summaryNumbers(page) {
  return page.evaluate(() => {
    const line = document.querySelector('[data-testid="ade-summary"]');
    if (line === null) return null;
    const read = (kind) => {
      const node = line.querySelector(`[data-ade-segment="${kind}"]`);
      return node === null ? 0 : Number(node.textContent ?? "0");
    };
    return {
      working: read("count"),
      blocked: read("blockedCount"),
      text: line.querySelector('[data-testid="ade-summary-text"]')?.textContent ?? "",
      label: line.querySelector('[data-testid="ade-summary-label"]')?.textContent ?? "",
    };
  });
}

async function openDrawer(page) {
  await page.getByTestId("ade-summary").click();
  await page.getByTestId("ade-drawer").waitFor();
}

async function cardFacts(page) {
  return page.locator('[data-testid="ade-card"]').evaluateAll((nodes) =>
    nodes.map((node) => ({
      kind: node.dataset.kind,
      state: node.dataset.state,
      durability: node.dataset.durability,
      title: node.querySelector('[data-testid="ade-card-title"]')?.textContent ?? "",
      badge:
        node.querySelector('[data-testid="ade-card-durability"]')?.textContent ?? "",
      chip: node.querySelector('[data-testid="ade-card-state"]')?.textContent ?? "",
      diffEmpty:
        node.querySelector('[data-testid="ade-card-diff"]')?.hasAttribute("data-empty") ??
        false,
    }))
  );
}

// ---- 1~4. 본 시나리오 --------------------------------------------------------

async function exerciseControl(browser) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await installRealtimeSocket(page);
  await installRedSeams(page);
  await installRoutes(context, { sessions: ledger(proveRedCount) });
  await login(page);

  // 열린 턴 둘: 하나는 작업 중, 하나는 승인 대기.
  await publish(page, statusFrame(agentId, generalId, "queued", "queued"));
  await publish(page, statusFrame(agentId, generalId, "streaming", "running"));
  await publish(page, statusFrame(hermesId, engineId, "queued", "queued"));
  await publish(
    page,
    statusFrame(hermesId, engineId, "awaiting_approval", "awaiting_approval")
  );

  const expected = expectedFromFixture(ledger(false), [
    "running",
    "awaiting_approval",
  ]);

  await page.getByTestId("ade-summary").waitFor({ timeout: 15_000 });
  await page.waitForFunction(
    (want) => {
      const node = document.querySelector('[data-ade-segment="count"]');
      return node !== null && Number(node.textContent ?? "0") === want;
    },
    expected.working,
    { timeout: 10_000 }
  ).catch(() => {
    // 대기는 편의다. 판정은 아래 비교가 한다.
  });

  // ---- 3. 서랍 불밀림 (여는 **전** 좌표) -----------------------------------
  //
  // 「입력창이 그 자리에 있는가」는 의견이 아니라 좌표다. 「작성 중」 줄이 컴포저를
  // 26px 밀었던 결함을 게이트가 픽셀로 잡았고(리뷰 H-2), 이 서랍은 그것보다 훨씬
  // 큰 표면이라 같은 자를 댄다.
  if (proveRedLayout) {
    // red seam: 서랍을 흐름 안의 블록으로 되돌린다 = 절대 위치를 쓰지 않은 판.
    // CSS 규칙만 바꾸므로 React 가 들고 있는 노드는 그대로다.
    await page.addStyleTag({
      content:
        '[data-testid="ade-drawer"]{position:static!important;inset:auto!important;max-inline-size:none!important}',
    });
  }
  const geometry = async () => {
    return page.evaluate(() => {
      const box = (selector) => {
        const node = document.querySelector(selector);
        if (node === null) return null;
        const rect = node.getBoundingClientRect();
        return {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        };
      };
      return {
        composer: box('[data-testid="composer-input"]'),
        header: box("main header"),
        summary: box('[data-testid="ade-summary"]'),
      };
    });
  };
  const before = await geometry();
  if (before.composer === null || before.header === null) {
    throw new Error("채널 표면을 측정할 수 없다 (컴포저/헤더가 없다)");
  }

  await openDrawer(page);

  const after = await geometry();
  console.log(
    `[layout] 컴포저 ${JSON.stringify(before.composer)} -> ${JSON.stringify(
      after.composer
    )} · 헤더 ${JSON.stringify(before.header)} -> ${JSON.stringify(after.header)}`
  );
  for (const [name, a, b] of [
    ["composer", before.composer, after.composer],
    ["header", before.header, after.header],
  ]) {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      throw new Error(
        `opening the drawer moved the route: ${name} ${JSON.stringify(
          a
        )} -> ${JSON.stringify(b)} (tokens.css ade-drawer must cover, never push)`
      );
    }
  }

  // ---- 1. 집계 정확성 -------------------------------------------------------
  const numbers = await summaryNumbers(page);
  if (numbers === null) throw new Error("요약 줄이 없다 (작업이 있는데도)");
  const cards = await cardFacts(page);
  const drawn = {
    working: cards.filter((c) => c.state === "working").length,
    blocked: cards.filter((c) => c.state === "blocked").length,
    idle: cards.filter((c) => c.state === "idle").length,
  };
  console.log(
    `[count] 원장 기대 ${JSON.stringify(expected)} · 요약 ${numbers.working}/${
      numbers.blocked
    } · 카드 ${JSON.stringify(drawn)}`
  );
  if (
    numbers.working !== expected.working ||
    numbers.blocked !== expected.blocked
  ) {
    throw new Error(
      `the summary count disagreed with the ledger: 기대 ${expected.working}/${expected.blocked}, 화면 ${numbers.working}/${numbers.blocked} (${numbers.text})`
    );
  }
  if (
    drawn.working !== expected.working ||
    drawn.blocked !== expected.blocked ||
    drawn.idle !== expected.idle
  ) {
    throw new Error(
      `the summary count disagreed with the ledger: 서랍이 ${JSON.stringify(
        drawn
      )} 장을 그렸다 (기대 ${JSON.stringify(expected)})`
    );
  }
  // 종료된 세션은 어디에도 없다. 이름으로 찾는다 — 상태 칸이 아니라 존재 자체다.
  if (cards.some((c) => c.title.includes("지난 배포 되돌리기"))) {
    throw new Error(
      "the summary count disagreed with the ledger: 종료된 세션이 관제 목록에 남았다"
    );
  }
  // 유휴는 카드로는 서지만 줄을 켜지 않는다.
  if (numbers.text.includes("유휴")) {
    throw new Error(
      `the summary count disagreed with the ledger: 유휴가 요약 줄에 실렸다 (${numbers.text})`
    );
  }

  // ---- 2. 대기 강조 ---------------------------------------------------------
  if (proveRedBlocked) {
    // red seam: 강조 조각을 나머지와 같은 잉크로 칠한다 = 강조축이 없는 판.
    await page.addStyleTag({
      content:
        '[data-ade-segment="blocked"],[data-ade-segment="blockedCount"]{color:var(--ink-muted)!important}',
    });
  }
  const inks = await page.evaluate(() => {
    const line = document.querySelector('[data-testid="ade-summary"]');
    const read = (kind) => {
      const node = line?.querySelector(`[data-ade-segment="${kind}"]`);
      return node === null || node === undefined
        ? null
        : getComputedStyle(node).color;
    };
    return { plain: read("plain"), blocked: read("blocked") };
  });
  console.log(`[blocked] plain=${inks.plain} · blocked=${inks.blocked}`);
  if (inks.blocked === null || inks.plain === null) {
    throw new Error("대기 was not emphasised: 강조 조각이 아예 없다");
  }
  if (inks.blocked === inks.plain) {
    throw new Error(
      `대기 was not emphasised: 강조 조각이 나머지와 같은 잉크다 (${inks.blocked})`
    );
  }
  // 순서도 강조축이다: 대기가 맨 위.
  if (cards[0]?.state !== "blocked") {
    throw new Error(
      `대기 was not emphasised: 목록 맨 위가 ${cards[0]?.state} 다 (대기가 멘션급이라는 D1 이 순서에 없다)`
    );
  }

  // ---- 4. 생존성 정직 -------------------------------------------------------
  const deviceBound = cards.filter((c) => c.durability === "device_bound");
  const persistent = cards.filter((c) => c.durability === "persistent");
  console.log(
    `[durability] 기기 종속 ${deviceBound.length}장 · 지속 ${persistent.length}장`
  );
  for (const card of deviceBound) {
    if (card.badge.includes(PERSISTENT_BADGE)) {
      throw new Error(
        `a device-bound session claimed it survives the lid: "${card.title}" -> "${card.badge}"`
      );
    }
    if (!card.badge.includes(DEVICE_BADGE)) {
      throw new Error(
        `a device-bound session claimed it survives the lid: "${card.title}" 이 자기 등급을 말하지 않았다 ("${card.badge}")`
      );
    }
  }
  if (persistent.length === 0) {
    throw new Error(
      `a device-bound session claimed it survives the lid: 지속 등급 카드가 한 장도 없다 (호스트 파생이 끊겼다)`
    );
  }
  for (const card of persistent) {
    if (!card.badge.includes(PERSISTENT_BADGE)) {
      throw new Error(
        `a device-bound session claimed it survives the lid: 지속 세션이 "${card.badge}" 라고 말했다`
      );
    }
  }
  // 턴에는 호스트가 없다. 등급은 `unknown` 이고 배지는 **그리지 않는다** — 모든
  // 턴이 「실행 위치 확인 필요」를 하나씩 달고 서면 경고가 기본값이 된다.
  const runCards = cards.filter((c) => c.kind === "run");
  if (runCards.length === 0) throw new Error("턴 카드가 목록에 없다");
  for (const card of runCards) {
    if (card.durability !== "unknown") {
      throw new Error(
        `a device-bound session claimed it survives the lid: 턴 카드가 "${card.durability}" 를 주장했다 (턴에는 호스트가 없다)`
      );
    }
    if (card.badge !== "") {
      throw new Error(
        `a device-bound session claimed it survives the lid: 턴 카드가 생존성 배지를 세웠다 ("${card.badge}")`
      );
    }
  }

  // diff 는 아직 서버에 없다. 자리는 있고, 숫자는 없다.
  if (!cards.every((c) => c.diffEmpty)) {
    throw new Error("서버가 주지 않은 diff 를 카드가 그렸다");
  }

  // ---- 7. live 영역이 아니다 -------------------------------------------------
  const live = await page.evaluate(() => {
    const line = document.querySelector('[data-testid="ade-summary"]');
    return line === null ? null : line.closest("[aria-live]") !== null;
  });
  if (live !== false) {
    throw new Error(
      "the summary line sits inside a live region; a count that changes this often would be read aloud over the reader's work"
    );
  }

  // ---- 6. 카드 확대: 서랍은 물러난다 ------------------------------------------
  //
  // **두 종류를 다 누른다.** 1차 게이트는 턴 카드만 눌렀고, 그 구멍으로 세션 카드가
  // 죽은 주소를 들고 통과했다(리뷰 B1). 카드가 두 종류라는 것은 이 표면의 설계이지
  // 구현 세부가 아니므로, 확대 검사도 두 종류다.
  const sessionCardIndex = cards.findIndex((c) => c.kind === "session");
  if (sessionCardIndex < 0) throw new Error("세션 카드가 목록에 없다");
  const sessionTitle = cards[sessionCardIndex].title;
  await page.locator('[data-testid="ade-card"]').nth(sessionCardIndex).click();
  await page.getByTestId("ade-drawer").waitFor({ state: "detached" });
  const landed = await page
    .getByTestId("work-panel")
    .waitFor({ timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  const hash = await page.evaluate(() => location.hash);
  if (!landed || !hash.startsWith("#/c/")) {
    throw new Error(
      `the session card led nowhere: "${sessionTitle}" 를 눌렀는데 작업 세션 패널이 ${
        landed ? "섰지만" : "서지 않았고"
      } 주소는 ${hash} 다 (라우트 표에 있는 것은 c/:channelId 뿐이고, 와일드카드는 쿼리까지 버린 채 / 로 보낸다)`
    );
  }
  console.log(`[expand] 세션 카드 -> 작업 세션 패널 (${hash})`);
  await page.getByTestId("work-panel-close").click();

  await openDrawer(page);
  const reopened = await cardFacts(page);
  const runCardIndex = reopened.findIndex((c) => c.kind === "run");
  if (runCardIndex < 0) throw new Error("턴 카드가 목록에 없다");
  await page.locator('[data-testid="ade-card"]').nth(runCardIndex).click();
  await page.getByTestId("ade-drawer").waitFor({ state: "detached" });
  await page.getByTestId("agent-work-panel").waitFor({ timeout: 5_000 });
  if ((await page.getByTestId("ade-drawer").count()) !== 0) {
    throw new Error(
      "카드를 확대했는데 서랍이 그대로 남았다: 두 부차 표면이 같은 층에 겹친다"
    );
  }
  console.log("[expand] 턴 카드 -> 작업 패널, 서랍은 물러났다");

  // ---- 9·11. 덮인 형제와 남는 띠 ----------------------------------------------
  //
  // 여기부터는 **작업 패널이 열려 있는 채로** 서랍을 연다. 리뷰가 잡은 두 결함이
  // 정확히 이 상태에서만 보인다: 가려진 패널이 탭 순서에 남았고(H1 ②), 서랍
  // 오른쪽에 19px 짜리 라우트 조각이 걸렸다(M3, 899px 실측).
  const panelInert = async () =>
    page.evaluate(() => {
      const panel = document.querySelector('[data-testid="agent-work-panel"]');
      return panel === null ? null : panel.hasAttribute("inert");
    });
  const routeStrip = async () =>
    page.evaluate(() => {
      const drawer = document.querySelector('[data-testid="ade-drawer"]');
      // 스크림이 곧 라우트 상자다(`inset: 0`). 상자를 따로 재지 않는 이유는 그
      // 둘이 같아야 한다는 것이 H2 수리의 계약이기 때문이다.
      const box = document.querySelector('[data-testid="ade-scrim"]');
      if (drawer === null || box === null) return null;
      const d = drawer.getBoundingClientRect();
      const b = box.getBoundingClientRect();
      return {
        strip: Math.round(b.right - d.right),
        box: Math.round(b.width),
        drawer: Math.round(d.width),
      };
    });

  await page.setViewportSize({ width: 899, height: 900 });
  await openDrawer(page);
  const narrow = await routeStrip();
  console.log(
    `[strip] 899px: 라우트 상자 ${narrow?.box}px · 서랍 ${narrow?.drawer}px · 남는 띠 ${narrow?.strip}px`
  );
  if (narrow === null || narrow.strip !== 0) {
    throw new Error(
      `the drawer left a sliver of route: 899px 에서 ${narrow?.strip}px 가 남았다 (반쯤 잘린 컨트롤이 걸리는 폭 — 전면 문턱은 1200px 이어야 한다)`
    );
  }
  if ((await panelInert()) !== true) {
    throw new Error(
      "a covered sibling stayed in the tab order: 서랍이 통째로 덮은 작업 패널에 inert 가 없다 (라우트에만 걸려 있다)"
    );
  }

  await page.setViewportSize({ width: 1280, height: 900 });
  const wide = await routeStrip();
  console.log(
    `[strip] 1280px: 라우트 상자 ${wide?.box}px · 서랍 ${wide?.drawer}px · 남는 칸 ${wide?.strip}px`
  );
  if (wide === null || wide.strip < 320) {
    throw new Error(
      `the drawer left a sliver of route: 1280px 에서 ${wide?.strip}px 만 남았다 (남는 것은 띠가 아니라 최소 한 칸 320px 이어야 한다)`
    );
  }
  if ((await panelInert()) !== true) {
    throw new Error(
      "a covered sibling stayed in the tab order: 넓은 창에서도 서랍이 열린 동안 작업 패널은 받지 않는다"
    );
  }

  // ---- 10. 바깥 클릭 (리뷰 H2) -------------------------------------------------
  //
  // 덮이지 않은 라우트 영역은 `inert` 라 아무 버튼도 눌리지 않는다. 그 상태에서
  // 클릭까지 아무 일도 하지 않으면 그 절반은 「살아 보이는 시체」다. 사이드바
  // 서랍이 스크림을 버튼으로 세운 것과 같은 답을 이 서랍도 갖는다.
  if (proveRedOutside) {
    // red seam: 스크림은 그 자리에 그대로 서 있고 클릭만 통과시킨다 = 히트면이
    // 없던 판. 노드도 색도 그대로라 「보이니까 반응한다」만 사라진다.
    await page.addStyleTag({
      content: '[data-testid="ade-scrim"]{pointer-events:none!important}',
    });
  }
  await page.mouse.click(1000, 400);
  await page
    .getByTestId("ade-drawer")
    .waitFor({ state: "detached", timeout: 3_000 })
    .catch(() => {});
  if ((await page.getByTestId("ade-drawer").count()) !== 0) {
    throw new Error(
      "clicking the uncovered route did nothing: 서랍이 라우트를 못 쓰게 해 놓고 바깥 클릭도 받지 않았다"
    );
  }
  if ((await panelInert()) !== false) {
    throw new Error(
      "a covered sibling stayed in the tab order: 서랍이 닫혔는데 작업 패널의 inert 가 남았다"
    );
  }
  console.log("[outside] 덮이지 않은 라우트 클릭 -> 서랍이 닫혔다");

  // ---- 8. Esc 는 한 층만 (리뷰 H1 ①) ------------------------------------------
  await openDrawer(page);
  await page.keyboard.press("Escape");
  await page
    .getByTestId("ade-drawer")
    .waitFor({ state: "detached", timeout: 3_000 })
    .catch(() => {});
  if ((await page.getByTestId("ade-drawer").count()) !== 0) {
    throw new Error("Esc 를 눌렀는데 서랍이 닫히지 않았다 (가장 위 층이 이것이다)");
  }
  if ((await page.getByTestId("agent-work-panel").count()) !== 1) {
    throw new Error(
      "one Escape closed two layers: 서랍을 닫으려 누른 한 번이 그 아래 작업 패널까지 닫았다 (Esc 는 가장 위 층의 것이다)"
    );
  }
  // 그리고 그 다음 Esc 는 아래 층을 닫는다 — 스택이 층을 삼키지 않는다는 증명.
  await page.keyboard.press("Escape");
  await page.getByTestId("agent-work-panel").waitFor({ state: "detached" });
  console.log("[esc] 첫 Esc = 서랍만 · 둘째 Esc = 작업 패널");

  await context.close();
}

// ---- 5. 빈 상태 --------------------------------------------------------------

async function exerciseEmpty(browser) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await installRealtimeSocket(page);
  // 종료된 세션만 있는 원장. 「없다」와 「모른다」를 가르려고 빈 배열이 아니라
  // 끝난 것들을 낸다 — 빈 배열이면 목이 아무 말도 안 한 것과 구별되지 않는다.
  await installRoutes(context, {
    sessions: BASE_SESSIONS.filter((s) => s.status === "ended"),
  });
  await login(page);
  await wait(1_500);

  if ((await page.getByTestId("ade-summary").count()) !== 0) {
    const text = await page.getByTestId("ade-summary").textContent();
    throw new Error(
      `살아 있는 작업이 0인데 요약 줄이 있다: "${text}" (빈 자리도 남기지 않는 것이 이 줄의 계약이다)`
    );
  }
  // 예약된 빈 띠도 없다: 라우트 맨 위는 채널 헤더가 받는다.
  const topOfRoute = await page.evaluate(() => {
    const header = document.querySelector("main header");
    const main = document.querySelector("main");
    if (header === null || main === null) return null;
    return Math.round(
      header.getBoundingClientRect().y - main.getBoundingClientRect().y
    );
  });
  console.log(`[empty] 요약 줄 없음 · 라우트 상단 여백 ${topOfRoute}px`);
  if (topOfRoute === null || topOfRoute > 4) {
    throw new Error(
      `작업이 0인데 라우트 위에 ${topOfRoute}px 가 예약돼 있다`
    );
  }
  await context.close();
}

// ---- 캡처 (판정하지 않는다, SKILL §11) ---------------------------------------

async function captureShots(browser) {
  const outDir = resolve(webRoot, "artifacts/ade");
  mkdirSync(outDir, { recursive: true });
  const shots = [];
  for (const scheme of ["light", "dark"]) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      reducedMotion: "reduce",
      colorScheme: scheme,
    });
    const page = await context.newPage();
    await installRealtimeSocket(page);
    await installRoutes(context, {});
    await login(page);
    await publish(page, statusFrame(agentId, generalId, "queued", "queued"));
    await publish(page, statusFrame(agentId, generalId, "streaming", "running"));
    await publish(page, statusFrame(hermesId, engineId, "queued", "queued"));
    await publish(
      page,
      statusFrame(hermesId, engineId, "awaiting_approval", "awaiting_approval")
    );
    await page.getByTestId("ade-summary").waitFor({ timeout: 15_000 });
    const closed = resolve(outDir, `ade-summary-${scheme}.png`);
    await page.screenshot({ path: closed });
    shots.push(closed);

    await openDrawer(page);
    const open = resolve(outDir, `ade-drawer-${scheme}.png`);
    await page.screenshot({ path: open });
    shots.push(open);

    // 좁은 폭: 서랍이 표면을 통째로 받는 판(tokens.css 600px 문턱).
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId("ade-drawer").waitFor();
    const narrow = resolve(outDir, `ade-drawer-narrow-${scheme}.png`);
    await page.screenshot({ path: narrow });
    shots.push(narrow);

    await context.close();
  }
  console.log(
    "[shots] artifacts/ade/ade-{summary,drawer,drawer-narrow}-{light,dark}.png"
  );
  return shots;
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
      await exerciseControl(browser);
      await exerciseEmpty(browser);
      await captureShots(browser);
    } finally {
      await browser.close();
    }
  } finally {
    server.kill("SIGTERM");
  }
  console.log("GATE PASS: 집계가 원장과 일치하고(종료 제외·유휴는 줄을 켜지 않음),");
  console.log("           대기가 잉크와 순서 양쪽에서 강조되며, 서랍은 라우트를");
  console.log("           한 픽셀도 밀지 않고, 기기 종속 세션은 지속을 주장하지");
  console.log("           않으며, 작업 0에서는 줄 자체가 없다. 카드는 두 종류 다");
  console.log("           살아 있는 표면으로 확대되고, Esc 한 번은 한 층만 닫으며,");
  console.log("           덮인 형제는 탭 순서에서 빠지고, 덮이지 않은 라우트는");
  console.log("           눌리면 서랍을 닫는다 — 남는 것은 띠가 아니라 한 칸이다.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
