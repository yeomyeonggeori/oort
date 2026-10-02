import type {
  SharedWorkSession,
  SharedWorkSessionDiff,
  SharedSessionState,
} from "../../lib/api";
import { uuidEq } from "../../lib/api";
import { attachParticle } from "../../lib/koreanParticle";
import { SESSION_STATUS_LABEL } from "./sessionList";

// =============================================================================
// 「팀 작업」 보드의 말과 묶음 (#2863, 제안서 §4, ADR-0194, 시안 ④).
//
// 보드는 **공유된 세션만** 보여 준다. 서버가 보는 사람의 채널 멤버십으로 이미 걸러
// 보낸 줄(`SharedWorkSession`)을 받아, 이 모듈은 말과 묶음만 정한다. 여기서 거르지
// 않는다: 클라이언트가 한 번 더 거르면 서버의 거르기가 새는 것을 가리거나, 보여야 할
// 줄을 숨긴다. 시험이 그 두 방향을 모두 잠근다.
//
// 대기 상태의 말은 「내 작업」과 같은 정본 상수(`SESSION_STATUS_LABEL`, 「응답 필요」)다
// (성재 결정 2026-10-01, #3279·#3285). 보드가 따로 말을 만들지 않는다.
// =============================================================================

export const TEAM_BOARD_COPY = {
  title: "팀 작업",
  subtitle: "공유된 세션만 보입니다",
  viewNow: "지금",
  viewDone: "오늘 끝난 것",
  groupHint: "공유한 것만 보여요",
  // 공유를 켜는 단추는 #2867이 세운다. 그 전에는 단추를 약속하지 않는다.
  emptyTitle: "공유된 세션이 아직 없어요",
  emptyBody:
    "팀원이 공유를 켠 세션이 여기에 보여요. 내가 속한 채널에 공유된 것만 모여요.",
  emptyDoneTitle: "오늘 끝난 공유 세션이 없어요",
  emptyDoneBody: "공유된 세션이 끝나면 여기에 모여요.",
  emptyAction: "채널로 가기",
  errorTitle: "팀 작업을 불러오지 못했어요",
  errorBody: "연결을 확인하고 다시 불러와 보세요.",
  errorAction: "다시 불러오기",
  offlineBanner: "오프라인이에요. 마지막으로 본 목록을 보여 드려요.",
  offlineEmpty: "오프라인이에요. 연결되면 팀 작업을 불러와요.",
  loadMore: "더 보기",
  loadingMore: "더 불러와요",
  drawerLabel: "세션 상세",
  drawerClose: "닫기",
  progressHeading: "진행",
  logHeading: "로그 요약",
  logHint: "하네스가 알린 것만",
  resultHeading: "결과",
  noPr: "아직 PR 없음",
  noPrBody: "PR이 열리면 채널 카드에 붙어요",
  terminalNote:
    "터미널 원문은 주인의 기기에만 있어요. 여기서는 이름, 상태, 작업 위치와 하네스가 알린 단계만 보여요.",
  goneTitle: "이 세션은 더 이상 보이지 않아요",
  goneBody: "공유가 꺼졌거나 이 채널의 멤버가 아니에요.",
  // 폰 한 열 판(#2864). 보기 전환은 「전체 | 내 것」, 한 줄 목록은 상태 구간으로 끊는다.
  filterAll: "전체",
  filterMine: "내 것",
  emptyMineTitle: "내가 시킨 세션이 없어요",
  emptyMineBody: "내 이름으로 돌고 있거나 오늘 끝난 공유 세션이 여기에 모여요.",
} as const;

/** 목록 한 줄의 상태 칩 말(시안 ④). 색만으로 말하지 않고 글자가 붙는다. */
export function stateChipLabel(item: SharedWorkSession): string {
  switch (item.state) {
    case "waiting":
      return SESSION_STATUS_LABEL.waiting;
    case "running":
      return "실행 중";
    case "review":
      return "검토 대기";
    case "idle":
      return "대기";
    case "done":
      return item.prUrl !== null ? "끝남 · PR" : "끝남";
    case "stopped":
      return "멈춤";
  }
}

/** 레인 말. 로컬 공유 세션과 에이전트 세션은 서로 다른 말을 쓴다(제안서 §4.2). */
export function laneLabel(item: SharedWorkSession): string {
  return item.origin === "host"
    ? `에이전트 · ${attachParticle(item.owner.displayName, "subject")} 시킴`
    : "로컬 · 공유됨";
}

export function isAgentLane(item: SharedWorkSession): boolean {
  return item.origin === "host";
}

