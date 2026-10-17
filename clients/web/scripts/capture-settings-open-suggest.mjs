#!/usr/bin/env node
// =============================================================================
// 에이전트 제안 「설정 열기」 카드 캡처 (U-S6 #3940, settings.open).
//
//   npm run build:design && node scripts/capture-settings-open-suggest.mjs
//
// 실제 design 번들의 타임라인에 hermes의 답 + `momo.command_suggest(ai.connect)` props가
// 실린 메시지를 놓고, 로그인한 사람을 바꿔 보는 사람별 렌더를 찍는다:
//   target(곽성재, 운영자) · target-done(로그인 뒤) · other(김하늘, 403) ·
//   operator(김하늘, 200 → 「팀 연결 보기」 펼침).
// 구독 줄의 자세는 GC-3와 같은 design 전용 `?aiEntry=rows&aiProbe=…`(제품 빌드는 무시).
// 라이트·다크 × 1280·390 → captures/3940/*.png
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

let suggestArgs = { section: "notifications" };
const SUGGEST = {
  v: 1,
  command_id: "settings.open",
  get args() {
    return suggestArgs;
  },
  for_member_id: memberId,
  label: "알림 설정 열기",
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
    body: "@hermes 알림 설정은 어디서 바꿔요?",
    createdAtMs: todayAt(15, 44),
  }),
  row({
    id: "0199dddd-0000-7000-8000-000000000003",
    seq: 12,
    authorMemberId: agentId,
    body: "알림은 설정에서 바꿀 수 있어요. 아래 카드로 바로 열어 보세요.",
    createdAtMs: todayAt(15, 44),
    props: { "momo.command_suggest": SUGGEST },
  }),
];

/** 스레드 장면(design-review #2948 B): 제안이 요청 메시지의 스레드 답글로 온다. */
let threadMode = false;
const THREAD_ROOT = "0199dddd-0000-7000-8000-000000000002";
function channelMessages() {
  if (!threadMode) return messages;
  if (threadMode === "root") {
    return [
      messages[0],
      messages[1],
      { ...messages[2], thread: { reply_count: 1, last_reply_seq: 13, last_reply_at: messages[2].createdAtMs + 60_000 } },
    ];
  }
  return [
    messages[0],
    { ...messages[1], thread: { reply_count: 1, last_reply_seq: 12, last_reply_at: messages[2].createdAtMs } },
  ];
}
function threadReplies() {
  if (threadMode === "root") {
    return [
      row({
        id: "0199dddd-0000-7000-8000-000000000004",
        seq: 13,
        authorMemberId: memberId,
        rootId: messages[2].id,
        body: "팀 키는 제가 못 넣네요. 운영자에게 부탁해 볼게요.",
        createdAtMs: messages[2].createdAtMs + 60_000,
      }),
    ];
  }
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

const outDir = resolve(webRoot, "captures/3940");

async function scene(browser, { width, scheme, name, as, args, label, act, expectCard = true }) {
  viewer = as;
  threadMode = false;
  suggestArgs = args;
  if (label) messages[2].props["momo.command_suggest"].label = label;
  const height = width === 390 ? 844 : 900;
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce", colorScheme: scheme, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await installRealtimeSocket(page);
  await installRoutes(context, [], async (route) => json(route, { error: { code: "forbidden", message: "x" } }, 403));
  await login(page);
  await page.evaluate((id) => { window.location.hash = `#/c/${id}`; }, channelA);
  await page.getByTestId("composer-input").waitFor({ timeout: 15_000 });
  const slot = page.getByTestId("settings-suggest");
  let shown = true;
  await slot.waitFor({ timeout: 6_000 }).catch(() => { shown = false; });
  await wait(500);
  if (shown) await slot.scrollIntoViewIfNeeded();
  const viewerAttr0 = shown ? await slot.getAttribute("data-viewer") : null;
  const controls0 = shown ? await slot.locator("button, input, select, textarea, a[href]").count() : 0;
  const text0 = shown ? ((await slot.textContent()) ?? "") : "";
  if (act && shown) await act(page);
  await page.mouse.move(0, 0);
  await wait(300);
  const path = resolve(outDir, `${name}-${width}-${scheme}.png`);
  await page.screenshot({ path });
  const viewerAttr = viewerAttr0;
  const controls = controls0;
  const text = text0;
  const body = act ? true : (await page.getByText("알림은 설정에서 바꿀 수 있어요").count()) > 0;
  const url = await page.evaluate(() => window.location.hash);
  await context.close();
  return { name, width, scheme, shown, viewerAttr, controls, text, body, url, expectCard };
}

const SUNG = { id: memberId, displayName: "곽성재", handle: "seongjae" };
const SKY = { id: peerId, displayName: "김하늘", handle: "haneul" };

const SCENES = [
  { name: "target", as: SUNG, args: { section: "notifications" }, expect: { viewer: "target", controls: 1 } },
  { name: "target-members", as: SUNG, args: { section: "members" }, label: "멤버와 초대 열기", expect: { viewer: "target", controls: 1 } },
  {
    name: "click-through",
    as: SUNG,
    args: { section: "appearance" },
    label: "모양 설정 열기",
    expect: { viewer: "target", controls: 1, url: "section=appearance" },
    act: async (page) => {
      await page.getByTestId("settings-suggest-open").click();
      await page.waitForURL(/section=appearance/, { timeout: 5000 }).catch(() => {});
    },
  },
  { name: "other", as: SKY, args: { section: "notifications" }, expect: { viewer: "other", controls: 0 } },
  { name: "unknown-section", as: SUNG, args: { section: "no-such-section" }, expect: { viewer: "other", controls: 0 } },
  { name: "unreachable-updates", as: SUNG, args: { section: "updates" }, label: "업데이트 설정 열기", expectCard: false, expect: { shown: false } },
];

async function main() {
  if (!existsSync(resolve(webRoot, "dist/index.html"))) throw new Error("dist/ is missing. Run npm run build:design first.");
  mkdirSync(outDir, { recursive: true });
  const server = await startGuardedPreview({ webRoot, port, portEnvVar: "CARD_CAPTURE_PORT" });
  let failed = 0;
  try {
    const browser = await chromium.launch();
    try {
      for (const width of [1440, 390]) {
        for (const scheme of ["light", "dark"]) {
          for (const s of SCENES) {
            const r = await scene(browser, { width, scheme, ...s });
            const e = s.expect;
            const bad =
              (e.shown === false ? r.shown : !r.shown) ||
              (e.viewer !== undefined && r.viewerAttr !== e.viewer) ||
              (e.controls !== undefined && r.controls !== e.controls) ||
              (e.url !== undefined && !r.url.includes(e.url)) ||
              // 카드가 서든 안 서든 에이전트의 본문 글은 남는다(폴백 = 글).
              (e.url === undefined && !r.body);
            if (bad) failed += 1;
            console.log(`[${bad ? "FAIL" : "shot"}] ${r.name}-${width}-${scheme}: shown=${r.shown} viewer=${r.viewerAttr} controls=${r.controls} body=${r.body} url=${r.url} :: ${r.text.slice(0, 70)}`);
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
