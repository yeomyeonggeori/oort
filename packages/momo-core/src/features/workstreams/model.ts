import {
  ApiError,
  WORKSTREAM_STATUSES,
  uuidEq,
  type Channel,
  type WorkHost,
  type WorkstreamRun,
  type WorkstreamStatus,
} from "../../lib/api";
import { workSessionResumeTargets } from "../work/workSessionModel";
import { TAKEOVER_NO_TARGET_COPY } from "../work/sessionHandoff";
import {
  channelLabel,
  memberFor,
  memberNameParts,
  type Directory,
} from "../workspace/directory";
import type { FilterTabsSpec } from "../common/filterTabs";

// =============================================================================
// 작업 흐름 (ADR-0143): the goal layer, as a set of pure functions.
//
// Everything a reader is told about a workstream that is not a server field is
// decided here rather than in JSX, for the reason the work session panel keeps
// its own model beside it: the list and the detail must not drift into two
// answers for one fact, and the honest-refusal branches below are the whole
// point of the surface, so they are testable rather than inline conditions.
// =============================================================================

export const WORKSTREAM_STATUS_LABEL: Readonly<Record<WorkstreamStatus, string>> = {
  active: "진행 중",
  paused: "멈춤",
  done: "완료",
  cancelled: "취소됨",
};

/**
 * One token colour per state, text first, no pulse (design-taste-web §8).
 *
 * 진행 중 is the CALM state here and takes no status token at all. It is what
 * almost every row says (nothing in the server writes a workstream out of
 * `active` yet — status transitions are ADR-0143 P2), and a column of amber
 * chips reporting that work is proceeding normally is a status board announcing
 * that nothing is happening, which is the same mistake the 잔여량 gauges fixed
 * by dropping their calm chip (tokens.md §5a).
 *
 * 멈춤 wears the accent for the reason the session ledger paints 호스트 연결
 * 끊김 with it: it is the one state waiting on a PERSON, and this surface exists
 * so that person can be someone other than whoever started it.
 *
 * 그릇은 네 칸이 전부 `--muted-soft` 다 (#1515 회전 1). 앞 판은 셋이
 * `--surface-hover`, 하나가 `--accent-soft` 였는데 **둘 다 행이 입는 상태의
 * 이름**이다: 목록 행(`WorkstreamListRoute`)이 `hover:bg-surface-hover` 로 서고
 * `--accent-soft` 는 이 레포에서 선택된 행의 채움이다. 그래서 가리키고 있는 행에서
 * 이 칩이 바탕과 한 픽셀도 다르지 않았다(실측 대비 1.000 · OKLab 거리 0.0000).
 *
 * 잉크는 그대로다 — 갈라진 것은 그릇이다. 색을 버는 것은 측정이지 이름이 아니므로
 * 톤은 잉크에만 남고, 그릇은 톤을 지지 않는다. 세션 원장 표가 같은 물음에 먼저 답한
 * 그대로다(`work/workSessionFormat.ts`).
 */
export const WORKSTREAM_STATUS_CLASS: Readonly<Record<WorkstreamStatus, string>> = {
  active: "bg-muted-soft text-ink",
  paused: "bg-muted-soft text-accent",
  done: "bg-muted-soft text-ok",
  cancelled: "bg-muted-soft text-ink-muted",
};

/**
 * The 404 both workstream reads answer for "not yours, and no more than that".
 *
 * It is a predicate and not a status comparison at the call site because the
 * distinction is load-bearing: 404 is the read refusing to confirm that a
 * workstream exists, 403 belongs to the resume path alone, and a surface that
 * folded them would talk about permission for something the server declined to
 * admit exists. Named the way `isAgentProfileMissing` is, beside the surface
 * that means it rather than in the transport.
 */
