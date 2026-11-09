#!/usr/bin/env node
// =============================================================================
// #5579 캡처와 실브라우저 확인: Codex 칸이 OSC 7501 보고로 「응답 필요」를 띄운다.
//
//   npm run build && OUT_DIR=<폴더> CAPTURE_PORT=26861 node scripts/capture-5579.mjs
//
// 진짜 앱 셸을 연다. 흉내는 capture-work-tab.mjs와 같은 모양이다: `/v1/**`는 고정 응답,
// 실시간 소켓은 곧바로 연결, 데스크탑은 `window.__TAURI_INTERNALS__`. Codex 칸은 실제
// 새 세션 메뉴(「Codex」)로 연다. 흉내 PTY는 Codex처럼 포커스 알림을 켜고(`\x1b[?1004h`),
// 데스크탑 셸이 칸 채널에 싣는 값(`{ from: "report", signal }`, `pane_signal.rs`
// `PaneSignalEvent`)을 흉내 낸다. 셸의 7501 해석기 자체는 Rust 시험이 잰다. 칸 이름과
// 화면 글은 지어낸 것이다.
//
// 재는 것(라이트·다크, 1440×900: 칸 넷이 240 이상으로 서는 폭):
//   - Codex 칸 둘이 「로컬 · Codex · …」이고, 보고만으로 응답 필요 표지와 바닥 띠가 선다
//     (permission → 「실행 허락을 기다려요」, question → 「답을 기다려요」).
//   - 그 칸을 눌러 포커스를 주면 xterm이 `\x1b[I`를 보내지만(흉내 PTY가 받은 것을 센다)
//     띠는 남는다. hook만 있는 칸이었다면 이 입력이 기다림을 풀었다(#2776 규칙).
//   - ⌃⇧J가 다음 응답 필요 칸(다른 Codex 칸)으로 간다.
//   - 인박스 「이 기기의 칸」에 두 Codex 칸 줄이 선다.
//   - 보고가 `working`이 되면 띠가 내려가고 「실행 중」이 된다.
// =============================================================================

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/5579");
const PORT = Number(process.env.CAPTURE_PORT || 26861);
const VIEWPORT = { width: 1440, height: 900 };

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const channels = [{ id: "00000000-0000-7000-8000-000000000201", workspaceId, kind: "public", name: "workbench", muted: false }];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "캡처 사용자", handle: "capture" },
  realtimeWebSocketUrl: "ws://capture-5579.invalid/connection/websocket",
};
const roster = [
  {
    id: memberId, workspaceId, kind: "human", status: "active", role: "owner", displayName: "캡처 사용자",
    handle: "capture", channelCount: 1, channelIds: channels.map((c) => c.id), capabilities: [],
    createdAtMs: 0, updatedAtMs: 0,
  },
];
// 칸 하나에서 시작한다. Codex 둘과 Claude Code 하나는 새 세션 메뉴가 나눠 연다.
const LAYOUT_ONE = { v: 1, root: { kind: "pane", id: "p1" }, focused: "p1", maximized: null, seq: 1 };

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
    if (path.endsWith("/work-sessions/shared")) return json(route, { sessions: [], nextCursor: null });
    if (path.endsWith(`/workspaces/${workspaceId}`)) return json(route, { workspace: { id: workspaceId, name: "캡처 워크스페이스" } });
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
          if (c.connect) return { id: c.id, connect: { client: "capture-5579", version: "6" } };
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

/**
 * 데스크탑 셸 흉내. PTY는 프로그램 종류(셸·Codex·Claude Code)마다 지어낸 화면을 그린다.
 * `window.__report(title, signal)`·`window.__hook(title, signal)`은 그 칸의 신호 채널에
 * 셸이 싣는 값을 보낸다. `window.__writes`는 칸이 보낸 입력(사람 키·포커스 알림)이다.
 */
