import type { LoginResponse } from "../lib/api";
import type { PersistedSession } from "../lib/sessionModel";

// =============================================================================
// The host port (ADR-0137 D3, goal RN-C1).
//
// This is the ONE place the core is allowed to depend on something it does not
// implement. Everything the domain logic needs from a platform arrives through
// here as a plain function, so the core itself contains no `window`, no
// `localStorage`, no keychain, and no bundler-specific config — a rule the
// purity gate (`packages/momo-core/scripts/purity.mjs`) enforces mechanically
// rather than by convention.
//
// Two ports, matching the two things the ADR called out as adapter-shaped:
//
//   apiBase / absoluteApiBase   WHICH server this device talks to. The value is
//                               stored per device: localStorage on web
//                               (`clients/web/src/lib/serverBase.ts`), MMKV on
//                               RN. The core only ever asks for the answer.
//
//   SessionPort                 WHERE the refresh token lives, and the in-memory
//                               access token beside it. Browser localStorage,
//                               the desktop OS keychain, or
//                               `react-native-keychain` on RN — never MMKV,
//                               which is not a secret store (ADR-0137 D7).
//
// The realtime transport is the third adapter and it does NOT live here: its
// interface is `RealtimeHandle` in `../lib/realtimeEvents`, because the frame
// vocabulary it hands back is core-owned and the two belong together. The
// centrifuge implementation stays in the host
// (`clients/web/src/lib/realtime.ts`).
//
// ## The default is deliberately inert, not a guess
//
// An uninstalled host answers "" for the base and "no session" for everything
// else. That is exactly what a browser with no stored choice and no login
// answers today, so unit tests that only exercise decoders keep running with no
// setup. It is NOT a fallback a shipping app may rely on: hosts install a real
// one before first render (web does it in `main.tsx`), and
// `coreHostInstalled()` lets a test assert that they did.
// =============================================================================

/** The session state the core reads and rotates. Implemented by the host. */
export interface SessionPort {
  /** The 15-minute access token, or null. Memory only, by design. */
  getAccessToken(): string | null;
  /** The rotating refresh token from the host's credential store, or null. */
  getRefreshToken(): string | null;
  /** What survived the last reload, or null. */
  getPersistedSession(): PersistedSession | null;
  /** Adopt a fresh login (or join) response. */
  applyLogin(response: LoginResponse): void;
  /** Adopt the pair a single-use refresh rotation returned. */
  applyRotation(accessToken: string, refreshToken: string): void;
  /** The refresh path is closed; the app tree should ask for a sign-in. */
  markAuthExpired(): void;
  /** Forget everything, including the credential store's copy. */
  clearSession(): void;
}

/** Everything the core needs from the platform it is running on. */
export interface CoreHost {
  /**
   * The base every request is built on. "" means same-origin relative paths,
   * which is the web deployment's normal mode and the dev proxy's whole point.
   */
  apiBase(): string;
  /**
   * The absolute origin to hand someone else (invite links, "point your client
   * here"). On web, same-origin resolves to the browser's own origin.
   */
  absoluteApiBase(): string;
  /**
   * Which build variant is running. On web this is Vite's `import.meta.env.MODE`
   * — "production" for a real build, and the `--mode <name>` value for the
   * Playwright gate builds, which stand up their own fixture server and must not
   * be told the production server's surface table (see
   * `features/capabilities/serverSurfaces.ts`). `import.meta` does not exist
   * under Metro/Hermes, which is why this is a port and not a global.
   */
  buildMode(): string;
  session: SessionPort;
}

const INERT_SESSION: SessionPort = {
  getAccessToken: () => null,
  getRefreshToken: () => null,
  getPersistedSession: () => null,
  applyLogin: () => {},
  applyRotation: () => {},
  markAuthExpired: () => {},
  clearSession: () => {},
};

const INERT_HOST: CoreHost = {
  apiBase: () => "",
  absoluteApiBase: () => "",
  buildMode: () => "production",
  session: INERT_SESSION,
};

let current: CoreHost | null = null;

/**
 * Install the platform implementation. Called once, before the first render.
 * Idempotent by replacement so a test can swap one in and put the previous one
 * back.
 */
export function installCoreHost(host: CoreHost): void {
  current = host;
}

/** True once a host has been installed. Exists so a wiring test can assert it. */
export function coreHostInstalled(): boolean {
  return current !== null;
}

/** Drop back to the inert host. Test-only. */
export function resetCoreHost(): void {
  current = null;
}

/** The installed host, or the inert default. Read at call time, never cached. */
export function coreHost(): CoreHost {
  return current ?? INERT_HOST;
}

/** Shorthand for the two readers the request layer uses on every call. */
export function apiBase(): string {
  return coreHost().apiBase();
}

export function absoluteApiBase(): string {
  return coreHost().absoluteApiBase();
}

export function buildMode(): string {
  return coreHost().buildMode();
}

export function coreSession(): SessionPort {
  return coreHost().session;
}
