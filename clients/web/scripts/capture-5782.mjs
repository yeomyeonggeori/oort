#!/usr/bin/env node
// =============================================================================
// 멤버 탭 실측 + 캡처 (#5782, owner 2026-11-13 QA 13).
//
// 재는 것이 먼저이고 찍는 것이 그 다음이다: `check()` 가 틀리면 끝 코드를 1 로 만든다.
//
//   npm run build:design && node scripts/capture-5782.mjs
//   OUT_DIR=… CAPTURE_PORT=… node scripts/capture-5782.mjs
//
// 재는 것:
//   L. 로딩: 스켈레톤 줄의 높이 = 도착한 실제 줄의 높이(사람·에이전트 모두), 첫 줄의 위 끝이 도착 전후 같다.
//   R. 줄: 모든 줄이 같은 높이(두 층), 보조 줄은 한 줄, 사람의 보조 줄에 「@핸들 · 이메일」, 에이전트는 「님이 관리」.
//   S. 검색: 앞 돋보기가 글자 시작보다 왼쪽에 있다, 이메일 조각으로 찾힌다, 없는 말이면 「일치하는 멤버가 없습니다」.
//   O. 오프라인 배너 · E. 오류 상자 · Z. 빈 명부.
//   G. 게스트 시점: 화면·접근 이름 어디에도 이메일이 없고, 이메일 조각으로는 아무도 안 찾힌다.
//   N. 좁은 폭(390)·200%(1440 창의 200% = 720 CSS px): 가로 넘침 0, 줄 높이 같음.
//   Y. 갤러리 견본: ListRowSkeleton = ListRow 높이, 글자 크기 「크게」에서도 같다.
//   D. 새 DM 창(같은 부품, 대화 상자 안이라 시트 채움 그릇): 줄 높이가 멤버 탭 줄과 같고, 그릇이 카드가 아니다.
//   M. 많은 명부(사람 15)·낮은 창(1024×480): 묶음 그릇이 눌려 잘리지 않고(scrollHeight = clientHeight) 마지막 줄까지
//      스크롤된다 — 멤버 탭과 새 DM 창 둘 다. 새 DM 창의 「대화 중」 표지·찾지 못함·390 폭도 여기서 찍는다.
// =============================================================================
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "captures/5782");
const PORT = Number(process.env.CAPTURE_PORT || 5782);
const SCHEMES = (process.env.SCHEMES || "light,dark").split(",");

const workspaceId = "00000000-0000-7000-8000-000000000001";
const P = (n) => `00000000-0000-7000-8000-0000000001${n}`;
const chId = (n) => `00000000-0000-7000-8000-0000000002${String(n).padStart(2, "0")}`;
const ME = P("01");
const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

// 가상 인물만.
const person = (n, displayName, handle, extra = {}) => ({
  id: P(n), workspaceId, kind: "human", status: "active", displayName, handle, role: "member",
  channelCount: 1, channelIds: [chId(1)], capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...extra,
});
const agent = (n, displayName, handle, extra = {}) =>
  person(n, displayName, handle, { kind: "agent", role: "member", ownerHumanId: ME, ...extra });

function rosterFor(viewerRole) {
  return [
    person("01", "김도현", "dohyeon", { role: viewerRole, email: "dohyeon@example.com", online: true }),
    person("02", "이서연", "seoyeon", { role: "admin", email: "seoyeon@example.com", online: true }),
    person("03", "정하윤", "hayun", { email: "hayun.jung@example.com", online: false, statusEmoji: "🌴", statusText: "다음 주 화요일까지 휴가" }),
    person("04", "한지우", "jiwoo", { role: "guest", email: "jiwoo.han.design-partner-studio@example.com", presenceStatus: "away", online: true }),
    person("05", "박서준", "seojun", { status: "invited", email: "seojun@example.com" }),
    agent("21", "hermes", "hermes", { email: "should-never-show@example.com" }),
    agent("22", "김인턴", "intern", { ownerHumanId: P("02"), hostOnline: true }),
  ];
}
const channels = [{ id: chId(1), workspaceId, kind: "public", name: "일반", muted: false }];
// 많은 명부 장면의 가상 인물 열(이름은 이니셜 + 번호, 사람이 아님이 분명하게).
const MANY = Array.from({ length: 10 }, (_, i) => person(String(30 + i), `시험 멤버 ${i + 1}`, `member${i + 1}`, { email: `member${i + 1}@example.com` }));
const dmWithSeoyeon = { id: "00000000-0000-7000-8000-000000000301", workspaceId, kind: "dm", muted: false, memberIds: [ME, P("02")] };

