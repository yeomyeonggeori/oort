import {login} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import type {RosterMember} from '@momo/core/lib/api';
import {act, cleanup, render, waitFor} from '@testing-library/react-native';
import React from 'react';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {Avatar} from '../src/features/conversation/Avatar';
import {
  FAILURE_TTL_MS,
  MAX_ENTRIES,
  __resetMemberAvatarCache,
  loadMemberAvatar,
} from '../src/features/conversation/memberAvatarImage';
import {__resetSessionStore} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// #3277 — 업로드된 멤버 아바타가 폰에 선다.
//
// 코어 `fetchMemberAvatar` 를 **가짜로 갈지 않는다**: 폰의 호스트(서버 주소·세션)
// 위에서 진짜 코어 경로가 베어러를 싣고 나가는지까지 `fetch` 경계에서 본다. 그래서
// 캐시가 깨져도(요청이 두 번 나감), 인가가 깨져도(헤더가 없음) 여기서 빨개진다.
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const SELF = '11111111-1111-4111-8111-111111111111';
const AGENT = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const PATH_A = `/v1/workspaces/${WS}/members/${SELF}/avatar/content?v=media-1`;
const PATH_B = `/v1/workspaces/${WS}/members/${SELF}/avatar/content?v=media-2`;
const BASE = 'https://api.example.com';

function member(over: Partial<RosterMember> & {id: string}): RosterMember {
  return {
    workspaceId: WS,
    kind: 'human',
    status: 'active',
    displayName: '곽성재',
    handle: 'seongjae',
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  } as RosterMember;
}

const dir = (avatarUrl?: string) =>
  makeDirectory([
    member({id: SELF, avatarUrl}),
    member({id: AGENT, kind: 'agent', displayName: '김인턴', avatarUrl}),
  ]);

const LOGIN_BODY = {
  accessToken: 'access-token-1',
  refreshToken: 'refresh-token-1',
  realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
  member: {id: SELF, workspaceId: WS, kind: 'human', displayName: 'x', handle: 'x'},
};

const DATA_URI = 'data:image/png;base64,AAAA';
let fetchMock: jest.Mock<Promise<Response>, [string, RequestInit?]>;
let readerResult: string | Error;

function installFileReader(): void {
  class FakeReader {
    result: string | null = null;
    error: Error | null = null;
    onloadend: (() => void) | null = null;
    readAsDataURL(): void {
      if (readerResult instanceof Error) this.error = readerResult;
      else this.result = readerResult;
      setTimeout(() => this.onloadend?.(), 0);
    }
  }
  (globalThis as unknown as {FileReader: unknown}).FileReader = FakeReader;
}

function avatarResponse(status: number): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    blob: async () => ({size: 4}) as unknown as Blob,
    text: async () => '',
  } as unknown as Response;
}

const authHeader = (init?: RequestInit): string | null =>
  (init?.headers as Headers | undefined)?.get('Authorization') ?? null;

const avatarCalls = () =>
  fetchMock.mock.calls.filter(([url]) => url.includes('/avatar/content'));

beforeEach(async () => {
  __resetMemberAvatarCache();
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase(BASE);
  readerResult = DATA_URI;
  installFileReader();
  fetchMock = jest.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockResolvedValueOnce({
    status: 200,
    ok: true,
    text: async () => JSON.stringify(LOGIN_BODY),
  } as unknown as Response);
  await login('a@example.com', 'pw');
  fetchMock.mockClear();
});

afterEach(() => {
  cleanup();
  jest.useRealTimers();
  __resetSessionStore();
  __resetServerBaseCache();
});

