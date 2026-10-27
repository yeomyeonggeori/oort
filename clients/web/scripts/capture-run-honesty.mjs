#!/usr/bin/env node
// =============================================================================
// ADR-0200 UXUI 캡처 (#3747 U1 · #3748 U2 · #3749 U3): 외부 에이전트 작업 상태를
// 사실대로.
//
//   SLICE=u3  생존 라벨 5종(응답함 n분 전 · 살아 있음 · 대기 중 · 일이 기다리는 중 · 깨웠지만 아직
//             안 가져감 · 응답 없음 n분)을 멤버 목록·에이전트 헤더·사이드바 DM 행·작업 패널에,
//             owner/admin에게만 보이는 「다시 깨우기」와 쿨다운.
//   SLICE=u2  서버 원장 기록(닫아도 남는다) · 여러 run(진행 중 병렬·대기열 순서·끝난 일) ·
//             대기열 앞(내 채널은 자세히, 아니면 「앞에 N건」) · 승인 카드 링크 ·
//             보이는 것의 한계 한 줄 · 서버가 모르는 run(이 화면에만 있는 기록).
//   SLICE=stop 사람의 중단 (#3852): 열린 run에만 서는 「중단」 → 확인 문장 → 확정 →
//             영수증·원장 「취소됐어요 · 사람이 중단했어요」, 이미 끝난 run(409)·권한 없음(403).
//   SLICE=u1  대기 2번째 → 가져감(소식 없음 포함) → 진행 단계 → 승인 대기 → 끝(사유),
//             여러 run 병렬. 사이드바 알약·컴포저 활동 줄·작업 패널 머리.
//   SLICE=d1  #3824: 보낸 메시지 아래 상태 줄(받았어요 → 깨우는 신호 보냄 → 가져감 →
//             작업 중 → 결과)과 일마다 걸린 시간(대기 → 작업 → 총), 원장의 깨우는 신호 줄
//             (접어 횟수), 이 앱이 모르는 원장 종류가 와도 깨지지 않는 기록.
//
// #4619로 갱신: 대화 안의 표시가 바뀌었다(docs/design-system/agent-work-display.md). 입력창 레일은 한 줄
// 「이름 · 낱말 · 최근 단계」이고 누르면 팝오버가 열려 에이전트 행이 작업 패널을 연다(경과·「가져간 뒤 N분째 소식이 없어요」는
// 팝오버에서만). 메시지 아래 문장 행(d1)은 없어졌고 머리 칩과 예외 줄(아직 받지 않았어요·깨우는 신호가 닿지 않음·실패·시간 초과)이
// 대신한다. 이 파일의 슬라이스는 그 말에 맞춰 이식됐다.
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
  return { runs: [], progressCalls: 0, ledgers: {}, ledgerCalls: 0, ledgerIncludes: [], approvals: [], liveness: {}, ringCalls: 0, ringMode: "ok", role: "owner", dmChannels: [], cancelCalls: [], cancelMode: "ok" };
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
    const livenessMatch = path.match(/\/agents\/([^/]+)\/liveness$/);
    if (livenessMatch) {
      const hit = scene.liveness[livenessMatch[1].toLowerCase()];
      return hit ? json(route, { agentMemberId: livenessMatch[1].toLowerCase(), ...hit }) : json(route, { error: { code: "not_found", message: "not found" } }, 404);
    }
    if (path.endsWith("/doorbell/ring") && method === "POST") {
      scene.ringCalls += 1;
      if (scene.ringMode === "limited") return json(route, { error: "rate limited", retryAfterSeconds: 2700 }, 429);
      const requestedAtMs = Date.now();
      return json(route, { requestedAtMs, nextAllowedAtMs: requestedAtMs + 60_000 }, 202);
    }
    if (path.endsWith("/hosted-agent-connections") && method === "GET") {
      if (scene.role === "member") return json(route, { error: { code: "forbidden", message: "forbidden" } }, 403);
      return json(route, { connections: Object.keys(scene.liveness).map((agent, i) => ({
        id: `00000000-0000-7000-8000-00000000050${i}`, agentMemberId: agent, status: "active", authMode: "static_bearer",
        audience: "https://oort.example.test", approvedChannelIds: [CH], approvedScopes: [], createdAtMs: 1 + i, updatedAtMs: 1 + i,
      })) });
    }
    if (path.endsWith("/profile") && method === "GET" && path.includes("/agents/")) {
      const id = path.split("/").at(-2);
      return json(route, { profile: { agentMemberId: id, workspaceId, instructions: "채널 정리와 일정 요약을 맡아요.", enabledTools: [], triggers: { mention: true }, paused: false, version: 1, updatedBy: memberId, updatedAtMs: Date.now() - 86_400_000 } });
    }
    if (path.endsWith("/allowed-models")) return json(route, { allowedAgentModels: [] });
    const cancelMatch = path.match(/\/agent-runs\/([^/]+)\/cancel$/);
    if (cancelMatch && method === "POST") {
      const runId = cancelMatch[1].toLowerCase();
      scene.cancelCalls.push(path);
      if (scene.cancelMode === "forbidden") return json(route, { error: { code: "forbidden", message: "active human channel member required" } }, 403);
      if (scene.cancelMode === "over") return json(route, { error: { code: "conflict", message: "agent run is already succeeded" } }, 409);
      // 서버처럼: run을 cancelled로, 원장에 human_cancelled 줄을 더한다(migration 128 트리거).
      scene.runs = scene.runs.map((r) => (r.id === runId ? { ...r, phase: "cancelled", status: "cancelled", finishedAtMs: Date.now(), endReason: "human_cancelled" } : r));
      scene.ledgers[runId] = [...(scene.ledgers[runId] ?? []), { ordinal: (scene.ledgers[runId]?.length ?? 0) + 1, kind: "cancelled", code: "human_cancelled", createdAtMs: Date.now() }];
      return json(route, { runId, status: "cancelled", linkedWorkSessionIds: [], workSessionsTerminated: false });
    }
    const ledgerMatch = path.match(/\/agent-runs\/([^/]+)\/events$/);
    if (ledgerMatch) {
      scene.ledgerCalls += 1;
      scene.ledgerIncludes.push(url.searchParams.get("include"));
      const runId = ledgerMatch[1].toLowerCase();
      return json(route, { runId, events: scene.ledgers[runId] ?? [] });
    }
    if (path.endsWith("/channels")) return json(route, { channels: [...channels, ...(scene.dmChannels ?? [])] });
    if (path.endsWith("/roster")) {
      return json(route, { members: scene.roster ?? roster.map((m) => (m.id === memberId ? { ...m, role: scene.role } : m)) });
    }
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
    if (path.includes(`/channels/${CH}/messages`)) return json(route, { messages: scene.messageRows ?? messageRows });
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
  // `nav-team`은 ADR-0202 D6(#3842)이 사이드바를 「작업」 한 줄로 합치며 걷었다. 로그인이 끝났다는 신호는 채널 목록이다.
  await page.getByTestId("channel-item").first().waitFor({ timeout: 20_000 });
  await page.evaluate((h) => { location.hash = h; }, hash);
  return { context, page };
}

