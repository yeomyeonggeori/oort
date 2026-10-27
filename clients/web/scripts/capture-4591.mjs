#!/usr/bin/env node
// =============================================================================
// #4591 캡처: 데스크탑 창 머리(Buzz식) — 맨 위 잡기 띠(40, 신호등 높이) · 대화 머리 그림자 · 머리 단추 연한 선 · 공용 툴팁
// 알약 · 판 바깥(위 띠·오른쪽·아래·모서리 뒤)이 사이드바와 같은 색 · 전체 화면 인셋 · 웹에는 띠가 없다. 인물은 가상 인물.
//
// 셸(Tauri)은 가짜 `__TAURI_INTERNALS__`로 흉내 낸다(신호등은 네이티브라 이 캡처에 없다. 실제 창에서 잰 값은 PR 본문).
// 백엔드 없음(`/v1/**` 고정 응답, 가짜 소켓). 단언이 하나라도 실패하면 종료 코드 1.
//   npm run build && node scripts/capture-4591.mjs      → captures/4591/*.png
// =============================================================================

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "captures/4591");
const PORT = Number(process.env.CAPTURE_PORT || 5491);
const MIN = 60_000;

const workspaceId = "00000000-0000-7000-8000-000000000001";
const me = "00000000-0000-7000-8000-000000000101";
const agentId = "00000000-0000-7000-8000-000000000102";
const peer = "00000000-0000-7000-8000-000000000103";
const peer2 = "00000000-0000-7000-8000-000000000104";
const GENERAL = "00000000-0000-7000-8000-000000000202";
const DESIGN = "00000000-0000-7000-8000-000000000203";
const DM = "00000000-0000-7000-8000-000000000401";

const person = (id, kind, displayName, handle, extra = {}) => ({
  id, workspaceId, kind, status: "active", role: "member", displayName, handle, channelCount: 2,
  channelIds: [GENERAL, DESIGN, DM], capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...extra,
});
const roster = [
  person(me, "human", "박서연", "seoyeon", { role: "owner" }),
  person(peer, "human", "이도현", "dohyun"),
  person(peer2, "human", "최민수", "minsu"),
  person(agentId, "agent", "김인턴", "kim-intern", { ownerHumanId: me, hostOnline: false }),
];
const channels = [
  { id: GENERAL, workspaceId, kind: "public", name: "일반", topic: "팀 공지와 가벼운 이야기", muted: false },
  { id: DESIGN, workspaceId, kind: "public", name: "디자인", topic: "창 머리·툴팁·토큰 이야기", muted: false },
  { id: DM, workspaceId, kind: "dm", muted: false, memberIds: [me, agentId] },
];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: me, workspaceId, kind: "human", displayName: "박서연", handle: "seoyeon" },
  realtimeWebSocketUrl: "ws://capture-4591.invalid/connection/websocket",
};

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function installRoutes(context, { rosterFail = false } = {}) {
  const now = Date.now();
  const row = (id, channelId, seq, author, body, ago, extra = {}) => ({
    id: `00000000-0000-7000-8000-0000000b${id}`, channelId, seq, hlcTs: now - ago, hlcCount: 0,
    authorMemberId: author, type: "text", body, state: "sent", createdAtMs: now - ago, ...extra,
  });
  const general = [
    row("0001", GENERAL, 1, peer, "내일 배포 전에 체크리스트 한 번만 같이 봐 주세요.", 90 * MIN),
    row("0002", GENERAL, 2, me, "확인했어요. 롤백 계획은 문서에 있어요.", 80 * MIN),
    row("0003", GENERAL, 3, peer2, "금요일 배포 공지 초안이에요. 이대로 올려도 될까요?", 70 * MIN),
    row("0004", GENERAL, 4, me, "네, 제목만 조금 짧게 바꾸면 좋겠어요.", 60 * MIN),
    row("0005", GENERAL, 5, peer, "알겠어요. 바꿔서 다시 올릴게요.", 50 * MIN),
    row("0006", GENERAL, 6, peer2, "그리고 창 머리 쪽 시안도 오늘 안에 공유할게요.", 40 * MIN),
    row("0007", GENERAL, 7, me, "좋아요. 라이트와 다크 둘 다 부탁해요.", 30 * MIN),
    row("0008", GENERAL, 8, peer, "넵. 툴팁 문구도 같이 정리해 둘게요.", 20 * MIN),
    row("0009", GENERAL, 9, peer2, "점심 먹고 한 번 더 맞춰 봐요.", 10 * MIN),
  ];
  const dm = [row("0011", DM, 11, me, "이번 주 일정 정리해 줘", 9 * MIN), row("0012", DM, 12, agentId, "네, 정리해서 올릴게요.", 8 * MIN)];
  await context.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId: me });
    }
    if (path.endsWith("/agent-dm-delivery")) return json(route, { agentMemberId: agentId, ownerMemberId: me, state: "open" });
    if (path.match(/\/agents\/([^/]+)\/liveness$/)) return json(route, { agentMemberId: agentId, state: "responsive", lastSignalAtMs: now - 30_000 });
    if (/\/inbox(\/|$)/.test(path)) return json(route, { items: [], nextCursor: null, unreadCount: 0, approvalsPending: 0 });
    if (path.endsWith("/agent-runs/progress")) return json(route, { runs: [] });
    if (path.endsWith("/hosted-agent-connections") && method === "GET") return json(route, { connections: [] });
    if (path.endsWith("/allowed-models")) return json(route, { allowedAgentModels: [] });
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) {
      if (rosterFail) return json(route, { error: { code: "unavailable", message: "roster unavailable" } }, 503);
      return json(route, { members: roster });
    }
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
    if (path.endsWith(`/workspaces/${workspaceId}`)) {
      return json(route, { workspace: { id: workspaceId, name: "달무리 스튜디오", slug: "team", updatedAtMs: 1, roleLabels: {}, welcomeAgentMemberId: null, welcomePrompt: "", subscriptionAgentsEnabled: true } });
    }
    if (path.includes(`/channels/${DM}/messages`)) return json(route, { messages: dm });
    if (path.includes(`/channels/${GENERAL}/messages`)) return json(route, { messages: general });
    if (path.includes("/messages")) return json(route, { messages: [] });
    return json(route, {});
  });
}

