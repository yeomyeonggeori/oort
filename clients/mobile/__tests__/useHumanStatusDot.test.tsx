import type {Member, RosterMember} from '@momo/core/lib/api';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {cleanup, renderHook} from '@testing-library/react-native';
import React from 'react';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {useHumanStatusDot} from '../src/features/presence/useHumanStatusDot';
import {
  RealtimeContext,
  type RealtimeContextValue,
} from '../src/realtime/RealtimeProvider';
import {SessionProvider} from '../src/session/useSession';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';

// =============================================================================
// 사람 한 명의 상태 점을 폰의 비홈 표면(새 DM 시트, 곧 프로필 시트)이 같은 판정으로 읽게 하는 공용 훅(#4692).
// 판정은 코어의 `humanPresenceDot` 이고(코어 시험이 잰다), 이 훅의 일은 두 가지 배선이다: 보는 사람 **자기
// 행**은 이 폰 자신의 소켓 연결을 따르고, 남의 행은 서버의 `online` 을 그대로 읽는다. 에이전트에는 점이 없다.
// 새 DM 시트는 자기 자신을 목록에서 빼므로, 자기 행 배선은 이 파일이 아니면 어디서도 잴 수 없다.
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const SELF: Member = {
  id: '11111111-1111-4111-8111-111111111111',
  workspaceId: WS,
  kind: 'human',
  displayName: '박서연',
  handle: 'seoyeon',
};

function person(over: Partial<RosterMember> & {id: string}): RosterMember {
  return {
    workspaceId: WS,
    kind: 'human',
    status: 'active',
    displayName: '이도현',
    handle: 'dohyun',
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  } as RosterMember;
}

const OTHER = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const AGENT = 'cccccccc-1111-4111-8111-cccccccccccc';

let queryClient: QueryClient | null = null;

beforeEach(() => {
  __resetSessionStore();
  sessionPort.applyLogin({
    accessToken: 'access-token-1',
    refreshToken: 'refresh-token-1',
    realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
    member: SELF,
  });
});

afterEach(() => {
  cleanup();
  queryClient?.clear();
  queryClient = null;
});

function dotFor(
  row: RosterMember | null,
  status: RealtimeContextValue['status'] = 'connected',
) {
  queryClient = new QueryClient();
  const client = queryClient;
  const realtime: RealtimeContextValue = {
    rail: null,
    status,
    subscriptionsWanted: true,
  };
  const {result} = renderHook(() => useHumanStatusDot(row), {
    wrapper: ({children}: {children: React.ReactNode}) => (
      <QueryClientProvider client={client}>
        <SessionProvider member={SELF}>
          <RealtimeContext.Provider value={realtime}>
            {children}
          </RealtimeContext.Provider>
        </SessionProvider>
      </QueryClientProvider>
    ),
  });
  return result.current;
}

describe('useHumanStatusDot (#4692)', () => {
  it('남의 행은 서버의 `online` 그대로다 — 내 소켓이 끊겨 있어도 바뀌지 않는다', () => {
    expect(dotFor(person({id: OTHER, online: true}), 'disconnected')).toEqual({
      tone: 'ok',
      label: '온라인',
    });
    expect(dotFor(person({id: OTHER, online: false}), 'connected')).toEqual({
      tone: 'muted',
      label: '오프라인',
    });
    expect(dotFor(person({id: OTHER}), 'connected')).toBeNull(); // 모름은 점이 없다
  });

  it('자기 행은 이 폰의 소켓 연결을 따른다 — 서버가 비어 있어도, 틀려도', () => {
    const own = (patch: Partial<RosterMember>) => person({id: SELF.id, ...patch});
    expect(dotFor(own({}), 'connected')?.tone).toBe('ok');
    expect(dotFor(own({online: false}), 'connected')?.tone).toBe('ok');
    expect(dotFor(own({online: true}), 'disconnected')?.tone).toBe('muted');
    expect(dotFor(own({}), 'connecting')?.tone).toBe('muted');
  });

  it('스스로 정한 자리 비움은 연결보다 먼저다', () => {
    expect(
      dotFor(person({id: OTHER, online: true, presenceStatus: 'away'}))?.label,
    ).toBe('자리 비움');
  });

  it('에이전트와 빈 행에는 점이 없다 — 에이전트의 생존감은 서버의 생존 판정이다', () => {
    expect(dotFor(person({id: AGENT, kind: 'agent', online: true}))).toBeNull();
    expect(dotFor(null)).toBeNull();
  });
});
