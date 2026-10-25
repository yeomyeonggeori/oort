import type {Message, MessageAttachment, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {act, cleanup, fireEvent, render, renderHook, screen} from '@testing-library/react-native';
import React from 'react';
import {Animated, StyleSheet} from 'react-native';

import {FixedScheme} from '../src/design/theme';
import {
  SEND_ARRIVE_EASE,
  SEND_ARRIVE_MS,
  SEND_ARRIVE_RISE_FACTOR,
  SEND_ARRIVE_RISE_FACTOR_HEAD,
  SEND_ARRIVE_UNMEASURED_HEIGHT,
  SEND_ARRIVE_WINDOW_MS,
} from '../src/design/motion';
import {CONV_ICON_SIZE} from '../src/design/icons';
import {ReduceMotionRefContext} from '../src/features/conversation/LandedTintFade';
import {MessageRow, PendingRow} from '../src/features/conversation/MessageRow';
import {timeLabel} from '../src/features/conversation/MessageActionSheet';
import {resetArrivedForTest} from '../src/features/conversation/sendArrival';
import {SEND_SLOW_MS, useSlowSend} from '../src/features/conversation/sendSlow';

// =============================================================================
// #4455 — 보낼 때 「전송 중」 깜빡임·행 높이 변화 없애기 + Buzz 식 쫀득한 등장.
//
// 이 파일이 재는 것과 못 재는 것. 픽셀 높이는 여기서 못 잰다(jest 는 레이아웃을 하지 않는다 —
// 시뮬레이터 20회 보내기 프레임 측정은 2단계 몫). 그래서 「높이 변화 0」은 **구조 대조**로 잰다:
// 같은 글·같은 머리 여부의 메아리와 서버 사본을 그려, 그려진 글자의 모음과 말풍선·첨부 목록의
// 펼친 스타일이 같은지 본다. 「전송 중」 줄을 되살리면 글자 모음이 달라지고(= 줄 하나, 14.7pt),
// 흐림(`muted`)을 되살리면 불투명도가 달라진다(= 색 한 번 튐) — 사보타주 표는 progress.md.
// =============================================================================

jest.mock('../src/session/useSession', () => ({
  useSession: () => ({
    workspaceId: 'ws',
    member: {id: 'self'},
    signOut: jest.fn(),
  }),
}));

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const NOW = 1_700_000_000_000;

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
  member({id: SELF, displayName: '박서연', handle: 'seoyeon'}),
  member({id: OTHER, displayName: '이도현', handle: 'dohyeon'}),
]);

const ACTIONS = {
  myMemberId: SELF,
  onToggleReaction: async () => {},
  onEdit: async () => {},
  onDelete: async () => {},
};

const flat = (style: unknown): Record<string, any> =>
  (StyleSheet.flatten(style as never) ?? {}) as Record<string, any>;

const FILE: MessageAttachment = {
  id: 'att-1',
  name: '회의록.pdf',
  mime: 'application/pdf',
  sizeBytes: 2048,
};

const pendingMsg = (over: Record<string, unknown> = {}) =>
  ({
    clientMsgId: 'c-1',
    channelId: 'ch',
    authorMemberId: SELF,
    body: '내일 오전에 봐요',
    status: 'sending',
    sinceSeq: null,
    createdAtMs: Date.now(),
    ...over,
  }) as never;

const serverMsg = (over: Partial<Message> = {}): Message => ({
  id: 'msg-1',
  channelId: 'ch',
  seq: 1,
  hlcTs: 1,
  hlcCount: 0,
  authorMemberId: SELF,
  type: 'text',
  body: '내일 오전에 봐요',
  state: 'sent',
  createdAtMs: NOW,
  ...over,
});

const echo = (over: Record<string, unknown> = {}, startsGroup = true) => (
  <PendingRow pending={pendingMsg(over)} startsGroup={startsGroup} directory={DIRECTORY} />
);
const server = (over: Partial<Message> = {}, startsGroup = true) => (
  <MessageRow
    message={serverMsg(over)}
    startsGroup={startsGroup}
    directory={DIRECTORY}
    chips={[]}
    nowMs={NOW}
    actions={ACTIONS}
  />
);

