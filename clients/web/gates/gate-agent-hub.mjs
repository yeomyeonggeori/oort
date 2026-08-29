#!/usr/bin/env node
// GATE: MOMO-652 workspace agent hub.
//
// The three scenarios intentionally skew roster, memory, and history response
// timing. A late response must stay attached to its lower-cased agent/query key
// instead of replacing whichever agent or section is visible when it arrives.
//
// Named red proofs, run only from a throwaway worktree:
//   AGENT_HUB_GATE_PROVE_RED_INVALIDATE=1 npm run gate:agent-hub
//     expected failure: "memory invalidate round-trip"
//   AGENT_HUB_GATE_PROVE_RED_HISTORY=1 npm run gate:agent-hub
//     expected failure: "history cursor page"
//   AGENT_HUB_GATE_PROVE_RED_PAUSE=1 npm run gate:agent-hub
//     expected failure: "pause projection"
//
// The red seams alter fixture behavior, not product source lines. A proof is
// therefore repeatable and does not ask a reviewer to delete an assertion.

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "./preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.AGENT_HUB_GATE_PORT || 5186);
const origin = `http://127.0.0.1:${port}`;
const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const agentId = "AAAAAAAA-AAAA-7AAA-8AAA-AAAAAAAAA652";
const otherAgentId = "BBBBBBBB-BBBB-7BBB-8BBB-BBBBBBBBB652";
const channelId = "00000000-0000-7000-8000-000000000201";
const memoryId = "CCCCCCCC-CCCC-7CCC-8CCC-CCCCCCCCCC01";
const runNewest = "DDDDDDDD-DDDD-7DDD-8DDD-DDDDDDDDDD01";
const runMiddle = "DDDDDDDD-DDDD-7DDD-8DDD-DDDDDDDDDD02";
const runOldest = "DDDDDDDD-DDDD-7DDD-8DDD-DDDDDDDDDD03";
const proveRedInvalidate =
  process.env.AGENT_HUB_GATE_PROVE_RED_INVALIDATE === "1";
const proveRedHistory =
  process.env.AGENT_HUB_GATE_PROVE_RED_HISTORY === "1";
const proveRedPause = process.env.AGENT_HUB_GATE_PROVE_RED_PAUSE === "1";

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
  realtimeWebSocketUrl: "ws://agent-hub-gate.invalid/connection/websocket",
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
    displayName:
      "김인턴 프로덕션 릴리스 품질 보증 및 고객 영향 분석 담당 에이전트",
    handle: "kim-intern",
    channelCount: 1,
    channelIds: [channelId],
    capabilities: ["github.read", "work.observe"],
    ownerHumanId: memberId,
    agentModel: "hermes-agent",
    createdAtMs: 0,
    updatedAtMs: 0,
  },
  {
    id: otherAgentId,
    workspaceId,
    kind: "agent",
    status: "active",
    role: "member",
    displayName: "나디아 Research",
    handle: "nadia-research",
    channelCount: 1,
    channelIds: [channelId],
    capabilities: ["search.read"],
    ownerHumanId: memberId,
    agentModel: "hermes-fast",
    createdAtMs: 0,
    updatedAtMs: 0,
  },
];

function profile(id, paused = false) {
  return {
    agentMemberId: id,
    workspaceId,
    instructions:
      id.toLowerCase() === agentId.toLowerCase()
        ? "근거를 먼저 확인하고, 모르면 모른다고 답합니다."
        : "조사 범위를 먼저 밝힙니다.",
    modelPref: id.toLowerCase() === agentId.toLowerCase()
      ? "hermes-fast"
      : "hermes-agent",
    effortPref: "high",
    enabledTools: ["github.read"],
    triggers: { mention: true, schedule: { expression: "0 9 * * 1-5" } },
    paused,
    version: paused ? 2 : 1,
    updatedBy: memberId,
    updatedAtMs: 1_785_238_400_000,
  };
}

const memory = {
  id: memoryId,
  workspaceId,
  scope: "agent",
  agentMemberId: agentId,
  kind: "preference",
  body: "배포 판단에는 테스트 결과와 되돌리기 절차를 함께 제시합니다.",
  confidence: 0.92,
  validAtMs: 1_785_238_400_000,
  createdByKind: "human",
  createdByMemberId: memberId,
  createdAtMs: 1_785_238_400_000,
  updatedAtMs: 1_785_238_400_000,
  sourceRefs: [{ messageId: "EEEEEEEE-EEEE-7EEE-8EEE-EEEEEEEEEE01", channelId }],
};

