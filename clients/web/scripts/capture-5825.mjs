#!/usr/bin/env node
// =============================================================================
// #5825 레인: 1:1 「대화 나가기」 - 줄 메뉴 · 대화 머리 ⋮ · 확인 창 · 끝난 뒤 (ADR-0177 증보 2026-11-14 D16·D18·D21).
//
//   npm run build && node scripts/capture-5825.mjs
//   ENGINES=chromium,webkit OUT_DIR=<dir> SHOTS=1 node scripts/capture-5825.mjs
//
// 번들 Chromium · WebKit 헤드리스, 백엔드 없음(`/v1/**` 고정 응답 + 가짜 실시간 소켓), 인물은 전부 가상이다. 재는 것:
//   A 메뉴 줄 유무: 사람 1:1(맨 아래 · 구분선 아래 · 위험색) / 에이전트 DM / 그룹 DM / 채널 / 옛 서버(투영에 하한 칸 없음). 머리 ⋮ 도.
//   B 확인 창 네 상태: 쉼(초점 「취소」 · 낭독 이름 = 제목 · 예약 N개 줄) / 진행 중(aria-busy · 취소·Esc 잠김) / 실패(alert · 다시 누를 수 있음)
//     / 성공(창 닫힘 · 줄 자리 영수증 · 캐럿이 이웃 줄).
//   C 키보드: Shift+F10 → End → Enter, 창 안 Tab 가둠, Esc 뒤 캐럿이 연 줄로.
//   D 두 번 누름 자리: 메뉴 줄 가운데에 창이 서는가 · 창이 닫힌 뒤 확정 단추 가운데에 무엇이 있는가(좌표).
//   E 영수증: 서는 순간과 걷히는 순간 아래 줄의 y(프레임마다), 포인터가 목록 안 / 밖.
//   F 정리(D17 기기 줄): 나간 대화의 초안 0 · 다른 대화 초안 그대로 - 줄 메뉴와 머리 ⋮ 둘 다.
//   G 하한(D18·D22): 하한 아래 seq 의 발행물(새 글 · 고정)은 그려지지 않고, 하한 위는 그려진다. 새 글이 온 대화는 줄이 다시 선다.
//   H 첫 페인트: 투영이 늦게 오는 동안 나간 대화(별표 없음)가 목록에도 「숨긴 대화」에도 없다.
//   I 머리 ⋮ 가 늦게 설 때 머리 단추들의 x 변화. J 예약 목록이 늦거나 실패할 때.
//   K 좁은 폭 390 · 200%: 창이 화면 안, 가로 넘침 0.
//   M 개인 채널로 옮겨 온 방 프레임(D17, 서버 셋째 칸): 상대가 나간 1:1 에 남은 내가 받는 옛 글의 수정이 열린 대화에 반영된다. 다른 방
//     이름을 단 것은 반영되지 않는다.
//   L 머리 ⋮ 길: 390(서랍 닫힘 - 끝나면 서랍이 열리고 영수증이 보임) · 1280 목록 접힘(⌘B): 캐럿이 <body> 가 아니고 낭독 영역이 말한다.
// =============================================================================
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/5825");
const PORT = Number(process.env.CAPTURE_PORT || 25825);
const SHOTS = process.env.SHOTS !== "0";
const ENGINES = (process.env.ENGINES || "chromium,webkit").split(",");
const ONLY = process.env.SCENES ? new Set(process.env.SCENES.split(",")) : null;
// 다른 번들(고치기 전·사보타주)로 돌릴 때: `vite preview --outDir` 로 넘긴다(`capture-5777.mjs` 와 같은 길).
const DIST_DIR = process.env.DIST_DIR || "";

const workspaceId = "00000000-0000-7000-8000-000000000001";
const P = (n) => `00000000-0000-7000-8000-0000000001${n}`;
const ME = P("01");
const chId = (n) => `00000000-0000-7000-8000-0000000002${String(n).padStart(2, "0")}`;
const dmId = (n) => `00000000-0000-7000-8000-0000000003${String(n).padStart(2, "0")}`;
const DM_SEOYEON = dmId(1);
const DM_JIHO = dmId(2);
const DM_AGENT = dmId(3);
const DM_GROUP = dmId(4);
const DM_MINJI = dmId(5);
const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const person = (n, displayName, handle, extra = {}) => ({
  id: P(n), workspaceId, kind: "human", status: "active", displayName, handle, channelCount: 1, channelIds: [], capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...extra,
});
const roster = [
  person("01", "김도현", "dohyeon", { role: "owner" }),
  person("11", "이서연", "seoyeon"),
  person("12", "박지호", "jiho"),
  person("13", "최민지", "minji"),
  person("14", "정리봇", "tidy", { kind: "agent", hostOnline: true, ownerHumanId: ME }),
];
const channels = [
  { id: chId(1), workspaceId, kind: "public", name: "general", muted: false },
  { id: chId(2), workspaceId, kind: "public", name: "design", muted: false },
];
const dm = (id, others, extra = {}) => ({ id, workspaceId, kind: "dm", muted: false, memberIds: [ME, ...others], ...extra });
const dms = [
  dm(DM_SEOYEON, [P("11")]),
  dm(DM_JIHO, [P("12")]),
  dm(DM_AGENT, [P("14")]),
  dm(DM_GROUP, [P("11"), P("12")], { dmKey: "group:abc" }),
  dm(DM_MINJI, [P("13")]),
];
const BODIES = [
  "내일 디자인 리뷰 몇 시에 할까요?", "오후 3시 괜찮아요", "시안 두 개 다 올려 둘게요", "좋아요, 확인할게요",
  "사이드바 간격 조금 줄였어요", "390 폭에서도 봐 주세요", "넵 지금 볼게요", "아이콘 정렬 맞았어요",
  "다음 주 일정 다시 볼게요", "고마워요!",
];
const now = Date.now();
const msg = (channelId, seq, author, body) => ({
  id: `${channelId.slice(0, 30)}${String(seq).padStart(6, "0")}`, channelId, seq, hlcTs: now - (20 - seq) * 60_000, hlcCount: 0,
  authorMemberId: author, type: "text", body, state: "sent", createdAtMs: now - (20 - seq) * 60_000,
});
const BASE_MESSAGES = {
  [DM_SEOYEON]: BODIES.map((b, i) => msg(DM_SEOYEON, i + 1, i % 2 === 0 ? P("11") : ME, b)),
  [DM_JIHO]: BODIES.slice(0, 4).map((b, i) => msg(DM_JIHO, i + 1, i % 2 === 0 ? P("12") : ME, b)),
  [DM_MINJI]: BODIES.slice(4, 6).map((b, i) => msg(DM_MINJI, i + 1, P("13"), b)),
  [chId(1)]: BODIES.slice(0, 3).map((b, i) => msg(chId(1), i + 1, P("12"), b)),
};
// [마지막으로 읽은 seq, 최신 seq]
const READ = {
  [chId(1)]: [3, 3], [chId(2)]: [0, 0],
  [DM_SEOYEON]: [10, 10], [DM_JIHO]: [4, 4], [DM_AGENT]: [0, 0], [DM_GROUP]: [0, 0], [DM_MINJI]: [2, 2],
};

