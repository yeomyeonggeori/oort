#!/usr/bin/env node
// =============================================================================
// #5192 레인: 메시지 호버 툴바·「더 많은 기능」(⋮) 메뉴·공용 툴팁 (owner 데스크탑 검수, Buzz 참고).
//
//   npm run build && node scripts/capture-5192.mjs
//   DIST_DIR=<다른 dist> node scripts/capture-5192.mjs          # 고치기 전 번들로 RED 를 다시 볼 때
//   OUT_DIR=<dir> node scripts/capture-5192.mjs                 # 캡처 저장 자리(기본 artifacts/5192, git 무시)
//   SHOTS=0 node scripts/capture-5192.mjs                       # 재기만(캡처 없음)
//   ENGINE=webkit node scripts/capture-5192.mjs                 # 같은 레인을 WebKit(WKWebView 의 엔진)으로
//   ONLY=1440-light node scripts/capture-5192.mjs               # 한 칸만(손으로 고칠 때)
//
// 재는 것(데스크탑 셸 흉내 · 900·1440 × 밝음·어두움 × 내 메시지·남의 메시지·에이전트 메시지):
//   도구 막대   호버로 서고, 아이콘이 뜻에 맞는 Lucide 글리프(⋮ = ellipsis-vertical, 반응 더하기 = smile-plus)다.
//   ⋮ 메뉴      짧은 목록: 반응 줄·다른 반응 고르기·답글이 없다(도구 막대 몫), 묶음 사이에만 구분선, 지우기가 맨 아래·위험색,
//               판 안(가로는 본문 판, 세로는 창)에 머문다. 키보드: Enter 로 열고 방향키가 항목을 돌고 Esc 가 초점을 ⋮ 로 돌려준다.
//   우클릭 메뉴 ⋮ 메뉴와 같은 목록·같은 순서다. **글자 위 우클릭도 두 엔진 모두 열린다**(macOS WebKit 은 우클릭한 낱말을 먼저 고르는데
//               그 선택을 양보로 읽던 것을 #5192 가 고쳤다). 사용자가 먼저 고른 선택(더블클릭) 위 우클릭은 두 엔진 모두 기본 메뉴에 양보한다.
//   툴팁        처음 가리키면 ≤ 200ms 안에 선다(목표 ≤ 150, 정확한 경계는 `tooltipDelay.test.ts`가 가짜 시계로 잰다),
//               옆 단추로 옮기면 바로 선다(≤ 80ms, 한 번에 하나), 빠른 통과는 안 뜨고, 키보드 초점은 즉시 뜬다.
//   겹침        넓은 판(1440)은 도구 막대 ∩ 이웃 글자 = 0 (레인 공용 자 `lib/hoverToolbarOverlap.mjs`). 좁은 판(900)의 겹침은 #4231 1번의
//               기존 결함이고 값이 실행마다 0↔16으로 흔들려 로그에만 적는다. 대신 도구 막대 너비(남의·에이전트 223, 내 행 257)가 커지지 않았는지를
//               결정적으로 단정한다.
//
// 백엔드는 없다: `/v1/**` 는 고정 응답이고 소켓은 구독만 받는다. 인물은 전부 가상이다(레포는 공개).
// 단언이 하나라도 실패하면 종료 코드 1(고치기 전 번들에서는 붉은 것이 정상: 그것이 「고치기 전 RED」다).
// =============================================================================
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import {
  assertHoverToolbarClearsBodyText,
  measureHoverToolbarOverlap,
} from "./lib/hoverToolbarOverlap.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/5192");
const PORT = Number(process.env.CAPTURE_PORT || 5592);
const DIST_DIR = process.env.DIST_DIR || "";
const SHOTS = process.env.SHOTS !== "0";
const ENGINE = process.env.ENGINE === "webkit" ? "webkit" : "chromium";
const MIN = 60_000;

/** 처음 가리킨 뒤 툴팁이 서기까지 허용하는 상한(ms). 코드의 지연은 120이고 타이머·렌더 오차를 넉넉히 둔다. */
const FIRST_TIP_MAX_MS = 200;
/** 옆 단추로 옮겼을 때 툴팁이 서기까지의 상한(ms): 지연이 없으니 렌더 한두 프레임이다. */
const HOP_TIP_MAX_MS = 80;
/**
 * 호버 도구 막대의 너비 상한(css px). 남의·에이전트 행은 변경 전과 같은 223×42다. 내 행은 고치기 연필(#5326, `toolbar-edit`)이 도구 막대에
 * 올라 한 칸(34)이 더해진 257×42다(7번째 단추): 연필은 내 메시지에만 서므로 두 상한을 따로 둔다.
 * #4231 1번(900폭에서 도구 막대가 앞 행 끝줄을 덮음)은 이 이슈 이전부터 있던 결함이다. 덮는 글자 수는 앞 행의 마지막 줄이 막대 왼쪽 끝에
 * 닿느냐에 달려 **실행마다 0과 16 사이로 흔들려서**(같은 번들·같은 레인을 반복해도 그렇다) 상한 가드로 쓰지 못한다(값은 로그에만 적는다).
 * 대신 원인인 도구 막대의 **크기**를 결정적으로 가둔다: 막대를 키우는 변경은 덮는 글자를 늘리고 행의 모양을 갈라 놓는다.
 */
const TOOLBAR_MAX_WIDTH = 223.5;
/** 내 메시지의 도구 막대 상한: 남의 행 223 + 연필 한 칸 34. 연필 말고 단추가 하나라도 더 오르면 이 상한이 잡는다. */
const TOOLBAR_MAX_WIDTH_OWN = 257.5;
/** 이 폭부터는 본문 판이 넉넉해 막대 아래 이웃 글자가 없어야 한다(0 단정). */
const WIDE_PANE_MIN_VIEWPORT = 1100;

