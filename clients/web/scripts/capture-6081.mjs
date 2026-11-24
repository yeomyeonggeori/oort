#!/usr/bin/env node
// =============================================================================
// 단축키 창 — 선 걷기 · 두 열 · 찾기 · 「단축키 바꾸기」 실측 + 캡처 (#6081, 2026-11-20 시안 장면 2).
//
//   npm run build:design && node scripts/capture-6081.mjs
//   PHASE=before|after OUT_DIR=… CAPTURE_PORT=… DSF=2 node scripts/capture-6081.mjs
//
// 재는 것(PHASE=after 에서 틀리면 끝 코드 1, before 는 기록만):
//   W. 폭 1280 · 720(데스크탑 최소): 창 폭 640 · 열 2개. 폭 390: 열 1개. 어느 폭이든 창 · 문서 가로 넘침 0px.
//   L. 줄 사이 선 0개: 창 안에서 위 · 아래 테두리가 있는 요소는 찾기 칸(입력 그릇) 하나뿐.
//   F. 찾기: 열리면 초점이 찾기 칸. 「설정」을 치면 전체 줄 수 → 맞는 줄 수. 없는 말이면 빈 상태 문장이 선다.
//      한글 조합 중(CDP Input.imeSetComposition, 두벌식 차례)에도 맞는 줄이 프레임마다 남는다.
//   K. Esc 로 닫히면 초점이 연 단추로 돌아간다. 「단축키 바꾸기」를 누르면 설정 › 단축키가 열린다.
//   H. 마우스를 올린 줄만 바탕이 바뀐다.
//   Z. 글자 200%: 창 안에서 잘리는 글(scrollWidth > clientWidth) 0.
// 찍는 것: 밝게/어둡게 × (1280 · 720 · 390 · 글자 200% · 찾는 중 · 빈 상태 · 가리킨 줄).
// =============================================================================
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as playwright from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PHASE = process.env.PHASE || "after";
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "captures/6081", PHASE);
const PORT = Number(process.env.CAPTURE_PORT || 26081);
const DSF = Number(process.env.DSF || 2);
const AFTER = PHASE === "after";

const workspaceId = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const CH = "00000000-0000-7000-8000-000000000201";
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
// 가상 인물만.
const roster = [
  { id: ME, workspaceId, kind: "human", status: "active", displayName: "김도현", handle: "dohyeon", role: "owner", channelCount: 1, channelIds: [CH], capabilities: [], createdAtMs: 0, updatedAtMs: 0, online: true, email: "dohyeon@example.com" },
];
const channels = [{ id: CH, workspaceId, kind: "public", name: "일반", muted: false }];

const results = [];
function check(scene, name, ok, detail) {
  results.push({ scene, name, ok: Boolean(ok), detail });
  console.log(JSON.stringify({ scene, check: name, ok: Boolean(ok), detail }));
}
const record = (scene, name, detail) => {
  results.push({ scene, name, ok: true, detail, recordOnly: true });
  console.log(JSON.stringify({ scene, record: name, detail }));
};
const expect = (scene, name, ok, detail) => (AFTER ? check(scene, name, ok, detail) : record(scene, name, detail));
async function attempt(scene, name, fn) {
  try {
    await fn();
  } catch (error) {
    check(scene, name + " (실행 실패)", false, String(error?.message ?? error).split("\n")[0]);
  }
}

