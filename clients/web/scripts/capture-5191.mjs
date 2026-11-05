#!/usr/bin/env node
// =============================================================================
// #5191 레인: 「메시지 고치기가 안 된다」 재현 표 + ↑ 키 흐름 + 한글 조합 + 실시간 (웹 Chromium · 데스크탑 웹뷰 대리 = WebKit).
//
//   npm run build && node scripts/capture-5191.mjs
//   DIST_DIR=<다른 dist> node scripts/capture-5191.mjs      # 고치기 전 번들로 RED 를 다시 볼 때
//   BROWSERS=chromium node scripts/capture-5191.mjs          # 한 엔진만(기본: chromium,webkit)
//   SCHEMES=light,dark node scripts/capture-5191.mjs         # 기본은 light
//   ONLY=table,arrow,ime,realtime                            # 장면 고르기(기본은 전부)
//   SHOTS=1 OUT_DIR=<dir> node scripts/capture-5191.mjs      # 캡처도 찍기(기본은 재기만). 단정의 성패와 무관하게 찍는다
//   DEBUG_5191=1                                             # 붉은 칸의 진단 값을 더 찍는다
//
// 장면 네 갈래. 단정이 아니라 **표**가 먼저이고, 표의 칸이 곧 단정이다.
//
//   table    재현 표: 내 글 / 내 글+첨부 / 예약해서 보낸 글 / 스레드 루트 / 남의 글 / 에이전트 글, 그리고 **스레드 패널 안**의 내 답글 ·
//            「대화에도 보낸」 답글 · 루트 — 칸마다
//              · ⋯ 메뉴에 「고치기」가 있는가, 우클릭 메뉴에 있는가(남의 글·에이전트 글은 **없어야** 한다)
//              · 눌러 열면 편집기가 **지금 글**로 열리는가 · Esc 는 PATCH 없이 닫는가
//              · 글을 바꿔 Enter → PATCH 가 `{"body": …}` 한 키로 나가는가 · 응답 뒤 화면에 새 글 + 「수정됨」이 서는가(첨부는 그대로)
//              · 저장 뒤 포인터를 치우면 그 행의 호버 툴바가 남지 않는가
//            스레드 패널 칸은 실시간 에코(`message.edited`)를 **일부러 보내지 않는다**: 저장한 사람의 화면은 에코 없이 바뀌어야 한다.
//            관찰(단정 아님): 첨부만(글 없음)인 줄의 고치기 · 글자 위 우클릭(WebKit 은 낱말 선택이 앱 메뉴를 막는다).
//            예약 보냄은 서버가 `MessageType::Text` 로 같은 길로 넣으므로(`scheduler.rs` `deliver_schedule_in_tx`) 와이어에서 보통 글과 같다.
//   arrow    ↑ 키: 빈 입력칸 + ↑ = 이 대화에서 내 마지막 **글 있는** 메시지 고치기. 글이 든 입력칸·수식키·한글 조합 중의 ↑ 는 원래 동작.
//            Esc 취소 · Enter 저장 · 끝난 뒤 초점이 입력칸으로 돌아오는가. 마지막이 사진뿐이거나 남의 글이어도 내 마지막 글을 연다.
//            내 마지막 글이 **목록에 마운트돼 있지 않은 먼 위**에 있어도(그 아래 120줄이 남의 글) 목록이 그 줄로 가서 편집기를 연다.
//   ime      고치기 입력칸의 Enter: 조합 중(Chromium 순서)과 조합을 끝내는 한 번(WebKit 순서)은 저장이 아니다.
//   realtime 다른 사람이 고친 `message.edited` 프레임(첨부 키 없음)이 와도 글 + 「수정됨」 + 첨부가 남는다.
//
// 백엔드는 없다: `/v1/**` 는 이 파일 안의 메모리 서버(PATCH 가 실제로 행을 바꾼다)이고 소켓은 구독만 받는다. 인물은 전부 가상이다(레포는 공개).
// =============================================================================
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { chromium, webkit } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "captures/5191");
const PORT = Number(process.env.CAPTURE_PORT || 5391);
const DIST_DIR = process.env.DIST_DIR || "";
const SHOTS = process.env.SHOTS === "1";
const ENGINES = (process.env.BROWSERS || "chromium,webkit").split(",").map((s) => s.trim()).filter(Boolean);
const SCHEMES = (process.env.SCHEMES || "light").split(",").map((s) => s.trim()).filter(Boolean);
// 장면 고르기(진단용): ONLY=table,arrow,ime,realtime 중 일부. 기본은 전부.
const ONLY = new Set((process.env.ONLY || "table,arrow,ime,realtime").split(",").map((v) => v.trim()));
const MIN = 60_000;
const NOW = Date.UTC(2026, 10, 2, 5, 0, 0);

const workspaceId = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const SEO = "00000000-0000-7000-8000-000000000102";
const A1 = "00000000-0000-7000-8000-000000000301";
const CH = "00000000-0000-7000-8000-000000000201";
const GEN = "00000000-0000-7000-8000-000000000202";
const mid = (n) => `00000000-0000-7000-8000-0000000a${String(n).padStart(4, "0")}`;
const att = (n) => `00000000-0000-7000-8000-0000000f${String(n).padStart(4, "0")}`;
const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const person = (id, kind, displayName, handle, extra = {}) => ({
  id, workspaceId, kind, status: "active", displayName, handle, role: "member", channelCount: 2,
  channelIds: [CH, GEN], capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...extra,
});
const roster = [
  person(ME, "human", "이도현", "dohyun", { role: "owner" }),
  person(SEO, "human", "박서연", "seoyeon"),
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
  realtimeWebSocketUrl: "ws://capture-5191.invalid/connection/websocket",
};

