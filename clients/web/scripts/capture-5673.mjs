#!/usr/bin/env node
// =============================================================================
// 「작업」 → 세션 상세 → 뒤로: 한 화면 안의 이동으로 읽히는가 (#5673, ADR-0202 D6).
//
//   npm run build && OUT_DIR=<dir> CAPTURE_PORT=<port> node scripts/capture-5673.mjs
//
// 백엔드가 없다(고정 응답은 capture-5640의 것을 그대로 쓴다). 사람·컴퓨터 이름은 가상 인물이다. 재는 것:
//   - 세션 상세 머리: 「← 작업」과 세션 이름, 제목에 「작업 콘솔」 0줄, 목록 이름 「진행 중인 세션」
//   - 「작업」 목록을 굴린 뒤 세션 줄을 열고 「← 작업」(그리고 브라우저 뒤로)으로 돌아오면 열었던 줄에 초점, 스크롤 위치 유지
//   - 1280·900·390 × 밝게·어둡게 캡처
// **라이브 서버·데스크탑 앱·실기기 왕복은 runtime-unverified**다.
// =============================================================================
//     네 모서리와 컨트롤 층(승인·거부 옆)을 재고, 거부 알약을 가리키면 띠가 꺼져 알약이 남는지, 상태 칩이 「응답 필요」 하나인지
// =============================================================================
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(homedir(), ".cache/momo-scratch/5673/captures");
const PORT = Number(process.env.CAPTURE_PORT || 26905);

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const otherId = "00000000-0000-7000-8000-000000000102";
const agentId = "00000000-0000-7000-8000-000000000301";
const hostId = "00000000-0000-7000-8000-000000000401";
const channels = [
  { id: "00000000-0000-7000-8000-000000000201", workspaceId, kind: "public", name: "workbench", muted: false },
  { id: "00000000-0000-7000-8000-000000000202", workspaceId, kind: "public", name: "agent-lab", muted: false },
];
const [bench, lab] = channels;
const me = { memberId, displayName: "김도현" };
const seoyeon = { memberId: otherId, displayName: "이서연" };
const grok = { memberId: agentId, displayName: "그록봇" };
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: me.displayName, handle: "dohyun" },
  realtimeWebSocketUrl: "ws://work-5640-capture.invalid/connection/websocket",
};
const roster = [
  { id: agentId, workspaceId, kind: "agent", status: "active", displayName: grok.displayName, handle: "grok-bot", channelCount: 2, channelIds: channels.map((c) => c.id), capabilities: [], ownerHumanId: memberId, createdAtMs: 0, updatedAtMs: 0 },
  { id: memberId, workspaceId, kind: "human", status: "active", role: "owner", displayName: me.displayName, handle: "dohyun", channelCount: 2, channelIds: channels.map((c) => c.id), capabilities: [], createdAtMs: 0, updatedAtMs: 0 },
  { id: otherId, workspaceId, kind: "human", status: "active", role: "member", displayName: seoyeon.displayName, handle: "seoyeon", channelCount: 2, channelIds: channels.map((c) => c.id), capabilities: [], createdAtMs: 0, updatedAtMs: 0 },
];

const NOW = Date.now();
const sec = Math.floor(NOW / 1000);
const none = { added: null, deleted: null, files: null, ahead: null, behind: null, uncommitted: null };
const id = (n) => `00000000-0000-7000-8000-0000000009${String(n).padStart(2, "0")}`;
const macBase = { source: "session", origin: "host", folderLabel: null, owner: me, homeChannel: { id: lab.id, name: "agent-lab" }, sharedAtMs: NOW - 30 * 60_000, repo: "oort", branch: null, diff: none, stages: [], prUrl: null, status: "running", state: "running", endedAtMs: null };
const runBase = { source: "run", requestedBy: me, origin: "agent_run", folderLabel: null, owner: grok, homeChannel: { id: lab.id, name: "agent-lab" }, sharedAtMs: null, repo: null, harness: "hosted", diff: none, stages: [], branch: null, prUrl: null, endedAtMs: null };

