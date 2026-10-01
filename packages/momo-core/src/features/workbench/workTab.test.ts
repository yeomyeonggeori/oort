import { describe, expect, it } from "vitest";
import { WORKBENCH_MIN_PANE } from "./layoutTree";
import {
  sessionListFits,
  WORK_TAB_RAIL_PX,
  WORK_TAB_SESSION_LIST_PX,
  isMyWorkTab,
  workTabFits,
  workTabPaneWidth,
  workViewOf,
} from "./workTab";

/** 레일을 접지 않은 앱 사이드바(워크스페이스 레일 56 + 목록 268). */
const FULL_SIDEBAR_PX = 56 + 268;

describe("작업 탭 폭 (#2854, 제안서 §3.3)", () => {
  it("1440 창, 레일 64 + 세션 목록 260에서 4×2 칸이 최소 폭 240을 넘는다", () => {
    const input = { windowWidth: 1440, sidebarPx: WORK_TAB_RAIL_PX, sessionListPx: WORK_TAB_SESSION_LIST_PX, cols: 4 };
    expect(workTabPaneWidth(input)).toBe(267); // 시안 ①은 목록 268 → 265, 레일+목록=324 정렬(#3275)로 목록 260 → 267
    expect(WORK_TAB_RAIL_PX + WORK_TAB_SESSION_LIST_PX).toBe(FULL_SIDEBAR_PX); // 탭을 오가도 왼쪽 가장자리가 같다
    expect(workTabPaneWidth(input)).toBeGreaterThanOrEqual(WORKBENCH_MIN_PANE.width);
    expect(workTabFits(input)).toBe(true);
  });

  it("사이드바를 접지 않으면 같은 창에서 4열이 240에 못 미친다(레일이 필요한 이유)", () => {
    const input = { windowWidth: 1440, sidebarPx: FULL_SIDEBAR_PX, sessionListPx: WORK_TAB_SESSION_LIST_PX, cols: 4 };
    expect(workTabPaneWidth(input)).toBeLessThan(WORKBENCH_MIN_PANE.width);
    expect(workTabFits(input)).toBe(false);
  });

  it("1280 창에서는 레일이어도 목록을 편 4열이 모자라다(프리셋 T5가 안내할 경우)", () => {
    expect(workTabFits({ windowWidth: 1280, sidebarPx: WORK_TAB_RAIL_PX, sessionListPx: WORK_TAB_SESSION_LIST_PX, cols: 4 })).toBe(false);
    expect(workTabFits({ windowWidth: 1280, sidebarPx: WORK_TAB_RAIL_PX, sessionListPx: 0, cols: 4 })).toBe(true);
  });
});

describe("/work 보기 판정 (ADR-0194 D1·D2)", () => {
  it("쿼리 없음은 내 작업, view=team은 팀 작업, 세션 링크와 view=console은 콘솔", () => {
    expect(workViewOf("")).toBe("mine");
    expect(workViewOf("?view=team")).toBe("team");
    expect(workViewOf("?view=team&channel=c1")).toBe("team");
    expect(workViewOf("?session=abc")).toBe("console");
    expect(workViewOf("?view=console")).toBe("console");
    expect(workViewOf("?view=nope")).toBe("mine");
  });

  it("격자를 그리는 내 작업은 데스크탑의 /work 쿼리 없음 하나뿐이다", () => {
    expect(isMyWorkTab("/work", "", true)).toBe(true);
    expect(isMyWorkTab("/work", "", false)).toBe(false);
    expect(isMyWorkTab("/work", "?view=team", true)).toBe(false);
    expect(isMyWorkTab("/work", "?session=abc", true)).toBe(false);
    expect(isMyWorkTab("/inbox", "", true)).toBe(false);
    // 라우터가 같은 라우트로 받는 표기(끝 빗금·대소문자)도 같은 답이다(검수 #2927 M2).
    expect(isMyWorkTab("/work/", "", true)).toBe(true);
    expect(isMyWorkTab("/Work", "", true)).toBe(true);
    expect(isMyWorkTab("/workstreams", "", true)).toBe(false);
  });
});

describe("sessionListFits (#2856)", () => {
  // 4×2의 최소 폭: 240 × 4 + 경계 8 × 3 = 984.
  const min4x2 = 4 * 240 + 3 * 8;
  it("1440 창은 목록(260)을 편 채로 4×2가 선다", () => {
    expect(sessionListFits(1440, min4x2)).toBe(true);
  });
  it("1280 창은 목록을 펴면 4×2가 240을 못 지켜 접는다", () => {
    expect(sessionListFits(1280, min4x2)).toBe(false);
  });
  it("경계: 목록을 편 격자 폭이 최소 폭과 같으면 선다", () => {
    expect(sessionListFits(64 + WORK_TAB_SESSION_LIST_PX + 24 + min4x2, min4x2)).toBe(true);
    expect(sessionListFits(64 + WORK_TAB_SESSION_LIST_PX + 24 + min4x2 - 1, min4x2)).toBe(false);
  });
});
