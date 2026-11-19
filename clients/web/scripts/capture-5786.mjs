#!/usr/bin/env node
// =============================================================================
// 아바타 상태 점 — 도려낸 자리에 앉는 점 실측 + 캡처 (#5786, owner 2026-11-13 QA 15).
//
//   npm run build:design && node scripts/capture-5786.mjs
//   ENGINE=chromium|webkit OUT_DIR=… CAPTURE_PORT=… node scripts/capture-5786.mjs
//   (수리 1회차: 두 엔진. 데스크탑 앱은 WebKit 으로 그린다 — 번들 WebKit 으로 잰다.)
//
// 재는 것(틀리면 기록하고 끝 코드를 1로 만든다):
//   G. 기하: 점이 서는 아바타마다(DM 줄 24 · 내 프로필 줄 32 · 멤버 목록 32 · 프로필 창 112) 점 지름이 코어 표와 같고
//      (10·12·42), 점 상자의 오른쪽·아래가 아바타 상자의 오른쪽·아래와 같다(상자 밖으로 나가지 않는다). 점을 감싼 칸의
//      크기 = 아바타 크기(점이 줄 높이를 바꾸지 않는다). 점이 없는 아바타(모름)는 도려내지 않는다.
//   P. 픽셀: 가리킨 줄 · 선택 줄 · 띠(노을) · 사진 아바타에서 점 둘레 틈 한가운데의 픽셀이 아바타 밖 바로 옆 바탕 픽셀과
//      같다 — 색 테가 없다. 점 표식은 그 바탕과 3:1 이상(네 모양 모두: 채운 원의 가운데 · 초승달의 오른쪽 아래 · 가로 줄의
//      위 · 고리), 모양의 빈 곳(초승달 왼쪽 위 · 가로 줄 · 고리 속)은 바탕.
//   수리 1회차(design-review r1):
//   I. 24 글자 아바타의 이니셜 잉크 손실 ≤ 3%(B1): DM 줄의 받침 있는 이니셜(김·박·한·정·홍)·라틴(K·D)·에이전트(김·리).
//      접힌 레일의 내 배지도 부르지만 이 픽스처의 「나」는 사진이라 재지 않고 로그에 한 줄 남긴다. 기준판은 같은 자리에서 마스크만 끄고 점을 숨긴 것(이니셜 옮김은 그대로)이고, 손실 = 기준판의
//      잉크 픽셀 가운데 실제 화면에서 바뀐 것의 비율이다.
//   H. 에이전트 경고는 채운 원(H2): 사람 초승달이면 빈 왼쪽 위까지 표식이다.
//   W. 배경화면을 켠 사이드바(H1): 밝게·어둡게 × 먹(어두운 단색)·진주(밝은 프리셋) + 그래파이트 밝게·먹 — 네 상태 표식이
//      그 자리 바탕과 3:1 이상.
//   M. 「내 상태」 메뉴의 표지(M1): 자리 비움 = 초승달(왼쪽 위가 메뉴 바탕), 방해 금지 = 가로 줄(가운데가 메뉴 바탕).
//   C. 채널 멤버 패널(M4): 사람·에이전트 줄 모두 넘긴 face = 실제 아바타 크기(G1~G3), 에이전트 경고는 채운 원.
// 찍는 것: 밝게/어둡게 × (사이드바 · 가리킨 DM · 선택 DM · 멤버 목록 · 프로필 창) + 노을띠 + 좁은 폭(390) · 글자 200%.
//          점 둘레는 400% 확대 조각(`zoom-*.png`)으로 따로.
// =============================================================================
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import * as playwright from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "captures/5786");
const PORT = Number(process.env.CAPTURE_PORT || 5786);
const ENGINE = process.env.ENGINE || "chromium";
// 사진 아바타: 저장소의 합성 사진(사람이 아니다 — 폰 캡처용 노을 그림).
const PHOTO = readFileSync(resolve(WEB_ROOT, "../mobile/maestro/assets/5325-photo-probe.png"));
// 코어 `statusBadgeGeometry` 의 표(수리 1회차: 24 → 8 · 2, 112 → 28 · 4). `avatarStatus.geometry.test.ts` 가 CSS 와 코어를 잇고
// 이 표는 실제 화면이 그 값으로 그려지는지 잰다.
const DOT = { 24: 8, 32: 12, 112: 28 };
const GAP = { 24: 2, 32: 2, 112: 4 };
const INK_LOSS_MAX = 3; // %

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
  // 수리 1회차: 받침 있는 이니셜 · 라틴 이니셜 · 에이전트 경고.
  person("07", "김서윤", "seoyun", { online: true, email: "seoyun@example.com" }),
  person("08", "홍예린", "yerin", { online: true, email: "yerin@example.com" }),
  person("09", "Kai Dawson", "kai", { online: true, email: "kai@example.com" }),
  person("10", "Dana Moore", "dana", { presenceStatus: "away", online: true, email: "dana@example.com" }),
  person("22", "리서치봇", "research", { kind: "agent", ownerHumanId: ME, hostOnline: true }),
];
const LIVENESS = { [P("21")]: "responsive", [P("22")]: "work_waiting" };
const channels = [{ id: chId(1), workspaceId, kind: "public", name: "일반", muted: false }];
const dm = (n, other) => ({ id: dmId(n), workspaceId, kind: "dm", muted: false, memberIds: [ME, other] });
const dms = [
  dm(1, P("02")), dm(2, P("03")), dm(3, P("04")), dm(4, P("05")), dm(5, P("06")), dm(6, P("21")),
  dm(7, P("07")), dm(8, P("08")), dm(9, P("09")), dm(10, P("10")), dm(11, P("22")),
];
// 24 글자 아바타(점 있음): 정 · 한 · 박 · 김(에이전트) · 김 · 홍 · K · D · 리(에이전트 경고).
const LETTER_DMS = [2, 3, 4, 6, 7, 8, 9, 10, 11];

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
    if (live) return json(route, { agentMemberId: live[1], state: LIVENESS[live[1]] ?? "responsive" });
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

