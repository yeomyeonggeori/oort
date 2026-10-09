#!/usr/bin/env node
// =============================================================================
// AI 허브 › 「에이전트」/「내 도구」 두 탭과 하네스 카드 캡처와 실측 (#3568, ADR-0198 D3).
//
//   npm run build && node scripts/capture-ai-tools.mjs
//   → OUT_DIR(기본 artifacts/ai-tools)/*.png + report.json
//
// 진짜 앱 셸을 Chromium으로 연다. `/v1/**`는 고정 응답, 실시간 소켓은 곧바로 연결되는 흉내.
// 데스크탑은 `__TAURI_INTERNALS__` 흉내이고 `detect_local_harnesses`가 장면마다 다른 상태 명령
// 결과(종료 코드의 번역)를 돌려준다. 실제 CLI도 workd도 키체인도 건드리지 않는다.
//
// 재는 것: 장면마다 카드의 `data-login`·`data-host`·`data-personal` (**기다리는 조건이 그 값이다**:
// 다른 상태이면 시간 초과로 실패한다), 로그인 중은 모달을 닫은 뒤에도 같은 값, 가로 넘침 0,
// 화면 어디에도 「문의 중」이 없다.
// =============================================================================

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/ai-tools");
const PORT = Number(process.env.CAPTURE_PORT || 5199);

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const hostId = "019a3c1e-5b7d-7e20-9c41-8d2f0a6b3e17";
const channels = [{ id: "00000000-0000-7000-8000-000000000201", workspaceId, kind: "public", name: "workbench", muted: false }];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: "ws://ai-tools-capture.invalid/connection/websocket",
};
const roster = [
  {
    id: memberId, workspaceId, kind: "human", status: "active", role: "owner", displayName: "곽성재",
    handle: "seongjae", channelCount: 1, channelIds: channels.map((c) => c.id), capabilities: [],
    createdAtMs: 0, updatedAtMs: 0,
  },
  {
    id: "00000000-0000-7000-8000-000000000301", workspaceId, kind: "agent", status: "active", displayName: "그록봇",
    handle: "grokbot", channelCount: 1, channelIds: channels.map((c) => c.id), capabilities: [],
    createdAtMs: 0, updatedAtMs: 0, ownerHumanId: memberId,
  },
];

const failures = [];
const report = { scenes: [], checks: [] };
function check(name, ok, detail) {
  report.checks.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures.push(name);
}

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

function hostRow(over = {}) {
  return {
    id: hostId, workspaceId, scope: "member", ownerMemberId: memberId, type: "workd",
    displayName: "성재 MacBook Pro", publicKey: "capture", capabilities: { acp: true },
    createdAtMs: Date.now() - 86_400_000, lastSeenAtMs: Date.now() - 20_000, online: true, ...over,
  };
}

const personalClaude = {
  id: "00000000-0000-7000-8000-000000000401", handle: "kwak-claude", displayName: "kwak-claude",
  harness: "claude_code", enabled: true, label: "곽성재의 개인 에이전트",
};

