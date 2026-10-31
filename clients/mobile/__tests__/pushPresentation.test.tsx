import type {Channel, RosterMember} from '@momo/core/lib/api';
import {act, cleanup, render, renderHook} from '@testing-library/react-native';
import {requireOptionalNativeModule} from 'expo-modules-core';
import React from 'react';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {
  clearPresentationState,
  exportAvatarForPush,
  exportChannelsForPush,
  isPushPreviewOn,
  isPushShowSenderOn,
  presentationChannels,
  setPushPreview,
  setPushShowSender,
  syncPresentationSettings,
  usePushPreview,
  usePushShowSender,
} from '../src/push/presentation';
import PushPresentationSync from '../src/push/PushPresentationSync';
import {NON_SECRET_KEYS} from '../src/storage/kv';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// 푸시 알림의 「보이는 모양」을 앱이 알림 확장에게 건네는 길 (ADR-0204 증보 5).
//
// 확장은 MMKV 도 앱의 사진·채널 목록도 읽지 못하고, 서버의 두 읽기 경로만 부를 수 있다. 그래서 설정 둘,
// 앱이 그린 얼굴, 채널 이름은 앱이 네이티브 모듈(`MomoPushNative`)로 App Group 에 쓴다. 이 파일이 재는 것:
//
//   1. 설정 둘은 한 번도 건드리지 않은 폰에서 **켜져** 있고, 바꾸면 두 값이 **함께** 확장 쪽으로 간다
//   2. 「보낸 사람 표시」를 끄면 이미 건넨 것을 거둔다(지우기 1회) — 설정을 쓴 **뒤에**
//   3. 얼굴은 멤버 아바타 content 경로의 모양일 때만, 이 실행에서 한 번만 간다
//   4. 채널 목록은 보관된 것을 빼고 DM 은 이름 없이 둘, 방은 명부에서 센 멤버 수를 싣는다
//   5. 어느 호출도 던지지 않고, 네이티브 모듈이 없는 빌드에서는 아무 일도 하지 않는다
//
// Swift 쪽 판정(캐시 한도·사진 순서·계획)은 `momo-push-native/sim-check` 가 컴파일해 돌린다.
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const DOHYUN = '99999999-9999-4999-8999-999999999999';
const SEOYEON = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const VERSION = 'aaaa1111-bbbb-4ccc-8ddd-eeee22223333';
const BASE = 'https://api.example.com';
const CONTENT = `/v1/workspaces/${WS}/members/${DOHYUN}/avatar/content?v=${VERSION}`;

const mockSession = {workspaceId: WS};
let mockChannels: Channel[] | undefined;
let mockRoster: RosterMember[] | undefined;

jest.mock('../src/session/useSession', () => ({
  useSession: () => mockSession,
}));
jest.mock('../src/features/workspace/queries', () => ({
  useChannels: () => ({data: mockChannels}),
  useDirectory: () => ({data: mockRoster}),
}));

const requireNative = requireOptionalNativeModule as unknown as jest.Mock;
const mmkvStore = (
  jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}
).__store;

interface Native {
  setPresentationSettings: jest.Mock;
  exportAvatar: jest.Mock;
  exportChannels: jest.Mock;
  clearPresentation: jest.Mock;
  /** 호출 순서(모듈 전체에서): 설정을 쓴 뒤에 지우는가를 재려고. */
  order: string[];
}

function installNative(overrides: Partial<Record<keyof Omit<Native, 'order'>, jest.Mock>> = {}): Native {
  const order: string[] = [];
  const native: Native = {
    setPresentationSettings: jest.fn(async (preview: boolean, sender: boolean) => {
      order.push(`settings:${preview}:${sender}`);
      return true;
    }),
    exportAvatar: jest.fn(async () => true),
    exportChannels: jest.fn(async () => true),
    clearPresentation: jest.fn(async () => {
      order.push('clear');
      return true;
    }),
    order,
    ...overrides,
  };
  requireNative.mockImplementation((name: string) => (name === 'MomoPushNative' ? native : null));
  return native;
}

function channel(id: string, kind: Channel['kind'], name?: string, extra: Partial<Channel> = {}): Channel {
  return {id, workspaceId: WS, kind, name, muted: false, ...extra};
}

