#!/usr/bin/env node
// =============================================================================
// #4619 캡처: 대화 안 에이전트 작업 표시 v2 (docs/design-system/agent-work-display.md).
//
//   입력창 레일(A) · 머리 칩(B) · 예외 줄(D) · 이어지는 행의 거터 칩 · 스레드 요약 칩(E)
//
// 상태 일곱(1명 작업 중 · 2명 · 승인 대기 · 아직 받지 않았어요 · 실패 · 끝남 · 깨우는 신호가 닿지 않음) ×
// 라이트·다크 × 창 폭(1440 · 720 데스크탑 최소 · 390 폰 폭 웹), 그리고 머리 칩 일곱 종, 이어지는 행의 거터 칩(쉼·hover),
// 레일 팝오버, 취소 확인, 사람만 있는 대화와 에이전트 대화의 입력창 위 간격 대조, 긴 이름.
//
// 이 스크립트는 **그림만 찍지 않는다.** 실제 앱(빌드 산출물)에서 잰 숫자를 단정한다:
//   - 레일 y 이동 0: 같은 대화·같은 마지막 행에서 상태만 바꿨을 때 「마지막 행 바닥 ~ 입력창 카드 위」 간격이 모든 상태에서 같다.
//   - 칩이 행 높이를 바꾸지 않는다: 칩을 `display:none`으로 지운 같은 행과 높이가 같다(머리 칩·거터 칩 모두).
//   - 사람만 있는 대화는 간격 불변(폼 윗 여백 그대로), 에이전트 대화는 24(+폰 폭은 독의 위 경계선 1).
//   - 카드·줄·칩이 같은 낱말(「아직 받지 않았어요」), 대화에 경과 숫자 없음. 시간 초과·신호 소실은 칩도 줄과 같은 낱말·경고 톤.
//   - 레일 팝오버가 지원하는 가장 좁은 폭(320)까지 뷰포트 안에 선다(design-review r1 B2). 끊긴 레일의 한정 문장은 잘리지 않고(B1),
//     에이전트 글은 접힘·이름만·전문 중 하나이며 낱말 중간에서 끊기지 않는다(r2 B1-r2; 안쪽 폭 20rem·32rem 문턱).
//   - 행동 단추는 요청자·owner/admin에게만(구경꾼에게는 문장만, M2).
//
// 백엔드는 없다: `/v1/**`는 고정 응답이고 소켓은 구독만 받는다. **인물은 전부 가상**이다(이도현·박서연·최민수·정하윤,
// 달무리 스튜디오, 달무리봇·모래시계봇·구름봇): 레포는 공개이고 실제 팀원 이름·대화를 fixture에 넣지 않는다.
//
//   npm run build && OUT_DIR=<dir> node scripts/capture-4619.mjs
//   (ONLY=wide|narrow720|narrow390|narrow320|r2|full 로 한 묶음만; r2 = 끊긴 레일·팝오버 폭·구경꾼)
// =============================================================================

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "captures/4619");
const PORT = Number(process.env.CAPTURE_PORT || 5319);
const ONLY = process.env.ONLY || "";
const MIN = 60_000;

const workspaceId = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const SEO = "00000000-0000-7000-8000-000000000102";
const MINSU = "00000000-0000-7000-8000-000000000103";
const HAYUN = "00000000-0000-7000-8000-000000000104";
const A1 = "00000000-0000-7000-8000-000000000301";
const A2 = "00000000-0000-7000-8000-000000000302";
const CH = "00000000-0000-7000-8000-000000000201";
const GEN = "00000000-0000-7000-8000-000000000202";
const DM = "00000000-0000-7000-8000-000000000203";
const mid = (n) => `00000000-0000-7000-8000-0000000a${String(n).padStart(4, "0")}`;
const rid = (n) => `0199aa11-2222-7000-8000-0000000000${String(n).padStart(2, "0")}`;

const person = (id, kind, displayName, handle, extra = {}) => ({
  id, workspaceId, kind, status: "active", displayName, handle, channelCount: 2,
  channelIds: [CH, GEN], capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...extra,
});
/** 이 장면이 서는 채널(대부분 #디자인-리뷰, 에이전트 DM 장면만 DM). */
const channelOf = (scene) => scene.channelId ?? CH;
const rosterOf = (scene) => [
  person(ME, "human", scene.names?.[ME] ?? "이도현", "dohyun", { role: scene.role ?? "owner", channelIds: scene.channelId === DM ? [CH, GEN, DM] : [CH, GEN] }),
  person(SEO, "human", scene.names?.[SEO] ?? "박서연", "seoyeon"),
  person(MINSU, "human", scene.names?.[MINSU] ?? "최민수", "minsu"),
  person(HAYUN, "human", scene.names?.[HAYUN] ?? "정하윤", "hayun"),
  ...(scene.humansOnly
    ? []
    : [
        person(A1, "agent", "달무리봇", "dalmuri-bot", { ownerHumanId: ME, channelIds: scene.channelId === DM ? [CH, GEN, DM] : [CH, GEN] }),
        person(A2, "agent", "모래시계봇", "sand-bot", { ownerHumanId: ME }),
      ]),
];
const baseChannels = [
  { id: CH, workspaceId, kind: "public", name: "디자인-리뷰", muted: false },
  { id: GEN, workspaceId, kind: "public", name: "일반", muted: false },
];
/** 에이전트 DM 장면에서만 DM이 목록에 더해진다: 상대는 에이전트 한 명(서버 규칙 「DM·사람 작성자·에이전트 상대 정확히 하나」). */
const channelsOf = (scene) =>
  scene.channelId === DM ? [...baseChannels, { id: DM, workspaceId, kind: "dm", name: "", memberIds: [ME, A1], muted: false }] : baseChannels;
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: ME, workspaceId, kind: "human", displayName: "이도현", handle: "dohyun" },
  realtimeWebSocketUrl: "ws://capture-4619.invalid/connection/websocket",
};

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

// ---- 장면 조립 ---------------------------------------------------------------

/** 메시지 한 줄. `at`은 지금으로부터 몇 분 전인가. seq는 장면마다 순서대로 매긴다(구멍 없이). */
const m = (n, author, body, minAgo, extra = {}) => ({
  id: mid(n), authorMemberId: author, type: "text", body, state: "sent", ago: minAgo * MIN, ...extra,
});

/** 진행 읽기 한 줄(ADR-0200 `AgentRunProgress`). */
function runRow(now, n, trigger, extra) {
  return {
    id: rid(n), channelId: CH, agentMemberId: A1, triggerMessageId: mid(trigger),
    status: "queued", phase: "queued", leaseState: "none", stepCount: 0, ahead: [],
    createdAtMs: now - 20_000, updatedAtMs: now - 20_000, ...extra,
  };
}
const RUNNING = (now, stage) => ({
  status: "running", phase: "running", leaseState: "live", createdAtMs: now - 4 * MIN, updatedAtMs: now - 5_000,
  claimedAtMs: now - 3 * MIN, startedAtMs: now - 3 * MIN, lastEventAtMs: now - 5_000, latestStage: stage, stepCount: 2,
});
const CLAIMED = (now) => ({ status: "queued", phase: "claimed", leaseState: "live", createdAtMs: now - MIN, updatedAtMs: now - 8_000, claimedAtMs: now - 8_000 });
const APPROVAL = (now) => ({
  status: "awaiting_approval", phase: "awaiting_approval", leaseState: "live", createdAtMs: now - 6 * MIN, updatedAtMs: now - MIN,
  claimedAtMs: now - 5 * MIN, startedAtMs: now - 5 * MIN, lastEventAtMs: now - MIN,
  approvalId: "0199aa11-2222-7000-8000-0000000000d1", approvalExpiresAtMs: now + 50 * MIN,
});
const UNCOLLECTED = (now) => ({ createdAtMs: now - 12 * MIN, updatedAtMs: now - 12 * MIN, queuePosition: 1, aheadTotal: 0 });
const FAILED = (now) => ({
  status: "failed", phase: "failed", leaseState: "none", createdAtMs: now - 5 * MIN, updatedAtMs: now - MIN,
  claimedAtMs: now - 4 * MIN, startedAtMs: now - 4 * MIN, finishedAtMs: now - MIN, endReason: "agent_error",
});
const TIMED_OUT = (now) => ({
  status: "timed_out", phase: "timed_out", leaseState: "none", createdAtMs: now - 8 * MIN, updatedAtMs: now - MIN,
  claimedAtMs: now - 7 * MIN, startedAtMs: now - 7 * MIN, finishedAtMs: now - MIN, endReason: "lease_abandoned",
});
const DONE = (now) => ({
  status: "succeeded", phase: "succeeded", leaseState: "none", createdAtMs: now - 5 * MIN, updatedAtMs: now - MIN,
  claimedAtMs: now - 4 * MIN, startedAtMs: now - 4 * MIN, finishedAtMs: now - MIN,
});

