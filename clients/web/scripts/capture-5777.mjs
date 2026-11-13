#!/usr/bin/env node
// =============================================================================
// #5777 레인: 채널 · DM 줄 메뉴와 채널 머리 ⋮ — 줄마다 아이콘, 머리글 대신 하위 메뉴(owner 2026-11-14, Buzz 대조).
//
//   npm run build && node scripts/capture-5777.mjs
//   DIST_DIR=<다른 dist> node scripts/capture-5777.mjs     # 고치기 전 번들(RED 가 정상)
//   OUT_DIR=<dir> PREFIX=c5777 SHOTS=0 node scripts/capture-5777.mjs
//
// 재는 것(번들 Chromium 헤드리스, 백엔드 없음: `/v1/**` 고정 응답, 인물은 전부 가상):
//   A. 아이콘 세로 줄: 열린 판마다 모든 줄이 아이콘을 들고, 아이콘 왼쪽 끝 · 글자 왼쪽 끝의 흩어짐(최대 − 최소)이 0.5px 이하,
//      아이콘 세로 가운데가 줄 세로 가운데와 0.5px 안. 알림(종) 줄도 같은 줄에 선다(owner 「알림 아이콘 정렬 잘 맞춰줘」).
//   B. 머리글 줄 없음: 위 판에 무리 제목(이름 붙은 group · 제목 줄)이 없고 「복사 ›」·「섹션으로 이동 ›」가 하위 메뉴(aria-haspopup)다.
//   C. 하위 판: 첫 줄 윗변이 여는 줄 윗변과 같은 높이(±1), 창 안에 머문다. 줄 높이는 위 판과 같다.
//   D. 키보드: Shift+F10 → → 가 「복사 ›」를 열고 첫 줄에 캐럿, ← 가 닫고 여는 줄로, Esc 가 메뉴를 닫고 행으로.
//   E. 가장자리: 720×480 창에서 낮은 행의 섹션 하위 판(80자 이름)이 창 안, 오른쪽 끝에서 연 메뉴의 하위 판은 왼쪽으로 뒤집힘.
//   F. 200%(720×450 · 배율 2): 같은 판이 창 안이고 A 가 그대로.
//   G. 헤더 ⋮: 같은 표에서 아이콘 + 글자로 서고 A 가 그대로(헤더에는 하위 메뉴가 없다 - 열쇠 표가 복사 · 섹션을 주지 않는다).
// =============================================================================
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/5777");
const PREFIX = process.env.PREFIX || "c5777";
const PORT = Number(process.env.CAPTURE_PORT || 5777);
const SHOTS = process.env.SHOTS !== "0";
const DIST_DIR = process.env.DIST_DIR || "";

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const chId = (n) => `00000000-0000-7000-8000-0000000002${String(n).padStart(2, "0")}`;
const dmId = (n) => `00000000-0000-7000-8000-0000000003${String(n).padStart(2, "0")}`;
const P = (n) => `00000000-0000-7000-8000-0000000001${n}`;
const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const channelNames = ["general", "design", "release-notes", "agent-lab", "launch", "qa", "infra", "support", "growth", "random"];
const channels = channelNames.map((name, i) => ({
  id: chId(i + 1), workspaceId, kind: "public", name, muted: i === 1,
  ...(i === 0 ? { topic: "팀 전체 공지와 주간 계획" } : {}),
}));
const person = (n, displayName, handle, extra = {}) => ({
  id: P(n), workspaceId, kind: "human", status: "active", displayName, handle, channelCount: 1, channelIds: [], capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...extra,
});
const roster = [
  person("01", "김도현", "dohyeon", { role: "owner", presenceStatus: "auto" }),
  person("11", "이서연", "seoyeon"),
  person("12", "박지호", "jiho"),
  person("14", "정리봇", "tidy", { kind: "agent", hostOnline: true, ownerHumanId: P("01") }),
];
const dm = (n, other) => ({ id: dmId(n), workspaceId, kind: "dm", muted: false, memberIds: [P("01"), other] });
const dms = [dm(1, P("11")), dm(2, P("12"))];
// [마지막으로 읽은 seq, 최신 seq]. agent-lab 과 이서연 DM 에만 안 읽음이 있다(「읽음 처리하기」가 선다), 나머지는 다 읽음
// (「읽지 않음으로 표시하기」). general 은 로그인 뒤 처음 열리는 채널이라 읽음이 되므로 안 읽음을 두지 않는다.
const READ = Object.fromEntries([
  ...channels.map((c, i) => [c.id, i === 3 ? [40, 47] : [12, 12]]),
  [dmId(1), [3, 5]], [dmId(2), [4, 4]],
]);
const LONG_SECTION = "긴급대응".repeat(20);
const PREFS = {
  version: 1,
  sections: [
    { id: "sec-1", name: "출시 준비", order: 0, channelIds: [chId(5)] },
    { id: "sec-2", name: LONG_SECTION, order: 1, channelIds: [] },
  ],
  starredChannelIds: [chId(3)],
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

const wireRead = (id) => ({
  channel_id: id, last_read_seq: READ[id][0], latest_seq: READ[id][1],
  unread_count: Math.max(0, READ[id][1] - READ[id][0]), mention_count: 0, marked_unread_before_seq: null,
});

async function installMocks(context) {
  const auth = {
    accessToken: "capture-only-not-a-credential", refreshToken: "capture-only-not-a-credential",
    member: { id: memberId, workspaceId, kind: "human", displayName: "김도현", handle: "dohyeon" },
    realtimeWebSocketUrl: "ws://menu-5777-capture.invalid/connection/websocket",
  };
  await context.route("**/v1/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId });
    if (path.endsWith("/read-state")) return json(route, { read_states: Object.keys(READ).map(wireRead) });
    if (path.endsWith("/members/me/sidebar-prefs")) return json(route, { prefs: PREFS });
    if (/\/agents\/[^/]+\/liveness$/.test(path)) return json(route, { agentMemberId: P("14"), state: "inactive" });
    if (path.endsWith("/channels")) return json(route, { channels: [...channels, ...dms] });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith(`/workspaces/${workspaceId}`)) return json(route, { workspace: { id: workspaceId, name: "새벽거리" } });
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
          if (c.connect) return { id: c.id, connect: { client: "menu", version: "6" } };
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

async function open(browser, origin, { scheme = "light", viewport = { width: 1440, height: 900 }, deviceScaleFactor = 1 } = {}) {
  const context = await browser.newContext({ viewport, deviceScaleFactor, colorScheme: scheme, serviceWorkers: "block", reducedMotion: "reduce" });
  await installMocks(context);
  await context.addInitScript((server) => { try { if (!localStorage.getItem("momo.web.server.v1")) localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ } }, origin);
  const page = await context.newPage();
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-item").first().waitFor({ timeout: 30_000 });
  await page.getByTestId("sidebar-section-sec-1").waitFor({ timeout: 30_000 });
  return { context, page };
}

const rowOf = (page, id) => page.locator(`[data-testid="channel-item"][data-channel-id="${id}"]`);
const ROW_MENU = '[data-testid="channel-row-menu"]';

/**
 * 판 하나의 줄 기하. 아이콘(`svg[data-menu-icon]`)의 왼쪽 끝 · 세로 가운데, 글자(줄의 첫 글자 노드 또는 첫 span)의 왼쪽 끝,
 * 줄의 세로 가운데 · 높이. 값은 판 왼쪽에서 잰 px(0.01 반올림).
 */
async function panelGeometry(page, selector) {
  return page.evaluate((sel) => {
    const panel = document.querySelector(sel);
    if (!panel) return null;
    const p = panel.getBoundingClientRect();
    const round = (v) => (v === null || v === undefined ? null : Math.round(v * 100) / 100);
    const rows = Array.from(panel.querySelectorAll('[role="menuitem"], [role="menuitemradio"]'));
    return {
      panel: { left: round(p.left), top: round(p.top), right: round(p.right), bottom: round(p.bottom), width: round(p.width), height: round(p.height) },
      view: { width: window.innerWidth, height: window.innerHeight },
      side: panel.getAttribute("data-side"),
      labelledBy: panel.getAttribute("aria-labelledby") ? document.getElementById(panel.getAttribute("aria-labelledby"))?.textContent?.trim() ?? null : null,
      titled: panel.querySelectorAll('[role="group"][aria-labelledby]').length,
      rows: rows.map((row) => {
        const r = row.getBoundingClientRect();
        const icon = row.querySelector(":scope > svg[data-menu-icon]");
        const ir = icon?.getBoundingClientRect();
        let labelLeft = null;
        const textNode = Array.from(row.childNodes).find((n) => n.nodeType === 3 && n.textContent.trim() !== "");
        const span = row.querySelector(":scope > span");
        if (textNode) {
          const range = document.createRange();
          range.selectNodeContents(textNode);
          labelLeft = range.getBoundingClientRect().left;
        } else if (span) {
          labelLeft = span.getBoundingClientRect().left;
        }
        return {
          testid: row.getAttribute("data-testid"),
          text: (row.textContent ?? "").trim(),
          role: row.getAttribute("role"),
          haspopup: row.getAttribute("aria-haspopup"),
          icon: icon?.getAttribute("data-menu-icon") ?? null,
          iconLeft: ir ? round(ir.left - p.left) : null,
          iconSize: ir ? round(ir.width) : null,
          iconDy: ir ? round(ir.top + ir.height / 2 - (r.top + r.height / 2)) : null,
          labelLeft: labelLeft === null ? null : round(labelLeft - p.left),
          top: round(r.top),
          height: round(r.height),
          color: getComputedStyle(row).color,
          iconColor: icon ? getComputedStyle(icon).color : null,
        };
      }),
    };
  }, selector);
}

const spread = (values) => {
  const v = values.filter((x) => x !== null && x !== undefined);
  return v.length === 0 ? null : Math.round((Math.max(...v) - Math.min(...v)) * 100) / 100;
};

/** A 묶음: 아이콘이 있는 판이면 모든 줄이 아이콘을 들고 한 세로 줄에 선다. 숫자를 돌려준다. */
function checkAlignment(scene, label, geo, { expectIcons = true } = {}) {
  const rows = geo.rows;
  const iconless = rows.filter((r) => r.icon === null).map((r) => r.text);
  const nums = {
    rows: rows.length,
    iconLeftSpread: spread(rows.map((r) => r.iconLeft)),
    labelLeftSpread: spread(rows.map((r) => r.labelLeft)),
    iconDyMax: rows.length ? Math.max(...rows.map((r) => Math.abs(r.iconDy ?? 0))) : null,
    iconSizes: [...new Set(rows.map((r) => r.iconSize))],
    heights: [...new Set(rows.map((r) => r.height))],
    iconLeft: rows[0]?.iconLeft ?? null,
    labelLeft: rows[0]?.labelLeft ?? null,
  };
  if (expectIcons) {
    check(scene, `${label}: 모든 줄이 아이콘을 든다`, rows.length > 0 && iconless.length === 0, { iconless, rows: rows.length });
    check(scene, `${label}: 아이콘 왼쪽 끝 흩어짐 ≤ 0.5px · 세로 가운데 차 ≤ 0.5px`, nums.iconLeftSpread !== null && nums.iconLeftSpread <= 0.5 && nums.iconDyMax <= 0.5, nums);
  }
  check(scene, `${label}: 글자 왼쪽 끝 흩어짐 ≤ 0.5px`, nums.labelLeftSpread !== null && nums.labelLeftSpread <= 0.5, nums);
  return nums;
}

function inside(geo) {
  const { panel, view } = geo;
  return panel.left >= 0 && panel.top >= 0 && panel.right <= view.width && panel.bottom <= view.height;
}

async function shot(page, name) {
  if (!SHOTS) return;
  await page.waitForTimeout(80);
  await page.screenshot({ path: resolve(OUT_DIR, `${PREFIX}-${name}.png`) });
}

async function openRowMenu(page, id, opts = {}) {
  await rowOf(page, id).click({ button: "right", ...opts });
  await page.locator(ROW_MENU).waitFor({ state: "visible", timeout: 5_000 });
}
/**
 * 하위 메뉴를 포인터로 연다. 손은 여는 줄 위에서 계속 움직이므로 그렇게 흉내 낸다: Radix 는 바로 앞 하위 판 쪽으로 가는
 * 길(포인터 유예 300ms) 위의 움직임을 삼키고, 여는 줄 위의 다음 움직임에서 100ms 뒤에 연다.
 */
async function hoverOpen(page, triggerId, panelId) {
  const box = await page.getByTestId(triggerId).boundingBox();
  const t0 = Date.now();
  for (let step = 0; step < 12; step += 1) {
    await page.mouse.move(box.x + 24 + (step % 3) * 4, box.y + box.height / 2);
    if (await page.getByTestId(panelId).isVisible()) break;
    await page.waitForTimeout(120);
  }
  await page.getByTestId(panelId).waitFor({ state: "visible", timeout: 3_000 });
  return Date.now() - t0;
}

async function closeMenus(page) {
  await page.keyboard.press("Escape");
  await page.locator(ROW_MENU).waitFor({ state: "detached", timeout: 5_000 }).catch(() => {});
}

// ── 1440 × 밝음 · 어두움: 채널 줄 · DM 줄 · 머리 ⋮ ───────────────────────────────
async function sceneWide(browser, origin, scheme) {
  const scene = `wide-${scheme}`;
  const { context, page } = await open(browser, origin, { scheme });
  try {
    await attempt(scene, async () => {
      // 채널 줄(agent-lab): 안 읽음이 있어 「읽음 처리하기」, 별표 손, 섹션 둘.
      await openRowMenu(page, chId(4));
      const root = await panelGeometry(page, ROW_MENU);
      const texts = root.rows.map((r) => r.text);
      check(scene, "B 채널 줄 위 판: 「복사 ›」·「섹션으로 이동 ›」 │ 읽음 · 알림 · 별표 │ 나가기, 머리글 줄 없음",
        JSON.stringify(texts) === JSON.stringify(["복사", "섹션으로 이동", "읽음 처리하기", "알림 켜짐", "별표 붙이기", "채널 나가기"]) && root.titled === 0
          && root.rows[0].haspopup === "menu" && root.rows[1].haspopup === "menu", { texts, titled: root.titled });
      const separators = await page.locator(`${ROW_MENU} > [role="separator"]`).count();
      check(scene, "B 구분선 둘(여는 줄 둘은 붙고, 상태 무리 앞 · 나가기 앞)", separators === 2, separators);
      const nums = checkAlignment(scene, "A 채널 줄 위 판", root);
      const bell = root.rows.find((r) => r.icon === "bell");
      check(scene, "A 알림(종) 아이콘이 다른 줄 아이콘과 같은 x · 같은 세로 가운데", bell && bell.iconLeft === nums.iconLeft && Math.abs(bell.iconDy) <= 0.5, bell);
      const leave = root.rows.find((r) => r.icon === "leave");
      check(scene, "A 나가기 줄은 아이콘도 글자와 같은 위험색", leave && leave.iconColor === leave.color, { color: leave?.color, icon: leave?.iconColor });
      await shot(page, `channel-row-menu-${scheme}`);

      // 「복사 ›」 하위 판: 포인터를 올려 연다(Radix 100ms 지연). 여는 시간은 참고값(부하).
      const hoverOpenMs = await hoverOpen(page, "channel-row-copy-group", "channel-row-copy-group-menu");
      const copy = await panelGeometry(page, '[data-testid="channel-row-copy-group-menu"]');
      const trigger = root.rows[0];
      check(scene, "C 복사 하위 판: 이름 · 링크 · ID, 판 이름은 「복사」", JSON.stringify(copy.rows.map((r) => r.text)) === JSON.stringify(["이름 복사하기", "링크 복사하기", "ID 복사하기"]) && copy.labelledBy === "복사", { texts: copy.rows.map((r) => r.text), labelledBy: copy.labelledBy });
      checkAlignment(scene, "A 복사 하위 판", copy);
      check(scene, "C 하위 판 첫 줄 윗변 = 여는 줄 윗변(±1), 줄 높이 같음, 창 안", Math.abs(copy.rows[0].top - trigger.top) <= 1 && copy.rows[0].height === trigger.height && inside(copy),
        { subTop: copy.rows[0].top, triggerTop: trigger.top, subH: copy.rows[0].height, rowH: trigger.height, panel: copy.panel, side: copy.side });
      check(scene, "C 포인터로 연 시간(참고값, 부하 높음)", hoverOpenMs < 1500, { hoverOpenMs });
      await shot(page, `channel-row-copy-sub-${scheme}`);

      // 「섹션으로 이동 ›」 하위 판(80자 이름): 판이 창 안이고 글자 시작이 한 줄.
      await hoverOpen(page, "channel-row-move-to-section", "channel-row-move-to-section-menu");
      const move = await panelGeometry(page, '[data-testid="channel-row-move-to-section-menu"]');
      check(scene, "C 섹션 하위 판: 라디오 셋(채널 섹션으로 · 출시 준비 · 80자), 창 안", move.rows.length === 3 && move.rows.every((r) => r.role === "menuitemradio") && inside(move), { panel: move.panel, view: move.view });
      checkAlignment(scene, "A 섹션 하위 판(아이콘 없는 판, 글자만)", move, { expectIcons: false });
      await shot(page, `channel-row-section-sub-${scheme}`);
      await closeMenus(page);

      // DM 줄(이서연): 「복사 ›」 │ 읽음 · 알림, 숨기기는 `canCloseDm` 손이 있을 때만(안 읽음이 있으면 없다).
      await openRowMenu(page, dmId(2));
      const dmRoot = await panelGeometry(page, ROW_MENU);
      check(scene, "B DM 줄 위 판: 「복사 ›」 │ 읽지 않음 · 알림 │ 목록에서 숨기기(또는 대화 닫기), 머리글 없음",
        dmRoot.rows[0].text === "복사" && dmRoot.rows[0].haspopup === "menu" && dmRoot.titled === 0 && !dmRoot.rows.some((r) => r.text === "채널 나가기"), dmRoot.rows.map((r) => r.text));
      checkAlignment(scene, "A DM 줄 위 판", dmRoot);
      await hoverOpen(page, "channel-row-copy-group", "channel-row-copy-group-menu");
      checkAlignment(scene, "A DM 복사 하위 판", await panelGeometry(page, '[data-testid="channel-row-copy-group-menu"]'));
      await shot(page, `dm-row-menu-copy-sub-${scheme}`);
      await closeMenus(page);

      // 머리 ⋮ (general 을 연다): 주제 · 알림 · 나가기, 아이콘 + 글자.
      await rowOf(page, chId(1)).click();
      await page.getByTestId("channel-title-menu").click();
      await page.getByTestId("channel-title-menu-content").waitFor({ state: "visible", timeout: 5_000 });
      const head = await panelGeometry(page, '[data-testid="channel-title-menu-content"]');
      check(scene, "G 머리 ⋮: 주제 보기 · 알림 · 나가기가 아이콘 + 글자, 하위 메뉴 없음", head.rows.length >= 3 && head.rows.every((r) => r.haspopup === null), head.rows.map((r) => `${r.icon}:${r.text}`));
      checkAlignment(scene, "A 머리 ⋮", head);
      await shot(page, `channel-header-menu-${scheme}`);
      await page.keyboard.press("Escape");
    });
  } finally {
    await context.close();
  }
}

// ── 키보드: Shift+F10 → → · ← · Esc ──────────────────────────────────────────────
async function sceneKeyboard(browser, origin) {
  const scene = "keyboard-light";
  const { context, page } = await open(browser, origin, { scheme: "light" });
  try {
    await attempt(scene, async () => {
      const link = rowOf(page, chId(1));
      await link.focus();
      await page.keyboard.press("Shift+F10");
      await page.locator(ROW_MENU).waitFor({ state: "visible" });
      const active = () => page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.tagName);
      await page.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "channel-row-copy-group", null, { timeout: 3_000 });
      check(scene, "D Shift+F10 의 첫 정거장은 「복사 ›」", (await active()) === "channel-row-copy-group", await active());
      await page.keyboard.press("ArrowRight");
      await page.getByTestId("channel-row-copy-group-menu").waitFor({ state: "visible", timeout: 3_000 });
      await page.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "channel-row-copy-name", null, { timeout: 3_000 }).catch(() => {});
      check(scene, "D → 가 하위 판을 열고 첫 줄(이름 복사하기)에 캐럿", (await active()) === "channel-row-copy-name", await active());
      const ring = await page.evaluate(() => {
        const el = document.activeElement;
        const s = el ? getComputedStyle(el) : null;
        return s ? { outline: s.outlineStyle, width: s.outlineWidth, bg: s.backgroundColor } : null;
      });
      check(scene, "D 하위 판의 캐럿 줄에 보이는 표식(배경 또는 포커스 링)", ring && (ring.outline !== "none" || ring.bg !== "rgba(0, 0, 0, 0)"), ring);
      await shot(page, "keyboard-copy-sub-light");
      await page.keyboard.press("ArrowLeft");
      await page.getByTestId("channel-row-copy-group-menu").waitFor({ state: "detached", timeout: 3_000 });
      check(scene, "D ← 가 하위 판을 닫고 「복사 ›」로 돌아온다", (await active()) === "channel-row-copy-group", await active());
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowRight");
      await page.getByTestId("channel-row-move-to-section-menu").waitFor({ state: "visible", timeout: 3_000 });
      await page.keyboard.press("Escape");
      await page.locator(ROW_MENU).waitFor({ state: "detached", timeout: 3_000 });
      await page.waitForTimeout(100);
      const back = await page.evaluate(() => document.activeElement?.getAttribute("data-channel-id"));
      check(scene, "D 하위 판의 Esc 는 메뉴를 통째로 닫고 캐럿을 그 행으로", back === "00000000-0000-7000-8000-000000000201", back);
    });
  } finally {
    await context.close();
  }
}

