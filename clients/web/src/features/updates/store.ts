import { useSyncExternalStore } from "react";
import { appVersion, desktopUpdater, isDesktop } from "@/lib/tauri";
import type { AvailableUpdate } from "@/lib/tauri";
import type { UpdateState } from "./model";

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

/**
 * How often a long-running window asks again. Six hours, not six minutes: a
 * tester who leaves the app open for a week should still learn about a build,
 * and an internal channel that publishes twice a day gains nothing from polling
 * a static file on a CDN every few minutes.
 */
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let state: UpdateState = { kind: "idle" };
let currentVersion: string | null = null;
let watching = false;
let inFlight = false;

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

function versionSnapshot(): string | null {
  return currentVersion;
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

/** The shared update state. */
export function useUpdateState(): UpdateState {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * Ask the manifest.
 *
 * A check while a download is running would be answered from a stale slot and
 * could replace the update being installed, so it is refused rather than
 * queued. Failure is a state, not a thrown error: every caller here is a click
 * handler or a timer, and neither has anywhere to put an exception.
 */
export async function checkForUpdate(): Promise<void> {
  if (!isDesktop()) return;
  if (inFlight || state.kind === "installing") return;
  inFlight = true;
  set({ kind: "checking" });
  try {
    const found = await desktopUpdater.check();
    set(found ? { kind: "available", update: found } : { kind: "current" });
  } catch (error) {
    set({
      kind: "failed",
      message: "업데이트 서버에 닿지 못했습니다. 네트워크를 확인하고 다시 시도하세요.",
      detail: messageOf(error),
      update: null,
    });
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
  } catch (error) {
    set({
      kind: "failed",
      message: "업데이트를 설치하지 못했습니다. 지금 쓰던 버전은 그대로입니다.",
      detail: messageOf(error),
      // Deliberately dropped: the shell consumed its pending update, so a retry
      // has to check again rather than reuse a handle that is already spent.
      update: null,
    });
  } finally {
    stop();
  }
}

/** Restart into the installed build. Never returns on success. */
export async function relaunchIntoUpdate(): Promise<void> {
  await desktopUpdater.relaunch();
}

/**
 * Resolve the running version and start the periodic check. Idempotent, and a
 * no-op in a browser tab, where there is no app bundle to replace and a reload
 * already gets the newest bundle.
 *
 * Returns the cleanup for the interval. Deliberately NOT tied to a component's
 * lifetime beyond the shell: navigating to another route must not restart the
 * check.
 */
export function startUpdateWatch(): () => void {
  if (!isDesktop() || watching) return () => {};
  watching = true;

  void appVersion().then((version) => {
    currentVersion = version;
    for (const listener of listeners) listener();
  });
  void checkForUpdate();

  const timer = window.setInterval(() => void checkForUpdate(), RECHECK_INTERVAL_MS);
  return () => {
    window.clearInterval(timer);
    watching = false;
  };
}

/** Test seam: reset the singleton between cases. */
export function resetUpdateStoreForTest(): void {
  state = { kind: "idle" };
  currentVersion = null;
  watching = false;
  inFlight = false;
  listeners.clear();
}
