#!/usr/bin/env node
// =============================================================================
// Dawn palette screenshot capture (MOMO-597 / ADR-0133 P1).
//
// Renders the real components against a mocked REST surface and captures every
// screen in BOTH color schemes, so light/dark can be reviewed side by side and
// regressions are visible. prefers-color-scheme is emulated at the browser
// level, which means the capture exercises the same CSS light-dark() path the
// product uses; nothing is themed specially for the screenshot.
//
//   npm run capture:design                    # -> artifacts/design/*.png
//   OUT_DIR=/tmp/shots npm run capture:design
//
// Go through the npm script, not this file directly: it builds `--mode design`,
// and that mode is what enables the `?agentwork=` capture seam. A release build
// (`npm run build`) answers null to that flag on purpose, so the two agent turn
// screens would shoot an empty sidebar against a production dist.
//
// No credentials and no backend are involved: /v1 is fulfilled from the
// fixtures below (realistic Korean+English team content, never "테스트 1").
// =============================================================================

import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR
  ? resolve(process.env.OUT_DIR)
  : resolve(WEB_ROOT, "artifacts/design");
const PORT = Number(process.env.CAPTURE_PORT || 5178);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const VIEWPORT = { width: 1280, height: 800 };

// 폰 프로파일 (goal B6). 390x844는 iPhone 14/15의 CSS 뷰포트이고, 이 티켓을 연
// 실캡처를 찍은 그 기기다. deviceScaleFactor 3 · hasTouch · isMobile까지 켜는
// 이유는 이 프로파일이 재는 것이 색이 아니라 **기하**이기 때문이다: 터치
// 타깃과 가로 오버플로는 포인터 컨텍스트에서는 측정되지 않는다.
const MOBILE_VIEWPORT = { width: 390, height: 844 };

/**
 * 폰에서 손가락으로 눌러야 하는 컨트롤과 그 최소 크기(px). 44px는 WCAG 2.5.5 /
 * Apple HIG의 값이고, tokens.css의 `tap-target`이 같은 수를 판다.
 *
 * 이 목록이 캡처 안에 있는 이유: 스크린샷은 버튼이 **작다**는 것을 보여주지
 * 않는다. 리뷰어가 픽셀을 재지 않으면 28px 버튼과 44px 버튼은 같은 그림이다.
 */
const MOBILE_TAP_TARGETS = [
  ["open-sidebar-drawer", "채널 목록 열기"],
  ["composer-send", "메시지 보내기"],
  ["composer-input", "컴포저 입력"],
];

// ADR-0134 계약 픽스처. 단위 테스트(routingModel.test.ts)와 라우팅 캡처가 이미
// 쓰는 그 파일이고, 여기서도 같은 것을 읽어 세 표면이 한 표를 본다.
const ROUTING_FIXTURES = JSON.parse(
  readFileSync(resolve(WEB_ROOT, "src/features/routing/routingFixtures.json"), "utf8")
);

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";
const GENERAL_ID = "00000000-0000-7000-8000-000000000201";
const ME = "019f94e3-7a10-79cd-9dee-208f47edd9a8";
const HERMES = "019f94e3-8b21-7ae0-b3c4-5f1a2d6e7c90";

const SESSION = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: {
    id: ME,
    workspaceId: WORKSPACE_ID,
    kind: "human",
    displayName: "곽성재",
    handle: "seongjae",
  },
  // Deliberately unreachable: the capture shows the disconnected/connecting
  // rail state rather than pretending the realtime rail is up.
  realtimeWebSocketUrl: `ws://127.0.0.1:${PORT + 900}/connection/websocket`,
};

const CHANNELS = [
  { id: GENERAL_ID, workspaceId: WORKSPACE_ID, kind: "public", name: "general", muted: false },
  { id: "00000000-0000-7000-8000-000000000202", workspaceId: WORKSPACE_ID, kind: "public", name: "엔진", muted: false },
  { id: "00000000-0000-7000-8000-000000000203", workspaceId: WORKSPACE_ID, kind: "private", name: "김인턴작업", muted: false },
  { id: "00000000-0000-7000-8000-000000000204", workspaceId: WORKSPACE_ID, kind: "public", name: "release-notes", muted: false },
];

// The DM the directory opens onto (MOMO-611). It is in the fixture so the
// sidebar renders its 다이렉트 메시지 section, including the 새 다이렉트 메시지
// entry point, in every frame below.
const DM_ID = "019f984d-b4a8-76fd-8fba-3b6e3390072d";
const DM_CHANNEL = {
  id: DM_ID,
  workspaceId: WORKSPACE_ID,
  kind: "dm",
  memberIds: [ME, HERMES],
  muted: false,
};

/** The id POST /channels answers with (MOMO-614): the app routes to it. */
const CREATED_CHANNEL_ID = "019f9b10-0000-7000-8000-000000000301";

const CHANNEL_IDS = CHANNELS.map((c) => c.id);

// Roster and read-state are what turn the timeline from raw ids into the actual
// design: the agent row is where --agent (predawn slate-blue) is visible at all,
// and the unread/mention badges are the only place --accent lands in the
// sidebar. Without these the capture would review a surface nobody ships.
const ROSTER = [
  {
    id: ME,
    workspaceId: WORKSPACE_ID,
    kind: "human",
    status: "active",
    role: "owner",
    displayName: "곽성재",
    handle: "seongjae",
    channelCount: CHANNEL_IDS.length,
    channelIds: CHANNEL_IDS,
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  },
  {
    id: HERMES,
    workspaceId: WORKSPACE_ID,
    kind: "agent",
    status: "active",
    role: "member",
    displayName: "hermes",
    handle: "hermes",
    channelCount: CHANNEL_IDS.length,
    channelIds: CHANNEL_IDS,
    capabilities: ["code"],
    ownerHumanId: ME,
    agentModel: "hermes-agent",
    createdAtMs: 0,
    updatedAtMs: 0,
  },
  // The directory (MOMO-611) is the first surface that renders the whole
  // roster, so the fixture carries a workspace rather than a pair: role
  // labels, the human/agent split, and a second agent attributed to a human.
  {
    id: "019f9a01-0000-7000-8000-000000000401",
    workspaceId: WORKSPACE_ID,
    kind: "human",
    status: "active",
    role: "admin",
    displayName: "박지훈",
    handle: "jihoon",
    channelCount: 2,
    channelIds: CHANNEL_IDS.slice(0, 2),
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  },
  {
    id: "019f9a01-0000-7000-8000-000000000402",
    workspaceId: WORKSPACE_ID,
    kind: "human",
    status: "active",
    role: "member",
    displayName: "김인턴",
    handle: "intern-kim",
    channelCount: 1,
    channelIds: [GENERAL_ID],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  },
  {
    id: "019f9a01-0000-7000-8000-000000000403",
    workspaceId: WORKSPACE_ID,
    kind: "human",
    status: "invited",
    role: "member",
    displayName: "Nadia Rahman",
    handle: "nadia",
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  },
  {
    id: "019f9a01-0000-7000-8000-000000000404",
    workspaceId: WORKSPACE_ID,
    kind: "agent",
    status: "active",
    role: "member",
    displayName: "김인턴",
    handle: "kim-intern",
    channelCount: 2,
    channelIds: CHANNEL_IDS.slice(0, 2),
    capabilities: ["code"],
    ownerHumanId: "019f9a01-0000-7000-8000-000000000401",
    agentModel: "hermes-agent",
    createdAtMs: 0,
    updatedAtMs: 0,
  },
];

const READ_STATES = [
  { channel_id: GENERAL_ID, last_read_seq: 1410, latest_seq: 1415, unread_count: 5, mention_count: 1 },
  { channel_id: CHANNELS[1].id, last_read_seq: 40, latest_seq: 42, unread_count: 2, mention_count: 0 },
  { channel_id: CHANNELS[2].id, last_read_seq: 12, latest_seq: 12, unread_count: 0, mention_count: 0 },
  { channel_id: CHANNELS[3].id, last_read_seq: 7, latest_seq: 7, unread_count: 0, mention_count: 0 },
  { channel_id: DM_ID, last_read_seq: 3, latest_seq: 3, unread_count: 0, mention_count: 0 },
];

