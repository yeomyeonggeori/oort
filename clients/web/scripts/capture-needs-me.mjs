#!/usr/bin/env node
// =============================================================================
// #3337 인박스/활동 역할 분리 + 「나에게 필요한 일」 수 캡처.
//
//   npm run build && OUT_DIR=~/.cache/momo-scratch/3337/captures node scripts/capture-needs-me.mjs
//   → 1280 × light·dark: 인박스(결정 대기·멘션·리마인더 탭, 에이전트 탭 없음, 활동 링크),
//     활동(필터 칩 네 개 + 각 칩), 레일 인박스 배지(승인 2 + 응답 필요 칸 1 + 멘션 2 = 5).
//
// 백엔드는 없다: `/v1/**`는 고정 응답, 실시간 소켓은 곧바로 연결되는 흉내, 데스크탑은
// `window.__TAURI_INTERNALS__` 흉내(capture-work-tab.mjs와 같은 모양, 세션은 셸이 쥔
// 핸들만 답하는 #3106 모양)다. 기준선(전)은 같은 스크립트를 base 워크트리에서 돌린다.
// =============================================================================

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/needs-me");
const PORT = Number(process.env.CAPTURE_PORT || 5203);

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const channels = [
  { id: "00000000-0000-7000-8000-000000000201", workspaceId, kind: "public", name: "workbench", muted: false },
  { id: "00000000-0000-7000-8000-000000000202", workspaceId, kind: "public", name: "agent-lab", muted: false },
  { id: "00000000-0000-7000-8000-000000000203", workspaceId, kind: "public", name: "general", muted: false },
  { id: "00000000-0000-7000-8000-000000000204", workspaceId, kind: "private", name: "design-2.0", muted: false },
];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: "ws://work-tab-capture.invalid/connection/websocket",
};
const agentId = "00000000-0000-7000-8000-000000000301";
const otherId = "00000000-0000-7000-8000-000000000102";
const otherAgentId = "00000000-0000-7000-8000-000000000302";
const NOW = Date.now();
const roster = [
  {
    id: agentId, workspaceId, kind: "agent", status: "active", displayName: "김인턴", handle: "kim-intern",
    channelCount: 4, channelIds: channels.map((c) => c.id), capabilities: [], ownerHumanId: memberId,
    createdAtMs: 0, updatedAtMs: 0,
  },
  {
    id: otherAgentId, workspaceId, kind: "agent", status: "active", displayName: "새벽봇", handle: "dawn-bot",
    channelCount: 4, channelIds: channels.map((c) => c.id), capabilities: [], ownerHumanId: otherId,
    createdAtMs: 0, updatedAtMs: 0,
  },
  {
    id: otherId, workspaceId, kind: "human", status: "active", role: "member", displayName: "서연", handle: "seoyeon",
    channelCount: 4, channelIds: channels.map((c) => c.id), capabilities: [], createdAtMs: 0, updatedAtMs: 0,
  },
  {
    id: memberId, workspaceId, kind: "human", status: "active", role: "owner", displayName: "곽성재",
    handle: "seongjae", channelCount: 4, channelIds: channels.map((c) => c.id), capabilities: [],
    createdAtMs: 0, updatedAtMs: 0,
  },
];

