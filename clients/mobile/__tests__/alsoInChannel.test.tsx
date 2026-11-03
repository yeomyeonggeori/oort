import type {Message, RosterMember} from '@momo/core/lib/api';
import {sendMessage, sendThreadReply} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import type {PendingMessage} from '@momo/core/features/timeline/model';
import {act, cleanup, fireEvent, render, renderHook, screen} from '@testing-library/react-native';
import React from 'react';

import '../src/boot/polyfills';
import {Timeline} from '../src/features/conversation/Timeline';
import {useTimeline} from '../src/features/conversation/useTimeline';

// =============================================================================
// #4888 — 폰: 대화에는 「대화에도 보내기」로 보낸 답글만 선다(웹과 같은 규칙), 옛 서버에서는 오늘 동작, 스레드 화면은 전부,
// 밀어서 보낸 답글이 실패하면 대화 화면에서 알린다(같은 `client_msg_id` 로 다시 보내기).
// 규칙의 단위 시험은 코어 `threadHome.test.ts`; 여기서는 진짜 `Timeline`·`useTimeline` 이 그 규칙을 **따르는지**를 잰다.
// =============================================================================

jest.mock('@momo/core/lib/api', () => ({
  ...jest.requireActual('@momo/core/lib/api'),
  sendMessage: jest.fn(),
  sendThreadReply: jest.fn(),
}));

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const ROOT_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
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
  member({id: SELF, displayName: '이서준', handle: 'seojun'}),
  member({id: OTHER, displayName: '김인턴', handle: 'intern-kim'}),
]);

function message(over: Partial<Message> = {}): Message {
  return {
    id: ROOT_ID,
    channelId: 'ch',
    seq: 10,
    hlcTs: 10,
    hlcCount: 0,
    authorMemberId: OTHER,
    type: 'text',
    body: '그건 배포 뒤에 봅시다',
    state: 'sent',
    createdAtMs: BASE_MS,
    ...over,
  };
}
const SUMMARY_NEW = {reply_count: 2, last_reply_seq: 12, last_reply_at: BASE_MS, participant_ids: [SELF], participant_count: 1};
const SUMMARY_OLD = {reply_count: 2, last_reply_seq: 12, last_reply_at: BASE_MS};
const rootWith = (thread: Message['thread']) => message({thread});
const reply = (seq: number, body: string, over: Partial<Message> = {}) =>
  message({id: `cccccccc-1111-4111-8111-00000000000${seq}`, rootId: ROOT_ID, seq, authorMemberId: SELF, body, ...over});

function actions(onOpenThread = jest.fn()) {
  return {
    myMemberId: SELF,
    onToggleReaction: jest.fn().mockResolvedValue(undefined),
    onEdit: jest.fn().mockResolvedValue(undefined),
    onDelete: jest.fn().mockResolvedValue(undefined),
    onOpenThread,
  };
}

function channel(messages: Message[], extra: Record<string, unknown> = {}) {
  return render(
    <Timeline
      messages={messages}
      directory={DIRECTORY}
      status="ready"
      myMemberId={SELF}
      nowMs={BASE_MS + 120_000}
      actions={actions()}
      {...extra}
    />,
  );
}

afterEach(cleanup);

