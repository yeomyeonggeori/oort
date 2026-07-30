#!/usr/bin/env node
// GATE: MOMO-677 작업 흐름 (ADR-0143 web surface).
//
// Fixture-only: no backend, no credentials. Seven things are locked here, and
// they are the claims the surface makes that a screenshot cannot check:
//
//   1. 목록 렌더 — rows carry the goal, the four-value status chip, the run and
//      active counts, and the server's own `?status=` filter actually reaches
//      the server (the request is inspected, not assumed).
//   2. 이력 A·B 병기 — one goal's history shows BOTH actors. This is the whole
//      evidence of ADR-0143 D2: continuity belongs to the workstream, so the
//      Run that A started and the Run the agent continued stand side by side.
//   3. 이어받기 왕복 — the takeover POSTs the EXISTING lineage resume with the
//      chosen host, the reader's own Run then joins the history, and the focus
//      lands on the confirmation instead of falling to <body> when the button
//      that was just pressed unmounts (1R M2).
//   4. 비멤버 404/403 분기 — a workstream outside the reader's channels answers
//      404 and the UI says "찾을 수 없습니다" without a word about permission,
//      while the resume path's 403 is the only place membership is named. A UI
//      that promoted the 404 to "권한이 없습니다" would hand back the existence
//      signal the server refused (WorkstreamRoutes, minimum exposure).
//   5. 헤더·행 측정 폭 — 헤더 내용과 행 내용이 같은 오른쪽 끝에서 멈추고,
//      구분선과 hover 배경은 그보다 넓게 판 전폭으로 간다. 집의 계약이고
//      (MemberRow.tsx §measure) v1은 헤더는 내용을, 목록은 컨테이너를 캡해서
//      오른쪽 가장자리를 셋 만들었다(1R H1, 1280 실측: 896/880/864).
//   6. 필터 탭 키보드 — 상태 필터는 인박스와 같은 탭 컨트롤이므로 탭 정거장이
//      1개(roving tabindex)이고 ←/→로 이동하며, 선택된 알약이 `멈춤` 상태칩과
//      같은 배지가 아니다(1R H2, 손으로 만든 버튼 5개는 정거장이 5개였다).
//   7. 끝난 목표 — 완료·취소된 목표는 원장에 고아 실행이 남아 있어도 이어받기를
//      제안하지 않고, 그 자리에 자기 문장을 놓는다(1R M1). 실행만 보고 목표를
//      보지 않으면 완료 칩 180px 아래에 활성화된 이어받기가 그려진다.
//
// Named red proofs, run from a throwaway worktree:
//   WORKSTREAM_GATE_PROVE_RED_RUNS=1 npm run gate:workstream
//     expected failure: "실행 이력 A·B 병기"
//   WORKSTREAM_GATE_PROVE_RED_RESUME=1 npm run gate:workstream
//     expected failure: "이어받기 왕복"
//   WORKSTREAM_GATE_PROVE_RED_DENIAL=1 npm run gate:workstream
//     expected failure: "비멤버 404/403 분기"
//
// Each of those three seams changes fixture BEHAVIOR, never a product or
// assertion line, so a proof is repeatable and does not ask a reviewer to
// delete anything.
//
// 5와 6은 그 형태로 붉힐 수 없다: 둘 다 제품 코드의 성질이지 데이터의 성질이
// 아니라서, 어떤 픽스처도 측정 폭이나 tabIndex를 바꾸지 못한다. 그래서 절차는
// 제품 한 줄을 되돌리는 것이고, 되돌릴 줄이 정확히 무엇인지 여기 적어둔다
// (되돌린 뒤 `npm run gate:workstream`, 확인하고 `git checkout --` 로 복구):
//   헤더·행 측정 폭 — WorkstreamListRoute의 <ul>에 className="max-w-pane-lg"를
//     도로 붙인다. 행 내용이 헤더보다 16px 왼쪽에서 끝나고 단정이 그 차이를
//     픽셀로 출력한다.
//   필터 탭 키보드 — features/common/FilterTabs의 tabIndex={selected ? 0 : -1}을
//     tabIndex={0}으로 바꾼다. 정거장이 1개에서 5개가 된다.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.WORKSTREAM_GATE_PORT || 5188);
const origin = `http://127.0.0.1:${port}`;
// Both schemes, because design-review reads both and this surface's one status
// colour (멈춤 = accent) has to survive the dark palette it was chosen in.
const outDir = process.env.WORKSTREAM_GATE_OUT_DIR
  ? resolve(process.env.WORKSTREAM_GATE_OUT_DIR)
  : resolve(webRoot, "artifacts/workstream");

const workspaceId = "00000000-0000-7000-8000-000000000001";
const viewerId = "00000000-0000-7000-8000-000000000101";
const aliceId = "00000000-0000-7000-8000-000000000102";
const agentId = "00000000-0000-7000-8000-000000000103";
const channelId = "00000000-0000-7000-8000-000000000201";
const rootMessageId = "00000000-0000-7000-8000-000000000301";
const otherRootMessageId = "00000000-0000-7000-8000-000000000302";

const activeWorkstreamId = "00000000-0000-7000-8000-000000000401";
const doneWorkstreamId = "00000000-0000-7000-8000-000000000402";
const foreignWorkstreamId = "00000000-0000-7000-8000-000000000403";

const aliceRunId = "00000000-0000-7000-8000-000000000501";
const agentRunId = "00000000-0000-7000-8000-000000000502";
const viewerRunId = "00000000-0000-7000-8000-000000000503";
const doneRunId = "00000000-0000-7000-8000-000000000504";

