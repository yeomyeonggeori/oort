#!/usr/bin/env node
// =============================================================================
// 사이드바 — 정렬 단추 없음 · 읽은 줄 연하게 · 「목록에서 숨기기」 실측 + 캡처 (#5775, QA 1·3·11).
//
//   npm run build && node scripts/capture-5775.mjs
//   OUT_DIR=… node scripts/capture-5775.mjs
//
// 재는 것(틀리면 기록하고 끝 코드를 1로 만든다):
//   A. 「채널」 머리에 정렬 단추(⇅)가 없다. 서버에 「가나다」가 저장돼 있어도 끌어서 정한 차례로 선다.
//   B. 읽은 줄은 연하고(이름 색 = --ink-muted), 안 읽은 줄·열린 줄은 또렷하다. 알림 끈 줄은 새 글이 있어도 연하다.
//      목적지 줄(인박스)은 짙다. 같은 이름 둘의 `@핸들`은 이름과 다른 색이다. 이름 글자색 대비 4.5:1 이상(계산된 색 ↔ 사이드바 바닥).
//   C. DM 호버 X 의 이름·툴팁이 「목록에서 숨기기」이고, 「⋯ › 숨긴 대화」 목록의 낱말이 새 낱말이다. 옛 낱말은 어디에도 없다.
//   D. 띠 테마(노을띠)에서도 B 의 대비.
// 찍는 것: 밝게/어둡게 × 보통/좁은 폭/글자 200% (+ 노을띠).
// =============================================================================
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/sidebar-5775");
const PORT = Number(process.env.CAPTURE_PORT || 5275);

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const chId = (n) => `00000000-0000-7000-8000-0000000002${String(n).padStart(2, "0")}`;
const dmId = (n) => `00000000-0000-7000-8000-0000000003${String(n).padStart(2, "0")}`;
const P = (n) => `00000000-0000-7000-8000-0000000001${n}`;
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const channels = [
  { id: chId(1), workspaceId, kind: "public", name: "general", muted: false },
  { id: chId(2), workspaceId, kind: "public", name: "design", muted: false },
  { id: chId(3), workspaceId, kind: "public", name: "alpha", muted: false },
  { id: chId(4), workspaceId, kind: "private", name: "zeta-room", muted: true },
  { id: chId(5), workspaceId, kind: "public", name: "beta", muted: false },
];
const person = (n, displayName, handle, extra = {}) => ({
  id: P(n), workspaceId, kind: "human", status: "active", displayName, handle, channelCount: 1, channelIds: [], capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...extra,
});
// 이서연이 둘이다: 이름만으로는 갈리지 않아 행에 `@핸들`이 선다.
const roster = [
  person("01", "박지우", "jiwoo", { role: "owner" }),
  person("11", "김도현", "dohyeon"),
  person("12", "이서연", "seoyeon"),
  person("13", "이서연", "seoyeon-design"),
  person("14", "김인턴", "intern", { kind: "agent", hostOnline: true, ownerHumanId: P("01") }),
];
const dm = (n, other) => ({ id: dmId(n), workspaceId, kind: "dm", muted: false, memberIds: [P("01"), other] });
const dms = [dm(1, P("11")), dm(2, P("12")), dm(3, P("13")), dm(4, P("14"))];

// [마지막으로 읽은 seq, 최신 seq]
const READ = {
  [chId(1)]: [10, 10], [chId(2)]: [7, 9], [chId(3)]: [4, 4], [chId(4)]: [2, 6], [chId(5)]: [3, 3],
  [dmId(1)]: [8, 8], [dmId(2)]: [5, 7], [dmId(3)]: [6, 6], [dmId(4)]: [4, 4],
};
// 「가나다」를 저장해 둔 계정: 끌어서 정한 차례는 alpha(가나다)와 다르게 zeta → beta → alpha 로 적어 둔다.
const PREFS = { version: 1, sections: [{ id: "sec-1", name: "출시 준비", order: 0, channelIds: [chId(4), chId(5), chId(3)] }], starredChannelIds: [], sectionSort: "alpha" };

const results = [];
function check(scheme, name, ok, detail) {
  results.push({ scheme, name, ok: Boolean(ok), detail });
  console.log(JSON.stringify({ scheme, check: name, ok: Boolean(ok), detail }));
}

