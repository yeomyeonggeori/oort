// =============================================================================
// Desktop shell bridge (ADR-0133 P2, MOMO-603).
//
// The SAME bundle runs in a browser tab and inside the Tauri shell, so every
// native capability has to be optional at runtime, not at build time. This file
// is the only place in `clients/web` that knows that: everywhere else calls a
// plain async function and gets a browser-shaped answer (nothing found, no
// permission, no keychain) when there is no shell underneath.
//
// The Rust half lives in `clients/desktop/src-tauri/src/{deeplink,discovery,
// notification,keychain,updater}.rs` and the command/event contract is
// documented in `clients/desktop/README.md`. Keep the three in sync — a renamed
// command fails at runtime, not at compile time.
//
// `@tauri-apps/api` is imported DYNAMICALLY on purpose. Vite splits it into its
// own chunk that a browser tab never requests, so the desktop bridge costs the
// web build nothing but a few bytes of guard code.
// =============================================================================

import { IS_TAURI } from "./env";

/** True when the native commands below can actually do something. */
export function isDesktop(): boolean {
  return IS_TAURI;
}

/** Event names emitted by the shell. Mirrors the Rust `*_EVENT` constants. */
export const DESKTOP_EVENT = {
  /** One accepted `momo://join` link. */
  deepLink: "momo:deep-link",
  /** The full current set of discovered servers. */
  discovery: "momo:discovery",
  /** Bytes downloaded so far while an update installs. */
  updateProgress: "momo:update-progress",
} as const;

// ---- module plumbing --------------------------------------------------------

type CoreModule = typeof import("@tauri-apps/api/core");
type EventModule = typeof import("@tauri-apps/api/event");

let corePromise: Promise<CoreModule> | null = null;
let eventPromise: Promise<EventModule> | null = null;

function core(): Promise<CoreModule> {
  corePromise ??= import("@tauri-apps/api/core");
  return corePromise;
}

function events(): Promise<EventModule> {
  eventPromise ??= import("@tauri-apps/api/event");
  return eventPromise;
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: call } = await core();
  return call<T>(command, args);
}

/** No-op unsubscribe, so callers can treat browser and desktop identically. */
const noop = () => {};

/**
 * Subscribe to a shell event. Resolves to the unsubscribe function; in a browser
 * it resolves immediately to a no-op, so `useEffect` cleanup stays uniform.
 */
async function listen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
  if (!IS_TAURI) return noop;
  const { listen: subscribe } = await events();
  const unlisten = await subscribe<T>(event, ({ payload }) => handler(payload));
  return unlisten;
}

// ---- deep links -------------------------------------------------------------

/**
 * A `momo://join` link the OS handed to the shell.
 *
 * Contract: `docs/onboarding-deeplink.md`. `server` and `code` arrive
 * percent-decoded and trimmed; either may be empty (a link carrying only one of
 * them still saves typing), never both. `server` is NOT validated as a base URL
 * by the shell — the join surface re-validates it, exactly as the macOS client
 * does, so that rule keeps a single owner.
 */
export interface DeepLinkJoin {
  /** The raw link. Carries the invite code — do not log it. */
  url: string;
  server: string;
  code: string;
}

/** Listen for links that arrive while the app is running. */
export function onDeepLink(handler: (link: DeepLinkJoin) => void): Promise<() => void> {
  return listen<DeepLinkJoin>(DESKTOP_EVENT.deepLink, handler);
}

/**
 * Drain links that arrived before this webview could listen, and tell the shell
 * it is now listening.
 *
 * Clicking an invite link with the app closed launches it, and macOS delivers
 * the URL long before React mounts. The shell buffers those; this call is the
 * handshake that releases them. Call it ONCE, right after `onDeepLink` resolves
 * — earlier and the buffer is released to nobody, twice and the second call
 * returns nothing.
 */
export async function takePendingDeepLinks(): Promise<DeepLinkJoin[]> {
  if (!IS_TAURI) return [];
  return invoke<DeepLinkJoin[]>("deep_link_take_pending");
}

// ---- LAN server discovery ---------------------------------------------------

/** A server advertised on the LAN as `_momo._tcp` with a TXT `base` key. */
export interface DiscoveredServer {
  /** API base URL, exactly as advertised — this is what gets prefilled. */
  baseUrl: string;
  /** Short label, e.g. `MacBook-Pro-2.local:28000`. */
  displayHost: string;
  /** Bonjour instance name, e.g. `momo`. */
  instanceName: string;
}

export interface DiscoveryPayload {
  servers: DiscoveredServer[];
  /** False on the last event of a scan. */
  scanning: boolean;
}

/** Listen for discovery results. The shell emits the FULL set every time. */
export function onDiscovery(handler: (payload: DiscoveryPayload) => void): Promise<() => void> {
  return listen<DiscoveryPayload>(DESKTOP_EVENT.discovery, handler);
}

/**
 * Start a scan. Results arrive through `onDiscovery`, so subscribe first.
 *
 * Never rejects: no responder, no permission and nothing on the network are the
 * same outcome to the person looking at the screen — an empty list — and
 * discovery is an offer, not a step. The cause is logged for the console.
 */
export async function startDiscovery(timeoutMs?: number): Promise<void> {
  if (!IS_TAURI) return;
  try {
    await invoke<void>("discovery_start", { timeoutMs });
  } catch (error) {
    console.warn("[momo] server discovery unavailable", error);
  }
}

/** Stop a scan early. Idempotent. */
export async function stopDiscovery(): Promise<void> {
  if (!IS_TAURI) return;
  try {
    await invoke<void>("discovery_stop");
  } catch {
    /* nothing to stop */
  }
}

// ---- native notifications ---------------------------------------------------