/** 셸이면 가짜 `__TAURI_INTERNALS__`를 심는다: `isFullscreen`은 `window.__capFullscreen`이 답한다(전체 화면 장면). */
async function installPage(page, { shell, fullscreen }) {
  await page.addInitScript(
    ({ shellOn, fullscreenOn }) => {
      class CaptureSocket {
        static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
        constructor(url) {
          this.url = String(url); this.readyState = 0;
          queueMicrotask(() => { this.readyState = 1; this.onopen?.(new Event("open")); });
        }
        send(data) {
          const replies = String(data).trim().split("\n").map((line) => {
            const c = JSON.parse(line);
            if (c.connect) return { id: c.id, connect: { client: "4591-capture", version: "6" } };
            if (c.subscribe) return { id: c.id, subscribe: { recoverable: true, positioned: true, recovered: false, epoch: "cap", offset: 0 } };
            return { id: c.id };
          });
          queueMicrotask(() => this.onmessage?.(new MessageEvent("message", { data: replies.map((r) => JSON.stringify(r)).join("\n") })));
        }
        close() { this.readyState = 3; this.onclose?.(new CloseEvent("close", { code: 1000 })); }
      }
      window.WebSocket = CaptureSocket;
      if (shellOn) {
        let n = 0;
        window.__capFullscreen = fullscreenOn;
        window.__TAURI_INTERNALS__ = {
          metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
          transformCallback: () => ++n, unregisterCallback: () => {}, convertFileSrc: (p) => p,
          invoke: async (cmd) => {
            if (cmd === "keychain_available") return false;
            if (cmd === "plugin:event|listen") return ++n;
            if (cmd === "plugin:window|is_fullscreen") return window.__capFullscreen === true;
            return null;
          },
        };
        Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
      }
    },
    { shellOn: shell, fullscreenOn: fullscreen }
  );
}

const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok) failures.push(name);
}

async function open(browser, origin, opts) {
  const {
    scheme, width, height = 760, hash, shell = true, theme = "dawnsky", fullscreen = false, rosterFail = false,
  } = opts;
  const context = await browser.newContext({
    viewport: { width, height }, colorScheme: scheme, reducedMotion: "reduce", serviceWorkers: "block",
    deviceScaleFactor: 2, locale: "ko-KR", timezoneId: "Asia/Seoul",
  });
  await installRoutes(context, { rosterFail });
  const page = await context.newPage();
  await installPage(page, { shell, fullscreen });
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
      record: { v: 2, scheme, theme, signal: null, density: "comfortable", glass: { on: false } },
    }
  );
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.getByTestId("profile-card").waitFor({ timeout: 20_000 });
  await page.evaluate((h) => { location.hash = h; }, hash);
  return { context, page };
}

