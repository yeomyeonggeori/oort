#!/usr/bin/env node
// GATE: MOMO-677 작업 흐름 (ADR-0143 web surface).
//
// Fixture-only: no backend, no credentials. Ten things are locked here, and
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
//   8. 피커 위계와 폭 — 자격 호스트가 셋인 화면에서, 결정(호스트 버튼)이 그것을
//      접는 토글보다 무겁고, 그룹 라벨이 스크린리더 전용이 아니며, 하나를 눌러
//      진행 상태로 만들어도 형제 버튼의 좌표와 폭이 1px도 움직이지 않는다
//      (MOMO-679 M3). 픽스처가 자격 호스트를 하나만 주던 동안에는 이 셋 중
//      어느 것도 화면에 나타난 적이 없다.
//   9. 목록 목표 말줄임 — 200자를 허용하는 목표(055)가 640px 읽기 폭에서 두
//      줄까지 접힌다. 한 줄 말줄임은 40자만 남기고, 행의 나머지 사실은 채널
//      이름뿐이라 접두사가 같은 두 목표가 같은 행이 됐다(MOMO-679 M4). 행이
//      시작한 사람도 말하는지 함께 잰다.
//  10. 원장 <-> 세션 왕복 — 실행 행이 그 실행의 작업 세션 패널로 가고, 거기서
//      다시 같은 목표로 돌아온다(MOMO-679 M5). 한 방향만 있으면 표면은
//      사이드바에서 출발할 때만 도달 가능하다. 에이전트 실행이 자기 소유자를
//      병기하는지도 같은 화면에서 잰다(M6).
//
// Named red proofs, run from a throwaway worktree:
//   WORKSTREAM_GATE_PROVE_RED_RUNS=1 npm run gate:workstream
//     expected failure: "실행 이력 A·B 병기"
//   WORKSTREAM_GATE_PROVE_RED_RESUME=1 npm run gate:workstream
//     expected failure: "이어받기 왕복"
//   WORKSTREAM_GATE_PROVE_RED_DENIAL=1 npm run gate:workstream
//     expected failure: "비멤버 404/403 분기"
//   WORKSTREAM_GATE_PROVE_RED_LEDGER=1 npm run gate:workstream
//     expected failure: "원장 역링크"
//
// Each of those four seams changes fixture BEHAVIOR, never a product or
// assertion line, so a proof is repeatable and does not ask a reviewer to
// delete anything.
//
// 5·6·8·9는 그 형태로 붉힐 수 없다: 넷 다 제품 코드의 성질이지 데이터의 성질이
// 아니라서, 어떤 픽스처도 측정 폭이나 tabIndex나 버튼 폭을 바꾸지 못한다.
// 그래서 절차는 제품 한 줄을 되돌리는 것이고, 되돌릴 줄이 정확히 무엇인지 여기
// 적어둔다 (되돌린 뒤 `npm run gate:workstream`, 확인하고 `git checkout --` 로
// 복구):
//   헤더·행 측정 폭 — WorkstreamListRoute의 <ul>에 className="max-w-pane-lg"를
//     도로 붙인다. 행 내용이 헤더보다 16px 왼쪽에서 끝나고 단정이 그 차이를
//     픽셀로 출력한다.
//   필터 탭 키보드 — features/common/FilterTabs의 tabIndex={selected ? 0 : -1}을
//     tabIndex={0}으로 바꾼다. 정거장이 1개에서 5개가 된다.
//   피커 위계와 폭 — features/work/HostPicker의 상설 아이콘 자리를 v1의 라벨
//     스왑으로 되돌린다(`busy ? <Loader2/> : <Monitor/>` 를 `busy && <Loader2/>`
//     로, 이름 자리를 `busy ? "이어받는 중" : host.displayName` 로). 누른 버튼이
//     넓어지면서 형제의 x가 밀리고, 단정이 움직인 버튼의 좌표를 출력한다.
//     위계 쪽은 같은 파일의 variant="default"를 "outline"으로 되돌리면 붉는다.
//   목록 목표 말줄임 — WorkstreamListRoute의 목표 span에서 `line-clamp-2`를
//     `truncate`로 되돌린다. 단정이 "1줄로 그려졌다"로 실패한다.
//
// 10은 픽스처로 붉힐 수 있으므로 위의 이름 있는 seam(LEDGER)을 갖는다.

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
// 두 번째·세 번째 자격 호스트. v1 픽스처는 자격 호스트를 언제나 하나만 줘서,
// 피커가 여러 선택지를 담은 화면을 아무도 본 적이 없었다(MOMO-679 M3).
const runnerHostId = "00000000-0000-7000-8000-000000000605";
const spareHostId = "00000000-0000-7000-8000-000000000606";

