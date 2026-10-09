import type {
  SessionThreadReply,
  WorkSessionEvent,
} from '@momo/core/features/work/workSessionModel';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react-native';
import React from 'react';
import {ScrollView} from 'react-native';

import {haptics} from '../src/lib/haptics';
import {
  buildConversation,
  followDecision,
  isNearBottom,
  PENDING_SKEW_MS,
  type ChatItem,
  type PendingSend,
} from '../src/features/work/conversation';
import {
  composerGate,
  ENDED_NOTICE,
  OFFLINE_NOTICE,
  OWNER_ONLY_NOTICE,
  SIGNING_LOADING_NOTICE,
  SIGNING_OFF_NOTICE,
  WorkConversationView,
  type ComposerGate,
  type SendOutcome,
} from '../src/features/work/WorkConversation';

jest.mock('../src/lib/haptics', () => ({
  haptics: {
    selection: jest.fn(),
    light: jest.fn(),
    medium: jest.fn(),
    success: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
  },
}));

// =============================================================================
// N3 #3595 - 작업 상세 「대화」 모드. 표적:
//  - 지시(내 답글)·답(조각)·허락 카드가 seq 순서로 선다
//  - 이어지는 조각은 같은 말풍선에 붙고, 내가 끼어들면 갈라진다
//  - 위로 올려 읽는 중이면 새 답이 와도 맨 아래로 끌지 않는다
//  - 보낸 뒤 입력창이 비고, 실패하면 글이 돌아온다
//  - 서명 요구가 꺼진 동안의 안내는 그 조건에서만 나온다
//  - 햅틱은 보내기 탭에서 한 번
// =============================================================================

const SID = 'SESSION-1';
const SELF = 'member-self';
const OTHER = 'member-other';

function ev(
  id: string,
  seq: number,
  type: WorkSessionEvent['type'],
  payload: Record<string, unknown> = {},
): WorkSessionEvent {
  return {
    eventId: id,
    type,
    sessionId: SID,
    atMs: 1_000 * seq,
    seq,
    payload: {work_session_id: SID, ...payload},
  };
}

const partial = (id: string, seq: number, text: string) =>
  ev(id, seq, 'agent.partial', {text_delta: text});

function reply(
  id: string,
  seq: number,
  text: string,
  author = SELF,
  mode?: 'queue' | 'interrupt',
): SessionThreadReply {
  return {id, authorMemberId: author, text, atMs: 1_000 * seq, seq, ...(mode ? {mode} : {})};
}

function build(over: Partial<Parameters<typeof buildConversation>[0]> = {}) {
  return buildConversation({
    events: [],
    session: {status: 'running'},
    truncated: false,
    replies: [],
    selfMemberId: SELF,
    pending: [],
    permissionRequestId: null,
    ...over,
  });
}

const kinds = (items: ChatItem[]) =>
  items.map(item =>
    item.kind === 'system' || item.kind === 'permission' ? item.kind : `${item.kind}:${'text' in item ? item.text : ''}`,
  );

