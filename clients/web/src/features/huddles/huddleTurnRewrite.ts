// =============================================================================
// Funnel TURN advertise-port rewrite (SPIKE-HD / #1825).
//
// LiveKit v1.13.3 `external_tls` hardcodes the ICE advertise URL as
// `turns:<host>:443?transport=tcp` (upstream livekit/livekit#4542). `tls_port`
// is listen-only. Funnel's 443 is the web edge, so a browser that honours the
// advertise URL lands on HTML, not TURN. The TURN listener answers on 8443
// (SPIKE-HD ALLOCATE → REALM=livekit · 401). Long-term credentials are
// port-independent, so rewriting the port on a completed RTCConfiguration is
// enough.
//
// Gate = host match, no product flag:
//   * self-host Funnel: turns host === signal (livekitUrl) host → rewrite
//   * LiveKit Cloud: turns host is `*.turn.livekit.cloud`, signal is
//     `<project>.livekit.cloud` → no rewrite
//   * stun: / other ports / host-or-srflx candidates → no rewrite
//
// Injection is a session-scoped RTCPeerConnection shim, not RoomConnectOptions
// rtcConfig: livekit-client RTCEngine.makeRTCConfiguration keeps JoinResponse
// iceServers only when `rtcConfig.iceServers` is unset, so a client-supplied
// list would drop the JoinResponse username/credential. The SDK constructs
// the PC with empty iceServers and injects JoinResponse ICE via
// setConfiguration (#1847), so the shim wraps the constructor and intercepts
// RTCPeerConnection.prototype.setConfiguration.
// =============================================================================

/**
 * Funnel TLS-terminated TURN listen port. LiveKit `external_tls` still
 * advertises 443; this is the port that actually answers ALLOCATE.
 */
export const FUNNEL_TURN_TLS_PORT = 8443;

const ADVERTISED_EXTERNAL_TLS_PORT = 443;

interface ParsedTurnsUrl {
  scheme: string;
  userinfo: string;
  host: string;
  port: string;
  query: string;
}

const TURNS_PREFIX = /^turns:(?:\/\/)?/i;

export const signalHostFromLivekitUrl = (
  livekitUrl: string
): string | null => {
  try {
    const host = new URL(livekitUrl).hostname.toLowerCase();
    return host.length > 0 ? host : null;
  } catch {
    return null;
  }
};

