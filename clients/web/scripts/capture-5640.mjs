#!/usr/bin/env node
// =============================================================================
// 「작업 · 내 작업」의 「응답 필요」 구간 캡처·실측 (#5640, ADR-0202 D1·D5·증보 2026-11-11, ADR-0188 D5).
//
//   npm run build && OUT_DIR=<dir> CAPTURE_PORT=<port> node scripts/capture-5640.mjs
//
// 백엔드가 없다. `/v1/**`는 이 파일의 고정 응답이고, 보드는 #5639 계약을 흉내 낸다: `include=jobs`로 읽는 사람이 세션 주인일
// 때만, 대기 요청이 있는 실행 중 맥 세션의 상태가 `waiting`이다. 승인 원장은 인박스 배지가 읽는 그 경로다. 사람·컴퓨터 이름은
// 가상 인물이다. **라이브 서버·데스크탑 앱·실기기 왕복은 runtime-unverified**다.
//
// 재는 것:
//   - 구간 순서(응답 필요 → 지금 → 끝난 일), 「팀 전체」에는 구간 없음, 가로 넘침 0, 결과 칸 글 잘림 0
//   - 수리 1회차: 열 이름, 결과 칸 꼬리표(승인 요청 · 권한 요청 · 에이전트 보고), 결정자 줄의 승인·거부(결과 열 안),
//     결정자가 아닌 줄의 대기 줄 + 카드 링크, 줄 사이 머리카락 선, 결정 중(「보내는 중」)·결정 실패(단추 자리의 한 줄),
//     데스크탑 셸 흉내(`__TAURI_INTERNALS__`)에서 권한 요청 줄의 「열어서 답하기」
//   - 1280·900·390 × 밝게·어둡게, 200% 확대(1280 창 = CSS 640), 키보드 초점 링
//   - 줄이 구간을 옮길 때(지금 → 응답 필요) 스크롤한 목록의 보던 줄 이동 px와 캐럿 유지. 브라우저의 스크롤 고정을 끄고
//     (`overflow-anchor: none`, 데스크탑 셸 WebKit에는 이 기능이 없다) 화면 코드의 고정만으로 잰다.
//   - 브라우저에서 내 맥 세션 줄 Enter → 세션 화면(작업 콘솔)
//   - 수리 2회차: 줄의 띠(가리킴·눌림·펼침 채움, 키보드 초점 링)가 구분선 사이를 끝에서 끝까지 채우는 각진 띠인지 — 찍힌 픽셀로
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
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(homedir(), ".cache/momo-scratch/5640/captures");
const PORT = Number(process.env.CAPTURE_PORT || 5264);
const ONLY = process.env.CAPTURE_ONLY ?? "";

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
  // 결정이 닿은 run은 서버가 다시 돌린다(phase `running`).
  const view = (row) =>
    row.origin === "host" && row.owner.memberId === memberId && state.waiting.has(row.sessionId)
      ? { ...row, state: "waiting" }
      : row.runId && state.decidedRuns.has(row.runId)
        ? { ...row, phase: "running" }
        : row;
  const second = state.twoDeciders ? [runApproval2] : [];
  const mine = [macWaiting, runApproval, ...second, runNonDecider, macQuiet, runWorking, ...doneRows].map(view);
  const team = [macWaiting, runApproval, ...second, runNonDecider, othersTerminal, macQuiet, runWorking, ...doneRows].map(view);
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
      const decidedRun = [...approvals, approval2].find((a) => a.id === approvalId)?.runId;
      if (decidedRun) state.decidedRuns.add(decidedRun);
      if (state.decisionDelayMs) await sleep(state.decisionDelayMs);
      return json(route, { status: "approved", decided_by: memberId, decided_at_ms: Date.now() });
    }
    if (path.endsWith("/approvals")) {
      state.ledgerReads += 1;
      if (state.ledgerDelayMs && state.ledgerReads === 1) await sleep(state.ledgerDelayMs);
      if (state.roundTripMs) await sleep(state.roundTripMs);
      const pending = [...approvals, ...(state.twoDeciders ? [approval2] : [])].filter((a) => !state.decidedIds.has(a.id));
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
/** 결과 칸 글·제목이 한 글자라도 잘리면 그 글. 숨은 요소는 세지 않는다. */
const clippedText = (page) =>
  page.evaluate(() => {
    const nodes = document.querySelectorAll('[data-testid="work-job-approval-summary"], [data-testid="work-job-approval-waiting"], [data-testid="work-job-permission-in-app"], [data-testid="work-job-approval-link"] > span, [data-testid="work-job-row"] [data-col="task"] > span:first-child');
    const out = [];
    for (const el of nodes) {
      if (el.getClientRects().length === 0) continue;
      if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) out.push((el.textContent ?? "").trim());
    }
    return out;
  });
const sectionOrder = (page) => page.$$eval('[data-testid="work-jobs-section"]', (els) => els.map((e) => e.getAttribute("data-section")));
const rowIdsIn = (page, key) =>
  page.$$eval(`[data-testid="work-jobs-section"][data-section="${key}"] [data-testid="work-job-row"]`, (els) => els.map((e) => e.getAttribute("data-job-id")));
const shots = [];
const shot = async (page, name, opts = {}) => {
  await page.screenshot({ path: resolve(OUT_DIR, `${name}.png`), ...opts });
  shots.push(`${name}.png`);
};

// ---- 줄의 띠 (수리 2회차) ------------------------------------------------------------------------------------------------

