#!/usr/bin/env node
// =============================================================================
// DM 행 상태 점 실측 + 캡처 (#3964).
//
// 성재(2026-10-16): 「꺼짐은 뭐야? 에이전트고 꺼져있는 상태라는거야? 프로필의 상태 칩으로 표시해.
// buzz UI 참고해.」 DM 행은 글자 라벨 대신 아바타 모서리의 상태 점으로 사람·에이전트의 상태를 말한다.
//
// 이 스크립트는 **재는 것**이 먼저이고 찍는 것이 그 다음이다. `check()`는 틀리면 기록하고 끝 코드를 1로
// 만든다(대기는 전부 실패할 수 있는 waitFor/expect). 같은 스크립트를 변경 전 번들과 변경 후 번들에 돌려
// 적색/녹색 두 줄을 PR 에 남긴다.
//
//   npm run build && node scripts/capture-3964.mjs
//   OUT_DIR=… PREFIX=c3964 ENGINES=chromium,webkit node scripts/capture-3964.mjs
//
// 재는 것:
//   A. 행 구성: DM 행 15개의 점이 상태마다 맞는 색 역할·모양이다. 낱말이 없는 자리라 **모양이 말한다**: 채운 점 =
//      신호가 오고 있다(응답함=초록, 살아 있음·대기=채운 회색, 사람 자리 비움=주황·방해 금지=빨강), 속 빈 고리 =
//      응답을 기대하기 어렵다(조용함·꺼짐). 경고(일이 밀림·안 가져감·응답 없음·거절됨)는 owner 에게만 주황, 호스트 폴백=초록,
//      판정을 모르면 점 없음, 평범한 사람·나간 멤버=점 없음. 색은 **토큰의 계산값**과 맞댄다. **살아 있음과 꺼짐은 한 점이
//      아니다**(design-review #3964 H1).
//      점은 8x8 이고 아바타의 오른쪽 아래 모서리에 앉으며, 이름은 점이 있든 없든 같은 x 에서 시작한다.
//   B. 글자 라벨 미노출: 행의 눈에 보이는 글자에 「꺼짐」 같은 상태 낱말이 없다.
//   C. 접근성: 숨은 글에 「이름, 상태」, 툴팁(title)에 낱말과 뜻.
//   D. 나간 멤버: 이니셜을 지어내지 않고 기본 아바타.
//   E. 같은 색 체계: 멤버 목록의 에이전트 칩과 DM 행 점이 같은 톤이다.
//   F. 보는 사람이 일반 멤버이면 경고가 속 빈 고리로 내려가고, 살아 있음(채운 회색)은 그대로다.
// =============================================================================
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/dm-status-dot-3964");
const PREFIX = process.env.PREFIX || "c3964";
const PORT = Number(process.env.CAPTURE_PORT || 5264);
const ENGINES = (process.env.ENGINES || "chromium,webkit").split(",");
const SHOTS = process.env.SHOTS !== "0";

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const chId = (n) => `00000000-0000-7000-8000-0000000002${String(n).padStart(2, "0")}`;
const dmId = (n) => `00000000-0000-7000-8000-0000000003${String(n).padStart(2, "0")}`;
const P = (n) => `00000000-0000-7000-8000-0000000001${n}`;
const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const channels = ["general", "workbench"].map((name, i) => ({ id: chId(i + 1), workspaceId, kind: "public", name, muted: false }));
const person = (n, displayName, handle, extra = {}) => ({
  id: P(n), workspaceId, kind: "human", status: "active", displayName, handle, channelCount: 1, channelIds: [], capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...extra,
});
const agent = (n, displayName, handle, extra = {}) =>
  person(n, displayName, handle, { kind: "agent", ownerHumanId: P("01"), ...extra });

