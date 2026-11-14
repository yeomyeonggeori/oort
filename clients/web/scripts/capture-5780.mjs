#!/usr/bin/env node
// =============================================================================
// #5780 캡처 + 실제 브라우저 확인: 멤버 프로필 창(큰 얼굴 · 행동 · 정보(이메일) · 관리)과 역할 바꾸기 확인 단계.
// 백엔드 없음(`/v1/**` 고정 응답, 가짜 소켓, 외부 네트워크 0). 인물은 가상 인물이다(김도현·이서연·이도현·최민수, 에이전트 김인턴).
//
//   npm run build && OUT_DIR=<폴더> node scripts/capture-5780.mjs
//
// 번들 Chromium(헤드리스)만 쓴다. 라이트·다크 × 다음 장면을 찍고, 단언이 하나라도 틀리면 종료 코드 1이다:
//   V. 네 시점(소유자·관리자·멤버·게스트) × 대상(사람·에이전트) — 1280 폭
//   R. 소유자 → 멤버: 고르개 열림 · 확인 단계(일반) · 확인 단계(소유자 승격) · 바뀐 뒤 「바뀜」 · 관리자 → 소유자(잠긴 글)
//   N. 좁은 폭(375) · 200%(1280 창의 200% = 640×450 CSS px, 배율 2)
//   O. 오프라인(사유 줄 자리·잠김) — 프로필 본문과 재설정 단계
//   T. 키보드 길(검수 r1 B1): Tab 정·역방향 정거장과 정거장마다 초점 고리(#5781: 정지·내보내기 줄이 든 여덟 정거장)
//   H. 요청이 나간 뒤의 취소(검수 r1 H1): PATCH 를 늦춘 채 취소 → 단계 그대로·요청 한 번·실제 결과
//   L. 정지·정지 풀기·내보내기(#5781): 시점 × 대상 표대로 줄 유무, 정지 → 칩·「정지 풀기」 → 멤버 탭 「정지됨」 줄로 다시 열기,
//      409(그사이 정지됨) 뒤 다시 읽은 새 상태, 진행 중 잠김, 내보낸 결과와 닫은 뒤 초점, 좁은 폭·200% 의 단계.
//   S. 정지된 사람이 실린 명부(#5781): 멤버 탭의 「정지됨」 묶음(소유자 시점) · 멤버 시점(묶음 없음) · 채널 멤버 패널
//
// 가짜 명부는 서버 #5814(PR #5819) 계약이다: 보는 사람이 활성 소유자·관리자인 사람이면 정지된 **사람**도 `status: "suspended"`
// 로(그 줄에는 `online` 없음), 그 밖은 활성만. `ROSTER_MODE=active` 면 #5814 이전 서버(누구에게나 활성만)로 돈다.
//
//   G. 확정의 첫 500ms(#5781 · #5818 검수 High): 줄을 누르고 250·400ms 뒤 확정을 눌러도 요청 0, 600ms 뒤에는 1 — 1280·390·200%,
//      키보드(Enter 로 열고 Tab → Enter 연타)도 같다.
//
// 장면 일부만: `npm run build && SCENES=T OUT_DIR=<폴더> node scripts/capture-5780.mjs` (Tab 정거장 단정만, 실패하면 종료 코드 1).
// =============================================================================

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "captures/5780");
const PORT = Number(process.env.CAPTURE_PORT || 5780);
const SCHEMES = ["light", "dark"];

const workspaceId = "00000000-0000-7000-8000-000000000001";
const OWNER = "00000000-0000-7000-8000-000000000101";
const ADMIN = "00000000-0000-7000-8000-000000000103";
const MEMBER = "00000000-0000-7000-8000-000000000104";
const GUEST = "00000000-0000-7000-8000-000000000105";
const AGENT = "00000000-0000-7000-8000-000000000102";
const GENERAL = "00000000-0000-7000-8000-000000000202";

const person = (id, kind, displayName, handle, extra = {}) => ({
  id, workspaceId, kind, status: "active", role: "member", displayName, handle, channelCount: 1,
  channelIds: [GENERAL], capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...extra,
});
function freshRoster() {
  return [
    person(OWNER, "human", "김도현", "dohyeon", { role: "owner", email: "dohyeon@dalmuri.example", online: true }),
    person(ADMIN, "human", "이서연", "seoyeon", { role: "admin", email: "seoyeon@dalmuri.example", online: true, statusEmoji: "🏠", statusText: "재택" }),
    person(MEMBER, "human", "이도현", "dohyun", { role: "member", email: "dohyun.lee@dalmuri.example", online: false }),
    person(GUEST, "human", "최민수", "minsu", { role: "guest", email: "minsu@partner.example", presenceStatus: "away", online: true }),
    person(AGENT, "agent", "김인턴", "kim-intern", { ownerHumanId: OWNER, hostOnline: false }),
  ];
}
let roster = freshRoster();
const ROSTER_MODE = process.env.ROSTER_MODE === "active" ? "active" : "5819";
/** 서버 명부(#5814): 위 머리말의 계약. 초대 대기·지워진 사람·정지된 에이전트는 누구에게도 없다. */
function rosterFor(viewerId, asked) {
  const viewer = roster.find((m) => m.id === viewerId);
  // 정지된 사람은 요청이 `?include=suspended` 를 달았을 때만(#5814 다음 회차 계약). 웹 명부 읽기는 늘 단다(`useDirectory`).
  const wide =
    ROSTER_MODE === "5819" && asked && viewer?.kind === "human" && viewer.status === "active" && (viewer.role === "owner" || viewer.role === "admin");
  return roster.flatMap((m) => {
    if (m.status === "active") return [m];
    if (wide && m.kind === "human" && m.status === "suspended") {
      const row = { ...m };
      delete row.online;
      return [row];
    }
    return [];
  });
}
/** `/roster` 를 읽은 횟수(409 뒤 다시 읽기를 잰다). */
let rosterReads = 0;

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const patches = [];
/** 역할 PATCH 응답을 늦춘다(진행 중 취소 장면, 검수 r1 H1). */
let patchDelayMs = 0;
/** 정지·풀기·내보내기 요청 기록(#5781). `lifecycleDelayMs` 는 응답을 늦추고, `lifecycleConflict` 는 그사이 상태가 바뀐 409 를 낸다. */
const lifecycleCalls = [];
let lifecycleDelayMs = 0;
let lifecycleConflict = false;
/** 서버 `MembershipLifecycleError` 문장(`as_swift_message`)과 같은 봉투. */
const refuse = (route, status, message) => json(route, { error: { message } }, status);

async function installRoutes(context, viewerId) {
  const viewer = roster.find((m) => m.id === viewerId);
  const auth = {
    accessToken: "capture-only-not-a-credential",
    refreshToken: "capture-only-not-a-credential",
    member: { id: viewer.id, workspaceId, kind: "human", displayName: viewer.displayName, handle: viewer.handle },
    realtimeWebSocketUrl: "ws://capture-5780.invalid/connection/websocket",
  };
  await context.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId: viewer.id });
    }
    const role = /\/members\/([^/]+)\/role$/.exec(path);
    if (role && method === "PATCH") {
      const body = JSON.parse(route.request().postData() ?? "{}");
      patches.push(`${role[1]}:${body.role}`);
      if (patchDelayMs > 0) await new Promise((done) => setTimeout(done, patchDelayMs));
      roster = roster.map((m) => (m.id === role[1] ? { ...m, role: body.role } : m));
      return json(route, { memberId: role[1], scope: "workspace", role: body.role });
    }
    // #5781: 서버 `routes/member_lifecycle.rs` 와 같은 길·상태 규칙(정지 = 활성만, 풀기 = 정지된 멤버만, 그 밖은 409).
    const lifecycle = /\/members\/([^/]+)(\/suspend|\/reinstate)?$/.exec(path);
    if (lifecycle && lifecycle[1] !== "me" && ((method === "POST" && lifecycle[2]) || (method === "DELETE" && !lifecycle[2]))) {
      const [, id, verb] = lifecycle;
      const action = verb === "/suspend" ? "suspend" : verb === "/reinstate" ? "reinstate" : "remove";
      lifecycleCalls.push(`${id}:${action}`);
      if (lifecycleDelayMs > 0) await new Promise((done) => setTimeout(done, lifecycleDelayMs));
      const target = roster.find((m) => m.id === id);
      if (!target || target.status === "deleted") return refuse(route, 404, "workspace member not found");
      if (lifecycleConflict && action === "suspend") {
        // 그사이 다른 관리자가 먼저 정지했다(검수 r1 M2): 서버 상태는 정지됨, 이 요청은 409.
        roster = roster.map((m) => (m.id === id ? { ...m, status: "suspended" } : m));
        return refuse(route, 409, "member status must be active");
      }
      if (action === "suspend" && target.status !== "active") return refuse(route, 409, "member status must be active");
      if (action === "reinstate" && target.status !== "suspended") return refuse(route, 409, "member status must be suspended");
      const next = action === "suspend" ? "suspended" : action === "reinstate" ? "active" : "deleted";
      roster = roster.map((m) => (m.id === id ? { ...m, status: next } : m));
      return json(route, { memberId: id, status: next });
    }
    if (/\/inbox(\/|$)/.test(path)) return json(route, { items: [], nextCursor: null, unreadCount: 0, approvalsPending: 0 });
    if (path.endsWith("/members/me/sidebar-prefs")) return json(route, { prefs: { version: 1, sections: [], starredChannelIds: [] } });
    if (path.endsWith("/channels")) return json(route, { channels: [{ id: GENERAL, workspaceId, kind: "public", name: "일반", topic: "팀 공지", muted: false }] });
    if (path.endsWith("/roster")) {
      rosterReads += 1;
      return json(route, { members: rosterFor(viewer.id, url.searchParams.get("include") === "suspended") });
    }
    if (path.endsWith("/read-state") && method === "GET") {
      return json(route, { read_states: [{ channel_id: GENERAL, last_read_seq: 9, latest_seq: 9, unread_count: 0, mention_count: 0, marked_unread_before_seq: null }] });
    }
    if (path.endsWith(`/workspaces/${workspaceId}`)) {
      return json(route, { workspace: { id: workspaceId, name: "달무리 스튜디오", slug: "team", updatedAtMs: 1, roleLabels: {}, welcomeAgentMemberId: null, welcomePrompt: "", subscriptionAgentsEnabled: true } });
    }
    if (path.includes("/messages")) return json(route, { messages: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null, participants: [] });
    if (path.endsWith("/approvals")) return json(route, { approvals: [] });
    return json(route, {});
  });
  return auth;
}

