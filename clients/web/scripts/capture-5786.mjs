#!/usr/bin/env node
// =============================================================================
// 아바타 상태 점 — 도려낸 자리에 앉는 점 실측 + 캡처 (#5786, owner 2026-11-13 QA 15).
//
//   npm run build:design && node scripts/capture-5786.mjs
//   OUT_DIR=… CAPTURE_PORT=… node scripts/capture-5786.mjs
//
// 재는 것(틀리면 기록하고 끝 코드를 1로 만든다):
//   G. 기하: 점이 서는 아바타마다(DM 줄 24 · 내 프로필 줄 32 · 멤버 목록 32 · 프로필 창 112) 점 지름이 코어 표와 같고
//      (10·12·42), 점 상자의 오른쪽·아래가 아바타 상자의 오른쪽·아래와 같다(상자 밖으로 나가지 않는다). 점을 감싼 칸의
//      크기 = 아바타 크기(점이 줄 높이를 바꾸지 않는다). 점이 없는 아바타(모름)는 도려내지 않는다.
//   P. 픽셀: 가리킨 줄 · 선택 줄 · 띠(노을) · 사진 아바타에서 점 둘레 틈 한가운데의 픽셀이 아바타 밖 바로 옆 바탕 픽셀과
//      같다 — 색 테가 없다. 점 표식은 그 바탕과 3:1 이상.
// 찍는 것: 밝게/어둡게 × (사이드바 · 가리킨 DM · 선택 DM · 멤버 목록 · 프로필 창) + 노을띠 + 좁은 폭(390) · 글자 200%.
//          점 둘레는 400% 확대 조각(`zoom-*.png`)으로 따로.
// =============================================================================
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "captures/5786");
const PORT = Number(process.env.CAPTURE_PORT || 5786);
// 사진 아바타: 저장소의 합성 사진(사람이 아니다 — 폰 캡처용 노을 그림).
const PHOTO = readFileSync(resolve(WEB_ROOT, "../mobile/maestro/assets/5325-photo-probe.png"));
const DOT = { 24: 10, 32: 12, 112: 42 };
const GAP = { 24: 2, 32: 2, 112: 7 };

const workspaceId = "00000000-0000-7000-8000-000000000001";
const P = (n) => `00000000-0000-7000-8000-0000000001${n}`;
const chId = (n) => `00000000-0000-7000-8000-0000000002${String(n).padStart(2, "0")}`;
const dmId = (n) => `00000000-0000-7000-8000-0000000003${String(n).padStart(2, "0")}`;
const ME = P("01");
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

// 가상 인물만.
const person = (n, displayName, handle, extra = {}) => ({
  id: P(n), workspaceId, kind: "human", status: "active", displayName, handle, role: "member",
  channelCount: 1, channelIds: [chId(1)], capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...extra,
});
const roster = [
  person("01", "김도현", "dohyeon", { role: "owner", online: true, avatarUrl: "/capture-5786-photo.png", email: "dohyeon@example.com" }),
  person("02", "이서연", "seoyeon", { role: "admin", online: true, avatarUrl: "/capture-5786-photo.png", email: "seoyeon@example.com" }),
  person("03", "정하윤", "hayun", { presenceStatus: "away", online: true, email: "hayun@example.com" }),
  person("04", "한지우", "jiwoo", { presenceStatus: "dnd", dndUntilMs: Date.now() + 86_400_000, online: true, email: "jiwoo@example.com" }),
  person("05", "박서준", "seojun", { online: false, email: "seojun@example.com" }),
  person("06", "오민재", "minjae", { email: "minjae@example.com" }), // 접속 여부 모름: 점 없음
  person("21", "김인턴", "intern", { kind: "agent", ownerHumanId: ME, hostOnline: true }),
];
const channels = [{ id: chId(1), workspaceId, kind: "public", name: "일반", muted: false }];
const dm = (n, other) => ({ id: dmId(n), workspaceId, kind: "dm", muted: false, memberIds: [ME, other] });
const dms = [dm(1, P("02")), dm(2, P("03")), dm(3, P("04")), dm(4, P("05")), dm(5, P("06")), dm(6, P("21"))];