/** 서버가 원장에 행을 쓴 것처럼: 장면을 바꾸고 프레임을 밀어 넣는다. */
async function serverMoves(page, scene, runs, kind) {
  scene.runs = runs;
  const before = scene.progressCalls;
  // 로그인 직후에는 가짜 소켓이 아직 없을 수 있다(구독 전). 있을 때 민다.
  await page.waitForFunction(() => window.__socket !== undefined, null, { timeout: 15_000 });
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
  // 내 메시지 하나가 run의 트리거다(예외 줄과 머리 칩이 서려면 run이 가리키는 메시지가 화면에 있어야 한다).
  const TRIGGER = "00000000-0000-7000-8000-0000000a0001";

  // ① 기다린 지 11분: 5분 유예를 넘었으니 입력창 레일에서는 빠지고 메시지 아래 예외 줄이 「아직 받지 않았어요」라고 말한다.
  //    옛 화면은 이미 「신호 소실」이었다. 경과(「11분째」)는 대화에 말하지 않는다(초·분 단위 없음).
  scene.runs = [
    progress(now, { id: RUN_C, agentMemberId: otherAgentId, phase: "claimed", status: "queued", leaseState: "live", claimedAtMs: now - 2 * MIN, createdAtMs: now - 14 * MIN }),
    progress(now, { id: RUN_A, triggerMessageId: TRIGGER, queuePosition: 2, aheadTotal: 1, ahead: [{ runId: RUN_C, channelId: CH }], triggerSummary: "채널 하나 만들어 줄래요?" }),
  ];
  await serverMoves(page, scene, scene.runs, "queued");
  await pill(page).first().waitFor({ timeout: 15_000 });
  const pillText = ((await pill(page).first().textContent()) ?? "").replace(/\s+/g, " ");
  check(`${tag} queued: 알약이 「작업 중」이 아니다`, !pillText.includes("작업 중"), pillText);
  await page.getByTestId("run-exception").waitFor({ timeout: 15_000 });
  const lineText = ((await page.getByTestId("run-exception-text").first().textContent()) ?? "").trim();
  check(`${tag} queued: 예외 줄이 「아직 받지 않았어요」를 말한다`, lineText === "그록봇: 아직 받지 않았어요", lineText);
  check(`${tag} queued: 대화에 경과 숫자가 없다(「11분째」)`, !/\d+\s*(시간|분|초)/.test(lineText), lineText);
  // 화면에 **보이는** 글이다(`innerText`): 칩의 폭을 지키는 보이지 않는 유령 낱말(`invisible`, `aria-hidden`)에는 「신호 소실」이 있다.
  check(`${tag} queued: 「신호 소실」이 보이지 않는다 (11분이 지났는데도)`, !(await page.locator("body").innerText())?.includes("신호 소실"));
  check(`${tag} queued: 머리 칩도 같은 낱말`, ((await page.getByTestId("trigger-chip-word").first().textContent()) ?? "").trim() === "아직 받지 않았어요");
  await page.getByTestId("run-exception-open").click();
  await page.getByTestId("agent-work-panel").waitFor();
  const chip = ((await page.getByTestId("agent-work-panel-state").textContent()) ?? "").trim();
  check(`${tag} queued: 패널 머리가 같은 낱말(카드·줄·칩과 한 상수)`, chip === "아직 받지 않았어요", chip);
  await page.screenshot({ path: shot("1-queued") });

  // ② 가져감 (소식 없음): 11분 만에 수령, lease는 그 뒤 만료. 레일의 한 줄은 「가져감」이다(여럿이면 +N으로 합쳐진다).
  await serverMoves(page, scene, [
    progress(now, { id: RUN_A, triggerMessageId: TRIGGER, phase: "claimed", status: "queued", leaseState: "live", claimedAtMs: now - 20_000 }),
  ], "claimed");
  await page.waitForTimeout(300);
  let text = (await page.getByTestId("composer-working").textContent()) ?? "";
  check(`${tag} claimed: 「가져감」`, text.includes("가져감"), text);
  check(`${tag} claimed: 11분 전에 올라온 run인데 소실이 아니다`, !text.includes("신호 소실"));
  await page.screenshot({ path: shot("2-claimed") });

  await serverMoves(page, scene, [
    progress(now, { id: RUN_A, triggerMessageId: TRIGGER, phase: "claimed", status: "queued", leaseState: "stale", claimedAtMs: now - 34 * MIN }),
  ], "claimed");
  // 경과 근거는 팝오버에만 있다(레일의 줄에는 없다): 줄을 눌러 팝오버를 열어 읽는다.
  await page.getByTestId("composer-working-open").first().click();
  await page.getByTestId("composer-working-popover").waitFor();
  text = (await page.getByTestId("composer-working-popover").textContent()) ?? "";
  check(`${tag} claimed-stale: 팝오버가 「가져간 뒤 34분째 소식이 없어요」 (끊김이라 하지 않는다)`, text.includes("가져간 뒤 34분째 소식이 없어요") && !text.includes("끊"), text);
  check(`${tag} claimed-stale: 레일의 줄에는 경과가 없다`, !((await page.getByTestId("composer-working-text").textContent()) ?? "").includes("34분"));
  await page.screenshot({ path: shot("3-claimed-stale") });
  await page.keyboard.press("Escape");

  // ③ 진행 단계 — 에이전트가 보고한 만큼만.
  for (const [i, stage] of ["시작: 채널 이름 확인", "grokbot-lab 이름 점검", "승인 카드 제안 준비"].entries()) {
    await serverMoves(page, scene, [
      progress(now, { id: RUN_A, triggerMessageId: TRIGGER, phase: "running", status: "running", leaseState: "live", claimedAtMs: now - 3 * MIN, startedAtMs: now - 2 * MIN, lastEventAtMs: now - 5_000, latestStage: stage, stepCount: i + 1 }),
    ], "stage");
    text = (await page.getByTestId("composer-working").textContent()) ?? "";
    check(`${tag} running-${i + 1}: 에이전트가 보고한 단계가 선다`, text.includes(stage), text);
    check(`${tag} running-${i + 1}: 머리 칩은 「작업 중」`, ((await page.getByTestId("trigger-chip-word").first().textContent()) ?? "").trim() === "작업 중");
    if (i === 0 || i === 2) await page.screenshot({ path: shot(`4-running-${i + 1}`) });
  }

  // ④ 승인 대기.
  await serverMoves(page, scene, [
    progress(now, { id: RUN_A, triggerMessageId: TRIGGER, phase: "awaiting_approval", status: "awaiting_approval", leaseState: "live", claimedAtMs: now - 6 * MIN, startedAtMs: now - 5 * MIN, lastEventAtMs: now - MIN, approvalId: "0199aa11-2222-7000-8000-0000000000d1", approvalExpiresAtMs: now + 50 * MIN }),
  ], "approval_requested");
  const waitingPill = ((await pill(page).first().textContent()) ?? "").replace(/\s+/g, " ");
  check(`${tag} awaiting_approval: 알약 「승인 대기」`, waitingPill.includes("승인 대기"), waitingPill);
  check(`${tag} awaiting_approval: 레일도 칩도 같은 낱말`, ((await page.getByTestId("composer-working").textContent()) ?? "").includes("승인 대기") && ((await page.getByTestId("trigger-chip-word").first().textContent()) ?? "").trim() === "승인 대기");
  await page.screenshot({ path: shot("5-awaiting-approval") });

  // ⑤ 끝(사유): 승인 만료로 시간 초과, 그리고 서버가 소식 끊김으로 끝낸 것.
  await serverMoves(page, scene, [
    progress(now, { id: RUN_A, triggerMessageId: TRIGGER, phase: "timed_out", status: "timed_out", leaseState: "live", claimedAtMs: now - 70 * MIN, startedAtMs: now - 69 * MIN, finishedAtMs: now - MIN, endReason: "approval_expired" }),
  ], "timed_out");
  await page.waitForTimeout(300);
  const soft = async (id) => ((await page.getByTestId(id).textContent({ timeout: 3000 }).catch(() => "")) ?? "").trim();
  const ended = await soft("agent-work-panel-state");
  const endedDetail = await soft("agent-work-panel-detail");
  if (!endedDetail) console.log("panel header:", (await page.locator("[data-testid=agent-work-panel] header").textContent().catch(() => "(none)")));
  // #3824: 근거 줄은 걸린 시간을 먼저 말한다(「10분 걸림 · 승인이 만료됐어요」).
  check(`${tag} ended: 「시간 초과 · … 걸림 · 승인이 만료됐어요」`, ended === "시간 초과" && /걸림 · 승인이 만료됐어요$/.test(endedDetail), `${ended} / ${endedDetail}`);
  check(`${tag} ended: 알약이 사라진다`, (await pill(page).count()) === 0);
  check(`${tag} ended: 메시지 아래 예외 줄이 「시간 초과 · 승인이 만료됐어요」`, ((await page.getByTestId("run-exception-text").first().textContent()) ?? "").includes("시간 초과 · 승인이 만료됐어요"));
  await page.screenshot({ path: shot("6-ended-approval-expired") });

  await serverMoves(page, scene, [
    progress(now, { id: RUN_A, triggerMessageId: TRIGGER, phase: "timed_out", status: "timed_out", leaseState: "stale", claimedAtMs: now - 200 * MIN, finishedAtMs: now - MIN, endReason: "lease_abandoned" }),
  ], "timed_out");
  await page.waitForTimeout(300);
  const lost = ((await page.getByTestId("agent-work-panel-state").textContent()) ?? "").trim();
  check(`${tag} ended: 「신호 소실」은 서버가 lease_abandoned로 알렸을 때만`, lost === "신호 소실", lost);
  // design-review r1 H2: 칩도 줄과 같은 낱말·같은 경고 톤이다(서버가 `failed`로 끝낸 것만 「실패」·위험 톤, ADR-0132: 부재를 오류로 올리지 않는다).
  const lostChip = page.getByTestId("trigger-chip").first();
  const lostChipClass = (await lostChip.getAttribute("class")) ?? "";
  check(`${tag} ended: 줄도 칩도 같은 낱말(신호 소실)이고 칩은 경고 톤이다(위험 톤 아님)`,
    ((await page.getByTestId("run-exception-text").first().textContent()) ?? "").includes("신호 소실") &&
      ((await page.getByTestId("trigger-chip-word").first().textContent()) ?? "").trim() === "신호 소실" &&
      (await lostChip.getAttribute("data-kind")) === "timed_out" && /bg-warn-soft/.test(lostChipClass) && !/danger/.test(lostChipClass), lostChipClass);
  await page.screenshot({ path: shot("7-ended-lease-abandoned") });

  // ⑥ 여러 run 병렬: 두 에이전트가 동시에. 레일은 한 줄(이끄는 쪽 + N)이고 둘은 팝오버에서 각자의 낱말로 나란히 선다.
  await serverMoves(page, scene, [
    progress(now, { id: RUN_A, triggerMessageId: TRIGGER, phase: "running", status: "running", leaseState: "live", claimedAtMs: now - 3 * MIN, startedAtMs: now - 2 * MIN, lastEventAtMs: now - 5_000, latestStage: "채널 이름 확인" }),
    progress(now, { id: RUN_C, agentMemberId: otherAgentId, phase: "queued", status: "queued", queuePosition: 1, createdAtMs: now - 3 * MIN }),
  ], "queued");
  text = ((await page.getByTestId("composer-working-text").textContent()) ?? "").replace(/\s+/g, " ").trim();
  check(`${tag} parallel: 레일은 한 줄로 합친다(「그록봇 +1」)`, text === "그록봇 +1", text);
  await page.getByTestId("composer-working-open").first().click();
  await page.getByTestId("composer-working-popover").waitFor();
  const parallel = (await page.getByTestId("composer-working-agent").allTextContents()).join(" | ");
  check(`${tag} parallel: 진행 중 하나와 대기 하나가 팝오버에서 각자의 낱말로 나란히`, parallel.includes("채널 이름 확인") && parallel.includes("받음"), parallel);
  await page.screenshot({ path: shot("8-parallel") });
  await page.keyboard.press("Escape");
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

/**
 * 레일의 줄을 눌러 팝오버를 열고(#4619), 그 에이전트의 행을 눌러 작업 패널을 연다. 줄은 이끄는 에이전트(+N)만 이름으로
 * 말하므로 `who`는 팝오버 행으로 고른다.
 */
async function openPanelViaRail(page, who) {
  await page.getByTestId("composer-working-open").first().click();
  const rows = page.getByTestId("composer-working-agent");
  await rows.first().waitFor({ timeout: 5_000 });
  await (who ? rows.filter({ hasText: who }) : rows).first().click();
  await page.getByTestId("agent-work-panel").waitFor();
}

async function openPanelFor(page, who) {
  await openPanelViaRail(page, who);
}

async function stop(browser, origin, scheme) {
  const tag = `1440-${scheme}`;
  const shot = (name) => resolve(OUT_DIR, `${name}-${tag}.png`);
  const now = Date.now();
  const running = () =>
    progress(now, { id: RUN_A, phase: "running", status: "running", leaseState: "live", claimedAtMs: now - 4 * MIN, startedAtMs: now - 3 * MIN, lastEventAtMs: now - 10_000, latestStage: "grokbot-lab 이름 점검", triggerSummary: "채널 하나 만들어 줄래요?", createdAtMs: now - 5 * MIN });
  const ledgerA = () => ledger(now, [["queued", 5], ["claimed", 4], ["started", 3], ["stage", 2, { stage: "시작: 채널 이름 확인" }], ["stage", 1, { stage: "grokbot-lab 이름 점검" }]]);

  // ①~③ 중단 → 확인 → 확정 → 영수증과 원장
  const scene = newScene();
  scene.runs = [running()];
  scene.ledgers[RUN_A] = ledgerA();
  const { context, page } = await open(browser, origin, scheme, scene, `/c/${CH}`);
  await serverMoves(page, scene, scene.runs, "stage");
  await page.getByTestId("composer-working-open").first().waitFor({ timeout: 15_000 });
  await openPanelFor(page, "그록봇");
  await page.getByTestId("agent-work-panel-stop-arm").waitFor({ timeout: 10_000 });
  check(`${tag} 열린 run에 「중단」이 선다`, ((await page.getByTestId("agent-work-panel-stop-arm").textContent()) ?? "").trim() === "중단");
  check(`${tag} 이름이 「확인 필요」를 말한다`, (await page.getByTestId("agent-work-panel-stop-arm").getAttribute("aria-label")) === "실행 중단, 확인 필요");
  await page.screenshot({ path: shot("1-stop-offer") });

  await page.getByTestId("agent-work-panel-stop-arm").click();
  await page.getByTestId("agent-work-panel-stop-confirm").waitFor();
  check(`${tag} 첫 클릭은 아무것도 보내지 않는다`, scene.cancelCalls.length === 0, String(scene.cancelCalls.length));
  await page.screenshot({ path: shot("2-stop-confirm") });

  await page.getByTestId("agent-work-panel-stop-commit").click();
  await page.getByTestId("agent-work-panel-stop-outcome").waitFor();
  check(`${tag} run 취소 경로로 한 번`, scene.cancelCalls.length === 1 && scene.cancelCalls[0].endsWith(`/agent-runs/${RUN_A}/cancel`), scene.cancelCalls.join(","));
  // 서버가 run 프레임을 낸 것처럼.
  await serverMoves(page, scene, scene.runs, "cancelled");
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="agent-work-panel-ledger-row"]')].some((n) => n.getAttribute("data-kind") === "cancelled"), null, { timeout: 8_000 });
  const outcomeText = ((await page.getByTestId("agent-work-panel-stop-outcome").textContent()) ?? "").trim();
  check(`${tag} 영수증`, outcomeText === "그록봇의 실행을 중단했어요.", outcomeText);
  const reasons = await page.getByTestId("agent-work-panel-ledger-reason").allTextContents();
  check(`${tag} 원장 사유 「사람이 중단했어요」`, reasons.some((r) => r.includes("사람이 중단했어요")), reasons.join("|"));
  check(`${tag} 끝난 run에는 버튼이 없다`, (await page.getByTestId("agent-work-panel-stop-arm").count()) === 0);
  await page.screenshot({ path: shot("3-stop-done-ledger") });
  await context.close();

  // ④ 이미 끝난 run(409)
  const over = newScene();
  over.runs = [running()];
  over.ledgers[RUN_A] = ledgerA();
  over.cancelMode = "over";
  const second = await open(browser, origin, scheme, over, `/c/${CH}`);
  await serverMoves(second.page, over, over.runs, "stage");
  await second.page.getByTestId("composer-working-open").first().waitFor({ timeout: 15_000 });
  await openPanelFor(second.page, "그록봇");
  await second.page.getByTestId("agent-work-panel-stop-arm").click();
  await second.page.getByTestId("agent-work-panel-stop-commit").click();
  await second.page.getByTestId("agent-work-panel-stop-outcome").waitFor();
  const overText = ((await second.page.getByTestId("agent-work-panel-stop-outcome").textContent()) ?? "").trim();
  check(`${tag} 409는 「이미 끝났어요」`, overText === "이 실행은 이미 끝났어요. 에이전트가 먼저 마쳤어요.", overText);
  await second.page.screenshot({ path: shot("4-stop-already-over") });
  await second.context.close();

  // ⑤ 권한 없음(403)
  const denied = newScene();
  denied.runs = [running()];
  denied.ledgers[RUN_A] = ledgerA();
  denied.cancelMode = "forbidden";
  const third = await open(browser, origin, scheme, denied, `/c/${CH}`);
  await serverMoves(third.page, denied, denied.runs, "stage");
  await third.page.getByTestId("composer-working-open").first().waitFor({ timeout: 15_000 });
  await openPanelFor(third.page, "그록봇");
  await third.page.getByTestId("agent-work-panel-stop-arm").click();
  await third.page.getByTestId("agent-work-panel-stop-commit").click();
  await third.page.getByTestId("agent-work-panel-stop-outcome").waitFor();
  const deniedText = ((await third.page.getByTestId("agent-work-panel-stop-outcome").textContent()) ?? "").trim();
  check(`${tag} 403은 누가 멈출 수 있는지 말한다`, deniedText === "중단하지 못했어요. 이 실행이 있는 채널의 멤버만 중단할 수 있어요.", deniedText);
  await third.page.screenshot({ path: shot("5-stop-forbidden") });
  await third.context.close();
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
  await openPanelViaRail(second.page);
  const local = ((await second.page.getByTestId("agent-work-panel-limit").textContent()) ?? "").trim();
  check(`${tag} local: 서버가 모르는 run은 「이 화면에만 있어요」`, local === "이 기록은 이 화면에만 있어요. 패널을 닫으면 사라져요.", local);
  check(`${tag} local: 서버 원장 영역이 없다`, (await second.page.getByTestId("agent-work-panel-ledger").count()) === 0 && (await second.page.getByTestId("agent-work-panel-runs").count()) === 0);
  await second.page.screenshot({ path: shot("4-local-only") });
  await second.context.close();
}

