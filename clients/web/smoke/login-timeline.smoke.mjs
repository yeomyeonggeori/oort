#!/usr/bin/env node
// =============================================================================
// MOMO-391 login -> timeline browser smoke (driven by
// scripts/verify_web_login_smoke.sh; do not run against a non-disposable
// stack — it writes messages).
//
// What it proves, end to end, in a real Chromium against the REAL prod
// Caddyfile edge (strict CSP, same-origin /v1 proxy, wss realtime origin):
//   1. The built SPA loads under the strict CSP (no inline script/style, no
//      external origins) — any CSP violation fails the run.
//   2. Login through the browser form (workspace field left EMPTY exercises
//      the server's demo-workspace fallback).
//   3. Channel list renders; #general opens; seeded messages display.
//   4. The timeline runs a REST `?after=<seq>` catch-up when the realtime
//      subscription establishes (the recovered:false backfill path).
//   5. A message posted over REST while the page is subscribed arrives
//      through the full write path (REST -> PG -> outbox -> relay ->
//      Centrifugo -> wss) and is rendered live.
//   6. Catch-up never runs without a seq baseline: no `?after=0` request is
//      ever issued (the Timeline defers catch-up until the head page lands).
//   7. Logout with an EXPIRED access token still revokes server-side: the
//      first /v1/auth/logout is intercepted with a 401 (deterministic stand-in
//      for the 15-minute expiry), and the client must rotate once and retry
//      with the ROTATED pair — proven by both refresh tokens being dead via
//      direct REST afterwards.
//
// Networking: the e2e Caddy edge listens on an alternate loopback port, but
// CSP host sources match on DEFAULT ports (wss://rt.localhost == :443). So a
// tiny fail-closed HTTP CONNECT proxy maps <allowed-host>:443 to the edge
// port, and Chromium runs with proxy + bypass '<-loopback>' (which disables
// its implicit *.localhost proxy bypass). Anything but the allowed hosts on
// 443 is refused — the smoke can never reach the real network.
// =============================================================================

import http from "node:http";
import net from "node:net";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

function env(name, fallback) {
  const value = process.env[name];
  if (value !== undefined && value !== "") return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing required env: ${name}`);
}

const APP_HOST = env("WEB_SMOKE_APP_HOST", "app.localhost");
const RT_HOST = env("WEB_SMOKE_RT_HOST", "rt.localhost");
const API_HOST = env("WEB_SMOKE_API_HOST", "api.localhost");
const EDGE_HTTPS_PORT = Number(env("WEB_SMOKE_EDGE_HTTPS_PORT", "18994"));
const API_BASE = env("WEB_SMOKE_API_BASE", "http://127.0.0.1:18990");
const EMAIL = env("WEB_SMOKE_EMAIL");
const PASSWORD = env("WEB_SMOKE_PASSWORD");
const CHANNEL_NAME = env("WEB_SMOKE_CHANNEL_NAME", "general");
const OUT_DIR = env("WEB_SMOKE_OUT_DIR", "/tmp/momo-web-login-smoke");
const HEADLESS = env("WEB_SMOKE_HEADLESS", "1") !== "0";

const failures = [];
function pass(message) {
  console.log(`PASS: ${message}`);
}
function fail(message) {
  throw new Error(`FAIL: ${message}`);
}

// ---- REST helpers (direct to the api host port; browser-independent) --------

async function api(path, { method = "GET", token, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    fail(`REST ${method} ${path} -> HTTP ${response.status}: ${text}`);
  }
  return response.json();
}

// ---- fail-closed CONNECT proxy ------------------------------------------------

function startProxy(allowedHosts, targetPort) {
  const proxy = http.createServer((request, response) => {
    // Plain HTTP through the proxy is not part of the smoke surface.
    response.writeHead(403);
    response.end();
  });
  proxy.on("connect", (request, clientSocket, head) => {
    const [host, port] = String(request.url).split(":");
    if (!allowedHosts.has(host) || port !== "443") {
      clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      clientSocket.destroy();
      return;
    }
    const upstream = net.connect(targetPort, "127.0.0.1", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });
  return new Promise((resolve) => {
    proxy.listen(0, "127.0.0.1", () => {
      resolve({ proxy, port: proxy.address().port });
    });
  });
}

// ---- main ---------------------------------------------------------------------

const runId = `${Date.now()}-${process.pid}`;
mkdirSync(OUT_DIR, { recursive: true });

// 1) REST: login (NO workspace -> server demo fallback) + seed the timeline.
const login = await api("/v1/auth/login", {
  method: "POST",
  body: { email: EMAIL, password: PASSWORD },
});
if (!login.realtimeWebSocketUrl.startsWith(`wss://${RT_HOST}`)) {
  fail(
    `login realtimeWebSocketUrl must point at wss://${RT_HOST} for this smoke, got: ${login.realtimeWebSocketUrl}`
  );
}
pass(`REST login ok (member ${login.member.handle}, demo workspace fallback)`);
const token = login.accessToken;
const workspaceId = login.member.workspaceId;

