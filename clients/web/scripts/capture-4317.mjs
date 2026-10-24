#!/usr/bin/env node
// =============================================================================
// #4317 캡처: 웹·데스크탑 입력창 — 글 칸 위·도구 줄 아래(+ · 멘션 · 이모지 · 서식 / 보내기), 카드 안 맥락 띠
// (인용 칩, 에이전트 DM 의 「일하는 곳 · 연결 안 됨」 칩은 연결 안 됨일 때만).
//
// 라이트·다크 x 1440·1280·900·600, 데스크탑 유리 배경(#4190, 네이티브 호출은 가짜: 진짜 블러 없음 — runtime-unverified).
// 백엔드 없음(`/v1/**` 고정 응답, 가짜 소켓). 단언이 하나라도 실패하면 종료 코드 1.
//   npm run build && node scripts/capture-4317.mjs      → captures/4317/*.png
// =============================================================================

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "captures/4317");
const PORT = Number(process.env.CAPTURE_PORT || 5417);
const MIN = 60_000;

const workspaceId = "00000000-0000-7000-8000-000000000001";
const me = "00000000-0000-7000-8000-000000000101";
const agentId = "00000000-0000-7000-8000-000000000102";
const peer = "00000000-0000-7000-8000-000000000103";
const GENERAL = "00000000-0000-7000-8000-000000000202";
const DM = "00000000-0000-7000-8000-000000000401";

const person = (id, kind, displayName, handle, extra = {}) => ({
  id, workspaceId, kind, status: "active", role: "member", displayName, handle, channelCount: 2,
  channelIds: [GENERAL, DM], capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...extra,
});
const roster = [
  person(me, "human", "박서연", "seoyeon", { role: "owner" }),
  person(peer, "human", "이도현", "dohyun"),
  person(agentId, "agent", "김인턴", "kim-intern", { ownerHumanId: me, hostOnline: false }),
];
const channels = [
  { id: GENERAL, workspaceId, kind: "public", name: "일반", muted: false },
  { id: DM, workspaceId, kind: "dm", muted: false, memberIds: [me, agentId] },
];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: me, workspaceId, kind: "human", displayName: "박서연", handle: "seoyeon" },
  realtimeWebSocketUrl: "ws://capture-4317.invalid/connection/websocket",
};

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function installRoutes(context) {
  const now = Date.now();
  const row = (id, channelId, seq, author, body, ago, extra = {}) => ({
    id: `00000000-0000-7000-8000-0000000b${id}`, channelId, seq, hlcTs: now - ago, hlcCount: 0,
    authorMemberId: author, type: "text", body, state: "sent", createdAtMs: now - ago, ...extra,
  });
  const general = [
    row("0001", GENERAL, 1, peer, "내일 배포 전에 체크리스트 한 번만 같이 봐 주세요.", 30 * MIN),
    row("0002", GENERAL, 2, me, "확인했어요. 롤백 계획은 문서에 있어요.", 20 * MIN),
    row("0003", GENERAL, 3, peer, "금요일 배포 공지 초안이에요. 이대로 올려도 될까요?", 10 * MIN, {
      thread: { reply_count: 1, last_reply_seq: 5, last_reply_at: now - 5 * MIN },
    }),
  ];
  const dm = [row("0011", DM, 11, me, "이번 주 일정 정리해 줘", 9 * MIN), row("0012", DM, 12, agentId, "네, 정리해서 올릴게요.", 8 * MIN)];
  await context.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId: me });
    }
    if (path.endsWith("/agent-dm-delivery")) return json(route, { agentMemberId: agentId, ownerMemberId: me, state: "open" });
    if (path.match(/\/agents\/([^/]+)\/liveness$/)) return json(route, { agentMemberId: agentId, state: "responsive", lastSignalAtMs: now - 30_000 });
    if (/\/inbox(\/|$)/.test(path)) return json(route, { items: [], nextCursor: null, unreadCount: 0, approvalsPending: 0 });
    if (path.endsWith("/agent-runs/progress")) return json(route, { runs: [] });
    if (path.endsWith("/hosted-agent-connections") && method === "GET") return json(route, { connections: [] });
    if (path.endsWith("/allowed-models")) return json(route, { allowedAgentModels: [] });
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/read-state") && method === "GET") {
      return json(route, { read_states: channels.map((c) => ({ channel_id: c.id, last_read_seq: 99, latest_seq: 99, unread_count: 0, mention_count: 0, marked_unread_before_seq: null })) });
    }
    if (path.endsWith("/approvals")) return json(route, { approvals: [] });
    if (path.endsWith("/agent-runs")) return json(route, { runs: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null, participants: [] });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: [] });
    if (path.endsWith("/work-sessions/shared")) return json(route, { sessions: [], nextCursor: null });
    if (path.endsWith("/work-sessions")) return json(route, { workSessions: [] });
    if (path.endsWith("/reminders")) return json(route, { reminders: [] });
    if (path.endsWith("/scheduled-messages")) return json(route, { scheduledMessages: [] });
    if (path.endsWith("/presence")) return json(route, { statuses: [] });
    if (path.endsWith("/webhooks")) return json(route, { installations: [] });
    if (path.endsWith("/event-subscriptions")) return json(route, { eventSubscriptions: [] });
    if (path.endsWith(`/workspaces/${workspaceId}`)) {
      return json(route, { workspace: { id: workspaceId, name: "달무리 스튜디오", slug: "team", updatedAtMs: 1, roleLabels: {}, welcomeAgentMemberId: null, welcomePrompt: "", subscriptionAgentsEnabled: true } });
    }
    if (path.includes(`/channels/${DM}/messages`)) return json(route, { messages: dm });
    if (path.includes(`/channels/${GENERAL}/messages`)) return json(route, { messages: general });
    if (path.includes("/messages")) return json(route, { messages: [] });
    return json(route, {});
  });
}

