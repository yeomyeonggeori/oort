import {localeAutonyms, type LocalePreferencePort} from '@momo/core/i18n';
import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react-native';
import React from 'react';
import {Linking, StyleSheet} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {HOME_ICON_SIZE, HOME_ICONS} from '../src/design/icons';
import {ListRow} from '../src/design/sheetParts';
import {FixedScheme, ThemeProvider} from '../src/design/theme';
import {darkPalette, lightPalette} from '../src/design/tokens';
import {OnboardingGhostButton} from '../src/features/onboarding/OnboardingControls';
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

// =============================================================================
// 검증 줄 2회차 화면 검수(#5101): L1 칩의 「고른다」 표지, L2 언어 목록 카드의 줄 사이 구분선.
// 값으로 잰다 — 글리프의 출처(ListRow 펼침과 같은 PNG)·크기·색 역할, 구분선 개수와 자리.
// =============================================================================
describe('언어 칩 다듬기 (#5101)', () => {
  const expandOf = (id: string) => screen.getByTestId(`${id}-expand`, {includeHiddenElements: true});
  const flat = (node: {props: {style?: unknown}}) => StyleSheet.flatten(node.props.style as never) as Record<string, unknown>;

  it('L1: 첫 화면 칩 뒤에 ⌄ 가 붙는다 — 이미 있는 펼침 글리프(ListRow와 같은 PNG·크기)이고 글자와 같은 색 역할이며, 낭독에서 빠지고, 「뒤로」에는 없다', async () => {
    // 1) 제품의 칩: 환영 화면(M0)과 로그인 폼(M-b) 둘 다 ⌄ 를 내고, 낭독 이름은 그대로다.
    const current = await controller();
    render(firstScreen(current));
    await screen.findByTestId('connect-welcome');
    const glyph = within(chip()).getByTestId('language-chip-expand', {includeHiddenElements: true});
    expect(glyph.props.source).toBe(HOME_ICONS.down);
    expect(glyph.props.accessibilityElementsHidden).toBe(true);
    expect(flat(chip()).flexDirection).toBe('row');
    expect(chip().props.accessibilityLabel).toBe('현재 언어: 한국어');
    fireEvent.press(screen.getByTestId('welcome-address'));
    expect(within(chip()).getByTestId('language-chip-expand', {includeHiddenElements: true})).toBeTruthy();
    screen.unmount();

    // 2) 부품: 같은 PNG·같은 크기(ListRow 펼침 행과 나란히), 고르는 단추가 아닌 「뒤로」에는 글리프도 줄 배치도 없다.
    render(
      <ThemeProvider>
        <ListRow title="행" accessory="expand" onPress={() => {}} testID="row" />
        <OnboardingGhostButton label="한국어" accessory="expand" onPress={() => {}} testID="probe" />
        <OnboardingGhostButton label="뒤로" onPress={() => {}} testID="back" />
      </ThemeProvider>,
    );
    const row = expandOf('row');
    const probe = expandOf('probe');
    expect(probe.props.source).toBe(row.props.source);
    expect({width: flat(probe).width, height: flat(probe).height}).toEqual({width: flat(row).width, height: flat(row).height});
    expect(flat(probe).width).toBe(HOME_ICON_SIZE.down);
    expect(screen.queryByTestId('back-expand', {includeHiddenElements: true})).toBeNull();
    expect(flat(screen.getByTestId('back')).flexDirection).toBeUndefined();
    screen.unmount();

    // 3) 색 역할: ⌄ 는 곁의 글자와 같은 textMuted 이고, 밝음·어두움 모두 그렇다.
    for (const [scheme, palette] of [['light', lightPalette], ['dark', darkPalette]] as const) {
      render(
        <FixedScheme scheme={scheme}>
          <OnboardingGhostButton label="한국어" accessory="expand" onPress={() => {}} testID="probe" />
        </FixedScheme>,
      );
      const label = within(screen.getByTestId('probe')).getByText('한국어');
      expect([scheme, flat(label).color]).toEqual([scheme, palette.textMuted]);
      expect([scheme, flat(expandOf('probe')).tintColor]).toEqual([scheme, palette.textMuted]);
      screen.unmount();
    }
  });

  it('L2: 언어 목록 카드는 줄 사이에 구분선이 선다 — 시트와 설정 페이지 모두, 라디오 묶음은 그대로 셋을 품는다', async () => {
    const current = await controller();
    render(firstScreen(current));
    await screen.findByTestId('connect-welcome');

    fireEvent.press(chip());
    const sheet = await screen.findByTestId('language-sheet');
    // 선택지가 셋(기기 언어 · 한국어 · English)이니 줄 사이 선은 둘이고, 선은 묶음 안(줄 사이)에 선다.
    const group = within(sheet).getByTestId('language-radiogroup');
    expect(group.props).toMatchObject({accessibilityRole: 'radiogroup', accessibilityLabel: '언어'});
    expect(within(group).getAllByRole('radio')).toHaveLength(3);
    expect(within(group).getAllByTestId('group-divider')).toHaveLength(2);
    expect(within(sheet).getAllByTestId('group-divider')).toHaveLength(2);

    screen.unmount();
    render(settingsPage(current));
    await screen.findByTestId('language-en-US');
    const page = within(screen.getByTestId('settings-language-page'));
    expect(within(page.getByTestId('language-radiogroup')).getAllByRole('radio')).toHaveLength(3);
    expect(page.getAllByTestId('group-divider')).toHaveLength(2);
  });
});