async function installSocket(page) {
  await page.addInitScript(() => {
    class CaptureSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      constructor(url) {
        this.url = String(url); this.readyState = 0;
        queueMicrotask(() => { this.readyState = 1; this.onopen?.(new Event("open")); });
      }
      send(data) {
        const replies = String(data).trim().split("\n").map((line) => {
          const c = JSON.parse(line);
          if (c.connect) return { id: c.id, connect: { client: "5780-capture", version: "6" } };
          if (c.subscribe) return { id: c.id, subscribe: { recoverable: false, positioned: false, recovered: false, epoch: "cap", offset: 0 } };
          return { id: c.id };
        });
        queueMicrotask(() => this.onmessage?.(new MessageEvent("message", { data: replies.map((r) => JSON.stringify(r)).join("\n") })));
      }
      close() { this.readyState = 3; this.onclose?.(new CloseEvent("close", { code: 1000 })); }
    }
    window.WebSocket = CaptureSocket;
  });
}

const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`);
  if (!ok) failures.push(name);
}

async function openContext(browser, origin, { scheme, viewerId, width = 1280, height = 900, scale = 1 }) {
  const context = await browser.newContext({
    viewport: { width, height }, colorScheme: scheme, reducedMotion: "reduce", serviceWorkers: "block",
    deviceScaleFactor: scale, locale: "ko-KR", timezoneId: "Asia/Seoul", permissions: ["clipboard-read", "clipboard-write"],
  });
  const auth = await installRoutes(context, viewerId);
  const page = await context.newPage();
  await installSocket(page);
  await page.addInitScript(
    ({ serverBase, session, record }) => {
      try {
        localStorage.setItem("momo.web.server.v1", serverBase);
        localStorage.setItem("momo.web.session.v1", JSON.stringify(session));
        localStorage.setItem("momo.web.appearance.v2", JSON.stringify(record));
        localStorage.setItem("oort.locale.preference", "ko-KR");
      } catch { /* 저장소 없는 캡처 */ }
    },
    {
      serverBase: origin,
      session: { refreshToken: auth.refreshToken, realtimeWebSocketUrl: auth.realtimeWebSocketUrl, member: auth.member },
      record: { v: 2, scheme, theme: "dawnsky", signal: null, density: "comfortable", glass: { on: false } },
    }
  );
  return { context, page };
}

async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
  await page.waitForTimeout(250);
}

const shot = async (page, name) => {
  await settle(page);
  await page.screenshot({ path: resolve(OUT_DIR, `${name}.png`) });
};

const overflowX = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** 창 안에서 가로로 넘치는 것(창보다 넓은 자식)이 있는지. */
const dialogOverflow = (page) =>
  page.evaluate(() => {
    const dialog = document.querySelector('[data-testid="member-profile-dialog"]');
    if (!dialog) return -1;
    const box = dialog.getBoundingClientRect();
    let worst = 0;
    for (const el of dialog.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      worst = Math.max(worst, r.right - box.right, box.left - r.left);
    }
    return Math.round(worst);
  });

async function openProfile(page, targetId) {
  await page.evaluate(() => { location.hash = "#/directory"; });
  const row = page.locator(`[data-testid="directory-row"][data-member-id="${targetId}"]`).first();
  await row.waitFor({ timeout: 20_000 });
  await row.click();
  const dialog = page.getByTestId("member-profile-dialog");
  await dialog.waitFor({ timeout: 10_000 });
  return { row, dialog };
}

/** 초점이 그 줄(또는 그 안)로 돌아오기를 1초까지 기다린다. 돌아온 곳의 이름을 함께 돌려준다. */
async function focusReturnsTo(page, locator) {
  for (let i = 0; i < 20; i += 1) {
    if (await locator.evaluate((el) => el === document.activeElement || el.contains(document.activeElement))) return { ok: true };
    await page.waitForTimeout(50);
  }
  const where = await page.evaluate(() => {
    const a = document.activeElement;
    return a ? `${a.tagName}#${a.getAttribute("data-testid") ?? ""}/${a.getAttribute("aria-label") ?? ""}` : "none";
  });
  return { ok: false, where };
}

/** 창의 위쪽 끝·왼쪽·폭·높이. */
const dialogBox = (page) =>
  page.evaluate(() => {
    const r = document.querySelector('[data-testid="member-profile-dialog"]')?.getBoundingClientRect();
    return r ? { top: r.top, left: r.left, width: r.width, height: r.height } : null;
  });
const boxDelta = (a, b) => {
  const d = { top: Math.abs(b.top - a.top), left: Math.abs(b.left - a.left), width: Math.abs(b.width - a.width), height: b.height - a.height };
  return { ...d, max: Math.max(d.top, d.left, d.width, Math.abs(d.height)) };
};

/**
 * 확인 단계가 서도 창이 뛰지 않는다(#5780 검수 r1 M2: 전에는 548 → 157). 위쪽 끝·왼쪽·폭·**높이**가 그대로다(±0.5px).
 * #5781 검수 r1 M1: 전에는 높이가 「줄지 않는다」만 재서 재설정 단계가 118~190px 자라는 것을 못 잡았다 — 이제 어느 단계도
 * 창을 키우거나 줄이지 않는다. 잰 값은 로그에 남긴다.
 */
async function stageHolds(page, name, before) {
  await settle(page);
  const after = await dialogBox(page);
  const d = boxDelta(before, after);
  console.log(`measure ${name} stage-box ${JSON.stringify({ before, after, delta: d })}`);
  check(`${name} 단계에서 창의 위쪽 끝·폭·높이가 그대로다`, d.max <= 0.5, d);
  return d;
}

/** 그 단추가 창 안에(창의 위·아래 끝 사이) 그리고 화면 안에 다 보인다 — `isVisible()` 은 접힌 아래 단추에서도 참이다(L7). */
const inDialog = (page, testId) =>
  page.evaluate((id) => {
    const dialog = document.querySelector('[data-testid="member-profile-dialog"]')?.getBoundingClientRect();
    const el = document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect();
    if (!dialog || !el || el.height === 0) return { ok: false };
    const ok = el.top >= dialog.top - 0.5 && el.bottom <= dialog.bottom + 0.5 && el.bottom <= window.innerHeight + 0.5 && el.top >= -0.5;
    return { ok, el: { top: el.top, bottom: el.bottom }, dialog: { top: dialog.top, bottom: dialog.bottom }, vh: window.innerHeight };
  }, testId);

/** 큰 얼굴 묶음의 자리. */
const heroBox = (page) =>
  page.evaluate(() => {
    const r = document.querySelector('[data-testid="member-profile-hero"]')?.getBoundingClientRect();
    return r ? { top: r.top, left: r.left, width: r.width, height: r.height } : null;
  });

/**
 * 단계가 선 뒤에도 큰 얼굴 묶음이 처음 자리(±0.5px)에 보이고(`visibility`·가려진 조상 없음), 이름을 말한다(#5780 검수 r2 N2).
 * 넓은 창에서만 자리를 맞댄다 — 좁은 창·200%에서는 단계가 보이도록 바깥 스크롤이 움직일 수 있다.
 */
async function heroStays(page, before, name) {
  const after = await heroBox(page);
  const shown = await page.evaluate(() => {
    const hero = document.querySelector('[data-testid="member-profile-hero"]');
    return !!hero && getComputedStyle(hero).visibility === "visible" && hero.closest('[aria-hidden="true"]') === null;
  });
  const said = ((await text(page, "member-profile-name")) ?? "").includes(name);
  const d = before && after ? Math.max(Math.abs(after.top - before.top), Math.abs(after.left - before.left), Math.abs(after.height - before.height)) : NaN;
  console.log(`measure hero ${JSON.stringify({ before, after, delta: d, shown, said })}`);
  return shown && said && d <= 0.5;
}

const text = (page, id) => page.getByTestId(id).innerText().catch(() => null);
const count = (page, id) => page.getByTestId(id).count();
/** 확정 단추는 선 뒤 500ms 동안 눌림을 받지 않는다(G 장면이 그 시간을 잰다): 사람처럼 받을 준비가 된 뒤 누른다. */
async function clickArmed(page, id) {
  await page.waitForFunction((testId) => document.querySelector(`[data-testid="${testId}"]`)?.getAttribute("data-armed") === "true", id, { timeout: 5_000 });
  await page.getByTestId(id).click();
}

/** V. 네 시점 × 대상(사람·에이전트). */
const VIEWS = [
  { viewer: OWNER, label: "owner", human: MEMBER, expect: { manage: 1, select: 1, options: ["소유자", "관리자", "멤버", "게스트"], email: "dohyun.lee@dalmuri.example", reset: 1, lifecycle: 1 } },
  { viewer: ADMIN, label: "admin", human: OWNER, expect: { manage: 1, select: 0, options: null, email: "dohyeon@dalmuri.example", reset: 0, text: "소유자", lifecycle: 0 } },
  { viewer: MEMBER, label: "member", human: ADMIN, expect: { manage: 0, select: 0, options: null, email: "seoyeon@dalmuri.example", reset: 0, lifecycle: 0 } },
  { viewer: GUEST, label: "guest", human: ADMIN, expect: { manage: 0, select: 0, options: null, email: null, reset: 0, lifecycle: 0 } },
];

