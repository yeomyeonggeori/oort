#!/usr/bin/env node
// GATE — malformed JSON must not blank the signed-in shell (MOMO-632).
//
// This deliberately serves values a typed DTO cannot describe: null, missing
// fields, and a value of the wrong primitive kind. The assertion is structural,
// not a screenshot: React must retain a root child and the sidebar navigation
// must remain usable while the affected panel reports its own empty/error state.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "./preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const githubManifest = JSON.parse(readFileSync(
  resolve(webRoot, "../../server/Fixtures/plugin-manifests/github.json"),
  "utf8"
));
const port = Number(process.env.WIRE_GATE_PORT || 5180);
const origin = `http://127.0.0.1:${port}`;
const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "019f94e3-7a10-79cd-9dee-208f47edd9a8";
const session = {
  accessToken: "gate-only-not-a-credential", refreshToken: "gate-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: `ws://127.0.0.1:${port + 900}/connection/websocket`,
};

function json(route, body) {
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

// Build the healthy half of this malformed-wire test from the actual registry
// fixture and PluginCatalogResponse fields. The only invented bodies below are
// deliberate malformed values the gate must survive.
function healthyPluginCatalog() {
  const plugin = githubManifest.plugin;
  return {
    plugins: [{
      pluginId: plugin.id, name: plugin.name, version: plugin.version,
      description: plugin.description, official: true, recommended: true,
      egressDomains: githubManifest.momo.egressDomains,
      recommendedFor: githubManifest.momo.recommendedFor,
      installed: true, enabled: true,
    }],
    toolPolicy: { plugins: [] },
  };
}

async function installFaults(context) {
  let pluginFault = "catalog-null";
  await context.route("**/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/auth/login") return json(route, session);
    if (path === "/v1/auth/refresh") return json(route, {
      accessToken: "gate-only-not-a-credential", refreshToken: "gate-only-not-a-credential",
    });
    if (path.endsWith("/channels")) return json(route, { channels: null });
    if (path.endsWith("/roster")) return json(route, { members: {} });
    if (path.endsWith("/read-state")) return json(route, { read_states: "wrong" });
    if (path.includes("/messages")) return json(route, { messages: null });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: null });
    if (path.endsWith("/work-tier-policy") || path.endsWith("/work-tier-policy/me")) return json(route, {});
    if (path.endsWith("/invites")) return json(route, { invites: {} });
    if (path.endsWith("/approvals")) return json(route, { approvals: "wrong" });
    if (path.endsWith("/plugins")) {
      if (pluginFault === "catalog-null") return json(route, { plugins: null, toolPolicy: { plugins: [] } });
      if (pluginFault === "catalog-wrong") return json(route, { plugins: [{ pluginId: 3 }], toolPolicy: {} });
      return json(route, healthyPluginCatalog());
    }
    if (path.endsWith(`/plugins/${githubManifest.plugin.id}`)) {
      return json(route, pluginFault === "detail-null" ? { plugin: null } : {});
    }
    if (path === "/v1/provider/link") return json(route, { configured: true, diagnostics: null });
    return json(route, {});
  });
  return { setPluginFault: (next) => { pluginFault = next; } };
}

async function assertShell(page, surface, { settings: inSettings = true } = {}) {
  await page.waitForTimeout(350);
  const state = await page.evaluate(() => ({
    rootChildren: document.getElementById("root")?.children.length ?? 0,
    sidebar: Boolean(document.querySelector("nav[aria-label='워크스페이스 탐색']")),
    settings: Boolean(document.querySelector('[data-testid="settings-route"]')),
    settingsNav: Boolean(document.querySelector('[data-testid="settings-nav"]')),
    // Only the boundary's own fallback counts. Inline field/section errors also
    // use role=alert and are exactly the graceful degradation we want to keep.
    caught: Boolean(document.querySelector('[data-testid="render-error-boundary"]')),
  }));
  // 설정 안에서는 앱 사이드바가 DOM에서 빠지고 설정 목차가 그 자리의 내비게이션이다(SettingsShell) — 어느 쪽이든
  // 「화면을 옮겨 다닐 길이 살아 있다」가 이 단정의 뜻이다(#5048).
  const navAlive = inSettings ? state.settings && state.settingsNav : state.sidebar;
  if (state.rootChildren === 0 || !navAlive) {
    throw new Error(`${surface}: shell blanked: ${JSON.stringify(state)}`);
  }
  // Without this the gate proves only that the error boundary works: a render
  // throw is caught, the route shell survives, and every assertion above still
  // holds while the wire validation is broken (measured — reverting
  // `listWorkHosts` to its unchecked unwrap kept this gate green). The section
  // must degrade to its own empty state, not be rescued mid-render.
  if (state.caught) {
    throw new Error(
      `${surface}: the error boundary caught a render throw — wire validation ` +
      `did not degrade this section gracefully: ${JSON.stringify(state)}`
    );
  }
}

