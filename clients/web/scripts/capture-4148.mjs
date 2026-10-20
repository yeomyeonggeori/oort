#!/usr/bin/env node
// =============================================================================
// 사이드바 DM 기본 아바타 실측 + 캡처 (#4148).
// 성재(2026-10-20): 「원형 구분같은게 전혀없으니까 기본 프로필은 구분이 잘 안돼.」
//   npm run build && MODE=before node scripts/capture-4148.mjs   (변경 전 번들: 캡처만, 검사 결과는 기록)
//   npm run build && MODE=after  node scripts/capture-4148.mjs
// 재는 것(계산값): 사진 없는 모든 아바타에 1px 테두리, 사람 채움이 사이드바 바탕과 다르고 서로 3색 이상 갈린다,
// 같은 id 는 새로 열어도 같은 색, 나간 멤버는 점선 테두리 원, 사진 아바타도 같은 테두리, 에이전트는 둥근 사각.
// =============================================================================
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/dm-avatar-4148");
const MODE = process.env.MODE || "after";
const PORT = Number(process.env.CAPTURE_PORT || 5348);
const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const chId = (n) => `00000000-0000-7000-8000-0000000002${String(n).padStart(2, "0")}`;
const dmId = (n) => `00000000-0000-7000-8000-0000000003${String(n).padStart(2, "0")}`;
const P = (n) => `00000000-0000-7000-8000-0000000001${n}`;
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const channels = ["general", "workbench"].map((name, i) => ({ id: chId(i + 1), workspaceId, kind: "public", name, muted: false }));
const person = (n, displayName, handle, extra = {}) => ({ id: P(n), workspaceId, kind: "human", status: "active", displayName, handle, channelCount: 1, channelIds: [], capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...extra });
const agent = (n, displayName, handle, extra = {}) => person(n, displayName, handle, { kind: "agent", ownerHumanId: P("01"), ...extra });
// 밝은 사진(거의 흰 바탕): 테두리가 없으면 사이드바 바탕에 녹는다.
const BRIGHT = "data:image/svg+xml;utf8," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='48' height='48'><rect width='48' height='48' fill='#fbfaf8'/><circle cx='24' cy='20' r='9' fill='#f3efe9'/></svg>");
const ROWS = [
  { n: 1, peer: person("11", "이도현", "dohyun") },
  { n: 2, peer: person("12", "박서연", "seoyeon", { avatarUrl: BRIGHT }) },
  { n: 3, peer: person("13", "최민수", "minsu") },
  { n: 4, peer: person("15", "정하윤", "hayun") },
  { n: 5, peer: person("16", "한지우", "jiwoo") },
  { n: 6, peer: person("17", "오세린", "serin") },
  { n: 7, peer: person("18", "윤태경", "taekyung") },
  { n: 8, peer: agent("14", "김인턴", "intern", { hostOnline: true }) },
];
const GHOST_N = ROWS.length + 1;
const roster = [person("01", "곽성재", "seongjae", { role: "owner", presenceStatus: "auto" }), ...ROWS.map((r) => r.peer)];
const dm = (n, other) => ({ id: dmId(n), workspaceId, kind: "dm", muted: false, memberIds: [P("01"), other] });
const dms = [...ROWS.map((r) => dm(r.n, r.peer.id)), dm(GHOST_N, P("99"))];
const READ = Object.fromEntries([...channels.map((c) => [c.id, [3, 3]]), ...dms.map((d) => [d.id, [2, 2]])]);
const results = [];
function check(scheme, name, ok, detail) { results.push({ scheme, name, ok: Boolean(ok), detail }); console.log(JSON.stringify({ scheme, check: name, ok: Boolean(ok), detail })); }

