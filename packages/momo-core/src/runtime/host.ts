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
  /**
   * Run one refresh rotation as the ONLY rotation this credential store sees
   * (#3067). Optional: a host whose store is reachable from exactly one JS
   * context may omit it and the core rotates directly. The phone implements it
   * anyway, for time rather than exclusion: it wraps the rotation in an iOS
   * background task so leaving the app mid-rotation does not freeze it before
   * the new token is stored (#3098).
   *
   * A host whose store is shared — browser tabs and desktop windows share
   * localStorage and the keychain item — must, before calling `work`:
   *   1. take a cross-context exclusive lock, and
   *   2. re-read its store and adopt what it finds, so `getRefreshToken()`
   *      answers the token another context may have rotated to meanwhile;
   * and must release only after `work`'s `applyRotation` is durably written.
   * Presenting a token another context already spent is exactly what the
   * server treats as theft (#3065 reuse detection).
   *
   * Rejecting (lock wait timed out, lock API failure) is reported by the core
   * as `unreachable`: nothing answered, so nothing is proven about the session.
   */
  exclusiveRotation?<T>(work: () => Promise<T>): Promise<T>;
  /**
   * The phone's refresh key (#3106, ADR-0146 D-7 증보 #3079): sign
   * `momo.human.refresh_proof.v1` for this refresh token. The native side
   * builds the bytes from these typed fields and picks the nonce; it signs
   * nothing else. Resolves null when this device has no refresh key (no Secure
   * Enclave, module absent) — the refresh then goes without a proof. Optional:
   * a browser has no key and never proves.
   */
  signRefreshProof?(request: RefreshProofRequest): Promise<RefreshDeviceProof | null>;
  /**
   * The desktop shell carries the refresh itself (#3106): it reads the token
   * it keeps, signs the proof, POSTs, stores the successor and answers with
   * the access token and a HANDLE for the new refresh token, so the webview
   * never holds the token. One attempt per call; the retry policy stays in the
   * core. Resolves null when the host cannot carry it right now (the core then
   * POSTs itself); rejects when nothing answered.
   */
  refreshThroughHost?(request: HostRefreshRequest): Promise<HostRefreshAnswer | null>;
  /**
   * Logout's server revocation through the host that holds the token
   * (#3106). Resolves true when the host carried it (whatever the server
   * said); false when the core should revoke with what it holds.
   */
  revokeThroughHost?(request: HostRevokeRequest): Promise<boolean>;
}

/** What a refresh proof binds (momo-wire `RefreshProof`, #3079). */
export interface RefreshProofRequest {
  /** The raw refresh token this request presents; only its SHA-256 is signed. */
  refreshToken: string;
  workspaceId: string;
  memberId: string;
  /** Local clock plus the server skew learned from `refresh_proof_stale`. */
  signedAtMs: number;
}

/** `RefreshRequest.deviceProof` (docs/api/openapi.yaml `RefreshDeviceProof`). */
export interface RefreshDeviceProof {
  /** base64 of the 33-byte compressed SEC1 refresh key. */
  publicKey: string;
  nonce: string;
  signedAtMs: number;
  /** base64 of raw r‖s (64 bytes). */
  signature: string;
}

export interface HostRefreshRequest {
  workspaceId: string;
  memberId: string;
  /** Server time minus local time, from a `refresh_proof_stale` answer. */
  skewMs: number;
  /**
   * This is the bind refresh right after a sign-in (#3106 MUST 1). A host
   * that cannot carry it WITH a proof right now should reject (the core keeps
   * the token and retries the bind) rather than answer null: a proofless
   * refresh would spend the sign-in's first token and leave it unbound.
   */
  bind?: boolean;
}

/** One refresh the host made. Mirrors the shell's `AttemptAnswer`. */
export interface HostRefreshAnswer {
  status: number;
  /** `error.code` of a refusal. */
  code?: string;
  /** The response `Date` header. */
  date?: string;
  /** 200 only. */
  accessToken?: string;
  /** 200 only: what `getRefreshToken()` answers from now on — a handle. */
  refreshToken?: string;
  /** A proof went with the request. */
  proved: boolean;
}

export interface HostRevokeRequest {
  accessToken: string;
  /**
   * What the core holds for the refresh half: the host's handle, or a raw
   * token the host never confirmed (then the host answers false and the core
   * revokes with it).
   */
  refreshToken: string | null;
  workspaceId: string;
  memberId: string;
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