async function installMocks(context) {
  const auth = {
    accessToken: "capture-only-not-a-credential", refreshToken: "capture-only-not-a-credential",
    member: { id: ME, workspaceId, kind: "human", displayName: "김도현", handle: "dohyeon" },
    realtimeWebSocketUrl: "ws://dots-6081-capture.invalid/connection/websocket",
  };
  await context.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId: ME });
    if (path.endsWith("/read-state")) return json(route, { read_states: channels.map((c) => ({ channel_id: c.id, last_read_seq: 0, latest_seq: 0, unread_count: 0, mention_count: 0, marked_unread_before_seq: null })) });
    if (path.endsWith("/members/me/sidebar-prefs")) return json(route, { prefs: { version: 1, sections: [], starredChannelIds: [] } });
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/workspaces/" + workspaceId)) return json(route, { workspace: { id: workspaceId, name: "달무리 스튜디오" } });
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
          if (c.connect) return { id: c.id, connect: { client: "dots", version: "6" } };
          if (c.subscribe) return { id: c.id, subscribe: { recoverable: false, positioned: false, recovered: false, epoch: "cap", offset: 0 } };
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
  const browser = await playwright.chromium.launch();
  const context = await browser.newContext({ viewport, colorScheme: scheme, serviceWorkers: "block", reducedMotion: "reduce", deviceScaleFactor: DSF, locale: "ko-KR" });
  await installMocks(context);
  await context.addInitScript((server) => { try { if (!localStorage.getItem("momo.web.server.v1")) localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ } }, origin);
  const page = await context.newPage();
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-item").first().waitFor({ timeout: 30_000 }).catch(() => undefined);
  await page.waitForTimeout(500);
  return { browser, page };
}

/** 「?」로 연다(어느 폭에서나 사이드바 단추가 보이는 것은 아니다). 연 자리는 body. */
async function openByKey(page) {
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  await page.keyboard.press("Shift+Slash");
  await page.getByTestId("shortcut-help-dialog").waitFor({ timeout: 10_000 });
  await page.waitForTimeout(300);
}

async function geometry(page) {
  return page.getByTestId("shortcut-help-dialog").evaluate((dlg) => {
    const box = dlg.getBoundingClientRect();
    const rows = [...dlg.querySelectorAll("[data-shortcut-id]")].filter((el) => el.getClientRects().length > 0);
    const xs = [...new Set(rows.map((el) => Math.round(el.getBoundingClientRect().left)))];
    // 선: 창 안 요소 가운데 위 · 아래 테두리가 보이는 것. 입력 그릇(찾기 칸)은 선이 아니라 컨트롤 테두리다.
    const lines = [...dlg.querySelectorAll("*")].filter((el) => {
      if (el.tagName === "INPUT") return false;
      const cs = getComputedStyle(el);
      const top = parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== "none";
      const bottom = parseFloat(cs.borderBottomWidth) > 0 && cs.borderBottomStyle !== "none";
      return (top || bottom) && el.getClientRects().length > 0;
    }).map((el) => (el.getAttribute("data-testid") || el.getAttribute("data-shortcut-id") || el.tagName.toLowerCase()));
    const clipped = [...dlg.querySelectorAll("dt, dd, h2, h3, span, p, kbd, button, label")].filter((el) => el.getClientRects().length > 0 && el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== "visible").map((el) => el.textContent?.trim().slice(0, 30));
    const offscreen = rows.filter((el) => { const b = el.getBoundingClientRect(); return b.right > box.right + 0.5 || b.left < box.left - 0.5; }).length;
    const rowH = rows.map((el) => Math.round(el.getBoundingClientRect().height));
    return {
      width: Math.round(box.width * 100) / 100,
      height: Math.round(box.height),
      columns: xs.length,
      rows: rows.length,
      rowHeights: [...new Set(rowH)],
      lines,
      clipped,
      offscreen,
      dialogOverflowX: dlg.scrollWidth - dlg.clientWidth,
      docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      focus: document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.tagName ?? null,
    };
  });
}

const shot = (page, name) => page.getByTestId("shortcut-help-dialog").screenshot({ path: resolve(OUT_DIR, name + ".png") });

