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
const SESSION_LIST_PX = 260; // 레일 64 + 260 = 사이드바 324 (#3275)
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
const LAYOUT_4X2 = {
  v: 1,
  root: { kind: "split", id: "s20", axis: "column", ratio: 0.5, first: row4(["p1", "p2", "p3", "p4"], 21), second: row4(["p5", "p6", "p7", "p8"], 24) },
  focused: "p3",
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
          if (cmd === "detect_local_harnesses") return { harnesses: [] };
          if (cmd === "detect_hosted_agents") return [];
          // #3106: 셸이 새로고침 토큰을 보관하고 웹뷰는 핸들만 본다. 저장되면 핸들이 선다.
          if (cmd === "keychain_available") return true;
          if (cmd === "keychain_store_refresh_token") { window.__kc = true; return null; }
          if (cmd === "keychain_refresh_token_handle") return window.__kc ? "shell:00000000000000000000000000000001" : null;
          if (cmd === "keychain_clear_refresh_token") { window.__kc = false; return null; }
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

// 시안 ①의 상태(#2776): 칸 3·5 나를 기다림, 나머지 실행 중(hook 「작업 중」), PTY 6 끝남(종료 0).
// 키는 칸 id다. `exit-0`은 신호가 아니라 그 칸의 프로세스를 코드 0으로 끝낸다.
// p8은 시안(실행 중)과 달리 코드 1로 끝내 「멈춤(×)」 표지를 증거로 남긴다(design-review M2).
const MOCK_SIGNALS = { p3: "waiting-permission", p5: "waiting-permission", p6: "exit-0", p8: "exit-1", "*": "working" };

async function open(browser, origin, { viewport, scheme, desktop, signals = null }) {
  const context = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion: "reduce" });
  await installRoutes(context);
  const page = await context.newPage();
  await installRealtime(page);
  if (desktop) {
    await installDesktop(page, LAYOUT_4X2, signals);
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

async function overflowX(page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

async function shot(page, name) {
  await page.screenshot({ path: resolve(OUT_DIR, `${name}.png`) });
  report.scenes.push(name);
}

async function myWork(browser, origin, scheme, viewport) {
  const tag = `${viewport.width}-${scheme}`;
  const { context, page } = await open(browser, origin, { viewport, scheme, desktop: true });
  await page.getByTestId("nav-my-work").click();
  await page.getByTestId("my-work-tab").waitFor();
  await page.getByTestId("work-rail").waitFor();
  const wide = viewport.width >= 1280;
  // 좁은 창(1100 기본·900)에서는 4×2가 240을 못 지켜 격자가 한 칸 최대화로 접힌다
  // (#2774 fitLayout). 그 모양을 그대로 찍고 기록한다(프리셋 안내는 T5).
  await page.waitForFunction((n) => document.querySelectorAll("[data-pane-id] .xterm-rows").length >= n, wide ? 8 : 1, { timeout: 15_000 });
  await page.waitForTimeout(400);
  const panes = await page.evaluate(() =>
    [...document.querySelectorAll("[data-testid='my-work-tab'] [data-pane-id]")].map((el) => {
      const r = el.getBoundingClientRect();
      return { id: el.getAttribute("data-pane-id"), w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 };
    })
  );
  const railWidth = await page.evaluate(() => document.querySelector("#sidebar-drawer")?.getBoundingClientRect().width ?? null);
  const narrowest = Math.min(...panes.map((p) => p.w));
  if (wide) {
    check(`${tag} 칸 여덟`, panes.length === 8, { panes: panes.length });
    check(`${tag} 칸 폭 ≥ ${MIN_PANE}`, narrowest >= MIN_PANE, { narrowest, panes });
  } else {
    const status = await page.locator("[data-testid='my-work-tab'] [data-testid='workbench-status']").textContent().catch(() => null);
    console.log(`info ${tag} 좁은 창: 칸 ${panes.length}, 상태 줄 ${JSON.stringify(status)}`);
    report[`my-work-${tag}-narrow`] = { panes, status };
  }
  check(`${tag} 앱 사이드바 레일 64`, railWidth === 64, { railWidth });
  // 세션 목록(#2856): 1440은 저절로 펴지고, 1280(4×2가 268 옆에서 240을 못 지킨다)은 접힌다.
  const listState = await page.getByTestId("my-work-tab").getAttribute("data-session-list");
  if (viewport.width >= 1440) {
    check(`${tag} 세션 목록 펼침`, listState === "open", { listState });
    await page.waitForFunction(() => document.querySelectorAll("[data-testid='session-list-row']").length >= 1);
    await page.waitForFunction(() => document.querySelector("[data-testid='session-list']")?.textContent?.includes("feat/2774-xterm"), null, { timeout: 10_000 });
    // 칸 6이 끝나 「끝남」 표지가 선 뒤에 찍는다.
    await page.waitForSelector("[data-testid='session-list-row'][data-status='done']", { timeout: 10_000 });
    const listWidth = await page.evaluate(() => document.querySelector("[data-testid='session-list']")?.getBoundingClientRect().width ?? null);
    check(`${tag} 세션 목록 폭 ${SESSION_LIST_PX}`, listWidth === SESSION_LIST_PX, { listWidth });
    // 말줄임(`text-overflow: ellipsis`)이 아닌데 제 상자를 넘는 요소. 상태 표지 상자는
    // 뺀다: 「나를 기다림」 마름모는 9px 네모를 45° 돌린 것이라(시안 `.st.wait i`) 대각선이
    // 상자를 조금 넘는 것이 모양 그 자체다.
    const rowOverflow = await page.evaluate(() =>
      [...document.querySelectorAll("[data-testid='session-list'] *")]
        .filter((el) => {
          const cs = getComputedStyle(el);
          return el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1 && cs.textOverflow !== "ellipsis" && cs.overflowY !== "auto" && !el.classList.contains("sl-st");
        })
        .map((el) => `${el.tagName.toLowerCase()}.${el.className?.baseVal ?? el.className} ${el.scrollWidth}>${el.clientWidth}`)
    );
    check(`${tag} 세션 목록 안 넘침 0`, rowOverflow.length === 0, { rowOverflow });
    report[`my-work-${tag}-session-list`] = {
      listWidth,
      rows: await page.evaluate(() => [...document.querySelectorAll("[data-testid='session-list-row']")].map((r) => r.textContent)),
    };
  } else if (viewport.width >= 1280) {
    check(`${tag} 4×2가 안 서는 폭에서 세션 목록 저절로 접힘`, listState === "closed", { listState });
  }
  check(`${tag} 가로 넘침 0`, (await overflowX(page)) === 0);
  check(
    `${tag} 도크가 함께 마운트되지 않는다`,
    (await page.locator("[data-testid='local-terminal-dock']").count()) === 0
  );
  await shot(page, `my-work-${tag}`);
  report[`my-work-${tag}`] = { panes, railWidth };
  if (viewport.width === 1280) {
    await page.getByTestId("session-list-expand").click();
    await page.getByTestId("session-list").waitFor();
    await page.waitForFunction(() => document.querySelector("[data-testid='session-list']")?.textContent?.includes("feat/2774-xterm"), null, { timeout: 10_000 });
    await page.waitForTimeout(300);
    const status = await page.locator("[data-testid='my-work-tab'] [data-testid='workbench-status']").textContent().catch(() => null);
    report[`my-work-${tag}-list-open`] = { status };
    console.log(`info ${tag} 목록을 편 1280: 상태 줄 ${JSON.stringify(status)}`);
    check(`${tag} 목록을 펴도 가로 넘침 0`, (await overflowX(page)) === 0);
    await shot(page, `my-work-${tag}-list-open`);
  }
  if (viewport.width === 1440) await sessionListStates(page, tag);
  if (viewport.width === 1440 || viewport.width === 1280) {
    const list = page.getByTestId("session-list");
    if ((await list.count()) > 0) await list.screenshot({ path: resolve(OUT_DIR, `session-list-${tag}.png`) });
  }
  await context.close();
}

async function teamWork(browser, origin, scheme, viewport, desktop) {
  const tag = `${viewport.width}-${scheme}${desktop ? "" : "-web"}`;
  const { context, page } = await open(browser, origin, { viewport, scheme, desktop });
  if (viewport.width < 600) {
    await page.goto(`${origin}/#/work?view=team`);
  } else {
    await page.getByTestId("nav-team-work").click();
  }
  await page.getByTestId("team-work-empty").waitFor();
  check(`${tag} 팀 작업 빈 상태`, true);
  check(`${tag} 가로 넘침 0`, (await overflowX(page)) === 0);
  check(`${tag} 팀 작업에서는 레일로 접지 않는다`, (await page.locator("[data-testid='work-rail']").count()) === 0);
  await shot(page, `team-work-${tag}`);
  if (viewport.width < 600) {
    await page.getByTestId("open-sidebar-drawer").first().click();
    await page.getByTestId("nav-team-work").waitFor({ state: "visible" });
    check(`${tag} 서랍에 「내 작업」 없음(웹)`, (await page.locator("[data-testid='nav-my-work']").count()) === 0);
    await page.waitForTimeout(300);
    await shot(page, `team-work-${tag}-drawer`);
  }
  await context.close();
}

/**
 * 세션 목록의 상태와 흐름(design-review M8): 키보드 포커스 줄(⌘J), 「나를 기다림」
 * 빈 상태, 상태로 묶기, 찾기(남은 세션 하나 → 평탄화된 두 줄 행). 끝나면 원래대로.
 */
async function sessionListStates(page, tag) {
  const list = page.getByTestId("session-list");
  const snap = async (name) => {
    await page.waitForTimeout(150);
    await list.screenshot({ path: resolve(OUT_DIR, `session-list-${tag}-${name}.png`) });
    report.scenes.push(`session-list-${tag}-${name}`);
  };
  await page.keyboard.press("Meta+J");
  await page.waitForFunction(() => document.activeElement?.hasAttribute("data-session-row"));
  await page.keyboard.press("ArrowDown");
  await snap("keyboard-focus");
  await page.getByTestId("session-list-filter-waiting").click();
  await page.getByTestId("session-list-empty").waitFor();
  await snap("empty-waiting");
  await page.getByTestId("session-list-show-all").click();
  await page.getByTestId("session-list-grouping").click();
  await page.getByTestId("session-list-grouping-status").click();
  await page.getByTestId("session-list-group").first().waitFor();
  await snap("group-status");
  await page.getByTestId("session-list-grouping").click();
  await page.getByTestId("session-list-grouping-repo").click();
  await page.getByTestId("session-list-search-toggle").click();
  await page.getByTestId("session-list-search").fill("cargo");
  await snap("search-flattened");
  await page.getByTestId("session-list-search").press("Escape");
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
  check(`${tag} 상태 장면 뒤 목록 복원`, (await page.locator("[data-testid='session-list-row']").count()) === 8);
}

/**
 * 칸 상태(#2776, 시안 ①): 칸 머리 표지, 「나를 기다림」 테두리·바닥 띠, ⌃⇧J, 인박스 합류.
 * 시안 ① 격자와 구현 격자를 나란히 찍는다.
 */
async function paneStatus(browser, origin, scheme, viewport) {
  const tag = `${viewport.width}-${scheme}`;
  const { context, page } = await open(browser, origin, { viewport, scheme, desktop: true, signals: MOCK_SIGNALS });
  await page.getByTestId("nav-my-work").click();
  await page.getByTestId("my-work-tab").waitFor();
  await page.waitForFunction(() => document.querySelectorAll("[data-testid='my-work-tab'] [data-pane-id] .xterm-rows").length >= 8, null, { timeout: 15_000 });
  // 칸 제목(OSC)이 선 뒤에 칸을 찾는다. 제목 없는 칸은 하나다.
  await page.waitForFunction(() => [...document.querySelectorAll("[data-testid='my-work-tab'] [data-pane-id]")].filter((el) => (el.getAttribute("aria-label") ?? "").split(" · ").length >= 3).length >= 7, null, { timeout: 15_000 });
  await page.evaluate((signals) => {
    for (const el of document.querySelectorAll("[data-testid='my-work-tab'] [data-pane-id]")) {
      const id = el.getAttribute("data-pane-id");
      const label = el.getAttribute("aria-label") ?? "";
      const key = Object.keys(window.__captureSignal).filter((t) => t && label.includes(t)).sort((a, b) => b.length - a.length)[0] ?? "";
      const value = signals[id] ?? signals["*"];
      if (value.startsWith("exit-")) window.__captureExit[key]?.(Number(value.slice(5)));
      else window.__captureSignal[key]?.(value);
    }
  }, MOCK_SIGNALS);
  await page.waitForSelector("[data-pane-id='p5'][data-waiting]", { timeout: 15_000, state: "attached" });
  await page.waitForSelector("[data-pane-id='p8'] [data-testid='status-mark'][data-status='stopped']", { timeout: 15_000, state: "attached" });
  if (viewport.width < 1280) {
    // 좁은 창: 격자가 활성 칸 하나로 접힌다(#2774 fitLayout). 그 모양만 찍는다.
    await page.waitForTimeout(300);
    check(`${tag} 가로 넘침 0`, (await overflowX(page)) === 0);
    await page.getByTestId("my-work-tab").screenshot({ path: resolve(OUT_DIR, `pane-status-${tag}.png`) });
    report.scenes.push(`pane-status-${tag}`);
    await context.close();
    return;
  }
  await page.waitForTimeout(300);
  const marks = await page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll("[data-testid='my-work-tab'] [data-pane-id]")].map((el) => [
        el.getAttribute("data-pane-id"),
        el.querySelector("[data-testid='status-mark']")?.getAttribute("data-status") ?? null,
      ])
    )
  );
  const count = (st) => Object.values(marks).filter((m) => m === st).length;
  check(`${tag} 칸 상태 표지(기다림 3·5, 끝남 6, 멈춤 8, 실행 중 4)`, marks.p3 === "waiting" && marks.p5 === "waiting" && marks.p6 === "done" && marks.p8 === "stopped" && count("running") === 4, marks);
  const donePane = Object.keys(marks).find((k) => marks[k] === "done");
  const strips = await page.locator("[data-testid='workbench-pane-waiting']").allTextContents();
  check(`${tag} 바닥 띠 둘(칸 3 ⌃⇧J, 칸 5 ⌃5)`, strips.length === 2 && strips[0].endsWith("⌃⇧J") && strips[1].endsWith("⌃5"), { strips });
  const headerOverflow = await page.evaluate(() =>
    [...document.querySelectorAll("[data-testid='workbench-pane'] header")].filter((h) => h.scrollWidth > h.clientWidth + 1).length
  );
  check(`${tag} 칸 머리 넘침 0`, headerOverflow === 0, { headerOverflow });
  check(`${tag} 가로 넘침 0`, (await overflowX(page)) === 0);
  await page.getByTestId("my-work-tab").screenshot({ path: resolve(OUT_DIR, `pane-status-${tag}.png`) });
  report.scenes.push(`pane-status-${tag}`);
  await page.locator("[data-pane-id='p3']").screenshot({ path: resolve(OUT_DIR, `pane-status-${tag}-pane3.png`) });
  // ⌃⇧J: 칸 3에서 다음 기다림(칸 5)으로.
  await page.locator("[data-pane-id='p3'] .xterm-helper-textarea").focus();
  await page.keyboard.press("Control+Shift+KeyJ");
  await page.waitForSelector("[data-pane-id='p5'][data-focused]", { timeout: 5_000 });
  check(`${tag} ⌃⇧J → 칸 5`, true);
  await page.waitForTimeout(200);
  await page.locator("[data-pane-id='p5']").screenshot({ path: resolve(OUT_DIR, `pane-status-${tag}-pane5-focused.png`) });
  // 인박스: 칸 5는 봤으니 내려간다. 끝난 칸은 남는다.
  await page.getByTestId("work-rail-inbox").click();
  await page.getByTestId("inbox-route").waitFor();
  await page.getByTestId("inbox-local-panes").waitFor({ timeout: 5_000 });
  const inboxRows = await page.locator("[data-testid='inbox-local-pane']").evaluateAll((els) => els.map((e) => e.getAttribute("data-status") + ":" + e.textContent));
  // 칸 5는 봤지만 아직 기다리므로 남는다(design-review M3). 끝난 칸 6도 있다.
  check(`${tag} 인박스 「이 기기의 칸」: 기다림과 끝남`, inboxRows.some((r) => r.startsWith("waiting:")) && inboxRows.some((r) => r.startsWith("done:")), { inboxRows });
  const empty = await page.getByTestId("inbox-empty").textContent().catch(() => null);
  check(`${tag} 결정 대기 빈 문구가 기다리는 칸과 모순되지 않는다`, empty === null || !empty.includes("결정할 일이 없습니다"), { empty });
  check(`${tag} 인박스 가로 넘침 0`, (await overflowX(page)) === 0);
  await shot(page, `inbox-local-panes-${tag}`);
  await page.locator("[data-testid='inbox-local-pane'][data-status='done']").first().click();
  await page.getByTestId("my-work-tab").waitFor();
  await page.waitForSelector(`[data-pane-id='${donePane}'][data-focused]`, { timeout: 5_000 });
  check(`${tag} 인박스 줄 → 그 칸`, true);
  await context.close();
  await comparePanes(browser, scheme, tag);
}

