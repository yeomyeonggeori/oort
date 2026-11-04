import type {RealtimeStatus} from '@momo/core/lib/realtimeEvents';
import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ConnectionProvider,
  NO_FEED,
  type SocketFeed,
} from '../features/connection/ConnectionProvider';
import {getPersistedSession} from '../storage/secureSession';
import {socketWanted} from './backgroundPolicy';
import {createChannelRail, type ChannelRail} from './channelRail';
import {createRealtimeTransport} from './centrifugeTransport';

// =============================================================================
// One socket for the signed-in tree.
//
// Mounted inside `SessionProvider` so it can take a session for granted, and
// ABOVE the screens so that opening a conversation does not open a socket:
// building the client per screen would mean a fresh Centrifuge on every
// navigation, and a fresh client throws away the recovery offset that lets a
// resubscribe replay the gap instead of cold-starting. That offset is the whole
// reason this product does not re-sync history over REST the way Mattermost
// does (ADR-0137 D4).
//
// ## The URL is read from the session, never derived
//
// ADR-0110: the address login returned is used verbatim. The server is the only
// authority on where its own websocket is, and deriving `ws://` from the API
// base is the bug that decision exists to forbid.
//
// The web client additionally rewrites an mDNS host down to loopback
// (`resolveSpikeRealtimeUrl`), because Chrome's resolver hangs on `.local` in
// that dev environment. That rewrite is NOT ported: it is a browser-resolver
// workaround, iOS resolves `.local` through Bonjour natively, and carrying it
// here would mean a rule that silently rewrites a real address on a platform
// that never needed it.
//
// ## KNOWN BLOCKER — `Origin` (spike #837 gate 3)
//
// React Native's WebSocket sends an `Origin` header whose value is the socket
// URL's own origin. Against this repo's `infra/centrifugo.json`
// `client.allowed_origins`, `wss://app.oor7.com` is accepted and every
// LAN/loopback address is REJECTED — the handshake fails, the socket never
// opens, and the symptom is `{"code":2,"message":"transport closed"}` repeating
// forever. Self-hosting on a LAN is a product property, so a self-hosted server
// cannot serve this client until that server-side configuration decision is
// made. Reproduced from this app in `measure/` (원점 캡처) rather than taken on
// faith, and recorded in the PR. Not fixable here: it is a security decision
// about a server config file this batch may not touch.
// =============================================================================

export interface RealtimeContextValue {
  /** Null until the session yields a websocket address. */
  rail: ChannelRail | null;
  status: RealtimeStatus;
  reconnect?: () => Promise<void>;
  /**
   * Does the background policy want a socket at all right now (goal RN-T2)?
   *
   * Distinct from `status`, which says what the socket is DOING. A backgrounded
   * app past its grace period has no socket BY DESIGN, and centrifuge-js reports
   * that as `connecting` forever — from the status alone it is indistinguishable
   * from a network outage the app is fighting to recover from.
   *
   * Surfaces that pay per subscription (the agent progress rail: up to 32) read
   * this instead, so they detach when the policy parks the socket and not when
   * it merely stumbles. The timeline keeps reading `status`, which is the right
   * question for it: "may I claim this feed is live".
   */
  subscriptionsWanted: boolean;
}

/**
 * 내보내는 이유는 **캡처 하네스** 하나다 (이슈 1137).
 *
 * 소켓 상태를 읽는 표면은 끊긴 판과 연결된 판이 서로 다르게 생겼고, 그 차이는
 * 나란히 놓인 사진에서만 확인된다(`measure/surfaces.tsx` 가 여백·접기·틴트·잠긴
 * 픽커에서 이미 네 번 쓴 규율). 시뮬레이터에는 붙일 소켓이 없어 하네스는
 * 「연결됨」을 만들 방법이 없었다 — `RealtimeProvider` 를 세워도 주소가 없으면
 * `connecting` 에 머문다.
 *
 * 앱 코드는 이것을 쓰지 않는다. 앱에서 읽는 길은 `useRealtime()` 하나다.
 */
export const RealtimeContext = createContext<RealtimeContextValue>({
  rail: null,
  status: 'connecting',
  subscriptionsWanted: false,
});

export function RealtimeProvider({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const url = getPersistedSession()?.realtimeWebSocketUrl ?? '';
  const [status, setStatus] = useState<RealtimeStatus>('connecting');
  // 사람에게 말하는 판정(첫 1초 침묵·「연결 중」·「끊김」의 원인)은 코어 연결 상태 모델이 한다(#5222). 전송이 밖에서 받은
  // 소켓 사건을 이 ref 를 거쳐 그 모델에 먹인다 — 아래 `ConnectionProvider` 가 채운다.
  const feedRef = useRef<SocketFeed>(NO_FEED);
  const [rail, setRail] = useState<ChannelRail | null>(null);
  const [reconnect, setReconnect] = useState<(() => Promise<void>) | undefined>();
  const [subscriptionsWanted, setSubscriptionsWanted] = useState(false);

  useEffect(() => {
    if (url === '') return;
    // `status` reads `connecting` from the moment a socket leaves `connected` until a ten-second
    // outage deadline; a retry loop cannot restart that deadline, a foreground return can (#4783).
    // It answers "is the socket live" for the surfaces that ask. What the person is TOLD (a silent first
    // second #4949, 「연결 중」, the cause of an outage) is the connection model's job (#5222): the same
    // socket events are fed to it through `feedRef`.
    const transport = createRealtimeTransport({
      url,
      onStatus: setStatus,
      onSocketEvent: event => feedRef.current(event),
      onPolicy: state => setSubscriptionsWanted(socketWanted(state)),
    });
    setRail(createChannelRail(transport.client));
    setReconnect(() => transport.reconnect);
    transport.start();
    return () => {
      setRail(null);
      setReconnect(undefined);
      // The socket is going away with the transport, so nothing may keep
      // subscribing against it. Said here rather than left to `onPolicy`: a
      // disposed transport has stopped dispatching, so it will never say this
      // itself.
      setSubscriptionsWanted(false);
      transport.dispose();
    };
  }, [url]);

  const value = useMemo<RealtimeContextValue>(
    () => ({rail, status, subscriptionsWanted, reconnect}),
    [rail, status, subscriptionsWanted, reconnect],
  );

  // 연결 상태 모델은 이 소켓·기기·REST 를 한 번에 읽는 앱 하나의 사실이라 소켓을 만드는 이 공급자 안에 선다. 자식
  // effect 가 먼저 돌아 `feedRef` 가 채워진 뒤에 전송이 시작한다.
  return (
    <ConnectionProvider feedRef={feedRef}>
      <RealtimeContext.Provider value={value}>
        {children}
      </RealtimeContext.Provider>
    </ConnectionProvider>
  );
}

export function useRealtime(): RealtimeContextValue {
  return useContext(RealtimeContext);
}