const results = [];
function check(scene, name, ok, detail) {
  results.push({ scene, name, ok: Boolean(ok), detail });
  console.log(JSON.stringify({ scene, check: name, ok: Boolean(ok), detail }));
}
async function attempt(scene, name, fn) {
  try {
    await fn();
  } catch (error) {
    check(scene, `${name} (실행 실패)`, false, String(error?.message ?? error).split("\n")[0]);
  }
}

/** `mode`: ok | hold(명부를 붙잡아 두었다가 `release()`) | fail | alone(나 혼자) | many(사람 15 + 이서연과의 DM). */
async function installMocks(context, { viewerRole, mode }) {
  let release;
  const held = new Promise((done) => { release = done; });
  const auth = {
    accessToken: "capture-only-not-a-credential", refreshToken: "capture-only-not-a-credential",
    member: { id: ME, workspaceId, kind: "human", displayName: "김도현", handle: "dohyeon" },
    realtimeWebSocketUrl: "ws://members-5782-capture.invalid/connection/websocket",
  };
  await context.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId: ME });
    const live = /\/agents\/([^/]+)\/liveness$/.exec(path);
    if (live) return json(route, { agentMemberId: live[1], state: "responsive" });
    if (path.endsWith("/read-state")) {
      return json(route, { read_states: channels.map((c) => ({ channel_id: c.id, last_read_seq: 2, latest_seq: 2, unread_count: 0, mention_count: 0, marked_unread_before_seq: null })) });
    }
    if (path.endsWith("/members/me/sidebar-prefs")) return json(route, { prefs: { version: 1, sections: [], starredChannelIds: [] } });
    if (path.endsWith("/channels")) return json(route, { channels: mode === "many" ? [...channels, dmWithSeoyeon] : channels });
    if (path.endsWith("/roster")) {
      if (mode === "fail") return json(route, { error: "unavailable" }, 503);
      if (mode === "hold") await held;
      const roster = rosterFor(viewerRole);
      return json(route, { members: mode === "alone" ? roster.slice(0, 1) : mode === "many" ? [...roster, ...MANY] : roster });
    }
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith(`/workspaces/${workspaceId}`)) return json(route, { workspace: { id: workspaceId, name: "달무리 스튜디오" } });
    if (path.includes("/messages")) return json(route, { messages: [] });
    return json(route, {});
  });
  await context.addInitScript(() => {
    class CaptureSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      constructor(url) { this.url = String(url); this.readyState = 0; queueMicrotask(() => { this.readyState = 1; this.onopen?.(new Event("open")); }); }
      send(data) {
        const replies = String(data).trim().split("\n").map((line) => {
          const c = JSON.parse(line);
          if (c.connect) return { id: c.id, connect: { client: "members", version: "6" } };
          if (c.subscribe) return { id: c.id, subscribe: { recoverable: false, positioned: false, recovered: false, epoch: "cap", offset: 0 } };
          return { id: c.id };
        });
        queueMicrotask(() => this.onmessage?.(new MessageEvent("message", { data: replies.map((r) => JSON.stringify(r)).join("\n") })));
      }
      close() { this.readyState = 3; this.onclose?.(new CloseEvent("close", { code: 1000 })); }
    }
    window.WebSocket = CaptureSocket;
  });
  return { release: () => release() };
}

async function open(origin, scheme, viewport, { viewerRole = "owner", mode = "ok" } = {}) {
  const browser = await chromium.launch();
  // 한국어 기기(owner 의 화면). 언어를 주지 않으면 헤드리스 Chromium 은 영어로 서고 사전도 영어다.
  const context = await browser.newContext({ viewport, colorScheme: scheme, serviceWorkers: "block", reducedMotion: "reduce", deviceScaleFactor: 2, locale: "ko-KR" });
  const roster = await installMocks(context, { viewerRole, mode });
  await context.addInitScript((server) => { try { if (!localStorage.getItem("momo.web.server.v1")) localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ } }, origin);
  const page = await context.newPage();
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-item").first().waitFor({ timeout: 30_000 });
  return { browser, context, page, roster };
}

