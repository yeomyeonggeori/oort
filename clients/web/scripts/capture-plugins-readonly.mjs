#!/usr/bin/env node
// =============================================================================
// 「앱」 화면 읽기 전용 캡처 (#3860, ADR-0113 증보 P-U1): AI 허브 › 외부 연결 › 앱.
//
//   npm run build && OUT_DIR=<폴더> node scripts/capture-plugins-readonly.mjs
//
// 백엔드는 없다. `/v1/**`는 고정 응답이고, 실시간 소켓은 곧바로 연결되는 흉내다.
// 앱 목록과 GitHub 상세는 **서버가 실제로 준 바이트**(`server/Fixtures/plugin-wire/*.json`,
// Rust 시험이 못박는다)를 그대로 쓰고, 나머지 세 앱의 상세는 같은 모양으로 시드
// 매니페스트(`server/Fixtures/plugin-manifests/*.json`)에서 만든다. 지어낸 응답은 없다.
//
// 쓰기 경로 탐지(PROBE): 화면은 설치 경로에 GET을 보내 서버가 그 경로를 싣는지 본다.
//   PROBE=absent   (기본) 설치·권한 경로가 라우터에 없다 → 404. 읽기 전용이다.
//   PROBE=present  경로가 있다 → 405. 설치·권한 버튼이 돌아오는 경계를 한 장 찍는다.
//   PROBE=unknown  서버가 아파서 모른다 → 503. 화면은 닫힌 채 같은 안내 한 줄을 말한다(모르면 닫는다).
// 세 값은 서버의 응답일 뿐이고, 화면은 어느 쪽이든 같은 번들이다.
//   MANY=1         공식 네 앱 뒤에 합성 앱 셋을 더해 일곱으로 만든다. 검색·보기가 돌아오는 분기와
//                  필터가 다 걸러 낸 빈 상태(「필터 지우기」)를 찍는다. 합성 앱은 길이만 재는 항목이다.
//
// 라이트·다크 × 1280 · 900. 목록(첫 화면), 상세(GitHub·Notion·Linear·Drive), 전체(키 큰 창).
// 거기에 네 가지 필수 상태(빈 · 로딩 · 오류 · 서버가 앱 목록을 싣지 않아 접힘)와 키보드로 지나가는
// 포커스 링 장면을 1280에서 더 찍는다.
// 단언이 하나라도 실패하면 종료 코드 1이다. CAPTURE_ASSERT=0이면 사진만 찍는다.
// =============================================================================

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(WEB_ROOT, "../..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/plugins-readonly");
const PORT = Number(process.env.CAPTURE_PORT || 5241);
const PROBE = process.env.PROBE === "present" ? "present" : process.env.PROBE === "unknown" ? "unknown" : "absent";
const MANY = process.env.MANY === "1";
const ASSERT = process.env.CAPTURE_ASSERT !== "0";

const wire = (name) => JSON.parse(readFileSync(resolve(REPO_ROOT, "server/Fixtures/plugin-wire", name), "utf8"));
const manifest = (name) => JSON.parse(readFileSync(resolve(REPO_ROOT, "server/Fixtures/plugin-manifests", name), "utf8"));
const CATALOG = wire("catalog.json");
const GITHUB_DETAIL = wire("detail-github.json");
const MANIFEST_BY_ID = {
  "com.momo.plugins.drive": manifest("drive.json"),
  "com.momo.plugins.linear": manifest("linear.json"),
  "com.momo.plugins.notion": manifest("notion.json"),
};
const ID = {
  drive: "com.momo.plugins.drive",
  github: "com.momo.plugins.github",
  linear: "com.momo.plugins.linear",
  notion: "com.momo.plugins.notion",
};

