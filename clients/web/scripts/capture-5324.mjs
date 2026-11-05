#!/usr/bin/env node
// =============================================================================
// #5324 레인: 스레드 답글의 「대화에도 보내기」를 화면에서 뺀 자리 + 스레드 패널 입력창이 본 입력창과 같은 카드인가
// (웹 Chromium · 데스크탑 웹뷰 대리 = WebKit).
//
//   npm run build && node scripts/capture-5324.mjs
//   DIST_DIR=<다른 dist> node scripts/capture-5324.mjs      # 고치기 전 번들로 RED 를 다시 볼 때
//   BROWSERS=chromium node scripts/capture-5324.mjs          # 한 엔진만(기본: chromium)
//   SCHEMES=light,dark node scripts/capture-5324.mjs         # 기본은 light
//   SHOTS=1 OUT_DIR=<dir> WIDTHS=1280,720 node scripts/capture-5324.mjs   # 캡처도 찍기(기본은 재기만)
//
// 단정이 곧 표다. 한 장면에서 아래를 모두 잰다.
//
//   본류      서버가 `alsoInChannel: true` 로 저장해 둔 옛 답글(루트의 스레드 답글)은 **스레드에만** 보인다 — 본류에 행도 「↳ ○○님 스레드에 답글」
//             줄도 서지 않고, 스레드 패널에는 보인다.
//   입력칸    스레드 입력창에 「대화에도 보내기」 체크가 없고, 보내기 요청 본문에 `alsoInChannel` 키가 없다(루트 `rootId` 는 간다).
//   같은 카드 스레드 입력창 그릇이 본 입력창 그릇과 **계산된 값**으로 같다 — 테두리 두께·색, 둥글기, 그림자, 바탕, 안쪽 여백. 도구 줄의 단추
//             묶음(첨부·멘션·이모지·서식·보내기·예약 ▾)도 같고, 보내기 단추의 둥글기·바탕이 같다. 다른 것은 자리표시 글뿐이다.
//   오프라인  막힌 채널 입력창(스레드를 닫은 동안)·스레드 입력창(연 동안)의 원인 문장은 어절에서 꺾인다(#5294: 계산된 word-break 가 keep-all —
//             이 검사는 지워진 `capture-4888.mjs` 가 하던 것이라 이 하네스가 이어받는다).
//
// 백엔드는 없다: `/v1/**` 는 이 파일 안의 메모리 서버다(POST 가 행을 만들고 받은 본문을 기록한다). 인물은 전부 가상이다(레포는 공개).
// =============================================================================
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "captures/5324");
const PORT = Number(process.env.CAPTURE_PORT || 5424);
const DIST_DIR = process.env.DIST_DIR || "";
const SHOTS = process.env.SHOTS === "1";
const ENGINES = (process.env.BROWSERS || "chromium").split(",").map((s) => s.trim()).filter(Boolean);
const SCHEMES = (process.env.SCHEMES || "light").split(",").map((s) => s.trim()).filter(Boolean);
const WIDTHS = (process.env.WIDTHS || "1280").split(",").map((s) => Number(s.trim())).filter(Boolean);
/** 캡처는 넓은 창(≥900)에서만 찍는다 — 좁은 창은 스레드가 채널을 덮어 두 입력창을 한 장에 담지 못한다. */
const SHOT_MIN_WIDTH = 900;
const MIN = 60_000;
const NOW = Date.UTC(2026, 10, 5, 5, 0, 0);

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
  realtimeWebSocketUrl: "ws://capture-5324.invalid/connection/websocket",
};

const ID = { root: mid(10), thread: mid(11), mine: mid(12), last: mid(13), oldAlso: mid(14) };
const ROOT_TEXT = "오늘 점심 뭐 먹을까요? 메뉴 추천 받아요";
const OLD_ALSO_TEXT = "점심은 국밥으로 정했어요, 12시에 로비에서 봐요";