const workspaceId = "00000000-0000-7000-8000-000000000001";
const me = "00000000-0000-7000-8000-000000000101";
const agentId = "00000000-0000-7000-8000-000000000102";
const peer = "00000000-0000-7000-8000-000000000103";
const peer2 = "00000000-0000-7000-8000-000000000104";
const GENERAL = "00000000-0000-7000-8000-000000000202";

const person = (id, kind, displayName, handle, extra = {}) => ({
  id, workspaceId, kind, status: "active", role: "member", displayName, handle, channelCount: 1,
  channelIds: [GENERAL], capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...extra,
});
const roster = [
  person(me, "human", "박서연", "seoyeon", { role: "owner" }),
  person(peer, "human", "이도현", "dohyun"),
  person(peer2, "human", "최민수", "minsu"),
  person(agentId, "agent", "김인턴", "kim-intern", { ownerHumanId: me, hostOnline: false }),
];
const channels = [{ id: GENERAL, workspaceId, kind: "public", name: "일반", topic: "팀 공지와 가벼운 이야기", muted: false }];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: me, workspaceId, kind: "human", displayName: "박서연", handle: "seoyeon" },
  realtimeWebSocketUrl: "ws://capture-5192.invalid/connection/websocket",
};

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** 행 종류 셋. 이웃 행(바로 위)은 마지막 줄이 오른쪽 끝까지 오는 긴 글이다: 겹침 자의 가장 나쁜 경우를 일부러 만든다. */
const KINDS = [
  { kind: "me", name: "내 메시지", id: "0007", seq: 7, own: true },
  { kind: "peer", name: "남의 메시지", id: "0006", seq: 6, own: false },
  { kind: "agent", name: "에이전트 메시지", id: "0008", seq: 8, own: false },
];

async function installRoutes(context) {
  const now = Date.now();
  const row = (id, seq, author, body, ago) => ({
    id: `00000000-0000-7000-8000-0000000b${id}`, channelId: GENERAL, seq, hlcTs: now - ago, hlcCount: 0,
    authorMemberId: author, type: "text", body, state: "sent", createdAtMs: now - ago,
  });
  const long1 = "내일 배포 전에 체크리스트를 한 번만 같이 봐 주세요. 롤백 계획과 알림 문구, 담당자 연락처까지 빠짐없이 확인하면 좋겠어요.";
  const long2 = "공지 초안을 먼저 올려 둘게요. 제목은 짧게 줄이고, 본문은 변경 사항 세 가지와 롤백 방법만 남겨서 한눈에 읽히게 해 봤어요.";
  const general = [
    row("0001", 1, peer, long1, 90 * MIN),
    row("0002", 2, me, "확인했어요. 롤백 계획은 문서에 있어요.", 80 * MIN),
    row("0003", 3, peer2, "금요일 배포 공지 초안이에요. 이대로 올려도 될까요?", 70 * MIN),
    row("0004", 4, me, "네, 제목만 조금 짧게 바꾸면 좋겠어요.", 60 * MIN),
    row("0005", 5, agentId, long2, 50 * MIN),
    row("0006", 6, peer, "알겠어요. 바꿔서 다시 올릴게요. 시안 링크도 같이 남겨 둘게요. 라이트와 다크 둘 다 부탁해요. 오늘 안에 확인해 주세요.", 40 * MIN),
    row("0007", 7, me, "좋아요. 라이트와 다크 둘 다 부탁해요. 툴팁 문구도 같이 정리해 두면 더 좋겠어요. 확인은 제가 할게요.", 30 * MIN),
    row("0008", 8, agentId, "체크리스트를 정리했어요. 빠진 항목이 있으면 알려 주세요.", 20 * MIN),
    row("0009", 9, peer2, "점심 먹고 한 번 더 맞춰 봐요.", 10 * MIN),
  ];
  await context.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
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
    if (path.endsWith(`/workspaces/${workspaceId}`)) {
      return json(route, { workspace: { id: workspaceId, name: "달무리 스튜디오", slug: "team", updatedAtMs: 1, roleLabels: {}, welcomeAgentMemberId: null, welcomePrompt: "", subscriptionAgentsEnabled: true } });
    }
    if (path.includes(`/channels/${GENERAL}/messages`)) return json(route, { messages: general });
    if (path.includes("/messages")) return json(route, { messages: [] });
    return json(route, {});
  });
}

/** 가짜 소켓 + 데스크탑 셸(가짜 `__TAURI_INTERNALS__`, 맥 플랫폼): 네이티브 호출은 가짜가 받는다. */
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
          if (c.connect) return { id: c.id, connect: { client: "5192-capture", version: "6" } };
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
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
}
const note = (line) => console.log(`     ${line}`);

async function open(browser, origin, scheme, width, height) {
  const context = await browser.newContext({
    viewport: { width, height }, colorScheme: scheme, reducedMotion: "reduce", serviceWorkers: "block",
    deviceScaleFactor: 2, locale: "ko-KR", timezoneId: "Asia/Seoul",
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
      record: { v: 2, scheme, theme: "dawnsky", signal: null, density: "comfortable", glass: { on: false } },
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

async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
  await page.waitForTimeout(300);
}

const rowOf = (page, id) => page.locator(`[data-testid="timeline-message"][data-message-id="00000000-0000-7000-8000-0000000b${id}"]`);

/** 그 행을 스크롤러 가운데로 놓고(위·아래 이웃이 다 보이게) 포인터를 올린다. 툴바가 설 때까지 기다린다. */
async function hoverRow(page, k) {
  await page.mouse.move(2, 2);
  await page.waitForTimeout(250);
  await page.evaluate(async (id) => {
    const frame = () => new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0)));
    const sc = document.querySelector("[data-virtuoso-scroller]");
    const row = document.querySelector(`[data-testid="timeline-message"][data-message-id="00000000-0000-7000-8000-0000000b${id}"]`);
    if (!sc || !row) return;
    const r = row.getBoundingClientRect();
    const s = sc.getBoundingClientRect();
    sc.scrollTop += r.top - s.top - (s.height - r.height) / 2;
    for (let i = 0; i < 6; i += 1) await frame();
  }, k.id);
  const row = rowOf(page, k.id);
  await row.hover({ position: { x: 120, y: 24 } });
  await row.locator('[data-testid="message-hover-toolbar"]').waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(200);
  return row;
}

