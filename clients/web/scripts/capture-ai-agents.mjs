#!/usr/bin/env node
// =============================================================================
// 「AI」 허브 › 에이전트 구획 캡처 (AIH-7, #3428): /ai/agents 표(팀 키 · 내 구독 · 남의 구독 잠금 · 개인 키 ·
// Claude 문의 중 · 외부)와 「에이전트 만들기」 3종 선택, 웹 라이트·다크.
//
//   npm run build && OUT_DIR=~/.cache/momo-scratch/3428/captures node scripts/capture-ai-agents.mjs
//
// 백엔드는 없다: `/v1/**`는 고정 응답, 실시간 소켓은 곧바로 연결되는 흉내다. 명부 행에는 서버가 내려주는
// brain · callableBy · owner · hostOnline · brainUnavailableReason 을 그대로 실었다.
// =============================================================================

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/ai-agents");
const PORT = Number(process.env.CAPTURE_PORT || 5233);

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const otherHuman = "00000000-0000-7000-8000-000000000102";
const channels = [{ id: "00000000-0000-7000-8000-000000000201", workspaceId, kind: "public", name: "general", muted: false }];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: "ws://ai-agents-capture.invalid/connection/websocket",
};
const base = { workspaceId, status: "active", channelCount: 1, channelIds: channels.map((c) => c.id), capabilities: [], createdAtMs: 0, updatedAtMs: 0 };
const human = (id, displayName, handle, role) => ({ ...base, id, kind: "human", displayName, handle, role });
const bot = (n, displayName, handle, extra) => ({ ...base, id: `00000000-0000-7000-8000-00000000030${n}`, kind: "agent", displayName, handle, paused: false, ...extra });
const ownedBy = (id, name) => ({ ownerHumanId: id, owner: { id, displayName: name } });
const roster = [
  human(memberId, "곽성재", "seongjae", "owner"),
  human(otherHuman, "서연", "seoyeon", "member"),
  bot(1, "김인턴", "kim-intern", { brain: "team_key", callableBy: "everyone", ...ownedBy(memberId, "곽성재") }),
  bot(2, "성재의 Codex", "seongjae-codex", { brain: "subscription", callableBy: "owner_only", hostOnline: true, ...ownedBy(memberId, "성재") }),
  bot(3, "서연의 Codex", "seoyeon-codex", { brain: "subscription", callableBy: "owner_only", hostOnline: false, ...ownedBy(otherHuman, "서연") }),
  bot(4, "성재의 API 키", "seongjae-key", { brain: "personal_key", callableBy: "owner_only", ...ownedBy(memberId, "성재") }),
  bot(5, "성재의 Claude Code", "seongjae-claude", {
    brain: "subscription", callableBy: "owner_only", hostOnline: true, brainUnavailableReason: "claude_subscription_agent_paused", ...ownedBy(memberId, "성재"),
  }),
  bot(6, "hermes", "hermes", { brain: "external", callableBy: "everyone" }),
];

// 하니스(C/X, 「내 구독 (Claude Code)」)는 호스티드 연결 목록에서 온다.
const conn = (n, agentMemberId, extra) => ({
  id: `c-${n}`, agentMemberId, status: "active", authMode: "bearer", audience: "oort", approvedChannelIds: [], approvedScopes: [],
  createdAtMs: n, updatedAtMs: n, ...extra,
});
const id = (n) => `00000000-0000-7000-8000-00000000030${n}`;
const connections = [
  conn(1, id(2), { invocationScope: "owner_only", subscriptionHarness: "codex" }),
  conn(2, id(3), { invocationScope: "owner_only", subscriptionHarness: "codex" }),
  conn(3, id(5), { invocationScope: "owner_only", subscriptionHarness: "claude_code" }),
  conn(4, id(6), { invocationScope: "workspace" }),
];
// 장면마다 서버 답이 달라진다.
const scenario = { role: "owner", members: "full", rosterDelayMs: 0, rosterError: false };
const ROSTER_MEMBERS = () => {
  if (scenario.members === "empty") return roster.filter((m) => m.kind === "human").map((m) => (m.id === memberId ? { ...m, role: scenario.role } : m));
  return roster.map((m) => (m.id === memberId ? { ...m, role: scenario.role } : m));
};