describe('대화(본류)에 서는 답글', () => {
  it('새 서버: 켜지 않은 답글은 서지 않고 켠 답글만 선다 — 켠 답글은 어느 스레드의 것인지 말한다', () => {
    channel([rootWith(SUMMARY_NEW), reply(11, '스레드로만 가요'), reply(12, '대화에도 보여요', {alsoInChannel: true})]);
    expect(screen.queryByText('스레드로만 가요')).toBeNull();
    expect(screen.getByText('대화에도 보여요')).toBeTruthy();
    expect(screen.getAllByTestId('reply-marker')).toHaveLength(1);
    expect(screen.getByText('↳ 김인턴님 스레드에 답글')).toBeTruthy();
    // 둘째 줄은 루트의 글 한 줄이다.
    expect(screen.getByTestId('reply-marker-excerpt').props.children).toBe('그건 배포 뒤에 봅시다');
  });

  it('옛 서버(요약에 참여자 키 없음, 켠 값 없음): 오늘처럼 답글이 전부 남는다 — 사라져 보이면 안 된다', () => {
    channel([rootWith(SUMMARY_OLD), reply(11, '옛 서버의 답글'), reply(12, '또 다른 답글')]);
    expect(screen.getByText('옛 서버의 답글')).toBeTruthy();
    expect(screen.getByText('또 다른 답글')).toBeTruthy();
    expect(screen.getAllByTestId('reply-marker')).toHaveLength(2);
  });

  it('스레드 화면(mainFlow=false)은 서버가 아는 서버여도 답글 전부가 선다', () => {
    channel([rootWith(SUMMARY_NEW), reply(11, '스레드로만 가요'), reply(12, '대화에도 보여요', {alsoInChannel: true})], {
      mainFlow: false,
      markReplies: false,
      showRollup: false,
    });
    expect(screen.getByText('스레드로만 가요')).toBeTruthy();
    expect(screen.getByText('대화에도 보여요')).toBeTruthy();
    expect(screen.queryByTestId('reply-marker')).toBeNull();
  });

  it('줄을 누르면 그 스레드(루트)가 열린다', () => {
    const onOpenThread = jest.fn();
    render(
      <Timeline
        messages={[rootWith(SUMMARY_NEW), reply(12, '대화에도 보여요', {alsoInChannel: true})]}
        directory={DIRECTORY}
        status="ready"
        myMemberId={SELF}
        nowMs={BASE_MS + 120_000}
        actions={actions(onOpenThread)}
      />,
    );
    const marker = screen.getByTestId('reply-marker');
    expect(marker.props.accessibilityRole).toBe('button');
    expect(marker.props.accessibilityLabel).toBe('김인턴님 스레드에 답글, 그건 배포 뒤에 봅시다');
    expect(marker.props.accessibilityHint).toBe('이 답글이 달린 스레드 열기');
    fireEvent.press(marker);
    expect(onOpenThread).toHaveBeenCalledTimes(1);
    expect(onOpenThread.mock.calls[0][0]).toMatchObject({id: ROOT_ID});
  });

  it('루트가 불러온 범위 위에 있으면 이름도 원문도 지어내지 않고, 눌리지 않는다', () => {
    channel([reply(12, '루트는 위에 있어요', {alsoInChannel: true})]);
    expect(screen.getByText('↳ 스레드에 답글')).toBeTruthy();
    expect(screen.queryByTestId('reply-marker-excerpt')).toBeNull();
    expect(screen.getByTestId('reply-marker').props.accessibilityRole).not.toBe('button');
  });
});

describe('보내지 못한 스레드 답글의 에코', () => {
  const echo = (over: Partial<PendingMessage> = {}): PendingMessage => ({
    clientMsgId: 'client-1',
    channelId: 'ch',
    authorMemberId: SELF,
    body: '밀어서 보낸 답글',
    createdAtMs: BASE_MS + 60_000,
    sinceSeq: 10,
    status: 'failed',
    rootId: ROOT_ID,
    ...over,
  });

  it('대화 화면에 「전송 실패」 줄로 서고, 다시 보내기·지우기가 같은 행 키로 간다', () => {
    const onResendPending = jest.fn();
    const onDiscardPending = jest.fn();
    channel([rootWith(SUMMARY_NEW)], {pending: [echo()], onResendPending, onDiscardPending});
    const row = screen.getByTestId('pending-row');
    expect(row).toBeTruthy();
    expect(screen.getByText('전송 실패')).toBeTruthy();
    // 어느 스레드로 가는 답글인지 에코도 같은 줄로 말한다.
    expect(screen.getByText('↳ 김인턴님 스레드에 답글')).toBeTruthy();
    fireEvent.press(screen.getByTestId('pending-resend'));
    expect(onResendPending).toHaveBeenCalledWith('client-1');
    fireEvent.press(screen.getByTestId('pending-discard'));
    expect(onDiscardPending).toHaveBeenCalledWith('client-1');
  });

  it('확정본이 나중에 도착하면 — 본류에서는 걸러져 있어도 — 실패 에코가 정착해 사라진다(이미 간 답글이 「전송 실패」로 남지 않는다)', () => {
    channel([rootWith(SUMMARY_NEW), reply(11, '밀어서 보낸 답글', {seq: 11})], {pending: [echo()]});
    expect(screen.queryByTestId('pending-row')).toBeNull();
    expect(screen.queryByText('전송 실패')).toBeNull();
  });
});

