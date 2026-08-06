import { uuidEq, type WorkHost, type WorkSession } from "../../lib/api";
import {
  agentLabel,
  UNKNOWN_AGENT_NAME,
  type AgentNameLookup,
} from "../agents/turnCopy";
import type { AgentWorkingSignal } from "../agents/workingSignal";
import { workSessionStatus } from "./workSessionModel";

// =============================================================================
// ADE 관제 모델 (ADR-0154 D1+D2, #1135) — **집계와 문구만**. 화면은 없다.
//
// 성재의 D2 수정이 이 파일의 형태를 정했다: "대화 공간에는 '실행 중인 작업 1개…'
// 같은 summary로 보이고 클릭하면 drawer 형태." 그래서 3층이다.
//
//   대화 공간  summary 한 줄        <- `adeSummarySegments` (이 파일)
//   drawer     세션 카드 관제       <- `adeItems` / `adeCounts` (이 파일)
//   터미널     상세                  <- 기존 표면(작업 패널 · 작업 세션 패널)
//
// 이 파일은 **아무것도 새로 관측하지 않는다.** 재료는 이미 둘 다 있다:
//
//   `AgentWorkingSignal`  `agent:` 레일이 증명한 열린 턴 (features/agents/
//                         workingSignal.ts). 채널×에이전트 하나로 이미 병합돼 있다.
//   `WorkSession`         ADR-0114 세션 원장의 REST 투영 (lib/api.ts).
//                         워크스페이스 전역이고 이미 멤버십으로 걸러져 온다.
//
// 세 번째 재료를 만들지 않은 것이 이 설계의 값이다. 「지금 몇 개가 돌고 있나」에
// 답이 두 벌이면, 그 둘은 반드시 언젠가 다른 수를 말한다.
//
// ## 두 재료를 왜 한 목록으로 세는가 — 그리고 왜 겹치지 않는가
//
// 둘은 다른 레일의 다른 객체다. `AgentWorkingSignal`은 **에이전트의 턴**(hermes가
// 채널에서 한 번 답하는 동안)이고, `WorkSession`은 **호스트 위의 ACP 작업
// 세션**(codex가 워크트리에서 도는 프로세스)이다. 사람이 "지금 뭐가 돌고 있지"를
// 물을 때 알고 싶은 것은 그 합집합이고, 둘 중 하나만 세는 줄은 나머지 절반에
// 대해 침묵한다.
//
// 겹침이 없는 이유도 형상에서 온다: 턴은 `runId`로, 세션은 `sessionId`로
// 식별되고 서로의 id 공간에 들어가지 않는다. 같은 작업이 두 줄로 세어지는 경우는
// 서버가 한 run을 두 레일에 같은 신원으로 싣기 시작할 때뿐이며, 그때는 이 파일이
// 아니라 그 서버 결정이 바뀐 것이다.
//
// ## 생존성 등급은 **파생**이다 (D1)
//
// `work_host.type`이 정본이고 이 파일은 그것을 읽기만 한다. 서버가 이미 같은
// 사상을 갖고 있다(`host_tier`: app->local, workd->remote, cloud->cloud —
// lib/executionPlan.ts의 `HostTier` 주석). 여기서 다시 정하지 않는 이유는 승인
// 카드의 픽커와 이 줄이 같은 호스트를 다르게 부르면 사람이 고른 것과 화면이
// 말하는 것이 갈리기 때문이다.
//
// **모르면 지속이라고 말하지 않는다.** 「이 작업은 기기를 꺼도 계속됩니다」는
// 사람이 랩탑을 덮는 근거가 되는 문장이라, 틀리면 작업이 사라진다. 호스트를 못
// 찾았거나 등록기가 모르는 타입이면 `unknown`이고, 화면은 아는 것만 말한다.
// =============================================================================

/**
 * D1의 상태 3분류. **`blocked`가 이 어휘의 존재 이유다**: 나머지 둘은 "구경"이고
 * 이것만 "행동"이라, 요약 줄과 카드 정렬 양쪽에서 강조축을 진다.
 *
 * `idle`은 「끝났고 호스트가 터미널을 열어 두고 있다」이지 「누가 기다린다」가
 * 아니다. 원장의 `idle` 라벨이 "완료 · 대기 중"이라 우리말이 겹치는데, 겹치는
 * 것은 라벨이지 사실이 아니다 — 그래서 이 층의 문구는 「유휴」로 갈라 둔다
 * (`ADE_STATE_LABEL`).
 */