async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
  await page.waitForTimeout(300);
}

/** (x, y) 한 픽셀을 화면에 그려진 대로 읽는다(스크린샷을 같은 엔진의 캔버스에 올려 읽는다). */
async function pixel(page, x, y) {
  const png = await page.screenshot({ clip: { x, y, width: 1, height: 1 } });
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.width; canvas.height = img.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2]];
  }, png.toString("base64"));
}

const spread = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

/**
 * 이 자리에 **사이드바가 서 있는 색**이 무엇이어야 하는지: 띠가 있으면 띠 색, 없으면 바닥 그라데이션이다. 같은 페이지·같은
 * 테마에서 창 전체를 덮는 기준 막대를 잠깐 띄워 읽는다(셸이 그 막대에 가려지고, 읽은 뒤에 치운다).
 */
async function sidebarColorAt(page, x, y) {
  await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.id = "cap-canvas-probe";
    const band = getComputedStyle(document.documentElement).getPropertyValue("--band").trim();
    probe.setAttribute("style",
      `position:fixed;inset:0;z-index:2147483647;pointer-events:none;background:${
        band ? "var(--band)" : "linear-gradient(160deg,var(--canvas-top) 0%,var(--canvas-mid) 42%,var(--canvas-bottom) 100%)"
      }`);
    document.body.append(probe);
  });
  try {
    return await pixel(page, x, y);
  } finally {
    await page.evaluate(() => document.getElementById("cap-canvas-probe")?.remove());
  }
}

/** 판 모서리 확대(오른쪽 위·오른쪽 아래): 창 가장자리 쪽 220×220 css px를 2x로 저장한다. */
async function cornerZooms(page, width, height, name) {
  await page.screenshot({ path: resolve(OUT_DIR, `${name}-top-right.png`), clip: { x: width - 220, y: 0, width: 220, height: 220 } });
  await page.screenshot({ path: resolve(OUT_DIR, `${name}-bottom-right.png`), clip: { x: width - 220, y: height - 220, width: 220, height: 220 } });
}

const HEAD_BUTTONS = ["open-terminal-dock", "open-pin-list", "channel-member-count", "huddle-start", "channel-title-menu"];

async function shellFacts(page) {
  return page.evaluate((ids) => {
    const r = (el) => { const b = el?.getBoundingClientRect(); return b ? { x: b.x, y: b.y, w: b.width, h: b.height, right: b.right, bottom: b.bottom } : null; };
    const q = (s) => document.querySelector(s);
    const head = q('[data-testid="channel-header"]');
    const headCs = head ? getComputedStyle(head) : null;
    const pane = q("main");
    const paneCs = pane ? getComputedStyle(pane) : null;
    return {
      titlebar: r(q('[data-testid="app-titlebar"]')),
      toggle: r(q('[data-testid="sidebar-toggle"]')),
      slot: r(q('[data-testid="app-titlebar-trailing"]')),
      pane: r(pane),
      radii: paneCs ? [paneCs.borderTopLeftRadius, paneCs.borderTopRightRadius, paneCs.borderBottomRightRadius, paneCs.borderBottomLeftRadius] : null,
      head: r(head),
      headBorder: headCs?.borderBottomWidth,
      headShadow: headCs?.boxShadow,
      buttons: ids.map((id) => { const b = q(`[data-testid="${id}"]`); return { id, present: !!b, title: b?.getAttribute("title") ?? null, border: b ? getComputedStyle(b).borderTopWidth : null }; }),
      shellMark: document.querySelector(".app-shell")?.hasAttribute("data-desktop-shell") ?? false,
      fullscreenMark: document.documentElement.hasAttribute("data-window-fullscreen"),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      vw: window.innerWidth,
      vh: window.innerHeight,
    };
  }, HEAD_BUTTONS);
}

const near = (actual, want, tol = 0.51) => Math.abs(actual - want) <= tol;