async function installPage(page) {
  await page.addInitScript(() => {
    class CaptureSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      constructor(url) {
        this.url = String(url); this.readyState = 0;
        queueMicrotask(() => { this.readyState = 1; this.onopen?.(new Event("open")); });
      }
      send(data) {
        const replies = String(data).trim().split("\n").map((line) => {
          const c = JSON.parse(line);
          if (c.connect) return { id: c.id, connect: { client: "4317-capture", version: "6" } };
          if (c.subscribe) return { id: c.id, subscribe: { recoverable: true, positioned: true, recovered: false, epoch: "cap", offset: 0 } };
          return { id: c.id };
        });
        queueMicrotask(() => this.onmessage?.(new MessageEvent("message", { data: replies.map((r) => JSON.stringify(r)).join("\n") })));
      }
      close() { this.readyState = 3; this.onclose?.(new CloseEvent("close", { code: 1000 })); }
    }
    window.WebSocket = CaptureSocket;
    // 맥 데스크탑 셸(유리 배경 #4190): 네이티브 호출은 가짜가 받는다.
    let n = 0;
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
      transformCallback: () => ++n, unregisterCallback: () => {}, convertFileSrc: (p) => p,
      invoke: async (cmd) => (cmd === "keychain_available" ? false : cmd === "plugin:event|listen" ? ++n : null),
    };
    Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
  });
}

const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok) failures.push(name);
}

