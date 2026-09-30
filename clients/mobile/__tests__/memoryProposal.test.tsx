import {ApiError} from '@momo/core/lib/api';
import type {Message, RosterMember} from '@momo/core/lib/api';
import type {MemoryProposal} from '@momo/core/features/memory/model';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
import React from 'react';

import {MessageRow} from '../src/features/conversation/MessageRow';
import * as copy from '../src/features/memory/copy';
import {MemoryProposalCard} from '../src/features/memory/MemoryProposalCard';
import {proposalErrorOutcome, proposalView} from '../src/features/memory/model';

// =============================================================================
// #3171 MEM-M2 폰 — 「기억해 둘게요」 제안 카드의 상태·게스트 읽기 전용·자기 수락 경고·
// 오류 갈래. 서버 호출은 코어 클라이언트 함수의 호출 인자로 잰다.
// =============================================================================

const mockList = jest.fn<Promise<MemoryProposal[]>, [string, string, Record<string, unknown>]>();
const mockAccept = jest.fn<Promise<MemoryProposal>, [string, string]>();
const mockReject = jest.fn<Promise<MemoryProposal>, [string, string]>();
const mockFetchMessages = jest.fn();

jest.mock('@momo/core/features/memory/api', () => ({
  listMemoryProposals: (ws: string, ch: string, options: Record<string, unknown>) =>
    mockList(ws, ch, options),
  acceptMemoryProposal: (ws: string, id: string) => mockAccept(ws, id),
  rejectMemoryProposal: (ws: string, id: string) => mockReject(ws, id),
  getRunMemoryReceipt: async () => {
    const actual = jest.requireActual('@momo/core/lib/api');
    throw new actual.ApiError(404, 'none');
  },
  listMemoryDigests: async () => ({digests: []}),
  getMemorySettings: async () => ({
    workspace: {enabled: true, paused: false, resetEpoch: 0},
    channels: [],
    me: {paused: false},
  }),
  patchMyMemorySettings: async () => ({paused: false}),
}));

jest.mock('@momo/core/lib/api', () => ({
  ...jest.requireActual('@momo/core/lib/api'),
  fetchMessages: (...args: unknown[]) => mockFetchMessages(...args),
}));

const WS = 'ws-1';
const CH = 'cccccccc-1111-4111-8111-cccccccccccc';
const AGENT = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const SELF = '11111111-1111-4111-8111-111111111111';
const BOB = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const NOW = 1_700_000_100_000;

function rosterMember(over: Partial<RosterMember> & {id: string}): RosterMember {
  return {
    workspaceId: WS, kind: 'human', status: 'active', displayName: '이름', handle: 'h',
    channelCount: 0, channelIds: [], capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...over,
  } as RosterMember;
}
function directoryOf(selfRole: RosterMember['role']) {
  return makeDirectory([
    rosterMember({id: SELF, displayName: '곽성재', handle: 'seongjae', role: selfRole}),
    rosterMember({id: BOB, displayName: '밥', handle: 'bob'}),
    rosterMember({id: AGENT, kind: 'agent', displayName: '김인턴', handle: 'intern'}),
  ]);
}

function proposal(over: Partial<MemoryProposal> = {}): MemoryProposal {
  return {
    id: 'p-1',
    channelId: CH,
    runId: 'run-1',
    agentMemberId: AGENT,
    requesterMemberId: BOB,
    kind: 'decision',
    status: 'pending',
    text: '배포는 매주 금요일 오후에 해요.',
    evidenceMessageIds: ['m-41'],
    evidence: [{messageId: 'm-41', seq: 41, authorMemberId: BOB}],
    callerIsRequester: false,
    createdAtMs: NOW - 1000,
    expiresAtMs: NOW + 86_400_000,
    ...over,
  };
}

function sourceMessage(over: Partial<Message> = {}): Message {
  return {
    id: 'm-41', channelId: CH, seq: 41, hlcTs: 41, hlcCount: 0, authorMemberId: BOB,
    type: 'text', body: '이번 주부터 금요일 오후 배포로 가요.', state: 'sent',
    createdAtMs: NOW - 5000, ...over,
  } as Message;
}

