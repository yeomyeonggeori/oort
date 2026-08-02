import {fireEvent, render, screen, waitFor} from '@testing-library/react-native';
import React from 'react';
import {Linking} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import ConnectScreen from '../src/screens/ConnectScreen';
import {__resetSessionStore, keychainSettled} from '../src/storage/secureSession';
import {__resetServerBaseCache} from '../src/storage/serverBase';

// =============================================================================
// The screen a signed-out person meets, exercised as they would use it.
//
// Four things are checked here and they are easy to conflate:
//
//   1. the screen RENDERS the core's answer — the hint under the address field
//      is `normalizeServerUrl`'s `base`, not a second opinion computed locally;
//   2. the screen SPEAKS the core's copy — every failure sentence comes from
//      `signInFailureCopy` / `joinFailureCopy`, so this client and the web client
//      cannot tell one person two different stories about the same 409;
//   3. the screen's input state is SYNCHRONOUS — spike #837 gate 1 case D
//      measured that a single `setTimeout(…, 0)` between a keystroke and the
//      rendered value is enough to sever the iOS IME and stop Korean jamo
//      combining altogether;
//   4. an invite link lands in the invite form, not next to it.
//
// (3) cannot be measured in Jest — there is no IME here. What CAN be measured is
// the property the IME needs: the value is readable immediately after the
// keystroke, with nothing awaited. A rewrite that routed input through a store,
// a query or the network would fail these assertions long before it reached a
// device.
// =============================================================================

const LOGIN_BODY = {
  accessToken: 'access-token-1',
  refreshToken: 'refresh-token-1',
  realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
  member: {
    id: '11111111-1111-4111-8111-111111111111',
    workspaceId: '22222222-2222-4222-8222-222222222222',
    kind: 'human',
    displayName: 'Seongjae Kwak',
    handle: 'seongjae',
  },
};

// The in-memory doubles from `jest.setup.js`. Reached through `requireMock` so
// the mock's inspection handles are not pretended to be part of the real
// modules' public API.
const mmkvStore = (
  jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}
).__store;
const keychainItems = (
  jest.requireMock('react-native-keychain') as {
    __items: Map<string, {password: string; options: {accessible?: string}}>;
  }
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
  jest.restoreAllMocks();
});

describe('the address field renders the core’s answer', () => {
  it('reads a bare host as https, exactly as every other client does', () => {
    render(<ConnectScreen />);
    fireEvent.changeText(screen.getByTestId('server-url-input'), 'momo.example.com');
    // `normalizeServerUrl` chose https over http — the safer guess, because a
    // plaintext guess would silently downgrade a TLS server.
    expect(screen.getByTestId('server-url-hint')).toHaveTextContent(
      '요청 주소: https://momo.example.com/v1/…',
    );
  });

  it('keeps a LAN address on its own scheme and port', () => {
    render(<ConnectScreen />);
    fireEvent.changeText(
      screen.getByTestId('server-url-input'),
      'http://macbook.local:28000',
    );
    expect(screen.getByTestId('server-url-hint')).toHaveTextContent(
      '요청 주소: http://macbook.local:28000/v1/…',
    );
  });

  it('shows the core’s own rejection copy rather than a local paraphrase', () => {
    render(<ConnectScreen />);
    fireEvent.changeText(screen.getByTestId('server-url-input'), 'ws://momo.example.com');
    expect(screen.getByTestId('server-url-hint')).toHaveTextContent(
      '주소는 http:// 또는 https:// 로 시작해야 합니다.',
    );
  });
});

