#!/usr/bin/env node
// =============================================================================
// 개인 비서 연결 캡처와 실측 (#3773).
//
//   npm run build:design && MODE=after node scripts/capture-personal-assistants.mjs
//   MODE=before DIST_DIR=<이전 빌드> node scripts/capture-personal-assistants.mjs
//
// 1440 × 라이트·다크. 진짜 앱 셸을 Chromium으로 열고 `/v1/**`는 고정 응답이다
// (연결 상태는 장면 안에서 상태 기계처럼 바뀐다). 실제 그록봇·자격증명은 없다.
//
//   after   list-none · list-active · flow-1-prompt · flow-2-approval · flow-3-swap ·
//           onboarding-ai-connect
//   before  list-none(목록 없음) · flow-0-chooser · flow-1-picker · flow-2-identity ·
//           flow-3-pairing · flow-4-approval · flow-5-activation
//
// 재는 것: 가로 넘침 0, (after) 행당 버튼 최대 1, 진행 표시 개수, 화면 수와 클릭 수.
// =============================================================================

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/personal-assistants");
const PORT = Number(process.env.CAPTURE_PORT || 5203);
const MODE = process.env.MODE === "before" ? "before" : "after";
const VIEWPORT = { width: 1440, height: 900 };

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const GENERAL = "00000000-0000-7000-8000-000000000201";
const LAB = "00000000-0000-7000-8000-000000000202";
const AGENT = "00000000-0000-7000-8000-000000000301";
const CONN = "019f9a01-0000-7000-8000-0000000005c1";
const AUDIENCE = "/v1/mcp/agent-port";
const PAIRING = "momo_pair_v1.capture-only-not-a-credential";
const ACTIVE = "momo_active_v1.capture-only-not-a-credential";

const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: ME, workspaceId: WS, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: "ws://assistants-capture.invalid/connection/websocket",
};
const channels = [
  { id: GENERAL, workspaceId: WS, kind: "public", name: "general", muted: false },
  { id: LAB, workspaceId: WS, kind: "public", name: "agent-lab", muted: false },
];
const human = {
  id: ME, workspaceId: WS, kind: "human", status: "active", role: "owner", displayName: "곽성재",
  handle: "seongjae", channelCount: 2, channelIds: channels.map((c) => c.id), capabilities: [],
  createdAtMs: 0, updatedAtMs: 0,
};
const grok = {
  id: AGENT, workspaceId: WS, kind: "agent", status: "active", displayName: "그록봇", handle: "grokbot",
  channelCount: 0, channelIds: [], capabilities: [], createdAtMs: 0, updatedAtMs: 0, ownerHumanId: ME,
};

const failures = [];
const report = { mode: MODE, scenes: [], checks: [], counts: {} };
function check(name, ok, detail) {
  report.checks.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
  if (!ok) failures.push(name);
}

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

function conn(status, extra = {}) {
  return {
    id: CONN, agentMemberId: AGENT, status, authMode: "static_bearer", audience: AUDIENCE,
    approvedChannelIds: [], approvedScopes: [], createdAtMs: Date.now() - 60_000, updatedAtMs: Date.now() - 5_000,
    ...extra,
  };
}

/** 장면 하나의 서버 흉내. `state.connection`이 바뀌면 목록·단건이 함께 바뀐다. */
async function installRoutes(context, state) {
  await context.route("**/v1/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const method = req.method();
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId: WS, memberId: ME });
    }
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) return json(route, { members: state.agentInRoster ? [human, grok] : [human] });
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/liveness")) {
      if (!state.liveness) return json(route, { error: { code: "not_found", message: "not found" } }, 404);
      return json(route, { agentMemberId: AGENT, state: "responsive", lastSignalAtMs: Date.now() - 3 * 60_000 });
    }
    if (path.endsWith("/hosted-agent-connections") && method === "GET") {
      return json(route, { connections: state.connection ? [state.connection] : [] });
    }
    if (path.endsWith("/hosted-agent-connections") && method === "POST") {
      state.connection = conn("pairing_pending");
      state.agentInRoster = true;
      state.created = (state.created ?? 0) + 1;
      return json(route, { connection: state.connection, pairingCredential: PAIRING, pairingExpiresAtMs: Date.now() + 600_000 });
    }
    if (path.endsWith(`/hosted-agent-connections/${CONN}/confirm`) && method === "POST") {
      state.connection = conn("detected", { activeCredentialId: "cred-1", approvedChannelIds: [GENERAL], approvedScopes: ["agent:port:connect", "agent:inbox:read", "messages:read", "messages:write"] });
      return json(route, { connection: state.connection, credentialId: "cred-1", credential: ACTIVE, tokenType: "Bearer" });
    }
    if (path.endsWith(`/hosted-agent-connections/${CONN}`) && method === "GET") {
      if (!state.connection) return json(route, { error: { code: "not_found", message: "not found" } }, 404);
      return json(route, { connection: state.connection, cleanupArtifacts: [] });
    }
    if (path.endsWith(`/workspaces/${WS}`)) return json(route, { workspace: { id: WS, slug: "yeomyeong", name: "여명거리 제품팀", updatedAtMs: 1 } });
    if (path.includes("/messages")) return json(route, { messages: [] });
    return json(route, {});
  });
}

