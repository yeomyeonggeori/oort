#!/usr/bin/env node
// =============================================================================
// #5173 레인: 호버 툴바와 **중단 시스템 줄**의 겹침 (검증 줄 3회차 화면 검수 B2, #5129 가 만든 결함).
//
//   npm run build && node scripts/capture-5173.mjs
//   DIST_DIR=<다른 dist> node scripts/capture-5173.mjs     # 고치기 전 번들로 RED 를 다시 볼 때
//   SHOTS=1 OUT_DIR=<dir> node scripts/capture-5173.mjs    # 캡처도 찍기(기본은 재기만)
//
// 재는 것(390·1440 × 밝음·어두움, 각 칸 아래 「포인터가 선 행」 네 가지):
//   R_b          줄 **아래** 행에 포인터, 툴바는 그 행의 위 경계를 걸친다(straddle top) → 줄 바닥을 36px 덮는 자리.
//   R_a 뒤집힘   줄 **위** 행이 스크롤러 맨 위에 걸려 툴바가 행 아래로 뒤집힌다(straddle below) → 줄 윗단을 36px 덮는 자리.
//                (검수 캡처 `5129-stop-line-live-390-*` 가 정확히 이 칸이다.)
//   R_a 가운데   줄 위 행이 화면 가운데 → 툴바는 행 위(줄 반대쪽)라 줄을 못 닿는다. 대조.
//   R_b 뒤집힘   줄 아래 행이 스크롤러 맨 위 → 툴바는 행 아래(줄 반대쪽). 대조.
//
// 단정은 레인 공용 자(`./lib/hoverToolbarOverlap.mjs`, `capture-screens.mjs` 와 한 벌)를 그대로 부른다. 그 위에 이 레인이 더하는 것:
//   - 칸마다 툴바가 **기대한 자리**(`data-straddle`)에 있었는가: 엉뚱한 자리를 재면서 초록이 되는 것을 막는다.
//   - **양성 대조**: 자가 이웃으로 시스템 줄을 실제로 봤는가(`looked`), 줄 글자가 실제로 잴 수 있는 상자인가.
//   - **자 민감도**: 툴바를 줄 글자 위에 일부러 얹었을 때 자가 시스템 줄 글자를 센다. 자가 눈이 멀면 이 칸이 먼저 붉다.
//
// 백엔드는 없다: `/v1/**`는 고정 응답이고 소켓은 구독만 받는다. 인물은 전부 가상이다(레포는 공개).
// =============================================================================
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";
import {
  assertHoverToolbarClearsBodyText,
  measureHoverToolbarOverlap,
} from "./lib/hoverToolbarOverlap.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "captures/5173");
const PORT = Number(process.env.CAPTURE_PORT || 5373);
const DIST_DIR = process.env.DIST_DIR || "";
const SHOTS = process.env.SHOTS === "1";
const MIN = 60_000;
const NOW = Date.UTC(2024, 5, 15, 3, 0, 0);

const workspaceId = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const SEO = "00000000-0000-7000-8000-000000000102";
const MINSU = "00000000-0000-7000-8000-000000000103";
const HAYUN = "00000000-0000-7000-8000-000000000104";
const A1 = "00000000-0000-7000-8000-000000000301";
const CH = "00000000-0000-7000-8000-000000000201";
const GEN = "00000000-0000-7000-8000-000000000202";
const mid = (n) => `00000000-0000-7000-8000-0000000a${String(n).padStart(4, "0")}`;
const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const person = (id, kind, displayName, handle, extra = {}) => ({
  id, workspaceId, kind, status: "active", displayName, handle, role: "member", channelCount: 2,
  channelIds: [CH, GEN], capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...extra,
});
const roster = [
  person(ME, "human", "이도현", "dohyun", { role: "owner" }),
  person(SEO, "human", "박서연", "seoyeon"),
  person(MINSU, "human", "최민수", "minsu"),
  person(HAYUN, "human", "정하윤", "hayun"),
  person(A1, "agent", "달무리봇", "dalmuri-bot", { ownerHumanId: ME }),
];
const channels = [
  { id: CH, workspaceId, kind: "public", name: "디자인-리뷰", muted: false },
  { id: GEN, workspaceId, kind: "public", name: "일반", muted: false },
];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: ME, workspaceId, kind: "human", displayName: "이도현", handle: "dohyun" },
  realtimeWebSocketUrl: "ws://capture-5173.invalid/connection/websocket",
};