async function sceneViews(browser, origin, scheme) {
  for (const view of VIEWS) {
    roster = freshRoster();
    const tag = `${view.label}-${scheme}`;
    const { context, page } = await openContext(browser, origin, { scheme, viewerId: view.viewer });
    try {
      await page.goto(origin, { waitUntil: "domcontentloaded" });
      const { row, dialog } = await openProfile(page, view.human);
      await page.mouse.move(0, 0);
      await shot(page, `V-${tag}-human`);
      const e = view.expect;
      check(`V ${tag} 관리 묶음 ${e.manage}`, (await count(page, "member-profile-manage")) === e.manage);
      check(`V ${tag} 고르개 ${e.select}`, (await count(page, "member-profile-role")) === e.select);
      if (e.text) check(`V ${tag} 고르개 대신 글 「${e.text}」`, (await text(page, "member-profile-role-text")) === e.text);
      check(`V ${tag} 이메일 ${e.email}`, (await count(page, "member-profile-email")) === (e.email ? 1 : 0) && (e.email === null || (await text(page, "member-profile-email")) === e.email));
      check(`V ${tag} 재설정 줄 ${e.reset}`, (await count(page, "member-profile-reset-open")) === e.reset);
      check(`V ${tag} 정지·내보내기 줄 ${e.lifecycle}`,
        (await count(page, "member-profile-suspend")) === e.lifecycle && (await count(page, "member-profile-remove")) === e.lifecycle);
      check(`V ${tag} 종류·상태 줄과 글자 닫기가 없다`, !(await dialog.innerText()).includes("종류") && (await dialog.getByRole("button", { name: "닫기", exact: true }).count()) === 0);
      check(`V ${tag} 창 안에서 넘치지 않는다`, (await dialogOverflow(page)) <= 0, await dialogOverflow(page));
      if (e.options) {
        await page.getByTestId("member-profile-role").click();
        await page.getByRole("listbox").waitFor();
        const opts = (await page.getByRole("option").allTextContents()).map((s) => s.trim());
        check(`V ${tag} 선택지 ${e.options.join("·")}`, JSON.stringify(opts) === JSON.stringify(e.options), opts);
        await page.mouse.move(0, 0);
        await shot(page, `V-${tag}-role-open`);
        await page.keyboard.press("Escape");
        await page.getByRole("listbox").waitFor({ state: "detached" });
        check(`V ${tag} 목록 Esc 는 목록만 닫는다`, await dialog.isVisible());
      }
      // 닫기: 창의 X → 초점이 연 줄로 돌아온다.
      await page.getByTestId("member-profile-close").click();
      await dialog.waitFor({ state: "detached" });
      const xFocus = await focusReturnsTo(page, row);
      check(`V ${tag} X 로 닫으면 초점이 연 줄로 돌아온다`, xFocus.ok, xFocus.where);

      // 에이전트 대상.
      const agent = await openProfile(page, AGENT);
      await page.mouse.move(0, 0);
      await shot(page, `V-${tag}-agent`);
      check(`V ${tag} 에이전트: 라우팅 설정 · 책임자 줄 · 이메일·관리 없음`,
        (await count(page, "member-profile-routing")) === 1 &&
          (await text(page, "member-profile-owner")) === "김도현 님이 관리" &&
          (await count(page, "member-profile-email")) === 0 &&
          (await count(page, "member-profile-manage")) === 0 &&
          (await count(page, "member-profile-suspend")) === 0 &&
          (await count(page, "member-profile-remove")) === 0);
      await page.keyboard.press("Escape");
      await agent.dialog.waitFor({ state: "detached" });
      const escFocus = await focusReturnsTo(page, agent.row);
      check(`V ${tag} Esc 로 닫으면 초점이 연 줄로 돌아온다`, escFocus.ok, escFocus.where);
    } finally {
      await context.close();
    }
  }
}

/** R. 역할 바꾸기 확인 단계. */
async function sceneRole(browser, origin, scheme) {
  roster = freshRoster();
  patches.length = 0;
  const tag = scheme;
  const { context, page } = await openContext(browser, origin, { scheme, viewerId: OWNER });
  try {
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    const { dialog } = await openProfile(page, MEMBER);
    await settle(page);
    const profileBox = await dialogBox(page);
    const profileHero = await heroBox(page);
    // 일반 확인 단계(멤버 → 관리자).
    await page.getByTestId("member-profile-role").click();
    await page.getByRole("option", { name: "관리자" }).click();
    await page.getByTestId("member-profile-role-stage").waitFor();
    check(`R ${tag} 고르면 확인 단계가 서고 요청은 없다`, patches.length === 0);
    // 역할 목록(Radix Popover, 그 판도 role="dialog")은 고른 뒤 닫히며 사라진다. 본문은 이제 단계 아래에 남으므로(M2) 목록이 닫히는
    // 동안 잠깐 같이 있을 수 있다: 목록이 걷힌 뒤에 센다.
    await page.getByRole("listbox").waitFor({ state: "detached" });
    const dialogs = await page.locator('[role="dialog"], [role="alertdialog"]').evaluateAll((els) => els.map((el) => el.getAttribute("data-testid") ?? el.tagName));
    check(`R ${tag} 대화상자는 하나다(겹친 창 없음, §3.4)`, dialogs.length === 1, dialogs);
    check(`R ${tag} 초점은 취소에 있다`, await page.evaluate(() => document.activeElement?.getAttribute("data-testid") === "member-profile-role-stage-cancel"));
    check(`R ${tag} 단계 위에 큰 얼굴 묶음(이름)이 제자리에 보인 채 남는다(검수 r2 N2)`, await heroStays(page, profileHero, "이도현"));
    await page.mouse.move(0, 0);
    await shot(page, `R-${tag}-confirm-general`);
    await stageHolds(page, `R ${tag} 일반`, profileBox);
    // 덮인 본문은 Tab 에 닿지 않는다: 단계 안의 정거장은 취소 → 역할 바꾸기 뿐이다(돌아서 다시 취소).
    const stageStops = [
      await pressTo(page, "Tab", "member-profile-role-stage-confirm"),
      await pressTo(page, "Tab", "member-profile-role-stage-cancel"),
      await pressTo(page, "Shift+Tab", "member-profile-role-stage-confirm"),
    ];
    console.log(`measure R ${tag} stage-tab ${JSON.stringify(stageStops)}`);
    check(`R ${tag} 단계의 Tab 정거장은 취소·역할 바꾸기 둘뿐(덮인 본문에 닿지 않음)`,
      JSON.stringify(stageStops) === JSON.stringify(["member-profile-role-stage-confirm", "member-profile-role-stage-cancel", "member-profile-role-stage-confirm"]), stageStops);
    await page.keyboard.press("Escape");
    await page.getByTestId("member-profile-role-stage").waitFor({ state: "detached" });
    check(`R ${tag} Esc 는 단계만 내린다(요청 없음, 창 남음)`, patches.length === 0 && (await dialog.isVisible()));
    await settle(page);
    const backBox = await dialogBox(page);
    check(`R ${tag} 단계가 내려가면 창이 처음 크기로 돌아온다(±0.5px)`, boxDelta(profileBox, backBox).max <= 0.5, { profileBox, backBox });

    // 소유자 승격 확인 단계.
    await page.getByTestId("member-profile-role").click();
    await page.getByRole("option", { name: "소유자" }).click();
    await page.getByTestId("member-profile-role-stage").waitFor();
    check(`R ${tag} 소유자 승격은 경고 + 위험 단추`,
      ((await text(page, "member-profile-role-stage-warning")) ?? "").endsWith("되돌릴 수 없어요.") &&
        (await page.getByTestId("member-profile-role-stage-confirm").getAttribute("data-tone")) === "destructive");
    await page.mouse.move(0, 0);
    await shot(page, `R-${tag}-confirm-owner`);
    await stageHolds(page, `R ${tag} 소유자`, profileBox);
    await page.getByTestId("member-profile-role-stage-cancel").click();

    // 실제로 바꾼다(멤버 → 관리자) → 「바뀜」. 영수증이 서도 고르개의 오른쪽 끝과 줄 높이가 움직이지 않는다(자리를 미리 잡음).
    const box = async () => page.evaluate(() => {
      const select = document.querySelector('[data-testid="member-profile-role"]')?.getBoundingClientRect();
      const row = document.querySelector('[data-testid="member-profile-role-row"]')?.getBoundingClientRect();
      return { right: select?.right ?? NaN, rowH: row?.height ?? NaN, rowTop: row?.top ?? NaN };
    });
    const before = await box();
    await page.getByTestId("member-profile-role").click();
    await page.getByRole("option", { name: "관리자" }).click();
    await clickArmed(page, "member-profile-role-stage-confirm");
    await page.getByTestId("member-profile-role-stage").waitFor({ state: "detached" });
    await page.waitForFunction(() => document.querySelector('[data-testid="member-profile-role-receipt"]')?.textContent === "바뀜");
    check(`R ${tag} 확인 뒤에만 PATCH 한 번`, JSON.stringify(patches) === JSON.stringify([`${MEMBER}:admin`]), patches);
    await page.waitForFunction(() => document.querySelector('[data-testid="member-profile-role"]')?.getAttribute("data-value") === "admin");
    const after = await box();
    const shift = { right: Math.abs(after.right - before.right), rowH: Math.abs(after.rowH - before.rowH), rowTop: Math.abs(after.rowTop - before.rowTop) };
    console.log(`measure R ${tag} receipt shift ${JSON.stringify(shift)}`);
    check(`R ${tag} 「바뀜」이 서도 고르개 오른쪽 끝·줄 높이·줄 위치가 그대로다(±0.5px)`, shift.right <= 0.5 && shift.rowH <= 0.5 && shift.rowTop <= 0.5, shift);
    await page.mouse.move(0, 0);
    await shot(page, `R-${tag}-changed`);
  } finally {
    await context.close();
  }
}

