#!/usr/bin/env node
// =============================================================================
// 채팅 로컬 연결 카드 캡처 (#2944 GC-3, 시안 claudedocs/chat-genui-connect/mockups.html ①②).
//
//   npm run build:design && node scripts/capture-ai-connect-card.mjs
//
// 실제 design 번들에서 컴포저에 `/연결`을 쳐서 카드를 연다. 브라우저에는 이 맥의
// CLI가 없어 design 전용 `?aiEntry=rows&aiProbe=…&aiCard=…`로 구독 줄의 자세를
// 세우고(제품 빌드는 늘 무시한다), 팀 연결은 네트워크 대역으로 흐름을 실제로 민다.
// 라이트·다크 × 1280·390 → captures/2944/*.png
//
// 모든 장면에서 접근성 트리(CDP Accessibility.getFullAXTree)에 가짜 키 글자가 이름·값
// 으로 나오면 실패한다(design-review #2961 H1: 키 칸은 password여야 한다).
// =============================================================================

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.CARD_CAPTURE_PORT || 5237);
const origin = `http://127.0.0.1:${port}`;

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const peerId = "00000000-0000-7000-8000-000000000102";
const agentId = "00000000-0000-7000-8000-000000000103";
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
];

const channels = [
  { id: channelA, workspaceId, kind: "public", name: "에이전트-실험", muted: false },
];

