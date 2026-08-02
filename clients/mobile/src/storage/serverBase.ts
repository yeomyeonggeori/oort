import {normalizeServerUrl} from '@momo/core/lib/serverUrl';
import {NON_SECRET_KEYS, nonSecretStore} from './kv';

// =============================================================================
// Which server this device talks to — the RN sibling of
// `clients/web/src/lib/serverBase.ts` (ADR-0137 D3 B군).
//
// The split is the ADR's: `normalizeServerUrl` is pure and lives in the core, so
// web, macOS and this app all accept and reject the same strings. What stayed
// platform-side is the half with storage in it — localStorage there, MMKV here.
//
// ## One real difference from web, and it is not cosmetic
//
// The web client may answer "" and mean *same-origin*: the page was served by
// the API, so `/v1/...` reaches it. **A native app has no origin.** "" here
// means "this device has not been told which server to talk to", and a request
// built on it would be sent to the string `/v1/...`, which fails in a way that
// looks like a network problem rather than a missing setting.
//
// So `requiresServerUrl()` is unconditionally true, and the connect screen
// treats an unset base as a question to ask rather than a default to fall back
// on. This is the same conclusion the Tauri shell reached for the same reason
// (`IS_TAURI && API_BASE_DEFAULT === ""`), arrived at from the other direction.
//
// NOT stored here: the realtime WebSocket address. Login returns it and it is
// used verbatim (ADR-0110); it is never derived from this base.
// =============================================================================

/** Re-exported so screens validate through one import, as web does. */
export {
  normalizeServerUrl,
  SERVER_URL_PLACEHOLDER,
  type ServerUrlCheck,
} from '@momo/core/lib/serverUrl';

function read(): string | null {
  try {
    const raw = nonSecretStore().getString(NON_SECRET_KEYS.serverBase);
    if (!raw) {
      return null;
    }
    // Re-validated on READ, not only on write: this value arrives from a text
    // field, a deep link or an mDNS record, and none of those are trusted input.
    // A build that tightened the rules must not keep honouring a base the
    // current rules reject.
    const checked = normalizeServerUrl(raw);
    return checked.ok ? checked.base : null;
  } catch {
    return null;
  }
}

let chosen: string | null = null;
let loaded = false;
const listeners = new Set<() => void>();

function current(): string | null {
  if (!loaded) {
    chosen = read();
    loaded = true;
  }
  return chosen;
}

export function subscribeServerBase(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The stored choice, or null when this device has not picked a server yet. */
export function getServerBase(): string | null {
  return current();
}

/**
 * Remember (or forget, with null) the server this device connects to. Accepts
 * only an already-normalised base: callers run `normalizeServerUrl` first so the
 * field can say what is wrong before anything is stored.
 */
export function setServerBase(base: string | null): void {
  const next = base === null || base === '' ? null : base;
  if (loaded && next === chosen) {
    return;
  }
  chosen = next;
  loaded = true;
  try {
    if (next === null) {
      nonSecretStore().remove(NON_SECRET_KEYS.serverBase);
    } else {
      nonSecretStore().set(NON_SECRET_KEYS.serverBase, next);
    }
  } catch {
    // Storage unavailable: the choice does not survive a relaunch and the
    // connect screen asks again. Nothing else degrades, so this is not worth
    // failing the sign-in the person is in the middle of.
  }
  for (const listener of listeners) {
    listener();
  }
}

/** The base every request is built on. "" means "not chosen yet" (see above). */
export function apiBase(): string {
  return current() ?? '';
}

/**
 * True when a server address is required rather than optional. Always, on a
 * native client: there is no origin to fall back to.
 */
export function requiresServerUrl(): boolean {
  return true;
}

/**
 * The absolute origin to hand someone else (invite links, "point your client
 * here"). Identical to `apiBase()` here, because a stored base is already
 * absolute — there is no relative mode to resolve, which is the whole of the
 * difference from web.
 */
export function absoluteApiBase(): string {
  return apiBase();
}

/** Test seam: drop the memoised value so a fresh store is re-read. */
export function __resetServerBaseCache(): void {
  chosen = null;
  loaded = false;
}