function member(id: string, channelIds: string[], extra: Partial<RosterMember> = {}): RosterMember {
  return {
    id,
    workspaceId: WS,
    kind: 'human',
    status: 'active',
    displayName: '이도현',
    handle: 'dohyun',
    channelCount: channelIds.length,
    channelIds,
    capabilities: [],
    ...extra,
  } as RosterMember;
}

beforeEach(async () => {
  mmkvStore.clear();
  __resetServerBaseCache();
  setServerBase(BASE);
  mockChannels = undefined;
  mockRoster = undefined;
  requireNative.mockImplementation(() => null);
  // 앞 시험이 건넨 기억(얼굴·채널 목록)을 비운다: 모듈 상태라 `clearPresentationState` 가 지운다.
  await clearPresentationState();
});

afterEach(() => {
  cleanup();
  requireNative.mockImplementation(() => null);
});

describe('설정 둘', () => {
  it('한 번도 건드리지 않은 폰에서는 둘 다 켜져 있고, 두 키는 비어 있다', () => {
    expect(isPushPreviewOn()).toBe(true);
    expect(isPushShowSenderOn()).toBe(true);
    expect(mmkvStore.has(NON_SECRET_KEYS.pushPreview)).toBe(false);
    expect(mmkvStore.has(NON_SECRET_KEYS.pushShowSender)).toBe(false);
  });

  it('끈 것만 \'0\' 으로 남고, 다시 켜면 키가 지워진다', () => {
    setPushPreview(false);
    expect(mmkvStore.get(NON_SECRET_KEYS.pushPreview)).toBe('0');
    expect(isPushPreviewOn()).toBe(false);
    expect(isPushShowSenderOn()).toBe(true);
    setPushPreview(true);
    expect(mmkvStore.has(NON_SECRET_KEYS.pushPreview)).toBe(false);
    expect(isPushPreviewOn()).toBe(true);
  });

  it('둘은 서로 다른 키다 — 하나를 꺼도 다른 하나는 그대로다', () => {
    setPushShowSender(false);
    expect(isPushShowSenderOn()).toBe(false);
    expect(isPushPreviewOn()).toBe(true);
    expect(NON_SECRET_KEYS.pushPreview).not.toBe(NON_SECRET_KEYS.pushShowSender);
  });

  it('바꾸면 확장이 읽는 자리에 두 값이 함께 쓰인다 — 바뀐 것만이 아니다', () => {
    const native = installNative();
    setPushPreview(false);
    expect(native.setPresentationSettings).toHaveBeenLastCalledWith(false, true);
    setPushShowSender(false);
    expect(native.setPresentationSettings).toHaveBeenLastCalledWith(false, false);
    setPushPreview(true);
    expect(native.setPresentationSettings).toHaveBeenLastCalledWith(true, false);
  });

  it('같은 값으로 바꾸면 아무것도 쓰지 않는다', () => {
    const native = installNative();
    setPushPreview(true);
    setPushShowSender(true);
    expect(native.setPresentationSettings).not.toHaveBeenCalled();
    expect(native.clearPresentation).not.toHaveBeenCalled();
  });

  it('syncPresentationSettings 는 지금 저장된 값을 그대로 쓴다(셸이 뜰 때)', () => {
    setPushShowSender(false);
    const native = installNative();
    syncPresentationSettings();
    expect(native.setPresentationSettings).toHaveBeenCalledWith(true, false);
  });

  it('훅은 바뀌면 다시 그리게 한다', () => {
    const preview = renderHook(() => usePushPreview());
    const sender = renderHook(() => usePushShowSender());
    expect(preview.result.current).toBe(true);
    expect(sender.result.current).toBe(true);
    act(() => setPushPreview(false));
    expect(preview.result.current).toBe(false);
    expect(sender.result.current).toBe(true);
    act(() => setPushShowSender(false));
    expect(sender.result.current).toBe(false);
  });

  it('네이티브 모듈이 없는 빌드에서는 저장만 하고 던지지 않는다', () => {
    expect(() => {
      setPushPreview(false);
      setPushShowSender(false);
      syncPresentationSettings();
    }).not.toThrow();
    expect(isPushPreviewOn()).toBe(false);
  });

  it('쓰기가 거절돼도(Promise reject) 던지지 않는다', async () => {
    installNative({setPresentationSettings: jest.fn(async () => Promise.reject(new Error('no group')))});
    expect(() => setPushPreview(false)).not.toThrow();
    await Promise.resolve();
  });
});

