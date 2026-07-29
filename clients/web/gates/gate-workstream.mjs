#!/usr/bin/env node
// GATE: MOMO-677 작업 흐름 (ADR-0143 web surface).
//
// Fixture-only: no backend, no credentials. Four things are locked here, and
// they are the four claims the surface makes that a screenshot cannot check:
//
//   1. 목록 렌더 — rows carry the goal, the four-value status chip, the run and
//      active counts, and the server's own `?status=` filter actually reaches
//      the server (the request is inspected, not assumed).
//   2. 이력 A·B 병기 — one goal's history shows BOTH actors. This is the whole
//      evidence of ADR-0143 D2: continuity belongs to the workstream, so the
//      Run that A started and the Run the agent continued stand side by side.
//   3. 이어받기 왕복 — the takeover POSTs the EXISTING lineage resume with the
//      chosen host, and the reader's own Run then joins the history.
//   4. 비멤버 404/403 분기 — a workstream outside the reader's channels answers
//      404 and the UI says "찾을 수 없습니다" without a word about permission,
//      while the resume path's 403 is the only place membership is named. A UI
//      that promoted the 404 to "권한이 없습니다" would hand back the existence
//      signal the server refused (WorkstreamRoutes, minimum exposure).
//
// Named red proofs, run from a throwaway worktree:
//   WORKSTREAM_GATE_PROVE_RED_RUNS=1 npm run gate:workstream
//     expected failure: "실행 이력 A·B 병기"
//   WORKSTREAM_GATE_PROVE_RED_RESUME=1 npm run gate:workstream
//     expected failure: "이어받기 왕복"
//   WORKSTREAM_GATE_PROVE_RED_DENIAL=1 npm run gate:workstream
//     expected failure: "비멤버 404/403 분기"
//
// Each seam changes fixture BEHAVIOR, never a product or assertion line, so a
// proof is repeatable and does not ask a reviewer to delete anything.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.WORKSTREAM_GATE_PORT || 5188);
const origin = `http://127.0.0.1:${port}`;
// Both schemes, because design-review reads both and this surface's one status
// colour (멈춤 = accent) has to survive the dark palette it was chosen in.
const outDir = process.env.WORKSTREAM_GATE_OUT_DIR
  ? resolve(process.env.WORKSTREAM_GATE_OUT_DIR)
  : resolve(webRoot, "artifacts/workstream");

const workspaceId = "00000000-0000-7000-8000-000000000001";
const viewerId = "00000000-0000-7000-8000-000000000101";
const aliceId = "00000000-0000-7000-8000-000000000102";
const agentId = "00000000-0000-7000-8000-000000000103";
const channelId = "00000000-0000-7000-8000-000000000201";
const rootMessageId = "00000000-0000-7000-8000-000000000301";
const otherRootMessageId = "00000000-0000-7000-8000-000000000302";

const activeWorkstreamId = "00000000-0000-7000-8000-000000000401";
const doneWorkstreamId = "00000000-0000-7000-8000-000000000402";
const foreignWorkstreamId = "00000000-0000-7000-8000-000000000403";

const aliceRunId = "00000000-0000-7000-8000-000000000501";
const agentRunId = "00000000-0000-7000-8000-000000000502";
const viewerRunId = "00000000-0000-7000-8000-000000000503";

const deadHostId = "00000000-0000-7000-8000-000000000601";
const liveHostId = "00000000-0000-7000-8000-000000000602";
const offlineHostId = "00000000-0000-7000-8000-000000000603";
const privateHostId = "00000000-0000-7000-8000-000000000604";

const proveRedRuns = process.env.WORKSTREAM_GATE_PROVE_RED_RUNS === "1";
const proveRedResume = process.env.WORKSTREAM_GATE_PROVE_RED_RESUME === "1";
const proveRedDenial = process.env.WORKSTREAM_GATE_PROVE_RED_DENIAL === "1";

const HOUR = 3_600_000;
const now = Date.now();

const session = {
  accessToken: "gate-only-not-a-credential",
  refreshToken: "gate-only-not-a-credential",
  member: {
    id: viewerId,
    workspaceId,
    kind: "human",
    displayName: "곽성재",
    handle: "seongjae",
  },
  realtimeWebSocketUrl: "ws://workstream-gate.invalid/connection/websocket",
};

const roster = [
  {
    id: viewerId,
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
    id: aliceId,
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
    ownerHumanId: viewerId,
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
    name: "release-train",
    muted: false,
  },
];

