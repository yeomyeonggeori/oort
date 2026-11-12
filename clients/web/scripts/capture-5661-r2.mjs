#!/usr/bin/env node
// =============================================================================
// #5661 2회차(owner 2026-11-11): 접힌 사이드바의 「업데이트」 알약과 「작업이 끝나면 다시 시작해요」. 골격은 capture-5661.mjs.
//
//   npm run build:design && OUT_DIR=<dir> CAPTURE_PORT=26522 node scripts/capture-5661-r2.mjs
//
//   1) ⌘B로 접은 사이드바: 처음에는 새 판이 없다. 맥이 한 시간 잤다 깨서 다시 묻고, 레일 아바타 위에 작은 알약(레일 글자 크기)이 선다.
//      레일 항목(워크스페이스 타일·+·대화·인박스·에이전트·작업)·레일 아바타·대화 영역의 자리가 0px 움직이는지 잰다(잴 것이 비어
//      있으면 실패). 밝게·어둡게·200%(640×400 @2x).
//   2) 알약을 눌러 받고 설치를 마쳤는데 이 맥의 작업 데몬에서 세션이 돈다: 카운트다운 대신 「작업이 끝나면 다시 시작해요」와 끊길
//      것 한 줄. 다시 시작하지 않는다. 밝게·어둡게·200%, 그리고 펼친 사이드바 한 장.
// 사람·워크스페이스·컴퓨터 이름은 가상이다.
// =============================================================================
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/5661-r2");
const PORT = Number(process.env.CAPTURE_PORT || 5204);

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
  member: { id: memberId, workspaceId, kind: "human", displayName: "김도현", handle: "dohyun" },
  realtimeWebSocketUrl: "ws://update-capture.invalid/connection/websocket",
};
const roster = [
  {
    id: memberId, workspaceId, kind: "human", status: "active", role: "owner", displayName: "김도현",
    handle: "dohyun", channelCount: 4, channelIds: channels.map((c) => c.id), capabilities: [],
    createdAtMs: 0, updatedAtMs: 0,
  },
];

const HOST_ID = "00000000-0000-7000-8000-0000000000a1";
/** 이 맥 호스트에서 도는 작업 세션 하나(가상). */
function workSessions() {
  return [{
    id: "00000000-0000-7000-8000-000000000301", workspaceId, channelId: channels[0].id, memberId, hostId: HOST_ID,
    rootMessageId: "00000000-0000-7000-8000-000000000401", tool: "claude", label: "릴리스 노트 정리", status: "running",
    observation: "owner_only", observerGrantCount: 0, remoteAttachAvailable: false, remoteDisplayAvailable: false,
    startedAtMs: Date.UTC(2026, 10, 5, 2, 50), origin: "host",
  }];
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
    if (path.endsWith("/work-sessions")) return json(route, { workSessions: workSessions() });
    if (path.endsWith(`/workspaces/${workspaceId}`)) return json(route, { workspace: { id: workspaceId, name: "새벽 스튜디오" } });
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
          if (c.connect) return { id: c.id, connect: { client: "update-capture", version: "6" } };
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

/** `mode`: "none" 새 판 없음 · "offer" 새 판 있음 · "off" 확인하지 않는 판 · "fail" 피드에 닿지 못함. 바꿀 수 있다(`window.__updateMode`). */
async function installDesktop(page, mode) {
  await page.addInitScript((initialMode) => {
    const callbacks = new Map();
    const listeners = new Map();
    let nextCallback = 1;
    window.__updateMode = initialMode;
    window.__checks = [];
    // 이 맥의 작업 데몬: 등록돼 돌고 있다(가상 이름). 그 세션은 원장 경로(/work-sessions)가 준다.
    window.__workHost = {
      sidecar: true,
      registered: {
        hostId: "00000000-0000-7000-8000-0000000000a1",
        workspaceId: "00000000-0000-7000-8000-000000000001",
        ownerMemberId: "00000000-0000-7000-8000-000000000101",
        serverUrl: "http://127.0.0.1",
      },
      running: true,
      heartbeat: { lastOkAtMs: Date.now(), failing: false },
      adapters: [],
      workFolder: "/Users/dohyun/oort",
      displayNameSuggestion: "도현 맥북",
    };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
      transformCallback(callback) {
        const id = nextCallback++;
        callbacks.set(id, callback);
        return id;
      },
      unregisterCallback(id) { callbacks.delete(id); },
      convertFileSrc: (p) => p,
      async invoke(cmd, args) {
        if (cmd === "plugin:event|listen") { listeners.set(args.event, args.handler); return 1; }
        if (cmd.startsWith("plugin:event|")) return 1;
        if (cmd === "updater_check") {
          window.__checks.push(Date.now());
          if (window.__updateMode === "off") throw "updater_disabled";
          if (window.__updateMode === "fail") throw "error sending request";
          return window.__updateMode === "offer"
            ? { version: "0.1.45", currentVersion: "0.1.42", notes: null, publishedAt: null }
            : null;
        }
        if (cmd === "updater_install") return new Promise((done) => setTimeout(() => done(null), 400));
        if (cmd === "updater_relaunch") { window.__relaunched = (window.__relaunched ?? 0) + 1; return null; }
        if (cmd === "work_host_status") return window.__workHost;
        if (cmd === "detect_local_harnesses") return { harnesses: [] };
        if (cmd === "detect_hosted_agents") return [];
        if (cmd === "keychain_available") return true;
        if (cmd === "keychain_store_refresh_token") { window.__kc = true; return null; }
        if (cmd === "keychain_refresh_token_handle") return window.__kc ? "shell:00000000000000000000000000000001" : null;
        if (cmd === "keychain_clear_refresh_token") { window.__kc = false; return null; }
        if (cmd === "deep_link_take_pending") return [];
        if (cmd === "app_version") return "0.1.42";
        if (cmd === "notification_permission") return "denied";
        return null;
      },
    };
  }, mode);
}

