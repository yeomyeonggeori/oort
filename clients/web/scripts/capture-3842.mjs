#!/usr/bin/env node
// =============================================================================
// 「작업」 한 화면 캡처 (ADR-0202 U1 #3842): 내 것·팀 전체·서랍(에이전트 보고)·승인 대기 줄·
// 옛 서버 물러서기·사이드바 한 줄·접힌 레일, 1440/390 × 라이트/다크.
//
//   npm run build && OUT_DIR=<dir> node scripts/capture-3842.mjs
//
// 백엔드가 없다. `/v1/**`는 이 파일의 고정 응답이다. 새 서버 모드는 E1이 지킬 계약(`include=runs,jobs`·
// `who` 되울림·run 줄의 `trigger`·`phase`·`agentReported`)을 흉내 내고, 옛 서버 모드는 배포된
// `work_board.rs`처럼 `include`가 정확히 `runs`일 때만 run 줄을 준다. **라이브 서버 동작은
// runtime-unverified**다.
// =============================================================================
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(homedir(), ".cache/momo-scratch/3842/captures");
const PORT = Number(process.env.CAPTURE_PORT || 5242);

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const agentId = "00000000-0000-7000-8000-000000000301";
const channels = [
  { id: "00000000-0000-7000-8000-000000000201", workspaceId, kind: "public", name: "workbench", muted: false },
  { id: "00000000-0000-7000-8000-000000000202", workspaceId, kind: "public", name: "agent-lab", muted: false },
];
const lab = channels[1];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: "ws://work-3842-capture.invalid/connection/websocket",
};
const ids = (n) => `00000000-0000-7000-8000-0000000000d${n}`;
const other = { memberId: "00000000-0000-7000-8000-000000000102", displayName: "김민지" };
const roster = [
  { id: agentId, workspaceId, kind: "agent", status: "active", displayName: "그록봇", handle: "grok-bot", channelCount: 2, channelIds: channels.map((c) => c.id), capabilities: [], ownerHumanId: memberId, createdAtMs: 0, updatedAtMs: 0 },
  { id: memberId, workspaceId, kind: "human", status: "active", role: "owner", displayName: "곽성재", handle: "seongjae", channelCount: 2, channelIds: channels.map((c) => c.id), capabilities: [], createdAtMs: 0, updatedAtMs: 0 },
];

