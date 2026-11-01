#!/usr/bin/env node
// GATE: W-AP1 웹 승인함 — 목록 다섯 갈래 + 결정 왕복.
//
// 이 표면은 이 제품에서 되돌릴 수 없는 유일한 액션 계열을 다루므로, 단위 테스트가
// 고정한 순수 판정(src/features/inbox/approvalsPanel.ts)이 실제로 DOM까지 도달하는지를
// 여기서 한 번 더 본다. 다섯 시나리오는 전부 픽스처 서버가 만들고, 승인 원장 라우트만
// 갈래마다 다르게 답한다:
//
//   list        pending 2건 + 이미 결정된 1건이 pending 페이지에 섞여 온다.
//               결정 컨트롤은 대기 행에만 붙어야 하고, 결정 왕복이 200으로 닫혀야 한다.
//   superseded  결정 POST가 409 + 결정된 영수증. "이미 결정됨"은 상태 전이이지 사고가
//               아니므로 role="status"여야 한다(role="alert" + --danger면 실패).
//   absent      목록이 본문 없는 404. 아직 배포되지 않은 서버의 답이고, 장애가 아니라
//               미제공으로 접혀야 한다.
//   error       승인 원장만 500(서버 투영은 정상·빈 배열, #5092 D2). 진짜 장애라 「비어 있어요」가 아니라
//               오류 배너 + [다시 시도]가 서야 하고(전체·처리할 일 탭 모두), 원장이 다시 답하면 줄이 선다.
//   projection-error  서버 투영이 500, 승인 원장은 정상. 인박스의 원천이 답하지 못한 장애다.
//   empty       목록이 200 + 빈 배열. 조용한 인박스는 설계가 작동한 모습이다.
//   loading     승인 원장만 늦게 답한다(서버 투영은 즉시, #5092 D3). 원장을 기다리는 동안은 「비어 있어요」가
//               아니라 로딩 막대여야 한다.
//   spawn       ADR-0125 D6-A 호스트 선택기 (이슈 1114). 스폰 승인 한 건이 후보 넷을
//               싣고 온다: 자격 둘 + 오프라인 하나 + T3 예약 하나. 자격 없는 둘은
//               **숨지 않고** 사유와 함께 서고, 라디오는 눌리지 않으며, 그 id는
//               결정 본문에 실리지 않는다.
//   spawn-forbidden  결정 POST가 403. 카드가 그려진 뒤 호스트가 꺼진 경우이고
//               (서버 `resolve_host_choice`의 세 번째 검사), 결정은 **기록되지
//               않았다**. 영수증이 아니라 오류로 그려져야 하고 픽커는 남아야 한다.
//   spawn-blocked    자격 있는 후보가 0. 서버가 409로 답할 것을 결정 **전에**
//               말한다: 승인 버튼이 실제로 불가용하고 그 옆에 이유가 선다.
//
// 결정한 승인(#5092 D1): 인박스 패널은 고른 줄의 스냅샷을 들고 있어서 원장이 그 행을 대기에서 뺀 뒤에도
// 같은 승인이 패널에 남는다. 결정이 닿으면 승인·거부 컨트롤은 사라지고(두 번째 결정이 나갈 길이 없다)
// 그 자리에 결정 결과가 서며, 초점은 사라진 버튼이 아니라 패널이 받는다. 원장이 다시 답한 뒤에도 같다.
//
// 결정 영수증은 **두 와이어를 함께 돌린다**(2R N2): 승인 갈래는 snake_case(Swift
// 서버), 거부 갈래는 camelCase(Rust 서버). 한 표기만 검사하면 다른 표기 앞에서
// 조용히 무너지는 파서를 초록으로 통과시킨다.
//
// 목 응답에는 갈래마다 다른 지연을 넣는다(#839 교훈): 같은 tick에 답하는 목은
// 로딩/포커스 단정을 헛초록으로 만든다.
//
// 뷰포트는 900x600이다. 이 레포에는 결정 컨트롤이 화면 밖으로 밀린 전과가 두 번
// 있으므로, 확정 버튼이 뷰포트 안에 있는지를 좌표로 재서 단언한다.
//
// 이름 있는 red proof, 버려도 되는 워크트리에서만 실행:
//   APPROVALS_GATE_PROVE_RED_SETTLED=1 npm run gate:approvals
//     expected failure: "settled row control"
//     (픽스처가 이미 결정된 행을 pending이라고 답한다 = 서버가 거짓말하는 경우.
//      단언이 '대기 행 수'가 아니라 '컨트롤 수'를 실제로 세고 있음을 증명한다.)
//   APPROVALS_GATE_PROVE_RED_SUPERSEDED=1 npm run gate:approvals
//     expected failure: "superseded stays a note"
//     (409 대신 500으로 답한다 = 진짜 장애. 단언이 색/role을 보고 있음을 증명한다.)
//   APPROVALS_GATE_PROVE_RED_ABSENT=1 npm run gate:approvals
//     expected failure: "absent folds to 미제공"
//     (404 대신 500으로 답한다. 단언이 404와 5xx를 구분함을 증명한다.)
//
// 이슈 1114가 더한 red proof 넷. 전부 픽스처만 바꾼다:
//   APPROVALS_GATE_PROVE_RED_UNSELECTABLE=1
//     expected failure: "unselectable host stays unpickable"
//     (오프라인 후보를 `selectable: true`로 답한다 = 서버가 자격을 잘못 말한 경우.
//      단언이 `selectable`을 실제로 읽어 라디오를 잠그고 있음을 증명한다.)
//   APPROVALS_GATE_PROVE_RED_DEFAULT=1
//     expected failure: "default host preselected"
//     (`default_host_id`를 두 번째 자격 호스트로 옮긴다. 단언은 첫 번째를 이름으로
//      기대하므로, 화면이 **payload의 기본값을 따라간다**는 사실이 붉게 드러난다 —
//      위치나 순서로 고르고 있었다면 이 이음매는 아무것도 바꾸지 못한다.)
//   APPROVALS_GATE_PROVE_RED_FORBIDDEN=1
//     expected failure: "forbidden host is refused"
//     (403 대신 200 + 승인 영수증으로 답한다. 단언이 거절을 「결정됨」과 구분함을
//      증명한다 — 기록되지 않은 결정을 기록됐다고 말하는 것이 이 갈래의 위험이다.)
//   APPROVALS_GATE_PROVE_RED_BLOCKED=1
//     expected failure: "no eligible host blocks approve"
//     (자격 0 시나리오에서 오프라인 후보 하나를 `selectable: true`로 답한다.
//      단언이 후보 목록을 읽어 승인 버튼을 끄고 있음을 증명한다.)
//
// `commit control viewport`에는 이음매가 없고, 그 이유를 적어 둔다(2R M4 실측).
// 창을 240px로 줄여도 이 단언은 붉어지지 않는다 — 무장 시 초점이 확정 버튼으로
// 옮겨 가고(H2), 브라우저의 `focus()`가 그 요소를 화면 안으로 끌어오기 때문이다.
// 즉 이 표면에서 "결정하려는 순간 확정 버튼이 화면 밖"은 **초점 이동이 살아 있는
// 한 일어날 수 없다**. 그래서 이 측정은 그 보장에 걸어 둔 덫이고, 그것을 무너뜨리는
// red proof는 아래 `arm focus`가 이미 갖고 있다(초점 이동을 지우면 이름을 부르며
// 실패한다). 초점 이동을 지운 채 창까지 줄이면 `escape disarms`가 먼저 붉어진다 —
// 초점이 컨테이너 밖으로 나가면 Esc 핸들러에 키가 닿지 않기 때문이다.
//
// 제품 소스를 되돌려야 하는 red proof 셋 — Esc 해제(H2), 키 반복 가드(H3),
// 무장 가드 시간(H3) — 은 각각 이 게이트의 "escape disarms" · "held enter guard" ·
// "arm guard window"를 이름으로 부르며 실패시킨다. 그 증거는 PR 본문에 있다.
//
// 붉은 이음매는 전부 픽스처의 행동만 바꾼다. 제품 소스 줄을 지웠다 되돌리라고
// 리뷰어에게 요구하지 않으므로 반복 실행할 수 있다. 반대로 **조건 분기를 부수는**
// 쪽의 red proof는 src/features/inbox/approvalsPanel.test.ts가 갖는다.
//
// #5092가 더한 단정은 이음매가 없다: 결함이 서버가 아니라 화면에 있어서 픽스처로는 만들 수 없다.
// 제품 소스를 되돌려야 하고, 각각 이름을 부르며 실패한다(증거는 PR 본문):
//   InboxDetail이 결정한 승인임을 컨트롤 판정에 넘기는 줄(`settled: settledLine !== null`)을 지우면 "decided row control",
//   결정이 닿을 때 패널로 초점을 옮기는 줄(`panelRef.current?.focus()`)을 지우면 "commit focus",
//   useMailbox가 승인 원장의 오류를 접는 줄(`ledgerFailed`)을 지우면 "ledger error (전체)",
//   승인 원장의 로딩을 접는 줄(`ledgerLoading`)을 지우면 "loading state".

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "./preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.APPROVALS_GATE_PORT || 5188);
const origin = `http://127.0.0.1:${port}`;

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const agentId = "AAAAAAAA-AAAA-7AAA-8AAA-AAAAAAAAAAP1";
const channelId = "00000000-0000-7000-8000-000000000201";
const runId = "00000000-0000-7000-8000-000000000301";
const pendingId = "BBBBBBBB-BBBB-7BBB-8BBB-BBBBBBBBBB01";
const secondPendingId = "BBBBBBBB-BBBB-7BBB-8BBB-BBBBBBBBBB02";
const settledId = "BBBBBBBB-BBBB-7BBB-8BBB-BBBBBBBBBB03";
const spawnId = "BBBBBBBB-BBBB-7BBB-8BBB-BBBBBBBBBB04";