// Four of these rows are typed agent events, not prose, so the capture shows
// the R-1 §4 agent cards (approval / tool run / settled turn cost) and the
// ADR-0135 D1 cascade notice in both schemes. The props are shaped exactly like
// the server's own (AgentGatewayRoutes.approvalRequestProps,
// WorkerService.toolResultProps, AgentGatewayRoutes.timelineProps,
// WorkerService.finalMessageProps), opaque fields included, so the capture also
// proves the redaction: `arguments` and `tool_grant` are present in the fixture
// and must not appear anywhere on screen.
//
// TWO settled turn records on purpose, because there are two executors and they
// mark themselves differently. Hand-writing only the gateway one is exactly how
// the cascade notice shipped structurally unrenderable (2026-07-26 merge review
// D1/F3): the rows a cascade actually lands on are written by the worker, which
// writes no `schema` key, and this capture agreed with the unit fixture instead
// of with the emitter. The cascade now rides the WORKER row here, which is the
// only row it can ride in production.
const BODIES = [
  [ME, "prometheus mem_limit 붙였어요. 야간 소크 돌려두고 아침에 그래프 확인합시다."],
  [ME, "relay outbox lag 지표가 p99에서 1.2s 근처인데, 배치 크기 조정 전에 원인부터 봅시다."],
  [HERMES, "로그를 읽었습니다. outbox drain 워커 1개가 재시작 루프에 있었고, 지금은 안정입니다."],
  [
    HERMES,
    "빌드 캐시를 정리하려 합니다.",
    "approval_request",
    {
      approval_id: "0199aa11-2222-7000-8000-0000000000a1",
      run_id: "0199aa11-2222-7000-8000-0000000000b2",
      action_type: "shell",
      tool_name: "shell",
      tier: "workspace_write",
      call_id: "call_9f31",
      title: "빌드 캐시 정리",
      summary: "빌드 산출물 디렉터리를 지웁니다. 진행 중인 빌드는 없습니다.",
      arguments: { command: "rm -rf build/", cwd: "/Users/dawn/projects/momo" },
      tool_grant: { grant_id: "g-31", scopes: ["shell:write"] },
      is_reversible: false,
      estimated_micro_usd: 12400,
      status: "pending",
      source: "hermes_gateway",
    },
  ],
  [ME, "좋아요, 승인할게요. 끝나면 seq 기준으로 복구 마커 남는지 확인 부탁해요."],
  [
    HERMES,
    "3개 디렉터리 삭제",
    "tool_result",
    {
      call_id: "call_9f31",
      tool_name: "shell",
      label: "빌드 캐시",
      approval_id: "0199aa11-2222-7000-8000-0000000000a1",
      run_id: "0199aa11-2222-7000-8000-0000000000b2",
      payload_sha256: "sha256:0199aa112222",
      output: { stdout: "removed 3 directories" },
      is_error: false,
      executor: "agentworker.resume_approval.v0",
    },
  ],
  [ME, "@hermes 다음은 clients/web 쪽 토큰 교체 diff 리뷰 부탁합니다."],
  [
    HERMES,
    "확인했습니다. 여명 팔레트 토큰만 사용하고 있고, 인디고 잔재는 없습니다.",
    "text",
    {
      // Gateway turn record (AgentGatewayRoutes.timelineProps). It is the only
      // shape that carries `usage`, so this is the row that renders the settled
      // turn cost card.
      schema: "momo.agent_gateway.timeline.v0",
      source: "hermes_gateway",
      status: "succeeded",
      run_id: "0199aa11-2222-7000-8000-0000000000c4",
      agent_member_id: HERMES,
      usage: {
        model: "claude-opus-4",
        prompt_tokens: 1240,
        completion_tokens: 380,
        cost_micro_usd: 12000,
        was_estimated: false,
      },
    },
  ],
  [ME, "@hermes 남은 세 파일도 같은 기준으로 봐주세요."],
  [
    HERMES,
    "남은 세 파일도 토큰만 씁니다. 하드코딩된 색은 없습니다.",
    "text",
    {
      // Worker turn record, transcribed from WorkerService.finalMessageProps.
      // No `schema` key: the worker does not write one, and inventing one here
      // would put this capture back to agreeing with the client instead of with
      // the emitter.
      //
      // The cascade fixture in src/features/timeline/cascadeRail.tsx keys its
      // seeded fallback off THIS run id, which is the only way the ADR-0135 D1
      // "2차 프로바이더로 처리됨" row can reach artifacts/design: the capture runs
      // with no socket, so the frame that normally carries it never arrives.
      // Change one and change the other.
      run_id: "0199aa11-2222-7000-8000-0000000000c3",
      source: "agent_worker.final_text.v0",
      trigger_message_id: "0199aa11-2222-7000-8000-0000000000d1",
      trigger_message_seq: 1412,
      author_member_id: ME,
      source_attribution: {
        source_id: "msg_0199aa11-2222-7000-8000-0000000000d1",
        kind: "message",
        title: "Message #1412",
        uri: `momo://workspaces/${WORKSPACE_ID}/channels/${GENERAL_ID}/messages/0199aa11-2222-7000-8000-0000000000d1`,
        workspace_id: WORKSPACE_ID,
        channel_id: GENERAL_ID,
        message_id: "0199aa11-2222-7000-8000-0000000000d1",
        message_seq: 1412,
        author_member_id: ME,
        permission_snapshot: "actor:channel_member agent:channel_member",
        excerpt: "@hermes 남은 세 파일도 같은 기준으로 봐주세요.",
      },
    },
  ],
];

function makeMessages(count) {
  const base = Date.now() - count * 60_000;
  return Array.from({ length: count }, (_, i) => {
    const [author, body, type, props] = BODIES[i % BODIES.length];
    return {
      id: `capture-${i + 1}`,
      channelId: GENERAL_ID,
      seq: 1400 + i,
      hlcTs: base + i * 60_000,
      hlcCount: 0,
      authorMemberId: author,
      type: type ?? "text",
      body,
      state: "sent",
      ...(props ? { props } : {}),
      createdAtMs: base + i * 60_000,
    };
  });
}

// 코드 실행 호스트 (MOMO-617). The registry is the block a review has to look
// at in both schemes: three status chips (온라인 / 오프라인 / 해지됨) side by
// side is where a status color that only works in one scheme would show.
//
// Shaped like the momowebqa ledger the R2 review measured, because that ledger
// is what exposed the defects. A host that pairs again writes a NEW row, so one
// display name repeats across rows and only the id tail separates them; revoked
// rows are never deleted; and the server returns creation order, so the usable
// hosts do not arrive first. The array is in that server order on purpose,
// which makes the shot prove the panel sorts rather than getting lucky.
const REVOKED_TARGET = "019f99a0-8ac1-77b0-948b-210e791c6238";
const WORK_HOSTS = [
  {
    id: "019f999c-6845-79cd-841d-22f20d098c61",
    workspaceId: WORKSPACE_ID,
    scope: "member",
    ownerMemberId: ME,
    type: "app",
    displayName: "성재 iMac, 집 작업실",
    publicKey: "capture-only-not-a-credential",
    capabilities: { terminal: true },
    revokedAtMs: Date.now() - 3 * 86_400_000,
    createdAtMs: Date.now() - 30 * 86_400_000,
    online: false,
  },
  {
    id: REVOKED_TARGET,
    workspaceId: WORKSPACE_ID,
    scope: "member",
    ownerMemberId: ME,
    type: "app",
    displayName: "성재 iMac, 집 작업실",
    publicKey: "capture-only-not-a-credential",
    capabilities: { terminal: true },
    revokedAtMs: Date.now() - 2 * 86_400_000,
    createdAtMs: Date.now() - 20 * 86_400_000,
    online: false,
  },
  {
    id: "019f994c-4ed0-76a9-9d43-a9bde45b8fcd",
    workspaceId: WORKSPACE_ID,
    scope: "member",
    ownerMemberId: ME,
    type: "app",
    displayName: "성재 MacBook Pro",
    publicKey: "capture-only-not-a-credential",
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
    publicKey: "capture-only-not-a-credential",
    capabilities: { terminal: true },
    lastSeenAtMs: Date.now() - 3 * 3_600_000,
    createdAtMs: Date.now() - 7 * 86_400_000,
    online: false,
  },
];

// 설정 > AI 연결 (MOMO-627 / ADR-0135 D1). The singleton head plus four fallback
// hops, because those five rows are what the block has to keep apart on screen:
// a head that is read-only here, a live fallback, a hop the operator switched
// off, a hop whose key the provider rejects, and a hop in a mock mode (the
// self-host default, and the row that must NOT read as a failure). Bearers are
// masked tails, exactly as the API answers (ADR-0004: the key never leaves the
// server).
const PROVIDER_LINK = {
  schema: "momo.provider_link.v0",
  configured: true,
  source: "database",
  mode: "external-hermes",
  baseUrl: "https://api.anthropic.com/v1",
  endpointLabel: "api.anthropic.com",
  bearerConfigured: true,
  bearerLast4: "8f21",
  availability: "live",
  keyConfigured: true,
  updatedAtMs: Date.now() - 6 * 3_600_000,
  diagnostics: [],
};

