#!/usr/bin/env node
// =============================================================================
// #4044 캡처: 웹 DM 머리는 얼굴 대신 아이콘 + 이름 한 줄(「에이전트」 둘째 줄 없음), 정상 상태의 입력창 위
// 「멘션 없이 바로 말하면 …가 답해요」는 없고 답하지 않는 상태의 문장만 남는다(폰 #4016과 같은 규칙).
//
// 라이트·다크 × 1440×900, 백엔드 없음(`/v1/**` 고정 응답, 가짜 소켓).
//   npm run build && node scripts/capture-4044.mjs      → captures/4044/*.png
// =============================================================================

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "captures/4044");
const PORT = Number(process.env.CAPTURE_PORT || 5244);
const MIN = 60_000;

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const agentId = "00000000-0000-7000-8000-000000000301";
const GENERAL = "00000000-0000-7000-8000-000000000202";
const DM = "00000000-0000-7000-8000-000000000401";

const person = (id, kind, displayName, handle, extra = {}) => ({
  id, workspaceId, kind, status: "active", displayName, handle, channelCount: 2,
  channelIds: [GENERAL, DM], capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...extra,
});
const roster = [
  person(memberId, "human", "곽성재", "seongjae", { role: "owner" }),
  person(agentId, "agent", "그록", "grok", { ownerHumanId: memberId }),
];
const channels = [
  { id: GENERAL, workspaceId, kind: "public", name: "general", muted: false },
  { id: DM, workspaceId, kind: "dm", muted: false, memberIds: [memberId, agentId] },
];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: "ws://4044-capture.invalid/connection/websocket",
};

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function installRoutes(context, scene) {
  const now = Date.now();
  const row = (n, author, body, ago) => ({
    id: `00000000-0000-7000-8000-0000000b000${n}`, channelId: DM, seq: 10 + n, hlcTs: now - ago, hlcCount: 0,
    authorMemberId: author, type: "text", body, state: "sent", createdAtMs: now - ago,
  });
  const messageRows = [
    row(1, memberId, "그록, 이번 주 일정 정리해 줘", 9 * MIN),
    row(2, agentId, "네, 정리해서 올릴게요. 월요일은 회의 두 건이 있어요.", 8 * MIN),
  ];
  await context.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId });
    }
    if (path.endsWith("/agent-dm-delivery")) {
      scene.deliveryCalls += 1;
      return json(route, { agentMemberId: agentId, ownerMemberId: memberId, state: scene.state });
    }
    if (/\/inbox(\/|$)/.test(path)) return json(route, { error: { code: "not_found", message: "not found" } }, 404);
    if (path.endsWith("/agent-runs/progress")) return json(route, { runs: [] });
    if (path.match(/\/agents\/([^/]+)\/liveness$/)) {
      return json(route, { agentMemberId: agentId, ...scene.liveness });
    }
    if (path.endsWith("/hosted-agent-connections") && method === "GET") return json(route, { connections: [] });
    if (path.endsWith("/allowed-models")) return json(route, { allowedAgentModels: [] });
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/read-state") && method === "GET") {
      return json(route, { read_states: channels.map((c) => ({ channel_id: c.id, last_read_seq: 99, latest_seq: 99, unread_count: 0, mention_count: 0, marked_unread_before_seq: null })) });
    }
    if (path.endsWith("/approvals")) return json(route, { approvals: [] });
    if (path.endsWith("/agent-runs")) return json(route, { runs: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: [] });
    if (path.endsWith("/work-sessions/shared")) return json(route, { sessions: [], nextCursor: null });
    if (path.endsWith("/work-sessions")) return json(route, { workSessions: [] });
    if (path.endsWith("/reminders")) return json(route, { reminders: [] });
    if (path.endsWith(`/workspaces/${workspaceId}`)) return json(route, { workspace: { id: workspaceId, name: "여명거리" } });
    if (path.includes(`/channels/${DM}/messages`)) return json(route, { messages: messageRows });
    if (path.includes("/messages")) return json(route, { messages: [] });
    return json(route, {});
  });
}

