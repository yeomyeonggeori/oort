#!/usr/bin/env node
// =============================================================================
// 보이는 변화 0의 증거 (AP-1a #4186, AC 4·5): 같은 화면을 변경 전·후 번들로 찍어 픽셀을 비교한다.
//
//   npm run build && cp -R dist artifacts/dist-before      (변경 전 HEAD에서)
//   ... 변경 ...
//   npm run build
//   LABEL=before DIST=artifacts/dist-before node scripts/capture-4186.mjs
//   LABEL=after  DIST=dist                  node scripts/capture-4186.mjs
//   MODE=diff BEFORE=artifacts/ap1a-4186/before AFTER=artifacts/ap1a-4186/after node scripts/capture-4186.mjs
//
// 화면: 새벽하늘·흑연·노을띠(띠가 있다) × 라이트·다크 × 1440·900·390 = 18장이 AC이고, 여기에
// 사이드바를 접은 1440 여섯 장(접힘의 background-size), 대비 높이기 두 장(prefers-contrast의
// 층 규칙), 설정 > 모양 한 쪽(설정 전면의 background-size) + 그 쪽의 DOM 문자열을 더한다.
//
// 거짓 0을 막는 장치 셋:
//   · 같은 번들을 두 번 찍어 서로 비교한다(`LABEL=before-b`): 찍을 때마다 흔들리는 화면이면 0이
//     아무것도 증명하지 못한다.
//   · 팔레트는 번들에 고르는 길이 없어 `data-palette`를 직접 바꾸고, 찍기 직전에 **읽어서**
//     맞는지 확인한다. 팔레트끼리 실제로 다른 화면인지도 비교한다.
//   · 바닥이 정말 층으로 칠해져 있는지(`app-shell`의 computed background-image) 기록한다.
//
// 백엔드 없이 `/v1/**` 고정 응답 + 가짜 소켓. 벽시계·로케일·시간대를 고정한다.
// =============================================================================
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = process.env.WEB_ROOT
  ? resolve(process.env.WEB_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODE = process.env.MODE || "capture";
const LABEL = process.env.LABEL || "after";
const DIST = process.env.DIST || "dist";
const OUT_ROOT = process.env.OUT_ROOT
  ? resolve(process.env.OUT_ROOT)
  : resolve(WEB_ROOT, "artifacts/ap1a-4186");
const PORT = Number(process.env.CAPTURE_PORT || 5386);

const FIXTURE_NOW = Date.parse("2026-10-21T09:30:00+09:00");
const PALETTES = ["dawnsky", "graphite", "noeul"];
const SCHEMES = ["light", "dark"];
const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "900", width: 900, height: 700 },
  { name: "390", width: 390, height: 844 },
];

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
  realtimeWebSocketUrl: "ws://ap1a-4186-capture.invalid/connection/websocket",
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
          if (c.connect) return { id: c.id, connect: { client: "4186-capture", version: "6" } };
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

async function openContext(browser, origin, scheme, viewport, extra = {}) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: scheme,
    reducedMotion: "reduce",
    serviceWorkers: "block",
    deviceScaleFactor: 2,
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    ...extra,
  });
  await installRoutes(context);
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

const settle = (page) =>
  page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  });

const outDir = () => resolve(OUT_ROOT, LABEL);
const meta = [];

async function setPalette(page, palette) {
  await page.evaluate((id) => document.documentElement.setAttribute("data-palette", id), palette);
  const read = await page.evaluate(() => document.documentElement.getAttribute("data-palette"));
  if (read !== palette) throw new Error(`data-palette 읽기값이 ${read}다(요청 ${palette}). 팔레트가 안 바뀐 채 찍으면 거짓 0이다.`);
}

async function shellFacts(page) {
  return page.evaluate(() => {
    const shell = document.querySelector(".app-shell");
    if (!shell) return null;
    const c = getComputedStyle(shell);
    return {
      backgroundImage: c.backgroundImage,
      backgroundSize: c.backgroundSize,
      backgroundPosition: c.backgroundPosition,
      backgroundColor: c.backgroundColor,
      collapsed: shell.hasAttribute("data-sidebar-collapsed"),
      settingsSurface: shell.hasAttribute("data-settings-surface"),
    };
  });
}

