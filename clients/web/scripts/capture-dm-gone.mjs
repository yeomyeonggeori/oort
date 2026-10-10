#!/usr/bin/env node
// =============================================================================
// 명부에서 빠진 상대(은퇴·정지된 에이전트)와의 DM 캡처 (#3675 · #3676). 서버 명부는 활성 멤버만
// 싣는다(`list_workspace_roster`: `m.status = 'active'`). 그래서 이 DM의 상대는 명부에 없다.
// 사이드바 행 · 채널 머리 · 컴포저 placeholder · 인박스 부제가 모두 같은 「나간 멤버」인지 라이트·다크
// 1440에서 찍는다. 백엔드는 없다(라우트 모의). 대기는 전부 실패할 수 있는 waitFor/expect다.
//
//   npm run build && node scripts/capture-dm-gone.mjs
//   OUT_DIR=… PREFIX=c3675 node scripts/capture-dm-gone.mjs
// =============================================================================
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/dm-gone");
const PREFIX = process.env.PREFIX || "c3675";
const PORT = Number(process.env.CAPTURE_PORT || 5199);

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const goneId = "00000000-0000-7000-8000-0000000001ff"; // 명부에 없다
const seoId = "00000000-0000-7000-8000-000000000102";
const DM_GONE = "00000000-0000-7000-8000-0000000003a1";
const DM_SEO = "00000000-0000-7000-8000-0000000003a2";
const channels = ["general", "workbench"].map((name, i) => ({
  id: `00000000-0000-7000-8000-00000000020${i + 1}`, workspaceId, kind: "public", name, muted: false,
}));
const dms = [
  { id: DM_GONE, workspaceId, kind: "dm", muted: false, memberIds: [memberId, goneId] },
  { id: DM_SEO, workspaceId, kind: "dm", muted: false, memberIds: [memberId, seoId] },
];
const person = (id, displayName, handle, extra = {}) => ({
  id, workspaceId, kind: "human", status: "active", displayName, handle, channelCount: 1, channelIds: [],
  capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...extra,
});
const roster = [person(memberId, "곽성재", "kwak", { role: "owner" }), person(seoId, "서연", "seoyeon")];
const NOW = Date.now();
const DAY = 86_400_000;
const msg = (channelId, seq, authorMemberId, body, daysAgo, extra = {}) => ({
  id: `00000000-0000-7000-8000-0000000004${channelId.slice(-2)}${String(seq).padStart(2, "0")}`,
  channelId, seq, hlcTs: NOW - daysAgo * DAY, hlcCount: 0, authorMemberId, type: "text", body,
  createdAtMs: NOW - daysAgo * DAY, ...extra,
});
const goneMessages = [
  msg(DM_GONE, 1, memberId, "ㅎㅇ", 8),
  msg(DM_GONE, 2, goneId, "이 에이전트는 호스트에 연결되지 않아 지금은 답하지 못해요.", 8, { type: "system", props: { kind: "agent_hosted_skip" } }),
  msg(DM_GONE, 3, memberId, "ㅎㅇ", 4),
  msg(DM_GONE, 4, goneId, "이 에이전트는 호스트에 연결되지 않아 지금은 답하지 못해요.", 4, { type: "system", props: { kind: "agent_hosted_skip" } }),
];
const seoMessages = [msg(DM_SEO, 1, seoId, "내일 리뷰 괜찮아요?", 1)];
const json = (route, body) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

async function open(browser, origin, scheme, hash) {
  const auth = {
    accessToken: "capture-only-not-a-credential", refreshToken: "capture-only-not-a-credential",
    member: { id: memberId, workspaceId, kind: "human", displayName: "곽성재", handle: "kwak" },
    realtimeWebSocketUrl: "ws://dm-gone-capture.invalid/connection/websocket",
  };
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme, serviceWorkers: "block" });
  await context.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId });
    if (path.endsWith("/channels")) return json(route, { channels: [...channels, ...dms] });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/read-state")) return json(route, { read_states: [
      { channel_id: DM_GONE, last_read_seq: 4, latest_seq: 4, unread_count: 0, mention_count: 0, marked_unread_before_seq: null },
      { channel_id: DM_SEO, last_read_seq: 0, latest_seq: 1, unread_count: 1, mention_count: 0, marked_unread_before_seq: null },
    ] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith(`/workspaces/${workspaceId}`)) return json(route, { workspace: { id: workspaceId, name: "여명거리" } });
    if (path.includes(DM_GONE) && path.endsWith("/messages")) return json(route, { messages: [...goneMessages].reverse(), nextBefore: 1 });
    if (path.includes(DM_SEO) && path.endsWith("/messages")) return json(route, { messages: seoMessages, nextBefore: 1 });
    if (path.includes("/messages")) return json(route, { messages: [] });
    return json(route, {});
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    class CaptureSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      constructor(url) { this.url = String(url); this.readyState = 0; queueMicrotask(() => { this.readyState = 1; this.onopen?.(new Event("open")); }); }
      send(data) {
        const replies = String(data).trim().split("\n").map((line) => {
          const c = JSON.parse(line);
          if (c.connect) return { id: c.id, connect: { client: "dm", version: "6" } };
          if (c.subscribe) return { id: c.id, subscribe: { recoverable: true, positioned: true, recovered: false, epoch: "cap", offset: 0 } };
          return { id: c.id };
        });
        queueMicrotask(() => this.onmessage?.(new MessageEvent("message", { data: replies.map((r) => JSON.stringify(r)).join("\n") })));
      }
      close() { this.readyState = 3; this.onclose?.(new CloseEvent("close", { code: 1000 })); }
    }
    window.WebSocket = CaptureSocket;
  });
  await page.addInitScript((server) => { try { localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ } }, origin);
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-item").first().waitFor({ timeout: 20_000 });
  await page.evaluate((h) => { location.hash = h; }, hash);
  return { context, page };
}

