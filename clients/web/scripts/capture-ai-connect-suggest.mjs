#!/usr/bin/env node
// =============================================================================
// 에이전트 제안 연결 카드 캡처 (#2948 GC-7, 시안 claudedocs/chat-genui-connect/mockups.html ③).
//
//   npm run build:design && node scripts/capture-ai-connect-suggest.mjs
//
// 실제 design 번들의 타임라인에 hermes의 답 + `momo.command_suggest(ai.connect)` props가
// 실린 메시지를 놓고, 로그인한 사람을 바꿔 보는 사람별 렌더를 찍는다:
//   target(곽성재, 운영자) · target-done(로그인 뒤) · other(김하늘, 403) ·
//   operator(김하늘, 200 → 「팀 연결 보기」 펼침).
// 구독 줄의 자세는 GC-3와 같은 design 전용 `?aiEntry=rows&aiProbe=…`(제품 빌드는 무시).
// 라이트·다크 × 1280·390 → captures/2948/*.png
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


let viewer = { id: memberId, displayName: "곽성재", handle: "seongjae" };
const sessionFor = () => ({
  accessToken: "gate-only-not-a-credential",
  refreshToken: "gate-only-not-a-credential",
  member: { id: viewer.id, workspaceId, kind: "human", displayName: viewer.displayName, handle: viewer.handle },
  realtimeWebSocketUrl: "ws://slash-gate.invalid/connection/websocket",
});

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
  member({ id: peerId, kind: "human", role: "admin", displayName: "김하늘", handle: "haneul" }),
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

let suggestArgs = { harness: "claude", scope: "mine" };
const SUGGEST = {
  v: 1,
  command_id: "ai.connect",
  get args() {
    return suggestArgs;
  },
  for_member_id: memberId,
  label: "Claude 구독 연결",
};

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
    body: "@hermes 내 클로드 구독 연결해 줘. 되는지도 확인해 주고.",
    createdAtMs: todayAt(15, 44),
  }),
  row({
    id: "0199dddd-0000-7000-8000-000000000003",
    seq: 12,
    authorMemberId: agentId,
    body: "구독 로그인은 성재 님 맥에서 공식 CLI로 해야 해서 제가 대신할 수 없어요. 아래 카드에서 바로 연결하고 확인할 수 있어요.",
    createdAtMs: todayAt(15, 44),
    props: { "momo.command_suggest": SUGGEST },
  }),
];

/** 스레드 장면(design-review #2948 B): 제안이 요청 메시지의 스레드 답글로 온다. */
let threadMode = false;
const THREAD_ROOT = "0199dddd-0000-7000-8000-000000000002";
function channelMessages() {
  if (!threadMode) return messages;
  return [
    messages[0],
    { ...messages[1], thread: { reply_count: 1, last_reply_seq: 12, last_reply_at: messages[2].createdAtMs } },
  ];
}
function threadReplies() {
  return [{ ...messages[2], rootId: THREAD_ROOT }];
}

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
    if (path === "/v1/auth/login") return json(route, sessionFor());
    if (path === "/v1/auth/realtime-token")
      return json(route, {
        token: "gate-realtime-token",
        tokenType: "Bearer",
        expiresAtMs: Date.now() + 60_000,
        ttlSeconds: 60,
        workspaceId,
        memberId: viewer.id,
      });
    if (path === "/v1/auth/refresh")
      return json(route, { accessToken: sessionFor().accessToken, refreshToken: sessionFor().refreshToken });
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
    if (path.endsWith("/replies")) return json(route, { messages: threadMode ? threadReplies() : [] });
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
      return json(route, { messages: channelMessages() });
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

const outDir = resolve(webRoot, "captures/2948");

async function scene(browser, { width, scheme, name, query, team, as, act, args, thread }) {
  viewer = as;
  threadMode = Boolean(thread);
  suggestArgs = args ?? { harness: "claude", scope: "mine" };
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
  if (thread) {
    await page.getByTestId("thread-anchor").first().click();
    await page.getByTestId("thread-panel").waitFor();
  }
  const slot = page.getByTestId("ai-suggest");
  await slot.waitFor({ timeout: 10_000 }).catch(async (error) => {
    await page.screenshot({ path: resolve(outDir, `DEBUG-${name}.png`) });
    throw error;
  });
  await wait(600);
  if (act) await act(page);
  const active = await page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.tagName);
  await page.mouse.move(0, 0);
  // 제안 행이 보이게 마지막 메시지로 내린다(가상 목록이 바닥에 붙어 있지 않을 때를 대비).
  await slot.scrollIntoViewIfNeeded();
  await wait(300);
  const path = resolve(outDir, `${name}-${width}-${scheme}.png`);
  await page.screenshot({ path });
  const viewerAttr = await slot.getAttribute("data-viewer");
  const controls = await slot.locator("button, input, select, textarea, a[href]").count();
  const text = (await slot.textContent()) ?? "";
  await context.close();
  return { name, width, scheme, path, text, viewerAttr, controls, active };
}