describe('input state is synchronous (spike #837 gate 1, case D)', () => {
  it('reflects a keystroke with nothing awaited', () => {
    render(<ConnectScreen />);
    const input = screen.getByTestId('server-url-input');

    // No `await`, no `waitFor`. If the value ever has to travel through a store
    // or the network and back, this line is where that shows up.
    fireEvent.changeText(input, 'ㅇ');
    expect(input.props.value).toBe('ㅇ');
  });

  it('carries a composed Korean string through unchanged', () => {
    render(<ConnectScreen />);
    const email = screen.getByTestId('email-input');
    // The IME delivers composed text; the screen must not transform it. The
    // spike's failing case turned 안녕하세요 into ㅇㅏㄴㄴㅕㅇㅎㅏㅅㅔㅇㅛ.
    fireEvent.changeText(email, '안녕하세요');
    expect(email.props.value).toBe('안녕하세요');
  });

  it('holds every intermediate value of a jamo-by-jamo sequence', () => {
    render(<ConnectScreen />);
    const email = screen.getByTestId('email-input');
    for (const step of ['ㅇ', '아', '안', '안ㄴ', '안녀', '안녕']) {
      fireEvent.changeText(email, step);
      expect(email.props.value).toBe(step);
    }
  });

  it('holds the invite code synchronously too', () => {
    // The composer is the next batch's, but a code pasted from a Korean IME
    // keyboard travels the same path and deserves the same rule.
    render(<ConnectScreen />);
    fireEvent.press(screen.getByTestId('mode-toggle'));
    const code = screen.getByTestId('invite-code-input');
    fireEvent.changeText(code, '초대-CODE-1');
    expect(code.props.value).toBe('초대-CODE-1');
  });
});

describe('the login round trip, mocked', () => {
  function fillForm() {
    fireEvent.changeText(
      screen.getByTestId('server-url-input'),
      'https://api.example.com',
    );
    fireEvent.changeText(screen.getByTestId('email-input'), 'seongjae@example.com');
    fireEvent.changeText(screen.getByTestId('password-input'), 'pw');
  }

  it('signs in and stores the refresh token in the keychain', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, LOGIN_BODY));
    render(<ConnectScreen />);
    fillForm();
    fireEvent.press(screen.getByTestId('submit-button'));

    await waitFor(() =>
      expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/v1/auth/login'),
    );
    await keychainSettled();
    expect(keychainItems.get('app.momo.ios.rn.session')?.password).toBe(
      'refresh-token-1',
    );
    // The screen does not announce success or navigate: the session store
    // notified and the gate above swaps the tree. A second source of truth for
    // "am I signed in" is how the two start disagreeing.
    expect(screen.queryByTestId('failure')).toBeNull();
  });

  it('speaks the core’s sentence for a rejected password', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, {error: {message: 'invalid credentials'}}),
    );
    render(<ConnectScreen />);
    fillForm();
    fireEvent.press(screen.getByTestId('submit-button'));

    await waitFor(() => expect(screen.getByTestId('failure')).toBeTruthy());
    expect(screen.getByTestId('failure')).toHaveTextContent(
      '이메일 또는 비밀번호가 맞지 않습니다.',
    );
    // …and specifically not the server's English, and not a network story.
    expect(screen.getByTestId('failure')).not.toHaveTextContent(/invalid credentials/);
    expect(screen.getByTestId('failure')).not.toHaveTextContent(/서버에 닿지 못했습니다/);
  });

  it('offers no retry for a wrong password, because pressing again cannot help', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, {error: {message: 'nope'}}));
    render(<ConnectScreen />);
    fillForm();
    fireEvent.press(screen.getByTestId('submit-button'));

    await waitFor(() => expect(screen.getByTestId('failure')).toBeTruthy());
    expect(screen.queryByTestId('failure-retry')).toBeNull();
  });

  it('says nothing answered when nothing answered, and offers a retry', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Network request failed'));
    render(<ConnectScreen />);
    fillForm();
    fireEvent.press(screen.getByTestId('submit-button'));

    await waitFor(() => expect(screen.getByTestId('failure')).toBeTruthy());
    // The core wrote this copy, deadline included; the screen shows it verbatim.
    expect(screen.getByTestId('failure')).toHaveTextContent(
      /주소와 네트워크를 확인하고 다시 시도하세요\./,
    );
    expect(screen.getByTestId('failure-retry')).toBeTruthy();
  });

  it('does not name a suspended account as a wrong password', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(403, {error: {message: 'member is suspended'}}),
    );
    render(<ConnectScreen />);
    fillForm();
    fireEvent.press(screen.getByTestId('submit-button'));

    await waitFor(() => expect(screen.getByTestId('failure')).toBeTruthy());
    expect(screen.getByTestId('failure')).toHaveTextContent(
      '이 계정은 지금 로그인할 수 없습니다. 워크스페이스 관리자에게 문의하세요.',
    );
  });

  it('will not submit without a usable address', () => {
    render(<ConnectScreen />);
    fireEvent.changeText(screen.getByTestId('email-input'), 'seongjae@example.com');
    fireEvent.changeText(screen.getByTestId('password-input'), 'pw');
    fireEvent.press(screen.getByTestId('submit-button'));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('joining with an invite code', () => {
  function fillJoinForm() {
    fireEvent.press(screen.getByTestId('mode-toggle'));
    fireEvent.changeText(
      screen.getByTestId('server-url-input'),
      'https://api.example.com',
    );
    fireEvent.changeText(screen.getByTestId('invite-code-input'), 'INVITE-1');
    fireEvent.changeText(screen.getByTestId('email-input'), 'new.person@example.com');
    fireEvent.changeText(screen.getByTestId('password-input'), 'pw');
  }

  it('redeems the code through the core’s public join route', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, LOGIN_BODY));
    render(<ConnectScreen />);
    fillJoinForm();
    fireEvent.press(screen.getByTestId('submit-button'));

    await waitFor(() =>
      expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/v1/join'),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.code).toBe('INVITE-1');
    // Identity is derived by the core, so someone joining from the phone and
    // from the mac chooser gets the same handle.
    expect(body.handle).toBe('new-person');
    expect(body.displayName).toBe('New Person');
  });

  it('will not submit without a code', () => {
    render(<ConnectScreen />);
    fireEvent.press(screen.getByTestId('mode-toggle'));
    fireEvent.changeText(
      screen.getByTestId('server-url-input'),
      'https://api.example.com',
    );
    fireEvent.changeText(screen.getByTestId('email-input'), 'a@example.com');
    fireEvent.changeText(screen.getByTestId('password-input'), 'pw');
    fireEvent.press(screen.getByTestId('submit-button'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('follows the core’s instruction to sign in when the invite was already used', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(409, {error: {message: 'invite already redeemed'}}),
    );
    render(<ConnectScreen />);
    fillJoinForm();
    fireEvent.press(screen.getByTestId('submit-button'));

    await waitFor(() => expect(screen.getByTestId('failure')).toBeTruthy());
    expect(screen.getByTestId('failure')).toHaveTextContent(
      '이미 이 초대로 가입한 계정입니다. 로그인하세요.',
    );
    // `suggestSignIn` is an instruction, so the form follows it rather than
    // leaving the person to find the toggle themselves.
    expect(screen.queryByTestId('invite-code-input')).toBeNull();
  });

  it('distinguishes an expired invite from a revoked one', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(410, {error: {message: 'invite expired'}}),
    );
    render(<ConnectScreen />);
    fillJoinForm();
    fireEvent.press(screen.getByTestId('submit-button'));

    await waitFor(() => expect(screen.getByTestId('failure')).toBeTruthy());
    expect(screen.getByTestId('failure')).toHaveTextContent(
      '만료된 초대입니다. 워크스페이스 관리자에게 새 초대 링크를 요청하세요.',
    );
  });
});

