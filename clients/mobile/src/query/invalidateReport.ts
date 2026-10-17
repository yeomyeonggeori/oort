import type {QueryClient, QueryKey} from '@tanstack/react-query';

// =============================================================================
// 무효화하고, 실패했는지까지 말해 주는 재조회 (#3962).
//
// `queryClient.invalidateQueries()` 는 쿼리가 **실패해도** 조용히 끝나고 `undefined` 로 답한다
// (재조회 오류는 쿼리 상태에만 남는다). 그래서 무효화로 「다시 읽기」를 만든 곳(키 접두사로 여러 쿼리를
// 한꺼번에 읽는 피드)은 호출자가 성공과 실패를 가를 수 없다. 당겨서 새로고침이 그런 곳에서 실패에
// 성공 햅틱을 냈다.
//
// 이 함수는 같은 무효화를 하고, 끝난 뒤 **그 접두사 아래의 활성 쿼리**가 오류 상태로 남았는지를 돌려준다.
// 모양은 `refreshFailed`(design/pullRefresh.ts)가 읽는 `{isError, status}` 와 같다.
// 활성 쿼리만 보는 이유: 무효화가 다시 읽는 것이 활성 쿼리뿐이라서다(관찰자 없는 쿼리의 옛 오류는
// 이번 재조회와 무관하다).
//
// `ignoreError` 는 **실패가 아닌 오류**를 걸러 낸다. 화면이 이미 「알려진 상태」로 말하는 오류가 그것이다:
// 예컨대 이 서버에는 그 경로가 없다(`serverSaysAbsent`)는 답은 화면이 미제공 상태로 접고 있는데, 당김이 그것을
// 실패로 읽으면 「화면이 말하는 것」과 「당기면 나오는 것」이 어긋난다. 이 도우미는 활성 쿼리 하나라도 걸러지지
// 않은 오류면 실패로 읽는다 — 화면이 「모두 실패」일 때만 오류로 말하는 피드(부분 실패는 알려진 상태)보다 엄격하다.
// =============================================================================

export interface InvalidateReport {
  status: 'success' | 'error';
  isError: boolean;
}

export interface InvalidateReportOptions {
  /** 참이면 그 오류는 실패로 세지 않는다. */
  ignoreError?: (error: unknown) => boolean;
}

export async function invalidateAndReport(
  client: QueryClient,
  keys: readonly QueryKey[],
  options: InvalidateReportOptions = {},
): Promise<InvalidateReport> {
  await Promise.all(keys.map(queryKey => client.invalidateQueries({queryKey})));
  const cache = client.getQueryCache();
  const isError = keys.some(queryKey =>
    cache
      .findAll({queryKey, type: 'active'})
      .some(
        query =>
          query.state.status === 'error' &&
          options.ignoreError?.(query.state.error) !== true,
      ),
  );
  return {status: isError ? 'error' : 'success', isError};
}