describe('대화 순서 (buildConversation)', () => {
  it('지시·답·허락 카드가 seq 순서로 서고, 내가 끼어들면 답이 갈라진다', () => {
    const items = build({
      events: [
        ev('E1', 1, 'agent.status', {terminal_event: 'created'}),
        partial('P1', 3, '살펴보는 중'),
        partial('P2', 4, '이에요'),
        ev('A1', 7, 'approval.requested', {action: 'run', action_type: 'execute'}),
        // 지시 뒤에 이어지는 같은 답의 조각.
        partial('P3', 9, '다시 볼게요'),
      ],
      replies: [
        reply('R-OTHER', 2, '팀원 한마디', OTHER),
        // 폰 시계가 느려도 순서는 seq가 정한다(atMs만 보면 맨 앞으로 간다).
        {...reply('R-MINE', 5, '테스트부터 봐 줘', SELF, 'queue'), atMs: 10},
        reply('R-LATE', 8, '급하면 지금 끼어들어', SELF, 'interrupt'),
      ],
      permissionRequestId: 'A1',
    });
    expect(kinds(items)).toEqual([
      'system',
      'other:팀원 한마디',
      'agent:살펴보는 중이에요',
      'mine:테스트부터 봐 줘',
      'permission',
      'mine:급하면 지금 끼어들어',
      'agent:다시 볼게요',
    ]);
  });

  it('이어지는 조각은 한 말풍선이고, 마지막 답만 작성 중이다', () => {
    const items = build({
      events: [partial('P1', 1, '안녕'), partial('P2', 2, '하세요')],
    });
    const agents = items.filter(item => item.kind === 'agent');
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({text: '안녕하세요', streaming: true});
    // 끝난 세션의 마지막 답은 더 이상 쓰는 중이 아니다.
    const done = build({
      events: [partial('P1', 1, '안녕'), partial('P2', 2, '하세요')],
      session: {status: 'ended'},
    });
    expect(done.find(item => item.kind === 'agent')).toMatchObject({streaming: false});
  });

  it('플래그 전·카드 불가일 때 대기 중인 승인은 버튼 없는 한 줄이다', () => {
    const items = build({
      events: [ev('A1', 1, 'approval.requested', {action: 'run'})],
      permissionRequestId: null,
    });
    expect(items.map(item => item.kind)).toEqual(['system']);
    expect(items[0]).toMatchObject({state: 'pending'});
  });

  it('결정된 승인은 카드가 아니라 한 줄이다', () => {
    const items = build({
      events: [
        ev('A1', 1, 'approval.requested', {action: 'run'}),
        ev('D1', 2, 'approval.decided', {status: 'approved'}),
      ],
      permissionRequestId: 'A1',
    });
    expect(items.map(item => item.kind)).toEqual(['system']);
  });

  it('낙관 말풍선은 끝에 서고, 읽기가 같은 글을 담으면 사라진다', () => {
    const pending: PendingSend[] = [
      {localId: 'p1', text: '이거 해 줘', mode: 'queue', startedAtMs: 50_000, status: 'sent'},
    ];
    const before = build({events: [partial('P1', 1, '답')], pending});
    expect(kinds(before)).toEqual(['agent:답', 'mine:이거 해 줘']);
    expect(before[1]).toMatchObject({delivery: 'sent'});

    const after = build({
      events: [partial('P1', 1, '답')],
      pending,
      replies: [reply('R1', 60, '이거 해 줘')],
    });
    expect(kinds(after)).toEqual(['agent:답', 'mine:이거 해 줘']);
    expect(after.filter(item => item.kind === 'mine')).toHaveLength(1);
    expect(after[1]).toMatchObject({id: 'R1'});
  });

  it('보내기 전에 있던 같은 글은 방금 보낸 것을 지우지 못한다', () => {
    const pending: PendingSend[] = [
      {localId: 'p1', text: '네', mode: 'queue', startedAtMs: 500_000, status: 'sending'},
    ];
    const items = build({
      pending,
      // 10분 전 같은 글(시계 차이 폭을 한참 넘는다).
      replies: [{...reply('OLD', 1, '네'), atMs: 500_000 - PENDING_SKEW_MS - 1}],
    });
    expect(items.filter(item => item.kind === 'mine')).toHaveLength(2);
  });
});

describe('맨 아래 따라가기 규칙', () => {
  it('위로 올렸으면 따라가지 않고, 내가 보낸 것만 어디서든 따라간다', () => {
    expect(isNearBottom(952, 400, 1400)).toBe(true);
    expect(isNearBottom(500, 400, 1400)).toBe(false);
    expect(followDecision({following: true, mineJustSent: false})).toBe('scroll');
    expect(followDecision({following: false, mineJustSent: false})).toBe('hold');
    expect(followDecision({following: false, mineJustSent: true})).toBe('scroll');
  });
});

describe('입력창이 열리는 조건 (composerGate)', () => {
  const open = {
    owner: true,
    ended: false,
    flag: 'required' as const,
    block: null,
    online: true,
    hasActions: true,
  };
  it('서명 요구가 켜진 뒤에만 열리고, 꺼진 동안은 이유를 말한다', () => {
    expect(composerGate(open)).toEqual({kind: 'ready'});
    expect(composerGate({...open, flag: 'off'})).toEqual({
      kind: 'closed',
      notice: SIGNING_OFF_NOTICE,
    });
    expect(composerGate({...open, flag: 'loading'})).toEqual({
      kind: 'closed',
      notice: SIGNING_LOADING_NOTICE,
    });
  });
  it('모르는 것은 꺼짐이라 부르지 않는다', () => {
    const unknown = composerGate({...open, flag: 'unknown'});
    expect(unknown.kind).toBe('closed');
    expect((unknown as {notice: string}).notice).not.toBe(SIGNING_OFF_NOTICE);
  });
  it('내 작업이 아니면, 끝났으면 자리 자체가 없고 이유가 나온다', () => {
    expect(composerGate({...open, owner: false})).toEqual({kind: 'none', notice: OWNER_ONLY_NOTICE});
    expect(composerGate({...open, ended: true})).toEqual({kind: 'none', notice: ENDED_NOTICE});
  });
  it('키 문제와 오프라인은 각자의 문장으로 닫힌다', () => {
    expect(composerGate({...open, block: '이 폰은 아직 지시 기기가 아니에요.'})).toEqual({
      kind: 'closed',
      notice: '이 폰은 아직 지시 기기가 아니에요.',
    });
    expect(composerGate({...open, online: false})).toEqual({kind: 'closed', notice: OFFLINE_NOTICE});
  });
});