/** 홈 채널의 표시. 이름이 없으면(모르면) 그대로 「채널」이다. */
export function channelLabel(item: SharedWorkSession): string {
  const name = item.homeChannel.name;
  return name === null || name === "" ? "채널" : `#${name}`;
}

/** 「저장소 / 브랜치」. 에이전트 레인은 둘 다 없을 수 있다. */
export function whereLabel(item: SharedWorkSession): {
  primary: string | null;
  secondary: string | null;
} {
  const primary = item.repo ?? item.folderLabel;
  return { primary, secondary: item.branch };
}

/**
 * 상세 머리의 상태 문장(시안 ④ 「곽성재의 응답이 필요해요 · 3분째」).
 * `nowMs`는 호출자가 준다(시계 없는 순수 함수).
 */
export function stateSentence(item: SharedWorkSession, nowMs: number): string {
  const owner = item.owner.displayName;
  switch (item.state) {
    case "waiting": {
      const minutes = Math.max(
        0,
        Math.floor((nowMs - item.lastActivityAt * 1000) / 60_000)
      );
      const since = minutes < 1 ? "방금부터" : `${minutes}분째`;
      return `${owner}의 응답이 필요해요 · ${since}`;
    }
    case "running":
      return "지금 작업하고 있어요";
    case "review":
      return "검토를 기다려요";
    case "idle":
      return "잠시 쉬고 있어요";
    case "done":
      return "끝났어요";
    case "stopped":
      return "멈췄어요";
  }
}

/** 상태가 끝났는가. 「지금」 보기와 「오늘 끝난 것」 보기를 가른다. */
export function isFinishedState(state: SharedSessionState): boolean {
  return state === "done" || state === "stopped";
}

export type BoardView = "now" | "done";

/** 같은 날(호출자 시간대) 0시. */
export function startOfLocalDay(nowMs: number): number {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 보기별 줄. 이것은 **보는 사람 거르기가 아니다**(서버가 끝낸 일). 같은 응답을 「지금」과
 * 「오늘 끝난 것」으로 나눌 뿐이고, 어느 쪽에도 없는 줄은 없다(끝난 지 오래된 줄은
 * 서버가 30일 뒤에 거둔다).
 */
export function itemsForView(
  items: readonly SharedWorkSession[],
  view: BoardView,
  nowMs: number
): SharedWorkSession[] {
  if (view === "now") return items.filter((i) => !isFinishedState(i.state));
  const since = startOfLocalDay(nowMs);
  return items.filter(
    (i) => isFinishedState(i.state) && i.lastActivityAt * 1000 >= since
  );
}

export interface BoardGroup {
  key: string;
  ownerName: string;
  /** 에이전트 레인 줄만 있는 묶음인가(아바타 모양을 가른다). */
  agentOnly: boolean;
  items: SharedWorkSession[];
}

/**
 * 사람별로 묶는다(기본 묶기). 서버 순서(마지막 활동 최신순)를 지킨다: 묶음은 첫
 * 줄이 나온 순서, 묶음 안은 받은 순서다.
 */
export function groupByOwner(
  items: readonly SharedWorkSession[]
): BoardGroup[] {
  const groups: BoardGroup[] = [];
  const index = new Map<string, BoardGroup>();
  for (const item of items) {
    const key = item.owner.memberId.toLowerCase();
    let group = index.get(key);
    if (!group) {
      group = {
        key,
        ownerName: item.owner.displayName,
        agentOnly: true,
        items: [],
      };
      index.set(key, group);
      groups.push(group);
    }
    if (item.origin !== "host") group.agentOnly = false;
    group.items.push(item);
  }
  return groups;
}

/** 줄 머리 요약(시안 ④ 코메토 줄). 숫자는 보이는 줄에서만 센다. */
export function boardSummary(items: readonly SharedWorkSession[]): {
  sentence: string;
  current: number;
  waiting: number;
} {
  const current = items.filter((i) => !isFinishedState(i.state));
  const waiting = current.filter((i) => i.state === "waiting").length;
  if (current.length === 0) {
    return { sentence: "지금 도는 공유 세션이 없어요.", current: 0, waiting: 0 };
  }
  const first = `지금 팀에서 ${current.length}개가 돌고 있어요.`;
  const sentence =
    waiting > 0 ? `${first} ${waiting}개는 응답이 필요해요.` : first;
  return { sentence, current: current.length, waiting };
}

/** 「오늘 끝난 것」 보기의 요약. 「지금」 문장을 그대로 두면 보이는 목록과 어긋난다. */
export function doneSummary(count: number): string {
  return count === 0
    ? "오늘 끝난 공유 세션이 없어요."
    : `오늘 ${count}개가 끝났어요.`;
}

export interface DiffFacts {
  commits: number | null;
  added: number | null;
  deleted: number | null;
  files: number | null;
}

/** 숫자가 하나도 없으면 null(에이전트 레인). 있는 것만 말한다. */
export function diffFacts(diff: SharedWorkSessionDiff): DiffFacts | null {
  const facts: DiffFacts = {
    commits: diff.ahead,
    added: diff.added,
    deleted: diff.deleted,
    files: diff.files,
  };
  const any =
    facts.commits !== null ||
    facts.added !== null ||
    facts.deleted !== null ||
    facts.files !== null;
  return any ? facts : null;
}

/** `https://github.com/owner/repo/pull/2851` → 「PR #2851」와 「owner/repo」. */
export function prFacts(
  url: string | null
): { number: string; repo: string; href: string } | null {
  if (url === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d{1,9})$/.exec(parsed.pathname);
  if (!match) return null;
  return {
    number: `PR #${match[3]}`,
    repo: `${match[1]}/${match[2]}`,
    href: parsed.toString(),
  };
}

export type StageMarker = { label: string; tone: "done" | "current" };

/**
 * 단계 표지. 하네스가 알린 닫힌 말의 순서 그대로다. 마지막 표지만 지금 상태를
 * 따르고(기다림·실행·끝남), 앞의 표지는 지나간 것이다. 없으면 빈 목록이고 화면은 이
 * 절을 숨긴다.
 */
export function stageMarkers(item: SharedWorkSession): StageMarker[] {
  return item.stages.map((label, i) => ({
    label,
    tone: i === item.stages.length - 1 && !isFinishedState(item.state) ? "current" : "done",
  }));
}

/** 목록·상세가 같이 쓰는 첫 줄 이름. 빈 이름이면 레인 말로 대신한다. */
export function sessionTitle(item: SharedWorkSession): string {
  const label = item.label.trim();
  return label === "" ? laneLabel(item) : label;
}

/** 보드가 듣는 집 채널들(중복 없이, 받은 순서). */
export function homeChannelIds(items: readonly SharedWorkSession[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.homeChannel.id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item.homeChannel.id);
  }
  return out;
}

