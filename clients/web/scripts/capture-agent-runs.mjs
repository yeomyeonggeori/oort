#!/usr/bin/env node
// =============================================================================
// 에이전트 작업 화면 캡처 (#3518 AT-5): 보드 카드·활동 「작업 끝남」·작업 상세.
//
//   npm run build && OUT_DIR=<dir> node scripts/capture-agent-runs.mjs
//
// 백엔드가 없다. 서버 쪽(AT-2/3/4/8)은 track/engine에만 있어서 `/v1/**`는 이 파일의 고정
// 응답이다(와이어 모양은 track/engine의 `work_board.rs`·`dto.rs`). **라이브 서버·실계정
// 동작은 runtime-unverified**다. 실시간 소켓은 곧바로 연결되는 흉내다.
// =============================================================================
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(homedir(), ".cache/momo-scratch/3518/captures");
const PORT = Number(process.env.CAPTURE_PORT || 5218);

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
  realtimeWebSocketUrl: "ws://agent-runs-capture.invalid/connection/websocket",
};
const ids = (n) => `00000000-0000-7000-8000-0000000000d${n}`;
const roster = [
  { id: agentId, workspaceId, kind: "agent", status: "active", displayName: "그록봇", handle: "grok-bot", channelCount: 2, channelIds: channels.map((c) => c.id), capabilities: [], ownerHumanId: memberId, createdAtMs: 0, updatedAtMs: 0 },
  { id: memberId, workspaceId, kind: "human", status: "active", role: "owner", displayName: "곽성재", handle: "seongjae", channelCount: 2, channelIds: channels.map((c) => c.id), capabilities: [], createdAtMs: 0, updatedAtMs: 0 },
];

const NOW = Date.now();
const sec = Math.floor(NOW / 1000);
const none = { added: null, deleted: null, files: null, ahead: null, behind: null, uncommitted: null };
const requester = { memberId, displayName: "곽성재" };
const owner = { memberId: agentId, displayName: "그록봇" };
const runBase = { source: "run", requestedBy: requester, origin: "agent_run", folderLabel: null, owner, homeChannel: { id: lab.id, name: "agent-lab" }, startedAtMs: NOW - 900_000, sharedAtMs: null, repo: null, harness: "hosted" };
const boardRows = [
  { ...runBase, runId: ids(1), label: "온보딩 문구 다듬기", status: "running", state: "running", endedAtMs: null, branch: "feat/onboarding-copy", stages: ["코드 읽는 중", "문구 고치는 중"], stepCount: 2, commits: null, diff: none, prUrl: null, lastActivityAt: sec - 90 },
  { ...runBase, runId: ids(2), label: "릴리스 노트 초안", status: "waiting", state: "waiting", endedAtMs: null, branch: null, stages: [], stepCount: 0, commits: null, diff: none, prUrl: null, lastActivityAt: sec - 40 },
  { ...runBase, runId: ids(3), label: "푸시 중복 수리", status: "done", state: "done", endedAtMs: NOW - 300_000, branch: "fix/push-dup", stages: ["원인 찾는 중", "고치는 중", "PR 올림"], stepCount: 3, commits: 2, diff: { ...none, added: 42, deleted: 18 }, pr: { url: "https://github.com/yeomyeonggeori/oort/pull/3521", number: 3521 }, prUrl: "https://github.com/yeomyeonggeori/oort/pull/3521", lastActivityAt: sec - 300 },
  { ...runBase, runId: ids(4), label: "의존성 점검", status: "failed", state: "failed", endedAtMs: NOW - 600_000, branch: "chore/deps", stages: ["의존성 읽는 중"], stepCount: 1, commits: null, diff: none, prUrl: null, lastActivityAt: sec - 600 },
].map((r) => ({ ...r, sessionId: undefined }));
const sessionRow = { source: "session", sessionId: "00000000-0000-7000-8000-0000000000a1", origin: "local_pty", label: "한글 입력 이중 전송 수리", folderLabel: "momo", status: "running", owner: requester, homeChannel: { id: channels[0].id, name: "workbench" }, startedAtMs: NOW - 3_600_000, endedAtMs: null, sharedAtMs: NOW - 3_000_000, repo: "momo", branch: "feat/2774-xterm", harness: "claude", state: "waiting", stages: ["세션 시작", "작업 중", "실행 허락 기다림"], diff: { added: 128, deleted: 40, files: 9, ahead: 2, behind: 0, uncommitted: 1 }, prUrl: null, lastActivityAt: sec - 180 };

