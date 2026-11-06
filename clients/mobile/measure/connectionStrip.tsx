import NetInfo from '@react-native-community/netinfo';
import {
  presentConnection,
  type ConnectionPresentation,
} from '@momo/core/features/connection/presentation';
import {
  eventAction,
  initialConnectionState,
  reduceConnection,
  socketEvent,
  tickAction,
} from '@momo/core/features/connection/screenState';
import {
  DISPLAY_GRACE_MS,
  HEALED_MS,
} from '@momo/core/features/connection/thresholds';
import {fetchWithDeadline} from '@momo/core/lib/http';
import {installCoreHost} from '@momo/core/runtime/host';
import {makeStressRoster} from '@momo/core/features/timeline/stress';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import React, {useEffect, useRef, useState} from 'react';
import {AppState, Settings, StyleSheet, Text, View} from 'react-native';
import {useStyles} from '../src/design/theme';
import {font, space, type Palette} from '../src/design/tokens';
import {
  ConnectionProvider,
  NO_FEED,
  type SocketFeed,
} from '../src/features/connection/ConnectionProvider';
import {ShellConnectionStrip} from '../src/features/connection/ShellConnectionStrip';
import {useConnectionBand} from '../src/features/connection/useConnectionBand';
import {ConversationHeader} from '../src/features/conversation/ConversationHeader';
import {RealtimeContext} from '../src/realtime/RealtimeProvider';

// =============================================================================
// 폰 셸 띠와 대화 화면 띠의 캡처·Maestro 표면 (#5222, #5201 S-D). 실제 연결 공급자·실제 띠가 스크립트된 NetInfo·소켓 사건·REST 실패 위에서 선다.
//
//   xcrun simctl launch <UDID> app.momo.ios --args -momoMeasure CONN-STRIP-<WHICH>     (라이트: LIGHT-CONN-STRIP-<WHICH>)
//
//   offline       기기 오프라인: 홈 띠 「오프라인이에요」(마크 정지 · 단추 없음) + 대화 화면 띠가 같은 원인을 말한다
//   unreachable   서버에 닿지 못함: 서로 다른 요청 셋이 응답 없이 실패 → 홈 띠 + 「지금 다시 연결」 단추
//   realtime      실시간만 끊김: 홈에는 띠가 **없고** 대화 화면 띠만 「실시간 연결이 끊겼어요」 (결정 ②)
//   flap          4초에 오프라인 → 12초에 돌아옴: 띠가 서고(오프라인) → 확인 표시 2초 → 걷힌다 (Maestro `5222-shell-connection-strip`)
//   probe         (#5407) 서버가 꺼진 채 시작해 띠가 서고, 서버를 다시 켜면 **사람 손 없이** 앱이 스스로 확인해 띠를 걷는다. 서버는 `-momoGapSink` 로 이은 모의 API 다
//                 (`GET /healthz` 와 그 밖의 경로에 200). 이 장면은 띠를 세운 뒤로 요청을 하지 않는다 - 확인은 앱(코어 `restProbe`)이 보낸다:
//                   xcrun simctl launch <UDID> app.momo.ios --args -momoMeasure CONN-STRIP-PROBE -momoGapSink 127.0.0.1:<모의 API 포트>
//   return        (#5403) 앱이 뒤에 가 있는 동안 소켓이 끊기고, 돌아오면 전송이 하는 일(`resume` → 0.4초 뒤 `connected`)을 흉내 낸다. 띠가 한 번이라도
//                 그려지면 안 된다. 진짜 AppState 로 재려고 사람이 앱을 뒤로 보냈다 가져온다:
//                   xcrun simctl launch <UDID> com.apple.Preferences   (뒤로)  →  14초 뒤  xcrun simctl launch <UDID> app.momo.ios   (앞으로)
//                 장면이 40초에 `-momoGapSink` 로 띠가 서 있던 구간(없으면 빈 배열)과 앱 상태 전이를 보낸다(`scenario: 'return'`).
//
// 위쪽은 홈 화면의 머리·목록 자리를 흉내 낸 틀이고 그 안의 띠가 진짜다. 아래쪽은 진짜 대화 머리다. 이 표면은 서버도 소켓도 없다: 소켓은
// 전송이 부르는 `feedRef` 로 먹이고 기기는 NetInfo 를 덮어 쓴다. 홈·받은함·에이전트 목록에 띠가 실제로 서는지는 시험
// (`connectionShellStrip.test.tsx`)이 재고, 이 표면은 모양을 찍는 곳이다.
// =============================================================================

const DIRECTORY = makeDirectory(makeStressRoster());

