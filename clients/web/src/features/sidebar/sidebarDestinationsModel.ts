import type { WorkView } from "@momo/core/features/workbench/workTab";

/** 구획 B의 접힘 열쇠(기기별, `sidebarSectionPreference`). */
export const AGENT_WORK_SECTION_ID = "agent-work";

export interface SidebarDestinationActive {
  chat: boolean;
  inbox: boolean;
  directory: boolean;
  agents: boolean;
  mine: boolean;
  team: boolean;
  activity: boolean;
  console: boolean;
  workstreams: boolean;
}

/**
 * 지금 주소가 어느 목적지인가. 한 번에 하나이고, 목적지 밖의 화면(설정 등)은 모두 거짓이다.
 * 웹에서도 「내 작업」 줄은 서므로(설명 상태가 열린다) 판정은 데스크탑과 웹이 같다.
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
    agents: startsWith("/agents"),
    mine: workView === "mine",
    team: workView === "team",
    activity: startsWith("/activity"),
    console: workView === "console",
    workstreams: startsWith("/workstreams"),
  };
}
