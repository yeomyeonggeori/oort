#!/usr/bin/env node
// =============================================================================
// 사이드바 DM 구획 캡처 (#3662). 「대화」 줄이 없는 구획 A, DM 머리 호버의 +, DM 행의 상대
// 아바타(사진·이니셜·에이전트·상태 점), 새 다이렉트 메시지 모달을 라이트·다크 1440에서 찍는다.
// 백엔드는 없다(라우트 모의). 대기는 전부 실패할 수 있는 waitFor/expect다.
//
//   npm run build && node scripts/capture-sidebar-dm.mjs
//   OUT_DIR=… PREFIX=c3662 node scripts/capture-sidebar-dm.mjs
// =============================================================================
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/sidebar-dm");
const PREFIX = process.env.PREFIX || "c3662";
const PORT = Number(process.env.CAPTURE_PORT || 5198);

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const ids = (n) => `00000000-0000-7000-8000-0000000003${String(n).padStart(2, "0")}`;
const channels = ["general", "workbench", "agent-lab", "design-2-0", "release"].map((name, i) => ({
  id: `00000000-0000-7000-8000-00000000020${i + 1}`, workspaceId, kind: "public", name, muted: false,
}));
const json = (route, body) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

const photo = "data:image/svg+xml;base64," + Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#c9784a"/><circle cx="32" cy="26" r="12" fill="#f3d6c0"/><rect x="12" y="42" width="40" height="22" rx="11" fill="#f3d6c0"/></svg>'
).toString("base64");
const P = (n) => `00000000-0000-7000-8000-0000000001${n}`;
const person = (n, displayName, handle, extra = {}) => ({
  id: P(n), workspaceId, kind: "human", status: "active", displayName, handle, channelCount: 1, channelIds: [], capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...extra,
});
const roster = [
  person("01", "곽성재", "seongjae", { role: "owner", presenceStatus: "auto" }),
  person("11", "이도현", "dohyun"),
  person("12", "박서연", "seoyeon", { avatarUrl: photo }),
  person("13", "최민수", "minsu", { presenceStatus: "away" }),
  person("15", "정하윤", "hayun", { presenceStatus: "dnd" }),
  person("14", "김인턴", "intern", { kind: "agent", hostOnline: true, ownerHumanId: P("01") }),
  person("16", "한지우", "jiwoo"),
];
const dm = (n, others) => ({ id: ids(n), workspaceId, kind: "dm", muted: false, memberIds: [P("01"), ...others] });
const dms = [dm(1, [P("11")]), dm(2, [P("12")]), dm(3, [P("13")]), dm(4, [P("14")]), dm(5, [P("15")])];

async function open(browser, origin, scheme, viewport) {
  const auth = {
    accessToken: "capture-only-not-a-credential", refreshToken: "capture-only-not-a-credential",
    member: { id: memberId, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
    realtimeWebSocketUrl: "ws://sidebar-dm-capture.invalid/connection/websocket",
  };
  const context = await browser.newContext({ viewport, colorScheme: scheme, serviceWorkers: "block" });
  await context.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId });
    if (path.endsWith("/channels")) return json(route, { channels: [...channels, ...dms] });
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
  await page.getByTestId("dm-avatar").first().waitFor({ timeout: 20_000 });
  return { context, page };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  try {
    for (const scheme of ["light", "dark"]) {
      const { context, page } = await open(browser, preview.origin, scheme, { width: 1440, height: 900 });
      const side = { x: 0, y: 0, width: 420, height: 900 };
      // 1) 쉴 때: 「대화」 줄 없음, DM 머리에 +가 없다.
      if ((await page.getByTestId("nav-chat").count()) !== 0) throw new Error("nav-chat 이 아직 있다");
      if ((await page.getByTestId("new-dm").count()) !== 0) throw new Error("+ 가 쉴 때도 서 있다");
      await page.screenshot({ path: resolve(OUT_DIR, `${PREFIX}-sidebar-rest-${scheme}.png`), clip: side });
      // 2) 머리 호버: + 가 선다.
      await page.getByTestId("sidebar-section-dms-header").hover();
      await page.getByTestId("new-dm").waitFor({ timeout: 5_000 });
      await page.screenshot({ path: resolve(OUT_DIR, `${PREFIX}-sidebar-hover-${scheme}.png`), clip: side });
      // 3) + 를 누르면 새 DM 모달, 받는 사람 칸에 캐럿.
      await page.getByTestId("new-dm").click();
      await page.getByTestId("new-dm-dialog").waitFor({ timeout: 5_000 });
      await page.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "new-dm-search", null, { timeout: 5_000 });
      const rowCount = await page.getByTestId("new-dm-row").count();
      if (rowCount !== 6) throw new Error(`모달 행이 6이어야 한다(나 제외): ${rowCount}`);
      if ((await page.locator('[data-testid="new-dm-row"][data-has-dm]').count()) !== 5) throw new Error("대화 중 표지가 5가 아니다");
      await page.screenshot({ path: resolve(OUT_DIR, `${PREFIX}-new-dm-modal-${scheme}.png`) });
      // 4) 검색으로 거르기.
      await page.getByTestId("new-dm-search").fill("지우");
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="new-dm-row"]').length === 1, null, { timeout: 5_000 });
      await page.screenshot({ path: resolve(OUT_DIR, `${PREFIX}-new-dm-modal-filtered-${scheme}.png`) });
      // 5) 이미 DM이 있는 사람 → 그 DM으로 이동(만들기 요청 없음).
      await page.getByTestId("new-dm-search").fill("dohyun");
      await page.getByTestId("new-dm-row").first().click();
      await page.waitForURL(new RegExp(`/c/${ids(1)}$`), { timeout: 5_000 });
      await page.getByTestId("new-dm-dialog").waitFor({ state: "detached", timeout: 5_000 });
      await page.screenshot({ path: resolve(OUT_DIR, `${PREFIX}-sidebar-after-pick-${scheme}.png`), clip: side });
      console.log("shots", scheme);
      await context.close();
    }
  } finally {
    await browser.close();
    await preview.stop?.();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
