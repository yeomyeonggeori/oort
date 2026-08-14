import { useMemo } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { fetchWorkTierPolicy } from "@momo/core/features/settings/api";
import {
  resolveExecutionTierAxis,
  type ExecutionTierAxis,
  type TierReadState,
} from "@momo/core/features/routing/tierAxis";
import { useSession } from "@/app/session";
import { useWorkHosts } from "@/features/work/useWorkSessions";

// =============================================================================
// 컴포저 라우팅 스트립이 실행 위치에 대해 아는 것 (CRUN-1 / 이슈 1382).
//
// 판정과 문구는 전부 코어(`features/routing/tierAxis.ts`)에 있고, 여기서 하는
// 일은 두 개의 실제 REST를 그 함수의 입력 모양으로 옮기는 것뿐이다.
//
//   GET .../work-hosts            등록기 (ADR-0125 D1)
//   GET .../work-tier-policy/me   이 사람에게 걸려 있는 정책 (ADR-0125 D11)
//
// **프로브가 아니다.** 모델·강도 축의 `probeSendRouting`은 부작용 없는 물음이지만
// 어쨌든 쓰기 표면을 두드리는 것이라 [이번만 바꾸기]를 누를 때까지 미룬다
// (capability.ts). 이 둘은 그냥 워크스페이스 상태 읽기이고, 접힌 줄의 요약이
// 이미 상속 티어를 말해야 하므로 줄이 서 있는 동안 계속 필요하다. 그래서 펼침을
// 기다리지 않는다 — "상속값 상시 표기"의 값이다.
//
// 캐시 키는 둘 다 **다른 화면이 이미 쓰는 키 그대로**다. 등록기는 작업 패널의
// `useWorkHosts`, 정책은 설정의 「호스트 상실 시 재개」 블록이 쓰는 키다. 새 키를
// 파면 같은 워크스페이스에 대해 두 벌의 답이 캐시에 남고, 두 화면이 서로 다른
// 시점의 사실을 말하게 된다.
// =============================================================================

/**
 * 쿼리 하나의 상태를 코어가 읽는 세 갈래로.
 *
 * 아직 못 물어본 것과 못 읽은 것을 한 칸에 넣지 않는다: 앞의 것은 기다리라는 말이고
 * 뒤의 것은 확인하지 못했다는 말이라, 사람에게 주는 다음 행동이 다르다.
 */
function readState(query: UseQueryResult<unknown, unknown>): TierReadState {
  if (query.isPending) return "pending";
  if (query.isError) return "unreadable";
  return "ready";
}

export function useExecutionTierAxis(): ExecutionTierAxis {
  const { workspaceId } = useSession();
  const hosts = useWorkHosts(workspaceId);
  // 워크스페이스 기본값이 아니라 `/me`다. 그 응답은 멤버 오버라이드가 없으면
  // `inherited: true`와 함께 **지금 실제로 걸려 있는 값**을 돌려주므로, 한 번의
  // 읽기로 이 사람에게 적용되는 정책이 나온다. 워크스페이스 기본값 경로는
  // owner/admin이 아니면 403이라 이 줄이 쓸 수 있는 물음이 아니다.
  const policy = useQuery({
    queryKey: ["settings", "work-tier-policy", workspaceId, "member"],
    queryFn: () => fetchWorkTierPolicy(workspaceId, "member"),
    retry: false,
    staleTime: 60_000,
  });

  const hostsState = readState(hosts);
  const policyState = readState(policy);
  const hostRows = hosts.data;
  const policyRow = policy.data;

  return useMemo(
    () =>
      resolveExecutionTierAxis({
        hostsState,
        hosts: hostRows ?? [],
        policyState,
        policy: policyRow ?? null,
      }),
    [hostsState, hostRows, policyState, policyRow]
  );
}
