#!/usr/bin/env node
// =============================================================================
// 컴포저에서 @내 개인 에이전트 부르기 캡처와 실측 (#3653, ADR-0198 증보 1 D7 · P1 확정).
//
//   npm run build && node scripts/capture-personal-call.mjs
//   → OUT_DIR(기본 artifacts/personal-call)/*.png + report.json
//
// 진짜 앱 셸을 Chromium으로 연다. `/v1/**`는 고정 응답, 실시간 소켓은 곧바로 연결되는 흉내.
// 데스크탑은 `__TAURI_INTERNALS__` 흉내이고 `device_key_sign_control`은 고정 서명을 돌려주는
// 흉내다(실제 Secure Enclave·Touch ID·서버는 건드리지 않는다). 장면마다:
//   typing    멘션을 치는 중 — 전송 직전 「내 맥 · <기기> · Claude Code」 한 줄
//   sent      보낸 뒤 — 서명된 spawn이 받아졌다
//   flag-off  서버가 서명 요구를 꺼 둔 상태(지금 서버의 실제 상태)
//   mac-off   내 맥이 꺼져 있다(409) — 같은 서명으로 다시 보내기
//   web       브라우저 탭 — 서명 키가 없어 메시지만 간다
//   teammate  팀원의 개인 에이전트 멘션 — 한 줄도, spawn도 없다
// 재는 것: 장면마다 보낸 요청(메시지 POST 수, work-spawns POST 수, 서명 호출 수)과 줄의 문장.
// =============================================================================

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/personal-call");
const PORT = Number(process.env.CAPTURE_PORT || 5198);

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const otherId = "00000000-0000-7000-8000-000000000102";
const hostId = "019a3c1e-5b7d-7e20-9c41-8d2f0a6b3e17";
const folderId = "fld_0123456789abcdef0123";
const channelId = "00000000-0000-7000-8000-000000000201";
const channels = [{ id: channelId, workspaceId, kind: "public", name: "workbench", muted: false }];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: "ws://personal-call-capture.invalid/connection/websocket",
};
const agentRow = (id, handle, ownerId, ownerName) => ({
  id, workspaceId, kind: "agent", status: "active", displayName: handle, handle,
  channelCount: 1, channelIds: [channelId], capabilities: [], createdAtMs: 0, updatedAtMs: 0,
  personalAgent: { label: `${ownerName}의 개인 에이전트`, ownerId, ownerDisplayName: ownerName, harness: "claude", enabled: true, mentionable: true },
});
const roster = [
  {
    id: memberId, workspaceId, kind: "human", status: "active", role: "owner", displayName: "곽성재",
    handle: "seongjae", channelCount: 1, channelIds: [channelId], capabilities: [], createdAtMs: 0, updatedAtMs: 0,
  },
  agentRow("00000000-0000-7000-8000-000000000401", "kwak-claude", memberId, "곽성재"),
  agentRow("00000000-0000-7000-8000-000000000402", "min-claude", otherId, "민수"),
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

function hostRow() {
  return {
    id: hostId, workspaceId, scope: "member", ownerMemberId: memberId, type: "workd",
    displayName: "성재 MacBook Pro", publicKey: "capture", capabilities: { acp: true },
    createdAtMs: Date.now() - 86_400_000, lastSeenAtMs: Date.now() - 20_000, online: true,
    defaultFolderId: folderId, folders: [{ id: folderId, displayName: "질문", kind: "question" }],
  };
}

async function installRoutes(context, scene, counts) {
  let seq = 0;
  await context.route("**/v1/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId });
    }
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: [hostRow()] });
    if (path.endsWith("/work-sessions")) return json(route, { workSessions: [] });
    if (path.endsWith("/signing-context")) {
      return json(route, {
        instanceId: "capture", serverTimeMs: Date.now(), maxLifetimeMs: 600_000, maxClockSkewMs: 300_000,
        humanControlSignatureRequired: scene.flag, hostRegisterSignatureRequired: false, sessionId: null,
      });
    }
    if (path.endsWith("/work-spawns") && req.method() === "POST") {
      counts.spawns += 1;
      if (scene.spawnStatus === 409) return json(route, { error: { code: "work_host_offline", message: "offline" } }, 409);
      return json(route, { workControl: { id: "ctl-capture", status: "dispatched" }, replayed: counts.spawns > 1 });
    }
    if (path.endsWith(`/channels/${channelId}/messages`) && req.method() === "POST") {
      counts.messages += 1;
      const body = JSON.parse(req.postData() || "{}");
      seq += 1;
      return json(route, {
        id: `00000000-0000-7000-8000-0000000009${String(seq).padStart(2, "0")}`, channelId, seq,
        hlcTs: Date.now(), hlcCount: 0, authorMemberId: memberId, type: "text", body: body.body, text: body.body,
        createdAtMs: Date.now(),
      }, 201);
    }
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
          if (c.connect) return { id: c.id, connect: { client: "personal-call-capture", version: "6" } };
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

