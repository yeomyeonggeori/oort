import type {Channel} from '@momo/core/lib/api';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {act, renderHook, waitFor} from '@testing-library/react-native';
import React from 'react';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {useChannelRowActions} from '../src/features/sidebar/useChannelRowActions';
import type {ChannelRowTarget} from '../src/features/sidebar/channelRowActions';
import {workspaceKeys} from '../src/features/workspace/queries';

// 「이름 바꾸기」의 왕복 (ADR-0225 D10, #5835): 성공하면 채널 목록 캐시의 줄이 응답의 새 이름이 되고(홈 줄 · 대화 머리가 같은 캐시를 읽는다) 시트가 닫힌다.
// 거절이면 시트는 열린 채 단계가 거절 문장의 종류를 든다.

const api = jest.requireActual('@momo/core/lib/api') as typeof import('@momo/core/lib/api');
const mockRename = jest.fn();
jest.mock('@momo/core/features/channels/rename', () => ({
  ...jest.requireActual('@momo/core/features/channels/rename'),
  renameChannel: (...args: unknown[]) => mockRename(...args),
}));
jest.mock('../src/features/inbox/useInbox', () => ({useMarkRead: () => jest.fn()}));

const WS = 'ws-1';
const channel: Channel = {id: 'c1', workspaceId: WS, kind: 'public', name: 'ops-room', muted: false};
const target: ChannelRowTarget = {
  channel,
  title: 'ops-room',
  muted: false,
  selfRole: 'admin',
  readState: null,
};

function mount() {
  const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
  client.setQueryData(workspaceKeys.channels(WS), [channel]);
  const wrapper = ({children}: {children: React.ReactNode}) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const view = renderHook(() => useChannelRowActions(WS, 'me'), {wrapper});
  return {client, view};
}

beforeEach(() => mockRename.mockReset());

it('성공하면 목록 캐시의 줄이 새 이름이 되고 시트가 닫힌다', async () => {
  const {client, view} = mount();
  act(() => view.result.current.open(target));
  act(() => view.result.current.run(target, 'rename'));
  expect(view.result.current.rename).toEqual({pending: false, failure: null});
  mockRename.mockResolvedValue({...channel, name: 'design-review'});
  act(() => view.result.current.confirmRename('design-review'));
  await waitFor(() => expect(view.result.current.active).toBeNull());
  expect(mockRename).toHaveBeenCalledWith(WS, 'c1', 'design-review');
  expect(client.getQueryData<Channel[]>(workspaceKeys.channels(WS))?.[0]?.name).toBe('design-review');
  expect(view.result.current.rename).toBeNull();
});

it('general 은 줄이 아니라 열쇠로도 단계가 서지 않는다', () => {
  const {view} = mount();
  const locked = {...target, channel: {...channel, name: 'general'}, title: 'general'};
  act(() => view.result.current.open(locked));
  act(() => view.result.current.run(locked, 'rename'));
  expect(view.result.current.rename).toBeNull();
});

it('409 general 잠금은 시트를 연 채 단계가 거절 종류를 든다', async () => {
  const {client, view} = mount();
  act(() => view.result.current.open(target));
  act(() => view.result.current.run(target, 'rename'));
  mockRename.mockRejectedValue(new api.ApiError(409, 'locked', 'general_channel_locked'));
  act(() => view.result.current.confirmRename('design-review'));
  await waitFor(() => expect(view.result.current.rename?.failure?.kind).toBe('generalLocked'));
  expect(view.result.current.active).not.toBeNull();
  expect(client.getQueryData<Channel[]>(workspaceKeys.channels(WS))?.[0]?.name).toBe('ops-room');
});