describe('멤버 아바타 받기', () => {
  it('서버 주소 + 경로로, 베어러를 싣고 받는다', async () => {
    fetchMock.mockResolvedValue(avatarResponse(200));
    await expect(loadMemberAvatar(PATH_A)).resolves.toBe(DATA_URI);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}${PATH_A}`);
    expect(authHeader(init)).toBe('Bearer access-token-1');
  });

  it('같은 ?v= 는 동시에 불러도·나중에 불러도 한 번만 받는다', async () => {
    fetchMock.mockResolvedValue(avatarResponse(200));
    await Promise.all([loadMemberAvatar(PATH_A), loadMemberAvatar(PATH_A)]);
    await loadMemberAvatar(PATH_A);
    expect(avatarCalls()).toHaveLength(1);
  });

  it('?v= 가 바뀌면(사진을 바꿈) 새로 받는다', async () => {
    fetchMock.mockResolvedValue(avatarResponse(200));
    await loadMemberAvatar(PATH_A);
    await loadMemberAvatar(PATH_B);
    expect(avatarCalls()).toHaveLength(2);
  });

  it('실패는 null 이고 잠깐은 다시 묻지 않으며, 지나면 다시 시도한다', async () => {
    jest.useFakeTimers({now: 1_000_000, doNotFake: ['setTimeout']});
    fetchMock.mockResolvedValue(avatarResponse(404));
    await expect(loadMemberAvatar(PATH_A)).resolves.toBeNull();
    await expect(loadMemberAvatar(PATH_A)).resolves.toBeNull();
    expect(avatarCalls()).toHaveLength(1);
    jest.setSystemTime(1_000_000 + FAILURE_TTL_MS + 1);
    fetchMock.mockResolvedValue(avatarResponse(200));
    await expect(loadMemberAvatar(PATH_A)).resolves.toBe(DATA_URI);
    expect(avatarCalls()).toHaveLength(2);
  });

  it('읽기 오류도 null 이다', async () => {
    readerResult = new Error('boom');
    fetchMock.mockResolvedValue(avatarResponse(200));
    await expect(loadMemberAvatar(PATH_A)).resolves.toBeNull();
  });

  it('임의 주소에는 베어러를 싣지 않는다(코어가 거절)', async () => {
    await expect(loadMemberAvatar('https://evil.example/x.png')).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('캐시는 상한을 넘으면 가장 오래 안 쓴 것부터 버린다', async () => {
    fetchMock.mockResolvedValue(avatarResponse(200));
    const p = (i: number) => `/v1/workspaces/${WS}/members/m${i}/avatar/content?v=1`;
    for (let i = 0; i <= MAX_ENTRIES; i += 1) await loadMemberAvatar(p(i));
    fetchMock.mockClear();
    await loadMemberAvatar(p(MAX_ENTRIES)); // 최근 것은 남아 있다
    expect(fetchMock).not.toHaveBeenCalled();
    await loadMemberAvatar(p(0)); // 가장 오래된 것은 밀려났다
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('Avatar 가 그린다', () => {
  const HIDDEN = {includeHiddenElements: true} as const;

  it('받는 동안·실패하면 이니셜, 도착하면 이미지 — 크기는 그대로', async () => {
    fetchMock.mockResolvedValue(avatarResponse(200));
    const view = render(<Avatar directory={dir(PATH_A)} memberId={SELF} />);
    expect(view.getByTestId('avatar-initial', HIDDEN)).toBeTruthy();
    const box = view.getByTestId('avatar-human', HIDDEN);
    const before = JSON.stringify(box.props.style);
    await waitFor(() => expect(view.getByTestId('avatar-image', HIDDEN)).toBeTruthy());
    expect(view.getByTestId('avatar-image', HIDDEN).props.source).toEqual({uri: DATA_URI});
    expect(JSON.stringify(view.getByTestId('avatar-human', HIDDEN).props.style)).toBe(before);
  });

  it('받기에 실패하면 이니셜이 남는다', async () => {
    fetchMock.mockResolvedValue(avatarResponse(404));
    const view = render(<Avatar directory={dir(PATH_A)} memberId={SELF} />);
    await act(async () => {
      await loadMemberAvatar(PATH_A);
    });
    expect(view.queryByTestId('avatar-image', HIDDEN)).toBeNull();
    expect(view.getByTestId('avatar-initial', HIDDEN)).toBeTruthy();
  });

  it('같은 사진의 아바타 여럿이 한 번만 받는다', async () => {
    fetchMock.mockResolvedValue(avatarResponse(200));
    const d = dir(PATH_A);
    const view = render(
      <>
        <Avatar directory={d} memberId={SELF} />
        <Avatar directory={d} memberId={SELF} size={48} />
      </>,
    );
    await waitFor(() => expect(view.getAllByTestId('avatar-image', HIDDEN)).toHaveLength(2));
    expect(avatarCalls()).toHaveLength(1);
  });

  it('옛 절대 avatarUrl 은 기존대로 uri 로 실리고 요청은 없다', () => {
    const view = render(
      <Avatar directory={dir(`${BASE}/legacy/me.png`)} memberId={SELF} />,
    );
    expect(view.getByTestId('avatar-image', HIDDEN).props.source).toEqual({
      uri: `${BASE}/legacy/me.png`,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('에이전트는 사진이 있어도 둥근 사각이다', async () => {
    const agentPath = `/v1/workspaces/${WS}/members/${AGENT}/avatar/content?v=m`;
    fetchMock.mockResolvedValue(avatarResponse(200));
    const view = render(<Avatar directory={dir(agentPath)} memberId={AGENT} />);
    await waitFor(() => expect(view.getByTestId('avatar-image', HIDDEN)).toBeTruthy());
    expect(view.getByTestId('avatar-agent', HIDDEN)).toBeTruthy();
  });
});