// ---- 사진: 레포는 공개이고 캡처는 가상 인물이라, 사진도 도형만 있는 PNG 를 즉석에서 만든다. ------------------------
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i];
    for (let k = 0; k < 8; k += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function makePng(w, h, [r, g, b]) {
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y += 1) {
    raw[y * stride] = 0;
    for (let x = 0; x < w; x += 1) {
      const o = y * stride + 1 + x * 3;
      const band = Math.floor((x / w) * 3) === Math.floor((y / h) * 3) ? 28 : 0;
      raw[o] = Math.min(255, r + band + Math.floor((y / h) * 40));
      raw[o + 1] = Math.min(255, g + band + Math.floor((x / w) * 30));
      raw[o + 2] = Math.min(255, b + band);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const PHOTO_PNG = makePng(480, 300, [92, 120, 150]);
const PHOTO_2_PNG = makePng(360, 240, [150, 120, 92]);
const photo = (n, name) => ({ id: att(n), name, mime: "image/png", sizeBytes: 48_000 + n });

// ---- 메모리 서버 -------------------------------------------------------------------------------------------------------
/** 칸 이름 → 메시지 id. 표의 행이 이 이름으로 쓴다. */
const ID = {
  plain: mid(11), withPhoto: mid(12), photoOnly: mid(13), scheduled: mid(14), root: mid(15),
  agent: mid(16), other: mid(17), replyOther: mid(18), replyMine: mid(19), alsoMine: mid(20), last: mid(21),
};

function baseRow(seq, id, author, body, minAgo, extra = {}) {
  const createdAtMs = NOW - minAgo * MIN;
  return {
    id, channelId: CH, seq, hlcTs: createdAtMs, hlcCount: 0, authorMemberId: author, type: "text", body,
    state: "sent", createdAtMs, ...extra,
  };
}

/** 장면마다 새로 만든다 — 한 장면의 PATCH 가 다른 장면에 새지 않는다. */
function makeServer(variant = "default") {
  const rows = [
    baseRow(10, mid(10), SEO, "오늘 오후에 디자인 리뷰 가능하세요?", 60),
    baseRow(11, ID.plain, ME, "회의 시간은 3시로 정했어요, 참석 부탁드려요", 50),
    baseRow(12, ID.withPhoto, ME, "점심 먹은 곳 사진이에요", 45, { attachments: [photo(1, "lunch-spot.png")] }),
    baseRow(13, ID.photoOnly, ME, "", 40, { attachments: [photo(2, "board-draft.png")] }),
    baseRow(14, ID.scheduled, ME, "예약해서 보낸 글이에요, 아침 아홉 시에 나갔어요", 35),
    baseRow(15, ID.root, ME, "스레드를 여는 글이에요", 30, {
      thread: { reply_count: 3, last_reply_seq: 20, last_reply_at: NOW - 20 * MIN, participant_ids: [ME, SEO] },
    }),
    baseRow(16, ID.agent, A1, "에이전트가 정리한 요약이에요", 28),
    baseRow(17, ID.other, SEO, "남이 쓴 글은 내 화면에서 고칠 수 없어요", 26),
    baseRow(20, ID.alsoMine, ME, "이 답글은 대화에도 같이 보내요", 20, { rootId: ID.root, alsoInChannel: true }),
  ];
  const replies = [
    baseRow(18, ID.replyOther, SEO, "좋아요, 저도 그렇게 생각해요", 25, { rootId: ID.root }),
    baseRow(19, ID.replyMine, ME, "회의록은 제가 정리할게요", 22, { rootId: ID.root }),
    baseRow(20, ID.alsoMine, ME, "이 답글은 대화에도 같이 보내요", 20, { rootId: ID.root, alsoInChannel: true }),
  ];
  if (variant === "lastIsPhoto") {
    rows.push(baseRow(21, ID.last, ME, "", 5, { attachments: [photo(3, "after.png")] }));
  } else if (variant === "lastIsOthers") {
    rows.push(baseRow(21, ID.last, SEO, "마지막은 남의 글이에요", 5));
  } else if (variant === "farAbove") {
    // 내 마지막 글(seq 15)이 화면 한참 위에 있고 그 아래는 전부 남의 글이다: 가상 목록이 그 행을 마운트하지 않은 채로 시작한다.
    for (let i = 0; i < 120; i += 1) rows.push(baseRow(21 + i, mid(100 + i), SEO, `남이 이어서 쓴 ${i + 1}번째 글이에요, 길게 이어 가는 대화예요`, 30 - Math.floor(i / 5)));
  } else if (variant === "noMine") {
    for (let i = rows.length - 1; i >= 0; i -= 1) if (rows[i].authorMemberId === ME) rows[i].authorMemberId = SEO;
  } else {
    rows.push(baseRow(21, ID.last, ME, "마지막으로 보낸 내 글이에요", 5));
  }
  const server = { rows, replies, patches: [], failNextPatch: 0, patchStatus: 200 };
  return server;
}

function patchProjection(row, body) {
  // 서버가 내는 편집 투영: 첨부·스레드 롤업이 없다(`routes/messages.rs` `edit`).
  const rest = { ...row };
  delete rest.attachments;
  delete rest.thread;
  return { ...rest, body, state: "edited", editedAtMs: NOW + 90_000 };
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
    if (path.endsWith(`/workspaces/${workspaceId}`)) return json(route, { workspace: { id: workspaceId, name: "달무리 스튜디오" } });
    // 첨부 바이트(인가 프록시).
    const content = path.match(/\/attachments\/([^/]+)\/content$/);
    if (content) {
      const body = content[1] === att(2) ? PHOTO_2_PNG : PHOTO_PNG;
      return route.fulfill({ status: 200, contentType: "image/png", body });
    }
    // 고치기: `PATCH /v1/workspaces/{ws}/messages/{id}` — 작성자만, 빈 글 400, 지운 글 거절은 서버 계약 그대로.
    const edit = path.match(/\/workspaces\/[^/]+\/messages\/([^/]+)$/);
    if (edit && method === "PATCH") {
      const id = edit[1].toLowerCase();
      const raw = request.postData() ?? "";
      server.patches.push({ id, raw });
      if (server.patchStatus !== 200) {
        return json(route, { error: { code: "forbidden", message: "only the message author may edit" } }, server.patchStatus);
      }
      let body;
      try { body = JSON.parse(raw).body; } catch { body = undefined; }
      const row = [...server.rows, ...server.replies].find((r) => r.id.toLowerCase() === id);
      if (!row) return json(route, { error: { code: "not_found", message: "message not found" } }, 404);
      if (row.authorMemberId !== ME) return json(route, { error: { code: "forbidden", message: "only the message author may edit" } }, 403);
      if (typeof body !== "string" || body.trim() === "") return json(route, { error: { code: "bad_request", message: "message body must not be empty" } }, 400);
      const projection = patchProjection(row, body);
      // 서버는 저장한 뒤 모든 읽기에 새 글을 준다(첨부·롤업은 읽기 쪽이 싣는다).
      for (const list of [server.rows, server.replies]) {
        const at = list.findIndex((r) => r.id.toLowerCase() === id);
        if (at >= 0) list[at] = { ...list[at], body, state: "edited", editedAtMs: projection.editedAtMs };
      }
      return json(route, projection);
    }
    const replies = path.match(/\/channels\/[^/]+\/messages\/([^/]+)\/replies$/);
    if (replies) return json(route, { messages: server.replies.filter((r) => r.rootId?.toLowerCase() === replies[1].toLowerCase()), following: false });
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
          if (c.connect) return { id: c.id, connect: { client: "capture-5191", version: "6" } };
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
    // 다른 사람의 클라이언트가 보낸 것처럼 채널 프레임 하나를 밀어 넣는다. 채널 이름은 구독이 알려 준 것(`ch:` 포함)이다.
    window.__push = (data) => {
      const channel = window.__subs.find((name) => name.includes("ch:") || name.includes(":ch:")) ?? window.__subs[0];
      window.__offset += 1;
      window.__socket.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ push: { channel, pub: { data, offset: window.__offset } } }) }));
    };
  });
}