const PROVIDER_CHAIN = {
  schema: "momo.provider_link.chain.v0",
  entries: [
    {
      position: 0,
      source: "provider_link",
      mode: "external-hermes",
      baseUrl: PROVIDER_LINK.baseUrl,
      endpointLabel: PROVIDER_LINK.endpointLabel,
      enabled: true,
      bearerConfigured: true,
      bearerLast4: "8f21",
      updatedAtMs: PROVIDER_LINK.updatedAtMs,
    },
    {
      position: 1,
      source: "chain",
      mode: "external-hermes",
      baseUrl: "https://gateway.dawn.internal:8443/v1",
      endpointLabel: "gateway.dawn.internal:8443",
      enabled: true,
      bearerConfigured: true,
      bearerLast4: "c40a",
      updatedAtMs: Date.now() - 2 * 3_600_000,
    },
    {
      position: 2,
      source: "chain",
      mode: "external-hermes",
      baseUrl: "https://backup.dawn.internal/v1",
      endpointLabel: "backup.dawn.internal",
      enabled: false,
      bearerConfigured: true,
      bearerLast4: "1b77",
    },
    {
      position: 3,
      source: "chain",
      mode: "external-hermes",
      baseUrl: "https://relay.dawn.internal/v1",
      endpointLabel: "relay.dawn.internal",
      enabled: true,
      bearerConfigured: true,
      bearerLast4: "9e03",
    },
    {
      position: 4,
      source: "chain",
      mode: "local-mock",
      baseUrl: "http://127.0.0.1:8088/v1",
      endpointLabel: "127.0.0.1:8088",
      enabled: true,
      bearerConfigured: true,
      bearerLast4: "0000",
    },
  ],
  // `entries.count - 1`: fallbacks only. `ProviderCascade.attemptable` filters
  // the WHOLE plan, so the head counts there and the parked hop does not, which
  // is why the summary sentence has to name what it is counting.
  fallbackCount: 4,
  attemptableCount: 4,
};

// The same body with one entry this client cannot read: position 2 lost its
// `baseUrl`. A 200 does not rule that out (a proxy, a dev catch-all or a later
// schema can all produce it), and the panel's answer to it is not cosmetic.
// `PUT /v1/provider/link/chain` replaces the whole fallback list, so a hop that
// never reached the draft is one the next save deletes from the server together
// with the key stored at its position. The block goes read-only, names the
// entry by its place in the answer, and states no count it cannot show.
const PROVIDER_CHAIN_PARTIAL = {
  ...PROVIDER_CHAIN,
  entries: PROVIDER_CHAIN.entries.map((entry, index) => {
    if (index !== 2) return entry;
    const rest = { ...entry };
    delete rest.baseUrl;
    return rest;
  }),
};

// A fresh self-host instance: no operator link, so the head is the boot-time
// HERMES_* env trio pointed at the bundled mock. This is what momowebqa answers
// today, and the state the panel must describe as a MODE rather than a failure.
const MOCK_ONLY_HOP = {
  position: 0,
  source: "environment",
  mode: "local-mock",
  baseUrl: "http://127.0.0.1:8088/v1",
  endpointLabel: "127.0.0.1:8088",
  enabled: true,
  bearerConfigured: true,
  bearerLast4: "0000",
};

// The probe result a review has to look at: the head fell over, the second hop
// answered, the parked hop was skipped, the fourth hop's key was rejected, and
// the fifth is in a mock mode the probe declines to call at all. Every
// disposition the server can emit, in one frame, with the tone each has to be
// drawn in. `cascadeOk: true` because a cascade that fell over to a working
// provider is the cascade doing its job.
const PROVIDER_PROBE = {
  schema: "momo.provider_link.test.v0",
  ok: false,
  reason: "provider_unreachable",
  source: "database",
  mode: "external-hermes",
  endpointLabel: PROVIDER_LINK.endpointLabel,
  checkedAtMs: Date.now(),
  cascadeOk: true,
  entries: [
    {
      position: 0,
      source: "provider_link",
      mode: "external-hermes",
      endpointLabel: "api.anthropic.com",
      enabled: true,
      ok: false,
      reason: "provider_unreachable",
      disposition: "fall_over",
    },
    {
      position: 1,
      source: "chain",
      mode: "external-hermes",
      endpointLabel: "gateway.dawn.internal:8443",
      enabled: true,
      ok: true,
      disposition: "ok",
    },
    {
      position: 2,
      source: "chain",
      mode: "external-hermes",
      endpointLabel: "backup.dawn.internal",
      enabled: false,
      ok: false,
      reason: "hop_disabled",
      disposition: "skipped",
    },
    {
      position: 3,
      source: "chain",
      mode: "external-hermes",
      endpointLabel: "relay.dawn.internal",
      enabled: true,
      ok: false,
      // 401/403. A caller error does NOT fall over: the next provider would
      // fail the same way, so the cascade stops here (--danger).
      reason: "provider_auth_failed",
      disposition: "propagate",
    },
    {
      position: 4,
      source: "chain",
      mode: "local-mock",
      endpointLabel: "127.0.0.1:8088",
      enabled: true,
      ok: false,
      // `probeHop` returns before calling anything for a non-external mode. It
      // arrives as `propagate`, but nothing failed and nothing was measured, so
      // this row is muted 목 모드 and is excluded from the headline's counts.
      reason: "not_external_provider",
      disposition: "propagate",
    },
  ],
};

// WorkTierPolicyRoutes.loadPolicy answers /me out of the workspace row when the
// member has no row of their own, so an inherited member policy carries the
// DEFAULT's mode, target and updated_at, and differs only in member_id and
// inherited. A review screenshot that shows 상속 중 next to a different mode is
// a screen the server cannot produce, which makes the shot worse than no shot.
const WORKSPACE_TIER_POLICY = {
  workspaceId: WORKSPACE_ID,
  mode: "auto",
  autoTarget: "019f994c-4ee2-74f5-80f1-44408e9a2b82",
  inherited: false,
  updatedAtMs: Date.now() - 3_600_000,
};

// The member has their OWN row here, pointing at a host that was revoked after
// the policy was written. That is the live momowebqa state and it is the one a
// review has to see: the server answers 409 for this target, so the panel is
// describing a policy that cannot run, and the shot is where you check that it
// says so in --danger instead of a muted footnote (SKILL §5 / §8).
const MEMBER_TIER_POLICY = {
  workspaceId: WORKSPACE_ID,
  memberId: ME,
  mode: "auto",
  autoTarget: REVOKED_TARGET,
  inherited: false,
  updatedAtMs: Date.now() - 40 * 60_000,
};

/** The DM the directory opens onto: a short 1:1 with the agent, not a channel. */
function makeDmMessages() {
  const base = Date.now() - 3 * 60_000;
  return [
    [ME, "어제 올린 relay 패치, DM으로 짧게만 확인할게요. 롤백 절차는 그대로죠?"],
    [HERMES, "그대로입니다. outbox 재처리 스크립트만 먼저 돌리면 됩니다."],
    [ME, "좋아요. 배포 끝나면 여기로 결과만 남겨주세요."],
  ].map(([author, body], i) => ({
    id: `capture-dm-${i + 1}`,
    channelId: DM_ID,
    seq: i + 1,
    hlcTs: base + i * 60_000,
    hlcCount: 0,
    authorMemberId: author,
    type: "text",
    body,
    state: "sent",
    createdAtMs: base + i * 60_000,
  }));
}

// ---- 에이전트 허브 (goal B5.3b) ---------------------------------------------
// 세 표면이 여기서 처음 화면에 오른다: 프로필 카드(모델·추론 강도·상태), 채널
// 배치, 그리고 만들기 폼. allowed-models가 200이라는 것은 이 서버에 프로필 쓰기와
// 일시정지가 있다는 뜻이고(capability.ts ④), 그래서 편집 컨트롤이 열린 프레임과
// 404로 잠긴 프레임을 둘 다 찍는다.

const AGENT_PROFILE = {
  agentMemberId: HERMES,
  workspaceId: WORKSPACE_ID,
  instructions:
    "배포 전에는 롤백 절차부터 확인하고, 근거가 없는 추정은 추정이라고 먼저 말합니다.",
  modelPref: "hermes-agent",
  enabledTools: ["shell", "git"],
  triggers: { mention: true },
  paused: false,
  version: 3,
  updatedBy: ME,
  updatedAtMs: Date.now() - 6 * 3_600_000,
};

const ALLOWED_AGENT_MODELS = ["hermes-agent", "hermes-agent-mini"];

/** The id POST /agents answers with: the hub selects it right after. */
const CREATED_AGENT_ID = "019f9b10-0000-7000-8000-0000000004a1";

