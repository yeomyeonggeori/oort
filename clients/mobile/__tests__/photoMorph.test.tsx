import {act, cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import {readFileSync} from 'fs';
import {join} from 'path';
import React, {useReducer} from 'react';
import {AccessibilityInfo, Pressable, Text} from 'react-native';

import {FixedScheme} from '../src/design/theme';
import {PhotoGridCard} from '../src/features/attachments/PhotoGridCard';
import {PhotoMorphFrame} from '../src/features/attachments/PhotoMorphFrame';
import {PHOTO_CARD, PHOTO_MORPH, photoCardSize} from '../src/features/attachments/photoCardDesign';
import {
  cardIsLive,
  menuIsInteractive,
  MORPH_START,
  morphPhase,
  morphReduce,
  type MorphState,
} from '../src/features/attachments/photoMorph';
import {nativePhotoPorts} from '../src/features/attachments/photosNative';
import {installAppClock} from './fixtures/fakeClock';

// =============================================================================
// 메뉴 → 사진 카드 변신 (#4181 Goal 3) — 상태 전이, 틀의 보간, 동작 줄이기, 그리고
// 「메뉴만 열어서는 권한 API 가 한 번도 불리지 않는다」(진짜 네이티브 포트로).
// =============================================================================

interface MediaLibraryMock {
  __reset: () => void;
  getPermissionsAsync: jest.Mock;
  requestPermissionsAsync: jest.Mock;
  getAssetsAsync: jest.Mock;
  addListener: jest.Mock;
  __state: {permission: unknown};
}
const mediaLibrary = jest.requireMock('expo-media-library/legacy') as MediaLibraryMock;

const MENU = {width: 216, height: 204};
const CARD = {width: 382, height: 372};
const MENU_RADIUS = 26;

afterEach(() => {
  cleanup();
  jest.useRealTimers();
  jest.restoreAllMocks();
});
beforeEach(() => {
  mediaLibrary.__reset();
  jest.clearAllMocks();
});

// 낭독에서 숨은 층도 읽어야 한다(`includeHiddenElements`) — 숨는 것이 이 시험들이 단정하는 사실이다.
function layer(testID: string) {
  return screen.getByTestId(testID, {includeHiddenElements: true});
}

function flat(testID: string): Record<string, unknown> {
  const style = layer(testID).props.style as unknown;
  const out: Record<string, unknown> = {};
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node !== null && typeof node === 'object') Object.assign(out, node);
  };
  walk(style);
  return out;
}

function frame(props: Partial<React.ComponentProps<typeof PhotoMorphFrame>> = {}) {
  return (
    <FixedScheme scheme="light">
      <PhotoMorphFrame
        target="menu"
        menuSize={MENU}
        menuRadius={MENU_RADIUS}
        cardSize={CARD}
        cardRadius={PHOTO_CARD.radius}
        menu={<Text>menu</Text>}
        card={<Text>card</Text>}
        {...props}
      />
    </FixedScheme>
  );
}