/** N. 좁은 폭(375)과 200%, 그리고 재설정 단계가 가장 길던 1280 의 이메일 없는 사람(#5781 검수 r1 M1: +190px). */
async function sceneNarrow(browser, origin, scheme) {
  for (const [label, opts, noEmail] of [
    ["375", { width: 375, height: 812, scale: 2 }, false],
    ["zoom200", { width: 640, height: 450, scale: 2 }, false],
    ["1280-noemail", { width: 1280, height: 900, scale: 1 }, true],
    ["375-noemail", { width: 375, height: 812, scale: 2 }, true],
  ]) {
    roster = freshRoster().map((m) => {
      if (!noEmail || m.id !== ADMIN) return m;
      const row = { ...m };
      delete row.email;
      return row;
    });
    const tag = `${label}-${scheme}`;
    const { context, page } = await openContext(browser, origin, { scheme, viewerId: OWNER, ...opts });
    try {
      await page.goto(origin, { waitUntil: "domcontentloaded" });
      await openProfile(page, ADMIN);
      await page.mouse.move(0, 0);
      await shot(page, `N-${tag}-profile`);
      const profileBox = await dialogBox(page);
      check(`N ${tag} 페이지가 가로로 넘치지 않는다`, (await overflowX(page)) <= 0, await overflowX(page));
      check(`N ${tag} 창 안에서 넘치지 않는다`, (await dialogOverflow(page)) <= 0, await dialogOverflow(page));
      // 본문은 안에서 스크롤된다: 맨 아래 관리 묶음까지 닿는다.
      await page.getByTestId("member-profile-reset-open").scrollIntoViewIfNeeded();
      await shot(page, `N-${tag}-profile-bottom`);
      check(`N ${tag} 맨 아래 「재설정 링크 만들기」까지 보인다`, await page.getByTestId("member-profile-reset-open").isVisible());
      await page.getByTestId("member-profile-role").click();
      await page.getByRole("option", { name: "소유자" }).click();
      await page.getByTestId("member-profile-role-stage").waitFor();
      await page.mouse.move(0, 0);
      await shot(page, `N-${tag}-confirm-owner`);
      check(`N ${tag} 확인 단계도 넘치지 않는다`, (await dialogOverflow(page)) <= 0, await dialogOverflow(page));
      await stageHolds(page, `N ${tag} 소유자`, profileBox);
      check(`N ${tag} 확인 단계의 단추가 창 안에 보인다`, await page.getByTestId("member-profile-role-stage-confirm").isVisible());
      await page.getByTestId("member-profile-role-stage-cancel").click();
      await page.getByTestId("member-profile-role-stage").waitFor({ state: "detached" });
      await page.getByTestId("member-profile-role").click();
      await page.getByRole("option", { name: "멤버" }).click();
      await page.getByTestId("member-profile-role-stage").waitFor();
      await page.mouse.move(0, 0);
      await shot(page, `N-${tag}-confirm-general`);
      await stageHolds(page, `N ${tag} 일반`, profileBox);
      await page.getByTestId("member-profile-role-stage-cancel").click();
      await page.getByTestId("member-profile-role-stage").waitFor({ state: "detached" });
      // 재설정 단계(#5781 검수 r1 M1): 창이 자라지 않고, 처음 섰을 때부터 「링크 만들기」가 창 안·화면 안이다.
      await page.getByTestId("member-profile-reset-open").scrollIntoViewIfNeeded();
      await page.getByTestId("member-profile-reset-open").click();
      await page.getByTestId("member-profile-reset-stage").waitFor();
      await page.mouse.move(0, 0);
      await shot(page, `N-${tag}-reset-stage`);
      await stageHolds(page, `N ${tag} 재설정`, profileBox);
      const submitAt = await inDialog(page, "member-profile-reset-submit");
      check(`N ${tag} 재설정 단계의 「링크 만들기」가 처음부터 창 안·화면 안에 다 보인다`, submitAt.ok, submitAt);
      check(`N ${tag} 재설정 단계도 넘치지 않는다`, (await dialogOverflow(page)) <= 0, await dialogOverflow(page));
    } finally {
      await context.close();
    }
  }
}

/** O. 오프라인: 사유 줄이 X 자리와 겹치지 않고 창 모서리 밖으로 번지지 않으며, 잠긴 단추가 그 줄을 가리킨다. */
async function sceneOffline(browser, origin, scheme) {
  roster = freshRoster();
  const tag = scheme;
  const { context, page } = await openContext(browser, origin, { scheme, viewerId: OWNER });
  try {
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => { location.hash = "#/directory"; });
    await page.locator(`[data-testid="directory-row"][data-member-id="${MEMBER}"]`).first().waitFor({ timeout: 20_000 });
    await context.setOffline(true);
    await page.waitForFunction(() => navigator.onLine === false);
    await openProfile(page, MEMBER);
    await page.getByTestId("member-profile-offline").waitFor();
    await page.mouse.move(0, 0);
    await shot(page, `O-${tag}-offline`);
    const geo = await page.evaluate(() => {
      const r = (id) => document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect();
      const banner = r("member-profile-offline");
      const close = r("member-profile-close");
      const dialog = r("member-profile-dialog");
      const overlap = banner && close
        ? Math.max(0, Math.min(banner.right, close.right) - Math.max(banner.left, close.left)) *
          Math.max(0, Math.min(banner.bottom, close.bottom) - Math.max(banner.top, close.top))
        : -1;
      const inset = banner && dialog ? Math.min(banner.left - dialog.left, dialog.right - banner.right, banner.top - dialog.top) : -1;
      return { overlap, inset };
    });
    console.log(`measure O ${tag} ${JSON.stringify(geo)}`);
    check(`O ${tag} 사유 줄과 X 가 겹치지 않는다(겹친 면적 0)`, geo.overlap === 0, geo);
    check(`O ${tag} 사유 줄이 창 가장자리에 붙지 않는다(둥근 모서리 밖으로 번지지 않음)`, geo.inset >= 16, geo);
    check(`O ${tag} 메시지·고르개·재설정이 잠기고 사유 줄을 가리킨다`,
      (await page.getByTestId("member-profile-dm").isDisabled()) &&
        (await page.getByTestId("member-profile-role").isDisabled()) &&
        (await page.getByTestId("member-profile-reset-open").isDisabled()) &&
        (await page.getByTestId("member-profile-role").getAttribute("aria-describedby")) === "member-profile-offline-reason");
    // 재설정 단계에서는 사유 줄이 단계 위의 띠다(창 위 모서리를 따라 둥글게).
    await context.setOffline(false);
    await page.waitForFunction(() => navigator.onLine === true);
    await page.getByTestId("member-profile-offline").waitFor({ state: "detached" });
    await settle(page);
    const profileBox = await dialogBox(page);
    await page.getByTestId("member-profile-reset-open").click();
    await page.getByTestId("member-profile-reset-stage").waitFor();
    // 재설정 단계는 큰 얼굴까지 덮어 선다(#5781 검수 r1 M1): 창 높이가 그대로이고, 바닥 줄(취소·만들기)이 창 안에 다 보인다.
    await page.mouse.move(0, 0);
    await shot(page, `O-${tag}-reset-stage`);
    await stageHolds(page, `O ${tag} 재설정 단계`, profileBox);
    const submitAt = await inDialog(page, "member-profile-reset-submit");
    check(`O ${tag} 재설정 단계의 「링크 만들기」가 창 안·화면 안에 다 보인다`, submitAt.ok, submitAt);
    await context.setOffline(true);
    await page.waitForFunction(() => navigator.onLine === false);
    await page.getByTestId("member-profile-offline").waitFor();
    await page.mouse.move(0, 0);
    await shot(page, `O-${tag}-offline-stage`);
    const band = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="member-profile-offline"]');
      return el ? getComputedStyle(el).borderTopLeftRadius : null;
    });
    check(`O ${tag} 단계 위 띠는 창 모서리를 따라 둥글다`, band === "20px", band);
    await context.setOffline(false);
  } finally {
    await context.close();
  }
}

/** 지금 초점의 이름(`data-testid`, 없으면 태그). */
const activeId = (page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    return a ? a.getAttribute("data-testid") ?? a.tagName : "none";
  });

/** 키를 누르고, 기대한 정거장에 서기를 기다린다(시간이 아니라 조건 — 부하에 걸지 않는다). 2초 안에 안 서면 선 자리를 돌려준다. */
async function pressTo(page, key, expected) {
  await page.keyboard.press(key);
  await page
    .waitForFunction((id) => document.activeElement?.getAttribute("data-testid") === id, expected, { timeout: 2_000 })
    .catch(() => undefined);
  return activeId(page);
}

/** 보이는 툴팁의 글(숨긴 채 떼기를 기다리는 노드는 「툴팁」 표지가 없다). */
const visibleTips = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="tooltip"]')]
      .filter((tip) => getComputedStyle(tip).display !== "none")
      .map((tip) => tip.textContent)
  );

/** 초점이 키보드 초점(:focus-visible)이고 고리(외곽선이나 그림자)가 그려져 있는지. */
const ringShown = (page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    if (!a || a === document.body) return false;
    const cs = getComputedStyle(a);
    return a.matches(":focus-visible") && (cs.outlineStyle !== "none" || cs.boxShadow !== "none");
  });

/**
 * T. 키보드 길 (#5780 검수 r1 B1). 소유자 → 멤버(이메일 있음): Tab 정방향 여덟 정거장, Shift+Tab 역방향 여덟 정거장
 * (#5781: 재설정 다음에 정지 · 워크스페이스에서 내보내기 줄이 든다).
 * 이메일 복사·X 의 툴팁은 키보드 초점에서 뜨는 공용 `Tooltip` 이고, 그 툴팁이 초점 이동 도중에 떼어지면 모달의 초점 가둠이
 * 초점을 대화상자 상자로 끌어갔다(역할 고르개·재설정·X 에 닿지 못함). 정거장마다 초점 고리가 보이는 그림을 남긴다.
 * 에이전트 프로필(라우팅 설정 · X)도 같은 길을 잰다.
 */
const PROFILE_STOPS = [
  "member-profile-dm",
  "member-profile-copy-mention",
  "member-profile-email-copy",
  "member-profile-role",
  "member-profile-reset-open",
  "member-profile-suspend",
  "member-profile-remove",
  "member-profile-close",
];
const AGENT_STOPS = ["member-profile-dm", "member-profile-copy-mention", "member-profile-routing", "member-profile-close"];

