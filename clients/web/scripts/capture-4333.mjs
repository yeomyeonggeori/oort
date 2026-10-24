#!/usr/bin/env node
// =============================================================================
// CAPTURE (#4333): GitHub 앱 만들기 조직 이름 칸 · 본인 확인 예고 (웹·데스크탑).
//
//   npm run build && OUT_DIR=<dir> node scripts/capture-4333.mjs
//
// 서버(#4084, PR #4087)가 이 트리에 없으므로 백엔드는 없다: `/v1/**` 고정 응답이고 모양은 PR #4087의
// openapi 를 옮긴 것이다(runtime-unverified). capture-3955.mjs 의 세계를 그대로 쓴다.
//
// 장면 (라이트·다크 x 1440·390):
//   A 복귀 linked_elsewhere   ?githubInstall=linked_elsewhere 가 GitHub 알림 화면의 막힌 문장이 된다
//   B 구독 다시 확인 필요     허브 구독 목록의 「다시 확인 필요」 줄 + 확인 문장
//   C 채널 다이얼로그 재구독  확인하면 confirmPrivate:true 한 번, 그 전에는 POST 0번
//   D 알림 줄(작성자 id)      github_author_member_id 가 일치할 때만 줄이 서고, 같은 이름의 사람 글에는 없다
// 단언이 하나라도 실패하면 종료 코드 1이다.
// =============================================================================

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(WEB_ROOT, "../..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/4333");
const PORT = Number(process.env.CAPTURE_PORT || 5255);

const wire = (name) => JSON.parse(readFileSync(resolve(REPO_ROOT, "server/Fixtures/plugin-wire", name), "utf8"));
const CATALOG = wire("catalog.json");
const GITHUB_DETAIL = wire("detail-github.json");

const workspaceId = "00000000-0000-7000-8000-000000000001";
const me = "00000000-0000-7000-8000-000000000101";
const haneul = "00000000-0000-7000-8000-000000000102";
const githubAgent = "00000000-0000-7000-8000-000000000a01";
const imposter = "00000000-0000-7000-8000-000000000a09";
const marketing = "00000000-0000-7000-8000-000000000201";
const billing = "00000000-0000-7000-8000-000000000202";
const BASE_MS = Date.parse("2026-10-19T02:10:00.000Z");
const channels = [
  { id: marketing, workspaceId, kind: "public", name: "마케팅", muted: false },
  { id: billing, workspaceId, kind: "private", name: "결제-개발", muted: false },
];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: me, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: "ws://capture-4333.invalid/connection/websocket",
};
const person = (id, displayName, handle, role, kind = "human") => ({
  id, workspaceId, kind, status: "active", role, displayName, handle, channelCount: 2,
  channelIds: [marketing, billing], capabilities: [], createdAtMs: 0, updatedAtMs: 0,
});
const roster = [person(me, "곽성재", "seongjae", "owner"), person(haneul, "김하늘", "haneul", "member"), person(githubAgent, "GitHub", "github", "member", "agent"), person(imposter, "GitHub", "gh-fan", "member")];

// ---- GitHub 쪽 세계 (PR #4070 소스에서 옮긴 모양) -------------------------------------------
const PERMISSIONS = { metadata: "read", issues: "read", pull_requests: "read", checks: "read", contents: "read" };
const statusUnregistered = (publicAddress = true) => ({ masterKeyConfigured: true, publicAddressConfigured: publicAddress, configured: false, permissions: PERMISSIONS, events: ["pull_request", "issues"] });
const INSTALLATIONS = [
  {
    installationId: 4001, accountLogin: "yeomyeonggeori", accountType: "Organization", repositorySelection: "selected", suspended: false,
    repositories: [
      { repoId: 11, fullName: "yeomyeonggeori/oort", private: false },
      { repoId: 12, fullName: "yeomyeonggeori/billing-internal", private: true },
      { repoId: 13, fullName: "yeomyeonggeori/landing", private: false },
    ],
  },
  { installationId: 4002, accountLogin: "dawn-labs", accountType: "Organization", repositorySelection: "all", suspended: false, repositories: [] },
];
const SUBSCRIPTIONS = [
  { id: "s-oort", channelId: marketing, installationId: 4001, repository: "yeomyeonggeori/oort", repoId: 11, features: ["pulls", "issues", "releases"], active: true, privateConfirmed: false, needsReconfirm: false },
  { id: "s-billing", channelId: billing, installationId: 4001, repository: "yeomyeonggeori/billing-internal", repoId: 12, features: ["pulls", "checks"], active: true, privateConfirmed: true, needsReconfirm: false },
];
const FEATURES = ["pulls", "issues", "reviews", "comments", "checks", "commits", "releases"];
const UNLINKED = [
  { installationId: 9001, accountLogin: "mirae-studio", accountType: "Organization", repositorySelection: "selected", suspended: false, repositoryCount: 3 },
  { installationId: 9002, accountLogin: "haneul-kim", accountType: "User", repositorySelection: "all", suspended: false, repositoryCount: 0 },
];