const wireRead = (id) => ({
  channel_id: id, last_read_seq: READ[id][0], latest_seq: READ[id][1],
  unread_count: Math.max(0, READ[id][1] - READ[id][0]), mention_count: 0, marked_unread_before_seq: null,
});

async function installMocks(context) {
  const auth = {
    accessToken: "capture-only-not-a-credential", refreshToken: "capture-only-not-a-credential",
    member: { id: memberId, workspaceId, kind: "human", displayName: "박지우", handle: "jiwoo" },
    realtimeWebSocketUrl: "ws://sidebar-5775-capture.invalid/connection/websocket",
  };
  await context.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId });
    if (path.endsWith("/read-state")) return json(route, { read_states: Object.keys(READ).map(wireRead) });
    if (path.endsWith("/members/me/sidebar-prefs")) return json(route, { prefs: PREFS });
    if (path.endsWith("/channels")) return json(route, { channels: [...channels, ...dms] });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith(`/workspaces/${workspaceId}`)) return json(route, { workspace: { id: workspaceId, name: "새벽 팀" } });
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

async function open(origin, scheme, viewport) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport, colorScheme: scheme, serviceWorkers: "block", reducedMotion: "reduce" });
  await installMocks(context);
  await context.addInitScript((server) => { try { if (!localStorage.getItem("momo.web.server.v1")) localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ } }, origin);
  const page = await context.newPage();
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-item").first().waitFor({ timeout: 20_000 });
  await page.getByTestId("sidebar-section-sec-1").waitFor({ timeout: 20_000 });
  return { browser, page };
}

const rowOf = (page, id) => page.locator(`[data-testid="channel-item"][data-channel-id="${id}"]`);

// WCAG 상대 휘도·대비. 계산된 색(`rgb(...)`)을 읽어 잰다 — 손으로 적은 값이 아니라 브라우저가 그린 색이다.
const MEASURE = `(() => {
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const parse = (s) => {
    const m = s.match(/[\\d.]+/g).map(Number);
    const unit = s.startsWith("color(srgb") ? 255 : 1;
    return { rgb: m.slice(0, 3).map((c) => c * unit), a: m.length > 3 ? m[3] : 1 };
  };
  const over = (top, base) => top.rgb.map((c, i) => c * top.a + base[i] * (1 - top.a));
  const bgOf = (el) => {
    const stack = [];
    for (let n = el; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c.a > 0) stack.push(c); if (c.a >= 1) break; }
    let base = [255, 255, 255];
    for (const layer of stack.reverse()) base = over(layer, base);
    return base;
  };
  const ratio = (fg, bg) => { const hi = Math.max(lum(fg), lum(bg)), lo = Math.min(lum(fg), lum(bg)); return (hi + 0.05) / (lo + 0.05); };
  window.__measure = (el, bgOverride) => {
    const bg = bgOverride ?? bgOf(el);
    const c = parse(getComputedStyle(el).color);
    const fg = over(c, bg);
    return { color: getComputedStyle(el).color, weight: getComputedStyle(el).fontWeight, ratio: Math.round(ratio(fg, bg) * 100) / 100 };
  };
})()`;

async function nameOf(page, id) {
  return rowOf(page, id).evaluate((row) => {
    const label = row.querySelector(":scope > span:nth-of-type(2) > span:first-child");
    return window.__measure(label);
  });
}

/** 줄마다 `@핸들`의 색·대비와 같은 줄 이름의 색. 이름이 연한 줄(읽은 줄)에서 두 색이 달라야 한다. */
async function handlesOf(page, bg) {
  return page.locator('[data-testid="row-handle"]').evaluateAll((els, bgArg) => els.map((el) => {
    const name = el.parentElement.firstElementChild;
    return { text: el.textContent, ...window.__measure(el, bgArg ?? undefined), nameColor: getComputedStyle(name).color };
  }), bg ?? null);
}

/** 노을띠의 띠 색(`design/themes/palettes/noeul.css` 의 `--band`, 표류 시험이 core 와 맞춘 값). */
const NOEUL_BAND = { light: [0x1c, 0x24, 0x40], dark: [0x0d, 0x12, 0x22] };
const bandColor = async (_page, scheme) => NOEUL_BAND[scheme];

