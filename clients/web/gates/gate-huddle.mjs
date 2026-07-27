#!/usr/bin/env node
// GATE: huddle configuration, active projection and realtime end transition.
//
// No backend, credentials, microphone, or real audio. LiveKit media and the
// Tauri WKWebView permission prompt remain orchestrator-owned manual checks.
// This gate locks the browser states the ticket can prove with fixtures:
//   1. HTTP 503 "허들 미구성" is an operator state, not a generic failure;
//   2. active Live badge and participant display names come from REST;
//   3. huddle_ended removes the badge even when an older active GET resolves
//      afterwards (the intentionally inverted response timing).
//
// Red proofs:
//   HUDDLE_GATE_PROVE_RED_503=1 npm run gate:huddle
//   HUDDLE_GATE_PROVE_RED_ENDED=1 npm run gate:huddle

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.HUDDLE_GATE_PORT || 5183);
const origin = `http://127.0.0.1:${port}`;
const outDir = process.env.OUT_DIR
  ? resolve(process.env.OUT_DIR)
  : resolve(webRoot, "artifacts/huddle");
const workspaceId = "00000000-0000-7000-8000-000000000001";
const channelId = "00000000-0000-7000-8000-000000000201";
const memberId = "019f94e3-7a10-79cd-9dee-208f47edd9a8";
const huddleId = "00000000-0000-7000-8000-000000000643";
const teammateId = "019f9a01-0000-7000-8000-000000000400";

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
  realtimeWebSocketUrl: "ws://huddle-gate.invalid/connection/websocket",
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
    id: teammateId,
    workspaceId,
    kind: "human",
    status: "active",
    role: "admin",
    displayName: "Nadia Rahman",
    handle: "nadia",
    channelCount: 1,
    channelIds: [channelId],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  },
];
const activeHuddle = {
  id: huddleId,
  workspaceId,
  channelId,
  startedBy: teammateId,
  startedAtMs: 1_722_000_000_000,
  endedAtMs: null,
  participants: [
    {
      memberId: teammateId,
      displayName: "Nadia Rahman",
      joinedAtMs: 1_722_000_001_000,
    },
    {
      memberId,
      displayName: "곽성재",
      joinedAtMs: 1_722_000_002_000,
    },
  ],
};

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
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
              connect: { client: "huddle-gate-client", version: "6" },
            });
          } else if (command.subscribe) {
            this.subscriptions.add(command.subscribe.channel);
            replies.push({
              id: command.id,
              subscribe: {
                recoverable: true,
                positioned: true,
                recovered: false,
                epoch: "huddle-gate",
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
    window.__huddleGatePublish = (frame) => {
      offset += 1;
      for (const socket of sockets) {
        for (const channelName of socket.subscriptions) {
          socket.onmessage?.(
            new MessageEvent("message", {
              data: JSON.stringify({
                push: {
                  channel: channelName,
                  pub: { data: frame, offset },
                },
              }),
            })
          );
        }
      }
    };
  });
}

async function installRoutes(context, state) {
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
    if (path.endsWith("/channels")) return json(route, { channels: [channel] });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/read-state")) {
      return json(route, { read_states: [] });
    }
    if (path.includes("/messages")) return json(route, { messages: [] });
    if (path.endsWith("/huddles/active")) {
      if (state.mode === "unconfigured") {
        return json(route, { error: { message: "허들 미구성" } }, 503);
      }
      if (state.mode === "error") {
        return json(route, { error: { message: "fixture failure" } }, 500);
      }
      if (state.delayActiveMs) {
        await new Promise((resolveDelay) =>
          setTimeout(resolveDelay, state.delayActiveMs)
        );
      }
      return json(route, {
        huddle: state.mode === "active" ? activeHuddle : null,
      });
    }
    return json(route, {});
  });
}