/** 결정 대기 (D-5). snake_case on the wire, the way the ledger projects it. */
const APPROVALS = [
  {
    id: "019f9b10-0000-7000-8000-0000000005a1",
    workspace_id: WORKSPACE_ID,
    run_id: "019f9b10-0000-7000-8000-0000000005b1",
    channel_id: GENERAL_ID,
    requested_by: HERMES,
    on_behalf_of: ME,
    action_type: "work.spawn",
    status: "pending",
    is_reversible: false,
    expires_at_ms: Date.now() + 26 * 60_000,
  },
  {
    id: "019f9b10-0000-7000-8000-0000000005a2",
    workspace_id: WORKSPACE_ID,
    run_id: "019f9b10-0000-7000-8000-0000000005b2",
    channel_id: "00000000-0000-7000-8000-000000000202",
    requested_by: HERMES,
    action_type: "shell.exec",
    status: "pending",
    is_reversible: true,
    expires_at_ms: Date.now() + 3 * 3_600_000,
  },
];

function json(route, body) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installMocks(context) {
  await context.route("**/v1/auth/login", (route) => json(route, SESSION));
  await context.route("**/v1/auth/realtime-token", (route) =>
    json(route, {
      token: "capture-only-not-a-credential",
      tokenType: "jwt",
      expiresAtMs: Date.now() + 60_000,
      ttlSeconds: 60,
      workspaceId: WORKSPACE_ID,
      memberId: ME,
    })
  );
  // 채널 만들기 (MOMO-614). The POST answers the way the server does: 409 when
  // an unarchived channel already carries the name, which is the frame that
  // matters because the rejection has to land under the name field, and 201
  // with the created row otherwise.
  await context.route("**/v1/workspaces/*/channels", (route) => {
    if (route.request().method() !== "POST") {
      return json(route, { channels: [...CHANNELS, DM_CHANNEL] });
    }
    const body = JSON.parse(route.request().postData() ?? "{}");
    if (CHANNELS.some((c) => c.name === body.name)) {
      return route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: { message: "channel name already exists" },
        }),
      });
    }
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        channel: {
          id: CREATED_CHANNEL_ID,
          workspaceId: WORKSPACE_ID,
          kind: body.kind,
          name: body.name,
          topic: body.topic,
          muted: false,
        },
        creatorMembership: {
          id: "019f9b10-0000-7000-8000-0000000003ff",
          workspaceId: WORKSPACE_ID,
          channelId: CREATED_CHANNEL_ID,
          memberId: ME,
          role: "owner",
          joinedAtMs: Date.now(),
        },
      }),
    });
  });
  // 디렉터리 행에서 DM 시작 (MOMO-611): idempotent per pair, so the fixture
  // answers created:false, which is the "이미 있는 대화로 이동" path.
  await context.route("**/v1/workspaces/*/dms", (route) =>
    route.request().method() === "POST"
      ? json(route, { channel: DM_CHANNEL, created: false })
      : json(route, { channels: [DM_CHANNEL] })
  );
  // 추론 강도 표 (ADR-0134 D2). 목이 없으면 이 요청은 프록시로 나가고, 살아
  // 있는 서버가 401을 답하는 순간 캡처 세션이 로그아웃된다. 축이 있는 서버를
  // 찍는 이유는 프로필 카드의 "추론 강도" 줄이 그 판정을 그대로 읽기 때문이다.
  await context.route("**/v1/provider/effort-table", (route) =>
    json(route, ROUTING_FIXTURES.effortTable)
  );
  // 에이전트 허브 (goal B5.3b). 더 긴 경로를 먼저 건다: `**/…/agents`가
  // `/agents/{id}/profile`을 삼키지 않도록 하는 것과 같은 규칙이다.
  await context.route("**/v1/workspaces/*/agents/*/allowed-models", (route) =>
    json(route, { allowedAgentModels: ALLOWED_AGENT_MODELS })
  );
  await context.route("**/v1/workspaces/*/agents/*/profile", (route) =>
    json(route, { profile: AGENT_PROFILE })
  );
  await context.route("**/v1/workspaces/*/agents/*/runs*", (route) =>
    json(route, { runs: [] })
  );
  // 만들기는 서버가 답하는 대로: 이미 있는 핸들이면 409(그 거절은 핸들 상자
  // 밑에 서야 한다), 아니면 201 + 만들어진 멤버.
  await context.route("**/v1/workspaces/*/agents", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = JSON.parse(route.request().postData() ?? "{}");
    if (ROSTER.some((member) => member.handle === body.handle)) {
      return route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: { message: "agent handle already exists" },
        }),
      });
    }
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        agent: {
          id: CREATED_AGENT_ID,
          handle: body.handle,
          displayName: body.displayName,
        },
      }),
    });
  });
  // 채널 배치 (B5.3a가 여는 표면). 넣기는 upsert, 빼기는 left_at 표시라 둘 다
  // 멤버십 한 행을 돌려준다.
  await context.route("**/v1/workspaces/*/channels/*/members**", (route) =>
    json(route, {
      membership: {
        id: "019f9b10-0000-7000-8000-0000000006a1",
        workspaceId: WORKSPACE_ID,
        channelId: GENERAL_ID,
        memberId: HERMES,
        role: "member",
        joinedAtMs: Date.now(),
      },
    })
  );
  // 결정 대기 (D-5): pending만 행이 있고, 나머지 상태 페이지는 비어 있다.
  await context.route("**/v1/workspaces/*/approvals*", (route) => {
    const url = new URL(route.request().url());
    return json(route, {
      approvals:
        url.searchParams.get("status") === "pending" ? APPROVALS : [],
    });
  });
  await context.route("**/v1/workspaces/*/roster", (route) =>
    json(route, { members: ROSTER })
  );
  await context.route("**/v1/workspaces/*/read-state", (route) =>
    json(route, { read_states: READ_STATES })
  );
  await context.route("**/v1/workspaces/*/channels/*/read-state", (route) =>
    json(route, READ_STATES[0])
  );
  await context.route(
    "**/v1/workspaces/*/channels/*/huddles/active",
    (route) => json(route, { huddle: null })
  );
  // 설정 > 코드 실행 호스트 (MOMO-617). The workspace default sits in 자동 재개
  // so the 재개 대상 control is on screen, and the member override inherits it,
  // which is the pair the panel has to keep apart.
  await context.route("**/v1/provider/work-host-engine", (route) =>
    json(route, {
      engine: "opencode",
      source: "database",
      updatedBy: "곽성재",
      updatedAtMs: Date.now() - 2 * 86_400_000,
      schema: "momo.work_host_engine.v0",
    })
  );
  await context.route("**/v1/workspaces/*/work-hosts", (route) =>
    json(route, { workHosts: WORK_HOSTS })
  );
  // 설정 > AI 연결 (MOMO-627). The chain routes are matched BEFORE the singleton
  // so `**/v1/provider/link` does not swallow `/link/chain` and `/link/test`.
  await context.route("**/v1/provider/link/chain", (route) =>
    json(route, PROVIDER_CHAIN)
  );
  await context.route("**/v1/provider/link/test", (route) =>
    json(route, PROVIDER_PROBE)
  );
  await context.route("**/v1/provider/link", (route) => json(route, PROVIDER_LINK));
  await context.route("**/v1/workspaces/*/work-tier-policy", (route) =>
    json(route, { workTierPolicy: WORKSPACE_TIER_POLICY })
  );
  await context.route("**/v1/workspaces/*/work-tier-policy/me", (route) =>
    json(route, { workTierPolicy: MEMBER_TIER_POLICY })
  );
  await context.route("**/v1/workspaces/*/channels/*/messages*", (route) => {
    const url = new URL(route.request().url());
    // Older-history and backfill pages are empty: the head page is the shot.
    if (url.searchParams.has("before") || url.searchParams.has("after")) {
      return json(route, { messages: [] });
    }
    if (url.pathname.includes(DM_ID)) {
      return json(route, { messages: makeDmMessages() });
    }
    return json(route, { messages: makeMessages(16) });
  });
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

async function signIn(page) {
  await page.getByTestId("login-email").fill("seongjae@dawn.example");
  await page.getByTestId("login-password").fill("capture-only-not-a-credential");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-list").waitFor({ state: "visible" });
}

/**
 * 가로로 새는 것이 있는가 (goal B6). 폰에서 가로 스크롤이 생기면 읽는 사람은
 * 글자를 따라 좌우로 끌어야 하고, 그 순간 화면 폭은 더 이상 390px이 아니다.
 * 셸은 `overflow: clip`으로 잘라내지만(tokens.css `app-shell`) 로그인 화면처럼
 * 셸 밖의 표면도 있으므로 문서 자체를 잰다.
 */
async function assertNoHorizontalOverflow(page, where) {
  const measure = await page.evaluate(`(() => {
    const doc = document.scrollingElement || document.documentElement;
    return {
      overflowX: doc.scrollWidth - doc.clientWidth,
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
    };
  })()`);
  if (measure.overflowX > 0) {
    throw new Error(
      `가로 오버플로 ${where}: 문서가 ${measure.scrollWidth}px인데 화면은 ${measure.clientWidth}px다`
    );
  }
  console.log(
    `  overflow-x ${where}: 0 (${measure.clientWidth}px 문서 = ${measure.scrollWidth}px)`
  );
}