beforeEach(() => {
  jest.mocked(haptics.light).mockClear();
  jest.mocked(haptics.selection).mockClear();
});

// ---- 화면 -------------------------------------------------------------------------

function view(
  items: ChatItem[],
  gate: ComposerGate,
  onSend: (text: string, mode: 'queue' | 'interrupt') => Promise<SendOutcome> = async () => ({ok: true}),
) {
  const props = {
    items,
    agentName: 'Claude Code',
    nameOf: () => '팀원',
    gate,
    onSend,
    renderPermission: () => null,
  };
  const out = render(<WorkConversationView {...props} />);
  return {
    ...out,
    update: (next: ChatItem[]) => out.rerender(<WorkConversationView {...props} items={next} />),
  };
}

const agentItem = (id: string, text: string): ChatItem => ({
  kind: 'agent',
  id,
  atMs: 1,
  seq: 1,
  text,
  streaming: false,
});

function scroll(offsetY: number, viewport: number, content: number, drag = false) {
  if (drag) fireEvent(screen.getByTestId('work-chat-scroll'), 'scrollBeginDrag');
  fireEvent.scroll(screen.getByTestId('work-chat-scroll'), {
    nativeEvent: {
      contentOffset: {x: 0, y: offsetY},
      layoutMeasurement: {width: 390, height: viewport},
      contentSize: {width: 390, height: content},
    },
  });
}

function grow(height: number) {
  fireEvent(screen.getByTestId('work-chat-scroll'), 'contentSizeChange', 390, height);
}

describe('자동 스크롤', () => {
  let spy: jest.SpyInstance;
  beforeEach(() => {
    spy = jest.spyOn(ScrollView.prototype as never, 'scrollToEnd');
  });
  afterEach(() => {
    spy.mockRestore();
    cleanup();
  });

  it('맨 아래에 있으면 새 답이 와도 맨 아래에 머문다', () => {
    const harness = view([agentItem('a', '하나')], {kind: 'none', notice: ENDED_NOTICE});
    grow(600); // 처음 자리 잡기
    spy.mockClear();
    scroll(200, 400, 600); // 맨 아래(200+400=600)
    harness.update([agentItem('a', '하나'), agentItem('b', '둘')]);
    grow(700);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('work-chat-unseen')).toBeNull();
  });

  it('위로 올려 읽는 중이면 멈추고 「새 답」 표지만 띄운다', () => {
    const harness = view([agentItem('a', '하나')], {kind: 'none', notice: ENDED_NOTICE});
    grow(600);
    spy.mockClear();
    scroll(0, 400, 600, true); // 손으로 맨 위로 올림
    harness.update([agentItem('a', '하나'), agentItem('b', '둘')]);
    grow(700);
    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByTestId('work-chat-unseen')).toBeTruthy();

    // 표지를 누르면 맨 아래로 가고 표지가 사라진다.
    fireEvent.press(screen.getByTestId('work-chat-unseen'));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('work-chat-unseen')).toBeNull();
  });

  it('우리가 일으킨 스크롤 도중의 오프셋은 따라가기를 끄지 못한다', () => {
    const harness = view([agentItem('a', '하나')], {kind: 'none', notice: ENDED_NOTICE});
    grow(600);
    spy.mockClear();
    scroll(100, 400, 600); // 손 없이: 애니메이션이 아직 아래에 못 닿은 중간 오프셋
    harness.update([agentItem('a', '하나'), agentItem('b', '둘')]);
    grow(700);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('work-chat-unseen')).toBeNull();
  });

  it('내가 보낸 말은 위에서 읽던 중이어도 보이게 따라간다', async () => {
    let resolve: (value: SendOutcome) => void = () => {};
    const harness = view(
      [agentItem('a', '하나')],
      {kind: 'ready'},
      () => new Promise<SendOutcome>(done => (resolve = done)),
    );
    grow(600);
    scroll(0, 400, 600, true);
    spy.mockClear();
    fireEvent.changeText(screen.getByTestId('work-chat-input'), '내 지시');
    act(() => {
      fireEvent.press(screen.getByTestId('work-chat-send'));
    });
    harness.update([agentItem('a', '하나'), agentItem('b', '둘')]);
    grow(700);
    expect(spy).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ok: true}));
  });
});

