#!/usr/bin/env node
// =============================================================================
// 설정 > 모양 > 「유리 배경」 행의 화면 증거 (AP-3 #4190, AC 4·5): 브라우저(Chromium)에서 찍는 절반.
//
//   npm run build
//   LABEL=after  DIST=dist                 node scripts/capture-4190.mjs
//   LABEL=before DIST=artifacts/dist-before node scripts/capture-4190.mjs     (변경 전 번들. 데스크탑 장면은 건너뛴다)
//
// 장면은 둘로 나뉜다.
//   · 브라우저: 있는 그대로의 번들. 유리 행은 「macOS 데스크탑 앱에서 쓸 수 있어요」로 잠겨 있다(폴백 1).
//     라이트·다크 × 1440·390.
//   · 데스크탑 흉내(`after`만): 맥 데스크탑 셸이라고 **페이지가 믿게** `__TAURI_INTERNALS__`와 `navigator.platform`을
//     심는다. 네이티브 호출(`window_vibrancy_set`)은 가짜가 받는다 — 그래서 이 장면에는 **진짜 블러가 없다**(일반
//     Chromium 창은 뒤가 비치지 않는다). 보는 것은 행의 문구·상태·슬라이더와 데이터 속성이고, 진짜 유리는 실제 앱
//     캡처(데스크탑 셸 + 합성 바탕)가 맡는다. 장면: 꺼짐 / 켬(슬라이더) / 켜기 실패(가짜가 거절) / 투명도 줄이기
//     (대비 높이기 흉내, 아래) / 배경화면이 켜져 있어 잠김.
//
// 「투명도 줄이기」는 `prefers-contrast: more` 흉내로 대신한다: WKWebView는 `prefers-reduced-transparency`를 구현하지
// 않고(macOS 27 실측, `no-preference` 질의가 거짓이다) Chromium 흉내도 그 질의를 안 준다. 코드는 두 질의를 같은
// 갈래로 읽으므로(desktopEffects.ts `REDUCED_TRANSPARENCY_QUERIES`) 고대비 흉내가 같은 경로를 탄다.
//
// 백엔드 없이 `/v1/**` 고정 응답 + 가짜 소켓(capture-4186과 같은 길). 벽시계·로케일·시간대를 고정한다.
// =============================================================================
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";

const WEB_ROOT = process.env.WEB_ROOT
  ? resolve(process.env.WEB_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LABEL = process.env.LABEL || "after";
const DIST = process.env.DIST || "dist";
const OUT_ROOT = process.env.OUT_ROOT ? resolve(process.env.OUT_ROOT) : resolve(WEB_ROOT, "artifacts/ap3-4190");
const PORT = Number(process.env.CAPTURE_PORT || 5390);

const FIXTURE_NOW = Date.parse("2026-10-22T09:30:00+09:00");
const SCHEMES = ["light", "dark"];
const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "390", width: 390, height: 844 },
];

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const CH = "00000000-0000-7000-8000-000000000201";
const GENERAL = "00000000-0000-7000-8000-000000000202";
const person = (id, kind, displayName, handle, extra = {}) => ({
  id, workspaceId, kind, status: "active", displayName, handle, channelCount: 2,
  channelIds: [CH, GENERAL], capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...extra,
});
const roster = [person(memberId, "human", "곽성재", "seongjae", { role: "owner" })];
const channels = [
  { id: CH, workspaceId, kind: "public", name: "계획", muted: false },
  { id: GENERAL, workspaceId, kind: "public", name: "general", muted: false },
];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: "ws://ap3-4190-capture.invalid/connection/websocket",
};
const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function installRoutes(context) {
  await context.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: FIXTURE_NOW + 600_000, ttlSeconds: 60, workspaceId, memberId });
    }
    if (/\/inbox(\/|$)/.test(path)) return json(route, { error: { code: "not_found", message: "not found" } }, 404);
    if (path.endsWith("/agent-runs/progress")) return json(route, { runs: [] });
    if (path.endsWith("/hosted-agent-connections") && method === "GET") return json(route, { connections: [] });
    if (path.endsWith("/allowed-models")) return json(route, { allowedAgentModels: [] });
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/read-state") && method === "GET") {
      return json(route, { read_states: channels.map((c) => ({ channel_id: c.id, last_read_seq: 0, latest_seq: 0, unread_count: 0, mention_count: 0, marked_unread_before_seq: null })) });
    }
    if (path.endsWith("/approvals")) return json(route, { approvals: [] });
    if (path.endsWith("/agent-runs")) return json(route, { runs: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/members/me/sidebar-prefs")) return json(route, { prefs: { version: 1, sections: [], starredChannelIds: [] } });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: [] });
    if (path.endsWith("/work-sessions/shared")) return json(route, { sessions: [], nextCursor: null });
    if (path.endsWith("/work-sessions")) return json(route, { workSessions: [] });
    if (path.endsWith("/reminders")) return json(route, { reminders: [] });
    if (path.endsWith(`/workspaces/${workspaceId}`)) return json(route, { workspace: { id: workspaceId, name: "여명거리" } });
    if (path.includes("/messages")) return json(route, { messages: [] });
    return json(route, {});
  });
}