/** 줄(seq 25) 앞뒤에 평범한 글이 선 대화. seq 24 = 줄 위 행(R_a), seq 26 = 줄 아래 행(R_b). */
const SEQ = { above: 24, line: 25, below: 26, after: 27 };
function messages() {
  const rows = [];
  let n = 1;
  const add = (author, body, minAgo, extra = {}) => {
    rows.push({ n: n++, author, body, minAgo, ...extra });
  };
  for (let i = 0; i < 14; i += 1) {
    // 줄 위 행(R_a)의 바로 앞 행(seq 23)만 짧은 글이다: 아래 「별개 결함 프로브」 가 긴 앞 행 꼬리 덮음을 따로 재므로, 여기서는
    // 단정이 시스템 줄만 재게 한다(툴바가 긴 앞 행의 꼬리를 덮는 것은 이 이슈의 결함이 아니다).
    const body = i === 13 ? "알겠어요." : `시안 ${i + 1}번 의견이에요. 여백과 글자 크기를 한 번 더 맞춰 봐요.`;
    add(i % 2 ? SEO : MINSU, body, 120 - i * 3);
  }
  add(ME, "@달무리봇 이번 주 회의록 초안, 중단 확인 먼저 할게요", 30);
  add(ME, "사람이 실행을 중단했어요.", 29, { system: true });
  add(ME, "표지 문구 후보 세 개만 먼저 보내 주세요", 28);
  add(HAYUN, "점심 먹고 이어서 볼게요", 20);
  add(SEO, "알겠어요. 오후 두 시에 다시 맞춰 봐요", 18);
  add(MINSU, "저는 디자인 시안 먼저 볼게요", 16);
  for (let i = 0; i < 9; i += 1) {
    add(i % 2 ? HAYUN : SEO, `시안 ${i + 15}번도 확인했어요. 이상 없어요.`, 14 - i);
  }
  add(ME, "마지막 확인은 제가 할게요", 3);
  let seq = 10;
  return rows.map((x) => {
    const createdAtMs = NOW - x.minAgo * MIN;
    const row = {
      id: mid(x.n), channelId: CH, seq: seq++, hlcTs: createdAtMs, hlcCount: 0, authorMemberId: x.author,
      type: x.system ? "system" : "text", body: x.body, state: "sent", createdAtMs,
    };
    if (x.system) row.props = { kind: "agent_run_cancelled" };
    return row;
  });
}

async function installMocks(context) {
  await context.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
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
    if (path.includes(`/channels/${CH}/messages`)) return json(route, { messages: messages() });
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
          if (c.connect) return { id: c.id, connect: { client: "capture-5173", version: "6" } };
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
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport, colorScheme: scheme, serviceWorkers: "block", reducedMotion: "reduce" });
  await installMocks(context);
  await context.addInitScript((server) => { try { localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ } }, origin);
  const page = await context.newPage();
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-item").first().waitFor({ state: "attached", timeout: 20_000 });
  await page.evaluate((h) => { location.hash = h; }, `/c/${CH}`);
  await page.getByTestId("composer").waitFor({ timeout: 20_000 });
  // 로그인 단추를 누른 자리에 포인터가 남으면 그 자리의 행이 hover 로 칠해진다. 구석으로 치운다.
  await page.mouse.move(2, 2);
  await page.waitForTimeout(1200);
  return { browser, context, page };
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
}
const note = (line) => console.log(`     ${line}`);

const rowOf = (page, seq) => page.locator(`[data-testid="timeline-message"][data-seq="${seq}"]`);

/** 그 행의 위 경계를 스크롤러 맨 위에 맞춘다(툴바가 위 경계를 걸치지 못하고 아래로 뒤집히는 자리). */
async function pinRowToScrollerTop(page, seq) {
  return page.evaluate(async (target) => {
    const frame = () => new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0)));
    const sc = document.querySelector("[data-virtuoso-scroller]");
    if (!sc) return null;
    const find = () => document.querySelector(`[data-testid="timeline-message"][data-seq="${target}"]`);
    sc.scrollTop = 0;
    for (let i = 0; i < 8; i += 1) await frame();
    for (let k = 0; k < 6; k += 1) {
      const row = find();
      if (!row) { sc.scrollTop += 400; await frame(); continue; }
      sc.scrollTop += row.getBoundingClientRect().top - sc.getBoundingClientRect().top;
      for (let i = 0; i < 6; i += 1) await frame();
    }
    const row = find();
    return row ? Math.round(row.getBoundingClientRect().top - sc.getBoundingClientRect().top) : null;
  }, seq);
}

/** 그 행을 화면 가운데로(핀 없는 보통 호버). */
async function centerRow(page, seq) {
  await page.evaluate(async (target) => {
    const frame = () => new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0)));
    const sc = document.querySelector("[data-virtuoso-scroller]");
    const row = document.querySelector(`[data-testid="timeline-message"][data-seq="${target}"]`);
    if (!sc || !row) return;
    const rect = row.getBoundingClientRect();
    const scRect = sc.getBoundingClientRect();
    sc.scrollTop += rect.top - scRect.top - (scRect.height - rect.height) / 2;
    for (let i = 0; i < 8; i += 1) await frame();
  }, seq);
}

