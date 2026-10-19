#!/usr/bin/env node
// =============================================================================
// CAPTURE (#3955, ADR-0205 D10, U-GH1): GitHub 알림 화면 전체.
//
//   npm run build && OUT_DIR=<dir> node scripts/capture-3955.mjs
//
// 서버(#3954, PR #4070)가 이 트리에 없으므로 백엔드는 없다: `/v1/**` 고정 응답이고, GitHub 쪽 라우트의
// 모양은 PR #4070의 서버 소스를 옮긴 것이다(runtime-unverified). 실제 GitHub 왕복은 없다.
//
// 장면 (라이트·다크 x 1440·390):
//   1 운영자 등록      「GitHub 앱 만들기」 폼 + 권한 문장
//   2 등록 넘김        조직 이름을 적고 누른 뒤의 GitHub 로 가는 폼(매니페스트는 비밀이 아니다)
//   3 수신 실패        앱은 있는데 공개 주소가 없다: 「공개 주소가 없어 GitHub 알림을 받을 수 없어요」
//   4 운영자 구역      등록된 앱 + 연결 안 된 설치
//   5 워크스페이스 연결 계정이 없을 때 「GitHub 연결」 → GitHub 로 가는 링크
//   6 워크스페이스 목록 연결된 계정 둘 + 구독 목록
//   7 채널 구독        채널 ⋮ › GitHub 알림 (구독 하나 + 폼)
//   8 비공개 확인      공개 채널에 비공개 저장소: 확인 장면, 이 시점에 구독 POST 는 0번
//   9 알림 메시지      PR 열림·이슈 닫힘·릴리스·체크, 「GitHub 알림」 아랫줄
//  10 앱 카드 두 얼굴  「앱」 목록 줄의 칩 둘 + 상세의 두 얼굴
//  11 돌아온 길        ?githubInstall=state_missing 이 화면 문장이 된다
//  12 옛 서버          GitHub 라우트가 404: 줄도 항목도 아랫줄도 없다 (1440 라이트)
//  13 네 상태          채널 다이얼로그의 읽는 중·오류·오프라인 (1440 라이트)
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
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/3955");
const PORT = Number(process.env.CAPTURE_PORT || 5255);
const ONLY = process.env.ONLY ?? ""; // hub | channel | old (비우면 전부)

const wire = (name) => JSON.parse(readFileSync(resolve(REPO_ROOT, "server/Fixtures/plugin-wire", name), "utf8"));
const CATALOG = wire("catalog.json");
const GITHUB_DETAIL = wire("detail-github.json");

const workspaceId = "00000000-0000-7000-8000-000000000001";
const me = "00000000-0000-7000-8000-000000000101";
const haneul = "00000000-0000-7000-8000-000000000102";
const githubAgent = "00000000-0000-7000-8000-000000000a01";
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
  realtimeWebSocketUrl: "ws://capture-3955.invalid/connection/websocket",
};
const person = (id, displayName, handle, role, kind = "human") => ({
  id, workspaceId, kind, status: "active", role, displayName, handle, channelCount: 2,
  channelIds: [marketing, billing], capabilities: [], createdAtMs: 0, updatedAtMs: 0,
});
const roster = [person(me, "곽성재", "seongjae", "owner"), person(haneul, "김하늘", "haneul", "member"), person(githubAgent, "GitHub", "github", "member", "agent")];