if (MANY) {
  // 길이만 재는 합성 항목: 상세가 없는 앱이라 고르지 않는다(첫 줄은 진짜 Drive가 선택된다).
  for (const [name, from] of [["Atlas", 0], ["Beacon", 1], ["Cobalt", 3]]) {
    CATALOG.plugins.push({
      ...CATALOG.plugins[from],
      pluginId: `com.example.${name.toLowerCase()}`,
      name,
      official: false,
      recommended: false,
      installed: false,
      enabled: false,
    });
  }
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
const roster = [{ ...base, id: memberId, kind: "human", displayName: "곽성재", handle: "seongjae", role: "owner" }];

/** 앱 목록 경로가 어떤 서버처럼 답하는가: ok · empty · error(503) · absent(404) · slow(2.5초 늦게). */
const scenario = { catalog: "ok" };

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

/** 서버가 준 카탈로그 항목에서 상세 와이어를 만든다(상세는 `recommended`를 싣지 않는다). */
function detailFor(pluginId) {
  if (pluginId === ID.github) return GITHUB_DETAIL;
  const item = CATALOG.plugins.find((plugin) => plugin.pluginId === pluginId);
  const seeded = MANIFEST_BY_ID[pluginId];
  if (!item || !seeded) return null;
  const rest = { ...item };
  delete rest.recommended;
  return { plugin: { ...rest, manifest: seeded } };
}

async function installRoutes(context) {
  await context.route("**/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId });
    }
    // 쓰기 경로 탐지: 설치·권한 경로에 GET. 있으면 405(다른 동사만 등록), 없으면 404.
    if (request.method() === "GET" && /\/plugins\/[^/]+\/(install|grants)$/.test(path)) {
      if (PROBE === "present") return json(route, { error: { code: "method_not_allowed", message: "method not allowed" } }, 405);
      if (PROBE === "unknown") return json(route, { error: { code: "unavailable", message: "unavailable" } }, 503);
      return json(route, { error: { code: "not_found", message: "not found" } }, 404);
    }
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/hosted-agent-connections")) return json(route, { connections: [] });
    if (path.endsWith("/webhooks")) return json(route, { installations: [] });
    if (path.endsWith("/event-subscriptions")) return json(route, { eventSubscriptions: [] });
    if (path.endsWith("/plugins")) {
      if (scenario.catalog === "empty") return json(route, { plugins: [], toolPolicy: { plugins: [] } });
      if (scenario.catalog === "error") return json(route, { error: { code: "unavailable", message: "unavailable" } }, 503);
      if (scenario.catalog === "absent") return json(route, { error: { code: "not_found", message: "not found" } }, 404);
      if (scenario.catalog === "slow") await new Promise((done) => setTimeout(done, 2500));
      return json(route, CATALOG);
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

const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok && ASSERT) failures.push(name);
}
const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const count = (page, testId) => page.getByTestId(testId).count();

async function open(browser, origin, scheme, viewport) {
  const context = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion: "reduce", serviceWorkers: "block" });
  await installRoutes(context);
  const page = await context.newPage();
  await installRealtime(page);
  await page.addInitScript((server) => { try { localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ } }, origin);
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("nav-ai").waitFor({ timeout: 20_000 });
  if ((await page.getByTestId("sidebar-toggle").getAttribute("aria-expanded")) === "false") {
    await page.getByTestId("sidebar-toggle").click();
    await page.waitForTimeout(400);
  }
  return { context, page };
}

async function selectPlugin(page, pluginId) {
  await page.getByTestId(`plugin-catalog-${pluginId}`).click();
  await page.getByTestId("plugin-detail").waitFor();
  // 상세 쿼리가 끝나고 탐지 응답이 자리를 잡을 때까지(버튼 또는 안내 줄이 선다).
  await page.waitForTimeout(700);
}

/** 상세 머리를 보이는 영역 맨 위로. 좁은 폭에서는 상세가 목록 아래에 서기 때문이다. */
async function revealDetail(page) {
  await page.getByTestId("plugin-detail").evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.waitForTimeout(250);
}

