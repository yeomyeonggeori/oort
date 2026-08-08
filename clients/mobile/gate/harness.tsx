import {login} from '@momo/core/lib/api';
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {
  ACCESSIBLE,
  getGenericPassword,
  resetGenericPassword,
  setGenericPassword,
} from 'react-native-keychain';
import {installReactQueryBridges} from '../src/query/queryClient';
import {sessionGateLaunch} from './root';
import type {AuthGate} from '../src/session/authGate';
import {useAuthGate} from '../src/session/useSession';
import {NON_SECRET_KEYS, nonSecretStore} from '../src/storage/kv';
import {
  __resetSessionStore,
  getPersistedSession,
  getRefreshToken,
  hasPersistedSession,
  initSessionStore,
  KEYCHAIN_SERVICE,
  keychainSettled,
  subscribeSession,
} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// The session-restore gate, run INSIDE the app on a simulator (goal RN-G1).
//
// ## Why this is not a jest test
//
// `__tests__/restoreOffline.test.ts` mocks `react-native-keychain`. It pins the
// *decision* — a launch with no signal must not cost the session — and it cannot
// pin the *mechanism*, because the mechanism is `SecItemAdd` and jest never
// reaches it. RN-C3 measured what that costs: a `CODE_SIGNING_ALLOWED=NO` build
// has no entitlements, every keychain call fails with errSecMissingEntitlement
// (-34018), `storeToken()` swallows it by design, and the app silently signs the
// person out on every relaunch **while every unit test stays green**.
//
// So this harness runs in the real process, against the real keychain, and the
// steps are separate LAUNCHES: the only honest way to ask "does a session
// survive a restart" is to restart.
//
// ## Why it does not drive the UI
//
// It calls the same functions the screens call — `login()` is what
// `ConnectScreen` calls, `useAuthGate()` is what `App.tsx` renders — and asserts
// on the store and the gate. Tapping through the UI would add a coordinate-and-
// timing layer whose failures look like product failures, and this batch is
// under an explicit instruction not to buy reliability with retries and sleeps.
//
// ## What each verdict means
//
// `fail` checks decide the exit code. `note` checks are observations the gate
// records but does not enforce — used where the current behaviour is a product
// defect that this (infrastructure) batch is not allowed to fix, so that the
// defect is visible in every run instead of being quietly asserted as correct.
// =============================================================================

type Severity = 'fail' | 'note';

interface Check {
  name: string;
  ok: boolean;
  severity: Severity;
  detail: string;
}

interface GatePlan {
  runId: string;
  step: string;
  apiBase: string;
  email: string;
  password: string;
  /** The refresh token the control server believes this device is holding. */
  expectRefreshToken: string | null;
  /** The handle the mock server logs in as. */
  expectHandle: string;
}

/** The probe writes to its own service so it cannot disturb the app's item. */
const PROBE_SERVICE = `${KEYCHAIN_SERVICE}.gate-probe`;

function check(
  name: string,
  ok: boolean,
  detail: string,
  severity: Severity = 'fail',
): Check {
  return {name, ok, severity, detail};
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as Error & {code?: unknown}).code;
    return code === undefined || code === null
      ? `${error.name}: ${error.message}`
      : `${error.name}: ${error.message} (code=${String(code)})`;
  }
  return String(error);
}

/** The app's stored refresh token, read straight out of the keychain. */
async function keychainToken(): Promise<string | null> {
  const result = await getGenericPassword({service: KEYCHAIN_SERVICE});
  return result === false ? null : result.password;
}

// ---- the raw keychain probe -------------------------------------------------
// `secureSession.ts` catches keychain failures on purpose: a failed write must
// not take down the sign-in that is currently succeeding. That is right for the
// product and it is exactly why the failure was invisible. The probe below is
// the one place that does NOT catch, so the OSStatus reaches the report.

async function probeKeychain(): Promise<Check[]> {
  const secret = `probe-${Date.now()}`;
  try {
    await resetGenericPassword({service: PROBE_SERVICE});
  } catch {
    // A missing item is not an error worth reporting; the write below is.
  }
  try {
    const wrote = await setGenericPassword('probe', secret, {
      service: PROBE_SERVICE,
      accessible: ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    });
    if (wrote === false) {
      return [check('keychain.write', false, 'setGenericPassword returned false')];
    }
  } catch (error) {
    return [
      check(
        'keychain.write',
        false,
        `SecItemAdd rejected this build: ${describeError(error)}`,
      ),
    ];
  }
  const checks = [check('keychain.write', true, 'SecItemAdd accepted')];
  try {
    const read = await getGenericPassword({service: PROBE_SERVICE});
    const value = read === false ? null : read.password;
    checks.push(
      check(
        'keychain.read',
        value === secret,
        value === null ? 'SecItemCopyMatching found nothing' : 'round-tripped',
      ),
    );
  } catch (error) {
    checks.push(check('keychain.read', false, describeError(error)));
  }
  try {
    await resetGenericPassword({service: PROBE_SERVICE});
  } catch {
    // Leaving a probe item behind is harmless: it uses its own service name.
  }
  return checks;
}