describe('입력창', () => {
  afterEach(() => {
    cleanup();
    jest.mocked(haptics.light).mockClear();
  });

  it('보내면 입력이 비고, 햅틱은 보내기 탭에서 한 번이다', async () => {
    const onSend = jest.fn(async () => ({ok: true}) as SendOutcome);
    view([], {kind: 'ready'}, onSend);
    fireEvent.changeText(screen.getByTestId('work-chat-input'), '  이거 고쳐 줘 ');
    await act(async () => {
      fireEvent.press(screen.getByTestId('work-chat-send'));
    });
    expect(haptics.light).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('이거 고쳐 줘', 'queue');
    expect(screen.getByTestId('work-chat-input').props.value).toBe('');
    // 보낼 글이 없으면 눌러도 아무 일이 없다.
    fireEvent.press(screen.getByTestId('work-chat-send'));
    expect(haptics.light).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('끼어들기를 켜고 보내면 interrupt로 가고, 보낸 뒤 꺼진다', async () => {
    const onSend = jest.fn(async () => ({ok: true}) as SendOutcome);
    view([], {kind: 'ready'}, onSend);
    fireEvent.press(screen.getByTestId('work-chat-interrupt'));
    fireEvent.changeText(screen.getByTestId('work-chat-input'), '멈추고 이것부터');
    await act(async () => {
      fireEvent.press(screen.getByTestId('work-chat-send'));
    });
    expect(onSend).toHaveBeenCalledWith('멈추고 이것부터', 'interrupt');
    expect(screen.getByTestId('work-chat-interrupt').props.accessibilityState.checked).toBe(false);
  });

  it('전달에 실패하면 글이 입력창으로 돌아오고 이유가 나온다', async () => {
    const onSend = jest.fn(
      async () => ({ok: false, text: '전달 안 됨 · 맥이 꺼져 있어요'}) as SendOutcome,
    );
    view([], {kind: 'ready'}, onSend);
    fireEvent.changeText(screen.getByTestId('work-chat-input'), '꼭 전해야 하는 말');
    await act(async () => {
      fireEvent.press(screen.getByTestId('work-chat-send'));
    });
    expect(screen.getByTestId('work-chat-input').props.value).toBe('꼭 전해야 하는 말');
    expect(screen.getByTestId('work-chat-failure')).toHaveTextContent('전달 안 됨 · 맥이 꺼져 있어요');
  });

  it('서명 요구가 꺼진 동안은 안내가 나오고 입력도 보내기도 막힌다', () => {
    const onSend = jest.fn(async () => ({ok: true}) as SendOutcome);
    view([], {kind: 'closed', notice: SIGNING_OFF_NOTICE}, onSend);
    expect(screen.getByTestId('work-chat-notice')).toHaveTextContent(SIGNING_OFF_NOTICE);
    expect(screen.getByTestId('work-chat-input').props.editable).toBe(false);
    fireEvent.press(screen.getByTestId('work-chat-send'));
    expect(onSend).not.toHaveBeenCalled();
    expect(haptics.light).not.toHaveBeenCalled();
  });

  it('열려 있을 때는 그 안내가 나오지 않는다', () => {
    view([], {kind: 'ready'});
    expect(screen.queryByTestId('work-chat-notice')).toBeNull();
    expect(screen.queryByText(SIGNING_OFF_NOTICE)).toBeNull();
  });

  it('답이 도착하거나 목록이 바뀌어도 햅틱은 부르지 않는다', () => {
    const harness = view([agentItem('a', '하나')], {kind: 'ready'});
    harness.update([agentItem('a', '하나'), agentItem('b', '둘')]);
    expect(haptics.light).not.toHaveBeenCalled();
    expect(haptics.selection).not.toHaveBeenCalled();
  });
});