const world = {
  statusMode: "operator", // operator | denied
  status: statusUnregistered(),
  unlinked: UNLINKED,
  overviewMode: "ok", // ok | absent | error | slow
  overview: { appRegistered: true, installations: INSTALLATIONS, subscriptions: SUBSCRIPTIONS, features: FEATURES, defaultFeatures: ["pulls", "issues"] },
  oldServer: false,
};
const writes = [];

// ---- 알림 메시지 ----------------------------------------------------------------------
const pr = (n, title, who) => `yeomyeonggeori/oort · @${who}님이 PR을 열었어요\n[#${n} ${title}](https://github.com/yeomyeonggeori/oort/pull/${n})`;
const NOTIFICATIONS = [
  { id: "g1", author: githubAgent, body: pr(412, "알림 설정에서 방해 금지 기한 고르기", "haneul"), props: { source: "github", github_author_member_id: githubAgent, github_event: "pull_request", github_action: "opened", github_repository: "yeomyeonggeori/oort", github_url: "https://github.com/yeomyeonggeori/oort/pull/412" } },
  { id: "g2", author: githubAgent, body: "yeomyeonggeori/oort · @minjun님이 이슈를 닫았어요\n[#398 푸시 알림이 두 번 와요](https://github.com/yeomyeonggeori/oort/issues/398)", props: { source: "github", github_author_member_id: githubAgent, github_event: "issues", github_action: "closed", github_repository: "yeomyeonggeori/oort", github_url: "https://github.com/yeomyeonggeori/oort/issues/398" } },
  { id: "g3", author: githubAgent, body: "yeomyeonggeori/oort · @seongjae님이 릴리스를 게시했어요\n[v0.4.2 폰 알림 걷기 수리](https://github.com/yeomyeonggeori/oort/releases/tag/v0.4.2)", props: { source: "github", github_author_member_id: githubAgent, github_event: "release", github_action: "published", github_repository: "yeomyeonggeori/oort", github_url: "https://github.com/yeomyeonggeori/oort/releases/tag/v0.4.2" } },
  { id: "g4", author: haneul, body: "412번 PR, 오늘 안에 리뷰 부탁해요.", props: undefined },
  // 표시 이름이 「GitHub」인 사람이 알림 props 를 흉내 낸 글: id가 달라서 줄이 서지 않는다.
  { id: "g5", author: imposter, body: "yeomyeonggeori/oort · @someone님이 PR을 열었어요", props: { source: "github", github_author_member_id: githubAgent, github_event: "pull_request", github_action: "opened", github_repository: "yeomyeonggeori/oort", github_url: "https://github.com/yeomyeonggeori/oort/pull/999" } },
];
function messagesFor(channelId) {
  if (channelId !== marketing) return [];
  return NOTIFICATIONS.map((row, index) => ({
    id: row.id, channelId, seq: 3955 + index, hlcTs: BASE_MS + index * 60_000, hlcCount: 0, authorMemberId: row.author, type: "text",
    body: row.body, state: "sent", ...(row.props && !world.oldServer ? { props: row.props } : {}), createdAtMs: BASE_MS + index * 60_000,
  }));
}

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}
const apiError = (route, status, code, message = "capture") => json(route, { error: { code, message } }, status);

