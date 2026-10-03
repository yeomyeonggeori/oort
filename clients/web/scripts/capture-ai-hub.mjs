#!/usr/bin/env node
// =============================================================================
// 「AI」 허브 입구 캡처 (AIH-3, #3393): 사이드바 AI 행, 허브 개요(웹·데스크탑), 네 구획 머리,
// 옛 입구(설정 › AI 연결·에이전트 화면)의 「AI 허브로 옮겼어요」 한 줄.
//
//   npm run build && OUT_DIR=~/.cache/momo-scratch/3393/captures node scripts/capture-ai-hub.mjs
//
// 백엔드는 없다: `/v1/**`는 고정 응답이고 실시간 소켓은 곧바로 연결되는 흉내다. 데스크탑은
// `window.__TAURI_INTERNALS__` 흉내(감지: Claude Code 준비됨, Codex 로그인 필요)다.
// 라이트·다크 × 1440×900·900×700.
// =============================================================================

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/ai-hub");
const PORT = Number(process.env.CAPTURE_PORT || 5231);

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const channels = [
  { id: "00000000-0000-7000-8000-000000000201", workspaceId, kind: "public", name: "general", muted: false },
  { id: "00000000-0000-7000-8000-000000000202", workspaceId, kind: "public", name: "agent-lab", muted: false },
];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: "ws://ai-hub-capture.invalid/connection/websocket",
};
const ids = { mine: "00000000-0000-7000-8000-000000000301", team: "00000000-0000-7000-8000-000000000302", ext: "00000000-0000-7000-8000-000000000303", other: "00000000-0000-7000-8000-000000000304" };
const otherHuman = "00000000-0000-7000-8000-000000000102";
const agent = (id, displayName, handle, owner) => ({
  id, workspaceId, kind: "agent", status: "active", displayName, handle, channelCount: 2,
  channelIds: channels.map((c) => c.id), capabilities: [], ownerHumanId: owner, createdAtMs: 0, updatedAtMs: 0,
});
const roster = [
  agent(ids.mine, "성재-claude", "seongjae-claude", memberId),
  agent(ids.team, "김인턴", "kim-intern", memberId),
  agent(ids.ext, "그록봇", "grokbot", memberId),
  agent(ids.other, "서연-codex", "seoyeon-codex", otherHuman),
  { id: memberId, workspaceId, kind: "human", status: "active", role: "owner", displayName: "곽성재", handle: "seongjae", channelCount: 2, channelIds: channels.map((c) => c.id), capabilities: [], createdAtMs: 0, updatedAtMs: 0 },
  { id: otherHuman, workspaceId, kind: "human", status: "active", role: "member", displayName: "서연", handle: "seoyeon", channelCount: 2, channelIds: channels.map((c) => c.id), capabilities: [], createdAtMs: 0, updatedAtMs: 0 },
];
const conn = (n, agentMemberId, extra) => ({
  id: `c-${n}`, agentMemberId, status: "active", authMode: "bearer", audience: "oort", approvedChannelIds: [], approvedScopes: [],
  createdAtMs: n, updatedAtMs: n, ...extra,
});
const connections = [
  conn(1, ids.mine, { invocationScope: "owner_only", subscriptionHarness: "claude_code" }),
  conn(2, ids.other, { invocationScope: "owner_only", subscriptionHarness: "codex" }),
  conn(3, ids.ext, { invocationScope: "workspace" }),
];
const providerLink = {
  schema: "momo.provider_link.v0", configured: true, source: "database", mode: "external-hermes",
  baseUrl: "https://api.anthropic.com/v1", endpointLabel: "https://api.anthropic.com/v1", bearerConfigured: true,
  bearerLast4: "7c1e", availability: "live", keyConfigured: true, format: "anthropic", updatedAtMs: 1_790_000_000_000, diagnostics: [],
};
const plugins = {
  plugins: ["github", "linear"].map((id) => ({
    pluginId: id, name: id, version: "1.0.0", description: "연동", official: true, recommended: false,
    egressDomains: [], recommendedFor: [], installed: true, enabled: true,
  })),
};

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function installRoutes(context) {
  await context.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId });
    }
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/hosted-agent-connections")) return json(route, { connections });
    if (path.endsWith("/provider/link")) return json(route, providerLink);
    if (path.endsWith("/provider/default-ai")) return json(route, { schema: "momo.provider.default_ai.v0", teamAgent: null, summary: null, guardrail: { mode: "off", available: false } });
    if (path.includes("/provider/link/chain")) return json(route, { error: { code: "not_found", message: "no chain" } }, 404);
    if (path.endsWith("/webhooks")) {
      return json(route, { installations: [{ id: "w1", channelId: channels[0].id, authorMemberId: memberId, mode: "native", status: "active", createdAtMs: 1, updatedAtMs: 1 }] });
    }
    if (path.endsWith("/event-subscriptions")) {
      return json(route, { eventSubscriptions: [1, 2].map((n) => ({ id: `e${n}`, workspaceId, url: `https://hooks.example.com/${n}`, eventKinds: ["message.created"], enabled: true, deliveryFailureCount: 0, createdAtMs: n, updatedAtMs: n })) });
    }
    if (path.endsWith("/plugins")) return json(route, plugins);
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: [] });
    if (path.endsWith("/work-sessions/shared")) return json(route, { sessions: [], nextCursor: null });
    if (path.endsWith("/work-sessions")) return json(route, { workSessions: [] });
    if (path.endsWith(`/workspaces/${workspaceId}`)) return json(route, { workspace: { id: workspaceId, name: "여명거리" } });
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
          if (c.connect) return { id: c.id, connect: { client: "ai-hub-capture", version: "6" } };
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

