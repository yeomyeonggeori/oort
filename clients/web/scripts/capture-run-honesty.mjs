#!/usr/bin/env node
// =============================================================================
// ADR-0200 UXUI 캡처 (#3747 U1 · #3748 U2 · #3749 U3): 외부 에이전트 작업 상태를
// 사실대로.
//
//   SLICE=u2  서버 원장 기록(닫아도 남는다) · 여러 run(진행 중 병렬·대기열 순서·끝난 일) ·
//             대기열 앞(내 채널은 자세히, 아니면 「앞에 N건」) · 승인 카드 링크 ·
//             보이는 것의 한계 한 줄 · 서버가 모르는 run(이 화면에만 있는 기록).
//   SLICE=u1  대기 2번째 → 가져감(소식 없음 포함) → 진행 단계 → 승인 대기 → 끝(사유),
//             여러 run 병렬. 사이드바 알약·컴포저 활동 줄·작업 패널 머리.
//
// 라이트·다크 × 1440×900. 백엔드는 없다: `/v1/**`는 ADR-0200 응답 모양의 고정
// 응답이고, 서버 프레임(`agent.run.event`)은 가짜 소켓으로 밀어 넣는다. 화면이
// 다시 읽는지(프레임 → GET progress)는 요청 수로 단정한다.
//
//   npm run build && SLICE=u1 OUT_DIR=<dir> node scripts/capture-run-honesty.mjs
// =============================================================================

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SLICE = process.env.SLICE || "u1";
const OUT_DIR = process.env.OUT_DIR
  ? resolve(process.env.OUT_DIR)
  : resolve(WEB_ROOT, `artifacts/run-honesty-${SLICE}`);
const PORT = Number(process.env.CAPTURE_PORT || 5231);
const MIN = 60_000;

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const agentId = "00000000-0000-7000-8000-000000000301";
const otherAgentId = "00000000-0000-7000-8000-000000000302";
const CH = "00000000-0000-7000-8000-000000000201";
const GENERAL = "00000000-0000-7000-8000-000000000202";
const RUN_A = "0199aa11-2222-7000-8000-0000000000a1";
const RUN_B = "0199aa11-2222-7000-8000-0000000000a2";
const RUN_C = "0199aa11-2222-7000-8000-0000000000a3";
const RUN_D = "0199aa11-2222-7000-8000-0000000000a4";
const RUN_E = "0199aa11-2222-7000-8000-0000000000a5";
const RUN_F = "0199aa11-2222-7000-8000-0000000000a6";

const person = (id, kind, displayName, handle, extra = {}) => ({
  id, workspaceId, kind, status: "active", displayName, handle, channelCount: 2,
  channelIds: [CH, GENERAL], capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...extra,
});
const roster = [
  person(memberId, "human", "곽성재", "seongjae", { role: "owner" }),
  person(agentId, "agent", "그록봇", "grokbot", { ownerHumanId: memberId }),
  person(otherAgentId, "agent", "김인턴", "kim-intern", { ownerHumanId: memberId }),
];
const channels = [
  { id: CH, workspaceId, kind: "public", name: "계획", muted: false },
  { id: GENERAL, workspaceId, kind: "public", name: "general", muted: false },
];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: "ws://run-honesty-capture.invalid/connection/websocket",
};

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** ADR-0200 `AgentRunProgress` 한 줄. */
function progress(now, extra) {
  return {
    channelId: CH,
    agentMemberId: agentId,
    status: "queued",
    phase: "queued",
    leaseState: "none",
    stepCount: 0,
    createdAtMs: now - 11 * MIN,
    updatedAtMs: now - 11 * MIN,
    ...extra,
  };
}

/** 장면 상태. 페이지가 읽을 때마다 현재 값을 돌려준다. */
function newScene() {
  return { runs: [], progressCalls: 0, ledgers: {}, ledgerCalls: 0, approvals: [] };
}