/**
 * 대화 한 벌. **마지막 줄은 언제나 같은 평범한 글**이다(정하윤 「점심 먹고 이어서 볼게요」): 상태만 바꿨을 때 그 글의 바닥과
 * 입력창 카드 위 사이가 움직이는지를 같은 자로 잰다. 나머지는 상태마다 다르다.
 */
function conversation(kind, now, triggerAuthor = ME) {
  const rows = [
    m(1, SEO, "지난주 인터뷰 메모를 한 장으로 정리해 줄래요? @달무리봇", 52),
    m(2, A1, "정리했어요. 핵심은 세 가지예요. 첫째, 처음 쓰는 사람은 설정 단계에서 가장 많이 멈춰요.", 50, { replyToId: mid(1) }),
    m(3, triggerAuthor, "@달무리봇 이번 주 회의록 초안도 부탁해요", 9),
  ];
  const runs = [runRow(now, 0, 1, { ...DONE(now), createdAtMs: now - 52 * MIN, claimedAtMs: now - 51 * MIN, startedAtMs: now - 51 * MIN, finishedAtMs: now - 50 * MIN })];
  const trigger = (extra) => runs.push(runRow(now, 1, 3, extra));
  switch (kind) {
    case "working1":
      trigger(RUNNING(now, "회의록 초안 정리 중"));
      break;
    case "working2":
      rows.push(m(4, SEO, "@모래시계봇 일정 표도 같이 맞춰 줄래요?", 7));
      trigger(RUNNING(now, "회의록 초안 정리 중"));
      runs.push(runRow(now, 2, 4, { ...RUNNING(now, "일정 표 맞추는 중"), agentMemberId: A2, createdAtMs: now - 3 * MIN }));
      break;
    case "approval":
      trigger(APPROVAL(now));
      break;
    case "uncollected":
      trigger(UNCOLLECTED(now));
      break;
    case "failed":
      trigger(FAILED(now));
      break;
    case "timedOut":
      trigger(TIMED_OUT(now));
      break;
    case "done":
      rows.push(m(5, A1, "초안을 올렸어요. 결정이 필요한 항목 두 개에 표시해 뒀어요.", 1, { replyToId: mid(3) }));
      trigger(DONE(now));
      break;
    case "wakeFailed":
      trigger({ createdAtMs: now - 25_000, updatedAtMs: now - 25_000, queuePosition: 1, aheadTotal: 0 });
      break;
    case "idle":
    default:
      break;
  }
  rows.push(m(9, MINSU, "저는 디자인 시안 먼저 볼게요", 4));
  rows.push(m(10, HAYUN, "점심 먹고 이어서 볼게요", 2));
  return { rows, runs };
}

/** 머리 칩 일곱 종이 한 화면에: 서로 다른 사람이 서로 다른 에이전트 상태를 부른 일곱 메시지. */
function gallery(now) {
  const rows = [
    m(21, SEO, "@달무리봇 인터뷰 메모를 한 장으로 줄여 줄래요?", 40),
    m(22, ME, "@달무리봇 표지 문구 후보 세 개만 뽑아 줘요", 34),
    m(23, MINSU, "@달무리봇 지난 분기 지표를 표로 맞춰 줘요", 28),
    m(24, SEO, "@달무리봇 새 안내문을 팀 채널에 올려도 될까요?", 22),
    m(25, ME, "@달무리봇 오늘 일정 요약해 줘요", 16),
    m(26, HAYUN, "@달무리봇 시안 파일 이름을 규칙에 맞게 바꿔 줘요", 10),
    m(27, SEO, "@달무리봇 회의 링크 다시 보내 줘요", 4),
    m(28, MINSU, "@달무리봇 어제 올린 시안에 코멘트를 달아 줘요", 2),
  ];
  const r = (n, trigger, extra) => runRow(now, n, trigger, extra);
  const runs = [
    r(21, 25, { ...DONE(now), createdAtMs: now - 16 * MIN, claimedAtMs: now - 15 * MIN, startedAtMs: now - 15 * MIN, finishedAtMs: now - 13 * MIN }),
    r(22, 26, { createdAtMs: now - 10 * MIN, updatedAtMs: now - 10 * MIN, queuePosition: 1, aheadTotal: 0 }),
    r(23, 27, FAILED(now)),
    r(24, 21, { ...CLAIMED(now), createdAtMs: now - 40 * MIN }),
    r(25, 22, { ...RUNNING(now, "문구 후보 다듬는 중"), createdAtMs: now - 34 * MIN }),
    r(26, 23, { ...APPROVAL(now), createdAtMs: now - 28 * MIN }),
    r(27, 24, { createdAtMs: now - 20_000, updatedAtMs: now - 20_000, queuePosition: 1, aheadTotal: 0 }),
    r(28, 28, TIMED_OUT(now)),
  ];
  // 위 r(…)의 trigger 인자는 메시지 번호가 아니라 rows의 mid(n)이다.
  runs[0].triggerMessageId = mid(25);
  runs[1].triggerMessageId = mid(26);
  runs[2].triggerMessageId = mid(27);
  runs[3].triggerMessageId = mid(21);
  runs[4].triggerMessageId = mid(22);
  runs[5].triggerMessageId = mid(23);
  runs[6].triggerMessageId = mid(24);
  runs[7].triggerMessageId = mid(28);
  return { rows, runs };
}

/** 이어지는 행: 같은 사람이 2분 안에 세 줄을 이어 썼고, 둘째·셋째가 에이전트를 불렀다. */
function continuing(now) {
  const rows = [
    m(31, MINSU, "저는 디자인 시안 먼저 볼게요", 20),
    m(41, SEO, "자료 올려 둘게요", 6),
    m(42, SEO, "@달무리봇 요약 부탁해요", 5, { sameGroup: true }),
    m(43, SEO, "@모래시계봇 표도요", 4, { sameGroup: true }),
    m(44, HAYUN, "점심 먹고 이어서 볼게요", 2),
  ];
  const runs = [
    runRow(now, 41, 42, { ...RUNNING(now, "요약 정리 중"), createdAtMs: now - 4 * MIN }),
    runRow(now, 42, 43, { ...FAILED(now), agentMemberId: A2, createdAtMs: now - 3 * MIN }),
  ];
  return { rows, runs };
}

/** 스레드 요약 줄의 작업 중 칩(E): 답글이 달린 루트를 내가 불렀고 일이 진행 중이다. */
function threadRoot(now) {
  const rows = [
    m(51, ME, "@달무리봇 분기 회고 문서 초안을 만들어 줘요", 14, { thread: { reply_count: 3, last_reply_seq: 99, last_reply_at: now - 3 * MIN } }),
    m(52, HAYUN, "점심 먹고 이어서 볼게요", 2),
  ];
  const runs = [runRow(now, 51, 51, { ...RUNNING(now, "회고 초안 정리 중"), createdAtMs: now - 12 * MIN })];
  return { rows, runs };
}

/** 위로 한 화면 넘게 올라간 트리거에서 「답함 ✓」을 누르면 답으로 가는지. */
function jumpScene(now) {
  const rows = [m(61, ME, "@달무리봇 분기 보고서 목차 먼저 잡아 줘요", 180)];
  for (let i = 0; i < 28; i += 1) {
    rows.push(m(70 + i, [SEO, MINSU, HAYUN][i % 3], `논의 메모 ${i + 1}: 오늘 안에 정리할 항목은 그대로 두고 내일 이어서 봐요`, 170 - i * 5));
  }
  rows.push(m(99, A1, "목차를 잡았어요. 다섯 장으로 나눴고 둘째 장은 비워 뒀어요.", 3, { replyToId: mid(61) }));
  const runs = [runRow(now, 61, 61, { ...DONE(now), createdAtMs: now - 179 * MIN, claimedAtMs: now - 178 * MIN, startedAtMs: now - 178 * MIN, finishedAtMs: now - 3 * MIN })];
  return { rows, runs };
}

/** 에이전트 DM: 사람 메시지마다 에이전트의 답이 달렸고 마지막 요청은 진행 중이다(「답함 ✓」 칩이 모든 사람 메시지에 서는 밀도). */
function dmScene(now) {
  const rows = [
    m(81, ME, "이번 주 인터뷰 메모를 세 줄로 줄여 줘요", 46),
    m(82, A1, "세 줄로 줄였어요. 처음 쓰는 사람이 설정에서 멈춘다는 이야기가 핵심이에요.", 44, { replyToId: mid(81) }),
    m(83, ME, "고마워요. 그럼 다음 주 일정표도 맞춰 줄래요?", 31),
    m(84, A1, "일정표를 맞췄어요. 목요일 오후 두 시가 비어 있어요.", 29, { replyToId: mid(83) }),
    m(85, ME, "목요일 두 시에 회의 초대 초안을 만들어 줘요", 12),
    m(86, A1, "초대 초안을 올렸어요. 참석자는 네 명으로 적었어요.", 10, { replyToId: mid(85) }),
    m(87, ME, "참석자에 정하윤도 넣어 줘요", 3),
  ];
  const done = (n, trigger, startAgo) => ({
    ...runRow(now, n, trigger, { ...DONE(now), createdAtMs: now - startAgo * MIN, claimedAtMs: now - (startAgo - 1) * MIN, startedAtMs: now - (startAgo - 1) * MIN, finishedAtMs: now - (startAgo - 2) * MIN }),
    channelId: DM,
  });
  const runs = [
    done(81, 81, 46),
    done(82, 83, 31),
    done(83, 85, 12),
    { ...runRow(now, 84, 87, { ...RUNNING(now, "참석자 명단 고치는 중"), createdAtMs: now - 2 * MIN }), channelId: DM },
  ];
  return { rows, runs };
}

