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
//   3) 수리 1회차: 기다리던 작업이 끝나면 닫아 둔 카드가 초점 없이 다시 열려 다시 시작을 예고하고 「지금 말고」로 미룬다. 밝게·어둡게.
//   4) 수리 2회차(Chromium · WebKit): 바깥을 눌러 닫은 카드의 초점과 그 뒤 키 두 번, 접힌 레일 카드와 입력창 독의 겹침(1280×800 ·
//      720×480 · 640×400 @2x), 예고를 Esc로 닫으면 멈춤, 설정 전면의 예고. `ENGINES=chromium,webkit`(기본 둘 다), `SCENES=r2`면 4)만, `R2_ONLY=outside`면 초점 장면만, `R2_ONLY=rail`이면 레일 겹침만(밝게).
// 사람·워크스페이스·컴퓨터 이름은 가상이다.
// =============================================================================
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
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
/** 그 세션의 상태. 수리 1회차 장면(`sceneNotice`)이 「끝남」으로 바꿔 기다림을 푼다. */
let sessionStatus = "running";
/** 이 맥 호스트에서 도는 작업 세션 하나(가상). */
function workSessions() {
  return [{
    id: "00000000-0000-7000-8000-000000000301", workspaceId, channelId: channels[0].id, memberId, hostId: HOST_ID,
    rootMessageId: "00000000-0000-7000-8000-000000000401", tool: "claude", label: "릴리스 노트 정리", status: sessionStatus,
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

async function open(browser, origin, scheme, mode, { zoom = false, collapsed = false, viewport = null } = {}) {
  const context = await browser.newContext({
    viewport: viewport ?? (zoom ? { width: 640, height: 400 } : { width: 1280, height: 800 }),
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
  await fastForward(page, "01:00:00");
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

/** 대화 영역·입력창·프로필 줄의 자리(펼친 사이드바). */
async function chatLayout(page) {
  return page.evaluate(() => {
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 100) / 100);
    };
    return {
      main: box(document.querySelector("main")),
      composer: box(document.querySelector('[data-testid="composer-input"]')),
      foot: box(document.querySelector('[data-testid="sidebar-profile-foot"]')),
    };
  });
}

/** 카드가 열리는 움직임(240ms)이 끝날 때까지: 그 사이에 찍으면 반투명한 카드가 찍힌다. */
const cardSettled = (page) =>
  page.waitForFunction(() => {
    const card = document.querySelector('[data-testid="update-card"]');
    return card !== null && card.getAnimations({ subtree: true }).every((a) => a.playState !== "running");
  }, null, { timeout: 3_000 }).catch(() => undefined);

/**
 * 가짜 시계를 돌린다. 트랙의 실시간 다시 열기(#5666)가 이 캡처의 가짜 소켓을 닫으려다 던지는 오류(`_transport` null)는 시계를 멈추지
 * 않게 삼키고 처음 한 번만 참고로 적는다 — 업데이트 흐름과 무관한, 가짜 소켓의 모자람이다.
 */
let runForNoted = false;
async function runFor(page, ms) {
  const until = (await page.evaluate(() => Date.now())) + ms;
  for (let guard = 0; guard < 50; guard += 1) {
    const now = await page.evaluate(() => Date.now());
    if (now >= until) return;
    try {
      await page.clock.runFor(until - now);
      return;
    } catch (error) {
      if (!runForNoted) {
        runForNoted = true;
        console.log(`참고 가짜 시계를 돌리는 중 페이지 오류를 넘김: ${String(error).split("\n")[0]}`);
      }
    }
  }
}

/** `runFor`와 같은 까닭으로 `clock.fastForward`의 같은 페이지 오류를 넘긴다(시계는 이미 그 시각으로 넘어가 있다). */
async function fastForward(page, spec) {
  try {
    await page.clock.fastForward(spec);
  } catch (error) {
    if (!runForNoted) {
      runForNoted = true;
      console.log(`참고 가짜 시계를 돌리는 중 페이지 오류를 넘김: ${String(error).split("\n")[0]}`);
    }
  }
}

const focusedTestId = (page) => page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.tagName ?? null);

/**
 * 수리 1회차(H2·H3): 기다리던 작업이 끝나면 닫아 둔 카드가 다시 열려 다시 시작을 예고한다. 초점은 글을 쓰던 입력창에 그대로이고,
 * 「지금 말고」로 미룬다. 예고가 뜨고 질 때 대화 영역·입력창·프로필 줄 이동 0px.
 */
async function sceneNotice(browser, origin, scheme) {
  sessionStatus = "running";
  const { context, page } = await open(browser, origin, scheme, "offer");
  try {
    await page.getByTestId("update-pill").waitFor({ timeout: 5_000 });
    await page.getByTestId("update-pill").click();
    await page.waitForFunction(() => document.querySelector('[data-testid="update-card-subline"]')?.textContent?.includes("작업 세션 1개"), null, { timeout: 12_000 });
    // 기다리는 카드를 닫고 입력창으로 돌아가 글을 쓴다.
    await page.keyboard.press("Escape");
    await page.getByTestId("update-card").waitFor({ state: "detached", timeout: 5_000 });
    const composer = page.getByTestId("composer-input");
    await composer.waitFor({ timeout: 10_000 });
    await composer.click();
    await page.keyboard.type("배포 전에 확인할 것");
    const before = await chatLayout(page);
    check(`${scheme} 예고: 대화 영역·입력창·프로필 줄을 잴 수 있다`, [before.main, before.composer, before.foot].every((b) => b !== null && b[2] > 0), JSON.stringify(before));

    // 작업이 끝난다 → 원장 다시 읽기(15초) → 쉬는 시간(2분) → 카운트다운. 5초씩 시계를 돌려 예고가 서는 순간에 멈춘다.
    sessionStatus = "ended";
    for (let i = 0; i < 60 && (await page.getByTestId("update-card").count()) === 0; i += 1) await runFor(page, 5_000);
    const title = await page.getByTestId("update-card-title").textContent().catch(() => null);
    const sub = (await page.getByTestId("update-card-subline").textContent().catch(() => null)) ?? "";
    const left = Number(/(\d+)초 뒤/.exec(sub)?.[1] ?? 0);
    check(`${scheme} 예고: 닫아 둔 카드가 다시 열려 「곧 다시 실행돼요」`, title === "곧 다시 실행돼요", title ?? "카드 없음");
    check(`${scheme} 예고: 남은 시간이 보인다(20초 넘게)`, left > 20, sub);
    check(`${scheme} 예고: 「지금 말고」`, (await page.getByTestId("update-card-defer").textContent()) === "지금 말고");
    check(`${scheme} 예고: 초점은 입력창 그대로`, (await focusedTestId(page)) === "composer-input", await focusedTestId(page));
    check(`${scheme} 예고: 아직 다시 시작하지 않았다`, (await page.evaluate(() => window.__relaunched ?? 0)) === 0);
    const shown = await chatLayout(page);
    check(`${scheme} 예고가 떠도 대화 영역·입력창·프로필 줄 이동 0px`, JSON.stringify(before) === JSON.stringify(shown), JSON.stringify({ before, shown }));
    await cardSettled(page);
    await page.screenshot({ path: resolve(OUT_DIR, `8-notice-${scheme}.png`) });

    await page.getByTestId("update-card-defer").click();
    await page.waitForFunction(() => document.querySelector('[data-testid="update-card-title"]')?.textContent === "다시 실행해 주세요", null, { timeout: 5_000 }).catch(() => undefined);
    check(`${scheme} 미룸: 「다시 실행해 주세요 · 지금」만 남는다`, (await page.getByTestId("update-card-title").textContent()) === "다시 실행해 주세요" && (await page.getByTestId("update-card-defer").count()) === 0);
    await cardSettled(page);
    await page.screenshot({ path: resolve(OUT_DIR, `8-notice-deferred-${scheme}.png`) });
    // 입력창을 눌러 카드를 닫고 계속 쓴다.
    await composer.click();
    await page.getByTestId("update-card").waitFor({ state: "detached", timeout: 5_000 });
    const gone = await chatLayout(page);
    check(`${scheme} 예고가 져도 대화 영역·입력창·프로필 줄 이동 0px`, JSON.stringify(before) === JSON.stringify(gone), JSON.stringify({ before, gone }));
    await runFor(page, 60_000);
    check(`${scheme} 미룬 뒤 1분 동안 다시 시작하지 않는다`, (await page.evaluate(() => window.__relaunched ?? 0)) === 0);
    check(`${scheme} 입력창의 글이 그대로다`, (await composer.inputValue().catch(() => composer.textContent())) === "배포 전에 확인할 것");
  } finally {
    sessionStatus = "running";
    await context.close();
  }
}

/** 두 상자의 겹친 넓이(px²)와 가로·세로. */
function overlap(a, b) {
  if (!a || !b) return null;
  const w = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const h = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  return { w: Math.round(w * 100) / 100, h: Math.round(h * 100) / 100, area: Math.round(w * h) };
}

async function boxOf(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 100) / 100);
  }, selector);
}

