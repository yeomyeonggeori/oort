#!/usr/bin/env node
// =============================================================================
// 사이드바 하단 프로필 행 캡처 (#3574). 구분 띠 없이 목록 끝에 이어지는 한 줄
// (아바타+상태 점, 굵은 이름, 둘째 줄 상태/워크스페이스)과 접힘(⌘B) 레일의 아바타를
// 라이트·다크, 상태 메시지 유무, 긴 이름, 좁은 폭에서 찍는다. 백엔드는 없다.
//
//   npm run build && node scripts/capture-sidebar-profile-foot.mjs
//   OUT_DIR=… PREFIX=c3574 node scripts/capture-sidebar-profile-foot.mjs
// =============================================================================
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/sidebar-profile-foot");
const PREFIX = process.env.PREFIX || "c3574";
const PORT = Number(process.env.CAPTURE_PORT || 5197);

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const channels = ["general", "workbench", "agent-lab", "design-2-0", "release"].map((name, i) => ({
  id: `00000000-0000-7000-8000-00000000020${i + 1}`, workspaceId, kind: "public", name, muted: false,
}));
const json = (route, body) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

const SCENES = {
  status: { displayName: "곽성재", handle: "seongjae", presenceStatus: "auto", statusEmoji: "🏝️", statusText: "휴가 중, 금요일에 돌아와요" },
  plain: { displayName: "곽성재", handle: "seongjae", presenceStatus: "auto" },
  dnd: { displayName: "곽성재", handle: "seongjae", presenceStatus: "dnd", statusEmoji: "🎧", statusText: "집중 작업" },
  long: { displayName: "Alexandria Montgomery-Wellington", handle: "alexandria", presenceStatus: "away", statusEmoji: "📅", statusText: "분기 회고 준비로 오후 내내 자리를 비웁니다" },
};

async function open(browser, origin, scheme, viewport, scene, collapsed) {
  const member = SCENES[scene];
  const roster = [{
    id: memberId, workspaceId, kind: "human", status: "active", role: "owner", displayName: member.displayName,
    handle: member.handle, channelCount: channels.length, channelIds: channels.map((c) => c.id), capabilities: [],
    presenceStatus: member.presenceStatus, statusEmoji: member.statusEmoji, statusText: member.statusText,
    createdAtMs: 0, updatedAtMs: 0,
  }];
  const auth = {
    accessToken: "capture-only-not-a-credential", refreshToken: "capture-only-not-a-credential",
    member: { id: memberId, workspaceId, kind: "human", displayName: member.displayName, handle: member.handle },
    realtimeWebSocketUrl: "ws://sidebar-foot-capture.invalid/connection/websocket",
  };
  const context = await browser.newContext({ viewport, colorScheme: scheme, serviceWorkers: "block" });
  await context.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId });
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith(`/workspaces/${workspaceId}`)) return json(route, { workspace: { id: workspaceId, name: "여명거리" } });
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
          if (c.connect) return { id: c.id, connect: { client: "foot", version: "6" } };
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
  if (collapsed) await page.addInitScript(() => { try { localStorage.setItem("momo.web.shell.listColumn.collapsed.v1", "1"); } catch { /* 저장소 없는 캡처 */ } });
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("profile-card").waitFor({ timeout: 20_000 });
  await page.waitForTimeout(700);
  return { context, page };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  const jobs = [];
  for (const scheme of ["light", "dark"]) {
    for (const scene of ["status", "plain", "dnd", "long"]) {
      jobs.push({ scheme, scene, collapsed: false, viewport: { width: 1280, height: 800 } });
    }
    jobs.push({ scheme, scene: "status", collapsed: true, viewport: { width: 1280, height: 800 } });
    jobs.push({ scheme, scene: "plain", collapsed: true, viewport: { width: 1280, height: 800 } });
    jobs.push({ scheme, scene: "long", collapsed: false, viewport: { width: 900, height: 600 }, tag: "narrow" });
    jobs.push({ scheme, scene: "long", collapsed: false, viewport: { width: 390, height: 780 }, tag: "phone", drawer: true });
  }
  try {
    for (const job of jobs) {
      const { context, page } = await open(browser, preview.origin, job.scheme, job.viewport, job.scene, job.collapsed);
      if (job.drawer) {
        await page.getByTestId("open-sidebar-drawer").first().click();
        await page.waitForTimeout(500);
      }
      const name = `${PREFIX}-${job.tag ?? "web"}-${job.scene}-${job.collapsed ? "collapsed" : "expanded"}-${job.scheme}`;
      await page.screenshot({ path: resolve(OUT_DIR, `${name}-full.png`) });
      const h = job.viewport.height;
      const w = job.collapsed ? 120 : Math.min(job.viewport.width, 360);
      const top = Math.max(0, h - 220);
      await page.screenshot({ path: resolve(OUT_DIR, `${name}.png`), clip: { x: 0, y: top, width: w, height: h - top } });
      console.log("shot", name);
      await context.close();
    }
  } finally {
    await browser.close();
    await preview.stop?.();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
