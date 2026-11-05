#!/usr/bin/env node
// =============================================================================
// #5326 레인: 고치기를 찾기 쉽게(내 메시지 호버 도구 막대의 연필) + 「수정됨」 옆 고친 시각 (웹 Chromium 헤드리스).
//
//   npm run build && node scripts/capture-5326.mjs
//   DIST_DIR=<다른 dist> node scripts/capture-5326.mjs        # 고치기 전 번들(RED 를 사진으로 남길 때)
//   EXPECT=before node scripts/capture-5326.mjs                # 고치기 전 번들의 기대: 연필 없음 · 시각 없음
//   SHOTS=1 OUT_DIR=<dir> TAG=after node scripts/capture-5326.mjs   # 캡처도 찍기(기본은 재기만)
//   SCHEMES=light,dark node scripts/capture-5326.mjs           # 기본은 light
//
// 장면 셋. 표의 칸이 곧 단정이다(`EXPECT=before` 이면 반대 방향의 단정).
//
//   toolbar  내 글에 포인터를 올리면 도구 막대에 연필(고치기)이 서고, 남의 글에는 없다. 도구 막대 상자가 **내 글의 글자와 겹치지 않는다**
//            (B11 R2 Blocker): 1280 폭과 좁은 900 폭, 세 줄짜리 한국어 글에서.
//   tooltip  고친 글의 「수정됨」에 초점을 주면(키보드와 같은 경로) 「…에 수정됨」 툴팁이 뜬다. 오늘 · 어제 · 같은 해 다른 날 · 다른 해가 각각
//            다른 문장이고, 시각을 모르는 고친 글은 낱말만이다. 그 낱말은 행의 로빙 그룹 구성원이라 행의 탭 정거장이 늘지 않는다.
//   keys     행에 키보드로 들어가 ←/→ 로 연필에 닿고 Enter 로 편집기를 연다(도구 막대 단추의 키보드 길).
//
// 백엔드는 없다: `/v1/**` 는 이 파일 안의 메모리 서버이고 소켓은 구독만 받는다. 인물은 전부 가상이다(레포는 공개).
// =============================================================================
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "captures/5326");
const PORT = Number(process.env.CAPTURE_PORT || 5392);
const DIST_DIR = process.env.DIST_DIR || "";
const SHOTS = process.env.SHOTS === "1";
const TAG = process.env.TAG || "run";
const EXPECT = process.env.EXPECT === "before" ? "before" : "after";
const SCHEMES = (process.env.SCHEMES || "light").split(",").map((s) => s.trim()).filter(Boolean);
const MIN = 60_000;
const HOUR = 60 * MIN;
const KST = 9 * HOUR;

const workspaceId = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const SEO = "00000000-0000-7000-8000-000000000102";
const CH = "00000000-0000-7000-8000-000000000201";
const GEN = "00000000-0000-7000-8000-000000000202";
const mid = (n) => `00000000-0000-7000-8000-0000000a${String(n).padStart(4, "0")}`;
const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

// 「오늘」은 이 순간의 서울 달력이다. 고친 시각은 거기서 센 오늘 · 어제 · 다른 날 · 다른 해다(브라우저 시간대도 서울로 맞춘다).
const NOW = Date.now();
const kstMidnight = (ms) => Math.floor((ms + KST) / (24 * HOUR)) * 24 * HOUR - KST;
const TODAY0 = kstMidnight(NOW);
const at = (dayOffset, hh, mm) => TODAY0 + dayOffset * 24 * HOUR + hh * HOUR + mm * MIN;
const EDITED_TODAY = Math.min(NOW - 2 * MIN, at(0, 9, 5));
const EDITED_YESTERDAY = at(-1, 21, 40);
const EDITED_OTHER_DAY = at(-3, 9, 15);
const EDITED_OTHER_YEAR = Date.UTC(new Date(NOW).getUTCFullYear() - 1, 11, 31, 12, 10);

const person = (id, kind, displayName, handle, extra = {}) => ({
  id, workspaceId, kind, status: "active", displayName, handle, role: "member", channelCount: 2,
  channelIds: [CH, GEN], capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...extra,
});
const roster = [person(ME, "human", "이도현", "dohyun", { role: "owner" }), person(SEO, "human", "박서연", "seoyeon")];
const channels = [
  { id: CH, workspaceId, kind: "public", name: "디자인-리뷰", muted: false },
  { id: GEN, workspaceId, kind: "public", name: "일반", muted: false },
];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: ME, workspaceId, kind: "human", displayName: "이도현", handle: "dohyun" },
  realtimeWebSocketUrl: "ws://capture-5326.invalid/connection/websocket",
};