async function open(browserType, origin, scheme, server, viewport = { width: 1280, height: 800 }) {
  const browser = await browserType.launch();
  // 한국어 문맥으로 연다(#5326): 「수정됨」이 사전 낱말로 옮겨져 영어 브라우저에서는 「Edited」다. 이 레인의 단정은 한국어 글자를 읽는다.
  const context = await browser.newContext({ viewport, colorScheme: scheme, locale: "ko-KR", serviceWorkers: "block", reducedMotion: "reduce" });
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
  // 본류의 맨 아래 행(가상 목록이 처음에 마운트하는 줄)이 서면 준비된 것이다. 변형마다 마지막 seq 가 다르고, 스레드 답글(rootId)은 본류에 그려지지 않는다.
  const lastDrawn = [...server.rows].reverse().find((row) => !row.rootId);
  await page.locator(`[data-testid="timeline-message"][data-seq="${lastDrawn.seq}"]`).first().waitFor({ timeout: 20_000 });
  await page.mouse.move(2, 2);
  await page.waitForTimeout(900);
  return { browser, context, page };
}

// ---- 표 --------------------------------------------------------------------------------------------------------------
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${String(detail).slice(0, 300)}`}`);
}
const note = (line) => console.log(`     ${line}`);

/** 캡처(SHOTS=1). 단정의 성패와 무관하게 그 순간의 화면을 찍는다 — 고치기 전 번들에서도 「아무 일 없음」이 사진으로 남는다. */
async function shot(page, tag, name) {
  if (!SHOTS) return;
  mkdirSync(OUT_DIR, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: resolve(OUT_DIR, `5191-${tag.replace(/\s+/g, "-")}-${name}.png`) });
}

const rowById = (page, id) => page.locator(`[data-testid="timeline-message"][data-message-id="${id.toLowerCase()}"]`).first();
/** 호버 툴바(이모지 칩)를 뺀 행 글. 툴바는 포인터·초점에 따라 서고 사라지므로 글 비교에 섞이면 안 된다. */
const bodyOf = (row) =>
  row.evaluate((el) => {
    const clone = el.cloneNode(true);
    clone.querySelectorAll('[data-testid="message-hover-toolbar"]').forEach((node) => node.remove());
    return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
  });

/** 행에 포인터를 올려 ⋯ 를 눌러 메뉴를 열고 「고치기」 유무를 읽는다. 메뉴는 열어 둔 채 돌려준다. 툴바·⋯ 는 **그 행 안의 것**만 쓴다. */
async function openOverflow(page, row) {
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  await page.mouse.move(2, 2);
  await page.waitForTimeout(150);
  await centerInViewport(row);
  await row.hover();
  const toolbar = row.locator('[data-testid="message-hover-toolbar"]').first();
  const shown = await toolbar.waitFor({ state: "visible", timeout: 2500 }).then(() => true, () => false);
  if (!shown) return { toolbar: false, trigger: false, edit: false, items: [] };
  const trigger = row.locator('[data-testid="message-actions-trigger"]').first();
  if ((await trigger.count()) === 0) return { toolbar: true, trigger: false, edit: false, items: [] };
  await trigger.click();
  const menu = page.locator('[data-testid="message-action-menu"]').first();
  // 메뉴가 안 서도 던지지 않는다: 부하 때문에 늦은 것이든 정말 없는 것이든 표의 칸이 「없음」으로 적히고 다음 칸으로 간다.
  const menuShown = await menu.waitFor({ state: "visible", timeout: 4000 }).then(() => true, () => false);
  if (!menuShown) return { toolbar: true, trigger: true, edit: false, items: [] };
  const items = await menu.locator('[data-testid^="menu-"]').evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-testid")));
  return { toolbar: true, trigger: true, edit: items.includes("menu-edit"), items };
}

/** 행을 화면 가운데로: 캡처에서 행 글줄이 잘리지 않고, 호버 툴바·메뉴가 서는 자리가 위·아래로 넉넉하다. */
async function centerInViewport(row) {
  await row.evaluate((el) => el.scrollIntoView({ block: "center" }));
}

async function closeOverlays(page) {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(120);
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  await page.mouse.move(2, 2);
  await page.waitForTimeout(150);
}

/**
 * 우클릭 메뉴에 「고치기」가 있는가.
 *
 * 글자 **없는** 곳(행의 오른쪽 끝)을 누른다: WebKit 은 글자 위 우클릭이 그 낱말을 선택하고, 행 안에 선택이 있으면
 * 사용자 정의 메뉴는 브라우저 메뉴에 양보한다(`selectionWithinRow`, 설계). 글자 위 우클릭은 `observeContextOnText` 가 관찰만 한다.
 */
