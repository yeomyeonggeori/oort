import NetInfo from '@react-native-community/netinfo';
import {
  DISPLAY_GRACE_MS,
  HEALED_MS,
  RECOVERED_FLASH_MS,
} from '@momo/core/features/connection/thresholds';
import {fetchWithDeadline} from '@momo/core/lib/http';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {act, cleanup, fireEvent, render, screen, within} from '@testing-library/react-native';
import React, {useRef} from 'react';
import {AppState, type AppStateStatus, Text} from 'react-native';

import {FixedScheme} from '../src/design/theme';
import {
  ConnectionProvider,
  NO_FEED,
  type SocketFeed,
} from '../src/features/connection/ConnectionProvider';
import {ShellConnectionStrip} from '../src/features/connection/ShellConnectionStrip';
import {useConnectionBand} from '../src/features/connection/useConnectionBand';
import {deviceOnlineNow} from '../src/features/connection/deviceOnline';
import {useConnectionGates} from '../src/features/connection/useConnectionGates';
import {ConversationHeader} from '../src/features/conversation/ConversationHeader';
import type {DisplayEvent} from '../src/realtime/connectionDisplay';
import {RealtimeContext, useRealtime} from '../src/realtime/RealtimeProvider';
import {pinReduceMotion} from './fixtures/reduceMotion';

// =============================================================================
// 폰 연결 상태 공급자 + 대화 머리 띠 + 셸 띠를 **진짜로 이어서** 잰다 (#5222, #5201 S-D).
//
// 소켓은 전송이 부르는 `feedRef` 로 먹이고(전송이 하는 일 그대로), 기기는 NetInfo 목, 서버는 `fetchWithDeadline` 에 가짜 `fetch` 를 물려 REST
// 결과를 코어가 접게 한다. 시간은 가짜 시계(Date 포함)로 흘린다. 숫자는 상수가 아니라 글자 그대로(999, 1_000, 10_000, 2_000)로 단정한다.
//
// 장면: 1초/10초 경계(결정 ④) · 깜빡이는 소켓 · 복귀/눌러서 다시 연결 · 끝난 소켓 · 셸 띠 네 장면(오프라인 · 서버에 닿지 못함 · 실시간만
// 끊김=대화에서만 · 돌아옴) · 보내기 게이트(결정 ③).
// =============================================================================

const netInfo = NetInfo as unknown as {__emit: (state: unknown) => void};
const feedRef: React.MutableRefObject<SocketFeed> = {current: NO_FEED};

let reconnect: jest.Mock | undefined;
let gates: ReturnType<typeof useConnectionGates> | null = null;

function Surface(): React.JSX.Element {
  const {band} = useConnectionBand();
  const realtime = useRealtime();
  const probe = useConnectionGates();
  gates = probe;
  return (
    <>
      <ConversationHeader
        title="대화"
        kind="dm"
        directory={makeDirectory([])}
        onBack={() => {}}
        band={band}
        onReconnect={realtime.reconnect ? () => void realtime.reconnect?.() : undefined}
      />
      <ShellConnectionStrip />
      <Text testID="gate-probe">{`${probe.canSend}|${probe.canUpload}|${probe.canDecide}|${probe.composerNote ?? '-'}`}</Text>
    </>
  );
}

function Host(): React.JSX.Element {
  const holder = useRef(feedRef);
  return (
    <FixedScheme scheme="light">
      <RealtimeContext.Provider
        value={{rail: null, status: 'connected', subscriptionsWanted: true, reconnect}}>
        <ConnectionProvider feedRef={holder.current}>
          <Surface />
        </ConnectionProvider>
      </RealtimeContext.Provider>
    </FixedScheme>
  );
}

const header = () => screen.queryByTestId('connection-banner');
const strip = () => screen.queryByTestId('shell-connection-strip');
const headerText = () => header()?.props.accessibilityLabel ?? null;

const feed = (event: DisplayEvent) => act(() => feedRef.current(event));
const raw = (status: 'connected' | 'connecting' | 'disconnected') => feed({kind: 'raw', status});
const tick = (ms: number) => act(async () => { await jest.advanceTimersByTimeAsync(ms); });
const emitNet = (online: boolean) =>
  act(() => netInfo.__emit({isConnected: online, isInternetReachable: online}));

