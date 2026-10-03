#!/usr/bin/env node
// =============================================================================
// 「채널에 공유」 캡처와 실측 (#2867, ADR-0190 D4-b Q4·Q5, ADR-0194 D4).
//
//   npm run build && node scripts/capture-share.mjs
//   → OUT_DIR(기본 ~/.cache/momo-scratch/2867/captures)/*.png + report.json
//
// 진짜 앱 셸을 Chromium으로 연다. 서버·데스크탑 셸은 이 파일의 고정 흉내다:
// - `/v1/**`: 서버 역할을 한다. `POST work-sessions {origin:local_pty}`는 세션을 만들고(카드는 서버가
//   올린다), `work_host_share`(workd가 host 서명으로 보내는 PATCH …/share)는 이 파일이 받아 보드가
//   읽는 공유 목록을 갱신한다. 보드는 그 목록을 `GET …/work-sessions/shared`로 읽는다.
// - `window.__TAURI_INTERNALS__`: pty·git·work_host_status·work_host_share 흉내(capture-pane-chrome과 같은 모양).
//
// 장면(1280·800, 밝음·어두움): 공유 꺼짐 메뉴 · 채널 고르기(기본=저장소 마지막 채널) · 처음 공유(기본 없음) ·
// 링크 복사 확인 · 공유된 칸 머리(표지) · 공유 중 메뉴 · 공유 끄기 뒤 · 호스트 미등록 · 팀 보드에 공유된 세션.
// 재는 것: 켜기 전에는 서버 호출이 없다, POST가 고른 채널로 갔다, 요약 PATCH가 host 서명 경로로 갔다,
// 끄기가 {shared:false}를 보냈다, 보드에 그 세션이 보인다/끈 뒤 사라진다. 틀리면 종료 코드 1이다.
// =============================================================================
import { homedir } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR
  ? resolve(process.env.OUT_DIR)
  : resolve(homedir(), ".cache/momo-scratch/2867/captures");
const PORT = Number(process.env.CAPTURE_PORT || 5203);

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const hostId = "00000000-0000-7000-8000-0000000000aa";
const channels = [
  { id: "00000000-0000-7000-8000-000000000201", workspaceId, kind: "public", name: "workbench", muted: false },
  { id: "00000000-0000-7000-8000-000000000202", workspaceId, kind: "private", name: "agent-lab", muted: false },
  { id: "00000000-0000-7000-8000-000000000203", workspaceId, kind: "public", name: "qa", muted: false },
  { id: "00000000-0000-7000-8000-000000000204", workspaceId, kind: "private", name: "release", muted: false },
];
const chByName = Object.fromEntries(channels.map((c) => [c.name, c]));
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: "ws://share-capture.invalid/connection/websocket",
};
const roster = [
  {
    id: memberId, workspaceId, kind: "human", status: "active", role: "owner", displayName: "곽성재",
    handle: "seongjae", channelCount: 4, channelIds: channels.map((c) => c.id), capabilities: [],
    createdAtMs: 0, updatedAtMs: 0,
  },
];
const LAYOUT_2 = {
  v: 1,
  root: { kind: "split", id: "s20", axis: "row", ratio: 0.5, first: { kind: "pane", id: "p1" }, second: { kind: "pane", id: "p2" } },
  focused: "p1",
  maximized: null,
  seq: 30,
};

const failures = [];
const report = { scenes: [], checks: [] };
function check(name, ok, detail) {
  report.checks.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
  if (!ok) failures.push(name);
}
const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** 서버·호스트 흉내의 상태. 장면마다 새로 만든다. */
function newWorld() {
  return {
    sessions: new Map(), // sessionId -> { label, channelId, tool, folderLabel, summary|null }
    posts: [], // POST work-sessions 본문
    patches: [], // work_host_share로 온 {sessionId, body}
    ended: [],
    n: 0,
  };
}

