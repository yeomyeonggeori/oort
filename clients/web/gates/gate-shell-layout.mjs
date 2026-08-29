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
//   npm run gate:shell  # builds this exact checkout before previewing it
//   SHELL_GATE_FOCUS_ONLY=1 npm run gate:shell  # #1291 geometry/focus lane
//
// No backend and no credentials: /v1 is fulfilled from the fixtures below, the
// same way scripts/capture-screens.mjs does it. The connect screen is checked
// too, in the opposite direction — it is signed out, has no shell, and is the
// one surface that may scroll the document, so a short window must still reach
// the sign-in button.
// =============================================================================

import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "./preview-guard.mjs";
import { openWorkPanelViaConsole } from "./work-openers.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";
import {
  buildExactSourceBeforePreview,
  matchesInsetFocusRing,
  parseInsetFocusRingContract,
} from "./gate-shell-layout-contract.mjs";


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
const FOCUS_RING_CONTRACT = parseInsetFocusRingContract(
  readFileSync(resolve(WEB_ROOT, "src/design/tokens.css"), "utf8")
);

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
const FOCUS_ONLY = process.env.SHELL_GATE_FOCUS_ONLY === "1";

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

// 이벤트 구독 (#1202) is a list ON TOP OF a form, so its height is the sum of
// both and the phone column is where that stops fitting. One row carries the
// auto-disabled reason line, which is the tallest a row gets.
const EVENT_SUBSCRIPTIONS = [
  {
    id: "019f994c-6a00-7000-8000-000000000001",
    workspaceId: WORKSPACE_ID,
    url: "https://hooks.slack.com/services/T0/B0/oort-mentions",
    eventKinds: ["mention", "approval_request"],
    enabled: true,
    deliveryFailureCount: 0,
    createdBy: ME,
    updatedBy: ME,
    createdAtMs: Date.now() - 2 * 86_400_000,
    updatedAtMs: Date.now() - 2 * 86_400_000,
  },
  {
    id: "019f994c-6a00-7000-8000-000000000002",
    workspaceId: WORKSPACE_ID,
    url: "https://ops.dawnlab.example/oort/work-status",
    eventKinds: ["work.status_changed"],
    enabled: false,
    disabledReason: "server_5xx_threshold",
    deliveryFailureCount: 3,
    disabledAtMs: Date.now() - 21_600_000,
    createdBy: ME,
    updatedBy: ME,
    createdAtMs: Date.now() - 9 * 86_400_000,
    updatedAtMs: Date.now() - 21_600_000,
  },
];

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
  // ## 로그인 직후의 토큰 회전 (#1089 — 이 게이트가 baseline 에서 죽던 이유)
  //
  // 위의 포괄 스텁은 200 을 주지만 **모양이 틀렸다**. 이 한 경로에서는 모양이
  // load-bearing 이다:
  //
  //   DESK-1(`2ce728e2`)이 `hasPersistedSession` 을 `useSyncExternalStore` 로
  //   바꾼 뒤, 로그인이 세션을 저장하는 순간 `resumable` 이 true 로 뒤집혀 갓 발급된
  //   토큰을 한 번 회전시킨다. 그 POST 가 `{channels:[],...}` 를 받으면 코어의
  //   `refreshResponseFromWire`(packages/momo-core/src/lib/api.ts:632)가 두 필드의
  //   문자열 검사에서 throw 하고, 그 throw 는 `markAuthExpired()` 로 번역된다 —
  //   앱은 로그인하고, 셸을 잠깐 그린 뒤, **스스로 로그아웃한다.** 증상은 화면이
  //   아니라 여기였다: `signIn` 이 `channel-list` 를 30초 기다리다 죽는다.
  //
  // 실측(2026-08-06, origin/track/engine baseline): 로그인 200 직후
  // `POST /v1/auth/refresh` → 포괄 스텁의 `{channels:[]...}` → 로그인 화면 복귀.
  // 형제 게이트 12개는 전부 이 스텁을 갖고 있었고, 이 파일과 gate-my-sessions ·
  // gate-huddle 셋만 빠져 있었다(#1089 규명 1/4).
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
  await context.route("**/v1/workspaces/*/event-subscriptions", (route) =>
    json(route, { eventSubscriptions: EVENT_SUBSCRIPTIONS })
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
  await context.route("**/v1/workspaces/*/work-sessions", (route) =>
    json(route, { sessions: [] })
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
  await advanceToAccount(page);
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
 * #1291 desktop focus mode. The assertion is geometry + focus, not only the
 * presence of a button: the surviving rail must stay 56px, the route must gain
 * the channel/profile pane's actual 184px, and every focus target inside that
 * hidden pane must leave both the visual and keyboard paths.
 *
 * 56px 는 `[data-testid="workspace-rail"]` (`w-rail` / `--spacing-rail`) 이다.
 * 안쪽 `[aria-label="워크스페이스"]` nav 는 44px 타일(`--spacing-rail-tile`)만
 * 감싸므로, 그 폭을 재면 레일 단정이 타일 폭을 재게 된다. 56 숫자는 그대로다.
 *
 * The work-session pane then covers the newly widened chat surface. This is the
 * seam `/work` uses after #1290 lands too: both are children of the same second
 * shell track, so no route-specific width is inferred here.
 */
async function assertDesktopSidebarFocusMode(page, size) {
  const collapse = page.getByTestId("sidebar-collapse");
  await collapse.waitFor({ state: "visible" });
  const before = await page.evaluate(`(() => {
    const shell = document.querySelector(".app-shell");
    const sidebar = document.querySelector('[data-testid="sidebar"]');
    const main = shell?.querySelector("main");
    const rail = document.querySelector('[data-testid="workspace-rail"]');
    const button = document.querySelector('[data-testid="sidebar-collapse"]');
    const rect = (element) => element ? Math.round(element.getBoundingClientRect().width) : null;
    return {
      collapsed: shell?.hasAttribute("data-sidebar-collapsed") ?? null,
      sidebarWidth: rect(sidebar),
      mainWidth: rect(main),
      railWidth: rect(rail),
      buttonText: button?.textContent?.trim(),
      buttonName: button?.getAttribute("aria-label"),
      buttonTitle: button?.getAttribute("title"),
      buttonHasIcon: Boolean(button?.querySelector("svg")),
      buttonControls: button?.getAttribute("aria-controls"),
      buttonExpanded: button?.getAttribute("aria-expanded"),
    };
  })()`);
  check(
    `${size.name} 접기 전 56px 레일 + 184px 채널 패널`,
    before.collapsed === false &&
      before.sidebarWidth === 240 &&
      before.railWidth === 56 &&
      before.buttonName === "탐색 패널 접기" &&
      before.buttonTitle === "탐색 패널 접기" &&
      before.buttonHasIcon === true &&
      before.buttonControls === "sidebar-channel-pane" &&
      before.buttonExpanded === "true",
    JSON.stringify(before)
  );

  // Open and widen FIRST, then mark both the panel root and a stable child.
  // A remount can reproduce text and geometry but cannot reproduce these
  // runtime-only markers, so their survival proves the same subtree remained.
  // TC-1 (#1758): 헤더는 도크다. WorkPanel 은 작업 콘솔 경유.
  await openWorkPanelViaConsole(page, { allowHashFallback: true });
  const workPanel = page.getByTestId("work-panel");
  await workPanel.waitFor({ state: "visible" });
  if (size.width >= 900) {
    const wide = page.getByTestId("work-panel-wide");
    await wide.waitFor({ state: "visible" });
    await wide.click();
  }
  const workMarker = `shell-focus-${size.name}`;
  await page.evaluate(`(() => {
    const panel = document.querySelector('[data-testid="work-panel"]');
    const subtree = panel?.querySelector("header");
    if (panel) panel.setAttribute("data-shell-gate-identity", ${JSON.stringify(workMarker)});
    if (subtree) subtree.setAttribute("data-shell-gate-subtree", ${JSON.stringify(workMarker)});
  })()`);
  const workSnapshot = () => page.evaluate(`(() => {
    const route = document.querySelector("#app-route");
    const panel = document.querySelector('[data-testid="work-panel"]');
    const toggle = document.querySelector('[data-testid="work-panel-wide"]');
    const subtree = panel?.querySelector("header");
    if (!route || !panel || !subtree) return { missing: true };
    const r = route.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    return {
      marker: panel.getAttribute("data-shell-gate-identity"),
      subtreeMarker: subtree.getAttribute("data-shell-gate-subtree"),
      routeWidth: Math.round(r.width),
      panelWidth: Math.round(p.width),
      sameEdges: Math.round(r.left) === Math.round(p.left) && Math.round(r.right) === Math.round(p.right),
      panelWide: panel.hasAttribute("data-wide"),
      widePressed: toggle?.getAttribute("aria-pressed"),
      wideToggleDisplay: toggle ? getComputedStyle(toggle).display : null,
    };
  })()`);
  const workBefore = await workSnapshot();
  check(
    `${size.name} 작업 세션 패널을 먼저 열어 wide 상태와 DOM identity를 잡는다`,
    workBefore.missing !== true &&
      workBefore.marker === workMarker &&
      workBefore.subtreeMarker === workMarker &&
      workBefore.panelWidth === workBefore.routeWidth &&
      workBefore.sameEdges === true &&
      (size.width >= 900
        ? workBefore.panelWide === true &&
          workBefore.widePressed === "true" &&
          workBefore.wideToggleDisplay !== "none"
        : workBefore.panelWide === false &&
          workBefore.widePressed === "false" &&
          workBefore.wideToggleDisplay === "none"),
    JSON.stringify(workBefore)
  );

  await collapse.click();
  await waitForPageCondition(
    page,
    'document.activeElement === document.querySelector(\'[data-testid="sidebar-expand"]\')'
  );
  const collapsed = await page.evaluate(`(() => {
    const shell = document.querySelector(".app-shell");
    const sidebar = document.querySelector('[data-testid="sidebar"]');
    const pane = document.querySelector('[data-testid="sidebar-channel-pane"]');
    const main = shell?.querySelector("main");
    const rail = document.querySelector('[data-testid="workspace-rail"]');
    const expand = document.querySelector('[data-testid="sidebar-expand"]');
    const focusable = pane ? Array.from(pane.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter((element) => element.getClientRects().length > 0) : [];
    const width = (element) => element ? Math.round(element.getBoundingClientRect().width) : null;
    return {
      collapsed: shell?.hasAttribute("data-sidebar-collapsed") ?? null,
      sidebarWidth: width(sidebar),
      mainWidth: width(main),
      railWidth: width(rail),
      paneDisplay: pane ? getComputedStyle(pane).display : null,
      visiblePaneFocusTargets: focusable.length,
      focus: document.activeElement?.getAttribute("data-testid"),
      expandText: expand?.textContent?.trim(),
      expandName: expand?.getAttribute("aria-label"),
      expandTitle: expand?.getAttribute("title"),
      expandHasIcon: Boolean(expand?.querySelector("svg")),
      expandControls: expand?.getAttribute("aria-controls"),
      expandExpanded: expand?.getAttribute("aria-expanded"),
    };
  })()`);
  check(
    `${size.name} 접으면 레일만 남고 본문이 정확히 184px 넓어진다`,
    collapsed.collapsed === true &&
      collapsed.sidebarWidth === 56 &&
      collapsed.railWidth === 56 &&
      collapsed.mainWidth - before.mainWidth === 184 &&
      collapsed.paneDisplay === "none" &&
      collapsed.visiblePaneFocusTargets === 0 &&
      collapsed.focus === "sidebar-expand" &&
      collapsed.expandText?.includes("열기") &&
      collapsed.expandName === "탐색 패널 열기" &&
      collapsed.expandTitle === "탐색 패널 열기" &&
      collapsed.expandHasIcon === true &&
      collapsed.expandControls === "sidebar-channel-pane" &&
      collapsed.expandExpanded === "false",
    JSON.stringify({ before, collapsed })
  );

  const workCollapsed = await workSnapshot();
  check(
    `${size.name} 접는 동안 같은 WorkPanel subtree와 wide 상태가 184px를 이어받는다`,
    workCollapsed.missing !== true &&
      workCollapsed.marker === workMarker &&
      workCollapsed.subtreeMarker === workMarker &&
      workCollapsed.panelWide === workBefore.panelWide &&
      workCollapsed.widePressed === workBefore.widePressed &&
      workCollapsed.panelWidth - workBefore.panelWidth === 184 &&
      workCollapsed.routeWidth - workBefore.routeWidth === 184 &&
      workCollapsed.panelWidth === workCollapsed.routeWidth &&
      workCollapsed.sameEdges === true,
    JSON.stringify({ workBefore, workCollapsed })
  );
  await page.screenshot({ path: `${OUT_DIR}/${size.name}-chat-focus-work-wide.png` });

  await page.getByTestId("sidebar-expand").click();
  await waitForPageCondition(
    page,
    'document.activeElement === document.querySelector(\'[data-testid="sidebar-collapse"]\')'
  );
  const reopened = await page.evaluate(`(() => {
    const shell = document.querySelector(".app-shell");
    const pane = document.querySelector('[data-testid="sidebar-channel-pane"]');
    return {
      collapsed: shell?.hasAttribute("data-sidebar-collapsed") ?? null,
      sidebarWidth: Math.round(document.querySelector('[data-testid="sidebar"]').getBoundingClientRect().width),
      mainWidth: Math.round(shell.querySelector("main").getBoundingClientRect().width),
      paneDisplay: getComputedStyle(pane).display,
      focus: document.activeElement?.getAttribute("data-testid"),
    };
  })()`);
  check(
    `${size.name} 다시 열면 240px 셸과 접기 버튼 포커스가 복구된다`,
    reopened.collapsed === false &&
      reopened.sidebarWidth === 240 &&
      collapsed.mainWidth - reopened.mainWidth === 184 &&
      reopened.paneDisplay !== "none" &&
      reopened.focus === "sidebar-collapse",
    JSON.stringify(reopened)
  );

  const workReopened = await workSnapshot();
  check(
    `${size.name} 다시 여는 동안에도 같은 WorkPanel subtree·wide·원래 geometry가 남는다`,
    workReopened.missing !== true &&
      workReopened.marker === workMarker &&
      workReopened.subtreeMarker === workMarker &&
      workReopened.panelWide === workBefore.panelWide &&
      workReopened.widePressed === workBefore.widePressed &&
      workReopened.panelWidth === workBefore.panelWidth &&
      workReopened.routeWidth === workBefore.routeWidth &&
      workReopened.sameEdges === true,
    JSON.stringify({ workBefore, workReopened })
  );
  await page.getByTestId("work-panel-close").click();

  // Route changes preserve the in-memory shell choice; they must not silently
  // reopen the pane. WorkPanel's DOM continuity was already proved above, while
  // the route itself intentionally changes subtree here.
  await page.getByTestId("sidebar-collapse").click();
  await waitForPageCondition(
    page,
    'document.activeElement === document.querySelector(\'[data-testid="sidebar-expand"]\')'
  );
  await go(page, "/inbox");
  const afterRoute = await page.evaluate(`(() => ({
    collapsed: document.querySelector(".app-shell")?.hasAttribute("data-sidebar-collapsed"),
    paneDisplay: getComputedStyle(document.querySelector('[data-testid="sidebar-channel-pane"]')).display,
    focus: document.activeElement?.getAttribute("data-testid"),
  }))()`);
  check(
    `${size.name} 라우트 변경 뒤에도 현재 셸 선택과 포커스가 유지된다`,
    afterRoute.collapsed === true &&
      afterRoute.paneDisplay === "none" &&
      afterRoute.focus === "sidebar-expand",
    JSON.stringify(afterRoute)
  );
  await go(page, `/c/${GENERAL_ID}`);
  await page.getByTestId("sidebar-expand").click();
  await waitForPageCondition(
    page,
    'document.activeElement === document.querySelector(\'[data-testid="sidebar-collapse"]\')'
  );
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
 *
 * Red proof for the blocked-decision legibility: put the 0선택 branch back on
 * `opacity-50` instead of the quiet accent surface, rebuild, run this gate. The
 * 선택 0개 assertion fails at all three sizes in BOTH schemes with
 * {"opacity":"0.5","dimmed":true}, which is exactly what shipped before
 * MOMO-642 R1 H-1 and what the label-text-only version of this check could not
 * see. The `contrast` field stays high there (5.72 light / 8.94 dark) because
 * getComputedStyle reports the un-composited pair: element opacity is a
 * separate multiplier the browser applies after, which is why the assertion
 * reads opacity and the token pair together rather than the number alone. The
 * composited truth behind that 0.5 is 2.20:1 light / 3.21:1 dark.
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
  // 0선택 상태에서 "왜 못 하는가"를 말하는 문장은 이 라벨 하나뿐이다. 그것이
  // 읽히는지까지 재지 않으면, 이 단정은 문장이 opacity-50으로 2.20:1까지
  // 내려가도 통과한다(MOMO-642 R1 H-1이 실제로 그렇게 통과했다). 그래서 여기서
  // 읽는 것은 실제 합성 결과다: 요소 opacity가 1이고, 계산된 전경/배경 쌍의
  // WCAG 대비가 AA를 넘어야 한다. 토큰 쌍 자체(--ink x --accent-soft)는
  // tokens.contrast.test.ts가 두 스킴에서 재고, 이 게이트는 그 쌍이 실제로 이
  // 버튼에 도달했는지를 잰다.
  //
  // 측정 전 색 전이가 끝나기를 기다린다. 버튼은 transition-colors를 갖고 있고,
  // getComputedStyle은 전이 중이면 **보간된 현재 프레임**을 돌려준다. 마지막
  // 체크를 해제한 직후에 재면 아직 --accent에 가까운 중간색이 나와서, 이 단정은
  // 실제 색이 무엇이든 클릭 직후의 잔상을 재게 된다(실측: 해제 직후 rgb(240 168
  // 80) = --accent). 기본 전이는 150ms이므로 그 두 배 넘게 기다린다.
  await page.waitForTimeout(400);
  const blockedConfirm = await page.evaluate(`(() => {
    const button = document.querySelector('[data-testid="plugin-scope-confirm"]');
    if (!button) return { missing: true };
    const style = getComputedStyle(button);
    const parse = (value) => value
      .slice(value.indexOf("(") + 1, value.indexOf(")"))
      .split(",")
      .slice(0, 3)
      .map((part) => Number(part.trim()));
    const luminance = (channels) => {
      const [r, g, b] = channels.map((value) => {
        const s = value / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const fg = luminance(parse(style.color));
    const bg = luminance(parse(style.backgroundColor));
    const [hi, lo] = fg > bg ? [fg, bg] : [bg, fg];
    return {
      label: button.textContent,
      ariaDisabled: button.getAttribute("aria-disabled"),
      opacity: style.opacity,
      dimmed: button.classList.contains("opacity-50"),
      color: style.color,
      background: style.backgroundColor,
      contrast: Number(((hi + 0.05) / (lo + 0.05)).toFixed(2)),
    };
  })()`);
  check(
    `${size.name} 선택 0개면 고정 액션이 필요한 다음 행동을 읽히게 말한다`,
    blockedConfirm.missing !== true &&
      blockedConfirm.label?.includes("권한을 하나 이상 선택") === true &&
      blockedConfirm.ariaDisabled === "true" &&
      blockedConfirm.dimmed === false &&
      blockedConfirm.opacity === "1" &&
      blockedConfirm.contrast >= 4.5,
    JSON.stringify(blockedConfirm)
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
    `${size.name} Tab 랩 뒤 첫 체크박스 인셋 포커스 링과 위쪽 여백이 남는다`,
    wrappedFocus.missing !== true &&
      wrappedFocus.gapAboveElement >= 4 &&
      matchesInsetFocusRing(wrappedFocus, FOCUS_RING_CONTRACT),
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

  await assertDesktopSidebarFocusMode(page, size);
  if (FOCUS_ONLY) {
    await context.close();
    return;
  }

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
    ["/settings?section=webhooks", "설정 웹훅", "settings-webhooks"],
    ["/settings?section=events", "설정 이벤트 구독", "settings-events"],
  ]) {
    await go(page, hash);
    await assertShellHeld(page, `${size.name} ${label}`, `${size.name}-${shot}`);
  }

  await assertPluginScopeConsent(page, size);

  // Clipping without scrolling would be the worse bug: the settings body pane
  // must still reach its last control, and doing so must not move the shell.
  // Four sections are asked, because they overflow for different reasons: 멤버와
  // 초대 by row count, 코드 실행 호스트 (MOMO-617) by carrying three blocks, and
  // 웹훅·이벤트 구독 (#1202) for the two reasons written beside them below.
  //
  // The code section's last control is the workspace-scope SAVE button, not the
  // target select above it: since R2 both policy scopes commit explicitly, and
  // a fold check that stops one control short is a fold check that passes while
  // the button nobody can reach is the one that writes the ledger.
  for (const [hash, label, shot, selector] of [
    ["/settings?section=members", "멤버와 초대", "settings-bottom", "invite-create"],
    ["/settings?section=code", "코드 실행 호스트", "settings-code-bottom", "work-tier-save-workspace"],
    // 웹훅(#1202)이 셋째인 이유는 또 다른 방식으로 넘치기 때문이다: 목록 위에
    // 발급 카드가 끼어들 수 있고, 그 아래로 폼 전체와 참고 자료 disclosure 가
    // 이어진다.
    //
    // 재는 것은 `webhook-ingress-notes` 다. 처음에는 발급 버튼을 적었는데 그것은
    // **마지막 컨트롤이 아니었고**(disclosure 가 폼 뒤에 온다), 그래서 이 검사는
    // 자기 바로 옆에서 폴드 3px 아래로 떨어져 있던 요소를 보지 못했다
    // (#1205 리뷰 H4, 실측 top=803 / viewport=800). 마지막 것을 재지 않는
    // 도달 검사는 도달을 재지 않는다.
    ["/settings?section=webhooks", "웹훅", "settings-webhooks-bottom", "webhook-ingress-notes"],
    // 이벤트 구독 (#1202) overflows for a fourth reason: a list and a form stacked,
    // where the form's commit is the LAST control. If that button cannot be
    // reached, the panel can be read and never used.
    ["/settings?section=events", "이벤트 구독", "settings-events-bottom", "event-subscription-create"],
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

/**
 * A desktop collapse must never become a half-empty phone drawer after resize.
 * The drawer keeps its original scrim/Escape/focus-return contract, and a fresh
 * shell mount starts expanded because #1291 deliberately has no persistence.
 */
async function measureSidebarDrawerIndependence(browser) {
  const context = await browser.newContext({
    viewport: { width: 760, height: 700 },
    colorScheme: SCHEME,
    reducedMotion: "reduce",
  });
  await installMocks(context);
  const page = await context.newPage();
  await page.goto(ORIGIN, { waitUntil: "networkidle" });
  await signIn(page);
  await page.getByTestId("sidebar-collapse").click();
  await waitForPageCondition(
    page,
    'document.activeElement === document.querySelector(\'[data-testid="sidebar-expand"]\')'
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const narrowBeforeOpen = await page.evaluate(`(() => {
    const shell = document.querySelector(".app-shell");
    const pane = document.querySelector('[data-testid="sidebar-channel-pane"]');
    return {
      shellColumns: getComputedStyle(shell).gridTemplateColumns,
      paneDisplay: getComputedStyle(pane).display,
      collapseCount: document.querySelectorAll('[data-testid="sidebar-collapse"]').length,
      expandCount: document.querySelectorAll('[data-testid="sidebar-expand"]').length,
      drawerOpen: document.querySelector('[data-testid="sidebar"]')?.hasAttribute("data-open"),
      focus: document.activeElement?.getAttribute("data-testid"),
    };
  })()`);
  check(
    "390px 모바일은 데스크톱 접힘 상태를 무시하고 기존 서랍을 준비한다",
    narrowBeforeOpen.shellColumns === "390px" &&
      narrowBeforeOpen.paneDisplay !== "none" &&
      narrowBeforeOpen.collapseCount === 0 &&
      narrowBeforeOpen.expandCount === 0 &&
      narrowBeforeOpen.drawerOpen === false &&
      narrowBeforeOpen.focus === "open-sidebar-drawer",
    JSON.stringify(narrowBeforeOpen)
  );

  const opener = page.getByTestId("open-sidebar-drawer");
  await opener.click();
  await waitForPageCondition(
    page,
    'document.activeElement === document.querySelector(\'[data-testid="close-sidebar-drawer"]\')'
  );
  const drawerOpen = await page.evaluate(`(() => {
    const sidebar = document.querySelector('[data-testid="sidebar"]');
    const pane = document.querySelector('[data-testid="sidebar-channel-pane"]');
    return {
      open: sidebar?.hasAttribute("data-open"),
      sidebarWidth: Math.round(sidebar.getBoundingClientRect().width),
      paneDisplay: getComputedStyle(pane).display,
      paneWidth: Math.round(pane.getBoundingClientRect().width),
      scrim: Boolean(document.querySelector('[data-testid="sidebar-scrim"]')),
      focus: document.activeElement?.getAttribute("data-testid"),
    };
  })()`);
  check(
    "390px 모바일 서랍은 전체 채널/프로필 패널과 기존 포커스 첫 정거장을 연다",
    drawerOpen.open === true &&
      drawerOpen.sidebarWidth === 280 &&
      drawerOpen.paneDisplay !== "none" &&
      drawerOpen.paneWidth === 224 &&
      drawerOpen.scrim === true &&
      drawerOpen.focus === "close-sidebar-drawer",
    JSON.stringify(drawerOpen)
  );
  await page.screenshot({ path: `${OUT_DIR}/390x844-drawer-independent.png` });

  await page.keyboard.press("Escape");
  await waitForPageCondition(
    page,
    'document.activeElement === document.querySelector(\'[data-testid="open-sidebar-drawer"]\')'
  );
  const drawerClosed = await page.evaluate(`(() => ({
    open: document.querySelector('[data-testid="sidebar"]')?.hasAttribute("data-open"),
    scrim: Boolean(document.querySelector('[data-testid="sidebar-scrim"]')),
    focus: document.activeElement?.getAttribute("data-testid"),
  }))()`);
  check(
    "390px 모바일 Escape는 기존처럼 서랍을 닫고 opener로 포커스를 돌린다",
    drawerClosed.open === false &&
      drawerClosed.scrim === false &&
      drawerClosed.focus === "open-sidebar-drawer",
    JSON.stringify(drawerClosed)
  );

  // A remount is the observable persistence boundary. Authentication may be
  // restored from its own session store, but the shell preference must not be:
  // wait for whichever legitimate post-reload surface appears, then inspect
  // the newly mounted AppShell without introducing storage for this feature.
  await page.setViewportSize({ width: 760, height: 700 });
  await waitForPageCondition(
    page,
    'document.activeElement === document.querySelector(\'[data-testid="sidebar-expand"]\')'
  );
  const returnedWide = await page.evaluate(`(() => ({
    collapsed: document.querySelector(".app-shell")?.hasAttribute("data-sidebar-collapsed"),
    paneDisplay: getComputedStyle(document.querySelector('[data-testid="sidebar-channel-pane"]')).display,
    focus: document.activeElement?.getAttribute("data-testid"),
  }))()`);
  check(
    "모바일에서 다시 넓어지면 숨은 opener 대신 현재 데스크톱 토글이 포커스를 받는다",
    returnedWide.collapsed === true &&
      returnedWide.paneDisplay === "none" &&
      returnedWide.focus === "sidebar-expand",
    JSON.stringify(returnedWide)
  );

  // The handoff above is recovery, not a general resize autofocus rule. If the
  // route already owns a visible focus target, both breakpoint crossings leave
  // it there instead of pulling the reader back into navigation.
  await page.getByTestId("composer-input").focus();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const visibleRouteFocusNarrow = await page.evaluate(`(() => ({
    focus: document.activeElement?.getAttribute("data-testid"),
    focusVisible: document.activeElement instanceof HTMLElement && document.activeElement.getClientRects().length > 0,
    openerFocused: document.activeElement === document.querySelector('[data-testid="open-sidebar-drawer"]'),
  }))()`);
  check(
    "390px 전환 때 route의 가시 포커스는 탐색 opener가 빼앗지 않는다",
    visibleRouteFocusNarrow.focus === "composer-input" &&
      visibleRouteFocusNarrow.focusVisible === true &&
      visibleRouteFocusNarrow.openerFocused === false,
    JSON.stringify(visibleRouteFocusNarrow)
  );
  await page.setViewportSize({ width: 760, height: 700 });
  await page.waitForTimeout(300);
  const visibleRouteFocusWide = await page.evaluate(`(() => ({
    focus: document.activeElement?.getAttribute("data-testid"),
    focusVisible: document.activeElement instanceof HTMLElement && document.activeElement.getClientRects().length > 0,
  }))()`);
  check(
    "760px 복귀 때도 route의 가시 포커스를 데스크톱 토글이 빼앗지 않는다",
    visibleRouteFocusWide.focus === "composer-input" &&
      visibleRouteFocusWide.focusVisible === true,
    JSON.stringify(visibleRouteFocusWide)
  );

  await page.reload({ waitUntil: "networkidle" });
  await waitForPageCondition(
    page,
    'document.querySelector(\'[data-testid="channel-list"]\') || document.querySelector(\'[data-testid="onboarding-landing"]\') || document.querySelector(\'[data-testid="onboarding-gateway"]\') || document.querySelector(\'[data-testid="onboarding-account"]\')'
  );
  if (await page.getByTestId("channel-list").isVisible().catch(() => false)) {
    await page.getByTestId("channel-list").waitFor({ state: "visible" });
  } else {
    await signIn(page);
  }
  const remounted = await page.evaluate(`(() => ({
    collapsed: document.querySelector(".app-shell")?.hasAttribute("data-sidebar-collapsed"),
    sidebarWidth: Math.round(document.querySelector('[data-testid="sidebar"]').getBoundingClientRect().width),
    paneDisplay: getComputedStyle(document.querySelector('[data-testid="sidebar-channel-pane"]')).display,
    expandCount: document.querySelectorAll('[data-testid="sidebar-expand"]').length,
  }))()`);
  check(
    "새 셸 마운트에는 접힘 상태가 저장되지 않는다",
    remounted.collapsed === false &&
      remounted.sidebarWidth === 240 &&
      remounted.paneDisplay !== "none" &&
      remounted.expandCount === 0,
    JSON.stringify(remounted)
  );
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
  const landingChoice = page.getByTestId("onboarding-choose-server");
  await landingChoice.waitFor({ state: "visible" });
  await landingChoice.scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  const landingReach = await page.evaluate(`(() => {
    const r = document.querySelector('[data-testid="onboarding-choose-server"]').getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom),
             viewportHeight: window.innerHeight,
             reached: r.top >= 0 && r.bottom <= window.innerHeight };
  })()`);
  check("연결 화면 짧은 창에서 S0 선택 도달", landingReach.reached === true, JSON.stringify(landingReach));
  await page.screenshot({ path: `${OUT_DIR}/connect-landing-short-window.png` });
  await advanceToAccount(page);
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

async function main() {
  await buildExactSourceBeforePreview({ webRoot: WEB_ROOT });
  mkdirSync(OUT_DIR, { recursive: true });

  const server = await startGuardedPreview({
    webRoot: WEB_ROOT,
    port: PORT,
    portEnvVar: "SHELL_GATE_PORT",
  });
  const shutdown = () => server.child.kill("SIGTERM");
  process.on("exit", shutdown);

  try {
    const browser = await chromium.launch();
    try {
      for (const size of SIZES) await measureSize(browser, size);
      await measureSidebarDrawerIndependence(browser);
      if (!FOCUS_ONLY) {
        await measureTimeline(browser);
        await measureConnect(browser);
      }
    } finally {
      await browser.close();
    }
  } finally {
    await server.stop();
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
