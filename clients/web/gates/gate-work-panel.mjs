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
//
// red seam은 **목/드라이버의 행동만** 바꾼다. ORDER는 델타를 거꾸로 발행하고,
// ARGS는 값 마커를 화면에 실제로 그려지는 자리(도구 이름)에 심어 "값은 절대
// 화면에 없다" 단언이 DOM을 읽고 있음을 증명하고, FOLD는 검사 전에 디스클로저를
// 먼저 펼치고, VOLATILE은 다시 연 패널에 지나간 문장을 되쏜다. 제품 소스 줄을
// 지우거나 단언을 빼라고 요구하지 않으므로 증명은 반복 가능하다.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

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
      return json(route, { channels });
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
    if (path.endsWith("/work-sessions")) return json(route, { sessions: [] });
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
  throw new Error("work panel preview server never came up");
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
      for (const scenario of scenarios) {
        await exerciseScenario(browser, scenario);
      }
      await exerciseCoOpen(browser);
      if (process.env.WORK_PANEL_GATE_SHOTS === "1") {
        await captureShots(browser);
      }
    } finally {
      await browser.close();
    }
  } finally {
    server.kill("SIGTERM");
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
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