/** 판을 감춰 창 바닥만 남기고, 판 바깥 표본이 **사이드바의 색**과 같은지 잰다(판의 그림자·선 고리가 섞이지 않는다). */
async function assertOutsideColor(page, tag, { top = 40, left = 324, strip = true } = {}) {
  const { vw, vh } = await page.evaluate(() => ({ vw: window.innerWidth, vh: window.innerHeight }));
  const handle = await page.addStyleTag({ content: "main { visibility: hidden !important; }" });
  try {
    const points = [
      ["오른쪽 여백", vw - 4, Math.round(vh / 2)],
      ["아래 여백", Math.round(vw / 2), vh - 4],
      ["판 오른쪽 위 모서리 뒤", vw - 10, top + 1],
      ["판 오른쪽 아래 모서리 뒤", vw - 10, vh - 10],
      ["판 왼쪽 위 모서리 뒤", left + 1, top + 1],
      ["판 왼쪽 아래 모서리 뒤", left + 1, vh - 10],
      ...(strip ? [["위 띠", Math.round(vw / 2), 20]] : []),
    ];
    for (const [label, x, y] of points) {
      const got = await pixel(page, x, y);
      const want = await sidebarColorAt(page, x, y);
      const d = spread(got, want);
      check(`${tag} 판 바깥 ${label}(${x},${y}) = 사이드바 색`, d <= 3, `${got} ≠ ${want} (차 ${d})`);
    }
  } finally {
    await handle.evaluate((el) => el.remove());
  }
}