async function contextHasEdit(page, row) {
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  await page.mouse.move(2, 2);
  await page.waitForTimeout(100);
  await row.scrollIntoViewIfNeeded();
  const box = await row.boundingBox();
  if (!box) return { opened: false, edit: false };
  await page.mouse.click(box.x + box.width - 28, box.y + Math.min(box.height / 2, 40), { button: "right" });
  const menu = page.locator('[data-testid="message-context-menu"]').first();
  const opened = await menu.waitFor({ state: "visible", timeout: 2000 }).then(() => true, () => false);
  const edit = opened ? (await menu.locator('[data-testid="context-edit"]').count()) > 0 : false;
  if (!opened && process.env.DEBUG_5191) {
    const diag = await page.evaluate(() => ({
      menus: [...document.querySelectorAll('[role="menu"], [data-radix-popper-content-wrapper]')].map((n) => n.outerHTML.slice(0, 160)),
      selection: String(document.getSelection()),
      bodyPointerEvents: document.body.style.pointerEvents,
      active: document.activeElement?.tagName,
    }));
    console.log("DEBUG context:", JSON.stringify(diag));
  }
  await closeOverlays(page);
  return { opened, edit };
}

/** 관찰(단정 아님): 글자 **위** 우클릭에서 사용자 정의 메뉴가 서는가. WebKit(데스크탑 웹뷰)에서는 낱말 선택이 먼저라 안 설 수 있다. */
async function observeContextOnText(page, tag) {
  const row = rowById(page, ID.plain);
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  await page.mouse.move(2, 2);
  await page.waitForTimeout(100);
  await row.scrollIntoViewIfNeeded();
  const point = await row.evaluate((el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && !(node.textContent ?? "").includes("회의 시간")) node = walker.nextNode();
    if (!node) return null;
    const range = document.createRange();
    range.setStart(node, 1);
    range.setEnd(node, 3);
    const rect = range.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  if (!point) return note(`글자 위 우클릭(${tag}): 글자를 못 찾았다`);
  await page.mouse.click(point.x, point.y, { button: "right" });
  const opened = await page.locator('[data-testid="message-context-menu"]').first().waitFor({ state: "visible", timeout: 1500 }).then(() => true, () => false);
  const selection = await page.evaluate(() => String(document.getSelection()));
  note(`글자 위 우클릭(${tag}): 사용자 정의 메뉴 ${opened ? "섬" : "안 섬"} · 선택된 글 ${JSON.stringify(selection)}`);
  await closeOverlays(page);
  await page.evaluate(() => document.getSelection()?.removeAllRanges());
}

/** 열린 ⋯ 메뉴에서 「고치기」를 눌러 편집기가 그 행 안에 서는지 읽는다. */
async function startEditFromMenu(page, row) {
  await page.locator('[data-testid="menu-edit"]').first().click();
  const input = row.locator('[data-testid="message-editor-input"]').first();
  const opened = await input.waitFor({ state: "visible", timeout: 2500 }).then(() => true, () => false);
  return { opened, input };
}

async function runCell(page, server, cell, tag, ctx = {}) {
  const name = `${tag} ${cell.label}`;
  const row = ctx.row ? ctx.row(cell.id) : rowById(page, cell.id);
  const found = await row.waitFor({ state: "visible", timeout: 4000 }).then(() => true, () => false);
  check(`${name}: 행이 화면에 있다`, found);
  if (!found) return { name, found: false };

  const beforeText = await bodyOf(row);
  const overflow = await openOverflow(page, row);
  // 표의 한 줄(눈으로 읽는 용): 툴바 · ⋯ · 메뉴 항목 수 · 고치기.
  note(`${cell.label}: 툴바 ${overflow.toolbar ? "섬" : "없음"} · ⋯ ${overflow.trigger ? "있음" : "없음"} · 메뉴 항목 ${overflow.items.length} · 고치기 ${overflow.edit ? "있음" : "없음"}`);
  check(`${name}: ⋯ 메뉴의 「고치기」 ${cell.expectEdit ? "있음" : "없음"}`, overflow.edit === cell.expectEdit, `items=${JSON.stringify(overflow.items)}`);
  let context = { edit: false };
  if (!overflow.edit) {
    await closeOverlays(page);
  } else {
    // 메뉴를 닫고 우클릭도 잰다(같은 항목이 있어야 한다).
    await closeOverlays(page);
  }
  context = await contextHasEdit(page, row);
  check(`${name}: 우클릭 메뉴의 「고치기」 ${cell.expectEdit ? "있음" : "없음"}`, context.edit === cell.expectEdit, JSON.stringify(context));
  if (!cell.expectEdit) return { name, found: true };

  // ---- 편집 흐름 ----
  const again = await openOverflow(page, row);
  if (cell.hasPhoto) await shot(page, tag, "01-menu-attachment-message");
  if (!again.edit) {
    check(`${name}: 고치기를 눌러 편집기가 열린다`, false, "메뉴에 고치기가 없다");
    return { name, found: true };
  }
  const started = await startEditFromMenu(page, row);
  if (cell.hasPhoto) await shot(page, tag, "02-editor-attachment-message");
  check(`${name}: 고치기를 누르면 그 행 안에 편집기가 열린다`, started.opened);
  if (!started.opened) return { name, found: true };
  const initial = await started.input.inputValue();
  check(`${name}: 편집기가 지금 글로 열린다`, initial === (cell.body ?? ""), `value=${JSON.stringify(initial)}`);

  // Esc 는 PATCH 없이 닫는다.
  const patchesBefore = server.patches.length;
  await started.input.press("End");
  await started.input.pressSequentially(" (덧붙임)");
  await started.input.press("Escape");
  await page.waitForTimeout(250);
  check(`${name}: Esc 는 편집기를 닫고 PATCH 를 보내지 않는다`, (await row.locator('[data-testid="message-editor"]').count()) === 0 && server.patches.length === patchesBefore, `patches=${server.patches.length - patchesBefore}`);
  check(`${name}: Esc 뒤 글은 그대로다`, (await bodyOf(row)) === beforeText, await bodyOf(row));

  // 저장: 글을 바꿔 Enter.
  const reopen = await openOverflow(page, row);
  if (!reopen.edit) {
    check(`${name}: 다시 열어 저장할 수 있다`, false, "메뉴에 고치기가 없다");
    return { name, found: true };
  }
  const second = await startEditFromMenu(page, row);
  const nextBody = `${cell.body ?? ""} (고침)`.trim();
  await second.input.press("End");
  await second.input.pressSequentially(cell.body ? " (고침)" : "(고침)");
  const waitPatch = page.waitForRequest((request) => request.method() === "PATCH", { timeout: 4000 }).catch(() => null);
  await second.input.press("Enter");
  const request = await waitPatch;
  const sent = request ? request.postData() : null;
  check(`${name}: Enter 는 PATCH 하나를 {"body": …} 한 키로 보낸다`, sent !== null && JSON.stringify(Object.keys(JSON.parse(sent))) === '["body"]' && JSON.parse(sent).body === nextBody, `sent=${sent}`);
  await page.waitForTimeout(700);
  const after = await bodyOf(row);
  check(`${name}: 저장 뒤 화면에 새 글이 선다`, after.includes("(고침)"), after);
  check(`${name}: 저장 뒤 「수정됨」이 선다`, after.includes("수정됨"), after);
  if (cell.hasPhoto) {
    check(`${name}: 저장 뒤 첨부는 그대로다`, (await row.locator('[data-testid="attachment-list"]').count()) === 1, `attachment-list=${await row.locator('[data-testid="attachment-list"]').count()}`);
  }
  await page.mouse.move(2, 2);
  await page.waitForTimeout(400);
  // 저장이 끝나 편집기가 사라진 뒤, 포인터를 치우면 이 행의 호버 툴바도 사라져야 한다(편집기에 있던 초점이 행에 남아 툴바를 붙들지 않는다).
  const stuck = await row.locator('[data-testid="message-hover-toolbar"]').count();
  if (stuck !== 0 && process.env.DEBUG_5191) {
    const rowHover = await row.evaluate((el) => el.matches(":hover"));
    console.log("DEBUG stuck:", cell.label, "rowHover=", rowHover, JSON.stringify(await page.evaluate(() => {
      const a = document.activeElement;
      return {
        tag: a?.tagName, testid: a?.getAttribute?.("data-testid"), id: a?.id,
        insideRow: a?.closest?.('[data-testid="timeline-message"]')?.getAttribute("data-seq") ?? null,
        hovered: [...document.querySelectorAll(":hover")].map((n) => n.getAttribute?.("data-testid") ?? n.tagName).slice(-4),
        menus: document.querySelectorAll('[role="menu"]').length,
        dialogs: document.querySelectorAll('[role="dialog"]').length,
        toolbars: [...document.querySelectorAll('[data-testid="message-hover-toolbar"]')].map((t) => t.closest('[data-testid="timeline-message"]')?.getAttribute("data-seq")),
        selection: String(document.getSelection()).slice(0, 20),
      };
    })));
  }
  check(`${name}: 저장 뒤 포인터를 치우면 이 행의 툴바가 남지 않는다`, stuck === 0, `toolbars=${stuck}`);
  // 캡처는 **단정을 다 마친 뒤**, 포인터를 치운 채로 행을 가운데에 놓고 찍는다(저장 뒤에는 편집기가 글줄로 줄어 행이 위로 밀려 잘린다).
  if (cell.hasPhoto) {
    await centerInViewport(row);
    await shot(page, tag, "03-saved-attachment-message");
  }
  return { name, found: true };
}

const MAIN_CELLS = [
  { id: ID.plain, label: "글(내 메시지)", expectEdit: true, body: "회의 시간은 3시로 정했어요, 참석 부탁드려요" },
  { id: ID.withPhoto, label: "첨부 든 글", expectEdit: true, body: "점심 먹은 곳 사진이에요", hasPhoto: true },
  { id: ID.scheduled, label: "예약해서 보낸 글", expectEdit: true, body: "예약해서 보낸 글이에요, 아침 아홉 시에 나갔어요" },
  { id: ID.root, label: "스레드 루트(내 글)", expectEdit: true, body: "스레드를 여는 글이에요" },
  { id: ID.other, label: "남의 글", expectEdit: false },
  { id: ID.agent, label: "에이전트 글", expectEdit: false },
];

const THREAD_CELLS = [
  { id: ID.replyMine, label: "내 답글" },
  { id: ID.alsoMine, label: "대화에도 보낸 내 답글" },
  { id: ID.root, label: "스레드 루트(내 글)" },
];

/** 내 첨부만(글 없음): 서버는 받지만 「글이 있는 메시지」가 아니다. 이 칸은 단정이 아니라 **관찰**을 적는다. */
async function observePhotoOnly(page) {
  const row = rowById(page, ID.photoOnly);
  const found = await row.waitFor({ state: "visible", timeout: 4000 }).then(() => true, () => false);
  if (!found) return note(`첨부만(글 없음): 행을 못 찾았다`);
  const overflow = await openOverflow(page, row);
  let opened = false;
  let initial = null;
  if (overflow.edit) {
    const started = await startEditFromMenu(page, row);
    opened = started.opened;
    initial = opened ? await started.input.inputValue() : null;
    if (opened) await started.input.press("Escape");
  } else {
    await closeOverlays(page);
  }
  note(`첨부만(글 없음): ⋯ 메뉴 고치기 ${overflow.edit ? "있음" : "없음"}${overflow.edit ? ` · 편집기 ${opened ? "열림" : "안 열림"}(처음 글 ${JSON.stringify(initial)})` : ""}`);
  await page.mouse.move(2, 2);
  await page.waitForTimeout(200);
}

// ---- 스레드 패널 안의 내 글(답글·루트) -----------------------------------------------------------------------------------
/**
 * 패널을 열고, 패널 안의 그 줄에서 고치기 → 저장까지 한다. 실시간 에코(`message.edited`)는 **일부러 보내지 않는다**:
 * 저장한 사람 자기 화면은 에코를 기다리지 않고 응답으로 바뀌어야 한다(에코는 다른 기기·다른 사람의 몫).
 */
async function runThreadCell(page, server, tag, cell) {
  const name = `${tag} 스레드 패널 안 ${cell.label}`;
  const root = rowById(page, ID.root);
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  await page.mouse.move(2, 2);
  await page.waitForTimeout(150);
  await root.scrollIntoViewIfNeeded();
  await root.hover();
  const replyButton = root.locator('[data-testid="toolbar-reply"]').first();
  const reachable = await replyButton.waitFor({ state: "visible", timeout: 2500 }).then(() => true, () => false);
  if (reachable) await replyButton.click();
  const panel = page.locator('[data-testid="thread-panel"]').first();
  const shown = await panel.waitFor({ state: "visible", timeout: 4000 }).then(() => true, () => false);
  check(`${name}: 스레드 패널이 열린다`, shown, `reachable=${reachable}`);
  if (!shown) return;
  const line = panel.locator(`[data-message-id="${cell.id.toLowerCase()}"]`).first();
  const loaded = await line.waitFor({ state: "visible", timeout: 4000 }).then(() => true, () => false);
  check(`${name}: 그 줄이 패널에 있다`, loaded);
  if (!loaded) {
    if (process.env.DEBUG_5191) console.log("DEBUG panel:", (await panel.innerText()).replace(/\s+/g, " ").slice(0, 600));
    return;
  }
  const overflow = await openOverflow(page, line);
  note(`스레드 패널 안 ${cell.label}: 메뉴 항목 ${overflow.items.length} · 고치기 ${overflow.edit ? "있음" : "없음"}`);
  check(`${name}: ⋯ 메뉴의 「고치기」 있음`, overflow.edit, JSON.stringify(overflow.items));
  if (!overflow.edit) return;
  await page.locator('[data-testid="menu-edit"]').first().click();
  const input = line.locator('[data-testid="message-editor-input"]').first();
  const opened = await input.waitFor({ state: "visible", timeout: 2500 }).then(() => true, () => false);
  check(`${name}: 편집기가 열린다`, opened);
  if (!opened) return;
  await input.press("End");
  await input.pressSequentially(" (고침)");
  const patch = page.waitForRequest((request) => request.method() === "PATCH", { timeout: 4000 }).catch(() => null);
  await input.press("Enter");
  const request = await patch;
  check(`${name}: Enter 는 PATCH 하나를 보낸다`, request !== null, "PATCH 없음");
  await page.waitForTimeout(900);
  const after = await bodyOf(line);
  if (cell.id === ID.replyMine) await shot(page, tag, "05-thread-panel-after-save");
  check(`${name}: 저장 뒤 패널의 줄이 새 글로 바뀐다(에코 없이)`, after.includes("(고침)"), after);
  check(`${name}: 저장 뒤 「수정됨」이 선다`, after.includes("수정됨"), after);
  await page.mouse.move(2, 2);
}

// ---- ↑ 키 --------------------------------------------------------------------------------------------------------------
const composerOf = (page) => page.locator("#composer-input");
const activeId = (page) => page.evaluate(() => document.activeElement?.id || document.activeElement?.getAttribute("data-testid") || document.activeElement?.tagName || "");

async function runArrowUp(browserType, origin, scheme, tag) {
  const server = makeServer("default");
  const { browser, context, page } = await open(browserType, origin, scheme, server);
  try {
    const composer = composerOf(page);
    await composer.click();
    await composer.press("ArrowUp");
    const editor = page.locator('[data-testid="message-editor-input"]').first();
    const opened = await editor.waitFor({ state: "visible", timeout: 2500 }).then(() => true, () => false);
    await shot(page, tag, "04-arrow-up-editor");
    check(`${tag} ↑ 빈 입력칸: 내 마지막 글의 편집기가 열린다`, opened);
    if (opened) {
      const target = rowById(page, ID.last);
      check(`${tag} ↑ 빈 입력칸: 편집기가 마지막 글(seq 21) 행 안에 선다`, (await target.locator('[data-testid="message-editor-input"]').count()) === 1);
      check(`${tag} ↑ 빈 입력칸: 편집기가 마지막 글로 열린다`, (await editor.inputValue()) === "마지막으로 보낸 내 글이에요", await editor.inputValue());
      check(`${tag} ↑ 빈 입력칸: 편집기에 초점이 간다`, (await activeId(page)) === "message-editor-input", await activeId(page));
      const start = server.patches.length;
      await editor.press("Escape");
      await page.waitForTimeout(250);
      check(`${tag} ↑ Esc: 편집기가 닫히고 PATCH 가 없다`, (await page.locator('[data-testid="message-editor"]').count()) === 0 && server.patches.length === start);
      check(`${tag} ↑ Esc: 초점이 입력칸으로 돌아온다`, (await activeId(page)) === "composer-input", await activeId(page));

      // 다시 ↑ → 고쳐서 Enter 저장.
      await composerOf(page).press("ArrowUp");
      const again = page.locator('[data-testid="message-editor-input"]').first();
      await again.waitFor({ state: "visible", timeout: 2500 }).catch(() => null);
      await again.press("End");
      await again.pressSequentially(" (고침)");
      const patch = page.waitForRequest((request) => request.method() === "PATCH", { timeout: 4000 }).catch(() => null);
      await again.press("Enter");
      const request = await patch;
      const sent = request ? request.postData() : null;
      check(`${tag} ↑ Enter: PATCH 가 마지막 글로 한 번 나간다`, sent !== null && JSON.parse(sent).body === "마지막으로 보낸 내 글이에요 (고침)" && request.url().toLowerCase().endsWith(`/messages/${ID.last.toLowerCase()}`), `sent=${sent}`);
      await page.waitForTimeout(600);
      const text = await bodyOf(target);
      check(`${tag} ↑ Enter: 저장 뒤 새 글 + 「수정됨」`, text.includes("(고침)") && text.includes("수정됨"), text);
      check(`${tag} ↑ Enter: 저장 뒤 초점이 입력칸으로 돌아온다`, (await activeId(page)) === "composer-input", await activeId(page));
      if (SHOTS) {
        mkdirSync(OUT_DIR, { recursive: true });
        await page.screenshot({ path: resolve(OUT_DIR, `5191-${tag.replace(/\s+/g, "-")}-after-save.png`) });
      }
    }

    // 입력칸에 글이 있으면 ↑ 는 원래 동작이다.
    await composerOf(page).click();
    await composerOf(page).pressSequentially("보내려고 쓰던 글");
    const countBefore = await page.locator('[data-testid="message-editor"]').count();
    await composerOf(page).press("ArrowUp");
    await page.waitForTimeout(250);
    check(`${tag} ↑ 글이 있는 입력칸: 편집기가 열리지 않는다`, (await page.locator('[data-testid="message-editor"]').count()) === countBefore);
    check(`${tag} ↑ 글이 있는 입력칸: 쓰던 글이 그대로다`, (await composerOf(page).inputValue()) === "보내려고 쓰던 글", await composerOf(page).inputValue());

    // 수식키가 붙은 ↑ 는 우리 것이 아니다.
    await composerOf(page).fill("");
    for (const combo of ["Shift+ArrowUp", "Alt+ArrowUp", "Control+ArrowUp", "Meta+ArrowUp"]) {
      await composerOf(page).press(combo);
      await page.waitForTimeout(80);
    }
    check(`${tag} ↑ 수식키(Shift·Alt·Ctrl·Cmd)+↑: 편집기가 열리지 않는다`, (await page.locator('[data-testid="message-editor"]').count()) === countBefore);

    // 한글 조합 중 ↑ 도 우리 것이 아니다(후보 창이 가진다): 조합 중 keydown 은 isComposing=true.
    const composing = await page.evaluate(() => {
      const area = document.getElementById("composer-input");
      if (!area) return null;
      area.focus();
      area.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      const event = new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true, isComposing: true });
      area.dispatchEvent(event);
      area.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      return { defaultPrevented: event.defaultPrevented };
    });
    await page.waitForTimeout(200);
    check(`${tag} ↑ 조합 중: 편집기가 열리지 않는다`, composing !== null && (await page.locator('[data-testid="message-editor"]').count()) === countBefore, JSON.stringify(composing));
  } finally {
    await context.close();
    await browser.close();
  }

  // 마지막이 사진뿐이면 그 앞의 글 있는 내 메시지를 고친다(글이 없는 메시지는 건너뛴다).
  {
    const s = makeServer("lastIsPhoto");
    const o = await open(browserType, origin, scheme, s);
    try {
      await composerOf(o.page).click();
      await composerOf(o.page).press("ArrowUp");
      const editor = o.page.locator('[data-testid="message-editor-input"]').first();
      const opened = await editor.waitFor({ state: "visible", timeout: 2500 }).then(() => true, () => false);
      const value = opened ? await editor.inputValue() : null;
      const inside = opened ? await o.page.evaluate(() => document.querySelector('[data-testid="message-editor"]')?.closest('[data-testid="timeline-message"]')?.getAttribute("data-seq")) : null;
      check(`${tag} ↑ 마지막이 사진뿐: 사진은 건너뛰고 본류의 그 앞 내 글(seq 15)이 열린다`, opened && value === "스레드를 여는 글이에요" && inside === "15", `value=${JSON.stringify(value)} seq=${inside}`);
    } finally {
      await o.context.close();
      await o.browser.close();
    }
  }
  // 마지막이 남의 글이어도 내 마지막 글이 열린다(「이 대화에서 **내** 마지막」).
  {
    const s = makeServer("lastIsOthers");
    const o = await open(browserType, origin, scheme, s);
    try {
      await composerOf(o.page).click();
      await composerOf(o.page).press("ArrowUp");
      const editor = o.page.locator('[data-testid="message-editor-input"]').first();
      const opened = await editor.waitFor({ state: "visible", timeout: 2500 }).then(() => true, () => false);
      const inside = opened ? await o.page.evaluate(() => document.querySelector('[data-testid="message-editor"]')?.closest('[data-testid="timeline-message"]')?.getAttribute("data-seq")) : null;
      check(`${tag} ↑ 마지막이 남의 글: 본류의 내 마지막 글(seq 15)이 열린다`, opened && inside === "15", `seq=${inside}`);
    } finally {
      await o.context.close();
      await o.browser.close();
    }
  }
  // 내 마지막 글이 목록에 마운트돼 있지 않은 먼 위에 있어도(그 아래는 전부 남의 글) ↑ 가 그 줄로 옮겨 가 편집기를 연다.
  {
    const s = makeServer("farAbove");
    const o = await open(browserType, origin, scheme, s);
    try {
      const mountedBefore = await o.page.locator('[data-testid="timeline-message"][data-seq="15"]').count();
      await composerOf(o.page).click();
      await composerOf(o.page).press("ArrowUp");
      const editor = o.page.locator('[data-testid="message-editor-input"]').first();
      const opened = await editor.waitFor({ state: "visible", timeout: 4500 }).then(() => true, () => false);
      const info = opened
        ? await editor.evaluate((el) => {
            const rect = el.getBoundingClientRect();
            return { seq: el.closest('[data-testid="timeline-message"]')?.getAttribute("data-seq") ?? null, inView: rect.top >= 0 && rect.bottom <= window.innerHeight };
          })
        : null;
      await shot(o.page, tag, "06-arrow-up-far-above");
      check(`${tag} ↑ 먼 위의 내 글: 전제 — 그 행이 처음에는 마운트돼 있지 않다`, mountedBefore === 0, `mounted=${mountedBefore}`);
      check(`${tag} ↑ 먼 위의 내 글: 목록이 그 줄로 가고 편집기가 열린다(seq 15, 화면 안)`, opened && info?.seq === "15" && info.inView === true, JSON.stringify(info));
    } finally {
      await o.context.close();
      await o.browser.close();
    }
  }
  // 고칠 내 글이 하나도 없으면 아무 일도 없다.
  {
    const s = makeServer("noMine");
    const o = await open(browserType, origin, scheme, s);
    try {
      await composerOf(o.page).click();
      await composerOf(o.page).press("ArrowUp");
      await o.page.waitForTimeout(400);
      check(`${tag} ↑ 내 글이 없다: 편집기가 열리지 않는다`, (await o.page.locator('[data-testid="message-editor"]').count()) === 0);
    } finally {
      await o.context.close();
      await o.browser.close();
    }
  }
}