function sceneOf(kind, opts = {}) {
  const now = Date.now();
  const base =
    kind === "dm" ? dmScene(now)
    : kind === "gallery" ? gallery(now)
    : kind === "continuing" ? continuing(now)
    : kind === "threadRoot" ? threadRoot(now)
    : kind === "jump" ? jumpScene(now)
    : conversation(kind, now, opts.triggerAuthor);
  const wakeKinds = new Set(["uncollected", "wakeFailed"]);
  const scene = {
    kind,
    now,
    channelId: kind === "dm" ? DM : CH,
    role: opts.role ?? "owner",
    humansOnly: opts.humansOnly ?? false,
    names: opts.names,
    messages: base.rows,
    runs: opts.humansOnly ? [] : base.runs,
    ledgers: {},
    // 「다시 깨우기」는 owner/admin이고 켜진 호스티드 연결이 있을 때만 스스로 선다(`WakeAgentButton`): 그 두 사실을 둔다.
    hosted: wakeKinds.has(kind) || kind === "gallery",
    liveness: wakeKinds.has(kind) || kind === "gallery" ? { [A1]: { state: "woken_not_collected", lastSignalAtMs: now - 3 * 60 * MIN } } : {},
    cancels: [],
  };
  if (kind === "wakeFailed") {
    scene.ledgers[rid(1)] = [
      { ordinal: 1, kind: "queued", createdAtMs: now - 25_000 },
      { ordinal: 2, kind: "doorbell_rung", code: "leading_failed", createdAtMs: now - 24_000 },
    ];
  }
  return scene;
}

// ---- 가짜 서버 ---------------------------------------------------------------

function messageRows(scene) {
  let seq = 10;
  return scene.messages.map((x) => {
    const createdAtMs = scene.now - x.ago;
    const row = {
      id: x.id, channelId: channelOf(scene), seq: seq++, hlcTs: createdAtMs, hlcCount: 0, authorMemberId: x.authorMemberId,
      type: x.type, body: x.body, state: x.state, createdAtMs,
    };
    if (x.replyToId !== undefined) row.replyToId = x.replyToId;
    if (x.thread !== undefined) row.thread = x.thread;
    return row;
  });
}

async function installRoutes(context, scene) {
  await context.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId: ME });
    }
    if (/\/inbox(\/|$)/.test(path)) return json(route, { error: { code: "not_found", message: "not found" } }, 404);
    if (path.endsWith("/channels")) return json(route, { channels: channelsOf(scene) });
    if (path.endsWith("/roster")) return json(route, { members: rosterOf(scene) });
    if (path.endsWith("/read-state") && method === "GET") {
      return json(route, { read_states: channelsOf(scene).map((c) => ({ channel_id: c.id, last_read_seq: 999, latest_seq: 999, unread_count: 0, mention_count: 0, marked_unread_before_seq: null })) });
    }
    if (path.endsWith("/approvals")) return json(route, { approvals: [] });
    if (path.endsWith(`/channels/${channelOf(scene)}/agent-runs/progress`)) return json(route, { runs: scene.runs });
    if (path.endsWith("/agent-runs/progress")) return json(route, { runs: [] });
    const liveness = path.match(/\/agents\/([^/]+)\/liveness$/);
    if (liveness) {
      const hit = scene.liveness[liveness[1].toUpperCase()] ?? scene.liveness[liveness[1].toLowerCase()];
      return hit ? json(route, { agentMemberId: liveness[1].toLowerCase(), ...hit }) : json(route, { error: { code: "not_found", message: "not found" } }, 404);
    }
    if (path.endsWith("/hosted-agent-connections") && method === "GET") {
      return json(route, {
        connections: scene.hosted
          ? [{ id: "00000000-0000-7000-8000-000000000500", agentMemberId: A1, status: "active", authMode: "static_bearer", audience: "https://oort.example.test", approvedChannelIds: [CH], approvedScopes: [], createdAtMs: 1, updatedAtMs: 1 }]
          : [],
      });
    }
    const cancel = path.match(/\/agent-runs\/([^/]+)\/cancel$/);
    if (cancel && method === "POST") {
      scene.cancels.push(cancel[1]);
      return json(route, { runId: cancel[1], status: "cancelled", linkedWorkSessionIds: [], workSessionsTerminated: false });
    }
    const events = path.match(/\/agent-runs\/([^/]+)\/events$/);
    if (events) return json(route, { runId: events[1], events: scene.ledgers[events[1]] ?? scene.ledgers[events[1].toLowerCase()] ?? [] });
    if (path.endsWith("/agent-runs")) return json(route, { runs: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: [] });
    if (path.endsWith("/work-sessions/shared")) return json(route, { sessions: [], nextCursor: null });
    if (path.endsWith("/work-sessions")) return json(route, { workSessions: [] });
    if (path.endsWith("/reminders")) return json(route, { reminders: [] });
    if (path.endsWith(`/workspaces/${workspaceId}`)) return json(route, { workspace: { id: workspaceId, name: "달무리 스튜디오" } });
    if (path.includes(`/channels/${channelOf(scene)}/messages`)) return json(route, { messages: messageRows(scene) });
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
        // 오프라인 장면: 새 소켓은 열리지 않는다(재연결이 곧바로 성공해 끊긴 레일을 지우지 않게).
        if (window.__offline) {
          queueMicrotask(() => { this.readyState = 3; this.onclose?.(new CloseEvent("close", { code: 1006 })); });
          return;
        }
        queueMicrotask(() => { this.readyState = 1; this.onopen?.(new Event("open")); });
      }
      send(data) {
        const replies = String(data).trim().split("\n").map((line) => {
          const c = JSON.parse(line);
          if (c.connect) return { id: c.id, connect: { client: "capture-4619", version: "6" } };
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
const log = [];
function check(name, ok, detail = "") {
  const line = `${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`;
  console.log(line);
  log.push(line);
  if (!ok) failures.push(name);
}
const note = (line) => { console.log(line); log.push(line); };

async function open(browser, origin, vp, scene) {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height }, colorScheme: vp.scheme, reducedMotion: "reduce", serviceWorkers: "block",
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
  await page.getByTestId("channel-item").first().waitFor({ state: "attached", timeout: 20_000 });
  await page.evaluate((h) => { location.hash = h; }, `/c/${channelOf(scene)}`);
  await page.getByTestId("composer").waitFor({ timeout: 20_000 });
  // 로그인 단추를 누른 자리에 포인터가 남아 있으면 그 자리의 행이 hover로 칠해진다(캡처가 거짓말을 한다). 구석으로 치운다.
  await page.mouse.move(2, 2);
  await page.waitForTimeout(1400);
  return { context, page };
}

// ---- 측정 --------------------------------------------------------------------

/**
 * 목록과 입력창의 기하. 「레일 y 이동 0」은 **상자**로 잰다: 목록 상자의 바닥(`listBottom`)과 입력창 카드의 위(`cardTop`)는
 * 내용과 무관한 배치 값이라 정확히 같아야 한다. 마지막 행의 바닥은 목록이 바닥에 붙는 스크롤 반올림(최대 1px 미만)을 안고 있어
 * 참고값(`lastRowGap`)으로만 단정한다.
 */
async function geometry(page) {
  return page.evaluate(() => {
    const rect = (el) => el.getBoundingClientRect();
    const rows = [...document.querySelectorAll("[data-row-body]")];
    const lastRow = rows.at(-1)?.parentElement ?? null;
    const card = document.querySelector('[data-testid="composer-frame"]');
    const list = document.querySelector('[data-testid="timeline-virtuoso"]');
    const rail = document.querySelector('[data-testid="composer-working"]');
    const shell = document.querySelector('[data-testid="composer"]');
    const form = card?.closest("form");
    return {
      listBottom: list ? rect(list).bottom : null,
      cardTop: card ? rect(card).top : null,
      railGap: list && card ? rect(card).top - rect(list).bottom : null,
      lastRowGap: lastRow && card ? rect(card).top - rect(lastRow).bottom : null,
      railHeight: rail ? rect(rail).height : null,
      hasRail: rail !== null,
      railState: rail?.getAttribute("data-state") ?? null,
      formPaddingTop: form ? Number.parseFloat(getComputedStyle(form).paddingTop) : null,
      dockBorderTop: shell ? Number.parseFloat(getComputedStyle(shell).borderTopWidth) : 0,
    };
  });
}

const text = async (page, id) => ((await page.getByTestId(id).first().textContent()) ?? "").replace(/\s+/g, " ").trim();

/** 본문 아래쪽(마지막 몇 줄 + 입력창)을 자른다. */
async function crop(page, { height = 440, width = 700, extraTop = 0 } = {}) {
  const main = await page.locator("main").first().boundingBox();
  const composer = await page.getByTestId("composer").boundingBox();
  const bottom = composer.y + composer.height;
  const h = height + extraTop;
  const y = Math.max(0, bottom - h);
  return page.screenshot({
    clip: { x: main.x, y, width: Math.min(main.width, width), height: Math.min(h, bottom - y) },
  });
}

/** 머리 칩 한 줄이 행 높이를 바꾸지 않는가: 칩을 지운 같은 행과 높이를 잰다(`display:none`은 상자를 걷는다). */
async function rowHeightsWithAndWithoutChip(page) {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll("[data-row-body]")]
      .map((body) => body.parentElement)
      .filter((row) => row.querySelector('[data-testid="trigger-chip"]'));
    const withChip = rows.map((row) => row.getBoundingClientRect().height);
    const style = document.createElement("style");
    style.setAttribute("data-probe", "chip-off");
    style.textContent = '[data-testid="trigger-chip"], [data-row-chip] { display: none !important; }';
    document.head.append(style);
    const without = rows.map((row) => row.getBoundingClientRect().height);
    style.remove();
    return { withChip, without };
  });
}