const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function installRoutes(context) {
  await context.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId });
    }
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) {
      if (scenario.rosterError) return json(route, { error: { code: "internal", message: "boom" } }, 500);
      if (scenario.rosterDelayMs > 0) await new Promise((r) => setTimeout(r, scenario.rosterDelayMs));
      return json(route, { members: ROSTER_MEMBERS() });
    }
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/hosted-agent-connections")) return json(route, { connections: scenario.role === "owner" ? connections : [] });
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

async function installDesktop(page) {
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
  }, [{ id: "claude", installed: true, auth: "logged_in" }, { id: "codex", installed: true, auth: "logged_in" }]);
}

const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok) failures.push(name);
}
const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const cell = (page, kind, handle) =>
  page.getByTestId(`ai-agent-${kind}-${handle}`).evaluate((td) => {
    const copy = td.cloneNode(true);
    copy.querySelectorAll("[data-cell-label]").forEach((el) => el.remove());
    return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
  });

async function open(browser, origin, scheme, viewport, desktop = false) {
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
  Object.assign(scenario, { role: "owner", members: "full", rosterDelayMs: 0, rosterError: false });
  const { context, page } = await open(browser, origin, scheme, viewport);
  try {
    if ((await page.getByTestId("sidebar-toggle").getAttribute("aria-expanded")) === "false") {
      await page.getByTestId("sidebar-toggle").click();
      await page.waitForTimeout(400);
    }
    await page.goto(`${origin}/#/ai/agents`);
    await page.getByTestId("ai-agents-table").waitFor();
    await page.waitForTimeout(800);
    await page.screenshot({ path: resolve(OUT_DIR, `agents-table-${tag}.png`) });

    check(`${tag} 머리: 쓰는 AI · 부를 수 있는 사람 · 비용 · 상태`, JSON.stringify(await page.locator("thead th").allTextContents()) === JSON.stringify(["에이전트", "쓰는 AI", "부를 수 있는 사람", "비용", "상태"]));
    check(`${tag} 여섯 줄`, (await page.locator("tbody tr").count()) === 6);
    check(`${tag} 팀 키: 팀 AI 키 · 누구나 · 팀`, (await cell(page, "brain", "kim-intern")) === "팀 AI 키" && (await cell(page, "callable", "kim-intern")) === "누구나" && (await cell(page, "cost", "kim-intern")) === "팀");
    check(`${tag} 내 구독 (Codex) · 나만 · 내 맥 켜짐`, (await cell(page, "brain", "seongjae-codex")) === "내 구독 (Codex)" && (await cell(page, "callable", "seongjae-codex")) === "나만" && (await cell(page, "status", "seongjae-codex")) === "내 맥 켜짐");
    const other = await cell(page, "callable", "seoyeon-codex");
    check(`${tag} 남의 구독: 서연 님만 + 잠금 + 맥 꺼짐`, other.startsWith("서연 님만") && (await page.getByTestId("ai-agent-row-seoyeon-codex").getAttribute("data-locked")) === "true" && (await cell(page, "status", "seoyeon-codex")).includes("팀 키로 대신하지 않아요"));
    check(`${tag} 개인 키: 개인 키 · 나만 · 개인 키`, (await cell(page, "brain", "seongjae-key")) === "개인 키" && (await cell(page, "callable", "seongjae-key")) === "나만" && (await cell(page, "cost", "seongjae-key")) === "개인 키");
    const paused = await cell(page, "status", "seongjae-claude");
    check(`${tag} Claude: 문의 중 + 설명, 맥 켜짐 없음`, paused.includes("문의 중") && paused.includes("Anthropic 약관 확인 전까지") && !paused.includes("맥 켜짐"), paused);
    check(`${tag} 외부: 외부 (직접 운영) · 누구나 · 외부 운영자`, (await cell(page, "brain", "hermes")) === "외부 (직접 운영)" && (await cell(page, "cost", "hermes")) === "외부 운영자");
    check(`${tag} 문서 가로 넘침 0`, (await overflowX(page)) === 0);

    await page.getByTestId("ai-agents-create").click();
    await page.getByTestId("create-agent-chooser").waitFor();
    await page.waitForTimeout(500);
    await page.screenshot({ path: resolve(OUT_DIR, `agents-create-chooser-${tag}.png`) });
    check(`${tag} 만들기: 팀 · 내 구독(잠김, 데스크탑에서) · 외부`,
      (await page.getByTestId("create-kind-team").getAttribute("data-state")) === "available" &&
      (await page.getByTestId("create-kind-mySubscription").getAttribute("data-state")) === "locked" &&
      (await page.getByTestId("create-kind-mySubscription-audience").textContent()) === "데스크탑에서 해요" &&
      (await page.getByTestId("create-kind-external").getAttribute("data-state")) === "available");
    check(`${tag} 만들기 창 가로 넘침 0`, (await overflowX(page)) === 0);
    await page.keyboard.press("Escape");
    await page.getByTestId("create-agent-chooser").waitFor({ state: "detached" });
    await page.waitForTimeout(300);
    const focused = await page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.tagName);
    check(`${tag} Esc 로 닫으면 만들기 단추로 포커스가 돌아온다`, focused === "ai-agents-create", String(focused));

    await page.goto(`${origin}/#/agents`);
    await page.getByTestId("agent-hub-to-ai").waitFor();
    await page.waitForTimeout(600);
    await page.screenshot({ path: resolve(OUT_DIR, `agents-page-one-liner-${tag}.png`) });
    await page.getByTestId("agent-hub-to-ai").click();
    await page.getByTestId("ai-agents-table").waitFor();
    check(`${tag} /agents 한 줄 「설정·권한·비용은 AI에서」 → /ai/agents`, page.url().endsWith("#/ai/agents"), page.url());
  } finally {
    await context.close();
  }
}

