#!/usr/bin/env node
// =============================================================================
// #4285 캡처: 아무도 가져가지 않은 사람 요청 — 사이드바 「작업 중」 카드·대화 아래 활동 줄·작업 패널의 「취소」.
//
//   uncollected        5분을 넘은 요청: 카드 「아직 받지 않았어요」 + 짧은 경고 문구 + 이유 줄, 활동 줄, 작업 패널의 「취소」
//   confirm            패널의 「취소」를 누른 확인 줄
//   cancelled          확정 뒤 영수증(컨트롤은 사라진다)
//   failed             서버가 500 — 「취소하지 못했어요」(컨트롤은 남는다)
//   young              2분 된 요청 — 「대기 1번째」 그대로, 이유 줄 없음
//   system             환영 작업뿐(서버가 5시간 기다렸다고 해도) — 카드가 없다
//   longname           7~9음절 한영 섞인 이름 — 상태 낱말은 한 줄로 온전하고 이름이 줄임표를 받는다(design-review r1 H3)
//   tworuns            같은 에이전트·같은 대화의 요청이 둘 — 패널의 머리 칩과 run 목록 칩이 같은 낱말(r1 H5)
//
// #4619로 갱신: 대화 아래의 「활동 줄」(composer-working 꼬리·경고·이유)은 없어졌다. 아무도 가져가지 않은 요청은 입력창 레일에서 빠지고
// 메시지 아래 **예외 줄**(run-exception)이 말한다(낱말 「아직 받지 않았어요」는 카드·패널·줄·칩이 한 상수). 작업 패널은 그 줄의 글을 눌러 연다.
//
// 라이트·다크 × 1440×900. 백엔드는 없다: `/v1/**`는 고정 응답이고 소켓은 구독만 받는다. 이름은 가상 인물
// (이도현·박서연·달무리봇, 달무리 스튜디오)이다. 사이드바에는 시계가 없으므로 경과 시간은 카드가 아니라
// 활동 줄이 말한다.
//
//   npm run build && OUT_DIR=<dir> node scripts/capture-4285.mjs
// =============================================================================

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR
  ? resolve(process.env.OUT_DIR)
  : resolve(WEB_ROOT, "artifacts/uncollected-4285");
const PORT = Number(process.env.CAPTURE_PORT || 5295);
const MIN = 60_000;
const HOUR = 60 * MIN;

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const seoyeonId = "00000000-0000-7000-8000-000000000102";
const agentId = "00000000-0000-7000-8000-000000000301";
const CH = "00000000-0000-7000-8000-000000000201";
const STUDIO = "00000000-0000-7000-8000-000000000202";
const RUN = "0199aa11-2222-7000-8000-0000000000b1";
const RUN2 = "0199aa11-2222-7000-8000-0000000000b2";
const MSG = "00000000-0000-7000-8000-0000000a0001";
const MSG2 = "00000000-0000-7000-8000-0000000a0002";

const person = (id, kind, displayName, handle, extra = {}) => ({
  id, workspaceId, kind, status: "active", displayName, handle, channelCount: 2,
  channelIds: [CH, STUDIO], capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...extra,
});
const rosterFor = (agentName) => [
  person(memberId, "human", "이도현", "dohyun", { role: "owner" }),
  person(seoyeonId, "human", "박서연", "seoyeon"),
  person(agentId, "agent", agentName, "dalmuri", { ownerHumanId: memberId }),
];
const channels = [
  { id: CH, workspaceId, kind: "public", name: "general", muted: false },
  { id: STUDIO, workspaceId, kind: "public", name: "스튜디오", muted: false },
];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "이도현", handle: "dohyun" },
  realtimeWebSocketUrl: "ws://uncollected-capture.invalid/connection/websocket",
};

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/**
 * scene.waitedMs   서버가 말한 대기 시간
 * scene.system     환영 작업(트리거 메시지도 제목도 없다)
 * scene.cancel     취소 POST 의 답: 200 | 500
 * scene.agentName  에이전트의 표시 이름(기본 「달무리봇」)
 * scene.secondRun  같은 에이전트·같은 대화의 둘째 요청(2분 된 요청, 대기 2번째)을 더한다
 */
