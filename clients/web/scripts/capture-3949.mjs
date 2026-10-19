#!/usr/bin/env node
// =============================================================================
// 앱 화면 v2 캡처 (#3949 U-S1, ADR-0113 증보 2 E1·E2·E4): AI 허브 › 외부 연결 › 앱.
//
//   npm run build && FIXTURE_DIR=<server/Fixtures 폴더> OUT_DIR=<폴더> node scripts/capture-3949.mjs
//
// 백엔드는 없다. `/v1/**`는 고정 응답이다. 앱 일곱(GitHub·Notion·Linear·Gmail·Google Calendar·Google 내 드라이브·
// 팀 공유 드라이브)의 목록과 상세는 서버 시드 매니페스트(`plugin-manifests/*.json`, #3944)에서 **그대로 지은다**:
// 지어낸 도구나 문구는 없다. 목록 응답은 매니페스트의 같은 필드(이름·설명·이송 주소)를 옮긴 것이다.
// `FIXTURE_DIR`을 주지 않으면 이 저장소의 `server/Fixtures`를 읽는다(시드 일곱이 들어온 뒤의 기본값).
//
// 세계 x 라이트·다크 x 1440·390:
//   main      소유자 시점. 설치 경로가 서 있는 서버. 목록 + 상세 다섯(팀 드라이브·Gmail·내 드라이브·Calendar·GitHub).
//   empty     앱이 하나도 없는 서버.   error  목록 요청이 실패.   loading  목록이 아직 오지 않음.
// 단언이 하나라도 실패하면 종료 코드 1이다. CAPTURE_ASSERT=0이면 사진만 찍는다.
// =============================================================================

import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(WEB_ROOT, "../..");
const FIXTURE_DIR = process.env.FIXTURE_DIR ? resolve(process.env.FIXTURE_DIR) : resolve(REPO_ROOT, "server/Fixtures");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/plugins-v2");
const PORT = Number(process.env.CAPTURE_PORT || 5249);
const ASSERT = process.env.CAPTURE_ASSERT !== "0";

const MANIFESTS = Object.fromEntries(
  readdirSync(resolve(FIXTURE_DIR, "plugin-manifests"))
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(resolve(FIXTURE_DIR, "plugin-manifests", name), "utf8")))
    .map((manifest) => [manifest.plugin.id, manifest])
);
const ID = {
  drive: "com.momo.plugins.drive",
  github: "com.momo.plugins.github",
  gmail: "com.momo.plugins.gmail",
  calendar: "com.momo.plugins.google-calendar",
  myDrive: "com.momo.plugins.google-drive",
  linear: "com.momo.plugins.linear",
  notion: "com.momo.plugins.notion",
};
// 서버는 id 순서로 준다(#3944 시험이 같은 순서를 못박는다).
const ORDER = Object.values(ID).sort();
for (const id of ORDER) if (!MANIFESTS[id]) throw new Error(`시드 매니페스트가 없어요: ${id} (FIXTURE_DIR=${FIXTURE_DIR})`);

function itemOf(manifest) {
  const id = manifest.plugin.id;
  const installed = id === ID.github || id === ID.notion;
  return {
    pluginId: id,
    name: manifest.plugin.name,
    version: manifest.plugin.version,
    description: manifest.plugin.description,
    official: true,
    recommended: id === ID.github,
    egressDomains: manifest.momo.egressDomains,
    recommendedFor: manifest.momo.recommendedFor,
    installed,
    enabled: installed,
  };
}
const CATALOG_ITEMS = ORDER.map((id) => itemOf(MANIFESTS[id]));

function catalogFor() {
  // 내가 허용한 도구: GitHub은 읽기 도구 전부(github:read), 나머지는 없다.
  const github = MANIFESTS[ID.github];
  const readTools = github.mcp.tools.filter((tool) => tool.risk === "read");
  return {
    plugins: CATALOG_ITEMS,
    toolPolicy: {
      plugins: [{
        pluginId: ID.github,
        mcp: { url: github.mcp.url, transport: github.mcp.transport },
        egressDomains: github.momo.egressDomains,
        tools: readTools.map((tool) => ({ name: tool.name, risk: tool.risk, approvalTier: github.momo.approvalTier[tool.name] })),
      }],
    },
  };
}