async function installRealtime(page) {
  await page.addInitScript(() => {
    class CaptureSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      constructor(url) {
        this.url = String(url);
        this.readyState = 0;
        queueMicrotask(() => { this.readyState = 1; this.onopen?.(new Event("open")); });
      }
      send(data) {
        const replies = String(data).trim().split("\n").map((line) => {
          const c = JSON.parse(line);
          if (c.connect) return { id: c.id, connect: { client: "assistants-capture", version: "6" } };
          if (c.subscribe) return { id: c.id, subscribe: { recoverable: true, positioned: true, recovered: false, epoch: "cap", offset: 0 } };
          return { id: c.id };
        });
        queueMicrotask(() => this.onmessage?.(new MessageEvent("message", { data: replies.map((r) => JSON.stringify(r)).join("\n") })));
      }
      close() { this.readyState = 3; this.onclose?.(new CloseEvent("close", { code: 1000 })); }
    }
    window.WebSocket = CaptureSocket;
  });
}

async function signIn(page, origin) {
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("nav-team").waitFor({ timeout: 20_000 });
}

async function open(browser, origin, scheme, state, hash) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: scheme, reducedMotion: "reduce", serviceWorkers: "block" });
  await installRoutes(context, state);
  const page = await context.newPage();
  if (process.env.CAPTURE_DEBUG) {
    page.on("console", (m) => console.log("console", m.type(), m.text().slice(0, 200)));
    page.on("pageerror", (e) => console.log("pageerror", String(e).slice(0, 300)));
  }
  await installRealtime(page);
  await page.addInitScript((server) => {
    try { localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ }
  }, origin);
  await signIn(page, origin);
  await page.evaluate((h) => { location.hash = h; }, hash);
  return { context, page };
}

const overflowX = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function shot(page, scheme, name) {
  await page.mouse.move(VIEWPORT.width + 80, VIEWPORT.height + 80);
  await page.waitForTimeout(400);
  check(`${name} ${scheme} 가로 넘침 0`, (await overflowX(page)) === 0);
  await page.screenshot({ path: resolve(OUT_DIR, `${name}-${scheme}.png`) });
  report.scenes.push(`${name}-${scheme}`);
}

// ---- after ----------------------------------------------------------------

async function afterScenes(browser, origin, scheme) {
  // 1) 목록: 연결 안 됨
  {
    const state = { connection: null, agentInRoster: false };
    const { context, page } = await open(browser, origin, scheme, state, "/ai/external");
    try {
      await page.getByTestId("personal-assistants").waitFor({ timeout: 15_000 });
      await page.locator("[data-testid='assistant-row']").nth(2).waitFor({ timeout: 10_000 });
      const rows = page.locator("[data-testid='assistant-row']");
      const counts = [];
      for (let i = 0; i < (await rows.count()); i += 1) counts.push(await rows.nth(i).locator("button").count());
      check(`list-none ${scheme} 행당 버튼 최대 1`, counts.every((n) => n <= 1), counts);
      check(`list-none ${scheme} 그록봇만 버튼`, counts[0] === 1 && counts[1] === 0 && counts[2] === 0, counts);
      await shot(page, scheme, "list-none");
    } finally {
      await context.close();
    }
  }
  // 2) 목록: 활성 + 생존 라벨
  {
    const state = { connection: conn("active", { activeCredentialId: "cred-1" }), agentInRoster: true, liveness: true };
    const { context, page } = await open(browser, origin, scheme, state, "/ai/external");
    try {
      await page.getByTestId("personal-assistants").waitFor({ timeout: 15_000 });
      await page.locator("[data-testid='agent-liveness']").waitFor({ timeout: 15_000 });
      await shot(page, scheme, "list-active");
    } finally {
      await context.close();
    }
  }
  // 3) 한 번에 흐름: 연결 → 프롬프트 → 승인 → 교체
  {
    const state = { connection: null, agentInRoster: false };
    const { context, page } = await open(browser, origin, scheme, state, "/ai/external");
    let clicks = 0;
    try {
      await page.locator("[data-testid='assistant-action']").first().waitFor({ timeout: 15_000 });
      await page.locator("[data-testid='assistant-action']").first().click(); clicks += 1;
      await page.getByTestId("hosted-prompt-copy").waitFor({ timeout: 15_000 });
      check(`flow ${scheme} 이름 입력 없이 프롬프트`, (await page.getByTestId("hosted-display-name").count()) === 0);
      check(`flow ${scheme} 진행 표시 3`, (await page.locator("[data-testid='hosted-step-chip']").count()) === 3);
      const preview = await page.getByTestId("hosted-prompt-preview").innerText();
      check(`flow ${scheme} 미리보기에 비밀 없음`, !preview.includes(PAIRING));
      await shot(page, scheme, "flow-1-prompt");
      await page.getByTestId("hosted-prompt-copy").click({ trial: true }).catch(() => {});
      await page.getByTestId("hosted-secret-done").click(); clicks += 2; // 복사 1(주 행동) + 붙여 넣었어요 1
      state.connection = conn("detected");
      await page.getByTestId("hosted-confirm").waitFor({ timeout: 20_000 });
      await page.locator("[data-testid='hosted-channels-row'] input[type='checkbox']").first().check(); clicks += 1;
      await shot(page, scheme, "flow-2-approval");
      await page.getByTestId("hosted-confirm").click(); clicks += 1;
      await page.getByTestId("hosted-swap-prompt-copy").waitFor({ timeout: 15_000 });
      await shot(page, scheme, "flow-3-swap");
      await page.getByTestId("hosted-swap-prompt-copy").click({ trial: true }).catch(() => {});
      clicks += 2; // 교체 복사 + 붙여 넣었어요
      report.counts[`flow-clicks-${scheme}`] = clicks;
    } finally {
      await context.close();
    }
  }
  // 4) 온보딩 AI 연결
  {
    const state = { connection: null, agentInRoster: false };
    const { context, page } = await open(browser, origin, scheme, state, "/?firstAgent=sub-ready");
    try {
      await page.getByTestId("ai-connect-list").waitFor({ timeout: 15_000 });
      await page.locator("[data-testid='ai-connect-soon-row']").first().waitFor({ timeout: 5_000 });
      check(`onboarding ${scheme} 곧 줄 2`, (await page.locator("[data-testid='ai-connect-soon-row']").count()) === 2);
      await shot(page, scheme, "onboarding-ai-connect");
    } finally {
      await context.close();
    }
  }
}

