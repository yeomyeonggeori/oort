import React from 'react';
import {AccessibilityInfo, Animated} from 'react-native';
import {act, cleanup, render, renderHook, screen} from '@testing-library/react-native';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {type Channel, setChannelNotificationPref} from '@momo/core/lib/api';
import {typingLabel, typingVisualSegments} from '@momo/core/features/chat/typing';
import {CHANNEL_MUTE_FAILURE} from '@momo/core/features/channels/model';
import {TypingBar, TYPING_RESERVE} from '../src/features/conversation/TypingBar';
import {useChannelRowActions} from '../src/features/sidebar/useChannelRowActions';
import type {ChannelRowTarget} from '../src/features/sidebar/channelRowActions';

jest.mock('../src/features/inbox/useInbox', () => ({useMarkRead: () => jest.fn()}));

jest.mock('@momo/core/lib/api', () => ({
  ...jest.requireActual('@momo/core/lib/api'),
  setChannelNotificationPref: jest.fn(),
}));

afterEach(() => { cleanup(); jest.restoreAllMocks(); });

it('작성 중은 동작 줄이기에 점을 멈추고 이름·낭독·빈 높이를 유지해요', async () => {
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
  const loop = jest.spyOn(Animated, 'loop');
  const names = ['A', 'B', 'C'];
  const {rerender} = render(<TypingBar segments={typingVisualSegments(names)} label={typingLabel(names)} />);
  await act(async () => {});
  expect(screen.getByText('A')).toBeTruthy();
  expect(screen.getByText(' 외 ')).toBeTruthy();
  expect(screen.getAllByTestId('responding-dot-still', {includeHiddenElements: true})).toHaveLength(3);
  expect(screen.queryAllByTestId('responding-dot-moving', {includeHiddenElements: true})).toHaveLength(0);
  expect(loop).not.toHaveBeenCalled();
  expect(screen.getByTestId('composer-typing').props.accessibilityLabel).toBe('3명이 작성 중');
  const shownStyle = screen.getByTestId('composer-typing').props.style;
  expect(shownStyle.minHeight + shownStyle.marginBottom).toBe(TYPING_RESERVE);
  rerender(<TypingBar segments={[]} />);
  const empty = screen.getByTestId('composer-typing', {includeHiddenElements: true});
  expect(empty.props.style).toEqual(shownStyle);
  expect(screen.queryByTestId('responding-dots')).toBeNull();
});

it('폰은 응답 전에 알림을 바꾸고 중복 요청을 막으며 실패는 해당 채널만 되돌려요', async () => {
  const client = new QueryClient({defaultOptions: {queries: {retry: false, gcTime: Infinity}}});
  const channels: Channel[] = [
    {id: 'c1', workspaceId: 'ws', kind: 'public', name: 'one', muted: false},
    {id: 'c2', workspaceId: 'ws', kind: 'public', name: 'two', muted: false},
  ];
  client.setQueryData(['channels', 'ws'], channels);
  const target: ChannelRowTarget = {channel: channels[0], title: 'one', muted: false, selfRole: 'owner', readState: null};
  const {result, unmount} = renderHook(() => useChannelRowActions('ws', 'me'), {
    wrapper: ({children}) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
  let reject!: (reason: Error) => void;
  let resolve!: (value: boolean) => void;
  const api = jest.mocked(setChannelNotificationPref);
  api.mockReset();
  api.mockImplementationOnce(() => new Promise((_, no) => { reject = no; }));
  act(() => { result.current.open(target); result.current.run(target, 'mute'); result.current.run(target, 'mute'); });
  await act(async () => {});
  const rows = () => client.getQueryData<Channel[]>(['channels', 'ws'])!;
  expect(api).toHaveBeenCalledTimes(1);
  expect(rows()[0].muted).toBe(true);
  expect(result.current.active?.muted).toBe(true);
  client.setQueryData<Channel[]>(['channels', 'ws'], old => old!.map(row => row.id === 'c2' ? {...row, muted: true} : row));
  await act(async () => { reject(new Error('offline')); });
  expect(rows().map(row => row.muted)).toEqual([false, true]);
  expect(result.current.active?.muted).toBe(false);
  expect(result.current.error).toBe(CHANNEL_MUTE_FAILURE);
  api.mockImplementationOnce(() => new Promise<boolean>(yes => { resolve = yes; }));
  act(() => result.current.run(target, 'mute'));
  await act(async () => {});
  expect(rows()[0].muted).toBe(true);
  await act(async () => { resolve(true); });
  expect(rows()[0].muted).toBe(true);
  expect(result.current.error).toBeNull();
  unmount(); client.clear();
});

it.each(['ws', 'other-ws'])('폰은 요청 중 %s의 다른 채널을 열어도 원래 채널만 되돌려요', async nextWorkspaceId => {
  const client = new QueryClient({defaultOptions: {queries: {retry: false, gcTime: Infinity}}});
  const original: Channel = {id: 'c1', workspaceId: 'ws', kind: 'public', name: 'one', muted: false};
  const other: Channel = {id: 'c2', workspaceId: 'ws', kind: 'public', name: 'two', muted: true};
  const elsewhere: Channel = {...other, id: 'c1', workspaceId: 'other-ws'};
  client.setQueryData(['channels', 'ws'], [original, other]);
  client.setQueryData(['channels', 'other-ws'], [elsewhere]);
  const invalidate = jest.spyOn(client, 'invalidateQueries');
  const target: ChannelRowTarget = {channel: original, title: 'one', muted: false, selfRole: 'owner', readState: null};
  const nextChannel = nextWorkspaceId === 'ws' ? other : elsewhere;
  const nextTarget: ChannelRowTarget = {...target, channel: nextChannel, title: 'two', muted: true};
  const {result, rerender, unmount} = renderHook(({workspaceId}: {workspaceId: string}) => useChannelRowActions(workspaceId, 'me'), {
    initialProps: {workspaceId: 'ws'},
    wrapper: ({children}) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
  let reject!: (reason: Error) => void;
  const api = jest.mocked(setChannelNotificationPref);
  api.mockReset();
  api.mockImplementationOnce(() => new Promise((_, no) => { reject = no; }));
  try {
    act(() => { result.current.open(target); result.current.run(target, 'mute'); });
    await act(async () => {});
    expect(client.getQueryData<Channel[]>(['channels', 'ws'])![0].muted).toBe(true);
    rerender({workspaceId: nextWorkspaceId});
    act(() => result.current.open(nextTarget));
    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith('ws', 'c1', true);
    await act(async () => { reject(new Error('offline')); });
    expect(client.getQueryData<Channel[]>(['channels', 'ws'])).toEqual([original, other]);
    expect(client.getQueryData<Channel[]>(['channels', 'other-ws'])).toEqual([elsewhere]);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({queryKey: ['channels', 'ws']});
  } finally {
    unmount();
    client.clear();
  }
});