const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok) failures.push(`${name} ${detail}`);
}

async function open(browser, origin, scheme, mode, { zoom = false, collapsed = false } = {}) {
  const context = await browser.newContext({
    viewport: zoom ? { width: 640, height: 400 } : { width: 1280, height: 800 },
    deviceScaleFactor: zoom ? 2 : 1,
    colorScheme: scheme,
    locale: "ko-KR",
    serviceWorkers: "block",
  });
  await installRoutes(context);
  const page = await context.newPage();
  await page.clock.install({ time: new Date("2026-11-05T03:09:00Z") });
  await installRealtime(page);
  await installDesktop(page, mode);
  await page.addInitScript((server) => { try { localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ } }, origin);
  if (collapsed) {
    await page.addInitScript(() => {
      try { localStorage.setItem("momo.web.shell.listColumn.collapsed.v1", "1"); } catch { /* 저장소 없는 캡처 */ }
    });
  }
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId(collapsed ? "rail-chat" : "sidebar-profile-foot").waitFor({ timeout: 20_000 });
  await page.waitForTimeout(500);
  // 「업데이트 소식」 창(이 판의 소식)이 처음 한 번 뜬다: 닫고 잰다.
  for (let i = 0; i < 3 && (await page.locator('[role="dialog"]').count()) > 0; i += 1) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  }
  return { context, page };
}

/** 레일 항목·레일 아바타·대화 영역의 자리. 접힌 사이드바에서 재는 것이라 채널 행은 없다(목록 열이 숨는다). */
async function railLayout(page) {
  return page.evaluate(() => {
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 100) / 100);
    };
    const rail = document.querySelector('[data-testid="workspace-rail"]');
    const ids = ["workspace-current", "add-workspace", "rail-chat", "rail-inbox", "rail-agents", "rail-work"];
    return {
      items: ids.map((id) => box(rail?.querySelector(`[data-testid="${id}"]`) ?? null)),
      avatar: box(rail?.querySelector('[data-testid="profile-card"]') ?? null),
      rail: box(rail),
      main: box(document.querySelector("main")),
      scroll: rail ? [rail.scrollHeight, rail.clientHeight, rail.scrollTop] : null,
    };
  });
}

function measurable(l) {
  return l.items.every((b) => b !== null && b[2] > 0) && l.avatar !== null && l.avatar[2] > 0 && l.main !== null && l.main[2] > 0;
}

function same(a, b) {
  return JSON.stringify([a.items, a.avatar, a.rail, a.main]) === JSON.stringify([b.items, b.avatar, b.rail, b.main]);
}

/** 레일 위쪽 항목(워크스페이스·+·목적지)과 대화 영역. 레일이 넘쳐 스크롤되는 창에서도 이것은 움직이면 안 된다. */
function sameTopAndMain(a, b) {
  return JSON.stringify([a.items, a.rail, a.main]) === JSON.stringify([b.items, b.rail, b.main]);
}

/** 알약이 서기 **전에** 레일이 이미 넘쳤나(스크롤 높이 > 보이는 높이). */
function overflowed(l) {
  return l.scroll !== null && l.scroll[0] > l.scroll[1];
}