const REST_OK = {status: 200, ok: true, text: async () => '{}', headers: {get: () => null}};
async function restFail(path: string) {
  (globalThis.fetch as jest.Mock).mockRejectedValueOnce(new TypeError('Network request failed'));
  await act(async () => {
    await fetchWithDeadline(`https://api.example.com/v1${path}`).catch(() => undefined);
  });
}
async function restOk(path: string) {
  (globalThis.fetch as jest.Mock).mockResolvedValueOnce(REST_OK);
  await act(async () => {
    await fetchWithDeadline(`https://api.example.com/v1${path}`);
  });
}

/** 소켓이 붙어 `HEALED_MS` 를 넘겨 건강하다: 이 뒤의 끊김은 새 틈이다. */
async function healthy() {
  await raw('connected');
  await tick(HEALED_MS + 100);
}

const realFetch = globalThis.fetch;
let releaseMotion: (() => void) | null = null;
beforeEach(async () => {
  // 로더가 「동작 줄이기」 답을 처음 읽을 때의 갱신이 act 밖에 새지 않게, 답을 미리 정해 둔다(움직임은 켠 채).
  releaseMotion = await pinReduceMotion(false);
  jest.useFakeTimers();
  jest.setSystemTime(1_700_000_000_000);
  globalThis.fetch = jest.fn() as unknown as typeof fetch;
  reconnect = jest.fn().mockResolvedValue(undefined);
  gates = null;
  feedRef.current = NO_FEED;
});
afterEach(() => {
  cleanup();
  releaseMotion?.();
  releaseMotion = null;
  jest.useRealTimers();
  globalThis.fetch = realFetch;
});

/** 공급자 아래에 대화 머리·셸 띠·게이트 읽개를 세운다. */
function mountHost() {
  return render(<Host />);
}