// 내 맥 세션 셋: 하나는 권한 요청을 기다리고(서버가 `waiting`), 하나는 조용하고, 하나는 실측 장면에서 요청이 생긴다.
const macWaiting = { ...macBase, sessionId: id(1), label: "결제 웹훅 재시도 고치기", harness: "claude", startedAtMs: NOW - 18 * 60_000, lastActivityAt: sec - 40 };
const macQuiet = { ...macBase, sessionId: id(2), label: "릴리스 노트 초안 쓰기", harness: "codex", startedAtMs: NOW - 9 * 60_000, lastActivityAt: sec - 120 };
const runApproval = { ...runBase, runId: id(3), label: "#launch 채널에 v0.1.46 공지 올리기", status: "running", state: "running", phase: "awaiting_approval", trigger: "mention", startedAtMs: NOW - 4 * 60_000, stepCount: 1, lastActivityAt: sec - 60 };
// 결정이 내 몫이 아닌 승인 대기 run(원장의 내 결정 목록에 없다): 「지금」 맨 위, 단추 없이 대기 줄과 카드 링크.
const runNonDecider = { ...runBase, runId: id(6), label: "#general 공지 고정하기", status: "running", state: "running", phase: "awaiting_approval", trigger: "work", startedAtMs: NOW - 7 * 60_000, stepCount: 1, lastActivityAt: sec - 70 };
const runWorking = { ...runBase, runId: id(4), label: "온보딩 문구 해요체로 다듬기", status: "running", state: "running", phase: "running", trigger: "work", startedAtMs: NOW - 12 * 60_000, stepCount: 2, stages: ["코드 읽기", "문구 고치기"], branch: "feat/onboarding-copy", lastActivityAt: sec - 90 };
const doneRows = Array.from({ length: 12 }, (_, i) => ({
  ...runBase,
  runId: id(10 + i),
  label: [`푸시 알림이 두 번 오는 문제 고치기`, `의존성 라이선스 점검`, `검색 색인 다시 만들기`, `설정 화면 문구 정리`][i % 4] + ` ${i + 1}`,
  status: "done",
  state: "done",
  phase: "succeeded",
  trigger: "work",
  startedAtMs: NOW - (40 + i * 10) * 60_000,
  endedAtMs: NOW - (30 + i * 10) * 60_000,
  stepCount: 3,
  lastActivityAt: sec - (1800 + i * 600),
  ...(i === 0
    ? { prUrl: "https://github.com/example/oort/pull/3521", pr: { url: "https://github.com/example/oort/pull/3521", number: 3521 }, agentReported: { resultKind: "pr_opened", tests: { passed: 128, failed: 0, notRun: 3 }, nextAction: "merge_ok", commitSha: "9f3c2a1b7e", toolCounts: { run: 14, edit: 6, read: 41 } } }
    : {}),
}));
// 남(이서연)의 로컬 공유 터미널: 그 기기의 입력 대기라 누구에게나 `waiting`이다. 「팀 전체」에만 보인다.
const othersTerminal = { source: "session", sessionId: id(5), origin: "local_pty", label: "검색 색인 다시 만들기", folderLabel: "oort", status: "running", owner: seoyeon, homeChannel: { id: bench.id, name: "workbench" }, startedAtMs: NOW - 47 * 60_000, endedAtMs: null, sharedAtMs: NOW - 40 * 60_000, repo: "oort", branch: "fix/index", harness: "claude", state: "waiting", stages: [], diff: { ...none, added: 12, deleted: 3, files: 2 }, prUrl: null, lastActivityAt: sec - 200 };

// 수리 3회차 장면용 두 번째 결정자 줄(`state.twoDeciders`일 때만): 「응답 필요」에 승인·거부가 선 줄이 둘.
const runApproval2 = { ...runBase, runId: id(7), label: "결제 재시도 정책 문서를 #billing-ops에 올리기", status: "running", state: "running", phase: "awaiting_approval", trigger: "mention", startedAtMs: NOW - 5 * 60_000, stepCount: 1, lastActivityAt: sec - 65 };

