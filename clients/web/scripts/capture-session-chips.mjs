#!/usr/bin/env node
// =============================================================================
// CAPTURE: 세션 경과·검증 칩의 상태별 증거 (UXC-C / 커서 웹 ADE 벤치마크 §3-C).
//
// `capture-completion.mjs` 의 짝이다. 그 파일이 완료 리포트 **카드**에 대해 하는
// 일을 이 파일이 그 문법을 물려받은 **세션 표면**에 대해 한다: 게이트가 아니라
// 증거이고, 판정은 사진이 스스로 말하지 못하는 것만 한다.
//
// 목록의 네 행이 이 티켓의 분기 전부다:
//   실행 중        살아 있는 시계("3m 12s"), 리포트가 아직 없으므로 **칩 없음**.
//   끝남 · 통과    「24분 28초 동안 작업」 + 검증 칩 「통과 N」(ok).
//   끝남 · 실패    같은 성과 서술 + 검증 칩 「실패 1」(danger). 통과 3개가 실패
//                  하나를 덮지 않는다는 것이 이 사진의 전부다.
//   끝남 · 무보고  성과 서술만. **칩이 없다** — 「미검증」이라고 쓰지 않는다.
//   끝남 · 순식간  「1초 미만 작업」. 조사 「동안」이 떨어진 자리다(#1468).
//   끝남 · 초장기  1,000행이 넘는 스레드. `/replies` 는 5×200 에서 절단되고 그 창
//                  안에는 리포트가 없다 — 그런데도 칩이 선다(#1463 / grok H2).
//
// #1463 부터 칩은 **목록 행 자체**에도 선다(`work-session-verification`). 그 행은
// 스레드를 읽지 않으므로, 이 파일이 채널 히스토리 대역을 함께 세워야 한다는 사실이
// 곧 read-model 이 바뀌었다는 증거다: 리포트는 이제 채널을 최신부터 훑어 온다
// (`useWorkSessions` 의 왕복 예산 · 코어 `sessionVerification` 머리말).
//
// 그리고 접혀 있는 「세션 정보」를 펴서 라벨을 함께 잰다: 그 줄과 위 성과 서술은
// **같은 함수 한 번**의 결과이므로, 라벨이 카드의 「작업 시간」과 다른 낱말이면
// 한 화면의 한 숫자가 두 측정처럼 읽힌다(#1468 — 그 낱말이 「실행 시간」이었다).
//
// 상세 화면에서는 **초록의 개수**도 픽셀 값으로 잰다(#1491): 검증 칩은 --ok 를 진
// 채이고 수명주기 칩은 아니다. 사진은 두 초록을 나란히 보여줄 뿐 어느 쪽이 무엇을
// 뜻하는지 말하지 못하고, 그 물음이 이 티켓이 온 이유였다.
//
//   npm run build && node scripts/capture-session-chips.mjs
//   OUT_DIR=/tmp/shots node scripts/capture-session-chips.mjs
// =============================================================================

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.SESSION_CHIPS_CAPTURE_PORT || 5198);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const OUT_DIR = process.env.OUT_DIR
  ? resolve(process.env.OUT_DIR)
  : resolve(WEB_ROOT, "artifacts/session-chips");
const VIEWPORT = { width: 1280, height: 900 };

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";
const CHANNEL_ID = "00000000-0000-7000-8000-000000000201";
/**
 * 이름이 긴 방 (#1463 리뷰 B1).
 *
 * 앞 판의 픽스처에는 방이 하나(「배포」)뿐이었고, 「최악 조합」도 제목·경과 낱말·칩
 * 낱말만 바꿨다. 그래서 **방 이름 축**이 통째로 빠져 있었다 — `channel.name` 은
 * 서버에 길이 상한이 없는 `text` 인데(`schema_v0.sql`), 목록 행의 아랫줄은 그
 * 이름과 요약과 칩이 한 줄을 나눠 쓴다. 이 방이 그 축이다.
 */
const LONG_CHANNEL_ID = "00000000-0000-7000-8000-000000000202";
const ME = "019f94e3-7a10-79cd-9dee-208f47edd9a8";
const HOST_ID = "019f9a01-0000-7000-8000-000000000501";

const RUNNING_ID = "019f9b00-0000-7000-8000-000000000601";
const CLEAN_ID = "019f9b00-0000-7000-8000-000000000602";
const FAILING_ID = "019f9b00-0000-7000-8000-000000000603";
const QUIET_ID = "019f9b00-0000-7000-8000-000000000604";
const WIDEST_ID = "019f9b00-0000-7000-8000-000000000605";
const BLINK_ID = "019f9b00-0000-7000-8000-000000000606";
const LONG_ID = "019f9b00-0000-7000-8000-000000000607";
const REPORTED_RUNNING_ID = "019f9b00-0000-7000-8000-000000000608";
const ROOT_OF = {
  [RUNNING_ID]: "019f9b00-0000-7000-8000-0000000006a1",
  [CLEAN_ID]: "019f9b00-0000-7000-8000-0000000006a2",
  [FAILING_ID]: "019f9b00-0000-7000-8000-0000000006a3",
  [QUIET_ID]: "019f9b00-0000-7000-8000-0000000006a4",
  [WIDEST_ID]: "019f9b00-0000-7000-8000-0000000006a5",
  [BLINK_ID]: "019f9b00-0000-7000-8000-0000000006a6",
  [LONG_ID]: "019f9b00-0000-7000-8000-0000000006a7",
  [REPORTED_RUNNING_ID]: "019f9b00-0000-7000-8000-0000000006a8",
};

const SESSION = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: {
    id: ME,
    workspaceId: WORKSPACE_ID,
    kind: "human",
    displayName: "곽성재",
    handle: "seongjae",
  },
  realtimeWebSocketUrl: "ws://session-chips-capture.invalid/connection/websocket",
};

const CHANNELS = [
  {
    id: CHANNEL_ID,
    workspaceId: WORKSPACE_ID,
    kind: "public",
    name: "배포",
    muted: false,
  },
  {
    id: LONG_CHANNEL_ID,
    workspaceId: WORKSPACE_ID,
    kind: "public",
    name: "결제-정산-플랫폼-마이그레이션-2026-상반기",
    muted: false,
  },
];

const ROSTER = [
  {
    id: ME,
    workspaceId: WORKSPACE_ID,
    kind: "human",
    status: "active",
    role: "owner",
    displayName: "곽성재",
    handle: "seongjae",
    channelCount: 1,
    channelIds: [CHANNEL_ID],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  },
];

const HOSTS = [
  {
    id: HOST_ID,
    workspaceId: WORKSPACE_ID,
    scope: "workspace",
    ownerMemberId: ME,
    type: "app",
    displayName: "개발실 Mac mini",
    capabilities: { terminal: true },
    createdAtMs: 1_785_163_000_000,
    online: true,
  },
];

const NOW = Date.now();

/** 어느 세션이 이름 긴 방에 사는가 (#1463 리뷰 B1). */
const CHANNEL_OF = {};

