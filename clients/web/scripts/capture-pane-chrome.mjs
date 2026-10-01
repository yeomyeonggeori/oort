#!/usr/bin/env node
// =============================================================================
// 「내 작업」·「팀 작업」 진입점 캡처와 실측 (#2854, 시안 ①·④).
//
//   npm run build && node scripts/capture-work-tab.mjs
//   → artifacts/work-tab/*.png + report.json
//
// 진짜 앱 셸(사이드바·레일·라우트)을 Chromium으로 연다. 백엔드는 없다: `/v1/**`는
// 이 파일의 고정 응답이고, 실시간 소켓은 곧바로 연결되는 흉내다(gate-work-console과
// 같은 모양). 데스크탑은 `window.__TAURI_INTERNALS__`를 흉내 내어 켠다. PTY는 흉내
// 셸 출력을 내는 가짜다. 신호등(macOS 창 단추)은 브라우저에 없다.
//
// 재는 것:
//   - 1440×900 「내 작업」 4×2: 칸 여덟의 폭이 모두 `WORKBENCH_MIN_PANE`(240) 이상,
//     앱 사이드바 열(레일) 폭 64, 가로 넘침 0.
//   - 1280×800 「내 작업」 4×2: 같은 것(세션 목록 T4가 서기 전 기준).
//   - 1100×760(데스크탑 기본 창)·900×700: 4×2가 240을 못 지키면 격자가 접힌 모양을 찍는다.
//   - 「팀 작업」 빈 상태: 데스크탑 1440·1280, 웹 390(서랍 닫힘·열림).
//   - 세션 목록(#2856, 시안 ① `.slist`): 1440에서 저절로 펴지고 폭 268, 칸 폭 ≥ 240.
//     1280에서는 4×2가 목록을 편 채로 240을 못 지켜 저절로 접힌다. 펴기를 누른
//     모양도 찍는다. git 읽기(`workbench_git_read`)는 시안 ①과 같은 고정 답이다.
//   - 시안 나란히: 시안 ① `.slist`와 구현 목록(`compare-session-list-*`).
// =============================================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/work-tab");
const PORT = Number(process.env.CAPTURE_PORT || 5197);
const MIN_PANE = 240;
const SESSION_LIST_PX = 268;
const MOCKUP =
  process.env.WORK_TAB_MOCKUP ??
  resolve(WEB_ROOT, "../../../momo/claudedocs/agent-workspace-2.0/workspace-mockups.html");

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
const roster = [
  {
    id: memberId, workspaceId, kind: "human", status: "active", role: "owner", displayName: "곽성재",
    handle: "seongjae", channelCount: 4, channelIds: channels.map((c) => c.id), capabilities: [],
    createdAtMs: 0, updatedAtMs: 0,
  },
];

// 균등 4×2. 위 줄이 1~4, 아래 줄이 5~8(시안 ①의 번호).
function row4(ids, base) {
  const pane = (id) => ({ kind: "pane", id });
  return {
    kind: "split", id: `s${base}`, axis: "row", ratio: 0.5,
    first: { kind: "split", id: `s${base + 1}`, axis: "row", ratio: 0.5, first: pane(ids[0]), second: pane(ids[1]) },
    second: { kind: "split", id: `s${base + 2}`, axis: "row", ratio: 0.5, first: pane(ids[2]), second: pane(ids[3]) },
  };
}
const LAYOUT_4X2_UNUSED = {
  v: 1,
  root: { kind: "split", id: "s20", axis: "column", ratio: 0.5, first: row4(["p1", "p2", "p3", "p4"], 21), second: row4(["p5", "p6", "p7", "p8"], 24) },
  focused: "p3",
  maximized: null,
  seq: 30,
};


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

const failures = [];
const report = { scenes: [], checks: [] };
function check(name, ok, detail) {
  report.checks.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures.push(name);
}

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
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: [] });
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
  await page.getByTestId("nav-team-work").waitFor({ timeout: 20_000 });
}

// 시안 ①의 상태(#2776): 칸 3·5 응답 필요, 나머지 실행 중(hook 「작업 중」), PTY 6 끝남(종료 0).
// 키는 칸 id다. `exit-0`은 신호가 아니라 그 칸의 프로세스를 코드 0으로 끝낸다.
// p8은 시안(실행 중)과 달리 코드 1로 끝내 「멈춤(×)」 표지를 증거로 남긴다(design-review M2).
const MOCK_SIGNALS = { p2: "waiting-permission", "*": "working" };