/** 지금 마운트된 도구 막대의 수. 장면은 늘 정확히 하나(대상 행의 것)여야 한다: 남은 막대가 있으면 다른 행의 단추를 누르게 된다. */
const toolbarCount = (page) => page.locator('[data-testid="message-hover-toolbar"]').count();

/** 글리프 이름(`lucide-…`) 목록. */
const glyphs = (loc) =>
  loc.evaluate((el) => Array.from(el.querySelectorAll("svg")).map((s) => /lucide-[a-z0-9-]+/.exec(s.getAttribute("class") || "")?.[0] || "(lucide 아님)")).catch(() => []);

/** 열린 메뉴의 행·구분선 순서: 행은 접두사를 뗀 키, 구분선은 `|`. */
async function menuSequence(page, menuId, prefix) {
  return page.evaluate(({ menuId, prefix }) => {
    const menu = document.querySelector(`[data-testid="${menuId}"]`);
    if (!menu) return null;
    return Array.from(menu.querySelectorAll('[role="menuitem"], [role="separator"]')).map((el) =>
      el.getAttribute("role") === "separator" ? "|" : (el.getAttribute("data-testid") || "").slice(prefix.length)
    );
  }, { menuId, prefix });
}

const rectOf = (page, selector) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height };
  }, selector);

/** 도구 막대와 열린 메뉴를 함께 담는 잘라낸 사진. */
async function shotAround(page, file, selectors, pad = 24) {
  if (!SHOTS) return;
  mkdirSync(OUT_DIR, { recursive: true });
  const rects = [];
  for (const sel of selectors) {
    const r = await rectOf(page, sel);
    if (r) rects.push(r);
  }
  if (rects.length === 0) return page.screenshot({ path: resolve(OUT_DIR, file) });
  const vp = page.viewportSize();
  const l = Math.max(0, Math.min(...rects.map((r) => r.l)) - pad);
  const t = Math.max(0, Math.min(...rects.map((r) => r.t)) - pad);
  const r = Math.min(vp.width, Math.max(...rects.map((x) => x.r)) + pad);
  const b = Math.min(vp.height, Math.max(...rects.map((x) => x.b)) + pad);
  await page.screenshot({ path: resolve(OUT_DIR, file), clip: { x: l, y: t, width: r - l, height: b - t } });
}
async function shotFull(page, file) {
  if (!SHOTS) return;
  mkdirSync(OUT_DIR, { recursive: true });
  await page.screenshot({ path: resolve(OUT_DIR, file) });
}

/** 툴팁 프로브: 포인터가 단추 안으로 들어온 시각과 툴팁이 DOM 에 들어온 시각을 같은 시계(performance.now)로 적는다. */
async function armTooltipProbe(page) {
  await page.evaluate(() => {
    window.__tip = { over: [], shown: [] };
    if (window.__tipObs) window.__tipObs.disconnect();
    if (window.__tipOver) document.removeEventListener("pointerover", window.__tipOver, true);
    window.__tipOver = (e) => {
      const item = e.target instanceof Element ? e.target.closest("[data-toolbar-item]") : null;
      if (item) window.__tip.over.push({ t: performance.now(), id: item.getAttribute("data-testid") });
    };
    document.addEventListener("pointerover", window.__tipOver, true);
    window.__tipObs = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (!(n instanceof Element)) continue;
          const tip = n.matches('[data-testid="tooltip"]') ? n : n.querySelector('[data-testid="tooltip"]');
          if (tip) window.__tip.shown.push({ t: performance.now(), text: tip.textContent });
        }
      }
    });
    window.__tipObs.observe(document.body, { childList: true, subtree: true });
  });
}
const readTooltipProbe = (page) => page.evaluate(() => ({ over: window.__tip.over, shown: window.__tip.shown, now: document.querySelectorAll('[data-testid="tooltip"]').length }));

async function center(page, testId) {
  const box = await page.locator(`[data-testid="${testId}"]`).first().boundingBox({ timeout: 3000 }).catch(() => null);
  return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
}

/** 행 안의 우클릭 자리 둘: 글자 없는 자리(행 자신이 맞는 점)와 글자 위(본문 첫 글 노드의 가운데 쪽). */
async function rowSpots(page, id) {
  return page.evaluate((id) => {
    const rowEl = document.querySelector(`[data-testid="timeline-message"][data-message-id="00000000-0000-7000-8000-0000000b${id}"]`);
    const r = rowEl.getBoundingClientRect();
    const body = rowEl.querySelector("[data-row-body]") ?? rowEl;
    let text = null;
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode() && text === null) {
      const node = walker.currentNode;
      if (!(node.textContent || "").trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const b = range.getBoundingClientRect();
      if (b.width > 0) text = { x: b.left + Math.min(b.width / 2, 60), y: b.top + b.height / 2 };
    }
    // 글자 없는 자리: 행 자신(`article`)이 맞는 점을 오른쪽부터 훑어 고른다. 가장자리 점은 엔진에 따라 스크롤바나 스크롤러가 가져간다
    // (WebKit 에서 실제로 그랬다). 행의 안쪽 여백·거터와 본문 사이 틈이 이 점이 된다.
    let empty = null;
    for (let x = r.right - 4; x > r.left + 4 && empty === null; x -= 4) {
      if (document.elementFromPoint(x, r.top + 20) === rowEl) empty = { x, y: r.top + 20 };
    }
    return { empty, text };
  }, id);
}

