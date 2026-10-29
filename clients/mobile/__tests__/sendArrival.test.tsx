// sendArrival — 보낸 메시지 등장·대기·표면 (sendArrival)
// 합친 원본: sendArrival4455.test.tsx, sendArrivalHold4455.test.tsx, sendArrivalStandby4455.test.tsx, sendArrivalStandbyTail4455.test.tsx, sendArrivalSurface4455.test.tsx
// 이슈 번호는 아래 묶음 `describe` 이름과 주석에 남아 있다.

import type {Message, MessageAttachment} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  within,
} from '@testing-library/react-native';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import {Animated, Dimensions, View} from 'react-native';
import type {
  PendingMessage,
  TimelineItem,
} from '@momo/core/features/timeline/model';

import {FixedScheme} from '../src/design/theme';
import {
  SEND_ARRIVE_EASE,
  SEND_ARRIVE_HOLD_SLACK_MS,
  SEND_ARRIVE_MS,
  SEND_ARRIVE_RISE_FACTOR,
  SEND_ARRIVE_RISE_FACTOR_HEAD,
  SEND_ARRIVE_UNMEASURED_HEIGHT,
  SEND_ARRIVE_WINDOW_MS,
} from '../src/design/motion';
import {CONV_ICON_SIZE} from '../src/design/icons';
import {ReduceMotionRefContext} from '../src/features/conversation/LandedTintFade';
import {
  MessageRow,
  type MessageRowActions,
  PendingRow,
  slowMarkGutterTop,
} from '../src/features/conversation/MessageRow';
import {timeLabel} from '../src/features/conversation/MessageActionSheet';
import {
  ARRIVAL_SURFACE_CHANNEL,
  arrivalsInFlight,
  carriesInlinePhoto,
  ECHO_LINGER_MS,
  holdArrival,
  holdSettledArrivals,
  isStandbyItem,
  markArrived,
  photoEchoesOf,
  resetArrivedForTest,
  sameEchoes,
  settledEchoes,
  subscribeArrivals,
  swapLingeringEchoes,
  threadArrivalSurface,
} from '../src/features/conversation/sendArrival';
import {SEND_SLOW_MS, useSlowSend} from '../src/features/conversation/sendSlow';
import {CONV} from '../src/features/conversation/convDesign';
import {line} from '../src/design/tokens';
import {Timeline} from '../src/features/conversation/Timeline';
import {resetAttachmentContentForTest} from '../src/features/attachments/content';
import {ThreadPanel} from '../src/features/conversation/ThreadPanel';
import type {UseTimelineResult} from '../src/features/conversation/useTimeline';
import {drainRender, flat, member} from './testkit';

jest.mock('../src/session/useSession', () => ({
  useSession: () => ({
    workspaceId: 'ws',
    member: {id: 'self'},
    signOut: jest.fn(),
  }),
}));

// ---- 아래 묶음들이 함께 쓰는 고정값·도구 (원래 파일마다 글자 그대로 같게 선언돼 있던 것)
const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const NOW = 1_700_000_000_000;

function spyTiming() {
  return jest.spyOn(Animated, 'timing').mockImplementation(
    () => ({start: jest.fn(), stop: jest.fn(), reset: jest.fn()}) as never,
  );
}

function message(seq: number, over: Partial<Message> = {}): Message {
  return {
    id: `msg-${seq}`,
    channelId: 'ch',
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: OTHER,
    type: 'text',
    body: `메시지 ${seq}`,
    state: 'sent',
    createdAtMs: NOW - 600_000 + seq * 1000,
    ...over,
  };
}

const item = (m: Message, startsGroup = true): TimelineItem => ({
  kind: 'message',
  key: `m-${m.seq}`,
  message: m,
  startsGroup,
});

interface FileSystemMock {
  __reset: () => void;
}
const fileSystem = jest.requireMock('expo-file-system') as FileSystemMock;
const HOLD_MS = SEND_ARRIVE_MS + SEND_ARRIVE_HOLD_SLACK_MS;