async function installDesktop(page) {
  await page.addInitScript(() => {
    const callbacks = new Map();
    let nextCallback = 1;
    window.__signCalls = 0;
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
      transformCallback(callback) { const id = nextCallback++; callbacks.set(id, callback); return id; },
      unregisterCallback(id) { callbacks.delete(id); },
      convertFileSrc: (p) => p,
      async invoke(cmd) {
        if (cmd === "keychain_store_refresh_token") { window.__h = "shell:" + "c".repeat(32); return null; }
        if (cmd === "keychain_refresh_token_handle") return window.__h ?? null;
        if (cmd === "device_key_sign_control") {
          window.__signCalls += 1;
          return { deviceKeyId: "00000000-0000-7000-8000-00000000d003", devicePublicKey: "cap", signature: "c2lnbmF0dXJl", payloadSha256: "00" };
        }
        if (cmd === "detect_local_harnesses") return [];
        if (cmd === "harness_profile_list") return [];
        if (cmd === "work_host_status") return null;
        if (cmd === "device_key_status") return null;
        if (cmd === "detect_hosted_agents") return [];
        if (cmd === "keychain_available") return false;
        if (cmd === "deep_link_take_pending") return [];
        if (cmd === "app_version") return "0.1.20";
        if (cmd === "notification_permission") return "denied";
        if (cmd === "updater_check") return null;
        if (cmd.startsWith("plugin:event|")) return 1;
        return null;
      },
    };
  });
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

const SCENES = [
  { name: "typing", desktop: true, flag: true, text: "@kwak-claude 빌드가 왜 깨지는지 봐 줘", send: false, expectPreview: "내 맥 · 성재 MacBook Pro · Claude Code" },
  { name: "sent", desktop: true, flag: true, text: "@kwak-claude 빌드가 왜 깨지는지 봐 줘", send: true, expectNotice: "called", expect: { messages: 1, spawns: 1, signs: 1 } },
  { name: "flag-off", desktop: true, flag: false, text: "@kwak-claude 빌드가 왜 깨지는지 봐 줘", send: true, expectNotice: "not_delivered", expectText: "이 서버는 아직 내 맥으로 보내는 호출을 받지 않아요.", expect: { messages: 1, spawns: 0, signs: 0 } },
  { name: "mac-off", desktop: true, flag: true, spawnStatus: 409, text: "@kwak-claude 빌드가 왜 깨지는지 봐 줘", send: true, expectNotice: "not_delivered", expectText: "내 맥이 꺼져 있어요. 맥을 켠 뒤 다시 불러 주세요.", expect: { messages: 1, spawns: 1, signs: 1 }, retry: true },
  { name: "web", desktop: false, flag: true, text: "@kwak-claude 빌드가 왜 깨지는지 봐 줘", send: true, expectPreview: null, expectNotice: "message_only", expectText: "데스크탑·폰에서 불러 주세요", expect: { messages: 1, spawns: 0, signs: 0 } },
  { name: "teammate", desktop: true, flag: true, text: "@min-claude 빌드가 왜 깨지는지 봐 줘", send: true, expectNoLine: true, expect: { messages: 1, spawns: 0, signs: 0 } },
];

