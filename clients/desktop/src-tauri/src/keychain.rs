// Refresh token storage in the OS credential store (ADR-0133 P2, MOMO-603).
//
// In the browser the refresh token lives in localStorage, and `clients/web/src/lib/session.ts`
// says plainly why that is a bound rather than a fix: any script that reaches the
// origin can read it and keep rotating it for 30 days. Inside the shell there is
// a better place — the macOS Keychain / Windows Credential Manager / Secret
// Service — and reaching it needs Rust, which is exactly why this is the plugin
// layer's job and not the React tree's.
//
// The surface is deliberately NOT a generic key-value store. There is one secret
// with one name, so the commands take no key: a free-form `keychain_get(key)`
// would let any script in the webview enumerate whatever else this app ever
// stores, which throws away most of what the keychain was for.
//
// Keychain calls can block on a user prompt (macOS asks before an unfamiliar
// binary reads an existing item), so every call goes through `spawn_blocking`
// rather than stalling the IPC thread.

use keyring::{Entry, Error as KeyringError};
use tauri::async_runtime::spawn_blocking;

/// Keychain service name. Stable across builds on purpose — it is the identity a
/// stored token is filed under, so changing it silently orphans every session.
const SERVICE: &str = "app.momo.desktop";
/// Account name for the one secret this shell stores.
const ACCOUNT: &str = "refresh-token";

fn entry() -> Result<Entry, KeyringError> {
    Entry::new(SERVICE, ACCOUNT)
}

async fn blocking<T, F>(work: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, KeyringError> + Send + 'static,
    T: Send + 'static,
{
    spawn_blocking(work)
        .await
        .map_err(|error| format!("keychain task failed: {error}"))?
        .map_err(|error| error.to_string())
}

/// True when this platform has a usable credential store.
///
/// The web side calls this once at boot and falls back to web storage when it is
/// false, so a shell on a machine with no Secret Service still signs in — it just
/// does so with the browser's guarantees, and says so.
#[tauri::command]
pub async fn keychain_available() -> bool {
    blocking(|| {
        // Reading a (probably absent) entry is the only honest probe: it exercises
        // the same path a real read takes. `NoEntry` means the store answered.
        match entry()?.get_password() {
            Ok(_) => Ok(true),
            Err(KeyringError::NoEntry) => Ok(true),
            Err(error) => Err(error),
        }
    })
    .await
    .unwrap_or(false)
}

/// Reads the stored refresh token, or `None` when there is no session to resume.
#[tauri::command]
pub async fn keychain_load_refresh_token() -> Result<Option<String>, String> {
    blocking(|| match entry()?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(error) => Err(error),
    })
    .await
}

/// Stores (or replaces) the refresh token.
#[tauri::command]
pub async fn keychain_store_refresh_token(token: String) -> Result<(), String> {
    if token.is_empty() {
        return Err("refusing to store an empty refresh token".into());
    }
    blocking(move || entry()?.set_password(&token)).await
}

/// Deletes the stored refresh token. Succeeds when there was nothing to delete —
/// logout must never fail because the device was already clean.
#[tauri::command]
pub async fn keychain_clear_refresh_token() -> Result<(), String> {
    blocking(|| match entry()?.delete_credential() {
        Ok(()) => Ok(()),
        Err(KeyringError::NoEntry) => Ok(()),
        Err(error) => Err(error),
    })
    .await
}
