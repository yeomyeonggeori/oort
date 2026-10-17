import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {act, cleanup, render} from '@testing-library/react-native';
import React from 'react';

import {useRecheckWhenElapsed} from '../src/features/profile/selfStatus';

// =============================================================================
// #2899 design-review H3 — 알고 있는 기한이 지나면 자기 화면이 서버에 다시 묻는다.
//
// 서버는 만료 시각에 이벤트를 보내지 않고, 질의 캐시는 30초 동안 신선하며 포커스 재조회도 꺼져 있다.
// 이 훅이 없으면 기한이 지난 뒤에도 프로필 시트가 낡은 방해 금지·일시 중지를 말한다. 이 훅은 화면을
// **스스로 풀지 않고 다시 읽을 뿐**이다. 기한이 오는 순간에 한 번 깨고(분 틱을 기다리지 않는다), 지난 뒤에는
// 분 틱마다 다시 묻는다. 기한이 없으면 묻지 않는다.
//
// `profilePauseUntil.test.tsx` 는 이 훅을 시트 안에서 **마운트 시점**만 친다. 타이머 두 길(기한이
// 오는 순간·분 틱)은 가짜 시계로 시간을 흘려야 보이므로 훅만 따로 세운다(재검수 N3).
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const at = (day: number, hour: number, minute = 0, second = 0) =>
  new Date(2026, 9, day, hour, minute, second, 0).getTime();
const NOW = at(16, 21, 7);

const ROSTER = JSON.stringify(['roster', WS]);
const RULES = JSON.stringify(['settings', 'notification-rules', WS]);

let client: QueryClient;
let invalidate: jest.SpyInstance;

function Probe({untilMs}: {untilMs: number | undefined}) {
  useRecheckWhenElapsed(WS, untilMs);
  return null;
}

function mount(untilMs: number | undefined) {
  client = new QueryClient();
  invalidate = jest.spyOn(client, 'invalidateQueries');
  const tree = (next: number | undefined) => (
    <QueryClientProvider client={client}>
      <Probe untilMs={next} />
    </QueryClientProvider>
  );
  const view = render(tree(untilMs));
  return {rerender: (next: number | undefined) => view.rerender(tree(next))};
}

const askedKeys = () =>
  invalidate.mock.calls.map(call => JSON.stringify((call[0] as {queryKey: unknown}).queryKey));

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

describe('useRecheckWhenElapsed (#2899 H3)', () => {
  it('이미 지난 기한이면 마운트하자마자 규칙과 명부를 다시 묻는다', () => {
    mount(at(16, 21, 0));
    expect(askedKeys()).toContain(RULES);
    expect(askedKeys()).toContain(ROSTER);
  });

  it('아직 오지 않은 기한이면 묻지 않고, 기한이 오는 순간에 한 번 깨어 묻는다(분 틱을 기다리지 않는다)', () => {
    mount(at(16, 21, 7, 53)); // 53초 뒤 — 분 틱(60초)보다 이르다
    expect(invalidate).not.toHaveBeenCalled();
    act(() => {
      jest.advanceTimersByTime(52_000);
    });
    expect(invalidate).not.toHaveBeenCalled();
    // 기한(+여유 0.5초) 직후: 분 틱이 오기 전이다.
    act(() => {
      jest.advanceTimersByTime(2_000);
    });
    expect(askedKeys()).toContain(RULES);
    expect(askedKeys()).toContain(ROSTER);
  });

  it('지난 뒤에도 서버가 켜져 있다고 답하는 동안(기한이 그대로)은 분 틱마다 다시 묻는다', () => {
    mount(at(16, 21, 0));
    invalidate.mockClear();
    act(() => {
      jest.advanceTimersByTime(60_000);
    });
    expect(askedKeys()).toContain(RULES);
    expect(askedKeys()).toContain(ROSTER);
    invalidate.mockClear();
    act(() => {
      jest.advanceTimersByTime(60_000);
    });
    expect(askedKeys()).toContain(RULES);
  });

  it('기한이 없으면(옛 판이 만든 기한 없는 행) 아무리 시간이 흘러도 묻지 않는다', () => {
    mount(undefined);
    act(() => {
      jest.advanceTimersByTime(10 * 60_000);
    });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('기한이 지워지면(서버의 새 답이 왔다) 더는 묻지 않는다', () => {
    const {rerender} = mount(at(16, 21, 0));
    invalidate.mockClear();
    rerender(undefined);
    act(() => {
      jest.advanceTimersByTime(5 * 60_000);
    });
    expect(invalidate).not.toHaveBeenCalled();
  });
});