async function waitForServer() {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    try {
      if ((await fetch(origin)).ok) return;
    } catch {
      // Preview is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
  throw new Error("preview server never came up");
}

async function openSignedIn(context) {
  const page = await context.newPage();
  await installRealtimeSocket(page);
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.getByTestId("login-email").fill("huddle@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.waitForSelector("nav[aria-label='워크스페이스 탐색']");
  return page;
}

async function main() {
  if (!existsSync(resolve(webRoot, "dist/index.html"))) {
    throw new Error("dist/ is missing. Run npm run build first.");
  }
  mkdirSync(outDir, { recursive: true });
  const server = spawn(
    resolve(webRoot, "node_modules/.bin/vite"),
    ["preview", "--port", String(port), "--strictPort", "--host", "127.0.0.1"],
    { cwd: webRoot, stdio: "ignore" }
  );
  try {
    await waitForServer();
    const browser = await chromium.launch();
    try {
      for (const mode of ["unconfigured", "idle", "error"]) {
        const context = await browser.newContext({
          viewport: { width: 1280, height: 800 },
          reducedMotion: "reduce",
          colorScheme: "dark",
        });
        const state = { mode, delayActiveMs: 0 };
        await installRoutes(context, state);
        const page = await openSignedIn(context);
        const target =
          mode === "unconfigured"
            ? "huddle-unconfigured"
            : mode === "idle"
              ? "huddle-start"
              : "huddle-error";
        await page.getByTestId(target).waitFor();
        if (
          mode === "unconfigured" &&
          process.env.HUDDLE_GATE_PROVE_RED_503 === "1"
        ) {
          await page.getByTestId("huddle-error").waitFor({ timeout: 500 });
        }
        await page.screenshot({
          path: resolve(outDir, `${mode}.png`),
          fullPage: true,
        });
        await context.close();
      }

      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        reducedMotion: "reduce",
        colorScheme: "light",
      });
      const state = { mode: "active", delayActiveMs: 0 };
      await installRoutes(context, state);
      const page = await openSignedIn(context);
      await page.getByTestId("huddle-live").waitFor();
      const names = await page.getByTestId("huddle-participants").textContent();
      if (!names?.includes("Nadia Rahman") || !names.includes("곽성재")) {
        throw new Error(`active participants missing: ${JSON.stringify(names)}`);
      }
      await page.screenshot({
        path: resolve(outDir, "active.png"),
        fullPage: true,
      });

      await page.evaluate(
        ({ id, ch, proveRed }) => {
          window.__huddleGatePublish?.({
            type: proveRed ? "huddle.participants.changed" : "huddle_ended",
            v: 1,
            ts: Date.now(),
            payload: {
              huddle_id: id,
              channel_id: ch,
              participant_member_ids: [],
            },
          });
        },
        {
          id: huddleId,
          ch: channelId,
          proveRed: process.env.HUDDLE_GATE_PROVE_RED_ENDED === "1",
        }
      );
      await page.getByTestId("huddle-live").waitFor({ state: "detached" });
      await page.getByTestId("huddle-start").waitFor();

      // Invert the fixture timing: an active read begins, huddle_ended wins,
      // then the old read finally resolves. The tombstone must keep Live gone.
      state.delayActiveMs = 700;
      await page.evaluate(({ id, ch }) => {
        window.__huddleGatePublish?.({
          type: "huddle_participants_changed",
          v: 1,
          ts: Date.now(),
          payload: {
            huddle_id: id,
            channel_id: ch,
            participant_member_ids: [],
          },
        });
      }, { id: huddleId, ch: channelId });
      await page.evaluate(({ id, ch }) => {
        window.__huddleGatePublish?.({
          type: "huddle_ended",
          v: 1,
          ts: Date.now(),
          payload: {
            huddle_id: id,
            channel_id: ch,
            participant_member_ids: [],
          },
        });
      }, { id: huddleId, ch: channelId });
      await page.waitForTimeout(900);
      if (await page.getByTestId("huddle-live").count()) {
        throw new Error("delayed active response resurrected the Live badge");
      }
      await context.close();
    } finally {
      await browser.close();
    }
  } finally {
    server.kill("SIGTERM");
  }
  console.log(
    "GATE PASS: 503 is configuration state, active participants render, and huddle_ended removes Live."
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
