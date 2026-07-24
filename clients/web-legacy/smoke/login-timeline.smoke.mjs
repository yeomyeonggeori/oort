#!/usr/bin/env node
// =============================================================================
// MOMO-391 + MOMO-400 + MOMO-401 web browser smoke (driven by
// scripts/verify_web_login_smoke.sh; do not run against a non-disposable
// stack — it writes messages, decides approvals and redeems invites).
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
// MOMO-400 additions (ADR-0119 W-4):
//   8. read-state: the sidebar unread badge initializes from the bulk GET;
//      an EXTERNAL cursor PUT (direct REST, not the browser) clears the badge
//      with zero further read-state GETs from the page — the update can only
//      have arrived over the `user:read-state#<member-id>` websocket push.
//      Opening a channel / receiving live messages drives browser-side cursor
//      PUTs whose bodies are asserted never-regressing (a re-PUT of the same
//      seq is legitimate; only a LOWER seq is a regression).
//   9. Composer idempotency: the first in-browser send is forwarded to the
//      server but answered with a synthetic 500 (deterministic lost-response
//      stand-in). The composer keeps the draft and the SAME clientMsgId; the
//      retry must reuse it, and both the timeline DOM and REST history must
//      show exactly ONE message (server-side ON CONFLICT dedup, L4 §3.1).
//  10. Approvals: the fixtures carry the REAL gateway's dangerous fields
//      (arguments tool JSON, tool_grant, estimated_micro_usd) in both
//      approval.payload and message props; the cards must render as ADR-0112
//      basic-mode cards on BOTH surfaces (timeline card + approvals panel
//      card) with zero leakage of those fields' unique markers; an
//      in-browser 승인 commits (receipt 200) and flips the card; a second
//      approval decided EXTERNALLY first answers the in-browser 거부 with a
//      409 RECEIPT that must transition the card to the authoritative status
//      (no error surface) — the decided-elsewhere flow is normal, not an
//      error.
//  11. DM: the sidebar DM section is fed by GET /dms; the picker opens a DM
//      with the seeded agent via POST /dms (idempotent) and the composer
//      round-trips a message in it.
//
// MOMO-401 additions (ADR-0119 W-5 / ADR-0121 D2-B):
//  12. Invite web join: a FRESH context opens /join?code=<code>. The app
//      renders the join form and, after a successful join, strips the code
//      from browser history (history.replaceState), then
//      submit establish the session from the JoinResponse token pair — the
//      spec'd join-login path (openapi.yaml JoinResponse REQUIRES
//      accessToken/refreshToken) — landing in the #general timeline with the
//      seeded messages visible. Logout, then the join-created credentials
//      must pass the normal login form (가입 → 로그인 → 타임라인).
//  13. Invite error UX: expired / exhausted / invalid codes each render
//      DISTINCT Korean copy (data-error-kind) derived from the server error
//      envelope — no raw English server strings.
//  14. Code hygiene: the raw invite code appears in NO request URL besides
//      the unavoidable document navigation, and in NO console line.
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
// MOMO-400 fixtures (installed by verify_web_login_smoke.sh):
const UNREAD_CHANNEL_NAME = env("WEB_SMOKE_UNREAD_CHANNEL_NAME", "agent-lab");
const APPROVAL_ID = env("WEB_SMOKE_APPROVAL_ID");
const APPROVAL2_ID = env("WEB_SMOKE_APPROVAL2_ID");
const DM_AGENT_HANDLE = env("WEB_SMOKE_DM_AGENT_HANDLE", "kim-intern");
// ADR-0112 leak probes: unique marker planted in the fixtures' arguments /
// tool_grant, plus the fixture estimated_micro_usd figures (comma-separated).
const LEAK_MARKER = env("WEB_SMOKE_LEAK_MARKER", "LEAKPROBE");
const LEAK_MICRO_USD = env("WEB_SMOKE_LEAK_MICRO_USD", "431337,917331")
  .split(",")
  .filter(Boolean);