export type AdeState = "working" | "blocked" | "idle";

/**
 * D1의 생존성 등급. `persistent`만이 「기기를 꺼도 계속됩니다」를 말할 자격이 있다.
 */
export type AdeDurability = "persistent" | "device_bound" | "unknown";

/** 카드가 확대되면 무엇이 열리는가 — 그 답이 곧 종류다. */
export type AdeItemKind = "run" | "session";

/**
 * drawer 카드 한 장이 아는 전부. 화면 문자열은 `title` 하나뿐이고(이름은 명부의
 * 것이라 여기서 지어낼 수 없다) 나머지는 라벨 함수가 만든다.
 */
export interface AdeItem {
  /** React 키이자 정렬 tiebreak. 종류가 접두사라 두 레일의 id가 섞이지 않는다. */
  key: string;
  kind: AdeItemKind;
  state: AdeState;
  durability: AdeDurability;
  /** 카드가 자기 방을 말한다. 요약이 워크스페이스 전역이라 필수다. */
  channelId: string;
  /** 에이전트 이름(턴) 또는 세션 라벨(세션). */
  title: string;
  /**
   * 3분류보다 정밀한 원래 사실 — 「호스트 연결 끊김」·「승인 대기」.
   *
   * 카드가 칩(3분류)과 이 줄을 함께 세우는 이유: 칩은 요약 줄이 센 것과 같은
   * 어휘여야 하고(그래야 "대기 1"과 카드가 같은 말을 한다), 원장이 아는 더
   * 정확한 사실은 그 대가로 사라지면 안 된다.
   */
  detail: string;
  /** 턴/세션이 시작된 서버 시각. 관측 못 한 턴은 없다(시계를 지어내지 않는다). */
  startedAtMs?: number;
  /** 끝난 세션의 시계는 여기서 멈춘다. */
  endedAtMs?: number;
  /** `kind: "session"` — `?work=`로 작업 세션 패널을 연다. */
  sessionId?: string;
  /** `kind: "run"` — 작업 패널(AgentWorkPanel)을 연다. */
  runId?: string;
  /** `kind: "run"` — 작업 패널이 로그를 찾는 열쇠. */
  memberId?: string;
  /**
   * 이 작업이 만든 변경. **오늘은 아무 빌더도 채우지 않는다** — 서버 투영에
   * diff가 없기 때문이고(work session ACP 투영의 허용 키 목록에 없다), 없는 것을
   * 0으로 그리면 「아직 모른다」가 「바꾼 게 없다」로 둔갑한다.
   *
   * 그런데도 형상이 여기 있는 이유는 ADR-0154가 리뷰 병목 방어를 D2의 1급 동선
   * 으로 못 박았기 때문이다. 카드는 이 칸의 **자리**를 지금 예약하고(높이가 나중에
   * 바뀌지 않게), `adeDiffLabel`이 값이 왔을 때 무엇을 적을지 이미 정해 둔다.
   */
  diff?: { added: number; removed: number };
}

/** 3분류의 계수. `total`은 살아 있는 것(working+blocked)이다 — 아래 주석 참조. */
export interface AdeCounts {
  working: number;
  blocked: number;
  idle: number;
  /**
   * 요약 줄이 존재할 자격. `working + blocked`이고 `idle`은 빠진다.
   *
   * 유휴 세션은 「호스트가 터미널을 열어 두고 있다」는 사실이지 진행 중인 작업이
   * 아니다. 그것까지 세면 아무 일도 안 일어나는 워크스페이스에서 줄이 영구히
   * 켜져 있게 되고, 그 줄은 라이브 액티비티가 아니라 장식이다. 유휴 세션은
   * drawer가 열렸을 때 목록에 함께 서고(그때는 전체 그림이 필요하다), 원래
   * 자리인 작업 세션 패널에도 그대로 있다.
   */
  total: number;
}

// ---- 생존성 등급 ------------------------------------------------------------

