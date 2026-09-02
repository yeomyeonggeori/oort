// =============================================================================
// 사이드바 섹션 REST (ADR-0177 D2 / BT-4 #1932).
//
//   GET|PUT /v1/workspaces/{ws}/members/me/sidebar-prefs
//
// 자기 파일인 이유는 `./notificationRules.ts` 가 적은 것과 같다: 공용 클라이언트
// (`lib/api.ts`)는 병렬 워커가 가장 자주 부딪히는 파일이고, `settingsRequest` 를
// 그대로 쓰므로 전송과 인증 경로는 여전히 하나다.
//
// 이벤트가 없다(D2). 그래서 이 표면에는 구독도 무효화 훅도 없고, 타 기기의 변경은
// 다음 부트스트랩 GET 에서 도착한다.
// =============================================================================

import { settingsRequest } from "../settings/api";
import {
  sidebarPrefsFromWire,
  sidebarPrefsToWire,
  type SidebarPrefs,
} from "./sidebarSections";

function sidebarPrefsPath(workspaceId: string): string {
  return `/v1/workspaces/${encodeURIComponent(
    workspaceId
  )}/members/me/sidebar-prefs`;
}

export function fetchSidebarPrefs(workspaceId: string): Promise<SidebarPrefs> {
  return settingsRequest<unknown>(sidebarPrefsPath(workspaceId)).then(
    sidebarPrefsFromWire
  );
}

/** 통째 교체(패치 아님). 서버가 저장한 것을 그대로 다시 읽어 돌려준다. */
export function putSidebarPrefs(
  workspaceId: string,
  prefs: SidebarPrefs
): Promise<SidebarPrefs> {
  return settingsRequest<unknown>(sidebarPrefsPath(workspaceId), {
    method: "PUT",
    body: JSON.stringify(sidebarPrefsToWire(prefs)),
  }).then(sidebarPrefsFromWire);
}

/** 이 워크스페이스의 사이드바 배치 쿼리 키. 부트스트랩 GET 과 저장이 함께 읽는다. */
export function sidebarPrefsQueryKey(workspaceId: string): [string, string] {
  return ["sidebar-prefs", workspaceId];
}
