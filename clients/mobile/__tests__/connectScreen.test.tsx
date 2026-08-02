import {fireEvent, render, screen, waitFor} from '@testing-library/react-native';
import React from 'react';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import ConnectScreen from '../src/screens/ConnectScreen';
import {__resetSessionStore, keychainSettled} from '../src/storage/secureSession';
import {__resetServerBaseCache} from '../src/storage/serverBase';

// =============================================================================
// The screen that proves the app is attached to the core, exercised as a person
// would use it. Two separate things are checked here and they are easy to
// conflate:
//
//   1. the screen RENDERS the core's answer — the hint under the address field
//      is `normalizeServerUrl`'s `base`, not a second opinion computed locally;
//   2. the screen's input state is SYNCHRONOUS — spike #837 gate 1 case D
//      measured that a single `setTimeout(…, 0)` between a keystroke and the
//      rendered value is enough to sever the iOS IME and stop Korean jamo
//      combining altogether.
//
// (2) cannot be measured in Jest — there is no IME here. What CAN be measured is
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

  it('signs in and reports the member the server returned', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, LOGIN_BODY));
    render(<ConnectScreen />);
    fillForm();
    fireEvent.press(screen.getByTestId('submit-button'));

    await waitFor(() => expect(screen.getByTestId('success')).toBeTruthy());
    expect(screen.getByTestId('success')).toHaveTextContent(/Seongjae Kwak/);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/v1/auth/login');

    await keychainSettled();
    expect(keychainItems.get('app.momo.ios.rn.session')?.password).toBe(
      'refresh-token-1',
    );
  });

  it('distinguishes a rejected password from an unreachable server', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, {error: {message: '이메일 또는 비밀번호가 올바르지 않습니다.'}}),
    );
    render(<ConnectScreen />);
    fillForm();
    fireEvent.press(screen.getByTestId('submit-button'));

    await waitFor(() => expect(screen.getByTestId('failure')).toBeTruthy());
    expect(screen.getByTestId('failure')).toHaveTextContent(
      /로그인 정보가 맞지 않습니다/,
    );
    // …and specifically NOT as a network problem. Telling someone to check
    // their connection when the server already answered sends them to fix the
    // wrong thing.
    expect(screen.getByTestId('failure')).not.toHaveTextContent(
      /서버에 닿지 못했습니다/,
    );
  });

  it('says nothing answered when nothing answered', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Network request failed'));
    render(<ConnectScreen />);
    fillForm();
    fireEvent.press(screen.getByTestId('submit-button'));

    await waitFor(() => expect(screen.getByTestId('failure')).toBeTruthy());
    // The core wrote this copy, deadline included; the screen shows it verbatim.
    expect(screen.getByTestId('failure')).toHaveTextContent(
      /주소와 네트워크를 확인하고 다시 시도하세요\./,
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
