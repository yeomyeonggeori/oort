#!/usr/bin/env node
// =============================================================================
// 설정 › AI 연결 › 기본 AI 표 캡처 (#2881 AA-8, 시안 §5).
//
//   npm run build:design && node scripts/capture-ai-defaults.mjs
//
// design 전용 쿼리(제품 빌드는 무시): `aiProfiles=demo`(프로필 줄) ·
// `aiDefaults=demo`(개인 줄 선택: 터미널=Claude · 개인, 원격=Claude · 회사(로그인 필요)) ·
// `aiUnlink=confirm`(회사 줄 해제 창). 팀 연결은 운영자(200)·운영자 아님(403)·비어
// 있음(모의)으로 나눈다. 라이트·다크 × 1280·390 → captures/2881/*.png
//
// #3042: `ONLY=team-save,team-save-before-check,team-save-member,chain-origin
// OUT_DIR=captures/3042` — 팀 줄 서버 저장(default-ai + 연결 확인 modelIds)과 연결
// 순서 hop 의 주소 origin 변경(키 필수).
// =============================================================================

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR
  ? resolve(process.env.OUT_DIR)
  : resolve(WEB_ROOT, "captures/2881");
// Tauri 셸은 WKWebView다. 선택 칸 화살표처럼 엔진마다 다르게 그리는 것은
// `BROWSER=webkit`으로 같은 장면을 WebKit에서도 찍는다(#3010).
const ENGINE = process.env.BROWSER === "webkit" ? webkit : chromium;
const PORT = Number(process.env.CAPTURE_PORT || 5288);
const ORIGIN = `http://127.0.0.1:${PORT}`;

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";
const GENERAL_ID = "00000000-0000-7000-8000-000000000201";
const ME = "019f94e3-7a10-79cd-9dee-208f47edd9a8";
const SESSION = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: ME, workspaceId: WORKSPACE_ID, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: `ws://127.0.0.1:${PORT + 900}/connection/websocket`,
};
const CHANNELS = [
  { id: GENERAL_ID, workspaceId: WORKSPACE_ID, kind: "public", name: "general", muted: false },
];

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

const KEY_LINK = {
  schema: "momo.provider_link.v0",
  configured: true,
  source: "database",
  mode: "external-hermes",
  baseUrl: "https://openrouter.ai/api/v1",
  // 서버 `endpoint_label()`은 주소다(provider_link.rs). 실제 형식으로 찍는다.
  endpointLabel: "https://openrouter.ai/api/v1",
  bearerConfigured: true,
  bearerLast4: "a4f2",
  availability: "live",
  keyConfigured: true,
  format: "openai",
  updatedAtMs: 1_790_000_000_000,
  diagnostics: [],
};
// #3010: 공용 선택 칸이 화살표 자리를 비우는지 재는 긴 자체 호스트(#3007 리뷰 Medium).
const LONG_LINK = {
  ...KEY_LINK,
  baseUrl: "https://llm-gateway.platform.internal.example.co.kr:8443/v1",
  endpointLabel: "https://llm-gateway.platform.internal.example.co.kr:8443/v1",
};
const EMPTY_LINK = {
  schema: "momo.provider_link.v0",
  configured: false,
  source: "environment",
  mode: "local-mock",
  baseUrl: "http://127.0.0.1:8642/v1",
  endpointLabel: "http://127.0.0.1:8642/v1",
  bearerConfigured: false,
  availability: "mock",
  keyConfigured: false,
  diagnostics: [],
};

// #3042: 연결 확인이 돌려준 모델 id(서버가 정화한 값의 실제 모양).
const CHECKED = {
  schema: "momo.provider_link.test.v0",
  ok: true,
  source: "database",
  mode: "external-hermes",
  endpointLabel: "https://openrouter.ai/api/v1",
  checkedAtMs: 1_790_000_000_000,
  cascadeOk: true,
  entries: [
    {
      position: 0,
      source: "provider_link",
      mode: "external-hermes",
      endpointLabel: "https://openrouter.ai/api/v1",
      enabled: true,
      ok: true,
      disposition: "ok",
      probe: {
        outcome: "ok",
        method: "models",
        latencyMs: 180,
        probedAtMs: 1_790_000_000_000,
        cached: false,
        modelCount: 4,
        modelIds: ["anthropic/claude-sonnet-4", "openai/gpt-4o", "openai/gpt-4o-mini", "google/gemini-2.5-pro"],
      },
    },
  ],
};
const DEFAULT_AI = {
  schema: "momo.provider.default_ai.v0",
  teamAgent: {
    source: "team_link",
    linkPosition: 0,
    endpointLabel: "https://openrouter.ai/api/v1",
    linkResolved: true,
    modelId: "anthropic/claude-sonnet-4",
    updatedBy: null,
    updatedAtMs: 1_790_000_000_000,
  },
  summary: {
    source: "team_link",
    linkPosition: 2,
    endpointLabel: "https://backup.dawn.internal/v1",
    linkResolved: false,
    modelId: null,
    updatedBy: null,
    updatedAtMs: 1_790_000_000_000,
  },
  guardrail: { mode: "off", available: false },
};
const CHAIN = {
  schema: "momo.provider_link.chain.v0",
  entries: [
    { position: 0, source: "provider_link", mode: "external-hermes", baseUrl: "https://openrouter.ai/api/v1", endpointLabel: "https://openrouter.ai/api/v1", enabled: true, bearerConfigured: true, bearerLast4: "a4f2", updatedAtMs: 1 },
    { position: 1, source: "chain", mode: "external-hermes", baseUrl: "https://gateway.dawn.internal:8443/v1", endpointLabel: "gateway.dawn.internal:8443", enabled: true, bearerConfigured: true, bearerLast4: "c40a", updatedAtMs: 1 },
  ],
  fallbackCount: 1,
  attemptableCount: 2,
};

