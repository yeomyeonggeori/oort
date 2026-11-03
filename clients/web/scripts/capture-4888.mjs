#!/usr/bin/env node
// =============================================================================
// #4888 레인: 「대화에도 보내기」 체크 + 본류 답글 줄 (웹 Chromium · 데스크탑 웹뷰 대리 = WebKit).
//
//   npm run build && node scripts/capture-4888.mjs
//   DIST_DIR=<다른 dist> node scripts/capture-4888.mjs      # 고치기 전 번들로 RED 를 다시 볼 때
//   BROWSERS=chromium node scripts/capture-4888.mjs          # 한 엔진만(기본: chromium,webkit)
//   SCHEMES=light,dark node scripts/capture-4888.mjs         # 기본은 light
//   LOCALE=en-US node scripts/capture-4888.mjs                # 영어 사전으로 같은 흐름(기본은 ko-KR)
//   ONLY=flow,arrow,old                                       # 장면 고르기(기본은 전부)
//   SHOTS=1 OUT_DIR=<dir> WIDTHS=720,1440 node scripts/capture-4888.mjs   # 캡처도 찍기(기본은 재기만)
//
// 장면 셋. 단정이 곧 표다.
//
//   flow   스레드 입력칸 → 체크는 기본 꺼짐 → 끄고 보낸 답글은 요청에 `alsoInChannel` 키가 없고 본류에 서지 않는다 → 켜고 보낸 답글은
//          요청에 `alsoInChannel: true` 가 실리고 본류에 「↳ ○○님 스레드에 답글」 + 원문 한 줄로 선다 → 보낸 뒤 체크가 꺼진다 →
//          스레드를 닫고 본류의 줄을 누르면 그 스레드가 열린다 → 키보드(Tab·Space).
//   arrow  빈 입력칸 + ↑ : 「대화에도 보낸」 내 답글(본류에 선다)이 고칠 대상이다(#5191 판정을 맞춘다).
//   old    옛 서버가 모르는 키로 400 을 주면 조용히 스레드로만 보내지 않고 이유를 말한다 → 체크를 끄면 보내진다.
//
// 백엔드는 없다: `/v1/**` 는 이 파일 안의 메모리 서버(POST 가 행을 만들고 켠 값을 응답에 되돌린다)이고, 새 행은 소켓 프레임으로도 민다.
// 인물은 전부 가상이다(레포는 공개).
// =============================================================================
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "captures/4888");
const PORT = Number(process.env.CAPTURE_PORT || 5388);
const DIST_DIR = process.env.DIST_DIR || "";
const SHOTS = process.env.SHOTS === "1";
const ENGINES = (process.env.BROWSERS || "chromium,webkit").split(",").map((s) => s.trim()).filter(Boolean);
const SCHEMES = (process.env.SCHEMES || "light").split(",").map((s) => s.trim()).filter(Boolean);
const WIDTHS = (process.env.WIDTHS || "1280").split(",").map((s) => Number(s.trim())).filter(Boolean);
const LOCALE = process.env.LOCALE === "en-US" ? "en-US" : "ko-KR";
/** 사전 문구는 언어를 따른다 — 같은 흐름을 두 사전으로 읽는다. */
const COPY = LOCALE === "en-US"
  ? { label: "Also send to the conversation", header: "↳ Replied in 박서연's thread", unsupported: "does not support" }
  : { label: "대화에도 보내기", header: "↳ 박서연님 스레드에 답글", unsupported: "지원하지 않아요" };
const ONLY = new Set((process.env.ONLY || "flow,arrow,old").split(",").map((v) => v.trim()));
const MIN = 60_000;
const NOW = Date.UTC(2026, 10, 3, 5, 0, 0);

const workspaceId = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const SEO = "00000000-0000-7000-8000-000000000102";
const CH = "00000000-0000-7000-8000-000000000201";
const GEN = "00000000-0000-7000-8000-000000000202";
const mid = (n) => `00000000-0000-7000-8000-0000000a${String(n).padStart(4, "0")}`;
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

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
  realtimeWebSocketUrl: "ws://capture-4888.invalid/connection/websocket",
};

const ID = { root: mid(10), thread: mid(11), mine: mid(12), last: mid(13), alsoMine: mid(14) };
const ROOT_TEXT = "오늘 점심 뭐 먹을까요? 메뉴 추천 받아요";

function baseRow(seq, id, author, body, minAgo, extra = {}) {
  const createdAtMs = NOW - minAgo * MIN;
  return { id, channelId: CH, seq, hlcTs: createdAtMs, hlcCount: 0, authorMemberId: author, type: "text", body, state: "sent", createdAtMs, ...extra };
}

