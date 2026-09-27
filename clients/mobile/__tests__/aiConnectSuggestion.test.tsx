import {ApiError, type Member, type Message, type RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {COMMAND_SUGGEST_PROP_KEY} from '@momo/core/features/timeline/commandSuggest';
import {linkPill} from '@momo/core/features/settings/aiLinkPill';
import {
  fetchProviderLink,
  testProviderLink,
  type ProviderLink,
} from '@momo/core/features/settings/api';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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
import {CONV} from '../src/features/conversation/convDesign';
import {SessionProvider} from '../src/session/useSession';

// =============================================================================
// #2948 GC-7 — 폰 `MessageRow`의 `command_suggest(ai.connect)` 분기 (ADR-0186 G4·G6).
//
// 웹 `MessageRow.commandSuggest.test.tsx`와 같은 픽스처(G3 샘플)를 같은 규칙으로 잰다:
//   - 대상 본인: 읽기 카드. 로그인·키 입력 없음(Q5). 운영자면 「연결 확인」 하나.
//   - 운영자(대상 아님): 한 줄 + 「팀 연결 보기」 → 팀 줄만.
//   - 그 밖: 한 줄, 누를 것 0.
//   - 알약은 props가 아니라 provider_link 응답 → 코어 `linkPill`.
// =============================================================================

jest.mock('@momo/core/features/settings/api', () => {
  const actual = jest.requireActual('@momo/core/features/settings/api');
  return {...actual, fetchProviderLink: jest.fn(), testProviderLink: jest.fn()};
});

const WS = '22222222-2222-4222-8222-222222222222';
const REQUESTER = '11111111-1111-4111-8111-111111111111';
const SKY = '11111111-1111-4111-8111-111111111112';
const HERMES = 'cccccccc-1111-4111-8111-cccccccccccc';
const CH = 'ch-general';

function person(
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
    role: 'member',
    channelCount: 1,
    channelIds: [CH],
    capabilities: [],
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

const DIRECTORY = makeDirectory([
  person(REQUESTER, 'human', '곽성재', 'seongjae'),
  person(SKY, 'human', '김하늘', 'sky'),
  person(HERMES, 'agent', 'hermes', 'hermes'),
]);

const G3 = {
  v: 1,
  command_id: 'ai.connect',
  args: {harness: 'claude', scope: 'mine'},
  for_member_id: REQUESTER,
  label: 'Claude 구독 연결',
};

const BODY = '구독 로그인은 맥에서 해야 해요. 카드를 맥에서 열어 주세요.';

const KEY_LINK = {
  schema: 'momo.provider_link.v0',
  configured: true,
  source: 'database',
  mode: 'external-hermes',
  baseUrl: 'https://api.openai.com/v1',
  endpointLabel: 'OpenAI',
  bearerConfigured: true,
  bearerLast4: 'a4f2',
  availability: 'live',
  keyConfigured: true,
  updatedAtMs: 1_790_000_000_000,
  diagnostics: [],
  presets: [],
} as unknown as ProviderLink;

function message(envelope: unknown, author = HERMES): Message {
  return {
    id: 'm-suggest',
    channelId: CH,
    seq: 3,
    hlcTs: 3,
    hlcCount: 0,
    authorMemberId: author,
    type: 'text',
    body: BODY,
    state: 'sent',
    createdAtMs: 1_700_000_000_000,
    props: {[COMMAND_SUGGEST_PROP_KEY]: envelope},
  } as Message;
}

function me(id: string): Member {
  return {id, workspaceId: WS, kind: 'human', displayName: '나', handle: 'me'} as Member;
}

function actions(id: string): MessageRowActions {
  return {
    myMemberId: id,
    onToggleReaction: jest.fn(),
    onEdit: jest.fn(),
    onDelete: jest.fn(),
  } as unknown as MessageRowActions;
}

function renderRow(msg: Message, viewer: string | null) {
  const client = new QueryClient({
    defaultOptions: {queries: {retry: false, gcTime: 0}},
  });
  return render(
    <QueryClientProvider client={client}>
      <SessionProvider member={me(viewer ?? SKY)}>
        <MessageRow
          message={msg}
          startsGroup
          directory={DIRECTORY}
          chips={[]}
          nowMs={1_700_000_000_000}
          {...(viewer !== null ? {actions: actions(viewer)} : {})}
        />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

/** 제안 자리 안의 누를 것 수(G6: 비대상·비운영자 0). */
function pressables(root: ReturnType<typeof screen.getByTestId>): number {
  return within(root).queryAllByRole('button').length;
}

beforeEach(() => {
  jest.mocked(fetchProviderLink).mockReset().mockResolvedValue(KEY_LINK);
  jest.mocked(testProviderLink).mockReset();
});

afterEach(cleanup);

describe('대상 본인 — 폰 읽기 카드', () => {
  it('본문 아래 제안 머리 + 「맥에서」 한 줄, 로그인·키 입력 없음', async () => {
    renderRow(message({...G3, args: {}}), REQUESTER);
    const card = await screen.findByTestId('ai-suggest-target', {}, {timeout: 5000});
    await screen.findByTestId('ai-suggest-team', {}, {timeout: 5000});
    expect(screen.getByText(BODY)).toBeTruthy();
    expect(within(card).getByText('hermes가 제안했어요')).toBeTruthy();
    expect(within(card).getByText(/구독 로그인은 맥에서 해요/)).toBeTruthy();
    expect(within(card).queryByText(/로그인$/)).toBeNull();
    expect(within(card).queryByText(/키 넣기|키 바꾸기/)).toBeNull();
    // 운영자면 누를 것은 「연결 확인」 하나.
    expect(within(card).getAllByRole('button').map(b => b.props.testID)).toEqual([
      'ai-suggest-team-check',
    ]);
    expect(within(card).queryByText('Claude 구독 연결')).toBeNull();
  });

  it('합친 팀 절은 제안 카드의 가장자리(CONV.cardPad)를 따른다 (#2945 R3-H1)', async () => {
    renderRow(message({...G3, args: {}}), REQUESTER);
    await screen.findByTestId('ai-suggest-team', {}, {timeout: 5000});
    const pad = (id: string) =>
      StyleSheet.flatten(screen.getByTestId(id).props.style).paddingHorizontal;
    expect(pad('ai-suggest-team-section')).toBe(CONV.cardPad);
    expect(pad('ai-suggest-team-section')).toBe(pad('ai-suggest-mine'));
  });

  it('팀 알약은 provider_link 응답 → 코어 linkPill(웹·설정과 같은 판정)', async () => {
    renderRow(message({...G3, args: {harness: 'team_key'}}), REQUESTER);
    const pill = await screen.findByTestId('ai-suggest-team-pill', {}, {timeout: 5000});
    const expected = linkPill({link: KEY_LINK, offline: false, probe: null});
    expect(within(pill).getByText(expected.text)).toBeTruthy();
    expect(expected.text).toBe('연결됨');
  });

  it('연결 확인은 기존 test 라우트를 부르고 결과가 그 줄에서 바뀐다', async () => {
    jest.mocked(testProviderLink).mockResolvedValue({
      schema: 'momo.provider_link.test.v0',
      ok: true,
      source: 'database',
      mode: 'external-hermes',
      endpointLabel: 'OpenAI',
      checkedAtMs: Date.now(),
    } as never);
    renderRow(message({...G3, args: {harness: 'team_key'}}), REQUESTER);
    const check = await screen.findByTestId('ai-suggest-team-check', {}, {timeout: 5000});
    await act(async () => {
      fireEvent.press(check);
    });
    await waitFor(() =>
      expect(within(screen.getByTestId('ai-suggest-team-pill')).getByText('확인됨')).toBeTruthy(),
    );
    expect(testProviderLink).toHaveBeenCalledTimes(1);
  });

  it('비운영자 본인: 팀 줄은 읽기 한 줄, 누를 것 0', async () => {
    jest.mocked(fetchProviderLink).mockRejectedValue(new ApiError(403, 'forbidden'));
    renderRow(message({...G3, args: {harness: 'team_key'}}), REQUESTER);
    await screen.findByTestId('ai-suggest-team-denied', {}, {timeout: 5000});
    expect(pressables(screen.getByTestId('ai-suggest-target'))).toBe(0);
  });

  it('props에 상태를 실어도 믿지 않는다: 한 줄 폴백, 누를 것 0', async () => {
    renderRow(message({...G3, state: 'ready'}), REQUESTER);
    const line = await screen.findByTestId('ai-suggest-other', {}, {timeout: 5000});
    expect(within(line).getByText('곽성재에게 AI 연결을 제안했어요')).toBeTruthy();
    expect(pressables(line)).toBe(0);
    expect(screen.queryByTestId('ai-suggest-target')).toBeNull();
  });
});

describe('대상이 아닌 사람', () => {
  it('비운영자(403): 한 줄만, 누를 것 0', async () => {
    jest.mocked(fetchProviderLink).mockRejectedValue(new ApiError(403, 'forbidden'));
    renderRow(message(G3), SKY);
    await waitFor(() => expect(fetchProviderLink).toHaveBeenCalled());
    const line = await screen.findByTestId('ai-suggest-other', {}, {timeout: 5000});
    expect(within(line).getByText('곽성재에게 AI 연결을 제안했어요')).toBeTruthy();
    expect(pressables(line)).toBe(0);
    expect(screen.queryByText(/내 계정/)).toBeNull();
  });

  it('운영자: 한 줄 + 「팀 연결 보기」 → 팀 줄만', async () => {
    renderRow(message(G3), SKY);
    const open = await screen.findByTestId('ai-suggest-team-open', {}, {timeout: 5000});
    expect(screen.queryByTestId('ai-suggest-team-panel')).toBeNull();
    await act(async () => {
      fireEvent.press(open);
    });
    const panel = await screen.findByTestId('ai-suggest-team-panel', {}, {timeout: 5000});
    await within(panel).findByTestId('ai-suggest-team-check', {}, {timeout: 5000});
    expect(screen.queryByText(/내 계정/)).toBeNull();
  });
});

describe('본문 폴백', () => {
  it.each([
    ['사람이 쓴 메시지', message(G3, SKY)],
    ['모르는 command_id', message({...G3, command_id: 'invite.create'})],
    ['문자열 봉투', message(JSON.stringify(G3))],
  ])('%s', async (_name, msg) => {
    renderRow(msg, REQUESTER);
    await act(async () => undefined);
    expect(screen.queryByTestId(/ai-suggest/)).toBeNull();
    expect(screen.getByText(BODY)).toBeTruthy();
  });
});
