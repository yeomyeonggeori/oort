#!/usr/bin/env node
// =============================================================================
// CAPTURE (#3950, ADR-0113 증보 2 E8·E10): 채팅 쪽 「쓴 앱」 꼬리 · 채널 노출 줄 · 막힘 문장
//   1. #마케팅(채널): 앱을 쓴 에이전트 답의 꼬리 + 「이 채널 n명에게 보여요」(+ 개인 앱 안내)
//   2. DM: 같은 꼬리, 노출 줄 없음
//   3. #막힘: 막힘 문장 전부(꺼짐·시간 초과·로그인 끊김 둘·회수·한도·차단·허용 안 함·진행 중)
//   4. 옛 서버(run 에 appsUsed 없음, props 에 app_notice 없음): 꼬리도 문장도 없음
//
//   npm run build && OUT_DIR=<dir> node scripts/capture-3950.mjs
// 백엔드는 없다: `/v1/**` 고정 응답, 실시간 소켓은 곧바로 연결되는 흉내다.
// =============================================================================

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/3950");
const PORT = Number(process.env.CAPTURE_PORT || 5250);

const workspaceId = "00000000-0000-7000-8000-000000000001";
const me = "00000000-0000-7000-8000-000000000101";
const haneul = "00000000-0000-7000-8000-000000000102";
const minjun = "00000000-0000-7000-8000-000000000103";
const soyeon = "00000000-0000-7000-8000-000000000104";
const jiho = "00000000-0000-7000-8000-000000000105";
const hermes = "00000000-0000-7000-8000-000000000302";
const marketing = "00000000-0000-7000-8000-000000000202";
const blocked = "00000000-0000-7000-8000-000000000203";
const dm = "00000000-0000-7000-8000-000000000204";
const BASE_MS = Date.parse("2026-10-18T02:10:00.000Z");
const channels = [
  { id: marketing, workspaceId, kind: "public", name: "마케팅", muted: false },
  { id: blocked, workspaceId, kind: "public", name: "막힘", muted: false },
  { id: dm, workspaceId, kind: "dm", name: null, muted: false },
];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: me, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: "ws://capture-3950.invalid/connection/websocket",
};
const person = (id, displayName, handle, role, channelIds) => ({
  id, workspaceId, kind: "human", status: "active", role, displayName, handle, channelCount: channelIds.length,
  channelIds, capabilities: [], createdAtMs: 0, updatedAtMs: 0,
});
const roster = () => [
  person(me, "곽성재", "seongjae", "owner", [marketing, blocked, dm]),
  person(haneul, "김하늘", "haneul", "member", [marketing]),
  person(minjun, "박민준", "minjun", "member", [marketing]),
  person(soyeon, "이소연", "soyeon", "member", [marketing]),
  person(jiho, "최지호", "jiho", "member", [marketing]),
  { id: hermes, workspaceId, kind: "agent", status: "active", displayName: "Hermes", handle: "hermes", channelCount: 3,
    channelIds: [marketing, blocked, dm], capabilities: [], ownerHumanId: me, createdAtMs: 0, updatedAtMs: 0 },
];

// 장면마다 서버 답을 바꾼다. old: run 에 appsUsed 가 없고 app_notice 도 없는 서버.
const scenario = { old: false };

const catalog = () => ({
  plugins: [
    { pluginId: "gmail", name: "Gmail", version: "1", description: "메일", official: true, recommended: true, egressDomains: ["gmailmcp.googleapis.com"], recommendedFor: [], installed: true, enabled: true },
    { pluginId: "google-calendar", name: "캘린더", version: "1", description: "일정", official: true, recommended: true, egressDomains: ["calendarmcp.googleapis.com"], recommendedFor: [], installed: true, enabled: true },
    { pluginId: "github", name: "GitHub", version: "1", description: "코드", official: true, recommended: true, egressDomains: ["api.githubcopilot.com"], recommendedFor: [], installed: true, enabled: true },
  ],
});
const RUNS = {
  "0199aa11-2222-7000-8000-000000003950": [{ pluginId: "gmail", tool: "search_threads", calls: 2 }],
  "0199aa11-2222-7000-8000-000000003951": [
    { pluginId: "github", tool: "get_issue", calls: 1 },
    { pluginId: "github", tool: "list_issues", calls: 3 },
  ],
  "0199aa11-2222-7000-8000-000000003952": [{ pluginId: "google-calendar", tool: "list_events", calls: 1 }],
};
const gw = (run) => ({ source: "hermes_gateway", status: "succeeded", run_id: run });
const failed = (note) => ({ source: "hermes_gateway", status: "failed", run_id: "0199aa11-2222-7000-8000-000000003999", app_notice: note });

