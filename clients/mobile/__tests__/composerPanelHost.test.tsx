import {act, cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';
import {Dimensions, Keyboard, LayoutAnimation, StyleSheet, View} from 'react-native';
import {
  HANDOFF_MAX_MS,
  useComposerPanel,
  type ComposerPanelApi,
} from '../src/features/conversation/composerPanel';
import {ConversationLayout, KEYBOARD_GAP, restingBottomPadding} from '../src/features/conversation/ConversationLayout';
import {pinReduceMotion} from './fixtures/reduceMotion';

// =============================================================================
// 키보드 자리의 창을 서게 하는 레이아웃 (#5452). 입력창이 키보드 ↔ 창을 오가는 동안 1pt 도 안 움직이려면(owner 11-07) 한 커밋에 세 가지가 맞아야 한다:
//   ① 네이티브 리프트를 눕힌다(`bottomInset` 이 키보드 높이 이상이면 `키보드 높이 - bottomInset` 이 0) ② 도크 밑에 같은 높이의 빈 칸 ③ 목록을 같은 만큼 위로.
// 이 시험이 재는 것은 그 산수와 맞바꿈의 차례다. 실제 픽셀(입력창 y)은 시뮬레이터가 잰다(`measure/panel-steady.py`).
// =============================================================================

const KEYBOARD = 336;
const WINDOW = {width: 402, height: 874, scale: 3, fontScale: 1};
type Emitter = {emit: (event: string, payload: unknown) => void};
const emitter = () => (Keyboard as unknown as {_emitter: Emitter})._emitter;
const shown = (height = KEYBOARD) => ({endCoordinates: {height, screenX: 0, screenY: 0, width: 402}, duration: 250, easing: 'keyboard'});

let api: ComposerPanelApi | null = null;
function Probe() {
  api = useComposerPanel();
  return <View testID="probe" />;
}
const flat = (style: unknown) => (StyleSheet.flatten(style as never) ?? {}) as Record<string, number | string | undefined>;
const pane = () => screen.getByTestId('conversation-layout');
const listStyle = () => flat(screen.getByTestId('conversation-list').props.style);

let insets: jest.SpyInstance;
let release: (() => void) | undefined;
beforeEach(async () => {
  Dimensions.set({window: WINDOW, screen: WINDOW});
  insets = jest
    .spyOn(require('react-native-safe-area-context'), 'useSafeAreaInsets')
    .mockReturnValue({top: 47, left: 0, right: 0, bottom: 34});
  release = await pinReduceMotion(true);
  api = null;
});
afterEach(() => {
  cleanup();
  insets.mockRestore();
  release?.();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

const mount = () => render(<ConversationLayout list={<View testID="list-slot" />} composer={<Probe />} />);
const open = (height = KEYBOARD) => act(() => api!.open(height));

describe('창이 닫혀 있는 동안은 옛 모양 그대로다', () => {
  it('`bottomInset`·목록 스타일에 덧붙는 것이 없고 창 요소도 없다', () => {
    mount();
    const resting = restingBottomPadding(34);
    expect(pane().props.bottomInset).toBe(resting - KEYBOARD_GAP);
    expect(listStyle().marginTop).toBeUndefined();
    expect(screen.queryByTestId('composer-panel')).toBeNull();
    expect(screen.queryByTestId('composer-panel-room')).toBeNull();
    expect(api!.phase).toBe('closed');
  });
});

describe('열기(키보드 → 창) — 한 렌더에 맞바꾼다', () => {
  it('네이티브 리프트는 0 이 되고(`키보드 높이 - bottomInset ≤ 0`), 도크 밑 빈 칸이 같은 만큼 서고, 목록이 그만큼 올라간다', () => {
    mount();
    open();
    const resting = restingBottomPadding(34);
    // ① 리프트 눕힘: 네이티브는 `max(키보드 높이 - bottomInset, 0)` 만큼 올린다.
    expect(Math.max(KEYBOARD - (pane().props.bottomInset as number), 0)).toBe(0);
    // ② 도크 밑 빈 칸 = 키보드가 올렸을 변환(= 키보드 높이 - (쉬는 여백 - 틈))과 같다.
    const keyboardLift = KEYBOARD - (resting - KEYBOARD_GAP);
    const room = flat(screen.getByTestId('composer-panel-room').props.style);
    expect(room.height).toBe(keyboardLift);
    // 도크의 바닥 자리: 키보드가 올라와 있을 때(화면 바닥에서 키보드 높이 + 틈)와 창이 서 있을 때(쉬는 여백 + 빈 칸)가 같다.
    expect(resting + (room.height as number)).toBe(KEYBOARD + KEYBOARD_GAP);
    // ③ 목록은 같은 만큼 위로 끌려 올라가 크기가 안 변한다.
    expect(listStyle().marginTop).toBe(-keyboardLift);
    // 쉬는 여백은 상수고 JS 는 transform 을 걸지 않는다(대화 레이아웃의 계약).
    expect(flat(pane().props.style).paddingBottom).toBe(resting);
    expect(flat(pane().props.style).transform).toBeUndefined();
    // 창은 화면 바닥에 붙어 키보드 높이를 채운다.
    expect(flat(screen.getByTestId('composer-panel').props.style)).toMatchObject({position: 'absolute', bottom: 0, height: KEYBOARD});
    expect(api!.phase).toBe('open');
  });

  it.each([0, 20, 34])('하단 인셋 %i 인 기기에서도 도크의 바닥 자리가 같다(키보드가 올렸을 때 = 창이 섰을 때)', bottom => {
    insets.mockReturnValue({top: 20, left: 0, right: 0, bottom});
    mount();
    open();
    const resting = restingBottomPadding(bottom);
    const room = flat(screen.getByTestId('composer-panel-room').props.style).height as number;
    expect(resting + room).toBe(KEYBOARD + KEYBOARD_GAP);
    expect(listStyle().marginTop).toBe(-room);
  });

  it('키보드는 빈 칸이 레이아웃에 닿은 뒤에야 내린다 - 열기만으로는 내리지 않는다', () => {
    const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {});
    mount();
    open();
    expect(dismiss).not.toHaveBeenCalled();
    fireEvent(screen.getByTestId('composer-panel-room'), 'layout', {nativeEvent: {layout: {x: 0, y: 0, width: 402, height: 306}}});
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('키보드가 없을 때(쉬는 상태에서 ☺)는 입력창·목록·창이 키보드 곡선으로 미끄러진다, 키보드가 올라와 있으면 맞바꿈이라 미끄러지지 않는다', async () => {
    release?.();
    release = await pinReduceMotion(false);
    const slide = jest.spyOn(LayoutAnimation, 'configureNext').mockImplementation(() => {});
    jest.spyOn(Keyboard, 'isVisible').mockReturnValue(false);
    mount();
    open();
    expect(slide).toHaveBeenCalledTimes(1);
    act(() => api!.close());
    expect(slide).toHaveBeenCalledTimes(2);

    slide.mockClear();
    (Keyboard.isVisible as jest.Mock).mockReturnValue(true);
    open();
    expect(slide).not.toHaveBeenCalled();
  });
});

describe('닫기(창 → 키보드) — 키보드가 다 올라온 뒤에 맞바꾼다', () => {
  it('handoff 중에도 창과 리프트 눕힘이 그대로이고, keyboardDidShow 에서 한 번에 옛 모양으로 돌아간다', () => {
    mount();
    open();
    act(() => api!.handoff());
    expect(api!.phase).toBe('handoff');
    // 키보드가 올라오는 동안: 창은 그대로, 네이티브 리프트는 계속 0 이라 입력창이 안 움직인다.
    expect(screen.getByTestId('composer-panel')).toBeTruthy();
    expect(Math.max(KEYBOARD - (pane().props.bottomInset as number), 0)).toBe(0);
    act(() => emitter().emit('keyboardWillShow', shown()));
    expect(screen.getByTestId('composer-panel')).toBeTruthy();
    act(() => emitter().emit('keyboardDidShow', shown()));
    expect(screen.queryByTestId('composer-panel')).toBeNull();
    expect(pane().props.bottomInset).toBe(restingBottomPadding(34) - KEYBOARD_GAP);
    expect(listStyle().marginTop).toBeUndefined();
    expect(api!.phase).toBe('closed');
  });

  it('키보드가 끝내 안 오는 기기(하드웨어 키보드)는 상한 시간 뒤에 창만 거둔다', () => {
    jest.useFakeTimers();
    mount();
    open();
    act(() => api!.handoff());
    act(() => {
      jest.advanceTimersByTime(HANDOFF_MAX_MS - 1);
    });
    expect(screen.getByTestId('composer-panel')).toBeTruthy();
    act(() => {
      jest.advanceTimersByTime(2);
    });
    expect(screen.queryByTestId('composer-panel')).toBeNull();
  });

  it('올라오는 도중에 ☺ 를 다시 누르면 창이 그대로 남고 키보드를 다시 내린다', () => {
    const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {});
    mount();
    open();
    act(() => api!.handoff());
    open();
    expect(api!.phase).toBe('open');
    expect(dismiss).toHaveBeenCalledTimes(1);
    // 높이는 처음 그 자리 그대로다(다시 재지 않는다).
    expect(flat(screen.getByTestId('composer-panel').props.style).height).toBe(KEYBOARD);
    // 옛 대기는 풀려서 뒤늦은 keyboardDidShow 가 창을 거두지 않는다.
    act(() => emitter().emit('keyboardDidShow', shown()));
    expect(screen.getByTestId('composer-panel')).toBeTruthy();
  });

  it('목록을 눌러 거두면(close) 창이 사라지고 옛 모양으로 돌아간다', () => {
    mount();
    open();
    act(() => api!.close());
    expect(screen.queryByTestId('composer-panel')).toBeNull();
    expect(listStyle().marginTop).toBeUndefined();
  });
});

describe('창이 서 있는 동안의 내용', () => {
  it('호스트가 쥔 내용을 창 안에 그리고, 닫으면 비운다', () => {
    mount();
    act(() => api!.setContent(<View testID="panel-content" />));
    expect(screen.queryByTestId('panel-content')).toBeNull(); // 닫혀 있으면 그리지 않는다
    open();
    expect(screen.getByTestId('panel-content')).toBeTruthy();
    act(() => api!.close());
    expect(screen.queryByTestId('panel-content')).toBeNull();
  });
});
