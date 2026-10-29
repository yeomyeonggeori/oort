import type {Message} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import {Animated, Pressable, Text} from 'react-native';

import {FixedScheme, ThemeProvider, useTheme} from '../src/design/theme';
import {SEND_ARRIVE_EASE, SEND_ARRIVE_MS} from '../src/design/motion';
import {ReduceMotionRefContext} from '../src/features/conversation/LandedTintFade';
import {MessageRow, PendingRow} from '../src/features/conversation/MessageRow';
import {resetArrivedForTest} from '../src/features/conversation/sendArrival';
import {NON_SECRET_KEYS, __setNonSecretStore} from '../src/storage/kv';
import {flat, member} from './testkit';

// =============================================================================
// #4383 — 외양 저장소의 말풍선 덮어쓰기(`layout: 'row'` 포함)가 화면까지 닿는다 +
// 보낸 메시지가 입력창에서 올라오는 등장(한 번만, 동작 줄이기면 즉시).
//
// 각 단정은 일부러 구현을 깨 봐서 빨개지는 것을 확인했다(사보타주 표는 progress.md).
// =============================================================================

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const BASE_MS = 1_700_000_000_000;

const DIRECTORY = makeDirectory([
  member({id: SELF, displayName: '박서연', handle: 'seoyeon'}),
  member({id: OTHER, displayName: '이도현', handle: 'dohyeon'}),
]);

function message(over: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    channelId: 'ch',
    seq: 1,
    hlcTs: 1,
    hlcCount: 0,
    authorMemberId: OTHER,
    type: 'text',
    body: '네네',
    state: 'sent',
    createdAtMs: BASE_MS,
    ...over,
  };
}

const ACTIONS = {
  myMemberId: SELF,
  onToggleReaction: async () => {},
  onEdit: async () => {},
  onDelete: async () => {},
};

function memoryStore() {
  const map = new Map<string, string>();
  return {
    map,
    getString: (key: string) => map.get(key),
    set: (key: string, value: string) => void map.set(key, value),
    remove: (key: string) => map.delete(key),
  };
}
let store = memoryStore();
const saved = () => JSON.parse(store.map.get(NON_SECRET_KEYS.appearance) ?? 'null');

beforeEach(() => {
  store = memoryStore();
  __setNonSecretStore(store);
  resetArrivedForTest();
});
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  __setNonSecretStore(null);
});

const row = (m: Message = message()) => (
  <MessageRow message={m} startsGroup directory={DIRECTORY} chips={[]} nowMs={BASE_MS} actions={ACTIONS} />
);

const pendingMsg = (over: Record<string, unknown> = {}) =>
  ({
    clientMsgId: 'c-1',
    channelId: 'ch',
    authorMemberId: SELF,
    body: '보내는 중',
    status: 'sending',
    // 자격 창(#4455)이 보낸 시각을 본다 — 방금 보낸 메아리.
    createdAtMs: Date.now(),
    ...over,
  }) as never;