const deadHostId = "00000000-0000-7000-8000-000000000601";
const liveHostId = "00000000-0000-7000-8000-000000000602";
const offlineHostId = "00000000-0000-7000-8000-000000000603";
const privateHostId = "00000000-0000-7000-8000-000000000604";

const proveRedRuns = process.env.WORKSTREAM_GATE_PROVE_RED_RUNS === "1";
const proveRedResume = process.env.WORKSTREAM_GATE_PROVE_RED_RESUME === "1";
const proveRedDenial = process.env.WORKSTREAM_GATE_PROVE_RED_DENIAL === "1";

const HOUR = 3_600_000;
const now = Date.now();

const session = {
  accessToken: "gate-only-not-a-credential",
  refreshToken: "gate-only-not-a-credential",
  member: {
    id: viewerId,
    workspaceId,
    kind: "human",
    displayName: "곽성재",
    handle: "seongjae",
  },
  realtimeWebSocketUrl: "ws://workstream-gate.invalid/connection/websocket",
};

const roster = [
  {
    id: viewerId,
    workspaceId,
    kind: "human",
    status: "active",
    role: "owner",
    displayName: "곽성재",
    handle: "seongjae",
    channelCount: 1,
    channelIds: [channelId],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  },
  {
    id: aliceId,
    workspaceId,
    kind: "human",
    status: "active",
    role: "member",
    displayName: "김서연",
    handle: "seoyeon",
    channelCount: 1,
    channelIds: [channelId],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  },
  {
    id: agentId,
    workspaceId,
    kind: "agent",
    status: "active",
    role: "member",
    displayName: "김인턴",
    handle: "kim-intern",
    channelCount: 1,
    channelIds: [channelId],
    capabilities: ["work.observe"],
    ownerHumanId: viewerId,
    agentModel: "hermes-agent",
    createdAtMs: 0,
    updatedAtMs: 0,
  },
];

const channels = [
  {
    id: channelId,
    workspaceId,
    kind: "public",
    name: "release-train",
    muted: false,
  },
];

const hosts = [
  {
    id: deadHostId,
    workspaceId,
    scope: "workspace",
    ownerMemberId: aliceId,
    type: "workd",
    displayName: "빌드 러너 01",
    capabilities: { pty: true },
    createdAtMs: 0,
    online: false,
  },
  {
    id: liveHostId,
    workspaceId,
    scope: "workspace",
    ownerMemberId: viewerId,
    type: "app",
    displayName: "성재 맥북",
    capabilities: { pty: true },
    createdAtMs: 0,
    online: true,
  },
  {
    id: offlineHostId,
    workspaceId,
    scope: "workspace",
    ownerMemberId: viewerId,
    type: "workd",
    displayName: "꺼진 러너",
    capabilities: { pty: true },
    createdAtMs: 0,
    online: false,
  },
  {
    id: privateHostId,
    workspaceId,
    scope: "member",
    ownerMemberId: aliceId,
    type: "app",
    displayName: "서연 맥북",
    capabilities: { pty: true },
    createdAtMs: 0,
    online: true,
  },
];

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

/** Mutable ledger: the takeover has to be observable as a state change. */
function newState(mode) {
  return {
    mode,
    listStatusParams: [],
    resumeBody: null,
    resumeSessionId: null,
    runs: [
      {
        id: aliceRunId,
        memberId: aliceId,
        hostId: deadHostId,
        tool: "codex",
        label: "회귀 재현",
        status: "ended",
        startedAtMs: now - 5 * HOUR,
        endedAtMs: now - 4 * HOUR,
        exitCode: 0,
        endReason: "resumed",
      },
      {
        id: agentRunId,
        memberId: agentId,
        hostId: deadHostId,
        tool: "codex",
        label: "회귀 재현",
        status: "orphaned",
        startedAtMs: now - 4 * HOUR,
        resumedFromSessionId: aliceRunId,
      },
    ],
    // 완료된 목표의 원장. 고아 실행이 하나 남아 있는 것이 요점이다: 일을 완료로
    // 부른 뒤 호스트가 죽으면 실제로 이 모양이 되고, 실행만 보는 UI는 완료 칩
    // 아래에 이어받기를 제안한다(1R M1).
    doneRuns: [
      {
        id: doneRunId,
        memberId: viewerId,
        hostId: deadHostId,
        tool: "codex",
        label: "출시 노트 초안",
        status: "orphaned",
        startedAtMs: now - 30 * HOUR,
      },
    ],
    workstreams: [
      {
        id: activeWorkstreamId,
        workspaceId,
        channelId,
        rootMessageId,
        goal: "릴리스 회귀 재현과 원인 좁히기",
        status: "active",
        createdByMemberId: aliceId,
        createdAtMs: now - 5 * HOUR,
        updatedAtMs: now - 4 * HOUR,
        runCount: 2,
        activeRunCount: 0,
      },
      {
        id: doneWorkstreamId,
        workspaceId,
        channelId,
        rootMessageId: otherRootMessageId,
        goal: "출시 노트 초안 작성",
        status: "done",
        createdByMemberId: viewerId,
        createdAtMs: now - 30 * HOUR,
        updatedAtMs: now - 29 * HOUR,
        runCount: 1,
        activeRunCount: 0,
      },
    ],
  };
}

function visibleRuns(state) {
  if (!proveRedRuns) return state.runs;
  // Red seam: the projection forgets every actor but the first, which is
  // exactly the "ownership transferred" ledger ADR-0143 replaced.
  const first = state.runs[0];
  return state.runs.filter((run) => run.memberId === first.memberId);
}

