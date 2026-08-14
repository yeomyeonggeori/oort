import {
  getHostedConnection,
  listHostedConnections,
} from '@momo/core/features/hostedAgents/api';
import {parseHostedConnections} from '@momo/core/features/hostedAgents/model';
import {
  parseHostedConnectionDetail,
  type HostedConnectionDetail,
} from '@momo/core/features/hostedAgents/status';
import type {HostedAgentConnection} from '@momo/core/features/hostedAgents/model';
import {useQuery} from '@tanstack/react-query';

// =============================================================================
// 호스티드 연결의 두 읽기 (goal HAP-UX3 / #1359). 쓰기는 없다.
//
// ADR-0137 D3 keeps react-query hooks in the HOST, so this is the RN sibling of
// the web `features/hostedAgents/hostedCredentialScope.ts` — and, exactly as the
// other query modules do, **the query keys are the web client's, character for
// character**. The list key is the wizard's own list key; the detail key is the
// one UX2's web disconnect section uses (`connection-detail`), so a phone that
// re-reads after the desktop acted lands on the same cache line rather than a
// parallel one.
//
// ## 이 화면은 관전이다 — retry 도, 폴링도 조심한다
//
// 목록/단건 모두 `retry: false`. 이 표면의 403 은 「누가 볼 수 있는가」의 답이지
// 장애가 아니고(`isHostedOperatorDenied`), 기본 retry 는 그 답을 얻으려 두 번 더
// 왕복한다. 폴링은 걸지 않는다: 웹 마법사는 pairing→detected 전이를 기다리느라
// 폴링하지만, 이 화면은 그 전이를 **일으키는** 자리가 아니라 이미 일어난 것을
// 보는 자리다. 새로고침이 필요하면 당겨서 다시 읽는다.
//
// ## 아무것도 `fetch` 하지 않는다
//
// 모든 요청은 `@momo/core/features/hostedAgents/api` 를 지나고, 그 파일은 비밀값을
// 로그하지 않는 규율과 `no-store` 를 든다. 여기서 `fetch` 를 부르면 그 규율의 두
// 번째 답이 된다.
// =============================================================================

export const hostedKeys = {
  /** 웹 `hostedListQueryKey` 와 글자 그대로 같다. */
  connections: (workspaceId: string) =>
    ['hosted-agents', 'connections', workspaceId] as const,
  /** 웹(UX2) `hostedConnectionDetailQueryKey` 와 글자 그대로 같다. */
  detail: (workspaceId: string, connectionId: string) =>
    ['hosted-agents', 'connection-detail', workspaceId, connectionId] as const,
};

/**
 * 비밀값 없는 목록. owner/admin 이 아니면 403 이고, 그것은 화면이 문장으로 답한다.
 */
export function useHostedConnections(workspaceId: string) {
  return useQuery<HostedAgentConnection[]>({
    queryKey: hostedKeys.connections(workspaceId),
    queryFn: async () => parseHostedConnections(await listHostedConnections(workspaceId)),
    retry: false,
  });
}

/**
 * 단건 조회 — 커넥션 한 줄과 cleanup 장부 전체. 해제 전에는 장부가 빈 목록이다.
 */
export function useHostedConnection(workspaceId: string, connectionId: string) {
  return useQuery<HostedConnectionDetail>({
    queryKey: hostedKeys.detail(workspaceId, connectionId),
    queryFn: async () =>
      parseHostedConnectionDetail(await getHostedConnection(workspaceId, connectionId)),
    retry: false,
  });
}