// ---- the steps --------------------------------------------------------------

/** Everything the device is carrying, wiped, so a run cannot inherit a pass. */
async function wipeDevice(): Promise<void> {
  const store = nonSecretStore();
  store.remove(NON_SECRET_KEYS.sessionMetadata);
  store.remove(NON_SECRET_KEYS.serverBase);
  __resetSessionStore();
  __resetServerBaseCache();
  try {
    await resetGenericPassword({service: KEYCHAIN_SERVICE});
  } catch {
    // Nothing stored is the state we are trying to reach.
  }
}

async function stepLogin(plan: GatePlan): Promise<Check[]> {
  await wipeDevice();
  const checks = await probeKeychain();
  // A build that cannot write to the keychain at all fails here, with the
  // OSStatus in the detail, rather than three launches later as "the session
  // did not survive" — which is the same defect wearing a much worse costume.
  if (checks.some(item => !item.ok)) {
    checks.push(
      check(
        'keychain.consequence',
        true,
        'nothing this app stores survives a relaunch — session restore cannot ' +
          'work in this build. Rebuild with scripts/build-sim.sh.',
        'note',
      ),
    );
    return checks;
  }

  setServerBase(plan.apiBase);
  await initSessionStore();
  // The response, not the plan: the plan was fetched before this login existed,
  // so the token to compare against is the one the server just issued.
  const issued = await login(plan.email, plan.password);
  await keychainSettled();

  const inMemory = getRefreshToken();
  checks.push(
    check(
      'login.persisted',
      inMemory === issued.refreshToken,
      inMemory === null
        ? 'the store kept no refresh token'
        : 'the store holds the issued refresh token',
    ),
  );
  const stored = await keychainToken();
  checks.push(
    check(
      'login.keychain',
      stored === issued.refreshToken,
      stored === null
        ? 'the keychain holds no refresh token after a successful login'
        : 'the keychain holds the issued refresh token',
    ),
  );

  // A second hydrate in this process, from cold: it proves the READ path as well
  // as the write, and it separates "never written" from "written, unreadable"
  // before the next launch has to distinguish them.
  __resetSessionStore();
  await initSessionStore();
  const rehydrated = getRefreshToken();
  checks.push(
    check(
      'login.rehydrate',
      rehydrated === issued.refreshToken,
      rehydrated === null
        ? 'a cold hydrate found nothing'
        : 'a cold hydrate in this process finds the stored session',
    ),
  );
  return checks;
}

/** Checks every relaunch step runs before the gate is allowed to decide. */
async function bootChecks(plan: GatePlan, expectSession: boolean): Promise<Check[]> {
  await initSessionStore();
  const token = getRefreshToken();
  if (!expectSession) {
    return [
      check(
        'boot.noSession',
        !hasPersistedSession(),
        hasPersistedSession()
          ? 'a session survived that should have been erased'
          : 'nothing to resume, as expected',
      ),
      check(
        'boot.keychainEmpty',
        (await keychainToken()) === null,
        'the keychain holds no refresh token',
      ),
    ];
  }
  return [
    check(
      'boot.sessionSurvived',
      hasPersistedSession(),
      hasPersistedSession()
        ? 'the stored session came back in a NEW PROCESS'
        : 'the stored session did not survive the relaunch',
    ),
    check(
      'boot.tokenMatches',
      token !== null && token === plan.expectRefreshToken,
      token === null
        ? 'no refresh token was restored'
        : 'the restored token is the one this run stored',
    ),
  ];
}

/**
 * Wait for the session store to reach `predicate`, then let the keychain queue
 * drain.
 *
 * This is a settle point, not a sleep. The gate can go terminal BEFORE the store
 * finishes: a refused rotation calls `markAuthExpired()` — which notifies, and
 * React re-renders the gate to `signedOut` — and only then unwinds into
 * `clearSession()`. Reading the keychain on the render would catch the refused
 * token still sitting there and call it a defect.
 *
 * `clearSession()` queues the keychain delete BEFORE it notifies, so a
 * notification that satisfies the predicate guarantees `keychainSettled()`
 * covers the delete. The budget is a bound on a local keychain operation that
 * takes microseconds, not a number to raise when the gate goes red.
 */