const rgb = (css) => (css.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** 목록 안에서 읽은 띠 토큰(셸·테마가 토큰을 바꿀 수 있어 그 자리에서 잰다). */
const bandTokens = (page) =>
  page.evaluate(() => {
    const probe = document.createElement("div");
    document.querySelector('[data-testid="work-jobs-table"]').append(probe);
    const read = (name) => {
      probe.style.backgroundColor = `var(${name})`;
      return getComputedStyle(probe).backgroundColor;
    };
    const out = { hover: read("--surface-hover"), pressed: read("--surface-pressed") };
    probe.remove();
    return out;
  });
/** 줄(`li`) 상자·계산 스타일. 줄 단추·컨트롤 층·상태 칩도 함께. */
const jobBox = (page, rowId) =>
  page.evaluate((id) => {
    const btn = document.querySelector(`[data-testid="work-job-row"][data-job-id="${id}"]`);
    const li = btn.closest('[data-testid="work-job"]');
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    };
    const cs = (el) => getComputedStyle(el);
    const extras = li.querySelector('[data-testid="work-job-extras"]');
    const chip = li.querySelector('[data-testid="team-board-state"]');
    const tag = [...li.querySelectorAll('[data-testid$="-tag"]')].find((el) => el.getClientRects().length > 0) ?? null;
    return {
      li: box(li),
      extras: extras ? box(extras) : null,
      liBg: cs(li).backgroundColor,
      liRadius: cs(li).borderRadius,
      liOutline: { style: cs(li).outlineStyle, width: cs(li).outlineWidth },
      btnBg: cs(btn).backgroundColor,
      btnRadius: cs(btn).borderRadius,
      btnOutline: cs(btn).outlineStyle,
      chipText: chip?.textContent?.trim() ?? null,
      chipBg: chip ? cs(chip).backgroundColor : null,
      tagBg: tag ? cs(tag).backgroundColor : null,
      title: box(btn.querySelector('[data-col="task"] > span:first-child')),
    };
  }, rowId);
/** 줄 상자 안의 찍힌 픽셀(CSS px 좌표, 줄 왼쪽 위 기준). 해독은 CSP 없는 빈 쪽의 캔버스로(새 의존 없음). */
async function bandPixels(page, decoder, li, points) {
  const clip = { x: Math.round(li.x), y: Math.round(li.y), width: Math.floor(li.width), height: Math.floor(li.height) };
  const png = await page.screenshot({ clip });
  return decoder.evaluate(
    async ({ b64, pts, w }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${b64}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const g = canvas.getContext("2d");
      g.drawImage(image, 0, 0);
      const scale = image.width / w;
      const out = {};
      for (const [name, x, y] of pts) {
        const d = g.getImageData(Math.floor(x * scale), Math.floor(y * scale), 1, 1).data;
        out[name] = [d[0], d[1], d[2]];
      }
      return out;
    },
    { b64: png.toString("base64"), pts: points, w: clip.width }
  );
}
/** 띠의 네 모서리(구분선 바로 위까지) + 컨트롤 층의 왼쪽 여백. 둥근 띠·단추에만 칠한 띠면 모서리·컨트롤 층이 바탕색이다. */
const bandPoints = (m) => {
  const w = Math.floor(m.li.width);
  const h = Math.floor(m.li.height);
  const pts = [["tl", 1, 1], ["tr", w - 2, 1], ["bl", 1, h - 3], ["br", w - 2, h - 3]];
  if (m.extras) pts.push(["extras", 2, Math.round(m.extras.y - m.li.y + m.extras.height / 2)]);
  return pts;
};
const allNear = (px, color) => Object.values(px).every((p) => dist(p, color) <= 3);
/**
 * 띠가 그 점까지 칠했는가: 모든 점이 쉬는 때와 달라졌고(채움이 닿았다), 오른쪽 두 모서리는 토큰 색 그대로다. 왼쪽 점은 토큰과 같다고
 * 묻지 않는다 — 폰 폭에서는 닫힌 사이드바 서랍(`.sidebar-drawer`, 화면 밖 -280..0)의 `shadow-lg`가 본문 왼쪽 10px 안팎에 비쳐
 * 쉬는 때든 칠한 때든 그 점이 조금 어둡다(이 PR 밖의 기존 그림자, 인계 「후속」).
 */
const bandLit = (rest, lit, color) =>
  Object.keys(rest).every((k) => dist(rest[k], lit[k]) > 3) && dist(lit.tr, color) <= 3 && dist(lit.br, color) <= 3;

/**
 * 결정자 승인 줄의 띠: 가리킴 → 눌림 → 거부 알약 가리킴 → 키보드 초점 링 → Tab 거부. 캡처 `5640-hover-*`·`5640-focus-ring-*`.
 * 모든 폭·스킴(그리고 200%)에서 같은 단언이다.
 */
