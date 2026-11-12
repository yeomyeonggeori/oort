import { useSyncExternalStore } from "react";
import {
  localWorkVerdict,
  restartGateStep,
  type LocalWorkFacts,
  type LocalWorkVerdict,
  type RestartGate,
} from "@momo/core/features/workbench/localWork";
import { recordConnectionDiag } from "@/features/common/connectionDiag";
import { appVersion, desktopUpdater, isDesktop } from "@/lib/tauri";
import type { AvailableUpdate } from "@/lib/tauri";
import { RELAUNCH_COUNTDOWN_SECONDS, UPDATER_DISABLED, type UpdateState } from "./model";
import { flushBeforeRelaunch } from "./relaunchFlush";
import { startUpdateSchedule, type ScheduledCheckResult } from "./schedule";

// =============================================================================
// The one update channel this app run has (ADR-0133 P2, MOMO-606).
//
// A module singleton rather than a hook's local state, because two surfaces
// render the same fact: the sidebar badge and the settings panel. Two hooks
// would mean two independent checks racing the same manifest, two progress
// bars disagreeing during the same download, and a badge that keeps offering an
// update the settings panel already installed.
//
// Same shape as `lib/session.ts` (subscribe + snapshot + notify), read through
// `useSyncExternalStore` so React never tears between the two renderers.
// =============================================================================

// How often a long-running window asks again lives in `schedule.ts` (#5661):
// at launch, every six hours of WALL-CLOCK time, thirty minutes after a failure,
// and once when the Mac wakes or the window comes back. Six hours, not six
// minutes: an internal channel that publishes twice a day gains nothing from
// polling a static file on a CDN every few minutes. The old `setInterval(6h)`
// counted only awake time, so a laptop shut every night could go days between
// checks.

let state: UpdateState = { kind: "idle" };
let currentVersion: string | null = null;
let watching = false;
let inFlight = false;
/** When the last check that actually asked (or learned it cannot ask) finished. */
let lastCheckedAt: number | null = null;
/** `update.check.off` goes into the connection log once per run, not every six hours. */
let offRecorded = false;
/** Seconds left before the automatic restart, or null when none is scheduled. */
let relaunchIn: number | null = null;
let relaunchTimer: number | null = null;

/**
 * Where this run reads its local work (#5661, owner 2026-11-11: restart on its own, but never cut work that is
 * running on this Mac). `App` wires the real one through `startUpdateWatch`; without one (a test that mounts a
 * single surface) the restart is the plain three-second countdown it always was.
 */
export interface LocalWorkSource {
  /** Re-read what needs a round trip (the work daemon's status). Never rejects: what it cannot read is unknown. */
  refresh(): Promise<void>;
  /** The facts as of now. Synchronous: the countdown asks it every second. */
  read(): LocalWorkFacts;
}

/** What holds the automatic restart, for the surfaces. `cut` is what 「지금 다시 시작」 would stop; null once the work has ended and the quiet period runs. */
export interface RelaunchHold {
  readonly cut: Extract<LocalWorkVerdict, { kind: "busy" }> | null;
}

/** While a restart waits for local work, the facts are read again this often. */
export const RESTART_GATE_TICK_MS = 5_000;

let localWork: LocalWorkSource | null = null;
let gate: RestartGate | null = null;
let gateTimer: number | null = null;
/** Set once a restart has been asked for (automatic or by hand): the gate stops, a failed restart waits for 「지금」. */
let gateDone = false;
let relaunchHold: RelaunchHold | null = null;

const listeners = new Set<() => void>();

function set(next: UpdateState): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): UpdateState {
  return state;
}

function countdownSnapshot(): number | null {
  return relaunchIn;
}

function versionSnapshot(): string | null {
  return currentVersion;
}

function lastCheckedSnapshot(): number | null {
  return lastCheckedAt;
}

function holdSnapshot(): RelaunchHold | null {
  return relaunchHold;
}

