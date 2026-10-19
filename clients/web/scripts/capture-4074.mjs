#!/usr/bin/env node
// =============================================================================
// 앱 로그인 캡처 (#4074): AI 허브 › 외부 연결 › 앱 › Gmail 상세의 「로그인」(Hermes 로그인 중계, 운영자 전용).
//
//   npm run build && OUT_DIR=<폴더> node scripts/capture-4074.mjs
//
// 백엔드는 없다. `/v1/**`는 고정 응답이다(앱 목록·상세는 #3949 캡처와 같은 시드 매니페스트에서 짓는다).
// **라이브 서버·사이드카 동작은 runtime-unverified**다. 1440/390 × 라이트/다크.
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

const HERMES = "00000000-0000-7000-8000-0000000000aa";
const LOGIN_ID = "login_gmail_0123456789ab";
const WORLDS = {
  main: { catalog: () => catalogFor(), delayMs: 0 },
  empty: { catalog: () => ({ plugins: [], toolPolicy: { plugins: [] } }), delayMs: 0 },
  error: { catalog: null, delayMs: 0 },
  off: { catalog: () => catalogFor(), delayMs: 0, login: { relay: "off" } },
  stranger: { catalog: () => catalogFor(), delayMs: 0, login: { relay: "forbidden" } },
  failed: { catalog: () => catalogFor(), delayMs: 0, login: { relay: "error" } },
  connected: { catalog: () => catalogFor(), delayMs: 0, login: { relay: "ready", connected: true } },
  loading: { catalog: () => catalogFor(), delayMs: 60_000 },
};

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function installLoginRoutes(context, world) {
  const lg = world.login ?? { relay: "ready", connected: false };
  const jsonR = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await context.route("**/v1/workspaces/*/cohosted-agent", (route) =>
    jsonR(route, { schema: "momo.cohosted_agent.status.v0", declaration: "ready", toolsLockAttested: true, connectable: false, connectedAgentId: HERMES }));
  await context.route("**/v1/workspaces/*/agents/*/app-login", async (route) => {
    if (route.request().method() === "GET") {
      if (lg.relay === "off") return jsonR(route, { error: { code: "login_relay_off", message: "off" } }, 409);
      if (lg.relay === "forbidden") return jsonR(route, { error: { message: "no" } }, 403);
      if (lg.relay === "error") return jsonR(route, { error: { message: "bad" } }, 502);
      return jsonR(route, { schema: "momo.login_relay.targets.v0", targets: [{ target: "gmail", connected: lg.connected }] });
    }
    return jsonR(route, { schema: "momo.login_relay.start.v0", loginId: LOGIN_ID, mode: "paste", url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=capture", expiresAt: Math.floor(Date.now() / 1000) + 290 });
  });
  await context.route("**/v1/workspaces/*/agents/*/app-login/*/complete", (route) => { lg.status = "submitted"; return jsonR(route, { schema: "momo.login_relay.status.v0", status: "submitted" }); });
  await context.route("**/v1/workspaces/*/agents/*/app-login/*", (route) =>
    jsonR(route, { schema: "momo.login_relay.status.v0", status: route.request().method() === "DELETE" ? "cancelled" : (lg.status ?? "pending") }));
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
  await installLoginRoutes(context, world);
}

const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok && ASSERT) failures.push(name);
}
const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const textOf = async (page, testId) => ((await page.getByTestId(testId).first().textContent()) ?? "").replace(/\s+/g, " ").trim();
const count = (page, testId) => page.getByTestId(testId).count();

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
  const shotIn = async (page, name) => {
    await page.getByTestId("app-login").evaluate((el) => el.scrollIntoView({ block: "center" })).catch(() => undefined);
    await page.waitForTimeout(250);
    check(`${tag} ${name}: 가로 넘침 0`, (await overflowX(page)) === 0, String(await overflowX(page)));
    await page.screenshot({ path: resolve(OUT_DIR, `${name}-${tag}.png`) });
  };
  const worlds = { ...WORLDS };
  // 1) 연결 안 됨 → 로그인 → 주소 열기·붙여넣기 → 확인 중
  {
    const world = { ...WORLDS.main, login: { relay: "ready", connected: false } };
    const { context, page } = await open(browser, origin, scheme, { width, height }, world, "plugin-list");
    try {
      await selectPlugin(page, ID.gmail);
      await page.getByTestId("app-login-row").waitFor();
      check(`${tag} 연결 안 됨 칩과 로그인 단추`, (await textOf(page, "app-login-row")).includes("연결 안 됨") && (await textOf(page, "app-login-start")) === "로그인");
      check(`${tag} 만료 안내는 단정하지 않는다`, (await textOf(page, "app-login-expiry")).includes("라면") && (await textOf(page, "app-login-expiry")).includes("알 수 없어요"));
      await shotIn(page, "idle");
      await page.getByTestId("app-login-start").click();
      await page.getByTestId("login-paste").waitFor();
      check(`${tag} 주소 열기: 호스트 강조와 rel`, (await textOf(page, "login-host")) === "accounts.google.com" && (await page.getByTestId("login-open").getAttribute("rel")) === "noopener noreferrer");
      check(`${tag} 첫 초점은 주소 열기`, await page.evaluate(() => document.activeElement?.getAttribute("data-testid") === "login-open"));
      await shotIn(page, "paste");
      await page.getByTestId("login-paste").fill("http://127.0.0.1:4182/callback?code=capture-only-fake&state=capture-only-fake");
      await page.getByTestId("login-paste-send").click();
      await page.waitForTimeout(250);
      check(`${tag} 보낸 뒤 칸이 비어 있고 화면에 값이 없다`, (await page.getByTestId("login-paste").inputValue()) === "" && !(await page.content()).includes("capture-only-fake"));
      await shotIn(page, "submitted");
    } finally {
      await context.close();
    }
  }
  // 2) 연결됨 + 만료 안내
  for (const [name, waitFor, check_] of [
    ["connected", "app-login-row", async (page) => check(`${tag} 연결됨: 다시 로그인`, (await textOf(page, "app-login-start")) === "다시 로그인")],
    ["off", "app-login-shell", async (page) => check(`${tag} 꺼짐: 프로브 명령`, (await textOf(page, "app-login-shell")).includes("mcp_login_probe.py gmail"))],
    ["failed", "app-login-error", async () => undefined],
  ]) {
    const { context, page } = await open(browser, origin, scheme, { width, height }, worlds[name], "plugin-list");
    try {
      await selectPlugin(page, ID.gmail);
      await page.getByTestId(waitFor).waitFor();
      await check_(page);
      await shotIn(page, name);
    } finally {
      await context.close();
    }
  }
  // 3) 운영자가 아니면 없다
  {
    const { context, page } = await open(browser, origin, scheme, { width, height }, worlds.stranger, "plugin-list");
    try {
      await selectPlugin(page, ID.gmail);
      await page.waitForTimeout(700);
      check(`${tag} 운영자 아님: 로그인 블록 없음`, (await count(page, "app-login")) === 0);
    } finally {
      await context.close();
    }
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