// ---- 편집기 안 한글 조합 ------------------------------------------------------------------------------------------------
async function runEditorIme(browserType, origin, scheme, tag) {
  const server = makeServer("default");
  const { browser, context, page } = await open(browserType, origin, scheme, server);
  try {
    const row = rowById(page, ID.plain);
    await openOverflow(page, row);
    const started = await startEditFromMenu(page, row);
    if (!started.opened) return check(`${tag} 편집기 조합: 편집기가 열린다`, false);
    // 글을 바꿔 둔다: 바뀐 게 없으면 Enter 는 저장이 아니라 「그냥 닫기」라서 프로브가 아무것도 못 잰다.
    await started.input.press("End");
    await started.input.pressSequentially(" (고침)");
    const before = server.patches.length;
    // 조합이 열려 있는 동안의 Enter(Chromium 순서: keydown isComposing=true) 는 저장이 아니다.
    const chromiumOrder = await page.evaluate(() => {
      const area = document.querySelector('[data-testid="message-editor-input"]');
      area.focus();
      area.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      const down = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: true });
      area.dispatchEvent(down);
      area.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      return down.defaultPrevented;
    });
    await page.waitForTimeout(300);
    check(`${tag} 편집기 조합: 조합 중 Enter(Chromium 순서)는 저장이 아니다`, server.patches.length === before, `patches=${server.patches.length - before} prevented=${chromiumOrder}`);
    // WebKit 순서: compositionend → keydown(Enter, isComposing=false). 같은 한 번의 키로 저장이 나가면 안 된다.
    const webkitOrder = await page.evaluate(() => {
      const area = document.querySelector('[data-testid="message-editor-input"]');
      if (!area) return null;
      area.focus();
      area.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      area.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      const down = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: false });
      area.dispatchEvent(down);
      return down.defaultPrevented;
    });
    await page.waitForTimeout(300);
    check(`${tag} 편집기 조합: 조합을 끝내는 Enter(WebKit 순서)는 저장이 아니다`, webkitOrder !== null && server.patches.length === before, `patches=${server.patches.length - before}`);
  } finally {
    await context.close();
    await browser.close();
  }
}