describe('「보낸 사람 표시」를 끄면', () => {
  it('설정을 쓴 뒤에 이미 건넨 것을 한 번 거둔다', () => {
    const native = installNative();
    setPushShowSender(false);
    expect(native.order).toEqual(['settings:true:false', 'clear']);
    expect(native.clearPresentation).toHaveBeenCalledTimes(1);
  });

  it('미리보기만 꺼서는 거두지 않는다', () => {
    const native = installNative();
    setPushPreview(false);
    expect(native.clearPresentation).not.toHaveBeenCalled();
  });

  it('꺼져 있는 동안에는 얼굴도 채널 이름도 건네지 않는다', () => {
    const native = installNative();
    setPushShowSender(false);
    exportAvatarForPush(CONTENT, 'file:///cache/face.img');
    exportChannelsForPush(WS, [{id: WS, kind: 'public', name: '디자인'}]);
    expect(native.exportAvatar).not.toHaveBeenCalled();
    expect(native.exportChannels).not.toHaveBeenCalled();
  });

  it('다시 켜면 같은 얼굴·목록도 다시 건넨다 — 거둔 것을 건넨 줄 알고 건너뛰지 않는다', () => {
    const native = installNative();
    exportAvatarForPush(CONTENT, 'file:///cache/face.img');
    const channels = [{id: WS, kind: 'public' as const, name: '디자인', memberCount: 3}];
    exportChannelsForPush(WS, channels);
    expect(native.exportAvatar).toHaveBeenCalledTimes(1);
    expect(native.exportChannels).toHaveBeenCalledTimes(1);
    setPushShowSender(false);
    setPushShowSender(true);
    exportAvatarForPush(CONTENT, 'file:///cache/face.img');
    exportChannelsForPush(WS, channels);
    expect(native.exportAvatar).toHaveBeenCalledTimes(2);
    expect(native.exportChannels).toHaveBeenCalledTimes(2);
  });
});

describe('앱이 그린 얼굴', () => {
  it('서버·워크스페이스·멤버·버전과 파일을 그대로 건넨다', () => {
    const native = installNative();
    exportAvatarForPush(CONTENT, 'file:///cache/face.img');
    expect(native.exportAvatar).toHaveBeenCalledWith(BASE, WS, DOHYUN, VERSION, 'file:///cache/face.img');
  });

  it('같은 얼굴은 이 실행에서 한 번만 간다 — 화면마다 그려져도 네이티브를 다시 부르지 않는다', () => {
    const native = installNative();
    for (let i = 0; i < 5; i += 1) exportAvatarForPush(CONTENT, 'file:///cache/face.img');
    expect(native.exportAvatar).toHaveBeenCalledTimes(1);
  });

  it('사진을 바꾼 멤버(다른 버전)는 다시 간다', () => {
    const native = installNative();
    exportAvatarForPush(CONTENT, 'file:///cache/a.img');
    exportAvatarForPush(CONTENT.replace(VERSION, 'bbbb2222-cccc-4ddd-8eee-ffff33334444'), 'file:///cache/b.img');
    expect(native.exportAvatar).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['다른 서버 주소의 절대 URL', 'https://cdn.example.test/legacy.png'],
    ['이 서버의 절대 URL(경로만 받는다)', `${BASE}${CONTENT}`],
    ['버전이 없는 경로', `/v1/workspaces/${WS}/members/${DOHYUN}/avatar/content`],
    ['버전이 경로인 것', `/v1/workspaces/${WS}/members/${DOHYUN}/avatar/content?v=../../secret`],
    ['추가 쿼리가 붙은 것', `${CONTENT}&x=1`],
    ['승인 카드의 미리보기 경로', `/v1/workspaces/${WS}/approvals/${SEOYEON}/avatar-preview?v=${VERSION}`],
  ])('%s 는 건네지 않는다', (_name, path) => {
    const native = installNative();
    exportAvatarForPush(path, 'file:///cache/face.img');
    expect(native.exportAvatar).not.toHaveBeenCalled();
  });

  it('디스크에 있는 파일(file://)이 아니면 건네지 않는다', () => {
    const native = installNative();
    exportAvatarForPush(CONTENT, 'https://api.example.com/avatar');
    exportAvatarForPush(CONTENT, '/cache/face.img');
    expect(native.exportAvatar).not.toHaveBeenCalled();
  });

  it('네이티브 모듈이 없거나 구버전(함수 없음)이면 아무 일도 하지 않는다', () => {
    expect(() => exportAvatarForPush(CONTENT, 'file:///cache/face.img')).not.toThrow();
    requireNative.mockImplementation((name: string) => (name === 'MomoPushNative' ? {} : null));
    expect(() => exportAvatarForPush(CONTENT, 'file:///cache/face.img')).not.toThrow();
  });
});