const results = [];
function check(scene, name, ok, detail) {
  results.push({ scene, name, ok: Boolean(ok), detail });
  console.log(JSON.stringify({ scene, check: name, ok: Boolean(ok), detail }));
}
async function attempt(scene, fn) {
  try {
    await fn();
  } catch (error) {
    check(scene, "(실행 실패)", false, String(error?.message ?? error).split("\n")[0]);
  }
}

function wireRead(state, id) {
  const [lastRead, base] = READ[id];
  const latest = Math.max(base, ...(state.extra[id] ?? []).map((m) => m.seq));
  const floor = state.left.get(id) ?? null;
  const read = floor === null ? lastRead : Math.max(lastRead, floor - 1);
  const row = {
    channel_id: id, last_read_seq: read, latest_seq: latest, unread_count: Math.max(0, latest - read), mention_count: 0,
    marked_unread_before_seq: null, latest_readable_seq: latest, closed_at_seq: floor === null ? null : floor - 1,
  };
  if (!state.legacy) row.history_from_seq = floor;
  return row;
}

async function installMocks(context, opts = {}) {
  const state = {
    legacy: opts.legacy ?? false,
    left: new Map(opts.left ?? []),
    extra: {},
    leaveDelayMs: opts.leaveDelayMs ?? 0,
    leaveStatus: opts.leaveStatus ?? 204,
    leaveCalls: [],
    readDelayMs: opts.readDelayMs ?? 0,
    scheduledDelayMs: opts.scheduledDelayMs ?? 0,
    scheduledStatus: opts.scheduledStatus ?? 200,
  };
  const auth = {
    accessToken: "capture-only-not-a-credential", refreshToken: "capture-only-not-a-credential",
    member: { id: ME, workspaceId, kind: "human", displayName: "김도현", handle: "dohyeon" },
    realtimeWebSocketUrl: "ws://leave-5825-capture.invalid/connection/websocket",
  };
  await context.route("**/v1/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId: ME });
    const leave = /\/channels\/([^/]+)\/dm-leave$/.exec(path);
    if (leave && req.method() === "PUT") {
      const body = JSON.parse(req.postData() ?? "{}");
      state.leaveCalls.push({ channelId: leave[1], seenSeq: body.seenSeq, at: Date.now() });
      if (state.leaveDelayMs > 0) await sleep(state.leaveDelayMs);
      if (state.leaveStatus !== 204) return json(route, { error: { code: "x", message: "x" } }, state.leaveStatus);
      state.left.set(leave[1].toLowerCase(), Math.max(state.left.get(leave[1].toLowerCase()) ?? 0, body.seenSeq + 1));
      return route.fulfill({ status: 204, body: "" });
    }
    if (path.endsWith("/read-state") && req.method() === "GET") {
      if (state.readDelayMs > 0) await sleep(state.readDelayMs);
      return json(route, { read_states: Object.keys(READ).map((id) => wireRead(state, id)) });
    }
    if (path.endsWith("/read-state")) return json(route, wireRead(state, path.split("/").at(-2)));
    if (path.endsWith("/scheduled-messages")) {
      if (state.scheduledDelayMs > 0) await sleep(state.scheduledDelayMs);
      if (state.scheduledStatus !== 200) return json(route, { error: { code: "x", message: "x" } }, state.scheduledStatus);
      return json(route, {
        scheduledMessages: [
          { id: "s1", workspaceId, memberId: ME, channelId: DM_SEOYEON, body: "금요일 회의 안내", sendAtMs: now + 86_400_000, status: "pending", rev: 1, createdAtMs: now, updatedAtMs: now },
          { id: "s2", workspaceId, memberId: ME, channelId: DM_SEOYEON, body: "자료 전달", sendAtMs: now - 60_000, status: "failed", failureReason: "x", rev: 1, createdAtMs: now, updatedAtMs: now },
        ],
      });
    }
    if (path.endsWith("/members/me/sidebar-prefs")) return json(route, { prefs: { version: 1, sections: [], starredChannelIds: [] } });
    if (/\/agents\/[^/]+\/liveness$/.test(path)) return json(route, { agentMemberId: P("14"), state: "inactive" });
    if (path.endsWith("/channels")) return json(route, { channels: [...channels, ...dms] });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith(`/workspaces/${workspaceId}`)) return json(route, { workspace: { id: workspaceId, name: "새벽거리" } });
    const list = /\/channels\/([^/]+)\/messages$/.exec(path);
    if (list) {
      const id = list[1].toLowerCase();
      const floor = state.left.get(id) ?? 1;
      let rows = [...(BASE_MESSAGES[id] ?? []), ...(state.extra[id] ?? [])].filter((m) => m.seq >= floor);
      const after = url.searchParams.get("after");
      const before = url.searchParams.get("before");
      if (after !== null) rows = rows.filter((m) => m.seq > Number(after));
      if (before !== null) rows = rows.filter((m) => m.seq < Number(before));
      return json(route, { messages: rows.sort((a, b) => b.seq - a.seq) });
    }
    if (path.includes("/messages")) return json(route, {});
    return json(route, {});
  });
  await context.addInitScript(() => {
    window.__offset = 0;
    class CaptureSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      constructor(url) { this.url = String(url); this.readyState = 0; window.__socket = this; queueMicrotask(() => { this.readyState = 1; this.onopen?.(new Event("open")); }); }
      send(data) {
        const replies = String(data).trim().split("\n").map((line) => {
          const c = JSON.parse(line);
          if (c.connect) return { id: c.id, connect: { client: "leave", version: "6" } };
          if (c.subscribe) return { id: c.id, subscribe: { recoverable: true, positioned: true, recovered: false, epoch: "cap", offset: 0 } };
          return { id: c.id };
        });
        queueMicrotask(() => this.onmessage?.(new MessageEvent("message", { data: replies.map((r) => JSON.stringify(r)).join("\n") })));
      }
      close() { this.readyState = 3; this.onclose?.(new CloseEvent("close", { code: 1000 })); }
    }
    window.WebSocket = CaptureSocket;
    window.__push = (channel, data) => {
      window.__offset += 1;
      window.__socket?.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ push: { channel, pub: { data, offset: window.__offset } } }) }));
    };
  });
  return state;
}

async function boot(browser, origin, { scheme = "light", viewport = { width: 1280, height: 800 }, deviceScaleFactor = 1, path = "", ...opts } = {}) {
  const context = await browser.newContext({ viewport, deviceScaleFactor, colorScheme: scheme, serviceWorkers: "block", reducedMotion: "reduce", locale: "ko-KR" });
  const state = await installMocks(context, opts);
  await context.addInitScript((server) => { try { if (!localStorage.getItem("momo.web.server.v1")) localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ } }, origin);
  const page = await context.newPage();
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.locator(`[data-testid="channel-item"][data-channel-id="${chId(1)}"]`).waitFor({ timeout: 30_000 });
  if (path) await page.evaluate((p) => { window.location.hash = p; }, path);
  await page.waitForTimeout(400);
  return { context, page, state };
}

