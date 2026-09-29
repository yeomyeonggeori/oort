import {ApiError} from '@momo/core/lib/api';
import type {Message, RosterMember} from '@momo/core/lib/api';
import type {
  MemoryDigest,
  MemoryDigestPage,
  MemoryReceipt,
  MemorySettings,
} from '@momo/core/features/memory/model';
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

import * as copy from '../src/features/memory/copy';
import {MemoryPauseSection} from '../src/features/memory/MemoryPauseSection';
import {MemoryReceiptChip} from '../src/features/memory/MemoryReceiptChip';
import {
  MissedDigestCard,
  MissedDigestCardView,
} from '../src/features/memory/MissedDigestCard';
import {MISSED_MIN_UNREAD} from '../src/features/memory/model';
import {MessageRow} from '../src/features/conversation/MessageRow';
import {jumpMissedNotice} from '../src/features/conversation/jumpNotice';

// =============================================================================
// #3166 MEM-M1 폰 — 요약 카드·칩·시트·일시정지가 실제로 그려지고 서버에 무엇을 보내는가.
// 서버 계약(`sinceSeq`만 보내고 `sinceLastRead`는 보내지 않는다 등)은 코어 클라이언트
// 함수의 호출 인자로 잰다.
// =============================================================================

const mockList = jest.fn<Promise<MemoryDigestPage>, [string, string, Record<string, unknown>]>();
const mockSettings = jest.fn<Promise<MemorySettings>, [string]>();
const mockReceipt = jest.fn<Promise<MemoryReceipt>, [string, string]>();
const mockPatchMe = jest.fn<Promise<{paused: boolean}>, [string, boolean]>();

jest.mock('@momo/core/features/memory/api', () => ({
  listMemoryDigests: (ws: string, ch: string, options: Record<string, unknown>) =>
    mockList(ws, ch, options),
  getMemorySettings: (ws: string) => mockSettings(ws),
  getRunMemoryReceipt: (ws: string, run: string) => mockReceipt(ws, run),
  patchMyMemorySettings: (ws: string, paused: boolean) => mockPatchMe(ws, paused),
}));

const WS = 'ws-1';
const CH = 'cccccccc-1111-4111-8111-cccccccccccc';

function digest(over: Partial<MemoryDigest> = {}): MemoryDigest {
  return {
    id: 'd-1',
    channelId: CH,
    level: 'window',
    fromSeq: 11,
    toSeq: 20,
    body: '- 배포 일정이 금요일로 정해졌어요.\n- 롤백 절차는 그대로 가요.',
    sourceCount: 10,
    createdAtMs: 1_700_000_000_000,
    evidence: [
      {messageId: 'm-15', channelId: CH, seq: 15},
      {messageId: 'm-18', channelId: CH, seq: 18},
    ],
    ...over,
  };
}

const SETTINGS: MemorySettings = {
  workspace: {enabled: true, paused: false, resetEpoch: 0},
  channels: [],
  me: {paused: false},
};

function withClient(node: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {retry: false, gcTime: Infinity},
      mutations: {retry: false, gcTime: Infinity},
    },
  });
  return {
    client,
    ui: <QueryClientProvider client={client}>{node}</QueryClientProvider>,
  };
}

beforeEach(() => {
  mockList.mockReset();
  mockSettings.mockReset();
  mockReceipt.mockReset();
  mockPatchMe.mockReset();
  mockSettings.mockResolvedValue(SETTINGS);
});
afterEach(cleanup);

const noop = () => {};

