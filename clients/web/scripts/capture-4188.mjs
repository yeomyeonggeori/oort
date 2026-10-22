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
//   states   새 화면의 상태들: 청크를 받는 동안(자리 막대) · 받지 못했을 때(한 줄) · 거절된 강조색 칩과 이유 한 줄 ·
//            색 모드를 바꿔 테마가 옮겨진 안내(규칙 2·3) · 타일을 눌러 전 화면이 바뀐 모습 · 타일 키보드 초점 ·
//            가리킴·눌림·트리거 초점·칩 초점 · 펼칠 때 고른 타일로 스크롤(390, 늦은 알파벳 테마).
//   review   설계 리뷰 1차가 요청한 앱 화면: vscode-plus·min·synthwave-84·kanagawa(안 읽음 배지·멘션이 있는 사이드바,
//            가리킨 행) × 라이트·다크 × 1440·390. 강조색을 고른 카탈로그 앱 화면(frappe 다크 + 홍염은 거절).
//   design   디자인 갤러리 `#/design`의 「칩 그릇」·「States」 구역을 구역별 요소 사진으로(쪽 전체 사진은 늦게 그려지는 구역이 비어
//            있다) × 같은 테마들 + 첫 파티 둘. `VITE_DESIGN_GALLERY=1`로 빌드한 dist를 `DIST_DESIGN`으로 준다.
//   widths   설정 > 모양 900·1280(접힘·펼침).
//   extra    설계 리뷰 2차가 요청한 나머지: 컴포저 `@` 자동완성의 강조된 줄(선택 행 `accent-soft`) × 어두운·밝은 카탈로그 테마 ·
//            640~760px 폭의 갤러리 · 390 다크 탭에서 격자 안쪽을 스크롤한 중간 장면.
//   names    접힌 행의 테마 이름이 한 줄이고 잘리거나 넘치지 않는가를 **모든** 타일(시스템·라이트·다크 탭)에서 320~760 폭으로 잰다
//            (설계 리뷰 2차 H-A). 그리고 배치가 이름마다 갈리지 않는가(한 줄 · 이름 위 썸네일 아래 · chevron만 홀로 아랫줄)와 선택해도
//            트리거 높이가 뛰지 않는가를 잰다(3차 M-1). 고를 때마다 **고른 타일의 이름**이 잘리지 않는지와 열린 격자가 움직이지 않는지도
//            재고(4차 B-1), 글자 크기는 기본과 「크게」 둘이다. 어기는 것이 하나라도 있으면 캡처가 실패한다(종료 코드 1). 사진은 한 장씩 남긴다
//            (접힌 행, 폰 폭에서는 열린 갤러리에서 가장 긴 이름을 고른 모양).
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
const DESIGN = "00000000-0000-7000-8000-000000000203";
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
// 안 읽음 장면(`unread`)에서만 채널 하나를 더한다: general은 멘션 한 건이 든 안 읽음, design은 멘션 없는 안 읽음 다섯 건.
const channelsFor = (unread) => (unread ? [...channels, { id: DESIGN, workspaceId, kind: "public", name: "design", muted: false }] : channels);
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: "ws://ap1a-4188-capture.invalid/connection/websocket",
};
const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

function messageRows(unread = false) {
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
    // 신호색이 앱에서 보이는 자리(`unread` 장면만): 나를 부른 멘션은 신호 채움, 다른 멤버 멘션은 신호 옅은 채움이다.
    ...(unread ? [m(7, P("11"), "@seongjae 배포 전에 @grok 한테 점검 요청해 주세요", 1 * MIN)] : []),
  ];
}

async function installRoutes(context, { unread = false } = {}) {
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
    if (path.endsWith("/channels")) return json(route, { channels: channelsFor(unread) });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/read-state") && method === "GET") {
      // 안 읽음 배지와 멘션은 신호의 일이다(설계 리뷰 1차): `unread`일 때만 general에 세 건·멘션 한 건을 둔다.
      const counts = { [GENERAL]: [3, 1], [DESIGN]: [5, 0] };
      return json(route, { read_states: channelsFor(unread).map((c) => ({ channel_id: c.id, last_read_seq: 99, latest_seq: 99, unread_count: unread ? (counts[c.id]?.[0] ?? 0) : 0, mention_count: unread ? (counts[c.id]?.[1] ?? 0) : 0, marked_unread_before_seq: null })) });
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
    if (path.includes(`/channels/${CH}/messages`)) return json(route, { messages: messageRows(unread) });
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
const REPS_ALL = [
  { ref: "dawnsky", name: "dawnsky", modes: ["light", "dark"] },
  { ref: "graphite", name: "graphite", modes: ["light", "dark"] },
  { ref: "noeul", name: "noeul", modes: ["light", "dark"] },
  { ref: "catalog:github", name: "github", modes: ["light", "dark"] },
  { ref: "catalog:catppuccin", name: "catppuccin", modes: ["light", "dark"] },
  { ref: "catalog:nord", name: "nord", modes: ["dark"] },
  { ref: "catalog:solarized", name: "solarized", modes: ["light", "dark"] },
  { ref: "catalog:gruvbox-hard", name: "gruvbox-hard", modes: ["light", "dark"] },
];
// `REPS=dawnsky,graphite,noeul`로 일부만 찍는다(전 번들은 카탈로그 테마를 모르므로 첫 파티만 의미가 있다).
const REPS_FILTER = process.env.REPS ? new Set(process.env.REPS.split(",")) : null;
const REPS = REPS_FILTER ? REPS_ALL.filter((rep) => REPS_FILTER.has(rep.name)) : REPS_ALL;
const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "390", width: 390, height: 844 },
];

