#!/usr/bin/env node
// =============================================================================
// 사이드바 행 호버·우클릭 통일 실측 + 캡처 (#3963).
//
// 성재(2026-10-16, Buzz 캡처 대조): 채널 행과 DM 행의 호버·우클릭이 달랐고, DM은 호버하면
// X로 닫을 수 있어야 하고, 우클릭하면 행에 테두리가 생기는 것도 고쳐 달라.
//
// 이 스크립트는 **재는 것**이 먼저이고 찍는 것이 그 다음이다. 아래 `check()`는 틀리면 기록하고
// 끝 코드를 1로 만든다(대기는 전부 실패할 수 있는 waitFor/expect). 같은 스크립트를 수리 전 번들과
// 수리 뒤 번들에 돌려 적색/녹색 두 줄을 PR에 남긴다.
//
//   npm run build && node scripts/capture-3963.mjs
//   OUT_DIR=… PREFIX=c3963 ENGINES=chromium,webkit node scripts/capture-3963.mjs
//
// 재는 것:
//   A. 쉴 때: 채널 행과 DM 행의 높이·이름 시작 위치·호버 배경이 같은가.
//   B. 호버: DM 행에만 X(사이드바에서 닫기)가 서고, 채널 행에는 서지 않는다. X가 글자·알약과 겹치지 않는다.
//   C. 우클릭(포인터): 열린 행에 테두리(outline)가 없다. 엔진 둘(Chromium·WebKit) 다.
//   D. 키보드: Tab/화살표로 닿은 행에는 포커스 링이 서고, Shift+F10으로 연 메뉴는 열림 표식이 남는다.
//   E. 메뉴 항목 목록(채널/DM)과 순서.
//   F. 닫기: X → 행이 사라지고, 새로고침해도 숨은 채이며, 새 메시지가 오면 다시 나타난다.
//   G. 읽지 않음으로 표시: PUT 몸통이 mark_unread_before_seq만 싣고 read_intent는 싣지 않는다.
// =============================================================================
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/sidebar-row-3963");
const PREFIX = process.env.PREFIX || "c3963";
const PORT = Number(process.env.CAPTURE_PORT || 5263);
const ENGINES = (process.env.ENGINES || "chromium,webkit").split(",");
const SHOTS = process.env.SHOTS !== "0";

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const CLOSED_KEY = "momo.web.sidebar-closed-dms.v1";
const chId = (n) => `00000000-0000-7000-8000-0000000002${String(n).padStart(2, "0")}`;
const dmId = (n) => `00000000-0000-7000-8000-0000000003${String(n).padStart(2, "0")}`;
const P = (n) => `00000000-0000-7000-8000-0000000001${n}`;
const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const channelNames = ["general", "workbench", "agent-lab", "design-2-0", "release"];
const channels = channelNames.map((name, i) => ({ id: chId(i + 1), workspaceId, kind: "public", name, muted: false }));
const person = (n, displayName, handle, extra = {}) => ({
  id: P(n), workspaceId, kind: "human", status: "active", displayName, handle, channelCount: 1, channelIds: [], capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...extra,
});
const roster = [
  person("01", "곽성재", "seongjae", { role: "owner", presenceStatus: "auto" }),
  person("11", "이도현", "dohyun"),
  person("12", "박서연", "seoyeon"),
  // 긴 이름(한글+부가 설명): 쉴 때도 잘리고, X가 서면 X 왼쪽에서 다시 잘려야 한다.
  person("13", "민수 (마케팅팀 · 글로벌 파트너십 총괄 디렉터)", "minsu", { presenceStatus: "away" }),
  person("15", "정하윤", "hayun", { presenceStatus: "dnd" }),
  person("14", "김인턴", "intern", { kind: "agent", hostOnline: true, ownerHumanId: P("01") }),
];
const dm = (n, other) => ({ id: dmId(n), workspaceId, kind: "dm", muted: false, memberIds: [P("01"), other] });
const dms = [dm(1, P("11")), dm(2, P("12")), dm(3, P("13")), dm(4, P("14")), dm(5, P("15"))];

