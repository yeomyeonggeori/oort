#!/usr/bin/env node
// =============================================================================
// #5165 · #5166 · #5174(L1~L6) 레인: 작업 패널을 닫을 때의 초점, 계획 독의 세션 전환·키보드 스크롤, 수·말씨.
//
//   npm run build && node scripts/capture-5165.mjs
//   DIST_DIR=<고치기 전 dist> node scripts/capture-5165.mjs        # 고치기 전 번들에서 RED 를 다시 볼 때
//   OUT_DIR=<dir> SHOTS=1 LABEL=after node scripts/capture-5165.mjs   # 캡처도 찍기(기본은 재기만)
//   ENGINE=webkit node scripts/capture-5165.mjs                      # 같은 흐름을 WebKit(WKWebView 의 엔진)으로
//   ONLY=390-light node scripts/capture-5165.mjs                      # 한 칸만(손으로 고칠 때). 쉼표로 여럿: 390-light,1280-dark
//
// 390 · 1280 × 밝음 · 어두움. 재는 것(단정은 구현 이름이 아니라 **화면에서 일어나는 일**을 잰다):
//   A  끝난 요청 요약 칩 → 작업 패널 → 닫기 단추 / Esc → 캐럿이 **그 칩**으로 돌아온다(#5165). 390 에서는 패널이 라우트를 덮고
//      셸이 라우트를 inert 로 둔다(양성 대조: 열려 있는 동안 inert 가 실제로 서 있다). 1280 은 같은 흐름이 원래 먹던 폭이다.
//   B  요약 칩(#5174 L6): 긴 영어 이름에서도 꼬리표 「에이전트 보고」가 칩 안에 온전히 남는다 · 눌림이 채움뿐이다(scale 없음).
//   C  작업 패널의 말씨(#5174 L1·L2): ms 단위·수 뒤 「번」 꼬리·「거절」이 없고, 건강 줄이 「거부된 승인」을 말한다.
//   D  계획 독(#5166·#5174 L3·L4): 팝오버를 연 채 세션을 바꿔도 독과 팝오버가 한 순간도 사라지지 않는다 · 단계 목록(50개)이
//      Tab 으로 닿고 PageDown 으로 스크롤된다 · 머리의 「N단계 중 M단계 완료」 · 남은 수가 옆 단추(멤버 수)와 같은 맨 숫자다.
//
// 백엔드는 없다: `/v1/**` 는 고정 응답이고 소켓은 구독만 받는다. 인물은 전부 가상이다(레포는 공개).
// 단언이 하나라도 실패하면 종료 코드 1(고치기 전 번들에서는 붉은 것이 정상: 그것이 「고치기 전 RED」다).
// =============================================================================
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "captures/5165");
const PORT = Number(process.env.CAPTURE_PORT || 5365);
const DIST_DIR = process.env.DIST_DIR || "";
const SHOTS = process.env.SHOTS === "1";
const LABEL = process.env.LABEL || "after";
const ENGINE = process.env.ENGINE === "webkit" ? webkit : chromium;
const ONLY = (process.env.ONLY || "").split(",").filter(Boolean);
const MIN = 60_000;

const workspaceId = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const SEO = "00000000-0000-7000-8000-000000000102";
const A1 = "00000000-0000-7000-8000-000000000301";
const CH = "00000000-0000-7000-8000-000000000201";
const DM = "00000000-0000-7000-8000-000000000203";
const RUN = "0199aa11-2222-7000-8000-0000000000b1";
const HOST = "0199aa11-7777-7000-8000-0000000000c1";
const S1 = "0199aa11-6666-7000-8000-0000000000a1";
const S2 = "0199aa11-6666-7000-8000-0000000000a2";
const ROOT1 = "0199aa11-6666-7000-8000-0000000000b1";
const ROOT2 = "0199aa11-6666-7000-8000-0000000000b2";
const mid = (n) => `00000000-0000-7000-8000-0000000a${String(n).padStart(4, "0")}`;
const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const person = (id, kind, displayName, handle, extra = {}) => ({
  id, workspaceId, kind, status: "active", displayName, handle, role: "member", channelCount: 2,
  channelIds: [CH, DM], capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...extra,
});
const rosterOf = (agentName) => [
  person(ME, "human", "이도현", "dohyun", { role: "owner" }),
  person(SEO, "human", "박서연", "seoyeon"),
  person(A1, "agent", agentName, "dalmuri-bot", { ownerHumanId: ME }),
];
const channels = [
  { id: CH, workspaceId, kind: "public", name: "디자인-리뷰", muted: false },
  { id: DM, workspaceId, kind: "dm", name: "", memberIds: [ME, A1], muted: false },
];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: ME, workspaceId, kind: "human", displayName: "이도현", handle: "dohyun" },
  realtimeWebSocketUrl: "ws://capture-5165.invalid/connection/websocket",
};