async function goDirectory(page) {
  await page.getByTestId("nav-directory").click();
  await page.getByTestId("directory-route").waitFor({ timeout: 10_000 });
}

async function rowGeometry(page, selector) {
  return page.evaluate((sel) => [...document.querySelectorAll(sel)].map((el) => {
    const r = el.getBoundingClientRect();
    return { id: el.getAttribute("data-member-id"), kind: el.getAttribute("data-member-kind"), top: Math.round(r.top * 10) / 10, h: Math.round(r.height * 10) / 10 };
  }), selector);
}

async function noHorizontalOverflow(page) {
  return page.evaluate(() => {
    const list = document.querySelector('[data-testid="directory-list"]');
    const doc = document.scrollingElement || document.documentElement;
    return { doc: doc.scrollWidth - doc.clientWidth, list: list ? list.scrollWidth - list.clientWidth : null };
  });
}

async function shot(page, name) {
  await page.mouse.move(0, 0);
  await page.waitForTimeout(150);
  await page.screenshot({ path: resolve(OUT_DIR, name) });
}

async function runMember(origin, scheme) {
  const scene = `member-${scheme}`;
  const { browser, context, page, roster } = await open(origin, scheme, { width: 1440, height: 900 }, { mode: "hold" });
  try {
    let skeleton = null;
    await attempt(scene, "L.loading", async () => {
      await goDirectory(page);
      await page.getByTestId("directory-skeleton").waitFor({ timeout: 10_000 });
      await page.waitForTimeout(200);
      skeleton = await rowGeometry(page, '[data-testid="skeleton-row"] > span');
      await shot(page, `directory-loading-${scheme}.png`);
      roster.release();
      await page.getByTestId("directory-row").first().waitFor({ timeout: 10_000 });
      await page.waitForTimeout(400);
      const rows = await rowGeometry(page, '[data-testid="directory-row"]');
      const people = rows.filter((r) => r.kind === "human");
      const agents = rows.filter((r) => r.kind === "agent");
      check(scene, "L1 스켈레톤 줄 높이 = 실제 사람 줄 높이", skeleton.length > 0 && skeleton.every((s) => s.h === people[0].h), { skeleton: skeleton.map((s) => s.h), person: people[0]?.h });
      check(scene, "L2 스켈레톤 줄 높이 = 실제 에이전트 줄 높이", agents.length > 0 && agents.every((a) => a.h === skeleton[0].h), { skeleton: skeleton[0]?.h, agents: agents.map((a) => a.h) });
      check(scene, "L3 첫 줄의 위 끝이 도착 전후 같다(목록 이동 0)", skeleton[0] && people[0] && skeleton[0].top === people[0].top, { before: skeleton[0]?.top, after: people[0]?.top });
    });

    await attempt(scene, "R.rows", async () => {
      const rows = await rowGeometry(page, '[data-testid="directory-row"]');
      const heights = [...new Set(rows.map((r) => r.h))];
      check(scene, "R1 모든 줄이 같은 높이(두 층)", heights.length === 1, { heights, n: rows.length });
      const subs = await page.evaluate(() => [...document.querySelectorAll('[data-testid="directory-row"]')].map((row) => {
        const sub = row.querySelector('[data-testid="directory-row-subtitle"]');
        const box = sub.parentElement.getBoundingClientRect();
        const lh = parseFloat(getComputedStyle(sub.parentElement).lineHeight);
        return { kind: row.getAttribute("data-member-kind"), text: sub.textContent, h: Math.round(box.height * 10) / 10, lh, label: row.getAttribute("aria-label") };
      }));
      check(scene, "R2 보조 줄은 한 줄(높이 = 줄 높이)", subs.every((s) => Math.abs(s.h - s.lh) < 0.6), subs.map((s) => [s.h, s.lh]));
      const seoyeon = subs.find((s) => s.text.startsWith("@seoyeon"));
      check(scene, "R3 사람의 보조 줄 「@핸들 · 이메일」, 접근 이름에도 이메일", seoyeon?.text === "@seoyeon · seoyeon@example.com" && seoyeon.label.includes("seoyeon@example.com"), seoyeon);
      const hermes = subs.find((s) => s.text.startsWith("@hermes"));
      check(scene, "R4 에이전트는 「@핸들 · ○○ 님이 관리」이고 이메일이 없다", hermes?.text === "@hermes · 김도현 님이 관리" && !hermes.label.includes("example.com"), hermes);
      const roles = await page.locator('[data-testid="directory-row-role"]').allTextContents();
      check(scene, "R5 역할은 끝의 칩(사람 다섯 줄)", roles.length === 5, roles);
      const self = await page.locator(`[data-testid="directory-row"][data-member-id="${ME}"] [data-testid="directory-row-self"]`).textContent();
      check(scene, "R6 내 줄은 이름 곁에 「나」", self === "나", self);
      await shot(page, `directory-${scheme}.png`);
    });

    await attempt(scene, "S.search", async () => {
      const search = page.getByTestId("directory-search");
      const geo = await page.evaluate(() => {
        const input = document.querySelector('[data-testid="directory-search"]');
        const icon = input.parentElement.querySelector("svg");
        const ir = icon.getBoundingClientRect();
        const xr = input.getBoundingClientRect();
        const pad = parseFloat(getComputedStyle(input).paddingLeft);
        return { iconLeft: round2(ir.left), iconRight: round2(ir.right), textStart: round2(xr.left + pad), inputW: round2(xr.width), iconMid: round2(ir.top + ir.height / 2), inputMid: round2(xr.top + xr.height / 2), placeholder: input.getAttribute("placeholder") };
        function round2(n) { return Math.round(n * 10) / 10; }
      });
      check(scene, "S1 앞 돋보기가 글자 시작보다 왼쪽, 세로 가운데", geo.iconRight <= geo.textStart && Math.abs(geo.iconMid - geo.inputMid) <= 0.6, geo);
      check(scene, "S2 자리 글은 이름·핸들·이메일", geo.placeholder === "이름, 핸들, 이메일로 찾기", geo.placeholder);
      await search.fill("SEOYEON@");
      await page.waitForTimeout(200);
      const hit = await page.locator('[data-testid="directory-row"]').evaluateAll((els) => els.map((el) => el.getAttribute("data-member-id")));
      check(scene, "S3 이메일 조각(대소문자 무시)으로 찾힌다", hit.length === 1 && hit[0] === P("02"), hit);
      await shot(page, `directory-search-${scheme}.png`);
      await search.fill("zzzz");
      await page.getByTestId("directory-no-match").waitFor({ timeout: 5_000 });
      const none = await page.getByTestId("directory-no-match").innerText();
      check(scene, "S4 없는 말이면 「일치하는 멤버가 없습니다」와 검색 지우기", none.includes("일치하는 멤버가 없습니다") && none.includes("이메일") && none.includes("검색 지우기"), none);
      await shot(page, `directory-no-match-${scheme}.png`);
      await search.fill("");
    });

    await attempt(scene, "O.offline", async () => {
      await context.setOffline(true);
      await page.getByTestId("directory-offline").waitFor({ timeout: 10_000 });
      const rows = await page.locator('[data-testid="directory-row"]').count();
      check(scene, "O1 오프라인 배너가 서고 받아 둔 명부는 그대로", rows === 7, rows);
      await shot(page, `directory-offline-${scheme}.png`);
      await context.setOffline(false);
      await page.getByTestId("directory-offline").waitFor({ state: "detached", timeout: 15_000 }).catch(() => undefined);
    });

    await attempt(scene, "N.narrow", async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(500);
      const over = await noHorizontalOverflow(page);
      const rows = await rowGeometry(page, '[data-testid="directory-row"]');
      check(scene, "N1 좁은 폭(390): 가로 넘침 0, 줄 높이 같음", over.doc <= 0 && (over.list ?? 0) <= 0 && new Set(rows.map((r) => r.h)).size === 1, { over, heights: [...new Set(rows.map((r) => r.h))] });
      await shot(page, `directory-narrow-${scheme}.png`);
      await page.setViewportSize({ width: 720, height: 450 });
      await page.waitForTimeout(500);
      const over2 = await noHorizontalOverflow(page);
      const rows2 = await rowGeometry(page, '[data-testid="directory-row"]');
      check(scene, "N2 200%(1440 창 = 720 CSS px): 가로 넘침 0, 줄 높이 같음", over2.doc <= 0 && (over2.list ?? 0) <= 0 && new Set(rows2.map((r) => r.h)).size === 1, { over2, heights: [...new Set(rows2.map((r) => r.h))] });
      await shot(page, `directory-200pct-${scheme}.png`);
    });
  } finally {
    await context.close();
    await browser.close();
  }
}