const runs = [
  {
    id: runNewest,
    channelId,
    triggerMessageId: "EEEEEEEE-EEEE-7EEE-8EEE-EEEEEEEEEE02",
    triggerSummary: "웹 에이전트 허브 검증",
    status: "running",
    startedAtMs: 1_785_238_403_000,
    createdAtMs: 1_785_238_403_000,
    updatedAtMs: 1_785_238_404_000,
  },
  {
    id: runMiddle,
    channelId,
    triggerSummary: "Memory Plane 계약 점검",
    status: "succeeded",
    startedAtMs: 1_785_238_402_000,
    finishedAtMs: 1_785_238_402_500,
    createdAtMs: 1_785_238_402_000,
    updatedAtMs: 1_785_238_402_500,
  },
  {
    id: runOldest,
    channelId,
    triggerSummary: "권한 투영 확인",
    status: "failed",
    startedAtMs: 1_785_238_401_000,
    finishedAtMs: 1_785_238_401_500,
    createdAtMs: 1_785_238_401_000,
    updatedAtMs: 1_785_238_401_500,
  },
];

const timings = [
  { name: "roster-memory-history", roster: 20, memory: 160, history: 300 },
  { name: "history-roster-memory", roster: 180, memory: 300, history: 20 },
  { name: "memory-history-roster", roster: 300, memory: 20, history: 160 },
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
    class GateWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      constructor(url) {
        this.url = url;
        this.readyState = GateWebSocket.CONNECTING;
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
              return { id: command.id, connect: { client: "agent-hub-gate", version: "6" } };
            }
            if (command.subscribe) {
              return {
                id: command.id,
                subscribe: {
                  recoverable: true,
                  positioned: true,
                  recovered: false,
                  epoch: "agent-hub-gate",
                  offset: 0,
                },
              };
            }
            if (command.unsubscribe) {
              // gate-my-sessions의 원본 목에는 있던 분기가 복사에서 빠졌다.
              // 응답 없는 unsubscribe는 centrifuge를 disconnect로 몰아
              // useOffline이 true가 되고 쓰기 버튼이 전부 disabled였다(실측).
              return { id: command.id, unsubscribe: {} };
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
  });
}