const approval = (id, status, minutesAgo, tool) => ({
  id, workspace_id: workspaceId, run_id: `run-${id}`, channel_id: channels[0].id, requested_by: agentId,
  action_type: "tool_call", status, expires_at_ms: NOW + 3_600_000, created_at_ms: NOW - minutesAgo * 60_000,
  payload: { tool_call: { name: tool } },
});
const approvals = {
  pending: [approval("ap-1", "pending", 5, "work.session.end"), approval("ap-2", "pending", 12, "shell.exec")],
  approved: [
    { ...approval("ap-3", "approved", 60, "file.write"), decided_at_ms: NOW - 3_000_000, decided_by: memberId },
    // 담당이 다른 에이전트(서연의 새벽봇): 「내 에이전트」 칩에서는 빠져야 한다.
    { ...approval("ap-4", "approved", 90, "file.write"), requested_by: otherAgentId, decided_at_ms: NOW - 5_000_000, decided_by: otherId },
  ],
};
const runs = [
  { id: "r-1", workspaceId, agentMemberId: agentId, channelId: channels[0].id, status: "succeeded", stepCount: 6, maxSteps: 20, input: { type: "work", title: "주간 리포트 초안" }, startedAtMs: NOW - 900_000, finishedAtMs: NOW - 600_000, createdAtMs: NOW - 900_000, updatedAtMs: NOW - 600_000 },
  { id: "r-3", workspaceId, agentMemberId: otherAgentId, channelId: channels[0].id, status: "succeeded", stepCount: 4, maxSteps: 20, input: { type: "work", title: "온보딩 카피 정리" }, startedAtMs: NOW - 2_000_000, finishedAtMs: NOW - 1_800_000, createdAtMs: NOW - 2_000_000, updatedAtMs: NOW - 1_800_000 },
  { id: "r-2", workspaceId, agentMemberId: agentId, channelId: channels[0].id, status: "running", stepCount: 2, maxSteps: 20, input: { type: "work", title: "배포 스크립트 점검" }, startedAtMs: NOW - 120_000, createdAtMs: NOW - 120_000, updatedAtMs: NOW - 60_000 },
];

