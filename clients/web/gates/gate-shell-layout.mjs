#!/usr/bin/env node
// =============================================================================
// GATE — app shell stays the window (MOMO-610 / parity G-2).
//
// The regression this exists to catch: 설정 > 멤버와 초대 rendered taller than
// the window, the *document* scrolled instead of the settings pane, and the
// sidebar left the screen (the parity run measured 워크스페이스 탐색 at y=-267,
// leaving an empty column and a stranded identity row). A desktop messenger
// window does not scroll; its panes do.
//
// So the gate asserts the boundary rather than a screenshot:
//   - the document never scrolls on any signed-in route, at any window size,
//   - the sidebar nav stays at its resting y,
//   - .app-shell itself is not a scroll container that focus could shift,
//   - a long settings section still reaches its last control (the shell clips,
//     so the body pane has to scroll — clipping without scrolling would trade
//     one bug for a worse one),
//   - the composer stays inside the window, and the 1k-row timeline still
//     virtualizes, because both depend on the shell handing down a definite
//     height.
//
//   npm run build && npm run gate:shell
//
// No backend and no credentials: /v1 is fulfilled from the fixtures below, the
// same way scripts/capture-screens.mjs does it. The connect screen is checked
// too, in the opposite direction — it is signed out, has no shell, and is the
// one surface that may scroll the document, so a short window must still reach
// the sign-in button.
// =============================================================================

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";