// MOMO-401 invite fixtures (installed by verify_web_login_smoke.sh). The
// codes are bearer secrets: this smoke never prints them, and asserts the
// app leaks them neither into request URLs nor the console.
const JOIN_CODE = env("WEB_SMOKE_JOIN_CODE");
const JOIN_EXPIRED_CODE = env("WEB_SMOKE_JOIN_EXPIRED_CODE");
const JOIN_EXHAUSTED_CODE = env("WEB_SMOKE_JOIN_EXHAUSTED_CODE");
const JOIN_EMAIL = env("WEB_SMOKE_JOIN_EMAIL");
const JOIN_PASSWORD = env("WEB_SMOKE_JOIN_PASSWORD");
const JOIN_DISPLAY_NAME = env(
  "WEB_SMOKE_JOIN_DISPLAY_NAME",
  "Web Smoke Joiner"
);

const failures = [];
function pass(message) {
  console.log(`PASS: ${message}`);
}
function fail(message) {
  throw new Error(`FAIL: ${message}`);
}

// ADR-0112 basic-mode leak assertion (review fix M1): beyond the structural
// tells (JSON punctuation, field names, currency), assert the fixture's
// unique dangerous-field markers and cost figures never reach the DOM.
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const LEAK_RE = new RegExp(
  [
    "[{}[\\]]",
    "micro_usd",
    "arguments",
    "tool_grant",
    "\\bUSD\\b",
    "\\$",
    ...[LEAK_MARKER, ...LEAK_MICRO_USD].map(escapeRegExp),
  ].join("|")
);
function assertNoApprovalLeak(text, where) {
  const match = LEAK_RE.exec(text);
  if (match !== null) {
    failures.push(
      `${where} leaks tool JSON / tool_grant / cost details (ADR-0112 basic mode violation; matched ${JSON.stringify(match[0])})`
    );
    return false;
  }
  return true;
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
  let afterZeroOnSeededChannel = false;
  let readStateGetCount = 0;
  const readStatePuts = [];
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("/messages?") && url.includes("after=")) {
      afterBackfillSeen = true;
      // Regression guard (MOMO-391 review fix 2): a catch-up before the head
      // page establishes a baseline would fire `after=0` and page the whole
      // channel history oldest-first. Scoped to the SEEDED channel: #general
      // always has messages here, so after=0 on it can only be a lost
      // baseline. On a confirmed-EMPTY channel (the MOMO-400 parking channel,
      // or a fresh DM) seq 0 IS the head — after=0 there is the correct
      // recovery cursor, not a regression.
      if (
        new URL(url).searchParams.get("after") === "0" &&
        url.toLowerCase().includes(general.id.toLowerCase())
      ) {
        afterZeroOnSeededChannel = true;
      }
    }
    // MOMO-400 read-state observability: count bulk GETs (push-proof control)
    // and record every cursor PUT body (monotonicity assertion).
    if (
      request.method() === "GET" &&
      /\/v1\/workspaces\/[^/]+\/read-state(\?|$)/.test(url)
    ) {
      readStateGetCount += 1;
    }
    if (request.method() === "PUT" && url.includes("/read-state")) {
      let body = {};
      try {
        body = JSON.parse(request.postData() ?? "{}");
      } catch {
        // keep {} — the monotonicity check will flag it
      }
      readStatePuts.push({ url, body });
    }
  });
  // L4: the push proof below pins the GET counter only after every observed
  // bulk GET's RESPONSE has completed — an in-flight response landing after
  // the external PUT could otherwise clear the badge and fake the proof.
  let readStateGetResponseCount = 0;
  page.on("response", (response) => {
    if (
      response.request().method() === "GET" &&
      /\/v1\/workspaces\/[^/]+\/read-state(\?|$)/.test(response.url())
    ) {
      readStateGetResponseCount += 1;
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

  try {
    await page
      .locator('[data-testid="realtime-status"][data-status="connected"]')
      .waitFor({ timeout: 30000 });
  } catch (cause) {
    dumpDiagnostics();
    throw cause;
  }
  pass("realtime websocket connected under the strict CSP");

  // 8) read-state: park on the no-unread fixture channel so #general's badge
  //    stays observable (viewing a channel advances its cursor by design).
  //    Parking determinism relies on the server's lower(name) channel sort
  //    (agent-lab < general): the app auto-opens the FIRST listed channel, so
  //    the initial open already lands on the parked channel, never #general.
  await page
    .locator(
      `[data-testid="channel-item"][data-channel-name="${UNREAD_CHANNEL_NAME}"]`
    )
    .click();

  const generalBadge = page.locator(
    `[data-testid="unread-badge"][data-channel-name="${CHANNEL_NAME}"]`
  );
  await generalBadge.waitFor({ timeout: 20000 });
  const badgeCount = Number(await generalBadge.getAttribute("data-count"));
  if (!(badgeCount > 0)) {
    failures.push(`#${CHANNEL_NAME} unread badge rendered without a count`);
  } else {
    pass(
      `sidebar unread badge for #${CHANNEL_NAME} initialized from the bulk read-state GET (count ${badgeCount})`
    );
  }

  // The personal-channel subscription always starts recovered:false, which
  // re-baselines with one extra bulk GET. Wait for that GET's RESPONSE to
  // complete — with no read-state GET still in flight — before pinning the
  // push-proof counter (review fix L4: a request-only wait left a window
  // where the in-flight response, not the push, could clear the badge).
  {
    const deadline = Date.now() + 20000;
    while (
      (readStateGetResponseCount < 2 ||
        readStateGetCount !== readStateGetResponseCount) &&
      Date.now() < deadline
    ) {
      await page.waitForTimeout(100);
    }
    if (readStateGetResponseCount < 2) {
      failures.push(
        "read-state subscription re-baseline (recovered:false bulk GET) never completed"
      );
    } else if (readStateGetCount !== readStateGetResponseCount) {
      failures.push(
        "a read-state GET was still in flight when pinning the push-proof counter"
      );
    }
  }

  // External cursor PUT (direct REST, not the browser): the ONLY way the
  // badge can clear without another read-state GET is the
  // user:read-state#<member-id> websocket push.
  const generalHead = await api(
    `/v1/workspaces/${workspaceId}/channels/${general.id}/messages?limit=1`,
    { token }
  );
  const generalLatestSeq = generalHead.messages[0]?.seq ?? 0;
  if (generalLatestSeq === 0) fail("#general has no messages; cannot run the read-state push proof");
  const readStateGetsBeforePush = readStateGetCount;
  await api(
    `/v1/workspaces/${workspaceId}/channels/${general.id}/read-state`,
    { method: "PUT", token, body: { last_read_seq: generalLatestSeq } }
  );
  try {
    await generalBadge.waitFor({ state: "detached", timeout: 30000 });
  } catch (cause) {
    dumpDiagnostics();
    throw cause;
  }
  if (readStateGetCount !== readStateGetsBeforePush) {
    failures.push(
      "badge cleared but extra read-state GETs ran — push reception not proven"
    );
  } else {
    pass(
      "external cursor PUT cleared the badge through the user:read-state push (zero further read-state GETs)"
    );
  }

  await page
    .locator(`[data-testid="channel-item"][data-channel-name="${CHANNEL_NAME}"]`)
    .click();

  for (const body of seedBodies) {
    await page
      .locator('[data-testid="timeline-message"]', { hasText: body })
      .waitFor({ timeout: 20000 });
  }
  pass(`timeline displays the seeded messages in #${CHANNEL_NAME}`);

  // 3) Live path: REST send while subscribed -> rendered via wss.
  const liveBody = `web smoke realtime ${runId} ${crypto.randomUUID()}`;
  const liveMessage = await api(
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

  // Viewing the live arrival must advance the browser-side cursor to its seq.
  {
    const deadline = Date.now() + 20000;
    let advanced = false;
    while (Date.now() < deadline) {
      advanced = readStatePuts.some(
        (put) =>
          put.url.toLowerCase().includes(general.id.toLowerCase()) &&
          put.body.last_read_seq >= liveMessage.seq
      );
      if (advanced) break;
      await page.waitForTimeout(100);
    }
    if (!advanced) {
      failures.push(
        "no browser read-state PUT advanced the cursor to the live message seq"
      );
    } else {
      pass("live arrival drove a browser cursor PUT up to its seq");
    }
  }

  if (!afterBackfillSeen) {
    failures.push(
      "expected at least one REST `?after=` catch-up request after subscribe"
    );
  } else if (afterZeroOnSeededChannel) {
    failures.push(
      "catch-up ran without a seq baseline (`after=0` on the seeded channel) — Timeline must defer until the head page loads"
    );
  } else {
    pass(
      "REST ?after= catch-up ran on subscription establish (baseline > 0 on the seeded channel)"
    );
  }

  // 9) Composer idempotency: forward the first POST to the server, answer it
  //    with a synthetic 500 (deterministic lost-response), and require the
  //    retry to reuse the SAME clientMsgId with exactly one resulting message.
  const composerBody = `web smoke composer ${runId}`;
  const composerPosts = [];
  let composerInterceptArmed = true;
  await page.route(
    "**/v1/workspaces/*/channels/*/messages*",
    async (route) => {
      const request = route.request();
      if (request.method() !== "POST") return route.continue();
      let parsed = {};
      try {
        parsed = JSON.parse(request.postData() ?? "{}");
      } catch {
        // recorded as {}; the clientMsgId assertion will flag it
      }
      composerPosts.push(parsed);
      if (composerInterceptArmed) {
        composerInterceptArmed = false;
        // Forward first: the insert COMMITS server-side, then the response
        // is replaced — the same observable input as a response lost on the
        // network after commit.
        await route.fetch();
        return route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "internal", message: "smoke induced failure" },
          }),
        });
      }
      return route.continue();
    }
  );

  await page.getByTestId("composer-input").fill(composerBody);
  await page.getByTestId("composer-send").click();
  await page.getByTestId("composer-error").waitFor({ timeout: 20000 });
  pass("composer surfaced the failed send with retry copy (draft preserved)");

  await page.getByTestId("composer-retry").click();
  await page
    .locator('[data-testid="timeline-message"]', { hasText: composerBody })
    .waitFor({ timeout: 30000 });
  await page.unroute("**/v1/workspaces/*/channels/*/messages*");

  if (composerPosts.length !== 2) {
    failures.push(
      `composer idempotency: expected exactly 2 POSTs (send + retry), saw ${composerPosts.length}`
    );
  } else if (
    !composerPosts[0].clientMsgId ||
    composerPosts[0].clientMsgId !== composerPosts[1].clientMsgId
  ) {
    failures.push(
      "composer retry must reuse the SAME clientMsgId (idempotent re-send)"
    );
  } else {
    pass("composer retry reused the same clientMsgId");
  }

  // Let the (deduplicated) broadcast land, then require exactly one render
  // and exactly one committed row.
  await page.waitForTimeout(1500);
  const composerDomCount = await page
    .locator('[data-testid="timeline-message"]', { hasText: composerBody })
    .count();
  if (composerDomCount !== 1) {
    failures.push(
      `idempotent re-send rendered ${composerDomCount} timeline messages; expected exactly 1`
    );
  }
  const generalHistory = await api(
    `/v1/workspaces/${workspaceId}/channels/${general.id}/messages?limit=200`,
    { token }
  );
  const composerCopies = generalHistory.messages.filter(
    (message) => message.body === composerBody
  );
  if (composerCopies.length !== 1) {
    failures.push(
      `idempotent re-send committed ${composerCopies.length} rows; expected exactly 1`
    );
  } else if (composerDomCount === 1) {
    pass(
      "clientMsgId re-send produced exactly one message (DOM and REST history)"
    );
  }

  // 10) Approvals: fixtures render as ADR-0112 basic-mode cards.
  const pendingBadge = page.getByTestId("approvals-pending-count");
  await pendingBadge.waitFor({ timeout: 20000 });
  const pendingCount = Number(await pendingBadge.getAttribute("data-count"));
  if (pendingCount !== 2) {
    failures.push(
      `sidebar pending-approvals badge shows ${pendingCount}; expected the 2 fixtures`
    );
  } else {
    pass("sidebar shows the 2 pending approval fixtures");
  }

  await page.getByTestId("approvals-button").click();
  await page.getByTestId("approvals-panel").waitFor({ timeout: 20000 });
  const panelCardCount = await page
    .locator('[data-testid="approvals-panel"] [data-testid="approval-card"]')
    .count();
  if (panelCardCount !== 2) {
    failures.push(
      `approvals panel lists ${panelCardCount} pending cards; expected 2`
    );
  } else {
    pass("approvals panel lists both pending fixtures");
  }
  // M1: the PANEL card renders from approval.payload (which now carries the
  // real gateway's arguments/tool_grant/estimated_micro_usd) — assert the
  // basic-mode no-leak invariant on this surface too, before closing.
  const panelCard1 = page.locator(
    `[data-testid="approvals-panel"] [data-testid="approval-card"][data-approval-id="${APPROVAL_ID.toLowerCase()}"]`
  );
  await panelCard1.waitFor({ timeout: 20000 });
  if (
    assertNoApprovalLeak(await panelCard1.innerText(), "approvals panel card")
  ) {
    pass(
      "approvals panel card stays in ADR-0112 basic mode (no arguments/tool_grant/cost markers from the payload)"
    );
  }
  await page.getByTestId("approvals-close").click();
  await page.getByTestId("timeline").waitFor({ timeout: 20000 });

  const approvalCard1 = page.locator(
    `[data-testid="approval-card"][data-approval-id="${APPROVAL_ID.toLowerCase()}"]`
  );
  await approvalCard1.waitFor({ timeout: 20000 });
  // M1: the TIMELINE card renders from message props (which now carry the
  // real gateway's arguments/tool_grant/estimated_micro_usd).
  const cardText = await approvalCard1.innerText();
  if (assertNoApprovalLeak(cardText, "timeline approval card")) {
    pass(
      "timeline approval card stays in ADR-0112 basic mode (no arguments/tool_grant/cost markers from the props)"
    );
  }

  await approvalCard1.getByTestId("approval-approve").click();
  await approvalCard1
    .locator('[data-testid="approval-state"]')
    .waitFor({ timeout: 20000 });
  const card1State = await approvalCard1
    .locator('[data-testid="approval-state"]')
    .innerText();
  if (!card1State.includes("승인됨")) {
    failures.push(`approved card shows "${card1State}"; expected 승인됨`);
  }
  const approvedList = await api(
    `/v1/workspaces/${workspaceId}/approvals?status=approved`,
    { token }
  );
  if (
    !approvedList.approvals.some(
      (approval) => approval.id.toLowerCase() === APPROVAL_ID.toLowerCase()
    )
  ) {
    failures.push(
      "REST approvals?status=approved does not contain the browser-approved fixture"
    );
  } else if (card1State.includes("승인됨")) {
    pass(
      "in-browser 승인 committed: receipt 200 -> card 승인됨 -> REST projection approved"
    );
  }

  // 409 path: settle the second fixture EXTERNALLY first, then decide the
  // opposite way in the browser. The 409 receipt must transition the card to
  // the authoritative status — quiet note, no error surface.
  await api(
    `/v1/workspaces/${workspaceId}/approvals/${APPROVAL2_ID}/decision`,
    {
      method: "POST",
      token,
      body: {
        approval_id: APPROVAL2_ID,
        approve: true,
        client_decision_id: crypto.randomUUID(),
      },
    }
  );
  const approvalCard2 = page.locator(
    `[data-testid="approval-card"][data-approval-id="${APPROVAL2_ID.toLowerCase()}"]`
  );
  await approvalCard2.getByTestId("approval-reject").click();
  await approvalCard2
    .locator('[data-testid="approval-state"]')
    .waitFor({ timeout: 20000 });
  const card2State = await approvalCard2
    .locator('[data-testid="approval-state"]')
    .innerText();
  const card2Errors = await approvalCard2
    .locator('[data-testid="approval-error"]')
    .count();
  const card2Notes = await approvalCard2
    .locator('[data-testid="approval-note"]')
    .count();
  if (!card2State.includes("승인됨")) {
    failures.push(
      `409 receipt must flip the card to the authoritative status (승인됨), saw "${card2State}"`
    );
  } else if (card2Errors !== 0) {
    failures.push(
      "409 decided-elsewhere rendered an error — it must be a normal card state transition"
    );
  } else if (card2Notes !== 1) {
    failures.push("409 decided-elsewhere card is missing the quiet note");
  } else {
    pass(
      "409 receipt (decided on another device first) transitioned the card with a quiet note — no error"
    );
  }

  // 11) DM: picker -> POST /dms -> composer round-trip -> GET /dms lists it.
  await page.getByTestId("dm-new-button").click();
  await page
    .locator(
      `[data-testid="dm-candidate"][data-member-handle="${DM_AGENT_HANDLE}"]`
    )
    .click();
  await page
    .locator('[data-testid="channel-item"][data-channel-kind="dm"]')
    .first()
    .waitFor({ timeout: 20000 });
  const dmBody = `web smoke dm ${runId}`;
  await page.getByTestId("composer-input").fill(dmBody);
  await page.getByTestId("composer-send").click();
  await page
    .locator('[data-testid="timeline-message"]', { hasText: dmBody })
    .waitFor({ timeout: 30000 });
  const dmList = await api(`/v1/workspaces/${workspaceId}/dms`, { token });
  if (dmList.channels.length === 0) {
    failures.push("GET /dms lists no channels after opening a DM");
  } else {
    pass(
      "DM opened through the picker (POST /dms), composer message round-tripped, GET /dms lists it"
    );
  }

  // Read-state PUT monotonicity across the whole run: the client must never
  // request a cursor REGRESSION on any channel. Only a LOWER seq than the
  // highest already PUT is a regression (review fix L3): re-PUTting the same
  // seq is legitimate client behavior (e.g. re-confirming the cursor on
  // channel re-entry), so `<` — not `<=` — is the failure condition.
  if (readStatePuts.length === 0) {
    failures.push("expected at least one browser-side read-state PUT");
  } else {
    let regressed = false;
    const highest = new Map();
    for (const { url, body } of readStatePuts) {
      const match = url.match(/channels\/([^/]+)\/read-state/);
      const key = (match?.[1] ?? "?").toLowerCase();
      const previous = highest.get(key) ?? 0;
      if (
        typeof body.last_read_seq !== "number" ||
        body.last_read_seq < previous
      ) {
        failures.push(
          `read-state PUT regression on channel ${key}: ${body.last_read_seq} after ${previous}`
        );
        regressed = true;
      }
      highest.set(key, Math.max(previous, body.last_read_seq ?? 0));
    }
    if (!regressed) {
      pass(
        `browser cursor PUTs never regressed (${readStatePuts.length} PUTs, non-decreasing per channel)`
      );
    }
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

  // ---- Goal #593: invite web join (/join?code=..., ADR-0121 D2) ---------------

  // 12) Happy path in a FRESH context (no stored session): deep link ->
  //     join form -> session applied -> code stripped from browser history
  //     from the JoinResponse token pair -> timeline entry -> logout ->
  //     re-login with the join-created credentials.
  const joinContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const joinPage = await joinContext.newPage();
  const joinConsole = [];
  joinPage.on("console", (message) => joinConsole.push(message.text()));
  joinPage.on("pageerror", (error) => joinConsole.push(String(error)));
  const codeLeakUrls = [];
  joinPage.on("request", (request) => {
    const url = request.url();
    if (
      !url.includes(JOIN_CODE) &&
      !url.includes(encodeURIComponent(JOIN_CODE))
    ) {
      return;
    }
    // The document navigation itself is the invite link and is unavoidable.
    // Any other request URL carrying the code is a leak.
    if (
      request.isNavigationRequest() &&
      request.resourceType() === "document"
    ) {
      return;
    }
    codeLeakUrls.push(url);
  });

  await joinPage.goto(
    `https://${APP_HOST}/join?code=${encodeURIComponent(JOIN_CODE)}`,
    { waitUntil: "load" }
  );
  await joinPage.getByTestId("join-email").waitFor({ timeout: 15000 });
  pass("join form rendered from /join?code=...");

  await joinPage.getByTestId("join-email").fill(JOIN_EMAIL);
  await joinPage.getByTestId("join-display-name").fill(JOIN_DISPLAY_NAME);
  await joinPage.getByTestId("join-password").fill(JOIN_PASSWORD);
  await joinPage.getByTestId("join-submit").click();

  await joinPage.getByTestId("channel-list").waitFor({ timeout: 30000 });
  const strippedUrl = new URL(joinPage.url());
  if (
    joinPage.url().includes(JOIN_CODE) ||
    joinPage.url().includes(encodeURIComponent(JOIN_CODE)) ||
    strippedUrl.pathname !== "/"
  ) {
    failures.push("invite code survived in browser history after a successful join");
  } else {
    pass("successful join removed the invite code with history.replaceState");
  }
  await joinPage
    .locator(
      `[data-testid="channel-item"][data-channel-name="${CHANNEL_NAME}"]`
    )
    .click();
  await joinPage
    .locator('[data-testid="timeline-message"]', { hasText: seedBodies[0] })
    .waitFor({ timeout: 20000 });
  pass(
    "browser join ok: session established from the JoinResponse token pair (no separate /v1/auth/login) and #general timeline entered"
  );
  await joinPage.screenshot({
    path: join(OUT_DIR, "web-join-timeline.png"),
    fullPage: true,
  });

  // 가입 → 로그인 → 타임라인: the credentials created at join must pass the
  // normal login form (proves the join committed the password server-side).
  await joinPage.getByTestId("logout-button").click();
  await joinPage.getByTestId("login-email").waitFor({ timeout: 20000 });
  await joinPage.getByTestId("login-email").fill(JOIN_EMAIL);
  await joinPage.getByTestId("login-password").fill(JOIN_PASSWORD);
  await joinPage.getByTestId("login-submit").click();
  await joinPage.getByTestId("channel-list").waitFor({ timeout: 20000 });
  await joinPage.getByTestId("timeline").waitFor({ timeout: 20000 });
  pass("re-login with the join-created credentials reached the timeline");

  // 14) Code hygiene: no non-document request URL and no console line may
  //     carry the raw code.
  if (codeLeakUrls.length > 0) {
    failures.push(
      `invite code leaked into ${codeLeakUrls.length} non-document request URL(s)`
    );
  } else {
    pass(
      "invite code appeared in no request URL besides the document navigation"
    );
  }
  if (joinConsole.some((text) => text.includes(JOIN_CODE))) {
    failures.push("invite code appeared in browser console output");
  }
  const joinCspViolations = joinConsole.filter((text) =>
    /content security policy|refused to/i.test(text)
  );
  if (joinCspViolations.length > 0) {
    failures.push(
      `CSP violations on the join surface: ${joinCspViolations.join(" | ")}`
    );
  }
  await joinContext.close();

  // 13) Error UX: expired / exhausted / invalid render DISTINCT Korean copy
  //     keyed off the server error envelope (spec statuses 410/409/404 plus
  //     the stable envelope messages splitting 410 expired vs revoked).
  const errContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const errPage = await errContext.newPage();
  const expectJoinError = async (code, expectedKind, copyProbe) => {
    await errPage.goto(
      `https://${APP_HOST}/join?code=${encodeURIComponent(code)}`,
      { waitUntil: "load" }
    );
    await errPage.getByTestId("join-email").waitFor({ timeout: 15000 });
    await errPage
      .getByTestId("join-email")
      .fill(`web-smoke-err-${crypto.randomUUID().slice(0, 8)}@momo.local`);
    await errPage.getByTestId("join-display-name").fill("Web Smoke Probe");
    await errPage.getByTestId("join-password").fill(`err-${crypto.randomUUID()}`);
    await errPage.getByTestId("join-submit").click();
    const errorBox = errPage.getByTestId("join-error");
    await errorBox.waitFor({ timeout: 20000 });
    const kind = await errorBox.getAttribute("data-error-kind");
    const text = await errorBox.innerText();
    if (kind !== expectedKind) {
      failures.push(
        `join error for the ${expectedKind} case rendered kind "${kind}"`
      );
    } else if (!text.includes(copyProbe)) {
      failures.push(
        `join ${expectedKind} copy is missing "${copyProbe}" (got: ${text})`
      );
    } else {
      pass(`join error UX: ${expectedKind} rendered its distinct Korean copy`);
    }
  };
  await expectJoinError(JOIN_EXPIRED_CODE, "expired", "만료");
  await expectJoinError(JOIN_EXHAUSTED_CODE, "exhausted", "소진");
  await expectJoinError(
    `web-smoke-invalid-${crypto.randomUUID()}`,
    "invalid",
    "유효하지 않"
  );
  await errContext.close();
} finally {
  await browser.close();
  proxy.close();
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exit(1);
}
console.log(
  "MOMO-391/MOMO-400/MOMO-401 web login/timeline/compose/read-state/approvals/join browser smoke PASS"
);
