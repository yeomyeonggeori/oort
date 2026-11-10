#!/usr/bin/env node
// =============================================================================
// 「작업 · 내 작업」의 「응답 필요」 구간 캡처·실측 (#5640, ADR-0202 D1·D5, ADR-0188 D5).
//
//   npm run build && OUT_DIR=<dir> CAPTURE_PORT=<port> node scripts/capture-5640.mjs
//
// 백엔드가 없다. `/v1/**`는 이 파일의 고정 응답이고, 보드는 #5639 계약을 흉내 낸다: `include=jobs`로 읽는 사람이 세션 주인일
// 때만, 대기 요청이 있는 실행 중 맥 세션의 상태가 `waiting`이다. 승인 원장은 인박스 배지가 읽는 그 경로다. 사람·컴퓨터 이름은
// 가상 인물이다. **라이브 서버·데스크탑 앱·실기기 왕복은 runtime-unverified**다.
//
// 재는 것:
//   - 구간 순서(응답 필요 → 지금 → 끝난 일), 「팀 전체」에는 구간 없음, 가로 넘침 0, 줄 아래 안내 잘림 0
//   - 1280·900·390 × 밝게·어둡게, 200% 확대(1280 창 = CSS 640), 키보드 초점 링
//   - 줄이 구간을 옮길 때(지금 → 응답 필요) 스크롤한 목록의 보던 줄 이동 px와 캐럿 유지. 브라우저의 스크롤 고정을 끄고
//     (`overflow-anchor: none`, 데스크탑 셸 WebKit에는 이 기능이 없다) 화면 코드의 고정만으로 잰다.
//   - 브라우저에서 내 맥 세션 줄 Enter → 세션 화면(작업 콘솔)
// =============================================================================
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(homedir(), ".cache/momo-scratch/5640/captures");
const PORT = Number(process.env.CAPTURE_PORT || 5264);
const ONLY = process.env.CAPTURE_ONLY ?? "";

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const otherId = "00000000-0000-7000-8000-000000000102";
const agentId = "00000000-0000-7000-8000-000000000301";
const hostId = "00000000-0000-7000-8000-000000000401";
const channels = [
  { id: "00000000-0000-7000-8000-000000000201", workspaceId, kind: "public", name: "workbench", muted: false },
  { id: "00000000-0000-7000-8000-000000000202", workspaceId, kind: "public", name: "agent-lab", muted: false },
];
const [bench, lab] = channels;
const me = { memberId, displayName: "김도현" };
const seoyeon = { memberId: otherId, displayName: "이서연" };
const grok = { memberId: agentId, displayName: "그록봇" };
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: me.displayName, handle: "dohyun" },
  realtimeWebSocketUrl: "ws://work-5640-capture.invalid/connection/websocket",
};
const roster = [
  { id: agentId, workspaceId, kind: "agent", status: "active", displayName: grok.displayName, handle: "grok-bot", channelCount: 2, channelIds: channels.map((c) => c.id), capabilities: [], ownerHumanId: memberId, createdAtMs: 0, updatedAtMs: 0 },
  { id: memberId, workspaceId, kind: "human", status: "active", role: "owner", displayName: me.displayName, handle: "dohyun", channelCount: 2, channelIds: channels.map((c) => c.id), capabilities: [], createdAtMs: 0, updatedAtMs: 0 },
  { id: otherId, workspaceId, kind: "human", status: "active", role: "member", displayName: seoyeon.displayName, handle: "seoyeon", channelCount: 2, channelIds: channels.map((c) => c.id), capabilities: [], createdAtMs: 0, updatedAtMs: 0 },
];

const NOW = Date.now();
const sec = Math.floor(NOW / 1000);
const none = { added: null, deleted: null, files: null, ahead: null, behind: null, uncommitted: null };
const id = (n) => `00000000-0000-7000-8000-0000000009${String(n).padStart(2, "0")}`;
const macBase = { source: "session", origin: "host", folderLabel: null, owner: me, homeChannel: { id: lab.id, name: "agent-lab" }, sharedAtMs: NOW - 30 * 60_000, repo: "oort", branch: null, diff: none, stages: [], prUrl: null, status: "running", state: "running", endedAtMs: null };
const runBase = { source: "run", requestedBy: me, origin: "agent_run", folderLabel: null, owner: grok, homeChannel: { id: lab.id, name: "agent-lab" }, sharedAtMs: null, repo: null, harness: "hosted", diff: none, stages: [], branch: null, prUrl: null, endedAtMs: null };