// ---- 실시간 ----------------------------------------------------------------------------------------------------------
async function runRealtime(browserType, origin, scheme, tag) {
  const server = makeServer("default");
  const { browser, context, page } = await open(browserType, origin, scheme, server);
  try {
    const subs = await page.evaluate(() => window.__subs ?? []);
    check(`${tag} 실시간: 채널 구독이 있다`, subs.length > 0, JSON.stringify(subs));
    const frame = (row, body) => ({
      type: "message.edited", v: 1, ts: NOW + 120_000, seq: row.seq,
      payload: {
        id: row.id, channel_id: CH, seq: row.seq, hlc_ts: row.hlcTs, hlc_count: 0, author_member_id: row.authorMemberId,
        type: "text", state: "edited", body, props: {}, root_id: row.rootId ?? null, reply_to_id: null, run_id: null,
        client_msg_id: null, created_at_ms: row.createdAtMs, edited_at_ms: NOW + 119_000, deleted_at_ms: null,
      },
    });
    // 다른 사람이 자기 글을 고쳤다.
    const other = server.rows.find((r) => r.id === ID.other);
    await page.evaluate((data) => window.__push(data), frame(other, "박서연이 고친 글이에요"));
    await page.waitForTimeout(500);
    const otherText = await bodyOf(rowById(page, ID.other));
    check(`${tag} 실시간: 남이 고친 글이 내 화면에서 바뀌고 「수정됨」이 선다`, otherText.includes("박서연이 고친 글이에요") && otherText.includes("수정됨"), otherText);
    // 내가 다른 기기(폰)에서 첨부 든 글을 고쳤다: 프레임에는 첨부 키가 없다.
    const mine = server.rows.find((r) => r.id === ID.withPhoto);
    await page.evaluate((data) => window.__push(data), frame(mine, "점심 먹은 곳 사진이에요 (가게 이름 추가)"));
    await page.waitForTimeout(500);
    const row = rowById(page, ID.withPhoto);
    const mineText = await bodyOf(row);
    check(`${tag} 실시간: 첨부 든 글의 고침이 오면 새 글 + 「수정됨」`, mineText.includes("(가게 이름 추가)") && mineText.includes("수정됨"), mineText);
    check(`${tag} 실시간: 첨부는 그대로 남는다(프레임에 첨부 키가 없어도)`, (await row.locator('[data-testid="attachment-list"]').count()) === 1);
  } finally {
    await context.close();
    await browser.close();
  }
}

