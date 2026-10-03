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
    if (path.endsWith("/roster")) return json(route, { members: roster });
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
const cell = (page, kind, handle) =>
  page.getByTestId(`ai-agent-${kind}-${handle}`).evaluate((td) => {
    const copy = td.cloneNode(true);
    copy.querySelectorAll("[data-cell-label]").forEach((el) => el.remove());
    return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
  });

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

async function scenes(browser, origin, scheme, viewport) {
  const tag = `${viewport.width}-${scheme}`;
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
    check(`${tag} 내 구독: 내 구독 · 나만 · 내 맥 켜짐`, (await cell(page, "brain", "seongjae-codex")) === "내 구독" && (await cell(page, "callable", "seongjae-codex")) === "나만" && (await cell(page, "status", "seongjae-codex")) === "내 맥 켜짐");
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
