#!/usr/bin/env node
// =============================================================================
// 「AI」 허브 › 외부 연결 구획 캡처 (AIH-8, #3438): /ai/external 목차(다섯 줄 · 개수 칩 · 코드 실행
// 호스트 링크), 줄마다 상세(앱 · 채널로 들어오는 주소 · 밖으로 보내는 알림 · 외부 에이전트 연결),
// 소유자 / 일반 멤버(읽기) 두 시점, 설정 쪽 안내 한 줄, 옛 딥링크 리다이렉트.
//
//   npm run build && OUT_DIR=~/.cache/momo-scratch/3438/captures node scripts/capture-ai-external.mjs
//
// 백엔드는 없다: `/v1/**`는 고정 응답, 실시간 소켓은 곧바로 연결되는 흉내다. 일반 멤버 시점에서는
// 서버가 운영자 목록(웹훅 · 이벤트 구독 · 호스티드 연결)에 403을 답한다. 라이트·다크 × 1440 · 1100 · 420.
// =============================================================================

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/ai-external");
const PORT = Number(process.env.CAPTURE_PORT || 5237);

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const otherHuman = "00000000-0000-7000-8000-000000000102";
const channels = [
  { id: "00000000-0000-7000-8000-000000000201", workspaceId, kind: "public", name: "general", muted: false },
  { id: "00000000-0000-7000-8000-000000000202", workspaceId, kind: "public", name: "알림", muted: false },
];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: "ws://ai-external-capture.invalid/connection/websocket",
};
const base = { workspaceId, status: "active", channelCount: 2, channelIds: channels.map((c) => c.id), capabilities: [], createdAtMs: 0, updatedAtMs: 0 };
const agentId = "00000000-0000-7000-8000-000000000303";
const roster = [
  { ...base, id: memberId, kind: "human", displayName: "곽성재", handle: "seongjae", role: "owner" },
  { ...base, id: otherHuman, kind: "human", displayName: "서연", handle: "seoyeon", role: "member" },
  { ...base, id: agentId, kind: "agent", displayName: "hermes", handle: "hermes", paused: false, ownerHumanId: memberId },
];
const connections = [
  {
    id: "c-1", agentMemberId: agentId, status: "active", authMode: "bearer", audience: "oort", approvedChannelIds: [channels[0].id],
    approvedScopes: [], invocationScope: "workspace", createdAtMs: Date.now() - 86_400_000, updatedAtMs: Date.now() - 3_600_000,
  },
];
const plugins = {
  plugins: [
    { pluginId: "github", name: "GitHub", version: "1.2.0", description: "이슈와 PR을 채널에서 봐요.", official: true, recommended: true, egressDomains: ["api.github.com"], recommendedFor: ["개발"], installed: true, enabled: true },
    { pluginId: "linear", name: "Linear", version: "1.0.3", description: "이슈 상태를 채널에서 바꿔요.", official: true, recommended: false, egressDomains: ["api.linear.app"], recommendedFor: ["개발"], installed: true, enabled: true },
    { pluginId: "notion", name: "Notion", version: "0.9.0", description: "문서를 검색해요.", official: true, recommended: false, egressDomains: ["api.notion.com"], recommendedFor: ["문서"], installed: false, enabled: false },
  ],
};
const webhooks = {
  installations: [
    { id: "w1", channelId: channels[0].id, authorMemberId: memberId, mode: "native", status: "active", label: "배포 알림", createdAtMs: Date.now() - 5 * 86_400_000, updatedAtMs: Date.now() - 86_400_000 },
  ],
};
const eventSubs = {
  eventSubscriptions: [
    { id: "e1", workspaceId, url: "https://hooks.slack.com/services/T0/B0/oort", eventKinds: ["mention"], enabled: true, deliveryFailureCount: 0, createdAtMs: Date.now() - 2 * 86_400_000, updatedAtMs: Date.now() - 2 * 86_400_000 },
    { id: "e2", workspaceId, url: "https://ops.example.com/oort/status", eventKinds: ["approval_request"], enabled: true, deliveryFailureCount: 0, createdAtMs: Date.now() - 9 * 86_400_000, updatedAtMs: Date.now() - 9 * 86_400_000 },
  ],
};
const scenario = { operator: true };
const denied = (route) => json(route, { error: { code: "forbidden", message: "operators only" } }, 403);

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function installRoutes(context) {
  await context.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId });
    }
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) {
      return json(route, { members: roster.map((m) => (m.id === memberId && !scenario.operator ? { ...m, role: "member" } : m)) });
    }
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/hosted-agent-connections")) return scenario.operator ? json(route, { connections }) : denied(route);
    if (path.endsWith("/webhooks")) return scenario.operator ? json(route, webhooks) : denied(route);
    if (path.endsWith("/event-subscriptions")) return scenario.operator ? json(route, eventSubs) : denied(route);
    if (path.endsWith("/plugins")) return json(route, plugins);
    const detail = path.match(/\/plugins\/([^/]+)$/);
    if (detail) {
      const item = plugins.plugins.find((p) => p.pluginId === detail[1]);
      if (!item) return json(route, { error: { code: "not_found", message: "no plugin" } }, 404);
      return json(route, {
        plugin: {
          ...item,
          manifest: {
            plugin: { publisher: { name: item.name, verified: true }, license: { spdx: "MIT" }, provenance: { sourceURL: "https://example.com/source" } },
            mcp: { tools: [{ name: "search", description: "검색", scopes: ["read"] }] },
            momo: { approvalTier: { search: "auto" } },
          },
        },
      });
    }
    if (path.endsWith("/provider/link")) return scenario.operator ? json(route, { schema: "momo.provider_link.v0", configured: false, source: "environment", mode: "local-mock", baseUrl: "http://mock", endpointLabel: "mock", bearerConfigured: false, availability: "mock", keyConfigured: false, diagnostics: [] }) : denied(route);
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: [] });
    if (path.endsWith("/work-sessions/shared")) return json(route, { sessions: [], nextCursor: null });
    if (path.endsWith("/work-sessions")) return json(route, { workSessions: [] });
    if (path.endsWith(`/workspaces/${workspaceId}`)) {
      return json(route, { workspace: { id: workspaceId, name: "여명거리", slug: "team", updatedAtMs: 1, roleLabels: {}, welcomeAgentMemberId: null, welcomePrompt: "", subscriptionAgentsEnabled: true } });
    }
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
        queueMicrotask(() => { this.readyState = 1; this.onopen?.(new Event("open")); });
      }
      send(data) {
        const replies = String(data).trim().split("\n").map((line) => {
          const c = JSON.parse(line);
          if (c.connect) return { id: c.id, connect: { client: "ai-external-capture", version: "6" } };
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

const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok) failures.push(name);
}
const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const text = async (page, testId) => ((await page.getByTestId(testId).textContent()) ?? "").replace(/\s+/g, " ").trim();

async function open(browser, origin, scheme, viewport) {
  const context = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion: "reduce", serviceWorkers: "block" });
  await installRoutes(context);
  const page = await context.newPage();
  await installRealtime(page);
  await page.addInitScript((server) => { try { localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ } }, origin);
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("nav-ai").waitFor({ timeout: 20_000 });
  if ((await page.getByTestId("sidebar-toggle").getAttribute("aria-expanded")) === "false") {
    await page.getByTestId("sidebar-toggle").click();
    await page.waitForTimeout(400);
  }
  return { context, page };
}