async function u3(browser, origin, scheme) {
  const tag = `1440-${scheme}`;
  const shot = (name) => resolve(OUT_DIR, `${name}-${tag}.png`);
  const now = Date.now();
  const A = {
    grok: agentId,
    kim: otherAgentId,
    dots: "00000000-0000-7000-8000-000000000303",
    plan: "00000000-0000-7000-8000-000000000304",
    desk: "00000000-0000-7000-8000-000000000305",
  };
  const agents = [
    person(A.grok, "agent", "그록봇", "grokbot", { ownerHumanId: memberId }),
    person(A.kim, "agent", "김인턴", "kim-intern", { ownerHumanId: memberId }),
    person(A.dots, "agent", "닷츠", "dots", { ownerHumanId: memberId }),
    person(A.plan, "agent", "플래너", "planner", { ownerHumanId: memberId }),
    person(A.desk, "agent", "데스크", "desk", { ownerHumanId: memberId }),
  ];
  const build = (role) => {
    const scene = newScene();
    scene.role = role;
    scene.roster = [person(memberId, "human", "곽성재", "seongjae", { role }), ...agents];
    scene.liveness = {
      [A.kim]: { state: "responsive", lastSignalAtMs: now - 3 * MIN },
      [A.dots]: { state: "alive_idle", lastSignalAtMs: now - 2 * MIN },
      [A.desk]: { state: "work_waiting", lastSignalAtMs: now - 25 * MIN },
      [A.grok]: { state: "woken_not_collected", lastSignalAtMs: now - 40 * MIN },
      [A.plan]: { state: "unresponsive", lastSignalAtMs: now - 12 * MIN },
    };
    scene.dmChannels = agents.map((a, i) => ({ id: `00000000-0000-7000-8000-00000000062${i}`, workspaceId, kind: "dm", muted: false, memberIds: [memberId, a.id] }));
    return scene;
  };

  // ① 멤버 목록: 다섯 라벨. (「연결됨」이 아니라 「지금 살아 있는가」)
  const admin = build("owner");
  const { context, page } = await open(browser, origin, scheme, admin, "/directory");
  await page.getByTestId("directory-row").first().waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="agent-liveness"]').length >= 5, null, { timeout: 15_000 });
  const rowLabel = async (agent) => ((await page.locator(`[data-testid="directory-row"][data-member-id="${agent}"] [data-testid="agent-liveness"]`).first().textContent()) ?? "").replace(/\s+/g, " ").trim();
  check(`${tag} members: 응답함 n분 전`, (await rowLabel(A.kim)).startsWith("응답함 3분 전"), await rowLabel(A.kim));
  check(`${tag} members: 살아 있음 · 대기 중`, (await rowLabel(A.dots)).startsWith("살아 있음 · 대기 중"), await rowLabel(A.dots));
  check(`${tag} members: 일이 기다리는 중`, (await rowLabel(A.desk)).startsWith("일이 기다리는 중"), await rowLabel(A.desk));
  check(`${tag} members: 깨웠지만 아직 안 가져감`, (await rowLabel(A.grok)).startsWith("깨웠지만 아직 안 가져감"), await rowLabel(A.grok));
  check(`${tag} members: 응답 없음 n분`, (await rowLabel(A.plan)).startsWith("응답 없음 12분"), await rowLabel(A.plan));
  const humanLabels = await page.locator(`[data-testid="directory-row"][data-member-kind="human"] [data-testid="agent-liveness"]`).count();
  check(`${tag} members: 사람 행에는 라벨이 없다`, humanLabels === 0);
  check(`${tag} members: 「연결됨」을 말하지 않는다`, !((await page.getByTestId("directory-row").allTextContents()).join(" ").includes("연결됨")));
  await page.screenshot({ path: shot("1-members") });

  // ② 에이전트 헤더 + 다시 깨우기(owner)
  await page.evaluate((id) => { location.hash = `/agents?agent=${id}`; }, A.grok);
  await page.getByTestId("agent-liveness-bar").waitFor({ timeout: 15_000 });
  await page.getByTestId("wake-agent-button").waitFor({ timeout: 15_000 });
  const headerLabel = ((await page.getByTestId("agent-liveness-bar").getByTestId("agent-liveness").textContent()) ?? "");
  check(`${tag} header: 깨웠지만 아직 안 가져감 + 다시 깨우기`, headerLabel.includes("깨웠지만 아직 안 가져감") && (await page.getByTestId("wake-agent-button").isEnabled()), headerLabel);
  await page.screenshot({ path: shot("2-header-wake") });
  const tabY = () => page.getByTestId("agent-hub-tab-profile").evaluate((el) => Math.round(el.getBoundingClientRect().top));
  const tabBefore = await tabY();
  await page.getByTestId("wake-agent-button").click();
  await page.waitForFunction(() => /뒤에 다시 깨울 수 있어요/.test(document.querySelector('[data-testid="wake-agent-cooldown"]')?.textContent ?? ""), null, { timeout: 5_000 });
  check(`${tag} wake: 쿨다운 문구가 나타나도 머리 높이가 변하지 않는다`, (await tabY()) === tabBefore, `${tabBefore} -> ${await tabY()}`);
  check(`${tag} wake: 눌렀더니 접수되고(1회) 버튼이 잠긴다`, admin.ringCalls === 1 && (await page.getByTestId("wake-agent-button").isDisabled()));
  const cool = ((await page.getByTestId("wake-agent-cooldown").textContent()) ?? "").trim();
  check(`${tag} wake: 쿨다운 표시`, /^깨웠어요 · (\d+초|1분) 뒤에 다시 깨울 수 있어요$/.test(cool), cool);
  const announced = ((await page.getByTestId("wake-agent-status").textContent()) ?? "").trim();
  check(`${tag} wake: 낭독 영역에는 접수 문장뿐이고 초 단위 숫자가 없다`, announced.includes("깨우는 신호를 보냈어요") && !/\d+\s*(초|분)/.test(announced), announced);
  await page.screenshot({ path: shot("3-wake-cooldown") });

  const listLabels = await page.locator('[data-testid="agent-liveness"]').evaluateAll((els) => els.length);
  check(`${tag} hub: 목록 행에도 「활성」 곁에 라벨이 있다`, listLabels >= 6, String(listLabels));
  // ③ 작업 패널 머리
  // 25분 기다린 요청: 5분 유예를 넘었으니 입력창 레일에서는 빠지고 그 메시지 아래 예외 줄이 선다(#4619). 그 줄의 글이 작업 패널의 입구다.
  admin.runs = [progress(now, { id: RUN_A, agentMemberId: A.desk, phase: "queued", status: "queued", queuePosition: 1, createdAtMs: now - 25 * MIN, triggerSummary: "일정 정리", triggerMessageId: "00000000-0000-7000-8000-0000000a0001" })];
  await serverMoves(page, admin, admin.runs, "queued");
  // desk 에이전트의 DM이 아니라 #계획 채널의 run이므로 계획 채널로 간다.
  await page.evaluate((id) => { location.hash = `/c/${id}`; }, CH);
  await page.getByTestId("run-exception-open").first().waitFor({ timeout: 15_000 });
  await page.getByTestId("run-exception-open").first().click();
  await page.getByTestId("agent-work-panel").waitFor();
  await page.getByTestId("agent-work-panel").getByTestId("agent-liveness").waitFor({ timeout: 10_000 });
  const panelLabel = ((await page.getByTestId("agent-work-panel").getByTestId("agent-liveness").textContent()) ?? "");
  check(`${tag} panel: 머리에 「일이 기다리는 중」`, panelLabel.includes("일이 기다리는 중"), panelLabel);
  check(`${tag} panel: 머리에도 다시 깨우기`, (await page.getByTestId("agent-work-panel").getByTestId("wake-agent-button").count()) === 1);
  await page.screenshot({ path: shot("5-panel") });
  // ④ 사이드바 DM 행: 한두 낱말
  await page.evaluate((id) => { location.hash = `/c/${id}`; }, admin.dmChannels[0].id);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="channel-item"] [data-testid="agent-liveness"]').length >= 5, null, { timeout: 15_000 });
  const rowWords = await page.locator('[data-testid="channel-item"] [data-testid="agent-liveness"] .truncate').allTextContents();
  check(`${tag} sidebar: DM 행마다 한두 낱말`, ["응답함", "살아 있음", "일이 밀림", "안 가져감", "응답 없음"].every((w) => rowWords.includes(w)), rowWords.join(","));
  const widest = await page.locator('[data-testid="channel-item"] [data-testid="agent-liveness"]').evaluateAll((els) => Math.max(...els.map((el) => el.getBoundingClientRect().width)));
  check(`${tag} sidebar: 행 안에서 넘치지 않는다`, widest <= 110, String(widest));
  const dmHeader = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="agent-liveness"]')]
      .filter((el) => !el.closest('[data-testid="sidebar"]') && !el.closest('[data-testid="agent-work-panel"]'))
      .map((el) => el.textContent ?? "").join("|")
  );
  check(`${tag} dm-header: 채널 머리에도 라벨`, dmHeader.includes("깨웠지만 아직 안 가져감"), dmHeader);
  await page.screenshot({ path: shot("4-sidebar-dm") });

  await context.close();

  // ⑤ 일반 멤버: 라벨만, 버튼은 없다
  const member = build("member");
  const second = await open(browser, origin, scheme, member, `/agents?agent=${A.grok}`);
  await second.page.getByTestId("agent-liveness-bar").waitFor({ timeout: 15_000 });
  await second.page.waitForTimeout(800);
  const memberLabel = ((await second.page.getByTestId("agent-liveness-bar").getByTestId("agent-liveness").textContent()) ?? "");
  check(`${tag} member: 라벨은 보인다`, memberLabel.includes("깨웠지만 아직 안 가져감"), memberLabel);
  check(`${tag} member: 할 일이 없는 멤버에게는 경고색이 아니다`, (await second.page.getByTestId("agent-liveness-bar").getByTestId("agent-liveness").getAttribute("data-tone")) === "neutral");
  check(`${tag} member: 다시 깨우기는 없다 (연결 목록이 403이다)`, (await second.page.getByTestId("wake-agent-button").count()) === 0);
  await second.page.screenshot({ path: shot("6-member-no-wake") });
  await second.context.close();

  // ⑥ 429: 시간당 한도 — 오류 문구가 아니라 서버가 준 쿨다운
  const limited = build("admin");
  limited.ringMode = "limited";
  const third = await open(browser, origin, scheme, limited, `/agents?agent=${A.grok}`);
  await third.page.getByTestId("wake-agent-button").waitFor({ timeout: 15_000 });
  await third.page.getByTestId("wake-agent-button").click();
  await third.page.waitForFunction(() => /45분 뒤에 다시 깨울 수 있어요/.test(document.querySelector('[data-testid="wake-agent-cooldown"]')?.textContent ?? ""), null, { timeout: 5_000 });
  const limitedNote = ((await third.page.getByTestId("wake-agent-cooldown").textContent()) ?? "").trim();
  check(`${tag} limited: 눈이 읽는 한 줄이 이유와 쿨다운을 함께 말한다`, limitedNote === "시간당 깨우기 한도에 닿았어요 · 45분 뒤에 다시 깨울 수 있어요", limitedNote);
  const limitedStatus = ((await third.page.getByTestId("wake-agent-status").textContent()) ?? "").trim();
  check(`${tag} limited: 429는 오류가 아니라 「시간당 깨우기 한도에 닿았어요」와 서버가 준 쿨다운`, limitedStatus === "시간당 깨우기 한도에 닿았어요." && !limitedStatus.includes("못했어요"), limitedStatus);
  await third.page.screenshot({ path: shot("7-wake-limited") });
  await third.context.close();
}