async function installRoutes(context, scene) {
  const roster = rosterFor(scene.agentName ?? "달무리봇");
  const now = Date.now();
  const createdAtMs = now - scene.waitedMs;
  const runRow = {
    id: RUN, channelId: CH, agentMemberId: agentId,
    ...(scene.system ? {} : { triggerMessageId: MSG, triggerSummary: "이번 주 일정 정리해 줄래요" }),
    status: "queued", phase: "queued", leaseState: "none", stepCount: 0,
    queuePosition: 1, aheadTotal: 0, ahead: [], createdAtMs, updatedAtMs: createdAtMs,
  };
  const secondAtMs = now - 2 * MIN;
  const secondRow = scene.secondRun
    ? {
        id: RUN2, channelId: CH, agentMemberId: agentId,
        triggerMessageId: MSG2, triggerSummary: "다음 주 회의록 만들어 줄래요",
        status: "queued", phase: "queued", leaseState: "none", stepCount: 0,
        queuePosition: 2, aheadTotal: 1, ahead: [{ runId: RUN, channelId: CH }],
        createdAtMs: secondAtMs, updatedAtMs: secondAtMs,
      }
    : null;
  const messageRows = [
    {
      id: MSG, channelId: CH, seq: 10, hlcTs: createdAtMs, hlcCount: 0, authorMemberId: memberId,
      type: "text", body: "@dalmuri 이번 주 일정 정리해 줄래요", state: "sent", createdAtMs,
    },
    ...(secondRow
      ? [{
          id: MSG2, channelId: CH, seq: 11, hlcTs: secondAtMs, hlcCount: 0, authorMemberId: memberId,
          type: "text", body: "@dalmuri 다음 주 회의록 만들어 줄래요", state: "sent", createdAtMs: secondAtMs,
        }]
      : []),
  ];
  const ledger = {
    runId: RUN,
    events: [
      { ordinal: 1, kind: "queued", createdAtMs },
      { ordinal: 2, kind: "doorbell_rung", code: "leading_ok", createdAtMs: createdAtMs + 1000 },
      { ordinal: 3, kind: "doorbell_rung", code: "trailing_ok", createdAtMs: createdAtMs + 6000 },
    ],
  };
  await context.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId });
    }
    if (/\/inbox(\/|$)/.test(path)) return json(route, { error: { code: "not_found", message: "not found" } }, 404);
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/read-state") && method === "GET") {
      return json(route, { read_states: channels.map((c) => ({ channel_id: c.id, last_read_seq: 99, latest_seq: 99, unread_count: 0, mention_count: 0, marked_unread_before_seq: null })) });
    }
    if (path.endsWith("/approvals")) return json(route, { approvals: [] });
    if (path.endsWith(`/channels/${CH}/agent-runs/progress`)) return json(route, { runs: secondRow ? [runRow, secondRow] : [runRow] });
    if (path.endsWith("/agent-runs/progress")) return json(route, { runs: [] });
    if (path.endsWith(`/agents/${agentId}/liveness`)) {
      return json(route, { agentMemberId: agentId, state: "woken_not_collected", lastSignalAtMs: now - 3 * HOUR });
    }
    if (path.endsWith(`/agent-runs/${RUN}/events`)) return json(route, ledger);
    if (path.endsWith(`/agent-runs/${RUN2}/events`)) {
      return json(route, { runId: RUN2, events: [{ ordinal: 1, kind: "queued", createdAtMs: secondAtMs }] });
    }
    if (path.endsWith(`/agent-runs/${RUN}/cancel`) && method === "POST") {
      cancelRequests.push(path);
      if (scene.cancel === 500) return json(route, { error: { code: "internal", message: "boom" } }, 500);
      return json(route, { runId: RUN, status: "cancelled", linkedWorkSessionIds: [], workSessionsTerminated: false });
    }
    if (path.endsWith("/agent-runs")) return json(route, { runs: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: [] });
    if (path.endsWith("/work-sessions/shared")) return json(route, { sessions: [], nextCursor: null });
    if (path.endsWith("/work-sessions")) return json(route, { workSessions: [] });
    if (path.endsWith("/reminders")) return json(route, { reminders: [] });
    if (path.endsWith(`/workspaces/${workspaceId}`)) return json(route, { workspace: { id: workspaceId, name: "달무리 스튜디오" } });
    if (path.includes(`/channels/${CH}/messages`)) return json(route, { messages: messageRows });
    if (path.includes("/messages")) return json(route, { messages: [] });
    return json(route, {});
  });
}
const cancelRequests = [];

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
          if (c.connect) return { id: c.id, connect: { client: "uncollected-capture", version: "6" } };
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