async function open(browser, origin, scheme, width, hash) {
  const context = await browser.newContext({
    viewport: { width, height: 900 }, colorScheme: scheme, reducedMotion: "reduce", serviceWorkers: "block",
    deviceScaleFactor: 2, locale: "ko-KR", timezoneId: "Asia/Seoul",
  });
  await installRoutes(context);
  const page = await context.newPage();
  await installPage(page);
  await page.addInitScript(
    ({ server, session, record }) => {
      try {
        localStorage.setItem("momo.web.server.v1", server);
        localStorage.setItem("momo.web.session.v1", JSON.stringify(session));
        localStorage.setItem("momo.web.appearance.v2", JSON.stringify(record));
      } catch { /* 저장소 없는 캡처 */ }
    },
    {
      server: origin,
      session: { refreshToken: auth.refreshToken, realtimeWebSocketUrl: auth.realtimeWebSocketUrl, member: auth.member },
      record: { v: 2, scheme: "system", theme: "dawnsky", signal: null, density: "comfortable", glass: { on: true } },
    }
  );
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.getByTestId("profile-card").waitFor({ timeout: 20_000 });
  await page.evaluate((h) => { location.hash = h; }, hash);
  return { context, page };
}

async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
  await page.waitForTimeout(300);
}

/** 입력창 카드 안에서 도구 줄 단추의 가로 순서와 넘침을 잰다. */
async function toolFacts(page) {
  return page.evaluate(() => {
    const frame = document.querySelector('[data-testid="composer-frame"]');
    const q = (id) => document.querySelector(`[data-testid="${id}"]`);
    const order = ["composer-attach", "composer-mention-trigger", "composer-emoji-trigger", "composer-format-trigger", "composer-send"];
    const xs = order.map((id) => {
      const el = id === "composer-attach" ? frame?.querySelector('[aria-label="파일 첨부"]') : q(id);
      const r = el?.getBoundingClientRect();
      return r && r.width > 0 ? Math.round(r.left) : null;
    });
    const fr = frame?.getBoundingClientRect();
    return {
      xs,
      mic: !!frame?.querySelector('[aria-label*="마이크"],[aria-label*="받아쓰기"]'),
      frameRight: fr ? Math.round(fr.right) : null,
      frameWidth: fr ? Math.round(fr.width) : null,
      frameOverflow: frame ? frame.scrollWidth - frame.clientWidth : null,
      docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      glass: document.documentElement.hasAttribute("data-glass"),
      band: !!q("composer-context-band"),
      bandInFrame: !!(q("composer-context-band") && frame?.contains(q("composer-context-band"))),
      host: q("composer-context-host")?.textContent ?? null,
      wide: frame
        ? [...frame.querySelectorAll("*")]
            .filter((el) => el.getBoundingClientRect().right > frame.getBoundingClientRect().right + 0.5)
            .slice(0, 4)
            .map((el) => `${el.tagName}[${el.getAttribute("data-testid") ?? el.getAttribute("aria-label") ?? el.className.toString().slice(0, 40)}]`)
        : [],
    };
  });
}

async function quoteFirstPeerMessage(page) {
  const row = page.getByTestId("timeline-message").last();
  await row.hover();
  await row.getByTestId("message-actions-trigger").click();
  await page.getByRole("menuitem", { name: /인용/ }).click();
  await page.getByTestId("composer-quote").waitFor({ timeout: 5_000 });
}