const row = (page, id) => page.locator(`[data-testid="channel-item"][data-channel-id="${id}"]`);
const MENU = '[data-testid="channel-row-menu"]';
async function shot(page, engine, name) {
  if (!SHOTS) return;
  await page.screenshot({ path: resolve(OUT_DIR, `${engine}-${name}.png`) });
}
async function rowMenuItems(page, id) {
  await row(page, id).click({ button: "right" });
  await page.locator(MENU).waitFor({ timeout: 3_000 });
  await page.waitForTimeout(120);
  return page.evaluate((sel) => {
    const panel = document.querySelector(sel);
    return Array.from(panel?.children ?? []).map((el) => ({
      role: el.getAttribute("role"),
      testid: el.getAttribute("data-testid"),
      text: (el.textContent ?? "").trim(),
      color: getComputedStyle(el).color,
      iconColor: el.querySelector("svg") ? getComputedStyle(el.querySelector("svg")).color : null,
      icon: el.querySelector("svg[data-menu-icon]")?.getAttribute("data-menu-icon") ?? null,
    }));
  }, MENU);
}
async function closeMenus(page) {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
}
const dangerColor = (page) =>
  page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--danger)";
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
const center = async (locator) => {
  const b = await locator.boundingBox();
  return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null;
};
const whatIsAt = (page, pt) =>
  page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    const hit = el.closest("button, a, [role='menuitem'], [role='alertdialog'], [data-testid]");
    return hit ? { tag: hit.tagName.toLowerCase(), testid: hit.getAttribute("data-testid"), role: hit.getAttribute("role"), interactive: hit.matches("button, a, [role='menuitem']") } : { tag: el.tagName.toLowerCase() };
  }, pt);
const focusInfo = (page) =>
  page.evaluate(() => ({ tag: document.activeElement?.tagName.toLowerCase(), testid: document.activeElement?.getAttribute("data-testid"), channel: document.activeElement?.getAttribute("data-channel-id") }));

/**
 * 확정을 누른다. 공용 확인 단계의 「선 뒤 500ms 눌림 무시」 가드(#5813)가 있는 판이면 `data-armed="true"` 를 기다리고, 그 속성이 없는 판
 * (가드 전)이면 바로 누른다 - 두 판에서 같은 장면이 돈다.
 */
async function clickConfirm(page) {
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-testid="dm-leave-confirm-confirm"]');
    return button !== null && button.getAttribute("data-armed") !== "false";
  }, null, { timeout: 5_000 });
  await page.getByTestId("dm-leave-confirm-confirm").click();
}

async function openLeaveFromRow(page, id) {
  await row(page, id).click({ button: "right" });
  await page.locator(MENU).waitFor({ timeout: 3_000 });
  const item = page.getByTestId("channel-row-leave-dm");
  const pt = await center(item);
  await item.click();
  await page.getByTestId("dm-leave-confirm").waitFor({ timeout: 5_000 });
  await page.waitForTimeout(250);
  return pt;
}

// ---- A · 메뉴 줄 ---------------------------------------------------------------------------------------------

async function sceneMenus(browser, origin, engine, scheme) {
  const scene = `A-menus-${engine}-${scheme}`;
  const { context, page } = await boot(browser, origin, { scheme });
  try {
    const danger = await dangerColor(page);
    await attempt(scene, async () => {
      const items = await rowMenuItems(page, DM_SEOYEON);
      const menuitems = items.filter((i) => i.role === "menuitem");
      const last = items.at(-1);
      check(scene, "사람 1:1 줄 메뉴: 「대화 나가기」가 맨 아래", last?.testid === "channel-row-leave-dm" && last.text === "대화 나가기", items.map((i) => i.testid ?? i.role));
      check(scene, "그 위가 구분선, 그 위가 「목록에서 숨기기」", items.at(-2)?.role === "separator" && items.at(-3)?.testid === "channel-row-close-dm", items.slice(-3).map((i) => i.testid ?? i.role));
      check(scene, "위험색: 글자와 아이콘(DoorOpen=leave)이 --danger", last?.color === danger && last?.iconColor === danger && last?.icon === "leave", { color: last?.color, iconColor: last?.iconColor, danger });
      check(scene, "다른 줄은 위험색이 아니다", menuitems.slice(0, -1).every((i) => i.color !== danger), menuitems.map((i) => i.color));
      await shot(page, engine, `row-menu-${scheme}`);
      await closeMenus(page);
    });
    for (const [label, id] of [["에이전트 DM", DM_AGENT], ["그룹 DM", DM_GROUP], ["채널", chId(2)]]) {
      await attempt(scene, async () => {
        const items = await rowMenuItems(page, id);
        check(scene, `${label}: 「대화 나가기」 없음`, !items.some((i) => i.testid === "channel-row-leave-dm"), items.map((i) => i.testid ?? i.role));
        await closeMenus(page);
      });
    }
    await attempt(scene, async () => {
      await page.evaluate((p) => { window.location.hash = p; }, `/c/${DM_SEOYEON}`);
      await page.getByTestId("channel-title-menu").waitFor({ timeout: 5_000 });
      await page.getByTestId("channel-title-menu").click();
      await page.getByTestId("channel-title-menu-content").waitFor();
      await page.waitForTimeout(150);
      const items = await page.evaluate(() => Array.from(document.querySelector('[data-testid="channel-title-menu-content"]').children).map((el) => el.getAttribute("data-testid") ?? el.getAttribute("role")));
      check(scene, "대화 머리 ⋮: 알림 · 구분선 · 「대화 나가기」(맨 아래)", items.at(-1) === "channel-leave-dm" && items.at(-2) === "separator", items);
      const label = await page.getByTestId("channel-title-menu").getAttribute("aria-label");
      check(scene, "머리 ⋮ 낭독 이름", label === "이서연 다이렉트 메시지 메뉴", label);
      await shot(page, engine, `header-menu-${scheme}`);
      await closeMenus(page);
      await page.evaluate((p) => { window.location.hash = p; }, `/c/${DM_AGENT}`);
      await page.waitForTimeout(500);
      check(scene, "에이전트 DM 머리에는 ⋮ 없음", (await page.getByTestId("channel-title-menu").count()) === 0, null);
    });
  } finally {
    await context.close();
  }
  if (scheme !== "light") return;
  const legacy = await boot(browser, origin, { legacy: true });
  try {
    await attempt(scene, async () => {
      const items = await rowMenuItems(legacy.page, DM_SEOYEON);
      check(scene, "옛 서버(투영에 하한 칸 없음): 줄 메뉴에 「대화 나가기」 0", !items.some((i) => i.testid === "channel-row-leave-dm") && items.some((i) => i.testid === "channel-row-close-dm"), items.map((i) => i.testid ?? i.role));
      await closeMenus(legacy.page);
      await legacy.page.evaluate((p) => { window.location.hash = p; }, `/c/${DM_SEOYEON}`);
      await legacy.page.waitForTimeout(600);
      check(scene, "옛 서버: 대화 머리 ⋮ 없음", (await legacy.page.getByTestId("channel-title-menu").count()) === 0, null);
    });
  } finally {
    await legacy.context.close();
  }
}