async function installRoutes(context, scene) {
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
    if (path.endsWith("/work-hosts")) {
      if (scene.hostsError) return json(route, { error: { code: "internal", message: "down" } }, 500);
      return json(route, { workHosts: scene.hosts ?? [] });
    }
    if (path.endsWith("/personal-agents")) {
      if (scene.personal === "unavailable") return json(route, { error: { code: "not_found", message: "not found" } }, 404);
      if (scene.personal === "error") return json(route, { error: { code: "internal", message: "down" } }, 500);
      return json(route, { agents: scene.personal ?? [] });
    }
    if (path.endsWith("/hosted-agent-connections")) return json(route, { connections: [] });
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
          if (c.connect) return { id: c.id, connect: { client: "ai-tools-capture", version: "6" } };
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

async function installDesktop(page, probes, spawnFail) {
  await page.addInitScript(({ probes, spawnFail }) => {
    const callbacks = new Map();
    let nextCallback = 1;
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
      transformCallback(callback) { const id = nextCallback++; callbacks.set(id, callback); return id; },
      unregisterCallback(id) { callbacks.delete(id); },
      convertFileSrc: (p) => p,
      async invoke(cmd) {
        if (cmd === "keychain_store_refresh_token") { window.__h = "shell:" + "c".repeat(32); return null; }
        if (cmd === "keychain_refresh_token_handle") return window.__h ?? null;
        if (cmd === "detect_local_harnesses") return probes;
        if (cmd === "harness_profile_list") return [];
        if (cmd === "pty_spawn") {
          // 셸이 PTY를 거부하는 장면(로그인·로그아웃 시작 실패)
          if (spawnFail) throw "refused: capture";
          return 1;
        }
        if (cmd === "pty_kill" || cmd === "pty_resize" || cmd === "pty_ack") return null;
        if (cmd === "work_host_status") return null;
        if (cmd === "device_key_status") return null;
        if (cmd === "detect_hosted_agents") return [];
        if (cmd === "keychain_available") return false;
        if (cmd === "deep_link_take_pending") return [];
        if (cmd === "app_version") return "0.1.19";
        if (cmd === "notification_permission") return "denied";
        if (cmd === "updater_check") return null;
        if (cmd.startsWith("plugin:event|")) return 1;
        return null;
      },
    };
  }, { probes, spawnFail });
}

async function signIn(page, origin) {
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  try {
    await page.getByTestId("nav-team").waitFor({ timeout: 20_000 });
  } catch (error) {
    await page.screenshot({ path: resolve(OUT_DIR, "FAIL-sign-in.png") }).catch(() => {});
    throw error;
  }
}

const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function open(browser, origin, { scheme, viewport, scene, hash }) {
  const context = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion: "reduce", serviceWorkers: "block" });
  await installRoutes(context, scene);
  const page = await context.newPage();
  if (process.env.CAPTURE_DEBUG) {
    page.on("console", (m) => console.log("console", m.type(), m.text().slice(0, 200)));
    page.on("pageerror", (e) => console.log("pageerror", String(e).slice(0, 300)));
  }
  await installRealtime(page);
  await installDesktop(page, scene.probes, scene.spawnFail === true);
  await page.addInitScript((server) => {
    try { localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ }
  }, origin);
  await signIn(page, origin);
  await page.evaluate((h) => { location.hash = h; }, hash);
  return { context, page };
}

const probe = (claude, codex = "needs_login") => [
  { id: "claude", installed: true, auth: claude },
  { id: "codex", installed: true, auth: codex },
];

