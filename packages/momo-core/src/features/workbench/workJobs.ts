import type {
  AgentNextAction,
  AgentReportedResult,
  AgentResultKind,
  AgentToolCountKey,
  SharedWorkSession,
  WorkJobsMode,
} from "../../lib/api";
import { elapsedSpan } from "../agents/runPhase";
import {
  sessionElapsedReadout,
  type SessionElapsedReadout,
} from "../work/workSessionFormat";
import {
  channelLabel,
  harnessLabel,
  isAwaitingApproval,
  isFinishedState,
  isRunItem,
  ownedBy,
  prFacts,
  sessionTitle,
  stateChipLabel,
} from "./teamBoard";

// =============================================================================
// 「작업」 한 화면의 줄 모델 (ADR-0202 D1~D3, U1 #3842).
//
// 화면의 줄 하나는 「맡긴 일 하나」다. 줄이 먼저 말하는 것은 **결과**다: 누가 어느 에이전트에게
// 맡겼나, 지금 어떤가, 얼마나 걸렸나, 무엇이 나왔나(PR·에이전트 보고). 진행 스트림(단계·oort
// 호출)은 줄을 열었을 때 서랍에서만 본다(D1). 남의 일은 결과 요약과 상태까지다(D5).
//
// 이 모듈은 거르지 않는다. 가시성(내가 멤버인 채널)과 「내 것」은 새 서버가 SQL에서 끝낸다
// (`who=mine`). 옛 서버(`mode: "legacy"`)에만 화면이 「내 것」을 고른다: 그때 서버는 팀 보드
// 한 벌만 주기 때문이다. 그 고르기는 가시성이 아니라 보기다(`ownedBy`, 기존 폰 판과 같은 뜻).
// =============================================================================

export type WorkFilter = "mine" | "team";

export const WORK_JOBS_COPY = {
  title: "작업",
  filterMine: "내 것",
  filterTeam: "팀 전체",
  filterGroup: "누구의 작업",
  /** 「지금 진행 3」. 숫자는 지금 보이는 줄에서만 센다(숨은 줄 수를 말하지 않는다, ADR-0194 D5). */
  inProgress: "지금 진행",
  sectionNow: "지금",
  sectionDone: "끝난 일",
  reportedTag: "에이전트 보고",
  approvalAction: "승인 카드 보기",
  approvalHint: "승인은 그 카드에서 해요",
  legacyNotice: "이 서버는 아직 호스팅 에이전트의 작업만 보여 줘요.",
  emptyMineTitle: "내가 맡긴 작업이 아직 없어요",
  emptyMineBody: "에이전트에게 일을 맡기면 결과가 여기에 모여요.",
  emptyTeamTitle: "팀이 맡긴 작업이 아직 없어요",
  emptyTeamBody: "내가 속한 채널에서 에이전트에게 맡긴 일이 여기에 모여요.",
  emptyAction: "채널로 가기",
  errorTitle: "작업을 불러오지 못했어요",
  errorBody: "연결을 확인하고 다시 불러와 보세요.",
  errorAction: "다시 불러오기",
  offlineEmpty: "오프라인이에요. 연결되면 작업을 불러와요.",
  staleError: "작업을 새로 불러오지 못했어요. 마지막 목록을 보여 드려요.",
  loadMore: "더 보기",
  loadingMore: "더 불러와요",
  listLabel: "맡긴 작업 목록",
  thisDevice: "이 기기",
  openTerminals: "터미널 열기",
  colTask: "맡긴 일",
  colState: "상태",
  colResult: "결과",
  colDuration: "걸린 시간",
  colChannel: "채널",
  noResultYet: "아직 결과 없음",
  /** 끝났는데 에이전트가 결과를 알리지 않았다(실패·멈춤 포함). 빈칸으로 두지 않는다. */
  noResultReported: "알린 결과 없음",
} as const;

/** 기기별로 기억하는 마지막 필터(ADR-0202 D2). 기본은 언제나 「내 것」이다. */
export const WORK_FILTER_STORAGE_KEY = "oort.work.filter";

export function parseWorkFilter(value: string | null | undefined): WorkFilter | null {
  return value === "mine" || value === "team" ? value : null;
}

/**
 * 주소가 정한 필터. `who=`가 먼저고, 옛 링크 `view=team`(ADR-0194 D2의 보드 링크)은 「팀
 * 전체」, `view=mine`은 「내 것」이다. 주소가 말하지 않으면 null(기기 기억 → 기본 「내 것」).
 */
export function workFilterFromSearch(search: string): WorkFilter | null {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const who = parseWorkFilter(params.get("who"));
  if (who !== null) return who;
  const view = params.get("view");
  if (view === "team") return "team";
  if (view === "mine") return "mine";
  return null;
}