// 내 맥 세션 셋: 하나는 권한 요청을 기다리고(서버가 `waiting`), 하나는 조용하고, 하나는 실측 장면에서 요청이 생긴다.
const macWaiting = { ...macBase, sessionId: id(1), label: "결제 웹훅 재시도 고치기", harness: "claude", startedAtMs: NOW - 18 * 60_000, lastActivityAt: sec - 40 };
const macQuiet = { ...macBase, sessionId: id(2), label: "릴리스 노트 초안 쓰기", harness: "codex", startedAtMs: NOW - 9 * 60_000, lastActivityAt: sec - 120 };
const runApproval = { ...runBase, runId: id(3), label: "#launch 채널에 v0.1.46 공지 올리기", status: "running", state: "running", phase: "awaiting_approval", trigger: "mention", startedAtMs: NOW - 4 * 60_000, stepCount: 1, lastActivityAt: sec - 60 };
const runWorking = { ...runBase, runId: id(4), label: "온보딩 문구 해요체로 다듬기", status: "running", state: "running", phase: "running", trigger: "work", startedAtMs: NOW - 12 * 60_000, stepCount: 2, stages: ["코드 읽기", "문구 고치기"], branch: "feat/onboarding-copy", lastActivityAt: sec - 90 };
const doneRows = Array.from({ length: 12 }, (_, i) => ({
  ...runBase,
  runId: id(10 + i),
  label: [`푸시 알림이 두 번 오는 문제 고치기`, `의존성 라이선스 점검`, `검색 색인 다시 만들기`, `설정 화면 문구 정리`][i % 4] + ` ${i + 1}`,
  status: "done",
  state: "done",
  phase: "succeeded",
  trigger: "work",
  startedAtMs: NOW - (40 + i * 10) * 60_000,
  endedAtMs: NOW - (30 + i * 10) * 60_000,
  stepCount: 3,
  lastActivityAt: sec - (1800 + i * 600),
  ...(i === 0
    ? { prUrl: "https://github.com/example/oort/pull/3521", pr: { url: "https://github.com/example/oort/pull/3521", number: 3521 }, agentReported: { resultKind: "pr_opened", tests: { passed: 128, failed: 0, notRun: 3 }, nextAction: "merge_ok", commitSha: "9f3c2a1b7e", toolCounts: { run: 14, edit: 6, read: 41 } } }
    : {}),
}));
// 남(이서연)의 로컬 공유 터미널: 그 기기의 입력 대기라 누구에게나 `waiting`이다. 「팀 전체」에만 보인다.
const othersTerminal = { source: "session", sessionId: id(5), origin: "local_pty", label: "검색 색인 다시 만들기", folderLabel: "oort", status: "running", owner: seoyeon, homeChannel: { id: bench.id, name: "workbench" }, startedAtMs: NOW - 47 * 60_000, endedAtMs: null, sharedAtMs: NOW - 40 * 60_000, repo: "oort", branch: "fix/index", harness: "claude", state: "waiting", stages: [], diff: { ...none, added: 12, deleted: 3, files: 2 }, prUrl: null, lastActivityAt: sec - 200 };

// 인박스 배지가 읽는 승인 원장: run 하나에 내 결정을 기다리는 승인.
const approvals = [
  { id: id(50), workspaceId, runId: runApproval.runId, channelId: lab.id, requestedBy: agentId, actionType: "tool_call", toolName: "message.send", status: "pending", expiresAtMs: NOW + 30 * 60_000 },
];

const host = { id: hostId, workspaceId, scope: "member", ownerMemberId: memberId, type: "app", displayName: "도현 맥북", capabilities: { terminal: true }, lastSeenAtMs: NOW, createdAtMs: NOW - 86_400_000, online: true };
const ledgerSession = (row) => ({ id: row.sessionId, workspaceId, channelId: lab.id, memberId, hostId, rootMessageId: row.sessionId.replace(/9(\d\d)$/, "8$1"), tool: row.harness, label: row.label, status: "running", observation: "open", observerGrantCount: 0, remoteAttachAvailable: false, remoteDisplayAvailable: false, startedAtMs: row.startedAtMs });