const BG = (page, testId) => page.getByTestId(testId).evaluate((el) => getComputedStyle(el).backgroundColor);

async function expandSidebar(page) {
  if ((await page.getByTestId("sidebar-toggle").getAttribute("aria-expanded")) === "false") {
    await page.getByTestId("sidebar-toggle").click();
    await page.waitForTimeout(400);
  }
}

// 넓이별 표. 420 은 카드로 접힌 표 전체가 한 장에 들어오게 창을 세로로 길게 연다.
async function widthScenes(browser, origin, scheme, viewport) {
  const tag = `${viewport.width}-${scheme}`;
  Object.assign(scenario, { role: "owner", members: "full", rosterDelayMs: 0, rosterError: false });
  const { context, page } = await open(browser, origin, scheme, viewport);
  try {
    await expandSidebar(page);
    await page.goto(`${origin}/#/ai/agents`);
    await page.getByTestId("ai-agents-table").waitFor();
    await page.waitForTimeout(800);
    await page.screenshot({ path: resolve(OUT_DIR, `v2-table-harness-${tag}.png`) });
    check(`${tag} 하니스: 내 구독 (Codex) / 내 구독 (Claude Code) + C·X 마크`,
      (await cell(page, "brain", "seongjae-codex")) === "내 구독 (Codex)" && (await cell(page, "brain", "seongjae-claude")) === "내 구독 (Claude Code)" &&
      (await page.getByTestId("ai-agent-row-seongjae-codex").locator("th").textContent()).includes("X") &&
      (await page.getByTestId("ai-agent-row-seongjae-claude").locator("th").textContent()).includes("C"));
    const nameBox = await page.getByTestId("ai-agent-link-seongjae-claude").boundingBox();
    check(`${tag} 이름 한 줄(높이 ${Math.round(nameBox.height)})`, viewport.width < 1024 || nameBox.height < 24, String(nameBox.height));
    const tone = (h) => page.getByTestId(`ai-agent-callable-${h}`).locator("[data-tone]").getAttribute("data-tone");
    check(`${tag} 「나만」 회색, 「서연 님만」 호박색`, (await tone("seongjae-codex")) === "mute" && (await tone("seoyeon-codex")) === "warn");
    check(`${tag} 문서 가로 넘침 0`, (await overflowX(page)) === 0);
    const region = await page.locator("[role='region']").evaluate((el) => ({ over: el.scrollWidth > el.clientWidth + 1, tab: el.getAttribute("tabindex") }));
    check(`${tag} 스크롤 영역 정차점은 넘칠 때만`, region.over === (region.tab === "0"), JSON.stringify(region));
    await page.getByTestId("ai-agent-link-seongjae-codex").click();
    await page.getByTestId("agent-hub-route").waitFor();
    await page.waitForTimeout(600);
    check(`${tag} 이름 링크 → /agents 에서 그 에이전트가 열린다`, page.url().includes("agent=") && (await page.getByTestId("agent-hub-agent-row").evaluateAll((els) => els.some((e) => e.getAttribute("aria-current") === "page" && e.textContent.includes("seongjae-codex")))));
    if (viewport.width > 700) {
      await page.screenshot({ path: resolve(OUT_DIR, `v2-agents-list-chips-${tag}.png`) });
      const chips = await page.getByTestId("agent-hub-agent-row").evaluateAll((els) => els.map((e) => e.textContent));
      const claude = chips.find((t) => t.includes("seongjae-claude")) ?? "";
      const seoyeon = chips.find((t) => t.includes("seoyeon-codex")) ?? "";
      check(`${tag} /agents 칩이 표와 같다: 문의 중 / 맥 꺼짐`, claude.includes("문의 중") && seoyeon.includes("맥 꺼짐"), JSON.stringify([claude, seoyeon]));
    }
  } finally {
    await context.close();
  }
}

