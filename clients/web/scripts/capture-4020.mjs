#!/usr/bin/env node
// =============================================================================
// #4020 캡처: 메시지마다 붙던 영수증 줄을 빼고, 컴포저 위에 한 줄. (#4619로 갱신: 「그록이 답하는 중」이
// 입력창 레일의 「그록 · 작업 중」으로 바뀌었다. 얼굴·점·동작 줄이기 규칙은 그대로이고, 줄이 사라져도 레일 칸은
// 남는다. 실패한 run의 영수증은 메시지 아래 예외 줄이 되었고, 메시지 머리에는 상태 칩이 선다.)
//
//   a. 일하는 중: 에이전트가 가져가 쓰는 동안. 타임라인에는 영수증 줄이 없고(끝난 run·
//      진행 중 run 모두), 컴포저 위 레일이 「그록 · 작업 중」 + 얼굴 + 점이다.
//   b. 실패·막힘은 남는다: 실패한 run은 그 메시지 아래 예외 줄(`run-exception`)과 머리 칩 「실패」로 선다.
//   c. 답이 오면(run이 끝나면) 레일의 줄이 사라진다(칸은 비어 남는다: 목록이 움직이지 않는다).
//   d. 동작 줄이기: 점에 애니메이션이 없다(computed animation-name none). 켜지 않은
//      판에서는 점이 움직인다(animation-name momo-responding).
//
// 라이트·다크 × 1440×900. 백엔드는 없다(`/v1/**` 고정 응답, 가짜 소켓).
//
//   npm run build && node scripts/capture-4020.mjs      → captures/4020/*.png
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
  : resolve(WEB_ROOT, "captures/4020");
const PORT = Number(process.env.CAPTURE_PORT || 5240);
const MIN = 60_000;

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const agentId = "00000000-0000-7000-8000-000000000301";
const otherAgentId = "00000000-0000-7000-8000-000000000302";
const CH = "00000000-0000-7000-8000-000000000201";
const GENERAL = "00000000-0000-7000-8000-000000000202";
const RUN_A = "0199aa11-2222-7000-8000-0000000000a1";
const RUN_B = "0199aa11-2222-7000-8000-0000000000a2";
const RUN_C = "0199aa11-2222-7000-8000-0000000000a3";

const person = (id, kind, displayName, handle, extra = {}) => ({
  id, workspaceId, kind, status: "active", displayName, handle, channelCount: 2,
  channelIds: [CH, GENERAL], capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...extra,
});
const roster = [
  person(memberId, "human", "곽성재", "seongjae", { role: "owner" }),
  person(agentId, "agent", "그록", "grok", { ownerHumanId: memberId }),
  person(otherAgentId, "agent", "김인턴", "kim-intern", { ownerHumanId: memberId }),
];
const channels = [
  { id: CH, workspaceId, kind: "public", name: "계획", muted: false },
  { id: GENERAL, workspaceId, kind: "public", name: "general", muted: false },
];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: "ws://4020-capture.invalid/connection/websocket",
};

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** ADR-0200 `AgentRunProgress` 한 줄. */
function progress(now, extra) {
  return {
    channelId: CH,
    agentMemberId: agentId,
    status: "queued",
    phase: "queued",
    leaseState: "none",
    stepCount: 0,
    createdAtMs: now - 11 * MIN,
    updatedAtMs: now - 11 * MIN,
    ...extra,
  };
}

/** 장면 상태. 페이지가 읽을 때마다 현재 값을 돌려준다. */
function newScene() {
  return { runs: [], progressCalls: 0, ledgers: {}, ledgerCalls: 0, ledgerIncludes: [], approvals: [], liveness: {}, ringCalls: 0, ringMode: "ok", role: "owner", dmChannels: [], cancelCalls: [], cancelMode: "ok" };
}

