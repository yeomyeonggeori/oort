#!/usr/bin/env node
// =============================================================================
// CAPTURE (#4220, ADR-0205 D2): GitHub 앱 만들기를 데스크탑에서 (기본 브라우저 핸드오프).
//
//   후: npm run build && node scripts/capture-4220.mjs
//   전: BEFORE=1 DIST_DIR=<변경 전 번들> node scripts/capture-4220.mjs     # 단언 없이 보이는 것만 적는다
//
// 서버는 이 트리에 없고 운영 서버에는 GITHUB_APP_MASTER_KEY·MOMO_PUBLIC_BASE_URL 이 아직 없다: `/v1/**` 는
// 고정 응답(runtime-unverified)이고, GitHub 는 가짜다. 하네스가 만드는 세계:
//
//   · 서버의 공개 오리진은 https 여야 한다(핸드오프는 https 콜백만 믿는다). 그래서 모든 문은
//     `https://oort.yeomyeonggeori.test` 이고, 이 오리진의 정적 파일은 로컬 preview 로 보낸다(TLS 는 없다).
//   · 「데스크탑 셸」은 `__TAURI_INTERNALS__` 흉내다: `open_external_url` 이 받은 주소를 `window.__opened` 에 쌓는다.
//   · 「시스템 브라우저」는 세션 없는 새 컨텍스트다: 데스크탑이 연 주소를 그대로 열어 보고, GitHub 로 가는 POST
//     한 번을 가로채 (주소·본문·Referer)를 적은 뒤 가짜 GitHub 화면으로 답한다.
//
// 장면 (라이트·다크 x 1440, 공개 두 화면은 390 도):
//   1 카드        「앱」 GitHub 카드: 운영자이고 앱이 없으면 「GitHub 앱 만들기」가 선다
//   2 운영자 구역 데스크탑에서 조직 이름을 적고 「GitHub 앱 만들기」: 기본 브라우저를 열었다 / 열지 못했다
//   3 핸드오프    시스템 브라우저가 연 `/github/handoff#…`: GitHub 로 POST 하는 순간의 화면
//   4 착지        GitHub 가 돌려보낸 `/?githubApp=…` 의 로그인 안 된 화면 (끝났어요 / 막혔어요)
//   5 등록됨      데스크탑 창이 앞으로 돌아오면 상태를 다시 읽어 「등록됨」, 이어서 「GitHub 연결」의 설치 링크
// 단언이 하나라도 실패하면(후 판에서) 종료 코드 1이다.
// =============================================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(WEB_ROOT, "../..");
const BEFORE = process.env.BEFORE === "1";
const DIST_DIR = process.env.DIST_DIR ? resolve(process.env.DIST_DIR) : resolve(WEB_ROOT, "dist");
const OUT_DIR = process.env.OUT_DIR
  ? resolve(process.env.OUT_DIR)
  : resolve(WEB_ROOT, BEFORE ? "captures/4220/before" : "captures/4220");
const PORT = Number(process.env.CAPTURE_PORT || 5420);

const FAKE_ORIGIN = "https://oort.yeomyeonggeori.test";
const wire = (name) => JSON.parse(readFileSync(resolve(REPO_ROOT, "server/Fixtures/plugin-wire", name), "utf8"));
const CATALOG = wire("catalog.json");
const GITHUB_DETAIL = wire("detail-github.json");

const workspaceId = "00000000-0000-7000-8000-000000000001";
const me = "00000000-0000-7000-8000-000000000101";
const marketing = "00000000-0000-7000-8000-000000000201";
const channels = [{ id: marketing, workspaceId, kind: "public", name: "마케팅", muted: false }];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: me, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: "ws://capture-4220.invalid/connection/websocket",
};
const roster = [
  {
    id: me, workspaceId, kind: "human", status: "active", role: "owner", displayName: "곽성재", handle: "seongjae",
    channelCount: 1, channelIds: [marketing], capabilities: [], createdAtMs: 0, updatedAtMs: 0,
  },
];