// ---- 훅: 에코가 「대화에도」 값을 싣고, 실패하면 같은 멱등키로 다시 보낸다 ------------------------------------------------

function hook() {
  return renderHook(() => useTimeline(null, 'workspace', 'channel', 'self'));
}

function confirmed(clientMsgId: string, over: Partial<Message> = {}): Message {
  void clientMsgId;
  return message({
    id: 'dddddddd-1111-4111-8111-dddddddddddd',
    channelId: 'channel',
    seq: 50,
    authorMemberId: 'self',
    rootId: ROOT_ID,
    body: '대화에도 보낼 답글',
    ...over,
  });
}

describe('useTimeline — 「대화에도 보내기」 답글의 에코와 다시 보내기', () => {
  beforeEach(() => {
    jest.mocked(sendMessage).mockReset();
    jest.mocked(sendThreadReply).mockReset();
  });

  it('켜지 않은 답글: 보내는 중에는 스레드의 것이고(대화 목록에 없다), 호출은 예전과 같은 모양이다', async () => {
    let finish: (m: Message) => void = () => undefined;
    jest.mocked(sendThreadReply).mockImplementation(
      () => new Promise<Message>(done => { finish = done; }),
    );
    const view = hook();
    let sending: Promise<void> = Promise.resolve();
    act(() => {
      sending = view.result.current.sendReply(ROOT_ID, '스레드로만');
    });
    expect(view.result.current.repliesPending(ROOT_ID)).toHaveLength(1);
    expect(view.result.current.pending).toEqual([]);
    const call = jest.mocked(sendThreadReply).mock.calls[0];
    expect(call[2]).toBe(ROOT_ID);
    expect(call[5]).toBeUndefined();
    await act(async () => {
      finish(confirmed('x', {body: '스레드로만'}));
      await sending;
    });
  });

  it('켠 답글: 에코가 대화 목록에 서고 요청에 alsoInChannel: true 가 실린다', async () => {
    let finish: (m: Message) => void = () => undefined;
    jest.mocked(sendThreadReply).mockImplementation(
      () => new Promise<Message>(done => { finish = done; }),
    );
    const view = hook();
    let sending: Promise<void> = Promise.resolve();
    act(() => {
      sending = view.result.current.sendReply(ROOT_ID, '대화에도 보낼 답글', undefined, {alsoInChannel: true});
    });
    expect(view.result.current.pending).toHaveLength(1);
    expect(view.result.current.pending[0]).toMatchObject({status: 'sending', rootId: ROOT_ID, alsoInChannel: true});
    expect(jest.mocked(sendThreadReply).mock.calls[0][5]).toEqual({alsoInChannel: true});
    await act(async () => {
      finish(confirmed('x', {alsoInChannel: true}));
      await sending;
    });
    expect(view.result.current.pending).toEqual([]);
  });

  it('실패 → 대화에 보임 → 다시 보내기: 같은 client_msg_id·같은 alsoInChannel 로 한 번 더 가고, 한 메시지로 모인다', async () => {
    jest.mocked(sendThreadReply)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(confirmed('x', {alsoInChannel: true}));
    const view = hook();
    await act(async () => {
      await view.result.current.sendReply(ROOT_ID, '대화에도 보낼 답글', undefined, {alsoInChannel: true});
    });
    expect(view.result.current.pending).toHaveLength(1);
    expect(view.result.current.pending[0].status).toBe('failed');
    const id = view.result.current.pending[0].clientMsgId;

    await act(async () => {
      await view.result.current.resend(id);
    });
    const calls = jest.mocked(sendThreadReply).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1][3]).toBe(calls[0][3]); // 같은 멱등키
    expect(calls[1][3]).toBe(id);
    expect(calls[1][5]).toEqual({alsoInChannel: true}); // 같은 요청
    expect(view.result.current.pending).toEqual([]);
    expect(view.result.current.state.messages.filter(m => m.rootId === ROOT_ID)).toHaveLength(1);
  });
});