const ID = { plain: mid(11), today: mid(12), yesterday: mid(13), otherDay: mid(14), otherYear: mid(15), noTime: mid(16), other: mid(17), long: mid(18) };
function row(seq, id, author, body, minAgo, extra = {}) {
  const createdAtMs = NOW - minAgo * MIN;
  return { id, channelId: CH, seq, hlcTs: createdAtMs, hlcCount: 0, authorMemberId: author, type: "text", body, state: "sent", createdAtMs, ...extra };
}
const edited = (editedAtMs) => ({ state: "edited", editedAtMs });
const rows = [
  row(10, mid(10), SEO, "오늘 오후에 디자인 리뷰 가능하세요?", 120),
  row(11, ID.plain, ME, "회의 시간은 3시로 정했어요, 참석 부탁드려요", 100),
  row(12, ID.today, ME, "점심은 12시 반에 건물 앞에서 만나요", 90, edited(EDITED_TODAY)),
  row(13, ID.yesterday, ME, "어제 보낸 글인데 장소를 3층으로 고쳤어요", 80, edited(EDITED_YESTERDAY)),
  row(14, ID.otherDay, ME, "며칠 전에 보낸 일정 글이에요", 70, edited(EDITED_OTHER_DAY)),
  row(15, ID.otherYear, ME, "작년에 보낸 글이에요, 연말 회식 장소입니다", 60, edited(EDITED_OTHER_YEAR)),
  row(16, ID.noTime, ME, "고친 시각이 오지 않은 옛 캐시의 줄이에요", 50, { state: "edited" }),
  row(17, ID.other, SEO, "남이 쓴 글은 내 화면에서 고칠 수 없어요", 40, edited(EDITED_TODAY)),
  row(18, ID.long, ME, "세 줄이 되는 긴 한국어 글이에요. 이번 분기 디자인 리뷰는 월요일 오전에 시작하고, 시안은 수요일까지 공유해 주세요. 피드백은 스레드에 모아 주시면 정리해서 금요일에 다시 말씀드릴게요. English mixed 문장도 한 줄 섞어 둡니다.", 20),
];

async function installMocks(context) {
  await context.route("**/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: NOW + 600_000, ttlSeconds: 60, workspaceId, memberId: ME });
    if (/\/inbox(\/|$)/.test(path)) return json(route, { error: { code: "not_found", message: "not found" } }, 404);
    if (path.endsWith("/read-state")) {
      return json(route, { read_states: channels.map((c) => ({ channel_id: c.id, last_read_seq: 999, latest_seq: 999, unread_count: 0, mention_count: 0, marked_unread_before_seq: null })) });
    }
    if (path.endsWith("/members/me/sidebar-prefs")) return json(route, { prefs: { version: 1, sections: [], starredChannelIds: [] } });
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/approvals")) return json(route, { approvals: [] });
    if (path.endsWith("/agent-runs/progress")) return json(route, { runs: [] });
    if (path.endsWith("/agent-runs")) return json(route, { runs: [] });
    if (path.endsWith("/reminders")) return json(route, { reminders: [] });
    if (path.endsWith(`/workspaces/${workspaceId}`)) return json(route, { workspace: { id: workspaceId, name: "달무리 스튜디오" } });
    if (path.includes(`/channels/${CH}/messages`)) return json(route, { messages: rows });
    if (path.includes("/messages")) return json(route, { messages: [] });
    return json(route, {});
  });
  await context.addInitScript(() => {
    class CaptureSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      constructor(url) {
        this.url = String(url); this.readyState = 0;
        queueMicrotask(() => { this.readyState = 1; this.onopen?.(new Event("open")); });
      }
      send(data) {
        const replies = String(data).trim().split("\n").map((line) => {
          const c = JSON.parse(line);
          if (c.connect) return { id: c.id, connect: { client: "capture-5326", version: "6" } };
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

async function open(origin, scheme, viewport) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport, colorScheme: scheme, locale: "ko-KR", timezoneId: "Asia/Seoul", serviceWorkers: "block", reducedMotion: "reduce" });
  await installMocks(context);
  await context.addInitScript((serverBase) => { try { localStorage.setItem("momo.web.server.v1", serverBase); } catch { /* 저장소 없는 캡처 */ } }, origin);
  const page = await context.newPage();
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-item").first().waitFor({ state: "attached", timeout: 20_000 });
  await page.evaluate((h) => { location.hash = h; }, `/c/${CH}`);
  await page.getByTestId("composer").waitFor({ timeout: 20_000 });
  await page.locator(`[data-testid="timeline-message"][data-seq="18"]`).first().waitFor({ timeout: 20_000 });
  await page.mouse.move(2, 2);
  await page.waitForTimeout(900);
  return { browser, page };
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${String(detail).slice(0, 300)}`}`);
}
const note = (line) => console.log(`     ${line}`);

async function shot(page, tag, name) {
  if (!SHOTS) return;
  mkdirSync(OUT_DIR, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: resolve(OUT_DIR, `5326-${TAG}-${tag.replace(/\s+/g, "-")}-${name}.png`) });
}

