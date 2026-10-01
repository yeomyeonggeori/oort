#!/usr/bin/env node
// =============================================================================
// 사이드바 하단 프로필 행의 흔들림 측정 (#3276).
//
//   npm run build && node scripts/capture-profile-jitter.mjs
//   → OUT_DIR(기본 artifacts/profile-jitter)/*.png + report.json
//
// 진짜 앱 셸을 Chromium으로 열고 프로필 단추를 누르는 동안(호버 → 누름 → 놓음 →
// 메뉴 열림 → 닫힘 → 키보드 포커스) 아바타·이름·상태 이모지·점의 레이아웃 상자와
// 그림 상자(transform 반영)를 매 프레임 잰다. 백엔드는 없다(`/v1/**` 고정 응답).
// 레이아웃 상자(offset*)는 transform을 반영하지 않으므로 둘을 함께 적는다:
// 눈에 보이는 흔들림은 그림 상자(getBoundingClientRect)에서 나온다.
// =============================================================================
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/profile-jitter");
const PORT = Number(process.env.CAPTURE_PORT || 5198);
const TOLERANCE = 0.01; // px. 소수점 잡음만 허용한다.

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const channels = [
  { id: "00000000-0000-7000-8000-000000000201", workspaceId, kind: "public", name: "general", muted: false },
];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "kwak", handle: "kwak" },
  realtimeWebSocketUrl: "ws://profile-jitter-capture.invalid/connection/websocket",
};
const roster = [
  {
    id: memberId, workspaceId, kind: "human", status: "active", role: "owner", displayName: "kwak",
    handle: "kwak", channelCount: 1, channelIds: channels.map((c) => c.id), capabilities: [],
    presenceStatus: "dnd", statusEmoji: "🏝️", statusText: "휴가 중",
    createdAtMs: 0, updatedAtMs: 0,
  },
];