/** 장면. `before`(없으면 `expect`)를 기다린 뒤 흐름을 밟고, `expect`가 마지막 모습이다. 다르면 시간 초과로 실패한다. */
const SCENES = [
  { name: "logged-out", probes: probe("needs_login"), hosts: [hostRow()], expect: { login: "reauth", host: "on", personal: "off" } },
  { name: "logging-in", probes: probe("needs_login"), hosts: [hostRow()], before: { login: "reauth", host: "on", personal: "off" }, expect: { login: "logging-in", host: "on", personal: "off" }, flow: "login-detach" },
  { name: "on", probes: probe("logged_in"), hosts: [hostRow()], expect: { login: "connected", host: "on", personal: "off" } },
  { name: "mac-off", probes: probe("logged_in"), hosts: [hostRow({ online: false, lastSeenAtMs: Date.now() - 20 * 60_000 })], expect: { login: "connected", host: "off", personal: "off" } },
  { name: "unregistered", probes: probe("logged_in"), hosts: [], expect: { login: "connected", host: "unregistered", personal: "off" } },
  { name: "personal-on", probes: probe("logged_in"), hosts: [hostRow()], personal: [personalClaude], expect: { login: "connected", host: "on", personal: "on" } },
  { name: "personal-form", probes: probe("logged_in"), hosts: [hostRow()], personal: [], expect: { login: "connected", host: "on", personal: "off" }, flow: "personal-form" },
  { name: "personal-unavailable", probes: probe("logged_in"), hosts: [hostRow()], personal: "unavailable", expect: { login: "connected", host: "on", personal: "off" }, flow: "unavailable" },
  { name: "host-unknown", probes: probe("logged_in"), hostsError: true, expect: { login: "connected", host: "unknown", personal: "off" } },
  { name: "personal-error", probes: probe("logged_in"), hosts: [hostRow()], personal: "error", expect: { login: "connected", host: "on", personal: "off" }, flow: "personal-error" },
  { name: "login-failed", probes: probe("needs_login"), hosts: [hostRow()], spawnFail: true, expect: { login: "reauth", host: "on", personal: "off" }, flow: "login-failed" },
  { name: "disconnect-failed", probes: probe("logged_in"), hosts: [hostRow()], spawnFail: true, expect: { login: "connected", host: "on", personal: "off" }, flow: "disconnect-failed" },
  { name: "offline", probes: probe("logged_in"), hosts: [hostRow()], expect: { login: "connected", host: "on", personal: "off" }, flow: "offline" },
  { name: "disconnect-confirm", probes: probe("logged_in"), hosts: [hostRow()], expect: { login: "connected", host: "on", personal: "off" }, flow: "disconnect-confirm" },
];

async function toolsScene(browser, origin, scene, { scheme, viewport }) {
  const tag = `tools-${scene.name}-${viewport.width}-${scheme}`;
  const { context, page } = await open(browser, origin, { scheme, viewport, scene, hash: "/ai/accounts" });
  try {
    const { login, host, personal } = scene.before ?? scene.expect;
    await page
      .locator(`[data-testid='tool-card-claude'][data-login='${login}'][data-host='${host}'][data-personal='${personal}']`)
      .waitFor({ timeout: 15_000 });
    // 개인 에이전트 목록이 답한 뒤에 찍는다(답하기 전 줄은 비활성 스위치다).
    await page.locator("[data-testid='tool-card-claude-personal'][data-read]:not([data-read='loading'])").waitFor({ timeout: 15_000 });

    if (scene.flow === "login-detach") {
      await page.getByTestId("tool-card-claude-login").click();
      await page.getByTestId("harness-login-dialog").waitFor({ timeout: 10_000 });
      await page.waitForTimeout(250);
      await page.screenshot({ path: resolve(OUT_DIR, `${tag}-dialog.png`) });
      report.scenes.push(`${tag}-dialog`);
      await page.getByTestId("harness-login-detach").click();
      await page.getByTestId("harness-login-dialog").waitFor({ state: "detached", timeout: 10_000 });
      // 모달을 닫은 뒤에도 카드가 로그인 중이다.
      await page.locator("[data-testid='tool-card-claude'][data-login='logging-in']").waitFor({ timeout: 5_000 });
      await page.getByTestId("tool-card-claude-progress").waitFor({ timeout: 5_000 });
      check(`${tag} 모달을 닫아도 카드가 로그인 중`, true);
    }
    if (scene.flow === "personal-form") {
      await page.getByTestId("tool-card-claude-personal-switch").click();
      await page.getByTestId("tool-card-claude-alias-input").fill("kwak-claude");
    }
    if (scene.flow === "unavailable") {
      await page.locator("[data-testid='tool-card-claude-personal'][data-read='unavailable']").waitFor({ timeout: 5_000 });
    }
    if (scene.flow === "personal-error") {
      await page.locator("[data-testid='tool-card-claude-personal'][data-read='error']").waitFor({ timeout: 5_000 });
      await page.getByTestId("tool-card-claude-personal-retry").waitFor({ timeout: 5_000 });
    }
    if (scene.flow === "login-failed") {
      await page.getByTestId("tool-card-claude-login").click();
      await page.getByTestId("harness-login-dialog").waitFor({ timeout: 10_000 });
      await page.getByTestId("harness-login-close").click();
      await page.getByTestId("tool-card-claude-login-failed").waitFor({ timeout: 10_000 });
    }
    if (scene.flow === "disconnect-failed") {
      await page.getByTestId("tool-card-claude-disconnect").click();
      await page.getByTestId("tool-card-claude-disconnect-go").click();
      await page.getByTestId("tool-card-claude-disconnect-failed").waitFor({ timeout: 10_000 });
    }
    if (scene.flow === "offline") {
      await page.context().setOffline(true);
      await page.evaluate(() => window.dispatchEvent(new Event("offline")));
      await page.waitForFunction(
        () => document.querySelector("[data-testid='tool-card-claude-personal-switch']")?.hasAttribute("disabled"),
        null,
        { timeout: 5_000 }
      );
    }
    if (scene.flow === "disconnect-confirm") {
      await page.getByTestId("tool-card-claude-disconnect").click();
      await page.getByTestId("tool-card-claude-disconnect-confirm").waitFor({ timeout: 5_000 });
    }

    // 흐름이 끝난 카드가 기대한 값이어야 한다(다르면 여기서 시간 초과로 실패한다).
    await page
      .locator(`[data-testid='tool-card-claude'][data-login='${scene.expect.login}'][data-host='${scene.expect.host}'][data-personal='${scene.expect.personal}']`)
      .waitFor({ timeout: 5_000 });
    check(`${tag} 가로 넘침 0`, (await overflowX(page)) === 0);
    check(`${tag} 「문의 중」이 없다`, !(await page.locator("body").innerText()).includes("문의 중"));
    check(`${tag} 구독 에이전트 만들기 입구가 없다`, (await page.getByTestId("agent-hub-subscription-entry").count()) === 0);
    await page.waitForTimeout(250);
    await page.screenshot({ path: resolve(OUT_DIR, `${tag}.png`) });
    report.scenes.push(tag);
  } catch (error) {
    await page.screenshot({ path: resolve(OUT_DIR, `FAIL-${tag}.png`) }).catch(() => {});
    throw error;
  } finally {
    await context.close();
  }
}

