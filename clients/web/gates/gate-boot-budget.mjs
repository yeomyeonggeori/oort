#!/usr/bin/env node
// =============================================================================
// GATE — boot never waits on the network (DESK-1).
//
// The bug this measures: the packaged desktop app showed a loading state for
// ~30 seconds before the connect screen appeared. Two serial gates on the boot
// path had no deadline of their own —
//
//   1. `initSessionStore()` blocked the first paint (main.tsx);
//   2. `restoreSession()` then held the skeleton for one /v1/auth/refresh
//      rotation bounded only by REQUEST_TIMEOUT_MS = 15_000
//      (packages/momo-core/src/lib/http.ts).
//
// and cross-origin from `tauri://localhost` every request is preflighted, so a
// server that answered no preflight (405 — the CORS half of this ticket) made
// the webview burn the deadline on the OPTIONS and again on the POST:
// 15 000 x 2 = 30 000 ms, which is what was observed.
//
// This gate reproduces the WORST case — a server that accepts the TCP
// connection and then never answers, which is exactly the shape of the
// unresolvable `.local` address in MOMO-609 — and measures the one number that
// matters: how long until the person can type. The CORS fix removes the
// doubling; the budgets remove the wait; only the second is a property of this
// bundle, so only the second is asserted here.
//
// Run after `npm run build`:
//   npm run gate:boot
//
// Red proof (expected FAIL):
//   BOOT_GATE_PROVE_RED=1 npm run gate:boot
// That rebuilds with VITE_MOMO_BOOT_RESTORE_BUDGET_MS set past the request
// deadline, i.e. the pre-DESK-1 behaviour, and the same walk must exceed the
// ceiling. Without it, a gate that passes proves nothing about its own ability
// to fail.
//
// LIMIT: Chromium against Vite preview, not the macOS WKWebView. The boot path
// under test is bundle JavaScript and is identical in both; what differs (the
// keychain IPC in `initSessionStore`) has its own budget and is unit-tested in
// src/app/boot.test.ts.
// =============================================================================

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "./preview-guard.mjs";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.BOOT_GATE_PORT || 5187);
const blackHolePort = Number(process.env.BOOT_GATE_BLACKHOLE_PORT || 5188);
const origin = `http://127.0.0.1:${port}`;
const blackHole = `http://127.0.0.1:${blackHolePort}`;
const proveRed = process.env.BOOT_GATE_PROVE_RED === "1";

// The whole point of the ticket. 30 000 ms was the symptom; the budget is
// 2 500 ms; this ceiling leaves room for Chromium start-up and bundle parse on a
// loaded CI box without ever admitting a network wait.
const CEILING_MS = Number(process.env.BOOT_GATE_CEILING_MS || 8_000);

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "019f94e3-7a10-79cd-9dee-208f47edd9a8";

// A persisted session is what puts the boot on the "restoring" path at all — a
// first-time visitor never sees the skeleton. Not a credential: these bytes are
// never accepted by any server, and the black hole never answers anyway.
const persisted = {
  refreshToken: "gate-only-not-a-credential",
  realtimeWebSocketUrl: "ws://127.0.0.1:1/connection/websocket",
  member: {
    id: memberId,
    workspaceId,
    kind: "human",
    displayName: "곽성재",
    handle: "seongjae",
  },
};

function fail(message) {
  console.error(`GATE FAIL: ${message}`);
  process.exitCode = 1;
}

/** Accepts the connection, reads the request, and then answers NOTHING, ever. */
function startBlackHole() {
  const held = new Set();
  const server = createServer((request) => {
    // Hold the socket open. No status line, no headers, no body — the client's
    // own deadline is the only thing that can end this.
    held.add(request);
  });
  server.on("connection", (socket) => held.add(socket));
  return new Promise((resolveReady) => {
    server.listen(blackHolePort, "127.0.0.1", () =>
      resolveReady({
        close: () => {
          for (const item of held) item.destroy?.();
          server.close();
        },
      })
    );
  });
}

async function build() {
  const env = { ...process.env };
  if (proveRed) {
    // The pre-DESK-1 behaviour, expressed as configuration: a budget longer than
    // the request deadline is no budget at all.
    env.VITE_MOMO_BOOT_RESTORE_BUDGET_MS = "600000";
    env.VITE_MOMO_HYDRATE_BUDGET_MS = "600000";
  }
  await new Promise((done, reject) => {
    const proc = spawn("npm", ["run", "build"], {
      cwd: webRoot,
      env,
      stdio: "inherit",
    });
    proc.on("exit", (code) =>
      code === 0 ? done() : reject(new Error(`build exited ${code}`))
    );
  });
}

async function main() {
  await build();

  const hole = await startBlackHole();
  const preview = await startGuardedPreview({
    webRoot,
    port,
    portEnvVar: "BOOT_GATE_PORT",
  });

  let browser;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext();

    // Seed BEFORE any script runs: a stored session (so boot goes down the
    // restore path) aimed at a server that will never answer.
    await context.addInitScript(
      ([session, base]) => {
        localStorage.setItem("momo.web.session.v1", session);
        localStorage.setItem("momo.web.server.v1", base);
      },
      [JSON.stringify(persisted), blackHole]
    );

    const page = await context.newPage();
    const started = Date.now();
    await page.goto(origin, { waitUntil: "commit" });

    // Stored server skips S0, so the first usable connect surface is S1
    // (gateway). Email lives on S2 and is a click away, not part of boot.
    let elapsed = null;
    try {
      await page.waitForSelector('[data-testid="onboarding-gateway"]', {
        state: "visible",
        timeout: CEILING_MS,
      });
      elapsed = Date.now() - started;
    } catch {
      elapsed = null;
    }

    if (elapsed === null) {
      const message = `connect screen did not appear within ${CEILING_MS} ms against a server that never answers`;
      if (proveRed) {
        console.log(`GATE RED PROOF OK: ${message} (this is the expected FAIL)`);
        return;
      }
      fail(message);
      return;
    }

    console.log(
      `[boot-budget] connect screen usable in ${elapsed} ms (ceiling ${CEILING_MS} ms, budget 2500 ms)`
    );

    if (proveRed) {
      fail(
        `red proof did not go red: the connect screen still appeared in ${elapsed} ms with the budget disabled`
      );
      return;
    }

    // The skeleton must not have been the last thing standing.
    const skeleton = await page
      .locator('[data-testid="session-restoring"]')
      .count();
    if (skeleton > 0) {
      fail("the restoring skeleton is still on screen after the connect screen appeared");
      return;
    }

    console.log(
      `GATE PASS: boot reaches a usable connect screen in ${elapsed} ms with the server black-holed.`
    );
  } finally {
    await browser?.close();
    await preview.stop();
    hole.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
