import {
  uuidEq,
  type AgentNextAction,
  type AgentReportedResult,
  type AgentResultKind,
  type AgentToolCountKey,
  type SharedWorkSession,
  type WorkJobsMode,
} from "../../lib/api";
import type { MessageService } from "../../i18n/types";
import { elapsedSpan } from "../agents/runPhase";
import { SESSION_STATUS_LABEL } from "./sessionList";
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
// 이 모듈은 거르지 않는다. 가시성(내가 멤버인 채널)과 「내 작업」은 새 서버가 SQL에서 끝낸다
// (`who=mine`). 옛 서버(`mode: "legacy"`)에만 화면이 「내 작업」을 고른다: 그때 서버는 팀 보드
// 한 벌만 주기 때문이다. 그 고르기는 가시성이 아니라 보기다(`ownedBy`, 기존 폰 판과 같은 뜻).
// =============================================================================

export type WorkFilter = "mine" | "team";

export const WORK_JOBS_COPY = {
  title: "작업",
  filterMine: "내 작업",
  filterTeam: "팀 전체",
  filterGroup: "누구의 작업",
  /** 「지금 진행 3」. 숫자는 지금 보이는 줄에서만 센다(숨은 줄 수를 말하지 않는다, ADR-0194 D5). */
  inProgress: "지금 진행",
  /**
   * 맨 위 구간(#5593): 내가 답해야 다음으로 가는 일 — 지금은 내 맥 세션의 권한 요청. 낱말표의 「나를 기다려요」 자리 말이다
   * (2026-11-09 낱말표). 숫자는 다른 구간처럼 화면이 붙인다(「응답 필요 1」).
   * 글자를 따로 적지 않고 세션 상태의 정본 낱말(`SESSION_STATUS_LABEL.waiting`)을 읽는다(owner 2026-11-10 「응답 필요」) —
   * 구간 머리글 → 줄 칩 → 세션 머리·배지가 한 정의에서 나온다.
   */
  sectionNeedsMe: SESSION_STATUS_LABEL.waiting,
  sectionNow: "지금",
  sectionDone: "끝난 일",
  reportedTag: "에이전트 보고",
  approvalAction: "승인 카드 보기",
  approvalHint: "승인은 그 카드에서 해요",
  /** 내 맥 세션이 권한을 묻고 기다린다(#5593). 줄을 누르면 그 세션 화면의 승인 카드다. */
  permissionHint: "권한 요청이 왔어요",
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
  /** 열 이름(owner 2026-11-11): 「작업」 · 「결과」 · 「상태」 · 「작업 시간」 · 「요청 채널」. */
  colTask: "작업",
  colState: "상태",
  colResult: "결과",
  colDuration: "작업 시간",
  colChannel: "요청 채널",
  noResultYet: "아직 결과 없음",
  /** 끝났는데 에이전트가 결과를 알리지 않았다(실패·멈춤 포함). 빈칸으로 두지 않는다. */
  noResultReported: "알린 결과 없음",
} as const;

/** 기기별로 기억하는 마지막 필터(ADR-0202 D2). 기본은 언제나 「내 작업」이다. */
export const WORK_FILTER_STORAGE_KEY = "oort.work.filter";

export function parseWorkFilter(value: string | null | undefined): WorkFilter | null {
  return value === "mine" || value === "team" ? value : null;
}

/**
 * 주소가 정한 필터. `who=`가 먼저고, 옛 링크 `view=team`(ADR-0194 D2의 보드 링크)은 「팀
 * 전체」, `view=mine`은 「내 작업」이다. 주소가 말하지 않으면 null(기기 기억 → 기본 「내 작업」).
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

/** 주소 → 기기 기억 → 「내 작업」. */
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

/** 구간 밖 승인 대기 run의 칩 낱말 「승인 대기」(ADR-0202 D1의 말)의 사전 키(#5640 수리 3회차). */
export const WORK_JOB_AWAITING_APPROVAL_KEY = "desktop.workJobs.stateAwaitingApproval" as const;

