#!/usr/bin/env node
// =============================================================================
// 「앱 설치」 켜기 캡처 (#3943 U-2, ADR-0113 P3): AI 허브 › 외부 연결 › 앱, 설치 경로가 서 있는 서버.
//
//   npm run build && OUT_DIR=<폴더> node scripts/capture-3943.mjs
//
// 백엔드는 없다. `/v1/**`는 고정 응답이고, 설치·권한 경로의 GET은 405(서 있는 서버)로 답한다.
// 앱 목록과 GitHub 상세는 서버가 실제로 준 바이트(`server/Fixtures/plugin-wire/*.json`)를 쓰고, 나머지
// 상세는 시드 매니페스트를 같은 모양으로 감싼다. 지어낸 응답은 없다. Notion은 쓰기 권한 하나를 더 선언한
// 합성 매니페스트로 「권한마다 따로 동의」를 잰다.
//
// 세계 넷 x 라이트·다크 x 1440:
//   admin          소유자 시점. 미설치 앱에 설치 단추, 설치된 앱에 회수·해제.
//   member-named   일반 멤버 시점, 활성 관리자가 있다: 「○○님(관리자)에게 설치를 요청하세요」.
//   member-none    일반 멤버 시점, 활성 관리자가 없다: 「설치할 사람이 없어요」.
//   member-consent 일반 멤버가 설치된 앱에서 「내 사용 허용」: 동의 창(두 줄, 선택 0), 하나만 고름, 서버 거절.
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
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/plugins-install");
const PORT = Number(process.env.CAPTURE_PORT || 5243);
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


const NO_INSTALLER = "이 워크스페이스에 앱을 설치할 사람이 없어요. 소유자 계정을 확인해 주세요.";

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
const meRow = (role) => ({ ...base, id: memberId, kind: "human", displayName: "곽성재", handle: "seongjae", role });

const WORLDS = {
  admin: { roster: [meRow("owner")], notionInstalled: false },
  "member-named": { roster: [meRow("member"), adminRow], notionInstalled: false },
  "member-none": { roster: [meRow("member")], notionInstalled: false },
  "member-consent": { roster: [meRow("member"), adminRow], notionInstalled: true },
};

const NOTION_WRITE_TOOL = {
  name: "notion.update_page",
  description: "페이지의 내용을 고칩니다.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  risk: "write",
  approvalPolicy: "require_approval",
  schemaDigest: `sha256:${"c".repeat(64)}`,
  scopes: ["notion:write"],
};

function catalogFor(world) {
  const catalog = JSON.parse(JSON.stringify(CATALOG));
  if (world.notionInstalled) {
    const item = catalog.plugins.find((plugin) => plugin.pluginId === ID.notion);
    Object.assign(item, { installed: true, enabled: true });
  }
  return catalog;
}

function detailFor(world, pluginId) {
  if (pluginId === ID.github) return GITHUB_DETAIL;
  const item = catalogFor(world).plugins.find((plugin) => plugin.pluginId === pluginId);
  let seeded = MANIFEST_BY_ID[pluginId];
  if (!item || !seeded) return null;
  if (pluginId === ID.notion) {
    seeded = {
      ...seeded,
      mcp: { ...seeded.mcp, tools: [...seeded.mcp.tools, NOTION_WRITE_TOOL] },
      momo: { ...seeded.momo, approvalTier: { ...seeded.momo.approvalTier, "notion.update_page": "workspace_write" } },
    };
  }
  const rest = { ...item };
  delete rest.recommended;
  return { plugin: { ...rest, manifest: seeded } };
}