const NOTICES = [
  ["site_off · 내 맥", { kind: "site_off", site: "mac" }],
  ["site_silent · Hermes", { kind: "site_silent", site: "hermes" }],
  ["login_lost · 내 맥", { kind: "login_lost", plugin_id: "gmail", site: "mac" }],
  ["login_lost · Hermes", { kind: "login_lost", plugin_id: "gmail", site: "hermes" }],
  ["grant_revoked", { kind: "grant_revoked" }],
  ["rate_limited", { kind: "rate_limited", plugin_id: "github" }],
  ["egress_blocked", { kind: "egress_blocked", plugin_id: "gmail", host: "gmailmcp.googleapis.com" }],
  ["not_allowed", { kind: "not_allowed", plugin_id: "gmail" }],
  ["working", { kind: "working", site: "hermes" }],
];

// 「n분째」는 지금 시각에서 센다: 캡처가 언제 돌아도 3분째다.
function withClock(props) {
  const note = props.app_notice;
  return note?.kind === "working" ? { ...props, app_notice: { ...note, since_ms: Date.now() - 3 * 60_000 } } : props;
}

function messagesFor(channelId) {
  let list = [];
  if (channelId === marketing) {
    list = [
      { id: "m1", author: me, body: "@Hermes 이번 주 거래처 메일에서 견적 얘기 나온 것만 찾아 줄래요?" },
      { id: "m2", author: hermes, body: "받은편지함에서 견적 관련 메일 두 건을 찾았어요. 하나는 10월 21일 회신 기한이고, 다른 하나는 금액 확인 요청이에요. 본문은 옮기지 않고 요약만 적었어요.", props: gw("0199aa11-2222-7000-8000-000000003950"), replyToId: "m1" },
      { id: "m3", author: me, body: "@Hermes 로그인 오류 이슈 정리해 줘" },
      { id: "m4", author: hermes, body: "열린 이슈 4건 중 로그인 오류는 #812 하나예요. 재현 방법이 댓글에 있어요.", props: gw("0199aa11-2222-7000-8000-000000003951"), replyToId: "m3" },
    ];
  } else if (channelId === dm) {
    list = [
      { id: "d1", author: me, body: "내일 일정 알려 줘" },
      { id: "d2", author: hermes, body: "내일은 오전 10시 팀 회의 하나만 있어요.", props: gw("0199aa11-2222-7000-8000-000000003952"), replyToId: "d1" },
    ];
  } else if (channelId === blocked) {
    NOTICES.forEach(([label, note], index) => {
      list.push({ id: `n${index}q`, author: me, body: `(${index + 1}) ${label}` });
      list.push({ id: `n${index}`, author: hermes, type: "text", body: "답을 만들지 못했어요.", props: failed(note), replyToId: `n${index}q` });
    });
  }
  const bySeq = new Map(list.map((row) => [row.id, row]));
  return list.map((row, index) => {
    const parent = row.replyToId ? bySeq.get(row.replyToId) : null;
    return {
      id: row.id, channelId, seq: 3950 + index, hlcTs: BASE_MS + index * 60_000, hlcCount: 0,
      authorMemberId: row.author, type: row.type ?? "text", body: row.body, state: "sent",
      ...(row.props ? { props: scenario.old ? { source: "hermes_gateway", status: row.props.status, run_id: row.props.run_id } : withClock(row.props) } : {}),
      ...(parent ? { replyToId: parent.id, replyTo: { id: parent.id, seq: 0, authorMemberId: parent.author, type: "text", body: parent.body, state: "sent" } } : {}),
      createdAtMs: BASE_MS + index * 60_000,
    };
  });
}

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function installRoutes(context) {
  await context.route("**/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId: me });
    }
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) return json(route, { members: roster() });
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/hosted-agent-connections")) return json(route, { connections: [] });
    if (path.endsWith("/plugins")) return json(route, catalog());
    const run = path.match(/\/agent-runs\/([0-9a-f-]{36})$/);
    if (run) {
      const appsUsed = RUNS[run[1]];
      return json(route, {
        id: run[1], workspaceId, agentMemberId: hermes, channelId: marketing, status: "succeeded", stepCount: 1, maxSteps: 4,
        createdAtMs: BASE_MS, updatedAtMs: BASE_MS, ...(appsUsed && !scenario.old ? { appsUsed } : {}),
      });
    }
    if (path.endsWith("/unfurl-settings")) return json(route, { enabled: true });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null, participants: [] });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: [] });
    if (path.endsWith("/work-sessions/shared")) return json(route, { sessions: [], nextCursor: null });
    if (path.endsWith("/work-sessions")) return json(route, { workSessions: [] });
    if (path.endsWith(`/workspaces/${workspaceId}`)) {
      return json(route, { workspace: { id: workspaceId, name: "여명거리", slug: "team", updatedAtMs: 1, roleLabels: {}, welcomeAgentMemberId: null, welcomePrompt: "", subscriptionAgentsEnabled: true } });
    }
    for (const channel of channels) {
      if (path.includes(`/channels/${channel.id}/messages`)) return json(route, { messages: messagesFor(channel.id) });
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
          if (c.connect) return { id: c.id, connect: { client: "capture-3950", version: "6" } };
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

async function open(browser, origin, scheme, viewport, channelId) {
  const context = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion: "reduce", serviceWorkers: "block", deviceScaleFactor: 2 });
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
  await page.evaluate((id) => { location.hash = `/c/${id}`; }, channelId);
  return { context, page };
}