async function installRealtimeSocket(page) {
  await page.addInitScript(() => {
    class GateWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      constructor(url) {
        this.url = url;
        this.readyState = GateWebSocket.CONNECTING;
        queueMicrotask(() => {
          this.readyState = GateWebSocket.OPEN;
          this.onopen?.(new Event("open"));
        });
      }
      send(data) {
        const replies = String(data)
          .trim()
          .split("\n")
          .map((line) => {
            const command = JSON.parse(line);
            if (command.connect) {
              return {
                id: command.id,
                connect: { client: "workstream-gate", version: "6" },
              };
            }
            if (command.subscribe) {
              return {
                id: command.id,
                subscribe: {
                  recoverable: true,
                  positioned: true,
                  recovered: false,
                  epoch: "workstream-gate",
                  offset: 0,
                },
              };
            }
            if (command.unsubscribe) return { id: command.id, unsubscribe: {} };
            return { id: command.id };
          });
        queueMicrotask(() => {
          this.onmessage?.(
            new MessageEvent("message", {
              data: replies.map((reply) => JSON.stringify(reply)).join("\n"),
            })
          );
        });
      }
      close() {
        this.readyState = GateWebSocket.CLOSED;
        this.onclose?.(new CloseEvent("close", { code: 1000 }));
      }
    }
    window.WebSocket = GateWebSocket;
  });
}

async function installRoutes(context, state) {
  await context.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const lower = path.toLowerCase();

    if (path === "/v1/auth/login") return json(route, session);
    if (path === "/v1/auth/realtime-token") {
      return json(route, {
        token: "gate-realtime-token",
        tokenType: "Bearer",
        expiresAtMs: Date.now() + 60_000,
        ttlSeconds: 60,
        workspaceId,
        memberId: viewerId,
      });
    }
    if (path === "/v1/auth/refresh") {
      return json(route, {
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
      });
    }
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: hosts });
    if (path.includes("/messages")) return json(route, { messages: [] });

    // ---- the three workstream reads -----------------------------------------
    const runsMatch = lower.match(/\/workstreams\/([^/]+)\/runs$/);
    if (runsMatch) {
      const id = runsMatch[1];
      if (state.mode === "non-member" || id === foreignWorkstreamId) {
        return json(route, { error: { message: "workstream not found" } }, 404);
      }
      const runsOf = () => {
        if (id === activeWorkstreamId) return visibleRuns(state);
        if (id === doneWorkstreamId) return state.doneRuns;
        return [];
      };
      return json(route, { workstreamId: id, runs: runsOf() });
    }

    const detailMatch = lower.match(/\/workstreams\/([^/]+)$/);
    if (detailMatch && request.method() === "GET") {
      const id = detailMatch[1];
      const found = state.workstreams.find((row) => row.id === id);
      if (state.mode === "non-member" || !found) {
        // The asymmetry under test: outside the anchor channel this read
        // answers 404 so it cannot be used to confirm the row exists.
        return json(
          route,
          { error: { message: "workstream not found" } },
          proveRedDenial ? 403 : 404
        );
      }
      return json(route, { workstream: found });
    }

    if (lower.endsWith("/workstreams")) {
      const status = url.searchParams.get("status");
      state.listStatusParams.push(status);
      if (state.mode === "non-member") return json(route, { workstreams: [] });
      const rows =
        status === null
          ? state.workstreams
          : state.workstreams.filter((row) => row.status === status);
      return json(route, { workstreams: rows });
    }

    // ---- the takeover: the EXISTING lineage resume ---------------------------
    const resumeMatch = lower.match(/\/work-sessions\/([^/]+)\/resume$/);
    if (resumeMatch && request.method() === "POST") {
      state.resumeSessionId = resumeMatch[1];
      state.resumeBody = request.postDataJSON();
      if (state.mode === "revoked-membership") {
        return json(
          route,
          { error: { message: "active channel membership required" } },
          403
        );
      }
      const source = state.runs.find((run) => run.id === state.resumeSessionId);
      const resumed = {
        id: viewerRunId,
        workspaceId,
        channelId,
        memberId: viewerId,
        hostId: state.resumeBody.targetHostId,
        rootMessageId,
        tool: source?.tool ?? "codex",
        label: source?.label ?? "회귀 재현",
        status: "running",
        observation: "open",
        observerGrantCount: 0,
        remoteAttachAvailable: false,
        startedAtMs: Date.now(),
        resumedFromSessionId: state.resumeSessionId,
      };
      if (!proveRedResume) {
        // The server ends the source Run and records a NEW one under the same
        // workstream; the red seam skips exactly that ledger write.
        if (source) {
          source.status = "ended";
          source.endedAtMs = Date.now();
          source.endReason = "resumed";
        }
        state.runs.push({
          id: resumed.id,
          memberId: viewerId,
          hostId: resumed.hostId,
          tool: resumed.tool,
          label: resumed.label,
          status: "running",
          startedAtMs: resumed.startedAtMs,
          resumedFromSessionId: state.resumeSessionId,
        });
        const workstream = state.workstreams.find(
          (row) => row.id === activeWorkstreamId
        );
        if (workstream) {
          workstream.runCount += 1;
          workstream.activeRunCount = 1;
          workstream.updatedAtMs = Date.now();
        }
      }
      return json(route, { workSession: resumed });
    }

    return json(route, {});
  });
}

async function waitForServer() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(origin)).ok) return;
    } catch {
      // Preview is still starting.
    }
    await wait(200);
  }
  throw new Error("workstream preview server never came up");
}

