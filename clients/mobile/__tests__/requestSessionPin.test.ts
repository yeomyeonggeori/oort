import * as coreApi from '@momo/core/lib/api';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {downloadAttachmentFile, resetAttachmentContentForTest} from '../src/features/attachments/content';
import {__resetMemberAvatarCache, loadMemberAvatar} from '../src/features/conversation/memberAvatarImage';
import {expressionTransport} from '../src/features/expressions/transport';
import {registerDevice} from '../src/push/devices';
import {__resetSessionStore, getAccessToken, getAuthExpired} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// #5816 — 폰이 직접 나르는 요청(첨부·사진 내려받기, 표현 올리기·내려받기, 푸시 등록)도 401 뒤에는 그 요청을
// 시작한 세션으로만 다시 보낸다. 다른 세션이 저장돼 있으면 그 자격으로 갱신하지도 다시 보내지도 않는다.
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const CH = '33333333-3333-4333-8333-333333333333';
const BASE = 'https://api.example.com';
const member = (id: string, displayName: string) => ({
  id,
  workspaceId: WS,
  kind: 'human',
  displayName,
  handle: displayName,
});
const DOHYEON = {
  accessToken: 'access-D1',
  refreshToken: 'refresh-D1',
  realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
  member: member('11111111-1111-4111-8111-1111111111d1', '김도현'),
};
const SEOYEON = {
  accessToken: 'access-S1',
  refreshToken: 'refresh-S1',
  realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
  member: member('11111111-1111-4111-8111-1111111111e1', '이서연'),
};

const fsModule = jest.requireMock('expo-file-system') as {
  File: {
    downloadFileAsync: (...args: unknown[]) => Promise<unknown>;
    prototype: {createUploadTask: (...args: unknown[]) => unknown};
  };
  __state: {downloads: {url: string; options: {headers?: Record<string, string>}}[]; uploads: {url: string; options: {headers?: Record<string, string>}}[]};
  __reset: () => void;
};

const reply = (status: number, body: unknown): Response =>
  ({status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body)}) as unknown as Response;

let fetchMock: jest.Mock<Promise<Response>, [string, RequestInit?]>;

/** 이서연의 값이 실린 요청·내려받기·올리기. */
function carriedBySeoyeon(): string[] {
  const fetched = fetchMock.mock.calls
    .filter(([, init]) => /-S1/.test(new Headers(init?.headers).get('Authorization') ?? '') || /-S1/.test(String(init?.body ?? '')))
    .map(([url]) => `fetch ${new URL(String(url)).pathname}`);
  const downloads = fsModule.__state.downloads
    .filter(d => /-S1/.test(d.options.headers?.Authorization ?? ''))
    .map(d => `download ${new URL(d.url).pathname}`);
  const uploads = fsModule.__state.uploads
    .filter(u => /-S1/.test(u.options.headers?.Authorization ?? ''))
    .map(u => `upload ${new URL(u.url).pathname}`);
  return [...fetched, ...downloads, ...uploads];
}

/** 같은 앱에서 로그아웃하고 이서연이 로그인한다. */
async function nextPersonSignsIn(): Promise<void> {
  void coreApi.logout();
  fetchMock.mockImplementationOnce(async () => reply(200, SEOYEON));
  await coreApi.login('seoyeon@example.test', 'pw');
}

beforeEach(async () => {
  __resetMemberAvatarCache();
  resetAttachmentContentForTest();
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase(BASE);
  fsModule.__reset();
  // 그 밖의 요청(로그아웃 등)은 200, 갱신은 이 시험이 쓰지 않는다 — 나가면 실패로 보인다.
  fetchMock = jest.fn(async (_url: string, _init?: RequestInit) => reply(200, {status: 'ok'}));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockImplementationOnce(async () => reply(200, DOHYEON));
  await coreApi.login('dohyeon@example.test', 'pw');
});

afterEach(() => {
  jest.restoreAllMocks();
  fsModule.__reset();
  __resetSessionStore();
  __resetServerBaseCache();
});

function expectNothingAsSeoyeon(): void {
  expect(carriedBySeoyeon()).toEqual([]);
  expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/v1/auth/refresh'))).toEqual([]);
  expect(getAccessToken()).toBe('access-S1');
  expect(getAuthExpired()).toBe(false);
}

/** 첫 내려받기는 그 사이 사람이 바뀐 뒤 401로 끝난다. */
function firstDownloadAnswers401AfterSwitch(): void {
  jest.spyOn(fsModule.File, 'downloadFileAsync').mockImplementationOnce(async (...args: unknown[]) => {
    const [url, , options] = args as [string, unknown, {headers?: Record<string, string>}];
    fsModule.__state.downloads.push({url, options});
    await nextPersonSignsIn();
    throw new Error('HTTP 401');
  });
}

it('첨부 내려받기', async () => {
  firstDownloadAnswers401AfterSwitch();
  await expect(
    downloadAttachmentFile(WS, CH, {id: 'att-1', name: '자료.pdf', mime: 'application/pdf', sizeBytes: 10}),
  ).rejects.toBeTruthy();
  expect(fsModule.__state.downloads).toHaveLength(1);
  expectNothingAsSeoyeon();
});

it('멤버 사진 내려받기', async () => {
  firstDownloadAnswers401AfterSwitch();
  await loadMemberAvatar(`/v1/workspaces/${WS}/members/${DOHYEON.member.id}/avatar/content?v=1`);
  expect(fsModule.__state.downloads).toHaveLength(1);
  expectNothingAsSeoyeon();
});

it('표현 그림 내려받기', async () => {
  firstDownloadAnswers401AfterSwitch();
  await expressionTransport
    .request({method: 'GET', path: `/v1/workspaces/${WS}/expressions/e1/image?v=1`})
    .catch(() => null);
  expect(fsModule.__state.downloads).toHaveLength(1);
  expectNothingAsSeoyeon();
});

it('표현 그림 올리기', async () => {
  jest.spyOn(fsModule.File.prototype, 'createUploadTask').mockImplementationOnce(function (this: unknown, ...args: unknown[]) {
    const [url, options] = args as [string, {headers?: Record<string, string>}];
    fsModule.__state.uploads.push({url, options});
    return {
      uploadAsync: async () => {
        await nextPersonSignsIn();
        return {body: '', headers: {}, status: 401};
      },
      cancel: () => {},
      release: () => {},
    };
  });
  await expressionTransport
    .request({
      method: 'POST',
      path: `/v1/workspaces/${WS}/expressions/uploads`,
      body: {name: 'wave'},
      file: {uri: 'file:///cache/wave.png', name: 'wave.png', mime: 'image/png'},
    })
    .catch(() => null);
  expect(fsModule.__state.uploads).toHaveLength(1);
  expectNothingAsSeoyeon();
});

it('푸시 등록', async () => {
  fetchMock.mockImplementationOnce(async () => {
    await nextPersonSignsIn();
    return reply(401, {error: {message: 'token has been revoked'}});
  });
  const outcome = await registerDevice({
    workspaceId: WS,
    deviceId: '44444444-4444-4444-8444-444444444444',
    apnsToken: 'ab'.repeat(32),
    env: 'sandbox',
    appBuild: '1',
  });
  expect(outcome.kind).toBe('unreachable');
  expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/devices'))).toHaveLength(1);
  expectNothingAsSeoyeon();
});