async function sceneRail(browser, origin, scheme, zoom) {
  const tag = `${scheme}${zoom ? "-200" : ""}`;
  const { context, page } = await open(browser, origin, scheme, "none", { zoom, collapsed: true });
  check(`${tag} 접힘: 목록 열이 숨었다`, (await page.getByTestId("sidebar-channel-pane").isHidden()));
  check(`${tag} 처음에는 알약이 없다(새 판 없음)`, (await page.getByTestId("update-pill").count()) === 0);
  const before = await railLayout(page);
  check(`${tag} 레일 항목·아바타·대화 영역을 잴 수 있다`, measurable(before), JSON.stringify(before));

  await page.evaluate(() => { window.__updateMode = "offer"; });
  await page.clock.fastForward("01:00:00");
  await page.getByTestId("update-pill").waitFor({ timeout: 5_000 }).catch(() => undefined);
  const pill = page.locator('[data-testid="workspace-rail"] [data-testid="update-pill"]');
  check(`${tag} 레일에 알약이 섰다(작은 모양)`, (await pill.count()) === 1 && (await pill.getAttribute("data-placement")) === "rail");
  check(`${tag} 알약의 이름`, (await pill.getAttribute("aria-label"))?.startsWith("업데이트. 0.1.45로") === true, await pill.getAttribute("aria-label"));
  const pillBox = await pill.boundingBox();
  const shown = await railLayout(page);
  check(`${tag} 알약이 레일 폭 안에 있다`, pillBox !== null && shown.rail !== null && pillBox.x >= shown.rail[0] && pillBox.x + pillBox.width <= shown.rail[0] + shown.rail[2], JSON.stringify([pillBox, shown.rail]));
  check(`${tag} 알약이 서도 레일 위쪽 항목·대화 영역 이동 0px`, sameTopAndMain(before, shown), JSON.stringify({ before, shown }));
  if (overflowed(before)) {
    // 이 창에서는 알약 전에 이미 레일이 넘쳐 아바타가 접힌 아래에 걸쳐 있다: 알약 자리만큼 아바타가 스크롤 영역 안에서 내려간다. 숨기지 않고 적는다.
    console.log(`참고 ${tag} 레일이 알약 전에 이미 넘침(스크롤 ${before.scroll[0]} > 보임 ${before.scroll[1]}): 아바타 y ${before.avatar[1]} → ${shown.avatar[1]}`);
  } else {
    check(`${tag} 알약이 서도 레일 아바타 이동 0px`, same(before, shown), JSON.stringify({ before, shown }));
  }
  check(`${tag} 점은 없다`, (await page.locator('[data-testid="workspace-rail"] [data-testid$="-dot"]').count()) === 0);
  check(`${tag} 레일 알약의 설명은 title(레일 타일과 같은 관례)`, ((await pill.getAttribute("title")) ?? "").startsWith("0.1.45로"), await pill.getAttribute("title"));
  await page.screenshot({ path: resolve(OUT_DIR, `5-rail-pill-${tag}.png`) });

  // 받고 설치를 마쳤는데 이 맥의 작업 세션이 돈다: 기다린다. 누르기 전 자리는 알약이 보이게 스크롤한 뒤에 잰다(사람도 그래야 누른다).
  await pill.scrollIntoViewIfNeeded();
  const beforeClick = await railLayout(page);
  await pill.click();
  await page.getByTestId("update-card").waitFor({ timeout: 5_000 });
  await page.waitForFunction(() => document.querySelector('[data-testid="update-card"]')?.getAttribute("data-update-state") === "installed", null, { timeout: 5_000 });
  await page.waitForFunction(() => document.querySelector('[data-testid="update-card-subline"]')?.textContent?.includes("작업 세션 1개"), null, { timeout: 12_000 }).catch(() => undefined);
  const title = await page.getByTestId("update-card-title").textContent();
  const sub = await page.getByTestId("update-card-subline").textContent().catch(() => null);
  check(`${tag} 「작업이 끝나면 다시 시작해요」`, title === "작업이 끝나면 다시 시작해요", title);
  check(`${tag} 끊길 것 한 줄`, sub === "지금 다시 시작하면 끊겨요: 작업 세션 1개", sub);
  check(`${tag} 「지금 다시 시작」`, ((await page.getByTestId("update-card-now").textContent()) ?? "").includes("지금 다시 시작"));
  const held = await railLayout(page);
  check(`${tag} 카드가 떠도 레일·대화 영역 이동 0px`, same(beforeClick, held), JSON.stringify({ beforeClick, held }));
  await page.screenshot({ path: resolve(OUT_DIR, `6-hold-rail-${tag}.png`) });
  await page.waitForTimeout(4_000);
  check(`${tag} 기다리는 동안 다시 시작하지 않는다`, (await page.evaluate(() => window.__relaunched ?? 0)) === 0);
  await context.close();
}

async function sceneHoldRow(browser, origin, scheme) {
  const { context, page } = await open(browser, origin, scheme, "offer");
  await page.getByTestId("update-pill").waitFor({ timeout: 5_000 });
  await page.getByTestId("update-pill").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="update-card-subline"]')?.textContent?.includes("작업 세션 1개"), null, { timeout: 12_000 }).catch(() => undefined);
  check(`${scheme} 펼침: 같은 카드`, (await page.getByTestId("update-card-title").textContent()) === "작업이 끝나면 다시 시작해요");
  await page.screenshot({ path: resolve(OUT_DIR, `7-hold-row-${scheme}.png`) });
  await context.close();
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  try {
    for (const scheme of ["light", "dark"]) {
      await sceneRail(browser, preview.origin, scheme, false);
      await sceneHoldRow(browser, preview.origin, scheme);
    }
    await sceneRail(browser, preview.origin, "light", true);
    await sceneRail(browser, preview.origin, "dark", true);
  } finally {
    await browser.close();
    await preview.stop?.();
  }
  if (failures.length) {
    console.error(`\n${failures.length} FAIL`);
    process.exit(1);
  }
  console.log("\nall ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
