// M3 알림 미리 안내 (#2820, ADR-0193 D8).
//
// 두 가지를 잰다.
//   1. 세션이 서도 알림 권한을 묻지 않는다(`requestPermissionsAsync` 0회). 예전의
//      `PushProvider`는 마운트되자마자 물었다. 그 호출을 되돌리면 이 파일이 빨갛다.
//   2. M3은 「아무도 묻지 않았을 때」만 선다. 허용·거부·provisional·ephemeral이면
//      건너뛴다. expo가 provisional을 일반 `status`에서 `undetermined`로 접으므로
//      iOS 원래 값을 보지 않으면 provisional에서 M3이 서고 이 파일이 빨갛다.
import type {Member} from '@momo/core/lib/api';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {act, fireEvent, render, screen, waitFor} from '@testing-library/react-native';
import * as Notifications from 'expo-notifications';
import React from 'react';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {NotificationPrimerGate} from '../src/features/onboarding/NotificationPrimer';
import {
  NOTIFY_CONTINUE_LABEL,
  NOTIFY_DETAIL,
  NOTIFY_LINE,
  noteConnectRoute,
  resetConnectRoute,
  shouldAskNotifications,
} from '../src/features/onboarding/phoneFlow';
import PushProvider from '../src/push/PushProvider';
import {SessionProvider} from '../src/session/useSession';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

const WS = '22222222-2222-4222-8222-222222222222';
const MEMBER: Member = {
  id: '11111111-1111-4111-8111-111111111111',
  workspaceId: WS,
  kind: 'human',
  displayName: 'Seongjae Kwak',
  handle: 'seongjae',
};

const getPermissions = Notifications.getPermissionsAsync as jest.Mock;
const requestPermissions = Notifications.requestPermissionsAsync as jest.Mock;

/** expo `NotificationPermissionsStatus`의 모양. iOS 값은 UNAuthorizationStatus. */
function settings(
  status: 'granted' | 'denied' | 'undetermined',
  iosStatus?: number,
) {
  return {
    status,
    granted: status === 'granted',
    canAskAgain: status !== 'denied',
    expires: 'never',
    ...(iosStatus === undefined ? {} : {ios: {status: iosStatus}}),
  };
}

const NOT_DETERMINED = 0;
const DENIED = 1;
const AUTHORIZED = 2;
const PROVISIONAL = 3;
const EPHEMERAL = 4;

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

beforeEach(() => {
  __resetSessionStore();
  __resetServerBaseCache();
  resetConnectRoute();
  setServerBase('https://api.example.com');
  sessionPort.applyLogin({
    accessToken: 'access-token-1',
    refreshToken: 'refresh-token-1',
    realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
    member: MEMBER,
  });
  globalThis.fetch = jest.fn(async () =>
    jsonResponse(200, {items: [], unreadTotal: 0}),
  ) as unknown as typeof fetch;
  getPermissions.mockReset();
  requestPermissions.mockReset();
  requestPermissions.mockResolvedValue(settings('granted', AUTHORIZED));
});

afterEach(() => {
  jest.restoreAllMocks();
});