async function walk(page, stops, tag, { shots = false } = {}) {
  const forward = [await activeId(page)];
  const tipsAt = {};
  for (let i = 1; i < stops.length; i += 1) {
    forward.push(await pressTo(page, "Tab", stops[i]));
    tipsAt[stops[i]] = await visibleTips(page);
    if (shots) {
      check(`T ${tag} 정방향 ${stops[i]} 에 초점 고리가 보인다`, await ringShown(page));
      await shot(page, `T-${tag}-fwd-${i}-${stops[i].replace("member-profile-", "")}`);
    }
  }
  // 끝에서 한 번 더 Tab → 처음으로 돈다(초점 가둠).
  forward.push(await pressTo(page, "Tab", stops[0]));
  const backward = [];
  const reversed = [...stops].reverse();
  for (const id of reversed) {
    backward.push(await pressTo(page, "Shift+Tab", id));
    if (shots && id === stops[0]) {
      check(`T ${tag} 역방향 ${id} 에 초점 고리가 보인다`, await ringShown(page));
      await shot(page, `T-${tag}-back-${id.replace("member-profile-", "")}`);
    }
  }
  console.log(`measure T ${tag} forward ${JSON.stringify(forward)}`);
  console.log(`measure T ${tag} backward ${JSON.stringify(backward)}`);
  console.log(`measure T ${tag} visible-tooltips ${JSON.stringify(tipsAt)}`);
  return { forward, backward, tipsAt };
}

async function sceneTab(browser, origin, scheme) {
  roster = freshRoster();
  const tag = scheme;
  const { context, page } = await openContext(browser, origin, { scheme, viewerId: OWNER });
  try {
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await openProfile(page, MEMBER);
    await page.mouse.move(0, 0);
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "member-profile-dm");
    const human = await walk(page, PROFILE_STOPS, `${tag}-member`, { shots: true });
    check(`T ${tag} 멤버: 정방향 메시지 → 멘션 → 이메일 복사 → 역할 → 재설정 → 정지 → 내보내기 → X → (처음)`,
      JSON.stringify(human.forward) === JSON.stringify([...PROFILE_STOPS, PROFILE_STOPS[0]]), human.forward);
    check(`T ${tag} 멤버: 역방향은 같은 정거장을 거꾸로`,
      JSON.stringify(human.backward) === JSON.stringify([...PROFILE_STOPS].reverse()), human.backward);
    // 전제가 섰는지: 툴팁 단추에 닿으면 그 툴팁이 실제로 떠 있었다(안 뜨면 이 결함은 재현되지 않아 위 단정이 헛돈다).
    check(`T ${tag} 멤버: 이메일 복사·X 에 닿으면 그 툴팁 하나가 떠 있다`,
      JSON.stringify(human.tipsAt["member-profile-email-copy"]) === JSON.stringify(["이메일 복사"]) &&
        JSON.stringify(human.tipsAt["member-profile-close"]) === JSON.stringify(["프로필 닫기"]), human.tipsAt);
    // 초점이 나가며 숨긴 채 한 박자 남는 툴팁 노드(`hidden`)가 이 앱의 CSS 아래에서도 실제로 안 보이는지(display:none).
    const hiddenDisplay = await page.evaluate(() => {
      const wrap = document.querySelector('[data-testid="member-profile-close"]')?.parentElement;
      const probe = document.createElement("span");
      // `TOOLTIP_CLASS` + 아래 방향 + 나타남 모션(tooltip.tsx 와 같은 클래스).
      probe.className = "tooltip-surface layer-content-float absolute left-1/2 -translate-x-1/2 text-meta top-full mt-1 motion-tooltip-enter";
      probe.hidden = true;
      probe.textContent = "probe";
      wrap?.append(probe);
      const display = getComputedStyle(probe).display;
      probe.remove();
      return display;
    });
    check(`T ${tag} 숨긴 툴팁 노드는 display:none 이다(보이는 닫힘은 즉시)`, hiddenDisplay === "none", hiddenDisplay);
    await page.keyboard.press("Escape");
    await page.getByTestId("member-profile-dialog").waitFor({ state: "detached" });

    await openProfile(page, AGENT);
    await page.mouse.move(0, 0);
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "member-profile-dm");
    const agent = await walk(page, AGENT_STOPS, `${tag}-agent`);
    check(`T ${tag} 에이전트: 정·역방향 네 정거장`,
      JSON.stringify(agent.forward) === JSON.stringify([...AGENT_STOPS, AGENT_STOPS[0]]) &&
        JSON.stringify(agent.backward) === JSON.stringify([...AGENT_STOPS].reverse()), agent);
  } finally {
    await context.close();
  }
}

/**
 * H. 요청이 나간 뒤의 「취소」 (#5780 검수 r1 H1). PATCH 를 늦춘 채 확정 → 「바꾸는 중」 동안 취소를 누른다. 취소는 잠겨 있고
 * (`aria-disabled`) 단계는 그대로 서며 요청은 한 번이다. 끝나면 화면이 실제 결과(바뀐 역할)를 보인다. 소유자 승격 길 포함.
 */
async function sceneInFlightCancel(browser, origin, scheme) {
  for (const [label, target, optionName, to] of [
    ["plain", GUEST, "멤버", "member"],
    ["owner", ADMIN, "소유자", "owner"],
  ]) {
    roster = freshRoster();
    patches.length = 0;
    patchDelayMs = 1_500;
    const tag = `${scheme}-${label}`;
    const { context, page } = await openContext(browser, origin, { scheme, viewerId: OWNER });
    try {
      await page.goto(origin, { waitUntil: "domcontentloaded" });
      await openProfile(page, target);
      await page.getByTestId("member-profile-role").click();
      await page.getByRole("option", { name: optionName }).click();
      await page.getByTestId("member-profile-role-stage").waitFor();
      await clickArmed(page, "member-profile-role-stage-confirm");
      await page.waitForFunction(() => document.querySelector('[data-testid="member-profile-role-stage-confirm"]')?.getAttribute("aria-busy") === "true");
      const cancel = page.getByTestId("member-profile-role-stage-cancel");
      const lockedAttr = await cancel.getAttribute("aria-disabled");
      // 사람의 누름 그대로: `aria-disabled` 단추도 눌리게 Playwright 의 사용 가능 검사를 건너뛴다.
      await cancel.click({ force: true });
      const stageAfterCancel = await page.getByTestId("member-profile-role-stage").count();
      await page.mouse.move(0, 0);
      await shot(page, `H-${tag}-cancel-in-flight`);
      await page.getByTestId("member-profile-role-stage").waitFor({ state: "detached", timeout: 15_000 });
      await page.waitForFunction(
        (expected) => {
          const select = document.querySelector('[data-testid="member-profile-role"]');
          const text = document.querySelector('[data-testid="member-profile-role-text"]');
          return expected === "owner" ? text?.textContent === "소유자" : select?.getAttribute("data-value") === expected;
        },
        to,
        { timeout: 15_000 }
      ).catch(() => undefined);
      const settled = await page.evaluate(() => ({
        select: document.querySelector('[data-testid="member-profile-role"]')?.getAttribute("data-value") ?? null,
        text: document.querySelector('[data-testid="member-profile-role-text"]')?.textContent ?? null,
        receipt: document.querySelector('[data-testid="member-profile-role-receipt"]')?.textContent ?? null,
      }));
      const result = { lockedAttr, stageAfterCancel, patches: [...patches], settled };
      console.log(`measure H ${tag} ${JSON.stringify(result)}`);
      check(`H ${tag} 진행 중 취소: 잠겨 있고 단계가 그대로이며 요청은 한 번, 끝나면 실제 결과를 보인다`,
        lockedAttr === "true" &&
          stageAfterCancel === 1 &&
          patches.length === 1 &&
          (to === "owner" ? settled.text === "소유자" : settled.select === to) &&
          settled.receipt === "바뀜", result);
      await shot(page, `H-${tag}-settled`);
    } finally {
      patchDelayMs = 0;
      await context.close();
    }
  }
}

/**
 * L. 정지 · 정지 풀기 · 워크스페이스에서 내보내기 (#5781). 실제 엔진에서:
 *   - 시점(소유자·관리자·멤버·게스트) × 대상 표대로 줄이 서고 안 선다(서버 사다리: 자기보다 낮은 역할만, 자기 자신·소유자 불가).
 *   - 정지 → 확인 단계(겹친 창 없음 · 초점 취소 · 얼굴 그대로 · 창 크기 그대로) → 요청 한 번 → 명부에서 빠져도 「정지됨」 칩과
 *     「정지 풀기」·영수증, 초점은 「정지 풀기」 → 정지 풀기 → 칩이 사라지고 「정지」.
 *   - 그사이 상태가 바뀐 409 → 단계 안 사유 문장. 진행 중에는 취소·Esc·바깥 누름이 단계를 내리지 못하고 요청은 한 번.
 *   - 내보내기 → 되돌릴 수 없다는 경고 → 결과 한 줄과 「닫기」(초점), 명부의 그 줄은 사라진다.
 */
const LIFECYCLE_TABLE = [
  { viewer: OWNER, label: "owner", targets: [[ADMIN, 1], [MEMBER, 1], [GUEST, 1], [AGENT, 0], [OWNER, 0]] },
  { viewer: ADMIN, label: "admin", targets: [[OWNER, 0], [MEMBER, 1], [GUEST, 1], [AGENT, 0]] },
  { viewer: MEMBER, label: "member", targets: [[GUEST, 0], [ADMIN, 0]] },
  { viewer: GUEST, label: "guest", targets: [[MEMBER, 0], [OWNER, 0]] },
];

