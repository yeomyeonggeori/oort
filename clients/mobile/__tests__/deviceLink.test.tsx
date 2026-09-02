import {fireEvent, render, screen, waitFor} from '@testing-library/react-native';
import React from 'react';
import {Linking} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {
  DEVICE_LINK_EXPIRED_COPY,
  DEVICE_LINK_MALFORMED_COPY,
  DEVICE_LINK_SAS_WAIT_COPY,
  DEVICE_LINK_TOKEN_LEN,
  DEVICE_LINK_USED_COPY,
} from '@momo/core/features/auth/deviceLinkModel';
import {parseDeviceLinkDeepLink} from '@momo/core/features/auth/deepLink';

import ConnectScreen from '../src/screens/ConnectScreen';
import {__resetSessionStore, keychainSettled} from '../src/storage/secureSession';
import {__resetServerBaseCache} from '../src/storage/serverBase';

// =============================================================================
// M0m / #1990 — device-link on the phone (ADR-0180 D2·D3·D4·D7).
//
// The voucher literal used to prove "it never lands in MMKV or logs" is local
// to this file. Assertions about leakage report only a boolean so a failure
// does not reprint the voucher into the test output.
// =============================================================================

const DEVICE_LINK_TOKEN = 'dEv1c3L1nkT0kenF1xtureDoN0tL0gOrSt0reXXXXXX';
const SERVER = 'https://api.example.com';
const ENCODED_SERVER = 'https%3A%2F%2Fapi.example.com';
const DEVICE_LINK_URL = `oort://link?server=${ENCODED_SERVER}&token=${DEVICE_LINK_TOKEN}`;

const LOGIN_BODY = {
  accessToken: 'access-token-device-link',
  refreshToken: 'refresh-token-device-link',
  realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
  member: {
    id: '11111111-1111-4111-8111-111111111111',
    workspaceId: '22222222-2222-4222-8222-222222222222',
    kind: 'human',
    displayName: 'Seongjae Kwak',
    handle: 'seongjae',
  },
};

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

function storeHoldsLiteral(literal: string): boolean {
  for (const value of mmkvStore.values()) {
    if (value.includes(literal)) return true;
  }
  return false;
}

function captureHoldsLiteral(lines: string[], literal: string): boolean {
  return lines.some(line => line.includes(literal));
}

function attachConsoleCapture(): {lines: string[]; restore: () => void} {
  const lines: string[] = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const spies = methods.map(method =>
    jest.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(
        args
          .map(value => {
            if (typeof value === 'string') return value;
            try {
              return JSON.stringify(value);
            } catch {
              return Object.prototype.toString.call(value);
            }
          })
          .join(' '),
      );
    }),
  );
  return {
    lines,
    restore: () => {
      for (const spy of spies) spy.mockRestore();
    },
  };
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

describe('oort://link parser under the installed URL polyfill', () => {
  it('parses order-independently, absorbs momo://, ignores unknown params', () => {
    expect(DEVICE_LINK_TOKEN).toHaveLength(DEVICE_LINK_TOKEN_LEN);
    expect(
      parseDeviceLinkDeepLink(
        `oort://link?token=${DEVICE_LINK_TOKEN}&utm=1&server=${ENCODED_SERVER}`,
      ),
    ).toEqual({serverUrl: SERVER, token: DEVICE_LINK_TOKEN});
    expect(
      parseDeviceLinkDeepLink(
        `momo://link?server=${ENCODED_SERVER}&token=${DEVICE_LINK_TOKEN}`,
      ),
    ).toEqual({serverUrl: SERVER, token: DEVICE_LINK_TOKEN});
  });

  it('rejects an unusable server', () => {
    expect(
      parseDeviceLinkDeepLink(
        `oort://link?server=not%20a%20url&token=${DEVICE_LINK_TOKEN}`,
      ),
    ).toBeNull();
  });
});