async function installRoutes(context) {
  await context.route("**/v1/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname;
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId: me });
    }
    // ---- GitHub (PR #4070) ----
    if (path.startsWith("/v1/integrations/github/")) {
      if (world.oldServer) return apiError(route, 404, "not_found");
      if (path === "/v1/integrations/github/app" && method === "GET") {
        return world.statusMode === "denied" ? apiError(route, 403, "forbidden") : json(route, world.status);
      }
      if (path === "/v1/integrations/github/app/manifest") {
        writes.push(`${method} ${path} ${request.postData() ?? ""}`);
        return json(route, {
          schema: "oort.github_app.manifest.v1",
          registrationUrl: "https://github.com/organizations/yeomyeonggeori/settings/apps/new?state=cap-state",
          manifest: { name: "oort-team", url: "https://oort.example.test", redirect_url: "https://oort.example.test/v1/integrations/github/app/callback", hook_attributes: { url: "https://oort.example.test/v1/integrations/github/webhook" }, default_permissions: PERMISSIONS, public: false },
          expiresInSeconds: 3600,
        });
      }
      if (path === "/v1/integrations/github/installations" && method === "GET") return json(route, { installations: world.unlinked });
      return apiError(route, 404, "not_found");
    }
    if (path === `/v1/workspaces/${workspaceId}/github` && method === "GET") {
      if (world.oldServer || world.overviewMode === "absent") return apiError(route, 404, "not_found");
      if (world.overviewMode === "error") return apiError(route, 500, "internal");
      if (world.overviewMode === "slow") await new Promise((r) => setTimeout(r, 4000));
      return json(route, world.overview);
    }
    if (path === `/v1/workspaces/${workspaceId}/github/link` && method === "POST") {
      writes.push(`POST ${path}`);
      return json(route, { installUrl: "https://github.com/apps/oort-yeomyeonggeori/installations/new?state=cap-install-state", expiresInSeconds: 600 });
    }
    if (path === `/v1/workspaces/${workspaceId}/github/subscriptions` && method === "POST") {
      const body = JSON.parse(request.postData() ?? "{}");
      writes.push(`POST ${path} ${JSON.stringify(body)}`);
      return json(route, { id: "s-new", channelId: body.channelId, installationId: body.installationId, repository: body.repository, repoId: 12, features: body.features, active: true, privateConfirmed: body.confirmPrivate === true, needsReconfirm: false });
    }
    // ---- 워크스페이스 공통 ----
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
    for (const channel of channels) {
      if (path.includes(`/channels/${channel.id}/messages`)) return json(route, { messages: messagesFor(channel.id) });
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
          if (c.connect) return { id: c.id, connect: { client: "capture-4333", version: "6" } };
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
  if (!ok) failures.push(name);
}
const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const textOf = async (page, testId) => ((await page.getByTestId(testId).first().textContent()) ?? "").replace(/\s+/g, " ").trim();

async function open(browser, origin, scheme, viewport, hash, search = "", desktop = false) {
  const context = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion: "reduce", serviceWorkers: "block", deviceScaleFactor: 2 });
  await installRoutes(context);
  const page = await context.newPage();
  await installRealtime(page);
  if (desktop) await page.addInitScript(() => { window.__opened = []; window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } }, transformCallback: () => 1, unregisterCallback() {}, convertFileSrc: (p) => p, async invoke(cmd, args) { if (cmd === "open_external_url" || cmd.includes("open")) { window.__opened.push(args); return null; } if (cmd === "keychain_available") return true; if (cmd === "keychain_store_refresh_token") { window.__kc = true; return null; } if (cmd === "keychain_refresh_token_handle") return window.__kc ? "shell:00000000000000000000000000000001" : null; if (cmd === "keychain_clear_refresh_token") { window.__kc = false; return null; } if (cmd === "deep_link_take_pending" || cmd === "detect_hosted_agents") return []; if (cmd === "detect_local_harnesses") return { harnesses: [] }; if (cmd === "app_version") return "0.1.36"; if (cmd === "notification_permission") return "denied"; if (cmd.startsWith("plugin:")) return 1; return null; } }; });
  await page.addInitScript((server) => { try { localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ } }, origin);
  await page.goto(`${origin}/${search}`, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("nav-ai").waitFor({ timeout: 20_000 });
  if (hash) await page.evaluate((h) => { location.hash = h; }, hash);
  return { context, page };
}

const shot = async (page, name, tag) => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: resolve(OUT_DIR, `c4333-${name}-${tag}.png`) });
};

function resetWorld() {
  world.statusMode = "operator";
  world.status = statusUnregistered();
  world.unlinked = UNLINKED;
  world.overviewMode = "ok";
  world.overview = { appRegistered: true, installations: INSTALLATIONS, subscriptions: SUBSCRIPTIONS, features: FEATURES, defaultFeatures: ["pulls", "issues"] };
  world.oldServer = false;
  writes.length = 0;
}

async function openGithubDialog(page) {
  await page.getByTestId("channel-title-menu").waitFor({ timeout: 25_000 });
  await page.getByTestId("channel-title-menu").click();
  await page.getByTestId("channel-github-notifications").click();
  await page.getByTestId("channel-github-dialog").waitFor({ timeout: 10_000 });
}