// 인박스 배지가 읽는 승인 원장: run 하나에 내 결정을 기다리는 승인(두 번째 결정자 장면이면 둘).
const approvals = [
  { id: id(50), workspaceId, runId: runApproval.runId, channelId: lab.id, requestedBy: agentId, actionType: "tool_call", toolName: "message.send", status: "pending", expiresAtMs: NOW + 30 * 60_000 },
];
const approval2 = { id: id(51), workspaceId, runId: runApproval2.runId, channelId: lab.id, requestedBy: agentId, actionType: "tool_call", toolName: "message.send", status: "pending", expiresAtMs: NOW + 30 * 60_000 };
// 수리 5회차 장면용 세 번째 결정자 줄(`state.threeDeciders`)과 같은 run(A)의 다음 승인(`state.reaskSameRun`, 검수 3회차 E6).
const runApproval3 = { ...runBase, runId: id(8), label: "주간 보고서를 #reports에 올리기", status: "running", state: "running", phase: "awaiting_approval", trigger: "mention", startedAtMs: NOW - 6 * 60_000, stepCount: 1, lastActivityAt: sec - 66 };
const approval3 = { ...approval2, id: id(53), runId: runApproval3.runId };
const reaskA = { ...approvals[0], id: id(52) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const host = { id: hostId, workspaceId, scope: "member", ownerMemberId: memberId, type: "app", displayName: "도현 맥북", capabilities: { terminal: true }, lastSeenAtMs: NOW, createdAtMs: NOW - 86_400_000, online: true };
const ledgerSession = (row) => ({ id: row.sessionId, workspaceId, channelId: lab.id, memberId, hostId, rootMessageId: row.sessionId.replace(/9(\d\d)$/, "8$1"), tool: row.harness, label: row.label, status: "running", observation: "open", observerGrantCount: 0, remoteAttachAvailable: false, remoteDisplayAvailable: false, startedAtMs: row.startedAtMs });

const failures = [];
function check(name, ok, detail) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
  if (!ok) failures.push(name);
}
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** 서버 흉내(#5639): 주인이 `include=jobs`로 읽을 때만 대기 요청이 있는 실행 중 맥 세션이 `waiting`. */
function boardView(state) {
  // 결정이 닿은 run은 실제 서버처럼(수리 4회차, 검수 2회차 `realRun`): 거부하면 바로 끝나고(`reject_run` → 보드 `stopped`), 승인하면
  // 줄을 선다(`queued`). `finishOnApprove`면 승인한 run이 곧바로 끝난다.
  const decided = (row) => {
    const approve = state.decidedRuns.get(row.runId);
    if (approve === false) return { ...row, status: "cancelled", state: "stopped", phase: "cancelled", endedAtMs: Date.now() };
    if (state.finishOnApprove) return { ...row, status: "done", state: "done", phase: "succeeded", endedAtMs: Date.now() };
    // 같은 run의 다음 승인을 기다리는 장면: run은 다시 승인 대기다.
    if (state.reaskSameRun && row.runId === runApproval.runId) return { ...row, phase: "awaiting_approval" };
    // 실제 서버: 승인한 run은 줄을 서고(`queued`) 보드 상태는 `waiting`이다(클라이언트는 실행 줄의 `waiting`을 `idle` → 칩 「시작 전」으로 읽는다).
    return { ...row, status: "queued", state: "waiting", phase: "queued" };
  };
  const view = (row) =>
    row.origin === "host" && row.owner.memberId === memberId && state.waiting.has(row.sessionId)
      ? { ...row, state: "waiting" }
      : row.runId && state.decidedRuns.has(row.runId)
        ? decided(row)
        : row;
  const second = [...(state.twoDeciders ? [runApproval2] : []), ...(state.threeDeciders ? [runApproval3] : [])];
  // 실제 서버 순서(`ORDER BY activity_us DESC`, 수리 5회차 검수 3회차): 결정이 닿은 run은 `updated_at`이 올라 목록 맨 앞으로 온다.
  const bump = (rows) => [...state.decidedRunOrder.map((rid) => rows.find((r) => r.runId === rid)).filter(Boolean), ...rows.filter((r) => !(r.runId && state.decidedRuns.has(r.runId)))];
  const mine = bump([macWaiting, runApproval, ...second, runNonDecider, macQuiet, runWorking, ...doneRows]).map(view);
  const team = bump([macWaiting, runApproval, ...second, runNonDecider, othersTerminal, macQuiet, runWorking, ...doneRows]).map(view);
  return { mine, team };
}

/** 서버가 쓴 카드 문장과 `canDecide`(run 진행). 늦은 거절 장면(`state.progress`)에서만 답한다. */
function progressRows(state) {
  const row = (run, approvalId, intent, canDecide) => ({ id: run.runId, channelId: lab.id, agentMemberId: agentId, status: "running", phase: "awaiting_approval", leaseState: "live", stepCount: 1, ahead: [], createdAtMs: NOW - 300_000, updatedAtMs: NOW - 60_000, bundle: { approvalId, status: "pending", decisionMode: "inline", canDecide, actionType: "tool_call", intent } });
  return [
    row(runApproval, id(50), "#launch 채널에 v0.1.46 공지를 올려도 될까요?", state.progress.aCanDecide !== false),
    // B는 문장 없이(원장 행의 문장 그대로): 거절이 닿을 때 B의 줄 높이가 바뀌지 않아 B가 A의 자리로 그대로 올라온다.
    row(runApproval2, id(51), undefined, true),
  ];
}

async function installRoutes(context, state) {
  await context.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId });
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/decision")) {
      state.decisions += 1;
      const approvalId = path.split("/").at(-2);
      state.decidedOrder.push(approvalId);
      if (state.decision === "hold") return; // 답을 붙잡아 「보내는 중」을 잰다(컨텍스트를 닫으면 끝난다).
      if (state.decision === "fail") return json(route, {}, 500);
      // 서버 왕복(수리 3회차): 결정은 바로 기록되고 답은 `decisionDelayMs` 뒤에 온다.
      state.decidedIds.add(approvalId);
      let approve = true;
      try {
        approve = JSON.parse(route.request().postData() ?? "{}").approve !== false;
      } catch {
        approve = true; // 본문이 없으면 승인으로 본다(이 하네스의 모든 결정은 본문을 싣는다)
      }
      state.decidedHow.push(approve);
      const decidedRun = [...approvals, approval2, approval3, reaskA].find((a) => a.id === approvalId)?.runId;
      if (decidedRun) {
        state.decidedRuns.set(decidedRun, approve);
        state.decidedRunOrder = [decidedRun, ...state.decidedRunOrder.filter((rid) => rid !== decidedRun)];
      }
      if (state.decisionDelayMs) await sleep(state.decisionDelayMs);
      return json(route, { status: approve ? "approved" : "rejected", decided_by: memberId, decided_at_ms: Date.now() });
    }
    if (path.endsWith("/approvals")) {
      state.ledgerReads += 1;
      if (state.ledgerDelayMs && state.ledgerReads === 1) await sleep(state.ledgerDelayMs);
      if (state.roundTripMs) await sleep(state.roundTripMs);
      const reask = state.reaskSameRun && state.decidedIds.has(approvals[0].id) ? [reaskA] : [];
      const pending = [...approvals, ...(state.twoDeciders ? [approval2] : []), ...(state.threeDeciders ? [approval3] : []), ...reask].filter((a) => !state.decidedIds.has(a.id));
      return json(route, { approvals: url.searchParams.get("status") === "pending" ? pending : [] });
    }
    if (state.progress && path.endsWith("/agent-runs/progress")) {
      if (state.progressDelayMs) await sleep(state.progressDelayMs);
      return json(route, { runs: path.includes(lab.id) ? progressRows(state) : [] });
    }
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: [host] });
    if (path.endsWith("/work-sessions/shared")) {
      const who = url.searchParams.get("who") === "team" ? "team" : "mine";
      state.boardReads += 1;
      if (state.roundTripMs && state.boardReads > 1) await sleep(state.roundTripMs);
      return json(route, { sessions: boardView(state)[who], nextCursor: null, who });
    }
    if (/\/work-sessions\/[^/]+\/shared$/.test(path)) return json(route, { error: { message: "shared work session not found" } }, 404);
    if (path.endsWith("/work-sessions")) return json(route, { workSessions: [ledgerSession(macWaiting), ledgerSession(macQuiet)] });
    if (path.endsWith(`/workspaces/${workspaceId}`)) return json(route, { workspace: { id: workspaceId, name: "새벽 작업실" } });
    if (path.includes("/messages")) return json(route, { messages: [] });
    return json(route, {});
  });
}

