#!/usr/bin/env node
// =============================================================================
// 사이드바 섹션 머리 호버 강조 면과 빈 섹션 문구 (#4108).
//
//   npm run build && OUT_DIR=<dir> node scripts/capture-4108.mjs
//   (전 판 번들은 DIST_DIR=dist-before 로 서빙한다. 그 판에서는 단언이 일부 틀리는 것이 정상이다.)
// 단언이 하나라도 틀리면 종료 코드 1이다.
// =============================================================================
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/4108");
const PORT = Number(process.env.CAPTURE_PORT || 5312);

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const channels = [
  { id: "00000000-0000-7000-8000-000000000201", workspaceId, kind: "public", name: "workbench", muted: false },
  { id: "00000000-0000-7000-8000-000000000202", workspaceId, kind: "public", name: "agent-lab", muted: false },
  { id: "00000000-0000-7000-8000-000000000203", workspaceId, kind: "public", name: "general", muted: false },
  { id: "00000000-0000-7000-8000-000000000204", workspaceId, kind: "private", name: "design-2.0", muted: false },
];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: "ws://work-tab-capture.invalid/connection/websocket",
};
const roster = [
  {
    id: memberId, workspaceId, kind: "human", status: "active", role: "owner", displayName: "곽성재",
    handle: "seongjae", channelCount: 4, channelIds: channels.map((c) => c.id), capabilities: [],
    createdAtMs: 0, updatedAtMs: 0,
  },
];

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function installRoutes(context) {
  await context.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId });
    }
    if (path.endsWith("/members/me/sidebar-prefs")) {
      return json(route, { prefs: { version: 1, starredChannelIds: [], sections: [
        { id: "sec-launch", name: "출시준비", order: 0, channelIds: [channels[1].id] },
        { id: "sec-empty", name: "나중에 볼 것", order: 1, channelIds: [] },
      ] } });
    }
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: [] });
    if (path.endsWith("/work-sessions")) return json(route, { workSessions: [] });
    if (path.endsWith(`/workspaces/${workspaceId}`)) return json(route, { workspace: { id: workspaceId, name: "여명거리" } });
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
          if (c.connect) return { id: c.id, connect: { client: "work-tab-capture", version: "6" } };
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

async function signIn(page, origin) {
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("nav-ai").waitFor({ timeout: 20_000 });
}




const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok) failures.push(`${name} ${detail}`);
}

async function scene(browser, origin, scheme) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: scheme, serviceWorkers: "block" });
  await installRoutes(context);
  const page = await context.newPage();
  await installRealtime(page);
  await page.addInitScript((server) => { try { localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ } }, origin);
  await signIn(page, origin);
  await page.waitForTimeout(700);
  const tag = scheme;
  const header = page.getByTestId("sidebar-section-sec-launch-header");
  await header.waitFor({ timeout: 10_000 });
  await header.hover();
  await page.waitForTimeout(700);
  const clip = async (name) => {
    const box = await page.getByTestId("sidebar-section-sec-launch").boundingBox();
    await page.screenshot({ path: resolve(OUT_DIR, `${name}-${tag}.png`), clip: { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 24), width: Math.min(340, box.width + 16), height: box.height + 130 } });
  };
  await clip("section-head-hover");
  const geo = await page.evaluate(() => {
    const head = document.querySelector('[data-testid="sidebar-section-sec-launch-header"]');
    const more = document.querySelector('[data-testid="section-menu-sec-launch"]');
    const hb = head.getBoundingClientRect();
    const mb = more?.getBoundingClientRect() ?? null;
    return { bg: getComputedStyle(head).backgroundColor, head: { l: hb.left, r: hb.right, t: hb.top, b: hb.bottom }, more: mb && { l: mb.left, r: mb.right, t: mb.top, b: mb.bottom } };
  });
  console.log("bg", geo.bg); check(`${tag} 머리 상자가 호버에 칠해진다`, geo.bg !== "rgba(0, 0, 0, 0)" && geo.bg !== "transparent", geo.bg);
  check(`${tag} 「…」가 칠해진 머리 상자 안 오른쪽에 선다`, geo.more !== null && geo.more.l >= geo.head.l && geo.more.r <= geo.head.r && geo.more.t >= geo.head.t - 0.5 && geo.more.b <= geo.head.b + 0.5 && geo.head.r - geo.more.r <= 8, JSON.stringify(geo));
  const hint = await page.getByTestId("sidebar-section-sec-empty").innerText();
  check(`${tag} 빈 섹션 문구가 해요체다`, hint.includes("옮겨요") && !hint.includes("옮깁니다"), hint);
  await page.getByTestId("sidebar-section-sec-empty").hover();
  await page.waitForTimeout(250);
  const box = await page.getByTestId("sidebar-section-sec-empty").boundingBox();
  await page.screenshot({ path: resolve(OUT_DIR, `section-empty-${tag}.png`), clip: { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 24), width: Math.min(340, box.width + 16), height: box.height + 40 } });
  await context.close();
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const dist = process.env.DIST_DIR;
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT", extraArgs: dist ? ["--outDir", dist] : [] });
  const browser = await chromium.launch();
  try {
    for (const scheme of ["light", "dark"]) await scene(browser, preview.origin, scheme);
  } finally {
    await browser.close();
    await preview.stop?.();
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length}개 단언 실패`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