// ---- B · 확인 창 네 상태 + D 두 번 누름 자리 ---------------------------------------------------------------------

async function sceneStates(browser, origin, engine, scheme) {
  const scene = `B-states-${engine}-${scheme}`;
  const { context, page, state } = await boot(browser, origin, { scheme, leaveDelayMs: 1_200 });
  try {
    await attempt(scene, async () => {
      const itemPt = await openLeaveFromRow(page, DM_SEOYEON);
      const dialog = page.getByTestId("dm-leave-confirm");
      const name = await page.evaluate(() => {
        const d = document.querySelector('[data-testid="dm-leave-confirm"]');
        return { role: d.getAttribute("role"), name: document.getElementById(d.getAttribute("aria-labelledby"))?.textContent, desc: document.getElementById(d.getAttribute("aria-describedby") ?? "")?.textContent };
      });
      const byName = await page.getByRole("alertdialog", { name: "이서연 님과의 대화에서 나갈까요?" }).count();
      const labelled = await page.evaluate(() => {
        const d = document.querySelector('[data-testid="dm-leave-confirm"]');
        return { labelledby: d.getAttribute("aria-labelledby"), titleId: d.querySelector("h2")?.id ?? null };
      });
      check(scene, "쉼: alertdialog · 낭독 이름 = 제목(접근성 트리)", name.role === "alertdialog" && byName === 1, { ...name, byName, ...labelled });
      check(scene, "쉼: 설명에 본문·되살림·예약 2개(pending+failed)", /그대로 남아요/.test(name.desc ?? "") && /그 글부터/.test(name.desc ?? "") && /예약해 둔 메시지 2개도 취소돼요/.test(name.desc ?? ""), name.desc);
      const warning = await page.getByTestId("dm-leave-confirm-warning").textContent();
      check(scene, "쉼: 경고 줄 「나간 뒤에는 되돌릴 수 없어요.」", warning === "나간 뒤에는 되돌릴 수 없어요.", warning);
      check(scene, "쉼: 초점은 「취소」", (await focusInfo(page)).testid === "dm-leave-confirm-cancel", await focusInfo(page));
      const under = itemPt ? await whatIsAt(page, itemPt) : null;
      const confirmBox = await page.getByTestId("dm-leave-confirm-confirm").boundingBox();
      const cancelBox = await page.getByTestId("dm-leave-confirm-cancel").boundingBox();
      const onConfirm = itemPt && confirmBox && itemPt.x >= confirmBox.x && itemPt.x <= confirmBox.x + confirmBox.width && itemPt.y >= confirmBox.y && itemPt.y <= confirmBox.y + confirmBox.height;
      check(scene, "두 번 누름: 메뉴 줄을 누른 자리에 확정 단추가 없다", !onConfirm, { itemPt, under, confirmBox, cancelBox });
      await shot(page, engine, `dialog-idle-${scheme}`);
      // 진행 중
      const confirmPt = await center(page.getByTestId("dm-leave-confirm-confirm"));
      await clickConfirm(page);
      await page.waitForTimeout(200);
      const busy = await page.evaluate(() => ({
        confirm: document.querySelector('[data-testid="dm-leave-confirm-confirm"]')?.getAttribute("aria-busy"),
        cancel: document.querySelector('[data-testid="dm-leave-confirm-cancel"]')?.getAttribute("aria-disabled"),
      }));
      check(scene, "진행 중: 확정 aria-busy · 취소 aria-disabled", busy.confirm === "true" && busy.cancel === "true", busy);
      await shot(page, engine, `dialog-busy-${scheme}`);
      await page.keyboard.press("Escape");
      await page.getByTestId("dm-leave-confirm-cancel").click({ force: true });
      await page.waitForTimeout(100);
      check(scene, "진행 중: Esc·취소를 눌러도 창이 그대로", (await dialog.count()) === 1, null);
      // 성공
      await page.waitForFunction(() => document.querySelector('[data-testid="dm-leave-confirm"]') === null, null, { timeout: 5_000 });
      await page.waitForTimeout(120);
      const after = await page.evaluate((id) => ({
        receipt: document.querySelector('[data-testid="dm-leave-receipt"]')?.textContent ?? null,
        row: document.querySelector(`[data-testid="channel-item"][data-channel-id="${id}"]`) !== null,
        announce: document.querySelector('[data-testid="dm-leave-announce"]')?.textContent ?? null,
      }), DM_SEOYEON);
      check(scene, "성공: 창 닫힘 · 줄 자리에 「대화에서 나갔어요.」 · 줄 없음 · 낭독", after.receipt === "대화에서 나갔어요." && !after.row && after.announce === "대화에서 나갔어요.", after);
      check(scene, "성공: PUT 한 번 · seenSeq = 투영의 최신 seq(10)", state.leaveCalls.length === 1 && state.leaveCalls[0].seenSeq === 10, state.leaveCalls);
      await page.waitForTimeout(100);
      const focus = await focusInfo(page);
      check(scene, "성공: 캐럿이 <body> 가 아니라 이웃 줄(박지호)", focus.tag !== "body" && focus.channel === DM_JIHO, focus);
      const underConfirm = confirmPt ? await whatIsAt(page, confirmPt) : null;
      check(scene, "두 번 누름: 창이 닫힌 뒤 확정 단추 자리(기록)", true, { confirmPt, underConfirm });
      await shot(page, engine, `after-success-${scheme}`);
    });
  } finally {
    await context.close();
  }
  const failing = await boot(browser, origin, { scheme, leaveStatus: 500 });
  try {
    await attempt(scene, async () => {
      const { page } = failing;
      await openLeaveFromRow(page, DM_SEOYEON);
      await clickConfirm(page);
      await page.getByTestId("dm-leave-confirm-error").waitFor({ timeout: 5_000 });
      const err = await page.evaluate(() => ({
        text: document.querySelector('[data-testid="dm-leave-confirm-error"]')?.textContent,
        role: document.querySelector('[data-testid="dm-leave-confirm-error"]')?.getAttribute("role"),
        busy: document.querySelector('[data-testid="dm-leave-confirm-confirm"]')?.getAttribute("aria-busy"),
      }));
      check(scene, "실패: 창 안 alert 한 줄 · 확정은 다시 누를 수 있다", err.text === "나가지 못했어요. 다시 시도해 주세요." && err.role === "alert" && err.busy === null, err);
      check(scene, "실패: 줄은 그대로 · 영수증 없음", (await row(page, DM_SEOYEON).count()) === 1 && (await page.getByTestId("dm-leave-receipt").count()) === 0, null);
      await shot(page, engine, `dialog-failed-${scheme}`);
      await clickConfirm(page);
      await page.waitForTimeout(400);
      check(scene, "실패 뒤 다시 시도: PUT 이 한 번 더 나간다", failing.state.leaveCalls.length === 2, failing.state.leaveCalls.length);
      await page.getByTestId("dm-leave-confirm-cancel").click();
      await page.waitForTimeout(250);
      const focus = await focusInfo(page);
      check(scene, "취소: 캐럿이 연 줄(이서연)로", focus.channel === DM_SEOYEON, focus);
    });
  } finally {
    await failing.context.close();
  }
}

