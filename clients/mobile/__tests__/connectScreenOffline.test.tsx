import NetInfo from '@react-native-community/netinfo';
import type {LocalePreferencePort} from '@momo/core/i18n';
import {act, fireEvent, render, screen, waitFor} from '@testing-library/react-native';
import React from 'react';
import {Linking} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {createMobileLocaleController} from '../src/i18n/controller';
import {MobileLocaleProvider} from '../src/i18n/LocaleProvider';
import ConnectScreen from '../src/screens/ConnectScreen';
import {__resetSessionStore} from '../src/storage/secureSession';
import {__resetServerBaseCache} from '../src/storage/serverBase';

// =============================================================================
// 로그인 전 화면(`ConnectScreen`)의 오프라인 안내는 사전(ko·en)에서 온다 (#5262, #5222 후속).
//
// 이 화면은 연결 공급자가 서기 전이라 NetInfo 를 직접 읽고, 안내 문구는 코드에 직접 적혀 있었다(「오프라인입니다.」 …). 이제 제목은 연결 카드와 같은
// 사전 키(`connection.card.offlineTitle`)이고, 설명은 로그인 전 화면에 맞는 키다(카드의 「받아 둔 내용만 보여요」는 받아 둔 것이 없는 이 화면에 거짓이다).
// 같은 장면이 영어 기기에서는 영어로 나온다.
// =============================================================================

const netInfo = NetInfo as unknown as {__emit: (state: unknown) => void};
const mmkvStore = (
  jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}
).__store;
const keychainItems = (
  jest.requireMock('react-native-keychain') as {
    __items: Map<string, {password: string; options: {accessible?: string}}>;
  }
).__items;

function port(language: string): LocalePreferencePort {
  return {
    readPreference: () => 'system',
    writePreference: () => {},
    readDevice: () => ({languages: [language], timeZone: 'UTC'}),
  };
}

beforeEach(() => {
  mmkvStore.clear();
  keychainItems.clear();
  __resetSessionStore();
  __resetServerBaseCache();
  globalThis.fetch = jest.fn() as unknown as typeof fetch;
  jest.spyOn(Linking, 'getInitialURL').mockResolvedValue(null);
});
afterEach(() => {
  jest.restoreAllMocks();
});

async function renderIn(language: string) {
  render(
    <MobileLocaleProvider
      createController={() => createMobileLocaleController({port: port(language)})}>
      <ConnectScreen />
    </MobileLocaleProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('connect-welcome')).toBeTruthy());
}
const goOffline = () =>
  act(() => netInfo.__emit({isConnected: false, isInternetReachable: false}));

describe.each([
  ['ko-KR', '오프라인이에요', '네트워크가 연결되면 다시 시도해 주세요.', '네트워크가 연결되면 QR을 찍을 수 있어요.'],
  ['en-US', "You're offline", "Try again once you're connected to a network.", "Once you're connected to a network, you can scan the QR code."],
])('%s 기기', (language, title, detail, qrDetail) => {
  it('환영 화면: 오프라인이면 QR 을 찍을 수 없는 까닭 한 줄이 사전 문장이다', async () => {
    await renderIn(language);
    expect(screen.queryByTestId('connect-offline')).toBeNull();
    await goOffline();
    expect(screen.getByTestId('connect-offline')).toHaveTextContent(qrDetail, {exact: false});
  });

  it('주소로 로그인하는 폼: 오프라인이면 안내 상자의 제목과 설명이 사전 문장이다', async () => {
    await renderIn(language);
    fireEvent.press(screen.getByTestId('welcome-address'));
    expect(screen.queryByTestId('connect-offline')).toBeNull();
    await goOffline();
    const notice = screen.getByTestId('connect-offline');
    expect(notice).toHaveTextContent(title, {exact: false});
    expect(notice).toHaveTextContent(detail, {exact: false});
    // 옛 직접 문구는 어느 언어에도 남지 않는다.
    expect(notice).not.toHaveTextContent('오프라인입니다.', {exact: false});
    expect(notice).not.toHaveTextContent('다시 시도하세요.', {exact: false});
  });
});
