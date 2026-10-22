#!/usr/bin/env node
// =============================================================================
// AP-1b(#4188) 캡처: 테마 갤러리·카탈로그 테마로 선 앱 (전/후, 라이트·다크, 1440·390).
//
//   LABEL=before DIST=<기준 dist> WEB_ROOT=<기준 clients/web> SCENES=base node scripts/capture-4188.mjs
//   LABEL=after  DIST=dist SCENES=app,gallery node scripts/capture-4188.mjs
//
// 장면
//   base     기준(AP-1b 전): 설정 > 모양의 「색상」 카드(테마 스타일 행 없음)를 새벽하늘·흑연·노을띠 라이트·다크로.
//   app      대표 여덟 테마(새벽하늘·흑연·노을띠·github·catppuccin·nord(다크 단독)·solarized·gruvbox-hard)로 선 앱을
//            라이트·다크(단독은 한 모드) × 1440·390. 저장소에 외양 v2 레코드를 **심고** 불러온다(첫 페인트 경로도 잰다).
//   gallery  설정 > 모양의 테마 스타일 행: 접힘, 시스템·라이트·다크 세 목록을 펼친 모습(1440, 390), 스크롤 아래쪽.
//
// 백엔드 없이 `/v1/**` 고정 응답 + 가짜 소켓. 벽시계·로케일·시간대를 고정한다.
// =============================================================================
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = process.env.WEB_ROOT
  ? resolve(process.env.WEB_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LABEL = process.env.LABEL || "after";
const DIST = process.env.DIST || "dist";
const OUT_ROOT = process.env.OUT_ROOT
  ? resolve(process.env.OUT_ROOT)
  : resolve(WEB_ROOT, "artifacts/ap1b-4188");
const PORT = Number(process.env.CAPTURE_PORT || 5388);

const FIXTURE_NOW = Date.parse("2026-10-21T09:30:00+09:00");
const MIN = 60_000;
const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const agentId = "00000000-0000-7000-8000-000000000301";
const CH = "00000000-0000-7000-8000-000000000201";
const GENERAL = "00000000-0000-7000-8000-000000000202";
const P = (n) => `00000000-0000-7000-8000-0000000001${n}`;
const person = (id, kind, displayName, handle, extra = {}) => ({
  id, workspaceId, kind, status: "active", displayName, handle, channelCount: 2,
  channelIds: [CH, GENERAL], capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...extra,
});
const roster = [
  person(memberId, "human", "곽성재", "seongjae", { role: "owner" }),
  person(P("11"), "human", "이도현", "dohyun"),
  person(P("12"), "human", "박서연", "seoyeon"),
  person(P("13"), "human", "최민수", "minsu"),
  person(P("15"), "human", "정하윤", "hayun"),
  person(agentId, "agent", "그록", "grok", { ownerHumanId: memberId }),
];
const channels = [
  { id: CH, workspaceId, kind: "public", name: "계획", muted: false },
  { id: GENERAL, workspaceId, kind: "public", name: "general", muted: false },
];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: "ws://ap1a-4188-capture.invalid/connection/websocket",
};
const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