describe('결정 ④ — 1초까지 조용히, 10초까지 「연결 중」, 그 뒤 「끊김」 (대화 화면 띠)', () => {
  beforeEach(() => { mountHost(); });

  it('0.6초 안에 다시 이어지면 띠는 한 번도 서지 않는다', async () => {
    await healthy();
    await raw('connecting');
    expect(header()).toBeNull();
    await tick(599);
    expect(header()).toBeNull();
    await raw('connected');
    await tick(20_000);
    expect(header()).toBeNull();
    expect(strip()).toBeNull();
  });

  it('1초가 되는 순간 「연결 중…」이 서고(단추 없음), 이어지면 말없이 걷힌다 - 연결 중만 보였다면 복구 표시도 없다', async () => {
    await healthy();
    await raw('connecting');
    await tick(999);
    expect(header()).toBeNull();
    await tick(1);
    expect(header()).toHaveTextContent('연결 중…', {exact: false});
    expect(within(header()!).queryByTestId('connection-banner-action')).toBeNull();
    await tick(500);
    await raw('connected');
    expect(header()).toBeNull();
    await tick(RECOVERED_FLASH_MS);
    expect(header()).toBeNull();
  });

  it('10초 직전까지 「연결 중…」이고 10초에 「실시간 연결이 끊겼어요」 + 「지금 다시 연결」이다', async () => {
    await healthy();
    await raw('connecting');
    await tick(DISPLAY_GRACE_MS - 1);
    expect(header()).toHaveTextContent('연결 중…', {exact: false});
    await tick(1);
    expect(headerText()).toBe('지금 다시 연결');
    expect(header()).toHaveTextContent('실시간 연결이 끊겼어요', {exact: false});
    // 실시간만 끊겼다: 셸 띠는 서지 않는다(결정 ②).
    expect(strip()).toBeNull();
  });

  it('깜빡이는 소켓: 다시 붙은 지 5초 안에 또 끊기면 틈을 이어 센다(침묵 1초를 다시 주지 않는다)', async () => {
    await healthy();
    await raw('connecting');
    await tick(1_500);
    expect(header()).toHaveTextContent('연결 중…', {exact: false});
    await raw('connected');
    expect(header()).toBeNull();
    await tick(2_000);
    await raw('connecting');
    // 틈이 풀리지 않았으니(2초 < 5초) 처음 끊긴 때부터 센다: 조용한 1초 없이 곧바로 「연결 중…」.
    expect(header()).toHaveTextContent('연결 중…', {exact: false});
    // 처음 끊긴 때부터 10초: 지금까지 흐른 3.5초를 뺀 만큼 뒤에 「끊김」.
    await tick(DISPLAY_GRACE_MS - 3_500 - 1);
    expect(header()).toHaveTextContent('연결 중…', {exact: false});
    await tick(1);
    expect(header()).toHaveTextContent('실시간 연결이 끊겼어요', {exact: false});
  });

  it('앱 복귀(resume): 조용하던 띠는 새 1초를 받고, 이미 선 띠는 침묵으로 내려가지 않는다', async () => {
    await healthy();
    await raw('connecting');
    await tick(800);
    expect(header()).toBeNull();
    await feed({kind: 'resume'});
    await tick(900);
    expect(header()).toBeNull();
    await tick(100);
    expect(header()).toHaveTextContent('연결 중…', {exact: false});
    await feed({kind: 'resume'});
    expect(header()).toHaveTextContent('연결 중…', {exact: false});
  });

  it('「지금 다시 연결」을 누르면 곧바로 「연결 중…」으로 바뀌고 새 10초를 센다', async () => {
    await healthy();
    await raw('connecting');
    await tick(DISPLAY_GRACE_MS);
    expect(header()).toHaveTextContent('실시간 연결이 끊겼어요', {exact: false});
    fireEvent.press(header()!);
    expect(reconnect).toHaveBeenCalledTimes(1);
    // 전송은 다시 열면서 `resume` 을 알린다.
    await feed({kind: 'resume'});
    expect(header()).toHaveTextContent('연결 중…', {exact: false});
    await tick(DISPLAY_GRACE_MS - 1);
    expect(header()).toHaveTextContent('연결 중…', {exact: false});
    await tick(1);
    expect(header()).toHaveTextContent('실시간 연결이 끊겼어요', {exact: false});
  });

  it('끝난 소켓(서버가 다시 연결하지 말라 했다)은 기다리지 않고 곧바로 「끊김」이다', async () => {
    await healthy();
    await raw('disconnected');
    await feed({kind: 'terminal'});
    expect(header()).toHaveTextContent('실시간 연결이 끊겼어요', {exact: false});
    expect(strip()).toBeNull();
  });
});