/** variant: default | alsoMine(내 「대화에도 보낸」 답글이 마지막) ; mode: new | old(알 수 없는 키를 400 으로 거절) */
function makeServer(variant = "default", mode = "new") {
  const rows = [
    baseRow(10, ID.root, SEO, ROOT_TEXT, 50, {
      thread: { reply_count: 1, last_reply_seq: 11, last_reply_at: NOW - 45 * MIN, participant_ids: [SEO], participant_count: 1 },
    }),
    baseRow(11, ID.thread, SEO, "저는 국밥이 좋아요", 45, { rootId: ID.root }),
    baseRow(12, ID.mine, ME, "회의 시간은 3시로 정했어요, 참석 부탁드려요", 40),
    baseRow(13, ID.last, SEO, "오늘 일정 공유드려요", 30),
  ];
  if (variant === "alsoMine") {
    rows.push(baseRow(14, ID.alsoMine, ME, "점심은 국밥으로 정했어요, 12시에 로비에서 봐요", 10, { rootId: ID.root, alsoInChannel: true }));
  }
  return { rows, mode, posts: [], nextSeq: 20 };
}

async function installMocks(context, server) {
  await context.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
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
    if (path.endsWith("/scheduled-messages")) return json(route, { messages: [] });
    if (path.endsWith(`/workspaces/${workspaceId}`)) return json(route, { workspace: { id: workspaceId, name: "달무리 스튜디오" } });
    // 보내기: 서버 계약 그대로 — 켠 값은 답글에서만(아니면 400), 옛 서버는 모르는 키라 400, 켠 때만 응답에 `alsoInChannel: true` 가 실린다.
    if (path.endsWith(`/channels/${CH}/messages`) && method === "POST") {
      const raw = request.postData() ?? "";
      let body = {};
      try { body = JSON.parse(raw); } catch { body = {}; }
      server.posts.push({ raw, body });
      if ("alsoInChannel" in body && server.mode === "old") {
        return json(route, { error: { code: "bad_request", message: "unknown field `alsoInChannel`" } }, 400);
      }
      if (body.alsoInChannel === true && !body.rootId) {
        return json(route, { error: { code: "bad_request", message: "alsoInChannel requires a thread reply" } }, 400);
      }
      server.nextSeq += 1;
      const seq = server.nextSeq;
      const row = baseRow(seq, mid(seq), ME, body.body ?? "", 0, {
        ...(body.rootId ? { rootId: body.rootId } : {}),
        ...(body.alsoInChannel === true ? { alsoInChannel: true } : {}),
      });
      server.rows.push(row);
      server.lastRow = row;
      return json(route, row);
    }
    const replies = path.match(/\/channels\/[^/]+\/messages\/([^/]+)\/replies$/);
    if (replies) return json(route, { messages: server.rows.filter((r) => r.rootId?.toLowerCase() === replies[1].toLowerCase()), following: false });
    if (path.includes(`/channels/${CH}/messages`)) return json(route, { messages: server.rows });
    if (path.includes("/messages")) return json(route, { messages: [] });
    return json(route, {});
  });
  await context.addInitScript(() => {
    class CaptureSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      constructor(url) {
        this.url = String(url); this.readyState = 0;
        window.__socket = this; window.__offset = 0; window.__subs = [];
        queueMicrotask(() => { this.readyState = 1; this.onopen?.(new Event("open")); });
      }
      send(data) {
        const replies = String(data).trim().split("\n").map((line) => {
          const c = JSON.parse(line);
          if (c.connect) return { id: c.id, connect: { client: "capture-4888", version: "6" } };
          if (c.subscribe) {
            window.__subs.push(c.subscribe.channel);
            return { id: c.id, subscribe: { recoverable: true, positioned: true, recovered: false, epoch: "cap", offset: 0 } };
          }
          return { id: c.id };
        });
        queueMicrotask(() => this.onmessage?.(new MessageEvent("message", { data: replies.map((r) => JSON.stringify(r)).join("\n") })));
      }
      close() { this.readyState = 3; this.onclose?.(new CloseEvent("close", { code: 1000 })); }
    }
    window.WebSocket = CaptureSocket;
    window.__push = (data) => {
      const channel = window.__subs.find((name) => name.includes("ch:") || name.includes(":ch:")) ?? window.__subs[0];
      window.__offset += 1;
      window.__socket.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ push: { channel, pub: { data, offset: window.__offset } } }) }));
    };
  });
}