const results = [];
function check(scene, name, ok, detail) {
  results.push({ scene, name, ok: Boolean(ok), detail });
  console.log(JSON.stringify({ scene, check: name, ok: Boolean(ok), detail }));
}
async function attempt(scene, name, fn) {
  try {
    await fn();
  } catch (error) {
    check(scene, `${name} (실행 실패)`, false, String(error?.message ?? error).split("\n")[0]);
  }
}

async function installMocks(context) {
  const auth = {
    accessToken: "capture-only-not-a-credential", refreshToken: "capture-only-not-a-credential",
    member: { id: ME, workspaceId, kind: "human", displayName: "김도현", handle: "dohyeon" },
    realtimeWebSocketUrl: "ws://dots-5786-capture.invalid/connection/websocket",
  };
  await context.route("**/capture-5786-photo.png", (route) => route.fulfill({ status: 200, contentType: "image/png", body: PHOTO }));
  await context.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId: ME });
    const live = /\/agents\/([^/]+)\/liveness$/.exec(path);
    if (live) return json(route, { agentMemberId: live[1], state: "responsive" });
    if (path.endsWith("/read-state")) {
      return json(route, { read_states: [...channels, ...dms].map((c) => ({ channel_id: c.id, last_read_seq: 2, latest_seq: 2, unread_count: 0, mention_count: 0, marked_unread_before_seq: null })) });
    }
    if (path.endsWith("/members/me/sidebar-prefs")) return json(route, { prefs: { version: 1, sections: [], starredChannelIds: [] } });
    if (path.endsWith("/channels")) return json(route, { channels: [...channels, ...dms] });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith(`/workspaces/${workspaceId}`)) return json(route, { workspace: { id: workspaceId, name: "달무리 스튜디오" } });
    if (path.includes("/messages")) return json(route, { messages: [] });
    return json(route, {});
  });
  await context.addInitScript(() => {
    class CaptureSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      constructor(url) { this.url = String(url); this.readyState = 0; queueMicrotask(() => { this.readyState = 1; this.onopen?.(new Event("open")); }); }
      send(data) {
        const replies = String(data).trim().split("\n").map((line) => {
          const c = JSON.parse(line);
          if (c.connect) return { id: c.id, connect: { client: "dots", version: "6" } };
          if (c.subscribe) return { id: c.id, subscribe: { recoverable: false, positioned: false, recovered: false, epoch: "cap", offset: 0 } };
          return { id: c.id };
        });
        queueMicrotask(() => this.onmessage?.(new MessageEvent("message", { data: replies.map((r) => JSON.stringify(r)).join("\n") })));
      }
      close() { this.readyState = 3; this.onclose?.(new CloseEvent("close", { code: 1000 })); }
    }
    window.WebSocket = CaptureSocket;
  });
}

async function open(origin, scheme, viewport, { palette = null } = {}) {
  const browser = await chromium.launch();
  // 400% 확대 조각을 같은 실행에서 찍는다: 기기 배율 4, 전체 화면은 `scale: "css"` 로 1배.
  const context = await browser.newContext({ viewport, colorScheme: scheme, serviceWorkers: "block", reducedMotion: "reduce", deviceScaleFactor: 4, locale: "ko-KR" });
  await installMocks(context);
  await context.addInitScript((server) => { try { if (!localStorage.getItem("momo.web.server.v1")) localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ } }, origin);
  const page = await context.newPage();
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-item").first().waitFor({ timeout: 30_000 });
  if (palette) await page.evaluate((p) => document.documentElement.setAttribute("data-palette", p), palette);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="dm-peer-dot"]').length >= 4, null, { timeout: 15_000 });
  await page.waitForTimeout(400);
  return { browser, page };
}

// ---- PNG → 픽셀 (scripts/capture-5242.mjs 와 같은 복호기) ----
function decodePng(png) {
  let at = 8, width = 0, height = 0, colorType = 0;
  const idat = [];
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const type = png.toString("ascii", at + 4, at + 8);
    const body = png.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") { width = body.readUInt32BE(0); height = body.readUInt32BE(4); colorType = body[9]; }
    if (type === "IDAT") idat.push(body);
    at += 12 + length;
  }
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const data = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? data[y * stride + x - channels] : 0;
      const up = y > 0 ? data[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? data[(y - 1) * stride + x - channels] : 0;
      let value = raw[y * (stride + 1) + 1 + x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const guess = left + up - upLeft;
        const dl = Math.abs(guess - left), du = Math.abs(guess - up), dul = Math.abs(guess - upLeft);
        value += dl <= du && dl <= dul ? left : du <= dul ? up : upLeft;
      }
      data[y * stride + x] = value & 255;
    }
  }
  return { width, channels, data };
}
const lum = ([r, g, b]) => { const lin = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); };
const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100; };
const near = (a, b, tol = 8) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