// 일반 멤버 / 빈 / 불러오는 중 / 못 읽음 / 데스크탑에서 셋 다 열린 선택 창.
async function stateScenes(browser, origin, scheme) {
  const viewport = { width: 1440, height: 900 };
  const tag = `1440-${scheme}`;
  const run = async (name, setup, body, desktop = false) => {
    Object.assign(scenario, { role: "owner", members: "full", rosterDelayMs: 0, rosterError: false }, setup);
    const { context, page } = await open(browser, origin, scheme, viewport, desktop);
    try {
      await expandSidebar(page);
      await page.goto(`${origin}/#/ai/agents`);
      await body(page);
    } finally {
      await context.close();
    }
  };
  await run("member", { role: "member" }, async (page) => {
    await page.getByTestId("ai-hub-pane-agents").waitFor();
    await page.getByTestId("ai-agents-table").waitFor();
    await page.waitForTimeout(600);
    await page.screenshot({ path: resolve(OUT_DIR, `v2-non-admin-${tag}.png`) });
    check(`${tag} 일반 멤버: 만들기 단추 없음, 표는 보임`, (await page.getByTestId("ai-agents-create").count()) === 0 && (await page.locator("tbody tr").count()) === 6);
  });
  await run("empty-owner", { members: "empty" }, async (page) => {
    await page.getByTestId("ai-agents-empty").waitFor();
    await page.waitForTimeout(500);
    await page.screenshot({ path: resolve(OUT_DIR, `v2-empty-owner-${tag}.png`) });
    const btn = page.getByTestId("ai-agents-empty").getByRole("button", { name: "에이전트 만들기" });
    check(`${tag} 빈 상태: 만들기 단추 type=button`, (await btn.getAttribute("type")) === "button");
  });
  await run("empty-member", { members: "empty", role: "member" }, async (page) => {
    await page.getByTestId("ai-agents-empty").waitFor();
    await page.waitForTimeout(500);
    await page.screenshot({ path: resolve(OUT_DIR, `v2-empty-member-${tag}.png`) });
  });
  await run("loading", { rosterDelayMs: 15000 }, async (page) => {
    // 로그인 직후 명부가 늦다: 허브 쪽 로딩 표시를 잡는다.
    await page.getByTestId("ai-agents-loading").waitFor({ timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(400);
    await page.screenshot({ path: resolve(OUT_DIR, `v2-loading-${tag}.png`) });
    check(`${tag} 로딩: 상태 영역이 보인다`, (await page.getByTestId("ai-agents-loading").count()) === 1 || (await page.getByTestId("ai-agents-table").count()) === 0);
  });
  await run("error", { rosterError: true }, async (page) => {
    await page.getByTestId("ai-agents-error").waitFor({ timeout: 20000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: resolve(OUT_DIR, `v2-error-${tag}.png`) });
    check(`${tag} 오류: 다시 불러오기`, (await page.getByTestId("ai-agents-error").textContent()).includes("다시 불러오기"));
  });
  await run("chooser-desktop", {}, async (page) => {
    await page.getByTestId("ai-agents-table").waitFor();
    await page.getByTestId("ai-agents-create").click();
    await page.getByTestId("create-agent-chooser").waitFor();
    await page.waitForFunction(() => document.querySelector("[data-testid='create-kind-mySubscription']")?.getAttribute("data-state") === "available", null, { timeout: 8000 });
    await page.mouse.move(5, 5);
    await page.waitForTimeout(400);
    await page.screenshot({ path: resolve(OUT_DIR, `v2-chooser-all-unlocked-${tag}.png`) });
    check(`${tag} 데스크탑: 셋 다 열림`, (await page.locator("[data-testid^='create-kind-'][data-state]").evaluateAll((els) => els.map((e) => e.getAttribute("data-state")))).join() === "available,available,available");
    check(`${tag} 대상 칩: 소유자·관리자 / 데스크탑 / 소유자·관리자`, [await page.getByTestId("create-kind-team-audience").textContent(), await page.getByTestId("create-kind-mySubscription-audience").textContent(), await page.getByTestId("create-kind-external-audience").textContent()].join() === "소유자·관리자,데스크탑,소유자·관리자");
  }, true);
}

// 420 선택 창: 첫 줄 채움이 hover 인지(마우스가 단추 자리에 남아 있어서) 포커스인지 가른다.
async function chooser420(browser, origin, scheme) {
  const tag = `420-${scheme}`;
  Object.assign(scenario, { role: "owner", members: "full", rosterDelayMs: 0, rosterError: false });
  const { context, page } = await open(browser, origin, scheme, { width: 420, height: 900 });
  try {
    await page.goto(`${origin}/#/ai/agents`);
    await page.getByTestId("ai-agents-table").waitFor();
    await page.getByTestId("ai-agents-create").click();
    await page.getByTestId("create-agent-chooser").waitFor();
    await page.waitForTimeout(500);
    const atClick = await BG(page, "create-kind-team");
    await page.screenshot({ path: resolve(OUT_DIR, `v2-chooser-mouse-over-${tag}.png`) });
    await page.mouse.move(5, 5);
    await page.waitForTimeout(300);
    const away = await BG(page, "create-kind-team");
    await page.screenshot({ path: resolve(OUT_DIR, `v2-chooser-mouse-away-${tag}.png`) });
    const focused = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
    check(`${tag} 첫 줄 채움은 hover 다: 마우스를 치우면 채움이 사라진다 (클릭 자리 ${atClick} → 치운 뒤 ${away}, 포커스 ${focused})`, atClick !== away);
  } finally {
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
      for (const viewport of [{ width: 1440, height: 900 }, { width: 420, height: 900 }]) {
        await scenes(browser, preview.origin, scheme, viewport);
      }
      await widthScenes(browser, preview.origin, scheme, { width: 900, height: 700 });
      await widthScenes(browser, preview.origin, scheme, { width: 420, height: 2000 });
      await chooser420(browser, preview.origin, scheme);
      await stateScenes(browser, preview.origin, scheme);
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
