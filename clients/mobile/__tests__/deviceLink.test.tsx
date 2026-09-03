import {act, fireEvent, render, screen, waitFor} from '@testing-library/react-native';
import React from 'react';
import {Linking} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {
  DEVICE_LINK_EXPIRED_COPY,
  DEVICE_LINK_MALFORMED_COPY,
  DEVICE_LINK_SAS_WAIT_COPY,
  DEVICE_LINK_TOKEN_LEN,
  DEVICE_LINK_UNREACHABLE_COPY,
  DEVICE_LINK_USED_COPY,
} from '@momo/core/features/auth/deviceLinkModel';
import {parseDeviceLinkDeepLink} from '@momo/core/features/auth/deepLink';

import ConnectScreen from '../src/screens/ConnectScreen';
import {deviceLinkDevice} from '../src/features/deviceLink/deviceIdentity';
import {focusTextInput} from '../src/features/deviceLink/focusTextInput';
import {__resetSessionStore, keychainSettled} from '../src/storage/secureSession';
import {__resetServerBaseCache} from '../src/storage/serverBase';

jest.mock('../src/features/deviceLink/focusTextInput', () => ({
  focusTextInput: jest.fn(),
}));

// =============================================================================
// M0m / #1990 — device-link on the phone (ADR-0180 D2·D3·D4·D7).
//
// The voucher literal used to prove "it never lands in MMKV or logs" is local
// to this file. Assertions about leakage report only a boolean so a failure
// does not reprint the voucher into the test output.
// =============================================================================

const DEVICE_LINK_TOKEN = 'dEv1c3L1nkT0kenF1xtureDoN0tL0gOrSt0reXXXXXX';
const SERVER = 'https://oort-production-4f2a.up.railway.app';
const ENCODED_SERVER = 'https%3A%2F%2Foort-production-4f2a.up.railway.app';
const DEVICE_LINK_URL = `oort://link?server=${ENCODED_SERVER}&token=${DEVICE_LINK_TOKEN}`;
const STORED_SERVER_A = 'https://a.example.com';
const SERVER_B = 'https://oort-production-4f2a.up.railway.app';
const ENCODED_SERVER_B = 'https%3A%2F%2Foort-production-4f2a.up.railway.app';
const DEVICE_LINK_URL_B = `oort://link?server=${ENCODED_SERVER_B}&token=${DEVICE_LINK_TOKEN}`;

const LOGIN_BODY = {
  accessToken: 'access-token-device-link',
  refreshToken: 'refresh-token-device-link',
  realtimeWebSocketUrl: 'wss://oort-production-4f2a.up.railway.app/connection/websocket',
  member: {
    id: '11111111-1111-4111-8111-111111111111',
    workspaceId: '22222222-2222-4222-8222-222222222222',
    kind: 'human',
    displayName: '곽성재 Seongjae Kwak 프로덕션 워크스페이스 멤버',
    handle: 'seongjae',
  },
};

const cameraMock = jest.requireMock('expo-camera') as {
  __state: {permission: {granted: boolean; canAskAgain: boolean; status: string}};
  __reset: () => void;
  __scan: (data: string) => void;
};

const netInfoMock = (
  jest.requireMock('@react-native-community/netinfo') as {
    default: {
      __emit: (state: {isConnected: boolean; isInternetReachable: boolean | null}) => void;
    };
  }
).default;

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
  cameraMock.__reset();
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
    await waitFor(
      () =>
        expect(keychainItems.get('app.momo.ios.rn.session')?.password).toBe(
          'refresh-token-device-link',
        ),
      {timeout: 5000},
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

async function renderPendingSas(sas = '4821'): Promise<void> {
  jest.spyOn(Linking, 'getInitialURL').mockResolvedValue(DEVICE_LINK_URL);
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url).endsWith('/v1/auth/device-link/redeem')) {
      return jsonResponse(200, {
        ...LOGIN_BODY,
        pendingSas: true,
        sas,
      });
    }
    if (String(url).includes('/v1/workspaces/')) {
      return jsonResponse(401, {error: {message: 'token has not been activated'}});
    }
    return jsonResponse(500, {error: {message: 'unexpected'}});
  });
  render(<ConnectScreen />);
  await waitFor(() => expect(screen.getByTestId('device-link-sas')).toBeTruthy());
}