async function runScheme(origin, scheme) {
  const { browser, page } = await open(origin, scheme, { width: 1440, height: 900 });
  const shot = (name, clip = { x: 0, y: 0, width: 420, height: 900 }) =>
    page.screenshot({ path: resolve(OUT_DIR, `c5775-${name}-${scheme}.png`), clip });
  try {
    await page.evaluate(MEASURE);
    await rowOf(page, chId(3)).click(); // 열린 줄: alpha
    await page.waitForURL(new RegExp(`/c/${chId(3)}$`), { timeout: 5_000 });
    await page.mouse.move(900, 450);

    // A. 정렬 단추 없음 · 저장된 「가나다」 무시
    const header = page.getByTestId("sidebar-section-channels-header");
    await header.hover();
    check(scheme, "A1 정렬 단추가 없다", (await page.getByTestId("sidebar-sort-menu").count()) === 0, null);
    check(scheme, "A2 「채널 정렬」 이름의 단추도 없다", (await page.getByRole("button", { name: "채널 정렬" }).count()) === 0, null);
    const order = await page.locator('[data-testid="sidebar-section-sec-1"] [data-testid="channel-item"]').evaluateAll((els) => els.map((el) => el.getAttribute("data-channel-id")));
    check(scheme, "A3 「가나다」를 저장해 둔 계정도 끌어서 정한 차례(zeta-room → beta → alpha)로 선다", JSON.stringify(order) === JSON.stringify([chId(4), chId(5), chId(3)]), order);

    // B. 읽은 줄 연하게
    const read = await nameOf(page, chId(1)); // general: 읽음
    const unread = await nameOf(page, chId(2)); // design: 안 읽음
    const open_ = await nameOf(page, chId(3)); // alpha: 열린 줄
    const muted = await nameOf(page, chId(4)); // zeta-room: 알림 끔 + 새 글
    const readDm = await nameOf(page, dmId(1));
    const unreadDm = await nameOf(page, dmId(2));
    const inbox = await page.getByTestId("nav-inbox").evaluate((el) => window.__measure(el)).catch(() => null);
    check(scheme, "B1 읽은 채널은 안 읽은 채널보다 연하다(글자색이 다르다)", read.color !== unread.color, { read, unread });
    check(scheme, "B2 열린 줄은 또렷하다(안 읽은 줄과 같은 색)", open_.color === unread.color, { open_, unread });
    check(scheme, "B3 알림 끈 줄은 새 글이 있어도 읽은 줄과 같은 연한 색이다", muted.color === read.color, { muted, read });
    check(scheme, "B4 읽은 DM 은 연하고 안 읽은 DM 은 또렷하다", readDm.color === read.color && unreadDm.color === unread.color, { readDm, unreadDm });
    check(scheme, "B5 연한 이름도 대비 4.5:1 이상", read.ratio >= 4.5 && readDm.ratio >= 4.5, { read: read.ratio, readDm: readDm.ratio });
    check(scheme, "B6 목적지 줄(인박스)은 짙다(읽은 줄보다 진하다)", inbox !== null && inbox.color === unread.color, { inbox, unread });
    const handles = await handlesOf(page);
    check(scheme, "B7 같은 이름 둘의 @핸들이 서고, 자기 줄의 이름과 다른 색이며 4.5:1 이상", handles.length === 2 && handles.every((h) => h.color !== h.nameColor && h.ratio >= 4.5), handles);
    // 읽은 에이전트 DM: 이름은 에이전트 정체성 색(`text-agent`)이 이긴다 — 연하게 칠하지 않는다(planner 결정 사항으로 보고).
    const agentRead = await nameOf(page, dmId(4));
    check(scheme, "B8 (보고) 읽은 에이전트 DM 의 이름 색은 연한 줄 색과 다르다 = 연하게 칠해지지 않고 에이전트 색이 이긴다", agentRead.color !== read.color, { agentRead, read });
    await shot("rest");

    // C. 낱말
    const x = rowOf(page, dmId(1));
    const box = await x.boundingBox();
    // 호버 X 는 포인터가 움직인 뒤에 선다(#3963 V): 행 안으로 들어가 몇 px 더 움직인다.
    await page.mouse.move(box.x + 30, box.y + box.height / 2);
    await page.mouse.move(box.x + 60, box.y + box.height / 2, { steps: 6 });
    await page.mouse.move(box.x + 90, box.y + box.height / 2, { steps: 6 });
    const close = page.getByTestId("dm-close");
    const closeSeen = await close.waitFor({ timeout: 3_000 }).then(() => true, () => false);
    if (closeSeen) {
      check(scheme, "C1 호버 X 의 이름이 「…, 목록에서 숨기기」", (await close.getAttribute("aria-label")) === "김도현, 목록에서 숨기기", await close.getAttribute("aria-label"));
      check(scheme, "C2 호버 X 의 툴팁 글자가 「목록에서 숨기기」", (await close.getAttribute("title")) === "목록에서 숨기기", await close.getAttribute("title"));
      await shot("hover-x");
    } else {
      check(scheme, "C1 호버 X 가 선다", false, null);
    }
    await page.mouse.move(900, 450);
    const body = await page.locator("body").innerText();
    check(scheme, "C3 화면에 옛 낱말(대화 닫기·닫은 대화·다시 열기)이 없다", !/대화 닫기|닫은 대화|다시 열기/.test(body), null);
    return { page };
  } finally {
    await browser.close();
  }
}

