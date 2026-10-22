#!/usr/bin/env node
// =============================================================================
// 글자 크기 3단 · 대화 밀도 3단의 증거 (AP-2a #4189, 이슈 AC 4·5): 실제 앱 번들을 실제 크로미움에서
// 돌려 같은 대화 화면을 단계마다 찍고, 단계마다 **잰 숫자**를 meta.json에 남긴다.
//
//   npm run build && cp -R dist artifacts/dist-before      (변경 전 HEAD에서, 번들만 보관)
//   ... 변경 ...
//   npm run build
//   ONLY=default LABEL=before DIST=artifacts/dist-before node scripts/capture-4189.mjs
//   LABEL=after DIST=dist node scripts/capture-4189.mjs
//   MODE=diff BEFORE=artifacts/ap2a-4189/before AFTER=artifacts/ap2a-4189/after node scripts/capture-4189.mjs
//
// 장면(라이트·다크 각각):
//   · 기본(저장값 없음) 1440·390 — 변경 전 번들과 **픽셀이 같아야** 한다(기본 모양은 안 바뀐다).
//   · 글자 크기 작게·기본·크게 × 1440 (밀도는 기본)
//   · 대화 밀도 촘촘·편하게·여유 × 1440 (글자는 기본)
//   · 극단 둘(작게+촘촘·크게+여유) × 1440, 크게+여유 × 390 — 컨트롤·글자가 틀 안에 담기는지(AC 5)
//   · 설정 > 모양 × (기본·극단 둘) × 1440, (기본·크게+여유) × 390 — 새 컨트롤과 대화 미리보기
//
// 거짓 0·거짓 통과를 막는 장치:
//   · 기본 장면을 변경 전·후 번들로 찍어 픽셀을 비교한다. 같은 번들을 두 번 찍어 서로 비교하는 길도
//     있다(`LABEL=after-b`): 찍을 때마다 흔들리는 화면이면 0이 아무것도 증명하지 못한다.
//   · 단계마다 DOM에서 실제로 잰다(본문 글자·줄 높이·아바타 한 변·행 사이·묶음 사이·문단 사이·목록 항목
//     사이). 속성만 바꾸고 화면이 안 바뀐 장면은 이 숫자가 기본과 같아 드러난다.
//   · 담김(clipping) 점검: 높이가 고정된 컨트롤 안의 글자가 상자보다 높은 요소를 단계마다 센다. 기본
//     단계에도 있던 것은 이 변경의 몫이 아니라서 「기본에 없고 이 단계에만 있는」 요소를 따로 적는다.
//   · 단계 사이의 화면이 서로 다른지 비교한다(`MODE=diff`의 구별 점검).
//
// 백엔드 없이 `/v1/**` 고정 응답 + 가짜 소켓. 벽시계·로케일·시간대를 고정한다.
// =============================================================================
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = process.env.WEB_ROOT
  ? resolve(process.env.WEB_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODE = process.env.MODE || "capture";
const LABEL = process.env.LABEL || "after";
const DIST = process.env.DIST || "dist";
const ONLY = process.env.ONLY || "all";
// ENGINE=webkit: 사파리·WKWebView의 엔진으로도 같은 장면을 찍는다(`ONLY=smoke`와 함께 쓰는 보조 증거).
const ENGINE = process.env.ENGINE === "webkit" ? webkit : chromium;
const OUT_ROOT = process.env.OUT_ROOT
  ? resolve(process.env.OUT_ROOT)
  : resolve(WEB_ROOT, "artifacts/ap2a-4189");
const PORT = Number(process.env.CAPTURE_PORT || 5389);

const APPEARANCE_ENTRY = "momo.web.appearance.v2";
const FIXTURE_NOW = Date.parse("2026-10-21T09:30:00+09:00");
const SCHEMES = ["light", "dark"];
const V1440 = { name: "1440", width: 1440, height: 900 };
const V390 = { name: "390", width: 390, height: 844 };
// 설정 쪽은 「대화 표시」 카드(행 셋 + 대화 미리보기)가 한 화면에 다 들어오게 세로를 늘린다.
const V1440_TALL = { name: "1440", width: 1440, height: 1500 };
const V390_TALL = { name: "390", width: 390, height: 2300 };

const MIN = 60_000;
const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const agentId = "00000000-0000-7000-8000-000000000301";
const CH = "00000000-0000-7000-8000-000000000201";
const GENERAL = "00000000-0000-7000-8000-000000000202";
const P = (n) => `00000000-0000-7000-8000-0000000001${n}`;
const person = (id, kind, displayName, handle, extra = {}) => ({
  id, workspaceId, kind, status: "active", displayName, handle, channelCount: 2,
  channelIds: [CH, GENERAL], capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...extra,
});
const roster = [
  person(memberId, "human", "곽성재", "seongjae", { role: "owner" }),
  person(P("11"), "human", "이도현", "dohyun"),
  person(P("12"), "human", "박서연", "seoyeon"),
  person(P("13"), "human", "최민수", "minsu"),
  person(P("15"), "human", "정하윤", "hayun"),
  person(agentId, "agent", "그록", "grok", { ownerHumanId: memberId }),
];
const channels = [
  { id: CH, workspaceId, kind: "public", name: "계획", muted: false },
  { id: GENERAL, workspaceId, kind: "public", name: "general", muted: false },
];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: "ws://ap2a-4189-capture.invalid/connection/websocket",
};
const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

// 한 사람이 연달아 쓴 행(이어지는 행), 사람이 바뀌는 자리, 문단 둘과 목록이 든 에이전트 답을 모두 담는다.
const AGENT_REPLY = [
  "요약해 둘게요.",
  "이번 주 일정은 세 가지예요.",
  "- 월요일 배포 점검\n- 수요일 디자인 리뷰\n- 금요일 회고",
  "더 필요한 게 있으면 말씀해 주세요.",
].join("\n\n");