describe('R2 B-1 SAS wait has an exit and a bounded poll', () => {
  it('shows 「QR 다시 찍기」 and pressing it opens the scanner', async () => {
    await renderPendingSas();
    expect(screen.getByText('QR 다시 찍기')).toBeTruthy();
    fireEvent.press(screen.getByTestId('device-link-sas-rescan'));
    await waitFor(() => expect(screen.getByTestId('qr-scanner-sheet')).toBeTruthy());
    expect(screen.queryByTestId('device-link-sas')).toBeNull();
  });

  it('sends 「주소로 연결」 to the form, not the scanner', async () => {
    await renderPendingSas();
    fireEvent.press(screen.getByTestId('device-link-address-fallback'));
    expect(screen.queryByTestId('qr-scanner-sheet')).toBeNull();
    expect(screen.getByTestId('server-url-input')).toBeTruthy();
    expect(screen.queryByTestId('device-link-sas')).toBeNull();
  });

  it('opens the scanner from the SAS expiry banner retry', async () => {
    jest.useFakeTimers();
    try {
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
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByTestId('device-link-sas')).toBeTruthy();
      await act(async () => {
        jest.advanceTimersByTime(120_000);
      });
      expect(screen.getByText(DEVICE_LINK_EXPIRED_COPY)).toBeTruthy();
      fireEvent.press(screen.getByTestId('device-link-failure-retry'));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByTestId('qr-scanner-sheet')).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('stops polling at the token TTL and speaks the expiry sentence', async () => {
    jest.useFakeTimers();
    try {
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
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByTestId('device-link-sas')).toBeTruthy();
      const before = jest.getTimerCount();
      await act(async () => {
        jest.advanceTimersByTime(120_000);
      });
      expect(screen.getByText(DEVICE_LINK_EXPIRED_COPY)).toBeTruthy();
      const afterExpiry = jest.getTimerCount();
      await act(async () => {
        jest.advanceTimersByTime(10_000);
      });
      expect(jest.getTimerCount()).toBe(afterExpiry);
      expect(afterExpiry).toBeLessThanOrEqual(before);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('R2 H-2 SAS offline and unreachable states', () => {
  it('renders the offline notice on the SAS screen', async () => {
    await renderPendingSas();
    act(() => {
      netInfoMock.__emit({isConnected: false, isInternetReachable: false});
    });
    expect(screen.getByTestId('connect-offline')).toBeTruthy();
  });

  it('keeps polling after one unreachable probe while online and activates on the next', async () => {
    jest.spyOn(Linking, 'getInitialURL').mockResolvedValue(DEVICE_LINK_URL);
    let probes = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/v1/auth/device-link/redeem')) {
        return jsonResponse(200, {
          ...LOGIN_BODY,
          pendingSas: true,
          sas: '4821',
        });
      }
      if (String(url).includes('/v1/workspaces/')) {
        probes += 1;
        if (probes === 1) throw new TypeError('Network request failed');
        return jsonResponse(200, {channels: []});
      }
      return jsonResponse(500, {error: {message: 'unexpected'}});
    });
    render(<ConnectScreen />);
    await waitFor(() => expect(screen.getByTestId('device-link-failure')).toBeTruthy());
    expect(screen.getByText(DEVICE_LINK_UNREACHABLE_COPY)).toBeTruthy();
    await waitFor(
      () => expect(keychainItems.size).toBeGreaterThan(0),
      {timeout: 8000},
    );
    expect(probes).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(DEVICE_LINK_UNREACHABLE_COPY)).toBeNull();
  }, 10000);
});

describe('R2 M-2 permission is decided before the Modal', () => {
  it('does not mount the scanner; 「주소로 연결」 focuses in-app; only Settings opens Settings', async () => {
    cameraMock.__state.permission = {
      granted: false,
      canAskAgain: false,
      status: 'denied',
    };
    const openSettings = jest
      .spyOn(Linking, 'openSettings')
      .mockResolvedValue(undefined as never);
    render(<ConnectScreen />);
    fireEvent.press(screen.getByTestId('qr-connect-button'));
    await waitFor(() => expect(screen.getByTestId('qr-permission-denied')).toBeTruthy());
    expect(screen.queryByTestId('qr-scanner-sheet')).toBeNull();
    expect(screen.getByTestId('server-url-input').props.autoFocus).toBeFalsy();
    expect(screen.getByTestId('qr-permission-fallback')).toBeTruthy();

    const focus = focusTextInput as jest.Mock;
    focus.mockClear();
    fireEvent.press(screen.getByTestId('qr-permission-fallback'));
    expect(openSettings).toHaveBeenCalledTimes(0);
    expect(focus).toHaveBeenCalled();

    fireEvent.press(screen.getByTestId('qr-permission-settings'));
    expect(openSettings).toHaveBeenCalledTimes(1);
  });
});

describe('R3 M-6 device name is the OS model', () => {
  it('sends expo-device modelName, falling back to the idiom string', () => {
    const Device = jest.requireMock('expo-device') as {modelName: string | null};
    Device.modelName = 'iPhone 17 Pro';
    expect(deviceLinkDevice()).toEqual({name: 'iPhone 17 Pro', platform: 'ios'});
    Device.modelName = null;
    expect(deviceLinkDevice().name).toMatch(/\(iOS\)$/);
    Device.modelName = `VeryLongModelNameThatExceedsTheServerDeviceLabelLimit ${'x'.repeat(80)}`;
    expect(deviceLinkDevice().name.length).toBeLessThanOrEqual(64);
  });
});

describe('R2 M-5 camera mock consumers', () => {
  it('opens the sheet from 「QR로 연결」 when permission is granted', async () => {
    render(<ConnectScreen />);
    fireEvent.press(screen.getByTestId('qr-connect-button'));
    await waitFor(() => expect(screen.getByTestId('qr-scanner-sheet')).toBeTruthy());
  });

  it('speaks the malformed sentence for a non-link QR and 「QR 다시 찍기」 reopens the sheet', async () => {
    render(<ConnectScreen />);
    fireEvent.press(screen.getByTestId('qr-connect-button'));
    await waitFor(() => expect(screen.getByTestId('qr-camera-view')).toBeTruthy());
    act(() => {
      cameraMock.__scan('https://example.com/not-a-link');
    });
    await waitFor(() => expect(screen.getByText(DEVICE_LINK_MALFORMED_COPY)).toBeTruthy());
    fireEvent.press(screen.getByText('QR 다시 찍기'));
    await waitFor(() => expect(screen.getByTestId('qr-scanner-sheet')).toBeTruthy());
  });
});

describe('R2 M-7 server base is not kept on a failed redeem', () => {
  it('keeps stored server A when a stale QR for server B returns 401', async () => {
    mmkvStore.set('momo.mobile.server.v1', STORED_SERVER_A);
    __resetServerBaseCache();
    jest.spyOn(Linking, 'getInitialURL').mockResolvedValue(DEVICE_LINK_URL_B);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, {error: {message: 'device link token is invalid'}}),
    );
    render(<ConnectScreen />);
    await waitFor(() => expect(screen.getByTestId('device-link-failure')).toBeTruthy());
    expect(screen.getByTestId('server-url-input').props.value).toBe(STORED_SERVER_A);
    expect(mmkvStore.get('momo.mobile.server.v1')).toBe(STORED_SERVER_A);
  });
});