const rowById = (page, id) => page.locator(`[data-testid="timeline-message"][data-message-id="${id.toLowerCase()}"]`).first();

async function hoverRow(page, row) {
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  await page.mouse.move(2, 2);
  await page.waitForTimeout(150);
  await row.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await row.hover();
  const toolbar = row.locator('[data-testid="message-hover-toolbar"]').first();
  const shown = await toolbar.waitFor({ state: "visible", timeout: 2500 }).then(() => true, () => false);
  await page.waitForTimeout(300);
  return { toolbar, shown };
}

/** 도구 막대 상자와 **이 행 본문 글자**가 겹치는가. 본문 글자의 줄 상자(Range 의 client rect)와 막대 상자의 교차를 잰다. */
async function toolbarTextOverlap(row) {
  return row.evaluate((el) => {
    const bar = el.querySelector('[data-testid="message-hover-toolbar"]');
    if (!bar) return { overlap: false, reason: "no toolbar" };
    const b = bar.getBoundingClientRect();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => (node.parentElement?.closest('[data-testid="message-hover-toolbar"]') || !(node.textContent ?? "").trim() ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    let hit = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const r of range.getClientRects()) {
        const x = Math.min(r.right, b.right) - Math.max(r.left, b.left);
        const y = Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top);
        if (x > 0.5 && y > 0.5) hit = { text: (node.textContent ?? "").slice(0, 24), x: Math.round(x), y: Math.round(y) };
      }
    }
    return { overlap: hit !== null, hit, bar: { w: Math.round(b.width), h: Math.round(b.height), l: Math.round(b.left), t: Math.round(b.top) } };
  });
}

