#!/usr/bin/env node
// =============================================================================
// 개인 API 키 UI 캡처 (#3469): 운영자(AI › 팀 AI 키 아래 「개인 API 키」: 빈 목록·목록·발급 창·회수 확인)와
// 멤버(AI › 내 AI 계정 「받은 개인 키」: 빈 목록·목록·에이전트 만들기 창·회수 확인), 웹 라이트·다크 × 1440·420.
//
//   npm run build && OUT_DIR=~/captures node scripts/capture-ai-personal-keys.mjs
//
// 백엔드는 없다: `/v1/**`는 고정 응답, 실시간 소켓은 곧바로 연결되는 흉내다. 운영자 여부는 서버가 하듯
// `GET /v1/provider/link` 200(운영자) / 403(멤버)로 가른다. 키 값은 어느 응답에도 없다.
// =============================================================================

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/ai-personal-keys");
const PORT = Number(process.env.CAPTURE_PORT || 5236);
const SECRET = "sk-capture-PERSONAL-0123456789abcdef";

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const seoyeon = "00000000-0000-7000-8000-000000000102";
const mina = "00000000-0000-7000-8000-000000000103";
const jun = "00000000-0000-7000-8000-000000000104";
const channels = [{ id: "00000000-0000-7000-8000-000000000201", workspaceId, kind: "public", name: "general", muted: false }];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: "ws://ai-personal-keys-capture.invalid/connection/websocket",
};
const base = { workspaceId, status: "active", channelCount: 1, channelIds: channels.map((c) => c.id), capabilities: [], createdAtMs: 0, updatedAtMs: 0 };
const human = (id, displayName, handle, role) => ({ ...base, id, kind: "human", displayName, handle, role });
const roster = () => [
  human(memberId, "곽성재", "seongjae", scenario.role),
  human(seoyeon, "서연", "seoyeon", "member"),
  human(mina, "미나", "mina", "member"),
  human(jun, "준호 Lee-Kim-Park", "junho", "member"),
];

const link = {
  schema: "momo.provider_link.v0", configured: true, source: "database", mode: "external-hermes", baseUrl: "https://api.anthropic.com/v1",
  endpointLabel: "https://api.anthropic.com/v1", bearerConfigured: true, bearerLast4: "7c1e", availability: "live", keyConfigured: true,
  updatedAtMs: 1_790_000_000_000, diagnostics: [], credentialKind: "bearer",
  presets: [
    { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", format: "openai" },
    { id: "anthropic", label: "Anthropic", baseUrl: "https://api.anthropic.com", format: "anthropic" },
  ],
};
const pk = (n, owner, format, extra = {}) => ({
  id: `00000000-0000-7000-8000-0000000004a${n}`, ownerMemberId: owner, format, endpointLabel: format === "anthropic" ? "api.anthropic.com" : "api.openai.com",
  status: "active", issuedBy: memberId, issuedAtMs: 1_790_000_000_000 + n * 86_400_000, ...extra,
});
const KEYS = {
  none: [],
  some: [
    pk(1, seoyeon, "anthropic", { label: "리서치 에이전트용" }),
    pk(2, mina, "openai"),
    pk(3, jun, "openai", { status: "revoked", revokedAtMs: 1_790_400_000_000 }),
  ],
};
const MINE = {
  none: [],
  one: [pk(1, memberId, "anthropic", { label: "리서치 에이전트용" })],
};
const scenario = { role: "owner", keys: "none", mine: "none" };

const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function installRoutes(context) {
  await context.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId });
    }
    if (path === "/v1/provider/link") {
      return scenario.role === "owner" ? json(route, link) : json(route, { error: { code: "forbidden", message: "운영자만 볼 수 있어요." } }, 403);
    }
    if (path.startsWith("/v1/provider/link/chain")) return json(route, { error: { code: "not_found", message: "none" } }, 404);
    if (path === "/v1/provider/default-ai") return json(route, { teamAgent: null, summary: null });
    if (path.endsWith("/personal-keys/mine")) return json(route, { keys: MINE[scenario.mine] });
    if (path.endsWith("/personal-keys")) {
      return scenario.role === "owner" ? json(route, { keys: KEYS[scenario.keys] }) : json(route, { error: { code: "forbidden", message: "no" } }, 403);
    }
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) return json(route, { members: roster() });
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/hosted-agent-connections")) return json(route, { connections: [] });
    if (path.endsWith(`/workspaces/${workspaceId}`)) {
      return json(route, { workspace: { id: workspaceId, name: "여명거리", slug: "team", updatedAtMs: 1, roleLabels: {}, welcomeAgentMemberId: null, welcomePrompt: "", subscriptionAgentsEnabled: true } });
    }
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: [] });
    if (path.endsWith("/work-sessions/shared")) return json(route, { sessions: [], nextCursor: null });
    if (path.endsWith("/work-sessions")) return json(route, { workSessions: [] });
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
          if (c.connect) return { id: c.id, connect: { client: "ai-agents-capture", version: "6" } };
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


const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok) failures.push(name);
}
const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function open(browser, origin, scheme, viewport) {
  const context = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion: "reduce", serviceWorkers: "block" });
  await installRoutes(context);
  const page = await context.newPage();
  await installRealtime(page);
  await page.addInitScript((server) => { try { localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ } }, origin);
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("nav-ai").waitFor({ timeout: 20_000 });
  return { context, page };
}

async function shot(page, name) {
  await page.waitForTimeout(500);
  await page.screenshot({ path: resolve(OUT_DIR, `${name}.png`) });
}

