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
import {StyleSheet} from 'react-native';

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
