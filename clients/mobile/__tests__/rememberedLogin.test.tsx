import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react-native';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import React from 'react';
import {Linking, Text} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import ConnectScreen from '../src/screens/ConnectScreen';
import {SessionProvider, useSession} from '../src/session/useSession';
import {__resetSessionStore, keychainSettled} from '../src/storage/secureSession';
import {NON_SECRET_KEYS} from '../src/storage/kv';
import {__resetServerBaseCache} from '../src/storage/serverBase';

// =============================================================================
// 「이메일 기억하기」(#4669), 폰(처음 값은 켬).
//
// 화면을 쓰는 순서대로 간다: 서버를 넣고 → 로그인하고 → **진짜 로그아웃**(`SessionProvider`의 `signOut`)하고 → 화면을
// 새로 열면 같은 서버의 이메일 칸이 채워져 있다. 「지우지 않았다」는 단정이 아니라 다시 그린 칸의 값과 MMKV에 실제로
// 적힌 글자를 잰다. 비밀번호는 어디에도 남지 않는다.
// =============================================================================

const SERVER = 'https://api.example.com';
const OTHER_SERVER = 'https://other.example.com';
const PASSWORD = 'S3cret-pw-9';
const KEY = NON_SECRET_KEYS.rememberedLogin;

const LOGIN_BODY = {
  accessToken: 'access-token-1',
  refreshToken: 'refresh-token-1',
  realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
  member: {
    id: '11111111-1111-4111-8111-111111111111',
    workspaceId: '22222222-2222-4222-8222-222222222222',
    kind: 'human',
    displayName: 'Dohyun Lee',
    handle: 'dohyun',
  },
};

const mmkvStore = (jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}).__store;
const keychainItems = (
  jest.requireMock('react-native-keychain') as {__items: Map<string, unknown>}
).__items;

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

let fetchMock: jest.Mock;

