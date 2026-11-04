import React from 'react';
import {StyleSheet} from 'react-native';
import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react-native';
import type {LocalePreferencePort} from '@momo/core/i18n';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {FixedScheme} from '../src/design/theme';
import {TOUCH_TARGET} from '../src/design/tokens';
import {ConversationHeader} from '../src/features/conversation/ConversationHeader';
import {createMobileLocaleController} from '../src/i18n/controller';
import {MobileLocaleProvider} from '../src/i18n/LocaleProvider';
import {
  connectedScene,
  connectingScene,
  offlineScene,
  quietScene,
  realtimeDownScene,
  recoveredScene,
  serverUnreachableScene,
  type BandScene,
} from './fixtures/connectionBand';

// =============================================================================
// #4895 — 끊김 띠를 누르면 「지금 다시 연결」. 사람이 화면을 잠갔다 켤 필요가 없어야 한다.
// #5222 — 띠가 말하는 것은 코어 연결 상태 모델이 정한다(원인별 문장 · 마크 · 행동). 이 파일은 머리가 그것을 **그리기만** 하는지 잰다.
//
// 눌리는 것은 모델이 행동을 줄 때뿐이다(실시간만 끊김 · 서버에 닿지 못함): 연결 중은 이미 시도하는 중이고 기기 오프라인은 누를 것이 없다.
// 열 것이 없는 단추는 만들지 않는다(`onReconnect` 가 없어도 같다). 눌리는 띠의 바깥은 여전히 손을 받지 않는다 — 알약 밑의 메시지가 눌려야 한다.
// 장면은 손으로 지은 문장이 아니라 실제 코어 모델에 사건을 먹여 만든다(`fixtures/connectionBand.ts`).
// =============================================================================

afterEach(() => cleanup());

function header(scene: BandScene, onReconnect?: () => void) {
  return (
    <FixedScheme scheme="light">
      <ConversationHeader
        title="대화"
        kind="dm"
        directory={makeDirectory([])}
        onBack={() => {}}
        band={scene.band}
        onReconnect={onReconnect}
      />
    </FixedScheme>
  );
}