const DETAILS = [
  ["apps", "apps", "앱"],
  ["incoming", "incoming", "채널로 들어오는 주소"],
  ["outgoing", "outgoing", "밖으로 보내는 알림"],
  ["agents", "externalAgents", "외부 에이전트 연결"],
];

async function scenes(browser, origin, scheme, viewport, operator) {
  const who = operator ? "owner" : "member";
  const tag = `${who}-${viewport.width}-${scheme}`;
  scenario.operator = operator;
  const { context, page } = await open(browser, origin, scheme, { width: viewport.width, height: viewport.height });
  const shot = (name) => page.screenshot({ path: resolve(OUT_DIR, `${name}-${tag}.png`), fullPage: true });
  try {
    await page.goto(`${origin}/#/ai/external`);
    await page.getByTestId("ai-hub-pane-external").waitFor();
    await page.getByTestId("ai-external-row-apps").waitFor();
    await page.waitForTimeout(900);
    await shot("index");

    const titles = await page.locator('[data-testid^="ai-external-row-"] h3').evaluateAll((els) => els.map((e) => e.firstChild?.textContent));
    check(`${tag} 목차 다섯 줄 이름`, titles.join("|") === "앱|채널로 들어오는 주소|밖으로 보내는 알림|외부 에이전트 연결|호스티드 봇 초대", titles.join("|"));
    const chip = async (id) => (await page.getByTestId(`ai-external-chip-${id}`).count()) ? text(page, `ai-external-chip-${id}`) : null;
    if (operator) {
      check(`${tag} 개수 칩: 설치 2 · 주소 1 · 구독 2 · 연결 1`, [await chip("apps"), await chip("incoming"), await chip("outgoing"), await chip("externalAgents"), await chip("hostedBotInvite")].join("|") === "설치 2|주소 1|구독 2|연결 1|봇 1");
    } else {
      check(`${tag} 일반 멤버: 설치 2 + 나머지는 소유자·관리자만 볼 수 있어요(0을 지어내지 않는다)`, [await chip("apps"), await chip("incoming"), await chip("outgoing"), await chip("externalAgents")].join("|") === "설치 2|소유자·관리자만 볼 수 있어요|소유자·관리자만 볼 수 있어요|소유자·관리자만 볼 수 있어요");
    }
    check(`${tag} 권한 문장`, (await text(page, "ai-external-permission")).includes("소유자·관리자만"));
    check(`${tag} 목차에 영어 약자·합류 없음`, !/MCP|Agent Port|합류/.test(await page.getByTestId("ai-hub-route").innerText()));
    check(`${tag} 코드 실행 호스트 링크 → 설정`, (await page.getByTestId("ai-external-code-host-link").getAttribute("href")).endsWith("/settings?section=code"));
    check(`${tag} 목차 가로 넘침 0`, (await overflowX(page)) === 0);

    for (const [sub, rowId, title] of DETAILS) {
      await page.getByTestId(`ai-external-open-${rowId}`).click();
      await page.getByTestId(`ai-external-detail-${rowId}`).waitFor();
      await page.waitForTimeout(900);
      await shot(`detail-${sub}`);
      const h2 = await page.locator("[data-testid='ai-hub-route'] h2").allTextContents();
      check(`${tag} ${sub} 머리: 용어집 이름 하나, 옛 제목 h2 겹침 없음`, h2.length === 1 && h2[0].startsWith(title), JSON.stringify(h2));
      check(`${tag} ${sub} 가로 넘침 0`, (await overflowX(page)) === 0);
      if (!operator && sub !== "apps") {
        check(`${tag} ${sub} 일반 멤버: 읽기 안내(OperatorNotice), 만들기 폼 없음`, (await page.getByTestId("operator-notice").count()) === 1 && (await page.locator("[data-testid='ai-hub-route'] form").count()) === 0);
      }
      await page.getByTestId("ai-external-back").click();
      await page.getByTestId("ai-external-row-apps").waitFor();
      check(`${tag} ${sub} 돌아오면 그 줄의 열기에 포커스`, (await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))) === `ai-external-open-${rowId}`);
    }
  } finally {
    await context.close();
  }
}