const ORG_INPUT = "github-org-input";
async function paneReady(page) {
  try { await page.getByTestId("github-app-register").waitFor({ timeout: 25_000 }); } catch (e) { await page.screenshot({ path: resolve(OUT_DIR, "debug.png") }); console.log((await page.locator("body").innerText()).slice(0, 600)); throw e; }
}
async function scenes(browser, origin, scheme, viewport) {
  const tag = `${viewport.width}-${scheme}`;
  for (const desktop of [false, true]) {
    const surf = desktop ? "desktop" : "web";
    resetWorld();
    {
      const { context, page } = await open(browser, origin, scheme, viewport, "/ai/external/github", "", desktop);
      await paneReady(page);
      const input = page.getByTestId(ORG_INPUT);
      check(`${surf} ${tag} A 예시 글자는 placeholder 이고 값은 비어 있다`, (await input.inputValue()) === "" && ((await input.getAttribute("placeholder")) ?? "").startsWith("예: "));
      check(`${surf} ${tag} A 본인 확인 예고가 만들기 앞에 있다`, (await page.getByTestId("github-identity-notice").count()) === 1);
      await shot(page, `A-empty-${surf}`, tag);
      writes.length = 0;
      await page.getByTestId("github-register-start").click();
      await page.waitForTimeout(200);
      const err = ((await page.getByTestId("github-app-register").textContent()) ?? "");
      check(`${surf} ${tag} B 빈 값이면 「조직 이름을 적어 주세요」, 요청 0번`, err.includes("조직 이름을 적어 주세요") && writes.length === 0, `${writes.join("|")}`);
      await shot(page, `B-error-${surf}`, tag);
      await input.fill("-bad-");
      await page.getByTestId("github-register-start").click();
      await page.waitForTimeout(200);
      check(`${surf} ${tag} B 잘못된 값이면 요청 0번`, writes.length === 0);
      await input.fill("my-team");
      await page.getByTestId("github-register-start").click();
      await page.waitForTimeout(500);
      check(`${surf} ${tag} C 유효한 값이면 시작 요청 1번`, writes.length === 1 && writes[0].includes("my-team"), writes.join("|"));
      await page.getByTestId(desktop ? "github-manifest-browser" : "github-manifest-handoff").first().waitFor({ timeout: 5000 }).catch(() => {});
      const idNotice = page.getByText("GitHub가 본인 확인을 한 번 요구할 수 있어요").last();
      check(`${surf} ${tag} C 카드 안에 본인 확인 예고가 선다`, (await idNotice.count()) >= 1 && (await page.getByTestId(desktop ? "github-manifest-browser" : "github-manifest-handoff").count()) === 1);
      await page.getByTestId(desktop ? "github-manifest-browser" : "github-manifest-handoff").scrollIntoViewIfNeeded().catch(() => {});
      await shot(page, `C-handoff-card-${surf}`, tag);
      check(`${surf} ${tag} 가로 넘침 0`, (await overflowX(page)) === 0);
      await context.close();
    }
  }
  // D 브라우저 안내 화면(/github/handoff)
  {
    const manifest = { name: "oort-team", url: origin, redirect_url: `${origin}/v1/integrations/github/app/callback`, hook_attributes: { url: `${origin}/v1/integrations/github/webhook` }, default_permissions: PERMISSIONS, public: false };
    const payload = Buffer.from(JSON.stringify({ v: 1, u: "https://github.com/organizations/my-team/settings/apps/new?state=cap-state", m: manifest, e: 3600 })).toString("base64url");
    const context = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion: "reduce", serviceWorkers: "block", deviceScaleFactor: 2 });
    await installRoutes(context);
    await context.addInitScript(() => { HTMLFormElement.prototype.submit = function () { window.__autoSubmitted = true; }; }); // 실제 GitHub로 보내지 않는다
    const page = await context.newPage();
    await page.goto(`${origin}/github/handoff#${payload}`, { waitUntil: "domcontentloaded" });
    try { await page.getByTestId("github-handoff-submit").waitFor({ timeout: 15_000 }); } catch (e) { console.log((await page.locator("body").innerText()).slice(0, 500), page.url().slice(0, 80)); throw e; }
    check(`${tag} D 안내 화면에 본인 확인 예고`, (await page.getByTestId("github-handoff-identity").count()) === 1);
    await shot(page, "D-handoff-page", tag);
    check(`${tag} D 가로 넘침 0`, (await overflowX(page)) === 0);
    await context.close();
  }
}

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) throw new Error("dist/ is missing. Run npm run build first.");
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  try {
    for (const [scheme, viewport] of [
      ["light", { width: 1440, height: 900 }],
      ["dark", { width: 1440, height: 900 }],
    ]) {
      await scenes(browser, preview.origin, scheme, viewport);
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