describe('채널 목록', () => {
  const ROOM = '33333333-3333-4333-8333-333333333333';
  const SECRET_ROOM = '44444444-4444-4444-8444-444444444444';
  const DM = '55555555-5555-4555-8555-555555555555';
  const OLD = '66666666-6666-4666-8666-666666666666';

  it('방은 이름과 명부에서 센 활성 멤버 수를, DM 은 이름 없이 둘을 싣는다', () => {
    const result = presentationChannels(
      [channel(ROOM, 'public', '디자인'), channel(SECRET_ROOM, 'private', '운영'), channel(DM, 'dm', '남의이름')],
      [
        member(DOHYUN, [ROOM.toUpperCase(), SECRET_ROOM]),
        member(SEOYEON, [ROOM]),
        member('cccccccc-cccc-4ccc-8ccc-cccccccccccc', [ROOM], {kind: 'agent'}),
        member('dddddddd-dddd-4ddd-8ddd-dddddddddddd', [ROOM], {status: 'suspended'}),
      ],
    );
    expect(result).toEqual([
      {id: ROOM, kind: 'public', name: '디자인', memberCount: 3},
      {id: SECRET_ROOM, kind: 'private', name: '운영', memberCount: 1},
      {id: DM, kind: 'dm', memberCount: 2},
    ]);
  });

  it('보관된 채널은 뺀다', () => {
    const result = presentationChannels([channel(ROOM, 'public', '디자인'), channel(OLD, 'public', '옛방', {archivedAtMs: 1})], []);
    expect(result.map(entry => entry.id)).toEqual([ROOM]);
  });

  it('멤버 수를 모르면(명부에 없음) 싣지 않는다 — 0 이라고 말하지 않는다', () => {
    const [room] = presentationChannels([channel(ROOM, 'public', '디자인')], []);
    expect(room).toEqual({id: ROOM, kind: 'public', name: '디자인'});
    expect('memberCount' in room).toBe(false);
  });

  it('이름 없는 방은 이름 칸이 없다', () => {
    const [room] = presentationChannels([channel(ROOM, 'public')], []);
    expect('name' in room).toBe(false);
  });

  it('확장이 받는 한도(512)를 넘기지 않는다', () => {
    const many = Array.from({length: 600}, (_, i) =>
      channel(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, 'public', `방 ${i}`),
    );
    expect(presentationChannels(many, [])).toHaveLength(512);
  });

  it('건네기: 서버·워크스페이스와 목록을 한 번에, 같은 목록은 다시 쓰지 않는다', () => {
    const native = installNative();
    const list = [{id: ROOM, kind: 'public' as const, name: '디자인', memberCount: 4}];
    exportChannelsForPush(WS, list);
    exportChannelsForPush(WS, [...list]);
    expect(native.exportChannels).toHaveBeenCalledTimes(1);
    expect(native.exportChannels).toHaveBeenCalledWith(BASE, WS, list);
    exportChannelsForPush(WS, [{...list[0], name: '디자인팀'}]);
    expect(native.exportChannels).toHaveBeenCalledTimes(2);
  });

  it('다른 워크스페이스의 같은 목록은 따로 건넨다', () => {
    const native = installNative();
    const list = [{id: ROOM, kind: 'public' as const, name: '디자인'}];
    exportChannelsForPush(WS, list);
    exportChannelsForPush('77777777-7777-4777-8777-777777777777', list);
    expect(native.exportChannels).toHaveBeenCalledTimes(2);
  });
});