describe('결정 ② — 셸 띠는 기기 오프라인·서버에 닿지 못함일 때만 (홈·받은함·에이전트)', () => {
  beforeEach(() => { mountHost(); });

  it('장면 1 기기 오프라인: 곧바로 서고(기다림 없음), 마크는 멈추고, 단추가 없다. 대화 화면 띠도 같은 원인을 말한다', async () => {
    await healthy();
    await emitNet(false);
    expect(strip()).toHaveTextContent('오프라인이에요', {exact: false});
    expect(strip()).toHaveTextContent('받아 둔 내용만 보여요. 연결되면 자동으로 이어져요.', {exact: false});
    expect(strip()!.props.accessibilityRole).toBe('text');
    expect(within(strip()!).queryByTestId('shell-connection-strip-action')).toBeNull();
    const satellite = screen.getByTestId('shell-connection-strip-loader-satellite', {includeHiddenElements: true});
    expect(JSON.stringify(satellite.props.style)).toContain('-45deg');
    expect(header()).toHaveTextContent('오프라인이에요', {exact: false});
  });

  it('장면 2 서버에 닿지 못함: 서로 다른 요청 셋이 연달아 실패해야 서고, 단추를 누르면 다시 연결을 부른다. 응답 한 건에 걷힌다', async () => {
    await healthy();
    await restFail('/channels');
    await restFail('/roster');
    // 둘로는 선언하지 않는다.
    expect(strip()).toBeNull();
    expect(header()).toBeNull();
    await restFail('/read-state');
    expect(strip()).toHaveTextContent('서버에 닿지 못했어요', {exact: false});
    expect(strip()).toHaveTextContent('잠시 뒤 다시 시도할게요.', {exact: false});
    expect(strip()!.props.accessibilityRole).toBe('button');
    expect(strip()!.props.accessibilityLabel).toBe('지금 다시 연결');
    expect(header()).toHaveTextContent('서버에 닿지 못했어요', {exact: false});
    fireEvent.press(strip()!);
    expect(reconnect).toHaveBeenCalledTimes(1);
    // 서버가 답하면 풀린다. 「끊김」이 보였으니 2초 확인 표시를 거쳐 걷힌다.
    await restOk('/channels');
    expect(strip()).toHaveTextContent('다시 연결됐어요', {exact: false});
    expect(within(strip()!).queryByTestId('shell-connection-strip-action')).toBeNull();
    await tick(RECOVERED_FLASH_MS);
    expect(strip()).toBeNull();
    expect(header()).toBeNull();
  });

  it('장면 3 실시간만 끊김: 소켓이 몇 분을 끊겨도 REST가 정상이면 대화 화면 띠만 있고 셸 띠는 없다. 돌아와도 셸은 알리지 않는다', async () => {
    await healthy();
    await raw('connecting');
    await tick(DISPLAY_GRACE_MS);
    await restOk('/channels');
    expect(header()).toHaveTextContent('실시간 연결이 끊겼어요', {exact: false});
    expect(strip()).toBeNull();
    await tick(120_000);
    expect(header()).toHaveTextContent('실시간 연결이 끊겼어요', {exact: false});
    expect(strip()).toBeNull();
    await raw('connected');
    // 대화 화면은 끊김을 말했으니 돌아왔다고도 말한다. 셸은 끊김을 말한 적이 없으니 말하지 않는다.
    expect(header()).toHaveTextContent('다시 연결됐어요', {exact: false});
    expect(strip()).toBeNull();
    await tick(RECOVERED_FLASH_MS);
    expect(header()).toBeNull();
  });

  it('장면 4 돌아옴: 섰던 셸 띠는 기기가 돌아오고 소켓이 붙은 순간 2초 「다시 연결됐어요」를 보이고 걷힌다', async () => {
    await healthy();
    await emitNet(false);
    expect(strip()).toHaveTextContent('오프라인이에요', {exact: false});
    await emitNet(true);
    // 기기가 돌아왔지만 소켓은 아직 붙기 전이다 - 띠는 잠시 비고(소켓 틈은 셸이 말하지 않는다) 기억은 이어진다.
    expect(strip()).toBeNull();
    await tick(500);
    await raw('connected');
    expect(strip()).toHaveTextContent('다시 연결됐어요', {exact: false});
    expect(within(strip()!).getByTestId('shell-connection-strip-check')).toBeTruthy();
    await tick(RECOVERED_FLASH_MS - 1);
    expect(strip()).toHaveTextContent('다시 연결됐어요', {exact: false});
    await tick(1);
    expect(strip()).toBeNull();
  });
});

describe('결정 ③ — 보내기 게이트: 실시간만 끊기면 열려 있다. 모르면 막지 않는다', () => {
  beforeEach(() => { mountHost(); });
  const probe = () => screen.getByTestId('gate-probe').props.children as string;

  it('실시간만 끊김(10초 넘게): 보내기·올리기·승인 모두 열려 있고 한 줄도 서지 않는다', async () => {
    await healthy();
    await raw('connecting');
    await tick(DISPLAY_GRACE_MS + 5_000);
    expect(header()).toHaveTextContent('실시간 연결이 끊겼어요', {exact: false});
    expect(probe()).toBe('true|true|true|-');
  });

  it('기기 오프라인: 막고, 원인 문장(오프라인) 키를 준다', async () => {
    await healthy();
    await emitNet(false);
    expect(probe()).toBe('false|false|false|connection.composer.offline');
  });

  it('서버에 닿지 못함: 막고, 원인 문장(서버) 키를 준다. 응답 한 건에 열린다', async () => {
    await healthy();
    await restFail('/channels');
    await restFail('/roster');
    await restFail('/read-state');
    expect(probe()).toBe('false|false|false|connection.composer.serverUnreachable');
    await restOk('/messages');
    expect(probe()).toBe('true|true|true|-');
  });

});

