#!/usr/bin/env node
// =============================================================================
// 레일 일관화 측정 (#3280): 하나의 레일(56px)이 모든 탭에서 같은 자리·같은 모양인지,
// 접기 단추가 같은 자리인지, ⌘B가 목록 열만 접고(레일 유지) 컴포저 굵게를 건드리지
// 않는지, 접힘이 기기별로 기억되는지를 실제 셸(Chromium)에서 재고 단언한다.
//
//   npm run build && node scripts/capture-rail-unified.mjs
//   → OUT_DIR(기본 artifacts/rail-unified)/*.png + report.json
//
// capture-work-tab.mjs와 같은 흉내(Tauri·PTY·/v1)로 진짜 셸을 연다. 단언이 하나라도
// 틀리면 종료 코드 1이다.
// =============================================================================
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/rail-unified");
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
  await page.getByTestId("rail-team").waitFor({ timeout: 20_000 });
}



const PROBE = `
(() => {
  const q = (s) => document.querySelector(s);
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x * 10) / 10, y: Math.round(r.y * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 }; };
  const main = q(".app-shell > main");
  const toggle = q("[data-testid='sidebar-toggle']");
  const pane = q("[data-testid='sidebar-channel-pane']");
  return {
    rail: box(q("[data-testid='workspace-rail']")),
    tile: box(q("[data-testid='workspace-current']")),
    plus: box(q("[data-testid='add-workspace']")),
    railItems: ["rail-chat", "rail-inbox", "rail-mine", "rail-team"].map((id) => box(q("[data-testid='" + id + "']"))),
    profile: box(q("[data-testid='profile-card']")),
    toggle: box(toggle),
    toggleAria: toggle ? { expanded: toggle.getAttribute("aria-expanded"), label: toggle.getAttribute("aria-label"), title: toggle.getAttribute("title") } : null,
    current: [...document.querySelectorAll("[data-testid='workspace-rail'] [aria-current='page']")].map((e) => e.textContent),
    listPaneHidden: pane ? pane.hidden : null,
    sessionList: box(q("[data-testid='session-list']")),
    content: box(q("[data-testid='my-work-tab'] > section") || main),
    main: box(main),
    cols: getComputedStyle(q(".app-shell")).gridTemplateColumns,
    legacyWorkRail: document.querySelectorAll("[data-testid='work-rail']").length,
    scrollW: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
})()`;