async function shoot(page, name, facts = {}) {
  await settle(page);
  const path = resolve(outDir(), `${name}.png`);
  await page.screenshot({ path, animations: "disabled", caret: "hide" });
  meta.push({ name, shell: await shellFacts(page), ...facts });
}

async function chatScenes(browser, origin, scheme, viewport) {
  const { context, page } = await openContext(browser, origin, scheme, viewport);
  try {
    await page.evaluate((id) => { location.hash = `/c/${id}`; }, CH);
    await page.getByText("이번 주 일정 정리해 줘").first().waitFor({ timeout: 15_000 });
    await page.waitForTimeout(700);
    for (const palette of PALETTES) {
      await setPalette(page, palette);
      await shoot(page, `${palette}-${scheme}-${viewport.name}`, { palette, scheme, viewport: viewport.name });
    }
    if (viewport.name === "1440") {
      // 사이드바를 접은 바닥(접힘의 background-size). 접힘 상태는 React가 쥔 속성이라 같은 속성을 직접 단다.
      await page.evaluate(() => document.querySelector(".app-shell")?.setAttribute("data-sidebar-collapsed", ""));
      for (const palette of PALETTES) {
        await setPalette(page, palette);
        await shoot(page, `collapsed-${palette}-${scheme}-1440`, { palette, scheme, viewport: "1440", collapsed: true });
      }
      await page.evaluate(() => document.querySelector(".app-shell")?.removeAttribute("data-sidebar-collapsed"));
      // 설정 > 모양: 설정 전면의 바닥과 페이지 DOM(AC 5).
      await setPalette(page, "dawnsky");
      await page.evaluate(() => { location.hash = "/settings?section=appearance"; });
      await page.waitForSelector('[data-testid="theme-choice"]', { timeout: 15_000 });
      await page.waitForTimeout(500);
      await shoot(page, `settings-appearance-${scheme}-1440`, { palette: "dawnsky", scheme, viewport: "1440", settings: true });
      const html = await page.evaluate(() => document.querySelector("main")?.innerHTML ?? "");
      writeFileSync(resolve(outDir(), `settings-appearance-${scheme}.html`), html);
    }
  } finally {
    await context.close();
  }
}

async function contrastScenes(browser, origin, scheme) {
  const viewport = VIEWPORTS[0];
  const { context, page } = await openContext(browser, origin, scheme, viewport, { contrast: "more" });
  try {
    await page.evaluate((id) => { location.hash = `/c/${id}`; }, CH);
    await page.getByText("이번 주 일정 정리해 줘").first().waitFor({ timeout: 15_000 });
    await page.waitForTimeout(700);
    const matches = await page.evaluate(() => matchMedia("(prefers-contrast: more)").matches);
    if (!matches) throw new Error("prefers-contrast: more 가 켜지지 않았다. 이 장면은 층 규칙을 재지 못한다.");
    await setPalette(page, "noeul");
    await shoot(page, `contrast-more-noeul-${scheme}-1440`, { palette: "noeul", scheme, viewport: "1440", contrast: "more" });
  } finally {
    await context.close();
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
      for (const viewport of VIEWPORTS) await chatScenes(browser, preview.origin, scheme, viewport);
      await contrastScenes(browser, preview.origin, scheme);
    }
  } finally {
    await browser.close();
    await preview.stop?.();
  }
  writeFileSync(resolve(outDir(), "meta.json"), JSON.stringify({ label: LABEL, dist: DIST, shots: meta }, null, 1));
  console.log(`CAPTURE ${LABEL}: ${meta.length} shots -> ${outDir()}`);
}