const hosts = [
  {
    id: deadHostId,
    workspaceId,
    scope: "workspace",
    ownerMemberId: aliceId,
    type: "workd",
    displayName: "빌드 러너 01",
    capabilities: { pty: true },
    createdAtMs: 0,
    online: false,
  },
  {
    id: liveHostId,
    workspaceId,
    scope: "workspace",
    ownerMemberId: viewerId,
    type: "app",
    displayName: "성재 맥북",
    capabilities: { pty: true },
    createdAtMs: 0,
    online: true,
  },
  {
    id: offlineHostId,
    workspaceId,
    scope: "workspace",
    ownerMemberId: viewerId,
    type: "workd",
    displayName: "꺼진 러너",
    capabilities: { pty: true },
    createdAtMs: 0,
    online: false,
  },
  {
    id: privateHostId,
    workspaceId,
    scope: "member",
    ownerMemberId: aliceId,
    type: "app",
    displayName: "서연 맥북",
    capabilities: { pty: true },
    createdAtMs: 0,
    online: true,
  },
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

/** Mutable ledger: the takeover has to be observable as a state change. */
function newState(mode) {
  return {
    mode,
    listStatusParams: [],
    resumeBody: null,
    resumeSessionId: null,
    runs: [
      {
        id: aliceRunId,
        memberId: aliceId,
        hostId: deadHostId,
        tool: "codex",
        label: "회귀 재현",
        status: "ended",
        startedAtMs: now - 5 * HOUR,
        endedAtMs: now - 4 * HOUR,
        exitCode: 0,
        endReason: "resumed",
      },
      {
        id: agentRunId,
        memberId: agentId,
        hostId: deadHostId,
        tool: "codex",
        label: "회귀 재현",
        status: "orphaned",
        startedAtMs: now - 4 * HOUR,
        resumedFromSessionId: aliceRunId,
      },
    ],
    workstreams: [
      {
        id: activeWorkstreamId,
        workspaceId,
        channelId,
        rootMessageId,
        goal: "릴리스 회귀 재현과 원인 좁히기",
        status: "active",
        createdByMemberId: aliceId,
        createdAtMs: now - 5 * HOUR,
        updatedAtMs: now - 4 * HOUR,
        runCount: 2,
        activeRunCount: 0,
      },
      {
        id: doneWorkstreamId,
        workspaceId,
        channelId,
        rootMessageId: otherRootMessageId,
        goal: "출시 노트 초안 작성",
        status: "done",
        createdByMemberId: viewerId,
        createdAtMs: now - 30 * HOUR,
        updatedAtMs: now - 29 * HOUR,
        runCount: 1,
        activeRunCount: 0,
      },
    ],
  };
}

function visibleRuns(state) {
  if (!proveRedRuns) return state.runs;
  // Red seam: the projection forgets every actor but the first, which is
  // exactly the "ownership transferred" ledger ADR-0143 replaced.
  const first = state.runs[0];
  return state.runs.filter((run) => run.memberId === first.memberId);
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
              return {
                id: command.id,
                connect: { client: "workstream-gate", version: "6" },
              };
            }
            if (command.subscribe) {
              return {
                id: command.id,
                subscribe: {
                  recoverable: true,
                  positioned: true,
                  recovered: false,
                  epoch: "workstream-gate",
                  offset: 0,
                },
              };
            }
            if (command.unsubscribe) return { id: command.id, unsubscribe: {} };
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

async function installRoutes(context, state) {
  await context.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const lower = path.toLowerCase();

    if (path === "/v1/auth/login") return json(route, session);
    if (path === "/v1/auth/realtime-token") {
      return json(route, {
        token: "gate-realtime-token",
        tokenType: "Bearer",
        expiresAtMs: Date.now() + 60_000,
        ttlSeconds: 60,
        workspaceId,
        memberId: viewerId,
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
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: hosts });
    if (path.includes("/messages")) return json(route, { messages: [] });

    // ---- the three workstream reads -----------------------------------------
    const runsMatch = lower.match(/\/workstreams\/([^/]+)\/runs$/);
    if (runsMatch) {
      const id = runsMatch[1];
      if (state.mode === "non-member" || id === foreignWorkstreamId) {
        return json(route, { error: { message: "workstream not found" } }, 404);
      }
      return json(route, {
        workstreamId: id,
        runs: id === activeWorkstreamId ? visibleRuns(state) : [],
      });
    }

    const detailMatch = lower.match(/\/workstreams\/([^/]+)$/);
    if (detailMatch && request.method() === "GET") {
      const id = detailMatch[1];
      const found = state.workstreams.find((row) => row.id === id);
      if (state.mode === "non-member" || !found) {
        // The asymmetry under test: outside the anchor channel this read
        // answers 404 so it cannot be used to confirm the row exists.
        return json(
          route,
          { error: { message: "workstream not found" } },
          proveRedDenial ? 403 : 404
        );
      }
      return json(route, { workstream: found });
    }

    if (lower.endsWith("/workstreams")) {
      const status = url.searchParams.get("status");
      state.listStatusParams.push(status);
      if (state.mode === "non-member") return json(route, { workstreams: [] });
      const rows =
        status === null
          ? state.workstreams
          : state.workstreams.filter((row) => row.status === status);
      return json(route, { workstreams: rows });
    }

    // ---- the takeover: the EXISTING lineage resume ---------------------------
    const resumeMatch = lower.match(/\/work-sessions\/([^/]+)\/resume$/);
    if (resumeMatch && request.method() === "POST") {
      state.resumeSessionId = resumeMatch[1];
      state.resumeBody = request.postDataJSON();
      if (state.mode === "revoked-membership") {
        return json(
          route,
          { error: { message: "active channel membership required" } },
          403
        );
      }
      const source = state.runs.find((run) => run.id === state.resumeSessionId);
      const resumed = {
        id: viewerRunId,
        workspaceId,
        channelId,
        memberId: viewerId,
        hostId: state.resumeBody.targetHostId,
        rootMessageId,
        tool: source?.tool ?? "codex",
        label: source?.label ?? "회귀 재현",
        status: "running",
        observation: "open",
        observerGrantCount: 0,
        remoteAttachAvailable: false,
        startedAtMs: Date.now(),
        resumedFromSessionId: state.resumeSessionId,
      };
      if (!proveRedResume) {
        // The server ends the source Run and records a NEW one under the same
        // workstream; the red seam skips exactly that ledger write.
        if (source) {
          source.status = "ended";
          source.endedAtMs = Date.now();
          source.endReason = "resumed";
        }
        state.runs.push({
          id: resumed.id,
          memberId: viewerId,
          hostId: resumed.hostId,
          tool: resumed.tool,
          label: resumed.label,
          status: "running",
          startedAtMs: resumed.startedAtMs,
          resumedFromSessionId: state.resumeSessionId,
        });
        const workstream = state.workstreams.find(
          (row) => row.id === activeWorkstreamId
        );
        if (workstream) {
          workstream.runCount += 1;
          workstream.activeRunCount = 1;
          workstream.updatedAtMs = Date.now();
        }
      }
      return json(route, { workSession: resumed });
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
    await wait(200);
  }
  throw new Error("workstream preview server never came up");
}

async function login(page) {
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  const submit = page.getByTestId("login-submit");
  const nav = page.getByTestId("nav-workstreams");
  await Promise.race([
    submit.waitFor({ timeout: 30_000 }).catch(() => {}),
    nav.waitFor({ timeout: 30_000 }).catch(() => {}),
  ]);
  if ((await submit.count()) > 0) {
    await page.getByTestId("login-email").fill("workstream@example.test");
    await page.getByTestId("login-password").fill("gate-only");
    await submit.click();
  }
  await nav.waitFor();
}

async function openList(page) {
  await page.getByTestId("nav-workstreams").click();
  await page.getByTestId("workstream-route").waitFor();
}

async function text(locator) {
  return (await locator.textContent())?.replace(/\s+/g, " ").trim() ?? "";
}

/**
 * Every wait carries the name of the claim it is waiting for. A bare
 * `waitFor` that expires prints "Timeout 10000ms exceeded" and a stack, which
 * tells a reviewer running a red proof nothing about which of the four claims
 * broke; the failure has to be readable as a sentence.
 */
async function claim(name, action) {
  try {
    await action();
  } catch (cause) {
    const detail =
      cause?.name === "TimeoutError"
        ? "waited for this and it never happened"
        : (cause?.message ?? String(cause));
    throw new Error(`${name}: ${detail}`);
  }
}

/** No surface in this shell may make the document scroll sideways (MOMO-610). */
async function assertNoHorizontalScroll(page, where) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  if (overflow.scrollWidth > overflow.innerWidth) {
    throw new Error(
      `narrow layout: ${where} scrolled the document sideways (${overflow.scrollWidth} > ${overflow.innerWidth})`
    );
  }
}

async function assertListAndHistory(browser) {
  const state = newState("member");
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await installRealtimeSocket(page);
  await installRoutes(context, state);
  await login(page);
  await openList(page);

  // ---- 1. 목록 렌더 ---------------------------------------------------------
  const rows = page.getByTestId("workstream-row");
  await claim("목록 렌더", () => rows.first().waitFor({ timeout: 15_000 }));
  if ((await rows.count()) !== 2) {
    throw new Error(`목록 렌더: expected 2 rows, got ${await rows.count()}`);
  }
  const first = page.locator(
    `li[data-testid="workstream-row"][data-workstream-id="${activeWorkstreamId}"]`
  );
  if ((await text(first.getByTestId("workstream-goal"))) !== "릴리스 회귀 재현과 원인 좁히기") {
    throw new Error("목록 렌더: the goal sentence is not the row's headline");
  }
  if ((await text(first.getByTestId("workstream-status"))) !== "진행 중") {
    throw new Error("목록 렌더: status chip lost the server's vocabulary");
  }
  if (
    (await text(first.getByTestId("workstream-run-count"))) !== "2" ||
    (await text(first.getByTestId("workstream-active-count"))) !== "0"
  ) {
    throw new Error("목록 렌더: run/active counts are not both stated");
  }
  if ((await text(first.getByTestId("workstream-channel"))) !== "#release-train") {
    throw new Error("목록 렌더: the row does not name its channel");
  }
  if ((await text(page.getByTestId("workstream-count"))) !== "2개") {
    throw new Error("목록 렌더: header count disagrees with the list");
  }

  // The filter is the SERVER's, so the request has to carry it.
  await page.getByTestId("workstream-filter-done").click();
  await claim("목록 렌더", () =>
    page.waitForFunction(
      () =>
        document.querySelectorAll('[data-testid="workstream-row"]').length === 1,
      undefined,
      { timeout: 10_000 }
    )
  );
  if (!state.listStatusParams.includes("done")) {
    throw new Error(
      `목록 렌더: 완료 filter never reached the server (${JSON.stringify(state.listStatusParams)})`
    );
  }
  if (!page.url().includes("status=done")) {
    throw new Error("목록 렌더: the filter did not survive in the url");
  }

  await page.getByTestId("workstream-filter-cancelled").click();
  const empty = page.getByTestId("workstream-empty");
  await claim("목록 렌더", () => empty.waitFor({ timeout: 10_000 }));
  if ((await empty.getAttribute("data-variant")) !== "filtered") {
    throw new Error("목록 렌더: a filtered zero was drawn as an empty workspace");
  }
  await page.getByTestId("workstream-empty-all").click();
  await claim("목록 렌더", () =>
    page.waitForFunction(
      () =>
        document.querySelectorAll('[data-testid="workstream-row"]').length === 2,
      undefined,
      { timeout: 10_000 }
    )
  );

  // ---- 2. 이력 A·B 병기 -----------------------------------------------------
  await first.locator("a").click();
  await claim("실행 이력 A·B 병기", async () => {
    await page.getByTestId("workstream-detail-route").waitFor({ timeout: 15_000 });
    await page.getByTestId("workstream-run-list").waitFor({ timeout: 15_000 });
  });
  const actors = await page
    .getByTestId("workstream-run-actor")
    .evaluateAll((nodes) => nodes.map((node) => node.textContent?.trim()));
  if (
    actors.length !== 2 ||
    !actors.includes("김서연") ||
    !actors.includes("김인턴")
  ) {
    throw new Error(
      `실행 이력 A·B 병기: expected both actors under one goal, got ${JSON.stringify(actors)}`
    );
  }
  const agentRow = page.locator(
    `li[data-testid="workstream-run-row"][data-run-id="${agentRunId}"]`
  );
  const agentToneOk = await agentRow
    .getByTestId("workstream-run-actor")
    .evaluate((node) => node.className.includes("text-agent"));
  if (!agentToneOk) {
    throw new Error(
      "실행 이력 A·B 병기: the agent Run lost its agent identity token"
    );
  }
  if ((await agentRow.getByTestId("workstream-run-lineage").count()) !== 1) {
    throw new Error(
      "실행 이력 A·B 병기: the continued Run does not say it continued one"
    );
  }
  if ((await text(page.getByTestId("workstream-detail-actors"))) !== "2") {
    throw new Error("실행 이력 A·B 병기: 참여자 count does not match the list");
  }
  const anchorHref = await page
    .getByTestId("workstream-detail-anchor")
    .getAttribute("href");
  if (!anchorHref?.includes(`/c/${channelId}`) || !anchorHref.includes("msg=")) {
    throw new Error(
      `앵커 대화: the detail does not link to the anchor thread (${anchorHref})`
    );
  }

  await assertNoHorizontalScroll(page, "detail at 1280");
  await page.setViewportSize({ width: 760, height: 480 });
  await assertNoHorizontalScroll(page, "detail at 760");
  await page.setViewportSize({ width: 1280, height: 800 });

  // ---- 3. 이어받기 왕복 -----------------------------------------------------
  const block = page.getByTestId("workstream-continue");
  if ((await block.getAttribute("data-state")) !== "ready") {
    throw new Error(
      `이어받기 왕복: takeover was not offered for an orphaned Run (${await block.getAttribute("data-state")})`
    );
  }
  await page.getByTestId("workstream-continue-toggle").click();
  const targets = page.getByTestId("workstream-continue-host");
  await claim("이어받기 왕복", () => targets.first().waitFor({ timeout: 10_000 }));
  const targetIds = await targets.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-host-id"))
  );
  if (targetIds.length !== 1 || targetIds[0] !== liveHostId) {
    throw new Error(
      `이어받기 왕복: host eligibility drifted from the server boundary (${JSON.stringify(targetIds)})`
    );
  }
  const resumeResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().toLowerCase().includes("/resume")
  );
  await targets.first().click();
  await claim("이어받기 왕복", () => resumeResponse);
  if (
    state.resumeSessionId !== agentRunId ||
    state.resumeBody?.targetHostId !== liveHostId
  ) {
    throw new Error(
      `이어받기 왕복: the takeover did not POST the orphaned Run and chosen host (${state.resumeSessionId}, ${JSON.stringify(state.resumeBody)})`
    );
  }
  await claim("이어받기 왕복", () =>
    page.getByTestId("workstream-continue-done").waitFor({ timeout: 10_000 })
  );
  await claim("이어받기 왕복", () =>
    page.waitForFunction(
      () =>
        document.querySelectorAll('[data-testid="workstream-run-row"]').length ===
        3,
      undefined,
      { timeout: 10_000 }
    )
  );
  const afterActors = await page
    .getByTestId("workstream-run-actor")
    .evaluateAll((nodes) => nodes.map((node) => node.textContent?.trim()));
  if (!afterActors.includes("곽성재")) {
    throw new Error(
      `이어받기 왕복: the reader's own Run never joined the history (${JSON.stringify(afterActors)})`
    );
  }
  if ((await text(page.getByTestId("workstream-detail-actors"))) !== "3") {
    throw new Error("이어받기 왕복: 참여자 count did not follow the new Run");
  }
  const afterState = await page
    .getByTestId("workstream-continue")
    .getAttribute("data-state");
  if (afterState !== "no-stopped-run") {
    throw new Error(
      `이어받기 왕복: a taken-over goal still advertises a takeover (${afterState})`
    );
  }
  const blockedCopy = await text(page.getByTestId("workstream-continue-blocked"));
  if (blockedCopy.includes("미커밋") || blockedCopy.includes("가져")) {
    throw new Error(
      "이어받기 왕복: the blocked copy promises the working tree (ADR-0143 D3)"
    );
  }

  await context.close();
}

