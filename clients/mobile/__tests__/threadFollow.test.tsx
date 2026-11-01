import {ApiError, type Message, type RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';

import {CONV_ICONS} from '../src/design/icons';
import {ThreadPanel} from '../src/features/conversation/ThreadPanel';
import type {UseTimelineResult} from '../src/features/conversation/useTimeline';

// =============================================================================
// 폰 스레드 화면 머리의 「따라가기 / 그만 따라가기」 (#4890). 서버는 가짜 응답이다. 규칙(낙관적 갱신·되돌림·숨김)의 단위 시험은
// 코어 `threadFollow.test.ts` 에 있고, 여기서는 화면이 **원을 언제 세우고 무엇을 말하는가**를 잰다: 상태 둘(말로 하는 라벨·
// 아이콘)·누르면 즉시 바뀜·실패하면 되돌리고 안내·쓸 수 없는 곳은 숨김. 폰의 푸시 알림 쪽(탭 → 스레드, `thread-id` 묶음)은
// `pushTap.test.tsx`·릴레이 시험이 이미 잰다.
// =============================================================================

const mockFollow = jest.fn();
const mockUnfollow = jest.fn();
jest.mock('@momo/core/lib/api', () => ({
  ...jest.requireActual('@momo/core/lib/api'),
  followThread: (...args: unknown[]) => mockFollow(...args),
  unfollowThread: (...args: unknown[]) => mockUnfollow(...args),
  markThreadRead: jest.fn(async () => ({following: true})),
}));

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const ROOT_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const BASE_MS = 1_700_000_000_000;

function member(id: string, name: string): RosterMember {
  return {
    id,
    workspaceId: 'ws',
    kind: 'human',
    status: 'active',
    displayName: name,
    handle: name,
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  } as RosterMember;
}
const DIRECTORY = makeDirectory([member(SELF, '곽성재'), member(OTHER, '김인턴')]);

function message(over: Partial<Message> = {}): Message {
  return {
    id: 'msg',
    channelId: 'ch',
    seq: 1,
    hlcTs: 1,
    hlcCount: 0,
    authorMemberId: OTHER,
    type: 'text',
    body: '배포는 금요일에 합니다.',
    state: 'sent',
    createdAtMs: BASE_MS,
    ...over,
  };
}
const ROOT = message({id: ROOT_ID, seq: 10});
const REPLY = message({id: 'reply-11', seq: 11, rootId: ROOT_ID, body: '확인했어요'});

const ON = '이 스레드를 따라가고 있어요. 누르면 그만 따라가요.';
const OFF = '이 스레드를 따라가지 않아요. 누르면 따라가요.';

function timeline(loadReplies: jest.Mock): UseTimelineResult {
  return {
    state: {messages: [ROOT, REPLY], oldestSeq: ROOT.seq, newestSeq: 30},
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
    applyThreadRead: () => {},
    sendReply: async () => {},
    repliesPending: () => [],
    loadOlder: async () => {},
    reload: () => {},
    loadingOlder: false,
    reachedStart: true,
    reactions: {},
  } as unknown as UseTimelineResult;
}

function panel(
  loadReplies: jest.Mock,
  over: {followable?: boolean; workspaceId?: string | null; channelId?: string | null} = {},
) {
  return (
    <ThreadPanel
      root={ROOT}
      timeline={timeline(loadReplies)}
      directory={DIRECTORY}
      myMemberId={SELF}
      nowMs={BASE_MS + 120_000}
      workspaceId={over.workspaceId === null ? undefined : (over.workspaceId ?? 'ws')}
      channelId={over.channelId === null ? undefined : (over.channelId ?? 'ch')}
      followable={over.followable}
      onClose={() => {}}
    />
  );
}

const settle = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
const loads = (following: boolean | undefined) =>
  jest.fn(async () => (following === undefined ? undefined : {following}));

beforeEach(() => {
  mockFollow.mockReset();
  mockUnfollow.mockReset();
});
afterEach(cleanup);

describe('머리의 원: 지금 상태를 말로 한다', () => {
  it('따라가는 스레드는 bell 과 「따라가고 있어요」 라벨, 따라가지 않는 스레드는 빗금 bell-off 와 「따라가지 않아요」 라벨이다', async () => {
    const first = render(panel(loads(true)));
    await settle();
    expect(screen.getByTestId('thread-follow').props.accessibilityLabel).toBe(ON);
    expect(screen.getByTestId('thread-follow-icon').props.source).toBe(CONV_ICONS.bell);
    first.unmount();

    render(panel(loads(false)));
    await settle();
    expect(screen.getByTestId('thread-follow').props.accessibilityLabel).toBe(OFF);
    expect(screen.getByTestId('thread-follow-icon').props.source).toBe(CONV_ICONS.bellOff);
  });

  it('옛 서버(following 을 못 읽음)는 따라가지 않는 것으로 읽는다', async () => {
    render(panel(loads(undefined)));
    await settle();
    expect(screen.getByTestId('thread-follow').props.accessibilityLabel).toBe(OFF);
  });

  it('스레드를 받기 전과 받지 못했을 때는 원이 없다', async () => {
    const first = render(panel(jest.fn(() => new Promise(() => {}))));
    expect(screen.queryByTestId('thread-follow')).toBeNull();
    first.unmount();
    render(panel(jest.fn(async () => Promise.reject(new Error('network')))));
    await settle();
    expect(screen.queryByTestId('thread-follow')).toBeNull();
  });

  it('DM 같은 곳(followable=false)과 보낼 곳을 모르는 격리 하니스에는 원이 없다', async () => {
    const first = render(panel(loads(false), {followable: false}));
    await settle();
    expect(screen.queryByTestId('thread-follow')).toBeNull();
    first.unmount();
    render(panel(loads(false), {workspaceId: null, channelId: null}));
    await settle();
    expect(screen.queryByTestId('thread-follow')).toBeNull();
  });
});

describe('누르면 바로 바뀌고 서버 값으로 확정된다', () => {
  it('따라가기: 응답 전에 켜진 모양이 되고(라벨·아이콘), 확정돼도 그대로다. 요청이 나가 있는 동안 다시 눌러도 요청은 한 번이다', async () => {
    let respond!: (value: {following: boolean}) => void;
    mockFollow.mockReturnValue(new Promise(resolve => { respond = resolve; }));
    render(panel(loads(false)));
    await settle();
    fireEvent.press(screen.getByTestId('thread-follow'));
    fireEvent.press(screen.getByTestId('thread-follow'));
    expect(mockFollow).toHaveBeenCalledTimes(1);
    expect(mockFollow).toHaveBeenCalledWith('ws', 'ch', ROOT_ID);
    expect(mockUnfollow).not.toHaveBeenCalled();
    expect(screen.getByTestId('thread-follow').props.accessibilityLabel).toBe(ON); // 낙관적: 아직 응답 전
    expect(screen.getByTestId('thread-follow').props.accessibilityState).toMatchObject({busy: true});
    await act(async () => respond({following: true}));
    expect(screen.getByTestId('thread-follow').props.accessibilityLabel).toBe(ON);
    expect(screen.getByTestId('thread-follow').props.accessibilityState).toMatchObject({busy: false});
  });

  it('그만 따라가기: DELETE 를 보내고 꺼진 모양이 된다', async () => {
    mockUnfollow.mockResolvedValue({following: false});
    render(panel(loads(true)));
    await settle();
    fireEvent.press(screen.getByTestId('thread-follow'));
    await settle();
    expect(mockUnfollow).toHaveBeenCalledWith('ws', 'ch', ROOT_ID);
    expect(screen.getByTestId('thread-follow').props.accessibilityLabel).toBe(OFF);
    expect(screen.getByTestId('thread-follow-icon').props.source).toBe(CONV_ICONS.bellOff);
  });
});

describe('실패하면 되돌리고 짧게 알린다', () => {
  it('서버 오류: 낙관값이 보이다가 누르기 전 모양으로 돌아가고 안내가 서며, 닫으면 사라진다', async () => {
    let fail!: (error: unknown) => void;
    mockFollow.mockReturnValue(new Promise((_resolve, reject) => { fail = reject; }));
    render(panel(loads(false)));
    await settle();
    fireEvent.press(screen.getByTestId('thread-follow'));
    expect(screen.getByTestId('thread-follow').props.accessibilityLabel).toBe(ON);
    await act(async () => fail(new ApiError(500, 'boom')));
    expect(screen.getByTestId('thread-follow').props.accessibilityLabel).toBe(OFF);
    expect(screen.getByText('따라가기를 바꾸지 못했어요. 잠시 뒤에 다시 시도해 주세요.')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('닫기'));
    expect(screen.queryByTestId('thread-follow-failed')).toBeNull();
  });

  it.each([
    ['옛 서버 404', new ApiError(404, 'not found')],
    ['옛 서버 405', new ApiError(405, 'method not allowed')],
    ['DM 스레드 400', new ApiError(400, 'not applicable', 'thread_follow_not_applicable')],
  ])('%s → 누른 뒤 원이 사라지고 실패 안내도 세우지 않는다', async (_name, error) => {
    mockFollow.mockRejectedValue(error);
    render(panel(loads(false)));
    await settle();
    fireEvent.press(screen.getByTestId('thread-follow'));
    await settle();
    expect(screen.queryByTestId('thread-follow')).toBeNull();
    expect(screen.queryByTestId('thread-follow-failed')).toBeNull();
  });
});