describe('an invite deep link', () => {
  it('fills the server and the code, and opens the invite form', async () => {
    jest
      .spyOn(Linking, 'getInitialURL')
      .mockResolvedValue(
        'oort://join?server=https%3A%2F%2Fapi.example.com&code=INVITE-9',
      );
    render(<ConnectScreen />);

    await waitFor(() => expect(screen.getByTestId('invite-code-input')).toBeTruthy());
    expect(screen.getByTestId('invite-code-input').props.value).toBe('INVITE-9');
    expect(screen.getByTestId('server-url-input').props.value).toBe(
      'https://api.example.com',
    );
    expect(screen.getByTestId('server-url-hint')).toHaveTextContent(
      '요청 주소: https://api.example.com/v1/…',
    );
  });

  it('is ignored when it is not a join link', async () => {
    jest.spyOn(Linking, 'getInitialURL').mockResolvedValue('oort://settings?x=1');
    render(<ConnectScreen />);
    await waitFor(() => expect(screen.getByTestId('submit-button')).toBeTruthy());
    // Still the sign-in form: a stray link must not switch the screen's job.
    expect(screen.queryByTestId('invite-code-input')).toBeNull();
  });
});

describe('a session that ended', () => {
  it('says why the person is back here', () => {
    render(<ConnectScreen sessionExpired />);
    expect(screen.getByTestId('session-expired')).toHaveTextContent(
      '로그인이 만료되었습니다. 다시 연결해 주세요.',
    );
  });

  it('says nothing when this is simply a first launch', () => {
    render(<ConnectScreen />);
    expect(screen.queryByTestId('session-expired')).toBeNull();
  });
});