async function open(origin, scheme, viewport, { palette = null, wallpaper = null, theme = "dawnsky" } = {}) {
  const browser = await playwright[ENGINE].launch();
  // 400% 확대 조각을 같은 실행에서 찍는다: 기기 배율 4, 전체 화면은 `scale: "css"` 로 1배.
  const context = await browser.newContext({ viewport, colorScheme: scheme, serviceWorkers: "block", reducedMotion: "reduce", deviceScaleFactor: 4, locale: "ko-KR" });
  await installMocks(context);
  await context.addInitScript((server) => { try { if (!localStorage.getItem("momo.web.server.v1")) localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ } }, origin);
  if (wallpaper) {
    // 설정 > 모양 > 배경과 같은 저장 기록(이 기기). 테마는 띠 없는 것만 — 띠가 있으면 배경화면은 사이드바를 보정하지 않는다.
    const [kind, id] = wallpaper.split(":");
    const record = JSON.stringify({ v: 2, scheme: "system", theme, signal: null, wallpaper: { kind, id } });
    await context.addInitScript((r) => { try { localStorage.setItem("momo.web.appearance.v2", r); } catch { /* 저장소 없는 캡처 */ } }, record);
  }
  const page = await context.newPage();
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-item").first().waitFor({ timeout: 30_000 });
  if (palette) await page.evaluate((p) => document.documentElement.setAttribute("data-palette", p), palette);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="dm-peer-dot"]').length >= 10, null, { timeout: 30_000 });
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
async function measureDot(page, scene, frameLocator, face, { pixels = true, subject = "human" } = {}) {
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
  // 모양(뜻): 표식 자리와 빈 자리. 빈 자리는 틈과 같은 바탕이고, 표식은 그 바탕과 3:1 이상.
  const r = DOT[face] / 2;
  const g = GAP[face];
  const shape = await frameLocator.evaluate((frame) => frame.querySelector(":scope > [data-avatar-status-dot]")?.getAttribute("data-shape") ?? null);
  const marks = { fill: [[0, 0]], moon: [[r * 0.55, r * 0.55]], bar: [[0, -(g / 2 + (r - g / 2) / 2)]], ring: [[-(r - g / 2), 0]] }[shape] ?? [];
  const holes = { fill: [], moon: [[-r * 0.5, -r * 0.5]], bar: [[0, 0]], ring: [[0, 0]] }[shape] ?? [];
  for (const [dx, dy] of marks) {
    const mark = await pixel({ x: cx + dx, y: cy + dy });
    check(scene, `P2 ${tag}/${shape} 표식 대 바탕 3:1 이상`, ratio(mark, gap) >= 3, { mark, ground: gap, ratio: ratio(mark, gap) });
  }
  for (const [dx, dy] of holes) {
    const hole = await pixel({ x: cx + dx, y: cy + dy });
    check(scene, `P3 ${tag}/${shape} 모양의 빈 곳 = 바탕`, near(hole, gap, 12), { hole, ground: gap });
  }
  if (subject === "agent" && shape === "fill") {
    // H: 에이전트 경고는 채운 원 — 사람이면 초승달이 비는 왼쪽 위까지 표식이다.
    const upperLeft = await pixel({ x: cx - r * 0.5, y: cy - r * 0.5 });
    check(scene, `H ${tag} 에이전트 점은 채운 원(왼쪽 위도 표식)`, ratio(upperLeft, gap) >= 3, { upperLeft, ground: gap });
  }
  if (subject === "agent") check(scene, `H ${tag} 에이전트 점의 모양은 채운 원 또는 고리`, shape === "fill" || shape === "ring", { shape });
}