async function runVariants(origin, scheme) {
  // 좁은 폭(모바일 서랍 폭)과 글자 200%
  for (const [name, viewport, zoom] of [["narrow", { width: 390, height: 800 }, null], ["text200", { width: 1440, height: 900 }, "200%"]]) {
    const { browser, page } = await open(origin, scheme, viewport);
    try {
      await page.evaluate(MEASURE);
      if (zoom) await page.addStyleTag({ content: `html{font-size:${zoom} !important}` });
      if (name === "narrow") {
        const drawer = page.getByTestId("open-drawer");
        if (await drawer.count()) await drawer.first().click().catch(() => undefined);
      }
      await page.waitForTimeout(400);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(scheme, `E-${name} 가로 넘침 없음`, overflow <= 0, { overflow });
      await page.screenshot({ path: resolve(OUT_DIR, `c5775-${name}-${scheme}.png`) });
    } finally {
      await browser.close();
    }
  }
}

async function runBand(origin, scheme) {
  const { browser, page } = await open(origin, scheme, { width: 1440, height: 900 });
  try {
    await page.evaluate(MEASURE);
    await page.evaluate(() => document.documentElement.setAttribute("data-palette", "noeul"));
    await page.waitForTimeout(300);
    await rowOf(page, chId(3)).click();
    await page.mouse.move(900, 450);
    const band = await bandColor(page, scheme);
    const named = (id) => rowOf(page, id).evaluate((row, bgArg) => window.__measure(row.querySelector(":scope > span:nth-of-type(2) > span:first-child"), bgArg), band);
    const read = await named(chId(1));
    const unread = await named(chId(2));
    const handles = await handlesOf(page, band);
    check(`${scheme}-노을띠`, "D1 띠 위 읽은 이름 4.5:1 이상 · 안 읽은 줄과 다른 색", read.ratio >= 4.5 && read.color !== unread.color, { band, read, unread });
    check(`${scheme}-노을띠`, "D2 띠 위 @핸들 4.5:1 이상 · 이름과 다른 색", handles.length === 2 && handles.every((h) => h.ratio >= 4.5 && h.color !== h.nameColor), handles);
    await page.screenshot({ path: resolve(OUT_DIR, `c5775-band-${scheme}.png`), clip: { x: 0, y: 0, width: 420, height: 900 } });
  } finally {
    await browser.close();
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  try {
    for (const scheme of ["light", "dark"]) {
      await runScheme(preview.origin, scheme);
      await runVariants(preview.origin, scheme);
      await runBand(preview.origin, scheme);
    }
  } finally {
    await preview.stop?.();
  }
  const bad = results.filter((r) => !r.ok);
  writeFileSync(resolve(OUT_DIR, "c5775-results.json"), JSON.stringify(results, null, 1));
  console.log(bad.length === 0 ? `SIDEBAR-5775 PASS (${results.length} checks)` : `SIDEBAR-5775 FAIL (${bad.length}/${results.length}): ${bad.map((r) => `${r.scheme}/${r.name}`).join(" | ")}`);
  process.exit(bad.length === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
