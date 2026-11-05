#!/usr/bin/env node
// =============================================================================
// #5328 레인: 데스크탑 다듬기 셋 중 둘 — 호버 툴바의 열림·닫힘, 링크 카드 ✕ (owner 데스크탑 검수 2026-11-05).
// (첨부 든 입력창 간격은 `capture-5200.mjs` 가 잰다: 같은 첨부 줄 부품을 본 입력창·스레드 입력창이 함께 쓴다.)
//
//   npm run build && node scripts/capture-5328.mjs
//   DIST_DIR=<옛 번들> LABEL=before node scripts/capture-5328.mjs     # 고치기 전 번들로 RED 를 다시 볼 때
//   OUT_DIR=<dir> node scripts/capture-5328.mjs                       # 캡처 저장 자리(기본 artifacts/5328, git 무시)
//   SHOTS=0 node scripts/capture-5328.mjs                             # 재기만(캡처 없음)
//   ENGINE=webkit node scripts/capture-5328.mjs                       # 같은 레인을 WebKit(WKWebView 의 엔진)으로
//
// 재는 것(번들 Chromium 헤드리스 · 1440 · 밝음):
//   툴바      ⋮ 메뉴를 열고 행동을 고르거나 바깥을 눌러 닫은 뒤, 포인터가 그 메시지를 떠났으면 그 행의 막대는 없다. 두 메시지에 막대가
//             동시에 남지 않는다. 막대 단추를 마우스로 눌러 초점이 남아도 포인터가 떠나면 막대는 내려간다. 키보드로 고르면 초점이 ⋮ 로
//             돌아와 막대가 남는다(키보드 사용자가 자리를 잃지 않는다).
//   링크 카드 ✕  입력칸 미리보기의 ✕ 가 호버가 되는 입력에서는 가만히 있을 때 안 보이고(opacity 0), 카드에 올리면 서고, 키보드 초점에서
//             서고, 테두리 없는 원이다. 손가락 입력(호버 없음)에서는 늘 보인다. 키보드로 닿고 이름이 있다.
//
// 백엔드는 없다: `/v1/**` 는 고정 응답이고 소켓은 구독만 받는다. 인물은 전부 가상이다(레포는 공개).
// 단언이 하나라도 실패하면 종료 코드 1(고치기 전 번들에서는 붉은 것이 정상: 그것이 「고치기 전 RED」다).
// =============================================================================
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/5328");
const PORT = Number(process.env.CAPTURE_PORT || 5628);
const DIST_DIR = process.env.DIST_DIR || "";
const LABEL = process.env.LABEL || "after";
const SHOTS = process.env.SHOTS !== "0";
const ENGINE = process.env.ENGINE === "webkit" ? "webkit" : "chromium";
const MIN = 60_000;

const workspaceId = "00000000-0000-7000-8000-000000000001";
const me = "00000000-0000-7000-8000-000000000101";
const peer = "00000000-0000-7000-8000-000000000103";
const peer2 = "00000000-0000-7000-8000-000000000104";
const GENERAL = "00000000-0000-7000-8000-000000000202";

const person = (id, displayName, handle, extra = {}) => ({
  id, workspaceId, kind: "human", status: "active", role: "member", displayName, handle, channelCount: 1,
  channelIds: [GENERAL], capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...extra,
});
const roster = [person(me, "박서연", "seoyeon", { role: "owner" }), person(peer, "이도현", "dohyun"), person(peer2, "최민수", "minsu")];
const channels = [{ id: GENERAL, workspaceId, kind: "public", name: "일반", topic: "팀 공지와 가벼운 이야기", muted: false }];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: me, workspaceId, kind: "human", displayName: "박서연", handle: "seoyeon" },
  realtimeWebSocketUrl: "ws://capture-5328.invalid/connection/websocket",
};

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const idOf = (id) => `00000000-0000-7000-8000-0000000b${id}`;
const LINK = "https://example.com/ops-guide";

