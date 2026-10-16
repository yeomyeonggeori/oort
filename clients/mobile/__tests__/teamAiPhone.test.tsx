import type {Member, Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react-native';
import React from 'react';
import {AccessibilityInfo, StyleSheet} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {
  MessageRow,
  type MessageRowActions,
} from '../src/features/conversation/MessageRow';
import {SessionProvider} from '../src/session/useSession';

// =============================================================================
// ADR-0201 (#3836) 폰: 도우미 승인 카드의 제안자 표기, 넘기는 줄의 「○○에게 맡기기」.
// 픽스처는 서버(PR #3837 `propose_in_tx` · `fallback_props`)가 싣는 모양 그대로이고,
// 웹 `clients/web/src/features/timeline/teamAi.test.tsx` 와 같은 글자다.
// =============================================================================

const mockSend = jest.fn();
jest.mock('@momo/core/lib/api', () => {
  const actual = jest.requireActual('@momo/core/lib/api');
  return {...actual, sendMessage: (...args: unknown[]) => mockSend(...args)};
});

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '11111111-1111-4111-8111-1111111111aa';
const HELPER = 'cccccccc-1111-4111-8111-cccccccccc01';
const GROK = 'cccccccc-1111-4111-8111-cccccccccc02';
const SOURCE = '0199aa11-2222-7000-8000-0000000004a1';
const CH = 'ch-general';
const KEY = '0e5fa1d0-c0de-5201-9d00-7e4a11a12023';
const BASE_MS = 1_760_000_000_000;

function rosterMember(
  id: string,
  kind: 'human' | 'agent',
  displayName: string,
  handle: string,
): RosterMember {
  return {
    id,
    workspaceId: WS,
    kind,
    status: 'active',
    displayName,
    handle,
    channelCount: 1,
    channelIds: [CH],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  } as RosterMember;
}

const DIRECTORY = makeDirectory([
  rosterMember(SELF_ID, 'human', '곽성재', 'seongjae'),
  rosterMember(OTHER_ID, 'human', '김하늘', 'haneul'),
  rosterMember(HELPER, 'agent', 'oort 도우미', 'oort-helper'),
  rosterMember(GROK, 'agent', '그록봇', 'grokbot'),
]);
const ME: Member = {
  id: SELF_ID,
  workspaceId: WS,
  kind: 'human',
  displayName: '곽성재',
  handle: 'seongjae',
};

function message(over: Partial<Message>): Message {
  return {
    id: '0199aa11-2222-7000-8000-0000000004b1',
    channelId: CH,
    seq: 10,
    hlcTs: 10,
    hlcCount: 0,
    authorMemberId: HELPER,
    type: 'text',
    body: null,
    state: 'sent',
    createdAtMs: BASE_MS,
    ...over,
  } as unknown as Message;
}

function approvalProps(withVia: boolean): Record<string, unknown> {
  return {
    approval_id: '0199aa11-2222-7000-8000-0000000005a1',
    action_type: 'workspace_action',
    status: 'pending',
    title: '채널 만들기',
    action: {
      id: 'channel.create',
      rows: [{label: '채널 이름', value: 'ideas'}],
      rationale: '아이디어 채널을 만들어 달라고 했어요',
      required_role: 'member',
    },
    ...(withVia
      ? {
          proposed_via: {
            kind: 'team_ai',
            requester_id: OTHER_ID,
            requester_name: '서버가 쓴 이름',
          },
        }
      : {}),
  };
}

const DELEGATE_PROPS = {
  source: 'team_ai_fallback',
  kind: 'team_ai.delegate.v1',
  reason: 'over_budget',
  agent_member_id: HELPER,
  notice_for_member_id: SELF_ID,
  run_id: '0199aa11-2222-7000-8000-0000000006a1',
  delegate: {
    source_message_id: SOURCE,
    candidates: [
      {member_id: GROK, handle: 'grokbot', display_name: '그록봇', client_msg_id: KEY},
    ],
  },
};

function actionsFor(myMemberId: string): MessageRowActions {
  return {
    myMemberId,
    workspaceId: WS,
    onToggleReaction: async () => {},
    onEdit: async () => {},
    onDelete: async () => {},
  };
}

function renderRow(msg: Message, actions?: MessageRowActions) {
  const client = new QueryClient({defaultOptions: {queries: {retry: false, gcTime: 0}}});
  return render(
    <QueryClientProvider client={client}>
      <SessionProvider member={ME}>
        <MessageRow
          message={msg}
          startsGroup
          directory={DIRECTORY}
          chips={[]}
          nowMs={BASE_MS}
          approvalsProvided
          {...(actions !== undefined ? {actions} : {})}
        />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockSend.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('도우미 승인 카드 (폰)', () => {
  it('누가 부탁했는지와 사유가 AI 글이라는 것을 말한다', () => {
    renderRow(message({type: 'approval_request', props: approvalProps(true)}));
    const row = screen.getByTestId('approval-team-ai');
    expect(within(row).getByText('도우미 제안 · 요청: 김하늘')).toBeTruthy();
    expect(within(row).getByText('승인하면 승인한 사람의 권한으로 실행돼요.')).toBeTruthy();
    const rationale = screen.getByTestId('approval-action-rationale');
    expect(within(rationale).getByText('도우미가 쓴 사유')).toBeTruthy();
    expect(screen.getByTestId('approval-action-rationale-note')).toBeTruthy();
  });

  it('값과 아래 한 줄이 함께 설 때 값이 높이 0 으로 접히지 않는다', () => {
    // 세로 상자 안의 `flex: 1` 은 flexBasis 0 이라 높이가 0 이 된다. 시뮬레이터 캡처에서
    // 「도우미 제안 · 요청」과 사유 본문이 사라졌던 결함(#3836)의 회귀 시험이다.
    renderRow(message({type: 'approval_request', props: approvalProps(true)}));
    for (const id of ['approval-team-ai-value', 'approval-action-rationale-value']) {
      const style = StyleSheet.flatten(screen.getByTestId(id).props.style) as {flex?: number};
      expect(style.flex ?? 0).toBe(0);
    }
  });

  it('도우미가 아닌 카드는 그대로다', () => {
    renderRow(message({type: 'approval_request', props: approvalProps(false)}));
    expect(screen.queryByTestId('approval-team-ai')).toBeNull();
    expect(within(screen.getByTestId('approval-action-rationale')).getByText('사유')).toBeTruthy();
    expect(screen.queryByTestId('approval-action-rationale-note')).toBeNull();
  });
});

describe('「그록봇에게 맡기기」 (폰)', () => {
  const delegateMessage = () =>
    message({
      body: '오늘 팀 AI 사용량을 다 썼어요. 다른 에이전트에게 맡길 수 있어요.',
      props: DELEGATE_PROPS,
      replyToId: SOURCE,
      replyTo: {
        id: SOURCE,
        seq: 9,
        authorMemberId: SELF_ID,
        type: 'text',
        body: '@oort-helper 프로필 소개를 바꿔 줘',
        state: 'sent',
      },
    } as Partial<Message>);

  it('요청자가 누르면 도우미 멘션을 뺀 원래 요청을 서버가 정한 키로 보낸다', async () => {
    mockSend.mockResolvedValue({});
    renderRow(delegateMessage(), actionsFor(SELF_ID));
    expect(screen.getByText('넘긴 이유: 오늘 도우미 사용량을 다 씀')).toBeTruthy();
    const button = screen.getByTestId('team-ai-delegate-button');
    expect(within(button).getByText('그록봇에게 맡기기')).toBeTruthy();
    await act(async () => {
      fireEvent.press(button);
    });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith(WS, CH, KEY, '@grokbot 프로필 소개를 바꿔 줘', {
      replyToId: SOURCE,
    });
    expect(screen.getByTestId('team-ai-delegate-sent')).toBeTruthy();
  });

  // #3844 design-review H-1: 행은 접근성 원소 하나라 띠의 버튼에 VoiceOver 가 닿지 못한다.
  // 그래서 같은 행동을 로터에 등재하고, 띠의 글을 행 라벨로 읽고, 결과를 소리로 말한다.
  it('VoiceOver 로터에서도 맡길 수 있고, 결과를 소리로 말한다', async () => {
    mockSend.mockResolvedValue({});
    const announce = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibility')
      .mockImplementation(() => {});
    renderRow(delegateMessage(), actionsFor(SELF_ID));
    const row = screen.getByTestId('message-row');
    expect(row.props.accessibilityLabel).toContain('넘긴 이유: 오늘 도우미 사용량을 다 씀');
    const actions = (row.props.accessibilityActions ?? []) as {name: string; label: string}[];
    const delegateAction = actions.find(action => action.label === '그록봇에게 맡기기');
    expect(delegateAction).toBeDefined();
    await act(async () => {
      fireEvent(row, 'accessibilityAction', {
        nativeEvent: {actionName: delegateAction?.name},
      });
    });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith(WS, CH, KEY, '@grokbot 프로필 소개를 바꿔 줘', {
      replyToId: SOURCE,
    });
    expect(announce).toHaveBeenCalledWith('그록봇에게 맡겼어요. 답은 이 채널에 와요.');
    const after = screen.getByTestId('message-row');
    expect(after.props.accessibilityLabel).toContain('그록봇에게 맡겼어요.');
    // 보낸 뒤에는 로터에서도 사라진다(띠의 버튼과 같은 조건).
    const afterActions = (after.props.accessibilityActions ?? []) as {label: string}[];
    expect(afterActions.some(action => action.label === '그록봇에게 맡기기')).toBe(false);
    announce.mockRestore();
  });

  it('요청자가 아니면 로터에도 맡기기가 없다', () => {
    renderRow(delegateMessage(), actionsFor(OTHER_ID));
    const actions = (screen.getByTestId('message-row').props.accessibilityActions ??
      []) as {label: string}[];
    expect(actions.some(action => action.label.endsWith('맡기기'))).toBe(false);
  });

  it('요청자가 아니면 버튼이 없다', () => {
    renderRow(delegateMessage(), actionsFor(OTHER_ID));
    expect(screen.queryByTestId('team-ai-delegate-button')).toBeNull();
    expect(screen.getByTestId('team-ai-delegate-reason')).toBeTruthy();
  });

  it('이 키를 모르는 줄에는 아무 것도 서지 않는다', () => {
    renderRow(message({body: '안녕하세요', props: {source: 'team_ai'}}), actionsFor(SELF_ID));
    expect(screen.queryByTestId('team-ai-delegate')).toBeNull();
  });
});

// ADR-0201 증보 v2 (#3893): 도우미 답의 꼬리와 새 설정 카드 — 웹 `teamAi.test.tsx` 와 같은 픽스처.
const V2_REPLY = {
  source: 'team_ai',
  run_id: '0199aa11-2222-7000-8000-0000000006b1',
  model_label: 'Claude Sonnet 4.5',
  tools_used: [
    {name: 'search_messages'},
    {name: 'read_channel', channel: '마케팅'},
    {name: 'web_search'},
  ],
  web_citations: [
    {url: 'https://www.example.com/rust-2026', title: 'Rust 2026 로드맵'},
    {url: 'javascript:alert(1)', title: '나쁜 주소'},
  ],
};

describe('도우미 답의 꼬리 (폰, v2)', () => {
  it('찾아본 것 · 모델 칩 · 출처를 그리고, 행 낭독과 로터에도 싣는다', () => {
    const {Linking} = require('react-native');
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    renderRow(
      message({body: '지난주 마케팅 채널에서 정한 건 세 가지예요.', props: V2_REPLY}),
      actionsFor(SELF_ID),
    );
    expect(screen.getByTestId('team-ai-tools-line')).toHaveTextContent(
      '찾아본 것: 메시지 검색 · #마케팅 읽기 · 웹 검색',
    );
    expect(screen.getByTestId('team-ai-model-chip')).toHaveTextContent('팀 AI · Claude Sonnet 4.5');
    expect(screen.getAllByTestId('team-ai-citation')).toHaveLength(1);

    const row = screen.getByTestId('message-row');
    expect(row.props.accessibilityLabel).toContain('찾아본 것: 메시지 검색, #마케팅 읽기, 웹 검색');
    expect(row.props.accessibilityLabel).toContain('출처 1개');
    const actions = (row.props.accessibilityActions ?? []) as {name: string; label: string}[];
    const source = actions.find(action => action.label.startsWith('출처 1 열기'));
    expect(source?.label).toBe('출처 1 열기, Rust 2026 로드맵');
    act(() => {
      fireEvent(row, 'accessibilityAction', {nativeEvent: {actionName: source?.name}});
    });
    expect(open).toHaveBeenCalledWith('https://www.example.com/rust-2026');
    open.mockRestore();
  });

  it('칸이 없는 도우미 답(옛 서버)에는 꼬리도 로터 행동도 없다', () => {
    renderRow(message({body: '안녕하세요', props: {source: 'team_ai', run_id: 'r'}}), actionsFor(SELF_ID));
    expect(screen.queryByTestId('team-ai-reply-meta')).toBeNull();
    const actions = (screen.getByTestId('message-row').props.accessibilityActions ??
      []) as {label: string}[];
    expect(actions.some(action => action.label.startsWith('출처'))).toBe(false);
  });

  it('설정 액션 카드는 「적용 범위: 워크스페이스 전체」를 말한다', () => {
    renderRow(
      message({
        type: 'approval_request',
        props: {
          ...approvalProps(true),
          title: '링크 미리보기 끄기',
          action: {
            id: 'workspace.unfurl.update',
            rows: [{label: '링크 미리보기', value: '켜짐 → 꺼짐'}],
            rationale: '링크 카드가 너무 커서 꺼 달라고 했어요',
            required_role: 'workspace_operator',
          },
        },
      }),
    );
    const wide = screen.getByTestId('approval-workspace-wide');
    expect(within(wide).getByText('적용 범위')).toBeTruthy();
    expect(within(wide).getByText('워크스페이스 전체')).toBeTruthy();
    expect(within(wide).getByText('승인하면 모든 멤버에게 바로 적용돼요.')).toBeTruthy();
  });
});
