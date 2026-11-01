import golden from '../../../docs/api/command-suggest-work-request-open.golden.json';
import {type Member, type Message, type RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {COMMAND_SUGGEST_PROP_KEY} from '@momo/core/features/timeline/commandSuggest';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {MessageRow, type MessageRowActions} from '../src/features/conversation/MessageRow';
import {SessionProvider} from '../src/session/useSession';

// =============================================================================
// #4972 S9 — 서버가 게시하는 `work.request.open` props(골든 벡터
// `docs/api/command-suggest-work-request-open.golden.json`)를 진짜 폰 MessageRow에 넣는다.
//
// - 대상 본인 + 시트를 열 셸이 있다(`actions.onOpenWorkRequest`): 읽기 카드, 누르면 골든이 가진 도구·글이
//   **그대로** 시트를 채울 값으로 넘어간다(CRLF·공백은 서버가 이미 정리한 값이다).
// - 대상 본인이어도 셸이 없으면(`onOpenWorkRequest` 없음) 한 줄이다. 남에게도 한 줄이다.
// =============================================================================

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

const BODY = '내 맥에서 바로 열 수 있어요.';

type GoldenCase = {
  name: string;
  props: Record<string, {args: {harness?: string; prompt: string}; label: string}>;
};
const CASES = golden.cases as unknown as GoldenCase[];

function message(envelope: unknown): Message {
  return {
    id: 'm-suggest',
    channelId: CH,
    seq: 3,
    hlcTs: 3,
    hlcCount: 0,
    authorMemberId: HERMES,
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

function actions(id: string, onOpenWorkRequest?: jest.Mock): MessageRowActions {
  return {
    myMemberId: id,
    onToggleReaction: jest.fn(),
    onEdit: jest.fn(),
    onDelete: jest.fn(),
    ...(onOpenWorkRequest !== undefined ? {onOpenWorkRequest} : {}),
  } as unknown as MessageRowActions;
}

function renderRow(msg: Message, viewer: string, rowActions: MessageRowActions) {
  const client = new QueryClient({defaultOptions: {queries: {retry: false, gcTime: 0}}});
  return render(
    <QueryClientProvider client={client}>
      <SessionProvider member={me(viewer)}>
        <MessageRow
          message={msg}
          startsGroup
          directory={DIRECTORY}
          chips={[]}
          nowMs={1_700_000_000_000}
          actions={rowActions}
        />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe('#4972: 서버가 게시한 골든 props → 폰 보는 사람별 렌더', () => {
  it('골든의 자리표시 요청자는 이 시험의 REQUESTER다', () => {
    expect(golden.for_member_id_placeholder).toBe(REQUESTER);
  });

  it.each(CASES.map(c => c.name))(
    '%s: 대상 본인에게 읽기 카드가 서고 누르면 골든의 도구·글이 시트로 간다',
    name => {
      const envelope = CASES.find(c => c.name === name)!.props[COMMAND_SUGGEST_PROP_KEY]!;
      const open = jest.fn();
      renderRow(message(envelope), REQUESTER, actions(REQUESTER, open));
      expect(screen.getByTestId('work-request-suggest-target')).toBeTruthy();
      expect(screen.queryByTestId('work-request-suggest-other')).toBeNull();
      expect(screen.getByText(BODY)).toBeTruthy();
      fireEvent.press(screen.getByTestId('work-request-suggest-open'));
      expect(open).toHaveBeenCalledTimes(1);
      expect(open).toHaveBeenCalledWith({
        harness: envelope.args.harness ?? null,
        prompt: envelope.args.prompt,
      });
    },
  );

  it('시트를 열 셸이 없으면 대상 본인에게도 한 줄이고 누를 것이 없다', () => {
    const envelope = CASES[0]!.props[COMMAND_SUGGEST_PROP_KEY]!;
    renderRow(message(envelope), REQUESTER, actions(REQUESTER));
    expect(screen.getByTestId('work-request-suggest-line')).toBeTruthy();
    expect(screen.queryByTestId('work-request-suggest-open')).toBeNull();
  });

  it('남에게는 한 줄이고 누를 것이 없다(셸이 있어도)', () => {
    const envelope = CASES[1]!.props[COMMAND_SUGGEST_PROP_KEY]!;
    renderRow(message(envelope), SKY, actions(SKY, jest.fn()));
    expect(screen.getByTestId('work-request-suggest-line')).toBeTruthy();
    expect(screen.queryByTestId('work-request-suggest-open')).toBeNull();
  });
});