// CSP-safe wait: page.evaluate travels over CDP and is exempt from the page's
// own Content-Security-Policy, while waitForFunction re-evaluates its predicate
// INSIDE the page world, which a script-src without 'unsafe-eval' refuses.
// Measured 2026-07-28 running this gate behind the packaged Tauri CSP
// (MOMO_CSP_GATE_HEADER replay from clients/web/README.md): every
// waitForFunction call threw EvalError while every page.evaluate succeeded.
async function waitForPageCondition(page, expression, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const satisfied = await page.evaluate(`(() => Boolean(${expression}))()`);
    if (satisfied) return;
    if (Date.now() > deadline) {
      throw new Error(`waitForPageCondition timed out: ${expression}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// 설정 > 사용량 (MOMO-616) is the tallest settings panel, so it is measured from
// the same contract fixture usageModel.test.ts asserts rather than from an
// invented payload.
const USAGE_FIXTURE = JSON.parse(
  readFileSync(resolve(WEB_ROOT, "src/features/settings/usageFixtures.json"), "utf8")
).normal;
const QUOTA_FIXTURE = JSON.parse(
  readFileSync(resolve(WEB_ROOT, "src/features/settings/quotaFixtures.json"), "utf8")
).healthy;
const GITHUB_MANIFEST = JSON.parse(
  readFileSync(resolve(WEB_ROOT, "../../server/Fixtures/plugin-manifests/github.json"), "utf8")
);
const PORT = Number(process.env.SHELL_GATE_PORT || 5179);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const OUT_DIR = process.env.OUT_DIR
  ? resolve(process.env.OUT_DIR)
  : resolve(WEB_ROOT, "artifacts/shell-layout");
// Layout is scheme-independent, so the gate runs one scheme by default and
// keeps the run short. SHELL_GATE_SCHEME=light shoots the same frames in the
// paper scheme when a review wants both.
const SCHEME = process.env.SHELL_GATE_SCHEME === "light" ? "light" : "dark";

// Windows worth measuring: the review default, the 900px case named in the
// ticket, and a window short and narrow enough that every section overflows.
const SIZES = [
  { name: "1280x800", width: 1280, height: 800 },
  { name: "900x600", width: 900, height: 600 },
  { name: "760x480", width: 760, height: 480 },
];

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";
const GENERAL_ID = "00000000-0000-7000-8000-000000000201";
const ME = "019f94e3-7a10-79cd-9dee-208f47edd9a8";
const HERMES = "019f94e3-8b21-7ae0-b3c4-5f1a2d6e7c90";
const NOTION_PLUGIN_ID = "com.momo.plugins.notion";
const GITHUB_PLUGIN_ID = GITHUB_MANIFEST.plugin.id;

// The marketplace has to tolerate a manifest with several independently
// selectable scopes. This fixture keeps the registry response shape and the
// gate's existing mock server, but makes its four consent rows tall enough to
// exercise the short-window scroll contract.
const NOTION_SCOPE_FIXTURE = [
  ["notion:read", "notion.search", "Search pages available to the delegated user", "read", "read_only"],
  ["notion:comment", "notion.comment", "Add a comment to a page shared with the delegated user", "write", "workspace_write"],
  ["notion:write", "notion.create_page", "Create or update a page shared with the delegated user", "write", "network_write"],
  ["notion:admin", "notion.manage_connections", "Manage delegated connection settings for this workspace", "admin", "workspace_write"],
];

const NOTION_MANIFEST = {
  schemaVersion: "momo.plugin.v1",
  plugin: {
    id: NOTION_PLUGIN_ID,
    name: "긴 한글 이름의 Notion 워크스페이스 지식 연결",
    version: "1.0.0",
    description: "Official Notion hosted MCP integration",
    publisher: { id: "makenotion", name: "Notion", verified: true },
    license: { spdx: "MIT", kind: "open_source" },
    provenance: {
      sourceURL: "https://github.com/makenotion/notion-mcp-server",
      releaseRef: "hosted",
      verified: true,
    },
  },
  mcp: {
    protocolVersion: "2025-06-18",
    transport: "streamable_http",
    url: "https://mcp.notion.com/mcp",
    server: { name: "makenotion/notion-mcp-server", version: "hosted" },
    tools: NOTION_SCOPE_FIXTURE.map(([scope, name, description, risk]) => ({
      name,
      description,
      scopes: [scope],
      risk,
    })),
  },
  momo: {
    approvalTier: Object.fromEntries(NOTION_SCOPE_FIXTURE.map(([, name,,, tier]) => [name, tier])),
    risk: "high",
    egressDomains: ["mcp.notion.com"],
    recommendedFor: ["knowledge-management", "documentation"],
  },
};

const NOTION_CATALOG_ITEM = {
  pluginId: NOTION_PLUGIN_ID,
  name: NOTION_MANIFEST.plugin.name,
  version: NOTION_MANIFEST.plugin.version,
  description: NOTION_MANIFEST.plugin.description,
  official: true,
  recommended: false,
  egressDomains: NOTION_MANIFEST.momo.egressDomains,
  recommendedFor: NOTION_MANIFEST.momo.recommendedFor,
  installed: true,
  enabled: true,
};
const GITHUB_CATALOG_ITEM = {
  pluginId: GITHUB_PLUGIN_ID,
  name: GITHUB_MANIFEST.plugin.name,
  version: GITHUB_MANIFEST.plugin.version,
  description: GITHUB_MANIFEST.plugin.description,
  official: true,
  recommended: true,
  egressDomains: GITHUB_MANIFEST.momo.egressDomains,
  recommendedFor: GITHUB_MANIFEST.momo.recommendedFor,
  installed: true,
  enabled: true,
};

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
  realtimeWebSocketUrl: `ws://127.0.0.1:${PORT + 900}/connection/websocket`,
};

const CHANNELS = [
  { id: GENERAL_ID, workspaceId: WORKSPACE_ID, kind: "public", name: "general", muted: false },
  { id: "00000000-0000-7000-8000-000000000202", workspaceId: WORKSPACE_ID, kind: "public", name: "엔진", muted: false },
  { id: "00000000-0000-7000-8000-000000000203", workspaceId: WORKSPACE_ID, kind: "private", name: "김인턴작업", muted: false },
  { id: "00000000-0000-7000-8000-000000000204", workspaceId: WORKSPACE_ID, kind: "public", name: "release-notes", muted: false },
];
const CHANNEL_IDS = CHANNELS.map((c) => c.id);

// A roster long enough to overflow a short window: 멤버 디렉터리 (MOMO-611) is
// the second surface after 설정 > 멤버와 초대 whose length is the workspace's,
// not the designer's, so the gate measures it on a workspace that has been
// hiring rather than on two rows that fit anywhere.
const TEAM = [
  ["박지훈", "jihoon", "admin"],
  ["이서연", "seoyeon", "member"],
  ["최민우", "minwoo", "member"],
  ["정하늘", "haneul", "member"],
  ["윤도현", "dohyun", "guest"],
  ["장서준", "seojun", "member"],
  ["임채원", "chaewon", "member"],
  ["오세훈", "sehun", "member"],
  ["강다인", "dain", "member"],
  ["신유진", "yujin", "member"],
  ["Nadia Rahman", "nadia", "member"],
  ["Tom Okafor", "tom", "member"],
];

const ROSTER = [
  { id: ME, workspaceId: WORKSPACE_ID, kind: "human", status: "active", role: "owner", displayName: "곽성재", handle: "seongjae", channelCount: CHANNEL_IDS.length, channelIds: CHANNEL_IDS, capabilities: [], createdAtMs: 0, updatedAtMs: 0 },
  { id: HERMES, workspaceId: WORKSPACE_ID, kind: "agent", status: "active", role: "member", displayName: "hermes", handle: "hermes", channelCount: CHANNEL_IDS.length, channelIds: CHANNEL_IDS, capabilities: ["code"], ownerHumanId: ME, agentModel: "hermes-agent", createdAtMs: 0, updatedAtMs: 0 },
  ...TEAM.map(([displayName, handle, role], i) => ({
    id: `019f9a01-0000-7000-8000-0000000004${String(i).padStart(2, "0")}`,
    workspaceId: WORKSPACE_ID,
    kind: "human",
    status: "active",
    role,
    displayName,
    handle,
    channelCount: 1,
    channelIds: [GENERAL_ID],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  })),
];

const READ_STATES = CHANNELS.map((c, i) => ({
  channel_id: c.id,
  last_read_seq: 10,
  latest_seq: i === 0 ? 15 : 10,
  unread_count: i === 0 ? 5 : 0,
  mention_count: i === 0 ? 1 : 0,
}));

// A realistic long Korean operator note: the sections have to wrap it, not
// widen the shell, and it is what makes 운영 sections overflow a short window.
const LONG_KO =
  "워크스페이스 운영자만 바꿀 수 있는 설정입니다. 이 값을 바꾸면 이미 발급된 초대 링크와 진행 중인 에이전트 턴에 즉시 영향이 갑니다.";

// Twelve issued codes: 멤버와 초대 is the section the parity run broke on, and
// a workspace that has actually been inviting people is what makes it long.
const INVITES = Array.from({ length: 12 }, (_, i) => ({
  id: `gate-invite-${i}`,
  workspaceId: WORKSPACE_ID,
  codePreview: `zz${String(i).padStart(4, "0")}`,
  role: i % 2 ? "admin" : "member",
  maxUses: 5,
  usedCount: i % 5,
  expiresAtMs: Date.now() + (i + 1) * 86_400_000,
  createdBy: ME,
  createdAtMs: Date.now(),
  updatedAtMs: Date.now(),
}));

// 코드 실행 호스트 (MOMO-617) is now three blocks tall, and the 재개 대상 control
// only exists when a policy is in auto, so the fixture puts both scopes there:
// the tallest form the section can take is the one to measure. One host carries
// a long Korean name for the same reason LONG_KO exists.
const WORK_HOSTS = [
  {
    id: "019f994c-4ed0-76a9-9d43-a9bde45b8fcd",
    workspaceId: WORKSPACE_ID,
    scope: "member",
    ownerMemberId: ME,
    type: "app",
    displayName: "성재 MacBook Pro 16인치, 사무실 창가 자리",
    publicKey: "gate-only-not-a-credential",
    capabilities: { terminal: true, git: true },
    lastSeenAtMs: Date.now() - 20_000,
    createdAtMs: Date.now() - 86_400_000,
    online: true,
  },
  {
    id: "019f994c-4ee2-74f5-80f1-44408e9a2b82",
    workspaceId: WORKSPACE_ID,
    scope: "workspace",
    ownerMemberId: ME,
    type: "workd",
    displayName: "dawn-build-01",
    publicKey: "gate-only-not-a-credential",
    capabilities: { terminal: true },
    lastSeenAtMs: Date.now() - 3 * 3_600_000,
    createdAtMs: Date.now() - 7 * 86_400_000,
    online: false,
  },
  {
    id: "019f994c-4ef4-70bb-9c02-2c3a5d8e1f77",
    workspaceId: WORKSPACE_ID,
    scope: "member",
    ownerMemberId: HERMES,
    type: "app",
    displayName: "지수 MacBook Air",
    publicKey: "gate-only-not-a-credential",
    capabilities: {},
    revokedAtMs: Date.now() - 2 * 86_400_000,
    createdAtMs: Date.now() - 30 * 86_400_000,
    online: false,
  },
];

// The pair the server can actually produce. WorkTierPolicyRoutes.loadPolicy
// answers /me from the workspace row when no member row exists, so an inherited
// member policy carries the DEFAULT's mode, target and updated_at, with only
// member_id and inherited differing. A fixture that inherits while showing a
// different mode measures a screen the server cannot serve.
const WORKSPACE_TIER_POLICY = {
  workspaceId: WORKSPACE_ID,
  mode: "auto",
  autoTarget: "019f994c-4ee2-74f5-80f1-44408e9a2b82",
  inherited: false,
  updatedAtMs: Date.now() - 3_600_000,
};

const MEMBER_TIER_POLICY = {
  ...WORKSPACE_TIER_POLICY,
  memberId: ME,
  inherited: true,
};

const BODIES = [
  [ME, "relay outbox lag p99가 1.2s 근처예요. batch size 만지기 전에 원인부터 봅시다."],
  [HERMES, "outbox_drain 워커 로그를 읽었습니다. 재시작 루프 1건, 마지막 30분은 안정입니다."],
  [ME, LONG_KO],
  [HERMES, "확인했습니다. 여명 팔레트 토큰만 쓰고 있고 인디고 잔재는 없습니다."],
];

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function makeMessages(count) {
  const base = Date.now() - count * 60_000;
  return Array.from({ length: count }, (_, i) => {
    const [author, body] = BODIES[i % BODIES.length];
    return {
      id: `gate-${i + 1}`,
      channelId: GENERAL_ID,
      seq: 1400 + i,
      hlcTs: base + i * 60_000,
      hlcCount: 0,
      authorMemberId: author,
      type: "text",
      body,
      state: "sent",
      createdAtMs: base + i * 60_000,
    };
  });
}

async function installMocks(context) {
  // Playwright checks handlers in reverse registration order, so this superset
  // catch-all is registered FIRST and therefore matches LAST. Without it an
  // endpoint nobody thought to mock answers 401 and the shell signs itself out
  // in the middle of the run, which reads as a layout pass on a login screen.
  await context.route("**/v1/**", (route) =>
    json(route, {
      channels: [], members: [], read_states: [], messages: [],
      invites: [], approvals: [], runs: [],
    })
  );
  await context.route("**/v1/auth/login", (route) => json(route, SESSION));
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
  await context.route("**/v1/workspaces/*/roster", (route) =>
    json(route, { members: ROSTER })
  );
  await context.route("**/v1/workspaces/*/read-state", (route) =>
    json(route, { read_states: READ_STATES })
  );
  await context.route("**/v1/workspaces/*/channels/*/read-state", (route) =>
    json(route, READ_STATES[0])
  );
  await context.route("**/v1/workspaces/*/channels/*/messages*", (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("before") || url.searchParams.has("after")) {
      return json(route, { messages: [] });
    }
    return json(route, { messages: makeMessages(24) });
  });
  await context.route(
    "**/v1/workspaces/*/channels/*/huddles/active",
    (route) => json(route, { huddle: null })
  );
  await context.route("**/v1/workspaces/*/invites*", (route) =>
    json(route, { invites: INVITES })
  );
  await context.route("**/v1/workspaces/*/usage/summary*", (route) =>
    json(route, USAGE_FIXTURE)
  );
  // 사용량 is the tallest settings panel and it grew a second frame on top
  // (구독 잔여량, ADR-0135 D2), so the gate measures it with the gauges actually
  // rendered rather than with the empty state a catch-all would produce.
  await context.route("**/v1/provider/quota-snapshots", (route) =>
    json(route, QUOTA_FIXTURE)
  );
  await context.route("**/v1/provider/link", (route) =>
    json(route, {
      schema: "momo.provider_link.v0",
      configured: true,
      source: "database",
      mode: "anthropic",
      baseUrl: "https://api.anthropic.com",
      endpointLabel: "Anthropic Messages",
      bearerConfigured: true,
      bearerLast4: "9f31",
      availability: "ok",
      keyConfigured: true,
      updatedAtMs: Date.now(),
      updatedBy: "곽성재",
      diagnostics: [LONG_KO, LONG_KO],
    })
  );
  await context.route("**/v1/provider/work-host-engine", (route) =>
    json(route, {
      engine: "docker",
      source: "database",
      updatedBy: "곽성재",
      updatedAtMs: Date.now(),
      schema: "momo.work_host_engine.v0",
    })
  );
  await context.route("**/v1/workspaces/*/work-hosts", (route) =>
    json(route, { workHosts: WORK_HOSTS })
  );
  await context.route("**/v1/workspaces/*/work-tier-policy", (route) =>
    json(route, { workTierPolicy: WORKSPACE_TIER_POLICY })
  );
  await context.route("**/v1/workspaces/*/work-tier-policy/me", (route) =>
    json(route, { workTierPolicy: MEMBER_TIER_POLICY })
  );
  // Least specific of the workspace routes; `*` never crosses a `/`, so the
  // ones above still win for their own sub-paths.
  await context.route("**/v1/workspaces/*", (route) =>
    json(route, {
      workspace: {
        id: WORKSPACE_ID,
        slug: "momowebqa",
        name: "momo webqa",
        updatedAtMs: Date.now(),
      },
    })
  );

  // The first confirmed batch fails scope-by-scope. The next one succeeds so
  // the same shell run asserts both full-failure dialog retention and the
  // full-grant focus handoff to the newly-mounted revoke control.
  const activeNotionScopes = new Set();
  let failedGrantResponses = 0;
  let notionDetailResponses = 0;
  const catalog = () => ({
    plugins: [NOTION_CATALOG_ITEM, GITHUB_CATALOG_ITEM],
    toolPolicy: {
      plugins: activeNotionScopes.size === 0 ? [] : [{
        pluginId: NOTION_PLUGIN_ID,
        mcp: { url: NOTION_MANIFEST.mcp.url, transport: NOTION_MANIFEST.mcp.transport },
        egressDomains: NOTION_MANIFEST.momo.egressDomains,
        tools: NOTION_MANIFEST.mcp.tools.filter((tool) => activeNotionScopes.has(tool.scopes[0]))
          .map((tool) => ({
            name: tool.name,
            risk: tool.risk,
            approvalTier: NOTION_MANIFEST.momo.approvalTier[tool.name],
          })),
      }],
    },
  });
  const detail = () => ({
    plugin: { ...NOTION_CATALOG_ITEM, manifest: NOTION_MANIFEST },
  });
  const githubDetail = () => ({
    plugin: { ...GITHUB_CATALOG_ITEM, manifest: GITHUB_MANIFEST },
  });
  await context.route("**/v1/workspaces/*/plugins", (route) => json(route, catalog()));
  await context.route(`**/v1/workspaces/*/plugins/${NOTION_PLUGIN_ID}`, async (route) => {
    // Initial selection is immediate. Refetches lag behind the catalog by
    // 160ms, reproducing the deployed timing where the complementary action
    // mounts disabled before the sibling request has fully settled.
    if (notionDetailResponses > 0) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 160));
    }
    notionDetailResponses += 1;
    return json(route, detail());
  });
  await context.route(`**/v1/workspaces/*/plugins/${GITHUB_PLUGIN_ID}`, (route) =>
    json(route, githubDetail())
  );
  await context.route(`**/v1/workspaces/*/plugins/${NOTION_PLUGIN_ID}/grants`, async (route) => {
    if (route.request().method() !== "POST") return json(route, { status: "revoked" });
    const scope = JSON.parse(route.request().postData() ?? "{}").scope;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 40));
    if (failedGrantResponses < NOTION_SCOPE_FIXTURE.length) {
      failedGrantResponses += 1;
      return json(route, { error: "gate-only policy failure" }, 403);
    }
    activeNotionScopes.add(scope);
    return json(route, {
      pluginId: NOTION_PLUGIN_ID,
      memberId: ME,
      scope,
      status: "active",
      enabled: true,
      capabilities: [],
    }, 201);
  });
}

