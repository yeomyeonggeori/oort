#!/usr/bin/env node
// =============================================================================
// 나간 멤버와의 대화는 안 읽음이 없으면 기본으로 접힌다 - 실측 + 캡처 (#4252).
//
// 성재(2026-10-20·22, 0.1.35): 「나간멤버랑 claude 왜 자꾸뜨는거야 추방하는데 ? 이제 해결된거지 ?」
//
//   npm run build && node scripts/capture-4252.mjs                               # 수리 후
//   DIST_DIR=~/.cache/momo-scratch/4252-before-dist MODE=before node scripts/capture-4252.mjs   # 수리 전
//
// 장면: 사이드바 DM 구역. 이도현(안 읽음 2) · 박서연 · kwak의 Claude(꺼진 에이전트, 명부에 **있다**) · grok ·
// 나간 멤버 둘(안 읽음 없음) · 나간 멤버 하나(안 읽은 사람 메시지 1).
//
//   수리 후(MODE=after): 안 읽음 없는 나간 멤버 둘은 접히고 「나간 멤버와의 대화 2개」가 끝에 선다. 안 읽은 하나와
//     명부에 있는 모든 DM(꺼진 에이전트 포함)은 그대로다. 줄을 펼치면 접힌 둘이 줄 아래에 서고, 그 행도 열린다.
//   수리 전(MODE=before): 나간 멤버 셋이 모두 목록에 있다(성재의 캡처와 같은 모양).
//
// 라이트·다크 × (사이드바 / 창 전체). 웹킷(데스크탑 셸의 엔진)은 라이트만 한 번 더 건다.
// =============================================================================
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/gone-dm-4252");
const PREFIX = process.env.PREFIX || "c4252";
const VIEWPORT_TAG = process.env.VIEWPORT && process.env.VIEWPORT !== "1440x900" ? `-${process.env.VIEWPORT}` : "";
const PORT = Number(process.env.CAPTURE_PORT || 5352);
const ENGINES = (process.env.ENGINES || "chromium,webkit").split(",");
const MODE = process.env.MODE === "before" ? "before" : "after";
const DIST_DIR = process.env.DIST_DIR ? resolve(process.env.DIST_DIR) : null;
const SHOTS = process.env.SHOTS !== "0";
// SCENE=only-gone: 명부에 있는 DM 이 하나도 없고 나간 멤버 DM 둘뿐인 구역(접힌 줄만 서고 「아직 대화가 없습니다」는 서지 않는다).
const SCENE = process.env.SCENE === "only-gone" ? "only-gone" : "main";

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
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
  // 꺼 두지 않은 개인 에이전트: 명부에 **있다**. 이 규칙이 접지 않는 쪽(연결이 꺼져 있을 뿐인 에이전트)이다.
  person("14", "kwak의 Claude", "kwak-claude", { kind: "agent", hostOnline: false, ownerHumanId: P("01") }),
  person("15", "grok", "grok", { kind: "agent", hostOnline: true }),
];
const dm = (n, other) => ({ id: dmId(n), workspaceId, kind: "dm", muted: false, memberIds: [P("01"), other] });
// 8·9: 명부에 없는 상대(나감·정지·꺼 둔 개인 에이전트). 안 읽음 없음. 7: 안 읽은 메시지가 있는 나간 멤버.
const GONE_READ_A = dmId(8);
const GONE_READ_B = dmId(9);
const GONE_UNREAD = dmId(7);
const dms =
  SCENE === "only-gone"
    ? [dm(8, P("98")), dm(9, P("99"))]
    : [dm(1, P("11")), dm(2, P("12")), dm(4, P("14")), dm(5, P("15")), dm(8, P("98")), dm(7, P("97")), dm(9, P("99"))];