// ---- GitHub 쪽 세계 (PR #4070 소스에서 옮긴 모양) -------------------------------------------
const PERMISSIONS = { metadata: "read", issues: "read", pull_requests: "read", checks: "read", contents: "read" };
const APP = {
  appId: 912345, slug: "oort-yeomyeonggeori", clientId: "Iv1.capture", ownerLogin: "yeomyeonggeori", ownerType: "Organization",
  source: "manifest", createdAtMs: Date.parse("2026-10-18T09:00:00Z"), rotationWindowOpen: false,
  installUrl: "https://github.com/apps/oort-yeomyeonggeori/installations/new",
};
const statusUnregistered = (publicAddress = true) => ({ masterKeyConfigured: true, publicAddressConfigured: publicAddress, configured: false, permissions: PERMISSIONS, events: ["pull_request", "issues"] });
const statusRegistered = (publicAddress = true) => ({ ...statusUnregistered(publicAddress), configured: true, app: APP });
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
  { id: "s-oort", channelId: marketing, installationId: 4001, repository: "yeomyeonggeori/oort", repoId: 11, features: ["pulls", "issues", "releases"], active: true, privateConfirmed: false },
  { id: "s-billing", channelId: billing, installationId: 4001, repository: "yeomyeonggeori/billing-internal", repoId: 12, features: ["pulls", "checks"], active: true, privateConfirmed: true },
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
  { id: "g1", author: githubAgent, body: pr(412, "알림 설정에서 방해 금지 기한 고르기", "haneul"), props: { source: "github", github_event: "pull_request", github_action: "opened", github_repository: "yeomyeonggeori/oort", github_url: "https://github.com/yeomyeonggeori/oort/pull/412" } },
  { id: "g2", author: githubAgent, body: "yeomyeonggeori/oort · @minjun님이 이슈를 닫았어요\n[#398 푸시 알림이 두 번 와요](https://github.com/yeomyeonggeori/oort/issues/398)", props: { source: "github", github_event: "issues", github_action: "closed", github_repository: "yeomyeonggeori/oort", github_url: "https://github.com/yeomyeonggeori/oort/issues/398" } },
  { id: "g3", author: githubAgent, body: "yeomyeonggeori/oort · @seongjae님이 릴리스를 게시했어요\n[v0.4.2 폰 알림 걷기 수리](https://github.com/yeomyeonggeori/oort/releases/tag/v0.4.2)", props: { source: "github", github_event: "release", github_action: "published", github_repository: "yeomyeonggeori/oort", github_url: "https://github.com/yeomyeonggeori/oort/releases/tag/v0.4.2" } },
  { id: "g4", author: haneul, body: "412번 PR, 오늘 안에 리뷰 부탁해요.", props: undefined },
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
          manifest: { name: "oort-yeomyeonggeori", url: "https://oort.example.test", default_permissions: PERMISSIONS, public: false },
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
      return json(route, { id: "s-new", channelId: body.channelId, installationId: body.installationId, repository: body.repository, repoId: 12, features: body.features, active: true, privateConfirmed: body.confirmPrivate === true });
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
          if (c.connect) return { id: c.id, connect: { client: "capture-3955", version: "6" } };
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

async function open(browser, origin, scheme, viewport, hash, search = "") {
  const context = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion: "reduce", serviceWorkers: "block", deviceScaleFactor: 2 });
  await installRoutes(context);
  const page = await context.newPage();
  await installRealtime(page);
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
  await page.screenshot({ path: resolve(OUT_DIR, `c3955-${name}-${tag}.png`) });
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