async function installDesktop(page) {
  await page.addInitScript(() => {
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
      transformCallback: () => 1,
      unregisterCallback() {},
      convertFileSrc: (p) => p,
      async invoke(cmd) {
        if (cmd === "keychain_store_refresh_token") { window.__h = "shell:" + "c".repeat(32); return null; }
        if (cmd === "keychain_refresh_token_handle") return window.__h ?? null;
        if (cmd === "detect_local_harnesses") return [{ id: "claude", installed: true, auth: "logged_in" }, { id: "codex", installed: true, auth: "needs_login" }];
        if (cmd === "detect_hosted_agents") return [];
        if (cmd === "keychain_available") return false;
        if (cmd === "deep_link_take_pending") return [];
        if (cmd === "app_version") return "0.1.17";
        if (cmd === "notification_permission") return "denied";
        if (cmd === "updater_check") return null;
        if (cmd.startsWith("plugin:event|")) return 1;
        return null;
      },
    };
  });
}

const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok) failures.push(name);
}
const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function open(browser, origin, scheme, viewport, desktop) {
  const context = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion: "reduce", serviceWorkers: "block" });
  await installRoutes(context);
  const page = await context.newPage();
  await installRealtime(page);
  if (desktop) await installDesktop(page);
  await page.addInitScript((server) => { try { localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ } }, origin);
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("nav-ai").waitFor({ timeout: 20_000 });
  return { context, page };
}