async function installRealtime(page) {
  await page.addInitScript(() => {
    class CaptureSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      constructor(url) {
        this.url = String(url);
        this.readyState = 0;
        window.__socket = this;
        window.__offset = 0;
        queueMicrotask(() => { this.readyState = 1; this.onopen?.(new Event("open")); });
      }
      send(data) {
        const replies = String(data).trim().split("\n").map((line) => {
          const c = JSON.parse(line);
          if (c.connect) return { id: c.id, connect: { client: "4044-capture", version: "6" } };
          if (c.subscribe) return { id: c.id, subscribe: { recoverable: true, positioned: true, recovered: false, epoch: "cap", offset: 0 } };
          return { id: c.id };
        });
        queueMicrotask(() => this.onmessage?.(new MessageEvent("message", { data: replies.map((r) => JSON.stringify(r)).join("\n") })));
      }
      close() { this.readyState = 3; this.onclose?.(new CloseEvent("close", { code: 1000 })); }
    }
    window.WebSocket = CaptureSocket;
    /** 서버가 채널 토픽에 프레임을 낸 것처럼 밀어 넣는다. */
    window.__push = (channel, data) => {
      window.__offset += 1;
      const frame = JSON.stringify({ push: { channel, pub: { data, offset: window.__offset } } });
      window.__socket.onmessage?.(new MessageEvent("message", { data: frame }));
    };
  });
}

const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok) failures.push(name);
}

async function open(browser, origin, scheme, scene, hash, reduced = true) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 }, colorScheme: scheme, reducedMotion: reduced ? "reduce" : "no-preference", serviceWorkers: "block",
  });
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


async function scene(browser, origin, scheme, state, name) {
  const tag = `1440-${scheme}`;
  const shot = (n) => resolve(OUT_DIR, `${n}-${tag}.png`);
  const sc = { state, deliveryCalls: 0, liveness: LIVENESS };
  const { context, page } = await open(browser, origin, scheme, sc, `/c/${DM}`);
  await page.getByText("이번 주 일정 정리해 줘").first().waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => true);
  await page.waitForTimeout(800);
  check(`${tag} ${name}: 전달 상태를 물었다`, sc.deliveryCalls >= 1, String(sc.deliveryCalls));
  const header = page.getByTestId("channel-header");
  const head = ((await header.textContent()) ?? "").replace(/\s+/g, " ");
  check(`${tag} ${name}: 머리에 이름 「그록」 한 줄`, head.includes("그록"), head);
  check(`${tag} ${name}: 머리에 「에이전트」 둘째 줄이 없다`, !/(^|\s)에이전트(\s|$)/.test(head), head);
  const box = await header.boundingBox();
  check(`${tag} ${name}: 머리 높이 한 줄(<=64)`, box !== null && box.height <= 64, JSON.stringify(box));
  const hint = page.getByTestId("composer-dm-hint");
  const hintCount = await hint.count();
  if (state === "open") {
    check(`${tag} ${name}: 정상 상태에는 입력창 위 안내가 없다`, hintCount === 0, String(hintCount));
    check(`${tag} ${name}: 「멘션 없이 바로 말하면」가 화면에 없다`, !((await page.locator("body").textContent()) ?? "").includes("멘션 없이 바로 말하면"));
  } else {
    const text = hintCount === 1 ? ((await hint.textContent()) ?? "").replace(/\s+/g, " ") : "";
    check(`${tag} ${name}: 답하지 않는 상태의 문장은 남는다`, text.includes("답하지 않아요"), text);
  }
  await page.screenshot({ path: shot(name) });
  await context.close();
}

const LIVENESS = { state: "responsive", lastSignalAtMs: Date.now() - 30_000 };

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) throw new Error("dist/ is missing. Run npm run build first.");
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  try {
    for (const scheme of ["light", "dark"]) {
      await scene(browser, preview.origin, scheme, "open", "1-open");
      await scene(browser, preview.origin, scheme, "connection_unavailable", "2-connection-unavailable");
    }
  } finally {
    await browser.close();
    await preview.stop?.();
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length}개 단언 실패`);
    process.exit(1);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
