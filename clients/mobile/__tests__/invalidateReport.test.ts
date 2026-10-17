import {QueryClient, QueryObserver} from '@tanstack/react-query';

import {invalidateAndReport} from '../src/query/invalidateReport';

// =============================================================================
// 무효화하고 실패까지 말해 주는 재조회 (#3962). 실제 QueryClient 로 잰다.
//
// `invalidateQueries()` 는 쿼리가 실패해도 `undefined` 로 조용히 끝난다. 이 도우미는 같은 무효화를 하고, 끝난 뒤
// 키 접두사 아래의 **활성** 쿼리가 오류 상태로 남았는지를 돌려준다.
//
// red proof (이 파일이 지키는 것):
//   - 오류 검사를 지우고 늘 success 로 답하면 → 「실패한 쿼리」가 붉다
//   - `type: 'active'` 를 지우면 → 「관찰자 없는 옛 오류는 이번 재조회와 무관하다」가 붉다
//   - 무효화를 빼면 → 「활성 쿼리를 다시 읽는다」가 붉다
// =============================================================================

/** gcTime 을 무한으로: 기본 5분 가비지 타이머가 남아 시험 프로세스가 끝나지 않는다. */
function newClient(): QueryClient {
  return new QueryClient({defaultOptions: {queries: {gcTime: Infinity}}});
}

function observe(client: QueryClient, key: readonly unknown[], fn: () => Promise<string>) {
  const observer = new QueryObserver(client, {queryKey: key, queryFn: fn, retry: false});
  return observer.subscribe(() => undefined);
}

describe('invalidateAndReport', () => {
  it('모두 성공하면 success', async () => {
    const client = newClient();
    const stop = observe(client, ['a', 'ws'], () => Promise.resolve('ok'));
    await expect(invalidateAndReport(client, [['a', 'ws']])).resolves.toEqual({status: 'success', isError: false});
    stop();
  });

  it('접두사 아래의 활성 쿼리가 실패하면 error 로 답한다 (invalidateQueries 만으로는 undefined)', async () => {
    const client = newClient();
    const stop = observe(client, ['a', 'ws', 'page-1'], () => Promise.reject(new Error('down')));
    // 같은 일을 무효화만으로 하면 결과가 없다: 호출자는 실패를 모른다.
    await expect(client.invalidateQueries({queryKey: ['a', 'ws']})).resolves.toBeUndefined();
    await expect(invalidateAndReport(client, [['a', 'ws']])).resolves.toEqual({status: 'error', isError: true});
    stop();
  });

  it('활성 쿼리를 다시 읽는다', async () => {
    const client = newClient();
    const fn = jest.fn(() => Promise.resolve('ok'));
    const stop = observe(client, ['a', 'ws'], fn);
    await new Promise(resolve => setTimeout(resolve, 0)); // 구독 때의 첫 읽기가 끝난다
    const before = fn.mock.calls.length;
    await invalidateAndReport(client, [['a', 'ws']]);
    expect(fn.mock.calls.length).toBe(before + 1);
    await invalidateAndReport(client, [['a', 'ws']]);
    expect(fn.mock.calls.length).toBe(before + 2);
    stop();
  });

  it('여러 접두사 중 하나라도 실패하면 error 다', async () => {
    const client = newClient();
    const stops = [
      observe(client, ['a', 'ws'], () => Promise.resolve('ok')),
      observe(client, ['b', 'ws'], () => Promise.reject(new Error('down'))),
    ];
    await expect(
      invalidateAndReport(client, [['a', 'ws'], ['b', 'ws']]),
    ).resolves.toEqual({status: 'error', isError: true});
    stops.forEach(stop => stop());
  });

  it('다른 접두사의 오류는 상관없다', async () => {
    const client = newClient();
    const stops = [
      observe(client, ['a', 'ws'], () => Promise.resolve('ok')),
      observe(client, ['other', 'ws'], () => Promise.reject(new Error('down'))),
    ];
    await expect(invalidateAndReport(client, [['a', 'ws']])).resolves.toEqual({status: 'success', isError: false});
    stops.forEach(stop => stop());
  });

  it('관찰자 없는 옛 오류는 이번 재조회와 무관하다 (무효화는 활성 쿼리만 다시 읽는다)', async () => {
    const client = newClient();
    await expect(
      client.fetchQuery({queryKey: ['a', 'ws'], queryFn: () => Promise.reject(new Error('old')), retry: false}),
    ).rejects.toThrow('old');
    expect(client.getQueryState(['a', 'ws'])?.status).toBe('error');
    await expect(invalidateAndReport(client, [['a', 'ws']])).resolves.toEqual({status: 'success', isError: false});
  });

  it('실패했던 쿼리가 다시 읽혀 성공하면 success 다', async () => {
    const client = newClient();
    let ok = false;
    const stop = observe(client, ['a', 'ws'], () => (ok ? Promise.resolve('ok') : Promise.reject(new Error('down'))));
    await expect(invalidateAndReport(client, [['a', 'ws']])).resolves.toMatchObject({isError: true});
    ok = true;
    await expect(invalidateAndReport(client, [['a', 'ws']])).resolves.toEqual({status: 'success', isError: false});
    stop();
  });
});