/** flap 장면의 시각표(ms). 느린 기계에서 Maestro 가 첫 단계에 몇 초를 쓰고도 오프라인 구간(8초)을 볼 수 있게 넉넉히 둔다. `connectionStripSurface.test.tsx` 가 같은 값으로 잰다. */
export const FLAP_OFFLINE_AT_MS = 4_000;
export const FLAP_BACK_AT_MS = 12_000;
const feedRef: React.MutableRefObject<SocketFeed> = {current: NO_FEED};
const REALTIME = {
  rail: null,
  status: 'connected' as const,
  subscriptionsWanted: true,
  reconnect: async () => {},
};

/** 대화 화면 띠 하나를 코어 모델로 지은 것(`oortLoader` 표면 같은, 공급자 없는 표면이 쓴다). */
export function bandFor(kind: 'connecting' | 'realtimeDown'): ConnectionPresentation | null {
  const t0 = 1_700_000_000_000;
  let state = initialConnectionState(t0, true);
  state = reduceConnection(state, eventAction(t0 + 100, socketEvent(t0 + 100, 'connected')));
  const healthyAt = t0 + 100 + HEALED_MS + 1_000;
  state = reduceConnection(state, eventAction(healthyAt, socketEvent(healthyAt, 'connecting')));
  const at = healthyAt + (kind === 'connecting' ? 1_500 : DISPLAY_GRACE_MS + 500);
  state = reduceConnection(state, tickAction(at));
  return presentConnection(state.view, false);
}

type Listener = (state: unknown) => void;

/** NetInfo 를 덮어 쓴다: 구독자에게 지금 값을 한 번 알리고, `emit` 으로 바뀐 값을 알린다. */
function installScriptedNetwork(): {emit: (online: boolean) => void} {
  const listeners = new Set<Listener>();
  let online = true;
  const report = (value: boolean) => ({
    isConnected: value,
    isInternetReachable: value,
    type: value ? 'wifi' : 'none',
    details: null,
  });
  (
    NetInfo as unknown as {addEventListener: (listener: Listener) => () => void}
  ).addEventListener = listener => {
    listeners.add(listener);
    listener(report(online));
    return () => {
      listeners.delete(listener);
    };
  };
  return {
    emit(value) {
      online = value;
      for (const listener of [...listeners]) listener(report(value));
    },
  };
}

/** probe 장면의 모의 API 주소(`-momoGapSink host:port`). 없으면 null. */
function probeBase(): string | null {
  const sink = Settings.get('momoGapSink');
  return typeof sink === 'string' && sink !== '' ? `http://${sink}` : null;
}

/** probe 장면: 코어가 확인 요청을 보낼 `apiBase()` 를 모의 API 로 돌린다(`composerNewline` 표면과 같은 방식). */
function installProbeHost(): void {
  const base = probeBase();
  if (base === null) return;
  installCoreHost({
    apiBase: () => base,
    absoluteApiBase: () => base,
    buildMode: () => 'development',
    session: {
      getAccessToken: () => 'measure-token',
      getRefreshToken: () => null,
      getPersistedSession: () => null,
      applyLogin: () => {},
      applyRotation: () => {},
      markAuthExpired: () => {},
      clearSession: () => {},
    },
  });
}