async function tailScenes(browser, origin, scheme, viewport) {
  const tag = `${viewport.width}-${scheme}`;
  scenario.old = false;
  // 1. 채널
  {
    const { context, page } = await open(browser, origin, scheme, viewport, marketing);
    await page.getByTestId("apps-used-line").first().waitFor({ timeout: 25_000 });
    await page.waitForTimeout(600);
    await page.getByTestId("apps-used-tail").first().evaluate((el) => el.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(300);
    const visibleLine = (n) => page.getByTestId("apps-used-line").nth(n).textContent();
    const first = await visibleLine(0);
    check(`${tag} 꼬리 한 줄`, first === "쓴 앱: Gmail 검색 2회 · 이 채널 5명에게 보여요", first);
    const second = await visibleLine(1);
    check(`${tag} 둘째 꼬리: GitHub 한 앱, 도구 섞이면 횟수만`, second === "쓴 앱: GitHub 4회", second);
    check(`${tag} 접힌 동안 명의·주소는 없다`, (await page.getByTestId("apps-details").count()) === 0);
    const tailBox = await page.getByTestId("apps-used-tail").first().boundingBox();
    check(`${tag} 꼬리 높이: 390에서도 두 줄 이하`, tailBox.height <= 48, String(tailBox.height));
    await page.getByTestId("apps-details-toggle").first().click();
    await page.waitForTimeout(200);
    const details = await page.getByTestId("apps-details").first().textContent();
    check(`${tag} 자세히: 명의·연결·자기 보고·개인 앱 안내`, ["Hermes에서 실행했어요.", "곽성재 명의로 썼어요.", "연결: gmailmcp.googleapis.com", "oort는 확인하지 못해요", "요약만 올리는 게 원칙이에요"].every((t) => details.includes(t)), details);
    await page.screenshot({ path: resolve(OUT_DIR, `c3950-1c-tail-channel-details-${tag}.png`) });
    await page.getByTestId("apps-details-toggle").first().click();
    await page.getByTestId("apps-used-tail").first().evaluate((el) => el.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(200);
    await page.screenshot({ path: resolve(OUT_DIR, `c3950-1a-tail-channel-${tag}.png`) });
    check(`${tag} 가로 넘침 0`, (await overflowX(page)) === 0);
    await page.getByTestId("apps-used-tail").nth(1).evaluate((el) => el.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(200);
    await page.screenshot({ path: resolve(OUT_DIR, `c3950-1b-tail-channel-github-${tag}.png`) });
    await context.close();
  }
  // 2. DM
  {
    const { context, page } = await open(browser, origin, scheme, viewport, dm);
    await page.getByTestId("apps-used-line").first().waitFor({ timeout: 25_000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: resolve(OUT_DIR, `c3950-2-tail-dm-${tag}.png`) });
    check(`${tag} DM: 꼬리는 있고 노출 줄은 없다`, (await page.getByTestId("apps-exposure-line").count()) === 0);
    await context.close();
  }
}

async function noticeScenes(browser, origin, scheme, base) {
  const tag = `${base.width}-${scheme}`;
  scenario.old = false;
  // 목록은 가상화돼 있다. 아홉 줄이 한 번에 그려지도록 키 큰 창에서 한 장으로 찍는다.
  const viewport = { width: base.width, height: base.width >= 1000 ? 2300 : 3300 };
  const { context, page } = await open(browser, origin, scheme, viewport, blocked);
  await page.getByTestId("app-notice").first().waitFor({ timeout: 25_000 });
  await page.waitForTimeout(600);
  await page.evaluate(() => { const el = document.querySelector("[data-testid='app-notice']"); let n = el?.parentElement; while (n && n.scrollHeight <= n.clientHeight + 4) n = n.parentElement; if (n) n.scrollTop = 0; });
  // 목록은 가상화돼 있다: 위에서 아래로 훑으며 보인 줄을 모은다.
  const seen = new Map();
  const actionLinks = new Map();
  for (let step = 0; step < 40; step += 1) {
    const rows = await page.getByTestId("app-notice").evaluateAll((els) =>
      els.map((el) => ({ kind: el.getAttribute("data-kind"), text: el.textContent, action: el.querySelector("[data-testid='app-notice-action']")?.getAttribute("href") ?? null, label: el.querySelector("[data-testid='app-notice-action']")?.textContent ?? null })));
    for (const row of rows) { seen.set(`${row.kind}|${row.text}`, row.text); if (row.label) actionLinks.set(row.label, row.action); }
    const moved = await page.evaluate(() => {
      const el = document.querySelector("[data-testid='app-notice']");
      let node = el?.parentElement;
      while (node && node.scrollHeight <= node.clientHeight + 4) node = node.parentElement;
      if (!node) return false;
      const before = node.scrollTop;
      node.scrollTop += node.clientHeight * 0.7;
      return node.scrollTop !== before;
    });
    await page.waitForTimeout(120);
    if (!moved) break;
  }
  const joined = [...seen.values()].join("\n");
  const wanted = [
    "내 맥이 꺼져 있어서 못 했어요. 맥을 켜면 다시 해 볼게요.",
    "Hermes가 답하지 않아요.",
    "Gmail 로그인이 끊겼어요.",
    "Gmail 로그인이 끊겼어요. 운영자가 다시 로그인해야 해요.",
    "실행 중에 허용이 회수돼서 여기서 멈췄어요. 이미 한 일은 그대로예요.",
    "GitHub가 잠시 요청을 막았어요. 1분 뒤 다시 해 주세요.",
    "에이전트가 gmailmcp.googleapis.com에 연결할 수 없어요.",
    "먼저 내 사용을 허용해 주세요.",
    "Hermes에서 하는 중 · 3분째",
  ];
  for (const text of wanted) check(`${tag} 막힘 문장: ${text}`, joined.includes(text), joined.slice(0, 300));
  check(`${tag} 행동 링크는 둘: 다시 로그인 · 앱 열기`, JSON.stringify([...actionLinks.keys()].sort()) === JSON.stringify(["다시 로그인", "앱 열기"]), JSON.stringify([...actionLinks]));
  check(`${tag} 행동은 앱 화면으로`, [...actionLinks.values()].every((h) => h?.endsWith("/ai/external/apps")), JSON.stringify([...actionLinks]));
  check(`${tag} 가로 넘침 0`, (await overflowX(page)) === 0);
  // 위쪽·아래쪽 두 장
  await page.evaluate(() => { const el = document.querySelector("[data-testid='app-notice']"); let n = el?.parentElement; while (n && n.scrollHeight <= n.clientHeight + 4) n = n.parentElement; if (n) n.scrollTop = 0; });
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve(OUT_DIR, `c3950-3-notices-${tag}.png`) });
  // 키보드 경로: 링크는 탭으로 닿는다.
  const first = page.getByTestId("app-notice-action").first();
  await first.waitFor({ timeout: 5000 });
  await first.focus();
  check(`${tag} 키보드: 행동 링크에 포커스`, await first.evaluate((el) => el === document.activeElement));
  await context.close();
}

async function oldServerScenes(browser, origin) {
  const viewport = { width: 1440, height: 900 };
  scenario.old = true;
  for (const [channelId, name] of [[marketing, "마케팅"], [blocked, "막힘"]]) {
    const { context, page } = await open(browser, origin, "light", viewport, channelId);
    await page.getByText(channelId === marketing ? "견적 관련 메일 두 건" : "(1) site_off").first().waitFor({ timeout: 25_000 });
    await page.waitForTimeout(1200);
    check(`옛 서버 #${name}: 꼬리 없음`, (await page.getByTestId("apps-used-tail").count()) === 0);
    check(`옛 서버 #${name}: 막힘 문장 없음`, (await page.getByTestId("app-notice").count()) === 0);
    if (channelId === marketing) await page.screenshot({ path: resolve(OUT_DIR, "c3950-4-old-server-1440-light.png") });
    await context.close();
  }
  scenario.old = false;
}

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) throw new Error("dist/ is missing. Run npm run build first.");
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  try {
    for (const [scheme, viewport] of [
      ["light", { width: 1440, height: 900 }],
      ["dark", { width: 1440, height: 900 }],
      ["light", { width: 390, height: 844 }],
      ["dark", { width: 390, height: 844 }],
    ]) {
      await tailScenes(browser, preview.origin, scheme, viewport);
      await noticeScenes(browser, preview.origin, scheme, viewport);
    }
    await oldServerScenes(browser, preview.origin);
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