/**
 * `work_host.type` -> 생존성 등급. 모르는 타입은 `unknown`이다(추측 금지).
 *
 * `app`만 기기 종속이다: ADR-0125 D1이 `app`을 로컬 클라이언트 호스트로
 * 정의했고(사람의 맥에서 도는 것), `workd`/`cloud`는 사람의 세션과 무관하게 살아
 * 있는 기계다. `workSessionModel.workHostTrust`가 같은 칼럼으로 릴레이 신뢰를
 * 가르는데 그쪽은 `app`/그 외의 2분류라 여기서 그대로 쓸 수 없다 — 그쪽이 묻는
 * 것은 「이 침묵을 해석해도 되나」이고 이쪽은 「랩탑을 덮어도 되나」다.
 */
export function hostDurability(hostType: string | undefined): AdeDurability {
  if (hostType === "app") return "device_bound";
  if (hostType === "workd" || hostType === "cloud") return "persistent";
  return "unknown";
}

/**
 * 이 세션이 기기를 꺼도 살아남는가. 호스트를 못 찾으면 `unknown`이다 —
 * 명부가 아직 안 왔다는 사실과 「지속된다」는 주장은 다른 것이다.
 */
export function sessionDurability(
  session: Pick<WorkSession, "hostId">,
  hosts: readonly WorkHost[] | undefined
): AdeDurability {
  if (!hosts) return "unknown";
  const host = hosts.find((candidate) => uuidEq(candidate.id, session.hostId));
  if (!host) return "unknown";
  return hostDurability(host.type);
}

/**
 * 카드에 붙는 생존성 배지. **`null`은 배지가 없다는 뜻이 아니라 「모른다」의 배지가
 * 따로 있다는 뜻이 아니다** — 세 등급 모두 말할 것이 있으므로 셋 다 문자열이다.
 *
 * 지속 쪽 문장이 ADR의 원문 그대로인 이유: 이 문장은 사람이 랩탑을 덮는 근거고,
 * 결정문과 화면이 한 글자라도 다르면 다음 사람은 어느 쪽이 계약인지 모른다.
 */
export function durabilityBadge(durability: AdeDurability): string {
  if (durability === "persistent") return "기기를 꺼도 계속됩니다";
  if (durability === "device_bound") return "이 기기에서만";
  return "실행 위치 확인 필요";
}

/**
 * 이 카드가 생존성을 **말할 자격이 있는가**. 없으면 `null` 이고 화면은 배지를
 * 그리지 않는다.
 *
 * 턴(`kind: "run"`)에는 호스트가 없다 — 사람의 기계에서 도는 것이 아니라 채널의
 * 에이전트가 답하는 중이다. 그 카드에 「실행 위치 확인 필요」를 세우면 **모든**
 * 턴이 경고를 하나씩 달고 서고, 경고가 기본값이 되는 순간 그것은 경고가 아니다.
 * 「해당 없음」과 「모른다」는 다른 사실이며, 화면에서 둘을 구별하는 방법은 앞의
 * 것을 말하지 않는 것이다.
 *
 * 세션의 `unknown` 은 그대로 말한다. 그쪽은 진짜로 모르는 것이고(호스트를 못
 * 찾았다), 사람이 랩탑을 덮을지 정하는 자리에서 침묵하면 안 된다.
 */
export function itemDurabilityBadge(
  item: Pick<AdeItem, "kind" | "durability">
): string | null {
  if (item.kind === "run") return null;
  return durabilityBadge(item.durability);
}

/**
 * 배지가 안심시키는 말인가, 조심하라는 말인가. 화면이 색을 고르는 축이고,
 * 문자열 비교로 색을 고르는 것을 막기 위해 여기 있다.
 */
export function durabilityTone(
  durability: AdeDurability
): "ok" | "muted" | "warn" {
  if (durability === "persistent") return "ok";
  if (durability === "device_bound") return "muted";
  return "warn";
}

// ---- 상태 3분류 -------------------------------------------------------------

/** 3분류의 우리말. 원장의 세밀한 라벨과 **일부러** 다른 낱말이다(위 주석). */
export const ADE_STATE_LABEL: Readonly<Record<AdeState, string>> = {
  working: "실행 중",
  blocked: "대기",
  idle: "유휴",
};

