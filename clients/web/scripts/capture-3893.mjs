#!/usr/bin/env node
// =============================================================================
// CAPTURE (#3893, ADR-0201 증보 v2 S7): 팀 AI를 @oort·@오르트로 부르는 화면
//   1. 「팀 AI 키」 다음 단계 카드: 1단계 할 일 / 켜기 준비 / 켠 뒤(별칭 상태·불러 보기) / 409
//      → 「#채널에서 @oort 불러 보기」를 누르면 그 채널이 열리고 작성창에 `@oort ` 가 찬다
//   2. 멘션 자동완성: `@오르` 에 「oort 도우미 · @오르트」, 고르면 `@oort `
//   3. 타임라인: 도우미 답의 「찾아본 것 · 팀 AI 칩 · 출처」, 설정 카드의 「적용 범위」
//   4. 옛 서버(별칭·꼬리 칸 없음, 스위치 모름): 카드도 꼬리도 없음
//
//   npm run build && OUT_DIR=<dir> node scripts/capture-3893.mjs
// 백엔드는 없다: `/v1/**` 고정 응답, 실시간 소켓은 곧바로 연결되는 흉내다.
// =============================================================================

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/3893");
const PORT = Number(process.env.CAPTURE_PORT || 5238);

const workspaceId = "00000000-0000-7000-8000-000000000001";
const me = "00000000-0000-7000-8000-000000000101";
const haneul = "00000000-0000-7000-8000-000000000102";
const helper = "00000000-0000-7000-8000-000000000301";
const grok = "00000000-0000-7000-8000-000000000302";
const claudeAgent = "00000000-0000-7000-8000-000000000303";
const general = "00000000-0000-7000-8000-000000000201";
const marketing = "00000000-0000-7000-8000-000000000202";
const BASE_MS = Date.parse("2026-10-16T02:10:00.000Z");
const channels = [
  { id: general, workspaceId, kind: "public", name: "일반", muted: false },
  { id: marketing, workspaceId, kind: "public", name: "마케팅", muted: false },
];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: me, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: "ws://capture-3893.invalid/connection/websocket",
};
const person = (id, displayName, handle, role) => ({
  id, workspaceId, kind: "human", status: "active", role, displayName, handle, channelCount: 2,
  channelIds: channels.map((c) => c.id), capabilities: [], createdAtMs: 0, updatedAtMs: 0,
});
const bot = (id, displayName, handle, extra = {}) => ({
  id, workspaceId, kind: "agent", status: "active", displayName, handle, channelCount: 2,
  channelIds: channels.map((c) => c.id), capabilities: [], ownerHumanId: me, createdAtMs: 0, updatedAtMs: 0, ...extra,
});

const providerLink = {
  schema: "momo.provider_link.v0", configured: true, source: "database", mode: "external-hermes",
  baseUrl: "https://api.anthropic.com/v1", endpointLabel: "https://api.anthropic.com/v1", bearerConfigured: true,
  bearerLast4: "7c1e", availability: "live", keyConfigured: true, format: "anthropic", updatedAtMs: BASE_MS, diagnostics: [],
};

// 장면마다 서버 답을 바꾼다.
//   v2: 서버가 별칭·꼬리·별칭 상태를 안다(S1~S4 뒤). false 면 #3837 서버(스위치만 앎).
//   old: 스위치도 모르는 서버(#3837 이전).
//   teamAgent: 기본 AI 「팀 에이전트의 답」 줄이 풀렸는가.  enable: "ok" | "taken".
const scenario = { v2: true, old: false, teamAgent: true, enable: "ok" };
let bag = { team_ai_fast_path: false };

function roster() {
  const helperRow = bot(helper, "oort 도우미", "oort-helper", scenario.v2 ? { aliases: ["oort", "오르트"] } : {});
  return [
    person(me, "곽성재", "seongjae", "owner"),
    person(haneul, "김하늘", "haneul", "member"),
    helperRow,
    bot(grok, "그록봇", "grokbot"),
    bot(claudeAgent, "클로드 코드", "claude"),
  ];
}