// ---- C · 키보드 -------------------------------------------------------------------------------------------------

async function sceneKeyboard(browser, origin, engine) {
  const scene = `C-keyboard-${engine}`;
  // macOS WebKit 은 기본 설정에서 Tab 이 단추에 서지 않는다(전체 키보드 접근). 단추 순회는 Option+Tab 이다.
  const TAB = engine === "webkit" ? "Alt+Tab" : "Tab";
  const BACK = engine === "webkit" ? "Alt+Shift+Tab" : "Shift+Tab";
  const { context, page } = await boot(browser, origin, {});
  try {
    await attempt(scene, async () => {
      await row(page, DM_SEOYEON).focus();
      await page.keyboard.press("Shift+F10");
      await page.locator(MENU).waitFor({ timeout: 3_000 });
      await page.keyboard.press("End");
      await page.waitForTimeout(80);
      const at = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
      check(scene, "Shift+F10 → End: 「대화 나가기」에 캐럿", at === "channel-row-leave-dm", at);
      await page.keyboard.press("Enter");
      await page.getByTestId("dm-leave-confirm").waitFor({ timeout: 5_000 });
      await page.waitForTimeout(250);
      const stops = [];
      stops.push((await focusInfo(page)).testid);
      for (let i = 0; i < 3; i++) {
        await page.keyboard.press(TAB);
        stops.push((await focusInfo(page)).testid);
      }
      await page.keyboard.press(BACK);
      stops.push((await focusInfo(page)).testid);
      check(scene, "창 안 Tab 가둠: 취소 → 나가기 → 취소 …, Shift+Tab 거꾸로", stops.every((s) => s === "dm-leave-confirm-cancel" || s === "dm-leave-confirm-confirm") && stops[0] === "dm-leave-confirm-cancel" && stops[1] === "dm-leave-confirm-confirm", stops);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      const back = await focusInfo(page);
      check(scene, "Esc: 창이 닫히고 캐럿이 연 줄로", (await page.getByTestId("dm-leave-confirm").count()) === 0 && back.channel === DM_SEOYEON, back);
      // Enter 는 초점이 「취소」라 닫기만 한다(되돌릴 수 없는 일이 기본 동작이 아니다).
      await page.keyboard.press("Shift+F10");
      await page.locator(MENU).waitFor({ timeout: 3_000 });
      await page.keyboard.press("End");
      // 캐럿이 「대화 나가기」에 선 뒤에 Enter(첫 회와 같은 차례 - 기다리지 않으면 Enter 가 앞 줄에 떨어진다).
      await page.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "channel-row-leave-dm", null, { timeout: 3_000 });
      await page.keyboard.press("Enter");
      await page.getByTestId("dm-leave-confirm").waitFor({ timeout: 5_000 });
      await page.waitForTimeout(250);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(300);
      check(scene, "창에서 바로 Enter: 「취소」라 아무것도 나가지 않는다", (await page.getByTestId("dm-leave-confirm").count()) === 0 && (await row(page, DM_SEOYEON).count()) === 1, null);
    });
  } finally {
    await context.close();
  }
}

// ---- E · 영수증이 서고 걷힐 때 -----------------------------------------------------------------------------------

async function trackRows(page, ids, ms) {
  return page.evaluate(([ids, ms]) => new Promise((resolve) => {
    const frames = [];
    const t0 = performance.now();
    const tick = () => {
      const receiptEl = document.querySelector('[data-testid="dm-leave-receipt"]');
      const f = { t: Math.round(performance.now() - t0), receipt: receiptEl !== null, receiptH: receiptEl ? Math.round(receiptEl.getBoundingClientRect().height * 100) / 100 : null };
      for (const id of ids) {
        const el = document.querySelector(`[data-testid="channel-item"][data-channel-id="${id}"]`);
        f[id.slice(-2)] = el ? Math.round(el.getBoundingClientRect().top * 100) / 100 : null;
      }
      frames.push(f);
      if (performance.now() - t0 < ms) requestAnimationFrame(tick);
      else resolve(frames);
    };
    requestAnimationFrame(tick);
  }), [ids, ms]);
}

async function sceneReceipt(browser, origin, engine, viewport = { width: 1280, height: 800 }) {
  const scene = `E-receipt-${engine}-${viewport.width}`;
  for (const pointer of ["outside", "inside"]) {
    const { context, page } = await boot(browser, origin, { viewport });
    try {
      await attempt(scene, async () => {
        if (viewport.width < 600) {
          await page.getByTestId("open-sidebar-drawer").click();
          await page.waitForTimeout(400);
        }
        const before = await row(page, DM_JIHO).boundingBox();
        const receiptSlot = await row(page, DM_SEOYEON).boundingBox();
        await openLeaveFromRow(page, DM_SEOYEON);
        const tracking = trackRows(page, [DM_JIHO, DM_MINJI], 3_200);
        await clickConfirm(page);
        if (pointer === "inside") {
          await page.waitForTimeout(300);
          const target = await center(row(page, DM_JIHO));
          await page.mouse.move(target.x, target.y);
        }
        const frames = await tracking;
        const shown = frames.filter((f) => f.receipt);
        const ys = shown.map((f) => f["02"]);

        check(scene, `영수증이 서는 순간: 아래 줄(박지호) y 그대로 [${pointer}]`, shown.length > 0 && ys.every((y) => Math.abs(y - before.y) <= 0.5), { before: before.y, ys: [...new Set(ys)] });
        if (pointer === "outside") {
          const heights = [...new Set(shown.map((f) => f.receiptH))];
          check(scene, "영수증 상자 = 원래 줄 상자(프레임마다 높이 ±0.5)", heights.length > 0 && heights.every((h) => Math.abs(h - receiptSlot.height) <= 0.5), { heights, slot: receiptSlot.height });
          const gone = frames.find((f) => !f.receipt && f.t > 200);
          check(scene, "포인터가 목록 밖이면 1.6초 뒤 걷힌다", gone !== undefined && gone.t >= 1_550, gone);
        } else {
          check(scene, "포인터가 목록 안이면 1.6초가 지나도 걷히지 않는다(포인터 밑 줄이 그대로)", frames.at(-1).receipt === true && frames.filter((f) => f.t > 300).every((f) => Math.abs(f["02"] - before.y) <= 0.5), frames.at(-1));
          await page.mouse.move(viewport.width - 20, viewport.height / 2);
          await page.waitForTimeout(250);
          check(scene, "포인터가 목록을 떠나면 걷힌다", (await page.getByTestId("dm-leave-receipt").count()) === 0, null);
        }
        writeFileSync(resolve(OUT_DIR, `frames-${engine}-${viewport.width}-${pointer}.json`), JSON.stringify(frames));
      });
    } finally {
      await context.close();
    }
  }
}

