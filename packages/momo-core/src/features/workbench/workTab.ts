import { WORKBENCH_GUTTER, WORKBENCH_MIN_PANE } from "./layoutTree";

// =============================================================================
// 작업 탭 진입점 (#2854, ADR-0194 D1, 제안서 §3.1·§3.3, 시안 ①).
//
// 사이드바 「작업」 묶음의 두 줄이 클라 라우트 `/work` 하나를 채운다.
//
// - 「내 작업」 `/work`: 이 기기의 세션 격자(데스크탑). 웹에는 로컬 터미널
//   레인이 없다(ADR-0190 D1). 웹의 `/work`는 지금까지처럼 작업 콘솔이다.
// - 「팀 작업」 `/work?view=team`: 팀 보드(ADR-0194 D1·D2의 보드 링크와 같은
//   쿼리). 보드는 `teamBoard.ts`와 웹 `workTab/teamBoard/`(T11 #2863)가 채운다.
// - 작업 콘솔: 에이전트(A 레인) 세션 목록. 웹은 `/work`, 데스크탑은 `/work`가
//   격자라 `?view=console`에 둔다. 세션 링크 `/work?session=<id>`는 두 곳 모두
//   콘솔로 간다(인박스 앵커·관제 카드가 이미 이 주소를 쓴다).
//
// 폭(§3.3): 레일은 모든 탭에서 같은 56px 한 벌이다(#3280). 작업 탭에서는 앱 사이드바의
// 채널 목록이 서지 않고 그 자리(목록 열)를 세션 목록이 쓴다(라우트 안). 사이드바(324)와
// 세션 목록(268)을 둘 다 펴면 1440 창의 4열 칸이 칸 최소 폭(240)에 못 미치므로 앱 사이드바
// 트리는 서지 않는다. 레일 56 + 목록 268 = 324: 다른 탭의 사이드바 전체 폭과 같다. 탭을 오갈
// 때 본문의 왼쪽 가장자리가 움직이지 않는다(#3275, #3280에서 260 타협 해소).
// =============================================================================

/** 모든 탭이 같이 쓰는 레일의 폭(`--spacing-rail`). #3280 이전에는 작업 탭만 64였다. */
export const WORK_TAB_RAIL_PX = 56;
/**
 * 세션 목록 패널의 폭(시안 ① `.slist`, T4 #2856이 세운다). 사이드바 목록 열(268,
 * `--w-sidebar-list`)과 같다. 레일 56과 합쳐 앱 사이드바 전체 폭(324)이 된다.
 */
export const WORK_TAB_SESSION_LIST_PX = 268;
/** 격자의 좌우 여백(시안 ① `.grid` padding 0 12). */
export const WORK_TAB_GRID_PAD_PX = 12;

// ADR-0202 D6 (U1 #3842): 사이드바의 「내 작업」·「팀 작업」·「활동」·「작업 콘솔」·「작업 흐름」
// 다섯 줄이 「작업」 한 줄이 됐다. `/work`는 이제 결과 중심 「작업」 화면이고, 「내 것 / 팀 전체」는
// 그 화면의 필터다(`workJobs.ts`). 옛 주소는 지우지 않는다:
//   - `/work?view=team`(ADR-0194 D2 보드 링크) → 「작업」 + 「팀 전체」
//   - `/work?view=console`·`?session=` → 작업 콘솔(그대로, 진입점만 숨김)
//   - 데스크탑 터미널 격자(옛 「내 작업」 본문)는 `?view=terminals`로 옮겼다. 「작업」 화면의
//     「내 것」 머리의 「이 기기」 줄이 그리로 간다. 사이드바 줄은 따로 없다.

/** 「작업」 화면. 옛 이름을 지키는 것은 이 상수를 쓰는 진입점(인박스·도크)이 여럿이라서다. */
export const MY_WORK_PATH = "/work";
export const WORK_PATH = MY_WORK_PATH;
/** 옛 「팀 작업」 링크. 지금은 「작업」 + 「팀 전체」로 열린다. */
export const TEAM_WORK_PATH = "/work?view=team";
export const WORK_CONSOLE_VIEW_PATH = "/work?view=console";
/** 데스크탑 이 기기의 터미널 격자(옛 「내 작업」 본문). */
export const LOCAL_TERMINALS_PATH = "/work?view=terminals";

export type WorkView = "jobs" | "terminals" | "console";

/**
 * `/work`의 쿼리로 어느 보기인지 정한다. 세션 링크(`?session=`)는 콘솔이다.
 * 모르는 `view` 값(옛 `team`·`mine` 포함)은 「작업」 화면으로 읽는다: 링크가 낡았다고 빈 화면을
 * 주지 않는다. 필터(`who`·옛 `view=team`)는 화면이 `workFilterFromSearch`로 읽는다.
 */
export function workViewOf(search: string): WorkView {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const view = params.get("view");
  if (view === "terminals") return "terminals";
  if (view === "console" || params.has("session")) return "console";
  return "jobs";
}

/**
 * 이 주소가 격자를 그리는 「내 작업」인가. 격자는 데스크탑에만 있다.
 * 앱 셸이 이 답으로 목록 열을 라우트(세션 목록)에 넘기고 도크를 내린다. 레일은 그대로다.
 */
export function isMyWorkTab(pathname: string, search: string, desktop: boolean): boolean {
  return desktop && isWorkPath(pathname) && workViewOf(search) === "terminals";
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
  /** 앱 사이드바 열의 폭. 작업 탭에서는 레일(56), 펼치면 324. */
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
 * 세션 목록(268)을 편 채로 이 배치가 칸 최소 폭을 지키는가(#2856). `minGridWidth`는
 * 배치의 최소 폭(`minimumSize(layout.root).width`)이다. 못 지키면 목록을 스스로
 * 접는다(사람이 직접 편 목록은 접지 않는다). 1440 창 4×2(984)는 지키고, 1280 창
 * 4×2는 못 지킨다(932).
 */
export function sessionListFits(windowWidth: number, minGridWidth: number): boolean {
  const grid = windowWidth - WORK_TAB_RAIL_PX - WORK_TAB_SESSION_LIST_PX - 2 * WORK_TAB_GRID_PAD_PX;
  return grid >= minGridWidth;
}

/**
 * 사이드바 줄과 화면 제목. 줄 이름과 도착한 화면의 제목이 같은 말이다(#1146 N4).
 * `work`가 사이드바의 한 줄이다(ADR-0202 D6). `mine`은 터미널 격자 머리의 제목으로만 남고,
 * `team`은 옛 화면(팀 보드 코드, 라우트에서 내려옴)의 제목으로만 남는다.
 */
export const WORK_NAV = {
  work: "작업",
  mine: "이 기기 터미널",
  team: "팀 작업",
} as const;