async function scene(browser, origin, scheme) {
  const shot = (n) => resolve(OUT_DIR, `${n}-${scheme}.png`);
  const rows = (page) => page.getByTestId("timeline-message");

  // 1) 셸 1100×760: 띠 · 판 · 머리 그림자 · 단추 선 · 툴팁이 따로 쓰는 title 없음
  {
    const { context, page } = await open(browser, origin, { scheme, width: 1100, hash: `/c/${GENERAL}` });
    await rows(page).first().waitFor({ timeout: 15_000 });
    await settle(page);
    const f = await shellFacts(page);
    check(`${scheme} 셸: 마커가 찍히고 띠 높이 40 · 판 위쪽 40`, f.shellMark && near(f.titlebar.h, 40) && near(f.pane.y, 40), JSON.stringify([f.shellMark, f.titlebar, f.pane]));
    check(`${scheme} 셸: 토글 중심 = 띠 가운데(20.0)`, near(f.toggle.y + f.toggle.h / 2, 20, 0.26), JSON.stringify(f.toggle));
    check(`${scheme} 셸: 오른쪽 자리가 있고 비어 있다(폭 0)`, f.slot !== null && near(f.slot.w, 0), JSON.stringify(f.slot));
    check(`${scheme} 셸: 판 네 모서리가 같다(18px)`, new Set(f.radii).size === 1 && f.radii[0] === "18px", JSON.stringify(f.radii));
    check(`${scheme} 셸: 판 오른쪽·아래 여백 8`, near(f.vw - f.pane.right, 8, 0.01) && near(f.vh - f.pane.bottom, 8, 0.01), JSON.stringify([f.vw - f.pane.right, f.vh - f.pane.bottom]));
    check(`${scheme} 머리: 아래 선 0 + 그림자`, f.headBorder === "0px" && f.headShadow && f.headShadow !== "none", JSON.stringify([f.headBorder, f.headShadow]));
    check(`${scheme} 머리 단추 다섯 개가 있고 네이티브 title이 없다`, f.buttons.every((b) => b.present && b.title === null), JSON.stringify(f.buttons));
    check(`${scheme} 머리 단추: 1px 선`, f.buttons.every((b) => b.border === "1px"), JSON.stringify(f.buttons.map((b) => b.border)));
    check(`${scheme} 가로 넘침 0`, f.overflow <= 0, String(f.overflow));
    await page.screenshot({ path: shot("1-shell") });
    await assertOutsideColor(page, `${scheme} 셸`);
    await context.close();
  }

  // 2) 좁은 창(720): 띠·판·머리가 그대로 서고 넘치지 않는다
  {
    const { context, page } = await open(browser, origin, { scheme, width: 720, height: 560, hash: `/c/${GENERAL}` });
    await rows(page).first().waitFor({ timeout: 15_000 });
    await settle(page);
    const f = await shellFacts(page);
    check(`${scheme} 좁은 창: 띠 40 · 판 위쪽 40 · 가로 넘침 0`, near(f.titlebar.h, 40) && near(f.pane.y, 40) && f.overflow <= 0, JSON.stringify([f.titlebar, f.pane, f.overflow]));
    check(`${scheme} 좁은 창: 머리 단추 다섯 개가 판 안에 든다`, await page.evaluate((ids) => {
      const pane = document.querySelector("main").getBoundingClientRect();
      return ids.every((id) => { const b = document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect(); return b && b.left >= pane.left && b.right <= pane.right; });
    }, HEAD_BUTTONS));
    await page.screenshot({ path: shot("2-narrow") });
    await context.close();
  }

  // 3) 접힘: 토글을 누르면 판이 레일 옆으로 오고 띠는 그대로 40
  {
    const { context, page } = await open(browser, origin, { scheme, width: 1100, hash: `/c/${GENERAL}` });
    await rows(page).first().waitFor({ timeout: 15_000 });
    await page.getByTestId("sidebar-toggle").click();
    await settle(page);
    const f = await shellFacts(page);
    check(`${scheme} 접힘: 판 왼쪽 = 레일 56 + 인셋 8, 판 위쪽 40`, near(f.pane.x, 64) && near(f.pane.y, 40), JSON.stringify(f.pane));
    check(`${scheme} 접힘: 토글 중심은 그대로 20.0`, near(f.toggle.y + f.toggle.h / 2, 20, 0.26), JSON.stringify(f.toggle));
    if (scheme === "light") await page.screenshot({ path: shot("3-collapsed") });
    await assertOutsideColor(page, `${scheme} 접힘`, { left: 64 });
    await context.close();
  }

  // 4) 웹(브라우저): 띠가 없다. 판은 첫 행까지 올라가 8에서 시작하고 오른쪽 자리도 없다
  {
    const { context, page } = await open(browser, origin, { scheme, width: 1100, hash: `/c/${GENERAL}`, shell: false });
    await rows(page).first().waitFor({ timeout: 15_000 });
    await settle(page);
    const f = await shellFacts(page);
    check(`${scheme} 웹: 마커·오른쪽 자리가 없고 판 위쪽 8`, !f.shellMark && f.slot === null && near(f.pane.y, 8), JSON.stringify([f.shellMark, f.slot, f.pane]));
    if (scheme === "light") await page.screenshot({ path: shot("4-web") });
    await assertOutsideColor(page, `${scheme} 웹`, { top: 8, strip: false });
    await context.close();
  }

  // 5) 머리 단추 툴팁(연회색 알약): 터미널(첫째)과 ⋮(맨 오른쪽, 오른쪽 끝 정렬)
  {
    const { context, page } = await open(browser, origin, { scheme, width: 1100, hash: `/c/${GENERAL}` });
    await rows(page).first().waitFor({ timeout: 15_000 });
    await settle(page);
    for (const [id, name] of [["open-terminal-dock", "5-tooltip-terminal"], ["channel-title-menu", "5-tooltip-menu"]]) {
      await page.getByTestId(id).hover();
      await page.waitForTimeout(150);
      const early = await page.getByTestId("tooltip").count();
      await page.waitForTimeout(700);
      const tip = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="tooltip"]');
        if (!el) return null;
        const cs = getComputedStyle(el);
        const probe = document.createElement("i");
        probe.setAttribute("style", "background:var(--muted-soft)");
        document.body.append(probe);
        const mutedSoft = getComputedStyle(probe).backgroundColor;
        probe.remove();
        const r = el.getBoundingClientRect();
        const pane = document.querySelector("main").getBoundingClientRect();
        return { bg: cs.backgroundColor, mutedSoft, shadow: cs.boxShadow, border: cs.borderTopWidth, inside: r.left >= pane.left && r.right <= pane.right && r.bottom <= pane.bottom };
      });
      check(`${scheme} 툴팁(${id}): 마우스는 500ms 전엔 없고 뒤엔 선다`, early === 0 && tip !== null, `early=${early} tip=${JSON.stringify(tip)}`);
      if (tip) {
        check(`${scheme} 툴팁(${id}): 연회색 알약(--muted-soft), 선·그림자 없음, 판 안에 든다`, tip.bg === tip.mutedSoft && tip.shadow === "none" && tip.border === "0px" && tip.inside, JSON.stringify(tip));
      }
      await page.screenshot({ path: shot(name), clip: { x: 640, y: 0, width: 460, height: 200 } });
      await page.mouse.move(10, 700);
      await page.waitForTimeout(100);
    }
    await context.close();
  }

  // 6) 메시지 줄 툴바의 툴팁도 같은 알약이다(planner 결정 2)
  {
    const { context, page } = await open(browser, origin, { scheme, width: 1100, hash: `/c/${GENERAL}` });
    await rows(page).first().waitFor({ timeout: 15_000 });
    await settle(page);
    const row = rows(page).nth(2);
    await row.hover();
    await row.getByTestId("toolbar-reply").hover();
    await page.waitForTimeout(800);
    const tip = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="tooltip"]');
      if (!el) return null;
      const probe = document.createElement("i");
      probe.setAttribute("style", "background:var(--muted-soft)");
      document.body.append(probe);
      const mutedSoft = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { bg: getComputedStyle(el).backgroundColor, mutedSoft, shadow: getComputedStyle(el).boxShadow };
    });
    check(`${scheme} 줄 툴바 툴팁: 같은 연회색 알약`, tip !== null && tip.bg === tip.mutedSoft && tip.shadow === "none", JSON.stringify(tip));
    const box = await row.boundingBox();
    if (box) await page.screenshot({ path: shot("6-row-toolbar-tooltip"), clip: { x: 324, y: Math.max(0, box.y - 60), width: 768, height: 200 } });
    await context.close();
  }
}

