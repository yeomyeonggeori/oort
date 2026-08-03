import {Settings} from 'react-native';

// =============================================================================
// Is this process a SESSION GATE run? (goal RN-G1)
//
// Same mechanism `measure/root.ts` uses and for the same reason: iOS puts
// `-key value` launch arguments into NSUserDefaults' argument domain, React
// Native's `Settings` module reads that domain back, and nothing persists — the
// next launch without the arguments is the app.
//
// Two arguments rather than one:
//
//   -momoSessionGate <step>    which scenario step this process is running.
//                              Named in the argument so a launch that never
//                              reports is still identifiable from the log.
//   -momoGateControl <url>     where to fetch the plan and post the verdict.
//                              Passed in because the orchestrator binds an
//                              ephemeral port; nothing is hardcoded and two
//                              runs cannot collide on one socket.
//
// `__DEV__` gates it, so a release build cannot be talked into the harness by
// anyone who can pass it arguments.
// =============================================================================

export interface SessionGateLaunch {
  /** The scenario step, e.g. `login`, `restore-offline`. */
  step: string;
  /** Origin of the orchestrator's control server, e.g. `http://127.0.0.1:52344`. */
  controlBase: string;
}

export function sessionGateLaunch(): SessionGateLaunch | null {
  if (!__DEV__) {
    return null;
  }
  const step = Settings.get('momoSessionGate');
  const controlBase = Settings.get('momoGateControl');
  if (typeof step !== 'string' || step.length === 0) {
    return null;
  }
  if (typeof controlBase !== 'string' || controlBase.length === 0) {
    return null;
  }
  return {step, controlBase};
}