const APPEARANCE_ENTRY = "momo.web.appearance.v2";
const seedRecord = (over) => JSON.stringify({ v: 2, scheme: "system", theme: "dawnsky", signal: null, density: "comfortable", ...over });

const outDir = () => resolve(OUT_ROOT, LABEL);
const meta = [];

async function openWith(browser, origin, { osScheme, viewport, record, prepare, unread = false }) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: osScheme,
    reducedMotion: "reduce",
    serviceWorkers: "block",
    deviceScaleFactor: 2,
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
  });
  await installRoutes(context, { unread });
  if (prepare) await prepare(context);
  if (record) {
    await context.addInitScript(([key, value]) => {
      try { localStorage.setItem(key, value); } catch { /* 저장소 없는 캡처 */ }
    }, [APPEARANCE_ENTRY, record]);
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
        // 미니 앱 제목은 좁은 타일에서 빠지고(display none) 접힌 행 썸네일에는 남는다. 증거로 meta에 적는다.
        const titles = await page.evaluate(() => {
          const shown = (el) => (el ? getComputedStyle(el).display : "absent");
          return {
            tile: shown(document.querySelector(".theme-tile-frame .theme-preview-title")),
            thumb: shown(document.querySelector(".theme-style-thumb .theme-preview-title")),
            tileWidth: Math.round(document.querySelector(".theme-tile-frame")?.getBoundingClientRect().width ?? 0),
            thumbWidth: Math.round(document.querySelector(".theme-style-thumb")?.getBoundingClientRect().width ?? 0),
          };
        });
        await shoot(page, `gallery-open-${mode}-${viewport.name}`, { mode, viewport: viewport.name, open: true, tiles, titles });
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

async function stateScenes(browser, origin) {
  const run = async (viewport, { osScheme = "light", record, prepare }, body) => {
    const { context, page } = await openWith(browser, origin, { osScheme, viewport, record, prepare });
    try {
      await body(page);
    } finally {
      await context.close();
    }
  };
  const settingsFacts = (page) =>
    page.evaluate(() => ({
      pending: !!document.querySelector('[data-testid="theme-style-row-pending"]'),
      failed: document.querySelector('[data-testid="theme-style-row-failed"]')?.textContent ?? null,
      reason: document.querySelector('[data-testid="accent-unavailable"]')?.textContent ?? null,
      disabledChips: [...document.querySelectorAll('.accent-swatch[aria-disabled="true"]')].map((n) => n.getAttribute("data-accent-swatch")),
      modeNotice: document.querySelector('[data-testid="theme-mode-notice"]')?.textContent ?? null,
      themeRef: document.documentElement.getAttribute("data-theme-ref") ?? document.documentElement.getAttribute("data-palette"),
      scheme: document.documentElement.getAttribute("data-theme"),
      focused: document.activeElement?.closest?.(".theme-tile")?.getAttribute("data-testid") ?? document.activeElement?.getAttribute?.("data-testid") ?? null,
    }));

  for (const viewport of VIEWPORTS) {
    // 1. 청크를 받는 동안: 같은 라벨의 행과 중립 막대 자리(행 높이가 변하지 않는다).
    await run(viewport, {
      record: seedRecord({ theme: "catalog:github", scheme: "light" }),
      prepare: (context) =>
        context.route("**/assets/ThemeGallery-*.js", async (route) => {
          await new Promise((done) => setTimeout(done, 15_000));
          await route.continue();
        }),
    }, async (page) => {
      await goAppearance(page);
      await page.getByTestId("theme-style-row-pending").waitFor({ timeout: 15_000 });
      await page.getByTestId("theme-style-row-pending").scrollIntoViewIfNeeded();
      await shoot(page, `state-pending-${viewport.name}`, { viewport: viewport.name, facts: await settingsFacts(page) });
    });

    // 2. 청크를 받지 못했을 때: 설정 화면은 서 있고 그 행만 한 줄로 말한다.
    await run(viewport, {
      record: seedRecord({ theme: "catalog:github", scheme: "light" }),
      prepare: (context) => context.route("**/assets/ThemeGallery-*.js", (route) => route.abort()),
    }, async (page) => {
      await goAppearance(page);
      await page.getByTestId("theme-style-row-failed").waitFor({ timeout: 15_000 });
      await page.getByTestId("theme-style-row-failed").scrollIntoViewIfNeeded();
      await shoot(page, `state-failed-${viewport.name}`, { viewport: viewport.name, facts: await settingsFacts(page) });
    });

    // 3. 거절된 강조색 칩: catppuccin-frappe(다크 단독) × 홍염은 위험색과 겹친다. 비활성 + 이유 한 줄.
    await run(viewport, { osScheme: "dark", record: seedRecord({ theme: "catalog:catppuccin-frappe", scheme: "dark" }) }, async (page) => {
      await goAppearance(page);
      await page.getByTestId("accent-unavailable").waitFor({ timeout: 15_000 });
      await page.getByTestId("accent-choice").scrollIntoViewIfNeeded();
      await shoot(page, `state-chips-rejected-${viewport.name}`, { viewport: viewport.name, facts: await settingsFacts(page) });
    });

    // 4. 색 모드를 바꿔 테마가 옮겨졌다: 규칙 2(짝 없는 테마에서 시스템으로)와 규칙 3(다크 단독에서 라이트로).
    for (const [rule, choice] of [["rule2", "system"], ["rule3", "light"]]) {
      await run(viewport, { osScheme: "dark", record: seedRecord({ theme: "catalog:nord", scheme: "dark" }) }, async (page) => {
        await goAppearance(page);
        await page.getByTestId(`theme-choice-${choice}`).click({ force: true });
        await page.getByTestId("theme-mode-notice").waitFor({ timeout: 15_000 });
        await page.waitForTimeout(400);
        await page.getByTestId("theme-choice").scrollIntoViewIfNeeded();
        await shoot(page, `state-notice-${rule}-${viewport.name}`, { viewport: viewport.name, choice, facts: await settingsFacts(page) });
      });
    }

    // 5. 타일을 눌러 고르면 전 화면이 바뀐다(설정 화면 자신이 그 테마가 된다). 다크 탭에서 Nord.
    await run(viewport, { osScheme: "dark", record: seedRecord({ theme: "dawnsky", scheme: "dark" }) }, async (page) => {
      await goAppearance(page);
      await page.getByTestId("theme-style-trigger").click();
      await page.getByTestId("theme-style-options").waitFor();
      await page.getByTestId("theme-tile-catalog-nord").click();
      await page.waitForTimeout(400);
      await page.getByTestId("theme-style-options").scrollIntoViewIfNeeded();
      await shoot(page, `state-pick-nord-${viewport.name}`, { viewport: viewport.name, facts: await settingsFacts(page) });
    });

    // 6. 타일의 키보드 초점: 트리거에서 Tab으로 첫 타일로(초점 고리가 보이는지).
    await run(viewport, { osScheme: "light", record: seedRecord({ theme: "catalog:github", scheme: "light" }) }, async (page) => {
      await goAppearance(page);
      await page.getByTestId("theme-style-trigger").click();
      await page.getByTestId("theme-style-options").waitFor();
      await page.getByTestId("theme-style-trigger").focus();
      await page.keyboard.press("Tab");
      await page.waitForTimeout(200);
      await page.getByTestId("theme-style-options").scrollIntoViewIfNeeded();
      await shoot(page, `state-focus-tile-${viewport.name}`, { viewport: viewport.name, facts: await settingsFacts(page) });
    });

    // 7. 트리거의 키보드 초점(색 모드 라이트 라디오에서 Tab 한 번)과 강조색 칩의 키보드 초점.
    await run(viewport, { osScheme: "light", record: seedRecord({ theme: "catalog:github", scheme: "light" }) }, async (page) => {
      await goAppearance(page);
      await page.getByTestId("theme-choice-light").focus();
      await page.keyboard.press("Tab");
      await page.waitForTimeout(150);
      await page.getByTestId("theme-style-trigger").scrollIntoViewIfNeeded();
      await shoot(page, `state-focus-trigger-${viewport.name}`, { viewport: viewport.name, facts: await settingsFacts(page) });
      await page.keyboard.press("Tab");
      await page.waitForTimeout(150);
      await page.getByTestId("accent-choice").scrollIntoViewIfNeeded();
      await shoot(page, `state-focus-chip-${viewport.name}`, { viewport: viewport.name, facts: await settingsFacts(page) });
    });

    // 8. 늦은 알파벳 테마(vitesse, 다크)를 고른 채 펼친다: 고른 타일이 보이는 자리로 스크롤돼 있다(43장 가운데 어디든).
    await run(viewport, { osScheme: "dark", record: seedRecord({ theme: "catalog:vitesse", scheme: "dark" }) }, async (page) => {
      await goAppearance(page);
      await page.getByTestId("theme-style-trigger").click();
      await page.getByTestId("theme-style-options").waitFor();
      await page.waitForTimeout(300);
      const inView = await page.evaluate(() => {
        const tile = document.querySelector(".theme-tile[data-selected]");
        if (!tile) return null;
        const box = tile.getBoundingClientRect();
        return { top: Math.round(box.top), bottom: Math.round(box.bottom), viewport: innerHeight };
      });
      await shoot(page, `state-open-selected-late-${viewport.name}`, { viewport: viewport.name, inView, facts: await settingsFacts(page) });
    });

    // 9. 마우스: 가리킨 타일과 누르고 있는 타일(눌림은 .press의 scale).
    if (viewport.name === "1440") {
      await run(viewport, { osScheme: "light", record: seedRecord({ theme: "catalog:github", scheme: "light" }) }, async (page) => {
        await goAppearance(page);
        await page.getByTestId("theme-style-trigger").click();
        await page.getByTestId("theme-style-options").waitFor();
        await page.getByTestId("theme-style-options").scrollIntoViewIfNeeded();
        const target = page.getByTestId("theme-tile-catalog-everforest");
        await target.scrollIntoViewIfNeeded();
        await target.hover();
        await page.waitForTimeout(250);
        await shoot(page, `state-hover-tile-${viewport.name}`, { viewport: viewport.name, facts: await settingsFacts(page) });
        await page.mouse.down();
        await page.waitForTimeout(250);
        await shoot(page, `state-pressed-tile-${viewport.name}`, { viewport: viewport.name, facts: await settingsFacts(page) });
        await page.mouse.up();
      });
    }
  }
}

// ---- 설계 리뷰 1차가 요청한 장면 --------------------------------------------------------
const REVIEW_REPS = [
  { ref: "catalog:vscode-plus", name: "vscode-plus", modes: ["light", "dark"] },
  { ref: "catalog:min", name: "min", modes: ["light", "dark"] },
  { ref: "catalog:synthwave-84", name: "synthwave-84", modes: ["dark"] },
  { ref: "catalog:kanagawa", name: "kanagawa", modes: ["light", "dark"] },
  // 2차 리뷰의 위계(ink↔ink-muted) 지적 행: 타임스탬프·구역 이름이 본문과 갈리는지.
  { ref: "catalog:houston", name: "houston", modes: ["dark"] },
  { ref: "catalog:one", name: "one", modes: ["dark"] },
  { ref: "catalog:material", name: "material", modes: ["light"] },
  { ref: "catalog:solarized", name: "solarized", modes: ["light", "dark"] },
  { ref: "catalog:vesper", name: "vesper", modes: ["dark"] },
  { ref: "catalog:poimandres", name: "poimandres", modes: ["dark"] },
];

async function reviewScenes(browser, origin) {
  for (const rep of REVIEW_REPS) {
    for (const mode of rep.modes) {
      for (const viewport of VIEWPORTS) {
        const { context, page } = await openWith(browser, origin, { osScheme: mode, viewport, record: seedRecord({ theme: rep.ref, scheme: mode }), unread: true });
        try {
          await goChat(page);
          // 가리킨 행(정하윤): 호버 막대 위의 글자. 사이드바에는 안 읽음 배지와 멘션이 선다.
          await page.getByText("디자인 시안은 내일 오전에 공유해요").first().hover();
          await page.waitForTimeout(250);
          await shoot(page, `review-${rep.name}-${mode}-${viewport.name}`, { theme: rep.ref, mode, viewport: viewport.name });
        } finally {
          await context.close();
        }
      }
    }
  }
  // 강조색을 고른 카탈로그 앱 화면: frappe 다크에서 홍염은 거절이라 화면은 그 테마의 기본 신호로 서고, 설정 화면이 이유를 말한다.
  for (const viewport of VIEWPORTS) {
    const record = seedRecord({ theme: "catalog:catppuccin-frappe", scheme: "dark", signal: { preset: "hongyeom" } });
    const { context, page } = await openWith(browser, origin, { osScheme: "dark", viewport, record, unread: true });
    try {
      await goChat(page);
      await shoot(page, `review-frappe-hongyeom-app-${viewport.name}`, { theme: "catalog:catppuccin-frappe", mode: "dark", viewport: viewport.name });
      await goAppearance(page);
      await page.getByTestId("accent-unavailable").waitFor({ timeout: 15_000 });
      await page.getByTestId("accent-choice").scrollIntoViewIfNeeded();
      await shoot(page, `review-frappe-hongyeom-settings-${viewport.name}`, { viewport: viewport.name });
    } finally {
      await context.close();
    }
  }
  // 성운(거절되지 않는 조합)을 고른 카탈로그 앱 화면.
  for (const viewport of VIEWPORTS) {
    const record = seedRecord({ theme: "catalog:github", scheme: "light", signal: { preset: "hyeseong" } });
    const { context, page } = await openWith(browser, origin, { osScheme: "light", viewport, record, unread: true });
    try {
      await goChat(page);
      await shoot(page, `review-github-hyeseong-app-${viewport.name}`, { theme: "catalog:github", mode: "light", viewport: viewport.name });
    } finally {
      await context.close();
    }
  }
}

// 디자인 갤러리(`#/design`): 칩 그릇·상태 행·표면이 한 쪽에 있다. 세션 없이 열린다.
// 구역마다 따로 찍는다(요소 사진): 쪽 전체 사진은 `content-visibility: auto` 구역이 화면에 들어오기 전에는 그려지지 않아서 첫 약
// 900px만 찍히고 칩 그릇·상태 구역은 빈 종이였다(설계 리뷰 3차 M-6). 요소 사진은 그 구역을 화면으로 가져온 뒤 찍는다.
const DESIGN_SECTIONS = [
  // [제목, 파일 꼬리, 구역 안에 실제로 그려졌다는 증거가 되는 글자]. 「칩 그릇」은 제목과 알약 한 줄뿐이라 작다(약 104px).
  ["칩 그릇", "chips", "원장"],
  ["States", "states", "seq 4082"],
];
async function designScenes(browser, origin) {
  const reps = [
    ...REVIEW_REPS,
    { ref: "catalog:github", name: "github", modes: ["light", "dark"] },
    { ref: "catalog:solarized", name: "solarized", modes: ["light", "dark"] },
    { ref: "catalog:catppuccin", name: "catppuccin", modes: ["dark"] },
    { ref: "catalog:everforest", name: "everforest", modes: ["dark"] },
    { ref: "catalog:nord", name: "nord", modes: ["dark"] },
    { ref: "catalog:gruvbox-hard", name: "gruvbox-hard", modes: ["light", "dark"] },
    { ref: "dawnsky", name: "dawnsky", modes: ["light", "dark"] },
    { ref: "graphite", name: "graphite", modes: ["light", "dark"] },
  ];
  for (const rep of reps) {
    for (const mode of rep.modes) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: mode, reducedMotion: "reduce", deviceScaleFactor: 1, locale: "ko-KR", timezoneId: "Asia/Seoul" });
      await context.addInitScript(([key, value]) => {
        try { localStorage.setItem(key, value); } catch { /* 저장소 없는 캡처 */ }
      }, [APPEARANCE_ENTRY, seedRecord({ theme: rep.ref, scheme: mode })]);
      const page = await context.newPage();
      try {
        await page.goto(`${origin}/#/design`, { waitUntil: "domcontentloaded" });
        await page.getByText("칩 그릇").first().waitFor({ timeout: 20_000 });
        await settle(page);
        for (const [title, slug, probe] of DESIGN_SECTIONS) {
          const section = page.getByRole("heading", { name: title, exact: true }).first().locator("xpath=ancestor::section[1]");
          await section.scrollIntoViewIfNeeded();
          // 늦게 그려지는 구역(`content-visibility: auto`)이 실제로 그려졌는지는 그 안의 글자로 본다(높이만으로는 대기 자리와 구분이 안 된다).
          await section.getByText(probe).first().waitFor({ timeout: 10_000 });
          await settle(page);
          const box = await section.boundingBox();
          if (!box || box.height < 60) throw new Error(`design ${rep.name} ${mode} ${title}: 구역이 그려지지 않았다(높이 ${box?.height ?? 0})`);
          const name = `design-${rep.name}-${mode}-${slug}`;
          await section.screenshot({ path: resolve(outDir(), `${name}.png`), animations: "disabled", caret: "hide" });
          meta.push({ name, theme: rep.ref, mode, section: title, height: Math.round(box.height), root: await facts(page) });
        }
      } finally {
        await context.close();
      }
    }
  }
}