/** 줄의 글자 Range 사각형(없으면 빈 배열). */
const lineTextRects = (page) =>
  page.evaluate(() => {
    const line = document.querySelector('[data-testid="system-line"]');
    const p = line?.querySelector("p");
    if (!p) return [];
    const range = document.createRange();
    range.selectNodeContents(p);
    return [...range.getClientRects()].map((r) => ({ l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom) }));
  });

const barRect = (page) =>
  page.evaluate(() => {
    const bar = document.querySelector('[data-testid="message-hover-toolbar"]');
    if (!bar) return null;
    const r = bar.getBoundingClientRect();
    return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), straddle: bar.getAttribute("data-straddle") };
  });

// 포인터가 선 행 네 가지. `expect` = 그 자리에서 툴바가 서야 하는 쪽.
const CASES = [
  { id: "R_b 줄 아래 행(위 경계 걸침)", seq: SEQ.below, pin: false, expect: "top", lineSide: "prev" },
  { id: "R_a 줄 위 행(스크롤러 맨 위, 뒤집힘)", seq: SEQ.above, pin: true, expect: "below", lineSide: "next" },
  { id: "R_a 줄 위 행(가운데, 대조)", seq: SEQ.above, pin: false, expect: "top", lineSide: "next" },
  { id: "R_b 줄 아래 행(스크롤러 맨 위, 뒤집힘, 대조)", seq: SEQ.below, pin: true, expect: "below", lineSide: "prev" },
];

async function runCase(page, tag, c) {
  const name = `${tag} ${c.id}`;
  await page.mouse.move(2, 2);
  await page.waitForTimeout(250);
  if (c.pin) {
    const top = await pinRowToScrollerTop(page, c.seq);
    check(`${name}: 행이 스크롤러 맨 위에 붙었다`, top !== null && Math.abs(top) <= 1, `top=${top}`);
  } else {
    await centerRow(page, c.seq);
  }
  await rowOf(page, c.seq).hover();
  await page.locator('[data-testid="message-hover-toolbar"]').first().waitFor({ state: "visible", timeout: 2000 });
  await page.waitForTimeout(350);

  const bar = await barRect(page);
  check(`${name}: 툴바가 기대한 자리(${c.expect})에 섰다`, bar?.straddle === c.expect, JSON.stringify(bar));
  const texts = await lineTextRects(page);
  check(`${name}: 줄 글자를 잴 수 있다(Range 사각형 ≥ 1)`, texts.length >= 1 && texts.every((r) => r.r > r.l && r.b > r.t), JSON.stringify(texts));
  const info = await measureHoverToolbarOverlap(page);
  const looked = info[0]?.looked ?? [];
  check(
    `${name}: 자가 이웃으로 시스템 줄을 봤다(양성 대조, ${c.lineSide})`,
    looked.some((item) => item.kind === "system-line" && item.where === c.lineSide),
    JSON.stringify(looked)
  );
  note(`툴바 ${bar ? `x ${bar.l}~${bar.r} y ${bar.t}~${bar.b}` : "없음"} · 줄 글자 ${texts[0] ? `x ${texts[0].l}~${texts[0].r} y ${texts[0].t}~${texts[0].b}` : "없음"} · 최악 ${info[0] ? `${info[0].neighbor}/${info[0].kind} ${info[0].chars}자` : "-"}`);

  let verdict = "";
  try {
    await assertHoverToolbarClearsBodyText(page, name);
  } catch (error) {
    verdict = String(error?.message ?? error);
  }
  check(`${name}: 툴바 ∩ 이웃(행·시스템 줄) 글자 = 0`, verdict === "", verdict);

  if (SHOTS) {
    mkdirSync(OUT_DIR, { recursive: true });
    const slug = c.id.replace(/[^0-9A-Za-z가-힣]+/g, "-").replace(/^-|-$/g, "");
    await page.screenshot({ path: resolve(OUT_DIR, `5173-${tag.replace(/\s+/g, "-")}-${slug}.png`) });
  }
  await page.mouse.move(2, 2);
  await page.waitForTimeout(200);
}

/**
 * 자 민감도: 툴바를 줄 글자 위에 일부러 얹으면 자가 시스템 줄 글자를 세는가. 자가 이웃 선택자를 잃으면(눈이 멀면) 이 칸이 붉다.
 * 툴바는 캡처 페이지의 DOM 일 뿐이라 이 조작은 앱 코드를 바꾸지 않는다(포인터를 치우면 툴바와 함께 사라진다).
 */
