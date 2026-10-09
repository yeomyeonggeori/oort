#!/usr/bin/env node
// =============================================================================
// 설정 › 기기 › 「지시 서명」 캡처와 실측 (#3025, ADR-0146 개정 R2-E5; 다시 연결 #3103).
//
//   npm run build && node scripts/capture-device-keys.mjs
//   → artifacts/device-keys/*.png + report.json
//
// 진짜 앱 셸을 Chromium으로 연다. `/v1/**`는 고정 응답, 실시간 소켓은 곧바로
// 연결되는 흉내. 데스크탑은 `__TAURI_INTERNALS__` 흉내이고 `device_key_status`가
// 장면마다 다른 셸 상태를 돌려준다. Secure Enclave·Touch ID·네이티브 확인 창은
// 셸 쪽이라 여기서 보이지 않는다(runtime-unverified). 키체인도 workd도 건드리지 않는다.
//
// 재는 것: 장면마다 `data-device-key-bound`, 가로 넘침 0.
// #3129: 「QR 아님」·승인 불가 폰, 작업 호스트 서명 검증(켜짐·서버만 켜짐·꺼짐),
// 해제 단추를 누른 뒤 확인 창 거절. `SCENES_ONLY=qr-,host-`로 일부만 찍는다.
// =============================================================================

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/device-keys");
const PORT = Number(process.env.CAPTURE_PORT || 5199);
const only = (process.env.SCENES_ONLY ?? "").split(",").map((v) => v.trim()).filter(Boolean);

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const channels = [
  { id: "00000000-0000-7000-8000-000000000201", workspaceId, kind: "public", name: "workbench", muted: false },
];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: "ws://device-keys-capture.invalid/connection/websocket",
};
const roster = [
  {
    id: memberId, workspaceId, kind: "human", status: "active", role: "owner", displayName: "곽성재",
    handle: "seongjae", channelCount: 1, channelIds: channels.map((c) => c.id), capabilities: [],
    createdAtMs: 0, updatedAtMs: 0,
  },
];

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

async function installRoutes(context, keys, linked) {
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
    if (path.endsWith("/device-keys/signing-context")) {
      return json(route, {
        instanceId: "capture", serverTimeMs: Date.now(), maxLifetimeMs: 600_000, maxClockSkewMs: 300_000,
        humanControlSignatureRequired: true, hostRegisterSignatureRequired: false,
        sessionId: "019a3c1e-0000-7000-8000-00000000c001",
      });
    }
    if (path.endsWith("/device-keys")) return json(route, { deviceKeys: keys });
    if (path === "/v1/auth/devices") return json(route, { devices: linked });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: [] });
    if (path.includes("/work-tier-policy")) return json(route, { workTierPolicy: { mode: "ask", source: "default" } });
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
          if (c.connect) return { id: c.id, connect: { client: "device-keys-capture", version: "6" } };
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



const MAC_KEY = "Al5MJdwsIiT7groXgUDS9kC6VMwSS1QutnuZEZlbxi5S";
const ROOT_ID = "019a3c1e-0000-7000-8000-00000000d001";
function keyRow(over = {}) {
  return {
    id: "019a3c1e-0000-7000-8000-00000000d002", workspaceId, memberId, alg: "p256",
    publicKey: "A2sX0fLhLEJH+Lzm5WOkQPJ3A32BLeszoPShOUXYmMKW", platform: "ios",
    label: "성재의 iPhone 16 Pro", state: "unendorsed", canInstruct: false, current: false,
    createdAtMs: Date.now() - 600_000, ...over,
  };
}
const rootRow = keyRow({ id: ROOT_ID, platform: "macos", publicKey: MAC_KEY, label: "Mac", state: "root", canInstruct: true, current: true });
const muteRoot = { ...rootRow, current: false, lineageLive: false };
const endorsed = keyRow({
  id: "019a3c1e-0000-7000-8000-00000000d003", publicKey: "AgBmMkJ9ZDo8OW7LaZbuUluxsG1dG33gCQzHURTemcBr",
  label: "지현의 iPhone 15 (회사 테스트 기기, 3층 회의실 충전 거치대)", state: "endorsed", canInstruct: true,
});
const linked = [
  { id: "link-1", label: "성재의 iPhone 16 Pro", platform: "ios", linkedAt: Date.now() - 600_000, current: false },
];

const hostPin = { running: true, matches: true, pinnedRootKeyId: ROOT_ID, workspaceMatches: true };