async function runKind(page, tag, k, shotTag) {
  const name = `${tag} ${k.name}`;
  const row = await hoverRow(page, k);

  // ---- 도구 막대 ----------------------------------------------------------------
  const bar = await rectOf(page, '[data-testid="message-hover-toolbar"]');
  check(`${name}: 호버로 도구 막대가 선다(화면에 하나만)`, bar !== null && (await toolbarCount(page)) === 1, `count=${await toolbarCount(page)}`);
  note(`도구 막대 상자 ${bar ? `${bar.w}×${bar.h}` : "없음"}`);
  const widthMax = k.own ? TOOLBAR_MAX_WIDTH_OWN : TOOLBAR_MAX_WIDTH;
  check(`${name}: 도구 막대 너비가 한계(${k.own ? "연필 포함 257" : "223"}px)를 넘지 않았다(막대를 키우면 좁은 판 겹침 #4231 1번이 커진다)`, bar !== null && bar.w <= widthMax, `w=${bar?.w} 한계=${widthMax}`);
  // 고치기 연필(#5326)은 내 메시지의 도구 막대에만 선다: 내 행은 단추 7개(반응 3 · 더하기 · 답글 · 연필 · ⋮), 남의·에이전트 행은 6개(연필 없음).
  const itemCount = await row.locator('[data-testid="message-hover-toolbar"] [data-toolbar-item]').count();
  const pencilCount = await row.locator('[data-testid="toolbar-edit"]').count();
  check(`${name}: 도구 막대 단추는 ${k.own ? "7개(고치기 연필 있음)" : "6개(고치기 연필 없음)"}다`, itemCount === (k.own ? 7 : 6) && pencilCount === (k.own ? 1 : 0), `count=${itemCount} pencil=${pencilCount}`);
  if (k.own) {
    const pencil = await glyphs(row.locator('[data-testid="toolbar-edit"]'));
    check(`${name}: 연필 단추의 아이콘은 연필이다`, pencil[0] === "lucide-pencil", `pencil=${pencil}`);
  }
  const trigger = row.locator('[data-testid="message-actions-trigger"]');
  const dots = await glyphs(trigger);
  const more = await glyphs(row.locator('[data-testid="toolbar-react-more"]'));
  const reply = await glyphs(row.locator('[data-testid="toolbar-reply"]'));
  check(`${name}: 더 많은 기능은 세로 점(⋮), 반응 더하기는 +가 붙은 얼굴`, dots[0] === "lucide-ellipsis-vertical" && more[0] === "lucide-smile-plus", `dots=${dots} more=${more} reply=${reply}`);
  note(`아이콘: 더 많은 기능 ${dots} · 반응 더하기 ${more} · 답글 ${reply}`);
  await shotAround(page, `1-toolbar-${k.kind}-${shotTag}.png`, ['[data-testid="message-hover-toolbar"]'], 40);

  // ---- ⋮ 메뉴 (포인터) ---------------------------------------------------------
  await trigger.click({ timeout: 3000 }).catch(() => {});
  const opened = await page.locator('[data-testid="message-action-menu"]').waitFor({ state: "visible", timeout: 3000 }).then(() => true, () => false);
  check(`${name}: ⋮ 를 누르면 메뉴가 열린다`, opened);
  await page.waitForTimeout(250);
  const seq = (await menuSequence(page, "message-action-menu", "menu-")) ?? [];
  // 내 글 메시지: 고치기가 첫 줄(Buzz와 같다), 지우기는 구분선 아래 혼자 맨 아래. 남의·에이전트 메시지에는 고치기·지우기가 없다.
  const wantOther = ["quote", "pin", "remind", "mark-unread", "|", "copy", "copy-link"];
  const want = k.own ? ["edit", "quote", "pin", "remind", "mark-unread", "|", "copy", "copy-link", "|", "delete"] : wantOther;
  note(`메뉴 순서: ${seq.join(" ")}`);
  check(`${name}: 메뉴는 짧은 목록이다(고치기 첫 줄, 묶음 사이에만 구분선, 지우기는 혼자 맨 아래)`, JSON.stringify(seq) === JSON.stringify(want), `want=${want.join(" ")} got=${seq.join(" ")}`);
  const noRepeat = await page.evaluate(() => {
    const menu = document.querySelector('[data-testid="message-action-menu"]');
    if (!menu) return null;
    return {
      reactions: menu.querySelectorAll('[data-testid^="menu-react"]').length,
      reply: menu.querySelectorAll('[data-testid="menu-reply"]').length,
      strip: menu.querySelectorAll('[aria-label="빠른 반응"]').length,
      text: menu.textContent,
    };
  });
  check(`${name}: 메뉴 안에 반응 줄·다른 반응 고르기·답글이 없다`, noRepeat && noRepeat.reactions === 0 && noRepeat.reply === 0 && noRepeat.strip === 0 && !/다른 반응 고르기|답글 달기/.test(noRepeat.text), JSON.stringify(noRepeat));
  const rows = await page.evaluate(() => {
    const menu = document.querySelector('[data-testid="message-action-menu"]');
    if (!menu) return null;
    const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));
    const probe = document.createElement("i");
    probe.setAttribute("style", "color:var(--danger)");
    document.body.append(probe);
    const danger = getComputedStyle(probe).color;
    probe.remove();
    const colorOf = (id) => { const el = menu.querySelector(`[data-testid="${id}"]`); return el ? getComputedStyle(el).color : null; };
    return {
      count: items.length,
      heights: [...new Set(items.map((el) => Math.round(el.getBoundingClientRect().height)))],
      svgPerRow: items.map((el) => el.querySelectorAll("svg").length),
      danger,
      deleteColor: colorOf("menu-delete"),
      quoteColor: colorOf("menu-quote"),
    };
  });
  if (rows) {
    note(`행 ${rows.count}개 · 행 높이 ${rows.heights} · 행당 아이콘 ${[...new Set(rows.svgPerRow)]}`);
    check(`${name}: 위험 동작은 지우기뿐이고 위험색이다`, k.own ? rows.deleteColor === rows.danger && rows.quoteColor !== rows.danger : rows.deleteColor === null, JSON.stringify(rows));
    check(`${name}: 행마다 아이콘이 정확히 하나`, rows.svgPerRow.every((n) => n === 1), JSON.stringify(rows.svgPerRow));
  }
  const menuRect = await rectOf(page, '[data-testid="message-action-menu"]');
  const paneRect = await rectOf(page, "main");
  const vp = page.viewportSize();
  if (menuRect) {
    const inWindow = menuRect.l >= 0 && menuRect.r <= vp.width && menuRect.t >= 0 && menuRect.b <= vp.height;
    const inPane = paneRect ? menuRect.l >= paneRect.l - 0.5 && menuRect.r <= paneRect.r + 0.5 : true;
    check(`${name}: 메뉴가 창 안(위아래 포함)과 본문 판 안(가로)에 머문다`, inWindow && inPane, `menu=${JSON.stringify(menuRect)} pane=${JSON.stringify(paneRect)} vp=${vp.width}x${vp.height}`);
    note(`메뉴 상자 x ${Math.round(menuRect.l)}~${Math.round(menuRect.r)} y ${Math.round(menuRect.t)}~${Math.round(menuRect.b)} (${Math.round(menuRect.w)}×${Math.round(menuRect.h)}) · 판 x ${paneRect ? `${Math.round(paneRect.l)}~${Math.round(paneRect.r)}` : "?"}`);
  }
  await shotAround(page, `2-menu-${k.kind}-${shotTag}.png`, ['[data-testid="message-hover-toolbar"]', '[data-testid="message-action-menu"]'], 32);
  if (k.kind === "me") await shotFull(page, `2-menu-${k.kind}-full-${shotTag}.png`);
  await page.keyboard.press("Escape");
  await page.locator('[data-testid="message-action-menu"]').waitFor({ state: "hidden", timeout: 3000 }).catch(() => {});

  // ---- 우클릭 메뉴: ⋮ 와 같은 목록 ----------------------------------------------
  // 두 자리를 따로 잰다. (a) 글자가 없는 자리(행의 오른쪽 안쪽 여백): 어느 엔진에서나 앱 메뉴가 열려야 한다.
  // (b) 글자 위: Chromium 은 앱 메뉴가 열린다. macOS WebKit(WKWebView 의 엔진)은 우클릭한 낱말을 먼저 선택하고, 이 행 안의 펼친 선택은
  // 앱 메뉴가 브라우저 기본 메뉴에 양보하는 설계(`selectionIsWithinRow`)다. 그래서 WebKit 의 (b)는 「열렸거나, 설계된 양보」면 통과다.
  // 변경 전 번들에서도 똑같다(진단 `probe-webkit-rightclick.mjs`): 이 변경이 만든 동작이 아니다.
  const spots = await rowSpots(page, k.id);
  const clearSelection = async () => {
    await page.evaluate(() => document.getSelection()?.removeAllRanges());
    await page.waitForTimeout(120);
  };
  const rightClick = async (spot) => {
    await page.mouse.move(2, 2);
    await clearSelection();
    // 누르기 전에 그 자리에 무엇이 있는지(진단): 행 안인지, 어떤 요소인지.
    const hit = await page.evaluate(({ x, y, id }) => {
      const rowEl = document.querySelector(`[data-testid="timeline-message"][data-message-id="00000000-0000-7000-8000-0000000b${id}"]`);
      const el = document.elementFromPoint(x, y);
      return el ? `${el.tagName.toLowerCase()}[${el.getAttribute("data-testid") ?? ""}] 행 안=${rowEl ? rowEl.contains(el) : false}` : "(없음)";
    }, { x: spot.x, y: spot.y, id: k.id });
    // contextmenu 처리가 **끝난 바로 그 순간**(모든 핸들러 뒤, 메뉴가 포커스를 가져가기 전)의 선택을 읽는다. 메뉴가 열리며 포커스가 옮겨 가면
    // 엔진의 낱말 선택이 저절로 풀리는 엔진이 있어서, 나중에 읽으면 「앱이 지웠는지」 「저절로 풀렸는지」를 못 가른다(사보타주로 확인).
    await page.evaluate(() => {
      window.__selAtCtx = null;
      document.addEventListener("contextmenu", () => { setTimeout(() => { window.__selAtCtx = document.getSelection()?.toString() ?? ""; }, 0); }, { once: true, capture: true });
    });
    await page.mouse.click(spot.x, spot.y, { button: "right" });
    const opened = await page.locator('[data-testid="message-context-menu"]').waitFor({ state: "visible", timeout: 1500 }).then(() => true, () => false);
    // setTimeout(0) 이 읽기보다 늦으면 null 이 읽힌다(부하에서 한 번 그랬다): 채워질 때까지 기다린 뒤 읽는다. 값이 "" 가 아니면 아래 단정이 그대로 잡는다.
    await page.waitForFunction(() => window.__selAtCtx !== null, null, { timeout: 2000 }).catch(() => {});
    const selAtCtx = await page.evaluate(() => window.__selAtCtx);
    const sequence = (await menuSequence(page, "message-context-menu", "context-")) ?? [];
    const sel = await page.evaluate((id) => {
      const rowEl = document.querySelector(`[data-message-id="00000000-0000-7000-8000-0000000b${id}"]`);
      const sel = document.getSelection();
      return { text: sel?.toString() ?? "", yielded: Boolean(sel && !sel.isCollapsed && rowEl && sel.anchorNode && rowEl.contains(sel.anchorNode)) };
    }, k.id);
    await page.keyboard.press("Escape");
    await page.locator('[data-testid="message-context-menu"]').waitFor({ state: "hidden", timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(150);
    // 메뉴가 닫힌 뒤(우리가 선택을 지우기 전)의 상태: 엔진이 만든 낱말 선택이 남아 있으면 안 되고, 포인터가 아직 행 위라서 호버 도구 막대가
    // 그대로 서야 한다(선택이 있는 동안 숨는 도구 막대가 돌아오는지).
    const after = await page.evaluate((id) => {
      const rowEl = document.querySelector(`[data-testid="timeline-message"][data-message-id="00000000-0000-7000-8000-0000000b${id}"]`);
      return { selAfter: document.getSelection()?.toString() ?? "", barAfter: rowEl ? rowEl.querySelectorAll('[data-testid="message-hover-toolbar"]').length : -1 };
    }, k.id);
    await clearSelection();
    return { opened, sequence, hit, selAtCtx, ...sel, ...after };
  };
  const sameList = (r) => r.opened && JSON.stringify(r.sequence) === JSON.stringify(seq);
  check(`${name}: 글자 없는 자리를 찾았다(행 자신이 맞는 점)`, spots.empty !== null);
  const emptyHit = spots.empty ? await rightClick(spots.empty) : { opened: false, sequence: [], hit: "(자리 없음)", text: "", yielded: false };
  check(`${name}: 우클릭(글자 없는 자리)이 열리고 ⋮ 메뉴와 같은 목록·같은 순서다`, sameList(emptyHit), `⋮=${seq.join(" ")} 우클릭=${emptyHit.sequence.join(" ")} 그 자리=${emptyHit.hit} 선택=${JSON.stringify(emptyHit.text)}`);
  if (k.kind === "me" && emptyHit.opened && spots.empty) {
    await page.mouse.move(2, 2);
    await clearSelection();
    await page.mouse.click(spots.empty.x, spots.empty.y, { button: "right" });
    await page.locator('[data-testid="message-context-menu"]').waitFor({ state: "visible", timeout: 1500 }).catch(() => {});
    await page.waitForTimeout(250);
    await shotAround(page, `3-context-${k.kind}-${shotTag}.png`, ['[data-testid="message-context-menu"]'], 40);
    await page.keyboard.press("Escape");
    await page.locator('[data-testid="message-context-menu"]').waitFor({ state: "hidden", timeout: 3000 }).catch(() => {});
    await clearSelection();
  }
  if (spots.text) {
    // 글자 위 우클릭: **모든 엔진에서** 앱 메뉴가 열린다. macOS WebKit(WKWebView 의 엔진)은 우클릭한 낱말을 contextmenu 직전에 스스로
    // 고르는데, 예전 규칙은 그 선택을 사용자가 고른 것으로 읽고 기본 메뉴에 양보했다(앱 메뉴가 안 열림, #5192).
    const textHit = await rightClick(spots.text);
    check(`${name}: 우클릭(글자 위)도 열리고 ⋮ 메뉴와 같은 목록이다`, sameList(textHit), `opened=${textHit.opened} 선택=${JSON.stringify(textHit.text)} 양보=${textHit.yielded} 우클릭=${textHit.sequence.join(" ")}`);
    check(`${name}: 우클릭(글자 위) 뒤 엔진이 만든 낱말 선택이 남지 않는다(contextmenu 처리 직후 · 메뉴가 열린 동안 · 닫은 뒤 모두 비어 있다)`, textHit.selAtCtx === "" && textHit.text === "" && textHit.selAfter === "", `직후=${JSON.stringify(textHit.selAtCtx)} 메뉴 열린 동안=${JSON.stringify(textHit.text)} 닫은 뒤=${JSON.stringify(textHit.selAfter)}`);
    check(`${name}: 우클릭(글자 위)로 메뉴를 닫은 뒤 호버 도구 막대가 그대로 선다(선택에 눌려 숨지 않음)`, textHit.barAfter === 1, `barAfter=${textHit.barAfter}`);
  }

  // ---- 겹침: 도구 막대 ∩ 이웃 글자 = 0 -----------------------------------------
  await hoverRow(page, k);
  let verdict = "";
  try {
    await assertHoverToolbarClearsBodyText(page, name);
  } catch (error) {
    verdict = String(error?.message ?? error).split("\n")[0].slice(0, 230);
  }
  const ov = await measureHoverToolbarOverlap(page);
  note(`겹침 자: 최악 ${ov[0] ? `${ov[0].neighbor}/${ov[0].kind} seq ${ov[0].seq} ${ov[0].chars}자(${ov[0].area}px²)` : "-"}`);
  const worstChars = ov.reduce((max, item) => Math.max(max, item.chars), 0);
  if (page.viewportSize().width >= WIDE_PANE_MIN_VIEWPORT) {
    check(`${name}: 도구 막대 ∩ 이웃(행·시스템 줄) 글자 = 0`, verdict === "", verdict);
  } else {
    // 프로브(단정 아님): 좁은 열의 겹침은 #4231 1번의 기존 결함이고 값이 실행마다 흔들린다(위 TOOLBAR_MAX_WIDTH 주석).
    note(`프로브(#4231 1번, 기존, 단정 아님): 덮는 이웃 글자 ${worstChars}자 · ${verdict === "" ? "겹침 없음" : verdict}`);
  }
  await page.mouse.move(2, 2);
  await page.waitForTimeout(200);
  void row;
}

/**
 * 사용자가 우클릭 **전에** 고른 선택(더블클릭)은 여전히 브라우저 기본 메뉴에 양보한다(복사 등): 앱 메뉴가 안 열리고, 선택이 남고,
 * contextmenu 가 preventDefault 되지 않는다(= 기본 메뉴가 뜰 자격). 두 엔진 모두, 세 종류 행 모두. #5192 가 「엔진이 만든 선택」을
 * 양보에서 빼면서 **이 보존해야 할 동작을 같이 깨뜨리지 않았는지** 재는 단정이다. 앞 장면의 네이티브 메뉴 잔상에 기대지 않도록 새
 * 컨텍스트에서 따로 돈다.
 */
async function runSelectionYield(page, tag, k) {
  const name = `${tag} ${k.name}`;
  await page.mouse.move(2, 2);
  await rowOf(page, k.id).scrollIntoViewIfNeeded();
  const spots = await rowSpots(page, k.id);
  if (!spots.text) { check(`${name}: 글자 위 자리를 찾았다`, false); return; }
  await page.mouse.dblclick(spots.text.x, spots.text.y);
  const picked = await page.evaluate(() => document.getSelection()?.toString() ?? "");
  await page.evaluate(() => {
    window.__ctxPrevented = null;
    document.addEventListener("contextmenu", (event) => { setTimeout(() => { window.__ctxPrevented = event.defaultPrevented; }, 0); }, { once: true, capture: true });
  });
  await page.mouse.click(spots.text.x, spots.text.y, { button: "right" });
  await page.waitForTimeout(400);
  const got = await page.evaluate(() => ({
    menu: document.querySelectorAll('[data-testid="message-context-menu"]').length,
    sel: document.getSelection()?.toString() ?? "",
    prevented: window.__ctxPrevented,
  }));
  note(`고른 선택 위 우클릭: 고른 글 ${JSON.stringify(picked)} · 앱 메뉴 ${got.menu} · 남은 선택 ${JSON.stringify(got.sel)} · preventDefault ${got.prevented}`);
  check(`${name}: 고른 선택(더블클릭) 위 우클릭은 기본 메뉴에 양보한다(앱 메뉴 안 열림 · 선택 유지 · preventDefault 안 함)`, picked.trim() !== "" && got.menu === 0 && got.sel === picked && got.prevented === false, `고른 글=${JSON.stringify(picked)} 앱 메뉴=${got.menu} 선택=${JSON.stringify(got.sel)} preventDefault=${got.prevented}`);
}

/** 키보드: 행에 초점 → Tab 으로 ⋮ → 툴팁 즉시 → Enter 로 열기 → 방향키 → Esc 가 초점을 ⋮ 로 돌려준다. 세 종류의 행 모두. */
async function runKeyboard(page, tag, k) {
  const name = `${tag} ${k.name} 키보드`;
  await page.mouse.move(2, 2);
  await page.waitForTimeout(250);
  await armTooltipProbe(page);
  await rowOf(page, k.id).scrollIntoViewIfNeeded();
  await rowOf(page, k.id).focus();
  await page.keyboard.press("Tab");
  const t0 = await page.evaluate(() => performance.now());
  await page.waitForFunction(() => document.querySelector('[data-testid="tooltip"]') !== null, null, { timeout: 1500 }).catch(() => {});
  const probe = await readTooltipProbe(page);
  const onTrigger = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
  check(`${name}: Tab 으로 ⋮ 에 닿는다`, onTrigger === "message-actions-trigger", `active=${onTrigger}`);
  const first = probe.shown[0];
  check(`${name}: 키보드 초점의 툴팁은 즉시 뜬다(≤ 60ms)`, first && first.t - t0 <= 60, `shown=${JSON.stringify(probe.shown)} t0=${t0}`);
  await page.keyboard.press("Enter");
  const opened = await page.locator('[data-testid="message-action-menu"]').waitFor({ state: "visible", timeout: 3000 }).then(() => true, () => false);
  check(`${name}: Enter 로 메뉴가 열린다`, opened);
  await page.waitForTimeout(250);
  const focused = async () => page.evaluate(() => {
    const el = document.activeElement;
    return el ? { id: el.getAttribute("data-testid"), role: el.getAttribute("role") } : null;
  });
  const f1 = await focused();
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(120);
  const f2 = await focused();
  check(`${name}: 방향키가 메뉴 항목 사이를 돈다`, f1?.role === "menuitem" && f2?.role === "menuitem" && f1.id !== f2.id, `${JSON.stringify(f1)} -> ${JSON.stringify(f2)}`);
  await page.keyboard.press("Escape");
  await page.locator('[data-testid="message-action-menu"]').waitFor({ state: "hidden", timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(150);
  const back = await focused();
  check(`${name}: Esc 가 메뉴를 닫고 초점을 ⋮ 로 돌려준다`, back?.id === "message-actions-trigger", JSON.stringify(back));
  await page.keyboard.press("Escape");
  await page.mouse.move(2, 2);
  await page.waitForTimeout(200);
}

/** 툴팁 시간: 처음 · 옮겨 감 · 빠른 통과. */
async function runTooltipTiming(page, tag, shotTag) {
  const k = KINDS[0];
  const name = `${tag} 툴팁`;
  await hoverRow(page, k);
  await page.mouse.move(2, 2);
  await page.waitForTimeout(700); // 무리가 쉬게: 옮겨 다님 창(300)이 지난 뒤
  const rowBox = await rowOf(page, k.id).boundingBox();
  await rowOf(page, k.id).hover({ position: { x: 120, y: 24 } });
  await rowOf(page, k.id).locator('[data-testid="message-hover-toolbar"]').waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(700);
  await armTooltipProbe(page);

  // 1) 처음: 반응 더하기 단추를 가리킨다.
  const a = await center(page, "toolbar-react-more");
  const b = await center(page, "toolbar-reply");
  const c = await center(page, "message-actions-trigger");
  if (!a || !b || !c) {
    check(`${name}: 도구 막대 단추를 찾았다`, false, `${a} ${b} ${c}`);
    return;
  }
  await page.mouse.move(a.x, a.y);
  await page.waitForTimeout(450);
  let p = await readTooltipProbe(page);
  const overA = p.over.filter((o) => o.id === "toolbar-react-more").at(-1);
  const shownA = p.shown[0];
  const firstMs = overA && shownA ? shownA.t - overA.t : null;
  note(`처음 가리킨 뒤 툴팁까지 ${firstMs === null ? "(안 뜸)" : `${Math.round(firstMs)}ms`}`);
  check(`${name}: 처음 가리키면 ${FIRST_TIP_MAX_MS}ms 안에 선다`, firstMs !== null && firstMs <= FIRST_TIP_MAX_MS, `firstMs=${firstMs}`);
  await shotAround(page, `4-tooltip-first-${shotTag}.png`, ['[data-testid="message-hover-toolbar"]', '[data-testid="tooltip"]'], 40);

  // 2) 옮겨 감: 옆 단추(답글)로 가면 바로 서고, 앞 툴팁은 사라져 하나만 있다.
  await armTooltipProbe(page);
  await page.mouse.move(b.x, b.y);
  await page.waitForTimeout(300);
  p = await readTooltipProbe(page);
  const overB = p.over.filter((o) => o.id === "toolbar-reply").at(-1);
  const shownB = p.shown[0];
  const hopMs = overB && shownB ? shownB.t - overB.t : null;
  note(`옆 단추로 옮긴 뒤 툴팁까지 ${hopMs === null ? "(안 뜸)" : `${Math.round(hopMs)}ms`} · 지금 떠 있는 툴팁 ${p.now}개`);
  check(`${name}: 옆 단추로 옮기면 ${HOP_TIP_MAX_MS}ms 안에 서고 하나만 떠 있다`, hopMs !== null && hopMs <= HOP_TIP_MAX_MS && p.now === 1, `hopMs=${hopMs} now=${p.now}`);

  // 3) 한 칸 더 옮겨도(⋮) 같다.
  await armTooltipProbe(page);
  await page.mouse.move(c.x, c.y);
  await page.waitForTimeout(300);
  p = await readTooltipProbe(page);
  const overC = p.over.filter((o) => o.id === "message-actions-trigger").at(-1);
  const shownC = p.shown[0];
  const hop2 = overC && shownC ? shownC.t - overC.t : null;
  check(`${name}: 한 칸 더(⋮)도 ${HOP_TIP_MAX_MS}ms 안에 선다`, hop2 !== null && hop2 <= HOP_TIP_MAX_MS && p.now === 1, `hop2=${hop2} now=${p.now}`);

  // 4) 쉰 뒤(창 300 지남)에는 다시 처음 지연이다: 지연 전엔 없다.
  await page.mouse.move(rowBox.x + 160, rowBox.y + rowBox.height - 6);
  await page.waitForTimeout(800);
  await armTooltipProbe(page);
  await page.mouse.move(a.x, a.y);
  await page.waitForTimeout(30);
  const early = await page.evaluate(() => document.querySelectorAll('[data-testid="tooltip"]').length);
  await page.waitForTimeout(400);
  p = await readTooltipProbe(page);
  check(`${name}: 한참 쉰 뒤에는 처음 지연을 다시 기다린다(30ms 시점에는 없고, 뒤에는 선다)`, early === 0 && p.now === 1, `early=${early} now=${p.now}`);

  // 5) 빠른 통과: 도구 막대를 빠르게 훑고 나가면 하나도 안 뜬다.
  await page.mouse.move(rowBox.x + 160, rowBox.y + rowBox.height - 6);
  await page.waitForTimeout(800);
  await armTooltipProbe(page);
  await page.mouse.move(a.x - 30, a.y);
  await page.mouse.move(c.x + 30, c.y, { steps: 14 });
  await page.mouse.move(rowBox.x + 160, rowBox.y + rowBox.height - 6);
  await page.waitForTimeout(500);
  p = await readTooltipProbe(page);
  check(`${name}: 빠른 통과는 하나도 안 뜬다`, p.shown.length === 0, `shown=${JSON.stringify(p.shown)}`);
  await page.mouse.move(2, 2);
  await page.waitForTimeout(200);
}

async function runViewport(browserType, origin, scheme, width, height) {
  const tag = `${width} ${scheme}`;
  const shotTag = `${width}-${scheme}`;
  const browser = await browserType.launch();
  console.log(`--- ${tag} (${ENGINE})`);
  // 장면마다 새 컨텍스트: 앞 장면의 초점·선택·떠 있는 툴팁·남은 도구 막대가 다음 장면을 오염시키지 않는다(WebKit 에서 실제로 그랬다).
  const scene = async (fn) => {
    const { context, page } = await open(browser, origin, scheme, width, height);
    try {
      await fn(page);
    } finally {
      await context.close();
    }
  };
  try {
    for (const k of KINDS) await scene((page) => runKind(page, tag, k, shotTag));
    for (const k of KINDS) await scene((page) => runSelectionYield(page, tag, k));
    await scene((page) => runTooltipTiming(page, tag, shotTag));
    for (const k of KINDS) {
      await scene(async (page) => {
        await runKeyboard(page, tag, k);
        check(`${tag} ${k.name}: 문서 가로 넘침 0`, (await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 0);
      });
    }
  } finally {
    await browser.close();
  }
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
  const browserType = ENGINE === "webkit" ? webkit : chromium;
  try {
    // ONLY=1440-light,900-dark 처럼 칸을 고를 수 있다(손으로 고칠 때). 기본은 네 칸 전부다.
    const only = process.env.ONLY ? process.env.ONLY.split(",") : null;
    for (const scheme of ["light", "dark"]) {
      for (const [width, height] of [[1440, 900], [900, 800]]) {
        if (only && !only.includes(`${width}-${scheme}`)) continue;
        await runViewport(browserType, preview.origin, scheme, width, height);
      }
    }
  } finally {
    await preview.stop?.();
  }
  const bad = results.filter((r) => !r.ok);
  console.log(
    bad.length === 0
      ? `MESSAGE-ACTIONS-5192 PASS (${results.length} checks, ${ENGINE})`
      : `MESSAGE-ACTIONS-5192 FAIL (${bad.length}/${results.length}, ${ENGINE})`
  );
  process.exit(bad.length === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
