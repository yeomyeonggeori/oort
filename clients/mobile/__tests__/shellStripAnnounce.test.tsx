import NetInfo from '@react-native-community/netinfo';
import {
  DISPLAY_GRACE_MS,
  HEALED_MS,
} from '@momo/core/features/connection/thresholds';
import {fetchWithDeadline} from '@momo/core/lib/http';
import {act, cleanup, render, screen} from '@testing-library/react-native';
import React, {useRef} from 'react';
import {AccessibilityInfo, Platform} from 'react-native';

import {FixedScheme} from '../src/design/theme';
import {
  ConnectionProvider,
  NO_FEED,
  type SocketFeed,
} from '../src/features/connection/ConnectionProvider';
import {ShellConnectionStrip} from '../src/features/connection/ShellConnectionStrip';
import {ShellStripAnnouncer} from '../src/features/connection/ShellStripAnnouncer';
import type {DisplayEvent} from '../src/realtime/connectionDisplay';
import {RealtimeContext} from '../src/realtime/RealtimeProvider';
import {pinReduceMotion} from './fixtures/reduceMotion';

// =============================================================================
// 셸 띠가 서는 순간 VoiceOver 가 한 번 읽는다 (#5262, #5222 후속).
//
// iOS 에는 live region 이 없어서 띠가 서도 눈으로 볼 수 없는 사람은 모른다. 이 파일은 낭독의 **규칙**을 잰다: 한 번 끊김에 원인마다 한 번,
// 깜빡여도 되풀이하지 않고, 원인이 바뀌면 한 번 더, 틈이 완전히 가라앉은 뒤의 다음 끊김은 새로 읽고, 실시간만 끊김이면 읽지 않는다.
// 띠 셋(홈 · 받은함 · 에이전트)을 한꺼번에 세워 두고 재므로 「띠마다 읽으면 세 번」이 곧바로 드러난다. 진짜 `AppShell` 에 한 번 서 있는지는
// `connectionShellStrip.test.tsx` 가 잰다.
// =============================================================================

const netInfo = NetInfo as unknown as {__emit: (state: unknown) => void};
const feedRef: React.MutableRefObject<SocketFeed> = {current: NO_FEED};

const OFFLINE = '오프라인이에요. 받아 둔 내용만 보여요. 연결되면 자동으로 이어져요.';
const UNREACHABLE = '서버에 닿지 못했어요. 잠시 뒤 다시 시도할게요.';

function Host(): React.JSX.Element {
  const holder = useRef(feedRef);
  return (
    <FixedScheme scheme="light">
      <RealtimeContext.Provider
        value={{rail: null, status: 'connected', subscriptionsWanted: true, reconnect: jest.fn().mockResolvedValue(undefined)}}>
        <ConnectionProvider feedRef={holder.current}>
          <ShellStripAnnouncer />
          {/* 홈 · 받은함 · 에이전트: 세 화면의 띠가 한꺼번에 마운트돼 있다. */}
          <ShellConnectionStrip />
          <ShellConnectionStrip />
          <ShellConnectionStrip />
        </ConnectionProvider>
      </RealtimeContext.Provider>
    </FixedScheme>
  );
}

const feed = (event: DisplayEvent) => act(() => feedRef.current(event));
const raw = (status: 'connected' | 'connecting' | 'disconnected') => feed({kind: 'raw', status});
const tick = (ms: number) => act(async () => { await jest.advanceTimersByTimeAsync(ms); });
const emitNet = (online: boolean) =>
  act(() => netInfo.__emit({isConnected: online, isInternetReachable: online}));
async function serverUnreachable() {
  (globalThis.fetch as jest.Mock).mockRejectedValue(new TypeError('Network request failed'));
  for (const path of ['/channels', '/roster', '/read-state']) {
    await act(async () => {
      await fetchWithDeadline(`https://api.example.com/v1${path}`).catch(() => undefined);
    });
  }
}
/** 소켓이 붙어 `HEALED_MS` 를 넘겨 건강하다: 이 뒤의 끊김은 새 틈이다. */
async function healthy() {
  await raw('connected');
  await tick(HEALED_MS + 100);
}

const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
const told = () => announce.mock.calls.map(call => call[0]);
const strips = () => screen.queryAllByTestId('shell-connection-strip');

