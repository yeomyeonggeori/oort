// Native notifications (ADR-0133 P2, MOMO-603).
//
// The web bundle cannot use the browser Notification API inside the shell — the
// webview origin is `tauri://localhost`, which no notification centre knows how
// to attribute — so mentions and approval requests go out through the OS via
// `tauri-plugin-notification` instead.
//
// These are thin app commands rather than the plugin's own JS bindings on
// purpose: the web side then needs exactly ONE npm dependency
// (`@tauri-apps/api`) for the whole desktop bridge, and the permission dance
// stays a single call the React tree can await instead of a plugin-shaped
// multi-step protocol.

use serde::Serialize;
use tauri::plugin::PermissionState;
use tauri::{AppHandle, Runtime};
use tauri_plugin_notification::NotificationExt;

/// Web-facing permission vocabulary, matching the browser Notification API so
/// the consuming code reads the same in both runtimes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NotificationPermission {
    Granted,
    Denied,
    /// Not decided yet — ask before the first notification matters to someone.
    Default,
}

impl From<PermissionState> for NotificationPermission {
    fn from(state: PermissionState) -> Self {
        match state {
            PermissionState::Granted => Self::Granted,
            PermissionState::Denied => Self::Denied,
            // Both prompt variants mean the same thing to the caller: ask.
            _ => Self::Default,
        }
    }
}

/// Current permission, without prompting.
#[tauri::command]
pub fn notification_permission<R: Runtime>(
    app: AppHandle<R>,
) -> Result<NotificationPermission, String> {
    app.notification()
        .permission_state()
        .map(NotificationPermission::from)
        .map_err(|error| error.to_string())
}

/// Requests permission, prompting if the platform needs it. Desktop grants
/// unconditionally; the call still exists so the web side has one code path.
#[tauri::command]
pub fn notification_request_permission<R: Runtime>(
    app: AppHandle<R>,
) -> Result<NotificationPermission, String> {
    app.notification()
        .request_permission()
        .map(NotificationPermission::from)
        .map_err(|error| error.to_string())
}

/// Shows one native notification.
///
/// Returns `Ok(false)` when permission is not granted — a refused notification is
/// a normal state, not a failure, and the caller should not have to distinguish
/// "the user said no" from "the notification centre broke" in a catch block.
#[tauri::command]
pub fn notification_show<R: Runtime>(
    app: AppHandle<R>,
    title: String,
    body: Option<String>,
) -> Result<bool, String> {
    let state = app
        .notification()
        .permission_state()
        .map_err(|error| error.to_string())?;
    if !matches!(state, PermissionState::Granted) {
        return Ok(false);
    }

    let mut builder = app.notification().builder().title(title);
    if let Some(body) = body {
        builder = builder.body(body);
    }
    builder.show().map_err(|error| error.to_string())?;
    Ok(true)
}