const json = (route, body) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
async function installRoutes(context) {
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
}
async function installRealtime(page) {
  await page.addInitScript(() => {
    class CaptureSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      constructor(url) { this.url = String(url); this.readyState = 0; queueMicrotask(() => { this.readyState = 1; this.onopen?.(new Event("open")); }); }
      send(data) {
        const replies = String(data).trim().split("\n").map((line) => {
          const c = JSON.parse(line);
          if (c.connect) return { id: c.id, connect: { client: "profile-jitter", version: "6" } };
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

// 프레임마다 재는 대상. 그림 상자는 transform을 반영하고, 레이아웃 상자는 반영하지 않는다.
const PROBE = `
(() => {
  const sel = {
    trigger: "[data-testid='profile-card']",
    avatar: "[data-testid='profile-card'] [data-testid='presence-control']",
    name: "[data-testid='self-name']",
    emoji: "[data-testid='custom-status-emoji']",
    dot: "[data-testid='profile-card'] [data-testid='presence-control'] > span",
  };
  const out = {};
  for (const [k, s] of Object.entries(sel)) {
    const el = document.querySelector(s);
    if (!el) { out[k] = null; continue; }
    const r = el.getBoundingClientRect();
    out[k] = {
      x: r.x, y: r.y, w: r.width, h: r.height,
      lw: el.offsetWidth, lh: el.offsetHeight, // offsetLeft/Top는 transform 조상을 offsetParent로 삼아 못 쓴다
    };
  }
  const t = document.querySelector(sel.trigger);
  out.transform = t ? getComputedStyle(t).transform : null;
  out.outline = t ? getComputedStyle(t).outlineStyle + " " + getComputedStyle(t).outlineWidth : null;
  out.state = t ? t.getAttribute("data-state") : null;
  return out;
})()`;

function flat(sample) {
  const o = {};
  for (const k of ["trigger", "avatar", "name", "emoji", "dot"]) {
    const b = sample[k];
    if (!b) continue;
    for (const f of ["x", "y", "w", "h", "lw", "lh"]) o[`${k}.${f}`] = b[f];
  }
  return o;
}

/** 기준 프레임 대비 가장 크게 움직인 값과 어느 단계였는지. */
function worst(baseline, frames) {
  const base = flat(baseline);
  let max = 0, at = null;
  const perKey = {};
  for (const f of frames) {
    const cur = flat(f.sample);
    for (const k of Object.keys(base)) {
      if (cur[k] === undefined) continue;
      const d = Math.abs(cur[k] - base[k]);
      if (d > (perKey[k]?.d ?? 0)) perKey[k] = { d: Math.round(d * 1000) / 1000, step: f.step };
      if (d > max) { max = d; at = `${f.step}:${k}`; }
    }
  }
  return { max: Math.round(max * 1000) / 1000, at, perKey };
}

async function run(browser, origin, scheme, viewport, report) {
  const tag = `${viewport.width}-${scheme}`;
  const context = await browser.newContext({ viewport, colorScheme: scheme }); // 모션 줄임 없음: 실제 전이를 잰다
  await installRoutes(context);
  const page = await context.newPage();
  await installRealtime(page);
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("profile-card").waitFor({ timeout: 20_000 });
  await page.getByTestId("custom-status-emoji").waitFor({ timeout: 10_000 });
  await page.waitForTimeout(500);
  if (viewport.width < 600) {
    // 폰 폭: 사이드바는 서랍이다.
    await page.getByTestId("open-sidebar-drawer").first().click();
    await page.waitForTimeout(500);
  }
  const probe = () => page.evaluate(PROBE);
  const baseline = await probe();
  const frames = [];
  const grab = async (step, settle = 0) => {
    if (settle) await page.waitForTimeout(settle);
    frames.push({ step, sample: await probe() });
  };
  // 전이 도중을 잡기 위해 rAF로 연속 표본을 모은다.
  await page.evaluate((src) => {
    window.__jit = [];
    window.__jitStop = false;
    const probe = () => (0, eval)(src);
    const tick = () => { window.__jit.push({ t: performance.now(), s: probe() }); if (!window.__jitStop) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }, PROBE);

  const box = await page.getByTestId("profile-card").boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await grab("hover", 250);
  await page.mouse.down();
  await grab("pressed", 20);
  await grab("pressed-settled", 250);
  await page.screenshot({ path: resolve(OUT_DIR, `pressed-${tag}.png`), clip: { x: 0, y: Math.max(0, box.y - 60), width: Math.min(viewport.width, 420), height: Math.min(viewport.height - Math.max(0, box.y - 60), box.height + 120) } });
  await page.mouse.up();
  await page.getByTestId("profile-card-menu").waitFor();
  await grab("menu-open-early", 30);
  await grab("menu-open-settled", 400);
  await page.screenshot({ path: resolve(OUT_DIR, `open-${tag}.png`) });
  await page.keyboard.press("Escape");
  await page.getByTestId("profile-card-menu").waitFor({ state: "detached" });
  await grab("menu-closed-early", 30);
  await grab("menu-closed-settled", 400);
  await page.mouse.move(2, 2);
  await grab("unhover", 250);
  await page.keyboard.press("Tab");
  await grab("keyboard-focus", 150);
  await page.screenshot({ path: resolve(OUT_DIR, `focus-${tag}.png`) });

  const stream = await page.evaluate(() => { window.__jitStop = true; return window.__jit; });
  const streamFrames = stream.map((f, i) => ({ step: `rAF#${i}@${Math.round(f.t)}`, sample: f.s }));
  const w1 = worst(baseline, frames);
  const w2 = worst(baseline, streamFrames);
  const transforms = [...new Set(stream.map((f) => f.s.transform))].map((t) => (t.length > 40 ? t.slice(0, 22) + '…' : t)).slice(0, 4);
  const outlines = [...new Set(stream.map((f) => f.s.outline))];
  report[tag] = { baseline: flat(baseline), steps: w1, frames: w2, streamFrameCount: stream.length, transforms, outlines };
  const byStep = {};
  for (const f of frames) byStep[f.step] = worst(baseline, [f]).max;
  console.log(`   단계별 최대 이동(px): ${JSON.stringify(byStep)}`);
  console.log(`${w1.max <= TOLERANCE && w2.max <= TOLERANCE ? "ok  " : "FAIL"} ${tag} 최대 이동 단계 ${w1.max}px (${w1.at}) · 연속 ${stream.length}프레임 ${w2.max}px (${w2.at}) · transform ${JSON.stringify(transforms)}`);
  report[tag].ok = w1.max <= TOLERANCE && w2.max <= TOLERANCE;
  await context.close();
  return report[tag].ok;
}

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) throw new Error("dist/ is missing. Run npm run build first.");
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  const report = {};
  let ok = true;
  try {
    for (const scheme of ["light", "dark"]) {
      for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 780 }]) {
        ok = (await run(browser, preview.origin, scheme, viewport, report)) && ok;
      }
    }
  } finally {
    await browser.close();
    await preview.stop?.();
  }
  writeFileSync(resolve(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));
  if (!ok && !process.env.JITTER_ALLOW_FAIL) process.exitCode = 1;
}
main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => { console.error(e); process.exit(1); });
