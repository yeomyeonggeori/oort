// 폰 M0 환영 분리 (#2819 OB2-13, ADR-0193 D7·D11, ADR-0185 증보 §6).
//
// 한 장 폼이 시안의 화면들로 나뉘었는지, 그리고 나뉜 뒤에도 같은 길인지 잰다.
import {fireEvent, render, screen, waitFor} from '@testing-library/react-native';
import React from 'react';
import {Linking} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {KomettoFace} from '../src/features/onboarding/KomettoGuide';
import {
  lastConnectRoute,
  resetConnectRoute,
  SAS_DETAIL,
  SAS_LINE,
  WELCOME_DETAIL,
  WELCOME_LINE,
  WELCOME_TAGLINE,
} from '../src/features/onboarding/phoneFlow';
import ConnectScreen from '../src/screens/ConnectScreen';
import {__resetSessionStore, keychainSettled} from '../src/storage/secureSession';
import {__resetServerBaseCache} from '../src/storage/serverBase';

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

const TOKEN = 'A'.repeat(43);
const DEVICE_LINK_URL = `oort://link?server=${encodeURIComponent(
  'https://api.example.com',
)}&token=${TOKEN}`;

const mmkvStore = (
  jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}
).__store;

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
  __resetSessionStore();
  __resetServerBaseCache();
  resetConnectRoute();
  fetchMock = jest.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  jest.spyOn(Linking, 'getInitialURL').mockResolvedValue(null);
});

afterEach(() => {
  jest.restoreAllMocks();
});

const HIDDEN = {includeHiddenElements: true} as const;

function expression(): string {
  return screen.UNSAFE_getByType(KomettoFace).props.expression as string;
}

describe('M0 환영', () => {
  it('leads with QR: hero Kometto waiting, the wordmark, one question, one big button', () => {
    render(<ConnectScreen />);
    expect(screen.getByTestId('connect-welcome')).toBeTruthy();
    expect(screen.getAllByTestId('kometto-face', HIDDEN)).toHaveLength(1);
    expect(screen.UNSAFE_getByType(KomettoFace).props.size).toBe('hero');
    expect(expression()).toBe('idle');
    expect(screen.getByText('oort')).toBeTruthy();
    expect(screen.getByText(WELCOME_TAGLINE)).toBeTruthy();
    expect(screen.getByTestId('kometto-guide-line')).toHaveTextContent(WELCOME_LINE);
    expect(screen.getByTestId('kometto-guide-detail')).toHaveTextContent(WELCOME_DETAIL);
    expect(screen.getByTestId('qr-connect-button')).toHaveTextContent('QR 찍기');
    expect(screen.getByTestId('welcome-invite')).toHaveTextContent('초대 링크로 참여');
    expect(screen.getByTestId('welcome-address')).toHaveTextContent('주소로 로그인');
    // Not the form: no field is on the first screen.
    expect(screen.queryByTestId('server-url-input')).toBeNull();
    expect(screen.queryByTestId('email-input')).toBeNull();
    // The first screen has no progress dots (ADR-0193 D10).
    expect(screen.queryByTestId('onboarding-dots')).toBeNull();
  });

  it('opens the sign-in form (M-b) and comes back with what was typed', () => {
    render(<ConnectScreen />);
    fireEvent.press(screen.getByTestId('welcome-address'));
    expect(screen.getByTestId('server-url-input')).toBeTruthy();
    expect(screen.queryByTestId('invite-code-input')).toBeNull();
    expect(screen.queryByTestId('display-name-input')).toBeNull();
    expect(screen.getByTestId('onboarding-dots').props.accessibilityLabel).toBe(
      '2단계 중 1단계',
    );
    fireEvent.changeText(screen.getByTestId('email-input'), 'a@example.com');

    fireEvent.press(screen.getByTestId('connect-back'));
    expect(screen.getByTestId('connect-welcome')).toBeTruthy();
    fireEvent.press(screen.getByTestId('welcome-address'));
    expect(screen.getByTestId('email-input').props.value).toBe('a@example.com');
  });

  it('opens the invite form (M-a) with the name field and the D1′ sentences', () => {
    render(<ConnectScreen />);
    fireEvent.press(screen.getByTestId('welcome-invite'));
    expect(screen.getByTestId('invite-code-input')).toBeTruthy();
    expect(screen.getByTestId('display-name-input')).toBeTruthy();
    expect(screen.getByTestId('submit-button')).toHaveTextContent('팀에 들어가기');
    expect(expression()).toBe('happy');
    // 「이미 계정이 있나요? 로그인」 goes to M-b in place.
    fireEvent.press(screen.getByTestId('mode-toggle'));
    expect(screen.queryByTestId('invite-code-input')).toBeNull();
    expect(screen.getByTestId('submit-button')).toHaveTextContent('로그인');
  });

  it('a session that expired opens straight on the sign-in form, with the notice', () => {
    render(<ConnectScreen sessionExpired />);
    expect(screen.queryByTestId('connect-welcome')).toBeNull();
    expect(screen.getByTestId('server-url-input')).toBeTruthy();
    expect(screen.getByTestId('session-expired')).toBeTruthy();
  });

  it('tells M3 which route signed in', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, LOGIN_BODY));
    render(<ConnectScreen />);
    fireEvent.press(screen.getByTestId('welcome-address'));
    fireEvent.changeText(screen.getByTestId('server-url-input'), 'https://api.example.com');
    fireEvent.changeText(screen.getByTestId('email-input'), 'a@example.com');
    fireEvent.changeText(screen.getByTestId('password-input'), 'pw');
    fireEvent.press(screen.getByTestId('submit-button'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(lastConnectRoute()).toBe('signIn');
    await keychainSettled();
  });
});

describe('M2 확인 번호', () => {
  async function renderSas() {
    jest.spyOn(Linking, 'getInitialURL').mockResolvedValue(DEVICE_LINK_URL);
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/v1/auth/device-link/redeem')) {
        return jsonResponse(200, {...LOGIN_BODY, pendingSas: true, sas: '4827'});
      }
      if (String(url).includes('/v1/workspaces/')) {
        return jsonResponse(401, {error: {message: 'token has not been activated'}});
      }
      return jsonResponse(500, {error: {message: 'unexpected'}});
    });
    render(<ConnectScreen />);
    await waitFor(() => expect(screen.getByTestId('device-link-sas')).toBeTruthy());
  }

  it('Kometto thinks and asks the question; four digit tiles; the server chip', async () => {
    await renderSas();
    expect(expression()).toBe('thinking');
    expect(screen.getByTestId('kometto-guide-line')).toHaveTextContent(SAS_LINE);
    expect(screen.getByTestId('kometto-guide-detail')).toHaveTextContent(SAS_DETAIL);
    const digits = screen.getByTestId('device-link-sas-digits');
    expect(digits).toHaveTextContent('4827');
    expect(digits.props.accessibilityLabel).toBe('확인 번호 4, 8, 2, 7');
    expect(screen.getByTestId('device-link-sas-server')).toHaveTextContent(
      'api.example.com',
    );
    expect(screen.getByTestId('device-link-sas-wait')).toHaveTextContent(
      '데스크톱에서 확인을 누르면 진행됩니다.',
    );
    expect(screen.getByTestId('onboarding-dots').props.accessibilityLabel).toBe(
      '3단계 중 2단계',
    );
    expect(lastConnectRoute()).toBe('qr');
  });
});