async function runWidth(origin, scheme, width, height, { text = null } = {}) {
  const label = text ? "text200" : String(width);
  const scene = label + "-" + scheme;
  const { browser, page } = await open(origin, scheme, { width, height });
  try {
    await attempt(scene, "열고 재기", async () => {
      if (text) await page.addStyleTag({ content: "html{font-size:" + text + " !important}" });
      await openByKey(page);
      const g = await geometry(page);
      record(scene, "기하", g);
      if (width >= 720) {
        expect(scene, "W1 창 폭 640", Math.abs(g.width - 640) < 0.5, g.width);
        // 열 문턱은 몸 폭 @xl(36rem)이라 글자 200%에서는 rem 이 두 배가 되어 한 열로 접힌다(의도).
        if (text) expect(scene, "W2b 글자 200% 는 한 열", g.columns === 1, g.columns);
        else expect(scene, "W2 열 2개", g.columns === 2, g.columns);
      } else {
        expect(scene, "W3 좁은 창 열 1개", g.columns === 1, g.columns);
      }
      expect(scene, "W4 가로 넘침 0px(창 · 문서 · 줄)", g.dialogOverflowX <= 0 && g.docOverflowX <= 0 && g.offscreen === 0, { dialog: g.dialogOverflowX, doc: g.docOverflowX, offscreenRows: g.offscreen });
      expect(scene, "L1 줄 사이 선 0개", g.lines.length === 0, g.lines);
      if (text) expect(scene, "Z1 글자 200% 잘리는 글 0", g.clipped.length === 0, g.clipped);
      await shot(page, "dialog-" + label + "-" + scheme);
      await page.screenshot({ path: resolve(OUT_DIR, "page-" + label + "-" + scheme + ".png") });
    });
  } finally {
    await browser.close();
  }
}