/** 쓰기 요청 기록: 「동의 없이 grant POST 0」을 눈이 아니라 숫자로 잰다. */
const writes = [];

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
    if (request.method() !== "GET" && /\/plugins\//.test(path)) {
      writes.push(`${request.method()} ${path}`);
      return json(route, { error: { code: "forbidden", message: "workspace admin required" } }, 403);
    }
    if (request.method() === "GET" && /\/plugins\/[^/]+\/(install|grants)$/.test(path)) {
      return json(route, { error: { code: "method_not_allowed", message: "method not allowed" } }, 405);
    }
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) return json(route, { members: world.roster });
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/hosted-agent-connections")) return json(route, { connections: [] });
    if (path.endsWith("/webhooks")) return json(route, { installations: [] });
    if (path.endsWith("/event-subscriptions")) return json(route, { eventSubscriptions: [] });
    if (path.endsWith("/plugins")) return json(route, catalogFor(world));
    const detail = path.match(/\/plugins\/([^/]+)$/);
    if (detail) {
      const body = detailFor(world, decodeURIComponent(detail[1]));
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

async function open(browser, origin, scheme, viewport, world) {
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
  if ((await page.getByTestId("sidebar-toggle").getAttribute("aria-expanded")) === "false") {
    await page.getByTestId("sidebar-toggle").click();
    await page.waitForTimeout(400);
  }
  await page.goto(`${origin}/#/ai/external/apps`);
  await page.getByTestId("plugin-list").waitFor({ timeout: 20_000 });
  await page.getByTestId("plugin-detail").waitFor();
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

const buttonCount = (page, name) => page.getByRole("button", { name, exact: true }).count();

async function world(browser, origin, scheme, name) {
  const tag = `${name}-${scheme}`;
  const { context, page } = await open(browser, origin, scheme, { width: 1440, height: 900 }, WORLDS[name]);
  const shot = (shotName, options = {}) => page.screenshot({ path: resolve(OUT_DIR, `${shotName}-${tag}.png`), ...options });
  writes.length = 0;
  try {
    check(`${tag} 가로 넘침 0`, (await overflowX(page)) === 0);
    if (name === "admin") {
      await selectPlugin(page, ID.notion);
      await shot("detail-notion");
      check(`${tag} Notion: 미설치 칩이 목록과 상세에 있다`, (await textOf(page, `plugin-catalog-${ID.notion}`)).includes("미설치") && (await textOf(page, "plugin-detail")).includes("미설치"));
      check(`${tag} Notion: 설치 단추가 있다`, (await buttonCount(page, "워크스페이스에 설치")) === 1);
      check(`${tag} 안내 문장(관리자에게)이 없다`, !(await textOf(page, "plugin-detail")).includes("설치를 요청하세요"));
      await selectPlugin(page, ID.github);
      await shot("detail-github");
      check(`${tag} GitHub: 설치됨 · 내가 허용함 칩`, (await textOf(page, "plugin-detail")).includes("설치됨 · 내가 허용함"));
      check(`${tag} GitHub: 회수·해제 단추`, (await buttonCount(page, "내 권한 회수")) === 1 && (await buttonCount(page, "설치 해제")) === 1);
      await selectPlugin(page, ID.linear);
      await shot("detail-linear");
      check(`${tag} Linear: 설치했지만 비활성 칩`, (await textOf(page, "plugin-detail")).includes("설치했지만 비활성"));
    } else if (name === "member-named") {
      await selectPlugin(page, ID.notion);
      await shot("detail-notion");
      const detail = await textOf(page, "plugin-detail");
      check(`${tag} 「김관리님(관리자)에게 설치를 요청하세요.」`, detail.includes("김관리님(관리자)에게 설치를 요청하세요."), detail.slice(0, 200));
      check(`${tag} 설치 단추가 없다`, (await buttonCount(page, "워크스페이스에 설치")) === 0);
    } else if (name === "member-none") {
      await selectPlugin(page, ID.notion);
      await shot("detail-notion");
      const detail = await textOf(page, "plugin-detail");
      check(`${tag} 관리자 없음 문장이 그대로 선다`, detail.includes(NO_INSTALLER), detail.slice(0, 200));
      check(`${tag} 설치 단추가 없다`, (await buttonCount(page, "워크스페이스에 설치")) === 0);
      check(`${tag} 경고(alert)로 그리지 않는다`, (await page.locator('[data-testid="plugin-detail"] [role="alert"]').count()) === 0);
    } else {
      await selectPlugin(page, ID.notion);
      await shot("detail-notion");
      check(`${tag} 설치됨 · 내 허용 없음 칩`, (await textOf(page, "plugin-detail")).includes("설치됨 · 내 허용 없음"));
      await page.getByTestId("plugin-scope-grant").click();
      await page.getByTestId("plugin-scope-consent").waitFor();
      await page.waitForTimeout(400);
      await shot("consent-open");
      const lines = await page.locator('[data-testid="plugin-consent-custody"] li').allTextContents();
      check(`${tag} 동의 창 두 줄`, JSON.stringify(lines) === JSON.stringify(["토큰은 oort에 없어요", "처음 쓸 때 실행 장소에서 로그인해요"]), JSON.stringify(lines));
      check(`${tag} 아무것도 고르지 않은 채 열린다`, (await textOf(page, "plugin-scope-selection-count")) === "2개 중 0개 선택");
      check(`${tag} 열기만 해서는 POST 0`, writes.length === 0, writes.join("|"));
      await page.getByTestId("plugin-scope-confirm").click({ force: true });
      await page.waitForTimeout(200);
      check(`${tag} 고른 것 없이 확인해도 POST 0`, writes.length === 0, writes.join("|"));
      await page.getByTestId("plugin-scope-notion:write").check();
      await page.waitForTimeout(200);
      await shot("consent-one-selected");
      check(`${tag} 하나만 고름: 2개 중 1개`, (await textOf(page, "plugin-scope-selection-count")) === "2개 중 1개 선택");
      await page.getByTestId("plugin-scope-confirm").click();
      await page.getByTestId("plugin-scope-consent-error").waitFor({ timeout: 10_000 });
      await page.waitForTimeout(300);
      await shot("consent-error");
      check(`${tag} 고른 권한 하나만 나갔다(POST 1, 쓰기 권한 body)`, writes.length === 1 && writes[0].startsWith("POST ") && writes[0].endsWith("/grants"), writes.join("|"));
      check(`${tag} 서버가 거절하면 창이 열린 채 오류를 말한다`, (await page.getByTestId("plugin-scope-consent").count()) === 1);
      check(`${tag} 동의 창 가로 넘침 0`, (await overflowX(page)) === 0);
      await page.getByTestId("plugin-scope-cancel").click();
      await page.waitForTimeout(300);
      check(`${tag} 취소 뒤에도 POST는 1건뿐`, writes.length === 1, writes.join("|"));
    }
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
      for (const name of Object.keys(WORLDS)) await world(browser, preview.origin, scheme, name);
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
