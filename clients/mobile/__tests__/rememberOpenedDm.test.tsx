import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {act, renderHook} from '@testing-library/react-native';
import type {Channel} from '@momo/core/lib/api';
import React from 'react';

import {
  useRememberOpenedDm,
  workspaceKeys,
} from '../src/features/workspace/queries';

// =============================================================================
// #4016 — 처음 연 에이전트 DM 의 머리에 상대 얼굴이 없던 원인.
//
// `openDirectMessage` 가 돌려준 채널이 채널 목록 캐시에 없으면 `ConversationScreen` 의
// `channel` 이 null 이라 머리의 `kind === 'dm'` 판정이 서지 못했다(3047 실기기 첫 캡처:
// grok DM 머리에 이름만). 응답을 캐시에 넣는 것이 이 시험의 대상이다.
// =============================================================================

const WS = 'ws-1';

function dm(id: string): Channel {
  return {
    id,
    workspaceId: WS,
    kind: 'dm',
    name: '',
    memberIds: ['self', 'grok'],
  } as unknown as Channel;
}

function setup() {
  const client = new QueryClient();
  const invalidate = jest.spyOn(client, 'invalidateQueries').mockResolvedValue();
  const wrapper = ({children}: {children: React.ReactNode}) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const {result} = renderHook(() => useRememberOpenedDm(WS), {wrapper});
  return {client, invalidate, remember: result.current};
}

it('목록에 없던 DM 을 캐시에 넣고 서버 목록을 다시 읽게 한다', () => {
  const {client, invalidate, remember} = setup();
  client.setQueryData(workspaceKeys.channels(WS), [dm('a')]);

  act(() => remember(dm('b')));

  const cached = client.getQueryData<Channel[]>(workspaceKeys.channels(WS)) ?? [];
  expect(cached.map(c => c.id)).toEqual(['a', 'b']);
  expect(invalidate).toHaveBeenCalledWith({queryKey: workspaceKeys.channels(WS)});
});

it('이미 있는 DM 은 중복으로 들어가지 않는다', () => {
  const {client, remember} = setup();
  client.setQueryData(workspaceKeys.channels(WS), [dm('a')]);

  act(() => remember(dm('A')));

  expect(client.getQueryData<Channel[]>(workspaceKeys.channels(WS))).toHaveLength(1);
});

it('목록을 아직 읽기 전이어도 채널 하나로 시작한다', () => {
  const {client, remember} = setup();
  act(() => remember(dm('a')));
  expect(client.getQueryData<Channel[]>(workspaceKeys.channels(WS))).toHaveLength(1);
});