function local(over = {}) {
  return {
    support: "ready", detail: null, publicKey: MAC_KEY, fingerprint: "7C2E 91A0 4B3F D8E6 1055",
    root: { keyId: ROOT_ID, memberId, publicKey: MAC_KEY }, reuseWindowSeconds: 300,
    host: { running: true, matches: true, pinnedRootKeyId: ROOT_ID }, ...over,
  };
}

async function installDesktop(page, status, rebind) {
  await page.addInitScript(({ status, rebind }) => {
    const callbacks = new Map();
    let nextCallback = 1;
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
      transformCallback(callback) { const id = nextCallback++; callbacks.set(id, callback); return id; },
      unregisterCallback(id) { callbacks.delete(id); },
      convertFileSrc: (p) => p,
      async invoke(cmd) {
        if (cmd === "device_key_status") return status;
        // #3129: the shell's native dialog, declined (the dialog is AppKit's).
        if (cmd === "device_key_reset_signature_requirement") throw "device_key_declined";
        // #3103: the shell's native dialog + Touch ID, held open or declined.
        if (cmd === "device_key_sign_rebind") {
          if (rebind === "declined") throw "device_key_declined";
          return new Promise(() => {});
        }
        if (cmd === "work_host_status") return null;
        if (cmd === "detect_local_harnesses") return { harnesses: [] };
        if (cmd === "detect_hosted_agents") return [];
        if (cmd === "keychain_available") return false;
        // #3106: the shell keeps the refresh token and answers a handle for it;
        // no handle reads as 「no session」 and signs the capture out.
        if (cmd === "keychain_store_refresh_token") {
          window.__captureHandle = "shell:" + "c".repeat(32);
          return null;
        }
        if (cmd === "keychain_refresh_token_handle") return window.__captureHandle ?? null;
        if (cmd === "deep_link_take_pending") return [];
        if (cmd === "app_version") return "0.1.12";
        if (cmd === "notification_permission") return "denied";
        if (cmd === "updater_check") return null;
        if (cmd.startsWith("plugin:event|")) return 1;
        return null;
      },
    };
  }, { status, rebind: rebind ?? "pending" });
}

async function signIn(page, origin) {
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("nav-team").waitFor({ timeout: 20_000 });
}

async function overflowX(page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

async function shoot(page, tag, target = "device-keys") {
  await page.waitForTimeout(250);
  const block = page.getByTestId(target);
  await block.scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(OUT_DIR, `${tag}.png`), fullPage: false });
  report.scenes.push(tag);
}

async function scene(browser, origin, { name, scheme, viewport, status, keys, expectBound, act, rebind, target, expectHost }) {
  const tag = `${name}-${viewport.width}-${scheme}`;
  const context = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion: "reduce" });
  await installRoutes(context, keys, linked);
  const page = await context.newPage();
  await installRealtime(page);
  await installDesktop(page, status, rebind);
  await page.addInitScript((server) => {
    try { localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ }
  }, origin);
  await signIn(page, origin);
  // In-page hash change: a fresh navigation would reload the app, and the
  // desktop session (no keychain in this double) lives in memory only.
  await page.evaluate(() => {
    window.location.hash = "#/settings?section=devices";
  });
  await page.getByTestId("device-keys").waitFor({ timeout: 15_000 });
  const bound = await page.getByTestId("device-keys").getAttribute("data-device-key-bound");
  check(`${tag} bound=${expectBound}`, bound === String(expectBound), { bound });
  if (expectHost !== undefined) {
    const line = page.getByTestId("device-key-host-signatures");
    const found = expectHost === null ? await line.count() : await line.getAttribute("data-signature-enforcement");
    check(`${tag} host=${expectHost}`, expectHost === null ? found === 0 : found === expectHost, { found });
  }
  if (act) await act(page);
  check(`${tag} 가로 넘침 0`, (await overflowX(page)) === 0);
  await shoot(page, tag, target);
  await context.close();
}