/** Resting y of the sidebar nav in a shell that has not been pushed anywhere. */
const NAV_RESTING_TOP = 45;

const SHELL_METRICS = `(() => {
  const doc = document.scrollingElement || document.documentElement;
  const nav = document.querySelector('[aria-label="워크스페이스 탐색"]');
  const shell = document.querySelector(".app-shell");
  return {
    docOverflowY: doc.scrollHeight - doc.clientHeight,
    docOverflowX: doc.scrollWidth - doc.clientWidth,
    docScrollY: Math.round(window.scrollY),
    shellScrollTop: shell ? shell.scrollTop : null,
    shellHeight: shell ? Math.round(shell.getBoundingClientRect().height) : null,
    navTop: nav ? Math.round(nav.getBoundingClientRect().top) : null,
    viewportHeight: window.innerHeight,
  };
})()`;

const failures = [];

function check(label, ok, detail) {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

/** Try to scroll the page, then assert nothing moved and nothing overflows. */
async function assertShellHeld(page, label, shotName) {
  await page.waitForTimeout(300);
  await page.evaluate("window.scrollTo(0, 99999)");
  await page.waitForTimeout(150);
  const m = await page.evaluate(SHELL_METRICS);
  const ok =
    m.docOverflowY === 0 &&
    m.docOverflowX === 0 &&
    m.docScrollY === 0 &&
    m.shellScrollTop === 0 &&
    m.navTop === NAV_RESTING_TOP &&
    m.shellHeight === m.viewportHeight;
  check(label, ok, JSON.stringify(m));
  if (shotName) await page.screenshot({ path: `${OUT_DIR}/${shotName}.png` });
}

async function signIn(page) {
  await page.getByTestId("login-email").fill("seongjae@dawn.example");
  await page.getByTestId("login-password").fill("gate-only-not-a-credential");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-list").waitFor({ state: "visible" });
}

/**
 * Route changes go through the hash, not page.goto: a reload drops the
 * in-memory session and would measure the connect screen by mistake.
 * SettingsRoute reads ?section= once at mount, so settings visits bounce
 * through /inbox to force a remount.
 */
async function go(page, hash) {
  if (hash.startsWith("/settings")) {
    await page.evaluate('location.hash = "/inbox"');
    await page.waitForTimeout(200);
  }
  await page.evaluate(`location.hash = ${JSON.stringify(hash)}`);
  await page.waitForTimeout(600);
}

/**
 * The consent panel owns a fixed header and footer around one middle scrollbox.
 * Red proof for layout: move the identity/description/installation context
 * from the scroll body back into the fixed header, rebuild, then run this
 * gate. The first-scope risk+approval visibility assertion fails at 760x480
 * for both the long-name four-scope fixture and the shipped one-scope GitHub
 * fixture, while the independent title+footer assertion stays green.
 *
 * Red proof for focus: revert focusPluginScopeChangeFallback to returning true
 * after focus() without checking disabled/aria-disabled/activeElement, and
 * remove mutation.isPending from its effect dependencies. This gate's catalog
 * answers immediately while the detail refetch waits 160ms; the revoke-focus
 * assertion then times out with document.activeElement === document.body.
 */
async function assertPluginScopeConsent(page, size) {
  await go(page, "/settings?section=plugins");
  const grant = page.getByTestId("plugin-scope-grant");
  await grant.waitFor({ state: "visible" });
  await grant.click();

  const dialog = page.getByTestId("plugin-scope-consent");
  const confirm = page.getByTestId("plugin-scope-confirm");
  await dialog.waitFor({ state: "visible" });
  const layout = await page.evaluate(`(() => {
    const panel = document.querySelector('[data-testid="plugin-scope-consent"]');
    const scrollbox = document.querySelector('[data-testid="plugin-scope-consent-body"]');
    const title = document.querySelector('[data-testid="plugin-scope-consent-title"]');
    const installationSignal = document.querySelector(
      '[data-testid="plugin-scope-installation-signal"]'
    );
    const firstBadges = document.querySelector('[data-testid^="plugin-scope-badges-"]');
    const momoMark = document.querySelector('[data-testid="plugin-scope-momo-mark"]');
    const buttons = [
      document.querySelector('[data-testid="plugin-scope-cancel"]'),
      document.querySelector('[data-testid="plugin-scope-confirm"]'),
    ];
    if (!panel || !scrollbox || !title || !installationSignal || !firstBadges || !momoMark || buttons.some((button) => !button)) {
      return { missing: true };
    }
    const panelRect = panel.getBoundingClientRect();
    const scrollboxRect = scrollbox.getBoundingClientRect();
    const titleRect = title.getBoundingClientRect();
    const installationSignalRect = installationSignal.getBoundingClientRect();
    const badgeRect = firstBadges.getBoundingClientRect();
    const buttonRects = buttons.map((button) => button.getBoundingClientRect());
    const inViewport = (rect) => rect.top >= 0 && rect.bottom <= window.innerHeight + 1;
    const inPanel = (rect) => rect.top >= panelRect.top && rect.bottom <= panelRect.bottom;
    return {
      panel: { top: Math.round(panelRect.top), bottom: Math.round(panelRect.bottom) },
      titleRect: { top: Math.round(titleRect.top), bottom: Math.round(titleRect.bottom) },
      buttonRects: buttonRects.map((rect) => ({ top: Math.round(rect.top), bottom: Math.round(rect.bottom) })),
      scrollboxOverflowY: getComputedStyle(scrollbox).overflowY,
      scrollboxScrolls: scrollbox.scrollHeight > scrollbox.clientHeight,
      scrollTop: scrollbox.scrollTop,
      titleInViewport: inViewport(titleRect),
      titleInPanel: inPanel(titleRect),
      installationSignalText: installationSignal.textContent,
      installationSignalInViewport: inViewport(installationSignalRect),
      installationSignalInPanel: inPanel(installationSignalRect),
      firstBadgeText: firstBadges.textContent,
      firstBadgesVisible:
        badgeRect.top >= scrollboxRect.top &&
        badgeRect.bottom <= scrollboxRect.bottom &&
        inViewport(badgeRect) &&
        inPanel(badgeRect),
      momoMarkFits: momoMark.scrollWidth <= momoMark.clientWidth,
      contactCopyHonest:
        panel.textContent?.includes("문의할 수 있는 관리자:") === true &&
        panel.textContent?.includes("설치 관리자:") === false,
      buttonsInViewport: buttonRects.every(inViewport),
      buttonsInPanel: buttonRects.every(inPanel),
    };
  })()`);
  check(
    `${size.name} 다중-scope 동의 제목과 확인·취소 버튼이 열자마자 함께 보인다`,
    layout.missing !== true &&
      layout.scrollboxOverflowY === "auto" &&
      layout.scrollboxScrolls === true &&
      layout.scrollTop === 0 &&
      layout.titleInViewport === true &&
      layout.titleInPanel === true &&
      layout.installationSignalText?.includes("워크스페이스 설치됨") &&
      layout.installationSignalInViewport === true &&
      layout.installationSignalInPanel === true &&
      layout.firstBadgesVisible === true &&
      layout.firstBadgeText?.includes("승인:") &&
      layout.firstBadgeText?.includes("위험도:") &&
      layout.momoMarkFits === true &&
      layout.contactCopyHonest === true &&
      layout.buttonsInViewport === true &&
      layout.buttonsInPanel === true,
    JSON.stringify(layout)
  );

  const scopeCheckboxes = dialog.getByRole("checkbox");
  const scopeCount = await scopeCheckboxes.count();
  for (let index = 0; index < scopeCount; index += 1) {
    await scopeCheckboxes.nth(index).click();
  }
  check(
    `${size.name} 선택 0개면 고정 액션이 필요한 다음 행동을 말한다`,
    (await confirm.textContent())?.includes("권한을 하나 이상 선택") === true &&
      await confirm.getAttribute("aria-disabled") === "true"
  );
  for (let index = 0; index < scopeCount; index += 1) {
    await scopeCheckboxes.nth(index).click();
  }

  await confirm.click();
  await waitForPageCondition(
    page,
    'document.querySelector(\'[data-testid="plugin-scope-confirm"]\')?.getAttribute("aria-busy") === "true"'
  );
  const busyConfirm = await page.evaluate(`(() => {
    const button = document.querySelector('[data-testid="plugin-scope-confirm"]');
    return {
      ariaBusy: button?.getAttribute("aria-busy"),
      ariaDisabled: button?.getAttribute("aria-disabled"),
      dimmed: button?.classList.contains("opacity-50"),
      label: button?.textContent,
      checkboxAriaDisabled: document.querySelector(
        '[data-testid^="plugin-scope-row-"] input'
      )?.getAttribute("aria-disabled"),
      checkboxLabelCursor: getComputedStyle(
        document.querySelector('[data-testid^="plugin-scope-row-"] label')
      ).cursor,
    };
  })()`);
  check(
    `${size.name} 진행 중 확인 버튼은 흐려지거나 비활성으로 말하지 않는다`,
    busyConfirm.ariaBusy === "true" &&
      busyConfirm.ariaDisabled === null &&
      busyConfirm.dimmed === false &&
      busyConfirm.label?.includes("변경 중") &&
      busyConfirm.checkboxAriaDisabled === "true" &&
      busyConfirm.checkboxLabelCursor !== "pointer",
    JSON.stringify(busyConfirm)
  );
  const consentError = page.getByTestId("plugin-scope-consent-error");
  await consentError.waitFor({ state: "visible" });
  const failure = await page.evaluate(`(() => ({
    dialogOpen: Boolean(document.querySelector('[data-testid="plugin-scope-consent"]')),
    error: document.querySelector('[data-testid="plugin-scope-consent-error"]')?.textContent,
    policyCauseCount: (
      document.querySelector('[data-testid="plugin-scope-consent-error"]')?.textContent
        ?.match(/이 앱은 워크스페이스 정책이나 내 역할상 변경할 수 없습니다\\./g) ?? []
    ).length,
  }))()`);
  check(
    `${size.name} 전량 권한 실패는 선택을 보존하고 같은 403 원인을 한 번만 말한다`,
    failure.dialogOpen === true &&
      NOTION_SCOPE_FIXTURE.every(([scope]) => failure.error?.includes(scope)) &&
      failure.policyCauseCount === 1 &&
      failure.error?.includes("관리자에게 정책과 권한을 확인하세요."),
    JSON.stringify(failure)
  );
  await consentError.getByRole("button", { name: "오류 닫기" }).click();
  await waitForPageCondition(
    page,
    'document.activeElement === document.querySelector(\'[data-testid="plugin-scope-confirm"]\')'
  );
  await page.keyboard.press("Tab");
  await waitForPageCondition(
    page,
    `document.activeElement === document.querySelector(
      '[data-testid=${JSON.stringify(`plugin-scope-${NOTION_SCOPE_FIXTURE[0][0]}`)}]'
    )`
  );
  // The app scrolls the focused control into view on the NEXT frame (Radix
  // moves focus with preventScroll), so a measurement taken the instant focus
  // lands reads the pre-scroll position. Let the scroll settle first.
  await page.evaluate("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
  const wrappedFocus = await page.evaluate(`(() => {
    const scrollbox = document.querySelector('[data-testid="plugin-scope-consent-body"]');
    const checkbox = document.querySelector(
      '[data-testid=${JSON.stringify(`plugin-scope-${NOTION_SCOPE_FIXTURE[0][0]}`)}]'
    );
    if (!scrollbox || !checkbox) return { missing: true };
    const s = scrollbox.getBoundingClientRect();
    const c = checkbox.getBoundingClientRect();
    const style = getComputedStyle(checkbox);
    return {
      gapAboveElement: Math.round(c.top - s.top),
      outlineWidth: style.outlineWidth,
      outlineOffset: style.outlineOffset,
    };
  })()`);
  check(
    `${size.name} Tab 랩 뒤 첫 체크박스 포커스 링 위쪽 여백이 남는다`,
    wrappedFocus.missing !== true &&
      wrappedFocus.gapAboveElement >= 4 &&
      wrappedFocus.outlineWidth === "2px" &&
      wrappedFocus.outlineOffset === "2px",
    JSON.stringify(wrappedFocus)
  );

  await page.getByTestId("plugin-scope-cancel").click();
  await dialog.waitFor({ state: "hidden" });
  const retainedAttempt = page.getByTestId("plugin-scope-change-result");
  await retainedAttempt.waitFor({ state: "visible" });
  check(
    `${size.name} 전량 실패 뒤 취소해도 패널에 시도 기록이 남는다`,
    (await retainedAttempt.textContent())?.includes("허용하지 못했습니다") === true
  );

  await grant.click();
  await dialog.waitFor({ state: "visible" });
  await confirm.click();
  await dialog.waitFor({ state: "hidden" });
  const revoke = page.getByTestId("plugin-scope-revoke");
  await revoke.waitFor({ state: "visible" });
  await waitForPageCondition(
    page,
    'document.activeElement === document.querySelector(\'[data-testid="plugin-scope-revoke"]\')'
  );
  check(`${size.name} 전량 허용 뒤 포커스가 회수 컨트롤로 간다`, true);

  if (size.name === "760x480") {
    await page.getByTestId(`plugin-catalog-${GITHUB_PLUGIN_ID}`).click();
    const githubGrant = page.getByTestId("plugin-scope-grant");
    await githubGrant.waitFor({ state: "visible" });
    await githubGrant.click();
    await dialog.waitFor({ state: "visible" });
    const githubLayout = await page.evaluate(`(() => {
      const panel = document.querySelector('[data-testid="plugin-scope-consent"]');
      const title = document.querySelector('[data-testid="plugin-scope-consent-title"]');
      const confirm = document.querySelector('[data-testid="plugin-scope-confirm"]');
      const scrollbox = document.querySelector('[data-testid="plugin-scope-consent-body"]');
      const firstBadges = document.querySelector('[data-testid^="plugin-scope-badges-"]');
      if (!panel || !title || !confirm || !scrollbox || !firstBadges) return { missing: true };
      const p = panel.getBoundingClientRect();
      const t = title.getBoundingClientRect();
      const c = confirm.getBoundingClientRect();
      const s = scrollbox.getBoundingClientRect();
      const b = firstBadges.getBoundingClientRect();
      return {
        title: title.textContent,
        titleVisible: t.top >= p.top && t.bottom <= p.bottom && t.top >= 0,
        confirmVisible: c.top >= p.top && c.bottom <= p.bottom && c.bottom <= window.innerHeight + 1,
        firstBadgeText: firstBadges.textContent,
        firstBadgesVisible:
          b.top >= s.top && b.bottom <= s.bottom &&
          b.top >= p.top && b.bottom <= p.bottom &&
          b.top >= 0 && b.bottom <= window.innerHeight + 1,
      };
    })()`);
    check(
      `${size.name} 출하 시드 GitHub도 제목과 확인 버튼이 열자마자 함께 보인다`,
      githubLayout.missing !== true &&
        githubLayout.title?.includes("GitHub") &&
        githubLayout.titleVisible === true &&
        githubLayout.confirmVisible === true &&
        githubLayout.firstBadgesVisible === true &&
        githubLayout.firstBadgeText?.includes("승인:") &&
        githubLayout.firstBadgeText?.includes("위험도:"),
      JSON.stringify(githubLayout)
    );
    await page.getByTestId("plugin-scope-cancel").click();
  }
}

async function measureSize(browser, size) {
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    colorScheme: SCHEME,
    reducedMotion: "reduce",
  });
  await installMocks(context);
  const page = await context.newPage();
  await page.goto(ORIGIN, { waitUntil: "networkidle" });
  await signIn(page);

  await assertShellHeld(page, `${size.name} 채널`, `${size.name}-chat`);

  // The composer is the bottom edge of the chat pane: if the shell ever hands
  // down an indefinite height it is the first thing to fall out of the window.
  const composer = await page.evaluate(`(() => {
    const el = document.querySelector('[data-testid="composer-input"]');
    if (!el) return { missing: true };
    const r = el.getBoundingClientRect();
    return { bottom: Math.round(r.bottom), viewportHeight: window.innerHeight,
             anchored: r.top >= 0 && r.bottom <= window.innerHeight + 1 };
  })()`);
  check(`${size.name} 컴포저가 창 안에 남는다`, composer.anchored === true, JSON.stringify(composer));

  for (const [hash, label, shot] of [
    ["/inbox", "인박스", "inbox"],
    ["/activity", "활동", "activity"],
    ["/directory", "멤버 디렉터리", "directory"],
    ["/settings?section=account", "설정 계정", "settings-account"],
    ["/settings?section=members", "설정 멤버와 초대", "settings-members"],
    ["/settings?section=ai", "설정 AI 연결", "settings-ai"],
    ["/settings?section=code", "설정 코드 실행 호스트", "settings-code"],
    ["/settings?section=workspace", "설정 워크스페이스", "settings-workspace"],
    ["/settings?section=usage", "설정 사용량", "settings-usage"],
  ]) {
    await go(page, hash);
    await assertShellHeld(page, `${size.name} ${label}`, `${size.name}-${shot}`);
  }

  await assertPluginScopeConsent(page, size);

  // Clipping without scrolling would be the worse bug: the settings body pane
  // must still reach its last control, and doing so must not move the shell.
  // Two sections are asked, because they overflow for different reasons: 멤버와
  // 초대 by row count, 코드 실행 호스트 (MOMO-617) by carrying three blocks.
  //
  // The code section's last control is the workspace-scope SAVE button, not the
  // target select above it: since R2 both policy scopes commit explicitly, and
  // a fold check that stops one control short is a fold check that passes while
  // the button nobody can reach is the one that writes the ledger.
  for (const [hash, label, shot, selector] of [
    ["/settings?section=members", "멤버와 초대", "settings-bottom", "invite-create"],
    ["/settings?section=code", "코드 실행 호스트", "settings-code-bottom", "work-tier-save-workspace"],
  ]) {
    await go(page, hash);
    const reach = await page.evaluate(`(async () => {
      const btn = document.querySelector('[data-testid="${selector}"]');
      if (!btn) return { missing: true };
      btn.scrollIntoView({ block: "end" });
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const r = btn.getBoundingClientRect();
      const shell = document.querySelector(".app-shell");
      const nav = document.querySelector('[aria-label="워크스페이스 탐색"]');
      return {
        reached: r.top >= 0 && r.bottom <= window.innerHeight + 1,
        shellScrollTop: shell ? shell.scrollTop : null,
        docScrollY: Math.round(window.scrollY),
        navTop: nav ? Math.round(nav.getBoundingClientRect().top) : null,
      };
    })()`);
    check(
      `${size.name} 설정 ${label} 마지막 컨트롤까지 스크롤된다`,
      reach.reached === true &&
        reach.shellScrollTop === 0 &&
        reach.docScrollY === 0 &&
        reach.navTop === NAV_RESTING_TOP,
      JSON.stringify(reach)
    );
    await page.screenshot({ path: `${OUT_DIR}/${size.name}-${shot}.png` });
  }

  // Same question for the member directory (MOMO-611): a 14-row roster is
  // taller than a 480px window, so the LIST has to scroll and the shell must
  // not. Reaching the last row by keyboard is the case that broke settings.
  await go(page, "/directory");
  const lastRow = await page.evaluate(`(async () => {
    const rows = document.querySelectorAll('[data-testid="directory-row"]');
    if (rows.length === 0) return { missing: true };
    const last = rows[rows.length - 1];
    last.scrollIntoView({ block: "end" });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const r = last.getBoundingClientRect();
    const shell = document.querySelector(".app-shell");
    const nav = document.querySelector('[aria-label="워크스페이스 탐색"]');
    const doc = document.scrollingElement || document.documentElement;
    return {
      rows: rows.length,
      reached: r.top >= 0 && r.bottom <= window.innerHeight + 1,
      shellScrollTop: shell ? shell.scrollTop : null,
      docScrollY: Math.round(window.scrollY),
      docOverflowY: doc.scrollHeight - doc.clientHeight,
      navTop: nav ? Math.round(nav.getBoundingClientRect().top) : null,
    };
  })()`);
  check(
    `${size.name} 디렉터리 본문이 마지막 멤버까지 스크롤된다`,
    lastRow.reached === true &&
      lastRow.shellScrollTop === 0 &&
      lastRow.docScrollY === 0 &&
      lastRow.docOverflowY === 0 &&
      lastRow.navTop === NAV_RESTING_TOP,
    JSON.stringify(lastRow)
  );
  await page.screenshot({ path: `${OUT_DIR}/${size.name}-directory-bottom.png` });

  await context.close();
}