// 호스트 후보 넷 — ADR-0125 D6-A가 이름 붙인 3택 + 자격을 잃은 로컬 하나.
const localHostId = "CCCCCCCC-CCCC-7CCC-8CCC-CCCCCCCCCC01";
const remoteHostId = "CCCCCCCC-CCCC-7CCC-8CCC-CCCCCCCCCC02";
const deadHostId = "CCCCCCCC-CCCC-7CCC-8CCC-CCCCCCCCCC03";
const cloudHostId = "CCCCCCCC-CCCC-7CCC-8CCC-CCCCCCCCCC04";

const proveRedSettled = process.env.APPROVALS_GATE_PROVE_RED_SETTLED === "1";
const proveRedSuperseded =
  process.env.APPROVALS_GATE_PROVE_RED_SUPERSEDED === "1";
const proveRedAbsent = process.env.APPROVALS_GATE_PROVE_RED_ABSENT === "1";
const proveRedUnselectable =
  process.env.APPROVALS_GATE_PROVE_RED_UNSELECTABLE === "1";
const proveRedDefault = process.env.APPROVALS_GATE_PROVE_RED_DEFAULT === "1";
const proveRedForbidden = process.env.APPROVALS_GATE_PROVE_RED_FORBIDDEN === "1";
const proveRedBlocked = process.env.APPROVALS_GATE_PROVE_RED_BLOCKED === "1";

// 시계는 픽스처가 소유한다. 만료 라벨("12분 후 만료")이 실행 시각에 따라 흔들리면
// 이 게이트는 자기가 재지 않은 것 때문에 붉어진다.
const nowMs = Date.UTC(2026, 7, 4, 3, 0, 0);

const session = {
  accessToken: "gate-only-not-a-credential",
  refreshToken: "gate-only-not-a-credential",
  member: {
    id: memberId,
    workspaceId,
    kind: "human",
    displayName: "곽성재",
    handle: "seongjae",
  },
  realtimeWebSocketUrl: "ws://approvals-gate.invalid/connection/websocket",
};

const roster = [
  {
    id: memberId,
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
    id: agentId,
    workspaceId,
    kind: "agent",
    status: "active",
    role: "member",
    displayName: "김인턴",
    handle: "kim-intern",
    channelCount: 1,
    channelIds: [channelId],
    capabilities: ["work.exec"],
    ownerHumanId: memberId,
    agentModel: "hermes-agent",
    createdAtMs: 0,
    updatedAtMs: 0,
  },
];

// 승인 원장의 와이어 모양은 momo-core `isWireApproval`이 읽는 그대로다
// (packages/momo-core/src/lib/api.ts): snake_case, Swift `ApprovalProjectionDTO`의
// CodingKeys와 같다.
function wireApproval(overrides) {
  return {
    id: pendingId,
    workspace_id: workspaceId,
    run_id: runId,
    channel_id: channelId,
    requested_by: agentId,
    action_type: "work.exec",
    payload: {},
    status: "pending",
    expires_at_ms: nowMs + 12 * 60_000,
    ...overrides,
  };
}

const pendingApprovals = [
  wireApproval({}),
  wireApproval({
    id: secondPendingId,
    action_type: "workspace.file_write_and_reindex",
    is_reversible: false,
    expires_at_ms: nowMs + 45 * 60_000,
  }),
];

/**
 * pending 페이지에 섞여 온 **이미 결정된 행**.
 *
 * 지어낸 상황이 아니다: 목록을 읽은 순간과 화면이 그려지는 순간 사이에 폰 푸시에서
 * 결정이 나면 서버는 이 행을 이미 결정된 상태로 들고 있다. 그때 결정 컨트롤이
 * 따라 붙으면 사람은 끝난 일을 되돌릴 수 있다고 읽는다.
 */
const settledApproval = wireApproval({
  id: settledId,
  status: proveRedSettled ? "pending" : "approved",
  decided_by: memberId,
  decided_at_ms: nowMs - 90_000,
  expires_at_ms: undefined,
});

/**
 * 스폰 승인의 `execution` — **서버가 실제로 내는 그 모양** (`spawn_execution_object`
 * 실측). snake_case이고, `unavailable_reason`까지 그대로다.
 *
 * 픽스처가 서버보다 친절하면 화면의 거짓말이 게이트에 잠긴다. 특히 자격 없는 둘을
 * 빼고 싶은 유혹이 있는데, 그것을 빼는 순간 이 게이트는 「사유와 함께 세운다」는
 * 이 배치의 논점을 아예 못 본다.
 */
function spawnExecution({ blocked = false } = {}) {
  const dead = {
    host_id: deadHostId,
    display_name: "낡은 맥",
    host_type: "app",
    tier: "local",
    scope: "member",
    online: false,
    // red seam: 서버가 자격을 잘못 말했다고 치면, 화면이 `selectable`을 실제로
    // 읽고 있는지가 드러난다.
    selectable: blocked ? proveRedBlocked : proveRedUnselectable,
    unavailable_reason: "offline",
  };
  const cloud = {
    host_id: cloudHostId,
    display_name: "momo Cloud",
    host_type: "cloud",
    tier: "cloud",
    scope: "workspace",
    online: true,
    selectable: false,
    unavailable_reason: "t3_disabled",
  };
  const local = {
    host_id: localHostId,
    display_name: "내 맥",
    host_type: "app",
    tier: "local",
    scope: "member",
    online: true,
    selectable: true,
    unavailable_reason: null,
  };
  const remote = {
    host_id: remoteHostId,
    display_name: "팀 VPS",
    host_type: "workd",
    tier: "remote",
    scope: "workspace",
    online: true,
    selectable: true,
    unavailable_reason: null,
  };
  return {
    kind: "work_session_spawn",
    tool: "codex",
    label: "리팩터링",
    requested_host_id: null,
    // red seam: 기본값을 두 번째 자격 호스트로 옮긴다. 아래 단언은 첫 번째를
    // **이름으로** 기대하므로, 화면이 payload의 기본값을 따라간다는 사실이 여기서
    // 붉게 드러난다.
    default_host_id: blocked
      ? null
      : proveRedDefault
        ? remoteHostId
        : localHostId,
    host_candidates: blocked ? [dead, cloud] : [local, remote, dead, cloud],
  };
}

/** 픽커가 붙는 대기 승인 한 건. */
function spawnApproval({ blocked = false } = {}) {
  return wireApproval({
    id: spawnId,
    action_type: "tool_call",
    payload: {
      run_id: runId,
      action_type: "tool_call",
      tool_call: {
        call_id: "call-spawn",
        name: "work.session.spawn",
        arguments: '{"tool":"codex","label":"리팩터링"}',
      },
      approval_reason: "spawn requires a human",
      resume_model: "gpt-5.6",
      execution: spawnExecution({ blocked }),
    },
    expires_at_ms: nowMs + 30 * 60_000,
  });
}