// ---- 끝난 요청(13분) · 원장 · 계획 ---------------------------------------------------------------

function runRow(now) {
  return {
    id: RUN, channelId: DM, agentMemberId: A1, triggerMessageId: mid(1), triggerSummary: "회의록 초안",
    status: "succeeded", phase: "succeeded", leaseState: "none", stepCount: 6, ahead: [],
    createdAtMs: now - 21 * MIN, updatedAtMs: now - 6 * MIN, claimedAtMs: now - 20 * MIN,
    startedAtMs: now - 19 * MIN, finishedAtMs: now - 6 * MIN, lastEventAtMs: now - 6 * MIN,
  };
}

/** 원장: 단계 6 · 명령 12 · oort 호출(12ms · 1.2초 · 반복 · 실패 뒤 재시도) · 거부된 승인 1 · 실패한 활동 1. */
function ledger(now) {
  const at = (n) => now - 19 * MIN + n * 1000;
  const tool = (n, name, code, durationMs) => ({ ordinal: n, kind: "tool_call", tool: name, code, durationMs, createdAtMs: at(n) });
  return {
    runId: RUN,
    events: [
      { ordinal: 1, kind: "queued", createdAtMs: now - 21 * MIN },
      ...Array.from({ length: 6 }, (_, i) => ({ ordinal: 2 + i, kind: "stage", stage: `${i + 1}번째 단계를 마쳤어요`, createdAtMs: at(2 + i) })),
      tool(10, "oort_job_start", "ok", 12),
      tool(11, "oort_run_event", "ok", 20),
      tool(12, "oort_run_event", "ok", 22),
      tool(13, "oort_run_event", "ok", 25),
      tool(14, "oort_job_renew", "conflict", 40),
      tool(15, "oort_job_renew", "ok", 1234),
      { ordinal: 16, kind: "approval_decided", code: "rejected", approvalId: "0199aa11-8888-7000-8000-0000000000d1", createdAtMs: at(16) },
      { ordinal: 17, kind: "activity", createdAtMs: at(17), activity: { id: "a1", kind: "run", status: "failed", n: 1, startedAtMs: at(17) } },
      { ordinal: 18, kind: "activity", createdAtMs: at(18), activity: { id: "a2", kind: "run", status: "completed", n: 11, startedAtMs: at(18) } },
    ],
    toolTally: [
      { tool: "oort_job_start", ok: 1, error: 0, durationMsSum: 12 },
      { tool: "oort_run_event", ok: 3, error: 0, durationMsSum: 67 },
      { tool: "oort_job_renew", ok: 1, error: 1, durationMsSum: 1274 },
    ],
    toolCallRowsCapped: false,
    activityTally: [{ kind: "run", completed: 11, failed: 1 }],
    activityRowsTrimmed: false,
  };
}

const planOf = (count, done) =>
  Array.from({ length: count }, (_, i) => ({ content: `계획 단계 ${i + 1}: 시안 정리와 확인`, status: i < done ? "completed" : i === done ? "in_progress" : "pending" }));

