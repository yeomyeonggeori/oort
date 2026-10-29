/**
 * 가짜 `fetch`. 시험이 가짜로 두는 것은 네트워크 하나뿐이고, 그 위의 훅·화면은 진짜다.
 *
 * 화면마다 라우트 표가 다르다(기존 시험의 `installFetch` 는 45가지 몸통이었다). 그래서
 * 여기는 표를 주지 않고 뼈대만 준다: 시험이 `route` 하나를 넘기면, 그 함수가 답한 요청만
 * 통과하고 답하지 않은 요청은 **던진다**(`unrouted request`). 시험이 모르는 요청을 조용히
 * 빈 응답으로 넘기면 화면이 엉뚱한 곳에서 멈추는데 원인이 보이지 않는다.
 */

/** 본문을 JSON 으로 돌려주는 응답. 코어의 HTTP 층이 읽는 `status`·`ok`·`text()` 만 가진다. */
export function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** 요청 하나에 답한다. `undefined` 면 이 라우트가 모르는 요청이다. */
export type FetchRoute = (
  url: string,
  init?: RequestInit,
) => Response | undefined | Promise<Response | undefined>;

function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

/**
 * `globalThis.fetch` 를 `route` 로 갈아 끼운다. 되돌리는 일은 시험의 몫이다
 * (`jest.restoreAllMocks()` 를 `afterEach` 에 둔 시험은 이미 한다).
 */
export function installFetch(route: FetchRoute): jest.Mock {
  const mock = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = urlOf(input);
    const answer = await route(url, init);
    if (answer === undefined) {
      throw new Error(`unrouted request: ${url}`);
    }
    return answer;
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

/** 주소에 `fragment` 가 든 호출이 몇 번이었나. */
export function callsTo(mock: jest.Mock, fragment: string): number {
  return mock.mock.calls.filter(([input]) => urlOf(input).includes(fragment)).length;
}