async function assertDenialAsymmetry(browser) {
  // A member sees the surface; the resume path alone answers 403, and only
  // there may the UI talk about membership.
  const revoked = newState("revoked-membership");
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await installRealtimeSocket(page);
  await installRoutes(context, revoked);
  await login(page);
  await page.goto(`${origin}/#/workstreams/${activeWorkstreamId}`);
  await claim("비멤버 404/403 분기", () =>
    page.getByTestId("workstream-run-list").waitFor({ timeout: 15_000 })
  );
  await page.getByTestId("workstream-continue-toggle").click();
  await page.getByTestId("workstream-continue-host").first().click();
  const error = page.getByTestId("workstream-continue-error");
  await claim("비멤버 404/403 분기", () => error.waitFor({ timeout: 10_000 }));
  const errorCopy = await text(error);
  if (!errorCopy.includes("멤버")) {
    throw new Error(
      `비멤버 404/403 분기: a 403 did not name membership (${errorCopy})`
    );
  }
  if ((await page.getByTestId("workstream-continue-done").count()) !== 0) {
    throw new Error("비멤버 404/403 분기: a refused takeover claimed success");
  }
  await context.close();

  // A non-member gets zero rows and a 404, and neither may be dressed as a
  // permission refusal: that would confirm the row exists.
  const outsider = newState("non-member");
  const outsiderContext = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    reducedMotion: "reduce",
  });
  const outsiderPage = await outsiderContext.newPage();
  await installRealtimeSocket(outsiderPage);
  await installRoutes(outsiderContext, outsider);
  await login(outsiderPage);
  await openList(outsiderPage);
  const outsiderEmpty = outsiderPage.getByTestId("workstream-empty");
  await claim("비멤버 404/403 분기", () =>
    outsiderEmpty.waitFor({ timeout: 15_000 })
  );
  if ((await outsiderEmpty.getAttribute("data-variant")) !== "all") {
    throw new Error("비멤버 404/403 분기: a zero list was not drawn as empty");
  }
  const emptyCopy = await text(outsiderEmpty);
  if (emptyCopy.includes("권한") || emptyCopy.includes("403")) {
    throw new Error(
      `비멤버 404/403 분기: the empty list accused the reader (${emptyCopy})`
    );
  }

  await outsiderPage.goto(`${origin}/#/workstreams/${foreignWorkstreamId}`);
  const missing = outsiderPage.getByTestId("workstream-detail-missing");
  await missing.waitFor({ timeout: 15_000 }).catch(() => {});
  if ((await missing.count()) !== 1) {
    throw new Error(
      "비멤버 404/403 분기: a 404 workstream did not render the not-found state"
    );
  }
  const missingCopy = await text(missing);
  if (missingCopy.includes("권한") || !missingCopy.includes("찾을 수 없습니다")) {
    throw new Error(
      `비멤버 404/403 분기: the 404 was promoted to a permission claim (${missingCopy})`
    );
  }
  if ((await outsiderPage.getByTestId("workstream-run-list").count()) !== 0) {
    throw new Error(
      "비멤버 404/403 분기: a workstream that answered 404 still drew a history"
    );
  }
  await outsiderContext.close();
}