async function runInteractions(origin, scheme) {
  const scene = "interact-" + scheme;
  const { browser, page } = await open(origin, scheme, { width: 1280, height: 820 });
  try {
    await attempt(scene, "열기 · 초점", async () => {
      const trigger = page.getByTestId("shortcut-help-trigger");
      await trigger.click();
      await page.getByTestId("shortcut-help-dialog").waitFor();
      await page.waitForTimeout(300);
      const g = await geometry(page);
      expect(scene, "F1 열리면 초점이 찾기 칸", g.focus === "shortcut-help-search", g.focus);
      // 가리킨 줄만 바탕이 바뀐다.
      const rows = page.locator('[data-testid="shortcut-help-dialog"] [data-shortcut-id]');
      const before = await rows.evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor));
      await rows.nth(1).hover();
      await page.waitForTimeout(250);
      const after = await rows.evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor));
      const changed = after.map((bg, i) => bg !== before[i]).map((c, i) => (c ? i : -1)).filter((i) => i >= 0);
      expect(scene, "H1 가리킨 줄만 바탕이 바뀐다", changed.length === 1 && changed[0] === 1, { changed, hovered: after[1], rest: after[0] });
      await shot(page, "hover-" + scheme);
      await page.mouse.move(2, 2);
      // Esc 로 닫으면 초점이 연 단추로.
      await page.keyboard.press("Escape");
      await page.getByTestId("shortcut-help-dialog").waitFor({ state: "detached", timeout: 5_000 });
      const focus = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
      check(scene, "K1 Esc 뒤 초점이 연 단추로", focus === "shortcut-help-trigger", focus);
    });
    if (!AFTER) return;
    await attempt(scene, "찾기", async () => {
      await openByKey(page);
      const total = (await geometry(page)).rows;
      await page.keyboard.type("설정");
      await page.waitForTimeout(200);
      const g1 = await geometry(page);
      const kept = await page.locator('[data-testid="shortcut-help-dialog"] [data-shortcut-id]').evaluateAll((els) => els.map((el) => el.getAttribute("data-shortcut-id")));
      check(scene, "F2 「설정」→ 맞는 줄만", total > g1.rows && g1.rows >= 1 && kept.includes("open-settings"), { total, kept });
      await shot(page, "search-" + scheme);
      await page.getByTestId("shortcut-help-search").fill("없는낱말");
      await page.waitForTimeout(200);
      const empty = await page.getByTestId("shortcut-help-empty").textContent().catch(() => null);
      const g2 = await geometry(page);
      check(scene, "F3 0건이면 빈 상태 문장", g2.rows === 0 && Boolean(empty), { rows: g2.rows, empty });
      await shot(page, "empty-" + scheme);
      // 입력 칸 안의 ?는 글자다.
      await page.getByTestId("shortcut-help-search").fill("");
      await page.keyboard.press("Shift+Slash");
      const typed = await page.getByTestId("shortcut-help-search").inputValue();
      check(scene, "F4 찾기 칸 안의 ?는 글자로 들어간다", typed === "?", typed);
      await page.getByTestId("shortcut-help-search").fill("");
      // 한글 조합 중: 두벌식으로 「탐색」을 치는 차례. 줄이 프레임마다 남는지.
      const cdp = await page.context().newCDPSession(page);
      const steps = ["ㅌ", "타", "탐", "탐ㅅ", "탐새", "탐색"];
      const frames = [];
      for (const s of steps) {
        await cdp.send("Input.imeSetComposition", { text: s, selectionStart: s.length, selectionEnd: s.length });
        for (let f = 0; f < 2; f += 1) {
          const ids = await page.evaluate(() => new Promise((res) => requestAnimationFrame(() => res([...document.querySelectorAll('[data-testid="shortcut-help-dialog"] [data-shortcut-id]')].map((el) => el.getAttribute("data-shortcut-id"))))));
          frames.push({ step: s, frame: f, value: await page.getByTestId("shortcut-help-search").inputValue(), rows: ids.length, sidebar: ids.includes("toggle-sidebar") });
        }
      }
      await cdp.send("Input.insertText", { text: "탐색" });
      await page.waitForTimeout(150);
      const committed = await page.locator('[data-testid="shortcut-help-dialog"] [data-shortcut-id]').evaluateAll((els) => els.map((el) => el.getAttribute("data-shortcut-id")));
      const mid = frames.filter((fr) => fr.step !== "ㅌ");
      check(scene, "F5 한글 조합 중에도 「탐색 패널」 줄이 프레임마다 남는다(타~탐색)", mid.every((fr) => fr.sidebar) && frames.some((fr) => fr.rows < total), frames);
      check(scene, "F6 조합 끝 「탐색」 → 맞는 줄", committed.includes("toggle-sidebar") && committed.length < total, { committed, total });
      await shot(page, "compose-" + scheme);
    });
    await attempt(scene, "단축키 바꾸기", async () => {
      await page.getByTestId("shortcut-help-search").fill("");
      await page.getByTestId("shortcut-help-change").click();
      await page.waitForURL(/\/settings\?section=shortcuts/, { timeout: 10_000 });
      const dialogGone = (await page.getByTestId("shortcut-help-dialog").count()) === 0;
      const heading = await page.locator("main h1, main h2").first().textContent().catch(() => null);
      check(scene, "K2 「단축키 바꾸기」→ 설정 › 단축키", dialogGone && page.url().includes("section=shortcuts"), { url: page.url(), heading });
      await page.screenshot({ path: resolve(OUT_DIR, "settings-shortcuts-" + scheme + ".png") });
    });
  } finally {
    await browser.close();
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  try {
    for (const scheme of ["light", "dark"]) {
      await runWidth(preview.origin, scheme, 1280, 820);
      await runWidth(preview.origin, scheme, 720, 720);
      await runWidth(preview.origin, scheme, 390, 800);
      await runWidth(preview.origin, scheme, 1280, 820, { text: "200%" });
      await runInteractions(preview.origin, scheme);
    }
  } finally {
    await preview.stop?.();
  }
  const bad = results.filter((r) => !r.ok);
  writeFileSync(resolve(OUT_DIR, "c6081-results.json"), JSON.stringify(results, null, 1));
  console.log(bad.length === 0 ? "SHORTCUT-6081 " + PHASE + " PASS (" + results.length + " rows)" : "SHORTCUT-6081 " + PHASE + " FAIL (" + bad.length + "/" + results.length + "): " + bad.map((r) => r.scene + "/" + r.name).join(" | "));
  process.exit(bad.length === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