async function login(page) {
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  const submit = page.getByTestId("login-submit");
  const nav = page.getByTestId("nav-workstreams");
  await Promise.race([
    submit.waitFor({ timeout: 30_000 }).catch(() => {}),
    nav.waitFor({ timeout: 30_000 }).catch(() => {}),
  ]);
  if ((await submit.count()) > 0) {
    await page.getByTestId("login-email").fill("workstream@example.test");
    await page.getByTestId("login-password").fill("gate-only");
    await submit.click();
  }
  await nav.waitFor();
}

async function openList(page) {
  await page.getByTestId("nav-workstreams").click();
  await page.getByTestId("workstream-route").waitFor();
}

async function text(locator) {
  return (await locator.textContent())?.replace(/\s+/g, " ").trim() ?? "";
}

/**
 * Every wait carries the name of the claim it is waiting for. A bare
 * `waitFor` that expires prints "Timeout 10000ms exceeded" and a stack, which
 * tells a reviewer running a red proof nothing about which of the four claims
 * broke; the failure has to be readable as a sentence.
 */
async function claim(name, action) {
  try {
    await action();
  } catch (cause) {
    const detail =
      cause?.name === "TimeoutError"
        ? "waited for this and it never happened"
        : (cause?.message ?? String(cause));
    throw new Error(`${name}: ${detail}`);
  }
}

/**
 * 헤더 내용과 행 내용은 같은 오른쪽 끝에서 멈추고, 구분선과 hover 배경은 그보다
 * 넓다. 이 두 문장이 집의 측정 계약 전부다(MemberRow.tsx §measure).
 *
 * 픽셀로 비교하는 이유: v1의 목록에도 "헤더와 같은 읽기 폭"이라 적힌 주석이
 * 있었고, 그 주석이 참이 아니었다. 클래스 이름을 읽는 단정은 같은 거짓말을
 * 통과시킨다 — 헤더는 내용을, 목록은 컨테이너를 캡해도 양쪽 다 max-w-pane-lg를
 * 쓰고 있기 때문이다.
 */
async function assertSharedRightEdge(page, where) {
  const edges = await page.evaluate(() => {
    const right = (selector) => {
      const node = document.querySelector(selector);
      return node ? node.getBoundingClientRect().right : null;
    };
    return {
      header: right('[data-testid="workstream-header-content"]'),
      content: right('[data-testid="workstream-row-content"]'),
      separator: right('[data-testid="workstream-row"]'),
      list: right('[data-testid="workstream-list"]'),
    };
  });
  if (edges.header === null || edges.content === null) {
    throw new Error(
      `헤더·행 측정 폭: ${where}에서 잴 것을 찾지 못했다 (${JSON.stringify(edges)})`
    );
  }
  if (Math.abs(edges.header - edges.content) > 1) {
    throw new Error(
      `헤더·행 측정 폭: ${where}에서 헤더와 행이 다른 곳에서 끝난다 (헤더 ${edges.header}, 행 ${edges.content})`
    );
  }
  // 구분선(=행 전체)은 내용보다 최소한 좌우 여백만큼 넓다. 같아지면 판 전폭으로
  // 그어져야 할 선이 내용과 함께 잘렸다는 뜻이다.
  if (edges.separator - edges.content < 16) {
    throw new Error(
      `헤더·행 측정 폭: ${where}에서 구분선이 내용과 함께 잘렸다 (구분선 ${edges.separator}, 내용 ${edges.content})`
    );
  }
  if (Math.abs(edges.list - edges.separator) > 1) {
    throw new Error(
      `헤더·행 측정 폭: ${where}에서 목록 컨테이너가 행보다 좁다 (목록 ${edges.list}, 행 ${edges.separator})`
    );
  }
  // 통과해도 숫자를 남긴다: 이 단정이 무엇을 재고 있는지 리뷰어가 캡처 없이 볼 수
  // 있어야 하고, 1R이 어긋남을 픽셀로 지적했으므로 반박도 픽셀이어야 한다.
  console.log(
    `measure ${where}: 헤더 우단 ${edges.header}, 행 내용 우단 ${edges.content}, 구분선 우단 ${edges.separator}`
  );
  return edges;
}

/** No surface in this shell may make the document scroll sideways (MOMO-610). */
async function assertNoHorizontalScroll(page, where) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  if (overflow.scrollWidth > overflow.innerWidth) {
    throw new Error(
      `narrow layout: ${where} scrolled the document sideways (${overflow.scrollWidth} > ${overflow.innerWidth})`
    );
  }
}

