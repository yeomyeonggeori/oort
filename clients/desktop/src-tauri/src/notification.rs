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
//
// A click on a banner is the one thing the plugin cannot report: its desktop
// `show()` is fire-and-forget. `notification_show_clickable` is the path that
// can, on macOS (`notification_click.rs`, #5059); everything else, and every
// banner that cannot wait, goes through the plugin as before.

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
///
/// On desktop the plugin reports `Granted` without asking the OS, so this is
/// `Ok(true)` even when macOS drops the banner: the first banner of a new
/// bundle raises the OS permission alert instead of showing, and after
/// 허용 안 함 none show (measured, #2676; `clients/desktop/README.md`).
#[tauri::command]
pub fn notification_show<R: Runtime>(
    app: AppHandle<R>,
    title: String,
    body: Option<String>,
) -> Result<bool, String> {
    if !permission_granted(&app)? {
        return Ok(false);
    }
    show_plain(&app, title, body)?;
    Ok(true)
}

fn permission_granted<R: Runtime>(app: &AppHandle<R>) -> Result<bool, String> {
    app.notification()
        .permission_state()
        .map(|state| matches!(state, PermissionState::Granted))
        .map_err(|error| error.to_string())
}

/// One banner through the plugin: fire-and-forget, no way to learn of a click. The fallback for
/// every banner that cannot be a clickable one (`notification_show_clickable`).
pub(crate) fn show_plain<R: Runtime>(
    app: &AppHandle<R>,
    title: String,
    body: Option<String>,
) -> Result<(), String> {
    let mut builder = app.notification().builder().title(title);
    if let Some(body) = body {
        builder = builder.body(body);
    }
    builder.show().map_err(|error| error.to_string())
}

/// What `notification_show_clickable` did with a banner (#5059).
#[cfg(desktop)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ClickableOutcome {
    /// Shown, and a click on it arrives as a `momo:notification-click` event carrying the
    /// request's `id` and `target`.
    Clickable,
    /// Shown, but a click on it cannot be reported (another OS, too many banners already waiting,
    /// a malformed click request). The web layer must not expect an event for it.
    Plain,
    /// Not shown: permission is not granted.
    Refused,
}

/// Whether this shell can report a banner click at all: macOS, where the shell keeps the banner's
/// handle (`notification_click.rs`). The web layer asks once per run; it decides whether the
/// old "the window came to the front within 20 s" approximation stays armed. A shell that does
/// not have this command (an older build) fails the call, which the web layer reads as "no".
#[cfg(desktop)]
#[tauri::command]
pub fn notification_click_supported() -> bool {
    cfg!(target_os = "macos")
}

/// Shows one native notification and, where the shell can, reports its click (#5059).
///
/// `id` is a token the web layer minted for this banner and `target` the app route a click
/// should open; both come back unchanged in `momo:notification-click`, and only on a click. The
/// answer says whether that will happen: [`ClickableOutcome::Clickable`] only after the wait is
/// really started, so the web layer never expects an event that cannot come.
///
/// Anything that cannot be waited on is shown the plain way instead of being dropped: another
/// OS, a banner past `MAX_PENDING_CLICKS`, a thread that could not start, a malformed `id` or
/// `target`. Losing a banner would cost the person a mention; losing its click costs one
/// sidebar click.
#[cfg(desktop)]
#[tauri::command]
#[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
pub fn notification_show_clickable<R: Runtime>(
    app: AppHandle<R>,
    title: String,
    body: Option<String>,
    id: String,
    target: String,
) -> Result<ClickableOutcome, String> {
    if !permission_granted(&app)? {
        return Ok(ClickableOutcome::Refused);
    }

    #[cfg(target_os = "macos")]
    if let Some(click) = crate::notification_click::parse_click(id, target) {
        if crate::notification_click::show_with_click(&app, title.clone(), body.clone(), click) {
            return Ok(ClickableOutcome::Clickable);
        }
    }

    show_plain(&app, title, body)?;
    Ok(ClickableOutcome::Plain)
}

/// Largest number the Dock tile shows. Past this the web side's own count is
/// still exact in the app; the tile just stops growing (macOS draws any digits,
/// but a four-digit badge is unreadable and means "a lot" either way).
#[cfg(desktop)]
const DOCK_BADGE_MAX: u32 = 999;

/// Sets the Dock/taskbar badge to the web side's 「나에게 필요한 일」 count
/// (#3339). `0` removes the badge. The count is computed once in the web
/// bundle (`useNeedsMeCount`); this command only draws it.
///
/// Acts on the calling window, so a capability that grants it to `main` only is
/// enough: no other window can set it, and no window label crosses the IPC
/// boundary. No notification permission is involved; macOS draws the badge on
/// the app icon without one.
#[cfg(desktop)]
#[tauri::command]
pub fn dock_badge_set<R: Runtime>(
    window: tauri::WebviewWindow<R>,
    count: u32,
) -> Result<(), String> {
    window
        .set_badge_count(badge_value(count))
        .map_err(|error| error.to_string())
}

/// `None` clears the badge; anything else is clamped to [`DOCK_BADGE_MAX`].
#[cfg(desktop)]
fn badge_value(count: u32) -> Option<i64> {
    if count == 0 {
        None
    } else {
        Some(i64::from(count.min(DOCK_BADGE_MAX)))
    }
}

#[cfg(all(test, desktop))]
mod click_tests {
    use super::{notification_click_supported, ClickableOutcome};

    /// The web layer reads these three words; a rename here is a silent "refused" there.
    #[test]
    fn the_outcome_words_are_the_ones_the_web_layer_reads() {
        for (outcome, word) in [
            (ClickableOutcome::Clickable, "clickable"),
            (ClickableOutcome::Plain, "plain"),
            (ClickableOutcome::Refused, "refused"),
        ] {
            assert_eq!(serde_json::to_value(outcome).unwrap(), word);
        }
    }

    /// Only macOS keeps the banner's handle; the other desktops stay on the plain path, where
    /// the web layer keeps its focus approximation.
    #[test]
    fn only_macos_reports_clicks() {
        // A literal per platform rather than `cfg!(..)` echoed back: the function is defined
        // as that expression, so comparing it with itself could never fail.
        #[cfg(target_os = "macos")]
        assert!(notification_click_supported());
        #[cfg(not(target_os = "macos"))]
        assert!(!notification_click_supported());
    }
}

#[cfg(all(test, desktop))]
mod badge_tests {
    use super::badge_value;

    #[test]
    fn zero_clears_the_badge() {
        assert_eq!(badge_value(0), None);
    }

    #[test]
    fn counts_pass_through_and_cap() {
        assert_eq!(badge_value(4), Some(4));
        assert_eq!(badge_value(999), Some(999));
        assert_eq!(badge_value(5000), Some(999));
    }
}