const failures = [];
function check(name, ok, detail) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
  if (!ok) failures.push(name);
}
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** 서버 흉내(#5639): 주인이 `include=jobs`로 읽을 때만 대기 요청이 있는 실행 중 맥 세션이 `waiting`. */
function boardView(state) {
  const view = (row) => (row.origin === "host" && row.owner.memberId === memberId && state.waiting.has(row.sessionId) ? { ...row, state: "waiting" } : row);
  const mine = [macWaiting, runApproval, macQuiet, runWorking, ...doneRows].map(view);
  const team = [macWaiting, runApproval, othersTerminal, macQuiet, runWorking, ...doneRows].map(view);
  return { mine, team };
}

async function installRoutes(context, state) {
  await context.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId });
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/approvals")) return json(route, { approvals: url.searchParams.get("status") === "pending" ? approvals : [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: [host] });
    if (path.endsWith("/work-sessions/shared")) {
      const who = url.searchParams.get("who") === "team" ? "team" : "mine";
      state.boardReads += 1;
      return json(route, { sessions: boardView(state)[who], nextCursor: null, who });
    }
    if (/\/work-sessions\/[^/]+\/shared$/.test(path)) return json(route, { error: { message: "shared work session not found" } }, 404);
    if (path.endsWith("/work-sessions")) return json(route, { workSessions: [ledgerSession(macWaiting), ledgerSession(macQuiet)] });
    if (path.endsWith(`/workspaces/${workspaceId}`)) return json(route, { workspace: { id: workspaceId, name: "새벽 작업실" } });
    if (path.includes("/messages")) return json(route, { messages: [] });
    return json(route, {});
  });
}