// =============================================================================
// 합친 시험: 원래 sendArrival4455.test.tsx (#4455)
// =============================================================================
describe('sendArrival (#4455)', () => {
  // =============================================================================
  // #4455 — 보낼 때 「전송 중」 깜빡임·행 높이 변화 없애기 + Buzz 식 쫀득한 등장.
  //
  // 이 파일이 재는 것과 못 재는 것. 픽셀 높이는 여기서 못 잰다(jest 는 레이아웃을 하지 않는다 —
  // 시뮬레이터 20회 보내기 프레임 측정은 2단계 몫). 그래서 「높이 변화 0」은 **구조 대조**로 잰다:
  // 같은 글·같은 머리 여부의 메아리와 서버 사본을 그려, 그려진 글자의 모음과 말풍선·첨부 목록의
  // 펼친 스타일이 같은지 본다. 「전송 중」 줄을 되살리면 글자 모음이 달라지고(= 줄 하나, 14.7pt),
  // 흐림(`muted`)을 되살리면 불투명도가 달라진다(= 색 한 번 튐) — 사보타주 표는 progress.md.
  // =============================================================================

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
  /** `id` 를 testID 로 든 자식의 **부모** 노드. */
  function parentOfTestId(node: unknown, id: string): Json | null {
    if (node === null || typeof node !== 'object') return null;
    if (Array.isArray(node)) {
      for (const child of node) {
        const hit = parentOfTestId(child, id);
        if (hit) return hit;
      }
      return null;
    }
    const n = node as Json;
    for (const child of n.children ?? []) {
      if (typeof child !== 'string' && child.props?.testID === id) return n;
    }
    for (const child of n.children ?? []) {
      const hit = parentOfTestId(child, id);
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

  const layoutEvent = (height: number) => ({
    nativeEvent: {layout: {x: 0, y: 0, width: 320, height}},
  });

  beforeEach(() => {
    resetArrivedForTest();
  });
  afterEach(async () => {
    await drainRender();
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

    // planner 결정(#4455): #1083 「지어내지 않는다」를 메아리 **머리 행에 한해** 뒤집었다. 서버 사본이 올 때
    // 시각 글자가 새로 생기는 것도 「보낼 때 잠깐 생겼다 사라지는 글자」와 같은 종류의 깜빡임이다.
    it('머리 행: 메아리가 기기 시계의 시각을 그려서 서버 사본과 글자 모음이 같다 (같은 분 — 글자 변화 0)', () => {
      const view = render(<FixedScheme scheme="dark">{echo({createdAtMs: NOW}, true)}</FixedScheme>);
      const mine = textsOf();
      // 짝 단정: 시각이 실제로 그려졌다(비어 있어서 같은 것이 아니다).
      expect(mine).toContain(timeLabel(NOW));
      expect(screen.getAllByTestId('row-time', {includeHiddenElements: true})).toHaveLength(1);
      view.unmount();
      render(<FixedScheme scheme="dark">{server({}, true)}</FixedScheme>);
      expect(textsOf()).toEqual(mine);
    });

    it('머리 행: 분이 다르면(분 경계·기기 시계 오차) 교체 때 시각 글자만 서버 시각으로 바뀐다 — 알려진 위험', () => {
      const view = render(<FixedScheme scheme="dark">{echo({createdAtMs: NOW}, true)}</FixedScheme>);
      const mine = textsOf();
      view.unmount();
      const later = NOW + 61_000; // 61초 뒤 = 언제나 다른 분
      expect(timeLabel(later)).not.toBe(timeLabel(NOW));
      render(<FixedScheme scheme="dark">{server({createdAtMs: later}, true)}</FixedScheme>);
      expect(textsOf()).toEqual(
        mine.filter(text => text !== timeLabel(NOW)).concat(timeLabel(later)).sort(),
      );
    });

    it('이어지는 행의 메아리는 시각을 그리지 않는다 (서버 사본의 연속 행과 같다)', () => {
      render(<FixedScheme scheme="dark">{echo({createdAtMs: NOW}, false)}</FixedScheme>);
      expect(screen.queryByTestId('row-time', {includeHiddenElements: true})).toBeNull();
    });

    it('보낸 시각을 알 수 없으면 시각을 지어내지 않는다 (「NaN:NaN」을 그리지 않는다)', () => {
      render(<FixedScheme scheme="dark">{echo({createdAtMs: Number.NaN}, true)}</FixedScheme>);
      expect(screen.queryByTestId('row-time', {includeHiddenElements: true})).toBeNull();
      expect(textsOf().some(text => text.includes('NaN'))).toBe(false);
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
        <FixedScheme scheme="dark">
          {echo({body: '', attachments: [FILE], createdAtMs: NOW})}
        </FixedScheme>,
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
      // 서버 사본의 머리 행 글자 = 메아리의 것(같은 분의 시각 포함).
      expect(textsOf()).toEqual(mine);
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

    it('SEND_SLOW_MS - 1 까지는 없고, SEND_SLOW_MS 에 선다 — 낭독도 그때부터만 「전송 중」', () => {
      render(<FixedScheme scheme="dark">{echo({createdAtMs: NOW})}</FixedScheme>);
      expect(screen.queryByTestId('pending-slow')).toBeNull();
      // 정상 전송에는 낭독이 없다(planner 결정 3).
      expect(screen.queryByLabelText('전송 중')).toBeNull();
      act(() => {
        jest.advanceTimersByTime(SEND_SLOW_MS - 1);
      });
      expect(screen.queryByTestId('pending-slow')).toBeNull();
      expect(screen.queryByLabelText('전송 중')).toBeNull();
      act(() => {
        jest.advanceTimersByTime(1);
      });
      expect(screen.getByTestId('pending-slow')).toBeTruthy();
      expect(screen.getByLabelText('전송 중')).toBeTruthy();
      // 옛 라벨은 없다.
      expect(screen.queryByLabelText('전송이 오래 걸리고 있어요')).toBeNull();
    });

    it('실패한 행의 낭독은 기존 그대로다 — 「전송 실패」·「다시 보내기」, 「전송 중」은 없다', () => {
      render(
        <FixedScheme scheme="dark">
          <PendingRow
            pending={pendingMsg({status: 'failed', createdAtMs: NOW - 10 * SEND_SLOW_MS})}
            startsGroup
            directory={DIRECTORY}
            onResend={jest.fn()}
          />
        </FixedScheme>,
      );
      expect(screen.queryByLabelText('전송 중')).toBeNull();
      expect(screen.getByText('전송 실패')).toBeTruthy();
      expect(screen.getByTestId('pending-resend')).toBeTruthy();
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
      // 시각 글자는 메아리도 그린다(planner 결정 — #1083 을 머리 행에 한해 뒤집음).
      expect(screen.getByTestId('row-time', {includeHiddenElements: true})).toBeTruthy();
    });

    it('머리 행: 시계는 시각 바로 오른쪽 형제(폭·높이 0 상자)에 선다 — 서버 사본이 오면 시계만 사라진다', () => {
      const view = render(
        <FixedScheme scheme="dark">{echo({createdAtMs: NOW - SEND_SLOW_MS}, true)}</FixedScheme>,
      );
      const line = parentOfTestId(screen.toJSON(), 'row-time');
      expect(line).not.toBeNull();
      const kids = ((line as Json).children ?? []).filter(
        (child): child is Json => typeof child !== 'string',
      );
      const at = kids.findIndex(child => child.props?.testID === 'row-time');
      expect(at).toBeGreaterThanOrEqual(0);
      const next = kids[at + 1];
      expect(next).toBeDefined();
      expect(flat(next.props.style)).toMatchObject({width: 0, height: 0});
      expect(findByTestId(next, 'pending-slow')).not.toBeNull();
      // 서버 사본의 같은 줄에는 시각만 있고 시계 상자는 없다.
      view.unmount();
      render(<FixedScheme scheme="dark">{server({}, true)}</FixedScheme>);
      expect(screen.queryByTestId('pending-slow')).toBeNull();
      const copyLine = parentOfTestId(screen.toJSON(), 'row-time') as Json;
      const copyKids = (copyLine.children ?? []).filter(
        (child): child is Json => typeof child !== 'string',
      );
      expect(copyKids.some(child => flat(child.props?.style).width === 0)).toBe(false);
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

  // -----------------------------------------------------------------------------
  // 사다리 전용 칸 `send-arrive` — 웹에 짝이 없으므로 값이 아니라 **관계**를 단정한다
  // (README §6 「폰에 값을 더할 때」: 값이 아니라 관계여야 웹이 다시 움직여도 산다).
  // -----------------------------------------------------------------------------
  describe('사다리 전용 칸 send-arrive — 값이 아니라 관계 (planner 결정 2)', () => {
    const MOTION_CSS = fs.readFileSync(
      path.join(__dirname, '../../web/src/design/motion.css'),
      'utf8',
    );
    const README = fs.readFileSync(
      path.join(__dirname, '../../../docs/design-system/README.md'),
      'utf8',
    );
    /** 웹 사다리(`motion.css` :root 의 첫 정의)에서 칸의 ms 를 읽는다. 기대값을 베끼지 않는다. */
    const rung = (name: string): number => {
      const match = new RegExp(`--motion-${name}:\\s*(\\d+)ms`).exec(MOTION_CSS);
      if (match === null) throw new Error(`--motion-${name} 을 motion.css 에서 못 찾았다`);
      return Number(match[1]);
    };

    it('standard < send-arrive < arrival — 웹 사다리의 이웃 칸 사이에 선다', () => {
      expect(rung('standard')).toBeLessThan(SEND_ARRIVE_MS);
      expect(SEND_ARRIVE_MS).toBeLessThan(rung('arrival'));
    });

    it('등장 < 자격 창 < 느린 전송 기준 — 시계는 등장이 끝난 뒤에만 선다', () => {
      expect(SEND_ARRIVE_MS).toBeLessThan(SEND_ARRIVE_WINDOW_MS);
      expect(SEND_ARRIVE_WINDOW_MS).toBeLessThan(SEND_SLOW_MS);
    });

    it('README 사다리 표의 `send-arrive` 행이 코드의 값과 같다 (문서와 코드가 어긋나면 붉다)', () => {
      const row = /\|\s*`send-arrive`[^|]*\|\s*(\d+)ms\s*\|/.exec(README);
      expect(row).not.toBeNull();
      expect(Number((row as RegExpExecArray)[1])).toBe(SEND_ARRIVE_MS);
      expect(README).toContain('SEND_ARRIVE_');
    });
  });
});

// =============================================================================
// 합친 시험: 원래 sendArrivalHold4455.test.tsx (#4455)
// =============================================================================
describe('sendArrivalHold (#4455)', () => {
  // =============================================================================
  // #4455 design-review r1 H1 — 확정본이 등장 도중에 와도 메아리를 자리에 둔다.
  //
  // 메아리의 오름은 메아리 자신의 transform 이고, 서버 사본이 오면 키가 `p-<clientMsgId>` → `m-<seq>` 로
  // 바뀌어 메아리가 언마운트된다. 등장이 끝나기 전에 확정본이 오면 남은 오름이 한 번에 사라지므로(r1 이 이
  // 면을 짚었다: 확정이 131ms 에 온 보내기가 이미 20회 원본에 있었다), 오름이 도는 동안은 확정본 자리에
  // 같은 키의 메아리를 그대로 둔다(`sendArrival.ts`). 여기서 재는 것:
  //   - 순수 함수 `holdSettledArrivals` 의 짝 짓기 규칙(한 번씩·보낸 순서·채널·미정착은 건드리지 않음)
  //   - 장부 `holdArrival` 의 시계(보류는 시간으로만 끝난다)와 구독 참조
  //   - `PendingRow` 가 **오름이 도는 행만** 적는다
  //   - `Timeline` 에서 같은 인스턴스가 이어진다(애니메이션 한 번, 확정본은 보류가 끝난 뒤에 선다)
  // 그리고 같은 리뷰의 M2(시계 상자 줄바꿈 방지)·M3(글자 배율)·L2(곡선 고정)를 **관계**로 단정한다.
  // =============================================================================

  const DIRECTORY = makeDirectory([
    member({id: SELF, displayName: '박서연', handle: 'seoyeon'}),
    member({id: OTHER, displayName: '이도현', handle: 'dohyeon'}),
  ]);

  function echo(over: Partial<PendingMessage> = {}): PendingMessage {
    return {
      clientMsgId: 'c-1',
      channelId: 'ch',
      authorMemberId: SELF,
      body: '내일 오전에 봐요',
      createdAtMs: NOW,
      sinceSeq: 2,
      status: 'sending',
      ...over,
    };
  }

  /** 내가 보낸 글의 확정본. */
  const mine = (seq: number, over: Partial<Message> = {}): Message =>
    message(seq, {authorMemberId: SELF, body: '내일 오전에 봐요', createdAtMs: NOW + 100, ...over});

  beforeEach(() => {
    resetArrivedForTest();
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });
  afterEach(async () => {
    await drainRender();
    cleanup();
    jest.useRealTimers();
    jest.restoreAllMocks();
    resetArrivedForTest();
  });

  // -----------------------------------------------------------------------------
  // 순수 함수: 확정본 자리에 메아리를 되돌려 세운다
  // -----------------------------------------------------------------------------
  describe('holdSettledArrivals — 짝 짓기', () => {
    const arrival = (pending: PendingMessage, startsGroup = true) => ({
      pending,
      startsGroup,
      untilMs: NOW + SEND_ARRIVE_MS + SEND_ARRIVE_HOLD_SLACK_MS,
      // 표면은 채널 목록이다(스레드 표면은 같은 파일의 `sendArrivalSurface` 묶음).
      surface: ARRIVAL_SURFACE_CHANNEL,
    });

    it('오름이 도는 메아리가 없으면 받은 배열을 그대로 돌려준다(참조 동일 — memo 를 지킨다)', () => {
      const items = [item(message(1)), item(message(2))];
      expect(holdSettledArrivals(items, [])).toBe(items);
    });

    it('확정본 항목을 같은 키(`p-<clientMsgId>`)의 메아리 항목으로 바꾼다 — 자리·머리 행 여부 그대로', () => {
      const items = [item(message(1)), item(message(2)), item(mine(3))];
      const out = holdSettledArrivals(items, [arrival(echo(), false)]);
      expect(out).not.toBe(items);
      expect(out).toHaveLength(3);
      expect(out[0]).toBe(items[0]);
      expect(out[1]).toBe(items[1]);
      expect(out[2]).toEqual({
        kind: 'pending',
        key: 'p-c-1',
        pending: echo(),
        // 메아리가 마운트될 때의 모양이다(확정본의 값이 아니다).
        startsGroup: false,
      });
      // 원본 배열은 건드리지 않는다.
      expect(items[2].kind).toBe('message');
    });

    it('메아리가 아직 자기 키로 서 있으면(미정착) 건드리지 않는다 — 같은 글의 남의 확정본을 가로채지 않는다', () => {
      // 같은 글을 먼저 보낸 메아리(c-0, 오름 장부에 없음)의 확정본이 이미 와 있고, 폴드는 그 확정본을 c-0 에 주었다.
      // c-1 은 미정착이라 자기 키로 서 있다. 이때 c-1 이 같은 내용이라는 이유로 확정본 자리를 가져가면 `p-c-1` 키가 둘이 된다.
      const own: TimelineItem = {kind: 'pending', key: 'p-c-1', pending: echo(), startsGroup: true};
      const items = [item(message(1)), item(message(2)), item(mine(3)), own];
      const out = holdSettledArrivals(items, [arrival(echo())]);
      expect(out).toBe(items);
      expect(out.filter(entry => entry.key === 'p-c-1')).toHaveLength(1);
    });

    it('짝이 아닌 확정본은 그대로다 — 다른 사람·다른 글·sinceSeq 이하·다른 채널', () => {
      for (const other of [
        mine(3, {authorMemberId: OTHER}),
        mine(3, {body: '다른 글'}),
        mine(2),
        mine(3, {channelId: 'other-channel'}),
      ]) {
        const items = [item(message(1)), item(other)];
        expect(holdSettledArrivals(items, [arrival(echo())])).toBe(items);
      }
    });

    it('메아리 하나는 확정본 하나만 대신한다 — 같은 글을 두 번 보내도 보낸 순서대로 하나씩', () => {
      const first = echo({clientMsgId: 'c-1'});
      const second = echo({clientMsgId: 'c-2', createdAtMs: NOW + 50});
      const items = [item(message(1)), item(message(2)), item(mine(3)), item(mine(4), false)];
      const out = holdSettledArrivals(items, [arrival(first), arrival(second, false)]);
      expect(out.map(i => i.key)).toEqual(['m-1', 'm-2', 'p-c-1', 'p-c-2']);
      // 확정본이 하나뿐이면 둘째 메아리는 자리를 못 얻는다.
      const single = holdSettledArrivals(items.slice(0, 3), [arrival(first), arrival(second)]);
      expect(single.map(i => i.key)).toEqual(['m-1', 'm-2', 'p-c-1']);
    });

    it('첨부가 붙은 전송은 첨부 id 까지 맞아야 짝이다(코어 `confirmsPending`)', () => {
      const file = {id: 'att-1', name: 'a.png', mime: 'image/png', sizeBytes: 1};
      const withFile = echo({body: '', attachments: [file]});
      const items = [item(message(1)), item(message(2)), item(mine(3, {body: ''}))];
      // 확정본에 첨부가 없으면 짝이 아니다.
      expect(holdSettledArrivals(items, [arrival(withFile)])).toBe(items);
      const matched = [item(message(1)), item(message(2)), item(mine(3, {body: '', attachments: [file]}))];
      expect(holdSettledArrivals(matched, [arrival(withFile)])[2].key).toBe('p-c-1');
    });
  });

  // -----------------------------------------------------------------------------
  // 장부: 보류는 시간으로만 끝난다
  // -----------------------------------------------------------------------------
  describe('holdArrival — 장부의 시계와 구독', () => {
    it('SEND_ARRIVE_MS + 여유 동안만 적혀 있고, 그 뒤에는 저절로 풀린다', () => {
      expect(arrivalsInFlight()).toHaveLength(0);
      holdArrival(echo(), true, NOW);
      expect(arrivalsInFlight()).toHaveLength(1);
      expect(arrivalsInFlight()[0].untilMs).toBe(NOW + SEND_ARRIVE_MS + SEND_ARRIVE_HOLD_SLACK_MS);
      act(() => {
        jest.advanceTimersByTime(SEND_ARRIVE_MS + SEND_ARRIVE_HOLD_SLACK_MS - 1);
      });
      expect(arrivalsInFlight()).toHaveLength(1);
      act(() => {
        jest.advanceTimersByTime(1);
      });
      expect(arrivalsInFlight()).toHaveLength(0);
    });

    it('여유는 한 프레임(≈17ms)보다 길다 — 네이티브 구동이 마운트보다 늦게 시작하고 마지막 프레임이 걸린다', () => {
      expect(SEND_ARRIVE_HOLD_SLACK_MS).toBeGreaterThanOrEqual(17);
    });

    it('바뀔 때만 새 참조다 — 구독자는 적을 때와 풀릴 때 한 번씩 불린다', () => {
      const listener = jest.fn();
      const off = subscribeArrivals(listener);
      const before = arrivalsInFlight();
      expect(arrivalsInFlight()).toBe(before);
      holdArrival(echo(), true, NOW);
      expect(listener).toHaveBeenCalledTimes(1);
      const during = arrivalsInFlight();
      expect(during).not.toBe(before);
      expect(arrivalsInFlight()).toBe(during);
      act(() => {
        jest.advanceTimersByTime(SEND_ARRIVE_MS + SEND_ARRIVE_HOLD_SLACK_MS);
      });
      expect(listener).toHaveBeenCalledTimes(2);
      off();
      holdArrival(echo({clientMsgId: 'c-9'}), true, NOW);
      expect(listener).toHaveBeenCalledTimes(2);
    });

    it('같은 메아리를 다시 적으면 시계가 새로 시작한다(타이머가 둘 쌓이지 않는다)', () => {
      holdArrival(echo(), true, NOW);
      act(() => {
        jest.advanceTimersByTime(200);
      });
      holdArrival(echo(), true, NOW + 200);
      expect(jest.getTimerCount()).toBe(1);
      act(() => {
        jest.advanceTimersByTime(SEND_ARRIVE_MS + SEND_ARRIVE_HOLD_SLACK_MS - 1);
      });
      expect(arrivalsInFlight()).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------------
  // PendingRow: 오름이 도는 행만 적는다
  // -----------------------------------------------------------------------------
  describe('PendingRow — 장부에 적는 조건', () => {
    const row = (pending: PendingMessage) => (
      <FixedScheme scheme="dark">
        <PendingRow pending={pending} startsGroup directory={DIRECTORY} />
      </FixedScheme>
    );

    it('등장이 도는 행은 마운트 때 적고, 그 사본의 머리 행 여부를 함께 든다', () => {
      spyTiming();
      render(row(echo()));
      expect(arrivalsInFlight()).toHaveLength(1);
      expect(arrivalsInFlight()[0]).toMatchObject({startsGroup: true, pending: {clientMsgId: 'c-1'}});
    });

    it.each([
      ['동작 줄이기', () => ({reduce: true, pending: echo()})],
      ['자격 창 밖(보낸 지 1초 넘음)', () => ({reduce: false, pending: echo({createdAtMs: NOW - 5_000})})],
      ['이미 실패한 행', () => ({reduce: false, pending: echo({status: 'failed'})})],
    ] as const)('%s: 움직이지 않으니 적지 않는다(적으면 확정본이 괜히 가려진다)', (_name, make) => {
      spyTiming();
      const {reduce, pending} = make();
      render(
        <ReduceMotionRefContext.Provider value={{current: reduce}}>
          {row(pending)}
        </ReduceMotionRefContext.Provider>,
      );
      expect(arrivalsInFlight()).toHaveLength(0);
    });

    it('이미 올라온 적이 있는 메아리(가상화 재마운트)는 다시 적지 않는다', () => {
      spyTiming();
      markArrived('c-1');
      render(row(echo()));
      expect(arrivalsInFlight()).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------------
  // Timeline: 같은 인스턴스가 이어진다
  // -----------------------------------------------------------------------------
  describe('Timeline — 확정본이 등장 도중에 와도 오름이 끊기지 않는다', () => {
    const history = [message(1), message(2)];
    const tl = (messages: Message[], pending: PendingMessage[]) => (
      <Timeline
        messages={messages}
        directory={DIRECTORY}
        status="ready"
        myMemberId={SELF}
        nowMs={NOW + 60_000}
        pending={pending}
      />
    );
    /** 보이는 확정본 행(남의 글 2개 + 확정된 내 글) 개수. */
    const confirmedRows = () => screen.queryAllByTestId('message-press').length;
    const echoRows = () => screen.queryAllByTestId('pending-row').length;

    it.each([
      ['POST 응답 경로 — 확정본과 pending 제거가 한 렌더', 30],
      ['등장 중간', 150],
      ['등장 끝 무렵', 280],
    ] as const)('%s (%dms): 확정본이 와도 메아리가 그 자리에 있고 오름은 한 번만 돈다', (_name, arrivesAt) => {
      const timing = spyTiming();
      const view = render(tl(history, [echo()]));
      expect(echoRows()).toBe(1);
      expect(confirmedRows()).toBe(2);
      expect(timing).toHaveBeenCalledTimes(1);

      act(() => {
        jest.advanceTimersByTime(arrivesAt);
      });
      // 확정본이 들어오고 훅의 pending 도 같은 틱에 비었다(`useTimeline.post`).
      view.rerender(tl([...history, mine(3)], []));
      expect(echoRows()).toBe(1);
      expect(confirmedRows()).toBe(2);
      expect(screen.getByText('내일 오전에 봐요')).toBeTruthy();
      // 같은 인스턴스다 — 등장을 다시 시작하지 않았다.
      expect(timing).toHaveBeenCalledTimes(1);
      expect(screen.queryAllByText('내일 오전에 봐요')).toHaveLength(1);

      // 보류가 끝나는 순간 서버 사본이 선다.
      act(() => {
        jest.advanceTimersByTime(SEND_ARRIVE_MS + SEND_ARRIVE_HOLD_SLACK_MS - arrivesAt);
      });
      expect(echoRows()).toBe(0);
      expect(confirmedRows()).toBe(3);
      expect(screen.queryAllByText('내일 오전에 봐요')).toHaveLength(1);
      expect(timing).toHaveBeenCalledTimes(1);
    });

    it('확정본이 오기 전에 보류 시간이 지났으면 평소처럼 바로 바뀐다(되돌려 세울 것이 없다)', () => {
      spyTiming();
      const view = render(tl(history, [echo()]));
      act(() => {
        jest.advanceTimersByTime(SEND_ARRIVE_MS + SEND_ARRIVE_HOLD_SLACK_MS + 40);
      });
      view.rerender(tl([...history, mine(3)], []));
      expect(echoRows()).toBe(0);
      expect(confirmedRows()).toBe(3);
    });

    it('등장이 안 도는 행(이미 올라온 적이 있음)은 확정본이 오면 바로 바뀐다', () => {
      spyTiming();
      markArrived('c-1');
      const view = render(tl(history, [echo()]));
      view.rerender(tl([...history, mine(3)], []));
      expect(echoRows()).toBe(0);
      expect(confirmedRows()).toBe(3);
    });

    it('보류 중에 상대 메시지가 더 와도 내 글의 자리(seq 순서)는 그대로다', () => {
      spyTiming();
      const view = render(tl(history, [echo()]));
      act(() => {
        jest.advanceTimersByTime(100);
      });
      view.rerender(tl([...history, mine(3), message(4)], []));
      const keys = screen
        .getByTestId('timeline-list')
        .props.data.map((entry: {key: string}) => entry.key);
      // m-3 자리에 같은 키의 메아리, 뒤에 상대의 m-4.
      expect(keys.slice(-2)).toEqual(['p-c-1', 'm-4']);
    });
  });

  // -----------------------------------------------------------------------------
  // M2 · M3 · L2 — 같은 리뷰의 나머지를 관계로
  // -----------------------------------------------------------------------------
  describe('느린 전송 시계 — 줄바꿈 방지(M2)·글자 배율(M3)', () => {
    const slowEcho = (startsGroup: boolean) =>
      render(
        <FixedScheme scheme="dark">
          <PendingRow
            pending={echo({createdAtMs: NOW - SEND_SLOW_MS})}
            startsGroup={startsGroup}
            directory={DIRECTORY}
          />
        </FixedScheme>,
      );

    /** 요소에서 위로 올라가며 `match` 를 만족하는 첫 조상(자기 포함)의 펼친 스타일. */
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

    it('M2: 시계 상자의 줄 안 몫(폭 + 마진 + 앞 간격)이 0 이라 혼자 줄바꿈되지 않는다', () => {
      slowEcho(true);
      const host = ancestorStyle(
        screen.getByTestId('pending-slow') as never,
        style => style.width === 0 && style.height === 0,
      );
      expect(host).not.toBeNull();
      // Yoga(`FlexLine.cpp`): 줄에 넣을지는 `쓴 폭 + 항목 폭 + 항목 마진 + 앞 간격 > 줄 폭` 이다.
      expect((host as {width: number}).width + (host as {marginLeft: number}).marginLeft + CONV.whoGap).toBe(0);
    });

    it('M2: 시계가 서는 자리(시각 오른쪽 끝에서 whoGap)는 그대로다 — 마진이 당긴 만큼 시계가 띄워 선다', () => {
      slowEcho(true);
      const host = ancestorStyle(
        screen.getByTestId('pending-slow') as never,
        style => style.width === 0 && style.height === 0,
      ) as {marginLeft: number};
      const clock = flat(screen.getByTestId('pending-slow').props.style);
      // 시각 끝 → (앞 간격 whoGap + 음수 마진) → 상자 → 시계 left.
      expect(CONV.whoGap + host.marginLeft + clock.left).toBe(CONV.whoGap);
    });

    it('M3: 이어지는 행 시계의 높이는 글자 배율을 곱한 첫 줄 가운데다', () => {
      // 배율이 2 면 첫 줄 중심은 line.body / 2 만큼 더 아래다.
      expect(slowMarkGutterTop(2) - slowMarkGutterTop(1)).toBeCloseTo(line.body / 2, 5);
      // 시계의 중심 = 말풍선 안쪽 위 여백 + 첫 줄의 가운데(+ 행 위 여백).
      for (const scale of [1, 1.35, 2]) {
        const center = slowMarkGutterTop(scale) + CONV_ICON_SIZE.clock / 2;
        const firstLineCenter = 3 + CONV.bubblePadY + (line.body * scale) / 2;
        expect(center).toBeCloseTo(firstLineCenter, 5);
      }
    });

    it('M3: 화면의 글자 배율(useWindowDimensions)이 실제 행에 반영된다', () => {
      slowEcho(false);
      const mark = screen.getByTestId('pending-slow');
      const gutter = ancestorStyle(
        mark.parent as never,
        style => style.position === 'absolute' && style.width !== undefined,
      ) as {top: number};
      expect(gutter.top).toBeCloseTo(slowMarkGutterTop(Dimensions.get('window').fontScale), 5);
    });
  });

  describe('곡선 — 제어점을 고정한다(L2)', () => {
    /** Flutter `Curves.easeOutCubic` = `Cubic(0.215, 0.61, 0.355, 1.0)` 를 따로 푼 기준값. */
    function cubicBezier(x1: number, y1: number, x2: number, y2: number, x: number): number {
      const at = (a: number, b: number, s: number) =>
        3 * (1 - s) ** 2 * s * a + 3 * (1 - s) * s ** 2 * b + s ** 3;
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 50; i += 1) {
        const mid = (lo + hi) / 2;
        if (at(x1, x2, mid) < x) lo = mid;
        else hi = mid;
      }
      return at(y1, y2, (lo + hi) / 2);
    }

    it.each([0.1, 0.25, 0.5, 0.75, 0.9])('x=%s 에서 Buzz easeOutCubic 과 같다', x => {
      expect(SEND_ARRIVE_EASE(x)).toBeCloseTo(cubicBezier(0.215, 0.61, 0.355, 1, x), 2);
      // 기준값이 곡선 밖(예: 선형)으로 흘러가지 않았다는 짝 단정.
      expect(cubicBezier(0.215, 0.61, 0.355, 1, x)).toBeGreaterThan(x);
    });
  });
});

// =============================================================================
// 합친 시험: 원래 sendArrivalStandby4455.test.tsx (#4455)
// =============================================================================
describe('sendArrivalStandby (#4455)', () => {
  // =============================================================================
  // #4455 design-review r3 H3 — 사진은 서버 사본을 눈에 안 보이는 채 먼저 마운트해 두고 메아리를 잠깐 더 남긴다.
  //
  // 서버 사본은 새 마운트라 사진 타일의 `<Image>` 도 새로 서고, 새 네이티브 이미지 뷰는 첫 프레임에 안 그려져 타일이 한 프레임
  // (8~23ms) 빈 면으로 번쩍였다(레이아웃 지표 0 — 칠만 빈다). JS 에서 첫 페인트를 앞당길 길이 없으니 **새 뷰가 보이기 전에 미리
  // 마운트해 그려 둔다**: 메아리는 확정본의 자리에 그대로(같은 키·인덱스·인스턴스) `ECHO_LINGER_MS` 더 남고, 확정본은 **스트림 맨 끝**에
  // 대기 상태(`standby`: 높이 0 · 투명 · 눌림·낭독 없음)로 서 있다가, 창이 끝나는 한 커밋에 메아리가 걷히며 제 자리로 드러난다(꼬리 행이
  // 재마운트되지 않는 것은 같은 파일의 `sendArrivalStandbyTail` 묶음). 여기서 재는 것:
  //   1. 순수 함수(사진 판정·짝 짓기·끼워 넣는 자리·확정본 없는 것은 버림·참조 보존)
  //   2. `MessageRow` 의 대기 모드(레이아웃 0·투명·눌림/낭독 없음·위 여백 없음, 보통 행은 그대로, 인스턴스가 드러남으로 이어짐)
  //   3. `Timeline`: 보류가 풀리는 **그 커밋에** 메아리가 남고 서버 사본이 대기로 선다(보류 경로·보류 없는 경로·느린 확정),
  //      메아리 인스턴스는 새 마운트가 아니며, 창이 끝나면 걷히고, 글자·파일 행에는 없다
  // jest 는 레이아웃이 없어서 `VirtualizedList` 가 늘어난 꼬리의 셀을 그리지 않는다 — 목록 **데이터**(키·`standby` 표지)와 원래
  // 있던 메아리 셀을 단정하고, 대기 행의 모양은 2 에서 따로 잰다.
  // =============================================================================

  const DIRECTORY = makeDirectory([
    member({id: SELF, displayName: '박서연', handle: 'seoyeon'}),
    member({id: OTHER, displayName: '이도현', handle: 'dohyeon'}),
  ]);

  const photo = (id: string, over: Partial<MessageAttachment> = {}): MessageAttachment => ({
    id,
    name: `${id}.png`,
    mime: 'image/png',
    sizeBytes: 4096,
    ...over,
  });
  const FILE_CARD: MessageAttachment = {id: 'file-1', name: '배포-결과.pdf', mime: 'application/pdf', sizeBytes: 2048};

  function echo(over: Partial<PendingMessage> = {}): PendingMessage {
    return {
      clientMsgId: 'c-1',
      channelId: 'ch',
      authorMemberId: SELF,
      body: '',
      createdAtMs: NOW,
      sinceSeq: 2,
      status: 'sending',
      attachments: [photo('photo-a')],
      ...over,
    };
  }

  /** 내가 보낸 사진의 확정본. */
  const mine = (seq: number, over: Partial<Message> = {}): Message =>
    message(seq, {authorMemberId: SELF, body: '', createdAtMs: NOW + 100, attachments: [photo('photo-a')], ...over});

  const echoItem = (pending: PendingMessage, startsGroup = true): Extract<TimelineItem, {kind: 'pending'}> => ({
    kind: 'pending',
    key: `p-${pending.clientMsgId}`,
    pending,
    startsGroup,
  });

  /** 미리보기 칸(`attachment-preview`)의 **인스턴스**를 모은다 — 같은 인스턴스가 이어지는지(새 마운트가 아닌지) 본다. */
  function trackTiles() {
    const instances = new Set<unknown>();
    const original = View.prototype.render;
    jest.spyOn(View.prototype, 'render').mockImplementation(function (this: {props: {testID?: string}}) {
      if (this.props.testID === 'attachment-preview') instances.add(this);
      return original.call(this);
    } as never);
    return instances;
  }

  /** 미리보기를 받아 오는 비동기(첨부 내려받기)가 act 밖에서 상태를 건드려 경고가 나지 않게 act 안에서 비운다. */
  const settle = () =>
    act(async () => {
      for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
    });

  let consoleErrors: string[] = [];

  beforeEach(() => {
    fileSystem.__reset();
    resetAttachmentContentForTest();
    resetArrivedForTest();
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    consoleErrors = [];
    jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(' '));
    });
  });
  afterEach(async () => {
    await drainRender();
    await settle();
    cleanup();
    jest.useRealTimers();
    jest.restoreAllMocks();
    resetArrivedForTest();
    expect(consoleErrors).toEqual([]);
  });

  // -----------------------------------------------------------------------------
  // 1. 순수 함수
  // -----------------------------------------------------------------------------
  describe('사진 메아리를 남기는 순수 함수', () => {
    it('사진 판정: 인라인 사진이 하나라도 있어야 한다 — 글자·파일 카드·SVG·첨부 없음은 아니다', () => {
      expect(carriesInlinePhoto(echo())).toBe(true);
      expect(carriesInlinePhoto(echo({body: '설명', attachments: [FILE_CARD, photo('p2')]}))).toBe(true);
      expect(carriesInlinePhoto(echo({attachments: [FILE_CARD]}))).toBe(false);
      expect(carriesInlinePhoto(echo({attachments: []}))).toBe(false);
      expect(carriesInlinePhoto(echo({body: '글자만', attachments: undefined}))).toBe(false);
      expect(carriesInlinePhoto(echo({attachments: [photo('svg', {mime: 'image/svg+xml'})]}))).toBe(false);
    });

    it('photoEchoesOf: 서 있는 사진 메아리만 모은다 — 글자 메아리·확정본은 뺀다', () => {
      const photoEcho = echoItem(echo({clientMsgId: 'c-photo'}));
      const textEcho = echoItem(echo({clientMsgId: 'c-text', body: '글자', attachments: undefined}));
      expect(photoEchoesOf([item(message(1)), photoEcho, textEcho])).toEqual([photoEcho]);
      expect(isStandbyItem({...item(message(1)), standby: true})).toBe(true);
      expect(isStandbyItem(item(message(1)))).toBe(false);
      expect(isStandbyItem(null)).toBe(false);
    });

    it('photoEchoesOf: 실패한 사진 메아리는 모으지 않는다 — 서버 사본과 모양이 달라 겹쳐 둘 이유가 없다(r4 L15)', () => {
      const failed = echoItem(echo({clientMsgId: 'c-failed', status: 'failed'}));
      const sending = echoItem(echo({clientMsgId: 'c-sending'}));
      expect(photoEchoesOf([failed, sending])).toEqual([sending]);
    });

    it('sameEchoes: 키와 보낸 사본의 동일성으로 같은 목록을 가린다', () => {
      const a = echoItem(echo({clientMsgId: 'c-1'}));
      const b = echoItem(echo({clientMsgId: 'c-2'}));
      expect(sameEchoes([a], [a])).toBe(true);
      expect(sameEchoes([a], [{...a}])).toBe(true);
      expect(sameEchoes([a], [b])).toBe(false);
      expect(sameEchoes([a], [a, b])).toBe(false);
      expect(sameEchoes([], [])).toBe(true);
      expect(sameEchoes([a], [{...a, pending: {...a.pending}}])).toBe(false);
    });

    it('settledEchoes: 확정본이 이미 서 있는 것만 — 확정본 없이 사라진 것(방을 옮김)은 남기지 않는다', () => {
      const settled = echoItem(echo({clientMsgId: 'c-1'}));
      const orphan = echoItem(echo({clientMsgId: 'c-2', attachments: [photo('photo-b')]}));
      const items = [item(message(1)), item(message(2)), item(mine(3))];
      expect(settledEchoes([settled, orphan], items)).toEqual([settled]);
      expect(settledEchoes([orphan], items)).toEqual([]);
    });

    it('settledEchoes: 다른 채널의 같은 글은 짝이 아니다 — 확정본의 채널이 메아리의 채널과 같아야 한다', () => {
      const lingering = echoItem(echo({clientMsgId: 'c-1'}));
      const otherChannel = [item(message(1)), item(message(2)), item(mine(3, {channelId: 'other-channel'}))];
      expect(settledEchoes([lingering], otherChannel)).toEqual([]);
      expect(swapLingeringEchoes(otherChannel, [lingering]).items).toBe(otherChannel);
    });

    it('settledEchoes: 확정본 하나는 메아리 하나만 짝짓는다 — 같은 사진 두 장은 보낸 순서대로 하나씩', () => {
      const first = echoItem(echo({clientMsgId: 'c-1'}));
      const second = echoItem(echo({clientMsgId: 'c-2', createdAtMs: NOW + 50}));
      const one = [item(message(1)), item(message(2)), item(mine(3))];
      expect(settledEchoes([first, second], one)).toEqual([first]);
      expect(settledEchoes([first, second], [...one, item(mine(4), false)])).toEqual([first, second]);
    });

    it('swapLingeringEchoes: 메아리를 확정본의 자리에 **그대로** 놓고 확정본은 standby 로 따로 돌려준다 — 어떤 행의 인덱스도 안 바뀐다', () => {
      const lingering = echoItem(echo({clientMsgId: 'c-1'}));
      const items = [item(message(1)), item(message(2)), item(mine(3)), item(message(4))];
      const split = swapLingeringEchoes(items, [lingering]);
      // 길이가 같고(뒤 행이 안 밀린다) 메아리가 확정본의 자리에 서 있다.
      expect(split.items).toHaveLength(items.length);
      expect(split.items.map(entry => entry.key)).toEqual(['m-1', 'm-2', 'p-c-1', 'm-4']);
      // 메아리 항목은 받은 그대로다(같은 객체 — 같은 키·같은 모양이라 인스턴스가 이어진다).
      expect(split.items[2]).toBe(lingering);
      // 뒤 행은 같은 항목이다.
      expect(split.items[3]).toBe(items[3]);
      // 확정본은 standby 표지만 더한 사본으로 따로 나온다 — 호출자가 맨 끝에 붙인다.
      expect(split.standby).toHaveLength(1);
      expect(split.standby[0].key).toBe('m-3');
      expect(isStandbyItem(split.standby[0])).toBe(true);
      // 원본 배열과 확정본 항목은 건드리지 않는다.
      expect(items.map(entry => entry.key)).toEqual(['m-1', 'm-2', 'm-3', 'm-4']);
      expect(isStandbyItem(items[2])).toBe(false);
    });

    it('swapLingeringEchoes: 바꿀 것이 없으면 받은 배열 그대로(참조) — 남길 메아리 없음·확정본을 못 찾음', () => {
      const items = [item(message(1)), item(message(2))];
      expect(swapLingeringEchoes(items, []).items).toBe(items);
      expect(swapLingeringEchoes(items, []).standby).toHaveLength(0);
      const lost = swapLingeringEchoes(items, [echoItem(echo({clientMsgId: 'c-lost'}))]);
      expect(lost.items).toBe(items);
      expect(lost.standby).toHaveLength(0);
    });

    it('swapLingeringEchoes: 사진 둘이면 메아리도 각자 자기 확정본의 자리에, 대기 사본은 보낸 순서대로', () => {
      const first = echoItem(echo({clientMsgId: 'c-1', attachments: [photo('photo-a')]}));
      const second = echoItem(echo({clientMsgId: 'c-2', attachments: [photo('photo-b')], createdAtMs: NOW + 40}));
      const items = [
        item(message(1)),
        item(mine(3, {attachments: [photo('photo-a')]})),
        item(message(4)),
        item(mine(5, {attachments: [photo('photo-b')]})),
      ];
      const split = swapLingeringEchoes(items, [first, second]);
      expect(split.items.map(entry => entry.key)).toEqual(['m-1', 'p-c-1', 'm-4', 'p-c-2']);
      expect(split.standby.map(entry => entry.key)).toEqual(['m-3', 'm-5']);
    });
  });

  // -----------------------------------------------------------------------------
  // 2. MessageRow 의 대기 모드
  // -----------------------------------------------------------------------------
  describe('MessageRow — 대기 모드', () => {
    const actions: MessageRowActions = {
      myMemberId: SELF,
      onToggleReaction: async () => {},
      onEdit: async () => {},
      onDelete: async () => {},
    };
    const row = (standby: boolean | undefined, startsGroup = true) => (
      <FixedScheme scheme="dark">
        <MessageRow
          message={mine(3)}
          startsGroup={startsGroup}
          directory={DIRECTORY}
          chips={[]}
          nowMs={NOW + 60_000}
          actions={actions}
          standby={standby}
        />
      </FixedScheme>
    );

    it('보통 행은 그대로다 — 대기 표지·눌림 차단·낭독 숨김이 없고 머리 행의 위 여백을 진다', async () => {
      render(row(undefined));
      const root = screen.getByTestId('message-row');
      expect(root.props.pointerEvents).toBeUndefined();
      expect(root.props.accessibilityElementsHidden).toBeUndefined();
      expect(root.props.importantForAccessibility).toBeUndefined();
      expect(screen.queryByTestId('message-row-standby')).toBeNull();
      const style = flat(root.props.style);
      expect(style.height).toBeUndefined();
      expect(style.opacity).toBeUndefined();
      expect(style.marginTop).toBeGreaterThan(0);
      await settle();
    });

    it('대기 행: 높이 0 · 투명 · 위 여백 없음 · 눌림과 낭독을 받지 않는다', async () => {
      render(row(true));
      // 낭독에서 숨긴 요소라 조회가 기본으로 건너뛴다.
      const root = screen.getByTestId('message-row-standby', {includeHiddenElements: true});
      const style = flat(root.props.style);
      expect(style.height).toBe(0);
      expect(style.opacity).toBe(0);
      expect(style.marginTop).toBeUndefined();
      expect(root.props.pointerEvents).toBe('none');
      expect(root.props.accessibilityElementsHidden).toBe(true);
      expect(root.props.importantForAccessibility).toBe('no-hide-descendants');
      expect(screen.queryByTestId('message-row')).toBeNull();
      await settle();
    });

    it('대기에서 드러남으로 바뀌어도 같은 인스턴스다 — 사진 타일의 이미지 뷰가 새로 서지 않는다', async () => {
      const tiles = trackTiles();
      const view = render(row(true));
      expect(tiles.size).toBe(1);
      view.rerender(row(undefined));
      expect(screen.getByTestId('message-row')).toBeTruthy();
      expect(flat(screen.getByTestId('message-row').props.style).height).toBeUndefined();
      // 인스턴스가 하나 더 생겼다면 드러나는 순간 이미지 뷰가 새로 서서 빈 프레임이 다시 생기는 것이다.
      expect(tiles.size).toBe(1);
      await settle();
    });
  });

  // -----------------------------------------------------------------------------
  // 3. Timeline
  // -----------------------------------------------------------------------------
  describe('Timeline — 서버 사본이 서는 커밋에 메아리가 남고 서버 사본은 대기한다', () => {
    const history = [message(1), message(2)];
    const tl = (messages: Message[], pending: PendingMessage[]) => (
      <Timeline
        messages={messages}
        directory={DIRECTORY}
        status="ready"
        myMemberId={SELF}
        nowMs={NOW + 60_000}
        pending={pending}
      />
    );
    /** 목록 데이터 중 메시지(`m-`)·메아리(`p-`)만 — 날짜 구분선은 거른다. `*` 는 대기 중인 서버 사본. */
    const keys = () =>
      (screen.getByTestId('timeline-list').props.data as Array<{key: string; standby?: boolean}>)
        .filter(entry => /^[mp]-/.test(entry.key))
        .map(entry => (entry.standby ? `${entry.key}*` : entry.key));
    const echoes = () => screen.queryAllByTestId('pending-row').length;
    /** 그려진 대기 서버 사본(낭독에서 숨긴 요소라 조회가 기본으로 건너뛴다). */
    const standbyRows = () => screen.queryAllByTestId('message-row-standby', {includeHiddenElements: true}).length;

    it.each([
      ['POST 응답 경로(확정본과 pending 제거가 한 렌더)', 30],
      ['등장 중간', 150],
    ] as const)('보류 경로 — %s (%dms): 보류가 풀리는 커밋에 메아리가 남고 서버 사본이 대기로 서며, 창이 끝나면 걷힌다', async (_name, arrivesAt) => {
      spyTiming();
      const tiles = trackTiles();
      const view = render(tl(history, [echo()]));
      expect(echoes()).toBe(1);
      expect(tiles.size).toBe(1);

      act(() => {
        jest.advanceTimersByTime(arrivesAt);
      });
      view.rerender(tl([...history, mine(3)], []));
      // 보류: 확정본 자리에 메아리가 그대로 있다.
      expect(echoes()).toBe(1);
      expect(keys()).toEqual(['m-1', 'm-2', 'p-c-1']);

      // 보류가 풀리는 **같은 커밋**에 서버 사본이 대기로 서고, 메아리는 그 항목 그대로 남는다.
      act(() => {
        jest.advanceTimersByTime(HOLD_MS - arrivesAt);
      });
      expect(keys()).toEqual(['m-1', 'm-2', 'p-c-1', 'm-3*']);
      expect(echoes()).toBe(1);
      // 서버 사본은 **그려져 있다** — 눈에 안 보이는 대기 행으로(높이 0·투명).
      expect(standbyRows()).toBe(1);
      // 사진 타일 인스턴스는 둘 — 이어 온 메아리의 것(1)과 미리 마운트된 대기 서버 사본의 것(2). 메아리가 새 마운트였다면 3 이다.
      expect(tiles.size).toBe(2);

      act(() => {
        jest.advanceTimersByTime(ECHO_LINGER_MS);
      });
      expect(keys()).toEqual(['m-1', 'm-2', 'm-3']);
      expect(echoes()).toBe(0);
      // 창이 끝나면 대기하던 행이 드러난다 — 새로 서지 않고 그 인스턴스가 이어진다(이미지가 이미 그려져 있다).
      expect(standbyRows()).toBe(0);
      expect(screen.getAllByTestId('message-row')).toHaveLength(3);
      expect(tiles.size).toBe(2);
      await settle();
    });

    it('보류가 없는 경로 — 등장이 없는 메아리(동작 줄이기·가상화 재마운트)는 확정본이 오는 커밋에 메아리가 남고 서버 사본이 대기로 선다', async () => {
      spyTiming();
      const tiles = trackTiles();
      // 이미 올라온 적이 있는 메아리는 등장도 보류 장부도 없다(`PendingRow` — 동작 줄이기와 같은 모양).
      markArrived('c-1');
      const view = render(tl(history, [echo()]));
      expect(echoes()).toBe(1);
      view.rerender(tl([...history, mine(3)], []));
      expect(keys()).toEqual(['m-1', 'm-2', 'p-c-1', 'm-3*']);
      expect(echoes()).toBe(1);
      expect(tiles.size).toBe(2);
      act(() => {
        jest.advanceTimersByTime(ECHO_LINGER_MS);
      });
      expect(keys()).toEqual(['m-1', 'm-2', 'm-3']);
      expect(tiles.size).toBe(2);
      await settle();
    });

    it('확정이 보류보다 늦은 느린 전송 — 확정본이 오는 커밋에 메아리가 남고 서버 사본이 대기로 선다', async () => {
      spyTiming();
      const view = render(tl(history, [echo()]));
      act(() => {
        jest.advanceTimersByTime(HOLD_MS + 600);
      });
      expect(keys()).toEqual(['m-1', 'm-2', 'p-c-1']);
      view.rerender(tl([...history, mine(3)], []));
      expect(keys()).toEqual(['m-1', 'm-2', 'p-c-1', 'm-3*']);
      expect(echoes()).toBe(1);
      await settle();
    });

    it('글자 행에는 대기가 없다 — 사진을 안 단 메아리·파일 카드만 단 메아리', async () => {
      spyTiming();
      for (const [pending, confirmed] of [
        [echo({body: '글자만', attachments: undefined}), mine(3, {body: '글자만', attachments: undefined})],
        [echo({attachments: [FILE_CARD]}), mine(3, {attachments: [FILE_CARD]})],
      ] as const) {
        resetArrivedForTest();
        const view = render(tl(history, [pending]));
        act(() => {
          jest.advanceTimersByTime(100);
        });
        view.rerender(tl([...history, confirmed], []));
        act(() => {
          jest.advanceTimersByTime(HOLD_MS);
        });
        expect(keys()).toEqual(['m-1', 'm-2', 'm-3']);
        await settle();
        view.unmount();
      }
    });

    it('이미 실패한 사진 메아리는 서버 사본이 와도 남기지 않는다 — 「전송 실패」 줄이 150ms 더 서 있지 않는다', async () => {
      spyTiming();
      const view = render(tl(history, [echo({status: 'failed'})]));
      view.rerender(tl([...history, mine(3)], []));
      expect(keys()).toEqual(['m-1', 'm-2', 'm-3']);
      expect(echoes()).toBe(0);
      await settle();
    });

    it('확정본 없이 사라진 사진 메아리(전송이 지워짐)는 남기지 않는다', async () => {
      spyTiming();
      markArrived('c-1');
      const view = render(tl(history, [echo()]));
      expect(echoes()).toBe(1);
      view.rerender(tl(history, []));
      expect(echoes()).toBe(0);
      expect(keys()).toEqual(['m-1', 'm-2']);
      await settle();
    });

    it('사진 둘을 잇달아 보내면 메아리도 각자 자기 확정본의 자리에 남고 대기 사본 둘은 맨 끝에 서며 함께 걷힌다', async () => {
      spyTiming();
      markArrived('c-1');
      markArrived('c-2');
      const two = [
        echo({clientMsgId: 'c-1', attachments: [photo('photo-a')]}),
        echo({clientMsgId: 'c-2', attachments: [photo('photo-b')], createdAtMs: NOW + 40}),
      ];
      const view = render(tl(history, two));
      expect(echoes()).toBe(2);
      view.rerender(
        tl(
          [...history, mine(3, {attachments: [photo('photo-a')]}), mine(4, {attachments: [photo('photo-b')]})],
          [],
        ),
      );
      expect(keys()).toEqual(['m-1', 'm-2', 'p-c-1', 'p-c-2', 'm-3*', 'm-4*']);
      act(() => {
        jest.advanceTimersByTime(ECHO_LINGER_MS);
      });
      expect(keys()).toEqual(['m-1', 'm-2', 'm-3', 'm-4']);
      await settle();
    });

    it('언마운트하면 창을 닫는 타이머를 걷는다 — setTimeout 이 돌려준 그 id 를 clearTimeout 이 받는다', async () => {
      spyTiming();
      markArrived('c-1');
      // 창을 여는 타이머(ECHO_LINGER_MS)의 id 를 붙잡는다.
      const lingerTimers: unknown[] = [];
      const realSetTimeout = global.setTimeout;
      jest.spyOn(global, 'setTimeout').mockImplementation(((handler: () => void, ms?: number, ...rest: unknown[]) => {
        const id = (realSetTimeout as (...args: unknown[]) => unknown)(handler, ms, ...rest);
        if (ms === ECHO_LINGER_MS) lingerTimers.push(id);
        return id;
      }) as never);
      const clearSpy = jest.spyOn(global, 'clearTimeout');
      const view = render(tl(history, [echo()]));
      view.rerender(tl([...history, mine(3)], []));
      expect(keys()).toEqual(['m-1', 'm-2', 'p-c-1', 'm-3*']);
      expect(lingerTimers).toHaveLength(1);
      view.unmount();
      // 언마운트가 그 타이머를 걷는다. 안 걷으면 닫힌 컴포넌트의 상태를 150ms 뒤 건드린다(React 19 는 그때 경고하지 않으니 호출로 본다).
      expect(clearSpy).toHaveBeenCalledWith(lingerTimers[0]);
      await settle();
    });
  });
});

// =============================================================================
// 합친 시험: 원래 sendArrivalStandbyTail4455.test.tsx (#4455)
// =============================================================================
describe('sendArrivalStandbyTail (#4455)', () => {
  // =============================================================================
  // #4455 design-review r4 H4 — 사진 뒤에 서 있는 행은 대기 서버 사본이 끼어도 새 인스턴스로 다시 서지 않는다.
  //
  // 대기 서버 사본(`standby`)을 메아리 바로 뒤에 끼우면 목록이 한 칸 늘면서 **그 뒤 행들의 인덱스가 한 칸씩 밀린다**. RN 0.86
  // `VirtualizedList` 는 항목이 늘어난 커밋에서 렌더 창의 끝을 그대로 두므로(`getDerivedStateFromProps`) 가장 뒤 행이 창 밖으로 나가
  // 언마운트됐다가 새 인스턴스로 다시 선다 — 사진 메아리를 「유령」으로 겹치려던 첫 설계를 버리게 한 바로 그 기전이 메아리 셀에서 꼬리
  // 셀(에이전트 「작업 중」 자리·뒤이어 보낸 메아리)로 옮겨 간다. 그래서 대기 서버 사본은 **스트림 맨 끝**에 두고 메아리는 확정본의 자리에
  // 남긴다 — 어떤 기존 행의 인덱스도 안 바뀐다.
  //
  // 이 파일은 **실제 `Timeline` 과 실제 RN `VirtualizedList` JS** 를 쓰고 레이아웃·스크롤 이벤트만 흉내 내서(렌더 창이 꼬리로 수렴하게)
  // 행 **인스턴스**를 센다. 인스턴스 수가 곧 재마운트다 — `View.prototype.render` 를 가로채 testID 별로 서로 다른 인스턴스를 모은다.
  // 다른 `Timeline` 시험은 사진이 마지막 항목인 데이터뿐이라 이 재마운트를 못 잡았다(design-review r4).
  // =============================================================================

  const AGENT = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
  const HIST = 14;
  const VIEWPORT = 700;
  const CELL = 70;

  const DIRECTORY = makeDirectory([
    member({id: SELF, displayName: '박서연', handle: 'seoyeon'}),
    member({id: OTHER, displayName: '이도현', handle: 'dohyeon'}),
    member({id: AGENT, kind: 'agent', displayName: 'hermes', handle: 'hermes'}),
  ]);

  const photo = (id: string): MessageAttachment => ({id, name: `${id}.png`, mime: 'image/png', sizeBytes: 4096});

  const history = Array.from({length: HIST}, (_, index) => message(index + 1));

  function echo(over: Partial<PendingMessage> = {}): PendingMessage {
    return {
      clientMsgId: 'c-1',
      channelId: 'ch',
      authorMemberId: SELF,
      body: '',
      createdAtMs: NOW,
      sinceSeq: HIST,
      status: 'sending',
      attachments: [photo('photo-a')],
      ...over,
    };
  }

  /** 내가 보낸 사진의 확정본. */
  const minePhoto = (seq: number, over: Partial<Message> = {}): Message =>
    message(seq, {authorMemberId: SELF, body: '', createdAtMs: NOW + 100, attachments: [photo('photo-a')], ...over});

  // ---- 인스턴스 수 ----------------------------------------------------------------------------------
  const TRACKED = (id: string) =>
    id.startsWith('working-row') ||
    id === 'pending-row' ||
    id === 'attachment-preview' ||
    id === 'message-row' ||
    id === 'message-row-standby';
  const seen: Record<string, Set<unknown>> = {};
  function trackInstances() {
    const original = View.prototype.render;
    jest.spyOn(View.prototype, 'render').mockImplementation(function (this: {props: {testID?: string}}) {
      const id = this.props.testID;
      if (typeof id === 'string' && TRACKED(id)) (seen[id] ??= new Set()).add(this);
      return original.call(this);
    } as never);
  }
  const instances = (id: string) => (seen[id] === undefined ? 0 : seen[id].size);

  // ---- 레이아웃 흉내 --------------------------------------------------------------------------------
  // 실제 `VirtualizedList` 는 셀이 `onLayout` 을 알려 와야 렌더 창을 꼬리로 수렴시킨다. 모든 셀이 같은 높이(CELL)를 갖고 목록이 꼬리에 붙어
  // 있다고 흉내 낸다. 높이 0 이어야 하는 대기 행도 CELL 로 흉내 내지만 인덱스 이동·창 거동에는 영향이 없다.
  const cellComposites = () =>
    screen.UNSAFE_root.findAll(
      (node: any) =>
        typeof node.type !== 'string' &&
        node.props &&
        node.props.cellKey !== undefined &&
        typeof node.props.index === 'number' &&
        typeof node.props.onLayout === 'function',
    );
  let tick = 0;
  function layoutPass() {
    const list = screen.getByTestId('timeline-list');
    const total = (list.props.data as unknown[]).length * CELL;
    act(() => {
      list.props.onLayout({nativeEvent: {layout: {x: 0, y: 0, width: 390, height: VIEWPORT}}});
      for (const cell of cellComposites()) {
        cell.props.onLayout({nativeEvent: {layout: {x: 0, y: cell.props.index * CELL, width: 390, height: CELL}}});
      }
      list.props.onContentSizeChange(390, total);
      tick += 16;
      list.props.onScroll({
        timeStamp: 1000 + tick,
        nativeEvent: {
          contentOffset: {x: 0, y: Math.max(0, total - VIEWPORT)},
          contentSize: {width: 390, height: total},
          layoutMeasurement: {width: 390, height: VIEWPORT},
          zoomScale: 1,
        },
      });
    });
  }
  function converge(passes = 10) {
    for (let pass = 0; pass < passes; pass += 1) {
      layoutPass();
      act(() => {
        jest.advanceTimersByTime(60);
      });
    }
  }
  const settle = () =>
    act(async () => {
      for (let tickCount = 0; tickCount < 20; tickCount += 1) await Promise.resolve();
    });

  /** 목록 데이터의 끝 몇 개(날짜 구분선은 거른다). `*` 는 대기 중인 서버 사본. */
  const keys = (take = 6) =>
    (screen.getByTestId('timeline-list').props.data as Array<{key: string; standby?: boolean}>)
      .filter(entry => /^[mpw]-/.test(entry.key))
      .map(entry => (entry.standby ? `${entry.key}*` : entry.key))
      .slice(-take);

  const tl = (messages: Message[], pending: PendingMessage[], working: Array<{memberId: string}> = []) => (
    <Timeline
      messages={messages}
      directory={DIRECTORY}
      status="ready"
      myMemberId={SELF}
      nowMs={NOW + 60_000}
      pending={pending}
      working={working}
    />
  );

  let consoleErrors: string[] = [];
  beforeEach(() => {
    fileSystem.__reset();
    resetAttachmentContentForTest();
    resetArrivedForTest();
    for (const key of Object.keys(seen)) delete seen[key];
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    tick = 0;
    jest
      .spyOn(Animated, 'timing')
      .mockImplementation(() => ({start: jest.fn(), stop: jest.fn(), reset: jest.fn()}) as never);
    consoleErrors = [];
    jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(' '));
    });
    trackInstances();
  });
  afterEach(async () => {
    await drainRender();
    await settle();
    cleanup();
    jest.useRealTimers();
    jest.restoreAllMocks();
    resetArrivedForTest();
    expect(consoleErrors).toEqual([]);
  });

  describe('사진 뒤에 서 있는 행은 대기 서버 사본이 끼어도 새 인스턴스로 다시 서지 않는다', () => {
    it('대조군 — 글 메아리 뒤의 「작업 중」 자리는 확정본이 와도 한 인스턴스다(대기 행이 안 생긴다)', async () => {
      markArrived('c-1');
      const text = echo({body: '글자만', attachments: undefined});
      const view = render(tl(history, [text], [{memberId: AGENT}]));
      converge();
      expect(instances(`working-row-${AGENT}`)).toBe(1);
      view.rerender(
        tl(
          [...history, message(HIST + 1, {authorMemberId: SELF, body: '글자만', createdAtMs: NOW + 100})],
          [],
          [{memberId: AGENT}],
        ),
      );
      converge(4);
      expect(instances(`working-row-${AGENT}`)).toBe(1);
      expect(instances('message-row-standby')).toBe(0);
      await settle();
    });

    it('사진 메아리 뒤에 「작업 중」 자리가 있어도 확정본이 오는 커밋·창이 끝나는 커밋에 그 자리는 한 인스턴스다', async () => {
      markArrived('c-1');
      const view = render(tl(history, [echo()], [{memberId: AGENT}]));
      converge();
      expect(instances(`working-row-${AGENT}`)).toBe(1);
      expect(instances('pending-row')).toBe(1);
      view.rerender(tl([...history, minePhoto(HIST + 1)], [], [{memberId: AGENT}]));
      // 확정본이 온 **바로 그 커밋**: 메아리는 확정본의 자리(`m-15` 의 자리)에 그대로 서고, 대기 서버 사본은 맨 끝이다.
      expect(keys(3)).toEqual([`p-c-1`, `w-${AGENT}`, 'm-15*']);
      converge(4);
      expect(instances(`working-row-${AGENT}`)).toBe(1);
      expect(instances('pending-row')).toBe(1);
      // 사진 타일은 둘이다 — 메아리의 것과 미리 마운트된 대기 서버 사본의 것.
      expect(instances('attachment-preview')).toBe(2);
      expect(instances('message-row-standby')).toBe(1);
      // 창이 끝나면 서버 사본이 자기 자리로 드러나고 메아리가 걷힌다 — 그래도 「작업 중」 자리는 그대로다.
      act(() => {
        jest.advanceTimersByTime(ECHO_LINGER_MS + 10);
      });
      converge(2);
      expect(keys(2)).toEqual(['m-15', `w-${AGENT}`]);
      expect(instances(`working-row-${AGENT}`)).toBe(1);
      expect(instances('attachment-preview')).toBe(2);
      await settle();
    });

    it('사진 메아리 뒤에 이어 보낸 글 메아리가 서 있어도 둘 다 새 인스턴스로 서지 않는다', async () => {
      markArrived('c-1');
      markArrived('c-2');
      const second = echo({clientMsgId: 'c-2', body: '이거 봐줘', attachments: undefined, createdAtMs: NOW + 30});
      const view = render(tl(history, [echo(), second]));
      converge();
      expect(instances('pending-row')).toBe(2);
      view.rerender(tl([...history, minePhoto(HIST + 1)], [second]));
      expect(keys(3)).toEqual(['p-c-1', 'p-c-2', 'm-15*']);
      converge(4);
      // 메아리 인스턴스는 둘이고(첫 사진 메아리 + 이어 보낸 글 메아리) 셋이 아니다.
      expect(instances('pending-row')).toBe(2);
      expect(instances('attachment-preview')).toBe(2);
      act(() => {
        jest.advanceTimersByTime(ECHO_LINGER_MS + 10);
      });
      converge(2);
      expect(keys(2)).toEqual(['m-15', 'p-c-2']);
      expect(instances('pending-row')).toBe(2);
      await settle();
    });

    it('사진 메아리 뒤에 상대 말이 이미 도착해 있어도 그 행은 새 인스턴스로 서지 않는다', async () => {
      markArrived('c-1');
      // 확정본(seq 15)이 아직 오기 전에 상대의 말이 먼저 도착했다 — 메아리는 맨 끝, 상대 말은 그 앞이다.
      const view = render(tl([...history, message(HIST + 1, {body: '상대 말'})], [echo({sinceSeq: HIST + 1})]));
      converge();
      const before = instances('message-row');
      view.rerender(
        tl([...history, message(HIST + 1, {body: '상대 말'}), minePhoto(HIST + 2)], []),
      );
      converge(4);
      // 상대 말 행의 인스턴스는 늘지 않는다(대기 서버 사본 하나만 새로 선다).
      expect(instances('message-row')).toBeLessThanOrEqual(before + 1);
      expect(instances('message-row-standby')).toBe(1);
      await settle();
    });

    it('혼자 서 있는 사진 메아리(캡처한 경우)는 그대로다 — 메아리 1 · 타일 2 · 대기 1, 드러난 뒤에도 타일 2', async () => {
      markArrived('c-1');
      const view = render(tl(history, [echo()]));
      converge();
      view.rerender(tl([...history, minePhoto(HIST + 1)], []));
      converge(4);
      expect(instances('pending-row')).toBe(1);
      expect(instances('attachment-preview')).toBe(2);
      expect(instances('message-row-standby')).toBe(1);
      act(() => {
        jest.advanceTimersByTime(ECHO_LINGER_MS + 10);
      });
      converge(2);
      expect(keys(1)).toEqual(['m-15']);
      expect(instances('attachment-preview')).toBe(2);
      await settle();
    });
  });
});

// =============================================================================
// 합친 시험: 원래 sendArrivalSurface4455.test.tsx (#4455)
// =============================================================================
describe('sendArrivalSurface (#4455)', () => {
  // =============================================================================
  // #4455 design-review r2 M4 — 보류는 메아리를 그린 표면에서만 읽는다.
  //
  // 보낸 메시지의 등장 보류(`sendArrival.ts`)는 모듈 전역 장부다. 스레드 답글의 메아리는 **스레드 목록에만** 서지만(코어
  // `useTimeline` 의 `channelPending` 이 채널 목록에서 거른다) 확정되면 채널 목록에도 평범한 행으로 선다. 보류가 표면을 가리지
  // 않으면 아래 깔린 채널 목록이 스레드에서 적힌 항목을 읽어, 확정된 답글을 약 360ms 동안 메아리로 한 번 더 그렸다(패널 뒤라
  // 안 보이지만 코어가 지킨다고 적은 불변식을 깨고, 패널을 360ms 안에 닫으면 채널 꼬리의 높이 변화가 보일 수 있다).
  //
  // 여기서 재는 것(바깥에서 안으로):
  //   1. 순수 함수 `holdSettledArrivals` 가 자기 표면의 항목만 읽는다(채널·스레드 루트 둘)
  //   2. 장부 `holdArrival` 이 표면을 적는다(기본: 채널 목록)
  //   3. `PendingRow` 가 받은 `arrivalSurface` 를 장부에 적는다
  //   4. `Timeline` 둘(채널·스레드 표면)을 함께 세워 스레드 답글이 확정될 때 채널 목록에 메아리가 마운트되지 않는다
  //   5. 진짜 `ThreadPanel` 이 자기 루트의 표면 이름을 `Timeline` 에 준다(배선)
  // =============================================================================

  const ROOT_ID = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';

  const DIRECTORY = makeDirectory([
    member({id: SELF, displayName: '박서연', handle: 'seoyeon'}),
    member({id: OTHER, displayName: '이도현', handle: 'dohyeon'}),
  ]);

  function echo(over: Partial<PendingMessage> = {}): PendingMessage {
    return {
      clientMsgId: 'c-1',
      channelId: 'ch',
      authorMemberId: SELF,
      body: '내일 오전에 봐요',
      createdAtMs: NOW,
      sinceSeq: 2,
      status: 'sending',
      ...over,
    };
  }

  /** 내가 보낸 글의 확정본. */
  const mine = (seq: number, over: Partial<Message> = {}): Message =>
    message(seq, {authorMemberId: SELF, body: '내일 오전에 봐요', createdAtMs: NOW + 100, ...over});

  beforeEach(() => {
    resetArrivedForTest();
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });
  afterEach(async () => {
    await drainRender();
    cleanup();
    jest.useRealTimers();
    jest.restoreAllMocks();
    resetArrivedForTest();
  });

  // -----------------------------------------------------------------------------
  // 1. 순수 함수
  // -----------------------------------------------------------------------------
  describe('holdSettledArrivals — 자기 표면의 항목만 읽는다', () => {
    const arrival = (pending: PendingMessage, surface: string) => ({
      pending,
      startsGroup: true,
      untilMs: NOW + HOLD_MS,
      surface,
    });
    const list = () => [item(message(1)), item(message(2)), item(mine(3))];

    it('표면 이름은 채널 목록과 스레드 루트마다 다르다', () => {
      expect(ARRIVAL_SURFACE_CHANNEL).toBe('channel');
      expect(threadArrivalSurface('root-A')).toBe('thread:root-A');
      expect(threadArrivalSurface('root-A')).not.toBe(threadArrivalSurface('root-B'));
      expect(threadArrivalSurface('root-A')).not.toBe(ARRIVAL_SURFACE_CHANNEL);
    });

    it('스레드에서 적힌 메아리를 채널 목록(기본 표면)은 읽지 않는다 — 받은 배열 그대로', () => {
      const items = list();
      expect(holdSettledArrivals(items, [arrival(echo(), threadArrivalSurface('root-A'))])).toBe(items);
      expect(
        holdSettledArrivals(items, [arrival(echo(), threadArrivalSurface('root-A'))], ARRIVAL_SURFACE_CHANNEL),
      ).toBe(items);
    });

    it('같은 스레드 표면은 읽는다 — 확정본 자리에 같은 키의 메아리', () => {
      const items = list();
      const out = holdSettledArrivals(
        items,
        [arrival(echo(), threadArrivalSurface('root-A'))],
        threadArrivalSurface('root-A'),
      );
      expect(out).not.toBe(items);
      expect(out.map(entry => entry.key)).toEqual(['m-1', 'm-2', 'p-c-1']);
    });

    it('다른 스레드 루트의 표면은 읽지 않는다', () => {
      const items = list();
      expect(
        holdSettledArrivals(items, [arrival(echo(), threadArrivalSurface('root-A'))], threadArrivalSurface('root-B')),
      ).toBe(items);
    });

    it('채널에서 적힌 메아리를 스레드 목록은 읽지 않는다', () => {
      const items = list();
      expect(
        holdSettledArrivals(items, [arrival(echo(), ARRIVAL_SURFACE_CHANNEL)], threadArrivalSurface('root-A')),
      ).toBe(items);
    });

    it('두 표면에 각자 적힌 항목이 섞여 있어도 각자 자기 것만 대신한다', () => {
      // 같은 글을 채널(c-1)과 스레드(c-2)에서 따로 보냈다 — 확정본이 둘이다.
      const channelEcho = echo({clientMsgId: 'c-1'});
      const threadEcho = echo({clientMsgId: 'c-2', createdAtMs: NOW + 50});
      const items = [item(message(1)), item(message(2)), item(mine(3)), item(mine(4), false)];
      const ledger = [arrival(channelEcho, ARRIVAL_SURFACE_CHANNEL), arrival(threadEcho, threadArrivalSurface('root-A'))];
      expect(holdSettledArrivals(items, ledger).map(entry => entry.key)).toEqual(['m-1', 'm-2', 'p-c-1', 'm-4']);
      expect(holdSettledArrivals(items, ledger, threadArrivalSurface('root-A')).map(entry => entry.key)).toEqual([
        'm-1',
        'm-2',
        'p-c-2',
        'm-4',
      ]);
    });
  });

  // -----------------------------------------------------------------------------
  // 2·3. 장부와 PendingRow
  // -----------------------------------------------------------------------------
  describe('장부는 그린 표면을 적는다', () => {
    it('holdArrival: 표면을 안 주면 채널 목록이고, 주면 그 표면이다', () => {
      holdArrival(echo({clientMsgId: 'c-1'}), true, NOW);
      holdArrival(echo({clientMsgId: 'c-2'}), true, NOW, threadArrivalSurface('root-A'));
      expect(arrivalsInFlight().map(entry => [entry.pending.clientMsgId, entry.surface])).toEqual([
        ['c-1', ARRIVAL_SURFACE_CHANNEL],
        ['c-2', 'thread:root-A'],
      ]);
    });

    it('PendingRow: 받은 arrivalSurface 를 장부에 적는다(안 받으면 채널 목록)', () => {
      spyTiming();
      render(
        <FixedScheme scheme="dark">
          <PendingRow
            pending={echo({clientMsgId: 'c-thread'})}
            startsGroup
            directory={DIRECTORY}
            arrivalSurface={threadArrivalSurface('root-A')}
          />
          <PendingRow pending={echo({clientMsgId: 'c-channel'})} startsGroup directory={DIRECTORY} />
        </FixedScheme>,
      );
      const bySurface = Object.fromEntries(arrivalsInFlight().map(entry => [entry.pending.clientMsgId, entry.surface]));
      expect(bySurface).toEqual({'c-thread': 'thread:root-A', 'c-channel': ARRIVAL_SURFACE_CHANNEL});
    });
  });

  // -----------------------------------------------------------------------------
  // 4. Timeline 둘 — 채널 목록이 스레드 답글의 메아리를 또 그리지 않는다
  // -----------------------------------------------------------------------------
  describe('Timeline 둘 — 스레드 답글이 확정될 때 채널 목록에 메아리가 마운트되지 않는다', () => {
    const history = [message(1), message(2)];
    const replyFor = (seq: number) => mine(seq, {rootId: ROOT_ID});

    const pair = (messages: Message[], threadPending: PendingMessage[]) => (
      <View>
        <View testID="channel-surface">
          <Timeline
            messages={messages}
            directory={DIRECTORY}
            status="ready"
            myMemberId={SELF}
            nowMs={NOW + 60_000}
            // 채널 목록은 답글의 메아리를 받지 않는다(코어 `channelPending`).
            pending={[]}
          />
        </View>
        <View testID="thread-surface">
          <Timeline
            messages={messages}
            directory={DIRECTORY}
            status="ready"
            myMemberId={SELF}
            nowMs={NOW + 60_000}
            pending={threadPending}
            markReplies={false}
            showRollup={false}
            arrivalSurface={threadArrivalSurface(ROOT_ID)}
          />
        </View>
      </View>
    );

    const surface = (id: 'channel-surface' | 'thread-surface') => within(screen.getByTestId(id));
    /** 목록 항목 키 중 메시지(`m-`)·메아리(`p-`)만 — 날짜 구분선은 거른다. */
    const keys = (id: 'channel-surface' | 'thread-surface') =>
      (surface(id)
        .getByTestId('timeline-list')
        .props.data.map((entry: {key: string}) => entry.key) as string[]).filter(key => /^[mp]-/.test(key));

    it.each([
      ['POST 응답 경로 — 확정본과 pending 제거가 한 렌더', 30],
      ['등장 중간', 150],
    ] as const)('%s (%dms): 채널 목록은 확정된 답글을 바로 확정본으로 그리고, 스레드는 보류한다', (_name, arrivesAt) => {
      const timing = spyTiming();
      const view = render(pair(history, [echo()]));
      // 마운트: 메아리는 스레드 목록에만 서고, 오름은 한 번만 돈다.
      expect(surface('thread-surface').queryAllByTestId('pending-row')).toHaveLength(1);
      expect(surface('channel-surface').queryAllByTestId('pending-row')).toHaveLength(0);
      expect(timing).toHaveBeenCalledTimes(1);
      expect(arrivalsInFlight().map(entry => entry.surface)).toEqual([threadArrivalSurface(ROOT_ID)]);

      act(() => {
        jest.advanceTimersByTime(arrivesAt);
      });
      // 확정본이 두 목록 모두에 들어오고 스레드의 pending 도 같은 틱에 비었다.
      view.rerender(pair([...history, replyFor(3)], []));

      // 채널 목록: 메아리를 한 번 더 그리지 않는다(이 PR 이전에는 약 360ms 동안 `p-c-1`).
      expect(surface('channel-surface').queryAllByTestId('pending-row')).toHaveLength(0);
      expect(keys('channel-surface')).toEqual(['m-1', 'm-2', 'm-3']);
      // 스레드 목록: 오름이 도는 동안 확정본 자리를 메아리가 지킨다.
      expect(surface('thread-surface').queryAllByTestId('pending-row')).toHaveLength(1);
      expect(keys('thread-surface')).toEqual(['m-1', 'm-2', 'p-c-1']);
      // 두 목록 어디서도 오름이 다시 시작하지 않았다.
      expect(timing).toHaveBeenCalledTimes(1);

      // 보류가 끝나면 스레드도 확정본이 서고, 채널 목록은 그대로다.
      act(() => {
        jest.advanceTimersByTime(HOLD_MS - arrivesAt);
      });
      expect(surface('thread-surface').queryAllByTestId('pending-row')).toHaveLength(0);
      expect(keys('thread-surface')).toEqual(['m-1', 'm-2', 'm-3']);
      expect(keys('channel-surface')).toEqual(['m-1', 'm-2', 'm-3']);
      expect(timing).toHaveBeenCalledTimes(1);
    });

    it('채널에서 보낸 글의 보류는 채널 목록이 읽는다(표면을 나눈 것이 보류를 끈 것이 아니다)', () => {
      spyTiming();
      const channelOnly = (messages: Message[], pending: PendingMessage[]) => (
        <Timeline
          messages={messages}
          directory={DIRECTORY}
          status="ready"
          myMemberId={SELF}
          nowMs={NOW + 60_000}
          pending={pending}
        />
      );
      const view = render(channelOnly(history, [echo()]));
      expect(arrivalsInFlight().map(entry => entry.surface)).toEqual([ARRIVAL_SURFACE_CHANNEL]);
      act(() => {
        jest.advanceTimersByTime(100);
      });
      view.rerender(channelOnly([...history, mine(3)], []));
      expect(screen.queryAllByTestId('pending-row')).toHaveLength(1);
      expect(
        (screen.getByTestId('timeline-list').props.data.map((entry: {key: string}) => entry.key) as string[]).filter(
          key => /^[mp]-/.test(key),
        ),
      ).toEqual(['m-1', 'm-2', 'p-c-1']);
    });
  });

  // -----------------------------------------------------------------------------
  // 5. 진짜 ThreadPanel 의 배선
  // -----------------------------------------------------------------------------
  describe('ThreadPanel — 자기 루트의 표면 이름을 목록에 준다', () => {
    const ROOT = message(1, {id: ROOT_ID});
    const OTHER_LINE = message(2);

    // 패널은 `loadReplies` 의 동일성이 바뀌면 답글을 다시 읽는다 — 확정으로 `timeline` 객체가 바뀌어도 읽기가 다시 돌지 않게 한 함수를 쓴다.
    const loadReplies = async () => {};

    /** `threadSelfSend.test.tsx` 의 하니스와 같은 만큼의 `useTimeline` — 답글 메아리와 확정만 움직인다. */
    const timelineOf = (confirmed: boolean): UseTimelineResult => {
      const reply = mine(3, {rootId: ROOT_ID});
      const messages = confirmed ? [ROOT, OTHER_LINE, reply] : [ROOT, OTHER_LINE];
      return {
        state: {messages, oldestSeq: 1, newestSeq: messages[messages.length - 1].seq},
        status: 'ready',
        resume: {lastRecovered: null, lastBackfillCount: 0, resubscribeCount: 0},
        recoveryMarkers: [],
        pending: [],
        send: async () => {},
        resend: async () => {},
        toggleReaction: async () => {},
        editBody: async () => {},
        removeMessage: async () => {},
        loadReplies,
        sendReply: async () => {},
        repliesPending: () => (confirmed ? [] : [echo()]),
        loadOlder: async () => {},
        reload: () => {},
        loadingOlder: false,
        reachedStart: true,
        reactions: {},
      } as unknown as UseTimelineResult;
    };

    const stack = (confirmed: boolean) => {
      const timeline = timelineOf(confirmed);
      return (
        <View>
          <View testID="channel-surface">
            <Timeline
              messages={timeline.state.messages}
              directory={DIRECTORY}
              status="ready"
              myMemberId={SELF}
              nowMs={NOW + 60_000}
              pending={[]}
            />
          </View>
          <View testID="thread-surface">
            <ThreadPanel
              root={ROOT}
              timeline={timeline}
              directory={DIRECTORY}
              myMemberId={SELF}
              nowMs={NOW + 60_000}
              onClose={() => {}}
            />
          </View>
        </View>
      );
    };

    it('패널의 메아리는 스레드 표면으로 적히고, 확정된 뒤에도 채널 목록은 메아리를 그리지 않는다', async () => {
      spyTiming();
      const view = render(stack(false));
      // 패널이 마운트 때 시작하는 답글 읽기(`loadReplies`)가 끝나도록 act 안에서 비운다.
      await act(async () => {
        for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
      });
      expect(arrivalsInFlight()).toHaveLength(1);
      expect(arrivalsInFlight()[0].surface).toBe(threadArrivalSurface(ROOT_ID));
      expect(within(screen.getByTestId('thread-surface')).queryAllByTestId('pending-row')).toHaveLength(1);

      act(() => {
        jest.advanceTimersByTime(100);
      });
      view.rerender(stack(true));
      // 패널은 보류하고, 아래 깔린 채널 목록은 확정본을 그대로 그린다.
      expect(within(screen.getByTestId('thread-surface')).queryAllByTestId('pending-row')).toHaveLength(1);
      expect(within(screen.getByTestId('channel-surface')).queryAllByTestId('pending-row')).toHaveLength(0);
      expect(
        (within(screen.getByTestId('channel-surface'))
          .getByTestId('timeline-list')
          .props.data.map((entry: {key: string}) => entry.key) as string[]).filter(key => /^[mp]-/.test(key)),
      ).toEqual(['m-1', 'm-2', 'm-3']);

      act(() => {
        jest.advanceTimersByTime(HOLD_MS);
      });
      expect(within(screen.getByTestId('thread-surface')).queryAllByTestId('pending-row')).toHaveLength(0);
    });
  });
});