/** 기다림 카드를 닫고 입력창에 글을 쓰는 중, 기다리던 작업이 끝나 예고(카운트다운)가 서는 순간까지 시계를 돌린다. */
async function untilNotice(page) {
  sessionStatus = "ended";
  for (let i = 0; i < 60 && (await page.getByTestId("update-card-defer").count()) === 0; i += 1) await runFor(page, 5_000);
  await cardSettled(page);
}

/** 알약을 눌러 받고 설치를 마쳐 기다림 카드가 뜰 때까지. */
async function installAndHold(page, pill) {
  await pill.click();
  await page.waitForFunction(() => document.querySelector('[data-testid="update-card-subline"]')?.textContent?.includes("작업 세션 1개"), null, { timeout: 12_000 });
}

const relaunched = (page) => page.evaluate(() => window.__relaunched ?? 0);

/** H1 길①·②: 바깥을 눌러 닫은 카드는 초점을 알약으로 끌지 않고, 그 뒤 Enter·Space 두 번이 다시 시작을 부르지 않는다. */
async function sceneOutsideFocus(browser, origin, engine) {
  sessionStatus = "running";
  const { context, page } = await open(browser, origin, "light", "offer");
  try {
    const pill = page.getByTestId("update-pill");
    await pill.waitFor({ timeout: 5_000 });
    await installAndHold(page, pill);
    await page.keyboard.press("Escape");
    await page.getByTestId("update-card").waitFor({ state: "detached", timeout: 5_000 });
    const composer = page.getByTestId("composer-input");
    await composer.click();
    await page.keyboard.type("배포 전에 확인할 것");
    // 길①: 알약으로 카드를 보고 입력창을 눌러 돌아온다.
    await pill.click();
    await page.getByTestId("update-card").waitFor({ timeout: 5_000 });
    await cardSettled(page);
    await composer.click();
    await page.waitForTimeout(400);
    const f1 = await focusedTestId(page);
    check(`${engine} 길① 알약으로 연 카드를 입력창을 눌러 닫으면 초점은 입력창`, f1 === "composer-input", f1);
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Space");
    await page.keyboard.press("Space");
    await page.waitForTimeout(300);
    const r1 = await relaunched(page);
    check(`${engine} 길① 그 뒤 키 넷에도 다시 시작 0번·카드 닫힘`, r1 === 0 && (await page.getByTestId("update-card").count()) === 0, `relaunch ${r1}`);
    if (r1 > 0) return; // 다시 시작이 걸린 앱에서는 길②를 잴 수 없다
    // 길②: 저절로 열린 카드(초점은 입력창) → 대화 영역의 글(초점을 받지 않는 곳)을 눌러 닫는다.
    await untilNotice(page);
    check(`${engine} 길② 예고가 저절로 열리고 초점은 입력창`, (await focusedTestId(page)) === "composer-input", await focusedTestId(page));
    const main = await boxOf(page, "main");
    await page.mouse.click(main[0] + main[2] / 2, main[1] + 140);
    await page.waitForTimeout(400);
    const f2 = await focusedTestId(page);
    check(`${engine} 길② 대화를 눌러 닫으면 초점은 알약이 아니다`, f2 !== "update-pill", f2);
    await page.keyboard.press("Space");
    await page.keyboard.press("Space");
    await page.waitForTimeout(300);
    await runFor(page, 60_000);
    check(`${engine} 길② 그 뒤 Space 두 번과 1분에 다시 시작 0번(예고를 닫으면 멈춤)`, (await relaunched(page)) === 0);
    const label = await pill.getAttribute("aria-label");
    check(`${engine} 멈춘 뒤 알약은 「곧」이라고 하지 않는다`, label === "업데이트. 설치를 마쳤어요. 다시 시작하면 새 버전으로 열려요.", label);
  } finally {
    sessionStatus = "running";
    await context.close();
  }
}