function messageRows() {
  const m = (n, author, body, ago) => ({
    id: `00000000-0000-7000-8000-0000000a00${String(n).padStart(2, "0")}`,
    channelId: CH, seq: 10 + n, hlcTs: FIXTURE_NOW - ago, hlcCount: 0, authorMemberId: author,
    type: "text", body, state: "sent", createdAtMs: FIXTURE_NOW - ago,
  });
  return [
    m(1, P("11"), "주간 회의 자료 올렸어요. 3쪽 숫자만 같이 봐 주세요.", 42 * MIN),
    m(2, P("12"), "확인했어요. 매출 표는 다시 계산해서 올릴게요.", 38 * MIN),
    m(3, P("13"), "저는 일정 쪽을 맡을게요. 배포 전날 점검은 제가 해요.", 31 * MIN),
    m(4, P("15"), "디자인 시안은 내일 오전에 공유해요. Figma 링크는 그때 붙일게요.", 24 * MIN),
    m(5, agentId, "요약해 둘게요. 필요한 일이 있으면 말씀해 주세요.", 12 * MIN),
    m(6, memberId, "이번 주 일정 정리해 줘", 4 * MIN),
  ];
}

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
    if (/\/agents\/([^/]+)\/liveness$/.test(path)) return json(route, { error: { code: "not_found", message: "not found" } }, 404);
    if (path.endsWith("/hosted-agent-connections") && method === "GET") return json(route, { connections: [] });
    if (path.endsWith("/allowed-models")) return json(route, { allowedAgentModels: [] });
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/read-state") && method === "GET") {
      return json(route, { read_states: channels.map((c) => ({ channel_id: c.id, last_read_seq: 99, latest_seq: 99, unread_count: 0, mention_count: 0, marked_unread_before_seq: null })) });
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
    if (path.includes(`/channels/${CH}/messages`)) return json(route, { messages: messageRows() });
    if (path.includes("/messages")) return json(route, { messages: [] });
    return json(route, {});
  });
}

async function installPageFixtures(page) {
  // 벽시계를 얼린다(하우스 패턴: capture-screens.mjs `pinPageWallClock`). 타임라인의 시각이 찍는 시각에 안 흔들리게.
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
        this.url = String(url); this.readyState = 0; window.__socket = this;
        queueMicrotask(() => { this.readyState = 1; this.onopen?.(new Event("open")); });
      }
      send(data) {
        const replies = String(data).trim().split("\n").map((line) => {
          const c = JSON.parse(line);
          if (c.connect) return { id: c.id, connect: { client: "4188-capture", version: "6" } };
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

const settle = (page) =>
  page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  });


const SCENES = (process.env.SCENES || "app,gallery").split(",");
const REPS = [
  { ref: "dawnsky", name: "dawnsky", modes: ["light", "dark"] },
  { ref: "graphite", name: "graphite", modes: ["light", "dark"] },
  { ref: "noeul", name: "noeul", modes: ["light", "dark"] },
  { ref: "catalog:github", name: "github", modes: ["light", "dark"] },
  { ref: "catalog:catppuccin", name: "catppuccin", modes: ["light", "dark"] },
  { ref: "catalog:nord", name: "nord", modes: ["dark"] },
  { ref: "catalog:solarized", name: "solarized", modes: ["light", "dark"] },
  { ref: "catalog:gruvbox-hard", name: "gruvbox-hard", modes: ["light", "dark"] },
];
const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "390", width: 390, height: 844 },
];

const APPEARANCE_KEY = "momo.web.appearance.v2";
const seedRecord = (over) => JSON.stringify({ v: 2, scheme: "system", theme: "dawnsky", signal: null, density: "comfortable", ...over });

const outDir = () => resolve(OUT_ROOT, LABEL);
const meta = [];

async function openWith(browser, origin, { osScheme, viewport, record }) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: osScheme,
    reducedMotion: "reduce",
    serviceWorkers: "block",
    deviceScaleFactor: 2,
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
  });
  await installRoutes(context);
  if (record) {
    await context.addInitScript(([key, value]) => {
      try { localStorage.setItem(key, value); } catch { /* 저장소 없는 캡처 */ }
    }, [APPEARANCE_KEY, record]);
  }
  const page = await context.newPage();
  await installPageFixtures(page);
  await page.addInitScript((server) => {
    try { localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ }
  }, origin);
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("profile-card").waitFor({ timeout: 20_000 });
  return { context, page };
}

async function facts(page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const inline = [...root.style].filter((n) => n.startsWith("--"));
    const cs = getComputedStyle(root);
    return {
      palette: root.getAttribute("data-palette"),
      themeRef: root.getAttribute("data-theme-ref"),
      dataTheme: root.getAttribute("data-theme"),
      signal: root.getAttribute("data-signal"),
      inlineVars: inline.length,
      canvas: cs.getPropertyValue("--canvas-mid").trim(),
      ink: cs.getPropertyValue("--ink").trim(),
      themeColor: [...document.querySelectorAll("meta[name='theme-color']")].map((m) => m.getAttribute("content")),
    };
  });
}