const REPLY_V2 = {
  source: "team_ai",
  run_id: "0199aa11-2222-7000-8000-0000000038a1",
  model_label: "Claude Sonnet 4.5",
  tools_used: [{ name: "search_messages" }, { name: "read_channel", channel: "마케팅" }, { name: "web_search" }],
  web_citations: [
    { url: "https://www.example.com/blog/launch-checklist-2026", title: "2026 출시 체크리스트, 무엇을 먼저 할까" },
    { url: "https://docs.example.org/pricing/team-plans", title: "팀 요금제 비교" },
  ],
};
const UNFURL_CARD = {
  approval_id: "0199aa11-2222-7000-8000-0000000038b1",
  run_id: "0199aa11-2222-7000-8000-0000000038b2",
  channel_id: marketing,
  action_type: "workspace_action",
  status: "pending",
  expires_at_ms: Date.now() + 3_600_000,
  title: "링크 미리보기 끄기",
  action: {
    id: "workspace.unfurl.update",
    rows: [{ label: "링크 미리보기", value: "켜짐 → 꺼짐" }],
    rationale: "김하늘 님이 링크 카드가 너무 커서 워크스페이스 전체에서 꺼 달라고 했어요.",
    required_role: "workspace_operator",
  },
  proposed_via: { kind: "team_ai", requester_id: haneul, requester_name: "김하늘" },
};

function messages() {
  const list = [
    { id: "m1", author: haneul, body: "@oort 지난주 마케팅 채널에서 정한 출시 일정이랑, 요즘 출시 체크리스트 글 있으면 같이 찾아 줘" },
    {
      id: "m2",
      author: helper,
      body: "지난주 #마케팅에서 정한 건 세 가지예요.\n\n1. 베타 공지는 10월 21일 화요일\n2. 랜딩 문구는 김하늘 님이 금요일까지 초안\n3. 가격표는 팀 요금제 비교 글을 참고해서 다시 보기\n\n출시 체크리스트는 아래 두 글이 정리가 잘 돼 있어요.",
      props: REPLY_V2,
      replyToId: "m1",
    },
    { id: "m3", author: haneul, body: "@오르트 링크 미리보기 카드가 너무 커요. 워크스페이스 전체에서 꺼 줄래요?" },
    { id: "m4", author: helper, type: "approval_request", body: "링크 미리보기 끄기", props: UNFURL_CARD },
  ];
  return list.map((row, index) => ({
    id: row.id,
    channelId: marketing,
    seq: 3800 + index,
    hlcTs: BASE_MS + index * 60_000,
    hlcCount: 0,
    authorMemberId: row.author,
    type: row.type ?? "text",
    body: row.body,
    state: "sent",
    ...(row.props ? { props: scenario.v2 || row.type ? row.props : { source: "team_ai", run_id: row.props.run_id } } : {}),
    ...(row.replyToId ? { replyToId: row.replyToId } : {}),
    createdAtMs: BASE_MS + index * 60_000,
  }));
}

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function installRoutes(context) {
  await context.route("**/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId: me });
    }
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) return json(route, { members: roster() });
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/hosted-agent-connections")) return json(route, { connections: [] });
    if (path.endsWith("/provider/link")) return json(route, providerLink);
    if (path.endsWith("/provider/default-ai")) {
      return json(route, {
        schema: "momo.provider.default_ai.v0",
        teamAgent: scenario.teamAgent
          ? { source: "team_link", linkPosition: 0, endpointLabel: "https://api.anthropic.com/v1", linkResolved: true, modelId: "claude-sonnet-4-5" }
          : null,
        summary: null,
        guardrail: { mode: "off", available: false },
      });
    }
    if (path.includes("/provider/link/chain")) return json(route, { error: { code: "not_found", message: "no chain" } }, 404);
    if (path.endsWith("/settings") && path.includes("/workspaces/")) {
      if (request.method() === "GET") return json(route, bag);
      const body = request.postDataJSON();
      const value = body.team_ai_fast_path;
      if (typeof value !== "boolean") {
        return json(route, { error: { code: "bad_request", message: scenario.old ? "unknown settings key: team_ai_fast_path" : "team_ai_fast_path must be true or false" } }, 400);
      }
      await new Promise((r) => setTimeout(r, 400));
      if (value && scenario.enable === "taken") {
        return json(route, { error: { code: "team_ai_unavailable", message: "the 'oort-helper' handle is taken" } }, 409);
      }
      bag = {
        ...bag,
        team_ai_fast_path: value,
        team_ai_agent_member_id: helper,
        ...(scenario.v2 ? { team_ai_alias_status: { oort: "registered", 오르트: "registered", claude: "taken" } } : {}),
      };
      return json(route, bag);
    }
    if (path.endsWith("/unfurl-settings")) return json(route, { enabled: true });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null, participants: [] });
    if (path.endsWith("/plugins")) return json(route, { plugins: [] });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: [] });
    if (path.endsWith("/work-sessions/shared")) return json(route, { sessions: [], nextCursor: null });
    if (path.endsWith("/work-sessions")) return json(route, { workSessions: [] });
    if (path.endsWith(`/workspaces/${workspaceId}`)) {
      return json(route, { workspace: { id: workspaceId, name: "여명거리", slug: "team", updatedAtMs: 1, roleLabels: {}, welcomeAgentMemberId: null, welcomePrompt: "", subscriptionAgentsEnabled: true } });
    }
    if (path.includes(`/channels/${marketing}/messages`)) return json(route, { messages: messages() });
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
          if (c.connect) return { id: c.id, connect: { client: "capture-3893", version: "6" } };
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
  const context = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion: "reduce", serviceWorkers: "block", deviceScaleFactor: 2 });
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

