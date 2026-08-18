// =============================================================================
// GATE 3 — 1k-message timeline scroll profile (react-virtuoso) + web cold start.
//
// Runs headless Chromium (a headless page reports visibilityState "visible", so
// rAF and react-virtuoso's ResizeObserver run at full rate — unlike a
// backgrounded automation tab).
//
// ---- 2026-08-06 (#1089): 라이브 자격증명 요구를 걷어냈다 ---------------------
// 이 게이트는 `MOMO_EMAIL`/`MOMO_PASSWORD` 와 이미 떠 있는 preview 서버를 요구했다.
// 그래서 워커 레인에서 **실행 자체가 불가능**했고(자격증명은 세션 정책상 취급 금지),
// "안 돌린 게이트"가 "초록인 게이트"와 구별되지 않았다.
//
// 요구가 실은 필요 없었다는 것이 규명의 요지다: `?stress=N` 경로는
// `makeSyntheticMessages(N)` 로 **행을 클라이언트에서 만들고 네트워크를 타지 않는다**
// (src/features/chat/ChatShell.tsx:81 "renders synthetic rows, no network").
// 라이브 서버가 필요했던 것은 오직 로그인 왕복 하나였고, 그건 형제 게이트 14개가
// 이미 쓰는 Playwright 라우트 스텁으로 대체된다. 즉 이 게이트가 재던 것 — 1000행
// 가상화의 프레임 프로파일과 콜드 스타트 — 은 처음부터 서버와 무관했다.
//
// 그래서 이제 게이트는 자기 preview 서버를 띄우고 스텁 세션으로 로그인한다.
// 자격증명은 어디에도 필요 없다. 라이브 서버를 상대로 재고 싶으면
// `SCROLL_GATE_BASE` 로 외부 origin 을 주고 `MOMO_EMAIL`/`MOMO_PASSWORD` 를 함께
// 넣으면 옛 경로로 돈다 — 그 조합에서만 스텁이 비활성이다.
//
//   npm run build && npm run gate:scroll
// =============================================================================
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "./preview-guard.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.SCROLL_GATE_PORT || 5185);
const EXTERNAL_BASE = process.env.SCROLL_GATE_BASE || process.env.MOMO_WEB_BASE || "";
const BASE = EXTERNAL_BASE || `http://127.0.0.1:${PORT}`;
const email = process.env.MOMO_EMAIL;
const password = process.env.MOMO_PASSWORD;
// 스텁 모드가 기본이다. 외부 origin + 실자격증명이 **둘 다** 주어졌을 때만 라이브다.
const LIVE = Boolean(EXTERNAL_BASE && email && password);

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";
const ME = "019f94e3-7a10-79cd-9dee-208f47edd9a8";
const GENERAL_ID = "00000000-0000-7000-8000-000000000201";
const SESSION = {
  accessToken: "gate-only-not-a-credential",
  refreshToken: "gate-only-not-a-credential",
  member: {
    id: ME,
    workspaceId: WORKSPACE_ID,
    kind: "human",
    displayName: "곽성재",
    handle: "seongjae",
  },
  // ?stress= 경로는 실시간 소켓을 아예 열지 않는다(AppShell.tsx:144). 그래도
  // 모양은 채워 둔다 — 세션 파서가 읽는 필드다.
  realtimeWebSocketUrl: `ws://127.0.0.1:${PORT + 900}/connection/websocket`,
};
const CHANNELS = [
  { id: GENERAL_ID, workspaceId: WORKSPACE_ID, kind: "public", name: "general", muted: false },
];

function json(route, body) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installStubs(context) {
  // 포괄 스텁을 먼저 등록한다(Playwright 는 역순 매칭이므로 이것이 마지막에 걸린다).
  await context.route("**/v1/**", (route) =>
    json(route, {
      channels: [], members: [], read_states: [], messages: [],
      invites: [], approvals: [], runs: [],
    })
  );
  await context.route("**/v1/auth/login", (route) => json(route, SESSION));
  // 로그인 직후의 토큰 회전 (#1089). 포괄 스텁의 빈 모양을 받으면 코어
  // `refreshResponseFromWire` 가 throw → `markAuthExpired()` → 앱이 스스로
  // 로그아웃한다. 형제 게이트 셋이 같은 구멍으로 죽어 있었다.
  await context.route("**/v1/auth/refresh", (route) =>
    json(route, {
      accessToken: SESSION.accessToken,
      refreshToken: SESSION.refreshToken,
    })
  );
  await context.route("**/v1/auth/realtime-token", (route) =>
    json(route, {
      token: "gate-only-not-a-credential",
      tokenType: "jwt",
      expiresAtMs: Date.now() + 60_000,
      ttlSeconds: 60,
      workspaceId: WORKSPACE_ID,
      memberId: ME,
    })
  );
  await context.route("**/v1/workspaces/*/channels", (route) =>
    json(route, { channels: CHANNELS })
  );
}