function workSession(id, label, extra) {
  return {
    id,
    workspaceId: WORKSPACE_ID,
    channelId: CHANNEL_OF[id] ?? CHANNEL_ID,
    memberId: ME,
    hostId: HOST_ID,
    rootMessageId: ROOT_OF[id],
    tool: "codex",
    label,
    status: "ended",
    observation: "open",
    observerGrantCount: 0,
    remoteAttachAvailable: false,
    remoteDisplayAvailable: false,
    startedAtMs: NOW - 1_468_000,
    endedAtMs: NOW,
    ...extra,
  };
}

/**
 * 실행 중인 세션은 `endedAtMs` **키 자체가 없다**. `undefined` 를 실어 두면
 * JSON 이 그 키를 지우므로 결과는 같지만, 서버 투영이 실제로 내는 모양은 키의
 * 부재이고 픽스처는 그것을 그대로 흉내 내야 한다.
 */
function runningSession(id, label, startedAtMs) {
  const session = workSession(id, label, { status: "running", startedAtMs });
  delete session.endedAtMs;
  return session;
}

/** 1시간 24분 — 시간 단위 경과. 「N시간 N분 동안 작업」이 가장 넓은 낱말이다. */
const HOUR_SCALE_MS = 5_040_000;

// 최악 조합 둘은 이름 긴 방에 산다: 가장 넓은 칩 낱말(「미상 결과 2」)과 초장기
// 세션이 그 방의 이름과 한 줄을 나눠 쓴다. 앞 판은 이 조합에서 칩이 패널 밖으로
// 밀려나고 320px 안에 가로 스크롤이 생겼다 (#1463 리뷰 B1).
CHANNEL_OF[WIDEST_ID] = LONG_CHANNEL_ID;
CHANNEL_OF[LONG_ID] = LONG_CHANNEL_ID;

// 코어가 짓는 낱말들(`workSessionFormat` · `completionReportCard`). 값을 여기 그대로
// 적는 이유는 둘이다: 이 노드 스크립트는 코어의 TS 소스를 import 하지 못하고, 그리고
// **대조**가 이 파일의 일이다 — 기대값을 코어에서 끌어오면 화면과 코어가 함께 틀린
// 날에도 이 게이트가 조용하다. 상수 쪽은 코어 스위트가 잰다.
const SUB_SECOND = "1초 미만";
const WORKED_SUFFIX = "동안 작업";
const BARE_SUFFIX = "작업";
const WORKED_LABEL = "작업 시간";

const SESSIONS = [
  runningSession(RUNNING_ID, "타임라인 접기 회귀 추적", NOW - 192_000),
  workSession(CLEAN_ID, "웹 세션 표면 게이트 정리"),
  workSession(FAILING_ID, "결제 어댑터 회귀 점검"),
  workSession(QUIET_ID, "로그 로테이션 스크립트 손보기"),
  // 최악 조합 (design-review H-1 후속): 가장 넓은 경과 낱말 + 가장 넓은 칩 낱말
  // (「미상 결과」, 4음절) + 긴 제목. 고정 폭만으로 320px 을 넘길 수 있는지가
  // 코드 추론으로만 남아 있었으므로, 여기서 실측한다.
  // `tool` 이 긴 이유는 이 행의 아랫줄 **요약**을 실제로 절단시키기 위해서다
  // (#1463 리뷰 M4). 목록의 요약은 레일이 나른 마지막 줄이고, 이 캡처의 소켓은
  // ACP 프레임을 하나도 밀지 않으므로 모든 행이 짧은 대체 문구(`tool · 시작 …`)로
  // 떨어진다 — 그러면 칩 옆이 늘 비어 있어 「요약이 양보한다」는 주장이 사진에서
  // 한 번도 시험되지 않는다. 도구 이름을 길게 두면 그 대체 문구가 길어져, 방 이름
  // (긴 방)·요약·칩이 한 줄을 두고 실제로 다툰다.
  workSession(WIDEST_ID, "결제 정산 배치 재실행 파이프라인 점검", {
    tool: "codex-cloud-batch-runner",
    startedAtMs: NOW - HOUR_SCALE_MS,
  }),
  // 시작하자마자 끝난 세션 (#1468). 「1초 미만」은 기간 명사가 아니라 비교 표현이라
  // 조사 「동안」을 받지 못한다 — 그 문장이 화면에 서 본 적이 없어서 어색함이
  // 코드 추론으로만 남아 있었으므로, 여기서 실측한다.
  workSession(BLINK_ID, "배포 전 설정 문법 검사", { startedAtMs: NOW - 400 }),
  // 초장기 세션 (#1463 / grok H2). 스레드가 1,000행을 넘어 `/replies` 5×200 창이
  // 절단되고, 잘려 나가는 쪽이 정확히 **가장 최근 리포트**다. 앞 판에서 이 행은
  // 영구히 칩이 없었다 — 리포트가 가장 필요한 세션이 정확히 이 세션인데.
  workSession(LONG_ID, "야간 회귀 스위트 전량 재실행", {
    startedAtMs: NOW - HOUR_SCALE_MS,
  }),
  // 아직 도는데 이미 보고한 세션. 「내 세션」범위는 끝난 세션을 빼므로 그 목록에서
  // 칩이 설 수 있는 유일한 경우이고, 동시에 두 칩이 서로를 함의하지 않는다는
  // `SessionVerificationChip` 머리말의 유일한 사진이다: 원장은 「실행 중」이라 부르고
  // 세션 자신은 「통과 3」을 보고했다.
  runningSession(REPORTED_RUNNING_ID, "인덱스 재구축 야간 배치", NOW - 512_000),
];

const CLEAN_REPORT = {
  kind: "completion_report",
  title: "웹 세션 표면 게이트 정리",
  summary: "웹·코어 게이트를 전부 초록으로 맞췄습니다.",
  elapsed_ms: 1_468_000,
  gates: [
    {
      surface: "웹",
      checks: [
        { label: "테스트", outcome: "pass", detail: "1055 통과" },
        { label: "린트", outcome: "pass", detail: "오류 0" },
      ],
    },
    {
      surface: "코어",
      checks: [{ label: "테스트", outcome: "pass", detail: "1565 통과" }],
    },
  ],
};

const FAILING_REPORT = {
  kind: "completion_report",
  title: "결제 어댑터 회귀 점검",
  summary: "환불 경로 테스트 하나가 아직 빨갛습니다.",
  elapsed_ms: 1_468_000,
  gates: [
    {
      surface: "웹",
      checks: [
        { label: "테스트", outcome: "pass", detail: "1055 통과" },
        { label: "린트", outcome: "pass", detail: "오류 0" },
      ],
    },
    {
      surface: "엔진",
      checks: [
        { label: "빌드", outcome: "pass" },
        { label: "테스트", outcome: "fail", detail: "1 실패" },
        { label: "보안", outcome: "skip", detail: "이번 판에서 제외" },
      ],
    },
  ],
};

/**
 * 가장 넓은 칩 낱말을 내는 표: 실패가 없고 **읽지 못한 결과**가 대표가 된다
 * (`unknown` → 「미상 결과 2」). 심각도 순위에서 unknown 이 fail 다음이므로 통과
 * 옆에서 이 칸이 앞선다 — 추측으로 통과를 짓지 않는다는 코어 규율 그대로다.
 */