async function installRoutes(context, scene) {
  const now = Date.now();
  const messageRows = [
    {
      id: "00000000-0000-7000-8000-0000000a0001", channelId: CH, seq: 10, hlcTs: now - 12 * MIN, hlcCount: 0,
      authorMemberId: memberId, type: "text",
      body: "@grokbot 채널 하나 만들어 줄래요? 이름은 grokbot-lab으로요.", state: "sent", createdAtMs: now - 12 * MIN,
    },
  ];
  await context.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId });
    }
    if (/\/inbox(\/|$)/.test(path)) return json(route, { error: { code: "not_found", message: "not found" } }, 404);
    if (path.endsWith("/agent-runs/progress")) {
      scene.progressCalls += 1;
      if (scene.legacyServer) return json(route, { error: { code: "not_found", message: "not found" } }, 404);
      const channel = path.split("/channels/")[1]?.split("/")[0];
      return json(route, { runs: scene.runs.filter((r) => r.channelId === channel) });
    }
    const ledgerMatch = path.match(/\/agent-runs\/([^/]+)\/events$/);
    if (ledgerMatch) {
      scene.ledgerCalls += 1;
      const runId = ledgerMatch[1].toLowerCase();
      return json(route, { runId, events: scene.ledgers[runId] ?? [] });
    }
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/read-state") && method === "GET") {
      return json(route, { read_states: channels.map((c) => ({ channel_id: c.id, last_read_seq: 99, latest_seq: 99, unread_count: 0, mention_count: 0, marked_unread_before_seq: null })) });
    }
    if (path.endsWith("/approvals")) {
      return json(route, { approvals: url.searchParams.get("status") === "pending" ? scene.approvals : [] });
    }
    if (path.endsWith("/agent-runs")) return json(route, { runs: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: [] });
    if (path.endsWith("/work-sessions/shared")) return json(route, { sessions: [], nextCursor: null });
    if (path.endsWith("/work-sessions")) return json(route, { workSessions: [] });
    if (path.endsWith("/reminders")) return json(route, { reminders: [] });
    if (path.endsWith(`/workspaces/${workspaceId}`)) return json(route, { workspace: { id: workspaceId, name: "여명거리" } });
    if (path.includes(`/channels/${CH}/messages`)) return json(route, { messages: messageRows });
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
        window.__socket = this;
        window.__offset = 0;
        queueMicrotask(() => { this.readyState = 1; this.onopen?.(new Event("open")); });
      }
      send(data) {
        const replies = String(data).trim().split("\n").map((line) => {
          const c = JSON.parse(line);
          if (c.connect) return { id: c.id, connect: { client: "run-honesty-capture", version: "6" } };
          if (c.subscribe) return { id: c.id, subscribe: { recoverable: true, positioned: true, recovered: false, epoch: "cap", offset: 0 } };
          return { id: c.id };
        });
        queueMicrotask(() => this.onmessage?.(new MessageEvent("message", { data: replies.map((r) => JSON.stringify(r)).join("\n") })));
      }
      close() { this.readyState = 3; this.onclose?.(new CloseEvent("close", { code: 1000 })); }
    }
    window.WebSocket = CaptureSocket;
    /** 서버가 채널 토픽에 프레임을 낸 것처럼 밀어 넣는다. */
    window.__push = (channel, data) => {
      window.__offset += 1;
      const frame = JSON.stringify({ push: { channel, pub: { data, offset: window.__offset } } });
      window.__socket.onmessage?.(new MessageEvent("message", { data: frame }));
    };
  });
}

const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok) failures.push(name);
}

async function open(browser, origin, scheme, scene, hash) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 }, colorScheme: scheme, reducedMotion: "reduce", serviceWorkers: "block",
  });
  await installRoutes(context, scene);
  const page = await context.newPage();
  await installRealtime(page);
  await page.addInitScript((server) => { try { localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ } }, origin);
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("nav-team").waitFor({ timeout: 20_000 });
  await page.evaluate((h) => { location.hash = h; }, hash);
  return { context, page };
}