/** 서버가 방금 저장한 행을 `message.new` 프레임으로 민다 — 켠 값은 `also_in_channel: true` 로만 간다(와이어 계약). */
const frameOf = (row) => ({
  type: "message.new", v: 1, ts: NOW + 1_000, seq: row.seq,
  payload: {
    id: row.id, channel_id: CH, seq: row.seq, hlc_ts: row.hlcTs, hlc_count: 0, author_member_id: row.authorMemberId,
    type: "text", state: "sent", body: row.body, props: {}, root_id: row.rootId ?? null, reply_to_id: null, run_id: null,
    client_msg_id: null, created_at_ms: row.createdAtMs, edited_at_ms: null, deleted_at_ms: null,
    ...(row.alsoInChannel === true ? { also_in_channel: true } : {}),
  },
});

async function open(browserType, origin, scheme, server, viewport) {
  const browser = await browserType.launch();
  const context = await browser.newContext({ viewport, colorScheme: scheme, locale: LOCALE, timezoneId: "Asia/Seoul", serviceWorkers: "block", reducedMotion: "reduce" });
  await installMocks(context, server);
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
  const lastDrawn = [...server.rows].reverse().find((row) => !row.rootId || row.alsoInChannel);
  await page.locator(`[data-testid="timeline-virtuoso"] [data-testid="timeline-message"][data-seq="${lastDrawn.seq}"]`).first().waitFor({ timeout: 20_000 });
  await page.mouse.move(2, 2);
  await page.waitForTimeout(700);
  return { browser, context, page };
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${String(detail).slice(0, 300)}`}`);
}

async function shot(page, tag, name) {
  if (!SHOTS) return;
  mkdirSync(OUT_DIR, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: resolve(OUT_DIR, `4888-${tag.replace(/\s+/g, "-")}-${name}.png`) });
}

const main = (page) => page.locator('[data-testid="timeline-virtuoso"]');
const panel = (page) => page.locator('[data-testid="thread-panel"]');
const checkbox = (page) => page.locator('[data-testid="thread-composer-also-in-channel-input"]');
const threadInput = (page) => page.locator('[data-testid="thread-composer-input"]');
const activeId = (page) => page.evaluate(() => document.activeElement?.id || document.activeElement?.getAttribute("data-testid") || document.activeElement?.tagName || "");

async function openRootThread(page) {
  await main(page).locator(`[data-testid="timeline-message"][data-message-id="${ID.root.toLowerCase()}"] [data-testid="thread-anchor"]`).first().click();
  await panel(page).waitFor({ timeout: 8000 });
  await threadInput(page).waitFor({ timeout: 8000 });
}

/** 스레드 입력칸에 글을 쓰고 보낸다. 서버가 저장한 행을 소켓으로도 밀어 준다(다른 기기·실시간과 같다). */
async function sendReply(page, server, text, { also }) {
  await threadInput(page).fill(text);
  if (also) await checkbox(page).check();
  const before = server.posts.length;
  const response = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/messages"), { timeout: 8000 }).catch(() => null);
  await page.locator('[data-testid="thread-composer-send"]').click();
  const answer = await response;
  await page.waitForTimeout(300);
  const post = server.posts.length > before ? server.posts[server.posts.length - 1] : null;
  if (answer && answer.status() === 200 && server.lastRow) {
    await page.evaluate((data) => window.__push(data), frameOf(server.lastRow));
    await page.waitForTimeout(500);
  }
  return { post, status: answer ? answer.status() : 0 };
}