async function open(browser, origin, { viewport, scheme, desktop, signals = null }) {
  const context = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion: "reduce" });
  await installRoutes(context);
  const page = await context.newPage();
  await installRealtime(page);
  if (desktop) {
    await installDesktop(page, LAYOUT_3, signals);
    // 데스크탑 첫 화면(D0)은 서버 주소를 받아야 넘어간다. 고른 서버를 미리 둔다.
    await page.addInitScript((server) => {
      try {
        localStorage.setItem("momo.web.server.v1", server);
      } catch {
        /* 저장소 없는 캡처 */
      }
    }, origin);
  }
  await signIn(page, origin);
  return { context, page };
}

async function overflowX(page) { return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth); }
async function scene(browser, origin, scheme, viewport) {
  const tag = `${viewport.width}-${scheme}`;
  const { context, page } = await open(browser, origin, { viewport, scheme, desktop: true, signals: MOCK_SIGNALS });
  if (viewport.width < 600) await page.goto(`${origin}/#/work`);
  else await page.getByTestId("nav-my-work").click();
  await page.getByTestId("my-work-tab").waitFor();
  await page.waitForFunction(() => document.querySelectorAll("[data-testid='my-work-tab'] [data-pane-id] .xterm-rows").length >= 1, null, { timeout: 15_000 });
  await page.waitForFunction(() => document.querySelectorAll("[data-testid='my-work-tab'] [data-pane-id]").length >= 1, null, { timeout: 15_000 });
  await page.waitForTimeout(1500);
  await page.evaluate((signals) => {
    for (const el of document.querySelectorAll("[data-testid='my-work-tab'] [data-pane-id]")) {
      const id = el.getAttribute("data-pane-id");
      const label = el.getAttribute("aria-label") ?? "";
      const key = Object.keys(window.__captureSignal).filter((t) => t && label.includes(t)).sort((a, b) => b.length - a.length)[0] ?? "";
      const value = signals[id] ?? signals["*"];
      window.__captureSignal[key]?.(value);
    }
  }, MOCK_SIGNALS);
  await page.waitForTimeout(700);
  await page.getByTestId("my-work-tab").screenshot({ path: resolve(OUT_DIR, `${tag}.png`) });
  report.scenes.push(tag);
  if (viewport.width >= 1000) {
    // 호버: 칸 3 위에 포인터. 칸 3의 단추만 드러나야 한다.
    await page.locator("[data-pane-id='p3']").hover({ position: { x: 120, y: 60 } });
    await page.waitForTimeout(250);
    await page.getByTestId("my-work-tab").screenshot({ path: resolve(OUT_DIR, `${tag}-hover.png`) });
    // 키보드 포커스: 칸 2의 첫 단추로 Tab.
    await page.mouse.move(2, 2);
    await page.locator("[data-pane-id='p2'] header button").first().focus();
    await page.keyboard.press("Tab");
    await page.waitForTimeout(250);
    await page.getByTestId("my-work-tab").screenshot({ path: resolve(OUT_DIR, `${tag}-focus.png`) });
    const o = await page.evaluate(() => {
      const op = (id) => {
        const b = document.querySelector(`[data-pane-id='${id}'] header button`);
        return b ? getComputedStyle(b.closest("[data-testid='workbench-pane-actions']") ?? b).opacity : null;
      };
      return { p1: op("p1"), p2: op("p2"), p3: op("p3") };
    });
    console.log(tag, "actions opacity after focus on p2", JSON.stringify(o));
    const header = await page.evaluate(() => document.body.innerText.includes("서버에 기록하지 않습니다"));
    console.log(tag, "header-note-present", header);
  }
  await context.close();
}

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) throw new Error("dist/ is missing. Run npm run build first.");
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  try {
    for (const scheme of ["light", "dark"]) {
      await scene(browser, preview.origin, scheme, { width: 1280, height: 800 });
      await scene(browser, preview.origin, scheme, { width: 390, height: 844 });
    }
  } finally {
    await browser.close();
    await preview.stop();
  }
}

await main();
