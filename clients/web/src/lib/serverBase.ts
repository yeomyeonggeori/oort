import { API_BASE_DEFAULT, IS_TAURI } from "./env";

// =============================================================================
// Which server this client talks to (MOMO-604 / ADR-0133 P2).
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

export type ServerUrlCheck =
  | { ok: true; base: string }
  | { ok: false; message: string };

/** Neutral example, never a real host: RFC 2606 reserves example.com. */
export const SERVER_URL_PLACEHOLDER = "https://oort.example.com";

const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * Validate and normalise a server address (the web sibling of the mac client's
 * `MomoServerSessionForm.validatedBaseURL()`).
 *
 * Accepts a bare host (`momo.example.com:28000`) by reading it as https, which
 * is the safer of the two guesses: a plaintext guess would silently downgrade a
 * TLS server. A LAN server that only speaks http is reached by typing `http://`
 * or by taking the discovery card's suggestion, which carries its own scheme.
 *
 * Returns the origin plus any path prefix (a reverse proxy may mount the API
 * under `/momo`), with the trailing slash, query and fragment dropped so the
 * value concatenates cleanly with `/v1/...`.
 */
export function normalizeServerUrl(raw: string): ServerUrlCheck {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: false, message: "서버 주소를 입력하세요." };
  }
  const candidate = SCHEME_RE.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return {
      ok: false,
      message: `주소를 확인하세요. 예: ${SERVER_URL_PLACEHOLDER}`,
    };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      ok: false,
      message: "주소는 http:// 또는 https:// 로 시작해야 합니다.",
    };
  }
  if (url.hostname === "") {
    return {
      ok: false,
      message: `호스트가 없습니다. 예: ${SERVER_URL_PLACEHOLDER}`,
    };
  }
  const path = url.pathname.replace(/\/+$/, "");
  return { ok: true, base: `${url.origin}${path}` };
}

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