function boardRow(world, id, now) {
  const s = world.sessions.get(id);
  const sum = s.summary;
  const ch = channels.find((c) => c.id === s.channelId);
  const sec = Math.floor(now / 1000);
  return {
    sessionId: id, origin: "local_pty", label: s.label, folderLabel: s.folderLabel, status: "running",
    owner: { memberId, displayName: "곽성재" }, homeChannel: { id: ch.id, name: ch.name },
    repo: sum.repo, branch: sum.branch, harness: sum.harness, state: sum.state, stages: sum.stages,
    diff: sum.diff, prUrl: sum.prUrl, lastActivityAt: sum.lastActivityAt ?? sec,
    endedAtMs: null, startedAtMs: now - 600_000, sharedAtMs: now - 60_000,
  };
}

async function installRoutes(context, world) {
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
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: [] });
    if (path.endsWith("/work-sessions/shared")) {
      const now = Date.now();
      const rows = [...world.sessions.entries()].filter(([, s]) => s.summary).map(([id]) => boardRow(world, id, now));
      return json(route, { sessions: rows, nextCursor: null });
    }
    const single = /\/work-sessions\/([0-9a-f-]+)\/shared$/.exec(path);
    if (single) {
      const s = world.sessions.get(single[1]);
      return s?.summary ? json(route, { session: boardRow(world, single[1], Date.now()) }) : json(route, { error: { message: "shared work session not found" } }, 404);
    }
    const end = /\/work-sessions\/([0-9a-f-]+)$/.exec(path);
    if (end && req.method() === "PATCH") {
      world.ended.push(end[1]);
      return json(route, { workSession: { id: end[1], status: "ended" } });
    }
    if (path.endsWith("/work-sessions") && req.method() === "POST") {
      const body = JSON.parse(req.postData() || "{}");
      world.posts.push(body);
      const id = `00000000-0000-7000-8000-0000000000b${++world.n}`;
      world.sessions.set(id, { label: body.label, channelId: body.channelId, tool: body.tool, folderLabel: body.folderLabel ?? null, summary: null });
      return json(route, {
        workSession: {
          id, workspaceId, channelId: body.channelId, memberId, hostId: body.hostId, rootMessageId: `00000000-0000-7000-8000-0000000000d${world.n}`,
          tool: body.tool, label: body.label, status: "running", observation: "owner_only", observerGrantCount: 0,
          remoteAttachAvailable: false, remoteDisplayAvailable: false, startedAtMs: Date.now(),
        },
      }, 201);
    }
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
          if (c.connect) return { id: c.id, connect: { client: "share-capture", version: "6" } };
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

const HOST_STATUS_REGISTERED = (origin) => ({
  sidecar: true,
  registered: { hostId, workspaceId, ownerMemberId: memberId, serverUrl: origin },
  running: true,
  heartbeat: { lastOkAtMs: Date.now(), failing: false },
  adapters: [],
  workFolder: "/Users/capture/.oort/work",
  displayNameSuggestion: "성재의 MacBook",
});