async function installRealtime(page) {
  await page.addInitScript(() => {
    // 앱의 쿼리 기본 신선 시간(30초)을 기다리지 않고 「창에 돌아온 사람」을 흉내 내려고 시계를 앞당길 수 있게 한다.
    const actualNow = Date.now.bind(Date);
    let offsetMs = 0;
    Date.now = () => actualNow() + offsetMs;
    window.__capture5640Advance = (byMs) => {
      offsetMs += byMs;
    };
    class CaptureSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      constructor(url) { this.url = String(url); this.readyState = 0; queueMicrotask(() => { this.readyState = 1; this.onopen?.(new Event("open")); }); }
      send(data) {
        const replies = String(data).trim().split("\n").map((line) => {
          const c = JSON.parse(line);
          if (c.connect) return { id: c.id, connect: { client: "work-5640-capture", version: "6" } };
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

async function signIn(page, origin) {
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("nav-work").waitFor({ timeout: 20_000 });
}

const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const shots = [];
const shot = async (page, name, opts = {}) => {
  await page.screenshot({ path: resolve(OUT_DIR, `${name}.png`), ...opts });
  shots.push(`${name}.png`);
};

async function installDesktop(page, origin) {
  await page.addInitScript((serverOrigin) => {
    const callbacks = new Map();
    let next = 1;
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() { /* 구독 해제 흉내 */ } };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
      transformCallback(cb) { const id = next++; callbacks.set(id, cb); return id; },
      unregisterCallback(id) { callbacks.delete(id); },
      convertFileSrc: (p) => p,
      async invoke(cmd) {
        if (cmd === "keychain_available") return true;
        if (cmd === "keychain_store_refresh_token") { window.__kc = true; return null; }
        if (cmd === "keychain_refresh_token_handle") return window.__kc ? "shell:00000000000000000000000000000001" : null;
        if (cmd === "keychain_clear_refresh_token") { window.__kc = false; return null; }
        if (cmd === "deep_link_take_pending") return [];
        if (cmd.startsWith("plugin:event|")) return 1;
        return null;
      },
    };
    try { localStorage.setItem("momo.web.server.v1", serverOrigin); } catch { /* 저장소 없는 캡처 */ }
  }, origin);
}

async function openContext(browser, origin, { scheme, viewport, deviceScaleFactor = 1, waiting = [macWaiting.sessionId], noNativeAnchor = false, desktop = false, decision = "ok", server = {}, touch = false }) {
  const state = { waiting: new Set(waiting), boardReads: 0, ledgerReads: 0, decision, decisions: 0, decidedIds: new Set(), decidedRuns: new Map(), decidedRunOrder: [], decidedOrder: [], decidedHow: [], ...server };
  const context = await browser.newContext({ viewport, deviceScaleFactor, colorScheme: scheme, reducedMotion: "reduce", serviceWorkers: "block", locale: "ko-KR", ...(touch ? { hasTouch: true } : {}) });
  await installRoutes(context, state);
  const page = await context.newPage();
  await installRealtime(page);
  if (desktop) await installDesktop(page, origin);
  if (noNativeAnchor) {
    await page.addInitScript(() => {
      const style = document.createElement("style");
      style.textContent = "*, *::before, *::after { overflow-anchor: none !important; }";
      document.addEventListener("DOMContentLoaded", () => document.head.append(style));
    });
  }
  await signIn(page, origin);
  await page.goto(`${origin}/#/work`);
  await page.getByTestId("work-jobs-route").waitFor();
  await page.getByTestId("work-job-row").first().waitFor();
  await page.waitForFunction(() => document.querySelector('[data-section="needsMe"]') !== null || document.querySelectorAll('[data-testid="work-job-row"]').length > 0);
  return { context, page, state };
}

// ---- 장면 -----------------------------------------------------------------------------------------------------------------

const rowOf = (page, sessionId) => page.locator(`[data-section="needsMe"] [data-job-id="${sessionId}"]`);
const focusedRowId = (page) => page.evaluate(() => document.activeElement?.closest("[data-job-id]")?.getAttribute("data-job-id") ?? document.activeElement?.getAttribute("data-job-id") ?? null);
const listScroll = (page) => page.evaluate(() => document.querySelector("[data-team-board-list]")?.scrollTop ?? -1);

async function openSession(page, sessionId) {
  await rowOf(page, sessionId).click();
  await page.waitForFunction((sid) => window.location.hash.includes(`session=${sid}`), sessionId);
  await page.getByTestId("work-console-route").waitFor({ timeout: 10_000 });
  await page.getByTestId("work-console-back").waitFor();
  await page.waitForTimeout(300);
}

async function headScene(browser, origin, scheme, viewport, tag) {
  const { context, page } = await openContext(browser, origin, { scheme, viewport });
  await shot(page, `5673-list-${tag}`);
  await openSession(page, macWaiting.sessionId);
  const head = await page.evaluate(() => ({
    h1: document.querySelector('[data-testid="work-console-route"] h1')?.textContent?.trim() ?? null,
    back: document.querySelector('[data-testid="work-console-back"]')?.textContent?.trim() ?? null,
    backAria: document.querySelector('[data-testid="work-console-back"]')?.getAttribute("aria-label") ?? null,
    listTitle: document.getElementById("work-console-list-title")?.textContent?.trim() ?? null,
    text: document.body.innerText,
  }));
  check(`head ${tag}: 제목은 세션 이름`, head.h1 === macWaiting.label, head.h1);
  check(`head ${tag}: 「← 작업」 단추와 낭독 이름`, head.back === "작업" && head.backAria === "작업으로 돌아가기", head);
  check(`head ${tag}: 화면 글에 「작업 콘솔」 0줄`, !head.text.includes("작업 콘솔"), "");
  if (viewport.width >= 900) check(`head ${tag}: 목록 이름 「진행 중인 세션」`, head.listTitle === "진행 중인 세션", head.listTitle);
  check(`head ${tag}: 가로 넘침 0`, (await overflowX(page)) <= 0, await overflowX(page));
  await shot(page, `5673-session-${tag}`);
  await context.close();
}

/** 「작업」 → 세션 상세 → 돌아오기(「← 작업」 또는 브라우저 뒤로): 열었던 줄에 초점, 스크롤 위치 유지. */
async function returnScene(browser, origin, scheme, viewport, tag, how) {
  const { context, page } = await openContext(browser, origin, { scheme, viewport, waiting: [macWaiting.sessionId, macQuiet.sessionId] });
  await page.evaluate(() => { document.querySelector("[data-team-board-list]").scrollTop = 70; });
  await page.waitForTimeout(150);
  const before = await listScroll(page);
  check(`return ${tag}/${how}: 시험 전 목록이 굴러 있다`, before > 0, before);
  await openSession(page, macQuiet.sessionId);
  if (how === "button") await page.getByTestId("work-console-back").click();
  else await page.goBack();
  await page.getByTestId("work-jobs-route").waitFor();
  await page.waitForFunction((sid) => (document.activeElement?.closest("[data-job-id]")?.getAttribute("data-job-id") ?? document.activeElement?.getAttribute("data-job-id")) === sid, macQuiet.sessionId, { timeout: 5000 }).catch(() => {});
  const hash = await page.evaluate(() => window.location.hash);
  const focused = await focusedRowId(page);
  const after = await listScroll(page);
  check(`return ${tag}/${how}: 「작업」 주소로 돌아왔다`, !hash.includes("session="), hash);
  check(`return ${tag}/${how}: 열었던 줄에 초점`, focused === macQuiet.sessionId, focused);
  check(`return ${tag}/${how}: 목록 스크롤 위치 유지(${before} → ${after})`, Math.abs(after - before) <= 1, { before, after });
  await shot(page, `5673-return-${tag}-${how}`);
  await context.close();
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  try {
    for (const scheme of ["light", "dark"]) {
      for (const viewport of [{ width: 1280, height: 560 }, { width: 900, height: 560 }, { width: 390, height: 700 }]) {
        const tag = `${viewport.width}-${scheme}`;
        await headScene(browser, preview.origin, scheme, viewport, tag);
        await returnScene(browser, preview.origin, scheme, viewport, tag, "button");
      }
    }
    await returnScene(browser, preview.origin, "light", { width: 1280, height: 560 }, "1280-light", "back");
  } finally {
    await browser.close();
    await preview.stop?.();
  }
  console.log(`\n${shots.length} captures in ${OUT_DIR}`);
  if (failures.length > 0) {
    console.error(`\n${failures.length}개 단언 실패`);
    process.exit(1);
  }
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