async function comparePanes(browser, scheme, tag) {
  const implPath = resolve(OUT_DIR, `pane-status-${tag}.png`);
  if (!existsSync(MOCKUP) || !existsSync(implPath)) return;
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, colorScheme: scheme });
  const page = await context.newPage();
  await page.goto(pathToFileURL(MOCKUP).href, { waitUntil: "load" });
  await page.evaluate((s) => {
    document.documentElement.setAttribute("data-theme", s);
    if (s === "dark") document.querySelector("#d1")?.classList.add("dark");
  }, scheme);
  const grid = page.locator("#d1 .grid").first();
  await grid.scrollIntoViewIfNeeded();
  const mockPng = await grid.screenshot();
  const implPng = readFileSync(implPath);
  const bg = scheme === "dark" ? "#121317" : "#e8e8eb";
  const ink = scheme === "dark" ? "#ededf0" : "#18181b";
  const sheet = await context.newPage();
  await sheet.setContent(`<!doctype html><html><body style="margin:0;background:${bg};color:${ink};font:14px -apple-system,sans-serif">
    <div style="display:flex;flex-direction:column;gap:24px;padding:24px">
      <figure style="margin:0"><figcaption style="margin-bottom:8px">시안 ① 격자 (${scheme})</figcaption><img style="max-width:1400px" src="data:image/png;base64,${mockPng.toString("base64")}"></figure>
      <figure style="margin:0"><figcaption style="margin-bottom:8px">구현 #2776 ${tag}</figcaption><img style="max-width:1400px" src="data:image/png;base64,${implPng.toString("base64")}"></figure>
    </div></body></html>`);
  await sheet.screenshot({ path: resolve(OUT_DIR, `compare-pane-status-${tag}.png`), fullPage: true });
  report.scenes.push(`compare-pane-status-${tag}`);
  await context.close();
}