// ---- F · 정리 ---------------------------------------------------------------------------------------------------

async function sceneCleanup(browser, origin, engine) {
  const scene = `F-cleanup-${engine}`;
  const { context, page } = await boot(browser, origin, {});
  const draftKey = (ch) => `momo.draft.v1:${workspaceId}:${ch}`;
  try {
    await attempt(scene, async () => {
      await page.evaluate(([a, b, me]) => {
        localStorage.setItem(a, JSON.stringify({ text: "옛 대화에 쓰던 글", atMs: Date.now(), author: me }));
        localStorage.setItem(b, JSON.stringify({ text: "다른 대화에 쓰던 글", atMs: Date.now(), author: me }));
      }, [draftKey(DM_SEOYEON), draftKey(DM_JIHO), ME]);
      await openLeaveFromRow(page, DM_SEOYEON);
      await clickConfirm(page);
      await page.waitForTimeout(500);
      const left = await page.evaluate(([a, b]) => [localStorage.getItem(a), localStorage.getItem(b)], [draftKey(DM_SEOYEON), draftKey(DM_JIHO)]);
      check(scene, "줄 메뉴: 나간 대화 초안 0 · 다른 대화 초안 그대로", left[0] === null && left[1] !== null, left);
    });
  } finally {
    await context.close();
  }
  const header = await boot(browser, origin, { path: `/c/${DM_SEOYEON}` });
  try {
    await attempt(scene, async () => {
      const { page } = header;
      await page.getByTestId("composer-input").waitFor({ timeout: 5_000 });
      await page.getByTestId("composer-input").click();
      await page.keyboard.type("나가기 전에 쓰던 글");
      await page.waitForTimeout(150);
      await page.getByTestId("channel-title-menu").click();
      await page.getByTestId("channel-leave-dm").click();
      await page.getByTestId("dm-leave-confirm").waitFor({ timeout: 5_000 });
      await page.waitForTimeout(250);
      await clickConfirm(page);
      await page.waitForTimeout(800);
      const hash = await page.evaluate(() => window.location.hash);
      const draft = await page.evaluate((k) => localStorage.getItem(k), draftKey(DM_SEOYEON));
      check(scene, "머리 ⋮: 그 대화를 떠나 `/` 로", !hash.toLowerCase().includes(DM_SEOYEON), hash);
      check(scene, "머리 ⋮: 나간 대화 초안 0(입력칸에 쓰던 중)", draft === null, draft);
      const focus = await focusInfo(page);
      check(scene, "머리 ⋮: 캐럿이 <body> 가 아니다", focus.tag !== "body", focus);
      await shot(page, engine, "after-header-leave");
    });
  } finally {
    await header.context.close();
  }
}

// ---- G · 하한 아래 발행물 · 다시 이어짐 · H 첫 페인트 -----------------------------------------------------------

async function sceneFloor(browser, origin, engine) {
  const scene = `G-floor-${engine}`;
  const { context, page, state } = await boot(browser, origin, {});
  const chan = `ch:ws${workspaceId.toUpperCase()}.${DM_SEOYEON.toUpperCase()}`;
  const frame = (seq, body, author = P("11")) => ({
    type: "message.new", v: 1, ts: Date.now(), seq,
    payload: { id: `${DM_SEOYEON.slice(0, 30)}${String(seq).padStart(6, "0")}`, channel_id: DM_SEOYEON, seq, type: "text", body, author_member_id: author, hlc_ts: Date.now(), hlc_count: 0, created_at_ms: Date.now(), state: "sent" },
  });
  const count = () => page.evaluate(() => Number((document.querySelector('[data-testid="message-count"]')?.textContent ?? "").replace(/\D/g, "")));
  try {
    await attempt(scene, async () => {
      await openLeaveFromRow(page, DM_SEOYEON);
      await clickConfirm(page);
      await page.waitForTimeout(400);
      // 상대가 새 글(11)을 보낸다.
      state.extra[DM_SEOYEON.toLowerCase()] = [msg(DM_SEOYEON, 11, P("11"), "새로 시작해요, 내일 봐요")];
      await page.evaluate((p) => { window.location.hash = p; }, `/c/${DM_SEOYEON}`);
      await page.waitForTimeout(800);
      const first = await count();
      check(scene, "다시 연 대화: 하한 위 글(11)만 보인다", first === 1, first);
      const pinned = (seq, body) => ({
        type: "message.pinned", v: 1, ts: Date.now(), seq,
        payload: { message_id: `${DM_SEOYEON.slice(0, 30)}${String(seq).padStart(6, "0")}`, channel_id: DM_SEOYEON, seq, author_member_id: P("11"), type: "text", state: "sent", body, created_at_ms: Date.now() - 600_000, pinned_by: P("11"), pinned_at_ms: Date.now() },
      });
      const pinItems = async () => {
        await page.getByTestId("open-pin-list").click();
        await page.getByTestId("pin-list").waitFor({ timeout: 3_000 });
        await page.waitForTimeout(150);
        const n = await page.getByTestId("pin-list-item").count();
        await page.keyboard.press("Escape");
        await page.waitForTimeout(150);
        return n;
      };
      await page.evaluate(([c, f]) => window.__push(c, f), [chan, frame(5, "하한 아래 글 다섯")]);
      await page.evaluate(([c, f]) => window.__push(c, f), [chan, pinned(3, "하한 아래 고정 글")]);
      await page.waitForTimeout(300);
      const afterOld = await count();
      const oldText = await page.evaluate(() => document.body.textContent.includes("하한 아래 글 다섯"));
      const oldPins = await pinItems();
      check(scene, "하한 아래 발행물(새 글 5 · 고정 3)은 그려지지 않는다(이력 · 머리 고정 목록)", afterOld === 1 && !oldText && oldPins === 0, { afterOld, oldText, oldPins });
      await page.evaluate(([c, f]) => window.__push(c, f), [chan, pinned(11, "새로 시작해요, 내일 봐요")]);
      await page.waitForTimeout(300);
      const newPins = await pinItems();
      check(scene, "대조: 하한 위 고정(11)은 고정 목록에 선다", newPins === 1, newPins);
      await page.evaluate(([c, f]) => window.__push(c, f), [chan, frame(12, "하한 위 새 글")]);
      await page.waitForTimeout(300);
      const afterNew = await count();
      check(scene, "하한 위 새 글(12)은 그려진다", afterNew === 2, afterNew);
      await shot(page, engine, "reopened-after-leave");
      // 새로고침: 새 글이 온 대화는 목록에 다시 선다.
      await page.evaluate(() => { window.location.hash = "/"; });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.locator(`[data-testid="channel-item"][data-channel-id="${chId(1)}"]`).waitFor({ timeout: 30_000 });
      await page.waitForTimeout(600);
      check(scene, "새 글이 온 나간 대화: 줄이 다시 선다", (await row(page, DM_SEOYEON).count()) === 1, null);
    });
  } finally {
    await context.close();
  }
  // H 첫 페인트: 나간 대화(새 글 없음)가 투영이 늦게 와도 목록에 서지 않는다.
  const cold = await boot(browser, origin, {});
  try {
    await attempt(`H-firstpaint-${engine}`, async () => {
      const { page, state: s } = cold;
      await openLeaveFromRow(page, DM_SEOYEON);
      await clickConfirm(page);
      await page.waitForTimeout(2_200);
      // 사본이 하한을 적도록 한 번 다시 읽힌 뒤(30초 폴링을 기다리지 않고 새로고침) 투영을 늦춘다.
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.locator(`[data-testid="channel-item"][data-channel-id="${chId(1)}"]`).waitFor({ timeout: 30_000 });
      await page.waitForTimeout(600);
      s.readDelayMs = 2_000;
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.locator(`[data-testid="channel-item"][data-channel-id="${chId(1)}"]`).waitFor({ timeout: 30_000 });
      const seen = [];
      for (let i = 0; i < 12; i++) {
        seen.push(await row(page, DM_SEOYEON).count());
        await page.waitForTimeout(150);
      }
      await page.getByTestId("sidebar-section-dms-header").hover();
      await page.waitForTimeout(200);
      const closedCount = await page.evaluate(() => document.querySelector('[data-testid="dm-section-menu"]')?.getAttribute("data-closed-count") ?? "(문 없음 = 0)");
      check(`H-firstpaint-${engine}`, "투영이 오기 전(첫 페인트)부터 나간 대화가 목록에 없다", seen.every((n) => n === 0), seen);
      check(`H-firstpaint-${engine}`, "「숨긴 대화」 수에 들지 않는다(머리에 호버해 문을 세운 뒤 읽음)", closedCount === "(문 없음 = 0)" || closedCount === "0", closedCount);
    });
  } finally {
    await cold.context.close();
  }
}