/** 손가락 타깃 실측. 값을 함께 찍어 리뷰가 숫자를 볼 수 있게 한다. */
async function assertTapTargets(page, where) {
  const measured = await page.evaluate(
    `(() => ${JSON.stringify(MOBILE_TAP_TARGETS)}.map(([testId, label]) => {
      const el = document.querySelector('[data-testid="' + testId + '"]');
      if (!el) return { testId, label, missing: true };
      const r = el.getBoundingClientRect();
      return {
        testId,
        label,
        width: Math.round(r.width),
        height: Math.round(r.height),
      };
    }))()`
  );
  for (const row of measured) {
    if (row.missing) throw new Error(`손가락 타깃 ${where}: ${row.testId} 없음`);
    if (row.height < 44) {
      throw new Error(
        `손가락 타깃 ${where}: ${row.label}(${row.testId})가 ${row.width}x${row.height}px다 (최소 44px)`
      );
    }
  }
  console.log(
    `  tap targets ${where}: ` +
      measured.map((r) => `${r.testId} ${r.width}x${r.height}`).join(", ")
  );
}

/**
 * 폰 (goal B6). 데스크탑 프로파일과 같은 목이고 같은 컴포넌트이며, 다른 것은
 * 뷰포트뿐이다: 이 셸이 폭에 따라 형태를 바꾼다는 주장을 같은 픽스처로 두 번
 * 찍어야 리뷰가 두 형태를 나란히 볼 수 있다.
 *
 * 다섯 화면인 이유는 그 다섯이 폰에서 형태가 **바뀐** 화면 전부이기 때문이다:
 * 연결(셸 밖), 채널(단일 pane + 도크된 컴포저), 서랍이 열린 상태, 에이전트 허브
 * (두 열이 한 열이 되는 표면), 인박스(전역 표면의 헤더에 햄버거가 서는 자리).
 */
async function captureMobile(browser, scheme) {
  const context = await browser.newContext({
    viewport: MOBILE_VIEWPORT,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    colorScheme: scheme,
    reducedMotion: "reduce",
  });
  await installMocks(context);
  const shots = [];
  const shoot = async (page, name) => {
    const path = `${OUT_DIR}/mobile-${name}-${scheme}.png`;
    await page.screenshot({ path });
    shots.push(path);
  };

  // 1. 연결 화면. 셸 밖의 유일한 표면이고, 폰에서 문서가 스크롤해도 되는 자리다.
  const page = await context.newPage();
  await page.goto(ORIGIN, { waitUntil: "networkidle" });
  await page.getByTestId("login-submit").waitFor({ state: "visible" });
  await assertNoHorizontalOverflow(page, `login ${scheme}`);
  await shoot(page, "login");

  // 2. 채널. 사이드바는 열이 아니라 닫힌 서랍이므로 타임라인이 390px 전부를
  //    받고, 컴포저는 안전 영역 위에 도크된다.
  await page.getByTestId("login-email").fill("seongjae@dawn.example");
  await page.getByTestId("login-password").fill("capture-only-not-a-credential");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("composer-input").waitFor({ state: "visible" });
  await page.getByTestId("timeline-message").first().waitFor({ state: "visible" });
  await page.waitForTimeout(300);
  await assertNoHorizontalOverflow(page, `chat ${scheme}`);
  await assertTapTargets(page, `chat ${scheme}`);
  await shoot(page, "chat");

  // 3. 서랍이 열린 상태. 뒤 표면이 110px 남는 것이 이 프레임의 요점이다: 덮은
  //    것이 화면 전체가 아니라 서랍이어야 바깥을 눌러 닫을 자리가 보인다.
  await page.getByTestId("open-sidebar-drawer").click();
  await page.getByTestId("sidebar-scrim").waitFor({ state: "visible" });
  await page.waitForTimeout(300);
  const drawer = await page.evaluate(`(() => {
    const el = document.querySelector('[data-testid="sidebar"]');
    const r = el.getBoundingClientRect();
    const row = document.querySelector("[data-sidebar-row]");
    const rowRect = row?.getBoundingClientRect();
    return {
      left: Math.round(r.left),
      width: Math.round(r.width),
      peek: Math.round(window.innerWidth - r.right),
      rowHeight: rowRect ? Math.round(rowRect.height) : null,
      mainInert: document
        .querySelector("main")
        ?.hasAttribute("inert"),
      focusInsideDrawer: el.contains(document.activeElement),
    };
  })()`);
  if (drawer.left !== 0 || drawer.peek <= 0) {
    throw new Error(`서랍 기하 ${scheme}: ${JSON.stringify(drawer)}`);
  }
  if (drawer.mainInert !== true) {
    throw new Error(`서랍이 열렸는데 본문이 inert가 아니다 ${scheme}`);
  }
  if (drawer.focusInsideDrawer !== true) {
    throw new Error(`서랍이 열렸는데 캐럿이 밖에 있다 ${scheme}`);
  }
  if (drawer.rowHeight !== null && drawer.rowHeight < 44) {
    throw new Error(`채널 행이 ${drawer.rowHeight}px다 (최소 44px) ${scheme}`);
  }
  console.log(
    `  drawer ${scheme}: ${drawer.width}px 서랍 + ${drawer.peek}px 잔여, 행 ${drawer.rowHeight}px, 본문 inert=${drawer.mainInert}`
  );
  await assertNoHorizontalOverflow(page, `drawer ${scheme}`);
  await shoot(page, "sidebar-drawer");

  // Esc로 닫힌다. 닫히는 길이 셋(닫기 버튼·스크림·Esc)이라는 주장 중 하나를
  // 여기서 실제로 걷는다.
  await page.keyboard.press("Escape");
  await page.getByTestId("sidebar-scrim").waitFor({ state: "detached" });

  // 4. 에이전트 허브. 900px 아래에서 명부와 상세가 한 열로 쌓이는 표면이라,
  //    폰에서 그 형태가 실제로 서는지 보는 자리다.
  await page.evaluate('location.hash = "/agents"');
  await page.getByTestId("agent-hub-profile-card").waitFor({ state: "visible" });
  await page.waitForTimeout(300);
  await assertNoHorizontalOverflow(page, `agent hub ${scheme}`);
  await shoot(page, "agent-hub");

  // 5. 인박스(결정 대기). 전역 표면의 헤더에도 서랍을 여는 길이 있어야 한다는
  //    것이 이 프레임의 요점이다: 없으면 채널 밖으로 나간 사람은 갇힌다.
  await page.evaluate('location.hash = "/inbox?filter=needs-action"');
  await page.getByTestId("feed-row").first().waitFor({ state: "visible" });
  await page.getByTestId("open-sidebar-drawer").waitFor({ state: "visible" });
  await page.waitForTimeout(300);
  await assertNoHorizontalOverflow(page, `inbox ${scheme}`);
  await shoot(page, "inbox");

  await context.close();
  return shots;
}