async function installPageFixtures(page) {
  await page.addInitScript((now) => {
    const NativeDate = Date;
    function FrozenDate(...args) {
      if (new.target) return Reflect.construct(NativeDate, args.length === 0 ? [now] : args);
      return new NativeDate(now).toString();
    }
    FrozenDate.now = () => now;
    FrozenDate.parse = NativeDate.parse.bind(NativeDate);
    FrozenDate.UTC = NativeDate.UTC.bind(NativeDate);
    FrozenDate.prototype = NativeDate.prototype;
    FrozenDate.prototype.constructor = FrozenDate;
    globalThis.Date = FrozenDate;
  }, FIXTURE_NOW);
  await page.addInitScript(() => {
    class CaptureSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      constructor(url) {
        this.url = String(url); this.readyState = 0;
        queueMicrotask(() => { this.readyState = 1; this.onopen?.(new Event("open")); });
      }
      send(data) {
        const replies = String(data).trim().split("\n").map((line) => {
          const c = JSON.parse(line);
          if (c.connect) return { id: c.id, connect: { client: "4190-capture", version: "6" } };
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

/** 맥 데스크탑 셸이라고 페이지가 믿게 한다. 네이티브 호출은 가짜가 받고 기록한다(`window.__tauriCalls`). */
async function installDesktopMock(page, { refuseVibrancy }) {
  await page.addInitScript((refuse) => {
    let n = 0;
    window.__tauriCalls = [];
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
      transformCallback: () => ++n,
      unregisterCallback: () => {},
      convertFileSrc: (path) => path,
      invoke: async (cmd, args) => {
        window.__tauriCalls.push([cmd, args ?? null]);
        if (cmd === "keychain_available") return false;
        if (cmd === "window_vibrancy_set") {
          if (refuse && args && args.enabled) throw "capture: the shell refused";
          return null;
        }
        if (cmd === "plugin:event|listen") return ++n;
        return null;
      },
    };
    Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
  }, refuseVibrancy);
}

/** 서버 주소와 로그인한 세션을 심어 로그인 화면을 건너뛴다. 저장소에 외양 레코드가 필요하면 함께 심는다. */
async function seed(page, origin, appearance) {
  await page.addInitScript(
    ({ server, session, record }) => {
      try {
        localStorage.setItem("momo.web.server.v1", server);
        localStorage.setItem("momo.web.session.v1", JSON.stringify(session));
        if (record) localStorage.setItem("momo.web.appearance.v2", JSON.stringify(record));
      } catch {
        /* 저장소 없는 캡처 */
      }
    },
    {
      server: origin,
      session: { refreshToken: auth.refreshToken, realtimeWebSocketUrl: auth.realtimeWebSocketUrl, member: auth.member },
      record: appearance ?? null,
    }
  );
}

const outDir = () => resolve(OUT_ROOT, LABEL);
const meta = [];

async function open(browser, origin, scheme, viewport, options = {}) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: scheme,
    reducedMotion: "reduce",
    serviceWorkers: "block",
    deviceScaleFactor: 2,
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    ...(options.contrast ? { contrast: options.contrast } : {}),
  });
  await installRoutes(context);
  const page = await context.newPage();
  await installPageFixtures(page);
  if (options.desktop) await installDesktopMock(page, { refuseVibrancy: options.refuse === true });
  await seed(page, origin, options.appearance);
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.getByTestId("profile-card").waitFor({ timeout: 20_000 });
  await page.evaluate(() => { location.hash = "/settings?section=appearance"; });
  await page.waitForSelector('[data-testid="theme-choice"]', { timeout: 15_000 });
  await page.waitForTimeout(600);
  return { context, page };
}

async function shoot(page, name, facts = {}) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
  const path = resolve(outDir(), `${name}.png`);
  await page.screenshot({ path, animations: "disabled", caret: "hide" });
  const state = await page.evaluate(() => {
    const root = document.documentElement;
    const toggle = document.querySelector('[data-testid="glass-background-toggle"]');
    const slider = document.querySelector('[data-testid="glass-opacity-slider"]');
    const row = document.querySelector('[data-testid="glass-background-row"]');
    return {
      dataGlass: root.hasAttribute("data-glass"),
      toggle: toggle ? { disabled: toggle.disabled, checked: toggle.getAttribute("aria-checked") } : null,
      slider: slider ? { min: slider.min, max: slider.max, value: slider.value, valuetext: slider.getAttribute("aria-valuetext") } : null,
      rowText: row ? row.textContent : null,
      calls: window.__tauriCalls ?? null,
    };
  });
  meta.push({ name, ...facts, state });
}

/** 유리 행이 화면 가운데에 오게 스크롤한다(행이 없으면 제자리). */
async function centerGlassRow(page) {
  await page.evaluate(() => {
    const row = document.querySelector('[data-testid="glass-background-row"]');
    row?.scrollIntoView({ block: "center" });
  });
  await page.waitForTimeout(200);
}

async function browserScenes(browser, origin, scheme, viewport) {
  const { context, page } = await open(browser, origin, scheme, viewport);
  try {
    await centerGlassRow(page);
    await shoot(page, `settings-appearance-${scheme}-${viewport.name}`, { scheme, viewport: viewport.name, env: "browser" });
  } finally {
    await context.close();
  }
}

async function desktopScenes(browser, origin, scheme, viewport) {
  const base = { scheme, viewport: viewport.name, env: "desktop-mock" };
  // 꺼짐
  {
    const { context, page } = await open(browser, origin, scheme, viewport, { desktop: true });
    try {
      await centerGlassRow(page);
      await shoot(page, `desktop-off-${scheme}-${viewport.name}`, base);
      // 켬: 슬라이더가 열리고 data-glass가 선다(가짜 네이티브가 성공했으므로).
      await page.getByTestId("glass-background-toggle").click();
      await page.getByTestId("glass-opacity-slider").waitFor({ timeout: 5_000 });
      await page.waitForFunction(() => document.documentElement.hasAttribute("data-glass"), null, { timeout: 5_000 });
      await centerGlassRow(page);
      await shoot(page, `desktop-on-${scheme}-${viewport.name}`, base);
      // 슬라이더 끝(하한과 95)
      await page.getByTestId("glass-opacity-slider").focus();
      await page.keyboard.press("End");
      await page.waitForTimeout(300);
      await shoot(page, `desktop-on-max-${scheme}-${viewport.name}`, base);
    } finally {
      await context.close();
    }
  }
  if (viewport.name !== "1440") return;
  // 켜기 실패(가짜가 거절): 스위치가 꺼지고 행 안 문장이 선다.
  {
    const { context, page } = await open(browser, origin, scheme, viewport, { desktop: true, refuse: true });
    try {
      await centerGlassRow(page);
      await page.getByTestId("glass-background-toggle").click();
      await page.getByTestId("glass-background-failed").waitFor({ timeout: 5_000 });
      await centerGlassRow(page);
      await shoot(page, `desktop-failed-${scheme}-${viewport.name}`, base);
    } finally {
      await context.close();
    }
  }
  // 투명도 줄이기(대비 높이기 흉내): 켠 채로 두고 그리지 않는다.
  {
    const { context, page } = await open(browser, origin, scheme, viewport, {
      desktop: true,
      contrast: "more",
      appearance: { v: 2, scheme: "system", theme: "dawnsky", signal: null, density: "comfortable", glass: { on: true } },
    });
    try {
      const matches = await page.evaluate(() => matchMedia("(prefers-contrast: more)").matches);
      if (!matches) throw new Error("prefers-contrast: more 가 켜지지 않았다. 이 장면은 폴백 2를 재지 못한다.");
      await centerGlassRow(page);
      await page.waitForTimeout(300);
      await shoot(page, `desktop-reduced-${scheme}-${viewport.name}`, { ...base, emulated: "prefers-contrast: more" });
    } finally {
      await context.close();
    }
  }
  // 배경화면이 켜져 있어 잠김(결정 9): 외양 레코드의 `wallpaper`가 한 칸이다.
  {
    const { context, page } = await open(browser, origin, scheme, viewport, {
      desktop: true,
      appearance: {
        v: 2, scheme: "system", theme: "dawnsky", signal: null, density: "comfortable",
        glass: { on: true }, wallpaper: { kind: "solid", id: "slate" },
      },
    });
    try {
      await centerGlassRow(page);
      await shoot(page, `desktop-wallpaper-${scheme}-${viewport.name}`, base);
    } finally {
      await context.close();
    }
  }
}

async function capture() {
  const distDir = resolve(WEB_ROOT, DIST);
  if (!existsSync(resolve(distDir, "index.html"))) throw new Error(`${distDir}/index.html 이 없다. 먼저 빌드한다.`);
  mkdirSync(outDir(), { recursive: true });
  const preview = await startGuardedPreview({
    webRoot: WEB_ROOT,
    port: PORT,
    portEnvVar: "CAPTURE_PORT",
    extraArgs: ["--outDir", distDir],
  });
  const browser = await chromium.launch();
  try {
    for (const scheme of SCHEMES) {
      for (const viewport of VIEWPORTS) {
        await browserScenes(browser, preview.origin, scheme, viewport);
        if (LABEL !== "before") await desktopScenes(browser, preview.origin, scheme, viewport);
      }
    }
  } finally {
    await browser.close();
    await preview.stop?.();
  }
  writeFileSync(resolve(outDir(), "meta.json"), JSON.stringify({ label: LABEL, dist: DIST, shots: meta }, null, 1));
  console.log(`CAPTURE ${LABEL}: ${meta.length} shots -> ${outDir()}`);
}

capture().catch((error) => {
  console.error(error);
  process.exit(1);
});