const EXTRA_AUTOCOMPLETE = [
  { ref: "catalog:vesper", name: "vesper", mode: "dark" },
  { ref: "catalog:poimandres", name: "poimandres", mode: "dark" },
  { ref: "catalog:ayu-dark", name: "ayu-dark", mode: "dark" },
  { ref: "catalog:material-theme-ocean", name: "material-theme-ocean", mode: "dark" },
  { ref: "catalog:kanagawa", name: "kanagawa", mode: "light" },
  { ref: "catalog:catppuccin", name: "catppuccin", mode: "light" },
  { ref: "dawnsky", name: "dawnsky", mode: "dark" },
];

async function extraScenes(browser, origin) {
  // 1. 컴포저에 `@`를 치면 뜨는 자동완성의 강조된 줄(`bg-accent-soft`): 보조 글자가 그 채움 위에서 읽히는가.
  for (const rep of EXTRA_AUTOCOMPLETE) {
    const viewport = VIEWPORTS[0];
    const { context, page } = await openWith(browser, origin, { osScheme: rep.mode, viewport, record: seedRecord({ theme: rep.ref, scheme: rep.mode }) });
    try {
      await goChat(page);
      await page.locator("#composer-input").click();
      await page.keyboard.type("@");
      await page.getByRole("listbox").first().waitFor({ timeout: 10_000 });
      await page.waitForTimeout(300);
      await shoot(page, `extra-mention-${rep.name}-${rep.mode}-1440`, { theme: rep.ref, mode: rep.mode });
    } finally {
      await context.close();
    }
  }
  // 2. 640~760px 폭의 갤러리(격자 안쪽 스크롤이 서는 첫 폭).
  for (const width of [640, 700, 760]) {
    const viewport = { name: String(width), width, height: 900 };
    const { context, page } = await openWith(browser, origin, { osScheme: "dark", viewport, record: seedRecord({ theme: "catalog:github", scheme: "dark" }) });
    try {
      await goAppearance(page);
      await page.getByTestId("theme-style-trigger").click();
      await page.getByTestId("theme-style-options").waitFor();
      await page.waitForTimeout(300);
      await page.getByTestId("theme-style-options").scrollIntoViewIfNeeded();
      const columns = await page.evaluate(() => getComputedStyle(document.querySelector(".theme-gallery-grid")).gridTemplateColumns.split(" ").length);
      await shoot(page, `extra-width-open-${width}`, { width, columns });
    } finally {
      await context.close();
    }
  }
  // 3. 390 다크 탭에서 격자 안쪽을 중간까지 스크롤한 장면과, 끝에서 한 번 더 밀면 페이지가 이어서 스크롤하는지(체이닝).
  {
    const viewport = VIEWPORTS[1];
    const { context, page } = await openWith(browser, origin, { osScheme: "dark", viewport, record: seedRecord({ theme: "dawnsky", scheme: "dark" }) });
    try {
      await goAppearance(page);
      await page.getByTestId("theme-style-trigger").click();
      await page.getByTestId("theme-style-options").waitFor();
      await page.getByTestId("theme-style-options").scrollIntoViewIfNeeded();
      const scroller = page.locator(".theme-gallery-scroll");
      const metrics = await scroller.evaluate((el) => ({ client: el.clientHeight, scroll: el.scrollHeight }));
      await scroller.evaluate((el) => { el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) / 2); });
      await page.waitForTimeout(200);
      await shoot(page, "extra-gallery-scroll-middle-390", { viewport: "390", metrics });
      // 체이닝: 격자를 끝까지 내린 뒤 같은 자리에서 휠을 더 굴리면 **바깥** 스크롤 영역(앱의 본문 스크롤러)이 움직인다.
      // 앱 루트는 창 스크롤이 아니라 안쪽 영역이 스크롤하므로, 격자의 가장 가까운 스크롤 가능 조상을 찾아 잰다.
      const scrollTopOfOuter = () =>
        page.evaluate(() => {
          let node = document.querySelector(".theme-gallery-scroll")?.parentElement ?? null;
          while (node) {
            const overflowY = getComputedStyle(node).overflowY;
            if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight + 1) return { tag: node.tagName.toLowerCase(), cls: node.className.slice(0, 60), top: node.scrollTop };
            node = node.parentElement;
          }
          return { tag: "window", cls: "", top: window.scrollY };
        });
      await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; });
      const before = await scrollTopOfOuter();
      const box = await scroller.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, 400);
      await page.waitForTimeout(400);
      await page.mouse.wheel(0, 400);
      await page.waitForTimeout(400);
      const after = await scrollTopOfOuter();
      meta.push({ name: "extra-gallery-chaining-390", outer: before.tag + "." + before.cls, chained: after.top > before.top, before: before.top, after: after.top });
    } finally {
      await context.close();
    }
  }
}