async function runFlow(browserType, origin, scheme, tag, width) {
  const server = makeServer("default");
  const { browser, context, page } = await open(browserType, origin, scheme, server, { width, height: 800 });
  const t = `${tag} ${width}`;
  try {
    // 켜지 않은 답글은 본류에 없다: 시작 상태.
    check(`${t} 시작: 스레드로만 간 답글(seq 11)은 본류에 없다`, (await main(page).getByText("저는 국밥이 좋아요").count()) === 0);
    await openRootThread(page);
    check(`${t} 체크: 스레드 입력칸에 「대화에도 보내기」가 있고 기본은 꺼짐`, (await checkbox(page).count()) === 1 && !(await checkbox(page).isChecked()));
    check(`${t} 체크: 이름은 보이는 글이다`, ((await page.locator('[data-testid="thread-composer-also-in-channel"]').textContent()) ?? "").trim() === COPY.label);
    await shot(page, t, "01-thread-composer-unchecked");

    // 끄고 보낸다.
    const off = await sendReply(page, server, "저도 국밥 좋아요", { also: false });
    check(`${t} 끈 채 보냄: 요청에 alsoInChannel 키가 없다`, off.post !== null && !("alsoInChannel" in off.post.body), off.post?.raw);
    check(`${t} 끈 채 보냄: 본류에 서지 않는다`, (await main(page).getByText("저도 국밥 좋아요").count()) === 0);
    check(`${t} 끈 채 보냄: 스레드에는 보인다`, (await panel(page).getByText("저도 국밥 좋아요").count()) >= 1);

    // 켜고 보낸다.
    await threadInput(page).fill("점심은 국밥으로 정했어요, 12시에 로비에서 봐요");
    await checkbox(page).check();
    check(`${t} 켜기: 체크가 켜진다`, await checkbox(page).isChecked());
    await shot(page, t, "02-thread-composer-checked");
    const on = await sendReply(page, server, "점심은 국밥으로 정했어요, 12시에 로비에서 봐요", { also: true });
    check(`${t} 켠 채 보냄: 요청에 alsoInChannel: true 와 rootId 가 함께 간다`, on.post?.body.alsoInChannel === true && on.post?.body.rootId === ID.root, on.post?.raw);
    const alsoRow = main(page).locator(`[data-testid="timeline-message"][data-message-id="${server.lastRow?.id.toLowerCase()}"]`).first();
    check(`${t} 켠 채 보냄: 본류에 그 답글이 선다`, (await alsoRow.count()) === 1);
    const header = ((await alsoRow.locator('[data-testid="reply-home-header"]').textContent().catch(() => null)) ?? "").trim();
    check(`${t} 본류 줄: 「↳ 박서연님 스레드에 답글」`, header === COPY.header, header);
    const excerpt = ((await alsoRow.locator('[data-testid="reply-home-excerpt"]').textContent().catch(() => null)) ?? "").trim();
    check(`${t} 본류 줄: 원문 한 줄`, excerpt === ROOT_TEXT, excerpt);
    check(`${t} 보낸 뒤: 체크가 꺼진다(마지막 선택을 기억하지 않는다)`, !(await checkbox(page).isChecked()));

    // 키보드: 글 칸 → Tab → 체크 → Space.
    await threadInput(page).focus();
    if (tag.startsWith("webkit")) {
      // WebKit 은 기본 설정에서 단추·체크를 Tab 순서에서 건너뛴다(Safari 의 「Tab 으로 항목 강조」 설정) — 같은 줄의 첨부·멘션·이모지
      // 단추도 그렇다(`DEBUG_4888=1` 로 순서를 찍어 확인했다). 그래서 이 엔진에서는 초점을 직접 주고 Space 만 잰다. Tab 순서는 Chromium 이 잰다.
      await checkbox(page).focus();
      console.log(`     (${tag}) WebKit 은 Tab 이 단추·체크를 건너뛰는 플랫폼 정책이라 Tab 순서 단정은 Chromium 에서만 한다`);
    } else {
      if (process.env.DEBUG_4888) {
        const seen = [];
        for (let i = 0; i < 4; i += 1) { await page.keyboard.press("Tab"); seen.push(await activeId(page)); }
        console.log(`     Tab 순서(${tag}): ${seen.join(" > ")}`);
        await threadInput(page).focus();
      }
      await page.keyboard.press("Tab");
    }
    check(`${t} 키보드: 체크에 초점이 있다(Chromium 은 글 칸에서 Tab 으로 닿는다)`, (await activeId(page)) === "thread-composer-also-in-channel-input", await activeId(page));
    await page.keyboard.press("Space");
    check(`${t} 키보드: Space 로 켜진다`, await checkbox(page).isChecked());
    await page.keyboard.press("Space");

    // 스레드를 닫고 본류의 줄을 눌러 다시 연다.
    await page.locator('[data-testid="thread-close"]').click();
    await panel(page).waitFor({ state: "detached", timeout: 8000 }).catch(() => null);
    check(`${t} 줄 누르기 전: 스레드가 닫혀 있다`, (await panel(page).count()) === 0);
    await alsoRow.scrollIntoViewIfNeeded().catch(() => null);
    await shot(page, t, "03-main-flow-reply-line");
    await alsoRow.locator('[data-testid="reply-home"]').click();
    const reopened = await panel(page).waitFor({ timeout: 8000 }).then(() => true, () => false);
    check(`${t} 줄 누르기: 그 스레드가 열린다`, reopened);
    check(`${t} 줄 누르기: 열린 스레드가 그 루트의 것이다`, (await panel(page).getByText(ROOT_TEXT).count()) >= 1);
    await shot(page, t, "05-thread-opened-from-line");
  } finally {
    await context.close();
    await browser.close();
  }
}

