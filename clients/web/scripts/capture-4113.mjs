#!/usr/bin/env node
// =============================================================================
// CAPTURE (#4113): 설정 › AI의 「같은 서버의 Hermes」 카드와 처음 한 번만 뜨는 「연결할까요?」 창.
//
//   npm run build && OUT_DIR=<dir> [APP_ROOT=<빌드가 있는 web 폴더>] [PHASE=before|after] node scripts/capture-4113.mjs
//
// 백엔드가 없다. `/v1/**`는 이 파일의 고정 응답이다(서버 계약: #3873 provider-pin, #3883 cohosted-agent).
// **라이브 서버 동작은 runtime-unverified**다. 1440/390 × 라이트/다크.
// =============================================================================
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.CAPTURE_PORT || 5375);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const APP_ROOT = process.env.APP_ROOT ? resolve(process.env.APP_ROOT) : WEB_ROOT;
const PHASE = process.env.PHASE || "after";
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/4113");

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000201";
const ME = "00000000-0000-7000-8000-000000000101";
const INTERN = "00000000-0000-7000-8000-000000000301";
const HERMES = "00000000-0000-7000-8000-000000000302";
const SESSION = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: ME, workspaceId: WS, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: "ws://pin-capture.invalid/connection/websocket",
};
const base = { workspaceId: WS, status: "active", channelCount: 1, channelIds: [CH], capabilities: [], createdAtMs: 0, updatedAtMs: 0 };
const ROSTER = [
  { ...base, id: ME, kind: "human", role: "owner", displayName: "곽성재", handle: "seongjae" },
  { ...base, id: INTERN, kind: "agent", role: "member", displayName: "김인턴", handle: "intern", ownerHumanId: ME, paused: false, brain: "team_key", callableBy: "everyone", agentModel: "claude-sonnet-4", tagline: "리서치와 요약을 맡아요" },
  { ...base, id: HERMES, kind: "agent", role: "member", displayName: "Hermes", handle: "hermes", ownerHumanId: ME, paused: false, brain: "team_key", callableBy: "everyone", agentModel: "hermes-agent" },
];
const KEY_LINK = {
  schema: "momo.provider_link.v0", configured: true, source: "database", mode: "external-hermes",
  baseUrl: "https://openrouter.ai/api/v1", endpointLabel: "https://openrouter.ai/api/v1",
  bearerConfigured: true, bearerLast4: "a4f2", availability: "live", keyConfigured: true, format: "openai",
  updatedAtMs: 1_790_000_000_000, diagnostics: [],
};
const CHAIN = {
  schema: "momo.provider_link.chain.v0",
  entries: [
    { position: 0, source: "provider_link", mode: "external-hermes", baseUrl: KEY_LINK.baseUrl, endpointLabel: KEY_LINK.endpointLabel, enabled: true, bearerConfigured: true, bearerLast4: "a4f2", updatedAtMs: 1 },
    { position: 1, source: "chain", mode: "external-hermes", baseUrl: "https://gateway.dawn.internal:8443/v1", endpointLabel: "gateway.dawn.internal:8443", enabled: true, bearerConfigured: true, bearerLast4: "c40a", updatedAtMs: 1 },
  ],
  fallbackCount: 1, attemptableCount: 2,
};
const DEFAULT_AI = { schema: "momo.provider.default_ai.v0", teamAgent: null, summary: null, guardrail: { mode: "off", available: false } };
const COHOST_LABEL = "http://hermes.railway.internal:8642/v1";