// 서버 read-state 투영. [마지막으로 읽은 seq, 최신 seq]. 이도현 DM과 general만 안 읽음이 있다.
const READ = {
  [chId(1)]: [47, 50], [chId(2)]: [20, 20], [chId(3)]: [8, 8], [chId(4)]: [12, 12], [chId(5)]: [30, 30],
  [dmId(1)]: [10, 12], [dmId(2)]: [5, 5], [dmId(3)]: [7, 7], [dmId(4)]: [9, 9], [dmId(5)]: [3, 3],
};

const results = [];
function check(engine, scheme, name, ok, detail) {
  results.push({ engine, scheme, name, ok: Boolean(ok), detail });
  console.log(JSON.stringify({ engine, scheme, check: name, ok: Boolean(ok), detail }));
}
function info(engine, scheme, name, detail) {
  console.log(JSON.stringify({ engine, scheme, info: name, detail }));
}
async function attempt(engine, scheme, name, fn) {
  try {
    await fn();
  } catch (error) {
    check(engine, scheme, `${name} (실행 실패)`, false, String(error?.message ?? error).split("\n")[0]);
  }
}

function newState() {
  return { read: structuredClone(READ), puts: [], writes: [], livenessState: "inactive" };
}
const wireRead = (state, id) => ({
  channel_id: id, last_read_seq: state.read[id][0], latest_seq: state.read[id][1],
  unread_count: Math.max(0, state.read[id][1] - state.read[id][0]), mention_count: 0,
  marked_unread_before_seq: state.mark?.[id] ?? null,
});