async function runGuest(origin, scheme) {
  const scene = `guest-${scheme}`;
  const { browser, context, page } = await open(origin, scheme, { width: 1440, height: 900 }, { viewerRole: "guest" });
  try {
    await attempt(scene, "G.guest", async () => {
      await goDirectory(page);
      await page.getByTestId("directory-row").first().waitFor({ timeout: 10_000 });
      await page.waitForTimeout(300);
      const leak = await page.evaluate(() => {
        const route = document.querySelector('[data-testid="directory-route"]');
        const labels = [...route.querySelectorAll("[aria-label]")].map((el) => el.getAttribute("aria-label")).join(" | ");
        return { text: route.innerText.includes("@example.com"), labels: labels.includes("@example.com"), html: route.innerHTML.includes("example.com") };
      });
      check(scene, "G1 게스트 시점: 화면 글·접근 이름·마크업 어디에도 이메일이 없다", !leak.text && !leak.labels && !leak.html, leak);
      const placeholder = await page.getByTestId("directory-search").getAttribute("placeholder");
      check(scene, "G2 게스트의 자리 글은 이메일을 약속하지 않는다", placeholder === "이름이나 핸들로 찾기", placeholder);
      await shot(page, `directory-guest-${scheme}.png`);
      await page.getByTestId("directory-search").fill("seoyeon@");
      await page.getByTestId("directory-no-match").waitFor({ timeout: 5_000 });
      const none = await page.getByTestId("directory-no-match").innerText();
      check(scene, "G3 게스트가 이메일 조각을 치면 아무도 안 찾힌다(가린 주소가 검색으로 새지 않음)", (await page.locator('[data-testid="directory-row"]').count()) === 0 && !none.includes("이메일"), none);
      await shot(page, `directory-guest-email-search-${scheme}.png`);
      await page.getByTestId("directory-search").fill("seoyeon");
      await page.waitForTimeout(200);
      check(scene, "G4 게스트도 이름·핸들로는 찾는다", (await page.locator('[data-testid="directory-row"]').count()) === 1, null);
    });
  } finally {
    await context.close();
    await browser.close();
  }
}