// 서버 read-state 투영. [마지막으로 읽은 seq, 최신 seq]
const READ = {
  [chId(1)]: [47, 50], [chId(2)]: [20, 20], [chId(3)]: [8, 8], [chId(4)]: [12, 12], [chId(5)]: [30, 30],
  [dmId(1)]: [10, 12], [dmId(2)]: [5, 5], [dmId(4)]: [9, 9], [dmId(5)]: [4, 4],
  [GONE_READ_A]: [6, 6], [GONE_UNREAD]: [3, 4], [GONE_READ_B]: [3, 3],
};
const LIVENESS = { [P("14")]: "inactive", [P("15")]: "responsive" };

const results = [];
function check(engine, scheme, name, ok, detail) {
  results.push({ engine, scheme, name, ok: Boolean(ok), detail });
  console.log(JSON.stringify({ engine, scheme, check: name, ok: Boolean(ok), detail }));
}
async function attempt(engine, scheme, name, fn) {
  try {
    await fn();
  } catch (error) {
    check(engine, scheme, `${name} (실행 실패)`, false, String(error?.message ?? error).split("\n")[0]);
  }
}

const DEFAULT_PREFS = { version: 1, sections: [{ id: "sec-1", name: "출시 준비", order: 0, channelIds: [chId(5)] }], starredChannelIds: [chId(3)] };
const wireRead = (id) => ({
  channel_id: id, last_read_seq: READ[id][0], latest_seq: READ[id][1],
  unread_count: Math.max(0, READ[id][1] - READ[id][0]), mention_count: 0, marked_unread_before_seq: null,
});