function mount(
  p: MemoryProposal,
  opts: {role?: RosterMember['role']; onOpenEvidence?: jest.Mock} = {},
) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {retry: false, gcTime: Infinity},
      mutations: {retry: false, gcTime: Infinity},
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryProposalCard
        proposal={p}
        workspaceId={WS}
        directory={directoryOf(opts.role)}
        role={opts.role}
        nowMs={NOW}
        onOpenEvidence={opts.onOpenEvidence}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockList.mockReset();
  mockAccept.mockReset();
  mockReject.mockReset();
  mockFetchMessages.mockReset();
  mockFetchMessages.mockResolvedValue({messages: [sourceMessage()]});
});
afterEach(cleanup);

const decided = (status: 'accepted' | 'rejected'): MemoryProposal => ({
  ...proposal({status, evidence: [], evidenceMessageIds: []}),
  text: undefined,
});

describe('제안 카드 — 순수 판정(proposalView)', () => {
  const base = {
    proposal: {status: 'pending', callerIsRequester: false, expiresAtMs: NOW + 1} as const,
    role: 'member' as const,
    outcome: 'none' as const,
    failed: false,
    nowMs: NOW,
  };
  it('처음은 결정 가능, 자기 제안이면 경고가 붙는다', () => {
    expect(proposalView(base)).toEqual({kind: 'pending', selfWarning: false, failed: false});
    expect(
      proposalView({...base, proposal: {...base.proposal, callerIsRequester: true}}),
    ).toMatchObject({kind: 'pending', selfWarning: true});
  });
  it('게스트는 읽기 전용, 결정 결과가 있어도 게스트가 우선하지 않는다(이미 정해진 것은 말한다)', () => {
    expect(proposalView({...base, role: 'guest'})).toEqual({kind: 'readOnly', cause: 'guest'});
    expect(proposalView({...base, role: 'guest', outcome: 'accepted'})).toEqual({kind: 'accepted'});
  });
  it('기한이 지나면 닫힘(expired)', () => {
    expect(
      proposalView({...base, proposal: {...base.proposal, expiresAtMs: NOW}}),
    ).toEqual({kind: 'stale', cause: 'expired'});
  });
  it('오류 응답은 409=닫힘 · 403=권한 없음 · 그 밖은 실패', () => {
    expect(proposalErrorOutcome(new ApiError(409, 'x'))).toBe('closed');
    expect(proposalErrorOutcome(new ApiError(403, 'x'))).toBe('forbidden');
    expect(proposalErrorOutcome(new ApiError(500, 'x'))).toBe('failed');
    expect(proposalErrorOutcome(new Error('offline'))).toBe('failed');
  });
});

