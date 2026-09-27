#!/usr/bin/env node
// =============================================================================
// 설정 › AI 연결 팀 연결 캡처 (#2880 AA-7, 시안 claudedocs/ai-accounts/mockups.html
// §3 팀 키 끊기 · §4 2b API 키 추가).
//
//   npm run build:design && node scripts/capture-ai-team-link.mjs
//
// 실제 design 번들의 설정 › AI 연결에서 팀 연결 흐름을 네트워크 대역으로 민다:
// 프리셋 추가 폼 · 직접 주소 · 저장하고 확인(지금 서버 probe_not_run) · #2960 모양의
// 확인 결과 · 연결 끊기 영향 창. 라이트·다크 × 1280·390 → captures/2880/*.png
//
// 모든 장면에서 접근성 트리에 가짜 키 글자가 이름·값으로 나오면 실패한다.
// =============================================================================

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.TEAM_LINK_CAPTURE_PORT || 5241);
const origin = `http://127.0.0.1:${port}`;

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const peerId = "00000000-0000-7000-8000-000000000102";
const agentId = "00000000-0000-7000-8000-000000000103";
const internId = "00000000-0000-7000-8000-000000000104";
const hostedId = "00000000-0000-7000-8000-000000000105";
const channelB = "00000000-0000-7000-8000-000000000202";
const channelA = "00000000-0000-7000-8000-000000000201";


const session = {
  accessToken: "gate-only-not-a-credential",
  refreshToken: "gate-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: "ws://slash-gate.invalid/connection/websocket",
};

function member(over) {
  return {
    workspaceId,
    status: "active",
    role: "member",
    channelCount: 1,
    channelIds: [channelA],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  };
}

const roster = [
  member({ id: memberId, kind: "human", role: "owner", displayName: "곽성재", handle: "seongjae" }),
  member({ id: peerId, kind: "human", displayName: "김하늘", handle: "haneul" }),
  member({
    id: agentId,
    kind: "agent",
    displayName: "hermes",
    handle: "hermes",
    ownerHumanId: memberId,
    agentModel: "hermes-agent",
  }),
  member({ id: internId, kind: "agent", displayName: "김인턴", handle: "intern", channelIds: [channelB] }),
  // 호스티드(자기 맥의 구독으로 도는) 에이전트: 팀 키를 쓰지 않으니 끊기 목록에 없다.
  member({ id: hostedId, kind: "agent", displayName: "성재의 Claude", handle: "sj-claude" }),
];

const channels = [
  { id: channelA, workspaceId, kind: "public", name: "리서치", muted: false },
  { id: channelB, workspaceId, kind: "public", name: "전체", muted: false },
];

function todayAt(hour, minute) {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

function row(over) {
  return { channelId: channelA, hlcCount: 0, type: "text", state: "sent", ...over, hlcTs: over.createdAtMs };
}

/** 장면마다 바꾸는 대역 상태(장면은 차례로 돈다). */
const sceneState = { extraAgents: [], hostedDenied: false };

const messages = [
  row({
    id: "0199dddd-0000-7000-8000-000000000001",
    seq: 10,
    authorMemberId: peerId,
    body: "hermes가 오늘 아침부터 대답을 안 하네요. 연결이 끊긴 건가요?",
    createdAtMs: todayAt(15, 31),
  }),
  row({
    id: "0199dddd-0000-7000-8000-000000000002",
    seq: 11,
    authorMemberId: memberId,
    body: "제 맥 쪽 구독부터 확인해 볼게요.",
    createdAtMs: todayAt(15, 38),
  }),
];

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

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

/** POST /messages 본문을 모은다. 이 게이트의 「전송했는가」의 정본이다. */
async function installRoutes(context, posted, team) {
  await context.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === "/v1/auth/login") return json(route, session);
    if (path === "/v1/auth/realtime-token")
      return json(route, {
        token: "gate-realtime-token",
        tokenType: "Bearer",
        expiresAtMs: Date.now() + 60_000,
        ttlSeconds: 60,
        workspaceId,
        memberId,
      });
    if (path === "/v1/auth/refresh")
      return json(route, { accessToken: session.accessToken, refreshToken: session.refreshToken });
    if (path.endsWith("/roster")) return json(route, { members: [...roster, ...sceneState.extraAgents] });
    // 팀 연결은 운영자만(#2944 카드의 팀 절). 이 게이트는 입구만 잰다.
    if (path.startsWith("/v1/provider/link")) return team(route, request, path);
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/hosted-agent-connections") && sceneState.hostedDenied)
      return json(route, { error: { code: "forbidden", message: "owner or admin required" } }, 403);
    if (path.endsWith("/hosted-agent-connections"))
      return json(route, {
        connections: [
          {
            id: "0199eeee-0000-7000-8000-000000000001", agentMemberId: hostedId, status: "active",
            authMode: "bearer", audience: "oort", approvedChannelIds: [], approvedScopes: [],
            createdAtMs: 1, updatedAtMs: 1,
          },
        ],
      });
    if (/\/v1\/workspaces\/[^/]+$/.test(path))
      return json(route, {
        id: workspaceId, slug: "yeomyeong", name: "여명거리", updatedAtMs: 1, roleLabels: {},
        welcomeAgentMemberId: null, welcomePrompt: "", subscriptionAgentsEnabled: true,
      });
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-sessions")) return json(route, { sessions: [] });
    if (path.endsWith("/messages")) {
      if (request.method() === "POST") {
        const body = JSON.parse(request.postData() ?? "{}");
        posted.push(body.body);
        return json(
          route,
          row({ id: "0199dddd-0000-7000-8000-0000000000f1", seq: 12, authorMemberId: memberId, body: body.body, createdAtMs: Date.now() })
        );
      }
      if (url.searchParams.has("after") || url.searchParams.has("before")) return json(route, { messages: [] });
      return json(route, { messages });
    }
    return json(route, {});
  });
}