function whenSession(predicate: () => boolean, budgetMs = 2_000): Promise<boolean> {
  if (predicate()) {
    return Promise.resolve(true);
  }
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      unsubscribe();
      resolve(false);
    }, budgetMs);
    const unsubscribe = subscribeSession(() => {
      if (predicate()) {
        clearTimeout(timer);
        unsubscribe();
        resolve(true);
      }
    });
  });
}

async function afterGate(plan: GatePlan, gate: AuthGate): Promise<Check[]> {
  if (plan.step === 'restore-rejected') {
    await whenSession(() => !hasPersistedSession());
  }
  if (plan.step === 'restore-online') {
    await whenSession(() => getRefreshToken() !== plan.expectRefreshToken);
  }
  await keychainSettled();
  const stored = await keychainToken();
  const observed = `gate=${gate.kind}${
    gate.kind === 'restoring'
      ? ` unreachable=${gate.unreachable}`
      : gate.kind === 'signedOut'
        ? ` expired=${gate.expired}`
        : ''
  }`;

  switch (plan.step) {
    case 'restore-online': {
      const rotated = getRefreshToken();
      return [
        check('gate.signedIn', gate.kind === 'signedIn', observed),
        check(
          'restore.member',
          gate.kind === 'signedIn' && gate.member.handle === plan.expectHandle,
          'the restored member is the one that logged in',
        ),
        check(
          'restore.rotated',
          rotated !== null && rotated !== plan.expectRefreshToken,
          'resuming spent one rotation and stored the new token',
        ),
        check(
          'restore.rotationPersisted',
          stored !== null && stored === rotated,
          'the keychain holds the ROTATED token, not the spent one',
        ),
      ];
    }
    case 'restore-offline': {
      // The rule the live defect broke: nothing answered, so nothing is proven,
      // so nothing may be deleted.
      return [
        check(
          'offline.credentialsKept',
          hasPersistedSession(),
          hasPersistedSession()
            ? 'the session is still here after an unreachable server'
            : 'ONE UNREACHABLE START ERASED THE SESSION',
        ),
        check(
          'offline.keychainKept',
          stored !== null && stored === plan.expectRefreshToken,
          stored === null
            ? 'the refresh token was deleted by a failed rotation'
            : 'the refresh token is untouched',
        ),
        // Promoted from a `note` to an assertion (goal RN-P2). RN-G1 could only
        // RECORD this line, because the defect it named was product work: the
        // credentials survived an unreachable start and the screen shown was
        // still the sign-in form. `useAuthGate` now reads
        // `refreshSessionOutcome()`'s verdict instead of inferring one from a
        // null, so the right screen is a fact this gate can hold on to.
        //
        // **Both halves, deliberately.** `restoring` alone would also pass while
        // the rotation is merely slow, which is a different state wearing a
        // different screen; `unreachable` is what makes it 서버에 닿지
        // 못했습니다 with a retry instead of a silent spinner. And the answer
        // this must never be again is `signedOut` — a session thrown away
        // because a train went into a tunnel.
        check(
          'offline.gateUnreachable',
          gate.kind === 'restoring' && gate.unreachable,
          gate.kind === 'signedOut'
            ? `${observed} — AN UNREACHABLE START SHOWED THE SIGN-IN SCREEN`
            : observed,
        ),
      ];
    }
    case 'restore-rejected': {
      const store = nonSecretStore();
      return [
        check(
          'rejected.signedOut',
          gate.kind === 'signedOut' && gate.expired,
          observed,
        ),
        check(
          'rejected.credentialsCleared',
          !hasPersistedSession() && getPersistedSession() === null,
          'a refused token ends the session',
        ),
        check(
          'rejected.keychainCleared',
          stored === null,
          stored === null
            ? 'the refresh token was deleted'
            : 'a REFUSED token is still in the keychain',
        ),
        check(
          'rejected.metadataCleared',
          store.getString(NON_SECRET_KEYS.sessionMetadata) === undefined,
          'the session metadata was deleted with it',
        ),
      ];
    }
    case 'signed-out-sticks':
      return [check('signedOut.sticks', gate.kind === 'signedOut', observed)];
    default:
      return [check('step.unknown', false, `no assertions for step ${plan.step}`)];
  }
}

