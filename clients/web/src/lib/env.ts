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

/**
 * The workspace this build connects to, or "" — never a hardcoded id.
 *
 * goal B13 (QA M/L): this used to fall back to the demo workspace's literal
 * uuid, and `ConnectPage` seeded the sign-in form's 워크스페이스 box with it. The
 * first thing a person met was therefore
 * `00000000-0000-7000-8000-000000000001` in an editable field with no label
 * hint: an internal identifier presented as something they were expected to
 * understand and maintain.
 *
 * Blank is not a behaviour change. `login()` omits the key when this is empty,
 * and the server's own fallback for an absent/unparsable `workspace` is that
 * exact demo id (`routes/auth_routes.rs`, `DEMO_WORKSPACE_ID`) — so the two
 * spellings were always the same request. The difference is only that the id
 * no longer has to be on screen for it to be the default.
 */
export const CONFIGURED_WORKSPACE = env.VITE_MOMO_WORKSPACE ?? "";

/**
 * Test-period login prefill (DESK-1). BUILD-TIME env only, and NEVER a literal
 * in this repo — the values live in `clients/web/.env.local`, which is
 * gitignored (see `.env.local.example` for the names).
 *
 * Unset is the default and prefills nothing, so the production web `dist` — and
 * any desktop build made without these — behaves exactly as before.
 *
 * A silently pre-filled password becomes an incident the first time one ships,
 * so a build that turns this on SAYS SO on the connect screen: see
 * `TEST_PREFILL_ACTIVE` and the banner in `ConnectPage`.
 */
export const DEV_EMAIL = env.VITE_MOMO_DEV_EMAIL ?? "";
export const DEV_PASSWORD = env.VITE_MOMO_DEV_PASSWORD ?? "";

/**
 * True when this build carries either prefill value. Drives the on-screen
 * marker; deliberately true for the email-only case too, because a filled
 * identity is still a build-time fact the reader did not type.
 */
export const TEST_PREFILL_ACTIVE = DEV_EMAIL !== "" || DEV_PASSWORD !== "";

/** True when running inside the Tauri WKWebView/WebView2 shell. */
export const IS_TAURI =
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