// 접힌 행의 이름과 타일: 모든 타일을 차례로 골라 가며, 고를 때마다 (1) 접힌 행의 이름이 한 줄이고 잘리지 않고 넘치지 않는지 (2) 배치가
// 이름마다 갈리지 않는지 (3) **고른 타일의 이름**이 잘리지 않는지 (4) 열린 격자가 선택 때문에 움직이지 않는지 잰다. 글자 크기는 기본과
// 「크게」 둘이다(크게에서는 이름이 타일보다 길어진다). 배치는 `row`(이름 · 썸네일 · chevron이 한 줄) 아니면 `stacked`(이름이 윗줄, 썸네일과
// chevron이 아랫줄)이고, chevron은 늘 썸네일 옆이다. 3·4는 설계 리뷰 4차 B-1: 타일 이름을 고르기 전에 한 번만 재서, 고른 순간에만 굵어진 이름이
// 잘리는 것을 못 잡았다.
const NAME_WIDTHS = (process.env.NAME_WIDTHS ?? "390,375,360,320,640,700,760").split(",").map(Number);
const NAME_WIDTHS_LARGER = (process.env.NAME_WIDTHS_LARGER ?? "390,375,360,640,700").split(",").map(Number);
const NAME_SHOT_WIDTHS = new Set([390, 375, 360, 640]);
const NAME_OPEN_SHOT_WIDTHS = new Set([375, 360]);
async function nameScenes(browser, origin) {
  const bad = [];
  const report = [];
  const tileReport = [];
  const runs = [
    ["default", NAME_WIDTHS],
    ["larger", NAME_WIDTHS_LARGER],
  ];
  for (const [fontSize, widths] of runs) {
    for (const width of widths) {
      const viewport = { name: String(width), width, height: 844 };
      for (const mode of ["system", "light", "dark"]) {
        const osScheme = mode === "dark" ? "dark" : "light";
        const record = seedRecord({ theme: "dawnsky", scheme: mode, ...(fontSize === "default" ? {} : { fontSize }) });
        const { context, page } = await openWith(browser, origin, { osScheme, viewport, record });
        const rows = [];
        const where = { width, mode, fontSize };
        try {
          await goAppearance(page);
          await page.getByTestId("theme-style-trigger").click();
          await page.getByTestId("theme-style-options").waitFor();
          // 타일 이름과 열 수(설계 리뷰 3차 M-2): 360 이상에서는 두 열이고, 이름은 잘리지 않고 두 줄 안에서 접힌다.
          const tileMeasure = await page.evaluate(() => {
            const names = [...document.querySelectorAll(".theme-tile-name")];
            const grid = document.querySelector(".theme-gallery-grid");
            return {
              cols: getComputedStyle(grid).gridTemplateColumns.split(" ").length,
              count: names.length,
              clipped: names.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent),
              maxLines: Math.max(...names.map((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)))),
              tileWidth: Math.round(grid.querySelector(".theme-tile").getBoundingClientRect().width),
            };
          });
          tileReport.push({ ...where, ...tileMeasure });
          if (tileMeasure.clipped.length > 0 || tileMeasure.maxLines > 2 || (width >= 360 && tileMeasure.cols < 2)) {
            bad.push({ ...where, ref: "*", label: `(타일: 열 ${tileMeasure.cols}, 최대 ${tileMeasure.maxLines}줄, 잘린 이름 ${tileMeasure.clipped.join("·") || "없음"})`, lines: tileMeasure.maxLines, truncated: tileMeasure.clipped.length > 0, triggerOverflow: false, layout: "tile", chevronBeside: true });
          }
          const refs = await page.locator(".theme-tile input").evaluateAll((nodes) => nodes.map((n) => n.value));
          for (const ref of refs) {
            const label = await page.evaluate((value) => document.querySelector(`.theme-tile input[value="${value}"]`)?.closest("label")?.querySelector(".theme-tile-name")?.textContent ?? "", ref);
            await page.locator(`.theme-tile input[value="${ref}"]`).evaluate((node) => node.closest("label").click());
            await page.waitForFunction(
              (text) => document.querySelector('[data-testid="theme-style-selected-name"]')?.textContent === text,
              label,
              { timeout: 5000 }
            );
            const m = await page.evaluate(() => {
              const name = document.querySelector('[data-testid="theme-style-selected-name"]');
              const trigger = document.querySelector('[data-testid="theme-style-trigger"]');
              const tail = trigger.querySelector(".theme-style-trigger-tail");
              const chevron = tail.querySelector("svg");
              const thumb = document.querySelector('[data-testid="theme-style-selected-preview"]');
              const style = getComputedStyle(name);
              const lineHeight = parseFloat(style.lineHeight);
              const rect = name.getBoundingClientRect();
              const tailBox = tail.getBoundingClientRect();
              const chevronBox = chevron.getBoundingClientRect();
              const thumbBox = thumb.getBoundingClientRect();
              // 고른 타일의 이름(고른 순간에 굵기·색이 바뀌는 자리): 잘리지 않고 두 줄 안이다.
              const tileName = document.querySelector(".theme-tile[data-selected] .theme-tile-name");
              const region = document.querySelector('[data-testid="theme-style-options"]');
              return {
                lines: Math.round(rect.height / lineHeight),
                truncated: name.scrollWidth > name.clientWidth + 1,
                triggerOverflow: trigger.scrollWidth > trigger.clientWidth + 1,
                pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
                nameWidth: Math.round(rect.width),
                triggerWidth: Math.round(trigger.getBoundingClientRect().width),
                triggerHeight: Math.round(trigger.getBoundingClientRect().height),
                layout: tailBox.top >= rect.bottom - 1 ? "stacked" : "row",
                // chevron은 썸네일 옆(위아래로 썸네일 범위 안)에 선다: 홀로 아랫줄에 떨어지지 않는다.
                chevronBeside: chevronBox.top >= thumbBox.top - 1 && chevronBox.bottom <= thumbBox.bottom + 1 && chevronBox.left >= thumbBox.right - 1,
                tileNameClipped: tileName.scrollWidth > tileName.clientWidth + 1,
                tileNameLines: Math.round(tileName.getBoundingClientRect().height / parseFloat(getComputedStyle(tileName).lineHeight)),
                regionHeight: Math.round(region.getBoundingClientRect().height),
              };
            });
            const row = { ...where, ref, label, ...m };
            report.push(row);
            rows.push(row);
            if (m.lines !== 1 || m.truncated || m.triggerOverflow || m.pageOverflow || !m.chevronBeside || m.tileNameClipped || m.tileNameLines > 2) bad.push(row);
          }
          // 이름마다 배치·높이가 갈리거나 열린 격자가 선택 때문에 움직이면 선택할 때 화면이 뛴다(설계 리뷰 3차 M-1 · 4차 B-1).
          const layouts = [...new Set(rows.map((r) => r.layout))];
          const heights = rows.map((r) => r.triggerHeight);
          const regionHeights = rows.map((r) => r.regionHeight);
          if (layouts.length > 1 || Math.max(...heights) - Math.min(...heights) > 1) {
            bad.push({ ...where, ref: "*", label: `(배치가 이름마다 갈린다: ${layouts.join("/")}, 높이 ${Math.min(...heights)}~${Math.max(...heights)})`, lines: 1, truncated: false, triggerOverflow: false, layout: layouts.join("/"), chevronBeside: true });
          }
          if (Math.max(...regionHeights) - Math.min(...regionHeights) > 1) {
            bad.push({ ...where, ref: "*", label: `(열린 갤러리의 높이가 선택에 따라 움직인다: ${Math.min(...regionHeights)}~${Math.max(...regionHeights)})`, lines: 1, truncated: false, triggerOverflow: false, layout: "region", chevronBeside: true });
          }
          // 가장 긴 이름 하나를 사진으로 남긴다: 접힌 행(이름·썸네일)과, 폰 폭에서는 열린 갤러리에서 그 타일이 고른 모양.
          const longest = rows.slice().sort((a, b) => b.label.length - a.label.length)[0];
          const suffix = fontSize === "default" ? "" : `-${fontSize}`;
          const shotNeeded = fontSize === "default" ? NAME_SHOT_WIDTHS.has(width) : NAME_OPEN_SHOT_WIDTHS.has(width);
          if (longest && shotNeeded) {
            await page.locator(`.theme-tile input[value="${longest.ref}"]`).evaluate((node) => node.closest("label").click());
            await page.getByTestId("theme-style-trigger").scrollIntoViewIfNeeded();
            await page.getByTestId("theme-style-row").scrollIntoViewIfNeeded();
            await shoot(page, `names-${mode}-${width}${suffix}`, { ...where, longest: longest.label });
          }
          if (longest && NAME_OPEN_SHOT_WIDTHS.has(width)) {
            await page.locator(".theme-tile[data-selected]").scrollIntoViewIfNeeded();
            await shoot(page, `names-open-${mode}-${width}${suffix}`, { ...where, longest: longest.label });
          }
        } finally {
          await context.close();
        }
      }
    }
  }
  writeFileSync(resolve(outDir(), "names.json"), JSON.stringify({ checked: report.length, bad, report, tiles: tileReport }, null, 1));
  console.log(`NAMES: ${report.length} measured, ${bad.length} violations`);
  if (bad.length > 0) {
    console.error(bad.slice(0, 12).map((r) => `${r.width}px ${r.mode} ${r.fontSize} ${r.label}: lines=${r.lines} truncated=${r.truncated} triggerOverflow=${r.triggerOverflow} layout=${r.layout} chevronBeside=${r.chevronBeside} tileNameClipped=${r.tileNameClipped ?? ""}`).join("\n"));
    process.exitCode = 1;
  }
}