async function installRealtime(page) {
  await page.addInitScript(() => {
    // 앱의 쿼리 기본 신선 시간(30초)을 기다리지 않고 「창에 돌아온 사람」을 흉내 내려고 시계를 앞당길 수 있게 한다.
    const actualNow = Date.now.bind(Date);
    let offsetMs = 0;
    Date.now = () => actualNow() + offsetMs;
    window.__capture5640Advance = (byMs) => {
      offsetMs += byMs;
    };
    class CaptureSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      constructor(url) { this.url = String(url); this.readyState = 0; queueMicrotask(() => { this.readyState = 1; this.onopen?.(new Event("open")); }); }
      send(data) {
        const replies = String(data).trim().split("\n").map((line) => {
          const c = JSON.parse(line);
          if (c.connect) return { id: c.id, connect: { client: "work-5640-capture", version: "6" } };
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
  await page.getByTestId("nav-work").waitFor({ timeout: 20_000 });
}

const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
/** 줄 아래 안내·제목이 한 글자라도 잘리면 그 글. 숨은 요소는 세지 않는다. */
const clippedText = (page) =>
  page.evaluate(() => {
    const nodes = document.querySelectorAll('[data-testid="work-job-permission-hint"], [data-testid="work-job-permission-hint"] > span, [data-testid="work-job-row"] [data-col="task"] > span:first-child');
    const out = [];
    for (const el of nodes) {
      if (el.getClientRects().length === 0) continue;
      if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) out.push((el.textContent ?? "").trim());
    }
    return out;
  });
const sectionOrder = (page) => page.$$eval('[data-testid="work-jobs-section"]', (els) => els.map((e) => e.getAttribute("data-section")));
const rowIdsIn = (page, key) =>
  page.$$eval(`[data-testid="work-jobs-section"][data-section="${key}"] [data-testid="work-job-row"]`, (els) => els.map((e) => e.getAttribute("data-job-id")));
const shots = [];
const shot = async (page, name, opts = {}) => {
  await page.screenshot({ path: resolve(OUT_DIR, `${name}.png`), ...opts });
  shots.push(`${name}.png`);
};

async function openContext(browser, origin, { scheme, viewport, deviceScaleFactor = 1, waiting = [macWaiting.sessionId], noNativeAnchor = false }) {
  const state = { waiting: new Set(waiting), boardReads: 0 };
  const context = await browser.newContext({ viewport, deviceScaleFactor, colorScheme: scheme, reducedMotion: "reduce", serviceWorkers: "block", locale: "ko-KR" });
  await installRoutes(context, state);
  const page = await context.newPage();
  await installRealtime(page);
  if (noNativeAnchor) {
    await page.addInitScript(() => {
      const style = document.createElement("style");
      style.textContent = "*, *::before, *::after { overflow-anchor: none !important; }";
      document.addEventListener("DOMContentLoaded", () => document.head.append(style));
    });
  }
  await signIn(page, origin);
  await page.goto(`${origin}/#/work`);
  await page.getByTestId("work-jobs-route").waitFor();
  await page.getByTestId("work-job-row").first().waitFor();
  await page.waitForFunction(() => document.querySelector('[data-section="needsMe"]') !== null || document.querySelectorAll('[data-testid="work-job-row"]').length > 0);
  return { context, page, state };
}

async function scene(browser, origin, scheme, viewport, tag) {
  const { context, page } = await openContext(browser, origin, { scheme, viewport });
  await page.locator('[data-section="needsMe"]').waitFor();
  // 승인 원장(run 줄 재료)이 닿을 때까지.
  await page.waitForFunction(() => document.querySelectorAll('[data-section="needsMe"] [data-testid="work-job-row"]').length === 2);
  check(`${tag} 구간 순서 응답 필요 → 지금 → 끝난 일`, JSON.stringify(await sectionOrder(page)) === JSON.stringify(["needsMe", "now", "done"]), await sectionOrder(page));
  const needs = await rowIdsIn(page, "needsMe");
  check(`${tag} 응답 필요: 서버가 준 맥 세션 + 원장의 run`, JSON.stringify(needs) === JSON.stringify([macWaiting.sessionId, runApproval.runId]), needs);
  const header = (await page.locator('[data-section="needsMe"] h2').innerText()).replace(/\s+/g, " ").trim();
  check(`${tag} 머리글 「응답 필요 2」`, header === "응답 필요 2", header);
  const hint = (await page.getByTestId("work-job-permission-hint").innerText()).replace(/\s+/g, " ").trim();
  check(`${tag} 줄 아래 안내`, hint === "권한 요청이 왔어요 · 허락은 폰이나 데스크탑 앱에서 보내 주세요", hint);
  check(`${tag} 가로 넘침 0`, (await overflowX(page)) === 0, await overflowX(page));
  check(`${tag} 안내·제목 잘림 0`, (await clippedText(page)).length === 0, await clippedText(page));
  await shot(page, `5640-mine-${tag}`);

  if (viewport.width >= 1280) {
    // 키보드 초점 링: 목록의 첫 줄(응답 필요)까지 Tab으로.
    await page.locator('[data-section="needsMe"] [data-testid="work-job-row"]').first().focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowUp");
    const ring = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { testid: el.getAttribute("data-testid"), outline: cs.outlineStyle, width: cs.outlineWidth, visible: el.matches(":focus-visible") };
    });
    check(`${tag} 키보드 초점 링(첫 줄)`, ring?.testid === "work-job-row" && ring.visible && ring.outline !== "none", ring);
    await shot(page, `5640-focus-ring-${tag}`);

    await page.getByTestId("work-jobs-filter-team").click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="work-job-row"]').length === 17);
    check(`${tag} 팀 전체: 구간 없음`, JSON.stringify(await sectionOrder(page)) === JSON.stringify(["now", "done"]), await sectionOrder(page));
    check(`${tag} 팀 전체: 안내 없음`, (await page.getByTestId("work-job-permission-hint").count()) === 0);
    await shot(page, `5640-team-${tag}`);
  }
  await context.close();
}

/** 200% 확대: 1280 창을 200%로 키우면 CSS 폭 640이다. */
async function zoomScene(browser, origin) {
  const { context, page } = await openContext(browser, origin, { scheme: "light", viewport: { width: 640, height: 450 }, deviceScaleFactor: 2 });
  await page.waitForFunction(() => document.querySelectorAll('[data-section="needsMe"] [data-testid="work-job-row"]').length === 2);
  check("zoom200 가로 넘침 0", (await overflowX(page)) === 0, await overflowX(page));
  check("zoom200 안내·제목 잘림 0", (await clippedText(page)).length === 0, await clippedText(page));
  await shot(page, "5640-zoom200-light");
  await context.close();
}

/** 줄이 구간을 옮길 때: 보던 줄 이동 px, 캐럿 유지. 브라우저의 스크롤 고정은 끈다(WebKit 흉내). */
async function jumpScene(browser, origin, scheme) {
  const { context, page, state } = await openContext(browser, origin, { scheme, viewport: { width: 900, height: 700 }, noNativeAnchor: true });
  await page.waitForFunction(() => document.querySelectorAll('[data-section="needsMe"] [data-testid="work-job-row"]').length === 2);
  const anchorOff = await page.evaluate(() => getComputedStyle(document.querySelector(".work-jobs-list")).overflowAnchor);
  check(`jump-${scheme} 브라우저 스크롤 고정 꺼짐`, anchorOff === "none", anchorOff);
  // 끝난 일 중간쯤까지 내려 읽는 중. 「지금」의 조용한 맥 세션 줄에 캐럿이 있다(키보드 사용자).
  await page.evaluate(() => {
    const list = document.querySelector(".work-jobs-list");
    list.scrollTop = 0;
  });
  await page.locator(`[data-testid="work-job-row"][data-job-id="${macQuiet.sessionId}"]`).focus();
  // 「끝난 일」까지 내려 읽는 중: 바뀌는 줄(지금 → 응답 필요)은 모두 화면 위에 있다. 보던 줄 = 화면 맨 위에 온전히 보이는 첫 줄.
  const watched = await page.evaluate((target) => {
    const list = document.querySelector(".work-jobs-list");
    const row = document.querySelector(`[data-testid="work-job-row"][data-job-id="${target}"]`);
    list.scrollTop += row.getBoundingClientRect().top - list.getBoundingClientRect().top;
    list.dispatchEvent(new Event("scroll"));
    return target;
  }, doneRows[2].runId);
  await page.waitForTimeout(100);
  const before = await page.evaluate((rowId) => {
    const list = document.querySelector(".work-jobs-list");
    const row = document.querySelector(`[data-testid="work-job-row"][data-job-id="${rowId}"]`);
    return { top: row.getBoundingClientRect().top - list.getBoundingClientRect().top, scrollTop: list.scrollTop };
  }, watched);
  check(`jump-${scheme} 바뀌는 줄은 화면 위에 있다`, before.scrollTop > 0 && Math.abs(before.top) < 1, before);
  await shot(page, `5640-jump-before-${scheme}`);
  // 서버: 조용하던 맥 세션에 권한 요청이 생겼다. 31초 뒤 창에 돌아온 사람(가시성 변화)이 다시 읽게 한다
  // (실시간 신호 `approval.requested`의 다시 읽기는 jsdom 시험이 잰다 — 같은 다시 그리기 길이다).
  const reads = state.boardReads;
  state.waiting.add(macQuiet.sessionId);
  await page.evaluate(() => {
    window.__capture5640Advance(31_000);
    window.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForFunction((rowId) => document.querySelector(`[data-section="needsMe"] [data-job-id="${rowId}"]`) !== null, macQuiet.sessionId);
  check(`jump-${scheme} 다시 읽음`, state.boardReads > reads, { reads, now: state.boardReads });
  await page.waitForTimeout(100);
  const after = await page.evaluate((rowId) => {
    const list = document.querySelector(".work-jobs-list");
    const row = document.querySelector(`[data-testid="work-job-row"][data-job-id="${rowId}"]`);
    const active = document.activeElement;
    return {
      top: row.getBoundingClientRect().top - list.getBoundingClientRect().top,
      scrollTop: list.scrollTop,
      activeId: active?.getAttribute("data-job-id") ?? active?.tagName ?? null,
    };
  }, watched);
  const moved = Math.round((after.top - before.top) * 100) / 100;
  check(`jump-${scheme} 보던 줄 이동 0px`, moved === 0, { before, after, moved });
  check(`jump-${scheme} 캐럿이 옮긴 줄을 따라감`, after.activeId === macQuiet.sessionId, after.activeId);
  await shot(page, `5640-jump-after-${scheme}`);
  console.log(`MEASURE jump-${scheme}: before.top=${before.top} after.top=${after.top} moved=${moved}px scrollTop ${before.scrollTop}→${after.scrollTop}`);
  await context.close();
}

/** 브라우저에서 내 맥 세션 줄 Enter → 세션 화면(작업 콘솔). */
async function enterScene(browser, origin) {
  const { context, page } = await openContext(browser, origin, { scheme: "light", viewport: { width: 1280, height: 800 } });
  const row = page.locator(`[data-section="needsMe"] [data-job-id="${macWaiting.sessionId}"]`);
  await row.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction((sid) => window.location.hash.includes(`session=${sid}`), macWaiting.sessionId);
  const landed = await page.evaluate(() => window.location.hash);
  check("enter 브라우저: 세션 화면 주소", landed.includes(`session=${macWaiting.sessionId}`) && !landed.includes("card="), landed);
  await page.getByTestId("work-console-route").waitFor({ timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(400);
  await shot(page, "5640-enter-session-light");
  await context.close();
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  try {
    if (ONLY === "" || ONLY === "scenes") {
      for (const scheme of ["light", "dark"]) {
        for (const viewport of [{ width: 1280, height: 800 }, { width: 900, height: 800 }, { width: 390, height: 844 }]) {
          await scene(browser, preview.origin, scheme, viewport, `${viewport.width}-${scheme}`);
        }
      }
    }
    if (ONLY === "" || ONLY === "zoom") await zoomScene(browser, preview.origin);
    if (ONLY === "" || ONLY === "jump") {
      await jumpScene(browser, preview.origin, "light");
      await jumpScene(browser, preview.origin, "dark");
    }
    if (ONLY === "" || ONLY === "enter") await enterScene(browser, preview.origin);
  } finally {
    await browser.close();
    await preview.stop?.();
  }
  console.log(`\n${shots.length} captures in ${OUT_DIR}`);
  if (failures.length > 0) {
    console.error(`\n${failures.length}개 단언 실패`);
    process.exit(1);
  }
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
