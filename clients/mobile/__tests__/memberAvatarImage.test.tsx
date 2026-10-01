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
  MAX_DISK_BYTES,
  __resetMemberAvatarCache,
  clearMemberAvatarCache,
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

const fsMock = jest.requireMock('expo-file-system') as {
  __files: Set<string>;
  __state: {
    downloads: {url: string; destination: {uri: string}; options: {headers?: Record<string, string>}}[];
    downloadBytes: number;
    failures: Error[];
    failure: Error | null;
  };
  __reset: () => void;
};
let fetchMock: jest.Mock<Promise<Response>, [string, RequestInit?]>;

const downloads = () => fsMock.__state.downloads;
const isFile = (uri: unknown) => typeof uri === 'string' && uri.startsWith('file://');

beforeEach(async () => {
  __resetMemberAvatarCache();
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase(BASE);
  fsMock.__reset();
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
  fsMock.__reset();
  __resetSessionStore();
  __resetServerBaseCache();
});

const pathN = (i: number) => `/v1/workspaces/${WS}/members/m${i}/avatar/content?v=1`;
const unauthorized = () => new Error('HTTP 401');

describe('멤버 아바타 받기 — 디스크 파일 캐시', () => {
  it('서버 주소 + 경로를 베어러와 함께 받아 file:// 주소를 준다', async () => {
    const uri = await loadMemberAvatar(PATH_A);
    expect(isFile(uri)).toBe(true);
    expect(downloads()).toHaveLength(1);
    expect(downloads()[0].url).toBe(`${BASE}${PATH_A}`);
    expect(downloads()[0].options.headers).toEqual({Authorization: 'Bearer access-token-1'});
    expect(fsMock.__files.has(uri as string)).toBe(true);
  });

  it('같은 ?v= 는 동시에도 나중에도 한 번만 받는다', async () => {
    const [a, b] = await Promise.all([loadMemberAvatar(PATH_A), loadMemberAvatar(PATH_A)]);
    await loadMemberAvatar(PATH_A);
    expect(a).toBe(b);
    expect(downloads()).toHaveLength(1);
  });

  it('?v= 가 바뀌면 다른 파일로 새로 받는다', async () => {
    const a = await loadMemberAvatar(PATH_A);
    const b = await loadMemberAvatar(PATH_B);
    expect(a).not.toBe(b);
    expect(downloads()).toHaveLength(2);
  });

  it('앱을 다시 켠 뒤에도 디스크에 남은 파일을 다시 받지 않는다', async () => {
    const first = await loadMemberAvatar(PATH_A);
    __resetMemberAvatarCache(); // 프로세스 재시작: 메모리만 사라진다
    await expect(loadMemberAvatar(PATH_A)).resolves.toBe(first);
    expect(downloads()).toHaveLength(1);
  });

  it('401 이면 갱신 후 한 번 다시 받는다', async () => {
    fsMock.__state.failures = [unauthorized()];
    fetchMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      text: async () =>
        JSON.stringify({...LOGIN_BODY, accessToken: 'access-token-2', refreshToken: 'refresh-token-2'}),
    } as unknown as Response);
    const uri = await loadMemberAvatar(PATH_A);
    expect(isFile(uri)).toBe(true);
    expect(downloads()).toHaveLength(2);
    expect(downloads()[1].options.headers).toEqual({Authorization: 'Bearer access-token-2'});
  });

  it('실패는 null 이고 잠깐은 다시 묻지 않으며, 지나면 다시 시도한다', async () => {
    jest.useFakeTimers({now: 1_000_000, doNotFake: ['setTimeout']});
    fsMock.__state.failures = [new Error('HTTP 404')];
    await expect(loadMemberAvatar(PATH_A)).resolves.toBeNull();
    await expect(loadMemberAvatar(PATH_A)).resolves.toBeNull();
    expect(downloads()).toHaveLength(1);
    jest.setSystemTime(1_000_000 + FAILURE_TTL_MS + 1);
    expect(isFile(await loadMemberAvatar(PATH_A))).toBe(true);
    expect(downloads()).toHaveLength(2);
  });

  it('임의 주소에는 베어러를 싣지 않는다', async () => {
    await expect(loadMemberAvatar('https://evil.example/x.png')).resolves.toBeNull();
    expect(downloads()).toHaveLength(0);
  });

  it('디스크 총량 상한을 넘으면 가장 오래 안 쓴 파일부터 지운다', async () => {
    fsMock.__state.downloadBytes = MAX_DISK_BYTES / 4 + 1; // 4장이면 상한 초과
    const uris: (string | null)[] = [];
    for (let i = 0; i < 4; i += 1) uris.push(await loadMemberAvatar(pathN(i)));
    expect(fsMock.__files.has(uris[0] as string)).toBe(false); // 가장 오래된 것
    for (const kept of uris.slice(1)) expect(fsMock.__files.has(kept as string)).toBe(true);
    await loadMemberAvatar(pathN(0)); // 지워졌으니 다시 받는다
    expect(downloads()).toHaveLength(5);
  });

  it('받는 도중 비우면 끝난 뒤 파일이 없고 결과는 null 이다', async () => {
    const pending = loadMemberAvatar(PATH_A);
    clearMemberAvatarCache();
    await expect(pending).resolves.toBeNull();
    expect([...fsMock.__files].filter(u => u.includes('oort-member-avatars'))).toHaveLength(0);
    // 비운 뒤의 새 요청은 정상으로 받는다.
    expect(isFile(await loadMemberAvatar(PATH_A))).toBe(true);
  });

  it('비우기는 메모리 색인과 디스크 파일을 모두 지운다', async () => {
    const uri = await loadMemberAvatar(PATH_A);
    clearMemberAvatarCache();
    expect(fsMock.__files.has(uri as string)).toBe(false);
    await loadMemberAvatar(PATH_A);
    expect(downloads()).toHaveLength(2);
  });
});

