import type { QueryClient, UseMutationOptions } from "@tanstack/react-query";

// =============================================================================
// 일회성 웹훅 비밀값이 화면보다 오래 사는 것을 막는다 (#1205 리뷰 B1).
//
// ## 무엇이 새고 있었나 (실측)
//
// 발급·회전은 mutation 이고, mutation 의 결과는 **MutationCache** 에 남는다. 그
// 캐시는 `src/app/queryClient.ts` 의 모듈 싱글턴이 소유하므로 라우트가 아니라
// 세션 수명을 갖는다. 관찰자(컴포넌트)가 떨어져 나가도 사라지지 않는다:
// `Mutation.removeObserver` 는 즉시 삭제가 아니라 `scheduleGc()` 를 부르고,
// `Removable` 의 기본 gcTime 은 브라우저에서 5분(300000ms)이다.
//
//   mounted       : ['{"keyId":"k1","secret":"whsec_THE_ONE_TIME_SECRET"}']
//   after unmount : ['{"keyId":"k1","secret":"whsec_THE_ONE_TIME_SECRET"}']
//   gcTime(ms)    : 300000
//
// 즉 「저장했습니다」를 누르지 않고 섹션을 옮기거나 설정을 닫은 사람은, 서버가
// 원문으로 보관하지 않기로 한 값을 앱 메모리에 5분간 남긴 채 떠났다. 지울 방법도
// 화면에 없었다.
//
// ## 규율
//
// 비밀값을 실어 나르는 mutation 은 **반드시** `CREDENTIAL_MUTATION_SCOPE` 를
// 펼쳐 넣는다. 그러면 두 가지가 동시에 성립한다:
//
//   - `gcTime: 0` — 마지막 관찰자가 떨어지는 순간 회수 대상이 된다. 5분이 0이 된다.
//   - `mutationKey` — 세션 전체에서 이 값들만 골라낼 수 있는 이름이 생긴다. 그게
//     `purgeWebhookCredentials` 가 정확히 이것만 지우고 다른 표면의 mutation 은
//     건드리지 않는 근거다.
//
// 그리고 언마운트에서 `purgeWebhookCredentials` 를 부른다. gcTime 0 은 다음
// 매크로태스크를 기다리지만 이쪽은 **동기적으로** 지우므로, 틱 하나의 창도 남지
// 않는다. 둘 다 두는 이유는 하나가 빠져도 다른 하나가 남기 때문이다.
//
// 이 파일이 컴포넌트 밖에 있는 이유: 이 스위트는 DOM 없이 도는 node 환경이라
// 렌더로는 이 보장을 재지 못한다. 캐시를 상대로 하는 순수 함수라면 진짜
// MutationCache 를 세워 **누수를 재현하고 해소되는 것까지** 단정할 수 있고,
// 그게 webhookCredentialScope.test.ts 다.
// =============================================================================

/**
 * 이 키를 단 mutation 은 응답 본문에 원문 비밀값이 들어 있다고 선언한다.
 * (openapi `createWebhookInstallation` / `rotateWebhookSecret` 둘뿐이다.)
 */
export const WEBHOOK_CREDENTIAL_MUTATION_KEY = [
  "settings",
  "webhooks",
  "credential",
] as const;

/** 비밀값을 실어 나르는 mutation 이 지켜야 하는 옵션. 펼쳐 넣는다. */
export const CREDENTIAL_MUTATION_SCOPE = {
  mutationKey: WEBHOOK_CREDENTIAL_MUTATION_KEY,
  // 기본값은 브라우저에서 300000, 서버 환경에서는 Infinity 다. 둘 다 이 값에는
  // 너무 길다: 일회성 비밀값의 올바른 수명은 "그것을 보여주던 화면과 같다"이다.
  gcTime: 0,
} satisfies Pick<UseMutationOptions, "mutationKey" | "gcTime">;

/**
 * 캐시에 남은 일회성 웹훅 비밀값을 전부 지운다.
 *
 * 전역이 아니라 위 키로 좁힌다: 설정 셸에는 다른 표면의 mutation 도 살아 있고,
 * 비밀값 하나를 지우자고 남의 진행 상태를 날리는 것은 다른 종류의 결함이다.
 * 전체 함수이고 멱등이다 — 지울 것이 없으면 0을 돌려준다.
 *
 * @returns 지운 mutation 수. 테스트가 "정말 있었고 정말 사라졌다"를 잴 수 있게.
 */
export function purgeWebhookCredentials(client: QueryClient): number {
  const cache = client.getMutationCache();
  const held = cache.findAll({
    mutationKey: WEBHOOK_CREDENTIAL_MUTATION_KEY,
    exact: true,
  });
  for (const mutation of held) cache.remove(mutation);
  return held.length;
}
