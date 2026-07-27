#!/usr/bin/env node
// =============================================================================
// GATE — Tauri shell CSP permits the actual bundled app, but nothing broader.
//
// `app.security.csp` is the source of truth. This gate reads it from
// clients/desktop/src-tauri/tauri.conf.json, gives Vite preview THAT exact
// policy as a Content-Security-Policy response header, and checks the built
// bundle through the login -> shell -> xterm observer path. xterm matters here:
// it writes a <style> element and inline truecolour cell styles at runtime, so
// the intentional style-src 'unsafe-inline' exception has an executable proof.
//
// Run after `npm run build`:
//   npm run gate:csp
//
// Red proof (expected FAIL):
//   CSP_GATE_PROVE_RED_STYLE=1 npm run gate:csp
// That removes only the configured style-src 'unsafe-inline' source. The same
// xterm path must report a style-src securitypolicyviolation, and this gate must
// fail. It is deliberately an environment-only test seam: the default always
// reads the unmodified Tauri configuration.
//
// LIMIT: this is Chromium against Vite preview, not the macOS WKWebView and not
// Tauri's protocol/IPC injection. The cargo-tauri smoke owned by the
// orchestrator remains the real-webview check.
// =============================================================================

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tauriConfigPath = resolve(webRoot, "../desktop/src-tauri/tauri.conf.json");
const port = Number(process.env.CSP_GATE_PORT || 5181);
const origin = `http://127.0.0.1:${port}`;

const workspaceId = "00000000-0000-7000-8000-000000000001";
const channelId = "00000000-0000-7000-8000-000000000201";
const memberId = "019f94e3-7a10-79cd-9dee-208f47edd9a8";
const hostId = "019f994c-4ed0-76a9-9d43-a9bde45b8fcd";
const workSessionId = "019f9a01-0000-7000-8000-000000000501";

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
  // The shell gets this address from the login response (ADR-0110), never from
  // the page origin. It has no listener in the gate, which is fine: the CSP
  // assertion is that opening it is permitted, not that a mock relay is live.
  realtimeWebSocketUrl: `ws://127.0.0.1:${port + 900}/connection/websocket`,
};

const workSession = {
  id: workSessionId,
  workspaceId,
  channelId,
  memberId,
  hostId,
  rootMessageId: "019f9a01-0000-7000-8000-000000000502",
  tool: "shell",
  label: "CSP gate terminal",
  status: "running",
  observation: "open",
  observerGrantCount: 0,
  remoteAttachAvailable: true,
  startedAtMs: Date.now() - 10_000,
};

const workHost = {
  id: hostId,
  workspaceId,
  scope: "member",
  ownerMemberId: memberId,
  type: "app",
  displayName: "CSP gate host",
  capabilities: { terminal: true },
  lastSeenAtMs: Date.now(),
  createdAtMs: Date.now() - 86_400_000,
  online: true,
};

function configuredCsp() {
  const config = JSON.parse(readFileSync(tauriConfigPath, "utf8"));
  const csp = config?.app?.security?.csp;
  if (typeof csp !== "string" || csp.trim() === "") {
    throw new Error(`${tauriConfigPath}: app.security.csp must be a non-empty string`);
  }
  return csp;
}

function cspForRun() {
  const csp = configuredCsp();
  if (process.env.CSP_GATE_PROVE_RED_STYLE !== "1") return csp;
  const narrowed = csp.replace(" 'unsafe-inline'", "");
  if (narrowed === csp) {
    throw new Error("red proof expected style-src 'unsafe-inline' in tauri.conf.json");
  }
  return narrowed;
}