function baseRow(seq, id, author, body, minAgo, extra = {}) {
  const createdAtMs = NOW - minAgo * MIN;
  return { id, channelId: CH, seq, hlcTs: createdAtMs, hlcCount: 0, authorMemberId: author, type: "text", body, state: "sent", createdAtMs, ...extra };
}

/** 서버가 이미 가진 행들. `oldAlso` 는 「대화에도 보내기」가 있던 때 켜고 보낸 내 답글이다(서버 필드는 그대로 온다). */
function makeServer() {
  const rows = [
    baseRow(10, ID.root, SEO, ROOT_TEXT, 50, {
      thread: { reply_count: 2, last_reply_seq: 14, last_reply_at: NOW - 10 * MIN, participant_ids: [ME, SEO], participant_count: 2 },
    }),
    baseRow(11, ID.thread, SEO, "저는 국밥이 좋아요", 45, { rootId: ID.root }),
    baseRow(12, ID.mine, ME, "회의 시간은 3시로 정했어요, 참석 부탁드려요", 40),
    baseRow(13, ID.last, SEO, "오늘 일정 공유드려요", 30),
    baseRow(14, ID.oldAlso, ME, OLD_ALSO_TEXT, 10, { rootId: ID.root, alsoInChannel: true }),
  ];
  return { rows, posts: [], nextSeq: 20 };
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
    // 보내기: 받은 본문을 그대로 기록한다 — 단정은 이 기록을 읽는다.
    if (path.endsWith(`/channels/${CH}/messages`) && method === "POST") {
      const raw = request.postData() ?? "";
      let body = {};
      try { body = JSON.parse(raw); } catch { body = {}; }
      server.posts.push({ raw, body });
      server.nextSeq += 1;
      const seq = server.nextSeq;
      const row = baseRow(seq, mid(seq), ME, body.body ?? "", 0, {
        ...(body.rootId ? { rootId: body.rootId } : {}),
        ...(body.alsoInChannel === true ? { alsoInChannel: true } : {}),
      });
      server.rows.push(row);
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
        queueMicrotask(() => { this.readyState = 1; this.onopen?.(new Event("open")); });
      }
      send(data) {
        const replies = String(data).trim().split("\n").map((line) => {
          const c = JSON.parse(line);
          if (c.connect) return { id: c.id, connect: { client: "capture-5324", version: "6" } };
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

async function open(browserType, origin, scheme, server, viewport) {
  const browser = await browserType.launch();
  const context = await browser.newContext({ viewport, colorScheme: scheme, locale: "ko-KR", timezoneId: "Asia/Seoul", serviceWorkers: "block", reducedMotion: "reduce" });
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
  await page.locator(`[data-testid="timeline-virtuoso"] [data-testid="timeline-message"][data-seq="13"]`).first().waitFor({ timeout: 20_000 });
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
  // 직전 클릭이 남긴 호버가 사진에 찍히지 않게 포인터를 치우고 가라앉힌다.
  await page.mouse.move(2, 2);
  await page.waitForTimeout(450);
  await page.screenshot({ path: resolve(OUT_DIR, `5324-${tag.replace(/\s+/g, "-")}-${name}.png`) });
}

/** 보이는 요소 하나만 잘라 찍는다. 안 보이면 건너뛴다. */
async function cropShot(locator, tag, name) {
  if (!SHOTS) return;
  mkdirSync(OUT_DIR, { recursive: true });
  if (!(await locator.isVisible().catch(() => false))) return;
  await locator.screenshot({ path: resolve(OUT_DIR, `5324-${tag.replace(/\s+/g, "-")}-${name}.png`) });
}

const main = (page) => page.locator('[data-testid="timeline-virtuoso"]');
const panel = (page) => page.locator('[data-testid="thread-panel"]');
const threadInput = (page) => page.locator('[data-testid="thread-composer-input"]');

async function openRootThread(page) {
  await main(page).locator(`[data-testid="timeline-message"][data-message-id="${ID.root.toLowerCase()}"] [data-testid="thread-anchor"]`).first().click();
  await panel(page).waitFor({ timeout: 8000 });
  await threadInput(page).waitFor({ timeout: 8000 });
}

/** 그릇 둘의 **계산된** 값 — 클래스 이름이 아니라 엔진이 그리는 값으로 같은지 잰다. */
const FRAME_PROPS = [
  "borderTopLeftRadius", "borderTopRightRadius", "borderBottomLeftRadius", "borderBottomRightRadius",
  "borderTopWidth", "borderTopStyle", "borderTopColor", "boxShadow", "backgroundColor",
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
];
const SEND_PROPS = ["borderTopLeftRadius", "borderTopRightRadius", "backgroundColor", "color", "width", "height"];

const computed = (page, testId, props) =>
  page.evaluate(([id, names]) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (!el) return null;
    const style = getComputedStyle(el);
    return Object.fromEntries(names.map((name) => [name, style[name]]));
  }, [testId, props]);

/** 도구 줄의 단추 이름 목록(보내기의 「메시지/답글」만 같은 낱말로 맞춘다). DOM 에 있는 것을 센다 — 좁은 카드가 접는 단추도 같은 묶음이다. */
const toolLabels = (page, actionsId) =>
  page.evaluate((id) => {
    const row = document.querySelector(`[data-testid="${id}"]`);
    if (!row) return null;
    return Array.from(row.querySelectorAll("button")).map((b) => (b.getAttribute("aria-label") || "").replace(/^(메시지|답글) 보내기$/, "보내기"));
  }, actionsId);

/**
 * 막힌 입력창의 원인 문장은 어절에서 꺾는다 (#5294). 기기를 오프라인으로 두면 막힌 입력창 위에 원인 문장이 서고, 꺾이는 자리는 폭에 달려 문자열로는
 * 못 잰다 — 엔진이 **계산한** `word-break` 를 읽는다(`break-keep` 이 빠지면 `normal` 이다).
 */
async function expectBlockedLineKeepsWords(context, page, t, name, testId) {
  await context.setOffline(true);
  try {
    const line = page.locator(`[data-testid="${testId}"]`);
    const stood = await line.waitFor({ state: "attached", timeout: 8000 }).then(() => true, () => false);
    const wordBreak = stood ? await line.evaluate((el) => getComputedStyle(el).wordBreak) : "(원인 문장이 서지 않았다)";
    check(`${t} 막힌 ${name}: 원인 문장의 word-break 가 keep-all 이다`, wordBreak === "keep-all", wordBreak);
  } finally {
    await context.setOffline(false);
  }
}

async function runThread(browserType, origin, scheme, tag, width) {
  const server = makeServer();
  const { browser, context, page } = await open(browserType, origin, scheme, server, { width, height: 800 });
  const t = `${tag} ${width}`;
  try {
    // 본류: 옛 「대화에도 보낸」 답글은 본류에 서지 않고 한 줄 요약도 없다.
    check(`${t} 본류: 옛 「대화에도 보낸」 답글은 본류에 서지 않는다`, (await main(page).getByText(OLD_ALSO_TEXT).count()) === 0);
    check(`${t} 본류: 「↳ ○○님 스레드에 답글」 줄이 없다`, (await page.locator('[data-testid="reply-home"]').count()) === 0);
    // 스레드를 닫은 동안은 채널 입력창이 보인다: 그 원인 문장을 먼저 잰다.
    await expectBlockedLineKeepsWords(context, page, t, "채널 입력창", "composer-offline");
    await openRootThread(page);
    check(`${t} 스레드: 옛 답글은 스레드에 보인다`, (await panel(page).getByText(OLD_ALSO_TEXT).count()) >= 1);

    // 입력칸: 「대화에도 보내기」가 없다.
    check(`${t} 입력칸: 「대화에도 보내기」 체크가 없다`, (await page.locator('[data-testid="thread-composer-also-in-channel"]').count()) === 0);
    check(`${t} 입력칸: 「대화에도 보내기」 글이 패널에 없다`, (await panel(page).getByText("대화에도 보내기").count()) === 0);

    // 같은 카드: 계산된 값으로 맞대 본다.
    const channelFrame = await computed(page, "composer-frame", FRAME_PROPS);
    const threadFrame = await computed(page, "thread-composer-frame", FRAME_PROPS);
    const diff = FRAME_PROPS.filter((name) => channelFrame?.[name] !== threadFrame?.[name]).map((name) => `${name}: ${channelFrame?.[name]} != ${threadFrame?.[name]}`);
    check(`${t} 같은 카드: 스레드 입력창 그릇이 본 입력창 그릇과 계산된 값이 같다(테두리·둥글기·그림자·바탕·여백)`, channelFrame !== null && threadFrame !== null && diff.length === 0, diff.join(" | "));
    const channelTools = await toolLabels(page, "composer-actions");
    const threadTools = await toolLabels(page, "thread-composer-actions");
    check(`${t} 같은 카드: 도구 줄의 단추 묶음이 같다`, channelTools !== null && JSON.stringify(channelTools) === JSON.stringify(threadTools), `${JSON.stringify(channelTools)} != ${JSON.stringify(threadTools)}`);
    // 보내기 단추는 글이 있어야 켜진다 — 같은 상태(글 있음)로 맞대려고 스레드에 글을 쓴다.
    await threadInput(page).fill("저도 국밥 좋아요");
    const threadSend = await computed(page, "thread-composer-send", SEND_PROPS);
    const channelSendBox = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="composer-send"]');
      return el ? { radius: getComputedStyle(el).borderTopLeftRadius, size: [getComputedStyle(el).width, getComputedStyle(el).height] } : null;
    });
    check(
      `${t} 같은 카드: 보내기 단추의 크기·둥글기가 같다`,
      threadSend !== null && channelSendBox !== null && threadSend.borderTopLeftRadius === channelSendBox.radius && threadSend.width === channelSendBox.size[0] && threadSend.height === channelSendBox.size[1],
      `${JSON.stringify(threadSend)} vs ${JSON.stringify(channelSendBox)}`
    );
    if (width >= SHOT_MIN_WIDTH) {
      await shot(page, t, "01-thread-open");
      await cropShot(page.locator('[data-testid="thread-composer"]'), t, "02-thread-composer");
    }

    // 보내기: 요청에 `alsoInChannel` 키가 없고 `rootId` 는 간다.
    const before = server.posts.length;
    const response = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/messages"), { timeout: 8000 }).catch(() => null);
    await page.locator('[data-testid="thread-composer-send"]').click();
    const answer = await response;
    await page.waitForTimeout(400);
    const post = server.posts.length > before ? server.posts[server.posts.length - 1] : null;
    check(`${t} 보내기: 요청이 나갔다`, answer !== null && answer.status() === 200 && post !== null, String(answer?.status()));
    check(`${t} 보내기: 요청 본문에 alsoInChannel 키가 없다`, post !== null && !("alsoInChannel" in post.body), post?.raw);
    check(`${t} 보내기: 답글의 rootId 는 간다`, post?.body.rootId === ID.root, post?.raw);
    check(`${t} 보내기: 스레드에는 보인다`, (await panel(page).getByText("저도 국밥 좋아요").count()) >= 1);
    check(`${t} 보내기: 본류에는 서지 않는다`, (await main(page).getByText("저도 국밥 좋아요").count()) === 0);

    // 오프라인: 막힌 스레드 입력창의 원인 문장도 어절에서 꺾인다(#5294).
    await expectBlockedLineKeepsWords(context, page, t, "스레드 입력창", "thread-composer-offline");
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
          await runThread(engine, preview.origin, scheme, tag, width);
        }
      }
    }
  } finally {
    await preview.stop?.();
  }
  const bad = results.filter((r) => !r.ok);
  console.log(
    bad.length === 0
      ? `THREAD-REPLY-5324 PASS (${results.length} checks)`
      : `THREAD-REPLY-5324 FAIL (${bad.length}/${results.length}): ${bad.map((r) => r.name).join(" | ")}`
  );
  process.exit(bad.length === 0 ? 0 : 1);
}
mainRun().catch((e) => { console.error(e); process.exit(1); });