describe('끊김 띠', () => {
  it('실시간만 끊겼을 때 단추다: 이름은 「지금 다시 연결」, 지금 상태는 값, 누르면 한 번 부른다', () => {
    const onReconnect = jest.fn();
    render(header(realtimeDownScene(), onReconnect));
    const banner = screen.getByTestId('connection-banner');
    expect(banner.props.accessibilityRole).toBe('button');
    expect(banner.props.accessibilityLabel).toBe('지금 다시 연결');
    // 눈에는 제목 한 줄, 설명은 낭독 값에 실린다(감사 문서 §6.2 P2: 한 줄 안에 원인 문장과 행동 캡슐).
    expect(banner.props.accessibilityValue).toEqual({
      text: '실시간 연결이 끊겼어요. 새 글이 늦게 보일 수 있어요.',
    });
    // 문장 뒤에 행동의 이름이 눈에 보이게 선다(#4982) - 낭독 라벨에만 있던 이름이다.
    expect(banner).toHaveTextContent('실시간 연결이 끊겼어요지금 다시 연결');
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
    render(header(realtimeDownScene(), onReconnect));
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

  it('서버에 닿지 못함도 단추다: 원인 문장이 다르고 같은 행동을 준다', () => {
    const onReconnect = jest.fn();
    render(header(serverUnreachableScene(), onReconnect));
    const banner = screen.getByTestId('connection-banner');
    expect(banner).toHaveTextContent('서버에 닿지 못했어요지금 다시 연결');
    expect(banner.props.accessibilityRole).toBe('button');
    expect(banner.props.accessibilityValue).toEqual({
      text: '서버에 닿지 못했어요. 잠시 뒤 다시 시도할게요.',
    });
    fireEvent.press(banner);
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it('기기 오프라인은 단추가 없다: 곧바로 서고, 마크는 멈춰 있고, 눌러도 아무 일이 없다', () => {
    const onReconnect = jest.fn();
    render(header(offlineScene(), onReconnect));
    const banner = screen.getByTestId('connection-banner');
    expect(banner).toHaveTextContent('오프라인이에요');
    expect(banner.props.accessibilityRole).toBe('text');
    expect(within(banner).queryByTestId('connection-banner-action')).toBeNull();
    expect(screen.getByTestId('connection-banner-layer').props.pointerEvents).toBe('none');
    fireEvent.press(banner);
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it('연결 중 띠는 그대로다: 행동의 이름도 44 상자도 없다', () => {
    render(header(connectingScene(), jest.fn()));
    const banner = screen.getByTestId('connection-banner');
    expect(banner).toHaveTextContent('연결 중…');
    expect(within(banner).queryByTestId('connection-banner-action')).toBeNull();
    expect(screen.queryByText('지금 다시 연결')).toBeNull();
    expect(flat(banner.props.style).minHeight).toBeUndefined();
  });

  it('연결 중에는 누를 것이 없다: 문장만 서고 손은 받지 않는다', () => {
    const onReconnect = jest.fn();
    render(header(connectingScene(), onReconnect));
    const banner = screen.getByTestId('connection-banner');
    expect(banner.props.accessibilityRole).toBe('text');
    expect(banner.props.accessibilityLabel).toBeUndefined();
    expect(screen.getByTestId('connection-banner-layer').props.pointerEvents).toBe('none');
    fireEvent.press(banner);
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it('열 것이 없으면 끊김도 문장만 선다 — 누르면 아무 일도 없는 단추는 만들지 않는다', () => {
    render(header(realtimeDownScene()));
    const banner = screen.getByTestId('connection-banner');
    expect(banner.props.accessibilityRole).toBe('text');
    expect(screen.getByTestId('connection-banner-layer').props.pointerEvents).toBe('none');
  });

  it('돌아온 직후 2초는 확인 표시다: 문장 「다시 연결됐어요」, 단추 없음, 로더 없음', () => {
    render(header(recoveredScene(), jest.fn()));
    const banner = screen.getByTestId('connection-banner');
    expect(banner).toHaveTextContent('다시 연결됐어요');
    expect(within(banner).getByTestId('connection-check')).toBeTruthy();
    expect(within(banner).queryByTestId('connection-loader', {includeHiddenElements: true})).toBeNull();
    expect(within(banner).queryByTestId('connection-banner-action')).toBeNull();
    expect(banner.props.accessibilityRole).toBe('text');
  });

  it.each([
    ['연결된 소켓', connectedScene],
    ['끊긴 지 1초가 안 된 소켓(침묵)', quietScene],
  ])('%s 은 띠가 없다', (_name, make) => {
    render(header(make(), jest.fn()));
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

  async function bannerIn(language: string, scene: BandScene) {
    render(
      <MobileLocaleProvider
        createController={() => createMobileLocaleController({port: port(language)})}>
        {header(scene, () => {})}
      </MobileLocaleProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('connection-banner')).toBeTruthy());
    return screen.getByTestId('connection-banner');
  }

  it('영어 기기는 「Reconnect now」 - 눈에 보이는 글자도 같은 낱말이다', async () => {
    const banner = await bannerIn('en-US', realtimeDownScene());
    expect(banner.props.accessibilityLabel).toBe('Reconnect now');
    expect(within(screen.getByTestId('connection-banner-action')).getByText('Reconnect now')).toBeTruthy();
  });

  it.each([
    ['오프라인', offlineScene, "You're offline"],
    ['서버에 닿지 못함', serverUnreachableScene, "Can't reach the server"],
    ['실시간만 끊김', realtimeDownScene, 'Live connection lost'],
    ['돌아옴', recoveredScene, 'Reconnected'],
  ])('영어 기기의 원인 문장은 sentence case 다: %s', async (_name, make, sentence) => {
    expect(await bannerIn('en-US', make())).toHaveTextContent(sentence, {exact: false});
  });

  it('한국어 기기는 「지금 다시 연결」', async () => {
    const banner = await bannerIn('ko-KR', realtimeDownScene());
    expect(banner.props.accessibilityLabel).toBe('지금 다시 연결');
  });
});