// #3279 칸 크롬 캡처(전/후 비교용). 3칸 분할 + 「응답 필요」 칸 하나.
// 3칸: 왼쪽 p1, 오른쪽 위 p2, 오른쪽 아래 p3.
const LAYOUT_3 = {
  v: 1,
  root: {
    kind: "split", id: "s20", axis: "row", ratio: 0.5,
    first: { kind: "pane", id: "p1" },
    second: { kind: "split", id: "s21", axis: "column", ratio: 0.5, first: { kind: "pane", id: "p2" }, second: { kind: "pane", id: "p3" } },
  },
  focused: "p1",
  maximized: null,
  seq: 30,
};

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function installRoutes(context) {
  await context.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId });
    }
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/read-state")) {
      return json(route, { read_states: [{ channel_id: channels[0].id, last_read_seq: 4, latest_seq: 9, unread_count: 5, mention_count: 2 }] });
    }
    if (path.endsWith("/approvals")) {
      const status = new URL(route.request().url()).searchParams.get("status") ?? "pending";
      return json(route, { approvals: approvals[status] ?? [] });
    }
    if (path.endsWith("/agent-runs")) return json(route, { runs: path.includes(channels[0].id) ? runs : [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: [] });
    if (path.endsWith("/work-sessions")) return json(route, { workSessions: [] });
    if (path.endsWith(`/workspaces/${workspaceId}`)) return json(route, { workspace: { id: workspaceId, name: "여명거리" } });
    if (path.includes("/messages")) {
      // 멘션 탭의 수(read-state 2)와 목록이 같아야 한다: 안 읽은 구간(seq 5~9)의 멘션 두 건.
      if (!path.includes(channels[0].id)) return json(route, { messages: [] });
      const mention = (id, seq, text) => ({
        id, channelId: channels[0].id, seq, hlcTs: NOW - 60_000 * seq, hlcCount: 0, authorMemberId: otherId, type: "text",
        body: text, text, createdAtMs: NOW - 60_000 * (10 - seq), props: { mention_member_ids: [memberId] },
      });
      return json(route, { messages: [mention("m-1", 8, "@seongjae 배포 전에 한번 봐 주세요"), mention("m-2", 9, "@seongjae 리뷰 코멘트 반영했어요")] });
    }
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
        queueMicrotask(() => { this.readyState = 1; this.onopen?.(new Event("open")); });
      }
      send(data) {
        const replies = String(data).trim().split("\n").map((line) => {
          const c = JSON.parse(line);
          if (c.connect) return { id: c.id, connect: { client: "work-tab-capture", version: "6" } };
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

/** 데스크탑 셸 흉내. PTY는 칸마다 짧은 셸 출력을 내고, 나머지 명령은 빈 답이다. */
async function installDesktop(page, layout, signals = null) {
  await page.addInitScript(
    ({ layout, signals }) => {
      try {
        localStorage.setItem("momo.web.workbench.layout.v1:dock", JSON.stringify(layout));
      } catch {
        /* 저장소 없는 캡처 */
      }
      const callbacks = new Map();
      let nextCallback = 1;
      let nextPty = 1;
      const enc = new TextEncoder();
      // 시안 ①의 여덟 칸: 작업 이름(OSC 제목)과 worktree. PTY 번호는 칸 순서(1~8)다.
      const titles = ["격자 리뷰", null, "한글 입력 수리", "한글 조합 중 ⌃` 키가 터미널로 새지 않는지 회귀 시험", "relay 중복 발행", "PR #2851 열림", "프리셋 스파이크", "cargo test"];
      const folders = ["momo", "momo", "2774-xterm", "2774-xterm", "push-dup", "push-dup", "presets", "presets"];
      const branches = { momo: "main", "2774-xterm": "feat/2774-xterm", "push-dup": "fix/push-dup", presets: "spike/workbench-layout-presets-5x2" };
      const diffs = { "2774-xterm": [128, 40], "push-dup": [42, 18], presets: [9, 2] };
      const worktrees = Object.keys(branches).map((folder) => ({ folder, branch: branches[folder], detached: false, locked: false, prunable: false }));
      const scripts = [
        ["\x1b[32m~/momo\x1b[0m \x1b[34mmain\x1b[0m \x1b[2m✓\x1b[0m", "\x1b[36m❯\x1b[0m git worktree list", "\x1b[2m~/momo            824b909e [main]\x1b[0m", "\x1b[2m…/feat-2774-xterm  a13f2c0 [feat/2774…]\x1b[0m", "\x1b[36m❯\x1b[0m "],
        ["\x1b[38;2;215;119;87m✻\x1b[0m Reviewing WorkbenchGrid.tsx…", "\x1b[2m  ⎿ Read 706 lines\x1b[0m", "", "\x1b[38;2;215;119;87m●\x1b[0m The split refusal at 240px", "  holds; fitLayout keeps the", "  focused pane."],
        ["\x1b[35mcodex\x1b[0m \x1b[2mgpt-5.6 · workspace-write\x1b[0m", "", "\x1b[36m•\x1b[0m Ran vitest \x1b[2m(filter ime)\x1b[0m", "  \x1b[32m✓ 9 passed\x1b[0m  \x1b[31m✗ 1 failed\x1b[0m", "\x1b[2m  Working (1m 12s)\x1b[0m"],
        ["\x1b[36m❯\x1b[0m cargo test -p momo-core", "\x1b[2m   Compiling momo-core v0.1.5\x1b[0m", "test layout::fit ... \x1b[32mok\x1b[0m", "test layout::min ... \x1b[32mok\x1b[0m", "test preset::5x2 ... \x1b[33mrunning\x1b[0m"],
      ];
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
      window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
        transformCallback(callback) {
          const id = nextCallback++;
          callbacks.set(id, callback);
          return id;
        },
        unregisterCallback(id) {
          callbacks.delete(id);
        },
        convertFileSrc: (p) => p,
        async invoke(cmd, args) {
          if (cmd === "pty_spawn") {
            const id = nextPty++;
            const out = callbacks.get(args.onOutput.id);
            const title = titles[(id - 1) % titles.length];
            const text = (title ? `\x1b]0;${title}\x07` : "") + scripts[(id - 1) % scripts.length].join("\r\n");
            const bytes = enc.encode(text);
            setTimeout(() => out?.({ index: 0, message: bytes.buffer.slice(0) }), 30);
            // 칸 6(시안 「PR #2851 열림」)은 코드 0으로 끝난다(「끝남」). 목록이 git을 먼저
            // 읽도록 조금 뒤에 끝낸다(끝난 칸은 셸이 git 읽기를 거절한다).
            if (id === 6 && !signals) {
              const exit = callbacks.get(args.onExit.id);
              setTimeout(() => exit?.({ index: 0, message: { id, code: 0, signal: null } }), 900);
            }
            // #2776: 하네스 hook 신호(데스크탑 셸이 소켓에서 받아 채널로 준 닫힌 목록).
            // 칸이 PTY를 띄우는 순서는 미러 청크 로딩에 따라 달라서, 캡처가 칸 머리의
            // 제목(= PTY 번호)으로 칸을 찾아 `__captureSignal`로 보낸다.
            if (signals && args.onSignal) {
              const cb = callbacks.get(args.onSignal.id);
              window.__captureSignal ??= {};
              window.__captureSignal[title ?? ""] = (value) => cb?.({ index: 0, message: value });
              const exit = callbacks.get(args.onExit.id);
              window.__captureExit ??= {};
              window.__captureExit[title ?? ""] = (code) => exit?.({ index: 0, message: { id, code, signal: null } });
            }
            return id;
          }
          if (cmd === "workbench_git_read") {
            const { command, paneId } = args.request;
            const folder = folders[(paneId - 1) % folders.length];
            if (command === "g1") return { outcome: "ok", value: { kind: "repo", name: folder } };
            if (command === "g2") return { outcome: "ok", value: { kind: "branch", name: branches[folder] } };
            if (command === "g3") return { outcome: "ok", value: { kind: "worktrees", worktrees } };
            if (command === "g7") {
              const d = diffs[folder];
              if (!d) return { outcome: "noUpstream" };
              return { outcome: "ok", value: { kind: "diff", files: [], totals: { files: 3, added: d[0], deleted: d[1], binary: 0 } } };
            }
            return { outcome: "unknown" };
          }
          // #3106: 셸이 refresh 토큰을 쥐고 핸들만 답한다. 핸들이 없으면 「세션 없음」으로 로그아웃된다.
          if (cmd === "keychain_store_refresh_token") {
            window.__captureHandle = "shell:" + "c".repeat(32);
            return null;
          }
          if (cmd === "keychain_refresh_token_handle") return window.__captureHandle ?? null;
          if (cmd === "detect_local_harnesses") return { harnesses: [] };
          if (cmd === "detect_hosted_agents") return [];
          if (cmd === "keychain_available") return false;
          if (cmd === "deep_link_take_pending") return [];
          if (cmd === "app_version") return "0.1.11";
          if (cmd === "notification_permission") return "denied";
          if (cmd === "updater_check") return null;
          if (cmd.startsWith("plugin:event|")) return 1;
          return null;
        },
      };
    },
    { layout, signals }
  );
}

async function signIn(page, origin) {
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("rail-team").waitFor({ timeout: 20_000 });
}

// 시안 ①의 상태(#2776): 칸 3·5 응답 필요, 나머지 실행 중(hook 「작업 중」), PTY 6 끝남(종료 0).
// 키는 칸 id다. `exit-0`은 신호가 아니라 그 칸의 프로세스를 코드 0으로 끝낸다.
// p8은 시안(실행 중)과 달리 코드 1로 끝내 「멈춤(×)」 표지를 증거로 남긴다(design-review M2).

const SIGNALS = { p2: "waiting-permission", "*": "working" };
const report = { scenes: [], badge: {} };
const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok) failures.push(name);
}