// ---- 가짜 서버가 아는 것 (모양은 server-rust 의 응답을 옮겼다) ----------------------------------------
const PERMISSIONS = { metadata: "read", issues: "read", pull_requests: "read", checks: "read", contents: "read" };
// 캡처 전용 값이다(자격이 아니다). 서버의 모양 `<워크스페이스 uuid>.<64 hex>` 를 그대로 쓴다.
const STATE = `${workspaceId}.${"3f9c".repeat(16)}`;
const REGISTRATION_URL = `https://github.com/organizations/yeomyeonggeori/settings/apps/new?state=${STATE}`;
const MANIFEST = {
  name: "oort-oort-yeomyeonggeori-test",
  url: FAKE_ORIGIN,
  hook_attributes: { url: `${FAKE_ORIGIN}/v1/integrations/github/webhook`, active: true },
  redirect_url: `${FAKE_ORIGIN}/v1/integrations/github/app/callback`,
  setup_url: `${FAKE_ORIGIN}/v1/integrations/github/setup`,
  description:
    "oort가 저장소의 PR·이슈·체크·push·release 소식을 채널로 받아 와요. 코드 읽기 권한(contents: read)은 push·release 알림을 받으려고 요청하고, oort 서버는 알림을 위해 코드를 읽지 않아요.",
  public: false,
  request_oauth_on_install: false,
  default_events: ["pull_request", "pull_request_review", "issues", "issue_comment", "check_suite", "push", "release"],
  default_permissions: PERMISSIONS,
};
const APP = {
  appId: 912345, slug: "oort-oort-yeomyeonggeori-test", clientId: "Iv1.capture", ownerLogin: "yeomyeonggeori", ownerType: "Organization",
  source: "manifest", createdAtMs: Date.parse("2026-10-22T09:00:00Z"), rotationWindowOpen: false,
  installUrl: "https://github.com/apps/oort-oort-yeomyeonggeori-test/installations/new",
};
const statusUnregistered = () => ({ masterKeyConfigured: true, publicAddressConfigured: true, configured: false, permissions: PERMISSIONS, events: ["pull_request", "issues"] });
const statusRegistered = () => ({ ...statusUnregistered(), configured: true, app: APP });
const FEATURES = ["pulls", "issues", "reviews", "comments", "checks", "commits", "releases"];

const world = {
  statusMode: "operator", // operator | denied
  status: statusUnregistered(),
  overview: { appRegistered: false, installations: [], subscriptions: [], features: FEATURES, defaultFeatures: ["pulls", "issues"] },
};
function resetWorld() {
  writes.length = 0;
  world.statusMode = "operator";
  world.status = statusUnregistered();
  world.overview = { appRegistered: false, installations: [], subscriptions: [], features: FEATURES, defaultFeatures: ["pulls", "issues"] };
}
const writes = [];

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}
const apiError = (route, status, code, message = "capture") => json(route, { error: { code, message } }, status);

async function handleApi(route, request, url) {
  const method = request.method();
  const path = url.pathname;
  if (path === "/v1/auth/login") return json(route, auth);
  if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
  if (path === "/v1/auth/realtime-token") {
    return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId: me });
  }
  if (path === "/v1/integrations/github/app" && method === "GET") {
    return world.statusMode === "denied" ? apiError(route, 403, "forbidden") : json(route, world.status);
  }
  if (path === "/v1/integrations/github/app/manifest" && method === "POST") {
    writes.push(`POST ${path} ${request.postData() ?? ""}`);
    return json(route, { schema: "oort.github_app.manifest.v1", registrationUrl: REGISTRATION_URL, manifest: MANIFEST, expiresInSeconds: 3600 });
  }
  if (path === "/v1/integrations/github/installations" && method === "GET") return json(route, { installations: [] });
  if (path.startsWith("/v1/integrations/github/")) return apiError(route, 404, "not_found");
  if (path === `/v1/workspaces/${workspaceId}/github` && method === "GET") return json(route, world.overview);
  if (path === `/v1/workspaces/${workspaceId}/github/link` && method === "POST") {
    writes.push(`POST ${path}`);
    return json(route, {
      installUrl: `https://github.com/apps/${APP.slug}/installations/new?state=${STATE}`,
      expiresInSeconds: 600,
    });
  }
  if (path.endsWith("/cohosted-agent")) return apiError(route, 404, "not_found"); // 이 서버에는 같은 서버 Hermes 길이 없다(배너 소음 제거)
  if (path.endsWith("/channels")) return json(route, { channels });
  if (path.endsWith("/roster")) return json(route, { members: roster });
  if (path.endsWith("/read-state")) return json(route, { read_states: [] });
  if (path.endsWith("/hosted-agent-connections")) return json(route, { connections: [] });
  if (path.endsWith("/webhooks")) return json(route, { installations: [] });
  if (path.endsWith("/event-subscriptions")) return json(route, { eventSubscriptions: [] });
  if (path.endsWith("/plugins")) return json(route, CATALOG);
  const detail = path.match(/\/plugins\/([^/]+)$/);
  if (detail) return decodeURIComponent(detail[1]) === "com.momo.plugins.github" ? json(route, GITHUB_DETAIL) : apiError(route, 404, "not_found");
  if (path.endsWith("/unfurl-settings")) return json(route, { enabled: true });
  if (path.endsWith("/huddles/active")) return json(route, { huddle: null, participants: [] });
  if (path.endsWith("/work-hosts")) return json(route, { workHosts: [] });
  if (path.endsWith("/work-sessions/shared")) return json(route, { sessions: [], nextCursor: null });
  if (path.endsWith("/work-sessions")) return json(route, { workSessions: [] });
  if (path.endsWith(`/workspaces/${workspaceId}`)) {
    return json(route, { workspace: { id: workspaceId, name: "여명거리", slug: "team", updatedAtMs: 1, roleLabels: {}, welcomeAgentMemberId: null, welcomePrompt: "", subscriptionAgentsEnabled: true } });
  }
  if (path.includes("/messages")) return json(route, { messages: [] });
  return json(route, {});
}