// ---- 컨택트 시트 -------------------------------------------------------------

async function sheet(browser, scheme, name, items, columns) {
  const dark = scheme === "dark";
  const bg = dark ? "#16171b" : "#eceae6";
  const ink = dark ? "#c9cbd2" : "#40424a";
  const cells = items
    .map(({ label, buf }) => `<figure><img src="data:image/png;base64,${buf.toString("base64")}"><figcaption>${label}</figcaption></figure>`)
    .join("");
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, colorScheme: scheme });
  const page = await ctx.newPage();
  await page.setContent(`<!doctype html><html><head><style>
    body { margin: 0; padding: 14px; background: ${bg}; font: 13px/1.3 -apple-system, "Apple SD Gothic Neo", sans-serif; color: ${ink}; }
    .grid { display: grid; grid-template-columns: repeat(${columns}, max-content); gap: 14px 16px; align-items: start; }
    figure { margin: 0; }
    img { display: block; border-radius: 6px; }
    figcaption { margin: 5px 2px 0; font-weight: 600; }
  </style></head><body><div class="grid">${cells}</div></body></html>`);
  await page.waitForTimeout(200);
  const path = resolve(OUT_DIR, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await ctx.close();
  note(`sheet ${path}`);
  return path;
}

// ---- 한 묶음: (창 폭, 스킴) ----------------------------------------------------

const STATE_LABELS = {
  working1: "1명 작업 중",
  working2: "2명 작업 중(합침)",
  approval: "승인 대기",
  uncollected: "아직 받지 않았어요 (owner)",
  failed: "실패",
  timedOut: "신호 소실(가져간 뒤 서버가 끝냄)",
  done: "끝남(답함 ✓)",
  wakeFailed: "깨우는 신호가 닿지 않음 (owner)",
};