function mount() {
  const client = new QueryClient({
    defaultOptions: {
      queries: {retry: false, gcTime: 0},
      mutations: {retry: false, gcTime: 0},
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <SessionProvider member={MEMBER}>
        <PushProvider>
          <NotificationPrimerGate />
        </PushProvider>
      </SessionProvider>
    </QueryClientProvider>,
  );
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

describe('shouldAskNotifications — M3 only when nobody has asked', () => {
  it.each([
    ['granted', settings('granted', AUTHORIZED), false],
    ['denied', settings('denied', DENIED), false],
    ['undetermined (iOS notDetermined)', settings('undetermined', NOT_DETERMINED), true],
    // expo folds these two into `undetermined` (ExpoNotificationsPermissionsRequester
    // `default:`); they are decided answers all the same.
    ['provisional', settings('undetermined', PROVISIONAL), false],
    ['ephemeral', settings('undetermined', EPHEMERAL), false],
    ['undetermined without an iOS value', settings('undetermined'), true],
  ])('%s', (_name, value, expected) => {
    expect(shouldAskNotifications(value)).toBe(expected);
  });
});

describe('PushProvider never asks on its own (#2820)', () => {
  it('reads the permission on sign-in and does not raise the iOS prompt', async () => {
    getPermissions.mockResolvedValue(settings('undetermined', NOT_DETERMINED));
    mount();
    await waitFor(() => expect(screen.getByTestId('notify-primer')).toBeTruthy());
    await settle();
    expect(getPermissions).toHaveBeenCalled();
    expect(requestPermissions).toHaveBeenCalledTimes(0);
  });
});

describe('M3 알림 미리 안내', () => {
  it('says the D8 sentences and has exactly one button, 「계속」', async () => {
    getPermissions.mockResolvedValue(settings('undetermined', NOT_DETERMINED));
    mount();
    await waitFor(() => expect(screen.getByTestId('notify-primer')).toBeTruthy());
    expect(screen.getByText(NOTIFY_LINE)).toBeTruthy();
    expect(screen.getByTestId('notify-primer-detail')).toHaveTextContent(NOTIFY_DETAIL);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveTextContent(NOTIFY_CONTINUE_LABEL);
    // HIG: no way out that skips the system prompt, and no label that reads like
    // the system's own buttons (the mockup's 「알림 켜기」/「나중에」, ADR-0193 D8).
    expect(buttons[0]).not.toHaveTextContent(/허용|나중에|알림 켜기/);
  });

  it('raises the iOS prompt only when 「계속」 is pressed, then gets out of the way', async () => {
    getPermissions.mockResolvedValue(settings('undetermined', NOT_DETERMINED));
    mount();
    await waitFor(() => expect(screen.getByTestId('notify-primer')).toBeTruthy());
    expect(requestPermissions).toHaveBeenCalledTimes(0);

    await act(async () => {
      fireEvent.press(screen.getByTestId('notify-primer-continue'));
    });
    await waitFor(() => expect(screen.queryByTestId('notify-primer')).toBeNull());
    expect(requestPermissions).toHaveBeenCalledTimes(1);
  });

  it('a refusal in the iOS prompt also lets the app through (4.5.4)', async () => {
    getPermissions.mockResolvedValue(settings('undetermined', NOT_DETERMINED));
    requestPermissions.mockResolvedValue(settings('denied', DENIED));
    mount();
    await waitFor(() => expect(screen.getByTestId('notify-primer')).toBeTruthy());
    await act(async () => {
      fireEvent.press(screen.getByTestId('notify-primer-continue'));
    });
    await waitFor(() => expect(screen.queryByTestId('notify-primer')).toBeNull());
  });

  it.each([
    ['granted', settings('granted', AUTHORIZED)],
    ['denied', settings('denied', DENIED)],
    ['provisional', settings('undetermined', PROVISIONAL)],
  ])('is skipped when the permission is already %s', async (_name, value) => {
    getPermissions.mockResolvedValue(value);
    mount();
    await settle();
    expect(getPermissions).toHaveBeenCalled();
    expect(screen.queryByTestId('notify-primer')).toBeNull();
    expect(requestPermissions).toHaveBeenCalledTimes(0);
  });

  it('continues the QR route’s progress dots: three steps, the third', async () => {
    noteConnectRoute('qr');
    getPermissions.mockResolvedValue(settings('undetermined', NOT_DETERMINED));
    mount();
    await waitFor(() => expect(screen.getByTestId('notify-primer')).toBeTruthy());
    expect(screen.getByTestId('onboarding-dots').props.accessibilityLabel).toBe(
      '3단계 중 3단계',
    );
  });

  it('shows no dots when the route is unknown (the app was relaunched)', async () => {
    getPermissions.mockResolvedValue(settings('undetermined', NOT_DETERMINED));
    mount();
    await waitFor(() => expect(screen.getByTestId('notify-primer')).toBeTruthy());
    expect(screen.queryByTestId('onboarding-dots')).toBeNull();
  });
});
