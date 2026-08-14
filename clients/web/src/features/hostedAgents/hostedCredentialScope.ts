import type { QueryClient, UseMutationOptions } from "@tanstack/react-query";
import {
  getHostedConnection,
  listHostedConnections,
} from "@momo/core/features/hostedAgents/api";
import {
  parseHostedConnection,
  parseHostedConnections,
} from "@momo/core/features/hostedAgents/model";
import { fetchWorkspace } from "@momo/core/features/settings/api";

// =============================================================================
// 호스티드 연결의 일회성 비밀값 둘을, 그 값을 보여준 화면의 수명에 묶는다.
//
// 규율은 발명이 아니라 인용이다 — features/settings/webhookCredentialScope.ts 가
// 힙 스냅샷으로 찾아낸 리테이너 경로가 그대로 여기에도 있다:
//
//   Window → DOMTimer → [closure] → 목록/단건 Query
//     → options.queryFn ← **컴포넌트 안에서 만든 인라인 클로저**
//       → 그 클로저의 컨텍스트(= 렌더 스코프)
//         → revealed.pairingCredential / revealed.credential
//
// V8 은 한 함수 호출의 컨텍스트를 하나 만들므로, 렌더 스코프의 클로저 중 **아무
// 하나**만 세션 수명 캐시에 얹혀도 그 렌더가 본 것 전부가 함께 산다. 그래서 규율은
// "비밀값을 넘기지 마라"가 아니라 이것이다:
//
//   **세션 수명 캐시에는 이 표면의 렌더 스코프에서 태어난 클로저를 얹지 않는다.**
//
// 이 표면은 웹훅보다 한 가지가 더 나쁘다: 비밀값이 **둘**이고 서로 다른 시점에
// 뜬다(연결 값과 active 자격증명). 그래서 두 값을 나르는 mutation 셋(create,
// regenerate, confirm)이 전부 같은 키를 달고 함께 지워진다.
//
// ## 폴링이 이 파일에 사는 이유
//
// 감지와 증명은 **다른 프로세스가** 일으키는 사건이고 이 서버에는 그 전이를 실어
// 나르는 realtime 채널이 없다(Centrifugo 는 채널·에이전트 turn 만 싣는다). 그래서
// 마법사는 단건 조회를 되묻는다. 그 간격을 컴포넌트가 아니라 여기서 정하는 이유도
// 같다: `queryFn` 이 렌더 스코프를 캡처하지 않게 하려면 옵션 전체가 모듈 스코프에서
// 나와야 한다.
// =============================================================================

/** 기다리는 동안의 되묻는 간격. 사람의 인내와 서버 부하 사이의 값이다. */
export const HOSTED_POLL_MS = 5_000;

export function hostedListQueryKey(workspaceId: string) {
  return ["hosted-agents", "connections", workspaceId] as const;
}

/**
 * 목록 쿼리 옵션. **모듈 스코프에서만 만든다.**
 *
 * 돌려주는 `queryFn` 이 붙잡는 것은 이 팩토리의 인자(`workspaceId`) 하나뿐이라,
 * 그 쿼리가 자기 gcTime 을 다 살아도 함께 사는 것은 문자열 하나다.
 */
export function hostedListQuery(workspaceId: string) {
  return {
    queryKey: hostedListQueryKey(workspaceId),
    queryFn: async () =>
      parseHostedConnections(await listHostedConnections(workspaceId)),
    // 403 은 "누가 할 수 있는가"를 그리는 분기이지 일시 오류가 아니다.
    retry: false,
  };
}

export function hostedConnectionQueryKey(
  workspaceId: string,
  connectionId: string
) {
  return ["hosted-agents", "connection", workspaceId, connectionId] as const;
}

/**
 * 단건 쿼리 옵션. 같은 이유로 모듈 스코프에서 만든다.
 *
 * @param polling 지금 남의 프로세스를 기다리는 중인가. 기다리지 않을 때까지 계속
 *   되묻는 것은 서버에게도 사람에게도 소음이라, 대기 구간에서만 켠다.
 */
export function hostedConnectionQuery(
  workspaceId: string,
  connectionId: string,
  polling: boolean
) {
  return {
    queryKey: hostedConnectionQueryKey(workspaceId, connectionId),
    queryFn: async () =>
      parseHostedConnection(await getHostedConnection(workspaceId, connectionId)),
    refetchInterval: polling ? HOSTED_POLL_MS : (false as const),
    retry: false,
  };
}

/**
 * 워크스페이스 이름 하나를 읽는 쿼리. routine 이름이 그 이름을 쓴다.
 *
 * 키는 설정·사이드바가 이미 쓰는 것과 같아서 캐시를 나눠 쓰고, 옵션은 같은 이유로
 * 모듈 스코프에서 만든다: 이 표면의 렌더 스코프에서 태어난 `queryFn` 은 그 렌더가
 * 본 비밀값까지 함께 붙잡는다.
 */
export function hostedWorkspaceQuery(workspaceId: string) {
  return {
    queryKey: ["settings", "workspace", workspaceId] as const,
    queryFn: () => fetchWorkspace(workspaceId),
    retry: false,
  };
}

/**
 * 이 키를 단 mutation 은 일회성 비밀값의 수명 규율 아래 있다고 선언한다.
 *
 * 셋 다 응답 본문에 원문을 담는다(create·regenerate 는 연결 값, confirm 은 active
 * 자격증명). 하나라도 빼면 그 하나가 나머지의 렌더 스코프를 붙잡는다.
 */
export const HOSTED_CREDENTIAL_MUTATION_KEY = [
  "hosted-agents",
  "credential",
] as const;

/** 이 표면의 mutation 이 지켜야 하는 옵션. 펼쳐 넣는다. */
export const HOSTED_CREDENTIAL_MUTATION_SCOPE = {
  mutationKey: HOSTED_CREDENTIAL_MUTATION_KEY,
  // 기본값은 브라우저에서 300000. 일회성 비밀값의 올바른 수명은 "그것을 보여주던
  // 화면과 같다"이다.
  gcTime: 0,
} satisfies Pick<UseMutationOptions, "mutationKey" | "gcTime">;

/**
 * 캐시에 남은 이 표면의 mutation 을 전부 지운다 — 본문과, 그 본문이 사는 스코프를
 * 붙잡고 있는 클로저까지. 전체 함수이고 멱등이다.
 *
 * @returns 지운 mutation 수. 테스트가 "정말 있었고 정말 사라졌다"를 잴 수 있게.
 */
export function purgeHostedCredentials(client: QueryClient): number {
  const cache = client.getMutationCache();
  const held = cache.findAll({
    mutationKey: HOSTED_CREDENTIAL_MUTATION_KEY,
    exact: true,
  });
  for (const mutation of held) cache.remove(mutation);
  return held.length;
}