/** 한 컨텍스트가 `FAKE_ORIGIN` 으로 보는 세계: /v1 은 가짜 서버, 나머지 정적 파일은 로컬 preview. */
async function installFakeOrigin(context, localOrigin) {
  await context.route(`${FAKE_ORIGIN}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.startsWith("/v1/")) return handleApi(route, request, url);
    const response = await context.request.get(`${localOrigin}${url.pathname}${url.search}`);
    return route.fulfill({ response });
  });
}

/** 가짜 GitHub: 오는 요청(주소·본문·Referer)을 적고 곧바로 가짜 화면으로 답한다. */
function installFakeGithub(context) {
  const hits = [];
  context.route("https://github.com/**", async (route) => {
    const request = route.request();
    hits.push({ url: request.url(), method: request.method(), referer: request.headers().referer ?? null, body: request.postData() ?? "" });
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: "<!doctype html><meta charset=utf-8><title>GitHub (capture)</title><p>GitHub (capture mock)</p>",
    });
  });
  return { hits };
}

/**
 * 「시스템 브라우저」: 세션 없는 새 컨텍스트. 핸드오프 페이지의 자동 제출(`form.submit()`)이 곧바로 화면을
 * 떠나면 그 화면을 찍을 수 없어서(보류된 이동 동안 Playwright 가 페이지를 읽지 못한다), 첫 제출은 **기록만**
 * 하고 막아 둔다. 기록(action·method·rel·칸·매니페스트)은 단언하고, 수동 버튼은 진짜 POST 로 흘려 보낸다.
 */
async function openSystemBrowser(browser, localOrigin, scheme, viewport) {
  const context = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion: "reduce", serviceWorkers: "block" });
  await installFakeOrigin(context, localOrigin);
  const github = installFakeGithub(context);
  await context.addInitScript(() => {
    window.__autoSubmits = [];
    window.__blockAutoSubmit = true;
    const real = HTMLFormElement.prototype.submit;
    HTMLFormElement.prototype.submit = function submitRecorded() {
      window.__autoSubmits.push({
        action: this.getAttribute("action"),
        method: this.getAttribute("method"),
        rel: this.getAttribute("rel"),
        fields: [...new FormData(this).keys()],
        manifest: this.elements.namedItem("manifest")?.value ?? null,
      });
      if (window.__blockAutoSubmit) return undefined;
      return real.call(this);
    };
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.log(`pageerror: ${error.message}`));
  return { context, page, github };
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
          if (c.connect) return { id: c.id, connect: { client: "capture-4220", version: "6" } };
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

/** 데스크탑 셸 흉내. `open_external_url` 이 받은 주소를 `window.__opened` 에 쌓는다(셸 쪽 검증은 opener.rs 의 몫). */
async function installDesktop(page) {
  await page.addInitScript(() => {
    const callbacks = new Map();
    let next = 1;
    window.__opened = [];
    window.__openFails = false;
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() { /* 구독 해제 흉내 */ } };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
      transformCallback(cb) { const id = next++; callbacks.set(id, cb); return id; },
      unregisterCallback(id) { callbacks.delete(id); },
      convertFileSrc: (p) => p,
      async invoke(cmd, args) {
        if (cmd === "open_external_url") {
          window.__opened.push(String(args?.url ?? ""));
          if (window.__openFails) throw new Error("refused: capture");
          return null;
        }
        if (cmd === "keychain_available") return true;
        if (cmd === "keychain_store_refresh_token") { window.__kc = true; return null; }
        if (cmd === "keychain_refresh_token_handle") return window.__kc ? "shell:00000000000000000000000000000001" : null;
        if (cmd === "keychain_clear_refresh_token") { window.__kc = false; return null; }
        if (cmd === "app_version") return "0.1.36";
        if (cmd === "notification_permission") return "granted";
        if (cmd === "dock_badge_set") return null;
        if (cmd === "deep_link_take_pending") return [];
        if (cmd.startsWith("plugin:event|")) return 1;
        return null;
      },
    };
  });
}

const failures = [];
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), ...(ok || detail === "" ? {} : { detail: String(detail).slice(0, 300) }) });
  if (BEFORE) {
    console.log(`info ${name}: ${ok ? "예" : "아니오"}`);
    return;
  }
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok) failures.push(name);
}
const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const textOf = async (page, testId) => ((await page.getByTestId(testId).first().textContent()) ?? "").replace(/\s+/g, " ").trim();
const has = async (page, testId) => (await page.getByTestId(testId).count()) > 0;
async function appear(page, testId, timeout = 25_000) {
  try {
    await page.getByTestId(testId).first().waitFor({ timeout });
    return true;
  } catch {
    return false;
  }
}

/** 기다리던 칸이 안 서면 화면이 무엇을 보여 주는지 적고 던진다(디버깅 시간을 줄인다). */
async function must(page, testId, timeout = 25_000) {
  try {
    await page.getByTestId(testId).first().waitFor({ timeout });
  } catch (error) {
    mkdirSync(OUT_DIR, { recursive: true });
    await page.screenshot({ path: resolve(OUT_DIR, `debug-${testId}.png`) }).catch(() => {});
    const text = ((await page.textContent("body").catch(() => "")) ?? "").replace(/\s+/g, " ").slice(0, 400);
    console.log(`기다린 칸 ${testId} 이(가) 서지 않았다. 주소 ${await page.evaluate(() => location.href.split("#")[0])} 글자: ${text}`);
    throw error;
  }
}

async function open(browser, localOrigin, scheme, viewport, { desktop = false, hash = "", search = "", path = "/", signedIn = true } = {}) {
  const context = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion: "reduce", serviceWorkers: "block" });
  await installFakeOrigin(context, localOrigin);
  const github = installFakeGithub(context);
  const page = await context.newPage();
  page.on("pageerror", (error) => console.log(`pageerror: ${error.message}`));
  await installRealtime(page);
  if (desktop) await installDesktop(page);
  await page.addInitScript((server) => { try { localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ } }, FAKE_ORIGIN);
  await page.goto(`${FAKE_ORIGIN}${path}${search}`, { waitUntil: "domcontentloaded" });
  if (signedIn) {
    await advanceToAccount(page);
    await page.getByTestId("login-email").fill("capture@example.test");
    await page.getByTestId("login-password").fill("not-a-secret");
    await page.getByTestId("login-submit").click();
    await page.getByTestId("nav-ai").waitFor({ timeout: 25_000 });
    if (hash) await page.evaluate((h) => { location.hash = h; }, hash);
  }
  return { context, page, github };
}

const shot = async (page, name, tag) => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: resolve(OUT_DIR, `${name}-${tag}.png`) });
};

/** 변경 전 번들에는 핸드오프 주소를 만드는 쪽이 없다: 같은 모양의 주소를 손으로 지어 「그 주소가 지금 무엇을 보여 주나」만 본다. */
function handwrittenHandoffUrl() {
  const payload = Buffer.from(JSON.stringify({ v: 1, u: REGISTRATION_URL, m: MANIFEST, e: 3600 }), "utf8").toString("base64url");
  return `${FAKE_ORIGIN}/github/handoff#${payload}`;
}

// ---- 1 카드 -------------------------------------------------------------------------------------------
async function sceneCard(browser, origin, scheme, viewport) {
  const tag = `${viewport.width}-${scheme}`;
  resetWorld();
  const { context, page } = await open(browser, origin, scheme, viewport, { hash: "/ai/external/apps" });
  await page.getByTestId("plugin-catalog-com.momo.plugins.github").waitFor({ timeout: 25_000 });
  await page.getByTestId("plugin-catalog-com.momo.plugins.github").click();
  await page.getByTestId("github-faces").waitFor({ timeout: 10_000 });
  await page.waitForTimeout(500);
  const entry = await has(page, "github-faces-operator");
  check(`${tag} 카드: 운영자이고 앱이 없으면 「GitHub 앱 만들기」가 선다`, entry);
  if (entry) {
    check(`${tag} 카드: 그 문장`, (await textOf(page, "github-faces-operator")).includes("이 서버에는 아직 GitHub 앱이 없어요."));
    check(`${tag} 카드: 「GitHub 알림 열기」 길은 그대로`, (await textOf(page, "github-faces-open")) === "GitHub 알림 열기");
  }
  await page.getByTestId("github-faces").scrollIntoViewIfNeeded();
  await shot(page, "1-card", tag);
  check(`${tag} 가로 넘침 0 (카드)`, (await overflowX(page)) === 0);
  if (entry) {
    await page.getByTestId("github-faces-create").click();
    await page.getByTestId("github-app-register").waitFor({ timeout: 10_000 });
    check(`${tag} 카드의 진입은 GitHub 구역으로 간다`, (await page.evaluate(() => location.hash)) === "#/ai/external/github");
  }
  // 운영자가 아니면 카드는 이전 그대로다.
  await context.close();
  world.statusMode = "denied";
  const denied = await open(browser, origin, scheme, viewport, { hash: "/ai/external/apps" });
  await denied.page.getByTestId("plugin-catalog-com.momo.plugins.github").click();
  await denied.page.getByTestId("github-faces").waitFor({ timeout: 10_000 });
  await denied.page.waitForTimeout(500);
  check(`${tag} 카드: 운영자가 아니면 진입 줄이 없다`, !(await has(denied.page, "github-faces-operator")));
  await denied.context.close();
  resetWorld();
}

// ---- 2~5 데스크탑 → 시스템 브라우저 → 착지 → 돌아오기 -----------------------------------------------------
async function sceneFlow(browser, origin, scheme, viewport) {
  const tag = `${viewport.width}-${scheme}`;
  resetWorld();
  const desktop = await open(browser, origin, scheme, viewport, { desktop: true, hash: "/ai/external/github" });
  const dp = desktop.page;
  await dp.getByTestId("github-app-register").waitFor({ timeout: 25_000 });
  await dp.getByTestId("github-org-input").fill("yeomyeonggeori");

  // 2 운영자 구역
  await dp.getByTestId("github-register-start").click();
  if (BEFORE) {
    const dead = await appear(dp, "github-manifest-desktop", 10_000);
    check(`${tag} 데스크탑: 막다른 문장이 선다`, dead);
    if (dead) check(`${tag} 데스크탑: 그 문장`, (await textOf(dp, "github-manifest-desktop")).includes("열 수 없어요"));
    check(`${tag} 데스크탑: 기본 브라우저는 열리지 않았다`, (await dp.evaluate(() => window.__opened.length)) === 0);
    await dp.getByTestId("github-paste").scrollIntoViewIfNeeded().catch(() => {});
    await shot(dp, "2-operator-desktop", tag);
    await desktop.context.close();
    return;
  }
  await dp.getByTestId("github-manifest-browser").waitFor({ timeout: 10_000 });
  const opened = await dp.evaluate(() => window.__opened.slice());
  check(`${tag} 데스크탑: 막다른 문장이 없다`, !(await has(dp, "github-manifest-desktop")) && !(await dp.textContent("body")).includes("열 수 없어요"));
  check(`${tag} 데스크탑: 기본 브라우저를 한 번 열었다`, opened.length === 1, `열기 ${opened.length}번`);
  const url = opened[0] ?? "";
  const parsed = url === "" ? null : new URL(url);
  check(`${tag} 열린 주소: 서버의 공개 오리진 + /github/handoff`, parsed?.origin === FAKE_ORIGIN && parsed?.pathname === "/github/handoff", url.slice(0, 80));
  check(`${tag} 열린 주소: 쿼리스트링이 비어 있다`, parsed?.search === "");
  check(`${tag} 열린 주소: 조각 밖에는 state 가 없다`, !url.split("#")[0].includes(STATE) && !url.split("#")[0].includes("state="));
  check(`${tag} 열린 주소: opener 한도(2048) 안`, url.length > 0 && url.length <= 2048, `길이 ${url.length}`);
  check(`${tag} 카드가 열었다고 말한다`, (await textOf(dp, "github-manifest-browser")).includes("기본 브라우저에서 GitHub를 열었어요."));
  check(`${tag} 화면 글자에 state 가 없다`, !(await dp.textContent("body")).includes(STATE));
  // 카드가 통째로 보이게, 그 아래 「이미 만든 앱이 있어요」까지 화면에 들인다.
  await dp.getByTestId("github-paste").scrollIntoViewIfNeeded();
  await shot(dp, "2-operator-desktop", tag);
  check(`${tag} 가로 넘침 0 (운영자 구역)`, (await overflowX(dp)) === 0);

  // 2b 브라우저를 열지 못했을 때
  await dp.evaluate(() => { window.__openFails = true; });
  await dp.getByTestId("github-manifest-browser-open").click();
  await dp.waitForFunction(() => document.querySelector('[data-testid="github-manifest-browser"]')?.getAttribute("data-outcome") === "failed", null, { timeout: 5000 });
  check(`${tag} 열지 못하면 그렇게 말하고 「다시 열기」가 선다`, (await textOf(dp, "github-manifest-browser")).includes("기본 브라우저를 열지 못했어요.") && (await textOf(dp, "github-manifest-browser-open")) === "다시 열기");
  await dp.getByTestId("github-paste").scrollIntoViewIfNeeded();
  await shot(dp, "2b-open-failed", tag);
  await dp.evaluate(() => { window.__openFails = false; });
  await dp.getByTestId("github-manifest-browser-open").click();
  await dp.waitForFunction(() => document.querySelector('[data-testid="github-manifest-browser"]')?.getAttribute("data-outcome") === "opened", null, { timeout: 5000 });
  check(`${tag} 다시 열면 같은 주소를 연다(새 state 를 만들지 않는다)`, (await dp.evaluate(() => window.__opened)).every((u) => u === url) && writes.filter((w) => w.includes("/manifest")).length === 1, writes.join("|"));

  // 3 핸드오프 화면(시스템 브라우저 = 세션 없는 새 컨텍스트)
  const system = await openSystemBrowser(browser, origin, scheme, viewport);
  const { context: browserCtx, page: sp, github } = system;
  await sp.goto(url, { waitUntil: "domcontentloaded" });
  await must(sp, "github-handoff-form");
  for (let i = 0; i < 40 && (await sp.evaluate(() => window.__autoSubmits.length)) === 0; i += 1) await sp.waitForTimeout(100);
  const auto = await sp.evaluate(() => window.__autoSubmits.slice());
  check(`${tag} 핸드오프: 로그인 화면이 아니다`, !(await has(sp, "login-email")) && !(await has(sp, "onboarding-welcome")));
  check(`${tag} 핸드오프: 읽은 즉시 폼을 자동 제출한다(한 번)`, auto.length === 1, `${auto.length}번`);
  check(`${tag} 핸드오프: 자동 제출은 등록 주소로 POST, 칸은 manifest 하나`, auto[0]?.action === REGISTRATION_URL && auto[0]?.method === "post" && auto[0]?.fields.join(",") === "manifest", JSON.stringify(auto[0] ?? null).slice(0, 200));
  check(`${tag} 핸드오프: 보내는 매니페스트는 서버가 만든 그대로`, JSON.stringify(JSON.parse(auto[0]?.manifest ?? "{}")) === JSON.stringify(MANIFEST));
  check(`${tag} 핸드오프: 폼이 noreferrer 다`, (auto[0]?.rel ?? "").includes("noreferrer"));
  const handoffHref = await sp.evaluate(() => location.href);
  check(`${tag} 핸드오프: 주소창에서 조각이 지워졌다`, handoffHref === `${FAKE_ORIGIN}/github/handoff`, handoffHref);
  const storage = await sp.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage), cookie: document.cookie }));
  check(`${tag} 핸드오프: 저장소·쿠키에 아무것도 쓰지 않았다`, storage.local.length === 0 && storage.session.length === 0 && storage.cookie === "", JSON.stringify(storage));
  const stored = await sp.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  check(`${tag} 핸드오프: 저장소 어디에도 state 가 없다`, !stored.includes(STATE) && !stored.includes("state="));
  // 폼의 action 은 state 를 담아야 GitHub 에 닿는다(DOM 에만 있고 어디에도 쓰이지 않는다). 사람 눈에 보이는 글자에는 없다.
  check(`${tag} 핸드오프: 화면 글자에 state 가 없다`, !(await sp.evaluate(() => document.body.innerText)).includes(STATE));
  check(`${tag} 핸드오프: 행선지·받는 서버·시한을 보여 준다`, (await textOf(sp, "github-handoff-form")).includes("yeomyeonggeori 조직") && (await textOf(sp, "github-handoff-form")).includes("oort.yeomyeonggeori.test") && (await textOf(sp, "github-handoff-form")).includes("60분 안에"));
  await shot(sp, "3-handoff", tag);
  check(`${tag} 가로 넘침 0 (핸드오프)`, (await overflowX(sp)) === 0);
  await sp.keyboard.press("Tab");
  check(`${tag} 핸드오프: 키보드로 수동 버튼에 닿는다`, await sp.evaluate(() => document.activeElement?.getAttribute("data-testid") === "github-handoff-submit"));
  // 자동 제출이 막히는 브라우저의 폴백: 수동 버튼은 진짜 POST 가 된다.
  check(`${tag} 핸드오프: 자동 제출은 막혀 있는 동안 네트워크에 나가지 않았다`, github.hits.length === 0);
  await sp.evaluate(() => { window.__blockAutoSubmit = false; });
  await sp.getByTestId("github-handoff-submit").click();
  for (let i = 0; i < 40 && github.hits.length === 0; i += 1) await sp.waitForTimeout(100);
  check(`${tag} 수동 버튼: GitHub 로 POST 한 번`, github.hits.length === 1 && github.hits[0].method === "POST", JSON.stringify(github.hits.map((h) => h.method)));
  check(`${tag} 수동 버튼: 등록 주소가 그대로다`, github.hits[0]?.url === REGISTRATION_URL);
  const bodyParams = new URLSearchParams(github.hits[0]?.body ?? "");
  check(`${tag} 수동 버튼: 본문은 manifest 한 칸이고 서버가 만든 매니페스트다`, [...bodyParams.keys()].join(",") === "manifest" && JSON.stringify(JSON.parse(bodyParams.get("manifest") ?? "{}")) === JSON.stringify(MANIFEST));
  check(`${tag} 수동 버튼: GitHub 에 Referer 를 보내지 않았다`, github.hits[0]?.referer === null, String(github.hits[0]?.referer));

  // GitHub 가 「Create GitHub App」 뒤 서버 콜백을 거쳐 이 브라우저를 돌려보낸다
  world.status = statusRegistered();
  world.overview = { ...world.overview, appRegistered: true };

  // 4 착지
  await sp.goto(`${FAKE_ORIGIN}/?githubApp=created`, { waitUntil: "domcontentloaded" });
  await sp.getByTestId("github-public-return").waitFor({ timeout: 25_000 });
  check(`${tag} 착지: 로그인 안 된 브라우저가 결과 문장을 말한다`, (await textOf(sp, "github-public-return-title")) === "GitHub 앱을 만들었어요. 이제 워크스페이스마다 연결할 수 있어요.");
  check(`${tag} 착지: 「oort 앱으로 돌아가세요」`, (await textOf(sp, "github-public-return-back")) === "oort 앱으로 돌아가세요.");
  check(`${tag} 착지: 로그인 화면이 아니다`, !(await has(sp, "login-email")) && !(await has(sp, "onboarding-welcome")));
  check(`${tag} 착지: 주소에서 단어가 지워졌다`, (await sp.evaluate(() => location.search)) === "");
  check(`${tag} 착지: 화면에 state·code 가 없다`, !(await sp.content()).includes(STATE) && !(await sp.content()).includes("code="));
  await shot(sp, "4-landing", tag);
  check(`${tag} 가로 넘침 0 (착지)`, (await overflowX(sp)) === 0);
  await sp.keyboard.press("Tab");
  check(`${tag} 착지: 키보드로 로그인 길에 닿는다`, await sp.evaluate(() => document.activeElement?.getAttribute("data-testid") === "github-public-return-login"));
  await sp.goto(`${FAKE_ORIGIN}/?githubApp=state_invalid`, { waitUntil: "domcontentloaded" });
  await sp.getByTestId("github-public-return").waitFor({ timeout: 25_000 });
  check(`${tag} 막힌 단어: 이유와 다음 걸음과 돌아가라는 말`, (await textOf(sp, "github-public-return")).includes("등록 시간이 지났거나 이미 쓴 등록이에요.") && (await textOf(sp, "github-public-return")).includes("다시 눌러 주세요") && (await textOf(sp, "github-public-return-back")) === "oort 앱으로 돌아가세요.");
  await shot(sp, "4b-landing-stop", tag);
  await browserCtx.close();

  // 5 데스크탑 창이 앞으로 돌아온다
  await dp.evaluate(() => window.dispatchEvent(new Event("focus")));
  await dp.getByTestId("github-app-registered").waitFor({ timeout: 10_000 });
  check(`${tag} 돌아온 창: 포커스만으로 「등록됨」으로 바뀐다`, (await textOf(dp, "github-app-registered")).includes("등록됨") && !(await has(dp, "github-manifest-browser")));
  check(`${tag} 돌아온 창: 등록 폼이 사라졌다`, !(await has(dp, "github-app-register")));
  await dp.getByTestId("github-app-registered").scrollIntoViewIfNeeded();
  await shot(dp, "5-registered", tag);
  check(`${tag} 가로 넘침 0 (등록됨)`, (await overflowX(dp)) === 0);

  // 6 설치도 기본 브라우저로
  await dp.getByTestId("github-link-start").waitFor({ timeout: 10_000 });
  await dp.getByTestId("github-link-start").click();
  await dp.getByTestId("github-link-open").waitFor({ timeout: 10_000 });
  const before = await dp.evaluate(() => window.__opened.length);
  await dp.getByTestId("github-link-open").click();
  const after = await dp.evaluate(() => window.__opened.slice());
  check(`${tag} 설치: 「GitHub에서 설치하기」도 기본 브라우저로 연다`, after.length === before + 1 && after.at(-1)?.startsWith(`https://github.com/apps/${APP.slug}/installations/new`), after.at(-1));
  await dp.getByTestId("github-link-ready").scrollIntoViewIfNeeded();
  await shot(dp, "6-install-link", tag);
  await desktop.context.close();
}