async function assertListAndHistory(browser) {
  const state = newState("member");
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await installRealtimeSocket(page);
  await installRoutes(context, state);
  await login(page);
  await openList(page);

  // ---- 1. 목록 렌더 ---------------------------------------------------------
  const rows = page.getByTestId("workstream-row");
  await claim("목록 렌더", () => rows.first().waitFor({ timeout: 15_000 }));
  if ((await rows.count()) !== 2) {
    throw new Error(`목록 렌더: expected 2 rows, got ${await rows.count()}`);
  }
  const first = page.locator(
    `li[data-testid="workstream-row"][data-workstream-id="${activeWorkstreamId}"]`
  );
  if ((await text(first.getByTestId("workstream-goal"))) !== "릴리스 회귀 재현과 원인 좁히기") {
    throw new Error("목록 렌더: the goal sentence is not the row's headline");
  }
  if ((await text(first.getByTestId("workstream-status"))) !== "진행 중") {
    throw new Error("목록 렌더: status chip lost the server's vocabulary");
  }
  if (
    (await text(first.getByTestId("workstream-run-count"))) !== "2" ||
    (await text(first.getByTestId("workstream-active-count"))) !== "0"
  ) {
    throw new Error("목록 렌더: run/active counts are not both stated");
  }
  if ((await text(first.getByTestId("workstream-channel"))) !== "#release-train") {
    throw new Error("목록 렌더: the row does not name its channel");
  }
  if ((await text(page.getByTestId("workstream-count"))) !== "2개") {
    throw new Error("목록 렌더: header count disagrees with the list");
  }

  // The filter is the SERVER's, so the request has to carry it.
  await page.getByTestId("workstream-filter-done").click();
  await claim("목록 렌더", () =>
    page.waitForFunction(
      () =>
        document.querySelectorAll('[data-testid="workstream-row"]').length === 1,
      undefined,
      { timeout: 10_000 }
    )
  );
  if (!state.listStatusParams.includes("done")) {
    throw new Error(
      `목록 렌더: 완료 filter never reached the server (${JSON.stringify(state.listStatusParams)})`
    );
  }
  if (!page.url().includes("status=done")) {
    throw new Error("목록 렌더: the filter did not survive in the url");
  }

  await page.getByTestId("workstream-filter-cancelled").click();
  const empty = page.getByTestId("workstream-empty");
  await claim("목록 렌더", () => empty.waitFor({ timeout: 10_000 }));
  if ((await empty.getAttribute("data-variant")) !== "filtered") {
    throw new Error("목록 렌더: a filtered zero was drawn as an empty workspace");
  }
  await page.getByTestId("workstream-empty-all").click();
  await claim("목록 렌더", () =>
    page.waitForFunction(
      () =>
        document.querySelectorAll('[data-testid="workstream-row"]').length === 2,
      undefined,
      { timeout: 10_000 }
    )
  );

  // ---- 5. 헤더·행 측정 폭 ----------------------------------------------------
  // 1280은 리뷰가 어긋남을 실측한 폭이고, 1600은 640px 캡이 확실히 무는 폭이다.
  // 캡이 물지 않는 판에서는 어떤 구현이든 우연히 같은 곳에서 끝나므로, 넓은 판이
  // 이 단정을 의미 있게 만든다.
  await assertSharedRightEdge(page, "목록 1280");
  await page.setViewportSize({ width: 1600, height: 900 });
  const wide = await assertSharedRightEdge(page, "목록 1600");
  if (wide.separator - wide.content < 200) {
    throw new Error(
      `헤더·행 측정 폭: 1600에서 읽기 폭 캡이 물지 않았다 (구분선 ${wide.separator}, 내용 ${wide.content}) — 단정이 아무것도 재지 않는다`
    );
  }
  await page.setViewportSize({ width: 1280, height: 800 });

  // ---- 6. 필터 탭 키보드 -----------------------------------------------------
  const tabs = await page.evaluate(() => {
    const nodes = Array.from(
      document.querySelectorAll('[data-testid^="workstream-filter-"]')
    );
    return {
      count: nodes.length,
      roles: nodes.map((node) => node.getAttribute("role")),
      listRole: nodes[0]?.parentElement?.getAttribute("role") ?? null,
      listLabel: nodes[0]?.parentElement?.getAttribute("aria-label") ?? null,
      stops: nodes.filter((node) => node.tabIndex >= 0).length,
      selected: nodes
        .filter((node) => node.getAttribute("aria-selected") === "true")
        .map((node) => node.getAttribute("data-testid")),
      selectedStop:
        nodes.find((node) => node.getAttribute("aria-selected") === "true")
          ?.tabIndex ?? null,
      selectedClass:
        nodes.find((node) => node.getAttribute("aria-selected") === "true")
          ?.className ?? "",
      // 선택된 탭만 검사한다: 이 셸의 탭 위젯은 활성 패널 하나만 렌더하므로
      // (인박스도 같다) 비활성 탭의 aria-controls는 아직 없는 id를 가리킨다.
      // 살아 있어야 하는 것은 지금 읽히는 관계다.
      selectedControls: (() => {
        const selected = nodes.find(
          (node) => node.getAttribute("aria-selected") === "true"
        );
        const id = selected?.getAttribute("aria-controls") ?? null;
        const panel = id === null ? null : document.getElementById(id);
        return panel !== null && panel.getAttribute("role") === "tabpanel";
      })(),
    };
  });
  if (tabs.count !== 5 || tabs.listRole !== "tablist") {
    throw new Error(
      `필터 탭 키보드: 다섯 값이 한 tablist 안에 있지 않다 (${tabs.count}개, 부모 role ${tabs.listRole})`
    );
  }
  if (tabs.roles.some((role) => role !== "tab")) {
    throw new Error(
      `필터 탭 키보드: 탭이 아닌 컨트롤이 섞였다 (${JSON.stringify(tabs.roles)})`
    );
  }
  if (tabs.stops !== 1 || tabs.selectedStop !== 0) {
    throw new Error(
      `필터 탭 키보드: 탭 정거장이 ${tabs.stops}개다. 다섯 값은 한 질문이므로 정거장은 하나이고, 그 하나는 선택된 탭이어야 한다`
    );
  }
  if (tabs.selected.length !== 1 || tabs.selected[0] !== "workstream-filter-all") {
    throw new Error(
      `필터 탭 키보드: 선택 상태가 aria-selected로 말해지지 않는다 (${JSON.stringify(tabs.selected)})`
    );
  }
  if (!tabs.selectedControls) {
    throw new Error(
      "필터 탭 키보드: 선택된 탭이 지배하는 tabpanel이 없다. aria-controls가 가리키는 자리에 목록이 있어야 한다"
    );
  }
  // 선택 알약이 상태칩의 잉크를 쓰면 목록 한 화면에 `멈춤` 배지가 둘이 된다
  // (model.ts WORKSTREAM_STATUS_CLASS.paused = bg-accent-soft text-accent).
  if (tabs.selectedClass.includes("text-accent")) {
    throw new Error(
      `필터 탭 키보드: 선택된 필터가 상태칩과 같은 배지다 (${tabs.selectedClass})`
    );
  }
  await page.getByTestId("workstream-filter-all").focus();
  await page.keyboard.press("ArrowRight");
  await claim("필터 탭 키보드", () =>
    page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="workstream-filter-active"]')
          ?.getAttribute("aria-selected") === "true",
      undefined,
      { timeout: 10_000 }
    )
  );
  if (!state.listStatusParams.includes("active")) {
    throw new Error(
      `필터 탭 키보드: ←/→ 이동이 서버 필터를 바꾸지 않았다 (${JSON.stringify(state.listStatusParams)})`
    );
  }
  const movedFocus = await page.evaluate(
    () => document.activeElement?.getAttribute("data-testid") ?? null
  );
  if (movedFocus !== "workstream-filter-active") {
    throw new Error(
      `필터 탭 키보드: 선택은 옮겼는데 포커스가 따라가지 않았다 (${movedFocus})`
    );
  }
  await page.getByTestId("workstream-filter-all").click();
  await claim("필터 탭 키보드", () =>
    page.waitForFunction(
      () =>
        document.querySelectorAll('[data-testid="workstream-row"]').length === 2,
      undefined,
      { timeout: 10_000 }
    )
  );

  // ---- 2. 이력 A·B 병기 -----------------------------------------------------
  await first.locator("a").click();
  await claim("실행 이력 A·B 병기", async () => {
    await page.getByTestId("workstream-detail-route").waitFor({ timeout: 15_000 });
    await page.getByTestId("workstream-run-list").waitFor({ timeout: 15_000 });
  });
  const actors = await page
    .getByTestId("workstream-run-actor")
    .evaluateAll((nodes) => nodes.map((node) => node.textContent?.trim()));
  if (
    actors.length !== 2 ||
    !actors.includes("김서연") ||
    !actors.includes("김인턴")
  ) {
    throw new Error(
      `실행 이력 A·B 병기: expected both actors under one goal, got ${JSON.stringify(actors)}`
    );
  }
  const agentRow = page.locator(
    `li[data-testid="workstream-run-row"][data-run-id="${agentRunId}"]`
  );
  const agentToneOk = await agentRow
    .getByTestId("workstream-run-actor")
    .evaluate((node) => node.className.includes("text-agent"));
  if (!agentToneOk) {
    throw new Error(
      "실행 이력 A·B 병기: the agent Run lost its agent identity token"
    );
  }
  if ((await agentRow.getByTestId("workstream-run-lineage").count()) !== 1) {
    throw new Error(
      "실행 이력 A·B 병기: the continued Run does not say it continued one"
    );
  }
  if ((await text(page.getByTestId("workstream-detail-actors"))) !== "2") {
    throw new Error("실행 이력 A·B 병기: 참여자 count does not match the list");
  }
  const anchorHref = await page
    .getByTestId("workstream-detail-anchor")
    .getAttribute("href");
  if (!anchorHref?.includes(`/c/${channelId}`) || !anchorHref.includes("msg=")) {
    throw new Error(
      `앵커 대화: the detail does not link to the anchor thread (${anchorHref})`
    );
  }

  await assertNoHorizontalScroll(page, "detail at 1280");
  await page.setViewportSize({ width: 760, height: 480 });
  await assertNoHorizontalScroll(page, "detail at 760");
  await page.setViewportSize({ width: 1280, height: 800 });

  // ---- 3. 이어받기 왕복 -----------------------------------------------------
  const block = page.getByTestId("workstream-continue");
  if ((await block.getAttribute("data-state")) !== "ready") {
    throw new Error(
      `이어받기 왕복: takeover was not offered for an orphaned Run (${await block.getAttribute("data-state")})`
    );
  }
  await page.getByTestId("workstream-continue-toggle").click();
  const targets = page.getByTestId("workstream-continue-host");
  await claim("이어받기 왕복", () => targets.first().waitFor({ timeout: 10_000 }));
  const targetIds = await targets.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-host-id"))
  );
  if (targetIds.length !== 1 || targetIds[0] !== liveHostId) {
    throw new Error(
      `이어받기 왕복: host eligibility drifted from the server boundary (${JSON.stringify(targetIds)})`
    );
  }
  const resumeResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().toLowerCase().includes("/resume")
  );
  await targets.first().click();
  await claim("이어받기 왕복", () => resumeResponse);
  if (
    state.resumeSessionId !== agentRunId ||
    state.resumeBody?.targetHostId !== liveHostId
  ) {
    throw new Error(
      `이어받기 왕복: the takeover did not POST the orphaned Run and chosen host (${state.resumeSessionId}, ${JSON.stringify(state.resumeBody)})`
    );
  }
  await claim("이어받기 왕복", () =>
    page.getByTestId("workstream-continue-done").waitFor({ timeout: 10_000 })
  );
  // 성공은 방금 누른 버튼을 없앤다(고아였던 실행이 더 이상 고아가 아니다). 포커스를
  // 옮기지 않으면 키보드 사용자는 안내만 듣고 <body>에 남는다(1R M2). 오류 경로는
  // 버튼이 그대로라 이 문제가 없으므로, 단정은 성공 경로에만 있다.
  const landed = await page.evaluate(
    () => document.activeElement?.getAttribute("data-testid") ?? null
  );
  if (landed !== "workstream-continue-done") {
    throw new Error(
      `이어받기 왕복: 성공한 이어받기가 포커스를 ${landed ?? "<body>"}로 떨어뜨렸다`
    );
  }
  await claim("이어받기 왕복", () =>
    page.waitForFunction(
      () =>
        document.querySelectorAll('[data-testid="workstream-run-row"]').length ===
        3,
      undefined,
      { timeout: 10_000 }
    )
  );
  const afterActors = await page
    .getByTestId("workstream-run-actor")
    .evaluateAll((nodes) => nodes.map((node) => node.textContent?.trim()));
  if (!afterActors.includes("곽성재")) {
    throw new Error(
      `이어받기 왕복: the reader's own Run never joined the history (${JSON.stringify(afterActors)})`
    );
  }
  if ((await text(page.getByTestId("workstream-detail-actors"))) !== "3") {
    throw new Error("이어받기 왕복: 참여자 count did not follow the new Run");
  }
  const afterState = await page
    .getByTestId("workstream-continue")
    .getAttribute("data-state");
  if (afterState !== "no-stopped-run") {
    throw new Error(
      `이어받기 왕복: a taken-over goal still advertises a takeover (${afterState})`
    );
  }
  const blockedCopy = await text(page.getByTestId("workstream-continue-blocked"));
  if (blockedCopy.includes("미커밋") || blockedCopy.includes("가져")) {
    throw new Error(
      "이어받기 왕복: the blocked copy promises the working tree (ADR-0143 D3)"
    );
  }

  await context.close();
}