async function bandChecks(page, tag) {
  const decoder = await page.context().newPage();
  try {
    const tokens = await bandTokens(page);
    const hover = rgb(tokens.hover);
    const pressed = rgb(tokens.pressed);
    const id = runApproval.runId;
    // 줄 전체(컨트롤 층까지)가 화면 안이어야 찍힌 픽셀을 잴 수 있다(200%에서는 줄이 화면 아래로 걸친다).
    await page.evaluate((rid) => document.querySelector(`[data-testid="work-job-row"][data-job-id="${rid}"]`).closest('[data-testid="work-job"]').scrollIntoView({ block: "center" }), id);
    await page.mouse.move(0, 0);
    const rest = await jobBox(page, id);
    const vh = page.viewportSize().height;
    check(`${tag} 띠를 재는 줄이 화면 안`, rest.li.y >= 0 && rest.li.y + rest.li.height <= vh, { li: rest.li, vh });
    const restPx = await bandPixels(page, decoder, rest.li, bandPoints(rest));
    check(`${tag} 띠: 쉬는 줄은 채움 없음(재는 색과 바탕이 다르다)`, Object.values(restPx).every((p) => dist(p, hover) > 3), { restPx, hover });
    check(`${tag} 상태 칩 「응답 필요」(승인 요청 줄)`, rest.chipText === "응답 필요", rest.chipText);
    // 가리킴: 줄 단추(제목) 위.
    await page.mouse.move(rest.title.x + Math.min(20, rest.title.width / 2), rest.title.y + rest.title.height / 2);
    await page.waitForTimeout(50);
    const hov = await jobBox(page, id);
    const hovPx = await bandPixels(page, decoder, hov.li, bandPoints(hov));
    check(`${tag} 띠: 가리킴 채움이 네 모서리·컨트롤 층까지(각진 띠)`, bandLit(restPx, hovPx, hover) && hov.extras !== null, { restPx, hovPx, hover });
    check(`${tag} 띠: 줄·줄 단추 반경 0, 단추 채움 = 띠 색(이음매 없음)`, hov.liRadius === "0px" && hov.btnRadius === "0px" && dist(rgb(hov.btnBg), hover) <= 3 && dist(rgb(hov.liBg), hover) <= 3, { li: hov.liRadius, btn: hov.btnRadius, btnBg: hov.btnBg, liBg: hov.liBg });
    check(`${tag} 띠: 가리켜도 줄 높이 그대로`, Math.abs(hov.li.height - rest.li.height) < 0.5, { rest: rest.li.height, hover: hov.li.height });
    check(`${tag} 칩 그릇이 띠 위에 남는다(상태 칩·꼬리표)`, dist(rgb(hov.chipBg), hover) > 3 && dist(rgb(hov.tagBg), hover) > 3, { chip: hov.chipBg, tag: hov.tagBg, band: tokens.hover });
    await shot(page, `5640-hover-${tag}`);
    // 눌림: 줄 단추를 누르는 동안. 뗄 때는 거부 위로 옮겨 떼어 서랍을 열지 않는다(누른 곳과 뗀 곳이 달라 단추의 click이 없다).
    await page.mouse.down();
    await page.waitForTimeout(50);
    const prsPx = await bandPixels(page, decoder, hov.li, bandPoints(hov));
    check(`${tag} 띠: 눌림 채움이 네 모서리·컨트롤 층까지`, bandLit(restPx, prsPx, pressed) && dist(prsPx.tr, hover) > 3, { prsPx, pressed });
    const reject = page.locator(`[data-testid="work-job"]`, { has: page.locator(`[data-job-id="${id}"]`) }).getByTestId("work-job-approval-reject");
    const rb = await reject.boundingBox();
    await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
    await page.mouse.up();
    await page.waitForTimeout(50);
    // 거부 알약 가리킴: 띠는 꺼지고 알약의 가리킴 채움이 바탕과 갈린다. 알약은 오른쪽 안쪽 끝을 잰다(폰 폭의 왼쪽 그림자 밖, 글자 밖).
    const onPill = await jobBox(page, id);
    const pillBg = await reject.evaluate((el) => getComputedStyle(el).backgroundColor);
    const pillPx = await bandPixels(page, decoder, onPill.li, [["pad", 2, 1], ["pill", Math.round(rb.x - onPill.li.x + rb.width - 6), Math.round(rb.y - onPill.li.y + rb.height / 2)]]);
    check(`${tag} 거부를 가리키면 띠는 꺼지고 알약(가리킴 채움)이 남는다`, /rgba\(0, 0, 0, 0\)|transparent/.test(onPill.liBg) && dist(rgb(pillBg), hover) <= 3 && dist(pillPx.pill, hover) <= 3 && dist(pillPx.pill, pillPx.pad) > 3, { liBg: onPill.liBg, pillBg, pillPx });
    console.log(`MEASURE band-${tag}: hover=${tokens.hover} pressed=${tokens.pressed} pill(on hover)=${pillBg} pillPx=${pillPx.pill} padPx=${pillPx.pad}`);
    // 키보드 초점 링: 띠 둘레(줄 단추 자신의 링 없음).
    await page.mouse.move(0, 0);
    await page.locator(`[data-testid="work-job-row"][data-job-id="${id}"]`).focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowUp");
    const ring = await jobBox(page, id);
    const active = await page.evaluate(() => document.activeElement?.getAttribute("data-job-id") ?? null);
    check(`${tag} 키보드 초점 링: 띠(li) 둘레 2px, 줄 단추 자신은 링 없음`, active === id && ring.liOutline.style === "solid" && ring.liOutline.width === "2px" && ring.btnOutline === "none" && ring.liRadius === "0px", { active, ring: ring.liOutline, btn: ring.btnOutline });
    await shot(page, `5640-focus-ring-${tag}`);
    await page.keyboard.press("Tab");
    const inner = await jobBox(page, id);
    const innerActive = await page.evaluate(() => ({ id: document.activeElement?.getAttribute("data-testid"), outline: getComputedStyle(document.activeElement).outlineStyle }));
    check(`${tag} Tab 거부: 띠 링은 접히고 거부 자신의 링만`, innerActive.id === "work-job-approval-reject" && innerActive.outline === "solid" && inner.liOutline.style === "none", { innerActive, li: inner.liOutline });
  } finally {
    await decoder.close();
  }
}

/** 데스크탑 셸 흉내(명령은 빈 답). 「작업」 화면이 `isDesktop()`으로 가르는 것만 본다 — 실제 WKWebView·A 칸은 runtime-unverified. */
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