const failures = [];
function check(name, ok, detail) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
  if (!ok) failures.push(name);
}
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function installMocks(context, mode) {
  const state = { connected: false };
  await context.route("**/v1/**", (route) => json(route, { channels: [], members: [], read_states: [], messages: [] }));
  await context.route("**/v1/auth/login", (route) => json(route, SESSION));
  await context.route("**/v1/auth/refresh", (route) => json(route, { accessToken: SESSION.accessToken, refreshToken: SESSION.refreshToken }));
  await context.route("**/v1/auth/realtime-token", (route) => json(route, { token: "x", tokenType: "jwt", expiresAtMs: Date.now() + 60_000, ttlSeconds: 60, workspaceId: WS, memberId: ME }));
  await context.route("**/v1/workspaces/*/channels", (route) => json(route, { channels: [{ id: CH, workspaceId: WS, kind: "public", name: "general", muted: false }] }));
  await context.route("**/v1/workspaces/*/roster", (route) => json(route, { members: ROSTER }));
  await context.route("**/v1/workspaces/*/read-state", (route) => json(route, { read_states: [] }));
  await context.route("**/v1/workspaces/*/channels/*/huddles/active", (route) => json(route, { huddle: null, participants: [] }));
  await context.route("**/v1/workspaces/*/agents/*/profile", (route) => json(route, { error: { message: "not found" } }, 404));
  await context.route("**/v1/provider/link", (route) => json(route, KEY_LINK));
  await context.route("**/v1/provider/link/chain", (route) => json(route, CHAIN));
  await context.route("**/v1/provider/default-ai", (route) => json(route, DEFAULT_AI));
  await context.route("**/v1/workspaces/*/agents/*/model-login", (route) => json(route, { error: { code: "login_relay_off", message: "off" } }, 409));
  await context.route("**/v1/workspaces/*/cohosted-agent", (route) =>
    json(route, { schema: "momo.cohosted_agent.status.v0", declaration: "ready", endpointLabel: COHOST_LABEL, toolsLockAttested: true, connectable: !state.connected, ...(state.connected ? { connectedAgentId: HERMES } : {}) }));
  await context.route("**/v1/workspaces/*/cohosted-agent/probe", (route) =>
    json(route, { schema: "momo.cohosted_agent.probe.v0", state: "ok", requestsSent: 3, modelCount: 1, toolsLockAttested: true, connectable: true,
      toolsets: mode.danger ? { signal: "dangerous_listed", listed: ["terminal", "browser"], proof: false } : { signal: "none_listed", proof: false } }));
  await context.route("**/v1/workspaces/*/cohosted-agent/connect", (route) => {
    state.connected = true;
    return json(route, { schema: "momo.cohosted_agent.connect.v0", agentId: HERMES, displayName: "Hermes", handle: "hermes" });
  });
}
async function installRealtime(context) {
  await context.addInitScript(() => {
    class CaptureSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      constructor(url) { this.url = String(url); this.readyState = 0; queueMicrotask(() => { this.readyState = 1; this.onopen?.(new Event("open")); }); }
      send(data) {
        const replies = String(data).trim().split("\n").map((line) => {
          const c = JSON.parse(line);
          if (c.connect) return { id: c.id, connect: { client: "pin-capture", version: "6" } };
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

async function waitForServer(url) {
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("preview server never came up");
}

async function open(browser, scheme, viewport, mode) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: scheme, reducedMotion: "reduce", serviceWorkers: "block" });
  await installMocks(context, mode);
  await installRealtime(context);
  const page = await context.newPage();
  await page.goto(ORIGIN, { waitUntil: "networkidle" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("seongjae@dawn.example");
  await page.getByTestId("login-password").fill("capture-only-not-a-credential");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-list").waitFor({ state: "visible" });
  return { context, page };
}

const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const shots = [];
async function save(page, name) {
  await page.screenshot({ path: resolve(OUT_DIR, `${name}.png`) });
  shots.push(`${name}.png`);
}
const goSettings = (page) => page.evaluate(() => { location.hash = "/settings?section=ai"; });
// :focus-visible 은 키보드로 닿을 때만 선다. 프로그램 focus() 만으로는 서지 않으므로 Tab 으로 모달리티를 먼저 키보드로 바꾼다.
const focusRingVisible = async (page, testId, inner) => {
  await page.keyboard.press("Tab");
  const target = inner ? page.getByTestId(testId).locator(inner) : page.getByTestId(testId);
  return target.evaluate((el) => {
    el.focus();
    const s = getComputedStyle(el);
    return s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0;
  });
};



async function scenes(browser, scheme, viewport) {
  const tag = `${viewport.width}-${scheme}`;
  const go = async (mode) => {
    const { context, page } = await open(browser, scheme, viewport, mode);
    await goSettings(page);
    await page.getByTestId("ai-page").waitFor();
    return { context, page };
  };
  const shoot = async (page, name) => {
    await page.waitForTimeout(350);
    check(`${tag} ${name}: 가로 넘침 0`, (await overflowX(page)) === 0, await overflowX(page));
    await save(page, `${PHASE}-${name}-${tag}`);
  };
  const cardShot = async (page, name) => {
    await page.getByTestId("ai-cohosted").evaluate((el) => el.scrollIntoView({ block: "center" }));
    await shoot(page, name);
  };
  if (PHASE === "before") {
    for (const danger of [false, true]) {
      const { context, page } = await go({ danger });
      await page.getByTestId("ai-cohosted-found").waitFor();
      check(`${tag} before: 창 없음`, (await page.getByTestId("ai-cohosted-prompt").count()) === 0);
      await cardShot(page, danger ? "card-danger" : "card");
      await context.close();
    }
    return;
  }
  {
    const { context, page } = await go({ danger: false });
    const dialog = page.getByTestId("ai-cohosted-prompt");
    await dialog.waitFor();
    check(`${tag} 처음: 창이 뜸`, (await dialog.innerText()).includes("연결할까요?"));
    await shoot(page, "prompt");
    await page.getByTestId("ai-cohosted-prompt-later").click();
    await page.getByTestId("ai-cohosted-found").waitFor();
    check(`${tag} 나중에: 창 닫힘, 카드 남음`, (await dialog.count()) === 0 && (await page.getByTestId("ai-cohosted-connect").count()) === 1);
    await cardShot(page, "card");
    await page.getByTestId("ai-cohosted-more").locator("summary").click();
    await cardShot(page, "card-more");
    check(`${tag} 자세히: 접힘 요약 초점 고리`, await focusRingVisible(page, "ai-cohosted-more", "summary"));
    await page.reload({ waitUntil: "networkidle" });
    await page.getByTestId("ai-cohosted-found").waitFor();
    await page.waitForTimeout(400);
    check(`${tag} 새로고침 뒤에도 다시 묻지 않음`, (await page.getByTestId("ai-cohosted-prompt").count()) === 0);
    await context.close();
  }
  {
    const { context, page } = await go({ danger: true });
    await page.getByTestId("ai-cohosted-toolsets-warn").waitFor();
    await page.waitForTimeout(400);
    check(`${tag} 위험 신호: 창 없이 카드에서 고르게 함`, (await page.getByTestId("ai-cohosted-prompt").count()) === 0);
    await cardShot(page, "card-danger");
    await context.close();
  }
  {
    const { context, page } = await go({ danger: false });
    await page.getByTestId("ai-cohosted-prompt").waitFor();
    await page.getByTestId("ai-cohosted-prompt-connect").click();
    await page.getByTestId("ai-cohosted-connected").waitFor();
    check(`${tag} 연결하기: 창 닫힘, 연결 줄`, (await page.getByTestId("ai-cohosted-prompt").count()) === 0);
    await cardShot(page, "connected");
    await context.close();
  }
}

async function main() {
  if (!existsSync(resolve(APP_ROOT, "dist/index.html"))) throw new Error("dist/ is missing. Run `npm run build` first.");
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = spawn(resolve(APP_ROOT, "node_modules/.bin/vite"), ["preview", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], { cwd: APP_ROOT, stdio: "ignore" });
  process.on("exit", () => preview.kill("SIGTERM"));
  try {
    await waitForServer(ORIGIN);
    const browser = await chromium.launch();
    try {
      for (const scheme of ["light", "dark"]) {
        for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
          await scenes(browser, scheme, viewport);
        }
      }
    } finally {
      await browser.close();
    }
  } finally {
    preview.kill("SIGTERM");
  }
  console.log(`\n${shots.length} captures in ${OUT_DIR}`);
  if (failures.length > 0) { console.error(`\n${failures.length}개 단언 실패`); process.exit(1); }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
