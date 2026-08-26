import type { QueryClient, UseMutationOptions } from "@tanstack/react-query";

// =============================================================================
// 도어벨 등록 mutation 의 수명 (ADR-0171 / WD-2).
//
// PUT 본문에 sender key 가 실린다. 응답에는 마스킹만 온다. 그래서 이 키는
// 마법사의 자격증명 키(`HOSTED_CREDENTIAL_MUTATION_KEY`)와 **다르다** — 연결 탭이
// 언마운트되며 이 캐시를 비울 때 열려 있는 마법사의 일회성 값을 함께 지우면 안
// 된다.
//
// 쿼리 함수는 여기 없다. 투영은 이미 있는 커넥션 단건 GET 에 실리고, 그 옵션은
// `hostedDisconnectScope.ts` 가 모듈 스코프에서 만든다.
// =============================================================================

export const HOSTED_DOORBELL_MUTATION_KEY = [
  "hosted-agents",
  "doorbell",
] as const;

export const HOSTED_DOORBELL_MUTATION_SCOPE = {
  mutationKey: HOSTED_DOORBELL_MUTATION_KEY,
  gcTime: 0,
} satisfies Pick<UseMutationOptions, "mutationKey" | "gcTime">;

export function purgeHostedDoorbellMutations(client: QueryClient): number {
  const cache = client.getMutationCache();
  const held = cache.findAll({
    mutationKey: HOSTED_DOORBELL_MUTATION_KEY,
    exact: true,
  });
  for (const mutation of held) cache.remove(mutation);
  return held.length;
}