async function installMocks(context, team) {
  await context.route("**/v1/**", (route) =>
    json(route, { channels: [], members: [], read_states: [], messages: [] })
  );
  await context.route("**/v1/auth/login", (route) => json(route, SESSION));
  await context.route("**/v1/auth/realtime-token", (route) =>
    json(route, {
      token: "capture-realtime-token",
      tokenType: "Bearer",
      expiresAtMs: Date.now() + 60_000,
      ttlSeconds: 60,
      workspaceId: WORKSPACE_ID,
      memberId: ME,
    })
  );
  await context.route("**/v1/auth/refresh", (route) =>
    json(route, { accessToken: SESSION.accessToken, refreshToken: SESSION.refreshToken })
  );
  await context.route("**/v1/workspaces/*/channels", (route) => json(route, { channels: CHANNELS }));
  await context.route("**/v1/workspaces/*/roster", (route) => json(route, { members: [] }));
  await context.route("**/v1/provider/default-ai", (route) => {
    if (team === "member") return json(route, { error: { code: "forbidden", message: "operator required" } }, 403);
    // 저장 중 장면: PUT 은 답하지 않는다(「저장하고 있어요」가 선 상태를 찍는다).
    if (team === "pending-3042" && route.request().method() === "PUT") return undefined;
    if (team === "operator-3042" || team === "pending-3042") return json(route, DEFAULT_AI);
    return json(route, { ...DEFAULT_AI, teamAgent: null, summary: null });
  });
  await context.route("**/v1/provider/link**", (route) => {
    const url = route.request().url();
    if (url.includes("/chain")) {
      if (team === "chain-3042") return json(route, CHAIN);
      return json(route, { error: { code: "not_found", message: "no chain" } }, 404);
    }
    if (url.includes("/test") && (team === "operator-3042" || team === "pending-3042")) return json(route, CHECKED);
    if (team === "error") return json(route, { error: { code: "internal", message: "boom" } }, 500);
    if (team === "member") return json(route, { error: { code: "forbidden", message: "operator required" } }, 403);
    if (team === "long") return json(route, LONG_LINK);
    return json(route, team === "empty" ? EMPTY_LINK : KEY_LINK);
  });
}

async function installRealtimeSocket(context) {
  await context.addInitScript(() => {
    class GateWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      constructor(url) {
        this.url = url;
        this.readyState = 0;
        queueMicrotask(() => {
          this.readyState = 1;
          this.onopen?.(new Event("open"));
        });
      }
      send(data) {
        const replies = [];
        for (const line of String(data).trim().split("\n")) {
          const command = JSON.parse(line);
          if (command.connect) replies.push({ id: command.id, connect: { client: "slash-gate", version: "6" } });
          else if (command.subscribe)
            replies.push({
              id: command.id,
              subscribe: { recoverable: true, positioned: true, recovered: true, epoch: "slash-gate", offset: 0 },
            });
          else replies.push({ id: command.id });
        }
        queueMicrotask(() =>
          this.onmessage?.(new MessageEvent("message", { data: replies.map((r) => JSON.stringify(r)).join("\n") }))
        );
      }
      close() {
        this.readyState = 3;
        this.onclose?.(new CloseEvent("close", { code: 1000 }));
      }
    }
    window.WebSocket = GateWebSocket;
  });
}

