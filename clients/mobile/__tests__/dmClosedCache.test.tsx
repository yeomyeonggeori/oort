import React from 'react';
import {render} from '@testing-library/react-native';

import {
  closedIdsOf,
  parseDmClosedCache,
  useDmClosedCacheInitial,
  useDmClosedCacheWrite,
} from '../src/features/sidebar/dmClosedCache';
import type {DmVerdict} from '../src/features/sidebar/dmVerdicts';
import {NON_SECRET_KEYS} from '../src/storage/kv';

// 닫힌 DM 첫 페인트 캐시 (#4367). 원장이 아니라 마지막 투영의 사본이다.
const mmkvStore = (jest.requireMock('react-native-mmkv') as {__store: Map<string, string>})
  .__store;

const WS = 'ws-1';
const verdict = (shown: boolean, rule: DmVerdict['rule']): DmVerdict => ({shown, rule});

function Probe(props: {
  phase: 'loading' | 'error' | 'ready';
  writable: boolean;
  verdicts: ReadonlyMap<string, DmVerdict>;
  onInitial: (set: ReadonlySet<string>) => void;
}) {
  props.onInitial(useDmClosedCacheInitial(WS));
  useDmClosedCacheWrite(WS, props.phase, props.writable, props.verdicts);
  return null;
}

function mount(props: React.ComponentProps<typeof Probe>) {
  return render(<Probe {...props} />);
}

beforeEach(() => mmkvStore.clear());

describe('parse / closedIdsOf', () => {
  it('망가진 저장값은 빈 표다', () => {
    expect(parseDmClosedCache(undefined)).toEqual({});
    expect(parseDmClosedCache('{')).toEqual({});
    expect(parseDmClosedCache('[1]')).toEqual({});
    expect(parseDmClosedCache('{"w":"x"}')).toEqual({});
  });
  it('내가 닫아 숨은 DM(7번)만 적는다: 나간 상대(6)·보임은 적지 않는다', () => {
    const map = new Map<string, DmVerdict>([
      ['b', verdict(false, 7)],
      ['a', verdict(false, 7)],
      ['g', verdict(false, 6)],
      ['v', verdict(true, 9)],
      ['r', verdict(true, 7)],
    ]);
    expect(closedIdsOf(map)).toEqual(['a', 'b']);
  });
});

describe('읽기·쓰기', () => {
  it('저장된 닫힘 id 를 첫 프레임에 읽는다', () => {
    mmkvStore.set(NON_SECRET_KEYS.dmClosedCache, JSON.stringify({[WS]: ['x'], other: ['y']}));
    let seen: ReadonlySet<string> = new Set();
    mount({phase: 'loading', writable: true, verdicts: new Map(), onInitial: s => (seen = s)});
    expect([...seen]).toEqual(['x']);
  });

  it('투영이 ready 이고 서버가 닫기를 실으면 그 결과로 덮어쓴다(다른 워크스페이스는 그대로)', () => {
    mmkvStore.set(NON_SECRET_KEYS.dmClosedCache, JSON.stringify({other: ['y'], [WS]: ['old']}));
    mount({
      phase: 'ready',
      writable: true,
      verdicts: new Map([['new', verdict(false, 7)]]),
      onInitial: () => {},
    });
    expect(JSON.parse(mmkvStore.get(NON_SECRET_KEYS.dmClosedCache) ?? '{}')).toEqual({
      other: ['y'],
      [WS]: ['new'],
    });
  });

  it('오는 중·실패·옛 서버에서는 쓰지 않는다', () => {
    const verdicts = new Map([['new', verdict(false, 7)]]);
    for (const [phase, writable] of [
      ['loading', true],
      ['error', true],
      ['ready', false],
    ] as const) {
      mount({phase, writable, verdicts, onInitial: () => {}});
    }
    expect(mmkvStore.has(NON_SECRET_KEYS.dmClosedCache)).toBe(false);
  });
});