// ---- before ---------------------------------------------------------------

async function beforeScenes(browser, origin, scheme) {
  {
    const state = { connection: null, agentInRoster: false };
    const { context, page } = await open(browser, origin, scheme, state, "/ai/external");
    try {
      await page.getByTestId("ai-hub-pane-external").waitFor({ timeout: 15_000 });
      await shot(page, scheme, "list-none");
    } finally {
      await context.close();
    }
  }
  {
    const state = { connection: null, agentInRoster: false };
    const { context, page } = await open(browser, origin, scheme, state, "/ai/agents?create=1");
    let clicks = 0;
    try {
      await page.getByTestId("create-agent-chooser").waitFor({ timeout: 15_000 }); clicks += 1;
      await shot(page, scheme, "flow-0-chooser");
      await page.getByTestId("create-kind-external").click(); clicks += 1;
      await page.getByTestId("external-preset-picker").waitFor({ timeout: 10_000 });
      await shot(page, scheme, "flow-1-picker");
      await page.getByTestId("external-preset-grok").click(); clicks += 1;
      await page.getByTestId("hosted-create").waitFor({ timeout: 10_000 });
      await shot(page, scheme, "flow-2-identity");
      await page.getByTestId("hosted-create").click(); clicks += 1;
      await page.getByTestId("hosted-pairing-card").waitFor({ timeout: 15_000 });
      await shot(page, scheme, "flow-3-pairing");
      clicks += 4; // 주소·routine 이름·연결 값 복사, 저장했어요
      await page.getByTestId("hosted-secret-done").click();
      state.connection = conn("detected");
      await page.getByTestId("hosted-confirm").waitFor({ timeout: 20_000 });
      await page.locator("[data-testid='hosted-channels-row'] input[type='checkbox']").first().check(); clicks += 1;
      await shot(page, scheme, "flow-4-approval");
      await page.getByTestId("hosted-confirm").click(); clicks += 1;
      await page.getByTestId("hosted-active-card").waitFor({ timeout: 15_000 });
      await shot(page, scheme, "flow-5-activation");
      clicks += 4; // 자격증명 복사, 저장했어요, 교체 표시, 실행 표시
      report.counts[`flow-clicks-${scheme}`] = clicks;
    } finally {
      await context.close();
    }
  }
}

async function main() {
  const dist = process.env.DIST_DIR ? resolve(process.env.DIST_DIR) : resolve(WEB_ROOT, "dist");
  if (!existsSync(resolve(dist, "index.html"))) throw new Error(`dist/ is missing (${dist}). Run npm run build:design first.`);
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT", extraArgs: ["--outDir", dist] });
  const browser = await chromium.launch();
  try {
    for (const scheme of ["light", "dark"]) {
      if (MODE === "after") await afterScenes(browser, preview.origin, scheme);
      else await beforeScenes(browser, preview.origin, scheme);
    }
  } finally {
    await browser.close();
    await preview.stop();
    writeFileSync(resolve(OUT_DIR, `report-${MODE}.json`), JSON.stringify(report, null, 2));
  }
  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
}

await main();