async function hubScenes(browser, origin, scheme, viewport) {
  const tag = `${viewport.width}-${scheme}`;
  // 1·2 운영자 등록
  resetWorld();
  {
    const { context, page } = await open(browser, origin, scheme, viewport, "/ai/external/github");
    await page.getByTestId("github-app-register").waitFor({ timeout: 25_000 });
    check(`${tag} 등록: 권한 다섯 줄과 쓰기 없음을 말한다`, (await textOf(page, "github-app-register")).includes("쓰기 권한은 없어요"));
    await shot(page, "1-operator-register", tag);
    await page.getByTestId("github-org-input").fill("yeomyeonggeori");
    await page.getByTestId("github-register-start").click();
    await page.getByTestId("github-manifest-handoff").waitFor({ timeout: 10_000 });
    const action = await page.getByTestId("github-manifest-handoff").getAttribute("action");
    check(`${tag} 넘김 폼은 github.com 의 https`, action?.startsWith("https://github.com/"), String(action));
    check(`${tag} 매니페스트 요청은 조직 이름을 보냈다`, writes.some((w) => w.includes('"organization":"yeomyeonggeori"')), writes.join("|"));
    await page.getByTestId("github-manifest-handoff").scrollIntoViewIfNeeded();
    await shot(page, "2-operator-handoff", tag);
    check(`${tag} 가로 넘침 0 (등록)`, (await overflowX(page)) === 0);
    await context.close();
  }
  // 3 수신 실패
  resetWorld();
  world.status = statusRegistered(false);
  {
    const { context, page } = await open(browser, origin, scheme, viewport, "/ai/external/github");
    await page.getByTestId("github-receive-failed").waitFor({ timeout: 25_000 });
    const line = await textOf(page, "github-receive-failed");
    check(`${tag} 수신 실패 줄: doctor 와 같은 말`, line.includes("GitHub 수신 실패") && line.includes("공개 주소가 없어 GitHub 알림을 받을 수 없어요"), line);
    check(`${tag} 수신 실패 줄: 다운 중 알림이 사라진다는 말을 숨기지 않는다`, line.includes("다시 오지 않아요"), line);
    await page.getByTestId("github-receive-failed").scrollIntoViewIfNeeded();
    await shot(page, "3-receive-failed", tag);
    await context.close();
  }
  // 4 운영자 구역(등록됨)
  resetWorld();
  world.status = statusRegistered(true);
  {
    const { context, page } = await open(browser, origin, scheme, viewport, "/ai/external/github");
    await page.getByTestId("github-unlinked").waitFor({ timeout: 25_000 });
    check(`${tag} 등록된 앱: 받을 수 있다고 말한다`, (await textOf(page, "github-receive-ok")).includes("알림을 보낼 수 있어요"));
    check(`${tag} 연결 안 된 설치 두 줄`, (await page.getByTestId("github-unlinked-row").count()) === 2);
    await shot(page, "4-operator-registered", tag);
    check(`${tag} 가로 넘침 0 (운영자)`, (await overflowX(page)) === 0);
    await context.close();
  }
  // 5 연결: 계정 없음 → 링크
  resetWorld();
  world.statusMode = "denied";
  world.overview = { appRegistered: true, installations: [], subscriptions: [], features: FEATURES, defaultFeatures: ["pulls", "issues"] };
  {
    const { context, page } = await open(browser, origin, scheme, viewport, "/ai/external/github");
    await page.getByTestId("github-no-installation").waitFor({ timeout: 25_000 });
    check(`${tag} 운영자가 아니면 운영자 구역이 없다`, (await page.getByTestId("github-operator").count()) === 0);
    await page.getByTestId("github-link-start").click();
    await page.getByTestId("github-link-ready").waitFor({ timeout: 10_000 });
    const href = await page.getByTestId("github-link-open").getAttribute("href");
    check(`${tag} 연결 링크는 github.com 설치 주소(state 포함)`, href?.startsWith("https://github.com/apps/") && href.includes("state="), String(href));
    check(`${tag} 설치 권고와 읽기 권한 문장`, (await textOf(page, "github-workspace")).includes("선택한 저장소만"));
    await shot(page, "5-connect-ready", tag);
    await context.close();
  }
  // 6 연결 목록 + 구독
  resetWorld();
  world.statusMode = "denied";
  {
    const { context, page } = await open(browser, origin, scheme, viewport, "/ai/external/github");
    await page.getByTestId("github-subscriptions").waitFor({ timeout: 25_000 });
    check(`${tag} 구독 줄에 채널 이름이 붙는다`, (await page.getByTestId("github-subscription-row").first().textContent()).includes("마케팅"));
    check(`${tag} 비공개 확인함 칩`, (await textOf(page, "github-subscriptions")).includes("비공개 확인함"));
    await shot(page, "6-workspace-list", tag);
    check(`${tag} 가로 넘침 0 (워크스페이스)`, (await overflowX(page)) === 0);
    await context.close();
  }
}

async function openGithubDialog(page) {
  await page.getByTestId("channel-title-menu").waitFor({ timeout: 25_000 });
  await page.getByTestId("channel-title-menu").click();
  await page.getByTestId("channel-github-notifications").click();
  await page.getByTestId("channel-github-dialog").waitFor({ timeout: 10_000 });
}