/** 1k rows still windowed: virtuoso needs a definite height from the shell. */
async function measureTimeline(browser) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    colorScheme: SCHEME,
    reducedMotion: "reduce",
  });
  await installMocks(context);
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/?stress=1000`, { waitUntil: "networkidle" });
  await signIn(page);
  await waitForPageCondition(page, "window.__spike && window.__spike.count === 1000", 20_000);
  await page.waitForSelector('[data-testid="timeline-message"]', { timeout: 20_000 });

  const timeline = await page.evaluate(`(async () => {
    const scroller = document.querySelector('[data-testid="timeline-virtuoso"]');
    if (!scroller) return { missing: true };
    const firstSeq = () => {
      const el = document.querySelector('[data-testid="timeline-message"]');
      return el ? Number(el.getAttribute("data-seq")) : null;
    };
    // Same warm-up as gate-scroll.mjs: virtuoso only measures the full extent
    // after a bottom→top round trip.
    scroller.scrollTop = scroller.scrollHeight;
    await new Promise((r) => setTimeout(r, 400));
    scroller.scrollTop = 0;
    await new Promise((r) => setTimeout(r, 800));
    const atTop = { rows: document.querySelectorAll('[data-testid="timeline-message"]').length, seq: firstSeq() };
    const measuredScrollHeight = Math.round(scroller.scrollHeight);
    scroller.scrollTop = scroller.scrollHeight;
    await new Promise((r) => setTimeout(r, 800));
    const atBottom = { rows: document.querySelectorAll('[data-testid="timeline-message"]').length, seq: firstSeq() };
    const doc = document.scrollingElement;
    return {
      atTop, atBottom, measuredScrollHeight,
      scrollerBottom: Math.round(scroller.getBoundingClientRect().bottom),
      viewportHeight: window.innerHeight,
      docOverflowY: doc.scrollHeight - doc.clientHeight,
    };
  })()`);

  const ok =
    !timeline.missing &&
    timeline.atTop.rows < 200 &&
    timeline.atBottom.rows < 200 &&
    timeline.measuredScrollHeight > timeline.viewportHeight * 10 &&
    timeline.atBottom.seq > timeline.atTop.seq &&
    timeline.scrollerBottom <= timeline.viewportHeight + 1 &&
    timeline.docOverflowY === 0;
  check("타임라인 1000행 가상화", ok, JSON.stringify(timeline));
  await page.screenshot({ path: `${OUT_DIR}/timeline-1000-bottom.png` });
  await context.close();
}

/**
 * The opposite assertion, on the one surface that has no shell: the connect
 * screen is allowed to scroll the document, and in a short window it has to,
 * or the sign-in button is unreachable.
 */
async function measureConnect(browser) {
  const context = await browser.newContext({
    viewport: { width: 900, height: 380 },
    colorScheme: SCHEME,
    reducedMotion: "reduce",
  });
  await installMocks(context);
  const page = await context.newPage();
  await page.goto(ORIGIN, { waitUntil: "networkidle" });
  const submit = page.getByTestId("login-submit");
  await submit.waitFor({ state: "visible" });
  await submit.scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  const reach = await page.evaluate(`(() => {
    const r = document.querySelector('[data-testid="login-submit"]').getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom),
             viewportHeight: window.innerHeight,
             reached: r.top >= 0 && r.bottom <= window.innerHeight };
  })()`);
  check("연결 화면 짧은 창에서 로그인 버튼 도달", reach.reached === true, JSON.stringify(reach));
  await page.screenshot({ path: `${OUT_DIR}/connect-short-window.png` });
  await context.close();
}

async function waitForServer(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`preview server never came up: ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) {
    throw new Error("dist/ is missing. Run `npm run build` first.");
  }
  mkdirSync(OUT_DIR, { recursive: true });

  const server = spawn(
    resolve(WEB_ROOT, "node_modules/.bin/vite"),
    ["preview", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"],
    { cwd: WEB_ROOT, stdio: "ignore" }
  );
  const shutdown = () => server.kill("SIGTERM");
  process.on("exit", shutdown);

  try {
    await waitForServer(ORIGIN);
    const browser = await chromium.launch();
    try {
      for (const size of SIZES) await measureSize(browser, size);
      await measureTimeline(browser);
      await measureConnect(browser);
    } finally {
      await browser.close();
    }
  } finally {
    shutdown();
  }

  console.log(`\nscreenshots: ${OUT_DIR}`);
  if (failures.length > 0) {
    console.error(`\nGATE FAIL: ${failures.length} check(s)`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("\nGATE PASS: the shell held at every window size.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
