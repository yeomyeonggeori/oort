#!/usr/bin/env node
// GATE: MOMO-644 my-session continuity surface.
//
// No backend or credentials. The session projection resolves before the host
// projection on purpose: the UI must wait for host truth instead of briefly
// painting an offline host's running ledger row as active.
//
// Red proofs:
//   MY_SESSIONS_GATE_PROVE_RED_OFFLINE=1 npm run gate:my-sessions
//   MY_SESSIONS_GATE_PROVE_RED_FILTER=1 npm run gate:my-sessions

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.MY_SESSIONS_GATE_PORT || 5184);
const origin = `http://127.0.0.1:${port}`;
const workspaceId = "00000000-0000-7000-8000-000000000001";
const channelId = "00000000-0000-7000-8000-000000000201";
const memberId = "00000000-0000-7000-8000-000000000101";
const otherMemberId = "00000000-0000-7000-8000-000000000102";
const offlineSessionId = "00000000-0000-7000-8000-000000000644";
const onlineSessionId = "00000000-0000-7000-8000-000000000645";
const otherSessionId = "00000000-0000-7000-8000-000000000646";
const offlineHostId = "00000000-0000-7000-8000-000000000701";
const onlineHostId = "00000000-0000-7000-8000-000000000702";
const otherHostId = "00000000-0000-7000-8000-000000000703";
const offlineRootId = "00000000-0000-7000-8000-000000000801";
const onlineRootId = "00000000-0000-7000-8000-000000000802";
const otherRootId = "00000000-0000-7000-8000-000000000803";
const proveRedOffline = process.env.MY_SESSIONS_GATE_PROVE_RED_OFFLINE === "1";
const proveRedFilter = process.env.MY_SESSIONS_GATE_PROVE_RED_FILTER === "1";

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
  realtimeWebSocketUrl: "ws://my-sessions-gate.invalid/connection/websocket",
};

const channel = {
  id: channelId,
  workspaceId,
  kind: "public",
  name: "제품-웹",
  muted: false,
};

const roster = [
  {
    id: memberId,
    workspaceId,
    kind: "human",
    status: "active",
    role: "member",
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
    displayName: "Nadia Rahman",
    handle: "nadia",
    channelCount: 1,
    channelIds: [channelId],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  },
];

function workSession({
  id,
  owner,
  hostId,
  rootMessageId,
  label,
}) {
  return {
    id,
    workspaceId,
    channelId,
    memberId: owner,
    hostId,
    rootMessageId,
    tool: "codex",
    label,
    status: "running",
    observation: "open",
    observerGrantCount: 0,
    remoteAttachAvailable: true,
    startedAtMs: 1_785_163_200_000,
  };
}

const sessions = [
  workSession({
    id: offlineSessionId,
    owner: memberId,
    hostId: offlineHostId,
    rootMessageId: offlineRootId,
    label: "세션 연속성 표면 구현",
  }),
  workSession({
    id: onlineSessionId,
    owner: memberId,
    hostId: onlineHostId,
    rootMessageId: onlineRootId,
    label: "게이트 검증 정리",
  }),
  workSession({
    id: otherSessionId,
    owner: proveRedFilter ? memberId : otherMemberId,
    hostId: otherHostId,
    rootMessageId: otherRootId,
    label: "다른 멤버의 비공개 세션",
  }),
];

function host(id, displayName, online) {
  return {
    id,
    workspaceId,
    scope: "member",
    ownerMemberId: memberId,
    type: "app",
    displayName,
    capabilities: { terminal: true },
    createdAtMs: 1_785_163_000_000,
    online,
  };
}

const hosts = [
  host(offlineHostId, "성재 MacBook Pro", proveRedOffline),
  host(onlineHostId, "개발실 Mac mini", true),
  host(otherHostId, "Nadia MacBook Air", true),
];

function rootMessage(id, authorMemberId, body, seq) {
  return {
    id,
    channelId,
    seq,
    hlcTs: 1_785_163_200_000 + seq,
    hlcCount: 0,
    authorMemberId,
    type: "system",
    body,
    createdAtMs: 1_785_163_200_000 + seq,
  };
}

const rootMessages = [
  rootMessage(offlineRootId, memberId, "세션 연속성 표면 구현", 11),
  rootMessage(onlineRootId, memberId, "게이트 검증 정리", 12),
  rootMessage(otherRootId, otherMemberId, "다른 멤버의 비공개 세션", 13),
];

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
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
                connect: { client: "my-sessions-gate", version: "6" },
              };
            }
            if (command.subscribe) {
              return {
                id: command.id,
                subscribe: {
                  recoverable: true,
                  positioned: true,
                  recovered: false,
                  epoch: "my-sessions-gate",
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
  });
}

