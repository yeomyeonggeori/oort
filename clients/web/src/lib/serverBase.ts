import { normalizeServerUrl } from "@momo/core/lib/serverUrl";
import { API_BASE_DEFAULT, IS_TAURI } from "./env";

export {
  normalizeServerUrl,
  SERVER_URL_PLACEHOLDER,
  type ServerUrlCheck,
} from "@momo/core/lib/serverUrl";

// =============================================================================
// Which server this client talks to (MOMO-604 / ADR-0133 P2).
//
// goal RN-C1: the VALIDATION half of this module (`normalizeServerUrl`) moved to
// `@momo/core/lib/serverUrl` and is re-exported above, so every existing
// `@/lib/serverBase` import keeps resolving. What stayed is the half that has a
// platform in it: the stored choice, kept in localStorage here and in MMKV on
// RN.
//
// The P0/P1 build assumed same-origin: the browser asked `/v1/...` and the
// dev/preview server proxied it. That assumption holds for a web deployment and
// breaks everywhere else, because the Tauri shell serves the bundle from
// `tauri://localhost`, where a relative `/v1` addresses the app bundle and no
// server at all. A remote browser session pointed at a separate API host has
// the same problem.
//
// So the base is now a runtime value with three layers, most specific first:
//   1. the server the person chose on the connect screen (localStorage);
//   2. VITE_MOMO_API_BASE baked into the build (API_BASE_DEFAULT);
//   3. "" = same-origin relative paths, which is what keeps the existing web
//      deployment and the dev proxy working unchanged.
//
// The stored value is re-validated on read: a base arrives from a deep link, a
// discovery record or a text field, and none of those are trusted input.
//
// NOT stored here: the realtime WebSocket address. That is returned by login
// and used verbatim (ADR-0110); it is never derived from this base.
// =============================================================================

const STORAGE_KEY = "momo.web.server.v1";

// ---- the stored choice ------------------------------------------------------

function readStorage(): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const checked = normalizeServerUrl(raw);
    return checked.ok ? checked.base : null;
  } catch {
    return null;
  }
}

function writeStorage(value: string | null): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (value) localStorage.setItem(STORAGE_KEY, value);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable (private mode, quota, embedded webview policy): the
    // choice simply does not survive a reload, and the connect screen asks
    // again. Nothing else degrades.
  }
}

let chosen: string | null = readStorage();
const listeners = new Set<() => void>();

export function subscribeServerBase(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The stored choice, or null when this device is running on same-origin. */
export function getServerBase(): string | null {
  return chosen;
}

/**
 * Remember (or forget, with null) the server this device connects to. Accepts
 * only an already-normalised base; callers run `normalizeServerUrl` first so
 * the field can report what is wrong before anything is stored.
 */
export function setServerBase(base: string | null): void {
  const next = base === null || base === "" ? null : base;
  if (next === chosen) return;
  chosen = next;
  writeStorage(next);
  for (const listener of listeners) listener();
}

/**
 * The base every request is built on. "" means same-origin relative paths,
 * which is the web deployment's normal mode and the dev proxy's whole point.
 */
export function apiBase(): string {
  return chosen ?? API_BASE_DEFAULT;
}

/**
 * True when this runtime cannot fall back to same-origin, so a server address
 * is required rather than optional: inside the Tauri shell the page origin is
 * the app bundle, not an API.
 */
export function requiresServerUrl(): boolean {
  return IS_TAURI && API_BASE_DEFAULT === "";
}

/**
 * The absolute origin to hand someone else (invite links, "point your client
 * here"). Same-origin resolves to the browser's own origin, which is the honest
 * answer for a web deployment.
 */
export function absoluteApiBase(): string {
  const base = apiBase();
  if (base) return base;
  if (typeof window === "undefined") return "";
  return window.location.origin;
}
