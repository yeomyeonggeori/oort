#!/usr/bin/env node
// =============================================================================
// GATE — 설정 › AI 연결 · 팀 연결 (#2974; 전판 U3 #1047 · ADR-0147 → #2909 개편).
//
//   npm run gate:ailink        (= npm run build && node gates/gate-ailink.mjs)
//
// 전판은 auth.json 붙여넣기 폼(ai-link-oauth-paste)을 시험했다. #2909가 그 흐름을
// 걷어낸 뒤로는 사라진 UI를 가리켰다. 이 판은 지금 화면을 잰다. 단위 시험은
// 함수만 단정할 수 있고, 이 게이트는 **배포 번들을 실제 포인터로** 민다.
//
//   ① 팀 키 넣기(TeamKeyForm)가 보내는 PUT 본문. 서버 `PutProviderLinkRequest`는
//      `deny_unknown_fields`라 낯선 키는 400이다. 그래서 「무엇이 선에 실렸나」를
//      잰다: 키 집합 ⊆ {baseUrl, bearer, mode, format}, `oauth` 없음, 프리셋 형식.
//   ② 넣은 키가 저장 뒤 DOM(글자·입력값·속성)과 접근성 트리 어디에도 없다
//      (ADR-0004 Rules #2/#5). 입력 칸은 password 형이다.
//   ③ 레거시 oauth-openai 연결은 읽기 전용이다: 「확인」·「키 바꾸기」가 없고,
//      auth.json을 붙일 칸(textarea)이 화면 어디에도 없다.
//   ④ 「연결 확인」 결과 칸(#2975): #2960 사유가 기본 갈래(「서버 사유」)로 떨어지지
//      않고, provider 숫자 줄은 숫자가 있을 때만 선다.
//
// 서버는 라우트 층에서 대역한다. 라이브 인스턴스·로컬 스택을 쓰지 않는다.
// =============================================================================

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "./preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.AILINK_GATE_PORT || 5186);
const origin = `http://127.0.0.1:${port}`;
const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "019f94e3-7a10-79cd-9dee-208f47edd9a8";

const session = {
  accessToken: "gate-only-not-a-credential",
  refreshToken: "gate-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: "ws://ailink-gate.invalid/connection/websocket",
};

// 이 게이트가 지어낸 값. 화면에 한 번도 나오면 안 된다.
const FAKE_KEY = "gate-ailink-not-a-key-7f3c9e21d4b8a6";
const DECLARED_PUT_KEYS = new Set(["baseUrl", "bearer", "mode", "format"]);

const PRESETS = [
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", format: "openai" },
  { id: "anthropic", label: "Anthropic (Claude)", baseUrl: "https://api.anthropic.com/v1", format: "anthropic" },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", format: "openai" },
];
const KEY_LINK = {
  schema: "momo.provider_link.v0", configured: true, source: "database", mode: "external-hermes",
  baseUrl: "https://api.anthropic.com/v1", endpointLabel: "Anthropic", bearerConfigured: true,
  bearerLast4: FAKE_KEY.slice(-4), availability: "live", keyConfigured: true, updatedAtMs: Date.now() - 86_400_000,
  diagnostics: [], credentialKind: "anthropic-key", format: "anthropic", presets: PRESETS,
};
const EMPTY_LINK = {
  schema: "momo.provider_link.v0", configured: false, source: "environment", mode: "local-mock",
  baseUrl: "http://mock", endpointLabel: "mock", bearerConfigured: false, availability: "mock",
  keyConfigured: false, diagnostics: [], presets: PRESETS,
};
const LEGACY_LINK = {
  ...KEY_LINK, baseUrl: "https://chatgpt.com/backend-api/codex", endpointLabel: "ChatGPT",
  credentialKind: "oauth-openai", format: undefined,
};

