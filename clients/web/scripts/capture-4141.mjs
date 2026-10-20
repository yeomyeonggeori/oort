#!/usr/bin/env node
// =============================================================================
// CAPTURE (#4141): 설정 목차의 AI 한 행, 옛 ?section=ai의 허브 리다이렉트, 허브 맨 위 「같은 서버의 Hermes」 카드,
// 연결 성공 알림(「Hermes를 연결했어요」 + 「대화 열기」), 연결됨 줄, 사이드바에 생긴 Hermes DM.
//
//   npm run build && OUT_DIR=<dir> [APP_ROOT=<빌드가 있는 web 폴더>] [PHASE=before|after] node scripts/capture-4141.mjs
//
// 백엔드가 없다. `/v1/**`는 이 파일의 고정 응답이다. **라이브 서버 동작은 runtime-unverified**다. 1440 × 라이트/다크.
// =============================================================================
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.CAPTURE_PORT || 5416);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const APP_ROOT = process.env.APP_ROOT ? resolve(process.env.APP_ROOT) : WEB_ROOT;
const PHASE = process.env.PHASE || "after";
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/4141");

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

const DM = { id: "00000000-0000-7000-8000-000000000501", workspaceId: WS, kind: "dm", muted: false, memberIds: [ME, HERMES] };

async function installMocks(context, mode) {
  const state = { connected: Boolean(mode.startConnected), dm: Boolean(mode.startConnected) };
  await context.route("**/v1/**", (route) => json(route, { channels: [], members: [], read_states: [], messages: [] }));
  await context.route("**/v1/auth/login", (route) => json(route, SESSION));
  await context.route("**/v1/auth/refresh", (route) => json(route, { accessToken: SESSION.accessToken, refreshToken: SESSION.refreshToken }));
  await context.route("**/v1/auth/realtime-token", (route) => json(route, { token: "x", tokenType: "jwt", expiresAtMs: Date.now() + 60_000, ttlSeconds: 60, workspaceId: WS, memberId: ME }));
  await context.route("**/v1/workspaces/*/channels", (route) => json(route, { channels: [{ id: CH, workspaceId: WS, kind: "public", name: "general", muted: false }, ...(state.dm ? [DM] : [])] }));
  await context.route("**/v1/workspaces/*/roster", (route) => json(route, { members: state.connected ? ROSTER : ROSTER.filter((m) => m.id !== HERMES) }));
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
  await context.route("**/v1/workspaces/*/dms", (route) => {
    state.dm = true;
    return json(route, { channel: DM, created: true });
  });
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

async function scenes(browser, scheme, viewport) {
  const tag = `${viewport.width}-${scheme}`;
  const go = async (mode, hash) => {
    const { context, page } = await open(browser, scheme, viewport, mode);
    await page.evaluate((h) => { location.hash = h; }, hash);
    return { context, page };
  };
  const shoot = async (page, name) => {
    await page.waitForTimeout(350);
    check(`${tag} ${name}: 가로 넘침 0`, (await overflowX(page)) === 0, await overflowX(page));
    await save(page, `${PHASE}-${name}-${tag}`);
  };
  // 설정 목차: 앱·연결 그룹의 AI 관련 행
  {
    const { context, page } = await go({}, "/settings?section=profile");
    await page.getByTestId("settings-nav").waitFor();
    const aiRows = await page.locator('[data-testid^="settings-nav-"]').evaluateAll((els) => els.map((e) => e.textContent).filter((t) => /^AI/.test(t ?? "")));
    console.log(`${tag} 목차 AI 행:`, JSON.stringify(aiRows));
    if (PHASE === "after") check(`${tag} 목차에 AI 관련 행 1개`, aiRows.length === 1 && aiRows[0] === "AI", aiRows);
    await shoot(page, "toc");
    await context.close();
  }
  if (PHASE === "before") {
    const { context, page } = await go({}, "/settings?section=ai");
    await page.getByTestId("ai-hub-moved-link").waitFor();
    await shoot(page, "legacy-ai-page");
    await context.close();
    return;
  }
  // 옛 딥링크는 허브로 간다. 처음 한 번 창이 허브 진입에서 뜬다.
  {
    const { context, page } = await go({ danger: false }, "/settings?section=ai");
    const dialog = page.getByTestId("ai-cohosted-prompt");
    await dialog.waitFor();
    check(`${tag} ?section=ai → 허브 AI 계정`, page.url().includes("#/ai/accounts"), page.url());
    check(`${tag} 처음: 창이 뜸`, (await dialog.innerText()).includes("연결할까요?"));
    await shoot(page, "prompt");
    await page.getByTestId("ai-cohosted-prompt-later").click();
    await page.getByTestId("ai-cohosted-found").waitFor();
    const order = await page.evaluate(() => {
      const card = document.querySelector('[data-testid="ai-cohosted"]');
      const pane = document.querySelector('[data-testid="ai-tools-pane"]');
      return Boolean(card && pane && (card.compareDocumentPosition(pane) & Node.DOCUMENT_POSITION_FOLLOWING));
    });
    check(`${tag} 카드가 구획 본문보다 위`, order);
    await shoot(page, "hub-card-found");
    await page.reload({ waitUntil: "networkidle" });
    await page.getByTestId("ai-cohosted-found").waitFor();
    await page.waitForTimeout(400);
    check(`${tag} 새로고침 뒤에도 다시 묻지 않음`, (await page.getByTestId("ai-cohosted-prompt").count()) === 0);
    await context.close();
  }
  // 카드 단추로 연결: 알림 + 연결됨 + 사이드바 DM
  {
    const { context, page } = await go({ danger: false }, "/ai/accounts");
    await page.getByTestId("ai-cohosted-prompt").waitFor();
    await page.getByTestId("ai-cohosted-prompt-later").click();
    await page.getByTestId("ai-cohosted-connect").click();
    await page.getByTestId("ai-cohosted-connected-notice").waitFor();
    const text = await page.getByTestId("ai-cohosted-connected-notice").innerText();
    check(`${tag} 알림 문구`, text.includes("Hermes를 연결했어요") && text.includes("대화 열기"), text);
    await page.getByTestId("ai-cohosted-connected").waitFor();
    check(`${tag} 카드가 연결됨`, (await page.getByTestId("ai-cohosted-connected").innerText()).includes("Hermes 연결됨"));
    await page.waitForTimeout(600);
    await shoot(page, "connected-notice");
    await page.getByTestId("ai-cohosted-notice-open-dm").click();
    await page.waitForFunction((id) => location.hash.includes(`/c/${id}`), DM.id);
    check(`${tag} 대화 열기 → DM`, true);
    await context.close();
  }
  // 이미 연결됨: 연결됨 줄의 「대화 열기」
  {
    const { context, page } = await go({ startConnected: true }, "/ai/accounts");
    await page.getByTestId("ai-cohosted-connected").waitFor();
    check(`${tag} 이미 연결됨: 알림 없음`, (await page.getByTestId("ai-cohosted-connected-notice").count()) === 0);
    await shoot(page, "connected-line");
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
        for (const viewport of [{ width: 1440, height: 900 }]) {
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