function messageRows() {
  const m = (n, author, body, ago) => ({
    id: `00000000-0000-7000-8000-0000000a00${String(n).padStart(2, "0")}`,
    channelId: CH, seq: 10 + n, hlcTs: FIXTURE_NOW - ago, hlcCount: 0, authorMemberId: author,
    type: "text", body, state: "sent", createdAtMs: FIXTURE_NOW - ago,
  });
  return [
    m(1, P("11"), "주간 회의 자료 올렸어요. 3쪽 숫자만 같이 봐 주세요.", 42 * MIN),
    m(2, P("11"), "표 이름은 매출 주간으로 바꿨어요.", 41 * MIN),
    m(3, P("11"), "어제 회의 메모도 같이 올려 뒀어요.", 40 * MIN),
    m(4, P("12"), "확인했어요. 매출 표는 다시 계산해서 올릴게요.", 38 * MIN),
    m(5, P("13"), "저는 일정 쪽을 맡을게요. 배포 전날 점검은 제가 해요.", 31 * MIN),
    m(6, P("15"), "디자인 시안은 내일 오전에 공유해요. Figma 링크는 그때 붙일게요.", 24 * MIN),
    m(7, agentId, AGENT_REPLY, 12 * MIN),
    m(8, memberId, "이번 주 일정 정리해 줘", 4 * MIN),
  ];
}

async function installRoutes(context) {
  await context.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: FIXTURE_NOW + 600_000, ttlSeconds: 60, workspaceId, memberId });
    }
    if (/\/inbox(\/|$)/.test(path)) return json(route, { error: { code: "not_found", message: "not found" } }, 404);
    if (path.endsWith("/agent-runs/progress")) return json(route, { runs: [] });
    if (/\/agents\/([^/]+)\/liveness$/.test(path)) return json(route, { error: { code: "not_found", message: "not found" } }, 404);
    if (path.endsWith("/hosted-agent-connections") && method === "GET") return json(route, { connections: [] });
    if (path.endsWith("/allowed-models")) return json(route, { allowedAgentModels: [] });
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/read-state") && method === "GET") {
      return json(route, { read_states: channels.map((c) => ({ channel_id: c.id, last_read_seq: 99, latest_seq: 99, unread_count: 0, mention_count: 0, marked_unread_before_seq: null })) });
    }
    if (path.endsWith("/approvals")) return json(route, { approvals: [] });
    if (path.endsWith("/agent-runs")) return json(route, { runs: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/members/me/sidebar-prefs")) return json(route, { prefs: { version: 1, sections: [], starredChannelIds: [] } });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: [] });
    if (path.endsWith("/work-sessions/shared")) return json(route, { sessions: [], nextCursor: null });
    if (path.endsWith("/work-sessions")) return json(route, { workSessions: [] });
    if (path.endsWith("/reminders")) return json(route, { reminders: [] });
    if (path.endsWith(`/workspaces/${workspaceId}`)) return json(route, { workspace: { id: workspaceId, name: "여명거리" } });
    if (path.includes(`/channels/${CH}/messages`)) return json(route, { messages: messageRows() });
    if (path.includes("/messages")) return json(route, { messages: [] });
    return json(route, {});
  });
}

async function installPageFixtures(page) {
  // 벽시계를 얼린다(하우스 패턴: capture-screens.mjs `pinPageWallClock`). 타임라인의 시각이 찍는 시각에 안 흔들리게.
  await page.addInitScript((now) => {
    const NativeDate = Date;
    function FrozenDate(...args) {
      if (new.target) return Reflect.construct(NativeDate, args.length === 0 ? [now] : args);
      return new NativeDate(now).toString();
    }
    FrozenDate.now = () => now;
    FrozenDate.parse = NativeDate.parse.bind(NativeDate);
    FrozenDate.UTC = NativeDate.UTC.bind(NativeDate);
    FrozenDate.prototype = NativeDate.prototype;
    FrozenDate.prototype.constructor = FrozenDate;
    globalThis.Date = FrozenDate;
  }, FIXTURE_NOW);
  await page.addInitScript(() => {
    class CaptureSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      constructor(url) {
        this.url = String(url); this.readyState = 0; window.__socket = this;
        queueMicrotask(() => { this.readyState = 1; this.onopen?.(new Event("open")); });
      }
      send(data) {
        const replies = String(data).trim().split("\n").map((line) => {
          const c = JSON.parse(line);
          if (c.connect) return { id: c.id, connect: { client: "4189-capture", version: "6" } };
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

/** 저장된 외양 레코드(v2). 기본값(글자 「기본」)은 필드를 두지 않는다 — 앱이 쓰는 정규 형태 그대로다. */
function appearanceRecord(scheme, size, density) {
  const record = { v: 2, scheme, theme: "dawnsky", signal: null, density };
  if (size !== "default") record.fontSize = size;
  return JSON.stringify(record);
}

async function openContext(browser, origin, scheme, viewport, appearance) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: scheme,
    reducedMotion: "reduce",
    serviceWorkers: "block",
    deviceScaleFactor: 2,
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
  });
  await installRoutes(context);
  const page = await context.newPage();
  await installPageFixtures(page);
  await page.addInitScript(([server, key, record]) => {
    try {
      localStorage.setItem("momo.web.server.v1", server);
      if (record !== null) localStorage.setItem(key, record);
    } catch { /* 저장소 없는 캡처 */ }
  }, [origin, APPEARANCE_ENTRY, appearance]);
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("profile-card").waitFor({ timeout: 20_000 });
  return { context, page };
}

const settle = (page) =>
  page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  });

const outDir = () => resolve(OUT_ROOT, LABEL);
const meta = [];

/** 화면에서 **잰** 값. 단계마다 DOM이 실제로 바뀌었다는 증거다. */
async function measureFacts(page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const px = (v) => Number.parseFloat(v);
    const rect = (el) => el.getBoundingClientRect();
    const facts = {
      attr: { fontSize: root.getAttribute("data-font-size"), density: root.getAttribute("data-density") },
      vars: {
        typeScale: getComputedStyle(root).getPropertyValue("--type-scale").trim(),
        spacingRow: getComputedStyle(root).getPropertyValue("--spacing-row").trim(),
      },
    };
    // 메시지 본문(첫 평문 문단)과 줄 높이.
    const body = document.querySelector("[data-row-body] p");
    if (body) {
      const cs = getComputedStyle(body);
      facts.bodyFontPx = px(cs.fontSize);
      facts.bodyLineHeightPx = px(cs.lineHeight);
    }
    // 채널 머리의 키: 대화 밀도가 닿으면 안 되는 자리다(폰 폭에서 py-row로 위아래 여백을 잡던 자리, 57px).
    const head = document.querySelector('[data-testid="channel-header"]');
    if (head) facts.channelHeadPx = Math.round(head.getBoundingClientRect().height * 100) / 100;
    // 아바타 한 변(타임라인 행).
    const avatar = document.querySelector('[data-testid="row-avatar"]');
    if (avatar) facts.avatarPx = [rect(avatar).width, rect(avatar).height];
    // 행 사이 거리: 이어지는 행(같은 사람) / 묶음이 바뀌는 자리. `data-row-body` 상자 사이의 빈 거리다.
    const rows = [...document.querySelectorAll("[data-row-body]")].map((el) => ({
      top: rect(el).top, bottom: rect(el).bottom, group: el.closest("article,div")?.querySelector('[data-testid="row-avatar"]') !== null,
    }));
    if (rows.length >= 3) {
      facts.withinGroupGapPx = rows[1].top - rows[0].bottom;
      facts.withinGroupGapPx2 = rows[2].top - rows[1].bottom;
      facts.betweenGroupGapPx = rows[3].top - rows[2].bottom;
    }
    // 마크다운: 블록 사이와 목록 항목 사이.
    const markdown = [...document.querySelectorAll('[data-testid="message-markdown"]')].find((el) =>
      el.querySelector('[data-testid="message-list"]')
    );
    if (markdown) {
      const blocks = [...markdown.children];
      facts.proseGapPx = blocks.length >= 2 ? rect(blocks[1]).top - rect(blocks[0]).bottom : null;
      const items = [...markdown.querySelectorAll('[data-testid="message-list"] > li')];
      facts.listItemGapPx = items.length >= 2 ? rect(items[1]).top - rect(items[0]).bottom : null;
    }
    return facts;
  });
}