/** 점 하나를 잰다: 기하(G)와, 그 자리를 4배로 찍어 틈 = 바로 옆 바탕(P). */
async function measureDot(page, scene, frameLocator, face, { pixels = true } = {}) {
  const geo = await frameLocator.evaluate((frame) => {
    const r = (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, r: b.right, b: b.bottom }; };
    const dot = frame.querySelector(":scope > [data-avatar-status-dot]");
    const face = frame.querySelector(":scope > [data-avatar-status-face] > *");
    return { frame: r(frame), face: face ? r(face) : null, dot: dot ? r(dot) : null, cut: frame.hasAttribute("data-status-cut"), tone: dot?.getAttribute("data-tone") ?? null, size: frame.getAttribute("data-status-face") };
  });
  const tag = `${face}/${geo.tone}`;
  check(scene, `G1 ${tag} 점 지름 = 코어 표(${DOT[face]})`, geo.dot && Math.round(geo.dot.w) === DOT[face] && Math.round(geo.dot.h) === DOT[face], geo.dot);
  check(scene, `G2 ${tag} 점은 아바타 상자 안 오른쪽 아래(오른쪽·아래 끝이 같다)`, geo.dot && geo.face && Math.abs(geo.dot.r - geo.face.r) < 0.5 && Math.abs(geo.dot.b - geo.face.b) < 0.5, { dot: geo.dot, face: geo.face });
  check(scene, `G3 ${tag} 감싼 칸 = 아바타 크기(줄 높이 그대로)`, geo.face && Math.abs(geo.frame.w - geo.face.w) < 0.5 && Math.abs(geo.frame.h - geo.face.h) < 0.5 && Math.round(geo.face.w) === face, { frame: geo.frame, face: geo.face });
  check(scene, `G4 ${tag} 도려냄이 켜져 있다`, geo.cut === true && geo.size === String(face), { cut: geo.cut, size: geo.size });
  if (!pixels || !geo.dot) return;
  // 틈 한가운데(점 중심에서 왼쪽 위 45°, 점 반지름 + 틈/2)와, 아바타 밖 바로 옆 바탕(아바타 왼쪽 3px 바깥, 같은 높이).
  const cx = geo.dot.x + geo.dot.w / 2;
  const cy = geo.dot.y + geo.dot.h / 2;
  const d = DOT[face] / 2 + GAP[face] / 2;
  const gapAt = { x: cx - d * Math.SQRT1_2, y: cy - d * Math.SQRT1_2 };
  const bgAt = { x: geo.face.x - 3, y: cy };
  const pixel = async ({ x, y }) => {
    // 2×2 CSS px 조각을 기기 배율(4)로 찍고, 그 점을 덮는 기기 픽셀 하나를 읽는다.
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const png = await page.screenshot({ clip: { x: x0, y: y0, width: 2, height: 2 }, scale: "device", animations: "disabled", caret: "hide" });
    const img = decodePng(png);
    const i = (Math.floor((y - y0) * 4) * img.width + Math.floor((x - x0) * 4)) * img.channels;
    return [img.data[i], img.data[i + 1], img.data[i + 2]];
  };
  const gap = await pixel(gapAt);
  const bg = await pixel(bgAt);
  check(scene, `P1 ${tag} 점 둘레 틈 = 옆 바탕(색 테 없음)`, near(gap, bg), { gap, bg });
  if (geo.tone === "ok" || geo.tone === "danger") {
    const markAt = geo.tone === "ok" ? { x: cx, y: cy } : { x: cx, y: cy - (GAP[face] / 2 + (DOT[face] / 2 - GAP[face] / 2) / 2) };
    const mark = await pixel(markAt);
    check(scene, `P2 ${tag} 표식 대 바탕 3:1 이상`, ratio(mark, bg) >= 3, { mark, bg, ratio: ratio(mark, bg) });
  }
}