const channels = await api(`/v1/workspaces/${workspaceId}/channels`, { token });
const general = channels.channels.find(
  (channel) => channel.name === CHANNEL_NAME
);
if (!general) fail(`channel #${CHANNEL_NAME} not found via REST`);

const seedBodies = [
  `web smoke seed one ${runId}`,
  `web smoke seed two ${runId}`,
];
for (const body of seedBodies) {
  await api(
    `/v1/workspaces/${workspaceId}/channels/${general.id}/messages`,
    {
      method: "POST",
      token,
      body: { clientMsgId: crypto.randomUUID(), body },
    }
  );
}
pass("REST seeded two timeline messages");

// 2) Browser phase.
const { proxy, port: proxyPort } = await startProxy(
  new Set([APP_HOST, RT_HOST, API_HOST]),
  EDGE_HTTPS_PORT
);

const browser = await chromium.launch({
  headless: HEADLESS,
  proxy: { server: `http://127.0.0.1:${proxyPort}`, bypass: "<-loopback>" },
});

try {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(String(error)));

  // Websocket lifecycle diagnostics (printed on failure): the realtime rail
  // is the piece with the most moving parts (proxy CONNECT, Caddy upgrade,
  // Centrifugo origin check, connection JWT).
  const wsEvents = [];
  page.on("websocket", (ws) => {
    wsEvents.push(`open ${ws.url()}`);
    ws.on("close", () => wsEvents.push(`close ${ws.url()}`));
    ws.on("socketerror", (error) => wsEvents.push(`error ${ws.url()}: ${error}`));
  });
  const dumpDiagnostics = () => {
    console.error("--- websocket events ---");
    for (const event of wsEvents) console.error(`  ${event}`);
    console.error("--- console errors ---");
    for (const text of consoleErrors) console.error(`  ${text}`);
  };

  let afterBackfillSeen = false;
  let afterZeroSeen = false;
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("/messages?") && url.includes("after=")) {
      afterBackfillSeen = true;
      // Regression guard (MOMO-391 review fix 2): a catch-up before the head
      // page establishes a baseline would fire `after=0` and page the whole
      // channel history oldest-first. #general is seeded before the browser
      // phase, so a legitimate after=0 cannot occur here.
      if (new URL(url).searchParams.get("after") === "0") {
        afterZeroSeen = true;
      }
    }
  });

  await page.goto(`https://${APP_HOST}/`, { waitUntil: "load" });
  await page.getByTestId("login-email").waitFor({ timeout: 15000 });
  pass("SPA served through the Caddy edge; login form rendered");

  // Workspace input intentionally left empty (demo workspace fallback).
  await page.getByTestId("login-email").fill(EMAIL);
  await page.getByTestId("login-password").fill(PASSWORD);
  await page.getByTestId("login-submit").click();

  await page.getByTestId("channel-list").waitFor({ timeout: 20000 });
  pass("browser login ok; channel list rendered");

  await page
    .locator(`[data-testid="channel-item"][data-channel-name="${CHANNEL_NAME}"]`)
    .click();

  for (const body of seedBodies) {
    await page
      .locator('[data-testid="timeline-message"]', { hasText: body })
      .waitFor({ timeout: 20000 });
  }
  pass(`timeline displays the seeded messages in #${CHANNEL_NAME}`);

  try {
    await page
      .locator('[data-testid="realtime-status"][data-status="connected"]')
      .waitFor({ timeout: 30000 });
  } catch (cause) {
    dumpDiagnostics();
    throw cause;
  }
  pass("realtime websocket connected under the strict CSP");

  // 3) Live path: REST send while subscribed -> rendered via wss.
  const liveBody = `web smoke realtime ${runId} ${crypto.randomUUID()}`;
  await api(
    `/v1/workspaces/${workspaceId}/channels/${general.id}/messages`,
    {
      method: "POST",
      token,
      body: { clientMsgId: crypto.randomUUID(), body: liveBody },
    }
  );
  try {
    await page
      .locator('[data-testid="timeline-message"]', { hasText: liveBody })
      .waitFor({ timeout: 60000 });
  } catch (cause) {
    dumpDiagnostics();
    throw cause;
  }
  pass("REST-sent message arrived live over the realtime rail");

  if (!afterBackfillSeen) {
    failures.push(
      "expected at least one REST `?after=` catch-up request after subscribe"
    );
  } else if (afterZeroSeen) {
    failures.push(
      "catch-up ran without a seq baseline (`after=0`) — Timeline must defer until the head page loads"
    );
  } else {
    pass("REST ?after= catch-up ran on subscription establish (baseline > 0)");
  }

  const cspViolations = consoleErrors.filter((text) =>
    /content security policy|refused to/i.test(text)
  );
  if (cspViolations.length > 0) {
    failures.push(`CSP violations in console: ${cspViolations.join(" | ")}`);
  } else {
    pass("no CSP violations in the browser console");
  }

  await page.screenshot({
    path: join(OUT_DIR, "web-login-timeline.png"),
    fullPage: true,
  });
  console.log(`screenshot: ${join(OUT_DIR, "web-login-timeline.png")}`);

  // 4) Expired-access logout must still revoke server-side (MOMO-391 review
  //    fix 1). The FIRST /v1/auth/logout is fulfilled with 401 locally — the
  //    same observable input the client gets from a 15-minute-old access
  //    token — so the client must rotate once and retry with the re-read
  //    ROTATED pair against the real server. Only that first response is
  //    mocked; the rotation and the retried logout hit the actual stack.
  const refreshResponses = [];
  const logoutStatuses = [];
  page.on("response", (response) => {
    const url = response.url();
    if (url.includes("/v1/auth/refresh")) refreshResponses.push(response);
    if (url.includes("/v1/auth/logout")) logoutStatuses.push(response.status());
  });
  let logoutInterceptUsed = false;
  await page.route("**/v1/auth/logout", async (route) => {
    if (logoutInterceptUsed) return route.continue();
    logoutInterceptUsed = true;
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "unauthorized", message: "expired access (smoke)" },
      }),
    });
  });

  const preLogoutRaw = await page.evaluate(() =>
    localStorage.getItem("momo.web.session.v1")
  );
  if (!preLogoutRaw) fail("session storage empty before logout");
  const preLogoutRefresh = JSON.parse(preLogoutRaw).refreshToken;

  await page.getByTestId("logout-button").click();
  await page.getByTestId("login-email").waitFor({ timeout: 20000 });
  pass("logout returned to the login form (local wipe)");

  const storedAfterLogout = await page.evaluate(() =>
    localStorage.getItem("momo.web.session.v1")
  );
  if (storedAfterLogout !== null) {
    failures.push("localStorage session survived logout");
  }

  const refreshProbe = (refreshToken) =>
    fetch(`${API_BASE}/v1/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });

  if (logoutStatuses.length !== 2 || logoutStatuses[0] !== 401) {
    failures.push(
      `expected logout 401 -> single retry, saw statuses: [${logoutStatuses.join(", ")}]`
    );
  } else if (logoutStatuses[1] < 200 || logoutStatuses[1] >= 300) {
    failures.push(
      `retried logout after rotation was not 2xx: ${logoutStatuses[1]}`
    );
  } else if (refreshResponses.length !== 1) {
    failures.push(
      `logout 401 must trigger exactly one refresh rotation, saw ${refreshResponses.length}`
    );
  } else {
    const rotated = await refreshResponses[0].json();
    // The ROTATED refresh token must be dead — the retry has to re-read the
    // fresh pair (replaying the stale body would leave this one alive) …
    const rotatedProbe = await refreshProbe(rotated.refreshToken);
    // … and the pre-rotation token was consumed by the rotation itself.
    const staleProbe = await refreshProbe(preLogoutRefresh);
    if (rotatedProbe.ok) {
      failures.push(
        "rotated refresh token still alive after logout — server-side revocation did not happen"
      );
    } else if (staleProbe.ok) {
      failures.push(
        "pre-rotation refresh token still alive after logout rotation"
      );
    } else {
      pass(
        "expired-access logout: 401 -> one rotation -> retried revoke with the rotated pair; both refresh tokens dead server-side"
      );
    }
  }
} finally {
  await browser.close();
  proxy.close();
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exit(1);
}
console.log("MOMO-391 web login/timeline browser smoke PASS");