const proveRedRuns = process.env.WORKSTREAM_GATE_PROVE_RED_RUNS === "1";
const proveRedResume = process.env.WORKSTREAM_GATE_PROVE_RED_RESUME === "1";
const proveRedDenial = process.env.WORKSTREAM_GATE_PROVE_RED_DENIAL === "1";
const proveRedLedger = process.env.WORKSTREAM_GATE_PROVE_RED_LEDGER === "1";

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
  // 자격을 갖춘 나머지 둘. 하나는 workspace scope이고 하나는 읽는 사람 소유의
  // member scope이라, `workSessionResumeTargets`의 두 통과 경로가 모두 화면에
  // 그려진다. 이름 길이도 다르다: 폭이 상태에 따라 변하지 않는다는 주장은
  // 짧은 이름들만 있는 줄에서는 증명되지 않는다.
  {
    id: runnerHostId,
    workspaceId,
    scope: "workspace",
    ownerMemberId: aliceId,
    type: "workd",
    displayName: "codex-workbench 02",
    capabilities: { pty: true },
    createdAtMs: 0,
    online: true,
  },
  {
    id: spareHostId,
    workspaceId,
    scope: "member",
    ownerMemberId: viewerId,
    type: "app",
    displayName: "성재 예비 맥미니",
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
        // 055가 허용하는 200자에 가까운 목표. 짧은 목표만 있는 픽스처에서는
        // 말줄임에 대한 어떤 단정도 아무것도 재지 못한다(MOMO-679 M4): 640px
        // 읽기 폭에서 한 줄은 40자쯤이라, 두 줄로 접히는지 한 줄에서 잘리는지는
        // 두 줄을 넘는 문장에서만 보인다.
        goal: "릴리스 회귀 재현과 원인 좁히기: 결제 실패 알림이 같은 주문에 두 번 가는 경로를 먼저 재현하고, 중복 억제가 어디서 풀리는지 좁힌 다음 재발 방지 테스트를 추가한다. 같은 증상이 정산 알림에도 있는지 확인하고, 없다면 두 파이프라인의 차이를 기록으로 남긴다",
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

/** 원장 행 하나를 작업 세션 패널이 읽는 모양으로. 같은 id, 같은 채널. */
function asWorkSession(run) {
  return {
    // Red seam: 두 투영이 같은 실행을 다른 id로 부르면, 원장 행이 가리키는
    // 세션은 패널에 없다. 이것이 v1의 상태와 정확히 같은 결과다 — 원장에서
    // 세션으로 가는 길이 없다.
    id: proveRedLedger ? run.id.replace(/.$/, "9") : run.id,
    workspaceId,
    channelId,
    memberId: run.memberId,
    hostId: run.hostId,
    rootMessageId,
    tool: run.tool,
    label: run.label,
    status: run.status,
    observation: "open",
    observerGrantCount: 0,
    remoteAttachAvailable: false,
    startedAtMs: run.startedAtMs,
    ...(run.endedAtMs === undefined ? {} : { endedAtMs: run.endedAtMs }),
    ...(run.resumedFromSessionId === undefined
      ? {}
      : { resumedFromSessionId: run.resumedFromSessionId }),
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
    // 작업 세션 원장. 목표의 실행 이력과 같은 행들을, 작업 세션 패널이 읽는
    // 모양으로 낸다: 원장 행에서 세션 상세로 가는 링크가 실제로 그 세션에
    // 도착하는지는 두 투영이 같은 id를 말할 때만 확인할 수 있다.
    if (path.endsWith("/work-sessions")) {
      return json(route, { workSessions: state.runs.map(asWorkSession) });
    }
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
      const sessionId = url.searchParams.get("sessionId");
      if (state.mode === "non-member") return json(route, { workstreams: [] });
      // `?sessionId=`는 같은 투영을 반대쪽 끝에서 묻는 것이다: 이 실행을 품은
      // 목표. 작업 세션 패널의 역링크가 쓰는 경로이고, 목록 필터와 섞이지
      // 않도록 `listStatusParams`에도 남기지 않는다.
      if (sessionId !== null) {
        const owning = state.runs.some((run) => run.id === sessionId)
          ? state.workstreams.find((row) => row.id === activeWorkstreamId)
          : state.doneRuns.some((run) => run.id === sessionId)
            ? state.workstreams.find((row) => row.id === doneWorkstreamId)
            : undefined;
        return json(route, { workstreams: owning ? [owning] : [] });
      }
      state.listStatusParams.push(status);
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

/**
 * 목록 행의 목표가 두 줄까지 접힌다 (MOMO-679 M4).
 *
 * 픽셀로 잰다. `line-clamp-2` 클래스가 붙어 있는지를 읽는 단정은 두 가지를
 * 통과시킨다: 클래스가 컴파일되지 않은 경우와, 픽스처의 목표가 짧아 애초에
 * 접힐 일이 없는 경우. 그래서 계산된 줄 수와 잘린 높이를 함께 확인하고, 잘린
 * 것이 없으면 "이 단정이 아무것도 재지 않는다"로 실패한다.
 */
async function assertGoalFold(page) {
  const fold = await page.evaluate(() => {
    const node = document.querySelector('[data-testid="workstream-goal"]');
    if (node === null) return null;
    const style = getComputedStyle(node);
    const lineHeight = Number.parseFloat(style.lineHeight);
    return {
      clamp: style.webkitLineClamp,
      lineHeight,
      clientHeight: node.clientHeight,
      scrollHeight: node.scrollHeight,
      lines: Math.round(node.clientHeight / lineHeight),
      chars: (node.textContent ?? "").length,
    };
  });
  if (fold === null) {
    throw new Error("목록 목표 말줄임: 잴 목표 엘리먼트가 없다");
  }
  if (fold.scrollHeight <= fold.clientHeight) {
    throw new Error(
      `목록 목표 말줄임: 픽스처의 목표(${fold.chars}자)가 접히지도 않았다. 이 단정이 아무것도 재지 않는다`
    );
  }
  if (fold.lines !== 2 || fold.clamp !== "2") {
    throw new Error(
      `목록 목표 말줄임: 목표가 ${fold.lines}줄로 그려졌다 (clamp ${fold.clamp}). 한 줄이면 200자 중 40자만 읽히고, 접두사가 같은 두 목표는 같은 행이 된다`
    );
  }
  console.log(
    `goal fold: ${fold.chars}자 목표가 ${fold.lines}줄 ${fold.clientHeight}px로 접혔다 (전체 ${fold.scrollHeight}px)`
  );
}

/**
 * 피커의 위계와 폭 (MOMO-679 M3).
 *
 * 세 가지를 픽셀과 계산된 스타일로 잰다. 클래스 이름을 읽는 단정은 이 셋 중
 * 어느 것도 재지 못한다: variant가 바뀌어도 셋 다 그대로일 수 있고, 반대로
 * 클래스가 그대로여도 라벨 하나가 폭을 흔들 수 있다.
 *
 *   - 결정 버튼이 그것을 접는 버튼보다 무겁다. 열린 토글은 채움이 없고
 *     (ghost), 호스트 버튼은 채움이 있다. v1은 둘 다 outline이었다.
 *   - 그룹 라벨이 스크린리더 전용이 아니다. 눈에 보이는 텍스트가 있고,
 *     그룹은 그것을 aria-labelledby로 되짚는다.
 *   - **형제 버튼이 움직이지 않는다.** 하나를 눌러 진행 상태로 만든 뒤 나머지
 *     둘의 좌표를 다시 재고, 1px이라도 움직이면 실패다. 이것이 M3의 실제
 *     피해였다 — `flex-wrap justify-end`에서 라벨이 바뀌면 아직 포인터가 있는
 *     자리의 형제가 미끄러진다.
 */
async function assertPickerHierarchy(page, closedToggleFill) {
  // 채움을 재기 전에 포인터를 치우고 전환이 끝나기를 기다린다. 방금 누른 토글
  // 위에 커서가 남아 있으면 `hover:bg-surface-hover`가 잡히고, 150ms짜리
  // `transition-colors` 중간이면 지워지는 중인 이전 채움이 잡힌다 — 둘 다 이
  // 단정이 물으려는 것(어느 버튼이 결정인가)과 무관한 값이다.
  await page.mouse.move(0, 0);
  await settle(page);
  const shape = await page.evaluate(() => {
    const group = document.querySelector(
      '[data-testid="workstream-continue-targets"]'
    );
    const toggle = document.querySelector(
      '[data-testid="workstream-continue-toggle"]'
    );
    const hosts = Array.from(
      document.querySelectorAll('[data-testid="workstream-continue-host"]')
    );
    const labelId = group?.getAttribute("aria-labelledby") ?? null;
    const label = labelId === null ? null : document.getElementById(labelId);
    return {
      role: group?.getAttribute("role") ?? null,
      labelId,
      labelText: label?.textContent?.trim() ?? null,
      labelVisible:
        label !== null && label.getBoundingClientRect().width > 0,
      srOnlyLabel: group?.getAttribute("aria-label") ?? null,
      controls: toggle?.getAttribute("aria-controls") ?? null,
      groupId: group?.getAttribute("id") ?? null,
      toggleFill: toggle ? getComputedStyle(toggle).backgroundColor : null,
      toggleClass: toggle?.className ?? null,
      hostFills: hosts.map((node) => getComputedStyle(node).backgroundColor),
      boxes: hosts.map((node) => {
        const box = node.getBoundingClientRect();
        return {
          hostId: node.getAttribute("data-host-id"),
          x: Math.round(box.x),
          y: Math.round(box.y),
          width: Math.round(box.width),
        };
      }),
    };
  });

  if (shape.role !== "group" || shape.labelId === null || shape.labelText === null) {
    throw new Error(
      `피커 위계: 호스트 줄이 이름을 가진 그룹이 아니다 (${JSON.stringify(shape)})`
    );
  }
  if (!shape.labelVisible) {
    throw new Error(
      `피커 위계: 그룹 라벨이 화면에 없다. 스크린리더만 무엇을 고르는 중인지 안다 (${shape.labelText})`
    );
  }
  if (shape.srOnlyLabel !== null) {
    throw new Error(
      `피커 위계: 보이는 라벨과 aria-label이 둘 다 있다. 이름이 둘이면 하나는 곧 거짓말이 된다 (${shape.srOnlyLabel})`
    );
  }
  if (shape.controls === null || shape.controls !== shape.groupId) {
    throw new Error(
      `피커 위계: 토글이 자기가 여는 그룹을 가리키지 않는다 (aria-controls ${shape.controls}, 그룹 ${shape.groupId})`
    );
  }
  // 채움의 유무로 잰다. 열린 토글은 배경이 없고(ghost), 호스트 버튼은 있다.
  if (shape.toggleFill === closedToggleFill) {
    throw new Error(
      `피커 위계: 토글이 열리고도 같은 무게다 (${shape.toggleFill} / ${shape.toggleClass}). 결정이 호스트 버튼으로 옮겨갔으면 토글은 물러나야 한다`
    );
  }
  const transparent = (value) =>
    value === null || value === "rgba(0, 0, 0, 0)" || value === "transparent";
  if (!transparent(shape.toggleFill)) {
    throw new Error(
      `피커 위계: 열린 토글이 아직 칠해져 있다 (${shape.toggleFill})`
    );
  }
  for (const fill of shape.hostFills) {
    if (transparent(fill)) {
      throw new Error(
        `피커 위계: 호스트 버튼이 채움 없이 서 있다 (${JSON.stringify(shape.hostFills)}). 이 줄에서 되돌리기 가장 어려운 버튼이 가장 가벼우면 안 된다`
      );
    }
  }
  if (shape.hostFills.some((fill) => fill !== shape.hostFills[0])) {
    throw new Error(
      `피커 위계: 같은 선택지들이 서로 다른 무게다 (${JSON.stringify(shape.hostFills)})`
    );
  }
  console.log(
    `picker: 라벨 "${shape.labelText}", 호스트 ${shape.boxes.length}개, 폭 ${shape.boxes
      .map((box) => box.width)
      .join("/")}`
  );

  // 진행 상태로 만들었을 때 형제가 움직이지 않는가. 진행 중인 순간의 기하가
  // 대상이므로 요청을 붙잡아 세운 채로 재고, 놓아줄 때는 원장에 아무것도 쓰지
  // 않도록 끊는다 — 이 단정은 왕복이 아니라 폭에 대한 것이고, 여기서 이어받기가
  // 성사되면 바로 아래의 왕복 단정이 잴 것을 잃는다.
  let release = () => {};
  const held = new Promise((resolveHold) => {
    release = resolveHold;
  });
  await page.route("**/resume", async (route) => {
    await held;
    await route.abort();
  });
  const first = page.getByTestId("workstream-continue-host").first();
  await first.click();
  await claim("피커 위계", () =>
    page.waitForFunction(
      () =>
        document.querySelector(
          '[data-testid="workstream-continue-host"][data-busy]'
        ) !== null,
      undefined,
      { timeout: 10_000 }
    )
  );
  const moved = await page.evaluate((before) => {
    const now = Array.from(
      document.querySelectorAll('[data-testid="workstream-continue-host"]')
    ).map((node) => {
      const box = node.getBoundingClientRect();
      return {
        hostId: node.getAttribute("data-host-id"),
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.round(box.width),
      };
    });
    return before
      .map((was, index) => ({ was, now: now[index] }))
      .filter(
        (pair) =>
          pair.now === undefined ||
          pair.was.x !== pair.now.x ||
          pair.was.y !== pair.now.y ||
          pair.was.width !== pair.now.width
      );
  }, shape.boxes);
  if (moved.length > 0) {
    throw new Error(
      `피커 위계: 하나를 누르자 버튼들이 움직였다 (${JSON.stringify(moved)}). 포인터가 아직 그 자리에 있다`
    );
  }
  console.log(
    `picker: 진행 중에도 ${shape.boxes.length}개 버튼의 좌표와 폭이 모두 그대로다`
  );
  release();
  await claim("피커 위계", () =>
    page.waitForFunction(
      () =>
        document.querySelector(
          '[data-testid="workstream-continue-host"][data-busy]'
        ) === null,
      undefined,
      { timeout: 10_000 }
    )
  );
  await page.unroute("**/resume");
  // 끊긴 요청은 실패로 끝나므로 피커는 그대로 열려 있고, 원장은 손대지 않았다.
  if ((await page.getByTestId("workstream-continue-host").count()) !== 3) {
    throw new Error(
      "피커 위계: 폭을 재는 동안 이어받기가 성사돼 버렸다. 아래 왕복 단정이 잴 것이 남지 않는다"
    );
  }
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
  if (
    (await text(first.getByTestId("workstream-goal"))) !==
    state.workstreams[0].goal
  ) {
    throw new Error("목록 렌더: the goal sentence is not the row's headline");
  }
  // ---- 9. 목록 목표 말줄임 (MOMO-679 M4) ------------------------------------
  await assertGoalFold(page);
  if ((await text(first.getByTestId("workstream-starter"))) !== "김서연") {
    throw new Error(
      "목록 렌더: 행이 이 목표를 시작한 사람을 말하지 않는다. 접두사가 같은 두 목표를 가르는 두 번째 사실이다"
    );
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
  // ---- 10. 에이전트 소유자 병기 (MOMO-679 M6) -------------------------------
  // "A -> 에이전트 -> C" 원장에서 가운데 칸의 책임 주체. 토큰 색만으로는 그
  // 에이전트를 누구에게 물어야 하는지가 화면에 없다(skill §9).
  const agentOwner = await text(agentRow.getByTestId("workstream-run-owner"));
  if (agentOwner !== "managed by 곽성재") {
    throw new Error(
      `에이전트 소유자 병기: 에이전트 실행이 책임 주체를 말하지 않는다 (${agentOwner || "없음"})`
    );
  }
  const aliceRow = page.locator(
    `li[data-testid="workstream-run-row"][data-run-id="${aliceRunId}"]`
  );
  if ((await aliceRow.getByTestId("workstream-run-owner").count()) !== 0) {
    throw new Error(
      "에이전트 소유자 병기: 사람 실행에까지 소유자가 붙었다. 사람은 누구에게도 관리되지 않는다"
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
  const toggle = page.getByTestId("workstream-continue-toggle");
  const closedToggleFill = await toggle.evaluate(
    (node) => getComputedStyle(node).backgroundColor
  );
  await toggle.click();
  const targets = page.getByTestId("workstream-continue-host");
  await claim("이어받기 왕복", () => targets.first().waitFor({ timeout: 10_000 }));
  const targetIds = await targets.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-host-id"))
  );
  // 셋: workspace scope 하나, 읽는 사람 소유의 member scope 하나, 그리고 v1부터
  // 있던 것. 죽은 소스 호스트·꺼진 러너·남의 개인 호스트는 여전히 빠진다.
  // 순서는 `workSessionResumeTargets`의 것이다(displayName localeCompare "ko",
  // 한글이 라틴 앞). 순서까지 적어두는 이유는 아래 왕복 단정이 "첫 번째"가 아니라
  // 이름으로 호스트를 고르기 때문이다: 정렬이 바뀌면 여기서 먼저 실패한다.
  const expectedTargets = [liveHostId, spareHostId, runnerHostId];
  if (JSON.stringify(targetIds) !== JSON.stringify(expectedTargets)) {
    throw new Error(
      `이어받기 왕복: host eligibility drifted from the server boundary (${JSON.stringify(targetIds)})`
    );
  }

  // ---- 8. 피커 위계와 폭 (MOMO-679 M3) -------------------------------------
  await assertPickerHierarchy(page, closedToggleFill);

  const resumeResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().toLowerCase().includes("/resume")
  );
  // 첫 번째가 아니라 이름으로 고른다. 자격 호스트가 셋이 된 뒤로 "첫 번째"는
  // 정렬 순서에 달린 값이고, 이 단정이 확인하려는 것은 **누른 그 호스트**가
  // 요청에 실린다는 것이다.
  await page
    .locator(
      `[data-testid="workstream-continue-host"][data-host-id="${liveHostId}"]`
    )
    .click();
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

/**
 * 원장과 세션 사이를 양쪽으로 걸어간다 (MOMO-679 M5).
 *
 * v1의 실행 이력은 읽을 수만 있었다. 한 실행이 무엇을 했는지는 작업 세션
 * 상세가 답하는데 거기로 가는 길이 없었고, 반대로 세션 상세에서 그 실행이 속한
 * 목표로 돌아오는 길도 없어서 작업 흐름 표면은 사이드바에서 출발할 때만 도달
 * 가능했다. 두 링크는 한 쌍이므로 한 번의 왕복으로 함께 잰다: 목표 -> 실행 ->
 * 목표가 같은 목표로 돌아오지 않으면 둘 중 하나는 다른 곳을 가리키고 있다.
 */
async function assertLedgerRoundTrip(browser) {
  const state = newState("member");
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await installRealtimeSocket(page);
  await installRoutes(context, state);
  await login(page);
  await page.goto(`${origin}/#/workstreams/${activeWorkstreamId}`);
  await claim("원장 역링크", () =>
    page.getByTestId("workstream-run-list").waitFor({ timeout: 15_000 })
  );

  const row = page.locator(
    `li[data-testid="workstream-run-row"][data-run-id="${agentRunId}"] [data-testid="workstream-run-link"]`
  );
  const href = await row.getAttribute("href");
  if (
    !href?.includes(`/c/${channelId}`) ||
    !href.toLowerCase().includes(`work=${agentRunId}`)
  ) {
    throw new Error(
      `원장 역링크: 실행 행이 그 실행으로 가지 않는다 (${href}). 채널과 세션을 함께 말해야 작업 세션 패널이 열린다`
    );
  }
  await row.click();

  // 도착: 그 채널의 작업 세션 패널이 그 세션을 펴고 있다.
  await claim("원장 역링크", () =>
    page.getByTestId("work-detail").waitFor({ timeout: 15_000 })
  );
  const landedLabel = await text(page.getByTestId("work-detail-status"));
  if (landedLabel === "") {
    throw new Error("원장 역링크: 세션 상세가 열렸는데 상태를 말하지 않는다");
  }
  // 주소는 패널의 상태를 두 번 말하지 않는다: 한 번 읽고 지운다.
  if (page.url().includes("work=")) {
    throw new Error(
      `원장 역링크: 열쇠가 주소에 남았다 (${page.url()}). 패널을 닫아도 주소는 계속 열려 있다고 말하게 된다`
    );
  }

  // 돌아오는 길.
  const back = page.getByTestId("work-detail-workstream");
  await claim("원장 역링크", () => back.waitFor({ timeout: 15_000 }));
  const backText = await text(back);
  if (!backText.includes("릴리스 회귀 재현")) {
    throw new Error(
      `원장 역링크: 세션이 어느 목표의 실행인지 말하지 않는다 (${backText})`
    );
  }
  await back.click();
  await claim("원장 역링크", () =>
    page.getByTestId("workstream-detail-route").waitFor({ timeout: 15_000 })
  );
  const returned = await text(page.getByTestId("workstream-detail-goal"));
  if (returned !== state.workstreams[0].goal) {
    throw new Error(
      `원장 역링크: 돌아온 곳이 출발한 목표가 아니다 (${returned})`
    );
  }
  console.log(
    "round trip: 목표 -> 실행(작업 세션 패널) -> 같은 목표. 두 링크가 한 쌍으로 맞는다"
  );
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

/**
 * 전환이 끝난 뒤에 찍는다 (MOMO-679 Low).
 *
 * `waitFor`는 노드가 붙는 순간 풀리고, 그 순간 사이드바의 현재 표시와 행 hover
 * 배경은 아직 150ms짜리 `transition-colors` 중간에 있다. v1 캡처에서 활성 내비
 * 항목이 표시가 없는 것처럼 보였던 것이 그 결과였고, 리뷰는 그것을 제품의
 * 문제로 읽을 수밖에 없었다. 두 프레임을 기다린 뒤 진행 중인 애니메이션이
 * 남아 있지 않은지 확인한다.
 */
async function settle(page) {
  await page.evaluate(
    () =>
      new Promise((done) => {
        requestAnimationFrame(() => requestAnimationFrame(() => done(null)));
      })
  );
  await page.waitForFunction(
    () => document.getAnimations().every((animation) => animation.playState !== "running"),
    undefined,
    { timeout: 5_000 }
  );
}

async function captureScreens(browser) {
  mkdirSync(outDir, { recursive: true });
  const shots = [];
  for (const scheme of ["light", "dark"]) {
    const state = newState("member");
    // 픽스처의 목표는 이미 두 줄을 넘는다(newState). 긴 한국어 목표가 상세에서
    // 어떻게 접히는지 — 어절에서 끊는가, 음절 한가운데서 끊는가(MOMO-676 M-5) —
    // 는 단정이 아니라 캡처로만 보이고, 1R H3이 지적한 것이 정확히 그 자리다.
    // 같은 문장을 목록은 두 줄로 접고 상세는 끝까지 펴므로, 한 문장이 두 주장을
    // 다 보여준다.
    //
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
    await settle(page);
    const listShot = resolve(outDir, `list-${scheme}.png`);
    await page.screenshot({ path: listShot });
    shots.push(listShot);

    await page.goto(`${origin}/#/workstreams/${activeWorkstreamId}`);
    await claim("캡처", () =>
      page.getByTestId("workstream-run-list").waitFor({ timeout: 15_000 })
    );
    await settle(page);
    const detailShot = resolve(outDir, `detail-${scheme}.png`);
    await page.screenshot({ path: detailShot });
    shots.push(detailShot);

    // 호스트 피커가 열린 화면. 다중 호스트를 아무도 본 적이 없었다는 것이 M3
    // 지적의 절반이었고(픽스처가 언제나 하나만 줬다), 위계와 라벨과 폭은 셋 다
    // 이 화면에서만 눈으로 확인된다.
    await page.getByTestId("workstream-continue-toggle").click();
    await claim("캡처", () =>
      page
        .getByTestId("workstream-continue-host")
        .first()
        .waitFor({ timeout: 15_000 })
    );
    await settle(page);
    const pickerShot = resolve(outDir, `picker-${scheme}.png`);
    await page.screenshot({ path: pickerShot });
    shots.push(pickerShot);

    // 끝난 목표. 새로 생긴 문장이 사는 유일한 자리이고, 리뷰가 읽을 수 있어야 한다:
    // 완료 칩 아래에서 이어받기가 사라지되 실행 이력은 남는다는 것이 이 화면의 주장
    // 전부다(1R M1).
    await page.goto(`${origin}/#/workstreams/${doneWorkstreamId}`);
    await claim("캡처", () =>
      page
        .locator('[data-testid="workstream-continue"][data-state="closed"]')
        .waitFor({ timeout: 15_000 })
    );
    await settle(page);
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
      await assertLedgerRoundTrip(browser);
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
    "           sharing one right edge, one tab stop on the filter, no takeover offered"
  );
  console.log(
    "           under a finished goal, a host picker whose siblings hold still while one is"
  );
  console.log(
    "           busy, a two-line goal fold in the list, and the ledger walking to a session"
  );
  console.log("           and back to the same goal.");
  console.log(`screenshots: ${captured.join(", ")}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