async function paneShot(page, viewport, file) {
  // 본문은 안쪽 스크롤이다: 내용 높이만큼 창을 키워 한 장에 담는다(capture-ai-hub 와 같은 방법).
  const full = await page.evaluate(() => {
    const pane = document.querySelector("[data-testid='ai-hub-route'] .overflow-y-auto");
    return pane ? pane.scrollHeight + pane.getBoundingClientRect().top + 8 : 0;
  });
  await page.setViewportSize({ width: viewport.width, height: Math.max(viewport.height, Math.ceil(full)) });
  await page.waitForTimeout(200);
  await page.getByTestId("team-ai-next-step").first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(OUT_DIR, file) });
  await page.setViewportSize(viewport);
}

async function openTeamKeys(browser, origin, scheme, viewport) {
  const opened = await open(browser, origin, scheme, viewport);
  await opened.page.goto(`${origin}/#/ai/team-keys`);
  await opened.page.getByTestId("ai-team-keys").waitFor();
  await opened.page.waitForTimeout(900);
  return opened;
}

async function nextStepScenes(browser, origin, scheme, viewport) {
  const tag = `${viewport.width}-${scheme}`;
  // a. 1단계 할 일(기본 AI 줄 없음): 켜기는 잠긴다
  Object.assign(scenario, { v2: true, old: false, teamAgent: false, enable: "ok" });
  bag = { team_ai_fast_path: false };
  {
    const { context, page } = await openTeamKeys(browser, origin, scheme, viewport);
    await page.getByTestId("team-ai-next-step").waitFor({ timeout: 8000 });
    await paneShot(page, viewport, `c3893-1a-next-step-todo-${tag}.png`);
    check(`${tag} 1단계 할 일: 켜기 잠김`, (await page.getByTestId("team-ai-next-step-enable").getAttribute("aria-disabled")) === "true");
    check(`${tag} 가로 넘침 0`, (await overflowX(page)) === 0);
    await context.close();
  }
  // b. 켤 준비 → 켜기 → 켠 뒤
  Object.assign(scenario, { teamAgent: true });
  bag = { team_ai_fast_path: false };
  {
    const { context, page } = await openTeamKeys(browser, origin, scheme, viewport);
    await page.getByTestId("team-ai-next-step").waitFor({ timeout: 8000 });
    await paneShot(page, viewport, `c3893-1b-next-step-ready-${tag}.png`);
    await page.getByTestId("team-ai-next-step-enable").click();
    await page.getByTestId("team-ai-next-step-enabled").waitFor({ timeout: 8000 });
    await page.waitForTimeout(300);
    await paneShot(page, viewport, `c3893-1c-next-step-enabled-${tag}.png`);
    const aliases = await page.getByTestId("team-ai-next-step-aliases").textContent();
    check(`${tag} 켠 뒤: 부르는 이름`, aliases === "부르는 이름: @oort · @오르트", aliases);
    const notice = await page.getByTestId("team-ai-next-step-alias-notice").textContent();
    check(`${tag} 켠 뒤: @claude 는 클로드 코드가 써서 연결 안 함`, notice.includes("@claude는 이미 클로드 코드가 쓰고 있어서"), notice);
    await page.getByTestId("team-ai-next-step-channel").selectOption(marketing);
    const tryLabel = await page.getByTestId("team-ai-next-step-try").textContent();
    check(`${tag} 불러 보기 버튼`, tryLabel === "#마케팅에서 @oort 불러 보기", tryLabel);
    if (viewport.width === 1440 && scheme === "light") {
      await page.getByTestId("team-ai-next-step-try").click();
      await page.waitForFunction((id) => location.hash.includes(`/c/${id}`), marketing, { timeout: 8000 });
      const input = page.locator("#composer-input");
      await input.waitFor({ timeout: 8000 });
      await page.waitForTimeout(500);
      const value = await input.evaluate((el) => ("value" in el ? el.value : el.textContent));
      check(`${tag} 불러 보기: 채널이 열리고 작성창에 @oort`, value === "@oort ", JSON.stringify(value));
      await page.screenshot({ path: resolve(OUT_DIR, `c3893-1d-seeded-composer-${tag}.png`) });
    }
    await context.close();
  }
  // c. 409
  if (viewport.width === 1440) {
    Object.assign(scenario, { enable: "taken" });
    bag = { team_ai_fast_path: false };
    const { context, page } = await openTeamKeys(browser, origin, scheme, viewport);
    await page.getByTestId("team-ai-next-step-enable").click();
    await page.getByTestId("team-ai-next-step-error").waitFor({ timeout: 8000 });
    await paneShot(page, viewport, `c3893-1e-next-step-409-${tag}.png`);
    await context.close();
    Object.assign(scenario, { enable: "ok" });
  }
}