describe('Avatar 가 그린다', () => {
  const HIDDEN = {includeHiddenElements: true} as const;

  it('받는 동안 이니셜, 도착하면 file:// 이미지 — 상자 크기는 그대로', async () => {
    const view = render(<Avatar directory={dir(PATH_A)} memberId={SELF} />);
    expect(view.getByTestId('avatar-initial', HIDDEN)).toBeTruthy();
    const before = JSON.stringify(view.getByTestId('avatar-human', HIDDEN).props.style);
    await waitFor(() => expect(view.getByTestId('avatar-image', HIDDEN)).toBeTruthy());
    expect(isFile(view.getByTestId('avatar-image', HIDDEN).props.source.uri)).toBe(true);
    expect(JSON.stringify(view.getByTestId('avatar-human', HIDDEN).props.style)).toBe(before);
  });

  it('받기에 실패하면 이니셜이 남는다', async () => {
    fsMock.__state.failures = [new Error('HTTP 404')];
    const view = render(<Avatar directory={dir(PATH_A)} memberId={SELF} />);
    await act(async () => {
      await loadMemberAvatar(PATH_A);
    });
    expect(view.queryByTestId('avatar-image', HIDDEN)).toBeNull();
    expect(view.getByTestId('avatar-initial', HIDDEN)).toBeTruthy();
  });

  it('같은 사진의 아바타 여럿이 한 번만 받는다', async () => {
    const d = dir(PATH_A);
    const view = render(
      <>
        <Avatar directory={d} memberId={SELF} />
        <Avatar directory={d} memberId={SELF} size={48} />
      </>,
    );
    await waitFor(() => expect(view.getAllByTestId('avatar-image', HIDDEN)).toHaveLength(2));
    expect(downloads()).toHaveLength(1);
  });

  it('같은 컴포넌트에서 memberId 만 바꾸면 앞 사람의 사진이 한 프레임도 안 나온다', async () => {
    const OTHER = '33333333-3333-4333-8333-333333333333';
    const otherPath = `/v1/workspaces/${WS}/members/${OTHER}/avatar/content?v=9`;
    const d = makeDirectory([
      member({id: SELF, avatarUrl: PATH_A}),
      member({id: OTHER, displayName: '박지민', avatarUrl: otherPath}),
    ]);
    const view = render(<Avatar directory={d} memberId={SELF} />);
    await waitFor(() => expect(view.getByTestId('avatar-image', HIDDEN)).toBeTruthy());
    const selfUri = view.getByTestId('avatar-image', HIDDEN).props.source.uri;

    // 같은 Avatar 원소에서 memberId 만 바꾼다(DM A→B). act 가 effect 까지 돌린 뒤라도
    // 새 사람의 파일이 오기 전에는 앞 사람 사진이 아니라 이니셜이어야 한다.
    fsMock.__state.failures = [];
    view.rerender(<Avatar directory={d} memberId={OTHER} />);
    expect(view.queryByTestId('avatar-image', HIDDEN)?.props.source.uri).not.toBe(selfUri);
    expect(view.getByTestId('avatar-initial', HIDDEN)).toBeTruthy();
    await waitFor(() => expect(view.getByTestId('avatar-image', HIDDEN)).toBeTruthy());
    expect(view.getByTestId('avatar-image', HIDDEN).props.source.uri).not.toBe(selfUri);
  });

  it('캐시가 찬 뒤 새로 마운트하면 첫 프레임부터 file:// 이미지이고 다시 받지 않는다', async () => {
    const first = render(<Avatar directory={dir(PATH_A)} memberId={SELF} />);
    await waitFor(() => expect(first.getByTestId('avatar-image', HIDDEN)).toBeTruthy());
    first.unmount();
    expect(downloads()).toHaveLength(1);
    const second = render(<Avatar directory={dir(PATH_A)} memberId={SELF} />);
    // 대기 없이 곧바로: effect·프라미스를 기다리지 않은 첫 프레임이다.
    expect(isFile(second.getByTestId('avatar-image', HIDDEN).props.source.uri)).toBe(true);
    expect(second.queryByTestId('avatar-initial', HIDDEN)).toBeNull();
    expect(downloads()).toHaveLength(1);
  });

  it('캐시에서 밀려난 뒤 다시 그려지면 낡은 주소를 버리고 다시 받는다', async () => {
    const view = render(<Avatar directory={dir(PATH_A)} memberId={SELF} />);
    await waitFor(() => expect(view.getByTestId('avatar-image', HIDDEN)).toBeTruthy());
    clearMemberAvatarCache(); // 축출과 같은 효과: 색인과 파일이 사라진다
    view.rerender(<Avatar directory={dir(PATH_A)} memberId={SELF} size={40} />);
    expect(view.queryByTestId('avatar-image', HIDDEN)).toBeNull();
    await waitFor(() => expect(downloads()).toHaveLength(2));
    await waitFor(() => expect(view.getByTestId('avatar-image', HIDDEN)).toBeTruthy());
  });

  it('사람 사진에만 배경이 깔리고 에이전트는 상자 색이 비친다', async () => {
    const agentPath = `/v1/workspaces/${WS}/members/${AGENT}/avatar/content?v=m`;
    const d = makeDirectory([
      member({id: SELF, avatarUrl: PATH_A}),
      member({id: AGENT, kind: 'agent', displayName: '김인턴', avatarUrl: agentPath}),
    ]);
    const view = render(
      <>
        <Avatar directory={d} memberId={SELF} />
        <Avatar directory={d} memberId={AGENT} />
      </>,
    );
    await waitFor(() => expect(view.getAllByTestId('avatar-image', HIDDEN)).toHaveLength(2));
    const [human, agent] = view.getAllByTestId('avatar-image', HIDDEN);
    const bg = (n: {props: {style: unknown}}) =>
      ([] as Record<string, unknown>[]).concat(n.props.style as never).flat(5)
        .map(x => x?.backgroundColor).find(Boolean);
    expect(bg(human)).toBeTruthy();
    expect(bg(agent)).toBeUndefined();
  });

  it('옛 절대 avatarUrl 은 기존대로 uri 로 실리고 요청은 없다', () => {
    const view = render(<Avatar directory={dir(`${BASE}/legacy/me.png`)} memberId={SELF} />);
    expect(view.getByTestId('avatar-image', HIDDEN).props.source).toEqual({
      uri: `${BASE}/legacy/me.png`,
    });
    expect(downloads()).toHaveLength(0);
  });

  it('에이전트는 사진이 있어도 둥근 사각이다', async () => {
    const agentPath = `/v1/workspaces/${WS}/members/${AGENT}/avatar/content?v=m`;
    const view = render(<Avatar directory={dir(agentPath)} memberId={AGENT} />);
    await waitFor(() => expect(view.getByTestId('avatar-image', HIDDEN)).toBeTruthy());
    expect(view.getByTestId('avatar-agent', HIDDEN)).toBeTruthy();
  });
});