// 설정 > 모양 900·1280(접힘·펼침).
async function widthScenes(browser, origin) {
  for (const width of [900, 1280]) {
    const viewport = { name: String(width), width, height: 900 };
    for (const mode of ["light", "dark"]) {
      const { context, page } = await openWith(browser, origin, { osScheme: mode, viewport, record: seedRecord({ theme: "catalog:github", scheme: mode }) });
      try {
        await goAppearance(page);
        await page.getByTestId("theme-style-trigger").scrollIntoViewIfNeeded();
        await shoot(page, `width-closed-${mode}-${viewport.name}`, { mode, viewport: viewport.name, open: false });
        await page.getByTestId("theme-style-trigger").click();
        await page.getByTestId("theme-style-options").waitFor();
        await page.waitForTimeout(300);
        await page.getByTestId("theme-style-options").scrollIntoViewIfNeeded();
        const columns = await page.evaluate(() => getComputedStyle(document.querySelector(".theme-gallery-grid")).gridTemplateColumns.split(" ").length);
        await shoot(page, `width-open-${mode}-${viewport.name}`, { mode, viewport: viewport.name, open: true, columns });
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
    if (SCENES.includes("states")) await stateScenes(browser, preview.origin);
    if (SCENES.includes("review")) await reviewScenes(browser, preview.origin);
    if (SCENES.includes("widths")) await widthScenes(browser, preview.origin);
    if (SCENES.includes("names")) await nameScenes(browser, preview.origin);
    if (SCENES.includes("extra")) await extraScenes(browser, preview.origin);
    if (SCENES.includes("design")) {
      // 디자인 갤러리는 `VITE_DESIGN_GALLERY=1`로 빌드한 dist가 따로 필요하다.
      const designDist = process.env.DIST_DESIGN ? resolve(WEB_ROOT, process.env.DIST_DESIGN) : null;
      if (!designDist || !existsSync(resolve(designDist, "index.html"))) throw new Error("design 장면은 DIST_DESIGN(VITE_DESIGN_GALLERY=1 빌드)이 필요하다.");
      const designPreview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT + 1, portEnvVar: "CAPTURE_PORT", extraArgs: ["--outDir", designDist] });
      try {
        await designScenes(browser, designPreview.origin);
      } finally {
        await designPreview.stop?.();
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