async function sceneLifecycle(browser, origin, scheme) {
  const tag = scheme;
  // 표: 시점 × 대상.
  for (const row of LIFECYCLE_TABLE) {
    roster = freshRoster();
    const { context, page } = await openContext(browser, origin, { scheme, viewerId: row.viewer });
    try {
      await page.goto(origin, { waitUntil: "domcontentloaded" });
      const seen = [];
      for (const [targetId, expected] of row.targets) {
        const { dialog } = await openProfile(page, targetId);
        const got = [await count(page, "member-profile-suspend"), await count(page, "member-profile-remove")];
        seen.push(`${roster.find((m) => m.id === targetId).handle}:${got.join("")}`);
        check(`L ${tag} ${row.label} → ${roster.find((m) => m.id === targetId).handle} 정지·내보내기 줄 ${expected}`, got[0] === expected && got[1] === expected, got);
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "detached" });
      }
      console.log(`measure L ${tag} table ${row.label} ${JSON.stringify(seen)}`);
    } finally {
      await context.close();
    }
  }

  // 정지 → 정지 풀기 (소유자 → 멤버).
  roster = freshRoster();
  lifecycleCalls.length = 0;
  {
    const { context, page } = await openContext(browser, origin, { scheme, viewerId: OWNER });
    try {
      await page.goto(origin, { waitUntil: "domcontentloaded" });
      const { dialog } = await openProfile(page, MEMBER);
      await settle(page);
      const profileBox = await dialogBox(page);
      const hero = await heroBox(page);
      await page.mouse.move(0, 0);
      await shot(page, `L-${tag}-profile`);
      await page.getByTestId("member-profile-suspend").click();
      await page.getByTestId("member-profile-lifecycle-stage").waitFor();
      const dialogs = await page.locator('[role="dialog"], [role="alertdialog"]').count();
      check(`L ${tag} 정지 단계: 대화상자 하나 · 요청 없음 · 초점 취소 · 위험 단추`,
        dialogs === 1 && lifecycleCalls.length === 0 &&
          (await activeId(page)) === "member-profile-lifecycle-stage-cancel" &&
          (await page.getByTestId("member-profile-lifecycle-stage-confirm").getAttribute("data-tone")) === "destructive",
        { dialogs, calls: [...lifecycleCalls], active: await activeId(page) });
      check(`L ${tag} 정지 단계 위에 큰 얼굴 묶음이 제자리에 남는다`, await heroStays(page, hero, "이도현"));
      await page.mouse.move(0, 0);
      await shot(page, `L-${tag}-suspend-stage`);
      await stageHolds(page, `L ${tag} 정지`, profileBox);
      const stops = [
        await pressTo(page, "Tab", "member-profile-lifecycle-stage-confirm"),
        await pressTo(page, "Tab", "member-profile-lifecycle-stage-cancel"),
      ];
      check(`L ${tag} 정지 단계의 Tab 정거장은 취소·정지 둘뿐`,
        JSON.stringify(stops) === JSON.stringify(["member-profile-lifecycle-stage-confirm", "member-profile-lifecycle-stage-cancel"]), stops);
      await clickArmed(page, "member-profile-lifecycle-stage-confirm");
      await page.getByTestId("member-profile-lifecycle-stage").waitFor({ state: "detached" });
      await page.waitForFunction(() => document.querySelector('[data-testid="member-profile-status-chip"]')?.textContent === "정지됨", null, { timeout: 10_000 }).catch(() => undefined);
      // #5814 명부: 그 사람은 멤버 탭의 「정지됨」 묶음으로 옮겨 남는다. 옛 서버(ROSTER_MODE=active): 명부에서 빠지고 창은 붙든 값으로 남는다.
      const behind = page.locator(`[data-testid="directory-row"][data-member-id="${MEMBER}"]`);
      const behindSuspended = page.locator(`[data-testid="directory-suspended"] [data-testid="directory-row"][data-member-id="${MEMBER}"]`);
      if (ROSTER_MODE === "5819") await behindSuspended.waitFor({ timeout: 10_000 }).catch(() => undefined);
      else await behind.waitFor({ state: "detached", timeout: 10_000 }).catch(() => undefined);
      const after = {
        calls: [...lifecycleCalls],
        chip: await text(page, "member-profile-status-chip"),
        reinstate: await text(page, "member-profile-reinstate"),
        receipt: await text(page, "member-profile-lifecycle-receipt"),
        rowBehind: await behind.count(),
        rowInSuspended: await behindSuspended.count(),
        presence: await count(page, "member-profile-presence"),
        active: await activeId(page),
        empty: await count(page, "member-profile-empty"),
      };
      console.log(`measure L ${tag} suspended ${JSON.stringify(after)}`);
      const rowOk = ROSTER_MODE === "5819" ? after.rowBehind === 1 && after.rowInSuspended === 1 : after.rowBehind === 0;
      check(`L ${tag} 정지 뒤: 요청 한 번, 「정지됨」 칩 · 「정지 풀기」 · 영수증, 접속 낱말 없음, 초점 「정지 풀기」, 뒤 멤버 탭 줄(${ROSTER_MODE})`,
        JSON.stringify(after.calls) === JSON.stringify([`${MEMBER}:suspend`]) && after.chip === "정지됨" && after.reinstate === "정지 풀기" &&
          after.receipt === "정지함" && rowOk && after.presence === 0 && after.active === "member-profile-reinstate" && after.empty === 0, after);
      await page.mouse.move(0, 0);
      await shot(page, `L-${tag}-suspended`);
      if (ROSTER_MODE === "5819") {
        // 창을 닫으면 초점이 그 사람의 줄(이제 「정지됨」 묶음)로 돌아오고, 그 줄로 다시 열면 「정지 풀기」가 선다.
        await page.getByTestId("member-profile-close").click();
        await dialog.waitFor({ state: "detached" });
        const back = await focusReturnsTo(page, behindSuspended);
        check(`L ${tag} 정지 뒤 X: 초점이 멤버 탭 「정지됨」 묶음의 그 줄로`, back.ok, back);
        await page.mouse.move(0, 0);
        await shot(page, `L-${tag}-directory-suspended`);
        await behindSuspended.click();
        await dialog.waitFor();
        await page.getByTestId("member-profile-reinstate").waitFor({ timeout: 10_000 }).catch(() => undefined);
        check(`L ${tag} 「정지됨」 줄로 다시 열면 칩과 「정지 풀기」`,
          (await text(page, "member-profile-status-chip")) === "정지됨" && (await count(page, "member-profile-reinstate")) === 1);
      }
      // 정지 풀기.
      await page.getByTestId("member-profile-reinstate").click();
      await page.getByTestId("member-profile-lifecycle-stage").waitFor();
      check(`L ${tag} 정지 풀기 단계는 잉크 단추`, (await page.getByTestId("member-profile-lifecycle-stage-confirm").getAttribute("data-tone")) === "default");
      await page.mouse.move(0, 0);
      await shot(page, `L-${tag}-reinstate-stage`);
      await clickArmed(page, "member-profile-lifecycle-stage-confirm");
      await page.getByTestId("member-profile-lifecycle-stage").waitFor({ state: "detached" });
      await page.getByTestId("member-profile-suspend").waitFor({ timeout: 10_000 }).catch(() => undefined);
      await page.getByTestId("member-profile-status-chip").waitFor({ state: "detached", timeout: 10_000 }).catch(() => undefined);
      const back = { calls: [...lifecycleCalls], chip: await count(page, "member-profile-status-chip"), suspend: await text(page, "member-profile-suspend"), receipt: await text(page, "member-profile-lifecycle-receipt") };
      check(`L ${tag} 정지 풀기 뒤: 칩이 사라지고 「정지」 · 영수증 「풀림」`,
        back.calls.length === 2 && back.calls[1] === `${MEMBER}:reinstate` && back.chip === 0 && back.suspend === "정지" && back.receipt === "풀림", back);
      await dialog.isVisible();
    } finally {
      await context.close();
    }
  }

  // 그사이 상태가 바뀐 409, 그리고 진행 중 잠김(관리자 → 게스트).
  roster = freshRoster();
  lifecycleCalls.length = 0;
  {
    const { context, page } = await openContext(browser, origin, { scheme, viewerId: ADMIN });
    try {
      await page.goto(origin, { waitUntil: "domcontentloaded" });
      await openProfile(page, GUEST);
      lifecycleConflict = true;
      const readsBefore = rosterReads;
      await page.getByTestId("member-profile-suspend").click();
      await clickArmed(page, "member-profile-lifecycle-stage-confirm");
      await page.getByTestId("member-profile-lifecycle-stage-error").waitFor({ timeout: 10_000 }).catch(() => undefined);
      const sentence = await text(page, "member-profile-lifecycle-stage-error");
      // 옛 서버(ROSTER_MODE=active)는 다시 읽은 명부에서 그 사람을 빼므로 문장 대신 곧 「찾을 수 없음」이 선다(아래).
      if (ROSTER_MODE === "5819") {
        check(`L ${tag} 409(그사이 상태가 바뀜) → 단계 안 사유 문장, 단계는 그대로`,
          sentence === "이 멤버는 지금 활성 상태가 아니에요. 그사이 다른 사람이 정지했을 수 있어요." && (await count(page, "member-profile-lifecycle-stage")) === 1, sentence);
      }
      await page.mouse.move(0, 0);
      await shot(page, `L-${tag}-409`);
      lifecycleConflict = false;
      // 검수 r1 M2: 409 뒤 명부를 다시 읽는다. #5814 명부면 취소한 뒤 창이 서버의 지금(「정지됨」·「정지 풀기」)을 보인다.
      await page.waitForFunction((n) => n > 0, rosterReads - readsBefore, { timeout: 5_000 }).catch(() => undefined);
      const reread = rosterReads - readsBefore;
      if (ROSTER_MODE === "5819") {
        await page.getByTestId("member-profile-lifecycle-stage-cancel").click();
        await page.getByTestId("member-profile-reinstate").waitFor({ timeout: 10_000 }).catch(() => undefined);
        const now = { reread, chip: await text(page, "member-profile-status-chip"), reinstate: await count(page, "member-profile-reinstate"), suspend: await count(page, "member-profile-suspend") };
        check(`L ${tag} 409 뒤 명부를 다시 읽고, 취소하면 「정지됨」 칩 · 「정지 풀기」`, now.reread >= 1 && now.chip === "정지됨" && now.reinstate === 1 && now.suspend === 0, now);
        await page.mouse.move(0, 0);
        await shot(page, `L-${tag}-409-reread`);
      } else {
        // 옛 서버: 다시 읽은 명부에 그 사람이 없다 → 「찾을 수 없음」, X 가 선다.
        await page.getByTestId("member-profile-empty").waitFor({ timeout: 10_000 }).catch(() => undefined);
        check(`L ${tag} 409 뒤(옛 서버) 명부를 다시 읽고 「찾을 수 없음」 · X`, reread >= 1 && (await count(page, "member-profile-empty")) === 1 && (await count(page, "member-profile-close")) === 1);
      }
    } finally {
      lifecycleConflict = false;
      await context.close();
    }
  }

  // 진행 중 잠김(관리자 → 게스트, 같은 단계에서 확정 → 늦게 오는 동안 취소·Esc·바깥 누름이 단계를 내리지 못한다).
  roster = freshRoster();
  lifecycleCalls.length = 0;
  {
    const { context, page } = await openContext(browser, origin, { scheme, viewerId: ADMIN });
    try {
      await page.goto(origin, { waitUntil: "domcontentloaded" });
      await openProfile(page, GUEST);
      await page.getByTestId("member-profile-suspend").click();
      lifecycleDelayMs = 1_500;
      lifecycleCalls.length = 0;
      await clickArmed(page, "member-profile-lifecycle-stage-confirm");
      await page.waitForFunction(() => document.querySelector('[data-testid="member-profile-lifecycle-stage-confirm"]')?.getAttribute("aria-busy") === "true");
      const locked = await page.getByTestId("member-profile-lifecycle-stage-cancel").getAttribute("aria-disabled");
      await page.getByTestId("member-profile-lifecycle-stage-cancel").click({ force: true });
      await page.keyboard.press("Escape");
      await page.mouse.click(8, 8);
      const held = { locked, stage: await count(page, "member-profile-lifecycle-stage"), dialog: await count(page, "member-profile-dialog"), calls: lifecycleCalls.length };
      await page.mouse.move(0, 0);
      await shot(page, `L-${tag}-in-flight`);
      await page.getByTestId("member-profile-lifecycle-stage").waitFor({ state: "detached", timeout: 15_000 }).catch(() => undefined);
      await page.waitForFunction(() => document.querySelector('[data-testid="member-profile-status-chip"]')?.textContent === "정지됨", null, { timeout: 10_000 }).catch(() => undefined);
      const settled = { chip: await text(page, "member-profile-status-chip"), calls: [...lifecycleCalls] };
      console.log(`measure L ${tag} in-flight ${JSON.stringify({ held, settled })}`);
      check(`L ${tag} 진행 중: 취소 잠김 · 취소·Esc·바깥 누름에도 단계와 창이 그대로 · 요청 한 번 · 끝나면 「정지됨」`,
        held.locked === "true" && held.stage === 1 && held.dialog === 1 && held.calls === 1 && settled.chip === "정지됨" && settled.calls.length === 1, { held, settled });
    } finally {
      lifecycleDelayMs = 0;
      lifecycleConflict = false;
      await context.close();
    }
  }

  // 내보내기(소유자 → 게스트).
  roster = freshRoster();
  lifecycleCalls.length = 0;
  {
    const { context, page } = await openContext(browser, origin, { scheme, viewerId: OWNER });
    try {
      await page.goto(origin, { waitUntil: "domcontentloaded" });
      const { dialog } = await openProfile(page, GUEST);
      await settle(page);
      const profileBox = await dialogBox(page);
      const heroBefore = await heroBox(page);
      await page.getByTestId("member-profile-remove").click();
      await page.getByTestId("member-profile-lifecycle-stage").waitFor();
      check(`L ${tag} 내보내기 단계: 되돌릴 수 없다는 경고 + 위험 단추`,
        (await text(page, "member-profile-lifecycle-stage-warning")) === "되돌릴 수 없어요. 다시 초대해도 같은 이메일로는 이 워크스페이스에 들어올 수 없어요." &&
          (await page.getByTestId("member-profile-lifecycle-stage-confirm").getAttribute("data-tone")) === "destructive");
      await page.mouse.move(0, 0);
      await shot(page, `L-${tag}-remove-stage`);
      await stageHolds(page, `L ${tag} 내보내기`, profileBox);
      await clickArmed(page, "member-profile-lifecycle-stage-confirm");
      await page.getByTestId("member-profile-removed").waitFor({ timeout: 10_000 });
      const behind = page.locator(`[data-testid="directory-row"][data-member-id="${GUEST}"]`);
      await behind.waitFor({ state: "detached", timeout: 10_000 }).catch(() => undefined);
      const done = { calls: [...lifecycleCalls], line: await text(page, "member-profile-removed"), active: await activeId(page), x: await count(page, "member-profile-close"), rowBehind: await behind.count() };
      console.log(`measure L ${tag} removed ${JSON.stringify(done)}`);
      check(`L ${tag} 내보낸 뒤: 요청 한 번 · 결과 한 줄 · 초점 「닫기」 · X 없음 · 명부의 줄 사라짐`,
        JSON.stringify(done.calls) === JSON.stringify([`${GUEST}:remove`]) && (done.line ?? "").includes("최민수 님을 워크스페이스에서 내보냈어요.") &&
          done.active === "member-profile-removed-close" && done.x === 0 && done.rowBehind === 0, done);
      // 내보낸 결과는 단계가 아니라 「그 사람이 없어진」 화면이다(검수 r1 M5): 큰 얼굴 아래 접속 낱말 줄이 빠진다. 창의 위·왼쪽·
      // 폭은 그대로이고, 높이는 **그 줄만큼만** 준다(얼굴 묶음의 높이 변화와 창의 높이 변화가 같다, ±0.5px) — 다른 자리는 뛰지 않는다.
      await settle(page);
      const resultBox = boxDelta(profileBox, await dialogBox(page));
      const heroAfter = await heroBox(page);
      const heroShrink = heroAfter.height - heroBefore.height;
      console.log(`measure L ${tag} 내보낸 결과 ${JSON.stringify({ resultBox, heroShrink })}`);
      check(`L ${tag} 내보낸 결과: 창의 위·폭 그대로, 높이 변화는 얼굴 아래 접속 줄이 빠진 만큼뿐`,
        resultBox.top <= 0.5 && resultBox.left <= 0.5 && resultBox.width <= 0.5 && heroShrink <= 0 && Math.abs(resultBox.height - heroShrink) <= 0.5,
        { resultBox, heroShrink });
      await page.mouse.move(0, 0);
      await shot(page, `L-${tag}-removed`);
      check(`L ${tag} 내보낸 결과에 접속 낱말·상태 칩이 없다`,
        (await count(page, "member-profile-presence")) === 0 && (await count(page, "member-profile-status-chip")) === 0);
      await page.getByTestId("member-profile-removed-close").click();
      await dialog.waitFor({ state: "detached" });
      // 검수 r1 M3: 연 줄이 사라졌으니 초점은 그 목록의 다음 줄(에이전트 김인턴)로 — 문서 맨 위가 아니다.
      const next = await focusReturnsTo(page, page.locator(`[data-testid="directory-row"][data-member-id="${AGENT}"]`));
      console.log(`measure L ${tag} focus-after-removed-close ${JSON.stringify(next)}`);
      check(`L ${tag} 내보낸 뒤 닫으면 초점이 멤버 탭의 다음 줄로`, next.ok, next);
    } finally {
      await context.close();
    }
  }

  // 좁은 폭·200%: 정지·내보내기 단계의 단추가 바깥 스크롤 안에 보이고, 창이 넘치지 않는다.
  for (const [label, opts] of [
    ["375", { width: 375, height: 812, scale: 2 }],
    ["zoom200", { width: 640, height: 450, scale: 2 }],
  ]) {
    roster = freshRoster();
    const { context, page } = await openContext(browser, origin, { scheme, viewerId: OWNER, ...opts });
    try {
      await page.goto(origin, { waitUntil: "domcontentloaded" });
      await openProfile(page, MEMBER);
      await settle(page);
      const profileBox = await dialogBox(page);
      for (const [opener, name] of [["member-profile-suspend", "suspend"], ["member-profile-remove", "remove"]]) {
        await page.getByTestId(opener).scrollIntoViewIfNeeded();
        await page.getByTestId(opener).click();
        await page.getByTestId("member-profile-lifecycle-stage").waitFor();
        await settle(page);
        const inView = await page.evaluate(() => {
          const scroller = document.querySelector('[data-testid="member-profile-scroll"]')?.getBoundingClientRect();
          const button = document.querySelector('[data-testid="member-profile-lifecycle-stage-confirm"]')?.getBoundingClientRect();
          return !!scroller && !!button && button.top >= scroller.top - 0.5 && button.bottom <= scroller.bottom + 0.5;
        });
        check(`L ${tag} ${label} ${name} 단계의 확정 단추가 창 안에 보인다`, inView);
        check(`L ${tag} ${label} ${name} 단계가 창 안에서 넘치지 않는다`, (await dialogOverflow(page)) <= 0, await dialogOverflow(page));
        check(`L ${tag} ${label} 페이지가 가로로 넘치지 않는다`, (await overflowX(page)) <= 0, await overflowX(page));
        await stageHolds(page, `L ${tag} ${label} ${name}`, profileBox);
        await page.mouse.move(0, 0);
        await shot(page, `L-${tag}-${label}-${name}-stage`);
        await page.keyboard.press("Escape");
        await page.getByTestId("member-profile-lifecycle-stage").waitFor({ state: "detached" });
      }
    } finally {
      await context.close();
    }
  }
}

