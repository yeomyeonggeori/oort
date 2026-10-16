#!/usr/bin/env node
// =============================================================================
// 팀 AI 키 › 「한도·남은 크레딧」 캡처 (#3887). 확인 전 · 확인 뒤(한도 헤더) · 헤더 없음 ·
// 크레딧/결제 문제 · OpenRouter · 추정 못 불러옴 · 키 추가 폼의 월 크레딧 · 비운영자.
//
//   npm run build && OUT_DIR=<dir> node scripts/capture-keys-limits.mjs
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
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/keys-limits");
const PORT = Number(process.env.CAPTURE_PORT || 5251);

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

// AIH-6: 팀 AI 키 장면이 서버 답을 바꾼다. operator=false 면 팀 키 읽기는 403, empty 면 저장된 키가 없다.
const scenario = { operator: true, empty: false, company: "anthropic", test: "none", limitsFail: false };
const openrouterLink = { ...providerLink, baseUrl: "https://openrouter.ai/api/v1", endpointLabel: "https://openrouter.ai/api/v1", bearerLast4: "a91f", format: "openai" };
const spend = (microUsd, runs, over = {}) => ({ microUsd, runs, promptTokens: runs * 1200, completionTokens: runs * 300, unpricedRuns: 0, unpricedModels: [], ...over });
const limitsBody = () => ({
  schema: "momo.provider_limits.v0", monthStartMs: Date.UTC(2026, 9, 1), computedAtMs: Date.now(),
  companies: [
    { company: "anthropic", monthlyBudgetMicroUsd: scenario.budget === null ? undefined : 100_000_000, spendEstimate: spend(32_480_000, 214, { unpricedRuns: 6, unpricedModels: ["claude-sonnet-5-6"] }) },
    { company: "openai", spendEstimate: spend(0, 0) },
    { company: "xai", spendEstimate: spend(0, 0) },
    { company: "openrouter", spendEstimate: spend(0, 0) },
  ],
});
const probeBody = () => {
  const head = { position: 0, source: "provider_link", mode: "external-hermes", endpointLabel: "x", enabled: true };
  const probe = (extra) => ({ outcome: "ok", method: "models", httpStatus: 200, latencyMs: 180, probedAtMs: Date.now(), cached: false, ...extra });
  const base = { schema: "momo.provider_link.test.v0", source: "database", mode: "external-hermes", endpointLabel: "x", checkedAtMs: Date.now(), cascadeOk: true };
  if (scenario.test === "ok")
    return { ...base, ok: true, entries: [{ ...head, ok: true, disposition: "ok", probe: probe({ modelCount: 9, rateLimit: { source: "anthropic-ratelimit", requestsLimit: 50, requestsRemaining: 49, tokensLimit: 40000, tokensRemaining: 39000 } }) }] };
  if (scenario.test === "ok-no-headers")
    return { ...base, ok: true, entries: [{ ...head, ok: true, disposition: "ok", probe: probe({ modelCount: 9 }) }] };
  if (scenario.test === "openrouter")
    return { ...base, ok: true, entries: [{ ...head, ok: true, disposition: "ok", probe: probe({ method: "key", credit: { limit: 20, limitRemaining: 12.5, usage: 7.5, usageMonthly: 2.25 }, accountCreditNeedsManagementKey: true }) }] };
  if (scenario.test === "no-credit")
    return { ...base, ok: false, reason: "provider_no_credit", cascadeOk: false, entries: [{ ...head, ok: false, reason: "provider_no_credit", disposition: "propagate", probe: probe({ outcome: "no_credit", httpStatus: 402 }) }] };
  return base;
};
const emptyLink = {
  schema: "momo.provider_link.v0", configured: false, source: "environment", mode: "local-mock",
  baseUrl: "http://mock", endpointLabel: "mock", bearerConfigured: false, availability: "mock", keyConfigured: false, diagnostics: [],
  presets: [
    { id: "anthropic", label: "Anthropic", baseUrl: "https://api.anthropic.com/v1", format: "anthropic" },
    { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", format: "openai" },
  ],
};

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function installRoutes(context, connectionsFor = connections) {
  await context.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId });
    }
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) {
      const members = scenario.operator ? roster : roster.map((m) => (m.id === memberId ? { ...m, role: "member" } : m.id === otherHuman ? { ...m, role: "owner" } : m));
      return json(route, { members });
    }
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/hosted-agent-connections")) return json(route, { connections: connectionsFor });
    if (path.endsWith("/provider/link")) {
      if (!scenario.operator) return json(route, { error: { code: "forbidden", message: "operators only" } }, 403);
      return json(route, scenario.empty ? emptyLink : scenario.company === "openrouter" ? openrouterLink : providerLink);
    }
    if (path.endsWith("/provider/link/test")) return json(route, probeBody());
    if (path.endsWith("/provider/limits")) {
      if (scenario.limitsFail) return json(route, { error: { code: "internal", message: "limits unavailable" } }, 500);
      return json(route, limitsBody());
    }
    if (path.endsWith("/provider/limits/budget")) return json(route, limitsBody());
    if (path.endsWith("/provider/default-ai")) {
      if (!scenario.operator) return json(route, { error: { code: "forbidden", message: "operators only" } }, 403);
      return json(route, { schema: "momo.provider.default_ai.v0", teamAgent: null, summary: null, guardrail: { mode: "off", available: false } });
    }
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
    if (path.endsWith(`/workspaces/${workspaceId}`)) return json(route, { workspace: { id: workspaceId, name: "여명거리", slug: "team", updatedAtMs: 1, roleLabels: {}, welcomeAgentMemberId: null, welcomePrompt: "", subscriptionAgentsEnabled: true } });
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

