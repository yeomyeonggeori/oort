#!/usr/bin/env node
// =============================================================================
// CAPTURE (#3875 + ADR-0203 짝 UI): 에이전트별 AI 고르기(운영자 전용)와 설정 › AI의 「같은 서버의 Hermes」 카드.
//
//   npm run build && OUT_DIR=<dir> node scripts/capture-3875.mjs
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
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/3875");

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
const PIN_SCHEMA = "momo.agent.provider_pin.v0";
const COHOST_LABEL = "http://hermes.railway.internal:8642/v1";

const failures = [];
function check(name, ok, detail) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
  if (!ok) failures.push(name);
}
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** mode: { pin: 'none'|'unresolved'|'env'|'forbidden'|'absent', cohost: 'hidden'|'checklist'|'found'|'unreachable'|'connected'|'warn'|'forbidden' } */
async function installMocks(context, mode) {
  const state = { pin: mode.pin === "unresolved" ? { kind: "team_link", linkPosition: 3, endpointLabel: "gateway.old.internal:8443", linkResolved: false, updatedAtMs: 1 } : null, connected: mode.cohost === "connected" };
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

  await context.route("**/v1/workspaces/*/agents/*/provider-pin", async (route) => {
    if (mode.pin === "forbidden") return json(route, { error: { message: "operator required" } }, 403);
    if (mode.pin === "absent") return json(route, { error: { message: "not found" } }, 404);
    if (route.request().method() === "PUT") {
      const body = JSON.parse(route.request().postData() ?? "{}");
      if (mode.pin === "refuse") return json(route, { error: { code: "agent_own_model_required", message: "x" } }, 409);
      state.pin = body.kind === "default" ? null : { kind: body.kind, linkPosition: body.linkPosition, endpointLabel: body.kind === "operator_env" ? COHOST_LABEL : CHAIN.entries[body.linkPosition]?.endpointLabel, linkResolved: true, updatedAtMs: Date.now() };
    }
    return json(route, { schema: PIN_SCHEMA, agentId: INTERN, pin: state.pin });
  });

  const status = () => ({
    schema: "momo.cohosted_agent.status.v0",
    declaration: mode.cohost === "hidden" ? "not_declared" : "ready",
    endpointLabel: COHOST_LABEL,
    toolsLockAttested: mode.cohost !== "checklist",
    connectable: mode.cohost !== "checklist" && !state.connected,
    ...(state.connected ? { connectedAgentId: HERMES } : {}),
  });
  await context.route("**/v1/workspaces/*/cohosted-agent", (route) => {
    if (mode.cohost === "forbidden") return json(route, { error: { message: "operator required" } }, 403);
    return json(route, status());
  });
  await context.route("**/v1/workspaces/*/cohosted-agent/probe", (route) => {
    const unreachable = mode.cohost === "unreachable";
    return json(route, {
      schema: "momo.cohosted_agent.probe.v0",
      state: unreachable ? "unreachable" : "ok",
      endpointLabel: COHOST_LABEL,
      requestsSent: unreachable ? 1 : 3,
      ...(unreachable ? {} : { modelCount: 1 }),
      toolsLockAttested: true,
      toolsets: mode.cohost === "warn" ? { signal: "dangerous_listed", listed: ["terminal"], proof: false } : { signal: "none_listed", proof: false },
      connectable: !unreachable,
    });
  });
  await context.route("**/v1/workspaces/*/cohosted-agent/connect", async (route) => {
    await new Promise((r) => setTimeout(r, 300));
    state.connected = true;
    return json(route, { schema: "momo.cohosted_agent.connect.v0", agentId: HERMES, displayName: "Hermes", handle: "hermes", endpointLabel: COHOST_LABEL, pinKind: "operator_env" }, 201);
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
const goAgent = (page, id) => page.evaluate((agent) => { location.hash = `/agents?agent=${agent}`; }, id);
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

async function pinScenes(browser, scheme, viewport) {
  const tag = `${viewport.width}-${scheme}`;
  const narrow = viewport.width < 700;
  // 1) 기본: 고르지 않음
  {
    const { context, page } = await open(browser, scheme, viewport, { pin: "none", cohost: "connected" });
    await goAgent(page, INTERN);
    await page.getByTestId("agent-pin-section").waitFor({ state: "visible" });
    await page.getByTestId("agent-pin-option-team_link:1").waitFor();
    await page.getByTestId("agent-pin-section").evaluate((el) => el.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(300);
    check(`${tag} 핀: 선택지 넷(기본·Hermes·연결1·연결2)`, (await page.locator("[data-testid^='agent-pin-option-']").count()) === 4);
    check(`${tag} 핀: 저장은 바꾸기 전까지 잠김`, await page.getByTestId("agent-pin-save").isDisabled());
    check(`${tag} 핀: 가로 넘침 0`, (await overflowX(page)) === 0, await overflowX(page));
    await save(page, `pin-default-${tag}`);
    // 2) Hermes 고르고 저장
    await page.getByTestId("agent-pin-option-operator_env").locator("input").check();
    check(`${tag} 핀: 고르면 저장이 열림`, !(await page.getByTestId("agent-pin-save").isDisabled()));
    check(`${tag} 핀: 키보드 초점 고리`, await focusRingVisible(page, "agent-pin-save"));
    await save(page, `pin-picked-${tag}`);
    await page.getByTestId("agent-pin-save").click();
    await page.getByTestId("agent-pin-saved").waitFor();
    await save(page, `pin-saved-${tag}`);
    await context.close();
  }
  // 3) 풀리지 않는 고정
  {
    const { context, page } = await open(browser, scheme, viewport, { pin: "unresolved", cohost: "hidden" });
    await goAgent(page, INTERN);
    await page.getByTestId("agent-pin-unresolved").waitFor();
    await page.getByTestId("agent-pin-section").evaluate((el) => el.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(300);
    check(`${tag} 핀: 풀리지 않음 문장`, (await page.getByTestId("agent-pin-unresolved").innerText()).includes("다른 연결로 넘어가지 않고"));
    check(`${tag} 핀: 선언 없는 서버에는 「같은 서버의 Hermes」 선택지 없음`, (await page.getByTestId("agent-pin-option-operator_env").count()) === 0);
    await save(page, `pin-unresolved-${tag}`);
    await context.close();
  }
  if (narrow) return;
  // 4) 서버 거절
  {
    const { context, page } = await open(browser, scheme, viewport, { pin: "refuse", cohost: "connected" });
    await goAgent(page, INTERN);
    await page.getByTestId("agent-pin-option-team_link:0").waitFor();
    await page.getByTestId("agent-pin-option-team_link:0").locator("input").check();
    await page.getByTestId("agent-pin-save").click();
    await page.getByTestId("agent-pin-save-error").waitFor();
    await page.getByTestId("agent-pin-section").evaluate((el) => el.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(300);
    await save(page, `pin-refused-${tag}`);
    await context.close();
  }
  // 5) 운영자가 아니면 절이 없다
  for (const pin of ["forbidden", "absent"]) {
    const { context, page } = await open(browser, scheme, viewport, { pin, cohost: "forbidden" });
    await goAgent(page, INTERN);
    await page.getByTestId("agent-identity-card").waitFor({ state: "visible" });
    await page.waitForTimeout(500);
    check(`${tag} 핀: ${pin} 이면 절이 없다`, (await page.getByTestId("agent-pin-section").count()) === 0);
    await context.close();
  }
}

async function cohostScenes(browser, scheme, viewport) {
  const tag = `${viewport.width}-${scheme}`;
  const narrow = viewport.width < 700;
  const scene = async (cohost, name, after) => {
    const { context, page } = await open(browser, scheme, viewport, { pin: "forbidden", cohost });
    await goSettings(page);
    await page.getByTestId("ai-page").waitFor();
    if (after) await after(page);
    await page.getByTestId("ai-cohosted").evaluate((el) => el.scrollIntoView({ block: "center" })).catch(() => undefined);
    await page.waitForTimeout(300);
    check(`${tag} 카드 ${name}: 가로 넘침 0`, (await overflowX(page)) === 0, await overflowX(page));
    await save(page, `cohost-${name}-${tag}`);
    return { context, page };
  };
  // 잠금 선언 전: 체크리스트만
  {
    const { context, page } = await scene("checklist", "checklist", async (p) => p.getByTestId("ai-cohosted-checklist-row").waitFor());
    check(`${tag} 선언 전: 연결 단추 없음`, (await page.getByTestId("ai-cohosted-connect").count()) === 0);
    check(`${tag} 선언 전: 체크리스트 링크`, (await page.getByTestId("ai-cohosted-checklist").count()) === 1);
    await context.close();
  }
  // 선언 뒤: 찾았다 → 한 번 클릭 → 연결됨
  {
    const { context, page } = await scene("found", "found", async (p) => p.getByTestId("ai-cohosted-found").waitFor());
    const found = await page.getByTestId("ai-cohosted-found").innerText();
    check(`${tag} 찾았어요 문장`, found.includes("같은 서버의 Hermes를 찾았어요, 연결할까요?"), found);
    check(`${tag} 정직한 표기`, found.includes("운영자님이 서버에 직접 선언한 값") && found.includes("확인한 것이 아니에요"));
    check(`${tag} 키보드 초점 고리(연결)`, await focusRingVisible(page, "ai-cohosted-connect"));
    if (!narrow) {
      await page.getByTestId("ai-cohosted-connect").click();
      await page.getByTestId("ai-cohosted-connected").waitFor();
      await page.waitForTimeout(300);
      check(`${tag} 연결 뒤 초점이 새 줄로`, await page.evaluate(() => document.activeElement?.getAttribute("data-testid") === "ai-cohosted-connected"));
      await save(page, `cohost-connected-${tag}`);
    }
    await context.close();
  }
  if (narrow) return;
  const warn = await scene("warn", "warn", async (p) => p.getByTestId("ai-cohosted-toolsets-warn").waitFor());
  await warn.context.close();
  const dead = await scene("unreachable", "unreachable", async (p) => p.getByTestId("ai-cohosted-not-found").waitFor());
  await dead.context.close();
  // 선언이 없거나 운영자가 아니면 카드가 없다
  for (const cohost of ["hidden", "forbidden"]) {
    const { context, page } = await open(browser, scheme, viewport, { pin: "forbidden", cohost });
    await goSettings(page);
    await page.getByTestId("ai-page").waitFor();
    await page.waitForTimeout(500);
    check(`${tag} 카드: ${cohost} 이면 없다`, (await page.getByTestId("ai-cohosted").count()) === 0);
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
          await pinScenes(browser, scheme, viewport);
          await cohostScenes(browser, scheme, viewport);
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
