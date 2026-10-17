import {login} from '@momo/core/lib/api';
import {NetworkError} from '@momo/core/lib/http';
import {coreSession} from '@momo/core/runtime/host';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {
  downloadAttachmentFile,
  resetAttachmentContentForTest,
} from '../src/features/attachments/content';
import {
  FAILURE_TTL_MS,
  __resetMemberAvatarCache,
  loadMemberAvatar,
} from '../src/features/conversation/memberAvatarImage';
import {
  __adoptPersisted,
  __resetSessionStore,
  getAuthExpired,
} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// #3997 — 아바타·첨부 다운로드의 갱신 실패는 거절일 때만 로그인 만료다.
//
// 폰의 두 다운로드 길은 네이티브 다운로더로 받아서 코어의 `authedResponse` 를 탈 수
// 없고, 그래서 401 뒤의 갱신을 스스로 읽어 왔다. boolean `refreshSession()` 이 `false`
// 이면(닿지 못함 포함) 스스로 `markAuthExpired()` 를 불렀고, 잠금 화면에서 돌아와
// 무선이 깨는 사이에 아바타 요청이 한꺼번에 나가는 바로 그 순간 로그아웃이 났다
// (#3993 이 코어에서 고친 것의 폰 쪽 사본). 이제 두 길은 코어의
// `rotateAfterUnauthorized` 를 부른다.
//
// 목은 `expo-file-system` 과 `fetch` 경계뿐이다. 코어 갱신, 폰의 세션 저장소, 호스트
// 포트는 진짜이고, 선언은 인증 게이트가 실제로 읽는 `getAuthExpired()` 로 본다.
//
// 헷갈리기 쉬운 곳 하나. 서버가 갱신을 **거절**하면 선언은 회전 자신이 이미 한다
// (`rotateOnce`). 그래서 「거절 뒤 선언」 단정만으로는 폰이 자기 선언 줄을 지워도 초록
// 으로 남는다. 폰의 줄이 **유일한 선언자**인 경우를 따로 둔다: 갱신 토큰이 없을 때(회전이
// 아예 일어나지 않는다)와, 갱신은 됐는데 새 토큰으로 받은 것도 401일 때(회전은 성공이다).
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const SELF = '11111111-1111-4111-8111-111111111111';
const CH = '33333333-3333-4333-8333-333333333333';
const BASE = 'https://api.example.com';

const LOGIN_BODY = {
  accessToken: 'access-token-1',
  refreshToken: 'refresh-token-1',
  realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
  member: {id: SELF, workspaceId: WS, kind: 'human', displayName: 'x', handle: 'x'},
};

const fsMock = jest.requireMock('expo-file-system') as {
  __state: {
    downloads: {url: string; options: {headers?: Record<string, string>}}[];
    failures: Error[];
  };
  __reset: () => void;
};
let fetchMock: jest.Mock<Promise<Response>, [string, RequestInit?]>;

const downloads = () => fsMock.__state.downloads;
const unauthorized = () => new Error('HTTP 401');

const refreshCalls = () =>
  fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/v1/auth/refresh'));

const reply = (status: number, body: unknown): Response =>
  ({
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  }) as unknown as Response;

const ROTATED = () =>
  reply(200, {accessToken: 'access-token-2', refreshToken: 'refresh-token-2'});
// 서버가 갱신 토큰을 보고 세션이 끝났다고 말하는 답(`auth_routes.rs` 의 refresh).
const REUSED = () =>
  reply(401, {error: {message: 'refresh token already used or revoked'}});

interface Subject {
  name: string;
  /** 같은 모양의 서로 다른 자원 하나를 받는다. `file` 은 파일을 얻었는지. */
  run: (index?: number) => Promise<{file: boolean; error: unknown}>;
  /** 실패를 호출자에게 던지는가(첨부), 삼켜서 `null` 로 접는가(아바타). */
  throws: boolean;
}