/** 서버가 원장에 행을 쓴 것처럼: 장면을 바꾸고 프레임을 밀어 넣는다. */
async function serverMoves(page, scene, runs, kind) {
  scene.runs = runs;
  const before = scene.progressCalls;
  await page.evaluate(
    ([channel, runId, k]) =>
      window.__push(channel, {
        type: "agent.run.event", v: 1, ts: Date.now(),
        payload: { run_id: runId, channel_id: channel.split(".")[1].toLowerCase(), kind: k },
      }),
    [`ch:ws${workspaceId.toUpperCase()}.${CH.toUpperCase()}`, runs[0]?.id ?? RUN_A, kind]
  );
  await page.waitForFunction(() => true);
  await page.waitForTimeout(500);
  return scene.progressCalls - before;
}

const pill = (page) =>
  page.locator('[data-testid="channel-item"][data-channel-id="' + CH + '"] [data-testid="agent-turn-badge"]');

async function u1(browser, origin, scheme) {
  const tag = `1440-${scheme}`;
  const shot = (name) => resolve(OUT_DIR, `${name}-${tag}.png`);
  const scene = newScene();
  const now = Date.now();
  const { context, page } = await open(browser, origin, scheme, scene, `/c/${CH}`);

  // ① 대기 2번째: 11분 전에 올라왔고 아직 아무도 가져가지 않았다. 옛 화면은 이미
  //    「신호 소실」이었다.
  scene.runs = [
    progress(now, { id: RUN_C, agentMemberId: otherAgentId, phase: "claimed", status: "queued", leaseState: "live", claimedAtMs: now - 2 * MIN, createdAtMs: now - 14 * MIN }),
    progress(now, { id: RUN_A, queuePosition: 2, aheadTotal: 1, ahead: [{ runId: RUN_C, channelId: CH }], triggerSummary: "채널 하나 만들어 줄래요?" }),
  ];
  await serverMoves(page, scene, scene.runs, "queued");
  await pill(page).first().waitFor({ timeout: 15_000 });
  const pillText = ((await pill(page).first().textContent()) ?? "").replace(/\s+/g, " ");
  check(`${tag} queued: 알약이 「작업 중」이 아니다`, !pillText.includes("작업 중"), pillText);
  const lineText = (await page.getByTestId("composer-working").textContent()) ?? "";
  check(`${tag} queued: 활동 줄이 「대기 2번째」와 「11분째 기다려요」를 말한다`, lineText.includes("대기 2번째") && lineText.includes("11분째 기다려요"), lineText);
  check(`${tag} queued: 「신호 소실」이 없다 (11분이 지났는데도)`, !(await page.locator("body").textContent())?.includes("신호 소실"));
  await page.getByTestId("composer-working-open").filter({ hasText: "그록봇" }).first().click();
  await page.getByTestId("agent-work-panel").waitFor();
  const chip = ((await page.getByTestId("agent-work-panel-state").textContent()) ?? "").trim();
  check(`${tag} queued: 패널 머리가 서버 낱말`, chip === "가져감" || chip.startsWith("대기"), chip);
  await page.screenshot({ path: shot("1-queued") });

  // ② 가져감 (소식 없음): 11분 만에 수령, lease는 그 뒤 만료.
  await serverMoves(page, scene, [
    progress(now, { id: RUN_A, phase: "claimed", status: "queued", leaseState: "live", claimedAtMs: now - 20_000 }),
  ], "claimed");
  await page.waitForTimeout(300);
  let text = (await page.getByTestId("composer-working").textContent()) ?? "";
  check(`${tag} claimed: 「가져감」`, text.includes("가져감"), text);
  check(`${tag} claimed: 11분 전에 올라온 run인데 소실이 아니다`, !text.includes("신호 소실"));
  await page.screenshot({ path: shot("2-claimed") });

  await serverMoves(page, scene, [
    progress(now, { id: RUN_A, phase: "claimed", status: "queued", leaseState: "stale", claimedAtMs: now - 34 * MIN }),
  ], "claimed");
  text = (await page.getByTestId("composer-working").textContent()) ?? "";
  check(`${tag} claimed-stale: 「가져간 뒤 34분째 소식이 없어요」 (끊김이라 하지 않는다)`, text.includes("가져간 뒤 34분째 소식이 없어요") && !text.includes("끊"), text);
  await page.screenshot({ path: shot("3-claimed-stale") });

  // ③ 진행 단계 — 에이전트가 보고한 만큼만.
  for (const [i, stage] of ["시작: 채널 이름 확인", "grokbot-lab 이름 점검", "승인 카드 제안 준비"].entries()) {
    await serverMoves(page, scene, [
      progress(now, { id: RUN_A, phase: "running", status: "running", leaseState: "live", claimedAtMs: now - 3 * MIN, startedAtMs: now - 2 * MIN, lastEventAtMs: now - 5_000, latestStage: stage, stepCount: i + 1 }),
    ], "stage");
    text = (await page.getByTestId("composer-working").textContent()) ?? "";
    check(`${tag} running-${i + 1}: 에이전트가 보고한 단계가 선다`, text.includes(stage), text);
    if (i === 0 || i === 2) await page.screenshot({ path: shot(`4-running-${i + 1}`) });
  }

  // ④ 승인 대기.
  await serverMoves(page, scene, [
    progress(now, { id: RUN_A, phase: "awaiting_approval", status: "awaiting_approval", leaseState: "live", claimedAtMs: now - 6 * MIN, startedAtMs: now - 5 * MIN, lastEventAtMs: now - MIN, approvalId: "0199aa11-2222-7000-8000-0000000000d1", approvalExpiresAtMs: now + 50 * MIN }),
  ], "approval_requested");
  const waitingPill = ((await pill(page).first().textContent()) ?? "").replace(/\s+/g, " ");
  check(`${tag} awaiting_approval: 알약 「승인 대기」`, waitingPill.includes("승인 대기"), waitingPill);
  await page.screenshot({ path: shot("5-awaiting-approval") });

  // ⑤ 끝(사유): 승인 만료로 시간 초과, 그리고 서버가 소식 끊김으로 끝낸 것.
  await serverMoves(page, scene, [
    progress(now, { id: RUN_A, phase: "timed_out", status: "timed_out", leaseState: "live", claimedAtMs: now - 70 * MIN, startedAtMs: now - 69 * MIN, finishedAtMs: now - MIN, endReason: "approval_expired" }),
  ], "timed_out");
  await page.waitForTimeout(300);
  const soft = async (id) => ((await page.getByTestId(id).textContent({ timeout: 3000 }).catch(() => "")) ?? "").trim();
  const ended = await soft("agent-work-panel-state");
  const endedDetail = await soft("agent-work-panel-detail");
  if (!endedDetail) console.log("panel header:", (await page.locator("[data-testid=agent-work-panel] header").textContent().catch(() => "(none)")));
  check(`${tag} ended: 「시간 초과 · 승인이 만료됐어요」`, ended === "시간 초과" && endedDetail === "승인이 만료됐어요", `${ended} / ${endedDetail}`);
  check(`${tag} ended: 알약이 사라진다`, (await pill(page).count()) === 0);
  await page.screenshot({ path: shot("6-ended-approval-expired") });

  await serverMoves(page, scene, [
    progress(now, { id: RUN_A, phase: "timed_out", status: "timed_out", leaseState: "stale", claimedAtMs: now - 200 * MIN, finishedAtMs: now - MIN, endReason: "lease_abandoned" }),
  ], "timed_out");
  await page.waitForTimeout(300);
  const lost = ((await page.getByTestId("agent-work-panel-state").textContent()) ?? "").trim();
  check(`${tag} ended: 「신호 소실」은 서버가 lease_abandoned로 알렸을 때만`, lost === "신호 소실", lost);
  await page.screenshot({ path: shot("7-ended-lease-abandoned") });

  // ⑥ 여러 run 병렬: 두 에이전트가 동시에.
  await serverMoves(page, scene, [
    progress(now, { id: RUN_A, phase: "running", status: "running", leaseState: "live", claimedAtMs: now - 3 * MIN, startedAtMs: now - 2 * MIN, lastEventAtMs: now - 5_000, latestStage: "채널 이름 확인" }),
    progress(now, { id: RUN_C, agentMemberId: otherAgentId, phase: "queued", status: "queued", queuePosition: 1, createdAtMs: now - 3 * MIN }),
  ], "queued");
  text = (await page.getByTestId("composer-working").textContent()) ?? "";
  check(`${tag} parallel: 진행 중 하나와 대기 하나가 각자의 낱말로 나란히`, text.includes("채널 이름 확인") && text.includes("대기 1번째"), text);
  await page.screenshot({ path: shot("8-parallel") });
  await context.close();

  // ⑦ 구 서버: 진행 경로가 404 → 한 번만 확인하고 옛 규칙으로.
  const legacy = newScene();
  legacy.legacyServer = true;
  const second = await open(browser, origin, scheme, legacy, `/c/${CH}`);
  await second.page.waitForTimeout(1500);
  const firstCalls = legacy.progressCalls;
  await second.page.evaluate(
    (channel) => window.__push(channel, { type: "agent.run.event", v: 1, ts: Date.now(), payload: { run_id: "x", channel_id: "x", kind: "stage" } }),
    `ch:ws${workspaceId.toUpperCase()}.${CH.toUpperCase()}`
  );
  await second.page.waitForTimeout(500);
  check(`${tag} legacy: 404를 확인한 뒤 프레임이 와도 다시 두드리지 않는다`, legacy.progressCalls === firstCalls && firstCalls >= 1, `${firstCalls} -> ${legacy.progressCalls}`);
  await second.context.close();
}