const UNKNOWN_REPORT = {
  kind: "completion_report",
  title: "결제 정산 배치 재실행 파이프라인 점검",
  summary: "정산 배치 게이트 둘의 결과 문자열을 읽지 못했습니다.",
  elapsed_ms: HOUR_SCALE_MS,
  gates: [
    {
      surface: "정산",
      checks: [
        { label: "빌드", outcome: "pass" },
        { label: "회귀", outcome: "quarantined", detail: "격리 큐로 이동" },
        { label: "정합", outcome: "flaky", detail: "재시도 3회" },
      ],
    },
  ],
};

/**
 * 초장기 세션의 리포트 (#1463). 이 봉투는 **스레드 페이지에 실리지 않는다** — 그
 * 스레드는 1,000행을 넘어 절단되고, 잘려 나가는 쪽이 정확히 이 리포트다. 화면이
 * 이것을 말할 수 있는 유일한 길은 채널을 최신부터 훑는 스캔이다.
 */
const LONG_REPORT = {
  kind: "completion_report",
  title: "야간 회귀 스위트 전량 재실행",
  summary: "격리 큐를 비우고 전량 재실행했습니다. 하나가 아직 빨갛습니다.",
  elapsed_ms: HOUR_SCALE_MS,
  gates: [
    {
      surface: "엔진",
      checks: [
        { label: "빌드", outcome: "pass" },
        { label: "회귀", outcome: "fail", detail: "1 실패" },
      ],
    },
  ],
};

const REPORT_OF = {
  [CLEAN_ID]: CLEAN_REPORT,
  [FAILING_ID]: FAILING_REPORT,
  [WIDEST_ID]: UNKNOWN_REPORT,
  [LONG_ID]: LONG_REPORT,
  // 두 칩이 **같은 톤**을 입는 유일한 조합 (#1463 리뷰 M2): 수명주기 「실행 중」은
  // warn 이고 게이트 대표가 「미상 결과」여도 warn 이다. 앞 판에서는 두 칩의 그릇이
  // 같아서 그 조합이 한 행에 뜻이 다른 호박색 알약 둘로 보였다. 그릇을 가른 뒤
  // (채움 = 원장, 테두리 = 자기 보고) 이 픽스처가 그 구분을 사진과 숫자로 남긴다.
  [REPORTED_RUNNING_ID]: UNKNOWN_REPORT,
};

/**
 * 스레드가 절단되는 세션. `/replies` 는 오래된 쪽부터만 페이지되므로(서버에
 * 내림차순이 없다) 이 세션의 5×200 창에는 ACP 이벤트만 들어오고 리포트는 늘 그
 * 바깥이다.
 */
const TRUNCATED = new Set([LONG_ID]);

/** 리포트가 채널 원장에 앉은 자리. 초장기 세션의 것은 스레드 창 훨씬 뒤에 있다. */
const REPORT_SEQ_OF = {
  [CLEAN_ID]: 3100,
  [FAILING_ID]: 3101,
  [WIDEST_ID]: 3102,
  [LONG_ID]: 41_000,
  [REPORTED_RUNNING_ID]: 41_001,
};

const REPLY_BASE_MS = NOW - 1_400_000;

/** 서버가 `/replies` 한 페이지에 담는 최대치. 클라도 이 값을 청한다. */
const REPLY_PAGE_LIMIT = 200;

function acpEvent(sessionId, index, seq) {
  const rootId = ROOT_OF[sessionId];
  const steps = [
    ["의존성 설치", "npm ci"],
    ["게이트 실행", "run_gate"],
    ["결과 정리", "write_report"],
  ];
  const step = steps[index % steps.length];
  const atMs = REPLY_BASE_MS + index * 1_000;
  return {
    id: `${rootId}-event-${index}`,
    channelId: CHANNEL_OF[sessionId] ?? CHANNEL_ID,
    rootId,
    seq,
    hlcTs: atMs,
    hlcCount: 0,
    authorMemberId: ME,
    type: "system",
    body: "ACP session update",
    state: "sent",
    createdAtMs: atMs,
    props: {
      kind: "work_session_event",
      schema: "momo.work_session.acp_event.v1",
      event_type: "agent.status",
      event_id: `${rootId}-event-${index}`,
      event_ts: atMs,
      event: {
        work_session_id: sessionId,
        tool_call_name: step[1],
        detail: step[0],
      },
    },
  };
}

function reportMessage(sessionId) {
  const rootId = ROOT_OF[sessionId];
  const atMs = REPLY_BASE_MS + 600_000;
  return {
    id: `${rootId}-report`,
    channelId: CHANNEL_OF[sessionId] ?? CHANNEL_ID,
    rootId,
    seq: REPORT_SEQ_OF[sessionId],
    hlcTs: atMs,
    hlcCount: 0,
    authorMemberId: ME,
    type: "text",
    body: "작업을 마쳤습니다.",
    state: "sent",
    createdAtMs: atMs,
    props: REPORT_OF[sessionId],
  };
}

/**
 * 세션 스레드 한 페이지 (오래된 쪽부터, seq 커서).
 *
 * 짧은 세션은 ACP 이벤트 몇 줄과 리포트 하나로 끝난다. 절단되는 세션은 어느
 * 커서에서든 가득 찬 페이지와 `nextCursor` 를 돌려준다 — 그것이 클라가 실제로 겪는
 * 초장기 스레드의 모양이고, 5×200 예산이 거기서 소진된다.
 */
function repliesFor(sessionId, cursor) {
  if (TRUNCATED.has(sessionId)) {
    const from = (cursor ?? 3_000) + 1;
    const messages = Array.from({ length: REPLY_PAGE_LIMIT }, (_, i) =>
      acpEvent(sessionId, i, from + i)
    );
    return { messages, nextCursor: from + REPLY_PAGE_LIMIT - 1 };
  }
  if (cursor !== undefined) return { messages: [] };
  const messages = [0, 1, 2].map((index) =>
    acpEvent(sessionId, index, 3000 + index)
  );
  if (REPORT_OF[sessionId]) messages.push(reportMessage(sessionId));
  return { messages };
}

/**
 * 채널 히스토리(최신부터) — #1463 의 read-model.
 *
 * 완료 리포트는 스레드 답글이고 서버는 히스토리에서 그것을 걸러내지 않는다
 * (`list_channel_page` 에 `root_id IS NULL` 술어가 없다). 그래서 이 대역이 목록 행의
 * 유일한 원천이자, 절단된 스레드가 못 닿는 최신 리포트의 유일한 길이다.
 */
const CHANNEL_HISTORY = Object.keys(REPORT_OF)
  .map((sessionId) => reportMessage(sessionId))
  .sort((a, b) => b.seq - a.seq);

