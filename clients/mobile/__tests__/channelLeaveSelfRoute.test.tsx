import React from 'react';
import {act, renderHook} from '@testing-library/react-native';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {ApiError, leaveChannel, removeChannelMember, type Channel} from '@momo/core/lib/api';
import {catalog as koCatalog} from '@momo/core/i18n/generated/ko-KR';
import {createMessageService} from '@momo/core/i18n/service';
import {useChannelRowActions} from '../src/features/sidebar/useChannelRowActions';
import type {ChannelRowTarget} from '../src/features/sidebar/channelRowActions';

// =============================================================================
// 폰의 「채널 나가기」가 **본인 나가기 길**을 부른다 (#5778).
//
// 행 시트 · 대화 머리 ⋮ 시트 · 채널 정보 페이지가 모두 이 훅의 `confirmLeave` 를 지난다. 예전에는 관리자 전용
// `removeChannelMember`(`…/members/{내 id}`)로 자기를 지워서, 일반 멤버·게스트는 서버에서 403 을 받았다(2026-11-14 로컬
// 스택 실측: 「workspace owner or admin role required」). 이 시험은 그 길이 다시 불리면 붉다.
// =============================================================================

jest.mock('../src/features/inbox/useInbox', () => ({useMarkRead: () => jest.fn()}));

jest.mock('@momo/core/lib/api', () => ({
  ...jest.requireActual('@momo/core/lib/api'),
  leaveChannel: jest.fn(),
  removeChannelMember: jest.fn(),
}));

const ko = createMessageService({messageLocale: 'ko-KR', catalog: koCatalog});

function setup(selfRole: ChannelRowTarget['selfRole']) {
  const client = new QueryClient({defaultOptions: {queries: {retry: false, gcTime: Infinity}}});
  const channels: Channel[] = [
    {id: 'c1', workspaceId: 'ws', kind: 'private', name: 'design-room', muted: false},
    {id: 'c2', workspaceId: 'ws', kind: 'public', name: 'general', muted: false},
  ];
  client.setQueryData(['channels', 'ws'], channels);
  const target: ChannelRowTarget = {channel: channels[0], title: 'design-room', muted: false, selfRole, readState: null};
  const left: string[] = [];
  const hook = renderHook(() => useChannelRowActions('ws', 'me', id => left.push(id)), {
    wrapper: ({children}) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
  const rows = () => client.getQueryData<Channel[]>(['channels', 'ws'])!.map(row => row.id);
  return {client, target, hook, left, rows};
}

beforeEach(() => {
  jest.mocked(leaveChannel).mockReset();
  jest.mocked(removeChannelMember).mockReset();
});

it.each(['member', 'guest'] as const)('%s 가 나가면 관리자 길이 아니라 본인 나가기 길을 부르고, 답한 뒤에 목록에서 걷어요', async role => {
  const {client, target, hook, left, rows} = setup(role);
  jest.mocked(leaveChannel).mockResolvedValue({channelId: 'c1', memberId: 'me', archived: false});
  act(() => { hook.result.current.open(target); hook.result.current.run(target, 'leave'); });
  expect(hook.result.current.confirmingLeave).toBe(true);
  await act(async () => { hook.result.current.confirmLeave(); });
  expect(jest.mocked(leaveChannel)).toHaveBeenCalledWith('ws', 'c1');
  expect(jest.mocked(removeChannelMember)).not.toHaveBeenCalled();
  expect(rows()).toEqual(['c2']);
  expect(left).toEqual(['c1']);
  hook.unmount(); client.clear();
});

it('거절(403)되면 확인 단계가 서서 사전의 사유 문장을 말하고 목록은 그대로예요', async () => {
  const {client, target, hook, rows} = setup('member');
  jest.mocked(leaveChannel).mockRejectedValue(new ApiError(403, 'active channel membership required'));
  act(() => { hook.result.current.open(target); hook.result.current.run(target, 'leave'); });
  await act(async () => { hook.result.current.confirmLeave(); });
  expect(hook.result.current.confirmingLeave).toBe(true);
  expect(hook.result.current.leave.error).toBe(ko.formatMessage('timeline.channelLeave.errorForbidden'));
  expect(rows()).toEqual(['c1', 'c2']);
  hook.unmount(); client.clear();
});

it('404 는 「이미 나간 것」이에요: 문장을 세우지 않고 줄을 걷고 나간 뒤처럼 이어져요 (#5818 검수 r2, 웹과 같음)', async () => {
  const {client, target, hook, rows, left} = setup('member');
  jest.mocked(leaveChannel).mockRejectedValue(new ApiError(404, 'active channel membership not found'));
  act(() => { hook.result.current.open(target); hook.result.current.run(target, 'leave'); });
  await act(async () => { hook.result.current.confirmLeave(); });
  expect(hook.result.current.leave.error).toBeNull();
  expect(rows()).toEqual(['c2']);
  expect(left).toEqual(['c1']);
  hook.unmount(); client.clear();
});
