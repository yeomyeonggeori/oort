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
// Since #3106 the token also never comes back OUT: the shell rotates it itself
// (`session_refresh`), and the webview gets a handle (`shell:` + a hash) to
// tell one stored token from another. A second item under the same service,
// `refresh-token-origin`, pins the token to the server it belongs to; it is
// not secret.
//
// Keychain calls can block on a user prompt (macOS asks before an unfamiliar
// binary reads an existing item), so every call goes through `spawn_blocking`
// rather than stalling the IPC thread.

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
/// The web side falls back to web storage when this is false, so a shell on a
/// machine with no Secret Service still signs in — it just does so with the
/// browser's guarantees, and says so.
///
/// ## Why the caller must not ask this at boot (MOMO-606)
///
/// macOS binds a keychain item's ACL to the **signature** of the binary that
/// wrote it. An item left by an earlier build with a different signature (the
/// unsigned spike, an ad-hoc dev build) is one this binary may not read, and
/// macOS does not answer that with an error: it puts up a **login keychain
/// password dialog**. Measured on 2026-07-25 with the signed 0.1.0-next.2
/// bundle against an item written by the unsigned spike: a modal appeared over
/// the window on launch, before the person had signed in or asked for anything.
///
/// Deleting the offending item is not a silent recovery either — `keyring`'s
/// `delete_credential` put up a **second** dialog for the same item (measured),
/// so an automatic delete-and-retry just doubles the prompts. (`security
/// delete-generic-password` does delete it without one, which is why the
/// operator instruction below is a shell one-liner rather than code.)
///
/// So the rule lives at the call site, in `clients/web/src/lib/session.ts`: the
/// credential store is touched only when there is a session to resume or a
/// token to move. A first launch never asks, because the answer would not be
/// used until sign-in anyway.
///
/// On a developer machine that already has an orphaned item:
///
/// ```sh
/// security delete-generic-password -s app.momo.desktop -a refresh-token
/// ```
#[tauri::command]
pub async fn keychain_available() -> bool {
    blocking(|| Ok(probe().is_ok())).await.unwrap_or(false)
}

/// What `getRefreshToken()` answers in the webview while the shell holds the
/// token (#3106): `shell:` + 32 hex of its SHA-256, or `None` when there is no
/// session to resume. The raw token never comes back across the bridge — it
/// used to (`keychain_load_refresh_token`, removed), which let any script in
/// the webview read it; now the shell rotates it itself
/// (`session_refresh_attempt`) and the webview only needs to tell one stored
/// token from another.
#[cfg(desktop)]
#[tauri::command]
pub async fn keychain_refresh_token_handle(
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    use tauri::Manager as _;
    let shell = app.state::<crate::session_refresh::SessionShell>();
    let _one = shell.gate().lock().await;
    blocking(|| match entry()?.get_password() {
        Ok(token) => Ok(Some(crate::session_refresh::handle_of(&token))),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(error) => Err(error),
    })
    .await
}

/// Stores (or replaces) the refresh token. `origin` is the server it belongs
/// to (`https://host[:port]`, #3106): the shell will present this token only
/// there, so a script cannot point `session_refresh_attempt` at another host.
/// A store without one (a legacy record moved from web storage) forgets the
/// old pin; the first rotation then records the origin it is asked for.
#[cfg(desktop)]
#[tauri::command]
pub async fn keychain_store_refresh_token(
    app: tauri::AppHandle,
    token: String,
    origin: Option<String>,
) -> Result<(), String> {
    use tauri::Manager as _;
    if token.is_empty() {
        return Err("refusing to store an empty refresh token".into());
    }
    let origin = match origin {
        Some(raw) => Some(
            crate::session_refresh::origin_of(&raw)
                .ok_or("refusing an origin that is not http(s)")?,
        ),
        None => None,
    };
    let shell = app.state::<crate::session_refresh::SessionShell>();
    let _one = shell.gate().lock().await;
    // A new sign-in: a token stashed by an earlier clear belongs to another
    // session and must not be revoked with this one's access token.
    shell.forget_pending_revoke();
    blocking(move || {
        entry()?.set_password(&token)?;
        write_origin(origin.as_deref())
    })
    .await
}

/// Deletes the stored refresh token. Succeeds when there was nothing to delete —
/// logout must never fail because the device was already clean.
///
/// The token is kept in memory (never on disk) until `session_revoke` takes
/// it: the web layer wipes the store BEFORE it revokes (a slow network must
/// never leave a usable token on the device), and the revocation needs the
/// token the webview no longer holds (#3106).
#[cfg(desktop)]
#[tauri::command]
pub async fn keychain_clear_refresh_token(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager as _;
    let shell = app.state::<crate::session_refresh::SessionShell>();
    // Behind any rotation in flight, so what is stashed is the token it wrote.
    let _one = shell.gate().lock().await;
    let stored = blocking(|| match entry()?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(error) => Err(error),
    })
    .await
    .unwrap_or(None);
    if let Some(token) = stored {
        shell.stash_for_revoke(token);
    }
    blocking(|| match entry()?.delete_credential() {
        Ok(()) => Ok(()),
        Err(KeyringError::NoEntry) => Ok(()),
        Err(error) => Err(error),
    })
    .await
}

#[cfg(not(desktop))]
#[tauri::command]
pub async fn keychain_store_refresh_token(token: String) -> Result<(), String> {
    if token.is_empty() {
        return Err("refusing to store an empty refresh token".into());
    }
    blocking(move || entry()?.set_password(&token)).await
}

#[cfg(not(desktop))]
#[tauri::command]
pub async fn keychain_clear_refresh_token() -> Result<(), String> {
    blocking(|| match entry()?.delete_credential() {
        Ok(()) => Ok(()),
        Err(KeyringError::NoEntry) => Ok(()),
        Err(error) => Err(error),
    })
    .await
}

// ---- the shell's own rotation (#3106) ---------------------------------------

/// Account for the origin the stored token belongs to. Not secret.
#[cfg(desktop)]
const ORIGIN_ACCOUNT: &str = "refresh-token-origin";

#[cfg(desktop)]
fn origin_entry() -> Result<Entry, KeyringError> {
    Entry::new(SERVICE, ORIGIN_ACCOUNT)
}

#[cfg(desktop)]
fn write_origin(origin: Option<&str>) -> Result<(), KeyringError> {
    match origin {
        Some(origin) => origin_entry()?.set_password(origin),
        None => match origin_entry()?.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(error) => Err(error),
        },
    }
}

/// The OS credential store as `session_refresh::TokenStore`. Same service
/// and account as the commands above: one token, no key parameter.
#[cfg(desktop)]
pub struct KeyringStore;

#[cfg(desktop)]
impl crate::session_refresh::TokenStore for KeyringStore {
    fn load(&self) -> Result<Option<String>, String> {
        match entry().and_then(|e| e.get_password()) {
            Ok(token) => Ok(Some(token)),
            Err(KeyringError::NoEntry) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    fn store(&self, token: &str) -> Result<(), String> {
        entry()
            .and_then(|e| e.set_password(token))
            .map_err(|error| error.to_string())
    }

    fn clear(&self) -> Result<(), String> {
        match entry().and_then(|e| e.delete_credential()) {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }

    fn origin(&self) -> Result<Option<String>, String> {
        match origin_entry().and_then(|e| e.get_password()) {
            Ok(origin) => Ok(Some(origin)),
            Err(KeyringError::NoEntry) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    fn set_origin(&self, origin: Option<&str>) -> Result<(), String> {
        write_origin(origin).map_err(|error| error.to_string())
    }
}
