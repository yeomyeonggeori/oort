import { WORKBENCH_GUTTER, WORKBENCH_MIN_PANE } from "./layoutTree";

// =============================================================================
// 작업 탭 진입점 (#2854, ADR-0194 D1, 제안서 §3.1·§3.3, 시안 ①).
//
// 사이드바 「작업」 묶음의 두 줄이 클라 라우트 `/work` 하나를 채운다.
//
// - 「내 작업」 `/work`: 이 기기의 세션 격자(데스크탑). 웹에는 로컬 터미널
//   레인이 없다(ADR-0190 D1). 웹의 `/work`는 지금까지처럼 작업 콘솔이다.
// - 「팀 작업」 `/work?view=team`: 팀 보드(ADR-0194 D1·D2의 보드 링크와 같은
//   쿼리). 보드 자체는 T11(#2863)이 채운다. 그 전에는 빈 상태 안내다.
// - 작업 콘솔: 에이전트(A 레인) 세션 목록. 웹은 `/work`, 데스크탑은 `/work`가
//   격자라 `?view=console`에 둔다. 세션 링크 `/work?session=<id>`는 두 곳 모두
//   콘솔로 간다(인박스 앵커·관제 카드가 이미 이 주소를 쓴다).
//
// 폭(§3.3): 작업 탭에서 앱 사이드바는 64px 레일로 접힌다. 사이드바(324)와 세션
// 목록(260)을 다 펴면 1440 창의 4열 칸이 칸 최소 폭(240)에 못 미친다.
// 레일 64 + 목록 260 = 324: 다른 탭의 사이드바 전체 폭과 같다. 탭을 오갈 때 본문의
// 왼쪽 가장자리가 움직이지 않는다(#3275).
// =============================================================================

/** 작업 탭에서 앱 사이드바가 접힌 레일의 폭(시안 ① `.rail`). */
export const WORK_TAB_RAIL_PX = 64;
/**
 * 세션 목록 패널의 폭(시안 ① `.slist`, T4 #2856이 세운다). 시안은 268이었으나 레일 64와
 * 합쳐 앱 사이드바 전체 폭(56 + 268 = 324)과 같도록 260으로 둔다(#3275).
 */
export const WORK_TAB_SESSION_LIST_PX = 260;
/** 격자의 좌우 여백(시안 ① `.grid` padding 0 12). */
export const WORK_TAB_GRID_PAD_PX = 12;

export const MY_WORK_PATH = "/work";
export const TEAM_WORK_PATH = "/work?view=team";
export const WORK_CONSOLE_VIEW_PATH = "/work?view=console";

export type WorkView = "mine" | "team" | "console";

/**
 * `/work`의 쿼리로 어느 보기인지 정한다. 세션 링크(`?session=`)는 콘솔이다.
 * 모르는 `view` 값은 「내 작업」으로 읽는다: 링크가 낡았다고 빈 화면을 주지 않는다.
 */
export function workViewOf(search: string): WorkView {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const view = params.get("view");
  if (view === "team") return "team";
  if (view === "console" || params.has("session")) return "console";
  return "mine";
}

/**
 * 이 주소가 격자를 그리는 「내 작업」인가. 격자는 데스크탑에만 있다.
 * 앱 셸이 이 답으로 사이드바를 레일로 접고 도크를 내린다.
 */
export function isMyWorkTab(pathname: string, search: string, desktop: boolean): boolean {
  return desktop && isWorkPath(pathname) && workViewOf(search) === "mine";
}

/**
 * 라우터가 `/work`로 받는 주소인가. React Router는 대소문자를 가리지 않고 끝
 * 빗금도 받는다(`/Work`, `/work/`). 셸(도크를 내린다)과 라우트(격자를 그린다)가
 * 같은 답을 내야 한 칸에 xterm 둘이 붙지 않는다(검수 #2927 M2).
 */
export function isWorkPath(pathname: string): boolean {
  return pathname.replace(/\/+$/, "").toLowerCase() === MY_WORK_PATH;
}

export interface WorkTabWidthInput {
  /** 창 폭(CSS px). */
  windowWidth: number;
  /** 앱 사이드바 열의 폭. 작업 탭에서는 레일(64), 펼치면 324. */
  sidebarPx: number;
  /** 세션 목록 패널의 폭. 접으면 0. */
  sessionListPx: number;
  /** 격자의 열 수(4×2면 4). */
  cols: number;
}

/**
 * 작업 탭에서 `cols`열 격자의 칸 하나 폭. 격자 좌우 여백과 칸 사이 경계를 빼고
 * 나눈다(시안 ① 계산과 같은 식: 1440에서 약 265). 작업 탭에는 떠 있는 판이 없어
 * 판 인셋이 없다(tokens.css `app-shell[data-work-rail]`).
 */
export function workTabPaneWidth({ windowWidth, sidebarPx, sessionListPx, cols }: WorkTabWidthInput): number {
  const grid =
    windowWidth - sidebarPx - sessionListPx - 2 * WORK_TAB_GRID_PAD_PX;
  return (grid - (cols - 1) * WORKBENCH_GUTTER) / cols;
}

/** 그 폭이 칸 최소 폭(`WORKBENCH_MIN_PANE`)을 넘는가. */
export function workTabFits(input: WorkTabWidthInput): boolean {
  return workTabPaneWidth(input) >= WORKBENCH_MIN_PANE.width;
}

/**
 * 세션 목록(260)을 편 채로 이 배치가 칸 최소 폭을 지키는가(#2856). `minGridWidth`는
 * 배치의 최소 폭(`minimumSize(layout.root).width`)이다. 못 지키면 목록을 스스로
 * 접는다(사람이 직접 편 목록은 접지 않는다). 1440 창 4×2(984)는 지키고, 1280 창
 * 4×2는 못 지킨다(932).
 */
export function sessionListFits(windowWidth: number, minGridWidth: number): boolean {
  const grid = windowWidth - WORK_TAB_RAIL_PX - WORK_TAB_SESSION_LIST_PX - 2 * WORK_TAB_GRID_PAD_PX;
  return grid >= minGridWidth;
}

/** 사이드바 두 줄과 화면 제목. 줄 이름과 도착한 화면의 제목이 같은 말이다(#1146 N4). */
export const WORK_NAV = {
  mine: "내 작업",
  team: "팀 작업",
} as const;

/** 「팀 작업」 보드가 서기 전(T11 #2863)의 빈 상태. 한 문장 + 한 행동. */
export const TEAM_WORK_EMPTY = {
  title: "팀 작업 보드가 아직 없습니다",
  body: "팀원이 공유한 세션과 에이전트 세션이 이곳에 모일 예정입니다. 그전에는 채널에서 진행을 확인하세요.",
  action: "채널로 가기",
} as const;
