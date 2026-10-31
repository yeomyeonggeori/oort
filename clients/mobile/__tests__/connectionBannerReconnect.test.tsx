import React from 'react';
import {StyleSheet} from 'react-native';
import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react-native';
import type {LocalePreferencePort} from '@momo/core/i18n';
import type {RealtimeStatus} from '@momo/core/lib/realtimeEvents';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {FixedScheme} from '../src/design/theme';
import {TOUCH_TARGET} from '../src/design/tokens';
import {
  ConversationHeader,
  RECONNECT_NOW_LABEL,
} from '../src/features/conversation/ConversationHeader';
import {createMobileLocaleController} from '../src/i18n/controller';
import {MobileLocaleProvider} from '../src/i18n/LocaleProvider';

// =============================================================================
// #4895 — 끊김 띠를 누르면 「지금 다시 연결」. 사람이 화면을 잠갔다 켤 필요가 없어야 한다.
//
// 띠는 두 문장(「연결 중…」·「연결이 끊겼습니다」)이다. 눌리는 것은 **끊김뿐**이다: 연결 중은 이미
// 시도하는 중이라 누를 것이 없고, 열 것이 없는 단추는 만들지 않는다(`onReconnect` 가 없어도 같다).
// 눌리는 띠의 바깥은 여전히 손을 받지 않는다 — 알약 밑의 메시지가 눌려야 한다.
// =============================================================================

afterEach(() => cleanup());

function header(railStatus: RealtimeStatus, onReconnect?: () => void) {
  return (
    <FixedScheme scheme="light">
      <ConversationHeader
        title="대화"
        kind="dm"
        directory={makeDirectory([])}
        onBack={() => {}}
        railStatus={railStatus}
        onReconnect={onReconnect}
      />
    </FixedScheme>
  );
}