async function installMocks(context, state) {
  const auth = {
    accessToken: "capture-only-not-a-credential", refreshToken: "capture-only-not-a-credential",
    member: { id: memberId, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
    realtimeWebSocketUrl: "ws://sidebar-row-3963-capture.invalid/connection/websocket",
  };
  await context.route("**/v1/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId });
    if (req.method() !== "GET" && !path.startsWith("/v1/auth/")) state.writes.push(`${req.method()} ${path}`);
    const perChannel = /\/channels\/([^/]+)\/read-state$/.exec(path);
    if (perChannel && req.method() === "PUT") {
      const id = perChannel[1];
      const body = JSON.parse(req.postData() ?? "{}");
      state.puts.push({ channel: id, body });
      if (body.mark_unread_before_seq !== undefined) (state.mark ??= {})[id] = body.mark_unread_before_seq;
      if (body.read_intent === "explicit_open") {
        state.read[id][0] = Math.max(state.read[id][0], Math.min(body.last_read_seq, state.read[id][1]));
        if (state.mark) delete state.mark[id];
      }
      return json(route, wireRead(state, id));
    }
    if (path.endsWith("/read-state")) return json(route, { read_states: Object.keys(state.read).map((id) => wireRead(state, id)) });
    if (path.endsWith("/members/me/sidebar-prefs")) {
      return json(route, { prefs: { version: 1, sections: [{ id: "sec-1", name: "출시 준비", order: 0, channelIds: [chId(5)] }], starredChannelIds: [chId(3)] } });
    }
    if (/\/agents\/[^/]+\/liveness$/.test(path)) return json(route, { agentMemberId: P("14"), state: state.livenessState });
    if (path.endsWith("/channels")) return json(route, { channels: [...channels, ...dms] });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith(`/workspaces/${workspaceId}`)) return json(route, { workspace: { id: workspaceId, name: "여명거리" } });
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
          if (c.connect) return { id: c.id, connect: { client: "row", version: "6" } };
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

async function login(page) {
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-item").first().waitFor({ timeout: 20_000 });
  await page.getByTestId("dm-avatar").first().waitFor({ timeout: 20_000 });
}

async function open(browserType, origin, scheme, state, viewport = { width: 1440, height: 900 }) {
  const browser = await browserType.launch();
  const context = await browser.newContext({ viewport, colorScheme: scheme, serviceWorkers: "block", reducedMotion: "reduce" });
  await installMocks(context, state);
  await context.addInitScript((server) => { try { if (!localStorage.getItem("momo.web.server.v1")) localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ } }, origin);
  const page = await context.newPage();
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await login(page);
  // 사이드바 배치(섹션·별표)가 도착해야 메뉴에 「섹션으로 이동」이 선다.
  await page.getByTestId("sidebar-section-sec-1").waitFor({ timeout: 20_000 });
  return { browser, context, page };
}

const rowOf = (page, id) => page.locator(`[data-testid="channel-item"][data-channel-id="${id}"]`);

/** 행 하나의 기하: 높이, 이름 글자의 왼쪽, 호버/현재 배경. */
async function geometry(page, id) {
  return rowOf(page, id).evaluate((a) => {
    const rect = a.getBoundingClientRect();
    const label = a.querySelector(":scope > span:nth-of-type(2) > span:first-child");
    const lrect = label?.getBoundingClientRect();
    const icon = a.querySelector("[data-row-icon]")?.firstElementChild?.getBoundingClientRect();
    return {
      height: Math.round(rect.height * 10) / 10,
      labelLeft: lrect ? Math.round((lrect.left - rect.left) * 10) / 10 : null,
      iconLeft: icon ? Math.round((icon.left - rect.left) * 10) / 10 : null,
      iconCenter: icon ? Math.round((icon.left + icon.width / 2 - rect.left) * 10) / 10 : null,
      bg: getComputedStyle(a).backgroundColor,
    };
  });
}

const OUTLINE = () => {
  const out = (el) => {
    if (!(el instanceof HTMLElement)) return null;
    const s = getComputedStyle(el);
    return { style: s.outlineStyle, width: s.outlineWidth, color: s.outlineColor, drawn: s.outlineStyle !== "none" && Number.parseFloat(s.outlineWidth) > 0 };
  };
  const trigger = document.querySelector('[data-row-menu-trigger][data-state="open"]');
  const active = document.activeElement;
  return {
    modality: document.documentElement.getAttribute("data-focus-modality"),
    trigger: out(trigger),
    triggerFound: Boolean(trigger),
    activeTag: active ? `${active.tagName.toLowerCase()}${active.getAttribute("data-testid") ? `[${active.getAttribute("data-testid")}]` : ""}` : null,
    active: active === document.body ? null : out(active),
  };
};

/** 메뉴 안의 항목(제목·행) 글자를 위에서 아래로. 구분선은 「---」. */
async function menuTexts(page) {
  return page.getByTestId("channel-row-menu").evaluate((menu) =>
    Array.from(
      menu.querySelectorAll(
        '[role="menuitem"], [role="menuitemradio"], [role="separator"], [data-testid="channel-row-move-to-section"], [data-testid="channel-row-copy-group"]'
      )
    ).map((el) => (el.getAttribute("role") === "separator" ? "---" : (el.textContent ?? "").trim()))
  );
}

async function closeMenu(page) {
  await page.keyboard.press("Escape");
  await page.getByTestId("channel-row-menu").waitFor({ state: "detached", timeout: 5_000 });
}

/** X 와 겹치는, 실제로 그려지는 글자·알약 요소들(폭이 0인 것은 그려지지 않는다). */
async function overlapOf(page, id) {
  return page.evaluate((channelId) => {
    const a = document.querySelector(`[data-testid="channel-item"][data-channel-id="${channelId}"]`);
    const x = document.querySelector('[data-testid="dm-close"]');
    const xr = x.getBoundingClientRect();
    const row = a.closest("li").getBoundingClientRect();
    const hits = [];
    for (const el of a.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || el.closest(".sr-only")) continue;
      const hasText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? "").trim() !== "");
      const isBadge = /^(unread-count|mention-badge|row-dot|agent-turn-badge|agent-liveness)$/.test(el.getAttribute("data-testid") ?? "");
      if (!hasText && !isBadge) continue;
      if (r.left < xr.right - 0.5 && xr.left < r.right - 0.5 && r.top < xr.bottom - 0.5 && xr.top < r.bottom - 0.5) hits.push(el.getAttribute("data-testid") ?? el.textContent?.trim());
    }
    return { hits, insideRow: xr.left >= row.left && xr.right <= row.right && xr.top >= row.top && xr.bottom <= row.bottom, size: [Math.round(xr.width), Math.round(xr.height)] };
  }, id);
}

