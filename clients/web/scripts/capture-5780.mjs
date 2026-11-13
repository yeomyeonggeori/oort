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

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const patches = [];

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
      roster = roster.map((m) => (m.id === role[1] ? { ...m, role: body.role } : m));
      return json(route, { memberId: role[1], scope: "workspace", role: body.role });
    }
    if (/\/inbox(\/|$)/.test(path)) return json(route, { items: [], nextCursor: null, unreadCount: 0, approvalsPending: 0 });
    if (path.endsWith("/members/me/sidebar-prefs")) return json(route, { prefs: { version: 1, sections: [], starredChannelIds: [] } });
    if (path.endsWith("/channels")) return json(route, { channels: [{ id: GENERAL, workspaceId, kind: "public", name: "일반", topic: "팀 공지", muted: false }] });
    if (path.endsWith("/roster")) return json(route, { members: roster });
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

const text = (page, id) => page.getByTestId(id).innerText().catch(() => null);
const count = (page, id) => page.getByTestId(id).count();

/** V. 네 시점 × 대상(사람·에이전트). */
const VIEWS = [
  { viewer: OWNER, label: "owner", human: MEMBER, expect: { manage: 1, select: 1, options: ["소유자", "관리자", "멤버", "게스트"], email: "dohyun.lee@dalmuri.example", reset: 1 } },
  { viewer: ADMIN, label: "admin", human: OWNER, expect: { manage: 1, select: 0, options: null, email: "dohyeon@dalmuri.example", reset: 0, text: "소유자" } },
  { viewer: MEMBER, label: "member", human: ADMIN, expect: { manage: 0, select: 0, options: null, email: "seoyeon@dalmuri.example", reset: 0 } },
  { viewer: GUEST, label: "guest", human: ADMIN, expect: { manage: 0, select: 0, options: null, email: null, reset: 0 } },
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
          (await count(page, "member-profile-manage")) === 0);
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
    // 일반 확인 단계(멤버 → 관리자).
    await page.getByTestId("member-profile-role").click();
    await page.getByRole("option", { name: "관리자" }).click();
    await page.getByTestId("member-profile-role-stage").waitFor();
    check(`R ${tag} 고르면 확인 단계가 서고 요청은 없다`, patches.length === 0);
    check(`R ${tag} 대화상자는 하나다(겹친 창 없음, §3.4)`, (await page.locator('[role="dialog"], [role="alertdialog"]').count()) === 1);
    check(`R ${tag} 초점은 취소에 있다`, await page.evaluate(() => document.activeElement?.getAttribute("data-testid") === "member-profile-role-stage-cancel"));
    await page.mouse.move(0, 0);
    await shot(page, `R-${tag}-confirm-general`);
    await page.keyboard.press("Escape");
    await page.getByTestId("member-profile-role-stage").waitFor({ state: "detached" });
    check(`R ${tag} Esc 는 단계만 내린다(요청 없음, 창 남음)`, patches.length === 0 && (await dialog.isVisible()));

    // 소유자 승격 확인 단계.
    await page.getByTestId("member-profile-role").click();
    await page.getByRole("option", { name: "소유자" }).click();
    await page.getByTestId("member-profile-role-stage").waitFor();
    check(`R ${tag} 소유자 승격은 경고 + 위험 단추`,
      ((await text(page, "member-profile-role-stage-warning")) ?? "").startsWith("되돌릴 수 없어요.") &&
        (await page.getByTestId("member-profile-role-stage-confirm").getAttribute("data-tone")) === "destructive");
    await page.mouse.move(0, 0);
    await shot(page, `R-${tag}-confirm-owner`);
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
    await page.getByTestId("member-profile-role-stage-confirm").click();
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

/** N. 좁은 폭(375)과 200%. */
async function sceneNarrow(browser, origin, scheme) {
  for (const [label, opts] of [
    ["375", { width: 375, height: 812, scale: 2 }],
    ["zoom200", { width: 640, height: 450, scale: 2 }],
  ]) {
    roster = freshRoster();
    const tag = `${label}-${scheme}`;
    const { context, page } = await openContext(browser, origin, { scheme, viewerId: OWNER, ...opts });
    try {
      await page.goto(origin, { waitUntil: "domcontentloaded" });
      await openProfile(page, ADMIN);
      await page.mouse.move(0, 0);
      await shot(page, `N-${tag}-profile`);
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
    await page.getByTestId("member-profile-reset-open").click();
    await page.getByTestId("member-profile-reset-stage").waitFor();
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

if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) throw new Error("dist/ is missing. Run npm run build first.");
mkdirSync(OUT_DIR, { recursive: true });
const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
const origin = preview.origin;
const browser = await chromium.launch();
try {
  for (const scheme of SCHEMES) {
    await sceneViews(browser, origin, scheme);
    await sceneRole(browser, origin, scheme);
    await sceneNarrow(browser, origin, scheme);
    await sceneOffline(browser, origin, scheme);
  }
} finally {
  await browser.close();
  await preview.stop();
}
console.log(failures.length === 0 ? "ALL OK" : `FAILED: ${failures.length}`);
process.exit(failures.length === 0 ? 0 : 1);