const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok) failures.push(`${name} ${detail}`);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function scene(browser, origin, scheme, viewport, report, preCollapsed = false) {
  const tag = `${viewport.width}-${scheme}${preCollapsed ? "-remembered" : ""}`;
  const context = await browser.newContext({ viewport, colorScheme: scheme, serviceWorkers: "block" });
  await installRoutes(context);
  const page = await context.newPage();
  await installRealtime(page);
  await installDesktop(page, LAYOUT_4X2, null);
  await page.addInitScript((server) => { try { localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ } }, origin);
  // 이전 실행에서 접어 둔 기기: 저장된 접힘으로 시작한다.
  if (preCollapsed) await page.addInitScript(() => { try { localStorage.setItem("momo.web.shell.listColumn.collapsed.v1", "1"); } catch { /* 저장소 없는 캡처 */ } });
  await signIn(page, origin);
  await page.waitForTimeout(600);
  const probe = () => page.evaluate(PROBE);
  const shot = (name) => page.screenshot({ path: resolve(OUT_DIR, `${name}-${tag}.png`) });
  const out = {};
  if (preCollapsed) {
    out.remembered = await probe();
    await shot("collapsed-remembered");
    check(`${tag} 저장된 접힘으로 시작한다(열 56·목록 열 숨김·aria-expanded=false)`, out.remembered.cols.startsWith("56px") && out.remembered.listPaneHidden === true && out.remembered.toggleAria.expanded === "false", JSON.stringify([out.remembered.cols, out.remembered.listPaneHidden, out.remembered.toggleAria]));
    await page.getByTestId("rail-mine").click();
    await page.getByTestId("my-work-tab").waitFor();
    await page.waitForTimeout(600);
    out.mineRemembered = await probe();
    check(`${tag} 저장된 접힘은 내 작업의 세션 목록에도 적용된다`, out.mineRemembered.sessionList === null);
    report[tag] = out;
    await context.close();
    return;
  }

  out.chat = await probe();
  await shot("chat");
  // 레일 노드 정체성: 탭을 옮겨도 같은 DOM 노드여야 한다.
  await page.evaluate(() => { document.querySelector("[data-testid='workspace-rail']").setAttribute("data-cap-identity", "rail-1"); });

  await page.getByTestId("rail-inbox").click();
  await page.waitForTimeout(500);
  out.inbox = await probe();
  await shot("inbox");

  await page.getByTestId("rail-mine").click();
  await page.getByTestId("my-work-tab").waitFor();
  await page.waitForTimeout(900);
  out.mine = await probe();
  await shot("mywork");

  await page.getByTestId("rail-team").click();
  await page.waitForTimeout(500);
  out.team = await probe();
  await shot("team");

  await page.getByTestId("rail-chat").click();
  await page.waitForTimeout(500);
  out.chatAgain = await probe();

  const identity = await page.evaluate(() => document.querySelector("[data-testid='workspace-rail']")?.getAttribute("data-cap-identity"));
  check(`${tag} 레일은 탭을 오가도 같은 DOM 노드다`, identity === "rail-1", String(identity));
  for (const key of ["inbox", "mine", "team", "chatAgain"]) {
    const o = out[key];
    check(`${tag} ${key}: 레일 상자(x·y·w·h)가 대화 탭과 같고 폭이 56이다`, same(o.rail, out.chat.rail) && o.rail.w === 56, JSON.stringify([o.rail, out.chat.rail]));
    check(`${tag} ${key}: 워크스페이스 타일·「+」·프로필 자리가 같다`, same(o.tile, out.chat.tile) && same(o.plus, out.chat.plus) && same(o.profile, out.chat.profile));
    check(`${tag} ${key}: 목적지 단추 자리가 같다`, same(o.railItems, out.chat.railItems), JSON.stringify([o.railItems, out.chat.railItems]));
    check(`${tag} ${key}: 접기 단추 자리·aria가 같다`, same(o.toggle, out.chat.toggle) && o.toggleAria.expanded === "true", JSON.stringify([o.toggle, out.chat.toggle]));
    check(`${tag} ${key}: 64px 작업 레일이 없다`, o.legacyWorkRail === 0);
    check(`${tag} ${key}: 가로 넘침 0`, o.scrollW === 0, String(o.scrollW));
  }
  check(`${tag} 레일 aria-current: 대화·인박스·내 작업·팀 작업 각 하나`,
    same([out.chat.current, out.inbox.current, out.mine.current, out.team.current], [["대화"], ["인박스"], ["내 작업"], ["팀 작업"]]),
    JSON.stringify([out.chat.current, out.inbox.current, out.mine.current, out.team.current]));
  // 본문 왼쪽 가장자리: 대화·인박스(떠 있는 판 = 324 + 8)와 내 작업(세션 목록 끝 = 56 + 268 = 324)이 같은 목록 열 폭을 쓴다.
  check(`${tag} 목록 열 폭: 내 작업 세션 목록 268(펼침일 때)`, out.mine.sessionList === null || out.mine.sessionList.w === 268, JSON.stringify(out.mine.sessionList));
  check(`${tag} 대화 탭 열 = 56 + 268`, out.chat.cols.startsWith("324px"), out.chat.cols);
  check(`${tag} 내 작업 열 = 56(목록은 라우트 안)`, out.mine.cols.startsWith("56px"), out.mine.cols);

  // ⌘B: 일반 포커스에서 목록 열만 접고 레일은 남는다.
  await page.getByTestId("rail-chat").focus();
  await page.keyboard.press("Meta+KeyB");
  await page.waitForTimeout(500);
  out.collapsed = await probe();
  await shot("collapsed");
  check(`${tag} ⌘B: 접힘 = 열 56·목록 열 숨김·단추 aria-expanded=false`, out.collapsed.cols.startsWith("56px") && out.collapsed.listPaneHidden === true && out.collapsed.toggleAria.expanded === "false", JSON.stringify([out.collapsed.cols, out.collapsed.listPaneHidden, out.collapsed.toggleAria]));
  check(`${tag} ⌘B: 접혀도 레일·접기 단추 자리가 같다`, same(out.collapsed.rail, out.chat.rail) && same(out.collapsed.toggle, out.chat.toggle) && same(out.collapsed.railItems, out.chat.railItems));
  const stored = await page.evaluate(() => localStorage.getItem("momo.web.shell.listColumn.collapsed.v1"));
  check(`${tag} 접힘을 기기별로 기억한다`, stored === "1", String(stored));

  // 접힌 채로 「내 작업」으로: 세션 목록도 접혀 있다(상태 한 벌), 레일은 그대로.
  await page.getByTestId("rail-mine").click();
  await page.getByTestId("my-work-tab").waitFor();
  await page.waitForTimeout(700);
  out.minedCollapsed = await probe();
  await shot("mywork-collapsed");
  check(`${tag} 접힌 채 내 작업: 세션 목록 없음·레일 같음·단추 같은 자리`, out.minedCollapsed.sessionList === null && same(out.minedCollapsed.rail, out.chat.rail) && same(out.minedCollapsed.toggle, out.chat.toggle) && out.minedCollapsed.toggleAria.expanded === "false");
  // 제목줄 단추로 편다(내 작업에서도 같은 단추).
  await page.getByTestId("sidebar-toggle").click();
  await page.waitForTimeout(600);
  out.minedOpened = await probe();
  check(`${tag} 내 작업에서 단추로 펴면 세션 목록(268)이 선다`, out.minedOpened.sessionList !== null && out.minedOpened.sessionList.w === 268 && out.minedOpened.toggleAria.expanded === "true", JSON.stringify(out.minedOpened.sessionList));

  // 컴포저 포커스에서는 ⌘B가 굵게이고 접힘이 바뀌지 않는다.
  await page.getByTestId("rail-chat").click();
  await page.waitForTimeout(500);
  const composer = page.locator("[data-testid='composer-input'], textarea").first();
  if (await composer.count()) {
    await composer.focus();
    await composer.fill("굵게");
    await page.keyboard.press("Meta+KeyA");
    await page.keyboard.press("Meta+KeyB");
    await page.waitForTimeout(400);
    const after = await probe();
    const value = await composer.inputValue().catch(() => null);
    check(`${tag} 컴포저에서 ⌘B: 접힘 불변(펼침 유지)`, after.toggleAria.expanded === "true" && after.cols.startsWith("324px"), JSON.stringify([after.toggleAria, after.cols]));
    out.composerValue = value;
  } else {
    console.log(`skip ${tag} 컴포저 시험: 컴포저 없음`);
  }

  report[tag] = out;
  await context.close();
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  const report = {};
  try {
    const only = process.env.ONLY ? process.env.ONLY.split(",") : null;
    for (const scheme of ["light", "dark"]) {
      for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 900, height: 700 }]) {
        if (only && !only.includes(`${viewport.width}-${scheme}`)) continue;
        await scene(browser, preview.origin, scheme, viewport, report);
        if (viewport.width === 1440) await scene(browser, preview.origin, scheme, viewport, report, true);
      }
    }
  } finally {
    await browser.close();
    await preview.stop?.();
  }
  writeFileSync(resolve(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));
  if (failures.length > 0) {
    console.error(`\n${failures.length}개 단언 실패`);
    process.exit(1);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
