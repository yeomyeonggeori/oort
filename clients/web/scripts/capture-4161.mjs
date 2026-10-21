#!/usr/bin/env node
// =============================================================================
// CAPTURE (#4161): 연결된 Hermes의 「모델」 구획(지금 답하는 모델·바꾸기·전체 보기), 연결 직후 「어떤 모델로 쓸까요?」,
// 로그인된 제공자를 접은 모델 인증 블록(일부/전부).
//
//   npm run build && OUT_DIR=<dir> [APP_ROOT=<빌드가 있는 web 폴더>] [PHASE=before|after] node scripts/capture-4161.mjs
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
const PORT = Number(process.env.CAPTURE_PORT || 5461);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const APP_ROOT = process.env.APP_ROOT ? resolve(process.env.APP_ROOT) : WEB_ROOT;
const PHASE = process.env.PHASE || "after";
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/4161");

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

const MODELS_ALL = {
  anthropic: [
    { id: "claude-sonnet-5-5", featured: true },
    { id: "claude-opus-5", featured: true },
    { id: "claude-haiku-4-5", featured: true },
    { id: "claude-sonnet-4", featured: false },
    { id: "claude-3-opus", featured: false },
  ],
  "openai-codex": [
    { id: "gpt-5.5", featured: true },
    { id: "gpt-5.4", featured: true },
    { id: "gpt-5.3-codex", featured: false },
  ],
};

