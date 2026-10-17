import {mintPushActionToken, PUSH_ACTION_TOKEN_PATH} from '../src/push/pushActionToken';

// =============================================================================
// #3931 — 잠금 화면 승인의 자격을 서버에서 받는 호출 (`POST /v1/auth/push-action-token`).
//
// 이 호출이 지키는 규율은 `pushFetchToken.ts` 와 같다: **어떤 실패에도 null** 이고, access
// 토큰으로 대신하지 않는다. 좁은 토큰을 받지 못한 폰은 잠금 화면에서 「…하지 못했어요 /
// 눌러서 앱에서 마무리해 주세요」라고 말한다 — 승인을 결정할 수 있는 더 센 토큰을 그 자리에 놓는
// 것보다 낫다.
// =============================================================================

const BASE = 'https://api.example.com';
const WS = '22222222-2222-4222-8222-222222222222';
const NOW = 1_800_000_000_000;

const mockFetch = jest.fn();
const mockSession = {access: 'access-token-1' as string | null};

jest.mock('@momo/core/lib/http', () => ({
  fetchWithDeadline: (...args: unknown[]) => mockFetch(...args),
}));
jest.mock('@momo/core/runtime/host', () => ({
  apiBase: () => 'https://api.example.com',
  coreSession: () => ({getAccessToken: () => mockSession.access}),
}));

function reply(status: number, body: unknown) {
  mockFetch.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

beforeEach(() => {
  mockFetch.mockReset();
  mockSession.access = 'access-token-1';
});

describe('토큰 받기', () => {
  it('POST /v1/auth/push-action-token 을 access bearer 로 부르고 응답을 그대로 돌려준다', async () => {
    reply(200, {token: 'tok', expiresAtMs: NOW, ttlSeconds: 21_600, workspaceId: WS});

    expect(await mintPushActionToken()).toEqual({
      token: 'tok',
      expiresAtMs: NOW,
      ttlSeconds: 21_600,
      workspaceId: WS,
    });
    expect(PUSH_ACTION_TOKEN_PATH).toBe('/v1/auth/push-action-token');
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`${BASE}/v1/auth/push-action-token`);
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer access-token-1');
  });

  it('세션이 없으면 요청하지 않는다', async () => {
    mockSession.access = null;

    expect(await mintPushActionToken()).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404, 409, 429, 500])(
    '상태 %i 는 null 이다 — access 토큰으로 대신하지 않는다',
    async status => {
      reply(status, {error: {message: 'no'}});

      expect(await mintPushActionToken()).toBeNull();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    },
  );

  it('오프라인(요청이 던짐)은 null 이다', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network request failed'));

    expect(await mintPushActionToken()).toBeNull();
  });

  it.each([
    ['토큰이 없다', {expiresAtMs: NOW, ttlSeconds: 1, workspaceId: WS}],
    ['토큰이 비었다', {token: '', expiresAtMs: NOW, ttlSeconds: 1, workspaceId: WS}],
    ['만료 시각이 없다', {token: 't', ttlSeconds: 1, workspaceId: WS}],
    ['수명이 0이다', {token: 't', expiresAtMs: NOW, ttlSeconds: 0, workspaceId: WS}],
    ['워크스페이스가 없다', {token: 't', expiresAtMs: NOW, ttlSeconds: 1}],
  ])('모양이 틀린 응답(%s)은 null 이다', async (_name, body) => {
    reply(200, body);

    expect(await mintPushActionToken()).toBeNull();
  });

  it('JSON 이 아닌 200 도 null 이다', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    });

    expect(await mintPushActionToken()).toBeNull();
  });
});
