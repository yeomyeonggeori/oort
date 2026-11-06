import type {MessageUnfurl} from '@momo/core/features/timeline/unfurl';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';
import {StyleSheet} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';
import {
  MEASURE_FLUSH_MS,
  createMeasureMemory,
  unfurlHeightMemory,
} from '../src/storage/measureMemory';
import {NON_SECRET_KEYS} from '../src/storage/kv';
import {
  measuredAttachmentSize,
  rememberAttachmentSize,
  resetAttachmentContentForTest,
} from '../src/features/attachments/content';
import {
  forgetUnfurlHeight,
  rememberUnfurlHeight,
  unfurlReserveFor,
} from '../src/features/conversation/unfurlReserve';
import {UnfurlCards} from '../src/features/conversation/UnfurlCards';
import {resetUnfurlImagesForTest} from '../src/features/conversation/unfurlImage';

// =============================================================================
// #5451 — 잰 크기를 **기기에** 기억한다(앱을 다시 켠 뒤에도 사진이 제 비율로 서고, 링크 카드 자리가 미리 비어 있다).
//
// 첨부 사진은 받기 전에는 크기를 모른다. 앱이 사는 동안만 기억하던 앞 판에서는 앱을 다시 켠 뒤 들어간 대화의 사진마다 16:9 자리표시로 섰다가
// 받으면 제 비율로 바뀌었다. 링크 카드는 방을 열고 한 번 더 읽어야 와서, 카드가 오면 줄이 자라 위 줄이 밀렸다. 여기서는 그 기억이 **쓰이고**(키·모양),
// **읽히고**(새 지도가 같은 키에서), **틀린 값을 받지 않는지**를 값으로 잰다.
// =============================================================================

const mmkv = (jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}).__store;

beforeEach(() => {
  jest.useFakeTimers();
  resetAttachmentContentForTest();
  unfurlHeightMemory.clearForTest();
  resetUnfurlImagesForTest(async () => 'data:image/png;base64,AAAA');
});
afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

describe('measureMemory', () => {
  const options = {key: 'momo.test.measure.v1', limit: 3, arity: 2};

  it('쓰기를 한데 모아 한 번에 하고, 새 지도(= 앱을 다시 켠 뒤)가 같은 키에서 읽는다', () => {
    const first = createMeasureMemory(options);
    first.set('a', [800, 600]);
    first.set('b', [600, 900]);
    first.set('a', [801, 600]);
    expect(mmkv.has(options.key)).toBe(false); // 아직 모으는 중
    act(() => {
      jest.advanceTimersByTime(MEASURE_FLUSH_MS);
    });
    expect(JSON.parse(mmkv.get(options.key) as string)).toEqual([
      ['b', 600, 900],
      ['a', 801, 600],
    ]);
    const second = createMeasureMemory(options);
    expect(second.get('a')).toEqual([801, 600]);
    expect(second.get('b')).toEqual([600, 900]);
    expect(second.get('c')).toBeNull();
  });

  it('같은 값은 쓰지 않고 같은 배열을 돌려주며, 오래된 것부터 잊고, 틀린 값은 받지 않는다', () => {
    const memory = createMeasureMemory({...options, key: 'momo.test.measure.lru.v1'});
    const stored = memory.set('a', [10, 20]);
    expect(memory.set('a', [10, 20])).toBe(stored);
    expect(memory.get('a')).toBe(stored);
    memory.set('b', [1, 1]);
    memory.set('c', [2, 2]);
    memory.set('d', [3, 3]); // 정원 3 — 가장 오래된 a 가 나간다
    expect(memory.get('a')).toBeNull();
    expect(memory.get('d')).toEqual([3, 3]);
    expect(memory.set('x', [0, 5])).toBeNull();
    expect(memory.set('x', [Number.NaN, 5])).toBeNull();
    expect(memory.set('x', [5])).toBeNull(); // 칸 수가 다르다
    expect(memory.get('x')).toBeNull();
  });

  it('저장된 것 중 모양이 틀린 항목은 읽지 않는다(숫자 둘이 아니거나 0·음수·글자)', () => {
    const key = 'momo.test.measure.bad.v1';
    mmkv.set(
      key,
      JSON.stringify([['ok', 4, 3], ['zero', 0, 3], ['neg', -1, 3], ['text', '4', 3], ['short', 4], 'junk', ['ok2', 8, 6]]),
    );
    const memory = createMeasureMemory({key, limit: 10, arity: 2});
    expect(memory.get('ok')).toEqual([4, 3]);
    expect(memory.get('ok2')).toEqual([8, 6]);
    for (const bad of ['zero', 'neg', 'text', 'short']) expect(memory.get(bad)).toBeNull();
    mmkv.set(key, 'not json');
    expect(createMeasureMemory({key, limit: 10, arity: 2}).get('ok')).toBeNull();
  });

  it('지우면 저장에서도 빠지고, 구독자는 값이 바뀔 때만 불린다', () => {
    const memory = createMeasureMemory({...options, key: 'momo.test.measure.del.v1'});
    const listener = jest.fn();
    memory.subscribe(listener);
    memory.set('a', [1, 2]);
    memory.set('a', [1, 2]); // 같은 값 — 부르지 않는다
    expect(listener).toHaveBeenCalledTimes(1);
    memory.delete('a');
    memory.delete('a'); // 없는 것 — 부르지 않는다
    expect(listener).toHaveBeenCalledTimes(2);
    act(() => {
      jest.advanceTimersByTime(MEASURE_FLUSH_MS);
    });
    expect(JSON.parse(mmkv.get('momo.test.measure.del.v1') as string)).toEqual([]);
  });
});

