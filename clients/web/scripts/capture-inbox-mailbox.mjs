#!/usr/bin/env node
// =============================================================================
// #3663 인박스 메일함 캡처: 종류가 섞인 목록(DM·멘션·스레드·처리할 일) + 오른쪽 맥락
// 패널, 필터, 빈 상태. 라이트·다크 × 1440×900.
//
//   npm run build && OUT_DIR=<dir> node scripts/capture-inbox-mailbox.mjs
//
// 백엔드는 없다: `/v1/**`는 고정 응답, 실시간 소켓은 곧바로 연결되는 흉내다
// (capture-sidebar-ia.mjs와 같은 모양). 응답 모양은 서버 읽기 계약 그대로다 —
// read-state, 채널 메시지 페이지(`thread` 롤업 포함), 스레드 답글, 대기 승인.
// =============================================================================

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/inbox-mailbox");
const PORT = Number(process.env.CAPTURE_PORT || 5213);

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const otherId = "00000000-0000-7000-8000-000000000102";
const agentId = "00000000-0000-7000-8000-000000000301";
const dawnId = "00000000-0000-7000-8000-000000000302";
const ch = (n) => `00000000-0000-7000-8000-0000000002${n}`;
const WB = ch("01");
const DESIGN = ch("02");
const DM_SEO = ch("03");
const DM_DAWN = ch("04");
const channels = [
  { id: WB, workspaceId, kind: "public", name: "workbench", muted: false },
  { id: DESIGN, workspaceId, kind: "public", name: "design-2.0", muted: false },
  { id: DM_SEO, workspaceId, kind: "dm", dmKey: "a", memberIds: [memberId, otherId], muted: false },
  { id: DM_DAWN, workspaceId, kind: "dm", dmKey: "b", memberIds: [memberId, dawnId], muted: false },
];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: "ws://inbox-capture.invalid/connection/websocket",
};
const NOW = Date.now();
const MIN = 60_000;
const person = (id, kind, displayName, handle, extra = {}) => ({
  id, workspaceId, kind, status: "active", displayName, handle, channelCount: 4,
  channelIds: channels.map((c) => c.id), capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...extra,
});
const roster = [
  person(memberId, "human", "곽성재", "seongjae", { role: "owner" }),
  person(otherId, "human", "서연", "seoyeon", { role: "member" }),
  person(agentId, "agent", "김인턴", "kim-intern", { ownerHumanId: memberId }),
  person(dawnId, "agent", "새벽봇", "dawn-bot", { ownerHumanId: otherId }),
];

const msg = (channelId, seq, authorMemberId, body, minAgo, extra = {}) => ({
  id: `00000000-0000-7000-8000-00000000${channelId.slice(-2)}${String(seq).padStart(2, "0")}`,
  channelId, seq, hlcTs: NOW - minAgo * MIN, hlcCount: 0, authorMemberId, type: "text", body,
  createdAtMs: NOW - minAgo * MIN, ...extra,
});
const dmSeo = [
  msg(DM_SEO, 5, memberId, "어제 올린 PR 봤어요?", 90),
  msg(DM_SEO, 6, otherId, "네, 리뷰 남겼어요", 80),
  msg(DM_SEO, 7, otherId, "인박스 새 구조 얘기 잠깐 할 수 있어요?", 12),
  msg(DM_SEO, 8, otherId, "오늘 4시에 디자인 리뷰 있는데, 같이 보면 좋겠어요", 4),
];
const dmDawn = [
  msg(DM_DAWN, 3, memberId, "주간 요약 부탁해요", 300),
  msg(DM_DAWN, 4, dawnId, "정리해서 #workbench에 올려 뒀어요.", 290),
];
const rootMine = msg(WB, 3, memberId, "배포 일정 언제쯤 확정될까요?", 200, {
  thread: { reply_count: 2, last_reply_seq: 9, last_reply_at: NOW - 6 * MIN },
});
const mentionWb = msg(WB, 8, otherId, `@seongjae 배포 전에 한번 봐 주세요. 체크리스트 링크 남겼어요.`, 25, {
  props: { mention_member_ids: [memberId] },
});
const wbPage = [rootMine, msg(WB, 6, agentId, "빌드 통과했습니다.", 60), mentionWb];
const replies = [
  msg(WB, 7, otherId, "다음 주 화요일 예정이에요", 30, { rootId: rootMine.id }),
  msg(WB, 9, agentId, "QA 확인 끝나면 바로 공유드릴게요.", 6, { rootId: rootMine.id }),
];
const mentionDesign = msg(DESIGN, 4, dawnId, "@seongjae 시안 3번 컬러 토큰 확인 부탁드려요", 45, {
  props: { mention_member_ids: [memberId] },
});
const pendingApproval = {
  id: "ap-1", workspace_id: workspaceId, run_id: "run-1", channel_id: WB, requested_by: agentId,
  action_type: "tool_call", status: "pending", expires_at_ms: NOW + 40 * MIN, created_at_ms: NOW - 3 * MIN,
  payload: { tool_call: { name: "work.session.end" } },
};

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