/** 주소 → 기기 기억 → 「내 것」. */
export function initialWorkFilter(search: string, remembered: string | null): WorkFilter {
  return workFilterFromSearch(search) ?? parseWorkFilter(remembered) ?? "mine";
}

export interface WorkJobPerson {
  memberId: string | null;
  displayName: string;
}

export interface WorkJobRow {
  id: string;
  item: SharedWorkSession;
  title: string;
  /** 맡긴 사람. 기록이 없으면 null(옛 run). */
  requester: WorkJobPerson | null;
  /** 맡은 쪽: run은 에이전트 멤버, 세션은 하네스 이름. */
  agentName: string;
  /** 에이전트가 1급 멤버인가(run 줄). 세션 줄은 도구 이름이라 거짓이다. */
  agentIsMember: boolean;
  finished: boolean;
  /** 서버가 phase를 실은 run이 승인을 기다리는가(새 서버만, ADR-0202 D1). */
  awaitingApproval: boolean;
  statusLabel: string;
  /** 공용 경과 판정(`sessionElapsedReadout`): 끝난 시각이 있으면 성과, 없으면 시계. */
  duration: SessionElapsedReadout | null;
  /**
   * 걸린 시간 칸의 말. 끝났으면 「25분 동안 작업」(공용 `sessionElapsedReadout`), 도는 중이면
   * 「12분째」(공용 `elapsedSpan`, 1분 미만은 「방금 시작」). 시계 눈금(「4m 00s」)은 쓰지 않는다:
   * 목록은 실시간 진행판이 아니다(ADR-0202 D1).
   */
  durationText: string | null;
  pr: { number: string; repo: string; href: string } | null;
  reported: AgentReportedResult | null;
  channel: string;
  channelId: string;
}

export function workJobRow(item: SharedWorkSession, nowMs: number): WorkJobRow {
  const run = isRunItem(item);
  const requester: WorkJobPerson | null = run
    ? item.requestedBy != null
      ? { memberId: item.requestedBy.memberId, displayName: item.requestedBy.displayName }
      : null
    : { memberId: item.owner.memberId, displayName: item.owner.displayName };
  const finished = isFinishedState(item.state);
  const awaitingApproval = isAwaitingApproval(item);
  const duration = sessionElapsedReadout(
    { startedAtMs: item.startedAtMs > 0 ? item.startedAtMs : null, endedAtMs: item.endedAtMs },
    nowMs
  );
  return {
    id: item.sessionId,
    item,
    title: sessionTitle(item),
    requester,
    agentName: run ? item.owner.displayName : harnessLabel(item),
    agentIsMember: run,
    finished,
    awaitingApproval,
    statusLabel: stateChipLabel(item),
    duration,
    durationText: durationTextOf(duration, item.startedAtMs, nowMs),
    pr: prFacts(item.prUrl),
    reported: item.agentReported ?? null,
    channel: channelLabel(item),
    channelId: item.homeChannel.id,
  };
}

function durationTextOf(
  duration: SessionElapsedReadout | null,
  startedAtMs: number,
  nowMs: number
): string | null {
  if (duration === null) return null;
  if (duration.kind === "worked") return duration.label;
  const span = elapsedSpan(startedAtMs, nowMs);
  return span === undefined ? "방금 시작" : `${span}째`;
}

/** 「구민수 → 그록봇」. 맡긴 사람 기록이 없으면 에이전트만. */
export function requesterToAgent(row: WorkJobRow): string {
  return row.requester === null
    ? row.agentName
    : `${row.requester.displayName} → ${row.agentName}`;
}

/**
 * 이 필터에 서는 줄. 새 서버(`jobs`)는 이미 `who`로 골라 보냈으니 그대로 둔다(클라이언트가
 * 다시 거르면 서버의 판정을 가리거나 보일 줄을 숨긴다). 옛 서버는 팀 보드 한 벌이라 「내 것」만
 * 여기서 고른다.
 */
export function itemsForFilter(
  items: readonly SharedWorkSession[],
  filter: WorkFilter,
  memberId: string,
  mode: WorkJobsMode
): SharedWorkSession[] {
  if (mode === "jobs" || filter === "team") return [...items];
  return ownedBy(items, memberId);
}

/** 「지금 진행 n」: 보이는 줄 가운데 끝나지 않은 것. */
export function inProgressCount(rows: readonly WorkJobRow[]): number {
  return rows.filter((row) => !row.finished).length;
}

export interface WorkJobSection {
  key: "now" | "done";
  label: string;
  rows: WorkJobRow[];
}