/**
 * 「작업」 줄 상태 칩의 낱말(#5640 수리 2·3회차). 「응답 필요」는 **「응답 필요」 구간에 선 줄**(내가 답할 줄)만 말한다 — 승인을 기다리는
 * run도 권한 요청을 기다리는 맥 세션과 같은 낱말 하나(`SESSION_STATUS_LABEL.waiting`)이고, 무엇을 기다리는지는 결과 칸 꼬리표가 말한다.
 * 구간 밖의 승인 대기 run(결정자가 내가 아니거나 「팀 전체」의 줄)은 **「승인 대기」**다: 내가 답할 수 없는 줄에 「응답 필요」를 붙이면
 * 틀린 말이다. 그래서 구간 머리글의 수 = 그 구간에서 「응답 필요」 칩이 선 줄의 수다. 그 밖은 공용 낱말(`stateChipLabel`) 그대로다.
 * 구간을 아는 것은 줄을 그리는 자리다(`needsMe`). 사이드바·서랍 기본값·폰은 여전히 `stateChipLabel`(「승인 필요」)을 읽는다.
 */
export function workJobStateLabel(
  row: WorkJobRow,
  needsMe: boolean,
  formatMessage: MessageService["formatMessage"]
): string {
  if (needsMe) return SESSION_STATUS_LABEL.waiting;
  if (row.awaitingApproval) return formatMessage(WORK_JOB_AWAITING_APPROVAL_KEY);
  return row.statusLabel;
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

/**
 * 주인에게 열린 권한 요청이 있는 세션 줄의 칩 상태(#5593 수리 M2) — 보드 상태 `waiting`(「응답 필요」). 세션 머리의
 * `withOpenRequest`(`work/workSessionModel`)와 같은 낱말이다. 돌고 있거나 대기 중인 줄만 바꾼다.
 */
export function awaitingMeItem(item: SharedWorkSession): SharedWorkSession {
  return item.state === "running" || item.state === "idle" ? { ...item, state: "waiting" } : item;
}

/** 「응답 필요」 구간을 정하는 사실(#5640). 화면이 모으고 판정은 `rowNeedsMe` 하나가 한다. */
export interface NeedsMeRowFacts {
  filter: WorkFilter;
  selfMemberId: string;
  /**
   * 내 결정을 기다리는 승인이 걸린 run의 id(소문자). 인박스·레일 배지가 세는 승인과 **같은 원장·같은 판정**에서 온 것이어야
   * 한다(웹 `decidableApprovals`). 보드의 `phase: awaiting_approval`로 대신하지 않는다.
   */
  approvalRunIds: ReadonlySet<string>;
}

/**
 * 이 줄이 「응답 필요」에 서는가 (#5640, ADR-0202 D1·D5, ADR-0188 D5). 웹·데스크탑 「작업 · 내 작업」의 한 판정이다.
 *
 * 줄 종류마다 올리는 사실이 하나다. 화면이 따로 읽어 추측하지 않는다(지어내지 않기):
 *   - 내 맥 세션(호스트 세션, 내가 주인): **서버가 준** 보드 상태 `waiting`. 서버(#5639)는 `include=jobs`로 읽는 사람이 그
 *     요청에 답할 수 있을 때만(세션 주인이면서 해지 안 된 호스트의 주인, 실행 중) `waiting`을 준다. `running`이면 올리지 않는다
 *     (폰처럼 세션마다 진행을 읽어 `awaitingMeItem`으로 바꾸지 않는다).
 *   - 내가 맡긴 에이전트 실행 줄: 그 run에 내 결정을 기다리는 승인이 있다(`approvalRunIds`).
 *   - 로컬 공유 터미널: 올리지 않는다. 그 `waiting`은 그 기기의 입력 대기라 보는 사람 누구에게나 같고, 여기서 답할 수 없다
 *     (데스크탑은 「이 기기」 줄이 이 기기의 칸을 센다).
 *   - 「팀 전체」, 남의 줄, 끝난 줄: 없다.
 */
export function rowNeedsMe(row: WorkJobRow, facts: NeedsMeRowFacts): boolean {
  if (facts.filter !== "mine" || row.finished) return false;
  const item = row.item;
  if (isRunItem(item)) {
    const runId = item.runId ?? item.sessionId;
    return (
      item.requestedBy != null &&
      uuidEq(item.requestedBy.memberId, facts.selfMemberId) &&
      facts.approvalRunIds.has(runId.toLowerCase())
    );
  }
  return (
    item.origin === "host" &&
    uuidEq(item.owner.memberId, facts.selfMemberId) &&
    item.state === "waiting"
  );
}

/**
 * 결과 칸이 말하는 것의 종류(#5640 수리 1회차, owner 2026-11-11). 칸 머리의 꼬리표가 이 종류를 말한다: 승인 요청 · 권한 요청 ·
 * 에이전트 보고, 그리고 꼬리표 없는 PR 번호·「결과 없음」.
 */
export type WorkJobResultKind = "approval" | "permission" | "reported" | "pr" | "none";

/**
 * 결과 칸의 종류 — 한 판정. 「응답 필요」에 선 줄은 그 구간에 올린 사실이 곧 종류다(내 맥 세션 → 권한 요청, 내가 맡긴 run → 승인 요청,
 * `rowNeedsMe`). 그 밖의 줄은 서버 phase가 승인 대기인 run이면 승인 요청(결정은 내 몫이 아니다), 아니면 에이전트 보고 → PR → 없음이다.
 * 끝난 줄은 승인을 묻지 않는다(끝난 run의 요청은 이미 닫혔다).
 */
export function workJobResultKind(row: WorkJobRow, needsMe: boolean): WorkJobResultKind {
  if (needsMe) return isRunItem(row.item) ? "approval" : "permission";
  if (!row.finished && row.awaitingApproval) return "approval";
  if (reportedSummary(row.reported) !== null) return "reported";
  if (row.pr !== null) return "pr";
  return "none";
}

/**
 * 결과 칸 아래층(줄 단추 밖의 컨트롤 — 승인·거부·열기·카드 링크, 「열어서 답하기」, PR 링크)이 서는가. 서는 것이 없으면 그 층 자체가 없어
 * 줄 높이가 늘지 않는다. 「열어서 답하기」는 허락을 보낼 수 있는 데스크탑 앱에서만 선다(브라우저는 안내 한 줄뿐이다).
 */
export function workJobResultHasControls(row: WorkJobRow, kind: WorkJobResultKind, desktop: boolean): boolean {
  if (row.pr !== null || kind === "approval") return true;
  return kind === "permission" && desktop;
}

/** 「구민수 → 그록봇」. 맡긴 사람 기록이 없으면 에이전트만. */
export function requesterToAgent(row: WorkJobRow): string {
  return row.requester === null
    ? row.agentName
    : `${row.requester.displayName} → ${row.agentName}`;
}

/**
 * 이 필터에 서는 줄. 새 서버(`jobs`)는 이미 `who`로 골라 보냈으니 그대로 둔다(클라이언트가
 * 다시 거르면 서버의 판정을 가리거나 보일 줄을 숨긴다). 옛 서버는 팀 보드 한 벌이라 「내 작업」만
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

/** 맨 위 「응답 필요」 구간의 열쇠(#5593·#5640). 화면이 구간을 가릴 때 이 상수를 읽는다. */
export const NEEDS_ME_SECTION = "needsMe" as const;

export interface WorkJobSection {
  key: typeof NEEDS_ME_SECTION | "now" | "done";
  label: string;
  rows: WorkJobRow[];
}

/**
 * 구간: 응답 필요 → 끝나지 않은 일(승인 대기를 맨 위로) → 끝난 일. 구간 안은 서버 순서(마지막 활동
 * 최신순)를 지킨다. 빈 구간은 만들지 않는다.
 *
 * 「응답 필요」(#5593)는 호출자가 답한다(`needsMyCheck`). 웹·데스크탑(#5640)은 `rowNeedsMe`로 서버가 준 사실만 읽는다(#5639의
 * `include=jobs` 상태 `waiting` + 인박스 배지와 같은 승인 원장). 폰은 아직 그 세션의 진행을 읽어 정한다(`pendingPermission`, v0.1.47에
 * 서버 사실로 옮긴다). 답하지 않으면 이 구간은 없다 — 예전 두 구간 그대로다. 끝난 줄은 묻지 않는다: 끝난 세션의 요청은 이미 취소됐다(D5).
 */
export function workJobSections(
  rows: readonly WorkJobRow[],
  needsMyCheck: (row: WorkJobRow) => boolean = () => false
): WorkJobSection[] {
  const open = rows.filter((row) => !row.finished);
  const mine = open.filter((row) => needsMyCheck(row));
  const rest = open.filter((row) => !needsMyCheck(row));
  const now = [
    ...rest.filter((row) => row.awaitingApproval),
    ...rest.filter((row) => !row.awaitingApproval),
  ];
  const done = rows.filter((row) => row.finished);
  const sections: WorkJobSection[] = [];
  if (mine.length > 0) {
    sections.push({ key: "needsMe", label: WORK_JOBS_COPY.sectionNeedsMe, rows: mine });
  }
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