async function scenes(browser, origin, scheme, viewport) {
  const tag = `${viewport.width}-${scheme}`;
  const { context, page } = await open(browser, origin, scheme, { width: viewport.width, height: viewport.height });
  const shot = (name, options = {}) => page.screenshot({ path: resolve(OUT_DIR, `${name}-${tag}.png`), ...options });
  try {
    // 0) 들어가는 문: AI 허브 › 외부 연결 목차의 「앱」 줄(문구와 설치 개수 칩).
    await page.goto(`${origin}/#/ai/external`);
    await page.getByTestId("ai-external-row-apps").waitFor({ timeout: 20_000 });
    await page.waitForTimeout(700);
    await shot("index");
    const appsRow = (await page.getByTestId("ai-external-row-apps").textContent()) ?? "";
    check(`${tag} 목차: 「앱」 줄은 읽기만 되는 서버에서도 참이다(관리한다고 말하지 않는다)`, appsRow.includes("확인해요") && !appsRow.includes("관리"), appsRow);
    check(`${tag} 목차: 설치 개수 칩 (서버가 준 설치 2)`, ((await page.getByTestId("ai-external-chip-apps").textContent()) ?? "").trim() === "설치 2");

    await page.goto(`${origin}/#/ai/external/apps`);
    await page.getByTestId("plugin-list").waitFor({ timeout: 20_000 });
    await page.getByTestId("plugin-detail").waitFor();
    await page.waitForTimeout(900);

    // 1) 목록(첫 화면): 맨 위 그대로.
    await shot("list");

    const ids = await page.locator('[data-testid^="plugin-catalog-"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")?.replace("plugin-catalog-", "")));
    check(`${tag} 목록: 공식 앱 4개`, ids.length === 4, ids.join("|"));
    check(`${tag} 가로 넘침 0`, (await overflowX(page)) === 0);

    // 2) 상세: GitHub(설치됨, 내가 허용한 도구 있음), Notion(미설치), Linear(설치됐지만 꺼짐).
    for (const [name, pluginId] of [["github", ID.github], ["notion", ID.notion], ["linear", ID.linear], ["drive", ID.drive]]) {
      await selectPlugin(page, pluginId);
      await revealDetail(page);
      await shot(`detail-${name}`);
      check(`${tag} ${name} 상세 가로 넘침 0`, (await overflowX(page)) === 0);
      const closed = await count(page, "plugin-install-closed");
      const grantButtons = await count(page, "plugin-scope-grant");
      const revokeButtons = await count(page, "plugin-scope-revoke");
      // 설치·권한을 바꾸는 단추 전부: 설치, 다시 활성화(설치했지만 꺼진 앱), 설치 해제.
      const installButton =
        (await page.getByRole("button", { name: "워크스페이스에 설치", exact: true }).count()) +
        (await page.getByRole("button", { name: "다시 활성화", exact: true }).count());
      const uninstallButton = await page.getByRole("button", { name: "설치 해제", exact: true }).count();
      if (PROBE !== "present") {
        check(`${tag} ${name} 읽기 전용: 설치·권한 버튼 없음`, grantButtons + revokeButtons + installButton + uninstallButton === 0, `grant=${grantButtons} revoke=${revokeButtons} install=${installButton} uninstall=${uninstallButton}`);
        check(`${tag} ${name} 읽기 전용: 차분한 안내 한 줄`, closed === 1, `count=${closed}`);
      } else {
        check(`${tag} ${name} 설치 경로가 있으면 안내 줄이 사라진다`, closed === 0, `count=${closed}`);
        check(`${tag} ${name} 설치 경로가 있으면 관리 버튼이 돌아온다`, grantButtons + revokeButtons + installButton + uninstallButton > 0);
      }
      check(`${tag} ${name} 연결하는 곳 공개`, (await count(page, "plugin-egress")) === 1);
    }

    // 3) 전체: 키 큰 창에서 처음부터 끝까지(스크롤 없이 한 장).
    await selectPlugin(page, ID.github);
    await page.setViewportSize({ width: viewport.width, height: viewport.width >= 1200 ? 1300 : 1700 });
    await page.waitForTimeout(400);
    await shot("full");
  } finally {
    await context.close();
  }
}

/** 한 문단이 실제로 어떻게 줄바꿈되는지: 글자마다 Range의 top으로 줄을 나눈다. */
async function paragraphLines(page, selector) {
  return page.evaluate((sel) => {
    const paragraph = document.querySelector(sel);
    if (!paragraph) return null;
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    const lines = [];
    let current = "";
    let lastTop = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (let index = 0; index < node.length; index += 1) {
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + 1);
        const rect = range.getClientRects()[0];
        if (!rect) continue;
        const top = Math.round(rect.top);
        if (lastTop !== null && Math.abs(top - lastTop) > 4) {
          lines.push(current);
          current = "";
        }
        lastTop = top;
        current += node.data[index];
      }
    }
    if (current) lines.push(current);
    return lines;
  }, selector);
}