/**
 * 세션 원장의 상태 -> 3분류. `ended`는 어느 분류도 아니라서 `null`이고, 호출자가
 * 목록에서 뺀다.
 *
 * ## 하트비트를 보지 않는 이유 (실측)
 *
 * `workSessionContinuityStatus`는 running/idle + `online === false`를 「호스트
 * 응답 없음」으로 그린다. 그것을 `blocked`로 접고 싶은 유혹이 있지만 하지 않는다:
 * `workHostOnline`의 주석에 실측이 남아 있다 — momowebqa 2026-07-26 기준 등록된
 * 호스트 8개 전부가 `online: false`를 답했고, 그중 하나는 그 순간 15개의
 * `agent.partial`을 릴레이하고 있었다. 그 값으로 3분류를 가르면 **모든 것이
 * 대기**가 되고, 「대기」는 멘션급 우선순위를 지는 낱말이라(D1) 그 순간 이 줄은
 * 늑대 소년이 된다.
 *
 * 원장이 정본이라는 규칙은 그 파일이 이미 적어 둔 것이다: "heartbeat loss changes
 * only the PRESENTATION of running, never the session's stored state." 이 함수는
 * 저장된 상태만 읽는다.
 */
export function sessionAdeState(status: string): AdeState | null {
  if (status === "running") return "working";
  // 호스트가 사라졌고 사람이 이어받아야 한다 — D1의 "랩탑이 닫혀 중단됨,
  // 이어받기 가능"이 정확히 이 상태다.
  if (status === "orphaned") return "blocked";
  if (status === "idle") return "idle";
  // `ended`와 이 빌드가 모르는 상태. 모르는 상태를 활성으로 세지 않는다.
  return null;
}

/**
 * 열린 턴 -> 3분류. `awaiting_approval`은 사람의 결정을 기다리는 상태이므로
 * `blocked`다 — `turnCopy.primary`가 사이드바 알약에서 이미 같은 우선순위를
 * 적용한다("An agent that is running needs nothing from you").
 */
export function turnAdeState(signal: AgentWorkingSignal): AdeState {
  return signal.state === "awaiting_approval" ? "blocked" : "working";
}

// ---- 카드 목록 --------------------------------------------------------------

/**
 * 정렬: 대기 -> 실행 중 -> 유휴, 같은 분류 안에서는 오래된 것 먼저.
 *
 * 대기가 맨 위인 이유는 D1이고(멘션급), 오래된 것이 먼저인 이유는
 * `workingSignal.byOldestTurn`과 같다: 가장 오래 붙들려 있는 것이 가장 먼저
 * 답을 받아야 한다. 시계를 못 본 항목은 자기 분류의 끝으로 간다.
 */
const STATE_RANK: Readonly<Record<AdeState, number>> = {
  blocked: 0,
  working: 1,
  idle: 2,
};

export function byAdePriority(a: AdeItem, b: AdeItem): number {
  const rank = STATE_RANK[a.state] - STATE_RANK[b.state];
  if (rank !== 0) return rank;
  const left = a.startedAtMs ?? Number.POSITIVE_INFINITY;
  const right = b.startedAtMs ?? Number.POSITIVE_INFINITY;
  if (left !== right) return left - right;
  return a.key.localeCompare(b.key);
}

/** 세션 원장 -> 카드. `ended`와 모르는 상태는 여기서 빠진다. */
export function adeItemsFromSessions(
  sessions: readonly WorkSession[],
  hosts: readonly WorkHost[] | undefined
): AdeItem[] {
  const out: AdeItem[] = [];
  for (const session of sessions) {
    const state = sessionAdeState(session.status);
    if (state === null) continue;
    const item: AdeItem = {
      key: `session|${session.id.toLowerCase()}`,
      kind: "session",
      state,
      durability: sessionDurability(session, hosts),
      channelId: session.channelId,
      // 라벨이 비어 온 세션은 도구 이름으로 선다. uuid를 이름 자리에 그리지
      // 않는다(spawnHostChoice의 같은 규칙: 「이름을 모른다」를 「이름이
      // uuid다」로 바꿔 말하지 않는다).
      title: session.label.trim() === "" ? session.tool : session.label,
      detail: workSessionStatus(session).label,
      startedAtMs: session.startedAtMs,
    };
    if (session.endedAtMs !== undefined) item.endedAtMs = session.endedAtMs;
    item.sessionId = session.id;
    out.push(item);
  }
  return out;
}

/**
 * 열린 턴 -> 카드. 이름은 명부에서 오고(`nameFor`), 명부가 아직이면 `에이전트`다.
 *
 * `headlines[0]`을 `detail`에 싣는 것은 이 층에서만 하는 일이 아니다 —
 * `turnCopy.activitySuffix`가 컴포저 활동 줄에서 같은 값을 같은 조건으로 쓴다
 * (working일 때만, 승인 대기는 헤드라인이 없다).
 */