let server = null;
if (!EXTERNAL_BASE) {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) {
    throw new Error("dist/ is missing. Run `npm run build` first.");
  }
  server = await startGuardedPreview({
    webRoot: WEB_ROOT,
    port: PORT,
    portEnvVar: "SCROLL_GATE_PORT",
  });
  process.on("exit", () => server?.child.kill("SIGTERM"));
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
if (!LIVE) await installStubs(context);
const page = await context.newPage();

// ---- cold start: fresh navigation timing to first rendered row -------------
const navStart = Date.now();
await page.goto(`${BASE}/?stress=1000`, { waitUntil: "domcontentloaded" });
await page.fill('[data-testid="login-email"]', LIVE ? email : "seongjae@dawn.example");
await page.fill(
  '[data-testid="login-password"]',
  LIVE ? password : "gate-only-not-a-credential"
);
await page.click('[data-testid="login-submit"]');
await page.waitForFunction(() => window.__spike?.count === 1000, null, {
  timeout: 15000,
});
await page.waitForSelector('[data-testid="timeline-message"]', {
  timeout: 15000,
});
const timeToFirstRowMs = Date.now() - navStart;

const paint = await page.evaluate(() => {
  const nav = performance.getEntriesByType("navigation")[0] || {};
  const fcp = performance.getEntriesByName("first-contentful-paint")[0];
  return {
    domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd || 0),
    loadEventMs: Math.round(nav.loadEventEnd || 0),
    firstContentfulPaintMs: fcp ? Math.round(fcp.startTime) : null,
  };
});

// ---- scroll profile: continuous rAF-timed scroll top→bottom ----------------
const scroll = await page.evaluate(async () => {
  const scroller = document.querySelector('[data-testid="timeline-virtuoso"]');
  const rowSel = '[data-testid="timeline-message"]';
  // let virtuoso measure item sizes so total height reflects 1000 rows
  scroller.scrollTop = scroller.scrollHeight;
  await new Promise((r) => setTimeout(r, 150));
  scroller.scrollTop = 0;
  await new Promise((r) => setTimeout(r, 150));

  const totalScroll = () => scroller.scrollHeight - scroller.clientHeight;
  const frames = [];
  let maxRows = 0;
  const durationMs = 3000;

  await new Promise((resolve) => {
    let last = performance.now();
    const start = last;
    function step(now) {
      frames.push(now - last);
      last = now;
      const n = document.querySelectorAll(rowSel).length;
      if (n > maxRows) maxRows = n;
      const t = (now - start) / durationMs;
      scroller.scrollTop = totalScroll() * Math.min(1, t);
      if (now - start < durationMs) requestAnimationFrame(step);
      else resolve();
    }
    requestAnimationFrame(step);
  });

  frames.shift(); // warmup frame
  const sorted = frames.slice().sort((a, b) => a - b);
  const pct = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const avg = frames.reduce((a, b) => a + b, 0) / frames.length;
  const rows = [...document.querySelectorAll(rowSel)].map((r) =>
    Number(r.getAttribute("data-seq"))
  );
  const mem = performance.memory
    ? Math.round(performance.memory.usedJSHeapSize / 1048576)
    : null;
  return {
    loaded: window.__spike?.count,
    scrollHeightPx: Math.round(scroller.scrollHeight),
    maxDomRowsDuringScroll: maxRows,
    bottomWindow: [rows[0], rows[rows.length - 1]],
    frames: frames.length,
    avgFrameMs: +avg.toFixed(2),
    fps: +(1000 / avg).toFixed(1),
    p50FrameMs: +pct(0.5).toFixed(2),
    p95FrameMs: +pct(0.95).toFixed(2),
    p99FrameMs: +pct(0.99).toFixed(2),
    maxFrameMs: +Math.max(...frames).toFixed(2),
    framesOver16_7ms: frames.filter((f) => f > 16.7).length,
    framesOver33ms: frames.filter((f) => f > 33).length,
    usedJSHeapMB: mem,
  };
});

console.log(
  JSON.stringify(
    {
      gate: "1k-scroll+coldstart",
      mode: LIVE ? "live" : "stub-session",
      base: BASE,
      coldStart: { timeToFirstRowMs, ...paint },
      scroll,
    },
    null,
    2
  )
);
await browser.close();
await server?.stop();
// 1000행이 실제로 마운트된 판에서만 프레임 수치가 의미를 갖는다. 가상화가
// 무너져 행이 안 들어왔는데 "빠르다"고 통과하는 초록을 막는다.
const virtualized =
  scroll.loaded === 1000 && scroll.maxDomRowsDuringScroll > 0 && scroll.maxDomRowsDuringScroll < 200;
const smooth = scroll.fps >= 55 && scroll.framesOver33ms <= 2;
if (!virtualized) {
  console.error(
    `FAIL virtualization: loaded=${scroll.loaded} maxDomRows=${scroll.maxDomRowsDuringScroll}`
  );
}
if (!smooth) {
  console.error(
    `FAIL frame profile: fps=${scroll.fps} framesOver33ms=${scroll.framesOver33ms}`
  );
}
process.exit(virtualized && smooth ? 0 : 1);