function json(route, body) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installMocks(context) {
  await context.route("**/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/auth/login") return json(route, session);
    if (path === "/v1/auth/refresh") {
      return json(route, {
        accessToken: "gate-only-not-a-credential",
        refreshToken: "gate-only-not-a-credential",
      });
    }
    if (path === "/v1/auth/realtime-token") {
      return json(route, {
        token: "gate-only-not-a-credential",
        tokenType: "jwt",
        expiresAtMs: Date.now() + 60_000,
        ttlSeconds: 60,
        workspaceId,
        memberId,
      });
    }
    if (path.endsWith("/channels")) {
      return json(route, {
        channels: [{ id: channelId, workspaceId, kind: "public", name: "general", muted: false }],
      });
    }
    if (path.endsWith("/roster")) {
      return json(route, {
        members: [{
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
        }],
      });
    }
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/work-sessions")) return json(route, { workSessions: [workSession] });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: [workHost] });
    if (path.endsWith("/terminal-attach")) {
      return json(route, {
        // The direct host endpoint is deliberately separate from the API and
        // relay. No host is needed: xterm opens before this permitted socket can
        // settle, which is enough to exercise its runtime style writes.
        attach_endpoint: "https://127.0.0.1:28443/v1/observer-terminal",
        capability_token: `momo_terminal_attach_v1.${"a".repeat(43)}`,
        pty_id: "csp-gate-pty",
      });
    }
    if (path.includes("/replies") || path.includes("/messages")) {
      return json(route, { messages: [] });
    }
    return json(route, {
      channels: [], members: [], read_states: [], invites: [], approvals: [], runs: [],
    });
  });
}

async function waitForServer() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(origin);
      if (response.ok) return response;
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("preview server never came up");
}

async function main() {
  if (!existsSync(resolve(webRoot, "dist/index.html"))) {
    throw new Error("dist/ is missing. Run npm run build first.");
  }

  const csp = cspForRun();
  const server = spawn(
    resolve(webRoot, "node_modules/.bin/vite"),
    ["preview", "--port", String(port), "--strictPort", "--host", "127.0.0.1"],
    {
      cwd: webRoot,
      env: { ...process.env, MOMO_CSP_GATE_HEADER: csp },
      stdio: "ignore",
    }
  );

  try {
    const probe = await waitForServer();
    const header = probe.headers.get("content-security-policy");
    if (header !== csp) {
      throw new Error(
        `preview CSP drifted from tauri.conf.json: expected ${JSON.stringify(csp)}, got ${JSON.stringify(header)}`
      );
    }

    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        reducedMotion: "reduce",
      });
      await context.addInitScript(() => {
        window.__momoCspViolations = [];
        document.addEventListener("securitypolicyviolation", (event) => {
          window.__momoCspViolations.push({
            blockedURI: event.blockedURI,
            effectiveDirective: event.effectiveDirective || event.violatedDirective,
          });
        });
      });
      await installMocks(context);

      const page = await context.newPage();
      await page.goto(origin, { waitUntil: "networkidle" });
      await page.getByTestId("login-email").fill("csp@example.test");
      await page.getByTestId("login-password").fill("not-a-secret");
      await page.getByTestId("login-submit").click();
      await page.waitForSelector("nav[aria-label='워크스페이스 탐색']");

      // This is the smallest real shell route that loads the lazy xterm chunk:
      // panel -> row peek -> detail -> observer start. A fixture-only style tag
      // would prove the browser, not the application dependency that needs the
      // exception.
      await page.getByTestId("open-work-panel").click();
      await page.getByTestId("work-session-row").click();
      await page.getByTestId("work-session-open").click();
      await page.getByTestId("work-observer-start").click();
      await page.locator(".xterm").waitFor({ state: "attached", timeout: 15_000 });
      await page.waitForTimeout(300);

      const violations = await page.evaluate(() => window.__momoCspViolations ?? []);
      if (
        process.env.CSP_GATE_PROVE_RED_STYLE === "1" &&
        !violations.some((violation) => violation.effectiveDirective.startsWith("style-src"))
      ) {
        throw new Error(
          `red proof did not observe xterm's expected style-src violation: ${JSON.stringify(violations)}`
        );
      }
      if (violations.length > 0) {
        throw new Error(`CSP blocked the bundled shell: ${JSON.stringify(violations)}`);
      }
      await context.close();
    } finally {
      await browser.close();
    }
  } finally {
    server.kill("SIGTERM");
  }

  console.log("GATE PASS: tauri.conf.json CSP reached preview unchanged and allowed login, shell, and xterm.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