const runWire = (id, title, status, output, extra = {}) => ({
  id, workspaceId, agentMemberId: agentId, channelId: lab.id, status, stepCount: output?.stages?.length ?? 0, maxSteps: 12, depth: 0,
  input: { type: "work", title, brief: "온보딩 화면의 문구를 해요체로 통일해 주세요." }, ...(output ? { output } : {}),
  startedAtMs: NOW - 900_000, ...extra, createdAtMs: NOW - 900_000, updatedAtMs: NOW - 300_000,
});
const doneOutput = { stages: ["원인 찾는 중", "고치는 중", "PR 올림"], artifacts: { prUrl: "https://github.com/yeomyeonggeori/oort/pull/3521", branch: "fix/push-dup", added: 42, deleted: 18, commits: 2 } };
const runs = [
  runWire(ids(3), "푸시 중복 수리", "succeeded", doneOutput, { finishedAtMs: NOW - 300_000 }),
  runWire(ids(4), "의존성 점검", "failed", { stages: ["의존성 읽는 중"] }, { finishedAtMs: NOW - 600_000 }),
  runWire(ids(1), "온보딩 문구 다듬기", "running", { stages: ["코드 읽는 중", "문구 고치는 중"] }),
];

const failures = [];
function check(name, ok, detail) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
  if (!ok) failures.push(name);
}
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function installRoutes(context) {
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
      const withRuns = url.searchParams.get("include") === "runs";
      return json(route, { sessions: withRuns ? [sessionRow, ...boardRows] : [sessionRow], nextCursor: null });
    }
    if (path.endsWith("/work-sessions")) return json(route, { workSessions: [] });
    if (path.endsWith(`/agents/${agentId}/runs`)) return json(route, { runs: runs.map((r) => ({ id: r.id, channelId: r.channelId, triggerSummary: r.input.title, status: r.status, startedAtMs: r.startedAtMs, finishedAtMs: r.finishedAtMs, createdAtMs: r.createdAtMs, updatedAtMs: r.updatedAtMs })) });
    const detail = /\/agent-runs\/([0-9a-f-]+)$/.exec(path);
    if (detail) return json(route, runs.find((r) => r.id === detail[1]) ?? {}, runs.some((r) => r.id === detail[1]) ? 200 : 404);
    if (path.endsWith("/agent-runs")) return json(route, { runs: path.includes(lab.id) ? runs : [] });
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
  await page.getByTestId("nav-team").waitFor({ timeout: 20_000 });
}
const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const shot = (page, name) => page.screenshot({ path: resolve(OUT_DIR, `${name}.png`) });