async function zoom(page, locator, name, pad = 6) {
  const box = await locator.boundingBox();
  if (!box) return;
  await page.screenshot({ path: resolve(OUT_DIR, `zoom-${name}.png`), clip: { x: box.x - pad, y: box.y - pad, width: box.width + pad * 2, height: box.height + pad * 2 }, scale: "device" });
}
const shot = (page, name, clip) => page.screenshot({ path: resolve(OUT_DIR, `${name}.png`), clip, scale: "css" });
const dmRow = (page, id) => page.locator(`[data-testid="channel-item"][data-channel-id="${id}"]`);
const dmFrame = (page, id) => dmRow(page, id).locator('[data-testid="dm-avatar"]');

async function hoverRow(page, row) {
  const box = await row.boundingBox();
  await page.mouse.move(box.x + 30, box.y + box.height / 2);
  await page.mouse.move(box.x + 60, box.y + box.height / 2, { steps: 4 });
  await page.waitForTimeout(200);
}

async function runSidebar(origin, scheme, palette = null) {
  const scene = `sidebar-${scheme}${palette ? `-${palette}` : ""}`;
  const suffix = `${scheme}${palette ? `-${palette}` : ""}`;
  const { browser, page } = await open(origin, scheme, { width: 1280, height: 820 }, { palette });
  try {
    await attempt(scene, "rest", async () => {
      await page.mouse.move(900, 400);
      await shot(page, `sidebar-${suffix}`, { x: 0, y: 0, width: 360, height: 820 });
      // 모름(오민재)은 점도 구멍도 없다.
      const unknown = dmFrame(page, dmId(5));
      check(scene, "G5 접속 여부를 모르는 사람: 점 없음·도려내지 않음", (await unknown.getAttribute("data-status-cut")) === null && (await unknown.locator("[data-avatar-status-dot]").count()) === 0, null);
      for (const n of [2, 3, 4, 6]) await measureDot(page, scene, dmFrame(page, dmId(n)), 24, { pixels: true });
      await zoom(page, dmRow(page, dmId(2)).locator('[data-testid="dm-avatar"]'), `dm-away-rest-${suffix}`);
      await zoom(page, dmRow(page, dmId(3)).locator('[data-testid="dm-avatar"]'), `dm-dnd-rest-${suffix}`);
      await zoom(page, dmRow(page, dmId(4)).locator('[data-testid="dm-avatar"]'), `dm-offline-rest-${suffix}`);
      await zoom(page, dmRow(page, dmId(6)).locator('[data-testid="dm-avatar"]'), `dm-agent-rest-${suffix}`);
    });
    await attempt(scene, "hover", async () => {
      await hoverRow(page, dmRow(page, dmId(1)));
      await measureDot(page, `${scene}-가리킴`, dmFrame(page, dmId(1)), 24);
      await zoom(page, dmRow(page, dmId(1)), `dm-photo-hover-${suffix}`, 2);
      await shot(page, `sidebar-hover-${suffix}`, { x: 0, y: 0, width: 360, height: 820 });
    });
    await attempt(scene, "selected", async () => {
      await dmRow(page, dmId(2)).click();
      await page.waitForURL(new RegExp(`/c/${dmId(2)}$`), { timeout: 5_000 });
      await page.mouse.move(900, 400);
      await page.waitForTimeout(300);
      await measureDot(page, `${scene}-선택`, dmFrame(page, dmId(2)), 24);
      await zoom(page, dmRow(page, dmId(2)), `dm-away-selected-${suffix}`, 2);
      await shot(page, `sidebar-selected-${suffix}`, { x: 0, y: 0, width: 360, height: 820 });
    });
    await attempt(scene, "profile-row", async () => {
      const card = page.getByTestId("profile-card");
      const frame = card.locator(".avatar-status");
      await card.hover();
      await page.waitForTimeout(200);
      await measureDot(page, `${scene}-내 프로필 가리킴`, frame, 32);
      await zoom(page, frame, `profile-row-hover-${suffix}`);
    });
  } finally {
    await browser.close();
  }
}