/** 데스크탑 셸 흉내. p1=PTY1(oort 저장소), p2=PTY2(momo 저장소, 공유한 적 없는 저장소). */
async function installDesktop(page, { registered, origin, remember }) {
  await page.addInitScript(
    ({ layout, registered, remember, status }) => {
      try {
        localStorage.setItem("momo.web.workbench.layout.v1:dock", JSON.stringify(layout));
        if (remember) localStorage.setItem(`momo.work.shareChannel.v1:${remember.ws}`, JSON.stringify(remember.map));
      } catch {
        /* 저장소 없는 캡처 */
      }
      const callbacks = new Map();
      let nextCallback = 1;
      let nextPty = 1;
      const enc = new TextEncoder();
      const titles = { 1: "한글 입력 이중 전송 수리", 2: "릴리스 노트 초안" };
      const repos = { 1: "oort", 2: "momo" };
      const branches = { 1: "feat/2774-xterm", 2: "docs/changelog" };
      const scripts = {
        1: ["\x1b[38;2;215;119;87m✻\x1b[0m Reviewing WorkbenchGrid.tsx…", "\x1b[2m  ⎿ Read 706 lines\x1b[0m", "", "\x1b[38;2;215;119;87m●\x1b[0m The split refusal holds."],
        2: ["\x1b[36m❯\x1b[0m git log --oneline -3", "\x1b[2m824b909e docs: changelog\x1b[0m", "\x1b[36m❯\x1b[0m "],
      };
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
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
            const text = `\x1b]0;${titles[id] ?? ""}\x07` + (scripts[id] ?? scripts[2]).join("\r\n");
            setTimeout(() => out?.({ index: 0, message: enc.encode(text).buffer.slice(0) }), 30);
            if (args.onSignal) {
              const cb = callbacks.get(args.onSignal.id);
              window.__captureSignal ??= {};
              window.__captureSignal[id] = (value) => cb?.({ index: 0, message: value });
            }
            return id;
          }
          if (cmd === "workbench_git_read") {
            const { command, paneId } = args.request;
            if (command === "g1") return { outcome: "ok", value: { kind: "repo", name: repos[paneId] ?? "momo" } };
            if (command === "g2") return { outcome: "ok", value: { kind: "branch", name: branches[paneId] ?? "main" } };
            if (command === "g4") return { outcome: "ok", value: { kind: "aheadBehind", ahead: 2, behind: 0 } };
            if (command === "g7") return { outcome: "ok", value: { kind: "diff", files: [], totals: { files: 9, added: 128, deleted: 40, binary: 0 } } };
            if (command === "g8") return { outcome: "ok", value: { kind: "status", modified: 3, added: 1, deleted: 0, untracked: 2 } };
            return { outcome: "unknown" };
          }
          if (cmd === "work_host_status") return registered ? status : { ...status, registered: null };
          if (cmd === "work_host_share") {
            await window.__nodeShare(args.sessionId, args.body);
            return null;
          }
          if (cmd === "keychain_store_refresh_token") {
            window.__captureHandle = "shell:" + "c".repeat(32);
            return null;
          }
          if (cmd === "keychain_refresh_token_handle") return window.__captureHandle ?? null;
          if (cmd === "detect_local_harnesses") return { harnesses: [] };
          if (cmd === "detect_hosted_agents") return [];
          if (cmd === "keychain_available") return false;
          if (cmd === "deep_link_take_pending") return [];
          if (cmd === "app_version") return "0.1.11";
          if (cmd === "notification_permission") return "denied";
          if (cmd === "updater_check") return null;
          if (cmd.startsWith("plugin:event|")) return 1;
          return null;
        },
      };
    },
    { layout: LAYOUT_2, registered, origin, remember, status: HOST_STATUS_REGISTERED(origin) }
  );
  await page.addInitScript((server) => {
    try {
      localStorage.setItem("momo.web.server.v1", server);
    } catch {
      /* 저장소 없는 캡처 */
    }
  }, origin);
}

async function signIn(page, origin) {
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("nav-team").waitFor({ timeout: 20_000 });
}

async function shot(page, name) {
  await page.screenshot({ path: resolve(OUT_DIR, `${name}.png`) });
  report.scenes.push(name);
}

/** 한 세계(서버·호스트 흉내)로 앱을 연다. */
async function open(browser, origin, scheme, { registered = true, remember = true } = {}) {
  const world = newWorld();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: scheme, reducedMotion: "reduce", serviceWorkers: "block" });
  await installRoutes(context, world);
  await context.exposeFunction("__nodeShare", (sessionId, body) => {
    world.patches.push({ sessionId, body });
    const s = world.sessions.get(sessionId);
    if (!s) return;
    s.summary = body.shared === true ? body : null;
  });
  const page = await context.newPage();
  await installRealtime(page);
  await installDesktop(page, {
    registered,
    origin,
    remember: remember ? { ws: workspaceId.toLowerCase(), map: { oort: chByName["agent-lab"].id } } : null,
  });
  await signIn(page, origin);
  await page.getByTestId("nav-mine").click();
  await page.getByTestId("my-work-tab").waitFor();
  await page.waitForFunction(() => document.querySelectorAll("[data-testid='my-work-tab'] [data-pane-id] .xterm-rows").length >= 2, null, { timeout: 15_000 });
  await page.waitForTimeout(900);
  return { context, page, world };
}