beforeEach(() => {
  mmkvStore.clear();
  keychainItems.clear();
  __resetSessionStore();
  __resetServerBaseCache();
  fetchMock = jest.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  jest.spyOn(Linking, 'getInitialURL').mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

function openSignIn() {
  render(<ConnectScreen />);
  fireEvent.press(screen.getByTestId('welcome-address'));
}

const emailInput = () => screen.getByTestId('email-input');
const toggleRow = () => screen.getByTestId('remember-email-row');
const stored = () => mmkvStore.get(KEY) ?? null;

async function signIn(server: string, email: string, password = PASSWORD) {
  fireEvent.changeText(screen.getByTestId('server-url-input'), server);
  fireEvent.changeText(emailInput(), email);
  fireEvent.changeText(screen.getByTestId('password-input'), password);
  fireEvent.press(screen.getByTestId('submit-button'));
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  await keychainSettled();
}

/** 로그아웃 뒤 다음 실행: 화면을 걷고 세션·서버 메모리를 비운다. 저장소(MMKV)는 그대로다(로그아웃은 이 칸을 모른다). */
function relaunch() {
  // `cleanup()`이 아니라 `unmount()`다: 시험 한가운데의 `cleanup()` 뒤에는 RNTL이 다음 `render`의 `.root`를 못 준다.
  screen.unmount();
  __resetSessionStore();
  __resetServerBaseCache();
}

describe('이메일 기억하기: 폰', () => {
  it('켠 채 시작하고, 로그인하면 기억하고, 로그아웃·재실행 뒤 같은 서버의 칸이 채워진다', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, LOGIN_BODY));
    openSignIn();
    expect(toggleRow().props.accessibilityState).toMatchObject({checked: true});
    await signIn(SERVER, '  me@example.com ');
    expect(JSON.parse(stored()!).entries).toEqual([[SERVER, 'me@example.com']]);

    relaunch();
    // 로그아웃은 이 칸을 지우지 않았다.
    expect(JSON.parse(stored()!).entries).toEqual([[SERVER, 'me@example.com']]);
    openSignIn();
    expect(screen.getByTestId('server-url-input').props.value).toBe(SERVER);
    expect(emailInput().props.value).toBe('me@example.com');
    expect(screen.getByTestId('password-input').props.value).toBe('');
    expect(toggleRow().props.accessibilityState).toMatchObject({checked: true});
    // 비밀번호는 MMKV 어디에도 없다.
    expect([...mmkvStore.values()].join('\n')).not.toContain(PASSWORD);
  });

  it('로그인에 실패하면 저장하지 않는다', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, {error: {message: 'nope'}}));
    openSignIn();
    await signIn(SERVER, 'typo@example.com');
    await waitFor(() => expect(screen.getByTestId('failure')).toBeTruthy());
    expect(stored()).toBeNull();
  });

  it('서버마다 따로다: 다른 서버로 바꾸면 비우고, 되돌리면 채우며, 직접 친 글자는 덮지 않는다', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, LOGIN_BODY));
    openSignIn();
    await signIn(SERVER, 'a-user@example.com');
    relaunch();

    openSignIn();
    expect(emailInput().props.value).toBe('a-user@example.com');
    fireEvent.changeText(screen.getByTestId('server-url-input'), OTHER_SERVER);
    expect(emailInput().props.value).toBe('');
    fireEvent.changeText(screen.getByTestId('server-url-input'), SERVER);
    expect(emailInput().props.value).toBe('a-user@example.com');

    // 사람이 이메일 칸에 친 글자는 서버를 바꿔도 그대로다.
    fireEvent.changeText(emailInput(), 'typed@example.com');
    fireEvent.changeText(screen.getByTestId('server-url-input'), OTHER_SERVER);
    expect(emailInput().props.value).toBe('typed@example.com');
  });

  it('끄면 저장된 이메일이 그 자리에서 사라지고, 재실행 뒤에도 꺼져 있으며, 꺼진 채 로그인하면 저장하지 않는다', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, LOGIN_BODY));
    openSignIn();
    await signIn(SERVER, 'me@example.com');
    relaunch();

    openSignIn();
    expect(emailInput().props.value).toBe('me@example.com');
    fireEvent.press(toggleRow());
    expect(toggleRow().props.accessibilityState).toMatchObject({checked: false});
    // MMKV에 적힌 글자에서 사라졌다. 칸에 떠 있는 글자는 로그인 중인 사람의 것이라 그대로다.
    expect(stored()).not.toContain('me@example.com');
    expect(JSON.parse(stored()!)).toMatchObject({enabled: false, entries: []});
    expect(emailInput().props.value).toBe('me@example.com');

    relaunch();
    openSignIn();
    expect(emailInput().props.value).toBe('');
    expect(toggleRow().props.accessibilityState).toMatchObject({checked: false});
    await signIn(SERVER, 'again@example.com');
    expect(stored()).not.toContain('again@example.com');
  });

  it('비밀번호 모양·토큰 모양은 켜 둔 채 로그인해도 저장하지 않는다', async () => {
    const jwtLocal = 'eyJfakehdr.eyJfakepld.fakesig@evil.example.com';
    fetchMock.mockResolvedValue(jsonResponse(200, LOGIN_BODY));
    for (const shaped of ['P@ssw0rd!', PASSWORD, jwtLocal]) {
      openSignIn();
      await signIn(SERVER, shaped, 'another-secret-1');
      const raw = stored() ?? '';
      expect(raw).not.toContain('ssw0rd');
      expect(raw).not.toContain('S3cret');
      expect(raw).not.toContain('eyJ');
      screen.unmount();
      __resetSessionStore();
      __resetServerBaseCache();
      mmkvStore.clear();
      fetchMock.mockClear();
    }
  });

  it('암호 자동 채움과 짝을 이룬다: 이메일 칸은 username, 비밀번호 칸은 password(가입은 newPassword)', () => {
    openSignIn();
    expect(emailInput().props.textContentType).toBe('username');
    expect(screen.getByTestId('password-input').props.textContentType).toBe('password');
    screen.unmount();

    render(<ConnectScreen />);
    fireEvent.press(screen.getByTestId('welcome-invite'));
    expect(emailInput().props.textContentType).toBe('username');
    expect(screen.getByTestId('password-input').props.textContentType).toBe('newPassword');
    // 가입에는 「이메일 기억하기」가 없다.
    expect(screen.queryByTestId('remember-email-row')).toBeNull();
  });

  it('진짜 로그아웃은 이 칸을 지우지 않는다: 같은 로그아웃이 지우는 다른 기록은 지워지는데도', async () => {
    mmkvStore.set(KEY, JSON.stringify({v: 1, enabled: true, entries: [[SERVER, 'me@example.com']]}));
    // 로그아웃이 지우는 기록 하나(이 폰의 푸시를 껐다는 기억, #3924)를 심어 「진짜 `signOut`이 돌았다」를 증명한다.
    mmkvStore.set(NON_SECRET_KEYS.pushOptOut, LOGIN_BODY.member.id);
    let signOut: (() => void) | null = null;
    // 화면이 하나도 없는 트리는 시험 렌더러가 `.root`를 못 준다. 보이는 것이 하나 있어야 한다.
    function Probe(): React.JSX.Element {
      signOut = useSession().signOut;
      return <Text>signed-in tree</Text>;
    }
    render(
      <QueryClientProvider client={new QueryClient({defaultOptions: {queries: {gcTime: 0}}})}>
        <SessionProvider member={LOGIN_BODY.member as never}>
          <Probe />
        </SessionProvider>
      </QueryClientProvider>,
    );
    act(() => signOut!());
    await keychainSettled();
    expect(mmkvStore.has(NON_SECRET_KEYS.pushOptOut)).toBe(false);
    expect(JSON.parse(stored()!).entries).toEqual([[SERVER, 'me@example.com']]);
  });
});