const realFetch = globalThis.fetch;
let releaseMotion: (() => void) | null = null;
beforeEach(async () => {
  releaseMotion = await pinReduceMotion(false);
  jest.useFakeTimers();
  jest.setSystemTime(1_700_000_000_000);
  globalThis.fetch = jest.fn() as unknown as typeof fetch;
  feedRef.current = NO_FEED;
  announce.mockReset();
  announce.mockImplementation(() => undefined);
  render(<Host />);
  await tick(0);
});
afterEach(() => {
  cleanup();
  releaseMotion?.();
  releaseMotion = null;
  jest.useRealTimers();
  globalThis.fetch = realFetch;
});

describe('셸 띠가 서는 순간 한 번 읽는다', () => {
  it('기기 오프라인: 띠 셋이 함께 서 있어도 한 번, 띠가 말하는 문장 그대로(제목. 설명)', async () => {
    await healthy();
    expect(told()).toEqual([]);
    await emitNet(false);
    expect(strips()).toHaveLength(3);
    expect(told()).toEqual([OFFLINE]);
    // 읽은 문장은 띠가 값으로 갖는 접근성 문장과 같다: 두 곳이 따로 지은 문장이 아니다.
    expect(strips()[0].props.accessibilityLabel).toBe(OFFLINE);
  });

  it('같은 원인으로 머무는 동안은 되풀이하지 않는다: 시간이 흘러도 같은 사건이 또 와도 한 번이다', async () => {
    await healthy();
    await emitNet(false);
    await tick(30_000);
    await emitNet(false);
    await tick(30_000);
    expect(told()).toEqual([OFFLINE]);
  });

  it('같은 틈 안에서 깜빡여도 되풀이하지 않는다: 오프라인 → 돌아옴(소켓 틈은 아직) → 다시 오프라인', async () => {
    await healthy();
    await raw('connecting');
    await emitNet(false);
    expect(told()).toEqual([OFFLINE]);
    // 기기는 돌아왔지만 소켓 틈은 가라앉지 않았다: 띠는 걷히고 끊김은 아직 이어지는 중이다.
    await emitNet(true);
    expect(strips()).toHaveLength(0);
    await emitNet(false);
    expect(strips()).toHaveLength(3);
    expect(told()).toEqual([OFFLINE]);
  });

  it('원인이 바뀌면 문장이 다르니 한 번 더 읽고, 이미 읽은 원인으로 돌아와도 되풀이하지 않는다', async () => {
    await healthy();
    await raw('connecting');
    await emitNet(false);
    await emitNet(true);
    await serverUnreachable();
    expect(told()).toEqual([OFFLINE, UNREACHABLE]);
    await emitNet(false);
    expect(told()).toEqual([OFFLINE, UNREACHABLE]);
  });

  it('틈이 완전히 가라앉은 뒤의 다음 끊김은 새 이야기라 다시 읽는다', async () => {
    await healthy();
    await emitNet(false);
    expect(told()).toEqual([OFFLINE]);
    // 기기가 돌아오고 소켓이 다시 붙는다(전송이 하는 일). 띠에는 「다시 연결됐어요」 복구 표시가 서지만 그것은 읽지 않는다 - 이 부품은 띠가 **서는**
    // 끊김만 맡는다.
    await emitNet(true);
    await raw('connected');
    expect(strips()).toHaveLength(3);
    expect(told()).toEqual([OFFLINE]);
    // 5초 건강하면 소켓 틈이 풀리고 복구 표시도 걷힌다: 이 끊김은 끝났다.
    await tick(HEALED_MS + 100);
    expect(strips()).toHaveLength(0);
    await emitNet(false);
    expect(strips()).toHaveLength(3);
    expect(told()).toEqual([OFFLINE, OFFLINE]);
  });

  it('실시간만 끊김(소켓이 10초 넘게 끊겨도 기기·서버는 정상)은 셸 띠가 서지 않으니 읽지 않는다', async () => {
    await healthy();
    await raw('connecting');
    await tick(DISPLAY_GRACE_MS + 500);
    expect(strips()).toHaveLength(0);
    expect(told()).toEqual([]);
  });

  it('안드로이드는 띠의 live region 이 이미 읽으므로 여기서 또 읽지 않는다 - 두 번 들리지 않게', async () => {
    const os = jest.replaceProperty(Platform, 'OS', 'android');
    try {
      await healthy();
      await emitNet(false);
      expect(strips()).toHaveLength(3);
      expect(told()).toEqual([]);
    } finally {
      os.restore();
    }
  });
});