/**
 * I: 24 글자 아바타의 이니셜 잉크 손실(%). 기준판 = 같은 자리에서 마스크만 끄고 점을 숨긴 것(이니셜 옮김은 그대로 — 옮김은
 * 잉크를 지우지 않는다). 기준판의 잉크 픽셀(글자색 쪽으로 절반 넘게 간 픽셀) 가운데 실제 화면에서 바뀐 것의 비율.
 */
async function inkLoss(page, frameLocator) {
  const box = await frameLocator.boundingBox();
  const clip = { x: box.x, y: box.y, width: box.width, height: box.height };
  const real = decodePng(await page.screenshot({ clip, scale: "device", animations: "disabled", caret: "hide" }));
  const info = await frameLocator.evaluate((frame) => {
    const face = frame.querySelector(":scope > [data-avatar-status-face]");
    const avatar = face.firstElementChild;
    const cs = getComputedStyle(avatar);
    const dot = frame.querySelector(":scope > [data-avatar-status-dot]");
    face.style.maskImage = "none";
    face.style.webkitMaskImage = "none";
    if (dot) dot.style.visibility = "hidden";
    return { ink: cs.color, text: avatar.textContent, shift: cs.paddingRight };
  });
  await page.waitForTimeout(80);
  const base = decodePng(await page.screenshot({ clip, scale: "device", animations: "disabled", caret: "hide" }));
  await frameLocator.evaluate((frame) => {
    const face = frame.querySelector(":scope > [data-avatar-status-face]");
    face.style.maskImage = "";
    face.style.webkitMaskImage = "";
    const dot = frame.querySelector(":scope > [data-avatar-status-dot]");
    if (dot) dot.style.visibility = "";
  });
  const rgb = (s) => (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
  const ink = rgb(info.ink);
  // 얼굴 채움은 기준판에서 읽는다(글자 위 가운데, 테두리 안쪽): 계산된 배경색은 띠 위에서 투명일 수 있다(노을띠).
  const at = (Math.floor(base.width * 0.14) * base.width + Math.floor(base.width * 0.5)) * base.channels;
  const bg = [base.data[at], base.data[at + 1], base.data[at + 2]];
  const axis = ink.map((v, i) => v - bg[i]);
  const norm = axis.reduce((sum, v) => sum + v * v, 0);
  let inkPx = 0;
  let lost = 0;
  // 얼굴 안쪽만(가장자리 2px 안): 띠 위에서는 얼굴 밖 모서리(남색 띠)가 글자색 쪽으로 읽혀 잉크로 잡힌다.
  const half = base.width / 2;
  const inner = half - 2 * (base.width / box.width);
  for (let i = 0; i < base.data.length / base.channels; i += 1) {
    if (Math.hypot((i % base.width) + 0.5 - half, Math.floor(i / base.width) + 0.5 - half) > inner) continue;
    const o = i * base.channels;
    const p = [base.data[o], base.data[o + 1], base.data[o + 2]];
    if (p.reduce((sum, v, k) => sum + (v - bg[k]) * axis[k], 0) / norm < 0.5) continue;
    inkPx += 1;
    if (Math.max(...[0, 1, 2].map((k) => Math.abs(real.data[o + k] - p[k]))) > 32) lost += 1;
  }
  return { text: info.text, shift: info.shift, ink, faceFill: bg, inkPx, lost, pct: inkPx ? Math.round((lost / inkPx) * 1000) / 10 : null };
}

async function checkInk(page, scene, frameLocator, label) {
  // 사진 아바타는 이니셜이 없다(옮기지도 않는다) — 글자 아바타만 잰다. 건너뛴 것은 로그에 남긴다(단정 수에는 넣지 않는다).
  if (await frameLocator.locator("img").count()) {
    console.log(JSON.stringify({ scene, skip: `I ${label}`, reason: "사진 아바타 — 이니셜 없음" }));
    return;
  }
  const r = await inkLoss(page, frameLocator);
  check(scene, `I ${label} 「${r.text}」 이니셜 잉크 손실 ≤ ${INK_LOSS_MAX}%`, r.inkPx > 20 && r.pct !== null && r.pct <= INK_LOSS_MAX, r);
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
  // 높이 1200: DM 줄 열한 개가 목록 끝의 내 프로필 줄(사진) 뒤로 가지 않게.
  const { browser, page } = await open(origin, scheme, { width: 1280, height: 1200 }, { palette });
  try {
    await attempt(scene, "rest", async () => {
      await page.mouse.move(900, 400);
      await shot(page, `sidebar-${suffix}`, { x: 0, y: 0, width: 360, height: 1200 });
      // 모름(오민재)은 점도 구멍도 없다.
      const unknown = dmFrame(page, dmId(5));
      check(scene, "G5 접속 여부를 모르는 사람: 점 없음·도려내지 않음", (await unknown.getAttribute("data-status-cut")) === null && (await unknown.locator("[data-avatar-status-dot]").count()) === 0, null);
      for (const n of [2, 3, 4, 7, 8, 9, 10]) await measureDot(page, scene, dmFrame(page, dmId(n)), 24, { pixels: true });
      for (const n of [6, 11]) await measureDot(page, scene, dmFrame(page, dmId(n)), 24, { pixels: true, subject: "agent" });
      for (const n of LETTER_DMS) await checkInk(page, scene, dmFrame(page, dmId(n)), `24/DM ${n}`);
      // 받침 있는 이니셜의 24 DM 줄 400% 조각(같은 열).
      const first = await dmFrame(page, dmId(2)).boundingBox();
      const last = await dmFrame(page, dmId(11)).boundingBox();
      await page.screenshot({ path: resolve(OUT_DIR, `zoom-dm-letters-${suffix}.png`), clip: { x: first.x - 6, y: first.y - 6, width: 220, height: last.y + last.height - first.y + 12 }, scale: "device" });
      await zoom(page, dmRow(page, dmId(2)).locator('[data-testid="dm-avatar"]'), `dm-away-rest-${suffix}`);
      await zoom(page, dmRow(page, dmId(3)).locator('[data-testid="dm-avatar"]'), `dm-dnd-rest-${suffix}`);
      await zoom(page, dmRow(page, dmId(4)).locator('[data-testid="dm-avatar"]'), `dm-offline-rest-${suffix}`);
      await zoom(page, dmRow(page, dmId(6)).locator('[data-testid="dm-avatar"]'), `dm-agent-rest-${suffix}`);
      await zoom(page, dmRow(page, dmId(11)).locator('[data-testid="dm-avatar"]'), `dm-agent-warn-rest-${suffix}`);
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
    if (!palette) await attempt(scene, "status-menu", () => measureStatusMenu(page, scene, suffix));
    if (!palette) await attempt(scene, "member-panel", () => measureMemberPanel(page, scene, suffix));
    await attempt(scene, "collapsed-rail", async () => {
      await page.keyboard.press("Escape");
      await page.getByTestId("sidebar-toggle").click({ timeout: 5_000 });
      await page.waitForTimeout(600);
      await page.mouse.move(900, 500);
      const frame = page.getByTestId("profile-card").locator(".avatar-status");
      await measureDot(page, `${scene}-접힌 레일`, frame, 24);
      await checkInk(page, `${scene}-접힌 레일`, frame, "24/접힌 레일 내 배지");
      await zoom(page, frame, `collapsed-self-${suffix}`);
    });
  } finally {
    await browser.close();
  }
}

/** M: 「내 상태」 메뉴의 표지 — 배지와 같은 모양(자리 비움 초승달 · 방해 금지 가로 줄). */
async function measureStatusMenu(page, scene, suffix) {
  await page.keyboard.press("Escape");
  await page.getByTestId("profile-card").click();
  const menu = page.getByTestId("profile-card-menu");
  await menu.waitFor({ timeout: 5_000 });
  await page.waitForTimeout(400);
  await zoom(page, menu, `status-menu-${suffix}`, 4);
  const marker = (status) => page.locator(`[data-testid="presence-option-${status}"] .status-mark`).first();
  const px1 = async (x, y) => {
    const png = await page.screenshot({ clip: { x: Math.floor(x), y: Math.floor(y), width: 2, height: 2 }, scale: "device", animations: "disabled", caret: "hide" });
    const img = decodePng(png);
    const i = (Math.floor((y - Math.floor(y)) * 4) * img.width + Math.floor((x - Math.floor(x)) * 4)) * img.channels;
    return [img.data[i], img.data[i + 1], img.data[i + 2]];
  };
  for (const [status, holeAt, markAt] of [
    ["away", [-0.5, -0.5], [0.55, 0.55]],
    ["dnd", [0, 0], [0, -0.62]],
    ["auto", null, [0, 0]],
  ]) {
    const box = await marker(status).boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const r = box.width / 2;
    const ground = await px1(box.x - 3, cy);
    const mark = await px1(cx + markAt[0] * r, cy + markAt[1] * r);
    check(scene, `M ${status} 메뉴 표지의 표식`, ratio(mark, ground) >= 3, { mark, ground, size: box.width });
    if (holeAt) {
      const hole = await px1(cx + holeAt[0] * r, cy + holeAt[1] * r);
      check(scene, `M ${status} 메뉴 표지의 빈 곳 = 메뉴 바탕(모양이 배지와 같다)`, near(hole, ground, 12), { hole, ground });
    }
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
}

/** C: 채널 멤버 패널 — 넘긴 face = 실제 아바타 크기, 에이전트 경고는 채운 원. */
async function measureMemberPanel(page, scene, suffix) {
  await page.locator(`[data-testid="channel-item"][data-channel-id="${chId(1)}"]`).click();
  await page.getByTestId("channel-member-count").click({ timeout: 8_000 });
  const panel = page.getByTestId("channel-member-panel");
  await panel.waitFor({ timeout: 8_000 });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="agent-liveness-dot"]').length >= 2, null, { timeout: 10_000 });
  await page.waitForTimeout(400);
  await page.mouse.move(5, 5);
  await zoom(page, panel, `member-panel-${suffix}`, 2);
  const frames = panel.locator('[data-testid="channel-member-item"] .avatar-status');
  const n = await frames.count();
  check(scene, "C 채널 멤버 패널에 점 상자가 있다", n >= 4, { n });
  for (let i = 0; i < n; i += 1) {
    const frame = frames.nth(i);
    if (!(await frame.locator("[data-avatar-status-dot]").count())) continue;
    const kind = await frame.evaluate((el) => el.closest('[data-testid="channel-member-item"]')?.getAttribute("data-member-kind"));
    await measureDot(page, `${scene}-채널 멤버 패널`, frame, 32, { subject: kind === "agent" ? "agent" : "human" });
  }
  await page.getByTestId("channel-member-close").click().catch(() => page.keyboard.press("Escape"));
  await page.waitForTimeout(300);
}

/** W: 배경화면을 켠 사이드바 — 네 상태(+ 에이전트)의 표식이 그 자리 바탕과 3:1 이상, 틈 = 바탕. */
async function runWallpaper(origin, scheme, wallpaper, theme) {
  const scene = `wallpaper-${scheme}-${theme}-${wallpaper.replace(":", "_")}`;
  const { browser, page } = await open(origin, scheme, { width: 1280, height: 1200 }, { wallpaper, theme });
  try {
    await attempt(scene, "rest", async () => {
      const live = await page.evaluate(() => document.documentElement.hasAttribute("data-wallpaper-live"));
      check(scene, "W 배경화면이 실제로 깔렸다", live, { live });
      await page.mouse.move(900, 400);
      for (const n of [2, 3, 4, 7]) await measureDot(page, scene, dmFrame(page, dmId(n)), 24);
      for (const n of [6, 11]) await measureDot(page, scene, dmFrame(page, dmId(n)), 24, { subject: "agent" });
      await shot(page, `wallpaper-sidebar-${scheme}-${theme}-${wallpaper.replace(":", "_")}`, { x: 0, y: 0, width: 360, height: 1200 });
      const first = await dmFrame(page, dmId(2)).boundingBox();
      const last = await dmFrame(page, dmId(11)).boundingBox();
      await page.screenshot({ path: resolve(OUT_DIR, `zoom-wallpaper-${scheme}-${theme}-${wallpaper.replace(":", "_")}.png`), clip: { x: first.x - 6, y: first.y - 6, width: 220, height: last.y + last.height - first.y + 12 }, scale: "device" });
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
      await zoom(page, page.getByTestId("member-profile-dialog"), `profile-dialog-full-${scheme}`, 0);
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
      for (const wallpaper of ["solid:ink", "preset:jinju"]) await runWallpaper(preview.origin, scheme, wallpaper, "dawnsky");
    }
    // 검수 r1 이 잰 가장 낮은 칸(그래파이트 밝게 + 먹 2.35:1).
    await runWallpaper(preview.origin, "light", "solid:ink", "graphite");
  } finally {
    await preview.stop?.();
  }
  const bad = results.filter((r) => !r.ok);
  writeFileSync(resolve(OUT_DIR, `c5786-results-${ENGINE}.json`), JSON.stringify(results, null, 1));
  console.log(bad.length === 0 ? `DOTS-5786 ${ENGINE} PASS (${results.length} checks)` : `DOTS-5786 ${ENGINE} FAIL (${bad.length}/${results.length}): ${bad.map((r) => `${r.scene}/${r.name}`).join(" | ")}`);
  process.exit(bad.length === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
