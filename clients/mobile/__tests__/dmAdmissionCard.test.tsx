import type {Member, Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import React from 'react';

import {MessageRow} from '../src/features/conversation/MessageRow';
import type {ApprovalGate} from '../src/features/conversation/approvalGate';
import {APPROVAL_OFFLINE_COPY} from '../src/features/inbox/useOnline';
import {SessionProvider} from '../src/session/useSession';
import {cleanup, render} from './fixtures/darkWorld';

// =============================================================================
// DM 들이기 허락 카드 (ADR-0217, 행동 `dm.agent.admit`) — #4920
//
// 서버는 초대한 사람을 뺀 사람마다 카드를 한 장씩 만들고 카드마다 결정자 한 명을 고정한다. 그래서 한
// 장의 카드가 기다리는 사람은 언제나 그 한 사람이고, 카드는 그 사람의 이름으로 말한다. 합친 트리에서는
// 묶음 카드의 대체 문장 「관리자의 승인을 기다려요」와 현행 카드의 「이 카드에 표시된 참여자의 허락을
// 기다려요.」가 모두 사실이 아니었다.
//
// 폰 카드는 두 갈래다. 서버가 묶음 필드를 안 싣는 오늘은 현행 카드가 `note` 한 줄을 그리고, 묶음 필드
// (`intent`·`can_decide`·`decision_mode`·행의 `after` 중 하나)가 실리면 묶음 카드가 `model.waitingFor`
// 한 줄을 그린다. 둘 다 같은 문장 한 곳을 읽어야 해서 둘 다 잰다. 문장은 손으로 적었다: 문장을 짓는
// 함수와 시험이 틀을 나누면 둘이 함께 틀려도 초록이다.
// =============================================================================

const WS = 'ws-1';
const REQUESTER = '11111111-1111-4111-8111-1111111111a1';
const TARGET = '22222222-2222-4222-8222-2222222222b2';
const PEER = '33333333-3333-4333-8333-3333333333c3';
const AGENT = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const BASE_MS = 1_700_000_000_000;

const TARGET_LINE = '박연구원 님의 허락을 기다려요';
const PEER_LINE = '이도현 님의 허락을 기다려요';
const UNNAMED_LINE = '다른 참여자의 허락을 기다려요';
const REJOIN_LINE = '연결이 돌아오면 여기서 결정할 수 있어요.';

function member(id: string, kind: 'human' | 'agent', displayName: string) {
  return {
    id,
    workspaceId: WS,
    kind,
    status: 'active',
    displayName,
    handle: displayName,
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  } as unknown as RosterMember;
}

const ROSTER = [
  member(REQUESTER, 'human', '김인턴'),
  member(TARGET, 'human', '박연구원'),
  member(PEER, 'human', '이도현'),
  member(AGENT, 'agent', '코메토'),
];
const DIRECTORY = makeDirectory(ROSTER);
const WITHOUT_TARGET = makeDirectory(ROSTER.filter(entry => entry.id !== TARGET));

const gate = (approvalId: string): ApprovalGate => ({
  approvalId,
  reversible: false,
  expiresAtMs: null,
});

/** 서버가 오늘 보내는 모양 그대로다: 묶음 필드(`intent` 등) 없이 행동 블록과 고정된 결정자만 있다. */
function consentCard(
  target: string,
  approvalId = 'ap-1',
  extra: Record<string, unknown> = {},
): Message {
  return {
    id: `msg-${approvalId}`,
    channelId: 'ch',
    seq: 10,
    hlcTs: 10,
    hlcCount: 0,
    // 카드의 작성자는 초대한 사람(요청자)이다.
    authorMemberId: REQUESTER,
    type: 'approval_request',
    body: '코메토 들이기 허락을 기다려요',
    state: 'sent',
    createdAtMs: BASE_MS,
    props: {
      approval_id: approvalId,
      approval_status: 'pending',
      action_type: 'workspace_action',
      title: '에이전트를 이 대화에 들이기',
      target_member_id: target,
      action: {
        id: 'dm.agent.admit',
        required_role: 'dm_participant',
        target_member_id: target,
        rows: [{label: '에이전트', value: '코메토 (@kometto)'}],
      },
      ...extra,
    },
  } as unknown as Message;
}

/** 서버가 가산 필드를 싣기 시작한 뒤의 모양: 같은 카드에 `intent` 하나만 더해도 묶음 카드가 된다. */
const bundled = (target: string, approvalId = 'ap-1') =>
  consentCard(target, approvalId, {intent: '에이전트를 이 대화에 들이기'});

function renderAs(
  viewer: string,
  message: Message,
  options: {
    directory?: ReturnType<typeof makeDirectory>;
    gates?: ReadonlyMap<string, ApprovalGate>;
    offline?: boolean;
  } = {},
) {
  const client = new QueryClient({
    defaultOptions: {queries: {retry: false, gcTime: 0}},
  });
  const me = {id: viewer, workspaceId: WS, displayName: '보는 사람'} as Member;
  return render(
    <QueryClientProvider client={client}>
      <SessionProvider member={me}>
        <MessageRow
          message={message}
          startsGroup
          directory={options.directory ?? DIRECTORY}
          chips={[]}
          nowMs={BASE_MS}
          approvalGates={options.gates ?? new Map([['ap-1', gate('ap-1')]])}
          approvalOffline={options.offline}
          approvalsProvided
          onApprovalSettled={() => {}}
          actions={{
            myMemberId: viewer,
            onToggleReaction: async () => {},
            onEdit: async () => {},
            onDelete: async () => {},
          }}
        />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

const waiting = (view: ReturnType<typeof renderAs>) =>
  view.queryAllByText(/허락을 기다려요/u);
const noControls = (view: ReturnType<typeof renderAs>) => {
  expect(view.queryByTestId('card-approval-ap-1-approve')).toBeNull();
  expect(view.queryByTestId('card-approval-ap-1-reject')).toBeNull();
};
// 「결정 권한」 행의 서버 계약 문구(「카드에 표시된 대화 참여자」)는 이 이슈의 범위 밖이라 그대로 있다. 시험이
// 막는 것은 대기 문장 자리의 옛 표현 「이 카드에 표시된 참여자의 허락」이다.
const noAdminNoPointer = (view: ReturnType<typeof renderAs>) => {
  expect(view.queryByText(/관리자/u)).toBeNull();
  expect(view.queryByText(/표시된 참여자/u)).toBeNull();
};

describe('현행 카드(서버가 묶음 필드를 안 싣는 오늘): 결정할 사람을 이름으로 말해요', () => {
  it.each([
    ['요청한 사람', REQUESTER],
    ['세 사람 이상 대화의 다른 참여자', PEER],
  ])('%s는 한 문장만 읽고 결정 단추를 받지 않아요', (_who, viewer) => {
    const view = renderAs(viewer, consentCard(TARGET));
    expect(view.queryByTestId('request-bundle-card')).toBeNull();
    expect(view.getByTestId('card-approval-participant')).toHaveTextContent(
      new RegExp(`^${TARGET_LINE}$`, 'u'),
    );
    expect(waiting(view)).toHaveLength(1);
    noControls(view);
    noAdminNoPointer(view);
  });

  it('결정할 사람 본인은 단추를 받고 기다리는 문장은 없어요', () => {
    const view = renderAs(TARGET, consentCard(TARGET));
    expect(view.getByTestId('card-approval-ap-1-approve')).toBeTruthy();
    expect(view.getByTestId('card-approval-ap-1-reject')).toBeTruthy();
    expect(waiting(view)).toHaveLength(0);
    expect(view.queryByTestId('card-approval-participant')).toBeNull();
    expect(view.queryByText(/관리자/u)).toBeNull();
  });

  it('카드마다 자기 결정자의 이름을 말해요: 세 사람 대화에서 요청자는 서로 다른 두 줄을 본다', () => {
    const gates = new Map([
      ['ap-1', gate('ap-1')],
      ['ap-2', gate('ap-2')],
    ]);
    const first = renderAs(REQUESTER, consentCard(TARGET, 'ap-1'), {gates});
    expect(first.getByTestId('card-approval-participant')).toHaveTextContent(
      new RegExp(`^${TARGET_LINE}$`, 'u'),
    );
    first.unmount();
    const second = renderAs(REQUESTER, consentCard(PEER, 'ap-2'), {gates});
    expect(second.getByTestId('card-approval-participant')).toHaveTextContent(
      new RegExp(`^${PEER_LINE}$`, 'u'),
    );
  });

  it('명부에서 이름을 못 풀면 이름 없이 말해요', () => {
    const view = renderAs(REQUESTER, consentCard(TARGET), {
      directory: WITHOUT_TARGET,
    });
    expect(view.getByTestId('card-approval-participant')).toHaveTextContent(
      new RegExp(`^${UNNAMED_LINE}$`, 'u'),
    );
    noAdminNoPointer(view);
  });

  it('끊긴 연결에서도 결정할 수 없는 사람에게는 연결이 돌아오면 결정하라고 말하지 않아요', () => {
    const view = renderAs(REQUESTER, consentCard(TARGET), {offline: true});
    expect(view.getByTestId('card-approval-participant')).toHaveTextContent(
      new RegExp(`^${TARGET_LINE}$`, 'u'),
    );
    expect(view.queryByText(APPROVAL_OFFLINE_COPY)).toBeNull();
    view.unmount();
    // 결정자 본인에게는 연결 문장이 서요.
    const decider = renderAs(TARGET, consentCard(TARGET), {offline: true});
    expect(decider.getByText(APPROVAL_OFFLINE_COPY)).toBeTruthy();
    expect(waiting(decider)).toHaveLength(0);
  });
});

describe('묶음 카드(서버가 가산 필드를 실을 때): 같은 문장을 말해요', () => {
  it.each([
    ['요청한 사람', REQUESTER],
    ['세 사람 이상 대화의 다른 참여자', PEER],
  ])('%s는 한 문장만 읽고 결정 단추를 받지 않아요', (_who, viewer) => {
    const view = renderAs(viewer, bundled(TARGET));
    expect(view.getByTestId('request-bundle-card')).toBeTruthy();
    // 대기 목록에 이 승인이 있어도(채널 사람 모두의 목록에 실려요) 고정된 결정자가 아니면 단추가 없다.
    expect(view.getByTestId('request-bundle-waiting')).toHaveTextContent(
      new RegExp(`^${TARGET_LINE}$`, 'u'),
    );
    expect(waiting(view)).toHaveLength(1);
    noControls(view);
    noAdminNoPointer(view);
  });

  it('결정할 사람 본인은 단추를 받고 기다리는 문장은 없어요', () => {
    const view = renderAs(TARGET, bundled(TARGET));
    expect(view.getByTestId('card-approval-ap-1-approve')).toBeTruthy();
    expect(view.queryByTestId('request-bundle-waiting')).toBeNull();
    expect(waiting(view)).toHaveLength(0);
    expect(view.queryByText(/관리자/u)).toBeNull();
  });

  it('결정할 사람 본인의 연결이 끊기면 연결 문장이 서고, 요청자는 이름 문장을 그대로 봐요', () => {
    const decider = renderAs(TARGET, bundled(TARGET), {offline: true});
    expect(decider.getByTestId('request-bundle-waiting')).toHaveTextContent(
      new RegExp(`^${REJOIN_LINE}$`, 'u'),
    );
    expect(waiting(decider)).toHaveLength(0);
    decider.unmount();
    const requester = renderAs(REQUESTER, bundled(TARGET), {offline: true});
    expect(requester.getByTestId('request-bundle-waiting')).toHaveTextContent(
      new RegExp(`^${TARGET_LINE}$`, 'u'),
    );
  });

  it('명부에서 이름을 못 풀면 이름 없이 말하고, 결정자 본인이 대기 목록에 없으면 문장이 없어요', () => {
    const view = renderAs(REQUESTER, bundled(TARGET), {
      directory: WITHOUT_TARGET,
    });
    expect(view.getByTestId('request-bundle-waiting')).toHaveTextContent(
      new RegExp(`^${UNNAMED_LINE}$`, 'u'),
    );
    noAdminNoPointer(view);
    view.unmount();
    // 결정자 본인이 이 승인을 대기 목록에서 못 찾는 때는 자기 자신도 관리자도 기다리지 않아요.
    const noGate = renderAs(TARGET, bundled(TARGET), {gates: new Map()});
    expect(waiting(noGate)).toHaveLength(0);
    expect(noGate.queryByText(/관리자/u)).toBeNull();
    noControls(noGate);
  });
});

describe('다른 승인 카드의 대기 문장은 그대로예요', () => {
  it('결정할 수 없다고 한 일반 행동 카드는 관리자 문장을 한 번 말해요', () => {
    const message = consentCard(TARGET, 'ap-1', {
      intent: '자기 소개를 바꾸려고 해요',
      can_decide: false,
      decision_mode: 'inline',
      action: {
        id: 'agent.profile.update',
        required_role: 'agent_editor',
        target_member_id: TARGET,
        rows: [{label: '소개', value: '새 소개', after: '새 소개'}],
      },
    });
    const view = renderAs(PEER, message);
    expect(view.getByTestId('request-bundle-waiting')).toHaveTextContent(
      /^관리자의 승인을 기다려요$/u,
    );
    expect(waiting(view)).toHaveLength(0);
    noControls(view);
  });
});