// -----------------------------------------------------------------------------
// 말풍선 덮어쓰기 배선
// -----------------------------------------------------------------------------
describe('말풍선 덮어쓰기 — 외양 저장소에서 화면까지', () => {
  it('기본은 말풍선이고, layout=row 면 말풍선이 없는 예전 평면 행이다 (남 글·내 글·메아리 모두)', () => {
    const {rerender} = render(<FixedScheme scheme="dark">{row()}</FixedScheme>);
    expect(screen.queryAllByTestId('message-bubble')).toHaveLength(1);

    rerender(
      <FixedScheme scheme="dark" bubble={{layout: 'row'}}>
        {row()}
      </FixedScheme>,
    );
    expect(screen.queryAllByTestId('message-bubble')).toHaveLength(0);
    expect(screen.getByText('네네')).toBeTruthy();

    rerender(
      <FixedScheme scheme="dark" bubble={{layout: 'row'}}>
        {row(message({authorMemberId: SELF}))}
        <PendingRow pending={pendingMsg()} startsGroup directory={DIRECTORY} />
      </FixedScheme>,
    );
    expect(screen.queryAllByTestId('message-bubble')).toHaveLength(0);
  });

  it('줄 보기에서도 코드 블록·산문 마크업은 그대로 그려진다 (본문이 사라지지 않는다)', () => {
    render(
      <FixedScheme scheme="dark" bubble={{layout: 'row'}}>
        {row(message({body: '**굵게** 와 `코드`'}))}
      </FixedScheme>,
    );
    expect(screen.queryAllByTestId('message-bubble')).toHaveLength(0);
    expect(screen.getByTestId('message-markdown')).toBeTruthy();
  });

  it('내 말풍선 색 덮어쓰기는 대비를 지키면 먹고, 못 지키면 기본으로 돌아간다', () => {
    const {rerender} = render(
      <FixedScheme scheme="dark" bubble={{mine: {bg: '#7B3FE4', fg: '#FFFFFF'}}}>
        {row(message({authorMemberId: SELF}))}
      </FixedScheme>,
    );
    expect(flat(screen.getByTestId('message-bubble').props.style).backgroundColor).toBe('#7B3FE4');

    rerender(
      <FixedScheme scheme="dark" bubble={{mine: {bg: '#FFFFFF', fg: '#FEFEFE'}}}>
        {row(message({authorMemberId: SELF}))}
      </FixedScheme>,
    );
    expect(flat(screen.getByTestId('message-bubble').props.style).backgroundColor).not.toBe('#FFFFFF');
  });

  it('모서리 덮어쓰기가 말풍선 반경으로 간다', () => {
    render(
      <FixedScheme scheme="dark" bubble={{radius: 4}}>
        {row()}
      </FixedScheme>,
    );
    expect(flat(screen.getByTestId('message-bubble').props.style).borderRadius).toBe(4);
  });

  function Controls(): React.JSX.Element {
    const {setBubble} = useTheme();
    return (
      <>
        <Pressable testID="to-row" onPress={() => setBubble({layout: 'row'})}>
          <Text>줄</Text>
        </Pressable>
        <Pressable testID="to-default" onPress={() => setBubble(undefined)}>
          <Text>기본</Text>
        </Pressable>
      </>
    );
  }

  it('ThemeProvider: 줄 보기를 고르면 즉시 화면이 바뀌고 저장되며, 기본으로 되돌리면 키가 사라진다', () => {
    render(
      <ThemeProvider>
        <Controls />
        {row()}
      </ThemeProvider>,
    );
    expect(screen.queryAllByTestId('message-bubble')).toHaveLength(1);
    expect(saved()).toBeNull();

    fireEvent.press(screen.getByTestId('to-row'));
    expect(screen.queryAllByTestId('message-bubble')).toHaveLength(0);
    expect(saved().bubble).toEqual({layout: 'row'});

    fireEvent.press(screen.getByTestId('to-default'));
    expect(screen.queryAllByTestId('message-bubble')).toHaveLength(1);
    expect(saved()).not.toHaveProperty('bubble');
  });

  it('다음 실행이 저장된 줄 보기로 첫 렌더를 한다', () => {
    store.map.set(
      NON_SECRET_KEYS.appearance,
      JSON.stringify({v: 2, scheme: 'dark', theme: 'dawnsky', signal: null, density: 'comfortable', bubble: {layout: 'row'}}),
    );
    render(<ThemeProvider>{row()}</ThemeProvider>);
    expect(screen.queryAllByTestId('message-bubble')).toHaveLength(0);
  });

  it('테마를 바꿔도 말풍선 덮어쓰기가 지워지지 않는다 (같은 레코드에 함께 산다)', () => {
    function ThemeBtn(): React.JSX.Element {
      const {setTheme} = useTheme();
      return (
        <Pressable testID="to-graphite" onPress={() => setTheme('graphite')}>
          <Text>흑연</Text>
        </Pressable>
      );
    }
    render(
      <ThemeProvider>
        <Controls />
        <ThemeBtn />
      </ThemeProvider>,
    );
    fireEvent.press(screen.getByTestId('to-row'));
    fireEvent.press(screen.getByTestId('to-graphite'));
    expect(saved()).toMatchObject({theme: 'graphite', bubble: {layout: 'row'}});
  });
});

// -----------------------------------------------------------------------------
// 보낸 메시지 등장
// -----------------------------------------------------------------------------
function spyTiming() {
  return jest.spyOn(Animated, 'timing').mockImplementation(
    () => ({start: jest.fn(), stop: jest.fn(), reset: jest.fn()}) as never,
  );
}

