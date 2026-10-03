import { useSyncExternalStore } from "react";
import { isDesktop } from "@/lib/tauri";

// =============================================================================
// Browser OS notifications (#3340, #3335 T5). The Notification API half of
// what `osNotifier` hands to the desktop shell.
//
// Opt-in only: `requestBrowserPermission` is called from exactly one place, the
// settings button. Nothing here asks on load, on first event or on focus, and a
// tab without a grant never shows a banner (`notifyDecision` is gated on it).
// Not a toast (ADR-0182) and not push: the tab has to be open.
// =============================================================================

export type BrowserPermission = "default" | "granted" | "denied" | "unsupported";

export interface BrowserNotifyTarget {
  kind: string;
  /** App route the click lands on; absent = just bring the tab forward. */
  route?: string;
}

function api(): typeof Notification | null {
  try {
    return typeof Notification === "undefined" ? null : Notification;
  } catch {
    return null;
  }
}

/** Current permission without prompting. The desktop shell has its own bridge. */
export function readBrowserPermission(): BrowserPermission {
  if (isDesktop()) return "unsupported";
  const n = api();
  if (n === null) return "unsupported";
  const value = n.permission;
  return value === "granted" || value === "denied" ? value : "default";
}

const listeners = new Set<() => void>();
function emit(): void {
  for (const listener of listeners) listener();
}

/**
 * Ask the browser now. Call only from a click handler: the browser requires a
 * user gesture on some engines (Safari) and punishes unprompted asks everywhere.
 */
export async function requestBrowserPermission(): Promise<BrowserPermission> {
  const n = api();
  if (n === null || isDesktop()) return "unsupported";
  try {
    // Safari < 15 takes a callback and returns undefined; the promise form is
    // everywhere else. Support both and always re-read the live value.
    await new Promise<void>((resolve) => {
      const result = n.requestPermission(() => resolve()) as unknown;
      if (result && typeof (result as Promise<unknown>).then === "function") {
        void (result as Promise<unknown>).then(() => resolve(), () => resolve());
      }
    });
  } catch {
    // A throwing engine reads as whatever it says next.
  }
  emit();
  return readBrowserPermission();
}

/** Live permission for render: re-reads when the tab regains focus. */
export function useBrowserPermission(): BrowserPermission {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      window.addEventListener("focus", listener);
      document.addEventListener("visibilitychange", listener);
      return () => {
        listeners.delete(listener);
        window.removeEventListener("focus", listener);
        document.removeEventListener("visibilitychange", listener);
      };
    },
    readBrowserPermission,
    () => "unsupported"
  );
}

let openRoute: ((route: string) => void) | null = null;

/** The router's navigate, so a banner click can land on its target. */
export function setBrowserOpenHandler(handler: ((route: string) => void) | null): void {
  openRoute = handler;
}

/**
 * Show one banner. False when it was not shown (no API, not granted, throw):
 * a refused notification is a normal state, not an error. Click focuses this
 * tab and routes to the target.
 */
export async function showBrowserNotification(
  title: string,
  body?: string,
  target?: BrowserNotifyTarget
): Promise<boolean> {
  const n = api();
  if (n === null || isDesktop() || readBrowserPermission() !== "granted") return false;
  try {
    const banner = new n(title, {
      ...(body === undefined ? {} : { body }),
      // Same kind replaces the previous banner instead of stacking.
      ...(target ? { tag: `oort-${target.kind}` } : {}),
    });
    banner.onclick = () => {
      try {
        window.focus();
      } catch {
        // Some engines forbid it; the click still routes.
      }
      if (target?.route) openRoute?.(target.route);
      banner.close();
    };
    return true;
  } catch {
    return false;
  }
}