/**
 * 끝난 목표는 이어받기를 제안하지 않는다.
 *
 * 모델 테스트가 잡을 수 없는 절반이 여기 있다: `continuationState`가 상태를 받게
 * 만드는 것과, 상세 라우트가 그 자리에 실제로 workstream.status를 넘기는 것은
 * 다른 일이다. 인자를 안 넘기면 타입이 잡지만, 엉뚱한 값을 넘기면 아무도 안
 * 잡는다.
 */
async function assertClosedGoal(browser) {
  const state = newState("member");
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await installRealtimeSocket(page);
  await installRoutes(context, state);
  await login(page);
  await page.goto(`${origin}/#/workstreams/${doneWorkstreamId}`);
  await claim("끝난 목표", () =>
    page.getByTestId("workstream-run-list").waitFor({ timeout: 15_000 })
  );
  if ((await text(page.getByTestId("workstream-detail-status"))) !== "완료") {
    throw new Error("끝난 목표: 픽스처가 완료된 목표를 그리지 않았다");
  }
  const block = page.getByTestId("workstream-continue");
  const kind = await block.getAttribute("data-state");
  if (kind !== "closed") {
    throw new Error(
      `끝난 목표: 완료된 목표의 이어받기 상태가 ${kind}다. 같은 화면의 원장에는 고아 실행이 있으므로, 목표 자체를 안 보면 여기서 ready가 나온다`
    );
  }
  if ((await page.getByTestId("workstream-continue-toggle").count()) !== 0) {
    throw new Error(
      "끝난 목표: 완료 칩 아래에 활성화된 이어받기 버튼이 남아 있다"
    );
  }
  const copy = await text(page.getByTestId("workstream-continue-blocked"));
  if (!copy.includes("완료") || copy.includes("이어받을 수 있습니다")) {
    throw new Error(
      `끝난 목표: 끝난 목표에 이어받기를 다시 권하고 있다 (${copy})`
    );
  }
  // 증거는 남는다: 제안이 사라지는 것과 이력이 사라지는 것은 다른 일이다. 남아
  // 있는 그 실행이 바로 고아 실행이라, 이 화면은 "이어받을 수 있는 실행이 있는데도
  // 제안하지 않는다"를 보여준다.
  const rows = page.getByTestId("workstream-run-row");
  if ((await rows.count()) !== 1) {
    throw new Error("끝난 목표: 제안을 거두면서 실행 이력까지 거뒀다");
  }
  if ((await rows.first().getAttribute("data-status")) !== "orphaned") {
    throw new Error(
      "끝난 목표: 픽스처가 고아 실행을 남기지 않아 단정이 아무것도 재지 않는다"
    );
  }
  await context.close();
}