async function shoot(page, name, extra = {}) {
  await settle(page);
  const path = resolve(outDir(), `${name}.png`);
  await page.screenshot({ path, animations: "disabled", caret: "hide" });
  meta.push({ name, ...extra, root: await facts(page) });
}

async function goChat(page) {
  await page.evaluate((id) => { location.hash = `/c/${id}`; }, CH);
  await page.getByText("이번 주 일정 정리해 줘").first().waitFor({ timeout: 15_000 });
  await page.waitForTimeout(500);
}

async function goAppearance(page) {
  await page.evaluate(() => { location.hash = "/settings?section=appearance"; });
  await page.waitForSelector('[data-testid="theme-choice"]', { timeout: 15_000 });
  await page.waitForTimeout(400);
}

async function appScenes(browser, origin) {
  for (const rep of REPS) {
    for (const mode of rep.modes) {
      for (const viewport of VIEWPORTS) {
        const record = seedRecord({ theme: rep.ref, scheme: mode });
        const { context, page } = await openWith(browser, origin, { osScheme: mode, viewport, record });
        try {
          await goChat(page);
          await shoot(page, `app-${rep.name}-${mode}-${viewport.name}`, { theme: rep.ref, mode, viewport: viewport.name });
        } finally {
          await context.close();
        }
      }
    }
  }
}

async function galleryScenes(browser, origin) {
  const github = (scheme) => seedRecord({ theme: "catalog:github", scheme });
  for (const viewport of VIEWPORTS) {
    for (const mode of ["system", "light", "dark"]) {
      const osScheme = mode === "dark" ? "dark" : "light";
      const { context, page } = await openWith(browser, origin, { osScheme, viewport, record: github(mode) });
      try {
        await goAppearance(page);
        await page.getByTestId("theme-style-trigger").waitFor({ timeout: 15_000 });
        await page.getByTestId("theme-style-trigger").scrollIntoViewIfNeeded();
        await shoot(page, `gallery-closed-${mode}-${viewport.name}`, { mode, viewport: viewport.name, open: false });
        await page.getByTestId("theme-style-trigger").click();
        await page.getByTestId("theme-style-options").waitFor();
        await page.waitForTimeout(300);
        await page.getByTestId("theme-style-options").scrollIntoViewIfNeeded();
        const tiles = await page.locator(".theme-tile").count();
        await shoot(page, `gallery-open-${mode}-${viewport.name}`, { mode, viewport: viewport.name, open: true, tiles });
        if (viewport.name === "1440") {
          // 목록 안에서 끝까지 스크롤한 모습(아래 페이드).
          await page.locator(".theme-gallery-scroll").evaluate((el) => { el.scrollTop = el.scrollHeight; });
          await page.waitForTimeout(200);
          await shoot(page, `gallery-open-${mode}-${viewport.name}-bottom`, { mode, viewport: viewport.name, open: true, scrolled: "bottom", tiles });
        }
      } finally {
        await context.close();
      }
    }
  }
}

async function baseScenes(browser, origin) {
  for (const viewport of VIEWPORTS) {
    for (const mode of ["light", "dark"]) {
      const { context, page } = await openWith(browser, origin, { osScheme: mode, viewport, record: seedRecord({ scheme: mode }) });
      try {
        await goAppearance(page);
        await shoot(page, `settings-appearance-${mode}-${viewport.name}`, { mode, viewport: viewport.name });
      } finally {
        await context.close();
      }
    }
  }
}

async function capture() {
  const distDir = resolve(WEB_ROOT, DIST);
  if (!existsSync(resolve(distDir, "index.html"))) throw new Error(`${distDir}/index.html 이 없다. 먼저 빌드한다.`);
  mkdirSync(outDir(), { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT", extraArgs: ["--outDir", distDir] });
  const browser = await chromium.launch();
  try {
    if (SCENES.includes("base")) await baseScenes(browser, preview.origin);
    if (SCENES.includes("app")) await appScenes(browser, preview.origin);
    if (SCENES.includes("gallery")) await galleryScenes(browser, preview.origin);
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