async function runTable(browserType, origin, scheme, tag) {
  const server = makeServer("default");
  const { browser, context, page } = await open(browserType, origin, scheme, server);
  try {
    for (const cell of MAIN_CELLS) await runCell(page, server, cell, tag);
    await observePhotoOnly(page);
    await observeContextOnText(page, tag);
  } finally {
    await context.close();
    await browser.close();
  }
  // 스레드 패널은 앞 칸들이 남긴 초점·선택에 오염되지 않게 칸마다 **새 페이지**에서 잰다.
  for (const cell of THREAD_CELLS) {
    const threadServer = makeServer("default");
    const fresh = await open(browserType, origin, scheme, threadServer);
    try {
      await runThreadCell(fresh.page, threadServer, tag, cell);
    } finally {
      await fresh.context.close();
      await fresh.browser.close();
    }
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
    for (const engineName of ENGINES) {
      const engine = engineName === "webkit" ? webkit : chromium;
      for (const scheme of SCHEMES) {
        const tag = `${engineName} ${scheme}`;
        console.log(`--- ${tag}`);
        if (ONLY.has("table")) await runTable(engine, preview.origin, scheme, tag);
        if (ONLY.has("arrow")) await runArrowUp(engine, preview.origin, scheme, tag);
        if (ONLY.has("ime")) await runEditorIme(engine, preview.origin, scheme, tag);
        if (ONLY.has("realtime")) await runRealtime(engine, preview.origin, scheme, tag);
      }
    }
  } finally {
    await preview.stop?.();
  }
  const bad = results.filter((r) => !r.ok);
  console.log(
    bad.length === 0
      ? `EDIT-MESSAGE-5191 PASS (${results.length} checks)`
      : `EDIT-MESSAGE-5191 FAIL (${bad.length}/${results.length}): ${bad.map((r) => r.name).join(" | ")}`
  );
  process.exit(bad.length === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
