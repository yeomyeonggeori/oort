import type { WorkView } from "@momo/core/features/workbench/workTab";

/** 구획 B의 접힘 열쇠(기기별, `sidebarSectionPreference`). */
export const AGENT_WORK_SECTION_ID = "agent-work";

export interface SidebarDestinationActive {
  chat: boolean;
  inbox: boolean;
  directory: boolean;
  ai: boolean;
  agents: boolean;
  /** 「작업」 한 줄(ADR-0202 D6): `/work`의 어느 보기든(「작업」 화면·터미널 격자·콘솔). */
  work: boolean;
}

/**
 * 지금 주소가 어느 목적지인가. 한 번에 하나이고, 목적지 밖의 화면(설정 등)은 모두 거짓이다.
 * 판정은 데스크탑과 웹이 같다.
 */
export function destinationActive(
  pathname: string,
  workView: WorkView | null
): SidebarDestinationActive {
  const startsWith = (prefix: string) =>
    pathname === prefix || pathname.startsWith(`${prefix}/`);
  return {
    chat: pathname === "/" || startsWith("/c"),
    inbox: startsWith("/inbox"),
    directory: startsWith("/directory"),
    ai: startsWith("/ai"),
    agents: startsWith("/agents"),
    // 숨긴 진입점(활동·작업 흐름)의 주소는 어느 줄도 고르지 않는다. 콘솔·터미널 격자는 「작업」
    // 묶음 안의 보기라 「작업」 줄이 선택이다.
    work: workView !== null,
  };
}
