import {localeAutonyms, type LocalePreferencePort} from '@momo/core/i18n';
import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react-native';
import React from 'react';
import {Linking} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {ThemeProvider} from '../src/design/theme';
import {createMobileLocaleController, type MobileLocaleController} from '../src/i18n/controller';
import {LanguageSettingsPage} from '../src/i18n/LanguageSettings';
import {MobileLocaleProvider} from '../src/i18n/LocaleProvider';
import {createMobileLocalePort, MOBILE_LOCALE_KEY} from '../src/i18n/preferencePort';
import ConnectScreen from '../src/screens/ConnectScreen';
import {__resetSessionStore} from '../src/storage/secureSession';
import {__resetServerBaseCache} from '../src/storage/serverBase';

// =============================================================================
// 첫 화면의 언어 칩 (#4670): 칩 → 언어 시트 → 즉시 반영, 그리고 **설정 › 프로필 › 언어와 같은 값**.
//
// 칩과 설정 페이지가 **같은 컨트롤러**를 쓰는 한 트리에서, 칩으로 고른 뒤 (1) MMKV의 설정 칸(`oort.mobile.locale.v1`)에
// 같은 글자가 적혔고 (2) 설정 페이지가 같은 줄을 고른 것으로 말하며 (3) 두 곳의 선택지가 같은 목록인지를 잰다. 칩이 다른
// 칸에 쓰거나 다른 목록을 들고 있으면 이 단정이 깨진다.
// =============================================================================

const mmkvStore = (jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}).__store;
const controllers: MobileLocaleController[] = [];

async function controller(port: LocalePreferencePort = createMobileLocalePort()) {
  const next = await createMobileLocaleController({port});
  controllers.push(next);
  return next;
}

function firstScreen(current: MobileLocaleController) {
  return (
    <ThemeProvider>
      <MobileLocaleProvider createController={async () => current}>
        <ConnectScreen />
      </MobileLocaleProvider>
    </ThemeProvider>
  );
}

function settingsPage(current: MobileLocaleController) {
  return (
    <ThemeProvider>
      <MobileLocaleProvider createController={async () => current}>
        <LanguageSettingsPage onBack={() => {}} />
      </MobileLocaleProvider>
    </ThemeProvider>
  );
}

const chip = () => screen.getByTestId('language-chip');
/** 칩에 보이는 글자(자칭 표기). */
const chipShows = (name: string) => within(chip()).getByText(name);
const radioLabels = () => screen.getAllByRole('radio').map(row => row.props.accessibilityLabel);

beforeEach(() => {
  mmkvStore.clear();
  __resetSessionStore();
  __resetServerBaseCache();
  jest.spyOn(Linking, 'getInitialURL').mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  controllers.splice(0).forEach(current => current.dispose());
  jest.restoreAllMocks();
});

describe('언어 칩: 폰 (#4670)', () => {
  it('환영 화면과 로그인 폼 둘 다에 서고, 지금 쓰는 말을 자칭 표기로 말한다', async () => {
    const current = await controller();
    render(firstScreen(current));
    await screen.findByTestId('connect-welcome');
    expect(chipShows(localeAutonyms['ko-KR'])).toBeTruthy();
    expect(chip().props.accessibilityLabel).toBe('현재 언어: 한국어');
    expect(chip().props.accessibilityRole).toBe('button');

    fireEvent.press(screen.getByTestId('welcome-address'));
    expect(screen.getByTestId('language-chip')).toBeTruthy();
    expect(screen.queryByTestId('connect-welcome')).toBeNull();
  });

  it('칩에서 고르면 바로 바뀌고, 설정의 언어와 같은 값·같은 저장소다', async () => {
    const current = await controller();
    render(firstScreen(current));
    await screen.findByTestId('connect-welcome');

    fireEvent.press(chip());
    expect(await screen.findByTestId('language-sheet')).toBeTruthy();
    const inSheet = radioLabels();
    expect(inSheet).toEqual(['기기 언어 따르기', '한국어', 'English']);

    fireEvent.press(screen.getByTestId('language-en-US'));
    // 설정 페이지가 쓰는 바로 그 MMKV 칸에 같은 글자가 적혔다.
    await waitFor(() => expect(mmkvStore.get(MOBILE_LOCALE_KEY)).toBe('en-US'));
    expect(current.getSnapshot().preference).toBe('en-US');
    // 저장이 성공하면 시트가 내려간다.
    await waitFor(() => expect(screen.queryByTestId('language-sheet')).toBeNull());

    // 첫 화면이 즉시 따라왔다: 칩의 말과 사전에서 오는 문구(스위치 줄)가 영어다.
    expect(chipShows(localeAutonyms['en-US'])).toBeTruthy();
    expect(chip().props.accessibilityLabel).toBe('Current language: English');
    fireEvent.press(screen.getByTestId('welcome-address'));
    expect(screen.getByTestId('remember-email-row').props.accessibilityLabel).toBe('Remember my email');

    // 같은 컨트롤러 위의 설정 페이지가 같은 줄을 고른 것으로 말하고, 선택지는 시트와 같은 목록이다.
    screen.unmount();
    render(settingsPage(current));
    expect(await screen.findByTestId('language-en-US')).toBeSelected();
    expect(screen.getByTestId('language-system')).not.toBeSelected();
    expect(screen.getByTestId('language-ko-KR')).not.toBeSelected();
    expect(radioLabels()).toEqual(['Use device language', '한국어', 'English']);
  });

  it('저장에 실패하면 시트가 열린 채 이유와 다시 시도를 말하고, 성공해야 내려간다', async () => {
    const write = jest.fn().mockImplementationOnce(() => {
      throw new Error('disk detail');
    });
    const current = await controller({...createMobileLocalePort(), writePreference: write});
    render(firstScreen(current));
    await screen.findByTestId('connect-welcome');

    fireEvent.press(chip());
    fireEvent.press(await screen.findByTestId('language-en-US'));
    const retry = await screen.findByRole('button', {name: '다시 시도'});
    expect(screen.getByTestId('language-sheet')).toBeTruthy();
    expect(current.getSnapshot().preference).toBe('system');
    expect(mmkvStore.has(MOBILE_LOCALE_KEY)).toBe(false);
    expect(screen.queryByText('disk detail')).toBeNull();

    fireEvent.press(retry);
    await waitFor(() => expect(current.getSnapshot().preference).toBe('en-US'));
    await waitFor(() => expect(screen.queryByTestId('language-sheet')).toBeNull());
    expect(write).toHaveBeenNthCalledWith(2, 'en-US');
  });

  it('앱의 언어 서비스가 없는 격리 화면에서는 칩을 그리지 않는다', async () => {
    render(<ConnectScreen />);
    expect(await screen.findByTestId('connect-welcome')).toBeTruthy();
    expect(screen.queryByTestId('language-chip')).toBeNull();
  });
});