async function openContext(browser, origin, { scheme, viewport, deviceScaleFactor = 1, waiting = [macWaiting.sessionId], noNativeAnchor = false, desktop = false, decision = "ok", server = {} }) {
  const state = { waiting: new Set(waiting), boardReads: 0, ledgerReads: 0, decision, decisions: 0, decidedIds: new Set(), decidedRuns: new Set(), decidedOrder: [], ...server };
  const context = await browser.newContext({ viewport, deviceScaleFactor, colorScheme: scheme, reducedMotion: "reduce", serviceWorkers: "block", locale: "ko-KR" });
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

async function scene(browser, origin, scheme, viewport, tag) {
  const { context, page } = await openContext(browser, origin, { scheme, viewport });
  await page.locator('[data-section="needsMe"]').waitFor();
  // 승인 원장(run 줄 재료)이 닿을 때까지.
  await page.waitForFunction(() => document.querySelectorAll('[data-section="needsMe"] [data-testid="work-job-row"]').length === 2);
  check(`${tag} 구간 순서 응답 필요 → 지금 → 끝난 일`, JSON.stringify(await sectionOrder(page)) === JSON.stringify(["needsMe", "now", "done"]), await sectionOrder(page));
  const needs = await rowIdsIn(page, "needsMe");
  check(`${tag} 응답 필요: 서버가 준 맥 세션 + 원장의 run`, JSON.stringify(needs) === JSON.stringify([macWaiting.sessionId, runApproval.runId]), needs);
  const header = (await page.locator('[data-section="needsMe"] h2').innerText()).replace(/\s+/g, " ").trim();
  check(`${tag} 머리글 「응답 필요 2」`, header === "응답 필요 2", header);
  const text = (loc) => loc.innerText().then((t) => t.replace(/\s+/g, " ").trim());
  const job = (rowId) => page.locator('[data-testid="work-job"]', { has: page.locator(`[data-testid="work-job-row"][data-job-id="${rowId}"]`) });
  // 결과 칸 꼬리표: 맥 세션 → 권한 요청(브라우저: 허락할 곳 안내), run → 승인 요청 + 승인·거부.
  const permJob = job(macWaiting.sessionId);
  check(`${tag} 권한 요청 꼬리표`, (await text(permJob.getByTestId("work-job-permission-tag").locator("visible=true").first())) === "권한 요청");
  check(`${tag} 권한 요청 안내(브라우저)`, (await text(permJob.getByTestId("work-job-permission-in-app").locator("visible=true").first())) === "허락은 폰이나 데스크탑 앱에서 보내 주세요");
  check(`${tag} 권한 요청: 브라우저에는 단추 없음`, (await permJob.getByTestId("work-job-permission-open").count()) === 0);
  const runJob = job(runApproval.runId);
  check(`${tag} 승인 요청 꼬리표`, (await text(runJob.getByTestId("work-job-approval-tag").locator("visible=true").first())) === "승인 요청");
  await runJob.getByTestId("work-job-approval-approve").waitFor();
  check(`${tag} 결정자: 승인·거부가 보인다`, (await runJob.getByTestId("work-job-approval-approve").isVisible()) && (await runJob.getByTestId("work-job-approval-reject").isVisible()));
  const nonJob = job(runNonDecider.runId);
  check(`${tag} 비결정자: 단추 없음`, (await nonJob.getByTestId("work-job-approval-approve").count()) === 0);
  check(`${tag} 비결정자: 대기 줄`, (await text(nonJob.getByTestId("work-job-approval-waiting").locator("visible=true").first())) === "관리자의 승인을 기다려요");
  check(`${tag} 비결정자: 카드 링크`, await nonJob.getByTestId("work-job-approval-link").isVisible());
  check(`${tag} 비결정자: 「지금」 맨 위`, (await rowIdsIn(page, "now"))[0] === runNonDecider.runId, await rowIdsIn(page, "now"));
  // 한 작업 = 한 덩어리: 줄 사이 머리카락 선 1px, 컨트롤은 결과 글과 같은 열(왼쪽 끝이 같다).
  const sep = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="work-job"]')).borderBottomWidth);
  check(`${tag} 줄 사이 선 1px`, sep === "1px", sep);
  const align = await runJob.evaluate((li) => {
    const cell = [...li.querySelectorAll('[data-testid="work-job-approval-tag"]')].find((el) => el.getClientRects().length > 0);
    const btn = li.querySelector('[data-testid="work-job-approval-reject"]');
    return Math.round(btn.getBoundingClientRect().left - cell.getBoundingClientRect().left);
  });
  check(`${tag} 승인·거부가 결과 글과 같은 열(왼쪽 끝 차 0px)`, align === 0, align);
  if (viewport.width >= 1280) {
    const heads = await page.evaluate(() => [...document.querySelectorAll('[data-testid="work-jobs-table"] > div[aria-hidden] > span')].map((e) => e.textContent));
    check(`${tag} 열 이름`, JSON.stringify(heads) === JSON.stringify(["작업", "결과", "상태", "작업 시간", "요청 채널"]), heads);
  }
  check(`${tag} 가로 넘침 0`, (await overflowX(page)) === 0, await overflowX(page));
  check(`${tag} 안내·제목 잘림 0`, (await clippedText(page)).length === 0, await clippedText(page));
  await shot(page, `5640-mine-${tag}`);
  // 권한 요청 줄의 상태 칩도 같은 낱말(두 종류 모두 「응답 필요」, 종류는 꼬리표가).
  check(`${tag} 상태 칩 「응답 필요」(권한 요청 줄)`, (await text(permJob.getByTestId("team-board-state"))) === "응답 필요");
  // 수리 3회차 H2: 「응답 필요」는 그 구간의 줄만. 머리글 수 = 「응답 필요」 칩 수(화면 전체), 구간 밖 승인 대기 줄은 「승인 대기」.
  const chipWords = await page.$$eval('[data-testid="team-board-state"]', (els) => els.filter((e) => e.getClientRects().length > 0).map((e) => e.textContent.trim()));
  check(`${tag} 머리글 수 = 「응답 필요」 칩 수`, chipWords.filter((w) => w === "응답 필요").length === 2, chipWords);
  check(`${tag} 비결정자 줄 칩 「승인 대기」`, (await text(nonJob.getByTestId("team-board-state"))) === "승인 대기");
  await bandChecks(page, tag);

  if (viewport.width >= 1280) {
    await page.getByTestId("work-jobs-filter-team").click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="work-job-row"]').length === 18);
    check(`${tag} 팀 전체: 구간 없음`, JSON.stringify(await sectionOrder(page)) === JSON.stringify(["now", "done"]), await sectionOrder(page));
    check(`${tag} 팀 전체: 권한 요청 꼬리표 없음`, (await page.getByTestId("work-job-permission-tag").count()) === 0);
    check(`${tag} 팀 전체: 결정 단추 0`, (await page.getByTestId("work-job-approval-approve").count()) + (await page.getByTestId("work-job-approval-reject").count()) === 0);
    const teamApprovalChips = await page.$$eval('[data-testid="work-job-row"][data-approval]', (els) => els.map((e) => e.querySelector('[data-testid="team-board-state"]').textContent.trim()));
    check(`${tag} 팀 전체: 승인 대기 줄의 칩은 「승인 대기」(수리 3회차 H2)`, teamApprovalChips.length === 2 && teamApprovalChips.every((w) => w === "승인 대기"), teamApprovalChips);
    await shot(page, `5640-team-${tag}`);
  }
  await context.close();
}