async function installRoutes(context) {
  const now = Date.now();
  const row = (id, seq, author, body, ago) => ({
    id: idOf(id), channelId: GENERAL, seq, hlcTs: now - ago, hlcCount: 0,
    authorMemberId: author, type: "text", body, state: "sent", createdAtMs: now - ago,
  });
  // 위(0007)는 내 글, 아래(0008·0009)는 남의 글이다. 메뉴는 위 행 밑으로 펼쳐지므로 행동을 고른 뒤 포인터는 아래 행 위에 선다.
  const general = [
    row("0001", 1, peer, "내일 배포 전에 체크리스트를 한 번만 같이 봐 주세요. 롤백 계획과 알림 문구까지 확인하면 좋겠어요.", 90 * MIN),
    row("0002", 2, me, "확인했어요. 롤백 계획은 문서에 있어요.", 80 * MIN),
    row("0003", 3, peer2, "금요일 배포 공지 초안이에요. 이대로 올려도 될까요?", 70 * MIN),
    row("0004", 4, me, "네, 제목만 조금 짧게 바꾸면 좋겠어요.", 60 * MIN),
    row("0005", 5, peer, "알겠어요. 바꿔서 다시 올릴게요.", 50 * MIN),
    row("0006", 6, peer2, "시안 링크도 같이 남겨 둘게요. 라이트와 다크 둘 다 부탁해요.", 40 * MIN),
    row("0007", 7, me, "좋아요. 확인은 제가 할게요. 툴팁 문구도 같이 정리해 두면 더 좋겠어요.", 30 * MIN),
    row("0008", 8, peer, "체크리스트를 정리했어요. 빠진 항목이 있으면 알려 주세요.", 20 * MIN),
    row("0009", 9, peer2, "점심 먹고 한 번 더 맞춰 봐요. 그때 최종 확인을 같이 해요.", 10 * MIN),
    row("0010", 10, peer, "좋아요, 그때 봐요. 자료는 제가 미리 올려 둘게요.", 5 * MIN),
  ];
  await context.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId: me });
    }
    if (/\/inbox(\/|$)/.test(path)) return json(route, { items: [], nextCursor: null, unreadCount: 0, approvalsPending: 0 });
    if (path.endsWith("/agent-runs/progress")) return json(route, { runs: [] });
    if (path.endsWith("/hosted-agent-connections") && method === "GET") return json(route, { connections: [] });
    if (path.endsWith("/allowed-models")) return json(route, { allowedAgentModels: [] });
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/read-state") && method === "GET") {
      return json(route, { read_states: channels.map((c) => ({ channel_id: c.id, last_read_seq: 99, latest_seq: 99, unread_count: 0, mention_count: 0, marked_unread_before_seq: null })) });
    }
    if (path.endsWith("/approvals")) return json(route, { approvals: [] });
    if (path.endsWith("/agent-runs")) return json(route, { runs: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null, participants: [] });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: [] });
    if (path.endsWith("/work-sessions/shared")) return json(route, { sessions: [], nextCursor: null });
    if (path.endsWith("/work-sessions")) return json(route, { workSessions: [] });
    if (path.endsWith("/reminders")) return json(route, { reminders: [] });
    if (path.endsWith("/scheduled-messages")) return json(route, { scheduledMessages: [] });
    if (path.endsWith("/presence")) return json(route, { statuses: [] });
    if (path.endsWith("/webhooks")) return json(route, { installations: [] });
    if (path.endsWith("/event-subscriptions")) return json(route, { eventSubscriptions: [] });
    if (path.endsWith("/pins")) return json(route, { pins: [] });
    // 「고정」: 메뉴에서 누르면 메뉴가 닫히는 가장 단순한 행동이다(복사는 메뉴를 열어 둔다).
    const pin = /\/messages\/([^/]+)\/pin$/.exec(path);
    if (pin && method === "PUT") return json(route, { action: "pinned", messageId: pin[1], channelId: GENERAL, changed: true });
    // 입력칸 링크 미리보기(#5005): 보내기 전 주소 하나의 카드.
    if (path.endsWith("/unfurl-previews") && method === "POST") {
      return json(route, { id: "0199aaaa-0000-7000-8000-0000000000c1", url: LINK, status: "ok", title: "운영 가이드", description: "문제가 생겼을 때 확인할 순서입니다.", domain: "example.com" });
    }
    if (path.endsWith("/unfurl-settings")) return json(route, { enabled: true });
    if (path.endsWith(`/workspaces/${workspaceId}`)) {
      return json(route, { workspace: { id: workspaceId, name: "달무리 스튜디오", slug: "team", updatedAtMs: 1, roleLabels: {}, welcomeAgentMemberId: null, welcomePrompt: "", subscriptionAgentsEnabled: true } });
    }
    if (path.includes(`/channels/${GENERAL}/messages`) && method === "GET") return json(route, { messages: general });
    if (path.includes("/messages")) return json(route, { messages: [] });
    return json(route, {});
  });
}