async function channelScenes(browser, origin, scheme, viewport) {
  const tag = `${viewport.width}-${scheme}`;
  resetWorld();
  // 7·8 채널 구독 + 비공개 확인
  {
    const { context, page } = await open(browser, origin, scheme, viewport, `/c/${marketing}`);
    await openGithubDialog(page);
    await page.getByTestId("github-subscribe-form").waitFor({ timeout: 10_000 });
    check(`${tag} 이 채널의 구독만 보인다`, (await page.getByTestId("github-subscription-row").count()) === 1);
    check(`${tag} 커밋·릴리스는 「선택」`, (await page.getByTestId("github-feature-commits").locator("xpath=ancestor::label").textContent()).includes("선택"));
    await shot(page, "7-subscribe-form", tag);
    await page.getByTestId("github-subscribe-repo").selectOption("yeomyeonggeori/billing-internal");
    writes.length = 0;
    await page.getByTestId("github-subscribe-submit").click();
    await page.getByTestId("github-private-confirm").waitFor({ timeout: 10_000 });
    check(`${tag} 비공개 확인 장면에서 구독 POST 는 0번 (수용 11)`, writes.filter((w) => w.includes("/github/subscriptions")).length === 0, writes.join("|"));
    await page.waitForTimeout(150);
    check(`${tag} 확인 장면의 초점은 안전한 쪽(취소)에서 시작한다`, await page.getByTestId("github-private-cancel").evaluate((el) => el === document.activeElement).catch(() => false));
    await page.getByTestId("github-private-confirm").scrollIntoViewIfNeeded();
    await shot(page, "8-subscribe-private-confirm", tag);
    // 취소 → 0번, 다시 → 확인 → 1번
    await page.getByTestId("github-private-cancel").click();
    check(`${tag} 취소하면 POST 0번`, writes.filter((w) => w.includes("/github/subscriptions")).length === 0);
    await page.getByTestId("github-subscribe-submit").click();
    await page.getByTestId("github-private-accept").click();
    await page.getByTestId("github-subscribe-done").waitFor({ timeout: 10_000 });
    const posts = writes.filter((w) => w.includes("/github/subscriptions"));
    check(`${tag} 확인한 뒤에만 confirmPrivate:true 한 번`, posts.length === 1 && posts[0].includes('"confirmPrivate":true'), posts.join("|"));
    check(`${tag} 가로 넘침 0 (다이얼로그)`, (await overflowX(page)) === 0);
    // 키보드: Esc 로 닫으면 ⋮ 로 포커스가 돌아온다
    await page.keyboard.press("Escape");
    await page.getByTestId("channel-github-dialog").waitFor({ state: "detached", timeout: 5000 });
    await page.waitForTimeout(200);
    check(`${tag} Esc 로 닫으면 포커스가 ⋮ 로 돌아온다`, await page.getByTestId("channel-title-menu").evaluate((el) => el === document.activeElement));
    await context.close();
  }
  // 9 알림 메시지
  resetWorld();
  {
    const { context, page } = await open(browser, origin, scheme, viewport, `/c/${marketing}`);
    await page.getByTestId("github-notice").first().waitFor({ timeout: 25_000 });
    check(`${tag} 알림 아랫줄 셋 (사람 글에는 없다)`, (await page.getByTestId("github-notice").count()) === 3, String(await page.getByTestId("github-notice").count()));
    const strip = await page.getByTestId("github-notice").first().getAttribute("aria-label");
    check(`${tag} 아랫줄 낭독`, strip === "GitHub 알림, yeomyeonggeori/oort, PR 열림", String(strip));
    const opener = page.getByTestId("github-notice-open").first();
    check(`${tag} 열기 링크는 https`, (await opener.getAttribute("href"))?.startsWith("https://github.com/"));
    await opener.focus();
    check(`${tag} 키보드: 열기 링크에 포커스`, await opener.evaluate((el) => el === document.activeElement));
    await shot(page, "9-notification", tag);
    check(`${tag} 가로 넘침 0 (알림)`, (await overflowX(page)) === 0);
    await context.close();
  }
  // 10 앱 카드 두 얼굴
  resetWorld();
  {
    const { context, page } = await open(browser, origin, scheme, viewport, "/ai/external/apps");
    await page.getByTestId("plugin-catalog-com.momo.plugins.github").waitFor({ timeout: 25_000 });
    check(`${tag} 목록 줄에 칩 둘`, (await page.getByTestId("plugin-catalog-com.momo.plugins.github").getByTestId("github-faces-chips").locator("span").count()) >= 2);
    await page.getByTestId("plugin-catalog-com.momo.plugins.github").click();
    await page.getByTestId("github-faces").waitFor({ timeout: 10_000 });
    const faces = await textOf(page, "github-faces");
    check(`${tag} 상세: 알림 · 팀 전체 · oort 서버가 받아요 / 도구 · 각자 에이전트`, faces.includes("알림 · 팀 전체 · oort 서버가 받아요") && faces.includes("도구 · 각자 에이전트"), faces);
    await page.getByTestId("github-faces").scrollIntoViewIfNeeded();
    await shot(page, "10-apps-faces", tag);
    check(`${tag} 가로 넘침 0 (앱)`, (await overflowX(page)) === 0);
    await context.close();
  }
  // 11 돌아온 길
  resetWorld();
  world.statusMode = "denied";
  {
    const { context, page } = await open(browser, origin, scheme, viewport, "", "?githubInstall=state_missing");
    await page.getByTestId("github-return").waitFor({ timeout: 25_000 });
    check(`${tag} state_missing 문장이 운영자 목록을 가리킨다`, (await textOf(page, "github-return")).includes("연결 안 된 설치"));
    check(`${tag} 주소에서 단어가 지워졌다`, !(await page.evaluate(() => location.search)).includes("githubInstall"));
    await shot(page, "11-return-state-missing", tag);
    await context.close();
  }
}