describe('비우기', () => {
  it('지우라고 하고, 시스템이 지웠다고 답했는가를 돌려준다', async () => {
    const native = installNative();
    await expect(clearPresentationState()).resolves.toBe(true);
    expect(native.clearPresentation).toHaveBeenCalledTimes(1);
    installNative({clearPresentation: jest.fn(async () => false)});
    await expect(clearPresentationState()).resolves.toBe(false);
  });

  it('던지거나 모듈이 없어도 던지지 않는다', async () => {
    installNative({clearPresentation: jest.fn(async () => Promise.reject(new Error('boom')))});
    await expect(clearPresentationState()).resolves.toBe(false);
    requireNative.mockImplementation(() => null);
    await expect(clearPresentationState()).resolves.toBe(false);
  });

  it('건넸던 기억도 비운다 — 로그아웃 뒤 같은 얼굴이 새 사람의 폰에 다시 간다', async () => {
    const native = installNative();
    exportAvatarForPush(CONTENT, 'file:///cache/face.img');
    await clearPresentationState();
    exportAvatarForPush(CONTENT, 'file:///cache/face.img');
    expect(native.exportAvatar).toHaveBeenCalledTimes(2);
  });

  it('설정 둘은 지우지 않는다(이 폰의 취향이다)', async () => {
    setPushPreview(false);
    setPushShowSender(false);
    installNative();
    await clearPresentationState();
    expect(isPushPreviewOn()).toBe(false);
    expect(isPushShowSenderOn()).toBe(false);
  });
});

describe('셸 안의 동기화 (PushPresentationSync)', () => {
  const ROOM = '33333333-3333-4333-8333-333333333333';

  it('뜰 때 설정을 쓰고, 채널 목록을 명부의 멤버 수와 함께 건넨다', () => {
    const native = installNative();
    mockChannels = [channel(ROOM, 'public', '디자인')];
    mockRoster = [member(DOHYUN, [ROOM]), member(SEOYEON, [ROOM])];
    render(<PushPresentationSync />);
    expect(native.setPresentationSettings).toHaveBeenCalledWith(true, true);
    expect(native.exportChannels).toHaveBeenCalledWith(BASE, WS, [
      {id: ROOM, kind: 'public', name: '디자인', memberCount: 2},
    ]);
  });

  it('목록을 아직 못 읽었으면 건네지 않는다 — 빈 목록으로 지우지 않는다', () => {
    const native = installNative();
    mockChannels = undefined;
    render(<PushPresentationSync />);
    expect(native.exportChannels).not.toHaveBeenCalled();
  });

  it('명부를 아직 못 읽었어도 방 이름은 건넨다(멤버 수만 빠진다)', () => {
    const native = installNative();
    mockChannels = [channel(ROOM, 'public', '디자인')];
    mockRoster = undefined;
    render(<PushPresentationSync />);
    expect(native.exportChannels).toHaveBeenCalledWith(BASE, WS, [{id: ROOM, kind: 'public', name: '디자인'}]);
  });

  it('「보낸 사람 표시」가 꺼져 있으면 목록을 건네지 않고, 켜면 건넨다', () => {
    setPushShowSender(false);
    const native = installNative();
    mockChannels = [channel(ROOM, 'public', '디자인')];
    mockRoster = [];
    render(<PushPresentationSync />);
    expect(native.exportChannels).not.toHaveBeenCalled();
    act(() => setPushShowSender(true));
    expect(native.exportChannels).toHaveBeenCalledTimes(1);
  });
});


it('a consented group DM exports the real member count to native push presentation', () => {
  const [group] = presentationChannels([channel('group-dm', 'dm', undefined, {memberIds: ['self-member', SEOYEON, 'agent-member']})], []);
  expect(group.memberCount).toBe(3);
});