/** G. 확정의 첫 500ms. 시각은 줄을 누른 순간부터 잰다(Playwright 한 동작의 지연만큼 늦을 수 있어 잰 값을 로그에 남긴다). */
async function sceneGuard(browser, origin, scheme) {
  for (const [label, opts] of [
    ["1280", { width: 1280, height: 900, scale: 1 }],
    ["390", { width: 390, height: 844, scale: 2 }],
    ["zoom200", { width: 640, height: 450, scale: 2 }],
  ]) {
    roster = freshRoster();
    lifecycleCalls.length = 0;
    const tag = `${label}-${scheme}`;
    const { context, page } = await openContext(browser, origin, { scheme, viewerId: OWNER, ...opts });
    try {
      await page.goto(origin, { waitUntil: "domcontentloaded" });
      await openProfile(page, MEMBER);
      await settle(page);
      for (const [opener, action] of [["member-profile-suspend", "suspend"], ["member-profile-remove", "remove"]]) {
        await page.getByTestId(opener).scrollIntoViewIfNeeded();
        await settle(page);
        const row = await page.getByTestId(opener).boundingBox();
        const at = { x: row.x + row.width / 2, y: row.y + row.height / 2 };
        const t0 = Date.now();
        await page.mouse.click(at.x, at.y);
        const confirm = page.getByTestId("member-profile-lifecycle-stage-confirm");
        await confirm.waitFor();
        const tries = [];
        for (const ms of [250, 400]) {
          await page.waitForTimeout(Math.max(0, ms - (Date.now() - t0)));
          const box = await confirm.boundingBox();
          // 둘째 누름 둘: 같은 좌표(줄을 누른 자리)와 확정 단추 한가운데.
          await page.mouse.click(at.x, at.y);
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          tries.push({ ms: Date.now() - t0, underRow: at.y >= box.y && at.y <= box.y + box.height && at.x >= box.x && at.x <= box.x + box.width });
        }
        await page.waitForTimeout(150);
        const early = { calls: lifecycleCalls.length, stage: await count(page, "member-profile-lifecycle-stage"), tries };
        await page.waitForTimeout(Math.max(0, 650 - (Date.now() - t0)));
        const box = await confirm.boundingBox();
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForFunction((n) => n, null, { timeout: 100 }).catch(() => undefined);
        await page.getByTestId("member-profile-lifecycle-stage").waitFor({ state: "detached", timeout: 10_000 }).catch(() => undefined);
        const late = { calls: [...lifecycleCalls] };
        console.log(`measure G ${tag} ${action} ${JSON.stringify({ early, late })}`);
        check(`G ${tag} ${action}: 250·400ms 의 둘째 누름은 확정 요청 0, 600ms 뒤에는 한 번`,
          early.calls === 0 && early.stage === 1 && late.calls.length === 1 && late.calls[0] === `${MEMBER}:${action}`, { early, late });
        if (action === "suspend") {
          // 되돌려 둔다(정지 풀기는 이 장면의 대상이 아니다): 서버 상태만 되돌리고 창을 다시 연다.
          roster = roster.map((m) => (m.id === MEMBER ? { ...m, status: "active" } : m));
          lifecycleCalls.length = 0;
          await page.keyboard.press("Escape").catch(() => undefined);
          await page.getByTestId("member-profile-close").click().catch(() => undefined);
          await page.getByTestId("member-profile-dialog").waitFor({ state: "detached", timeout: 5_000 }).catch(() => undefined);
          await page.reload({ waitUntil: "domcontentloaded" });
          await openProfile(page, MEMBER);
          await settle(page);
        }
      }
    } finally {
      await context.close();
    }
  }
  // 키보드: 줄에서 Enter 로 열고(초점은 취소) Tab → Enter 를 바로 이어 눌러도 요청 0, 600ms 뒤 Enter 는 한 번.
  roster = freshRoster();
  lifecycleCalls.length = 0;
  {
    const { context, page } = await openContext(browser, origin, { scheme, viewerId: OWNER });
    try {
      await page.goto(origin, { waitUntil: "domcontentloaded" });
      await openProfile(page, MEMBER);
      await settle(page);
      await page.getByTestId("member-profile-suspend").focus();
      const t0 = Date.now();
      await page.keyboard.press("Enter");
      await page.keyboard.press("Enter");
      const afterDouble = { calls: lifecycleCalls.length, stage: await count(page, "member-profile-lifecycle-stage") };
      // 둘째 Enter 는 초점이 선 취소에 닿아 단계를 내린다(확정이 아니다). 다시 열고 Tab → Enter 연타.
      if (afterDouble.stage === 0) await page.keyboard.press("Enter");
      const t1 = Date.now();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Enter");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(150);
      const early = { calls: lifecycleCalls.length, active: await activeId(page), ms: Date.now() - t1 };
      await page.waitForTimeout(Math.max(0, 650 - (Date.now() - t1)));
      await page.keyboard.press("Enter");
      await page.getByTestId("member-profile-lifecycle-stage").waitFor({ state: "detached", timeout: 10_000 }).catch(() => undefined);
      const late = { calls: [...lifecycleCalls], total: Date.now() - t0 };
      console.log(`measure G keyboard-${scheme} ${JSON.stringify({ afterDouble, early, late })}`);
      check(`G keyboard-${scheme}: Enter 연타·Tab → Enter 연타(500ms 안)는 요청 0, 600ms 뒤 Enter 는 한 번`,
        afterDouble.calls === 0 && early.calls === 0 && early.active === "member-profile-lifecycle-stage-confirm" &&
          late.calls.length === 1 && late.calls[0] === `${MEMBER}:suspend`, { afterDouble, early, late });
    } finally {
      await context.close();
    }
  }
}