async function installDesktop(page, probes) {
  await page.addInitScript((probes) => {
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
      transformCallback: () => 1,
      unregisterCallback() {},
      convertFileSrc: (p) => p,
      async invoke(cmd) {
        if (cmd === "keychain_store_refresh_token") { window.__h = "shell:" + "c".repeat(32); return null; }
        if (cmd === "keychain_refresh_token_handle") return window.__h ?? null;
        if (cmd === "detect_local_harnesses") return probes;
        if (cmd === "harness_profile_list") return [];
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
  }, probes);
}

const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok) failures.push(name);
}
const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

const DEFAULT_PROBES = [{ id: "claude", installed: true, auth: "logged_in" }, { id: "codex", installed: true, auth: "needs_login" }];

async function open(browser, origin, scheme, viewport, desktop, opts = {}) {
  const context = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion: "reduce", serviceWorkers: "block" });
  await installRoutes(context, opts.connections);
  const page = await context.newPage();
  await installRealtime(page);
  if (desktop) await installDesktop(page, opts.probes ?? DEFAULT_PROBES);
  await page.addInitScript((server) => { try { localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ } }, origin);
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("nav-ai").waitFor({ timeout: 20_000 });
  return { context, page };
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

async function scenes(browser, origin, scheme, viewport) {
  const tag = `${viewport.width}-${scheme}`;
  const run = async (name, setup, body) => {
    Object.assign(scenario, { operator: true, empty: false, company: "anthropic", test: "none", limitsFail: false, budget: 1 }, setup);
    const { context, page } = await open(browser, origin, scheme, viewport, true);
    try {
      await page.goto(`${origin}/#/ai/team-keys`);
      await page.getByTestId("ai-team-keys").waitFor();
      await page.waitForTimeout(700);
      const shot = async (file) => {
        const full = await page.evaluate(() => {
          const pane = document.querySelector("[data-testid='ai-hub-route'] .overflow-y-auto");
          return pane ? pane.scrollHeight + pane.getBoundingClientRect().top + 8 : 0;
        });
        await page.setViewportSize({ width: viewport.width, height: Math.max(viewport.height, Math.ceil(full)) });
        await page.waitForTimeout(200);
        await page.screenshot({ path: resolve(OUT_DIR, `${file}-${tag}.png`) });
        await page.setViewportSize(viewport);
      };
      await body(page, shot);
      check(`${tag} ${name}: 가로 넘침 0`, (await overflowX(page)) === 0);
    } finally {
      await context.close();
    }
  };
  await run("before-check", {}, async (page, shot) => {
    await page.getByTestId("ai-link-limits-estimate").waitFor();
    await shot("keys-1-before-check");
    const block = await page.getByTestId("ai-link-limits").textContent();
    check(`${tag} 확인 전: 두 출처 이름이 보인다`, block.includes("공급사가 알려 준 숫자") && block.includes("oort 추정") && block.includes("Anthropic 전체") && block.includes("공급사 잔액이 아니에요"));
    check(`${tag} 확인 전: 월 크레딧 100 중 약 $32.48, 남은 양(추정) 약 $67.52`, block.includes("$100.00") && block.includes("약 $32.48") && block.includes("약 $67.52"), block);
    check(`${tag} 확인 전: 단가 모르는 모델을 이름으로 말한다`, block.includes("claude-sonnet-5-6"));
    check(`${tag} 확인 전: 콘솔 링크`, (await page.getByTestId("ai-link-limits-console").getAttribute("href")) === "https://platform.claude.com/settings/billing");
  });
  await run("checked", { test: "ok" }, async (page, shot) => {
    await page.getByTestId("ai-link-limits-estimate").waitFor();
    await page.getByTestId("ai-link-check").click();
    await page.getByTestId("ai-link-probe").waitFor();
    await page.waitForTimeout(400);
    await shot("keys-2-checked");
    const block = await page.getByTestId("ai-link-limits-provider").textContent();
    check(`${tag} 확인 뒤: 공급사 한도 숫자`, block.includes("50 중 49 남음") && block.includes("40,000 중 39,000 남음"), block);
    check(`${tag} 확인 뒤: 잔액을 읽을 수 없다고 말한다`, block.includes("일반 API 키로 알려 주지 않아요"));
    // 키보드로 닿아야 focus-visible 링이 그려진다(스크립트 focus()는 링을 안 그린다).
    await page.getByTestId("ai-link-limits-refresh").focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await page.screenshot({ path: resolve(OUT_DIR, `keys-2b-refresh-focus-${tag}.png`) });
  });
  await run("no-headers", { test: "ok-no-headers" }, async (page, shot) => {
    await page.getByTestId("ai-link-limits-estimate").waitFor();
    await page.getByTestId("ai-link-check").click();
    await page.getByTestId("ai-link-probe").waitFor();
    await shot("keys-3-no-headers");
    check(`${tag} 헤더 없음: 지어내지 않고 말한다`, (await page.getByTestId("ai-link-limits-provider-note").textContent()).includes("한도 숫자를 주지 않았어요"));
  });
  await run("no-credit", { test: "no-credit" }, async (page, shot) => {
    await page.getByTestId("ai-link-limits-estimate").waitFor();
    await page.getByTestId("ai-link-check").click();
    await page.getByTestId("ai-link-probe").waitFor();
    await page.waitForTimeout(400);
    await shot("keys-4-no-credit");
    check(`${tag} 크레딧 문제: 키 탓이 아니라고 말한다`, (await page.getByTestId("ai-link-probe-text").textContent()).includes("키는 맞지만 크레딧이나 결제에 문제가 있어요"));
  });
  await run("openrouter", { test: "openrouter", company: "openrouter" }, async (page, shot) => {
    await page.getByTestId("ai-link-limits").waitFor();
    await page.getByTestId("ai-link-check").click();
    await page.getByTestId("ai-link-probe").waitFor();
    await page.waitForTimeout(400);
    await shot("keys-5-openrouter");
    const block = await page.getByTestId("ai-link-limits-provider").textContent();
    check(`${tag} OpenRouter: 키의 숫자와 관리 키 안내`, block.includes("$12.50 / $20.00") && block.includes("$2.25") && block.includes("관리 키로만 읽혀요"), block);
  });
  await run("limits-error", { limitsFail: true }, async (page, shot) => {
    await page.getByTestId("ai-link-limits-estimate-pending").waitFor();
    await shot("keys-6-limits-error");
  });
  await run("add-form", { empty: true }, async (page, shot) => {
    await page.getByTestId("ai-team-add").click();
    await page.getByTestId("ai-team-keys-form").waitFor();
    await page.waitForTimeout(300);
    await shot("keys-7-add-form-anthropic");
    check(`${tag} 추가 폼: 월 크레딧 칸(선택)`, (await page.getByTestId("ai-link-budget-input").count()) === 1);
    await page.getByTestId("ai-link-preset-custom").locator("..").click();
    check(`${tag} 추가 폼: 모르는 주소에는 월 크레딧 칸이 없다`, (await page.getByTestId("ai-link-budget-input").count()) === 0);
  });
  await run("non-operator", { operator: false }, async (page) => {
    await page.getByTestId("operator-notice").waitFor();
    check(`${tag} 비운영자: 한도 블록 없음`, (await page.getByTestId("ai-link-limits").count()) === 0);
  });
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
