#!/usr/bin/env node
// =============================================================================
// 사람의 접속 점 실측 + 캡처 (#4692, ADR-0160 ② 가용성).
//
// 서버가 명부 행에 싣는 `online`(접속 중 / 접속 없음 / 말하지 않음)이 웹 화면에 어떻게 서는지를 **재고** 찍는다.
// 재는 것이 먼저이고 찍는 것이 그 다음이다: `check()` 는 틀리면 끝 코드를 1 로 만든다.
//
//   npm run build && node scripts/capture-4692.mjs
//   OUT_DIR=… node scripts/capture-4692.mjs
//
// 재는 것:
//   A. 앱이 로그인하면 `online:ws<WS>` (작업공간 출석부)를 구독한다 - 소켓이 본 구독 이름으로 잰다.
//   B. DM 행: 접속 중=채운 초록, 접속 없음=속 빈 고리(배경 --surface, 테두리 --line-strong), 자리 비움=주황(접속 여부보다
//      먼저), 방해 금지=빨강, 서버가 말하지 않은 사람=점 없음, 에이전트=생존 판정의 점. 색은 토큰의 **계산값**과 맞댄다.
//   C. 멤버 목록: 사람 행의 아바타 모서리 점이 같은 규칙이고, 접근 가능한 이름이 낱말을 잇는다. 자기 행은 이 클라이언트의
//      연결(서버가 말하지 않아도 접속 중)이다. 행의 높이는 점이 있든 없든 같다.
//   D. 대화 머리: 사람 DM 의 머리에 점 + 낱말 한 줄. 모르면 없다.
//   E. 프로필: 「@핸들 · 낱말」 과 아바타 모서리 점.
//   F. 폰 폭(390): 머리의 칩은 wide-only 라 좁은 폭에서 접힌다.
// =============================================================================
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "captures/4692");
const PORT = Number(process.env.CAPTURE_PORT || 5292);
const SHOTS = process.env.SHOTS !== "0";

const workspaceId = "00000000-0000-7000-8000-000000000001";
const P = (n) => `00000000-0000-7000-8000-0000000001${n}`;
const chId = (n) => `00000000-0000-7000-8000-0000000002${String(n).padStart(2, "0")}`;
const dmId = (n) => `00000000-0000-7000-8000-0000000003${String(n).padStart(2, "0")}`;
const ME = P("01");
const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const person = (n, displayName, handle, extra = {}) => ({
  id: P(n), workspaceId, kind: "human", status: "active", displayName, handle, role: "member",
  channelCount: 1, channelIds: [chId(1)], capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...extra,
});
const agent = (n, displayName, handle, extra = {}) =>
  person(n, displayName, handle, { kind: "agent", ownerHumanId: ME, ...extra });

// [dm 번호, 상대, 기대 점 톤(null=점 없음), 낱말, 설명]
const ROWS = [
  { n: 1, peer: person("11", "이도현", "dohyun", { online: true }), tone: "ok", word: "온라인", what: "접속 중: 채운 초록" },
  { n: 2, peer: person("12", "박서연", "seoyeon", { online: false }), tone: "muted", word: "오프라인", what: "접속 없음: 속 빈 고리" },
  { n: 3, peer: person("13", "최민수", "minsu", { presenceStatus: "away", online: true }), tone: "warn", word: "자리 비움", what: "자리 비움이 접속 여부보다 먼저: 주황" },
  { n: 4, peer: person("14", "정하윤", "hayun", { presenceStatus: "dnd", online: true }), tone: "danger", word: "방해 금지", what: "방해 금지: 접속 중이어도 빨강" },
  { n: 5, peer: person("15", "김하늘", "haneul"), tone: null, word: null, what: "서버가 말하지 않음: 점 없음(모름은 오프라인이 아니다)" },
  { n: 6, peer: agent("21", "김인턴", "intern", { hostOnline: true }), tone: "ok", word: "응답함", what: "에이전트: 생존 판정의 점(사람의 접속 점이 아니다)" },
];
const roster = [person("01", "한지우", "jiwoo", { role: "owner" }), ...ROWS.map((r) => r.peer)];
const channels = [{ id: chId(1), workspaceId, kind: "public", name: "일반", muted: false }];
const dms = ROWS.map((r) => ({ id: dmId(r.n), workspaceId, kind: "dm", muted: false, memberIds: [ME, r.peer.id] }));