export function adeItemsFromTurns(
  turns: readonly AgentWorkingSignal[],
  nameFor: AgentNameLookup
): AdeItem[] {
  const out: AdeItem[] = [];
  for (const turn of turns) {
    const parts = nameFor(turn.memberId);
    const state = turnAdeState(turn);
    const headline = state === "working" ? turn.headlines[0] : undefined;
    const item: AdeItem = {
      key: `run|${(turn.runId ?? turn.memberId).toLowerCase()}|${turn.channelId.toLowerCase()}`,
      kind: "run",
      state,
      // 턴은 호스트를 갖지 않는다. 「이 기기에서만」이라고 말할 근거도
      // 「기기를 꺼도 계속됩니다」라고 말할 근거도 없으므로 모른다고 말한다.
      durability: "unknown",
      channelId: turn.channelId,
      title: parts.name.trim() === "" ? UNKNOWN_AGENT_NAME : agentLabel(parts),
      detail: headline ?? (state === "blocked" ? "승인 대기" : "작업 중"),
    };
    if (turn.startedAtMs !== undefined) item.startedAtMs = turn.startedAtMs;
    if (turn.runId !== undefined) item.runId = turn.runId;
    item.memberId = turn.memberId;
    out.push(item);
  }
  return out;
}

/** 두 재료를 한 목록으로. 정렬은 `byAdePriority`. */
export function adeItems(
  sessions: readonly WorkSession[],
  hosts: readonly WorkHost[] | undefined,
  turns: readonly AgentWorkingSignal[],
  nameFor: AgentNameLookup
): AdeItem[] {
  return [
    ...adeItemsFromSessions(sessions, hosts),
    ...adeItemsFromTurns(turns, nameFor),
  ].sort(byAdePriority);
}

export function adeCounts(items: readonly AdeItem[]): AdeCounts {
  let working = 0;
  let blocked = 0;
  let idle = 0;
  for (const item of items) {
    if (item.state === "working") working += 1;
    else if (item.state === "blocked") blocked += 1;
    else idle += 1;
  }
  return { working, blocked, idle, total: working + blocked };
}

// ---- 요약 한 줄 -------------------------------------------------------------

/**
 * 조각의 종류. `typingSegments`와 같은 이유로 조각이 정본이다: 화면이 문장을
 * 다시 조립하면 보이는 글자와 보조기술이 읽는 글자가 갈릴 수 있고, 두 벌을
 * 유지하는 대신 한 벌을 나눠 쓴다.
 *
 *   plain        muted 산문
 *   count        일반 숫자 (`data-numeric`)
 *   blocked      강조 산문 — 대기는 사람을 부르는 축이다 (D1)
 *   blockedCount 강조 숫자 (`data-numeric`)
 */
export type AdeSummarySegmentKind =
  | "plain"
  | "count"
  | "blocked"
  | "blockedCount";

export interface AdeSummarySegment {
  kind: AdeSummarySegmentKind;
  text: string;
}

/**
 * 요약 줄의 조각들. **살아 있는 작업이 하나도 없으면 빈 배열이고, 화면은 줄 자체를
 * 그리지 않는다.**
 *
 * ## 빈 상태에 자리를 예약하지 않는 이유 (설계 판단, #1135)
 *
 * 같은 레포의 「작성 중」 줄은 자리를 예약한다(`TypingLine`, 리뷰 H-2). 그
 * 판정을 그대로 베끼지 않은 근거가 셋이다.
 *
 *  1. **미는 대상이 다르다.** 작성 중 줄은 컴포저 **바로 아래**에 있어서, 나타날
 *     때 캐럿과 전송 버튼이 26px 움직인다. 이 줄은 라우트 **맨 위**에 있고,
 *     컴포저는 열의 바닥에 고정돼 있어 이 줄이 생겨도 제자리다. 움직이는 것은
 *     타임라인의 가용 높이이고, 그 목록은 바닥 정렬이라 읽던 줄이 그대로 남는다.
 *  2. **빈도와 원인이 다르다.** 작성 중은 남의 키 입력이 3초마다 켰다 껐다 하는
 *     신호다. 이 줄은 사람이 에이전트를 부르거나 세션이 끝날 때 한 번 바뀐다 —
 *     대개 **자기 행동의 결과**라 예측 가능하다.
 *  3. **예약된 빈 띠는 그 자체로 한 줄이다.** ADR-0154가 요구하는 정직함은
 *     「작업이 없으면 없다고 말하라」가 아니라 「없을 때 아무 말도 하지 말라」다.
 *     라우트 맨 위에 영구히 28px의 침묵하는 띠를 두는 것은 후자를 어긴다.
 *
 * 대신 **drawer는 자리를 밀지 않는다** — 그쪽은 절대 위치로 라우트를 덮고, 게이트가
 * 열기 전후의 좌표를 픽셀로 잰다. 흔들림 방어는 거기에 있다.
 *
 * ## 문구
 *
 *   실행만        `실행 중인 작업 2개`
 *   실행 + 대기   `실행 중인 작업 2개 · 대기 1`   (ADR-0154 D2 원문)
 *   대기만        `대기 중인 작업 1개`
 *
 * 대기만 있을 때 「실행 중인 작업 0개」로 시작하지 않는다: 0을 세는 문장은 읽는
 * 사람에게 아무 일도 시키지 않으면서 진짜 할 일을 문장 끝으로 밀어낸다.
 */