describe('화면 밖 코드가 읽는 기기 온라인', () => {
  it('NetInfo 보고가 deviceOnlineNow() 로 옮겨 적히고, 공급자가 사라지면 모르는 값(null)으로 돌아간다', async () => {
    const view = mountHost();
    expect(deviceOnlineNow()).toBeNull();
    await emitNet(false);
    expect(deviceOnlineNow()).toBe(false);
    await emitNet(true);
    expect(deviceOnlineNow()).toBe(true);
    view.unmount();
    expect(deviceOnlineNow()).toBeNull();
  });
});

describe('공급자 밖', () => {
  it('격리 하네스에서는 NetInfo 하나로 답한다 - 예전과 같다', async () => {
    render(
      <FixedScheme scheme="light">
        <Gates />
      </FixedScheme>,
    );
    expect(gates).toMatchObject({canSend: true, composerNote: null});
    await emitNet(false);
    expect(gates).toMatchObject({canSend: false, canUpload: false, canDecide: false, composerNote: null});
  });
});

function Gates(): null {
  gates = useConnectionGates();
  return null;
}

describe('수명', () => {
  it('공급자가 사라지면 전송이 부르는 자리는 아무것도 하지 않는 함수로 돌아가고 남는 시계가 없다', async () => {
    const view = mountHost();
    await healthy();
    await raw('connecting');
    expect(feedRef.current).not.toBe(NO_FEED);
    expect(jest.getTimerCount()).toBeGreaterThan(0);
    view.unmount();
    expect(feedRef.current).toBe(NO_FEED);
    expect(jest.getTimerCount()).toBe(0);
  });
});

// =============================================================================
// #5403 - 정상 재연결은 조용히, 복구 표시는 끊김을 본 경우에만 짧게 서고 저절로 걷힌다.
//
// 사람이 끊김 띠를 본 적이 없는 재연결(대화 열기 · 앱 복귀)은 아무것도 보이지 않는다. 「다시 연결됐어요」는 이 띠가 끊김을 실제로 그린 뒤에만
// 서고, 사람 행동(보내기 같은 다음 사건) 없이 2초 안에 걷힌다 - 깨움 시계가 늦거나 사라져도 다음 렌더 · 앱 복귀에서 거둔다.
// =============================================================================