/** 가짜 소켓 + 데스크탑 셸(가짜 `__TAURI_INTERNALS__`, 맥 플랫폼). */
async function installPage(page) {
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
          if (c.connect) return { id: c.id, connect: { client: "5328-capture", version: "6" } };
          if (c.subscribe) return { id: c.id, subscribe: { recoverable: true, positioned: true, recovered: false, epoch: "cap", offset: 0 } };
          return { id: c.id };
        });
        queueMicrotask(() => this.onmessage?.(new MessageEvent("message", { data: replies.map((r) => JSON.stringify(r)).join("\n") })));
      }
      close() { this.readyState = 3; this.onclose?.(new CloseEvent("close", { code: 1000 })); }
    }
    window.WebSocket = CaptureSocket;
    let n = 0;
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
      transformCallback: () => ++n, unregisterCallback: () => {}, convertFileSrc: (p) => p,
      invoke: async (cmd) => {
        if (cmd === "keychain_available") return false;
        if (cmd === "plugin:event|listen") return ++n;
        if (cmd === "plugin:window|is_fullscreen") return false;
        return null;
      },
    };
    Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
  });
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail === "" ? "" : `  (${detail})`}`);
}

async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
  await page.waitForTimeout(250);
}

async function open(browser, origin, { width, height, touch = false }) {
  const context = await browser.newContext({
    viewport: { width, height }, colorScheme: "light", reducedMotion: "reduce", serviceWorkers: "block",
    deviceScaleFactor: 2, locale: "ko-KR", timezoneId: "Asia/Seoul",
    ...(touch ? { hasTouch: true, isMobile: true } : {}),
  });
  await installRoutes(context);
  const page = await context.newPage();
  await installPage(page);
  await page.addInitScript(
    ({ server, session, record }) => {
      try {
        localStorage.setItem("momo.web.server.v1", server);
        localStorage.setItem("momo.web.session.v1", JSON.stringify(session));
        localStorage.setItem("momo.web.appearance.v2", JSON.stringify(record));
      } catch { /* 저장소 없는 캡처 */ }
    },
    {
      server: origin,
      session: { refreshToken: auth.refreshToken, realtimeWebSocketUrl: auth.realtimeWebSocketUrl, member: auth.member },
      record: { v: 2, scheme: "light", theme: "dawnsky", signal: null, density: "comfortable", glass: { on: false } },
    }
  );
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.getByTestId("profile-card").waitFor({ timeout: 20_000 });
  await page.evaluate((h) => { location.hash = h; }, `/c/${GENERAL}`);
  await page.locator('[data-testid="timeline-message"]').first().waitFor({ timeout: 20_000 });
  await page.mouse.move(2, 2);
  await settle(page);
  return { context, page };
}

const rowOf = (page, id) => page.locator(`[data-testid="timeline-message"][data-message-id="${idOf(id)}"]`);
const toolbarCount = (page) => page.locator('[data-testid="message-hover-toolbar"]').count();
const toolbarOn = (page, id) => rowOf(page, id).locator('[data-testid="message-hover-toolbar"]').count();

async function shot(page, file, clip) {
  if (!SHOTS) return;
  mkdirSync(OUT_DIR, { recursive: true });
  await page.screenshot({ path: resolve(OUT_DIR, `${LABEL}-${file}`), ...(clip ? { clip } : {}) });
}

/** 행을 스크롤러 가운데로 놓고 위에 포인터를 올린다. 막대가 설 때까지 기다린다. */
async function hoverRow(page, id) {
  await page.mouse.move(2, 2);
  await page.waitForTimeout(200);
  await page.evaluate(async (rowId) => {
    const frame = () => new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0)));
    const sc = document.querySelector("[data-virtuoso-scroller]");
    const row = document.querySelector(`[data-testid="timeline-message"][data-message-id="${rowId}"]`);
    if (!sc || !row) return;
    const r = row.getBoundingClientRect();
    const s = sc.getBoundingClientRect();
    sc.scrollTop += r.top - s.top - (s.height - r.height) / 2 - 80;
    for (let i = 0; i < 6; i += 1) await frame();
  }, idOf(id));
  const row = rowOf(page, id);
  await row.hover({ position: { x: 160, y: 20 } });
  await row.locator('[data-testid="message-hover-toolbar"]').waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(200);
  return row;
}

/** ⋮ 를 마우스로 눌러 메뉴를 열고 포인터를 첫 항목(고정) 위로 옮긴다. */
async function openMenuAndEnter(page) {
  const trigger = page.locator('[data-testid="message-actions-trigger"]');
  await trigger.click();
  const item = page.locator('[data-testid="menu-pin"]');
  await item.waitFor({ state: "visible", timeout: 3000 });
  await item.hover();
  await page.waitForTimeout(150);
  return item;
}

/** 막대가 선 행들(위 이웃부터 아래)을 담는 잘라낸 사진. 막대가 몇 개 남았는지가 한눈에 보인다. */
async function shotRows(page, file) {
  if (!SHOTS) return;
  const top = await rowOf(page, "0005").boundingBox();
  const bottom = await rowOf(page, "0010").boundingBox();
  if (!top || !bottom) return shot(page, file);
  await shot(page, file, { x: Math.max(0, top.x - 8), y: Math.max(0, top.y - 24), width: top.width + 16, height: Math.min(900 - Math.max(0, top.y - 24), bottom.y + bottom.height - top.y + 48) });
}

/** 1) 행동을 고른다: 메뉴가 닫히고 항목이 포인터 밑에서 사라진다. 포인터는 아래 행 위에 선다. */
async function runToolbarPick(page) {
  await hoverRow(page, "0007");
  const item = await openMenuAndEnter(page);
  const box = await item.boundingBox();
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(500);
  const menuGone = (await page.locator('[data-testid="message-action-menu"]').count()) === 0;
  // 사라진 항목 밑의 새 요소가 포인터 밑에 서도록 한 번 살짝 움직인다(실제 사람도 움직인다. WebKit 은 움직여야 호버를 다시 센다).
  const at = box ? [box.x + box.width / 2 + 2, box.y + box.height / 2 + 2] : [0, 0];
  await page.mouse.move(at[0], at[1]);
  await page.waitForTimeout(400);
  const underPointer = await page.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x, y);
    return el?.closest('[data-testid="timeline-message"]')?.getAttribute("data-message-id") ?? null;
  }, at);
  const onA = await toolbarOn(page, "0007");
  const total = await toolbarCount(page);
  check("메뉴에서 행동을 고르면 메뉴가 닫힌다", menuGone);
  check("행동을 고른 뒤 포인터가 떠난 메시지(위)의 막대는 사라진다", onA === 0 && underPointer !== idOf("0007"), `위 막대 ${onA} · 포인터 밑 ${underPointer?.slice(-4) ?? "없음"}`);
  check("두 메시지에 막대가 동시에 남지 않는다(하나 이하)", total <= 1, `막대 ${total}개`);
  await shotRows(page, "toolbar-after-pick.png");
}

/** 2) 열었다가 바깥(빈 자리)을 눌러 닫는다. */
async function runToolbarOutside(page) {
  await hoverRow(page, "0007");
  await openMenuAndEnter(page);
  await page.mouse.move(60, 400);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(500);
  const left = await toolbarCount(page);
  check("메뉴를 열었다 바깥을 눌러 닫으면 막대가 하나도 남지 않는다", left === 0, `막대 ${left}개`);
}

/** 3) 막대 단추를 마우스로 누르고(초점이 단추에 남는다) 포인터를 치운다. */
async function runToolbarButton(page) {
  const row = await hoverRow(page, "0007");
  await row.locator('[data-testid^="toolbar-react-"]').first().click();
  await page.waitForTimeout(250);
  await page.mouse.move(60, 400);
  await page.waitForTimeout(500);
  const left = await toolbarCount(page);
  check("막대 단추를 마우스로 누른 뒤 포인터가 떠나면 막대가 내려간다", left === 0, `막대 ${left}개`);
}

/** 4) 키보드: 행에 키보드로 닿으면 막대가 서고, ⋮ 에서 Enter 로 열어 항목에서 Enter 로 고르면 초점이 ⋮ 로 돌아와 막대가 남는다. */
async function runToolbarKeyboard(page) {
  await page.keyboard.press("Shift"); // 입력 방식을 키보드로 넘긴다(그 뒤 스크립트가 옮기는 초점이 `:focus-visible` 이다)
  await page.evaluate((rowId) => document.querySelector(`[data-testid="timeline-message"][data-message-id="${rowId}"]`)?.focus(), idOf("0007"));
  await rowOf(page, "0007").locator('[data-testid="message-hover-toolbar"]').waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(250);
  const trigger = rowOf(page, "0007").locator('[data-testid="message-actions-trigger"]');
  if ((await trigger.count()) > 0) await trigger.focus();
  await page.keyboard.press("Enter");
  // 내 글의 메뉴는 「고치기」가 첫 줄이다(#5213): 키보드로 열면 초점이 거기 서므로, 편집기가 열리지 않게 「고정」으로 옮긴다.
  await page.locator('[data-testid="menu-pin"]').waitFor({ state: "visible", timeout: 3000 });
  await page.locator('[data-testid="menu-pin"]').focus();
  await page.waitForTimeout(150);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(700);
  const stays = await toolbarOn(page, "0007");
  const focusOn = await page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? null);
  check("키보드로 행동을 고르면 초점이 ⋮ 로 돌아오고 막대가 남는다", stays === 1 && focusOn === "message-actions-trigger", `막대 ${stays} · 초점 ${focusOn}`);
}

async function typeLink(page) {
  const input = page.getByTestId("composer-input");
  await input.click();
  await input.fill(`운영 가이드 먼저 봐 주세요 ${LINK} `);
  await page.getByTestId("composer-link-preview").waitFor({ state: "visible", timeout: 8000 });
  await page.waitForTimeout(400);
}

/** 입력칸 미리보기 줄과 입력 그릇을 함께 담는 잘라낸 사진(전체 화면은 ✕ 가 너무 작게 나온다). */
async function shotComposer(page, file) {
  if (!SHOTS) return;
  const preview = await page.getByTestId("composer-link-preview").boundingBox();
  const frame = await page.getByTestId("composer-frame").boundingBox();
  const boxes = [preview, frame].filter(Boolean);
  if (boxes.length === 0) return shot(page, file);
  const pad = 16;
  const vp = page.viewportSize();
  const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad);
  const y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad);
  const r = Math.min(vp.width, Math.max(...boxes.map((b) => b.x + b.width)) + pad);
  const b = Math.min(vp.height, Math.max(...boxes.map((box) => box.y + box.height)) + pad);
  await shot(page, file, { x, y, width: r - x, height: b - y });
}

const xState = (page) =>
  page.getByTestId("composer-link-preview-dismiss").evaluate((el) => {
    const cs = getComputedStyle(el);
    const visual = el;
    const r = visual.getBoundingClientRect();
    return {
      opacity: Number(cs.opacity),
      borderTop: cs.borderTopWidth,
      radius: parseFloat(cs.borderTopLeftRadius),
      w: r.width, h: r.height,
      tab: el.tabIndex,
      label: el.getAttribute("aria-label"),
      shadow: cs.boxShadow !== "none",
    };
  });

async function runLinkX(page, { touch }) {
  await typeLink(page);
  const card = page.getByTestId("composer-link-preview").locator('[data-testid="unfurl-card"]').first();
  await page.mouse.move(2, 2);
  await page.waitForTimeout(300);
  const rest = await xState(page);
  if (touch) {
    check("손가락 입력(호버 없음)에서는 ✕ 가 늘 보인다", rest.opacity === 1, `opacity ${rest.opacity}`);
    await shotComposer(page, "x-touch.png");
    return;
  }
  check("호버가 되는 입력에서 가만히 있을 때 ✕ 는 안 보인다", rest.opacity === 0, `opacity ${rest.opacity}`);
  await shotComposer(page, "x-rest.png");
  await card.hover();
  await page.waitForTimeout(250);
  const hover = await xState(page);
  check("카드에 올리면 ✕ 가 선다", hover.opacity === 1, `opacity ${hover.opacity}`);
  await shotComposer(page, "x-hover.png");
  check("✕ 는 테두리가 없는 원이다", hover.borderTop === "0px" && hover.radius >= hover.w / 2 - 0.5, `테두리 ${hover.borderTop} · 반경 ${Math.round(hover.radius)} · ${hover.w}×${hover.h}`);
  check("✕ 는 이름이 있고 키보드로 닿는다", hover.label === "이번 메시지는 미리보기 없이 보내기" && hover.tab >= 0, `이름 ${hover.label} · tabIndex ${hover.tab}`);
  await page.mouse.move(2, 2);
  await page.waitForTimeout(250);
  check("포인터가 카드를 떠나면 ✕ 가 다시 안 보인다", (await xState(page)).opacity === 0);
  // 키보드: 글 칸에서 Shift+Tab 이 ✕ 에, 한 번 더 누르면 카드 링크에 닿는다. 닿는 순간 보인다.
  await page.getByTestId("composer-input").focus();
  await page.keyboard.press("Shift+Tab");
  await page.waitForTimeout(150);
  const onX = await page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? null);
  check("키보드로 ✕ 에 닿으면 보인다", onX === "composer-link-preview-dismiss" && (await xState(page)).opacity === 1, `초점 ${onX}`);
  await page.keyboard.press("Shift+Tab");
  await page.waitForTimeout(150);
  const onCard = await page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? null);
  check("키보드로 카드 링크에 닿으면 ✕ 가 선다", onCard === "unfurl-card" && (await xState(page)).opacity === 1, `초점 ${onCard}`);
}

async function main() {
  const dist = DIST_DIR ? resolve(DIST_DIR) : resolve(WEB_ROOT, "dist");
  if (!existsSync(resolve(dist, "index.html"))) throw new Error(`${dist}/index.html is missing. Run npm run build first (or set DIST_DIR).`);
  const preview = await startGuardedPreview({
    webRoot: WEB_ROOT,
    port: PORT,
    portEnvVar: "CAPTURE_PORT",
    ...(DIST_DIR ? { extraArgs: ["--outDir", dist] } : {}),
  });
  const browser = await (ENGINE === "webkit" ? webkit : chromium).launch();
  try {
    for (const scene of [runToolbarPick, runToolbarOutside, runToolbarButton, runToolbarKeyboard]) {
      const { context, page } = await open(browser, preview.origin, { width: 1440, height: 900 });
      try { await scene(page); } finally { await context.close(); }
    }
    {
      const { context, page } = await open(browser, preview.origin, { width: 1440, height: 900 });
      try { await runLinkX(page, { touch: false }); } finally { await context.close(); }
    }
    {
      const { context, page } = await open(browser, preview.origin, { width: 390, height: 844, touch: true });
      try { await runLinkX(page, { touch: true }); } finally { await context.close(); }
    }
  } finally {
    await browser.close();
    await preview.stop?.();
  }
  const bad = results.filter((r) => !r.ok);
  console.log(
    bad.length === 0
      ? `HOVER-TOOLBAR-LINK-X-5328 PASS (${results.length} checks, ${ENGINE}, ${LABEL})`
      : `HOVER-TOOLBAR-LINK-X-5328 FAIL (${bad.length}/${results.length}, ${ENGINE}, ${LABEL})`
  );
  process.exit(bad.length === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