async function runArrow(browserType, origin, scheme, tag, width) {
  const server = makeServer("alsoMine");
  const { browser, context, page } = await open(browserType, origin, scheme, server, { width, height: 800 });
  const t = `${tag} ${width}`;
  try {
    const row = main(page).locator(`[data-testid="timeline-message"][data-message-id="${ID.alsoMine.toLowerCase()}"]`).first();
    check(`${t} ↑ 준비: 내 「대화에도 보낸」 답글이 본류에 서 있다`, (await row.count()) === 1);
    const composer = page.locator("#composer-input");
    await composer.click();
    await composer.press("ArrowUp");
    const editor = page.locator('[data-testid="message-editor-input"]').first();
    const opened = await editor.waitFor({ state: "visible", timeout: 2500 }).then(() => true, () => false);
    check(`${t} ↑ 빈 입력칸: 내 「대화에도 보낸」 답글의 편집기가 열린다`, opened);
    if (opened) {
      check(`${t} ↑: 편집기가 그 답글 행 안에 선다`, (await row.locator('[data-testid="message-editor-input"]').count()) === 1);
      check(`${t} ↑: 편집기가 그 답글 글로 열린다`, (await editor.inputValue()) === "점심은 국밥으로 정했어요, 12시에 로비에서 봐요", await editor.inputValue());
      await editor.press("Escape");
    }
  } finally {
    await context.close();
    await browser.close();
  }
}

async function runOld(browserType, origin, scheme, tag, width) {
  const server = makeServer("default", "old");
  const { browser, context, page } = await open(browserType, origin, scheme, server, { width, height: 800 });
  const t = `${tag} ${width}`;
  try {
    await openRootThread(page);
    const first = await sendReply(page, server, "옛 서버에 켜고 보내요", { also: true });
    check(`${t} 옛 서버: 켠 요청은 400 으로 거절된다(서버 계약)`, first.status === 400, String(first.status));
    const message = ((await page.locator('[data-testid="thread-composer-error"]').textContent().catch(() => null)) ?? "").trim();
    check(`${t} 옛 서버: 조용히 스레드로만 보내지 않고 이유를 말한다`, message.includes(COPY.unsupported) && message.includes(COPY.label.slice(0, 8)), message);
    check(`${t} 옛 서버: 글과 체크가 남아 있다`, (await threadInput(page).inputValue()) === "옛 서버에 켜고 보내요" && (await checkbox(page).isChecked()));
    await shot(page, t, "04-old-server-unsupported");
    await checkbox(page).uncheck();
    const second = await sendReply(page, server, "옛 서버에 켜고 보내요", { also: false });
    check(`${t} 옛 서버: 체크를 끄고 다시 보내면 보내진다(키 없음)`, second.status === 200 && second.post !== null && !("alsoInChannel" in second.post.body), JSON.stringify(second));
  } finally {
    await context.close();
    await browser.close();
  }
}

async function mainRun() {
  const preview = await startGuardedPreview({
    webRoot: WEB_ROOT,
    port: PORT,
    portEnvVar: "CAPTURE_PORT",
    ...(DIST_DIR ? { extraArgs: ["--outDir", resolve(DIST_DIR)] } : {}),
  });
  try {
    for (const engineName of ENGINES) {
      const engine = engineName === "webkit" ? webkit : chromium;
      for (const scheme of SCHEMES) {
        for (const width of WIDTHS) {
          const tag = `${engineName} ${scheme}`;
          console.log(`--- ${tag} ${width}`);
          if (ONLY.has("flow")) await runFlow(engine, preview.origin, scheme, tag, width);
          if (ONLY.has("arrow")) await runArrow(engine, preview.origin, scheme, tag, width);
          if (ONLY.has("old")) await runOld(engine, preview.origin, scheme, tag, width);
        }
      }
    }
  } finally {
    await preview.stop?.();
  }
  const bad = results.filter((r) => !r.ok);
  console.log(
    bad.length === 0
      ? `ALSO-IN-CHANNEL-4888 PASS (${results.length} checks)`
      : `ALSO-IN-CHANNEL-4888 FAIL (${bad.length}/${results.length}): ${bad.map((r) => r.name).join(" | ")}`
  );
  process.exit(bad.length === 0 ? 0 : 1);
}
mainRun().catch((e) => { console.error(e); process.exit(1); });