// ---- d1 (#3824 → #4619): 보낸 메시지의 상태 · 걸린 시간 · 깨우는 신호 --------------------
//
// #3824의 메시지 아래 상태 줄(받았어요 → 깨우는 신호 보냄 → 가져감 → 작업 중 → 결과)은 없어졌다(#4619, owner 「ㄱㄱ」).
// 같은 사실이 이제 머리 칩(받음 → 가져감 → 작업 중 → 답함), 입력창 레일, 예외 줄(깨우는 신호가 닿지 않음 · 아직 받지
// 않았어요 · 실패 · 시간 초과)로 나뉘어 말해진다. 작업 패널의 원장·걸린 시간은 그대로다.

const MSG_SENT = "00000000-0000-7000-8000-0000000a0009";

async function d1(browser, origin, scheme) {
  const tag = `1440-${scheme}`;
  const shot = (name) => resolve(OUT_DIR, `d1-${name}-${tag}.png`);
  const scene = newScene();
  const now = Date.now();
  // 방금 보낸 메시지 하나(내가 썼다).
  scene.messageRows = [
    {
      id: MSG_SENT, channelId: CH, seq: 12, hlcTs: now - 4_000, hlcCount: 0,
      authorMemberId: memberId, type: "text",
      body: "@grokbot 채널 하나 만들어 줄래요? 이름은 grokbot-lab으로요.", state: "sent", createdAtMs: now - 4_000,
    },
  ];
  const base = { id: RUN_A, triggerMessageId: MSG_SENT, triggerSummary: "채널 하나 만들어 줄래요?", createdAtMs: now - 3_000, updatedAtMs: now - 3_000 };
  scene.ledgers[RUN_A] = [{ ordinal: 1, kind: "queued", createdAtMs: now - 3_000 }];
  scene.liveness = { [agentId]: { state: "woken_not_collected", lastSignalAtMs: now - 40 * MIN } };
  scene.runs = [progress(now, { ...base, queuePosition: 1, aheadTotal: 0 })];
  const { context, page } = await open(browser, origin, scheme, scene, `/c/${CH}`);
  const chipWord = async () => ((await page.getByTestId("trigger-chip-word").first().textContent()) ?? "").trim();
  const bodyText = async () => (await page.locator("body").textContent()) ?? "";

  // ① 받음: 진행 읽기에 run이 서면 곧바로. 문장 행은 없고, 평소의 진행에는 예외 줄도 없다.
  await page.getByTestId("trigger-chip-word").first().waitFor({ timeout: 15_000 });
  check(`${tag} received: 머리 칩 「받음」`, (await chipWord()) === "받음", await chipWord());
  check(`${tag} received: 문장 행(「받았어요 → …」)이 없다`, (await page.getByTestId("message-run-status-row").count()) === 0 && !(await bodyText()).includes("받았어요 →"));
  check(`${tag} received: 예외 줄이 없다`, (await page.getByTestId("run-exception").count()) === 0);
  check(`${tag} received: 대화에 초 단위 숫자가 없다(「n초째 기다려요」)`, !/\d+초째/.test(await bodyText()));
  await page.screenshot({ path: shot("1-received") });

  // ② 깨우는 신호가 닿았다: 원장에 doorbell_rung 행, 프레임 하나. 화면은 조용하다(칩은 그대로 「받음」, 예외 줄 없음).
  //    원장은 `?include=doorbell`로 읽는다.
  scene.ledgers[RUN_A] = [
    { ordinal: 1, kind: "queued", createdAtMs: now - 3_000 },
    { ordinal: 2, kind: "doorbell_rung", code: "leading_ok", createdAtMs: now - 2_500 },
  ];
  const ledgerBefore = scene.ledgerCalls;
  await serverMoves(page, scene, scene.runs, "doorbell_rung");
  await page.waitForTimeout(500);
  check(`${tag} woken: 원장을 다시 읽었고 ?include=doorbell로 물었다`, scene.ledgerCalls > ledgerBefore && scene.ledgerIncludes.every((v) => v === "doorbell"), JSON.stringify(scene.ledgerIncludes));
  check(`${tag} woken: 신호가 닿았으면 줄이 서지 않는다(칩은 그대로)`, (await page.getByTestId("run-exception").count()) === 0 && (await chipWord()) === "받음");
  await page.screenshot({ path: shot("2-woken") });

  // ③ 깨우는 신호가 닿지 않았다(#4619 planner 결정 5): 유예를 기다리지 않고 예외 줄이 서고 「다시 깨우기」(owner)가 곁에 선다.
  scene.ledgers[RUN_A] = [
    { ordinal: 1, kind: "queued", createdAtMs: now - 3_000 },
    { ordinal: 2, kind: "doorbell_rung", code: "leading_failed", createdAtMs: now - 2_500 },
  ];
  await serverMoves(page, scene, scene.runs, "doorbell_rung");
  await page.getByTestId("run-exception").waitFor({ timeout: 5_000 });
  const failedLine = ((await page.getByTestId("run-exception-text").textContent()) ?? "").trim();
  check(`${tag} wake-failed: 예외 줄 「깨우는 신호가 닿지 않음」(폰과 같은 낱말)`, failedLine.startsWith("그록봇: 깨우는 신호가 닿지 않음"), failedLine);
  check(`${tag} wake-failed: 칩은 아직 진행 낱말(「받음」)이다`, (await chipWord()) === "받음");
  await page.getByTestId("run-exception").getByTestId("wake-agent-button").waitFor({ timeout: 10_000 });
  check(`${tag} wake-failed: 「다시 깨우기」와 「취소」가 줄 안에 선다`, (await page.getByTestId("run-exception").getByTestId("wake-agent-button").count()) === 1 && (await page.getByTestId("run-exception").getByTestId("agent-work-panel-stop-arm").count()) === 1);
  await page.screenshot({ path: shot("3-wake-failed") });

  // ④ 가져감 → 작업 중. 줄은 걷히고 칩 「작업 중」과 레일(「그록봇 · 작업 중 · 단계」)이 말한다. 걸린 시간은 패널에 있다.
  scene.ledgers[RUN_A] = [
    { ordinal: 1, kind: "queued", createdAtMs: now - 12 * MIN - 20_000 },
    { ordinal: 2, kind: "doorbell_rung", code: "leading_ok", createdAtMs: now - 12 * MIN - 19_000 },
    { ordinal: 3, kind: "doorbell_rung", code: "trailing_ok", createdAtMs: now - 12 * MIN - 14_000 },
    { ordinal: 4, kind: "tool_call", code: "ok", createdAtMs: now - 12 * MIN - 13_000 },
    { ordinal: 5, kind: "claimed", createdAtMs: now - 12 * MIN - 8_000 },
    { ordinal: 6, kind: "started", createdAtMs: now - 12 * MIN },
    { ordinal: 7, kind: "stage", stage: "grokbot-lab 이름 점검", createdAtMs: now - MIN },
  ];
  await serverMoves(page, scene, [
    progress(now, { ...base, createdAtMs: now - 12 * MIN - 20_000, phase: "running", status: "running", leaseState: "live", claimedAtMs: now - 12 * MIN - 8_000, startedAtMs: now - 12 * MIN, lastEventAtMs: now - MIN - 5_000, latestStage: "grokbot-lab 이름 점검", stepCount: 1 }),
  ], "stage");
  await page.waitForFunction(() => document.querySelector('[data-testid="run-exception"]') === null, null, { timeout: 5_000 }).catch(() => {});
  check(`${tag} working: 줄이 걷히고 칩이 「작업 중」`, (await page.getByTestId("run-exception").count()) === 0 && (await chipWord()) === "작업 중");
  const activity = ((await page.getByTestId("composer-working").textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
  check(`${tag} working: 레일 「그록봇 · 작업 중 · 단계」, 경과·영어 시계가 없다`, activity.includes("그록봇 · 작업 중 · grokbot-lab 이름 점검") && !/\d+m \d+s|\d+분째|\d+초/.test(activity), activity);
  await page.screenshot({ path: shot("3-working") });

  // ⑤ 레일 → 팝오버 → 작업 패널: 걸린 시간 줄 · 접힌 깨우는 신호 · 모르는 종류. 경과는 팝오버와 패널에서만 말한다.
  await page.getByTestId("composer-working-open").first().click();
  await page.getByTestId("composer-working-popover").waitFor();
  const popover = ((await page.getByTestId("composer-working-popover").textContent()) ?? "");
  check(`${tag} popover: 경과가 1분 단위로(「12분째」)`, popover.includes("12분째"), popover);
  await page.getByTestId("composer-working-agent").first().click();
  await page.getByTestId("agent-work-panel").waitFor();
  await page.getByTestId("agent-work-panel-ledger").waitFor({ timeout: 5_000 });
  const durations = ((await page.getByTestId("agent-work-panel-durations").textContent()) ?? "").trim();
  check(`${tag} panel: 걸린 시간 「대기 12초 → 작업 12분째」`, durations === "대기 12초 → 작업 12분째", durations);
  const ledgerText = ((await page.getByTestId("agent-work-panel-ledger").textContent()) ?? "");
  check(`${tag} panel: 깨우는 신호가 접혀 「· 2번」`, ledgerText.includes("깨우는 신호를 보냈어요 · 2번"), ledgerText);
  check(`${tag} panel: 모르는 종류가 와도 기록이 선다`, ledgerText.includes("이 앱이 아직 모르는 기록이에요") && ledgerText.includes("grokbot-lab 이름 점검"), ledgerText);
  await page.screenshot({ path: shot("4-panel-ledger") });

  // ⑥ 결과: 답함 · 3분 12초 걸림(패널). 이 run의 답 메시지를 모르면 칩은 눌리지 않는다.
  scene.ledgers[RUN_A] = [
    ...scene.ledgers[RUN_A],
    { ordinal: 8, kind: "succeeded", createdAtMs: now - 12 * MIN - 20_000 + 192_000 },
  ];
  await serverMoves(page, scene, [
    progress(now, { ...base, createdAtMs: now - 12 * MIN - 20_000, phase: "succeeded", status: "succeeded", leaseState: "none", claimedAtMs: now - 12 * MIN - 8_000, startedAtMs: now - 12 * MIN, finishedAtMs: now - 12 * MIN - 20_000 + 192_000 }),
  ], "succeeded");
  await page.waitForFunction(() => /답함/.test(document.querySelector('[data-testid="trigger-chip-word"]')?.textContent ?? ""), null, { timeout: 3_000 }).catch(() => {});
  check(`${tag} done: 머리 칩 「답함」`, (await chipWord()) === "답함", await chipWord());
  check(`${tag} done: 답을 모르면 칩은 눌리지 않는다(죽은 단추 없음)`, (await page.getByTestId("trigger-chip").first().evaluate((el) => el.tagName)) === "SPAN");
  const doneDurations = ((await page.getByTestId("agent-work-panel-durations").textContent()) ?? "").trim();
  check(`${tag} done: 「대기 12초 → 작업 2분 52초 → 총 3분 12초」`, doneDurations === "대기 12초 → 작업 2분 52초 → 총 3분 12초", doneDurations);
  await page.screenshot({ path: shot("5-done") });
  await context.close();

  // ⑦ 옛 서버(진행 읽기 없음): 칩도 줄도 없고 예전 화면 그대로.
  const legacy = newScene();
  legacy.legacyServer = true;
  legacy.messageRows = scene.messageRows;
  const old = await open(browser, origin, scheme, legacy, `/c/${CH}`);
  await old.page.getByText("grokbot-lab으로요").first().waitFor({ timeout: 15_000 });
  await old.page.waitForTimeout(800);
  check(`${tag} legacy: 진행 읽기가 없는 서버에서는 칩도 예외 줄도 없다`, (await old.page.getByTestId("trigger-chip").count()) === 0 && (await old.page.getByTestId("run-exception").count()) === 0);
  await old.page.screenshot({ path: shot("6-legacy-server") });
  await old.context.close();
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
      if (SLICE === "u3") await u3(browser, preview.origin, scheme);
      if (SLICE === "stop") await stop(browser, preview.origin, scheme);
      if (SLICE === "d1") await d1(browser, preview.origin, scheme);
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