function planFrame(sessionId, rootId, plan, seq) {
  const at = Date.now() - 30 * MIN;
  return {
    id: `0199cccc-0000-7000-8000-00000000${String(seq).padStart(4, "0")}`, channelId: CH, hlcCount: 0, type: "text", state: "sent",
    authorMemberId: ME, body: "", seq, hlcTs: at, createdAtMs: at, rootId,
    props: {
      kind: "work_session_event", schema: "momo.work_session.acp_event.v1", event_type: "agent.status",
      event_id: `cap5165-event-${seq}`, event_ts: at, event: { work_session_id: sessionId, plan, has_plan: true, phase: "running" },
    },
  };
}

const session = (id, rootId, label, status, startedAtMs, extra = {}) => ({
  id, workspaceId, channelId: CH, memberId: ME, hostId: HOST, rootMessageId: rootId, tool: "claude", label, status,
  observation: "open", observerGrantCount: 0, remoteAttachAvailable: false, remoteDisplayAvailable: false, startedAtMs, ...extra,
});

/** S2 의 스레드 읽기를 붙잡는 시간. 이 동안 키가 바뀐 독의 `data` 가 없다(캐시된 스레드로는 재현되지 않는다). */
const S2_DELAY_MS = 1600;

async function installMocks(context, scene) {
  const now = Date.now();
  await context.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: now + 600_000, ttlSeconds: 60, workspaceId, memberId: ME });
    if (/\/inbox(\/|$)/.test(path)) return json(route, { error: { code: "not_found", message: "not found" } }, 404);
    if (path.endsWith("/read-state")) return json(route, { read_states: channels.map((c) => ({ channel_id: c.id, last_read_seq: 999, latest_seq: 999, unread_count: 0, mention_count: 0, marked_unread_before_seq: null })) });
    if (path.endsWith("/members/me/sidebar-prefs")) return json(route, { prefs: { version: 1, sections: [], starredChannelIds: [] } });
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) return json(route, { members: rosterOf(scene.agentName) });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/approvals")) return json(route, { approvals: [] });
    if (path.endsWith("/reminders")) return json(route, { reminders: [] });
    if (path.endsWith("/pins")) return json(route, { pins: [] });
    if (path.endsWith("/reactions")) return json(route, {});
    if (path.endsWith(`/channels/${DM}/agent-runs/progress`)) return json(route, { runs: [runRow(now)] });
    if (path.endsWith("/agent-runs/progress")) return json(route, { runs: [] });
    if (path.endsWith(`/agent-runs/${RUN}/events`)) return json(route, ledger(now));
    if (path.endsWith("/agent-runs")) return json(route, { runs: [] });
    if (path.endsWith(`/agents/${A1}/liveness`)) return json(route, { agentMemberId: A1, state: "responsive", lastSignalAtMs: now });
    if (path.endsWith("/work-hosts")) {
      return json(route, { workHosts: [{ id: HOST, workspaceId, scope: "workspace", ownerMemberId: ME, type: "mac", displayName: "capture-host", capabilities: {}, createdAtMs: 0, online: true, lastSeenAtMs: now }] });
    }
    if (path.endsWith("/work-sessions/shared")) return json(route, { sessions: [], nextCursor: null });
    if (path.endsWith("/work-sessions")) {
      return json(route, { workSessions: [
        session(S1, ROOT1, "독 시안 정리", "running", now - 40 * MIN),
        session(S2, ROOT2, "캡처 하네스", "ended", now - 90 * MIN, { endedAtMs: now - 60 * MIN }),
      ] });
    }
    if (path.endsWith(`/messages/${ROOT1}/replies`)) return json(route, { messages: [planFrame(S1, ROOT1, planOf(4, 2), 2)] });
    if (path.endsWith(`/messages/${ROOT2}/replies`)) {
      await new Promise((done) => setTimeout(done, S2_DELAY_MS));
      return json(route, { messages: [planFrame(S2, ROOT2, planOf(50, 20), 3)] });
    }
    if (path.endsWith("/replies")) return json(route, { messages: [] });
    if (path.includes(`/channels/${DM}/messages`)) {
      return json(route, { messages: [
        { id: mid(1), channelId: DM, seq: 10, hlcTs: now - 21 * MIN, hlcCount: 0, authorMemberId: ME, type: "text", body: "회의록 초안 부탁해요", state: "sent", createdAtMs: now - 21 * MIN },
        { id: mid(2), channelId: DM, seq: 11, hlcTs: now - 6 * MIN, hlcCount: 0, authorMemberId: A1, type: "text", body: "정리했어요. 핵심은 세 가지예요.", state: "sent", createdAtMs: now - 6 * MIN, replyToId: mid(1) },
      ] });
    }
    if (path.includes(`/channels/${CH}/messages`)) {
      return json(route, { messages: [
        { id: mid(5), channelId: CH, seq: 20, hlcTs: now - 50 * MIN, hlcCount: 0, authorMemberId: SEO, type: "text", body: "시안 두 장 올렸어요. 여백만 한 번 더 봐 주세요.", state: "sent", createdAtMs: now - 50 * MIN },
      ] });
    }
    if (path.endsWith(`/workspaces/${workspaceId}`)) return json(route, { workspace: { id: workspaceId, name: "달무리 스튜디오" } });
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
          if (c.connect) return { id: c.id, connect: { client: "capture-5165", version: "6" } };
          if (c.subscribe) return { id: c.id, subscribe: { recoverable: false, positioned: false, recovered: false, epoch: "cap", offset: 0 } };
          return { id: c.id };
        });
        queueMicrotask(() => this.onmessage?.(new MessageEvent("message", { data: replies.map((r) => JSON.stringify(r)).join("\n") })));
      }
      close() { this.readyState = 3; this.onclose?.(new CloseEvent("close", { code: 1000 })); }
    }
    window.WebSocket = CaptureSocket;
  });
}