/** 시안 ① `.slist`와 구현 목록을 나란히. 시안 파일이 없으면 건너뛴다. */
async function compareSessionList(browser, scheme, width) {
  const implPath = resolve(OUT_DIR, `session-list-${width}-${scheme}.png`);
  if (!existsSync(MOCKUP) || !existsSync(implPath)) return;
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, colorScheme: scheme });
  const page = await context.newPage();
  await page.goto(pathToFileURL(MOCKUP).href, { waitUntil: "load" });
  await page.evaluate((s) => {
    document.documentElement.setAttribute("data-theme", s);
    if (s === "dark") document.querySelector("#d1")?.classList.add("dark");
  }, scheme);
  const slist = page.locator("#d1 aside.slist");
  await slist.scrollIntoViewIfNeeded();
  const mockPng = await slist.screenshot();
  const implPng = readFileSync(implPath);
  const bg = scheme === "dark" ? "#121317" : "#e8e8eb";
  const ink = scheme === "dark" ? "#ededf0" : "#18181b";
  const sheet = await context.newPage();
  await sheet.setContent(`<!doctype html><html><body style="margin:0;background:${bg};color:${ink};font:14px -apple-system,sans-serif">
    <div style="display:flex;gap:32px;padding:24px;align-items:flex-start">
      <figure style="margin:0"><figcaption style="margin-bottom:8px">시안 ① .slist (${scheme})</figcaption><img src="data:image/png;base64,${mockPng.toString("base64")}"></figure>
      <figure style="margin:0"><figcaption style="margin-bottom:8px">구현 #2856 ${width} (${scheme})</figcaption><img src="data:image/png;base64,${implPng.toString("base64")}"></figure>
    </div></body></html>`);
  await sheet.screenshot({ path: resolve(OUT_DIR, `compare-session-list-${width}-${scheme}.png`), fullPage: true });
  report.scenes.push(`compare-session-list-${width}-${scheme}`);
  await context.close();
}

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) throw new Error("dist/ is missing. Run npm run build first.");
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  try {
    const only = process.env.WORK_TAB_ONLY;
    for (const scheme of ["light", "dark"]) {
      if (only === "pane-status") {
        await paneStatus(browser, preview.origin, scheme, { width: 1440, height: 900 });
        await paneStatus(browser, preview.origin, scheme, { width: 1280, height: 800 });
        await paneStatus(browser, preview.origin, scheme, { width: 900, height: 700 });
        continue;
      }
      await paneStatus(browser, preview.origin, scheme, { width: 1440, height: 900 });
      await myWork(browser, preview.origin, scheme, { width: 1440, height: 900 });
      await myWork(browser, preview.origin, scheme, { width: 1280, height: 800 });
      await myWork(browser, preview.origin, scheme, { width: 1100, height: 760 });
      await myWork(browser, preview.origin, scheme, { width: 900, height: 700 });
      await teamWork(browser, preview.origin, scheme, { width: 1440, height: 900 }, true);
      await teamWork(browser, preview.origin, scheme, { width: 390, height: 844 }, false);
      await compareSessionList(browser, scheme, 1440);
      await compareSessionList(browser, scheme, 1280);
    }
  } finally {
    await browser.close();
    await preview.stop();
    writeFileSync(resolve(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));
  }
  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
}

await main();