const SUNG = { id: memberId, displayName: "곽성재", handle: "seongjae" };
const SKY = { id: peerId, displayName: "김하늘", handle: "haneul" };

function scenes() {
  return [
    { name: "target", as: SUNG, query: "aiEntry=rows&aiProbe=login", team: () => teamRoute(), expect: { viewer: "target" } },
    { name: "target-done", as: SUNG, query: "aiEntry=rows&aiProbe=claude-ready&aiCard=logged", team: () => teamRoute(), expect: { viewer: "target" } },
    { name: "other", as: SKY, query: "", team: () => teamRoute({ denied: true }), expect: { viewer: "other", controls: 0 } },
    {
      name: "operator",
      as: SKY,
      query: "",
      team: () => teamRoute(),
      expect: { viewer: "operator" },
      act: async (page) => {
        await page.getByTestId("ai-suggest-team-open").click();
        await page.getByTestId("ai-connect-card-team").waitFor();
      },
    },
    {
      // 비운영자 요청자 + 팀 키 제안(시안 ③ 이도윤 자리): 거절 줄 + 「운영자에게 부탁하기」를
      // 누르면 컴포저에 운영자 멘션만 찬다(보내지 않는다).
      name: "requester-denied",
      as: SUNG,
      query: "aiEntry=rows&aiProbe=claude-ready",
      args: { harness: "team_key", scope: "team" },
      team: () => teamRoute({ denied: true }),
      expect: { viewer: "target" },
      act: async (page) => {
        await page.getByTestId("ai-connect-card-ask-operator").click();
        const value = await page.getByTestId("composer-input").inputValue();
        if (value !== "@haneul ") throw new Error(`컴포저에 운영자 멘션이 차지 않았다: ${JSON.stringify(value)}`);
      },
    },
    {
      // 스레드 답글로 온 제안: 부탁 멘션은 채널이 아니라 그 스레드 입력창에 찬다.
      name: "thread-denied",
      thread: true,
      as: SUNG,
      query: "aiEntry=rows&aiProbe=claude-ready",
      args: { harness: "team_key", scope: "team" },
      team: () => teamRoute({ denied: true }),
      expect: { viewer: "target" },
      act: async (page) => {
        await page.getByTestId("thread-panel").getByTestId("ai-connect-card-ask-operator").click();
        const box = page.getByTestId("thread-composer").locator("textarea");
        const value = await box.inputValue();
        if (value !== "@haneul ") throw new Error(`스레드 입력창에 멘션이 차지 않았다: ${JSON.stringify(value)}`);
        const channel = await page.getByTestId("composer-input").inputValue();
        if (channel !== "") throw new Error(`채널 입력창이 채워졌다: ${JSON.stringify(channel)}`);
      },
    },
    { name: "operator-line", as: SKY, query: "", team: () => teamRoute(), expect: { viewer: "operator", controls: 1 } },
  ];
}

async function main() {
  if (!existsSync(resolve(webRoot, "dist/index.html"))) throw new Error("dist/ is missing. Run npm run build:design first.");
  mkdirSync(outDir, { recursive: true });
  const server = await startGuardedPreview({ webRoot, port, portEnvVar: "CARD_CAPTURE_PORT" });
  const only = process.env.ONLY ? process.env.ONLY.split(",") : null;
  let failed = 0;
  try {
    const browser = await chromium.launch();
    try {
      for (const width of [1280, 390]) {
        for (const scheme of ["light", "dark"]) {
          for (const s of scenes()) {
            if (only && !only.includes(s.name)) continue;
            const r = await scene(browser, { width, scheme, name: s.name, query: s.query, team: s.team(), as: s.as, act: s.act, args: s.args, thread: s.thread });
            const bad =
              r.viewerAttr !== s.expect.viewer ||
              (s.expect.controls !== undefined && r.controls !== s.expect.controls) ||
              // 마운트한 제안 카드가 초점을 가져가지 않는다(행동이 없는 장면).
              (!s.act && r.active !== "BODY" && r.active !== "composer-input");
            if (bad) failed += 1;
            console.log(
              `[${bad ? "FAIL" : "shot"}] ${r.name}-${width}-${scheme}: viewer=${r.viewerAttr} controls=${r.controls} focus=${r.active} :: ${r.text.slice(0, 80)}`
            );
          }
        }
      }
    } finally {
      await browser.close();
    }
  } finally {
    await server.stop();
  }
  if (failed > 0) throw new Error(`${failed} scene(s) failed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