/** 스캔은 채널 단위다. 방이 둘이므로 대역도 방마다 갈라야 한다. */
function historyPage(channelId, limit, before) {
  const rows = CHANNEL_HISTORY.filter(
    (row) =>
      row.channelId.toLowerCase() === channelId.toLowerCase() &&
      (before === undefined || row.seq < before)
  ).slice(0, limit);
  const nextBefore = rows.length > 0 ? rows[rows.length - 1].seq : undefined;
  return { messages: rows, ...(nextBefore === undefined ? {} : { nextBefore }) };
}

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

/**
 * Centrifugo 대역의 최소 대역. 진짜 소켓이 없으면 `connStatus` 가 연결됨이 되지
 * 않고, 그러면 패널이 오프라인 배너를 쓴 채로 찍힌다 — 이 티켓이 보여줘야 하는
 * 것은 살아 있는 판의 위계다(오프라인 판은 별도 사진).
 */
async function installRealtimeSocket(page) {
  await page.addInitScript(() => {
    class CaptureWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;

      constructor(url) {
        this.url = url;
        this.readyState = CaptureWebSocket.CONNECTING;
        queueMicrotask(() => {
          this.readyState = CaptureWebSocket.OPEN;
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
                connect: { client: "session-chips-capture", version: "6" },
              };
            }
            if (command.subscribe) {
              return {
                id: command.id,
                subscribe: {
                  recoverable: true,
                  positioned: true,
                  recovered: false,
                  epoch: "session-chips-capture",
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
        this.readyState = CaptureWebSocket.CLOSED;
        this.onclose?.(new CloseEvent("close", { code: 1000 }));
      }
    }
    window.WebSocket = CaptureWebSocket;
  });
}

async function installMocks(context) {
  await context.route("**/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/auth/login") return json(route, SESSION);
    if (path === "/v1/auth/refresh") {
      return json(route, {
        accessToken: SESSION.accessToken,
        refreshToken: SESSION.refreshToken,
      });
    }
    if (path === "/v1/auth/realtime-token") {
      return json(route, {
        token: "capture-only-not-a-credential",
        tokenType: "Bearer",
        expiresAtMs: Date.now() + 60_000,
        ttlSeconds: 60,
        workspaceId: WORKSPACE_ID,
        memberId: ME,
      });
    }
    if (path.endsWith("/channels")) return json(route, { channels: CHANNELS });
    if (path.endsWith("/roster")) return json(route, { members: ROSTER });
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: HOSTS });
    if (path.includes("/work-sessions")) {
      return json(route, { workSessions: SESSIONS });
    }
    if (path.includes("/messages/") && path.endsWith("/replies")) {
      const url = new URL(route.request().url());
      const rootId = path.split("/messages/")[1].replace("/replies", "");
      const sessionId = Object.keys(ROOT_OF).find(
        (id) => ROOT_OF[id].toLowerCase() === rootId.toLowerCase()
      );
      const raw = url.searchParams.get("cursor");
      const cursor = raw === null ? undefined : Number(raw);
      return json(
        route,
        sessionId ? repliesFor(sessionId, cursor) : { messages: [] }
      );
    }
    if (path.endsWith("/messages")) {
      // #1463 — 검증 칩의 원천. 목록 행은 스레드를 열지 않고 이 대역만 읽는다.
      const url = new URL(route.request().url());
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const rawBefore = url.searchParams.get("before");
      const channelId = path.split("/channels/")[1]?.split("/")[0] ?? "";
      return json(
        route,
        historyPage(
          channelId,
          limit,
          rawBefore === null ? undefined : Number(rawBefore)
        )
      );
    }
    return json(route, {
      channels: [],
      members: [],
      read_states: [],
      messages: [],
      workSessions: [],
      workHosts: [],
    });
  });
}