// ---- I · 머리 ⋮ 가 늦게 설 때 / J 예약 목록 ------------------------------------------------------------------------

async function sceneLate(browser, origin, engine) {
  const scene = `I-late-${engine}`;
  const { context, page, state } = await boot(browser, origin, {});
  try {
    await attempt(scene, async () => {
      state.readDelayMs = 1_500;
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.evaluate((p) => { window.location.hash = p; }, `/c/${DM_SEOYEON}`);
      const samples = [];
      for (let i = 0; i < 20; i++) {
        samples.push(await page.evaluate(() => {
          const group = document.querySelector('[data-testid="channel-header-controls"]');
          return group ? Array.from(group.querySelectorAll("button")).map((b) => ({ id: b.getAttribute("data-testid"), x: Math.round(b.getBoundingClientRect().left) })) : [];
        }));
        await page.waitForTimeout(120);
      }
      const menuSeen = samples.findIndex((s) => s.some((b) => b.id === "channel-title-menu"));
      const firstControls = samples.findIndex((s) => s.length > 0);
      // 단추마다 서 있던 동안의 x 흩어짐(최대 − 최소). 0 이면 늦게 오는 것이 머리 단추를 밀지 않았다.
      const drift = {};
      for (const sample of samples) for (const b of sample) (drift[b.id] ??= []).push(b.x);
      const moved = Object.entries(drift).map(([id, xs]) => ({ id, spread: Math.max(...xs) - Math.min(...xs), seen: xs.length })).filter((d) => d.spread > 0);
      check(scene, "투영이 늦어도 머리 단추가 옆으로 밀리지 않는다(단추마다 x 흩어짐 0)", moved.length === 0, { firstControlsAtSample: firstControls, menuSeenAtSample: menuSeen, moved, ids: Object.keys(drift) });
    });
  } finally {
    await context.close();
  }
  for (const [label, opts] of [["느림 1.5초", { scheduledDelayMs: 1_500 }], ["실패 500", { scheduledStatus: 500 }]]) {
    const late = await boot(browser, origin, opts);
    try {
      await attempt(`J-scheduled-${engine}`, async () => {
        const { page } = late;
        await row(page, DM_SEOYEON).click({ button: "right" });
        await page.locator(MENU).waitFor({ timeout: 3_000 });
        const t0 = Date.now();
        await page.getByTestId("channel-row-leave-dm").click();
        await page.getByTestId("dm-leave-confirm").waitFor({ timeout: 8_000 });
        const waited = Date.now() - t0;
        const info = await page.evaluate(() => ({
          text: document.querySelector('[data-testid="dm-leave-confirm"]')?.textContent ?? "",
          disabled: document.querySelector('[data-testid="dm-leave-confirm-confirm"]')?.getAttribute("aria-disabled"),
        }));
        check(`J-scheduled-${engine}`, `예약 목록 ${label}: 창이 서기까지(ms, 기록) · 내용`, opts.scheduledStatus === 500 ? info.disabled === "true" && info.text.includes("예약 목록을 불러오지 못했어요") : info.text.includes("2개"), { waited, ...info, text: info.text.slice(-60) });
        if (opts.scheduledStatus === 500) await shot(page, engine, "dialog-scheduled-failed");
      });
    } finally {
      await late.context.close();
    }
  }
}

// ---- K · 좁은 폭 · 200% ----------------------------------------------------------------------------------------