async function open(browser, origin, scheme, scene) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 }, colorScheme: scheme, reducedMotion: "reduce", serviceWorkers: "block",
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
  await page.waitForTimeout(1500);
  await page.evaluate((h) => { location.hash = h; }, `/c/${CH}`);
  return { context, page };
}

const text = async (page, id) => ((await page.getByTestId(id).first().textContent()) ?? "").replace(/\s+/g, " ").trim();
/** 작업 패널 안으로 좁힌다: 예외 줄의 인라인 「취소」도 같은 testid(`agent-work-panel-stop-*`)를 쓰므로 패널을 열면 둘이 함께 있다. */
const panel = (page) => page.getByTestId("agent-work-panel");

async function scenes(browser, origin, scheme) {
  const tag = `1440-${scheme}`;
  const shot = (name) => resolve(OUT_DIR, `${name}-${tag}.png`);

  // ---- 5시간 넘게 가져가지 않은 요청 ------------------------------------------------
  {
    const { context, page } = await open(browser, origin, scheme, { waitedMs: 17 * HOUR, cancel: 200 });
    await page.getByTestId("sidebar-now-card").waitFor({ timeout: 15_000 });
    await page.getByTestId("sidebar-now-reason").waitFor({ timeout: 15_000 });
    await page.getByTestId("run-exception").waitFor({ timeout: 15_000 });
    await page.waitForTimeout(600);
    const card = await text(page, "sidebar-now-card");
    check(`${tag} uncollected: 카드 낱말`, card.includes("아직 받지 않았어요") && !card.includes("대기 1번째"), card);
    check(`${tag} uncollected: 장소 줄에 짧은 경고 문구`, (await text(page, "sidebar-now-line")).includes("안 가져감"), await text(page, "sidebar-now-line"));
    check(`${tag} uncollected: 이유 줄`, (await text(page, "sidebar-now-reason")) === "연결이 꺼져 있을 수 있어요");
    check(`${tag} uncollected: 카드 안에 취소가 없다(링크 안에 누르는 면을 두지 않는다)`, (await page.getByTestId("sidebar-now-card").locator("button").count()) === 0);
    // 메시지 아래 예외 줄: 같은 낱말 + 서버 판정에 근거가 있을 때만 이유. 경과(「17시간째」)는 말하지 않는다(초·분 단위 없음).
    const line = await text(page, "run-exception-text");
    check(`${tag} uncollected: 예외 줄 낱말·이유`, line === "달무리봇: 아직 받지 않았어요 · 연결이 꺼져 있을 수 있어요", line);
    check(`${tag} uncollected: 예외 줄에 경과 숫자가 없다`, !/\d+\s*(시간|분|초)/.test(line), line);
    check(`${tag} uncollected: 머리 칩도 같은 낱말`, (await text(page, "trigger-chip-word")) === "아직 받지 않았어요", await text(page, "trigger-chip-word"));
    check(`${tag} uncollected: 입력창 레일에서는 빠진다(줄이 두 군데서 말하지 않는다)`, (await page.getByTestId("composer-working-text").count()) === 0);
    await page.screenshot({ path: shot("uncollected") });

    // 작업 패널의 「취소」: 예외 줄의 글이 그 run의 작업 패널 입구다.
    await page.getByTestId("run-exception-open").click();
    await panel(page).getByTestId("agent-work-panel-stop-arm").waitFor({ timeout: 10_000 });
    const arm = panel(page).getByTestId("agent-work-panel-stop-arm");
    check(`${tag} panel: 첫 단추는 「취소」이고 이름은 요청 취소`, ((await arm.textContent()) ?? "").trim() === "취소" && (await arm.getAttribute("aria-label")) === "요청 취소, 확인 필요");
    check(`${tag} panel: 영역 이름도 요청 취소`, (await panel(page).getByTestId("agent-work-panel-stop").getAttribute("aria-label")) === "요청 취소");
    check(`${tag} panel: 상태 칩도 카드·활동 줄과 같은 낱말`, (await text(page, "agent-work-panel-state")) === "아직 받지 않았어요", await text(page, "agent-work-panel-state"));
    await page.waitForTimeout(500);
    await page.screenshot({ path: shot("panel") });

    check(`${tag} panel: 누르기 전에는 취소 요청이 0건`, cancelRequests.length === 0);
    await arm.click();
    await panel(page).getByTestId("agent-work-panel-stop-confirm").waitFor({ timeout: 5_000 });
    check(`${tag} confirm: 첫 클릭은 묻기만 한다`, cancelRequests.length === 0);
    check(`${tag} confirm: 확인 문장`, (await text(page, "agent-work-panel-stop-confirm")).includes("취소하면 이 요청은 여기서 끝나요. 같은 일은 다시 시킬 수 있어요."));
    await page.screenshot({ path: shot("confirm") });
    await panel(page).getByTestId("agent-work-panel-stop-commit").click();
    await panel(page).getByTestId("agent-work-panel-stop-outcome").waitFor({ timeout: 10_000 });
    check(`${tag} cancelled: 취소 요청 한 번`, cancelRequests.length === 1, String(cancelRequests.length));
    check(`${tag} cancelled: 영수증`, (await text(page, "agent-work-panel-stop-outcome")) === "달무리봇의 요청을 취소했어요.");
    check(`${tag} cancelled: 답을 받으면 취소 단추가 사라진다`, (await panel(page).getByTestId("agent-work-panel-stop-arm").count()) === 0 && (await panel(page).getByTestId("agent-work-panel-stop-commit").count()) === 0);
    await page.waitForTimeout(400);
    await page.screenshot({ path: shot("cancelled") });
    await context.close();
    cancelRequests.length = 0;
  }
  // ---- 서버가 500으로 답한다 --------------------------------------------------------
  {
    const { context, page } = await open(browser, origin, scheme, { waitedMs: 17 * HOUR, cancel: 500 });
    await page.getByTestId("run-exception-open").waitFor({ timeout: 15_000 });
    await page.getByTestId("run-exception-open").click();
    await panel(page).getByTestId("agent-work-panel-stop-arm").waitFor({ timeout: 10_000 });
    await panel(page).getByTestId("agent-work-panel-stop-arm").click();
    await panel(page).getByTestId("agent-work-panel-stop-commit").click();
    await panel(page).getByTestId("agent-work-panel-stop-outcome").waitFor({ timeout: 10_000 });
    const sentence = await text(page, "agent-work-panel-stop-outcome");
    check(`${tag} failed: 「취소하지 못했어요」이고 「중단」이 없다`, sentence === "취소하지 못했어요. 서버가 오류로 답했어요.", sentence);
    check(`${tag} failed: 확인 줄이 남아 다시 누를 수 있다`, (await panel(page).getByTestId("agent-work-panel-stop-commit").count()) === 1);
    await page.waitForTimeout(400);
    await page.screenshot({ path: shot("failed") });
    await context.close();
    cancelRequests.length = 0;
  }
  // ---- 2분 된 요청 ------------------------------------------------------------------
  {
    const { context, page } = await open(browser, origin, scheme, { waitedMs: 2 * MIN, cancel: 200 });
    await page.getByTestId("sidebar-now-card").waitFor({ timeout: 15_000 });
    await page.waitForTimeout(800);
    const card = await text(page, "sidebar-now-card");
    check(`${tag} young: 5분 안은 「대기 1번째」 그대로`, card.includes("대기 1번째") && !card.includes("아직 받지 않았어요"), card);
    check(`${tag} young: 이유 줄이 없다`, (await page.getByTestId("sidebar-now-reason").count()) === 0);
    await page.screenshot({ path: shot("young") });
    await context.close();
  }
  // ---- 환영 작업뿐 ------------------------------------------------------------------
  {
    const { context, page } = await open(browser, origin, scheme, { waitedMs: 5 * HOUR, system: true, cancel: 200 });
    await page.getByTestId("composer").waitFor({ timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(2500);
    check(`${tag} system: 서버가 5시간 기다렸다고 해도 카드가 없다`, (await page.getByTestId("sidebar-now-card").count()) === 0);
    await page.screenshot({ path: shot("system") });
    await context.close();
  }
  // ---- 7~9음절 한영 섞인 이름: 낱말은 한 줄로 온전하고 이름이 줄임표를 받는다 (design-review r1 H3) -----
  {
    const { context, page } = await open(browser, origin, scheme, {
      waitedMs: 17 * HOUR, cancel: 200, agentName: "프론트엔드 리뷰어 (Claude)",
    });
    await page.getByTestId("sidebar-now-card").waitFor({ timeout: 15_000 });
    await page.waitForTimeout(800);
    const state = page.getByTestId("sidebar-now-state");
    const stateBox = await state.boundingBox();
    const nameLoc = page.getByTestId("sidebar-now-card").locator(".sidebar-now-name");
    const nameBox = await nameLoc.boundingBox();
    const truncated = await nameLoc.evaluate((el) => el.scrollWidth > el.clientWidth);
    check(`${tag} longname: 상태 낱말이 온전하다`, (await text(page, "sidebar-now-state")) === "아직 받지 않았어요", await text(page, "sidebar-now-state"));
    check(`${tag} longname: 상태 낱말이 한 줄이다(「아직 받지 않았어 / 요」로 꺾이지 않는다)`, stateBox !== null && stateBox.height < 24, JSON.stringify(stateBox));
    check(`${tag} longname: 이름이 줄임표를 받는다(낱말을 밀어내지 않는다)`, truncated === true);
    check(`${tag} longname: 이름과 낱말이 겹치지 않는다`, nameBox !== null && stateBox !== null && nameBox.x + nameBox.width <= stateBox.x + 1, `${JSON.stringify(nameBox)} ${JSON.stringify(stateBox)}`);
    await page.screenshot({ path: shot("longname") });
    await context.close();
  }
  // ---- 같은 에이전트·같은 대화의 요청이 둘: 패널의 머리 칩과 목록 칩이 같은 낱말 (design-review r1 H5) -----
  {
    const { context, page } = await open(browser, origin, scheme, { waitedMs: 17 * HOUR, cancel: 200, secondRun: true });
    await page.getByTestId("run-exception-open").waitFor({ timeout: 15_000 });
    await page.getByTestId("run-exception-open").first().click();
    await page.getByTestId("agent-work-panel-runs").waitFor({ timeout: 10_000 });
    await page.waitForTimeout(600);
    const head = await text(page, "agent-work-panel-state");
    const rows = page.getByTestId("agent-work-panel-run");
    const count = await rows.count();
    const first = count > 0 ? ((await rows.nth(0).textContent()) ?? "") : "";
    const second = count > 1 ? ((await rows.nth(1).textContent()) ?? "") : "";
    check(`${tag} tworuns: 목록에 요청이 둘 선다`, count === 2, String(count));
    check(`${tag} tworuns: 머리 칩은 「아직 받지 않았어요」`, head === "아직 받지 않았어요", head);
    check(`${tag} tworuns: 목록의 첫 요청 칩도 같은 낱말이고 「대기 1번째」가 아니다`, first.includes("아직 받지 않았어요") && !first.includes("대기 1번째"), first);
    check(`${tag} tworuns: 5분 안의 둘째 요청은 「대기 2번째」 그대로다`, second.includes("대기 2번째") && !second.includes("아직 받지 않았어요"), second);
    await page.screenshot({ path: shot("tworuns") });
    await context.close();
  }
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