// ---- 결과 장부 ---------------------------------------------------------------------------------

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  (${detail})`}`);
}

async function open(origin, scheme, viewport, scene = {}) {
  const browser = await ENGINE.launch();
  // 문구는 한국어 사전으로 읽는다: 기기 언어를 ko-KR 로 고정한다(헤드리스 기본은 en-US).
  const context = await browser.newContext({ viewport, colorScheme: scheme, serviceWorkers: "block", reducedMotion: "reduce", locale: "ko-KR", timezoneId: "Asia/Seoul" });
  await installMocks(context, { agentName: "달무리봇", ...scene });
  await context.addInitScript((server) => { try { localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ } }, origin);
  const page = await context.newPage();
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  page.setDefaultTimeout(10_000);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-item").first().waitFor({ state: "attached", timeout: 20_000 });
  return { browser, context, page };
}

async function go(page, channelId, readyTestId) {
  await page.evaluate((h) => { location.hash = h; }, `/c/${channelId}`);
  await page.getByTestId(readyTestId).first().waitFor({ timeout: 20_000 });
  await page.mouse.move(2, 2);
  await page.waitForTimeout(700);
}

async function shot(page, scene, tag) {
  if (!SHOTS) return;
  mkdirSync(OUT_DIR, { recursive: true });
  await page.screenshot({ path: resolve(OUT_DIR, `${LABEL}-${scene}-${tag}.png`) });
}

/** 지금 캐럿이 어디 있는가: testid 와 (칩이면) 그 칩이 속한 run. */
const caret = (page) => page.evaluate(() => {
  const el = document.activeElement;
  const slot = el?.closest?.('[data-testid="request-thought-slot"]');
  return { testid: el?.getAttribute?.("data-testid") ?? null, tag: el?.tagName ?? null, run: slot?.getAttribute("data-run-id") ?? null };
});

// ---- A·B·C: 끝난 요청 요약 칩과 작업 패널 -------------------------------------------------------