describe('요약 카드 — 화면', () => {
  const view = (state: React.ComponentProps<typeof MissedDigestCardView>['state'], extra = {}) =>
    render(<MissedDigestCardView state={state} onDismiss={noop} {...extra} />);

  it('로딩', () => {
    view({kind: 'loading'});
    expect(screen.getByTestId('missed-digest-loading')).toBeTruthy();
    expect(screen.getByText(copy.MISSED_LOADING)).toBeTruthy();
  });

  it('오류는 다시 시도를 준다', () => {
    const onRetry = jest.fn();
    view({kind: 'error'}, {onRetry});
    expect(screen.getByText(copy.MISSED_ERROR)).toBeTruthy();
    fireEvent.press(screen.getByTestId('missed-digest-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it.each(Object.entries(copy.MISSED_OFF))('꺼짐/일시정지(%s)는 이유를 말한다', (cause, sentence) => {
    view({kind: 'off', cause: cause as keyof typeof copy.MISSED_OFF});
    expect(screen.getByTestId('missed-digest-off')).toBeTruthy();
    expect(screen.getByText(sentence)).toBeTruthy();
    expect(screen.queryByTestId('missed-digest-ready')).toBeNull();
  });

  it('요약 전은 만들어지면 보여 준다고 말한다', () => {
    view({kind: 'notSummarized'});
    expect(screen.getByText(copy.MISSED_NOT_SUMMARIZED)).toBeTruthy();
    expect(screen.queryByText(copy.MISSED_EMPTY)).toBeNull();
  });

  it('요약할 게 없음은 요약 전과 다른 문장이다', () => {
    view({kind: 'empty'});
    expect(screen.getByText(copy.MISSED_EMPTY)).toBeTruthy();
    expect(screen.queryByText(copy.MISSED_NOT_SUMMARIZED)).toBeNull();
  });

  it('요약은 줄로 나오고, 근거를 누르면 그 링크가 올라간다', () => {
    const onOpenEvidence = jest.fn();
    view({kind: 'ready', digests: [digest()], partial: false}, {onOpenEvidence});
    expect(screen.getByText('배포 일정이 금요일로 정해졌어요.')).toBeTruthy();
    expect(screen.getByText('롤백 절차는 그대로 가요.')).toBeTruthy();
    fireEvent.press(screen.getByTestId('missed-digest-evidence-2'));
    expect(onOpenEvidence).toHaveBeenCalledWith({messageId: 'm-18', channelId: CH, seq: 18});
    expect(screen.queryByTestId('missed-digest-partial')).toBeNull();
  });

  it('워커가 덜 따라왔으면 그 사실을 함께 말한다', () => {
    view({kind: 'ready', digests: [digest()], partial: true});
    expect(screen.getByText(copy.MISSED_PARTIAL)).toBeTruthy();
  });

  it('닫기를 누르면 onDismiss 가 불린다', () => {
    const onDismiss = jest.fn();
    view({kind: 'empty'}, {onDismiss});
    fireEvent.press(screen.getByTestId('missed-digest-dismiss'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('hidden 이면 아무것도 그리지 않는다', () => {
    view({kind: 'hidden'});
    expect(screen.queryByTestId('missed-digest-card')).toBeNull();
  });
});

describe('요약 카드 — 서버와의 계약', () => {
  function mount(props: Partial<React.ComponentProps<typeof MissedDigestCard>> = {}) {
    const {ui} = withClient(
      <MissedDigestCard
        workspaceId={WS}
        channelId={CH}
        sinceSeq={10}
        unreadCount={MISSED_MIN_UNREAD}
        headSeq={20}
        {...props}
      />,
    );
    return render(ui);
  }

  it('방문이 얼린 sinceSeq 를 보내고 sinceLastRead 는 보내지 않는다', async () => {
    mockList.mockResolvedValue({digests: [digest()], afterSeq: 10, summarizedThroughSeq: 20});
    mount();
    await waitFor(() => expect(screen.getByTestId('missed-digest-ready')).toBeTruthy());
    const options = mockList.mock.calls[0][2];
    expect(options.sinceSeq).toBe(10);
    expect(options).not.toHaveProperty('sinceLastRead');
    expect(options).not.toHaveProperty('threadRootId');
  });

  it('스레드는 threadRootId 를 싣는다', async () => {
    mockList.mockResolvedValue({digests: [digest()], afterSeq: 10, summarizedThroughSeq: 20});
    mount({threadRootId: 'root-1'});
    await waitFor(() => expect(mockList).toHaveBeenCalled());
    expect(mockList.mock.calls[0][2].threadRootId).toBe('root-1');
  });

  it('문턱 밑이면 요청도 카드도 없다', async () => {
    mount({unreadCount: MISSED_MIN_UNREAD - 1});
    await act(async () => {});
    expect(mockList).not.toHaveBeenCalled();
    expect(mockSettings).not.toHaveBeenCalled();
    expect(screen.queryByTestId('missed-digest-card')).toBeNull();
  });

  it('자격 없는 방(사람끼리의 DM)이면 요청도 카드도 없다', async () => {
    mount({eligible: false});
    await act(async () => {});
    expect(mockList).not.toHaveBeenCalled();
    expect(screen.queryByTestId('missed-digest-card')).toBeNull();
  });

  it('꺼진 방에는 요약 요청을 보내지 않고 이유를 말한다', async () => {
    mockSettings.mockResolvedValue({...SETTINGS, me: {paused: true}});
    mount();
    await waitFor(() => expect(screen.getByTestId('missed-digest-off')).toBeTruthy());
    expect(screen.getByText(copy.MISSED_OFF.me)).toBeTruthy();
    expect(mockList).not.toHaveBeenCalled();
  });

  it('빈 목록 + 워커가 뒤 → 요약 전', async () => {
    mockList.mockResolvedValue({digests: [], afterSeq: 10, summarizedThroughSeq: 12});
    mount();
    await waitFor(() => expect(screen.getByTestId('missed-digest-pending')).toBeTruthy());
  });

  it('빈 목록 + 워커가 따라잡음 → 요약할 게 없음', async () => {
    mockList.mockResolvedValue({digests: [], afterSeq: 10, summarizedThroughSeq: 20});
    mount();
    await waitFor(() => expect(screen.getByTestId('missed-digest-empty')).toBeTruthy());
  });

  it('요청이 실패하면 오류 상태이고 다시 시도가 다시 묻는다', async () => {
    mockList.mockRejectedValueOnce(new ApiError(500, 'boom'));
    mount();
    await waitFor(() => expect(screen.getByTestId('missed-digest-error')).toBeTruthy());
    mockList.mockResolvedValue({digests: [digest()], afterSeq: 10, summarizedThroughSeq: 20});
    fireEvent.press(screen.getByTestId('missed-digest-retry'));
    await waitFor(() => expect(screen.getByTestId('missed-digest-ready')).toBeTruthy());
  });

  it('닫으면 사라진다', async () => {
    mockList.mockResolvedValue({digests: [digest()], afterSeq: 10, summarizedThroughSeq: 20});
    mount();
    await waitFor(() => expect(screen.getByTestId('missed-digest-ready')).toBeTruthy());
    fireEvent.press(screen.getByTestId('missed-digest-dismiss'));
    expect(screen.queryByTestId('missed-digest-card')).toBeNull();
  });

  it('더 보기는 시트를 열고, 시트의 근거는 시트를 닫고 링크를 올린다', async () => {
    const onOpenEvidence = jest.fn();
    mockList.mockResolvedValue({
      digests: [digest({id: 'a', fromSeq: 11, toSeq: 15}), digest({id: 'b', fromSeq: 16, toSeq: 20})],
      afterSeq: 10,
      summarizedThroughSeq: 20,
    });
    mount({onOpenEvidence});
    await waitFor(() => expect(screen.getByTestId('missed-digest-more')).toBeTruthy());
    fireEvent.press(screen.getByTestId('missed-digest-more'));
    expect(screen.getByTestId('missed-digest-sheet')).toBeTruthy();
    fireEvent.press(screen.getByTestId('missed-digest-sheet-evidence-1-1'));
    expect(onOpenEvidence).toHaveBeenCalledWith({messageId: 'm-15', channelId: CH, seq: 15});
    expect(screen.queryByTestId('missed-digest-sheet')).toBeNull();
  });
});

function receipt(over: Partial<MemoryReceipt> = {}): MemoryReceipt {
  return {
    runId: 'r-1',
    channelId: CH,
    servedCount: 2,
    digestIds: ['d-1', 'd-2'],
    digests: [digest({id: 'd-1'}), digest({id: 'd-2', fromSeq: 21, toSeq: 30})],
    budgetChars: 6000,
    usedChars: 900,
    createdAtMs: 1_700_000_000_000,
    ...over,
  };
}

describe('기억 n개 참고 칩', () => {
  function mount(onOpenEvidence?: jest.Mock) {
    const {ui} = withClient(
      <MemoryReceiptChip workspaceId={WS} runId="r-1" onOpenEvidence={onOpenEvidence} />,
    );
    return render(ui);
  }

  it('servedCount 를 n 으로 세운다', async () => {
    mockReceipt.mockResolvedValue(receipt({servedCount: 5}));
    mount();
    await waitFor(() => expect(screen.getByText(copy.receiptChipLabel(5))).toBeTruthy());
  });

  it('0건이면 칩이 없다', async () => {
    mockReceipt.mockResolvedValue(receipt({servedCount: 0, digests: [], digestIds: []}));
    mount();
    await waitFor(() => expect(mockReceipt).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByTestId('memory-receipt-chip')).toBeNull();
  });

  it('영수증이 없으면(404) 칩이 없다', async () => {
    mockReceipt.mockRejectedValue(new ApiError(404, 'receipt not found'));
    mount();
    await waitFor(() => expect(mockReceipt).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByTestId('memory-receipt-chip')).toBeNull();
  });

  it('읽지 못해도 답을 가리지 않는다 (칩이 없다)', async () => {
    mockReceipt.mockRejectedValue(new ApiError(500, 'boom'));
    mount();
    await waitFor(() => expect(mockReceipt).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByTestId('memory-receipt-chip')).toBeNull();
  });

  it('누르면 실린 요약 목록 시트가 열리고, 보류 줄은 서버가 개수를 줄 때만 나온다', async () => {
    mockReceipt.mockResolvedValue(receipt());
    mount();
    await waitFor(() => expect(screen.getByTestId('memory-receipt-chip')).toBeTruthy());
    fireEvent.press(screen.getByTestId('memory-receipt-chip'));
    expect(screen.getByText(copy.RECEIPT_SHEET_TITLE)).toBeTruthy();
    expect(screen.getByTestId('memory-sheet-item-2')).toBeTruthy();
    expect(screen.queryByTestId('memory-sheet-withheld')).toBeNull();
    expect(screen.queryByText(copy.WITHHELD_EXPLAIN)).toBeNull();
  });

  it('withheldCount 가 있으면 개수와 이유만 말하고 내용은 그리지 않는다', async () => {
    mockReceipt.mockResolvedValue(receipt({withheldCount: 3}));
    mount();
    await waitFor(() => expect(screen.getByTestId('memory-receipt-chip')).toBeTruthy());
    fireEvent.press(screen.getByTestId('memory-receipt-chip'));
    expect(screen.getByText(copy.withheldLine(3))).toBeTruthy();
    expect(screen.getByText(copy.WITHHELD_EXPLAIN)).toBeTruthy();
    // 실린 두 개 말고 그려진 요약 항목이 더 없다.
    expect(screen.queryByTestId('memory-sheet-item-3')).toBeNull();
  });

  it('목록이 실린 수보다 짧으면 「볼 수 있는 기억만」 한 줄이 붙는다', async () => {
    mockReceipt.mockResolvedValue(receipt({servedCount: 4}));
    mount();
    await waitFor(() => expect(screen.getByTestId('memory-receipt-chip')).toBeTruthy());
    fireEvent.press(screen.getByTestId('memory-receipt-chip'));
    expect(screen.getByText(copy.RECEIPT_ONLY_READABLE)).toBeTruthy();
    expect(screen.queryByTestId('memory-sheet-withheld')).toBeNull();
  });

  it('시트의 근거는 시트를 닫고 링크를 올린다', async () => {
    const onOpenEvidence = jest.fn();
    mockReceipt.mockResolvedValue(receipt());
    mount(onOpenEvidence);
    await waitFor(() => expect(screen.getByTestId('memory-receipt-chip')).toBeTruthy());
    fireEvent.press(screen.getByTestId('memory-receipt-chip'));
    fireEvent.press(screen.getByTestId('memory-sheet-evidence-1-2'));
    expect(onOpenEvidence).toHaveBeenCalledWith({messageId: 'm-18', channelId: CH, seq: 18});
    expect(screen.queryByTestId('memory-sheet')).toBeNull();
  });
});

const AGENT = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const SELF = '11111111-1111-4111-8111-111111111111';
function rosterMember(over: Partial<RosterMember> & {id: string}): RosterMember {
  return {
    workspaceId: WS, kind: 'human', status: 'active', displayName: '이름', handle: 'h',
    channelCount: 0, channelIds: [], capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...over,
  } as RosterMember;
}
const DIRECTORY = makeDirectory([
  rosterMember({id: SELF, displayName: '곽성재', handle: 'seongjae'}),
  rosterMember({id: AGENT, kind: 'agent', displayName: '김인턴', handle: 'intern'}),
]);
function turnRecord(over: Partial<Message> = {}): Message {
  return {
    id: 'msg-turn', channelId: CH, seq: 30, hlcTs: 30, hlcCount: 0, authorMemberId: AGENT,
    type: 'text', body: '정리했어요.', state: 'sent', createdAtMs: 1_700_000_000_000,
    props: {schema: 'momo.agent_gateway.timeline.v0', run_id: 'RUN-1'},
    ...over,
  };
}

describe('에이전트 답 행에 칩이 붙는 자리', () => {
  function row(message: Message, workspaceId: string | null = WS) {
    const {ui} = withClient(
      <MessageRow
        message={message}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={1_700_000_100_000}
        actions={{
          myMemberId: SELF,
          onToggleReaction: async () => {},
          onEdit: async () => {},
          onDelete: async () => {},
          workspaceId: workspaceId ?? undefined,
        }}
      />,
    );
    return render(ui);
  }

  it('정착한 턴 기록에는 run id 로 영수증을 읽어 칩을 단다', async () => {
    mockReceipt.mockResolvedValue(receipt({servedCount: 2}));
    row(turnRecord());
    await waitFor(() => expect(screen.getByTestId('memory-receipt-chip')).toBeTruthy());
    // 코어가 run id 를 소문자로 맞춘다(`turnRecordRunId`).
    expect(mockReceipt).toHaveBeenCalledWith(WS, 'run-1');
  });

  it('일반 메시지에는 영수증을 묻지도 칩을 달지도 않는다', async () => {
    row(turnRecord({props: {}}));
    await act(async () => {});
    expect(mockReceipt).not.toHaveBeenCalled();
    expect(screen.queryByTestId('memory-receipt-chip')).toBeNull();
  });

  it('워크스페이스를 모르는 표면에서는 묻지 않는다', async () => {
    row(turnRecord(), null);
    await act(async () => {});
    expect(mockReceipt).not.toHaveBeenCalled();
  });

  it('지워진 답에는 칩이 없다', async () => {
    mockReceipt.mockResolvedValue(receipt());
    row(turnRecord({state: 'deleted', body: undefined}));
    await act(async () => {});
    expect(screen.queryByTestId('memory-receipt-chip')).toBeNull();
  });
});

// 스위치는 줄이 대신 읽어 주므로 접근성 트리에서 숨겨져 있다(`ProfileSheet`와 같은 규율).
const pauseSwitch = (optional = false) =>
  screen[optional ? 'queryByTestId' : 'getByTestId']('memory-pause-switch', {
    includeHiddenElements: true,
  });

describe('개인 일시정지 (프로필 시트)', () => {
  function mount() {
    const {ui, client} = withClient(<MemoryPauseSection workspaceId={WS} />);
    return {client, ...render(ui)};
  }

  it('서버 값을 읽은 뒤에야 스위치가 서고, 켜면 me 만 보낸다', async () => {
    mockPatchMe.mockResolvedValue({paused: true});
    mount();
    expect(pauseSwitch(true)).toBeNull();
    await waitFor(() => expect(pauseSwitch()).toBeTruthy());
    expect(pauseSwitch().props.value).toBe(false);
    fireEvent(pauseSwitch(), 'valueChange', true);
    await waitFor(() => expect(mockPatchMe).toHaveBeenCalledWith(WS, true));
    await waitFor(() => expect(pauseSwitch().props.value).toBe(true));
    expect(screen.getByText(copy.MEMORY_PAUSE_DETAIL_ON)).toBeTruthy();
  });

  it('쓰기가 실패하면 되돌리고 문장으로 말한다', async () => {
    mockPatchMe.mockRejectedValue(new ApiError(500, 'boom'));
    mount();
    await waitFor(() => expect(pauseSwitch()).toBeTruthy());
    fireEvent(pauseSwitch(), 'valueChange', true);
    await waitFor(() => expect(screen.getByTestId('memory-pause-failure')).toBeTruthy());
    expect(pauseSwitch().props.value).toBe(false);
    expect(screen.getByText(copy.MEMORY_PAUSE_SAVE_FAILED)).toBeTruthy();
  });

  it('읽기 실패면 스위치 대신 다시 불러오기를 주고, 「꺼짐」을 그리지 않는다', async () => {
    mockSettings.mockRejectedValue(new ApiError(500, 'boom'));
    mount();
    await waitFor(() => expect(screen.getByTestId('memory-pause-retry')).toBeTruthy());
    expect(pauseSwitch(true)).toBeNull();
    expect(screen.getByText(copy.MEMORY_PAUSE_LOAD_FAILED)).toBeTruthy();
  });

  it('팀 설정이 꺼져 있으면 그 사실을 알리고, 관리자 설정은 데스크탑이라고 말한다', async () => {
    mockSettings.mockResolvedValue({...SETTINGS, workspace: {enabled: false, paused: false, resetEpoch: 0}});
    mount();
    await waitFor(() => expect(screen.getByTestId('memory-workspace-off')).toBeTruthy());
    expect(screen.getByText(copy.MEMORY_ADMIN_DETAIL)).toBeTruthy();
  });
});

describe('근거 점프의 못 찾음 고지', () => {
  it('memory 주어는 해요체이고 seq 를 알면 위쪽에 있다고 단정한다', () => {
    const older = jumpMissedNotice('older', 'memory');
    expect(older.headline).toBe('근거 메시지는 이 대화의 더 위쪽에 있어요');
    const unknown = jumpMissedNotice('unknown', 'memory');
    expect(unknown.headline).toBe('근거 메시지를 이 화면에서 찾지 못했어요');
    expect(older.detail).toMatch(/요\.$/);
  });
});