const NOW = Date.now();
const sec = Math.floor(NOW / 1000);
const none = { added: null, deleted: null, files: null, ahead: null, behind: null, uncommitted: null };
const me = { memberId, displayName: "곽성재" };
const grok = { memberId: agentId, displayName: "그록봇" };
const runBase = { source: "run", requestedBy: me, origin: "agent_run", folderLabel: null, owner: grok, homeChannel: { id: lab.id, name: "agent-lab" }, sharedAtMs: null, repo: null, harness: "hosted", diff: none, stages: [] };
const mineRows = [
  { ...runBase, runId: ids(1), label: "#launch 채널에 v0.1.26 공지 올리기", status: "running", state: "running", phase: "awaiting_approval", trigger: "mention", startedAtMs: NOW - 240_000, endedAtMs: null, branch: null, stepCount: 1, prUrl: null, lastActivityAt: sec - 60 },
  { ...runBase, runId: ids(2), label: "온보딩 문구 해요체로 다듬기", status: "running", state: "running", phase: "running", trigger: "work", startedAtMs: NOW - 12 * 60_000, endedAtMs: null, branch: "feat/onboarding-copy", stages: ["코드 읽기", "문구 고치기"], stepCount: 2, prUrl: null, lastActivityAt: sec - 90 },
  { ...runBase, runId: ids(3), label: "푸시 알림이 두 번 오는 문제 고치기", status: "done", state: "done", phase: "succeeded", trigger: "work", startedAtMs: NOW - 31 * 60_000, endedAtMs: NOW - 6 * 60_000, branch: "fix/push-dup", stages: ["원인 찾기", "고치기", "PR 열기"], stepCount: 3, commits: 2, diff: { ...none, added: 42, deleted: 18 }, pr: { url: "https://github.com/yeomyeonggeori/oort/pull/3521", number: 3521 }, prUrl: "https://github.com/yeomyeonggeori/oort/pull/3521", lastActivityAt: sec - 360,
    agentReported: { resultKind: "pr_opened", tests: { passed: 128, failed: 0, notRun: 3 }, nextAction: "merge_ok", commitSha: "9f3c2a1b7e", toolCounts: { run: 14, edit: 6, read: 41 } } },
  { ...runBase, runId: ids(4), label: "의존성 라이선스 점검", status: "done", state: "done", phase: "succeeded", trigger: "thread_reply", startedAtMs: NOW - 70 * 60_000, endedAtMs: NOW - 58 * 60_000, branch: null, stepCount: 1, prUrl: null, lastActivityAt: sec - 3480,
    agentReported: { resultKind: "no_change", tests: { passed: 0, failed: 0, notRun: 0 }, nextAction: "none" } },
].map((r) => ({ ...r, sessionId: undefined }));
const teamRows = [
  ...mineRows,
  { source: "session", sessionId: "00000000-0000-7000-8000-0000000000a1", origin: "local_pty", label: "결제 웹훅 재시도 고치기", folderLabel: "oort", status: "running", owner: other, homeChannel: { id: channels[0].id, name: "workbench" }, startedAtMs: NOW - 47 * 60_000, endedAtMs: null, sharedAtMs: NOW - 40 * 60_000, repo: "oort", branch: "fix/webhook-retry", harness: "claude", state: "waiting", stages: ["세션 시작", "실행 허락 기다림"], diff: { added: 88, deleted: 12, files: 4, ahead: 1, behind: 0, uncommitted: 2 }, prUrl: null, lastActivityAt: sec - 200 },
  { ...runBase, runId: ids(5), requestedBy: other, label: "릴리스 노트 초안 쓰기", status: "failed", state: "failed", phase: "failed", trigger: "work", startedAtMs: NOW - 95 * 60_000, endedAtMs: NOW - 80 * 60_000, branch: null, stepCount: 1, prUrl: null, lastActivityAt: sec - 4800, sessionId: undefined },
];
// 옛 서버: include=runs면 호스팅 run 줄(새 필드 없음)까지, 아니면 세션 줄만.
const legacyRows = teamRows.map((row) => {
  const rest = { ...row };
  delete rest.phase;
  delete rest.trigger;
  delete rest.agentReported;
  return rest;
});

const failures = [];
function check(name, ok, detail) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
  if (!ok) failures.push(name);
}
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function installRoutes(context, mode) {
  await context.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId });
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/approvals")) return json(route, { approvals: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: [] });
    if (path.endsWith("/work-sessions/shared")) {
      const include = url.searchParams.get("include");
      const who = url.searchParams.get("who");
      if (mode === "jobs" && include === "runs,jobs" && (who === "mine" || who === "team")) {
        return json(route, { sessions: who === "mine" ? mineRows : teamRows, nextCursor: null, who });
      }
      return json(route, { sessions: include === "runs" ? legacyRows : legacyRows.filter((r) => r.source === "session"), nextCursor: null });
    }
    if (/\/work-sessions\/[^/]+\/shared$/.test(path)) return json(route, { error: { message: "shared work session not found" } }, 404);
    if (path.endsWith("/work-sessions")) return json(route, { workSessions: [] });
    if (path.endsWith(`/workspaces/${workspaceId}`)) return json(route, { workspace: { id: workspaceId, name: "여명거리" } });
    if (path.includes("/messages")) return json(route, { messages: [] });
    return json(route, {});
  });
}

