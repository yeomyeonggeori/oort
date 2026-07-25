// Runtime config for the spike. Backend origin + workspace are configurable;
// credentials are NEVER hardcoded, they come from .env.local (dev prefill) or
// the login form. The realtime WS address is NOT here: it is only ever the
// `realtimeWebSocketUrl` the server returns at login (ADR-0110).

const env = import.meta.env as Record<string, string | undefined>;

// BUILD-TIME default only. Empty = same-origin relative paths, proxied to
// momowebqa by the dev/preview server (see vite.config.ts). Set
// VITE_MOMO_API_BASE only for a CORS-enabled backend origin.
//
// This is no longer the address requests actually go to: the person connecting
// can pick a server on the connect screen (MOMO-604), and that choice is stored
// per device. Read the effective base through `apiBase()` in ./serverBase.ts;
// this constant is only its fallback.
export const API_BASE_DEFAULT = (env.VITE_MOMO_API_BASE ?? "").replace(
  /\/+$/,
  ""
);

export const DEFAULT_WORKSPACE =
  env.VITE_MOMO_WORKSPACE ?? "00000000-0000-7000-8000-000000000001";

/** Dev-only login prefill. Blank in shared/committed envs. */
export const DEV_EMAIL = env.VITE_MOMO_DEV_EMAIL ?? "";
export const DEV_PASSWORD = env.VITE_MOMO_DEV_PASSWORD ?? "";

/** True when running inside the Tauri WKWebView/WebView2 shell. */
export const IS_TAURI =
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