/** 그려진 모든 `Text` 의 글자(자식 문자열을 이은 것). 접근성에서 숨긴 시각도 포함한다. */
function textsOf(): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const n = node as {type?: string; children?: unknown[] | null};
    if (n.type === 'Text') {
      out.push(
        (n.children ?? [])
          .map(child => (typeof child === 'string' ? child : ''))
          .join(''),
      );
    }
    (n.children ?? []).forEach(walk);
  };
  walk(screen.toJSON());
  return out.filter(text => text !== '').sort();
}

/** 행 안쪽 그릇(= 글이 서는 열)의 레이아웃 스타일과 **흐름에 서는** 자식들의 서명. */
type Json = {type: string; props: Record<string, any>; children: Array<Json | string> | null};
const LAYOUT_KEYS = [
  'padding', 'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom', 'paddingHorizontal',
  'paddingVertical', 'margin', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight',
  'marginHorizontal', 'marginVertical', 'gap', 'rowGap', 'columnGap', 'height', 'minHeight',
  'maxHeight', 'borderRadius', 'flexDirection', 'alignItems',
];
function findByTestId(node: unknown, id: string): Json | null {
  if (node === null || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findByTestId(child, id);
      if (hit) return hit;
    }
    return null;
  }
  const n = node as Json;
  if (n.props?.testID === id) return n;
  for (const child of n.children ?? []) {
    const hit = findByTestId(child, id);
    if (hit) return hit;
  }
  return null;
}
function contentColumn(kind: 'echo' | 'server') {
  const root = findByTestId(screen.toJSON(), kind === 'echo' ? 'pending-row' : 'message-press');
  if (root === null) throw new Error(`${kind} row not rendered`);
  const column = kind === 'echo' ? (root.children?.[0] as Json) : root;
  const style = flat(column.props.style);
  const layout = Object.fromEntries(Object.entries(style).filter(([key]) => LAYOUT_KEYS.includes(key)));
  const flow = (column.children ?? [])
    .filter((child): child is Json => typeof child !== 'string')
    .filter(child => flat(child.props?.style).position !== 'absolute')
    .map(child => `${child.type}:${child.props?.testID ?? ''}`);
  return {layout, flow};
}

function spyTiming() {
  return jest.spyOn(Animated, 'timing').mockImplementation(
    () => ({start: jest.fn(), stop: jest.fn(), reset: jest.fn()}) as never,
  );
}

const layoutEvent = (height: number) => ({
  nativeEvent: {layout: {x: 0, y: 0, width: 320, height}},
});