async function login(page) {
  await page.goto(origin, { waitUntil: "networkidle" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("slash@example.test");
  await page.getByTestId("login-password").fill("gate-only");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-item").first().waitFor();
}

const PRESETS = [
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", format: "openai" },
  { id: "anthropic", label: "Anthropic (Claude)", baseUrl: "https://api.anthropic.com/v1", format: "anthropic" },
  { id: "xai", label: "xAI (Grok)", baseUrl: "https://api.x.ai/v1", format: "openai" },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", format: "openai" },
];
const KEY_LINK = {
  schema: "momo.provider_link.v0", configured: true, source: "database", mode: "external-hermes",
  baseUrl: "https://api.anthropic.com/v1", endpointLabel: "Anthropic", bearerConfigured: true,
  bearerLast4: "7c1e", availability: "live", keyConfigured: true, updatedAtMs: Date.now() - 3 * 86_400_000,
  diagnostics: [], credentialKind: "anthropic-key", presets: PRESETS,
};
const EMPTY_LINK = {
  schema: "momo.provider_link.v0", configured: false, source: "environment", mode: "local-mock",
  baseUrl: "http://mock", endpointLabel: "mock", bearerConfigured: false, availability: "mock",
  keyConfigured: false, diagnostics: [], presets: PRESETS,
};
const FAKE_KEY = "capture-only-not-a-key-000000000000";
const probe = (ok, reason) => ({
  schema: "momo.provider_link.test.v0", ok, reason, source: "database", mode: "external-hermes",
  endpointLabel: "Anthropic", checkedAtMs: Date.now(),
});

/** 팀 연결 대역. PUT 뒤로는 저장된 링크를 답한다. */
function teamRoute({ link = KEY_LINK, test = probe(false, "probe_not_run") } = {}) {
  let current = link;
  return async (route, request, path) => {
    if (path.endsWith("/test")) return json(route, { ...test, checkedAtMs: Date.now() });
    if (path.endsWith("/chain")) return json(route, { error: { code: "not_found", message: "none" } }, 404);
    if (request.method() === "PUT") {
      current = KEY_LINK;
      return json(route, current);
    }
    return json(route, current);
  };
}

/** #2960 모양의 성공 확인(entries[0].probe). 서버 머지 전이라 runtime-unverified. */
const PROBE_2960 = {
  ...probe(true),
  cascadeOk: true,
  entries: [
    {
      position: 0, source: "database", mode: "external-hermes", endpointLabel: "Anthropic", enabled: true,
      ok: true, disposition: "ok",
      probe: {
        outcome: "ok", method: "models", httpStatus: 200, latencyMs: 212, modelCount: 6,
        rateLimit: { source: "anthropic-ratelimit", requestsLimit: 50, requestsRemaining: 49 },
        probedAtMs: Date.now(), cached: false,
      },
    },
  ],
};

/** #2960 모양의 확인 한 벌(entries[0].probe). #2972가 track/uxui에 오기 전이라 OpenAPI 모양 대역. */
function probeWith(ok, reason, detail) {
  return {
    ...probe(ok, reason),
    cascadeOk: ok,
    entries: [
      {
        position: 0, source: "provider_link", mode: "external-hermes", endpointLabel: "Anthropic", enabled: true,
        ok, reason, disposition: ok ? "ok" : "propagate",
        probe: { method: "models", latencyMs: 180, probedAtMs: Date.now(), cached: false, ...detail },
      },
    ],
  };
}

const outDir = resolve(webRoot, process.env.CAPTURE_OUT || "captures/2880");

async function scene(browser, { width, scheme, name, team, run, setup }) {
  sceneState.extraAgents = [];
  sceneState.hostedDenied = false;
  setup?.();
  const height = width === 390 ? 844 : 820;
  const context = await browser.newContext({
    viewport: { width, height },
    reducedMotion: "reduce",
    colorScheme: scheme,
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  await installRealtimeSocket(page);
  await installRoutes(context, [], team);
  await login(page);
  await page.evaluate(() => {
    window.location.hash = "/settings?section=ai&aiEntry=rows";
  });
  await page.getByTestId("ai-page").waitFor({ timeout: 15_000 });
  await wait(300);
  const target = await run(page);
  await assertNoKeyInAxTree(context, page, name);
  await page.mouse.move(0, 0);
  await wait(300);
  const path = resolve(outDir, `${name}-${width}-${scheme}.png`);
  if (target === "dialog") {
    await page.screenshot({ path });
  } else {
    // 곁판이 좁은 폭에서는 절 밑에 쌓인다: 장면의 끝(결과 칸·저장 버튼)이 보이게
    // 내려서 창 그대로 찍는다.
    const end = page.locator('[data-testid="ai-link-probe"], [data-testid="ai-link-key-save"]').first();
    await end.scrollIntoViewIfNeeded();
    await page.evaluate(() => {
      const pane = document.querySelector("[data-settings-scroll-viewport]");
      if (pane) pane.scrollTop += 160;
    });
    await wait(200);
    await page.screenshot({ path });
  }
  const text = target === "dialog"
    ? (await page.getByTestId("ai-link-unlink-dialog").textContent()) ?? ""
    : (await page.getByTestId("ai-team-aside").textContent()) ?? "";
  await context.close();
  return { name, width, scheme, path, text };
}

/** 접근성 트리에 가짜 키가 이름·값으로 나오면 실패한다. */
async function assertNoKeyInAxTree(context, page, name) {
  const cdp = await context.newCDPSession(page);
  const { nodes } = await cdp.send("Accessibility.getFullAXTree");
  await cdp.detach();
  const leaks = nodes.filter((node) =>
    [node.name?.value, node.value?.value, node.description?.value].some(
      (text) => typeof text === "string" && text.includes(FAKE_KEY.slice(0, 16))
    )
  );
  if (leaks.length > 0) throw new Error(`[${name}] 접근성 트리에 키가 평문으로 있다`);
}

async function openAdd(page) {
  await page.getByTestId("ai-team-add").click();
  await page.getByTestId("ai-link-key-form").waitFor();
}

async function openAside(page) {
  await page.getByTestId("ai-link-row-more").click();
  await page.getByTestId("ai-team-aside").waitFor();
}

const SCENES = [
  {
    name: "check-fail",
    team: () => teamRoute({ test: probe(false, "provider_auth_failed") }),
    run: async (page) => {
      await openAside(page);
      await page.getByTestId("ai-link-check").click();
      await page.getByTestId("ai-link-probe").waitFor();
      if ((await page.getByTestId("ai-link-probe").getAttribute("data-tone")) !== "bad") throw new Error("거절이 실패색이 아니다");
    },
  },
  {
    // 에이전트가 많으면 목록만 스크롤하고 버튼 줄은 창 안에 남는다(design-review #2880 H2).
    name: "unlink-many",
    setup: () => {
      sceneState.extraAgents = Array.from({ length: 30 }, (_, i) =>
        member({
          id: `00000000-0000-7000-8000-0000000003${String(i).padStart(2, "0")}`,
          kind: "agent",
          displayName: `리서치 봇 ${i + 1}`,
          handle: `bot${i + 1}`,
          channelIds: [channelA, channelB],
        })
      );
    },
    team: () => teamRoute(),
    run: async (page) => {
      await openAside(page);
      await page.getByTestId("ai-link-unlink").click();
      await page.getByTestId("ai-link-unlink-impact").waitFor();
      const box = await page.getByTestId("ai-link-unlink-confirm").boundingBox();
      const vp = page.viewportSize();
      if (!box || !vp || box.y + box.height > vp.height) throw new Error("끊기 버튼이 창 밖으로 밀려났다");
      return "dialog";
    },
  },
  {
    name: "unlink-unknown",
    setup: () => {
      sceneState.hostedDenied = true;
    },
    team: () => teamRoute(),
    run: async (page) => {
      await openAside(page);
      await page.getByTestId("ai-link-unlink").click();
      await page.getByTestId("ai-link-unlink-unknown").waitFor();
      return "dialog";
    },
  },
  {
    name: "add-preset",
    team: () => teamRoute({ link: EMPTY_LINK }),
    run: async (page) => {
      await openAdd(page);
      await page.getByTestId("ai-link-key-form").getByText("Anthropic (Claude)").click();
      await page.getByTestId("ai-link-key-input").fill(FAKE_KEY);
    },
  },
  {
    name: "add-custom",
    team: () => teamRoute({ link: EMPTY_LINK }),
    run: async (page) => {
      await openAdd(page);
      await page.getByTestId("ai-link-key-form").getByText("직접 주소").click();
      await page.getByTestId("ai-link-custom-url").fill("https://llm-gateway.example/v1");
      await page.getByTestId("ai-link-key-input").fill(FAKE_KEY);
    },
  },
  {
    name: "saved-not-run",
    team: () => teamRoute({ link: EMPTY_LINK }),
    run: async (page) => {
      await openAdd(page);
      await page.getByTestId("ai-link-key-form").getByText("Anthropic (Claude)").click();
      await page.getByTestId("ai-link-key-input").fill(FAKE_KEY);
      await page.getByTestId("ai-link-key-save").click();
      await page.getByTestId("ai-link-probe").waitFor();
      const text = (await page.getByTestId("ai-link-probe").textContent()) ?? "";
      if (!text.includes("확인 전") || text.includes("거절")) throw new Error(`probe_not_run 결과가 정직하지 않다: ${text}`);
    },
  },
  {
    name: "checked-2960",
    team: () => teamRoute({ test: PROBE_2960 }),
    run: async (page) => {
      await openAside(page);
      await page.getByTestId("ai-link-check").click();
      await page.getByTestId("ai-link-probe").waitFor();
    },
  },
  // #2975: #2960 사유와 provider 숫자 줄. ONLY=check-egress,check-invalid,checked-openrouter,checked-cached
  ...[
    ["check-egress", "provider_egress_denied", { outcome: "unreachable" }],
    ["check-invalid", "provider_invalid_response", { outcome: "unknown", httpStatus: 200 }],
  ].map(([name, reason, detail]) => ({
    name,
    team: () => teamRoute({ test: probeWith(false, reason, detail) }),
    run: async (page) => {
      await openAside(page);
      await page.getByTestId("ai-link-check").click();
      await page.getByTestId("ai-link-probe").waitFor();
      if ((await page.getByTestId("ai-link-probe-detail").count()) > 0) throw new Error(`${name}: 숫자 없는 실패에 숫자 줄`);
    },
  })),
  {
    name: "checked-openrouter",
    team: () =>
      teamRoute({
        test: probeWith(true, undefined, {
          outcome: "ok", method: "key", httpStatus: 200, modelCount: 312,
          rateLimit: { source: "x-ratelimit", requestsLimit: 200, requestsRemaining: 198 },
          credit: { limit: 20, limitRemaining: 12.5, usage: 7.5 },
        }),
      }),
    run: async (page) => {
      await openAside(page);
      await page.getByTestId("ai-link-check").click();
      await page.getByTestId("ai-link-probe-detail").waitFor();
    },
  },
  {
    name: "checked-cached",
    team: () => teamRoute({ test: probeWith(true, undefined, { outcome: "ok", modelCount: 6, cached: true }) }),
    run: async (page) => {
      await openAside(page);
      await page.getByTestId("ai-link-check").click();
      await page.getByTestId("ai-link-probe-detail").waitFor();
    },
  },
  {
    name: "unlink",
    team: () => teamRoute(),
    run: async (page) => {
      await openAside(page);
      await page.getByTestId("ai-link-unlink").click();
      await page.getByTestId("ai-link-unlink-impact").waitFor();
      const names = await page.getByTestId("ai-link-unlink-agent").allTextContents();
      if (names.some((n) => n.includes("성재의 Claude"))) throw new Error("호스티드 에이전트가 끊기 목록에 섰다");
      return "dialog";
    },
  },
];

async function main() {
  if (!existsSync(resolve(webRoot, "dist/index.html"))) throw new Error("dist/ is missing. Run npm run build:design first.");
  mkdirSync(outDir, { recursive: true });
  const server = await startGuardedPreview({ webRoot, port, portEnvVar: "TEAM_LINK_CAPTURE_PORT" });
  const only = process.env.ONLY ? process.env.ONLY.split(",") : null;
  try {
    const browser = await chromium.launch();
    try {
      for (const width of [1280, 390]) {
        for (const scheme of ["light", "dark"]) {
          for (const s of SCENES) {
            if (only && !only.includes(s.name)) continue;
            const result = await scene(browser, { width, scheme, name: s.name, team: s.team(), run: s.run, setup: s.setup });
            console.log(`[shot] ${result.name}-${width}-${scheme}: ${result.text.slice(0, 110)}`);
          }
        }
      }
    } finally {
      await browser.close();
    }
  } finally {
    await server.stop();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
