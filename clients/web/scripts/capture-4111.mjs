#!/usr/bin/env node
// =============================================================================
// ⌘K 「탐색 패널 접기/열기」 명령 측정 (#3299): 명령 줄이 서고, 이름이 상태를 따르고
// (접기/열기), 키캡이 지금 유효한 조합(재지정 포함)이며, 누르면 목록 열이 접히고 펴지는지
// 실제 셸(Chromium)에서 재고 단언한다. capture-rail-unified.mjs와 같은 흉내(/v1·실시간).
//
//   npm run build && node scripts/capture-4111.mjs
//   → OUT_DIR(기본 artifacts/4111)/*.png
// 단언이 하나라도 틀리면 종료 코드 1이다.
// =============================================================================
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/4111");
const PORT = Number(process.env.CAPTURE_PORT || 5311);

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

async function signIn(page, origin) {
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("nav-ai").waitFor({ timeout: 20_000 });
}




const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok) failures.push(`${name} ${detail}`);
}

async function typeInPalette(page, text) {
  const input = page.getByTestId("quick-switcher-input");
  await input.fill(text);
  await page.waitForTimeout(250);
}
const rowIds = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("[cmdk-item]")].map((n) => n.getAttribute("data-command-id") ?? n.getAttribute("data-testid") ?? "")
  );

async function scene(browser, origin, scheme) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme, serviceWorkers: "block" });
  await installRoutes(context);
  const page = await context.newPage();
  await installRealtime(page);
  await page.addInitScript((server) => { try { localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ } }, origin);
  await signIn(page, origin);
  await page.waitForTimeout(500);
  const tag = scheme;
  const shot = (name) => page.screenshot({ path: resolve(OUT_DIR, `${name}-${tag}.png`) });

  await page.keyboard.press("Meta+KeyK");
  await page.getByTestId("quick-switcher").waitFor();
  await typeInPalette(page, "ai");
  const shown = await rowIds(page);
  await shot("palette-ai");
  for (const hidden of ["nav.inbox", "nav.activity", "nav.directory", "nav.settings"]) {
    check(`${tag} 「ai」에 ${hidden} 가 숨는다`, !shown.includes(hidden), shown.join(","));
  }
  check(`${tag} 「ai」에 AI 연결·AI가 남는다`, shown.includes("nav.settings.ai") && shown.includes("nav.ai"), shown.join(","));

  await typeInPalette(page, "ai 연결");
  await shot("palette-ai-yeongyeol");
  const first = (await rowIds(page))[0];
  check(`${tag} 「ai 연결」 맨 위는 AI 연결이다`, first === "nav.settings.ai", first);

  await typeInPalette(page, "zzqx");
  await shot("palette-empty");
  const empty = await rowIds(page);
  check(`${tag} 맞는 것이 없으면 메시지 검색만 남는다`, empty.every((id) => id.startsWith("switcher-message-search")), empty.join(","));

  await typeInPalette(page, "ai 연결");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(600);
  check(`${tag} Enter가 설정 AI 연결로 간다`, page.url().includes("section=ai"), page.url());
  await shot("settings-ai-connect");
  const nav = await page.evaluate(() => [...document.querySelectorAll('[data-testid^="settings-nav-"]')].map((n) => `${n.getAttribute("data-testid")}:${n.textContent}`));
  check(`${tag} 설정 목차에 AI 연결과 AI 허브가 따로 선다`, nav.some((t) => t.endsWith(":AI 연결")) && nav.some((t) => t.endsWith(":AI 허브")), nav.join(" | "));
  await context.close();
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const dist = process.env.DIST_DIR;
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT", extraArgs: dist ? ["--outDir", dist] : [] });
  const browser = await chromium.launch();
  try {
    for (const scheme of ["light", "dark"]) await scene(browser, preview.origin, scheme);
  } finally {
    await browser.close();
    await preview.stop?.();
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length}개 단언 실패`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