async function installRoutes(context, state) {
  await context.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/auth/login") return json(route, auth);
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
    if (path.endsWith("/channels")) return json(route, { channels: [channel] });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/read-state")) {
      return json(route, { read_states: [] });
    }
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-sessions")) {
      if (state.mode === "error") {
        return json(route, { error: { message: "fixture failure" } }, 500);
      }
      return json(route, {
        workSessions: state.mode === "sessions-empty" ? [] : sessions,
      });
    }
    if (path.endsWith("/work-hosts")) {
      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, state.hostDelayMs)
      );
      return json(route, {
        workHosts: state.mode === "hosts-empty" ? [] : hosts,
      });
    }
    if (path.includes("/messages/") && path.endsWith("/replies")) {
      return json(route, { messages: [] });
    }
    if (path.endsWith("/messages")) {
      return json(route, { messages: rootMessages });
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

async function loginAndOpenMine(context) {
  const page = await context.newPage();
  await installRealtimeSocket(page);
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  if ((await page.getByTestId("login-submit").count()) > 0) {
    await page.getByTestId("login-email").fill("gate@example.test");
    await page.getByTestId("login-password").fill("not-a-secret");
    await page.getByTestId("login-submit").click();
  }
  await page.getByTestId("open-work-panel").waitFor();
  await page.getByTestId("open-work-panel").click();
  await page.getByTestId("work-scope-mine").click();
  return page;
}

async function assertContinuity(context) {
  const page = await loginAndOpenMine(context);
  await page.getByTestId("work-panel-summary").waitFor();
  if ((await page.getByTestId("my-work-session-row").count()) !== 0) {
    throw new Error(
      "session rows rendered before the delayed host projection resolved"
    );
  }
  await page
    .locator(`[data-session-id="${offlineSessionId}"]`)
    .waitFor({ timeout: 10_000 });

  const rows = page.getByTestId("my-work-session-row");
  if ((await rows.count()) !== 2) {
    throw new Error(`mine filter rendered ${await rows.count()} rows, expected 2`);
  }
  if (
    (await page.locator(`[data-session-id="${otherSessionId}"]`).count()) !== 0
  ) {
    throw new Error("mine filter exposed another member's session");
  }

  const offline = page.locator(`[data-session-id="${offlineSessionId}"]`);
  if ((await offline.getAttribute("data-status")) !== "unavailable") {
    throw new Error(
      `offline running session rendered as ${await offline.getAttribute("data-status")}`
    );
  }
  if (
    (await offline.getByTestId("my-work-session-status").textContent())?.trim() !==
    "호스트 응답 없음"
  ) {
    throw new Error("offline running session lost the host-unavailable copy");
  }
  if (!(await offline.getByTestId("my-work-session-terminal").isDisabled())) {
    throw new Error("offline running session still offers an active terminal");
  }

  const online = page.locator(`[data-session-id="${onlineSessionId}"]`);
  await online.getByTestId("my-work-session-terminal").click();
  await page.getByTestId("work-detail").waitFor();
  await page.getByTestId("work-detail-back").click();
  await online.getByTestId("my-work-session-thread").click();
  await page.getByTestId("thread-panel").waitFor();
  await page.close();
}

async function assertTerminalState(context, state, testId) {
  state.mode = testId;
  state.hostDelayMs = 0;
  const page = await loginAndOpenMine(context);
  const expected =
    testId === "hosts-empty"
      ? "work-panel-hosts-empty"
      : testId === "sessions-empty"
        ? "work-panel-empty"
        : "work-panel-error";
  await page.getByTestId(expected).waitFor({ timeout: 10_000 });
  await page.close();
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
      const state = { mode: "continuity", hostDelayMs: 1_200 };
      await installRoutes(context, state);
      await assertContinuity(context);
      await assertTerminalState(context, state, "hosts-empty");
      await assertTerminalState(context, state, "sessions-empty");
      await assertTerminalState(context, state, "error");
    } finally {
      await browser.close();
    }
  } finally {
    server.kill("SIGTERM");
  }
  console.log(
    "PASS my sessions: delayed hosts, offline running, owner filter, direct attach, and terminal states"
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
