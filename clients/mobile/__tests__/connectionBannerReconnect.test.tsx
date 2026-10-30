import React from 'react';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react-native';
import type {LocalePreferencePort} from '@momo/core/i18n';
import type {RealtimeStatus} from '@momo/core/lib/realtimeEvents';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {FixedScheme} from '../src/design/theme';
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
    expect(banner).toHaveTextContent('연결이 끊겼습니다');
    // 눌리는 것은 알약이다. 층은 손을 통과시킨다 — 알약 밖의 메시지는 그대로 눌린다.
    expect(screen.getByTestId('connection-banner-layer').props.pointerEvents).toBe('box-none');

    fireEvent.press(banner);
    expect(onReconnect).toHaveBeenCalledTimes(1);
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

  it('영어 기기는 「Reconnect now」', async () => {
    expect(await labelIn('en-US')).toBe('Reconnect now');
  });

  it('한국어 기기는 「지금 다시 연결」', async () => {
    expect(await labelIn('ko-KR')).toBe('지금 다시 연결');
  });

  it('사전 없이 올라오는 격리 하네스의 폴백은 사전의 한국어와 같은 낱말이다', async () => {
    expect(RECONNECT_NOW_LABEL).toBe('지금 다시 연결');
    expect(await labelIn('ko-KR')).toBe(RECONNECT_NOW_LABEL);
  });
});