// 서버처럼 커서는 앞으로만 가고 latest에서 멈춘다(`max(current, min(requested, latest))`).
// 멘션 수는 「커서 뒤의 멘션」이라 커서가 그 seq를 지나면 0이 된다.
function readStates(empty, cursors) {
  const rows = [
    { channel_id: WB, last_read_seq: 4, latest_seq: 9, mention_seq: 8 },
    { channel_id: DESIGN, last_read_seq: 2, latest_seq: 4, mention_seq: 4 },
    { channel_id: DM_SEO, last_read_seq: 6, latest_seq: 8, mention_seq: null },
    { channel_id: DM_DAWN, last_read_seq: 4, latest_seq: 4, mention_seq: null },
  ];
  return rows.map((row) => {
    const last = empty ? row.latest_seq : Math.max(row.last_read_seq, cursors[row.channel_id] ?? 0);
    return {
      channel_id: row.channel_id, last_read_seq: last, latest_seq: row.latest_seq,
      unread_count: row.latest_seq - last,
      mention_count: row.mention_seq !== null && row.mention_seq > last ? 1 : 0,
      marked_unread_before_seq: null,
    };
  });
}

async function installRoutes(context, empty) {
  const cursors = {};
  await context.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId });
    }
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/read-state") && method === "GET") return json(route, { read_states: readStates(empty, cursors) });
    if (/\/channels\/[^/]+\/read-state$/.test(path) && method === "PUT") {
      const id = path.split("/channels/")[1].split("/")[0];
      const requested = JSON.parse(route.request().postData() ?? "{}").last_read_seq ?? 0;
      cursors[id] = Math.max(cursors[id] ?? 0, requested);
      return json(route, readStates(false, cursors).find((r) => r.channel_id === id));
    }
    if (path.endsWith("/approvals")) {
      const status = url.searchParams.get("status") ?? "pending";
      return json(route, { approvals: !empty && status === "pending" ? [pendingApproval] : [] });
    }
    if (path.endsWith("/agent-runs")) return json(route, { runs: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: [] });
    if (path.endsWith("/work-sessions/shared")) return json(route, { sessions: [], nextCursor: null });
    if (path.endsWith("/work-sessions")) return json(route, { workSessions: [] });
    if (path.endsWith("/reminders")) return json(route, { reminders: [] });
    if (path.endsWith(`/workspaces/${workspaceId}`)) return json(route, { workspace: { id: workspaceId, name: "여명거리" } });
    if (path.endsWith("/replies")) return json(route, { messages: replies });
    if (path.includes("/messages")) {
      if (empty) return json(route, { messages: [] });
      const after = url.searchParams.get("after");
      if (path.includes(DM_SEO)) return json(route, { messages: dmSeo });
      if (path.includes(DM_DAWN)) return json(route, { messages: dmDawn });
      if (path.includes(DESIGN)) return json(route, { messages: [mentionDesign] });
      if (path.includes(WB)) return json(route, { messages: after ? [mentionWb] : wbPage });
    }
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
          if (c.connect) return { id: c.id, connect: { client: "inbox-capture", version: "6" } };
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