async function scenes(browser, origin, scheme, viewport) {
  const tag = `${viewport.width}-${scheme}`;
  for (const desktop of [true, false]) {
    const kind = desktop ? "desktop" : "web";
    const { context, page } = await open(browser, origin, scheme, viewport, desktop);
    const shot = (name) => page.screenshot({ path: resolve(OUT_DIR, `${name}-${tag}.png`) });
    // 좁은 창은 폭 규칙으로 목록 열이 접혀 있다: 사람이 펴는 길(제목줄 단추)로 편다.
    if ((await page.getByTestId("sidebar-toggle").getAttribute("aria-expanded")) === "false") {
      await page.getByTestId("sidebar-toggle").click();
      await page.waitForTimeout(400);
    }
    // 사이드바: AI 행이 구획 맨 위, 에이전트 행도 그대로.
    if (desktop) {
      await page.getByTestId("sidebar-list-head").screenshot({ path: resolve(OUT_DIR, `sidebar-ai-row-${tag}.png`) });
      const rows = await page.locator("[data-testid='sidebar-section-agent-work'] a").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
      check(`${tag} 사이드바: 「에이전트·작업」 맨 위 AI, 에이전트 행 유지`, rows[0] === "nav-ai" && rows[1] === "nav-agents", JSON.stringify(rows));
    }
    await page.getByTestId("nav-ai").click();
    await page.getByTestId("ai-hub-overview").waitFor();
    await page.waitForFunction(() => !document.querySelector("[data-testid='ai-hub-overview']")?.textContent?.includes("확인하는 중"), null, { timeout: 8000 });
    await page.waitForTimeout(300);
    await shot(`overview-${kind}`);
    const cards = await page.locator("[data-testid^='ai-hub-card-']").evaluateAll((els) => els.map((e) => e.textContent));
    check(`${tag} ${kind} 개요: 카드 넷`, cards.length === 4);
    if (desktop) {
      check(`${tag} 데스크탑 개요: 감지 결과 그대로(Claude Code 준비됨 · Codex 로그인 필요)`, cards[0].includes("Claude Code 준비됨") && cards[0].includes("Codex 로그인 필요"), cards[0]);
      check(`${tag} 개요: 팀 키는 서버 값(Anthropic 연결됨)`, cards[1].includes("Anthropic 연결됨"), cards[1]);
      check(`${tag} 개요: 에이전트 4명 · 나만 부름 2 · 모두 부름 2`, cards[2].includes("4명") && cards[2].includes("나만 부름 2") && cards[2].includes("모두 부름 2") && !cards[2].includes("맥 꺼짐"), cards[2]);
      check(`${tag} 개요: 외부 연결 수는 목록 길이`, cards[3].includes("앱 2") && cards[3].includes("채널로 들어오는 주소 1") && cards[3].includes("밖으로 보내는 알림 2") && cards[3].includes("외부 에이전트 연결 1") && cards[3].includes("6개"), cards[3]);
    } else {
      check(`${tag} 웹 개요: 로그인은 데스크탑에서 한다고 말한다`, cards[0].includes("로그인은 데스크탑 앱에서 해요"), cards[0]);
    }
    check(`${tag} ${kind} 개요: 가로 넘침 0`, (await overflowX(page)) === 0);
    check(`${tag} ${kind} 개요: 사이드바 AI 행이 현재`, (await page.getByTestId("nav-ai").getAttribute("aria-current")) === "page");
    if (desktop) {
      for (const [id, testId, label] of [["accounts", "ai-hub-pane-accounts", "내 AI 계정"], ["team-keys", "ai-hub-pane-teamKeys", "팀 AI 키"], ["agents", "ai-hub-pane-agents", "에이전트"], ["external", "ai-hub-pane-external", "외부 연결"]]) {
        await page.goto(`${origin}/#/ai/${id}`);
        await page.getByTestId(testId).waitFor();
        await page.waitForTimeout(500);
        await shot(`route-${id}`);
        const h2 = await page.getByTestId(testId).locator("h2").first().textContent();
        check(`${tag} /ai/${id}: 머리 = ${label}`, h2 === label, String(h2));
        check(`${tag} /ai/${id}: 탭 현재`, (await page.locator("[data-testid='ai-hub-tabs'] [aria-current='page']").textContent()) === label);
        check(`${tag} /ai/${id}: 가로 넘침 0`, (await overflowX(page)) === 0);
      }
      // 옛 입구: 설정 › AI 연결 위의 한 줄, 누르면 허브.
      await page.goto(`${origin}/#/settings?section=ai`);
      await page.getByTestId("ai-hub-moved-link").waitFor();
      await page.waitForTimeout(500);
      await shot("old-settings-ai");
      await page.getByTestId("ai-hub-moved-link").locator("a").click();
      await page.getByTestId("ai-hub-pane-accounts").waitFor();
      check(`${tag} 설정 › AI 연결 → 허브 내 AI 계정`, page.url().endsWith("#/ai/accounts"), page.url());
      await page.goto(`${origin}/#/settings?section=webhooks`);
      await page.getByTestId("ai-hub-moved-link").waitFor();
      await shot("old-settings-webhooks");
      await page.goto(`${origin}/#/agents`);
      await page.getByTestId("agent-hub-to-ai").waitFor();
      await page.waitForTimeout(500);
      await shot("old-agents-header");
      await page.getByTestId("agent-hub-to-ai").click();
      await page.getByTestId("ai-hub-overview").waitFor();
      check(`${tag} 에이전트 화면 → 허브 개요`, page.url().endsWith("#/ai"), page.url());
      // ⌘K
      await page.keyboard.press("Meta+KeyK");
      await page.getByTestId("quick-switcher").waitFor();
      await page.locator("[cmdk-input]").fill("AI");
      await page.waitForTimeout(500);
      await shot("palette-ai");
      const palette = await page.locator("[cmdk-item]").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
      check(`${tag} ⌘K: 허브 줄 다섯`, ["switcher-ai", "switcher-ai-accounts", "switcher-ai-teamKeys", "switcher-ai-agents", "switcher-ai-external"].every((t) => palette.includes(t)), JSON.stringify(palette));
    }
    await context.close();
  }
}

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) throw new Error("dist/ is missing. Run npm run build first.");
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  try {
    for (const scheme of ["light", "dark"]) {
      for (const viewport of [{ width: 1440, height: 900 }, { width: 900, height: 700 }]) {
        await scenes(browser, preview.origin, scheme, viewport);
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
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
