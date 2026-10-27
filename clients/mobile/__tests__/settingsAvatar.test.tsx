import {makeDirectory} from '@momo/core/features/workspace/directory';
import type {Member, RosterMember} from '@momo/core/lib/api';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';
import {StyleSheet} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {paletteFor, ThemeProvider} from '../src/design/theme';
import {ds2Radius, radius, SAFE_GUTTER} from '../src/design/tokens';
import {pinReduceMotion} from './fixtures/reduceMotion';
import {SettingsPage} from '../src/features/profile/SettingsPage';

// =============================================================================
// #4384 · #4457 — 설정 페이지에서 사진 장으로 가는 길
//
// 머리의 큰 얼굴과 「프로필」 카드의 「사진 바꾸기」 행이 **같은 장**(「프로필 사진」)을 연다. 얼굴만 누르게
// 두면 바꿀 수 있다는 것을 아는 사람만 바꾼다. 페이지의 다른 훅(푸시·상태·기기 키·업데이트)은 이
// 시험의 관심이 아니라 가짜로 바꾼다.
// =============================================================================

jest.mock('../src/push/usePushSwitch', () => ({
  PUSH_SWITCH_LABEL: '푸시 알림',
  PUSH_SWITCH_OFF_FAILED: 'x',
  pushSwitchDetail: () => '',
  usePushSwitch: () => ({
    on: false,
    busy: false,
    state: 'off',
    toggle: () => {},
    failed: false,
    detail: '',
  }),
}));
jest.mock('../src/features/profile/selfStatus', () => ({
  useRecheckWhenElapsed: () => {},
  useSetPresence: () => ({isPending: false, mutate: () => {}, mutateAsync: async () => {}}),
  usePauseNotifications: () => ({
    paused: false,
    untilMs: undefined,
    pending: false,
    ready: true,
    failed: false,
    resume: () => {},
    pauseUntil: async () => true,
  }),
  usePushKinds: () => ({workComplete: true, ready: true, pending: false, failed: false, set: () => {}}),
}));
jest.mock('../src/features/deviceKey/useDeviceKey', () => ({
  useDeviceKey: () => ({view: {kind: 'unavailable'}}),
}));
jest.mock('../src/features/deviceKey/copy', () => ({
  ...jest.requireActual('../src/features/deviceKey/copy'),
  deviceKeyCopy: () => ({badge: '연결 안 됨', detail: ''}),
}));
jest.mock('../src/features/appUpdate/useAppUpdateOffer', () => ({
  useAppUpdateOffer: () => ({offer: null}),
}));
jest.mock('../src/features/memory/MemoryPauseSection', () => ({MemoryPauseSection: () => null}));
jest.mock('../src/features/inbox/useOnline', () => ({useOnline: () => true}));

const WS = 'ws-1';
const SELF: Member = {id: 'me-1', workspaceId: WS, kind: 'human', displayName: '이도현', handle: 'dohyun'};
const ROW = {
  ...SELF,
  status: 'active',
  channelCount: 0,
  channelIds: [],
  capabilities: [],
  createdAtMs: 0,
  updatedAtMs: 0,
} as unknown as RosterMember;

function mount() {
  const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
  return render(
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <SettingsPage
          workspaceId={WS}
          member={SELF}
          directory={makeDirectory([ROW])}
          connected
          onSignOut={() => {}}
          onClose={() => {}}
        />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

/** 이 시험들은 움직임이 주제가 아니다 — 층이 누르는 즉시 걷히도록 동작 줄이기를 켠 채 돈다(`layerMotion4457.test.tsx` 가 움직임을 잰다). */
let releaseMotion: (() => void) | null = null;

beforeEach(async () => {
  releaseMotion = await pinReduceMotion(true);
});

afterEach(() => {
  cleanup();
  releaseMotion?.();
  releaseMotion = null;
});

describe('설정 페이지 → 프로필 사진 장', () => {
  it('사진 장의 묶음은 새 카드 가족이다 — 반경 20·surface 채움이고 옛 반경 8 카드가 아니다', () => {
    mount();
    fireEvent.press(screen.getByTestId('self-profile-avatar', {includeHiddenElements: true}));
    const card = StyleSheet.flatten(screen.getByTestId('avatar-card-card').props.style);
    expect(card.borderRadius).toBe(ds2Radius.card);
    expect(card.borderRadius).not.toBe(radius.md); // 옛 `GroupSection` 의 반경 — 비교가 헛돌지 않는다
    expect(card.backgroundColor).toBe(paletteFor('light').surface);
    // 가로 여백은 이 장이 진다(카드는 폭 전체) — 카드가 화면 가장자리까지 번지지 않는다.
    const page = StyleSheet.flatten(screen.getByTestId('avatar-page').props.style);
    expect(page.paddingHorizontal).toBe(SAFE_GUTTER);
  });

  it('큰 얼굴을 누르면 사진 장이 한 겹 더 쌓이고, 머리의 ‹ 뒤로가 설정으로 돌려보낸다', () => {
    mount();
    expect(screen.queryByTestId('avatar-page')).toBeNull();
    fireEvent.press(screen.getByTestId('self-profile-avatar', {includeHiddenElements: true}));
    expect(screen.getByTestId('avatar-page')).toBeTruthy();
    expect(screen.getByTestId('settings-sub-title')).toHaveTextContent('프로필 사진');
    // 설정 페이지는 밑에 마운트된 채 남는다 — 닫히는 것은 한 겹뿐이다.
    expect(screen.getByTestId('settings-page')).toBeTruthy();
    fireEvent.press(screen.getByTestId('settings-back'));
    expect(screen.queryByTestId('avatar-page')).toBeNull();
    expect(screen.getByTestId('self-profile-name')).toBeTruthy();
  });

  it('「사진 바꾸기」 줄도 같은 장을 연다', () => {
    mount();
    fireEvent.press(screen.getByTestId('self-profile-avatar-change'));
    expect(screen.getByTestId('avatar-page')).toBeTruthy();
  });

  it('낭독은 「사진 바꾸기」 줄 하나만 읽고 얼굴 탭은 낭독에서 숨는다(같은 단추 두 번 읽기 방지)', () => {
    mount();
    expect(screen.getByTestId('self-profile-avatar-change').props.accessibilityLabel).toBe('프로필 사진 바꾸기');
    const face = screen.getByTestId('self-profile-avatar', {includeHiddenElements: true});
    expect(face.props.accessible).toBe(false);
    expect(face.props.accessibilityElementsHidden).toBe(true);
    // 눈으로 누르는 길은 그대로 같은 장을 연다.
    fireEvent.press(face);
    expect(screen.getByTestId('avatar-page')).toBeTruthy();
  });
});