async function runChipScenes(origin, scheme, width, height) {
  const tag = `${width}-${scheme}`;
  for (const agentName of ["달무리봇", "Frontend Review Assistant (Claude Code)"]) {
    const long = agentName !== "달무리봇";
    const name = `${tag}${long ? " 긴 영어 이름" : ""}`;
    const { browser, context, page } = await open(origin, scheme, { width, height }, { agentName });
    try {
      console.log(`--- 요약 칩 ${name}`);
      await go(page, DM, "request-thought-line");
      const chip = page.getByTestId("request-thought-line").first();
      await shot(page, long ? "chip-long" : "chip", tag);

      if (long) {
        // B. 긴 영어 이름: 몸이 줄임표를 받아도 꼬리표 「에이전트 보고」는 칩 안에 온전히 남는다.
        const geo = await page.evaluate(() => {
          const chipEl = document.querySelector('[data-testid="request-thought-line"]');
          const tail = document.querySelector('[data-testid="request-thought-tail"]');
          if (!chipEl) return null;
          const c = chipEl.getBoundingClientRect();
          const body = tail?.previousElementSibling;
          const t = tail?.getBoundingClientRect();
          return {
            hasTail: Boolean(tail), tailText: tail?.textContent?.trim() ?? null,
            tailInside: t ? t.left >= c.left - 0.5 && t.right <= c.right + 0.5 && t.right <= window.innerWidth + 0.5 : false,
            tailClipped: tail ? tail.scrollWidth > tail.clientWidth + 0.5 : null,
            bodyTruncated: body ? body.scrollWidth > body.clientWidth + 0.5 : null,
            chipRight: Math.round(c.right), column: window.innerWidth,
          };
        });
        check(`${name}: 꼬리표 「에이전트 보고」가 몸과 따로 선다`, geo?.hasTail === true && geo.tailText === "· 에이전트 보고", JSON.stringify(geo));
        check(`${name}: 꼬리표가 칩 안에 온전히 남는다(잘리지 않는다)`, geo?.tailInside === true && geo.tailClipped === false, JSON.stringify(geo));
        if (width <= 480) check(`${name}: 양성 대조 - 좁은 폭에서 몸은 실제로 줄임표를 받는다`, geo?.bodyTruncated === true, JSON.stringify(geo));
      } else {
        // B. 눌림: 칩 위에서 포인터를 누른 동안 scale 이 없다(채움만). 클릭이 되지 않게 칩 밖에서 놓는다.
        const box = await chip.boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        const pressed = await chip.evaluate((el) => ({ transform: getComputedStyle(el).transform, background: getComputedStyle(el).backgroundColor }));
        await page.mouse.move(2, 2);
        await page.mouse.up();
        check(`${name}: 눌림은 채움뿐이다(scale 축소 없음)`, pressed.transform === "none", JSON.stringify(pressed));
        await page.waitForTimeout(200);

        // A. 연다 → 닫기 단추로 닫는다 → 캐럿은 그 칩이다. Esc 도 같다.
        for (const how of ["닫기 단추", "Esc"]) {
          await chip.click();
          await page.getByTestId("agent-work-panel").waitFor({ timeout: 10_000 });
          await page.waitForTimeout(400);
          const inertWhileOpen = await page.evaluate(() => document.getElementById("app-route")?.hasAttribute("inert") ?? null);
          check(`${name} ${how}: 양성 대조 - 패널이 열린 동안 라우트 inert 는 ${width < 900 ? "서 있다" : "없다"}`, inertWhileOpen === (width < 900), String(inertWhileOpen));
          if (how === "닫기 단추") {
            if (SHOTS) { await page.waitForTimeout(500); await shot(page, "panel", tag); }
            // C. 패널의 말씨(#5174 L1·L2): 한 번 읽는다.
            await panelWording(page, name);
            await page.getByTestId("agent-work-panel-close").click();
          } else {
            await page.keyboard.press("Escape");
          }
          await page.getByTestId("agent-work-panel").waitFor({ state: "detached", timeout: 10_000 });
          const where = await caret(page);
          check(`${name} ${how}: 닫으면 캐럿이 연 요약 칩으로 돌아온다`, where.testid === "request-thought-line" && where.run?.toLowerCase() === RUN, JSON.stringify(where));
          const inertAfter = await page.evaluate(() => document.getElementById("app-route")?.hasAttribute("inert") ?? null);
          check(`${name} ${how}: 닫은 뒤 라우트의 inert 는 없다`, inertAfter === false, String(inertAfter));
          await page.mouse.move(2, 2);
          await page.waitForTimeout(250);
        }
      }
    } finally {
      await context.close();
      await browser.close();
    }
  }
}