const ledger = (now, rows) =>
  rows.map(([kind, minAgo, extra = {}], i) => ({ ordinal: i + 1, kind, createdAtMs: now - minAgo * MIN, ...extra }));

async function open2(browser, origin, scheme, scene) {
  const opened = await open(browser, origin, scheme, scene, `/c/${CH}`);
  return opened;
}

async function openPanelFor(page, who) {
  await page.getByTestId("composer-working-open").filter({ hasText: who }).first().click();
  await page.getByTestId("agent-work-panel").waitFor();
}

async function u2(browser, origin, scheme) {
  const tag = `1440-${scheme}`;
  const shot = (name) => resolve(OUT_DIR, `${name}-${tag}.png`);
  const now = Date.now();
  const APPROVAL = "0199aa11-2222-7000-8000-0000000000d1";
  const CARD_MSG = "00000000-0000-7000-8000-0000000b0001";
  const scene = newScene();
  scene.runs = [
    progress(now, { id: RUN_A, phase: "awaiting_approval", status: "awaiting_approval", leaseState: "live", claimedAtMs: now - 9 * MIN, startedAtMs: now - 9 * MIN, lastEventAtMs: now - 3 * MIN, approvalId: APPROVAL, approvalExpiresAtMs: now + 50 * MIN, triggerSummary: "grokbot-lab 채널 만들기", createdAtMs: now - 12 * MIN }),
    progress(now, { id: RUN_C, phase: "running", status: "running", leaseState: "live", claimedAtMs: now - 5 * MIN, startedAtMs: now - 4 * MIN, lastEventAtMs: now - 20_000, latestStage: "릴리스 노트 초안 정리", triggerSummary: "릴리스 노트 정리", createdAtMs: now - 6 * MIN }),
    progress(now, { id: RUN_D, queuePosition: 3, aheadTotal: 2, triggerSummary: "회의록 요약", createdAtMs: now - 3 * MIN }),
    progress(now, { id: RUN_E, queuePosition: 4, aheadTotal: 3, ahead: [{ runId: RUN_D, channelId: CH }], triggerSummary: "일정 정리", createdAtMs: now - 2 * MIN }),
    progress(now, { id: RUN_F, phase: "timed_out", status: "timed_out", leaseState: "live", claimedAtMs: now - 80 * MIN, finishedAtMs: now - 20 * MIN, endReason: "approval_expired", triggerSummary: "설정 바꾸기", createdAtMs: now - 85 * MIN }),
  ];
  scene.ledgers[RUN_A] = ledger(now, [
    ["queued", 12], ["claimed", 9], ["started", 9],
    ["stage", 8, { stage: "시작: 채널 이름 확인" }],
    ["stage", 6, { stage: "grokbot-lab 이름 점검" }],
    ["stage", 4, { stage: "승인 카드 제안 준비" }],
    ["approval_requested", 3, { approvalId: APPROVAL }],
  ]);
  scene.ledgers[RUN_C] = ledger(now, [["queued", 6], ["claimed", 5], ["started", 4], ["stage", 1, { stage: "릴리스 노트 초안 정리" }]]);
  scene.ledgers[RUN_F] = ledger(now, [
    ["queued", 85], ["claimed", 80], ["started", 80],
    ["approval_requested", 79, { approvalId: "0199aa11-2222-7000-8000-0000000000d9" }],
    ["approval_decided", 20, { code: "expired", approvalId: "0199aa11-2222-7000-8000-0000000000d9" }],
    ["timed_out", 20, { code: "approval_expired" }],
  ]);
  scene.approvals = [{
    id: APPROVAL, workspaceId, runId: RUN_A, channelId: CH, requestMessageId: CARD_MSG, requestedBy: agentId,
    actionType: "workspace_action",
    payload: { action: { id: "channel.create", args: {}, rationale: null }, proposed_by: agentId, resume_model: null },
    status: "pending", expiresAtMs: now + 50 * MIN, createdAtMs: now - 3 * MIN,
  }];

  const { context, page } = await open2(browser, origin, scheme, scene);
  await serverMoves(page, scene, scene.runs, "approval_requested");
  await page.getByTestId("composer-working-open").first().waitFor({ timeout: 15_000 });
  await openPanelFor(page, "그록봇");
  // 컴포저 줄은 에이전트당 하나라 가장 강한 상태(작업 중)의 run으로 열린다. 승인
  // 대기 run은 목록에서 고른다.
  await page.locator(`[data-run-id="${RUN_A}"]`).click();

  // ① 서버 원장이 기록이다 + 승인 카드 링크 + 한계 한 줄
  await page.getByTestId("agent-work-panel-ledger").waitFor();
  const rowsText = (await page.getByTestId("agent-work-panel-ledger-row").allTextContents()).join(" | ");
  check(`${tag} ledger: 요청→가져감→시작→단계 3개→승인 요청이 시각과 함께 선다`,
    ["요청이 들어왔어요", "에이전트가 일을 가져갔어요", "작업을 시작했어요", "시작: 채널 이름 확인", "grokbot-lab 이름 점검", "승인 카드 제안 준비", "승인을 요청했어요"].every((t) => rowsText.includes(t)) &&
    (await page.getByTestId("agent-work-panel-ledger-time").first().textContent())?.match(/^\d\d:\d\d$/) !== null, rowsText);
  const bodyText = (await page.getByTestId("agent-work-panel").textContent()) ?? "";
  check(`${tag} ledger: 거짓 문구 「패널을 닫으면 이 기록은 사라집니다」가 없다`, !bodyText.includes("이 기록은 사라집니다") && !bodyText.includes("이 기록은 사라져요"));
  check(`${tag} ledger: 「패널을 닫아도 남아요」`, bodyText.includes("패널을 닫아도"));
  const limit = ((await page.getByTestId("agent-work-panel-limit").textContent()) ?? "").trim();
  check(`${tag} ledger: 보이는 것의 한계 한 줄`, limit === "에이전트가 보낸 만큼만 보여요. 보내지 않은 생각은 oort도 알 수 없어요.", limit);
  check(`${tag} ledger: 「실시간」을 약속하지 않는다`, !bodyText.includes("실시간"));
  const link = page.getByTestId("agent-work-panel-approval-link");
  check(`${tag} approval: 카드로 가는 링크`, ((await link.getAttribute("href")) ?? "").includes(`msg=${CARD_MSG}`), String(await link.getAttribute("href")));
  await page.screenshot({ path: shot("1-ledger-approval") });

  // ② 여러 run: 진행 중(병렬) · 대기열(순서) · 끝난 일
  const sections = await page.locator('[data-testid="agent-work-panel-runs-section"]').evaluateAll((els) => els.map((el) => el.getAttribute("data-section")));
  check(`${tag} runs: 진행 중 → 대기열 → 끝난 일 순서`, sections.join(",") === "active,queue,done", sections.join(","));
  const activeRows = await page.locator('[data-section="active"] [data-testid="agent-work-panel-run"]').allTextContents();
  check(`${tag} runs: 진행 중 둘이 나란히 (작업 중 + 승인 대기)`, activeRows.length === 2 && activeRows.join("|").includes("승인 대기") && activeRows.join("|").includes("작업 중"), activeRows.join("|"));
  const queueRows = await page.locator('[data-section="queue"] [data-testid="agent-work-panel-run"]').allTextContents();
  check(`${tag} runs: 대기열은 서버 순번대로`, queueRows[0]?.includes("대기 3번째") && queueRows[1]?.includes("대기 4번째"), queueRows.join("|"));
  const doneRows = await page.locator('[data-section="done"] [data-testid="agent-work-panel-run"]').allTextContents();
  check(`${tag} runs: 끝난 일은 사유와 함께`, doneRows[0]?.includes("시간 초과") && doneRows[0]?.includes("승인이 만료됐어요"), doneRows.join("|"));

  // ③ 대기열 2번째를 고른다: 내 채널의 앞선 일은 자세히, 나머지는 건수만
  await page.locator(`[data-run-id="${RUN_E}"]`).click();
  await page.getByTestId("agent-work-panel-ahead").waitFor();
  const aheadRows = await page.getByTestId("agent-work-panel-ahead-row").allTextContents();
  check(`${tag} queue: 내 채널의 앞선 일은 제목이 있다`, aheadRows.length === 1 && aheadRows[0].includes("회의록 요약") && aheadRows[0].includes("#계획"), aheadRows.join("|"));
  const hidden = ((await page.getByTestId("agent-work-panel-ahead-hidden").textContent()) ?? "").trim();
  check(`${tag} queue: 그 밖은 「앞에 N건」만`, hidden.startsWith("앞에 2건이 더 있어요") && !hidden.includes("#"), hidden);
  const emptyHeadline = ((await page.getByTestId("agent-work-panel-empty").textContent()) ?? "");
  const headerDetail = await page.getByTestId("agent-work-panel-detail").count();
  check(`${tag} queue: 목록이 있으면 머리에 같은 근거 줄을 되풀이하지 않는다`, headerDetail === 0, String(headerDetail));
  check(`${tag} queue: 선택 행은 왼쪽 막대로 표시된다`, ((await page.locator(`[data-run-id="${RUN_E}"]`).getAttribute("class")) ?? "").includes("border-ink"));
  check(`${tag} queue: 수령 전 빈 기록 안내`, emptyHeadline.includes("아직 아무도 일을 가져가지 않았어요"), emptyHeadline);
  await page.screenshot({ path: shot("2-queue-ahead") });

  // ④ 끝난 일을 고른다
  await page.locator(`[data-run-id="${RUN_F}"]`).click();
  await page.getByTestId("agent-work-panel-ledger").waitFor();
  const endText = (await page.getByTestId("agent-work-panel-ledger-reason").allTextContents()).join("|");
  check(`${tag} done: 끝난 줄에 사유`, endText.includes("승인이 만료됐어요"), endText);
  check(`${tag} done: 결정된 승인에는 카드 링크가 없다`, (await page.getByTestId("agent-work-panel-ledger-card-link").count()) === 0 && (await page.getByTestId("agent-work-panel-approval-link").count()) === 0);
  await page.screenshot({ path: shot("3-done-reason") });

  // ⑤ 닫아도 남는다: 닫고 다시 열면 같은 기록이 서버에서 온다
  await page.getByTestId("agent-work-panel-close").click();
  await page.getByTestId("agent-work-panel").waitFor({ state: "detached" });
  const before = scene.ledgerCalls;
  await openPanelFor(page, "그록봇");
  await page.getByTestId("agent-work-panel-ledger").waitFor();
  const again = (await page.getByTestId("agent-work-panel-ledger-row").allTextContents()).join(" | ");
  check(`${tag} kept: 닫았다 다시 열어도 같은 기록 (서버를 다시 읽는다)`, again.includes("릴리스 노트 초안 정리") && scene.ledgerCalls > before, `${before} -> ${scene.ledgerCalls}`);
  await page.locator(`[data-run-id="${RUN_A}"]`).click();
  await page.getByTestId("agent-work-panel-approval-link").waitFor();
  const kept = (await page.getByTestId("agent-work-panel-ledger-row").allTextContents()).join(" | ");
  check(`${tag} kept: 승인 대기 run의 기록도 그대로`, kept.includes("grokbot-lab 이름 점검") && kept.includes("승인을 요청했어요"), kept);
  await context.close();

  // ⑥ 서버가 모르는 run: 이 화면에만 있는 기록
  const legacy = newScene();
  const second = await open2(browser, origin, scheme, legacy);
  await second.page.waitForTimeout(1200);
  await second.page.evaluate(
    ([agentChannel, run, agent, channel]) => window.__push(agentChannel, { type: "agent.status", v: 1, ts: Date.now(), payload: { run_id: run, agent_member_id: agent, channel_id: channel, phase: "streaming", run_status: "running" } }),
    [`agent:ws${workspaceId.toUpperCase()}.${CH.toUpperCase()}.${agentId.toUpperCase()}`, RUN_B, agentId, CH]
  );
  await second.page.getByTestId("composer-working-open").first().waitFor({ timeout: 10_000 });
  await second.page.getByTestId("composer-working-open").first().click();
  await second.page.getByTestId("agent-work-panel").waitFor();
  const local = ((await second.page.getByTestId("agent-work-panel-limit").textContent()) ?? "").trim();
  check(`${tag} local: 서버가 모르는 run은 「이 화면에만 있어요」`, local === "이 기록은 이 화면에만 있어요. 패널을 닫으면 사라져요.", local);
  check(`${tag} local: 서버 원장 영역이 없다`, (await second.page.getByTestId("agent-work-panel-ledger").count()) === 0 && (await second.page.getByTestId("agent-work-panel-runs").count()) === 0);
  await second.page.screenshot({ path: shot("4-local-only") });
  await second.context.close();
}

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) throw new Error("dist/ is missing. Run npm run build first.");
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  try {
    for (const scheme of ["light", "dark"]) {
      if (SLICE === "u1") await u1(browser, preview.origin, scheme);
      if (SLICE === "u2") await u2(browser, preview.origin, scheme);
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