const results = [];
function check(scheme, name, ok, detail) {
  results.push({ scheme, name, ok: Boolean(ok), detail });
  console.log(JSON.stringify({ scheme, check: name, ok: Boolean(ok), detail }));
}
async function attempt(scheme, name, fn) {
  try {
    await fn();
  } catch (error) {
    check(scheme, `${name} (실행 실패)`, false, String(error?.message ?? error).split("\n")[0]);
  }
}

async function installMocks(context) {
  const auth = {
    accessToken: "capture-only-not-a-credential", refreshToken: "capture-only-not-a-credential",
    member: { id: ME, workspaceId, kind: "human", displayName: "한지우", handle: "jiwoo" },
    realtimeWebSocketUrl: "ws://online-4692-capture.invalid/connection/websocket",
  };
  await context.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId: ME });
    const live = /\/agents\/([^/]+)\/liveness$/.exec(path);
    if (live) return json(route, { agentMemberId: live[1], state: "responsive" });
    if (path.endsWith("/read-state")) {
      return json(route, { read_states: [...channels, ...dms].map((c) => ({ channel_id: c.id, last_read_seq: 2, latest_seq: 2, unread_count: 0, mention_count: 0, marked_unread_before_seq: null })) });
    }
    if (path.endsWith("/members/me/sidebar-prefs")) return json(route, { prefs: { version: 1, sections: [], starredChannelIds: [] } });
    if (path.endsWith("/channels")) return json(route, { channels: [...channels, ...dms] });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith(`/workspaces/${workspaceId}`)) return json(route, { workspace: { id: workspaceId, name: "달무리 스튜디오" } });
    if (path.includes("/messages")) return json(route, { messages: [] });
    return json(route, {});
  });
  await context.addInitScript(() => {
    window.__subs = [];
    class CaptureSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      constructor(url) { this.url = String(url); this.readyState = 0; queueMicrotask(() => { this.readyState = 1; this.onopen?.(new Event("open")); }); }
      send(data) {
        const replies = String(data).trim().split("\n").map((line) => {
          const c = JSON.parse(line);
          if (c.connect) return { id: c.id, connect: { client: "dot", version: "6" } };
          if (c.subscribe) { window.__subs.push(c.subscribe.channel); return { id: c.id, subscribe: { recoverable: false, positioned: false, recovered: false, epoch: "cap", offset: 0 } }; }
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
  const context = await browser.newContext({ viewport, colorScheme: scheme, serviceWorkers: "block", reducedMotion: "reduce", deviceScaleFactor: 2 });
  await installMocks(context);
  await context.addInitScript((server) => { try { if (!localStorage.getItem("momo.web.server.v1")) localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ } }, origin);
  const page = await context.newPage();
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-item").first().waitFor({ timeout: 20_000 });
  await page.getByTestId("dm-avatar").first().waitFor({ timeout: 20_000 });
  return { browser, context, page };
}

async function tokenColor(page, variable) {
  return page.evaluate((name) => {
    const probe = document.createElement("i");
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  }, variable);
}

const dmRow = (page, n) => page.locator(`[data-testid="channel-item"][data-channel-id="${dmId(n)}"]`);

async function dotOf(locator, selector) {
  return locator.evaluate((root, sel) => {
    const dot = root.querySelector(sel);
    if (!dot) return null;
    const cs = getComputedStyle(dot);
    const box = dot.getBoundingClientRect();
    return { tone: dot.getAttribute("data-tone"), bg: cs.backgroundColor, border: cs.borderTopColor, w: Math.round(box.width * 10) / 10, h: Math.round(box.height * 10) / 10 };
  }, selector);
}

async function runScheme(origin, scheme) {
  const { browser, context, page } = await open(origin, scheme, { width: 1440, height: 900 });
  try {
    await page.waitForTimeout(900);
    const c = {
      ok: await tokenColor(page, "--ok"), warn: await tokenColor(page, "--warn"), danger: await tokenColor(page, "--danger"),
      surface: await tokenColor(page, "--surface"), lineStrong: await tokenColor(page, "--line-strong"), inkMuted: await tokenColor(page, "--ink-muted"),
    };
    const want = (tone) => (tone === "muted" ? { bg: c.surface, border: c.lineStrong } : { bg: c[tone], border: null });

    await attempt(scheme, "A.rollcall", async () => {
      const subs = await page.evaluate(() => window.__subs);
      check(scheme, "A1 앱이 작업공간 출석부 `online:ws<WS>` 를 구독한다(소켓이 본 구독 이름)", subs.includes(`online:ws${workspaceId.toUpperCase()}`), subs);
      check(scheme, "A2 출석부 말고 다른 새 레일은 없다(대화 채널 구독은 열린 대화만)", subs.filter((s) => s.startsWith("online:")).length === 1, subs);
    });

    await attempt(scheme, "B.dm-rows", async () => {
      for (const r of ROWS) {
        const dot = await dotOf(dmRow(page, r.n), '[data-testid="dm-peer-dot"]');
        const name = `B${r.n} ${r.peer.displayName}: ${r.what}`;
        if (r.tone === null) check(scheme, name, dot === null, dot);
        else check(scheme, name, dot?.tone === r.tone && dot.bg === want(r.tone).bg && (want(r.tone).border === null || dot.border === want(r.tone).border) && dot.w === 8 && dot.h === 8, { dot, want: want(r.tone) });
      }
      const on = await dotOf(dmRow(page, 1), '[data-testid="dm-peer-dot"]');
      const off = await dotOf(dmRow(page, 2), '[data-testid="dm-peer-dot"]');
      check(scheme, "B7 접속 중(채운 초록)과 접속 없음(속 빈 고리)은 한 점이 아니다", on && off && on.bg !== off.bg && on.tone !== off.tone, { on, off });
      const sr = await dmRow(page, 2).locator(".sr-only").textContent();
      check(scheme, "B8 행의 숨은 글이 낱말을 잇는다(접속 없음 → 「, 오프라인」)", sr === ", 오프라인", sr);
      const unknown = await dmRow(page, 5).locator(".sr-only").count();
      check(scheme, "B9 말하지 않은 사람 행에는 숨은 상태 글도 없다", unknown === 0, unknown);
    });

    if (SHOTS) await page.screenshot({ path: resolve(OUT_DIR, `web-dm-rows-${scheme}.png`), clip: { x: 0, y: 0, width: 420, height: 760 } });

    await attempt(scheme, "C.directory", async () => {
      await page.getByTestId("nav-directory").click();
      await page.locator('[data-testid="directory-row"]').first().waitFor({ timeout: 10_000 });
      await page.waitForTimeout(500);
      const rows = await page.evaluate(() => [...document.querySelectorAll('[data-testid="directory-row"]')].map((row) => ({
        id: row.getAttribute("data-member-id"), kind: row.getAttribute("data-member-kind"), name: row.getAttribute("aria-label"),
        h: Math.round(row.getBoundingClientRect().height * 10) / 10,
        tone: row.querySelector('[data-testid="presence-dot"]')?.getAttribute("data-tone") ?? null,
      })));
      const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
      for (const r of ROWS.filter((x) => x.peer.kind === "human")) {
        const got = byId[r.peer.id];
        check(scheme, `C${r.n} 멤버 목록 ${r.peer.displayName}: ${r.what}`, got && got.tone === r.tone && (r.word === null ? !/온라인|오프라인|자리 비움|방해 금지/.test(got.name) : got.name.includes(r.word)), got);
      }
      check(scheme, "C6 에이전트 행에는 사람의 접속 점이 없다", byId[P("21")] && byId[P("21")].tone === null && !/온라인|오프라인/.test(byId[P("21")].name), byId[P("21")]);
      const self = byId[ME];
      check(scheme, "C7 자기 행은 이 클라이언트의 연결이다(서버가 말하지 않았어도 접속 중, 이름에 낱말)", self && self.tone === "ok" && self.name.includes("온라인"), self);
      const humans = rows.filter((x) => x.kind === "human");
      const heights = humans.map((x) => x.h);
      check(scheme, "C8 행의 높이는 점이 있든 없든 같다(점은 아바타 상자 안이다)", Math.max(...heights) - Math.min(...heights) <= 0.5, humans.map((x) => [x.id.slice(-2), x.tone, x.h]));
      if (SHOTS) await page.screenshot({ path: resolve(OUT_DIR, `web-directory-${scheme}.png`) });
    });

    await attempt(scheme, "D.dm-header", async () => {
      for (const r of ROWS.filter((x) => x.peer.kind === "human")) {
        // 앱 안에서 이동한다(새로고침하면 기본 채널로 가므로 DM 머리를 못 찍는다).
        await dmRow(page, r.n).click();
        await page.getByTestId("dm-profile-trigger").waitFor({ timeout: 10_000 });
        await page.waitForTimeout(300);
        const chip = await page.locator('[data-testid="channel-header"] [data-testid="human-presence"]').evaluateAll((els) => els.map((el) => ({ text: el.textContent, tone: el.getAttribute("data-tone") })));
        const ok = r.word === null ? chip.length === 0 : chip.length === 1 && chip[0].text === r.word && chip[0].tone === r.tone;
        check(scheme, `D${r.n} 대화 머리 ${r.peer.displayName}: ${r.word ?? "아무것도 서지 않는다"}`, ok, chip);
        if (SHOTS && r.n === 2) await page.screenshot({ path: resolve(OUT_DIR, `web-dm-header-${scheme}.png`), clip: { x: 0, y: 0, width: 1440, height: 140 } });
      }
    });

    await attempt(scheme, "E.profile", async () => {
      await dmRow(page, 1).click();
      await page.getByTestId("dm-profile-trigger").waitFor({ timeout: 10_000 });
      await page.getByTestId("dm-profile-trigger").click();
      const dialog = page.getByTestId("member-profile-dialog");
      await dialog.waitFor({ timeout: 10_000 });
      const text = await dialog.innerText();
      const dot = await dotOf(dialog, '[data-testid="presence-dot"]');
      check(scheme, "E1 프로필: 「@dohyun · 온라인」과 채운 초록 점", text.includes("@dohyun · 온라인") && dot?.tone === "ok" && dot.bg === c.ok, { dot, text: text.split("\n").slice(0, 3) });
      if (SHOTS) await page.screenshot({ path: resolve(OUT_DIR, `web-profile-${scheme}.png`) });
    });
  } finally {
    await context.close();
    await browser.close();
  }
}

async function runNarrow(origin) {
  const { browser, context, page } = await open(origin, "light", { width: 1440, height: 900 });
  try {
    await attempt("light", "F.narrow", async () => {
      await dmRow(page, 1).click();
      await page.getByTestId("dm-profile-trigger").waitFor({ timeout: 10_000 });
      const wide = await page.locator('[data-testid="channel-header"] [data-testid="human-presence"]').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width > 0));
      check("light", "F0 (대조) 넓은 폭에서는 같은 칩이 보인다", wide.length === 1 && wide[0] === true, wide);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(400);
      const visible = await page.locator('[data-testid="channel-header"] [data-testid="human-presence"]').evaluateAll((els) => els.map((el) => getComputedStyle(el).display !== "none" && el.getBoundingClientRect().width > 0));
      check("light", "F1 폰 폭(390)에서 머리의 칩은 접힌다(wide-only), 제목이 먼저다", visible.length === 1 && visible[0] === false, visible);
    });
  } finally {
    await context.close();
    await browser.close();
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  try {
    for (const scheme of ["light", "dark"]) await runScheme(preview.origin, scheme);
    await runNarrow(preview.origin);
  } finally {
    await preview.stop?.();
  }
  const bad = results.filter((r) => !r.ok);
  writeFileSync(resolve(OUT_DIR, "web-results.json"), JSON.stringify(results, null, 1));
  console.log(bad.length === 0 ? `ONLINE-4692 PASS (${results.length} checks)` : `ONLINE-4692 FAIL (${bad.length}/${results.length}): ${bad.map((r) => `${r.scheme}/${r.name}`).join(" | ")}`);
  process.exit(bad.length === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