async function bundle(browser, origin, vp, opts) {
  const tag = `${vp.width}-${vp.scheme}`;
  const phoneWidth = vp.width < 600;
  const items = [];
  const gaps = new Map();

  for (const kind of Object.keys(STATE_LABELS)) {
    const scene = sceneOf(kind);
    const { context, page } = await open(browser, origin, vp, scene);
    const g = await geometry(page);
    gaps.set(kind, g);
    const railText = g.railState === "active" ? await text(page, "composer-working-text") : "";
    const chips = (await page.getByTestId("trigger-chip").evaluateAll((els) => els.map((e) => `${e.getAttribute("data-kind")}:${e.getAttribute("data-variant") ?? "row"}`)));
    const line = (await page.getByTestId("run-exception-text").count()) > 0 ? await text(page, "run-exception-text") : "";
    note(`[${tag}] ${kind}: 레일「${railText}」 줄「${line}」 칩 ${chips.join(",")} 목록~입력창 ${g.railGap}`);

    // 상태별 단정(말이 맞는가)
    if (kind === "working1") {
      check(`${tag} working1: 레일 「달무리봇 · 작업 중 · 회의록 초안 정리 중」`, railText === "달무리봇 · 작업 중 · 회의록 초안 정리 중", railText);
      check(`${tag} working1: 예외 줄이 없다(평소의 진행은 줄을 세우지 않는다)`, line === "");
      // 결정 3: #4020 점 셋은 레일 안 작은 생존 표지로 남고, 동작 줄이기(이 캡처의 컨텍스트)에서는 멈춰 선다.
      const dots = await page.getByTestId("responding-dots").evaluateAll((els) => els.map((e) => ({ motion: e.getAttribute("data-motion"), inRail: e.closest('[data-testid="composer-working"]') !== null, animated: [...e.children].some((c) => getComputedStyle(c).animationName !== "none") })));
      check(`${tag} working1: 점 셋이 레일 안에 있고 동작 줄이기에서는 멈춰 선다`, dots.length === 1 && dots[0].inRail && dots[0].motion === "still" && !dots[0].animated, JSON.stringify(dots));
    }
    if (kind === "working2") check(`${tag} working2: 두 에이전트는 한 줄로 합친다`, railText === "달무리봇 +1", railText);
    if (kind === "approval") {
      check(`${tag} approval: 레일 「달무리봇 · 승인 대기」`, railText === "달무리봇 · 승인 대기", railText);
      check(`${tag} approval: 승인 대기는 「작업 중」이라 부르지 않는다`, !railText.includes("작업 중"));
    }
    if (kind === "uncollected") {
      check(`${tag} uncollected: 줄 「달무리봇: 아직 받지 않았어요 · 연결이 꺼져 있을 수 있어요」`, line === "달무리봇: 아직 받지 않았어요 · 연결이 꺼져 있을 수 있어요", line);
      check(`${tag} uncollected: 레일에서는 빠진다(한 군데서만 말한다)`, g.railState === "idle", String(g.railState));
      check(`${tag} uncollected: 대화에 경과 숫자가 없다`, !/\d+\s*(시간|분|초)/.test(line), line);
      await page.getByTestId("run-exception").getByTestId("wake-agent-button").waitFor({ timeout: 10_000 });
      check(`${tag} uncollected: 다시 깨우기(owner) · 취소 · 설정이 줄 안에 선다`,
        (await page.getByTestId("run-exception").getByTestId("wake-agent-button").count()) === 1 &&
        (await page.getByTestId("run-exception").getByTestId("agent-work-panel-stop-arm").count()) === 1 &&
        (await page.getByTestId("run-exception-settings").count()) === 1);
      // M3: 폰 폭에서 자기 줄을 갖는 행동 단추 셋은 44 이상(전역 `tap-target`이 실제로 먹는지 실제 앱에서 잰다).
      const boxes = await page.evaluate(() => ["wake-agent-button", "agent-work-panel-stop-arm", "run-exception-settings"].map((id) => {
        const r = document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect();
        return r ? { id, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 } : { id, w: 0, h: 0 };
      }));
      note(`[${tag}] uncollected 행동 단추 크기: ${boxes.map((b) => `${b.id}=${b.w}×${b.h}`).join(" ")}`);
      if (phoneWidth) check(`${tag} uncollected: 행동 단추 셋이 폰 폭에서 44×44 이상이다(M3)`, boxes.every((b) => b.h >= 43.99 && b.w >= 43.99), JSON.stringify(boxes));
    }
    if (kind === "failed") {
      check(`${tag} failed: 줄 「달무리봇: 실패 · 에이전트가 오류로 끝냈어요」`, line === "달무리봇: 실패 · 에이전트가 오류로 끝냈어요", line);
      check(`${tag} failed: 되돌릴 행동이 없다(다시 깨우기·취소 없음)`, (await page.getByTestId("run-exception").getByTestId("agent-work-panel-stop-arm").count()) === 0);
      check(`${tag} failed: 줄의 아이콘이 칩과 같은 가위표`, ((await page.getByTestId("run-exception").locator("svg").first().getAttribute("class")) ?? "").includes("circle-x"));
    }
    if (kind === "timedOut") {
      check(`${tag} timedOut: 줄 「달무리봇: 신호 소실 · 가져간 에이전트가 오래 응답하지 않아 서버가 끝냈어요」`, line === "달무리봇: 신호 소실 · 가져간 에이전트가 오래 응답하지 않아 서버가 끝냈어요", line);
      const chip = page.locator('[data-testid="trigger-chip"][data-kind="timed_out"]').first();
      check(`${tag} timedOut: 칩도 같은 낱말·경고 톤(위험 톤 아님)`, (await chip.count()) === 1 && /bg-warn-soft/.test((await chip.getAttribute("class")) ?? "") && !/danger/.test((await chip.getAttribute("class")) ?? ""));
      if (!phoneWidth && vp.width >= 900) check(`${tag} timedOut: 칩의 낱말 「신호 소실」`, (await chip.locator('[data-testid="trigger-chip-word"]').first().textContent())?.trim() === "신호 소실");
      check(`${tag} timedOut: 줄의 아이콘은 느낌표(가위표는 failed만)`, ((await page.getByTestId("run-exception").locator("svg").first().getAttribute("class")) ?? "").includes("circle-alert"));
    }
    if (kind === "done") {
      check(`${tag} done: 레일은 비고 칸은 남는다`, g.railState === "idle" && g.hasRail);
      const chip = page.locator('[data-testid="trigger-chip"][data-kind="answered"]').first();
      check(`${tag} done: 「답함 ✓」은 답을 알 때 눌리는 단추다`, (await chip.evaluate((el) => el.tagName)) === "BUTTON");
    }
    if (kind === "wakeFailed") {
      check(`${tag} wakeFailed: 유예를 기다리지 않고 줄 「달무리봇: 깨우는 신호가 닿지 않음」`, line.startsWith("달무리봇: 깨우는 신호가 닿지 않음"), line);
      await page.getByTestId("run-exception").getByTestId("wake-agent-button").waitFor({ timeout: 10_000 });
      check(`${tag} wakeFailed: 칩은 아직 진행 낱말(받음)`, chips.some((c) => c.startsWith("received")));
    }
    check(`${tag} ${kind}: 레일 칸 높이 24`, g.railHeight === null || Math.abs(g.railHeight - 24) < 0.51, String(g.railHeight));

    items.push({ label: `${STATE_LABELS[kind]}`, buf: await crop(page, { height: kind === "working2" ? 470 : 440, width: phoneWidth ? 420 : vp.width < 900 ? 720 : 700 }) });
    await context.close();
  }

  // 레일 y 이동 0: 같은 마지막 행에서 상태만 바꿨다.
  const idle = sceneOf("idle");
  {
    const { context, page } = await open(browser, origin, vp, idle);
    gaps.set("idle", await geometry(page));
    await context.close();
  }
  const gapValues = [...gaps.entries()].map(([k, v]) => `${k}=${v.railGap}`);
  note(`[${tag}] 목록 상자 바닥 ~ 입력창 카드 위: ${gapValues.join(" ")}`);
  const base = gaps.get("idle");
  const boxShift = Math.max(...[...gaps.values()].map((v) => Math.max(Math.abs(v.listBottom - base.listBottom), Math.abs(v.cardTop - base.cardTop))));
  check(`${tag} 레일 y 이동 0: 비어 있을 때와 아홉 장면(여덟 상태 + 빈 레일)의 목록 상자 바닥·입력창 카드 위가 같다(최대 차이 ${boxShift.toFixed(2)}px)`, boxShift < 0.01, gapValues.join(" "));
  const rowShift = Math.max(...[...gaps.values()].map((v) => Math.abs(v.lastRowGap - base.lastRowGap)));
  check(`${tag} 마지막 행 바닥~입력창 카드 위도 같다(스크롤 반올림 1px 미만 허용, 최대 차이 ${rowShift.toFixed(2)}px)`, rowShift < 1, [...gaps.entries()].map(([k, v]) => `${k}=${v.lastRowGap}`).join(" "));
  const expectedAgentGap = base.dockBorderTop + 24;
  check(`${tag} 에이전트 대화의 목록~입력창 간격은 ${expectedAgentGap}px(칸 24${base.dockBorderTop ? " + 독 경계선 1" : ""})`, Math.abs(base.railGap - expectedAgentGap) < 0.51, String(base.railGap));

  const out = { items };

  if (opts.extras) {
    // 머리 칩 일곱 종
    {
      const scene = sceneOf("gallery");
      const { context, page } = await open(browser, origin, vp, scene);
      const kinds = await page.getByTestId("trigger-chip").evaluateAll((els) => els.map((e) => ({ kind: e.getAttribute("data-kind"), variant: e.getAttribute("data-variant") ?? "row", w: e.getBoundingClientRect().width, h: e.getBoundingClientRect().height })));
      check(`${tag} 칩 여덟 종이 한 화면에: ${kinds.map((k) => k.kind).sort().join(",")}`,
        JSON.stringify(kinds.map((k) => k.kind).sort()) === JSON.stringify(["answered", "approval", "claimed", "failed", "received", "timed_out", "uncollected", "working"]));
      check(`${tag} 칩 크기 고정: 여덟 종의 폭·높이가 같다(${kinds[0]?.w.toFixed(1)}×${kinds[0]?.h.toFixed(1)})`,
        kinds.every((k) => Math.abs(k.w - kinds[0].w) < 0.01 && Math.abs(k.h - kinds[0].h) < 0.01));
      const words = await page.getByTestId("trigger-chip-word").evaluateAll((els) => els.filter((e) => e.getClientRects().length > 0).map((e) => e.textContent?.trim()));
      if (phoneWidth || vp.width < 900) {
        // 좁은 줄(머리 줄 폭 < 24rem)에서는 아이콘만: 낱말 층이 접힌다.
        const marks = await page.getByTestId("trigger-chip-mark").evaluateAll((els) => els.filter((e) => e.getClientRects().length > 0).length);
        note(`[${tag}] 좁은 줄: 보이는 낱말 ${words.length}개 · 보이는 아이콘 ${marks}개`);
      } else {
        check(`${tag} 넓은 줄: 여덟 낱말이 보인다`, words.length === 8, words.join("|"));
      }
      const heights = await rowHeightsWithAndWithoutChip(page);
      check(`${tag} 칩이 행 높이를 바꾸지 않는다(칩을 지운 같은 행과 높이가 같다, ${heights.withChip.length}행)`,
        heights.withChip.length === 8 && heights.withChip.every((h, i) => Math.abs(h - heights.without[i]) < 0.01), JSON.stringify(heights));
      items.push({ label: "머리 칩 여덟 종", buf: await crop(page, { height: 700, width: phoneWidth ? 420 : 700 }) });
      out.galleryItem = items.at(-1);
      await context.close();
    }
    // 이어지는 행의 거터 칩(쉼 · hover)
    {
      const scene = sceneOf("continuing");
      const { context, page } = await open(browser, origin, vp, scene);
      const chipRows = await page.locator("[data-row-chip]").count();
      const touch = await page.evaluate(() => matchMedia("(hover: none)").matches);
      const g0 = await page.evaluate(() => {
        const wrap = document.querySelector("[data-row-chip]");
        const chip = wrap?.querySelector('[data-testid="trigger-chip"]');
        const row = wrap?.closest("[data-row-body]") ?? wrap?.parentElement?.parentElement;
        const time = wrap?.parentElement?.querySelector('[data-testid="row-time"]');
        return wrap === null || wrap === undefined ? null : {
          chipKind: chip?.getAttribute("data-kind"), chipOpacity: Number.parseFloat(getComputedStyle(wrap).opacity), timeOpacity: Number.parseFloat(getComputedStyle(time).opacity),
          rowHeight: row?.getBoundingClientRect().height ?? null,
        };
      });
      check(`${tag} 이어지는 행: 거터 아이콘 칩이 둘(작업 중·실패)`, chipRows === 2, String(chipRows));
      check(`${tag} 이어지는 행: 쉬는 중 칩이 보이고 시각은 숨는다`, g0 !== null && g0.chipOpacity > 0.99 && g0.timeOpacity < 0.01, JSON.stringify(g0));
      const heights = await page.evaluate(() => {
        const rows = [...document.querySelectorAll("[data-row-chip]")].map((w) => w.closest("[data-row-body]")?.parentElement ?? w.parentElement.parentElement.parentElement);
        const withChip = rows.map((r) => r.getBoundingClientRect().height);
        const s = document.createElement("style");
        s.textContent = "[data-row-chip] { display: none !important; }";
        document.head.append(s);
        const without = rows.map((r) => r.getBoundingClientRect().height);
        s.remove();
        return { withChip, without };
      });
      check(`${tag} 이어지는 행: 거터 칩이 행 높이를 바꾸지 않는다`, heights.withChip.length === 2 && heights.withChip.every((h, i) => Math.abs(h - heights.without[i]) < 0.01), JSON.stringify(heights));
      out.gutterRest = await crop(page, { height: 380, width: phoneWidth ? 420 : 700 });
      // hover: 칩이 시각에 자리를 내준다.
      const target = page.locator("[data-row-chip]").first();
      await target.locator("xpath=ancestor::*[contains(@class,'group')][1]").hover();
      await page.waitForTimeout(250);
      const g1 = await page.evaluate(() => {
        const wrap = document.querySelector("[data-row-chip]");
        const time = wrap?.parentElement?.querySelector('[data-testid="row-time"]');
        return { chipOpacity: Number.parseFloat(getComputedStyle(wrap).opacity), timeOpacity: Number.parseFloat(getComputedStyle(time).opacity) };
      });
      if (!touch) check(`${tag} 이어지는 행: hover하면 칩은 시각에 자리를 내준다`, g1.chipOpacity < 0.01 && g1.timeOpacity > 0.99, JSON.stringify(g1));
      out.gutterHover = await crop(page, { height: 380, width: phoneWidth ? 420 : 700 });
      await context.close();
    }
    // 스레드 요약 칩(E)
    {
      const scene = sceneOf("threadRoot");
      const { context, page } = await open(browser, origin, vp, scene);
      const chip = await page.getByTestId("thread-work-chip").count();
      check(`${tag} 스레드 요약 줄에 「작업 중」 칩이 선다`, chip === 1, String(chip));
      out.thread = await crop(page, { height: 300, width: phoneWidth ? 420 : 700 });
      await context.close();
    }
    // 에이전트 DM: 모든 사람 메시지에 칩이 서는 밀도(design-review r1 M1의 증거 공백). 끝의 진행 중 요청은 레일이 말한다.
    {
      const scene = sceneOf("dm");
      const { context, page } = await open(browser, origin, vp, scene);
      const g = await geometry(page);
      const kinds = await page.getByTestId("trigger-chip").evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")));
      check(`${tag} 에이전트 DM: 사람 메시지 넷에 칩이 선다(답함 ×3 + 작업 중 ×1, ${kinds.join(",")})`, JSON.stringify([...kinds].sort()) === JSON.stringify(["answered", "answered", "answered", "working"]), kinds.join(","));
      check(`${tag} 에이전트 DM: 레일 칸이 서고(24) 진행 중 줄이 선다`, g.hasRail && Math.abs(g.railHeight - 24) < 0.51 && g.railState === "active", JSON.stringify(g));
      const dmRail = await text(page, "composer-working-text");
      check(`${tag} 에이전트 DM: 레일 「달무리봇 · 작업 중 · 참석자 명단 고치는 중」`, dmRail === "달무리봇 · 작업 중 · 참석자 명단 고치는 중", dmRail);
      const heights = await rowHeightsWithAndWithoutChip(page);
      check(`${tag} 에이전트 DM: 칩이 행 높이를 바꾸지 않는다(${heights.withChip.length}행)`, heights.withChip.length === 4 && heights.withChip.every((h, i) => Math.abs(h - heights.without[i]) < 0.01), JSON.stringify(heights));
      out.dm = await crop(page, { height: 560, width: phoneWidth ? Math.max(vp.width, 320) : 700 });
      await context.close();
    }
  }
  return out;
}

