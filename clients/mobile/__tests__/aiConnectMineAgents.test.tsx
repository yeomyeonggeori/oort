import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {cleanup, render, screen} from '@testing-library/react-native';
import React from 'react';

import {AiConnectCard} from '../src/features/aiConnect/AiConnectCard';
import {AI_HUB_COPY} from '@momo/core/features/ai/aiHubModel';

// AIH-4 (#3399): 폰 「내 계정 · 맥」 절의 내 구독으로 쓰는 에이전트 상태(읽기 전용).
// 로그인은 맥에서 하고, Claude 에이전트는 보수 모드(#3397) 동안 「문의 중」이며
// 부를 수 있다고 말하지 않는다. 못 읽으면 없다고 하지 않는다.

const ME = 'me-1';
const mockDirectory = jest.fn();
const mockHosted = jest.fn();

jest.mock('../src/features/workspace/queries', () => ({
  useDirectory: () => mockDirectory(),
}));
jest.mock('../src/features/hostedAgents/queries', () => ({
  useHostedConnections: () => mockHosted(),
}));
jest.mock('@momo/core/features/settings/api', () => {
  const actual = jest.requireActual('@momo/core/features/settings/api');
  return {...actual, fetchProviderLink: () => new Promise(() => {}), testProviderLink: () => new Promise(() => {})};
});

const agent = (id: string, name: string, owner: string) => ({
  id,
  kind: 'agent',
  displayName: name,
  ownerHumanId: owner,
});
const conn = (agentMemberId: string, harness: string) => ({
  agentMemberId,
  status: 'active',
  subscriptionHarness: harness,
});

function ready(members: unknown[], connections: unknown[]) {
  mockDirectory.mockReturnValue({isPending: false, isError: false, directory: {members}});
  mockHosted.mockReturnValue({isPending: false, isError: false, data: connections});
}

function card(withMine = true) {
  const client = new QueryClient({defaultOptions: {queries: {retry: false, gcTime: Infinity}}});
  return render(
    <QueryClientProvider client={client}>
      <AiConnectCard
        line={null}
        offline={false}
        onClose={() => {}}
        mine={withMine ? {workspaceId: 'w1', memberId: ME} : undefined}
      />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

function textOf(testId: string): string {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (typeof node === 'string') out.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object' && 'props' in node) walk((node as {props: {children?: unknown}}).props.children);
  };
  walk(screen.getByTestId(testId).props.children);
  return out.join('');
}

describe('폰 내 계정 절 — 내 구독으로 쓰는 에이전트 (AIH-4)', () => {
  it('로그인은 맥이라고 말하고, Claude 에이전트는 문의 중이며 부를 수 있다고 하지 않는다', () => {
    ready([agent('a1', '성재-claude', ME), agent('a2', '서연-codex', 'other')], [conn('a1', 'claude_code'), conn('a2', 'codex')]);
    card();
    expect(screen.getByText(AI_HUB_COPY.phoneAccountsNotice)).toBeTruthy();
    const text = textOf('ai-connect-card-mine-claude_code');
    expect(text).toContain('에이전트 @성재-claude');
    expect(text).toContain('문의 중');
    expect(text).not.toMatch(/연결됨|부를 수 있|나만 부름|켜짐/);
    // 남의 Codex 에이전트는 내 줄에 오르지 않는다.
    expect(textOf('ai-connect-card-mine-codex')).toContain('아직 에이전트 없음');
  });

  it('Codex 에이전트는 나만 부름이다', () => {
    ready([agent('a3', '성재-codex', ME)], [conn('a3', 'codex')]);
    card();
    const text = textOf('ai-connect-card-mine-codex');
    expect(text).toContain('에이전트 @성재-codex');
    expect(text).toContain('나만 부름');
  });

  it('못 읽으면 없다고 하지 않고 줄을 만들지 않는다', () => {
    mockDirectory.mockReturnValue({isPending: false, isError: false, directory: {members: []}});
    mockHosted.mockReturnValue({isPending: false, isError: true, data: undefined});
    card();
    expect(screen.queryByTestId('ai-connect-card-mine-agents')).toBeNull();
    expect(screen.queryByText(/아직 에이전트 없음/)).toBeNull();
  });

  it('범위를 주지 않으면 맥 안내 한 줄만 남는다(기존 호출부 그대로)', () => {
    card(false);
    expect(screen.getByText(AI_HUB_COPY.phoneAccountsNotice)).toBeTruthy();
    expect(screen.queryByTestId('ai-connect-card-mine-agents')).toBeNull();
  });
});