function notify(): void {
  for (const listener of listeners) listener();
}

function messageOf(error: unknown): string | null {
  if (error === null || error === undefined) return null;
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** The running build, once `startUpdateWatch()` has resolved it. */
export function useAppVersion(): string | null {
  return useSyncExternalStore(subscribe, versionSnapshot, versionSnapshot);
}

/**
 * Seconds until the automatic restart (3, 2, 1), or null when none is pending.
 * It lives here and not in the card: the card can be closed or the sidebar
 * folded (⌘B) and the owner's decision is still "restart on its own".
 */
export function useRelaunchCountdown(): number | null {
  return useSyncExternalStore(subscribe, countdownSnapshot, countdownSnapshot);
}

/** The shared update state. */
export function useUpdateState(): UpdateState {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** When the last finished check ran (epoch ms), or null before the first one. */
export function useLastCheckedAt(): number | null {
  return useSyncExternalStore(subscribe, lastCheckedSnapshot, lastCheckedSnapshot);
}

/** Non-null while an installed update waits for local work to end (「작업이 끝나면 다시 시작해요」). */
export function useRelaunchHold(): RelaunchHold | null {
  return useSyncExternalStore(subscribe, holdSnapshot, holdSnapshot);
}

/**
 * Ask the manifest.
 *
 * A check while a download is running would be answered from a stale slot and
 * could replace the update being installed, so it is refused rather than
 * queued. Failure is a state, not a thrown error: every caller here is a click
 * handler or a timer, and neither has anywhere to put an exception.
 *
 * The channel/dev/debug guard is NOT here. This exact bundle ships in a
 * `tauri dev` run, a local `cargo tauri build`, and a published channel
 * artifact, so the web side cannot tell a local build (which the published
 * manifest would only ever downgrade) from a shipping one. That judgement
 * lives in the shell, where the build kind is known: `updater_check` in
 * `clients/desktop/src-tauri/src/updater.rs` does not ask the feed unless
 * `MOMO_CHANNEL_BUILD=1` was set at compile time (#1281, W-B2-5). Then the
 * shell rejects with `UPDATER_DISABLED`, and that becomes `{kind: "off"}` here
 * — never `current`: a build that did not look must not say 「최신」 (#5661).
 *
 * A check while an installed update waits for its restart is refused too: the
 * running version is still the old one, so the manifest would offer the same
 * build again and flip 「곧 다시 실행」 back to 「새 버전」.
 *
 * While a new build is already on offer, a re-check keeps the offer on screen
 * (#5661): no 「확인 중」 blink of the pill on every wake or window return, and a
 * re-check that fails because the network is not back yet does not take the
 * pill away. The shell keeps the update it found (`pending`) when a check
 * errors, so 「업데이트」 still installs that build. The failure is still logged.
 *
 * Resolves with what it learned, for the schedule (`schedule.ts`). A failed
 * check goes into the connection log (설정 > 업데이트 > 연결 기록) as a time and
 * a kind only. 「마지막 확인」 moves only when a check got an answer.
 */
export async function checkForUpdate(): Promise<ScheduledCheckResult> {
  if (!isDesktop()) return "refused";
  if (inFlight || state.kind === "installing" || state.kind === "installed") return "refused";
  inFlight = true;
  const offered = state.kind === "available";
  if (!offered) set({ kind: "checking" });
  try {
    const found = await desktopUpdater.check();
    lastCheckedAt = Date.now();
    set(found ? { kind: "available", update: found } : { kind: "current" });
    return found ? "available" : "current";
  } catch (error) {
    const at = Date.now();
    if (messageOf(error) === UPDATER_DISABLED) {
      if (!offRecorded) {
        offRecorded = true;
        recordConnectionDiag("update.check.off", at);
      }
      set({ kind: "off" });
      return "off";
    }
    recordConnectionDiag("update.check.failed", at);
    if (offered) return "failed";
    set({
      kind: "failed",
      phase: "check",
      message: "업데이트 서버에 닿지 못했어요. 네트워크를 확인하고 다시 시도하세요.",
      detail: messageOf(error),
      update: null,
    });
    return "failed";
  } finally {
    inFlight = false;
  }
}

/**
 * Download, verify and swap the bundle. Does not restart.
 *
 * Progress arrives as shell events; the subscription is opened before the
 * install starts and closed in `finally`, so a failed install cannot leave a
 * listener behind that reports bytes for an update that no longer exists.
 */
export async function installUpdate(): Promise<void> {
  if (!isDesktop()) return;
  const pending: AvailableUpdate | null =
    state.kind === "available" || state.kind === "failed" ? state.update : null;
  if (!pending) return;

  set({ kind: "installing", update: pending, downloaded: 0, total: null });

  const stop = await desktopUpdater.onProgress(({ downloaded, total }) => {
    // Ignore late events from a previous attempt: only the live install owns
    // the progress numbers.
    if (state.kind !== "installing") return;
    set({ kind: "installing", update: pending, downloaded, total });
  });

  try {
    await desktopUpdater.install();
    set({ kind: "installed", update: pending });
    afterInstall();
  } catch (error) {
    set({
      kind: "failed",
      phase: "install",
      message: "업데이트를 설치하지 못했어요. 지금 쓰던 버전은 그대로예요.",
      detail: messageOf(error),
      // Deliberately dropped: the shell consumed its pending update, so a retry
      // has to check again rather than reuse a handle that is already spent.
      update: null,
    });
  } finally {
    stop();
  }
}

function clearRelaunchTimer(): void {
  if (relaunchTimer !== null) {
    window.clearTimeout(relaunchTimer);
    relaunchTimer = null;
  }
}

function clearGateTimer(): void {
  if (gateTimer !== null) {
    window.clearTimeout(gateTimer);
    gateTimer = null;
  }
}

/**
 * The install finished: restart now, or wait for local work (#5661). Without a wired source this is the plain
 * countdown. With one, the first verdict decides (nothing running → the countdown at once, no quiet period), and
 * from then on the facts are read every `RESTART_GATE_TICK_MS` until the gate opens.
 */
function afterInstall(): void {
  gate = null;
  gateDone = false;
  if (localWork === null) {
    scheduleRelaunch();
    return;
  }
  void evaluateGate(true);
}

/**
 * One step of the gate (`restartGateStep`, core). `refresh` re-reads the work daemon first; the countdown's
 * per-second check does not (it only needs to see a pane or session that just started).
 * Returns true when the restart may go on.
 */
async function evaluateGate(refresh: boolean): Promise<boolean> {
  const source = localWork;
  if (source === null || gateDone || state.kind !== "installed") return !gateDone;
  if (refresh) await source.refresh();
  if (localWork !== source || gateDone || state.kind !== "installed") return false;
  return applyGate(source.read());
}

function applyGate(facts: LocalWorkFacts): boolean {
  gate = restartGateStep(gate, localWorkVerdict(facts), Date.now());
  clearGateTimer();
  if (gate.kind === "go") {
    const wasHolding = relaunchHold !== null;
    relaunchHold = null;
    if (relaunchIn === null) scheduleRelaunch();
    else if (wasHolding) notify();
    return true;
  }
  // Holding: no countdown on screen, and the facts are read again shortly.
  clearRelaunchTimer();
  relaunchIn = null;
  relaunchHold = { cut: gate.kind === "hold" ? gate.verdict : null };
  notify();
  gateTimer = window.setTimeout(() => {
    gateTimer = null;
    void evaluateGate(true);
  }, RESTART_GATE_TICK_MS);
  return false;
}

/** Start the 3-second countdown after a finished install. One at a time. */
function scheduleRelaunch(): void {
  clearRelaunchTimer();
  relaunchIn = RELAUNCH_COUNTDOWN_SECONDS;
  notify();
  const tick = () => {
    relaunchTimer = null;
    if (relaunchIn === null) return;
    // Work that started during the countdown (a pane opened, a session began) puts the restart back on hold.
    if (localWork !== null && !applyGate(localWork.read())) return;
    if (relaunchIn <= 1) {
      void relaunchIntoUpdate();
      return;
    }
    relaunchIn -= 1;
    notify();
    relaunchTimer = window.setTimeout(tick, 1000);
  };
  relaunchTimer = window.setTimeout(tick, 1000);
}

/**
 * Restart into the installed build. Never returns on success.
 *
 * Every restart path (the automatic countdown, the gate opening after local
 * work ends, 「지금」/「지금 다시 시작」, Settings, the connect screen) goes through
 * here, so this is the one place that makes sure unsent text is on disk first.
 * Pressed by hand it does not ask the gate: the card already said what it
 * stops. A failed restart keeps the installed state and puts the countdown
 * away; the 「지금」 button stays, so nothing is lost.
 */
export async function relaunchIntoUpdate(): Promise<void> {
  clearRelaunchTimer();
  clearGateTimer();
  gateDone = true;
  flushBeforeRelaunch();
  try {
    await desktopUpdater.relaunch();
  } catch {
    relaunchIn = null;
    // The gate has stopped: 「작업이 끝나면」 would now be a promise nobody keeps. The card falls back to 「지금」.
    relaunchHold = null;
    notify();
  }
}

/**
 * Resolve the running version and start the schedule (`schedule.ts`): a check
 * now, then by the wall clock, and once when the Mac wakes, the window is shown
 * again or the device comes back online. Idempotent, and a no-op in a browser
 * tab, where there is no app bundle to replace and a reload already gets the
 * newest bundle.
 *
 * Returns the cleanup. Deliberately NOT tied to a component's lifetime beyond
 * the shell: navigating to another route must not restart the check.
 *
 * `localWork` is what the automatic restart waits on (#5661). The app passes the
 * real reader (`localWorkSource.ts`); it is a parameter so this module does not
 * pull the terminal manager into every test that renders an update surface.
 */
export function startUpdateWatch(options: { localWork?: LocalWorkSource } = {}): () => void {
  if (!isDesktop() || watching) return () => {};
  watching = true;
  localWork = options.localWork ?? null;

  void appVersion().then((version) => {
    currentVersion = version;
    for (const listener of listeners) listener();
  });

  const schedule = startUpdateSchedule({
    now: () => Date.now(),
    setTimer: (run, ms) => window.setTimeout(run, ms),
    clearTimer: (handle) => window.clearTimeout(handle as number),
    check: checkForUpdate,
  });
  const onVisible = () => {
    if (document.visibilityState === "visible") schedule.nudge();
  };
  const onBack = () => schedule.nudge();
  const onOnline = () => schedule.nudge("online");
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", onBack);
  window.addEventListener("online", onOnline);
  return () => {
    schedule.stop();
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", onBack);
    window.removeEventListener("online", onOnline);
    watching = false;
    localWork = null;
    clearGateTimer();
  };
}

/** Test and capture seam: put the store into a given state without a manifest. */
export function seedUpdateStateForTest(
  next: UpdateState,
  countdown: number | null = null,
  hold: RelaunchHold | null = null
): void {
  state = next;
  relaunchIn = countdown;
  relaunchHold = hold;
  notify();
}

/** Test seam: reset the singleton between cases. */
export function resetUpdateStoreForTest(): void {
  state = { kind: "idle" };
  currentVersion = null;
  watching = false;
  inFlight = false;
  lastCheckedAt = null;
  offRecorded = false;
  clearRelaunchTimer();
  relaunchIn = null;
  localWork = null;
  gate = null;
  clearGateTimer();
  gateDone = false;
  relaunchHold = null;
  listeners.clear();
}
