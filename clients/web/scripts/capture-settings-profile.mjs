#!/usr/bin/env node
// =============================================================================
// 설정 › 프로필 한 페이지 캡처 (#3578 S2 / #3603).
//
//   npm run build && node scripts/capture-settings-profile.mjs
//   → OUT_DIR(기본 artifacts/settings-profile)/*.png
//
// 진짜 앱 셸을 Chromium으로 열어 `/settings?section=profile`을 폭 1440/900/640/390 ×
// 라이트/다크로 찍는다. 변형: 사진 있음, 오프라인, 핸들 중복(409), 나가기 확인 열림,
// `?section=account` 별칭. 백엔드는 없다(`/v1/**` 고정 응답, 사진은 코드로 만든 PNG).
// =============================================================================
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, crc32 } from "node:zlib";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/settings-profile");
const PORT = Number(process.env.CAPTURE_PORT || 5203);

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const channels = [{ id: "00000000-0000-7000-8000-000000000201", workspaceId, kind: "public", name: "general", muted: false }];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: "ws://settings-profile-capture.invalid/connection/websocket",
};
const LONG_NAME = "가나다라마바사아자차카타파하".repeat(7).slice(0, 100);
const rosterMember = (withPhoto, longName) => ({
  id: memberId, workspaceId, kind: "human", status: "active", role: "owner", displayName: longName ? LONG_NAME : "곽성재",
  handle: "seongjae", channelCount: 1, channelIds: channels.map((c) => c.id), capabilities: [],
  ...(withPhoto ? { avatarUrl: `/v1/workspaces/${workspaceId}/members/${memberId}/avatar/content?v=cap` } : {}),
  createdAtMs: 0, updatedAtMs: 0,
});

/** 외부 의존 없이 만든 96x96 그라데이션 PNG. */
function makePng() {
  const w = 96, h = 96;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = 90 + Math.round((x / w) * 120);
      raw[o + 1] = 120 + Math.round((y / h) * 90);
      raw[o + 2] = 170;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const PNG = makePng();

const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
async function installRoutes(context, { photo, handleTaken, longName }) {
  await context.route("**/v1/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId });
    if (path.endsWith("/avatar/content")) return route.fulfill({ status: 200, contentType: "image/png", body: PNG });
    if (req.method() === "PATCH" && path.endsWith("/members/me") && handleTaken) {
      return json(route, { error: { code: "conflict", message: "handle is already in use" } }, 409);
    }
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) return json(route, { members: [rosterMember(photo, longName)] });
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith(`/workspaces/${workspaceId}`)) return json(route, { workspace: { id: workspaceId, name: "여명거리" } });
    if (path.includes("/messages")) return json(route, { messages: [] });
    return json(route, {});
  });
}
async function installRealtime(page) {
  await page.addInitScript(() => {
    class CaptureSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      constructor(url) { this.url = String(url); this.readyState = 0; queueMicrotask(() => { this.readyState = 1; this.onopen?.(new Event("open")); }); }
      send(data) {
        const replies = String(data).trim().split("\n").map((line) => {
          const c = JSON.parse(line);
          if (c.connect) return { id: c.id, connect: { client: "settings-profile", version: "6" } };
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

async function open(browser, origin, scheme, viewport, opts, section = "profile") {
  const context = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion: "reduce" });
  await installRoutes(context, opts);
  const page = await context.newPage();
  await installRealtime(page);
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("profile-card").or(page.getByTestId("open-sidebar-drawer").first()).first().waitFor({ timeout: 20_000 });
  await page.evaluate((s) => { location.hash = `/settings?section=${s}`; }, section);
  await page.getByTestId("profile-hero").waitFor({ state: "visible", timeout: 20_000 });
  await page.waitForTimeout(600);
  return { context, page };
}

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) throw new Error("dist/ is missing. Run npm run build first.");
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  const shot = (page, name) => page.screenshot({ path: resolve(OUT_DIR, `${name}.png`) });
  try {
    for (const scheme of ["light", "dark"]) {
      for (const [width, height] of [[1440, 1300], [900, 1300], [640, 1400], [390, 1900]]) {
        const { context, page } = await open(browser, preview.origin, scheme, { width, height }, { photo: false });
        await shot(page, `profile-${width}-${scheme}`);
        await context.close();
      }
      const wide = { width: 1440, height: 1300 };
      let r = await open(browser, preview.origin, scheme, wide, { photo: true });
      await shot(r.page, `profile-photo-1440-${scheme}`);
      await r.context.close();
      r = await open(browser, preview.origin, scheme, { width: 390, height: 1900 }, { photo: true });
      await shot(r.page, `profile-photo-390-${scheme}`);
      await r.context.close();
      r = await open(browser, preview.origin, scheme, wide, { photo: false }, "account");
      await shot(r.page, `alias-account-1440-${scheme}`);
      await r.context.close();
      r = await open(browser, preview.origin, scheme, wide, { photo: true, handleTaken: true });
      await r.page.getByTestId("profile-handle").fill("taken");
      await r.page.getByTestId("profile-save").click();
      // 오류 칸은 늘 그려져 있으므로(reserveErrorSlot) 실제 문장이 뜰 때까지 기다린다.
      await r.page.getByText("이미 쓰는 핸들이에요", { exact: false }).waitFor({ state: "visible", timeout: 10_000 });
      // 포커스를 다른 칸으로 옮겨도 서버 오류가 남아야 한다(blur 로컬 검사가 덮지 않는다).
      await r.page.getByTestId("profile-display-name").focus();
      await r.page.waitForTimeout(200);
      if (!(await r.page.getByText("이미 쓰는 핸들이에요", { exact: false }).isVisible())) {
        throw new Error("핸들 409 오류가 blur 뒤에 사라졌다");
      }
      await shot(r.page, `profile-handle-taken-1440-${scheme}`);
      await r.page.getByTestId("workspace-leave").click();
      await r.page.getByTestId("workspace-leave-question").waitFor({ state: "visible" });
      await shot(r.page, `profile-leave-confirm-1440-${scheme}`);
      await r.context.close();
      for (const w of [640, 390]) {
        r = await open(browser, preview.origin, scheme, { width: w, height: w === 390 ? 1900 : 1500 }, { photo: true });
        await r.page.getByTestId("workspace-leave").click();
        await r.page.getByTestId("workspace-leave-question").waitFor({ state: "visible" });
        await shot(r.page, `profile-leave-confirm-${w}-${scheme}`);
        await r.context.close();
      }
      r = await open(browser, preview.origin, scheme, { width: 390, height: 1900 }, { photo: false, longName: true });
      await shot(r.page, `profile-longname-390-${scheme}`);
      await r.context.close();
      r = await open(browser, preview.origin, scheme, wide, { photo: true });
      await r.context.setOffline(true);
      await r.page.evaluate(() => window.dispatchEvent(new Event("offline")));
      await r.page.getByTestId("profile-offline-banner").waitFor({ state: "visible", timeout: 10_000 });
      await shot(r.page, `profile-offline-1440-${scheme}`);
      await r.context.close();
    }
  } finally {
    await browser.close();
    await preview.stop?.();
  }
  console.log(`ok   ${OUT_DIR}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