// ── 720×480: 낮은 행 · 오른쪽 끝에서 뒤집힘 ─────────────────────────────────────
async function sceneEdge(browser, origin, scheme) {
  const scene = `edge-720x480-${scheme}`;
  const { context, page } = await open(browser, origin, { scheme, viewport: { width: 720, height: 480 } });
  try {
    await attempt(scene, async () => {
      // 보이는 채널 줄 중 가장 아래 것.
      const ids = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="channel-item"][data-channel-id]'))
        .filter((a) => { const r = a.getBoundingClientRect(); return r.height > 0 && r.bottom <= window.innerHeight && r.top >= 0; })
        .map((a) => a.getAttribute("data-channel-id")));
      const low = ids.filter((id) => id.startsWith("00000000-0000-7000-8000-0000000002")).at(-1);
      await openRowMenu(page, low);
      const root = await panelGeometry(page, ROW_MENU);
      check(scene, "E 낮은 행의 위 판이 창 안", inside(root), { panel: root.panel, view: root.view, row: low });
      checkAlignment(scene, "A 720 위 판", root);
      await hoverOpen(page, "channel-row-move-to-section", "channel-row-move-to-section-menu");
      const move = await panelGeometry(page, '[data-testid="channel-row-move-to-section-menu"]');
      check(scene, "E 섹션 하위 판(80자 이름)이 720×480 창 안", inside(move), { panel: move.panel, view: move.view, side: move.side });
      await shot(page, `edge-low-row-section-sub-${scheme}`);
      await closeMenus(page);

      // 오른쪽 끝에서 연 메뉴: 키보드 소환과 같은 길로 행 위에 `contextmenu` 를 오른쪽 끝 좌표로 쏜다(Radix 는 그 좌표에 판을 세운다).
      await page.evaluate((id) => {
        const a = document.querySelector(`[data-testid="channel-item"][data-channel-id="${id}"]`);
        const r = a.getBoundingClientRect();
        a.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: window.innerWidth - 60, clientY: Math.round(r.top + r.height / 2) }));
      }, chId(1));
      await page.locator(ROW_MENU).waitFor({ state: "visible", timeout: 5_000 });
      await hoverOpen(page, "channel-row-copy-group", "channel-row-copy-group-menu");
      const edgeRoot = await panelGeometry(page, ROW_MENU);
      const flipped = await panelGeometry(page, '[data-testid="channel-row-copy-group-menu"]');
      check(scene, "E 오른쪽 끝: 위 판 · 하위 판 모두 창 안, 하위 판은 왼쪽으로 뒤집힘", inside(edgeRoot) && inside(flipped) && flipped.side === "left" && flipped.panel.right <= edgeRoot.panel.left + 1,
        { root: edgeRoot.panel, sub: flipped.panel, side: flipped.side, view: flipped.view });
      await shot(page, `edge-right-flip-${scheme}`);
      await closeMenus(page);
    });
  } finally {
    await context.close();
  }
}