async function installRealtime(page) {
  await page.addInitScript(() => {
    class CaptureSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      constructor(url) { this.url = String(url); this.readyState = 0; queueMicrotask(() => { this.readyState = 1; this.onopen?.(new Event("open")); }); }
      send(data) {
        const replies = String(data).trim().split("\n").map((line) => {
          const c = JSON.parse(line);
          if (c.connect) return { id: c.id, connect: { client: "agent-runs-capture", version: "6" } };
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
// #3850 리뷰(ADR-0112 D6): 보이는 줄의 제목·결과 글이 한 글자라도 잘리면 그 글을 돌려준다.
// 잘림 = 상자보다 글이 넓거나(한 줄 말줄임) 높다(줄 수 제한). 숨은 열(display:none)은 세지 않는다.
const clippedText = (page) =>
  page.evaluate(() => {
    const nodes = document.querySelectorAll(
      '[data-testid="work-job-row"] [data-col="task"] > span:first-child, [data-testid="work-job-result"], [data-testid="work-job-result"] > span'
    );
    const out = [];
    for (const el of nodes) {
      if (el.getClientRects().length === 0) continue;
      if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) out.push((el.textContent ?? "").trim());
    }
    return out;
  });
const shot = (page, name) => page.screenshot({ path: resolve(OUT_DIR, `${name}.png`) });
const shots = [];

async function scene(browser, origin, scheme, viewport, mode) {
  const tag = `${viewport.width}-${scheme}${mode === "legacy" ? "-legacy" : ""}`;
  const narrow = viewport.width < 700;
  const context = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion: "reduce", serviceWorkers: "block" });
  await installRoutes(context, mode);
  const page = await context.newPage();
  await installRealtime(page);
  await signIn(page, origin);
  const save = async (name) => { await shot(page, name); shots.push(`${name}.png`); };

  if (!narrow && mode === "jobs") {
    // 사이드바: 「에이전트·작업」 묶음이 AI · 에이전트 · 작업 셋이다.
    const labels = await page.$$eval('[data-testid="sidebar-section-agent-work"] a', (as) => as.map((a) => (a.textContent ?? "").replace(/\d+$/, "").trim()));
    check(`${tag} 사이드바: AI · 에이전트 · 작업`, JSON.stringify(labels.slice(0, 3)) === JSON.stringify(["AI", "에이전트", "작업"]), labels);
    for (const id of ["nav-mine", "nav-team", "nav-activity", "nav-work-console", "nav-workstreams"]) {
      check(`${tag} 사이드바: ${id} 없음`, (await page.getByTestId(id).count()) === 0);
    }
  }

  await page.goto(`${origin}/#/work`);
  await page.getByTestId("work-jobs-route").waitFor();
  await page.getByTestId("work-job-row").first().waitFor();
  check(`${tag} 기본 필터 「내 것」`, (await page.getByTestId("work-jobs-route").getAttribute("data-filter")) === "mine");
  const mine = await page.getByTestId("work-job-row").count();
  check(`${tag} 내 것 줄 수`, mine === (mode === "legacy" ? 4 : 4), mine);
  const running = await page.getByTestId("work-jobs-running").innerText();
  check(`${tag} 지금 진행`, /지금 진행 2/.test(running), running);
  check(`${tag} 가로 넘침 0(내 것)`, (await overflowX(page)) === 0, await overflowX(page));
  check(`${tag} 제목·결과 잘림 0(내 것)`, (await clippedText(page)).length === 0, await clippedText(page));
  if (mode === "jobs") {
    check(`${tag} 승인 대기 줄이 맨 위·카드 링크`, (await page.getByTestId("work-job-row").first().getAttribute("data-approval")) === "" && (await page.getByTestId("work-job-approval-link").count()) === 1);
    check(`${tag} 에이전트 보고 꼬리표`, (await page.getByTestId("work-job-reported-tag").count()) >= 1);
  } else {
    check(`${tag} 옛 서버 안내`, (await page.getByTestId("work-jobs-legacy").count()) === 1);
  }
  await save(`work-mine-${tag}`);

  await page.getByTestId("work-jobs-filter-team").click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="work-job-row"]').length === 6);
  check(`${tag} 팀 전체 6줄`, (await page.getByTestId("work-job-row").count()) === 6);
  check(`${tag} 가로 넘침 0(팀 전체)`, (await overflowX(page)) === 0, await overflowX(page));
  check(`${tag} 제목·결과 잘림 0(팀 전체)`, (await clippedText(page)).length === 0, await clippedText(page));
  await save(`work-team-${tag}`);

  if (mode === "jobs") {
    await page.locator('[data-testid="work-job-row"]', { hasText: "푸시 알림이 두 번 오는 문제 고치기" }).click();
    await page.getByTestId("team-board-drawer").waitFor();
    await page.waitForTimeout(200);
    const reported = await page.getByTestId("work-job-reported").innerText();
    check(`${tag} 서랍: 에이전트 보고 칸`, reported.includes("테스트 통과 128") && reported.includes("머지해도 된대요"), reported);
    if (viewport.width >= 1400) {
      // 1400 아래에서는 서랍이 목록 자리를 통째로 쓴다(team-board-layout). 그 위에서만 나란히 선다.
      // design-review B-1: 서랍이 열리면 목록 상자 폭으로 접어 결과는 첫 열 셋째 줄로 내려간다.
      const resultCol = await page.locator('[data-testid="work-job-row"] > [data-col="result"]').first().evaluate((el) => getComputedStyle(el).display);
      const narrowLine = await page.locator('[data-testid="work-job-row"] [data-narrow]').first().evaluate((el) => getComputedStyle(el).display);
      check(`${tag} 서랍 열림: 결과 열 접힘·셋째 줄로`, resultCol === "none" && narrowLine === "flex", { resultCol, narrowLine });
    }
    check(`${tag} 가로 넘침 0(서랍)`, (await overflowX(page)) === 0);
    check(`${tag} 제목·결과 잘림 0(서랍)`, (await clippedText(page)).length === 0, await clippedText(page));
    await save(`work-drawer-${tag}`);
    await page.keyboard.press("Escape");
    await page.locator('[data-testid="work-job-row"]', { hasText: "v0.1.26 공지" }).click();
    await page.getByTestId("team-board-drawer").waitFor();
    await page.waitForTimeout(200);
    await save(`work-drawer-approval-${tag}`);
    await page.keyboard.press("Escape");

    // 옛 팀 링크 → 팀 전체
    await page.goto(`${origin}/#/work?view=team`);
    await page.getByTestId("work-jobs-route").waitFor();
    check(`${tag} ?view=team → 팀 전체`, (await page.getByTestId("work-jobs-route").getAttribute("data-filter")) === "team");
  }
  if (!narrow && mode === "jobs") {
    // 접힌 레일(⌘B): 대화 · 인박스 · 에이전트 · 작업
    await page.goto(`${origin}/#/work`);
    await page.getByTestId("work-jobs-route").waitFor();
    await page.keyboard.press("Meta+b");
    await page.waitForTimeout(400);
    const rail = await page.$$eval('[data-testid="workspace-rail"] nav[aria-label="앱 탐색"] a', (as) => as.map((a) => a.getAttribute("data-testid")));
    check(`${tag} 접힌 레일 네 목적지`, JSON.stringify(rail) === JSON.stringify(["rail-chat", "rail-inbox", "rail-agents", "rail-work"]), rail);
    await save(`work-rail-collapsed-${tag}`);
  }
  await context.close();
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  try {
    for (const scheme of ["light", "dark"]) {
      for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 390, height: 844 }]) {
        await scene(browser, preview.origin, scheme, viewport, "jobs");
      }
    }
    await scene(browser, preview.origin, "light", { width: 1440, height: 900 }, "legacy");
  } finally {
    await browser.close();
    await preview.stop?.();
  }
  console.log(`\n${shots.length} captures in ${OUT_DIR}`);
  if (failures.length > 0) { console.error(`\n${failures.length}개 단언 실패`); process.exit(1); }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