/**
 * D5 공개 문장(연결하는 곳)의 줄바꿈이 조사를 줄 머리에 홀로 남기지 않는가. 폭마다 다시 잰다:
 * 900에서만 깨지던 결함(괄호 뒤 「이」)은 1240에서 다른 자리가 깨지는 식으로 폭에 따라 달랐다.
 * 이어지는 줄이 한 글자 조사 + 공백으로 시작하면 고아다(첫 줄의 「이 앱을」은 지시어라 센 줄에서 뺀다).
 */
async function widthSweepScene(browser, origin, scheme) {
  const { context, page } = await open(browser, origin, scheme, { width: 1280, height: 800 });
  try {
    await page.goto(`${origin}/#/ai/external/apps`);
    await page.getByTestId("plugin-list").waitFor({ timeout: 20_000 });
    for (const width of [900, 960, 1024, 1100, 1200, 1240, 1280, 1366, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const [name, pluginId] of [["github", ID.github], ["notion", ID.notion], ["drive", ID.drive]]) {
        await page.getByTestId(`plugin-catalog-${pluginId}`).click();
        await page.getByTestId("plugin-detail").waitFor();
        await page.waitForTimeout(250);
        const lines = await paragraphLines(page, '[data-testid="plugin-egress"] p');
        const orphans = (lines ?? []).slice(1).filter((line) => /^[이가은는을를도만의에로와과]\s/.test(line.trimStart()));
        check(`${width}-${scheme} ${name} D5 문장: 줄 머리에 홀로 남은 조사가 없다`, lines !== null && orphans.length === 0, JSON.stringify(lines));
      }
    }
  } finally {
    await context.close();
  }
}

/** 목록이 일곱이 되면 검색·보기가 돌아오고, 다 걸러 내면 사실대로 말하고 「필터 지우기」를 준다. */
async function manyScenes(browser, origin, scheme) {
  const viewport = { width: 1280, height: 800 };
  const tag = `${viewport.width}-${scheme}`;
  const { context, page } = await open(browser, origin, scheme, viewport);
  const shot = (name) => page.screenshot({ path: resolve(OUT_DIR, `${name}-${tag}.png`) });
  try {
    await page.goto(`${origin}/#/ai/external/apps`);
    await page.getByTestId("plugin-list").waitFor({ timeout: 20_000 });
    await page.getByTestId("plugin-detail").waitFor();
    await page.waitForTimeout(700);
    await shot("many");
    check(`${tag} 일곱 앱: 목록이 일곱 줄이다`, (await page.locator('[data-testid^="plugin-catalog-"]').count()) === 7);
    check(`${tag} 일곱 앱: 검색·보기가 돌아온다`, (await page.locator("#plugin-search").count()) === 1 && (await page.locator("#plugin-filter").count()) === 1);
    await page.locator("#plugin-search").fill("zzzz");
    await page.getByTestId("plugins-empty").waitFor({ timeout: 10_000 });
    await page.waitForTimeout(300);
    await shot("many-filtered-empty");
    const empty = (await page.getByTestId("plugins-empty").textContent()) ?? "";
    check(`${tag} 걸러 낸 빈 상태: 사실대로 말하고 필터 지우기를 준다`, empty.includes("보여 줄 앱이 아직 없어요.") && empty.includes("검색어나 보기를 바꿔") && empty.includes("필터 지우기"), empty);
    await page.getByRole("button", { name: "필터 지우기", exact: true }).click();
    await page.getByTestId("plugin-list").waitFor({ timeout: 10_000 });
    check(`${tag} 필터 지우기: 일곱 줄이 돌아온다`, (await page.locator('[data-testid^="plugin-catalog-"]').count()) === 7);
  } finally {
    await context.close();
  }
}