describe('보낸 메시지 등장 — 입력창에서 올라온다', () => {
  it('메아리가 마운트되면 한 번, 자리보다 아래에서 시작해 300ms 에 앉는다 (네이티브 구동, 페이드 없음)', () => {
    const timing = spyTiming();
    render(<PendingRow pending={pendingMsg()} startsGroup directory={DIRECTORY} />);
    expect(timing).toHaveBeenCalledTimes(1);
    const config = timing.mock.calls[0][1];
    // #4455: 남은 오름의 비율을 1→0 으로 돌리고, Buzz 곡선(`easeOutCubic`)·300ms 다.
    expect(config).toMatchObject({
      toValue: 0,
      duration: SEND_ARRIVE_MS,
      easing: SEND_ARRIVE_EASE,
      useNativeDriver: true,
    });

    const style = flat(screen.getByTestId('pending-row').props.style);
    // 불투명도는 건드리지 않는다 — 목록이 아래 가장자리에서 행을 자르므로 페이드가 필요 없다.
    expect(style.opacity).toBeUndefined();
    expect(style.transform).toHaveLength(1);
    expect(style.transform[0].translateY).toBeGreaterThan(0);
    // 움직임은 transform 뿐 — 높이·여백을 건드리면 바닥 추적의 측정이 흔들린다.
    expect(Object.keys(style).sort()).toEqual(
      expect.arrayContaining(['marginHorizontal', 'transform']),
    );
    expect(style.height).toBeUndefined();
    expect(style.maxHeight).toBeUndefined();
  });

  it('다시 그려져도(상태 갱신) 더 올라오지 않는다', () => {
    const timing = spyTiming();
    const {rerender} = render(<PendingRow pending={pendingMsg()} startsGroup directory={DIRECTORY} />);
    rerender(<PendingRow pending={pendingMsg({body: '보내는 중 2'})} startsGroup directory={DIRECTORY} />);
    rerender(<PendingRow pending={pendingMsg({status: 'failed'})} startsGroup directory={DIRECTORY} />);
    expect(timing).toHaveBeenCalledTimes(1);
  });

  it('가상화로 다시 마운트된 같은 메아리는 곧바로 자리에 선다 (한 번만)', () => {
    const timing = spyTiming();
    const first = render(<PendingRow pending={pendingMsg()} startsGroup directory={DIRECTORY} />);
    first.unmount();
    render(<PendingRow pending={pendingMsg()} startsGroup directory={DIRECTORY} />);
    expect(timing).toHaveBeenCalledTimes(1);
    expect(flat(screen.getByTestId('pending-row').props.style).opacity).toBeUndefined();
  });

  it('다른 메시지의 메아리는 각자 한 번씩 올라온다', () => {
    const timing = spyTiming();
    render(
      <>
        <PendingRow pending={pendingMsg({clientMsgId: 'a'})} startsGroup directory={DIRECTORY} />
        <PendingRow pending={pendingMsg({clientMsgId: 'b'})} startsGroup directory={DIRECTORY} />
      </>,
    );
    expect(timing).toHaveBeenCalledTimes(2);
  });

  it('서버 사본(MessageRow)은 움직이지 않는다 — 메아리를 대체할 때 두 번째 움직임이 없다', () => {
    const timing = spyTiming();
    const {rerender} = render(<PendingRow pending={pendingMsg()} startsGroup directory={DIRECTORY} />);
    expect(timing).toHaveBeenCalledTimes(1);
    rerender(row(message({authorMemberId: SELF})));
    expect(timing).toHaveBeenCalledTimes(1);
  });

  it('동작 줄이기면 애니메이션 호출이 0이고 처음부터 자리에 선다', () => {
    const timing = spyTiming();
    render(
      <ReduceMotionRefContext.Provider value={{current: true}}>
        <PendingRow pending={pendingMsg()} startsGroup directory={DIRECTORY} />
      </ReduceMotionRefContext.Provider>,
    );
    expect(timing).not.toHaveBeenCalled();
    const style = flat(screen.getByTestId('pending-row').props.style);
    expect(style.opacity).toBeUndefined();
    expect(style.transform).toBeUndefined();
  });

  it('이미 실패한 행(복원된 전송)은 올라오지 않는다', () => {
    const timing = spyTiming();
    render(<PendingRow pending={pendingMsg({status: 'failed'})} startsGroup directory={DIRECTORY} />);
    expect(timing).not.toHaveBeenCalled();
  });

  it('입력 중 햅틱 0 계약: 등장 코드는 햅틱을 부르지 않는다', () => {
    const src = (name: string) =>
      fs.readFileSync(path.resolve(__dirname, '../src/features/conversation', name), 'utf8');
    const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code(src('sendArrival.ts'))).not.toMatch(/haptic/i);
    const rowSrc = code(src('MessageRow.tsx'));
    const start = rowSrc.indexOf('export function PendingRow');
    expect(start).toBeGreaterThan(0);
    expect(rowSrc.slice(start, start + 4000)).not.toMatch(/haptic/i);
  });
});