async function timelineScenes(browser, origin, scheme, viewport) {
  const tag = `${viewport.width}-${scheme}`;
  Object.assign(scenario, { v2: true, old: false, teamAgent: true, enable: "ok" });
  bag = { team_ai_fast_path: true, team_ai_agent_member_id: helper };
  const { context, page } = await open(browser, origin, scheme, viewport);
  await page.evaluate((id) => { location.hash = `/c/${id}`; }, marketing);
  await page.getByTestId("team-ai-reply-meta").first().waitFor({ timeout: 10_000 });
  await page.waitForTimeout(500);
  await page.getByTestId("team-ai-reply-meta").first().evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(OUT_DIR, `c3893-3a-reply-meta-${tag}.png`) });
  const line = await page.getByTestId("team-ai-tools-line").first().textContent();
  check(`${tag} 꼬리: 찾아본 것`, line.includes("찾아본 것: 메시지 검색 · #마케팅 읽기 · 웹 검색"), line);
  check(`${tag} 꼬리: 출처 2개`, (await page.getByTestId("team-ai-citation").count()) === 2);
  await page.getByTestId("approval-workspace-wide").first().evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(OUT_DIR, `c3893-3b-settings-card-${tag}.png`) });
  check(`${tag} 가로 넘침 0`, (await overflowX(page)) === 0);

  // 2. 자동완성 `@오르`
  const input = page.locator("#composer-input");
  await input.click();
  await input.pressSequentially("@오르");
  await page.locator("[role='listbox']").first().waitFor({ timeout: 5000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(OUT_DIR, `c3893-2a-autocomplete-${tag}.png`) });
  const options = await page.locator("[role='listbox'] [role='option']").allTextContents();
  check(`${tag} 자동완성: @오르 → 도우미 한 줄`, options.length === 1 && options[0].includes("@oort") && options[0].includes("@오르트"), JSON.stringify(options));
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  const value = await input.evaluate((el) => ("value" in el ? el.value : el.textContent));
  check(`${tag} 자동완성: 고르면 @oort`, value === "@oort ", JSON.stringify(value));
  await context.close();
}

async function oldServerScenes(browser, origin) {
  const viewport = { width: 1440, height: 900 };
  // #3837 이전: 스위치를 모르는 서버. 카드 없음.
  Object.assign(scenario, { v2: false, old: true, teamAgent: true });
  bag = {};
  {
    const { context, page } = await openTeamKeys(browser, origin, "light", viewport);
    await page.waitForTimeout(800);
    check("옛 서버: 다음 단계 카드 없음", (await page.getByTestId("team-ai-next-step").count()) === 0);
    await context.close();
  }
  // #3837 서버(v1): 별칭·꼬리 칸 없음. 타임라인에 꼬리 없음, `@오르` 에 후보 없음.
  Object.assign(scenario, { v2: false, old: false });
  bag = { team_ai_fast_path: true, team_ai_agent_member_id: helper };
  {
    const { context, page } = await open(browser, origin, "light", viewport);
    await page.evaluate((id) => { location.hash = `/c/${id}`; }, marketing);
    await page.getByTestId("agent-card").first().waitFor({ timeout: 10_000 });
    await page.waitForTimeout(500);
    check("v1 서버: 꼬리 없음", (await page.getByTestId("team-ai-reply-meta").count()) === 0);
    await page.screenshot({ path: resolve(OUT_DIR, "c3893-4-v1-server-timeline-1440-light.png") });
    const input = page.locator("#composer-input");
    await input.click();
    await input.pressSequentially("@오르");
    await page.waitForTimeout(400);
    check("v1 서버: @오르 후보 없음", (await page.locator("[role='listbox'] [role='option']").count()) === 0);
    await context.close();
  }
}

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) throw new Error("dist/ is missing. Run npm run build first.");
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  try {
    for (const [scheme, viewport] of [
      ["light", { width: 1440, height: 900 }],
      ["dark", { width: 1440, height: 900 }],
      ["light", { width: 390, height: 844 }],
    ]) {
      await nextStepScenes(browser, preview.origin, scheme, viewport);
      await timelineScenes(browser, preview.origin, scheme, viewport);
    }
    await oldServerScenes(browser, preview.origin);
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