export function adeSummarySegments(
  counts: AdeCounts
): AdeSummarySegment[] {
  const { working, blocked } = counts;
  if (working === 0 && blocked === 0) return [];
  if (working === 0) {
    return [
      { kind: "blocked", text: "대기 중인 작업 " },
      { kind: "blockedCount", text: `${blocked}` },
      { kind: "blocked", text: "개" },
    ];
  }
  const segments: AdeSummarySegment[] = [
    { kind: "plain", text: "실행 중인 작업 " },
    { kind: "count", text: `${working}` },
    { kind: "plain", text: "개" },
  ];
  if (blocked > 0) {
    // 가운뎃점은 이 레포가 이미 쓰는 구분자다(작업 세션 행의 메타 줄). em-dash는
    // 디자인 프리플라이트가 하드 제로로 막는다.
    segments.push({ kind: "plain", text: " · " });
    segments.push({ kind: "blocked", text: "대기 " });
    segments.push({ kind: "blockedCount", text: `${blocked}` });
  }
  return segments;
}

/** 조각의 합. 없으면 `null`이고, 그것이 「줄이 없다」의 정본 판정이다. */
export function adeSummarySentence(counts: AdeCounts): string | null {
  const segments = adeSummarySegments(counts);
  if (segments.length === 0) return null;
  return segments.map((segment) => segment.text).join("");
}

/**
 * 요약 줄을 여는 컨트롤의 접근 이름.
 *
 * 보이는 문장에 「작업 목록 열기」를 덧붙인다. 보이는 글자만으로는 이것이 누를 수
 * 있는 것인지 알 수 없고, 아이콘 하나로 말하기에는 이 컨트롤이 여는 것이 화면의
 * 절반이다.
 */
export function adeSummaryLabel(counts: AdeCounts): string | null {
  const sentence = adeSummarySentence(counts);
  return sentence === null ? null : `${sentence}. 작업 목록 열기`;
}

// ---- 카드 문구 --------------------------------------------------------------

/**
 * 리뷰 병목 방어의 첫 칸(D2). 값이 없으면 `null`이고, 카드는 **자리만** 남긴다 —
 * `+0 -0`은 「모른다」가 아니라 「안 바꿨다」라서 쓰지 않는다.
 */
export function adeDiffLabel(
  diff: AdeItem["diff"] | undefined
): string | null {
  if (diff === undefined) return null;
  return `+${diff.added} -${diff.removed}`;
}

/**
 * drawer가 비어 있을 때의 한 문장.
 *
 * 요약 줄이 있어야 drawer가 열리므로 `total > 0`인 동안 이 문장은 보이지 않는다.
 * 볼 수 있는 경로는 하나다: 열어 둔 채로 마지막 작업이 끝나는 것. 그때 서랍을
 * 닫아 버리면 사람이 보던 것이 손 밑에서 사라지므로, 서랍은 남고 이 문장이 선다.
 */
export const ADE_DRAWER_EMPTY_HEADLINE = "진행 중인 작업이 없습니다.";
export const ADE_DRAWER_EMPTY_DETAIL =
  "에이전트를 부르거나 작업 세션을 시작하면 여기에 한 장씩 쌓입니다.";