async function installDesktop(page) {
  await page.addInitScript(
    ({ layout }) => {
      try {
        localStorage.setItem("momo.web.workbench.layout.v1:dock", JSON.stringify(layout));
      } catch {
        /* 저장소 없는 캡처 */
      }
      const callbacks = new Map();
      const indices = new Map();
      let nextCallback = 1;
      let nextPty = 1;
      const enc = new TextEncoder();
      const counts = { shell: 0, codex: 0, claude: 0 };
      const titles = { codex: ["빌드 스크립트 정리", "로그 회전 설정"], claude: ["문서 링크 점검"] };
      // Codex처럼 포커스 알림을 켠다(`EnableFocusChange`). 그 뒤 칸에 포커스가 가면 xterm이 \x1b[I를 보낸다.
      const screens = {
        shell: () => "\x1b[32m~/sample-app\x1b[0m \x1b[34mmain\x1b[0m\r\n\x1b[36m❯\x1b[0m ",
        codex: (n) =>
          "\x1b[?1004h" +
          [
            "\x1b[35m>_ Codex\x1b[0m \x1b[2m(sample-app)\x1b[0m",
            "",
            n === 0 ? "\x1b[36m•\x1b[0m 빌드 스크립트의 중복 단계를 하나로 합칠게요." : "\x1b[36m•\x1b[0m 로그 파일을 날마다 돌리는 설정을 볼게요.",
            "",
            n === 0 ? "  \x1b[1m명령을 실행할까요?\x1b[0m  \x1b[2mnpm run build -- --clean\x1b[0m" : "  \x1b[1m보관 기간을 며칠로 할까요?\x1b[0m",
            n === 0 ? "  \x1b[7m 1. 예 \x1b[0m   2. 이번 세션 동안 예   3. 아니요" : "  \x1b[2m답을 입력하세요\x1b[0m",
          ].join("\r\n"),
        claude: () =>
          ["\x1b[38;2;215;119;87m✻\x1b[0m 문서의 깨진 링크를 찾고 있어요…", "\x1b[2m  ⎿ Read 3 files\x1b[0m"].join("\r\n"),
      };
      const send = (cbId, message) => {
        const index = indices.get(cbId) ?? 0;
        indices.set(cbId, index + 1);
        callbacks.get(cbId)?.({ index, message });
      };
      window.__writes = [];
      window.__report = {};
      window.__hook = {};
      window.__spawned = [];
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
            const program = args.request.program;
            const kind = program.kind === "harness" ? program.id : "shell";
            const n = counts[kind]++;
            const title = titles[kind]?.[n] ?? null;
            window.__spawned.push({ id, kind, title });
            const text = (title ? `\x1b]0;${title}\x07` : "") + screens[kind](n);
            setTimeout(() => send(args.onOutput.id, enc.encode(text).buffer), 30);
            if (title) {
              window.__report[title] = (signal) => send(args.onSignal.id, { from: "report", signal });
              window.__hook[title] = (signal) => send(args.onSignal.id, { from: "hook", signal });
            }
            return id;
          }
          if (cmd === "pty_write") {
            window.__writes.push(new TextDecoder().decode(args));
            return null;
          }
          if (cmd === "detect_local_harnesses") {
            return [
              { id: "claude", installed: true, auth: "logged_in" },
              { id: "codex", installed: true, auth: "logged_in" },
            ];
          }
          if (cmd === "workbench_git_read") {
            const { command } = args.request;
            if (command === "g1") return { outcome: "ok", value: { kind: "repo", name: "sample-app" } };
            if (command === "g2") return { outcome: "ok", value: { kind: "branch", name: "main" } };
            return { outcome: "unknown" };
          }
          if (cmd === "detect_hosted_agents") return [];
          if (cmd === "keychain_available") return true;
          if (cmd === "keychain_store_refresh_token") { window.__kc = true; return null; }
          if (cmd === "keychain_refresh_token_handle") return window.__kc ? "shell:00000000000000000000000000000001" : null;
          if (cmd === "keychain_clear_refresh_token") { window.__kc = false; return null; }
          if (cmd === "deep_link_take_pending") return [];
          if (cmd === "app_version") return "0.1.46";
          if (cmd === "notification_permission") return "denied";
          if (cmd === "updater_check") return null;
          if (cmd.startsWith("plugin:event|")) return 1;
          return null;
        },
      };
    },
    { layout: LAYOUT_ONE }
  );
}

async function signIn(page, origin) {
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  try {
    await page.getByTestId("nav-work").waitFor({ timeout: 20_000 });
  } catch (error) {
    await page.screenshot({ path: resolve(OUT_DIR, "debug-signin.png") });
    const ids = await page.evaluate(() => [...document.querySelectorAll("[data-testid]")].map((el) => el.getAttribute("data-testid")).slice(0, 80));
    console.error("visible test ids:", JSON.stringify(ids));
    throw error;
  }
}

const pane = (page, name) => page.locator(`[data-testid='my-work-tab'] [data-pane-id][aria-label*='${name}']`);