async function installRoutes(context, timing) {
  const state = {
    paused: false,
    invalidated: false,
    historyCalls: 0,
  };
  await context.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === "/v1/auth/login") return json(route, session);
    if (path === "/v1/auth/realtime-token") {
      // gate-my-sessions에는 있던 목이 복사에서 빠졌다. 토큰이 안 오면 레일이
      // disconnected로 떨어져 useOffline이 true — 쓰기 버튼 전부 disabled(실측).
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
      await wait(timing.roster);
      return json(route, { members: roster });
    }
    if (path.endsWith("/channels")) {
      return json(route, {
        channels: [{
          id: channelId,
          workspaceId,
          kind: "public",
          name: "agent-hub",
          muted: false,
        }],
      });
    }
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.includes("/messages")) return json(route, { messages: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path === "/v1/provider/effort-table") {
      return json(route, {
        schema: "momo.provider.effort_table.v0",
        levels: ["low", "medium", "high", "xhigh", "max"],
        fallback: {
          efforts: ["low", "medium", "high"],
          defaultEffort: "medium",
        },
        providers: [
          {
            provider: "hermes",
            models: [
              {
                model: "hermes-agent",
                efforts: ["low", "medium", "high", "xhigh", "max"],
                defaultEffort: "medium",
              },
              {
                model: "hermes-fast",
                efforts: ["low", "medium"],
                defaultEffort: "low",
              },
            ],
          },
        ],
      });
    }
    if (path.endsWith("/allowed-models")) {
      return json(route, { allowedAgentModels: ["hermes-agent", "hermes-fast"] });
    }
    if (path.endsWith("/profile")) {
      const id = path.split("/").at(-2);
      if (id.toLowerCase() === otherAgentId.toLowerCase()) {
        return json(route, { error: "agent profile not found" }, 404);
      }
      return json(route, { profile: profile(id, state.paused && id.toLowerCase() === agentId.toLowerCase()) });
    }
    if (path.endsWith("/pause") && request.method() === "PUT") {
      const body = request.postDataJSON();
      if (!proveRedPause) state.paused = body.paused === true;
      return json(route, { profile: profile(agentId, state.paused) });
    }
    if (path.endsWith("/memories/search")) {
      await wait(timing.memory);
      return json(route, { hits: state.invalidated ? [] : [{ memory, score: 0.98 }] });
    }
    if (path.endsWith("/memories") && request.method() === "GET") {
      await wait(timing.memory);
      return json(route, { memories: state.invalidated ? [] : [memory] });
    }
    if (path.endsWith(`/${memoryId.toLowerCase()}/invalidate`) ||
        path.toLowerCase().endsWith(`/${memoryId.toLowerCase()}/invalidate`)) {
      if (!proveRedInvalidate) state.invalidated = true;
      return json(route, { memory: { ...memory, invalidAtMs: Date.now() } });
    }
    if (path.toLowerCase().endsWith(`/${memoryId.toLowerCase()}/grants`)) {
      return json(route, {
        grants: [{
          id: "FFFFFFFF-FFFF-7FFF-8FFF-FFFFFFFFFF01",
          workspaceId,
          memoryId,
          granteeKind: "agent",
          granteeId: otherAgentId,
          grantedBy: memberId,
          createdAtMs: 1_785_238_400_000,
        }],
      });
    }
    if (path.toLowerCase().endsWith(`/${agentId.toLowerCase()}/runs`)) {
      state.historyCalls += 1;
      await wait(timing.history);
      if (url.searchParams.has("cursor")) {
        return json(route, {
          runs: proveRedHistory ? [runs[1]] : [runs[2]],
          ...(proveRedHistory ? { nextCursor: runMiddle } : {}),
        });
      }
      return json(route, { runs: runs.slice(0, 2), nextCursor: runMiddle });
    }
    if (path.toLowerCase().includes("/agent-runs/")) {
      const id = path.split("/").at(-1);
      const summary = runs.find((run) => run.id.toLowerCase() === id.toLowerCase()) ?? runs[0];
      return json(route, {
        ...summary,
        workspaceId,
        agentMemberId: agentId,
        stepCount: 2,
        maxSteps: 8,
        input: {
          type: "work",
          title: summary.triggerSummary,
          brief: "기존 run 상세 경로를 통해 읽는 검증된 작업 설명입니다.",
        },
      });
    }
    return json(route, {});
  });
  return state;
}