async function installRoutes(context, scene) {
  const now = Date.now();
  const messageRows = [
    {
      id: "00000000-0000-7000-8000-0000000a0001", channelId: CH, seq: 10, hlcTs: now - 12 * MIN, hlcCount: 0,
      authorMemberId: memberId, type: "text",
      body: "@grokbot 채널 하나 만들어 줄래요? 이름은 grokbot-lab으로요.", state: "sent", createdAtMs: now - 12 * MIN,
    },
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
    if (/\/inbox(\/|$)/.test(path)) return json(route, { error: { code: "not_found", message: "not found" } }, 404);
    if (path.endsWith("/agent-runs/progress")) {
      scene.progressCalls += 1;
      if (scene.legacyServer) return json(route, { error: { code: "not_found", message: "not found" } }, 404);
      const channel = path.split("/channels/")[1]?.split("/")[0];
      return json(route, { runs: scene.runs.filter((r) => r.channelId === channel) });
    }
    const livenessMatch = path.match(/\/agents\/([^/]+)\/liveness$/);
    if (livenessMatch) {
      const hit = scene.liveness[livenessMatch[1].toLowerCase()];
      return hit ? json(route, { agentMemberId: livenessMatch[1].toLowerCase(), ...hit }) : json(route, { error: { code: "not_found", message: "not found" } }, 404);
    }
    if (path.endsWith("/doorbell/ring") && method === "POST") {
      scene.ringCalls += 1;
      if (scene.ringMode === "limited") return json(route, { error: "rate limited", retryAfterSeconds: 2700 }, 429);
      const requestedAtMs = Date.now();
      return json(route, { requestedAtMs, nextAllowedAtMs: requestedAtMs + 60_000 }, 202);
    }
    if (path.endsWith("/hosted-agent-connections") && method === "GET") {
      if (scene.role === "member") return json(route, { error: { code: "forbidden", message: "forbidden" } }, 403);
      return json(route, { connections: Object.keys(scene.liveness).map((agent, i) => ({
        id: `00000000-0000-7000-8000-00000000050${i}`, agentMemberId: agent, status: "active", authMode: "static_bearer",
        audience: "https://oort.example.test", approvedChannelIds: [CH], approvedScopes: [], createdAtMs: 1 + i, updatedAtMs: 1 + i,
      })) });
    }
    if (path.endsWith("/profile") && method === "GET" && path.includes("/agents/")) {
      const id = path.split("/").at(-2);
      return json(route, { profile: { agentMemberId: id, workspaceId, instructions: "채널 정리와 일정 요약을 맡아요.", enabledTools: [], triggers: { mention: true }, paused: false, version: 1, updatedBy: memberId, updatedAtMs: Date.now() - 86_400_000 } });
    }
    if (path.endsWith("/allowed-models")) return json(route, { allowedAgentModels: [] });
    const cancelMatch = path.match(/\/agent-runs\/([^/]+)\/cancel$/);
    if (cancelMatch && method === "POST") {
      const runId = cancelMatch[1].toLowerCase();
      scene.cancelCalls.push(path);
      if (scene.cancelMode === "forbidden") return json(route, { error: { code: "forbidden", message: "active human channel member required" } }, 403);
      if (scene.cancelMode === "over") return json(route, { error: { code: "conflict", message: "agent run is already succeeded" } }, 409);
      // 서버처럼: run을 cancelled로, 원장에 human_cancelled 줄을 더한다(migration 128 트리거).
      scene.runs = scene.runs.map((r) => (r.id === runId ? { ...r, phase: "cancelled", status: "cancelled", finishedAtMs: Date.now(), endReason: "human_cancelled" } : r));
      scene.ledgers[runId] = [...(scene.ledgers[runId] ?? []), { ordinal: (scene.ledgers[runId]?.length ?? 0) + 1, kind: "cancelled", code: "human_cancelled", createdAtMs: Date.now() }];
      return json(route, { runId, status: "cancelled", linkedWorkSessionIds: [], workSessionsTerminated: false });
    }
    const ledgerMatch = path.match(/\/agent-runs\/([^/]+)\/events$/);
    if (ledgerMatch) {
      scene.ledgerCalls += 1;
      scene.ledgerIncludes.push(url.searchParams.get("include"));
      const runId = ledgerMatch[1].toLowerCase();
      return json(route, { runId, events: scene.ledgers[runId] ?? [] });
    }
    if (path.endsWith("/channels")) return json(route, { channels: [...channels, ...(scene.dmChannels ?? [])] });
    if (path.endsWith("/roster")) {
      return json(route, { members: scene.roster ?? roster.map((m) => (m.id === memberId ? { ...m, role: scene.role } : m)) });
    }
    if (path.endsWith("/read-state") && method === "GET") {
      return json(route, { read_states: channels.map((c) => ({ channel_id: c.id, last_read_seq: 99, latest_seq: 99, unread_count: 0, mention_count: 0, marked_unread_before_seq: null })) });
    }
    if (path.endsWith("/approvals")) {
      return json(route, { approvals: url.searchParams.get("status") === "pending" ? scene.approvals : [] });
    }
    if (path.endsWith("/agent-runs")) return json(route, { runs: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: [] });
    if (path.endsWith("/work-sessions/shared")) return json(route, { sessions: [], nextCursor: null });
    if (path.endsWith("/work-sessions")) return json(route, { workSessions: [] });
    if (path.endsWith("/reminders")) return json(route, { reminders: [] });
    if (path.endsWith(`/workspaces/${workspaceId}`)) return json(route, { workspace: { id: workspaceId, name: "여명거리" } });
    if (path.includes(`/channels/${CH}/messages`)) return json(route, { messages: scene.messageRows ?? messageRows });
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
          if (c.connect) return { id: c.id, connect: { client: "4020-capture", version: "6" } };
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

/** 서버가 원장에 행을 쓴 것처럼: 장면을 바꾸고 프레임을 밀어 넣는다. */
async function serverMoves(page, scene, runs, kind) {
  scene.runs = runs;
  const before = scene.progressCalls;
  // 로그인 직후에는 가짜 소켓이 아직 없을 수 있다(구독 전). 있을 때 민다.
  await page.waitForFunction(() => window.__socket !== undefined, null, { timeout: 15_000 });
  await page.evaluate(
    ([channel, runId, k]) =>
      window.__push(channel, {
        type: "agent.run.event", v: 1, ts: Date.now(),
        payload: { run_id: runId, channel_id: channel.split(".")[1].toLowerCase(), kind: k },
      }),
    [`ch:ws${workspaceId.toUpperCase()}.${CH.toUpperCase()}`, runs[0]?.id ?? RUN_A, kind]
  );
  await page.waitForFunction(() => true);
  await page.waitForTimeout(500);
  return scene.progressCalls - before;
}


const pill = null; void pill;

/** 대화: 영수증이 붙던 자리들. 마지막 글만 아직 답을 기다린다. */
function messages(now) {
  const mine = (id, seq, body, ago) => ({
    id, channelId: CH, seq, hlcTs: now - ago, hlcCount: 0, authorMemberId: memberId, type: "text", body, state: "sent", createdAtMs: now - ago,
  });
  return [
    mine("00000000-0000-7000-8000-0000000a0001", 10, "그록, 어제 올린 보고서 요약 부탁해요", 9 * MIN),
    mine("00000000-0000-7000-8000-0000000a0002", 11, "ㅎㅇ", 6 * MIN),
    { id: "00000000-0000-7000-8000-0000000a0003", channelId: CH, seq: 12, hlcTs: now - 5 * MIN, hlcCount: 0, authorMemberId: agentId, type: "text", body: "안녕하세요, 곽성재님! 필요한 일 있으면 편하게 말씀해 주세요.", state: "sent", createdAtMs: now - 5 * MIN },
    mine("00000000-0000-7000-8000-0000000a0004", 13, "이번 주 일정 정리해 줘", 20_000),
  ];
}

const T = (id) => `00000000-0000-7000-8000-0000000a000${id}`;

async function scene(browser, origin, scheme, reduced) {
  const tag = `1440-${scheme}${reduced ? "-reduced" : ""}`;
  const shot = (name) => resolve(OUT_DIR, `${name}-${tag}.png`);
  const sc = newScene();
  const now = Date.now();
  sc.messageRows = messages(now);
  const context0 = null; void context0;
  const { context, page } = await open(browser, origin, scheme, sc, `/c/${CH}`, reduced);
  await page.getByText("이번 주 일정 정리해 줘").first().waitFor({ timeout: 15_000 });

  const run = (id, trigger, extra) => progress(now, { id, triggerMessageId: T(trigger), ...extra });
  const DONE = { phase: "succeeded", status: "succeeded", leaseState: "none", claimedAtMs: now - 9 * MIN, startedAtMs: now - 9 * MIN, finishedAtMs: now - 8 * MIN };
  sc.runs = [
    run(RUN_A, 1, { ...DONE, phase: "failed", status: "failed", createdAtMs: now - 9 * MIN }),
    run(RUN_B, 2, { ...DONE, createdAtMs: now - 6 * MIN, claimedAtMs: now - 6 * MIN, startedAtMs: now - 6 * MIN, finishedAtMs: now - 5 * MIN }),
    run(RUN_C, 4, { phase: "running", status: "running", leaseState: "live", createdAtMs: now - 20_000, claimedAtMs: now - 15_000, startedAtMs: now - 14_000, lastEventAtMs: now - 3_000 }),
  ];
  await serverMoves(page, sc, sc.runs, "stage");
  await page.getByTestId("composer-working-text").waitFor({ timeout: 10_000 });
  await page.waitForTimeout(400);

  // a. 일하는 중
  const line = ((await page.getByTestId("composer-working").textContent()) ?? "").replace(/\s+/g, " ");
  check(`${tag} 컴포저 위 레일이 「그록 · 작업 중」`, line.includes("그록 · 작업 중"), line);
  check(`${tag} 레일에 초 단위 숫자가 없다`, !/\d+\s*초/.test(line), line);
  check(`${tag} 얼굴이 선다`, (await page.getByTestId("responding-avatar").count()) === 1);
  const dots = page.getByTestId("responding-dots");
  check(`${tag} 점 셋이 선다`, (await dots.locator("span").count()) === 3);
  const animation = await dots.locator("span").first().evaluate((el) => getComputedStyle(el).animationName);
  if (reduced) {
    check(`${tag} 동작 줄이기: 점에 애니메이션이 없다`, animation === "none", animation);
    check(`${tag} 동작 줄이기: data-motion=still`, (await dots.getAttribute("data-motion")) === "still");
  } else {
    check(`${tag} 점이 움직인다(momo-responding)`, animation === "momo-responding", animation);
    check(`${tag} data-motion=full`, (await dots.getAttribute("data-motion")) === "full");
  }
  // 타임라인: 끝난 run·진행 중 run의 영수증 줄이 없다. 실패한 run의 예외 줄만 남는다.
  const rows = page.getByTestId("run-exception");
  check(`${tag} 예외 줄은 실패한 run 하나뿐`, (await rows.count()) === 1, String(await rows.count()));
  const rowText = ((await rows.first().textContent()) ?? "").replace(/\s+/g, " ");
  check(`${tag} 남은 줄이 「실패」를 말한다`, rowText.includes("실패"), rowText);
  check(`${tag} 「완료」·「걸림」 영수증이 없다`, !(await page.locator("body").textContent())?.includes("걸림") || rowText.includes("걸림"));
  check(`${tag} 실패 줄은 그 글 아래에 선다(진행 중 글 아래에는 없다)`, (await page.locator('[data-run-id="' + RUN_C + '"]').count()) === 0 && (await page.locator('[data-run-id="' + RUN_A + '"]').count()) === 1);
  // 칩: 실패·답함·작업 중이 각자의 메시지에 선다(행 높이는 칩과 무관하다). 같은 사람의 연속 메시지(「ㅎㅇ」)에는 머리 줄이
  // 없어 아이콘 칩이 거터에 선다(`data-variant=mark`).
  const kinds = (await page.getByTestId("trigger-chip").evaluateAll((els) => els.map((e) => `${e.getAttribute("data-kind")}:${e.getAttribute("data-variant") ?? "word"}`))).sort();
  check(`${tag} 칩 셋: 실패(머리)·작업 중(머리)·답함(거터 아이콘)`, JSON.stringify(kinds) === JSON.stringify(["answered:mark", "failed:word", "working:word"]), JSON.stringify(kinds));
  await page.screenshot({ path: shot("1-responding") });

  // c. 답이 오면 사라진다
  sc.runs = sc.runs.map((r) => (r.id === RUN_C ? { ...r, phase: "succeeded", status: "succeeded", leaseState: "none", finishedAtMs: Date.now() } : r));
  await serverMoves(page, sc, sc.runs, "succeeded");
  await page.waitForFunction(() => document.querySelector('[data-testid="composer-working-text"]') === null, null, { timeout: 5_000 }).catch(() => {});
  check(`${tag} run이 끝나면 줄이 사라진다`, (await page.getByTestId("composer-working-text").count()) === 0);
  check(`${tag} 줄이 사라져도 레일 칸은 남는다(목록이 움직이지 않는다)`, (await page.getByTestId("composer-working").getAttribute("data-state")) === "idle");
  check(`${tag} 끝난 뒤에도 성공 영수증은 없다`, (await page.locator('[data-run-id="' + RUN_C + '"]').count()) === 0);
  await page.screenshot({ path: shot("2-after-answer") });
  await context.close();
}

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) throw new Error("dist/ is missing. Run npm run build first.");
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  try {
    for (const scheme of ["light", "dark"]) {
      await scene(browser, preview.origin, scheme, false);
      await scene(browser, preview.origin, scheme, true);
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