const parseTurnsUrl = (raw: string): ParsedTurnsUrl | null => {
  const prefix = raw.match(TURNS_PREFIX);
  if (!prefix) return null;

  const rest = raw.slice(prefix[0].length);
  const queryIndex = rest.search(/[/?#]/);
  const authority = queryIndex === -1 ? rest : rest.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : rest.slice(queryIndex);
  if (authority.length === 0) return null;

  let userinfo = "";
  let hostport = authority;
  const at = authority.lastIndexOf("@");
  if (at !== -1) {
    userinfo = authority.slice(0, at + 1);
    hostport = authority.slice(at + 1);
  }

  let host: string;
  let port = "";
  if (hostport.startsWith("[")) {
    const close = hostport.indexOf("]");
    if (close === -1) return null;
    host = hostport.slice(1, close);
    const after = hostport.slice(close + 1);
    if (after.startsWith(":")) port = after.slice(1);
    else if (after.length > 0) return null;
  } else {
    const colon = hostport.lastIndexOf(":");
    if (colon === -1) {
      host = hostport;
    } else {
      host = hostport.slice(0, colon);
      port = hostport.slice(colon + 1);
    }
  }

  if (host.length === 0 || (port.length > 0 && !/^\d+$/.test(port))) {
    return null;
  }
  return { scheme: prefix[0], userinfo, host, port, query };
};

export const rewriteTurnsUrl = (
  raw: string,
  signalHost: string
): string => {
  const parsed = parseTurnsUrl(raw);
  if (!parsed) return raw;
  if (parsed.port !== String(ADVERTISED_EXTERNAL_TLS_PORT)) return raw;
  if (parsed.host.toLowerCase() !== signalHost.toLowerCase()) return raw;
  return `${parsed.scheme}${parsed.userinfo}${
    parsed.host.includes(":") ? `[${parsed.host}]` : parsed.host
  }:${FUNNEL_TURN_TLS_PORT}${parsed.query}`;
};

const rewriteIceServer = (
  server: RTCIceServer,
  signalHost: string
): RTCIceServer => {
  const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
  const nextUrls = urls.map((url) => rewriteTurnsUrl(url, signalHost));
  if (nextUrls.every((url, index) => url === urls[index])) return server;
  return {
    ...server,
    urls: Array.isArray(server.urls) ? nextUrls : nextUrls[0],
  };
};

export const rewriteIceServers = (
  iceServers: RTCIceServer[],
  signalHost: string
): RTCIceServer[] => {
  let changed = false;
  const next = iceServers.map((server) => {
    const rewritten = rewriteIceServer(server, signalHost);
    if (rewritten !== server) changed = true;
    return rewritten;
  });
  return changed ? next : iceServers;
};

export const rewriteRtcConfiguration = (
  configuration: RTCConfiguration | undefined,
  signalHost: string
): RTCConfiguration | undefined => {
  if (!configuration?.iceServers) return configuration;
  const iceServers = rewriteIceServers(configuration.iceServers, signalHost);
  if (iceServers === configuration.iceServers) return configuration;
  return { ...configuration, iceServers };
};

type SetConfigurationFn = (
  this: RTCPeerConnection,
  configuration?: RTCConfiguration,
  ...rest: unknown[]
) => void;

/**
 * Install a huddle-scoped RTCPeerConnection wrapper that rewrites completed
 * ICE configs (constructor + prototype setConfiguration). livekit-client
 * constructs with empty iceServers and injects JoinResponse ICE via
 * setConfiguration; a constructor-only subclass misses that path when the
 * SDK holds a captured constructor. Returns a restore function that is a
 * no-op after the first call and never replaces a later wrapper.
 */
export const installHuddleTurnRewriteShim = (
  livekitUrl: string
): (() => void) => {
  const signalHost = signalHostFromLivekitUrl(livekitUrl);
  const Original = globalThis.RTCPeerConnection;
  if (!signalHost || typeof Original !== "function") {
    return () => undefined;
  }
  const rewriteHost = signalHost;
  const originalSetConfiguration = Original.prototype.setConfiguration as
    | SetConfigurationFn
    | undefined;
  const interceptedSetConfiguration: SetConfigurationFn | undefined =
    typeof originalSetConfiguration === "function"
      ? function (configuration, ...rest) {
          return originalSetConfiguration.call(
            this,
            rewriteRtcConfiguration(configuration, rewriteHost),
            ...rest
          );
        }
      : undefined;

  class HuddleTurnRewritePeerConnection extends Original {
    constructor(configuration?: RTCConfiguration) {
      super(rewriteRtcConfiguration(configuration, rewriteHost));
    }

    override setConfiguration(configuration?: RTCConfiguration): void {
      super.setConfiguration(
        rewriteRtcConfiguration(configuration, rewriteHost)
      );
    }
  }

  if (interceptedSetConfiguration) {
    Original.prototype.setConfiguration = interceptedSetConfiguration;
  }

  globalThis.RTCPeerConnection =
    HuddleTurnRewritePeerConnection as typeof RTCPeerConnection;

  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    if (
      interceptedSetConfiguration &&
      originalSetConfiguration &&
      Original.prototype.setConfiguration === interceptedSetConfiguration
    ) {
      Original.prototype.setConfiguration = originalSetConfiguration;
    }
    if (globalThis.RTCPeerConnection === HuddleTurnRewritePeerConnection) {
      globalThis.RTCPeerConnection = Original;
    }
  };
};
