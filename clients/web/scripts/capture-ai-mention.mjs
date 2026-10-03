#!/usr/bin/env node
// =============================================================================
// 멘션 자동완성 주석 + composer 위 한 줄 캡처 (AIH-9, #3439): 하늘 님 화면에서 @ 를 열어 팀 키 · 내 구독 ·
// 남의 구독(잠금, 맥 꺼짐) · 개인 키 · 문의 중 · 외부 후보와, 못 부르는 에이전트를 부르는 글의 한 줄.
//
//   npm run build && OUT_DIR=/path/to/captures-3439 node scripts/capture-ai-mention.mjs
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
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/ai-mention");
const PORT = Number(process.env.CAPTURE_PORT || 5237);

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
// 보는 사람은 하늘 님(member)이다. 성재 님의 구독·키 에이전트는 하늘 님이 부를 수 없다.
const roster = [
  bot(1, "김인턴", "kim-intern", { brain: "team_key", callableBy: "everyone", ...ownedBy(otherHuman, "성재") }),
  bot(2, "하늘의 Codex", "haneul-codex", { brain: "subscription", callableBy: "owner_only", hostOnline: true, ...ownedBy(memberId, "하늘") }),
  bot(3, "성재의 Codex", "seongjae-codex", { brain: "subscription", callableBy: "owner_only", hostOnline: false, ...ownedBy(otherHuman, "성재") }),
  bot(4, "성재의 API 키", "seongjae-key", { brain: "personal_key", callableBy: "owner_only", ...ownedBy(otherHuman, "성재") }),
  bot(5, "성재의 Claude Code", "seongjae-claude", {
    brain: "subscription", callableBy: "owner_only", hostOnline: true, brainUnavailableReason: "claude_subscription_agent_paused", ...ownedBy(otherHuman, "성재"),
  }),
  bot(6, "hermes", "hermes", { brain: "external", callableBy: "everyone" }),
  human(memberId, "하늘", "haneul", "member"),
  human(otherHuman, "성재", "seongjae", "owner"),
  bot(7, "하늘의 Claude Code", "haneul-claude", {
    brain: "subscription", callableBy: "owner_only", hostOnline: true, brainUnavailableReason: "claude_subscription_agent_paused", ...ownedBy(memberId, "하늘"),
  }),
];
const message = {
  id: "00000000-0000-7000-8000-000000000301", channelId: channels[0].id, seq: 1, authorMemberId: otherHuman,
  body: "이번 주 배포 정리해 줄 사람?", type: "text", state: "sent", createdAtMs: 1_800_000_000_000, hlcTs: 1_800_000_000_000, hlcCount: 0,
};
// 장면마다 서버 답이 달라진다.
const scenario = { role: "member", members: "full", rosterDelayMs: 0, rosterError: false };
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
    if (path.endsWith("/hosted-agent-connections")) return json(route, { connections: [] });
    if (path.endsWith(`/workspaces/${workspaceId}`)) {
      return json(route, { workspace: { id: workspaceId, name: "여명거리", slug: "team", updatedAtMs: 1, roleLabels: {}, welcomeAgentMemberId: null, welcomePrompt: "", subscriptionAgentsEnabled: true } });
    }
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: [] });
    if (path.endsWith("/work-sessions/shared")) return json(route, { sessions: [], nextCursor: null });
    if (path.endsWith("/work-sessions")) return json(route, { workSessions: [] });
    if (path.includes("/messages")) return json(route, { messages: [message] });
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
  await page.evaluate((id) => { window.location.hash = `#/c/${id}`; }, channels[0].id);
  await page.locator("#composer-input").waitFor({ timeout: 15_000 });
  await page.waitForTimeout(400);
  return { context, page };
}

const lineOf = (page, handle) =>
  page.locator("[data-testid='composer-mention-option']").filter({ hasText: `@${handle}` }).first();

async function scenes(browser, origin, scheme, viewport) {
  const tag = `${viewport.width}-${scheme}`;
  const { context, page } = await open(browser, origin, scheme, viewport);
  try {
    const input = page.locator("#composer-input");
    await input.click();
    await page.keyboard.type("배포 요약 부탁해요 @");
    await page.getByTestId("composer-mention-list").waitFor();
    await page.waitForTimeout(300);
    await page.screenshot({ path: resolve(OUT_DIR, `mention-list-${tag}.png`) });
    const text = (handle, sel) => lineOf(page, handle).locator(`[data-testid='${sel}']`).textContent();
    check(`${tag} 팀 키: 팀 키 · 누구나`, (await text("kim-intern", "mention-agent-line")) === "팀 키 · 누구나");
    check(`${tag} 내 구독: 내 구독 · 나만 부를 수 있어요`, (await text("haneul-codex", "mention-agent-line")) === "내 구독 · 나만 부를 수 있어요");
    check(`${tag} 남의 구독: 성재 님 개인 구독 · 성재 님만 부를 수 있어요 · 맥 꺼짐`, (await text("seongjae-codex", "mention-agent-line")) === "성재 님 개인 구독 · 성재 님만 부를 수 있어요 · 맥 꺼짐");
    check(`${tag} 개인 키: 개인 키 · 성재 님만`, (await text("seongjae-key", "mention-agent-line")) === "개인 키 · 성재 님만");
    check(`${tag} 문의 중 꼬리`, (await text("seongjae-claude", "mention-agent-line")).endsWith("· 문의 중"));
    check(`${tag} 외부: 외부 · 누구나`, (await text("hermes", "mention-agent-line")) === "외부 · 누구나");
    for (const h of ["seongjae-codex", "seongjae-key", "seongjae-claude"]) {
      check(`${tag} ${h} 잠금`, (await lineOf(page, h).getAttribute("data-locked")) !== null);
    }
    for (const h of ["kim-intern", "haneul-codex", "hermes"]) {
      check(`${tag} ${h} 잠금 아님`, (await lineOf(page, h).getAttribute("data-locked")) === null);
    }
    check(`${tag} 가로 넘침 0`, (await overflowX(page)) === 0);
    const box = await page.getByTestId("composer-mention-list").boundingBox();
    check(`${tag} 목록이 화면 안`, box.x >= 0 && box.x + box.width <= viewport.width, JSON.stringify(box));

    // 남의 구독을 골라 보내기 전
    await lineOf(page, "seongjae-codex").click();
    await page.keyboard.type("배포 요약 부탁해요");
    const notice = page.getByTestId("composer-agent-notice");
    await notice.waitFor();
    await page.waitForTimeout(300);
    await page.screenshot({ path: resolve(OUT_DIR, `composer-locked-notice-${tag}.png`) });
    check(`${tag} 한 줄: 못 부름`, ((await notice.textContent()) ?? "").endsWith("성재 님만 부를 수 있어요. 보내도 답하지 않아요."), String(await notice.textContent()));

    // Claude 문의 중 (내 에이전트)
    await input.fill("@haneul-claude 요약 부탁해요");
    await notice.waitFor();
    await page.waitForTimeout(300);
    await page.screenshot({ path: resolve(OUT_DIR, `composer-paused-notice-${tag}.png`) });
    check(`${tag} 한 줄: 문의 중`, ((await notice.textContent()) ?? "").includes("약관 확인 전까지 쉬고 있어요"));
    check(`${tag} 한 줄 가로 넘침 0`, (await overflowX(page)) === 0);

    // 부를 수 있는 에이전트는 한 줄이 없다
    await input.fill("@kim-intern 요약 부탁해요");
    await page.waitForTimeout(200);
    check(`${tag} 팀 키 에이전트는 한 줄 없음`, (await page.getByTestId("composer-agent-notice").count()) === 0);
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