// ---- 확장: 팝오버·취소 확인·대화 간격 대조·점프·긴 이름 ---------------------------

async function popoverScene(browser, origin, vp) {
  const tag = `${vp.width}-${vp.scheme}`;
  const scene = sceneOf("working2");
  const { context, page } = await open(browser, origin, vp, scene);
  await page.getByTestId("composer-working-open").click();
  await page.getByTestId("composer-working-popover").waitFor();
  const agents = await page.getByTestId("composer-working-agent").allTextContents();
  check(`${tag} 팝오버: 일하는 에이전트가 각자의 낱말로 나란히`, agents.length === 2 && agents[0].includes("달무리봇") && agents[1].includes("모래시계봇"), agents.join("|"));
  check(`${tag} 팝오버: 경과는 1분 단위로만`, agents.every((a) => !/\d+\s*초/.test(a)) && agents[0].includes("3분째"), agents.join("|"));
  check(`${tag} 팝오버: 「활동 보기」가 있다`, (await page.getByTestId("composer-working-activity").count()) === 1);
  const buf = await crop(page, { height: 440, extraTop: 120, width: vp.width < 600 ? 420 : 700 });
  await context.close();
  return buf;
}

async function cancelConfirmScene(browser, origin, vp) {
  const tag = `${vp.width}-${vp.scheme}`;
  const scene = sceneOf("uncollected");
  const { context, page } = await open(browser, origin, vp, scene);
  await page.getByTestId("run-exception").getByTestId("agent-work-panel-stop-arm").click();
  await page.getByTestId("run-exception").getByTestId("agent-work-panel-stop-confirm").waitFor();
  check(`${tag} 취소: 첫 클릭은 묻기만 한다`, scene.cancels.length === 0);
  const confirmText = ((await page.getByTestId("run-exception").getByTestId("agent-work-panel-stop-confirm").textContent()) ?? "").replace(/\s+/g, " ");
  check(`${tag} 취소: 확인 문장`, confirmText.includes("취소하면 이 요청은 여기서 끝나요"), confirmText);
  const confirmBoxes = await page.evaluate(() => ["agent-work-panel-stop-keep", "agent-work-panel-stop-commit"].map((id) => {
    const r = document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect();
    return r ? { id, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 } : { id, w: 0, h: 0 };
  }));
  note(`[${tag}] 취소 확인 단추 크기: ${confirmBoxes.map((b) => `${b.id}=${b.w}×${b.h}`).join(" ")}`);
  if (vp.width < 600) check(`${tag} 취소 확인: 「그대로 두기」·「취소 확정」이 폰 폭에서 같은 44(위험한 쪽만 크지 않다, M3)`, confirmBoxes.every((b) => b.h >= 43.99 && b.w >= 43.99), JSON.stringify(confirmBoxes));
  const buf = await crop(page, { height: 460, width: vp.width < 600 ? Math.max(vp.width, 320) : 700 });
  await page.getByTestId("run-exception").getByTestId("agent-work-panel-stop-commit").click();
  await page.waitForTimeout(500);
  check(`${tag} 취소: 확정하면 취소 요청이 한 번 나간다`, scene.cancels.length === 1, String(scene.cancels.length));
  await context.close();
  return buf;
}

async function spacingScenes(browser, origin, vp) {
  const tag = `${vp.width}-${vp.scheme}`;
  const phoneWidth = vp.width < 600;
  const out = [];
  for (const [label, scene] of [
    ["에이전트 대화(레일 칸 24)", sceneOf("idle")],
    ["사람만 있는 대화(칸 없음, 폼 윗 여백)", sceneOf("idle", { humansOnly: true })],
  ]) {
    const { context, page } = await open(browser, origin, vp, scene);
    const g = await geometry(page);
    const expected = g.dockBorderTop + (scene.humansOnly ? g.formPaddingTop : 24);
    check(`${tag} ${label}: 목록~입력창 간격 ${expected}px`, Math.abs(g.railGap - expected) < 0.51, String(g.railGap));
    if (scene.humansOnly) {
      check(`${tag} 사람만 있는 대화: 레일 칸이 없다(죽은 띠 없음)`, !g.hasRail);
      check(`${tag} 사람만 있는 대화: 간격이 폼의 윗 여백 그대로다(#1749, ${phoneWidth ? "폰 폭 12 + 독 경계선 1" : "8"})`, Math.abs(g.railGap - (g.formPaddingTop + g.dockBorderTop)) < 0.01 && g.formPaddingTop === (phoneWidth ? 12 : 8), JSON.stringify(g));
    }
    out.push({ label: `${label}: 목록~입력창 ${g.railGap}px`, buf: await crop(page, { height: 300, width: phoneWidth ? 420 : 700 }) });
    await context.close();
  }
  return out;
}

async function jumpScene2(browser, origin, vp) {
  const tag = `${vp.width}-${vp.scheme}`;
  const scene = sceneOf("jump");
  const { context, page } = await open(browser, origin, vp, scene);
  // 맨 위로 올라가 트리거를 찾는다(칩은 가상 목록 밖에서는 그려지지 않는다).
  const scroller = page.locator('[data-testid="timeline-virtuoso"]').first();
  await scroller.evaluate((el) => { el.scrollTop = 0; });
  await page.waitForTimeout(600);
  const chip = page.locator('[data-testid="trigger-chip"][data-kind="answered"]').first();
  await chip.waitFor({ timeout: 10_000 });
  check(`${tag} 점프: 위에서 본 「답함 ✓」은 단추다`, (await chip.evaluate((el) => el.tagName)) === "BUTTON");
  const before = await scroller.evaluate((el) => el.scrollTop);
  await chip.click();
  await page.waitForTimeout(1200);
  const after = await scroller.evaluate((el) => el.scrollTop);
  const answerVisible = await page.evaluate(() => {
    const el = [...document.querySelectorAll("[data-row-body]")].find((b) => (b.textContent ?? "").includes("목차를 잡았어요"));
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < innerHeight;
  });
  check(`${tag} 점프: 「답함 ✓」을 누르면 답 메시지로 간다(스크롤 ${Math.round(before)} → ${Math.round(after)})`, answerVisible && after > before, `${before} -> ${after}, visible=${answerVisible}`);
  await context.close();
}