const test = (ok, reason, entryProbe) => ({
  schema: "momo.provider_link.test.v0", ok, reason, source: "database", mode: "external-hermes",
  endpointLabel: "Anthropic", checkedAtMs: Date.now(),
  ...(entryProbe
    ? {
        cascadeOk: ok,
        entries: [
          {
            position: 0, source: "provider_link", mode: "external-hermes", endpointLabel: "Anthropic",
            enabled: true, ok, reason, disposition: ok ? "ok" : "propagate",
            probe: { method: "models", latencyMs: 140, probedAtMs: Date.now(), cached: false, ...entryProbe },
          },
        ],
      }
    : {}),
});

function fail(message) {
  throw new Error(`GATE FAIL: ${message}`);
}

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function installRealtimeSocket(page) {
  await page.addInitScript(() => {
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
          if (command.connect) replies.push({ id: command.id, connect: { client: "ailink-gate", version: "6" } });
          else if (command.subscribe)
            replies.push({
              id: command.id,
              subscribe: { recoverable: true, positioned: true, recovered: true, epoch: "ailink-gate", offset: 0 },
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

/** 팀 연결 대역. `state.puts`에 PUT 본문 원문을 모은다. */
async function installRoutes(context, state) {
  await context.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === "/v1/auth/login") return json(route, session);
    if (path === "/v1/auth/realtime-token")
      return json(route, {
        token: "gate-realtime-token", tokenType: "Bearer", expiresAtMs: Date.now() + 60_000,
        ttlSeconds: 60, workspaceId, memberId,
      });
    if (path === "/v1/auth/refresh")
      return json(route, { accessToken: session.accessToken, refreshToken: session.refreshToken });
    if (path.endsWith("/roster"))
      return json(route, {
        members: [
          {
            id: memberId, workspaceId, kind: "human", role: "owner", status: "active", displayName: "곽성재",
            handle: "seongjae", channelCount: 0, channelIds: [], capabilities: [], createdAtMs: 0, updatedAtMs: 0,
          },
        ],
      });
    if (path.startsWith("/v1/provider/link")) {
      if (path.endsWith("/test")) return json(route, { ...state.test, checkedAtMs: Date.now() });
      if (path.endsWith("/chain")) return json(route, { error: { code: "not_found", message: "none" } }, 404);
      if (request.method() === "PUT") {
        state.puts.push(request.postData() ?? "");
        state.link = KEY_LINK;
      }
      return json(route, state.link);
    }
    if (path.endsWith("/channels")) return json(route, { channels: [] });
    if (path.endsWith("/hosted-agent-connections")) return json(route, { connections: [] });
    if (/\/v1\/workspaces\/[^/]+$/.test(path))
      return json(route, {
        id: workspaceId, slug: "yeomyeong", name: "여명거리", updatedAtMs: 1, roleLabels: {},
        welcomeAgentMemberId: null, welcomePrompt: "", subscriptionAgentsEnabled: true,
      });
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-sessions")) return json(route, { sessions: [] });
    if (path.endsWith("/messages")) return json(route, { messages: [] });
    return json(route, {});
  });
}

async function openAiPage(browser, state) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  await installRealtimeSocket(page);
  await installRoutes(context, state);
  await page.goto(origin, { waitUntil: "networkidle" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("ailink@example.test");
  await page.getByTestId("login-password").fill("gate-only");
  await page.getByTestId("login-submit").click();
  await page.waitForFunction(() => !location.hash.includes("login"), undefined, { timeout: 15_000 });
  await page.evaluate(() => {
    window.location.hash = "/settings?section=ai&aiEntry=rows";
  });
  await page.getByTestId("ai-page").waitFor({ timeout: 15_000 });
  return { context, page };
}

/** ② 글자·입력값·속성 어디에도 키가 없다. */
async function assertKeyNowhereInDom(page, when) {
  const hit = await page.evaluate((needle) => {
    if (document.body.innerText.includes(needle)) return "text";
    for (const el of document.querySelectorAll("*")) {
      if ("value" in el && typeof el.value === "string" && el.value.includes(needle)) return `value of <${el.tagName}>`;
      for (const attr of el.attributes) if (attr.value.includes(needle)) return `attribute ${attr.name}`;
    }
    return null;
  }, FAKE_KEY.slice(0, 20));
  if (hit) fail(`${when}: the key is in the DOM (${hit})`);
}

async function assertKeyNotInAxTree(context, page, when) {
  const cdp = await context.newCDPSession(page);
  const { nodes } = await cdp.send("Accessibility.getFullAXTree");
  await cdp.detach();
  const leak = nodes.some((node) =>
    [node.name?.value, node.value?.value, node.description?.value].some(
      (text) => typeof text === "string" && text.includes(FAKE_KEY.slice(0, 20))
    )
  );
  if (leak) fail(`${when}: the key is in the accessibility tree`);
}

/** ①② 팀 키 넣기 → 저장하고 확인. */
async function addKey(browser) {
  const state = { link: EMPTY_LINK, puts: [], test: test(true, undefined, { outcome: "ok", modelCount: 6 }) };
  const { context, page } = await openAiPage(browser, state);
  await page.getByTestId("ai-team-add").click();
  await page.getByTestId("ai-link-key-form").waitFor();
  await page.getByTestId("ai-link-key-form").getByText("Anthropic (Claude)").click();
  if (!(await page.getByTestId("ai-link-preset-anthropic").isChecked())) fail("the Anthropic preset did not take");
  const input = page.getByTestId("ai-link-key-input");
  if ((await input.getAttribute("type")) !== "password") fail("the key box is not type=password");
  await input.fill(FAKE_KEY);
  await page.getByTestId("ai-link-key-save").click();
  await page.getByTestId("ai-link-probe").waitFor({ timeout: 10_000 });

  if (state.puts.length !== 1) fail(`expected exactly one PUT, saw ${state.puts.length}`);
  const body = JSON.parse(state.puts[0]);
  const stray = Object.keys(body).filter((key) => !DECLARED_PUT_KEYS.has(key));
  if (stray.length > 0) fail(`PUT carries undeclared keys ${JSON.stringify(stray)} (deny_unknown_fields → 400)`);
  if ("oauth" in body) fail("PUT carries an oauth object; the paste flow was removed in #2909");
  if (body.bearer !== FAKE_KEY) fail("PUT did not carry the typed key as bearer");
  if (body.baseUrl !== "https://api.anthropic.com/v1" || body.format !== "anthropic") {
    fail(`the Anthropic preset sent ${JSON.stringify({ baseUrl: body.baseUrl, format: body.format })}`);
  }
  if (body.mode !== "external-hermes") fail(`PUT mode ${JSON.stringify(body.mode)}`);

  await assertKeyNowhereInDom(page, "after save");
  await assertKeyNotInAxTree(context, page, "after save");
  await context.close();
}

/** ③ 레거시 oauth-openai 연결은 읽기 전용이다. */
async function legacyReadOnly(browser) {
  const state = { link: LEGACY_LINK, puts: [], test: test(false, "probe_not_run") };
  const { context, page } = await openAiPage(browser, state);
  const row = page.getByTestId("ai-link-row");
  await row.waitFor();
  if (!((await row.textContent()) ?? "").includes("읽기 전용")) fail("the legacy row does not say 읽기 전용");
  await page.getByTestId("ai-link-row-more").click();
  await page.getByTestId("ai-team-aside").waitFor();
  await page.getByTestId("ai-link-legacy-note").waitFor();
  for (const id of ["ai-link-check", "ai-link-edit", "ai-link-oauth-paste"]) {
    if ((await page.getByTestId(id).count()) > 0) fail(`the legacy link offers ${id}`);
  }
  if ((await page.locator("textarea").count()) > 0) fail("a textarea is on the AI page (auth.json paste box is back)");
  if (state.puts.length > 0) fail("opening a legacy link wrote to the server");
  await context.close();
}

/** ④ 「연결 확인」 결과 칸(#2975). */
const CHECKS = [
  { name: "egress", test: test(false, "provider_egress_denied", { outcome: "unreachable" }), tone: "bad", mustSay: "AGENT_PROVIDER_LOCAL_HOSTS", detail: null },
  { name: "invalid", test: test(false, "provider_invalid_response", { outcome: "unknown", httpStatus: 200 }), tone: "bad", mustSay: "API가 아닌", detail: null },
  { name: "auth", test: test(false, "provider_auth_failed", { outcome: "rejected", httpStatus: 401 }), tone: "bad", mustSay: "새 키를 넣어", detail: null },
  { name: "rate", test: test(false, "provider_rate_limited", { outcome: "rate_limited", httpStatus: 429, retryAfterSeconds: 30 }), tone: "bad", mustSay: "30초 뒤", detail: null },
  { name: "ok-silent", test: test(true, undefined, { outcome: "ok", httpStatus: 200 }), tone: "ok", mustSay: "응답을 확인했어요", detail: null },
  {
    name: "ok-numbers",
    test: test(true, undefined, {
      outcome: "ok", method: "key", httpStatus: 200, modelCount: 6,
      rateLimit: { source: "x-ratelimit", requestsLimit: 50, requestsRemaining: 49 },
      credit: { limit: 20, limitRemaining: 12.5, usage: 7.5 },
    }),
    tone: "ok",
    mustSay: "응답을 확인했어요",
    detail: "쓸 수 있는 모델 6개 · 요청 한도 50 중 49 남음 · 남은 크레딧 12.5 / 20 · 쓴 크레딧 7.5",
  },
];

async function checkResults(browser) {
  for (const check of CHECKS) {
    const state = { link: KEY_LINK, puts: [], test: check.test };
    const { context, page } = await openAiPage(browser, state);
    await page.getByTestId("ai-link-row-more").click();
    await page.getByTestId("ai-link-check").click();
    const box = page.getByTestId("ai-link-probe");
    await box.waitFor({ timeout: 10_000 });
    const tone = await box.getAttribute("data-tone");
    const text = (await page.getByTestId("ai-link-probe-text").textContent()) ?? "";
    if (tone !== check.tone) fail(`[${check.name}] tone ${tone}, expected ${check.tone}`);
    if (/서버 사유|서버가 보고한 사유/.test(text)) fail(`[${check.name}] fell to the default branch: ${text}`);
    if (!text.includes(check.mustSay)) fail(`[${check.name}] result does not say ${JSON.stringify(check.mustSay)}: ${text}`);
    const detail = page.getByTestId("ai-link-probe-detail");
    const detailCount = await detail.count();
    if (check.detail === null && detailCount > 0) {
      fail(`[${check.name}] drew a numbers line with nothing to show: ${await detail.textContent()}`);
    }
    if (check.detail !== null && (await detail.textContent()) !== check.detail) {
      fail(`[${check.name}] numbers line ${JSON.stringify(detailCount ? await detail.textContent() : null)}`);
    }
    console.log(`[ailink] ${check.name}: ${text}${check.detail ? ` | ${check.detail}` : ""}`);
    await context.close();
  }
}

async function main() {
  if (!existsSync(resolve(webRoot, "dist/index.html"))) fail("dist/ is missing. Run npm run build first.");
  const server = await startGuardedPreview({ webRoot, port, portEnvVar: "AILINK_GATE_PORT" });
  try {
    const browser = await chromium.launch();
    try {
      await addKey(browser);
      await legacyReadOnly(browser);
      await checkResults(browser);
    } finally {
      await browser.close();
    }
  } finally {
    await server.stop();
  }
  console.log("GATE PASS: the team key PUT carries only declared keys (no oauth); the key never");
  console.log("           reaches the DOM or AX tree after save; a legacy oauth link is read-only");
  console.log("           with no paste box; check results say the #2960 reasons in words and draw");
  console.log("           the numbers line only when the provider stated numbers.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