const STEPS_WITH_SESSION = ['restore-online', 'restore-offline', 'restore-rejected'];

// ---- the harness ------------------------------------------------------------

interface Phase {
  kind: 'working' | 'gate' | 'done';
  label: string;
}

export default function SessionGateHarness(): React.JSX.Element {
  // Read once, not through props: `index.js` decides to mount this by asking the
  // same function, and threading the answer through would let the two disagree.
  const launch = useRef(sessionGateLaunch()).current;
  const step = launch?.step ?? 'unknown';
  const controlBase = launch?.controlBase ?? '';
  const [phase, setPhase] = useState<Phase>({kind: 'working', label: step});
  const [plan, setPlan] = useState<GatePlan | null>(null);
  const carried = useRef<Check[]>([]);
  const reported = useRef(false);

  const report = useCallback(
    async (runId: string, checks: Check[]) => {
      if (reported.current) {
        return;
      }
      reported.current = true;
      const ok = checks.every(item => item.severity === 'note' || item.ok);
      const body = {runId, step, ok, checks};
      // Logged as well as posted: `simctl launch --console-pty` captures this,
      // so a run whose report never arrives still says what it decided.
      console.log(`MOMO_GATE ${JSON.stringify(body)}`);
      try {
        await fetch(`${controlBase}/__gate/report`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(body),
        });
      } catch (error) {
        console.log(`MOMO_GATE_REPORT_FAILED ${describeError(error)}`);
      }
      setPhase({kind: 'done', label: ok ? 'PASS' : 'FAIL'});
    },
    [controlBase, step],
  );

  useEffect(() => {
    let cancelled = false;
    const teardown = installReactQueryBridges();
    (async () => {
      let runId = 'unknown';
      try {
        const res = await fetch(`${controlBase}/__gate/plan`);
        const fetched = (await res.json()) as GatePlan;
        runId = fetched.runId;
        if (fetched.step !== step) {
          throw new Error(
            `the control server is on step ${fetched.step}, this launch is ${step}`,
          );
        }
        if (cancelled) {
          return;
        }
        setPlan(fetched);
        if (step === 'login') {
          await report(runId, await stepLogin(fetched));
          return;
        }
        const checks = await bootChecks(
          fetched,
          STEPS_WITH_SESSION.includes(step),
        );
        carried.current = checks;
        if (cancelled) {
          return;
        }
        // Same order `App.tsx` boots in: the keychain answers first, and only
        // then is the gate allowed to choose a screen.
        setPhase({kind: 'gate', label: step});
      } catch (error) {
        await report(runId, [
          check('harness', false, `the harness itself failed: ${describeError(error)}`),
        ]);
      }
    })();
    return () => {
      cancelled = true;
      teardown();
    };
  }, [controlBase, report, step]);

  const onTerminal = useCallback(
    (gate: AuthGate) => {
      const current = plan;
      if (current === null) {
        return;
      }
      void (async () => {
        try {
          const checks = carried.current.concat(await afterGate(current, gate));
          await report(current.runId, checks);
        } catch (error) {
          await report(current.runId, [
            check('harness', false, `assertions threw: ${describeError(error)}`),
          ]);
        }
      })();
    },
    [plan, report],
  );

  return (
    <View style={styles.root}>
      <Text style={styles.line}>momo session gate</Text>
      <Text style={styles.line}>{`${phase.kind}: ${phase.label}`}</Text>
      {phase.kind === 'gate' ? <GateObserver onTerminal={onTerminal} /> : null}
    </View>
  );
}

/**
 * The real `useAuthGate`, watched until it stops being undecided.
 *
 * `restoring` with `unreachable` false is the only non-terminal answer: it means
 * a rotation is still in flight. Everything else is a decision the app would
 * have rendered, so it is the moment to look at what happened to the credentials.
 */
function GateObserver({
  onTerminal,
}: {
  onTerminal: (gate: AuthGate) => void;
}): React.JSX.Element {
  const {gate} = useAuthGate();
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) {
      return;
    }
    if (gate.kind === 'restoring' && !gate.unreachable) {
      return;
    }
    fired.current = true;
    onTerminal(gate);
  }, [gate, onTerminal]);

  return <Text style={styles.line}>{`observed: ${gate.kind}`}</Text>;
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'center',
    padding: 24,
    gap: 8,
    backgroundColor: '#101014',
  },
  line: {color: '#fff', fontSize: 16},
});