describe('#5403 — 사람이 본 적 없는 재연결은 아무것도 보이지 않는다', () => {
  let appState: AppStateStatus = 'active';
  let appHandlers: Array<(state: AppStateStatus) => void> = [];
  const appStateDescriptor = Object.getOwnPropertyDescriptor(AppState, 'currentState');
  const goTo = (state: AppStateStatus) =>
    act(() => {
      appState = state;
      for (const handler of appHandlers) handler(state);
    });

  /** 대화 화면 띠는 `open` 일 때만 선다(대화를 연 순간 새로 마운트된다). 셸 띠는 늘 선다. */
  function Opening({open}: {open: boolean}): React.JSX.Element {
    return (
      <FixedScheme scheme="light">
        <RealtimeContext.Provider
          value={{rail: null, status: 'connected', subscriptionsWanted: true, reconnect}}>
          <ConnectionProvider feedRef={feedRef}>
            {open ? <Band /> : null}
            <ShellConnectionStrip />
          </ConnectionProvider>
        </RealtimeContext.Provider>
      </FixedScheme>
    );
  }
  function Band(): React.JSX.Element {
    const {band} = useConnectionBand();
    return (
      <ConversationHeader
        title="대화"
        kind="dm"
        directory={makeDirectory([])}
        onBack={() => {}}
        band={band}
      />
    );
  }

  beforeEach(() => {
    appState = 'active';
    appHandlers = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
      appHandlers.push(handler as (state: AppStateStatus) => void);
      return {
        remove: () => {
          appHandlers = appHandlers.filter(h => h !== handler);
        },
      };
    });
    Object.defineProperty(AppState, 'currentState', {configurable: true, get: () => appState});
  });
  afterEach(() => {
    if (appStateDescriptor) Object.defineProperty(AppState, 'currentState', appStateDescriptor);
    jest.restoreAllMocks();
  });

  it('앱이 뒤에 있는 동안 끊긴 소켓: 돌아온 순간 띠가 서지 않고, 붙으면 복구 표시도 없다 (앱 알림이 먼저)', async () => {
    render(<Opening open />);
    await healthy();
    await goTo('background');
    await raw('disconnected');
    // 뒤에서 흐른 5분: 멈춘 JS 가 늦게 깨어나도 아무도 못 본 시간이다.
    await tick(300_000);
    // 시뮬레이터 실측(2026-11-06): 늦은 깨움은 앱 상태 알림(`active`)보다 **먼저** 돌아오고, 그 사이 화면은 이미 앞에 있다. 이 순간 띠가 낡은 「끊김」을
    // 그리면 안 된다(실측: 약 360ms 동안 「끊김」 띠가 떴다 걷혔다).
    expect(header()).toBeNull();
    await goTo('active');
    await feed({kind: 'resume'});
    expect(header()).toBeNull();
    await tick(500);
    await raw('connected');
    expect(header()).toBeNull();
    await tick(RECOVERED_FLASH_MS + 100);
    expect(header()).toBeNull();
    expect(strip()).toBeNull();
  });

  it('전송의 다시 열기가 앱 알림보다 먼저 와도 같다', async () => {
    render(<Opening open />);
    await healthy();
    await goTo('background');
    await raw('disconnected');
    await tick(300_000);
    // 전송이 먼저 듣고 소켓을 다시 연다. 앱 알림은 같은 순간 뒤따른다.
    await feed({kind: 'resume'});
    await goTo('active');
    expect(header()).toBeNull();
    await tick(500);
    await raw('connected');
    expect(header()).toBeNull();
    await tick(RECOVERED_FLASH_MS + 100);
    expect(header()).toBeNull();
  });

  it('끊김이 홈에 있는 동안 지나간 것이면, 막 연 대화의 띠는 복구 표시를 말하지 않는다', async () => {
    const view = render(<Opening open={false} />);
    await healthy();
    await raw('disconnected');
    await tick(DISPLAY_GRACE_MS + 100);
    // 셸은 실시간만 끊긴 것을 말하지 않는다 - 사람은 본 적이 없다.
    expect(strip()).toBeNull();
    await raw('connected');
    // 복구 2초가 서 있는 사이에 대화를 연다.
    await tick(400);
    view.rerender(<Opening open />);
    expect(header()).toBeNull();
    await tick(RECOVERED_FLASH_MS);
    expect(header()).toBeNull();
  });

  it('끊김을 이 띠가 실제로 그렸으면 「다시 연결됐어요」가 서고, 사람 행동 없이 2초에 걷힌다', async () => {
    render(<Opening open />);
    await healthy();
    await raw('disconnected');
    await tick(DISPLAY_GRACE_MS + 100);
    expect(header()).toHaveTextContent('실시간 연결이 끊겼어요', {exact: false});
    await raw('connected');
    expect(header()).toHaveTextContent('다시 연결됐어요', {exact: false});
    await tick(RECOVERED_FLASH_MS - 1);
    expect(header()).toHaveTextContent('다시 연결됐어요', {exact: false});
    await tick(1);
    expect(header()).toBeNull();
  });

  it('깨움 시계가 사라져도 다음 렌더에서 거둔다 (보내기 같은 다음 사건을 기다리지 않는다)', async () => {
    const view = render(<Opening open />);
    await healthy();
    await raw('disconnected');
    await tick(DISPLAY_GRACE_MS + 100);
    await raw('connected');
    expect(header()).toHaveTextContent('다시 연결됐어요', {exact: false});
    // 깨움이 오지 않은 채 시각만 5분 흐른다(멈춘 타이머): 상태는 그대로인데 읽는 시각이 지났다.
    jest.setSystemTime(Date.now() + 300_000);
    expect(header()).toHaveTextContent('다시 연결됐어요', {exact: false});
    view.rerender(<Opening open />);
    expect(header()).toBeNull();
  });

  it('깨움 시계가 사라져도 앱 복귀(inactive → active)에서 거둔다', async () => {
    render(<Opening open />);
    await healthy();
    await raw('disconnected');
    await tick(DISPLAY_GRACE_MS + 100);
    await raw('connected');
    expect(header()).toHaveTextContent('다시 연결됐어요', {exact: false});
    await goTo('inactive');
    jest.setSystemTime(Date.now() + 300_000);
    await goTo('active');
    expect(header()).toBeNull();
  });
});