/** 전체 화면: 신호등이 사라지는 창이라 80px 인셋이 접힌다(`isFullscreen`을 가짜 셸이 참으로 답한다). */
async function sceneFullscreen(browser, origin) {
  const { context, page } = await open(browser, origin, { scheme: "light", width: 1440, height: 900, hash: `/c/${GENERAL}`, fullscreen: true });
  await page.getByTestId("timeline-message").first().waitFor({ timeout: 15_000 });
  await settle(page);
  const f = await shellFacts(page);
  check("전체 화면: 루트 표지가 찍히고 토글이 12에 선다(신호등 인셋 80이 접혔다)", f.fullscreenMark && near(f.toggle.x, 12, 0.26), JSON.stringify([f.fullscreenMark, f.toggle]));
  check("전체 화면: 띠 높이·토글 중심은 그대로", near(f.titlebar.h, 40) && near(f.toggle.y + f.toggle.h / 2, 20, 0.26), JSON.stringify([f.titlebar, f.toggle]));
  await page.screenshot({ path: resolve(OUT_DIR, "7-fullscreen-light.png") });
  await context.close();
  // 대조: 창 모드(전체 화면 아님)는 80이다.
  const windowed = await open(browser, origin, { scheme: "light", width: 1440, height: 900, hash: `/c/${GENERAL}` });
  await windowed.page.getByTestId("timeline-message").first().waitFor({ timeout: 15_000 });
  await settle(windowed.page);
  const g = await shellFacts(windowed.page);
  check("창 모드: 표지가 없고 토글이 신호등 인셋 80에 선다", !g.fullscreenMark && near(g.toggle.x, 80, 0.26), JSON.stringify([g.fullscreenMark, g.toggle]));
  await windowed.context.close();
}

/** 테마 대표: 기본(새벽하늘) 라이트·다크, 흑연, 노을띠(남색 사이드바) 라이트·다크, 카탈로그(노드) 다크. 판 바깥 색 단언 + 오른쪽 위·아래 확대. */
async function sceneThemes(browser, origin) {
  const cases = [
    ["dawnsky", "light"], ["dawnsky", "dark"], ["graphite", "dark"],
    ["noeul", "light"], ["noeul", "dark"], ["catalog:nord", "dark"],
  ];
  for (const [theme, scheme] of cases) {
    const slug = theme.replace(":", "-");
    const { context, page } = await open(browser, origin, { scheme, width: 1100, hash: `/c/${GENERAL}`, theme });
    await page.getByTestId("timeline-message").first().waitFor({ timeout: 15_000 });
    await settle(page);
    const tag = `${theme} ${scheme}`;
    await assertOutsideColor(page, tag);
    // 새벽하늘 전체 장면은 `1-shell`과 같은 그림이다: 확대만 따로 둔다.
    if (theme !== "dawnsky") await page.screenshot({ path: resolve(OUT_DIR, `8-theme-${slug}-${scheme}.png`) });
    await cornerZooms(page, 1100, 760, `8z-${slug}-${scheme}`);
    await context.close();
  }
  // 노을띠는 띠가 판 바깥 전체이므로, 오른쪽 여백 픽셀이 띠 색(어두운 남색)이다(밝은 바닥이 아니다).
  const { context, page } = await open(browser, origin, { scheme: "light", width: 1100, hash: `/c/${GENERAL}`, theme: "noeul" });
  await page.getByTestId("timeline-message").first().waitFor({ timeout: 15_000 });
  await settle(page);
  const band = await page.evaluate(() => {
    const probe = document.createElement("i");
    probe.setAttribute("style", "background:var(--band)");
    document.body.append(probe);
    const m = getComputedStyle(probe).backgroundColor.match(/[\d.]+/g) ?? [];
    probe.remove();
    return m.slice(0, 3).map(Number);
  });
  const handle = await page.addStyleTag({ content: "main { visibility: hidden !important; }" });
  const rightMargin = await pixel(page, 1096, 400);
  await handle.evaluate((el) => el.remove());
  check("노을띠: 판 오른쪽 여백이 띠 색(남색)이다", band.length === 3 && spread(rightMargin, band) <= 3, `${rightMargin} vs ${band}`);
  await context.close();
}