async function runStates(origin, scheme) {
  for (const [mode, testId, file, name] of [
    ["fail", "directory-error", `directory-error-${scheme}.png`, "E1 명부를 못 읽으면 오류 상자와 다시 시도"],
    ["alone", "directory-empty", `directory-empty-${scheme}.png`, "Z1 나 혼자면 초대 빈 상태"],
  ]) {
    const scene = `${mode}-${scheme}`;
    const { browser, context, page } = await open(origin, scheme, { width: 1440, height: 900 }, { mode });
    try {
      await attempt(scene, mode, async () => {
        await goDirectory(page);
        await page.getByTestId(testId).waitFor({ timeout: 20_000 });
        check(scene, name, true, null);
        await shot(page, file);
      });
    } finally {
      await context.close();
      await browser.close();
    }
  }
}

async function runNewDm(origin, scheme) {
  const scene = `newdm-${scheme}`;
  const { browser, context, page } = await open(origin, scheme, { width: 1440, height: 900 });
  try {
    await attempt(scene, "D.newdm", async () => {
      await page.getByTestId("sidebar-section-dms-header").hover();
      await page.getByTestId("new-dm").click();
      await page.getByTestId("new-dm-dialog").waitFor({ timeout: 10_000 });
      await page.getByTestId("new-dm-row").first().waitFor({ timeout: 10_000 });
      await page.waitForTimeout(300);
      const geo = await page.evaluate(() => ({
        rows: [...document.querySelectorAll('[data-testid="new-dm-row"]')].map((el) => Math.round(el.getBoundingClientRect().height * 10) / 10),
        surfaces: [...document.querySelectorAll('[data-testid="new-dm-dialog"] [data-list-surface]')].map((el) => el.getAttribute("data-list-surface")),
        bandHeads: document.querySelectorAll('[data-testid="new-dm-dialog"] h2.border-b').length,
      }));
      check(scene, "D1 새 DM 창의 줄도 두 층 56(멤버 탭과 같은 줄, 나와 초대됨을 뺀 다섯)", geo.rows.length === 5 && geo.rows.every((h) => h === 56), geo.rows);
      check(scene, "D2 대화 상자 안의 묶음은 시트 채움 그릇이고 선 띠 머리글은 없다", geo.surfaces.length === 2 && geo.surfaces.every((x) => x === "sheet") && geo.bandHeads === 0, geo);
      await page.mouse.move(0, 0);
      await page.waitForTimeout(150);
      await page.screenshot({ path: resolve(OUT_DIR, `newdm-${scheme}.png`) });
    });
  } finally {
    await context.close();
    await browser.close();
  }
}

