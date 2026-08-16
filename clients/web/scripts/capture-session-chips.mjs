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
const ME = "019f94e3-7a10-79cd-9dee-208f47edd9a8";
const HOST_ID = "019f9a01-0000-7000-8000-000000000501";

const RUNNING_ID = "019f9b00-0000-7000-8000-000000000601";
const CLEAN_ID = "019f9b00-0000-7000-8000-000000000602";
const FAILING_ID = "019f9b00-0000-7000-8000-000000000603";
const QUIET_ID = "019f9b00-0000-7000-8000-000000000604";
const WIDEST_ID = "019f9b00-0000-7000-8000-000000000605";
const BLINK_ID = "019f9b00-0000-7000-8000-000000000606";
const ROOT_OF = {
  [RUNNING_ID]: "019f9b00-0000-7000-8000-0000000006a1",
  [CLEAN_ID]: "019f9b00-0000-7000-8000-0000000006a2",
  [FAILING_ID]: "019f9b00-0000-7000-8000-0000000006a3",
  [QUIET_ID]: "019f9b00-0000-7000-8000-0000000006a4",
  [WIDEST_ID]: "019f9b00-0000-7000-8000-0000000006a5",
  [BLINK_ID]: "019f9b00-0000-7000-8000-0000000006a6",
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

function workSession(id, label, extra) {
  return {
    id,
    workspaceId: WORKSPACE_ID,
    channelId: CHANNEL_ID,
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
  workSession(WIDEST_ID, "결제 정산 배치 재실행 파이프라인 점검", {
    startedAtMs: NOW - HOUR_SCALE_MS,
  }),
  // 시작하자마자 끝난 세션 (#1468). 「1초 미만」은 기간 명사가 아니라 비교 표현이라
  // 조사 「동안」을 받지 못한다 — 그 문장이 화면에 서 본 적이 없어서 어색함이
  // 코드 추론으로만 남아 있었으므로, 여기서 실측한다.
  workSession(BLINK_ID, "배포 전 설정 문법 검사", { startedAtMs: NOW - 400 }),
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

const REPORT_OF = {
  [CLEAN_ID]: CLEAN_REPORT,
  [FAILING_ID]: FAILING_REPORT,
  [WIDEST_ID]: UNKNOWN_REPORT,
};

/** 세션 스레드 한 통: ACP 이벤트 몇 줄, 그리고 있으면 완료 리포트 하나. */
function repliesFor(sessionId) {
  const rootId = ROOT_OF[sessionId];
  const base = NOW - 1_400_000;
  const steps = [
    ["의존성 설치", "npm ci"],
    ["게이트 실행", "run_gate"],
    ["결과 정리", "write_report"],
  ];
  const messages = steps.map((step, index) => ({
    id: `${rootId}-event-${index}`,
    channelId: CHANNEL_ID,
    rootId,
    seq: 3000 + index,
    hlcTs: base + index * 60_000,
    hlcCount: 0,
    authorMemberId: ME,
    type: "system",
    body: "ACP session update",
    state: "sent",
    createdAtMs: base + index * 60_000,
    props: {
      kind: "work_session_event",
      schema: "momo.work_session.acp_event.v1",
      event_type: "agent.status",
      event_id: `${rootId}-event-${index}`,
      event_ts: base + index * 60_000,
      event: {
        work_session_id: sessionId,
        tool_call_name: step[1],
        detail: step[0],
      },
    },
  }));
  const report = REPORT_OF[sessionId];
  if (report) {
    messages.push({
      id: `${rootId}-report`,
      channelId: CHANNEL_ID,
      rootId,
      seq: 3100,
      hlcTs: base + 600_000,
      hlcCount: 0,
      authorMemberId: ME,
      type: "text",
      body: "작업을 마쳤습니다.",
      state: "sent",
      createdAtMs: base + 600_000,
      props: report,
    });
  }
  return messages;
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
      const rootId = path.split("/messages/")[1].replace("/replies", "");
      const sessionId = Object.keys(ROOT_OF).find(
        (id) => ROOT_OF[id].toLowerCase() === rootId.toLowerCase()
      );
      return json(route, {
        messages: sessionId ? repliesFor(sessionId) : [],
      });
    }
    if (path.endsWith("/messages")) return json(route, { messages: [] });
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

  const list = `${OUT_DIR}/session-list-${scheme}.png`;
  await panel.screenshot({ path: list });
  shots.push(list);

  for (const [name, id] of [
    ["clean", CLEAN_ID],
    ["attention", FAILING_ID],
    ["no-report", QUIET_ID],
    ["widest", WIDEST_ID],
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
    const shot = `${OUT_DIR}/session-peek-${name}-${scheme}.png`;
    await panel.screenshot({ path: shot });
    shots.push(shot);
  }

  for (const [name, id] of [
    ["attention", FAILING_ID],
    ["clean", CLEAN_ID],
    ["widest", WIDEST_ID],
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