function expect(label, ok) {
  if (!ok) throw new Error(`실패: ${label}`);
  console.log("ok  ", label);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  try {
    for (const scheme of ["light", "dark"]) {
      // 1) 채널: 사이드바 행 · 머리 · 컴포저 · 타임라인(스켈레톤이 아니라 기록).
      const chat = await open(browser, preview.origin, scheme, `#/c/${DM_GONE}`);
      const p = chat.page;
      await p.getByTestId("channel-header").waitFor({ timeout: 20_000 });
      await p.waitForFunction(() => document.querySelector('[data-testid="channel-header"]')?.textContent?.includes("나간 멤버"), null, { timeout: 10_000 });
      const head = await p.getByTestId("channel-header").textContent();
      expect(`${scheme} 머리가 「나간 멤버」`, head.includes("나간 멤버") && !head.includes("다이렉트 메시지"));
      const rows = await p.getByTestId("channel-item").allTextContents();
      expect(`${scheme} 사이드바 행이 「나간 멤버」`, rows.some((t) => t.includes("나간 멤버")));
      expect(`${scheme} 사이드바에 「알 수 없는 멤버」가 없다`, !rows.some((t) => t.includes("알 수 없는 멤버")));
      const composer = await p.locator("#composer-input").first();
      await composer.waitFor({ timeout: 10_000 });
      const placeholder = await p.evaluate(() => document.querySelector("#composer-input")?.getAttribute("placeholder") ?? document.querySelector('[data-testid="composer-placeholder"]')?.textContent ?? "");
      expect(`${scheme} 컴포저 placeholder가 「나간 멤버에게」`, placeholder.includes("나간 멤버에게") && !placeholder.includes("다이렉트 메시지"));
      await p.waitForFunction(() => document.querySelectorAll('[data-testid="skeleton"][data-ready="false"]').length === 0, null, { timeout: 10_000 });
      expect(`${scheme} 타임라인이 스켈레톤에 머물지 않는다`, (await p.locator('[data-testid="chat-timeline"] [data-testid="skeleton"][data-ready="false"]').count()) === 0);
      const timelineText = await p.getByTestId("chat-timeline").textContent();
      expect(`${scheme} 글쓴이가 id 조각이 아니라 「나간 멤버」`, !timelineText.includes("00000000") && timelineText.includes("나간 멤버"));
      await p.screenshot({ path: resolve(OUT_DIR, `${PREFIX}-channel-${scheme}.png`) });
      await chat.context.close();
      // 2) 인박스: 부제 「DM · 나간 멤버」, 마지막 말은 내 것이라 「나」.
      const inbox = await open(browser, preview.origin, scheme, "#/inbox");
      const q = inbox.page;
      await q.getByTestId("inbox-route").waitFor({ timeout: 20_000 });
      await q.getByTestId("mailbox-row").first().waitFor({ timeout: 15_000 });
      await q.waitForFunction(() => document.querySelectorAll('[data-testid="skeleton"][data-ready="false"]').length === 0, null, { timeout: 15_000 });
      await q.getByTestId("mailbox-row").filter({ hasText: "나간 멤버" }).first().click();
      await q.getByTestId("inbox-reply-input").waitFor({ timeout: 10_000 });
      await q.getByTestId("inbox-context-row").first().waitFor({ timeout: 10_000 });
      await q.waitForTimeout(1200); // 스켈레톤 페이드가 끝난 뒤에 찍는다
      const inboxText = await q.getByTestId("inbox-route").textContent();
      expect(`${scheme} 인박스에 「나간 멤버」`, inboxText.includes("나간 멤버"));
      expect(`${scheme} 인박스에 「다이렉트 메시지」 이름 없음`, !/DM\s*·\s*다이렉트 메시지/.test(inboxText));
      await q.screenshot({ path: resolve(OUT_DIR, `${PREFIX}-inbox-${scheme}.png`) });
      await inbox.context.close();
      console.log("shots", scheme);
    }
  } finally {
    await browser.close();
    await preview.stop?.();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