describe('ConnectScreen device-link redeem', () => {
  it('speaks three distinct sentences for 401, 409, and a malformed payload', async () => {
    jest.spyOn(Linking, 'getInitialURL').mockResolvedValue(DEVICE_LINK_URL);

    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, {error: {message: 'device link token is invalid'}}),
    );
    const first = render(<ConnectScreen />);
    await waitFor(() => expect(screen.getByTestId('device-link-failure')).toBeTruthy());
    expect(screen.getByText(DEVICE_LINK_EXPIRED_COPY)).toBeTruthy();
    expect(screen.getByTestId('device-link-failure-retry')).toHaveTextContent(
      'QR 다시 찍기',
    );
    first.unmount();

    fetchMock.mockResolvedValueOnce(
      jsonResponse(409, {error: {message: 'device link token has already been used'}}),
    );
    jest.spyOn(Linking, 'getInitialURL').mockResolvedValue(DEVICE_LINK_URL);
    const second = render(<ConnectScreen />);
    await waitFor(() => expect(screen.getByTestId('device-link-failure')).toBeTruthy());
    expect(screen.getByText(DEVICE_LINK_USED_COPY)).toBeTruthy();
    second.unmount();

    jest.spyOn(Linking, 'getInitialURL').mockResolvedValue('oort://link?token=nope');
    const third = render(<ConnectScreen />);
    await waitFor(() => expect(screen.getByTestId('device-link-failure')).toBeTruthy());
    expect(screen.getByText(DEVICE_LINK_MALFORMED_COPY)).toBeTruthy();
    const sentences = new Set([
      DEVICE_LINK_EXPIRED_COPY,
      DEVICE_LINK_USED_COPY,
      DEVICE_LINK_MALFORMED_COPY,
    ]);
    expect(sentences.size).toBe(3);
    third.unmount();
  });

  it('shows the server-provided SAS digits and waits until activation', async () => {
    jest.spyOn(Linking, 'getInitialURL').mockResolvedValue(DEVICE_LINK_URL);
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/v1/auth/device-link/redeem')) {
        return jsonResponse(200, {
          ...LOGIN_BODY,
          pendingSas: true,
          sas: '4821',
        });
      }
      if (String(url).includes('/v1/workspaces/')) {
        return jsonResponse(401, {error: {message: 'token has not been activated'}});
      }
      return jsonResponse(500, {error: {message: 'unexpected'}});
    });

    render(<ConnectScreen />);

    await waitFor(() => expect(screen.getByTestId('device-link-sas')).toBeTruthy());
    expect(screen.getByTestId('device-link-sas-digits')).toHaveTextContent('4821');
    expect(screen.getByText(DEVICE_LINK_SAS_WAIT_COPY)).toBeTruthy();
    await keychainSettled();
    expect(keychainItems.size).toBe(0);

    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/v1/workspaces/')) {
        return jsonResponse(200, {channels: []});
      }
      return jsonResponse(500, {error: {message: 'unexpected'}});
    });
    fireEvent.press(screen.getByTestId('device-link-sas-retry'));
    await keychainSettled();
    await waitFor(() =>
      expect(keychainItems.get('app.momo.ios.rn.session')?.password).toBe(
        'refresh-token-device-link',
      ),
    );
  });

  it('never writes the voucher literal to MMKV or console', async () => {
    const capture = attachConsoleCapture();
    jest.spyOn(Linking, 'getInitialURL').mockResolvedValue(DEVICE_LINK_URL);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        ...LOGIN_BODY,
        pendingSas: false,
      }),
    );

    render(<ConnectScreen />);
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(call => String(call[0]).includes('/redeem'))).toBe(
        true,
      ),
    );
    await keychainSettled();

    const leakedStore =
      storeHoldsLiteral(DEVICE_LINK_TOKEN) ||
      storeHoldsLiteral(LOGIN_BODY.accessToken) ||
      storeHoldsLiteral(LOGIN_BODY.refreshToken);
    const leakedLogs =
      captureHoldsLiteral(capture.lines, DEVICE_LINK_TOKEN) ||
      captureHoldsLiteral(capture.lines, LOGIN_BODY.accessToken) ||
      captureHoldsLiteral(capture.lines, LOGIN_BODY.refreshToken);
    capture.restore();
    expect(leakedStore).toBe(false);
    expect(leakedLogs).toBe(false);
  });
});