/** 새 세션 메뉴에서 하네스를 고른다. 격자 화면에서는 세션 목록 머리의 「새 세션」이 연다. */
async function openHarness(page, id) {
  const list = page.getByTestId("session-list-new");
  await ((await list.isVisible()) ? list : page.getByTestId("local-terminal-new")).click();
  await page.getByTestId(`local-terminal-new-${id}`).click();
}

async function scene(browser, origin, scheme) {
  const tag = `${VIEWPORT.width}-${scheme}`;
  // 한국어 화면(앱 언어는 브라우저 언어를 따른다, ADR-0213).
  const context = await browser.newContext({ viewport: VIEWPORT, colorScheme: scheme, reducedMotion: "reduce", locale: "ko-KR" });
  await installRoutes(context);
  const page = await context.newPage();
  await installRealtime(page);
  await installDesktop(page);
  await page.addInitScript((server) => {
    try {
      localStorage.setItem("momo.web.server.v1", server);
      // 업데이트 소식 창은 이 캡처의 대상이 아니다: 이미 본 것으로 둔다.
      localStorage.setItem("momo.web.release-notes.seen.v1", "99.0.0");
    } catch {
      /* 저장소 없는 캡처 */
    }
  }, origin);
  await signIn(page, origin);
  // 데스크탑 터미널 격자(옛 「내 작업」): `/work?view=terminals` (WorkRoute).
  await page.goto(`${origin}/#/work?view=terminals`);
  await page.getByTestId("my-work-tab").waitFor();
  await page.waitForFunction(() => (window.__spawned ?? []).length >= 1, null, { timeout: 15_000 });

  await openHarness(page, "codex");
  await pane(page, "빌드 스크립트 정리").waitFor({ timeout: 15_000 });
  await openHarness(page, "codex");
  await pane(page, "로그 회전 설정").waitFor({ timeout: 15_000 });
  // Claude Code 칸은 셸 칸(p1)을 나눠 연다: 격자가 2×2로 선다.
  await page.locator("[data-testid='my-work-tab'] [data-pane-id='p1'] .xterm-helper-textarea").focus();
  await openHarness(page, "claude");
  await pane(page, "문서 링크 점검").waitFor({ timeout: 15_000 });
  const spawned = await page.evaluate(() => window.__spawned);
  check(`${tag} 새 세션 메뉴로 연 칸의 프로그램`, spawned.map((s) => s.kind).join(",") === "shell,codex,codex,claude", { spawned });
  const labels = await page.evaluate(() =>
    [...document.querySelectorAll("[data-testid='my-work-tab'] [data-pane-id]")].map((el) => el.getAttribute("aria-label"))
  );
  check(`${tag} Codex 칸 둘의 이름은 「로컬 · Codex · …」`, labels.filter((l) => l?.includes("로컬 · Codex · ")).length === 2, { labels });

  // 셸이 Codex의 OSC 7501을 읽어 실었을 값. Claude Code 칸은 hook만 있다(oort는 7501 질의에 답하지 않는다).
  await page.evaluate(() => {
    window.__report["빌드 스크립트 정리"]("ready");
    window.__report["빌드 스크립트 정리"]("working");
    window.__report["빌드 스크립트 정리"]("waiting-permission");
    window.__report["로그 회전 설정"]("waiting-input");
    window.__hook["문서 링크 점검"]("working");
  });
  const codexA = pane(page, "빌드 스크립트 정리");
  const codexB = pane(page, "로그 회전 설정");
  await codexA.and(page.locator("[data-waiting]")).waitFor({ state: "attached", timeout: 10_000 });
  await codexB.and(page.locator("[data-waiting]")).waitFor({ state: "attached", timeout: 10_000 });
  await page.waitForTimeout(300);
  const bandOf = async (loc) => (await loc.locator("[data-testid='workbench-pane-waiting']").allTextContents()).join(" | ");
  const markOf = (loc) => loc.locator("[data-testid='status-mark']").first().getAttribute("data-status");
  check(`${tag} Codex 칸 표지는 응답 필요`, (await markOf(codexA)) === "waiting" && (await markOf(codexB)) === "waiting", {
    a: await markOf(codexA),
    b: await markOf(codexB),
  });
  const bandA = await bandOf(codexA);
  const bandB = await bandOf(codexB);
  check(`${tag} 바닥 띠: 허락은 「실행 허락을 기다려요」, 질문은 「답을 기다려요」`, bandA.includes("실행 허락을 기다려요") && bandB.includes("답을 기다려요"), { bandA, bandB });
  const headerOverflow = await page.evaluate(() =>
    [...document.querySelectorAll("[data-testid='workbench-pane'] header")].filter((h) => h.scrollWidth > h.clientWidth + 1).length
  );
  check(`${tag} 칸 머리 넘침 0`, headerOverflow === 0, { headerOverflow });
  await page.getByTestId("my-work-tab").screenshot({ path: resolve(OUT_DIR, `grid-${tag}.png`) });
  report.scenes.push(`grid-${tag}`);
  await codexA.screenshot({ path: resolve(OUT_DIR, `codex-pane-waiting-${tag}.png`) });
  report.scenes.push(`codex-pane-waiting-${tag}`);

  // 그 칸을 눌러 포커스: Codex가 켠 포커스 알림 \x1b[I가 입력으로 가도 기다림은 그대로.
  await codexA.locator(".xterm-screen").click();
  await page.waitForFunction(() => window.__writes.some((w) => w.includes("\x1b[I")), null, { timeout: 5_000 });
  await page.waitForTimeout(200);
  const writes = await page.evaluate(() => window.__writes.map((w) => JSON.stringify(w)));
  check(`${tag} 포커스 알림(\\x1b[I)이 갔어도 띠가 남는다`, (await bandOf(codexA)).includes("실행 허락을 기다려요"), { writes });
  await codexA.screenshot({ path: resolve(OUT_DIR, `codex-pane-waiting-focused-${tag}.png`) });
  report.scenes.push(`codex-pane-waiting-focused-${tag}`);

  // ⌃⇧J: 다음 응답 필요 칸(다른 Codex 칸)으로.
  await page.keyboard.press("Control+Shift+KeyJ");
  await codexB.and(page.locator("[data-focused]")).waitFor({ state: "attached", timeout: 5_000 });
  await page.waitForTimeout(200);
  check(`${tag} ⌃⇧J → 다른 Codex 칸, 두 칸 다 띠가 남는다`, (await bandOf(codexA)).length > 0 && (await bandOf(codexB)).length > 0);
  await page.getByTestId("my-work-tab").screenshot({ path: resolve(OUT_DIR, `grid-next-waiting-${tag}.png`) });
  report.scenes.push(`grid-next-waiting-${tag}`);

  // 인박스: 「이 기기의 칸」. 지금 보고 있는 칸(로그 회전 설정)은 오르지 않는다(#2776 규칙).
  await page.getByTestId("nav-inbox").click();
  await page.getByTestId("inbox-route").waitFor();
  await page.waitForTimeout(300);
  const inboxText = (await page.getByTestId("inbox-route").textContent()) ?? "";
  check(`${tag} 인박스에 Codex 칸의 응답 필요 줄`, inboxText.includes("빌드 스크립트 정리") && inboxText.includes("실행 허락을 기다려요"), {
    excerpt: inboxText.slice(0, 200),
  });
  await page.getByTestId("inbox-route").screenshot({ path: resolve(OUT_DIR, `inbox-${tag}.png`) });
  report.scenes.push(`inbox-${tag}`);

  // 허락하면 Codex가 working을 보고한다: 띠가 내려가고 「실행 중」.
  await page.goto(`${origin}/#/work?view=terminals`);
  await page.getByTestId("my-work-tab").waitFor();
  await page.evaluate(() => window.__report["빌드 스크립트 정리"]("working"));
  await page.waitForTimeout(300);
  check(`${tag} 보고가 working이면 띠가 내려가고 실행 중`, (await bandOf(codexA)) === "" && (await markOf(codexA)) === "running", {
    mark: await markOf(codexA),
  });
  await codexA.screenshot({ path: resolve(OUT_DIR, `codex-pane-working-${tag}.png`) });
  report.scenes.push(`codex-pane-working-${tag}`);
  await context.close();
}

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) throw new Error("dist/ is missing. Run npm run build first.");
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  try {
    for (const scheme of ["light", "dark"]) {
      try {
        await scene(browser, preview.origin, scheme);
      } catch (error) {
        for (const ctx of browser.contexts()) {
          for (const p of ctx.pages()) await p.screenshot({ path: resolve(OUT_DIR, `debug-failure-${scheme}.png`) }).catch(() => undefined);
          const notice = await ctx.pages()[0]?.evaluate(() => document.querySelector("[data-testid='workbench-notice']")?.textContent ?? null).catch(() => null);
          console.error("notice:", notice);
          await ctx.close();
        }
        throw error;
      }
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