// -----------------------------------------------------------------------------
// 폰 한 열 판 (#2864, 제안서 T12). 같은 줄을 **상태 순서**로 한 열에 세운다:
// 응답 필요 → 실행 중 → 검토 대기, 그 뒤 대기, 맨 끝에 오늘 끝난 것. 구간 안은 서버
// 순서(마지막 활동 최신순)를 지킨다. 여기서도 **거르지 않는다**: 순서와 구간만 정하고,
// 「내 것」은 보는 사람이 고른 보기이지 가시성 거르기가 아니다(서버가 이미 끝낸 일).
// -----------------------------------------------------------------------------

/** 한 열 판의 구간. 끝난 줄은 「오늘 끝난 것」 하나로 모은다. */
export type BoardSectionKey = "waiting" | "running" | "review" | "idle" | "finished";

/** 위에서 아래로. 이 순서가 이슈 #2864의 수용 기준이다. */
export const BOARD_SECTION_ORDER: readonly BoardSectionKey[] = [
  "waiting",
  "running",
  "review",
  "idle",
  "finished",
];

export interface BoardSection {
  key: BoardSectionKey;
  label: string;
  items: SharedWorkSession[];
}

/**
 * 구간으로 나눈다. 빈 구간은 만들지 않는다. 끝난 줄은 오늘 0시 이후에 끝난 것만 서고
 * (`itemsForView`의 「오늘 끝난 것」과 같은 기준), 그보다 오래된 끝난 줄은 이 한 열
 * 판에 서지 않는다(웹 보드에서도 어느 보기에도 서지 않는 줄이다).
 */
export function boardSections(
  items: readonly SharedWorkSession[],
  nowMs: number
): BoardSection[] {
  const finished = itemsForView(items, "done", nowMs);
  const sections: BoardSection[] = [];
  for (const key of BOARD_SECTION_ORDER) {
    const inSection =
      key === "finished" ? finished : items.filter((i) => i.state === key);
    if (inSection.length === 0) continue;
    sections.push({
      key,
      label: key === "finished" ? TEAM_BOARD_COPY.viewDone : SESSION_STATUS_LABEL[key],
      items: inSection,
    });
  }
  return sections;
}

/** 「내 것」: 주인이 나인 줄. 에이전트 레인은 주인이 시킨 사람이다(레인 말과 같은 뜻). */
export function ownedBy(
  items: readonly SharedWorkSession[],
  memberId: string
): SharedWorkSession[] {
  return items.filter((i) => uuidEq(i.owner.memberId, memberId));
}
