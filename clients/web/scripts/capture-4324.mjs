#!/usr/bin/env node
// =============================================================================
// #4324 캡처: 웹·데스크탑 메시지 줄 옅은 호버(바깥 4·안쪽 12·반경 14)·알약 도구 막대(32px 원 단추)·공용 툴팁·줄 착지 면
// (`--warn-soft` + 1px 테두리). 인물은 가상 인물.
//
// 라이트·다크 x 1440·1280·900, 데스크탑 유리 배경(#4190, 네이티브 호출은 가짜: 진짜 블러 없음 — runtime-unverified).
// 백엔드 없음(`/v1/**` 고정 응답, 가짜 소켓). 단언이 하나라도 실패하면 종료 코드 1.
//   npm run build && node scripts/capture-4324.mjs      → captures/4324/*.png
// =============================================================================

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "captures/4324");
const PORT = Number(process.env.CAPTURE_PORT || 5424);
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
  realtimeWebSocketUrl: "ws://capture-4324.invalid/connection/websocket",
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


const alpha = (c) => { const m = c.match(/[\d.]+/g) ?? []; return Number(m[3] ?? 1); };

async function scene(browser, origin, scheme, width) {
  const tag = `${width}-${scheme}`;
  const shot = (n) => resolve(OUT_DIR, `${n}-${tag}.png`);
  const rows = (page) => page.getByTestId("timeline-message");

  // 1) 줄 호버 + 도구 막대
  {
    const { context, page } = await open(browser, origin, scheme, width, `/c/${GENERAL}`);
    await rows(page).first().waitFor({ timeout: 15_000 });
    await settle(page);
    const row = rows(page).nth(1);
    await page.screenshot({ path: shot("0-rest") });
    await row.hover();
    await settle(page);
    const f = await row.evaluate((el) => {
      const cs = getComputedStyle(el);
      const bar = el.querySelector('[data-testid="message-hover-toolbar"]');
      const b = bar && getComputedStyle(bar);
      const btn = el.querySelector('[data-testid="toolbar-reply"]')?.getBoundingClientRect();
      return { bg: cs.backgroundColor, radius: cs.borderTopLeftRadius, ml: cs.marginLeft, pl: cs.paddingLeft,
        bar: !!bar, barRadius: b?.borderTopLeftRadius, barH: bar?.getBoundingClientRect().height, btnW: btn?.width, btnH: btn?.height };
    });
    check(`${tag} 줄: 호버 면이 옅다(알파 ≤ .5)`, alpha(f.bg) > 0 && alpha(f.bg) <= 0.51, JSON.stringify(f));
    check(`${tag} 줄: 반경 14·바깥 4·안쪽 12`, f.radius === "14px" && f.ml === "4px" && f.pl === "12px", JSON.stringify(f));
    check(`${tag} 도구 막대가 호버로 선다`, f.bar === true, JSON.stringify(f));
    check(`${tag} 도구 막대: 알약·단추 32px 원`, f.barH === 42 && f.btnW === 32 && f.btnH === 32, JSON.stringify(f));
    check(`${tag} 문서 가로 넘침 0`, (await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 0);
    await page.screenshot({ path: shot("1-hover") });

    // 2) 툴팁: 마우스는 500ms 뒤
    await row.getByTestId("toolbar-reply").hover();
    await page.waitForTimeout(150);
    const early = await page.getByTestId("tooltip").count();
    await page.waitForTimeout(700);
    const late = await page.getByTestId("tooltip").count();
    check(`${tag} 툴팁: 마우스는 500ms 전엔 없고 뒤엔 선다`, early === 0 && late >= 1, `early=${early} late=${late}`);
    await page.screenshot({ path: shot("2-tooltip") });
    await context.close();
  }

  // 3) 키보드: 도구 막대 단추에 Tab으로 닿으면 툴팁이 즉시, 줄 초점 면
  {
    const { context, page } = await open(browser, origin, scheme, width, `/c/${GENERAL}`);
    await rows(page).first().waitFor({ timeout: 15_000 });
    await settle(page);
    const row = rows(page).nth(1);
    await row.focus();
    await page.keyboard.press("Tab");
    await page.waitForTimeout(80);
    const reached = await page.evaluate(() => document.activeElement?.closest('[data-testid="message-hover-toolbar"]') !== null);
    const tips = await page.getByTestId("tooltip").count();
    check(`${tag} 키보드: Tab으로 도구 막대에 닿고 툴팁이 즉시 선다`, reached && tips >= 1, `reached=${reached} tips=${tips}`);
    await page.screenshot({ path: shot("3-keyboard") });
    await context.close();
  }

  // 4) 줄 착지 면(링크로 도착): warn-soft + 1px 안쪽 테두리, 1.6초 뒤 사라진다
  {
    const { context, page } = await open(browser, origin, scheme, width, `/c/${GENERAL}?seq=2`);
    await rows(page).first().waitFor({ timeout: 15_000 });
    const landed = await page.waitForSelector(".landed-surface", { timeout: 5_000 }).catch(() => null);
    check(`${tag} 착지: 도착한 줄에 landed-surface 가 붙는다`, landed !== null);
    if (landed) {
      const f = await landed.evaluate((el) => {
        const cs = getComputedStyle(el);
        const ref = document.createElement("i");
        ref.className = "bg-warn-soft";
        document.body.append(ref);
        const warn = getComputedStyle(ref).backgroundColor;
        ref.remove();
        return { bg: cs.backgroundColor, warn, shadow: cs.boxShadow, h: el.getBoundingClientRect().height };
      });
      check(`${tag} 착지: 바탕은 --warn-soft, 테두리는 안쪽 1px`, f.bg === f.warn && /inset/.test(f.shadow) && /1px/.test(f.shadow), JSON.stringify(f));
      await page.screenshot({ path: shot("4-landed") });
    }
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
      for (const width of [1440, 1280, 900]) await scene(browser, preview.origin, scheme, width);
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
