// =============================================================================
// When the realtime socket may be dropped and when it must be rebuilt
// (ADR-0137 D4). Pure: no AppState, no NetInfo, no timers, no Centrifuge — the
// transport in `./centrifugeTransport.ts` supplies the signals and performs the
// actions, and this file only decides. That split is what makes the 15-second
// grace testable at all; a policy tangled into the socket can only be verified
// by sitting and waiting.
//
// The policy is Mattermost's, adopted deliberately (D4):
//
//   background   do NOT drop the socket immediately. Most backgrounding is
//                seconds long — a glance at a notification, the app switcher,
//                answering a message elsewhere. Dropping instantly means the
//                person pays a full reconnect, a token fetch and a recovery
//                replay to look at their own home screen. Wait 15s first.
//   foreground   resume. Cancel a pending drop if the grace has not elapsed,
//                which is the case that makes the whole policy worth having.
//   network type FORCE a reconnect. This one is not an optimisation: a socket
//                held across a Wi-Fi -> cellular handover often survives as an
//                object while being attached to a dead route, so it neither
//                errors nor delivers. Only tearing it down surfaces the truth.
//
// iOS `inactive` is NOT background. The app is `inactive` while the notification
// shade is pulled down, during an incoming call, and mid-app-switcher — states a
// person is still looking at and returns from immediately. Treating it as
// background would arm the grace timer many times a session for no reason.
// =============================================================================

/** How long a backgrounded app keeps its socket. Mattermost's number (D4). */
export const BACKGROUND_GRACE_MS = 15_000;

export type AppVisibility = 'active' | 'inactive' | 'background';

export interface RealtimePolicyState {
  /** Is the person looking at the app? `inactive` still counts as yes. */
  foreground: boolean;
  /** Do we want a live socket right now? */
  wantConnected: boolean;
  /** Is a grace-expiry drop armed? */
  gracePending: boolean;
  /** Last observed network transport ("wifi", "cellular", …), null if unknown. */
  networkType: string | null;
}

export type RealtimeSignal =
  | {kind: 'visibility'; status: AppVisibility}
  | {kind: 'grace-elapsed'}
  | {kind: 'network'; networkType: string | null; online: boolean};

export type RealtimeAction =
  /** Open the socket (no-op if the transport already has one). */
  | {kind: 'connect'}
  /** Close it. Only ever reached by a grace timer that ran to completion. */
  | {kind: 'disconnect'}
  /** Arm the grace timer. */
  | {kind: 'arm-grace'; delayMs: number}
  /** Disarm it — the person came back in time. */
  | {kind: 'cancel-grace'}
  /** Tear down and rebuild, because the old socket may be attached to a dead
   *  route even though it still looks open. */
  | {kind: 'force-reconnect'};

export function initialPolicyState(
  foreground: boolean = true,
): RealtimePolicyState {
  return {
    foreground,
    wantConnected: false,
    gracePending: false,
    networkType: null,
  };
}

export interface PolicyStep {
  state: RealtimePolicyState;
  actions: RealtimeAction[];
}

/**
 * Sign in / sign out are not signals but explicit starts and stops: the socket
 * exists because there is a session, and no amount of app-state churn should
 * create one when there is not.
 */
export function policyStart(state: RealtimePolicyState): PolicyStep {
  if (state.wantConnected) {
    return {state, actions: []};
  }
  return {state: {...state, wantConnected: true}, actions: [{kind: 'connect'}]};
}

export function policyStop(state: RealtimePolicyState): PolicyStep {
  const actions: RealtimeAction[] = [];
  if (state.gracePending) {
    actions.push({kind: 'cancel-grace'});
  }
  if (state.wantConnected) {
    actions.push({kind: 'disconnect'});
  }
  return {
    state: {...state, wantConnected: false, gracePending: false},
    actions,
  };
}

export function policyStep(
  state: RealtimePolicyState,
  signal: RealtimeSignal,
): PolicyStep {
  switch (signal.kind) {
    case 'visibility': {
      const foreground = signal.status !== 'background';
      if (foreground === state.foreground) {
        return {state, actions: []};
      }
      const next = {...state, foreground};

      if (!state.wantConnected) {
        // No session, so nothing to preserve or drop.
        return {state: next, actions: []};
      }

      if (foreground) {
        const actions: RealtimeAction[] = [];
        if (state.gracePending) {
          // The whole point of the grace period: back within 15s, socket kept,
          // no reconnect and no replay.
          actions.push({kind: 'cancel-grace'});
        } else {
          // The grace elapsed while away and the socket was dropped, so coming
          // back has to rebuild it.
          actions.push({kind: 'connect'});
        }
        return {state: {...next, gracePending: false}, actions};
      }

      if (state.gracePending) {
        return {state: next, actions: []};
      }
      return {
        state: {...next, gracePending: true},
        actions: [{kind: 'arm-grace', delayMs: BACKGROUND_GRACE_MS}],
      };
    }

    case 'grace-elapsed': {
      if (!state.gracePending) {
        return {state, actions: []};
      }
      if (state.foreground) {
        // Cancellation lost a race with the timer firing. The person is looking
        // at the app; keep the socket.
        return {state: {...state, gracePending: false}, actions: []};
      }
      return {
        state: {...state, gracePending: false},
        actions: [{kind: 'disconnect'}],
      };
    }

    case 'network': {
      const changed =
        signal.networkType !== null && signal.networkType !== state.networkType;
      const next = {...state, networkType: signal.networkType};
      if (!changed || state.networkType === null) {
        // First observation is not a transition — there was no previous route to
        // have been stranded on.
        return {state: next, actions: []};
      }
      if (!state.wantConnected || !signal.online) {
        return {state: next, actions: []};
      }
      return {state: next, actions: [{kind: 'force-reconnect'}]};
    }

    default: {
      return {state, actions: []};
    }
  }
}
