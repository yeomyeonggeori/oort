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
//   5. 인자 접힘       `tool_call_args`는 기본 접힘이고 명시적으로 펼쳐야 보인다.
//
// 세 시나리오는 REST 응답 지연과 프레임 간격을 서로 다르게 흔든다(지연 편차 목).
// 마지막 시나리오는 패널을 열기 **전에** 도구 프레임을 흘려 보내, 패널이 못 본
// 것을 봤다고 말하지 않는지 확인한다.
//
// 이름 붙은 red proof (버릴 워크트리에서만 돌린다):
//   WORK_PANEL_GATE_PROVE_RED_ORDER=1 npm run gate:work-panel
//     expected failure: "delta order"
//   WORK_PANEL_GATE_PROVE_RED_ARGS=1 npm run gate:work-panel
//     expected failure: "tool args folded by default"
//   WORK_PANEL_GATE_PROVE_RED_VOLATILE=1 npm run gate:work-panel
//     expected failure: "a closed panel kept (or backfilled) history"
//
// red seam은 **목/드라이버의 행동만** 바꾼다. ORDER는 델타를 거꾸로 발행하고,
// ARGS는 검사 전에 디스클로저를 먼저 펼치고, VOLATILE은 다시 연 패널에 지나간
// 문장을 되쏜다. 제품 소스 줄을 지우거나 단언을 빼라고 요구하지 않으므로 증명은
// 반복 가능하다.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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
const proveRedVolatile = process.env.WORK_PANEL_GATE_PROVE_RED_VOLATILE === "1";

const DELTAS = ["배포 로그를 ", "먼저 ", "읽었습니다."];
const DELTA_SENTENCE = DELTAS.join("");
const REOPEN_DELTA = "다시 열고 나서 온 줄입니다.";
const MISSED_DELTA = "닫혀 있는 동안 흘러간 줄입니다.";
const TOOL_NAME = "work.session.end";
const TOOL_ARG_MARKER = "/Users/seongjae/projects/momo/secret-plan.md";

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

const scenarios = [
  { name: "burst", roster: 20, channels: 20, frameGapMs: 0, toolBeforeOpen: false },
  { name: "slow-roster", roster: 280, channels: 40, frameGapMs: 120, toolBeforeOpen: false },
  { name: "pre-open-tool", roster: 40, channels: 280, frameGapMs: 40, toolBeforeOpen: true },
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
    if (path.includes("/messages")) return json(route, { messages: [] });
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

  // run은 이미 흐르고 있다. 패널은 그 다음에 붙는다 — v0에서 이것이 유일한
  // 진입 경로이고, 그래서 잘림 고지가 예외가 아니라 기본값이다.
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

  // ---- 3. 도구 단계와 인자 접힘 ---------------------------------------------
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
  await page.getByTestId("agent-work-panel-args-toggle").waitFor();
  if (proveRedArgs) {
    // red seam: 검사 전에 사람이 펼친 척한다. 접힘 단언이 살아 있다면 여기서
    // 반드시 깨진다.
    await page.getByTestId("agent-work-panel-args-toggle").click();
    await page.getByTestId("agent-work-panel-args").waitFor();
  }
  const foldedBody =
    (await page.getByTestId("agent-work-panel").textContent()) ?? "";
  if (foldedBody.includes(TOOL_ARG_MARKER)) {
    throw new Error(
      `${label}: tool args folded by default — the argument path was on screen without an explicit expand`
    );
  }
  if (!foldedBody.includes(TOOL_NAME)) {
    throw new Error(`${label}: tool step must state its name (${TOOL_NAME})`);
  }
  await page.getByTestId("agent-work-panel-args-toggle").click();
  await page.getByTestId("agent-work-panel-args").waitFor();
  const expandedBody =
    (await page.getByTestId("agent-work-panel").textContent()) ?? "";
  if (!expandedBody.includes(TOOL_ARG_MARKER)) {
    throw new Error(
      `${label}: an explicitly expanded disclosure must actually show the args`
    );
  }
  const cost = await page.getByTestId("agent-work-panel-cost").textContent();
  if (!cost || !cost.includes("$")) {
    throw new Error(`${label}: cost snapshot missing, read "${cost}"`);
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
    "           held across three skewed REST/frame timings."
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
