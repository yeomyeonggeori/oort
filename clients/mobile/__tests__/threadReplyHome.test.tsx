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
// #4888 → #5324 — 폰: 대화(본류)에는 스레드 답글이 서지 않는다. 「대화에도 보내기」는 화면에서 빠졌고, 옛날에 켜고 보낸 답글(서버 필드는 그대로
// 온다)도 **스레드에만** 보인다 — 본류의 행도 「↳ ○○님 스레드에 답글」 한 줄 요약도 없다. 서버가 스레드 요약을 모르는 옛 서버에서는 오늘 동작
// (답글 전부)을 지킨다. 스레드 화면은 전부. 밀어서 보낸 답글이 실패하면 대화 화면에서 알린다(같은 `client_msg_id` 로 다시 보내기).
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

describe('대화(본류)에 서는 행', () => {
  // 사보타주: 코어 `isMainFlowRow` 에 `|| message.alsoInChannel === true` 를 되살리면 이 시험이 RED 여야 한다.
  it('새 서버: 스레드 답글은 하나도 서지 않는다 — 옛날에 「대화에도 보내기」로 보낸 답글도 스레드에만 있고, 답글 줄도 없다', () => {
    channel([rootWith(SUMMARY_NEW), reply(11, '스레드로만 가요'), reply(12, '옛날에 대화에도 보낸 답글', {alsoInChannel: true})]);
    expect(screen.getByText('그건 배포 뒤에 봅시다')).toBeTruthy();
    expect(screen.queryByText('스레드로만 가요')).toBeNull();
    expect(screen.queryByText('옛날에 대화에도 보낸 답글')).toBeNull();
    expect(screen.queryByTestId('reply-marker')).toBeNull();
    expect(screen.queryByText('↳ 김인턴님 스레드에 답글')).toBeNull();
  });

  it('서버에 남은 옛 「대화에도 보낸」 답글만 있는 창(요약 없음)도 새 서버의 증거라서 그 답글은 본류에 서지 않는다', () => {
    channel([reply(12, '루트는 위에 있는 옛 답글', {alsoInChannel: true})]);
    expect(screen.queryByText('루트는 위에 있는 옛 답글')).toBeNull();
    expect(screen.queryByTestId('reply-marker')).toBeNull();
  });

  it('옛 서버(요약에 참여자 키 없음, 켠 값 없음): 오늘처럼 답글이 전부 남는다 — 사라져 보이면 안 된다', () => {
    channel([rootWith(SUMMARY_OLD), reply(11, '옛 서버의 답글'), reply(12, '또 다른 답글')]);
    expect(screen.getByText('옛 서버의 답글')).toBeTruthy();
    expect(screen.getByText('또 다른 답글')).toBeTruthy();
    expect(screen.getAllByTestId('reply-marker')).toHaveLength(2);
  });

  it('스레드 화면(mainFlow=false)은 서버가 아는 서버여도 답글 전부가 선다 — 옛 「대화에도 보낸」 답글 포함', () => {
    channel([rootWith(SUMMARY_NEW), reply(11, '스레드로만 가요'), reply(12, '옛날에 대화에도 보낸 답글', {alsoInChannel: true})], {
      mainFlow: false,
      markReplies: false,
      showRollup: false,
    });
    expect(screen.getByText('스레드로만 가요')).toBeTruthy();
    expect(screen.getByText('옛날에 대화에도 보낸 답글')).toBeTruthy();
    expect(screen.queryByTestId('reply-marker')).toBeNull();
  });

  it('옛 서버의 본류 답글 줄을 누르면 그 스레드(루트)가 열린다', () => {
    const onOpenThread = jest.fn();
    render(
      <Timeline
        messages={[rootWith(SUMMARY_OLD), reply(12, '옛 서버의 답글')]}
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

  it('루트가 불러온 범위 위에 있으면 이름도 원문도 지어내지 않고, 눌리지 않는다(옛 서버 경로)', () => {
    channel([reply(12, '루트는 위에 있어요')]);
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

  it('스레드 화면(markReplies=false)의 에코에는 답글 줄이 없다 — 그 화면의 행은 전부 그 스레드의 답글이다', () => {
    channel([rootWith(SUMMARY_NEW)], {pending: [echo({status: 'sending'})], mainFlow: false, markReplies: false, showRollup: false});
    expect(screen.getByTestId('pending-row')).toBeTruthy();
    expect(screen.queryByTestId('reply-marker')).toBeNull();
  });

  it('확정본이 나중에 도착하면 — 본류에서는 걸러져 있어도 — 실패 에코가 정착해 사라진다(이미 간 답글이 「전송 실패」로 남지 않는다)', () => {
    channel([rootWith(SUMMARY_NEW), reply(11, '밀어서 보낸 답글', {seq: 11})], {pending: [echo()]});
    expect(screen.queryByTestId('pending-row')).toBeNull();
    expect(screen.queryByText('전송 실패')).toBeNull();
  });
});

// ---- 훅: 답글의 요청에는 「대화에도 보내기」 키가 없고, 실패하면 같은 멱등키로 다시 보낸다 -------------------------------------------

function hook() {
  return renderHook(() => useTimeline(null, 'workspace', 'channel', 'self'));
}

function confirmed(over: Partial<Message> = {}): Message {
  return message({
    id: 'dddddddd-1111-4111-8111-dddddddddddd',
    channelId: 'channel',
    seq: 50,
    authorMemberId: 'self',
    rootId: ROOT_ID,
    body: '스레드로 보낼 답글',
    ...over,
  });
}

describe('useTimeline — 스레드 답글의 에코와 다시 보내기', () => {
  beforeEach(() => {
    jest.mocked(sendMessage).mockReset();
    jest.mocked(sendThreadReply).mockReset();
  });

  it('보내는 중에는 스레드의 것이고(대화 목록에 없다), 호출은 옵션 자리가 비어 있다', async () => {
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
      finish(confirmed({body: '스레드로만'}));
      await sending;
    });
  });

  // 사보타주: `useTimeline` 의 `sendReply` 에 `...(flags?.alsoInChannel === true ? {alsoInChannel: true} : {})` 를 되살리면 이 시험이 RED 여야 한다.
  it('옛 호출자가 alsoInChannel 을 억지로 넘겨도 에코에도 요청에도 실리지 않는다', async () => {
    jest.mocked(sendThreadReply).mockResolvedValue(confirmed());
    const view = hook();
    await act(async () => {
      await view.result.current.sendReply(ROOT_ID, '스레드로 보낼 답글', undefined, {alsoInChannel: true} as never);
    });
    const call = jest.mocked(sendThreadReply).mock.calls[0];
    expect(call[5]).toBeUndefined();
  });

  it('실패 → 대화에 보임 → 다시 보내기: 같은 client_msg_id 로 한 번 더 가고, 한 메시지로 모인다', async () => {
    jest.mocked(sendThreadReply)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(confirmed());
    const view = hook();
    await act(async () => {
      await view.result.current.sendReply(ROOT_ID, '스레드로 보낼 답글');
    });
    expect(view.result.current.pending).toHaveLength(1);
    expect(view.result.current.pending[0].status).toBe('failed');
    expect(view.result.current.pending[0]).not.toHaveProperty('alsoInChannel');
    const id = view.result.current.pending[0].clientMsgId;

    await act(async () => {
      await view.result.current.resend(id);
    });
    const calls = jest.mocked(sendThreadReply).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1][3]).toBe(calls[0][3]); // 같은 멱등키
    expect(calls[1][3]).toBe(id);
    expect(calls[1][5]).toBeUndefined(); // 같은 요청 — 옵션 자리가 비어 있다
    expect(view.result.current.pending).toEqual([]);
    expect(view.result.current.state.messages.filter(m => m.rootId === ROOT_ID)).toHaveLength(1);
  });
});
