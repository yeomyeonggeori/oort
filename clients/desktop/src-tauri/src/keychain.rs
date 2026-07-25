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

use std::sync::atomic::{AtomicBool, Ordering};

use keyring::{Entry, Error as KeyringError};
use tauri::async_runtime::spawn_blocking;

/// Keychain service name. Matches the bundle identifier (`app.momo.desktop`) and
/// is stable across builds on purpose — it is the identity a stored token is
/// filed under, so changing it silently orphans every session.
const SERVICE: &str = "app.momo.desktop";
/// Account name for the one secret this shell stores.
const ACCOUNT: &str = "refresh-token";

fn entry() -> Result<Entry, KeyringError> {
    Entry::new(SERVICE, ACCOUNT)
}

/// True once this process has already tried to clear an unreadable item. The
/// recovery below destroys a session, so it gets exactly one attempt per run.
static RECOVERY_ATTEMPTED: AtomicBool = AtomicBool::new(false);

/// Can this process read (or confirm the absence of) the stored item?
///
/// Reading a probably-absent entry is the only honest probe: it exercises the
/// same path a real read takes. `NoEntry` means the store answered.
fn probe() -> Result<(), KeyringError> {
    match entry()?.get_password() {
        Ok(_) | Err(KeyringError::NoEntry) => Ok(()),
        Err(error) => Err(error),
    }
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
///
/// ## The orphaned item (MOMO-606)
///
/// macOS binds a keychain item's ACL to the *signature* of the binary that
/// created it. The spike build was unsigned and filed under `app.momo.spike`;
/// this build is Developer ID signed and filed under `app.momo.desktop`. Every
/// such identity change — and every unsigned rebuild before it — leaves an item
/// this binary can neither read nor overwrite: the read comes back
/// `errSecAuthFailed`/`errSecInteractionNotAllowed` rather than `NoEntry`.
///
/// Without a recovery that is permanent: the probe fails, the shell falls back
/// to web storage, and it does so on every launch forever, quietly downgrading
/// the one security property the credential store was added for.
///
/// So an unreadable item is deleted once per process and the probe re-run. The
/// cost is a single sign-in (the token in there was unusable anyway); the
/// alternative is a shell that silently never uses the keychain again. It runs
/// once so that a genuinely locked keychain — the other way this probe fails —
/// cannot turn into a delete loop.
#[tauri::command]
pub async fn keychain_available() -> bool {
    blocking(|| {
        if probe().is_ok() {
            return Ok(true);
        }
        if RECOVERY_ATTEMPTED.swap(true, Ordering::SeqCst) {
            return Ok(false);
        }
        let _ = entry().and_then(|item| item.delete_credential());
        Ok(probe().is_ok())
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