async function runToolbar(origin, scheme) {
  const tag = `${scheme}`;
  for (const [label, viewport] of [["1280", { width: 1280, height: 800 }], ["900", { width: 900, height: 800 }]]) {
    const { browser, page } = await open(origin, scheme, viewport);
    try {
      const own = rowById(page, ID.plain);
      const { toolbar, shown } = await hoverRow(page, own);
      check(`${tag} ${label}: 내 글에 올리면 도구 막대가 선다`, shown);
      const pencil = toolbar.locator('[data-testid="toolbar-edit"]');
      const hasPencil = (await pencil.count()) > 0;
      check(`${tag} ${label}: 내 글 도구 막대에 연필이 ${EXPECT === "after" ? "있다" : "없다(고치기 전)"}`, EXPECT === "after" ? hasPencil : !hasPencil);
      if (hasPencil) {
        const name = await pencil.getAttribute("aria-label");
        check(`${tag} ${label}: 연필의 접근성 이름은 「고치기」`, name === "고치기", name);
        check(`${tag} ${label}: 연필은 행의 로빙 그룹 구성원이다`, (await pencil.getAttribute("data-row-action")) !== null);
        const order = await toolbar.locator("[data-testid]").evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-testid")));
        const i = order.indexOf("toolbar-edit");
        check(`${tag} ${label}: 연필은 답글 다음 ⋯ 앞이다`, order[i - 1] === "toolbar-reply" && order[i + 1] === "message-actions-trigger", order.join(","));
      }
      await shot(page, tag, `own-toolbar-${label}`);
      const overlapPlain = await toolbarTextOverlap(own);
      note(`짧은 글 ${label}: 도구 막대 ${JSON.stringify(overlapPlain.bar)} 글자와 겹침 ${overlapPlain.overlap ? JSON.stringify(overlapPlain.hit) : "없음"}`);
      check(`${tag} ${label}: 짧은 내 글의 글자와 도구 막대가 겹치지 않는다`, !overlapPlain.overlap, JSON.stringify(overlapPlain));

      const long = rowById(page, ID.long);
      await hoverRow(page, long);
      const overlapLong = await toolbarTextOverlap(long);
      note(`세 줄 글 ${label}: 도구 막대 ${JSON.stringify(overlapLong.bar)} 글자와 겹침 ${overlapLong.overlap ? JSON.stringify(overlapLong.hit) : "없음"}`);
      check(`${tag} ${label}: 세 줄짜리 내 글의 글자와 도구 막대가 겹치지 않는다`, !overlapLong.overlap, JSON.stringify(overlapLong));
      if (label === "900") await shot(page, tag, "own-toolbar-long-900");

      const other = rowById(page, ID.other);
      const otherState = await hoverRow(page, other);
      check(`${tag} ${label}: 남의 글에도 도구 막대는 서되`, otherState.shown);
      check(`${tag} ${label}: 남의 글에는 연필이 없다`, (await otherState.toolbar.locator('[data-testid="toolbar-edit"]').count()) === 0);
    } finally {
      await browser.close();
    }
  }
}

async function focusMark(page, id) {
  const row = rowById(page, id);
  await row.evaluate((el) => el.scrollIntoView({ block: "center" }));
  // 고치기 전 번들의 「수정됨」은 testid 가 없는 글자뿐이라 글자로 찾는다.
  const mark = EXPECT === "before" ? row.getByText("수정됨", { exact: true }).first() : row.locator('[data-testid="edited-mark"]').first();
  await mark.waitFor({ state: "attached", timeout: 3000 });
  return { row, mark };
}

async function runTooltip(origin, scheme) {
  const tag = `${scheme}`;
  const { browser, page } = await open(origin, scheme, { width: 1280, height: 800 });
  try {
    const cases = [
      ["오늘", ID.today, /^(?!.*(어제|월 )).*:\d\d에 수정됨$/],
      ["어제", ID.yesterday, /^어제 .*에 수정됨$/],
      ["같은 해 다른 날", ID.otherDay, /^\d+월 \d+일 .*에 수정됨$/],
      ["다른 해", ID.otherYear, /^\d{4}년 \d+월 \d+일 .*에 수정됨$/],
    ];
    for (const [name, id, pattern] of cases) {
      const { row, mark } = await focusMark(page, id);
      const tagName = await mark.evaluate((el) => el.tagName);
      if (EXPECT === "before") {
        check(`${tag} ${name}: 고치기 전 번들의 「수정됨」은 글자뿐이다(시각 없음)`, tagName === "SPAN" && (await mark.getAttribute("aria-label")) === null && (await mark.textContent()) === "수정됨", tagName);
        await row.hover();
        await page.waitForTimeout(700);
        if (name === "오늘") await shot(page, tag, "edited-mark-hover");
        continue;
      }
      const label = (await mark.getAttribute("aria-label")) ?? "";
      check(`${tag} ${name}: 접근성 이름이 시각 문장이다`, pattern.test(label), label);
      check(`${tag} ${name}: 보이는 글자는 「수정됨」이다`, (await mark.textContent()) === "수정됨");
      await row.hover();
      await mark.focus({ preventScroll: true });
      await page.keyboard.press("Shift+Tab").catch(() => undefined);
      await mark.focus({ preventScroll: true });
      const tip = row.locator(".tooltip-surface").first();
      const shown = await tip.waitFor({ state: "visible", timeout: 2000 }).then(() => true, () => false);
      const tipText = shown ? ((await tip.textContent()) ?? "") : "";
      check(`${tag} ${name}: 초점이 가면 같은 문장이 툴팁으로 뜬다`, shown && tipText === label, tipText);
      if (name === "오늘" || name === "다른 해") await shot(page, tag, `edited-tooltip-${name === "오늘" ? "today" : "other-year"}`);
      await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
    }
    // 시각을 모르는 고친 글: 낱말만. 남의 글의 「수정됨」도 시각이 있으면 같다.
    const noTime = EXPECT === "before" ? rowById(page, ID.noTime).getByText("수정됨", { exact: true }).first() : rowById(page, ID.noTime).locator('[data-testid="edited-mark"]').first();
    check(`${tag} 시각 모름: 낱말 글자 하나(툴팁·초점 정거장 없음)`, (await noTime.evaluate((el) => el.tagName)) === "SPAN" && (await noTime.getAttribute("data-row-action")) === null);
    if (EXPECT === "after") {
      const others = await rowById(page, ID.other).locator('[data-testid="edited-mark"]').first().getAttribute("aria-label");
      check(`${tag} 남의 고친 글에도 같은 시각 문장이다`, /에 수정됨$/.test(others ?? ""), others);
      // 행의 탭 정거장은 늘지 않는다: 낱말은 로빙 그룹의 구성원이라 tabindex 가 -1 이거나 행 정거장 하나 안에 든다.
      const stops = await rowById(page, ID.today).evaluate((el) =>
        [el, ...el.querySelectorAll("[tabindex]")].filter((n) => n.tabIndex >= 0).length
      );
      check(`${tag} 고친 글 행의 탭 정거장이 1이다`, stops === 1, String(stops));
    }
  } finally {
    await browser.close();
  }
}