async function oldServerAndStates(browser, origin) {
  const viewport = { width: 1440, height: 900 };
  const tag = "1440-light";
  // 12 옛 서버
  resetWorld();
  world.oldServer = true;
  {
    const { context, page } = await open(browser, origin, "light", viewport, `/c/${marketing}`);
    await page.getByTestId("channel-title-menu").waitFor({ timeout: 25_000 });
    await page.waitForTimeout(800);
    check("옛 서버: 알림 아랫줄 없음", (await page.getByTestId("github-notice").count()) === 0);
    await page.getByTestId("channel-title-menu").click();
    await openDialogIfPresent(page, tag);
    await context.close();
  }
  // 13 네 상태
  for (const [mode, name] of [["slow", "loading"], ["error", "error"]]) {
    resetWorld();
    world.overviewMode = mode;
    const { context, page } = await open(browser, origin, "light", viewport, `/c/${marketing}`);
    await openGithubDialog(page);
    if (mode === "error") await page.getByTestId("channel-github-load").waitFor({ timeout: 10_000 });
    await shot(page, `13-state-${name}`, tag);
    if (mode === "error") check("오류 상태: 다시 시도가 있다", (await page.getByRole("button", { name: "다시 시도" }).count()) > 0);
    await context.close();
  }
  resetWorld();
  {
    const { context, page } = await open(browser, origin, "light", viewport, `/c/${marketing}`);
    await openGithubDialog(page);
    await page.getByTestId("github-subscribe-form").waitFor({ timeout: 10_000 });
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    await page.waitForTimeout(500);
    const label = await textOf(page, "github-subscribe-form");
    check("오프라인: 구독할 수 없다고 말한다", label.includes("연결이 끊겨 있어서"), label.slice(0, 200));
    await shot(page, "13-state-offline", tag);
    await context.setOffline(false);
    await context.close();
  }
  // 빈 상태(구독 0)
  resetWorld();
  world.overview = { ...world.overview, subscriptions: [] };
  {
    const { context, page } = await open(browser, origin, "light", viewport, `/c/${marketing}`);
    await openGithubDialog(page);
    await page.getByTestId("channel-github-empty").waitFor({ timeout: 10_000 });
    await shot(page, "13-state-empty", tag);
    await context.close();
  }
}

async function openDialogIfPresent(page, tag) {
  const present = (await page.getByTestId("channel-github-notifications").count()) > 0;
  if (present) {
    await page.getByTestId("channel-github-notifications").click();
    await page.getByTestId("channel-github-load-absent").waitFor({ timeout: 10_000 });
    check("옛 서버: 항목은 서고 눌러 보면 장애가 아니라 「받지 않아요」", (await textOf(page, "channel-github-load-absent")).includes("이 서버는 아직 GitHub 알림을 받지 않아요"));
    await shot(page, "12-old-server-dialog", tag);
  } else {
    check("옛 서버: 항목이 없다", true);
  }
  await page.keyboard.press("Escape");
  // 허브 목차는 서 있고, 열면 한 문장으로 접힌다(서버 판정은 첫 읽기에서).
  await page.evaluate(() => { location.hash = "/ai/external/github"; });
  await page.getByTestId("github-pane-load-absent").waitFor({ timeout: 10_000 });
  await shot(page, "12-old-server-pane", tag);
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
      ["light", { width: 390, height: 844 }],
      ["dark", { width: 390, height: 844 }],
    ]) {
      if (ONLY === "" || ONLY === "hub") await hubScenes(browser, preview.origin, scheme, viewport);
      if (ONLY === "" || ONLY === "channel") await channelScenes(browser, preview.origin, scheme, viewport);
    }
    if (ONLY === "" || ONLY === "old") await oldServerAndStates(browser, preview.origin);
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