async function captureScreens(browser) {
  mkdirSync(outDir, { recursive: true });
  const shots = [];
  for (const scheme of ["light", "dark"]) {
    const state = newState("member");
    // A paused goal exists only in this capture: nothing writes a workstream
    // out of `active` yet (status transitions are ADR-0143 P2), so the accent
    // chip would otherwise never be reviewable in either scheme.
    state.workstreams.push({
      ...state.workstreams[0],
      id: "00000000-0000-7000-8000-000000000404",
      goal: "결제 실패 알림 파이프라인 정리",
      status: "paused",
      runCount: 4,
      activeRunCount: 0,
      updatedAtMs: now - 2 * HOUR,
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      reducedMotion: "reduce",
      colorScheme: scheme,
    });
    const page = await context.newPage();
    await installRealtimeSocket(page);
    await installRoutes(context, state);
    await login(page);
    await openList(page);
    await claim("캡처", () =>
      page.getByTestId("workstream-row").first().waitFor({ timeout: 15_000 })
    );
    const listShot = resolve(outDir, `list-${scheme}.png`);
    await page.screenshot({ path: listShot });
    shots.push(listShot);

    await page.goto(`${origin}/#/workstreams/${activeWorkstreamId}`);
    await claim("캡처", () =>
      page.getByTestId("workstream-run-list").waitFor({ timeout: 15_000 })
    );
    const detailShot = resolve(outDir, `detail-${scheme}.png`);
    await page.screenshot({ path: detailShot });
    shots.push(detailShot);
    await context.close();
  }
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
  let captured = [];
  try {
    await waitForServer();
    const browser = await chromium.launch();
    try {
      await assertListAndHistory(browser);
      await assertDenialAsymmetry(browser);
      captured = await captureScreens(browser);
    } finally {
      await browser.close();
    }
  } finally {
    server.kill("SIGTERM");
  }
  console.log(
    "GATE PASS workstream: list rows and server-side status filter, A·B run history with"
  );
  console.log(
    "           agent identity and lineage, takeover round trip through the existing resume,"
  );
  console.log(
    "           and the 404/403 asymmetry kept the way the server means it."
  );
  console.log(`screenshots: ${captured.join(", ")}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