async function assertDenialAsymmetry(browser) {
  // A member sees the surface; the resume path alone answers 403, and only
  // there may the UI talk about membership.
  const revoked = newState("revoked-membership");
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await installRealtimeSocket(page);
  await installRoutes(context, revoked);
  await login(page);
  await page.goto(`${origin}/#/workstreams/${activeWorkstreamId}`);
  await claim("비멤버 404/403 분기", () =>
    page.getByTestId("workstream-run-list").waitFor({ timeout: 15_000 })
  );
  await page.getByTestId("workstream-continue-toggle").click();
  await page.getByTestId("workstream-continue-host").first().click();
  const error = page.getByTestId("workstream-continue-error");
  await claim("비멤버 404/403 분기", () => error.waitFor({ timeout: 10_000 }));
  const errorCopy = await text(error);
  if (!errorCopy.includes("멤버")) {
    throw new Error(
      `비멤버 404/403 분기: a 403 did not name membership (${errorCopy})`
    );
  }
  if ((await page.getByTestId("workstream-continue-done").count()) !== 0) {
    throw new Error("비멤버 404/403 분기: a refused takeover claimed success");
  }
  await context.close();

  // A non-member gets zero rows and a 404, and neither may be dressed as a
  // permission refusal: that would confirm the row exists.
  const outsider = newState("non-member");
  const outsiderContext = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    reducedMotion: "reduce",
  });
  const outsiderPage = await outsiderContext.newPage();
  await installRealtimeSocket(outsiderPage);
  await installRoutes(outsiderContext, outsider);
  await login(outsiderPage);
  await openList(outsiderPage);
  const outsiderEmpty = outsiderPage.getByTestId("workstream-empty");
  await claim("비멤버 404/403 분기", () =>
    outsiderEmpty.waitFor({ timeout: 15_000 })
  );
  if ((await outsiderEmpty.getAttribute("data-variant")) !== "all") {
    throw new Error("비멤버 404/403 분기: a zero list was not drawn as empty");
  }
  const emptyCopy = await text(outsiderEmpty);
  if (emptyCopy.includes("권한") || emptyCopy.includes("403")) {
    throw new Error(
      `비멤버 404/403 분기: the empty list accused the reader (${emptyCopy})`
    );
  }

  await outsiderPage.goto(`${origin}/#/workstreams/${foreignWorkstreamId}`);
  const missing = outsiderPage.getByTestId("workstream-detail-missing");
  await missing.waitFor({ timeout: 15_000 }).catch(() => {});
  if ((await missing.count()) !== 1) {
    throw new Error(
      "비멤버 404/403 분기: a 404 workstream did not render the not-found state"
    );
  }
  const missingCopy = await text(missing);
  if (missingCopy.includes("권한") || !missingCopy.includes("찾을 수 없습니다")) {
    throw new Error(
      `비멤버 404/403 분기: the 404 was promoted to a permission claim (${missingCopy})`
    );
  }
  if ((await outsiderPage.getByTestId("workstream-run-list").count()) !== 0) {
    throw new Error(
      "비멤버 404/403 분기: a workstream that answered 404 still drew a history"
    );
  }
  await outsiderContext.close();
}