async function sceneZoom(browser, origin, engine) {
  for (const [label, viewport, dsf] of [["390", { width: 390, height: 844 }, 2], ["200pct", { width: 720, height: 450 }, 2]]) {
    const scene = `K-${label}-${engine}`;
    for (const scheme of ["light", "dark"]) {
      const { context, page } = await boot(browser, origin, { viewport, deviceScaleFactor: dsf, scheme });
      try {
        await attempt(scene, async () => {
          if (viewport.width < 600) {
            await page.getByTestId("open-sidebar-drawer").click();
            await page.waitForTimeout(400);
          }
          const itemPt = await openLeaveFromRow(page, DM_SEOYEON);
          const geo = await page.evaluate(() => {
            const d = document.querySelector('[data-testid="dm-leave-confirm"]').getBoundingClientRect();
            return { left: d.left, right: d.right, top: d.top, bottom: d.bottom, vw: window.innerWidth, vh: window.innerHeight, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
          });
          check(scene, `창이 화면 안 · 가로 넘침 0 [${scheme}]`, geo.left >= 0 && geo.right <= geo.vw && geo.overflow <= 0, geo);
          const confirmBox = await page.getByTestId("dm-leave-confirm-confirm").boundingBox();
          const onConfirm = itemPt && confirmBox && itemPt.x >= confirmBox.x && itemPt.x <= confirmBox.x + confirmBox.width && itemPt.y >= confirmBox.y && itemPt.y <= confirmBox.y + confirmBox.height;
          check(scene, `두 번 누름: 메뉴 줄 자리에 확정 단추가 없다 [${scheme}]`, !onConfirm, { itemPt, confirmBox });
          await shot(page, engine, `dialog-${label}-${scheme}`);
          await clickConfirm(page);
          await page.waitForTimeout(500);
          const focus = await focusInfo(page);
          check(scene, `성공 뒤 캐럿이 <body> 가 아니다 [${scheme}]`, focus.tag !== "body", focus);
          await shot(page, engine, `after-${label}-${scheme}`);
        });
      } finally {
        await context.close();
      }
    }
  }
}

// ---- M · 개인 채널로 옮겨 온 방 프레임 -------------------------------------------------------------------------

async function sceneRelayed(browser, origin, engine) {
  const scene = `M-relayed-${engine}`;
  const { context, page } = await boot(browser, origin, { path: `/c/${DM_JIHO}` });
  const personal = `user:read-state#${ME.toUpperCase()}`;
  const room = (ch) => `ch:ws${workspaceId.toUpperCase()}.${ch.toUpperCase()}`;
  const target = BASE_MESSAGES[DM_JIHO][1];
  const edited = (body, roomChannel) => ({
    type: "message.edited", v: 1, ts: Date.now(), seq: target.seq,
    payload: { id: target.id, channel_id: DM_JIHO, seq: target.seq, type: "text", body, author_member_id: target.authorMemberId, hlc_ts: target.hlcTs, hlc_count: 0, created_at_ms: target.createdAtMs, state: "sent", edited_at_ms: Date.now() },
    room_channel: roomChannel,
  });
  const hasText = (text) => page.evaluate((t) => document.querySelector('[data-testid="timeline-virtuoso"]')?.textContent?.includes(t) ?? false, text);
  try {
    await attempt(scene, async () => {
      await page.waitForFunction((t) => document.querySelector('[data-testid="timeline-virtuoso"]')?.textContent?.includes(t), target.body, { timeout: 8_000 });
      await page.evaluate(([c, f]) => window.__push(c, f), [personal, edited("다른 방 이름을 단 수정", room(DM_MINJI))]);
      await page.waitForTimeout(300);
      check(scene, "다른 방 이름(room_channel)을 단 프레임은 이 대화에 반영되지 않는다", !(await hasText("다른 방 이름을 단 수정")) && (await hasText(target.body)), null);
      await page.evaluate(([c, f]) => window.__push(c, f), [personal, edited("오후 4시로 바꿀게요", room(DM_JIHO))]);
      await page.waitForTimeout(400);
      check(scene, "개인 채널로 온 이 방의 수정이 열린 대화에 반영된다", (await hasText("오후 4시로 바꿀게요")) && !(await hasText(target.body)), null);
      await shot(page, engine, "relayed-edit");
    });
  } finally {
    await context.close();
  }
}

// ---- L · 머리 ⋮ 길: 390 서랍 닫힘 · 1280 목록 접힘 ---------------------------------------------------------------

async function sceneHeaderPath(browser, origin, engine) {
  for (const [label, viewport] of [["390", { width: 390, height: 844 }], ["1280-collapsed", { width: 1280, height: 800 }]]) {
    const scene = `L-header-${label}-${engine}`;
    const { context, page } = await boot(browser, origin, { viewport });
    try {
      await attempt(scene, async () => {
        if (label === "1280-collapsed") {
          await page.getByTestId("sidebar-toggle").click();
          await page.waitForTimeout(500);
        }
        await page.evaluate((p) => { window.location.hash = p; }, `/c/${DM_SEOYEON}`);
        await page.getByTestId("channel-title-menu").waitFor({ timeout: 5_000 });
        await page.getByTestId("channel-title-menu").click();
        await page.getByTestId("channel-leave-dm").click();
        await page.getByTestId("dm-leave-confirm").waitFor({ timeout: 5_000 });
        await page.waitForTimeout(250);
        check(scene, "확인 창이 서고 초점은 「취소」", (await focusInfo(page)).testid === "dm-leave-confirm-cancel", await focusInfo(page));
        await clickConfirm(page);
        await page.waitForTimeout(700);
        const after = await page.evaluate(() => ({
          hash: window.location.hash,
          drawerOpen: document.getElementById("sidebar-drawer")?.hasAttribute("data-open") ?? null,
          receiptVisible: (() => {
            const r = document.querySelector('[data-testid="dm-leave-receipt"]')?.getBoundingClientRect();
            return r ? r.width > 0 && r.right > 0 && r.left < window.innerWidth : false;
          })(),
          announce: document.querySelector('[data-testid="dm-leave-announce"]')?.textContent ?? null,
          focus: { tag: document.activeElement?.tagName.toLowerCase(), testid: document.activeElement?.getAttribute("data-testid") },
        }));
        check(scene, "그 대화를 떠나 `/` 로 · 낭독 영역이 「대화에서 나갔어요.」", !after.hash.toLowerCase().includes(DM_SEOYEON) && after.announce === "대화에서 나갔어요.", after);
        check(scene, "캐럿이 <body> 가 아니다", after.focus.tag !== "body", after.focus);
        if (label === "390") check(scene, "좁은 폭: 서랍(목록)이 열리고 영수증이 보인다", after.drawerOpen === true && after.receiptVisible, after);
        await shot(page, engine, `after-header-${label}`);
      });
    } finally {
      await context.close();
    }
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({
    webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT",
    ...(DIST_DIR ? { extraArgs: ["--outDir", resolve(DIST_DIR)] } : {}),
  });
  try {
    for (const engine of ENGINES) {
      const browser = await (engine === "webkit" ? webkit : chromium).launch();
      try {
        const run = async (key, fn) => { if (ONLY === null || ONLY.has(key)) await fn(); };
        await run("A", async () => { for (const scheme of ["light", "dark"]) await sceneMenus(browser, preview.origin, engine, scheme); });
        await run("B", async () => { for (const scheme of ["light", "dark"]) await sceneStates(browser, preview.origin, engine, scheme); });
        await run("C", () => sceneKeyboard(browser, preview.origin, engine));
        await run("E", async () => { await sceneReceipt(browser, preview.origin, engine); await sceneReceipt(browser, preview.origin, engine, { width: 390, height: 844 }); });
        await run("F", () => sceneCleanup(browser, preview.origin, engine));
        await run("G", () => sceneFloor(browser, preview.origin, engine));
        await run("I", () => sceneLate(browser, preview.origin, engine));
        await run("K", () => sceneZoom(browser, preview.origin, engine));
        await run("L", () => sceneHeaderPath(browser, preview.origin, engine));
        await run("M", () => sceneRelayed(browser, preview.origin, engine));
      } finally {
        await browser.close();
      }
    }
  } finally {
    await preview.stop?.();
  }
  const bad = results.filter((r) => !r.ok);
  writeFileSync(resolve(OUT_DIR, "c5825-results.json"), JSON.stringify(results, null, 1));
  console.log(bad.length === 0 ? `LEAVE-5825 PASS (${results.length} checks)` : `LEAVE-5825 FAIL (${bad.length}/${results.length}): ${bad.map((r) => `${r.scene}/${r.name}`).join(" | ")}`);
  process.exit(bad.length === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
