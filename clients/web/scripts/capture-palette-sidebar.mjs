#!/usr/bin/env node
// =============================================================================
// ⌘K 「탐색 패널 접기/열기」 명령 측정 (#3299): 명령 줄이 서고, 이름이 상태를 따르고
// (접기/열기), 키캡이 지금 유효한 조합(재지정 포함)이며, 누르면 목록 열이 접히고 펴지는지
// 실제 셸(Chromium)에서 재고 단언한다. capture-rail-unified.mjs와 같은 흉내(/v1·실시간).
//
//   npm run build && node scripts/capture-palette-sidebar.mjs
//   → OUT_DIR(기본 artifacts/palette-sidebar)/*.png
// 단언이 하나라도 틀리면 종료 코드 1이다.
// =============================================================================
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/palette-sidebar");
const PORT = Number(process.env.CAPTURE_PORT || 5198);

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
  await page.getByTestId("rail-team").waitFor({ timeout: 20_000 });
}




const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok) failures.push(`${name} ${detail}`);
}

const cols = (page) => page.evaluate(() => getComputedStyle(document.querySelector(".app-shell")).gridTemplateColumns);
const paletteRow = (page) => page.locator("[data-command-id='view.sidebar']");
async function openPalette(page) {
  await page.keyboard.press("Meta+KeyK");
  await page.getByTestId("quick-switcher").waitFor();
  await page.keyboard.type("탐색 패널");
  await page.waitForTimeout(250);
}

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

  check(`${tag} 시작은 펼침(열 324)`, (await cols(page)).startsWith("324px"), await cols(page));
  await openPalette(page);
  const row = paletteRow(page);
  check(`${tag} 팔레트에 「탐색 패널 접기」 줄이 선다`, (await row.count()) === 1 && (await row.innerText()).includes("탐색 패널 접기"), await row.allInnerTexts());
  check(`${tag} 키캡이 ⌘B다`, JSON.stringify(await row.locator("kbd").allInnerTexts()) === JSON.stringify(["⌘", "B"]) || (await row.locator("kbd").allInnerTexts()).join("") === "⌘B", JSON.stringify(await row.locator("kbd").allInnerTexts()));
  await shot("palette-collapse");
  await row.click();
  await page.waitForTimeout(600);
  check(`${tag} 누르면 팔레트가 닫히고 목록 열이 접힌다(열 56)`, (await page.getByTestId("quick-switcher").count()) === 0 && (await cols(page)).startsWith("56px"), await cols(page));

  await openPalette(page);
  check(`${tag} 접힌 뒤에는 이름이 「탐색 패널 열기」다`, (await paletteRow(page).innerText()).includes("탐색 패널 열기"));
  await shot("palette-open");
  await paletteRow(page).click();
  await page.waitForTimeout(600);
  check(`${tag} 다시 누르면 펴진다(열 324)`, (await cols(page)).startsWith("324px"), await cols(page));

  // 재지정: 키캡이 따라간다.
  await page.evaluate(() => localStorage.setItem("oort.shortcuts.v1", JSON.stringify({ version: 1, bindings: { "toggle-sidebar": { code: "KeyY", shift: true, alt: false } } })));
  await page.reload();
  await page.getByTestId("rail-team").waitFor({ timeout: 20_000 });
  await page.waitForTimeout(500);
  await openPalette(page);
  const caps = (await paletteRow(page).locator("kbd").allInnerTexts()).join("");
  check(`${tag} 재지정하면 키캡이 ⌘⇧Y로 바뀐다`, caps === "⌘⇧Y", caps);
  await shot("palette-rebound");
  await page.keyboard.press("Escape");
  await context.close();
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
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