async function operator(browser, origin, scheme, viewport) {
  const tag = `${viewport.width}-${scheme}-operator`;
  for (const keys of ["none", "some"]) {
    Object.assign(scenario, { role: "owner", keys, mine: "none" });
    const { context, page } = await open(browser, origin, scheme, viewport);
    try {
      await page.goto(`${origin}/#/ai/team-keys`);
      await page.getByTestId("ai-personal-keys").waitFor();
      await page.getByTestId(keys === "none" ? "ai-personal-keys-empty" : "ai-personal-keys-list").waitFor();
      await page.getByTestId("ai-personal-keys").scrollIntoViewIfNeeded();
      await page.evaluate(() => document.querySelector("[data-testid='ai-personal-keys']")?.scrollIntoView({ block: "start" }));
      await shot(page, `${keys === "none" ? "empty" : "list"}-${tag}`);
      check(`${tag} ${keys}: 문서 가로 넘침 0`, (await overflowX(page)) === 0);
      if (keys === "some") {
        const rows = await page.getByTestId("ai-personal-key-row").count();
        check(`${tag} 세 줄(사용 중 둘, 회수됨 하나)`, rows === 3);
        check(`${tag} 화면에 키 값 없음`, !(await page.content()).includes("sk-"));
        await page.getByTestId("ai-personal-key-revoke").first().click();
        await page.getByTestId("ai-personal-revoke-dialog").waitFor();
        await shot(page, `revoke-confirm-${tag}`);
        await page.keyboard.press("Escape");
        await page.getByTestId("ai-personal-revoke-dialog").waitFor({ state: "detached" });
        const focused = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
        check(`${tag} Esc 로 닫으면 회수 단추로 포커스가 돌아온다`, focused === "ai-personal-key-revoke", String(focused));
      } else {
        await page.getByTestId("ai-personal-issue").click();
        await page.getByTestId("ai-personal-issue-form").waitFor();
        await page.getByTestId("ai-personal-issue-holder").selectOption(seoyeon);
        await page.getByTestId("ai-personal-issue-form").getByText("Anthropic", { exact: true }).click();
        await page.getByTestId("ai-personal-issue-key").fill(SECRET);
        await page.getByTestId("ai-personal-issue-label").fill("리서치 에이전트용");
        await shot(page, `issue-dialog-${tag}`);
        check(`${tag} 발급 창 가로 넘침 0`, (await overflowX(page)) === 0);
        check(`${tag} 키 칸은 password`, (await page.getByTestId("ai-personal-issue-key").getAttribute("type")) === "password");
        await page.getByTestId("ai-personal-issue-submit").click();
        await page.waitForTimeout(600);
        const left = await page.evaluate((secret) => ({ dom: document.documentElement.outerHTML.includes(secret) }), SECRET);
        check(`${tag} 제출 뒤 DOM 어디에도 키 값 없음`, !left.dom);
        check(`${tag} 제출 뒤 키 칸 비어 있음`, (await page.getByTestId("ai-personal-issue-key").count()) === 0 || (await page.getByTestId("ai-personal-issue-key").inputValue()) === "");
      }
    } finally {
      await context.close();
    }
  }
}

async function member(browser, origin, scheme, viewport) {
  const tag = `${viewport.width}-${scheme}-member`;
  for (const mine of ["none", "one"]) {
    Object.assign(scenario, { role: "member", keys: "none", mine });
    const { context, page } = await open(browser, origin, scheme, viewport);
    try {
      await page.goto(`${origin}/#/ai/accounts`);
      await page.getByTestId("ai-my-personal-keys").waitFor();
      await page.getByTestId(mine === "none" ? "ai-my-personal-keys-empty" : "ai-my-personal-keys-list").waitFor();
      await page.evaluate(() => document.querySelector("[data-testid='ai-my-personal-keys']")?.scrollIntoView({ block: "center" }));
      await shot(page, `${mine === "none" ? "empty" : "list"}-${tag}`);
      check(`${tag} ${mine}: 문서 가로 넘침 0`, (await overflowX(page)) === 0);
      check(`${tag} ${mine}: 운영자 컨트롤(발급) 없음`, (await page.getByTestId("ai-personal-issue").count()) === 0);
      if (mine === "one") {
        await page.getByTestId("ai-my-personal-key-create-agent").click();
        await page.getByTestId("ai-my-personal-agent-form").waitFor();
        await shot(page, `create-agent-dialog-${tag}`);
        check(`${tag} 이름 기본값 곽성재-Anthropic`, (await page.getByTestId("ai-my-personal-agent-name").inputValue()) === "곽성재-Anthropic");
        check(`${tag} 에이전트 창 가로 넘침 0`, (await overflowX(page)) === 0);
        await page.getByTestId("ai-my-personal-agent-cancel").click();
        await page.getByTestId("ai-my-personal-agent-dialog").waitFor({ state: "detached" });
        await page.getByTestId("ai-my-personal-key-revoke").click();
        await page.getByTestId("ai-personal-revoke-dialog").waitFor();
        await shot(page, `revoke-confirm-${tag}`);
      }
    } finally {
      await context.close();
    }
  }
}

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) throw new Error("dist/ is missing. Run npm run build first.");
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  try {
    for (const scheme of ["light", "dark"]) {
      for (const viewport of [{ width: 1440, height: 900 }, { width: 420, height: 900 }]) {
        await operator(browser, preview.origin, scheme, viewport);
        await member(browser, preview.origin, scheme, viewport);
      }
    }
  } finally {
    await browser.close();
    await preview.stop?.();
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length}개 단언 실패`);
    process.exit(1);
  }
  console.log(`\n캡처: ${OUT_DIR}`);
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