function todayAt(hour, minute) {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

function row(over) {
  return { channelId: channelA, hlcCount: 0, type: "text", state: "sent", ...over, hlcTs: over.createdAtMs };
}

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
    if (path.endsWith("/roster")) return json(route, { members: roster });
    // 팀 연결은 운영자만(#2944 카드의 팀 절). 이 게이트는 입구만 잰다.
    if (path.startsWith("/v1/provider/link")) return team(route, request, path);
    if (path.endsWith("/channels")) return json(route, { channels });
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
/** 프리셋에 없는 지금 주소(사내 게이트웨이, review #2961 M4). */
const PROXY_LINK = {
  ...KEY_LINK,
  baseUrl: "https://llm-gateway.yeomyeong-internal.example/v1",
  endpointLabel: "llm-gateway.yeomyeong-internal.example",
  credentialKind: "bearer",
  format: "openai",
};
const FAKE_KEY = "capture-only-not-a-key-000000000000";
const probe = (ok, reason) => ({
  schema: "momo.provider_link.test.v0", ok, reason, source: "database", mode: "external-hermes",
  endpointLabel: "Anthropic", checkedAtMs: Date.now(),
});

/** 팀 연결 대역. `testHold`가 있으면 확인 응답을 그 약속이 풀릴 때까지 붙든다. */
function teamRoute({ link = KEY_LINK, test = probe(true), testHold = null, denied = false } = {}) {
  return async (route, request, path) => {
    if (denied) return json(route, { error: { code: "forbidden", message: "operator required" } }, 403);
    if (path.endsWith("/test")) {
      if (testHold) await testHold;
      return json(route, test);
    }
    if (path.endsWith("/chain")) return json(route, { error: { code: "not_found", message: "none" } }, 404);
    return json(route, link);
  };
}

const outDir = resolve(webRoot, "captures/2944");

async function scene(browser, { width, scheme, name, query, team, act }) {
  const height = width === 390 ? 844 : 800;
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
  await page.evaluate(
    ([id, q]) => {
      window.location.hash = `#/c/${id}?${q}`;
    },
    [channelA, query]
  );
  await page.getByTestId("composer-input").waitFor({ timeout: 15_000 });
  await page.getByTestId("timeline-message").first().waitFor();
  await wait(300);
  const input = page.getByTestId("composer-input");
  await input.click();
  await page.keyboard.type(act?.slash ?? "/연결");
  // 목록의 첫 줄을 누른다(좁은 폭의 ↵는 줄바꿈이라 목록 선택으로 연다).
  await page.getByTestId("composer-command-option").first().click();
  await page.getByTestId("ai-connect-card").waitFor({ timeout: 5_000 }).catch(async (error) => {
    await page.screenshot({ path: resolve(outDir, `DEBUG-${name}.png`) });
    console.log("hash", await page.evaluate(() => location.hash), "input", await input.inputValue());
    throw error;
  });
  await wait(400);
  // 접근성 트리를 먼저 잰다: 새 CDP 세션은 Playwright의 오프라인 흉내를 풀어 버린다.
  if (act?.run) await act.run(page, () => assertNoKeyInAxTree(context, page, name));
  if (!act?.checksAx) await assertNoKeyInAxTree(context, page, name);
  // 오프라인 장면은 잠긴 저장 버튼 위의 포인터(흐린 상태)를 그대로 찍는다.
  if (!act?.keepPointer) await page.mouse.move(0, 0);
  await wait(300);
  const path = resolve(outDir, `${name}-${width}-${scheme}.png`);
  await page.screenshot({ path });
  const text = (await page.getByTestId("ai-connect-card").textContent()) ?? "";
  await context.close();
  return { name, width, scheme, path, text };
}

/** 접근성 트리에 가짜 키가 이름·값으로 나오면 실패한다(스크린리더·접근성 권한 앱이 읽는 면). */
async function assertNoKeyInAxTree(context, page, name) {
  const cdp = await context.newCDPSession(page);
  const { nodes } = await cdp.send("Accessibility.getFullAXTree");
  await cdp.detach();
  const leaks = nodes.filter((node) =>
    [node.name?.value, node.value?.value, node.description?.value].some(
      (text) => typeof text === "string" && text.includes(FAKE_KEY.slice(0, 16))
    )
  );
  if (leaks.length > 0) {
    throw new Error(`[${name}] 접근성 트리에 키가 평문으로 있다: ${JSON.stringify(leaks.map((n) => n.role?.value))}`);
  }
}

/** 실패한 지금 키 → 「키 바꾸기」로 폼을 연다. */
async function openReplaceForm(page) {
  await page.getByTestId("ai-connect-card-team-check").click();
  await page.getByTestId("ai-connect-card-team-key").click();
  await page.getByTestId("ai-connect-card-key-form").waitFor();
}

function scenes() {
  let release = () => undefined;
  const hold = () => new Promise((done) => (release = done));
  return [
    { name: "card", query: "aiEntry=rows&aiProbe=login", team: () => teamRoute() },
    { name: "login-modal", query: "aiEntry=rows&aiProbe=login&aiCard=login-modal", team: () => teamRoute() },
    { name: "logged", query: "aiEntry=rows&aiProbe=claude-ready&aiCard=logged", team: () => teamRoute() },
    {
      name: "team-key",
      query: "aiEntry=rows&aiProbe=login",
      team: () => teamRoute({ link: EMPTY_LINK }),
      act: {
        slash: "/연결 팀키",
        run: async (page) => {
          await page.getByTestId("ai-connect-card-key-form").waitFor();
          await page.getByTestId("ai-connect-card-key-form").getByText("Anthropic (Claude)").click();
          if (!(await page.getByTestId("ai-connect-card-preset-anthropic").isChecked()))
            throw new Error("프리셋 칩을 눌러도 고르지 못했다");
          // 캡처에는 가짜 키의 마스킹 점만 찍힌다(칸이 password라 접근성 트리에도
          // 값이 없다. assertNoKeyInAxTree가 모든 장면에서 잰다).
          await page.getByTestId("ai-connect-card-key-input").fill(FAKE_KEY);
        },
      },
    },
    {
      name: "checking",
      query: "aiEntry=rows&aiProbe=claude-ready",
      team: () => teamRoute({ testHold: hold() }),
      act: {
        run: async (page) => {
          await page.getByTestId("ai-connect-card-team-check").click();
          await page.locator("[data-testid='ai-connect-card-team-pill'] [data-tone='run']").waitFor();
        },
      },
      after: () => release(),
    },
    {
      name: "checked",
      query: "aiEntry=rows&aiProbe=claude-ready",
      team: () => teamRoute({ test: probe(true) }),
      act: {
        run: async (page) => {
          await page.getByTestId("ai-connect-card-team-check").click();
          await page.getByTestId("ai-connect-card-team-result").waitFor();
        },
      },
    },
    {
      name: "fail",
      query: "aiEntry=rows&aiProbe=login&aiCard=unfinished",
      team: () => teamRoute({ test: probe(false, "provider_auth_failed") }),
      act: {
        run: async (page) => {
          await page.getByTestId("ai-connect-card-team-check").click();
          await page.getByTestId("ai-connect-card-team-result").waitFor();
        },
      },
    },
    {
      name: "replace-confirm",
      query: "aiEntry=rows&aiProbe=claude-ready",
      team: () => teamRoute({ test: probe(false, "provider_auth_failed") }),
      act: {
        slash: "/연결 팀키",
        run: async (page) => {
          await page.getByTestId("ai-connect-card-team-check").click();
          await page.getByTestId("ai-connect-card-team-key").click();
          await page.getByTestId("ai-connect-card-key-input").fill(FAKE_KEY);
          await page.getByTestId("ai-connect-card-key-save").click();
          await page.getByTestId("ai-connect-card-key-replace").waitFor();
        },
      },
    },
    {
      // 프리셋에 없는 지금 주소는 「지금 주소」 칩을 고른 채 열린다(review #2961 M4·N2).
      name: "current-chip",
      query: "aiEntry=rows&aiProbe=claude-ready",
      team: () => teamRoute({ link: PROXY_LINK, test: probe(false, "provider_auth_failed") }),
      act: {
        slash: "/연결 팀키",
        run: async (page) => {
          await openReplaceForm(page);
          if (!(await page.getByTestId("ai-connect-card-preset-current").isChecked()))
            throw new Error("「지금 주소」 칩이 골라져 있지 않다");
        },
      },
    },
    {
      // 다른 프리셋을 고르면 대체 확인이 주소가 바뀐다고 말한다(N1: 「OpenRouter 주소로」).
      name: "current-move-confirm",
      query: "aiEntry=rows&aiProbe=claude-ready",
      team: () => teamRoute({ link: PROXY_LINK, test: probe(false, "provider_auth_failed") }),
      act: {
        slash: "/연결 팀키",
        run: async (page) => {
          await openReplaceForm(page);
          await page.getByTestId("ai-connect-card-key-form").getByText("OpenRouter").click();
          await page.getByTestId("ai-connect-card-key-input").fill(FAKE_KEY);
          await page.getByTestId("ai-connect-card-key-save").click();
          const confirm = page.getByTestId("ai-connect-card-key-replace");
          await confirm.waitFor();
          if (!((await confirm.textContent()) ?? "").includes("OpenRouter 주소로"))
            throw new Error("대체 확인이 주소 변경을 말하지 않는다");
        },
      },
    },
    {
      // 끊기면 저장은 잠기고 사유가 붙는다. 눌러도 요청은 없다(review #2961 H1).
      name: "offline-lock",
      query: "aiEntry=rows&aiProbe=login",
      team: () => teamRoute({ link: EMPTY_LINK }),
      act: {
        slash: "/연결 팀키",
        keepPointer: true,
        checksAx: true,
        run: async (page, checkAx) => {
          await page.getByTestId("ai-connect-card-key-form").waitFor();
          await page.getByTestId("ai-connect-card-key-input").fill(FAKE_KEY);
          await checkAx();
          await page.context().setOffline(true);
          await page.getByTestId("ai-connect-card-offline").waitFor();
          const save = page.getByTestId("ai-connect-card-key-save");
          if ((await save.getAttribute("aria-disabled")) !== "true") throw new Error("오프라인인데 저장이 잠기지 않았다");
          await save.click({ force: true });
          await wait(300);
        },
      },
    },
    { name: "denied", query: "aiEntry=rows&aiProbe=claude-ready", team: () => teamRoute({ denied: true }) },
    { name: "browser-tab", query: "aiEntry=desktop-only", team: () => teamRoute() },
  ];
}

async function main() {
  if (!existsSync(resolve(webRoot, "dist/index.html"))) throw new Error("dist/ is missing. Run npm run build:design first.");
  mkdirSync(outDir, { recursive: true });
  const server = await startGuardedPreview({ webRoot, port, portEnvVar: "CARD_CAPTURE_PORT" });
  const only = process.env.ONLY ? process.env.ONLY.split(",") : null;
  try {
    const browser = await chromium.launch();
    try {
      for (const width of [1280, 390]) {
        for (const scheme of ["light", "dark"]) {
          for (const s of scenes()) {
            if (only && !only.includes(s.name)) continue;
            const result = await scene(browser, { width, scheme, name: s.name, query: s.query, team: s.team(), act: s.act });
            s.after?.();
            console.log(`[shot] ${result.name}-${width}-${scheme}: ${result.text.slice(0, 90)}`);
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