/**
 * 두 구간: 끝나지 않은 일(승인 대기를 맨 위로) → 끝난 일. 구간 안은 서버 순서(마지막 활동
 * 최신순)를 지킨다. 빈 구간은 만들지 않는다.
 */
export function workJobSections(rows: readonly WorkJobRow[]): WorkJobSection[] {
  const open = rows.filter((row) => !row.finished);
  const now = [
    ...open.filter((row) => row.awaitingApproval),
    ...open.filter((row) => !row.awaitingApproval),
  ];
  const done = rows.filter((row) => row.finished);
  const sections: WorkJobSection[] = [];
  if (now.length > 0) sections.push({ key: "now", label: WORK_JOBS_COPY.sectionNow, rows: now });
  if (done.length > 0) sections.push({ key: "done", label: WORK_JOBS_COPY.sectionDone, rows: done });
  return sections;
}

const RESULT_KIND_TEXT: Readonly<Record<AgentResultKind, string>> = {
  pr_opened: "PR을 열었어요",
  branch_only: "브랜치에만 올렸어요",
  vm_only: "작업 환경 안에만 있어요",
  no_change: "바꾼 것이 없어요",
};

const NEXT_ACTION_TEXT: Readonly<Record<AgentNextAction, string | null>> = {
  merge_ok: "머지해도 된대요",
  please_test: "직접 확인해 달래요",
  blocked: "막혔대요",
  none: null,
};

const TOOL_COUNT_TEXT: Readonly<Record<AgentToolCountKey, string>> = {
  run: "명령",
  edit: "수정",
  read: "읽기",
  search: "검색",
  web: "웹",
  other: "그 밖",
};

const TOOL_COUNT_ORDER: readonly AgentToolCountKey[] = ["run", "edit", "read", "search", "web", "other"];

export function resultKindText(kind: AgentResultKind): string {
  return RESULT_KIND_TEXT[kind];
}

export function nextActionText(action: AgentNextAction): string | null {
  return NEXT_ACTION_TEXT[action];
}

/** 「테스트 통과 12 · 실패 1 · 안 돌림 3」. 0인 실패·안 돌림은 말하지 않는다. */
export function testsText(tests: NonNullable<AgentReportedResult["tests"]>): string {
  const parts = [`테스트 통과 ${tests.passed}`];
  if (tests.failed > 0) parts.push(`실패 ${tests.failed}`);
  if (tests.notRun > 0) parts.push(`안 돌림 ${tests.notRun}`);
  return parts.join(" · ");
}

/** 「명령 12 · 수정 4 · 읽기 30」. */
export function toolCountsText(counts: NonNullable<AgentReportedResult["toolCounts"]>): string {
  return TOOL_COUNT_ORDER.filter((key) => counts[key] !== undefined)
    .map((key) => `${TOOL_COUNT_TEXT[key]} ${counts[key]}`)
    .join(" · ");
}

/**
 * 목록 줄의 결과 한 줄(에이전트 보고만). 서버가 잰 사실(PR 주소·diff)은 이 줄에 섞지 않는다:
 * 화면이 「에이전트 보고」 꼬리표를 이 줄 앞에만 붙인다(ADR-0162 증보 5 C1 「구조가 곧 표시 규칙」).
 */
export function reportedSummary(reported: AgentReportedResult | null): string | null {
  if (reported === null) return null;
  const parts: string[] = [];
  if (reported.resultKind !== null) parts.push(RESULT_KIND_TEXT[reported.resultKind]);
  // 세 수가 모두 0이면 「테스트 통과 0」은 아무것도 말하지 않는다: 줄에서는 뺀다(서랍은 그대로 말한다).
  if (reported.tests !== null && reported.tests.passed + reported.tests.failed + reported.tests.notRun > 0) {
    parts.push(testsText(reported.tests));
  }
  if (reported.nextAction !== null) {
    const next = NEXT_ACTION_TEXT[reported.nextAction];
    if (next !== null) parts.push(next);
  }
  return parts.length === 0 ? null : parts.join(" · ");
}

/** 「지금 진행 3」. 다음 쪽이 남았으면 센 수가 합계가 아니므로 「3+」. */
export function inProgressLabel(count: number, partial: boolean): string {
  return `${WORK_JOBS_COPY.inProgress} ${count}${partial ? "+" : ""}`;
}

/** 주소 쿼리에서 필터를 바꾼다(`view`의 옛 값은 걷고 `who`만 남긴다). 서랍 `card`는 둔다. */
export function searchWithFilter(search: string, filter: WorkFilter): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const view = params.get("view");
  if (view === "team" || view === "mine") params.delete("view");
  params.set("who", filter);
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}
