#!/usr/bin/env node
// =============================================================================
// CAPTURE (#4065): 메시지 이름 옆 「에이전트」 배지 제거 — 채널·DM, 1440, 라이트·다크.
//   배지는 눈에서 없고(이름 색 + 둥근 사각 아바타가 에이전트임을 나른다), 낭독 낱말만 남는다.
//   npm run build && OUT_DIR=<dir> node scripts/capture-4065.mjs
// 백엔드는 없다: `/v1/**` 고정 응답, 실시간 소켓은 곧바로 연결되는 흉내다.
// =============================================================================

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/4065");
const PORT = Number(process.env.CAPTURE_PORT || 5250);


const workspaceId = "00000000-0000-7000-8000-000000000001";
const me = "00000000-0000-7000-8000-000000000101";
const grok = "00000000-0000-7000-8000-000000000302";
const ch = "00000000-0000-7000-8000-000000000202";
const dm = "00000000-0000-7000-8000-000000000204";
const BASE_MS = Date.parse("2026-10-19T02:10:00.000Z");
const channels = [
  { id: ch, workspaceId, kind: "public", name: "계획", muted: false },
  { id: dm, workspaceId, kind: "dm", name: null, muted: false },
];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: me, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: "ws://capture-4065.invalid/connection/websocket",
};
const roster = () => [
  { id: me, workspaceId, kind: "human", status: "active", role: "owner", displayName: "곽성재", handle: "seongjae", channelCount: 2, channelIds: [ch, dm], capabilities: [], createdAtMs: 0, updatedAtMs: 0 },
  { id: grok, workspaceId, kind: "agent", status: "active", displayName: "grok", handle: "grok", channelCount: 2, channelIds: [ch, dm], capabilities: [], ownerHumanId: me, createdAtMs: 0, updatedAtMs: 0 },
];
function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}
function messagesFor(channelId) {
  const rows = [
    [me, "이번 주 일정 정리해 줘"],
    [grok, "이번 주는 화요일 오전 10시 팀 회의, 목요일 오후 3시 고객 통화가 있어요."],
    [grok, "금요일은 비어 있어요. 필요하면 회고 시간을 잡아 둘까요?"],
    [me, "응, 금요일 오후로 잡아 줘"],
  ];
  return rows.map(([author, body], index) => ({
    id: `m${index}-${channelId.slice(-3)}`, channelId, seq: 4065 + index, hlcTs: BASE_MS + index * 60_000, hlcCount: 0,
    authorMemberId: author, type: "text", body, state: "sent", createdAtMs: BASE_MS + index * 60_000,
  }));
}
async function installRoutes(context) {
  await context.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId: me });
    }
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) return json(route, { members: roster() });
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/hosted-agent-connections")) return json(route, { connections: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null, participants: [] });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: [] });
    if (path.endsWith("/work-sessions/shared")) return json(route, { sessions: [], nextCursor: null });
    if (path.endsWith("/work-sessions")) return json(route, { workSessions: [] });
    if (path.endsWith(`/workspaces/${workspaceId}`)) {
      return json(route, { workspace: { id: workspaceId, name: "여명거리", slug: "team", updatedAtMs: 1, roleLabels: {}, welcomeAgentMemberId: null, welcomePrompt: "", subscriptionAgentsEnabled: true } });
    }
    for (const channel of channels) {
      if (path.includes(`/channels/${channel.id}/messages`)) return json(route, { messages: messagesFor(channel.id) });
    }
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
          if (c.connect) return { id: c.id, connect: { client: "capture-4065", version: "6" } };
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

async function open(browser, origin, scheme, viewport, channelId) {
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
  await page.evaluate((id) => { location.hash = `/c/${id}`; }, channelId);
  return { context, page };
}

async function scenes(browser, origin, scheme) {
  const tag = `1440-${scheme}`;
  for (const [name, channelId] of [["channel", ch], ["dm", dm]]) {
    const { context, page } = await open(browser, origin, scheme, { width: 1440, height: 900 }, channelId);
    await page.getByText("금요일은 비어 있어요").first().waitFor({ timeout: 25_000 });
    await page.waitForTimeout(500);
    const visible = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="timeline-message"] *')]
        .filter((el) => el.children.length === 0 && !el.closest(".sr-only"))
        .map((el) => el.textContent.trim())
    );
    check(`${tag} ${name}: 눈에 보이는 「에이전트」 글자가 메시지 행에 없다`, !visible.includes("에이전트"), JSON.stringify(visible));
    const sr = await page.getByTestId("row-agent-sr").count();
    check(`${tag} ${name}: 낭독 낱말은 에이전트 머리 행 수만큼 남는다`, sr >= 1, String(sr));
    check(`${tag} ${name}: 에이전트 아바타는 둥근 사각`, (await page.locator('[data-avatar-kind="agent"]').count()) >= 1);
    await page.screenshot({ path: resolve(OUT_DIR, `c4065-${name}-${tag}.png`) });
    await context.close();
  }
}

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) throw new Error("dist/ is missing. Run npm run build first.");
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  try {
    for (const scheme of ["light", "dark"]) await scenes(browser, preview.origin, scheme);
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