async function runKeys(origin, scheme) {
  if (EXPECT === "before") return;
  const tag = `${scheme}`;
  const { browser, page } = await open(origin, scheme, { width: 1280, height: 800 });
  try {
    const own = rowById(page, ID.plain);
    await own.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await own.focus();
    await page.keyboard.press("Tab").catch(() => undefined);
    await own.focus();
    const toolbarShown = await own.locator('[data-testid="message-hover-toolbar"]').first().waitFor({ state: "visible", timeout: 2500 }).then(() => true, () => false);
    check(`${tag} 키보드: 행에 초점이 가면 도구 막대가 선다`, toolbarShown);
    const pencil = own.locator('[data-testid="toolbar-edit"]').first();
    let reached = false;
    for (let step = 0; step < 12 && !reached; step += 1) {
      reached = (await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))) === "toolbar-edit";
      if (!reached) await page.keyboard.press("ArrowLeft");
    }
    check(`${tag} 키보드: ←/→ 로 연필에 닿는다`, reached);
    if (reached) {
      const tip = own.locator(".tooltip-surface").first();
      const tipShown = await tip.waitFor({ state: "visible", timeout: 2000 }).then(() => true, () => false);
      check(`${tag} 키보드: 연필에 초점이 가면 「고치기」 툴팁이 뜬다`, tipShown && ((await tip.textContent()) ?? "") === "고치기");
      await shot(page, tag, "pencil-keyboard-focus");
      await pencil.press("Enter");
      const input = own.locator('[data-testid="message-editor-input"]').first();
      const opened = await input.waitFor({ state: "visible", timeout: 2500 }).then(() => true, () => false);
      check(`${tag} 키보드: Enter 로 연필을 누르면 그 행 안에 편집기가 지금 글로 열린다`, opened && (await input.inputValue()) === "회의 시간은 3시로 정했어요, 참석 부탁드려요");
    }
  } finally {
    await browser.close();
  }
}

async function main() {
  const preview = await startGuardedPreview({
    webRoot: WEB_ROOT,
    port: PORT,
    portEnvVar: "CAPTURE_PORT",
    ...(DIST_DIR ? { extraArgs: ["--outDir", resolve(DIST_DIR)] } : {}),
  });
  try {
    for (const scheme of SCHEMES) {
      console.log(`--- chromium ${scheme} (${EXPECT})`);
      await runToolbar(preview.origin, scheme);
      await runTooltip(preview.origin, scheme);
      await runKeys(preview.origin, scheme);
    }
  } finally {
    await preview.stop?.();
  }
  const bad = results.filter((r) => !r.ok);
  console.log(`EDIT-ENTRY-5326 ${bad.length === 0 ? "PASS" : "FAIL"} (${results.length} checks${bad.length ? `, ${bad.length} failed` : ""})`);
  if (bad.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