async function scene(browser, origin, scheme, viewport) {
  const tag = `${viewport.width}-${scheme}`;
  const context = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion: "reduce", serviceWorkers: "block" });
  await installRoutes(context);
  const page = await context.newPage();
  await installRealtime(page);
  await signIn(page, origin);

  // 보드: 지금(돌고 있는 실행 둘 + 세션 하나)
  await page.goto(`${origin}/#/work?view=team`);
  await page.getByTestId("team-work-route").waitFor();
  await page.getByTestId("team-board-row").first().waitFor();
  const nowRows = await page.getByTestId("team-board-row").count();
  check(`${tag} 보드 「지금」: 세션 1 + 실행 2`, nowRows === 3, nowRows);
  check(`${tag} 보드: 실행 줄 2개`, (await page.locator('[data-source="run"]').count()) === 2);
  check(`${tag} 보드: 가로 넘침 0`, (await overflowX(page)) === 0, await overflowX(page));
  await shot(page, `board-now-${tag}`);

  // 오늘 끝난 것: 끝난 실행(PR 링크)과 실패
  await page.getByTestId("team-board-view-done").click();
  await page.getByTestId("team-board-row-pr").waitFor();
  const href = await page.getByTestId("team-board-row-pr").getAttribute("href");
  check(`${tag} 보드 카드: PR 링크가 https 주소다`, href === "https://github.com/yeomyeonggeori/oort/pull/3521", href);
  check(`${tag} 보드: 가로 넘침 0(끝난 것)`, (await overflowX(page)) === 0);
  await shot(page, `board-done-${tag}`);

  // 상세: 끝난 실행의 드로어
  await page.locator('[data-source="run"]', { hasText: "푸시 중복 수리" }).first().click();
  await page.getByTestId("team-board-drawer").waitFor();
  await page.waitForTimeout(200);
  const stages = await page.getByTestId("team-board-stages").innerText();
  check(`${tag} 상세: 단계 목록`, stages.includes("원인 찾는 중") && stages.includes("PR 올림"), stages);
  check(`${tag} 상세: 가로 넘침 0`, (await overflowX(page)) === 0);
  await shot(page, `run-detail-drawer-${tag}`);
  await page.keyboard.press("Escape");

  // 활동 「작업 끝남」
  await page.goto(`${origin}/#/activity`);
  await page.getByTestId("activity-route").waitFor();
  await page.getByTestId("activity-tab-done").click();
  await page.waitForTimeout(800);
  const rows = await page.$$eval("[data-testid='activity-list'] > li", (e) => e.map((x) => x.textContent ?? ""));
  check(`${tag} 활동 「작업 끝남」: 끝난 호스팅 실행 2건, 마지막 단계·PR이 보인다`, rows.length === 2 && rows.some((t) => t.includes("PR 올림 · PR #3521")), rows);
  check(`${tag} 활동: 가로 넘침 0`, (await overflowX(page)) === 0);
  await shot(page, `activity-done-${tag}`);

  // 작업 상세(에이전트 허브의 실행 기록)
  await page.goto(`${origin}/#/agents?agent=${agentId}`);
  await page.waitForTimeout(800);
  await page.getByText("이력", { exact: true }).first().click();
  await page.waitForTimeout(800);
  const opener = page.getByText("푸시 중복 수리").first();
  if (await opener.count()) {
    await opener.click();
    await page.getByTestId("run-report").waitFor({ timeout: 8000 }).catch(() => undefined);
    const has = (await page.getByTestId("run-report").count()) > 0;
    check(`${tag} 작업 상세: 단계·결과 구역`, has);
    if (has) {
      const pr = await page.getByTestId("run-report-pr").getAttribute("href");
      check(`${tag} 작업 상세: PR 링크`, pr === "https://github.com/yeomyeonggeori/oort/pull/3521", pr);
      check(`${tag} 작업 상세: 가로 넘침 0`, (await overflowX(page)) === 0);
    }
    await shot(page, `run-detail-dialog-${tag}`);
  } else {
    check(`${tag} 작업 상세: 허브에서 실행 기록 줄을 찾았다`, false);
    await shot(page, `run-detail-dialog-MISSING-${tag}`);
  }
  await context.close();
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  try {
    for (const scheme of ["light", "dark"]) {
      for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
        await scene(browser, preview.origin, scheme, viewport);
      }
    }
  } finally {
    await browser.close();
    await preview.stop?.();
  }
  if (failures.length > 0) { console.error(`\n${failures.length}개 단언 실패`); process.exit(1); }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