async function installMocks(context) {
  const auth = {
    accessToken: "capture-only-not-a-credential", refreshToken: "capture-only-not-a-credential",
    member: { id: memberId, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
    realtimeWebSocketUrl: "ws://gone-dm-4252-capture.invalid/connection/websocket",
  };
  await context.route("**/v1/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId });
    if (/\/channels\/([^/]+)\/read-state$/.test(path) && req.method() === "PUT") {
      const id = /\/channels\/([^/]+)\/read-state$/.exec(path)[1];
      const body = JSON.parse(req.postData() ?? "{}");
      if (body.read_intent === "explicit_open" && READ[id]) READ[id][0] = READ[id][1];
      return json(route, READ[id] ? wireRead(id) : {});
    }
    if (path.endsWith("/read-state")) return json(route, { read_states: Object.keys(READ).map(wireRead) });
    if (path.endsWith("/members/me/sidebar-prefs")) return json(route, { prefs: DEFAULT_PREFS });
    const live = /\/agents\/([^/]+)\/liveness$/.exec(path);
    if (live) return json(route, { agentMemberId: live[1], state: LIVENESS[live[1].toUpperCase()] ?? LIVENESS[live[1]] ?? "inactive" });
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
  // 나간 멤버 DM 뿐인 구역은 수리 후 기본으로 접혀 DM 아바타가 하나도 없다: 그때는 접힌 줄을 기다린다.
  if (SCENE === "only-gone" && MODE === "after") await page.getByTestId("gone-dm-toggle").waitFor({ timeout: 20_000 });
  else await page.getByTestId("dm-avatar").first().waitFor({ timeout: 20_000 });
}

// VIEWPORT=900x720 처럼 창 크기를 바꿔 같은 장면을 찍는다(검수 phase 2: 1280·900 폭). 기본은 1440x900.
const [VIEWPORT_W, VIEWPORT_H] = (process.env.VIEWPORT || "1440x900").split("x").map(Number);
async function open(browserType, origin, scheme, viewport = { width: VIEWPORT_W, height: VIEWPORT_H }) {
  const browser = await browserType.launch();
  const context = await browser.newContext({ viewport, colorScheme: scheme, serviceWorkers: "block", reducedMotion: "reduce" });
  await installMocks(context);
  await context.addInitScript((server) => { try { if (!localStorage.getItem("momo.web.server.v1")) localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ } }, origin);
  const page = await context.newPage();
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await login(page);
  await page.getByTestId("sidebar-section-sec-1").waitFor({ timeout: 20_000 });
  return { browser, context, page };
}

const rowOf = (page, id) => page.locator(`[data-testid="channel-item"][data-channel-id="${id}"]`);

/**
 * DM 구역 끝이 화면에 들어오게 내린다(1440×900 에서는 DM 구역이 접힘선 아래에 있다). 구역의 끝을 `scrollIntoView` 로 맞추면
 * 중첩된 스크롤 상자를 브라우저가 알아서 따라 내린다: 창 높이가 780 이하면 사이드바 목록의 스크롤 구조가 달라지기 때문이다.
 */
const scrollDmsIntoView = (page) =>
  page.evaluate(() => {
    const section = document.querySelector('[data-testid="sidebar-section-dms"]');
    section?.scrollIntoView({ block: "end" });
  });

/** 이 행이 가장 가까운 스크롤 상자 안에서 눈에 보이는가(잘리지 않고 전부). */
const visibleInScrollport = (page, id) =>
  page.evaluate((channelId) => {
    const row = document.querySelector(`[data-testid="channel-item"][data-channel-id="${channelId}"]`);
    if (!row) return false;
    let box = row.parentElement;
    while (box && box.scrollHeight <= box.clientHeight + 1) box = box.parentElement;
    if (!box) return true;
    const r = row.getBoundingClientRect();
    const c = box.getBoundingClientRect();
    return r.top >= c.top - 1 && r.bottom <= c.bottom + 1;
  }, id);

/** 나간 멤버 DM 뿐인 구역: 빈 안내(아직 대화가 없습니다)는 서지 않고 접힌 줄만 선다. */
async function runOnlyGone(browserType, engine, origin) {
  for (const scheme of engine === "chromium" ? ["light", "dark"] : ["light"]) {
    const { browser, context, page } = await open(browserType, origin, scheme);
    const shot = async (name) => {
      if (!SHOTS) return;
      await scrollDmsIntoView(page);
      await page.waitForTimeout(200);
      await page.screenshot({ path: resolve(OUT_DIR, `${PREFIX}${VIEWPORT_TAG}-${MODE}-${engine}-${name}-${scheme}.png`), clip: { x: 0, y: 0, width: 420, height: Math.min(900, VIEWPORT_H) } });
    };
    const settle = () => page.waitForTimeout(1200);
    const shown = (id) => rowOf(page, id).count().then((n) => n > 0);
    try {
      await attempt(engine, scheme, "O.only-gone", async () => {
        await page.mouse.move(900, 450);
        await settle();
        if (MODE === "before") {
          check(engine, scheme, "OB0 수리 전: 나간 멤버 둘이 목록에 그대로 있다", (await shown(GONE_READ_A)) && (await shown(GONE_READ_B)), null);
          await shot("sidebar-only-gone");
          return;
        }
        const toggle = page.getByTestId("gone-dm-toggle");
        const empty = page.getByTestId("dm-section-empty");
        check(engine, scheme, "O0 나간 멤버 DM 뿐이면 목록에는 아무 행도 없다", !(await shown(GONE_READ_A)) && !(await shown(GONE_READ_B)), null);
        check(engine, scheme, "O1 「아직 대화가 없습니다」는 서지 않고 접힌 줄만 선다(한 화면이 없다와 2개 있다를 같이 말하지 않는다)", (await empty.count()) === 0 && (await toggle.innerText()).trim() === "나간 멤버와의 대화 2개", null);
        await shot("sidebar-only-gone");
        await toggle.click();
        await page.mouse.move(900, 450);
        await settle();
        check(engine, scheme, "O2 펼치면 접힌 둘이 줄 아래에 선다", (await shown(GONE_READ_A)) && (await shown(GONE_READ_B)), null);
        await shot("sidebar-only-gone-expanded");
      });
    } finally {
      await context.close();
      await browser.close();
    }
  }
}

async function runEngine(browserType, engine, origin) {
  if (SCENE === "only-gone") return runOnlyGone(browserType, engine, origin);
  for (const scheme of engine === "chromium" ? ["light", "dark"] : ["light"]) {
    const { browser, context, page } = await open(browserType, origin, scheme);
    // `scroll: false` 는 하네스가 스크롤을 대신하지 않는다: 앱이 스스로 맞춘 모양 그대로 찍는다(펼침·열린 행의 증거).
    const shot = async (name, clip = { x: 0, y: 0, width: 420, height: Math.min(900, VIEWPORT_H) }, { scroll = true } = {}) => {
      if (!SHOTS) return;
      if (scroll) await scrollDmsIntoView(page);
      await page.waitForTimeout(200);
      await page.screenshot({ path: resolve(OUT_DIR, `${PREFIX}${VIEWPORT_TAG}-${MODE}-${engine}-${name}-${scheme}.png`), clip });
    };
    const shown = (id) => rowOf(page, id).count().then((n) => n > 0);
    const settle = () => page.waitForTimeout(1200);
    try {
      await attempt(engine, scheme, "G.fold", async () => {
        await page.mouse.move(900, 450);
        await settle();
        const toggle = page.getByTestId("gone-dm-toggle");
        const hasToggle = (await toggle.count()) > 0;
        const rows = await page.locator('[data-testid="channel-item"][data-channel-id^="00000000-0000-7000-8000-0000000003"]').count();
        const names = await page.locator('[data-testid="channel-item"][data-channel-id^="00000000-0000-7000-8000-0000000003"]').allInnerTexts();
        console.log(JSON.stringify({ engine, scheme, mode: MODE, dmRows: rows, names, toggle: hasToggle }));
        if (MODE === "before") {
          check(engine, scheme, "B0 수리 전: 나간 멤버 셋이 모두 목록에 있다", (await shown(GONE_READ_A)) && (await shown(GONE_READ_B)) && (await shown(GONE_UNREAD)), names);
          check(engine, scheme, "B1 수리 전: 접힌 줄이 없다", !hasToggle, null);
          await shot("sidebar");
          await shot("window", { x: 0, y: 0, width: VIEWPORT_W, height: VIEWPORT_H });
          return;
        }
        check(engine, scheme, "G0 안 읽음 없는 나간 멤버 둘은 목록에서 접힌다", !(await shown(GONE_READ_A)) && !(await shown(GONE_READ_B)), names);
        check(engine, scheme, "G1 구역 끝의 줄이 「나간 멤버와의 대화 2개」를 센다", hasToggle && (await toggle.innerText()).trim() === "나간 멤버와의 대화 2개", hasToggle ? await toggle.innerText() : null);
        check(engine, scheme, "G2 안 읽은 나간 멤버 DM 은 접히지 않는다(알약 1)", (await shown(GONE_UNREAD)) && (await rowOf(page, GONE_UNREAD).locator('[data-testid="unread-count"]').innerText()) === "1", null);
        check(engine, scheme, "G3 명부에 있는 DM(꺼진 에이전트 포함)은 그대로다", (await shown(dmId(1))) && (await shown(dmId(2))) && (await shown(dmId(4))) && (await shown(dmId(5))), null);
        check(engine, scheme, "G4 접힌 줄은 DM 구역의 마지막 줄이다", await page.evaluate(() => {
          const t = document.querySelector('[data-testid="gone-dm-toggle"]')?.closest("li");
          return t !== null && t?.nextElementSibling === null;
        }), null);
        await shot("sidebar");
        await shot("window", { x: 0, y: 0, width: VIEWPORT_W, height: VIEWPORT_H });
        // 사람은 줄을 찾으려고 목록 맨 아래까지 내린 뒤 누른다: 하네스가 스크롤을 대신하지 않는다(design-review M1).
        await scrollDmsIntoView(page);
        await toggle.click();
        await page.mouse.move(900, 450);
        await settle();
        check(engine, scheme, "G5 펼치면 접힌 둘이 줄 아래에 선다", (await shown(GONE_READ_A)) && (await shown(GONE_READ_B)) && (await toggle.getAttribute("aria-expanded")) === "true", null);
        check(engine, scheme, "G5b 펼친 직후 접힌 행이 스크롤 상자 안에 보인다(앱이 스스로 맞춘다, 하네스 스크롤 없음)", (await visibleInScrollport(page, GONE_READ_A)) && (await visibleInScrollport(page, GONE_READ_B)), null);
        check(engine, scheme, "G6 접힌 행은 기본 아바타와 「나간 멤버」다", (await rowOf(page, GONE_READ_A).innerText()).includes("나간 멤버") && (await rowOf(page, GONE_READ_A).locator('[data-testid="dm-avatar-default"]').count()) === 1, null);
        await shot("sidebar-expanded", undefined, { scroll: false });
        // 키보드로 접힌 행을 연다(design-review H1): 캐럿이 그 행에 남고 행은 접힌 목록의 제자리에 머문다.
        await rowOf(page, GONE_READ_A).focus();
        await page.keyboard.press("Enter");
        await settle();
        check(engine, scheme, "G7 접힌 행을 열면 그 대화가 열린다(주소 /c/…)", page.url().toLowerCase().endsWith(`/c/${GONE_READ_A}`.toLowerCase()), page.url());
        check(engine, scheme, "G7b Enter 뒤에도 캐럿이 그 행에 있다(<body> 로 떨어지지 않는다)", await page.evaluate((id) => document.activeElement?.getAttribute("data-channel-id")?.toLowerCase() === id.toLowerCase(), GONE_READ_A), await page.evaluate(() => document.activeElement?.tagName));
        check(engine, scheme, "G7c 열린 행은 접힌 목록의 제자리에 머물고 선택 표시만 바뀐다(점프 없음, 줄은 그대로 2개)", (await page.evaluate(() => document.querySelector('[data-testid="gone-dm-list"] [data-testid="channel-item"][aria-current="page"]') !== null)) && (await toggle.innerText()).trim() === "나간 멤버와의 대화 2개", await toggle.innerText());
        await shot("sidebar-open-gone-expanded", undefined, { scroll: false });
        // 줄을 접으면 열려 있는 나간 멤버 DM 은 위 목록으로 올라와 남고(보던 대화가 사라지지 않는다), 줄의 수만 하나 준다.
        await toggle.click();
        await page.mouse.move(900, 450);
        await settle();
        check(engine, scheme, "G8 줄을 접으면 열려 있는 나간 멤버 DM 은 위 목록에 남고, 줄은 남은 하나를 센다", (await shown(GONE_READ_A)) && !(await shown(GONE_READ_B)) && (await toggle.innerText()).trim() === "나간 멤버와의 대화 1개", await toggle.innerText());
        await shot("sidebar-open-gone");
        // 다른 대화로 옮겨 가면 다시 접힌 줄로 돌아간다.
        await rowOf(page, dmId(2)).click();
        await settle();
        check(engine, scheme, "G9 다른 곳으로 옮겨 가면 접힌 줄로 돌아간다(둘)", !(await shown(GONE_READ_A)) && (await toggle.innerText()).trim() === "나간 멤버와의 대화 2개", await toggle.innerText());
      });
    } finally {
      await context.close();
      await browser.close();
    }
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({
    webRoot: WEB_ROOT,
    port: PORT,
    portEnvVar: "CAPTURE_PORT",
    extraArgs: DIST_DIR ? ["--outDir", DIST_DIR] : [],
  });
  try {
    if (ENGINES.includes("chromium")) await runEngine(chromium, "chromium", preview.origin);
    if (ENGINES.includes("webkit")) await runEngine(webkit, "webkit", preview.origin);
  } finally {
    await preview.stop?.();
  }
  const bad = results.filter((r) => !r.ok);
  writeFileSync(resolve(OUT_DIR, `${PREFIX}${VIEWPORT_TAG}-${MODE}-results.json`), JSON.stringify(results, null, 1));
  console.log(bad.length === 0 ? `GONE-DM-4252 ${MODE} PASS (${results.length} checks)` : `GONE-DM-4252 ${MODE} FAIL (${bad.length}/${results.length}): ${bad.map((r) => `${r.engine}/${r.scheme}/${r.name}`).join(" | ")}`);
  process.exit(bad.length === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