async function longNameScene(browser, origin, vp) {
  const tag = `${vp.width}-${vp.scheme}`;
  const names = { [SEO]: "달무리 스튜디오 플랫폼엔지니어링팀 박서연" };
  const scene = sceneOf("gallery", { names });
  const { context, page } = await open(browser, origin, vp, scene);
  const rows = await page.evaluate(() => {
    const heads = [...document.querySelectorAll('[data-testid="row-time"]')]
      .filter((t) => t.closest("[data-row-body]")?.querySelector('[data-testid="trigger-chip"]'))
      .map((t) => t.parentElement);
    return heads.map((h) => ({ h: h.getBoundingClientRect().height, name: h.firstElementChild.textContent.trim().length, chipInside: h.querySelector('[data-testid="trigger-chip"]') !== null }));
  });
  const oneLine = Math.min(...rows.map((r) => r.h));
  check(`${tag} 긴 이름(21자): 모든 머리 줄이 한 줄이다(줄바꿈 0)`, rows.every((r) => Math.abs(r.h - oneLine) < 0.5 && r.chipInside), JSON.stringify(rows));
  const buf = await crop(page, { height: 640, width: vp.width < 600 ? 420 : 700 });
  await context.close();
  return buf;
}

// ---- r2 묶음(ONLY=r2): design-review r1의 B1·B2·M2 수리를 재는 장면(끊긴 레일·좁은 폭 팝오버·구경꾼) ----

const STALE_SENTENCE = "연결이 끊겨 갱신이 멈췄어요. 마지막으로 확인된 상태예요.";

/** 실시간 연결을 끊고 다시 붙지 못하게 한다(새 소켓은 열리자마자 닫힌다). REST는 그대로라 화면은 남는다. */
async function goOffline(page) {
  await page.evaluate(() => {
    window.__offline = true;
    window.__socket?.onclose?.(new CloseEvent("close", { code: 1006 }));
  });
  await page.getByTestId("composer-working-stale").waitFor({ state: "attached", timeout: 15_000 });
  await page.waitForTimeout(300);
}

/**
 * B1: 끊긴 레일은 한정 문장을 **전문 그대로, 잘림 없이** 보인다. 지원하는 가장 좁은 폭(320)부터 데스크탑 최소 창(720)까지 실제 앱에서 잰다.
 * 에이전트 글은 한정 문장에 자리를 내주되 낱말 중간에서 끊기지 않는다: 안쪽 폭에 따라 접힘 · 이름만 · 전문으로 선다(r2 B1-r2).
 */
async function offlineScene(browser, origin, vp) {
  const tag = `${vp.width}-${vp.scheme}`;
  const scene = sceneOf("working1");
  const { context, page } = await open(browser, origin, vp, scene);
  await goOffline(page);
  const g = await page.evaluate(() => {
    const shell = document.querySelector('[data-testid="composer-working"]');
    const stale = shell.querySelector('[data-testid="composer-working-stale"]');
    const agent = shell.querySelector('[data-testid="composer-working-text"]');
    const button = shell.querySelector("button").getBoundingClientRect();
    const sh = shell.getBoundingClientRect();
    const st = stale.getBoundingClientRect();
    const ag = agent.getBoundingClientRect();
    return {
      sentence: stale.textContent.trim(),
      clipped: stale.scrollWidth > stale.clientWidth + 0.5,
      staleWidth: st.width,
      staleNatural: stale.scrollWidth,
      agentWidth: ag.width,
      // 칸 안쪽 폭(컨테이너 쿼리가 묻는 폭)과 rem, 낱말·단계 조각, 보이는 글(r2 B1-r2: 접힘·이름만·전문 중 하나이고 잘리지 않는다).
      // 접혀 그려지지 않는 글(`display: none`)은 innerText가 textContent로 되돌아가므로 폭 0이면 빈 글로 본다.
      inner: shell.clientWidth - parseFloat(getComputedStyle(shell).paddingLeft) - parseFloat(getComputedStyle(shell).paddingRight),
      rem: parseFloat(getComputedStyle(document.documentElement).fontSize),
      tailWidth: (() => {
        const t = shell.querySelector('[data-testid="composer-working-tail"]');
        return t ? t.getBoundingClientRect().width : -1;
      })(),
      visible: ag.width === 0 ? "" : agent.innerText.replace(/\s+/g, " ").trim(),
      lead: (agent.firstElementChild?.textContent ?? "").trim(),
      full: (agent.textContent ?? "").replace(/\s+/g, " ").trim(),
      textCut: ag.width > 0 && agent.scrollWidth > agent.clientWidth + 0.5,
      overlap: ag.right > st.left + 0.5,
      buttonRight: button.right,
      shellRight: sh.right,
      shellHeight: sh.height,
      hasFaces: shell.querySelector('[data-testid="composer-working-avatars"]') !== null,
      hasDots: shell.querySelector('[data-testid="responding-dots"]') !== null,
      hScroll: document.documentElement.scrollWidth > innerWidth + 0.5,
      title: shell.querySelector("button").getAttribute("title") ?? "",
    };
  });
  const tier = g.inner < 20 * g.rem ? "접힘" : g.inner < 32 * g.rem ? "이름만" : "전문";
  note(`[${tag}] 끊긴 레일: 칸 안쪽 ${g.inner.toFixed(1)}px(${tier}) · 한정 문장 ${g.staleWidth.toFixed(1)}/${g.staleNatural}px · 에이전트 글 ${g.agentWidth.toFixed(1)}px 「${g.visible}」`);
  check(`${tag} 끊긴 레일: 한정 문장이 전문 그대로다`, g.sentence === STALE_SENTENCE, g.sentence);
  check(`${tag} 끊긴 레일: 한정 문장이 잘리지 않는다(B1, ${g.staleWidth.toFixed(1)} ≥ ${g.staleNatural})`, !g.clipped, JSON.stringify(g));
  check(`${tag} 끊긴 레일: 에이전트 글과 한정 문장이 겹치지 않고, 줄이 칸을 넘치지 않는다`, !g.overlap && g.buttonRight <= g.shellRight + 0.5, JSON.stringify(g));
  check(`${tag} 끊긴 레일: 에이전트 글이 부스러기로 남지 않는다(접히거나 이름이 읽힐 만큼, ${g.agentWidth.toFixed(1)}px)`, g.agentWidth === 0 || g.agentWidth >= 40, JSON.stringify(g));
  check(`${tag} 끊긴 레일: 보이는 에이전트 글이 낱말 중간에서 끊기지 않는다(B1-r2: 접힘·이름만·전문 중 하나, 줄임표 없음, 「${g.visible}」)`, !g.textCut && (g.visible === "" || g.visible === g.lead || g.visible === g.full), JSON.stringify(g));
  check(
    `${tag} 끊긴 레일: 칸 안쪽 ${g.inner.toFixed(1)}px는 「${tier}」 단계다(안쪽 20rem·32rem 문턱)`,
    tier === "접힘" ? g.agentWidth === 0 : tier === "이름만" ? g.visible === g.lead && g.tailWidth === 0 : g.visible === g.full && g.tailWidth > 0,
    JSON.stringify(g)
  );
  check(`${tag} 끊긴 레일: 칸 높이 24 · 가로 스크롤 없음`, Math.abs(g.shellHeight - 24) < 0.51 && !g.hScroll, JSON.stringify(g));
  check(`${tag} 끊긴 레일: 얼굴·점이 걷힌다(낡은 상태를 살아 있는 듯 보이지 않는다)`, !g.hasFaces && !g.hasDots, JSON.stringify(g));
  check(`${tag} 끊긴 레일: 보이는 글과 title·보조기술이 같은 문장을 쓴다`, g.title.endsWith(STALE_SENTENCE), g.title);
  const buf = await crop(page, { height: 240, width: vp.width < 600 ? Math.max(vp.width, 320) : 700 });
  await context.close();
  return buf;
}

/**
 * B2: 레일 팝오버는 어떤 폭에서도 뷰포트 안에 선다(고정 폭 384가 폰 폭에서 오른쪽을 넘던 것). 행·「활동 보기」도 안에 든다.
 */
