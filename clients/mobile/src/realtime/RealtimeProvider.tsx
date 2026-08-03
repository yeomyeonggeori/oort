import type {RealtimeStatus} from '@momo/core/lib/realtimeEvents';
import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {getPersistedSession} from '../storage/secureSession';
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
}

const RealtimeContext = createContext<RealtimeContextValue>({
  rail: null,
  status: 'connecting',
});

export function RealtimeProvider({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const url = getPersistedSession()?.realtimeWebSocketUrl ?? '';
  const [status, setStatus] = useState<RealtimeStatus>('connecting');
  const [rail, setRail] = useState<ChannelRail | null>(null);

  useEffect(() => {
    if (url === '') return;
    // `connecting` means two things to centrifuge-js and only one thing to a
    // reader. Before the first `connected` it is the opening handshake, and
    // "연결 중" is honest. After it, it is the reconnect loop the client sits in
    // for as long as the network is gone — `disconnected` is emitted only when
    // the SERVER closes the session deliberately. Reporting both as "연결 중" is
    // why a real 40s drop showed no offline state at all on web (measured
    // there); once we have been connected, not being connected is being
    // disconnected.
    let everConnected = false;
    const transport = createRealtimeTransport({
      url,
      onStatus: next => {
        if (next === 'connected') everConnected = true;
        setStatus(
          next === 'connecting' && everConnected ? 'disconnected' : next,
        );
      },
    });
    setRail(createChannelRail(transport.client));
    transport.start();
    return () => {
      setRail(null);
      transport.dispose();
    };
  }, [url]);

  const value = useMemo<RealtimeContextValue>(
    () => ({rail, status}),
    [rail, status],
  );

  return (
    <RealtimeContext.Provider value={value}>
      {children}
    </RealtimeContext.Provider>
  );
}

export function useRealtime(): RealtimeContextValue {
  return useContext(RealtimeContext);
}