// ── 200%: 1440×900 창을 200% 로 키운 것과 같은 CSS 창(720×450, 배율 2) ─────────────
async function sceneZoom(browser, origin) {
  const scene = "zoom-200-light";
  const { context, page } = await open(browser, origin, { scheme: "light", viewport: { width: 720, height: 450 }, deviceScaleFactor: 2 });
  try {
    await attempt(scene, async () => {
      await openRowMenu(page, chId(1));
      const root = await panelGeometry(page, ROW_MENU);
      check(scene, "F 200%: 위 판이 창 안", inside(root), { panel: root.panel, view: root.view });
      checkAlignment(scene, "A 200% 위 판", root);
      await hoverOpen(page, "channel-row-copy-group", "channel-row-copy-group-menu");
      const copy = await panelGeometry(page, '[data-testid="channel-row-copy-group-menu"]');
      check(scene, "F 200%: 복사 하위 판이 창 안", inside(copy), { panel: copy.panel, side: copy.side });
      checkAlignment(scene, "A 200% 복사 하위 판", copy);
      await shot(page, "zoom-200-copy-sub-light");
    });
  } finally {
    await context.close();
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT", ...(DIST_DIR ? { distDir: resolve(DIST_DIR) } : {}) });
  const browser = await chromium.launch();
  try {
    for (const scheme of ["light", "dark"]) await sceneWide(browser, preview.origin, scheme);
    await sceneKeyboard(browser, preview.origin);
    for (const scheme of ["light", "dark"]) await sceneEdge(browser, preview.origin, scheme);
    await sceneZoom(browser, preview.origin);
  } finally {
    await browser.close();
    await preview.stop?.();
  }
  const bad = results.filter((r) => !r.ok);
  writeFileSync(resolve(OUT_DIR, `${PREFIX}-results.json`), JSON.stringify(results, null, 1));
  console.log(bad.length === 0 ? `MENU-5777 PASS (${results.length} checks)` : `MENU-5777 FAIL (${bad.length}/${results.length}): ${bad.map((r) => `${r.scene}/${r.name}`).join(" | ")}`);
  process.exit(bad.length === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