// The route-level boundary has to clear itself when the user navigates, but the
// obvious way to do that — keying it on the pathname — rebuilds the route
// subtree on EVERY navigation. Measured when it did: clicking the channel you
// are already reading wiped the composer draft and refetched history. So the
// reset is a prop the boundary watches, and this asserts the property that
// distinguishes the two: navigation must not cost the route its state.
async function assertNavigationKeepsRouteState(context) {
  const healthy = { id: "00000000-0000-7000-8000-000000000201", workspaceId, name: "general", kind: "channel", topic: null, muted: false };
  // Registered last, so it is checked first and supersedes the fault handler.
  await context.route("**/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/auth/login") return json(route, session);
    if (path.endsWith("/channels")) return json(route, { channels: [healthy] });
    if (path.endsWith("/roster")) return json(route, { members: [] });
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.includes("/messages")) return json(route, { messages: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    return json(route, {});
  });

  const page = await context.newPage();
  await page.goto(origin, { waitUntil: "networkidle" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("wire@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.waitForSelector("nav[aria-label='워크스페이스 탐색']");

  const composer = page.locator("textarea").first();
  await composer.waitFor({ timeout: 15_000 });
  const draft = "작성 중인 문장입니다";
  await composer.fill(draft);

  await page.getByRole("link", { name: /general/ }).first().click();
  await page.waitForTimeout(400);

  const kept = await page.locator("textarea").first().inputValue();
  if (kept !== draft) {
    throw new Error(
      `navigation discarded the route subtree: composer draft was ${JSON.stringify(draft)} ` +
      `and is now ${JSON.stringify(kept)} — the boundary must reset without remounting children`
    );
  }
  await page.close();
}

// 망가진 응답에서 플러그인 판은 **말을 해야 한다** — 목록이든 인라인 오류든.
// 아무것도 없는 빈 판은 사용자에게 "앱이 없다"로 읽히므로 실패로 취급한다.
async function assertPluginSurfaceSpeaks(page, surface) {
  // queryClient는 retry:1이라 실패 응답도 한 번 더 시도한다. 성급하게 재면
  // 스켈레톤을 '빈 판'으로 오독한다(측정됨). 종단 상태가 나올 때까지 기다린다.
  const deadline = Date.now() + 8000;
  let state;
  const read = () => page.evaluate(() => {
    const has = (id) => Boolean(document.querySelector(`[data-testid="${id}"]`));
    return {
      list: has("plugin-list"),
      detail: has("plugin-detail"),
      empty: has("plugins-empty"),
      catalogError: has("plugins-error"),
      detailError: has("plugin-detail-error"),
    };
  });
  for (;;) {
    state = await read();
    if (state.list || state.detail || state.empty || state.catalogError || state.detailError) break;
    if (Date.now() > deadline) break;
    await page.waitForTimeout(250);
  }
  // 검색·필터 컨트롤은 항상 렌더되므로 "텍스트가 있느냐"로는 아무것도 못 잡는다
  // (측정됨). 결과 영역이 무엇을 말하는지만 본다.
  if (!state.list && !state.detail && !state.empty && !state.catalogError && !state.detailError) {
    throw new Error(
      `plugins ${surface}: 판이 비었다 — 목록도 상세도 오류도 없다: ${JSON.stringify(state)}`
    );
  }
}

async function main() {
  if (!existsSync(resolve(webRoot, "dist/index.html"))) throw new Error("dist/ is missing. Run npm run build first.");
  const server = await startGuardedPreview({ webRoot, port, portEnvVar: "WIRE_GATE_PORT" });
  try {
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
      const faults = await installFaults(context);
      const page = await context.newPage();
      await page.goto(origin, { waitUntil: "networkidle" });
      await advanceToAccount(page);
      await page.getByTestId("login-email").fill("wire@example.test");
      await page.getByTestId("login-password").fill("not-a-secret");
      await page.getByTestId("login-submit").click();
      await page.waitForSelector("nav[aria-label='워크스페이스 탐색']");
      // UX-D4: 설정은 하단 프로필 카드 안의 실존 항목이다. 톱니 Link 가 아니다.
      await page.getByTestId("profile-card").click();
      await page.getByTestId("profile-card-menu").waitFor({ state: "visible" });
      await page.getByTestId("nav-settings").click();
      await page.waitForSelector('[data-testid="settings-route"]');
      // 설정 목차의 모든 화면(허브로 가는 링크 행 제외)을 차례로 연다. 옛 고정 목록(AI 연결·앱·계정)은 설정 재편(#3578)과
      // AI 허브 이전(#4141)으로 사라지거나 옮겨 갔다 — 목차를 눈앞에서 읽어, 새 섹션이 생겨도 이 레인에서 빠지지 않게 한다.
      // 호스트가 깨진 응답을 주는 이 픽스처에서는 「실행 호스트」 행이 접힌다(표면 판정, #2780). 접힌 행을 눌러 보는 일은
      // 없고, 그 접힘 자체가 깨진 호스트 응답이 셸을 살려 둔다는 증거다.
      const sectionIds = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-testid^="settings-nav-"]'))
          .filter((node) => node.getAttribute("data-link") === null)
          .map((node) => node.getAttribute("data-testid").slice("settings-nav-".length))
      );
      if (sectionIds.length < 8 || !sectionIds.includes("members")) {
        throw new Error(`settings nav read ${JSON.stringify(sectionIds)} — the walk below would prove nothing`);
      }
      for (const section of sectionIds) {
        await page.getByTestId(`settings-nav-${section}`).click();
        await assertShell(page, `settings ${section}`);
      }
      // 플러그인 카탈로그는 설정이 아니라 AI 허브 「외부 연결 › 앱」이다(AiExternalPane `apps` 상세, #4141): 설정 목차에는
      // 허브로 가는 링크 행만 있다. 판이 무엇을 말하는지는 그 판에 있을 때만 잴 수 있다 — 루프 뒤 마지막 섹션을 재면
      // 엉뚱한 곳을 본다(측정됨).
      await page.evaluate(() => {
        window.location.hash = "#/ai/external/apps";
      });
      await assertShell(page, "ai hub external apps", { settings: false });
      await assertPluginSurfaceSpeaks(page, "catalog-null");
      // A malformed catalog must stay an inline error. Once it recovers, the
      // selected manifest gets its own bad body, which must not turn into a
      // route-level render error either.
      // 셸이 살아 있다는 것만으로는 부족하다: 이 파싱은 쿼리 함수 안이라 어떤
      // throw든 react-query가 잡아 렌더 크래시가 되지 않는다. 즉 assertShell은
      // 검증 유무와 무관하게 통과한다(측정됨). 판이 통째로 비는 것과 오류를
      // 보고하는 것을 갈라야 이 게이트가 값을 갖는다.
      faults.setPluginFault("detail-null");
      await page.getByTestId("plugins-error").getByRole("button", { name: "다시 시도", exact: true }).click();
      await assertShell(page, "ai hub external apps detail", { settings: false });
      await assertPluginSurfaceSpeaks(page, "detail-null");
      await assertNavigationKeepsRouteState(context);
      await context.close();
    } finally { await browser.close(); }
  } finally { await server.stop(); }
  console.log("GATE PASS: malformed wire responses kept the shell and navigation alive,");
  console.log("           and navigation did not discard route state.");
}

main().catch((error) => { console.error(error); process.exit(1); });
