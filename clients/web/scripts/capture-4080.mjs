#!/usr/bin/env node
// =============================================================================
// CAPTURE : 에이전트별 AI 고르기(운영자 전용)와 설정 › AI의 「같은 서버의 Hermes」 카드.
//
//   npm run build && OUT_DIR=<dir> node scripts/capture-4080.mjs
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
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/4080");

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

const LOGIN_CODEX = "login_codex_0123456789";
const LOGIN_CLAUDE = "login_claude_0123456789";

/** mode.relay: ready | off | forbidden | error | slow ; mode.start: ok | busy | rate */
async function installMocks(context, mode) {
  const state = { loginStatus: "pending", connectedCodex: false };
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
  await context.route("**/v1/workspaces/*/cohosted-agent", (route) =>
    json(route, { schema: "momo.cohosted_agent.status.v0", declaration: "ready", endpointLabel: COHOST_LABEL, toolsLockAttested: true, connectable: false, connectedAgentId: HERMES }));
  const targets = () => ({ schema: "momo.login_relay.targets.v0", targets: [{ target: "openai-codex", connected: state.connectedCodex }, { target: "anthropic", connected: false }] });
  await context.route("**/v1/workspaces/*/agents/*/model-login", async (route) => {
    const method = route.request().method();
    if (method === "GET") {
      if (mode.relay === "forbidden") return json(route, { error: { message: "no" } }, 403);
      if (mode.relay === "off") return json(route, { error: { code: "login_relay_off", message: "off" } }, 409);
      if (mode.relay === "error") return json(route, { error: { message: "bad" } }, 502);
      if (mode.relay === "slow") await new Promise((r) => setTimeout(r, 4000));
      return json(route, targets());
    }
    if (mode.start === "rate") return json(route, { error: { code: "login_relay_rate_limited", message: "x" } }, 429);
    const body = JSON.parse(route.request().postData() ?? "{}");
    const now = Math.floor(Date.now() / 1000);
    if (body.provider === "openai-codex") {
      return json(route, { schema: "momo.login_relay.start.v0", loginId: LOGIN_CODEX, mode: "device", url: "https://auth.openai.com/codex/device", userCode: "KX7Q-4M2P", expiresAt: now + 870 });
    }
    return json(route, { schema: "momo.login_relay.start.v0", loginId: LOGIN_CLAUDE, mode: "paste", url: "https://claude.ai/oauth/authorize?code=true&client_id=capture", expiresAt: now + 290 });
  });
  await context.route("**/v1/workspaces/*/agents/*/model-login/*/complete", (route) => {
    state.loginStatus = "submitted";
    return json(route, { schema: "momo.login_relay.status.v0", status: "submitted" });
  });
  await context.route("**/v1/workspaces/*/agents/*/model-login/*", (route) => {
    if (route.request().method() === "DELETE") return json(route, { schema: "momo.login_relay.status.v0", status: "cancelled", reason: "cancelled" });
    if (state.loginStatus === "done") state.connectedCodex = true;
    return json(route, { schema: "momo.login_relay.status.v0", status: state.loginStatus });
  });
  mode.finish = () => { state.loginStatus = "done"; };
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
const focusRingVisible = async (page, testId) => {
  await page.keyboard.press("Tab");
  return page.getByTestId(testId).evaluate((el) => {
    el.focus();
    const s = getComputedStyle(el);
    return s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0;
  });
};


const FAKE_PASTE = "capture-only-fake-code#capture-only-fake-state";

async function scenes(browser, scheme, viewport) {
  const tag = `${viewport.width}-${scheme}`;
  const narrow = viewport.width < 700;
  const go = async (mode) => {
    const { context, page } = await open(browser, scheme, viewport, mode);
    await goSettings(page);
    await page.getByTestId("ai-page").waitFor();
    return { context, page };
  };
  const shoot = async (page, name, anchor = "model-login") => {
    await page.getByTestId(anchor).evaluate((el) => el.scrollIntoView({ block: "center" })).catch(() => undefined);
    await page.waitForTimeout(250);
    check(`${tag} ${name}: 가로 넘침 0`, (await overflowX(page)) === 0, await overflowX(page));
    await save(page, `${name}-${tag}`);
  };
  // 1) 빈(로그인 안 됨) 목록
  {
    const mode = { relay: "ready", start: "ok" };
    const { context, page } = await go(mode);
    await page.getByTestId("model-login-codex").waitFor();
    check(`${tag} 선택지 셋`, (await page.getByTestId("model-login-codex").count()) === 1 && (await page.getByTestId("model-login-claude").count()) === 1 && (await page.getByTestId("model-login-key").count()) === 1);
    await shoot(page, "idle");
    // 2) Codex 시작
    await page.getByTestId("model-login-start-openai-codex").click();
    await page.getByTestId("login-device-code").waitFor();
    check(`${tag} Codex: 호스트 강조`, (await page.getByTestId("login-host").innerText()) === "auth.openai.com");
    check(`${tag} Codex: 기기 코드`, (await page.getByTestId("login-device-code").innerText()).includes("KX7Q-4M2P"));
    check(`${tag} Codex: 열기 rel`, (await page.getByTestId("login-open").getAttribute("rel")) === "noopener noreferrer");
    check(`${tag} Codex: 열기 초점 고리`, await focusRingVisible(page, "login-open"));
    await shoot(page, "codex-device");
    // 승인되면 폴링이 끝을 알린다
    // 승인되면 폴링(4초)이 끝을 알리고 기기 코드가 화면에서 사라진다
    mode.finish();
    await page.getByTestId("model-login-result").waitFor({ timeout: 9000 });
    check(`${tag} Codex 성공: 코드가 사라짐`, !(await page.content()).includes("KX7Q-4M2P"));
    await shoot(page, "codex-done");
    await context.close();
  }
  {
    const { context, page } = await go({ relay: "ready", start: "ok" });
    await page.getByTestId("model-login-start-openai-codex").click();
    await page.getByTestId("login-session").waitFor();
    await page.getByTestId("login-cancel").click();
    check(`${tag} 취소하면 세션 사라짐`, (await page.getByTestId("login-session").count()) === 0);
    await context.close();
  }
  // 3) Claude: 약관 한 줄 → 붙여넣기 → 확인 중
  {
    const { context, page } = await go({ relay: "ready", start: "ok" });
    await page.getByTestId("model-login-claude").waitFor();
    await page.getByTestId("model-login-start-anthropic").click();
    await page.getByTestId("model-login-claude-terms").waitFor();
    await shoot(page, "claude-terms");
    await page.getByTestId("model-login-claude-confirm").click();
    await page.getByTestId("login-paste").waitFor();
    check(`${tag} Claude: 붙여넣기 칸은 마스킹`, (await page.getByTestId("login-paste").getAttribute("type")) === "password");
    await shoot(page, "claude-paste");
    await page.getByTestId("login-paste").fill(FAKE_PASTE);
    check(`${tag} Claude: 붙여넣기 초점 고리`, await focusRingVisible(page, "login-paste-send"));
    await shoot(page, "claude-pasted");
    await page.getByTestId("login-paste-send").click();
    await page.waitForTimeout(200);
    check(`${tag} Claude: 보낸 뒤 칸이 비어 있음`, (await page.getByTestId("login-paste").inputValue()) === "");
    check(`${tag} Claude: 화면 어디에도 값이 없음`, !(await page.content()).includes("capture-only-fake-code"));
    await shoot(page, "claude-submitted");
    await context.close();
  }
  // 4) 꺼짐: 셸 명령
  {
    const { context, page } = await go({ relay: "off" });
    await page.getByTestId("model-login-shell").waitFor();
    check(`${tag} 꺼짐: 명령 표시, 시작 단추 없음`, (await page.getByTestId("model-login-shell").innerText()).includes("hermes auth add anthropic") && (await page.getByTestId("model-login-start-anthropic").count()) === 0);
    await shoot(page, "relay-off");
    await context.close();
  }
  // 5) 오류, 6) 불러오는 중
  {
    const { context, page } = await go({ relay: "error" });
    await page.getByTestId("model-login-error").waitFor();
    await shoot(page, "load-error");
    await context.close();
  }
  {
    const { context, page } = await go({ relay: "slow" });
    await page.getByTestId("model-login-loading").waitFor();
    await shoot(page, "loading");
    await context.close();
  }
  if (narrow) return;
  // 7) 시작 거절(429)
  {
    const { context, page } = await go({ relay: "ready", start: "rate" });
    await page.getByTestId("model-login-start-openai-codex").click();
    await page.getByTestId("model-login-start-error").waitFor();
    await shoot(page, "start-refused");
    await context.close();
  }
  // 8) 운영자가 아니면 없다
  {
    const { context, page } = await go({ relay: "forbidden" });
    await page.waitForTimeout(600);
    check(`${tag} 운영자 아님: 모델 인증 없음`, (await page.getByTestId("model-login").count()) === 0);
    await context.close();
  }
}

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) throw new Error("dist/ is missing. Run `npm run build` first.");
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = spawn(resolve(WEB_ROOT, "node_modules/.bin/vite"), ["preview", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], { cwd: WEB_ROOT, stdio: "ignore" });
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