/**
 * 담김 점검: 높이가 작은(64px 이하) 상자 안의 내용이 상자보다 높은 요소. 스크롤 상자는 일부러 뺀다.
 * 기본 단계에도 있던 것은 이 변경의 몫이 아니므로, 호출한 쪽이 기본과 비교한다.
 */
async function clippingReport(page) {
  return page.evaluate(() => {
    const out = [];
    const seen = new Set();
    for (const el of document.querySelectorAll("button, a, label, li, input, select, textarea, h1, h2, h3, [role='button'], [role='tab'], [role='menuitem'], .settings-row, span, p")) {
      const cs = getComputedStyle(el);
      if (cs.display === "inline" || cs.display === "contents") continue;
      if (/auto|scroll/.test(cs.overflowY)) continue;
      const h = el.clientHeight;
      if (h <= 1 || h > 64) continue; // 1px 이하는 sr-only 같은 보조기술용 상자다.
      let textHeight = 0;
      if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLSelectElement) && !(el instanceof HTMLTextAreaElement)) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const rects = [...range.getClientRects()];
        if (rects.length) textHeight = Math.max(...rects.map((r) => r.height));
        if (textHeight > 0 && el.childElementCount === 0) {
          // 단일 줄 글자의 줄 상자가 상자보다 큰지.
        }
      }
      const overflowing = el.scrollHeight > h + 1;
      const textTaller = textHeight > h + 1 && el.childElementCount === 0;
      if (!overflowing && !textTaller) continue;
      const key = `${el.tagName}|${el.getAttribute("data-testid") ?? ""}|${(el.textContent ?? "").trim().slice(0, 24)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, clientHeight: h, scrollHeight: el.scrollHeight, textHeight: Math.round(textHeight * 10) / 10 });
    }
    return out;
  });
}

/** 설정 컨트롤이 큰 글자를 담는지(AC 5): 세그먼트 칸의 높이와 그 안 글자 줄 상자, 행 상자와 글자. */
async function controlFacts(page) {
  return page.evaluate(() => {
    const out = {};
    for (const id of ["font-size-choice", "density-choice", "link-preview-choice", "theme-choice"]) {
      const group = document.querySelector(`[data-testid="${id}"]`);
      if (!group) continue;
      const label = group.querySelector("label");
      // 라벨 안의 **글자 노드**만 잰다(숨긴 라디오 입력의 상자는 글자가 아니다).
      const textNode = [...label.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() !== "");
      const range = document.createRange();
      range.selectNodeContents(textNode);
      const text = range.getBoundingClientRect();
      const box = label.getBoundingClientRect();
      out[id] = {
        labelBoxPx: Math.round(box.height * 10) / 10,
        textBoxPx: Math.round(text.height * 10) / 10,
        lineHeightPx: Number.parseFloat(getComputedStyle(label).lineHeight),
        fontPx: Number.parseFloat(getComputedStyle(label).fontSize),
        contained: text.top >= box.top - 0.5 && text.bottom <= box.bottom + 0.5,
      };
    }
    return out;
  });
}

/** 이어지는 행에 포인터를 올렸을 때 거터의 시각이 상자 안에 담기는지(작은 거터 + 큰 글자의 최악). */
async function clockFacts(page) {
  return page.evaluate(() => {
    // 거터의 시계는 `data-row-clock`(묶음 머리 행의 이름 옆 시각도 `row-time`이라 그 표지로 가른다).
    const time = document.querySelector("[data-row-clock]");
    if (!time) return null;
    const r = time.getBoundingClientRect();
    const row = time.closest("article, div[class*='group']");
    const gutter = time.parentElement.getBoundingClientRect();
    return {
      left: Math.round(r.left * 10) / 10,
      right: Math.round(r.right * 10) / 10,
      widthPx: Math.round(r.width * 10) / 10,
      gutterWidthPx: Math.round(gutter.width * 10) / 10,
      rowLeft: Math.round((row?.getBoundingClientRect().left ?? 0) * 10) / 10,
      opacity: getComputedStyle(time).opacity,
    };
  });
}

async function shoot(page, name, facts = {}) {
  if (!facts.keepPointer) {
    // 포인터를 화면 모서리 밖 여백으로 치운다: 로그인 버튼을 누른 자리의 행이 호버 툴바를 달고 찍히지 않게.
    await page.mouse.move(1, 1);
    await page.mouse.move(page.viewportSize().width - 2, page.viewportSize().height - 2);
  }
  await settle(page);
  const path = resolve(outDir(), `${name}.png`);
  await page.screenshot({ path, animations: "disabled", caret: "hide" });
  meta.push({
    name,
    measured: await measureFacts(page),
    clipping: await clippingReport(page),
    ...(facts.kind === "settings" ? { controls: await controlFacts(page) } : {}),
    ...(facts.keepPointer ? { clock: await clockFacts(page) } : {}),
    ...facts,
  });
}

async function chatScene(browser, origin, { scheme, viewport, size = "default", density = "comfortable", seeded = true, name, hoverContinuation = false }) {
  const appearance = seeded ? appearanceRecord(scheme, size, density) : null;
  const { context, page } = await openContext(browser, origin, scheme, viewport, appearance);
  try {
    await page.evaluate((id) => { location.hash = `/c/${id}`; }, CH);
    await page.getByText("이번 주 일정 정리해 줘").first().waitFor({ timeout: 15_000 });
    await page.getByText("더 필요한 게 있으면 말씀해 주세요.").first().waitFor({ timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(700);
    if (hoverContinuation) {
      // 둘째 행(같은 사람의 이어지는 행)에 포인터를 올려 거터의 시각을 보인다.
      await page.locator("[data-row-body]").nth(1).hover();
      await page.waitForTimeout(250);
    }
    await shoot(page, name, { kind: "chat", scheme, viewport: viewport.name, size, density, seeded, keepPointer: hoverContinuation });
  } finally {
    await context.close();
  }
}

async function settingsScene(browser, origin, { scheme, viewport, size, density, name }) {
  const { context, page } = await openContext(browser, origin, scheme, viewport, appearanceRecord(scheme, size, density));
  try {
    await page.evaluate(() => { location.hash = "/settings?section=appearance"; });
    await page.waitForSelector('[data-testid="font-size-choice"]', { timeout: 15_000 });
    await page.waitForTimeout(500);
    // 새 컨트롤과 대화 미리보기가 한 화면에 들어오게 「대화 표시」 카드를 맨 위로 올려 둔다.
    await page.evaluate(() =>
      document.querySelector('[data-testid="font-size-row"]')?.closest("section")?.scrollIntoView({ block: "start" })
    );
    await page.waitForTimeout(200);
    await shoot(page, name, { kind: "settings", scheme, viewport: viewport.name, size, density });
  } finally {
    await context.close();
  }
}

async function capture() {
  const distDir = resolve(WEB_ROOT, DIST);
  if (!existsSync(resolve(distDir, "index.html"))) throw new Error(`${distDir}/index.html 이 없다. 먼저 빌드한다.`);
  mkdirSync(outDir(), { recursive: true });
  const preview = await startGuardedPreview({
    webRoot: WEB_ROOT,
    port: PORT,
    portEnvVar: "CAPTURE_PORT",
    extraArgs: ["--outDir", distDir],
  });
  const browser = await ENGINE.launch();
  try {
    for (const scheme of SCHEMES) {
      if (ONLY === "smoke") {
        // 보조 엔진용 연기 점검: 기본·극단 하나·설정 쪽 하나(1440).
        await chatScene(browser, preview.origin, { scheme, viewport: V1440, seeded: false, name: `default-${scheme}-1440` });
        await chatScene(browser, preview.origin, { scheme, viewport: V1440, size: "larger", density: "spacious", name: `extreme-larger-spacious-${scheme}-1440` });
        await chatScene(browser, preview.origin, { scheme, viewport: V1440, size: "smaller", density: "compact", name: `extreme-smaller-compact-${scheme}-1440` });
        await settingsScene(browser, preview.origin, { scheme, viewport: V1440_TALL, size: "larger", density: "spacious", name: `settings-larger-spacious-${scheme}-1440` });
        continue;
      }
      // 기본(저장값 없음): 변경 전 번들과 같아야 하는 장면.
      await chatScene(browser, preview.origin, { scheme, viewport: V1440, seeded: false, name: `default-${scheme}-1440` });
      await chatScene(browser, preview.origin, { scheme, viewport: V390, seeded: false, name: `default-${scheme}-390` });
      if (ONLY === "default") continue;
      for (const size of ["smaller", "default", "larger"]) {
        await chatScene(browser, preview.origin, { scheme, viewport: V1440, size, name: `size-${size}-${scheme}-1440` });
      }
      for (const density of ["compact", "comfortable", "spacious"]) {
        await chatScene(browser, preview.origin, { scheme, viewport: V1440, density, name: `density-${density}-${scheme}-1440` });
      }
      await chatScene(browser, preview.origin, { scheme, viewport: V1440, size: "smaller", density: "compact", name: `extreme-smaller-compact-${scheme}-1440` });
      await chatScene(browser, preview.origin, { scheme, viewport: V1440, size: "larger", density: "spacious", name: `extreme-larger-spacious-${scheme}-1440` });
      await chatScene(browser, preview.origin, { scheme, viewport: V390, size: "larger", density: "spacious", name: `extreme-larger-spacious-${scheme}-390` });
      // 거터가 가장 좁고(28) 시각 글자가 가장 큰(11.7px) 조합에서 이어지는 행의 시각이 상자 안에 담기는지.
      await chatScene(browser, preview.origin, { scheme, viewport: V1440, size: "larger", density: "compact", name: `hover-clock-larger-compact-${scheme}-1440`, hoverContinuation: true });
      await settingsScene(browser, preview.origin, { scheme, viewport: V1440_TALL, size: "default", density: "comfortable", name: `settings-default-${scheme}-1440` });
      await settingsScene(browser, preview.origin, { scheme, viewport: V1440_TALL, size: "larger", density: "spacious", name: `settings-larger-spacious-${scheme}-1440` });
      await settingsScene(browser, preview.origin, { scheme, viewport: V1440_TALL, size: "smaller", density: "compact", name: `settings-smaller-compact-${scheme}-1440` });
      await settingsScene(browser, preview.origin, { scheme, viewport: V390_TALL, size: "default", density: "comfortable", name: `settings-default-${scheme}-390` });
      await settingsScene(browser, preview.origin, { scheme, viewport: V390_TALL, size: "larger", density: "spacious", name: `settings-larger-spacious-${scheme}-390` });
    }
  } finally {
    await browser.close();
    await preview.stop?.();
  }
  writeFileSync(resolve(outDir(), "meta.json"), JSON.stringify({ label: LABEL, dist: DIST, shots: meta }, null, 1));
  console.log(`CAPTURE ${LABEL}: ${meta.length} shots -> ${outDir()}`);
}

// ---- 비교: 브라우저의 캔버스로 두 PNG의 픽셀을 비교한다(의존성 없이) ---------------------
async function diff() {
  const beforeDir = resolve(process.env.BEFORE || resolve(OUT_ROOT, "before"));
  const afterDir = resolve(process.env.AFTER || resolve(OUT_ROOT, "after"));
  const names = readdirSync(beforeDir).filter((n) => n.endsWith(".png")).sort();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const compare = (a, b) =>
    page.evaluate(async ([x64, y64]) => {
      const load = async (b64) => {
        const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
        const bmp = await createImageBitmap(blob);
        const canvas = new OffscreenCanvas(bmp.width, bmp.height);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(bmp, 0, 0);
        return { w: bmp.width, h: bmp.height, data: ctx.getImageData(0, 0, bmp.width, bmp.height).data };
      };
      const [x, y] = await Promise.all([load(x64), load(y64)]);
      if (x.w !== y.w || x.h !== y.h) return { sizeMismatch: [x.w, x.h, y.w, y.h] };
      let differing = 0;
      let maxDelta = 0;
      for (let i = 0; i < x.data.length; i += 4) {
        let m = 0;
        for (let k = 0; k < 4; k++) {
          const v = Math.abs(x.data[i + k] - y.data[i + k]);
          if (v > m) m = v;
        }
        if (m > 0) { differing++; if (m > maxDelta) maxDelta = m; }
      }
      return { w: x.w, h: x.h, differing, maxDelta };
    }, [readFileSync(a).toString("base64"), readFileSync(b).toString("base64")]);
  try {
    const rows = [];
    for (const name of names) {
      const after = join(afterDir, name);
      if (!existsSync(after)) { rows.push({ name, missing: true }); continue; }
      rows.push({ name, ...(await compare(join(beforeDir, name), after)) });
    }
    for (const r of rows) {
      console.log(`${r.differing === 0 ? "SAME" : "DIFF"}  ${r.name}  ${r.w ?? "?"}x${r.h ?? "?"}  differing=${r.differing ?? "n/a"}  maxDelta=${r.maxDelta ?? "n/a"}`);
    }
    const bad = rows.filter((r) => r.missing || r.sizeMismatch || r.differing !== 0);

    // 구별 점검: 단계가 다르면 화면도 달라야 한다(같으면 설정이 화면에 닿지 않은 것이다).
    const sanity = [];
    for (const scheme of SCHEMES) {
      const pairs = [
        [`default-${scheme}-1440`, `size-larger-${scheme}-1440`],
        [`default-${scheme}-1440`, `size-smaller-${scheme}-1440`],
        [`size-smaller-${scheme}-1440`, `size-larger-${scheme}-1440`],
        [`default-${scheme}-1440`, `density-compact-${scheme}-1440`],
        [`default-${scheme}-1440`, `density-spacious-${scheme}-1440`],
        [`density-compact-${scheme}-1440`, `density-spacious-${scheme}-1440`],
        [`default-${scheme}-390`, `extreme-larger-spacious-${scheme}-390`],
      ];
      for (const [a, b] of pairs) {
        const pa = join(afterDir, `${a}.png`);
        const pb = join(afterDir, `${b}.png`);
        if (!existsSync(pa) || !existsSync(pb)) continue;
        const r = await compare(pa, pb);
        sanity.push({ pair: `${a} vs ${b}`, differing: r.differing ?? -1 });
      }
      // 「편하게」를 저장값으로 고른 장면은 저장값이 없는 기본 장면과 같아야 한다(기본값은 안 바뀐다).
      const base = join(afterDir, `default-${scheme}-1440.png`);
      for (const twin of [`size-default-${scheme}-1440`, `density-comfortable-${scheme}-1440`]) {
        const tp = join(afterDir, `${twin}.png`);
        if (!existsSync(base) || !existsSync(tp)) continue;
        const r = await compare(base, tp);
        sanity.push({ pair: `${twin} == default-${scheme}-1440`, mustBeSame: true, differing: r.differing ?? -1 });
      }
    }
    const flat = sanity.filter((s) => (s.mustBeSame ? s.differing !== 0 : s.differing === 0));
    for (const s of sanity) console.log(`${s.mustBeSame ? "TWIN" : "DISTINCT"}  ${s.pair}  differing=${s.differing}`);
    console.log(
      `RESULT ${bad.length === 0 && flat.length === 0 ? "PASS" : "FAIL"}: ` +
        `변경 전·후 ${rows.length - bad.length}/${rows.length} 장 픽셀 동일, 구별·쌍둥이 점검 ${sanity.length - flat.length}/${sanity.length} 통과`
    );
    if (bad.length || flat.length) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

// ---- 결합 점검: 대화 밀도가 닿으면 안 되는 자리(채널 머리·컴포저 자동완성 목록)의 키가 단계마다 같은가 ------
//   MODE=coupling LABEL=coupling DIST=dist node scripts/capture-4189.mjs
// 슬래시 명령 목록(`CommandList`)의 행이 `py-row`를 쓰는 자리다. 「@」 목록은 다른 렌더러라 이 값을 읽지 않는다.
async function autocompleteFacts(page) {
  const input = page.getByTestId("composer-input");
  await input.click();
  await input.fill("/");
  await page.waitForSelector('[data-testid="composer-command-option"]', { timeout: 6_000 }).catch(() => null);
  await page.waitForTimeout(200);
  const facts = await page.evaluate(() => {
    const options = [...document.querySelectorAll('[data-testid="composer-command-option"]')];
    const heights = options.map((o) => Math.round(o.getBoundingClientRect().height * 100) / 100);
    const label = document.querySelector('[data-testid="composer-command-list-panel"] p');
    return {
      count: options.length,
      optionPx: heights[0] ?? null,
      allSame: heights.every((h) => h === heights[0]),
      labelPx: label ? Math.round(label.getBoundingClientRect().height * 100) / 100 : null,
    };
  });
  await input.fill("");
  return facts;
}

// AI 계정 카드(타임라인 꼬리 행)는 메시지 행의 아바타 거터와 같은 자리를 비워 본문 열에 선다. 거터 폭이 밀도를 따르므로
// 카드의 왼쪽 가장자리도 본문 열과 같아야 한다(손으로 쓴 w-8이면 compact·spacious에서 4px 어긋난다).
async function cardAlignmentFacts(page) {
  const input = page.getByTestId("composer-input");
  await input.click();
  await input.fill("/ai");
  await page.waitForSelector('[data-testid="composer-command-option"]', { timeout: 6_000 }).catch(() => null);
  await page.keyboard.press("Enter");
  await page.waitForSelector('[data-testid="ai-connect-card"]', { timeout: 8_000 }).catch(() => null);
  await page.waitForTimeout(500);
  return page.evaluate(() => {
    const card = document.querySelector('[data-testid="ai-connect-card"] .ai-card');
    const body = [...document.querySelectorAll("[data-row-body]")].at(-1);
    if (!card || !body) return { opened: Boolean(card), cardLeftPx: null, bodyLeftPx: null, delta: null };
    const cardLeft = card.getBoundingClientRect().left;
    const bodyLeft = body.getBoundingClientRect().left;
    return {
      opened: true,
      cardLeftPx: Math.round(cardLeft * 100) / 100,
      bodyLeftPx: Math.round(bodyLeft * 100) / 100,
      delta: Math.round((cardLeft - bodyLeft) * 100) / 100,
    };
  });
}

async function coupling() {
  const distDir = resolve(WEB_ROOT, DIST);
  if (!existsSync(resolve(distDir, "index.html"))) throw new Error(`${distDir}/index.html 이 없다. 먼저 빌드한다.`);
  mkdirSync(outDir(), { recursive: true });
  const preview = await startGuardedPreview({
    webRoot: WEB_ROOT,
    port: PORT,
    portEnvVar: "CAPTURE_PORT",
    extraArgs: ["--outDir", distDir],
  });
  const browser = await ENGINE.launch();
  const rows = [];
  try {
    for (const viewport of [V1440, V390]) {
      for (const density of ["compact", "comfortable", "spacious"]) {
        const { context, page } = await openContext(browser, preview.origin, "light", viewport, appearanceRecord("light", "default", density));
        try {
          await page.evaluate((id) => { location.hash = `/c/${id}`; }, CH);
          await page.getByText("이번 주 일정 정리해 줘").first().waitFor({ timeout: 15_000 });
          await page.waitForTimeout(500);
          const base = await measureFacts(page);
          const auto = await autocompleteFacts(page);
          const card = await cardAlignmentFacts(page);
          rows.push({ viewport: viewport.name, density, channelHeadPx: base.channelHeadPx, autocomplete: auto, card, avatarPx: base.avatarPx?.[0], withinGroupGapPx: base.withinGroupGapPx });
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
    await preview.stop?.();
  }
  for (const r of rows) console.log(JSON.stringify(r));
  const bad = [];
  for (const viewport of ["1440", "390"]) {
    const set = rows.filter((r) => r.viewport === viewport);
    for (const key of ["channelHeadPx"]) {
      if (new Set(set.map((r) => r[key])).size !== 1) bad.push(`${viewport}: ${key} 가 단계마다 다르다 ${JSON.stringify(set.map((r) => r[key]))}`);
    }
    if (new Set(set.map((r) => r.autocomplete.optionPx)).size !== 1) bad.push(`${viewport}: 명령 목록 행 높이가 단계마다 다르다 ${JSON.stringify(set.map((r) => r.autocomplete.optionPx))}`);
    if (new Set(set.map((r) => r.autocomplete.labelPx)).size !== 1) bad.push(`${viewport}: 명령 목록 머리글 높이가 단계마다 다르다 ${JSON.stringify(set.map((r) => r.autocomplete.labelPx))}`);
    if (set.some((r) => !(r.autocomplete.count > 0))) bad.push(`${viewport}: 자동완성 후보를 못 열었다(점검이 아무것도 재지 못했다)`);
    if (set.some((r) => !r.card.opened)) bad.push(`${viewport}: AI 계정 카드를 못 열었다(점검이 아무것도 재지 못했다)`);
    for (const r of set) {
      if (r.card.opened && r.card.delta !== 0) bad.push(`${viewport} ${r.density}: AI 계정 카드가 본문 열에서 ${r.card.delta}px 어긋난다`);
    }
    // 대조: 대화 표면은 실제로 단계마다 달라야 한다(점검이 허수가 아니다).
    if (new Set(set.map((r) => r.withinGroupGapPx)).size !== 3) bad.push(`${viewport}: 대화 행 간격이 단계마다 달라야 한다 ${JSON.stringify(set.map((r) => r.withinGroupGapPx))}`);
  }
  console.log(`RESULT ${bad.length === 0 ? "PASS" : "FAIL"}: 밀도가 닿으면 안 되는 자리의 키가 세 단계에서 같다${bad.length ? ` — ${bad.join(" | ")}` : ""}`);
  if (bad.length) process.exitCode = 1;
}

// ---- 상호작용 증거: 설정에서 컨트롤을 실제로 눌러 즉시 바뀌고, 새로고침 첫 페인트에도 서 있는지 ---------
//   MODE=interact LABEL=interact DIST=dist node scripts/capture-4189.mjs
async function interact() {
  const distDir = resolve(WEB_ROOT, DIST);
  if (!existsSync(resolve(distDir, "index.html"))) throw new Error(`${distDir}/index.html 이 없다. 먼저 빌드한다.`);
  mkdirSync(outDir(), { recursive: true });
  const preview = await startGuardedPreview({
    webRoot: WEB_ROOT,
    port: PORT,
    portEnvVar: "CAPTURE_PORT",
    extraArgs: ["--outDir", distDir],
  });
  const browser = await ENGINE.launch();
  const problems = [];
  const steps = [];
  const expect = (label, actual, want) => {
    const ok = JSON.stringify(actual) === JSON.stringify(want);
    steps.push(`${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(actual)}${ok ? "" : ` (기대 ${JSON.stringify(want)})`}`);
    if (!ok) problems.push(label);
  };
  try {
    const { context, page } = await openContext(browser, preview.origin, "light", V1440_TALL, null);
    try {
      await page.evaluate(() => { location.hash = "/settings?section=appearance"; });
      await page.waitForSelector('[data-testid="font-size-choice"]', { timeout: 15_000 });
      await page.waitForTimeout(400);
      const read = () =>
        page.evaluate(() => {
          const root = document.documentElement;
          const rows = [...document.querySelectorAll('[data-testid="preview-row"]')];
          const avatar = document.querySelector('[data-testid="preview-avatar"]');
          const stored = JSON.parse(localStorage.getItem("momo.web.appearance.v2") ?? "{}");
          return {
            attrs: { fontSize: root.getAttribute("data-font-size"), density: root.getAttribute("data-density") },
            bodyPx: Number.parseFloat(getComputedStyle(document.body).fontSize),
            previewBodyPx: Number.parseFloat(getComputedStyle(document.querySelector('[data-testid="conversation-preview"] p')).fontSize),
            rowVar: getComputedStyle(root).getPropertyValue("--spacing-row").trim(),
            continuationPadPx: Number.parseFloat(getComputedStyle(rows[1]).paddingTop),
            avatarPx: avatar ? avatar.getBoundingClientRect().width : null,
            stored: { fontSize: stored.fontSize ?? null, density: stored.density ?? null },
          };
        });
      const choose = async (group, text) => {
        await page.locator(`[data-testid="${group}"] label`).filter({ hasText: text }).click();
        await page.waitForTimeout(120);
      };

      // 접근성 트리(스크린리더가 읽는 것): 네이티브 fieldset + legend가 이름 있는 그룹이 되고, 칸은 이름 있는
      // 라디오이며 고른 것이 [checked]다(기존 색 모드 컨트롤과 같은 문법).
      const tree = async (id) => {
        const snapshot = await page.locator(`[data-testid="${id}"]`).ariaSnapshot();
        return {
          group: /^- group "([^"]+)"/.exec(snapshot.trim())?.[1] ?? null,
          radios: [...snapshot.matchAll(/- radio "([^"]+)"( \[checked\])?/g)].map((m) => `${m[1]}${m[2] ? " [checked]" : ""}`),
        };
      };
      expect("글자 크기 그룹의 접근성 트리", await tree("font-size-choice"), {
        group: "글자 크기",
        radios: ["작게", "기본 [checked]", "크게"],
      });
      expect("대화 밀도 그룹의 접근성 트리", await tree("density-choice"), {
        group: "대화 밀도",
        radios: ["촘촘하게", "편하게 [checked]", "여유롭게"],
      });
      expect("처음(저장값 없음)", await read(), {
        attrs: { fontSize: "default", density: "comfortable" },
        bodyPx: 15, previewBodyPx: 15, rowVar: "6px", continuationPadPx: 6, avatarPx: 32,
        stored: { fontSize: null, density: null },
      });
      // 키보드: 고른 칸에 초점을 두고 오른쪽 화살표를 누르면 다음 칸이 골라진다(네이티브 라디오 그룹, 탭 정차는 하나).
      await page.locator('[data-testid="font-size-choice-default"]').focus();
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(120);
      expect("키보드: 글자 크기 「기본」에서 오른쪽 화살표 → 「크게」(곧바로 16px)", (await read()).attrs.fontSize + "/" + (await read()).bodyPx, "larger/16");
      await page.keyboard.press("ArrowLeft");
      await page.waitForTimeout(120);
      expect("키보드: 왼쪽 화살표 → 다시 「기본」", (await read()).attrs.fontSize + "/" + (await read()).bodyPx, "default/15");
      await choose("font-size-choice", "크게");
      expect("글자 크기 「크게」를 누르면 곧바로(새로고침 없이) 16px", await read(), {
        attrs: { fontSize: "larger", density: "comfortable" },
        bodyPx: 16, previewBodyPx: 16, rowVar: "6px", continuationPadPx: 6, avatarPx: 32,
        stored: { fontSize: "larger", density: "comfortable" },
      });
      await choose("density-choice", "여유롭게");
      expect("대화 밀도 「여유롭게」를 누르면 곧바로 미리보기 간격·아바타가 커짐", await read(), {
        attrs: { fontSize: "larger", density: "spacious" },
        bodyPx: 16, previewBodyPx: 16, rowVar: "8px", continuationPadPx: 8, avatarPx: 36,
        stored: { fontSize: "larger", density: "spacious" },
      });
      await choose("font-size-choice", "작게");
      await choose("density-choice", "촘촘하게");
      expect("「작게」+「촘촘하게」", await read(), {
        attrs: { fontSize: "smaller", density: "compact" },
        bodyPx: 14, previewBodyPx: 14, rowVar: "4px", continuationPadPx: 4, avatarPx: 28,
        stored: { fontSize: "smaller", density: "compact" },
      });
      await page.screenshot({ path: resolve(outDir(), "interact-smaller-compact-settings-1440.png"), animations: "disabled" });

      // 설정에서 바꾼 뒤 같은 세션에서 대화로 돌아온다(새로고침 없이): 타임라인이 새 글자·간격으로 서고, 가상 목록이
      // 낡은 행 높이를 쥐고 있어서 행이 겹치는 일이 없다.
      await page.evaluate((id) => { location.hash = `/c/${id}`; }, CH);
      await page.getByText("이번 주 일정 정리해 줘").first().waitFor({ timeout: 15_000 });
      await page.mouse.move(1, 1);
      await page.waitForTimeout(600);
      const back = await measureFacts(page);
      expect("설정에서 바꾼 뒤 대화로 돌아오면(새로고침 없이) 새 글자·간격이 서 있음", {
        body: back.bodyFontPx, avatar: back.avatarPx?.[0], within: back.withinGroupGapPx, between: back.betweenGroupGapPx,
        prose: back.proseGapPx, listItem: back.listItemGapPx,
      }, { body: 14, avatar: 28, within: 8, between: 12, prose: 6, listItem: 0 });
      const overlaps = await page.evaluate(() => {
        const boxes = [...document.querySelectorAll("[data-row-body]")]
          .map((el) => el.getBoundingClientRect())
          .sort((a, b) => a.top - b.top);
        const bad = [];
        for (let i = 1; i < boxes.length; i++) if (boxes[i].top < boxes[i - 1].bottom - 0.5) bad.push(i);
        return { rows: boxes.length, overlapping: bad };
      });
      expect("대화로 돌아온 타임라인의 행이 서로 겹치지 않음", overlaps.overlapping, []);
      expect("대화로 돌아온 타임라인에 행이 그려져 있음(6행 이상)", overlaps.rows >= 6, true);
      await page.screenshot({ path: resolve(outDir(), "interact-chat-back-smaller-compact-1440.png"), animations: "disabled" });
      await page.evaluate(() => { location.hash = "/settings?section=appearance"; });
      await page.waitForSelector('[data-testid="font-size-choice"]', { timeout: 15_000 });
      await page.waitForTimeout(300);

      // 새로고침 첫 페인트: 앱 번들이 오기 전 문서에 이미 선 값(저장된 선택이 화면에 서 있다).
      const fresh = await context.newPage();
      await installPageFixtures(fresh);
      const held = [];
      await fresh.route("**/assets/*.js", (route) => { held.push(route); });
      await fresh.goto(preview.origin, { waitUntil: "commit" });
      await fresh.waitForFunction(() => document.getElementById("root") !== null, undefined, { timeout: 10_000 });
      const early = await fresh.evaluate(() => ({
        rendered: (document.getElementById("root")?.childElementCount ?? -1) > 0,
        attrs: { fontSize: document.documentElement.getAttribute("data-font-size"), density: document.documentElement.getAttribute("data-density") },
        bodyPx: Number.parseFloat(getComputedStyle(document.body).fontSize),
        rowVar: getComputedStyle(document.documentElement).getPropertyValue("--spacing-row").trim(),
      }));
      expect("새로고침 첫 페인트(React 미렌더)에도 저장된 「작게」+「촘촘하게」가 이미 서 있음", early, {
        rendered: false,
        attrs: { fontSize: "smaller", density: "compact" },
        bodyPx: 14, rowVar: "4px",
      });
      await fresh.unroute("**/assets/*.js");
      for (const route of held) await route.continue().catch(() => {});
      await fresh.close();

      await choose("font-size-choice", "기본");
      await choose("density-choice", "편하게");
      expect("「기본」+「편하게」로 돌아오면 저장에서 기본값이 빠지고 처음과 같은 화면", await read(), {
        attrs: { fontSize: "default", density: "comfortable" },
        bodyPx: 15, previewBodyPx: 15, rowVar: "6px", continuationPadPx: 6, avatarPx: 32,
        stored: { fontSize: null, density: "comfortable" },
      });
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
    await preview.stop?.();
  }
  for (const line of steps) console.log(line);
  console.log(`RESULT ${problems.length === 0 ? "PASS" : "FAIL"}: 상호작용 ${steps.length - problems.length}/${steps.length} 단계`);
  if (problems.length) process.exitCode = 1;
}

(MODE === "diff" ? diff() : MODE === "interact" ? interact() : MODE === "coupling" ? coupling() : capture()).catch((error) => {
  console.error(error);
  process.exit(1);
});