describe('첨부 사진의 잰 크기', () => {
  it('잰 크기를 기기에 쓰고, 앱을 다시 켠 뒤(새 모듈)에도 첫 프레임부터 안다', () => {
    rememberAttachmentSize('ABC-123', 800, 600);
    act(() => {
      jest.advanceTimersByTime(MEASURE_FLUSH_MS);
    });
    expect(JSON.parse(mmkv.get(NON_SECRET_KEYS.attachmentSizes) as string)).toEqual([
      ['abc-123', 800, 600],
    ]);
    // 앱을 다시 켠 것과 같다: 모듈을 새로 불러 저장소에서 읽는다.
    jest.isolateModules(() => {
      const fresh = require('../src/features/attachments/content') as typeof import('../src/features/attachments/content');
      expect(fresh.measuredAttachmentSize('ABC-123')).toEqual({width: 800, height: 600});
      // 같은 객체를 돌려준다(상태 갱신이 비교만으로 끝난다).
      expect(fresh.measuredAttachmentSize('abc-123')).toBe(fresh.measuredAttachmentSize('ABC-123'));
      expect(fresh.measuredAttachmentSize('never-seen')).toBeNull();
    });
    expect(measuredAttachmentSize('abc-123')).toEqual({width: 800, height: 600});
  });

  it('그림이 아닌 값은 기억하지 않는다', () => {
    expect(rememberAttachmentSize('bad', 0, 10)).toBeNull();
    expect(rememberAttachmentSize('bad', 10, Number.POSITIVE_INFINITY)).toBeNull();
    act(() => {
      jest.advanceTimersByTime(MEASURE_FLUSH_MS);
    });
    expect(measuredAttachmentSize('bad')).toBeNull();
    expect(mmkv.has(NON_SECRET_KEYS.attachmentSizes)).toBe(false);
  });
});

describe('링크 카드 자리', () => {
  const card: MessageUnfurl = {
    id: 'u1',
    messageId: 'm1',
    url: 'https://example.com/post',
    status: 'ok',
    title: '배포 후기',
    description: '세 번째 시도에서 드디어 성공한 이야기',
    domain: 'example.com',
  };

  it('카드가 오기 전에는 지난번에 차지한 높이만큼 비워 두고, 카드가 오면 그 자리를 카드가 쓴다', () => {
    rememberUnfurlHeight('M1', 96);
    const ui = render(<UnfurlCards unfurls={[]} rowKey="m-1" messageId="m1" mayHaveCard />);
    const reserve = screen.getByTestId('unfurl-reserve');
    expect(StyleSheet.flatten(reserve.props.style)).toMatchObject({height: 96});
    expect(screen.queryByTestId('unfurl-group')).toBeNull();
    ui.rerender(<UnfurlCards unfurls={[card]} rowKey="m-1" messageId="m1" mayHaveCard />);
    expect(screen.queryByTestId('unfurl-reserve')).toBeNull();
    expect(screen.getByTestId('unfurl-group')).toBeTruthy();
  });

  it('기억이 없거나 카드가 올 수 없는 줄(링크 없음)에는 자리를 비우지 않는다', () => {
    const ui = render(<UnfurlCards unfurls={[]} rowKey="m-1" messageId="m2" mayHaveCard />);
    expect(screen.queryByTestId('unfurl-reserve')).toBeNull();
    rememberUnfurlHeight('m3', 96);
    ui.rerender(<UnfurlCards unfurls={[]} rowKey="m-1" messageId="m3" mayHaveCard={false} />);
    expect(screen.queryByTestId('unfurl-reserve')).toBeNull();
  });

  it('읽었더니 카드가 없으면 기억을 지워 빈 자리가 따라 사라진다', () => {
    rememberUnfurlHeight('m4', 80);
    render(<UnfurlCards unfurls={[]} rowKey="m-4" messageId="m4" mayHaveCard />);
    expect(screen.getByTestId('unfurl-reserve')).toBeTruthy();
    act(() => {
      forgetUnfurlHeight('m4');
    });
    expect(screen.queryByTestId('unfurl-reserve')).toBeNull();
    expect(unfurlReserveFor('m4')).toBeNull();
  });

  it('카드 묶음이 자리를 잡으면(onLayout) 그 높이를 기억한다', () => {
    render(<UnfurlCards unfurls={[card]} rowKey="m-5" messageId="m5" mayHaveCard />);
    act(() => {
      fireEvent(screen.getByTestId('unfurl-group'), 'layout', {nativeEvent: {layout: {x: 0, y: 0, width: 300, height: 72.4}}});
    });
    expect(unfurlReserveFor('M5')).toBe(72.4);
    fireEvent(screen.getByTestId('unfurl-group'), 'layout', {nativeEvent: {layout: {x: 0, y: 0, width: 300, height: 0}}});
    expect(unfurlReserveFor('m5')).toBe(72.4); // 0 은 받지 않는다
  });
});