/** S. 정지된 사람이 실린 명부(#5781): 최민수(게스트, 자리 비움 + 접속 중이던 사람)가 정지돼 있다. */
async function sceneSuspended(browser, origin, scheme) {
  for (const view of [
    { viewer: OWNER, label: "owner", group: ROSTER_MODE === "5819" ? 1 : 0 },
    { viewer: MEMBER, label: "member", group: 0 },
  ]) {
    roster = freshRoster().map((m) => (m.id === GUEST ? { ...m, status: "suspended" } : m));
    const tag = `${view.label}-${scheme}`;
    const { context, page } = await openContext(browser, origin, { scheme, viewerId: view.viewer });
    try {
      await page.goto(origin, { waitUntil: "domcontentloaded" });
      await page.evaluate(() => { location.hash = "#/directory"; });
      await page.locator('[data-testid="directory-row"]').first().waitFor({ timeout: 20_000 });
      await settle(page);
      const seen = await page.evaluate((guest) => {
        const group = document.querySelector('[data-testid="directory-suspended"]');
        const row = group?.querySelector(`[data-testid="directory-row"][data-member-id="${guest}"]`);
        const people = document.querySelector('[data-testid="directory-people"]');
        const lists = [...document.querySelectorAll('[data-testid="directory-list"] > *')].map((el) => el.getAttribute("data-testid"));
        return {
          group: group ? 1 : 0,
          inGroup: row ? 1 : 0,
          inPeople: people?.querySelector(`[data-member-id="${guest}"]`) ? 1 : 0,
          chip: row?.textContent?.includes("정지됨") ?? false,
          tone: row?.querySelector('[data-testid="avatar-with-presence"]')?.getAttribute("data-presence-tone") ?? null,
          count: document.querySelector('[data-testid="directory-count"]')?.textContent ?? null,
          last: lists.at(-1),
        };
      }, GUEST);
      console.log(`measure S ${tag} directory ${JSON.stringify(seen)}`);
      if (view.group === 1) {
        check(`S ${tag} 멤버 탭: 정지된 사람은 맨 아래 「정지됨」 묶음에 칩과 함께, 접속 점 없이, 「사람 N」에는 안 든다`,
          seen.group === 1 && seen.inGroup === 1 && seen.inPeople === 0 && seen.chip && seen.tone === null && seen.count === "사람 3 · 에이전트 1" && seen.last === "directory-suspended", seen);
      } else {
        check(`S ${tag} 멤버 탭: 「정지됨」 묶음이 없고 정지된 사람이 어디에도 없다`,
          seen.group === 0 && seen.inPeople === 0 && seen.count === "사람 3 · 에이전트 1", seen);
      }
      await page.mouse.move(0, 0);
      await shot(page, `S-${tag}-directory`);
      // 채널 멤버 패널: 머리 수는 활성만, 정지된 사람은 맨 아래 「정지됨」 묶음(소유자·관리자 시점).
      await page.evaluate((id) => { location.hash = `#/c/${id}`; }, GENERAL);
      const trigger = page.getByTestId("channel-member-count");
      await trigger.waitFor({ timeout: 20_000 });
      await page.waitForFunction(() => document.querySelector('[data-testid="channel-member-count"]')?.getAttribute("data-roster-status") === "ready", null, { timeout: 10_000 }).catch(() => undefined);
      const head = (await trigger.innerText()).trim();
      await trigger.click();
      await page.getByTestId("channel-member-panel").waitFor();
      await settle(page);
      const panel = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="channel-member-section"]')].map((section) => ({
          group: section.getAttribute("data-group"),
          heading: section.querySelector("h2")?.textContent ?? "",
          n: section.querySelectorAll('[data-testid="channel-member-item"]').length,
        }))
      );
      console.log(`measure S ${tag} panel ${JSON.stringify({ head, panel })}`);
      const activeRows = panel.filter((x) => x.group !== "suspended").reduce((n, x) => n + x.n, 0);
      if (view.group === 1) {
        const last = panel.at(-1);
        check(`S ${tag} 채널 패널: 머리 수 4(활성만) = 활성 묶음 합, 맨 아래 「정지됨 1」`,
          head === "4" && activeRows === 4 && last?.group === "suspended" && last.heading === "정지됨 1" && last.n === 1, { head, panel });
      } else {
        check(`S ${tag} 채널 패널: 머리 수 4, 「정지됨」 묶음 없음`, head === "4" && activeRows === 4 && !panel.some((x) => x.group === "suspended"), { head, panel });
      }
      await page.mouse.move(0, 0);
      await shot(page, `S-${tag}-channel-panel`);
    } finally {
      await context.close();
    }
  }
}

if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) throw new Error("dist/ is missing. Run npm run build first.");
mkdirSync(OUT_DIR, { recursive: true });
const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
const origin = preview.origin;
const browser = await chromium.launch();
// `SCENES=T,H` 처럼 장면 일부만 돌린다(기본은 전부).
const SCENES = new Set((process.env.SCENES ?? "V,R,N,O,T,H,L,S,G").split(",").map((s) => s.trim()));
try {
  for (const scheme of SCHEMES) {
    if (SCENES.has("V")) await sceneViews(browser, origin, scheme);
    if (SCENES.has("R")) await sceneRole(browser, origin, scheme);
    if (SCENES.has("N")) await sceneNarrow(browser, origin, scheme);
    if (SCENES.has("O")) await sceneOffline(browser, origin, scheme);
    if (SCENES.has("T")) await sceneTab(browser, origin, scheme);
    if (SCENES.has("H")) await sceneInFlightCancel(browser, origin, scheme);
    if (SCENES.has("L")) await sceneLifecycle(browser, origin, scheme);
    if (SCENES.has("S")) await sceneSuspended(browser, origin, scheme);
    if (SCENES.has("G")) await sceneGuard(browser, origin, scheme);
  }
} finally {
  await browser.close();
  await preview.stop();
}
console.log(failures.length === 0 ? "ALL OK" : `FAILED: ${failures.length}`);
process.exit(failures.length === 0 ? 0 : 1);