describe('끊김 띠', () => {
  it('끊겼을 때만 단추다: 이름은 「지금 다시 연결」, 지금 상태는 값, 누르면 한 번 부른다', () => {
    const onReconnect = jest.fn();
    render(header('disconnected', onReconnect));
    const banner = screen.getByTestId('connection-banner');
    expect(banner.props.accessibilityRole).toBe('button');
    expect(banner.props.accessibilityLabel).toBe('지금 다시 연결');
    expect(banner.props.accessibilityValue).toEqual({text: '연결이 끊겼습니다'});
    // 문장 뒤에 행동의 이름이 눈에 보이게 선다(#4982) - 낭독 라벨에만 있던 이름이다.
    expect(banner).toHaveTextContent('연결이 끊겼습니다지금 다시 연결');
    // 눌리는 것은 알약이다. 층은 손을 통과시킨다 — 알약 밖의 메시지는 그대로 눌린다.
    expect(screen.getByTestId('connection-banner-layer').props.pointerEvents).toBe('box-none');

    fireEvent.press(banner);
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  // #4982: 끊김 띠의 「지금 다시 연결」은 낭독 라벨에만 있었고(눈에는 문장 하나뿐), 눌리는 높이는 약 36(알약 29 + 위 여유 7)이었다.
  // JS 렌더러에는 레이아웃이 없으니 눌리는 상자를 **선언된 값**으로 잰다: 알약의 `minHeight` + 세로 `hitSlop` 이 엄지 바닥(44)이다.
  const flat = (style: unknown) => (StyleSheet.flatten(style as never) ?? {}) as Record<string, number | undefined>;
  const slop = (value: unknown) => {
    const found = (value ?? {}) as {top?: number; bottom?: number};
    return (found.top ?? 0) + (found.bottom ?? 0);
  };

  it('끊김 띠는 행동의 이름이 눈에 보이고 눌림 높이가 44 이상이다: 캡슐은 그림이고 눌리는 것은 띠 전체다', () => {
    const onReconnect = jest.fn();
    render(header('disconnected', onReconnect));
    const banner = screen.getByTestId('connection-banner');
    // 눌림 높이: 알약의 상자가 지고(`minHeight`), 슬롭으로 채우지 않는다.
    const box = flat(banner.props.style).minHeight ?? 0;
    expect(box).toBeGreaterThanOrEqual(TOUCH_TARGET);
    expect(box + slop(banner.props.hitSlop)).toBeGreaterThanOrEqual(TOUCH_TARGET);
    // 보이는 이름: 문장 옆 캡슐 안의 글자다.
    const action = within(banner).getByTestId('connection-banner-action');
    // 낭독 라벨과 같은 낱말이 **글자로도** 선다(보이는 글자가 이름에 들어 있다).
    expect(within(action).getByText('지금 다시 연결')).toBeTruthy();
    expect(banner.props.accessibilityLabel).toBe('지금 다시 연결');
    // 캡슐은 그림이다: 손을 따로 받지 않고(Pressable 이 아니다) 눌러도 띠가 한 번 부른다.
    expect(action.props.onPress).toBeUndefined();
    fireEvent.press(within(action).getByText('지금 다시 연결'));
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it('연결 중 띠는 그대로다: 행동의 이름도 44 상자도 없다', () => {
    render(header('connecting', jest.fn()));
    const banner = screen.getByTestId('connection-banner');
    expect(within(banner).queryByTestId('connection-banner-action')).toBeNull();
    expect(screen.queryByText('지금 다시 연결')).toBeNull();
    expect(flat(banner.props.style).minHeight).toBeUndefined();
  });

  it('연결 중에는 누를 것이 없다: 문장만 서고 손은 받지 않는다', () => {
    const onReconnect = jest.fn();
    render(header('connecting', onReconnect));
    const banner = screen.getByTestId('connection-banner');
    expect(banner.props.accessibilityRole).toBe('text');
    expect(banner.props.accessibilityLabel).toBeUndefined();
    expect(screen.getByTestId('connection-banner-layer').props.pointerEvents).toBe('none');
    fireEvent.press(banner);
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it('열 것이 없으면 끊김도 문장만 선다 — 누르면 아무 일도 없는 단추는 만들지 않는다', () => {
    render(header('disconnected'));
    const banner = screen.getByTestId('connection-banner');
    expect(banner.props.accessibilityRole).toBe('text');
    expect(screen.getByTestId('connection-banner-layer').props.pointerEvents).toBe('none');
  });

  it('연결되면 띠가 없다', () => {
    render(header('connected', jest.fn()));
    expect(screen.queryByTestId('connection-banner')).toBeNull();
    expect(screen.queryByTestId('connection-banner-layer')).toBeNull();
  });
});

describe('이름은 사전(ko·en)에서 온다', () => {
  function port(language: string): LocalePreferencePort {
    return {
      readPreference: () => 'system',
      writePreference: () => {},
      readDevice: () => ({languages: [language], timeZone: 'UTC'}),
    };
  }

  async function labelIn(language: string): Promise<string> {
    render(
      <MobileLocaleProvider
        createController={() => createMobileLocaleController({port: port(language)})}>
        {header('disconnected', () => {})}
      </MobileLocaleProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('connection-banner')).toBeTruthy());
    return screen.getByTestId('connection-banner').props.accessibilityLabel as string;
  }

  it('영어 기기는 「Reconnect now」 - 눈에 보이는 글자도 같은 낱말이다', async () => {
    expect(await labelIn('en-US')).toBe('Reconnect now');
    expect(within(screen.getByTestId('connection-banner-action')).getByText('Reconnect now')).toBeTruthy();
  });

  it('한국어 기기는 「지금 다시 연결」', async () => {
    expect(await labelIn('ko-KR')).toBe('지금 다시 연결');
  });

  it('사전 없이 올라오는 격리 하네스의 폴백은 사전의 한국어와 같은 낱말이다', async () => {
    expect(RECONNECT_NOW_LABEL).toBe('지금 다시 연결');
    expect(await labelIn('ko-KR')).toBe(RECONNECT_NOW_LABEL);
  });
});