async function waitForServer(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`preview server never came up: ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function signedIn(browser, { viewport, scheme }, team) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    colorScheme: scheme,
    reducedMotion: "reduce",
  });
  await installMocks(context, team);
  await installRealtimeSocket(context);
  const page = await context.newPage();
  await page.goto(ORIGIN, { waitUntil: "networkidle" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("seongjae@dawn.example");
  await page.getByTestId("login-password").fill("capture-only-not-a-credential");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-list").waitFor({ state: "visible" });
  return { context, page };
}

const BASE = "/settings?section=ai&aiEntry=rows&aiProbe=claude-ready&aiProfiles=demo";

/** 곁판에서 「연결 확인」을 누르고 결과가 선 뒤 곁판을 닫는다(#3042). */
async function checkConnection(page) {
  await page.getByTestId("ai-link-row-more").click();
  await page.getByTestId("ai-link-check").click();
  await page.getByTestId("ai-link-probe").waitFor({ state: "visible" });
  await page.getByTestId("ai-team-aside-close").click();
  await page.getByTestId("ai-default-teamAgent-select").waitFor({ state: "visible" });
  await page.getByTestId("ai-defaults").evaluate((el) => el.scrollIntoView({ block: "start" }));
}

/** 연결 순서를 열고 저장된 hop 의 주소를 다른 host 로 바꾼 뒤 칸을 떠난다(#3042). */
async function moveHopOrigin(page) {
  await page.getByTestId("ai-team-chain-toggle").click();
  const url = page.getByLabel("2차 provider 주소");
  await url.fill("https://llm.other-vendor.example/v1");
  await page.getByLabel("2차 provider 키").focus();
  await page.getByLabel("2차 provider 모드").focus();
  await page.getByTestId("chain-hop").first().evaluate((el) => el.scrollIntoView({ block: "center" }));
}

const SCENES = [
  { name: "team-save", team: "operator-3042", query: "&aiDefaults=demo", ready: "ai-defaults-team-foot", act: checkConnection, focus: "ai-default-teamAgent" },
  {
    name: "team-save-pending",
    team: "pending-3042",
    query: "&aiDefaults=demo",
    ready: "ai-defaults-team-foot",
    act: async (page) => {
      await checkConnection(page);
      await page.getByTestId("ai-default-teamAgent-select").selectOption("link:0:openai/gpt-4o");
      await page.getByTestId("ai-default-teamAgent-saved").waitFor({ state: "visible" });
    },
    focus: "ai-default-teamAgent",
  },
  { name: "team-save-before-check", team: "operator-3042", query: "&aiDefaults=demo", ready: "ai-defaults-team-foot", focus: "ai-default-teamAgent" },
  { name: "team-save-member", team: "member", query: "&aiDefaults=demo", ready: "ai-defaults-team-foot", focus: "ai-default-teamAgent" },
  { name: "chain-origin", team: "chain-3042", query: "", ready: "ai-team-chain-toggle", act: moveHopOrigin },
  { name: "defaults-operator", team: "operator", query: "&aiDefaults=demo", ready: "ai-defaults-team-foot" },
  { name: "defaults-member", team: "member", query: "&aiDefaults=demo", ready: "ai-defaults-team-foot" },
  { name: "defaults-empty", team: "empty", query: "", ready: "ai-defaults-team-foot" },
  { name: "defaults-error", team: "error", query: "&aiDefaults=demo", ready: "ai-defaults-table" },
  { name: "defaults-browser", team: "operator", query: "&aiEntry=desktop-only", base: "/settings?section=ai", ready: "ai-defaults-team-foot" },
  { name: "defaults-long-host", team: "long", query: "&aiDefaults=demo", ready: "ai-defaults-team-foot" },
  { name: "unlink-impact", team: "operator", query: "&aiDefaults=demo&aiUnlink=confirm", ready: "my-account-unlink-impact", dialog: true },
];

const FRAMES = [
  { viewport: { width: 1280, height: 800 }, scheme: "light" },
  { viewport: { width: 1280, height: 800 }, scheme: "dark" },
  { viewport: { width: 390, height: 844 }, scheme: "light" },
  { viewport: { width: 390, height: 844 }, scheme: "dark" },
];

async function shoot(browser, frame, scene) {
  const { context, page } = await signedIn(browser, frame, scene.team);
  await page.evaluate((hash) => {
    location.hash = hash;
  }, (scene.base ?? BASE) + scene.query);
  try { await page.getByTestId(scene.ready).first().waitFor({ state: "visible", timeout: 8000 }); } catch (e) { await page.screenshot({ path: `${OUT_DIR}/debug.png` }); throw e; }
  if (!scene.dialog) {
    await page.getByTestId("ai-defaults").evaluate((el) => el.scrollIntoView({ block: "start" }));
  }
  if (scene.act) await scene.act(page);
  // 좁은 폭에서는 팀 줄이 첫 화면 밖이다: 볼 줄을 위로 올린다(#3042).
  if (scene.focus && frame.viewport.width < 800) {
    await page.getByTestId(scene.focus).evaluate((el) => el.scrollIntoView({ block: "start" }));
  }
  await page.waitForTimeout(250);
  const engine = process.env.BROWSER === "webkit" ? "-webkit" : "";
  const path = `${OUT_DIR}/${scene.name}-${frame.viewport.width}-${frame.scheme}${engine}.png`;
  await page.screenshot({ path });
  await context.close();
  return path;
}

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) {
    throw new Error("dist/ is missing. Run `npm run build:design` first.");
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const server = spawn(
    resolve(WEB_ROOT, "node_modules/.bin/vite"),
    ["preview", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"],
    { cwd: WEB_ROOT, stdio: "ignore" }
  );
  const shutdown = () => server.kill("SIGTERM");
  process.on("exit", shutdown);
  try {
    await waitForServer(ORIGIN);
    const browser = await ENGINE.launch();
    try {
      const only = process.env.ONLY ? process.env.ONLY.split(",") : null;
      for (const scene of SCENES) {
        if (only && !only.includes(scene.name)) continue;
        for (const frame of FRAMES) console.log(await shoot(browser, frame, scene));
      }
    } finally {
      await browser.close();
    }
  } finally {
    shutdown();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