describe('상태 전이', () => {
  const step = (state: MorphState, ...events: Parameters<typeof morphReduce>[1][]) =>
    events.reduce(morphReduce, state);

  it('처음은 메뉴이고, 메뉴만 눌린다', () => {
    expect(MORPH_START).toEqual({target: 'menu', settled: true});
    expect(morphPhase(MORPH_START)).toBe('menu');
    expect(menuIsInteractive(MORPH_START)).toBe(true);
    expect(cardIsLive(MORPH_START)).toBe(false);
  });

  it('사진 → 펼치는 중 → 도착하면 카드', () => {
    const opening = step(MORPH_START, {type: 'open'});
    expect(morphPhase(opening)).toBe('opening');
    // 카드의 내용은 펼치기 시작부터 산다 — 권한 읽기가 이때 시작한다. 메뉴는 이미 눌리지 않는다.
    expect(cardIsLive(opening)).toBe(true);
    expect(menuIsInteractive(opening)).toBe(false);
    const card = step(opening, {type: 'settled', target: 'card'});
    expect(morphPhase(card)).toBe('card');
    expect(cardIsLive(card)).toBe(true);
  });

  it('뒤로 → 접는 중 → 도착하면 메뉴, 카드의 내용은 그때까지 산다', () => {
    const card = step(MORPH_START, {type: 'open'}, {type: 'settled', target: 'card'});
    const closing = step(card, {type: 'back'});
    expect(morphPhase(closing)).toBe('closing');
    expect(cardIsLive(closing)).toBe(true);
    expect(menuIsInteractive(closing)).toBe(false);
    const menu = step(closing, {type: 'settled', target: 'menu'});
    expect(morphPhase(menu)).toBe('menu');
    expect(cardIsLive(menu)).toBe(false);
    expect(menuIsInteractive(menu)).toBe(true);
  });

  it('펼치다 뒤로: 늦게 도착한 「카드에 닿았다」 신호는 접는 중을 카드로 만들지 못한다', () => {
    const closing = step(MORPH_START, {type: 'open'}, {type: 'back'});
    expect(morphPhase(closing)).toBe('closing');
    const stale = step(closing, {type: 'settled', target: 'card'});
    expect(stale).toBe(closing);
    expect(morphPhase(stale)).toBe('closing');
  });

  it('접다가 다시 사진: 지금 값에서 되감아 펼친다', () => {
    const reopened = step(
      MORPH_START,
      {type: 'open'},
      {type: 'settled', target: 'card'},
      {type: 'back'},
      {type: 'open'},
    );
    expect(morphPhase(reopened)).toBe('opening');
  });

  it('같은 방향을 두 번 눌러도 상태가 그대로다', () => {
    const opening = step(MORPH_START, {type: 'open'});
    expect(step(opening, {type: 'open'})).toBe(opening);
    expect(step(MORPH_START, {type: 'back'})).toBe(MORPH_START);
    const card = step(opening, {type: 'settled', target: 'card'});
    expect(step(card, {type: 'settled', target: 'card'})).toBe(card);
  });
});

describe('틀의 보간 — 폭·높이·모서리 하나의 진행 값', () => {
  it('진행 0 은 메뉴의 크기이고 메뉴 층만 보인다', () => {
    render(frame({pinnedProgress: 0}));
    expect(flat('photo-morph')).toMatchObject({
      width: MENU.width,
      height: MENU.height,
      borderRadius: MENU_RADIUS,
    });
    expect(flat('photo-morph-menu').opacity).toBe(1);
    expect(flat('photo-morph-card').opacity).toBe(0);
  });

  it('진행 1 은 카드의 크기이고 카드 층만 보인다', () => {
    render(frame({target: 'card', pinnedProgress: 1}));
    expect(flat('photo-morph')).toMatchObject({
      width: CARD.width,
      height: CARD.height,
      borderRadius: PHOTO_CARD.radius,
    });
    expect(flat('photo-morph-menu').opacity).toBe(0);
    expect(flat('photo-morph-card').opacity).toBe(1);
  });

  it('중간 프레임은 두 크기 사이이고 두 층이 겹쳐 비친다', () => {
    render(frame({target: 'card', pinnedProgress: 0.4}));
    const style = flat('photo-morph');
    expect(style.width as number).toBeGreaterThan(MENU.width);
    expect(style.width as number).toBeLessThan(CARD.width);
    expect(style.height as number).toBeGreaterThan(MENU.height);
    expect(style.height as number).toBeLessThan(CARD.height);
    const menuOpacity = flat('photo-morph-menu').opacity as number;
    const cardOpacity = flat('photo-morph-card').opacity as number;
    expect(menuOpacity).toBeGreaterThan(0);
    expect(menuOpacity).toBeLessThan(1);
    expect(cardOpacity).toBeGreaterThan(0);
    expect(cardOpacity).toBeLessThan(1);
    // 메뉴는 줄어들며 접혀 든다.
    const transform = flat('photo-morph-menu').transform as Array<Record<string, number>>;
    const scale = transform.find(entry => 'scale' in entry)?.scale as number;
    expect(scale).toBeLessThan(1);
    expect(scale).toBeGreaterThan(PHOTO_MORPH.menuEndScale);
  });

  it('보이지 않는 층은 눌리지도 낭독되지도 않는다', () => {
    const view = render(frame({pinnedProgress: 0}));
    expect(layer('photo-morph-card').props.pointerEvents).toBe('none');
    expect(layer('photo-morph-card').props.accessibilityElementsHidden).toBe(true);
    expect(layer('photo-morph-menu').props.pointerEvents).toBe('auto');
    view.rerender(frame({target: 'card', pinnedProgress: 1}));
    expect(layer('photo-morph-menu').props.pointerEvents).toBe('none');
    expect(layer('photo-morph-menu').props.accessibilityElementsHidden).toBe(true);
    expect(layer('photo-morph-card').props.pointerEvents).toBe('auto');
  });

  it('메뉴 층은 틀의 윗변에 붙어 올라간다(카드의 왼쪽 위로 접혀 든다)', () => {
    // 틀이 `p × (카드 − 메뉴)` 만큼 위로 자랄 때 메뉴 층도 그만큼 끌어올려야 윗변이 틀의 윗변에 붙는다.
    render(frame({target: 'card', pinnedProgress: 0.25}));
    const p = 0.25;
    const frameHeight = flat('photo-morph').height as number;
    const lift = (flat('photo-morph-menu').transform as Array<Record<string, number>>).find(
      entry => 'translateY' in entry,
    )?.translateY as number;
    expect(frameHeight).toBeCloseTo(MENU.height + p * (CARD.height - MENU.height), 5);
    // 메뉴 층의 윗변 = 틀 높이 − 메뉴 높이 + 끌어올림 = 0.
    expect(frameHeight - MENU.height + lift).toBeCloseTo(0, 5);
  });
});