/** 노을띠에서 다른 표면: 설정 전면은 창 바닥 전체가 띠, 「내 작업」은 판이 없어 띠가 사이드바 열(+윗줄)만이다. */
async function sceneOtherSurfaces(browser, origin) {
  const band = async (page) => page.evaluate(() => {
    const probe = document.createElement("i");
    probe.setAttribute("style", "background:var(--band)");
    document.body.append(probe);
    const m = getComputedStyle(probe).backgroundColor.match(/[\d.]+/g) ?? [];
    probe.remove();
    return m.slice(0, 3).map(Number);
  });
  // 설정 전면
  {
    const { context, page } = await open(browser, origin, { scheme: "light", width: 1100, hash: "/settings", theme: "noeul" });
    const found = await page.waitForSelector(".app-shell[data-settings-surface]", { timeout: 15_000 }).then(() => true, () => false);
    check("노을띠 설정 전면: 설정 표면 마커가 선다", found);
    if (found) {
      await settle(page);
      const handle = await page.addStyleTag({ content: "main { visibility: hidden !important; }" });
      const want = await band(page);
      for (const [label, x, y] of [["오른쪽 끝", 1096, 400], ["아래 끝", 550, 756], ["본문 가운데", 700, 400]]) {
        const got = await pixel(page, x, y);
        check(`노을띠 설정 전면: ${label}(${x},${y})가 띠 색이다`, spread(got, want) <= 3, `${got} vs ${want}`);
      }
      await handle.evaluate((el) => el.remove());
      await page.screenshot({ path: resolve(OUT_DIR, "11-settings-noeul-light.png") });
    }
    await context.close();
  }
  // 내 작업
  {
    const { context, page } = await open(browser, origin, { scheme: "light", width: 1100, hash: "/work?view=terminals", theme: "noeul" });
    const found = await page.waitForSelector(".app-shell[data-work-rail]", { timeout: 15_000 }).then(() => true, () => false);
    check("노을띠 내 작업: 작업 탭 마커가 선다", found);
    if (found) {
      await settle(page);
      const want = await band(page);
      const handle = await page.addStyleTag({ content: "main { visibility: hidden !important; }" });
      const strip = await pixel(page, 700, 20);
      const floor = await pixel(page, 700, 400);
      await handle.evaluate((el) => el.remove());
      check("노을띠 내 작업: 윗줄(40)은 전폭 띠 색이다", spread(strip, want) <= 3, `${strip} vs ${want}`);
      check("노을띠 내 작업: 사이드바 오른쪽 바닥은 띠 색이 아니다(칸이 바닥 위에 선다)", spread(floor, want) >= 20, `${floor} vs ${want}`);
      await page.screenshot({ path: resolve(OUT_DIR, "12-mywork-noeul-light.png") });
    }
    await context.close();
  }
}

/** 머리 아래에 오는 배너(앵커를 못 찾았다): `--head-edge`가 타임라인이 아니라 배너 위에 떨어진다. */
async function sceneBanner(browser, origin) {
  const { context, page } = await open(browser, origin, { scheme: "light", width: 1100, hash: `/c/${GENERAL}?seq=500` });
  await page.getByTestId("timeline-message").first().waitFor({ timeout: 15_000 });
  const banner = await page.getByTestId("chat-anchor-missed").waitFor({ timeout: 8_000 }).then(() => true, () => false);
  check("머리 + 앵커 배너: 배너가 머리 바로 아래에 선다", banner, "배너가 나타나지 않았다");
  if (banner) {
    const gap = await page.evaluate(() => {
      const head = document.querySelector('[data-testid="channel-header"]').getBoundingClientRect();
      const b = document.querySelector('[data-testid="chat-anchor-missed"]').getBoundingClientRect();
      return b.top - head.bottom;
    });
    check("머리 + 앵커 배너: 머리와 배너 사이가 비지 않는다", gap >= -0.5 && gap <= 1, String(gap));
    await settle(page);
    await page.screenshot({ path: resolve(OUT_DIR, "9-header-banner-light.png"), clip: { x: 324, y: 30, width: 768, height: 220 } });
  }
  await context.close();
}

