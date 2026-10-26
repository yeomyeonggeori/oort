#!/usr/bin/env node
// =============================================================================
// 아바타 문법 나머지 표면 실측 + 캡처 (#4162, #4148 후속).
//   npm run build && MODE=before node scripts/capture-4162.mjs   (변경 전 번들: 캡처, 검사 결과는 기록만)
//   npm run build && MODE=after  node scripts/capture-4162.mjs
// 재는 것(계산값): 타임라인 32px 아바타(사진 없음 색조·거의 흰 사진 테두리·에이전트), 사이드바 하단 내 아바타,
// 「답하는 중」 얼굴, 설정 프로필 히어로. 백엔드 없이 `/v1/**` 고정 응답 + 가짜 소켓.
// =============================================================================
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = process.env.WEB_ROOT ? resolve(process.env.WEB_ROOT) : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/avatar-4162");
const MODE = process.env.MODE || "after";
const PORT = Number(process.env.CAPTURE_PORT || 5362);
const MIN = 60_000;
const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const agentId = "00000000-0000-7000-8000-000000000301";
const CH = "00000000-0000-7000-8000-000000000201";
const GENERAL = "00000000-0000-7000-8000-000000000202";
const RUN_C = "0199aa11-2222-7000-8000-0000000000a3";
const P = (n) => `00000000-0000-7000-8000-0000000001${n}`;
const svg = (bg, fg) => "data:image/svg+xml;utf8," + encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='48' height='48'><rect width='48' height='48' fill='${bg}'/><circle cx='24' cy='20' r='9' fill='${fg}'/></svg>`);
const BRIGHT = svg("#fdfcfa", "#f6f2ec");
const DARKPHOTO = svg("#15181d", "#20242b");
const person = (id, kind, displayName, handle, extra = {}) => ({ id, workspaceId, kind, status: "active", displayName, handle, channelCount: 2, channelIds: [CH, GENERAL], capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...extra });
const roster = [
  person(memberId, "human", "곽성재", "seongjae", { role: "owner" }),
  person(P("11"), "human", "이도현", "dohyun"),
  person(P("12"), "human", "박서연", "seoyeon", { avatarUrl: BRIGHT }),
  person(P("13"), "human", "최민수", "minsu"),
  person(P("15"), "human", "정하윤", "hayun", { avatarUrl: DARKPHOTO }),
  person(P("16"), "human", "한지우", "jiwoo"),
  person(agentId, "agent", "그록", "grok", { ownerHumanId: memberId }),
];
const channels = [
  { id: CH, workspaceId, kind: "public", name: "계획", muted: false },
  { id: GENERAL, workspaceId, kind: "public", name: "general", muted: false },
];
const auth = {
  accessToken: "capture-only-not-a-credential", refreshToken: "capture-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: "ws://avatar-4162-capture.invalid/connection/websocket",
};
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const results = [];
function check(scheme, name, ok, detail) { results.push({ scheme, name, ok: Boolean(ok), detail }); console.log(JSON.stringify({ scheme, check: name, ok: Boolean(ok), detail })); }

function messageRows(now) {
  const m = (n, author, body, ago) => ({ id: `00000000-0000-7000-8000-0000000a00${String(n).padStart(2, "0")}`, channelId: CH, seq: 10 + n, hlcTs: now - ago, hlcCount: 0, authorMemberId: author, type: "text", body, state: "sent", createdAtMs: now - ago });
  return [
    m(1, P("11"), "주간 회의 자료 올렸어요.", 30 * MIN),
    m(2, P("12"), "확인했어요. 3쪽 숫자만 다시 볼게요.", 28 * MIN),
    m(3, P("13"), "저는 일정 쪽을 맡을게요.", 25 * MIN),
    m(4, P("15"), "디자인 시안은 내일 오전에 공유해요.", 20 * MIN),
    m(5, P("16"), "좋아요, 그럼 오후에 같이 봐요.", 15 * MIN),
    m(6, agentId, "요약해 둘게요. 필요한 일 있으면 말씀해 주세요.", 10 * MIN),
    m(7, memberId, "이번 주 일정 정리해 줘", 20_000),
  ];
}

async function installRoutes(context, scene) {
  const now = Date.now();
  await context.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId });
    if (/\/inbox(\/|$)/.test(path)) return json(route, { error: { code: "not_found", message: "not found" } }, 404);
    if (path.endsWith("/agent-runs/progress")) {
      const channel = path.split("/channels/")[1]?.split("/")[0];
      return json(route, { runs: scene.runs.filter((r) => r.channelId === channel) });
    }
    const live = path.match(/\/agents\/([^/]+)\/liveness$/);
    if (live) return json(route, { error: { code: "not_found", message: "not found" } }, 404);
    if (path.endsWith("/hosted-agent-connections") && method === "GET") return json(route, { connections: [] });
    if (path.endsWith("/allowed-models")) return json(route, { allowedAgentModels: [] });
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/read-state") && method === "GET") return json(route, { read_states: channels.map((c) => ({ channel_id: c.id, last_read_seq: 99, latest_seq: 99, unread_count: 0, mention_count: 0, marked_unread_before_seq: null })) });
    if (path.endsWith("/approvals")) return json(route, { approvals: [] });
    if (path.endsWith("/agent-runs")) return json(route, { runs: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/members/me/sidebar-prefs")) return json(route, { prefs: { version: 1, sections: [], starredChannelIds: [] } });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: [] });
    if (path.endsWith("/work-sessions/shared")) return json(route, { sessions: [], nextCursor: null });
    if (path.endsWith("/work-sessions")) return json(route, { workSessions: [] });
    if (path.endsWith("/reminders")) return json(route, { reminders: [] });
    if (path.endsWith(`/workspaces/${workspaceId}`)) return json(route, { workspace: { id: workspaceId, name: "여명거리" } });
    if (path.includes(`/channels/${CH}/messages`)) return json(route, { messages: messageRows(now) });
    if (path.includes("/messages")) return json(route, { messages: [] });
    return json(route, {});
  });
}

async function installRealtime(page) {
  await page.addInitScript(() => {
    class CaptureSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      constructor(url) { this.url = String(url); this.readyState = 0; window.__socket = this; window.__offset = 0; queueMicrotask(() => { this.readyState = 1; this.onopen?.(new Event("open")); }); }
      send(data) {
        const replies = String(data).trim().split("\n").map((line) => {
          const c = JSON.parse(line);
          if (c.connect) return { id: c.id, connect: { client: "4162-capture", version: "6" } };
          if (c.subscribe) return { id: c.id, subscribe: { recoverable: true, positioned: true, recovered: false, epoch: "cap", offset: 0 } };
          return { id: c.id };
        });
        queueMicrotask(() => this.onmessage?.(new MessageEvent("message", { data: replies.map((r) => JSON.stringify(r)).join("\n") })));
      }
      close() { this.readyState = 3; this.onclose?.(new CloseEvent("close", { code: 1000 })); }
    }
    window.WebSocket = CaptureSocket;
    window.__push = (channel, data) => { window.__offset += 1; window.__socket.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ push: { channel, pub: { data, offset: window.__offset } } }) })); };
  });
}

async function open(browser, origin, scheme, scene, hash) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme, reducedMotion: "reduce", serviceWorkers: "block", deviceScaleFactor: 2 });
  await installRoutes(context, scene);
  const page = await context.newPage();
  await installRealtime(page);
  await page.addInitScript((server) => { try { localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ } }, origin);
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("profile-card").waitFor({ timeout: 20_000 });
  await page.evaluate((h) => { location.hash = h; }, hash);
  return { context, page };
}

const css = (el) => el.evaluate((n) => { const c = getComputedStyle(n); return { bg: c.backgroundColor, bgImage: c.backgroundImage, color: c.color, bw: c.borderTopWidth, bs: c.borderTopStyle, bc: c.borderTopColor, radius: c.borderTopLeftRadius, w: n.getBoundingClientRect().width }; });
const tokenColor = (page, v) => page.evaluate((name) => { const i = document.createElement("i"); i.style.color = `var(${name})`; document.body.append(i); const c = getComputedStyle(i).color; i.remove(); return c; }, v);
const shot = (scheme, name) => resolve(OUT_DIR, `${MODE}-${name}-${scheme}.png`);

async function scene(browser, origin, scheme) {
  const sc = { runs: [] };
  const now = Date.now();
  const { context, page } = await open(browser, origin, scheme, sc, `/c/${CH}`);
  try {
    await page.getByText("이번 주 일정 정리해 줘").first().waitFor({ timeout: 15_000 });
    await page.waitForTimeout(700);
    const line = await tokenColor(page, "--line");
    const edge = MODE === "after" ? await tokenColor(page, "--avatar-edge") : null;
    const surface = await tokenColor(page, "--surface");
    // 1. 타임라인 32px
    const avatars = page.locator('[data-testid="message-avatar"], [data-avatar-kind]');
    const tl = await page.evaluate(() => [...document.querySelectorAll("main [data-avatar-kind]")].map((el) => {
      const c = getComputedStyle(el); return { kind: el.getAttribute("data-avatar-kind"), hasImg: el.querySelector("img") !== null, bg: c.backgroundColor, bw: c.borderTopWidth, bc: c.borderTopColor, w: el.getBoundingClientRect().width, text: el.textContent };
    }));
    void avatars;
    const photos = tl.filter((a) => a.hasImg);
    const humansNoPhoto = tl.filter((a) => a.kind === "human" && !a.hasImg);
    check(scheme, "1 타임라인 32px 아바타가 실제로 그려진다", tl.length >= 6 && tl.every((a) => Math.round(a.w) === 32), tl.map((a) => a.w));
    check(scheme, "2 사진 없는 사람은 id 색조 채움(2색 이상, 바탕 아님)", new Set(humansNoPhoto.map((a) => a.bg)).size >= 2 && humansNoPhoto.every((a) => a.bg !== surface), humansNoPhoto.map((a) => a.bg));
    check(scheme, "3 사진 아바타 테두리가 --line 보다 짙다(--avatar-edge)", photos.length === 2 && photos.every((a) => a.bw === "1px" && a.bc !== line), { line, edge, photos: photos.map((a) => a.bc) });
    // 2. 사이드바 하단 내 아바타
    const me = await css(page.getByTestId("presence-control"));
    check(scheme, "4 사이드바 하단 내 아바타: 1px 테두리 + 색조 채움(옛 흰 면 아님)", me.bw === "1px" && me.bg !== surface, me);
    const card = page.getByTestId("profile-card");
    const box = await card.boundingBox();
    if (box) await page.screenshot({ path: shot(scheme, "sidebar-me"), clip: { x: Math.max(0, box.x - 8), y: box.y - 4, width: Math.min(box.width + 16, 300), height: box.height + 8 }, scale: "device" });
    // 3. 답하는 중 줄
    sc.runs = [{ id: RUN_C, channelId: CH, agentMemberId: agentId, triggerMessageId: "00000000-0000-7000-8000-0000000a0007", status: "running", phase: "running", leaseState: "live", stepCount: 0, createdAtMs: now - 20_000, updatedAtMs: now - 3_000, claimedAtMs: now - 15_000, startedAtMs: now - 14_000, lastEventAtMs: now - 3_000 }];
    await page.waitForFunction(() => window.__socket !== undefined, null, { timeout: 15_000 });
    await page.evaluate(([channel, runId]) => window.__push(channel, { type: "agent.run.event", v: 1, ts: Date.now(), payload: { run_id: runId, channel_id: channel.split(".")[1].toLowerCase(), kind: "stage" } }),
      [`ch:ws${workspaceId.toUpperCase()}.${CH.toUpperCase()}`, RUN_C]);
    // #4619: `composer-working`은 예약된 칸이다(줄이 없어도 선다). 줄이 섰는지는 줄의 글이 말한다.
    await page.getByTestId("composer-working-text").waitFor({ timeout: 10_000 });
    await page.waitForTimeout(400);
    const rv = await css(page.getByTestId("responding-avatar"));
    check(scheme, "5 「답하는 중」 얼굴: 1px 테두리", rv.bw === "1px", rv);
    const wbox = await page.getByTestId("composer-working").boundingBox();
    if (wbox) await page.screenshot({ path: shot(scheme, "responding"), clip: { x: Math.max(0, wbox.x - 8), y: wbox.y - 4, width: Math.min(wbox.width + 16, 420), height: wbox.height + 8 }, scale: "device" });
    // 타임라인 클립
    const main = await page.locator("main").first().boundingBox();
    if (main) await page.screenshot({ path: shot(scheme, "timeline"), clip: { x: main.x, y: main.y, width: Math.min(main.width, 760), height: Math.min(main.height, 900) } });
    // 4. 설정 프로필 히어로
    await page.evaluate(() => { location.hash = "/settings"; });
    await page.getByTestId("profile-hero").waitFor({ timeout: 10_000 });
    await page.waitForTimeout(400);
    const hero = await css(page.getByTestId("profile-avatar"));
    check(scheme, "6 설정 히어로 아바타: 그라데이션 아님 + 색조 채움", hero.bgImage === "none" && hero.bg !== surface, hero);
    const hb = await page.getByTestId("profile-hero").boundingBox();
    if (hb) await page.screenshot({ path: shot(scheme, "hero"), clip: { x: hb.x, y: hb.y, width: Math.min(hb.width, 700), height: hb.height }, scale: "device" });
    await page.screenshot({ path: shot(scheme, "full") });
  } finally { await context.close(); }
}

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) throw new Error("dist/ is missing. Run npm run build first.");
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  try { for (const scheme of ["light", "dark"]) await scene(browser, preview.origin, scheme); }
  finally { await browser.close(); await preview.stop?.(); }
  const bad = results.filter((r) => !r.ok);
  writeFileSync(resolve(OUT_DIR, `${MODE}-results.json`), JSON.stringify(results, null, 1));
  console.log(bad.length === 0 ? `AVATAR-4162 ${MODE} PASS (${results.length})` : `AVATAR-4162 ${MODE} FAIL (${bad.length}/${results.length}): ${bad.map((r) => `${r.scheme}/${r.name}`).join(" | ")}`);
  process.exit(MODE === "before" ? 0 : bad.length === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