// 행 목록: [dm 번호, 상대, 기대 점(톤|null), 설명]. 에이전트 판정 여덟 상태가 모두 한 번씩 있다.
const ROWS = [
  { n: 1, peer: person("11", "이도현", "dohyun"), tone: null, what: "평범한 사람: 점 없음" },
  { n: 2, peer: person("12", "박서연", "seoyeon", { presenceStatus: "auto" }), tone: null, what: "auto: 점 없음(근거 없는 온라인 점 금지)" },
  { n: 3, peer: person("13", "최민수", "minsu", { presenceStatus: "away" }), tone: "warn", what: "자리 비움: 주황" },
  { n: 4, peer: person("15", "정하윤", "hayun", { presenceStatus: "dnd" }), tone: "danger", what: "방해 금지: 빨강" },
  { n: 5, peer: agent("14", "김인턴", "intern", { hostOnline: true }), live: "responsive", tone: "ok", what: "에이전트 응답함: 초록" },
  { n: 6, peer: agent("16", "헤르메스", "hermes", { hostOnline: true }), live: "alive_idle", tone: "idle", what: "에이전트 살아 있음·대기: 채운 회색(신호는 온다)" },
  { n: 7, peer: agent("17", "코비", "coby", { hostOnline: true }), live: "inactive", tone: "muted", what: "에이전트 꺼짐: 속 빈 회색 고리(호스트가 닿아 있어도 판정이 이긴다)" },
  { n: 8, peer: agent("18", "워처", "watcher"), live: "work_waiting", tone: "warn", what: "일이 기다림: owner 에게 주황" },
  { n: 9, peer: agent("19", "레거시봇", "legacy", { hostOnline: true }), live: null, tone: "ok", what: "판정 없음(404)+호스트 연결: 초록" },
  { n: 10, peer: agent("20", "조용봇", "quiet", { hostOnline: false }), live: null, tone: null, what: "판정 없음(404)+호스트 안 닿음: 점 없음" },
  { n: 11, peer: agent("21", "느림봇", "slow", { hostOnline: true }), live: "pending", tone: null, what: "판정을 아직 모름: 점 없음(호스트 폴백을 먼저 그리지 않는다)" },
  { n: 12, peer: agent("22", "새벽봇", "dawn"), live: "quiet", tone: "muted", what: "에이전트 조용함: 속 빈 회색 고리(신호가 한동안 없다)" },
  { n: 13, peer: agent("23", "먹통봇", "stuck"), live: "unresponsive", tone: "warn", what: "응답 없음: owner 에게 주황" },
  { n: 14, peer: agent("24", "막힘봇", "refused"), live: "error", tone: "warn", what: "호출이 거절됨: owner 에게 주황" },
  { n: 15, peer: agent("25", "깨움봇", "woken"), live: "woken_not_collected", tone: "warn", what: "깨웠지만 안 가져감: owner 에게 주황" },
];
const WARN_ROWS = ROWS.filter((r) => r.tone === "warn" && r.peer.kind === "agent");
const GHOST_N = ROWS.length + 1;
const GHOST = P("99");
const roster = [person("01", "곽성재", "seongjae", { role: "owner", presenceStatus: "auto" }), ...ROWS.map((r) => r.peer)];
const dm = (n, other) => ({ id: dmId(n), workspaceId, kind: "dm", muted: false, memberIds: [P("01"), other] });
const dms = [...ROWS.map((r) => dm(r.n, r.peer.id)), dm(GHOST_N, GHOST)];
const READ = Object.fromEntries([...channels.map((c) => [c.id, [3, 3]]), ...dms.map((d) => [d.id, [2, 2]])]);

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

function newState(cfg = {}) {
  return { viewerRole: "owner", ...cfg };
}