async function scene(browser, origin, scheme) {
  const tag = `1280-${scheme}`;
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: scheme, reducedMotion: "reduce", serviceWorkers: "block" });
  await installRoutes(context);
  const page = await context.newPage();
  await installRealtime(page);
  await installDesktop(page, LAYOUT_3, SIGNALS);
  await page.addInitScript((server) => { try { localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ } }, origin);
  await signIn(page, origin);
  const shot = (name) => page.screenshot({ path: resolve(OUT_DIR, `${name}-${tag}.png`) });
  const badge = () => page.locator("[data-testid='rail-inbox-badge']").first().textContent().catch(() => null);

  // 칸이 「응답 필요」가 되도록 내 작업을 한 번 연다(상태는 이 기기 스토어가 쥔다).
  await page.getByTestId("rail-mine").click();
  await page.getByTestId("my-work-tab").waitFor();
  await page.waitForFunction(() => document.querySelectorAll("[data-testid='my-work-tab'] [data-pane-id] .xterm-rows").length >= 1, null, { timeout: 15_000 });
  await page.waitForTimeout(1500);
  await page.evaluate((signals) => {
    for (const el of document.querySelectorAll("[data-testid='my-work-tab'] [data-pane-id]")) {
      const id = el.getAttribute("data-pane-id");
      const label = el.getAttribute("aria-label") ?? "";
      const key = Object.keys(window.__captureSignal).filter((t) => t && label.includes(t)).sort((a, b) => b.length - a.length)[0] ?? "";
      window.__captureSignal[key]?.(signals[id] ?? signals["*"]);
    }
  }, SIGNALS);
  await page.waitForTimeout(800);

  // 인박스: 에이전트 탭 없음, 활동 링크, 머리 수.
  await page.getByTestId("rail-inbox").click();
  await page.getByTestId("inbox-route").waitFor();
  await page.waitForTimeout(900);
  const tabs = await page.$$eval("[role='tab']", (els) => els.map((e) => e.textContent));
  report.badge[tag] = { rail: await badge(), header: await page.getByTestId("inbox-needs-me-count").textContent().catch(() => null), tabs };
  check(`${tag} 인박스에 「에이전트」 탭이 없다`, !tabs.some((t) => t?.includes("에이전트")), JSON.stringify(tabs));
  check(`${tag} 레일 배지 = 5 (승인 2 + 응답 필요 칸 1 + 멘션 2)`, report.badge[tag].rail === "5", JSON.stringify(report.badge[tag]));
  check(`${tag} 인박스 머리 수가 레일 배지와 같다`, report.badge[tag].header === report.badge[tag].rail, JSON.stringify(report.badge[tag]));
  await shot("inbox-needs-action");
  await page.getByTestId("inbox-tab-mentions").click();
  await page.waitForTimeout(800);
  const mentionRows = await page.$$eval("[data-testid='inbox-list'] > li", (e) => e.length).catch(() => 0);
  check(`${tag} 멘션 탭: 수(2)와 목록(2건)이 같다`, mentionRows === 2, String(mentionRows));
  await shot("inbox-mentions");
  await page.getByTestId("inbox-tab-needs-action").click();

  // 옛 딥링크는 활동으로 건너간다.
  await page.goto(`${origin}/#/inbox?filter=agents`);
  await page.getByTestId("activity-route").waitFor();
  check(`${tag} ?filter=agents 딥링크는 활동으로 간다`, page.url().includes("/activity"), page.url());

  // 활동: 칩 네 개와 각 칩.
  await page.waitForTimeout(800);
  const chips = await page.$$eval("[role='tab']", (els) => els.map((e) => e.textContent));
  check(`${tag} 활동 칩 네 개`, JSON.stringify(chips) === JSON.stringify(["전체", "내 에이전트", "승인", "작업 끝남"]), JSON.stringify(chips));
  await shot("activity-all");
  const rowsOf = () => page.$$eval("[data-testid='activity-list'] > li", (e) => e.map((x) => x.textContent ?? ""));
  const allRows = await rowsOf();
  for (const f of ["mine", "approvals", "done"]) {
    await page.getByTestId(`activity-tab-${f}`).click();
    await page.waitForTimeout(500);
    await shot(`activity-${f}`);
    const rows = await rowsOf();
    if (f === "mine") check(`${tag} 내 에이전트 칩은 서연의 새벽봇 행을 뺀다`, rows.length > 0 && rows.length < allRows.length && !rows.some((t) => t.includes("dawn-bot")), `${rows.length}/${allRows.length}`);
    if (f === "approvals") check(`${tag} 승인 칩은 승인 행만 (실행 행 제외)`, rows.length === 4 && !rows.some((t) => t.includes("작업을 실행")), String(rows.length));
    if (f === "done") check(`${tag} 작업 끝남 칩은 끝난 실행 2건만 보인다`, rows.length === 2 && rows.every((t) => t.includes("작업을 실행")), String(rows.length));
  }
  await page.getByTestId("activity-tab-all").click();
  check(`${tag} 대기 승인 행에 인박스 링크`, (await page.getByTestId("activity-pending-link").count()) === 2);
  check(`${tag} 가로 넘침 0`, (await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) === 0);
  await shot("rail-badge-mixed");
  report.scenes.push(tag);
  await context.close();
}

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) throw new Error("dist/ is missing. Run npm run build first.");
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  try {
    for (const scheme of ["light", "dark"]) await scene(browser, preview.origin, scheme);
  } finally {
    await browser.close();
    await preview.stop();
  }
  writeFileSync(resolve(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));
  if (failures.length > 0) {
    console.error(`\n${failures.length}개 단언 실패`);
    process.exit(1);
  }
}

await main();