/** Tab을 눌러 조건을 만족하는 요소에 닿을 때까지. 닿지 못하면 null. */
async function tabTo(page, predicateSource, max = 80) {
  for (let step = 1; step <= max; step += 1) {
    await page.keyboard.press("Tab");
    const hit = await page.evaluate(`(() => { const el = document.activeElement; return Boolean(el) && (${predicateSource})(el); })()`);
    if (hit) return step;
  }
  return null;
}

/**
 * 한 상태 장면. 상태마다 **새 컨텍스트**로 연다: 같은 페이지에서 서버의 답만 바꾸면 react-query가
 * 앞 장면의 캐시를 먼저 보여 줘서 다른 상태를 찍게 된다.
 */
async function stateScene(browser, origin, scheme, state, run) {
  const viewport = { width: 1280, height: 800 };
  const tag = `${viewport.width}-${scheme}`;
  scenario.catalog = state;
  const { context, page } = await open(browser, origin, scheme, viewport);
  const shot = (name) => page.screenshot({ path: resolve(OUT_DIR, `${name}-${tag}.png`) });
  try {
    await run({ page, tag, shot });
  } finally {
    scenario.catalog = "ok";
    await context.close();
  }
}

/** 네 가지 필수 상태. 모두 1280, 한 서버가 앱 목록에 어떻게 답하느냐만 다르다. */
async function stateScenes(browser, origin, scheme) {
  // 빈 상태: 서버가 앱을 하나도 등록하지 않았다.
  await stateScene(browser, origin, scheme, "empty", async ({ page, tag, shot }) => {
    await page.goto(`${origin}/#/ai/external/apps`);
    await page.getByTestId("plugins-empty").waitFor({ timeout: 20_000 });
    await page.waitForTimeout(400);
    await shot("state-empty");
    check(`${tag} 빈 상태: 사실대로 말한다`, ((await page.getByTestId("plugins-empty").textContent()) ?? "").includes("보여 줄 앱이 아직 없어요."));
    check(`${tag} 빈 상태: 안내 줄·검색 컨트롤이 없다`, (await count(page, "plugin-install-closed")) === 0 && (await page.locator("#plugin-search").count()) === 0);
  });

  // 오류: 서버가 아프다(503). 접지 않고 다시 시도를 준다.
  await stateScene(browser, origin, scheme, "error", async ({ page, tag, shot }) => {
    await page.goto(`${origin}/#/ai/external/apps`);
    await page.getByTestId("plugins-error").waitFor({ timeout: 20_000 });
    await page.waitForTimeout(400);
    await shot("state-error");
    check(`${tag} 오류: 다시 시도가 있고 접힌 안내가 아니다`, (await count(page, "plugins-unavailable")) === 0 && ((await page.getByTestId("plugins-error").textContent()) ?? "").includes("다시 시도"));
  });

  // 로딩: 높이를 보존하는 중성 막대(목록·상세 두 칸). 응답이 늦다.
  await stateScene(browser, origin, scheme, "slow", async ({ page, tag, shot }) => {
    await page.goto(`${origin}/#/ai/external/apps`);
    await page.getByTestId("plugin-marketplace-skeleton").waitFor({ timeout: 20_000 });
    await page.waitForTimeout(300);
    await shot("state-loading");
    check(`${tag} 로딩: 막대가 서고 목록·설치 컨트롤은 아직 없다`, (await count(page, "plugin-list")) === 0 && (await count(page, "plugin-install-closed")) === 0);
  });

  // 접힘: 이 서버는 앱 목록 경로가 없다(404). 목차의 「앱」 줄이 접히고, 직접 열어도 오류가 아니다.
  await stateScene(browser, origin, scheme, "absent", async ({ page, tag, shot }) => {
    await page.goto(`${origin}/#/ai/external`);
    await page.getByTestId("ai-external-row-incoming").waitFor({ timeout: 20_000 });
    await page.waitForTimeout(900);
    await shot("state-absent-index");
    check(`${tag} 접힘: 목차에 「앱」 줄도 칩도 없다`, (await count(page, "ai-external-row-apps")) === 0 && (await count(page, "ai-external-chip-apps")) === 0);
    const indexText = (await page.getByTestId("ai-external-row-incoming").locator("xpath=ancestor::ul").textContent()) ?? "";
    check(`${tag} 접힘: 목차가 「읽지 못했어요」를 말하지 않는다`, !indexText.includes("읽지 못했어요"));
    await page.goto(`${origin}/#/ai/external/apps`);
    await page.getByTestId("plugins-unavailable").waitFor({ timeout: 20_000 });
    await page.waitForTimeout(400);
    await shot("state-absent-detail");
    check(`${tag} 접힘: 직접 열면 미제공 안내이고 오류 배너가 아니다`, (await count(page, "plugins-error")) === 0);
  });
}

