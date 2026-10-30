// =============================================================================
// A local, bounded record of what the realtime socket did and why (#2751).
//
// The RCA for 2026-09-26 could prove from server logs THAT the phone's socket
// churned (six sockets in 54 s, two of them exactly 20.7 s long) but not WHY:
// Centrifugo at info level does not log reconnectable closes, and the edge only
// sees a socket end. The reason lives in the client — centrifuge-js hands it to
// every `connecting`/`disconnected` listener as a numeric code — and nothing was
// keeping it. This buffer keeps it, so the next occurrence names its trigger:
//
//   connecting code 1  transportClosed    the socket died under us (network)
//   connecting code 2  noPing             no server ping within 25 s + 10 s
//   connecting code 3  subscribeTimeout   a subscribe got no reply in 5 s,
//                                         which centrifuge-js answers by
//                                         dropping the WHOLE connection
//   connecting code 4  unsubscribeError   same, for an unsubscribe
//   disconnected code 0  disconnectCalled our own policy closed it
//                                         (grace elapsed / force-reconnect /
//                                         resume) — see the `policy` entry
//                                         recorded just before it
//   connecting code 109 / 3xxx            server-sent reasons
//
// Each `connected` → not-connected transition carries `lifetimeMs`, which is the
// number the RCA could only reconstruct from edge logs.
//
// ## What is NOT recorded
//
// No channel names (they embed workspace and channel ids), no token, no URL, no
// user or member id, no error MESSAGE text from the token fetch (it is
// `e.toString()` of whatever the HTTP layer threw and may carry a URL or a
// body). Codes, allowlisted policy action kinds, app-state names and
// the network TYPE ("wifi" / "cellular" / "none") only. That is what makes it
// safe to paste into an issue.
//
// Module state, deliberately: it must survive `RealtimeProvider` remounts (a
// session refresh rebuilds the transport) because the churn it exists to explain
// is exactly the kind of thing that spans them.
// =============================================================================

export const DIAGNOSTICS_CAPACITY = 128;

export type RealtimeDiagnosticKind =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error'
  | 'policy'
  | 'network'
  | 'app-state'
  | 'token';

export interface RealtimeDiagnostic {
  /** Wall clock, ms. */
  at: number;
  kind: RealtimeDiagnosticKind;
  /** centrifuge-js code (connecting/disconnected/error). */
  code?: number;
  /** Allowlisted policy action / app state / network type / error type. */
  detail?: string;
  /** For a transition out of `connected`: how long that connection lived. */
  lifetimeMs?: number;
}

const SAFE_DETAILS: Partial<Record<RealtimeDiagnosticKind, readonly string[]>> = {
  policy: ['connect', 'disconnect', 'resume', 'force-reconnect', 'arm-grace', 'cancel-grace', 'token-cleared'],
  'app-state': ['active', 'inactive', 'background', 'unknown', 'extension'],
  error: ['connectToken', 'refreshToken', 'transport', 'timeout', 'refresh', 'connect'],
};
const NETWORK = '(?:unknown|none|cellular|wifi|bluetooth|ethernet|wimax|vpn|other|\\?)';
const NETWORK_DETAIL = new RegExp(`^${NETWORK}->${NETWORK}( offline)?$`);
function safeDetail(entry: RealtimeDiagnostic): string | undefined {
  if (entry.detail === undefined) return undefined;
  if (entry.kind === 'network') return NETWORK_DETAIL.test(entry.detail) ? entry.detail : undefined;
  return SAFE_DETAILS[entry.kind]?.includes(entry.detail) ? entry.detail : undefined;
}

let entries: RealtimeDiagnostic[] = [];

export function recordRealtimeDiagnostic(entry: RealtimeDiagnostic): void {
  const next: RealtimeDiagnostic = {...entry};
  next.detail = safeDetail(entry);
  entries.push(next);
  if (entries.length > DIAGNOSTICS_CAPACITY) {
    entries = entries.slice(entries.length - DIAGNOSTICS_CAPACITY);
  }
}

export function realtimeDiagnostics(): readonly RealtimeDiagnostic[] {
  return entries;
}

export function resetRealtimeDiagnostics(): void {
  entries = [];
}

/**
 * One line per entry, oldest first, ISO time in UTC so it lines up with server
 * and edge logs without a timezone conversion.
 */
export function formatRealtimeDiagnostics(
  list: readonly RealtimeDiagnostic[] = entries,
): string {
  if (list.length === 0) return 'realtime: no events recorded';
  return list
    .map(entry => {
      const parts = [new Date(entry.at).toISOString(), entry.kind];
      if (entry.code !== undefined) parts.push(`code=${entry.code}`);
      const detail = safeDetail(entry);
      if (detail !== undefined) parts.push(detail);
      if (entry.lifetimeMs !== undefined) {
        parts.push(`lifetime=${(entry.lifetimeMs / 1000).toFixed(1)}s`);
      }
      return parts.join(' ');
    })
    .join('\n');
}