const avatar: Subject = {
  name: '멤버 아바타 (memberAvatarImage)',
  throws: false,
  run: async (index = 0) => {
    const uri = await loadMemberAvatar(
      `/v1/workspaces/${WS}/members/${SELF}/avatar/content?v=media-${index}`,
    );
    return {file: uri !== null, error: null};
  },
};

const attachment: Subject = {
  name: '첨부 (attachments/content)',
  throws: true,
  run: async (index = 0) => {
    try {
      await downloadAttachmentFile(WS, CH, {
        id: `att-${index}`,
        name: '배포-결과.pdf',
        mime: 'application/pdf',
        sizeBytes: 2048,
      });
      return {file: true, error: null};
    } catch (error) {
      return {file: false, error};
    }
  },
};

beforeEach(async () => {
  __resetMemberAvatarCache();
  resetAttachmentContentForTest();
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase(BASE);
  fsMock.__reset();
  fetchMock = jest.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockResolvedValueOnce(reply(200, LOGIN_BODY));
  await login('a@example.com', 'pw');
  fetchMock.mockClear();
});

afterEach(() => {
  jest.useRealTimers();
  fsMock.__reset();
  __resetSessionStore();
  __resetServerBaseCache();
});

describe.each([avatar, attachment])('$name', subject => {
  describe('갱신이 서버에 닿지 못하면 로그인 만료가 아니다', () => {
    function expectKept() {
      // 선언도, 자격증명 삭제도 없다. 갱신 토큰은 쓰이지 않았으니 다음 갱신이 같은 것을 낸다.
      expect(getAuthExpired()).toBe(false);
      expect(coreSession().getRefreshToken()).toBe('refresh-token-1');
      expect(coreSession().getAccessToken()).toBe('access-token-1');
      // 한 번 받으려 했고 한 번 갱신하려 했다. 다시 받지도 갱신을 되풀이하지도 않는다.
      expect(downloads()).toHaveLength(1);
      expect(refreshCalls()).toHaveLength(1);
    }

    it('연결이 끊겨 갱신 요청이 못 나가면 그 다운로드만 실패한다', async () => {
      fsMock.__state.failures = [unauthorized()];
      fetchMock.mockRejectedValueOnce(new TypeError('network down'));

      const result = await subject.run();

      expect(result.file).toBe(false);
      expectKept();
      if (subject.throws) {
        // 코어의 기존 연결 오류다: 새 문구가 없고, 그 문구는 401 로 읽히지 않는다.
        expect(result.error).toBeInstanceOf(NetworkError);
        expect((result.error as NetworkError).message).toMatch(/서버에 닿지 못했어요/);
      }
    });

    it.each([500, 503, 429, 408])(
      '갱신 서버가 %i 로 답해도 같다: 서버가 토큰을 보지 않았다',
      async status => {
        fsMock.__state.failures = [unauthorized()];
        fetchMock.mockResolvedValueOnce(reply(status, {error: {message: 'x'}}));

        const result = await subject.run();

        expect(result.file).toBe(false);
        expectKept();
      },
    );

    it('동시에 401 을 받은 다운로드들은 갱신 하나를 나눠 쓰고 모두 선언 없이 실패한다', async () => {
      fsMock.__state.failures = [unauthorized(), unauthorized()];
      fetchMock.mockRejectedValueOnce(new TypeError('network down'));

      const [first, second] = await Promise.all([subject.run(0), subject.run(1)]);

      expect(first.file).toBe(false);
      expect(second.file).toBe(false);
      expect(getAuthExpired()).toBe(false);
      expect(coreSession().getRefreshToken()).toBe('refresh-token-1');
      expect(refreshCalls()).toHaveLength(1);
    });

    it('닿지 못한 뒤 다음 다운로드는 다시 갱신해서 새 토큰으로 받는다', async () => {
      // 아바타는 실패를 30초 기억한다. 그 기억이 아니라 갱신이 다시 도는지를 보려고 시계를 넘긴다.
      jest.useFakeTimers({now: 1_000_000, doNotFake: ['setTimeout']});
      fsMock.__state.failures = [unauthorized()];
      fetchMock.mockRejectedValueOnce(new TypeError('network down'));
      expect((await subject.run()).file).toBe(false);

      jest.setSystemTime(1_000_000 + FAILURE_TTL_MS + 1);
      fsMock.__state.failures = [unauthorized()];
      fetchMock.mockResolvedValueOnce(ROTATED());
      expect((await subject.run()).file).toBe(true);

      expect(getAuthExpired()).toBe(false);
      expect(refreshCalls()).toHaveLength(2);
      // 첫 갱신은 닿지 못해 토큰이 쓰이지 않았으니 둘째 갱신이 같은 토큰을 낸다.
      const bodies = refreshCalls().map(([, init]) => JSON.parse(String(init?.body)));
      expect(bodies).toEqual([
        {refreshToken: 'refresh-token-1'},
        {refreshToken: 'refresh-token-1'},
      ]);
      expect(downloads()).toHaveLength(3);
      expect(downloads()[2].options.headers).toEqual({Authorization: 'Bearer access-token-2'});
    });
  });

  describe('서버가 세션을 끝냈다고 말하면 로그인 만료다', () => {
    it('갱신이 거절되면(재사용 탐지) 선언하고 그 다운로드는 실패한다', async () => {
      fsMock.__state.failures = [unauthorized()];
      fetchMock.mockResolvedValueOnce(REUSED());

      const result = await subject.run();

      expect(result.file).toBe(false);
      expect(getAuthExpired()).toBe(true);
      // 다시 받지도 갱신을 되풀이하지도 않는다.
      expect(downloads()).toHaveLength(1);
      expect(refreshCalls()).toHaveLength(1);
    });

    it('갱신 토큰이 없으면 갱신 요청 없이 선언한다 — 회전이 없으니 폰의 자기 줄만 선언할 수 있다', async () => {
      // 접근 토큰만 남고 갱신 토큰이 없다(다른 곳에서 로그아웃된 저장소를 다시 읽은 모양).
      __adoptPersisted(null);
      expect(coreSession().getRefreshToken()).toBeNull();
      fsMock.__state.failures = [unauthorized()];

      const result = await subject.run();

      expect(result.file).toBe(false);
      expect(refreshCalls()).toHaveLength(0);
      expect(getAuthExpired()).toBe(true);
    });

    it('갱신은 됐는데 새 토큰으로 받은 것도 401 이면 선언한다 — 회전은 성공이니 폰의 자기 줄만 선언할 수 있다', async () => {
      // 재사용 탐지로 계보가 쓸려 나가면 방금 받은 새 접근 토큰도 거절된다.
      fsMock.__state.failures = [unauthorized(), unauthorized()];
      fetchMock.mockResolvedValueOnce(ROTATED());

      const result = await subject.run();

      expect(result.file).toBe(false);
      expect(refreshCalls()).toHaveLength(1);
      expect(downloads()).toHaveLength(2);
      expect(getAuthExpired()).toBe(true);
    });
  });

  describe('갱신이 되면 새 토큰으로 한 번 다시 받는다', () => {
    it('선언 없이 파일을 얻는다', async () => {
      fsMock.__state.failures = [unauthorized()];
      fetchMock.mockResolvedValueOnce(ROTATED());

      const result = await subject.run();

      expect(result.file).toBe(true);
      expect(getAuthExpired()).toBe(false);
      expect(downloads()).toHaveLength(2);
      expect(downloads()[0].options.headers).toEqual({Authorization: 'Bearer access-token-1'});
      expect(downloads()[1].options.headers).toEqual({Authorization: 'Bearer access-token-2'});
    });
  });
});