/** Same vocabulary as the browser Notification API, minus the prompt variants. */
export type DesktopNotificationPermission = "granted" | "denied" | "default";

/** Current permission, without prompting. */
export async function notificationPermission(): Promise<DesktopNotificationPermission> {
  if (!IS_TAURI) return "denied";
  try {
    return await invoke<DesktopNotificationPermission>("notification_permission");
  } catch {
    return "denied";
  }
}

let permissionPromise: Promise<DesktopNotificationPermission> | null = null;

/**
 * Ensure permission, asking at most once per app run.
 *
 * The prompt is deliberately not fired at boot: an OS permission dialog before
 * someone has any reason to want notifications is the fastest way to get a
 * permanent "no". Call this at the moment a notification is first worth showing.
 */
export async function ensureNotificationPermission(): Promise<DesktopNotificationPermission> {
  if (!IS_TAURI) return "denied";
  permissionPromise ??= (async () => {
    const current = await notificationPermission();
    if (current !== "default") return current;
    try {
      return await invoke<DesktopNotificationPermission>("notification_request_permission");
    } catch {
      return "denied";
    }
  })();
  return permissionPromise;
}

/**
 * Show one native notification. Returns false when it was not shown — in a
 * browser, or because permission is not granted. A refused notification is a
 * normal state, so it is a return value rather than a thrown error.
 */
export async function showNotification(title: string, body?: string): Promise<boolean> {
  if (!IS_TAURI) return false;
  if ((await ensureNotificationPermission()) !== "granted") return false;
  try {
    return await invoke<boolean>("notification_show", { title, body });
  } catch (error) {
    console.warn("[momo] native notification failed", error);
    return false;
  }
}

// ---- OS credential store ----------------------------------------------------

/**
 * The refresh token at rest, in the OS keychain instead of localStorage.
 *
 * Consumed by `./session.ts`, which is the only caller that should exist: the
 * point of moving the token out of web storage is that fewer places can reach
 * it, and a second caller would undo that.
 *
 * Reads and writes can block on an OS prompt, so every method is async and none
 * of them throws — a keychain that will not answer degrades the session to web
 * storage rather than blocking sign-in (see `session.ts`).
 */
export const desktopKeychain = {
  /** True when this platform has a credential store this build can use. */
  async available(): Promise<boolean> {
    if (!IS_TAURI) return false;
    try {
      return await invoke<boolean>("keychain_available");
    } catch {
      return false;
    }
  },

  /** The stored refresh token, or null when there is no session to resume. */
  async load(): Promise<string | null> {
    if (!IS_TAURI) return null;
    try {
      return await invoke<string | null>("keychain_load_refresh_token");
    } catch (error) {
      console.warn("[momo] keychain read failed", error);
      return null;
    }
  },

  /** Store (replacing) the refresh token. Returns false if it did not land. */
  async store(token: string): Promise<boolean> {
    if (!IS_TAURI) return false;
    try {
      await invoke<void>("keychain_store_refresh_token", { token });
      return true;
    } catch (error) {
      console.warn("[momo] keychain write failed", error);
      return false;
    }
  },

  /** Delete the stored refresh token. Succeeds when there was nothing to delete. */
  async clear(): Promise<boolean> {
    if (!IS_TAURI) return false;
    try {
      await invoke<void>("keychain_clear_refresh_token");
      return true;
    } catch (error) {
      console.warn("[momo] keychain clear failed", error);
      return false;
    }
  },
};

// ---- self-update ------------------------------------------------------------

/** The build this shell is running, e.g. `0.1.0-next.1`. Null in a browser. */
export async function appVersion(): Promise<string | null> {
  if (!IS_TAURI) return null;
  try {
    return await invoke<string>("app_version");
  } catch {
    return null;
  }
}

/** A newer build announced by the update manifest. */
export interface AvailableUpdate {
  /** The version on offer. */
  version: string;
  /** The version running now, so the offer can be shown as a transition. */
  currentVersion: string;
  /** Release notes from the manifest. May be absent. */
  notes: string | null;
  /** The manifest's publish timestamp (RFC 3339), verbatim. May be absent. */
  publishedAt: string | null;
}

export interface UpdateProgress {
  downloaded: number;
  /** Null when the server sent no Content-Length. */
  total: number | null;
}

/**
 * Self-update, in three separate acts (ADR-0133 P2, MOMO-606).
 *
 * Unlike the rest of this file, `check` and `install` REJECT on failure instead
 * of degrading quietly. "I could not reach the update server" and "you are on
 * the latest build" must never look the same to a tester, or a stalled release
 * channel stays invisible until someone reports a bug that was fixed a week
 * ago. `relaunch` is the exception and by nature: it never returns.
 */
export const desktopUpdater = {
  /** Ask the manifest. Resolves to null when this build is current. */
  async check(): Promise<AvailableUpdate | null> {
    if (!IS_TAURI) return null;
    return invoke<AvailableUpdate | null>("updater_check");
  },

  /**
   * Download, verify (minisign) and swap the app bundle on disk. Does NOT
   * restart: on macOS the running process keeps executing the old image until
   * it exits, so when to restart is the person's call, not ours.
   */
  async install(): Promise<void> {
    if (!IS_TAURI) return;
    return invoke<void>("updater_install");
  },

  /** Restart into the installed build. Never resolves. */
  async relaunch(): Promise<void> {
    if (!IS_TAURI) return;
    return invoke<void>("updater_relaunch");
  },

  /** Download progress while `install` runs. */
  onProgress(handler: (progress: UpdateProgress) => void): Promise<() => void> {
    return listen<UpdateProgress>(DESKTOP_EVENT.updateProgress, handler);
  },
};