async function installMocks(context) {
  const auth = {
    accessToken: "capture-only-not-a-credential", refreshToken: "capture-only-not-a-credential",
    member: { id: memberId, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
    realtimeWebSocketUrl: "ws://dm-avatar-4148-capture.invalid/connection/websocket",
  };
  const liveness = new Map();
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
      return json(route, { members: roster.map((m) => (m.id === P("01") ? { ...m, role: "owner" } : m)) });
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

async function open(browserType, origin, scheme, viewport = { width: 1440, height: 900 }) {
  const browser = await browserType.launch();
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


const rowOf = (page, id) => page.locator(`[data-testid="channel-item"][data-channel-id="${id}"]`);
const readAvatar = (page, n) => rowOf(page, dmId(n)).evaluate((a) => {
  const el = a.querySelector('[data-testid="dm-avatar"]');
  const box = el.firstElementChild;
  const cs = getComputedStyle(box);
  return { kind: el.getAttribute("data-avatar-kind"), bg: cs.backgroundColor, color: cs.color, bw: cs.borderTopWidth, bs: cs.borderTopStyle, bc: cs.borderTopColor, radius: cs.borderTopLeftRadius, w: box.getBoundingClientRect().width, hasImg: box.querySelector("img") !== null, text: box.textContent };
});

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  try {
    for (const scheme of ["light", "dark"]) {
      const { browser, context, page } = await open(chromium, preview.origin, scheme);
      try {
        await page.waitForTimeout(900);
        const sheet = await page.evaluate(() => { const i = document.createElement("i"); i.style.color = "var(--sheet)"; document.body.append(i); const v = getComputedStyle(i).color; i.remove(); return v; });
        const rows = {};
        for (const r of ROWS) rows[r.n] = await readAvatar(page, r.n);
        rows[GHOST_N] = await readAvatar(page, GHOST_N);
        const humans = [1, 3, 4, 5, 6, 7].map((n) => rows[n]);
        check(scheme, "1 사진 없는 사람/에이전트/나간 멤버 모두 1px 테두리", [...humans, rows[8], rows[GHOST_N]].every((x) => x.bw === "1px" && x.bs !== "none"), humans.map((x) => x.bw));
        check(scheme, "2 사람 채움이 사이드바 바탕과 다르다", humans.every((x) => x.bg !== sheet), { sheet, bgs: humans.map((x) => x.bg) });
        check(scheme, "3 사람 채움이 3색 이상으로 갈린다(id 기반)", new Set(humans.map((x) => x.bg)).size >= 3, humans.map((x) => x.bg));
        check(scheme, "4 사람은 원, 에이전트는 둥근 사각", humans.every((x) => parseFloat(x.radius) >= 12) && parseFloat(rows[8].radius) < 12, { human: humans[0].radius, agent: rows[8].radius });
        check(scheme, "5 나간 멤버: 점선 테두리 + 이니셜 없음", rows[GHOST_N].bs === "dashed" && rows[GHOST_N].text === "" && rows[GHOST_N].kind === "unknown", rows[GHOST_N]);
        check(scheme, "6 사진 아바타도 같은 1px 테두리 원", rows[2].hasImg && rows[2].bw === "1px" && parseFloat(rows[2].radius) >= 12, rows[2]);
        check(scheme, "7 크기는 24px 그대로", [...humans, rows[8], rows[2], rows[GHOST_N]].every((x) => Math.round(x.w) === 24), null);
        const again = await open(chromium, preview.origin, scheme);
        try { await again.page.waitForTimeout(900); const r1 = await readAvatar(again.page, 1); check(scheme, "8 새로 열어도 같은 id 는 같은 색", r1.bg === rows[1].bg, [r1.bg, rows[1].bg]); } finally { await again.context.close(); await again.browser.close(); }
        const box = await page.locator('[data-testid="sidebar-section-dms"]').boundingBox();
        if (box) {
          const clip = { x: Math.max(0, box.x - 8), y: box.y - 4, width: Math.min(box.width + 16, 360), height: box.height + 8 };
          await page.screenshot({ path: resolve(OUT_DIR, `${MODE}-dm-${scheme}.png`), clip });
          await page.screenshot({ path: resolve(OUT_DIR, `${MODE}-dm-${scheme}@3x.png`), clip, scale: "device" });
        }
        await page.screenshot({ path: resolve(OUT_DIR, `${MODE}-full-${scheme}.png`) });
      } finally { await context.close(); await browser.close(); }
    }
  } finally { await preview.stop?.(); }
  const bad = results.filter((r) => !r.ok);
  writeFileSync(resolve(OUT_DIR, `${MODE}-results.json`), JSON.stringify(results, null, 1));
  console.log(bad.length === 0 ? `DM-AVATAR-4148 ${MODE} PASS (${results.length})` : `DM-AVATAR-4148 ${MODE} FAIL (${bad.length}/${results.length}): ${bad.map((r) => `${r.scheme}/${r.name}`).join(" | ")}`);
  process.exit(MODE === "before" ? 0 : bad.length === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