/** 키보드만으로: 목록 행과 상세의 링크에 포커스 링이 보이는가. */
async function keyboardScenes(browser, origin, scheme) {
  const viewport = { width: 1280, height: 800 };
  const tag = `${viewport.width}-${scheme}`;
  const { context, page } = await open(browser, origin, scheme, viewport);
  const shot = (name) => page.screenshot({ path: resolve(OUT_DIR, `${name}-${tag}.png`) });
  try {
    scenario.catalog = "ok";
    await page.goto(`${origin}/#/ai/external/apps`);
    await page.getByTestId("plugin-list").waitFor({ timeout: 20_000 });
    await page.getByTestId("plugin-detail").waitFor();
    await page.waitForTimeout(700);
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    const toRow = await tabTo(page, `(el) => (el.getAttribute("data-testid") || "").startsWith("plugin-catalog-")`);
    check(`${tag} 키보드: Tab으로 앱 목록 행에 닿는다`, toRow !== null, String(toRow));
    await page.waitForTimeout(150);
    await shot("focus-row");
    const toLink = await tabTo(page, `(el) => el.tagName === "A" && el.closest('[data-testid="plugin-detail"]') !== null`, 40);
    check(`${tag} 키보드: Tab으로 상세의 링크에 닿는다`, toLink !== null, String(toLink));
    await page.waitForTimeout(150);
    await shot("focus-link");
    // 포커스 링이 실제로 그려진다(outline이 있다).
    const ring = await page.evaluate(() => { const style = getComputedStyle(document.activeElement); return { width: style.outlineWidth, style: style.outlineStyle }; });
    check(`${tag} 키보드: 링크의 포커스 링이 보인다`, ring.style !== "none" && ring.width !== "0px", JSON.stringify(ring));
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
      if (MANY) {
        await manyScenes(browser, preview.origin, scheme);
        continue;
      }
      for (const viewport of [{ width: 1280, height: 800 }, { width: 900, height: 800 }]) {
        await scenes(browser, preview.origin, scheme, viewport);
      }
      if (PROBE === "absent") await widthSweepScene(browser, preview.origin, scheme);
      // 필수 상태와 키보드 장면은 설치 경로가 없는 서버(오늘의 서버)에서만 의미가 있다.
      if (PROBE === "absent") {
        await stateScenes(browser, preview.origin, scheme);
        await keyboardScenes(browser, preview.origin, scheme);
      }
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