async function login(page) {
  await page.goto(origin, { waitUntil: "networkidle" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("agent-hub@example.test");
  await page.getByTestId("login-password").fill("gate-only");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("nav-agents").waitFor();
  await page.getByTestId("nav-agents").click();
  await page.getByTestId("agent-hub-route").waitFor();
}

async function exerciseScenario(browser, timing, interactive) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await installRealtimeSocket(page);
  const state = await installRoutes(context, timing);
  await login(page);

  const rows = page.getByTestId("agent-hub-agent-row");
  await rows.first().waitFor();
  if ((await rows.count()) !== 2) {
    throw new Error(`${timing.name}: roster list expected 2 agents`);
  }
  const firstId = await rows.first().getAttribute("data-agent-id");
  if (firstId !== agentId.toLowerCase()) {
    throw new Error(`${timing.name}: UUID normalization mixed the selected agent`);
  }
  await page.waitForFunction(
    (id) => {
      const row = document.querySelector(`[data-agent-id="${id}"]`);
      return row && !row.textContent?.includes("상태 확인 중");
    },
    otherAgentId.toLowerCase()
  );
  const missingProfileCopy = await page
    .locator(`[data-agent-id="${otherAgentId.toLowerCase()}"]`)
    .textContent();
  if (
    missingProfileCopy?.includes("상태 확인 실패") ||
    !missingProfileCopy?.includes("활성")
  ) {
    throw new Error(
      `${timing.name}: profile 404 was promoted to a roster failure`
    );
  }

  const tabLineCounts = await page
    .locator('[data-testid^="agent-hub-tab-"]')
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        return range.getClientRects().length;
      })
    );
  if (tabLineCounts.some((count) => count !== 1)) {
    throw new Error(
      `${timing.name}: long agent name forced a section tab onto multiple lines`
    );
  }

  await page.getByTestId("agent-hub-tab-memory").click();
  await page.getByTestId("agent-memory-list").waitFor();
  const memoryRowId = await page.getByTestId("agent-memory-row").getAttribute("data-memory-id");
  if (memoryRowId !== memoryId.toLowerCase()) {
    throw new Error(`${timing.name}: delayed memory landed on the wrong agent`);
  }

  await page.getByTestId("agent-hub-tab-history").click();
  await page.getByTestId("agent-history-list").waitFor();
  const runIds = await page
    .getByTestId("agent-history-row")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-run-id")));
  if (runIds.join(",") !== [runNewest, runMiddle].map((id) => id.toLowerCase()).join(",")) {
    throw new Error(`${timing.name}: delayed history order or UUID normalization drifted`);
  }

  if (interactive) {
    await page.getByTestId("agent-history-more").click();
    await page.waitForTimeout(timing.history + 300);
    const afterMore = await page.getByTestId("agent-history-row").count();
    if (afterMore !== 3 || state.historyCalls !== 2) {
      throw new Error(
        `history cursor page: expected 3 unique rows in 2 calls, got ${afterMore} rows in ${state.historyCalls} calls`
      );
    }

    await page.getByTestId("agent-history-row").first().click();
    await page.getByRole("dialog").waitFor();
    await page.getByRole("button", { name: "상세 닫기" }).click();

    await page.getByTestId("agent-hub-tab-memory").click();
    await page.getByTestId("agent-memory-invalidate").click();
    await page.getByTestId("agent-memory-invalidate-confirm").click();
    await page.waitForTimeout(timing.memory + 300);
    const invalidationEmpty = await page.getByTestId("agent-memory-empty").count();
    if (!state.invalidated || invalidationEmpty !== 1) {
      throw new Error(
        `memory invalidate round-trip: expected empty refetch, state=${state.invalidated}, empty=${invalidationEmpty}`
      );
    }

    await page.getByTestId("agent-hub-tab-profile").click();
    const effortSelect = page.getByTestId("agent-hub-routing-effort");
    if (
      await effortSelect.isDisabled() ||
      (await effortSelect.locator("option").count()) < 2
    ) {
      throw new Error(
        "effort table ready path: real schema did not unlock effort choices"
      );
    }
    await page.getByTestId("agent-hub-pause").click();
    await page.waitForTimeout(300);
    const resumeButton = await page
      .getByRole("button", { name: "에이전트 재개" })
      .count();
    if (!state.paused || resumeButton !== 1) {
      throw new Error(
        `pause projection: expected paused=true and resume action, state=${state.paused}, resume=${resumeButton}`
      );
    }

    await page.setViewportSize({ width: 760, height: 480 });
    const ownerSummary = page.getByTestId("agent-hub-owner-summary");
    await ownerSummary.scrollIntoViewIfNeeded();
    const ownerBox = await ownerSummary.boundingBox();
    const ownerVisible = await ownerSummary.isVisible();
    if (!ownerVisible || ownerBox === null || ownerBox.width <= 0) {
      throw new Error(
        `narrow detail value width: expected visible dd wider than zero at 760x480, got ${ownerBox?.width ?? "missing"}`
      );
    }
    const narrowTabLineCounts = await page
      .locator('[data-testid^="agent-hub-tab-"]')
      .evaluateAll((nodes) =>
        nodes.map((node) => {
          const range = document.createRange();
          range.selectNodeContents(node);
          return range.getClientRects().length;
        })
      );
    if (narrowTabLineCounts.some((count) => count !== 1)) {
      throw new Error(
        "narrow section tabs: a tab label wrapped instead of keeping its intrinsic width"
      );
    }
  }
  await context.close();
}

async function main() {
  if (!existsSync(resolve(webRoot, "dist/index.html"))) {
    throw new Error("dist/ is missing. Run npm run build first.");
  }
  const server = await startGuardedPreview({
    webRoot,
    port,
    portEnvVar: "AGENT_HUB_GATE_PORT",
  });
  try {
    const browser = await chromium.launch();
    try {
      for (let index = 0; index < timings.length; index += 1) {
        await exerciseScenario(browser, timings[index], index === 0);
      }
    } finally {
      await browser.close();
    }
  } finally {
    await server.stop();
  }
  console.log(
    "GATE PASS: agent roster, profile 404, narrow detail, tab width, effort readiness,"
  );
  console.log(
    "           memory invalidation, history cursor, pause projection, and three skewed timings stayed agent-scoped."
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