function detailFor(pluginId) {
  const item = CATALOG_ITEMS.find((plugin) => plugin.pluginId === pluginId);
  if (!item) return null;
  const rest = { ...item };
  delete rest.recommended;
  return { plugin: { ...rest, manifest: MANIFESTS[pluginId] } };
}

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const channels = [
  { id: "00000000-0000-7000-8000-000000000201", workspaceId, kind: "public", name: "general", muted: false },
];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: "ws://plugins-readonly-capture.invalid/connection/websocket",
};
const base = { workspaceId, status: "active", channelCount: 1, channelIds: channels.map((c) => c.id), capabilities: [], createdAtMs: 0, updatedAtMs: 0 };
async function installRealtime(page) {
  await page.addInitScript(() => {
    class CaptureSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      constructor(url) {
        this.url = String(url);
        this.readyState = 0;
        queueMicrotask(() => { this.readyState = 1; this.onopen?.(new Event("open")); });
      }
      send(data) {
        const replies = String(data).trim().split("\n").map((line) => {
          const c = JSON.parse(line);
          if (c.connect) return { id: c.id, connect: { client: "plugins-readonly-capture", version: "6" } };
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



const adminRow = { ...base, id: "00000000-0000-7000-8000-000000000102", kind: "human", displayName: "김관리", handle: "kim", role: "admin" };
const meRow = { ...base, id: memberId, kind: "human", displayName: "곽성재", handle: "seongjae", role: "owner" };

const WORLDS = {
  main: { catalog: () => catalogFor(), delayMs: 0 },
  empty: { catalog: () => ({ plugins: [], toolPolicy: { plugins: [] } }), delayMs: 0 },
  error: { catalog: null, delayMs: 0 },
  loading: { catalog: () => catalogFor(), delayMs: 60_000 },
};

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function installRoutes(context, world) {
  await context.route("**/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/v1/auth/login") return json(route, { ...auth, member: { ...auth.member } });
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId });
    }
    if (request.method() === "GET" && /\/plugins\/[^/]+\/(install|grants)$/.test(path)) {
      return json(route, { error: { code: "method_not_allowed", message: "method not allowed" } }, 405);
    }
    if (request.method() !== "GET" && /\/plugins\//.test(path)) {
      return json(route, { error: { code: "forbidden", message: "capture is read only" } }, 403);
    }
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) return json(route, { members: [meRow, adminRow] });
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/hosted-agent-connections")) return json(route, { connections: [] });
    if (path.endsWith("/webhooks")) return json(route, { installations: [] });
    if (path.endsWith("/event-subscriptions")) return json(route, { eventSubscriptions: [] });
    if (path.endsWith("/plugins")) {
      if (world.delayMs) await new Promise((done) => setTimeout(done, world.delayMs));
      if (!world.catalog) return json(route, { error: { code: "internal", message: "boom" } }, 500);
      return json(route, world.catalog());
    }
    const detail = path.match(/\/plugins\/([^/]+)$/);
    if (detail) {
      const body = detailFor(decodeURIComponent(detail[1]));
      return body ? json(route, body) : json(route, { error: { code: "not_found", message: "plugin not found" } }, 404);
    }
    if (path.endsWith("/provider/link")) return json(route, { schema: "momo.provider_link.v0", configured: false, source: "environment", mode: "local-mock", baseUrl: "http://mock", endpointLabel: "mock", bearerConfigured: false, availability: "mock", keyConfigured: false, diagnostics: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: [] });
    if (path.endsWith("/work-sessions/shared")) return json(route, { sessions: [], nextCursor: null });
    if (path.endsWith("/work-sessions")) return json(route, { workSessions: [] });
    if (path.endsWith(`/workspaces/${workspaceId}`)) {
      return json(route, { workspace: { id: workspaceId, name: "여명거리", slug: "team", updatedAtMs: 1, roleLabels: {}, welcomeAgentMemberId: null, welcomePrompt: "", subscriptionAgentsEnabled: true } });
    }
    if (path.includes("/messages")) return json(route, { messages: [] });
    return json(route, {});
  });
}

const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok && ASSERT) failures.push(name);
}
const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const textOf = async (page, testId) => ((await page.getByTestId(testId).first().textContent()) ?? "").replace(/\s+/g, " ").trim();
const count = (page, testId) => page.getByTestId(testId).count();
const buttonCount = (page, name) => page.getByRole("button", { name, exact: true }).count();