// 칸 순서와 PTY 번호는 미러 청크 로딩에 따라 달라진다: 칸은 머리의 작업 이름(OSC 제목)으로 찾는다.
// 1 = PTY 1(oort 저장소), 2 = PTY 2(momo 저장소).
const PANE_TITLE = { 1: "한글 입력 이중 전송 수리", 2: "릴리스 노트 초안" };
const paneOf = (page, n) => page.locator(`[data-testid='workbench-pane'][aria-label*='${PANE_TITLE[n]}']`);
async function openPaneMenu(page, n) {
  await paneOf(page, n).hover({ position: { x: 120, y: 12 } });
  await paneOf(page, n).getByTestId("workbench-pane-share-menu").click();
  await page.getByTestId("workbench-pane-share-items").waitFor();
}
const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function scene(browser, origin, scheme) {
  const tag = `1280-${scheme}`;

  // ---- 1. 기본 꺼짐 · 메뉴 · 채널 고르기 · 공유 켜기 · 표지 · 보드 · 끄기 -------------------------------
  {
    const { context, page, world } = await open(browser, origin, scheme);
    check(`${tag} 기본: 칸을 열기만 했을 때 서버 호출·PATCH가 0이다`, world.posts.length === 0 && world.patches.length === 0, { posts: world.posts.length, patches: world.patches.length });
    check(`${tag} 기본: 공유 표지가 없다`, (await page.getByTestId("workbench-pane-share-chip").count()) === 0);
    await openPaneMenu(page, 1);
    check(`${tag} 꺼짐 메뉴: 채널에 공유 · 링크 복사만`, (await page.getByTestId("pane-share-menu-share").innerText()) === "채널에 공유" && (await page.getByTestId("pane-share-menu-copy").innerText()) === "링크 복사" && (await page.getByTestId("pane-share-menu-unshare").count()) === 0);
    await shot(page, `share-menu-off-${tag}`);
    await page.keyboard.press("Escape");

    // 세션 목록 행 우클릭 메뉴: 같은 항목이다.
    await page.getByTestId("session-list-row").first().click({ button: "right" });
    await page.getByTestId("session-list-row-menu").waitFor();
    check(`${tag} 목록 행 메뉴: 채널에 공유 · 링크 복사`, (await page.getByTestId("session-row-menu-share").innerText()) === "채널에 공유" && (await page.getByTestId("session-row-menu-copy").innerText()) === "링크 복사");
    await shot(page, `share-row-menu-${tag}`);
    await page.keyboard.press("Escape");

    await openPaneMenu(page, 1);
    await page.getByTestId("pane-share-menu-share").click();
    await page.getByTestId("share-dialog-channels").waitFor();
    await page.waitForTimeout(250);
    const checkedBefore = await page.evaluate(() => document.querySelector("input[name='share-channel']:checked")?.value ?? null);
    check(`${tag} 채널 고르기: 이 저장소(oort)로 마지막에 공유한 채널(agent-lab)이 골라져 있다`, checkedBefore === chByName["agent-lab"].id, checkedBefore);
    check(`${tag} 채널 고르기: 워크스페이스 전체 공개 선택지가 없다`, (await page.locator("input[name='share-channel']").count()) === channels.length);
    await shot(page, `share-dialog-${tag}`);

    const nameValue = await page.getByTestId("share-dialog-name").inputValue();
    check(`${tag} 이름: 주인이 보는 칸에 기본 이름이 채워져 있고 경로 구분자가 없다`, nameValue.length > 0 && !/[\\/]/.test(nameValue), nameValue);
    await page.getByTestId("share-dialog-name").fill("한글 입력 이중 전송 수리");

    // 다른 채널로 바꿔 공유한다: 고른 것이 집이다.
    await page.locator(`input[name='share-channel'][value='${chByName.workbench.id}']`).check();
    await page.getByTestId("share-dialog-submit").click();
    await page.getByTestId("workbench-pane-share-chip").first().waitFor();
    await page.waitForTimeout(500);
    check(`${tag} 공유: POST가 고른 채널·내 호스트·origin=local_pty로 갔다`, world.posts.length === 1 && world.posts[0].origin === "local_pty" && world.posts[0].channelId === chByName.workbench.id && world.posts[0].hostId === hostId && world.posts[0].folderLabel === "oort", world.posts);
    check(`${tag} 공유: 주인이 확인한 이름이 서버로 갔다`, world.posts[0].label === "한글 입력 이중 전송 수리", world.posts[0].label);
    check(`${tag} 공유: 폴더 전체 경로가 서버로 가지 않는다`, !JSON.stringify(world.posts).includes("/Users/"));
    check(`${tag} 공유: 요약 PATCH가 host 서명 경로(work_host_share)로 갔다`, world.patches.length >= 1 && world.patches[0].body.shared === true && world.patches[0].body.harness === "shell", world.patches.map((p) => p.body.shared));
    const chipText = await page.getByTestId("workbench-pane-share-chip").first().innerText();
    check(`${tag} 공유: 칸 머리에 「공유 중 · #workbench」 표지`, chipText.includes("공유 중 · #workbench"), chipText);
    await paneOf(page, 1).hover({ position: { x: 120, y: 12 } });
    await page.waitForTimeout(250);
    await shot(page, `share-pane-chrome-${tag}`);

    // 좁은 창(900): 표지는 아이콘만 남고 메뉴 단추는 접힌다. 가로 넘침 0.
    await page.setViewportSize({ width: 900, height: 700 });
    await page.waitForTimeout(400);
    check(`${tag} 900: 가로 넘침 0`, (await overflowX(page)) === 0, await overflowX(page));
    await paneOf(page, 1).hover({ position: { x: 100, y: 12 } });
    await shot(page, `share-pane-chrome-900-${tag}`);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(400);

    // 몇 초 뒤 git 숫자가 담긴 갱신이 간다(간격 제한 5초).
    await page.waitForTimeout(6200);
    const last = world.patches.at(-1).body;
    check(`${tag} 갱신: git 숫자(저장소·브랜치·diff)가 S1 필드로 간다`, last.repo === "oort" && last.branch === "feat/2774-xterm" && last.diff?.added === 128, last);
    check(`${tag} 갱신: 보내는 필드가 S1 목록뿐이다(커밋 제목·경로·출력 자리가 없다)`, Object.keys(last).every((k) => ["shared", "repo", "branch", "harness", "state", "stages", "diff", "prUrl", "lastActivityAt"].includes(k)), Object.keys(last));

    await openPaneMenu(page, 1);
    check(`${tag} 공유 중 메뉴: 링크 복사 · 공유 끄기`, (await page.getByTestId("pane-share-menu-unshare").innerText()) === "공유 끄기" && (await page.getByTestId("pane-share-menu-share").count()) === 0);
    await shot(page, `share-menu-on-${tag}`);
    await page.keyboard.press("Escape");

    // 팀 보드: 같은 앱에서 「팀 작업」으로 가면 방금 공유한 세션이 보인다.
    await page.getByTestId("nav-team").click();
    await page.getByTestId("team-work-route").waitFor();
    await page.getByTestId("team-board-row").first().waitFor();
    const boardText = await page.getByTestId("team-work-route").innerText();
    check(`${tag} 팀 보드: 방금 공유한 세션이 보인다(이름·저장소·집 채널)`, boardText.includes("한글 입력 이중 전송 수리") && boardText.includes("oort") && boardText.includes("workbench"), boardText.slice(0, 200));
    check(`${tag} 팀 보드: 가로 넘침 0`, (await overflowX(page)) === 0);
    await shot(page, `team-board-shared-${tag}`);

    // 다시 내 작업으로 돌아와도 공유 상태가 이어진다(도크 ↔ 탭 전환에도 칸 상태가 안 사라진다).
    await page.getByTestId("nav-mine").click();
    await page.getByTestId("my-work-tab").waitFor();
    await page.getByTestId("workbench-pane-share-chip").first().waitFor({ timeout: 8000 });
    check(`${tag} 화면을 오가도 공유 표지가 남는다`, (await page.getByTestId("workbench-pane-share-chip").count()) === 1);

    // 공유 끄기.
    await openPaneMenu(page, 1);
    await page.getByTestId("pane-share-menu-unshare").click();
    await page.waitForFunction(() => document.querySelectorAll("[data-testid='workbench-pane-share-chip']").length === 0, null, { timeout: 8000 });
    await page.waitForTimeout(300);
    const off = world.patches.at(-1);
    check(`${tag} 끄기: 서버에 {shared:false}가 갔다`, off.body.shared === false && Object.keys(off.body).length === 1, off);
    const notice = await page.getByTestId("my-work-tab").innerText();
    check(`${tag} 끄기: 상태 줄이 「공유를 껐어요」`, notice.includes("공유를 껐어요"));
    await shot(page, `share-unshared-${tag}`);
    // 끈 뒤 보드에서 사라진다.
    await page.getByTestId("nav-team").click();
    await page.getByTestId("team-work-route").waitFor();
    await page.waitForTimeout(600);
    check(`${tag} 끄기: 팀 보드에서 그 세션이 사라진다`, (await page.getByTestId("team-board-row").count()) === 0);
    await shot(page, `team-board-after-unshare-${tag}`);
    await context.close();
  }

  // ---- 2. 처음 공유하는 저장소(기억 없음) · 링크 복사 확인 -----------------------------------------------
  {
    const { context, page, world } = await open(browser, origin, scheme, { remember: false });
    await openPaneMenu(page, 2);
    await page.getByTestId("pane-share-menu-copy").click();
    await page.getByTestId("share-dialog-channels").waitFor();
    await page.waitForTimeout(250);
    const checked = await page.evaluate(() => document.querySelector("input[name='share-channel']:checked")?.value ?? null);
    check(`${tag} 처음: 기억이 없으면 채널이 골라져 있지 않다`, checked === null, checked);
    check(`${tag} 링크 복사(꺼짐): 공유 확인이 먼저 뜬다`, (await page.getByTestId("share-dialog").getAttribute("data-intent")) === "copy" && (await page.getByTestId("share-dialog").innerText()).includes("이 세션을 공유할까요?"));
    check(`${tag} 링크 복사(꺼짐): 고르기 전에는 공유 단추가 꺼져 있다`, await page.getByTestId("share-dialog-submit").isDisabled());
    await shot(page, `share-copy-confirm-first-${tag}`);
    await page.getByRole("button", { name: "취소" }).click();
    await page.waitForTimeout(250);
    check(`${tag} 링크 복사(꺼짐): 취소하면 서버 호출이 0이다`, world.posts.length === 0 && world.patches.length === 0);
    await context.close();
  }

  // ---- 3. 호스트 미등록 ---------------------------------------------------------------------------------
  {
    const { context, page, world } = await open(browser, origin, scheme, { registered: false });
    await openPaneMenu(page, 1);
    await page.getByTestId("pane-share-menu-share").click();
    await page.getByTestId("share-dialog-host").waitFor();
    await page.waitForTimeout(250);
    const t = await page.getByTestId("share-dialog").innerText();
    check(`${tag} 호스트 미등록: 등록 안내와 「이 맥 등록하러 가기」`, t.includes("이 맥을 작업 호스트로 먼저 등록") && t.includes("이 맥 등록하러 가기"));
    check(`${tag} 호스트 미등록: 채널 고르기·공유 단추가 없다`, (await page.getByTestId("share-dialog-channels").count()) === 0 && (await page.getByTestId("share-dialog-submit").count()) === 0);
    check(`${tag} 호스트 미등록: 서버 호출이 0이다`, world.posts.length === 0 && world.patches.length === 0);
    await shot(page, `share-host-not-registered-${tag}`);
    await page.getByTestId("share-dialog-host-go").click();
    await page.waitForFunction(() => location.hash.includes("/settings"), null, { timeout: 5000 });
    check(`${tag} 호스트 미등록: 「이 맥」이 있는 설정(code 섹션)으로 간다`, (await page.evaluate(() => location.hash)).includes("section=code"));
    await context.close();
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  try {
    for (const scheme of ["light", "dark"]) await scene(browser, preview.origin, scheme);
  } finally {
    await browser.close();
    await preview.stop();
  }
  writeFileSync(resolve(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));
  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
}

await main();