/** 200% 확대: 1280 창을 200%로 키우면 CSS 폭 640이다. */
async function zoomScene(browser, origin) {
  const { context, page } = await openContext(browser, origin, { scheme: "light", viewport: { width: 640, height: 450 }, deviceScaleFactor: 2 });
  await page.waitForFunction(() => document.querySelectorAll('[data-section="needsMe"] [data-testid="work-job-row"]').length === 2);
  check("zoom200 가로 넘침 0", (await overflowX(page)) === 0, await overflowX(page));
  check("zoom200 안내·제목 잘림 0", (await clippedText(page)).length === 0, await clippedText(page));
  await shot(page, "5640-zoom200-light");
  await bandChecks(page, "zoom200-light");
  await context.close();
}

/**
 * 펼친 줄(서랍이 열림)의 띠와 그 줄의 거부 알약 — 단언 없이 잰 값만 남긴다(planner가 정할 것: 펼침 채움과 보조 알약의 가리킴 채움이
 * 같은 토큰). 캡처 `5640-selected-reject-hover-*`(1440: 목록과 서랍이 함께 선다).
 */
async function selectedScene(browser, origin, scheme) {
  // 1400보다 좁으면 서랍이 목록 자리를 차지한다(`team-board-layout`): 목록과 서랍이 함께 서는 폭에서 잰다.
  const { context, page } = await openContext(browser, origin, { scheme, viewport: { width: 1440, height: 900 } });
  await page.waitForFunction(() => document.querySelectorAll('[data-section="needsMe"] [data-testid="work-job-row"]').length === 2);
  const id = runApproval.runId;
  const decoder = await context.newPage();
  const tokens = await bandTokens(page);
  await page.locator(`[data-testid="work-job-row"][data-job-id="${id}"]`).click();
  await page.waitForFunction((rid) => document.querySelector(`[data-testid="work-job-row"][data-job-id="${rid}"]`)?.getAttribute("aria-expanded") === "true", id);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(100);
  const sel = await jobBox(page, id);
  const selPx = await bandPixels(page, decoder, sel.li, bandPoints(sel));
  check(`selected-${scheme} 펼친 줄: 펼침 채움이 네 모서리·컨트롤 층까지`, allNear(selPx, rgb(tokens.hover)), { selPx, hover: tokens.hover });
  const reject = page.locator(`[data-testid="work-job"]`, { has: page.locator(`[data-job-id="${id}"]`) }).getByTestId("work-job-approval-reject");
  const rb = await reject.boundingBox();
  const pillPoint = (li) => [["pad", 2, 1], ["pill", Math.round(rb.x - li.x + rb.width - 6), Math.round(rb.y - li.y + rb.height / 2)]];
  const restPx = await bandPixels(page, decoder, sel.li, pillPoint(sel.li));
  await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
  await page.waitForTimeout(50);
  const pillBg = await reject.evaluate((el) => getComputedStyle(el).backgroundColor);
  const after = await jobBox(page, id);
  const px = await bandPixels(page, decoder, after.li, pillPoint(after.li));
  console.log(`MEASURE selected-${scheme}: band=${after.liBg} pill(rest)=${restPx.pill} pill(hover)=${pillBg} pillPx=${px.pill} padPx=${px.pad} dist(pill,band)=${dist(px.pill, px.pad).toFixed(2)} dist(hover,rest)=${dist(px.pill, restPx.pill).toFixed(2)}`);
  // 수리 3회차 질문 ② (a): 펼친 줄의 거부 알약을 가리켜도 그릇이 띠와 갈린다(가리킴 채움 = `--surface-pressed`).
  check(`selected-${scheme} 펼친 줄: 가리킨 거부 알약이 띠에 녹지 않는다`, dist(rgb(pillBg), rgb(tokens.pressed)) <= 3 && dist(px.pill, px.pad) > 3, { pillBg, pressed: tokens.pressed, pill: px.pill, band: px.pad });
  await shot(page, `5640-selected-reject-hover-${scheme}`);
  await decoder.close();
  await context.close();
}