describe('스프링 — 도착을 알린다', () => {
  it('사진을 누르면 카드로 자라 도착을 한 번 알린다', async () => {
    installAppClock();
    const onSettled = jest.fn();
    const view = render(frame({onSettled}));
    await act(async () => {
      jest.advanceTimersByTime(50);
    });
    view.rerender(frame({target: 'card', onSettled}));
    await act(async () => {
      jest.advanceTimersByTime(1500);
    });
    expect(onSettled).toHaveBeenCalledWith('card');
    expect(flat('photo-morph')).toMatchObject({width: CARD.width, height: CARD.height});
  });

  it('펼치다 뒤로 가면 펼침의 도착은 알리지 않고 메뉴의 도착만 알린다', async () => {
    installAppClock();
    const onSettled = jest.fn();
    const view = render(frame({onSettled}));
    await act(async () => {
      jest.advanceTimersByTime(50);
    });
    view.rerender(frame({target: 'card', onSettled}));
    await act(async () => {
      jest.advanceTimersByTime(60);
    });
    view.rerender(frame({target: 'menu', onSettled}));
    await act(async () => {
      jest.advanceTimersByTime(1500);
    });
    expect(onSettled.mock.calls.map(call => call[0])).toEqual(['menu']);
    expect(flat('photo-morph')).toMatchObject({width: MENU.width, height: MENU.height});
  });

  it('스프링은 JS 구동이다 — 폭·높이는 네이티브 드라이버로 움직일 수 없다', () => {
    // 이 한 줄을 `true` 로 바꾸면 기기에서 「Style property 'width' is not supported by native
    // animated module」 로 죽는다. jest 는 네이티브 드라이버를 흉내 내지 않으므로 소스로 못 박는다.
    const source = readFileSync(
      join(__dirname, '../src/features/attachments/PhotoMorphFrame.tsx'),
      'utf8',
    );
    expect(source).not.toMatch(/useNativeDriver:\s*true/);
    expect(source.match(/useNativeDriver:\s*false/g)?.length).toBe(2);
  });
});

describe('동작 줄이기 — 크기는 즉시, 두 층만 바뀐다', () => {
  it('켜져 있으면 크기가 바로 카드가 되고 층은 120ms 에 서로 바뀐다', async () => {
    installAppClock();
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
    const onSettled = jest.fn();
    const view = render(frame({onSettled}));
    await act(async () => {
      jest.advanceTimersByTime(10);
      await Promise.resolve();
    });
    view.rerender(frame({target: 'card', onSettled}));
    // 효과가 돈 직후: 크기는 이미 카드, 카드 층은 아직 완전히 서지 않았다.
    await act(async () => {
      await Promise.resolve();
    });
    expect(flat('photo-morph')).toMatchObject({width: CARD.width, height: CARD.height});
    expect(onSettled).not.toHaveBeenCalled();
    await act(async () => {
      jest.advanceTimersByTime(PHOTO_MORPH.fadeMs + 60);
    });
    expect(onSettled).toHaveBeenCalledWith('card');
    expect(flat('photo-morph-card').opacity).toBe(1);
    expect(flat('photo-morph-menu').opacity).toBe(0);
  });

  it('돌아올 때도 크기는 즉시 메뉴다', async () => {
    installAppClock();
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
    const view = render(frame({target: 'card'}));
    await act(async () => {
      jest.advanceTimersByTime(10);
      await Promise.resolve();
    });
    view.rerender(frame({target: 'menu'}));
    await act(async () => {
      await Promise.resolve();
    });
    expect(flat('photo-morph')).toMatchObject({width: MENU.width, height: MENU.height});
  });
});