async function open(browser, origin, scheme, viewport, world, waitFor) {
  const context = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion: "reduce", serviceWorkers: "block" });
  await installRoutes(context, world);
  const page = await context.newPage();
  await installRealtime(page);
  await page.addInitScript((server) => { try { localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ } }, origin);
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("nav-ai").waitFor({ timeout: 20_000 });
  await page.goto(`${origin}/#/ai/external/apps`);
  await page.getByTestId(waitFor).waitFor({ timeout: 20_000 });
  await page.waitForTimeout(900);
  return { context, page };
}

async function selectPlugin(page, pluginId) {
  await page.getByTestId(`plugin-catalog-${pluginId}`).click();
  await page.getByTestId("plugin-detail").waitFor();
  await page.waitForTimeout(700);
  await page.getByTestId("plugin-detail").evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.waitForTimeout(250);
}

async function run(browser, origin, scheme, width) {
  const tag = `${scheme}-${width}`;
  const height = width >= 1000 ? 900 : 844;
  const shotIn = (page, name, options = {}) => page.screenshot({ path: resolve(OUT_DIR, `${name}-${tag}.png`), ...options });

  // ---- main: 목록과 상세들 ----
  {
    const { context, page } = await open(browser, origin, scheme, { width, height }, WORLDS.main, "plugin-list");
    try {
      check(`${tag} 목록: 앱 일곱 줄`, (await page.locator('[data-testid^="plugin-catalog-"]').count()) === 7);
      check(`${tag} 검색·보기 컨트롤이 서지 않는다(일곱은 한눈에 읽힌다)`, (await page.locator("#plugin-search").count()) === 0);
      check(`${tag} 가로 넘침 0 (목록)`, (await overflowX(page)) === 0);
      const tiles = await page.locator('[data-testid^="plugin-catalog-"] > span:first-child > span[aria-hidden="true"]').allTextContents();
      check(`${tag} 타일 글자 일곱이 서로 다르다`, new Set(tiles).size === 7, JSON.stringify(tiles));
      await shotIn(page, "list");
      await page.screenshot({ path: resolve(OUT_DIR, `list-full-${tag}.png`), fullPage: true });
      for (const id of [ID.gmail, ID.calendar, ID.myDrive]) {
        check(`${tag} 목록: ${id} 「미리보기」 칩`, (await textOf(page, `plugin-row-${id}-preview`)) === "미리보기");
      }
      for (const id of [ID.drive, ID.github, ID.linear, ID.notion]) {
        check(`${tag} 목록: ${id} 미리보기 칩 없음`, (await count(page, `plugin-row-${id}-preview`)) === 0);
      }
      check(`${tag} 목록: 내 드라이브 칩`, (await textOf(page, `plugin-row-${ID.myDrive}-route`)) === "내 드라이브 · 내 에이전트가 읽어요");
      check(`${tag} 목록: 팀 공유 드라이브는 칩을 숨기고 관리자 설정`, (await textOf(page, `plugin-row-${ID.drive}-route`)) === "관리자 설정이 필요해요" && !(await textOf(page, "plugin-list")).includes("팀 전체 · oort가 읽어요"));

      await selectPlugin(page, ID.drive);
      check(`${tag} 팀 드라이브 상세: 실행하는 곳 줄 없음(hosted)`, (await count(page, "plugin-run-places")) === 0);
      check(`${tag} 팀 드라이브 상세: 관리자 설정 칩`, (await textOf(page, "plugin-detail-route")) === "관리자 설정이 필요해요");
      check(`${tag} 팀 드라이브 상세: 설치 단추 대신 안내 한 줄`, (await buttonCount(page, "워크스페이스에 설치")) === 0 && (await textOf(page, "plugin-setup-note")) === "관리자가 서버 설정을 끝내면 설치할 수 있어요.");
      await shotIn(page, "detail-drive-team");

      await selectPlugin(page, ID.gmail);
      const gmail = await textOf(page, "plugin-detail");
      check(`${tag} Gmail 상세: 미리보기 칩과 안내`, (await textOf(page, "plugin-detail-preview")) === "미리보기" && gmail.includes("정식으로 내놓지 않은 앱"));
      check(`${tag} Gmail 상세: 실행하는 곳 셋`, (await page.getByTestId("plugin-run-place").count()) === 3);
      check(`${tag} Gmail 상세: 내 맥은 준비 중`, gmail.includes("내 맥에서 앱 쓰기는 준비 중이에요") && !gmail.includes("기기가 막아요"));
      const grades = await page.locator('[data-testid="plugin-tool-grade"]').evaluateAll((els) => els.map((el) => el.getAttribute("data-grade")));
      check(`${tag} Gmail 상세: 등급 R 6 · A 2 · B 5`, ["R", "A", "B"].map((g) => grades.filter((x) => x === g).length).join() === "6,2,5", JSON.stringify(grades));
      check(`${tag} Gmail 상세: 등급 설명은 한 번`, (await count(page, "plugin-grade-legend")) === 1);
      check(`${tag} 가로 넘침 0 (Gmail 상세)`, (await overflowX(page)) === 0);
      await shotIn(page, "detail-gmail");
      await page.getByTestId("plugin-tools").evaluate((el) => el.scrollIntoView({ block: "start" }));
      await page.waitForTimeout(200);
      await shotIn(page, "detail-gmail-tools");
      // 쓰기 등급(A·B) 칩이 서는 구간: 마지막 도구 줄이 보이게 내린다.
      await page.getByTestId("plugin-tools").locator("li").last().evaluate((el) => el.scrollIntoView({ block: "end" }));
      await page.waitForTimeout(200);
      await shotIn(page, "detail-gmail-tools-write");
      check(`${tag} 가로 넘침 0 (Gmail 쓰기 등급 구간)`, (await overflowX(page)) === 0);

      await selectPlugin(page, ID.myDrive);
      check(`${tag} 내 드라이브 상세: 칩 둘(미리보기 + 내 드라이브)`, (await textOf(page, "plugin-detail-preview")) === "미리보기" && (await textOf(page, "plugin-detail-route")) === "내 드라이브 · 내 에이전트가 읽어요");
      await shotIn(page, "detail-drive-mine");

      await selectPlugin(page, ID.calendar);
      await shotIn(page, "detail-calendar");

      await selectPlugin(page, ID.github);
      check(`${tag} GitHub 상세: 미리보기 칩 없음`, (await count(page, "plugin-detail-preview")) === 0);
      const ghGrades = await page.locator('[data-testid="plugin-tool-grade"]').evaluateAll((els) => els.map((el) => el.getAttribute("data-grade")));
      check(`${tag} GitHub 상세: R 26 · B 10 (A 없음)`, ["R", "A", "B"].map((g) => ghGrades.filter((x) => x === g).length).join() === "26,0,10", JSON.stringify(ghGrades.length));
      await shotIn(page, "detail-github");
      await page.getByTestId("plugin-tools").locator("li").last().evaluate((el) => el.scrollIntoView({ block: "end" }));
      await page.waitForTimeout(200);
      await shotIn(page, "detail-github-tools-write");
      check(`${tag} 가로 넘침 0 (GitHub 상세)`, (await overflowX(page)) === 0);
    } finally {
      await context.close();
    }
  }

  // ---- 상태: 빈·오류·로딩(1440 위주, 390은 가로 넘침만) ----
  for (const [name, waitFor] of [["empty", "plugins-empty"], ["error", "plugins-error"], ["loading", "plugin-marketplace-skeleton"]]) {
    const { context, page } = await open(browser, origin, scheme, { width, height }, WORLDS[name], waitFor);
    try {
      check(`${tag} ${name}: 가로 넘침 0`, (await overflowX(page)) === 0);
      await shotIn(page, `state-${name}`);
    } finally {
      await context.close();
    }
  }
}

async function offline(browser, origin, scheme, width) {
  const tag = `${scheme}-${width}`;
  const { context, page } = await open(browser, origin, scheme, { width, height: width >= 1000 ? 900 : 844 }, WORLDS.main, "plugin-list");
  try {
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    await page.waitForTimeout(600);
    check(`${tag} 오프라인: 가로 넘침 0`, (await overflowX(page)) === 0);
    await page.screenshot({ path: resolve(OUT_DIR, `state-offline-${tag}.png`) });
  } finally {
    await context.close();
  }
}

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) throw new Error("dist/ is missing. Run npm run build first.");
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  try {
    for (const scheme of ["light", "dark"]) {
      for (const width of [1440, 390]) await run(browser, preview.origin, scheme, width);
      for (const width of [1440, 390]) await offline(browser, preview.origin, scheme, width);
    }
  } finally {
    await browser.close();
    await preview.stop?.();
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length}개 단언 실패`);
    process.exit(1);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
