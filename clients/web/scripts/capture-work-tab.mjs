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
//   - 「팀 작업」 빈 상태: 데스크탑 1440·1280, 웹 390(서랍 닫힘·열림).
// =============================================================================

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/work-tab");
const PORT = Number(process.env.CAPTURE_PORT || 5197);
const MIN_PANE = 240;

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
async function installDesktop(page, layout) {
  await page.addInitScript(
    ({ layout }) => {
      try {
        localStorage.setItem("momo.web.workbench.layout.v1:dock", JSON.stringify(layout));
      } catch {
        /* 저장소 없는 캡처 */
      }
      const callbacks = new Map();
      let nextCallback = 1;
      let nextPty = 1;
      const enc = new TextEncoder();
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
            const text = scripts[(id - 1) % scripts.length].join("\r\n");
            const bytes = enc.encode(text);
            setTimeout(() => out?.({ index: 0, message: bytes.buffer.slice(0) }), 30);
            return id;
          }
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
    { layout }
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

async function open(browser, origin, { viewport, scheme, desktop }) {
  const context = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion: "reduce" });
  await installRoutes(context);
  const page = await context.newPage();
  await installRealtime(page);
  if (desktop) {
    await installDesktop(page, LAYOUT_4X2);
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
  await page.waitForFunction(() => document.querySelectorAll("[data-pane-id] .xterm-rows").length >= 8, null, { timeout: 15_000 });
  await page.waitForTimeout(400);
  const panes = await page.evaluate(() =>
    [...document.querySelectorAll("[data-testid='my-work-tab'] [data-pane-id]")].map((el) => {
      const r = el.getBoundingClientRect();
      return { id: el.getAttribute("data-pane-id"), w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 };
    })
  );
  const railWidth = await page.evaluate(() => document.querySelector("#sidebar-drawer")?.getBoundingClientRect().width ?? null);
  check(`${tag} 칸 여덟`, panes.length === 8, { panes: panes.length });
  const narrowest = Math.min(...panes.map((p) => p.w));
  check(`${tag} 칸 폭 ≥ ${MIN_PANE}`, narrowest >= MIN_PANE, { narrowest, panes });
  check(`${tag} 앱 사이드바 레일 64`, railWidth === 64, { railWidth });
  // 세션 목록(T4 #2856, 268)이 격자 옆에 서면: 지금 격자 폭에서 268을 빼고 4열로 나눈다.
  const gridWidth = await page.evaluate(
    () => document.querySelector("[data-testid='my-work-tab'] [data-testid='workbench-grid']")?.getBoundingClientRect().width ?? null
  );
  const withList = gridWidth === null ? null : (gridWidth - 268 - 3 * 8) / 4;
  report[`my-work-${tag}-with-session-list`] = { gridWidth, withList };
  console.log(`info ${tag} 격자 폭 ${gridWidth}, 세션 목록 268을 편 4열 칸 ${withList}`);
  if (viewport.width === 1440) {
    check(`${tag} 세션 목록(268)을 펴도 4×2 칸 ≥ ${MIN_PANE}`, withList !== null && withList >= MIN_PANE, { gridWidth, withList });
  }
  check(`${tag} 가로 넘침 0`, (await overflowX(page)) === 0);
  check(
    `${tag} 도크가 함께 마운트되지 않는다`,
    (await page.locator("[data-testid='local-terminal-dock']").count()) === 0
  );
  await shot(page, `my-work-${tag}`);
  report[`my-work-${tag}`] = { panes, railWidth };
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

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) throw new Error("dist/ is missing. Run npm run build first.");
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  try {
    for (const scheme of ["light", "dark"]) {
      await myWork(browser, preview.origin, scheme, { width: 1440, height: 900 });
      await myWork(browser, preview.origin, scheme, { width: 1280, height: 800 });
      await teamWork(browser, preview.origin, scheme, { width: 1440, height: 900 }, true);
      await teamWork(browser, preview.origin, scheme, { width: 390, height: 844 }, false);
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