describe('호스트 — 메뉴를 열고 사진으로 변신해도 권한은 「허용」 전에 묻지 않는다 (진짜 네이티브 포트)', () => {
  function Host({reduce = false}: {reduce?: boolean}): React.JSX.Element {
    const [state, dispatch] = useReducer(morphReduce, MORPH_START);
    return (
      <FixedScheme scheme="light">
        <Pressable
          accessibilityRole="button"
          onPress={() => dispatch({type: 'open'})}
          testID="open-photos">
          <Text>{reduce ? '사진' : '사진'}</Text>
        </Pressable>
        <PhotoMorphFrame
          target={state.target}
          menuSize={MENU}
          menuRadius={MENU_RADIUS}
          cardSize={photoCardSize({width: 402, height: 874})}
          cardRadius={PHOTO_CARD.radius}
          onSettled={target => dispatch({type: 'settled', target})}
          menu={<Text>메뉴</Text>}
          card={
            <PhotoGridCard
              ports={nativePhotoPorts}
              active={cardIsLive(state)}
              size={photoCardSize({width: 402, height: 874})}
              room={20}
              onBack={() => dispatch({type: 'back'})}
              onAttach={jest.fn()}
              onDone={() => dispatch({type: 'back'})}
              onOpenSystemPicker={jest.fn()}
            />
          }
        />
        <Text testID="phase">{morphPhase(state)}</Text>
      </FixedScheme>
    );
  }

  const counts = () => ({
    read: mediaLibrary.getPermissionsAsync.mock.calls.length,
    request: mediaLibrary.requestPermissionsAsync.mock.calls.length,
    list: mediaLibrary.getAssetsAsync.mock.calls.length,
    listen: mediaLibrary.addListener.mock.calls.length,
  });

  it('메뉴 상태(마운트·시간 경과)에서는 권한 API 호출이 0 이다', async () => {
    installAppClock();
    render(<Host />);
    await act(async () => {
      jest.advanceTimersByTime(2000);
      await Promise.resolve();
    });
    expect(screen.getByTestId('phase')).toHaveTextContent('menu');
    expect(counts()).toEqual({read: 0, request: 0, list: 0, listen: 0});
  });

  it('사진을 누르면 상태를 읽기만 하고, 「허용」을 눌러야 프롬프트가 뜬다', async () => {
    installAppClock();
    render(<Host />);
    await act(async () => {
      fireEvent.press(screen.getByTestId('open-photos'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(counts()).toMatchObject({read: 1, request: 0, list: 0});
    expect(screen.getByTestId('phase')).toHaveTextContent('opening');
    await act(async () => {
      jest.advanceTimersByTime(1500);
      await Promise.resolve();
    });
    expect(screen.getByTestId('phase')).toHaveTextContent('card');
    expect(screen.getByTestId('photo-pane-undetermined')).toBeTruthy();
    expect(counts().request).toBe(0);
    await act(async () => {
      fireEvent.press(screen.getByTestId('photo-allow'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(counts().request).toBe(1);
  });

  it('뒤로 가면 메뉴로 접히고, 카드가 사라진 뒤에는 포트를 더 부르지 않는다', async () => {
    installAppClock();
    render(<Host />);
    await act(async () => {
      fireEvent.press(screen.getByTestId('open-photos'));
      jest.advanceTimersByTime(1500);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('photo-back'));
      await Promise.resolve();
    });
    expect(screen.getByTestId('phase')).toHaveTextContent('closing');
    await act(async () => {
      jest.advanceTimersByTime(1500);
      await Promise.resolve();
    });
    expect(screen.getByTestId('phase')).toHaveTextContent('menu');
    const settled = counts();
    await act(async () => {
      jest.advanceTimersByTime(3000);
      await Promise.resolve();
    });
    expect(counts()).toEqual(settled);
  });
});