async function runDirectory(origin, scheme) {
  const scene = `directory-${scheme}`;
  const { browser, page } = await open(origin, scheme, { width: 1280, height: 820 });
  try {
    await attempt(scene, "list", async () => {
      await page.getByTestId("nav-directory").click();
      await page.getByTestId("directory-row").first().waitFor({ timeout: 10_000 });
      await page.mouse.move(1200, 10);
      await page.waitForTimeout(300);
      const row = (id) => page.locator(`[data-testid="directory-row"][data-member-id="${id}"]`);
      for (const id of [P("02"), P("03"), P("04"), P("05")]) await measureDot(page, scene, row(id).locator('[data-testid="avatar-with-presence"]'), 32);
      const heights = await page.locator('[data-testid="directory-row"]').evaluateAll((els) => [...new Set(els.map((el) => Math.round(el.getBoundingClientRect().height * 10) / 10))]);
      check(scene, "G6 멤버 목록 줄 높이가 모두 같다(점 있는 줄 = 점 없는 줄)", heights.length === 1, heights);
      await shot(page, `directory-${scheme}`, { x: 0, y: 0, width: 1280, height: 820 });
      await row(P("03")).hover();
      await page.waitForTimeout(200);
      await measureDot(page, `${scene}-가리킴`, row(P("03")).locator('[data-testid="avatar-with-presence"]'), 32);
      await zoom(page, row(P("03")).locator('[data-testid="avatar-with-presence"]'), `directory-away-hover-${scheme}`);
      await zoom(page, row(P("04")).locator('[data-testid="avatar-with-presence"]'), `directory-dnd-${scheme}`);
      await zoom(page, row(P("05")).locator('[data-testid="avatar-with-presence"]'), `directory-offline-${scheme}`);
    });
    await attempt(scene, "profile-dialog", async () => {
      await page.locator(`[data-testid="directory-row"][data-member-id="${P("02")}"]`).click();
      const hero = page.getByTestId("member-profile-hero").locator('[data-testid="avatar-with-presence"]');
      await hero.waitFor({ timeout: 10_000 });
      await page.waitForTimeout(400);
      await measureDot(page, `${scene}-프로필 창`, hero, 112);
      await zoom(page, hero, `profile-dialog-hero-photo-${scheme}`, 24);
      await shot(page, `profile-dialog-${scheme}`, { x: 0, y: 0, width: 1280, height: 820 });
    });
  } finally {
    await browser.close();
  }
}

async function runVariants(origin, scheme) {
  for (const [name, viewport, text] of [["narrow390", { width: 390, height: 800 }, null], ["text200", { width: 1280, height: 820 }, "200%"]]) {
    const scene = `${name}-${scheme}`;
    const { browser, page } = await open(origin, scheme, viewport);
    try {
      await attempt(scene, name, async () => {
        if (text) await page.addStyleTag({ content: `html{font-size:${text} !important}` });
        if (name === "narrow390") {
          const drawer = page.getByTestId("open-sidebar-drawer");
          if (await drawer.count()) await drawer.first().click().catch(() => undefined);
        }
        await page.waitForTimeout(400);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        check(scene, "가로 넘침 없음", overflow <= 0, { overflow });
        const frames = await page.locator('[data-testid="dm-avatar"]').evaluateAll((els) => els.map((el) => { const b = el.getBoundingClientRect(); return [Math.round(b.width), Math.round(b.height)]; }).filter(([w]) => w > 0));
        check(scene, "DM 아바타 칸은 24×24 그대로", frames.length > 0 && frames.every(([w, h]) => w === 24 && h === 24), frames);
        await page.screenshot({ path: resolve(OUT_DIR, `${name}-${scheme}.png`), scale: "css" });
      });
    } finally {
      await browser.close();
    }
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  try {
    for (const scheme of ["light", "dark"]) {
      await runSidebar(preview.origin, scheme);
      await runSidebar(preview.origin, scheme, "noeul");
      await runDirectory(preview.origin, scheme);
      await runVariants(preview.origin, scheme);
    }
  } finally {
    await preview.stop?.();
  }
  const bad = results.filter((r) => !r.ok);
  writeFileSync(resolve(OUT_DIR, "c5786-results.json"), JSON.stringify(results, null, 1));
  console.log(bad.length === 0 ? `DOTS-5786 PASS (${results.length} checks)` : `DOTS-5786 FAIL (${bad.length}/${results.length}): ${bad.map((r) => `${r.scene}/${r.name}`).join(" | ")}`);
  process.exit(bad.length === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