function Scene({
  which,
  network,
}: {
  which: string;
  network: {emit: (online: boolean) => void};
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const {band} = useConnectionBand();
  const bandRef = useRef(band);
  bandRef.current = band;
  const started = useRef(false);

  // 공급자의 효과(`feedRef` 를 채운다)는 이 자식의 효과보다 **나중에** 돈다: 사건은 한 박자 뒤에 보낸다.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const cleanups: Array<() => void> = [];
    const later = (ms: number, run: () => void) => timers.push(setTimeout(run, ms));
    later(50, () => feedRef.current({kind: 'raw', status: 'connected'}));
    if (which === 'offline') later(150, () => network.emit(false));
    if (which === 'unreachable') {
      later(150, () => {
        // 이 장면은 서버가 없는 채로 띠를 세워 둔다: 가짜 `fetch` 를 되돌리지 않는다. 되돌리면 2초 뒤 앱이 스스로 보내는 확인 요청(#5407)이 진짜 주소로 나가 띠를 걷을 수 있다.
        globalThis.fetch = (() => Promise.reject(new TypeError('Network request failed'))) as typeof fetch;
        void Promise.all(
          ['channels', 'roster', 'read-state'].map(path =>
            fetchWithDeadline(`https://api.example.com/v1/${path}`).catch(() => undefined),
          ),
        );
      });
    }
    if (which === 'probe') {
      // 모의 API 가 꺼진 채 서로 다른 요청 셋을 보낸다 -> 닿지 못해 띠가 선다. 이 뒤로 이 장면은 요청하지 않는다.
      later(150, () => {
        const base = probeBase();
        if (base === null) return;
        for (const path of ['channels', 'roster', 'read-state']) {
          void fetchWithDeadline(`${base}/v1/${path}`).catch(() => undefined);
        }
      });
    }
    if (which === 'realtime') {
      later(HEALED_MS + 200, () => {
        feedRef.current({kind: 'raw', status: 'disconnected'});
        feedRef.current({kind: 'terminal'});
      });
    }
    if (which === 'return') {
      // 전송이 하는 일을 흉내 낸다: 뒤로 가면 소켓이 끊기고, 앞으로 돌아오면 다시 열어(`resume`) 곧 붙는다. 띠에 그려진 톤의 **전이**만 적는다.
      const t0 = Date.now();
      const marks: Array<{t: number; what: string}> = [];
      const bandLog: Array<{t: number; tone: string | null}> = [];
      let lastTone: string | null = null;
      let wentBack = false;
      const sampler = setInterval(() => {
        const tone = bandRef.current?.tone ?? null;
        if (tone !== lastTone) {
          lastTone = tone;
          bandLog.push({t: Date.now() - t0, tone});
        }
      }, 25);
      const subscription = AppState.addEventListener('change', status => {
        marks.push({t: Date.now() - t0, what: `app-${status}`});
        if (status === 'background') {
          wentBack = true;
          feedRef.current({kind: 'raw', status: 'disconnected'});
        } else if (status === 'active' && wentBack) {
          wentBack = false;
          feedRef.current({kind: 'resume'});
          later(400, () => feedRef.current({kind: 'raw', status: 'connected'}));
        }
      });
      later(40_000, () => {
        clearInterval(sampler);
        const sink = Settings.get('momoGapSink');
        if (typeof sink === 'string' && sink !== '') {
          void fetch(`http://${sink}/return`, {
            method: 'POST',
            body: JSON.stringify({scenario: 'return', marks, bandLog, bandShown: bandLog.filter(entry => entry.tone !== null).length}),
          }).catch(() => undefined);
        }
      });
      cleanups.push(() => clearInterval(sampler));
      cleanups.push(() => subscription.remove());
    }
    if (which === 'flap') {
      later(FLAP_OFFLINE_AT_MS, () => network.emit(false));
      later(FLAP_BACK_AT_MS, () => {
        network.emit(true);
        // 전송이 하는 일: 기기가 돌아오면 다시 열고(`resume`) 붙으면 `connected` 를 알린다.
        feedRef.current({kind: 'resume'});
        later(300, () => feedRef.current({kind: 'raw', status: 'connected'}));
      });
    }
    return () => {
      for (const timer of timers) clearTimeout(timer);
      for (const cleanup of cleanups) cleanup();
    };
  }, [which, network]);

  return (
    <View style={styles.screen} testID="conn-strip-scene">
      <Text style={styles.title}>홈</Text>
      <ShellConnectionStrip />
      <Text style={styles.sample}>채널과 사람의 목록이 이 아래로 이어져요.</Text>
      <Text style={styles.label}>대화 화면 띠</Text>
      <View style={styles.headerBox}>
        <ConversationHeader
          title="agent-lab"
          memberCount="6명"
          kind="public"
          directory={DIRECTORY}
          onBack={() => {}}
          band={band}
          onReconnect={() => {}}
        />
      </View>
    </View>
  );
}

export function ConnectionStripSurface({which}: {which: string}): React.JSX.Element {
  // 렌더 중에 덮어 쓴다: 공급자의 NetInfo 구독(효과)보다 먼저여야 한다.
  const [network] = useState(installScriptedNetwork);
  useState(() => {
    if (which === 'probe') installProbeHost();
  });
  return (
    <RealtimeContext.Provider value={REALTIME}>
      <ConnectionProvider feedRef={feedRef}>
        <Scene which={which} network={network} />
      </ConnectionProvider>
    </RealtimeContext.Provider>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    screen: {flex: 1, backgroundColor: color.bg},
    title: {
      fontSize: font.heading,
      fontWeight: '700',
      color: color.text,
      paddingHorizontal: space.lg,
      paddingTop: 72,
      paddingBottom: space.sm,
    },
    sample: {fontSize: font.meta, color: color.textMuted, paddingHorizontal: space.lg},
    label: {
      fontSize: font.label,
      color: color.textMuted,
      paddingHorizontal: space.lg,
      paddingTop: space.xl,
    },
    headerBox: {height: 170},
  });
