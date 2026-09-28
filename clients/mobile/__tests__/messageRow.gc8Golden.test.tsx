import golden from '../../../docs/api/command-suggest-ai-connect.golden.json';
import {
  ApiError,
  type Member,
  type Message,
  type RosterMember,
} from '@momo/core/lib/api';
import { makeDirectory } from '@momo/core/features/workspace/directory';
import { COMMAND_SUGGEST_PROP_KEY } from '@momo/core/features/timeline/commandSuggest';
import {
  fetchProviderLink,
  testProviderLink,
  type ProviderLink,
} from '@momo/core/features/settings/api';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {
  MessageRow,
  type MessageRowActions,
} from '../src/features/conversation/MessageRow';
import { SessionProvider } from '../src/session/useSession';

// =============================================================================
// #2949 GC-8(#2986) — 서버 E2E가 실제로 게시한 props(골든 벡터
// `docs/api/command-suggest-ai-connect.golden.json`)를 GC-7의 진짜 폰 MessageRow에 넣는다.
// 웹 `MessageRow.gc8Golden.test.tsx`의 폰 짝이다. 폰은 구독 로그인을 맥에 맡기므로(Q5)
// 대상 본인의 「제자리」 변화는 팀 줄의 연결 확인 → 같은 카드 안 알약으로 잰다.
//
// - 대상 본인: 네 골든 모두 읽기 카드(폴백 아님).
// - 그 밖(비운영자): 한 줄, 누를 것 0.
// =============================================================================

jest.mock('@momo/core/features/settings/api', () => {
  const actual = jest.requireActual('@momo/core/features/settings/api');
  return {
    ...actual,
    fetchProviderLink: jest.fn(),
    testProviderLink: jest.fn(),
  };
});

const WS = '22222222-2222-4222-8222-222222222222';
// 골든의 자리표시 요청자와 같은 값이어야 한다(아래 첫 시험이 잰다).
const REQUESTER = '00000000-0000-7000-8000-000000000101';
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
    props: { [COMMAND_SUGGEST_PROP_KEY]: envelope },
  } as Message;
}

function me(id: string): Member {
  return {
    id,
    workspaceId: WS,
    kind: 'human',
    displayName: '나',
    handle: 'me',
  } as Member;
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
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
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
          {...(viewer !== null ? { actions: actions(viewer) } : {})}
        />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

/** 제안 자리 안의 누를 것 수(G6: 비대상·비운영자 0). */
function pressables(root: ReturnType<typeof screen.getByTestId>): number {
  return within(root).queryAllByRole('button').length;
}

function goldenCase(name: string): unknown {
  const found = (
    golden.cases as { name: string; props: Record<string, unknown> }[]
  ).find(c => c.name === name);
  if (!found) {
    throw new Error(name);
  }
  return found.props[COMMAND_SUGGEST_PROP_KEY];
}

beforeEach(() => {
  jest.mocked(fetchProviderLink).mockReset().mockResolvedValue(KEY_LINK);
  jest.mocked(testProviderLink).mockReset();
});

afterEach(cleanup);

describe('GC-8: 서버가 게시한 골든 props → 폰 보는 사람별 렌더', () => {
  it('골든의 자리표시 요청자는 이 시험의 REQUESTER다', () => {
    expect(golden.for_member_id_placeholder).toBe(REQUESTER);
  });

  it.each(['no_args', 'claude', 'codex', 'team_key'])(
    '%s: 대상 본인에게 읽기 카드(폴백 아님)',
    async name => {
      renderRow(message(goldenCase(name)), REQUESTER);
      await screen.findByTestId('ai-suggest-target', {}, { timeout: 5000 });
      expect(screen.queryByTestId('ai-suggest-other')).toBeNull();
      expect(screen.getByText(BODY)).toBeTruthy();
    },
  );

  it('요청 → 카드 → 연결 확인 → 그 줄이 제자리에서 「확인됨」', async () => {
    jest.mocked(testProviderLink).mockResolvedValue({
      schema: 'momo.provider_link.test.v0',
      ok: true,
      source: 'database',
      mode: 'external-hermes',
      endpointLabel: 'OpenAI',
      checkedAtMs: Date.now(),
    } as never);
    renderRow(message(goldenCase('team_key')), REQUESTER);
    const check = await screen.findByTestId(
      'ai-suggest-team-check',
      {},
      { timeout: 5000 },
    );
    expect(
      within(screen.getByTestId('ai-suggest-team-pill')).getByText('연결됨'),
    ).toBeTruthy();
    await act(async () => {
      fireEvent.press(check);
    });
    await waitFor(() =>
      expect(
        within(screen.getByTestId('ai-suggest-team-pill')).getByText('확인됨'),
      ).toBeTruthy(),
    );
    // 같은 메시지 안, 같은 카드다(새 메시지·새 카드가 아니다).
    expect(screen.getAllByTestId('ai-suggest-target')).toHaveLength(1);
  });

  it('남(비운영자)에게는 한 줄, 누를 것 0', async () => {
    jest
      .mocked(fetchProviderLink)
      .mockRejectedValue(new ApiError(403, 'forbidden'));
    renderRow(message(goldenCase('claude')), SKY);
    await waitFor(() => expect(fetchProviderLink).toHaveBeenCalled());
    const line = await screen.findByTestId(
      'ai-suggest-other',
      {},
      { timeout: 5000 },
    );
    await act(async () => undefined);
    expect(
      within(line).getByText('곽성재에게 AI 연결을 제안했어요'),
    ).toBeTruthy();
    expect(pressables(line)).toBe(0);
    expect(screen.queryByTestId('ai-suggest-target')).toBeNull();
  });
});
