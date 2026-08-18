import type { QueryClient } from "@tanstack/react-query";
import { getHostedConnection } from "@momo/core/features/hostedAgents/api";
import { parseHostedConnectionDetail } from "@momo/core/features/hostedAgents/disconnect";
import {
  hostedConnectionQueryKey,
  hostedListQueryKey,
} from "./hostedCredentialScope";

// =============================================================================
// 해제 화면의 쿼리 옵션 (HAP-UX2 / #1362).
//
// 규율은 옆 파일(`hostedCredentialScope.ts`)에서 그대로 가져온다: **쿼리 옵션은
// 모듈 스코프에서만 만든다.** 이 표면에는 원문 비밀값이 오지 않지만 규율을 낮추지
// 않는 이유는 두 가지다. 같은 폴더의 두 파일이 서로 다른 규율을 갖고 있으면 다음
// 사람은 어느 쪽이 규칙인지 알 수 없고, 이 화면은 마법사와 **같은 캐시**를
// 공유한다 — 여기서 만든 클로저가 그 캐시에 얹히면 마법사의 렌더 스코프가 함께
// 산다.
//
// ## 왜 마법사와 다른 키인가
//
// 같은 URL(`GET …/hosted-agent-connections/{id}`)을 두 화면이 읽지만 서로 다른
// 것을 읽는다:
//
//   - 마법사는 **상태 한 줄**을 5초마다 되묻는다(감지·증명은 남이 일으킨다).
//   - 이 화면은 **정리 장부 전체**를 읽고, 되물을 일이 없다 — 여기서 다음 수를
//     두는 것은 화면 앞의 사람이고, 그 사람의 저장은 응답을 직접 들고 온다.
//
// 파서를 하나로 합치면 마법사의 폴링이 매 5초마다 쓰지 않을 목록을 파싱하고,
// 폴링을 합치면 이 화면이 사람이 타이핑하는 동안 5초마다 폼 아래 목록을 갈아
// 끼운다. 그래서 키를 나누고, **쓰는 쪽에서 둘 다 무효화한다**
// (`invalidateHostedConnection`). 둘 중 하나만 무효화하는 것이 이 분리의 유일한
// 실패 모드이므로 그 일을 손으로 하지 않고 함수 하나에 맡긴다.
// =============================================================================

export function hostedConnectionDetailQueryKey(
  workspaceId: string,
  connectionId: string
) {
  return ["hosted-agents", "connection-detail", workspaceId, connectionId] as const;
}

/**
 * 커넥션 + 정리 목록. 되묻지 않는다.
 *
 * 돌려주는 `queryFn` 이 붙잡는 것은 이 팩토리의 인자 둘뿐이다.
 */
export function hostedConnectionDetailQuery(
  workspaceId: string,
  connectionId: string
) {
  return {
    queryKey: hostedConnectionDetailQueryKey(workspaceId, connectionId),
    queryFn: async () =>
      parseHostedConnectionDetail(
        await getHostedConnection(workspaceId, connectionId)
      ),
    // 403 은 "누가 할 수 있는가"의 답이지 일시 오류가 아니다.
    retry: false,
  };
}

/**
 * 이 연결에 대한 캐시를 전부 낡은 것으로 표시한다.
 *
 * 셋을 함께 다루는 이유: 해제는 목록의 상태 칩(`hosted-agents/connections`),
 * 마법사의 단건(`hosted-agents/connection`), 이 화면의 장부
 * (`hosted-agents/connection-detail`)를 동시에 낡게 만든다. 하나를 빼먹으면 다른
 * 탭이 이미 폐기된 연결을 활성으로 그린다.
 */
export function invalidateHostedConnection(
  client: QueryClient,
  workspaceId: string,
  connectionId: string
): void {
  void client.invalidateQueries({
    queryKey: hostedConnectionDetailQueryKey(workspaceId, connectionId),
  });
  void client.invalidateQueries({
    queryKey: hostedConnectionQueryKey(workspaceId, connectionId),
  });
  void client.invalidateQueries({ queryKey: hostedListQueryKey(workspaceId) });
}