async function scene(browser, origin, scheme, width) {
  const tag = `${width}-${scheme}`;
  const shot = (n) => resolve(OUT_DIR, `${n}-${tag}.png`);

  // 1) 채널: 빈 입력창 → 글 입력 → 서식 트레이
  {
    const { context, page } = await open(browser, origin, scheme, width, `/c/${GENERAL}`);
    await page.getByTestId("composer-input").waitFor({ timeout: 15_000 });
    await settle(page);
    let f = await toolFacts(page);
    check(`${tag} 채널: 도구 순서 + 멘션 이모지 서식 보내기`, [0, 1, 2, 4].every((i) => f.xs[i] !== null) && f.xs.filter((x) => x !== null).every((x, i, a) => i === 0 || x > a[i - 1]), JSON.stringify(f.xs));
    check(`${tag} 채널: 서식 단추는 카드가 320px보다 좁을 때만 접힌다(폭 ${f.frameWidth})`, (f.frameWidth < 320) === (f.xs[3] === null), JSON.stringify(f.xs));
    check(`${tag} 채널: 마이크 자리는 DOM 에 없다`, f.mic === false);
    check(`${tag} 채널: 띠가 없다`, f.band === false);
    check(`${tag} 채널: 카드·문서 가로 넘침 0`, f.frameOverflow <= 0 && f.docOverflow <= 0, JSON.stringify(f));
    check(`${tag} 채널: 유리 배경이 켜졌다(data-glass)`, f.glass === true);
    await page.screenshot({ path: shot("1-empty") });
    await page.getByTestId("composer-input").fill("배포 롤백 근거를 정리해 주세요");
    if (await page.getByTestId("composer-format-trigger").isVisible()) {
      await page.getByTestId("composer-format-trigger").click();
      await page.getByTestId("composer-format-tray").waitFor({ timeout: 5_000 });
    }
    await settle(page);
    f = await toolFacts(page);
    check(`${tag} 서식: 카드 넘침 0`, f.frameOverflow <= 0 && f.docOverflow <= 0, JSON.stringify(f));
    await page.screenshot({ path: shot("2-format") });
    await context.close();
  }

  // 2) 채널: 인용 띠
  {
    const { context, page } = await open(browser, origin, scheme, width, `/c/${GENERAL}`);
    await page.getByTestId("composer-input").waitFor({ timeout: 15_000 });
    await settle(page);
    await quoteFirstPeerMessage(page);
    await page.getByTestId("composer-input").fill("네, 이대로 올려 주세요");
    await settle(page);
    const f = await toolFacts(page);
    check(`${tag} 인용: 띠가 카드 안에 선다`, f.band && f.bandInFrame, JSON.stringify(f));
    check(`${tag} 인용: 호스트 칩은 없다(사람 채널)`, f.host === null);
    check(`${tag} 인용: 카드·문서 가로 넘침 0`, f.frameOverflow <= 0 && f.docOverflow <= 0, JSON.stringify(f));
    await page.screenshot({ path: shot("3-quote") });
    await context.close();
  }

  // 3) 에이전트 DM: 연결 안 됨 칩, 인용과 함께
  {
    const { context, page } = await open(browser, origin, scheme, width, `/c/${DM}`);
    await page.getByTestId("composer-input").waitFor({ timeout: 15_000 });
    await settle(page);
    let f = await toolFacts(page);
    check(`${tag} DM: 연결 안 됨 칩이 띠에 선다`, f.band && f.bandInFrame && f.host === "일하는 곳 · 연결 안 됨", JSON.stringify(f));
    await page.screenshot({ path: shot("4-dm-offline") });
    await quoteFirstPeerMessage(page);
    await settle(page);
    f = await toolFacts(page);
    check(`${tag} DM+인용: 한 띠 안에 칩 둘, 넘침 0`, f.band && f.host !== null && f.frameOverflow <= 0 && f.docOverflow <= 0, JSON.stringify(f));
    await page.screenshot({ path: shot("5-dm-quote") });
    await context.close();
  }

  // 4) 스레드 입력창 (넓은 폭만)
  if (width >= 1280) {
    const { context, page } = await open(browser, origin, scheme, width, `/c/${GENERAL}`);
    await page.getByTestId("composer-input").waitFor({ timeout: 15_000 });
    await settle(page);
    const anchor = page.getByTestId("thread-anchor").first();
    if (await anchor.count()) {
      await anchor.click();
      await page.getByTestId("thread-composer-input").waitFor({ timeout: 8_000 }).catch(() => {});
      await settle(page);
      const ok = await page.getByTestId("thread-composer-input").count();
      check(`${tag} 스레드: 입력창이 열린다`, ok === 1);
      if (ok) await page.screenshot({ path: shot("6-thread") });
    } else check(`${tag} 스레드: 앵커를 찾았다`, false);
    await context.close();
  }
}

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) throw new Error("dist/ is missing. Run npm run build first.");
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  try {
    for (const scheme of ["light", "dark"]) {
      for (const width of [1440, 1280, 900, 600]) await scene(browser, preview.origin, scheme, width);
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