async function captureScheme(browser, scheme) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    colorScheme: scheme,
    reducedMotion: "reduce",
  });
  await installMocks(context);
  const shots = [];

  // 1. login surface: Card / Input / Button / runtime badge tokens
  const login = await context.newPage();
  await login.goto(ORIGIN, { waitUntil: "networkidle" });
  await login.getByTestId("login-submit").waitFor({ state: "visible" });
  const loginShot = `${OUT_DIR}/login-${scheme}.png`;
  await login.screenshot({ path: loginShot });
  shots.push(loginShot);

  // 1b. connect surface, invite path (MOMO-604): the browser fallback for a
  //     momo://join link fills server and code, so only email/password remain.
  //     The LAN discovery card has no web equivalent (no mDNS in a page), so it
  //     is reviewed in the desktop shell, not here.
  const invite = await context.newPage();
  const deepLink = `momo://join?server=${encodeURIComponent(
    ORIGIN
  )}&code=momo-alpha-2026`;
  await invite.goto(`${ORIGIN}/?join=${encodeURIComponent(deepLink)}`, {
    waitUntil: "networkidle",
  });
  await invite.getByTestId("login-invite-code").waitFor({ state: "visible" });
  const inviteShot = `${OUT_DIR}/connect-invite-${scheme}.png`;
  await invite.screenshot({ path: inviteShot });
  shots.push(inviteShot);

  // 2. chat shell, live path: sidebar + timeline + composer + rail status
  await signIn(login);
  await login.getByTestId("timeline-message").first().waitFor({ state: "visible" });
  const chatShot = `${OUT_DIR}/chat-${scheme}.png`;
  await login.screenshot({ path: chatShot });
  shots.push(chatShot);

  // 3. focus ring on the composer (focus indication is a hard rule)
  await login.getByTestId("composer-input").focus();
  const focusShot = `${OUT_DIR}/composer-focus-${scheme}.png`;
  await login.screenshot({ path: focusShot });
  shots.push(focusShot);

  // 3a. 채널 만들기 다이얼로그 (MOMO-614): the form the sidebar + opens, filled
  //     the way a person fills it. This is the surface that replaced the
  //     /settings dead end, so it is reviewed in both schemes.
  await login.getByTestId("new-channel").click();
  await login.getByTestId("create-channel-dialog").waitFor({ state: "visible" });
  await login.getByTestId("create-channel-name").fill("release-rollback");
  await login
    .getByTestId("create-channel-topic")
    .fill("배포와 롤백 절차, 당번 인계를 한곳에서");
  // The focus ring rides `transition-colors` (150ms), so a frame shot the
  // instant after focus catches the ring mid-interpolation and reviews a color
  // the product never rests on. Let it settle first.
  await login.waitForTimeout(300);
  const createShot = `${OUT_DIR}/channel-create-${scheme}.png`;
  await login.screenshot({ path: createShot });
  shots.push(createShot);

  // 3a-2. 서버 거절은 필드 옆에 (MOMO-614): 이미 있는 이름을 보내면 409가 이름
  //       상자 밑에 붙고, 입력한 값은 그대로 남는다. 토스트 아님.
  await login.getByTestId("create-channel-name").fill("general");
  await login.getByTestId("create-channel-submit").click();
  await login
    .getByTestId("create-channel-name-error")
    .waitFor({ state: "visible" });
  await login.waitForTimeout(300);
  const createErrorShot = `${OUT_DIR}/channel-create-error-${scheme}.png`;
  await login.screenshot({ path: createErrorShot });
  shots.push(createErrorShot);

  // 3a-3. 진행 중 (MOMO-614 R1): 제출 버튼 안 스피너 + 라벨. 흐린 라벨 하나가
  //       유일한 진행 신호였던 프레임이라, 두 스킴 모두에서 다시 본다. 응답을
  //       늦추는 라우트는 이 페이지에만 걸고 곧바로 걷는다.
  await login.route("**/v1/workspaces/*/channels", async (route) => {
    if (route.request().method() === "POST") {
      await new Promise((r) => setTimeout(r, 2_000));
    }
    return route.fallback();
  });
  await login.getByTestId("create-channel-name").fill("release-rollback");
  await login.getByTestId("create-channel-submit").click();
  await login
    .locator('[data-testid="create-channel-submit"][aria-busy="true"]')
    .waitFor({ state: "visible" });
  await login.waitForTimeout(200);
  const createPendingShot = `${OUT_DIR}/channel-create-pending-${scheme}.png`;
  await login.screenshot({ path: createPendingShot });
  shots.push(createPendingShot);
  await login.getByTestId("create-channel-dialog").waitFor({ state: "detached" });
  await login.unroute("**/v1/workspaces/*/channels");

  // 3a-4. 오프라인 (MOMO-614 R1 / R-1 5장): 배너 한 줄 + 만들기 버튼 disabled.
  //       레일의 disconnected는 종단 절단에서만 오므로 브라우저가 아는 오프라인도
  //       함께 읽는다. 여기서는 그 브라우저 신호를 실제로 끊어 확인한다.
  await context.setOffline(true);
  await login.getByTestId("new-channel").click();
  await login.getByTestId("create-channel-dialog").waitFor({ state: "visible" });
  await login.getByTestId("create-channel-offline").waitFor({ state: "visible" });
  await login.waitForTimeout(200);
  const createOfflineShot = `${OUT_DIR}/channel-create-offline-${scheme}.png`;
  await login.screenshot({ path: createOfflineShot });
  shots.push(createOfflineShot);
  await context.setOffline(false);
  await login.getByTestId("create-channel-cancel").click();
  await login.getByTestId("create-channel-dialog").waitFor({ state: "detached" });

  // 3a-3. 빈 워크스페이스 (MOMO-614): 채널이 0개일 때 남는 유일한 행동. 이 화면의
  //       [채널 만들기]가 /settings로 보내던 막다른 골목이었고, 이제 위의
  //       다이얼로그를 연다. 이 페이지에서만 채널 목록을 비운다.
  const emptyWorkspace = await context.newPage();
  await emptyWorkspace.route("**/v1/workspaces/*/channels", (route) =>
    route.request().method() === "POST"
      ? route.fallback()
      : json(route, { channels: [] })
  );
  await emptyWorkspace.goto(ORIGIN, { waitUntil: "networkidle" });
  await signIn(emptyWorkspace);
  await emptyWorkspace.getByTestId("chat-no-channel").waitFor({ state: "visible" });
  const emptyShot = `${OUT_DIR}/workspace-empty-${scheme}.png`;
  await emptyWorkspace.screenshot({ path: emptyShot });
  shots.push(emptyShot);

  // 3a-5. 만들 권한이 없는 멤버가 보는 같은 화면 (MOMO-614): +도 팔레트 항목도
  //       없고, 대신 누가 만들 수 있는지 말한다. requireWorkspaceAdmin이 거절할
  //       버튼을 내주지 않는 것이 이 티켓이 없앤 막다른 골목의 반대편이다.
  const nonAdmin = await context.newPage();
  await nonAdmin.route("**/v1/workspaces/*/channels", (route) =>
    route.request().method() === "POST"
      ? route.fallback()
      : json(route, { channels: [] })
  );
  await nonAdmin.route("**/v1/workspaces/*/roster", (route) =>
    json(route, {
      members: ROSTER.map((m) =>
        m.id === ME ? { ...m, role: "member" } : m
      ),
    })
  );
  await nonAdmin.goto(ORIGIN, { waitUntil: "networkidle" });
  await signIn(nonAdmin);
  await nonAdmin.getByTestId("chat-no-channel").waitFor({ state: "visible" });
  const nonAdminShot = `${OUT_DIR}/workspace-empty-nonadmin-${scheme}.png`;
  await nonAdmin.screenshot({ path: nonAdminShot });
  shots.push(nonAdminShot);

  // 3b. 멤버 디렉터리 (MOMO-611): the roster as a list, the role labels, the
  //     human/agent split, and the row that starts a DM.
  const directory = await context.newPage();
  await directory.goto(ORIGIN, { waitUntil: "networkidle" });
  await signIn(directory);
  await directory.evaluate('location.hash = "/directory"');
  await directory.getByTestId("directory-row").first().waitFor({ state: "visible" });
  const directoryShot = `${OUT_DIR}/directory-${scheme}.png`;
  await directory.screenshot({ path: directoryShot });
  shots.push(directoryShot);

  // 3c. ⌘K with the 사람 section: channels, DMs and people in one palette. The
  //     query is typed, which is how the palette is actually used, and "김"
  //     lands on the pair a directory has to keep apart (a human and an agent
  //     whose display names are both 김인턴).
  await directory.getByTestId("open-quick-switcher").click();
  await directory.getByTestId("quick-switcher-input").fill("김");
  await directory.getByTestId("switcher-person").first().waitFor({ state: "visible" });
  const switcherShot = `${OUT_DIR}/quick-switcher-people-${scheme}.png`;
  await directory.screenshot({ path: switcherShot });
  shots.push(switcherShot);
  await directory.keyboard.press("Escape");

  // 3d. the DM that a directory row opens: same timeline anatomy as a channel.
  await directory
    .locator('[data-testid="directory-row"][data-member-kind="agent"]')
    .first()
    .click();
  await directory.getByTestId("composer-input").waitFor({ state: "visible" });
  await directory.getByTestId("timeline-message").first().waitFor({ state: "visible" });
  const dmShot = `${OUT_DIR}/dm-${scheme}.png`;
  await directory.screenshot({ path: dmShot });
  shots.push(dmShot);

  // 3f. 에이전트 허브 (goal B5.3b, D-4): 명부 왼쪽, 프로필 카드와 채널 배치
  //     오른쪽. 이 한 판이 "이 에이전트가 무슨 모델로 어디에서 돌고 있나"에
  //     답해야 하는 화면이라, 카드와 채널 목록이 같은 프레임에 들어와야 한다.
  const agentHub = await context.newPage();
  await agentHub.goto(ORIGIN, { waitUntil: "networkidle" });
  await signIn(agentHub);
  await agentHub.evaluate('location.hash = "/agents"');
  await agentHub.getByTestId("agent-hub-profile-card").waitFor({ state: "visible" });
  await agentHub.getByTestId("agent-hub-channels").waitFor({ state: "visible" });
  const agentHubShot = `${OUT_DIR}/agent-hub-${scheme}.png`;
  await agentHub.screenshot({ path: agentHubShot });
  shots.push(agentHubShot);

  // 3f-2. 에이전트 만들기, 사람이 채우는 대로 채운 상태. 자격증명 줄이 폼 안에
  //       있는지가 이 프레임의 요점이다 (ADR-0004: 여기에는 키를 넣지 않는다).
  await agentHub.getByTestId("agent-hub-create").click();
  await agentHub.getByTestId("create-agent-dialog").waitFor({ state: "visible" });
  await agentHub.getByTestId("create-agent-display-name").fill("배포당번");
  await agentHub.getByTestId("create-agent-handle").fill("release-duty");
  await agentHub.getByTestId("create-agent-model").fill("hermes-agent");
  await agentHub
    .getByTestId("create-agent-base-url")
    .fill("https://gateway.dawn.internal/v1");
  await agentHub
    .getByTestId("create-agent-instructions")
    .fill("배포 전 롤백 절차를 먼저 확인하고, 확인되지 않은 것은 확인되지 않았다고 적습니다.");
  // 포커스 링은 transition-colors(150ms)를 타므로, 방금 포커스한 프레임을 찍으면
  // 제품이 한 번도 머무르지 않는 중간 색을 리뷰하게 된다.
  await agentHub.waitForTimeout(300);
  const agentCreateShot = `${OUT_DIR}/agent-create-${scheme}.png`;
  await agentHub.screenshot({ path: agentCreateShot });
  shots.push(agentCreateShot);

  // 3f-3. 서버 거절은 필드 옆에: 이미 있는 핸들을 보내면 409가 핸들 상자 밑에
  //       붙고, 입력한 값은 그대로 남는다. 토스트 아님.
  await agentHub.getByTestId("create-agent-handle").fill("hermes");
  await agentHub.getByTestId("create-agent-submit").click();
  await agentHub
    .getByTestId("create-agent-handle-error")
    .waitFor({ state: "visible" });
  await agentHub.waitForTimeout(300);
  const agentCreateErrorShot = `${OUT_DIR}/agent-create-error-${scheme}.png`;
  await agentHub.screenshot({ path: agentCreateErrorShot });
  shots.push(agentCreateErrorShot);
  await agentHub.getByTestId("create-agent-cancel").click();
  await agentHub.getByTestId("create-agent-dialog").waitFor({ state: "detached" });

  // 3f-4. 편집 표면이 없는 서버 (diff matrix D-4의 현재 형상): allowed-models가
  //       404면 프로필 쓰기와 일시정지도 없다. 화면은 읽기는 그대로 두고 저장을
  //       잠근 채 왜 잠겼는지 말해야 한다. 이 프레임이 없으면 "저장하면
  //       만들어집니다"라고 약속하고 404를 돌려주던 상태로 되돌아가기 쉽다.
  const readOnlyHub = await context.newPage();
  await readOnlyHub.route("**/v1/workspaces/*/agents/*/allowed-models", (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: { message: "not found" } }),
    })
  );
  await readOnlyHub.goto(ORIGIN, { waitUntil: "networkidle" });
  await signIn(readOnlyHub);
  await readOnlyHub.evaluate('location.hash = "/agents"');
  await readOnlyHub
    .getByTestId("agent-hub-edit-unsupported")
    .waitFor({ state: "visible" });
  const agentHubReadOnlyShot = `${OUT_DIR}/agent-hub-readonly-${scheme}.png`;
  await readOnlyHub.screenshot({ path: agentHubReadOnlyShot });
  shots.push(agentHubReadOnlyShot);

  // 3g. 결정 대기에서 바로 결정 (goal B5.3b, D-5). 이 목록은 승인 원장을 이미
  //     읽고 있었지만 결정하려면 채널로 들어가야 했다. 판단에 필요한 사실이 이미
  //     행에 있으므로 결정도 여기서 한다.
  const approvals = await context.newPage();
  await approvals.goto(ORIGIN, { waitUntil: "networkidle" });
  await signIn(approvals);
  await approvals.evaluate('location.hash = "/inbox?filter=needs-action"');
  await approvals.getByTestId("feed-row").first().waitFor({ state: "visible" });
  await approvals.getByTestId("inbox-approval-approve").first().waitFor({
    state: "visible",
  });
  const approvalsShot = `${OUT_DIR}/approvals-${scheme}.png`;
  await approvals.screenshot({ path: approvalsShot });
  shots.push(approvalsShot);

  // 3g-2. 확인 단계 (SKILL §6): 한 번의 무방비 클릭으로는 아무것도 결정되지
  //       않는다. 승인/거부는 무장이고, 확정이 결정이다.
  await approvals.getByTestId("inbox-approval-approve").first().click();
  await approvals.getByTestId("inbox-approval-confirm").first().waitFor({
    state: "visible",
  });
  await approvals.waitForTimeout(200);
  const approvalsConfirmShot = `${OUT_DIR}/approvals-confirm-${scheme}.png`;
  await approvals.screenshot({ path: approvalsConfirmShot });
  shots.push(approvalsConfirmShot);

  // 3e. agent turn surfaces (MOMO-613): the sidebar pill and the composer
  //     activity list. `?agentwork=live` seeds fixed turns and reports the rail
  //     as connected, so the clock, the 승인 대기 state and the stacked composer
  //     lines are all on screen at once without a socket.
  const turns = await context.newPage();
  await turns.goto(`${ORIGIN}/?agentwork=live`, { waitUntil: "networkidle" });
  await signIn(turns);
  await turns.getByTestId("timeline-message").first().waitFor({ state: "visible" });
  await turns.getByTestId("agent-turn-badge").first().waitFor({ state: "visible" });
  await turns.getByTestId("composer-working").waitFor({ state: "visible" });
  // The ADR-0135 D1 cascade notice, and this wait is a GATE rather than a
  // convenience. The row it hangs on is the WORKER turn record in BODIES, which
  // is the only shape a real cascade can land on; the seeded fallback in
  // cascadeRail.tsx is keyed to that row's run id. If `turnRecordRunId` ever
  // narrows back to the gateway schema, the capture stops here instead of
  // shipping screenshots of a surface that cannot render in production, which
  // is precisely how D1/F3 got through the gates the first time.
  await turns.getByTestId("cascade-notice").waitFor({ state: "visible" });
  const turnsShot = `${OUT_DIR}/agent-turns-${scheme}.png`;
  await turns.screenshot({ path: turnsShot });
  shots.push(turnsShot);

  // 3e-2. 그 안내 줄을 화면 안으로 (ADR-0135 D1). 이 줄은 아티팩트에 한 번도 뜬
  //       적이 없다 — 렌더를 확인하지 못한 채 머지 리뷰까지 갔고, 거기서 구조적으로
  //       렌더 불가라는 것이 드러났다(D1/F3). 워커 턴 행에 붙은 모습을 두 스킴
  //       모두에서 남겨 다음 리뷰가 눈으로도 확인할 수 있게 한다.
  await turns.getByTestId("cascade-notice").scrollIntoViewIfNeeded();
  await turns.waitForTimeout(200);
  const cascadeShot = `${OUT_DIR}/cascade-notice-${scheme}.png`;
  await turns.screenshot({ path: cascadeShot });
  shots.push(cascadeShot);

  // 3f. the same turns with the rail down (SKILL §5 offline): the clocks go
  //     away rather than counting on a dead socket, and the banner says why.
  const turnsOffline = await context.newPage();
  await turnsOffline.goto(`${ORIGIN}/?agentwork=offline`, {
    waitUntil: "networkidle",
  });
  await signIn(turnsOffline);
  await turnsOffline
    .getByTestId("timeline-message")
    .first()
    .waitFor({ state: "visible" });
  await turnsOffline
    .getByTestId("agent-turn-badge")
    .first()
    .waitFor({ state: "visible" });
  const turnsOfflineShot = `${OUT_DIR}/agent-turns-offline-${scheme}.png`;
  await turnsOffline.screenshot({ path: turnsOfflineShot });
  shots.push(turnsOfflineShot);

  // 3g. 설정 > 코드 실행 호스트 (MOMO-617): the three blocks that decide where an
  //     agent runs. Shot at the top of the panel, where the engine card, the
  //     registry rows and the policy selects all land in one frame.
  const settings = await context.newPage();
  await settings.goto(ORIGIN, { waitUntil: "networkidle" });
  await signIn(settings);
  await settings.evaluate('location.hash = "/settings?section=code"');
  await settings.getByTestId("work-host-list").waitFor({ state: "visible" });
  await settings.getByTestId("work-tier-policy").waitFor({ state: "visible" });
  const workHostShot = `${OUT_DIR}/settings-work-host-${scheme}.png`;
  await settings.screenshot({ path: workHostShot });
  shots.push(workHostShot);

  // …and the same panel scrolled to its foot, where the three status chips and
  // the two policy scopes sit together. A section this tall is reviewed twice
  // or the half nobody sees is the half that regresses.
  await settings
    .getByTestId("work-tier-policy")
    .scrollIntoViewIfNeeded();
  await settings.waitForTimeout(200);
  const policyShot = `${OUT_DIR}/settings-work-host-policy-${scheme}.png`;
  await settings.screenshot({ path: policyShot });
  shots.push(policyShot);

  // 3h. 설정 > AI 연결 (MOMO-627 / ADR-0135 D1): the singleton card plus the
  //     cascade it heads. Three rows that must stay apart at a glance, the head
  //     being the only one this block cannot edit.
  const aiLink = await context.newPage();
  await aiLink.goto(ORIGIN, { waitUntil: "networkidle" });
  await signIn(aiLink);
  await aiLink.evaluate('location.hash = "/settings?section=ai"');
  await aiLink.getByTestId("chain-list").waitFor({ state: "visible" });
  const aiLinkShot = `${OUT_DIR}/settings-ai-chain-${scheme}.png`;
  await aiLink.screenshot({ path: aiLinkShot });
  shots.push(aiLinkShot);

  // …and its foot, where the hop editor's own controls live. A block this tall
  // is reviewed twice or the half nobody sees is the half that regresses.
  await aiLink.getByTestId("chain-add").scrollIntoViewIfNeeded();
  await aiLink.waitForTimeout(200);
  const aiEditShot = `${OUT_DIR}/settings-ai-chain-edit-${scheme}.png`;
  await aiLink.screenshot({ path: aiEditShot });
  shots.push(aiEditShot);

  // …and the probe table, which is the one surface carrying all four
  //     dispositions and therefore all four status tones in one frame.
  await aiLink.getByRole("button", { name: "연결 확인" }).click();
  await aiLink.getByTestId("chain-probe").waitFor({ state: "visible" });
  const aiProbeShot = `${OUT_DIR}/settings-ai-probe-${scheme}.png`;
  await aiLink.screenshot({ path: aiProbeShot });
  shots.push(aiProbeShot);

  // …and a hop that was just added. This frame exists to prove a NEGATIVE: the
  //     empty address field must NOT be red, must not be aria-invalid, and must
  //     keep its format hint. Nothing has happened yet, so there is no error to
  //     report; what the block owes the reader is the next step, once, at the
  //     foot ("6차 provider 주소를 입력하면 저장할 수 있습니다.").
  await aiLink.getByTestId("chain-add").click();
  await aiLink.getByTestId("chain-blocked").waitFor({ state: "visible" });
  await aiLink.getByTestId("chain-blocked").scrollIntoViewIfNeeded();
  await aiLink.waitForTimeout(200);
  const aiNewRowShot = `${OUT_DIR}/settings-ai-chain-new-row-${scheme}.png`;
  await aiLink.screenshot({ path: aiNewRowShot });
  shots.push(aiNewRowShot);

  // …and the probe table with that unsaved hop still on screen. The table is
  //     numbered by the SAVED order, so once the two can disagree it has to say
  //     which of them it is describing: one screen must not carry two meanings
  //     of "3차".
  await aiLink.getByTestId("chain-probe-scope").scrollIntoViewIfNeeded();
  await aiLink.waitForTimeout(200);
  const aiPendingShot = `${OUT_DIR}/settings-ai-probe-pending-${scheme}.png`;
  await aiLink.screenshot({ path: aiPendingShot });
  shots.push(aiPendingShot);

  // 3h-2. a 200 whose entries this client cannot read in full. Read-only, one
  //     banner naming the entry, and no count anywhere that the rows below do
  //     not support.
  const aiPartial = await context.newPage();
  await aiPartial.route("**/v1/provider/link/chain", (route) =>
    json(route, PROVIDER_CHAIN_PARTIAL)
  );
  await aiPartial.goto(ORIGIN, { waitUntil: "networkidle" });
  await signIn(aiPartial);
  await aiPartial.evaluate('location.hash = "/settings?section=ai"');
  await aiPartial.getByTestId("chain-partial").waitFor({ state: "visible" });
  await aiPartial.getByTestId("chain-partial").scrollIntoViewIfNeeded();
  await aiPartial.waitForTimeout(200);
  const aiPartialShot = `${OUT_DIR}/settings-ai-chain-partial-${scheme}.png`;
  await aiPartial.screenshot({ path: aiPartialShot });
  shots.push(aiPartialShot);

  // 3i. the same panel against a server built BEFORE the chain landed, which is
  //     the live momowebqa answer today (404, measured 2026-07-26). The block
  //     has to say "this server has no chain yet", never draw an empty chain.
  const aiLegacy = await context.newPage();
  await aiLegacy.route("**/v1/provider/link/chain", (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: { message: "not found" } }),
    })
  );
  await aiLegacy.goto(ORIGIN, { waitUntil: "networkidle" });
  await signIn(aiLegacy);
  await aiLegacy.evaluate('location.hash = "/settings?section=ai"');
  await aiLegacy.getByTestId("chain-unavailable").waitFor({ state: "visible" });
  const aiLegacyShot = `${OUT_DIR}/settings-ai-no-chain-${scheme}.png`;
  await aiLegacy.screenshot({ path: aiLegacyShot });
  shots.push(aiLegacyShot);

  // 3j. the self-host DEFAULT: one hop, mock mode, no operator link. This frame
  //     exists because the panel used to call it broken. `probeHop` never calls
  //     a non-external hop, so the check measured nothing, and "지금은 실행이
  //     실패합니다" was a false statement about an instance whose turns succeed
  //     through the bundled mock. It has to read as a mode, not as an outage.
  const aiMock = await context.newPage();
  await aiMock.route("**/v1/provider/link/chain", (route) =>
    json(route, {
      schema: "momo.provider_link.chain.v0",
      entries: [MOCK_ONLY_HOP],
      fallbackCount: 0,
      attemptableCount: 1,
    })
  );
  await aiMock.route("**/v1/provider/link/test", (route) =>
    json(route, {
      schema: "momo.provider_link.test.v0",
      ok: false,
      reason: "not_external_provider",
      source: "environment",
      mode: "local-mock",
      endpointLabel: MOCK_ONLY_HOP.endpointLabel,
      checkedAtMs: Date.now(),
      cascadeOk: false,
      entries: [
        {
          position: 0,
          source: "environment",
          mode: "local-mock",
          endpointLabel: MOCK_ONLY_HOP.endpointLabel,
          enabled: true,
          ok: false,
          reason: "not_external_provider",
          disposition: "propagate",
        },
      ],
    })
  );
  // The singleton above the chain is overridden too, or the shot would show a
  // saved anthropic link heading a mock cascade: a frame the server cannot
  // produce, which makes the screenshot worse than no screenshot. Registered
  // after the two above for the same reason installMocks does it in that order.
  await aiMock.route("**/v1/provider/link", (route) =>
    json(route, {
      schema: "momo.provider_link.v0",
      configured: false,
      source: "environment",
      mode: "local-mock",
      baseUrl: MOCK_ONLY_HOP.baseUrl,
      endpointLabel: MOCK_ONLY_HOP.endpointLabel,
      bearerConfigured: true,
      availability: "mock",
      keyConfigured: true,
      diagnostics: [],
    })
  );
  await aiMock.goto(ORIGIN, { waitUntil: "networkidle" });
  await signIn(aiMock);
  await aiMock.evaluate('location.hash = "/settings?section=ai"');
  await aiMock.getByTestId("chain-list").waitFor({ state: "visible" });
  await aiMock.getByRole("button", { name: "연결 확인" }).click();
  await aiMock.getByTestId("chain-probe").waitFor({ state: "visible" });
  const aiMockShot = `${OUT_DIR}/settings-ai-mock-mode-${scheme}.png`;
  await aiMock.screenshot({ path: aiMockShot });
  shots.push(aiMockShot);

  // 4. dense timeline via the stress path (no realtime rail, 40 rows)
  const stress = await context.newPage();
  await stress.goto(`${ORIGIN}/?stress=40`, { waitUntil: "networkidle" });
  await signIn(stress);
  await stress.getByTestId("timeline-message").first().waitFor({ state: "visible" });
  const stressShot = `${OUT_DIR}/timeline-dense-${scheme}.png`;
  await stress.screenshot({ path: stressShot });
  shots.push(stressShot);

  await context.close();
  return shots;
}

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) {
    throw new Error("dist/ is missing. Run `npm run capture:design`.");
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
      const all = [];
      for (const scheme of ["light", "dark"]) {
        all.push(...(await captureScheme(browser, scheme)));
      }
      // 폰 프로파일 (goal B6). 데스크탑 프레임 뒤에 붙는 이유는 회귀를 읽는
      // 순서 때문이다: 1280 프레임이 먼저 전부 나오고, 그 다음이 390이다.
      for (const scheme of ["light", "dark"]) {
        all.push(...(await captureMobile(browser, scheme)));
      }
      for (const path of all) console.log(path);
    } finally {
      await browser.close();
    }
  } finally {
    shutdown();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