/** 멤버 명단이 실패한 머리: 가운데 정렬 툴팁이 판 오른쪽 끝에서 잘리지 않는다. */
async function sceneMemberError(browser, origin) {
  const { context, page } = await open(browser, origin, { scheme: "light", width: 1100, hash: `/c/${GENERAL}`, rosterFail: true });
  await page.getByTestId("channel-member-count").waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => document.querySelector('[data-testid="channel-member-count"]')?.getAttribute("data-roster-status") === "failed", null, { timeout: 15_000 }).catch(() => undefined);
  await settle(page);
  await page.getByTestId("channel-member-count").hover();
  await page.waitForTimeout(800);
  const tip = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="tooltip"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const pane = document.querySelector("main").getBoundingClientRect();
    return { text: el.textContent, right: r.right, paneRight: pane.right, left: r.left, paneLeft: pane.left };
  });
  check("멤버 명단 실패 툴팁이 뜨고 판 안에 든다(오른쪽 끝에서 잘리지 않는다)", tip !== null && tip.right <= tip.paneRight && tip.left >= tip.paneLeft, JSON.stringify(tip));
  await page.screenshot({ path: resolve(OUT_DIR, "10-member-error-tooltip-light.png"), clip: { x: 640, y: 0, width: 460, height: 200 } });
  await context.close();
}

/** 테마 전환 직후: 설정에서 타일을 눌러 바꾼 바로 다음 프레임의 판 바깥 색이 새로 부팅한 같은 테마의 색과 같다(옛 색이 남지 않는다). */
async function sceneThemeSwitch(browser, origin) {
  const edge = async (page) => {
    const { vw, vh } = await page.evaluate(() => ({ vw: window.innerWidth, vh: window.innerHeight }));
    const handle = await page.addStyleTag({ content: "main { visibility: hidden !important; }" });
    try {
      return [await pixel(page, vw - 4, Math.round(vh / 2)), await pixel(page, Math.round(vw / 2), vh - 4)];
    } finally {
      await handle.evaluate((el) => el.remove());
    }
  };
  const fresh = new Map();
  for (const theme of ["dawnsky", "graphite", "noeul"]) {
    const boot = await open(browser, origin, { scheme: "light", width: 1100, hash: "/settings?section=appearance", theme });
    await boot.page.getByTestId("theme-style-trigger").waitFor({ timeout: 20_000 });
    await settle(boot.page);
    fresh.set(theme, await edge(boot.page));
    await boot.context.close();
  }
  const { context, page } = await open(browser, origin, { scheme: "light", width: 1100, hash: "/settings?section=appearance", theme: "dawnsky" });
  await page.getByTestId("theme-style-trigger").waitFor({ timeout: 20_000 });
  await page.getByTestId("theme-style-trigger").click();
  await page.getByTestId("theme-tile-noeul").waitFor({ timeout: 20_000 });
  await settle(page);
  for (const next of ["noeul", "graphite", "dawnsky", "noeul", "dawnsky"]) {
    // 타일을 누르고 **다음 프레임 한 번**만 기다려 읽는다(옛 색이 남으면 여기서 붉다).
    await page.getByTestId(`theme-tile-${next}`).click({ force: true });
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => done())));
    const [right, bottom] = await edge(page);
    const [wantRight, wantBottom] = fresh.get(next);
    check(`테마 전환 → ${next}: 오른쪽 여백이 바로 새 색이다`, spread(right, wantRight) <= 3, `${right} ≠ ${wantRight}`);
    check(`테마 전환 → ${next}: 아래 여백이 바로 새 색이다`, spread(bottom, wantBottom) <= 3, `${bottom} ≠ ${wantBottom}`);
  }
  await context.close();
}

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) throw new Error("dist/ is missing. Run npm run build first.");
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  try {
    for (const scheme of ["light", "dark"]) await scene(browser, preview.origin, scheme);
    await sceneFullscreen(browser, preview.origin);
    await sceneThemes(browser, preview.origin);
    await sceneOtherSurfaces(browser, preview.origin);
    await sceneBanner(browser, preview.origin);
    await sceneMemberError(browser, preview.origin);
    await sceneThemeSwitch(browser, preview.origin);
  } finally {
    await browser.close();
    await preview.stop?.();
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length}개 단언 실패`);
    process.exit(1);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