async function agentsScene(browser, origin, { scheme, viewport }) {
  const tag = `agents-${viewport.width}-${scheme}`;
  const scene = { probes: probe("logged_in"), hosts: [hostRow()] };
  const { context, page } = await open(browser, origin, { scheme, viewport, scene, hash: "/ai" });
  try {
    await page.getByTestId("ai-hub-overview").waitFor({ timeout: 15_000 });
    await page.locator("[data-testid='ai-hub-top-agents'][aria-current='page']").waitFor({ timeout: 5_000 });
    check(`${tag} 위 탭은 에이전트와 내 도구`, (await page.locator("[data-testid='ai-hub-top-tabs'] a").allInnerTexts()).join("|") === "에이전트|내 도구");
    check(`${tag} 가로 넘침 0`, (await overflowX(page)) === 0);
    await page.waitForTimeout(250);
    await page.screenshot({ path: resolve(OUT_DIR, `${tag}.png`) });
    report.scenes.push(tag);
  } catch (error) {
    await page.screenshot({ path: resolve(OUT_DIR, `FAIL-${tag}.png`) }).catch(() => {});
    throw error;
  } finally {
    await context.close();
  }
}

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) throw new Error("dist/ is missing. Run npm run build first.");
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  try {
    for (const scheme of ["light", "dark"]) {
      for (const width of [1440, 900]) {
        const viewport = { width, height: 900 };
        await agentsScene(browser, preview.origin, { scheme, viewport });
        for (const scene of SCENES) await toolsScene(browser, preview.origin, scene, { scheme, viewport });
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