/** 줄이 구간을 옮길 때: 보던 줄 이동 px, 캐럿 유지. 브라우저의 스크롤 고정은 끈다(WebKit 흉내). */
async function jumpScene(browser, origin, scheme) {
  const { context, page, state } = await openContext(browser, origin, { scheme, viewport: { width: 900, height: 700 }, noNativeAnchor: true });
  await page.waitForFunction(() => document.querySelectorAll('[data-section="needsMe"] [data-testid="work-job-row"]').length === 2);
  const anchorOff = await page.evaluate(() => getComputedStyle(document.querySelector(".work-jobs-list")).overflowAnchor);
  check(`jump-${scheme} 브라우저 스크롤 고정 꺼짐`, anchorOff === "none", anchorOff);
  // 끝난 일 중간쯤까지 내려 읽는 중. 「지금」의 조용한 맥 세션 줄에 캐럿이 있다(키보드 사용자).
  await page.evaluate(() => {
    const list = document.querySelector(".work-jobs-list");
    list.scrollTop = 0;
  });
  await page.locator(`[data-testid="work-job-row"][data-job-id="${macQuiet.sessionId}"]`).focus();
  // 「끝난 일」까지 내려 읽는 중: 바뀌는 줄(지금 → 응답 필요)은 모두 화면 위에 있다. 보던 줄 = 화면 맨 위에 온전히 보이는 첫 줄.
  const watched = await page.evaluate((target) => {
    const list = document.querySelector(".work-jobs-list");
    const row = document.querySelector(`[data-testid="work-job-row"][data-job-id="${target}"]`);
    list.scrollTop += row.getBoundingClientRect().top - list.getBoundingClientRect().top;
    list.dispatchEvent(new Event("scroll"));
    return target;
  }, doneRows[2].runId);
  await page.waitForTimeout(100);
  const before = await page.evaluate((rowId) => {
    const list = document.querySelector(".work-jobs-list");
    const row = document.querySelector(`[data-testid="work-job-row"][data-job-id="${rowId}"]`);
    return { top: row.getBoundingClientRect().top - list.getBoundingClientRect().top, scrollTop: list.scrollTop };
  }, watched);
  check(`jump-${scheme} 바뀌는 줄은 화면 위에 있다`, before.scrollTop > 0 && Math.abs(before.top) < 1, before);
  await shot(page, `5640-jump-before-${scheme}`);
  // 서버: 조용하던 맥 세션에 권한 요청이 생겼다. 31초 뒤 창에 돌아온 사람(가시성 변화)이 다시 읽게 한다
  // (실시간 신호 `approval.requested`의 다시 읽기는 jsdom 시험이 잰다 — 같은 다시 그리기 길이다).
  const reads = state.boardReads;
  state.waiting.add(macQuiet.sessionId);
  await page.evaluate(() => {
    window.__capture5640Advance(31_000);
    window.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForFunction((rowId) => document.querySelector(`[data-section="needsMe"] [data-job-id="${rowId}"]`) !== null, macQuiet.sessionId);
  check(`jump-${scheme} 다시 읽음`, state.boardReads > reads, { reads, now: state.boardReads });
  await page.waitForTimeout(100);
  const after = await page.evaluate((rowId) => {
    const list = document.querySelector(".work-jobs-list");
    const row = document.querySelector(`[data-testid="work-job-row"][data-job-id="${rowId}"]`);
    const active = document.activeElement;
    return {
      top: row.getBoundingClientRect().top - list.getBoundingClientRect().top,
      scrollTop: list.scrollTop,
      activeId: active?.getAttribute("data-job-id") ?? active?.tagName ?? null,
    };
  }, watched);
  const moved = Math.round((after.top - before.top) * 100) / 100;
  check(`jump-${scheme} 보던 줄 이동 0px`, moved === 0, { before, after, moved });
  check(`jump-${scheme} 캐럿이 옮긴 줄을 따라감`, after.activeId === macQuiet.sessionId, after.activeId);
  await shot(page, `5640-jump-after-${scheme}`);
  console.log(`MEASURE jump-${scheme}: before.top=${before.top} after.top=${after.top} moved=${moved}px scrollTop ${before.scrollTop}→${after.scrollTop}`);
  await context.close();
}

/** 데스크탑 셸 흉내: 권한 요청 줄의 「열어서 답하기」(내용 없는 허락 단추는 없다). */
async function desktopScene(browser, origin, scheme) {
  const { context, page } = await openContext(browser, origin, { scheme, viewport: { width: 1280, height: 800 }, desktop: true });
  await page.waitForFunction(() => document.querySelectorAll('[data-section="needsMe"] [data-testid="work-job-row"]').length === 2);
  const open = page.getByTestId("work-job-permission-open");
  check(`desktop-${scheme} 「열어서 답하기」 하나`, (await open.count()) === 1 && (await open.innerText()).trim() === "열어서 답하기");
  check(`desktop-${scheme} 권한 요청: 안내 줄 없음`, (await page.getByTestId("work-job-permission-in-app").locator("visible=true").count()) === 0);
  check(`desktop-${scheme} 가로 넘침 0`, (await overflowX(page)) === 0, await overflowX(page));
  await shot(page, `5640-desktop-${scheme}`);
  await open.click();
  // 격자가 `agent=`를 읽고 주소에서 걷을 수 있어 「터미널 보기로 갔다」를 잰다(같은 길의 jsdom 시험이 `agent=`까지 잰다).
  const landed = await page.waitForFunction(() => (window.location.href.includes("view=terminals") ? window.location.href : null)).then((h) => h.jsonValue()).catch(async () => page.evaluate(() => window.location.href));
  check(`desktop-${scheme} 「열어서 답하기」 → 그 세션의 A 칸(터미널 보기)`, String(landed).includes("view=terminals"), landed);
  await context.close();
}

/** 결정 중(답을 붙잡음) → 「보내는 중」, 결정 실패(500) → 단추 자리의 한 줄, 단추는 남는다. */
async function decideScene(browser, origin, scheme) {
  for (const mode of ["hold", "fail"]) {
    const { context, page, state } = await openContext(browser, origin, { scheme, viewport: { width: 1280, height: 800 }, decision: mode });
    await page.waitForFunction(() => document.querySelectorAll('[data-section="needsMe"] [data-testid="work-job-row"]').length === 2);
    const approve = page.getByTestId("work-job-approval-approve");
    // 키보드만으로: 그 줄 단추에서 Tab 한 번 = 거부, 두 번 = 승인(실수로 승인이 먼저 오지 않는다).
    await page.locator(`[data-testid="work-job-row"][data-job-id="${runApproval.runId}"]`).focus();
    const active = () => page.evaluate(() => ({ id: document.activeElement?.getAttribute("data-testid"), visible: document.activeElement?.matches(":focus-visible") ?? false }));
    await page.keyboard.press("Tab");
    const first = await active();
    await page.keyboard.press("Tab");
    const second = await active();
    check(`decide-${mode}-${scheme} 키보드: 줄 → Tab 거부 → Tab 승인(초점 링 보임)`, first.id === "work-job-approval-reject" && second.id === "work-job-approval-approve" && second.visible, { first, second });
    await page.keyboard.press("Enter");
    if (mode === "hold") {
      await page.waitForFunction(() => document.querySelector('[data-testid="work-job-approval-approve"]')?.textContent === "보내는 중");
      check(`decide-hold-${scheme} 「보내는 중」·aria-disabled`, (await approve.getAttribute("aria-disabled")) === "true");
      await page.keyboard.press("Enter");
      check(`decide-hold-${scheme} 두 번 나가지 않는다`, state.decisions === 1, state.decisions);
      await shot(page, `5640-deciding-${scheme}`);
    } else {
      await page.getByTestId("work-job-approval-error").waitFor();
      check(`decide-fail-${scheme} 실패 줄은 alert`, (await page.getByTestId("work-job-approval-error").getAttribute("role")) === "alert");
      check(`decide-fail-${scheme} 단추는 남는다`, (await approve.innerText()).trim() === "승인");
      check(`decide-fail-${scheme} 가로 넘침 0`, (await overflowX(page)) === 0, await overflowX(page));
      await shot(page, `5640-decide-failed-${scheme}`);
    }
    await context.close();
  }
}

// ---- 같은 자리 두 번 누름 (수리 3회차 H1) -----------------------------------------------------------------------------------

/** 그 점 밑에 무엇이 있나: 결정 단추면 어느 줄의 무엇인지. */
const underPoint = (page, x, y) =>
  page.evaluate(([px, py]) => {
    const el = document.elementFromPoint(px, py);
    const decision = el?.closest("[data-decision]");
    const job = el?.closest('[data-testid="work-job"]')?.querySelector('[data-testid="work-job-row"]')?.getAttribute("data-job-id") ?? null;
    return { decision: decision?.getAttribute("data-decision") ?? null, job, testid: el?.closest("[data-testid]")?.getAttribute("data-testid") ?? null };
  }, [x, y]);
const approveCenter = async (page, rowId) => {
  const box = await page.locator('[data-testid="work-job"]', { has: page.locator(`[data-job-id="${rowId}"]`) }).getByTestId("work-job-approval-approve").boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};
const twoDecidersReady = (page) =>
  page.waitForFunction(() => document.querySelectorAll('[data-section="needsMe"] [data-testid="work-job-approval-approve"]').length === 2, null, { timeout: 15_000 });

/**
 * 결정자 줄 둘(맨 위, scrollTop 0)에서 A의 「승인」을 누르고 포인터를 움직이지 않은 채 같은 자리를 한 번 더 누른다(검수 1회차 재현).
 * 서버 왕복(결정 POST·원장·목록 GET) 40·100·300ms × 두 번째 누름 +250·+600·+1600ms. 나간 결정은 1건이어야 한다.
 */
async function doublePressScene(browser, origin, viewport) {
  for (const roundTripMs of [40, 100, 300]) {
    for (const gapMs of [250, 600, 1600]) {
      const tag = `double-${viewport.width}-rt${roundTripMs}-gap${gapMs}`;
      const { context, page, state } = await openContext(browser, origin, { scheme: "light", viewport, server: { twoDeciders: true, decisionDelayMs: roundTripMs, roundTripMs } });
      await twoDecidersReady(page);
      await sleep(300);
      const a = await approveCenter(page, runApproval.runId);
      await page.mouse.move(a.x, a.y);
      await page.mouse.down();
      await page.mouse.up();
      await sleep(gapMs);
      const under = await underPoint(page, a.x, a.y);
      await page.mouse.down();
      await page.mouse.up();
      await sleep(Math.max(900, roundTripMs * 3));
      check(`${tag} 같은 자리 두 번 누름 → 나간 결정 1건(A)`, state.decisions === 1 && state.decidedOrder[0] === approvals[0].id, { decisions: state.decisions, order: state.decidedOrder.map((x) => x.slice(-2)), under });
      if (roundTripMs === 100 && gapMs === 600) {
        const held = await page.evaluate((rid) => {
          const li = document.querySelector(`[data-testid="work-job-row"][data-job-id="${rid}"]`).closest('[data-testid="work-job"]');
          return { section: li.closest("[data-section]").getAttribute("data-section"), receipt: li.querySelector('[data-testid="work-job-approval-settled"]')?.textContent?.trim() ?? null };
        }, runApproval.runId);
        check(`${tag} 결정한 줄은 영수증을 보인 채 그 자리(포인터가 구간 안)`, held.section === "needsMe" && held.receipt === "승인을 기록했어요.", held);
        await shot(page, `5640-decided-held-${viewport.width}-light`);
      }
      await context.close();
    }
  }
}

/** Enter 연타: A의 「승인」에 초점을 두고 Enter를 거듭 친다. 나간 결정 1건, 초점은 다음 줄의 단추가 아니다. */
async function enterRepeatScene(browser, origin) {
  for (const roundTripMs of [40, 100, 300]) {
    const tag = `enter-repeat-rt${roundTripMs}`;
    const { context, page, state } = await openContext(browser, origin, { scheme: "light", viewport: { width: 1280, height: 800 }, server: { twoDeciders: true, decisionDelayMs: roundTripMs, roundTripMs } });
    await twoDecidersReady(page);
    await page.mouse.move(0, 0);
    await page.locator('[data-testid="work-job"]', { has: page.locator(`[data-job-id="${runApproval.runId}"]`) }).getByTestId("work-job-approval-approve").focus();
    const t0 = Date.now();
    for (const at of [0, 120, 320, 700, 1500]) {
      await sleep(Math.max(0, at - (Date.now() - t0)));
      await page.keyboard.press("Enter");
    }
    await sleep(900);
    const focus = await page.evaluate(() => ({ testid: document.activeElement?.getAttribute("data-testid") ?? null, job: document.activeElement?.closest('[data-testid="work-job"]')?.querySelector('[data-testid="work-job-row"]')?.getAttribute("data-job-id") ?? null }));
    check(`${tag} Enter 연타 → 나간 결정 1건, 초점은 결정 단추가 아니다`, state.decisions === 1 && focus.testid !== "work-job-approval-approve" && focus.testid !== "work-job-approval-reject", { decisions: state.decisions, focus });
    await context.close();
  }
}

/**
 * 결정 없이 줄이 포인터 밑에서 움직일 때: (a) 원장이 늦게 와서 「지금」의 줄이 「응답 필요」로 올라오고 카드 링크 자리에 「승인」이 선다,
 * (b) 서버의 「못 한다」가 늦게 와서 A가 빠지고 A의 「승인」 자리에 B의 「승인」이 선다. 포인터를 움직이지 않은 누름은 결정이 아니고,
 * 포인터를 움직인 뒤의 누름은 결정이다(보호가 모든 누름을 막지 않는다).
 */
async function shiftGuardScene(browser, origin) {
  // (a) 늦은 원장
  {
    const { context, page, state } = await openContext(browser, origin, { scheme: "light", viewport: { width: 1280, height: 800 }, server: { twoDeciders: true, ledgerDelayMs: 2500 } });
    await page.waitForFunction((rid) => document.querySelector(`[data-section="now"] [data-job-id="${rid}"]`) !== null, runApproval.runId);
    const link = await page.locator('[data-testid="work-job"]', { has: page.locator(`[data-job-id="${runApproval.runId}"]`) }).getByTestId("work-job-approval-link").boundingBox();
    const x = link.x + link.width / 2;
    const y = link.y + link.height / 2;
    await page.mouse.move(x, y);
    await twoDecidersReady(page);
    const under = await underPoint(page, x, y);
    await page.mouse.down();
    await page.mouse.up();
    await sleep(400);
    check("late-ledger 링크 자리에 결정 단추가 선다(재현 조건)", under.decision !== null, under);
    check("late-ledger 링크 자리에 선 결정 단추: 움직이지 않은 누름은 결정이 아니다", state.decisions === 0, { under, decisions: state.decisions });
    await page.mouse.move(x + 8, y);
    await page.mouse.move(x, y);
    const again = await underPoint(page, x, y);
    await page.mouse.down();
    await page.mouse.up();
    await sleep(400);
    check("late-ledger 포인터를 움직인 뒤의 누름은 결정이다", again.decision !== null && state.decisions === 1, { again, decisions: state.decisions });
    console.log(`MEASURE late-ledger: under=${JSON.stringify(under)} after-move=${JSON.stringify(again)} decisions=${state.decisions}`);
    await context.close();
  }
  // (b) 늦은 서버 거절
  {
    const { context, page, state } = await openContext(browser, origin, { scheme: "light", viewport: { width: 1280, height: 800 }, server: { twoDeciders: true, progress: { aCanDecide: false }, progressDelayMs: 1500 } });
    await twoDecidersReady(page);
    // 포인터를 A가 빠지면 B의 「승인」이 올 점에 둔다: B는 A의 줄 자리로 올라온다(그 위의 줄은 그대로).
    const tops = await page.evaluate((ids) => ids.map((rid) => document.querySelector(`[data-testid="work-job-row"][data-job-id="${rid}"]`).closest('[data-testid="work-job"]').getBoundingClientRect().top), [runApproval.runId, runApproval2.runId]);
    const b = await approveCenter(page, runApproval2.runId);
    const a = { x: b.x, y: tops[0] + (b.y - tops[1]) };
    await page.mouse.move(a.x, a.y);
    await page.waitForFunction((rid) => document.querySelector(`[data-section="needsMe"] [data-job-id="${rid}"]`) === null, runApproval.runId, { timeout: 10_000 });
    const under = await underPoint(page, a.x, a.y);
    await page.mouse.down();
    await page.mouse.up();
    await sleep(400);
    check("late-refusal A가 빠진 자리에 B의 「승인」이 선다(재현 조건)", under.decision === "approve" && under.job === runApproval2.runId, under);
    check("late-refusal A가 빠진 자리: 움직이지 않은 누름은 결정이 아니다", state.decisions === 0, { under, decisions: state.decisions });
    await page.mouse.move(a.x + 8, a.y);
    await page.mouse.move(a.x, a.y);
    const again = await underPoint(page, a.x, a.y);
    await page.mouse.down();
    await page.mouse.up();
    await sleep(400);
    check("late-refusal 포인터를 움직인 뒤의 누름은 결정이다", again.decision !== null && state.decisions === 1, { again, decisions: state.decisions });
    console.log(`MEASURE late-refusal: under=${JSON.stringify(under)} after-move=${JSON.stringify(again)} decisions=${state.decisions}`);
    await context.close();
  }
}

/** 브라우저에서 내 맥 세션 줄 Enter → 세션 화면(작업 콘솔). */
async function enterScene(browser, origin) {
  const { context, page } = await openContext(browser, origin, { scheme: "light", viewport: { width: 1280, height: 800 } });
  const row = page.locator(`[data-section="needsMe"] [data-job-id="${macWaiting.sessionId}"]`);
  await row.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction((sid) => window.location.hash.includes(`session=${sid}`), macWaiting.sessionId);
  const landed = await page.evaluate(() => window.location.hash);
  check("enter 브라우저: 세션 화면 주소", landed.includes(`session=${macWaiting.sessionId}`) && !landed.includes("card="), landed);
  await page.getByTestId("work-console-route").waitFor({ timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(400);
  await shot(page, "5640-enter-session-light");
  await context.close();
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  try {
    if (ONLY === "" || ONLY === "scenes") {
      for (const scheme of ["light", "dark"]) {
        for (const viewport of [{ width: 1280, height: 800 }, { width: 900, height: 800 }, { width: 390, height: 844 }]) {
          await scene(browser, preview.origin, scheme, viewport, `${viewport.width}-${scheme}`);
        }
      }
    }
    if (ONLY === "" || ONLY === "zoom") await zoomScene(browser, preview.origin);
    if (ONLY === "" || ONLY === "selected") {
      await selectedScene(browser, preview.origin, "light");
      await selectedScene(browser, preview.origin, "dark");
    }
    if (ONLY === "" || ONLY === "jump") {
      await jumpScene(browser, preview.origin, "light");
      await jumpScene(browser, preview.origin, "dark");
    }
    if (ONLY === "" || ONLY === "enter") await enterScene(browser, preview.origin);
    if (ONLY === "" || ONLY === "desktop") {
      await desktopScene(browser, preview.origin, "light");
      await desktopScene(browser, preview.origin, "dark");
    }
    if (ONLY === "" || ONLY === "decide") {
      await decideScene(browser, preview.origin, "light");
      await decideScene(browser, preview.origin, "dark");
    }
    if (ONLY === "" || ONLY === "h1" || ONLY === "double") {
      await doublePressScene(browser, preview.origin, { width: 1280, height: 800 });
      await doublePressScene(browser, preview.origin, { width: 390, height: 844 });
    }
    if (ONLY === "" || ONLY === "h1") await enterRepeatScene(browser, preview.origin);
    if (ONLY === "" || ONLY === "h1" || ONLY === "shift") await shiftGuardScene(browser, preview.origin);
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