describe('제안 카드 — 화면', () => {
  it('대기: 본문·종류·근거(작성자와 원문)와 두 버튼', async () => {
    mount(proposal());
    expect(screen.getByText(copy.PROPOSAL_TITLE)).toBeTruthy();
    expect(screen.getByText(copy.PROPOSAL_KIND_LABEL.decision)).toBeTruthy();
    expect(screen.getByText('배포는 매주 금요일 오후에 해요.')).toBeTruthy();
    expect(screen.getByText('밥 · #41')).toBeTruthy();
    expect(screen.getByText(copy.PROPOSAL_EVIDENCE_LOADING)).toBeTruthy();
    await waitFor(() => expect(screen.getByText('이번 주부터 금요일 오후 배포로 가요.')).toBeTruthy());
    // 정상 읽기 길: seq 바로 앞을 기준으로 1건.
    expect(mockFetchMessages).toHaveBeenCalledWith(WS, CH, {after: 40, limit: 1});
    expect(screen.getByTestId('memory-proposal-accept')).toBeTruthy();
    expect(screen.getByTestId('memory-proposal-reject')).toBeTruthy();
    expect(screen.queryByTestId('memory-proposal-self-warning')).toBeNull();
  });

  it('근거를 누르면 그 메시지로 데려간다', async () => {
    const onOpenEvidence = jest.fn();
    mount(proposal(), {onOpenEvidence});
    fireEvent.press(screen.getByTestId('memory-proposal-evidence-41'));
    expect(onOpenEvidence).toHaveBeenCalledWith({messageId: 'm-41', channelId: CH, seq: 41});
    await waitFor(() => expect(mockFetchMessages).toHaveBeenCalled());
  });

  it('원문을 못 읽거나 다른 메시지가 오면 줄은 남기고 원문 자리에 이유를 쓴다', async () => {
    mockFetchMessages.mockResolvedValue({messages: [sourceMessage({id: 'other'})]});
    mount(proposal());
    await waitFor(() => expect(screen.getByText(copy.PROPOSAL_EVIDENCE_UNREADABLE)).toBeTruthy());
    expect(screen.getByText('밥 · #41')).toBeTruthy();
  });

  it('수락: 서버에 보내고 「기억해 뒀어요」와 데스크탑 안내로 바뀐다', async () => {
    mockAccept.mockResolvedValue(decided('accepted'));
    mount(proposal());
    fireEvent.press(screen.getByTestId('memory-proposal-accept'));
    await waitFor(() => expect(screen.getByTestId('memory-proposal-accepted')).toBeTruthy());
    expect(mockAccept).toHaveBeenCalledWith(WS, 'p-1');
    expect(mockReject).not.toHaveBeenCalled();
    expect(screen.getByText(copy.PROPOSAL_ACCEPTED)).toBeTruthy();
    expect(screen.getByText(copy.PROPOSAL_DESKTOP_HINT)).toBeTruthy();
    expect(screen.queryByTestId('memory-proposal-accept')).toBeNull();
    expect(screen.queryByTestId('memory-proposal-evidence')).toBeNull();
  });

  it('거절: 「기억하지 않기로 했어요」', async () => {
    mockReject.mockResolvedValue(decided('rejected'));
    mount(proposal());
    fireEvent.press(screen.getByTestId('memory-proposal-reject'));
    await waitFor(() => expect(screen.getByTestId('memory-proposal-rejected')).toBeTruthy());
    expect(mockReject).toHaveBeenCalledWith(WS, 'p-1');
    expect(mockAccept).not.toHaveBeenCalled();
    expect(screen.getByText(copy.PROPOSAL_REJECTED)).toBeTruthy();
    expect(screen.queryByText(copy.PROPOSAL_DESKTOP_HINT)).toBeNull();
  });

  it('처리 중에는 버튼이 사라지고 요청은 한 번만 나간다', async () => {
    let finish: (value: MemoryProposal) => void = () => {};
    mockAccept.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    mount(proposal());
    fireEvent.press(screen.getByTestId('memory-proposal-accept'));
    await waitFor(() => expect(screen.getByTestId('memory-proposal-busy')).toBeTruthy());
    expect(screen.queryByTestId('memory-proposal-accept')).toBeNull();
    expect(mockAccept).toHaveBeenCalledTimes(1);
    await act(async () => finish(decided('accepted')));
    await waitFor(() => expect(screen.getByTestId('memory-proposal-accepted')).toBeTruthy());
  });

  it('409(다른 곳에서 정해짐·기한·근거 변경)는 닫힘 문장이고 버튼이 없다', async () => {
    mockAccept.mockRejectedValue(new ApiError(409, 'decided'));
    mount(proposal());
    fireEvent.press(screen.getByTestId('memory-proposal-accept'));
    await waitFor(() => expect(screen.getByTestId('memory-proposal-stale')).toBeTruthy());
    expect(screen.getByText(copy.PROPOSAL_STALE)).toBeTruthy();
    expect(screen.queryByTestId('memory-proposal-accept')).toBeNull();
    expect(screen.queryByTestId('memory-proposal-error')).toBeNull();
  });

  it('기한이 이미 지난 제안은 누르기 전에 닫힌 채로 나온다', () => {
    mount(proposal({expiresAtMs: NOW - 1}));
    expect(screen.getByText(copy.PROPOSAL_EXPIRED)).toBeTruthy();
    expect(screen.queryByTestId('memory-proposal-accept')).toBeNull();
  });

  it('403은 읽기 전용(권한 없음) 문장이다', async () => {
    mockReject.mockRejectedValue(new ApiError(403, 'no'));
    mount(proposal());
    fireEvent.press(screen.getByTestId('memory-proposal-reject'));
    await waitFor(() => expect(screen.getByTestId('memory-proposal-readonly')).toBeTruthy());
    expect(screen.getByText(copy.PROPOSAL_FORBIDDEN)).toBeTruthy();
    expect(screen.queryByTestId('memory-proposal-accept')).toBeNull();
  });

  it('네트워크 오류는 카드를 그대로 두고 다시 누를 수 있게 한다', async () => {
    mockAccept.mockRejectedValueOnce(new Error('offline'));
    mockAccept.mockResolvedValueOnce(decided('accepted'));
    mount(proposal());
    fireEvent.press(screen.getByTestId('memory-proposal-accept'));
    await waitFor(() => expect(screen.getByTestId('memory-proposal-error')).toBeTruthy());
    expect(screen.getByText(copy.PROPOSAL_FAILED)).toBeTruthy();
    fireEvent.press(screen.getByTestId('memory-proposal-accept'));
    await waitFor(() => expect(screen.getByTestId('memory-proposal-accepted')).toBeTruthy());
    expect(screen.queryByTestId('memory-proposal-error')).toBeNull();
  });

  it('내 질문에서 나온 제안은 경고를 보이지만 버튼은 살아 있다', () => {
    mount(proposal({callerIsRequester: true}));
    expect(screen.getByTestId('memory-proposal-self-warning')).toBeTruthy();
    expect(screen.getByText(copy.PROPOSAL_SELF_WARNING)).toBeTruthy();
    expect(screen.getByTestId('memory-proposal-accept')).toBeTruthy();
  });

  it('게스트는 읽기만 한다: 이유를 말하고 버튼도 요청도 없다', async () => {
    mount(proposal({callerIsRequester: true}), {role: 'guest'});
    expect(screen.getByTestId('memory-proposal-readonly')).toBeTruthy();
    expect(screen.getByText(copy.PROPOSAL_GUEST)).toBeTruthy();
    expect(screen.queryByTestId('memory-proposal-accept')).toBeNull();
    expect(screen.queryByTestId('memory-proposal-reject')).toBeNull();
    expect(screen.queryByTestId('memory-proposal-self-warning')).toBeNull();
    // 근거는 게스트도 읽는다.
    expect(screen.getByText('밥 · #41')).toBeTruthy();
    await waitFor(() => expect(mockFetchMessages).toHaveBeenCalled());
    expect(mockAccept).not.toHaveBeenCalled();
  });
});