/** H2: 접힌 레일에서 저절로 열린 카드(기다림·예고)와 입력창 독의 겹침 0px. 대화 판 상자는 그대로. */
async function sceneRailOverlap(browser, origin, engine, size, scheme = "light") {
  sessionStatus = "running";
  const zoom = size === "640@2x";
  const viewport = size === "720" ? { width: 720, height: 480 } : null;
  const tag = `${engine} ${scheme} ${size}`;
  const { context, page } = await open(browser, origin, scheme, "offer", { collapsed: true, zoom, viewport });
  try {
    const pill = page.locator('[data-testid="workspace-rail"] [data-testid="update-pill"]');
    await pill.waitFor({ timeout: 5_000 });
    await pill.scrollIntoViewIfNeeded();
    await installAndHold(page, pill);
    await cardSettled(page);
    const dock = '[data-composer-shell]';
    const heldOverlap = overlap(await boxOf(page, '[data-testid="update-card"]'), await boxOf(page, dock));
    check(`${tag} 알약으로 연 기다림 카드와 입력창 독 겹침 0`, heldOverlap !== null && heldOverlap.area === 0, JSON.stringify(heldOverlap));
    await page.keyboard.press("Escape");
    await page.getByTestId("update-card").waitFor({ state: "detached", timeout: 5_000 });
    const composer = page.getByTestId("composer-input");
    await composer.click();
    await page.keyboard.type("배포 전에 확인할 것");
    const before = await chatLayout(page);
    await untilNotice(page);
    const card = await boxOf(page, '[data-testid="update-card"]');
    const o = overlap(card, await boxOf(page, dock));
    const vw = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
    check(`${tag} 저절로 열린 예고 카드와 입력창 독 겹침 0`, o !== null && o.area === 0, JSON.stringify({ card, o }));
    check(`${tag} 카드가 창 안에 있다`, card !== null && card[0] >= 0 && card[1] >= 0 && card[0] + card[2] <= vw[0] && card[1] + card[3] <= vw[1], JSON.stringify({ card, vw }));
    check(`${tag} 초점은 입력창`, (await focusedTestId(page)) === "composer-input", await focusedTestId(page));
    const shown = await chatLayout(page);
    check(`${tag} 예고가 떠도 대화 판·입력창 이동 0px`, JSON.stringify([before.main, before.composer]) === JSON.stringify([shown.main, shown.composer]), JSON.stringify({ before, shown }));
    if (engine === "chromium") await page.screenshot({ path: resolve(OUT_DIR, `9-rail-notice-${scheme}-${size}.png`) });
    // 예고를 Esc로 닫으면 멈춘다.
    await page.keyboard.press("Escape");
    await runFor(page, 60_000);
    check(`${tag} 예고를 Esc로 닫으면 1분 동안 다시 시작 0번`, (await relaunched(page)) === 0);
  } finally {
    sessionStatus = "running";
    await context.close();
  }
}