/** 묶음 그릇마다 눌려 잘렸는가: 안의 높이(scrollHeight)와 보이는 높이(clientHeight)가 같아야 한다. */
async function surfacesUnclipped(page, root) {
  return page.evaluate((sel) => [...document.querySelectorAll(`${sel} [data-list-surface]`)].map((el) => ({ surface: el.getAttribute("data-list-surface"), scroll: el.scrollHeight, client: el.clientHeight })), root);
}

async function lastRowReachable(page, listSel, rowSel) {
  return page.evaluate(async ({ listSel, rowSel }) => {
    const list = document.querySelector(listSel);
    const rows = list.querySelectorAll(rowSel);
    const last = rows[rows.length - 1];
    list.scrollTop = list.scrollHeight;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const lr = list.getBoundingClientRect();
    const r = last.getBoundingClientRect();
    return { rows: rows.length, scrolls: list.scrollHeight > list.clientHeight, inside: r.top >= lr.top - 0.5 && r.bottom <= lr.bottom + 0.5, h: Math.round(r.height * 10) / 10 };
  }, { listSel, rowSel });
}

async function runMany(origin, scheme) {
  const scene = `many-${scheme}`;
  const { browser, context, page } = await open(origin, scheme, { width: 1024, height: 480 }, { mode: "many" });
  try {
    await attempt(scene, "M.directory", async () => {
      await goDirectory(page);
      await page.getByTestId("directory-row").first().waitFor({ timeout: 10_000 });
      await page.waitForTimeout(300);
      const surfaces = await surfacesUnclipped(page, '[data-testid="directory-list"]');
      check(scene, "M1 멤버 탭: 묶음 그릇이 눌려 잘리지 않는다(사람 15 · 낮은 창)", surfaces.length === 2 && surfaces.every((x) => x.surface === "pane" && x.scroll === x.client), surfaces);
      const reach = await lastRowReachable(page, '[data-testid="directory-list"]', '[data-testid="directory-row"]');
      check(scene, "M2 멤버 탭: 목록이 스크롤되고 마지막 줄(56)이 목록 안에 온전히 선다", reach.rows === 17 && reach.scrolls && reach.inside && reach.h === 56, reach);
      await shot(page, `directory-many-bottom-${scheme}.png`);
    });
    await attempt(scene, "M.newdm", async () => {
      await page.getByTestId("sidebar-section-dms-header").hover();
      await page.getByTestId("new-dm").click();
      await page.getByTestId("new-dm-row").first().waitFor({ timeout: 10_000 });
      await page.waitForTimeout(300);
      const surfaces = await surfacesUnclipped(page, '[data-testid="new-dm-list"]');
      check(scene, "M3 새 DM 창: 시트 그릇이 눌려 잘리지 않는다", surfaces.length === 2 && surfaces.every((x) => x.surface === "sheet" && x.scroll === x.client), surfaces);
      const hasDm = await page.locator('[data-testid="new-dm-row"][data-has-dm] [data-testid="new-dm-has-dm"]').count();
      check(scene, "M4 새 DM 창: 이미 대화 중인 사람에게 「대화 중」 표지(끝 칸)", hasDm === 1, hasDm);
      await shot(page, `newdm-many-top-${scheme}.png`);
      const reach = await lastRowReachable(page, '[data-testid="new-dm-list"]', '[data-testid="new-dm-row"]');
      check(scene, "M5 새 DM 창: 마지막 줄까지 스크롤되고 온전히 선다", reach.scrolls && reach.inside && reach.h === 56, reach);
      await page.getByTestId("new-dm-search").fill("zzzz");
      await page.getByTestId("new-dm-no-match").waitFor({ timeout: 5_000 });
      check(scene, "M6 새 DM 창: 찾지 못함", true, null);
      await shot(page, `newdm-no-match-${scheme}.png`);
      await page.getByTestId("new-dm-search").fill("");
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(400);
      const over = await page.evaluate(() => {
        const list = document.querySelector('[data-testid="new-dm-list"]');
        return { list: list.scrollWidth - list.clientWidth, doc: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      });
      check(scene, "M7 새 DM 창 390 폭: 가로 넘침 0", over.list <= 0 && over.doc <= 0, over);
      await shot(page, `newdm-narrow-${scheme}.png`);
    });
  } finally {
    await context.close();
    await browser.close();
  }
}

async function runGallery(origin, scheme) {
  const scene = `gallery-${scheme}`;
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: scheme, reducedMotion: "reduce", deviceScaleFactor: 2, locale: "ko-KR" });
  const page = await context.newPage();
  try {
    await attempt(scene, "Y.gallery", async () => {
      await page.goto(`${origin}/#/design`, { waitUntil: "networkidle" });
      const section = page.getByTestId("gallery-list-row");
      await section.waitFor({ timeout: 20_000 });
      await section.scrollIntoViewIfNeeded();
      const measure = () => section.evaluate((root) => {
        const rows = [...root.querySelectorAll("li > button")].map((b) => Math.round(b.getBoundingClientRect().height * 10) / 10);
        const skels = [...root.querySelectorAll('li[aria-hidden="true"] > span')].map((s) => Math.round(s.getBoundingClientRect().height * 10) / 10);
        return { rows, skels };
      });
      const base = await measure();
      check(scene, "Y1 견본: 스켈레톤 줄 = 줄 높이(기본 글자)", base.skels.length === 2 && new Set([...base.rows, ...base.skels]).size === 1, base);
      await page.evaluate(() => document.documentElement.setAttribute("data-font-size", "larger"));
      await page.waitForTimeout(200);
      const large = await measure();
      check(scene, "Y2 견본: 글자 「크게」에서도 스켈레톤 줄 = 줄 높이", new Set([...large.rows, ...large.skels]).size === 1 && large.rows[0] > base.rows[0], large);
      await page.evaluate(() => document.documentElement.setAttribute("data-font-size", "default"));
      await page.waitForTimeout(200);
      await page.mouse.move(0, 0);
      await section.screenshot({ path: resolve(OUT_DIR, `gallery-list-row-${scheme}.png`) });
    });
  } finally {
    await context.close();
    await browser.close();
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  try {
    for (const scheme of SCHEMES) {
      await runMember(preview.origin, scheme);
      await runGuest(preview.origin, scheme);
      await runStates(preview.origin, scheme);
      await runNewDm(preview.origin, scheme);
      await runMany(preview.origin, scheme);
      await runGallery(preview.origin, scheme);
    }
  } finally {
    await preview.stop?.();
  }
  const bad = results.filter((r) => !r.ok);
  writeFileSync(resolve(OUT_DIR, "results.json"), JSON.stringify(results, null, 1));
  console.log(bad.length === 0 ? `MEMBERS-5782 PASS (${results.length} checks)` : `MEMBERS-5782 FAIL (${bad.length}/${results.length}): ${bad.map((r) => `${r.scene}/${r.name}`).join(" | ")}`);
  process.exit(bad.length === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