export function isWorkstreamMissing(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/** `?status=` on the route, which is also the server's own filter vocabulary. */
export function parseStatusFilter(raw: string | null): WorkstreamStatus | null {
  if (raw === null) return null;
  return (WORKSTREAM_STATUSES as readonly string[]).includes(raw)
    ? (raw as WorkstreamStatus)
    : null;
}

/**
 * The five answers to "어떤 상태?", in the shape the shared tab control takes.
 *
 * `all` is not a server status, it is the ABSENCE of `?status=`, so it lives
 * only in this vocabulary and is translated back to `null` before any request.
 * The two converters below are the whole translation layer, and they are
 * functions rather than an inline `?? "all"` at the call site because the URL
 * (status | null) and the control (five values) are two different alphabets and
 * a surface that mixed them would send `?status=all` to a server that has no
 * such row.
 */
export const WORKSTREAM_FILTERS = ["all", ...WORKSTREAM_STATUSES] as const;

export type WorkstreamFilter = (typeof WORKSTREAM_FILTERS)[number];

export function workstreamFilterLabel(value: WorkstreamFilter): string {
  return value === "all" ? "전체" : WORKSTREAM_STATUS_LABEL[value];
}

export function workstreamFilterOf(
  status: WorkstreamStatus | null
): WorkstreamFilter {
  return status ?? "all";
}

export function workstreamStatusOf(
  filter: WorkstreamFilter
): WorkstreamStatus | null {
  return filter === "all" ? null : filter;
}

/**
 * 상태 필터는 인박스 탭과 같은 컨트롤이다 (features/common/FilterTabs).
 *
 * 처음에는 `role="group"` + `aria-pressed` 버튼 다섯 개를 손으로 만들었고, 그
 * 대가가 실측됐다: 탭 정거장 5개(집의 컨트롤은 roving tabindex로 1개), ←/→ 이동
 * 없음, 그리고 선택 알약이 `bg-accent-soft text-accent`라 `멈춤` 상태칩과 픽셀
 * 단위로 같은 배지가 됐다 — 목록의 한 행에 "멈춤" 배지가 둘 있는 화면(1R H2).
 * 공용 탭은 선택을 `bg-accent-soft font-medium text-ink`로 칠하므로 상태칩과
 * 잉크 색·크기·높이가 모두 다르다.
 */
export const WORKSTREAM_FILTER_TABS: FilterTabsSpec<WorkstreamFilter> = {
  label: "작업 흐름 상태",
  values: WORKSTREAM_FILTERS,
  labelFor: workstreamFilterLabel,
  tabId: (value) => `workstream-tab-${value}`,
  panelId: (value) => `workstream-panel-${value}`,
  // 엘리먼트 id와 달리 test id는 v1이 정한 문자열을 그대로 지킨다: 게이트가
  // `workstream-filter-done`으로 서버 필터 왕복을 잡고 있고, 리뷰가 맞다고 인정한
  // 단정을 컨트롤 교체로 깨뜨릴 이유가 없다.
  testId: (value) => `workstream-filter-${value}`,
};

/**
 * A run clock that survives leaving today, in two pieces.
 *
 * The session panel's bare HH:MM is right for a list of live sessions and wrong
 * here: a goal's history routinely spans days, and "09:12" three rows under
 * another "09:12" from last week reads as one morning's work.
 *
 * It comes back split because only ONE of the two halves is a figure. The clock
 * is tabular (a column of them has to line up); the date is Korean prose with
 * its units attached, and prose set in the mono stack renders with visibly
 * stretched gaps between syllables ("7월  29일", measured — tokens.md §4). So
 * the caller tags the time and leaves the day in the sans stack, rather than
 * this returning one string that forces the wrong answer for half of it.
 */
export interface RunClock {
  /** null when the run started today: the reader already knows the day. */
  day: string | null;
  time: string;
}

export function runClockLabel(atMs: number, nowMs: number): RunClock {
  const at = new Date(atMs);
  const now = new Date(nowMs);
  const pad = (value: number) => String(value).padStart(2, "0");
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  if (sameDay) return { day: null, time };
  const day = `${at.getMonth() + 1}월 ${at.getDate()}일`;
  return {
    day:
      at.getFullYear() === now.getFullYear()
        ? day
        : `${at.getFullYear()}년 ${day}`,
    time,
  };
}

/**
 * 이 목표를 실행한 사람(또는 에이전트)을 한 문장에서 부를 수 있는 형태로.
 *
 * 이 로스터에는 김인턴이 둘 있다(사람 하나, 에이전트 하나). 그래서 이름은
 * `displayName`에서 읽는 것이 아니라 공용 disambiguator를 지난다: 한 목표 아래
 * 김인턴 두 줄은 이력이 아니라 동전 던지기다.
 *
 * `ownerName`은 skill §9가 요구하는 병기다. agent actor에 `--agent` 토큰만
 * 얹으면 "A -> 에이전트 -> C" 원장에서 그 에이전트를 **누가 책임지는지**가
 * 빠지고, 이 표면은 정확히 그 원장을 읽으라고 존재한다(PR 918 R1 M6). 문장은
 * 멤버 디렉터리·타임라인이 이미 쓰는 `{owner} 님이 관리` 그대로다 — 같은
 * 사실을 두 표면이 다른 말로 부르면 읽는 사람이 둘을 다른 사실로 읽는다.
 *
 * 오너를 로스터에서 찾지 못하면 비운다. MemberRow가 하는 것과 같고, 없는 이름을
 * 지어내는 것보다 낫다.
 */
export interface WorkstreamActor {
  name: string;
  isAgent: boolean;
  /** 에이전트를 책임지는 사람. 사람 actor에는 언제나 null이다. */
  ownerName: string | null;
}

export function workstreamActor(
  directory: Directory,
  memberId: string
): WorkstreamActor {
  const parts = memberNameParts(directory, memberId, "알 수 없는 멤버");
  const member = memberFor(directory, memberId);
  const isAgent = member?.kind === "agent";
  const owner = isAgent ? memberFor(directory, member?.ownerHumanId) : null;
  return {
    name: parts.handle ? `${parts.name} ${parts.handle}` : parts.name,
    isAgent,
    ownerName: owner?.displayName ?? null,
  };
}

/**
 * How many DIFFERENT members ran this goal. This is the number ADR-0143 exists
 * to make possible ("A가 시작한 일을 B가 이어받는다"), so the detail states it
 * rather than leaving the reader to compare names down a column.
 */
export function actorCount(runs: readonly WorkstreamRun[]): number {
  return new Set(runs.map((run) => run.memberId.toLowerCase())).size;
}

/**
 * The Run a takeover would continue: the most recent ORPHANED one.
 *
 * Orphaned is not a presentation choice, it is the server's precondition
 * (`only an orphaned work session can resume`). A live session's control is a
 * Writer Lease question and belongs to ADR-0141, which is on hold, so this
 * surface offers exactly one thing: picking up something that stopped.
 */
export function continuableRun(
  runs: readonly WorkstreamRun[]
): WorkstreamRun | null {
  let candidate: WorkstreamRun | null = null;
  for (const run of runs) {
    if (run.status !== "orphaned") continue;
    if (candidate === null || run.startedAtMs > candidate.startedAtMs) {
      candidate = run;
    }
  }
  return candidate;
}

export type ContinuationState =
  | { kind: "ready"; run: WorkstreamRun; targets: WorkHost[] }
  | { kind: "closed"; status: Extract<WorkstreamStatus, "done" | "cancelled"> }
  | { kind: "offline" }
  | { kind: "no-runs" }
  | { kind: "no-stopped-run" }
  | { kind: "no-host"; run: WorkstreamRun };

/** 목표 자체가 끝난 상태. 실행이 아니라 GOAL에 대한 사실이다. */
function closedStatus(
  status: WorkstreamStatus
): Extract<WorkstreamStatus, "done" | "cancelled"> | null {
  return status === "done" || status === "cancelled" ? status : null;
}

/**
 * Whether 인수 can be offered, and when it cannot, which fact stopped it.
 *
 * Every branch is a different sentence to the reader, which is why this returns
 * a reason rather than a boolean: "아직 실행이 없습니다", "지금 인수할 실행이
 * 없습니다" and "인수할 수 있는 다른 호스트가 없습니다" are three different next
 * actions, and a disabled button with one generic tooltip is none of them.
 *
 * The workstream's OWN status is the first question, ahead of transport and
 * ahead of the run ledger, and it is a separate question from the runs: a goal
 * that was completed or cancelled can still hold an orphaned Run (a host dies
 * after the work is called done), and reading only the runs offered a 인수
 * control 180px under a 완료 chip (1R M1, measured). It has to outrank
 * `offline` too, because the offline sentence promises "다시 연결되면 이 자리에서
 * 인수할 수 있습니다", and for a finished goal that promise is simply false.
 * The status is the one the page is already rendering, so the block cannot
 * disagree with the chip in its own header.
 */
export function continuationState(
  runs: readonly WorkstreamRun[],
  hosts: readonly WorkHost[],
  viewerMemberId: string,
  offline: boolean,
  status: WorkstreamStatus
): ContinuationState {
  const closed = closedStatus(status);
  if (closed !== null) return { kind: "closed", status: closed };
  if (offline) return { kind: "offline" };
  if (runs.length === 0) return { kind: "no-runs" };
  const run = continuableRun(runs);
  if (run === null) return { kind: "no-stopped-run" };
  const targets = workSessionResumeTargets(run, hosts, viewerMemberId);
  return targets.length === 0
    ? { kind: "no-host", run }
    : { kind: "ready", run, targets };
}

/**
 * What the surface says when it cannot offer a takeover. Kept beside the state
 * that produced it so a new branch cannot ship without its sentence.
 *
 * None of these promise the working tree. momo's ledger knows the WIP branch
 * name, its base commit and the checkpoint metadata; whether the git remote
 * will actually hand those commits to the next person is git's answer, not
 * momo's (ADR-0143 D3), so no copy on this surface says "가져옵니다".
 */
export function continuationBlockedCopy(
  state: Exclude<ContinuationState, { kind: "ready" }>
): string {
  switch (state.kind) {
    case "closed":
      // 완료와 취소는 같은 "끝"이 아니다: 하나는 목표가 이루어진 것이고 하나는
      // 목표를 접은 것이라, 다음 행동을 권하는 어조가 다르다. 둘 다 이 목표로
      // 돌아오라고 하지 않고 앵커 스레드를 가리키는 이유는, 새 목표를 만드는 일이
      // 이 표면에 없기 때문이다(명시적 create는 ADR-0143 P2, 대화가 정본 ADR-0114).
      return state.status === "done"
        ? "이 목표는 완료됐습니다. 이어서 할 일이 있으면 앵커 대화에서 새 작업으로 시작하세요."
        : "이 목표는 취소됐습니다. 다시 해야 한다면 앵커 대화에서 새 작업으로 시작하세요.";
    case "offline":
      return "연결이 끊겨 지금은 인수할 수 없습니다. 다시 연결되면 이 자리에서 인수할 수 있습니다.";
    case "no-runs":
      return "아직 실행이 없습니다. 채널 스레드에서 작업을 시작하면 이 목표의 첫 실행으로 기록됩니다.";
    case "no-stopped-run":
      // 「가져올 수 있습니다」로 적지 않는다. 이 표면의 어떤 문장도 워킹 트리를
      // 약속하지 않는 것이 ADR-0143 D3 이고, 게이트가 그 낱말로 그 규칙을
      // 지킨다(`gate-workstream` 왕복 단정).
      return "지금 인수할 실행이 없습니다. 호스트 연결이 끊긴 실행만 다른 호스트에서 인수할 수 있습니다.";
    case "no-host":
      // 형제 표면과 **같은 문장**이다(sessionHandoff). 이 분기가 말하는 사실은
      // 거기서 말하는 사실과 같은 것이고, 두 벌로 두면 같은 막힘이 두 가지
      // 원인처럼 읽힌다 — 실제로 그랬다: 이쪽만 `online` 을 자격으로 불렀다.
      return TAKEOVER_NO_TARGET_COPY;
  }
}

/**
 * 인수 실패 문구는 **이 파일에 없다** (R1 H1).
 *
 * 여기 있던 `continuationErrorCopy` 는 상태 코드만 보고 세 문장을 갈랐다. 같은
 * `POST …/resume` 를 부르는 작업 세션 패널은 그 사이 서버 메시지까지 읽도록
 * 자랐고(`takeoverFailureCopy`), 두 번역기가 갈라진 지점이 정확히 **409**다:
 * 서버는 그 코드로 「상태가 바뀌었다」와 「실행 슬롯이 다 찼다」(`pool_exhausted`)
 * 와 「내 동시 실행 한도」(`member_limit`)를 함께 말한다. 이 파일의 409 문장은
 * 그 셋 전부에 「이력을 새로고침한 뒤 다시 확인하세요」라고 답했고, 슬롯이 찬
 * 사람은 새로고침을 반복하게 된다.
 *
 * 한 act 의 실패는 한 곳에서 번역한다 — 이 티켓이 낱말에 대해 세운 규칙과 같은
 * 규칙이다. 호출자는 `features/work/sessionHandoff.takeoverFailureCopy` 를 쓴다.
 */

/**
 * Name a channel the way the 작업 세션 패널 names it: `#채널` for a channel, the
 * peer's name for a DM, and 다른 채널 for one this client has not listed. Two
 * work surfaces calling one channel by two names is a reader's problem, not a
 * style question, so the idiom is shared rather than copied.
 *
 * It never HIDES a row: the server decides what is visible, and a client-side
 * channel miss is a naming gap, not a permission answer.
 */
export function channelDisplayName(
  channelId: string,
  channels: readonly Channel[],
  directory: Directory,
  selfMemberId: string
): string {
  const channel = channels.find((candidate) => uuidEq(candidate.id, channelId));
  if (!channel) return "다른 채널";
  const label = channelLabel(channel, directory, selfMemberId);
  return channel.kind === "dm" ? label : `#${label}`;
}