async function sceneRun(browser, origin, scene, { scheme, viewport }) {
  const tag = `${scene.name}-${viewport.width}-${scheme}`;
  const counts = { messages: 0, spawns: 0 };
  const context = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion: "reduce", serviceWorkers: "block" });
  await installRoutes(context, scene, counts);
  const page = await context.newPage();
  if (process.env.CAPTURE_DEBUG) {
    page.on("console", (m) => console.log("console", m.type(), m.text().slice(0, 200)));
    page.on("pageerror", (e) => console.log("pageerror", String(e).slice(0, 300)));
  }
  await installRealtime(page);
  if (scene.desktop) await installDesktop(page);
  await page.addInitScript((server) => {
    try { localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ }
  }, origin);
  try {
    await signIn(page, origin);
    await page.evaluate((h) => { location.hash = h; }, `/c/${channelId}`);
    const area = page.locator("[data-testid='composer'] textarea");
    await area.waitFor({ timeout: 15_000 });
    // 로스터·내 맥 목록이 도착한 뒤에 친다(도착 전에는 줄이 서지 않는다).
    await page.waitForTimeout(800);
    await area.fill(scene.text);
    if (scene.expectPreview !== undefined && scene.expectPreview !== null) {
      await page.locator("[data-testid='composer-call-destination']").waitFor({ timeout: 10_000 });
      check(`${tag} 도착지 한 줄`, (await page.getByTestId("composer-call-destination").innerText()) === scene.expectPreview);
    }
    if (scene.expectPreview === null) {
      await page.locator("[data-testid='composer-call-blocked']").waitFor({ timeout: 10_000 });
      check(`${tag} 보내기 전에 정직하게 말한다`, (await page.getByTestId("composer-call-blocked").innerText()).includes("데스크탑·폰에서 불러 주세요"));
    }
    if (scene.expectNoLine) {
      await page.waitForTimeout(500);
      check(`${tag} 팀원 에이전트에는 줄이 없다`, (await page.getByTestId("composer-call-preview").count()) === 0);
    }
    if (!scene.send) {
      await page.waitForTimeout(250);
      check(`${tag} 가로 넘침 0`, (await overflowX(page)) === 0);
      await page.screenshot({ path: resolve(OUT_DIR, `${tag}.png`) });
      await page.getByTestId("composer").screenshot({ path: resolve(OUT_DIR, `${tag}-composer.png`) });
      report.scenes.push(tag);
      return;
    }
    await area.press("Enter");
    if (scene.expectNotice) {
      await page.locator(`[data-testid='composer-call-notice'][data-state='${scene.expectNotice}']`).waitFor({ timeout: 10_000 });
      if (scene.expectText) {
        check(`${tag} 문장`, (await page.getByTestId("composer-call-text").innerText()) === scene.expectText);
      }
      check(`${tag} 재시도 단추`, ((await page.getByTestId("composer-call-retry").count()) === 1) === (scene.retry === true));
    } else {
      await page.waitForTimeout(1000);
      check(`${tag} 줄이 없다`, (await page.getByTestId("composer-call-notice").count()) === 0);
    }
    const signs = scene.desktop ? await page.evaluate(() => window.__signCalls) : 0;
    check(`${tag} 요청 수`, counts.messages === scene.expect.messages && counts.spawns === scene.expect.spawns && signs === scene.expect.signs, { counts, signs });
    check(`${tag} 가로 넘침 0`, (await overflowX(page)) === 0);
    await page.waitForTimeout(250);
    await page.screenshot({ path: resolve(OUT_DIR, `${tag}.png`) });
    await page.getByTestId("composer").screenshot({ path: resolve(OUT_DIR, `${tag}-composer.png`) });
    report.scenes.push(tag);
    if (scene.retry) {
      // 맥이 켜졌다고 치고 같은 서명을 다시 보낸다: 메시지·서명은 늘지 않고 spawn만 한 번 더 간다.
      scene.spawnStatus = 200;
      await page.getByTestId("composer-call-retry").click();
      await page.locator("[data-testid='composer-call-notice'][data-state='called']").waitFor({ timeout: 10_000 });
      const signs2 = await page.evaluate(() => window.__signCalls);
      check(`${tag} 재시도는 같은 서명으로 spawn만`, counts.messages === 1 && counts.spawns === 2 && signs2 === 1, { counts, signs2 });
      await page.waitForTimeout(250);
      await page.screenshot({ path: resolve(OUT_DIR, `${tag}-retried.png`) });
    }
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
      for (const width of [1440]) {
        for (const scene of SCENES) await sceneRun(browser, preview.origin, { ...scene }, { scheme, viewport: { width, height: 900 } });
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