describe('에이전트 답 행에 제안이 붙는 자리', () => {
  function row(message: Message, role: RosterMember['role'] = 'member') {
    const client = new QueryClient({
      defaultOptions: {queries: {retry: false, gcTime: Infinity}},
    });
    return render(
      <QueryClientProvider client={client}>
        <MessageRow
          message={message}
          startsGroup
          directory={directoryOf(role)}
          chips={[]}
          nowMs={NOW}
          actions={{
            myMemberId: SELF,
            onToggleReaction: async () => {},
            onEdit: async () => {},
            onDelete: async () => {},
            workspaceId: WS,
          }}
        />
      </QueryClientProvider>,
    );
  }
  const turn = (over: Partial<Message> = {}): Message =>
    ({
      id: 'msg-turn', channelId: CH, seq: 50, hlcTs: 50, hlcCount: 0, authorMemberId: AGENT,
      type: 'text', body: '정리했어요.', state: 'sent', createdAtMs: NOW - 1000,
      props: {schema: 'momo.agent_gateway.timeline.v0', run_id: 'RUN-1'},
      ...over,
    }) as Message;

  it('run id 로 이 채널의 대기 제안을 읽어 카드를 단다', async () => {
    mockList.mockResolvedValue([proposal()]);
    row(turn());
    await waitFor(() => expect(screen.getByTestId('memory-proposal')).toBeTruthy());
    expect(mockList).toHaveBeenCalledWith(WS, CH, {runId: 'run-1', status: 'pending', limit: 5});
  });

  it('제안이 없거나 읽지 못하면 아무것도 그리지 않는다', async () => {
    mockList.mockRejectedValue(new Error('down'));
    row(turn());
    await waitFor(() => expect(mockList).toHaveBeenCalled());
    expect(screen.queryByTestId('memory-proposals')).toBeNull();
  });

  it('로스터에서 게스트인 사람에게는 읽기 전용으로 붙는다', async () => {
    mockList.mockResolvedValue([proposal()]);
    row(turn(), 'guest');
    await waitFor(() => expect(screen.getByTestId('memory-proposal-readonly')).toBeTruthy());
    expect(screen.queryByTestId('memory-proposal-accept')).toBeNull();
  });

  it('지워진 답에는 묻지도 않는다', async () => {
    mockList.mockResolvedValue([proposal()]);
    row(turn({state: 'deleted', body: undefined}));
    expect(mockList).not.toHaveBeenCalled();
  });
});