async function panelWording(page, name) {
  const read = await page.evaluate(() => {
    const text = (id) => (document.querySelector(`[data-testid="${id}"]`)?.textContent ?? "").replace(/\s+/g, " ").trim();
    const panel = document.querySelector('[data-testid="agent-work-panel"]');
    return {
      all: (panel?.textContent ?? "").replace(/\s+/g, " "),
      health: text("agent-work-panel-health"),
      repeats: [...document.querySelectorAll('[data-testid="work-timeline-repeat"]')].map((el) => (el.textContent ?? "").trim()),
      durations: [...document.querySelectorAll('[data-testid="work-timeline-duration"]')].map((el) => (el.textContent ?? "").trim()),
    };
  });
  check(`${name}: 작업 패널에 「ms」 단위가 없다(시간은 초·분 한 틀)`, !/\d\s*ms\b/.test(read.all) && read.durations.some((d) => d === "0.1초 미만"), JSON.stringify(read.durations));
  check(`${name}: 반복 수는 맨 숫자다(「N번」 꼬리 없음)`, read.repeats.length > 0 && read.repeats.every((r) => /^\d+$/.test(r)), JSON.stringify(read.repeats));
  check(`${name}: 건강 줄은 「거부된 승인」이고 「거절」·「번」 꼬리가 없다`, read.health === "실패한 활동 1 · 거부된 승인 1 · oort 호출 재시도 1" && !/거절/.test(read.all), read.health);
  check(`${name}: 도구 호출 합계에도 「번」 꼬리가 없다`, !/도구 호출 \d+번/.test(read.all), read.all.match(/도구 호출[^·]*/)?.[0] ?? "");
}

// ---- D: 계획 독 ---------------------------------------------------------------------------------

