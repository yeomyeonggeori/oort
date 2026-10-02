#!/usr/bin/env node
// =============================================================================
// 탭 전환 측정 (#3275): 대화/인박스 <-> 「내 작업」을 오갈 때 좌측 패널이 튀지 않는지.
//
//   npm run build && node scripts/capture-shell-switch.mjs
//   → OUT_DIR(기본 artifacts/shell-switch)/*.png + report.json
//
// capture-work-tab.mjs와 같은 흉내(Tauri·PTY·/v1)로 진짜 셸을 연다. 전환 중
// 매 프레임 `#sidebar-drawer`(레일)와 좌측 패널(`[data-testid=session-list]`,
// 없으면 `sidebar-channel-pane`)과 본문의 상자를 재고, 전환 전·후의 면(배경색)·
// 모서리·머리 높이·안쪽 여백 값을 한 표로 적는다. 모션 줄임 없음(실제 전이를 잰다).
// =============================================================================
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/shell-switch");
const PORT = Number(process.env.CAPTURE_PORT || 5199);

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
          if (cmd === "app_version") return "0.1.15";
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
  await page.getByTestId("nav-team").waitFor({ timeout: 20_000 });
}


// 프레임마다 재는 상자와 면. 전환이 튀는지는 이 값들이 프레임 사이에서 얼마나 뛰는지로 읽는다.
const PROBE = `
(() => {
  const q = (s) => document.querySelector(s);
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
  const style = (el) => { if (!el) return null; const c = getComputedStyle(el); return { bg: c.backgroundColor, radius: c.borderTopRightRadius, borderR: c.borderRightWidth + " " + c.borderRightColor, pad: c.paddingTop + " " + c.paddingRight, backdrop: c.backdropFilter }; };
  const shell = q(".app-shell");
  const panel = q("[data-testid='session-list']") || q("[data-testid='sidebar-channel-pane']:not([hidden])");
  const head = q("[data-testid='session-list'] .sl-hd") || q("[data-testid='sidebar-workspace-header']");
  const main = q(".app-shell > main");
  return {
    rail: box(q("[data-testid='workspace-rail']")),
    drawer: box(q("#sidebar-drawer")),
    panel: box(panel), panelKind: panel ? panel.getAttribute("data-testid") : null, panelStyle: style(panel),
    head: box(head),
    main: box(main), mainStyle: style(main),
    // 눈에 보이는 본문의 왼쪽 가장자리: 작업 탭은 격자 구역, 나머지는 떠 있는 판.
    content: box(q("[data-testid='my-work-tab'] > section") || main),
    cols: shell ? getComputedStyle(shell).gridTemplateColumns : null,
    scrollW: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
})()`;

async function startStream(page) {
  await page.evaluate((src) => {
    window.__sw = [];
    window.__swStop = false;
    const t0 = performance.now();
    const tick = () => { window.__sw.push({ t: Math.round(performance.now() - t0), s: (0, eval)(src) }); if (!window.__swStop) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }, PROBE);
}
async function endStream(page) {
  return page.evaluate(() => { window.__swStop = true; return window.__sw; });
}

/** 연속 프레임에서 가장 큰 한 프레임 간 뜀(px)과, 그 뜀이 어느 상자의 어느 값인지. */
function biggestJump(stream, keys) {
  let best = { px: 0, at: null };
  for (let i = 1; i < stream.length; i++) {
    for (const k of keys) {
      const a = stream[i - 1].s[k], b = stream[i].s[k];
      if (!a || !b) continue;
      for (const f of ["x", "w", "h"]) {
        const d = Math.abs(b[f] - a[f]);
        if (d > best.px) best = { px: Math.round(d * 10) / 10, at: `${k}.${f}@${stream[i].t}ms` };
      }
    }
  }
  return best;
}

async function switchScene(browser, origin, scheme, viewport, report) {
  const tag = `${viewport.width}-${scheme}`;
  const context = await browser.newContext({ viewport, colorScheme: scheme, serviceWorkers: "block" }); // 모션 줄임 없음
  await installRoutes(context);
  const page = await context.newPage();
  await installRealtime(page);
  await installDesktop(page, LAYOUT_4X2, null);
  await page.addInitScript((server) => { try { localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ } }, origin);
  await signIn(page, origin);
  await page.waitForTimeout(500);
  const probe = () => page.evaluate(PROBE);
  const out = { tag };

  await page.getByTestId("nav-inbox").click();
  await page.waitForTimeout(500);
  out.inbox = await probe();
  await page.screenshot({ path: resolve(OUT_DIR, `inbox-${tag}.png`) });

  await startStream(page);
  await page.getByTestId("nav-mine").click();
  await page.getByTestId("my-work-tab").waitFor();
  await page.waitForTimeout(900);
  let stream = await endStream(page);
  out.work = await probe();
  out.toWork = { frames: stream.length, jump: biggestJump(stream, ["content", "head"]), cols: [...new Set(stream.map((f) => f.s.cols))] };
  await page.screenshot({ path: resolve(OUT_DIR, `work-${tag}.png`) });

  if (out.work.panelKind !== "session-list") {
    // 좁은 창은 목록이 접혀 있다: 펴서 같은 칸을 비교한다.
    await page.getByTestId("sidebar-toggle").click();
    await page.getByTestId("session-list").waitFor();
    await page.waitForTimeout(500);
    out.workListOpen = await probe();
    await page.screenshot({ path: resolve(OUT_DIR, `work-list-open-${tag}.png`) });
  }

  await startStream(page);
  await page.getByTestId("nav-chat").click().catch(async () => { await page.getByTestId("nav-inbox").click(); });
  await page.waitForTimeout(900);
  stream = await endStream(page);
  out.fromWork = { frames: stream.length, jump: biggestJump(stream, ["content", "head"]), cols: [...new Set(stream.map((f) => f.s.cols))] };
  out.back = await probe();
  await page.screenshot({ path: resolve(OUT_DIR, `back-${tag}.png`) });
  report[tag] = out;
  console.log(`${tag}: ->work 본문·머리 최대 뜀 ${out.toWork.jump.px}px (${out.toWork.jump.at}) cols ${JSON.stringify(out.toWork.cols)} | ->chat 본문·머리 최대 뜀 ${out.fromWork.jump.px}px (${out.fromWork.jump.at}) cols ${JSON.stringify(out.fromWork.cols)}`);
  console.log(`   본문 왼쪽 가장자리 x: 인박스 ${out.inbox.content.x} · 내 작업 ${out.work.content.x} · 돌아온 뒤 ${out.back.content.x}`);
  console.log(`   inbox panel ${JSON.stringify(out.inbox.panelStyle)} head ${JSON.stringify(out.inbox.head)}`);
  console.log(`   work  panel ${JSON.stringify((out.workListOpen ?? out.work).panelStyle)} head ${JSON.stringify((out.workListOpen ?? out.work).head)}`);
  await context.close();
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  const report = {};
  try {
    for (const scheme of ["light", "dark"]) {
      for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 900, height: 700 }]) {
        await switchScene(browser, preview.origin, scheme, viewport, report);
      }
    }
  } finally {
    await browser.close();
    await preview.stop?.();
  }
  writeFileSync(resolve(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