// 설정 쪽 안내 한 줄과 옛 딥링크 리다이렉트.
async function settingsScenes(browser, origin, scheme, viewport) {
  const tag = `${viewport.width}-${scheme}`;
  scenario.operator = true;
  const { context, page } = await open(browser, origin, scheme, viewport);
  try {
    await page.goto(`${origin}/#/settings?section=profile`);
    await page.getByTestId("settings-nav-events").waitFor();
    await page.getByTestId("settings-nav-ai").click();
    await page.getByTestId("ai-hub-moved-link").waitFor();
    await page.waitForTimeout(500);
    await page.screenshot({ path: resolve(OUT_DIR, `settings-one-liner-${tag}.png`), fullPage: true });
    check(`${tag} 설정 › AI 연결: 안내 한 줄 링크`, (await page.getByTestId("ai-hub-moved-link").locator("a").getAttribute("href")).endsWith("/ai/accounts"));
    // 옮긴 네 구획은 사이드바에서 눌러도 그 줄 상세로 간다.
    for (const [nav, target] of [["events", "outgoing"], ["webhooks", "incoming"], ["plugins", "apps"], ["agents", "agents"]]) {
      await page.goto(`${origin}/#/settings?section=profile`);
      await page.getByTestId(`settings-nav-${nav}`).click();
      await page.getByTestId(`ai-external-detail-${target === "agents" ? "externalAgents" : target}`).waitFor();
      check(`${tag} 설정 사이드바 ${nav} 클릭 → /ai/external/${target}`, page.url().endsWith(`#/ai/external/${target}`), page.url());
      check(`${tag} 상세 진입 시 포커스가 제목에 있다(${target})`, await page.evaluate(() => document.activeElement?.tagName === "H2"));
    }
    for (const [section, target] of [["webhooks", "incoming"], ["plugins", "apps"], ["agents", "agents"], ["events", "outgoing"]]) {
      await page.goto(`${origin}/#/settings?section=${section}`);
      await page.getByTestId(`ai-hub-pane-external`).waitFor({ state: "detached", timeout: 100 }).catch(() => {});
      await page.waitForFunction((t) => location.hash === `#/ai/external/${t}`, target, { timeout: 5000 }).catch(() => {});
      check(`${tag} ?section=${section} → /ai/external/${target}`, page.url().endsWith(`#/ai/external/${target}`), page.url());
    }
  } finally {
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
      for (const viewport of [{ width: 1440, height: 900 }, { width: 1100, height: 800 }, { width: 420, height: 1300 }]) {
        await scenes(browser, preview.origin, scheme, viewport, true);
        await scenes(browser, preview.origin, scheme, viewport, false);
      }
      await settingsScenes(browser, preview.origin, scheme, { width: 1100, height: 700 });
      await settingsScenes(browser, preview.origin, scheme, { width: 420, height: 800 });
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