// =============================================================================
// #5407 — 「서버에 닿지 못했어요」·「연결에 문제가 있어요」 띠는 응답 한 건이 와야 걷혀서, 서버가 돌아와도 사람이 보내기 같은 요청을 하기 전까지 남았다.
// 이제 이 띠가 **앞에서** 서 있는 동안 앱이 스스로 가볍게 다시 확인한다(2 · 4 · 8 · 16 · 30초). 사람이 하는 요청은 띠를 세우는 `hit` 뿐이고, 서버가 돌아온 뒤에는
// 한 건도 없다. 서버는 `serverUp` 하나로 켜고 끄고, 확인 요청은 `GET …/healthz` 로 세어 단정한다.
// =============================================================================

describe('#5407 — 서버에 닿지 못함 띠는 앱이 스스로 다시 확인한다', () => {
  let serverUp = false;
  let appState: AppStateStatus = 'active';
  let appHandlers: Array<(state: AppStateStatus) => void> = [];
  const appStateDescriptor = Object.getOwnPropertyDescriptor(AppState, 'currentState');
  const goTo = (state: AppStateStatus) =>
    act(() => {
      appState = state;
      for (const handler of appHandlers) handler(state);
    });

  /** 요청이 어디로 갔나(확인 요청은 주소가 `/healthz` 로 끝난다). */
  const urls = () => (globalThis.fetch as jest.Mock).mock.calls.map(([url]) => String(url));
  const probes = () => urls().filter(url => url.endsWith('/healthz'));
  const humanRequests = () => urls().filter(url => !url.endsWith('/healthz'));
  /** 사람(화면)이 한 요청. 서버가 꺼져 있으면 닿지 못한다. */
  async function hit(path: string) {
    await act(async () => {
      await fetchWithDeadline(`https://api.example.com/v1${path}`).catch(() => undefined);
    });
  }
  const declareUnreachable = async () => {
    for (const path of ['/channels', '/roster', '/read-state']) await hit(path);
    expect(strip()).toHaveTextContent('서버에 닿지 못했어요', {exact: false});
  };

  beforeEach(() => {
    serverUp = false;
    appState = 'active';
    appHandlers = [];
    (globalThis.fetch as jest.Mock).mockImplementation(async () => {
      if (!serverUp) throw new TypeError('Network request failed');
      return REST_OK;
    });
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
      appHandlers.push(handler as (state: AppStateStatus) => void);
      return {
        remove: () => {
          appHandlers = appHandlers.filter(h => h !== handler);
        },
      };
    });
    Object.defineProperty(AppState, 'currentState', {configurable: true, get: () => appState});
  });
  afterEach(() => {
    if (appStateDescriptor) Object.defineProperty(AppState, 'currentState', appStateDescriptor);
    jest.restoreAllMocks();
  });

  it('서버가 돌아오면 사람의 요청 없이 띠가 걷힌다: 2초에 첫 확인, 돌아온 뒤 다음 확인(6초)에 「다시 연결됐어요」를 거쳐 비워진다', async () => {
    mountHost();
    await healthy();
    await declareUnreachable();
    expect(humanRequests()).toHaveLength(3);
    await tick(1_999);
    expect(probes()).toHaveLength(0);
    await tick(1);
    expect(probes()).toHaveLength(1);
    expect(probes()[0]).toMatch(/\/healthz$/);
    // 서버가 아직 안 돌아왔다: 띠는 그대로이고 보내기도 막혀 있다.
    expect(strip()).toHaveTextContent('서버에 닿지 못했어요', {exact: false});
    expect(screen.getByTestId('gate-probe').props.children).toContain('false|false|false');

    serverUp = true;
    await tick(3_999);
    expect(probes()).toHaveLength(1);
    expect(strip()).toHaveTextContent('서버에 닿지 못했어요', {exact: false});
    await tick(1); // 첫 확인이 끝난 때부터 4초
    expect(probes()).toHaveLength(2);
    expect(strip()).toHaveTextContent('다시 연결됐어요', {exact: false});
    expect(screen.getByTestId('gate-probe').props.children).toContain('true|true|true');
    await tick(RECOVERED_FLASH_MS);
    expect(strip()).toBeNull();
    expect(header()).toBeNull();
    // 걷혔으면 더는 보내지 않고, 그동안 사람이 보낸 요청은 한 건도 없다.
    await tick(300_000);
    expect(probes()).toHaveLength(2);
    expect(humanRequests()).toHaveLength(3);
  });

  it('뒤에 있는 동안은 확인을 한 건도 보내지 않고, 앞으로 돌아오면 2초부터 다시 시작한다', async () => {
    mountHost();
    await healthy();
    await declareUnreachable();
    await goTo('background');
    await tick(300_000);
    expect(probes()).toHaveLength(0);
    await goTo('active');
    await tick(1_999);
    expect(probes()).toHaveLength(0);
    await tick(1);
    expect(probes()).toHaveLength(1);
  });

  it('알림 센터를 당긴 동안(inactive)도 보내지 않는다 - 앞(active)에 있을 때만이다', async () => {
    mountHost();
    await healthy();
    await declareUnreachable();
    await goTo('inactive');
    await tick(60_000);
    expect(probes()).toHaveLength(0);
    await goTo('active');
    await tick(2_000);
    expect(probes()).toHaveLength(1);
  });

  it('실시간이 다시 붙으면 요청 없이 걷히고, 확인도 멈춘다', async () => {
    mountHost();
    await healthy();
    await declareUnreachable();
    await tick(2_000);
    expect(probes()).toHaveLength(1);
    await raw('disconnected');
    await raw('connected');
    expect(strip()).toHaveTextContent('다시 연결됐어요', {exact: false});
    await tick(RECOVERED_FLASH_MS);
    expect(strip()).toBeNull();
    await tick(300_000);
    expect(probes()).toHaveLength(1);
    expect(humanRequests()).toHaveLength(3);
  });

  it('「연결에 문제가 있어요」(알 수 없음)도 확인한다 - 서버가 답하면 실시간만 끊긴 띠로 좁혀지고 확인은 멈춘다', async () => {
    mountHost();
    await healthy();
    await raw('connecting');
    await hit('/channels');
    await tick(DISPLAY_GRACE_MS);
    expect(header()).toHaveTextContent('연결에 문제가 있어요', {exact: false});
    expect(strip()).toBeNull();
    await tick(2_000);
    expect(probes()).toHaveLength(1);
    // 확인이 닿지 못해도 띠는 「서버에 닿지 못했어요」로 올라가지 않는다.
    expect(header()).toHaveTextContent('연결에 문제가 있어요', {exact: false});
    expect(strip()).toBeNull();
    serverUp = true;
    await tick(4_000);
    expect(probes()).toHaveLength(2);
    expect(header()).toHaveTextContent('실시간 연결이 끊겼어요', {exact: false});
    await tick(300_000);
    expect(probes()).toHaveLength(2);
  });

  it('공급자가 사라지면 날아갈 확인의 시계도 남지 않는다', async () => {
    const view = mountHost();
    await healthy();
    await declareUnreachable();
    view.unmount();
    // 효과의 거둠이 빠지면 2초 뒤 확인이 나간다(띠 애니메이션 같은 화면 쪽 시계는 이 시험이 세지 않는다).
    await tick(300_000);
    expect(probes()).toHaveLength(0);
  });
});