/** 설정 전면: 기다리는 중 ⌘,로 설정에 들어가 있는 동안 작업이 끝나면 목록 아래 알약의 예고 카드가 열린다. */
async function sceneSettingsNotice(browser, origin, engine, scheme = "light") {
  sessionStatus = "running";
  const { context, page } = await open(browser, origin, scheme, "offer");
  try {
    const pill = page.getByTestId("update-pill");
    await pill.waitFor({ timeout: 5_000 });
    await installAndHold(page, pill);
    await page.keyboard.press("Escape");
    await page.getByTestId("update-card").waitFor({ state: "detached", timeout: 5_000 });
    await page.keyboard.press("Meta+Comma");
    await page.getByTestId("settings-nav").waitFor({ timeout: 10_000 });
    check(`${engine} ${scheme} 설정: 목록 아래에 알약`, (await page.locator('[data-testid="settings-restart-notice"] [data-testid="update-pill"]').count()) === 1);
    check(`${engine} ${scheme} 설정: 닫아 둔 카드는 다시 열리지 않는다`, (await page.getByTestId("update-card").count()) === 0);
    await untilNotice(page);
    const title = await page.getByTestId("update-card-title").textContent().catch(() => null);
    check(`${engine} ${scheme} 설정: 예고 카드 「곧 다시 실행돼요」·「지금 말고」`, title === "곧 다시 실행돼요" && (await page.getByTestId("update-card-defer").count()) === 1, title ?? "카드 없음");
    check(`${engine} ${scheme} 설정: 아직 다시 시작 0번`, (await relaunched(page)) === 0);
    if (engine === "chromium") await page.screenshot({ path: resolve(OUT_DIR, `10-settings-notice-${scheme}.png`) });
    await page.getByTestId("update-card-defer").click();
    await runFor(page, 60_000);
    check(`${engine} ${scheme} 설정: 「지금 말고」 뒤 1분 0번`, (await relaunched(page)) === 0);
    // 설정의 Esc는 「가장 위 층」 것이다: 열린 카드가 먼저 닫히고 설정은 남는다.
    await page.keyboard.press("Escape");
    await page.getByTestId("update-card").waitFor({ state: "detached", timeout: 5_000 }).catch(() => undefined);
    check(`${engine} ${scheme} 설정: Esc는 카드만 닫고 설정은 남는다`, (await page.getByTestId("update-card").count()) === 0 && (await page.getByTestId("settings-nav").count()) === 1);
  } finally {
    sessionStatus = "running";
    await context.close();
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const onlyR2 = process.env.SCENES === "r2";
  const engines = (process.env.ENGINES ?? "chromium,webkit").split(",");
  const browser = await chromium.launch();
  try {
    if (!onlyR2) {
      for (const scheme of ["light", "dark"]) {
        await sceneRail(browser, preview.origin, scheme, false);
        await sceneHoldRow(browser, preview.origin, scheme);
        await sceneNotice(browser, preview.origin, scheme);
      }
      await sceneRail(browser, preview.origin, "light", true);
      await sceneRail(browser, preview.origin, "dark", true);
    }
    for (const engine of engines) {
      const b = engine === "webkit" ? await webkit.launch() : browser;
      // 한 장면이 던져도 다음 장면·엔진은 잰다(던진 것은 실패로 센다).
      const guard = async (name, run) => {
        try {
          await run();
        } catch (error) {
          check(`${engine} ${name} 장면이 끝까지 돌았다`, false, String(error).split("\n")[0]);
        }
      };
      try {
        if (process.env.R2_ONLY !== "rail") await guard("길①·②", () => sceneOutsideFocus(b, preview.origin, engine));
        if (process.env.R2_ONLY === "outside") continue;
        for (const size of ["1280", "720", "640@2x"]) await guard(`레일 ${size}`, () => sceneRailOverlap(b, preview.origin, engine, size));
        if (process.env.R2_ONLY === "rail") continue;
        if (engine === "chromium") await guard("레일 어둡게", () => sceneRailOverlap(b, preview.origin, engine, "1280", "dark"));
        await guard("설정", () => sceneSettingsNotice(b, preview.origin, engine));
        if (engine === "chromium") await guard("설정 어둡게", () => sceneSettingsNotice(b, preview.origin, engine, "dark"));
      } finally {
        if (b !== browser) await b.close();
      }
    }
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