async function open(browser, origin, scheme, viewport, empty) {
  const context = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion: "reduce", serviceWorkers: "block" });
  await installRoutes(context, empty);
  const page = await context.newPage();
  await installRealtime(page);
  await page.addInitScript((server) => { try { localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ } }, origin);
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("nav-team").waitFor({ timeout: 20_000 });
  await page.evaluate(() => { location.hash = "#/inbox"; });
  await page.getByTestId("inbox-route").waitFor();
  return { context, page };
}

async function scenes(browser, origin, scheme) {
  const viewport = { width: 1440, height: 900 };
  const tag = `${viewport.width}-${scheme}`;
  const { context, page } = await open(browser, origin, scheme, viewport, false);
  const shot = (name) => page.screenshot({ path: resolve(OUT_DIR, `${name}-${tag}.png`) });
  await page.getByTestId("mailbox-row").first().waitFor({ timeout: 15_000 });
  await page.waitForTimeout(600);
  await shot("list");
  const kinds = await page.locator("[data-testid='mailbox-row']").evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")));
  check(`${tag} 목록에 종류가 섞인다 (처리할 일·DM·스레드·멘션)`, ["task", "dm", "thread", "mention"].every((k) => kinds.includes(k)), JSON.stringify(kinds));
  check(`${tag} 처리할 일이 맨 앞`, kinds[0] === "task", JSON.stringify(kinds));
  check(`${tag} 읽은 DM(새벽봇)도 목록에 남는다`, (await page.locator("[data-kind='dm'][data-unread='false']").count()) === 1);
  check(`${tag} 가로 넘침 0`, (await overflowX(page)) === 0);

  // DM: 열면 맥락 + 답장 입력, 읽음 처리 요청이 나간다.
  const putRead = page.waitForRequest((r) => r.method() === "PUT" && r.url().includes(`/channels/${DM_SEO}/read-state`));
  await page.locator("[data-kind='dm'][data-unread='true']").first().click();
  await page.getByTestId("inbox-reply-input").waitFor();
  await putRead;
  check(`${tag} DM을 열면 그 채널 읽음 PUT이 나간다`, true);
  await page.waitForTimeout(500);
  await shot("dm");

  await page.locator("[data-kind='mention']").first().click();
  await page.getByTestId("inbox-context-row").first().waitFor();
  await page.waitForTimeout(400);
  await shot("mention");
  check(`${tag} 멘션: 그 메시지가 강조된다`, (await page.locator("[data-highlighted='true']").count()) === 1);

  await page.locator("[data-kind='thread']").first().click();
  await page.getByTestId("inbox-thread-root").waitFor();
  await page.waitForTimeout(400);
  await shot("thread");

  await page.locator("[data-kind='task']").first().click();
  await page.getByTestId("inbox-task").waitFor();
  await page.waitForTimeout(400);
  await shot("task");
  check(`${tag} 처리할 일: 승인/거부 컨트롤이 패널에 있다`, (await page.locator("[data-testid='inbox-detail'] button").count()) >= 2);

  await page.getByTestId("inbox-tab-dm").click();
  await page.waitForTimeout(300);
  await shot("filter-dm");
  const dmOnly = await page.locator("[data-testid='mailbox-row']").evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")));
  check(`${tag} DM 필터는 DM만 남긴다`, dmOnly.length >= 2 && dmOnly.every((k) => k === "dm"), JSON.stringify(dmOnly));
  await page.getByTestId("inbox-tab-unread").click();
  await page.waitForTimeout(300);
  await shot("filter-unread");
  check(`${tag} 가로 넘침 0 (패널 열린 상태)`, (await overflowX(page)) === 0);
  await context.close();

  const empty = await open(browser, origin, scheme, viewport, true);
  await empty.page.getByTestId("inbox-empty").waitFor({ timeout: 15_000 });
  await empty.page.waitForTimeout(400);
  await empty.page.screenshot({ path: resolve(OUT_DIR, `empty-${tag}.png`) });
  check(`${tag} 빈 상태는 장애가 아니라 조용함`, (await empty.page.getByTestId("inbox-error").count()) === 0);
  await empty.context.close();
}

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) throw new Error("dist/ is missing. Run npm run build first.");
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  try {
    for (const scheme of ["light", "dark"]) await scenes(browser, preview.origin, scheme);
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
