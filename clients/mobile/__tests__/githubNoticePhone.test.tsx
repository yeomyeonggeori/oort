import type {Member, Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';
import {Linking} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import * as surfaces from '@momo/core/features/capabilities/serverSurfaces';
import {phoneAppDetail} from '@momo/core/features/plugins/phoneApps';
import {
  MessageRow,
  type MessageRowActions,
} from '../src/features/conversation/MessageRow';
import {SessionProvider} from '../src/session/useSession';
import {AppDetailView} from '../src/screens/AppDetailScreen';

// =============================================================================
// GitHub 알림 — 폰 (ADR-0205 D4·D10, U-GH1 #3955). 판정은 코어(`githubNoticeFor`,
// `githubFacesFor`)가 하고 시험은 `model.test.ts`다. 여기서는 폰 행과 앱 상세에 배선됐는지를 박는다.
// 웹 판은 `clients/web/src/features/timeline/MessageRow.github.test.tsx`다.
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const GITHUB_ID = 'cccccccc-1111-4111-8111-cccccccccc0a';
const HERMES_ID = 'cccccccc-1111-4111-8111-cccccccccc03';
const CH = 'ch-general';
const BASE_MS = 1_760_000_000_000;

const member = (id: string, kind: 'human' | 'agent', displayName: string, handle: string) =>
  ({
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
  }) as RosterMember;
const DIRECTORY = makeDirectory([
  member(SELF_ID, 'human', '곽성재', 'seongjae'),
  member(GITHUB_ID, 'agent', 'GitHub', 'github'),
  member(HERMES_ID, 'agent', 'Hermes', 'hermes'),
]);
const ME: Member = {id: SELF_ID, workspaceId: WS, kind: 'human', displayName: '곽성재', handle: 'seongjae'};

const PROPS = {
  source: 'github',
  github_event: 'pull_request',
  github_action: 'opened',
  github_repository: 'yeomyeonggeori/oort',
  github_url: 'https://github.com/yeomyeonggeori/oort/pull/12',
};

function githubMessage(props: Record<string, unknown> | undefined, author = GITHUB_ID): Message {
  return {
    id: '0199aa11-2222-7000-8000-0000000005a1',
    channelId: CH,
    seq: 10,
    hlcTs: 10,
    hlcCount: 0,
    authorMemberId: author,
    type: 'text',
    body: 'yeomyeonggeori/oort · @haneul님이 PR을 열었어요',
    state: 'sent',
    createdAtMs: BASE_MS,
    ...(props ? {props} : {}),
  } as unknown as Message;
}

const actions: MessageRowActions = {
  myMemberId: SELF_ID,
  workspaceId: WS,
  onToggleReaction: async () => {},
  onEdit: async () => {},
  onDelete: async () => {},
};

function renderRow(msg: Message) {
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
          actions={actions}
        />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

describe('GitHub 알림 아랫줄 (폰)', () => {
  it('에이전트 「GitHub」의 알림에는 칩, 소식, 열기가 서고 행 낭독에 실린다', () => {
    renderRow(githubMessage(PROPS));
    expect(screen.getByTestId('github-notice')).toBeTruthy();
    expect(screen.getByText('GitHub 알림')).toBeTruthy();
    expect(screen.getByTestId('github-notice-what')).toHaveTextContent('PR 열림');
    expect(screen.getByTestId('github-notice-open')).toBeTruthy();
    const label = screen.getByTestId('message-row').props.accessibilityLabel as string;
    expect(label).toContain('GitHub 알림, yeomyeonggeori/oort, PR 열림');
  });

  it('열기는 https 주소를 연다', () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    jest.spyOn(Linking, 'canOpenURL').mockResolvedValue(true);
    renderRow(githubMessage(PROPS));
    fireEvent.press(screen.getByTestId('github-notice-open'));
    expect(open).toHaveBeenCalledWith('https://github.com/yeomyeonggeori/oort/pull/12');
  });

  it('로터에 「GitHub에서 열기」 행동이 선다', () => {
    renderRow(githubMessage(PROPS));
    const names = (screen.getByTestId('message-row').props.accessibilityActions as {name: string}[]).map(
      action => action.name,
    );
    expect(names).toContain('momoGithubOpen');
  });

  it('주소가 https 가 아니면 줄은 서지만 열기와 로터 행동은 없다', () => {
    renderRow(githubMessage({...PROPS, github_url: 'javascript:alert(1)'}));
    expect(screen.getByTestId('github-notice')).toBeTruthy();
    expect(screen.queryByTestId('github-notice-open')).toBeNull();
    const names = ((screen.getByTestId('message-row').props.accessibilityActions ?? []) as {name: string}[]).map(
      action => action.name,
    );
    expect(names).not.toContain('momoGithubOpen');
  });

  it('다른 이름의 에이전트가 같은 props 를 실어도 줄이 서지 않는다', () => {
    renderRow(githubMessage(PROPS, HERMES_ID));
    expect(screen.queryByTestId('github-notice')).toBeNull();
  });

  it('사람이 같은 props 를 실어도 줄이 서지 않는다', () => {
    renderRow(githubMessage(PROPS, SELF_ID));
    expect(screen.queryByTestId('github-notice')).toBeNull();
  });

  it('props 가 없는 옛 서버의 메시지는 화면 변화가 없다', () => {
    renderRow(githubMessage(undefined));
    expect(screen.queryByTestId('github-notice')).toBeNull();
  });
});

describe('「앱」 상세의 GitHub 얼굴 (폰)', () => {
  const view = (pluginId: string) =>
    phoneAppDetail(
      {
        pluginId,
        name: 'GitHub',
        version: '1.0.0',
        description: 'd',
        official: true,
        installed: true,
        enabled: true,
        egressDomains: [],
        recommendedFor: [],
        tools: [],
      },
      undefined,
    );
  const props = (pluginId: string) => ({
    title: 'GitHub',
    pluginId,
    state: 'ready' as const,
    view: view(pluginId),
    policyKnown: true,
    offline: false,
    webUrl: 'https://api.example.com/settings?section=plugins',
    onBack: () => {},
    onRetry: () => {},
    onOpenWeb: () => {},
  });

  it('GitHub 카드는 알림과 도구 두 얼굴을 말하고 구독은 웹에서 한다고 말한다', () => {
    render(<AppDetailView {...props('com.momo.plugins.github')} />);
    expect(screen.getByTestId('app-detail-github-face-notify')).toHaveTextContent(/알림 · 팀 전체 · oort 서버가 받아요/);
    expect(screen.getByTestId('app-detail-github-face-tools')).toHaveTextContent(/도구 · 각자 에이전트/);
    expect(screen.getByTestId('app-detail-github-phone-note')).toHaveTextContent(/웹이나 데스크탑에서 해요/);
  });

  it('다른 앱에는 얼굴이 없다', () => {
    render(<AppDetailView {...props('com.momo.plugins.notion')} />);
    expect(screen.queryByTestId('app-detail-github-faces')).toBeNull();
  });

  it('서버가 GitHub 알림을 싣지 않으면 알림 얼굴이 숨고 도구 얼굴만 남는다', () => {
    const real = surfaces.isSurfaceProvided;
    jest
      .spyOn(surfaces, 'isSurfaceProvided')
      .mockImplementation(id => (id === 'githubNotifications' ? false : real(id)));
    render(<AppDetailView {...props('com.momo.plugins.github')} />);
    expect(screen.queryByTestId('app-detail-github-face-notify')).toBeNull();
    expect(screen.queryByTestId('app-detail-github-phone-note')).toBeNull();
    expect(screen.getByTestId('app-detail-github-face-tools')).toBeTruthy();
  });
});