async function installMocks(context, state) {
  const auth = {
    accessToken: "capture-only-not-a-credential", refreshToken: "capture-only-not-a-credential",
    member: { id: memberId, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
    realtimeWebSocketUrl: "ws://dm-status-3964-capture.invalid/connection/websocket",
  };
  const liveness = new Map(ROWS.filter((r) => r.peer.kind === "agent").map((r) => [r.peer.id.toLowerCase(), r.live]));
  await context.route("**/v1/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId });
    const live = /\/agents\/([^/]+)\/liveness$/.exec(path);
    if (live) {
      const state_ = liveness.get(live[1].toLowerCase());
      if (state_ === "pending") return new Promise(() => undefined);
      if (state_ === null || state_ === undefined) return json(route, { error: { message: "not found" } }, 404);
      return json(route, { agentMemberId: live[1], state: state_ });
    }
    if (path.endsWith("/read-state")) {
      return json(route, { read_states: Object.entries(READ).map(([id, [last, latest]]) => ({ channel_id: id, last_read_seq: last, latest_seq: latest, unread_count: latest - last, mention_count: 0, marked_unread_before_seq: null })) });
    }
    if (path.endsWith("/members/me/sidebar-prefs")) return json(route, { prefs: { version: 1, sections: [], starredChannelIds: [] } });
    if (path.endsWith("/channels")) return json(route, { channels: [...channels, ...dms] });
    if (path.endsWith("/roster")) {
      return json(route, { members: roster.map((m) => (m.id === P("01") ? { ...m, role: state.viewerRole } : m)) });
    }
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
          if (c.connect) return { id: c.id, connect: { client: "dot", version: "6" } };
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

async function open(browserType, origin, scheme, state, viewport = { width: 1440, height: 1300 }) {
  const browser = await browserType.launch();
  const context = await browser.newContext({ viewport, colorScheme: scheme, serviceWorkers: "block", reducedMotion: "reduce", deviceScaleFactor: 2 });
  await installMocks(context, state);
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

const rowOf = (page, id) => page.locator(`[data-testid="channel-item"][data-channel-id="${id}"]`);

/** 한 DM 행의 점·글자·접근성을 한 번에 읽는다. 색은 **토큰의 계산값**과 맞댈 수 있게 계산값으로 준다. */
async function readRow(page, id) {
  return rowOf(page, id).evaluate((a) => {
    const avatar = a.querySelector('[data-testid="dm-avatar"]');
    const dot = avatar?.querySelector('[data-testid="dm-peer-dot"]') ?? null;
    const cs = dot ? getComputedStyle(dot) : null;
    const hidden = a.querySelector(".sr-only");
    // 눈에 보이는 글자: sr-only 밖의 텍스트 노드
    const visible = [...a.querySelectorAll("*")]
      .filter((el) => !el.closest(".sr-only"))
      .map((el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(""))
      .join("");
    return {
      tone: dot?.getAttribute("data-tone") ?? null,
      bg: cs?.backgroundColor ?? null,
      borderColor: cs?.borderTopColor ?? null,
      borderWidth: cs?.borderTopWidth ?? null,
      size: dot ? [Math.round(dot.getBoundingClientRect().width * 10) / 10, Math.round(dot.getBoundingClientRect().height * 10) / 10] : null,
      title: avatar?.getAttribute("title") ?? null,
      srOnly: hidden?.textContent ?? null,
      visible,
      kind: avatar?.getAttribute("data-avatar-kind") ?? null,
      defaultGlyph: Boolean(avatar?.querySelector('[data-testid="dm-avatar-default"]')),
      avatarText: avatar?.textContent ?? "",
      chip: a.querySelector('[data-testid="agent-liveness"]') !== null,
      // 위치: 점은 아바타의 오른쪽 아래 모서리에 앉고, 이름은 점이 있든 없든 같은 x 에서 시작한다.
      avatarBox: avatar ? ((r) => ({ left: r.left, right: r.right, bottom: r.bottom, width: r.width }))(avatar.getBoundingClientRect()) : null,
      dotBox: dot ? ((r) => ({ left: r.left, right: r.right, bottom: r.bottom }))(dot.getBoundingClientRect()) : null,
      nameLeft: (() => {
        const leaf = [...a.querySelectorAll("*")].find((el) => el.children.length === 0 && !el.closest(".sr-only") && !avatar?.contains(el) && (el.textContent ?? "").trim() !== "");
        return leaf ? leaf.getBoundingClientRect().left : null;
      })(),
    };
  });
}

/** CSS 변수의 계산값(rgb). 토큰이 바뀌면 이 값도 같이 바뀌므로 하드코딩 색과 맞대지 않는다. */
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

const STATUS_WORDS = /꺼짐|꺼져|응답함|살아 있음|일이 기다|조용함|응답 없음|거절/;

async function runEngine(browserType, engine, origin) {
  for (const scheme of ["light", "dark"]) {
    if (engine === "webkit" && scheme === "dark") continue;
    const state = newState();
    const { browser, context, page } = await open(browserType, origin, scheme, state);
    const full = engine === "chromium";
    try {
      // 판정 쿼리가 도착해야 점이 선다(첫 응답까지 기다린다).
      await page.waitForTimeout(900);
      const colors = {
        ok: await tokenColor(page, "--ok"),
        warn: await tokenColor(page, "--warn"),
        danger: await tokenColor(page, "--danger"),
        surface: await tokenColor(page, "--surface"),
        lineStrong: await tokenColor(page, "--line-strong"),
        inkMuted: await tokenColor(page, "--ink-muted"),
      };

      await attempt(engine, scheme, "A.rows", async () => {
        for (const r of ROWS) {
          const row = await readRow(page, dmId(r.n));
          const name = `A${r.n} ${r.peer.displayName}: ${r.what}`;
          if (r.tone === null) {
            check(engine, scheme, name, row.tone === null && row.bg === null, { tone: row.tone });
          } else if (r.tone === "idle") {
            // 채운 회색 + 면색 고리(속 빈 고리가 아니다).
            check(engine, scheme, name, row.tone === "idle" && row.bg === colors.inkMuted && row.borderColor === colors.surface, { tone: row.tone, bg: row.bg, border: row.borderColor, want: [colors.inkMuted, colors.surface] });
          } else if (r.tone === "muted") {
            check(engine, scheme, name, row.tone === "muted" && row.bg === colors.surface && row.borderColor === colors.lineStrong, { tone: row.tone, bg: row.bg, border: row.borderColor, want: [colors.surface, colors.lineStrong] });
          } else {
            check(engine, scheme, name, row.tone === r.tone && row.bg === colors[r.tone], { tone: row.tone, bg: row.bg, want: colors[r.tone] });
          }
        }
        // H1: 살아 있음(헤르메스)과 꺼짐(코비)은 한 점이 아니다 - 채움 vs 속 빈 고리.
        const idleRow = await readRow(page, dmId(6));
        const offRow = await readRow(page, dmId(7));
        check(engine, scheme, "AS4 살아 있음과 꺼짐은 다른 점이다(채운 회색 vs 속 빈 고리): 배경이 다르다", idleRow.bg !== null && offRow.bg !== null && idleRow.bg !== offRow.bg && idleRow.tone !== offRow.tone, { idle: [idleRow.tone, idleRow.bg], off: [offRow.tone, offRow.bg] });
        // 크기: 8px 점(테두리 포함).
        const sample = await readRow(page, dmId(5));
        check(engine, scheme, "AS1 점의 크기는 8x8 이다(테두리 포함)", sample.size && sample.size[0] === 8 && sample.size[1] === 8, sample.size);
        // 위치: 점이 아바타의 오른쪽 아래 모서리에 앉는다(엉뚱한 조상에 붙어 떠다니지 않는다).
        const dotted = [];
        const names = [];
        for (const r of [...ROWS, { n: GHOST_N, peer: { displayName: "나간 멤버" }, tone: null }]) {
          const row = await readRow(page, dmId(r.n));
          names.push({ n: r.n, left: row.nameLeft });
          if (row.dotBox && row.avatarBox) dotted.push({ n: r.n, dr: Math.round((row.dotBox.right - row.avatarBox.right) * 10) / 10, db: Math.round((row.dotBox.bottom - row.avatarBox.bottom) * 10) / 10 });
        }
        check(engine, scheme, "AS2 점이 아바타의 오른쪽 아래 모서리에 앉는다", dotted.length >= 11 && dotted.every((d) => Math.abs(d.dr) <= 1 && Math.abs(d.db) <= 1), dotted);
        const lefts = names.map((x) => x.left);
        check(engine, scheme, "AS3 점이 있든 없든 이름은 같은 x 에서 시작한다(행이 움직이지 않는다)", lefts.every((v) => v !== null) && Math.max(...lefts) - Math.min(...lefts) <= 0.5, names);
      });

      await attempt(engine, scheme, "B.no-label", async () => {
        const leaked = [];
        for (const r of ROWS) {
          const row = await readRow(page, dmId(r.n));
          if (STATUS_WORDS.test(row.visible) || row.chip) leaked.push({ n: r.n, visible: row.visible, chip: row.chip });
        }
        check(engine, scheme, "B1 DM 행의 눈에 보이는 글자에 상태 낱말(「꺼짐」 등)·생존 칩이 없다", leaked.length === 0, leaked);
        const body = await page.locator('[data-testid="sidebar-list-root"]').innerText();
        check(engine, scheme, "B2 사이드바 전체 글자에도 「꺼짐」이 없다", !/꺼짐/.test(body), body.match(/.{0,10}꺼짐.{0,10}/)?.[0] ?? null);
      });

      await attempt(engine, scheme, "C.a11y", async () => {
        const off = await readRow(page, dmId(7));
        check(engine, scheme, "C1 꺼짐 에이전트: 숨은 글이 「, 연결이 꺼져 있어요」", off.srOnly === ", 연결이 꺼져 있어요", off.srOnly);
        check(engine, scheme, "C2 꺼짐 에이전트: 툴팁에 낱말과 뜻", off.title?.includes("연결이 꺼져 있어요") && off.title?.includes("이 에이전트의 연결이 꺼져 있어요"), off.title);
        const name = await rowOf(page, dmId(7)).evaluate((a) => a.textContent);
        check(engine, scheme, "C3 링크의 이름이 「이름, 상태」로 읽힌다", /코비, 연결이 꺼져 있어요/.test(name ?? ""), name);
        const away = await readRow(page, dmId(3));
        check(engine, scheme, "C4 사람 자리 비움: 숨은 글 「, 자리 비움」", away.srOnly === ", 자리 비움", away.srOnly);
        const none = await readRow(page, dmId(1));
        check(engine, scheme, "C5 점이 없는 행에는 숨은 상태 글도 없다", none.srOnly === null, none.srOnly);
      });

      await attempt(engine, scheme, "D.ghost", async () => {
        const ghost = await readRow(page, dmId(GHOST_N));
        check(engine, scheme, "D1 나간 멤버: 기본 아바타(점 하나가 아니다)이고 이니셜을 지어내지 않는다", ghost.kind === "unknown" && ghost.defaultGlyph && ghost.avatarText === "" && ghost.tone === null, ghost);
      });

      if (full) {
        await attempt(engine, scheme, "shots", async () => {
          if (SHOTS) {
            await page.screenshot({ path: resolve(OUT_DIR, `${PREFIX}-rows-${scheme}.png`), clip: { x: 0, y: 0, width: 420, height: 1300 } });
            const box = await page.locator('[data-testid="sidebar-section-dms"]').boundingBox();
            if (box) await page.screenshot({ path: resolve(OUT_DIR, `${PREFIX}-dm-section-${scheme}.png`), clip: { x: Math.max(0, box.x - 8), y: box.y - 4, width: Math.min(box.width + 16, 420), height: box.height + 8 } });
          }
        });
        // E. 멤버 목록의 칩과 같은 색 체계
        await attempt(engine, scheme, "E.chips", async () => {
          await page.getByTestId("nav-directory").click();
          await page.locator('[data-testid="directory-row"][data-member-kind="agent"]').first().waitFor({ timeout: 10_000 });
          await page.waitForTimeout(900);
          const chips = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-testid="directory-row"][data-member-kind="agent"]')].map((row) => {
            const id = row.getAttribute("data-member-id");
            const chip = row.querySelector('[data-testid="agent-liveness"]');
            const dot = chip?.querySelector("span[aria-hidden]");
            return [id, chip ? { tone: chip.getAttribute("data-tone"), state: chip.getAttribute("data-state"), bg: getComputedStyle(dot).backgroundColor, text: chip.textContent } : null];
          })));
          const inkMuted = await tokenColor(page, "--ink-muted");
          const want = (r) => ({ ok: "ok", warn: "warn", idle: "neutral", muted: "neutral" })[r.tone];
          for (const r of ROWS.filter((x) => x.peer.kind === "agent" && x.live && x.live !== "pending")) {
            const chip = chips[r.peer.id];
            const name = `E${r.n} 멤버 목록 칩과 DM 행 점이 같은 톤: ${r.peer.displayName}(${r.live})`;
            // 칩의 톤(ok/neutral/warn)이 점의 톤(ok/muted/warn)과 같은 표의 같은 칸이다.
            check(engine, scheme, name, chip !== null && chip.tone === want(r), { chip, dotTone: r.tone });
            if (r.tone === "ok") check(engine, scheme, `${name}: 칩의 점 색이 점과 같다`, chip.bg === colors.ok, { chip: chip.bg, ok: colors.ok });
            if (r.tone === "muted" || r.tone === "idle") check(engine, scheme, `${name}: 칩의 점은 채운 회색(글자가 곁에 있다)`, chip.bg === inkMuted, { chip: chip.bg, inkMuted });
          }
          if (SHOTS) await page.screenshot({ path: resolve(OUT_DIR, `${PREFIX}-members-chips-${scheme}.png`) });
          await page.getByTestId("nav-directory").click();
        });
      }
    } finally {
      await context.close();
      await browser.close();
    }
  }

  // F. 일반 멤버가 보면 경고가 회색으로 내려간다.
  if (engine === "chromium") {
    const { browser, context, page } = await open(browserType, origin, "light", newState({ viewerRole: "member" }));
    try {
      await attempt(engine, "light", "F.member", async () => {
        await page.waitForTimeout(900);
        const surface = await tokenColor(page, "--surface");
        const inkMuted = await tokenColor(page, "--ink-muted");
        const demoted = [];
        for (const r of WARN_ROWS) {
          const row = await readRow(page, dmId(r.n));
          demoted.push({ n: r.n, name: r.peer.displayName, ok: row.tone === "muted" && row.bg === surface, tone: row.tone, text: row.srOnly });
        }
        check(engine, "light", "F1 일반 멤버: 경고 넷(일이 기다림·응답 없음·거절됨·안 가져감)이 속 빈 회색 고리로 내려간다(할 수 있는 일이 없는 경고는 소음이다)", demoted.length === 4 && demoted.every((d) => d.ok), demoted);
        check(engine, "light", "F2 낱말은 그대로다(같은 사실, 같은 낱말)", demoted.find((d) => d.n === 8)?.text === ", 일이 기다리는 중", demoted.map((d) => d.text));
        const idle = await readRow(page, dmId(6));
        const resp = await readRow(page, dmId(5));
        check(engine, "light", "F3 일반 멤버에게도 살아 있음은 채운 회색, 응답함은 초록 그대로다(강등은 경고만)", idle.tone === "idle" && idle.bg === inkMuted && resp.tone === "ok", { idle: [idle.tone, idle.bg], resp: resp.tone });
      });
    } finally {
      await context.close();
      await browser.close();
    }
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  try {
    if (ENGINES.includes("chromium")) await runEngine(chromium, "chromium", preview.origin);
    if (ENGINES.includes("webkit")) await runEngine(webkit, "webkit", preview.origin);
  } finally {
    await preview.stop?.();
  }
  const bad = results.filter((r) => !r.ok);
  writeFileSync(resolve(OUT_DIR, `${PREFIX}-results.json`), JSON.stringify(results, null, 1));
  console.log(bad.length === 0 ? `DM-STATUS-3964 PASS (${results.length} checks)` : `DM-STATUS-3964 FAIL (${bad.length}/${results.length}): ${bad.map((r) => `${r.engine}/${r.scheme}/${r.name}`).join(" | ")}`);
  process.exit(bad.length === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