async function runEngine(browserType, engine, origin) {
  const full = engine === "chromium";
  for (const scheme of full ? ["light", "dark"] : ["light"]) {
    const state = newState();
    const { browser, context, page } = await open(browserType, origin, scheme, state);
    const shot = async (name, clip = { x: 0, y: 0, width: 420, height: 900 }) => {
      if (!SHOTS || !full) return;
      await page.screenshot({ path: resolve(OUT_DIR, `${PREFIX}-${name}-${scheme}.png`), clip });
    };
    try {
      // 현재 보는 채널을 workbench로: 「선택된 행」에서의 우클릭까지 재기 위해.
      await rowOf(page, chId(2)).click();
      await page.waitForURL(new RegExp(`/c/${chId(2)}$`), { timeout: 5_000 });
      await page.mouse.move(900, 450);

      // ── A. 쉴 때의 기하 ──────────────────────────────────────────────────────
      await attempt(engine, scheme, "A.geometry", async () => {
        const ch = await geometry(page, chId(4));
        const peer = await geometry(page, dmId(5));
        check(engine, scheme, "A1 채널·DM 행 높이가 같다", ch.height === peer.height, { channel: ch.height, dm: peer.height });
        check(engine, scheme, "A2 채널·DM 이름 시작 위치가 같다(±0.5px)", ch.labelLeft !== null && peer.labelLeft !== null && Math.abs(ch.labelLeft - peer.labelLeft) <= 0.5, { channel: ch.labelLeft, dm: peer.labelLeft });
        check(engine, scheme, "A3 채널 글리프와 DM 아바타의 중심이 같은 축이다(±0.5px)", ch.iconCenter !== null && peer.iconCenter !== null && Math.abs(ch.iconCenter - peer.iconCenter) <= 0.5, { channel: ch.iconCenter, dm: peer.iconCenter });
        await shot("rest");
      });

      // ── B. 호버 ─────────────────────────────────────────────────────────────
      await attempt(engine, scheme, "B.hover", async () => {
        await rowOf(page, chId(4)).hover();
        await page.waitForTimeout(200);
        const chHover = await geometry(page, chId(4));
        check(engine, scheme, "B1 채널 행 호버에는 X가 서지 않는다", (await page.getByTestId("dm-close").count()) === 0, null);
        await shot("hover-channel");
        await rowOf(page, dmId(5)).hover();
        const close = page.getByTestId("dm-close");
        await close.waitFor({ timeout: 2_000 });
        check(engine, scheme, "B2 DM 행 호버에 X가 선다", (await close.count()) === 1, null);
        const label = (await close.getAttribute("aria-label")) ?? "";
        check(engine, scheme, "B3 X의 접근 가능한 이름에 「사이드바에서 닫기」", label.includes("사이드바에서 닫기"), label);
        const dmHover = await geometry(page, dmId(5));
        check(engine, scheme, "B4 호버 배경이 채널·DM에서 같다", chHover.bg === dmHover.bg, { channel: chHover.bg, dm: dmHover.bg });
        const quiet = await overlapOf(page, dmId(5));
        check(engine, scheme, "B5 X가 글자와 겹치지 않는다(안 읽음 없는 DM)", quiet.hits.length === 0, quiet.hits);
        check(engine, scheme, "B6 X가 행 안쪽에 있고 24px 이다", quiet.insideRow && quiet.size[0] === 24 && quiet.size[1] === 24, quiet.size);
        await shot("hover-dm");
        // 안 읽음 알약이 있는 DM: 이 시험이 빈손이 아니도록 쉴 때 알약이 실제로 보이는지부터 잰다.
        await page.mouse.move(900, 450);
        await page.waitForTimeout(100);
        const restPill = await rowOf(page, dmId(1)).locator('[data-testid="unread-count"]').boundingBox();
        check(engine, scheme, "B5a 쉴 때 안 읽음 알약이 보인다(아래 B5b가 빈손이 아니다)", restPill !== null && restPill.width > 0, restPill);
        await rowOf(page, dmId(1)).hover();
        await page.getByTestId("dm-close").waitFor({ timeout: 2_000 });
        const pilled = await overlapOf(page, dmId(1));
        check(engine, scheme, "B5b 안 읽음 알약이 있는 DM: X가 서면 알약이 내려가고 겹치지 않는다", pilled.hits.length === 0, pilled.hits);
        check(engine, scheme, "B5c X가 선 동안 알약은 화면에 없다", (await rowOf(page, dmId(1)).locator('[data-testid="unread-count"]').boundingBox()) === null, null);
        await page.mouse.move(900, 450);
        await page.waitForTimeout(100);
        check(engine, scheme, "B8 호버를 떼면 알약이 돌아오고 X가 사라진다",
          (await rowOf(page, dmId(1)).locator('[data-testid="unread-count"]').boundingBox()) !== null && (await page.getByTestId("dm-close").count()) === 0, null);
        // 에이전트 DM: 쉴 때는 생존 라벨(「꺼짐」)이 보이고, X가 서면 겹치지 않는다.
        await rowOf(page, dmId(4)).locator('[data-testid="agent-liveness"]').waitFor({ timeout: 5_000 }).catch(() => undefined);
        const restLabel = await rowOf(page, dmId(4)).locator('[data-testid="agent-liveness"]').boundingBox();
        check(engine, scheme, "B7a 쉴 때 에이전트 DM에 생존 라벨이 보인다(아래 B7이 빈손이 아니다)", restLabel !== null && restLabel.width > 0, restLabel);
        await rowOf(page, dmId(4)).hover();
        await page.getByTestId("dm-close").waitFor({ timeout: 2_000 });
        const agentOverlap = await overlapOf(page, dmId(4));
        check(engine, scheme, "B7 에이전트 DM 호버에서도 X가 글자와 겹치지 않는다", agentOverlap.hits.length === 0, agentOverlap.hits);
        await shot("hover-dm-agent");
        // 긴 이름: X가 서면 이름이 X 왼쪽(4px 간격)에서 잘린다. 여백이 모자라면 이름이 X 밑으로 들어간다.
        await rowOf(page, dmId(3)).hover();
        await page.getByTestId("dm-close").waitFor({ timeout: 2_000 });
        const longName = await page.evaluate((id) => {
          const a = document.querySelector(`[data-testid="channel-item"][data-channel-id="${id}"]`);
          const wrapper = a.querySelector(":scope > span:nth-of-type(2)").getBoundingClientRect();
          const x = document.querySelector('[data-testid="dm-close"]').getBoundingClientRect();
          const text = a.querySelector(":scope > span:nth-of-type(2) > span:first-child");
          return { wrapperRight: Math.round(wrapper.right * 10) / 10, xLeft: Math.round(x.left * 10) / 10, truncated: text.scrollWidth > text.clientWidth };
        }, dmId(3));
        check(engine, scheme, "B5d 긴 이름은 X 왼쪽 3px 안쪽에서 잘린다(이름이 X 밑으로 들어가지 않는다)", longName.truncated && longName.wrapperRight <= longName.xLeft - 3, longName);
        await shot("hover-dm-long-name");
        await page.mouse.move(900, 450);
      });

      // ── C. 우클릭(포인터) ────────────────────────────────────────────────────
      for (const [what, id] of [["채널(안 읽음 없음)", chId(4)], ["현재 보는 채널", chId(2)], ["DM", dmId(1)]]) {
        await attempt(engine, scheme, `C.${what}`, async () => {
          await rowOf(page, id).click({ button: "right" });
          await page.getByTestId("channel-row-menu").waitFor({ timeout: 5_000 });
          await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-testid="channel-row-menu"]')).opacity === "1", null, { timeout: 5_000 });
          await page.waitForTimeout(150);
          const o = await page.evaluate(OUTLINE);
          check(engine, scheme, `C1 ${what}: 우클릭 모달리티는 pointer`, o.modality === "pointer", o.modality);
          check(engine, scheme, `C2 ${what}: 열린 행(trigger)에 테두리가 없다`, o.triggerFound && o.trigger && !o.trigger.drawn, o.trigger);
          check(engine, scheme, `C3 ${what}: 캐럿 요소에도 포커스 링이 없다`, !o.active || !o.active.drawn, { tag: o.activeTag, ring: o.active });
          if (id === chId(4)) await shot("menu-channel", { x: 0, y: 0, width: 760, height: 900 });
          if (id === chId(2)) await shot("menu-channel-selected", { x: 0, y: 0, width: 760, height: 900 });
          if (id === dmId(1)) await shot("menu-dm", { x: 0, y: 0, width: 760, height: 900 });
          if (full && id === chId(4)) {
            const texts = await menuTexts(page);
            check(engine, scheme, "E1 채널 메뉴 항목과 순서", JSON.stringify(texts) === JSON.stringify(["복사", "이름 복사하기", "링크 복사하기", "ID 복사하기", "---", "섹션으로 이동", "채널 섹션으로", "출시 준비", "---", "읽지 않음으로 표시", "알림 끄기", "별표 붙이기", "---", "채널 나가기"]), texts);
          }
          if (full && id === dmId(1)) {
            const texts = await menuTexts(page);
            check(engine, scheme, "E2 DM 메뉴 항목과 순서", JSON.stringify(texts) === JSON.stringify(["복사", "이름 복사하기", "링크 복사하기", "ID 복사하기", "---", "읽음 처리하기", "알림 끄기", "---", "사이드바에서 닫기"]), texts);
          }
          await closeMenu(page);
          // 메뉴를 닫은 뒤(포인터 모달리티): 캐럿이 어디로 돌아갔든 링이 서지 않는다.
          await page.waitForTimeout(200);
          const after = await page.evaluate(OUTLINE);
          check(engine, scheme, `C4 ${what}: 메뉴를 닫은 뒤에도 링이 없다`, after.modality === "pointer" && (!after.active || !after.active.drawn), { tag: after.activeTag, ring: after.active, modality: after.modality });
        });
      }

      // ── D. 키보드: 링은 남고, 키보드로 연 메뉴는 열림 표식이 남는다 ──────────────
      await attempt(engine, scheme, "D.keyboard", async () => {
        await rowOf(page, chId(4)).hover();
        await rowOf(page, chId(4)).evaluate((el) => el.focus());
        await page.keyboard.press("ArrowDown"); // 로빙: 다음 행으로(스탬프 keyboard)
        await page.keyboard.press("ArrowUp");
        await page.mouse.move(900, 450);
        await page.waitForTimeout(150);
        const ring = await page.evaluate(OUTLINE);
        check(engine, scheme, "D1 키보드 로빙으로 닿은 행에는 포커스 링이 선다", ring.modality === "keyboard" && ring.active?.drawn === true, ring);
        await page.keyboard.press("Shift+F10");
        await page.getByTestId("channel-row-menu").waitFor({ timeout: 5_000 });
        await page.waitForTimeout(250);
        const open = await page.evaluate(OUTLINE);
        check(engine, scheme, "D2 키보드로 연 메뉴: 모달리티는 keyboard로 남는다", open.modality === "keyboard", open.modality);
        check(engine, scheme, "D3 키보드로 연 메뉴: 열린 행 표식(outline)이 남는다", open.trigger?.drawn === true, open.trigger);
        await closeMenu(page);
      });

      // ── G. 읽지 않음으로 표시(Chromium만) ──────────────────────────────────────
      if (full && scheme === "light") {
        await attempt(engine, scheme, "G.mark-unread", async () => {
          await rowOf(page, chId(4)).click({ button: "right" });
          await page.getByTestId("channel-row-menu").waitFor({ timeout: 5_000 });
          await page.getByTestId("channel-row-mark-unread").click();
          await page.getByTestId("channel-row-menu").waitFor({ state: "detached", timeout: 5_000 });
          await page.waitForFunction((id) => document.querySelector(`[data-testid="channel-item"][data-channel-id="${id}"] [data-testid="unread-count"]`) !== null, chId(4), { timeout: 5_000 });
          const put = state.puts.find((p) => p.channel === chId(4));
          check(engine, scheme, "G1 PUT 몸통: last_read_seq=기존, mark_unread_before_seq=최신, read_intent 없음",
            put && put.body.last_read_seq === 12 && put.body.mark_unread_before_seq === 12 && put.body.read_intent === undefined, put?.body);
          check(engine, scheme, "G2 표시 뒤 행에 안 읽음 알약", (await rowOf(page, chId(4)).locator('[data-testid="unread-count"]').count()) === 1, null);
        });
      }

      // ── J. X 위의 우클릭도 행 메뉴를 연다(Chromium만) ─────────────────────────
      if (full && scheme === "light") {
        await attempt(engine, scheme, "J.right-click-on-x", async () => {
          await rowOf(page, dmId(2)).hover();
          await page.getByTestId("dm-close").waitFor({ timeout: 2_000 });
          await page.getByTestId("dm-close").click({ button: "right" });
          await page.getByTestId("channel-row-menu").waitFor({ timeout: 5_000 });
          const texts = await menuTexts(page);
          check(engine, scheme, "J1 X 위의 우클릭이 그 DM의 행 메뉴를 연다", texts.includes("사이드바에서 닫기"), texts);
          check(engine, scheme, "J2 서버 쓰기 없이 열린다(X를 눌러 닫은 것이 아니다)", (await rowOf(page, dmId(2)).count()) === 1, null);
          await closeMenu(page);
        });
      }

      // ── H. 키보드로 닫기: Tab/화살표 → Shift+F10 → 「사이드바에서 닫기」 → 캐럿은 이웃 행 ─
      if (full && scheme === "light") {
        await attempt(engine, scheme, "H.keyboard-close", async () => {
          await rowOf(page, dmId(3)).evaluate((el) => el.focus());
          await page.keyboard.press("ArrowDown"); // 로빙: 다음 DM 행(스탬프 keyboard)
          await page.keyboard.press("ArrowUp");
          await page.keyboard.press("Shift+F10");
          await page.getByTestId("channel-row-menu").waitFor({ timeout: 5_000 });
          await page.waitForTimeout(200);
          const visited = [];
          for (let step = 0; step < 10; step += 1) {
            const at = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
            visited.push(at);
            if (at === "channel-row-close-dm") break;
            await page.keyboard.press("ArrowDown");
            await page.waitForTimeout(60);
          }
          const atClose = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
          check(engine, scheme, "H1 키보드로 「사이드바에서 닫기」 항목까지 걸어 닿는다", atClose === "channel-row-close-dm", { atClose, visited });
          await page.keyboard.press("Enter");
          await page.waitForFunction((id) => document.querySelector(`[data-channel-id="${id}"]`) === null, dmId(3), { timeout: 5_000 });
          await page.waitForTimeout(250);
          const caret = await page.evaluate(() => {
            const el = document.activeElement;
            const s = el ? getComputedStyle(el) : null;
            return {
              id: el?.getAttribute?.("data-channel-id") ?? null,
              testid: el?.getAttribute?.("data-testid") ?? null,
              ringed: Boolean(s && s.outlineStyle !== "none" && Number.parseFloat(s.outlineWidth) > 0),
              modality: document.documentElement.getAttribute("data-focus-modality"),
            };
          });
          check(engine, scheme, "H2 닫은 뒤 캐럿은 이웃 행(다음 DM)에 있다 - body 로 떨어지지 않는다", caret.testid === "channel-item" && caret.id === dmId(4), caret);
          check(engine, scheme, "H3 키보드로 닫았으니 이웃 행에는 포커스 링이 선다", caret.modality === "keyboard" && caret.ringed, caret);
          // 되돌려 둔다(다음 단계가 이 DM을 쓴다): 원장에서 지우고 새로고침 없이 다시 보이게 하려면 새 메시지로.
          state.read[dmId(3)][1] += 1;
        });
      }

      // ── I. 보고 있는 DM을 X로 닫으면 `/` 로 착지한다(Chromium만) ─────────────────
      if (full && scheme === "light") {
        await attempt(engine, scheme, "I.close-open-dm", async () => {
          await rowOf(page, dmId(2)).click();
          await page.waitForURL(new RegExp(`/c/${dmId(2)}$`), { timeout: 5_000 });
          await rowOf(page, dmId(2)).hover();
          await page.getByTestId("dm-close").click();
          await page.waitForFunction((id) => document.querySelector(`[data-channel-id="${id}"]`) === null, dmId(2), { timeout: 5_000 });
          await page.waitForTimeout(200);
          check(engine, scheme, "I1 보고 있던 DM을 닫으면 그 주소에 머물지 않는다", !page.url().includes(dmId(2)), page.url());
          check(engine, scheme, "I2 닫은 그 DM은 사이드바에 다시 나타나지 않는다(중간 렌더의 재오픈 경합 없음)", (await rowOf(page, dmId(2)).count()) === 0, null);
        });
      }

      // ── F. 닫기(Chromium만) ──────────────────────────────────────────────────
      if (full && scheme === "light") {
        await attempt(engine, scheme, "F.close", async () => {
          await rowOf(page, dmId(5)).hover();
          await page.getByTestId("dm-close").click();
          await page.waitForFunction((id) => document.querySelector(`[data-channel-id="${id}"]`) === null, dmId(5), { timeout: 5_000 });
          check(engine, scheme, "F1 X를 누르면 DM 행이 사라진다", (await rowOf(page, dmId(5)).count()) === 0, null);
          const stored = await page.evaluate((k) => localStorage.getItem(k), CLOSED_KEY);
          const parsed = stored ? JSON.parse(stored) : null;
          check(engine, scheme, "F2 닫은 DM이 기기 로컬 원장에 닫을 때의 최신 seq와 함께 남는다", parsed?.[workspaceId]?.[dmId(5)] === 3, parsed);
          const writesAfterClose = state.writes.filter((w) => !/\/channels\/[^/]+\/read-state$/.test(w));
          check(engine, scheme, "F3 대화 삭제가 아니다(닫기가 부른 서버 쓰기 0건: 멤버십·읽음·선호 어느 것도)", writesAfterClose.length === 0 && state.puts.every((p) => p.channel !== dmId(5)), { writes: state.writes, puts: state.puts.map((p) => p.channel) });
          await shot("after-close");
          // 새로고침해도 숨은 채.
          await page.reload({ waitUntil: "domcontentloaded" });
          if ((await page.getByTestId("login-email").count()) > 0) await login(page);
          await page.getByTestId("dm-avatar").first().waitFor({ timeout: 20_000 });
          check(engine, scheme, "F4 새로고침 뒤에도 닫은 DM은 숨어 있다", (await rowOf(page, dmId(5)).count()) === 0, null);
          // 새 메시지가 오면(latest_seq 증가) 다시 나타난다.
          state.read[dmId(5)][1] = 4;
          await page.reload({ waitUntil: "domcontentloaded" });
          if ((await page.getByTestId("login-email").count()) > 0) await login(page);
          await page.getByTestId("dm-avatar").first().waitFor({ timeout: 20_000 });
          await rowOf(page, dmId(5)).waitFor({ timeout: 5_000 });
          check(engine, scheme, "F5 새 메시지가 오면 닫은 DM이 다시 나타난다", (await rowOf(page, dmId(5)).count()) === 1, null);
          await shot("after-reappear");
        });
      }
    } finally {
      await context.close();
      await browser.close();
    }
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  try {
    if (ENGINES.includes("chromium")) await runEngine(chromium, "chromium", preview.origin);
    if (ENGINES.includes("webkit")) await runEngine(webkit, "webkit", preview.origin);
  } finally {
    await preview.stop?.();
  }
  const bad = results.filter((r) => !r.ok);
  writeFileSync(resolve(OUT_DIR, `${PREFIX}-results.json`), JSON.stringify(results, null, 1));
  console.log(bad.length === 0 ? `ROW-3963 PASS (${results.length} checks)` : `ROW-3963 FAIL (${bad.length}/${results.length}): ${bad.map((r) => `${r.engine}/${r.scheme}/${r.name}`).join(" | ")}`);
  process.exit(bad.length === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