beforeEach(() => {
  resetArrivedForTest();
});
afterEach(() => {
  cleanup();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

// -----------------------------------------------------------------------------
// 정상 전송 — 메아리가 서버 사본과 같은 모양으로 선다
// -----------------------------------------------------------------------------
describe('정상 전송 — 글자·높이·색 변화 0 (구조 대조)', () => {
  it('「전송 중」 줄이 없다 (되살리면 글자 한 줄 = 14.7pt)', () => {
    render(<FixedScheme scheme="dark">{echo()}</FixedScheme>);
    expect(screen.queryByTestId('pending-sending')).toBeNull();
    expect(screen.queryByText('전송 중')).toBeNull();
    // 본문이 그려졌다는 짝 단정 — 행을 통째로 비워도 위 둘은 통과한다.
    expect(screen.getByText('내일 오전에 봐요')).toBeTruthy();
  });

  it('이어지는 행: 메아리와 서버 사본의 글자 모음이 같다', () => {
    const view = render(<FixedScheme scheme="dark">{echo({}, false)}</FixedScheme>);
    const mine = textsOf();
    view.unmount();
    render(<FixedScheme scheme="dark">{server({}, false)}</FixedScheme>);
    expect(textsOf()).toEqual(mine);
    expect(mine).toEqual(['내일 오전에 봐요']);
  });

  it.each([
    ['머리 행', true],
    ['이어지는 행', false],
  ] as const)(
    '%s: 글이 서는 열의 안쪽 여백과 흐름 자식이 서버 사본과 같다 (줄·여백을 더하면 곧 높이 변화)',
    (_name, startsGroup) => {
      const view = render(<FixedScheme scheme="dark">{echo({}, startsGroup)}</FixedScheme>);
      const mine = contentColumn('echo');
      view.unmount();
      render(<FixedScheme scheme="dark">{server({}, startsGroup)}</FixedScheme>);
      const theirs = contentColumn('server');
      expect(mine.layout).toEqual(theirs.layout);
      expect(mine.flow).toEqual(theirs.flow);
      // 짝 단정: 비어 있어서 같은 것이 아니다.
      expect(mine.flow.length).toBeGreaterThan(0);
      expect(Object.keys(mine.layout)).toContain('paddingLeft');
    },
  );

  it('머리 행: 서버 사본에만 생기는 글자는 시각 하나뿐이다 (#1083 — 높이는 안 바뀐다)', () => {
    const view = render(<FixedScheme scheme="dark">{echo({}, true)}</FixedScheme>);
    const mine = textsOf();
    view.unmount();
    render(<FixedScheme scheme="dark">{server({}, true)}</FixedScheme>);
    expect(textsOf()).toEqual([...mine, timeLabel(NOW)].sort());
  });

  it.each(['dark', 'light'] as const)(
    '%s: 말풍선의 펼친 스타일이 서버 사본과 같다 (색 한 번 튀지 않는다)',
    scheme => {
      const view = render(<FixedScheme scheme={scheme}>{echo()}</FixedScheme>);
      const mine = flat(screen.getByTestId('message-bubble').props.style);
      view.unmount();
      render(<FixedScheme scheme={scheme}>{server()}</FixedScheme>);
      const theirs = flat(screen.getByTestId('message-bubble').props.style);
      expect(mine).toEqual(theirs);
      expect(mine.opacity).toBeUndefined();
    },
  );

  it('줄 보기(말풍선 없음)에서도 본문 글자색이 서버 사본과 같다', () => {
    const view = render(
      <FixedScheme scheme="dark" bubble={{layout: 'row'}}>
        {echo()}
      </FixedScheme>,
    );
    const mine = flat(screen.getByText('내일 오전에 봐요').props.style);
    view.unmount();
    render(
      <FixedScheme scheme="dark" bubble={{layout: 'row'}}>
        {server()}
      </FixedScheme>,
    );
    expect(flat(screen.getByText('내일 오전에 봐요').props.style)).toEqual(mine);
  });

  it('첨부 목록도 흐리지 않는다 (서버 사본과 같은 불투명도)', () => {
    const view = render(
      <FixedScheme scheme="dark">{echo({attachments: [FILE]})}</FixedScheme>,
    );
    const mine = flat(screen.getByTestId('attachment-list').props.style);
    view.unmount();
    render(
      <FixedScheme scheme="dark">{server({attachments: [FILE]})}</FixedScheme>,
    );
    expect(flat(screen.getByTestId('attachment-list').props.style)).toEqual(mine);
    expect(mine.opacity).toBeUndefined();
  });

  it('사진·파일만 보낸 메아리는 빈 말풍선을 세우지 않는다 (서버 사본이 본문 칸을 접는다)', () => {
    const view = render(
      <FixedScheme scheme="dark">{echo({body: '', attachments: [FILE]})}</FixedScheme>,
    );
    expect(screen.queryAllByTestId('message-bubble')).toHaveLength(0);
    expect(screen.getByTestId('attachment-list')).toBeTruthy();
    const mine = textsOf();
    view.unmount();
    render(
      <FixedScheme scheme="dark">
        {server({body: undefined, attachments: [FILE]})}
      </FixedScheme>,
    );
    expect(screen.queryAllByTestId('message-bubble')).toHaveLength(0);
    // 서버 사본의 머리 행 글자 = 메아리의 것 + 시각.
    expect(textsOf()).toEqual([...mine, timeLabel(NOW)].sort());
  });
});

describe('실패한 메아리 — 예전 그대로', () => {
  it('흐린 본문 + 「전송 실패」 + 「다시 보내기」', () => {
    const onResend = jest.fn();
    render(
      <FixedScheme scheme="dark">
        <PendingRow
          pending={pendingMsg({status: 'failed'})}
          startsGroup
          directory={DIRECTORY}
          onResend={onResend}
        />
      </FixedScheme>,
    );
    expect(screen.getByText('전송 실패')).toBeTruthy();
    expect(flat(screen.getByTestId('message-bubble').props.style).opacity).toBe(0.6);
    fireEvent.press(screen.getByTestId('pending-resend'));
    expect(onResend).toHaveBeenCalledWith('c-1');
    // 실패한 줄에는 시계가 없다.
    expect(screen.queryByTestId('pending-slow')).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// 느린 전송의 표지
// -----------------------------------------------------------------------------
describe('느린 전송 — 기준 시간 뒤에만 시계 하나', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  it('SEND_SLOW_MS - 1 까지는 없고, SEND_SLOW_MS 에 선다', () => {
    render(<FixedScheme scheme="dark">{echo({createdAtMs: NOW})}</FixedScheme>);
    expect(screen.queryByTestId('pending-slow')).toBeNull();
    act(() => {
      jest.advanceTimersByTime(SEND_SLOW_MS - 1);
    });
    expect(screen.queryByTestId('pending-slow')).toBeNull();
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(screen.getByTestId('pending-slow')).toBeTruthy();
    expect(screen.getByLabelText('전송이 오래 걸리고 있어요')).toBeTruthy();
  });

  it('이미 기준을 넘긴 채 마운트되면(가상화 재마운트) 첫 렌더부터 서 있다', () => {
    render(
      <FixedScheme scheme="dark">
        {echo({createdAtMs: NOW - SEND_SLOW_MS - 1})}
      </FixedScheme>,
    );
    expect(screen.getByTestId('pending-slow')).toBeTruthy();
  });

  it('기준 직전에 마운트된 재마운트는 남은 시간만 기다린다 (마운트 시각부터 다시 세지 않는다)', () => {
    render(
      <FixedScheme scheme="dark">
        {echo({createdAtMs: NOW - (SEND_SLOW_MS - 100)})}
      </FixedScheme>,
    );
    expect(screen.queryByTestId('pending-slow')).toBeNull();
    act(() => {
      jest.advanceTimersByTime(99);
    });
    expect(screen.queryByTestId('pending-slow')).toBeNull();
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(screen.getByTestId('pending-slow')).toBeTruthy();
  });

  it('실패하면 시계가 걷히고 실패 줄이 선다 — 실패한 행에는 시계가 없다', () => {
    const view = render(<FixedScheme scheme="dark">{echo({createdAtMs: NOW})}</FixedScheme>);
    act(() => {
      jest.advanceTimersByTime(SEND_SLOW_MS);
    });
    expect(screen.getByTestId('pending-slow')).toBeTruthy();
    view.rerender(
      <FixedScheme scheme="dark">{echo({createdAtMs: NOW, status: 'failed'})}</FixedScheme>,
    );
    expect(screen.queryByTestId('pending-slow')).toBeNull();
    expect(screen.getByText('전송 실패')).toBeTruthy();
  });

  it('다시 보내기는 새 시도라 그때부터 다시 센다 (보낸 시각을 그대로 두는 재시도가 곧바로 시계를 띄우지 않는다)', () => {
    const view = render(
      <FixedScheme scheme="dark">{echo({createdAtMs: NOW, status: 'failed'})}</FixedScheme>,
    );
    act(() => {
      jest.advanceTimersByTime(10_000);
    });
    expect(screen.queryByTestId('pending-slow')).toBeNull();
    view.rerender(
      <FixedScheme scheme="dark">{echo({createdAtMs: NOW, status: 'sending'})}</FixedScheme>,
    );
    expect(screen.queryByTestId('pending-slow')).toBeNull();
    act(() => {
      jest.advanceTimersByTime(SEND_SLOW_MS - 1);
    });
    expect(screen.queryByTestId('pending-slow')).toBeNull();
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(screen.getByTestId('pending-slow')).toBeTruthy();
  });

  it('타이머는 하나이고 언마운트에서 걷힌다 (훅 단독)', () => {
    const {result, unmount} = renderHook(() => useSlowSend(NOW, 'sending'));
    expect(result.current).toBe(false);
    expect(jest.getTimerCount()).toBe(1);
    unmount();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('실패로 바뀌면 타이머가 걷히고 표지도 걷힌다 (훅 단독)', () => {
    const {result, rerender} = renderHook(
      ({status}: {status: 'sending' | 'failed'}) => useSlowSend(NOW, status),
      {initialProps: {status: 'sending'}},
    );
    expect(jest.getTimerCount()).toBe(1);
    rerender({status: 'failed'});
    expect(jest.getTimerCount()).toBe(0);
    act(() => {
      jest.advanceTimersByTime(SEND_SLOW_MS * 2);
    });
    expect(result.current).toBe(false);
  });

  it('보낸 시각을 알 수 없으면 마운트 시각부터 센다', () => {
    const {result} = renderHook(() => useSlowSend(Number.NaN, 'sending'));
    expect(result.current).toBe(false);
    act(() => {
      jest.advanceTimersByTime(SEND_SLOW_MS - 1);
    });
    expect(result.current).toBe(false);
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(result.current).toBe(true);
  });

  /** 요소에서 위로 올라가며 펼친 스타일이 `match` 를 만족하는 첫 조상(자기 포함)의 스타일. */
  function ancestorStyle(
    element: {parent: unknown; props: {style?: unknown}} | null,
    match: (style: Record<string, any>) => boolean,
  ): Record<string, any> | null {
    let node = element;
    for (let hops = 0; node !== null && hops < 8; hops += 1) {
      const style = flat(node.props?.style);
      if (match(style)) return style;
      node = node.parent as typeof element;
    }
    return null;
  }

  it('흐름에 자리를 차지하지 않는다 — 머리 행은 폭·높이 0 상자에 절대 배치', () => {
    // 인라인으로 두면 이름 줄이 넘어가거나 줄 높이가 바뀌는 순간이 생긴다(= 1.5초에 생기는 높이 변화).
    render(
      <FixedScheme scheme="dark">{echo({createdAtMs: NOW - SEND_SLOW_MS}, true)}</FixedScheme>,
    );
    const mark = screen.getByTestId('pending-slow');
    expect(flat(mark.props.style)).toMatchObject({
      position: 'absolute',
      width: CONV_ICON_SIZE.clock,
      height: CONV_ICON_SIZE.clock,
    });
    // 이름 줄 안의 폭 0·높이 0 상자가 표지를 든다.
    const host = ancestorStyle(
      mark as never,
      style => style.width === 0 && style.height === 0,
    );
    expect(host).not.toBeNull();
    // 시각 글자는 여전히 없다(#1083).
    expect(screen.queryByTestId('row-time', {includeHiddenElements: true})).toBeNull();
  });

  it('시계는 서버 사본의 시각 글자와 같은 색이다 (시각이 그 자리를 이어받는다)', () => {
    const view = render(<FixedScheme scheme="dark">{server()}</FixedScheme>);
    const timeColor = flat(
      screen.getByTestId('row-time', {includeHiddenElements: true}).props.style,
    ).color;
    view.unmount();
    render(
      <FixedScheme scheme="dark">{echo({createdAtMs: NOW - SEND_SLOW_MS}, true)}</FixedScheme>,
    );
    expect(timeColor).toBeTruthy();
    expect(flat(screen.getByTestId('pending-slow').props.style).tintColor).toBe(timeColor);
  });

  it('흐름에 자리를 차지하지 않는다 — 이어지는 행은 아바타 칸에 절대 배치', () => {
    render(
      <FixedScheme scheme="dark">{echo({createdAtMs: NOW - SEND_SLOW_MS}, false)}</FixedScheme>,
    );
    const mark = screen.getByTestId('pending-slow');
    const gutter = ancestorStyle(
      mark.parent as never,
      style => style.position === 'absolute' && style.width !== undefined,
    );
    expect(gutter).not.toBeNull();
    expect(gutter).toMatchObject({position: 'absolute'});
  });
});

// -----------------------------------------------------------------------------
// 등장
// -----------------------------------------------------------------------------
describe('보낸 메시지 등장 — 자기 높이에 비례해 입력창 밑에서 올라온다', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
  });

  const row = () => flat(screen.getByTestId('pending-row').props.style);

  it('한 번, 300ms · Buzz 곡선 · 남은 비율 1→0 · 네이티브 구동', () => {
    const timing = spyTiming();
    render(<FixedScheme scheme="dark">{echo({createdAtMs: NOW})}</FixedScheme>);
    expect(timing).toHaveBeenCalledTimes(1);
    expect(timing.mock.calls[0][1]).toMatchObject({
      toValue: 0,
      duration: SEND_ARRIVE_MS,
      easing: SEND_ARRIVE_EASE,
      useNativeDriver: true,
    });
    expect(SEND_ARRIVE_MS).toBe(300);
  });

  it('transform 만 움직인다 — 불투명도·높이·여백은 건드리지 않는다', () => {
    spyTiming();
    render(<FixedScheme scheme="dark">{echo({createdAtMs: NOW})}</FixedScheme>);
    const style = row();
    expect(style.transform).toHaveLength(1);
    expect(style.opacity).toBeUndefined();
    expect(style.height).toBeUndefined();
    expect(style.maxHeight).toBeUndefined();
  });

  it('높이를 재기 전에는 목록 가장자리 밑에 숨어 있다 (가정 높이 × 배수)', () => {
    spyTiming();
    render(<FixedScheme scheme="dark">{echo({createdAtMs: NOW})}</FixedScheme>);
    expect(row().transform[0].translateY).toBe(
      SEND_ARRIVE_RISE_FACTOR_HEAD * SEND_ARRIVE_UNMEASURED_HEIGHT,
    );
  });

  it.each([
    ['이어지는 행', false, SEND_ARRIVE_RISE_FACTOR],
    ['머리 행', true, SEND_ARRIVE_RISE_FACTOR_HEAD],
  ] as const)('%s: 시작 거리는 잰 높이의 %s배', (_name, startsGroup, factor) => {
    spyTiming();
    render(<FixedScheme scheme="dark">{echo({createdAtMs: NOW}, startsGroup)}</FixedScheme>);
    expect(factor).toBeGreaterThan(1);
    for (const height of [52, 130]) {
      act(() => {
        fireEvent(screen.getByTestId('pending-row'), 'layout', layoutEvent(height));
      });
      expect(row().transform[0].translateY).toBeCloseTo(factor * height, 5);
    }
    // 머리 행이 더 멀리서 출발한다 — 작성자 머리(아바타)가 서는 행.
    expect(SEND_ARRIVE_RISE_FACTOR_HEAD).toBeGreaterThan(SEND_ARRIVE_RISE_FACTOR);
  });

  it('자격 창: 보낸 지 1000ms 까지는 올라오고, 1001ms 부터는 처음부터 자리에 선다', () => {
    const timing = spyTiming();
    for (const [age, plays] of [
      [0, true],
      [SEND_ARRIVE_WINDOW_MS - 1, true],
      [SEND_ARRIVE_WINDOW_MS, true],
      [SEND_ARRIVE_WINDOW_MS + 1, false],
      [60_000, false],
    ] as const) {
      resetArrivedForTest();
      timing.mockClear();
      const view = render(
        <FixedScheme scheme="dark">{echo({createdAtMs: NOW - age})}</FixedScheme>,
      );
      expect(timing).toHaveBeenCalledTimes(plays ? 1 : 0);
      expect(row().transform === undefined).toBe(!plays);
      view.unmount();
    }
  });

  it('보낸 시각을 알 수 없는 행은 움직이지 않는다 (모르는 행을 방금 보낸 것으로 읽지 않는다)', () => {
    const timing = spyTiming();
    render(<FixedScheme scheme="dark">{echo({createdAtMs: undefined})}</FixedScheme>);
    expect(timing).not.toHaveBeenCalled();
  });

  it('「동작 줄이기」면 애니메이션 호출 0, transform 없이 처음부터 자리에 선다', () => {
    const timing = spyTiming();
    render(
      <ReduceMotionRefContext.Provider value={{current: true}}>
        <FixedScheme scheme="dark">{echo({createdAtMs: NOW})}</FixedScheme>
      </ReduceMotionRefContext.Provider>,
    );
    expect(timing).not.toHaveBeenCalled();
    expect(row().transform).toBeUndefined();
    expect(row().opacity).toBeUndefined();
  });

  it('같은 메아리를 다시 마운트하면 두 번째 등장은 없다 (한 번만)', () => {
    const timing = spyTiming();
    const first = render(<FixedScheme scheme="dark">{echo({createdAtMs: NOW})}</FixedScheme>);
    first.unmount();
    render(<FixedScheme scheme="dark">{echo({createdAtMs: NOW})}</FixedScheme>);
    expect(timing).toHaveBeenCalledTimes(1);
    expect(row().transform).toBeUndefined();
  });

  it('서버 사본이 메아리를 대체할 때 움직이지 않는다', () => {
    const timing = spyTiming();
    const view = render(<FixedScheme scheme="dark">{echo({createdAtMs: NOW})}</FixedScheme>);
    expect(timing).toHaveBeenCalledTimes(1);
    view.rerender(<FixedScheme scheme="dark">{server()}</FixedScheme>);
    expect(timing).toHaveBeenCalledTimes(1);
  });

  it('이미 실패한 행(복원된 전송)은 움직이지 않는다', () => {
    const timing = spyTiming();
    render(
      <FixedScheme scheme="dark">{echo({createdAtMs: NOW, status: 'failed'})}</FixedScheme>,
    );
    expect(timing).not.toHaveBeenCalled();
  });
});

describe('보낸 메시지 등장 — 실제로 앉는다 (가짜 시계로 끝까지 돌린다)', () => {
  it('높이 60 의 머리 행: 출발 150pt → 곡선 위의 중간값 → 300ms 뒤 정확히 0', () => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    // 네이티브 구동은 jest 에서 값을 JS 로 돌려주지 않는다. 운영 코드가 부른 **그 설정 그대로**
    // 자바스크립트 구동으로 돌려 값을 읽는다(곡선·길이·도착값은 바꾸지 않는다).
    const realTiming = Animated.timing;
    const configs: Animated.TimingAnimationConfig[] = [];
    jest.spyOn(Animated, 'timing').mockImplementation(((
      value: Animated.Value,
      config: Animated.TimingAnimationConfig,
    ) => {
      configs.push(config);
      return realTiming(value, {...config, useNativeDriver: false});
    }) as never);

    render(<FixedScheme scheme="dark">{echo({createdAtMs: NOW})}</FixedScheme>);
    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({toValue: 0, duration: SEND_ARRIVE_MS, useNativeDriver: true});
    act(() => {
      fireEvent(screen.getByTestId('pending-row'), 'layout', layoutEvent(60));
    });
    const y = () => flat(screen.getByTestId('pending-row').props.style).transform[0].translateY;
    const start = SEND_ARRIVE_RISE_FACTOR_HEAD * 60;
    expect(y()).toBeCloseTo(start, 3);

    act(() => {
      jest.advanceTimersByTime(SEND_ARRIVE_MS / 2);
    });
    const mid = y();
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(start);
    // 곡선 위의 값이다: 남은 비율 = 1 - 곡선(0.5). (프레임 간격 16ms 어림이라 소수 첫째 자리까지.)
    expect(mid / start).toBeCloseTo(1 - SEND_ARRIVE_EASE(0.5), 1);

    act(() => {
      jest.advanceTimersByTime(SEND_ARRIVE_MS);
    });
    expect(y()).toBe(0);
  });
});