async function planDockScenes(origin, scheme, width, height) {
  const tag = `${width}-${scheme}`;
  const name = `${tag} 계획 독`;
  const { browser, context, page } = await open(origin, scheme, { width, height });
  try {
    console.log(`--- ${name}`);
    await go(page, CH, "work-plan-dock");
    const dock = page.getByTestId("work-plan-dock");

    // L4: 남은 수는 옆 단추(멤버 수)와 같은 맨 숫자다: 둥근 면 · 배경이 없다.
    const grammar = await page.evaluate(() => {
      const style = (el) => { const s = getComputedStyle(el); return { radius: s.borderRadius, bg: s.backgroundColor, size: s.fontSize, pad: s.paddingLeft }; };
      const plan = document.querySelector('[data-testid="work-plan-remaining"]');
      const members = document.querySelector('[data-testid="channel-member-count"] [data-numeric]');
      return { plan: plan ? style(plan) : null, members: members ? style(members) : null };
    });
    check(`${name}: 남은 수가 옆 단추(멤버 수)와 같은 문법의 맨 숫자다`,
      grammar.plan !== null && grammar.members !== null && JSON.stringify(grammar.plan) === JSON.stringify(grammar.members), JSON.stringify(grammar));
    await shot(page, "dock", tag);

    // L3: 열면 머리가 「완료」까지 말한다.
    await dock.click();
    await page.getByTestId("work-plan-popover").waitFor();
    const title = (await page.getByTestId("work-plan-title").textContent())?.trim();
    check(`${name}: 머리가 「4단계 중 2단계 완료」다`, title === "계획 · 4단계 중 2단계 완료", String(title));
    await shot(page, "popover", tag);

    // #5166: 세션을 바꾸는 동안 독과 팝오버는 한 순간도 사라지지 않는다.
    await page.getByTestId("work-plan-session-select").selectOption(S2);
    const startedAt = Date.now();
    const missing = [];
    let seenBusy = false;
    while (Date.now() - startedAt < S2_DELAY_MS - 250) {
      const sample = await page.evaluate(() => ({
        dock: Boolean(document.querySelector('[data-testid="work-plan-dock"]')),
        popover: Boolean(document.querySelector('[data-testid="work-plan-popover"]')),
        busy: document.querySelector('[data-testid="work-plan-steps"]')?.getAttribute("aria-busy") === "true",
      }));
      if (!sample.dock || !sample.popover) missing.push({ ms: Date.now() - startedAt, ...sample });
      seenBusy ||= sample.busy;
      await page.waitForTimeout(40);
    }
    check(`${name}: 새 세션을 읽는 동안 독과 팝오버가 사라진 순간이 없다`, missing.length === 0, JSON.stringify(missing.slice(0, 2)));
    check(`${name}: 읽는 동안 목록이 읽는 중임을 알린다(aria-busy)`, seenBusy);
    await shot(page, "switching", tag);
    await page.waitForFunction(() => document.querySelector('[data-testid="work-plan-title"]')?.textContent?.includes("50단계"), null, { timeout: 8_000 }).catch(() => {});
    const after = (await page.getByTestId("work-plan-title").textContent().catch(() => null))?.trim() ?? null;
    check(`${name}: 팝오버가 열린 채 새 내용(50단계 중 20단계 완료)으로 바뀐다`, after === "계획 · 50단계 중 20단계 완료" && (await page.getByTestId("work-plan-popover").count()) === 1, String(after));

    // 50개 목록은 키보드로 닿고 스크롤된다.
    const list = page.getByTestId("work-plan-steps");
    if ((await list.count()) === 0) {
      // 독이 사라졌다(고치기 전 번들): 아래 단정은 닿을 곳이 없다. 기다리다 멈추지 말고 붉게 적고 다음 칸으로 간다.
      check(`${name}: 단계 목록이 남아 있다(독이 사라지지 않았다)`, false, "work-plan-steps 없음");
      return;
    }
    check(`${name}: 단계 목록이 초점을 받는 스크롤 영역이다(tabindex 0 · 이름 있음)`,
      (await list.getAttribute("tabindex")) === "0" && Boolean(await list.getAttribute("aria-labelledby")), String(await list.getAttribute("tabindex")));
    const scrolls = await list.evaluate((el) => el.scrollHeight > el.clientHeight + 1);
    check(`${name}: 양성 대조 - 50개 목록은 실제로 넘친다`, scrolls);
    await page.getByTestId("work-plan-session-select").focus();
    await page.keyboard.press("Tab");
    const onList = await caret(page);
    check(`${name}: 선택 상자에서 Tab 한 번에 목록이 초점을 받는다`, onList.testid === "work-plan-steps", JSON.stringify(onList));
    await page.keyboard.press("PageDown");
    await page.waitForTimeout(250);
    const top = await list.evaluate((el) => el.scrollTop);
    check(`${name}: PageDown 으로 목록이 스크롤된다`, top > 0, `scrollTop=${top}`);
    await shot(page, "list-scrolled", tag);
  } finally {
    await context.close();
    await browser.close();
  }
}

async function main() {
  const preview = await startGuardedPreview({
    webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT",
    ...(DIST_DIR ? { extraArgs: ["--outDir", resolve(DIST_DIR)] } : {}),
  });
  try {
    for (const scheme of ["light", "dark"]) {
      for (const [width, height] of [[390, 844], [1280, 900]]) {
        if (ONLY.length > 0 && !ONLY.includes(`${width}-${scheme}`)) continue;
        await runChipScenes(preview.origin, scheme, width, height);
        await planDockScenes(preview.origin, scheme, width, height);
      }
    }
  } finally {
    await preview.stop?.();
  }
  const bad = results.filter((r) => !r.ok);
  console.log(bad.length === 0
    ? `FOCUS-DOCK-5165 PASS (${results.length} checks)`
    : `FOCUS-DOCK-5165 FAIL (${bad.length}/${results.length}): ${bad.map((r) => r.name).join(" | ")}`);
  process.exit(bad.length === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