async function installMocks(context, mode) {
  const state = { connected: Boolean(mode.startConnected), dm: Boolean(mode.startConnected), current: { provider: "anthropic", model: "claude-sonnet-5-5" }, puts: [] };
  const providers = mode.providers ?? ["anthropic"];
  const modelsBody = () => ({
    schema: "momo.cohosted_agent.models.v0", agentId: HERMES, pinned: true, current: state.current,
    providers: providers.map((p) => ({ provider: p, models: MODELS_ALL[p].map((m) => ({ ...m, current: p === state.current.provider && m.id === state.current.model })) })),
  });
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
    json(route, { schema: "momo.cohosted_agent.probe.v0", state: "ok", requestsSent: 3, modelCount: 1, toolsLockAttested: true, connectable: true, toolsets: { signal: "none_listed", proof: false } }));
  await context.route("**/v1/workspaces/*/cohosted-agent/models", (route) => json(route, modelsBody()));
  await context.route("**/v1/workspaces/*/cohosted-agent/model", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    state.puts.push(body);
    await new Promise((r) => setTimeout(r, mode.slowPut ? 900 : 0));
    state.current = { provider: body.provider, model: body.model };
    return json(route, { schema: "momo.cohosted_agent.model.v0", agentId: HERMES, current: state.current, pinned: true });
  });
  await context.route("**/v1/workspaces/*/dms", (route) => {
    state.dm = true;
    return json(route, { channel: DM, created: true });
  });
  await context.route("**/v1/workspaces/*/cohosted-agent/connect", (route) => {
    state.connected = true;
    return json(route, { schema: "momo.cohosted_agent.connect.v0", agentId: HERMES, displayName: "Hermes", handle: "hermes" });
  });
  return state;
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
  const state = await installMocks(context, mode);
  await installRealtime(context);
  const page = await context.newPage();
  await page.goto(ORIGIN, { waitUntil: "networkidle" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("seongjae@dawn.example");
  await page.getByTestId("login-password").fill("capture-only-not-a-credential");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-list").waitFor({ state: "visible" });
  return { context, page, state };
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
    const opened = await open(browser, scheme, viewport, mode);
    await opened.page.evaluate((h) => { location.hash = h; }, hash);
    return opened;
  };
  const shoot = async (page, name) => {
    await page.waitForTimeout(350);
    check(`${tag} ${name}: 가로 넘침 0`, (await overflowX(page)) === 0, await overflowX(page));
    await save(page, `${PHASE}-${name}-${tag}`);
  };
  const later = async (page) => {
    await page.getByTestId("ai-cohosted-prompt").waitFor();
    await page.getByTestId("ai-cohosted-prompt-later").click();
  };
  // 이미 연결됨(제공자 하나만 로그인): 전/후 공통 장면
  {
    const { context, page } = await go({ startConnected: true, providers: ["anthropic"] }, "/ai/accounts");
    await page.getByTestId("ai-cohosted-connected").waitFor();
    if (PHASE === "after") {
      await page.getByTestId("ai-cohosted-model-select").waitFor();
      check(`${tag} 모델 문장은 한 번`, ((await page.getByTestId("ai-cohosted-model").innerText()).split("Claude Sonnet 5.5 · Anthropic").length - 1) === 1);
      await page.getByTestId("model-login-in-anthropic").waitFor();
      const shell = await page.getByTestId("model-login-shell").innerText();
      check(`${tag} 로그인된 Claude는 명령 없이 「로그인됨」`, !shell.includes("hermes auth add anthropic") && shell.includes("로그인됨"), shell);
      check(`${tag} 로그인 안 된 Codex만 명령`, shell.includes("hermes auth add openai-codex"));
    } else {
      await page.getByTestId("model-login-shell").waitFor();
    }
    await shoot(page, "connected-partial");
    await context.close();
  }
  if (PHASE === "before") {
    // 연결 직후(알림 아래에 모델 인증 명령 블록만 남는다)
    const { context, page } = await go({ providers: ["anthropic"] }, "/ai/accounts");
    await later(page);
    await page.getByTestId("ai-cohosted-connect").click();
    await page.getByTestId("ai-cohosted-connected-notice").waitFor();
    await page.getByTestId("model-login-shell").waitFor();
    await shoot(page, "just-connected");
    await context.close();
    return;
  }
  // 둘 다 로그인: 인증 블록이 한 줄로 접힌다
  {
    const { context, page } = await go({ startConnected: true, providers: ["anthropic", "openai-codex"] }, "/ai/accounts");
    await page.getByTestId("ai-cohosted-model-select").waitFor();
    await page.getByTestId("model-login-fold").waitFor();
    check(`${tag} 둘 다 로그인: 접힘`, (await page.getByTestId("model-login").getAttribute("data-folded")) !== null);
    check(`${tag} 접힌 한 줄 문구`, (await page.getByTestId("model-login-fold").innerText()).includes("모두 로그인됨"));
    await shoot(page, "connected-all-folded");
    await context.close();
  }
  // 모델 고르기: 목록(추린 모델) → 전체 보기 → 선택 → 저장 알림
  {
    const { context, page, state } = await go({ startConnected: true, providers: ["anthropic", "openai-codex"], slowPut: true }, "/ai/accounts");
    await page.getByTestId("ai-cohosted-model-select").waitFor();
    await page.getByTestId("ai-cohosted-model-select").click();
    await page.getByRole("listbox").waitFor();
    const featured = await page.getByRole("option").count();
    check(`${tag} 추린 모델만 기본 노출(5개)`, featured === 5, featured);
    await shoot(page, "model-open");
    await page.keyboard.press("Escape");
    await page.getByTestId("ai-cohosted-model-toggle").click();
    await page.getByTestId("ai-cohosted-model-select").click();
    await page.getByRole("listbox").waitFor();
    const all = await page.getByRole("option").count();
    check(`${tag} 전체 보기: 8개`, all === 8, all);
    await shoot(page, "model-open-all");
    const noteY = () => page.getByTestId("ai-cohosted-model-anchor").locator("span.text-meta.text-ink-muted").last().evaluate((el) => el.getBoundingClientRect().top);
    const y0 = await noteY();
    await page.getByRole("option").filter({ hasText: "gpt-5.5" }).click();
    await page.getByTestId("ai-cohosted-model-saving").waitFor();
    check(`${tag} 저장 중 아래 줄이 밀리지 않음`, Math.abs((await noteY()) - y0) < 1, [y0, await noteY()]);
    await shoot(page, "model-saving");
    await page.getByTestId("ai-cohosted-model-saved").waitFor();
    check(`${tag} 저장 뒤에도 밀리지 않음`, Math.abs((await noteY()) - y0) < 1, [y0, await noteY()]);
    check(`${tag} PUT payload`, JSON.stringify(state.puts) === JSON.stringify([{ provider: "openai-codex", model: "gpt-5.5" }]), state.puts);
    check(`${tag} 선택 칸이 바뀐 모델을 말함`, (await page.getByTestId("ai-cohosted-model-select").innerText()).includes("gpt-5.5 · OpenAI Codex"));
    await shoot(page, "model-saved");
    await context.close();
  }
  // 연결 직후: 알림 다음에 「어떤 모델로 쓸까요?」 와 초점
  {
    const { context, page } = await go({ providers: ["anthropic"] }, "/ai/accounts");
    await later(page);
    await page.getByTestId("ai-cohosted-connect").click();
    await page.getByTestId("ai-cohosted-connected-notice").waitFor();
    await page.getByTestId("ai-cohosted-model-select").waitFor();
    const title = await page.getByTestId("ai-cohosted-model").locator("h4").innerText();
    check(`${tag} 연결 직후 제목`, title === "어떤 모델로 쓸까요?", title);
    const focused = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
    check(`${tag} 초점이 모델 구획`, focused === "ai-cohosted-model-anchor", focused);
    await shoot(page, "just-connected");
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