/** 카드가 낸 목록 밖의 호스트에 서버가 답하는 모양 (`resolve_host_choice`). */
const forbiddenReceipt = {
  approvalId: spawnId,
  status: "forbidden",
  decidedAtMs: nowMs,
  decisionReason: "selected host is not one of this approval's candidates",
};

const decisionReceipt = {
  approval_id: pendingId,
  status: "approved",
  decided_by: memberId,
  decided_at_ms: nowMs,
};

const supersededReceipt = {
  approval_id: pendingId,
  status: "approved",
  decided_by: "00000000-0000-7000-8000-000000000103",
  decided_at_ms: nowMs - 30_000,
};

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

/** 본문 없는 404. 라우트를 싣지 않은 서버가 실제로 돌려주는 모양이다. */
function bodilessNotFound(route, status = 404) {
  return route.fulfill({ status, contentType: "text/plain", body: "" });
}

function wait(ms) {
  return new Promise((done) => setTimeout(done, ms));
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
                connect: { client: "approvals-gate", version: "6" },
              };
            }
            if (command.subscribe) {
              return {
                id: command.id,
                subscribe: {
                  recoverable: true,
                  positioned: true,
                  recovered: false,
                  epoch: "approvals-gate",
                  offset: 0,
                },
              };
            }
            // 응답 없는 unsubscribe는 centrifuge를 disconnect로 몰고, 그러면
            // useOffline이 참이 되어 결정 컨트롤이 통째로 오프라인 문구로 바뀐다
            // (gate-agent-hub이 같은 함정을 이미 밟았다).
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

/**
 * @param scenario 승인 목록 라우트가 어떻게 답하는가.
 * @param delayMs  그 답이 얼마나 늦게 오는가. 같은 tick에 답하는 목은 로딩 단정을
 *                 헛초록으로 만든다.
 */
async function installRoutes(context, scenario, delayMs) {
  // `ledgerFails`: error 시나리오의 승인 원장이 지금 5xx로 답하는가. 테스트가 꺼서 「다시 시도」가 원장을
  // 다시 읽는지 잰다.
  const state = {
    decisions: [],
    listCalls: 0,
    decidedIds: new Set(),
    ledgerFails: scenario === "error",
  };

  await context.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path === "/v1/auth/login") return json(route, session);
    if (path === "/v1/auth/realtime-token") {
      return json(route, {
        token: "gate-realtime-token",
        tokenType: "Bearer",
        expiresAtMs: nowMs + 60_000,
        ttlSeconds: 60,
        workspaceId,
        memberId,
      });
    }
    if (path === "/v1/auth/refresh") {
      return json(route, {
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
      });
    }
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/channels")) {
      return json(route, {
        channels: [
          {
            id: channelId,
            workspaceId,
            kind: "public",
            name: "배포",
            muted: false,
          },
        ],
      });
    }
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    // 인박스는 서버 투영(`GET /inbox`, ADR-0199)이 원천이고 처리할 일(승인)은 클라이언트가 아래 `/approvals`를
    // 따로 합친다. 이 게이트가 재는 것은 승인이므로 투영은 비어 있다. 이 줄이 없으면 포괄 응답 `{}`가
    // 파싱에 실패해 인박스가 「불러오지 못했어요」로 서고 승인 행은 영영 그려지지 않는다(#5048).
    if (path.endsWith("/inbox")) {
      // 투영은 늘 즉시 답한다: 승인 원장만 늦거나 실패하는 갈래(`loading`·`error`)가 투영이 이미 답한 뒤에도
      // 「비어 있어요」로 접히지 않는지를 잰다(#5092 D2·D3). 두 원천이 함께 붙들리면 이 단정은 승인 원장이 아니라
      // 투영을 재게 된다.
      // 진짜 장애: 인박스의 원천(투영)이 5xx로 답하지 못한다. 승인 원장은 정상이다.
      if (scenario === "projection-error") {
        return json(route, { error: { message: "internal error" } }, 500);
      }
      return json(route, { items: [], nextCursor: null });
    }

    // 결정 POST. 목록보다 먼저 검사한다: 경로가 …/approvals/{id}/decision 이라
    // 목록 검사에 먼저 걸리면 결정이 목록으로 답해 버린다.
    if (path.endsWith("/decision") && request.method() === "POST") {
      const body = request.postDataJSON();
      state.decisions.push(body);
      await wait(delayMs);
      if (scenario === "spawn-forbidden") {
        // 카드가 그려진 뒤 호스트가 꺼진 경우다. 서버는 결정을 **기록하지 않고**
        // 403 + 영수증 스키마로 답한다. red seam은 200 + 승인 영수증으로 답한다.
        return proveRedForbidden
          ? json(route, { ...decisionReceipt, approval_id: spawnId }, 200)
          : json(route, forbiddenReceipt, 403);
      }
      if (scenario === "superseded") {
        if (proveRedSuperseded) {
          return json(route, { error: { message: "internal error" } }, 500);
        }
        return json(route, supersededReceipt, 409);
      }
      // 2R M5: 픽스처가 `approve`를 **읽는다**. 거부 왕복이 승인 영수증을 받아
      // 놓고 초록으로 남는 일이 없도록, 원장이 실제로 답하는 것과 같은 상태를
      // 돌려준다. 이 한 줄이 없으면 거부 시나리오는 자기가 무엇을 검사하는지
      // 모르는 채 통과한다.
      // 2R N2: 거부 갈래만 **camelCase 영수증**으로 답한다. 이 레포에는 서버가
      // 두 대 살고(Swift=snake, Rust=camel), 한 표기만 검사하면 다른 표기 앞에서
      // 조용히 무너지는 코드를 초록으로 통과시킨다. 승인 갈래는 snake로 남겨
      // 두 와이어가 같은 게이트 안에서 함께 돌게 한다.
      if (!body.approve) {
        state.decidedIds.add(String(body.approval_id).toLowerCase());
        return json(route, {
          approvalId: body.approval_id,
          status: "rejected",
          decidedBy: memberId,
          decidedAtMs: nowMs,
        });
      }
      state.decidedIds.add(String(body.approval_id).toLowerCase());
      return json(route, {
        ...decisionReceipt,
        approval_id: body.approval_id,
        status: "approved",
      });
    }

    if (path.endsWith("/approvals")) {
      state.listCalls += 1;
      await wait(delayMs);
      const status = url.searchParams.get("status");
      if (scenario === "absent") {
        return bodilessNotFound(route, proveRedAbsent ? 500 : 404);
      }
      if (scenario === "error" && state.ledgerFails) {
        return json(route, { error: { message: "internal error" } }, 500);
      }
      if (scenario === "empty") return json(route, { approvals: [] });
      if (status !== "pending") return json(route, { approvals: [] });
      if (scenario === "spawn" || scenario === "spawn-forbidden") {
        // 스폰 한 건만 답한다. 픽커가 붙은 행과 안 붙은 행이 섞이면 test id가
        // 어느 행의 라디오를 가리키는지 말할 수 없다.
        return json(route, { approvals: [spawnApproval()] });
      }
      if (scenario === "spawn-blocked") {
        return json(route, { approvals: [spawnApproval({ blocked: true })] });
      }
      // 결정된 행은 원장이 다시 읽을 때 대기 목록에서 빠진다(서버 답으로만 바뀐다 — 클라이언트가 흉내 내지 않는다).
      return json(route, {
        approvals: [
          ...pendingApprovals.filter(
            (approval) => !state.decidedIds.has(String(approval.id).toLowerCase())
          ),
          settledApproval,
        ],
      });
    }

    if (path.includes("/messages")) return json(route, { messages: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    return json(route, {});
  });

  return state;
}

