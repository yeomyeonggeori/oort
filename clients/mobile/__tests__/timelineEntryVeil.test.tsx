import type {Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';
import {AccessibilityInfo, StyleSheet} from 'react-native';

import {Timeline, type PillState} from '../src/features/conversation/Timeline';
import {installAppClock} from './fixtures/fakeClock';

// =============================================================================
// 대화를 열면 목록은 처음부터 바닥에 앉은 채 보인다 (#5403, owner 11-05 「들어온 직후 위에서 아래로 움직이는 듯한 동작」).
//
// 마운트한 목록은 오프셋 0(대화의 맨 위)에 서고 곧 끝으로 간다(진입 수렴). 시뮬레이터 녹화로 잰 그 몇 프레임이 「위에서 아래로 훑는」 움직임이다:
// 「대화의 시작입니다」·옛 날짜가 4프레임(약 70ms) 보이고, 중간 자리를 한 프레임 거쳐, 바닥에 앉았다. 그래서 진입이 앉을 때까지(`settleEntry`) 목록은
// 그려지지 않고 그 자리에 「불러오는 중」이 이어진다 - 사람은 바닥에 앉은 첫 프레임만 본다. 상한이 지나면 무슨 일이 있어도 보인다.
// =============================================================================

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const BASE_MS = 1_700_000_000_000;

function member(over: Partial<RosterMember> & {id: string}): RosterMember {
  return {
    workspaceId: 'ws',
    kind: 'human',
    status: 'active',
    displayName: '이름',
    handle: 'handle',
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  } as RosterMember;
}

const DIRECTORY = makeDirectory([
  member({id: SELF, displayName: '이도현', handle: 'dohyun'}),
  member({id: OTHER, displayName: '박서연', handle: 'seoyeon'}),
]);

function message(seq: number): Message {
  return {
    id: `msg-${seq}`,
    channelId: 'ch',
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: OTHER,
    type: 'text',
    body: `${seq}번째 메시지`,
    state: 'sent',
    createdAtMs: BASE_MS + seq * 1000,
  };
}

const HISTORY = [1, 2, 3, 4, 5, 6, 7, 8].map(message);

let pills: React.MutableRefObject<PillState | null> = {current: null};

function element(options: {messages?: Message[]; jumpPills?: boolean} = {}) {
  return (
    <Timeline
      messages={options.messages ?? HISTORY}
      directory={DIRECTORY}
      status="ready"
      myMemberId={SELF}
      nowMs={BASE_MS}
      lastReadSeq={8}
      unreadCount={0}
      jumpPills={options.jumpPills ?? true}
      pillsRef={pills}
    />
  );
}

const flat = (style: unknown): Record<string, unknown> =>
  (StyleSheet.flatten(style as never) ?? {}) as Record<string, unknown>;
const list = () => screen.getByTestId('timeline-list');
const listOpacity = () => flat(list().props.style).opacity;
const cover = () => screen.queryByTestId('timeline-entry-veil');

async function sleep(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

/** 목록이 끝에 닿았다고 보고한다 - 진입 수렴이 앉는 조건. */
async function landAtBottom() {
  fireEvent(list(), 'contentSizeChange', 390, 4000);
  fireEvent.scroll(list(), {
    nativeEvent: {
      contentOffset: {y: 3200},
      contentSize: {height: 4000, width: 390},
      layoutMeasurement: {height: 800, width: 390},
    },
  });
  await sleep(0);
}

beforeEach(() => {
  installAppClock();
  (AccessibilityInfo.isReduceMotionEnabled as jest.Mock).mockResolvedValue(false);
  pills = {current: null};
});

afterEach(() => {
  cleanup();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('진입 베일 (#5403)', () => {
  it('첫 렌더부터 진입이 앉을 때까지 목록은 그려지지 않고 「불러오는 중」이 그 자리를 잇는다. 앉으면 목록이 보이고 표시가 걷힌다', async () => {
    render(element());
    // 첫 프레임: 오프셋 0 의 목록(대화의 맨 위)을 사람이 보면 안 된다.
    expect(listOpacity()).toBe(0);
    expect(cover()).toBeTruthy();
    expect(cover()).toHaveTextContent('대화를 불러오는 중입니다.', {exact: false});

    await landAtBottom();
    for (let waited = 0; waited < 2000 && pills.current?.settled !== true; waited += 20) {
      await sleep(20);
    }
    expect(pills.current?.settled).toBe(true);
    expect(listOpacity()).not.toBe(0);
    expect(cover()).toBeNull();
  });

  it('앉지 못해도 상한(500ms) 뒤에는 목록이 보인다 - 베일이 목록을 영영 가리는 길은 없다', async () => {
    render(element());
    expect(listOpacity()).toBe(0);
    await sleep(499);
    expect(listOpacity()).toBe(0);
    await sleep(1);
    expect(listOpacity()).not.toBe(0);
    expect(cover()).toBeNull();
  });

  it('필이 없는 표면(스레드 패널·하네스)은 목록이 부모의 직접 자식인 채다: 베일이 없다', () => {
    render(element({jumpPills: false}));
    expect(listOpacity()).not.toBe(0);
    expect(cover()).toBeNull();
  });

  it('내용이 없는 대화에는 가릴 목록이 없다', () => {
    render(element({messages: []}));
    expect(screen.queryByTestId('timeline-list')).toBeNull();
    expect(cover()).toBeNull();
  });
});