async function popoverWidthScene(browser, origin, vp) {
  const tag = `${vp.width}-${vp.scheme}`;
  const scene = sceneOf("working2");
  const { context, page } = await open(browser, origin, vp, scene);
  await page.getByTestId("composer-working-open").click();
  await page.getByTestId("composer-working-popover").waitFor();
  await page.waitForTimeout(300);
  const r = await page.evaluate(() => {
    const box = document.querySelector('[data-testid="composer-working-popover"]').getBoundingClientRect();
    const inner = [...document.querySelectorAll('[data-testid="composer-working-agent"], [data-testid="composer-working-activity"]')].map((e) => e.getBoundingClientRect());
    return {
      left: box.left, right: box.right, width: box.width, vw: innerWidth,
      innerLeft: Math.min(...inner.map((b) => b.left)), innerRight: Math.max(...inner.map((b) => b.right)), rows: inner.length,
      hScroll: document.documentElement.scrollWidth > innerWidth + 0.5,
    };
  });
  note(`[${tag}] 팝오버: 폭 ${r.width.toFixed(1)} · 왼쪽 ${r.left.toFixed(1)} · 오른쪽 ${r.right.toFixed(1)} / 뷰포트 ${r.vw}`);
  check(`${tag} 팝오버가 뷰포트 안에 선다(B2, ${r.left.toFixed(1)}~${r.right.toFixed(1)} / ${r.vw})`, r.left >= -0.5 && r.right <= r.vw + 0.5, JSON.stringify(r));
  check(`${tag} 팝오버의 행(에이전트 둘 + 「활동 보기」)이 팝오버 안에 든다`, r.rows === 3 && r.innerLeft >= r.left - 0.5 && r.innerRight <= r.right + 0.5, JSON.stringify(r));
  check(`${tag} 팝오버가 가로 스크롤을 만들지 않는다`, !r.hScroll, JSON.stringify(r));
  const buf = await crop(page, { height: 420, extraTop: 120, width: vp.width < 600 ? Math.max(vp.width, 320) : 700 });
  await context.close();
  return buf;
}

/**
 * M2: 구경꾼(요청자도 owner/admin도 아닌 멤버)에게는 예외 줄의 **문장만** 서고 행동 단추(다시 깨우기·취소·설정)는 없다.
 * 칩은 모든 사람 메시지에 선다(planner 결정 2): 박서연이 부른 메시지에도.
 */
async function bystanderScene(browser, origin, vp) {
  const tag = `${vp.width}-${vp.scheme}`;
  const out = [];
  for (const [kind, label] of [["uncollected", "구경꾼: 아직 받지 않았어요"], ["failed", "구경꾼: 실패"]]) {
    const scene = sceneOf(kind, { role: "member", triggerAuthor: SEO });
    const { context, page } = await open(browser, origin, vp, scene);
    const line = await text(page, "run-exception-text");
    const wake = await page.getByTestId("run-exception").getByTestId("wake-agent-button").count();
    const cancel = await page.getByTestId("run-exception").getByTestId("agent-work-panel-stop-arm").count();
    const settings = await page.getByTestId("run-exception-settings").count();
    check(`${tag} ${label}: 문장은 선다(「${line}」)`, line.startsWith("달무리봇: "), line);
    check(`${tag} ${label}: 행동 단추가 없다(다시 깨우기 ${wake} · 취소 ${cancel} · 설정 ${settings})`, wake === 0 && cancel === 0 && settings === 0);
    const chipKinds = await page.getByTestId("trigger-chip").evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")));
    check(`${tag} ${label}: 남이 부른 메시지에도 칩이 선다(${chipKinds.join(",")})`, chipKinds.includes(kind === "failed" ? "failed" : "uncollected"), chipKinds.join(","));
    out.push({ label, buf: await crop(page, { height: 400, width: vp.width < 600 ? Math.max(vp.width, 320) : 700 }) });
    await context.close();
  }
  return out;
}

// ---- main --------------------------------------------------------------------

/** 창 전체의 모습(사이드바·머리·본문·입력창)을 한 장씩: 컨택트 시트가 자른 아래쪽이 창 어디에 서는지 보여 준다. */
async function fullWindowShots(browser, origin) {
  for (const [scheme, kind, width, height] of [
    ["light", "working1", 1440, 900],
    ["dark", "approval", 1440, 900],
  ]) {
    const { context, page } = await open(browser, origin, { width, height, scheme }, sceneOf(kind));
    const path = resolve(OUT_DIR, `full-${width}-${scheme}-${kind}.png`);
    await page.screenshot({ path });
    note(`full ${path}`);
    await context.close();
  }
}

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) throw new Error("dist/ is missing. Run npm run build first.");
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  const results = {};
  try {
    if (ONLY === "full") {
      await fullWindowShots(browser, preview.origin);
      return;
    }
    if (ONLY === "r2" || ONLY === "") {
      // design-review r1 보강: 끊긴 레일(B1)·좁은 폭 팝오버(B2)·구경꾼(M2).
      const offline = [];
      for (const [width, scheme] of [[320, "light"], [360, "light"], [375, "light"], [390, "light"], [390, "dark"], [720, "light"], [1440, "light"]]) {
        const buf = await offlineScene(browser, preview.origin, { width, height: 760, scheme });
        offline.push({ label: `끊긴 레일 ${width} ${scheme}`, buf });
      }
      await sheet(browser, "light", "offline-rail", offline, 2);
      const pops = [];
      for (const [width, scheme] of [[320, "light"], [360, "light"], [375, "light"], [390, "light"], [320, "dark"], [720, "light"]]) {
        const buf = await popoverWidthScene(browser, preview.origin, { width, height: 760, scheme });
        pops.push({ label: `팝오버 ${width} ${scheme}`, buf });
      }
      await sheet(browser, "light", "popover-widths", pops, 3);
      const by = [];
      for (const [width, scheme] of [[390, "light"], [720, "light"]]) {
        for (const item of await bystanderScene(browser, preview.origin, { width, height: 760, scheme })) by.push({ ...item, label: `${item.label} (${width})` });
      }
      await sheet(browser, "light", "bystander", by, 2);
      if (ONLY === "r2") {
        writeFileSync(resolve(OUT_DIR, "assertions-r2.txt"), `${log.join("\n")}\n`);
        if (failures.length > 0) {
          console.error(`\n${failures.length}개 단언 실패`);
          process.exit(1);
        }
        console.log(`\nPASS: ${log.filter((l) => l.startsWith("ok")).length}개 단언`);
        return;
      }
    }
    const plan = [
      { key: "wide", width: 1440, height: 900, extras: true, schemes: ["light", "dark"] },
      { key: "narrow720", width: 720, height: 800, extras: true, schemes: ["light", "dark"] },
      { key: "narrow390", width: 390, height: 800, extras: true, schemes: ["light"] },
      { key: "narrow320", width: 320, height: 700, extras: true, schemes: ["light"] },
    ];
    for (const p of plan) {
      if (ONLY && ONLY !== p.key) continue;
      for (const scheme of p.schemes) {
        const vp = { width: p.width, height: p.height, scheme };
        const name = `${p.key}-${scheme}`;
        const r = await bundle(browser, preview.origin, vp, { extras: p.extras });
        results[name] = { vp, r };
        // 상태 시트
        const cols = p.width < 600 ? 4 : p.width < 900 ? 2 : 2;
        await sheet(browser, scheme, `states-${name}`, r.items.filter((i) => !i.label.startsWith("머리 칩")), cols);
        // 칩·거터·스레드 시트
        const extra = [
          { label: "머리 칩 여덟 종", buf: r.galleryItem.buf },
          { label: "이어지는 행: 쉼 (거터 아이콘 칩)", buf: r.gutterRest },
          { label: "이어지는 행: hover (시각에 자리를 내준다)", buf: r.gutterHover },
          { label: "스레드 요약 줄의 작업 중 칩", buf: r.thread },
          { label: "에이전트 DM: 사람 메시지마다 칩(답함 ×3 + 작업 중)", buf: r.dm },
        ];
        if (p.key === "wide" || p.key === "narrow720") {
          extra.push({ label: "레일 팝오버", buf: await popoverScene(browser, preview.origin, vp) });
          extra.push({ label: "취소 확인(예외 줄 안)", buf: await cancelConfirmScene(browser, preview.origin, vp) });
        } else {
          // 폰 폭: 팝오버는 별도 장면(popover-widths)이 재고, 취소 확인은 여기서 44를 잰다.
          extra.push({ label: "취소 확인(예외 줄 안)", buf: await cancelConfirmScene(browser, preview.origin, vp) });
        }
        await sheet(browser, scheme, `extras-${name}`, extra, p.width < 600 ? 4 : 2);
        if (scheme === "light") {
          const spacing = await spacingScenes(browser, preview.origin, vp);
          await sheet(browser, scheme, `spacing-${name}`, spacing, p.width < 600 ? 2 : 2);
        }
        if (p.key === "wide" && scheme === "light") await jumpScene2(browser, preview.origin, vp);
        if (p.key !== "wide" && scheme === "light") {
          const longName = await longNameScene(browser, preview.origin, vp);
          await sheet(browser, scheme, `longname-${name}`, [{ label: "긴 이름(21자)과 칩: 줄바꿈 0", buf: longName }], 1);
        }
      }
    }
  } finally {
    await browser.close();
    await preview.stop?.();
  }
  writeFileSync(resolve(OUT_DIR, `assertions-${ONLY || "all"}.txt`), `${log.join("\n")}\n`);
  if (failures.length > 0) {
    console.error(`\n${failures.length}개 단언 실패`);
    process.exit(1);
  }
  console.log(`\nPASS: ${log.filter((l) => l.startsWith("ok")).length}개 단언`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