const SCENES = [
  { name: "bound", status: local(), keys: [rootRow, keyRow(), endorsed], expectBound: true },
  {
    name: "approve-confirm", status: local(), keys: [rootRow, keyRow(), endorsed], expectBound: true,
    act: async (page) => {
      await page.getByTestId("device-key-endorse-start").click();
      await page.getByTestId("device-key-endorse-fingerprint").waitFor();
      // #3145: registered time and where the name comes from.
      await page.locator('[data-testid="device-key-endorse-name"][data-name-origin="matchesLink"]').waitFor();
      check("approve-confirm 등록 시각 줄", (await page.getByTestId("device-key-endorse-registered").innerText()).includes("10분 전"));
    },
  },
  {
    name: "approve-origin-none", status: local(), expectBound: true,
    keys: [rootRow, keyRow({ label: "아이폰", createdAtMs: Date.now() - 45_000 })],
    act: async (page) => {
      await page.getByTestId("device-key-endorse-start").click();
      await page.locator('[data-testid="device-key-endorse-name"][data-name-origin="notInLinks"]').waitFor();
    },
  },
  {
    name: "revoke-confirm", status: local(), keys: [rootRow, keyRow(), endorsed], expectBound: true,
    act: async (page) => {
      await page.getByTestId("device-key-revoke").click();
      await page.getByTestId("device-key-revoke-confirm").waitFor();
    },
  },
  {
    name: "unbound-password", status: local({ root: null, host: null }), keys: [keyRow()], expectBound: false,
    act: async (page) => {
      await page.getByTestId("device-key-root-start").click();
      await page.getByTestId("device-key-root-password").focus();
    },
  },
  // #3103: the root row's sign-in ended without revoking it (lineageLive false).
  {
    name: "relink-pending", status: local(), keys: [muteRoot, keyRow(), endorsed], expectBound: false,
    rebind: "pending",
    act: async (page) => {
      await page.getByTestId("device-key-root-relink").getByText("다시 연결 중").waitFor();
    },
  },
  {
    name: "relink-failed", status: local(), keys: [muteRoot, keyRow(), endorsed], expectBound: false,
    rebind: "declined",
    act: async (page) => {
      await page.getByTestId("device-key-relink-error").waitFor();
    },
  },
  // #3129 (ADR-0146 D-6 증보 「QR 연결로만」 #3119, 래칫 #3117).
  {
    name: "qr-marks",
    status: local({ host: { ...hostPin, signatureEnforcement: "enforced", serverRequiresSignatures: true, signaturesRequiredBy: "server" } }),
    keys: [
      rootRow,
      { ...endorsed, linkedSession: false, linkedFromMac: false },
      keyRow({ linkedSession: false, linkedFromMac: false }),
      keyRow({ id: "019a3c1e-0000-7000-8000-00000000d004", publicKey: "A5y3m8oU6lB9X0QeFJ7a1Z2w3E4r5T6y7U8i9O0p1A2s", label: "민수의 iPhone", linkedSession: true, linkedFromMac: false }),
    ],
    expectBound: true, expectHost: "enforced", target: "device-keys-phones",
  },
  {
    name: "host-half",
    status: local({ root: null, host: { running: true, matches: false, pinnedRootKeyId: null, signatureEnforcement: "server_only", workspaceMatches: true, serverRequiresSignatures: true, signaturesRequiredBy: null } }),
    keys: [keyRow()], expectBound: false, expectHost: "server_only",
  },
  {
    name: "host-latched",
    status: local({ host: { ...hostPin, signatureEnforcement: "enforced", serverRequiresSignatures: false, signaturesRequiredBy: "server" } }),
    keys: [rootRow, endorsed], expectBound: true, expectHost: "enforced",
  },
  {
    name: "host-reset-declined",
    status: local({ host: { ...hostPin, signatureEnforcement: "enforced", serverRequiresSignatures: false, signaturesRequiredBy: "server" } }),
    keys: [rootRow, endorsed], expectBound: true, expectHost: "enforced",
    act: async (page) => {
      await page.getByTestId("device-key-host-signatures-reset").click();
      await page.getByTestId("device-key-host-signatures").getByText("검증을 끄지 않았습니다.").waitFor();
    },
  },
  {
    name: "host-off",
    status: local({ host: { ...hostPin, signatureEnforcement: "off", serverRequiresSignatures: false, signaturesRequiredBy: null } }),
    keys: [rootRow, endorsed], expectBound: true, expectHost: "off",
  },
  {
    name: "unsigned", status: local({ support: "unsigned_build", detail: "device_key_unsigned_build", publicKey: null, fingerprint: null, root: null, host: null }),
    keys: [keyRow()], expectBound: false,
  },
];

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) throw new Error("dist/ is missing. Run npm run build first.");
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  try {
    for (const scheme of ["light", "dark"]) {
      for (const viewport of [{ width: 1280, height: 860 }, { width: 390, height: 844 }]) {
        for (const s of SCENES) {
          if (only.length && !only.some((prefix) => s.name.startsWith(prefix))) continue;
          await scene(browser, preview.origin, { ...s, scheme, viewport });
        }
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