async function openInbox(page) {
  await page.goto(origin, { waitUntil: "networkidle" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("approvals@example.test");
  await page.getByTestId("login-password").fill("gate-only");
  await page.getByTestId("login-submit").click();
  // 목적지는 펼친 사이드바의 목록 열에 산다(`nav-inbox`). `rail-inbox`는 ⌘B로 접은 레일에만 서므로(WorkspaceRail,
  // #3334) 펼친 채로 열리는 이 하네스는 그것을 영영 못 찾았다(#5048).
  await page.getByTestId("nav-inbox").waitFor();
  await page.getByTestId("nav-inbox").click();
  await page.getByTestId("inbox-route").waitFor();
}

/**
 * 인박스는 메일함이다(#3663, ADR-0199): 왼쪽 목록의 한 줄(`mailbox-row`)을 고르면 오른쪽 패널이 그 맥락을 열고,
 * 결정 컨트롤은 그 **패널**에 선다. 옛 판처럼 행마다 컨트롤이 붙어 있지 않으므로 결정을 재는 시나리오는 먼저
 * 처리할 일 탭에서 줄을 하나 골라야 한다(#5048). `hasText`는 같은 목록의 두 대기 행 중 어느 쪽인지 가른다.
 */
async function openApproval(page, { hasText } = {}) {
  await page.getByTestId("inbox-tab-task").click();
  await page.getByTestId("inbox-list").waitFor();
  const rows = page.getByTestId("mailbox-row");
  await (hasText === undefined ? rows.first() : rows.filter({ hasText }).first()).click();
  await page.getByTestId("inbox-detail").waitFor();
}

async function newPage(browser, scenario, delayMs, { open = true, hasText } = {}) {
  const context = await browser.newContext({
    // 900x600: 이 레포에는 결정 컨트롤이 뷰포트 밖으로 밀린 전과가 두 번 있다.
    viewport: { width: 900, height: 600 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await installRealtimeSocket(page);
  const state = await installRoutes(context, scenario, delayMs);
  await openInbox(page);
  if (open) await openApproval(page, { hasText });
  return { context, page, state };
}

// ---- 시나리오 --------------------------------------------------------------

/** 목록 + 결정 왕복. 승인함이 실제로 폐곡선인지 여기서 닫는다. */
async function exerciseList(browser, delayMs) {
  // 줄을 열지 않은 채 시작한다: 열기 전에는 결정 컨트롤이 어디에도 없어야 한다(아래 ①).
  const { context, page, state } = await newPage(browser, "list", delayMs, {
    open: false,
  });

  // 「처리할 일」 탭이 서 있어야 한다. 이 탭은 approvals 표면이 제공될 때만
  // 세워지므로(mailboxTabs), 판정 플립이 화면에 도달했다는 증거다.
  const tab = page.getByTestId("inbox-tab-task");
  if ((await tab.count()) !== 1) {
    throw new Error(
      "task tab: 승인 표면이 제공되는데도 처리할 일 탭이 서지 않았다"
    );
  }
  await tab.click();

  await page.getByTestId("inbox-list").waitFor();
  const rows = page.getByTestId("mailbox-row");
  // 대기 행 둘뿐이다: pending 페이지에 섞여 온 이미 결정된 행(settledApproval)은 줄이 되지 않는다.
  if ((await rows.count()) !== 2) {
    throw new Error(
      `approval rows: expected 2 pending rows at ${delayMs}ms (the settled one gets no row), got ${await rows.count()}`
    );
  }

  // red proof seam ①: 컨트롤 수를 실제로 센다. 줄을 열기 전에는 컨트롤이 없고, 대기 행을 열면 그 한 건의
  // 컨트롤만 선다. 결정된 행에 컨트롤이 따라 붙으면 줄이 셋이 되어 위에서 먼저 잡힌다.
  const approveButtons = page.getByTestId("inbox-approval-approve");
  if ((await approveButtons.count()) !== 0) {
    throw new Error(
      "decision controls before opening a row: 줄을 열지 않았는데 결정 컨트롤이 서 있다"
    );
  }
  await openApproval(page, { hasText: "명령 실행 허가" });
  const approveCount = await approveButtons.count();
  if (
    approveCount !== 1 ||
    (await page.getByTestId("inbox-approval-reject").count()) !== 1
  ) {
    throw new Error(
      `decision controls: expected one approve + one reject for the opened pending row, got ${approveCount} approve`
    );
  }

  // #3819: 한 번 누르면 결정이다. 확정 단계(무장 → 확정, Esc 해제, 가드 시간)는 걷혔다.
  // 그 자리에서 이 게이트가 지키는 것은 세 가지다: 확정 컨트롤이 어디에도 없고, 마지막
  // 대기 행의 결정 버튼까지 스크롤 없이 닿으며, 길게 누른 Enter가 결정을 한 번만 보낸다.
  if (
    (await page.getByTestId("inbox-approval-confirm").count()) !== 0 ||
    (await page.getByTestId("inbox-approval-commit").count()) !== 0
  ) {
    throw new Error("one-step: 확정 컨트롤이 남아 있다");
  }
  if (state.decisions.length !== 0) {
    throw new Error(
      `one-step: 아무것도 누르지 않았는데 결정이 ${state.decisions.length}건 날아갔다`
    );
  }

  // 밀도 주장: 900x600 한 화면에서 연 대기 행의 결정 컨트롤까지 스크롤 없이 닿는다. `boundingBox()`는 스크롤하지 않으므로 화면 밖이면
  // 좌표가 그대로 밖에 나온다(Playwright의 click은 먼저 스크롤해 답이 항상 참이 된다).
  const lastBox = await approveButtons.last().boundingBox();
  const viewport = page.viewportSize();
  if (
    lastBox === null ||
    lastBox.x < 0 ||
    lastBox.y < 0 ||
    lastBox.x + lastBox.width > viewport.width ||
    lastBox.y + lastBox.height > viewport.height
  ) {
    throw new Error(
      `decision control viewport: ${viewport.width}x${viewport.height}에서 연 행의 승인 버튼이 스크롤 없이 화면 안에 없다 (${JSON.stringify(lastBox)})`
    );
  }

  // **실키 이벤트**. `.click()`으로는 영영 잡히지 않는 결함이다: 브라우저는 <button>
  // 위의 Enter keydown마다 click을 합성한다. 한 번의 길게 누름(repeat=true 반복 keydown)이
  // 결정을 여러 건 보내면 안 된다. Playwright는 두 번째 `down()`부터 repeat=true를 싣는다.
  const beforeListCalls = state.listCalls;
  await approveButtons.first().focus();
  await page.keyboard.down("Enter"); // repeat=false → 결정
  await page.keyboard.down("Enter"); // repeat=true
  await page.keyboard.down("Enter"); // repeat=true
  await page.keyboard.up("Enter");
  await page.getByTestId("inbox-decision-note").waitFor();
  await page.waitForTimeout(delayMs + 300);
  if (state.decisions.length !== 1) {
    throw new Error(
      `decision round-trip: expected exactly 1 POST, got ${state.decisions.length}`
    );
  }
  const sent = state.decisions[0];
  if (
    sent.approve !== true ||
    String(sent.approval_id).toLowerCase() !== pendingId.toLowerCase() ||
    typeof sent.client_decision_id !== "string" ||
    sent.client_decision_id.length === 0
  ) {
    throw new Error(
      `decision body: 승인 결정이 계약대로 나가지 않았다 ${JSON.stringify(sent)}`
    );
  }

  const note = page.getByTestId("inbox-decision-note");
  const noteRole = await note.getAttribute("role");
  const noteText = (await note.textContent()) ?? "";
  if (noteRole !== "status" || !noteText.includes("승인을 기록했어요")) {
    throw new Error(
      `committed note: expected a neutral status note, got role=${noteRole} text=${noteText}`
    );
  }
  // 2R 카피 정본: 계약이 지킬 수 없는 약속을 하지 않는다. 재개는 outbox를 거치는
  // 비동기이고, 실행이 hold를 떠났으면 재개 job은 아예 들어가지 않는다.
  if (/바로 실행|즉시/.test(noteText)) {
    throw new Error(`committed note: 계약을 넘어서는 약속을 했다 (${noteText})`);
  }

  // #5092 D1: 컨트롤을 거두는 것은 서버의 영수증이지 목록의 재조회가 아니다 — 원장이 다시 답하기 **전에** 먼저 잰다.
  await assertDecidedRowSettled(page, "right after the decision", "승인을 기록했어요");

  // 2R M6: 결정 뒤에 초점이 body로 떨어지면 키보드 사용자는 방금 일한 자리를 잃고 문서 맨 위에서 다시 Tab을
  // 시작한다. 눌린 버튼은 결과 줄로 바뀌며 사라지므로 초점은 패널이 받는다(#5092; 옛 판의 「목록 `ul`로 착지」는
  // 목록이 메일함으로 바뀌며 사라졌다, #5048). 결과는 위의 상태 줄(role=status)이 한 번 읽어 주므로 초점은 결과
  // 줄이 아니라 패널에 앉는다.
  const afterCommitFocus = await page.evaluate(() => {
    const active = document.activeElement;
    if (active === null || active === document.body) return "body";
    return active.closest('[data-testid="inbox-detail"]') !== null
      ? "panel"
      : (active.getAttribute("data-testid") ?? active.tagName);
  });
  if (afterCommitFocus === "body") {
    throw new Error("commit focus: 결정 뒤 초점이 문서 몸통으로 버려졌다");
  }
  if (afterCommitFocus !== "panel") {
    throw new Error(
      `commit focus: 결정 뒤 초점이 결정한 패널이 아니라 ${afterCommitFocus}에 있다`
    );
  }

  // 결정 뒤에는 원장을 다시 읽는다. 행이 사라지는 것을 클라이언트가 흉내 내지
  // 않고 서버 답으로만 바꾸기 때문이다.
  await page.waitForTimeout(delayMs + 500);
  if (state.listCalls <= beforeListCalls) {
    throw new Error(
      `ledger refetch: 결정 뒤 목록을 다시 읽지 않았다 (${beforeListCalls} -> ${state.listCalls})`
    );
  }
  // 다시 읽은 원장의 답이 화면에 닿았다: 탭의 대기 수가 둘에서 하나로 줄었다.
  const pendingAfter = Number(
    ((await tab.innerText()).match(/\d+/) ?? ["NaN"])[0]
  );
  if (pendingAfter !== 1) {
    throw new Error(
      `ledger refetch: 원장이 다시 답했는데 처리할 일 수가 1로 줄지 않았다 (${pendingAfter})`
    );
  }
  // 원장이 결정된 행을 대기에서 뺀 뒤에도 패널은 그 승인의 스냅샷으로 남는다: 이때 컨트롤이 다시 서는 것이
  // #5092가 고친 결함이다(탭 수는 2→1로 줄었는데 `inbox-approval-approve`가 그대로 섰다).
  await assertDecidedRowSettled(page, "after the ledger answered again", "승인을 기록했어요");

  await context.close();
}

/**
 * 결정한 승인의 패널 (#5092 D1).
 *
 * 인박스 패널은 고른 줄의 스냅샷을 들고 있어서 원장이 그 행을 대기에서 뺀 뒤에도 같은 승인이 남는다.
 * 그 승인에 승인·거부가 다시 서면 이미 결정된 건에 두 번째 결정이 나간다(서버는 409). 그래서 컨트롤을
 * **세는 것**이 이 단정이다: 결정 직후에도, 원장이 다시 답한 뒤에도 0이어야 하고 그 자리에 결과가 서야 한다.
 */
async function assertDecidedRowSettled(page, when, receipt) {
  const buttons =
    (await page.getByTestId("inbox-approval-approve").count()) +
    (await page.getByTestId("inbox-approval-reject").count());
  if (buttons !== 0) {
    throw new Error(
      `decided row control: 결정한 승인에 승인·거부 컨트롤이 ${buttons}개 남아 있다 (${when})`
    );
  }
  const result = page.getByTestId("inbox-approval-settled");
  const text =
    (await result.count()) === 1 ? ((await result.textContent()) ?? "") : "";
  if (!text.includes(receipt)) {
    throw new Error(
      `decided row result: 컨트롤 자리에 「${receipt}」가 서지 않았다 (${when}) ${JSON.stringify(text)}`
    );
  }
}

/**
 * 두 결과 중 먼저 나타나는 것을 기다린다.
 *
 * `waitFor` 하나를 거는 대신 이렇게 쓰는 이유는 red proof 때문이다. 기대한
 * 엘리먼트만 기다리면 회귀는 10초 타임아웃으로 나타나고, 타임아웃은 **무엇이
 * 틀렸는지 말하지 않는다**. 둘 다 기다리면 실패가 "대신 이것이 그려졌다"로
 * 이름을 갖는다.
 */
async function waitForEither(page, expectedTestId, wrongTestId, label) {
  const expected = page.getByTestId(expectedTestId);
  const wrong = page.getByTestId(wrongTestId);
  const deadline = Date.now() + 10_000;
  for (;;) {
    if ((await expected.count()) > 0) return;
    if ((await wrong.count()) > 0) {
      throw new Error(
        `${label}: expected [${expectedTestId}] but the surface drew [${wrongTestId}] — ` +
          `${((await wrong.first().textContent()) ?? "").trim()}`
      );
    }
    if (Date.now() > deadline) {
      throw new Error(
        `${label}: neither [${expectedTestId}] nor [${wrongTestId}] appeared in 10s`
      );
    }
    await wait(100);
  }
}

/**
 * 거부 왕복 (2R M5) + 영수증이 탭을 따라다니지 않는다 (2R L1).
 *
 * 앞 판의 게이트는 승인만 눌렀고, 픽스처는 무엇을 눌렀든 승인 영수증을 돌려줬다.
 * 그래서 거부 경로 전체 — body의 `approve: false`, 거부 영수증의 해석, 거부 확정
 * 문장 — 가 한 번도 검사되지 않았다. 거부는 승인과 같은 무게의 액션이다.
 */
async function exerciseReject(browser, delayMs) {
  const { context, page, state } = await newPage(browser, "list", delayMs);

  // #3819: 거부도 한 번에 결정된다.
  await page.getByTestId("inbox-approval-reject").first().click();
  await page.getByTestId("inbox-decision-note").waitFor();

  if (state.decisions.length !== 1 || state.decisions[0].approve !== false) {
    throw new Error(
      `reject round-trip: expected one POST with approve=false, got ${JSON.stringify(state.decisions)}`
    );
  }
  const note = page.getByTestId("inbox-decision-note");
  const text = (await note.textContent()) ?? "";
  if (
    (await note.getAttribute("role")) !== "status" ||
    !text.includes("거부를 기록했어요")
  ) {
    throw new Error(`reject receipt: 거부 영수증이 정본이 아니다 (${text})`);
  }
  await assertDecidedRowSettled(page, "after the rejection", "거부를 기록했어요");
  // 계약 실측: 거부는 같은 트랜잭션에서 실행을 취소하지만 그 UPDATE는
  // `WHERE status='awaiting_approval'` 가드에 걸리면 조용히 빠진다. 무조건 참인
  // 것은 "재개되지 않는다"뿐이다.
  if (/취소되었습니다/.test(text)) {
    throw new Error(`reject receipt: 좁은 경합에서 거짓이 되는 문장이다 (${text})`);
  }

  // 2R L1: 이 영수증은 **그 목록에 대한 답**이다. 탭을 옮기면 가리키던 행은
  // 화면에 없는데 줄만 남아, 멘션 목록 위에 "거부를 기록했습니다"가 떠 있게 된다.
  await page.getByTestId("inbox-tab-mention").click();
  await page.waitForTimeout(300);
  if ((await page.getByTestId("inbox-decision-note").count()) !== 0) {
    throw new Error(
      "receipt scope: 탭을 옮겼는데 앞 목록의 결정 영수증이 그대로 남아 있다"
    );
  }
  await context.close();
}

// ---- 이슈 1114: 승인 카드 호스트 선택기 (ADR-0125 D6-A) ---------------------

/** 라디오 하나의 실제 상태. `disabled`는 DOM에서 읽는다 — 클래스가 아니라. */
async function radioState(page, hostId) {
  const radio = page.getByTestId(`inbox-approval-host-radio-${hostId}`);
  if ((await radio.count()) === 0) {
    throw new Error(`host radio: ${hostId} 줄이 아예 그려지지 않았다`);
  }
  return {
    checked: await radio.isChecked(),
    disabled: await radio.isDisabled(),
    label:
      (
        await page
          .getByTestId(`inbox-approval-host-option-${hostId}`)
          .textContent()
      )?.trim() ?? "",
  };
}

/**
 * 픽커가 서는 갈래: 목록 · 기본값 · 잠긴 줄 · 결정 본문.
 *
 * 이 시나리오가 지키는 것은 하나로 요약된다: **화면이 고를 수 있다고 말한 것만
 * 서버로 나간다.** 서버는 같은 것을 두 겹으로 다시 막지만(카드가 낸 목록과의
 * 대조 403 + 결정 시점 재판정), 화면이 고를 수 있는 것처럼 보여 놓고 서버가
 * 거절하는 것은 「막았다」가 아니라 「거짓말한 뒤 막았다」이다.
 */
async function exerciseSpawnPicker(browser, delayMs) {
  const { context, page, state } = await newPage(browser, "spawn", delayMs);
  await page.getByTestId("inbox-approval-host-group").waitFor();

  // ① RED PROOF: 자격 없는 줄은 눌리지 않는다.
  //
  // 순서에 이유가 있다. 아래 ②의 라벨 단언도 같은 `selectable`을 읽으므로, 그것을
  // 먼저 두면 `PROVE_RED_UNSELECTABLE` 이음매가 라벨 쪽을 먼저 붉히고 이 배치의
  // 논점(**눌리지 않는다**)은 한 번도 측정되지 않은 채로 남는다.
  const dead = await radioState(page, deadHostId);
  const cloud = await radioState(page, cloudHostId);
  if (!dead.disabled || !cloud.disabled) {
    throw new Error(
      `unselectable host stays unpickable: 자격 없는 라디오가 열려 있다 (dead=${dead.disabled} cloud=${cloud.disabled})`
    );
  }
  // **진짜 마우스**로 그 줄의 한가운데를 누른다. 두 가지 손쉬운 방법을 다 버린
  // 이유가 있다:
  //   - 라디오에 `dispatchEvent("click")`: Chromium은 dispatch된 click을 disabled
  //     입력에도 흘려보내 checked를 뒤집는다. 사람이 만들 수 없는 입력이고, 화면의
  //     계약도 아니다.
  //   - 로케이터의 `.click()`: Playwright의 액셔너빌리티가 "element is not enabled"
  //     에서 30초를 기다리다 **타임아웃**을 낸다. 타임아웃은 무엇이 틀렸는지 말하지
  //     않는다.
  // `page.mouse.click`은 브라우저의 히트 테스트를 그대로 지나므로, 사람이 그 줄을
  // 눌렀을 때 무슨 일이 일어나는지를 실제로 잰다.
  const checkedBefore = (await radioState(page, localHostId)).checked
    ? localHostId
    : remoteHostId;
  const deadBox = await page
    .getByTestId(`inbox-approval-host-option-${deadHostId}`)
    .boundingBox();
  if (deadBox === null) {
    throw new Error("unselectable host stays unpickable: 오프라인 줄이 화면에 없다");
  }
  await page.mouse.click(
    deadBox.x + deadBox.width / 2,
    deadBox.y + deadBox.height / 2
  );
  if ((await radioState(page, deadHostId)).checked) {
    throw new Error(
      "unselectable host stays unpickable: 오프라인 호스트가 선택 상태로 옮겨 갔다"
    );
  }
  // 누르기 **전에** 무엇이 찍혀 있었는지를 들고 비교한다. 「내 맥이 여전히
  // 찍혀 있다」로 적으면 기본값을 옮기는 다른 이음매(`PROVE_RED_DEFAULT`)가 이
  // 단언을 먼저 붉혀, 그 이음매가 겨냥한 곳이 측정되지 않는다.
  if ((await radioState(page, checkedBefore)).checked !== true) {
    throw new Error(
      "unselectable host stays unpickable: 자격 없는 줄을 누르자 선택이 풀렸다"
    );
  }

  // ② 자격 없는 후보가 **숨지 않는다**. 서버가 사유와 함께 싣기로 한 결정을
  //    화면이 무효로 만들면, "왜 내 랩탑을 못 고르지"의 답이 사라진다.
  if (!dead.label.includes("낡은 맥 (오프라인)")) {
    throw new Error(
      `unavailable host is listed: 오프라인 호스트가 사유와 함께 서지 않았다 (${dead.label})`
    );
  }
  // T3 자리 — ADR-0136이 momo Cloud를 꺼 둔 동안의 표기.
  if (!cloud.label.includes("momo Cloud (준비 중)")) {
    throw new Error(
      `t3 slot: 예약된 클라우드 슬롯이 「준비 중」으로 서지 않았다 (${cloud.label})`
    );
  }

  // ③ RED PROOF: 찍혀 있는 것은 **payload의 기본값**이다. 이름으로 기대한다 —
  //    위치나 순서로 고르고 있었다면 이 단언은 seam 없이도 통과해 버린다.
  const local = await radioState(page, localHostId);
  const remote = await radioState(page, remoteHostId);
  if (!local.checked || remote.checked) {
    throw new Error(
      `default host preselected: 카드의 기본값(내 맥)이 아니라 다른 것이 찍혀 있다 (local=${local.checked} remote=${remote.checked})`
    );
  }

  // ④ RED PROOF: 손대지 않고 결정하면 `hostId` 키가 **아예 없다**. 서버가 같은
  //    payload의 `default_host_id`를 적용하므로 결과는 같고, 키를 빼는 쪽이
  //    정직하다: 사람이 선택이라는 행위를 하지 않았다는 사실이 원장에 남는다.
  // #3819: 한 번 누르면 결정이다. 목적지는 누르기 **전에** 픽커가 말하고(찍힌 라디오),
  // 확정 문장은 없다.
  await page.getByTestId("inbox-approval-approve").first().click();
  await page.getByTestId("inbox-decision-note").waitFor();
  if (state.decisions.length !== 1) {
    throw new Error(
      `spawn decision: expected exactly 1 POST, got ${state.decisions.length}`
    );
  }
  const untouched = state.decisions[0];
  if (Object.prototype.hasOwnProperty.call(untouched, "hostId")) {
    throw new Error(
      `default applies without a hostId: 픽커를 손대지 않았는데 본문이 hostId를 실었다 ${JSON.stringify(untouched)}`
    );
  }
  await context.close();

  // ⑤ 바꾸면 명시적으로 실린다. 새 판에서 한다 — 결정한 행은 사라진다.
  const second = await newPage(browser, "spawn", delayMs);
  await second.page.getByTestId("inbox-approval-host-group").waitFor();
  await second.page
    .getByTestId(`inbox-approval-host-radio-${remoteHostId}`)
    .check();
  await second.page.getByTestId("inbox-approval-approve").first().click();
  await second.page.getByTestId("inbox-decision-note").waitFor();
  const chosen = second.state.decisions[0];
  if (String(chosen?.hostId ?? "").toLowerCase() !== remoteHostId.toLowerCase()) {
    throw new Error(
      `chosen host travels: 사람이 고른 호스트가 본문에 실리지 않았다 ${JSON.stringify(chosen)}`
    );
  }
  await second.context.close();
}

/**
 * 403 — 카드가 그려진 뒤 호스트가 꺼졌다 (서버 `resolve_host_choice`의 세 번째 검사).
 *
 * 이 갈래의 위험은 하나뿐이고 그것이 이 단언의 전부다: **기록되지 않은 결정을
 * 기록됐다고 말하는 것.** 403은 원장을 움직이지 않았으므로 영수증이 아니라 오류이고,
 * 픽커는 남아 있어야 사람이 다른 호스트로 다시 시도할 수 있다.
 */
async function exerciseSpawnForbidden(browser, delayMs) {
  const { context, page } = await newPage(browser, "spawn-forbidden", delayMs);
  await page.getByTestId("inbox-approval-host-group").waitFor();
  await page.getByTestId("inbox-approval-approve").first().click();

  await waitForEither(
    page,
    "inbox-approval-error",
    "inbox-decision-note",
    "forbidden host is refused"
  );
  const error = page.getByTestId("inbox-approval-error");
  const role = await error.getAttribute("role");
  const tone = await error.getAttribute("data-tone");
  if (role !== "alert" || tone !== "error") {
    throw new Error(
      `forbidden host is refused: 거절이 사고로 그려지지 않았다 (role=${role} tone=${tone})`
    );
  }
  // 픽커가 남아야 다른 호스트로 다시 시도할 수 있다. 거절과 함께 사라지면 사람은
  // 무엇을 바꿔야 하는지 모른 채 같은 버튼을 다시 누른다.
  if ((await page.getByTestId("inbox-approval-host-group").count()) === 0) {
    throw new Error(
      "forbidden host is refused: 거절 뒤 픽커가 사라져 다른 호스트를 고를 수 없다"
    );
  }
  await context.close();
}

/**
 * 자격 있는 후보가 0. 서버가 409로 답할 것을 결정 **전에** 말한다.
 *
 * 거부는 막지 않는다 — 서버도 거부에는 호스트를 묻지 않고, 실행할 수 없는 요청을
 * 정리할 길까지 닫을 이유는 없다.
 */
async function exerciseSpawnBlocked(browser, delayMs) {
  const { context, page, state } = await newPage(
    browser,
    "spawn-blocked",
    delayMs
  );
  await page.getByTestId("inbox-approval-host-group").waitFor();

  const blocked = page.getByTestId("inbox-approval-host-blocked");
  if ((await blocked.count()) === 0) {
    throw new Error(
      "no eligible host blocks approve: 고를 것이 없는데 화면이 아무 말도 하지 않았다"
    );
  }
  // 사고가 아니라 상태다. alert으로 끼어들면 이 줄이 오류처럼 읽힌다. 그렇다고
  // `role="status"`도 아니다 (design-review M5): 라이브 리전은 **바뀐** 내용을
  // 읽는데 이 문장은 첫 페인트부터 거기 있어 아무것도 발화되지 않는다. 대신 아래에서
  // 승인 버튼이 `aria-describedby`로 이 문장을 되짚는지를 잰다.
  const blockedRole = await blocked.getAttribute("role");
  if (blockedRole !== null) {
    throw new Error(
      `no eligible host blocks approve: 안내에 role=${blockedRole} 이 붙어 있다`
    );
  }

  const approve = page.getByTestId("inbox-approval-approve").first();
  // 네이티브 `disabled`가 **아니다** (design-review H1). 채움 버튼에 걸린
  // `disabled:opacity-50`은 「승인」을 2.23:1로 떨어뜨리고, 무엇보다 disabled 버튼은
  // 초점을 받지 못해 키보드/보이스오버 사용자가 막힌 컨트롤을 아예 만나지 못한다.
  // 그래서 판정은 세 가지를 함께 잰다: 상태는 알리되(aria-disabled), 초점은
  // 남기고(tabbable), 이유는 되짚는다(aria-describedby → 그 문장).
  if ((await approve.getAttribute("aria-disabled")) !== "true") {
    throw new Error(
      "no eligible host blocks approve: 실행할 호스트가 없는데 승인 버튼이 살아 있다"
    );
  }
  // DOM 속성을 직접 읽는다. Playwright의 `isDisabled()`는 `aria-disabled`도 함께
  // 세므로 이 구분(네이티브 disabled인가 / 상태만 알리는가)에는 쓸 수 없다 —
  // 그리고 이 단언이 지키려는 것이 정확히 그 구분이다.
  if (await approve.evaluate((node) => node.disabled)) {
    throw new Error(
      "blocked approve stays reachable: 막힌 승인이 네이티브 disabled라 초점이 닿지 않는다"
    );
  }
  const describedBy = await approve.getAttribute("aria-describedby");
  const blockedDomId = await blocked.getAttribute("id");
  if (!describedBy || describedBy !== blockedDomId) {
    throw new Error(
      `blocked approve names its reason: aria-describedby=${describedBy} 가 사유 문장(${blockedDomId})을 가리키지 않는다`
    );
  }
  await approve.focus();
  const focused = await page.evaluate(() =>
    document.activeElement?.getAttribute("data-testid")
  );
  if (focused !== "inbox-approval-approve") {
    throw new Error(
      `blocked approve stays reachable: 막힌 승인에 초점이 닿지 않는다 (${focused})`
    );
  }
  // 진짜 마우스로 누른다. 로케이터의 `.click()`은 `aria-disabled`를 보고 액셔너빌리티
  // 대기에 들어가 타임아웃으로 끝나는데, 타임아웃은 무엇이 틀렸는지 말하지 않는다.
  const approveBox = await approve.boundingBox();
  if (approveBox === null) {
    throw new Error("no eligible host blocks approve: 승인 버튼이 화면에 없다");
  }
  await page.mouse.click(
    approveBox.x + approveBox.width / 2,
    approveBox.y + approveBox.height / 2
  );
  // 키보드도 같은 문을 지나야 한다: 초점이 이미 그 버튼에 있으므로 Enter가 곧
  // 두 번째 입구다.
  await page.keyboard.press("Enter");
  await page.waitForTimeout(delayMs + 200);
  if (state.decisions.length !== 0) {
    throw new Error(
      `no eligible host blocks approve: 결정이 ${state.decisions.length}건 나갔다`
    );
  }

  // 거부는 열려 있다: 한 번 누르면 결정이 나간다(#3819).
  await page.getByTestId("inbox-approval-reject").first().click();
  await page.getByTestId("inbox-decision-note").waitFor();
  if (state.decisions.length !== 1 || state.decisions[0].approve !== false) {
    throw new Error(
      `reject stays open: 거부 한 번이 거부 결정 1건이어야 한다 ${JSON.stringify(state.decisions)}`
    );
  }
  await context.close();
}

/** 이미 다른 곳에서 결정된 요청. 정상적인 상태 전이이지 사고가 아니다. */
async function exerciseSuperseded(browser, delayMs) {
  const { context, page } = await newPage(browser, "superseded", delayMs);
  await page.getByTestId("inbox-approval-approve").first().click();

  // 인라인 오류(`inbox-approval-error`)가 먼저 그려지면 그것이 곧 회귀다:
  // 이미 결정된 요청을 사고로 말한 것이다.
  await waitForEither(
    page,
    "inbox-decision-note",
    "inbox-approval-error",
    "superseded stays a note"
  );

  const note = page.getByTestId("inbox-decision-note");
  const role = await note.getAttribute("role");
  const text = (await note.textContent()) ?? "";
  if (role !== "status" || !text.includes("이미 승인으로 기록되어 있었어요")) {
    throw new Error(
      `superseded stays a note: expected role="status" + 원장 방향 문구, got role=${role} text=${text}`
    );
  }
  await context.close();
}

/** 아직 배포되지 않은 서버. 미제공이지 장애가 아니다. */
async function exerciseAbsent(browser, delayMs) {
  const { context, page } = await newPage(browser, "absent", delayMs, {
    open: false,
  });
  // 이 빌드의 탭 표는 정적이라 승인 원장이 404여도 「처리할 일」 탭은 선다 — 그 탭이 말하는 것이 「미제공」이어야
  // 장애(`inbox-error`)로 읽히지 않는다. 탭을 눌러 그 문장을 읽는다(#5048).
  await page.getByTestId("inbox-tab-task").click();
  await waitForEither(
    page,
    "inbox-unavailable",
    "inbox-error",
    "absent folds to 미제공"
  );
  const text = (await page.getByTestId("inbox-unavailable").textContent()) ?? "";
  if (!text.includes("아직 승인 결정을 기록하지 않습니다")) {
    throw new Error(`absent folds to 미제공: 미제공 문구가 아니다 (${text})`);
  }
  await context.close();
}

/**
 * 승인 원장만 5xx (#5092 D2). 서버 투영은 정상이고 비어 있다.
 *
 * 투영이 이미 답했다고 인박스가 비어 있는 것이 아니다: 처리할 일(승인)은 투영에 저장되지 않고 이 원장에서만
 * 오므로, 원장이 답하지 못했는데 「조용한 게 정상이에요」라고 말하면 대기 중인 승인을 모르는 채 하는 말이다.
 * 진짜 장애라 오류 배너와 [다시 시도]가 서야 하고, 다시 시도는 원장을 다시 읽어야 한다.
 */
async function exerciseError(browser, delayMs) {
  const { context, page, state } = await newPage(browser, "error", delayMs, {
    open: false,
  });
  // 전체 탭. 「비어 있어요」가 먼저 그려지면 그것이 곧 회귀다(원장 실패를 가린 것).
  await waitForEither(page, "inbox-error", "inbox-empty", "ledger error (전체)");
  const role = await page.getByTestId("inbox-error").getAttribute("role");
  if (role !== "alert") {
    throw new Error(`ledger error: 오류 배너가 alert이 아니다 (role=${role})`);
  }
  // 「처리할 일」 탭: 그 탭의 내용은 이 원장 하나다. 「미제공」으로도 읽히면 안 된다(그건 404의 말이다).
  await page.getByTestId("inbox-tab-task").click();
  await waitForEither(page, "inbox-error", "inbox-empty", "ledger error (처리할 일)");
  if ((await page.getByTestId("inbox-unavailable").count()) !== 0) {
    throw new Error("ledger error: 5xx를 미제공(404의 말)으로 읽었다");
  }

  // 다시 시도는 원장을 다시 읽는다. 원장이 살아난 뒤 한 번 누르면 줄이 서야 한다.
  const callsBefore = state.listCalls;
  state.ledgerFails = false;
  await page.getByTestId("inbox-error").getByRole("button").click();
  await page.getByTestId("mailbox-row").first().waitFor({ timeout: 10_000 });
  if ((await page.getByTestId("mailbox-row").count()) !== 2) {
    throw new Error(
      `ledger retry: 원장이 살아난 뒤 다시 시도했는데 대기 행 둘이 서지 않았다 (${await page.getByTestId("mailbox-row").count()})`
    );
  }
  if ((await page.getByTestId("inbox-error").count()) !== 0) {
    throw new Error("ledger retry: 줄이 섰는데 오류 배너가 남아 있다");
  }
  if (state.listCalls <= callsBefore) {
    throw new Error(
      `ledger retry: 다시 시도가 원장을 다시 읽지 않았다 (${callsBefore} -> ${state.listCalls})`
    );
  }
  await context.close();
}

/** 서버 투영(인박스의 원천)이 5xx. 승인 원장이 멀쩡해도 인박스는 오류를 말한다. */
async function exerciseProjectionError(browser, delayMs) {
  const { context, page } = await newPage(browser, "projection-error", delayMs, {
    open: false,
  });
  await waitForEither(page, "inbox-error", "inbox-unavailable", "projection error");
  const role = await page.getByTestId("inbox-error").getAttribute("role");
  if (role !== "alert") {
    throw new Error(`projection error: 오류 배너가 alert이 아니다 (role=${role})`);
  }
  await context.close();
}

/** 조용한 인박스는 설계가 작동한 모습이다. */
async function exerciseEmpty(browser, delayMs) {
  const { context, page } = await newPage(browser, "empty", delayMs, {
    open: false,
  });
  await waitForEither(page, "inbox-empty", "inbox-error", "empty state");
  const text = (await page.getByTestId("inbox-empty").textContent()) ?? "";
  if (!text.includes("조용한 게 정상이에요")) {
    throw new Error(`empty state: 빈 상태가 실패처럼 말한다 (${text})`);
  }
  await context.close();
}

/**
 * 로딩은 첫 응답이 오기 전에만 서고, 높이를 지키는 중립 막대여야 한다.
 *
 * 늦는 것은 **승인 원장**이다(#5092 D3). 서버 투영은 즉시 비어 있다고 답하지만 처리할 일(승인)은 이 원장에서만
 * 오므로, 원장을 기다리는 동안 「비어 있어요」를 말하면 대기 중인 승인을 모르는 채 하는 말이다.
 */
async function exerciseLoading(browser) {
  // 승인 원장은 앱이 뜰 때(사이드바 「나에게 필요한 일」 수) 이미 읽기 시작하므로 옛 900ms 창은 라우트가 열린 뒤
  // CDP 왕복만으로도 닫혔다 — 로딩 막대를 볼 수 있을 만큼 길게 잡는다(#5048).
  const { context, page } = await newPage(browser, "loading", 4_000, {
    open: false,
  });
  // 인박스 안으로 한정한다. 사이드바 채널 섹션의 끝난 스켈레톤(숨은 막대)이 문서 앞에 남아 있어 페이지 전체의
  // `.first()`는 영영 보이지 않을 그 요소를 기다린다(#5048). 끝난 스켈레톤의 막대는 DOM에 숨은 채 남는다
  // (`is-settled`): 사람이 보는 것은 보이는 막대뿐이다.
  const visibleBars = page.locator(
    '[data-testid="inbox-route"] [data-testid="skeleton-row"]:visible'
  );
  // 막대를 기다리다 「비어 있어요」가 먼저 그려지면 그것이 곧 회귀다: 타임아웃이 아니라 이름으로 실패한다.
  const deadline = Date.now() + 10_000;
  for (;;) {
    if ((await visibleBars.count()) > 0) break;
    if ((await page.getByTestId("inbox-empty").count()) > 0) {
      throw new Error(
        "loading state: 승인 원장의 응답을 기다리는 동안 「비어 있어요」라고 말했다"
      );
    }
    if (Date.now() > deadline) {
      throw new Error("loading state: 로딩 막대가 10초 안에 보이지 않았다");
    }
    await wait(100);
  }
  if ((await page.getByTestId("inbox-empty").count()) !== 0) {
    throw new Error(
      "loading state: 응답을 기다리는 동안 '결정할 일이 없습니다'라고 말했다"
    );
  }
  await page.getByTestId("inbox-list").waitFor({ timeout: 10_000 });
  if ((await visibleBars.count()) !== 0) {
    throw new Error("loading state: 목록이 온 뒤에도 스켈레톤이 보인다");
  }
  await context.close();
}

async function main() {
  if (!existsSync(resolve(webRoot, "dist/index.html"))) {
    throw new Error("dist/ is missing. Run npm run build first.");
  }
  const server = await startGuardedPreview({
    webRoot,
    port,
    portEnvVar: "APPROVALS_GATE_PORT",
  });
  try {
    const browser = await chromium.launch();
    try {
      // 세 가지 지연으로 목록을 돌린다: 같은 tick에 답하는 목은 아무것도 증명하지
      // 못한다(#839).
      for (const delayMs of [20, 180, 320]) {
        await exerciseList(browser, delayMs);
      }
      await exerciseLoading(browser);
      await exerciseReject(browser, 60);
      // 이슈 1114 — 호스트 선택기. 두 지연에서 돌린다: 픽커의 기본값은 목록 응답이
      // 그려진 **뒤에** 정해지므로, 같은 tick에 답하는 목은 그 순서를 못 잰다.
      for (const delayMs of [20, 180]) {
        await exerciseSpawnPicker(browser, delayMs);
      }
      await exerciseSpawnForbidden(browser, 60);
      await exerciseSpawnBlocked(browser, 60);
      await exerciseSuperseded(browser, 120);
      await exerciseAbsent(browser, 60);
      await exerciseError(browser, 60);
      await exerciseProjectionError(browser, 60);
      await exerciseEmpty(browser, 60);
    } finally {
      await browser.close();
    }
  } finally {
    await server.stop();
  }
  console.log(
    "GATE PASS: 처리할 일 탭 · 연 대기 행에만 결정 컨트롤 · 한 번에 결정(확정 단계 없음) ·"
  );
  console.log(
    "           결정한 승인은 컨트롤이 사라지고 결과가 서며 초점은 패널이 받는다(원장 재조회 뒤에도) ·"
  );
  console.log(
    "           900x600 뷰포트 안 · 결정 왕복과 원장 재조회 · 이미 결정됨은 상태 전이 ·"
  );
  console.log(
    "           미제공/장애/빈/로딩 갈래가 갈라진 채로 남았다: 원장만 실패하거나 늦어도 「비어 있어요」가"
  );
  console.log(
    "           아니라 오류+다시 시도 / 로딩 막대 · 투영 장애도 오류."
  );
  console.log(
    "           호스트 선택기: 자격 없는 둘이 사유와 함께 서고 눌리지 않는다 ·"
  );
  console.log(
    "           기본값은 payload가 정한다 · 손대지 않으면 hostId 키가 없다 ·"
  );
  console.log(
    "           고른 호스트는 본문에 실린다 · 403은 영수증이 아니라 오류다 ·"
  );
  console.log("           자격 0이면 승인이 실제로 불가용하고 거부만 열린다.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
