// @vitest-environment jsdom
import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {MemoryRouter} from 'react-router-dom';
import {QueryClient, QueryClientProvider, useQuery} from '@tanstack/react-query';
import {expect, it, vi} from 'vitest';
import type {Channel} from '@momo/core/lib/api';
import {CHANNEL_MUTE_FAILURE} from '@momo/core/features/channels/model';
import {channelActionItemsForSurface} from '@momo/core/features/channels/actionModel';
import {useChannelActions, type ChannelActions} from './channelActions';

const api = vi.hoisted(() => vi.fn());
vi.mock('@momo/core/lib/api', async original => ({
  ...await original<typeof import('@momo/core/lib/api')>(),
  setChannelNotificationPref: api,
}));

it('웹 두 메뉴는 응답 전 현재 상태를 바꾸고 실패는 해당 채널만 되돌려요', async () => {
  api.mockReset();
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  const client = new QueryClient({defaultOptions: {queries: {retry: false, staleTime: Infinity, gcTime: 0}}});
  const rows: Channel[] = [
    {id: 'c1', workspaceId: 'ws', kind: 'public', name: 'one', muted: false},
    {id: 'c2', workspaceId: 'ws', kind: 'public', name: 'two', muted: false},
  ];
  client.setQueryData(['channels', 'ws'], rows);
  let actions!: ChannelActions;
  const done = vi.fn();
  function Probe() {
    const {data} = useQuery<Channel[]>({queryKey: ['channels', 'ws'], queryFn: async () => rows, enabled: false});
    actions = useChannelActions({workspaceId: 'ws', channel: data![0], title: 'one', selfMemberId: 'me', selfRole: 'owner', onActionSucceeded: done});
    return null;
  }
  const host = document.createElement('div'); const root = createRoot(host);
  const flush = async () => { await act(async () => { await new Promise(yes => setTimeout(yes, 0)); }); };
  let reject!: (error: Error) => void;
  let resolve!: () => void;
  api.mockImplementationOnce(() => new Promise((_, no) => { reject = no; }));
  try {
    act(() => root.render(<MemoryRouter future={{v7_startTransition: true, v7_relativeSplatPath: true}}><QueryClientProvider client={client}><Probe /></QueryClientProvider></MemoryRouter>));
    act(() => actions.run('mute'));
    await flush();
    expect(actions.state.muted).toBe(true);
    for (const surface of ['header', 'row'] as const) {
      const item = channelActionItemsForSurface(surface, actions.available, actions.state).find(row => row.key === 'mute');
      expect(item).toMatchObject({label: '알림 꺼짐', icon: '🔕'});
      expect(item?.busyLabel).toBeUndefined();
    }
    act(() => actions.run('mute')); expect(api).toHaveBeenCalledTimes(1);
    act(() => client.setQueryData<Channel[]>(['channels', 'ws'], old => old!.map(row => row.id === 'c2' ? {...row, muted: true} : row)));
    await act(async () => { reject(new Error('offline')); }); await flush();
    expect(client.getQueryData<Channel[]>(['channels', 'ws'])!.map(row => row.muted)).toEqual([false, true]);
    expect(actions.state.muted).toBe(false); expect(actions.error).toBe(CHANNEL_MUTE_FAILURE);
    api.mockImplementationOnce(() => new Promise<void>(yes => { resolve = yes; }));
    act(() => actions.run('mute')); await flush();
    expect(actions.state.muted).toBe(true);
    await act(async () => { resolve(); }); await flush();
    expect(done).toHaveBeenCalledTimes(1); expect(actions.error).toBeNull();
  } finally { act(() => root.unmount()); client.clear(); }
});

it.each([
  {workspaceId: 'ws', channelId: 'c2'},
  {workspaceId: 'other-ws', channelId: 'c1'},
].flatMap(destination => ['cancel', 'request'].map(phase => ({...destination, phase}))))('$phase 대기 중 $workspaceId/$channelId로 이동해도 원래 채널만 요청·복구·무효화해요', async destination => {
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  api.mockReset();
  const client = new QueryClient({defaultOptions: {queries: {retry: false, gcTime: Infinity}}});
  const original: Channel = {id: 'c1', workspaceId: 'ws', kind: 'public', name: 'one', muted: false};
  const other: Channel = {id: 'c2', workspaceId: 'ws', kind: 'public', name: 'two', muted: true};
  const elsewhere: Channel = {...other, id: 'c1', workspaceId: 'other-ws'};
  client.setQueryData(['channels', 'ws'], [original, other]);
  client.setQueryData(['channels', 'other-ws'], [elsewhere]);
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  // onMutate가 기다리는 사이 이동하면 mutationFn도 새 옵션을 받는다.
  let finishCancel!: () => void;
  vi.spyOn(client, 'cancelQueries').mockImplementationOnce(() => new Promise<void>(yes => { finishCancel = yes; }));
  let reject!: (error: Error) => void;
  api.mockImplementationOnce(() => new Promise((_, no) => { reject = no; }));
  let actions!: ChannelActions;
  function Probe({workspaceId, channelId}: {workspaceId: string; channelId: string}) {
    const {data} = useQuery<Channel[]>({queryKey: ['channels', workspaceId], queryFn: async () => { throw new Error('offline'); }, enabled: false});
    const channel = data!.find(row => row.id === channelId)!;
    actions = useChannelActions({workspaceId, channel, title: channel.name!, selfMemberId: 'me', selfRole: 'owner', onActionSucceeded: vi.fn()});
    return null;
  }
  const root = createRoot(document.createElement('div'));
  const renderTarget = (workspaceId: string, channelId: string) => root.render(
    <MemoryRouter future={{v7_startTransition: true, v7_relativeSplatPath: true}}>
      <QueryClientProvider client={client}><Probe workspaceId={workspaceId} channelId={channelId} /></QueryClientProvider>
    </MemoryRouter>,
  );
  const flush = async () => { await act(async () => { await new Promise(yes => setTimeout(yes, 0)); }); };
  try {
    act(() => renderTarget('ws', 'c1'));
    act(() => actions.run('mute'));
    await flush();
    if (destination.phase === 'request') {
      await act(async () => { finishCancel(); });
    }
    act(() => renderTarget(destination.workspaceId, destination.channelId));
    if (destination.phase === 'cancel') {
      await act(async () => { finishCancel(); });
    }
    await flush();
    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith('ws', 'c1', true);
    expect(client.getQueryData<Channel[]>(['channels', 'ws'])!.map(row => row.muted)).toEqual([true, true]);
    // 별도 채널의 동시 편집도 롤백으로 덮어쓰지 않는다.
    act(() => client.setQueryData<Channel[]>(['channels', 'ws'], rows => rows!.map(row => row.id === 'c2' ? {...row, topic: 'edited'} : row)));
    await act(async () => { reject(new Error('offline')); });
    await flush();
    expect(client.getQueryData<Channel[]>(['channels', 'ws'])).toEqual([original, {...other, topic: 'edited'}]);
    expect(client.getQueryData<Channel[]>(['channels', 'other-ws'])).toEqual([elsewhere]);
    expect(actions.state.muted).toBe(true);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({queryKey: ['channels', 'ws']});
  } finally {
    act(() => root.unmount());
    client.clear();
  }
});