async function captureScreens(browser) {
  mkdirSync(outDir, { recursive: true });
  const shots = [];
  for (const scheme of ["light", "dark"]) {
    const state = newState("member");
    // 리뷰가 읽어야 하는 문장은 짧은 문장이 아니다. 긴 한국어 목표가 상세에서 어떻게
    // 접히는지 — 어절에서 끊는가, 음절 한가운데서 끊는가(MOMO-676 M-5) — 는 단정이
    // 아니라 캡처로만 보이고, 1R H3이 지적한 것이 정확히 그 자리다. 같은 문장을 목록은
    // 말줄임으로, 상세는 줄바꿈으로 처리하므로 한 문장이 두 주장을 다 보여준다.
    state.workstreams[0].goal =
      "결제 실패 알림이 같은 주문에 두 번 가는 문제를 재현하고 원인을 좁힌 다음 재발 방지 테스트를 추가한다";
    // A paused goal exists only in this capture: nothing writes a workstream
    // out of `active` yet (status transitions are ADR-0143 P2), so the accent
    // chip would otherwise never be reviewable in either scheme.
    state.workstreams.push({
      ...state.workstreams[0],
      id: "00000000-0000-7000-8000-000000000404",
      goal: "결제 실패 알림 파이프라인 정리",
      status: "paused",
      runCount: 4,
      activeRunCount: 0,
      updatedAtMs: now - 2 * HOUR,
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      reducedMotion: "reduce",
      colorScheme: scheme,
    });
    const page = await context.newPage();
    await installRealtimeSocket(page);
    await installRoutes(context, state);
    await login(page);
    await openList(page);
    await claim("캡처", () =>
      page.getByTestId("workstream-row").first().waitFor({ timeout: 15_000 })
    );
    const listShot = resolve(outDir, `list-${scheme}.png`);
    await page.screenshot({ path: listShot });
    shots.push(listShot);

    await page.goto(`${origin}/#/workstreams/${activeWorkstreamId}`);
    await claim("캡처", () =>
      page.getByTestId("workstream-run-list").waitFor({ timeout: 15_000 })
    );
    const detailShot = resolve(outDir, `detail-${scheme}.png`);
    await page.screenshot({ path: detailShot });
    shots.push(detailShot);

    // 끝난 목표. 새로 생긴 문장이 사는 유일한 자리이고, 리뷰가 읽을 수 있어야 한다:
    // 완료 칩 아래에서 이어받기가 사라지되 실행 이력은 남는다는 것이 이 화면의 주장
    // 전부다(1R M1).
    await page.goto(`${origin}/#/workstreams/${doneWorkstreamId}`);
    await claim("캡처", () =>
      page
        .locator('[data-testid="workstream-continue"][data-state="closed"]')
        .waitFor({ timeout: 15_000 })
    );
    const closedShot = resolve(outDir, `closed-${scheme}.png`);
    await page.screenshot({ path: closedShot });
    shots.push(closedShot);
    await context.close();
  }
  return shots;
}

async function main() {
  if (!existsSync(resolve(webRoot, "dist/index.html"))) {
    throw new Error("dist/ is missing. Run npm run build first.");
  }
  const server = spawn(
    resolve(webRoot, "node_modules/.bin/vite"),
    ["preview", "--port", String(port), "--strictPort", "--host", "127.0.0.1"],
    { cwd: webRoot, stdio: "ignore" }
  );
  let captured = [];
  try {
    await waitForServer();
    const browser = await chromium.launch();
    try {
      await assertListAndHistory(browser);
      await assertClosedGoal(browser);
      await assertDenialAsymmetry(browser);
      captured = await captureScreens(browser);
    } finally {
      await browser.close();
    }
  } finally {
    server.kill("SIGTERM");
  }
  console.log(
    "GATE PASS workstream: list rows and server-side status filter, A·B run history with"
  );
  console.log(
    "           agent identity and lineage, takeover round trip through the existing resume,"
  );
  console.log(
    "           the 404/403 asymmetry kept the way the server means it, header and rows"
  );
  console.log(
    "           sharing one right edge, one tab stop on the filter, and no takeover offered"
  );
  console.log("           under a finished goal.");
  console.log(`screenshots: ${captured.join(", ")}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