async function waitForServer(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      throw new Error(`preview server never came up: ${url}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function openPanel(context) {
  const page = await context.newPage();
  await installRealtimeSocket(page);
  await page.goto(ORIGIN, { waitUntil: "networkidle" });
  await page.getByTestId("login-email").fill("seongjae@dawn.example");
  await page.getByTestId("login-password").fill("capture-only-not-a-credential");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-list").waitFor({ state: "visible" });
  await page
    .locator(`[data-testid="channel-list"] a[href="#/c/${CHANNEL_ID}"]`)
    .first()
    .click();
  await page.getByTestId("open-work-panel").click();
  await page.getByTestId("work-panel").waitFor({ state: "visible" });
  await page.getByTestId("work-scope-all").click();
  await page.getByTestId("work-session-row").first().waitFor();
  return page;
}

/**
 * 사진이 스스로 말하지 못하는 것 셋. 나머지는 사람이 본다.
 *
 *   1. 실행 중 세션은 시계다(`data-kind="clock"`).
 *   2. 끝난 세션은 성과 서술이다(`data-kind="worked"`).
 *   3. 리포트가 없는 세션에는 칩이 **없다**. 이것이 「미검증」을 쓰지 않는다는
 *      약속의 유일한 기계적 증거다 — 없는 노드는 사진에 찍히지 않는다.
 *   4. 1초에 못 미친 세션은 조사를 뗀다(「1초 미만 작업」, #1468). 사진은 그 문장이
 *      어색한지 말해 주지 않고, 어색함이 바로 이 티켓이 온 이유다.
 */
const ELAPSED_KINDS = `(() => {
  const rows = [...document.querySelectorAll('[data-testid="work-session-row"]')];
  return rows.map((row) => {
    const elapsed = row.querySelector('[data-testid="work-session-elapsed"]');
    return {
      sessionId: row.getAttribute("data-session-id"),
      kind: elapsed ? elapsed.getAttribute("data-kind") : null,
      label: elapsed ? elapsed.textContent.trim() : null,
    };
  });
})()`;

/**
 * 좁은 판에서 제목이 실제로 몇 픽셀을 남기는가 (design-review H-1).
 *
 * 기준은 비율이 아니라 **목록 행**이다. 리뷰어의 지적이 정확히 그 모양이었다:
 * "목록 행조차 더 많이 남기는데, 세션 식별이 유일한 임무인 상세 머리가 목록보다
 * 정보를 덜 준다." 그래서 같은 세션의 제목이 상세 머리에서 목록 행보다 좁아지면
 * 그것이 회귀다 — 두 자리 다 이름 하나를 두고 같은 320px 을 나눠 쓰므로 비교가
 * 성립한다.
 */
const ROW_TITLE_WIDTHS = `(() => {
  const rows = [...document.querySelectorAll('[data-testid="work-session-row"]')];
  const out = {};
  for (const row of rows) {
    const label = row.firstElementChild?.firstElementChild;
    if (!label) continue;
    out[String(row.getAttribute("data-session-id")).toLowerCase()] =
      Math.round(label.getBoundingClientRect().width);
  }
  return out;
})()`;

/**
 * 목록 행의 검증 칩 (#1463).
 *
 * 세 가지를 한 번에 답한다: 어느 행에 칩이 섰는가, 그 칩이 무엇이라 말하는가,
 * 그리고 **어느 행에 없는가**. 마지막이 이 게이트의 핵심이다 — 없는 노드는 사진에
 * 찍히지 않으므로, 「미검증」을 쓰지 않는다는 약속의 기계적 증거는 여기뿐이다.
 */
const ROW_VERIFICATIONS = `(() => {
  const rows = [...document.querySelectorAll('[data-testid="work-session-row"]')];
  const out = {};
  for (const row of rows) {
    const chip = row.querySelector('[data-testid="work-session-verification"]');
    // 윗줄의 두 번째 칸이 수명주기 칩이다(제목 · 상태 칩 · 경과).
    const status = row.firstElementChild?.children[1] ?? null;
    if (!chip) {
      out[String(row.getAttribute("data-session-id")).toLowerCase()] = null;
      continue;
    }
    const chipStyle = getComputedStyle(chip);
    const statusStyle = status ? getComputedStyle(status) : null;
    out[String(row.getAttribute("data-session-id")).toLowerCase()] = {
      lead: chip.getAttribute("data-lead"),
      label: chip.textContent.trim(),
      ink: chipStyle.color,
      ground: chipStyle.backgroundColor,
      border: parseFloat(chipStyle.borderTopWidth) || 0,
      rowGround: getComputedStyle(row).backgroundColor,
      statusLabel: status ? status.textContent.trim() : null,
      statusInk: statusStyle ? statusStyle.color : null,
      statusGround: statusStyle ? statusStyle.backgroundColor : null,
      statusBorder: statusStyle
        ? parseFloat(statusStyle.borderTopWidth) || 0
        : null,
    };
  }
  return out;
})()`;

/**
 * 목록이 자기 폭 안에 있는가 (#1463 리뷰 B1).
 *
 * 사진은 이것을 말해 주지 못한다 — 밀려난 칩은 **패널 밖에** 있으므로 패널
 * 스크린샷에 아예 찍히지 않고, 사라진 것과 구분되지 않는다. 그래서 숫자로 잰다:
 *
 *   pane   패널의 스크롤 기둥이 가로로 넘치는가. 320px 옆 패널 안에 가로 스크롤이
 *          생기면 그 자체가 결함이다.
 *   rows   각 행의 아랫줄이 자기 폭 안에 있는가. 앞 판에서는 방 이름이 `shrink-0`
 *          이라 요약이 0으로 줄어든 뒤 칩이 줄 밖으로 나갔다(scrollW 315 > 287).
 *   chip   칩의 오른쪽 끝이 행의 오른쪽 끝 안에 있는가. 위 둘이 통과해도 칩이
 *          `px-4` 안쪽 여백을 침범하면 그것은 다른 결함이다.
 */
const LIST_OVERFLOW = `(() => {
  const pane = document.querySelector('[data-testid="work-panel"] .overflow-y-auto')
    ?? document.querySelector('[data-testid="work-panel"]');
  const rows = [...document.querySelectorAll('[data-testid="work-session-row"]')];
  const out = { pane: null, rows: [] };
  if (pane) out.pane = { client: pane.clientWidth, scroll: pane.scrollWidth };
  for (const row of rows) {
    const line = row.lastElementChild;
    const chip = row.querySelector('[data-testid="work-session-verification"]');
    // 아랫줄의 **유연한** 두 칸: 방 이름과 요약. 둘 중 하나가 0px 이면 그 사실은
    // 화면에 아무 흔적도 남기지 않는다 — 생략부호조차 없다(#1463 재검토 H-1).
    const flexible = [...(line ? line.children : [])].filter(
      (node) => node !== chip && node.getAttribute("data-testid") === null
    );
    out.rows.push({
      sessionId: String(row.getAttribute("data-session-id")).toLowerCase(),
      client: line ? line.clientWidth : 0,
      scroll: line ? line.scrollWidth : 0,
      chipRight: chip ? Math.round(chip.getBoundingClientRect().right) : null,
      rowRight: Math.round(row.getBoundingClientRect().right),
      flexible: flexible.map((node) => ({
        text: node.textContent.trim().slice(0, 12),
        width: Math.round(node.getBoundingClientRect().width),
      })),
    });
  }
  return out;
})()`;

/**
 * 접힌 「세션 정보」의 경과 줄 (#1468). 라벨과 값을 함께 돌려준다 — 그 라벨이
 * 카드의 「작업 시간」과 같은 낱말인가가 이 티켓의 질문이고, 값은 위 성과 서술과
 * 같은 숫자여야 한다(격만 뺀 것).
 */
const META_ELAPSED = `(() => {
  const meta = document.querySelector('[data-testid="work-detail-meta"]');
  const value = meta?.querySelector('[data-testid="work-detail-elapsed-meta"]');
  const row = value?.closest("div");
  return {
    label: row ? row.querySelector("dt")?.textContent.trim() ?? null : null,
    value: value ? value.textContent.trim() : null,
    kind: value ? value.getAttribute("data-kind") : null,
    report:
      document
        .querySelector('[data-testid="work-detail-elapsed"][data-kind="worked"]')
        ?.textContent.trim() ?? null,
  };
})()`;

/**
 * 통과한 세션의 화면에서 초록이 **몇 개인가** (#1491).
 *
 * 사진은 두 초록을 나란히 보여줄 뿐 어느 쪽이 무엇을 뜻하는지 말하지 못하고,
 * 정확히 그것이 이 티켓이 온 이유였다: 수명주기 칩의 초록은 「멈췄다」 위에 얹힌,
 * 그 화면에서 가장 정보가 없는 초록이었다. 그래서 색을 **브라우저가 푼 픽셀 값**
 * 으로 재고 두 사실을 함께 단정한다 — 검증 칩은 --ok 그대로이고(옮긴 것이지 없앤
 * 것이 아니다), 수명주기 칩은 아니다.
 *
 * `--ok` 를 임시 노드에 얹어 읽는 이유는 그 토큰이 `light-dark()` 라 문자열로는
 * 지금 스킴의 값을 말하지 않기 때문이다. 푼 값끼리 대조해야 라이트·다크 두 판에서
 * 같은 질문이 성립한다.
 */
const CHIP_GREENS = `(() => {
  const probe = document.createElement("span");
  probe.style.color = "var(--ok)";
  document.body.appendChild(probe);
  const ok = getComputedStyle(probe).color;
  probe.remove();
  const inkOf = (id) => {
    const node = document.querySelector('[data-testid="' + id + '"]');
    return node ? getComputedStyle(node).color : null;
  };
  return {
    ok,
    status: inkOf("work-detail-status"),
    statusLabel:
      document.querySelector('[data-testid="work-detail-status"]')?.textContent.trim() ??
      null,
    verification: inkOf("work-detail-verification"),
    verificationLabel:
      document
        .querySelector('[data-testid="work-detail-verification"]')
        ?.textContent.trim() ?? null,
  };
})()`;

const DETAIL_TITLE_WIDTH = `(() => {
  const head = document.querySelector('[data-testid="work-detail-back"]').parentElement;
  const title = head.querySelector("h2, h3");
  return {
    row: Math.round(head.getBoundingClientRect().width),
    title: Math.round(title.getBoundingClientRect().width),
    clipped: title.scrollWidth > title.clientWidth + 1,
    text: title.textContent.trim(),
  };
})()`;

async function peek(page, sessionId) {
  await page
    .locator(`[data-testid="work-session-row"][data-session-id="${sessionId}"]`)
    .click();
  await page
    .locator(`[data-testid="work-session-peek"][data-session-id="${sessionId}"]`)
    .waitFor();
  await page.waitForTimeout(200);
}

async function captureScheme(browser, scheme) {
  const shots = [];
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    colorScheme: scheme,
    reducedMotion: "reduce",
  });
  await installMocks(context);
  const page = await openPanel(context);
  const panel = page.getByTestId("work-panel");

  const kinds = await page.evaluate(ELAPSED_KINDS);
  const byId = Object.fromEntries(
    kinds.map((row) => [String(row.sessionId).toLowerCase(), row])
  );
  const running = byId[RUNNING_ID];
  const clean = byId[CLEAN_ID];
  const widest = byId[WIDEST_ID];
  const blink = byId[BLINK_ID];
  if (running?.kind !== "clock") {
    throw new Error(
      `${scheme}: 실행 중 세션의 경과가 시계가 아니다 (${JSON.stringify(running)})`
    );
  }
  if (clean?.kind !== "worked") {
    throw new Error(
      `${scheme}: 끝난 세션의 경과가 성과 서술이 아니다 (${JSON.stringify(clean)})`
    );
  }
  if (blink?.label !== `${SUB_SECOND} ${BARE_SUFFIX}`) {
    throw new Error(
      `${scheme}: 1초 미만 세션의 낱말이 「${SUB_SECOND} ${BARE_SUFFIX}」가 아니다` +
        ` (${JSON.stringify(blink)}) — 「${SUB_SECOND} ${WORKED_SUFFIX}」는 조사가` +
        ` 기간 명사가 아닌 값을 받은 문장이다 (#1468)`
    );
  }
  console.log(
    `  ${scheme}: running=${running.label} · ended=${clean.label} · widest=${widest?.label}` +
      ` · blink=${blink.label}`
  );

  // 상세 머리의 제목이 비교당할 기준. 목록을 떠나기 전에 재 둔다.
  const rowTitleWidths = await page.evaluate(ROW_TITLE_WIDTHS);

  // ---- 목록 행의 칩 (#1463) ------------------------------------------------
  // 스캔이 도착할 때까지 기다린다. 행은 세션 목록과 함께 먼저 그려지고 칩은 채널
  // 히스토리 읽기가 돌아온 뒤에 선다 — 그 사이에 재면 「칩이 없다」가 언제나 참이다.
  // 스캔은 **채널당** 하나라, 방이 둘이면 도착도 둘이다. 한쪽만 기다리고 재면
  // 다른 방의 행은 아직 비어 있을 뿐인데 「칩이 없다」로 읽힌다.
  for (const id of [CLEAN_ID, LONG_ID]) {
    try {
      await page
        .locator(
          `[data-testid="work-session-row"][data-session-id="${id}"] [data-testid="work-session-verification"]`
        )
        .waitFor({ timeout: 10_000 });
    } catch {
      throw new Error(
        `${scheme}: 목록 행(${id.slice(-3)})에 검증 칩이 끝내 서지 않았다 — 행은` +
          ` 스레드를 읽지 않으므로, 채널 히스토리 스캔이 닿지 않으면 이 목록은 영영` +
          ` 아무 말도 하지 않는다 (#1463)`
      );
    }
  }
  const rowChips = await page.evaluate(ROW_VERIFICATIONS);
  for (const [name, id, expected] of [
    ["통과", CLEAN_ID, "pass"],
    ["실패", FAILING_ID, "fail"],
    // 초장기 세션. 스레드는 절단됐고 그 창 안에 리포트가 없는데도 칩이 선다 —
    // 이 한 줄이 grok H2 의 답이다(리포트가 가장 필요한 세션이 정확히 이 세션).
    ["초장기", LONG_ID, "fail"],
    ["미상", WIDEST_ID, "unknown"],
  ]) {
    const chip = rowChips[id.toLowerCase()];
    if (chip?.lead !== expected) {
      throw new Error(
        `${scheme}: ${name} 세션의 목록 행 칩이 ${expected} 가 아니다` +
          ` (${JSON.stringify(chip)}) — 행은 스레드를 읽지 않으므로 이 칩의 원천은` +
          ` 채널 히스토리 스캔뿐이다 (#1463)`
      );
    }
  }
  for (const [name, id] of [
    ["무보고", QUIET_ID],
    ["실행 중", RUNNING_ID],
  ]) {
    if (rowChips[id.toLowerCase()] !== null) {
      throw new Error(
        `${scheme}: ${name} 세션의 목록 행에 칩이 섰다` +
          ` (${JSON.stringify(rowChips[id.toLowerCase()])}) — 보고가 없는 것은` +
          ` 검증에 실패한 것이 아니다 (ADR-0132)`
      );
    }
  }
  // ---- 그릇이 살아남는가 (#1463 리뷰 H1) ------------------------------------
  // 앞 판의 칩 바탕은 행의 hover·선택 바탕과 **같은 토큰**이었다. 그래서 사람이
  // 가리키고 있는 행에서 알약이 통째로 사라졌다(대비 1.00). 사진은 「없어졌다」와
  // 「원래 없다」를 구분해 주지 않으므로, 여기서 푼 픽셀 값으로 직접 잰다.
  for (const [id, chip] of Object.entries(rowChips)) {
    if (chip === null) continue;
    if (chip.ground === chip.rowGround && chip.border === 0) {
      throw new Error(
        `${scheme}: 행 ${id.slice(-3)} 의 검증 칩이 행 바탕과 같은 색인데 테두리도` +
          ` 없다 (${chip.ground}) — 그릇이 사라진 알약은 배지가 아니라 여백의 조각이다`
      );
    }
  }
  // ---- 톤이 겹치는 한 쌍을 그릇이 가르는가 (#1463 리뷰 M2) -------------------
  const pair = rowChips[REPORTED_RUNNING_ID.toLowerCase()];
  if (pair === null || pair === undefined) {
    throw new Error(`${scheme}: 실행 중 + 보고 세션의 행을 찾지 못했다`);
  }
  if (pair.statusInk !== pair.ink) {
    throw new Error(
      `${scheme}: 픽스처가 더 이상 같은 톤 한 쌍을 만들지 않는다` +
        ` (수명주기 ${pair.statusInk} vs 검증 ${pair.ink}) — 이 단정이 지키려는 것은` +
        ` 「두 칩이 같은 색일 수 있다」는 사실 자체다`
    );
  }
  if (pair.statusGround === pair.ground && pair.statusBorder === pair.border) {
    throw new Error(
      `${scheme}: 「${pair.statusLabel}」과 「${pair.label}」이 같은 잉크에 같은 그릇` +
        `이다 — 원장의 판정과 세션의 자기 보고를 구분할 방법이 색뿐인데 그 색이 같다`
    );
  }
  console.log(
    `  ${scheme}: 목록 행 칩 ` +
      Object.entries(rowChips)
        .map(([id, chip]) => `${id.slice(-3)}=${chip ? chip.label : "없음"}`)
        .join(" · ")
  );
  console.log(
    `  ${scheme}: 같은 톤 한 쌍 「${pair.statusLabel}」/「${pair.label}」 ink ${pair.ink}` +
      ` · 그릇 ${pair.statusGround}(테두리 ${pair.statusBorder}) vs ${pair.ground}` +
      `(테두리 ${pair.border})`
  );

  // ---- 목록이 자기 폭 안에 있는가 (#1463 리뷰 B1) ---------------------------
  // 두 폭에서 잰다. 1280px 은 패널이 320px 인 판이고, 900px 은 패널이 292px 로
  // 줄어드는 판이다(tokens.css `work-panel-pane`) — 넘치기 시작하는 쪽은 후자다.
  for (const width of [1280, 900]) {
    if (width !== VIEWPORT.width) {
      await page.setViewportSize({ width, height: VIEWPORT.height });
      await page.waitForTimeout(200);
    }
    const overflow = await page.evaluate(LIST_OVERFLOW);
    if (overflow.pane && overflow.pane.scroll > overflow.pane.client + 1) {
      throw new Error(
        `${scheme}/${width}px: 목록 기둥에 가로 스크롤이 생겼다` +
          ` (client ${overflow.pane.client} < scroll ${overflow.pane.scroll}) —` +
          ` 320px 옆 패널 안에서 가로로 밀려난 것은 화면 밖에 있는 것이다 (#1463 B1)`
      );
    }
    for (const row of overflow.rows) {
      if (row.scroll > row.client + 1) {
        throw new Error(
          `${scheme}/${width}px: 행 ${row.sessionId.slice(-3)} 의 아랫줄이 넘쳤다` +
            ` (client ${row.client} < scroll ${row.scroll}) — 방 이름·요약·칩이 한 줄을` +
            ` 나눠 쓰는데 물러서지 않는 항목이 늘어난 것이다 (#1463 B1)`
        );
      }
      if (row.chipRight !== null && row.chipRight > row.rowRight) {
        throw new Error(
          `${scheme}/${width}px: 행 ${row.sessionId.slice(-3)} 의 칩이 행 밖으로` +
            ` 나갔다 (chip ${row.chipRight} > row ${row.rowRight})`
        );
      }
      // 넘치지 않는 것만으로는 모자란다 (#1463 재검토 H-1): 한 칸이 0px 로
      // 사라져도 줄은 자기 폭 안에 있다. 사라진 칸은 생략부호도 남기지 않으므로
      // 「잘렸다」와 구분되지 않고, 레일이 headline 을 나른 행에서는 그 행이 존재하는
      // 이유가 통째로 지워진다.
      for (const cell of row.flexible) {
        if (cell.width === 0) {
          throw new Error(
            `${scheme}/${width}px: 행 ${row.sessionId.slice(-3)} 의 아랫줄에서` +
              ` 「${cell.text}」 칸이 0px 로 사라졌다 — 부족분은 나눠 져야지 한쪽이` +
              ` 통째로 지워지면 안 된다 (#1463 재검토 H-1)`
          );
        }
      }
    }
    console.log(
      `  ${scheme}/${width}px: 기둥 ${overflow.pane.client}/${overflow.pane.scroll}` +
        ` · 아랫줄 최대 scrollW ${Math.max(...overflow.rows.map((r) => r.scroll))}` +
        ` (client ${overflow.rows[0]?.client})`
    );
    if (width !== 1280) {
      const narrow = `${OUT_DIR}/session-list-${width}-${scheme}.png`;
      await panel.screenshot({ path: narrow });
      shots.push(narrow);
    }
  }
  await page.setViewportSize(VIEWPORT);
  await page.waitForTimeout(200);

  const list = `${OUT_DIR}/session-list-${scheme}.png`;
  await panel.screenshot({ path: list });
  shots.push(list);

  // ---- 「내 세션」 목록 (#1463) ---------------------------------------------
  // 그 범위는 끝난 세션을 빼므로, 여기서 칩이 설 수 있는 세션은 **아직 도는데 이미
  // 보고한** 세션뿐이다. 그 한 행이 두 칩의 독립을 사진으로 만든다: 원장은 「실행
  // 중」이라 부르고 세션 자신은 「통과 3」을 보고했다.
  await page.getByTestId("work-scope-mine").click();
  await page.getByTestId("my-work-session-list").waitFor();
  try {
    await page
      .locator(
        `[data-testid="my-work-session-row"][data-session-id="${REPORTED_RUNNING_ID}"]` +
          ` [data-testid="my-work-session-verification"]`
      )
      .waitFor({ timeout: 10_000 });
  } catch {
    throw new Error(
      `${scheme}: 「내 세션」 행에 검증 칩이 끝내 서지 않았다 — 도는 세션도 이미` +
        ` 보고했을 수 있고, 두 목록이 한 세션을 두고 다른 것을 말하면 안 된다 (#1463)`
    );
  }
  const mineChips = await page
    .getByTestId("my-work-session-verification")
    .count();
  if (mineChips !== 1) {
    throw new Error(
      `${scheme}: 「내 세션」의 검증 칩이 ${mineChips}개다 — 보고한 세션 하나에만` +
        ` 서야 하고, 아직 아무 말도 하지 않은 세션에는 서지 않아야 한다`
    );
  }
  const mine = `${OUT_DIR}/session-list-mine-${scheme}.png`;
  await panel.screenshot({ path: mine });
  shots.push(mine);
  await page.getByTestId("work-scope-all").click();
  await page.getByTestId("work-session-list").waitFor();

  for (const [name, id] of [
    ["clean", CLEAN_ID],
    ["attention", FAILING_ID],
    ["no-report", QUIET_ID],
    ["widest", WIDEST_ID],
    ["long-thread", LONG_ID],
  ]) {
    await peek(page, id);
    const chips = await page.getByTestId("work-peek-verification").count();
    if (name === "no-report" && chips !== 0) {
      throw new Error(
        `${scheme}: 리포트가 없는 세션에 검증 칩이 ${chips}개 섰다`
      );
    }
    if (name !== "no-report" && chips !== 1) {
      throw new Error(`${scheme}: ${name} 세션의 검증 칩이 ${chips}개다`);
    }
    // 선택된 행은 `--surface-hover` 를 입는다 — 앞 판의 칩 바탕과 **같은 토큰**이다
    // (#1463 리뷰 H1). 알약이 살아남는지는 정확히 여기서만 물을 수 있다.
    const peeked = (await page.evaluate(ROW_VERIFICATIONS))[id.toLowerCase()];
    if (peeked !== null && peeked !== undefined) {
      if (peeked.ground === peeked.rowGround && peeked.border === 0) {
        throw new Error(
          `${scheme}/${name}: 선택된 행에서 검증 칩의 그릇이 사라졌다` +
            ` (칩 ${peeked.ground} = 행 ${peeked.rowGround}, 테두리 없음) — 가리키고` +
            ` 있는 행에서 배지가 여백의 조각이 된다 (#1463 H1)`
        );
      }
      console.log(
        `  ${scheme}/${name}: 선택된 행 칩 ${peeked.ground} vs 행 ${peeked.rowGround}` +
          ` (테두리 ${peeked.border}px)`
      );
    }
    if (name === "long-thread") {
      // 이 미리보기는 두 문장을 **동시에** 말해야 한다: 진행 내역은 앞부분만
      // 읽었다(절단 고지)는 것과, 그런데도 이 세션의 최신 보고는 이것이라는 것.
      // 앞 판에서는 뒤쪽이 침묵이었고, 그 침묵이 정확히 grok H2 였다.
      const notice = await page.getByTestId("work-peek-truncated").count();
      if (notice !== 1) {
        throw new Error(
          `${scheme}: 초장기 세션의 미리보기에 절단 고지가 ${notice}개다 —` +
            ` 픽스처가 더 이상 절단을 재현하지 못하면 이 사진은 아무것도 증명하지 않는다`
        );
      }
    }
    const shot = `${OUT_DIR}/session-peek-${name}-${scheme}.png`;
    await panel.screenshot({ path: shot });
    shots.push(shot);
  }

  for (const [name, id] of [
    ["attention", FAILING_ID],
    ["clean", CLEAN_ID],
    ["widest", WIDEST_ID],
    // 초장기 세션의 상세 (#1463). 사람이 이 보고를 실제로 읽는 자리가 여기이고,
    // 앞 판에서 이 화면은 「보고 없음」이었다.
    ["long-thread", LONG_ID],
  ]) {
    await peek(page, id);
    await page.getByTestId("work-session-open").click();
    await page.getByTestId("work-detail").waitFor();
    await page.getByTestId("work-detail-verification").waitFor();
    await page.waitForTimeout(200);
    // H-1 의 수치. 사진만으로는 다음 사람이 이 회귀를 다시 알아보지 못한다.
    const head = await page.evaluate(DETAIL_TITLE_WIDTH);
    const inRow = rowTitleWidths[id.toLowerCase()];
    console.log(
      `  ${scheme}/${name}: 제목 상세 ${head.title}px / 목록 ${inRow}px` +
        `${head.clipped ? " (잘림)" : ""} 「${head.text}」`
    );
    if (head.title < inRow) {
      throw new Error(
        `${scheme}/${name}: 320px 상세 머리의 제목(${head.title}px)이 목록 행` +
          `(${inRow}px)보다 좁다 — 세션 식별이 유일한 임무인 줄이 목록보다 적게` +
          ` 말한다 (H-1 회귀, 「${head.text}」)`
      );
    }
    // 초록의 개수 (#1491). 통과한 세션이 이 질문의 자리다 — 거기서만 두 칩이
    // 동시에 초록일 수 있었다.
    const greens = await page.evaluate(CHIP_GREENS);
    if (greens.status === greens.ok) {
      throw new Error(
        `${scheme}/${name}: 수명주기 칩 「${greens.statusLabel}」이 --ok(${greens.ok})` +
          ` 를 입고 있다 — 「멈췄다」는 초록을 벌지 않는다 (#1491)`
      );
    }
    if (name === "clean" && greens.verification !== greens.ok) {
      throw new Error(
        `${scheme}/${name}: 통과 세션의 검증 칩 「${greens.verificationLabel}」이` +
          ` --ok(${greens.ok})가 아니다 (${greens.verification}) — 초록은 없앤 것이` +
          ` 아니라 정보가 있는 자리로 옮긴 것이다 (#1491)`
      );
    }
    console.log(
      `  ${scheme}/${name}: 수명주기 「${greens.statusLabel}」 ${greens.status}` +
        ` · 검증 「${greens.verificationLabel}」 ${greens.verification}` +
        ` · --ok ${greens.ok}`
    );
    const shot = `${OUT_DIR}/session-detail-${name}-${scheme}.png`;
    await panel.screenshot({ path: shot });
    shots.push(shot);
    // 접힌 「세션 정보」를 펴서 같은 숫자의 두 번째 자리를 잰다 (#1468). 라벨이
    // 「작업 시간」이 아니면 한 화면의 한 숫자가 두 어근으로 불린다.
    const metaSummary = page.locator(
      '[data-testid="work-detail-meta"] > summary'
    );
    await metaSummary.click();
    await page.waitForTimeout(120);
    const meta = await page.evaluate(META_ELAPSED);
    if (meta.label !== WORKED_LABEL) {
      throw new Error(
        `${scheme}/${name}: 세션 정보의 경과 라벨이 「${WORKED_LABEL}」이 아니다` +
          ` (${JSON.stringify(meta)}) — 카드와 같은 측정을 다른 어근으로 부른다 (#1468)`
      );
    }
    if (meta.report !== `${meta.value} ${WORKED_SUFFIX}`) {
      throw new Error(
        `${scheme}/${name}: 두 자리의 숫자가 갈라졌다 (${JSON.stringify(meta)})`
      );
    }
    console.log(
      `  ${scheme}/${name}: 세션 정보 「${meta.label} ${meta.value}」 · 보고 줄 「${meta.report}」`
    );
    const metaShot = `${OUT_DIR}/session-detail-${name}-meta-${scheme}.png`;
    await panel.screenshot({ path: metaShot });
    shots.push(metaShot);
    // 다시 접는다 — 아래 넓은 판 사진은 이 줄이 열리기 전과 같은 것을 물어야 한다.
    await metaSummary.click();
    await page.waitForTimeout(120);
    // 320px 은 이 행이 가장 빡빡한 판이고, 상세를 읽는 판은 넓은 쪽이다
    // (MOMO-619 R1 H2). 두 폭을 함께 남겨야 리뷰가 「좁을 때 제목이 얼마나
    // 밀리는가」와 「넓을 때 위계가 옳은가」를 따로 볼 수 있다.
    await page.getByTestId("work-panel-wide").click();
    await page.waitForTimeout(200);
    const wide = `${OUT_DIR}/session-detail-${name}-wide-${scheme}.png`;
    await panel.screenshot({ path: wide });
    shots.push(wide);
    await page.getByTestId("work-panel-wide").click();
    await page.waitForTimeout(200);
    await page.getByTestId("work-detail-back").click();
    await page.getByTestId("work-session-list").waitFor();
  }

  await context.close();
  return shots;
}

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) {
    throw new Error("dist/ is missing. Run `npm run build` first.");
  }
  mkdirSync(OUT_DIR, { recursive: true });

  const server = spawn(
    resolve(WEB_ROOT, "node_modules/.bin/vite"),
    ["preview", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"],
    { cwd: WEB_ROOT, stdio: "ignore" }
  );
  const shutdown = () => server.kill("SIGTERM");
  process.on("exit", shutdown);

  try {
    await waitForServer(ORIGIN);
    const browser = await chromium.launch();
    try {
      const all = [];
      for (const scheme of ["light", "dark"]) {
        all.push(...(await captureScheme(browser, scheme)));
      }
      for (const path of all) console.log(path);
    } finally {
      await browser.close();
    }
  } finally {
    shutdown();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