// ---- 비교: 브라우저의 캔버스로 두 PNG의 픽셀을 비교한다(의존성 없이) ---------------------
async function diff() {
  const beforeDir = resolve(process.env.BEFORE || resolve(OUT_ROOT, "before"));
  const afterDir = resolve(process.env.AFTER || resolve(OUT_ROOT, "after"));
  const names = readdirSync(beforeDir).filter((n) => n.endsWith(".png")).sort();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const rows = [];
  const compare = (a, b) =>
    page.evaluate(async ([x64, y64]) => {
      const load = async (b64) => {
        const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
        const bmp = await createImageBitmap(blob);
        const canvas = new OffscreenCanvas(bmp.width, bmp.height);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(bmp, 0, 0);
        return { w: bmp.width, h: bmp.height, data: ctx.getImageData(0, 0, bmp.width, bmp.height).data };
      };
      const [x, y] = await Promise.all([load(x64), load(y64)]);
      if (x.w !== y.w || x.h !== y.h) return { sizeMismatch: [x.w, x.h, y.w, y.h] };
      let differing = 0;
      let maxDelta = 0;
      const colors = new Set();
      for (let i = 0; i < x.data.length; i += 4) {
        let m = 0;
        for (let k = 0; k < 4; k++) {
          const v = Math.abs(x.data[i + k] - y.data[i + k]);
          if (v > m) m = v;
        }
        if (m > 0) { differing++; if (m > maxDelta) maxDelta = m; }
        if (i % (4 * 251) === 0) colors.add((x.data[i] << 16) | (x.data[i + 1] << 8) | x.data[i + 2]);
      }
      return { w: x.w, h: x.h, differing, maxDelta, sampledColors: colors.size };
    }, [readFileSync(a).toString("base64"), readFileSync(b).toString("base64")]);
  try {
    for (const name of names) {
      const after = join(afterDir, name);
      if (!existsSync(after)) { rows.push({ name, missing: true }); continue; }
      rows.push({ name, ...(await compare(join(beforeDir, name), after)) });
    }
    // 같은 장면의 팔레트끼리는 달라야 한다: 같으면 팔레트 전환이 화면에 닿지 않은 것이다.
    const sanity = [];
    for (const scheme of SCHEMES) {
      for (const vp of VIEWPORTS) {
        for (let i = 0; i < PALETTES.length; i++) {
          for (let j = i + 1; j < PALETTES.length; j++) {
            const a = join(beforeDir, `${PALETTES[i]}-${scheme}-${vp.name}.png`);
            const b = join(beforeDir, `${PALETTES[j]}-${scheme}-${vp.name}.png`);
            if (!existsSync(a) || !existsSync(b)) continue;
            const r = await compare(a, b);
            sanity.push({ pair: `${PALETTES[i]} vs ${PALETTES[j]} / ${scheme} / ${vp.name}`, differing: r.differing ?? -1 });
          }
        }
      }
    }
    const htmlRows = readdirSync(beforeDir)
      .filter((n) => n.endsWith(".html"))
      .map((n) => ({
        name: n,
        identical: existsSync(join(afterDir, n)) && readFileSync(join(beforeDir, n), "utf8") === readFileSync(join(afterDir, n), "utf8"),
        bytes: readFileSync(join(beforeDir, n), "utf8").length,
      }));
    const bad = rows.filter((r) => r.missing || r.sizeMismatch || r.differing !== 0);
    const flat = sanity.filter((s) => s.differing === 0);
    for (const r of rows) {
      console.log(`${r.differing === 0 ? "SAME" : "DIFF"}  ${r.name}  ${r.w ?? "?"}x${r.h ?? "?"}  differing=${r.differing ?? "n/a"}  maxDelta=${r.maxDelta ?? "n/a"}  colors~${r.sampledColors ?? "n/a"}`);
    }
    for (const h of htmlRows) console.log(`${h.identical ? "SAME" : "DIFF"}  ${h.name}  ${h.bytes} chars`);
    console.log(`팔레트 구별 점검: ${sanity.length}쌍 중 같은 화면 ${flat.length}쌍`);
    console.log(
      `RESULT ${bad.length === 0 && htmlRows.every((h) => h.identical) && flat.length === 0 ? "PASS" : "FAIL"}: ` +
        `${rows.length - bad.length}/${rows.length} 장 픽셀 동일, DOM ${htmlRows.filter((h) => h.identical).length}/${htmlRows.length} 동일`
    );
    if (bad.length || flat.length || htmlRows.some((h) => !h.identical)) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

(MODE === "diff" ? diff() : capture()).catch((error) => {
  console.error(error);
  process.exit(1);
});