// ---- 변경 전 번들의 공개 두 화면 ---------------------------------------------------------------------------
async function sceneBeforePublic(browser, origin, scheme, viewport) {
  const tag = `${viewport.width}-${scheme}`;
  resetWorld();
  const { context: ctx, page } = await openSystemBrowser(browser, origin, scheme, viewport);
  await page.addInitScript((server) => { try { localStorage.setItem("momo.web.server.v1", server); } catch { /* */ } }, FAKE_ORIGIN);
  await page.goto(handwrittenHandoffUrl(), { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  check(`${tag} 전: 핸드오프 주소는 로그인(연결) 화면이다`, (await has(page, "onboarding-welcome")) || (await has(page, "login-email")));
  check(`${tag} 전: 핸드오프 폼이 없다`, !(await has(page, "github-handoff-form")));
  await shot(page, "3-handoff", tag);
  await page.goto(`${FAKE_ORIGIN}/?githubApp=created`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  check(`${tag} 전: 착지 주소도 로그인(연결) 화면이다`, (await has(page, "onboarding-welcome")) || (await has(page, "login-email")));
  check(`${tag} 전: 결과 문장이 없다`, !(await page.content()).includes("GitHub 앱을 만들었어요"));
  await shot(page, "4-landing", tag);
  await ctx.close();
}

async function main() {
  if (!existsSync(resolve(DIST_DIR, "index.html"))) throw new Error(`${DIST_DIR}/index.html is missing. Build first.`);
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({
    webRoot: WEB_ROOT,
    port: PORT,
    portEnvVar: "CAPTURE_PORT",
    extraArgs: ["--outDir", DIST_DIR],
  });
  const browser = await chromium.launch();
  try {
    for (const scheme of ["light", "dark"]) {
      const desktopView = { width: 1440, height: 900 };
      await sceneCard(browser, preview.origin, scheme, desktopView);
      await sceneFlow(browser, preview.origin, scheme, desktopView);
      if (BEFORE) await sceneBeforePublic(browser, preview.origin, scheme, desktopView);
    }
    // 공개 두 화면은 폰 폭에서도 읽혀야 한다(시스템 브라우저가 폰일 수도 있다).
    if (!BEFORE) {
      for (const scheme of ["light", "dark"]) {
        const view = { width: 390, height: 844 };
        const tag = `${view.width}-${scheme}`;
        resetWorld();
        const { context: ctx, page, github } = await openSystemBrowser(browser, preview.origin, scheme, view);
        await page.goto(handwrittenHandoffUrl(), { waitUntil: "domcontentloaded" });
        await must(page, "github-handoff-form");
        for (let i = 0; i < 40 && (await page.evaluate(() => window.__autoSubmits.length)) === 0; i += 1) await page.waitForTimeout(100);
        check(`${tag} 핸드오프(폰 폭): 자동 제출 한 번`, (await page.evaluate(() => window.__autoSubmits.length)) === 1);
        await shot(page, "3-handoff", tag);
        check(`${tag} 가로 넘침 0 (핸드오프)`, (await overflowX(page)) === 0);
        check(`${tag} 핸드오프(폰 폭): 막아 둔 동안 네트워크에 나가지 않았다`, github.hits.length === 0);
        await page.goto(`${FAKE_ORIGIN}/?githubInstall=requested`, { waitUntil: "domcontentloaded" });
        await must(page, "github-public-return");
        await shot(page, "4-landing", tag);
        check(`${tag} 가로 넘침 0 (착지)`, (await overflowX(page)) === 0);
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
    await preview.stop?.();
  }
  writeFileSync(resolve(OUT_DIR, "report.json"), `${JSON.stringify({ mode: BEFORE ? "before" : "after", results }, null, 2)}\n`);
  if (!BEFORE && failures.length > 0) {
    console.error(`\n${failures.length}개 단언 실패`);
    process.exit(1);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