async function runSensitivity(page, tag) {
  const name = `${tag} 자 민감도`;
  await page.mouse.move(2, 2);
  await page.waitForTimeout(250);
  await centerRow(page, SEQ.below);
  await rowOf(page, SEQ.below).hover();
  await page.locator('[data-testid="message-hover-toolbar"]').first().waitFor({ state: "visible", timeout: 2000 });
  await page.waitForTimeout(300);
  const forced = await page.evaluate(() => {
    const bar = document.querySelector('[data-testid="message-hover-toolbar"]');
    const p = document.querySelector('[data-testid="system-line"] p');
    if (!bar || !p) return null;
    // 글자 상자(Range)를 겨눈다. `<p>` 상자는 좁은 열에서 위·아래 여유를 품어 글자보다 크다.
    const range = document.createRange();
    range.selectNodeContents(p);
    const text = range.getBoundingClientRect();
    bar.style.position = "fixed";
    bar.style.translate = "none";
    bar.style.left = `${Math.max(0, text.left - 4)}px`;
    bar.style.top = `${Math.max(0, text.top - 12)}px`;
    bar.style.right = "auto";
    bar.style.bottom = "auto";
    return true;
  });
  check(`${name}: 툴바를 줄 글자 위로 옮겼다`, forced === true, String(forced));
  const info = await measureHoverToolbarOverlap(page);
  const hit = info[0];
  check(
    `${name}: 자가 시스템 줄 글자를 센다(chars > 0, kind=system-line)`,
    hit && hit.chars > 0 && hit.kind === "system-line",
    JSON.stringify(hit)
  );
  let thrown = "";
  try {
    await assertHoverToolbarClearsBodyText(page, name);
  } catch (error) {
    thrown = String(error?.message ?? error);
  }
  check(`${name}: 공용 단정이 그 겹침에서 던진다`, thrown.includes("system-line") && thrown.includes("덮는다"), thrown || "던지지 않았다");
  await page.mouse.move(2, 2);
  await page.waitForTimeout(200);
}

/**
 * 별개 결함 프로브(**단정 아님**, 수치만 찍는다). 줄과 무관한 보통 행 두 개: 포인터가 선 행의 툴바가 **앞 행의 마지막 줄**을 덮는가.
 * 툴바는 행 위 경계를 걸쳐 앞 행 바닥 36px 를 덮고(README §6 5번), 좁은 열에서는 앞 행의 꼬리 글이 툴바 밑까지 온다 — 시스템 줄과
 * 상관없이 일어나는 같은 계열의 겹침이다(앞 회차 s3-web L4 의 모양). 이 이슈의 수리 범위 밖이라 단정으로 세지 않고, 있는 그대로 적는다.
 */
async function runNormalPairProbe(page, tag) {
  await page.mouse.move(2, 2);
  await page.waitForTimeout(250);
  const seq = SEQ.above - 2;
  await centerRow(page, seq);
  await rowOf(page, seq).hover();
  await page.locator('[data-testid="message-hover-toolbar"]').first().waitFor({ state: "visible", timeout: 2000 });
  await page.waitForTimeout(300);
  const info = await measureHoverToolbarOverlap(page);
  const worst = info[0];
  note(`프로브(단정 아님) ${tag} 보통 행 쌍 seq ${seq}: 최악 ${worst ? `${worst.neighbor}/${worst.kind} seq ${worst.seq} ${worst.chars}자(${worst.area}px²)` : "-"} · 이웃 ${JSON.stringify(worst?.looked ?? [])}`);
  await page.mouse.move(2, 2);
  await page.waitForTimeout(200);
}

async function runViewport(origin, scheme, width, height) {
  const tag = `${width} ${scheme}`;
  const { browser, context, page } = await open(origin, scheme, { width, height });
  try {
    console.log(`--- ${tag}`);
    check(`${tag}: 시스템 줄이 화면에 있다`, (await page.locator('[data-testid="system-line"]').count()) === 1);
    for (const c of CASES) await runCase(page, tag, c);
    await runSensitivity(page, tag);
    await runNormalPairProbe(page, tag);
  } finally {
    await context.close();
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
    for (const scheme of ["light", "dark"]) {
      await runViewport(preview.origin, scheme, 390, 844);
      await runViewport(preview.origin, scheme, 1440, 900);
    }
  } finally {
    await preview.stop?.();
  }
  const bad = results.filter((r) => !r.ok);
  console.log(
    bad.length === 0
      ? `HOVER-TOOLBAR-5173 PASS (${results.length} checks)`
      : `HOVER-TOOLBAR-5173 FAIL (${bad.length}/${results.length}): ${bad.map((r) => r.name).join(" | ")}`
  );
  process.exit(bad.length === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
